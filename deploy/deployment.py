#!/usr/bin/env python3
"""Run one serialized, pause-first Compose image replacement."""

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

IMAGE_PREFIX = 'ghcr.io/aurea-ecom-labs/wpp-vip-ingest'
DIGEST_RE = re.compile(r'^sha256:[0-9a-f]{64}$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
SCHEMA_LABEL = 'com.aurea.wpp.database-schema'
RUNTIME_SCHEMA_LABEL = 'com.aurea.wpp.runtime-state-schema'
LIFECYCLE_STATES = {'starting', 'connecting', 'ready', 'draining', 'needs_pairing', 'failed'}


class DeploymentError(Exception):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def write_json_atomically(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(value, output, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def load_state(path):
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise DeploymentError('Deployment state is not readable JSON') from error
    if value.get('version') != 1:
        raise DeploymentError('Unsupported deployment state version')
    return value


def readiness_summary(value):
    if not value:
        return {'state': 'not_running'}
    snapshot = value.get('status') or {}
    control = value.get('control') or {}
    lifecycle = snapshot.get('lifecycle')
    session = control.get('session')
    admission = control.get('admission')
    return {
        'healthy': value.get('health', {}).get('healthy') is True,
        'lifecycle': lifecycle if lifecycle in LIFECYCLE_STATES else 'unknown',
        'session': session if session in {'active', 'needs_pairing'} else 'unknown',
        'admission': admission if admission in {'paused', 'resumed'} else 'unknown',
        'processCurrent': value.get('processCurrent') is True,
        'heartbeatAt': snapshot.get('heartbeatAt') if isinstance(snapshot.get('heartbeatAt'), str) else None,
    }


def has_mode_access(path, uid, gid, requested):
    info = path.stat()
    mode = info.st_mode
    if uid == info.st_uid:
        available = (mode >> 6) & 0b111
    elif gid == info.st_gid:
        available = (mode >> 3) & 0b111
    else:
        available = mode & 0b111
    return available & requested == requested


class DockerCompose:
    def __init__(self, root, runner=None, clock=time.monotonic, sleep=time.sleep):
        self.root = Path(root).resolve()
        self.runner = runner or self._subprocess
        self.clock = clock
        self.sleep = sleep

    @staticmethod
    def _subprocess(command, environment, timeout=180):
        return subprocess.run(command, env=environment, capture_output=True, text=True, timeout=timeout)

    def run(self, command, image=None, timeout=180):
        environment = os.environ.copy()
        if image:
            environment['WPP_IMAGE'] = image
        try:
            result = self.runner(command, environment, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise DeploymentError('Docker operation timed out') from error
        except OSError as error:
            raise DeploymentError('Docker command is unavailable') from error
        if result.returncode != 0:
            raise DeploymentError(f'Command failed ({Path(command[0]).name}, exit {result.returncode})')
        return result.stdout.strip()

    def compose(self, *args, image=None, timeout=180):
        command = [
            'docker', 'compose', '--project-directory', str(self.root),
            '--env-file', str(self.root / '.env'), '-f', str(self.root / 'compose.yaml'), *args,
        ]
        return self.run(command, image=image, timeout=timeout)

    def validate_candidate(self, image):
        self.run(['docker', 'info'], timeout=20)
        env_file = self.root / '.env'
        if not env_file.is_file() or not os.access(env_file, os.R_OK):
            raise DeploymentError('Target .env file is missing or unreadable')
        if not DIGEST_RE.fullmatch(self.configured_image().rsplit('@', 1)[-1]) or not self.configured_image().startswith(f'{IMAGE_PREFIX}@'):
            raise DeploymentError('Target WPP_IMAGE must use the approved GHCR prefix and an image digest')
        config = json.loads(self.compose('config', '--format', 'json', image=image))
        worker = config.get('services', {}).get('worker')
        if not worker or worker.get('image') != image:
            raise DeploymentError('Compose worker image does not match the approved digest')
        try:
            worker_uid, worker_gid = str(worker.get('user', '')).split(':', 1)
            worker_uid, worker_gid = int(worker_uid), int(worker_gid)
            if worker_uid <= 0 or worker_gid < 0:
                raise DeploymentError('Compose worker must run as a non-root user')
        except ValueError as error:
            raise DeploymentError('Compose worker user must use a numeric non-root UID') from error
        mounts = worker.get('volumes', [])
        source = next((mount for mount in mounts if mount.get('target') == '/source'), None)
        data = next((mount for mount in mounts if mount.get('target') == '/data'), None)
        source_path = Path(source.get('source', '')) if source else None
        if (not source or source.get('type') != 'bind' or not source.get('read_only') or
                not source_path or not source_path.is_dir() or
                not has_mode_access(source_path, worker_uid, worker_gid, 0b101)):
            raise DeploymentError('Read-only source directory is missing or unreadable')
        source_file = source_path / 'source.json'
        if not source_file.is_file() or not has_mode_access(source_file, worker_uid, worker_gid, 0b100):
            raise DeploymentError('Configured source file is missing or unreadable')
        environment = worker.get('environment', {})
        groups = [group for group in environment.get('WPP_GROUPS', '').split(',') if group]
        if not groups or any(not re.fullmatch(r'\d[\d-]*@g\.us', group) for group in groups):
            raise DeploymentError('Configured allowed groups are invalid')
        try:
            rows = json.loads(source_file.read_text(encoding='utf-8'))
            if not isinstance(rows, list):
                raise ValueError
            for row in rows:
                if (not isinstance(row, dict) or set(row) != {'phone', 'group'} or
                        not isinstance(row['phone'], str) or
                        not re.fullmatch(r'\+[1-9]\d{7,14}', row['phone']) or
                        row['group'] not in groups):
                    raise ValueError
        except (OSError, json.JSONDecodeError, ValueError, TypeError, KeyError) as error:
            raise DeploymentError('Configured source file does not match the phone/group contract') from error
        if not data or data.get('type') != 'volume' or data.get('read_only'):
            raise DeploymentError('Persistent writable data volume is missing')
        minimum = int(os.environ.get('WPP_MIN_FREE_BYTES', str(1024 ** 3)))
        if shutil.disk_usage(self.root).free < minimum:
            raise DeploymentError('Host free space is below WPP_MIN_FREE_BYTES')

    def validate_container_space(self, image):
        minimum = int(os.environ.get('WPP_MIN_FREE_BYTES', str(1024 ** 3)))
        output = self.run(['docker', 'run', '--rm', '--read-only', '--entrypoint', 'df',
                           image, '-Pk', '/'])
        lines = output.splitlines()
        if len(lines) < 2:
            raise DeploymentError('Cannot read Docker storage free space')
        try:
            available_bytes = int(lines[-1].split()[3]) * 1024
        except (IndexError, ValueError) as error:
            raise DeploymentError('Cannot parse Docker storage free space') from error
        if available_bytes < minimum:
            raise DeploymentError('Docker storage free space is below WPP_MIN_FREE_BYTES')

    def configured_image(self):
        path = self.root / '.env'
        values = []
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.startswith('WPP_IMAGE='):
                value = line.partition('=')[2].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                values.append(value)
        if len(values) != 1:
            raise DeploymentError('Target .env must contain one WPP_IMAGE digest')
        return values[0]

    def set_configured_image(self, image):
        if not image.startswith(f'{IMAGE_PREFIX}@') or not DIGEST_RE.fullmatch(image.rsplit('@', 1)[-1]):
            raise DeploymentError('Refusing to write an unapproved image reference')
        path = self.root / '.env'
        lines = path.read_text(encoding='utf-8').splitlines()
        matches = [index for index, line in enumerate(lines) if line.startswith('WPP_IMAGE=')]
        if len(matches) != 1:
            raise DeploymentError('Target .env must contain one WPP_IMAGE setting')
        lines[matches[0]] = f'WPP_IMAGE={image}'
        temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                output.write('\n'.join(lines) + '\n')
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()

    def pull(self, image):
        self.compose('pull', 'worker', image=image, timeout=600)

    def pull_image(self, image):
        self.run(['docker', 'pull', image], timeout=600)

    def schema(self, image):
        jobs = self.label(image, SCHEMA_LABEL)
        runtime = self.label(image, RUNTIME_SCHEMA_LABEL)
        return f'{jobs}:{runtime}' if jobs and runtime else ''

    def label(self, image, label):
        raw = self.run([
            'docker', 'image', 'inspect', '--format',
            '{{json .Config.Labels}}', image,
        ])
        try:
            labels = json.loads(raw)
        except json.JSONDecodeError as error:
            raise DeploymentError('Image labels are invalid JSON') from error
        return labels.get(label, '') if isinstance(labels, dict) else ''

    def running_image(self):
        container = self.compose('ps', '-q', 'worker')
        if not container:
            return None
        running = self.run(['docker', 'inspect', '--format', '{{.State.Running}}', container])
        if running != 'true':
            return None
        return self.run(['docker', 'inspect', '--format', '{{.Config.Image}}', container])

    def status(self):
        if not self.running_image():
            return None
        raw = self.compose('exec', '-T', 'worker', 'node', 'src/cli.mjs', 'runtime-status')
        try:
            value = json.loads(raw.splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise DeploymentError('Worker runtime status is invalid') from error
        if not isinstance(value, dict) or not isinstance(value.get('control'), dict):
            raise DeploymentError('Worker runtime status is incomplete')
        return value

    def stopped_status(self, image):
        raw = self.compose('run', '--rm', '--no-deps', 'worker', 'runtime-status', image=image, timeout=60)
        try:
            value = json.loads(raw.splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise DeploymentError('Stopped worker control status is invalid') from error
        if not isinstance(value, dict) or not isinstance(value.get('control'), dict):
            raise DeploymentError('Stopped worker control status is incomplete')
        return value

    def pause(self):
        result = self.compose('exec', '-T', 'worker', 'node', 'src/cli.mjs', 'pause', timeout=75)
        try:
            value = json.loads(result.splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise DeploymentError('Pause acknowledgement is invalid') from error
        if value.get('admission') != 'paused' or value.get('drain') not in ('drained', 'worker_not_running'):
            raise DeploymentError('Worker did not confirm a paused, drained state')

    def persist_pause_stopped(self):
        result = self.compose('run', '--rm', '--no-deps', 'worker', 'pause', timeout=90)
        try:
            value = json.loads(result.splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise DeploymentError('Stopped worker did not confirm persisted pause') from error
        if value.get('admission') != 'paused' or value.get('drain') not in ('drained', 'worker_not_running'):
            raise DeploymentError('Stopped worker did not confirm persisted pause')

    def stop(self):
        self.compose('stop', '-t', '60', 'worker', timeout=75)
        if self.running_image():
            raise DeploymentError('Old worker did not stop')

    def start(self, image):
        self.compose('up', '-d', '--no-deps', '--force-recreate', 'worker', image=image, timeout=300)

    def initialize_volume(self, image):
        self.compose('run', '--rm', '--no-deps', 'init-data', image=image, timeout=300)

    def wait_ready(self, timeout=180):
        deadline = self.clock() + timeout
        last_status = None
        while self.clock() < deadline:
            try:
                last_status = self.status()
            except DeploymentError:
                last_status = None
            if last_status:
                snapshot = last_status.get('status') or {}
                if snapshot.get('lifecycle') == 'needs_pairing' or snapshot.get('session') == 'needs_pairing':
                    return last_status
                if snapshot.get('lifecycle') == 'failed':
                    return last_status
                if (last_status.get('health', {}).get('healthy') and
                        last_status.get('processCurrent') is True and
                        snapshot.get('lifecycle') == 'ready' and
                        last_status.get('control', {}).get('session') == 'active'):
                    return last_status
            self.sleep(2)
        raise DeploymentError('Candidate readiness timed out')

    def resume(self):
        raw = self.compose('exec', '-T', 'worker', 'node', 'src/cli.mjs', 'resume', timeout=30)
        try:
            value = json.loads(raw.splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise DeploymentError('Resume acknowledgement is invalid') from error
        if (value.get('admission') != 'resumed' or value.get('lifecycle') != 'ready' or
                value.get('session') != 'active'):
            raise DeploymentError('Worker did not confirm resume')
        return value


class Deployment:
    def __init__(self, root, docker):
        self.root = Path(root).resolve()
        self.docker = docker
        self.state_dir = self.root / 'state'
        self.state_path = self.state_dir / 'deployment.json'
        self.lock_path = self.state_dir / 'deploy.lock'

    def _save(self, transaction):
        transaction['updatedAt'] = timestamp()
        write_json_atomically(self.state_path, transaction)

    def _new_transaction(self, digest, source_sha, run_number, rollback, previous):
        last = previous.get('lastSuccessful') if previous else None
        if last and run_number < last['runNumber'] and not rollback:
            raise DeploymentError('Candidate is older than the deployed release; request an explicit rollback')
        if last and run_number == last['runNumber'] and digest != last['digest'] and not rollback:
            raise DeploymentError('A publish run cannot replace its recorded image digest')
        status = self.docker.status()
        control = status.get('control', {}) if status else {}
        previous_mode = control.get('admission') if status else None
        if control.get('session') == 'needs_pairing':
            previous_mode = 'paused'
        current_image = self.docker.running_image()
        current_digest = current_image.rsplit('@', 1)[1] if current_image and '@' in current_image else None
        previous_digest = current_digest or (last.get('digest') if last else None)
        return {
            'version': 1,
            'transactionId': str(uuid.uuid4()),
            'phase': 'validating',
            'outcome': 'in_progress',
            'candidateDigest': digest,
            'sourceSha': source_sha,
            'publishRunNumber': run_number,
            'rollbackRequested': rollback,
            'previousDigest': previous_digest,
            'previousMode': previous_mode,
            'previousSchema': None,
            'candidateSchema': None,
            'lastSuccessful': last,
            'createdAt': timestamp(),
            'updatedAt': timestamp(),
        }

    def _rollback(self, transaction, disrupted):
        if not disrupted:
            return
        try:
            current = self.docker.running_image()
            if current:
                try:
                    self.docker.pause()
                except DeploymentError:
                    pass
                transaction['phase'] = 'rollback_stopping_candidate'
                self._save(transaction)
                self.docker.stop()
            transaction['phase'] = 'rollback_confirming_persisted_pause'
            self._save(transaction)
            self.docker.persist_pause_stopped()
            previous = transaction.get('previousDigest')
            compatible = (previous and DIGEST_RE.fullmatch(previous) and
                          transaction.get('previousSchema') and
                          transaction.get('previousSchema') == transaction.get('candidateSchema'))
            if compatible:
                previous_image = f'{IMAGE_PREFIX}@{previous}'
                self.docker.set_configured_image(previous_image)
                self.docker.start(previous_image)
                self.docker.wait_ready()
                transaction['phase'] = 'previous_image_restored_paused'
            else:
                transaction['phase'] = 'candidate_stopped_no_compatible_rollback'
        except Exception:
            transaction['phase'] = 'rollback_failed'
            transaction['rollbackError'] = 'Previous image restoration failed'

    def apply(self, digest, source_sha, run_number, rollback=False):
        if not DIGEST_RE.fullmatch(digest):
            raise DeploymentError('Image digest must use sha256 followed by 64 lowercase hex characters')
        if not SHA_RE.fullmatch(source_sha):
            raise DeploymentError('Source commit must be a 40-character lowercase Git SHA')
        if not isinstance(run_number, int) or run_number < 1:
            raise DeploymentError('Publish run number must be a positive integer')
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.state_dir, 0o700)
        with self.lock_path.open('a+', encoding='utf-8') as lock:
            os.chmod(self.lock_path, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise DeploymentError('Another deployment holds the host lock') from error
            prior = load_state(self.state_path)
            if prior and prior.get('outcome') == 'in_progress':
                if (prior.get('candidateDigest') != digest or prior.get('sourceSha') != source_sha or
                        prior.get('publishRunNumber') != run_number):
                    raise DeploymentError('An earlier transaction is incomplete; inspect deployment-status first')
                transaction = prior
                disrupted = transaction.get('phase') not in ('validating', 'candidate_pulled')
            elif (prior and prior.get('outcome') == 'completed' and
                  prior.get('candidateDigest') == digest and prior.get('sourceSha') == source_sha and
                  prior.get('publishRunNumber') == run_number):
                return {**prior, 'idempotent': True}
            else:
                transaction = self._new_transaction(digest, source_sha, run_number, rollback, prior)
                disrupted = False
                self._save(transaction)

            image = f'{IMAGE_PREFIX}@{digest}'
            try:
                self.docker.validate_candidate(image)
                self.docker.pull(image)
                self.docker.validate_container_space(image)
                transaction['candidateSchema'] = self.docker.schema(image)
                if not transaction['candidateSchema']:
                    raise DeploymentError('Candidate has no database schema label')
                if self.docker.label(image, 'org.opencontainers.image.revision') != source_sha:
                    raise DeploymentError('Candidate image revision does not match the trusted publish record')
                try:
                    image_run_number = int(self.docker.label(image, 'com.aurea.wpp.publish-run-number'))
                except ValueError as error:
                    raise DeploymentError('Candidate image has no trusted publish run number') from error
                if image_run_number != run_number:
                    raise DeploymentError('Candidate image run number does not match the trusted publish record')
                previous = transaction.get('previousDigest')
                if previous and DIGEST_RE.fullmatch(previous):
                    previous_image = f'{IMAGE_PREFIX}@{previous}'
                    try:
                        transaction['previousSchema'] = self.docker.schema(previous_image)
                    except DeploymentError:
                        try:
                            self.docker.pull_image(previous_image)
                            transaction['previousSchema'] = self.docker.schema(previous_image)
                        except DeploymentError:
                            transaction['previousSchema'] = None
                if (transaction.get('previousDigest') and transaction.get('previousSchema') and
                        transaction['previousSchema'] != transaction['candidateSchema']):
                    raise DeploymentError('Candidate database schema is not compatible with the previous image')
                transaction['phase'] = 'candidate_pulled'
                self._save(transaction)

                current = self.docker.running_image()
                if current:
                    status = self.docker.status()
                    if status is None and self.docker.running_image():
                        raise DeploymentError('Cannot read the current worker state; refusing to stop it')
                    if status:
                        transaction['phase'] = 'pausing_old_worker'
                        self._save(transaction)
                        disrupted = True
                        self.docker.pause()
                        status = self.docker.status()
                        if (not status or status.get('control', {}).get('admission') != 'paused' or
                                (status.get('status') or {}).get('activeClaims', 0) != 0 or
                                (status.get('status') or {}).get('activeCommands', 0) != 0):
                            raise DeploymentError('Old worker did not confirm a paused, drained state')
                        transaction['uncertainJobCount'] = status.get('jobCounts', {}).get('uncertain', 0)
                        transaction['inFlightJobCount'] = status.get('jobCounts', {}).get('in_flight', 0)
                        self._save(transaction)
                    transaction['phase'] = 'stopping_old_worker'
                    self._save(transaction)
                    disrupted = True
                    self.docker.stop()
                else:
                    transaction['phase'] = 'stopping_old_worker'
                    self._save(transaction)
                    disrupted = True
                    self.docker.stop()
                    transaction['phase'] = 'initializing_data_volume'
                    self._save(transaction)
                    self.docker.set_configured_image(image)
                    self.docker.initialize_volume(image)
                    status = self.docker.stopped_status(image)
                    control = status.get('control', {})
                    if transaction.get('previousMode') is None:
                        transaction['previousMode'] = (
                            'paused' if control.get('session') == 'needs_pairing'
                            else control.get('admission', 'paused')
                        )
                    transaction['uncertainJobCount'] = status.get('jobCounts', {}).get('uncertain', 0)
                    transaction['inFlightJobCount'] = status.get('jobCounts', {}).get('in_flight', 0)
                    self._save(transaction)
                transaction['phase'] = 'old_worker_stopped'
                self._save(transaction)

                transaction['phase'] = 'starting_candidate_paused'
                self._save(transaction)
                disrupted = True
                if current:
                    self.docker.set_configured_image(image)
                transaction['phase'] = 'persisting_candidate_pause'
                self._save(transaction)
                self.docker.persist_pause_stopped()
                self.docker.start(image)
                transaction['phase'] = 'candidate_started'
                self._save(transaction)
                status = self.docker.wait_ready()
                snapshot = status.get('status') or {}
                if (snapshot.get('lifecycle') != 'ready' or
                        status.get('control', {}).get('session') != 'active' or
                        not status.get('health', {}).get('healthy')):
                    raise DeploymentError('Candidate is not ready; pairing may be required')
                transaction['readiness'] = readiness_summary(status)
                transaction['phase'] = 'candidate_verified'
                self._save(transaction)

                if transaction.get('previousMode') == 'resumed':
                    transaction['phase'] = 'resuming_candidate'
                    self._save(transaction)
                    status = self.docker.resume()
                    transaction['readiness'] = readiness_summary(status)
                transaction['phase'] = 'completed'
                transaction['outcome'] = 'completed'
                transaction['lastSuccessful'] = {
                    'digest': digest,
                    'sourceSha': source_sha,
                    'runNumber': run_number,
                }
                self._save(transaction)
                return transaction
            except Exception as error:
                if disrupted:
                    self._rollback(transaction, disrupted)
                transaction['outcome'] = 'failed'
                transaction['error'] = str(error)[:500] if isinstance(error, DeploymentError) else type(error).__name__
                self._save(transaction)
                if isinstance(error, DeploymentError):
                    raise
                raise DeploymentError('Deployment failed; inspect deployment-status') from error


def status(root):
    path = Path(root).resolve() / 'state' / 'deployment.json'
    value = load_state(path)
    transaction = value or {'version': 1, 'outcome': 'not_started'}
    readiness = None
    try:
        readiness = readiness_summary(DockerCompose(root).status())
    except Exception:
        readiness = {'state': 'unavailable'}
    return {**transaction, 'readiness': readiness or transaction.get('readiness')}


def main(argv=None):
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest='command', required=True)
    deploy = subcommands.add_parser('deploy')
    deploy.add_argument('digest')
    deploy.add_argument('source_sha')
    deploy.add_argument('run_number', type=int)
    deploy.add_argument('--rollback', action='store_true')
    subcommands.add_parser('status')
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    try:
        if args.command == 'status':
            print(json.dumps(status(root), sort_keys=True))
            return 0
        docker = DockerCompose(root)
        result = Deployment(root, docker).apply(args.digest, args.source_sha, args.run_number, args.rollback)
        print(json.dumps({
            'transactionId': result.get('transactionId'),
            'outcome': result.get('outcome'),
            'phase': result.get('phase'),
            'candidateDigest': result.get('candidateDigest'),
            'sourceSha': result.get('sourceSha'),
            'idempotent': result.get('idempotent', False),
        }, sort_keys=True))
        return 0
    except (DeploymentError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

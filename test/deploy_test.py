import fcntl
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from deploy.deployment import Deployment, DeploymentError, IMAGE_PREFIX


SOURCE_A = 'a' * 40
SOURCE_B = 'b' * 40
DIGEST_A = 'sha256:' + '1' * 64
DIGEST_B = 'sha256:' + '2' * 64


class FakeDocker:
    def __init__(self):
        self.images = {}
        self.running = None
        self.configured = f'{IMAGE_PREFIX}@{DIGEST_A}'
        self.admission = 'paused'
        self.job_counts = {'uncertain': 0, 'in_flight': 0}
        self.fail_readiness = set()
        self.fail_pull = False
        self.fail_start = set()
        self.crash_after_start = False
        self.events = []

    def add_image(self, digest, source_sha, run_number, schema='1', runtime_schema='1'):
        self.images[f'{IMAGE_PREFIX}@{digest}'] = {
            'revision': source_sha,
            'run': str(run_number),
            'schema': schema,
            'runtime_schema': runtime_schema,
        }

    def validate_candidate(self, image):
        self.events.append(('validate', image))

    def configured_image(self):
        return self.configured

    def set_configured_image(self, image):
        self.events.append(('configure', image))
        self.configured = image

    def pull(self, image):
        self.events.append(('pull', image))
        if self.fail_pull:
            raise DeploymentError('Candidate pull failed')

    def validate_container_space(self, image):
        self.events.append(('space', image))

    def schema(self, image):
        values = self.images.get(image, {})
        jobs = values.get('schema', '')
        runtime = values.get('runtime_schema', '')
        return f'{jobs}:{runtime}' if jobs and runtime else ''

    def label(self, image, label):
        key = {
            'org.opencontainers.image.revision': 'revision',
            'com.aurea.wpp.publish-run-number': 'run',
            'com.aurea.wpp.runtime-state-schema': 'runtime_schema',
        }.get(label)
        return self.images.get(image, {}).get(key, '')

    def running_image(self):
        return self.running

    def status(self):
        if not self.running:
            return None
        return {
            'control': {'admission': self.admission, 'session': 'active'},
            'status': {'lifecycle': 'ready', 'session': 'active'},
            'health': {'healthy': True},
            'jobCounts': dict(self.job_counts),
        }

    def pause(self):
        self.events.append(('pause', self.running))
        self.admission = 'paused'

    def stop(self):
        self.events.append(('stop', self.running))
        self.running = None

    def start(self, image):
        self.events.append(('start', image))
        if image in self.fail_start:
            raise DeploymentError('Candidate start failed')
        self.running = image
        self.admission = 'paused'
        if self.crash_after_start:
            self.crash_after_start = False
            raise KeyboardInterrupt('synthetic lost response')

    def initialize_volume(self, image):
        self.events.append(('initialize_volume', image))

    def wait_ready(self):
        self.events.append(('ready', self.running))
        if self.running in self.fail_readiness:
            raise DeploymentError('Candidate readiness failed')
        return self.status()

    def resume(self):
        self.events.append(('resume', self.running))
        self.admission = 'resumed'


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wpp-deploy-test-')
        self.root = Path(self.temp.name)
        self.docker = FakeDocker()

    def tearDown(self):
        self.temp.cleanup()

    def deploy(self, digest, source_sha, run_number, rollback=False):
        return Deployment(self.root, self.docker).apply(digest, source_sha, run_number, rollback)

    def test_rejects_tags_and_untrusted_shell_input(self):
        with self.assertRaisesRegex(DeploymentError, 'Image digest'):
            self.deploy('latest; touch /tmp/bad', SOURCE_A, 1)
        self.assertEqual(self.docker.events, [])


    def test_success_preserves_an_intentional_pause(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.docker.job_counts = {'uncertain': 2, 'in_flight': 0}
        self.docker.running = f'{IMAGE_PREFIX}@{DIGEST_A}'
        result = self.deploy(DIGEST_A, SOURCE_A, 1)
        self.assertEqual(result['outcome'], 'completed')
        self.assertEqual(self.docker.admission, 'paused')
        self.assertNotIn(('resume', f'{IMAGE_PREFIX}@{DIGEST_A}'), self.docker.events)
        self.assertEqual(result['lastSuccessful']['digest'], DIGEST_A)
        self.assertEqual(result['uncertainJobCount'], 2)

    def test_fresh_volume_is_initialized_before_worker_start(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        names = [name for name, _ in self.docker.events]
        self.assertLess(names.index('initialize_volume'), names.index('start'))

    def test_resumed_worker_resumes_only_after_candidate_readiness(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        self.docker.admission = 'resumed'
        self.docker.add_image(DIGEST_B, SOURCE_B, 2)
        result = self.deploy(DIGEST_B, SOURCE_B, 2)
        events = [name for name, _ in self.docker.events]
        self.assertLess(events.index('ready', events.index('start')), events.index('resume'))
        self.assertEqual(result['outcome'], 'completed')
        self.assertEqual(self.docker.admission, 'resumed')

    def test_failed_readiness_rolls_back_compatible_image_and_stays_paused(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        self.docker.admission = 'resumed'
        self.docker.add_image(DIGEST_B, SOURCE_B, 2)
        self.docker.fail_readiness.add(f'{IMAGE_PREFIX}@{DIGEST_B}')
        with self.assertRaisesRegex(DeploymentError, 'readiness'):
            self.deploy(DIGEST_B, SOURCE_B, 2)
        state = Deployment(self.root, self.docker).state_path.read_text()
        self.assertIn('previous_image_restored_paused', state)
        self.assertEqual(self.docker.running, f'{IMAGE_PREFIX}@{DIGEST_A}')
        self.assertEqual(self.docker.admission, 'paused')
        self.assertNotIn(('resume', f'{IMAGE_PREFIX}@{DIGEST_A}'), self.docker.events)

    def test_schema_mismatch_fails_before_pause_or_stop(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        self.docker.admission = 'resumed'
        self.docker.add_image(DIGEST_B, SOURCE_B, 2, schema='2')
        with self.assertRaisesRegex(DeploymentError, 'database schema'):
            self.deploy(DIGEST_B, SOURCE_B, 2)
        self.assertNotIn('pause', [name for name, _ in self.docker.events])
        self.assertNotIn('stop', [name for name, _ in self.docker.events])

    def test_pull_failure_does_not_pause_or_stop_the_current_worker(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        self.docker.admission = 'resumed'
        self.docker.add_image(DIGEST_B, SOURCE_B, 2)
        self.docker.fail_pull = True
        with self.assertRaisesRegex(DeploymentError, 'Candidate pull failed'):
            self.deploy(DIGEST_B, SOURCE_B, 2)
        names = [name for name, _ in self.docker.events]
        self.assertNotIn('pause', names)
        self.assertNotIn('stop', names)
        self.assertEqual(self.docker.admission, 'resumed')

    def test_failed_candidate_start_restores_previous_image_paused(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        self.docker.admission = 'resumed'
        self.docker.add_image(DIGEST_B, SOURCE_B, 2)
        self.docker.fail_start.add(f'{IMAGE_PREFIX}@{DIGEST_B}')
        with self.assertRaisesRegex(DeploymentError, 'Candidate start failed'):
            self.deploy(DIGEST_B, SOURCE_B, 2)
        self.assertEqual(self.docker.running, f'{IMAGE_PREFIX}@{DIGEST_A}')
        self.assertEqual(self.docker.admission, 'paused')

    def test_missing_previous_schema_blocks_automatic_rollback(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        self.docker.images[f'{IMAGE_PREFIX}@{DIGEST_A}']['schema'] = ''
        self.docker.admission = 'resumed'
        self.docker.add_image(DIGEST_B, SOURCE_B, 2)
        self.docker.fail_readiness.add(f'{IMAGE_PREFIX}@{DIGEST_B}')
        with self.assertRaisesRegex(DeploymentError, 'readiness'):
            self.deploy(DIGEST_B, SOURCE_B, 2)
        self.assertIsNone(self.docker.running)
        self.assertEqual(self.docker.admission, 'paused')

    def test_incomplete_transaction_recovers_without_a_second_owner(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.docker.crash_after_start = True
        with self.assertRaises(KeyboardInterrupt):
            self.deploy(DIGEST_A, SOURCE_A, 1)
        self.assertEqual(self.docker.running, f'{IMAGE_PREFIX}@{DIGEST_A}')
        self.docker.add_image(DIGEST_B, SOURCE_B, 2)
        with self.assertRaisesRegex(DeploymentError, 'incomplete'):
            self.deploy(DIGEST_B, SOURCE_B, 2)
        result = self.deploy(DIGEST_A, SOURCE_A, 1)
        self.assertEqual(result['outcome'], 'completed')
        self.assertEqual(self.docker.events.count(('start', f'{IMAGE_PREFIX}@{DIGEST_A}')), 2)
        self.assertEqual(self.docker.admission, 'paused')

    def test_completed_transaction_is_idempotent(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 1)
        self.deploy(DIGEST_A, SOURCE_A, 1)
        event_count = len(self.docker.events)
        result = self.deploy(DIGEST_A, SOURCE_A, 1)
        self.assertTrue(result['idempotent'])
        self.assertEqual(len(self.docker.events), event_count)

    def test_older_release_needs_explicit_rollback(self):
        self.docker.add_image(DIGEST_A, SOURCE_A, 5)
        self.deploy(DIGEST_A, SOURCE_A, 5)
        self.docker.add_image(DIGEST_B, SOURCE_B, 4)
        with self.assertRaisesRegex(DeploymentError, 'explicit rollback'):
            self.deploy(DIGEST_B, SOURCE_B, 4)
        result = self.deploy(DIGEST_B, SOURCE_B, 4, rollback=True)
        self.assertEqual(result['lastSuccessful']['runNumber'], 4)

    def test_host_lock_rejects_competing_deployment(self):
        path = self.root / 'state' / 'deploy.lock'
        path.parent.mkdir(mode=0o700)
        with path.open('a+') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(DeploymentError, 'host lock'):
                self.deploy(DIGEST_A, SOURCE_A, 1)
        self.assertEqual(self.docker.events, [])


class TailscaleCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wpp-tailscale-test-')
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.capture = self.root / 'args.txt'
        fake = self.bin / 'tailscale'
        fake.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$@" > "$TAILSCALE_CAPTURE"\n'
            'exit "${TAILSCALE_EXIT:-0}"\n',
            encoding='utf-8',
        )
        fake.chmod(0o755)
        self.script = Path(__file__).resolve().parent.parent / 'deploy' / 'tailscale-deploy.sh'

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, target, digest, sha, run_number, rollback, exit_code='0'):
        environment = os.environ.copy()
        environment.update({
            'PATH': f'{self.bin}:{environment["PATH"]}',
            'TAILSCALE_CAPTURE': str(self.capture),
            'TAILSCALE_EXIT': exit_code,
        })
        return subprocess.run(
            ['bash', str(self.script), target, digest, sha, run_number, rollback],
            env=environment, capture_output=True, text=True,
        )

    def test_runs_only_the_fixed_remote_script_with_validated_arguments(self):
        result = self.invoke('deploy@worker.tailnet.ts.net', DIGEST_A, SOURCE_A, '7', 'true')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.capture.read_text().splitlines(), [
            'ssh', 'deploy@worker.tailnet.ts.net',
            '/opt/wpp-vip-ingest/deploy/deploy-container.sh',
            DIGEST_A, SOURCE_A, '7', '--rollback',
        ])

    def test_rejects_shell_injection_before_ssh(self):
        result = self.invoke('deploy@worker;touch /tmp/bad', DIGEST_A, SOURCE_A, '7', 'false')
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.capture.exists())

    def test_propagates_remote_failure(self):
        result = self.invoke('deploy@worker.tailnet.ts.net', DIGEST_A, SOURCE_A, '7', 'false', '17')
        self.assertEqual(result.returncode, 17)


if __name__ == '__main__':
    unittest.main()

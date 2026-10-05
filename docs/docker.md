# Docker Compose operations

Docker Compose is the only supported live runtime. Native macOS live operation is retired. The container owns the Baileys session, SQLite database, authentication files, and runtime control state. A read-only host directory supplies the complete `phone` and `group` source.

**Before / after:** Before this change, a LaunchAgent started Node directly and used a removable lock directory. After this change, Compose starts one container, and `flock` holds a stable lock file for each live command.

## Setup

Install Docker Engine with the Compose v2 plugin on Linux, or Docker Desktop on macOS. The host must keep its Docker runtime available. Docker Desktop may stop or sleep with its user session; confirm its startup and sleep behavior before a live trial.

Create local configuration and a source directory:

```sh
cp .env.example .env
chmod 600 .env
mkdir -p source
printf '[]\n' > source/source.json
```

Edit `.env`. Replace the sample group and operator identifiers with approved values. Keep `WPP_IMAGE=wpp-vip-ingest:local` for a local build. The source file must contain only `phone` and `group` fields. Do not put credentials, database files, or customer source data in Git.

Build and check the local image:

```sh
docker compose build
docker compose config --quiet
npm run demo
```

The demo uses a simulated socket. It does not connect to WhatsApp. The container runs as UID 1000. The `init-data` service sets the data volume owner before the worker starts. It does not make the files world-writable.

## Pair and start

Pair with the same data volume that the worker will use:

```sh
docker compose run --rm worker pair
```

Scan the QR with the Business app. Pairing requires the worker to be stopped. The entry wrapper holds the stable `/data/worker.lock` file through the whole live command. The kernel releases the lock when the process exits. Do not remove this file.

Start the worker:

```sh
docker compose up -d worker
docker compose exec worker node src/cli.mjs health
docker compose exec worker node src/cli.mjs runtime-status
```

The first data volume starts with admission paused. Pairing does not resume it. The worker still connects and becomes `ready`, but it does not import source rows, accept `/add` work, or claim jobs until an operator resumes it.

Check that the source and groups are valid, then resume:

```sh
docker compose exec worker node src/cli.mjs resume
```

The worker reads the source every ten seconds and processes up to ten queued jobs per cycle. It processes one job at a time. Repeated source entries keep the same job state. They do not cause a second addition.

Replace source snapshots by writing a complete sibling file, then renaming it in the same host directory. The worker mounts the directory read-only and sees the rename. This uses synthetic identifiers; replace them with approved data:

```sh
cat > source/source.json.next <<'JSON'
[
  { "phone": "+5511999999999", "group": "123456789@g.us" }
]
JSON
mv -f source/source.json.next source/source.json
```

## Pause, status, and health

Pause persists in SQLite, even if the worker is stopped:

```sh
docker compose exec worker node src/cli.mjs pause
docker compose exec worker node src/cli.mjs runtime-status
```

`pause` waits for current command work and the active admission attempt to drain. It returns an error if the worker does not confirm the drain within 60 seconds. The pause remains set after that error. An interrupted `in_flight` job becomes `uncertain` on owner recovery. Do not retry an uncertain job automatically.

Health reads the local runtime snapshot. It does not open a Baileys connection or read SQLite. Health reports process liveness; it does not mean WhatsApp is ready or admission is resumed. A worker in `needs_pairing` can be healthy while admission stays paused. `runtime-status` shows the lifecycle and control state. Neither command prints phone numbers or credentials.

Docker marks an unhealthy container. Compose does not restart a container only because it is unhealthy. A non-logout transport failure drains and exits nonzero, so `restart: unless-stopped` can reconnect. An invalid configuration stays visibly failed until an operator fixes it. Logout and missing pairing credentials persist `needs_pairing` and do not enter a reconnect loop. An interrupted `in_flight` job becomes `uncertain`; a restart does not retry it.

`status` is a local operator command and includes phone numbers. Do not publish its output:

```sh
docker compose run --rm --no-deps worker status
```

## Live review and retry

Every command that opens Baileys uses the same file lock. Stop the worker before a live membership check or retry:

```sh
docker compose exec worker node src/cli.mjs pause
docker compose stop -t 60 worker
docker compose run --rm --no-deps worker check JOB_ID
docker compose run --rm --no-deps worker retry JOB_ID "Checked in WhatsApp; prior operation settled; member absent"
docker compose up -d worker
```

The `check` command is read-only. `retry` only queues an uncertain job after the membership check confirms absence and the operator supplies a review note. It does not perform the addition. Resume only after the worker is ready:

```sh
docker compose exec worker node src/cli.mjs resume
```

An `invite_required` job cannot be retried. No command sends an invitation or a group response.

## Logout and pairing recovery

Logout sets the durable session state to `needs_pairing` and pauses admission before the application closes its socket. The worker stays visible and does not open another session or show a QR. It keeps the authentication files.

Pair explicitly with the worker stopped:

```sh
docker compose stop -t 60 worker
docker compose run --rm worker pair
docker compose up -d worker
docker compose exec worker node src/cli.mjs runtime-status
```

Successful credential writes clear `needs_pairing`. Admission stays paused. Resume only after the status shows a fresh `ready` worker and an active session. Do not delete the data volume as a pairing repair.

## Backup and restore

Stop the worker before backup. The `backup` command takes a consistent SQLite copy with `VACUUM INTO` and copies authentication files with restrictive permissions. It requires the same advisory lock as the worker.

Example for the default named volume:

```sh
docker compose exec worker node src/cli.mjs pause
docker compose stop -t 60 worker

set -euo pipefail
umask 077
backup_root="$HOME/wpp-vip-backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 -p "$backup_root"
image="$(sed -n 's/^WPP_IMAGE=//p' .env)"
container="wpp-backup-$stamp"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

docker create --name "$container" --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=1777 \
  --tmpfs /backup:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700 \
  --volume wpp-vip-ingest_wpp-data:/data \
  --env WPP_DATA_DIR=/data \
  "$image" backup "/backup/$stamp"
docker start --attach "$container"
docker cp "$container:/backup/$stamp" "$backup_root/"
docker rm "$container"
trap - EXIT
chmod -R go-rwx "$backup_root/$stamp"
```

This archive includes `jobs.db`, `runtime-state.sqlite`, and `auth/`. It does not include the source directory. Back up that directory under the business data policy. Store the archive in a separate encrypted location. Never restore an older jobs database over current records as an image rollback. An old database can forget completed additions and allow duplicates.

To restore, use a new empty volume. Keep the old volume until the restored worker is verified. Run this while the worker is stopped:

```sh
restore_volume="wpp-vip-ingest-restore-$stamp"
docker volume create "$restore_volume"
docker run --rm --read-only --user 0:0 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --volume "$restore_volume:/data" \
  --volume "$backup_root/$stamp:/backup:ro" \
  --entrypoint /bin/sh "$image" -ec '
    install -d -o 1000 -g 1000 -m 700 /data/auth
    install -o 1000 -g 1000 -m 600 /backup/jobs.db /data/jobs.db
    install -o 1000 -g 1000 -m 600 /backup/runtime-state.sqlite /data/runtime-state.sqlite
    if [ -d /backup/auth ]; then
      cp -a /backup/auth/. /data/auth/
      chown -R 1000:1000 /data/auth
      find /data/auth -type d -exec chmod 700 {} +
      find /data/auth -type f -exec chmod 600 {} +
    fi
  '
```

Set `WPP_DATA_VOLUME` in `.env` to the new volume name. Start the worker, inspect `runtime-status` and `status`, and resume only after readiness is clear. Do not use volume deletion as routine cleanup.

## Image digest deployment

Production Compose configuration must use the public GHCR image by digest, not by a moving tag:

```text
WPP_IMAGE=ghcr.io/aurea-ecom-labs/wpp-vip-ingest@sha256:<64 lowercase hex characters>
```

The deploy workflow selects only a digest from a successful trusted `main` publish record. It does not accept a caller-supplied image name. The host script validates the digest, image labels, schema, runtime, source mount, and free space. It serializes deployment with a stable host lock and stores transaction state outside the image under `state/deployment.json`. When no worker is running, it runs `init-data` on the configured volume before the candidate starts.

After the owner chooses and verifies a non-root deployment account, install the same reviewed commit under the fixed path. Replace `DEPLOY_USER` with that configured account:

```sh
DEPLOY_USER='the-configured-account'
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 /opt/wpp-vip-ingest
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 /opt/wpp-vip-ingest/state
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 /opt/wpp-vip-ingest/src /opt/wpp-vip-ingest/docker /opt/wpp-vip-ingest/deploy
sudo install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0640 Dockerfile .dockerignore compose.yaml package.json package-lock.json /opt/wpp-vip-ingest/
sudo cp -R src/. /opt/wpp-vip-ingest/src/
sudo cp -R docker/. /opt/wpp-vip-ingest/docker/
sudo install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 deploy/deploy-container.sh deploy/deployment-status.sh /opt/wpp-vip-ingest/deploy/
sudo install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0640 deploy/deployment.py /opt/wpp-vip-ingest/deploy/
```

Create `/opt/wpp-vip-ingest/.env` with mode `0600`, an absolute read-only source path, the persistent volume name, approved groups/operators, and the current tested image digest. Do not copy `.env.example` unchanged to a live host. The deployment account needs access to the intended Docker runtime. Docker access can control the host; choose its privilege boundary with care. Do not expose a Docker TCP API.

The target host name, account, Docker context, source path, and pairing state are owner settings. They are not configured by this repository. The production GitHub environment needs `WPP_DEPLOY_HOST` and `WPP_DEPLOY_USER` variables, plus `TS_FEDERATED_CLIENT_ID` and `TS_AUDIENCE` secrets. The Tailscale identity, tailnet rules, GitHub environment restrictions, package visibility, and host Docker startup are still owner setup.

The first cutover needs a stopped LaunchAgent, a consistent backup, a paused replacement, and a manual Business app/API check. Do not run both old and new workers against the same WhatsApp account. No live deployment or cutover has been verified by this code change.

## Build and test both CPUs

The pull request workflow uses native amd64 and arm64 GitHub runners. It runs unit/CLI tests, deployment transaction tests, Docker builds, a Baileys import, Compose validation, and lifecycle tests inside the built image. The publish workflow pushes a platform image, pulls and tests that exact digest, then assembles the multi-platform tag only after both platform jobs pass. BuildKit produces provenance and an SBOM. `npm audit` checks locked npm dependencies; it is not a claim that the OS image has no vulnerabilities. Review vulnerability reports and update the pinned base digest when required.

The local test command skips container tests when Docker is not available. Run all container tests with an image and a running Compose v2 daemon:

```sh
WPP_TEST_IMAGE=wpp-vip-ingest:test WPP_REQUIRE_DOCKER_TESTS=1 node --test test/container.test.mjs
```

This does not replace the separate macOS Docker Desktop trial or live account compatibility check.

## Expected behavior

- Given a new data volume, when Compose starts the worker, then admission stays paused until `resume` passes configuration and readiness checks.
- Given a pause during an active attempt, when the attempt drains, then no next job is claimed and the pause remains after restart.
- Given logout, when the worker restarts, then it stays healthy in `needs_pairing` without opening another session or showing a QR.
- Given a deployment failure, when the host restores a compatible image, then it keeps the same volume and job database and leaves admission paused.
- Given an uncertain result, when a container restarts, then the worker does not repeat the addition.

## Verification status

Unit, CLI, and fake deployment tests run without a WhatsApp account. The container suite requires Docker Compose. This development host has a Docker CLI, but its daemon and Compose plugin are not available, so local container build and lifecycle results are not claimed. No registry publish, tailnet join, SSH operation, host change, or live WhatsApp operation was run.

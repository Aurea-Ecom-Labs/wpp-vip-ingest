# macOS host

Docker Compose is the only supported live runtime on macOS. Docker Desktop runs the Linux container in its Linux VM. Install and start Docker Desktop, then check that `docker compose version` works before you use the worker.

**Before / after:** Before this change, launchd owned the native worker process. Now Compose owns the worker process. The old LaunchAgent installer is disabled; it does not stop an already installed LaunchAgent.

Follow [Docker Compose operations](docker.md) to configure `.env`, the read-only `source/` directory, and the persistent data volume. Use these commands from the repository root:

```sh
cp .env.example .env
chmod 600 .env
mkdir -p source
printf '[]\n' > source/source.json
docker compose build
docker compose run --rm worker pair
docker compose up -d worker
docker compose exec worker node src/cli.mjs runtime-status
docker compose exec worker node src/cli.mjs resume
```

Replace the sample group and operator values in `.env` before live use. Pairing closes its session after credentials are saved. Admission remains paused until `resume` succeeds.

Stop the worker before `check`, `retry`, or `pair`. The container entry wrapper holds one OS-managed lock for each live command. Do not run `node src/cli.mjs worker` or use the old LaunchAgent installer.

The LaunchAgent files remain only for migration history. `deploy/install-launchagent.sh` now stops with a deprecation message. If a LaunchAgent is already installed, the owner must stop and disable it before pairing or starting Compose. This repository does not alter launchd on the Mac.

Docker Desktop availability depends on its login, startup, and sleep settings. A sleeping Mac cannot process work. macOS Docker Desktop startup, pairing, Business app behavior, and official API compatibility need an owner trial. CI on a macOS Node runner would not prove Docker Desktop behavior.

## Expected behavior

- Given Docker Desktop is stopped, when an operator runs Compose, then the worker does not start.
- Given a new container volume, when pairing succeeds, then admission remains paused.
- Given a session logout, when Docker restarts the worker, then it does not show a QR or reconnect until explicit pairing.

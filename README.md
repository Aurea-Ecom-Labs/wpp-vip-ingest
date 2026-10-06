# wpp-vip-ingest

Small WhatsApp group-addition prototype for macOS and Linux. Docker Compose runs the Baileys worker and its local SQLite records.
It has a JSON source, an `/add` command adapter, and one long-running worker.
It has no event export, message archive, customer reply, offer sender, or invitation sender.

## Responsibility boundary

**Consent and customer authorization belong to the business domain.**
Every number in the controlled source is accepted as authorized by the business.
The service does not check consent. It has no consent reference, consent version, consent table, or consent callback.
The business decides which numbers enter the source. The service performs technical validation and group additions.
The source needs only a number and a group:

```json
[
  { "phone": "+5511999999999", "group": "123456789@g.us" }
]
```

Use a full international number with `+`. The group must be a configured WhatsApp group JID.
Phone syntax validation is not a complete check of national numbering plans.
PN/LID identity mappings come from Baileys responses and group metadata. The source does not need to supply them.
Never interpret an `@lid` identifier as a phone number.

## Test without a WhatsApp account

Install Node.js 24 or later. Then run:

```sh
npm test
npm run test:deploy
npm run demo
```

Unit tests and the demo do not connect to WhatsApp. `npm test` skips container tests when a Docker daemon is not available. The demo uses a simulated socket. `npm run test:deploy` tests the host transaction logic with a fake Docker adapter and needs Python 3.

Container tests use the built image, SQLite, and an explicit fake transport. They need a running Docker Compose v2 daemon:

```sh
WPP_TEST_IMAGE=wpp-vip-ingest:test WPP_REQUIRE_DOCKER_TESTS=1 node --test test/container.test.mjs
```

CI is configured to build and test native amd64 and arm64 images. Simulated checks do not prove live WhatsApp behavior, Docker Desktop behavior, Tailscale policy, or server deployment.

## Compose setup and live trial

```sh
cp .env.example .env
chmod 600 .env
export WPP_UID="$(id -u)" WPP_GID="$(id -g)"
mkdir -p source
printf '[]\n' > source/source.json
docker compose build
docker compose run --rm worker pair
docker compose up -d worker
docker compose exec worker node src/cli.mjs runtime-status
```

Replace the sample group and operator identifiers in `.env`. Add only business-approved `phone` and `group` rows to `source/source.json`. Scan the QR with the Business app's linked-device function. No official Business API token is used.
If WhatsApp logs out, the worker stays in `needs_pairing`. Stop the worker before running `docker compose run --rm worker pair` again. The command uses the same data volume and lock.
Do not change the production number's official API registration to test this prototype.
Verify that the app session and official API messaging still work after pairing.

The first data volume starts paused. After the worker status is `ready`, resume explicitly:

```sh
docker compose exec worker node src/cli.mjs health
docker compose exec worker node src/cli.mjs resume
```

The connected account must be an admin of the target group.
Only an allowed operator who is also a group admin can use `/add +5511999999999`.
The worker accepts notify events only. It ignores commands older than five minutes.
It resolves commands from the account itself through the socket's own identity.
It does not send a group acknowledgement or private message. Read results with `status`.

The worker imports the source every ten seconds and processes at most ten queued entries per cycle.
It uses one connection and performs additions sequentially. Repeated source entries do not create another job.
The timer interval and cycle limit are prototype values, not a guarantee of WhatsApp acceptance.
Keep all live numbers, source files, credentials, databases, and logs outside Git. Compose mounts the source directory read-only and stores credentials, runtime state, and SQLite in the named `wpp-data` volume.

## Results

| Status | Meaning | Further automatic action |
| --- | --- | --- |
| `queued` | Waiting for an attempt | One attempt |
| `in_flight` | Attempt is running | No second attempt |
| `added` | Successful result and membership confirmed | None |
| `already_member` | Member was present | None |
| `invite_required` | Response contains invitation-request evidence | None; no invitation sent |
| `uncertain` | Error, timeout, unmatched result, refusal without invitation evidence, or unconfirmed success | None; human review required |
| `bot_not_admin` | Connected account lacks group admin rights | None |
| `not_registered` | Number lookup returned no registered account | None |

A returned promise or `200` status alone is not enough for `added`.
The service checks the participant response and then reads current membership.
An `add_request` response node takes priority over `200` and produces `invite_required`.
A plain `403` is not proof of the exact cause. Without invitation evidence it produces `uncertain`.
All thrown errors and server-error responses produce `uncertain`.
No raw invitation token is stored or sent. No `sendMessage` function is called by the application.

Uncertain jobs remain stopped after restart. An interrupted `in_flight` job becomes `uncertain`.
Source re-import cannot reset an existing job, including one for a member who later leaves.
There is no automatic retry, reconciliation loop, or automatic re-addition.

## Human review

Pause and stop the worker before using the live review commands. They need exclusive session ownership.
Inspect the group in the WhatsApp UI. Wait for any previous operation to settle.
Then run a read-only membership check:

```sh
docker compose exec worker node src/cli.mjs pause
docker compose stop -t 60 worker
docker compose run --rm --no-deps worker status
docker compose run --rm --no-deps worker check JOB_ID
```

The `check` command reports `present`, `absent`, or `uncertain`. It sends no addition request.
If the result remains uncertain, stop. If the member is present, do not try another addition.
For an uncertain job with confirmed absent membership, record a human review note:

```sh
docker compose run --rm --no-deps worker retry JOB_ID "Checked in WhatsApp; prior operation settled; member absent"
```

This command rechecks membership and returns the job to `queued` only when membership is absent.
It does not send the addition itself. Start the worker, inspect readiness, then explicitly resume admission to perform the requested attempt.
An `invite_required` job cannot be returned to the queue by this command.

## Host operation

Use Docker Compose on macOS and Linux. See [Docker Compose operations](docs/docker.md) and [macOS host notes](docs/macos.md).
Native LaunchAgent operation is retired. The legacy installer now exits with a deprecation message. Stop any installed LaunchAgent before pairing or starting the container.

**Before / after:** Before this change, LaunchAgent ran the live Node process on macOS. Now Docker Compose owns the live process on macOS and Linux. Local simulated tests still run directly under Node.

The CLI also has a manual `backup DIRECTORY` command for the stopped worker. The owner runs it when needed; it copies authentication files and job records. Read the [backup warning and procedure](docs/docker.md#backup-and-restore) before use. This sensitive-data warning does not block normal worker operation.

## Scope and limits

This is a prototype extracted from the earlier admission design, not a GitHub fork that contains the full upstream TUI.
It uses the command and headless-runtime approach studied in `he4rt/wpp-tui`.
The implementation is new code. It deliberately omits the collector and export components.
Baileys is pinned to `7.0.0-rc13`, the version inspected in the upstream project.

The live adapter uses Baileys file-based authentication for this trial. The data volume is private and the entry wrapper uses `flock` on a stable lock file. The operating system releases the lock when the process exits. Do not remove the lock file.
A non-logout transport failure drains and exits nonzero; Compose may restart the process. An interrupted `in_flight` job becomes `uncertain` and is not retried. Logout or missing pairing credentials persists `needs_pairing`, keeps credentials, and blocks reconnects until explicit pairing. No automatic credential deletion or uncertain-job retry is implemented.

The prototype covers standalone groups first. Community propagation is not implemented or assumed.
The official API number's linked-device compatibility must be checked in a live trial.
See [Baileys response evidence](docs/baileys-responses.md) and [architecture](docs/architecture.md).

## Learn the deployment design

Read the [current and proposed design](docs/learning/design-guide.md), [identity and private deployment](docs/learning/identity-and-deployment.md), and [implementation handoff](docs/learning/implementation-plan.md). They distinguish code in this repository from owner configuration that is not verified here.

## Expected behavior

- Given a new Docker data volume, when the worker starts, then it is paused until an operator resumes it.
- Given a paused worker receives `/add`, when it handles the command, then it reports a local paused result and creates no receipt or job.
- Given an uncertain addition, when the worker restarts, then it does not send the addition again.
- Given the session logs out, when the container restarts, then the worker stays visible in `needs_pairing` until an operator pairs it.
- Given the worker is stopped, when the owner runs `backup DIRECTORY`, then SQLite and auth data are copied with restrictive permissions.

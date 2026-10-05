# wpp-vip-ingest

Small WhatsApp group-addition prototype for macOS. It uses Baileys and local SQLite records.
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
npm run demo
```

These commands do not need dependencies installed. They do not connect to WhatsApp.
The demo uses a simulated socket. Thirty-one tests passed on Linux with Node.js v24.19.0.
The test suite includes application flows, SQLite persistence, and a CLI smoke run.
The pinned live dependencies were installed and passed an import smoke check without opening a WhatsApp connection.
It does not prove live WhatsApp behavior or macOS execution.

## Live trial

```sh
npm ci
export WPP_DATA_DIR="$HOME/Library/Application Support/wpp-vip-ingest"
npm run pair
node src/cli.mjs groups
```

Scan the QR with the Business app's linked-device function. No official Business API token is used.
If WhatsApp closes the first pairing connection with a restart-required result, run `npm run pair` again.
Do not change the production number's official API registration to test this prototype.
Verify that the app session and official API messaging still work after pairing.

Then configure one private test group and an operator identity:

```sh
export WPP_GROUPS="123456789@g.us"
export WPP_OPERATORS="5511777777777@s.whatsapp.net"
export WPP_SOURCE="$WPP_DATA_DIR/source.json"
# Create source.json with numbers approved by the business.
npm start
```

The connected account must be an admin of the target group.
Only an allowed operator who is also a group admin can use `/add +5511999999999`.
The worker accepts notify events only. It ignores commands older than five minutes.
It resolves commands from the account itself through the socket's own identity.
It does not send a group acknowledgement or private message. Read results with `status`.

The worker imports the source every ten seconds and processes at most ten queued entries per cycle.
It uses one connection and performs additions sequentially. Repeated source entries do not create another job.
The timer interval and cycle limit are prototype values, not a guarantee of WhatsApp acceptance.
Keep all live numbers, source files, credentials, databases, and logs outside Git.

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

Stop the worker before using the live review commands. They need exclusive session ownership.
Inspect the group in the WhatsApp UI. Wait for any previous operation to settle.
Then run a read-only membership check:

```sh
node src/cli.mjs status
node src/cli.mjs check JOB_ID
```

The `check` command reports `present`, `absent`, or `uncertain`. It sends no addition request.
If the result remains uncertain, stop. If the member is present, do not try another addition.
For an uncertain job with confirmed absent membership, record a human review note:

```sh
node src/cli.mjs retry JOB_ID "Checked in WhatsApp; prior operation settled; member absent"
```

This command rechecks membership and returns the job to `queued` only when membership is absent.
It does not send the addition itself. Restart the worker to perform the explicitly requested attempt.
An `invite_required` job cannot be returned to the queue by this command.

## macOS deployment

Use launchd, not systemd. See [macOS instructions](docs/macos.md).
The installation script creates a user LaunchAgent with absolute Node and project paths.
It preserves credentials and job records in Application Support.
A LaunchAgent runs while its user session is available. It is not a system service before login.
An asleep or powered-off Mac cannot process jobs. Treat availability as a deployment requirement.

## Scope and limits

This is a prototype extracted from the earlier admission design, not a GitHub fork that contains the full upstream TUI.
It uses the command and headless-runtime approach studied in `he4rt/wpp-tui`.
The implementation is new code. It deliberately omits the collector and export components.
Baileys is pinned to `7.0.0-rc13`, the version inspected in the upstream project.

The live adapter uses file-based authentication for the trial. Baileys does not recommend that helper for production.
Replace it with a durable credential and Signal-key store before production use.
Only one local process may own the account session. A lock prevents a second live command or worker from starting.
After a crash, inspect the process state before removing a stale lock. Do not bypass this check.
Connection loss stops the worker. launchd can restart it after a nonzero exit, but stopped admission jobs remain stopped.
Logout leaves credentials in place and exits successfully so launchd does not repeatedly try to pair.
Use manual pairing to restore the session. No automatic credential deletion is implemented.

The prototype covers standalone groups first. Community propagation is not implemented or assumed.
The official API number's linked-device compatibility must be checked in a live trial.
See [Baileys response evidence](docs/baileys-responses.md) and [architecture](docs/architecture.md).

## Learn the deployment design

Read the [current and proposed design](docs/learning/design-guide.md), [identity and private deployment](docs/learning/identity-and-deployment.md), and [detailed implementation handoff](docs/learning/implementation-plan.md). These explain the planned Docker, GHCR, CI, and Tailscale changes. They do not claim that those changes are implemented.

# Learn the current and container design

Design date: 2026-10-05. Main baseline before implementation: `d0be25e` (includes the prototype at `c9fd452`).

This is teaching documentation. It explains what each module does and how the modules work together. The worker lifecycle, Docker files, CI workflows, and deployment scripts are implemented in this branch. Native amd64 and arm64 container CI passed in run `37405763481`; local Docker Desktop and all owner infrastructure setup remain unverified. Read [the implementation plan](implementation-plan.md) and [identity and deployment](identity-and-deployment.md) for remaining evidence.

## 1. Start with the business boundary

The business decides which customers are authorized. Every number in the controlled source is accepted as authorized. The service has no consent reference, version, table, or callback. A row needs only `phone` and `group`. The service checks technical input, configured groups, operator identity, WhatsApp identity, and membership.

A phone number is not a WhatsApp LID. A PN JID identifies an account through a phone number, such as `5511999999999@s.whatsapp.net`. A LID, such as `200@lid`, is a separate identifier. Baileys responses and metadata provide their mapping. Never infer a phone number from LID digits.

## 2. AS-IS: current repository code

```text
                       macOS or Linux host
  +----------------------------------------------------------+
  | Docker Compose -> one non-root Node worker -> Baileys -----+--> WhatsApp
  |                       |                                  |
  | read-only JSON source +-> validate -> SQLite jobs          |
  | group /add event --------> operator/admin check            |
  |                                   |                        |
  |                    one claim -> attempt -> confirmed result|
  |                                   |                        |
  | data volume: auth, jobs.db, runtime-state.sqlite, lock     |
  +----------------------------------------------------------+

  Pull request -> native amd64/arm64 image tests; read-only token
  Trusted main -> platform publish/test -> multi-platform GHCR digest
  Manual dispatch -> tested digest -> Tailscale SSH script (owner setup pending)
```

`src/cli.mjs` parses commands and routes them to `WorkerRuntime`. The runtime injects transport, clock, timers, and data paths for tests. It imports JSON every ten seconds and processes up to ten queued jobs per cycle. Additions run sequentially.

`src/admission.mjs` owns technical admission decisions and the existing `jobs.db` schema. A phone/group pair identifies one durable job. Importing the same pair again does not reset it. Commands have message receipts to prevent repeated processing. The command queues work; it does not send a group reply. Versioned admission/session control lives separately in `runtime-state.sqlite`, so the first container release does not change the admission database schema.

`src/baileys.mjs` owns the live connection and file-based credentials. It classifies logout as `needs_pairing` before the first successful connection too. `src/fake-transport.mjs` is selected explicitly by tests; a failed live connection never falls back to it. `src/source.mjs` parses and validates the complete source snapshot before importing it.

The account must be a group admin. An allowed command operator must also be a group admin. A returned promise does not prove that an addition succeeded. The service requires a matching participant response and membership confirmation.

```text
  queued -> in_flight -> added / already_member
                    |-> invite_required -> STOP
                    |-> uncertain -------> STOP
                    |-> bot_not_admin ---> STOP
                    +-> not_registered --> STOP

  crash with in_flight -> uncertain after owner recovery
  uncertain -> human UI review -> explicit check -> explicit retry
  invite_required -> no invite, no automatic retry
```

The tests cover admission outcomes, SQLite, PN/LID resolution, pause/resume, lifecycle recovery, backup permissions, and deployment transactions. Container tests run the fake transport and SQLite inside the built image. PR run `37405763481` passed these tests on native amd64 and arm64 runners. This development host has no running Docker daemon or Compose plugin. No test proves live WhatsApp behavior.

### Current gaps that matter for containers

Live ownership uses `flock` on a stable file in the data volume. The process does not unlink it. The operating system releases the lock after process death without PID checks.

Shutdown blocks new claims and command work, then drains active operations and credential writes for up to 60 seconds. A timeout ends the process and leaves any persisted `in_flight` job for recovery as `uncertain`.

Logout writes `needs_pairing` and pauses admission. A worker with that marker stays alive and does not reconnect or generate a QR. Explicit pairing uses the same lock and volume.

The code now has local health/readiness snapshots, pause/resume commands, Docker packaging, Compose, container lifecycle tests, GHCR workflows, a deployment transaction, and a manual Tailscale deploy workflow. Native CI Docker builds and container tests passed. Live owner configuration has not been verified. File-based Baileys auth remains a trial choice; durable credential and Signal-key storage remains separate production work.

## 3. Compose worker image

```text
                        macOS or Linux host
  +-------------------------------------------------------------+
  | container runtime                                            |
  |   +-------------------------------------------------------+  |
  |   | one worker container                                  |  |
  |   | Node.js + pinned dependencies + application            |--+--> WhatsApp
  |   | session state + health + bounded shutdown              |  |
  |   +-----------+------------------------+------------------+  |
  |               | read only              | read/write          |
  |       controlled source mount     persistent data volume     |
  |                                   jobs + auth + identities    |
  |                                   session-stop + pause state  |
  +-------------------------------------------------------------+

  Linux: Docker Engine uses the host Linux kernel.
  macOS: the runtime runs Linux containers in a Linux VM.
```

An image is the packaged program. A container is one running instance of that image. A registry stores images. Compose describes the container's settings and mounts. A volume stores data outside the container's replaceable filesystem.

The Dockerfile pins a Node.js 24 Debian base digest and installs locked dependencies with `npm ci --omit=dev`. The image defaults to UID 1000; Compose runs as the configured non-root `WPP_UID`/`WPP_GID`. No inbound application port is needed for the worker. The worker has no Docker socket mount.

Use one persistent local volume for `jobs.db`, `runtime-state.sqlite`, credentials, and identity mappings. Use a separate read-only mount for the source directory. Mount the directory rather than one source file so an atomic file replacement is visible. Keep both SQLite files on local storage; do not place their WAL files on a network filesystem. Source updates should write a complete temporary file and rename it into place.

The same image name can refer to a manifest with `linux/amd64` and `linux/arm64` variants. An Intel machine selects amd64. An Apple Silicon Mac selects arm64 inside the Linux VM. CPU support must be built and tested, not assumed.

## 4. Data safety is separate from container availability

Restarting a process is useful after a connection failure. It is not permission to repeat a customer addition. An uncertain job stays stopped even if the container restarts ten times.

Keep three states separate:

| State | Question | Example |
| --- | --- | --- |
| Process health | Is the worker alive and its heartbeat fresh? | Worker loop is responding |
| Session readiness | Is WhatsApp connected and usable? | Connected, credentials persisted |
| Admission mode | May the worker claim new jobs? | Paused for deployment verification |

A logged-out worker remains alive in `needs_pairing`, with admission paused. This makes its blocked state visible and prevents reconnect loops. It does not create a QR automatically. Pairing is an explicit interactive command, with the worker stopped and the same data volume attached. Successful pairing clears the stop marker only after credentials are saved. Admission remains paused until an explicit resume.

A healthcheck reads local state. It must not connect a second Baileys session, send messages, or add numbers. Docker marks health failures; a normal Compose healthcheck does not itself restart an unhealthy container. The deployment workflow must inspect readiness explicitly.

## 5. Why deployment needs a pause gate

```text
  old worker running
          |
  persist PAUSED -> drain active attempt -> stop old worker
          |
  start candidate PAUSED -> connect -> verify readiness
          |
       success? -- no --> stop candidate; retain PAUSED; inspect
          |
         yes
          |
  explicit resume -> new worker may claim queued jobs
```

Without this gate, a new image can process customers before verification finishes. A deployment failure could then have external effects even if the image is rolled back.

The pause gate stops new source imports, command receipts, and queued-job claims. In-flight work gets a bounded time to finish. If it cannot finish, its outcome becomes uncertain. Pause does not undo a WhatsApp request already sent. The host transaction script records uncertain-job counts and never resets the records.

There is one session owner. Replacement is stop-then-start, with a short outage. Never run the old and new workers together for the same account, even on two different hosts. A local lock cannot prevent a copy of credentials on another host from connecting.

## 6. CI proves the image; CD changes the server

CI means continuous integration: checks that changes fit together. CD here means deployment: replacing the server's running version. A runner is the temporary machine that executes a workflow job. The runner is not the production worker. Workflow code exists, but these workflows have not run from this feature branch yet.

```text
  pull request -> isolated tests -> image tests -> result
                     NO tailnet or production credentials

  trusted main -> tests -> images -> GHCR immutable digest
                                         |
  manual deploy request -----------------+
          |
  deployment runner -> temporary tailnet identity -> server
          |
  pause -> stop -> replace -> verify -> resume -> cleanup
```

An image tag is a name that can move. A digest identifies exact image content. Publish a commit tag for human use, but deploy by digest. GHCR is GitHub Container Registry. It is separate from the Git repository: pushing code does not publish an image.

The publish job uses its scoped `GITHUB_TOKEN` with `packages: write`. The deployment job does not need package write access. The selected package path is public, so the server can pull without a registry password. The owner must still set package visibility and test an anonymous pull. No source rows or credentials enter the image.

CI builds each native CPU image, pulls the exact published platform digest, and runs container tests before assembling the manifest. Simulated flows prove application and container behavior. A manual trial with the account proves live compatibility. Do not make production customer additions part of CI.

## 7. What rollback can and cannot do

A rollback changes the executable image. It cannot remove an addition that WhatsApp already completed. Keep current job records. Restoring an older database can forget completed additions and permit duplicates.

The first container release should not change the admission database schema. Later migrations need an explicit compatibility policy. Rollback is permitted only if the previous image can read the current schema. If compatibility or outcome is uncertain, remain paused and request human review.

The server script builds a deployment transaction: one serialized image replacement with atomic phase records outside the image. It pulls the candidate before stopping the old worker, records the previous digest, validates the SQLite schema label, and checks readiness before it resumes. A lost SSH connection is not proof that nothing happened; the next call reads the recorded transaction. Rollback changes only the image and preserves both databases and the data volume.

## 8. How to maintain these learning materials

The Markdown documents are the authoritative teaching source. The separate HTML page is a snapshot of the same material; it is not committed to this repository and is not available in this checkout. It remains an owner follow-up. Mark code as implemented only with test evidence. Keep registry, tailnet, host, and live-account claims proposed until an owner verifies them.

## Expected behavior

- Given a first container start, when the session is ready, then admission remains paused until an explicit resume.
- Given a fresh logout, when the worker restarts, then it remains visible in `needs_pairing` and does not connect.
- Given an interrupted job, when a replacement starts with the same volume, then the job becomes `uncertain` and is not retried.
- Given either CPU platform fails its image tests, when the publish workflow finishes, then no multi-platform commit manifest is assembled.
- Given host or tailnet facts are missing, when code checks finish, then no live deployment is claimed as verified.

## Sources

These are official references checked on 2026-10-05. Configuration examples are project proposals, not evidence of configured infrastructure.

- [Docker multi-platform CI](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
- [Docker Desktop VM](https://docs.docker.com/desktop/features/vmm/)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action)
- [Tailscale workload identity federation](https://tailscale.com/docs/features/workload-identity-federation)
- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)
- [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc)

- [Tailscale grants](https://tailscale.com/docs/features/access-control/grants)

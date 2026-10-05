# Learn the current and proposed design

Design date: 2026-10-05. Current code baseline: `c9fd452`.

This is teaching documentation. It explains what each component does, why it is needed, and how the components work together. The Docker and deployment design below is proposed work. It is not implemented by this documentation commit. Read [the implementation plan](implementation-plan.md) after this guide and [identity and deployment](identity-and-deployment.md).

## 1. Start with the business boundary

The business decides which customers are authorized. Every number in the controlled source is accepted as authorized. The service has no consent reference, version, table, or callback. A row needs only `phone` and `group`. The service checks technical input, configured groups, operator identity, WhatsApp identity, and membership.

A phone number is not a WhatsApp LID. A PN JID identifies an account through a phone number, such as `5511999999999@s.whatsapp.net`. A LID, such as `200@lid`, is a separate identifier. Baileys responses and metadata provide their mapping. Never infer a phone number from LID digits.

## 2. AS-IS: what the repository does today

```text
                       macOS host
  +-------------------------------------------------------+
  | launchd -> Node.js CLI -> one Baileys connection ------+----> WhatsApp
  |                       |                               |
  | controlled JSON ------+--> validate -> SQLite queue    |
  | group /add event -----+--> operator/admin check -------+
  |                                 |                     |
  |                  claim one job -> attempt -> result    |
  |                                 |                     |
  | Application Support: auth files, jobs.db, worker.lock  |
  +-------------------------------------------------------+

  GitHub Actions -> macOS runner -> tests + demo + shell syntax
  No image build. No registry publish. No remote deployment.
```

`src/cli.mjs` owns command routing, the session lock, source polling, signal handling, and the worker loop. It imports JSON every ten seconds and processes up to ten queued jobs per cycle. Additions run sequentially.

`src/admission.mjs` owns technical admission decisions and SQLite records. A phone/group pair identifies one durable job. Importing the same pair again does not reset it. Commands have message receipts to prevent repeated processing. The command queues work; it does not send a group reply.

`src/baileys.mjs` owns the connection and file-based credentials. It loads live dependencies only for live commands. Tests and the demo use a simulated socket. `src/source.mjs` parses and validates the complete source snapshot before importing it.

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

The current tests cover the application state rules, SQLite, PN/LID resolution, commands, and a CLI smoke run. The original CI runs them on macOS. It does not install live dependencies. A local dependency import smoke check was performed separately. Neither proves live WhatsApp behavior.

### Current gaps that matter for containers

The session lock is a directory. Normal shutdown removes it. A forced termination leaves it behind. The next live command refuses to start. A container restart policy alone cannot fix that.

Shutdown closes the connection as soon as a signal arrives. The active admission operation can then fail or time out. The plan must define a bounded drain and preserve uncertain outcomes.

An observed logout exits with code zero, but no durable session-stop marker exists. A later host restart can launch the worker again. Logout before the first connection opens is currently reported as a generic startup error. Both paths need a persistent stop state.

There is no readiness interface, paused admission mode, image, Compose file, or deployment workflow. File-based Baileys auth remains a trial choice. Its replacement with durable credential and Signal-key storage is a separate production requirement.

## 3. TO-BE: one portable worker image

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

The image includes Node.js 24, the locked dependencies, and the application. Use a Debian-based Node image initially to reduce native-library compatibility differences. Run as a non-root user. No inbound application port is needed for the worker. Do not mount the Docker socket into it.

Use one persistent local volume for SQLite, credentials, identities, and runtime control state. Use a separate read-only mount for the source directory. Mount the directory rather than one source file so an atomic file replacement is visible. Keep SQLite on local storage; do not place its WAL database on a network filesystem. Source updates should write a complete temporary file and rename it into place.

The same image name can refer to a manifest with `linux/amd64` and `linux/arm64` variants. An Intel machine selects amd64. An Apple Silicon Mac selects arm64 inside the Linux VM. CPU support must be built and tested, not assumed.

## 4. Data safety is separate from container availability

Restarting a process is useful after a connection failure. It is not permission to repeat a customer addition. An uncertain job stays stopped even if the container restarts ten times.

Keep three states separate:

| State | Question | Example |
| --- | --- | --- |
| Process health | Is the worker alive and its heartbeat fresh? | Worker loop is responding |
| Session readiness | Is WhatsApp connected and usable? | Connected, credentials persisted |
| Admission mode | May the worker claim new jobs? | Paused for deployment verification |

A logged-out worker should remain alive in `needs_pairing`, with admission paused. This makes its stopped state visible and prevents restart loops. It must not create a QR automatically. Pairing is an explicit interactive command, with the worker stopped and the same data volume attached. Successful pairing clears the stop marker only after credentials are saved. Admission remains paused until an explicit resume.

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

The pause gate stops new source imports, command enqueueing, and queued-job claims. In-flight work gets a bounded time to finish. If it cannot finish, its outcome becomes uncertain. Pause does not undo a WhatsApp request already sent.

There is one session owner. Replacement is stop-then-start, with a short outage. Never run the old and new workers together for the same account, even on two different hosts. A local lock cannot prevent a copy of credentials on another host from connecting.

## 6. CI proves the image; CD changes the server

CI means continuous integration: checks that changes fit together. CD here means deployment: replacing the server's running version. A runner is the temporary machine that executes a workflow job. The runner is not the production worker.

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

The publish job uses its scoped `GITHUB_TOKEN` with `packages: write`. The deployment job does not need package write access. A public repository does not automatically make its new package public. The owner must check package visibility. The first design uses an explicitly public image, so the server can pull it without a registry password. No source rows or credentials enter the image.

CI must run the built image, not only tests on the runner. Test both CPU variants. Simulated flows prove application and container behavior. A manual trial with the account proves live compatibility. Do not make production customer additions part of CI.

## 7. What rollback can and cannot do

A rollback changes the executable image. It cannot remove an addition that WhatsApp already completed. Keep current job records. Restoring an older database can forget completed additions and permit duplicates.

The first container release should not change the admission database schema. Later migrations need an explicit compatibility policy. Rollback is permitted only if the previous image can read the current schema. If compatibility or outcome is uncertain, remain paused and request human review.

Build and pull the candidate before stopping the old worker. Record the previous digest. Keep deployment metadata outside the image. A CI disconnection can occur after the server changes. Therefore the server records transaction phases and status; a lost SSH connection is not proof that nothing happened.

## 8. How to maintain these learning materials

The Markdown documents are the authoritative teaching source. The separate HTML page is a snapshot of the same material; it is not committed to this repository. It must show its baseline and date. When a change is requested, inspect the current code, update AS-IS first, revise TO-BE and acceptance tests, then regenerate the HTML. Mark completed plan steps as implemented with their commit and evidence. Never turn a proposal into an AS-IS claim before it is verified.

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

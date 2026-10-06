# Implementation handoff: Docker, CI, and private deployment

Status: CODE AND NATIVE CONTAINER CI COMPLETE; OWNER/LIVE ACCEPTANCE INCOMPLETE. Date: 2026-10-06.

The remote `main` baseline for this work is `d0be25e44fb231817999658b930f430b95d687d2`. The plan's `c9fd452` is an earlier prototype commit already included in that baseline. The baseline working tree was clean. All 31 baseline tests passed on Node.js `v25.9.0`.

This branch is `feat/docker-ci-deployment`, in [PR #1](https://github.com/Aurea-Ecom-Labs/wpp-vip-ingest/pull/1). GitHub run `37407432992` passed the native amd64 and arm64 container jobs for commit `bc5f00c`. Native live execution is retired by owner decision; local fake tests remain native. The selected package path is public GHCR, but package settings are not verified. No image was published. No tailnet join, SSH operation, server change, pairing, or live WhatsApp operation was performed.

Local `npm test` passes 48 tests, with one container test file skipped because no image was set. `npm run test:deploy` passes 21 tests. The pinned Baileys import succeeds. Native amd64/arm64 container tests passed in GitHub run `37407432992`. This host has Docker CLI `29.5.3` but no running daemon or Compose plugin. macOS Docker Desktop and live/remote acceptance remain open.

Read `design-guide.md` and `identity-and-deployment.md` first. This plan is for a coding agent and the infrastructure owner. Complete one phase at a time. Do not report remote configuration or live behavior as verified without evidence.

## Goal and fixed requirements

Make Docker Compose the primary deployment path for macOS and Linux. Build and test amd64 and arm64 images. Publish trusted versions to GHCR. Add a manually triggered deployment workflow through Tailscale SSH. Preserve the existing phone/group source contract and all admission outcome rules.

Do not add consent checks, invite sending, event export, offer sending, automatic uncertain-job retries, community propagation, or concurrent session owners. Do not require live credentials in CI. Do not enable automatic production deployment on every main push in the first release.

## Phase 0: establish facts before changing code

Agent: read the current remote main, all source files, tests, docs, lockfile, and any AGENTS.md. Record baseline SHA and working tree status. Work on a feature branch and open a reviewable PR. Preserve user changes. Re-run the baseline tests once. Inspect installed Baileys behavior when changing connection handling; do not rely only on this plan.

Owner: supply the following facts through configuration, not hardcoded code:

| Fact | Reason |
| --- | --- |
| Target host name and CPU architecture | Choose the tested platform and target |
| Tailscale installation variant and version | Determine macOS SSH server capability |
| Docker runtime and startup model | Determine availability after login/reboot |
| Deployment account and Docker socket/context | Verify the account can control the intended runtime |
| Current tailnet policy and Tailnet Lock state | Evaluate effective access and registration prerequisites |
| Public or private GHCR package decision | Determine pull authentication |
| Persistent data/source locations and current pairing state | Plan safe cutover |

Public GHCR was selected for the first release. The following owner facts remain unknown: target host and CPU, Tailscale installation/version, Docker startup model and context, deployment account access, effective tailnet policy and Tailnet Lock, package linkage/visibility, persistent source/data locations, current pairing state, and current LaunchAgent state.

Stop only the dependent live deployment work if these facts are missing. Continue code, tests, and explanatory docs. Do not guess a host or weaken SSH policy.

Acceptance: baseline reproduced; external unknowns listed; no production operation performed.

**Code status:** baseline tests were reproduced. The installed Baileys package was inspected for `DisconnectReason.loggedOut` and `connection.update` behavior. Owner facts above remain unresolved. The branch has not performed production operations.

## Phase 1: extract a testable worker lifecycle

**Code status:** implemented in `src/runtime.mjs`, `src/runtime-state.mjs`, `src/cli.mjs`, and tests. Local tests cover persistent pause, invalid resume, stale health, logout before ready, pause during an attempt, repeated signals, and bounded shutdown. Native container CI passed in PR run `37407432992`.

Expected files: new `src/runtime.mjs` and `src/runtime-state.mjs`; refactor `src/cli.mjs`; update `src/baileys.mjs` and tests. Final names may differ if documented.

Separate CLI parsing from the worker lifecycle. Inject transport, clock, timers, and local data paths for tests. Keep `Admission` responsible for admission rules. Add persistent control state with an explicit version and atomic writes: admission paused/resumed and session active/needs_pairing. Default the first Docker deployment to paused. Existing native behavior must have an explicit migration decision, documented and tested.

Define lifecycle states: starting, connecting, ready, draining, needs_pairing, failed. Write a local status snapshot with instance identity and a heartbeat. Health reads this snapshot and checks its recorded process identity, without opening SQLite or a Baileys connection. Report no phone numbers or raw credentials in health output. A stale snapshot must not look healthy after a restart.

Add commands `health`, `pause`, `resume`, and `runtime-status`. Pause persists even when the process exits. Resume refuses if session-stop is set, configuration is invalid, or readiness is stale. Paused commands must not consume a message receipt and silently lose an operator request; report a local paused result and do not enqueue it. Do not send a group response.

Shutdown: stop new claims and command work, drain the active attempt and credential writes within a documented limit, then close the socket and database. The admission timeout is currently 30 seconds; give the container a larger stop grace period, initially 60 seconds. If draining cannot finish, leave a durable in_flight/uncertain record that owner recovery stops. Handle repeated signals and close errors without removing ownership while code is still using the session.

Acceptance: tests cover pause during a running operation, no new claim after pause, restart retains pause, invalid resume fails, stale health fails, and bounded shutdown does not resend.

## Phase 2: session ownership and logout

**Code status:** Linux Compose commands use one stable `flock` file. Native live operation is retired; launchd instructions and installer are marked deprecated. Native container CI passed logout persistence, forced-kill recovery, and competing-owner tests. No live logout or pairing was run.

Replace the directory-only lock with an OS-managed exclusive advisory lock on a stable file in the shared local data volume. On Linux containers, an entry wrapper can use `flock` for the full live process lifetime. Every command that opens Baileys must use the same lock. Do not unlink the locked file. OS release on process death removes the stale-directory problem. Do not use PID existence alone: container PID namespaces and PID reuse make that unsafe.

If native macOS execution remains supported, choose and test an equivalent advisory-lock mechanism. Do not run two unrelated lock mechanisms against the same session. If native live execution is retired, say so and make the docs direct operators to the container. Local simulated tests can remain native.

Classify logout even before the first successful connection. Persist needs_pairing before closing. While needs_pairing is set, a worker stays in a visible blocked state without opening a session or generating a QR. Pairing requires the worker stopped and exclusive lock ownership; clear the marker only after successful credential persistence. Keep admission paused after pairing.

Acceptance: two live owners cannot start against one volume; forced kill releases ownership; replacement recovers interrupted jobs as uncertain; logout survives a container/runtime restart; explicit pairing and resume work in a fake transport test. No automatic credential deletion.

## Phase 3: container package and Compose

**Code status:** Dockerfile, Compose configuration, entry wrapper, `.env.example`, ignore rules, and `docs/docker.md` are present. Node 24 Debian base digest is pinned. Run `37407432992` passed native amd64/arm64 builds, Baileys imports, Compose validation, non-root writes, and source mount checks. macOS Docker Desktop remains an owner trial.

Add `Dockerfile`, `.dockerignore`, `compose.yaml`, a container entry wrapper, `.env.example`, and `docs/docker.md`.

Use Node.js 24 on Debian, pin a reviewed base digest, and install with `npm ci --omit=dev`. Include the locked native dependencies and required build/runtime libraries. Run direct Node as the worker process with correct signal forwarding. Run as non-root; provide volume initialization with correct ownership. Never solve permission errors with world-writable auth files.

Exclude data, auth, databases, logs, environment secrets, local artifacts, and `.git` from the build context. The image must contain no live configuration. Configure one replica, read-only root filesystem where possible, writable local data volume and temporary directory, read-only source directory, no published worker ports, no Docker socket, stop grace period, and bounded log rotation.

Use a restart policy such as unless-stopped only after durable needs_pairing prevents reconnect loops. A healthcheck is observation, not an admission action or a second connection. Docker does not restart on unhealthy status by itself. Document this.

Use explicit image digest configuration for deployment. Provide local build commands and interactive pair commands. Explain how to stop the worker for live review commands, attach the same data volume, and restart paused or resumed. Preserve the volume during replacement. Do not use volume deletion as routine cleanup.

Acceptance: clean build on both architectures; non-root write access; Baileys import works; no secrets in image/context; pair/help/health commands route correctly; demo runs inside the image; source directory atomic replacement is visible.

## Phase 4: container behavior tests

**Code status:** explicit fake transport and container lifecycle tests are present. Run `37407432992` passed the synthetic lifecycle cases inside native amd64 and arm64 containers and uploaded test records/logs. The local host still cannot run Docker containers.

Add a fake transport entry point that exercises the real worker lifecycle and SQLite without contacting WhatsApp. The live transport remains the default; tests select the fake explicitly. CI must never silently fall back from a failed live transport to simulation.

Test in actual containers: first startup paused, resume, successful simulated addition, repeated source entry, privacy add_request with status403 and status200, error/timeout, healthy needs_pairing, forced-kill in_flight, replacement with same volume, exclusive ownership, source mount permissions, graceful SIGTERM, and stale health. Check persistent records after each relevant replacement. Assert one simulated external write where required.

Use deterministic fault hooks/barriers rather than arbitrary long sleeps. A failed test must leave useful synthetic logs, without credentials or customer data. Clean up test containers and temporary volumes only.

Acceptance: results test behavior and observable records, not only file syntax. Architecture variants both run, preferably on native amd64/arm64 runners. If emulation is used, label that limitation. macOS Docker Desktop smoke is a separate owner trial; macOS-hosted Node tests are not a Docker Desktop test.

## Phase 5: CI and image publication

**Code status:** the read-only PR workflow passed in run `37407432992`; the trusted-main publish workflow has not run. Actions use commit SHA references. The publish workflow tests each platform digest before manifest assembly and requests provenance/SBOM. No image has been published. GHCR linkage, public visibility, and anonymous pull remain unverified.

Extend or replace `.github/workflows/test.yml`. Add a publish workflow. Pin external actions to reviewed commit SHAs. Use minimum job permissions.

Pull request jobs: contents read; no package writes, OIDC permission, tailnet access, production environment, or live data. Run unit/CLI tests, Docker build, native-dependency imports, Compose validation, and container lifecycle tests on amd64 and arm64.

Trusted main publish: use the same tested image artifacts or prove the published image digest was tested. Do not test one image and publish a separately rebuilt unverified image. Assemble the multi-platform manifest only from successful platform results. Publish commit tags and record the manifest digest, platform digests, source SHA, and checks. Use packages write only for this job. Add OCI source/revision labels. Produce provenance and an SBOM; never place secrets in build arguments. Vulnerability reports need a defined response, not a claim of absolute safety.

Owner: permit GHCR publishing in the organization, link package to repository, and explicitly set public visibility for the proposed public-image path. Validate anonymous pull from a clean environment. A private package needs a separate read-only server credential design.

Acceptance: untrusted PR cannot publish or join tailnet; both platform images tested; published digest and commit traceable; clean anonymous pull works if public.

## Phase 6: server deployment transaction

**Code status:** fixed host scripts and fake Docker/Tailscale adapters are present. The transaction reads persisted mode when no worker is running, initializes the volume, and writes a paused state before candidate start. If rollback cannot confirm pause, it leaves all workers stopped. Twenty-one local tests cover digest validation, ordering, schema mismatch, pause preservation, rollback, host serialization, interrupted recovery, preflight failure, idempotency, container identity/source access, safe remote arguments, the fixed remote command, and readiness summaries. The deploy status output includes sanitized readiness. No host Compose or Tailscale integration trial has run.

Add `deploy/deploy-container.sh`, `deploy/deployment-status.sh`, and tests. Install reviewed scripts and trusted Compose configuration at a fixed host location. Prefer a fixed server-side script over arbitrary remote shell assembled by CI. Define the deployment account's real privilege boundary; Docker access is powerful. Do not expose a remote Docker TCP API.

Inputs: approved image prefix plus digest, target-local configuration. Reject arbitrary image names, tags when a digest is required, invalid digest syntax, and injected shell text. Quote all arguments. Serialize deployments on the host as well as in GitHub. Persist transaction ID, previous/candidate digests, and phases atomically.

Transaction order:

1. Validate candidate schema compatibility, runtime availability, source/config access, and disk space. Pull candidate before disruption.
2. Persist pause and wait for drain acknowledgement. Record any uncertain jobs; do not reset them.
3. Stop the old container and prove it exited before starting another owner.
4. Start candidate paused with the same volume. Wait a bounded time for process health and WhatsApp readiness.
5. Record verified candidate. Resume only when the previous mode was resumed and all readiness checks pass; preserve an intentional pre-existing pause.
6. On failure, remain paused. If a compatible previous digest is available, stop candidate before restoring it. Record outcome and return failure even if restoration works.

If session needs pairing, do not label deployment ready or unpause it. If SSH is lost, the next invocation reads transaction status before doing work. Idempotency must recognize a completed transaction and not replay it. Do not restore an old job database as part of image rollback.

Acceptance: fake Docker/SSH command tests cover failures at each phase, lost response after replacement, competing deployments, interrupted transaction recovery, intentional pause preservation, failed readiness, and rollback compatibility. Integration trial proves stop-then-start with persistent records.

## Phase 7: owner identity and tailnet setup

**Code status:** deployment workflow inputs match this design. The production environment, OIDC trust, tailnet policy, Tailnet Lock, server account, SSH, and Docker access are not configured or tested.

The owner creates the production GitHub environment, restricts deployment branches, creates tags, and creates the federated identity. Use the exact issuer, environment subject, audience, and claim restrictions described in `identity-and-deployment.md`. Use auth_keys scope and only the runner tag. Do not create broad wildcard trust.

Merge narrow network and SSH rules into the existing tailnet policy. Remove or adjust broader rules that would accidentally grant CI unrelated access. Validate policy tests. Confirm macOS CLI Tailscale SSH capability, local account existence, target tag uniqueness, host SSH exposure, and Docker access. Preserve existing human access and a local recovery path. Do not switch Tailscale variants or edit the live policy without owner authorization.

Acceptance: authorized workflow joins; unauthorized branch/repository fails; target TCP22 allowed; unrelated target/port denied; selected SSH account allowed; other account denied; ordinary SSH remains unavailable; normal cleanup removes temporary node. Record any Tailnet Lock/device approval prerequisites.

## Phase 8: deployment workflow

**Code status:** manual workflow code is present. It resolves only a successful main publish record, checks release order, uses the production environment, and joins through Tailscale SSH. It has not run because owner secrets, environment rules, federation, and target details are not configured.

Add `.github/workflows/deploy.yml` with workflow_dispatch initially. Resolve the requested digest from a successful trusted publish record for main; do not accept an arbitrary untested image. Re-check candidate age/order so a delayed job cannot replace a newer release without an explicit rollback request.

Use the production environment, contents read and id-token write for this job, and the federated identity inputs. Join with the deployment tag. Connect through Tailscale SSH to the configured host/account. Invoke the fixed deployment script and query transaction status. Serialize by target; do not cancel a deployment already replacing a worker. Use job timeouts and bounded server operations. Cleanup must run after failure where possible.

Acceptance: manual deployment of a tested digest succeeds on a non-production trial target; failed readiness keeps admission paused; cleanup occurs; job summary includes commit, digest, transaction result, and sanitized readiness. Only then perform the owner-approved real account trial.

## Phase 9: cutover, docs, and later automation

**Code status:** README, architecture, macOS, Docker, identity, and implementation documents are updated. The CLI has a manual `backup DIRECTORY` command to support the owner backup task; it does not run automatically. The separate HTML snapshot is not in this repository. LaunchAgent shutdown, backup/restore execution, volume migration, Business app/API checks, reboot, logout, rollback, and production cutover remain owner work. Automatic deployment is not enabled.

Owner: stop/disable the original LaunchAgent before pairing or running the container. Back up stopped state using a consistent SQLite backup, including credentials with restrictive permissions. Migrate the data into the container volume and validate file ownership. Run first replacement paused. Verify official Business API and app behavior manually. Use a private test group and approved test numbers. Do not infer compatibility from simulated CI.

Agent: update README, docs/architecture.md, macOS instructions, these teaching files, and the separate HTML snapshot. Mark what is implemented and what remains proposed. Add exact local/container commands and recovery explanations. Retain legacy launchd files only with a clear deprecated status if native operation is retired.

After owner evidence proves cutover, failures, reboot/runtime restart, logout/pairing, and rollback, propose automatic deployment after trusted main publication. Do not enable it silently. A first Docker installation still has host startup and sleep constraints.

## Completion evidence

The final PR must report changed behavior, tests for both CPUs, published-image verification if enabled, and unresolved external setup. Infrastructure completion requires owner evidence for federation, effective policy, SSH, Docker access, package visibility, and the Mac trial. Code completion is not deployment completion. Preserve uncertain admission results throughout every phase.

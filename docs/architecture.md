# Architecture

The business supplies approved `phone` and `group` rows. Every source row is accepted as business-authorized. The service validates technical input, configured groups, operator identity, WhatsApp identity, and membership. It does not validate customer consent.

**Before / after:** Before this change, `src/cli.mjs` owned parsing, locking, connection setup, and the worker loop. Now `WorkerRuntime` owns the loop, while the CLI routes commands and Compose owns the live process.

## Runtime path

```text
  ┌───────────────────────┐     read-only      ┌────────────────────┐
  │ Host source directory │ ─────────────────► │ Compose worker     │
  └───────────────────────┘                    │ Node 24 + Baileys  │
                                               └───────┬────────────┘
                                                       │ SQLite
                            OS advisory lock            ▼
  ┌───────────────────────┐ ◄─────────────────── ┌──────────────┐
  │ WhatsApp session      │                      │ Data volume  │
  │ one owner only        │                      │ jobs + auth  │
  └───────────────────────┘                      │ control state│
                                                 └──────────────┘
```

An OS advisory lock is a stable file lock held by the kernel while a process uses the session. The Docker entry wrapper uses `flock` for the full lifetime of `worker`, `pair`, `groups`, `check`, `retry`, and `backup`. The lock file is not deleted. Process exit releases the lock.

The source parser validates the complete JSON snapshot before import. `Admission` stores jobs, attempts, command receipts, and explicit PN/LID mappings in SQLite. A phone/group pair has one durable job. Numeric LIDs are never converted to phone numbers.

`RuntimeStateStore` stores versioned admission and session control in a separate `runtime-state.sqlite` file. This keeps the existing `jobs.db` schema unchanged. A new control database starts paused. A short `BEGIN IMMEDIATE` transaction on the control database serializes pause/resume with each source insert, message receipt, and job claim. A pause also waits for active work to drain before it reports success. Paused `/add` commands do not consume receipts. Paused source imports do not enqueue jobs.

The worker writes `runtime-status.json` atomically. It contains an instance ID, process identity, lifecycle state, control state, and heartbeat. `health` reads this snapshot only; it does not read SQLite or credentials. `resume` and deployment readiness also check the recorded process identity with the operating system. Linux process start time makes a reused PID different from the process that wrote an old snapshot. Health reports snapshot freshness; `runtime-status` reports session readiness and admission mode.

The transport seam uses the Adapter pattern: the live Baileys adapter and the explicit fake adapter supply a session to the same worker lifecycle. This lets tests exercise the real runtime without WhatsApp. Node.js provides function parameters and module imports for this seam; it does not require a dependency-injection container.

The host transaction also uses an Adapter seam: production calls Docker Compose, while tests inject a fake Docker adapter to check ordering and rollback without changing a host. Python's standard library supplies `subprocess` and file locks; it does not include a Docker client framework. If no worker is running, the transaction runs `init-data` before it starts the candidate.

## Session and job outcomes

```text
  [starting] ──config valid──► [connecting] ──socket open──► [ready]
       │                            │                         │
       └──invalid────────────────► [failed]                  │
                                    │ logout                  │ SIGTERM
                                    ▼                         ▼
                           [needs_pairing] ◄────────────── [draining]
                                    │
                          explicit pair; paused
```

The worker claims a job before network access. The WhatsApp result must identify one participant. Invitation-request evidence produces `invite_required`, even when status is `200`. Other errors, timeouts, and unconfirmed additions produce `uncertain`. Neither state retries automatically.

```text
  queued -> in_flight -> added / already_member
                    |-> invite_required -> STOP
                    |-> uncertain -------> STOP
                    |-> bot_not_admin ---> STOP
                    +-> not_registered --> STOP

  process death with in_flight -> uncertain during owner recovery
  uncertain -> human membership check -> explicit retry only when absent
```

Pause stops new imports, command receipts, and claims. Current work drains for at most 60 seconds at shutdown; each admission network call has a 30-second timeout. If the process cannot drain, the container stop limit ends it. The persisted `in_flight` state becomes `uncertain` on the next exclusive owner start. It is not reset.

Logout or missing pairing credentials sets `needs_pairing` and pauses admission. A worker with this marker stays visible and does not connect or generate a QR. Pairing requires the worker to be stopped and the same volume. Credential writes must finish before the marker clears. Admission remains paused after pairing. Other transport failures exit nonzero after drain, so the Compose restart policy can reconnect.

## Local deployment and verification

Compose runs one non-root worker with a read-only root filesystem, one persistent local volume, a read-only source directory, no published ports, and bounded JSON logs. It has no Docker socket mount. A health check observes local status only. Docker does not restart a container only because it is unhealthy.

Pull request CI builds and tests native `linux/amd64` and `linux/arm64` images without package writes, OIDC, tailnet access, or live credentials. Trusted publish tests the exact platform digests before assembling the manifest. A manual deploy workflow uses a tested publish record and Tailscale SSH.

Container CI uses only the explicit fake transport and synthetic numbers. It does not prove live WhatsApp compatibility, Docker Desktop startup, tailnet policy, GHCR visibility, or the configured host runtime. See [Docker operations](docker.md), [macOS host notes](macos.md), and [Baileys response evidence](baileys-responses.md).

## Expected behavior

- Given a new database, when the worker starts, then it is paused and does not claim a queued job.
- Given a fresh status snapshot from a different process start, when `health` reads it, then it reports unhealthy.
- Given the session is `needs_pairing`, when the worker restarts, then it stays visible and does not connect.
- Given an addition is uncertain, when the worker restarts, then the record stays uncertain and no external write repeats.

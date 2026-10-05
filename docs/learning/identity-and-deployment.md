# Understand identity and private deployment

Status: workflow code is present in this branch. No tailnet, server, registry visibility, or GitHub environment was changed or verified.

## 1. Four separate permissions

```text
  GitHub workflow
       |
       | signed short-lived OIDC token: who is this job?
       v
  Tailscale federated identity: do its claims match?
       |
       | register temporary device with tag:wpp-deploy-ci
       v
  Tailnet network rule: may it reach target TCP 22?
       |
       v
  Tailscale SSH rule: may it log in as wppdeploy?
       |
       v
  Host account permissions: may it replace this container?
```

OIDC is OpenID Connect. Here it lets GitHub supply a signed identity token to Tailscale. The token describes the job. It does not contain the user's GitHub password. Tailscale checks the signature, issuer, audience, subject, and configured claim rules. A matching job can register a temporary tagged device. Tags give the temporary device a stable policy identity even though its machine and IP change on every run.

Network permission and SSH permission are separate. A successful ping proves neither SSH authorization nor Docker access. Host account permissions remain a fourth boundary. A deployment account that can control Docker or edit arbitrary Compose mounts has broad access to the host runtime. Tailscale destination restrictions do not make that account harmless.

## 2. A concrete identity example

Create a GitHub environment named `production`. Restrict deployment to trusted `main` code. For the initial release, use a manual `workflow_dispatch` trigger. Restrict which branches can deploy through that environment. Repository administrators decide whether to require a review gate.

Proposed federation values:

| Value | Meaning |
| --- | --- |
| Issuer `https://token.actions.githubusercontent.com` | GitHub issues the identity token |
| Subject `repo:Aurea-Ecom-Labs@278542040/wpp-vip-ingest@1405040191:environment:production` | Job belongs to this repository and uses this environment |
| Audience | Copy the exact audience from the created Tailscale federated identity |
| Runner tag `tag:wpp-deploy-ci` | Policy identity for temporary deployment devices |
| Scope `auth_keys` | The action can register the temporary node |
| Additional claim rules | Require `ref=refs/heads/main`, expected repository identity, and the intended workflow when supported |

The repository was created on 2026-10-05. GitHub documents an immutable default subject for repositories created after 2026-07-15. The example includes the owner ID 278542040 and repository ID 1405040191, read from repository metadata. Treat the string as an expected value until a controlled job proves its actual subject. Custom OIDC templates can change it. Older examples without IDs must not be copied blindly. An environment subject does not by itself restrict the branch. This is why environment branch rules and claim rules matter. Inspect non-secret claim fields for a test job and compare them with the identity configuration. Never print the full token.

The Tailscale action currently uses the input name `oauth-client-id` even for a federated identity client ID. It also takes `audience` and `tags`. The deployment job requires `id-token: write` so it can request its short-lived GitHub token. That permission does not authorize arbitrary writes to repository content.

```yaml
# Teaching fragment only. Replace action reference with a reviewed commit SHA.
permissions:
  contents: read
  id-token: write
steps:
  - uses: tailscale/github-action@v4
    with:
      oauth-client-id: ${{ secrets.TS_FEDERATED_CLIENT_ID }}
      audience: ${{ secrets.TS_AUDIENCE }}
      tags: tag:wpp-deploy-ci
```

Store the exact client ID and audience as environment secrets or controlled configuration. Federation does not need an OAuth client secret. It still requires an owner to create the trust relationship. Do not grant these inputs or tailnet access to pull request test jobs. Do not use `pull_request_target` to execute submitted code with deployment access.

## 3. Network and SSH policy

First confirm the target installation. Tailscale SSH server support on macOS requires the open-source CLI `tailscale` + `tailscaled` variant. Do not assume that the standard macOS app can accept Tailscale SSH. Do not switch installations remotely without a recovery path. Docker Desktop also needs an available logged-in user runtime; do not assume the dedicated SSH account can access another user's Docker socket.

The following is an illustrative policy addition. Merge it with the existing policy; do not replace the whole policy. `wppdeploy` must be an existing, explicitly selected host account.

```json
{
  "tagOwners": {
    "tag:wpp-deploy-ci": ["autogroup:admin"],
    "tag:wpp-vip-server": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:wpp-deploy-ci"],
      "dst": ["tag:wpp-vip-server"],
      "ip": ["tcp:22"]
    }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["tag:wpp-deploy-ci"],
      "dst": ["tag:wpp-vip-server"],
      "users": ["wppdeploy"]
    }
  ]
}
```

The tag on the target must identify only the authorized deployment server. Network grants are additive. An existing allow-all rule can still let the CI tag reach other devices. Review the effective policy, not only this new fragment. Add policy tests for allowed target access and denied unrelated access. Use a non-interactive SSH `accept` rule for the deployment identity; do not require a human check-mode login during CI.

Tailscale SSH handles the tailnet SSH connection. Ordinary macOS Remote Login/OpenSSH exposure should remain disabled under the user's policy. Validate connections from a permitted tailnet node and rejection from unauthorized nodes. Do not disable SSH host verification. Use the supported `tailscale ssh` path, which checks the target identity through Tailscale.

## 4. Why temporary access can be authorized in advance

```text
  run A -> temporary device A --+
                               +-- tag:wpp-deploy-ci -> same narrow rules
  run B -> temporary device B --+

  job ends -> action logs out -> temporary device removed
```

The policy authorizes the tag, not a fixed IP. The action registers an ephemeral device with that tag. A later job registers another device with the same policy identity. Normal job cleanup logs it out and removes it. An abruptly lost runner can delay cleanup; ephemeral status is not a promise of immediate removal in every failure. Include a cleanup check in the trial. Tailnet Lock, device approval, and organization restrictions can add prerequisites; inspect them before enabling deployment.

## 5. Registry identity is a different identity

The publish job authenticates to `ghcr.io` using its GitHub job token and `packages: write`. It publishes a lowercase image name such as `ghcr.io/aurea-ecom-labs/wpp-vip-ingest`. Add an OCI source label that links the image to this repository. Confirm organization package policy and package/repository linkage.

A code repository and its image package have separate visibility. The proposed first package is public. A public pull needs no registry credential on the Mac. If the owner chooses a private package, design server-side read-only registry authentication separately. Do not copy the publishing token onto the server. Never use image build arguments for WhatsApp credentials.

The selected first-release path is a public GHCR package. The owner must still link the package to this repository, set its visibility to public, and test an anonymous pull. The repository being public does not prove the package is public.

## 6. Remote replacement example

A deployment job receives a tested manifest digest and platform digests from the successful publish artifact. It connects to one configured MagicDNS host as the configured deployment account. It requests a fixed server-side deployment script, passing the validated digest, source SHA, and publish run number. The workflow does not accept an arbitrary image name or digest.

A deployment transaction is one serialized image replacement with durable phase records. The fixed host script owns this transaction and uses an OS lock to block a second deploy. GitHub concurrency is useful but cannot block a local operator or another workflow. The script validates the image prefix and `sha256` digest, verifies source and run labels, checks schema compatibility and disk space, pulls the candidate, persists pause, drains and stops the old owner, starts the candidate paused, verifies bounded readiness, and records success before resuming. It must never evaluate caller-supplied shell text.

A read-only local health command can run through `docker exec`. Live `check` and `retry` commands require the worker stopped because they open a session. Do not run a second live session inside an already running worker container.

If verification fails, keep admission paused. Restore the previous compatible image if that policy is explicitly enabled, then report the failure. If the SSH channel disappears, query the recorded transaction status before attempting another replacement. Never infer that a timed-out deployment made no changes.

## 7. First-use learning checks

Before a live rollout, use an isolated test service and synthetic state. Confirm that a valid production job joins, an unauthorized branch cannot join, the runner reaches only the target, the permitted account works, other accounts fail, and cleanup removes the ephemeral device. Then prove that the deployment account can reach the correct Docker runtime. These are different checks; one successful SSH command does not prove all of them.

Read the [design guide sources](design-guide.md#sources) and the [implementation plan](implementation-plan.md) for the exact work boundaries.

The workflow and scripts are not proof of authorization. Owner setup must create the production environment and restrict its branches, create the exact federated identity, review effective tailnet rules, confirm the Tailscale SSH server and account, and confirm the account's Docker access. The configured production target and package visibility remain unknown here.

## Expected behavior

- Given an untrusted pull request, when its checks run, then they receive no package-write permission, OIDC token permission, or tailnet access.
- Given a manual deploy request, when its commit has no successful trusted publish record, then digest resolution fails before joining the tailnet.
- Given a request selects an older successful publish, when rollback is false, then both the workflow and host reject it.
- Given the Tailscale trust or target configuration is absent, when deployment starts, then the job fails without changing the worker.

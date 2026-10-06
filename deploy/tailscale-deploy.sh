#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 5 ]]; then
  echo 'Expected target, digest, source SHA, publish run number, and rollback flag.' >&2
  exit 64
fi

target="$1"
digest="$2"
source_sha="$3"
run_number="$4"
rollback="$5"

[[ "$target" =~ ^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'Invalid Tailscale target.' >&2; exit 64; }
[[ "${target%%@*}" != 'root' ]] || { echo 'Do not deploy through the root account.' >&2; exit 64; }
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Invalid image digest.' >&2; exit 64; }
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid source commit.' >&2; exit 64; }
[[ "$run_number" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid publish run number.' >&2; exit 64; }
[[ "$rollback" == 'true' || "$rollback" == 'false' ]] || { echo 'Invalid rollback flag.' >&2; exit 64; }

args=("$digest" "$source_sha" "$run_number")
if [[ "$rollback" == 'true' ]]; then args+=(--rollback); fi
exec tailscale ssh "$target" /opt/wpp-vip-ingest/deploy/deploy-container.sh "${args[@]}"

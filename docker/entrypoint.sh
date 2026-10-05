#!/bin/sh
set -eu
umask 077

case "${1:-}" in
  pair|worker|groups|check|retry|backup)
    exec flock -n -F -E 75 /data/worker.lock /bin/sh -c \
      'export WPP_LOCK_HELD=1; exec node /app/src/cli.mjs "$@"' wpp-worker "$@"
    ;;
  *)
    exec node /app/src/cli.mjs "$@"
    ;;
esac

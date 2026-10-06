#!/bin/sh
set -eu

uid=${WPP_UID:-1000}
gid=${WPP_GID:-1000}
case "$uid" in ''|*[!0-9]*) echo 'WPP_UID must be numeric.' >&2; exit 1 ;; esac
case "$gid" in ''|*[!0-9]*) echo 'WPP_GID must be numeric.' >&2; exit 1 ;; esac
if [ "$uid" -eq 0 ]; then echo 'WPP_UID must not be root.' >&2; exit 1; fi

chown -R "$uid:$gid" /data
chmod 700 /data

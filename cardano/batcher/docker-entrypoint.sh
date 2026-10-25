#!/bin/sh
# Railway mounts the volume as root. The batcher runs as `node`: the key's folder is made and
# given to `node` alone (0700), then root is dropped for good (setpriv, no capabilities kept).
# Started as a non-root user already, it runs as that user.
set -eu
if [ "$(id -u)" != 0 ]; then
  exec node /app/src/main.ts "$@"
fi
if [ -n "${BATCHER_KEY_FILE:-}" ]; then
  dir=$(dirname "$BATCHER_KEY_FILE")
  mkdir -p "$dir"
  chown node:node "$dir"
  chmod 0700 "$dir"
fi
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs node /app/src/main.ts "$@"

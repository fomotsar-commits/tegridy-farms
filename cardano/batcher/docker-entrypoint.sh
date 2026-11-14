#!/bin/sh
# The key lives at the top of the volume, and only there: anywhere else is the container's own
# disk, wiped at the next deploy, and the key has no other copy (whatever was sent to it is lost).
# So a key file outside the volume's mount point (Railway's RAILWAY_VOLUME_MOUNT_PATH, else /data),
# a relative path, a folder below it, a symlink, or no volume mounted at all is refused before
# anything runs. Railway mounts the volume as root: the volume is given to `node` alone (0700),
# then root is dropped for good (setpriv, no capabilities kept), and src/supervise.ts runs the
# batcher. Started as a non-root user already, it runs as that user, after the same check.
set -eu
refuse() {
  printf '{"kind":"fatal","error":"%s"}\n' "$1"
  exit 1
}
if [ -n "${BATCHER_KEY_FILE:-}" ]; then
  case "$BATCHER_KEY_FILE" in
    /*) ;;
    *) refuse "BATCHER_KEY_FILE must be an absolute path at the top of the volume" ;;
  esac
  dir=$(dirname "$BATCHER_KEY_FILE")
  vol=${RAILWAY_VOLUME_MOUNT_PATH:-/data}
  [ "$dir" = "${vol%/}" ] || refuse "the key must be at the top of the volume (${vol}), not in ${dir}: anywhere else it is lost at the next deploy"
  { [ ! -L "$dir" ] && mountpoint -q "$dir"; } || refuse "${dir} is not a mounted volume: a key there is lost at the next deploy"
fi
if [ "$(id -u)" != 0 ]; then
  exec node /app/src/supervise.ts "$@"
fi
if [ -n "${BATCHER_KEY_FILE:-}" ]; then
  chown -h node:node "$dir"
  chmod 0700 "$dir"
fi
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs node /app/src/supervise.ts "$@"

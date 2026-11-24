#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
mkdir -p "$DATA_DIR" "$HOME"

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
  # Run as the Unraid-style user (nobody:users by default) so files in appdata are owned sensibly
  # and Claude Code is not running as root.
  getent group "$PGID" >/dev/null 2>&1 || groupadd -o -g "$PGID" splat
  getent passwd "$PUID" >/dev/null 2>&1 || useradd -o -u "$PUID" -g "$PGID" -d "$HOME" -s /bin/sh splat
  if [ "$(stat -c %u "$DATA_DIR")" != "$PUID" ] || [ "$(stat -c %u "$HOME")" != "$PUID" ]; then
    echo "Fixing ownership of $DATA_DIR for $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec gosu "$PUID:$PGID" env HOME="$HOME" "$@"
fi

exec "$@"

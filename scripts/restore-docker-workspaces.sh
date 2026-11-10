#!/bin/sh
# Restore a Roost Docker workspace backup made by backup-docker-workspaces.sh.
# Run on the Docker host with the target workspaces root.
set -eu
ARCHIVE=${1:?usage: restore-docker-workspaces.sh <archive.tar.gz> [target-root]}
TARGET=${2:-${ROOST_DOCKER_WORKSPACE_ROOT:-/var/lib/roost/workspaces}}
[ -f "$ARCHIVE" ] || { echo "missing archive: $ARCHIVE" >&2; exit 2; }
mkdir -p "$TARGET"
# Refuse to restore over a non-empty root unless explicitly forced.
if [ "$(find "$TARGET" -mindepth 1 -maxdepth 1 | head -1)" ] && [ "${ROOST_RESTORE_FORCE:-0}" != "1" ]; then
  echo "target is not empty: $TARGET (set ROOST_RESTORE_FORCE=1 to overwrite)" >&2
  exit 3
fi
tar -xzf "$ARCHIVE" -C "$TARGET"
echo "restored $ARCHIVE -> $TARGET"

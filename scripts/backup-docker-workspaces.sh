#!/bin/sh
# Backup Roost Docker workspace volumes (plain directories on the Docker host).
# Run on the Docker host as root. Container sessions are not quiesced in this
# first version; schedule it during low activity or stop workspaces first.
set -eu
WORKSPACE_ROOT=${ROOST_DOCKER_WORKSPACE_ROOT:-/var/lib/roost/workspaces}
BACKUP_ROOT=${ROOST_DOCKER_BACKUP_ROOT:-/var/backups/roost/workspaces}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_ROOT"
OUT="$BACKUP_ROOT/workspaces-$STAMP.tar.gz"
tar -czf "$OUT" -C "$WORKSPACE_ROOT" .
echo "$OUT"
# Keep 7 daily-style snapshots by default.
KEEP=${ROOST_DOCKER_BACKUP_KEEP:-7}
ls -1t "$BACKUP_ROOT"/workspaces-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

#!/usr/bin/env bash
# Roost 控制面备份：活动 SQLite 用 .backup 取一致快照，附件目录打包。
# 目标目录必须不存在；默认拒绝覆盖任何已有备份。
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
usage: backup.sh <db-path> <attachments-dir> <destination-root>

  db-path           SQLite 数据库文件（不能在备份期间被删除）
  attachments-dir   附件根目录（ROOST_ATTACHMENTS_DIR）
  destination-root  备份父目录；脚本会在其下创建 roost-backup-<UTC 时间戳>/

示例：
  deploy/backup.sh /var/lib/roost/roost.db /var/lib/roost/attachments /var/backups/roost
EOF
}

die() {
  printf 'backup: %s\n' "$*" >&2
  exit 1
}

table_counts() {
  local db=$1
  local tables table count
  tables=$(sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
  while IFS= read -r table; do
    [ -n "$table" ] || continue
    count=$(sqlite3 "$db" "SELECT COUNT(*) FROM \"$table\";")
    printf '%s %s\n' "$table" "$count"
  done <<< "$tables"
}

integrity_check() {
  local db=$1
  local result
  result=$(sqlite3 "$db" 'PRAGMA integrity_check;')
  [ "$result" = 'ok' ] || die "integrity_check failed for $db: $result"
}

if [ "$#" -ne 3 ]; then
  usage
  exit 2
fi

DB=$1
ATTACHMENTS=$2
DEST_ROOT=$3

command -v sqlite3 >/dev/null 2>&1 || die 'sqlite3 is required'
command -v tar >/dev/null 2>&1 || die 'tar is required'

[ -f "$DB" ] || die "database not found: $DB"
[ -r "$DB" ] || die "database is not readable: $DB"
[ -d "$ATTACHMENTS" ] || die "attachments directory not found: $ATTACHMENTS"
[ -r "$ATTACHMENTS" ] || die "attachments directory is not readable: $ATTACHMENTS"
[ -d "$DEST_ROOT" ] || die "destination root not found: $DEST_ROOT"
[ -w "$DEST_ROOT" ] || die "destination root is not writable: $DEST_ROOT"

DB=$(cd "$(dirname "$DB")" && pwd)/$(basename "$DB")
ATTACHMENTS=$(cd "$ATTACHMENTS" && pwd)
DEST_ROOT=$(cd "$DEST_ROOT" && pwd)

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$DEST_ROOT/roost-backup-$STAMP"
[ ! -e "$BACKUP_DIR" ] || die "refusing to overwrite existing $BACKUP_DIR"
mkdir -m 0700 "$BACKUP_DIR"

complete=0
cleanup() {
  if [ "$complete" -ne 1 ]; then
    rm -rf "$BACKUP_DIR"
  fi
}
trap cleanup EXIT

# .backup 在活动库（含 WAL）上取一致快照；不要直接 cp 活动数据库。
( cd "$BACKUP_DIR" && sqlite3 "$DB" '.backup roost.db.tmp' )
mv "$BACKUP_DIR/roost.db.tmp" "$BACKUP_DIR/roost.db"
chmod 0600 "$BACKUP_DIR/roost.db"

integrity_check "$BACKUP_DIR/roost.db"
COUNTS=$(table_counts "$BACKUP_DIR/roost.db")
for required in schema_migrations events workspaces; do
  grep -q "^$required " <<< "$COUNTS" || die "required table missing from backup: $required"
done
printf '%s\n' "$COUNTS" > "$BACKUP_DIR/counts.txt"

# COPYFILE_DISABLE 避免 macOS 把扩展属性打成 ._ 文件。
COPYFILE_DISABLE=1 tar -czf "$BACKUP_DIR/attachments.tar.gz" -C "$ATTACHMENTS" .
chmod 0600 "$BACKUP_DIR/attachments.tar.gz"

MIGRATIONS=$(sqlite3 "$BACKUP_DIR/roost.db" 'SELECT COUNT(*) FROM schema_migrations;')
LATEST=$(sqlite3 "$BACKUP_DIR/roost.db" 'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1;')
EVENTS=$(sqlite3 "$BACKUP_DIR/roost.db" 'SELECT COUNT(*) FROM events;')
WORKSPACES=$(sqlite3 "$BACKUP_DIR/roost.db" 'SELECT COUNT(*) FROM workspaces;')
ATTACHMENT_ROWS=$(sqlite3 "$BACKUP_DIR/roost.db" 'SELECT COUNT(*) FROM attachments;')

{
  printf 'format=roost-backup-v1\n'
  printf 'created_at=%s\n' "$STAMP"
  printf 'source_db=%s\n' "$DB"
  printf 'source_attachments=%s\n' "$ATTACHMENTS"
  printf 'database=roost.db\n'
  printf 'attachments=attachments.tar.gz\n'
  printf 'counts=counts.txt\n'
  printf 'integrity_check=ok\n'
  printf 'schema_migrations=%s\n' "$MIGRATIONS"
  printf 'latest_migration=%s\n' "$LATEST"
  printf 'events=%s\n' "$EVENTS"
  printf 'workspaces=%s\n' "$WORKSPACES"
  printf 'attachments_rows=%s\n' "$ATTACHMENT_ROWS"
} > "$BACKUP_DIR/manifest.txt"
chmod 0600 "$BACKUP_DIR/manifest.txt" "$BACKUP_DIR/counts.txt"

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$BACKUP_DIR" && sha256sum roost.db attachments.tar.gz counts.txt manifest.txt > SHA256SUMS )
else
  ( cd "$BACKUP_DIR" && shasum -a 256 roost.db attachments.tar.gz counts.txt manifest.txt > SHA256SUMS )
fi
chmod 0600 "$BACKUP_DIR/SHA256SUMS"

complete=1
printf 'backup: ok %s\n' "$BACKUP_DIR"
printf 'backup: events=%s workspaces=%s attachments=%s migrations=%s\n' \
  "$EVENTS" "$WORKSPACES" "$ATTACHMENT_ROWS" "$MIGRATIONS"

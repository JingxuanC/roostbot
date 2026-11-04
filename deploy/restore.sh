#!/usr/bin/env bash
# Roost 控制面恢复：把 backup.sh 产物还原到空的数据库路径与附件目录。
# 默认拒绝覆盖已有数据库或非空附件目录。
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
usage: restore.sh <backup-dir> <target-db> <target-attachments-dir>

  backup-dir             backup.sh 创建的时间戳目录
  target-db              新数据库路径（必须不存在）
  target-attachments-dir 新附件目录（可以不存在或为空）

示例：
  deploy/restore.sh /var/backups/roost/roost-backup-20261104T120000Z \
    /var/lib/roost/roost.db /var/lib/roost/attachments
EOF
}

die() {
  printf 'restore: %s\n' "$*" >&2
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

BACKUP_DIR=$1
TARGET_DB=$2
TARGET_ATTACHMENTS=$3

command -v sqlite3 >/dev/null 2>&1 || die 'sqlite3 is required'
command -v tar >/dev/null 2>&1 || die 'tar is required'

[ -d "$BACKUP_DIR" ] || die "backup directory not found: $BACKUP_DIR"
[ -f "$BACKUP_DIR/roost.db" ] || die "backup database missing: $BACKUP_DIR/roost.db"
[ -f "$BACKUP_DIR/attachments.tar.gz" ] || die "backup attachments missing: $BACKUP_DIR/attachments.tar.gz"
[ -f "$BACKUP_DIR/counts.txt" ] || die "backup counts missing: $BACKUP_DIR/counts.txt"

case "$TARGET_DB" in
  ''|'/') die "invalid target database path: $TARGET_DB" ;;
  *\'*) die "target database path must not contain a single quote" ;;
esac
case "$TARGET_ATTACHMENTS" in
  ''|'/') die "invalid target attachments path: $TARGET_ATTACHMENTS" ;;
esac

[ ! -e "$TARGET_DB" ] && [ ! -L "$TARGET_DB" ] || die "refusing to overwrite existing database: $TARGET_DB"
if [ -e "$TARGET_ATTACHMENTS" ] || [ -L "$TARGET_ATTACHMENTS" ]; then
  [ -d "$TARGET_ATTACHMENTS" ] || die "target attachments path is not a directory: $TARGET_ATTACHMENTS"
  [ -z "$(ls -A "$TARGET_ATTACHMENTS")" ] || die "refusing to overwrite non-empty attachments directory: $TARGET_ATTACHMENTS"
fi

integrity_check "$BACKUP_DIR/roost.db"

if [ -f "$BACKUP_DIR/SHA256SUMS" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS >/dev/null ) || die 'checksum verification failed'
  else
    ( cd "$BACKUP_DIR" && shasum -a 256 -c SHA256SUMS >/dev/null ) || die 'checksum verification failed'
  fi
fi

DB_DIR=$(dirname "$TARGET_DB")
ATT_PARENT=$(dirname "$TARGET_ATTACHMENTS")
mkdir -p "$DB_DIR" "$ATT_PARENT"

DB_STAGE=$(mktemp "$DB_DIR/.roost-restore-db.XXXXXX")
rm -f "$DB_STAGE"
ATT_STAGE=$(mktemp -d "$ATT_PARENT/.roost-restore-att.XXXXXX")

complete=0
cleanup() {
  if [ "$complete" -ne 1 ]; then
    rm -f "$DB_STAGE"
    rm -rf "$ATT_STAGE"
  fi
}
trap cleanup EXIT

sqlite3 "$BACKUP_DIR/roost.db" ".backup '$DB_STAGE'"
chmod 0600 "$DB_STAGE"
integrity_check "$DB_STAGE"

EXPECTED_COUNTS=$(cat "$BACKUP_DIR/counts.txt")
ACTUAL_COUNTS=$(table_counts "$DB_STAGE")
if [ "$EXPECTED_COUNTS" != "$ACTUAL_COUNTS" ]; then
  printf 'restore: row counts differ\n' >&2
  diff -u <(printf '%s\n' "$EXPECTED_COUNTS") <(printf '%s\n' "$ACTUAL_COUNTS") >&2 || true
  die 'restored database does not match backup counts'
fi

tar -xzf "$BACKUP_DIR/attachments.tar.gz" -C "$ATT_STAGE"

if [ -d "$TARGET_ATTACHMENTS" ]; then
  rmdir "$TARGET_ATTACHMENTS" || die "attachments directory became non-empty: $TARGET_ATTACHMENTS"
fi

mv "$DB_STAGE" "$TARGET_DB"
mv "$ATT_STAGE" "$TARGET_ATTACHMENTS"
complete=1

printf 'restore: ok %s\n' "$TARGET_DB"
printf 'restore: attachments=%s\n' "$TARGET_ATTACHMENTS"
printf 'restore: tables=%s\n' "$(printf '%s\n' "$ACTUAL_COUNTS" | wc -l | tr -d ' ')"
if [ -f "$BACKUP_DIR/manifest.txt" ]; then
  printf 'restore: source manifest\n'
  sed 's/^/  /' "$BACKUP_DIR/manifest.txt"
fi

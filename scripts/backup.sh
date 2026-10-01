#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export PGUSER="${DB_USER:?DB_USER is not set, run via scripts/with-secrets.sh}"
export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is not set, run via scripts/with-secrets.sh}"
export PGDATABASE="${DB_NAME:?DB_NAME is not set, run via scripts/with-secrets.sh}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
FILE="$BACKUP_DIR/${PGDATABASE}_${STAMP}.dump"
REMOTE="/tmp/backup_${STAMP}_$$.dump"

pg() { docker compose exec -T -e PGHOST=postgres -e PGUSER -e PGPASSWORD -e PGDATABASE postgres "$@"; }
cleanup() { pg rm -f "$REMOTE" 2>/dev/null || true; rm -f "$FILE.part" "$FILE.control.part"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
{
  echo 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'
  echo 'SELECT pg_export_snapshot() AS snapshot \gset'
  echo '\setenv SNAPSHOT :snapshot'
  echo "\\! pg_dump -Fc --exclude-schema=pgbouncer --snapshot=\"\$SNAPSHOT\" -f $REMOTE"
  cat scripts/backup-control.sql
  echo 'COMMIT;'
} | pg psql -v ON_ERROR_STOP=1 -qAt > "$FILE.control.part"

pg pg_restore --list "$REMOTE" > /dev/null
pg cat "$REMOTE" > "$FILE.part"
mv "$FILE.part" "$FILE"
mv "$FILE.control.part" "$FILE.control"

find "$BACKUP_DIR" -maxdepth 1 -name "${PGDATABASE}_*.dump*" -mtime +"$RETENTION_DAYS" -delete

echo "backup of $PGDATABASE: $(wc -c < "$FILE" | tr -d ' ') bytes, $(grep -c '^rows|' "$FILE.control" || true) tables in control file" >&2
echo "$FILE"

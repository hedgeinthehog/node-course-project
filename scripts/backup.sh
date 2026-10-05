#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DB_HOST="${DB_HOST:?DB_HOST is not set, run via scripts/with-secrets.sh}"
DB_PORT="${DB_PORT:?DB_PORT is not set, run via scripts/with-secrets.sh}"
export PGUSER="${DB_USER:?DB_USER is not set, run via scripts/with-secrets.sh}"
export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is not set, run via scripts/with-secrets.sh}"
export PGDATABASE="${DB_NAME:?DB_NAME is not set, run via scripts/with-secrets.sh}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
FILE="$BACKUP_DIR/${PGDATABASE}_${STAMP}.dump"
REMOTE="/tmp/backup_${STAMP}_$$.dump"

IMAGE="$(docker compose config --images | grep -m1 '^postgres:')"
CLUSTER_ID_SQL='SELECT system_identifier FROM pg_control_system()'

pg() { docker compose exec -T -e PGHOST=postgres -e PGUSER -e PGPASSWORD -e PGDATABASE postgres "$@"; }
client() {
  local network="$1" host="$2"
  shift 2
  docker run --rm "$network" -e PGCONNECT_TIMEOUT=5 -e PGUSER -e PGPASSWORD -e PGDATABASE "$IMAGE" \
    psql -h "$host" -p "$DB_PORT" "$@"
}
endpoint_psql() {
  case "$DB_HOST" in
    127.* | localhost | ::1)
      client --network=host "$DB_HOST" "$@" 2> /dev/null ||
        client --add-host=host.docker.internal:host-gateway host.docker.internal "$@"
      ;;
    *) client --network=host "$DB_HOST" "$@" ;;
  esac
}
cleanup() { pg rm -f "$REMOTE" 2>/dev/null || true; rm -f "$FILE.part" "$FILE.control.part"; }
trap cleanup EXIT

ENDPOINT_CLUSTER="$(endpoint_psql -XAtc "$CLUSTER_ID_SQL")" || {
  echo "backup: cannot query $DB_HOST:$DB_PORT as $PGUSER, check the connection settings from the vault" >&2
  exit 1
}
DIRECT_CLUSTER="$(pg psql -XAtc "$CLUSTER_ID_SQL")"
[ "$ENDPOINT_CLUSTER" = "$DIRECT_CLUSTER" ] || {
  echo "backup: $DB_HOST:$DB_PORT leads to cluster $ENDPOINT_CLUSTER, but the compose service postgres is cluster $DIRECT_CLUSTER, refusing to dump" >&2
  exit 1
}

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

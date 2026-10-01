#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${DB_NAME:?DB_NAME is not set, run via scripts/with-secrets.sh}"
BACKUP_DIR="${BACKUP_DIR:-backups}"

FILE="$(ls -1 "$BACKUP_DIR"/"${DB_NAME}"_*.dump 2>/dev/null | sort | tail -1 || true)"
[ -n "$FILE" ] || { echo "restore-drill: no dumps in $BACKUP_DIR, run scripts/backup.sh first" >&2; exit 1; }
[ -f "$FILE.control" ] || { echo "restore-drill: $FILE.control is missing" >&2; exit 1; }

IMAGE="$(docker compose config --images | grep -m1 '^postgres:')"
CONTAINER="restore-drill-$(date +%s)-$$"
trap 'docker rm -fv "$CONTAINER" > /dev/null 2>&1 || true' EXIT

echo "dump:      $FILE ($(wc -c < "$FILE" | tr -d ' ') bytes)"
echo "target:    new container $CONTAINER ($IMAGE, empty volume)"

T0=$(date +%s)
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB="$DB_NAME" "$IMAGE" > /dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres -d "$DB_NAME" && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres -d "$DB_NAME"
T1=$(date +%s)

docker exec -i "$CONTAINER" pg_restore --no-owner --no-privileges --exit-on-error -U postgres -d "$DB_NAME" < "$FILE"
T2=$(date +%s)

RESTORED="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qAt -U postgres -d "$DB_NAME" < scripts/backup-control.sql)"
T3=$(date +%s)

echo "timing:    container ready $((T1 - T0)) s, pg_restore $((T2 - T1)) s, verification $((T3 - T2)) s, total $((T3 - T0)) s"
echo "expected (at backup time):"
sed 's/^/  /' "$FILE.control"
echo "restored:"
echo "$RESTORED" | sed 's/^/  /'

grep -qx 'tables|0' "$FILE.control" && echo "note:      the dump has no tables, the backup was taken before migrations were applied"

if [ "$RESTORED" = "$(cat "$FILE.control")" ]; then
  echo "MATCH"
else
  echo "MISMATCH" >&2
  exit 1
fi

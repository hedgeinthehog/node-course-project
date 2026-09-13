#!/usr/bin/env bash
set -euo pipefail

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

PASSWORD_FILE="${DB_PASSWORD_FILE:?DB_PASSWORD_FILE is not set}"
DB_NAME="${DB_URL:?DB_URL is not set}"
DB_NAME="${DB_NAME##*/}"

CURRENT_USER="$(cut -d: -f1 "$PASSWORD_FILE")"
case "$CURRENT_USER" in
  marketplace_a) NEXT_USER=marketplace_b ;;
  marketplace_b) NEXT_USER=marketplace_a ;;
  *) echo "unknown user '$CURRENT_USER' in $PASSWORD_FILE" >&2; exit 1 ;;
esac
NEW_PASSWORD="$(openssl rand -hex 16)"

psql_exec() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" -qAt -c "$1"
}

psql_exec "ALTER ROLE $NEXT_USER PASSWORD '$NEW_PASSWORD'"
printf '%s:%s' "$NEXT_USER" "$NEW_PASSWORD" > "$PASSWORD_FILE.tmp"
mv "$PASSWORD_FILE.tmp" "$PASSWORD_FILE"
TERMINATED="$(psql_exec "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = '$CURRENT_USER'")"

echo "Switched $CURRENT_USER -> $NEXT_USER with a new password, $PASSWORD_FILE updated, $TERMINATED old connection(s) terminated"

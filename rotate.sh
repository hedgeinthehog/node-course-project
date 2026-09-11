#!/usr/bin/env bash
set -euo pipefail

PASSWORD_FILE="${DB_PASSWORD_FILE:-secrets/db_password}"
DB_USER="${DB_USER:-marketplace}"
DB_NAME="${DB_NAME:-marketplace}"
NEW_PASSWORD="$(openssl rand -hex 16)"

psql_exec() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -qAt -c "$1"
}

psql_exec "ALTER ROLE \"$DB_USER\" PASSWORD '$NEW_PASSWORD'"
printf '%s' "$NEW_PASSWORD" > "$PASSWORD_FILE"
TERMINATED="$(psql_exec "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = '$DB_USER' AND pid <> pg_backend_pid()")"

echo "Password for role $DB_USER rotated, $PASSWORD_FILE updated, $TERMINATED old connection(s) terminated"

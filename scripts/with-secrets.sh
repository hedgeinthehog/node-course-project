#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"
if [ -f "$CREDS" ]; then
  set -a; . "$CREDS"; set +a
  exec infisical run --env="$ENV_SLUG" -- "$@"
fi

[ -f "$ROOT/.env" ] || { echo "with-secrets: no .env and no $CREDS" >&2; exit 1; }
set -a; . "$ROOT/.env"; set +a
SECRET_FILE="$ROOT/${DB_PASSWORD_FILE:?DB_PASSWORD_FILE is not set}"
[ -f "$SECRET_FILE" ] || { echo "with-secrets: $SECRET_FILE not found" >&2; exit 1; }

HOSTPORT="${DB_URL#*://}"; HOSTPORT="${HOSTPORT%%/*}"
case "$HOSTPORT" in *:*) DB_PORT="${HOSTPORT##*:}" ;; *) DB_PORT=5432 ;; esac
export DB_HOST="${HOSTPORT%%:*}" DB_PORT DB_NAME="${DB_URL##*/}"
export DB_USER="$(cut -d: -f1 "$SECRET_FILE")" DB_PASSWORD="$(cut -d: -f2- "$SECRET_FILE")"
exec "$@"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
case "$PULUMI_BACKEND_URL" in file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;; esac
: "${PULUMI_CONFIG_PASSPHRASE:?PULUMI_CONFIG_PASSPHRASE is not set, run via scripts/with-secrets.sh}"

cd "$ROOT/infra"
pulumi stack select --create "${PULUMI_STACK:-dev}" --non-interactive > /dev/null

case "${1:-}" in
  up) exec pulumi up --yes --skip-preview --non-interactive ;;
  destroy) exec pulumi destroy --yes --skip-preview --non-interactive ;;
  *) exec pulumi "$@" ;;
esac

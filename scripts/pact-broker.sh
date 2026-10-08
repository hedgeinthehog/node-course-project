#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BROKER="${PACT_BROKER_URL:?PACT_BROKER_URL is not set, run via scripts/with-secrets.sh}"
VERSION="${PACT_VERSION:-$(git rev-parse --short HEAD)}"
CONSUMER=marketplace-web
PROVIDER=marketplace-api

api() {
  if [ -n "${PACT_BROKER_TOKEN:-}" ]; then
    curl -sS -H "Authorization: Bearer $PACT_BROKER_TOKEN" "$@"
  else
    curl -sS "$@"
  fi
}

put() {
  local code
  code="$(api -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' "$@")"
  echo "$code"
  [ "$code" = 201 ] || [ "$code" = 200 ]
}

case "${1:-}" in
  publish)
    put --data @"pacts/$CONSUMER-$PROVIDER.json" \
      "$BROKER/pacts/provider/$PROVIDER/consumer/$CONSUMER/version/$VERSION"
    ;;
  tag-prod)
    put "$BROKER/pacticipants/$PROVIDER/versions/$VERSION/tags/prod"
    ;;
  can-i-deploy)
    RESULT="$(api "$BROKER/can-i-deploy?pacticipant=$CONSUMER&version=$VERSION&to=prod")"
    echo "$RESULT"
    echo "$RESULT" | grep -q '"deployable":true'
    ;;
  *)
    echo "usage: $0 publish | tag-prod | can-i-deploy" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BROKER="${PACT_BROKER_URL:?PACT_BROKER_URL is not set, run via scripts/with-secrets.sh}"
CONSUMER=marketplace-web
PROVIDER=marketplace-api

if [ -z "${PACT_VERSION:-}" ]; then
  PACT_VERSION="$(git rev-parse --short HEAD 2> /dev/null)" || {
    echo "pact-broker: PACT_VERSION is not set and there is no git checkout to derive it from" >&2
    exit 1
  }
fi

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

pacticipant() {
  case "${1:-}" in
    "$CONSUMER" | "$PROVIDER") echo "$1" ;;
    *) echo "usage: $0 $2 $CONSUMER|$PROVIDER" >&2; exit 2 ;;
  esac
}

case "${1:-}" in
  publish)
    put --data @"pacts/$CONSUMER-$PROVIDER.json" \
      "$BROKER/pacts/provider/$PROVIDER/consumer/$CONSUMER/version/$PACT_VERSION"
    ;;
  can-i-deploy)
    NAME="$(pacticipant "${2:-}" can-i-deploy)"
    RESULT="$(api "$BROKER/can-i-deploy?pacticipant=$NAME&version=$PACT_VERSION&to=prod")"
    echo "$RESULT"
    echo "$RESULT" | grep -q '"deployable":true'
    ;;
  record-deployment)
    NAME="$(pacticipant "${2:-}" record-deployment)"
    put "$BROKER/pacticipants/$NAME/versions/$PACT_VERSION/tags/prod"
    ;;
  *)
    echo "usage: $0 publish | can-i-deploy <pacticipant> | record-deployment <pacticipant>" >&2
    exit 2
    ;;
esac

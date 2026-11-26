#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
DIR="${EVIDENCE_DIR:?EVIDENCE_DIR is not set}"; mkdir -p "$DIR"
touch "$DIR/build.log"

from() { grep -E "^$2=" "$DIR/$1" 2> /dev/null | tail -1 | cut -d= -f2-; }
deployed=""; leaked=0
if [ -s "$DIR/deployment.json" ]; then
  deployed="$(jq -r '.spec.template.spec.containers[0].image | split("@")[1] // ""' "$DIR/deployment.json")"
  for name in DB_PASSWORD BROKER_URL JWT_PRIVATE_KEY REFRESH_TOKEN_PEPPER STORAGE_SECRET_KEY; do
    value="${!name:-}"
    [ -n "$value" ] && leaked=$((leaked + $(grep -oF -- "$value" "$DIR/deployment.json" | wc -l)))
  done
fi

{
  echo "run-id=${RUN_ID:-}"
  echo "head-sha=${HEAD_SHA:-}"
  echo "environment=${ENVIRONMENT:-}"
  echo "image-ref=${IMAGE_REF:-}"
  echo "built-digest=${BUILT_DIGEST:-}"
  echo "deployed-digest=$deployed"
  echo "build-invocations=$(wc -l < "$DIR/build.log" | tr -d ' ')"
  echo "creds-source=oidc"
  echo "oidc-iss=$(from oidc.txt iss)"
  echo "oidc-aud=$(from oidc.txt aud)"
  echo "oidc-sub=$(from oidc.txt sub)"
  echo "oidc-sig-verified=$(from oidc.txt sig-verified)"
  echo "oidc-policy-allow=$(from oidc.txt policy-allow)"
  echo "rollout-requests=$(from rollout.txt requests)"
  echo "rollout-ok=$(from rollout.txt ok)"
  echo "rollout-failed=$(from rollout.txt failed)"
  echo "rollout-seconds=$(from rollout.txt rollout-seconds)"
  echo "secret-in-manifest=$leaked"
  echo "gate-scan-exit=${GATE_SCAN_EXIT:-}"
} | tee "$DIR/evidence.txt"

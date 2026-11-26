#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:?usage: gate-contract.sh <git ref of the published contract>}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git show "$BASE:openapi/openapi.yaml" > "$WORK/base.yaml"
cp openapi/openapi.yaml "$WORK/revision.yaml"
chmod -R a+rX "$WORK"
docker run --rm -v "$WORK:/specs:ro" tufin/oasdiff:v1.11.7 \
  breaking /specs/base.yaml /specs/revision.yaml --fail-on ERR
echo "contract: no breaking change against $BASE"

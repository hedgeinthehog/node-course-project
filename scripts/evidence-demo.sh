#!/usr/bin/env bash
set -uo pipefail
. "$(dirname "$0")/aws-env.sh"
OUT="$AWS_ROOT/evidence"; mkdir -p "$OUT"
clean() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -v '^@ '; }

{
  bash "$AWS_ROOT/scripts/aws-stack.sh" demo preview --color never 2>&1 | clean
  echo
  echo "# pulumi preview --json: operation and full resource type of every step"
  bash "$AWS_ROOT/scripts/aws-stack.sh" demo preview --json 2> /dev/null \
    | jq -r '.steps[] | "\(.op) \(.newState.type // .oldState.type) \(.urn | split("::") | last)"'
} > "$OUT/preview-demo.txt"
echo "preview steps=$(grep -c '^create ' "$OUT/preview-demo.txt")"
bash "$AWS_ROOT/scripts/aws-stack.sh" demo up --color never 2>&1 | clean > "$OUT/501.txt"
echo "up exit=${PIPESTATUS[0]} (501 is expected on LocalStack Community)"
grep -c 'StatusCode: 501' "$OUT/501.txt"

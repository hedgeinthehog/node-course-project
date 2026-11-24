#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/aws-env.sh"

PROGRAM="${1:?usage: aws-stack.sh <base|demo> <pulumi arguments>}"; shift
cd "$AWS_ROOT/infra/$PROGRAM"

if [ ! -f "Pulumi.$HW31_STACK.yaml" ]; then
  grep -v '^encryptionsalt:' Pulumi.localstack.yaml > "Pulumi.$HW31_STACK.yaml"
fi
pulumi stack select --create "$HW31_STACK" > /dev/null

case "$1" in
  up) shift; exec pulumi up --yes --skip-preview "$@" ;;
  destroy) shift; exec pulumi destroy --yes --skip-preview "$@" ;;
  *) exec pulumi "$@" ;;
esac

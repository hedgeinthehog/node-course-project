#!/usr/bin/env bash
# Sourced by the hw-31 scripts. The backup lane talks to LocalStack: its credentials are the
# emulator's well-known constants, not secrets. Real secrets (the Pulumi passphrase, DB_PASSWORD)
# still come from the vault through scripts/with-secrets.sh.
AWS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://127.0.0.1:23166}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
export AWS_PAGER=""
export HW31_STACK="${HW31_STACK:-localstack}"
export HW31_REGIONS="${HW31_REGIONS:-$AWS_REGION us-east-1}"
export PULUMI_BACKEND_URL="${HW31_BACKEND_URL:-file://$AWS_ROOT/.pulumi-aws}"
export PULUMI_SKIP_UPDATE_CHECK=1
: "${PULUMI_CONFIG_PASSPHRASE:?PULUMI_CONFIG_PASSPHRASE is not set — it comes from the vault}"
mkdir -p "${PULUMI_BACKEND_URL#file://}"

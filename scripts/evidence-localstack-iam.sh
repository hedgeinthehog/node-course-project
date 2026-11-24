#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/aws-env.sh"
OUT="$AWS_ROOT/evidence"; mkdir -p "$OUT"
COMPOSE="docker compose -f $AWS_ROOT/infra/localstack.compose.yml"

RUN="$(date +%s)"
USER="hw31-denied-$RUN"; BUCKET="hw31-deny-all-$RUN"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

aws iam create-user --user-name "$USER" > /dev/null
aws iam put-user-policy --user-name "$USER" --policy-name deny-all \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}'
KEY="$(aws iam create-access-key --user-name "$USER" --output json)"
DENIED_ID="$(jq -r .AccessKey.AccessKeyId <<< "$KEY")"
DENIED_SECRET="$(jq -r .AccessKey.SecretAccessKey <<< "$KEY")"

as() { AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" aws "${@:3}" > /dev/null 2>&1 && echo 200 || echo denied; }
create="$(as "$DENIED_ID" "$DENIED_SECRET" s3api create-bucket --bucket "$BUCKET" \
  --create-bucket-configuration "LocationConstraint=$AWS_REGION")"
put="$(printf 'secret' | AWS_ACCESS_KEY_ID="$DENIED_ID" AWS_SECRET_ACCESS_KEY="$DENIED_SECRET" \
  aws s3 cp - "s3://$BUCKET/object.txt" > /dev/null 2>&1 && echo 200 || echo denied)"
fake="$(as TOTALLY_FAKE_KEY_12345 nothing s3api get-object --bucket "$BUCKET" --key object.txt /dev/null)"

sleep 1
LOG="$($COMPOSE logs --since "$SINCE" localstack 2>&1 || true)"
{
  echo "enforce-iam=$($COMPOSE exec -T localstack printenv ENFORCE_IAM)"
  echo "deny-all-create-bucket=$create"
  echo "deny-all=$put"
  echo "fake-key=$fake"
  echo "log-lines=$(grep -c . <<< "$LOG")"
  echo "iam-request-log-lines=$(grep -c 'AWS iam\.' <<< "$LOG" || true)"
  echo "enforce-iam-log-lines=$(grep -ciE 'denied|not authorized|forbidden|enforc' <<< "$LOG" || true)"
} | tee "$OUT/localstack-iam.txt"

aws s3 rb "s3://$BUCKET" --force > /dev/null
aws iam delete-access-key --user-name "$USER" --access-key-id "$DENIED_ID"
aws iam delete-user-policy --user-name "$USER" --policy-name deny-all
aws iam delete-user --user-name "$USER"

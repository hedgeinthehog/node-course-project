#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/aws-env.sh"
OUT="$AWS_ROOT/evidence"; mkdir -p "$OUT"

ROLE="$(bash "$AWS_ROOT/scripts/aws-stack.sh" base stack output ciRoleName)"
ARN="$(bash "$AWS_ROOT/scripts/aws-stack.sh" base stack output ciRoleArn)"
HAS="${SIM_ALLOWED_ACTION:-rds:DeleteDBInstance}"
HAS_NOT="${SIM_DENIED_ACTION:-iam:CreateUser}"

jq -n \
  --argjson role "$(aws iam get-role --role-name "$ROLE" --output json)" \
  --argjson policy "$(aws iam get-role-policy --role-name "$ROLE" --policy-name teardown-demo --output json)" \
  '{TrustPolicy: $role.Role.AssumeRolePolicyDocument, PermissionPolicy: $policy.PolicyDocument, Role: ($role.Role | del(.AssumeRolePolicyDocument))}' \
  > "$OUT/iam.json"

decision() {
  aws iam simulate-principal-policy --policy-source-arn "$ARN" --action-names "$1" \
    --resource-arns '*' --query 'EvaluationResults[0].EvalDecision' --output text
}
{
  echo "sim-allowed-action=$HAS"
  echo "sim-allowed=$(decision "$HAS")"
  echo "sim-denied-action=$HAS_NOT"
  echo "sim-denied=$(decision "$HAS_NOT")"
} | tee "$OUT/iam.txt"

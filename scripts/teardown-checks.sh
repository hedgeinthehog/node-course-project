#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/aws-env.sh"

# LocalStack Community has no RDS and no ELBv2 API at all: a 501 from the emulator means the service
# does not exist there, so nothing of that kind can be left. Any other failure stops the script.
count() {
  local out
  if out="$("$@" --output text 2>&1)"; then echo "$out"; return; fi
  if [[ "$AWS_ENDPOINT_URL" != "" && "$out" == *"has not yet been emulated by LocalStack"* ]] ||
     [[ "$AWS_ENDPOINT_URL" != "" && "$out" == *"LocalStack license"* ]]; then
    echo 0; return
  fi
  echo "$out" >&2; exit 1
}

state=0
for program in demo base; do
  left="$(bash "$AWS_ROOT/scripts/aws-stack.sh" "$program" stack export \
    | jq '[.deployment.resources[]?|select(.type|startswith("aws:"))]|length')"
  state=$((state + left))
done

tagged=0; rds=0; alb=0; nat=0; eip=0
for R in $HW31_REGIONS; do
  tagged=$((tagged + $(count aws resourcegroupstaggingapi get-resources --region "$R" \
    --tag-filters Key=Project,Values=nodejs-pro-hw31 --query 'length(ResourceTagMappingList)')))
  rds=$((rds + $(count aws rds describe-db-instances --region "$R" --query 'length(DBInstances)')))
  alb=$((alb + $(count aws elbv2 describe-load-balancers --region "$R" --query 'length(LoadBalancers)')))
  nat=$((nat + $(count aws ec2 describe-nat-gateways --region "$R" --filter Name=state,Values=available \
    --query 'length(NatGateways)')))
  eip=$((eip + $(count aws ec2 describe-addresses --region "$R" --query 'length(Addresses)')))
done

echo "regions-checked=$(wc -w <<< "$HW31_REGIONS" | tr -d ' ')"
echo "state-resources-left=$state"
echo "tagged-resources-left=$tagged"
echo "rds-left=$rds"
echo "alb-left=$alb"
echo "nat-left=$nat"
echo "eip-left=$eip"
[ $((state + tagged + rds + alb + nat + eip)) -eq 0 ]

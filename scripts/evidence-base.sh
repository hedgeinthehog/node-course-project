#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/aws-env.sh"
OUT="$AWS_ROOT/evidence"; mkdir -p "$OUT"
stack() { bash "$AWS_ROOT/scripts/aws-stack.sh" base "$@"; }

VPC="$(stack stack output vpcId)"
PUBLIC="$(stack stack output publicSubnetIds --json | jq -r '.[]')"
PRIVATE="$(stack stack output privateSubnetIds --json | jq -r '.[]')"
ALL="$(printf '%s\n%s\n' "$PUBLIC" "$PRIVATE")"

exists() { aws ec2 describe-subnets --subnet-ids $1 --query 'length(Subnets)' --output text; }
default_routes=0
for subnet in $PRIVATE; do
  count="$(aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$subnet" \
    --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`][])' --output text)"
  default_routes=$((default_routes + count))
done

{
  echo "vpc-id=$VPC"
  echo "public-subnets=$(exists "$PUBLIC")"
  echo "private-subnets=$(exists "$PRIVATE")"
  echo "subnet-azs=$(aws ec2 describe-subnets --subnet-ids $ALL --query 'Subnets[].AvailabilityZone' --output json | jq 'unique | length')"
  echo "private-default-route=$default_routes"
  echo "security-groups=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC" \
    --query 'length(SecurityGroups[?GroupName!=`default`])' --output text)"
  echo "tagged-resources=$(aws resourcegroupstaggingapi get-resources \
    --tag-filters Key=Project,Values=nodejs-pro-hw31 --query 'length(ResourceTagMappingList)' --output text)"
} | tee "$OUT/base.txt"
stack stack export > "$OUT/base-state.json"

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${KIND_CLUSTER:-marketplace}"
IMAGE="${IMAGE:-marketplace-api:local}"

docker image inspect "$IMAGE" > /dev/null 2>&1 || {
  echo "cluster-up: image $IMAGE not found, run npm run image:build first" >&2
  exit 1
}
if ! kind get clusters 2> /dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config k8s/kind-config.yaml --wait 120s
fi
kind load docker-image "$IMAGE" --name "$CLUSTER"
kubectl --context "kind-$CLUSTER" get nodes

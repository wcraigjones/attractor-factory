#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

NODE_MIN_SIZE="${NODE_MIN_SIZE:-2}"
NODE_DESIRED_SIZE="${NODE_DESIRED_SIZE:-2}"
NODE_MAX_SIZE="${NODE_MAX_SIZE:-6}"
KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.35}"

require_cmds aws jq kubectl
assert_account

NETWORK_TEMPLATE="$ROOT_DIR/deploy/cloudformation/network.yaml"
EKS_TEMPLATE="$ROOT_DIR/deploy/cloudformation/eks.yaml"
ECR_TEMPLATE="$ROOT_DIR/deploy/cloudformation/ecr.yaml"
CERT_TEMPLATE="$ROOT_DIR/deploy/cloudformation/certificate.yaml"

HOSTED_ZONE_ID="$(resolve_hosted_zone_id "$HOSTED_ZONE_NAME")"

echo "Deploying network stack: $NETWORK_STACK_NAME"
deploy_stack "$NETWORK_STACK_NAME" "$NETWORK_TEMPLATE" \
  --parameter-overrides \
    StackPrefix="$STACK_PREFIX" \
    ClusterName="$CLUSTER_NAME"

PRIVATE_SUBNET_IDS="$(get_stack_output "$NETWORK_STACK_NAME" PrivateSubnetIds)"

echo "Deploying ECR stack: $ECR_STACK_NAME"
deploy_stack "$ECR_STACK_NAME" "$ECR_TEMPLATE" \
  --parameter-overrides StackPrefix="$STACK_PREFIX"

echo "Deploying EKS stack: $EKS_STACK_NAME"
deploy_stack "$EKS_STACK_NAME" "$EKS_TEMPLATE" \
  --parameter-overrides \
    ClusterName="$CLUSTER_NAME" \
    KubernetesVersion="$KUBERNETES_VERSION" \
    PrivateSubnetIds="$PRIVATE_SUBNET_IDS" \
    NodeMinSize="$NODE_MIN_SIZE" \
    NodeDesiredSize="$NODE_DESIRED_SIZE" \
    NodeMaxSize="$NODE_MAX_SIZE"

echo "Deploying certificate stack: $CERT_STACK_NAME"
deploy_stack "$CERT_STACK_NAME" "$CERT_TEMPLATE" \
  --parameter-overrides \
    DomainName="$DOMAIN_NAME" \
    HostedZoneId="$HOSTED_ZONE_ID"

echo "Updating kubeconfig for cluster: $CLUSTER_NAME"
update_kubeconfig

echo "Infra deployment complete."
echo "Network stack: $NETWORK_STACK_NAME"
echo "ECR stack: $ECR_STACK_NAME"
echo "EKS stack: $EKS_STACK_NAME"
echo "Certificate stack: $CERT_STACK_NAME"
echo "Hosted zone id: $HOSTED_ZONE_ID"

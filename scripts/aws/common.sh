#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

export AWS_PAGER=""

AWS_PROFILE="${AWS_PROFILE:-ai-sandbox-administrator}"
AWS_REGION="${AWS_REGION:-us-west-2}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-582719176192}"
STACK_PREFIX="${STACK_PREFIX:-attractor-factory}"
CLUSTER_NAME="${CLUSTER_NAME:-${STACK_PREFIX}-eks}"
NAMESPACE="${NAMESPACE:-factory-system}"
DOMAIN_NAME="${DOMAIN_NAME:-factory.pelx.ai}"
HOSTED_ZONE_NAME="${HOSTED_ZONE_NAME:-pelx.ai}"

NETWORK_STACK_NAME="${NETWORK_STACK_NAME:-${STACK_PREFIX}-network}"
EKS_STACK_NAME="${EKS_STACK_NAME:-${STACK_PREFIX}-eks}"
ECR_STACK_NAME="${ECR_STACK_NAME:-${STACK_PREFIX}-ecr}"
CERT_STACK_NAME="${CERT_STACK_NAME:-${STACK_PREFIX}-cert}"
DNS_STACK_NAME="${DNS_STACK_NAME:-${STACK_PREFIX}-dns}"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

aws_cli() {
  aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: missing required command '$cmd'" >&2
    exit 1
  fi
}

require_cmds() {
  local cmd
  for cmd in "$@"; do
    require_cmd "$cmd"
  done
}

assert_account() {
  local account
  account="$(aws_cli sts get-caller-identity --query Account --output text)"
  if [[ "$account" != "$AWS_ACCOUNT_ID" ]]; then
    echo "error: expected AWS account $AWS_ACCOUNT_ID but authenticated account is $account" >&2
    echo "hint: run scripts/aws/login.sh with AWS_PROFILE=$AWS_PROFILE" >&2
    exit 1
  fi
}

resolve_hosted_zone_id() {
  local zone_name="${1:-$HOSTED_ZONE_NAME}"
  local zone_id
  zone_id="$(aws_cli route53 list-hosted-zones-by-name \
    --dns-name "${zone_name}." \
    --query "HostedZones[?Name == '${zone_name}.'] | [0].Id" \
    --output text)"

  if [[ -z "$zone_id" || "$zone_id" == "None" ]]; then
    echo "error: hosted zone '${zone_name}' not found in account ${AWS_ACCOUNT_ID}" >&2
    exit 1
  fi

  zone_id="${zone_id#/hostedzone/}"
  echo "$zone_id"
}

deploy_stack() {
  local stack_name="$1"
  local template_path="$2"
  shift 2

  aws_cli cloudformation deploy \
    --stack-name "$stack_name" \
    --template-file "$template_path" \
    --capabilities CAPABILITY_NAMED_IAM \
    "$@"
}

get_stack_output() {
  local stack_name="$1"
  local output_key="$2"
  aws_cli cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text
}

update_kubeconfig() {
  aws_cli eks update-kubeconfig --name "$CLUSTER_NAME" >/dev/null
}

wait_for_ingress_hostname() {
  local namespace="$1"
  local ingress_name="$2"
  local timeout_seconds="${3:-600}"
  local elapsed=0
  local hostname=""

  while (( elapsed < timeout_seconds )); do
    hostname="$(kubectl -n "$namespace" get ingress "$ingress_name" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
    if [[ -n "$hostname" ]]; then
      echo "$hostname"
      return 0
    fi
    sleep 10
    elapsed=$(( elapsed + 10 ))
  done

  echo "error: timed out waiting for ingress/$ingress_name hostname in namespace $namespace" >&2
  return 1
}

print_context() {
  cat <<EOF
AWS_PROFILE=$AWS_PROFILE
AWS_REGION=$AWS_REGION
AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID
STACK_PREFIX=$STACK_PREFIX
CLUSTER_NAME=$CLUSTER_NAME
NAMESPACE=$NAMESPACE
DOMAIN_NAME=$DOMAIN_NAME
HOSTED_ZONE_NAME=$HOSTED_ZONE_NAME
IMAGE_TAG=$IMAGE_TAG
NETWORK_STACK_NAME=$NETWORK_STACK_NAME
EKS_STACK_NAME=$EKS_STACK_NAME
ECR_STACK_NAME=$ECR_STACK_NAME
CERT_STACK_NAME=$CERT_STACK_NAME
DNS_STACK_NAME=$DNS_STACK_NAME
EOF
}

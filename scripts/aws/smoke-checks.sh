#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

require_cmds aws kubectl curl jq
assert_account
update_kubeconfig

echo "Checking CloudFormation stack statuses..."
for stack in "$NETWORK_STACK_NAME" "$EKS_STACK_NAME" "$ECR_STACK_NAME" "$CERT_STACK_NAME" "$DNS_STACK_NAME"; do
  status="$(aws_cli cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text)"
  echo "  $stack: $status"
  if [[ "$status" != *_COMPLETE ]]; then
    echo "error: stack $stack is not complete" >&2
    exit 1
  fi
done

echo "Checking workload readiness in namespace $NAMESPACE..."
kubectl -n "$NAMESPACE" get pods

echo "Checking ingress..."
kubectl -n "$NAMESPACE" get ingress factory-system

INGRESS_AUTH_TYPE="$(kubectl -n "$NAMESPACE" get ingress factory-system -o jsonpath='{.metadata.annotations.alb\.ingress\.kubernetes\.io/auth-type}' 2>/dev/null || true)"

if [[ "$INGRESS_AUTH_TYPE" == "oidc" ]]; then
  echo "Ingress auth enabled (OIDC). Verifying unauthenticated redirect to Google."
  REDIRECT_HEADERS="$(curl -sSI "https://${DOMAIN_NAME}/" || true)"
  echo "$REDIRECT_HEADERS" | head -n 1
  if ! echo "$REDIRECT_HEADERS" | grep -qiE '^location: https://accounts\.google\.com/'; then
    echo "error: expected redirect to Google sign-in when OIDC auth is enabled" >&2
    exit 1
  fi
else
  echo "Health check: https://${DOMAIN_NAME}/healthz"
  HEALTH_RESPONSE="$(curl -fsS "https://${DOMAIN_NAME}/healthz")"
  echo "Health response: $HEALTH_RESPONSE"

  echo "API check: https://${DOMAIN_NAME}/api/models/providers"
  API_STATUS="$(curl -fsS -o /tmp/factory-api-providers.json -w '%{http_code}' "https://${DOMAIN_NAME}/api/models/providers")"
  echo "API status: $API_STATUS"
  rm -f /tmp/factory-api-providers.json

  echo "Web root check: https://${DOMAIN_NAME}/"
  WEB_STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' "https://${DOMAIN_NAME}/")"
  echo "Web status: $WEB_STATUS"
fi

if [[ -n "${PROJECT_ID:-}" && -n "${ATTRACTOR_ID:-}" ]]; then
  echo "Queueing validation run for project ${PROJECT_ID}"
  curl -fsS -X POST "https://${DOMAIN_NAME}/api/runs" \
    -H 'Content-Type: application/json' \
    -d "{\"projectId\":\"${PROJECT_ID}\",\"attractorDefId\":\"${ATTRACTOR_ID}\",\"runType\":\"task\",\"sourceBranch\":\"main\",\"targetBranch\":\"main\"}" | jq .
else
  echo "Skipping run queue validation (set PROJECT_ID and ATTRACTOR_ID to enable)."
fi

echo "Smoke checks passed."

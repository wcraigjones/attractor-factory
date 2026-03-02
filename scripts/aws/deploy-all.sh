#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

echo "Deployment context:"
print_context

echo "Step 1/7: AWS SSO login"
"$SCRIPT_DIR/login.sh"

echo "Step 2/7: CloudFormation infrastructure"
"$SCRIPT_DIR/deploy-infra.sh"

echo "Step 3/7: AWS Load Balancer Controller"
"$SCRIPT_DIR/install-alb-controller.sh"

echo "Step 4/7: Build and push images"
"$SCRIPT_DIR/build-push.sh"

echo "Step 5/7: Helm application deploy"
"$SCRIPT_DIR/deploy-app.sh"

echo "Step 6/7: Route53 DNS publish"
"$SCRIPT_DIR/publish-dns.sh"

echo "Step 7/7: Smoke checks"
"$SCRIPT_DIR/smoke-checks.sh"

echo "Deployment complete: https://${DOMAIN_NAME}"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

require_cmds aws kubectl
assert_account
update_kubeconfig

HOSTED_ZONE_ID="$(resolve_hosted_zone_id "$HOSTED_ZONE_NAME")"
INGRESS_HOSTNAME="$(wait_for_ingress_hostname "$NAMESPACE" factory-system 900)"
INGRESS_HOSTNAME="${INGRESS_HOSTNAME%.}"

if [[ -z "$INGRESS_HOSTNAME" ]]; then
  echo "error: ingress hostname is empty" >&2
  exit 1
fi

LB_ZONE_ID="$(aws_cli elbv2 describe-load-balancers \
  --query "LoadBalancers[?DNSName=='${INGRESS_HOSTNAME}'].CanonicalHostedZoneId | [0]" \
  --output text)"

if [[ -z "$LB_ZONE_ID" || "$LB_ZONE_ID" == "None" ]]; then
  echo "error: could not resolve ALB canonical hosted zone id for DNS name $INGRESS_HOSTNAME" >&2
  exit 1
fi

echo "Publishing Route53 alias for ${DOMAIN_NAME} -> ${INGRESS_HOSTNAME}"
deploy_stack "$DNS_STACK_NAME" "$ROOT_DIR/deploy/cloudformation/dns-record.yaml" \
  --parameter-overrides \
    HostedZoneId="$HOSTED_ZONE_ID" \
    RecordName="$DOMAIN_NAME" \
    LoadBalancerDnsName="$INGRESS_HOSTNAME" \
    LoadBalancerHostedZoneId="$LB_ZONE_ID"

echo "DNS published: https://${DOMAIN_NAME}"

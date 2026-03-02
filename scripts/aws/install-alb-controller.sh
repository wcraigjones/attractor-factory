#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

ALB_CONTROLLER_NAMESPACE="${ALB_CONTROLLER_NAMESPACE:-kube-system}"
ALB_CONTROLLER_SERVICE_ACCOUNT="${ALB_CONTROLLER_SERVICE_ACCOUNT:-aws-load-balancer-controller}"
ALB_CONTROLLER_RELEASE_NAME="${ALB_CONTROLLER_RELEASE_NAME:-aws-load-balancer-controller}"
ALB_CONTROLLER_CHART_VERSION="${ALB_CONTROLLER_CHART_VERSION:-}"
ALB_CONTROLLER_IAM_POLICY_VERSION="${ALB_CONTROLLER_IAM_POLICY_VERSION:-v2.8.2}"
ALB_CONTROLLER_POLICY_NAME="${ALB_CONTROLLER_POLICY_NAME:-${STACK_PREFIX}-AWSLoadBalancerControllerIAMPolicy}"
ALB_CONTROLLER_ROLE_NAME="${ALB_CONTROLLER_ROLE_NAME:-${STACK_PREFIX}-aws-load-balancer-controller}"
ALB_CONTROLLER_EXTRA_POLICY_NAME="${ALB_CONTROLLER_EXTRA_POLICY_NAME:-${STACK_PREFIX}-aws-load-balancer-controller-extra}"
OIDC_THUMBPRINT="${OIDC_THUMBPRINT:-06b25927c42a721631c1efd9431e648fa62e1e39}"

require_cmds aws kubectl helm jq curl
assert_account
update_kubeconfig

VPC_ID="$(get_stack_output "$NETWORK_STACK_NAME" VpcId)"
OIDC_ISSUER_URL="$(aws_cli eks describe-cluster --name "$CLUSTER_NAME" --query 'cluster.identity.oidc.issuer' --output text)"
if [[ -z "$OIDC_ISSUER_URL" || "$OIDC_ISSUER_URL" == "None" ]]; then
  echo "error: OIDC issuer URL not found for cluster $CLUSTER_NAME" >&2
  exit 1
fi
OIDC_PROVIDER_PATH="${OIDC_ISSUER_URL#https://}"
OIDC_PROVIDER_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_PATH}"

if aws_cli iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" >/dev/null 2>&1; then
  echo "Using existing IAM OIDC provider: $OIDC_PROVIDER_ARN"
else
  echo "Creating IAM OIDC provider: $OIDC_PROVIDER_ARN"
  aws_cli iam create-open-id-connect-provider \
    --url "$OIDC_ISSUER_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "$OIDC_THUMBPRINT" >/dev/null
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

POLICY_ARN="$(aws_cli iam list-policies --scope Local --query "Policies[?PolicyName=='${ALB_CONTROLLER_POLICY_NAME}'].Arn | [0]" --output text)"
if [[ -z "$POLICY_ARN" || "$POLICY_ARN" == "None" ]]; then
  echo "Creating IAM policy $ALB_CONTROLLER_POLICY_NAME"
  curl -fsSL "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/${ALB_CONTROLLER_IAM_POLICY_VERSION}/docs/install/iam_policy.json" \
    -o "$TMP_DIR/iam-policy.json"
  POLICY_ARN="$(aws_cli iam create-policy \
    --policy-name "$ALB_CONTROLLER_POLICY_NAME" \
    --policy-document "file://$TMP_DIR/iam-policy.json" \
    --query 'Policy.Arn' \
    --output text)"
else
  echo "Using existing IAM policy $ALB_CONTROLLER_POLICY_NAME"
fi

cat > "$TMP_DIR/trust-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_PATH}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER_PATH}:aud": "sts.amazonaws.com",
          "${OIDC_PROVIDER_PATH}:sub": "system:serviceaccount:${ALB_CONTROLLER_NAMESPACE}:${ALB_CONTROLLER_SERVICE_ACCOUNT}"
        }
      }
    }
  ]
}
EOF

if aws_cli iam get-role --role-name "$ALB_CONTROLLER_ROLE_NAME" >/dev/null 2>&1; then
  echo "Updating assume-role policy for $ALB_CONTROLLER_ROLE_NAME"
  aws_cli iam update-assume-role-policy \
    --role-name "$ALB_CONTROLLER_ROLE_NAME" \
    --policy-document "file://$TMP_DIR/trust-policy.json"
else
  echo "Creating role $ALB_CONTROLLER_ROLE_NAME"
  aws_cli iam create-role \
    --role-name "$ALB_CONTROLLER_ROLE_NAME" \
    --assume-role-policy-document "file://$TMP_DIR/trust-policy.json" >/dev/null
fi

ROLE_ARN="$(aws_cli iam get-role --role-name "$ALB_CONTROLLER_ROLE_NAME" --query 'Role.Arn' --output text)"
ATTACHED="$(aws_cli iam list-attached-role-policies --role-name "$ALB_CONTROLLER_ROLE_NAME" --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'] | length(@)" --output text)"
if [[ "$ATTACHED" == "0" ]]; then
  aws_cli iam attach-role-policy --role-name "$ALB_CONTROLLER_ROLE_NAME" --policy-arn "$POLICY_ARN"
fi

cat > "$TMP_DIR/role-extra-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "elasticloadbalancing:DescribeListenerAttributes"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws_cli iam put-role-policy \
  --role-name "$ALB_CONTROLLER_ROLE_NAME" \
  --policy-name "$ALB_CONTROLLER_EXTRA_POLICY_NAME" \
  --policy-document "file://$TMP_DIR/role-extra-policy.json"

kubectl create namespace "$ALB_CONTROLLER_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${ALB_CONTROLLER_SERVICE_ACCOUNT}
  namespace: ${ALB_CONTROLLER_NAMESPACE}
  annotations:
    eks.amazonaws.com/role-arn: ${ROLE_ARN}
EOF

helm repo add eks https://aws.github.io/eks-charts >/dev/null 2>&1 || true
helm repo update eks >/dev/null

HELM_ARGS=(
  upgrade --install "$ALB_CONTROLLER_RELEASE_NAME" eks/aws-load-balancer-controller
  --namespace "$ALB_CONTROLLER_NAMESPACE"
  --set clusterName="$CLUSTER_NAME"
  --set serviceAccount.create=false
  --set serviceAccount.name="$ALB_CONTROLLER_SERVICE_ACCOUNT"
  --set region="$AWS_REGION"
  --set vpcId="$VPC_ID"
)

if [[ -n "$ALB_CONTROLLER_CHART_VERSION" ]]; then
  HELM_ARGS+=(--version "$ALB_CONTROLLER_CHART_VERSION")
fi

helm "${HELM_ARGS[@]}"

kubectl -n "$ALB_CONTROLLER_NAMESPACE" rollout status deployment/"$ALB_CONTROLLER_RELEASE_NAME" --timeout=300s

echo "AWS Load Balancer Controller installed successfully."

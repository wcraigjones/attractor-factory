#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

require_cmds aws kubectl helm jq
assert_account
update_kubeconfig

EBS_CSI_ROLE_NAME="${EBS_CSI_ROLE_NAME:-${STACK_PREFIX}-ebs-csi-controller}"
EBS_CSI_ADDON_NAME="${EBS_CSI_ADDON_NAME:-aws-ebs-csi-driver}"
OIDC_THUMBPRINT="${OIDC_THUMBPRINT:-06b25927c42a721631c1efd9431e648fa62e1e39}"
GOOGLE_OIDC_ENABLED="${GOOGLE_OIDC_ENABLED:-}"
GOOGLE_OIDC_CLIENT_ID="${GOOGLE_OIDC_CLIENT_ID:-}"
GOOGLE_OIDC_CLIENT_SECRET="${GOOGLE_OIDC_CLIENT_SECRET:-}"
GOOGLE_OIDC_SECRET_NAME="${GOOGLE_OIDC_SECRET_NAME:-google-oidc}"
GOOGLE_OIDC_SCOPE="${GOOGLE_OIDC_SCOPE:-openid email profile}"
GOOGLE_OIDC_SESSION_TIMEOUT="${GOOGLE_OIDC_SESSION_TIMEOUT:-3600}"
GOOGLE_OIDC_AUTHORIZATION_ENDPOINT="${GOOGLE_OIDC_AUTHORIZATION_ENDPOINT:-https://accounts.google.com/o/oauth2/v2/auth}"
GOOGLE_OIDC_TOKEN_ENDPOINT="${GOOGLE_OIDC_TOKEN_ENDPOINT:-https://oauth2.googleapis.com/token}"
GOOGLE_OIDC_USER_INFO_ENDPOINT="${GOOGLE_OIDC_USER_INFO_ENDPOINT:-https://openidconnect.googleapis.com/v1/userinfo}"
GOOGLE_OIDC_ISSUER="${GOOGLE_OIDC_ISSUER:-https://accounts.google.com}"
GOOGLE_OIDC_AUTH_VALUES=""
RUNNER_IMAGE_DIGEST="${RUNNER_IMAGE_DIGEST:-}"

ensure_ebs_csi_driver() {
  local oidc_issuer_url oidc_provider_path oidc_provider_arn role_arn tmp_dir attached addon_status elapsed

  oidc_issuer_url="$(aws_cli eks describe-cluster --name "$CLUSTER_NAME" --query 'cluster.identity.oidc.issuer' --output text)"
  if [[ -z "$oidc_issuer_url" || "$oidc_issuer_url" == "None" ]]; then
    echo "error: OIDC issuer URL not found for cluster $CLUSTER_NAME" >&2
    exit 1
  fi

  oidc_provider_path="${oidc_issuer_url#https://}"
  oidc_provider_arn="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${oidc_provider_path}"
  role_arn="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${EBS_CSI_ROLE_NAME}"

  if ! aws_cli iam get-open-id-connect-provider --open-id-connect-provider-arn "$oidc_provider_arn" >/dev/null 2>&1; then
    aws_cli iam create-open-id-connect-provider \
      --url "$oidc_issuer_url" \
      --client-id-list sts.amazonaws.com \
      --thumbprint-list "$OIDC_THUMBPRINT" >/dev/null
  fi

  tmp_dir="$(mktemp -d)"
  cat > "$tmp_dir/ebs-csi-trust-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${oidc_provider_arn}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${oidc_provider_path}:aud": "sts.amazonaws.com",
          "${oidc_provider_path}:sub": "system:serviceaccount:kube-system:ebs-csi-controller-sa"
        }
      }
    }
  ]
}
EOF

  if aws_cli iam get-role --role-name "$EBS_CSI_ROLE_NAME" >/dev/null 2>&1; then
    aws_cli iam update-assume-role-policy \
      --role-name "$EBS_CSI_ROLE_NAME" \
      --policy-document "file://$tmp_dir/ebs-csi-trust-policy.json" >/dev/null
  else
    aws_cli iam create-role \
      --role-name "$EBS_CSI_ROLE_NAME" \
      --assume-role-policy-document "file://$tmp_dir/ebs-csi-trust-policy.json" >/dev/null
  fi

  attached="$(aws_cli iam list-attached-role-policies --role-name "$EBS_CSI_ROLE_NAME" \
    --query "AttachedPolicies[?PolicyArn=='arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy'] | length(@)" \
    --output text)"
  if [[ "$attached" == "0" ]]; then
    aws_cli iam attach-role-policy \
      --role-name "$EBS_CSI_ROLE_NAME" \
      --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  fi

  if aws_cli eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$EBS_CSI_ADDON_NAME" >/dev/null 2>&1; then
    aws_cli eks update-addon \
      --cluster-name "$CLUSTER_NAME" \
      --addon-name "$EBS_CSI_ADDON_NAME" \
      --service-account-role-arn "$role_arn" \
      --resolve-conflicts OVERWRITE >/dev/null
  else
    aws_cli eks create-addon \
      --cluster-name "$CLUSTER_NAME" \
      --addon-name "$EBS_CSI_ADDON_NAME" \
      --service-account-role-arn "$role_arn" >/dev/null
  fi

  elapsed=0
  while (( elapsed < 600 )); do
    addon_status="$(aws_cli eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$EBS_CSI_ADDON_NAME" --query 'addon.status' --output text)"
    if [[ "$addon_status" == "ACTIVE" ]]; then
      rm -rf "$tmp_dir"
      return 0
    fi
    sleep 10
    elapsed=$(( elapsed + 10 ))
  done

  echo "error: timed out waiting for addon ${EBS_CSI_ADDON_NAME} to become ACTIVE" >&2
  aws_cli eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$EBS_CSI_ADDON_NAME" \
    --query 'addon.health.issues' --output json >&2 || true
  rm -rf "$tmp_dir"
  exit 1
}

ensure_metrics_server() {
  helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
  helm repo update metrics-server >/dev/null
  helm upgrade --install metrics-server metrics-server/metrics-server \
    --namespace kube-system \
    --set 'args[0]=--kubelet-insecure-tls' >/dev/null
  kubectl -n kube-system rollout status deployment/metrics-server --timeout=300s >/dev/null
}

ensure_gp3_storage_class() {
  if kubectl get storageclass gp3 >/dev/null 2>&1; then
    return 0
  fi

  cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: gp3
  fsType: ext4
EOF
}

configure_google_oidc_auth() {
  local enabled idp_json

  enabled="false"
  if [[ "$GOOGLE_OIDC_ENABLED" == "true" ]]; then
    enabled="true"
  fi
  if [[ -n "$GOOGLE_OIDC_CLIENT_ID" && -n "$GOOGLE_OIDC_CLIENT_SECRET" ]]; then
    enabled="true"
  fi

  if [[ "$enabled" != "true" ]]; then
    return 0
  fi

  if [[ -z "$GOOGLE_OIDC_CLIENT_ID" || -z "$GOOGLE_OIDC_CLIENT_SECRET" ]]; then
    echo "error: GOOGLE_OIDC_CLIENT_ID and GOOGLE_OIDC_CLIENT_SECRET are required when Google OIDC auth is enabled" >&2
    exit 1
  fi

  kubectl -n "$NAMESPACE" create secret generic "$GOOGLE_OIDC_SECRET_NAME" \
    --from-literal=clientID="$GOOGLE_OIDC_CLIENT_ID" \
    --from-literal=clientSecret="$GOOGLE_OIDC_CLIENT_SECRET" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  cat <<EOF | kubectl -n "$NAMESPACE" apply -f - >/dev/null
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: aws-load-balancer-controller-oidc-secret-reader
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["${GOOGLE_OIDC_SECRET_NAME}"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: aws-load-balancer-controller-oidc-secret-reader
subjects:
  - kind: ServiceAccount
    name: aws-load-balancer-controller
    namespace: kube-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: aws-load-balancer-controller-oidc-secret-reader
EOF

  idp_json="$(jq -nc \
    --arg issuer "$GOOGLE_OIDC_ISSUER" \
    --arg authorizationEndpoint "$GOOGLE_OIDC_AUTHORIZATION_ENDPOINT" \
    --arg tokenEndpoint "$GOOGLE_OIDC_TOKEN_ENDPOINT" \
    --arg userInfoEndpoint "$GOOGLE_OIDC_USER_INFO_ENDPOINT" \
    --arg secretName "$GOOGLE_OIDC_SECRET_NAME" \
    '{issuer:$issuer,authorizationEndpoint:$authorizationEndpoint,tokenEndpoint:$tokenEndpoint,userInfoEndpoint:$userInfoEndpoint,secretName:$secretName}')"

  GOOGLE_OIDC_AUTH_VALUES="$(cat <<EOF
    alb.ingress.kubernetes.io/auth-type: oidc
    alb.ingress.kubernetes.io/auth-on-unauthenticated-request: authenticate
    alb.ingress.kubernetes.io/auth-scope: ${GOOGLE_OIDC_SCOPE}
    alb.ingress.kubernetes.io/auth-session-timeout: "${GOOGLE_OIDC_SESSION_TIMEOUT}"
    alb.ingress.kubernetes.io/auth-idp-oidc: '${idp_json}'
EOF
)"
}

API_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" ApiRepositoryUri)"
WEB_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" WebRepositoryUri)"
CONTROLLER_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" ControllerRepositoryUri)"
RUNNER_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" RunnerRepositoryUri)"
CERT_ARN="$(get_stack_output "$CERT_STACK_NAME" CertificateArn)"

if [[ -z "$API_REPO_URI" || "$API_REPO_URI" == "None" || -z "$WEB_REPO_URI" || "$WEB_REPO_URI" == "None" || -z "$CONTROLLER_REPO_URI" || "$CONTROLLER_REPO_URI" == "None" || -z "$RUNNER_REPO_URI" || "$RUNNER_REPO_URI" == "None" ]]; then
  echo "error: one or more ECR repository outputs are missing from stack $ECR_STACK_NAME" >&2
  exit 1
fi

if [[ -z "$CERT_ARN" || "$CERT_ARN" == "None" ]]; then
  echo "error: certificate ARN not found in stack $CERT_STACK_NAME" >&2
  exit 1
fi

ensure_ebs_csi_driver
ensure_metrics_server
ensure_gp3_storage_class
configure_google_oidc_auth

if [[ -n "$RUNNER_IMAGE_DIGEST" && ! "$RUNNER_IMAGE_DIGEST" =~ ^sha256:[A-Fa-f0-9]{64}$ ]]; then
  echo "error: RUNNER_IMAGE_DIGEST must match sha256:<64 hex chars>" >&2
  exit 1
fi

TMP_VALUES="$(mktemp)"
trap 'rm -f "$TMP_VALUES"' EXIT

runner_image_values="$(cat <<EOF
  runner:
    repository: ${RUNNER_REPO_URI}
    tag: ${IMAGE_TAG}
EOF
)"
if [[ -n "$RUNNER_IMAGE_DIGEST" ]]; then
  runner_image_values="$(cat <<EOF
${runner_image_values}
    digest: ${RUNNER_IMAGE_DIGEST}
EOF
)"
fi

cat > "$TMP_VALUES" <<EOF
images:
  api:
    repository: ${API_REPO_URI}
    tag: ${IMAGE_TAG}
  web:
    repository: ${WEB_REPO_URI}
    tag: ${IMAGE_TAG}
  controller:
    repository: ${CONTROLLER_REPO_URI}
    tag: ${IMAGE_TAG}
${runner_image_values}
ingress:
  host: ${DOMAIN_NAME}
  annotations:
    alb.ingress.kubernetes.io/certificate-arn: ${CERT_ARN}
EOF

if [[ -n "$GOOGLE_OIDC_AUTH_VALUES" ]]; then
  cat >> "$TMP_VALUES" <<EOF
${GOOGLE_OIDC_AUTH_VALUES}
EOF
fi

helm upgrade --install factory-system "$ROOT_DIR/deploy/helm/factory-system" \
  --reset-values \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$ROOT_DIR/deploy/helm/factory-system/values.aws-eks.yaml" \
  -f "$TMP_VALUES"

kubectl -n "$NAMESPACE" rollout status deployment/factory-api --timeout=600s
kubectl -n "$NAMESPACE" rollout status deployment/factory-web --timeout=600s
kubectl -n "$NAMESPACE" rollout status deployment/factory-runner-controller --timeout=600s
kubectl -n "$NAMESPACE" rollout status statefulset/postgres --timeout=600s
kubectl -n "$NAMESPACE" rollout status statefulset/redis --timeout=600s
kubectl -n "$NAMESPACE" rollout status statefulset/minio --timeout=600s

echo "Helm release deployed."
echo "Namespace: $NAMESPACE"
echo "Domain: $DOMAIN_NAME"
echo "Image tag: $IMAGE_TAG"
if [[ -n "$RUNNER_IMAGE_DIGEST" ]]; then
  echo "Runner image digest: $RUNNER_IMAGE_DIGEST"
fi

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

require_cmds aws docker
assert_account

API_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" ApiRepositoryUri)"
WEB_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" WebRepositoryUri)"
CONTROLLER_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" ControllerRepositoryUri)"
RUNNER_REPO_URI="$(get_stack_output "$ECR_STACK_NAME" RunnerRepositoryUri)"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

if [[ -z "$API_REPO_URI" || "$API_REPO_URI" == "None" ]]; then
  echo "error: unable to resolve ECR outputs from stack $ECR_STACK_NAME" >&2
  exit 1
fi

ECR_REGISTRY="${API_REPO_URI%%/*}"

echo "Logging in to ECR registry $ECR_REGISTRY"
aws_cli ecr get-login-password | docker login --username AWS --password-stdin "$ECR_REGISTRY"

if ! docker buildx inspect >/dev/null 2>&1; then
  docker buildx create --use >/dev/null
fi
docker buildx inspect --bootstrap >/dev/null

echo "Building and pushing monorepo image for tag $IMAGE_TAG on platform $DOCKER_PLATFORM"
docker buildx build \
  --platform "$DOCKER_PLATFORM" \
  -t "${API_REPO_URI}:${IMAGE_TAG}" \
  -t "${WEB_REPO_URI}:${IMAGE_TAG}" \
  -t "${CONTROLLER_REPO_URI}:${IMAGE_TAG}" \
  -t "${RUNNER_REPO_URI}:${IMAGE_TAG}" \
  --push \
  "$ROOT_DIR"

echo "Image push complete."
echo "api=${API_REPO_URI}:${IMAGE_TAG}"
echo "web=${WEB_REPO_URI}:${IMAGE_TAG}"
echo "controller=${CONTROLLER_REPO_URI}:${IMAGE_TAG}"
echo "runner=${RUNNER_REPO_URI}:${IMAGE_TAG}"

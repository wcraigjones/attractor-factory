#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${ATTRACTOR_DEV_IMAGE:-attractor-dev:local}"
NETWORK="${ATTRACTOR_DOCKER_NETWORK:-attractor-dev}"
POSTGRES_CONTAINER="${ATTRACTOR_POSTGRES_CONTAINER:-attractor-postgres}"
REDIS_CONTAINER="${ATTRACTOR_REDIS_CONTAINER:-attractor-redis}"
MINIO_CONTAINER="${ATTRACTOR_MINIO_CONTAINER:-attractor-minio}"

docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -f "$ROOT_DIR/Dockerfile.dev" -t "$IMAGE" "$ROOT_DIR"
fi

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

docker run --rm -it --init \
  --network "$NETWORK" \
  -p 8080:8080 \
  -p 5173:5173 \
  -e DATABASE_URL="postgresql://postgres:postgres@${POSTGRES_CONTAINER}:5432/factory" \
  -e REDIS_URL="redis://${REDIS_CONTAINER}:6379" \
  -e MINIO_ENDPOINT="http://${MINIO_CONTAINER}:9000" \
  -e MINIO_BUCKET=factory-artifacts \
  -e MINIO_ACCESS_KEY=minioadmin \
  -e MINIO_SECRET_KEY=minioadmin \
  -e PORT=8080 \
  -e K8S_ENABLED=false \
  -e FACTORY_API_BASE_URL=http://localhost:8080 \
  -v "$ROOT_DIR":/workspace \
  -v attractor_node_modules:/workspace/node_modules \
  -v attractor_npm_cache:/home/node/.npm \
  -v attractor_playwright_cache:/ms-playwright \
  "$IMAGE" "$@"

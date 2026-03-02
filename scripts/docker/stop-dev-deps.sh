#!/usr/bin/env bash
set -euo pipefail

NETWORK="${ATTRACTOR_DOCKER_NETWORK:-attractor-dev}"
POSTGRES_CONTAINER="${ATTRACTOR_POSTGRES_CONTAINER:-attractor-postgres}"
REDIS_CONTAINER="${ATTRACTOR_REDIS_CONTAINER:-attractor-redis}"
MINIO_CONTAINER="${ATTRACTOR_MINIO_CONTAINER:-attractor-minio}"
REMOVE_NETWORK="${REMOVE_NETWORK:-0}"

docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true

if [[ "$REMOVE_NETWORK" == "1" ]]; then
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
fi

echo "Dependency containers stopped."

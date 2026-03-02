#!/usr/bin/env bash
set -euo pipefail

NETWORK="${ATTRACTOR_DOCKER_NETWORK:-attractor-dev}"
POSTGRES_CONTAINER="${ATTRACTOR_POSTGRES_CONTAINER:-attractor-postgres}"
REDIS_CONTAINER="${ATTRACTOR_REDIS_CONTAINER:-attractor-redis}"
MINIO_CONTAINER="${ATTRACTOR_MINIO_CONTAINER:-attractor-minio}"

postgres_running() {
  docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null | grep -q true
}

redis_running() {
  docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER" 2>/dev/null | grep -q true
}

minio_running() {
  docker inspect -f '{{.State.Running}}' "$MINIO_CONTAINER" 2>/dev/null | grep -q true
}

docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

if ! postgres_running; then
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$POSTGRES_CONTAINER" \
    --network "$NETWORK" \
    -p 5432:5432 \
    -e POSTGRES_DB=factory \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    postgres:16 >/dev/null
fi

if ! redis_running; then
  docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$REDIS_CONTAINER" \
    --network "$NETWORK" \
    -p 6379:6379 \
    redis:7 >/dev/null
fi

if ! minio_running; then
  docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$MINIO_CONTAINER" \
    --network "$NETWORK" \
    -p 9000:9000 \
    -p 9001:9001 \
    -e MINIO_ROOT_USER=minioadmin \
    -e MINIO_ROOT_PASSWORD=minioadmin \
    minio/minio:RELEASE.2025-07-23T15-54-02Z \
    server /data --console-address :9001 >/dev/null
fi

until docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres -d factory >/dev/null 2>&1; do sleep 1; done
until docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; do sleep 1; done

docker run --rm \
  --network "$NETWORK" \
  minio/mc:RELEASE.2025-06-13T11-33-47Z \
  /bin/sh -c '
    set -e
    until /usr/bin/mc alias set local http://'"$MINIO_CONTAINER"':9000 minioadmin minioadmin; do sleep 1; done
    /usr/bin/mc mb -p local/factory-artifacts || true
  ' >/dev/null

cat <<EOF
Dependency containers are ready.
Network: $NETWORK
Postgres: $POSTGRES_CONTAINER (postgresql://postgres:postgres@$POSTGRES_CONTAINER:5432/factory)
Redis: $REDIS_CONTAINER (redis://$REDIS_CONTAINER:6379)
MinIO: $MINIO_CONTAINER (http://$MINIO_CONTAINER:9000)
EOF

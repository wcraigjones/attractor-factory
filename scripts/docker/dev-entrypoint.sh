#!/usr/bin/env bash
set -euo pipefail

cd /workspace

if [[ "${SKIP_CONTAINER_BOOTSTRAP:-0}" != "1" ]] && [[ -f package-lock.json ]]; then
  wanted_lock_hash="$(sha256sum package-lock.json | awk '{print $1}')"
  actual_lock_hash=""
  hash_marker="node_modules/.package-lock.hash"

  if [[ -f "$hash_marker" ]]; then
    actual_lock_hash="$(cat "$hash_marker")"
  fi

  if [[ ! -d node_modules || "$wanted_lock_hash" != "$actual_lock_hash" ]]; then
    echo "Installing npm dependencies (lockfile changed or node_modules missing)..."
    npm ci
    npm run prisma:generate
    mkdir -p node_modules
    printf '%s' "$wanted_lock_hash" > "$hash_marker"
  fi
fi

exec "$@"

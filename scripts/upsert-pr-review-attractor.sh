#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
ATTRACTOR_NAME="${ATTRACTOR_NAME:-pr-review-attractor}"
ATTRACTOR_PATH="${ATTRACTOR_PATH:-factory/pr-review-attractor.dot}"
DEFAULT_RUN_TYPE="${DEFAULT_RUN_TYPE:-task}"
ACTIVE="${ACTIVE:-true}"
DESCRIPTION="${DESCRIPTION:-Pull request review attractor with review council -> review summary flow.}"
ATTRACTOR_CONTENT="${ATTRACTOR_CONTENT:-}"

if [[ -z "$ATTRACTOR_CONTENT" ]]; then
  if [[ ! -f "$ATTRACTOR_PATH" ]]; then
    echo "Attractor file not found: $ATTRACTOR_PATH" >&2
    exit 1
  fi
  ATTRACTOR_CONTENT="$(cat "$ATTRACTOR_PATH")"
fi

payload=$(
  ATTRACTOR_NAME="$ATTRACTOR_NAME" \
  ATTRACTOR_PATH="$ATTRACTOR_PATH" \
  ATTRACTOR_CONTENT="$ATTRACTOR_CONTENT" \
  DEFAULT_RUN_TYPE="$DEFAULT_RUN_TYPE" \
  DESCRIPTION="$DESCRIPTION" \
  ACTIVE="$ACTIVE" \
  node -e '
    const payload = {
      name: process.env.ATTRACTOR_NAME,
      repoPath: process.env.ATTRACTOR_PATH,
      content: process.env.ATTRACTOR_CONTENT,
      defaultRunType: process.env.DEFAULT_RUN_TYPE,
      description: process.env.DESCRIPTION,
      active: process.env.ACTIVE === "true"
    };
    process.stdout.write(JSON.stringify(payload));
  '
)

response=$(curl -sS -X POST "$API_BASE_URL/api/attractors/global" \
  -H 'content-type: application/json' \
  -d "$payload")

echo "$response"

#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
ATTRACTOR_NAME="${ATTRACTOR_NAME:-build-attractor}"
ATTRACTOR_PATH="${ATTRACTOR_PATH:-factory/build-attractor.dot}"
DEFAULT_RUN_TYPE="${DEFAULT_RUN_TYPE:-implementation}"
ACTIVE="${ACTIVE:-true}"
DESCRIPTION="${DESCRIPTION:-Simple 3-phase build attractor: plan -> build -> review.}"
MODEL_PROVIDER="${MODEL_PROVIDER:-openrouter}"
MODEL_ID="${MODEL_ID:-openai/gpt-5.3-codex}"
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
  MODEL_PROVIDER="$MODEL_PROVIDER" \
  MODEL_ID="$MODEL_ID" \
  node -e '
    const payload = {
      name: process.env.ATTRACTOR_NAME,
      repoPath: process.env.ATTRACTOR_PATH,
      content: process.env.ATTRACTOR_CONTENT,
      defaultRunType: process.env.DEFAULT_RUN_TYPE,
      modelConfig: {
        provider: process.env.MODEL_PROVIDER,
        modelId: process.env.MODEL_ID
      },
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

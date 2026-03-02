#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/aws/common.sh
source "$SCRIPT_DIR/common.sh"

require_cmds aws

echo "Starting AWS SSO login for profile '$AWS_PROFILE'..."
aws sso login --profile "$AWS_PROFILE"

assert_account

echo "Authenticated profile/account:"
aws_cli sts get-caller-identity

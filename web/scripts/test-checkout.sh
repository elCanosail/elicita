#!/usr/bin/env bash
# scripts/test-checkout.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
APP_URL="${APP_URL:-http://localhost:4321}"
USER_ID="${USER_ID:-user_test}"
echo "Test checkout Stripe: $APP_URL"
DATA='{"userId":"'"$USER_ID"'"}'
RESPONSE=$(curl -s -X POST "$APP_URL/api/test/checkout-flow" -H "Content-Type: application/json" -d "$DATA")
echo "$RESPONSE" | python3 -m json.tool

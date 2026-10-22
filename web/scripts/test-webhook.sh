#!/usr/bin/env bash
# scripts/test-webhook.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
APP_URL="${APP_URL:-http://localhost:4321}"
WEBHOOK_URL="$APP_URL/api/stripe/webhook"
USER_ID="${USER_ID:-user_test}"
echo "Test webhook Stripe: $WEBHOOK_URL"
PAYLOAD='{"id":"evt_test_'"$(date +%s)"'","object":"event","type":"checkout.session.completed","data":{"object":{"id":"cs_test_'"$(date +%s)"'","object":"checkout.session","client_reference_id":"'"$USER_ID"'","customer":"cus_test_'"$(date +%s)"'","subscription":"sub_test_'"$(date +%s)"'","metadata":{"clerk_user_id":"'"$USER_ID"'","plan":"pro","interval":"month"}}}}'
curl -s -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d "$PAYLOAD" -w "\nHTTP %{http_code}\n"

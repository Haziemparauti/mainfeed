#!/usr/bin/env bash
# test_image_gen.sh — fire one /image request at the current pod and download
# the resulting JPEG locally for visual QA.
#
# Reuses the spin script's persisted pod URL + secret. Assumes the test
# selfie has been pre-staged at the URL hard-coded in test_image_payload.json
# (or pass --payload to override).
#
# Usage:
#   bash pod/scripts/test_image_gen.sh
#   bash pod/scripts/test_image_gen.sh --payload /path/to/custom.json
set -euo pipefail

STOCK_DIR="/c/Users/cex/Desktop/mainfeed-stock"
POD_URL=$(< "$STOCK_DIR/runpod_pod_url.txt")
POD_SECRET=$(< "$STOCK_DIR/swap_pod_secret.txt")
PAYLOAD="${STOCK_DIR}/test_image_payload.json"

while [ "${1:-}" != "" ]; do
  case "$1" in
    --payload) shift; PAYLOAD="$1"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "▶ POD_URL  = $POD_URL"
echo "▶ PAYLOAD  = $PAYLOAD"
echo ""

# Health check first — the server may be still loading weights.
echo "▶ /health:"
H=$(curl -s -H "Authorization: Bearer $POD_SECRET" "$POD_URL/health")
echo "$H" | python -m json.tool
ML=$(echo "$H" | python -c "import json,sys; print(json.load(sys.stdin).get('model_loaded'))")
if [ "$ML" != "True" ]; then
  echo "  ⏳ model not loaded yet — wait + retry"
  exit 1
fi

# Pull the request_id out of the payload for the download step.
REQ_ID=$(python -c "import json; print(json.load(open('$PAYLOAD'))['request_id'])")
echo ""
echo "▶ POST /image (request_id=$REQ_ID)"
RESP=$(curl -s -X POST "$POD_URL/image" \
  -H "Authorization: Bearer $POD_SECRET" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD")
echo "$RESP" | python -m json.tool

# Poll /metrics until in_flight == 0
echo ""
echo "▶ Polling /metrics for completion..."
for _ in $(seq 1 60); do
  M=$(curl -s -H "Authorization: Bearer $POD_SECRET" "$POD_URL/metrics")
  INF=$(echo "$M" | python -c "import json,sys; print(json.load(sys.stdin).get('in_flight'))")
  COMP=$(echo "$M" | python -c "import json,sys; print(json.load(sys.stdin).get('completed'))")
  FAIL=$(echo "$M" | python -c "import json,sys; print(json.load(sys.stdin).get('failed'))")
  printf "  in_flight=%s completed=%s failed=%s\n" "$INF" "$COMP" "$FAIL"
  if [ "$INF" = "0" ] && ( [ "$COMP" -gt 0 ] || [ "$FAIL" -gt 0 ] ); then
    break
  fi
  sleep 5
done

# Download output from R2 via wrangler
OUT_LOCAL="$STOCK_DIR/${REQ_ID}.jpg"
echo ""
echo "▶ Downloading r2://mainfeed-content/generated/${REQ_ID}.jpg → $OUT_LOCAL"
cd "$(dirname "${BASH_SOURCE[0]}")/../../worker"
npx --yes wrangler r2 object get "mainfeed-content/generated/${REQ_ID}.jpg" \
  --remote --file "$OUT_LOCAL" 2>&1 | tail -3

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Output: $OUT_LOCAL"
echo "  Size:   $(stat -c %s "$OUT_LOCAL" 2>/dev/null || stat -f %z "$OUT_LOCAL") bytes"
echo "═══════════════════════════════════════════════════════════════════════"

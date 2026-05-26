#!/usr/bin/env bash
# Deploys the latest pod code + burn-in deps onto a running RunPod instance.
# Run from your local machine in the mainfeed/ project root.
#
# Usage:
#   POD_IP=103.196.86.108 POD_PORT=10800 bash pod/deploy_to_pod.sh
#
# What it does:
#   1. scp swap_server.py + render_overlay.py to /root/ on the pod
#   2. ssh in and:
#      a) pip install Pillow (one-time)
#      b) wget Anton.ttf into /app/assets/ (one-time)
#      c) kill the existing swap_server.py process
#      d) restart it in the background, logs to /root/swap.log
#   3. tail the log so you can watch it boot

set -e

: "${POD_IP:?Set POD_IP to your RunPod IP (e.g. 103.196.86.108)}"
: "${POD_PORT:?Set POD_PORT to your RunPod SSH port (e.g. 10800)}"

echo "→ copying pod source + brand assets to root@${POD_IP}:${POD_PORT}…"
scp -P "$POD_PORT" \
    pod/swap_server.py \
    pod/render_overlay.py \
    root@"$POD_IP":/root/

ssh -p "$POD_PORT" root@"$POD_IP" 'mkdir -p /app/assets'
scp -P "$POD_PORT" \
    pod/assets/Anton.ttf \
    pod/assets/Inter-Medium.ttf \
    pod/assets/logo-square2.svg \
    root@"$POD_IP":/app/assets/

echo "→ installing deps + restarting swap_server.py…"
ssh -p "$POD_PORT" root@"$POD_IP" bash -s <<'REMOTE'
set -e

# Pillow + cairosvg for the overlay PNG; idempotent.
pip install --quiet --no-cache-dir Pillow cairosvg

# libcairo2 for cairosvg's runtime; idempotent.
if ! dpkg -s libcairo2 >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq libcairo2 && rm -rf /var/lib/apt/lists/*
fi

# Restart the server. The existing process holds the GPU lock so any in-flight
# swap will fail — wait until /health shows in_flight=0 before running this.
if pgrep -f swap_server.py > /dev/null; then
  echo "  stopping current swap_server.py…"
  pkill -f swap_server.py || true
  sleep 2
fi

echo "  starting fresh swap_server.py (log → /root/swap.log)…"
cd /root
nohup python /root/swap_server.py > /root/swap.log 2>&1 &
sleep 3
REMOTE

echo ""
echo "→ tailing /root/swap.log for 20s (Ctrl-C to exit, server keeps running)…"
ssh -p "$POD_PORT" root@"$POD_IP" 'tail -n 80 -f /root/swap.log' &
TAIL_PID=$!
sleep 20
kill "$TAIL_PID" 2>/dev/null || true

echo ""
echo "✓ deploy complete. test with: curl https://<your-runpod-proxy>/health"

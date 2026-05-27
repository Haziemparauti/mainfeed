#!/usr/bin/env bash
# spin_new_pod.sh — one-shot bootstrap for a fresh Mainfeed swap pod.
#
# Why this exists: doing this by hand the first time on 2026-05-26 took ~30 min
# (15 min lost to community-cloud SSH key drama, 5 min to GPU availability
# fallback). This script removes those failure modes and keeps the rest
# under ~8 minutes from `bash` to a worker that can queue swaps.
#
# Usage:
#   bash pod/scripts/spin_new_pod.sh                            # default A40 SECURE
#   bash pod/scripts/spin_new_pod.sh "NVIDIA RTX A6000"         # GPU override (SECURE)
#   CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh       # community mode (cheaper, image-only)
#   CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh "NVIDIA GeForce RTX 4090"
#
# Cloud type semantics:
#   SECURE      — proven dev flow. SSH-based: live SCP of pod source + env writing.
#                 PUBLIC_KEY install is reliable.
#   COMMUNITY   — cheaper ($0.16-0.34/hr vs $0.44-0.69/hr) but spot-style.
#                 PUBLIC_KEY isn't honored on community hosts, so we skip SSH
#                 entirely and pass all secrets (SWAP_POD_SECRET + R2 creds)
#                 in the deploy env array. The image must be current —
#                 in-flight pod/ edits won't be reflected until CI rebuilds.
#                 Requires GHCR image visibility = PUBLIC.
#
# What it does (in order):
#   1. RunPod GraphQL deploy on $CLOUD_TYPE cloud. All required env (PUBLIC_KEY
#      + SWAP_POD_SECRET + R2 creds) is sent in the mutation. Walks a fallback
#      ladder if the first GPU type is unavailable.
#   2. Polls RunPod for the public SSH endpoint (still appears on community,
#      even though sshd inside won't accept our key).
#   3-6. SECURE only: SSH handshake, apt/pip bootstrap (skip if pre-baked
#      image), SCP pod source, write /root/pod_env.sh, start swap_server.py.
#      COMMUNITY: skipped — swap_server starts itself via Dockerfile CMD
#      using env from Step 1.
#   7. Polls /health until model_loaded=true (~30s with R2 mirror, ~3 min cold).
#   8. Pushes the new pod's HTTP proxy URL to the worker's SWAP_POD_URL secret
#      via `wrangler secret put`. Worker can immediately reach the pod.
#   9. Persists pod_id + SSH endpoint + proxy URL under mainfeed-stock/.
#
# Result: `curl https://api.mainfeed.app/api/admin/swap/queue ...` works.

set -euo pipefail

# ===== config =====

# Repo root resolved from script location (works regardless of cwd)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"

# All persisted secrets + keys live here (gitignored, never in repo)
STOCK_DIR="/c/Users/cex/Desktop/mainfeed-stock"
SSH_KEY="$STOCK_DIR/runpod_ssh/id_ed25519"
RUNPOD_API_KEY=$(< "$STOCK_DIR/runpod_key.txt")
POD_SECRET=$(< "$STOCK_DIR/swap_pod_secret.txt")

# R2 creds (optional since 2026-05-27 security refactor) — only needed if you
# want the pod to pull weights from the R2 mirror at boot (fast: ~30s vs
# HuggingFace's ~6 min). Output uploads now go through the worker proxy at
# WORKER_UPLOAD_URL, so the pod no longer needs R2 write access. If you DO
# inject R2 creds, scope them READ-ONLY to the models/ prefix only — never
# give the pod broader access.
# Plain `grep` avoids the Git-Bash + Windows-Python /c/... path-mangling issue.
R2_ACCESS_KEY_ID=$(grep '^ACCESS_KEY_ID=' "$STOCK_DIR/r2_creds.txt" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n' || echo "")
R2_SECRET_ACCESS_KEY=$(grep '^SECRET_ACCESS_KEY=' "$STOCK_DIR/r2_creds.txt" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n' || echo "")

# Cloud type selector. SECURE is the dev-mode flow (SSH bootstrap + SCP source
# for live iteration). COMMUNITY is image-only: no SSH (PUBLIC_KEY env isn't
# honored on community hosts), so the image must already contain whatever code
# the pod will run, and runtime secrets are passed via the deploy env array.
#
# Invoke COMMUNITY mode:  CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh
# Verified working 2026-05-27 evening on 3090 community ($0.22/hr) after the
# GHCR package was flipped to PUBLIC — image pull + container start + model
# load completed in ~3 min with no SSH needed.
CLOUD_TYPE="${CLOUD_TYPE:-SECURE}"

# Pinned DreamID-V commit — the only SHA validated end-to-end (2026-05-25)
DREAMIDV_SHA=9b589940577559c91481fb3a13bae000a55f97a1

# The public key that matches $STOCK_DIR/runpod_ssh/id_ed25519 — runpod plumbs
# this into the container's /root/.ssh/authorized_keys at startup (SECURE only;
# community hosts don't reliably run this entrypoint logic).
PUBLIC_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILLA2lhnTAxCvp2g6pLC5uWAui1+pEJUXZdW57r3lebu mainfeed-ghost-test"

# GPU fallback ladders, split by cloud type. Cheapest viable first.
#   SECURE (reliable, ~50% pricier):
#     A40    48GB $0.44/hr  ← proven 2026-05-26 ($2.64 for 6h)
#     3090   24GB $0.46/hr  ← Ampere consumer, also fine
#     A6000  48GB $0.49/hr  ← previous prod baseline
#     4090   24GB $0.69/hr  ← fastest but pricey
#   COMMUNITY (spot-style — 3090 has been the most reliably deployable today;
#   4090/A6000 frequently return "out of resources" on the matched host):
#     3090   24GB $0.22/hr  ← cheapest 24GB that fits DreamID-V
#     4090   24GB $0.34/hr  ← production target, supply variable
#     A6000  48GB $0.33/hr  ← supply variable
#     A5000  24GB $0.16/hr  ← cheapest but often sold out
if [ "$CLOUD_TYPE" = "COMMUNITY" ]; then
  GPU_FALLBACK=(
    "${1:-NVIDIA GeForce RTX 3090}"
    "NVIDIA GeForce RTX 4090"
    "NVIDIA RTX A6000"
    "NVIDIA RTX A5000"
  )
else
  GPU_FALLBACK=(
    "${1:-NVIDIA A40}"
    "NVIDIA GeForce RTX 3090"
    "NVIDIA RTX A6000"
    "NVIDIA GeForce RTX 4090"
  )
fi

# Default to our pre-baked image (built by .github/workflows/build-pod.yml):
#   - DreamID-V cloned + checkout at pinned SHA
#   - All pip deps incl. flash_attn + onnxruntime-gpu
#   - Anton + Inter-Medium fonts in /app/assets
#   - Brand SVG in /app/assets
#   - swap_server.py + render_overlay.py + precompute_pose.py in /root
# Cold pod boot drops from ~6 min → ~1-2 min (just image pull + weights download).
# Override to fall back to bare pytorch base if the image is unavailable:
#   MAINFEED_POD_IMAGE=runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04 \
#     bash pod/scripts/spin_new_pod.sh
POD_IMAGE="${MAINFEED_POD_IMAGE:-ghcr.io/haziemparauti/mainfeed-swap:latest}"

# ===== helpers =====

graphql() {
  curl -s -X POST https://api.runpod.io/graphql \
    -H "Authorization: Bearer $RUNPOD_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$1"
}

# ===== Step 1: deploy =====

echo "▶ Deploying pod ($CLOUD_TYPE cloud, fallback ladder)..."

# env array baked into the deploy mutation. Since the 2026-05-27 security
# refactor the pod no longer needs R2 credentials by default — output
# uploads go through the worker proxy. We only inject SWAP_POD_SECRET
# (mandatory; pod auths to worker with this) and PUBLIC_KEY (SECURE only;
# community doesn't honor it but harmless to send).
POD_ID=""
for GPU_TYPE in "${GPU_FALLBACK[@]}"; do
  printf "  trying %-30s ... " "$GPU_TYPE"
  RESP=$(graphql "$(cat <<EOF
{"query":"mutation { podFindAndDeployOnDemand(input: { cloudType: $CLOUD_TYPE, gpuCount: 1, volumeInGb: 0, containerDiskInGb: 60, gpuTypeId: \"$GPU_TYPE\", name: \"mainfeed-swap-$(date +%Y%m%d-%H%M)\", imageName: \"$POD_IMAGE\", ports: \"22/tcp,8000/http\", startSsh: true, env: [{key: \"PUBLIC_KEY\", value: \"$PUBLIC_KEY\"}, {key: \"SWAP_POD_SECRET\", value: \"$POD_SECRET\"}] }) { id imageName desiredStatus } }"}
EOF
)")
  POD_ID=$(echo "$RESP" | python -c "import json,sys; d=json.load(sys.stdin); p=(d.get('data',{}) or {}).get('podFindAndDeployOnDemand') or {}; print(p.get('id') or '')")
  if [ -n "$POD_ID" ]; then
    echo "✓ $POD_ID"
    break
  else
    ERR=$(echo "$RESP" | python -c "import json,sys; d=json.load(sys.stdin); print((d.get('errors') or [{}])[0].get('message','')[:80])")
    echo "✗ $ERR"
  fi
done

if [ -z "$POD_ID" ]; then
  echo "ERROR: every GPU type in the fallback ladder is unavailable." >&2
  echo "       Wait a few minutes and try again, or extend the ladder in this script." >&2
  exit 1
fi
echo "$POD_ID" > "$STOCK_DIR/runpod_pod_id.txt"

# ===== Step 2: wait for runtime ports =====

echo "▶ Waiting for runtime ports..."
SSH_INFO=""
for _ in $(seq 1 60); do
  RESP=$(graphql "{\"query\":\"query { pod(input: {podId: \\\"$POD_ID\\\"}) { runtime { ports { ip isIpPublic privatePort publicPort type } } } }\"}")
  SSH_INFO=$(echo "$RESP" | python -c "
import json, sys
d = json.load(sys.stdin)
rt = (d.get('data',{}) or {}).get('pod') or {}
rt = rt.get('runtime') or {}
for p in rt.get('ports') or []:
    if p.get('type')=='tcp' and p.get('isIpPublic') and p.get('privatePort')==22:
        print(f\"{p['ip']} {p['publicPort']}\")
        break
")
  if [ -n "$SSH_INFO" ]; then break; fi
  sleep 5
done
[ -z "$SSH_INFO" ] && { echo "ERROR: pod never exposed tcp/22"; exit 1; }

POD_IP=$(echo "$SSH_INFO" | cut -d' ' -f1)
POD_PORT=$(echo "$SSH_INFO" | cut -d' ' -f2)
echo "  ✓ SSH: $POD_IP:$POD_PORT"
echo "$POD_IP:$POD_PORT" > "$STOCK_DIR/runpod_pod_ssh.txt"

# ===== Steps 3-6: SSH-based bootstrap (SECURE only) =====
# On COMMUNITY pods the PUBLIC_KEY install isn't honored, so we can't SSH.
# Instead the deploy mutation already passed all required env (SWAP_POD_SECRET,
# R2 creds) and the Dockerfile CMD auto-starts /root/swap_server.py with those
# env vars at container start. The image must therefore be CURRENT — any local
# pod/ edits not yet in the latest CI-built image won't be reflected.
if [ "$CLOUD_TYPE" != "COMMUNITY" ]; then

# ===== Step 3: wait for sshd to actually answer =====

echo "▶ Waiting for sshd handshake..."
for _ in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6 -o BatchMode=yes \
       -i "$SSH_KEY" -p "$POD_PORT" root@"$POD_IP" 'true' 2>/dev/null; then
    echo "  ✓ ssh OK"
    break
  fi
  sleep 5
done

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $SSH_KEY"

# ===== Step 4: apt + pip + clone =====

echo "▶ Bootstrap (skip if image is pre-baked, else full install)..."
ssh $SSH_OPTS -p "$POD_PORT" root@"$POD_IP" \
  DREAMIDV_SHA="$DREAMIDV_SHA" bash -s <<'REMOTE'
set -e

# Fast-path: if the image is our pre-baked ghcr.io/haziemparauti/mainfeed-swap
# image (or any image with flash_attn already installed + DreamID-V cloned),
# skip the ~5-minute bootstrap entirely. Detected by checking the two slowest
# things to install — if both are there, everything else upstream of them
# already ran during image build.
if python -c "import flash_attn" >/dev/null 2>&1 && [ -f /root/dreamidv/generate_dreamidv_faster.py ]; then
  echo "  ✓ image is pre-provisioned (skipping apt/pip/clone)"
  exit 0
fi

echo "  → bare image — running full install (~5 min)"

# apt — ffmpeg for video, libcairo2 for cairosvg, rest are CLI essentials
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ffmpeg libcudnn9-cuda-12 libcairo2 unzip wget git curl >/dev/null

# DreamID-V at pinned SHA (idempotent)
if [ ! -d /root/dreamidv ]; then
  git clone https://github.com/Haziemparauti/DreamID-V.git /root/dreamidv >/dev/null 2>&1
fi
cd /root/dreamidv
git fetch --quiet
git checkout --quiet "$DREAMIDV_SHA"

# Patch upstream quirks (carry-forward from prior install runs)
sed -i 's|mediapipe==0.10.5#numpy|mediapipe==0.10.5  # numpy|' requirements.txt
sed -i '/^flash_attn/d' requirements.txt

# pip — DreamID-V requirements first
pip install --quiet --no-cache-dir -r requirements.txt
pip install --quiet --no-cache-dir decord

# Replace stock CPU-only onnxruntime with GPU variant. The CPU one runs DWPose
# at ~5-8s per frame on A6000; GPU brings it under 1s. Single biggest swap-speed
# lever on the install side.
pip uninstall -y -q onnxruntime 2>/dev/null || true
pip install --quiet --no-cache-dir onnxruntime-gpu

# REST server + burn-in deps
pip install --quiet --no-cache-dir fastapi 'uvicorn[standard]' httpx boto3 Pillow cairosvg

# flash_attn LAST + --no-build-isolation. Order matters; if it picks the wrong
# torch during build the pod will OOM at swap time.
pip install --quiet --no-cache-dir packaging ninja
pip install --quiet --no-cache-dir flash_attn --no-build-isolation
REMOTE

# ===== Step 5: scp pod files =====

echo "▶ Uploading pod source + assets..."
ssh $SSH_OPTS -p "$POD_PORT" root@"$POD_IP" 'mkdir -p /app/assets /workspace/ckpts /workspace/tmp'
scp $SSH_OPTS -P "$POD_PORT" \
  "$REPO_ROOT/pod/swap_server.py" \
  "$REPO_ROOT/pod/dreamidv_runtime.py" \
  "$REPO_ROOT/pod/flux_pulid_runtime.py" \
  "$REPO_ROOT/pod/render_overlay.py" \
  "$REPO_ROOT/pod/precompute_pose.py" \
  root@"$POD_IP":/root/
scp $SSH_OPTS -P "$POD_PORT" \
  "$REPO_ROOT/pod/assets/Anton.ttf" \
  "$REPO_ROOT/pod/assets/Inter-Medium.ttf" \
  "$REPO_ROOT/pod/assets/logo-square2.svg" \
  root@"$POD_IP":/app/assets/

# ===== Step 6: write env + start swap_server =====

echo "▶ Writing env file + starting swap_server.py..."
# R2 creds already loaded at top of script (also needed for the COMMUNITY
# deploy-env path). No need to re-read here.

ssh $SSH_OPTS -p "$POD_PORT" root@"$POD_IP" \
  POD_SECRET="$POD_SECRET" \
  DREAMIDV_ENABLED="${DREAMIDV_ENABLED:-}" \
  FLUX_PULID_ENABLED="${FLUX_PULID_ENABLED:-}" \
  bash -s <<'REMOTE'
set -e
# Minimal env file — most defaults are baked into the Dockerfile ENV (see
# pod/Dockerfile). Only secrets + dev-mode overrides go here.
# R2 credentials are NOT written: since 2026-05-27 the pod uploads outputs
# via the worker proxy (env.CONTENT binding on the worker side). The pod
# never holds R2 creds, so even SECURE-host env can't leak them.
cat > /root/pod_env.sh <<ENV
SWAP_POD_SECRET=$POD_SECRET
DEBUG_KEEP_WORKDIR=1
${DREAMIDV_ENABLED:+DREAMIDV_ENABLED=$DREAMIDV_ENABLED}
${FLUX_PULID_ENABLED:+FLUX_PULID_ENABLED=$FLUX_PULID_ENABLED}
ENV
chmod 600 /root/pod_env.sh

# Restart cleanly
PIDS=$(pgrep -f "^python /root/swap_server.py" || true)
if [ -n "$PIDS" ]; then kill -9 $PIDS; sleep 2; fi
cd /root
set -a; . /root/pod_env.sh; set +a
nohup python /root/swap_server.py > /root/swap.log 2>&1 < /dev/null &
disown
sleep 2
echo "  PID: $(pgrep -f swap_server.py | head -1)"
REMOTE

else  # CLOUD_TYPE == COMMUNITY
  echo "▶ COMMUNITY mode: skipping SSH bootstrap (image runs swap_server.py via CMD; secrets injected via deploy env)"
fi  # end SECURE-only block

# ===== Step 7: poll /health =====

POD_URL="https://${POD_ID}-8000.proxy.runpod.net"
echo "$POD_URL" > "$STOCK_DIR/runpod_pod_url.txt"

echo "▶ Polling /health (model loads from R2 mirror in ~30s)..."
for _ in $(seq 1 60); do
  H=$(curl -s -H "Authorization: Bearer $POD_SECRET" "$POD_URL/health" 2>/dev/null || echo '{}')
  if echo "$H" | grep -q '"model_loaded":true'; then
    echo "  ✓ $H"
    break
  fi
  sleep 5
done

# ===== Step 8: update worker SWAP_POD_URL =====

echo "▶ Pushing SWAP_POD_URL to worker secrets..."
(cd "$WORKER_DIR" && echo "$POD_URL" | npx --yes wrangler secret put SWAP_POD_URL 2>&1 | tail -3)

# ===== final summary =====

GPU_NAME=$(graphql "{\"query\":\"query { pod(input: {podId: \\\"$POD_ID\\\"}) { machine { gpuTypeId } } }\"}" \
  | python -c "import json,sys; print((json.load(sys.stdin).get('data',{}).get('pod') or {}).get('machine',{}).get('gpuTypeId',''))")

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  ✓ POD READY"
echo "    POD_ID  $POD_ID"
echo "    GPU     $GPU_NAME"
echo "    SSH     ssh -i $SSH_KEY -p $POD_PORT root@$POD_IP"
echo "    PROXY   $POD_URL"
echo ""
echo "  Test:"
echo "    curl -H \"Authorization: Bearer \$(cat $STOCK_DIR/swap_pod_secret.txt)\" $POD_URL/health"
echo "═══════════════════════════════════════════════════════════════════════"

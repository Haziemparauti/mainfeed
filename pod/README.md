# Mainfeed swap pod

Self-hosted DreamID-V faster head+hair swap. Runs on a single RTX 4090 RunPod
instance, serves a REST `/swap` endpoint to the Cloudflare Worker.

## Architecture

```
                    +-----------------------+
                    |  Cloudflare Worker    |
                    |  api.mainfeed.app     |
                    +----------+------------+
                               | POST /swap (with SWAP_POD_SECRET)
                               v
                    +-----------------------+
                    |  swap_server.py       |
                    |  on RunPod RTX 4090   |
                    |  :8000                |
                    +----------+------------+
                               | POST callback_url (with SWAP_POD_SECRET)
                               v
                    +-----------------------+
                    |  Worker /api/swap/    |
                    |  complete             |
                    +-----------------------+
```

Always-warm pod is **deferred** until launch. Until then:
- `ocg8daon2bxzio` (RTX 4090 SECURE, $0.69/hr) is the dev pod where DreamID-V
  was validated 2026-05-25 evening.
- The Worker reads `SWAP_POD_URL` from Wrangler secrets. When the dev pod is up,
  point it at `https://ocg8daon2bxzio-8000.proxy.runpod.net`. When the pod is
  down, swap requests fail clearly — that's expected during dev.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Reproducible build of the swap pod image. |
| `swap_server.py` | FastAPI REST server. Loads DreamID-V once, serves `/swap`. |
| `precompute_pose.py` | Per-stock-clip DWPose preprocessing. Run once during library prep. |
| `scripts/mirror_weights_to_r2.sh` | One-time R2 mirror of HuggingFace weights. |

## Quick start (dev — iterate against the existing pod via SSH)

The fastest feedback loop while iterating on `swap_server.py` is to SSH into the
already-set-up dev pod and run the server in the foreground. Skips Docker entirely
during dev.

```bash
# Copy server code to the pod (one-time):
scp -P 10800 swap_server.py precompute_pose.py root@103.196.86.108:/root/

# SSH in:
ssh -p 10800 root@103.196.86.108

# Inside the pod, install lightweight server deps (one-time):
pip install fastapi 'uvicorn[standard]' httpx

# Set the secret + start the server (foreground; logs to stdout):
export SWAP_POD_SECRET="$(openssl rand -hex 32)"
export WEIGHTS_DIR=/workspace/ckpts   # weights are already there from validation run
python /root/swap_server.py
```

Expose port 8000 via RunPod's proxy → `https://ocg8daon2bxzio-8000.proxy.runpod.net`.
Store both that URL and the secret in the Worker:

```bash
echo "https://ocg8daon2bxzio-8000.proxy.runpod.net" | npx wrangler secret put SWAP_POD_URL
echo "$SWAP_POD_SECRET"                              | npx wrangler secret put SWAP_POD_SECRET
```

## Docker build + push (production target)

```bash
docker build -t ghcr.io/haziemparauti/mainfeed-swap:dev pod/
docker push ghcr.io/haziemparauti/mainfeed-swap:dev
```

When ready to deploy a pod from the image (still on-demand, not always-warm yet):

```bash
# RunPod GraphQL mutation — adapt deploy_dreamidv.json with imageName field:
#   imageName: "ghcr.io/haziemparauti/mainfeed-swap:dev"
# Container disk: 40 GB minimum.
# Env: SWAP_POD_SECRET=<...>
# Expose: 8000/tcp
```

First container start downloads ~14 GB of weights from HuggingFace → caches to
`/workspace/ckpts`. ~3 min cold, instant on subsequent starts with persistent
volume.

## Phase 1B — supply-chain hardening (R2 mirror)

When the dev loop stabilizes and we want production builds that don't depend on
HuggingFace being up:

```bash
bash pod/scripts/mirror_weights_to_r2.sh    # 14 GB upload to mainfeed-content/models/
```

Then rebuild image with R2-backed weights:

```bash
docker build \\
  --build-arg HARDEN_WEIGHTS_R2=1 \\
  --build-arg R2_PUBLIC_PREFIX=https://mainfeed-content.r2.cloudflarestorage.com/models \\
  -t ghcr.io/haziemparauti/mainfeed-swap:v1 pod/
```

## REST contract

### `POST /swap`

```jsonc
// request
{
  "request_id":         "uuid-or-piece-id",
  "source_image_url":   "https://api.mainfeed.app/api/selfie/<userid>/primary.jpg",
  "target_video_url":   "https://api.mainfeed.app/public/stock/cop_s07_coffee_plaza_f.mp4",
  "target_pose_url":    null,           // optional; pod computes if missing
  "target_mask_url":    null,           // optional; pod computes if missing
  "callback_url":       "https://api.mainfeed.app/api/swap/complete",
  "output_upload_url":  "https://...r2-signed-put-url.../piece.mp4",  // optional
  "sample_steps":       16,
  "sample_guide_scale_img": 4.0,
  "size":               "832x480"
}

// 202 response (job queued, will callback when done)
{
  "request_id": "...",
  "status":     "processing",
  "in_flight":  1
}
```

### `POST <callback_url>` (pod → worker)

```jsonc
// success
{
  "request_id":     "...",
  "status":         "completed",
  "elapsed_sec":    78.4,
  "output_uploaded": true
}

// failure
{
  "request_id": "...",
  "status":     "failed",
  "error":      "<short message>"
}
```

### `GET /health`

```jsonc
{
  "ok":            true,
  "model_loaded":  true,
  "in_flight":     0,
  "completed":     17,
  "failed":        2,
  "uptime_sec":    3142.55
}
```

## Performance targets

| Stage | Time on RTX 4090 | Notes |
|---|---|---|
| Container cold start (no cached weights) | ~3 min | One-time per pod |
| Container start (cached weights) | ~30 sec | Model load to GPU |
| First swap after model load | ~80 sec | 16 sample_steps, 832×480 |
| Subsequent swaps | ~30 sec | warm model + cached DWPose |
| DWPose precompute per stock clip | ~5–10 min | Done once during library prep |

Production optimization roadmap (post-MVP, in `mainfeed_v5_production_lockdown_checklist`):
torch.compile → fp16 → TensorRT → ulysses parallel → ~15-25 sec per swap.

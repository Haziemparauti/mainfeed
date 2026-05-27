# Mainfeed swap pod

Self-hosted dual-pipeline media generation. Runs on a single RunPod GPU
instance (target: RTX A6000 48 GB community), serves two REST endpoints to
the Cloudflare Worker:

- **`/swap`** — DreamID-V faster head+hair swap (videos + GIFs, output mp4)
- **`/image`** — Flux.1-schnell + PuLID-FLUX identity-preserving image
  generation (cosplay images, output jpg)

**The pod holds exactly one secret: `SWAP_POD_SECRET`.** No R2 credentials,
no HF tokens (in production), no Cloudflare account keys. All R2 access —
both reads (weights) and writes (outputs) — flows through worker proxy
endpoints. See [Security model](#security-model).

## Architecture

```
                    +-----------------------+
                    |  Cloudflare Worker    |
                    |  api.mainfeed.app     |
                    +-+--------+--------+---+
                      |        ^        ^
        (1a) POST /swap        |        |
        (1b) POST /image       |        |
        bearer SWAP_POD_SECRET |        |
                      |   (3a) GET      |     (3c) POST /api/swap/complete
                      |   /api/pod/     |     bearer SWAP_POD_SECRET
                      |   weight        |     { request_id, status, ... }
                      v   (worker→pod   |
                          R2 read       |     (3b) POST /api/swap/upload
                          proxy)        |     bearer SWAP_POD_SECRET
                    +-+--------+--------+---+
                    |  swap_server.py      |
                    |  on RunPod GPU       |
                    |  :8000               |
                    |                      |
                    |  - dreamidv_runtime  |
                    |  - flux_pulid_runtime|
                    +----------------------+
                    (2) pipeline runs
                        output → /api/swap/upload (mp4 or jpg)
                        worker writes to R2 via env.CONTENT binding
```

1. Worker → Pod `/swap` (videos+GIFs) or `/image` (cosplay images), bearer-authed.
2. Pod runs the selected pipeline:
   - **`/swap`**: DWPose → DreamID-V diffusion → caption+watermark burn-in (ffmpeg overlay)
   - **`/image`**: Flux text encode → PuLID identity embed → Flux denoise → VAE decode → watermark burn-in (PIL alpha-composite)
3. Pod talks to worker for three things:
   - **`(3a) GET /api/pod/weight?key=models/...`** — streams a mirrored weight file from `r2://mainfeed-content/models/` via worker's `env.CONTENT` binding. Required during pod boot when `HARDEN_WEIGHTS_R2=1`. Worker enforces `models/` prefix restriction.
   - **`(3b) POST /api/swap/upload?key=generated/...`** — streams the generated mp4 or jpg back to R2 via worker. Worker enforces `generated/` prefix restriction.
   - **`(3c) POST /api/swap/complete`** — final callback (success or fail). Worker flips the `generated_pieces` row from `processing` → `ready` / `failed`.

## Security model

**Tenet:** the pod's env contains exactly these secrets and nothing else:
- `SWAP_POD_SECRET` — the bearer token shared with the worker

It MUST NEVER hold:
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — R2 access flows through the worker proxy
- Cloudflare account tokens
- User-data decryption keys

**Why this matters:** community-cloud hosts are third-party operator hardware.
The operator has root and can read any container's env vars via `docker
inspect`, `cat /proc/<pid>/environ`, or `nsenter`. SECURE hosts are RunPod's
own datacenter and trusted, but the principle of least privilege says don't
give the pod access it doesn't need anywhere.

**How it stays enforced:**

- **Output writes** go through `POST /api/swap/upload`. Worker uses
  `env.CONTENT.put()` (Cloudflare-managed binding, never exposed to pod).
  Hard-restricts upload `key` to `generated/` prefix only.
- **Weight reads** go through `GET /api/pod/weight`. Worker uses
  `env.CONTENT.get()`. Hard-restricts read `key` to `models/` prefix only.
- **Source asset reads** (selfies, target videos) use public/signed HTTPS
  URLs the worker generates per-request — NOT boto3 from the pod.
- **HF_TOKEN exception:** for the FLUX.1-schnell gated repo on HuggingFace,
  the pod can hold a fine-grained HF token scoped read-only to that one
  repo (see [[mainfeed_flux_schnell_gated_on_hf]]). Production path:
  `HARDEN_WEIGHTS_R2=1` removes even this dependency — weights load via the
  worker proxy from our R2 mirror, no HF involvement.

The R2-creds-on-pod-via-env path that existed pre-2026-05-27 has been
fully removed from the codebase. `swap_server.py` no longer imports boto3
or constructs an S3 client.

Standing memory rule: [[feedback_no_secrets_on_pod]].

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Reproducible build. Clones DreamID-V + PuLID forks at pinned SHAs. Pre-bakes deps; weights load at startup. |
| `swap_server.py` | FastAPI REST server. Loads both pipelines once. Serves `/swap`, `/image`, `/health`, `/metrics`. Uploads via worker. |
| `dreamidv_runtime.py` | In-process DreamID-V wrapper. Warm pipeline for `/swap` head-swaps. |
| `flux_pulid_runtime.py` | In-process Flux+PuLID wrapper. Warm pipeline for `/image` cosplay generation. Contains the critical `@torch.inference_mode()` decorator on generate_image. |
| `render_overlay.py` | Burn-in. `brand_video()` for mp4 (ffmpeg overlay filter), `brand_image()` for jpg (PIL alpha-composite). |
| `precompute_pose.py` | Per-stock-clip DWPose preprocessing. Run once during library prep to enable DWPose caching. |
| `scripts/spin_new_pod.sh` | One-shot RunPod deploy. Supports SECURE / COMMUNITY / SKIP_SSH modes. |
| `scripts/mirror_weights_to_r2.py` | One-time R2 mirror of DreamID-V + Wan-2.1 + DWPose weights. Runs ON a pod. |
| `scripts/mirror_flux_pulid_to_r2.py` | One-time R2 mirror of Flux + PuLID + antelopev2 weights. Runs on the HOST (uses boto3 multipart to bypass wrangler's 300 MiB cap on the 24 GB flux1-schnell.safetensors). |
| `scripts/test_image_gen.sh` | Convenience runner: fire one `/image` request against the latest pod, download the JPEG for visual QA. |

## Spinning a pod

```bash
# SECURE pod, full pipeline (both /swap and /image)
SKIP_SSH=1 bash pod/scripts/spin_new_pod.sh "NVIDIA RTX A6000"

# SECURE pod, image-only test (no DreamID-V — saves ~17 GB weight download)
SKIP_SSH=1 DREAMIDV_ENABLED=0 bash pod/scripts/spin_new_pod.sh "NVIDIA RTX A6000"

# SECURE pod, video-only test (no Flux+PuLID — saves ~26 GB weight download)
SKIP_SSH=1 FLUX_PULID_ENABLED=0 bash pod/scripts/spin_new_pod.sh "NVIDIA RTX A6000"

# COMMUNITY pod (cheaper, no SSH, image must be current)
CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh "NVIDIA GeForce RTX 4090"
```

The script handles GPU fallback ladder, deploys with the latest GHCR image,
polls `/health` until `model_loaded=true`, and pushes the new pod's HTTP
proxy URL to the worker secret `SWAP_POD_URL`. After it returns, the worker
can queue both swaps and images.

**SECURE vs COMMUNITY vs SKIP_SSH:**

- **SECURE** (default): RunPod datacenter. SSH bootstrap can SCP local source
  edits over the image-baked code (useful for live iteration). 2026-05-27
  observed: SSH plumbing sometimes flakes with `kex_exchange_identification`
  aborts — use `SKIP_SSH=1` as workaround.
- **COMMUNITY**: third-party operator hosts, cheaper ($0.34/hr for 4090 vs
  $0.69/hr SECURE). No SSH (`PUBLIC_KEY` env isn't honored). Image must
  contain everything needed — secrets injected via deploy env array.
- **SKIP_SSH=1**: same as COMMUNITY behavior but on SECURE hosts. Use when
  SSH is flaking or when the latest image already has everything you need.

**Pre-flight requirements:**
- GHCR image must be PUBLIC (https://github.com/users/Haziemparauti/packages/container/mainfeed-swap).
- `SWAP_POD_SECRET` lives at `$STOCK_DIR/swap_pod_secret.txt`.
- `HF_TOKEN` (for FLUX.1-schnell fallback) lives at `$STOCK_DIR/hf_token.txt`.
  If absent, set `HARDEN_WEIGHTS_R2=1` in env to pull Flux via the worker
  proxy from R2 mirror (avoids HF entirely).

## REST contract

### `POST /swap` (worker → pod)

```jsonc
{
  "request_id":         "uuid-or-piece-id",
  "source_image_url":   "https://api.mainfeed.app/public/stock/_welcome_src_<id>.jpg",
  "target_video_url":   "https://api.mainfeed.app/public/stock/cop_s07_coffee_plaza_f.mp4",
  "target_pose_url":    null,                              // optional; pod computes via DWPose if missing
  "target_mask_url":    null,                              // optional; pod computes via DWPose if missing
  "callback_url":       "https://api.mainfeed.app/api/swap/complete",
  "output_r2_key":      "generated/<id>.mp4",
  "sample_steps":       16,                                // LOCKED — sample_steps=8 rejected on 2026-05-28 visual QA
  "sample_guide_scale_img": 4.0,
  "size":               "832*480",                         // DreamID-V CLI asterisk-separator
  "frame_num":          81,                                // 3s @ 24fps locked spec
  "caption":            "POV: ...",                        // optional, burned into video (Anton)
  "handle":             "@user"                            // optional, watermark (Inter Medium)
}
```

Returns `202 Accepted` with `{request_id, status: "processing", in_flight}`.

### `POST /image` (worker → pod)

```jsonc
{
  "request_id":          "uuid-or-piece-id",
  "source_image_url":    "https://api.mainfeed.app/public/stock/_welcome_src_<id>.jpg",
  "prompt":              "movie poster, action hero, man with medium-length dark straight hair, medium-brown skin, holding a katana, neon lighting, cinematic, dramatic, intense expression, ultra detailed",
  "callback_url":        "https://api.mainfeed.app/api/swap/complete",
  "output_r2_key":       "generated/<id>.jpg",
  "width":               1024,                             // locked 1:1 square per spec
  "height":              1024,
  "num_steps":           4,                                // Flux.1-schnell turbo (4-step distilled)
  "guidance":            4.0,                              // fake-CFG, PuLID recommended for photoreal
  "id_weight":           1.0,                              // PuLID identity injection strength
  "start_step":          0,                                // inject ID from first denoise step (highest fidelity)
  "base_seed":           42,
  "handle":              "@user",                          // optional, watermark only (NO caption — image format)
  "aggressive_offload":  false                             // true → shuttle Flux blocks CPU↔GPU during denoise (~5x slower, fits tighter VRAM)
}
```

Returns `202 Accepted` with `{request_id, status: "processing", in_flight, kind: "image"}`.

### `POST /api/swap/upload?key=<key>` (pod → worker)

Bearer-authed via `SWAP_POD_SECRET`. Body = mp4 or jpg binary.

Worker validates:
- Auth bearer matches `SWAP_POD_SECRET`
- Key starts with `generated/` (no `users/`, no `models/`, no `..` traversal)
- Key ends with `.mp4` (Content-Type `video/*`) or `.jpg` (Content-Type `image/*`)
- Body ≤ 100 MB

Returns `{ok: true, bucket: "mainfeed-content", key, size}`.

### `GET /api/pod/weight?key=models/<path>` (pod → worker)

Bearer-authed via `SWAP_POD_SECRET`. Pod-side weight fetch during boot.

Worker validates:
- Auth bearer matches `SWAP_POD_SECRET`
- Key starts with `models/` (read-only, restricted prefix)
- No path traversal

Returns the R2 object body as a stream. No buffering — works for the 24 GB
`flux1-schnell.safetensors` without OOM.

### `POST /api/swap/complete` (pod → worker)

Final callback. Bearer-authed via `SWAP_POD_SECRET`.

```jsonc
{
  "request_id":  "...",
  "status":      "completed",                // or "failed"
  "kind":        "image",                    // or omitted/"video" for /swap
  "elapsed_sec": 28.5,
  "output_bytes": 201211,
  "r2_bucket":   "mainfeed-content",
  "r2_key":      "generated/<id>.jpg",
  "error":       null                        // populated if status="failed"
}
```

Worker defense-in-depth: checks `r2_key` matches the value it stored at
queue time. Prevents a compromised pod delivering Output A as Piece B.

### `GET /health` / `GET /metrics`

```jsonc
{
  "ok":           true,
  "model_loaded": true,
  "in_flight":    0,
  "completed":    17,
  "failed":       2,
  "uptime_sec":   3142.55,
  "last_error":   null
}
```

## Env vars

### Required (set at pod-spin time)

| Var | Purpose |
|---|---|
| `SWAP_POD_SECRET` | Bearer token shared with the worker. Both sides must match. |

### Baked into Dockerfile (production defaults)

| Var | Default | Purpose |
|---|---|---|
| `DREAMIDV_TORCH_COMPILE` | `default` | torch.compile mode for DreamID-V. +14% measured speedup. |
| `HARDEN_WEIGHTS_R2` | `0` | If `1`, pull weights from R2 via worker proxy (~30s cold). |
| `WORKER_UPLOAD_URL` | `https://api.mainfeed.app/api/swap/upload` | Pod-side upload endpoint. |
| `WORKER_WEIGHT_URL` | `https://api.mainfeed.app/api/pod/weight` | Pod-side weight-read endpoint. |
| `R2_BUCKET` | `mainfeed-content` | Path component for R2 keys. |
| `R2_OUTPUT_PREFIX` | `generated/` | Output key prefix. |
| `R2_WEIGHTS_PREFIX` | `models/` | Weight prefix in R2 mirror. |
| `WEIGHTS_DIR` | `/workspace/ckpts` | Local weight cache. |
| `DREAMIDV_DIR` | `/root/dreamidv` | DreamID-V repo checkout. |
| `PULID_DIR` | `/root/pulid` | PuLID repo checkout. |
| `OUTPUT_DIR` | `/workspace/tmp` | Per-request workdir parent. |
| `PORT` | `8000` | Bind port. |

### Optional pipeline toggles

| Var | Default | Purpose |
|---|---|---|
| `DREAMIDV_ENABLED` | `1` | Set to `0` to skip DreamID-V init AND skip downloading its 17 GB of weights. `/swap` returns 503. Image-only test pods. |
| `FLUX_PULID_ENABLED` | `1` | Set to `0` to skip Flux+PuLID init AND skip downloading its 26 GB of weights. `/image` returns 503. Video-only test pods. |
| `HF_TOKEN` | (none) | Optional HuggingFace fine-grained token. Only used when `HARDEN_WEIGHTS_R2=0` AND we need to download the gated FLUX.1-schnell repo. Production path is `HARDEN_WEIGHTS_R2=1` which avoids HF entirely. |
| `PULID_FLUX_VERSION` | `v0.9.1` | PuLID adapter version. |
| `DEBUG_KEEP_WORKDIR` | `0` | If `1`, retain per-request workdirs (debug). |

### No longer accepted

The pod env explicitly does NOT accept these anymore — the worker proxy
handles all R2 access:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

`spin_new_pod.sh` no longer reads `r2_creds.txt` (that file is now used only
by the host-side mirror scripts).

## Performance (measured 2026-05-27/28)

| Operation | Time on RTX A6000 SECURE | Notes |
|---|---|---|
| Container start + image pull | ~1-2 min | Pre-baked image, just network |
| Weight download (worker proxy, full 14 files / 49 GB) | ~24 min cold | Once per pod boot |
| Weight download (worker proxy, image-only 8 files / 26 GB) | ~14 min cold | With `DREAMIDV_ENABLED=0` |
| DreamID-V model load to GPU | ~17-27 sec | Once at startup |
| Flux+PuLID model load to GPU | ~30-60 sec | Once at startup |
| `/swap` wall time (3s video, sample_steps=16, torch.compile=default) | ~98 sec | Per-swap on 4090 SECURE |
| `/image` wall time (1024×1024, num_steps=4, aggressive_offload=false) | ~28 sec | Per-image on A6000, fits 48 GB after `@torch.inference_mode()` fix |
| `/image` wall time (aggressive_offload=true) | ~50-60 sec | Falls back to block-shuttling for 24 GB cards |

Per-piece cost projections:

| Pipeline | GPU | $/piece |
|---|---|---|
| DreamID-V 3s video on 4090 community ($0.34/hr) | 4090 | ~$0.009 |
| DreamID-V 1.5s GIF on 4090 community | 4090 | ~$0.005 |
| Flux+PuLID 1024² image on A6000 community ($0.33/hr) | A6000 | ~$0.003 |

Full economics in [[mainfeed_production_gpu_strategy]].

## Docker image

CI auto-builds on push to `pod/**` via `.github/workflows/build-pod.yml`.
Published to `ghcr.io/haziemparauti/mainfeed-swap:{latest,sha-<7char>}`.

| Property | Value |
|---|---|
| Size (compressed) | ~9.5 GB |
| Layers | ~45 |
| Base | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` |
| Visibility | **PUBLIC** (required for community-cloud pulls) |
| Container disk needed | 100 GB (both pipelines' weights + HF runtime cache for T5/CLIP/EVA-CLIP) |

To rebuild locally:

```bash
docker build -t ghcr.io/haziemparauti/mainfeed-swap:dev pod/
docker push ghcr.io/haziemparauti/mainfeed-swap:dev
```

But CI is faster and gets the cache hits — only do local builds for
Dockerfile experiments before pushing.

## Cross-references

- [[mainfeed_production_gpu_strategy]] — locked production economics (single A6000 + Flux fp8 + DWPose cache → 75% margin)
- [[mainfeed_session_2026-05-27_image_pipeline_launch]] — full build log for the image pipeline shipping
- [[mainfeed_flux_schnell_gated_on_hf]] — HF gating on Flux + HF_TOKEN handling
- [[mainfeed_image_library_architecture]] — image format spec (1:1 1024², watermark only, no library — 50 prompt templates)
- [[mainfeed_v5_production_lockdown_checklist]] — overall build state including DreamID-V Phase 1B mirror history
- [[feedback_no_secrets_on_pod]] — security tenet enforced by the worker-proxy pattern
- [[feedback_three_formats_are_distinct]] — videos / GIFs / images architecture (use precise vocabulary)

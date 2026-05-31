# Mainfeed swap pod

Self-hosted video face-swap. Runs on a single RunPod GPU instance
(swap-only — DreamID-V fits a 24 GB card; target: RTX 4090 / 3090 community),
serving one REST endpoint to the Cloudflare Worker:

- **`/swap`** — DreamID-V faster head+hair swap (videos, output mp4). Supports
  `long_swap` (sliding-window swap for 10–15 s 9:16 clips: overlapping ≤81-frame
  windows, cross-faded, source audio muxed back).

> **Flux/PuLID image generation was REMOVED 2026-05-31.** Mainfeed is video-only
> (produced episodes = swapped hero clips + free text cards). The pod no longer
> serves `/image`, loads no Flux weights, and needs no `HF_TOKEN` in production.

**The pod holds exactly one secret: `SWAP_POD_SECRET`.** No R2 credentials,
no Cloudflare account keys. All R2 access — both reads (weights) and writes
(outputs) — flows through worker proxy endpoints. See [Security model](#security-model).

## Architecture

```
                    +-----------------------+
                    |  Cloudflare Worker    |
                    |  api.mainfeed.app     |
                    +-+--------+--------+---+
                      |        ^        ^
        (1) POST /swap         |        |
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
                    |  - sliding_window    |
                    +----------------------+
                    (2) DWPose → DreamID-V diffusion → (long_swap: stitch +
                        audio mux) → output → /api/swap/upload (mp4)
                        worker writes to R2 via env.CONTENT binding
```

1. Worker → Pod `/swap`, bearer-authed.
2. Pod runs the swap: DWPose → DreamID-V diffusion. For `long_swap`, the clip is
   split into overlapping ≤81-frame windows (`sliding_window.py`), each swapped
   on the warm pipeline, then cross-faded and re-muxed with the source audio.
3. Pod talks to worker for three things:
   - **`(3a) GET /api/pod/weight?key=models/...`** — streams a mirrored weight file from `r2://mainfeed-content/models/` via worker's `env.CONTENT` binding. Required during pod boot when `HARDEN_WEIGHTS_R2=1`. Worker enforces `models/` prefix restriction.
   - **`(3b) POST /api/swap/upload?key=generated/...`** — streams the generated mp4 back to R2 via worker. Worker enforces `generated/` prefix restriction.
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

The R2-creds-on-pod-via-env path that existed pre-2026-05-27 has been
fully removed from the codebase. `swap_server.py` no longer imports boto3
or constructs an S3 client.

Standing memory rule: [[feedback_no_secrets_on_pod]].

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Reproducible build. Clones the DreamID-V fork at a pinned SHA. Pre-bakes deps; weights load at startup. |
| `swap_server.py` | FastAPI REST server. Loads the DreamID-V pipeline once. Serves `/swap`, `/health`, `/metrics`. Uploads via worker. |
| `dreamidv_runtime.py` | In-process DreamID-V wrapper. Warm pipeline for `/swap` head-swaps. `run_swap` (single) + `run_swap_long` (sliding-window). |
| `sliding_window.py` | `plan_windows` + `assemble_windows` — splits long clips into ≤81-frame windows and cross-fades the overlaps back together (PIL blend + ffmpeg audio mux). |
| `render_overlay.py` | Download-branding burn-in. `brand_video()` for mp4 (ffmpeg overlay filter) — the watermark "context bug", applied only on download/share. |
| `precompute_pose.py` | Per-stock-clip DWPose preprocessing. Run once during library prep to enable DWPose caching. |
| `scripts/spin_new_pod.sh` | One-shot RunPod deploy. Supports SECURE / COMMUNITY / SKIP_SSH modes. |
| `scripts/mirror_weights_to_r2.py` | One-time R2 mirror of DreamID-V + Wan-2.1 + DWPose weights. Runs ON a pod. |
| `scripts/fade_clip.sh` | Apply a quick 0.4 s fade in/out (video + audio) to a swap output before finalizing. |

## Spinning a pod

```bash
# COMMUNITY pod (cheaper, no SSH, image must be current) — default ladder now
# leads with 24 GB consumer cards (4090 → 3090) since swap-only fits 24 GB.
CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh

# Pin a specific GPU
CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh "NVIDIA GeForce RTX 3090"

# SECURE pod (RunPod datacenter; SSH bootstrap can SCP local source edits)
bash pod/scripts/spin_new_pod.sh "NVIDIA RTX A6000"
```

The script handles the GPU fallback ladder, deploys with the latest GHCR image,
polls `/health` until `model_loaded=true`, and pushes the new pod's HTTP
proxy URL to the worker secret `SWAP_POD_URL`. After it returns, the worker
can queue swaps.

**SECURE vs COMMUNITY vs SKIP_SSH:**

- **SECURE** (default): RunPod datacenter. SSH bootstrap can SCP local source
  edits over the image-baked code (useful for live iteration). 2026-05-27
  observed: SSH plumbing sometimes flakes with `kex_exchange_identification`
  aborts — use `SKIP_SSH=1` as workaround.
- **COMMUNITY**: third-party operator hosts, cheaper ($0.22/hr for 3090,
  $0.34/hr for 4090 vs $0.69/hr SECURE). No SSH (`PUBLIC_KEY` env isn't
  honored). Image must contain everything needed — secrets injected via deploy env array.
- **SKIP_SSH=1**: same as COMMUNITY behavior but on SECURE hosts. Use when
  SSH is flaking or when the latest image already has everything you need.

**Pre-flight requirements:**
- GHCR image must be PUBLIC (https://github.com/users/Haziemparauti/packages/container/mainfeed-swap).
- `SWAP_POD_SECRET` lives at `$STOCK_DIR/swap_pod_secret.txt`.
- Production weight path is `HARDEN_WEIGHTS_R2=1` (baked default in the deploy) —
  pulls DreamID-V + Wan-2.1 + DWPose weights from the R2 mirror via the worker
  proxy, no HuggingFace involvement.

## REST contract

### `POST /swap` (worker → pod)

```jsonc
{
  "request_id":         "uuid-or-piece-id",
  "source_image_url":   "https://api.mainfeed.app/public/stock/_welcome_src_<id>.jpg",
  "target_video_url":   "https://api.mainfeed.app/public/stock/jungle_d1v2_s2.mp4",
  "target_pose_url":    null,                              // optional; pod computes via DWPose if missing
  "target_mask_url":    null,                              // optional; pod computes via DWPose if missing
  "callback_url":       "https://api.mainfeed.app/api/swap/complete",
  "output_r2_key":      "generated/<id>.mp4",
  "sample_steps":       16,                                // LOCKED — sample_steps=8 rejected on 2026-05-28 visual QA
  "sample_guide_scale_img": 4.0,
  "size":               "720*1280",                        // DreamID-V CLI asterisk-separator; 9:16 vertical
  "frame_num":          121,                               // ignored when long_swap=true (windows derived from clip)
  "long_swap":          true,                              // sliding-window swap for >81-frame (10–15 s) clips + audio
  "handle":             "@user"                            // optional, download watermark (Inter Medium)
}
```

Returns `202 Accepted` with `{request_id, status: "processing", in_flight}`.

### `POST /api/swap/upload?key=<key>` (pod → worker)

Bearer-authed via `SWAP_POD_SECRET`. Body = mp4 binary.

Worker validates:
- Auth bearer matches `SWAP_POD_SECRET`
- Key starts with `generated/` (no `users/`, no `models/`, no `..` traversal)
- Key ends with `.mp4` (Content-Type `video/*`)
- Body ≤ 100 MB

Returns `{ok: true, bucket: "mainfeed-content", key, size}`.

### `GET /api/pod/weight?key=models/<path>` (pod → worker)

Bearer-authed via `SWAP_POD_SECRET`. Pod-side weight fetch during boot.

Worker validates:
- Auth bearer matches `SWAP_POD_SECRET`
- Key starts with `models/` (read-only, restricted prefix)
- No path traversal

Returns the R2 object body as a stream. No buffering — works for multi-GB
weight files without OOM.

### `POST /api/swap/complete` (pod → worker)

Final callback. Bearer-authed via `SWAP_POD_SECRET`.

```jsonc
{
  "request_id":  "...",
  "status":      "completed",                // or "failed"
  "elapsed_sec": 2760.0,
  "output_bytes": 4201211,
  "r2_bucket":   "mainfeed-content",
  "r2_key":      "generated/<id>.mp4",
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
| `HARDEN_WEIGHTS_R2` | `0` | If `1`, pull weights from R2 via worker proxy (~30s cold). Set `1` by the spin script. |
| `WORKER_UPLOAD_URL` | `https://api.mainfeed.app/api/swap/upload` | Pod-side upload endpoint. |
| `WORKER_WEIGHT_URL` | `https://api.mainfeed.app/api/pod/weight` | Pod-side weight-read endpoint. |
| `R2_BUCKET` | `mainfeed-content` | Path component for R2 keys. |
| `R2_OUTPUT_PREFIX` | `generated/` | Output key prefix. |
| `R2_WEIGHTS_PREFIX` | `models/` | Weight prefix in R2 mirror. |
| `WEIGHTS_DIR` | `/workspace/ckpts` | Local weight cache. |
| `DREAMIDV_DIR` | `/root/dreamidv` | DreamID-V repo checkout. |
| `OUTPUT_DIR` | `/workspace/tmp` | Per-request workdir parent. |
| `PORT` | `8000` | Bind port. |

### Optional pipeline toggles

| Var | Default | Purpose |
|---|---|---|
| `DREAMIDV_ENABLED` | `1` | Set to `0` to skip DreamID-V init AND skip downloading its ~17 GB of weights. `/swap` returns 503. Rarely useful now (swap is the only pipeline). |
| `HF_TOKEN` | (none) | Optional HuggingFace token for the HF weight-download fallback (`HARDEN_WEIGHTS_R2=0`). DreamID-V + Wan-2.1 repos are public, so it's normally unset. |
| `DEBUG_KEEP_WORKDIR` | `0` | If `1`, retain per-request workdirs (debug). |

### No longer accepted

The pod env explicitly does NOT accept these anymore — the worker proxy
handles all R2 access:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

`spin_new_pod.sh` no longer reads `r2_creds.txt` (that file is now used only
by the host-side mirror script).

## Performance (measured 2026-05-27 → 05-31)

| Operation | Time | Notes |
|---|---|---|
| Container start + image pull | ~1-2 min | Pre-baked image, just network |
| Weight download (worker proxy, DreamID-V + Wan-2.1 + DWPose) | ~14 min cold | Once per pod boot |
| DreamID-V model load to GPU | ~17-27 sec | Once at startup |
| `/swap` single (≤81-frame, sample_steps=16, torch.compile) | ~98 sec | first swap pays a one-time ~9 min torch.compile |
| `/swap` `long_swap` (full 15s / 358 frames, 720², 5 windows, audio) | ~46 min on L40 | first window pays the compile tax; ~35-40 min subsequent. 512² ≈ 3.5× faster. |

Per-piece cost: dominated by video-seconds swapped/user. See
[[mainfeed_production_gpu_strategy]] and the cost number in
[[mainfeed_todo_2026-05-30]] (~46 min/clip at 720² on L40).

## Docker image

CI auto-builds on push to `pod/**` via `.github/workflows/build-pod.yml`.
Published to `ghcr.io/haziemparauti/mainfeed-swap:{latest,sha-<7char>}`.

> Note: CI only BUILDS the image — it never runs a swap. CI-green ≠ pipeline
> works. Always prove a real swap on a fresh pod after a meaningful pod change
> (lesson from 2026-05-31, when `run_swap_long` was missing from a "green" image).

| Property | Value |
|---|---|
| Base | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` |
| Visibility | **PUBLIC** (required for community-cloud pulls) |
| Container disk needed | 100 GB (weights + HF runtime cache for T5) |

To rebuild locally:

```bash
docker build -t ghcr.io/haziemparauti/mainfeed-swap:dev pod/
docker push ghcr.io/haziemparauti/mainfeed-swap:dev
```

But CI is faster and gets the cache hits — only do local builds for
Dockerfile experiments before pushing.

## Cross-references

- [[mainfeed_production_gpu_strategy]] — locked production economics
- [[mainfeed_todo_2026-05-30]] — current to-do; long-swap proof + cost number
- [[mainfeed_v5_production_lockdown_checklist]] — overall build state including DreamID-V mirror history
- [[feedback_no_secrets_on_pod]] — security tenet enforced by the worker-proxy pattern

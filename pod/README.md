# Mainfeed swap pod

Self-hosted DreamID-V faster head+hair swap. Runs on a single RunPod GPU
instance (RTX 4090 / 3090 / A40 / A6000), serves a REST `/swap` endpoint to
the Cloudflare Worker. Output mp4s are uploaded back to R2 via the worker —
**the pod never holds R2 credentials by default** (security audit 2026-05-27,
see [Security model](#security-model) below).

## Architecture

```
                    +-----------------------+
                    |  Cloudflare Worker    |
                    |  api.mainfeed.app     |
                    +-----+--------+--------+
                          |        ^      ^
        (1) POST /swap    |        |      |
        with Bearer       |   (3) POST    |    (4) POST /api/swap/complete
        SWAP_POD_SECRET   |   /api/swap/  |    Bearer SWAP_POD_SECRET
                          v   upload      |    { request_id, status, ... }
                    +-----+--------+------+
                    |  swap_server.py     |
                    |  on RunPod GPU      |
                    |  :8000              |
                    +---------------------+
                    (2) DreamID-V swap runs
                        output → /api/swap/upload
                        worker writes to R2 via env.CONTENT binding
```

1. Worker → Pod `/swap` — bearer-authed request with source + target URLs.
2. Pod runs the DreamID-V swap (`run_swap` → DWPose → diffusion → caption/watermark burn-in).
3. Pod → Worker `/api/swap/upload?key=generated/<id>.mp4` — streams output mp4.
   Worker writes to R2 (`env.CONTENT.put`) and returns `{ok, bucket, key, size}`.
4. Pod → Worker `/api/swap/complete` — final callback with elapsed/result/keys.
   Worker flips the `generated_pieces` row from `processing` → `ready`/`failed`.

## Security model

**Tenet:** the pod holds exactly ONE secret: `SWAP_POD_SECRET` (bearer token to
talk to the worker). It MUST NEVER hold:

- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
- Cloudflare account tokens
- User-data decryption keys

**Why:** community-cloud hosts are third-party operator hardware. The operator
has root on the host and can read any container's env vars via
`docker inspect`, `cat /proc/<pid>/environ`, or `nsenter`. SECURE hosts are
RunPod's datacenter and trusted, but principle of least privilege says don't
give the pod access it doesn't need anywhere.

**How it stays enforced:**
- All R2 writes go through `POST /api/swap/upload` on the worker, which uses
  Cloudflare R2 bindings (server-side configuration, never exposed to pod).
- Worker hard-restricts upload `key` prefix to `generated/` — even a fully
  compromised pod can't overwrite selfies, weights, or brand assets.
- Pod reads (source images, target videos) use public/signed HTTPS URLs the
  worker generates per-request, NOT boto3 from the pod.
- Weights load from HuggingFace by default (~6 min cold). The optional
  R2 weights fast-path (`HARDEN_WEIGHTS_R2=1`, ~30s) requires a separate
  READ-ONLY token scoped to `models/*` only — never inject a token with
  broader access.

This refactor landed 2026-05-27 evening (commit `d305a42`, worker version
`6d5a677e`). Standing memory rule:
`feedback_no_secrets_on_pod.md`.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Reproducible build of the swap pod image. Pre-baked weights NOT included (downloaded at startup). |
| `swap_server.py` | FastAPI REST server. Loads DreamID-V once, serves `/swap` + `/health`. Uploads via worker. |
| `dreamidv_runtime.py` | In-process DreamID-V wrapper. Loaded once at startup; reused per swap. |
| `render_overlay.py` | Caption + watermark burn-in (Anton + Inter Medium + brand SVG). |
| `precompute_pose.py` | Per-stock-clip DWPose preprocessing. Run once during library prep. |
| `scripts/spin_new_pod.sh` | One-shot deploy script. Supports `CLOUD_TYPE=SECURE` (default) and `CLOUD_TYPE=COMMUNITY`. |
| `scripts/mirror_weights_to_r2.py` | One-time R2 mirror of all weights → `mainfeed-content/models/`. Idempotent. Requires R2 creds in env (no defaults). |

## Spinning a pod

```bash
# SECURE pod (default) — proven dev flow, supports SSH-based source SCP
bash pod/scripts/spin_new_pod.sh                       # default A40 SECURE
bash pod/scripts/spin_new_pod.sh "NVIDIA RTX A6000"    # GPU override

# COMMUNITY pod (cheaper, no SSH) — image-only, secrets via deploy env
CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh
CLOUD_TYPE=COMMUNITY bash pod/scripts/spin_new_pod.sh "NVIDIA GeForce RTX 4090"
```

Either path: script handles GPU fallback ladder, polls `/health` until
`model_loaded:true`, and pushes the new pod's HTTP proxy URL to the worker
secret `SWAP_POD_URL`. After it returns, the worker can queue swaps.

**Pre-flight requirement:** the GHCR image visibility must be PUBLIC at
https://github.com/users/Haziemparauti/packages/container/mainfeed-swap.
Otherwise community hosts can't pull the image and stall silently
(audit 2026-05-27 — this was the root cause of multiple "runtime: null"
community failures).

## REST contract

### `POST /swap` (worker → pod)

```jsonc
{
  "request_id":         "uuid-or-piece-id",
  "source_image_url":   "https://api.mainfeed.app/public/stock/_welcome_src_<id>.jpg",
  "target_video_url":   "https://api.mainfeed.app/public/stock/cop_s07_coffee_plaza_f.mp4",
  "target_pose_url":    null,            // optional; pod computes if missing
  "target_mask_url":    null,            // optional; pod computes if missing
  "callback_url":       "https://api.mainfeed.app/api/swap/complete",
  "output_r2_key":      "generated/<id>.mp4",  // optional; worker enforces "generated/" prefix
  "sample_steps":       16,
  "sample_guide_scale_img": 4.0,
  "size":               "832*480",       // asterisk separator (DreamID-V CLI requirement)
  "frame_num":          81,              // 3s @ 24fps (production locked spec)
  "caption":            "POV: ...",      // optional, burned into video
  "handle":             "@user"          // optional, watermark
}
```

Returns `202 Accepted` with `{request_id, status: "processing", in_flight}`.

### `POST /api/swap/upload?key=generated/<id>.mp4` (pod → worker)

Bearer-authed via `SWAP_POD_SECRET`. Body = mp4 binary, `Content-Type: video/mp4`.

Worker validates:
- Auth bearer matches `SWAP_POD_SECRET`
- Key starts with `generated/` (no `users/`, no `models/`, no `..` traversal)
- Body ≤ 100 MB (pre-checked via `Content-Length`, re-checked post-read)
- Content-Type starts with `video/`

Returns `{ok: true, bucket: "mainfeed-content", key, size}`.

### `POST /api/swap/complete` (pod → worker)

Final callback. Bearer-authed via `SWAP_POD_SECRET`.

```jsonc
{
  "request_id":  "...",
  "status":      "completed",            // or "failed"
  "elapsed_sec": 98.05,
  "output_bytes": 3311710,
  "r2_bucket":   "mainfeed-content",
  "r2_key":      "generated/<id>.mp4",
  "error":       null                    // populated if status="failed"
}
```

Worker checks `r2_key` matches the value it stored at queue time —
defense-in-depth against a compromised pod delivering Output A as Piece B.

### `GET /health`

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
| `SWAP_POD_SECRET` | Bearer between pod and worker. Both sides must match. |

### Baked into Dockerfile (defaults)

| Var | Default | Purpose |
|---|---|---|
| `DREAMIDV_TORCH_COMPILE` | `default` | torch.compile mode. +14% measured speedup. |
| `HARDEN_WEIGHTS_R2` | `0` | If `1`, pull weights from R2 mirror (requires R2 creds). |
| `R2_BUCKET` | `mainfeed-content` | Bucket name (used only if R2 client constructs). |
| `R2_OUTPUT_PREFIX` | `generated/` | Default output key prefix. |
| `R2_WEIGHTS_PREFIX` | `models/` | Weight prefix in R2 mirror. |
| `WORKER_UPLOAD_URL` | `https://api.mainfeed.app/api/swap/upload` | Where the pod uploads outputs. |
| `WEIGHTS_DIR` | `/workspace/ckpts` | Local weight cache. |
| `DREAMIDV_DIR` | `/root/dreamidv` | DreamID-V repo checkout. |
| `OUTPUT_DIR` | `/workspace/tmp` | Per-request workdir parent. |
| `PORT` | `8000` | Bind port. |

### Optional (only set if HARDEN_WEIGHTS_R2=1)

| Var | Purpose |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID. Required if R2 client is enabled. |
| `R2_ACCESS_KEY_ID` | R2 S3 access key. Must be READ-ONLY scoped to `models/*` only. |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret. Same scope rule. |

**Never inject R2 creds with broader scope.** A compromised community pod
with broad R2 access could exfiltrate every user's selfies.

## Performance (measured 2026-05-27)

| Stage | Time on RTX 4090 SECURE | Notes |
|---|---|---|
| Container start + image pull | ~1-2 min | Pre-baked image, just network |
| Weight download (HF, default) | ~6 min cold | Once per pod boot |
| Weight download (R2 mirror) | ~30 sec | Requires `HARDEN_WEIGHTS_R2=1` + creds |
| Model load to GPU | ~17-27 sec | Once at swap_server startup |
| **Per-swap wall time** | **~98 sec** | 3s output, `sample_steps=16`, torch.compile=default |
| Eager mode (no torch.compile) | ~111 sec | Rollback fallback only |

Per-swap cost on 4090 SECURE ($0.69/hr): **$0.019/swap**.
On 4090 community ($0.34/hr, projected): **$0.009/swap**.

See [mainfeed_optimization_test_results_2026-05-27] (memory) for the full
compile-time optimization test pass — `default` is the locked production mode;
`max-autotune` and `reduce-overhead` are dead (CUDA graphs incompatible).

## Docker image

CI auto-builds on push to `pod/**` via `.github/workflows/build-pod.yml`.
Published to `ghcr.io/haziemparauti/mainfeed-swap:{latest,sha-<7char>}`.

| Property | Value |
|---|---|
| Size (compressed) | ~9.13 GB |
| Layers | 41 |
| Base | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` (~7 GB of total) |
| Visibility | **PUBLIC** (required for community-cloud pulls) |

To rebuild locally:

```bash
docker build -t ghcr.io/haziemparauti/mainfeed-swap:dev pod/
docker push ghcr.io/haziemparauti/mainfeed-swap:dev
```

But CI is faster and gets the cache hits — only do local builds for
Dockerfile experiments before pushing.

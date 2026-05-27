#!/usr/bin/env python3
"""
Mainfeed swap pod — REST server.

Long-running process. Pulls DreamID-V faster + Wan-2.1 + DWPose at startup,
runs `generate_dreamidv_faster.py` (head+hair swap, body preserved) per request.
Single GPU, serialized via asyncio.Lock (DreamID-V is not thread-safe).

Endpoints:
  POST /swap     — queue a swap job (returns 202, callbacks when done)
  GET  /health   — liveness + model-loaded probe
  GET  /metrics  — same as /health for now

Validated invocation (cop_s07_coffee_plaza_f + example1_512.jpg, 2026-05-25):
  python generate_dreamidv_faster.py
    --task swapface --size 832*480
    --ckpt_dir /workspace/ckpts/wan2.1
    --dreamidv_ckpt /workspace/ckpts/dreamidv_faster.pth
    --ref_image source.jpg --ref_video target.mp4 --save_file output.mp4
    --sample_steps 16 --sample_guide_scale_img 4.0 --base_seed 42

Auth: protected endpoints require `Authorization: Bearer $SWAP_POD_SECRET`.

Environment:
  SWAP_POD_SECRET      — shared bearer between worker and pod. Required.
  WEIGHTS_DIR          — root for cached weights. Default /workspace/ckpts.
  DREAMIDV_DIR         — DreamID-V repo checkout. Default /root/dreamidv.
  OUTPUT_DIR           — per-request workdir parent. Default /workspace/tmp.
  PORT                 — bind port. Default 8000.
  HF_TOKEN             — optional, only if HF repos require auth.
  DEBUG_KEEP_WORKDIR   — "1" to retain workdirs after each swap (debugging).

  R2_ACCOUNT_ID        — Cloudflare account ID for R2.
  R2_ACCESS_KEY_ID     — R2 S3-compat access key.
  R2_SECRET_ACCESS_KEY — R2 S3-compat secret.
  R2_BUCKET            — bucket name for swap outputs. Default mainfeed-content.
  R2_OUTPUT_PREFIX     — key prefix. Default generated/.
"""

from __future__ import annotations
import asyncio
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Optional

import boto3
import httpx
import uvicorn
from botocore.client import Config as BotoConfig
from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

from render_overlay import brand_video


# ============ config ============

POD_SECRET = os.environ.get("SWAP_POD_SECRET", "")
WEIGHTS_DIR = Path(os.environ.get("WEIGHTS_DIR", "/workspace/ckpts"))
DREAMIDV_DIR = Path(os.environ.get("DREAMIDV_DIR", "/root/dreamidv"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/workspace/tmp"))
PORT = int(os.environ.get("PORT", "8000"))
HF_TOKEN = os.environ.get("HF_TOKEN", "") or None

# Worker proxy URL for output upload. Pod POSTs the swap mp4 here and the
# worker writes it to R2 via Cloudflare binding — pod never holds R2 creds.
# This closes the leak vector where community-cloud hosts could read R2
# credentials from the container's env (audit 2026-05-27).
WORKER_UPLOAD_URL = os.environ.get(
    "WORKER_UPLOAD_URL",
    "https://api.mainfeed.app/api/swap/upload",
)

DREAMIDV_FASTER_CKPT = WEIGHTS_DIR / "dreamidv_faster.pth"
WAN21_DIR = WEIGHTS_DIR / "wan2.1"
DWPOSE_DIR = DREAMIDV_DIR / "pose" / "models"

# R2 (Cloudflare S3-compatible) — optional. If creds are present the pod
# pulls weights from R2 mirror (~30s). Without creds it falls back to
# HuggingFace (~6 min cold). Output upload no longer uses these creds —
# see WORKER_UPLOAD_URL above. R2_ACCOUNT_ID is read from env (no longer
# defaulted to a tenant-specific value baked into the source).
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "mainfeed-content")
R2_OUTPUT_PREFIX = os.environ.get("R2_OUTPUT_PREFIX", "generated/").rstrip("/") + "/"
R2_WEIGHTS_PREFIX = os.environ.get("R2_WEIGHTS_PREFIX", "models/").rstrip("/") + "/"
R2_ENABLED = bool(R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY)
# If set + R2 is configured, ensure_weights pulls from R2 mirror instead of HuggingFace.
HARDEN_WEIGHTS_R2 = os.environ.get("HARDEN_WEIGHTS_R2", "0") == "1"


# ============ state ============

class State:
    def __init__(self) -> None:
        self.model_loaded = False
        self.started_at = time.time()
        self.gpu_lock = asyncio.Lock()
        self.in_flight = 0
        self.total_completed = 0
        self.total_failed = 0
        self.last_error: Optional[str] = None
        self.r2: Optional[object] = None


STATE = State()


def build_r2_client():
    if not R2_ENABLED:
        return None
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=BotoConfig(signature_version="s3v4"),
        region_name="auto",
    )


# ============ API models ============

class SwapRequest(BaseModel):
    request_id: str = Field(..., min_length=1, max_length=128)
    source_image_url: str
    target_video_url: str
    # pose/mask URLs are kept in the schema for future compat with the dwpose
    # variant; the FASTER variant computes pose internally and ignores them.
    target_pose_url: Optional[str] = None
    target_mask_url: Optional[str] = None
    callback_url: str
    # R2 key under R2_BUCKET where the output mp4 should land (e.g.
    # "generated/u/<user_id>/<piece_id>.mp4"). If null, defaults to
    # f"{R2_OUTPUT_PREFIX}{request_id}.mp4".
    output_r2_key: Optional[str] = None
    sample_steps: int = 16
    sample_guide_scale_img: float = 4.0
    size: str = "832*480"   # DreamID-V uses asterisk-separated W*H
    base_seed: int = 42
    frame_num: Optional[int] = None  # default determined by DreamID-V if None
    # Caption + user handle drive the post-swap burn-in step. If both are
    # null the burn-in is a no-op and the raw swap output is uploaded.
    caption: Optional[str] = None
    handle: Optional[str] = None


# ============ weight download (HF) ============

# Weight manifest — used by both R2 and HF paths.
# Each entry: (local_path, r2_key, hf_repo_or_None, hf_filename_or_None)
# Entries with hf_repo=None are pulled by snapshot_download (Wan-2.1 bundle).
def _weight_manifest():
    return [
        (DREAMIDV_FASTER_CKPT,
         f"{R2_WEIGHTS_PREFIX}dreamidv_faster.pth",
         "XuGuo699/DreamID-V", "dreamidv_faster.pth"),
        (DWPOSE_DIR / "dw-ll_ucoco_384.onnx",
         f"{R2_WEIGHTS_PREFIX}dwpose/dw-ll_ucoco_384.onnx",
         "XuGuo699/DreamID-V", "dw-ll_ucoco_384.onnx"),
        (DWPOSE_DIR / "yolox_l.onnx",
         f"{R2_WEIGHTS_PREFIX}dwpose/yolox_l.onnx",
         "XuGuo699/DreamID-V", "yolox_l.onnx"),
        (WAN21_DIR / "Wan2.1_VAE.pth",
         f"{R2_WEIGHTS_PREFIX}wan2.1/Wan2.1_VAE.pth",
         None, None),
        (WAN21_DIR / "models_t5_umt5-xxl-enc-bf16.pth",
         f"{R2_WEIGHTS_PREFIX}wan2.1/models_t5_umt5-xxl-enc-bf16.pth",
         None, None),
        (WAN21_DIR / "diffusion_pytorch_model.safetensors",
         f"{R2_WEIGHTS_PREFIX}wan2.1/diffusion_pytorch_model.safetensors",
         None, None),
    ]


def _exists_and_nonempty(p: Path, min_bytes: int = 1_000_000) -> bool:
    try:
        return p.exists() and p.stat().st_size >= min_bytes
    except OSError:
        return False


def _r2_download(s3, key: str, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(Bucket=R2_BUCKET, Key=key, Filename=str(dst))


def ensure_weights() -> None:
    """Materialize all required weight files under WEIGHTS_DIR + DREAMIDV_DIR/pose/models.

    Source selection:
      - HARDEN_WEIGHTS_R2=1 + R2 creds set  →  pull from R2 mirror (mainfeed-content/models/...)
      - otherwise                            →  pull from HuggingFace
    """
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    WAN21_DIR.mkdir(parents=True, exist_ok=True)
    DWPOSE_DIR.mkdir(parents=True, exist_ok=True)

    manifest = _weight_manifest()
    missing = [m for m in manifest if not _exists_and_nonempty(m[0])]
    if not missing:
        print("[ensure_weights] all weights present", flush=True)
        return

    use_r2 = HARDEN_WEIGHTS_R2 and R2_ENABLED
    if use_r2:
        s3 = build_r2_client()
        print(f"[ensure_weights] R2 mirror — fetching {len(missing)} files from "
              f"r2://{R2_BUCKET}/{R2_WEIGHTS_PREFIX}", flush=True)
        for local, r2_key, _, _ in missing:
            print(f"  GET {r2_key}", flush=True)
            t = time.time()
            _r2_download(s3, r2_key, local)
            sz = local.stat().st_size
            el = time.time() - t
            print(f"      ok {sz/1e6:.0f} MB in {el:.1f}s ({(sz/1e6)/max(el,0.001):.0f} MB/s)", flush=True)
        print("[ensure_weights] all weights present (from R2)", flush=True)
        return

    # Fallback / default: HuggingFace
    from huggingface_hub import hf_hub_download, snapshot_download
    print(f"[ensure_weights] HuggingFace — fetching {len(missing)} files "
          "(set HARDEN_WEIGHTS_R2=1 + R2 creds to use our R2 mirror)", flush=True)

    # Individual hf_hub_downloads for files with explicit hf_repo
    for local, _, hf_repo, hf_filename in missing:
        if hf_repo and not _exists_and_nonempty(local):
            print(f"  hf_hub_download {hf_repo}:{hf_filename}", flush=True)
            hf_hub_download(
                repo_id=hf_repo, filename=hf_filename,
                local_dir=str(local.parent), token=HF_TOKEN,
            )

    # Wan-2.1 bundle via snapshot_download (only if any wan2.1 file is still missing)
    wan_missing = [m for m in missing if m[2] is None and not _exists_and_nonempty(m[0])]
    if wan_missing:
        print("  snapshot_download Wan-AI/Wan2.1-T2V-1.3B (allow_patterns)", flush=True)
        snapshot_download(
            repo_id="Wan-AI/Wan2.1-T2V-1.3B",
            local_dir=str(WAN21_DIR),
            allow_patterns=["*.pth", "*.safetensors", "config.json", "google/**"],
            token=HF_TOKEN,
        )

    print("[ensure_weights] all weights present (from HuggingFace)", flush=True)


# ============ helpers ============

async def download_to(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=1 << 16):
                    f.write(chunk)


async def upload_via_worker(src: Path, key: str, content_type: str = "video/mp4") -> dict:
    """Stream a local file to the worker's /api/swap/upload endpoint. The worker
    holds R2 access via its Cloudflare binding and writes the file on the pod's
    behalf — this lets the pod never hold R2 credentials. Bearer-authed via
    SWAP_POD_SECRET (already shared between pod and worker).

    Audit 2026-05-27: replaces the previous direct boto3 PUT, which would leak
    R2 credentials onto community-cloud hosts (the host operator can read any
    container's env vars). Worker enforces key prefix = "generated/" so a
    compromised pod can't overwrite selfies, weights, or brand assets.
    """
    if not WORKER_UPLOAD_URL:
        raise RuntimeError("WORKER_UPLOAD_URL not configured")
    if not POD_SECRET:
        raise RuntimeError("SWAP_POD_SECRET not set; cannot authenticate to worker")
    size = src.stat().st_size
    with open(src, "rb") as f:
        data = f.read()
    headers = {
        "Authorization": f"Bearer {POD_SECRET}",
        "Content-Type": content_type,
    }
    params = {"key": key}
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(WORKER_UPLOAD_URL, content=data, headers=headers, params=params)
        if resp.status_code >= 300:
            raise RuntimeError(f"worker upload {resp.status_code}: {resp.text[:300]}")
        return {
            "bucket": "mainfeed-content",
            "key": key,
            "size": size,
            "worker_response": resp.json(),
        }


async def callback(callback_url: str, payload: dict) -> None:
    if not callback_url:
        return
    headers = {"Content-Type": "application/json"}
    if POD_SECRET:
        headers["Authorization"] = f"Bearer {POD_SECRET}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            await client.post(callback_url, json=payload, headers=headers)
    except Exception as e:
        print(f"[swap_server] callback failed: {e}", flush=True)


# ============ inference (in-process, warm DreamID-V) ============

# dreamidv_runtime keeps the DreamIDV pipeline loaded once at startup;
# every /swap call reuses the warm model. Refactor 2026-05-26 from the
# old subprocess-per-swap design — saves ~10-15s of Python+weight-load
# overhead per swap AND unblocks future torch.compile / TRT optimizations
# whose compiled artifacts only pay off when the model state persists.
import dreamidv_runtime


async def run_dreamidv(workdir: Path, src_image: Path, ref_video: Path,
                       sample_steps: int, sample_guide_scale_img: float,
                       size: str, base_seed: int, frame_num: Optional[int]) -> Path:
    """Run one swap against the warm DreamID-V pipeline (in-process)."""
    if not dreamidv_runtime.is_ready():
        raise RuntimeError("dreamidv_runtime not initialized; call init() at startup")

    output = workdir / "output.mp4"

    # frame_num=None → fall back to DreamID-V's default of 81. The worker
    # sends 81 (3s @ 24fps, locked spec); we keep the optional path for
    # one-off longer-clip tests.
    kwargs = dict(
        src_image=str(src_image),
        ref_video=str(ref_video),
        out_mp4=str(output),
        size=size,
        sample_steps=sample_steps,
        sample_guide_scale_img=sample_guide_scale_img,
        sample_shift=5.0,
        sample_solver="unipc",
        seed=base_seed,
        offload_model=True,
        task="swapface",
    )
    if frame_num is not None:
        kwargs["frame_num"] = frame_num

    print(f"[swap_server] running dreamidv (warm) "
          f"size={size} steps={sample_steps} frame_num={frame_num} seed={base_seed}", flush=True)
    started = time.time()
    # CPU-bound + blocking — run in a thread so we don't stall the event loop.
    await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: dreamidv_runtime.run_swap(**kwargs),
    )
    elapsed = round(time.time() - started, 2)

    if not output.exists():
        raise RuntimeError(f"DreamID-V finished {elapsed}s but no output at {output}")
    print(f"[swap_server] DreamID-V finished in {elapsed}s, output {output.stat().st_size} bytes", flush=True)
    return output


async def run_swap(req: SwapRequest) -> None:
    workdir = OUTPUT_DIR / req.request_id
    workdir.mkdir(parents=True, exist_ok=True)
    src_image = workdir / "source.jpg"
    ref_video = workdir / "target.mp4"
    started = time.time()

    # Resolve R2 destination — caller may override; otherwise key by request_id.
    r2_key = req.output_r2_key or f"{R2_OUTPUT_PREFIX}{req.request_id}.mp4"

    try:
        await download_to(req.source_image_url, src_image)
        await download_to(req.target_video_url, ref_video)
        # pose/mask are ignored for the FASTER variant; keep schema for compat
        async with STATE.gpu_lock:
            output = await run_dreamidv(
                workdir, src_image, ref_video,
                req.sample_steps, req.sample_guide_scale_img,
                req.size, req.base_seed, req.frame_num,
            )

        # Burn caption + watermark into the video frames so the file you
        # download from your feed and upload to TikTok/IG carries the brand.
        # No-op if neither caption nor handle was provided.
        burn_started = time.time()
        try:
            branded = await asyncio.get_event_loop().run_in_executor(
                None, brand_video, output, workdir, req.handle, req.caption,
            )
            if branded != output:
                burn_elapsed = round(time.time() - burn_started, 2)
                print(f"[swap_server] {req.request_id} burn-in OK in {burn_elapsed}s "
                      f"({branded.stat().st_size} bytes)", flush=True)
                output = branded
        except Exception as burn_err:
            # Failure here is non-fatal — fall back to the un-branded swap so
            # the user still sees their video. Log it loudly so we can fix.
            print(f"[swap_server] {req.request_id} burn-in FAILED, uploading raw swap: {burn_err}",
                  flush=True)

        # Upload output mp4 via the worker proxy. Pod never holds R2 creds —
        # worker writes to R2 on the pod's behalf via Cloudflare binding.
        r2_meta = await upload_via_worker(output, r2_key, "video/mp4")
        print(f"[swap_server] {req.request_id} → r2://{r2_meta['bucket']}/{r2_meta['key']} ({r2_meta['size']} bytes)", flush=True)

        elapsed = round(time.time() - started, 2)
        STATE.total_completed += 1
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "completed",
            "elapsed_sec": elapsed,
            "output_bytes": output.stat().st_size if output.exists() else 0,
            "r2_bucket": (r2_meta or {}).get("bucket"),
            "r2_key":    (r2_meta or {}).get("key"),
        })
        print(f"[swap_server] {req.request_id} OK in {elapsed}s", flush=True)
    except Exception as e:
        STATE.total_failed += 1
        msg = str(e)[:1500]
        print(f"[swap_server] {req.request_id} FAILED: {msg}", flush=True)
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "failed",
            "error": msg,
        })
    finally:
        STATE.in_flight -= 1
        if os.environ.get("DEBUG_KEEP_WORKDIR", "0") != "1":
            shutil.rmtree(workdir, ignore_errors=True)


# ============ FastAPI ============

app = FastAPI(title="Mainfeed Swap Pod")


def require_auth(authorization: str) -> None:
    if not POD_SECRET:
        raise HTTPException(500, "pod misconfigured: SWAP_POD_SECRET not set")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Bearer token required")
    if authorization[7:].strip() != POD_SECRET:
        raise HTTPException(401, "invalid token")


@app.on_event("startup")
async def on_startup() -> None:
    print("[swap_server] starting up...", flush=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ensure_weights()

    # R2 client is OPTIONAL now — only used by ensure_weights() for the fast
    # boot path. Output uploads go through the worker proxy (no creds needed
    # on the pod). If R2 creds aren't set, ensure_weights already fell back
    # to HuggingFace above and STATE.r2 stays None.
    STATE.r2 = build_r2_client()
    if STATE.r2:
        try:
            STATE.r2.head_bucket(Bucket=R2_BUCKET)
            print(f"[swap_server] R2 weights-mirror OK (bucket={R2_BUCKET})", flush=True)
        except Exception as e:
            print(f"[swap_server] R2 head_bucket failed (weights came from HF fallback): {e}", flush=True)
            STATE.r2 = None
    else:
        print("[swap_server] R2 client disabled (no creds set) — output uploads go via worker proxy", flush=True)

    # Verify worker upload endpoint reachable + auth works (cheap GET on the
    # base origin's /api/swap/complete? No — that needs a body. Skip preflight,
    # let first swap fail loudly if misconfigured).
    print(f"[swap_server] worker upload URL: {WORKER_UPLOAD_URL}", flush=True)

    # Load DreamID-V once into GPU memory. Replaces the previous
    # subprocess-per-swap behavior — saves ~10-15s of cold-start per request
    # and lets future torch.compile/TRT optimizations cache across swaps.
    print("[swap_server] loading DreamID-V pipeline (one-time)...", flush=True)
    load_started = time.time()
    await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: dreamidv_runtime.init(
            weights_dir=str(WEIGHTS_DIR),
            dreamidv_dir=str(DREAMIDV_DIR),
        ),
    )
    print(f"[swap_server] DreamID-V loaded in {round(time.time() - load_started, 1)}s", flush=True)

    STATE.model_loaded = True
    print(f"[swap_server] ready on port {PORT}", flush=True)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": STATE.model_loaded,
        "model_loaded": STATE.model_loaded,
        "in_flight": STATE.in_flight,
        "completed": STATE.total_completed,
        "failed": STATE.total_failed,
        "uptime_sec": round(time.time() - STATE.started_at, 2),
        "last_error": STATE.last_error,
    }


@app.get("/metrics")
async def metrics() -> dict:
    return await health()


@app.post("/swap", status_code=202)
async def swap(req: SwapRequest, background: BackgroundTasks,
               authorization: str = Header(default="")) -> dict:
    require_auth(authorization)
    if not STATE.model_loaded:
        raise HTTPException(503, "model not loaded yet, try again in 30s")
    STATE.in_flight += 1
    background.add_task(run_swap, req)
    return {
        "request_id": req.request_id,
        "status": "processing",
        "in_flight": STATE.in_flight,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

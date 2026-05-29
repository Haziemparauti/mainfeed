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

import httpx
import uvicorn
from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

from render_overlay import brand_video, brand_image


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

# Flux + PuLID paths (for the cosplay-image 10/day quota — separate code path
# from DreamID-V video swaps). See [[mainfeed_image_library_architecture]].
#
# All Flux+PuLID weights live under a single canonical dir which the runtime
# symlinks to PULID_DIR/models/ — PuLID's pipeline_flux.py uses RELATIVE paths
# like 'models/antelopev2/...' and 'models/pulid_flux_*.safetensors', and the
# symlink keeps both the HF auto-downloads AND our pre-staged R2 mirror in the
# same canonical location. See pod/flux_pulid_runtime.py for the chdir dance.
FLUX_PULID_DIR = WEIGHTS_DIR / "flux_pulid"
FLUX_CKPT = FLUX_PULID_DIR / "flux1-schnell.safetensors"
AE_CKPT = FLUX_PULID_DIR / "ae.safetensors"
PULID_FLUX_VERSION = os.environ.get("PULID_FLUX_VERSION", "v0.9.1")
PULID_CKPT = FLUX_PULID_DIR / f"pulid_flux_{PULID_FLUX_VERSION}.safetensors"
ANTELOPEV2_DIR = FLUX_PULID_DIR / "antelopev2"
PULID_DIR = Path(os.environ.get("PULID_DIR", "/root/pulid"))

# R2-related env (NO credentials — pod never holds R2 keys per
# [[feedback_no_secrets_on_pod]]). Only the destination prefix names remain,
# and they're paths/strings — the actual R2 reads/writes go through the
# worker's env.CONTENT binding via the proxy endpoints below.
R2_BUCKET = os.environ.get("R2_BUCKET", "mainfeed-content")
R2_OUTPUT_PREFIX = os.environ.get("R2_OUTPUT_PREFIX", "generated/").rstrip("/") + "/"
R2_WEIGHTS_PREFIX = os.environ.get("R2_WEIGHTS_PREFIX", "models/").rstrip("/") + "/"

# Weight read fast-path: when set, ensure_weights() fetches each manifest
# entry from the worker's /api/pod/weight proxy instead of HuggingFace.
# Worker auths via SWAP_POD_SECRET (already in pod env), so no R2 keys are
# ever needed here. Same idea as the upload-via-worker pattern.
HARDEN_WEIGHTS_R2 = os.environ.get("HARDEN_WEIGHTS_R2", "0") == "1"
WORKER_WEIGHT_URL = os.environ.get(
    "WORKER_WEIGHT_URL",
    "https://api.mainfeed.app/api/pod/weight",
)


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


STATE = State()


# build_r2_client deleted 2026-05-27: pod no longer holds R2 credentials.
# Both reads (weights) and writes (outputs) go through worker proxy endpoints
# (Bearer-authed via SWAP_POD_SECRET). See [[feedback_no_secrets_on_pod]].


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
    # Watermark "context bug" inputs: handle → mainfeed.app/@handle, arc_name →
    # the share-name on the bug (e.g. "LOST"), day → DAY N. If handle is null
    # the burn-in is a no-op and the raw swap output is uploaded.
    # NOTE: `caption` (the monologue) is NO LONGER burned in — it ships to the
    # feed as in-app text. Kept here (optional, ignored) only for back-compat.
    caption: Optional[str] = None
    handle: Optional[str] = None
    arc_name: Optional[str] = None
    day: Optional[int] = None


class ImageRequest(BaseModel):
    """Request schema for the Flux+PuLID cosplay-image path (10/day quota).
    Different format than SwapRequest — no target video, no caption (images
    are watermark-only), 1:1 square output. See [[mainfeed_image_library_architecture]].
    """
    request_id: str = Field(..., min_length=1, max_length=128)
    source_image_url: str            # user's selfie (HTTPS, fetched by pod)
    prompt: str = Field(..., min_length=1, max_length=2000)
    callback_url: str
    # R2 key under R2_BUCKET where the output JPEG should land (e.g.
    # "generated/u/<user_id>/<piece_id>.jpg"). If null, defaults to
    # f"{R2_OUTPUT_PREFIX}{request_id}.jpg".
    output_r2_key: Optional[str] = None
    # Per [[mainfeed_image_library_architecture]] the format spec is locked
    # to 1024x1024. Allow overrides for one-off experiments but default tight.
    width: int = 1024
    height: int = 1024
    num_steps: int = 4              # Flux.1-schnell turbo default
    guidance: float = 4.0
    id_weight: float = 1.0          # PuLID identity injection strength
    start_step: int = 0             # 0 = inject ID from first denoise step
    base_seed: int = 42
    # Watermark "context bug" inputs (handle → mainfeed.app/@handle, arc_name →
    # share-name e.g. "LOST", day → DAY N). If handle is null the raw Flux
    # output is uploaded (no watermark).
    handle: Optional[str] = None
    arc_name: Optional[str] = None
    day: Optional[int] = None
    # 24 GB cards (3090, 4090) can't hold the 24 GB Flux model + ~2 GB
    # workspace at once — set aggressive_offload=true to shuttle Flux
    # transformer blocks CPU↔GPU one-at-a-time during denoise. Slower
    # (~5-10x per step) but only path that fits. 48 GB cards (A40, A6000)
    # leave this false.
    aggressive_offload: bool = False


# ============ weight download (HF) ============

# Weight manifest — used by both R2 and HF paths.
# Each entry: (local_path, r2_key, hf_repo_or_None, hf_filename_or_None)
# Filtered at runtime so DREAMIDV_ENABLED=0 pods don't waste cold-boot time
# downloading 17 GB of DreamID-V/Wan-2.1 weights they'll never use, and
# FLUX_PULID_ENABLED=0 pods skip the 26 GB Flux weight set.
def _weight_manifest():
    dreamidv_on = os.environ.get("DREAMIDV_ENABLED", "1") == "1"
    flux_on     = os.environ.get("FLUX_PULID_ENABLED", "1") == "1"

    entries = []
    if dreamidv_on:
        entries.extend([
            # === DreamID-V (video swap engine) ===
            (DREAMIDV_FASTER_CKPT,
             f"{R2_WEIGHTS_PREFIX}dreamidv_faster.pth",
             "XuGuo699/DreamID-V", "dreamidv_faster.pth"),
            (DWPOSE_DIR / "dw-ll_ucoco_384.onnx",
             f"{R2_WEIGHTS_PREFIX}dwpose/dw-ll_ucoco_384.onnx",
             "XuGuo699/DreamID-V", "dw-ll_ucoco_384.onnx"),
            (DWPOSE_DIR / "yolox_l.onnx",
             f"{R2_WEIGHTS_PREFIX}dwpose/yolox_l.onnx",
             "XuGuo699/DreamID-V", "yolox_l.onnx"),
            # === Wan-2.1 (base diffusion model for DreamID-V) ===
            # Pulled as a snapshot_download bundle (hf_repo=None signals bundle).
            (WAN21_DIR / "Wan2.1_VAE.pth",
             f"{R2_WEIGHTS_PREFIX}wan2.1/Wan2.1_VAE.pth",
             None, None),
            (WAN21_DIR / "models_t5_umt5-xxl-enc-bf16.pth",
             f"{R2_WEIGHTS_PREFIX}wan2.1/models_t5_umt5-xxl-enc-bf16.pth",
             None, None),
            (WAN21_DIR / "diffusion_pytorch_model.safetensors",
             f"{R2_WEIGHTS_PREFIX}wan2.1/diffusion_pytorch_model.safetensors",
             None, None),
        ])

    if flux_on:
        entries.extend(_flux_pulid_manifest_entries())
    return entries


def _flux_pulid_manifest_entries():
    return [
        # === Flux.1-schnell base model (~24 GB) ===
        # Apache 2.0. Single safetensors file (NOT diffusers-format bundle —
        # PuLID's flux/util.py uses its own custom loader, not FluxPipeline).
        # Used by pod/flux_pulid_runtime.py for the 10/day cosplay-image quota.
        (FLUX_CKPT,
         f"{R2_WEIGHTS_PREFIX}flux_pulid/flux1-schnell.safetensors",
         "black-forest-labs/FLUX.1-schnell", "flux1-schnell.safetensors"),
        # === Flux autoencoder (~335 MB) ===
        # Companion VAE for the Flux base. Same repo, different file.
        (AE_CKPT,
         f"{R2_WEIGHTS_PREFIX}flux_pulid/ae.safetensors",
         "black-forest-labs/FLUX.1-schnell", "ae.safetensors"),
        # === PuLID-FLUX adapter (~700 MB) ===
        # Identity-injection cross-attention weights for Flux. License Apache 2.0
        # (verified 2026-05-27, both PuLID source + weights).
        (PULID_CKPT,
         f"{R2_WEIGHTS_PREFIX}flux_pulid/pulid_flux_{PULID_FLUX_VERSION}.safetensors",
         "guozinan/PuLID", f"pulid_flux_{PULID_FLUX_VERSION}.safetensors"),
        # === InsightFace antelopev2 (face detection + embedding for PuLID) ===
        # PuLID uses antelopev2 to extract the identity embedding from the
        # user's selfie. Sourced from DIAMONIK7777/antelopev2 (the PuLID-
        # canonical mirror — same SHAs as PuLID's own snapshot_download call,
        # so pre-staging here makes that call a no-op at runtime).
        (ANTELOPEV2_DIR / "1k3d68.onnx",
         f"{R2_WEIGHTS_PREFIX}flux_pulid/antelopev2/1k3d68.onnx",
         "DIAMONIK7777/antelopev2", "1k3d68.onnx"),
        (ANTELOPEV2_DIR / "2d106det.onnx",
         f"{R2_WEIGHTS_PREFIX}flux_pulid/antelopev2/2d106det.onnx",
         "DIAMONIK7777/antelopev2", "2d106det.onnx"),
        (ANTELOPEV2_DIR / "genderage.onnx",
         f"{R2_WEIGHTS_PREFIX}flux_pulid/antelopev2/genderage.onnx",
         "DIAMONIK7777/antelopev2", "genderage.onnx"),
        (ANTELOPEV2_DIR / "glintr100.onnx",
         f"{R2_WEIGHTS_PREFIX}flux_pulid/antelopev2/glintr100.onnx",
         "DIAMONIK7777/antelopev2", "glintr100.onnx"),
        (ANTELOPEV2_DIR / "scrfd_10g_bnkps.onnx",
         f"{R2_WEIGHTS_PREFIX}flux_pulid/antelopev2/scrfd_10g_bnkps.onnx",
         "DIAMONIK7777/antelopev2", "scrfd_10g_bnkps.onnx"),
    ]


def _exists_and_nonempty(p: Path, min_bytes: int = 1_000_000) -> bool:
    try:
        return p.exists() and p.stat().st_size >= min_bytes
    except OSError:
        return False


def _worker_weight_download(r2_key: str, dst: Path, timeout: float = 1800.0) -> None:
    """GET an R2 weight file via the worker proxy and stream it to `dst`.

    Worker enforces:
      - key prefix = "models/" (no access outside the mirror)
      - SWAP_POD_SECRET bearer auth (same secret the pod uses to /swap/upload)

    Stream-through: the worker doesn't buffer the body, and we don't buffer
    either — chunks written to disk as they arrive. For 24 GB flux1-schnell.safetensors
    this is the only viable path inside a Worker pipe.
    """
    if not POD_SECRET:
        raise RuntimeError("SWAP_POD_SECRET not set; cannot authenticate to worker for weight fetch")
    import httpx as _httpx_sync   # local import to avoid bumping module deps
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")
    headers = {"Authorization": f"Bearer {POD_SECRET}"}
    params = {"key": r2_key}
    with _httpx_sync.stream(
        "GET", WORKER_WEIGHT_URL, headers=headers, params=params,
        timeout=timeout, follow_redirects=True,
    ) as resp:
        if resp.status_code != 200:
            try:
                body = resp.read().decode("utf-8", "replace")[:400]
            except Exception:
                body = ""
            raise RuntimeError(f"worker /api/pod/weight {resp.status_code}: {body}")
        with open(tmp, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=1 << 20):  # 1 MB chunks
                f.write(chunk)
    os.replace(tmp, dst)


def ensure_weights() -> None:
    """Materialize all required weight files under WEIGHTS_DIR + DREAMIDV_DIR/pose/models.

    Source selection:
      - HARDEN_WEIGHTS_R2=1  →  pull from R2 mirror via worker proxy
                                (worker uses env.CONTENT binding — pod never holds R2 creds)
      - otherwise            →  pull from HuggingFace
    """
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    WAN21_DIR.mkdir(parents=True, exist_ok=True)
    DWPOSE_DIR.mkdir(parents=True, exist_ok=True)
    FLUX_PULID_DIR.mkdir(parents=True, exist_ok=True)
    ANTELOPEV2_DIR.mkdir(parents=True, exist_ok=True)

    manifest = _weight_manifest()
    missing = [m for m in manifest if not _exists_and_nonempty(m[0])]
    if not missing:
        print("[ensure_weights] all weights present", flush=True)
        return

    if HARDEN_WEIGHTS_R2:
        print(f"[ensure_weights] worker proxy — fetching {len(missing)} files via "
              f"{WORKER_WEIGHT_URL} (no R2 creds on pod)", flush=True)
        for local, r2_key, _, _ in missing:
            print(f"  GET {r2_key}", flush=True)
            t = time.time()
            _worker_weight_download(r2_key, local)
            sz = local.stat().st_size
            el = time.time() - t
            print(f"      ok {sz/1e6:.0f} MB in {el:.1f}s ({(sz/1e6)/max(el,0.001):.0f} MB/s)", flush=True)
        print("[ensure_weights] all weights present (from R2 via worker)", flush=True)
        return

    # Fallback / default: HuggingFace
    from huggingface_hub import hf_hub_download, snapshot_download
    print(f"[ensure_weights] HuggingFace — fetching {len(missing)} files "
          "(set HARDEN_WEIGHTS_R2=1 to use the worker-proxy R2 mirror fast-path)", flush=True)

    # Individual hf_hub_downloads for files with explicit hf_repo.
    # hf_repo=None signals a snapshot_download bundle (currently only Wan-2.1).
    for local, _, hf_repo, hf_filename in missing:
        if hf_repo and not _exists_and_nonempty(local):
            print(f"  hf_hub_download {hf_repo}:{hf_filename}", flush=True)
            hf_hub_download(
                repo_id=hf_repo, filename=hf_filename,
                local_dir=str(local.parent), token=HF_TOKEN,
            )

    # Wan-2.1 bundle via snapshot_download (only if any wan2.1 file is still missing).
    # hf_repo=None marks Wan-2.1 entries.
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

# flux_pulid_runtime is the parallel module for the 10/day cosplay-image
# quota (Flux.1-schnell + PuLID-FLUX). Same warm-pipeline pattern as
# dreamidv_runtime — loaded once at startup, generate_image() per /image call.
# Both pipelines share the GPU, serialized through STATE.gpu_lock.
import flux_pulid_runtime


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


async def run_flux_pulid(workdir: Path, selfie: Path, prompt: str,
                         width: int, height: int, num_steps: int, guidance: float,
                         id_weight: float, start_step: int, seed: int,
                         aggressive_offload: bool) -> Path:
    """Run one image generation against the warm Flux+PuLID pipeline (in-process)."""
    if not flux_pulid_runtime.is_ready():
        raise RuntimeError("flux_pulid_runtime not initialized; call init() at startup")

    output = workdir / "output.jpg"
    print(f"[swap_server] running flux+pulid (warm) "
          f"{width}x{height} steps={num_steps} id_weight={id_weight} seed={seed} "
          f"agg_offload={aggressive_offload}", flush=True)
    started = time.time()
    await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: flux_pulid_runtime.generate_image(
            selfie_path=str(selfie),
            prompt=prompt,
            out_jpg=str(output),
            seed=seed,
            num_steps=num_steps,
            guidance=guidance,
            id_weight=id_weight,
            start_step=start_step,
            width=width,
            height=height,
            aggressive_offload=aggressive_offload,
        ),
    )
    elapsed = round(time.time() - started, 2)
    if not output.exists():
        raise RuntimeError(f"Flux+PuLID finished {elapsed}s but no output at {output}")
    print(f"[swap_server] Flux+PuLID finished in {elapsed}s, output {output.stat().st_size} bytes", flush=True)
    return output


async def run_image(req: ImageRequest) -> None:
    """Generate one cosplay image (Flux + PuLID). Parallel to run_swap()
    but for the 10/day image quota — see [[mainfeed_image_library_architecture]]."""
    workdir = OUTPUT_DIR / req.request_id
    workdir.mkdir(parents=True, exist_ok=True)
    selfie = workdir / "source.jpg"
    started = time.time()

    r2_key = req.output_r2_key or f"{R2_OUTPUT_PREFIX}{req.request_id}.jpg"

    try:
        await download_to(req.source_image_url, selfie)
        async with STATE.gpu_lock:
            output = await run_flux_pulid(
                workdir, selfie, req.prompt,
                req.width, req.height, req.num_steps, req.guidance,
                req.id_weight, req.start_step, req.base_seed,
                req.aggressive_offload,
            )

        # Watermark "context bug" is intentionally NOT burned here — the in-app
        # feed shows CLEAN images; the bug is applied only on download/share
        # (render_overlay.brand_image, via the download path). `output` is the
        # raw Flux render. content_type=image/jpeg drives the R2 object's MIME.
        r2_meta = await upload_via_worker(output, r2_key, "image/jpeg")
        print(f"[swap_server] {req.request_id} image → r2://{r2_meta['bucket']}/{r2_meta['key']} ({r2_meta['size']} bytes)", flush=True)

        elapsed = round(time.time() - started, 2)
        STATE.total_completed += 1
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "completed",
            "kind": "image",
            "elapsed_sec": elapsed,
            "output_bytes": output.stat().st_size if output.exists() else 0,
            "r2_bucket": (r2_meta or {}).get("bucket"),
            "r2_key":    (r2_meta or {}).get("key"),
        })
        print(f"[swap_server] {req.request_id} image OK in {elapsed}s", flush=True)
    except Exception as e:
        STATE.total_failed += 1
        msg = str(e)[:1500]
        print(f"[swap_server] {req.request_id} image FAILED: {msg}", flush=True)
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "failed",
            "kind": "image",
            "error": msg,
        })
    finally:
        STATE.in_flight -= 1
        if os.environ.get("DEBUG_KEEP_WORKDIR", "0") != "1":
            shutil.rmtree(workdir, ignore_errors=True)


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
        # DWPose cache: if the caller passes precomputed pose+mask URLs, drop
        # them exactly where dreamidv_runtime.run_swap looks
        # (workdir/temp_generated/{base}_pose.mp4 + {base}_mask.mp4) so it SKIPS
        # the ~30s inline DWPose pass. The pose+mask are computed ONCE per stock
        # clip at library time and cached in R2, then reused on every user's
        # swap of that clip. Quality-identical — the mask is the same whether
        # computed inline now or precomputed earlier; this only removes
        # redundant recomputation. If either URL is absent, run_swap falls back
        # to computing DWPose inline (unchanged behavior).
        if req.target_pose_url and req.target_mask_url:
            base = ref_video.stem  # "target" → matches dreamidv_runtime's video_base
            temp_dir = workdir / "temp_generated"
            await download_to(req.target_pose_url, temp_dir / f"{base}_pose.mp4")
            await download_to(req.target_mask_url, temp_dir / f"{base}_mask.mp4")
            print(f"[swap_server] {req.request_id} DWPose cache HIT — downloaded "
                  f"precomputed pose+mask, skipping inline DWPose (~30s saved)", flush=True)
        async with STATE.gpu_lock:
            output = await run_dreamidv(
                workdir, src_image, ref_video,
                req.sample_steps, req.sample_guide_scale_img,
                req.size, req.base_seed, req.frame_num,
            )

        # The watermark "context bug" is intentionally NOT burned here. The
        # in-app feed shows CLEAN media; the bug is applied ONLY when a piece is
        # downloaded/shared (render_overlay.brand_video, invoked by the download
        # path) — keeping the in-app experience watermark-free. `output` is the
        # raw swap. Pod never holds R2 creds — worker writes on its behalf.
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

    # Pod no longer holds an R2 client. Both reads (weights) and writes
    # (outputs) route through the worker proxy, authed via SWAP_POD_SECRET.
    print(f"[swap_server] worker upload URL: {WORKER_UPLOAD_URL}", flush=True)
    print(f"[swap_server] worker weight URL: {WORKER_WEIGHT_URL}", flush=True)

    # Load Flux + PuLID FIRST. flux_pulid_runtime.init() chdir's temporarily
    # into PULID_DIR to satisfy PuLID's relative-path constructors, then
    # restores cwd before returning. dreamidv_runtime.init() below does its
    # own permanent chdir(DREAMIDV_DIR) — order matters: PuLID first so it
    # can restore cwd cleanly, DreamID-V second so its chdir is the final
    # state (per-request DWPose paths are joined against the ref_video dir,
    # not cwd, but DreamID-V's internal model loaders use a relative
    # 'dreamidv_wan_faster/context.pth' resolved at init time only).
    if os.environ.get("FLUX_PULID_ENABLED", "1") == "1":
        print("[swap_server] loading Flux + PuLID pipeline (one-time)...", flush=True)
        load_started = time.time()
        try:
            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: flux_pulid_runtime.init(
                    weights_dir=str(WEIGHTS_DIR),
                    pulid_dir=str(PULID_DIR),
                ),
            )
            print(f"[swap_server] Flux + PuLID loaded in {round(time.time() - load_started, 1)}s", flush=True)
        except Exception as e:
            # Non-fatal: pod can still serve /swap (videos) even if Flux+PuLID
            # fails to load. /image will return 503 until it's fixed.
            STATE.last_error = f"flux_pulid init failed: {str(e)[:500]}"
            print(f"[swap_server] WARN Flux+PuLID init FAILED — /image disabled: {e}", flush=True)
    else:
        print("[swap_server] FLUX_PULID_ENABLED=0 — skipping Flux+PuLID load (image endpoint disabled)", flush=True)

    # Load DreamID-V once into GPU memory. Replaces the previous
    # subprocess-per-swap behavior — saves ~10-15s of cold-start per request
    # and lets future torch.compile/TRT optimizations cache across swaps.
    # Gated behind DREAMIDV_ENABLED=1 so image-only test pods on tight-VRAM
    # cards (e.g. 4090 24 GB) can boot Flux+PuLID without DreamID-V's ~17 GB
    # eating into the headroom Flux needs during denoise.
    if os.environ.get("DREAMIDV_ENABLED", "1") == "1":
        print("[swap_server] loading DreamID-V pipeline (one-time)...", flush=True)
        load_started = time.time()
        try:
            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: dreamidv_runtime.init(
                    weights_dir=str(WEIGHTS_DIR),
                    dreamidv_dir=str(DREAMIDV_DIR),
                ),
            )
            print(f"[swap_server] DreamID-V loaded in {round(time.time() - load_started, 1)}s", flush=True)
        except Exception as e:
            # Non-fatal — pod can still serve /image (Flux+PuLID) even when
            # DreamID-V fails to load. Common cause: insufficient VRAM (24 GB
            # cards can't host Flux + DreamID-V concurrently). /swap returns
            # 503 in that case (see guard in the /swap endpoint).
            STATE.last_error = f"dreamidv init failed: {str(e)[:500]}"
            print(f"[swap_server] WARN DreamID-V init FAILED — /swap disabled, /image still works: {e}", flush=True)
    else:
        print("[swap_server] DREAMIDV_ENABLED=0 — skipping DreamID-V load (swap endpoint disabled)", flush=True)

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
    if not dreamidv_runtime.is_ready():
        raise HTTPException(503, "dreamidv not loaded (check DREAMIDV_ENABLED env); /image remains available")
    STATE.in_flight += 1
    background.add_task(run_swap, req)
    return {
        "request_id": req.request_id,
        "status": "processing",
        "in_flight": STATE.in_flight,
    }


@app.post("/image", status_code=202)
async def image(req: ImageRequest, background: BackgroundTasks,
                authorization: str = Header(default="")) -> dict:
    """Queue one Flux+PuLID cosplay-image generation. Async — returns 202
    immediately and posts to req.callback_url when done. See
    [[mainfeed_image_library_architecture]] for the format spec."""
    require_auth(authorization)
    if not STATE.model_loaded:
        raise HTTPException(503, "model not loaded yet, try again in 30s")
    if not flux_pulid_runtime.is_ready():
        raise HTTPException(503, "flux+pulid not loaded (check startup logs); /swap remains available")
    STATE.in_flight += 1
    background.add_task(run_image, req)
    return {
        "request_id": req.request_id,
        "status": "processing",
        "in_flight": STATE.in_flight,
        "kind": "image",
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

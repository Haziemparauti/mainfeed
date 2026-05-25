#!/usr/bin/env python3
"""
Mainfeed swap pod — REST server.

Long-running process. Loads DreamID-V faster + DWPose once at startup, keeps them
on GPU, serves POST /swap requests. Single-GPU, single-worker (DreamID-V is not
thread-safe), serialized via asyncio.Lock.

Endpoints:
  POST /swap       — queue a swap job (returns 202 immediately, callbacks on done)
  GET  /health     — liveness + model-loaded probe
  GET  /metrics    — basic counters

Request shape (POST /swap, JSON):
  {
    "request_id":         "unique-string",
    "source_image_url":   "https://.../selfie.jpg",
    "target_video_url":   "https://.../stock/cop_s07_coffee_plaza_f.mp4",
    "target_pose_url":    null | "https://.../stock/cop_s07_coffee_plaza_f_pose.mp4",
    "target_mask_url":    null | "https://.../stock/cop_s07_coffee_plaza_f_mask.mp4",
    "callback_url":       "https://api.mainfeed.app/api/swap/complete",
    "output_upload_url":  "https://r2.../signed-put-url-for-output.mp4",
    "sample_steps":       16,
    "sample_guide_scale_img": 4.0,
    "size":               "832x480"
  }

If target_pose_url + target_mask_url are missing, the pod computes DWPose on-the-fly
(~5–10 min extra). Production library prep precomputes pose+mask per stock clip,
so production calls always pass the URLs and the pod skips that work.

Auth: every protected endpoint requires `Authorization: Bearer $SWAP_POD_SECRET`.

Environment:
  SWAP_POD_SECRET   — shared with the Cloudflare Worker; required.
  WEIGHTS_DIR       — where to cache model weights. Default /workspace/ckpts.
  DREAMIDV_DIR      — where the DreamID-V repo is cloned. Default /root/dreamidv.
  OUTPUT_DIR        — temp dir for per-request workdirs. Default /workspace/tmp.
  PORT              — bind port. Default 8000.
  HARDEN_WEIGHTS_R2 — if "1", download weights from R2_PUBLIC_PREFIX instead of HuggingFace.
  R2_PUBLIC_PREFIX  — e.g. https://mainfeed-content.r2.cloudflarestorage.com/models.
"""

from __future__ import annotations
import asyncio
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field


# ============ config ============

POD_SECRET = os.environ.get("SWAP_POD_SECRET", "")
WEIGHTS_DIR = Path(os.environ.get("WEIGHTS_DIR", "/workspace/ckpts"))
DREAMIDV_DIR = Path(os.environ.get("DREAMIDV_DIR", "/root/dreamidv"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/workspace/tmp"))
HARDEN_R2 = os.environ.get("HARDEN_WEIGHTS_R2", "0") == "1"
R2_PUBLIC_PREFIX = os.environ.get("R2_PUBLIC_PREFIX", "")
PORT = int(os.environ.get("PORT", "8000"))

# === Weight manifest ===
# Each entry: (local_relative_path, huggingface_repo, huggingface_file)
# At startup, if HARDEN_R2=1 the URLs are replaced with $R2_PUBLIC_PREFIX/<filename>.
WEIGHTS = [
    ("dreamidv/dreamidv_faster.pth",      "XuGuo699/DreamID-V",     "dreamidv_faster.pth"),
    ("wan2.1/Wan2.1_VAE.pth",             "Wan-AI/Wan2.1-T2V-1.3B", "Wan2.1_VAE.pth"),
    ("wan2.1/models_t5_umt5-xxl-enc-bf16.pth",
                                          "Wan-AI/Wan2.1-T2V-1.3B", "models_t5_umt5-xxl-enc-bf16.pth"),
    ("wan2.1/diffusion_pytorch_model.safetensors",
                                          "Wan-AI/Wan2.1-T2V-1.3B", "diffusion_pytorch_model.safetensors"),
    ("wan2.1/config.json",                "Wan-AI/Wan2.1-T2V-1.3B", "config.json"),
    ("dwpose/dw-ll_ucoco_384.onnx",       "yzd-v/DWPose",           "dw-ll_ucoco_384.onnx"),
    ("dwpose/yolox_l.onnx",               "yzd-v/DWPose",           "yolox_l.onnx"),
]


# ============ state ============

class State:
    def __init__(self) -> None:
        self.model_loaded = False
        self.started_at = time.time()
        self.gpu_lock = asyncio.Lock()
        self.in_flight = 0
        self.total_completed = 0
        self.total_failed = 0


STATE = State()


# ============ API models ============

class SwapRequest(BaseModel):
    request_id: str = Field(..., min_length=1, max_length=128)
    source_image_url: str
    target_video_url: str
    target_pose_url: Optional[str] = None
    target_mask_url: Optional[str] = None
    callback_url: str
    output_upload_url: Optional[str] = None
    sample_steps: int = 16
    sample_guide_scale_img: float = 4.0
    size: str = "832x480"


# ============ helpers ============

def hf_url(repo: str, filename: str) -> str:
    return f"https://huggingface.co/{repo}/resolve/main/{filename}"


def r2_url(filename: str) -> str:
    if not R2_PUBLIC_PREFIX:
        raise RuntimeError("HARDEN_WEIGHTS_R2=1 but R2_PUBLIC_PREFIX not set")
    return f"{R2_PUBLIC_PREFIX.rstrip('/')}/{Path(filename).name}"


def ensure_weights() -> None:
    """Download model weights at startup if not present locally."""
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    for rel_path, hf_repo, hf_file in WEIGHTS:
        local = WEIGHTS_DIR / rel_path
        if local.exists() and local.stat().st_size > 1024:
            continue
        local.parent.mkdir(parents=True, exist_ok=True)
        url = r2_url(hf_file) if HARDEN_R2 else hf_url(hf_repo, hf_file)
        print(f"[swap_server] downloading {rel_path}  ({url})", flush=True)
        rc = subprocess.run(
            ["wget", "-q", "--show-progress", url, "-O", str(local)],
            check=False,
        ).returncode
        if rc != 0 or local.stat().st_size < 1024:
            raise RuntimeError(f"failed to download {rel_path} from {url}")


def load_model() -> None:
    """Verify DreamID-V CLI is importable. Heavy lifting happens at first invocation;
    keeping the process warm + reusing the python interpreter is what saves the
    30-sec model load on subsequent swaps. For now we keep this lightweight and
    rely on subprocess invocation per swap; a future optimization is to import
    generate_dreamidv_faster as a module and hold the model in-process."""
    script = DREAMIDV_DIR / "generate_dreamidv_faster.py"
    if not script.exists():
        raise RuntimeError(f"DreamID-V script not found at {script}")
    STATE.model_loaded = True


async def download_to(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300.0) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=1 << 16):
                    f.write(chunk)


async def upload_to(url: str, src: Path, content_type: str = "video/mp4") -> None:
    async with httpx.AsyncClient(timeout=600.0) as client:
        with open(src, "rb") as f:
            resp = await client.put(url, content=f.read(),
                                    headers={"Content-Type": content_type})
            resp.raise_for_status()


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


# ============ inference ============

async def run_dreamidv(workdir: Path, src_image: Path, ref_video: Path,
                       pose_video: Optional[Path], mask_video: Optional[Path],
                       sample_steps: int, sample_guide_scale_img: float, size: str
                       ) -> Path:
    """Invoke generate_dreamidv_faster.py with the validated argset."""
    output = workdir / "output.mp4"
    cmd = [
        sys.executable,
        str(DREAMIDV_DIR / "generate_dreamidv_faster.py"),
        "--src_image", str(src_image),
        "--ref_video", str(ref_video),
        "--save_path", str(output),
        "--sample_steps", str(sample_steps),
        "--sample_guide_scale_img", str(sample_guide_scale_img),
        "--size", size,
        # checkpoints
        "--dit_checkpoint",  str(WEIGHTS_DIR / "dreamidv" / "dreamidv_faster.pth"),
        "--wan_checkpoint_dir", str(WEIGHTS_DIR / "wan2.1"),
        "--pose_model",      str(WEIGHTS_DIR / "dwpose" / "dw-ll_ucoco_384.onnx"),
        "--yolox_model",     str(WEIGHTS_DIR / "dwpose" / "yolox_l.onnx"),
    ]
    if pose_video and pose_video.exists():
        cmd.extend(["--ref_pose_video", str(pose_video)])
    if mask_video and mask_video.exists():
        cmd.extend(["--ref_mask_video", str(mask_video)])
    print(f"[swap_server] running: {' '.join(cmd)}", flush=True)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(DREAMIDV_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    log = stdout.decode("utf-8", errors="ignore") if stdout else ""
    if proc.returncode != 0:
        raise RuntimeError(f"DreamID-V failed (rc={proc.returncode}):\n{log[-2000:]}")
    if not output.exists():
        raise RuntimeError(f"DreamID-V exited 0 but no output at {output}:\n{log[-2000:]}")
    return output


async def run_swap(req: SwapRequest) -> None:
    workdir = OUTPUT_DIR / req.request_id
    workdir.mkdir(parents=True, exist_ok=True)
    src_image = workdir / "source.jpg"
    ref_video = workdir / "target.mp4"
    pose_video = workdir / "pose.mp4" if req.target_pose_url else None
    mask_video = workdir / "mask.mp4" if req.target_mask_url else None
    started = time.time()
    try:
        await download_to(req.source_image_url, src_image)
        await download_to(req.target_video_url, ref_video)
        if req.target_pose_url:
            await download_to(req.target_pose_url, pose_video)  # type: ignore[arg-type]
        if req.target_mask_url:
            await download_to(req.target_mask_url, mask_video)  # type: ignore[arg-type]

        async with STATE.gpu_lock:
            output = await run_dreamidv(
                workdir, src_image, ref_video, pose_video, mask_video,
                req.sample_steps, req.sample_guide_scale_img, req.size,
            )

        if req.output_upload_url:
            await upload_to(req.output_upload_url, output)

        elapsed = round(time.time() - started, 2)
        STATE.total_completed += 1
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "completed",
            "elapsed_sec": elapsed,
            "output_uploaded": bool(req.output_upload_url),
        })
        print(f"[swap_server] {req.request_id} done in {elapsed}s", flush=True)
    except Exception as e:
        STATE.total_failed += 1
        print(f"[swap_server] {req.request_id} failed: {e}", flush=True)
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "failed",
            "error": str(e)[:1000],
        })
    finally:
        STATE.in_flight -= 1
        # Keep workdir for debugging if env DEBUG_KEEP_WORKDIR=1
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
    ensure_weights()
    load_model()
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

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
  SWAP_POD_SECRET    — shared bearer between worker and pod. Required.
  WEIGHTS_DIR        — root for cached weights. Default /workspace/ckpts.
  DREAMIDV_DIR       — DreamID-V repo checkout. Default /root/dreamidv.
  OUTPUT_DIR         — per-request workdir parent. Default /workspace/tmp.
  PORT               — bind port. Default 8000.
  HF_TOKEN           — optional, only if the HF repos require auth.
  DEBUG_KEEP_WORKDIR — "1" to retain workdirs after each swap (debugging).
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


# ============ config ============

POD_SECRET = os.environ.get("SWAP_POD_SECRET", "")
WEIGHTS_DIR = Path(os.environ.get("WEIGHTS_DIR", "/workspace/ckpts"))
DREAMIDV_DIR = Path(os.environ.get("DREAMIDV_DIR", "/root/dreamidv"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/workspace/tmp"))
PORT = int(os.environ.get("PORT", "8000"))
HF_TOKEN = os.environ.get("HF_TOKEN", "") or None

DREAMIDV_FASTER_CKPT = WEIGHTS_DIR / "dreamidv_faster.pth"
WAN21_DIR = WEIGHTS_DIR / "wan2.1"
DWPOSE_DIR = DREAMIDV_DIR / "pose" / "models"


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
    output_upload_url: Optional[str] = None
    sample_steps: int = 16
    sample_guide_scale_img: float = 4.0
    size: str = "832*480"   # DreamID-V uses asterisk-separated W*H
    base_seed: int = 42
    frame_num: Optional[int] = None  # default determined by DreamID-V if None


# ============ weight download (HF) ============

def ensure_weights() -> None:
    """Download missing weights into WEIGHTS_DIR + DREAMIDV_DIR/pose/models."""
    from huggingface_hub import hf_hub_download, snapshot_download

    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    WAN21_DIR.mkdir(parents=True, exist_ok=True)
    DWPOSE_DIR.mkdir(parents=True, exist_ok=True)

    # 1) DreamID-V faster checkpoint
    if not DREAMIDV_FASTER_CKPT.exists() or DREAMIDV_FASTER_CKPT.stat().st_size < 1_000_000:
        print("[ensure_weights] dreamidv_faster.pth", flush=True)
        hf_hub_download(
            repo_id="XuGuo699/DreamID-V",
            filename="dreamidv_faster.pth",
            local_dir=str(WEIGHTS_DIR),
            local_dir_use_symlinks=False,
            token=HF_TOKEN,
        )

    # 2) DWPose onnx models (placed inside repo dir, where DreamID-V looks)
    for fname in ("dw-ll_ucoco_384.onnx", "yolox_l.onnx"):
        dst = DWPOSE_DIR / fname
        if not dst.exists() or dst.stat().st_size < 1_000_000:
            print(f"[ensure_weights] {fname}", flush=True)
            hf_hub_download(
                repo_id="XuGuo699/DreamID-V",
                filename=fname,
                local_dir=str(DWPOSE_DIR),
                local_dir_use_symlinks=False,
                token=HF_TOKEN,
            )

    # 3) Wan-2.1-T2V-1.3B base model (the *.pth, *.safetensors, config.json + google/ tokenizer)
    sentinel = WAN21_DIR / "models_t5_umt5-xxl-enc-bf16.pth"
    if not sentinel.exists() or sentinel.stat().st_size < 1_000_000_000:
        print("[ensure_weights] Wan-2.1-T2V-1.3B (snapshot, only required files)", flush=True)
        snapshot_download(
            repo_id="Wan-AI/Wan2.1-T2V-1.3B",
            local_dir=str(WAN21_DIR),
            local_dir_use_symlinks=False,
            allow_patterns=[
                "*.pth",
                "*.safetensors",
                "config.json",
                "google/**",
            ],
            token=HF_TOKEN,
        )

    print("[ensure_weights] all weights present", flush=True)


# ============ helpers ============

async def download_to(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
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
                       sample_steps: int, sample_guide_scale_img: float,
                       size: str, base_seed: int, frame_num: Optional[int]) -> Path:
    """Invoke generate_dreamidv_faster.py with the validated argset."""
    output = workdir / "output.mp4"
    cmd = [
        sys.executable,
        str(DREAMIDV_DIR / "generate_dreamidv_faster.py"),
        "--task", "swapface",
        "--size", size,
        "--ckpt_dir", str(WAN21_DIR),
        "--dreamidv_ckpt", str(DREAMIDV_FASTER_CKPT),
        "--ref_image", str(src_image),
        "--ref_video", str(ref_video),
        "--save_file", str(output),
        "--sample_steps", str(sample_steps),
        "--sample_guide_scale_img", str(sample_guide_scale_img),
        "--base_seed", str(base_seed),
    ]
    if frame_num is not None:
        cmd.extend(["--frame_num", str(frame_num)])

    print(f"[swap_server] running: {' '.join(cmd)}", flush=True)
    started = time.time()
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(DREAMIDV_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    log = stdout.decode("utf-8", errors="ignore") if stdout else ""
    elapsed = round(time.time() - started, 2)
    if proc.returncode != 0:
        STATE.last_error = log[-2000:]
        raise RuntimeError(f"DreamID-V exited rc={proc.returncode} ({elapsed}s):\n{log[-2000:]}")
    if not output.exists():
        raise RuntimeError(f"DreamID-V exited 0 ({elapsed}s) but no output at {output}:\n{log[-2000:]}")
    print(f"[swap_server] DreamID-V finished in {elapsed}s, output {output.stat().st_size} bytes", flush=True)
    return output


async def run_swap(req: SwapRequest) -> None:
    workdir = OUTPUT_DIR / req.request_id
    workdir.mkdir(parents=True, exist_ok=True)
    src_image = workdir / "source.jpg"
    ref_video = workdir / "target.mp4"
    started = time.time()
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

        if req.output_upload_url:
            await upload_to(req.output_upload_url, output)

        elapsed = round(time.time() - started, 2)
        STATE.total_completed += 1
        await callback(req.callback_url, {
            "request_id": req.request_id,
            "status": "completed",
            "elapsed_sec": elapsed,
            "output_uploaded": bool(req.output_upload_url),
            "output_bytes": output.stat().st_size if output.exists() else 0,
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
    # Light sanity-check on the inference script — actual model load happens
    # in the subprocess on the first /swap call (warm cache afterwards).
    script = DREAMIDV_DIR / "generate_dreamidv_faster.py"
    if not script.exists():
        raise RuntimeError(f"DreamID-V script missing at {script}")
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

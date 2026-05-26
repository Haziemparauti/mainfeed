"""
In-process DreamID-V runtime wrapper.

Refactor of the per-swap subprocess (generate_dreamidv_faster.py CLI) into a
module that loads the DreamIDV pipeline ONCE at process startup and keeps it
warm in GPU memory for the lifetime of the swap_server.

Why: every swap used to spawn a fresh Python interpreter, re-import DreamID-V,
re-load 23 GB of weights from disk, run inference, then exit. That's ~10-15s
of overhead per swap (small) — but more importantly it kills any optimization
that relies on warm state (torch.compile cache, TRT compiled models, KV cache).

This module reproduces the exact behavior of generate_dreamidv_faster.py at
seed=42 so output is bit-for-bit identical (or visually identical at minimum,
allowing for CUDA atomic non-determinism between processes).

Usage:
    import dreamidv_runtime
    dreamidv_runtime.init(
        weights_dir="/workspace/ckpts",
        dreamidv_dir="/root/dreamidv",
    )
    # ... per swap ...
    dreamidv_runtime.run_swap(
        src_image="/path/to/source.jpg",
        ref_video="/path/to/target.mp4",
        out_mp4="/path/to/output.mp4",
        size="832*480",
        sample_steps=16,
        sample_guide_scale_img=4.0,
        frame_num=120,
        seed=42,
    )

Both `init()` and `run_swap()` are synchronous (single GPU = single worker —
serialize via swap_server's asyncio.Lock).
"""

from __future__ import annotations

import logging
import os
import sys
import warnings
from pathlib import Path
from typing import Optional

warnings.filterwarnings("ignore")


# ============ module-level state (set by init()) ============

_PIPELINE = None       # DreamIDV instance, loaded once
_WAN_CONFIGS = None    # dreamidv_wan_faster.configs.WAN_CONFIGS
_SIZE_CONFIGS = None   # dreamidv_wan_faster.configs.SIZE_CONFIGS
_CACHE_VIDEO = None    # dreamidv_wan_faster.utils.utils.cache_video
_PROCESS_DWPOSE = None # pose.extract.process_dwpose
_DEVICE = None         # int — torch device index (always 0 for single-GPU)
_INITIALIZED = False


def is_ready() -> bool:
    """True if init() has completed and the pipeline is warm."""
    return _INITIALIZED and _PIPELINE is not None


def init(weights_dir: str, dreamidv_dir: str, task: str = "swapface",
         device_id: int = 0) -> None:
    """
    Load DreamIDV pipeline once. Subsequent run_swap() calls reuse it.

    Args:
        weights_dir: directory containing wan2.1/ subdir with VAE + T5 + DiT ckpts.
            Also where dreamidv_faster.pth lives (resolved from `dreamidv_ckpt`).
        dreamidv_dir: path to the DreamID-V git checkout (we add it to sys.path
            so its `dreamidv_wan_faster` and `pose.extract` modules import).
        task: WAN config key. Always "swapface" for our pipeline.
        device_id: CUDA device index. 0 for single-GPU pods.
    """
    global _PIPELINE, _WAN_CONFIGS, _SIZE_CONFIGS, _CACHE_VIDEO, _PROCESS_DWPOSE, _DEVICE, _INITIALIZED

    if _INITIALIZED:
        logging.info("[dreamidv_runtime] already initialized; skipping reload")
        return

    dreamidv_dir = str(dreamidv_dir)
    if dreamidv_dir not in sys.path:
        sys.path.insert(0, dreamidv_dir)
    # pose/ is a sub-package shipped under the DreamID-V repo (NOT installed via pip)
    pose_dir = os.path.join(dreamidv_dir, "pose")
    if pose_dir not in sys.path:
        sys.path.append(pose_dir)

    # DreamID-V's internal code uses RELATIVE paths in a few places
    # (e.g. dreamidv_wan_faster/context.pth) that previously worked only
    # because the CLI was launched with cwd=DREAMIDV_DIR. Now that we
    # import it in-process from swap_server.py (cwd=/root), we chdir
    # explicitly so those paths still resolve. One-time, harmless.
    os.chdir(dreamidv_dir)
    logging.info(f"[dreamidv_runtime] chdir → {dreamidv_dir}")

    # Lazy-import here so the module can be imported in test contexts without
    # the DreamID-V tree being on disk yet.
    import dreamidv_wan_faster
    from dreamidv_wan_faster.configs import WAN_CONFIGS, SIZE_CONFIGS
    from dreamidv_wan_faster.utils.utils import cache_video
    from pose.extract import process_dwpose

    _WAN_CONFIGS = WAN_CONFIGS
    _SIZE_CONFIGS = SIZE_CONFIGS
    _CACHE_VIDEO = cache_video
    _PROCESS_DWPOSE = process_dwpose
    _DEVICE = device_id

    cfg = WAN_CONFIGS[task]
    dreamidv_ckpt = str(Path(weights_dir) / "dreamidv_faster.pth")
    ckpt_dir = str(Path(weights_dir) / "wan2.1")

    logging.info(f"[dreamidv_runtime] creating DreamIDV pipeline (cfg={task}, device={device_id})")
    logging.info(f"[dreamidv_runtime]   ckpt_dir       = {ckpt_dir}")
    logging.info(f"[dreamidv_runtime]   dreamidv_ckpt  = {dreamidv_ckpt}")

    _PIPELINE = dreamidv_wan_faster.DreamIDV(
        config=cfg,
        checkpoint_dir=ckpt_dir,
        dreamidv_ckpt=dreamidv_ckpt,
        device_id=device_id,
        rank=0,            # single-GPU → no distributed
        t5_fsdp=False,
        dit_fsdp=False,
        use_usp=False,
        t5_cpu=False,
    )
    _INITIALIZED = True
    logging.info("[dreamidv_runtime] pipeline loaded; ready for swaps")


def run_swap(src_image: str, ref_video: str, out_mp4: str,
             size: str = "832*480", sample_steps: int = 16,
             sample_guide_scale_img: float = 4.0, frame_num: int = 120,
             sample_fps: int = 24,
             sample_shift: float = 5.0, sample_solver: str = "unipc",
             seed: int = 42, offload_model: bool = True,
             task: str = "swapface") -> str:
    """
    Run one swap. Mirrors the behavior of generate_dreamidv_faster.py CLI
    exactly so output matches at the same seed.

    Steps:
      1. Run DWPose on ref_video to produce *_pose.mp4 + *_mask.mp4
         (skipped if cached files already exist next to ref_video).
      2. Call pipeline.generate(...) with warm model.
      3. cache_video(...) to write the output mp4.

    Args mirror the CLI args of generate_dreamidv_faster.py.

    Returns:
        Path to the output mp4 on disk.
    """
    if not _INITIALIZED:
        raise RuntimeError("dreamidv_runtime.init() must be called before run_swap()")

    cfg = _WAN_CONFIGS[task]

    # === DWPose preprocessing (matches generate_dreamidv_faster.py lines 270-289) ===
    ref_dir = os.path.dirname(ref_video) or "."
    temp_dir = os.path.join(ref_dir, "temp_generated")
    video_base = os.path.basename(ref_video).split(".")[0]
    final_pose_path = os.path.join(temp_dir, video_base + "_pose.mp4")
    final_mask_path = os.path.join(temp_dir, video_base + "_mask.mp4")

    if not (os.path.exists(final_pose_path) and os.path.exists(final_mask_path)):
        os.makedirs(temp_dir, exist_ok=True)
        try:
            _PROCESS_DWPOSE(ref_video, final_pose_path, final_mask_path)
            logging.info(f"[dreamidv_runtime] DWPose: {final_pose_path}")
        except Exception as e:
            logging.error(f"[dreamidv_runtime] DWPose failed: {e}")
            raise
    else:
        logging.info(f"[dreamidv_runtime] DWPose cached, skipping: {final_mask_path}")

    # === Diffusion (matches generate_dreamidv_faster.py lines 297-313) ===
    ref_paths = [ref_video, final_mask_path, src_image]
    prompt = "chang face"

    video = _PIPELINE.generate(
        prompt,
        ref_paths,
        size=_SIZE_CONFIGS[size],
        frame_num=frame_num,
        shift=sample_shift,
        sample_solver=sample_solver,
        sampling_steps=sample_steps,
        guide_scale_img=sample_guide_scale_img,
        seed=seed,
        offload_model=offload_model,
    )

    # === Save (matches generate_dreamidv_faster.py lines 316-328) ===
    # NB: cfg.sample_fps default is 16, BUT the CLI always passed
    # --sample_fps=24 because argparse default is 24 (not None). To stay
    # byte-compatible with the old subprocess pipeline we override.
    _CACHE_VIDEO(
        tensor=video[None],
        save_file=out_mp4,
        fps=sample_fps,
        nrow=1,
        normalize=True,
        value_range=(-1, 1),
    )
    return out_mp4

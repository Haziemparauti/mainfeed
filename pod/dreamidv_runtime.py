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
    # Wan ships only ONE square preset (1024*1024) — ~6x heavier than 832*480 and
    # too slow for per-user pre-bake (~12 min/swap measured). The arc format is
    # 1:1, so register the planned smaller squares: 512² is the locked target,
    # 720² the higher-fidelity dial. Both are /16-divisible (512/16=32, 720/16=45)
    # so the DiT/VAE handle them; quality dips vs 1024² — the deliberate trade for
    # bake speed/cost (the 1024² test confirmed 1:1/5s renders; we don't need it).
    # 9:16 VERTICAL (TikTok) is the LOCKED format 2026-05-31. Register the vertical
    # dims (also /16-divisible: 720/16=45, 1280/16=80; 480/16=30, 832/16=52). 720*1280
    # is the production target; 480*832 a faster/cheaper dial. Squares kept for legacy.
    _SIZE_CONFIGS = {
        **SIZE_CONFIGS,
        '512*512': (512, 512), '720*720': (720, 720),
        '720*1280': (720, 1280), '1280*720': (1280, 720),
        '480*832': (480, 832), '832*480': (832, 480),
    }
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

    # OPTIONAL: torch.compile the DiT for diffusion-time speedup.
    # Gated behind DREAMIDV_TORCH_COMPILE env var so we can A/B without code changes.
    # First swap after compile-on pays ~30-60s compile cost; subsequent swaps
    # use cached graph at steady-state speedup. `fullgraph=False` allows graph
    # breaks for flash_attn / custom kernels.
    import torch as _torch
    # DREAMIDV_TORCH_COMPILE env var values (validated 2026-05-27 night, clean
    # steady-state per-iter measurement at frame_num=81):
    #   "0" (default) → eager mode, 4.78 s/it. Safest fallback only.
    #   "1" / "default" → torch.compile(mode="default") — 4.10 s/it = +14%. LOCKED PRODUCTION.
    #   "reduce-overhead" → CUDA graphs requested but silently skipped on our
    #       codebase (per-swap noise tensor allocation invalidates graphs).
    #       Ends up same as "default" — do not use.
    #   "max-autotune" → CRASHES on 2nd swap with "static input data pointer
    #       changed" (CUDA graph + per-swap tensor allocation incompatible). DEAD.
    # See [[mainfeed_optimization_test_results_2026-05-27]] for full test pass.
    # Rollback strategy: set to "0" and restart server.
    _compile_flag = os.environ.get("DREAMIDV_TORCH_COMPILE", "0").lower()
    _compile_mode = None
    if _compile_flag in ("1", "default"):
        _compile_mode = "default"
    elif _compile_flag in ("reduce-overhead", "reduce_overhead"):
        _compile_mode = "reduce-overhead"
    elif _compile_flag in ("max-autotune", "max_autotune"):
        _compile_mode = "max-autotune"

    print(f"[dreamidv_runtime] DREAMIDV_TORCH_COMPILE={_compile_flag} → mode={_compile_mode}", flush=True)
    if _compile_mode is not None:
        try:
            print(f"[dreamidv_runtime] applying torch.compile(mode={_compile_mode}, fullgraph=False)...", flush=True)
            _PIPELINE.model = _torch.compile(
                _PIPELINE.model,
                mode=_compile_mode,
                fullgraph=False,
                dynamic=False,
            )
            print(f"[dreamidv_runtime] torch.compile WRAPPER APPLIED ({_compile_mode}) — first swap pays compile cost", flush=True)
        except Exception as e:
            print(f"[dreamidv_runtime] torch.compile FAILED ({_compile_mode}), eager fallback: {e}", flush=True)

    _INITIALIZED = True
    logging.info("[dreamidv_runtime] pipeline loaded; ready for swaps")


# Tail-trim DISABLED 2026-05-26 LATE EVENING with quota simplification.
# Locked product spec: 3-second videos at DreamID-V's default frame_num=81.
# At that length the end-of-clip identity drift is small in absolute time
# (~0.2s of micro-jitter at clip end) and not worth +17% cost to fix —
# videos are no longer the focal "share format" (memes + images are).
# To re-enable for special longer clips, set TAIL_TRIM_FRAMES > 0.
TAIL_TRIM_FRAMES = 0


def _trim_tail(mp4_path: str, n_drop: int) -> None:
    """Drop the last `n_drop` frames from the video in place. No-op if the
    trim would leave <24 frames (1s) — safety guard."""
    import subprocess
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", mp4_path],
        capture_output=True, text=True, check=True,
    )
    total = int((probe.stdout or "0").strip() or "0")
    keep = total - n_drop
    if keep < 24:
        logging.warning(f"[dreamidv_runtime] _trim_tail: total={total} keep={keep} (<24), skipping trim")
        return
    tmp_path = mp4_path + ".trim.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-i", mp4_path,
         "-frames:v", str(keep),
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-an",
         tmp_path],
        check=True, capture_output=True,
    )
    os.replace(tmp_path, mp4_path)
    logging.info(f"[dreamidv_runtime] tail-trimmed {n_drop} frames; {total} → {keep}")


def run_swap(src_image: str, ref_video: str, out_mp4: str,
             size: str = "832*480", sample_steps: int = 16,
             sample_guide_scale_img: float = 4.0, frame_num: int = 81,
             sample_fps: int = 24,
             sample_shift: float = 5.0, sample_solver: str = "unipc",
             seed: int = 42, offload_model: bool = True,
             task: str = "swapface") -> str:
    """
    Run one swap. Mirrors the behavior of generate_dreamidv_faster.py CLI
    exactly so output matches at the same seed.

    `frame_num` is the USER-FACING target. Internally we ask DreamID-V for
    `frame_num + TAIL_TRIM_FRAMES` and trim the glitchy tail (temporal-chunk
    artifact at the last frames of every swap).

    Steps:
      1. Run DWPose on ref_video to produce *_pose.mp4 + *_mask.mp4
         (skipped if cached files already exist next to ref_video).
      2. Call pipeline.generate(...) with frame_num + tail buffer.
      3. cache_video(...) to write the raw output mp4.
      4. ffmpeg-trim the last TAIL_TRIM_FRAMES from the output.

    Args mirror the CLI args of generate_dreamidv_faster.py.

    Returns:
        Path to the output mp4 on disk (already tail-trimmed).
    """
    if not _INITIALIZED:
        raise RuntimeError("dreamidv_runtime.init() must be called before run_swap()")

    import time as _time
    _t_swap_start = _time.perf_counter()

    cfg = _WAN_CONFIGS[task]

    # Ask DreamID-V for the user-facing target PLUS a tail buffer that we'll
    # trim post-generation. The model's last temporal chunk has weaker identity
    # conditioning, producing visible micro-jitter in the final ~5-10 frames.
    requested_frame_num = frame_num + TAIL_TRIM_FRAMES

    # === DWPose preprocessing (matches generate_dreamidv_faster.py lines 270-289) ===
    ref_dir = os.path.dirname(ref_video) or "."
    temp_dir = os.path.join(ref_dir, "temp_generated")
    video_base = os.path.basename(ref_video).split(".")[0]
    final_pose_path = os.path.join(temp_dir, video_base + "_pose.mp4")
    final_mask_path = os.path.join(temp_dir, video_base + "_mask.mp4")

    _t_dwpose_start = _time.perf_counter()
    _dwpose_was_cached = os.path.exists(final_pose_path) and os.path.exists(final_mask_path)
    if not _dwpose_was_cached:
        os.makedirs(temp_dir, exist_ok=True)
        try:
            _PROCESS_DWPOSE(ref_video, final_pose_path, final_mask_path)
            logging.info(f"[dreamidv_runtime] DWPose: {final_pose_path}")
        except Exception as e:
            logging.error(f"[dreamidv_runtime] DWPose failed: {e}")
            raise
    else:
        logging.info(f"[dreamidv_runtime] DWPose cached, skipping: {final_mask_path}")
    _t_dwpose_elapsed = _time.perf_counter() - _t_dwpose_start
    print(f"[PHASE] dwpose cached={_dwpose_was_cached} elapsed={_t_dwpose_elapsed:.2f}s", flush=True)

    # === Diffusion (matches generate_dreamidv_faster.py lines 297-313) ===
    ref_paths = [ref_video, final_mask_path, src_image]
    prompt = "chang face"

    _t_diff_start = _time.perf_counter()
    video = _PIPELINE.generate(
        prompt,
        ref_paths,
        size=_SIZE_CONFIGS[size],
        frame_num=requested_frame_num,
        shift=sample_shift,
        sample_solver=sample_solver,
        sampling_steps=sample_steps,
        guide_scale_img=sample_guide_scale_img,
        seed=seed,
        offload_model=offload_model,
    )
    _t_diff_elapsed = _time.perf_counter() - _t_diff_start
    print(f"[PHASE] diffusion steps={sample_steps} frames={requested_frame_num} elapsed={_t_diff_elapsed:.2f}s", flush=True)

    # === Save (matches generate_dreamidv_faster.py lines 316-328) ===
    # NB: cfg.sample_fps default is 16, BUT the CLI always passed
    # --sample_fps=24 because argparse default is 24 (not None). To stay
    # byte-compatible with the old subprocess pipeline we override.
    _t_save_start = _time.perf_counter()
    _CACHE_VIDEO(
        tensor=video[None],
        save_file=out_mp4,
        fps=sample_fps,
        nrow=1,
        normalize=True,
        value_range=(-1, 1),
    )
    _t_save_elapsed = _time.perf_counter() - _t_save_start
    _t_total_elapsed = _time.perf_counter() - _t_swap_start
    print(f"[PHASE] cache_video elapsed={_t_save_elapsed:.2f}s", flush=True)
    print(f"[PHASE] TOTAL run_swap={_t_total_elapsed:.2f}s  "
          f"(dwpose={_t_dwpose_elapsed:.1f}s diff={_t_diff_elapsed:.1f}s save={_t_save_elapsed:.1f}s)",
          flush=True)

    # Tail-trim the glitchy last frames (see TAIL_TRIM_FRAMES comment above).
    if TAIL_TRIM_FRAMES > 0:
        try:
            _trim_tail(out_mp4, TAIL_TRIM_FRAMES)
        except Exception as e:
            logging.error(f"[dreamidv_runtime] tail-trim failed (keeping untrimmed): {e}")

    return out_mp4


def _mux_audio(video_only: str, audio_src: str, out_mp4: str) -> str:
    """Mux audio_src's audio onto a video-only mp4 (→ out_mp4). If audio_src has
    no audio track, just move video_only → out_mp4. Used by the <=81f single-shot
    path; the windowed path muxes audio inside sliding_window.assemble_windows."""
    import sliding_window
    import subprocess as _sp
    import shutil as _sh
    if not sliding_window.has_audio(audio_src):
        if os.path.abspath(video_only) != os.path.abspath(out_mp4):
            _sh.move(video_only, out_mp4)
        return out_mp4
    _sp.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-i", video_only, "-i", audio_src,
         "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
         "-map", "0:v:0", "-map", "1:a:0", "-shortest", out_mp4],
        check=True, capture_output=True,
    )
    if os.path.abspath(video_only) != os.path.abspath(out_mp4):
        try:
            os.remove(video_only)
        except OSError:
            pass
    return out_mp4


def run_swap_long(src_image: str, ref_video: str, out_mp4: str,
                  size: str = "720*1280", sample_steps: int = 16,
                  sample_guide_scale_img: float = 4.0,
                  seed: int = 42, offload_model: bool = True,
                  task: str = "swapface", keep_audio: bool = True) -> str:
    """
    Sliding-window swap for clips LONGER than DreamID-V's ~81-frame trained
    window (our Storytime clips are 10-15s = 240-450 frames). The clip is split
    into OVERLAPPING 81-frame windows; each window is swapped independently on
    the warm pipeline (so identity is re-derived from the selfie every window),
    then the windows are cross-faded over their overlap regions
    (sliding_window.assemble_windows) so the per-window identity reset is hidden
    behind a smooth alpha blend → seamless long swap. Source audio is muxed back.

    Every window is exactly WINDOW_FRAMES (=81 = 4·20+1, a valid Wan frame count)
    and TAIL_TRIM_FRAMES is 0, so each window swaps to exactly 81 frames and the
    planned specs stay frame-aligned with the swapped outputs for assembly.

    Clips <= 81 frames fall through to a single run_swap + audio mux.
    Returns out_mp4.
    """
    if not _INITIALIZED:
        raise RuntimeError("dreamidv_runtime.init() must be called before run_swap_long()")

    import sliding_window
    import tempfile
    import shutil as _sh

    total = sliding_window.probe_frames(ref_video)
    fps = sliding_window.probe_fps(ref_video)
    print(f"[dreamidv_runtime] run_swap_long: {total} frames @ {fps:.3f}fps size={size} "
          f"keep_audio={keep_audio}", flush=True)
    if total <= 0:
        raise RuntimeError(f"run_swap_long: ref_video has no frames ({ref_video})")

    # Short clip → no windowing needed. Round frame_num down to Wan's 4n+1.
    if total <= sliding_window.WINDOW_FRAMES:
        fn = max(5, ((total - 1) // 4) * 4 + 1)
        tmp_video = out_mp4 + ".noaudio.mp4"
        run_swap(src_image=src_image, ref_video=ref_video, out_mp4=tmp_video,
                 size=size, sample_steps=sample_steps,
                 sample_guide_scale_img=sample_guide_scale_img,
                 frame_num=fn, seed=seed, offload_model=offload_model, task=task)
        if keep_audio:
            _mux_audio(tmp_video, ref_video, out_mp4)
        else:
            os.replace(tmp_video, out_mp4)
        return out_mp4

    specs = sliding_window.plan_windows(total)   # [(start, 81), ...], final ends at total
    print(f"[dreamidv_runtime] run_swap_long: {len(specs)} windows {specs}", flush=True)

    work = tempfile.mkdtemp(prefix="longswap_")
    try:
        window_clips = []
        for idx, (start, length) in enumerate(specs):
            win_src = os.path.join(work, f"win{idx}_src.mp4")
            win_out = os.path.join(work, f"win{idx}_out.mp4")
            sliding_window.extract_window(ref_video, start, length, win_src)
            print(f"[dreamidv_runtime] run_swap_long window {idx + 1}/{len(specs)} "
                  f"frames[{start}:{start + length}] → swap", flush=True)
            run_swap(src_image=src_image, ref_video=win_src, out_mp4=win_out,
                     size=size, sample_steps=sample_steps,
                     sample_guide_scale_img=sample_guide_scale_img,
                     frame_num=length, seed=seed,
                     offload_model=offload_model, task=task)
            window_clips.append(win_out)

        audio_src = ref_video if keep_audio else None
        sliding_window.assemble_windows(specs, window_clips, total, fps, out_mp4,
                                        audio_src=audio_src)
        if not os.path.exists(out_mp4):
            raise RuntimeError(f"run_swap_long: assemble produced no output at {out_mp4}")
        print(f"[dreamidv_runtime] run_swap_long DONE → {out_mp4} "
              f"({os.path.getsize(out_mp4)} bytes, {total} frames)", flush=True)
        return out_mp4
    finally:
        if os.environ.get("DEBUG_KEEP_WORKDIR", "0") != "1":
            _sh.rmtree(work, ignore_errors=True)

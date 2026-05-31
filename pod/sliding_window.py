"""
Sliding-window long-video swap assembly.

WHY: DreamID-V (Wan-2.1) is trained at ~81 frames. Past that the identity
conditioning weakens -> drift + temporal-chunk jitter. Our Storytime clips are
10-15s (300-450 frames), 4-5x the window. So for long clips we swap in
OVERLAPPING windows of <=81 frames and CROSS-FADE the overlap regions, which
hides the per-window identity "reset" (each window re-derives the face from the
selfie) behind a smooth alpha blend -> seamless long swap.

This module is deliberately pure ffmpeg + numpy + PIL (NO cv2 / torch) so the
stitch math is unit-testable OFF-GPU: feed it any per-window clips and it
assembles them. dreamidv_runtime.run_swap_long() is the GPU orchestrator that
supplies real swapped windows into assemble_windows().

Frame-exact extraction uses ffmpeg `trim=start_frame:end_frame` (end exclusive).
Assembly decodes each window to PNGs, blends overlaps per-frame with a linear
alpha ramp via PIL.Image.blend (no numpy — PIL is on the pod and locally, so the
stitch math is unit-testable off-GPU), and re-encodes.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import shutil
from typing import List, Tuple

from PIL import Image

WINDOW_FRAMES = 81       # DreamID-V trained window (hard quality horizon)
WINDOW_OVERLAP = 12      # frames cross-faded between adjacent windows
# stride = WINDOW_FRAMES - WINDOW_OVERLAP


# ----------------------------------------------------------------------------- probes
def probe_frames(path: str) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return int((out.stdout or "0").strip() or 0)


def probe_fps(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    raw = (out.stdout or "24/1").strip() or "24/1"
    num, _, den = raw.partition("/")
    den = den or "1"
    try:
        return float(num) / float(den)
    except ZeroDivisionError:
        return 24.0


def has_audio(path: str) -> bool:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    return bool((out.stdout or "").strip())


# ----------------------------------------------------------------------------- planning
def plan_windows(total: int, window: int = WINDOW_FRAMES,
                 overlap: int = WINDOW_OVERLAP) -> List[Tuple[int, int]]:
    """
    Cover [0, total) with overlapping windows. Returns [(start, length), ...].
    - clips <= window -> single full window.
    - the FINAL window always ends exactly at `total` (clamped, may start late).
    - a near-duplicate penultimate start (within `overlap` of the final) is
      dropped so we don't waste a window swapping nearly the same frames.
    Adjacent windows always overlap by >= 1 frame (blend computed per-pair from
    the ACTUAL overlap, so an uneven last gap is handled correctly).
    """
    if total <= 0:
        return []
    if total <= window:
        return [(0, total)]
    stride = max(1, window - overlap)
    starts = list(range(0, total - window, stride))
    final_start = total - window
    if not starts:
        starts = [0]
    if starts[-1] != final_start:
        # drop a penultimate start that would almost fully overlap the final
        if final_start - starts[-1] < overlap:
            starts[-1] = final_start
        else:
            starts.append(final_start)
    return [(s, window) for s in starts]


# ----------------------------------------------------------------------------- extract
def extract_window(src: str, start: int, length: int, out_path: str) -> str:
    """Write source frames [start, start+length) to out_path (frame-exact, no audio)."""
    end = start + length  # trim end_frame is EXCLUSIVE
    vf = f"trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
         "-vf", vf, "-an",
         "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p",
         out_path],
        check=True, capture_output=True,
    )
    return out_path


# ----------------------------------------------------------------------------- assemble
def _decode_frames(path: str, work: str) -> List[str]:
    """Decode a clip to PNG frame paths (0-indexed). Returns the path list;
    frames are loaded lazily by the assembler to keep memory flat on long clips."""
    d = tempfile.mkdtemp(prefix="frames_", dir=work)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
         "-start_number", "0", os.path.join(d, "%05d.png")],
        check=True, capture_output=True,
    )
    return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".png"))


def assemble_windows(window_specs: List[Tuple[int, int]],
                     window_clips: List[str],
                     total: int, fps: float, out_path: str,
                     audio_src: str | None = None) -> str:
    """
    Blend per-window swapped clips into one seamless `total`-frame video.

    window_specs : [(start, length), ...] from plan_windows (parallel to window_clips).
    window_clips : swapped mp4 for each window (length frames each).
    Overlap between window i and i+1 is cross-faded with a linear alpha ramp so
    the identity reset between windows is invisible. Output has exactly `total`
    frames. If audio_src is given (+ has audio), its track is muxed back.
    """
    assert len(window_specs) == len(window_clips), "specs/clips length mismatch"
    work = tempfile.mkdtemp(prefix="assemble_")
    try:
        # Decode every window's frames once (paths, lazy-loaded).
        decoded = [_decode_frames(c, work) for c in window_clips]
        # Guard: a window clip may decode to slightly != length (encoder rounding);
        # clamp the spec length to what actually decoded.
        specs = []
        for (start, length), frames in zip(window_specs, decoded):
            specs.append((start, min(length, len(frames))))

        odir = tempfile.mkdtemp(prefix="out_", dir=work)
        for f in range(total):
            # windows covering source frame f: start <= f < start+len
            covering = [i for i, (s, ln) in enumerate(specs) if s <= f < s + ln]
            if not covering:
                # gap safety: clamp to nearest window (shouldn't happen)
                covering = [min(range(len(specs)),
                                key=lambda i: abs(specs[i][0] - f))]
            if len(covering) == 1:
                i = covering[0]
                img = Image.open(decoded[i][f - specs[i][0]]).convert("RGB")
            else:
                # earliest two (stride>overlap => never 3-way)
                i, j = covering[0], covering[1]
                si, sj = specs[i][0], specs[j][0]
                ov_start = sj
                ov_end = si + specs[i][1]            # exclusive
                ov_len = max(1, ov_end - ov_start)
                a = (f - ov_start + 1) / (ov_len + 1)  # (0,1), never hard 0/1
                fa = Image.open(decoded[i][f - si]).convert("RGB")
                fb = Image.open(decoded[j][f - sj]).convert("RGB")
                img = Image.blend(fa, fb, a)           # fa*(1-a) + fb*a
            img.save(os.path.join(odir, f"{f:05d}.png"))

        silent = out_path + ".silent.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-framerate", f"{fps:.6f}", "-start_number", "0",
             "-i", os.path.join(odir, "%05d.png"),
             "-c:v", "libx264", "-preset", "medium", "-crf", "16",
             "-pix_fmt", "yuv420p", silent],
            check=True, capture_output=True,
        )

        if audio_src and has_audio(audio_src):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-i", silent, "-i", audio_src,
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                 "-map", "0:v:0", "-map", "1:a:0", "-shortest", out_path],
                check=True, capture_output=True,
            )
            os.remove(silent)
        else:
            os.replace(silent, out_path)
        return out_path
    finally:
        shutil.rmtree(work, ignore_errors=True)

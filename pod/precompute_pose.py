#!/usr/bin/env python3
"""
Pre-compute DWPose pose-video + mask-video for a stock clip.

Run ONCE per stock-library clip during library prep. The output `_pose.mp4` and
`_mask.mp4` files live alongside the stock clip in R2 (or local disk during dev)
and are passed to swap_server's /swap endpoint at production-swap time, so the
swap pod skips the 5–10-min DWPose pass per swap.

Usage:
  python precompute_pose.py \\
      --input /path/to/cop_s07_coffee_plaza_f.mp4 \\
      --output-dir /path/to/output \\
      [--pose-model /workspace/ckpts/dwpose/dw-ll_ucoco_384.onnx] \\
      [--yolox-model /workspace/ckpts/dwpose/yolox_l.onnx]

Writes:
  <output-dir>/<stem>_pose.mp4
  <output-dir>/<stem>_mask.mp4
"""

from __future__ import annotations
import argparse
import os
import sys
import subprocess
from pathlib import Path

DREAMIDV_DIR = Path(os.environ.get("DREAMIDV_DIR", "/root/dreamidv"))
WEIGHTS_DIR = Path(os.environ.get("WEIGHTS_DIR", "/workspace/ckpts"))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, type=Path, help="Stock video (mp4).")
    p.add_argument("--output-dir", required=True, type=Path)
    p.add_argument("--pose-model", type=Path,
                   default=WEIGHTS_DIR / "dwpose" / "dw-ll_ucoco_384.onnx")
    p.add_argument("--yolox-model", type=Path,
                   default=WEIGHTS_DIR / "dwpose" / "yolox_l.onnx")
    p.add_argument("--dreamidv-dir", type=Path, default=DREAMIDV_DIR)
    args = p.parse_args()

    if not args.input.exists():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2

    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem = args.input.stem
    pose_out = args.output_dir / f"{stem}_pose.mp4"
    mask_out = args.output_dir / f"{stem}_mask.mp4"

    # DreamID-V repo has a DWPose preprocessing utility; the exact entry-point
    # script name has shifted between commits. Adjust here once the pinned-SHA
    # repo state is final. The argset below is the validated invocation from
    # the 2026-05-25 retest session.
    script = args.dreamidv_dir / "preprocess_pose.py"
    if not script.exists():
        # Fall back to the common alt name
        alt = args.dreamidv_dir / "tools" / "preprocess_pose.py"
        if alt.exists():
            script = alt
        else:
            print(f"preprocess script not found in {args.dreamidv_dir}", file=sys.stderr)
            return 2

    cmd = [
        sys.executable,
        str(script),
        "--input", str(args.input),
        "--output_pose", str(pose_out),
        "--output_mask", str(mask_out),
        "--pose_model", str(args.pose_model),
        "--yolox_model", str(args.yolox_model),
    ]
    print(f"[precompute_pose] {' '.join(cmd)}", flush=True)
    rc = subprocess.run(cmd, cwd=str(args.dreamidv_dir)).returncode
    if rc != 0:
        return rc

    if not pose_out.exists() or not mask_out.exists():
        print("expected outputs missing after pose preprocess", file=sys.stderr)
        return 3

    print(f"[precompute_pose] pose: {pose_out}  ({pose_out.stat().st_size} bytes)")
    print(f"[precompute_pose] mask: {mask_out}  ({mask_out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

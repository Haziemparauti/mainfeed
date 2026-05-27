#!/usr/bin/env python3
"""
One-time mirror — push DreamID-V faster + Wan-2.1 + DWPose weights from a pod
that has booted successfully (and therefore has all weights cached locally)
into our R2 bucket at `mainfeed-content/models/`. After this runs, pods can
boot from R2 instead of HuggingFace by setting HARDEN_WEIGHTS_R2=1 (see
pod/swap_server.py `_weight_manifest`).

Idempotent: each file is `head_object`'d in R2 first; uploaded only if missing
or size-mismatched. Safe to rerun after partial transfers.

Requirements:
  - boto3 installed locally (already in the pod's Dockerfile)
  - R2 S3 API creds available via env vars:
      R2_ACCOUNT_ID
      R2_ACCESS_KEY_ID
      R2_SECRET_ACCESS_KEY
  - All source weights present at the paths in MIRROR below (run from a pod
    where swap_server.py has booted at least once on the HF path).

Run on the pod:
    set -a; . /root/r2_creds.env; set +a
    python /root/mirror_weights_to_r2.py

Bytes: ~24 GB.  Wall-time on the RunPod ↔ R2 link: ~6 min at ~60 MB/s.
R2 storage cost: ~$0.36/mo at $0.015/GB.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import boto3
from botocore.client import Config


ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "")
SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
BUCKET     = os.environ.get("R2_BUCKET", "mainfeed-content")
PREFIX     = os.environ.get("R2_WEIGHTS_PREFIX", "models/").rstrip("/") + "/"

if not (ACCOUNT_ID and ACCESS_KEY and SECRET_KEY):
    sys.stderr.write(
        "ERROR: R2_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY must be set.\n"
        "Source them from your local r2 creds before running, e.g.:\n"
        "    set -a; . /root/r2_creds.env; set +a\n"
        "    python /root/mirror_weights_to_r2.py\n"
    )
    sys.exit(2)

WEIGHTS_DIR  = Path(os.environ.get("WEIGHTS_DIR", "/workspace/ckpts"))
DREAMIDV_DIR = Path(os.environ.get("DREAMIDV_DIR", "/root/dreamidv"))

# (local_path, r2_key_relative_to_PREFIX)
MIRROR = [
    (WEIGHTS_DIR  / "dreamidv_faster.pth",                            "dreamidv_faster.pth"),
    (WEIGHTS_DIR  / "wan2.1" / "Wan2.1_VAE.pth",                      "wan2.1/Wan2.1_VAE.pth"),
    (WEIGHTS_DIR  / "wan2.1" / "models_t5_umt5-xxl-enc-bf16.pth",     "wan2.1/models_t5_umt5-xxl-enc-bf16.pth"),
    (WEIGHTS_DIR  / "wan2.1" / "diffusion_pytorch_model.safetensors", "wan2.1/diffusion_pytorch_model.safetensors"),
    (DREAMIDV_DIR / "pose" / "models" / "dw-ll_ucoco_384.onnx",       "dwpose/dw-ll_ucoco_384.onnx"),
    (DREAMIDV_DIR / "pose" / "models" / "yolox_l.onnx",               "dwpose/yolox_l.onnx"),
]


def main() -> int:
    if not (ACCESS_KEY and SECRET_KEY):
        print("ERROR: R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY required in env", file=sys.stderr)
        return 2

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    plan, skipped, total_bytes = [], 0, 0
    for local, rel_key in MIRROR:
        if not local.exists():
            print(f"MISSING locally: {local}", file=sys.stderr)
            return 2
        sz = local.stat().st_size
        full_key = PREFIX + rel_key
        try:
            head = s3.head_object(Bucket=BUCKET, Key=full_key)
            if head.get("ContentLength") == sz:
                skipped += 1
                continue
        except Exception:
            pass
        plan.append((local, full_key, sz))
        total_bytes += sz

    print(f"skipped: {skipped} files already in R2 at matching size")
    print(f"upload:  {len(plan)} files = {total_bytes / 1e9:.2f} GB")

    t0 = time.time()
    for local, key, sz in plan:
        print(f"  PUT {key:60s} ({sz:>13,} bytes)", flush=True)
        tt = time.time()
        s3.upload_file(
            Filename=str(local),
            Bucket=BUCKET,
            Key=key,
            ExtraArgs={"ContentType": "application/octet-stream"},
        )
        el = time.time() - tt
        rate = (sz / 1e6) / max(el, 0.001)
        print(f"      ok {el:.1f}s ({rate:.0f} MB/s)", flush=True)
    print(f"=== DONE in {time.time() - t0:.1f}s ===")

    # Final inventory
    print(f"\nR2 inventory at {BUCKET}/{PREFIX}:")
    total, n = 0, 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX):
        for obj in page.get("Contents", []):
            print(f"  {obj['Key']:60s} {obj['Size']:>13,}")
            total += obj["Size"]
            n += 1
    print(f"total: {n} files, {total/1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Host-side one-time mirror — pull Flux.1-schnell + PuLID + antelopev2 + AE
from HuggingFace and push them into our R2 bucket so the pod can boot from
R2 without an HF_TOKEN (FLUX.1-schnell is gated; without this mirror, the
gate is in the cold-boot critical path).

Parallel companion to `mirror_weights_to_r2.py` (which runs ON a pod for
DreamID-V + Wan-2.1 + DWPose mirror). This one runs on the HOST because:
  - HF token for the gated FLUX.1-schnell repo lives at $STOCK_DIR/hf_token.txt
  - R2 write creds (S3-compatible) live at $STOCK_DIR/r2_creds.txt — a
    short-lived WRITE-scoped token the user generated solely for this mirror
    and should revoke after. After mirror is done, the pod uses a separate
    READ-ONLY token (or none at all if HF_TOKEN is set instead).

Sequence:
  1. huggingface_hub.hf_hub_download → $CACHE_DIR/<filename>
  2. boto3 upload_file → r2://mainfeed-content/models/flux_pulid/<filename>
     (boto3 handles multipart automatically for files > 8 MB; no 300 MiB
     cap like wrangler r2 object put)

Idempotent at both layers: HF download is HF-cache-aware (no re-download on
repeat runs), and R2 upload skips files that already match size at the
destination key.

Usage (from repo root):
    python pod/scripts/mirror_flux_pulid_to_r2.py

Auto-loads HF_TOKEN from $STOCK_DIR/hf_token.txt and R2 creds from
$STOCK_DIR/r2_creds.txt (ACCOUNT_ID + ACCESS_KEY_ID + SECRET_ACCESS_KEY).

Bytes: ~25 GB.  Wall-time on a decent home connection: 15-30 min (download
dominates; boto3 multipart maxes out the upload pipe).
R2 storage cost: ~$0.38/mo at $0.015/GB.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.client import Config as BotoConfig

# ============ config ============

STOCK_DIR = Path(os.environ.get("STOCK_DIR", r"C:\Users\cex\Desktop\mainfeed-stock"))
CACHE_DIR = Path(os.environ.get("FLUX_MIRROR_CACHE",
                                str(STOCK_DIR / "flux_pulid_cache")))

R2_BUCKET = os.environ.get("R2_BUCKET", "mainfeed-content")
R2_PREFIX = os.environ.get("R2_WEIGHTS_PREFIX", "models/").rstrip("/") + "/"

HF_TOKEN = os.environ.get("HF_TOKEN", "")
if not HF_TOKEN and (STOCK_DIR / "hf_token.txt").exists():
    HF_TOKEN = (STOCK_DIR / "hf_token.txt").read_text().strip()

if not HF_TOKEN:
    sys.stderr.write(
        "ERROR: HF_TOKEN not found in env or at $STOCK_DIR/hf_token.txt.\n"
        "FLUX.1-schnell is gated — see [[mainfeed_flux_schnell_gated_on_hf]]\n"
        "for the one-time HF terms acceptance + read-token creation steps.\n"
    )
    sys.exit(2)


# Load R2 S3-compat creds from $STOCK_DIR/r2_creds.txt (KEY=value lines).
R2_CREDS = {}
_creds_path = STOCK_DIR / "r2_creds.txt"
if _creds_path.exists():
    for line in _creds_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        R2_CREDS[k.strip()] = v.strip()

R2_ACCOUNT_ID        = os.environ.get("R2_ACCOUNT_ID", R2_CREDS.get("ACCOUNT_ID", ""))
R2_ACCESS_KEY_ID     = os.environ.get("R2_ACCESS_KEY_ID", R2_CREDS.get("ACCESS_KEY_ID", ""))
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", R2_CREDS.get("SECRET_ACCESS_KEY", ""))

if not (R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY):
    sys.stderr.write(
        "ERROR: R2 creds incomplete. Need ACCOUNT_ID + ACCESS_KEY_ID + SECRET_ACCESS_KEY\n"
        f"in $STOCK_DIR/r2_creds.txt (currently at: {_creds_path})\n"
    )
    sys.exit(2)


# ============ mirror manifest ============

# Each entry: (hf_repo, hf_filename, r2_key_relative_to_R2_PREFIX)
# Same R2 keys as in pod/swap_server.py _weight_manifest() — keep in sync.
# Ordered smallest → largest so the cheap antelopev2 + pulid files validate
# the upload path before we commit to the 24 GB flux1-schnell upload.
MIRROR = [
    # === InsightFace antelopev2 (public — DIAMONIK7777 mirror that PuLID's
    # pipeline_flux.py auto-downloads, mirrored here for deterministic boot) ===
    ("DIAMONIK7777/antelopev2", "1k3d68.onnx",
     "flux_pulid/antelopev2/1k3d68.onnx"),
    ("DIAMONIK7777/antelopev2", "2d106det.onnx",
     "flux_pulid/antelopev2/2d106det.onnx"),
    ("DIAMONIK7777/antelopev2", "genderage.onnx",
     "flux_pulid/antelopev2/genderage.onnx"),
    ("DIAMONIK7777/antelopev2", "glintr100.onnx",
     "flux_pulid/antelopev2/glintr100.onnx"),
    ("DIAMONIK7777/antelopev2", "scrfd_10g_bnkps.onnx",
     "flux_pulid/antelopev2/scrfd_10g_bnkps.onnx"),

    # === AE / Flux autoencoder (gated, needs HF_TOKEN) ===
    ("black-forest-labs/FLUX.1-schnell", "ae.safetensors",
     "flux_pulid/ae.safetensors"),

    # === PuLID-FLUX adapter (public) ===
    ("guozinan/PuLID", "pulid_flux_v0.9.1.safetensors",
     "flux_pulid/pulid_flux_v0.9.1.safetensors"),

    # === Flux.1-schnell base (gated, ~24 GB — largest, queued last) ===
    ("black-forest-labs/FLUX.1-schnell", "flux1-schnell.safetensors",
     "flux_pulid/flux1-schnell.safetensors"),
]


# ============ R2 client ============

S3 = boto3.client(
    "s3",
    endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    config=BotoConfig(signature_version="s3v4"),
    region_name="auto",
)

# boto3 multipart config:
#   multipart_threshold: switch to multipart for files larger than this
#   multipart_chunksize: each part size (must be 5 MB minimum, except last)
#   max_concurrency: parallel part uploads — bumps throughput on home connections
# R2 limit: 10,000 parts per upload. With 100 MB parts that supports up to 1 TB
# per file. flux1-schnell at 24 GB needs ~240 parts — comfortable headroom.
TRANSFER_CFG = TransferConfig(
    multipart_threshold=8 * 1024 * 1024,
    multipart_chunksize=100 * 1024 * 1024,
    max_concurrency=4,
    use_threads=True,
)


# ============ helpers ============

def r2_object_size(key: str) -> int | None:
    """Return the byte-size of an R2 object, or None if it doesn't exist."""
    try:
        head = S3.head_object(Bucket=R2_BUCKET, Key=key)
        return head.get("ContentLength")
    except Exception:
        return None


def hf_download(hf_repo: str, hf_filename: str, local_dir: Path) -> Path:
    """Download a single file from HF into local_dir. HF-cache-aware (no
    re-download if already present at matching SHA)."""
    from huggingface_hub import hf_hub_download
    local_dir.mkdir(parents=True, exist_ok=True)
    print(f"  hf_hub_download {hf_repo}:{hf_filename} -> {local_dir}", flush=True)
    path = hf_hub_download(
        repo_id=hf_repo,
        filename=hf_filename,
        local_dir=str(local_dir),
        token=HF_TOKEN,
    )
    return Path(path)


def r2_put(local: Path, key: str, content_type: str = "application/octet-stream") -> None:
    """Upload a local file to R2 via boto3 (multipart for files > 8 MB).
    Streams from disk so 24 GB files don't blow up memory."""
    full_key = f"{R2_BUCKET}/{key}"
    sz = local.stat().st_size
    print(f"  PUT  {full_key} ({sz:,} bytes, ~{sz / 1e9:.2f} GB)", flush=True)
    S3.upload_file(
        Filename=str(local),
        Bucket=R2_BUCKET,
        Key=key,
        ExtraArgs={"ContentType": content_type},
        Config=TRANSFER_CFG,
    )


# ============ main ============

def main() -> int:
    print(f"Mirror cache dir: {CACHE_DIR}")
    print(f"R2 destination:   {R2_BUCKET}/{R2_PREFIX}")
    print(f"Manifest:         {len(MIRROR)} files")
    print()

    skipped, uploaded, total_uploaded_bytes = 0, 0, 0
    t_total = time.time()

    for hf_repo, hf_filename, rel_key in MIRROR:
        full_key = R2_PREFIX + rel_key
        print(f"=== {rel_key} ===")

        # Fast path: HEAD R2 first. If already mirrored at any non-zero size,
        # skip re-downloading from HF too (saves 24 GB of HF bandwidth on
        # idempotent re-runs).
        r2_size_before = r2_object_size(full_key)

        # Step 1: download from HF into local cache (HF-aware caching).
        try:
            local_path = hf_download(hf_repo, hf_filename, CACHE_DIR)
        except Exception as e:
            sys.stderr.write(f"HF download FAILED for {hf_repo}:{hf_filename} - {e}\n")
            return 3
        local_size = local_path.stat().st_size

        # Step 2: skip upload if R2 already has it at matching size.
        if r2_size_before == local_size:
            print(f"  ok already in R2 at matching size ({local_size:,} bytes), skipping upload")
            skipped += 1
            print()
            continue
        if r2_size_before is not None:
            print(f"  ! R2 has {r2_size_before:,} bytes, local is {local_size:,} - re-uploading")

        # Step 3: upload via boto3 (multipart automatic for >8 MB).
        t_up = time.time()
        try:
            r2_put(local_path, full_key)
        except Exception as e:
            sys.stderr.write(f"R2 upload FAILED for {full_key} - {e}\n")
            return 4
        el = time.time() - t_up
        rate = (local_size / 1e6) / max(el, 0.001)
        print(f"  ok {el:.1f}s ({rate:.0f} MB/s)")
        uploaded += 1
        total_uploaded_bytes += local_size
        print()

    el_total = time.time() - t_total
    print()
    print(f"=== DONE ===")
    print(f"  skipped:  {skipped} files already in R2 at matching size")
    print(f"  uploaded: {uploaded} files = {total_uploaded_bytes / 1e9:.2f} GB")
    print(f"  total:    {el_total:.1f}s wall-time")
    return 0


if __name__ == "__main__":
    sys.exit(main())

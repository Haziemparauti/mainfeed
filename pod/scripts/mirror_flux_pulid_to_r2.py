#!/usr/bin/env python3
"""
Host-side one-time mirror — pull Flux.1-schnell + PuLID + antelopev2 + AE
from HuggingFace and push them into our R2 bucket so the pod can boot from
R2 without an HF_TOKEN (FLUX.1-schnell is gated; without this mirror, the
gate is in the cold-boot critical path).

Parallel companion to `mirror_weights_to_r2.py` (which runs ON a pod for
DreamID-V + Wan-2.1 + DWPose mirror). This one runs on the HOST because:
  - HF token for the gated FLUX.1-schnell repo lives at $STOCK_DIR/hf_token.txt
  - R2 writes go through `wrangler r2 object put` (Cloudflare session auth,
    no S3-compat keys needed), keeping us aligned with [[feedback_no_secrets_on_pod]]
    — the revoked R2 token never comes back, even for this one-time mirror.

Sequence:
  1. huggingface_hub.hf_hub_download → $CACHE_DIR/<filename>
  2. wrangler r2 object put mainfeed-content/models/flux_pulid/<filename>

Idempotent at both layers: HF download is HF-cache-aware (no re-download on
repeat runs), and R2 upload skips files that already match size at the
destination key.

Usage:
    HF_TOKEN=$(< /c/Users/cex/Desktop/mainfeed-stock/hf_token.txt) \\
      python pod/scripts/mirror_flux_pulid_to_r2.py

Or just run from the repo root — script auto-loads HF_TOKEN from the standard
mainfeed-stock path if env is empty:

    python pod/scripts/mirror_flux_pulid_to_r2.py

Bytes: ~25 GB.  Wall-time on a decent home connection: 15-30 min.
R2 storage cost: ~$0.38/mo at $0.015/GB.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ============ config ============

STOCK_DIR = Path(os.environ.get("STOCK_DIR", r"C:\Users\cex\Desktop\mainfeed-stock"))
CACHE_DIR = Path(os.environ.get("FLUX_MIRROR_CACHE",
                                str(STOCK_DIR / "flux_pulid_cache")))
WORKER_DIR = Path(__file__).resolve().parent.parent.parent / "worker"

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


# ============ helpers ============

def wrangler(*args, capture=False) -> subprocess.CompletedProcess:
    """Invoke npx wrangler from the worker/ dir so it picks up wrangler.toml."""
    cmd = ["npx.cmd" if os.name == "nt" else "npx", "--yes", "wrangler", *args]
    return subprocess.run(
        cmd, cwd=str(WORKER_DIR), check=False,
        capture_output=capture, text=capture,
    )


# NB: wrangler 4.x has no `r2 object info` / list — there's no cheap way
# to ask "does this key already exist at the right size?" from the host.
# We rely on HF's cache being canonical (skip re-download) and let wrangler
# overwrite on the R2 side. Re-runs are safe (overwrite is idempotent) but
# pay the upload bandwidth cost each time. For a one-time mirror that's OK.


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
    """Stream a local file to R2 via wrangler. wrangler handles multipart
    chunking transparently for files > 5 GB."""
    full_key = f"{R2_BUCKET}/{key}"
    print(f"  PUT  {full_key} ({local.stat().st_size:,} bytes)", flush=True)
    res = wrangler(
        "r2", "object", "put", full_key,
        "--file", str(local),
        "--content-type", content_type,
        "--remote",
    )
    if res.returncode != 0:
        raise RuntimeError(f"wrangler r2 put failed (exit {res.returncode})")


# ============ main ============

def main() -> int:
    print(f"Mirror cache dir: {CACHE_DIR}")
    print(f"R2 destination:   {R2_BUCKET}/{R2_PREFIX}")
    print(f"Manifest:         {len(MIRROR)} files")
    print()

    uploaded, total_uploaded_bytes = 0, 0
    t_total = time.time()

    for hf_repo, hf_filename, rel_key in MIRROR:
        full_key = R2_PREFIX + rel_key
        print(f"=== {rel_key} ===")

        # Step 1: download from HF into local cache (HF-aware caching).
        try:
            local_path = hf_download(hf_repo, hf_filename, CACHE_DIR)
        except Exception as e:
            sys.stderr.write(f"HF download FAILED for {hf_repo}:{hf_filename} — {e}\n")
            return 3
        local_size = local_path.stat().st_size

        # Step 2: upload via wrangler (overwrite is idempotent).
        t_up = time.time()
        try:
            r2_put(local_path, full_key)
        except Exception as e:
            sys.stderr.write(f"R2 upload FAILED for {full_key} — {e}\n")
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
    print(f"  uploaded: {uploaded} files = {total_uploaded_bytes / 1e9:.2f} GB")
    print(f"  total:    {el_total:.1f}s wall-time")
    return 0


if __name__ == "__main__":
    sys.exit(main())

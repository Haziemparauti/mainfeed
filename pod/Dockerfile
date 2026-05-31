# Mainfeed swap pod — DreamID-V faster head+hair swap.
# Base image is RunPod's PyTorch 2.4 + CUDA 12.4. Image stays small (~3 GB base + code);
# model weights are pulled at container start from HuggingFace into /workspace/ckpts
# (or, with HARDEN_WEIGHTS_R2=1, from our R2 mirror — see pod/README.md).
#
# Build:   docker build -t ghcr.io/haziemparauti/mainfeed-swap:dev pod/
# Push:    docker push ghcr.io/haziemparauti/mainfeed-swap:dev
# Run:     docker run --gpus all -p 8000:8000 \
#            -e SWAP_POD_SECRET=$SECRET \
#            ghcr.io/haziemparauti/mainfeed-swap:dev
#
# Validated DreamID-V invocation pattern (cop_s07 retest, 2026-05-25 evening):
#   python generate_dreamidv_faster.py --src_image ... --ref_video ... \
#     --sample_steps 16 --sample_guide_scale_img 4.0 --size 832*480

FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

# === System deps (single apt layer — libcairo2 lives here with everything else
# instead of in its own RUN, so we don't pay for a second apt-get update layer) ===
RUN apt-get update -qq && apt-get install -y -qq \
      ffmpeg libcudnn9-cuda-12 libcairo2 unzip wget git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# === Clone DreamID-V at pinned commit + prune .git + patch upstream quirks ===
# Source: Haziemparauti/DreamID-V (fork of bytedance/DreamID-V) — pinned to the
# exact commit validated on 2026-05-25 against cop_s07_coffee_plaza_f. Fork
# insulates the production build from upstream rebase / delete / license shift.
# .git history is dropped after checkout — runtime never reads it (saves ~50 MB).
# Patches:
#   1. requirements.txt has `mediapipe==0.10.5#numpy must < 2.0` — invalid PEP 440
#      (missing space before #). Fix in-place.
#   2. Strip flash_attn from requirements — it must install separately AFTER
#      torch is settled with --no-build-isolation (handled below).
ARG DREAMIDV_REPO=https://github.com/Haziemparauti/DreamID-V.git
ARG DREAMIDV_SHA=9b589940577559c91481fb3a13bae000a55f97a1
RUN git clone $DREAMIDV_REPO /root/dreamidv \
    && cd /root/dreamidv && git checkout $DREAMIDV_SHA \
    && rm -rf /root/dreamidv/.git \
    && sed -i 's|mediapipe==0.10.5#numpy|mediapipe==0.10.5  # numpy|' requirements.txt \
    && sed -i '/^flash_attn/d' requirements.txt

WORKDIR /root/dreamidv

# === Python deps — ONE RUN ===
# Why single-layer: pip uninstall in a later layer can't reclaim space from an
# earlier layer (Docker layers stack — deletions only mask, don't free). Running
# all pip work in one RUN means the onnxruntime uninstall/replace actually
# reclaims the CPU-only build instead of leaving it as dead weight in an earlier layer.
#
# Order matters:
#   1. DreamID-V requirements (sans flash_attn — patched out above)
#   2. Replace stock onnxruntime (CPU only) with onnxruntime-gpu. DWPose runs
#      pose+mask extraction on every swap; CPU-ORT does ~5-8s per frame on A6000,
#      GPU-ORT brings it under 1s. ~10x speedup on the dominant per-swap cost.
#   3. decord — missing from upstream requirements but referenced by
#      load_image_latent_ref_ip_video.
#   4. Server + burn-in deps (REST, R2 client, image rendering).
#   5. flash_attn LAST + --no-build-isolation. If it picks the wrong torch
#      during build the pod will OOM at swap time.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y onnxruntime 2>/dev/null || true \
    && pip install --no-cache-dir \
         onnxruntime-gpu \
         decord \
         fastapi 'uvicorn[standard]' httpx huggingface_hub \
         Pillow cairosvg \
         packaging ninja \
         sentencepiece protobuf einops torchsde \
         insightface facexlib timm \
    && pip install --no-cache-dir flash_attn --no-build-isolation

# === Note on the extra Python deps in the RUN block above ===
# sentencepiece + protobuf (T5 tokenizer), einops and torchsde are used by the
# Wan-2.1 / DreamID-V pipeline. insightface/facexlib/timm were originally added
# for the now-removed Flux+PuLID image path; left installed because they're small
# and pruning them risks the swap pipeline — revisit on a later slimming pass.
# diffusers / accelerate / transformers / torchvision come from dreamidv's reqs.txt.

# === Post-swap branding assets (caption + watermark burn-in) ===
# Bundle local-source-of-truth assets:
#   Anton          (SIL OFL) — bold condensed, meme caption font
#   Inter Medium   (SIL OFL) — premium SaaS sans, watermark text (locked
#                              2026-05-26: replaces DejaVu Bold which read
#                              cheap at small video sizes; size 0.022 + 2.5em
#                              letter-spacing per pod/render_overlay.py)
#   logo-square2   (Mainfeed brand mark) — rasterized by cairosvg at startup
RUN mkdir -p /app/assets
COPY assets/Anton.ttf         /app/assets/Anton.ttf
COPY assets/Inter-Medium.ttf  /app/assets/Inter-Medium.ttf
COPY assets/logo-square2.svg  /app/assets/logo-square2.svg

# === Server code ===
# swap_server.py imports dreamidv_runtime + sliding_window at startup.
# render_overlay.py burns the watermark "context bug" into downloaded MP4s
# (caption Anton, watermark Inter Medium per pod/render_overlay.py).
COPY swap_server.py        /root/swap_server.py
COPY dreamidv_runtime.py   /root/dreamidv_runtime.py
COPY sliding_window.py     /root/sliding_window.py
COPY render_overlay.py     /root/render_overlay.py
COPY precompute_pose.py    /root/precompute_pose.py

# === Workspace for weights + temp inference files (mounted as volume in prod) ===
RUN mkdir -p /workspace/ckpts/dreamidv /workspace/ckpts/wan2.1 /workspace/ckpts/dwpose /workspace/tmp

# === Runtime ===
# Path defaults — match where the bootstrap puts things.
ENV WEIGHTS_DIR=/workspace/ckpts \
    DREAMIDV_DIR=/root/dreamidv \
    OUTPUT_DIR=/workspace/tmp \
    PORT=8000

# Production-default optimizations validated 2026-05-27 (clean steady-state
# re-measurement; supersedes the 2026-05-26 +10% figure that folded in compile cost):
#   DREAMIDV_TORCH_COMPILE=default → +14% diffusion speedup vs eager
#     (4.10 vs 4.78 s/it at frame_num=81), visually identical output, locked.
#     max-autotune / reduce-overhead are DEAD (CUDA graphs incompatible with
#     our per-swap noise tensor allocation). Compile-time ceiling reached.
#
# HARDEN_WEIGHTS_R2 defaults to 0 since the security refactor 2026-05-27:
# pod no longer holds R2 credentials by default (output uploads go via the
# worker proxy at WORKER_UPLOAD_URL). Weights load from HuggingFace at boot
# (~6 min cold). To re-enable the R2 weights fast-path (~30s cold), set
# HARDEN_WEIGHTS_R2=1 AND inject a READ-ONLY token scoped to models/ only —
# never inject a token with write access or access to other prefixes.
ENV DREAMIDV_TORCH_COMPILE=default \
    HARDEN_WEIGHTS_R2=0 \
    R2_BUCKET=mainfeed-content \
    R2_OUTPUT_PREFIX=generated/ \
    R2_WEIGHTS_PREFIX=models/ \
    WORKER_UPLOAD_URL=https://api.mainfeed.app/api/swap/upload

# Tenant-specific env (must be supplied at pod-spin time, NOT baked into image):
#   SWAP_POD_SECRET                                      — required (pod auths to worker)
#   R2_ACCOUNT_ID                                        — required ONLY if HARDEN_WEIGHTS_R2=1
#   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY               — required ONLY if HARDEN_WEIGHTS_R2=1
# (R2_ACCOUNT_ID is no longer baked into the image — keeps the image tenant-agnostic
#  and avoids embedding the Cloudflare account identifier in a public GHCR layer.)

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["python", "/root/swap_server.py"]

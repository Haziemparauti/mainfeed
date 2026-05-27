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
#     --sample_steps 16 --sample_guide_scale_img 4.0 --size 832x480

FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

# === System deps ===
RUN apt-get update -qq && apt-get install -y -qq \
      ffmpeg libcudnn9-cuda-12 unzip wget git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# === Clone DreamID-V at pinned commit ===
# Source: Haziemparauti/DreamID-V (fork of bytedance/DreamID-V) — pinned to the
# exact commit validated on 2026-05-25 against cop_s07_coffee_plaza_f. Fork
# insulates the production build from upstream rebase / delete / license shift.
ARG DREAMIDV_REPO=https://github.com/Haziemparauti/DreamID-V.git
ARG DREAMIDV_SHA=9b589940577559c91481fb3a13bae000a55f97a1
RUN git clone $DREAMIDV_REPO /root/dreamidv \
    && cd /root/dreamidv && git checkout $DREAMIDV_SHA

WORKDIR /root/dreamidv

# === Patch upstream quirks (carry forward from last session's install run) ===
# 1. requirements.txt has `mediapipe==0.10.5#numpy must < 2.0` — invalid PEP 440 (missing space before #)
# 2. flash_attn install conflicts with default torch — install separately with --no-build-isolation
RUN sed -i 's|mediapipe==0.10.5#numpy|mediapipe==0.10.5  # numpy|' requirements.txt \
    && sed -i '/^flash_attn/d' requirements.txt

# === Python deps (order matters — pin torch back AFTER face-alignment downgrades it) ===
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir decord
RUN pip install --no-cache-dir packaging ninja \
    && pip install --no-cache-dir flash_attn --no-build-isolation

# Replace stock onnxruntime (CPU only) with onnxruntime-gpu so DreamID-V's DWPose
# pose+mask preprocessing runs on the GPU. CPU-ORT does ~5-8s per frame on RTX A6000;
# GPU-ORT brings it to <1s per frame (~10x speedup on the dominant per-swap cost).
RUN pip uninstall -y onnxruntime onnxruntime-gpu 2>/dev/null || true \
    && pip install --no-cache-dir onnxruntime-gpu

RUN pip install --no-cache-dir fastapi 'uvicorn[standard]' httpx boto3 huggingface_hub

# === Post-swap branding (caption + watermark burn-in via Pillow + FFmpeg) ===
# Pillow renders the overlay PNG; FFmpeg composites it onto every frame.
# cairosvg rasterizes the real Mainfeed brand SVG at pod startup so the
# watermark uses the actual brand mark (not a programmatic approximation).
RUN apt-get update -qq && apt-get install -y -qq libcairo2 && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir Pillow cairosvg

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
# swap_server.py imports dreamidv_runtime at startup — both must ship.
# render_overlay.py burns caption + watermark into each MP4 (caption Anton,
# watermark Inter Medium per pod/render_overlay.py).
COPY swap_server.py      /root/swap_server.py
COPY dreamidv_runtime.py /root/dreamidv_runtime.py
COPY render_overlay.py   /root/render_overlay.py
COPY precompute_pose.py  /root/precompute_pose.py

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
#   HARDEN_WEIGHTS_R2=1 → ensure_weights() pulls from R2 mirror (~30s, fast)
#     instead of HuggingFace (~6 min, slow), per pod/README.md.
# These can be overridden at container/pod-spin time if a future test needs
# eager mode or HuggingFace fallback. spin_new_pod.sh re-writes them into
# pod_env.sh redundantly (same value, harmless).
ENV DREAMIDV_TORCH_COMPILE=default \
    HARDEN_WEIGHTS_R2=1 \
    R2_ACCOUNT_ID=1107173d768105bad60ebb40ff28ef3d \
    R2_BUCKET=mainfeed-content \
    R2_OUTPUT_PREFIX=generated/ \
    R2_WEIGHTS_PREFIX=models/

# Secret env vars (must be supplied at pod-spin time, NOT baked into image):
#   SWAP_POD_SECRET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["python", "/root/swap_server.py"]

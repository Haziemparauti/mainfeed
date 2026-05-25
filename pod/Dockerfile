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
RUN pip install --no-cache-dir fastapi 'uvicorn[standard]' httpx boto3

# === Server code ===
COPY swap_server.py /root/swap_server.py
COPY precompute_pose.py /root/precompute_pose.py

# === Workspace for weights + temp inference files (mounted as volume in prod) ===
RUN mkdir -p /workspace/ckpts/dreamidv /workspace/ckpts/wan2.1 /workspace/ckpts/dwpose /workspace/tmp

# === Runtime ===
ENV WEIGHTS_DIR=/workspace/ckpts \
    DREAMIDV_DIR=/root/dreamidv \
    OUTPUT_DIR=/workspace/tmp \
    PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["python", "/root/swap_server.py"]

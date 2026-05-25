#!/usr/bin/env bash
# One-time prep — mirror all DreamID-V + Wan-2.1 + DWPose weights from HuggingFace
# to our R2 `mainfeed-content/models/` bucket. After running this, Docker images
# built with HARDEN_WEIGHTS_R2=1 will pull from R2 instead of HuggingFace
# (insulates against upstream deletion / repo rename / HF rate limits).
#
# Pre-req: wrangler is OAuth-authed to the Cloudflare account that owns
#          mainfeed-content (Account ID 1107173d768105bad60ebb40ff28ef3d).
#
# Total transfer: ~14 GB. Time: ~30 min depending on bandwidth.
# R2 storage cost: ~$0.21/month for 14 GB at $0.015/GB.

set -euo pipefail

WORK=${WORK:-/tmp/mainfeed-weights-mirror}
mkdir -p "$WORK"
cd "$WORK"

declare -A FILES=(
  ["dreamidv_faster.pth"]="https://huggingface.co/XuGuo699/DreamID-V/resolve/main/dreamidv_faster.pth"
  ["Wan2.1_VAE.pth"]="https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/main/Wan2.1_VAE.pth"
  ["models_t5_umt5-xxl-enc-bf16.pth"]="https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/main/models_t5_umt5-xxl-enc-bf16.pth"
  ["diffusion_pytorch_model.safetensors"]="https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/main/diffusion_pytorch_model.safetensors"
  ["wan_config.json"]="https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/main/config.json"
  ["dw-ll_ucoco_384.onnx"]="https://huggingface.co/yzd-v/DWPose/resolve/main/dw-ll_ucoco_384.onnx"
  ["yolox_l.onnx"]="https://huggingface.co/yzd-v/DWPose/resolve/main/yolox_l.onnx"
)

for filename in "${!FILES[@]}"; do
  url="${FILES[$filename]}"
  if [ ! -f "$filename" ] || [ "$(stat -c%s "$filename" 2>/dev/null || stat -f%z "$filename")" -lt 1024 ]; then
    echo "[mirror] downloading $filename"
    wget -q --show-progress "$url" -O "$filename"
  else
    echo "[mirror] $filename already present, skipping"
  fi
done

for filename in "${!FILES[@]}"; do
  echo "[mirror] uploading $filename → r2://mainfeed-content/models/$filename"
  npx wrangler r2 object put "mainfeed-content/models/$filename" \
    --file "$filename" \
    --remote
done

echo
echo "Mirror complete. Public URLs (if bucket is configured for public access):"
echo "  https://mainfeed-content.r2.cloudflarestorage.com/models/<filename>"
echo
echo "To use the mirror in the pod, build the Docker image with:"
echo "  --build-arg HARDEN_WEIGHTS_R2=1 \\"
echo "  --build-arg R2_PUBLIC_PREFIX=https://mainfeed-content.r2.cloudflarestorage.com/models"

"""
In-process Flux.1-schnell + PuLID-FLUX runtime wrapper.

Parallel to dreamidv_runtime.py — loads Flux + PuLID once at process startup,
keeps it warm in GPU memory, exposes a synchronous generate_image() per request.

Used by the 10/day cosplay-image quota path (see
[[mainfeed_image_library_architecture]]). 1:1 square at 1024x1024, JPEG output.
Watermark-only burn-in (NO captions — captions are video-format-only).

Architecture:
  - PuLID's pipeline_flux.py expects weight files at RELATIVE paths under
    PULID_DIR/models/. We chdir to PULID_DIR during init() only, then chdir
    back so dreamidv_runtime's own chdir(DREAMIDV_DIR) at its init() works.
  - Heavy weights (Flux base 24 GB + AE 0.3 GB + PuLID adapter 0.7 GB) live
    under WEIGHTS_DIR/flux_pulid/ (canonical). We symlink PULID_DIR/models ->
    WEIGHTS_DIR/flux_pulid/ before chdir so PuLID's relative path lookups
    resolve there. antelopev2 + EVA-CLIP + xflux T5 + CLIP-L are downloaded
    on-demand by PuLID itself on first init (cheap, ~280 MB + HF cache).
  - offload=True throughout: T5/CLIP/PuLID/Flux/AE rotate between CPU and GPU
    per phase. Required even on 48 GB cards when DreamID-V is also resident
    (Flux 24 GB + DreamID-V 17 GB + T5 10 GB > 48 GB without offload).

Usage:
    import flux_pulid_runtime
    flux_pulid_runtime.init(
        weights_dir="/workspace/ckpts",
        pulid_dir="/root/pulid",
    )
    flux_pulid_runtime.generate_image(
        selfie_path="/path/to/selfie.jpg",
        prompt="movie poster, action hero, ...",
        out_jpg="/path/to/output.jpg",
        seed=42,
    )

Both init() and generate_image() are synchronous (single GPU = single worker —
serialize via swap_server's asyncio.Lock alongside DreamID-V).
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

_GENERATOR = None       # PuLID FluxGenerator-equivalent instance, loaded once
_DENOISE = None         # flux.sampling.denoise
_GET_NOISE = None       # flux.sampling.get_noise
_GET_SCHEDULE = None    # flux.sampling.get_schedule
_PREPARE = None         # flux.sampling.prepare
_UNPACK = None          # flux.sampling.unpack
_SAMPLING_OPTIONS = None  # flux.util.SamplingOptions
_RESIZE_LONG = None     # pulid.utils.resize_numpy_image_long
_DEVICE = None          # torch.device
_OFFLOAD = True
_INITIALIZED = False

# Output format: 1024x1024 square locked per [[mainfeed_image_library_architecture]].
# Flux accepts any multiple of 16; 1024 is well-tested and lands on the trained scale.
OUTPUT_W = 1024
OUTPUT_H = 1024

# Flux.1-schnell is a turbo model — 4 steps suffice for full denoise.
# (Flux.1-dev uses 20-28 steps. We picked schnell explicitly for Apache 2.0
# license + 4-step economics: ~$0.003/image vs ~$0.012 on dev.)
DEFAULT_NUM_STEPS = 4
# guidance >1 is "fake CFG" (uses Flux's embedded classifier-free guidance,
# no extra forward passes). PuLID recommends 4.0 for photorealistic scenes.
DEFAULT_GUIDANCE = 4.0
# id_weight: how strongly to inject the user's identity. 1.0 is PuLID's default
# and what the example prompts in app_flux.py use.
DEFAULT_ID_WEIGHT = 1.0
# start_step: at which denoise step to begin ID injection. 0 = inject from
# the very first step (highest fidelity). Recommended 0-1 for photorealistic
# (cosplay) scenes per PuLID docs.
DEFAULT_START_STEP = 0


def is_ready() -> bool:
    """True if init() has completed and the pipeline is warm."""
    return _INITIALIZED and _GENERATOR is not None


def init(weights_dir: str, pulid_dir: str, device_id: int = 0,
         offload: bool = True, version: str = "v0.9.1") -> None:
    """
    Load Flux + PuLID once. Subsequent generate_image() calls reuse the warm
    pipeline.

    Args:
        weights_dir: root dir containing flux_pulid/ subdir with
            flux1-schnell.safetensors + ae.safetensors + pulid_flux_*.safetensors.
        pulid_dir: path to the PuLID git checkout (we add it to sys.path so its
            flux + pulid + eva_clip packages import).
        device_id: CUDA device index. 0 for single-GPU pods.
        offload: shuttle T5/CLIP/PuLID/Flux/AE between CPU and GPU per phase.
            Required when DreamID-V is also resident on the same GPU.
        version: PuLID adapter version string. v0.9.1 is the latest stable.
    """
    global _GENERATOR, _DENOISE, _GET_NOISE, _GET_SCHEDULE, _PREPARE, _UNPACK
    global _SAMPLING_OPTIONS, _RESIZE_LONG, _DEVICE, _OFFLOAD, _INITIALIZED

    if _INITIALIZED:
        logging.info("[flux_pulid_runtime] already initialized; skipping reload")
        return

    import torch

    pulid_dir = str(pulid_dir)
    weights_dir = str(weights_dir)
    flux_pulid_weights = Path(weights_dir) / "flux_pulid"
    flux_pulid_weights.mkdir(parents=True, exist_ok=True)

    # PuLID hardcodes relative paths like 'models/antelopev2/...' and
    # 'models/pulid_flux_v0.9.1.safetensors'. Make PULID_DIR/models point at
    # our canonical weights dir so PuLID's lookups resolve to pre-staged files
    # (and any HF auto-downloads land in the same canonical place).
    pulid_models_link = Path(pulid_dir) / "models"
    _ensure_symlink(pulid_models_link, flux_pulid_weights)

    # Add PuLID repo to sys.path so its flux/, pulid/, eva_clip/ packages import.
    if pulid_dir not in sys.path:
        sys.path.insert(0, pulid_dir)

    # PuLID's loaders read FLUX_SCHNELL + AE env vars for the schnell variant's
    # base + autoencoder ckpts. Set them to our pre-staged files.
    flux_ckpt = flux_pulid_weights / "flux1-schnell.safetensors"
    ae_ckpt = flux_pulid_weights / "ae.safetensors"
    os.environ["FLUX_SCHNELL"] = str(flux_ckpt)
    os.environ["AE"] = str(ae_ckpt)

    # chdir into PULID_DIR for the init phase only. PuLID's pipeline_flux.py
    # uses relative paths during construction (snapshot_download/hf_hub_download
    # with local_dir='models'). After init, the loaded model objects hold their
    # weights in memory — no further cwd-relative reads — so we restore cwd.
    prev_cwd = os.getcwd()
    os.chdir(pulid_dir)
    logging.info(f"[flux_pulid_runtime] chdir → {pulid_dir} (temporary, for init)")

    try:
        # Lazy-import here so the module can be imported without PuLID's tree
        # on disk (testing / CI lint).
        from flux.sampling import denoise, get_noise, get_schedule, prepare, unpack
        from flux.util import (
            SamplingOptions, load_ae, load_clip, load_flow_model, load_t5,
        )
        from pulid.pipeline_flux import PuLIDPipeline
        from pulid.utils import resize_numpy_image_long

        _DENOISE = denoise
        _GET_NOISE = get_noise
        _GET_SCHEDULE = get_schedule
        _PREPARE = prepare
        _UNPACK = unpack
        _SAMPLING_OPTIONS = SamplingOptions
        _RESIZE_LONG = resize_numpy_image_long

        device = torch.device(f"cuda:{device_id}" if torch.cuda.is_available() else "cpu")
        _DEVICE = device
        _OFFLOAD = offload

        logging.info(f"[flux_pulid_runtime] device={device} offload={offload}")

        # Load Flux base + AE + T5 + CLIP. With offload=True, heavy modules
        # stage on CPU initially and shuttle to GPU per-call.
        cpu_or_gpu = "cpu" if offload else str(device)
        logging.info("[flux_pulid_runtime] loading T5 (xlabs-ai/xflux_text_encoders, max_length=128)...")
        t5 = load_t5(device, max_length=128)
        logging.info("[flux_pulid_runtime] loading CLIP (openai/clip-vit-large-patch14)...")
        clip = load_clip(device)
        logging.info("[flux_pulid_runtime] loading Flux.1-schnell base model (bf16)...")
        flux_model = load_flow_model("flux-schnell", device=cpu_or_gpu)
        flux_model.eval()
        logging.info("[flux_pulid_runtime] loading AE (autoencoder)...")
        ae = load_ae("flux-schnell", device=cpu_or_gpu)

        # PuLIDPipeline wraps the Flux model with cross-attention adapters that
        # inject the user's identity embedding. ID encoder + EVA-CLIP backbone
        # + InsightFace antelopev2 face detector are loaded inside __init__.
        logging.info("[flux_pulid_runtime] constructing PuLIDPipeline (loads ID encoder + EVA-CLIP + antelopev2)...")
        pulid_model = PuLIDPipeline(
            flux_model,
            device="cpu" if offload else device,
            weight_dtype=torch.bfloat16,
            onnx_provider="gpu",
        )
        if offload:
            # PuLID expects face_helper components on GPU even when the rest is
            # offloaded (mirrors app_flux.py:48-52).
            pulid_model.face_helper.face_det.mean_tensor = (
                pulid_model.face_helper.face_det.mean_tensor.to(torch.device("cuda"))
            )
            pulid_model.face_helper.face_det.device = torch.device("cuda")
            pulid_model.face_helper.device = torch.device("cuda")
            pulid_model.device = torch.device("cuda")

        # Load PuLID adapter weights (pulid_flux_v0.9.1.safetensors). hf_hub_download
        # inside load_pretrain uses local_dir='models' — our symlink makes that
        # resolve to flux_pulid_weights/, so if pre-staged it's a no-op.
        pulid_ckpt_path = str(flux_pulid_weights / f"pulid_flux_{version}.safetensors")
        logging.info(f"[flux_pulid_runtime] loading PuLID adapter ({version}) from {pulid_ckpt_path}")
        pulid_model.load_pretrain(pulid_ckpt_path, version=version)

        # Stash everything on a single namespace object for clean access in
        # generate_image(). Mirrors the FluxGenerator class in PuLID's app_flux.py.
        class _Gen:
            pass
        _GENERATOR = _Gen()
        _GENERATOR.t5 = t5
        _GENERATOR.clip = clip
        _GENERATOR.model = flux_model
        _GENERATOR.ae = ae
        _GENERATOR.pulid_model = pulid_model
        _GENERATOR.offload = offload
        _GENERATOR.device = device

        _INITIALIZED = True
        logging.info("[flux_pulid_runtime] pipeline loaded; ready for image generation")
    finally:
        os.chdir(prev_cwd)
        logging.info(f"[flux_pulid_runtime] chdir restored → {prev_cwd}")


def _ensure_symlink(link: Path, target: Path) -> None:
    """Make sure `link` is a symlink to `target`. Idempotent."""
    target = target.resolve()
    if link.exists() or link.is_symlink():
        try:
            if link.is_symlink() and Path(os.readlink(link)).resolve() == target:
                return
        except OSError:
            pass
        # exists but wrong — remove and re-link
        if link.is_dir() and not link.is_symlink():
            # already a real dir, don't blow it away — caller staged into the wrong place
            logging.warning(f"[flux_pulid_runtime] {link} is a real directory (not symlink); not modifying")
            return
        link.unlink()
    link.symlink_to(target, target_is_directory=True)
    logging.info(f"[flux_pulid_runtime] symlink {link} → {target}")


# @torch.inference_mode() is CRITICAL here — without it PyTorch retains
# autograd metadata for every activation during the forward pass, roughly
# DOUBLING peak VRAM at Flux's attention scale (4500-token seq × 24 heads
# × 19+38 blocks). Caught 2026-05-27 night after the A6000 OOMed at 47 GB
# during a denoise phase that should have peaked under 30 GB.
# PuLID's reference app_flux.py has the same decorator on its generate_image.
def _torch_inference_mode_decorator(fn):
    import torch
    return torch.inference_mode()(fn)


@_torch_inference_mode_decorator
def generate_image(
    selfie_path: str,
    prompt: str,
    out_jpg: str,
    seed: int = 42,
    num_steps: int = DEFAULT_NUM_STEPS,
    guidance: float = DEFAULT_GUIDANCE,
    id_weight: float = DEFAULT_ID_WEIGHT,
    start_step: int = DEFAULT_START_STEP,
    width: int = OUTPUT_W,
    height: int = OUTPUT_H,
    max_sequence_length: int = 128,
    aggressive_offload: bool = False,
) -> str:
    """
    Generate one cosplay image from a selfie + prompt.

    Mirrors FluxGenerator.generate_image in PuLID's app_flux.py at the same
    seed so output matches the reference implementation.

    Args:
        selfie_path: path to user's selfie (jpg/png). Must contain a face.
        prompt: filled prompt string. Length capped at 128 tokens (T5
            max_sequence_length) — keep concise.
        out_jpg: where to write the output JPEG.
        seed: deterministic seed. Use the request_id hash to spread across
            users, or 42 for golden-path tests.
        num_steps: diffusion steps. 4 for schnell (turbo).
        guidance: classifier-free guidance scale. 4.0 photorealistic default.
        id_weight: identity injection strength. 1.0 = PuLID default.
        start_step: which denoise step to begin injecting ID. 0 = from start
            (highest fidelity).
        width, height: output resolution. 1024x1024 default (1:1 locked).
        max_sequence_length: T5 token cap. 128 = balance of detail vs speed.

    Returns:
        Path to the output JPEG.
    """
    if not _INITIALIZED or _GENERATOR is None:
        raise RuntimeError("flux_pulid_runtime.init() must be called before generate_image()")

    import time as _time
    import numpy as np
    import torch
    from PIL import Image
    from einops import rearrange

    _t_start = _time.perf_counter()

    gen = _GENERATOR
    device = gen.device
    offload = gen.offload

    # Update T5 max length on every call (PuLID's app_flux.py does this too).
    gen.t5.max_length = max_sequence_length

    # === Load + preprocess selfie ===
    _t_pre_start = _time.perf_counter()
    selfie_pil = Image.open(selfie_path).convert("RGB")
    id_image = np.asarray(selfie_pil)  # H x W x 3, uint8, RGB
    id_image = _RESIZE_LONG(id_image, 1024)  # PuLID expects long-side 1024
    _t_pre_elapsed = _time.perf_counter() - _t_pre_start
    print(f"[PHASE] flux_pulid preprocess elapsed={_t_pre_elapsed:.2f}s", flush=True)

    # === Build sampling options ===
    opts = _SAMPLING_OPTIONS(
        prompt=prompt,
        width=width,
        height=height,
        num_steps=num_steps,
        guidance=guidance,
        seed=int(seed),
    )

    # === Prepare initial noise + timesteps (mirrors app_flux.py:84-104) ===
    _t_text_start = _time.perf_counter()
    x = _GET_NOISE(
        1, opts.height, opts.width,
        device=device, dtype=torch.bfloat16, seed=opts.seed,
    )
    timesteps = _GET_SCHEDULE(
        opts.num_steps,
        x.shape[-1] * x.shape[-2] // 4,
        shift=True,
    )

    # === Text embedding (T5 + CLIP on GPU during this phase) ===
    if offload:
        gen.t5, gen.clip = gen.t5.to(device), gen.clip.to(device)
    inp = _PREPARE(t5=gen.t5, clip=gen.clip, img=x, prompt=opts.prompt)
    _t_text_elapsed = _time.perf_counter() - _t_text_start
    print(f"[PHASE] flux_pulid text_embed elapsed={_t_text_elapsed:.2f}s", flush=True)

    # === ID embedding (PuLID components on GPU during this phase) ===
    _t_id_start = _time.perf_counter()
    if offload:
        gen.t5, gen.clip = gen.t5.cpu(), gen.clip.cpu()
        torch.cuda.empty_cache()
        gen.pulid_model.components_to_device(torch.device("cuda"))

    id_embeddings, _uncond_id_embeddings = gen.pulid_model.get_id_embedding(
        id_image, cal_uncond=False,
    )
    _t_id_elapsed = _time.perf_counter() - _t_id_start
    print(f"[PHASE] flux_pulid id_embed elapsed={_t_id_elapsed:.2f}s", flush=True)

    # === Denoise (Flux DiT on GPU during this phase) ===
    # Two offload strategies:
    #   - aggressive_offload=False (default, ~48 GB cards): whole Flux model
    #     on GPU during denoise. ~24 GB params + 2 GB workspace = 26 GB peak.
    #   - aggressive_offload=True (24 GB cards): Flux's transformer blocks
    #     shuttle CPU↔GPU one-at-a-time during denoise. ~3-4 GB peak. 5-10x
    #     slower per step but only path that fits 24 GB cards.
    _t_diff_start = _time.perf_counter()
    if offload:
        gen.pulid_model.components_to_device(torch.device("cpu"))
        torch.cuda.empty_cache()
        if aggressive_offload:
            gen.model.components_to_gpu()  # PuLID's Flux class supports this
        else:
            gen.model = gen.model.to(device)

    x = _DENOISE(
        gen.model, **inp,
        timesteps=timesteps,
        guidance=opts.guidance,
        id=id_embeddings,
        id_weight=id_weight,
        start_step=start_step,
        uncond_id=None,
        true_cfg=1.0,
        timestep_to_start_cfg=1,
        neg_txt=None, neg_txt_ids=None, neg_vec=None,
        aggressive_offload=aggressive_offload,
    )
    _t_diff_elapsed = _time.perf_counter() - _t_diff_start
    print(f"[PHASE] flux_pulid denoise steps={num_steps} elapsed={_t_diff_elapsed:.2f}s", flush=True)

    # === VAE decode (AE.decoder on GPU during this phase) ===
    _t_dec_start = _time.perf_counter()
    if offload:
        gen.model.cpu()
        torch.cuda.empty_cache()
        gen.ae.decoder.to(x.device)

    x = _UNPACK(x.float(), opts.height, opts.width)
    with torch.autocast(device_type=device.type, dtype=torch.bfloat16):
        x = gen.ae.decode(x)

    if offload:
        gen.ae.decoder.cpu()
        torch.cuda.empty_cache()
    _t_dec_elapsed = _time.perf_counter() - _t_dec_start
    print(f"[PHASE] flux_pulid vae_decode elapsed={_t_dec_elapsed:.2f}s", flush=True)

    # === Save JPEG ===
    _t_save_start = _time.perf_counter()
    x = x.clamp(-1, 1)
    x = rearrange(x[0], "c h w -> h w c")
    img = Image.fromarray((127.5 * (x + 1.0)).cpu().byte().numpy())
    # JPEG quality 92 is a sweet spot for photographic content — visually
    # indistinguishable from quality=95 but ~20% smaller files.
    out_path = Path(out_jpg)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out_path), format="JPEG", quality=92, optimize=True)
    _t_save_elapsed = _time.perf_counter() - _t_save_start
    _t_total_elapsed = _time.perf_counter() - _t_start
    print(f"[PHASE] flux_pulid save elapsed={_t_save_elapsed:.2f}s", flush=True)
    print(f"[PHASE] TOTAL generate_image={_t_total_elapsed:.2f}s  "
          f"(pre={_t_pre_elapsed:.1f}s text={_t_text_elapsed:.1f}s id={_t_id_elapsed:.1f}s "
          f"diff={_t_diff_elapsed:.1f}s dec={_t_dec_elapsed:.1f}s save={_t_save_elapsed:.1f}s)",
          flush=True)

    return str(out_path)

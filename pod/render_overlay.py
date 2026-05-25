"""
Mainfeed video branding — burns caption + watermark INTO the swapped MP4
so the brand survives a download/share to TikTok/IG.

Layout (no background bars or fills — pure transparent text + logo):
  • watermark band at Y=10% of video height: logo (square gradient + "M")
    followed by "Mainfeed.app · @handle" text, centered horizontally
  • caption at Y=18%: big uppercase multi-line meme caption, centered

Both use a multi-direction black stroke around white fill so they survive
cross-platform recompression and stay readable on any frame content.

Logo is rendered programmatically from the Mainfeed brand-kit colors so
the pod has zero external image assets to manage — just an Anton TTF.
"""

from __future__ import annotations
import io
import subprocess
import textwrap
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

# cairosvg rasterizes the real Mainfeed brand SVG at startup so the watermark
# uses the actual logo (gradient + custom "M") rather than a programmatic
# approximation. Linux-only; the Dockerfile installs libcairo2 + cairosvg.
import cairosvg


# ============ config (tweak to retune layout) ============

# Anton = display font for the meme CAPTION (bold condensed, classic meme).
# Simplex Sans = clean geometric display sans for the WATERMARK pill. SIL OFL.
# Single Regular weight (no Bold ship). Designed for display sizes; safe at
# our supersampled render (3× → effective 39px, downsampled to 13px final).
CAPTION_FONT_PATH = "/app/assets/Anton.ttf"
WATERMARK_FONT_PATH = "/app/assets/SimplexSans-Regular.ttf"

# Watermark layout — small sharp chip with gradient border (top-center).
# Supersampling factor: render at 3× target size then LANCZOS-downsample
# for crisp small text (Pillow renders < 20px text poorly at native).
WATERMARK_Y_PCT = 0.10
WATERMARK_LOGO_PCT = 0.022   # logo height as fraction of video height
WATERMARK_TEXT_PCT = 0.016   # watermark text height as fraction of video height
WATERMARK_PILL_HORIZONTAL_PAD_PX = 6
WATERMARK_PILL_VERTICAL_PAD_PX = 3
WATERMARK_PILL_GAP_PX = 5
WATERMARK_PILL_BORDER_PX = 1
WATERMARK_PILL_RADIUS_PX = 6         # fixed corner radius (was: pill_h/2 = stadium)
WATERMARK_PILL_BG = (0, 0, 0, 175)
WATERMARK_SUPERSAMPLE = 4            # render at N× then LANCZOS-downsample for AA

# Caption layout — back to TOP, just under the pill, slightly smaller than v1
CAPTION_Y_PCT = 0.15        # just below pill (pill center=10%, pill_h ~24px on 832h)
CAPTION_TEXT_PCT = 0.030    # was 0.035 — slightly smaller per user feedback
CAPTION_LINE_SPACING_PCT = 0.010
CAPTION_STROKE = 3
CAPTION_HORIZONTAL_PAD_PCT = 0.04

# Logo source SVG (the real Mainfeed brand mark) + render quality. We
# rasterize the SVG once at LOGO_HIRES_SIZE then LANCZOS-downsample for
# each watermark draw — sharp at any size.
LOGO_SVG_PATH = "/app/assets/logo-square2.svg"
LOGO_HIRES_SIZE = 512

# Mainfeed brand-kit gradient (dark navy → deep blue → teal → gold)
BRAND_COLORS = [
    (0, 11, 33),     # #000b21
    (0, 63, 130),    # #003f82
    (76, 162, 181),  # #4ca2b5
    (255, 210, 127), # #ffd27f
]


# ============ logo (rasterized from the real Mainfeed brand SVG) ============

# BRAND_COLORS is kept as a constant in case we want a programmatic fallback,
# but the live logo path uses cairosvg + the actual brand SVG, not these.

@lru_cache(maxsize=1)
def _make_logo_hires() -> Image.Image:
    """Rasterize the brand SVG ONCE at high resolution; downsample per-watermark."""
    png_bytes = cairosvg.svg2png(
        url=LOGO_SVG_PATH,
        output_width=LOGO_HIRES_SIZE,
        output_height=LOGO_HIRES_SIZE,
    )
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def make_logo(size: int) -> Image.Image:
    """Return the logo downsampled to `size`×`size` with LANCZOS — sharp at any scale."""
    hi = _make_logo_hires()
    return hi.resize((size, size), Image.LANCZOS)


# ============ gradient-bordered watermark pill ============

def _interp_brand(t: float) -> Tuple[int, int, int]:
    """Sample the 4-stop brand gradient at position t in [0, 1]."""
    if t <= 0: return BRAND_COLORS[0]
    if t >= 1: return BRAND_COLORS[-1]
    n = len(BRAND_COLORS) - 1
    seg = t * n
    i = int(seg)
    f = seg - i
    a = BRAND_COLORS[i]
    b = BRAND_COLORS[i + 1]
    return (
        int(a[0] * (1 - f) + b[0] * f),
        int(a[1] * (1 - f) + b[1] * f),
        int(a[2] * (1 - f) + b[2] * f),
    )


def _make_gradient_strip(width: int, height: int) -> Image.Image:
    """Horizontal brand-gradient strip used as the pill's outer border source."""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    px = img.load()
    for x in range(width):
        r, g, b = _interp_brand(x / max(1, width - 1))
        for y in range(height):
            px[x, y] = (r, g, b, 255)
    return img


def render_watermark_pill(handle: str, video_h: int) -> Image.Image:
    """
    Build a self-contained transparent RGBA pill: gradient-stroked rounded
    rectangle, logo on left, "Mainfeed.app · @handle" text on right, all
    centered vertically inside.

    Internal pipeline:
      - Compute target final dimensions from video height
      - Render the entire pill at WATERMARK_SUPERSAMPLE × target size
      - LANCZOS-downsample to target — gives sharp text at small sizes
        where Pillow's native rendering produces fuzzy glyphs
    """
    ss = WATERMARK_SUPERSAMPLE
    target_text_size = max(10, int(video_h * WATERMARK_TEXT_PCT))
    target_logo_size = max(12, int(video_h * WATERMARK_LOGO_PCT))

    # Scaled-up working sizes for rendering
    text_size = target_text_size * ss
    logo_size = target_logo_size * ss
    pad_x = WATERMARK_PILL_HORIZONTAL_PAD_PX * ss
    pad_y = WATERMARK_PILL_VERTICAL_PAD_PX * ss
    gap = WATERMARK_PILL_GAP_PX * ss
    bp = WATERMARK_PILL_BORDER_PX * ss
    radius = WATERMARK_PILL_RADIUS_PX * ss

    text = f"Mainfeed.app · @{handle}"
    font = ImageFont.truetype(WATERMARK_FONT_PATH, text_size)

    tmp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    text_w = int(tmp_draw.textlength(text, font=font))
    asc, desc = font.getmetrics()
    text_h = asc + desc

    inner_h = max(logo_size, text_h)
    inner_w = logo_size + gap + text_w
    pill_w = inner_w + 2 * pad_x
    pill_h = inner_h + 2 * pad_y

    pill = Image.new("RGBA", (pill_w, pill_h), (0, 0, 0, 0))

    # Gradient border = brand gradient masked by an outer-minus-inner ring
    gradient = _make_gradient_strip(pill_w, pill_h)
    ring_mask = Image.new("L", (pill_w, pill_h), 0)
    rd = ImageDraw.Draw(ring_mask)
    rd.rounded_rectangle((0, 0, pill_w - 1, pill_h - 1), radius=radius, fill=255)
    rd.rounded_rectangle(
        (bp, bp, pill_w - 1 - bp, pill_h - 1 - bp),
        radius=max(1, radius - bp), fill=0,
    )
    pill.paste(gradient, (0, 0), ring_mask)

    # Black interior fill (inside the gradient ring)
    interior = Image.new("RGBA", (pill_w, pill_h), (0, 0, 0, 0))
    ImageDraw.Draw(interior).rounded_rectangle(
        (bp, bp, pill_w - 1 - bp, pill_h - 1 - bp),
        radius=max(1, radius - bp), fill=WATERMARK_PILL_BG,
    )
    pill = Image.alpha_composite(pill, interior)

    # Logo on left (rendered at the supersampled logo_size — make_logo already
    # downsamples from its 512px cache)
    logo = make_logo(logo_size)
    logo_y = (pill_h - logo_size) // 2
    pill.paste(logo, (pad_x, logo_y), logo)

    # Text on right, optically centered
    text_x = pad_x + logo_size + gap
    text_y = (pill_h - text_h) // 2 - desc // 4
    ImageDraw.Draw(pill).text(
        (text_x, text_y), text, font=font, fill=(255, 255, 255, 255)
    )

    # Downsample to the final display size
    final_w = pill_w // ss
    final_h = pill_h // ss
    return pill.resize((final_w, final_h), Image.LANCZOS)


# ============ video probing ============

def probe_dimensions(video_path: Path) -> Tuple[int, int]:
    """Return (width, height) of the first video stream using ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0",
        str(video_path),
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()
    w, h = (int(x) for x in out.split(","))
    return w, h


# ============ overlay rendering ============

def _wrap_caption(caption: str, font: ImageFont.ImageFont,
                  max_text_width_px: float, draw: ImageDraw.ImageDraw) -> list[str]:
    """Greedy word-wrap so each line ≤ max_text_width_px when rendered."""
    words = caption.upper().split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for w in words[1:]:
        trial = f"{current} {w}"
        if draw.textlength(trial, font=font) <= max_text_width_px:
            current = trial
        else:
            lines.append(current)
            current = w
    lines.append(current)
    return lines


def render_overlay_png(video_w: int, video_h: int,
                       handle: Optional[str], caption: Optional[str],
                       out_path: Path) -> Path:
    """
    Render a transparent RGBA PNG matching the video dimensions with the
    watermark + caption painted on. Areas without text are fully transparent
    so FFmpeg's `overlay` filter composes cleanly.
    """
    img = Image.new("RGBA", (video_w, video_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ===== Watermark pill (gradient-bordered black chip, top-center) =====
    if handle:
        pill = render_watermark_pill(handle, video_h)
        pill_x = (video_w - pill.width) // 2
        pill_y = int(video_h * WATERMARK_Y_PCT) - pill.height // 2
        img.paste(pill, (pill_x, pill_y), pill)

    # ===== Caption at Y=16%, multi-line, uppercase, centered =====
    if caption:
        cap_size = max(20, int(video_h * CAPTION_TEXT_PCT))
        cap_font = ImageFont.truetype(CAPTION_FONT_PATH, cap_size)
        pad = int(video_w * CAPTION_HORIZONTAL_PAD_PCT)
        max_w = video_w - 2 * pad
        lines = _wrap_caption(caption, cap_font, max_w, draw)
        line_h = cap_size + int(video_h * CAPTION_LINE_SPACING_PCT)
        cap_y0 = int(video_h * CAPTION_Y_PCT)
        for i, line in enumerate(lines):
            line_w = draw.textlength(line, font=cap_font)
            x = int((video_w - line_w) / 2)
            y = cap_y0 + i * line_h
            draw.text(
                (x, y), line,
                font=cap_font,
                fill=(255, 255, 255, 255),
                stroke_width=CAPTION_STROKE,
                stroke_fill=(0, 0, 0, 255),
            )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


# ============ FFmpeg burn-in ============

def burn_overlay(input_mp4: Path, overlay_png: Path, output_mp4: Path) -> None:
    """
    Re-encode `input_mp4` with `overlay_png` composited on every frame.
    libx264 / veryfast / crf 20 → quality matches DreamID-V's output without
    a meaningful size bump. movflags=+faststart so the file is streamable.
    """
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(input_mp4),
        "-i", str(overlay_png),
        "-filter_complex", "[0:v][1:v]overlay=0:0[v]",
        "-map", "[v]",
        "-map", "0:a?",   # audio is optional (DreamID-V output has none)
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "16",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        str(output_mp4),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


# ============ public entry point ============

def brand_video(swapped_mp4: Path, workdir: Path,
                handle: Optional[str], caption: Optional[str]) -> Path:
    """
    Take the raw DreamID-V output and produce a branded MP4 with caption +
    watermark burned into the frames. Returns the path to the branded file.

    If both `handle` and `caption` are falsy, returns `swapped_mp4` unchanged
    so callers can run unconditionally.
    """
    if not handle and not caption:
        return swapped_mp4

    width, height = probe_dimensions(swapped_mp4)
    overlay_png = workdir / "overlay.png"
    branded_mp4 = workdir / "branded.mp4"
    render_overlay_png(width, height, handle, caption, overlay_png)
    burn_overlay(swapped_mp4, overlay_png, branded_mp4)
    return branded_mp4

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
# DejaVu Sans Bold = clean bold sans for the WATERMARK. Pre-installed on
# the Ubuntu base via fonts-dejavu-core. Genuinely bold (no thin glyphs),
# Watermark = Inter Medium (premium SaaS sans, SIL OFL). DejaVu Bold read
# too bulky / "Linux defaults" at small video sizes; Inter Medium has
# refined letterforms that survive small-size rendering when paired with
# letter-spacing (`tracking`) — the same trick Stripe / Vercel use in UI.
CAPTION_FONT_PATH = "/app/assets/Anton.ttf"
WATERMARK_FONT_PATH = "/app/assets/Inter-Medium.ttf"

# Watermark layout — Inter Medium with tracking. Size bumped to compensate
# for the lighter weight (Medium 500 vs DejaVu Bold 700), so glyphs read
# as confidently large rather than thin-and-small.
WATERMARK_Y_PCT = 0.06              # vertical CENTER of pill
WATERMARK_LOGO_PCT = 0.026          # logo height / video height (unchanged)
WATERMARK_TEXT_PCT = 0.022          # was 0.018 (DejaVu Bold); Inter Medium needs more pixels
WATERMARK_LETTER_SPACING_EM = 0.025 # 2.5% of font size between chars — air = premium
WATERMARK_PILL_HORIZONTAL_PAD_PX = 7
WATERMARK_PILL_VERTICAL_PAD_PX = 4
WATERMARK_PILL_GAP_PX = 6
WATERMARK_PILL_BORDER_PX = 1
WATERMARK_PILL_RADIUS_PX = 7
WATERMARK_PILL_BG = (0, 0, 0, 175)
WATERMARK_SUPERSAMPLE = 4            # render at N× then LANCZOS-downsample for AA

# Caption layout — back to TOP, just under the pill (5% gap preserved)
CAPTION_Y_PCT = 0.11        # was 0.15 — moved up in lockstep with watermark
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


def _measure_tracked(draw: ImageDraw.ImageDraw, text: str,
                     font: ImageFont.ImageFont, ls_px: int) -> int:
    """Width of `text` rendered with `ls_px` pixels between each pair of chars."""
    if not text:
        return 0
    total = 0
    for ch in text:
        total += int(draw.textlength(ch, font=font))
    total += ls_px * (len(text) - 1)
    return total


def _draw_text_tracked(draw: ImageDraw.ImageDraw, xy, text: str,
                       font: ImageFont.ImageFont, fill, ls_px: int) -> None:
    """Render `text` one char at a time with extra `ls_px` between chars.
    Pillow has no letter-spacing param; per-char draw is the only way."""
    x, y = xy
    for i, ch in enumerate(text):
        draw.text((x, y), ch, font=font, fill=fill)
        x += int(draw.textlength(ch, font=font))
        if i < len(text) - 1:
            x += ls_px


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

    # Letter-spacing (tracking) — Pillow doesn't render this natively, so
    # we compute the tracked width here and render per-char below. Spacing
    # is in supersampled pixels so it scales with the rest of the layout.
    ls_px = int(text_size * WATERMARK_LETTER_SPACING_EM)

    tmp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    text_w = _measure_tracked(tmp_draw, text, font, ls_px)
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

    # Text on right, optically centered, drawn per-char so we can apply
    # letter-spacing (tracking).
    text_x = pad_x + logo_size + gap
    text_y = (pill_h - text_h) // 2 - desc // 4
    _draw_text_tracked(
        ImageDraw.Draw(pill), (text_x, text_y), text, font,
        fill=(255, 255, 255, 255), ls_px=ls_px,
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


def brand_image(swapped_jpg: Path, workdir: Path,
                handle: Optional[str]) -> Path:
    """
    Take a raw Flux+PuLID JPEG and produce a watermarked branded JPEG.
    Image format is WATERMARK-ONLY (no captions) per
    [[mainfeed_image_library_architecture]] — captions are video-format-only.

    Reuses render_overlay_png with caption=None so the watermark renders at
    the same position + style as videos. Composes the transparent PNG onto
    the JPEG with PIL alpha-blend (no ffmpeg dependency for the image path).

    Returns the path to the branded JPEG. If handle is falsy, returns
    swapped_jpg unchanged so callers can run unconditionally.
    """
    if not handle:
        return swapped_jpg

    base = Image.open(swapped_jpg).convert("RGBA")
    width, height = base.size

    overlay_png = workdir / "overlay.png"
    render_overlay_png(width, height, handle, None, overlay_png)

    overlay = Image.open(overlay_png).convert("RGBA")
    composed = Image.alpha_composite(base, overlay).convert("RGB")
    branded_jpg = workdir / "branded.jpg"
    composed.save(str(branded_jpg), format="JPEG", quality=92, optimize=True)
    return branded_jpg

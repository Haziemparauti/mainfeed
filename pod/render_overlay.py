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
import subprocess
import textwrap
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image, ImageDraw, ImageFont


# ============ config (tweak to retune layout) ============

FONT_PATH = "/app/assets/Anton.ttf"

# Watermark layout
WATERMARK_Y_PCT = 0.10
WATERMARK_LOGO_PCT = 0.055  # logo height as fraction of video height
WATERMARK_TEXT_PCT = 0.035  # watermark text height as fraction of video height
WATERMARK_STROKE = 2

# Caption layout
CAPTION_Y_PCT = 0.18
CAPTION_TEXT_PCT = 0.075  # caption text height as fraction of video height
CAPTION_LINE_SPACING_PCT = 0.012
CAPTION_STROKE = 4
CAPTION_HORIZONTAL_PAD_PCT = 0.06   # left/right padding from edges

# Mainfeed brand-kit gradient (dark navy → deep blue → teal → gold)
BRAND_COLORS = [
    (0, 11, 33),     # #000b21
    (0, 63, 130),    # #003f82
    (76, 162, 181),  # #4ca2b5
    (255, 210, 127), # #ffd27f
]


# ============ logo (generated from brand colors at runtime) ============

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


@lru_cache(maxsize=8)
def make_logo(size: int) -> Image.Image:
    """Mainfeed logo at `size` × `size`: rounded square diagonal gradient + white M."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        for x in range(size):
            # Diagonal gradient: 0 at top-left, 1 at bottom-right
            t = (x + y) / (2 * (size - 1))
            r, g, b = _interp_brand(t)
            px[x, y] = (r, g, b, 255)

    # Apply rounded-corner alpha mask
    radius = int(size * 0.22)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=radius, fill=255
    )
    img.putalpha(mask)

    # White "M" centered
    draw = ImageDraw.Draw(img)
    m_size = int(size * 0.66)
    font = ImageFont.truetype(FONT_PATH, m_size)
    m_w = draw.textlength("M", font=font)
    m_x = (size - m_w) / 2
    # Optical centering: nudge up slightly because Anton has bottom whitespace
    m_y = (size - m_size) / 2 - m_size * 0.10
    draw.text((m_x, m_y), "M", font=font, fill=(255, 255, 255, 255))
    return img


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

    # ===== Watermark row at Y=10% =====
    if handle:
        wm_text = f"Mainfeed.app · @{handle}"
        wm_text_size = max(12, int(video_h * WATERMARK_TEXT_PCT))
        wm_logo_size = max(16, int(video_h * WATERMARK_LOGO_PCT))
        wm_font = ImageFont.truetype(FONT_PATH, wm_text_size)
        wm_text_w = draw.textlength(wm_text, font=wm_font)
        gap = max(6, wm_logo_size // 4)
        total_w = wm_logo_size + gap + int(wm_text_w)
        wm_x0 = (video_w - total_w) // 2
        wm_center_y = int(video_h * WATERMARK_Y_PCT)

        logo = make_logo(wm_logo_size)
        logo_y = wm_center_y - wm_logo_size // 2
        img.paste(logo, (wm_x0, logo_y), logo)

        text_y = wm_center_y - wm_text_size // 2
        draw.text(
            (wm_x0 + wm_logo_size + gap, text_y),
            wm_text,
            font=wm_font,
            fill=(255, 255, 255, 255),
            stroke_width=WATERMARK_STROKE,
            stroke_fill=(0, 0, 0, 255),
        )

    # ===== Caption at Y=18%, multi-line, uppercase, centered =====
    if caption:
        cap_size = max(20, int(video_h * CAPTION_TEXT_PCT))
        cap_font = ImageFont.truetype(FONT_PATH, cap_size)
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
        "-preset", "veryfast",
        "-crf", "20",
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

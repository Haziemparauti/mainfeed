"""
Mainfeed media branding — burns the CONTEXT BUG into the swapped media so the
brand + serial hook survive a screenshot or a download/share.

LOCKED 2026-05-29 (memory: mainfeed_session_2026-05-29_decisions):
  • NO narrative text is burned in. The first-person monologue lives ONLY as an
    in-app feed caption — never on the pixels.
  • The ONLY thing composited onto the media is the watermark "context bug",
    bottom-left, a whisper (premium show-bug, not an ad banner):

        [logo]  mainfeed.app/@handle
                LOST · EPISODE N

    - the URL kills App/Play-Store confusion (Mainfeed is a web app) and routes
      a curious viewer to the user's /@handle profile.
    - `LOST` is the arc SHARE-NAME (arc internal name = jungle_survival), sand.
    - `EPISODE N` is the per-piece episode (1-30) — the serial curiosity hook, white.

Applies to video, gif (short mp4) and image. cairosvg rasterizes the real
Mainfeed brand SVG (pod is Linux; Dockerfile installs libcairo2 + cairosvg).
"""

from __future__ import annotations
import io
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import cairosvg


# ============ assets ============
URL_FONT_PATH    = "/app/assets/Inter-Medium.ttf"   # clean sans — the URL line
CHYRON_FONT_PATH = "/app/assets/Anton.ttf"          # condensed caps — LOST · EPISODE N
LOGO_SVG_PATH    = "/app/assets/logo-square2.svg"   # the real brand mark
LOGO_HIRES_SIZE  = 512


# ============ bug layout (fractions of media height; media is 1:1 so h≈w) ====
BUG_INSET_PCT       = 0.045   # margin from the bottom-left corner
BUG_LOGO_PCT        = 0.075   # logo square height
BUG_LOGO_RADIUS_PCT = 0.22    # logo rounded-corner radius (fraction of logo size)
BUG_GAP_PCT         = 0.022   # gap between logo and the text block
BUG_URL_PCT         = 0.030   # URL line cap height
BUG_CHYRON_PCT      = 0.042   # chyron line cap height
BUG_LINE_GAP_PCT    = 0.008   # gap between the two text lines
BUG_TRACKING_EM     = 0.04    # letter-spacing on the chyron
BUG_SUPERSAMPLE     = 4       # render N× then LANCZOS-downsample for crisp AA

SAND  = (255, 210, 127, 255)  # arc-name colour (#ffd27f)
WHITE = (255, 255, 255, 255)
MUTED = (180, 180, 186, 255)


# ============ logo (rasterized from the real Mainfeed brand SVG) ============

@lru_cache(maxsize=1)
def _logo_hires() -> Image.Image:
    png = cairosvg.svg2png(url=LOGO_SVG_PATH,
                           output_width=LOGO_HIRES_SIZE, output_height=LOGO_HIRES_SIZE)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def _logo(size: int) -> Image.Image:
    """Logo downsampled to size×size, brand rounded-corners baked in."""
    img = _logo_hires().resize((size, size), Image.LANCZOS)
    r = max(1, int(size * BUG_LOGO_RADIUS_PCT))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


# ============ text helpers (Pillow has no native letter-spacing) ============

def _tracked_width(draw: ImageDraw.ImageDraw, text: str,
                   font: ImageFont.ImageFont, ls: int) -> int:
    if not text:
        return 0
    return sum(int(draw.textlength(c, font=font)) for c in text) + ls * (len(text) - 1)


def _draw_tracked(draw: ImageDraw.ImageDraw, xy, text: str,
                  font: ImageFont.ImageFont, fill, ls: int) -> int:
    x, y = xy
    for i, c in enumerate(text):
        draw.text((x, y), c, font=font, fill=fill)
        x += int(draw.textlength(c, font=font))
        if i < len(text) - 1:
            x += ls
    return x


# ============ the context bug ============

def render_bug(handle: str, arc_name: Optional[str], day: Optional[int],
               media_h: int) -> Image.Image:
    """Build the transparent RGBA bug tile (logo + URL line + chyron line)."""
    ss = BUG_SUPERSAMPLE
    logo_sz  = max(16, int(media_h * BUG_LOGO_PCT)) * ss
    gap      = int(media_h * BUG_GAP_PCT) * ss
    url_sz   = max(9,  int(media_h * BUG_URL_PCT)) * ss
    chy_sz   = max(11, int(media_h * BUG_CHYRON_PCT)) * ss
    line_gap = int(media_h * BUG_LINE_GAP_PCT) * ss

    url_font = ImageFont.truetype(URL_FONT_PATH, url_sz)
    chy_font = ImageFont.truetype(CHYRON_FONT_PATH, chy_sz)

    url_text = f"mainfeed.app/@{handle}"
    arc_text = (arc_name or "").upper()
    day_text = f"EPISODE {day}" if day is not None else ""
    dot      = "  •  "
    ls       = int(chy_sz * BUG_TRACKING_EM)

    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    url_w = int(tmp.textlength(url_text, font=url_font))
    arc_w = _tracked_width(tmp, arc_text, chy_font, ls)
    dot_w = int(tmp.textlength(dot, font=chy_font)) if (arc_text and day_text) else 0
    day_w = _tracked_width(tmp, day_text, chy_font, ls)
    chy_w = arc_w + dot_w + day_w
    text_w = max(url_w, chy_w)

    url_asc, url_desc = url_font.getmetrics()
    chy_asc, chy_desc = chy_font.getmetrics()
    url_h = url_asc + url_desc
    chy_h = chy_asc + chy_desc
    block_h = url_h + line_gap + chy_h

    bug_w = logo_sz + gap + text_w
    bug_h = max(logo_sz, block_h)
    bug = Image.new("RGBA", (bug_w, bug_h), (0, 0, 0, 0))

    bug.alpha_composite(_logo(logo_sz), (0, (bug_h - logo_sz) // 2))

    d = ImageDraw.Draw(bug)
    tx = logo_sz + gap
    ty0 = (bug_h - block_h) // 2
    d.text((tx, ty0), url_text, font=url_font, fill=WHITE)         # line 1 — URL
    cy = ty0 + url_h + line_gap                                    # line 2 — chyron
    x = _draw_tracked(d, (tx, cy), arc_text, chy_font, SAND, ls)
    if dot_w:
        d.text((x, cy), dot, font=chy_font, fill=MUTED)
        x += dot_w
    _draw_tracked(d, (x, cy), day_text, chy_font, WHITE, ls)

    return bug.resize((bug_w // ss, bug_h // ss), Image.LANCZOS)


def render_overlay_png(media_w: int, media_h: int, handle: Optional[str],
                       arc_name: Optional[str], day: Optional[int],
                       out_path: Path) -> Path:
    """Full-frame transparent PNG with the context bug at bottom-left, a soft
    corner scrim + drop-shadow for legibility on any frame content."""
    img = Image.new("RGBA", (media_w, media_h), (0, 0, 0, 0))

    if handle:
        bug = render_bug(handle, arc_name, day, media_h)
        inset = int(media_h * BUG_INSET_PCT)
        bx = inset
        by = media_h - inset - bug.height

        # soft dark corner scrim (blurred ellipse anchored off the bottom-left)
        scrim = Image.new("RGBA", (media_w, media_h), (0, 0, 0, 0))
        ImageDraw.Draw(scrim).ellipse(
            [-int(media_w * 0.18), by - int(bug.height * 0.7),
             bx + bug.width + int(bug.width * 0.45), media_h + int(media_h * 0.12)],
            fill=(0, 0, 0, 120),
        )
        scrim = scrim.filter(ImageFilter.GaussianBlur(int(media_h * 0.03)))
        img = Image.alpha_composite(img, scrim)

        # drop shadow of the bug (dark silhouette from alpha, offset + blurred)
        off = max(1, int(media_h * 0.004))
        shadow = Image.new("RGBA", (media_w, media_h), (0, 0, 0, 0))
        black = Image.new("RGBA", bug.size, (0, 0, 0, 210))
        shadow.paste(black, (bx + off, by + off), bug.split()[3])
        shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, int(media_h * 0.006))))
        img = Image.alpha_composite(img, shadow)

        img.alpha_composite(bug, (bx, by))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


# ============ video probing ============

def probe_dimensions(video_path: Path) -> Tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video_path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    w, h = (int(x) for x in out.split(","))
    return w, h


# ============ FFmpeg burn-in ============

def burn_overlay(input_mp4: Path, overlay_png: Path, output_mp4: Path) -> None:
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(input_mp4),
        "-i", str(overlay_png),
        "-filter_complex", "[0:v][1:v]overlay=0:0[v]",
        "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "fast", "-crf", "16",
        "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
        str(output_mp4),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


# ============ public entry points ============

def brand_video(swapped_mp4: Path, workdir: Path, handle: Optional[str],
                arc_name: Optional[str] = None, day: Optional[int] = None) -> Path:
    """Burn the context bug into a swapped MP4 (video or gif). Returns the
    branded path; if `handle` is falsy, returns the input unchanged."""
    if not handle:
        return swapped_mp4
    width, height = probe_dimensions(swapped_mp4)
    overlay_png = workdir / "overlay.png"
    branded_mp4 = workdir / "branded.mp4"
    render_overlay_png(width, height, handle, arc_name, day, overlay_png)
    burn_overlay(swapped_mp4, overlay_png, branded_mp4)
    return branded_mp4


def brand_image(swapped_jpg: Path, workdir: Path, handle: Optional[str],
                arc_name: Optional[str] = None, day: Optional[int] = None) -> Path:
    """Burn the context bug into a Flux+PuLID JPEG via PIL alpha-composite
    (no ffmpeg). Returns the branded path; if `handle` is falsy, unchanged."""
    if not handle:
        return swapped_jpg
    base = Image.open(swapped_jpg).convert("RGBA")
    width, height = base.size
    overlay_png = workdir / "overlay.png"
    render_overlay_png(width, height, handle, arc_name, day, overlay_png)
    overlay = Image.open(overlay_png).convert("RGBA")
    branded_jpg = workdir / "branded.jpg"
    Image.alpha_composite(base, overlay).convert("RGB").save(
        str(branded_jpg), format="JPEG", quality=92, optimize=True)
    return branded_jpg

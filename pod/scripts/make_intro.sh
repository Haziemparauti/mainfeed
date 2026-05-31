#!/usr/bin/env bash
# make_intro.sh — LOCKED Day-1 title scene (2026-05-31, approved by user).
#
#   rounded "Mainfeed" logo  ->  wordmark (same width as the logo, centered)
#   ->  "presents"  ->  "The story of @<handle>"
#   12s, 9:16 720x1280, clean movie fades, over a darkened+blurred copy of the
#   day's opening clip, with an audio bed (a supplied music track, or the bg
#   clip's own ambience as a fallback).
#
# The ONLY per-user variable is <handle>. Everything else (logo, wordmark,
# background, sizes, positions, timing, fades) is identical for every user, so
# the whole scene is user-agnostic except the one drawtext line. Cheap ffmpeg,
# no GPU. This is the canonical Day-1 opener — DO NOT restyle without sign-off.
#
# Assets (committed in pod/assets, generated once via sharp from the brand SVGs):
#   logo_icon_round.png  — square brand mark, rounded corners (from logo-square2.svg)
#   wordmark.png         — "Mainfeed" wordmark, TRIMMED to the glyphs so centering
#                          the image centers the text (from logo-rect2.svg)
#   Inter-Medium.ttf     — premium sans for "presents" + "The story of @handle"
#
# Usage:
#   make_intro.sh <handle> <bg_clip.mp4> <out.mp4> [music_track]
#     <bg_clip> = the shared Day-1 island clip (1U; same for all users).
#     [music]   = optional bed; if omitted, the bg clip's own audio is used.
#   ASSETS_DIR env var overrides the asset location (default: pod/assets).
set -euo pipefail

HANDLE="${1:?usage: make_intro.sh <handle> <bg_clip.mp4> <out.mp4> [music]}"
BG="${2:?need bg clip}"
OUT="${3:?need output path}"
MUSIC="${4:-}"
ASSETS_DIR="${ASSETS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)}"

ICON="$ASSETS_DIR/logo_icon_round.png"
WM="$ASSETS_DIR/wordmark.png"
FONT="$ASSETS_DIR/Inter-Medium.ttf"

FC="$(mktemp).txt"
trap 'rm -f "$FC"' EXIT
cat > "$FC" <<EOF
[0:v]trim=0:12,setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,eq=brightness=-0.5:saturation=0.45,boxblur=12:1,format=yuv420p[bgv];
[1:v]scale=140:-1,format=rgba,fade=t=in:st=0.6:d=0.6:alpha=1,fade=t=out:st=4.0:d=0.6:alpha=1[icon];
[2:v]scale=140:-1,format=rgba,fade=t=in:st=0.85:d=0.6:alpha=1,fade=t=out:st=4.0:d=0.6:alpha=1[wm];
[bgv][icon]overlay=x=(W-w)/2:y=405:enable='between(t,0.4,4.7)'[t1];
[t1][wm]overlay=x=(W-w)/2:y=558:enable='between(t,0.4,4.7)'[t2];
[t2]drawtext=fontfile=${FONT}:text='presents':fontcolor=0xE6E6E6:fontsize=24:x=(w-text_w)/2:y=520:alpha='if(lt(t,5.0),0,if(lt(t,5.6),(t-5.0)/0.6,if(lt(t,7.2),1,if(lt(t,7.8),(7.8-t)/0.6,0))))',drawtext=fontfile=${FONT}:text='The story of @${HANDLE}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=512:alpha='if(lt(t,8.2),0,if(lt(t,8.8),(t-8.2)/0.6,if(lt(t,10.6),1,if(lt(t,11.2),(11.2-t)/0.6,0))))',fade=t=in:st=0:d=0.8,fade=t=out:st=11.0:d=1.0[v]
EOF

INPUTS=(-i "$BG" -loop 1 -framerate 24 -t 12 -i "$ICON" -loop 1 -framerate 24 -t 12 -i "$WM")
ABED="0:a"
if [ -n "$MUSIC" ]; then INPUTS+=(-i "$MUSIC"); ABED="3:a"; fi

ffmpeg -nostdin -y -loglevel error "${INPUTS[@]}" \
  -filter_complex_script "$FC" -map "[v]" -map "$ABED" \
  -af "atrim=0:12,asetpts=PTS-STARTPTS,volume=0.75,afade=t=in:st=0:d=1.0,afade=t=out:st=10.6:d=1.4" \
  -t 12 -r 24 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 160k "$OUT"

echo "✓ intro -> $OUT"

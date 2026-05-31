#!/usr/bin/env bash
# make_finalcard.sh — LOCKED Episode end card (2026-05-31, approved by user).
#
# Plays as the FINAL segment, after the last footage clip (7U). Distinct, more
# cinematic style than the regular text cards: a clean near-black screen (NOT
# the gradient-bordered card). The previous clip fades to black, then this card
# fades in (the "7U → final card has the fade out and in" rule). Per-user only
# via @handle — no manual inputs.
#
#   [logo]  Mainfeed              (sign-off, top-centre)
#   TO BE CONTINUED
#   @<handle>, your story isn't over.
#   Tune in next episode.
#
# Usage:
#   make_finalcard.sh <handle> <out.mp4>
#   env: ASSETS_DIR overrides the asset dir (default: pod/assets).
#        TMPROOT where the textfile goes (default /tmp; set "." for local
#        Windows renders so the filtergraph path stays relative).
set -euo pipefail

HANDLE="${1:?handle}"; OUT="${2:?out}"
HANDLE="${HANDLE#@}"                          # tolerate a leading @

ASSETS_DIR="${ASSETS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)}"
ICON="$ASSETS_DIR/logo_icon_round.png"
WM="$ASSETS_DIR/wordmark.png"
FONT="$ASSETS_DIR/Inter-Medium.ttf"

DUR=6.5

TMPD="$(mktemp -d "${TMPROOT:-/tmp}/final.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT
TUNE="$TMPD/tune1.txt"
# textfile= keeps the apostrophe in "isn't" raw — no escaping needed.
printf '@%s, your story isn'\''t over.' "$HANDLE" > "$TUNE"

FC="$TMPD/fc.txt"
cat > "$FC" <<EOF
color=c=0x060608:s=720x1280:d=${DUR}[bk];
[0:v]scale=120:120[icon];
[1:v]scale=120:-1[wm];
[bk][icon]overlay=(W-w)/2:118[l1];
[l1][wm]overlay=(W-w)/2:246[l2];
[l2]drawtext=fontfile=${FONT}:text='TO BE CONTINUED':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=520:alpha='if(lt(t,1.0),0,if(lt(t,1.7),(t-1.0)/0.7,1))',drawtext=fontfile=${FONT}:textfile=${TUNE}:fontcolor=0xffd27f:fontsize=28:x=(w-text_w)/2:y=624:alpha='if(lt(t,2.6),0,if(lt(t,3.3),(t-2.6)/0.7,1))',drawtext=fontfile=${FONT}:text='Tune in next episode.':fontcolor=0xffd27f:fontsize=28:x=(w-text_w)/2:y=668:alpha='if(lt(t,2.6),0,if(lt(t,3.3),(t-2.6)/0.7,1))',fade=t=in:st=0:d=0.9,fade=t=out:st=5.3:d=1.2[v]
EOF

ffmpeg -nostdin -y -loglevel error \
  -loop 1 -framerate 24 -t "$DUR" -i "$ICON" \
  -loop 1 -framerate 24 -t "$DUR" -i "$WM" \
  -filter_complex_script "$FC" -map "[v]" -t "$DUR" -r 24 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -an "$OUT"

echo "✓ final card -> $OUT  (@${HANDLE})"

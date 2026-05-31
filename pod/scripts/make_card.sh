#!/usr/bin/env bash
# make_card.sh — LOCKED Day text card (2026-05-31, approved by user).
#
# A 9:16 720x1280 caption card, played between the swapped video pieces of an
# episode. Style (DO NOT restyle without sign-off):
#   - black bg + the user's own face-swapped frame FROM THIS EPISODE, softened
#     (blurred ~3, ~50% opacity) — personalized per episode, no manual images.
#   - vertical rounded card with the brand-gradient border + semi-transparent
#     fill (jungle shows through).
#   - header INSIDE the card: [logo + Mainfeed] on the left, "DAY N" + "Arc: X"
#     (sand) on the right, faint divider under it.
#   - 1-3 monologue lines, centered, revealed ONE AT A TIME with a smooth fade
#     (each line fades in and stays). Clean fade in/out on the whole card.
#
# Per-user/episode variables: the bg frame, the day, the arc, the lines. The
# final "next episode" card is just a normal card whose line carries @handle.
#
# Usage:
#   make_card.sh <bg_frame.jpg> <day> <arc> <out.mp4> <line1> [line2] [line3]
#   ASSETS_DIR overrides the asset dir (default: pod/assets).
set -euo pipefail

BG="${1:?bg frame}"; DAY="${2:?day}"; ARC="${3:?arc}"; OUT="${4:?out}"
shift 4
LINES=("$@")
N=${#LINES[@]}
[ "$N" -ge 1 ] || { echo "need at least one monologue line" >&2; exit 1; }
[ "$N" -le 3 ] || { echo "max 3 lines" >&2; exit 1; }

ASSETS_DIR="${ASSETS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)}"
ICON="$ASSETS_DIR/logo_icon_round.png"
WM="$ASSETS_DIR/wordmark.png"
FRAME="$ASSETS_DIR/card_frame.png"
FONT="$ASSETS_DIR/Inter-Medium.ttf"

YC=590; LH=64; FS=44
DUR=$(awk "BEGIN{printf \"%.2f\", 1.2 + ($N-1)*1.4 + 0.6 + 2.0 + 0.8}")
FADEOUT=$(awk "BEGIN{printf \"%.2f\", $DUR - 0.8}")

TMPD="$(mktemp -d)"
FC="$(mktemp).txt"
trap 'rm -rf "$TMPD" "$FC"' EXIT

# Per-line drawtext chain — textfile= keeps the monologue raw (apostrophes,
# punctuation, etc. need no escaping). Each line fades in at a staggered time.
MONO=""
for i in "${!LINES[@]}"; do
  lf="$TMPD/l$i.txt"
  printf '%s' "${LINES[$i]}" > "$lf"
  y=$(awk "BEGIN{printf \"%d\", $YC - ($N-1)*$LH/2 + $i*$LH}")
  a=$(awk "BEGIN{printf \"%.2f\", 1.2 + $i*1.4}")
  ae=$(awk "BEGIN{printf \"%.2f\", 1.2 + $i*1.4 + 0.6}")
  col="white"; [ $((i % 2)) -eq 1 ] && col="0xEDEDED"
  MONO="${MONO},drawtext=fontfile=${FONT}:textfile=${lf}:fontcolor=${col}:fontsize=${FS}:x=(w-text_w)/2:y=${y}:alpha='if(lt(t,${a}),0,if(lt(t,${ae}),(t-${a})/0.6,1))'"
done

cat > "$FC" <<EOF
color=c=black:s=720x1280:d=${DUR}[bk];
[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=3:1,eq=brightness=-0.04:saturation=0.78,format=rgba,colorchannelmixer=aa=0.5[jg];
[bk][jg]overlay[bg0];
[2:v]scale=46:-1[icon];
[3:v]scale=118:-1[wm];
[bg0][1:v]overlay=(W-w)/2:255[s0];
[s0][icon]overlay=104:290[s1];
[s1][wm]overlay=160:300[s2];
[s2]drawbox=x=104:y=372:w=512:h=2:color=white@0.16:t=fill,drawtext=fontfile=${FONT}:text='DAY ${DAY}':fontcolor=white:fontsize=30:x=616-text_w:y=294,drawtext=fontfile=${FONT}:text='Arc\\: ${ARC}':fontcolor=0xffd27f:fontsize=23:x=616-text_w:y=334${MONO},fade=t=in:st=0:d=0.7,fade=t=out:st=${FADEOUT}:d=0.8[v]
EOF

ffmpeg -nostdin -y -loglevel error \
  -loop 1 -framerate 24 -t "$DUR" -i "$BG" \
  -loop 1 -framerate 24 -t "$DUR" -i "$FRAME" \
  -loop 1 -framerate 24 -t "$DUR" -i "$ICON" \
  -loop 1 -framerate 24 -t "$DUR" -i "$WM" \
  -filter_complex_script "$FC" -map "[v]" -t "$DUR" -r 24 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -an "$OUT"

echo "✓ card -> $OUT  (${N} lines, ${DUR}s, DAY ${DAY} / Arc: ${ARC})"

#!/usr/bin/env bash
# make_card.sh — LOCKED Episode text card (2026-05-31; v2 2026-05-31).
#
# A 9:16 720x1280 monologue card, played between the swapped video pieces of an
# episode. Style (DO NOT restyle without sign-off):
#   - black bg + the user's own face-swapped frame FROM THIS EPISODE, softened
#     (blurred ~3, ~50% opacity) — personalized per episode, no manual images.
#   - vertical rounded card with the brand-gradient border + semi-transparent
#     fill (jungle shows through).
#   - header INSIDE the card: [logo + Mainfeed] on the left, "EPISODE N" + "Arc:
#     X" (sand) on the right, faint divider under it.
#   - monologue: each ARG is one "beat", revealed one beat at a time with a
#     smooth fade (fades in + stays). Long beats word-wrap onto 2 rows; the font
#     auto-fits to the number of rows. Clean fade in/out on the whole card.
#   - OPTIONAL prop image (env CARD_PROP) — e.g. the note the character finds —
#     rendered under the header, above the text (used on Episode-1 card 3).
#
# Usage:
#   make_card.sh <bg_frame> <day> <arc> <out.mp4> <beat1> [beat2] [beat3] ...
#   env: CARD_PROP=<image>   optional prop above the text
#        ASSETS_DIR=<dir>    override asset dir (default: pod/assets)
#        TMPROOT=<dir>       where per-row textfiles go (default /tmp; set "."
#                            for local Windows renders so the filtergraph paths
#                            stay relative — colons in C:\ break -filter_*_script)
set -euo pipefail

BG="${1:?bg frame}"; DAY="${2:?day}"; ARC="${3:?arc}"; OUT="${4:?out}"
shift 4
LINES=("$@")
N=${#LINES[@]}
[ "$N" -ge 1 ] || { echo "need at least one monologue beat" >&2; exit 1; }

ASSETS_DIR="${ASSETS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)}"
ICON="$ASSETS_DIR/logo_icon_round.png"
WM="$ASSETS_DIR/wordmark.png"
FRAME="${CARD_FRAME:-$ASSETS_DIR/card_frame.png}"     # taller variant for cards that need it (e.g. card 3)
FONT="$ASSETS_DIR/Inter-Medium.ttf"
PROP="${CARD_PROP:-}"
HASPROP=0; [ -n "$PROP" ] && HASPROP=1

# ---- card geometry derived from the frame image (a taller frame just works) ----
FRAME_W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$FRAME" | tr -dc '0-9')
FRAME_H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$FRAME" | tr -dc '0-9')
FRAME_Y=${CARD_FRAME_Y:-$(awk "BEGIN{print int((1280-$FRAME_H)/2)-25}")}   # 720->255 (matches the locked layout); taller frames sit higher
FRAME_X=$(awk "BEGIN{print int((720-$FRAME_W)/2)}")                        # 580->70
ICON_Y=$(( FRAME_Y + 35 )); WM_Y=$(( FRAME_Y + 45 )); DIV_Y=$(( FRAME_Y + 117 ))
EP_Y=$(( FRAME_Y + 39 ));   ARC_Y=$(( FRAME_Y + 79 ))
HDR_L=$(( FRAME_X + 34 ));  HDR_WM=$(( FRAME_X + 90 )); HDR_R=$(( FRAME_X + FRAME_W - 34 )); DIV_W=$(( FRAME_W - 68 ))
REGION_TOP=$(( FRAME_Y + 155 )); REGION_BOT=$(( FRAME_Y + FRAME_H - 39 ))
USABLE=525                    # max text width inside the card (px)
FS_MAX=40; FS_MIN=20

# ---- optional prop (e.g. the note) above the text; it steals vertical room ----
TEXT_TOP=$REGION_TOP; PROP_Y=$REGION_TOP; propW=0; propH=0
if [ "$HASPROP" -eq 1 ]; then
  pw=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$PROP" | tr -dc '0-9')
  ph=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$PROP" | tr -dc '0-9')
  propW=${CARD_PROP_W:-220}                             # readable note; never taller than 60% of region
  propH=$(awk "BEGIN{print int($propW*$ph/$pw)}")
  maxH=$(awk "BEGIN{print int(($REGION_BOT-$REGION_TOP)*0.60)}")
  [ "$propH" -gt "$maxH" ] && { propH=$maxH; propW=$(awk "BEGIN{print int($maxH*$pw/$ph)}"); }
  TEXT_TOP=$(( REGION_TOP + propH + 18 ))
fi
AVAIL=$(( REGION_BOT - TEXT_TOP ))

# ---- ONE row per sentence. Auto-fit the font so the LONGEST sentence fits on a
#      single line (NO wrapping), then space the sentences out generously. ----
MAXLEN=1
for l in "${LINES[@]}"; do [ ${#l} -gt "$MAXLEN" ] && MAXLEN=${#l}; done
FS=$(awk "BEGIN{f=int($USABLE/($MAXLEN*0.55)); if(f>$FS_MAX)f=$FS_MAX; if(f<$FS_MIN)f=$FS_MIN; print f}")
# pitch between sentence centres: spread across the region, capped so a few lines
# don't drift miles apart, floored so they never crowd.
PITCH=$(awk "BEGIN{p=$AVAIL/($N+1); hi=$FS*3.0; lo=$FS*1.9; if(p>hi)p=hi; if(p<lo)p=lo; print int(p)}")
BLOCKH=$(( (N-1)*PITCH ))
TOP=$(awk "BEGIN{print int($TEXT_TOP + ($AVAIL-$BLOCKH)/2)}")

# ---- timing ----
BASE_T=1.0; STEP=1.3; FADE=0.55; HOLD=2.2
DUR=$(awk "BEGIN{printf \"%.2f\", $BASE_T + ($N-1)*$STEP + $FADE + $HOLD + 0.8}")
FADEOUT=$(awk "BEGIN{printf \"%.2f\", $DUR-0.85}")

TMPD="$(mktemp -d "${TMPROOT:-/tmp}/card.XXXXXX")"
FC="$(mktemp).txt"
trap 'rm -rf "$TMPD" "$FC"' EXIT

# ---- one drawtext per sentence: centred, evenly spaced, revealed one at a time ----
TEXT=""
for i in "${!LINES[@]}"; do
  lf="$TMPD/r$i.txt"; printf '%s' "${LINES[$i]}" > "$lf"
  yc=$(( TOP + i*PITCH ))
  y=$(awk "BEGIN{print int($yc - $FS/2)}")
  a=$(awk "BEGIN{printf \"%.2f\", $BASE_T + $i*$STEP}")
  ae=$(awk "BEGIN{printf \"%.2f\", $BASE_T + $i*$STEP + $FADE}")
  pre=","; [ -z "$TEXT" ] && pre=""
  TEXT="${TEXT}${pre}drawtext=fontfile=${FONT}:textfile=${lf}:fontcolor=white:fontsize=${FS}:x=(w-text_w)/2:y=${y}:alpha='if(lt(t,${a}),0,if(lt(t,${ae}),(t-${a})/${FADE},1))'"
done

# ---- optional prop overlay (input index 4) ----
PROP_FILT=""; BASE="hd"
if [ "$HASPROP" -eq 1 ]; then
  PROP_FILT="[4:v]scale=${propW}:${propH}[prop];[hd][prop]overlay=(W-w)/2:${PROP_Y}[bd];"
  BASE="bd"
fi

cat > "$FC" <<EOF
color=c=black:s=720x1280:d=${DUR}[bk];
[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=3:1,eq=brightness=-0.04:saturation=0.78,format=rgba,colorchannelmixer=aa=0.5[jg];
[bk][jg]overlay[bg0];
[2:v]scale=46:-1[icon];
[3:v]scale=118:-1[wm];
[bg0][1:v]overlay=(W-w)/2:${FRAME_Y}[s0];
[s0][icon]overlay=${HDR_L}:${ICON_Y}[s1];
[s1][wm]overlay=${HDR_WM}:${WM_Y}[s2];
[s2]drawbox=x=${HDR_L}:y=${DIV_Y}:w=${DIV_W}:h=2:color=white@0.16:t=fill,drawtext=fontfile=${FONT}:text='EPISODE ${DAY}':fontcolor=white:fontsize=27:x=${HDR_R}-text_w:y=${EP_Y},drawtext=fontfile=${FONT}:text='Arc\\: ${ARC}':fontcolor=0xffd27f:fontsize=23:x=${HDR_R}-text_w:y=${ARC_Y}[hd];
${PROP_FILT}[${BASE}]${TEXT},fade=t=in:st=0:d=0.7,fade=t=out:st=${FADEOUT}:d=0.85[v]
EOF

INPUTS=(-loop 1 -framerate 24 -t "$DUR" -i "$BG"
        -loop 1 -framerate 24 -t "$DUR" -i "$FRAME"
        -loop 1 -framerate 24 -t "$DUR" -i "$ICON"
        -loop 1 -framerate 24 -t "$DUR" -i "$WM")
[ "$HASPROP" -eq 1 ] && INPUTS+=(-loop 1 -framerate 24 -t "$DUR" -i "$PROP")

ffmpeg -nostdin -y -loglevel error "${INPUTS[@]}" \
  -filter_complex_script "$FC" -map "[v]" -t "$DUR" -r 24 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -an "$OUT"

echo "✓ card -> $OUT  (${N} sentences, FS=${FS}, pitch=${PITCH}, ${DUR}s, EPISODE ${DAY}${PROP:+, +prop})"

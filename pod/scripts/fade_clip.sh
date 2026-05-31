#!/usr/bin/env bash
# fade_clip.sh <in> <out> [fade_seconds]
# Adds a smooth quick fade-in + fade-out (video AND audio if present).
# Auto-detects duration so the out-fade lands flush at the end, and skips the
# audio filter on silent clips (e.g. 5U). Re-encodes h264/aac, faststart.
set -euo pipefail
IN="$1"; OUT="$2"; D="${3:-0.4}"
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$IN")
OUTST=$(python -c "print(max(0.0, float('$DUR') - float('$D')))")
HAS_AUDIO=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$IN" | head -1)
VF="fade=t=in:st=0:d=$D,fade=t=out:st=$OUTST:d=$D"
if [ -n "$HAS_AUDIO" ]; then
  ffmpeg -y -i "$IN" -vf "$VF" \
    -af "afade=t=in:st=0:d=$D,afade=t=out:st=$OUTST:d=$D" \
    -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 \
    -c:a aac -b:a 128k -movflags +faststart "$OUT" 2>&1 | tail -2
else
  ffmpeg -y -i "$IN" -vf "$VF" \
    -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 \
    -an -movflags +faststart "$OUT" 2>&1 | tail -2
fi
echo "faded ($D s, dur=$DUR, audio=$([ -n "$HAS_AUDIO" ] && echo yes || echo no)) -> $OUT"

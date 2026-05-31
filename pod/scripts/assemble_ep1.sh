#!/usr/bin/env bash
# assemble_ep1.sh — stitch the full Episode-1 "LOST" episode into ONE mp4.
#
#   intro -> 1U -> card1 -> 2U -> card2 -> 3U -> card3(tall+note) -> 4U -> card4
#         -> 5U -> card5 -> 6U -> 7U -> final
#
# Fades: every clip + card fades in/out EXCEPT 6U has no fade-out and 7U has no
# fade-in (hard-cut glue); 7U fades out -> final fades in. (intro/cards/final
# carry their own fades from make_*.sh; clips get fades here.)
#
# Audio (both LOW, UNDER the clips' native sound):
#   music (mysterysound) quick fade-in at 1U -> ~18% -> fades out during 6U
#   ocean (Oceanwaves)   fades in at 5U -> ~30% -> fades out at end of final
#
# Usage:
#   assemble_ep1.sh <handle> <clips_dir> <out.mp4>
#     clips_dir holds 1U.mp4 (passthrough) + 2U..7U.mp4 (swapped, or raw for a
#     dry-run). note/music/ocean default to the Episode-1 folder (override via
#     NOTE / MUSIC / OCEAN env).
set -euo pipefail

HANDLE="${1:?handle}"; CLIPS="${2:?clips dir}"; OUT="${3:?out}"
HANDLE="${HANDLE#@}"

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$(cd "$SCRIPTS/../assets" && pwd)"
EP="${EP_DIR:-/c/Users/cex/Desktop/mainfeed-stock/Production stock/Episode 1}"
NOTE="${NOTE:-$EP/3U4U_note.png}"
MUSIC="${MUSIC:-$EP/mysterysound.mp3}"
OCEAN="${OCEAN:-$EP/Oceanwaves sounds.mp3}"
MUSIC_VOL="${MUSIC_VOL:-0.18}"; OCEAN_VOL="${OCEAN_VOL:-0.30}"
FD=0.4   # clip fade seconds

WORK="$(mktemp -d "${TMPROOT:-/tmp}/asm.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# make_*.sh need relative asset paths to render on Windows (absolute C:\ breaks
# the filtergraph) — run them from the assets dir with ASSETS_DIR=.
cd "$ASSETS"
mc() { ASSETS_DIR=. TMPROOT=. bash "$SCRIPTS/make_card.sh" "$@"; }

probe() { ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" | tr -dc '0-9.'; }

# Normalize a segment to a uniform stream so concat is clean. fi/fo = add a
# fade-in / fade-out (clips only; cards/intro/final already faded). Silent
# inputs get a generated silent track so every segment has video+audio.
seg() {  # <in> <out> <fi> <fo>
  local in="$1" out="$2" fi="$3" fo="$4"
  local dur ost vf af ha
  dur=$(probe "$in"); ost=$(awk "BEGIN{printf \"%.3f\", $dur-$FD}")
  vf="scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,format=yuv420p"
  af=""
  [ "$fi" = 1 ] && { vf="$vf,fade=t=in:st=0:d=$FD"; af="afade=t=in:st=0:d=$FD"; }
  [ "$fo" = 1 ] && { vf="$vf,fade=t=out:st=$ost:d=$FD"; af="${af:+$af,}afade=t=out:st=$ost:d=$FD"; }
  ha=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$in" | head -1)
  if [ -n "$ha" ]; then
    ffmpeg -nostdin -y -loglevel error -i "$in" -vf "$vf" ${af:+-af "$af"} \
      -c:v libx264 -crf 19 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 "$out"
  else
    ffmpeg -nostdin -y -loglevel error -i "$in" -f lavfi -t "$dur" -i anullsrc=r=44100:cl=stereo \
      -vf "$vf" -map 0:v -map 1:a -c:v libx264 -crf 19 -preset veryfast -pix_fmt yuv420p \
      -c:a aac -ar 44100 -ac 2 -shortest "$out"
  fi
}

bgframe() {  # <clip> <out.jpg> — a mid-clip frame for a card background
  local d; d=$(probe "$1"); local mid; mid=$(awk "BEGIN{printf \"%.2f\", $d/2}")
  ffmpeg -nostdin -y -loglevel error -ss "$mid" -i "$1" -frames:v 1 -q:v 3 "$2"
}

echo "▶ card backgrounds"
for n in 1 2 3 4 5; do bgframe "$CLIPS/${n}U.mp4" "$WORK/bg$n.jpg"; done

echo "▶ rendering segments"
ASSETS_DIR=. bash "$SCRIPTS/make_intro.sh" "$HANDLE" "$CLIPS/1U.mp4" "$WORK/r00.mp4"
mc "$WORK/bg1.jpg" 1 LOST "$WORK/r02.mp4" "Sleep is amazing, right?" "It's relaxing, it's comforting.." "it might be the best part of the day." "Unless you open your eyes and..."
mc "$WORK/bg2.jpg" 1 LOST "$WORK/r04.mp4" "Where am I !?" "How did I get here !?" "I don't remember anything," "what the hell happened !?"
CARD_FRAME=card_frame_tall.png CARD_PROP_W=340 CARD_PROP="$NOTE" mc "$WORK/bg3.jpg" 1 LOST "$WORK/r06.mp4" "Who wrote this ?" "And what is this even about ?!" "I need to get home, how did I end up here!?" "I need to get out of here !"
mc "$WORK/bg4.jpg" 1 LOST "$WORK/r08.mp4" "I saw some light back there," "It looked like an entrance." "Let me go check it out."
mc "$WORK/bg5.jpg" 1 LOST "$WORK/r10.mp4" "I am in the middle of nowhere !?" "Its just the ocean..." "There is no one ??!"
ASSETS_DIR=. TMPROOT=. bash "$SCRIPTS/make_finalcard.sh" "$HANDLE" "$WORK/r13.mp4"

echo "▶ normalizing (fades baked per the rules)"
seg "$WORK/r00.mp4"   "$WORK/s00.mp4" 0 0   # intro
seg "$CLIPS/1U.mp4"   "$WORK/s01.mp4" 1 1
seg "$WORK/r02.mp4"   "$WORK/s02.mp4" 0 0   # card1
seg "$CLIPS/2U.mp4"   "$WORK/s03.mp4" 1 1
seg "$WORK/r04.mp4"   "$WORK/s04.mp4" 0 0   # card2
seg "$CLIPS/3U.mp4"   "$WORK/s05.mp4" 1 1
seg "$WORK/r06.mp4"   "$WORK/s06.mp4" 0 0   # card3
seg "$CLIPS/4U.mp4"   "$WORK/s07.mp4" 1 1
seg "$WORK/r08.mp4"   "$WORK/s08.mp4" 0 0   # card4
seg "$CLIPS/5U.mp4"   "$WORK/s09.mp4" 1 1
seg "$WORK/r10.mp4"   "$WORK/s10.mp4" 0 0   # card5
seg "$CLIPS/6U.mp4"   "$WORK/s11.mp4" 1 0   # 6U: fade in, NO fade out
seg "$CLIPS/7U.mp4"   "$WORK/s12.mp4" 0 1   # 7U: NO fade in, fade out
seg "$WORK/r13.mp4"   "$WORK/s13.mp4" 0 0   # final

echo "▶ concat"
CI=(); CF=""; k=0
for i in 00 01 02 03 04 05 06 07 08 09 10 11 12 13; do CI+=(-i "$WORK/s$i.mp4"); CF+="[$k:v][$k:a]"; k=$((k+1)); done
ffmpeg -nostdin -y -loglevel error "${CI[@]}" \
  -filter_complex "${CF}concat=n=14:v=1:a=1[v][a]" -map "[v]" -map "[a]" \
  -c:v libx264 -crf 19 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 "$WORK/base.mp4"

# --- audio bed offsets (seconds), summed from the normalized segments ---
sumdur() { local t=0 f; for f in "$@"; do t=$(awk "BEGIN{printf \"%.3f\", $t + $(probe "$f")}"); done; echo "$t"; }
T1U=$(sumdur "$WORK/s00.mp4")
T5U=$(sumdur "$WORK"/s0{0,1,2,3,4,5,6,7,8}.mp4)
T6Uend=$(sumdur "$WORK"/s{00,01,02,03,04,05,06,07,08,09,10,11}.mp4)
TOTAL=$(sumdur "$WORK"/s{00,01,02,03,04,05,06,07,08,09,10,11,12,13}.mp4)
MLEN=$(awk "BEGIN{printf \"%.3f\", $T6Uend-$T1U}")
MFO=$(awk "BEGIN{printf \"%.3f\", $T6Uend-3.0}")
OLEN=$(awk "BEGIN{printf \"%.3f\", $TOTAL-$T5U}")
OFO=$(awk "BEGIN{printf \"%.3f\", $TOTAL-1.5}")
T1Ums=$(awk "BEGIN{printf \"%d\", $T1U*1000}")
T5Ums=$(awk "BEGIN{printf \"%d\", $T5U*1000}")
echo "  offsets: 1U=${T1U}s 5U=${T5U}s 6Uend=${T6Uend}s total=${TOTAL}s"

echo "▶ mixing audio beds"
ffmpeg -nostdin -y -loglevel error -i "$WORK/base.mp4" -i "$MUSIC" -i "$OCEAN" -filter_complex "
[1:a]atrim=0:${MLEN},asetpts=PTS-STARTPTS,volume=${MUSIC_VOL},adelay=${T1Ums}|${T1Ums},afade=t=in:st=${T1U}:d=0.5,afade=t=out:st=${MFO}:d=3[mus];
[2:a]atrim=0:${OLEN},asetpts=PTS-STARTPTS,volume=${OCEAN_VOL},adelay=${T5Ums}|${T5Ums},afade=t=in:st=${T5U}:d=1.0,afade=t=out:st=${OFO}:d=1.5[oce];
[0:a][mus][oce]amix=inputs=3:duration=first:normalize=0,alimiter=limit=0.95[a]
" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart "$OUT"

echo "✓ episode -> $OUT  (${TOTAL}s, @${HANDLE})"

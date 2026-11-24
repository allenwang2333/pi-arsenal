#!/usr/bin/env bash
# Screenshot reveal.js slides with all fragments shown.
# Usage: render_slides.sh <deck-dir> <out-dir> [0-based slide index ...]
# Without indexes, renders every top-level <section> in index.html.
set -euo pipefail

deck=$(cd "$1" && pwd)
out=$2
shift 2
mkdir -p "$out"

chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
port=${PORT:-8765}

# Headless print and some scripts fail on file://, so serve over HTTP.
python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$deck" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
sleep 1

if [ $# -eq 0 ]; then
  count=$(grep -c '<section' "$deck/index.html")
  set -- $(seq 0 $((count - 1)))
fi

for i in "$@"; do
  # A fresh profile per shot: a reused profile can serve stale cached HTML.
  profile=$(mktemp -d)
  "$chrome" --headless=new --user-data-dir="$profile" --disable-gpu --hide-scrollbars \
    --window-size=1280,720 --virtual-time-budget=6000 \
    --screenshot="$out/s$(printf %02d $((i + 1))).png" \
    "http://127.0.0.1:$port/index.html?fragments=false#/$i" >/dev/null 2>&1
  rm -rf "$profile"
done
ls "$out"

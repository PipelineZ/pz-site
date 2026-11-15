#!/usr/bin/env bash
# Render every FastDraw diagram under public/diagrams to a light PNG and a dark PNG.
#
#   scripts/render-diagrams.sh                 # all diagrams
#   scripts/render-diagrams.sh public/diagrams/book/05-layers.fdraw   # just these
#
# The light image uses the look the file names (the built-in look when it names none). The dark
# image draws the same file with FastDraw's Night look, which has the same styles on a dark page.
# Set FASTDRAW to the command to use (default: fastdraw on the PATH, else npx fastdraw).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "${FASTDRAW:-}" ]]; then
  read -r -a fd <<<"$FASTDRAW"
elif command -v fastdraw >/dev/null; then
  fd=(fastdraw)
else
  fd=(npx --yes fastdraw)
fi

if [[ $# -gt 0 ]]; then
  files=("$@")
else
  mapfile -t files < <(find public/diagrams -name '*.fdraw' | sort)
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for f in "${files[@]}"; do
  base="${f%.fdraw}"
  "${fd[@]}" check "$f"
  "${fd[@]}" render "$f" -o "$base.png" --scale 2
  # Night replaces whatever look the file names.
  { echo 'look night'; grep -v '^look ' "$f"; } >"$tmp/dark.fdraw"
  "${fd[@]}" render "$tmp/dark.fdraw" -o "$base-dark.png" --scale 2
  echo "rendered $base.png and $base-dark.png"
done

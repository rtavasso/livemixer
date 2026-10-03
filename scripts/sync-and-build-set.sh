#!/usr/bin/env bash
# Pull the show's audio from Google Drive and build the Live set, ready to open.
#
#   scripts/sync-and-build-set.sh            # sync from Drive, then build
#   scripts/sync-and-build-set.sh --no-sync  # build from what is already in .fadr/
#
# Drive holds the finished renders (rendered-stems/<NN Artist - Title>/: equal-length WAVs, _render.json and the
# cached beat analysis _analysis.json), tempo-key.json and the setlist order-camelot.txt, so a new machine needs
# no source stems and no re-analysis. The set is written for Live 11 with the gesture layout (Live 12 opens it).
#
# Drive folder: $LIVEMIXER_DRIVE, else the first "My Drive/livemixer" under ~/Library/CloudStorage (Google Drive
# for desktop on macOS), else G:/My Drive/livemixer (Windows). Output: .fadr/groop-show/LiveMixer Show.als
set -euo pipefail
cd "$(dirname "$0")/.."

SYNC=1
[ "${1:-}" = "--no-sync" ] && SYNC=0
OUT=".fadr/groop-show/${LIVEMIXER_SET:-LiveMixer Show}.als"

find_drive() {
  if [ -n "${LIVEMIXER_DRIVE:-}" ]; then echo "$LIVEMIXER_DRIVE"; return; fi
  for d in "$HOME"/Library/CloudStorage/GoogleDrive-*/"My Drive"/livemixer "/g/My Drive/livemixer" "G:/My Drive/livemixer"; do
    [ -d "$d" ] && { echo "$d"; return; }
  done
  return 1
}

if [ "$SYNC" = 1 ]; then
  DRIVE="$(find_drive)" || { echo "Google Drive folder 'My Drive/livemixer' not found; set LIVEMIXER_DRIVE or pass --no-sync" >&2; exit 1; }
  echo "Syncing from $DRIVE"
  mkdir -p .fadr/groop-show .fadr/additions
  # Live's .asd analysis files are per machine and regenerated; everything else is copied when newer or missing.
  # Drive for desktop streams files on demand, so the first sync downloads ~7 GB.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '*.asd' "$DRIVE/groop-show/" .fadr/groop-show/
    [ -d "$DRIVE/additions" ] && rsync -a "$DRIVE/additions/" .fadr/additions/
  else
    cp -R -u "$DRIVE/groop-show/." .fadr/groop-show/
    [ -d "$DRIVE/additions" ] && cp -R -u "$DRIVE/additions/." .fadr/additions/
  fi
fi

for f in order-camelot.txt tempo-key.json; do
  [ -f ".fadr/groop-show/$f" ] || { echo "missing .fadr/groop-show/$f (sync from Drive first)" >&2; exit 1; }
done

# numpy is all the builder needs beyond the standard library; uv keeps it out of the system Python.
echo "Building $OUT"
uv run --no-project --python 3.12 --with numpy python scripts/ableton-stem-set.py \
  --from-rendered --merge --live 11 --gestures --natural-speed --style crossfade --overlap-bars 2 \
  --order .fadr/groop-show/order-camelot.txt -o "$OUT" --force
echo "Done: open \"$OUT\" in Live, then press Play."

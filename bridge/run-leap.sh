#!/bin/sh
# Runs the Leap Motion depth bridge for the hologram installation and restarts it whenever it exits.
# The Ultraleap service occasionally re-enumerates the camera; only a fresh process gets images again,
# so the bridge is told to give up after two failed restarts (--max-restarts) and this loop relaunches it.
# The learned empty-scene background is kept in bridge/.background.npy: delete it to learn again
# (keep hands out of the box for the first seconds after that).
#
# The picture spans ~25-46 cm above the controller: --near 0.2 keeps a hand touching its bottom edge whole.
#
# Usage: sh bridge/run-leap.sh [extra depth_bridge.py arguments]
set -u
cd "$(dirname "$0")/.." || exit 1
while :; do
  uv run --no-project --python 3.12 --with numpy --with websockets --with opencv-python-headless \
    python bridge/depth_bridge.py --source leap --frame upright --near 0.2 --far 0.55 --box-mm 700 500 \
    --background 4 --background-file bridge/.background.npy --max-restarts 2 "$@"
  code=$?
  [ "$code" -eq 130 ] && exit 0  # Ctrl-C
  echo "bridge exited with status $code; restarting in 2 s" >&2
  sleep 2
done

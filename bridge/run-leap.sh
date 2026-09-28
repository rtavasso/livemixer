#!/bin/sh
# Runs the Leap Motion depth bridge for the hologram installation and keeps it, and the Ultraleap
# tracking service behind it, alive.
#
# The service sometimes stops receiving video from the controller and then serves nothing, to any
# client, until it is restarted or the controller is replugged; a new bridge process alone does not help.
# So when the bridge reports the Leap silent for --leap-timeout seconds (exit status 3), this loop
# restarts the service (launchctl kickstart, allowed without a password by
# `sudo sh bridge/install-leap-restart.sh`) and relaunches the bridge. If service restarts stop helping
# (the controller itself is gone from USB), it backs off and asks for a replug.
#
# The learned empty-scene background is kept in bridge/.background.npy: delete it to learn again
# (keep hands out of the box for the first seconds after that).
#
# The picture spans ~25-46 cm above the controller: --near 0.2 keeps a hand touching its bottom edge whole.
#
# Hands come only from the Leap's own tracker (--no-blob-hands): the stereo scan invents surfaces around
# 25-30 cm from false matches that no background removes, and those used to become phantom hands. The
# scan itself still goes out for the simulations; pass --blob-hands to get scan blobs as hands again.
#
# Usage: sh bridge/run-leap.sh [extra depth_bridge.py arguments]
set -u
cd "$(dirname "$0")/.." || exit 1

SERVICE=system/com.ultraleap.tracking.service
MAX_KICKS=3      # service restarts in a row before backing off
HEALTHY_S=120    # a bridge that ran this long was working: the next failure starts a fresh count

restart_service() {
  if sudo -n /bin/launchctl kickstart -k "$SERVICE" 2>/dev/null; then
    echo "restarted the Ultraleap tracking service" >&2
    sleep 3  # the service reopens the controller within a second; leave it time to stream
    return 0
  fi
  echo "cannot restart the Ultraleap tracking service without a password: run 'sudo sh bridge/install-leap-restart.sh' once, or replug the controller" >&2
  return 1
}

kicks=0
while :; do
  started=$(date +%s)
  uv run --no-project --python 3.12 --with numpy --with websockets --with opencv-python-headless \
    python bridge/depth_bridge.py --source leap --frame upright --near 0.2 --far 0.55 --box-mm 700 500 \
    --background 4 --background-file bridge/.background.npy --max-restarts 0 --leap-timeout 8 --no-blob-hands "$@"
  code=$?
  [ "$code" -eq 130 ] && exit 0  # Ctrl-C
  [ $(( $(date +%s) - started )) -ge "$HEALTHY_S" ] && kicks=0
  if [ "$code" -ne 3 ]; then
    echo "bridge exited with status $code; restarting in 2 s" >&2
    sleep 2
  elif [ "$kicks" -ge "$MAX_KICKS" ]; then
    echo "the Leap stayed silent after $kicks service restarts: replug the controller (check the cable and hub); retrying in 30 s" >&2
    kicks=0
    sleep 30
  else
    kicks=$((kicks + 1))
    echo "the Leap went silent; restarting the tracking service (attempt $kicks of $MAX_KICKS)" >&2
    restart_service || sleep 5
  fi
done

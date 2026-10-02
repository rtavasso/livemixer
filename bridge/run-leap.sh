#!/bin/sh
# Runs the Leap Motion depth bridge for the hologram installation and relaunches it whenever it exits,
# until Ctrl-C / SIGTERM / SIGHUP (POSIX sh: macOS /bin/sh and zsh's sh mode, Linux, Git Bash).
#
# Failures and what happens:
# - No images for --stall-restart seconds (unplugged controller, service restart, LeapC stall): the bridge
#   reopens its LeapC connection, every ~6 s, as long as it takes.
# - The Ultraleap service occasionally re-enumerates the camera in a way only a fresh process recovers from,
#   so after --max-restarts failed reopenings (~25 s) the bridge exits with status 3 and this loop starts a
#   new one; a LeapC thread stuck in a native call, or a hung read, does the same at once.
# - Every frame failing analysis for 30 s: status 4, relaunched. A single bad frame is just skipped.
# - A crash within 10 s of starting (port in use, missing package) backs off 2, 4, 8 ... 30 s.
# While the controller stays away this script says so once a minute.
#
# Learned once and kept for later starts (delete the file, or pass --relearn for the second, to learn again):
# - bridge/.background.npy: the empty scene (keep hands out of the box for the first seconds after deleting it).
# - bridge/.leap-state.json: the right camera's alignment and the hand-skeleton convention.
#
# The picture spans ~25-46 cm above the controller: --near 0.2 keeps a hand touching its bottom edge whole.
#
# Usage: sh bridge/run-leap.sh [extra depth_bridge.py arguments]
set -u
cd "$(dirname "$0")/.." || exit 1

log() {
  printf '%s run-leap: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

stop=0
child=
on_signal() {
  stop=1
  if [ -n "$child" ]; then
    # The bridge runs as a background job (so this trap runs at once instead of after it exits): signal
    # Python itself where pkill can find it, and uv, which forwards the signal too. The bridge ignores repeats.
    pkill -TERM -P "$child" 2>/dev/null
    kill -TERM "$child" 2>/dev/null
  fi
}
trap on_signal INT TERM HUP

crash_backoff=2
last_wait_log=0
outage_since=
while [ "$stop" -eq 0 ]; do
  started=$(date +%s)
  uv run --no-project --python 3.12 --with numpy --with websockets --with opencv-python-headless \
    python bridge/depth_bridge.py --source leap --frame upright --near 0.2 --far 0.55 --box-mm 700 500 \
    --background 4 --background-file bridge/.background.npy --leap-state bridge/.leap-state.json \
    --stall-restart 5 --max-restarts 3 "$@" &
  child=$!
  wait "$child"
  code=$?
  # A trapped signal ends `wait` early: keep waiting while the bridge closes the controller.
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    code=$?
  done
  child=
  [ "$stop" -eq 1 ] && break
  now=$(date +%s)
  ran=$((now - started))
  if [ "$ran" -ge 60 ]; then  # it ran for a while (a give-up cycle takes ~25 s): whatever happens now is a new episode
    outage_since=
    last_wait_log=0
  fi
  if [ "$code" -eq 3 ]; then
    # The controller is away (or LeapC wedged): relaunch at once, say so once a minute.
    [ -z "$outage_since" ] && outage_since=$(date '+%H:%M:%S')
    if [ $((now - last_wait_log)) -ge 60 ]; then
      log "no frames from the Leap since $outage_since; still relaunching the bridge (status 3)"
      last_wait_log=$now
    fi
    pause=1
  else
    outage_since=
    if [ "$ran" -lt 10 ]; then
      pause=$crash_backoff
      crash_backoff=$((crash_backoff * 2))
      [ "$crash_backoff" -gt 30 ] && crash_backoff=30
    else
      pause=2
      crash_backoff=2
    fi
    log "bridge exited with status $code after ${ran} s; relaunching in ${pause} s"
  fi
  sleep "$pause" &
  child=$!
  wait "$child"
  child=
done
log "stopped"
exit 0

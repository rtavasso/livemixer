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
# - The Ultraleap service itself sometimes stops receiving video from the controller (a known Hyperion 6.2
#   stall) and then serves nothing, to any client, until it is restarted or the controller is replugged; a
#   new bridge process alone does not help. So on status 3 (macOS) this loop also restarts the service
#   (launchctl kickstart, allowed without a password by `sudo sh bridge/install-leap-restart.sh`), up to
#   three times in a row; past that the controller itself is gone from USB and it asks for a replug.
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
# Hands come only from the Leap's own tracker (--no-blob-hands): the stereo scan invents surfaces around
# 25-30 cm from false matches that no background removes, and those used to become phantom hands. The
# scan itself still goes out for the simulations; pass --blob-hands to get scan blobs as hands again.
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

SERVICE=system/com.ultraleap.tracking.service
MAX_KICKS=3  # service restarts in a row before asking for a replug
kicks=0
kick_hint_shown=0

restart_service() {
  [ -x /bin/launchctl ] || return 1  # macOS only; elsewhere relaunching the bridge is all there is
  if sudo -n /bin/launchctl kickstart -k "$SERVICE" 2>/dev/null; then
    log "restarted the Ultraleap tracking service (attempt $kicks of $MAX_KICKS)"
    sleep 3  # the service reopens the controller within a second; leave it time to stream
    return 0
  fi
  if [ "$kick_hint_shown" -eq 0 ]; then
    log "cannot restart the Ultraleap tracking service without a password: run 'sudo sh bridge/install-leap-restart.sh' once, or replug the controller"
    kick_hint_shown=1
  fi
  return 1
}

crash_backoff=2
last_wait_log=0
outage_since=
while [ "$stop" -eq 0 ]; do
  started=$(date +%s)
  uv run --no-project --python 3.12 --with numpy --with websockets --with opencv-python-headless \
    python bridge/depth_bridge.py --source leap --frame upright --near 0.2 --far 0.55 --box-mm 700 500 \
    --background 4 --background-file bridge/.background.npy --leap-state bridge/.leap-state.json \
    --stall-restart 5 --max-restarts 3 --no-blob-hands "$@" &
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
    kicks=0
  fi
  if [ "$code" -eq 3 ]; then
    # The controller is away (or LeapC wedged): relaunch at once, say so once a minute.
    [ -z "$outage_since" ] && outage_since=$(date '+%H:%M:%S')
    if [ "$kicks" -lt "$MAX_KICKS" ]; then
      kicks=$((kicks + 1))
      restart_service
      why="still relaunching the bridge (status 3)"
    else
      why="the service restarts did not help: replug the controller (check the cable and hub); still relaunching the bridge"
    fi
    if [ $((now - last_wait_log)) -ge 60 ]; then
      log "no frames from the Leap since $outage_since; $why"
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

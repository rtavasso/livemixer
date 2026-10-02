#!/bin/bash
# LiveMixer show launcher: starts everything the installation needs and keeps it running unattended.
#
#   web        production build of the pages, served by `vite preview` on 127.0.0.1:4179 (no dev reloads)
#   bridge     scripts/ableton-bridge.py (controls page -> Live), fail-safe "living" (instrumental) by default
#   leap       sh bridge/run-leap.sh (Leap depth bridge; it also loops on its own)
#   caffeinate macOS only: no display or system sleep while the show runs
#   chrome     macOS only: the simulation (fullscreen) and the controls page as two Chrome app windows
#
# Every service is supervised: when it exits it is restarted after 1 s, doubling to at most 30 s, and the
# delay goes back to 1 s once it has stayed up for a minute. Output goes to logs/<service>.log (rotated
# at 10 MB, 3 old files kept); logs/show.log has starts, exits and a health line every minute.
# Ctrl-C or SIGTERM stops everything; the bridge puts Live at the fail-safe mix on the way out.
#
# Usage: scripts/show/show.sh [--dry-run] [--no-browser]      (or: npm run show -- --dry-run)
# Environment:
#   LIVEMIXER_MIDI_PORT        MIDI output to Live (default "IAC Driver LiveMixer")
#   LIVEMIXER_FAIL_SAFE        living (instrumental, the default) | full (full vocals, for the old two-song sets)
#   LIVEMIXER_SIM              tide | lantern | murmuration (default tide)
#   LIVEMIXER_SIM_PARAMS       extra sim.html query, e.g. "rotate=20&rotation=tide,lantern"
#   LIVEMIXER_SIM_POSITION     x,y of the display for the simulation window, e.g. "1920,0"
#   LIVEMIXER_CHROME           path to the Chrome binary (default: /Applications/Google Chrome.app)
#   LIVEMIXER_CHROME_PROFILE   Chrome profile for the show (default ~/Library/Application Support/LiveMixerShow)
#   LIVEMIXER_CHROME_DEBUG_PORT  local DevTools port used to check that both windows are open (default 9333)
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd) || exit 1
cd "$ROOT" || exit 1

LOGS=$ROOT/logs
STATE=$LOGS/.state
LOG_MAX=$((10 * 1024 * 1024))
LOG_KEEP=3
WEB_PORT=4179
WEB_URL=http://127.0.0.1:$WEB_PORT
MIDI_PORT=${LIVEMIXER_MIDI_PORT:-IAC Driver LiveMixer}
FAIL_SAFE=${LIVEMIXER_FAIL_SAFE:-living}
SIM=${LIVEMIXER_SIM:-tide}
SIM_URL="$WEB_URL/sim.html?source=depth&sim=$SIM&overlay=0${LIVEMIXER_SIM_PARAMS:+&$LIVEMIXER_SIM_PARAMS}"
CONTROLS_URL="$WEB_URL/ableton.html?connect=1"
SIM_POSITION=${LIVEMIXER_SIM_POSITION:-}
PROFILE=${LIVEMIXER_CHROME_PROFILE:-$HOME/Library/Application Support/LiveMixerShow}
DEBUG_PORT=${LIVEMIXER_CHROME_DEBUG_PORT:-9333}
CHROME=${LIVEMIXER_CHROME:-}

DRY_RUN=0
BROWSER=1
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --no-browser) BROWSER=0 ;;
    -h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

IS_MAC=0
[ "$(uname -s)" = Darwin ] && IS_MAC=1

# launchd starts us with a bare PATH: add the usual homes of node, npm and uv.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export PYTHONUNBUFFERED=1
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u; . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; set -u
fi

# ---------------------------------------------------------------------------------------------- logging

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

rotate() {  # file: once it passes LOG_MAX, file -> file.1 -> file.2 -> file.3 (the oldest is dropped)
  [ -f "$1" ] || return 0
  size=$(( $(wc -c <"$1" 2>/dev/null || echo 0) ))
  [ "$size" -gt "$LOG_MAX" ] || return 0
  i=$LOG_KEEP
  while [ "$i" -gt 1 ]; do
    [ -f "$1.$((i - 1))" ] && mv -f "$1.$((i - 1))" "$1.$i"
    i=$((i - 1))
  done
  mv -f "$1" "$1.1"
}

say() {  # a timestamped line on stdout (the service log inside a supervisor) and in logs/show.log
  line="$(stamp) $*"
  echo "$line"
  [ "$DRY_RUN" = 1 ] && return 0
  rotate "$LOGS/show.log"
  echo "$line" >>"$LOGS/show.log"
}

logwriter() {  # file: appends stdin to the file, rotating it as it grows; survives Ctrl-C to drain the last lines
  trap '' INT TERM HUP
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >>"$1"
    n=$((n + 1))
    if [ "$n" -ge 200 ]; then n=0; rotate "$1"; fi
  done
}

# ------------------------------------------------------------------------------------------ processes

descendants() {  # pid: every descendant pid (macOS / Linux ps; prints nothing where ps cannot)
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      found[root] = 1; changed = 1
      while (changed) { changed = 0; for (p in parent) if (!(p in found) && (parent[p] in found)) { found[p] = 1; changed = 1 } }
      for (p in found) if (p != root) print p
    }'
}

stop_tree() {  # pid: SIGTERM the process and everything under it, SIGKILL what is left after 8 s
  pids="$1 $(descendants "$1" | tr '\n' ' ')"
  kill -TERM $pids 2>/dev/null
  i=0
  while [ "$i" -lt 16 ]; do
    alive=
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && return 0
    sleep 0.5
    i=$((i + 1))
  done
  kill -KILL $alive 2>/dev/null
  return 0
}

supervise() {  # name command...: runs the command forever; restarts with backoff 1 -> 30 s
  name=$1; shift
  child=; napper=; restarts=0; delay=1
  write_state() { printf '%s %s %s\n' "$1" "$restarts" "$(stamp)" >"$STATE/$name"; }
  trap '[ -n "$napper" ] && kill "$napper" 2>/dev/null; [ -n "$child" ] && stop_tree "$child"; write_state stopped; exit 0' TERM HUP INT
  while :; do
    started=$(date +%s)
    say "$name: starting: $*"
    "$@" </dev/null &
    child=$!
    write_state up
    wait "$child"
    code=$?
    child=
    ran=$(( $(date +%s) - started ))
    [ "$ran" -ge 60 ] && delay=1
    restarts=$((restarts + 1))
    write_state down
    say "$name: exited with status $code after ${ran}s; restart $restarts in ${delay}s"
    sleep "$delay" &
    napper=$!
    wait "$napper"
    napper=
    delay=$((delay * 2))
    [ "$delay" -gt 30 ] && delay=30
  done
}

SUPERVISORS=
start() {  # name command...: supervise in the background, output to logs/<name>.log
  name=$1
  if [ "$DRY_RUN" = 1 ]; then
    shift; printf 'would start %-10s' "$name"; printf ' %q' "$@"; echo; return 0
  fi
  supervise "$@" > >(logwriter "$LOGS/$name.log") 2>&1 &
  SUPERVISORS="$SUPERVISORS $!"
}

# ---------------------------------------------------------------------------------------------- build

server_up() { curl -fsS -o /dev/null --max-time 2 "$WEB_URL/sim.html" 2>/dev/null; }

build_if_needed() {  # npm run build, unless dist is newer than everything it is built from
  stampfile=dist/.show-build
  if [ -f "$stampfile" ] && [ -f dist/sim.html ] && [ -f dist/ableton.html ]; then
    newer=$(find src public index.html sim.html ableton.html telemetry.html vite.config.ts package.json package-lock.json \
      -newer "$stampfile" -print 2>/dev/null | head -n 1)
    if [ -z "$newer" ]; then say "build: dist is up to date"; return 0; fi
    reason="$newer changed"
  else
    reason="no show build yet"
  fi
  if [ "$DRY_RUN" = 1 ]; then echo "would build ($reason): npm run build"; return 0; fi
  say "build: $reason; npm run build (log: logs/build.log)"
  rotate "$LOGS/build.log"
  if npm run build >>"$LOGS/build.log" 2>&1; then
    touch "$stampfile"; say "build: done"
  elif [ -f dist/sim.html ] && [ -f dist/ableton.html ]; then
    say "build: FAILED (see logs/build.log); serving the previous build"
  else
    say "build: FAILED and there is no previous build (see logs/build.log)"
    return 1
  fi
}

# --------------------------------------------------------------------------------------------- chrome

find_chrome() {
  for c in "$CHROME" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

chrome_flags() {  # one per line; the same profile for both windows so they share BroadcastChannel
  printf '%s\n' --user-data-dir="$PROFILE" --remote-debugging-port="$DEBUG_PORT" \
    --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
    --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check \
    --hide-crash-restore-bubble --disable-session-crashed-bubble --disable-features=Translate
}

windows_ok() {  # both show pages are open (or the DevTools port does not answer, so we cannot tell)
  list=$(curl -fsS --max-time 5 "http://127.0.0.1:$DEBUG_PORT/json/list" 2>/dev/null) || return 0
  case $list in *"/sim.html"*) ;; *) return 1 ;; esac
  case $list in *"/ableton.html"*) ;; *) return 1 ;; esac
  return 0
}

chrome_session() {  # one Chrome with both app windows; returns (so it is restarted) if either window is gone
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null && sleep 2  # a leftover show browser would swallow our windows
  until server_up; do sleep 1; done
  mkdir -p "$PROFILE"
  flags=$(chrome_flags)
  IFS='
'
  # shellcheck disable=SC2086  # one flag per line
  "$CHROME" $flags ${SIM_POSITION:+--window-position=$SIM_POSITION} --start-fullscreen --app="$SIM_URL" &
  browser=$!
  sleep 5
  "$CHROME" $flags --app="$CONTROLS_URL"  # hands the window to the running browser and returns
  unset IFS
  while kill -0 "$browser" 2>/dev/null; do
    sleep 30
    if ! windows_ok; then
      echo "$(stamp) a show window was closed; restarting Chrome"
      stop_tree "$browser"
      return 1
    fi
  done
  wait "$browser"
}

manual_urls() {
  until server_up; do sleep 1; done
  say "browser: open these in Google Chrome (same profile, separate windows):"
  say "  simulation (fullscreen on the hologram display): $SIM_URL"
  say "  controls: $CONTROLS_URL"
}

health() {
  line=
  for name in $SERVICES; do
    if [ -f "$STATE/$name" ]; then
      read -r status restarts _ <"$STATE/$name"
      line="$line $name=$status/$restarts"
    else
      line="$line $name=?"
    fi
  done
  server_up && web="answers" || web="NOT ANSWERING"
  say "health:$line (service=status/restarts); $WEB_URL $web"
}

shutdown() {
  trap '' INT TERM HUP
  say "show: stopping"
  for pid in $SUPERVISORS; do kill -TERM "$pid" 2>/dev/null; done
  for pid in $SUPERVISORS; do wait "$pid" 2>/dev/null; done
  say "show: stopped"
  exit 0
}

# ----------------------------------------------------------------------------------------------- main

if [ "$DRY_RUN" = 0 ]; then
  mkdir -p "$STATE" || exit 1
  rm -f "$STATE"/*
fi
say "show: starting in $ROOT (sim $SIM, MIDI '$MIDI_PORT')"

missing=
for tool in node npm uv curl; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
if [ -n "$missing" ]; then
  say "show: missing:$missing (see docs/SHOW.md); exiting"
  [ "$DRY_RUN" = 1 ] || exit 1
fi

build_if_needed || exit 1

[ "$DRY_RUN" = 1 ] || trap shutdown INT TERM HUP

SERVICES="web bridge leap"
start web ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort
start bridge uv run scripts/ableton-bridge.py --midi-port "$MIDI_PORT" --fail-safe "$FAIL_SAFE"
start leap sh bridge/run-leap.sh
if [ "$IS_MAC" = 1 ] || [ "$DRY_RUN" = 1 ]; then
  SERVICES="$SERVICES caffeinate"
  [ "$IS_MAC" = 1 ] || echo "(macOS only)"
  start caffeinate caffeinate -dims
fi

if [ "$BROWSER" = 1 ]; then
  if CHROME=$(find_chrome); then
    SERVICES="$SERVICES chrome"
    if [ "$DRY_RUN" = 1 ]; then
      flags=$(chrome_flags | tr '\n' ' ')
      echo "would start chrome     (after $WEB_URL answers; restarted if it quits or a window is closed)"
      echo "  \"$CHROME\" $flags${SIM_POSITION:+--window-position=$SIM_POSITION }--start-fullscreen --app=$SIM_URL"
      echo "  \"$CHROME\" $flags--app=$CONTROLS_URL"
    else
      start chrome chrome_session
    fi
  elif [ "$DRY_RUN" = 1 ]; then
    echo "Google Chrome not found: would print these URLs to open by hand:"
    echo "  $SIM_URL"
    echo "  $CONTROLS_URL"
  else
    manual_urls &
  fi
fi

[ "$DRY_RUN" = 1 ] && exit 0

while :; do
  sleep 60 &
  wait $!
  health
done

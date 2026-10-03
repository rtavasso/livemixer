#!/bin/bash
# Installs the LiveMixer show as a LaunchAgent: it starts at login and launchd restarts show.sh if it exits.
# Usage: scripts/show/install-launch-agent.sh      (undo: scripts/show/uninstall-launch-agent.sh)
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=com.livemixer.show
TARGET=$HOME/Library/LaunchAgents/$LABEL.plist

[ "$(uname -s)" = Darwin ] || { echo "LaunchAgents are macOS only." >&2; exit 1; }
case $ROOT$HOME in
  *'&'* | *'<'* | *'>'* | *'|'*) echo "The repository path must not contain & < > or |: $ROOT" >&2; exit 1 ;;
esac
case $ROOT in
  "$HOME/Desktop"* | "$HOME/Documents"* | "$HOME/Downloads"*)
    echo "Note: $ROOT is in a folder macOS protects. launchd's /bin/bash cannot read it unless /bin/bash has"
    echo "Full Disk Access (System Settings > Privacy & Security). Moving the repository to e.g. ~/livemixer avoids that."
    ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" "$ROOT/scripts/show/LiveMixerShow.plist" >"$TARGET"
plutil -lint "$TARGET" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
echo "Installed $TARGET; the show is starting (logs: $ROOT/logs/show.log)."
echo "Stop it for now:  launchctl bootout gui/$(id -u)/$LABEL     (it starts again at the next login)"
echo "Remove it:        scripts/show/uninstall-launch-agent.sh"

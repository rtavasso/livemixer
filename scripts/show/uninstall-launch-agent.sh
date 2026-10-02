#!/bin/bash
# Stops the LiveMixer show LaunchAgent (show.sh stops every service; the bridge releases Live) and removes it.
set -eu

LABEL=com.livemixer.show
TARGET=$HOME/Library/LaunchAgents/$LABEL.plist

[ "$(uname -s)" = Darwin ] || { echo "LaunchAgents are macOS only." >&2; exit 1; }
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped $LABEL." || echo "$LABEL was not running."
rm -f "$TARGET" && echo "Removed $TARGET."

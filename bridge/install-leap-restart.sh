#!/bin/sh
# One-time setup: lets bridge/run-leap.sh restart the Ultraleap tracking service without a password.
# The service sometimes stops receiving video from the controller ("run_device_tracker error receiving
# video frames" in /var/log/ultraleap/tracker_log.txt) and then serves nothing until it is restarted or
# the controller is replugged. The rule allows exactly one command, as root, for the invoking user:
#   /bin/launchctl kickstart -k system/com.ultraleap.tracking.service
#
# Usage: sudo sh bridge/install-leap-restart.sh      (remove with: sudo rm /etc/sudoers.d/livemixer-leap)
set -eu
[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo sh bridge/install-leap-restart.sh" >&2; exit 1; }
user=${SUDO_USER:?run through sudo so the rule names your user}
file=/etc/sudoers.d/livemixer-leap
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.ultraleap.tracking.service\n' "$user" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 0440 -o root -g wheel "$tmp" "$file"
echo "installed $file: $user may restart the Ultraleap tracking service without a password"

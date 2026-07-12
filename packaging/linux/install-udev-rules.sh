#!/usr/bin/env bash
# DS5 Bridge system setup (for AppImage users; the pacman package does this
# automatically).
#
# Usage: put this script in the same folder as the DS5-Bridge-Companion
# AppImage (or the bundled 60-ds5bridge.rules / 52-ds5-bridge-noucm.conf),
# then run:
#
#   sudo bash install-udev-rules.sh
#
# It installs the udev rules (device access + chord key injection) and the
# WirePlumber rule that exposes the controller's audio/haptic channels, then
# reloads them. Unplug and replug the bridge once afterward.
set -euo pipefail

RULES_NAME="60-ds5bridge.rules"
WP_CONF_NAME="52-ds5-bridge-noucm.conf"
RULES_DIR="${DS5_UDEV_RULES_DIR:-/etc/udev/rules.d}"
WP_CONF_DIR="${DS5_WIREPLUMBER_DIR:-/etc/wireplumber/wireplumber.conf.d}"
MODULES_DIR="${DS5_MODULES_LOAD_DIR:-/etc/modules-load.d}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DS5_UDEV_RULES_DIR:-}" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash $(basename "${BASH_SOURCE[0]}")" >&2
  exit 1
fi

# Find a bundled file $1 either next to this script or inside a DS5 Bridge
# AppImage (under resources/$2/). Echoes the resolved path on success.
find_bundled() {
  local name="$1" appimage_subdir="$2"
  if [ -f "$SCRIPT_DIR/$name" ]; then
    echo "$SCRIPT_DIR/$name"
    return 0
  fi
  local appimage
  appimage=$(find "$SCRIPT_DIR" -maxdepth 1 -name 'DS5-Bridge-Companion-*.AppImage' | sort | tail -1)
  if [ -n "$appimage" ]; then
    local extract_dir
    extract_dir=$(mktemp -d)
    (
      cd "$extract_dir"
      chmod +x "$appimage" 2>/dev/null || true
      "$appimage" --appimage-extract "resources/$appimage_subdir/$name" > /dev/null
    )
    if [ -f "$extract_dir/squashfs-root/resources/$appimage_subdir/$name" ]; then
      echo "$extract_dir/squashfs-root/resources/$appimage_subdir/$name"
      return 0
    fi
    rm -rf "$extract_dir"
  fi
  return 1
}

rules_source=$(find_bundled "$RULES_NAME" udev) || {
  echo "Could not find $RULES_NAME or a DS5-Bridge-Companion AppImage next to this script." >&2
  echo "Put this script in the same folder as the AppImage (or the rules file) and rerun." >&2
  exit 1
}

install -D -m 0644 "$rules_source" "$RULES_DIR/$RULES_NAME"
echo "Installed $RULES_DIR/$RULES_NAME"

# WirePlumber rule that exposes the controller's 4-channel audio (speaker +
# haptics). Not fatal if it can't be found.
if wp_source=$(find_bundled "$WP_CONF_NAME" wireplumber); then
  install -D -m 0644 "$wp_source" "$WP_CONF_DIR/$WP_CONF_NAME"
  echo "Installed $WP_CONF_DIR/$WP_CONF_NAME"
  if [ -z "${DS5_WIREPLUMBER_DIR:-}" ] && [ -n "${SUDO_USER:-}" ]; then
    uid=$(id -u "$SUDO_USER")
    sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$uid" \
      systemctl --user restart wireplumber pipewire pipewire-pulse 2>/dev/null \
      && echo "Restarted audio for $SUDO_USER" \
      || echo "Restart audio to apply:  systemctl --user restart wireplumber pipewire pipewire-pulse"
  fi
else
  echo "Note: $WP_CONF_NAME not found; controller audio/haptics rule not installed." >&2
fi

if command -v udevadm > /dev/null 2>&1 && [ -z "${DS5_UDEV_RULES_DIR:-}" ]; then
  udevadm control --reload
  udevadm trigger
  echo "Reloaded udev rules"
fi

# Chord key injection needs the uinput module.
if [ -z "${DS5_MODULES_LOAD_DIR:-}" ] || [ -d "$MODULES_DIR" ]; then
  mkdir -p "$MODULES_DIR"
  echo uinput > "$MODULES_DIR/ds5bridge-uinput.conf"
  echo "Enabled uinput module load on boot"
fi
if [ -z "${DS5_UDEV_RULES_DIR:-}" ]; then
  modprobe uinput 2>/dev/null || true
fi

echo ""
echo "Done. Unplug and replug the DS5 Bridge dongle, then start the app."

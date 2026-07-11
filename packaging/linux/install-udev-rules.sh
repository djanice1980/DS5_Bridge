#!/usr/bin/env bash
# DS5 Bridge udev rules installer (for AppImage users; the pacman package
# installs the rules automatically).
#
# Usage: put this script in the same folder as either 60-ds5bridge.rules or
# the DS5-Bridge-Companion AppImage, then run:
#
#   sudo bash install-udev-rules.sh
#
# It installs the udev rules, reloads udev, and makes sure the uinput module
# (chord key injection) is loaded now and on boot. Then unplug and replug the
# bridge once.
set -euo pipefail

RULES_NAME="60-ds5bridge.rules"
RULES_DIR="${DS5_UDEV_RULES_DIR:-/etc/udev/rules.d}"
MODULES_DIR="${DS5_MODULES_LOAD_DIR:-/etc/modules-load.d}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DS5_UDEV_RULES_DIR:-}" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash $(basename "${BASH_SOURCE[0]}")" >&2
  exit 1
fi

find_rules_source() {
  # 1) rules file sitting next to this script
  if [ -f "$SCRIPT_DIR/$RULES_NAME" ]; then
    echo "$SCRIPT_DIR/$RULES_NAME"
    return 0
  fi

  # 2) extract from a DS5 Bridge AppImage sitting next to this script
  local appimage
  appimage=$(find "$SCRIPT_DIR" -maxdepth 1 -name 'DS5-Bridge-Companion-*.AppImage' | sort | tail -1)
  if [ -n "$appimage" ]; then
    local extract_dir
    extract_dir=$(mktemp -d)
    (
      cd "$extract_dir"
      chmod +x "$appimage" 2>/dev/null || true
      "$appimage" --appimage-extract "resources/udev/$RULES_NAME" > /dev/null
    )
    if [ -f "$extract_dir/squashfs-root/resources/udev/$RULES_NAME" ]; then
      echo "$extract_dir/squashfs-root/resources/udev/$RULES_NAME"
      return 0
    fi
    rm -rf "$extract_dir"
  fi

  return 1
}

rules_source=$(find_rules_source) || {
  echo "Could not find $RULES_NAME or a DS5-Bridge-Companion AppImage next to this script." >&2
  echo "Put this script in the same folder as the AppImage (or the rules file) and rerun." >&2
  exit 1
}

install -D -m 0644 "$rules_source" "$RULES_DIR/$RULES_NAME"
echo "Installed $RULES_DIR/$RULES_NAME"

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

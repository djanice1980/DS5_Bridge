#!/bin/sh
# DS5 Bridge pacman post-remove: the packaged udev rules file is removed by
# pacman itself; clean up what the install hook created, reload udev, and
# refresh the desktop database (this script replaces electron-builder's
# default hook).
set -e

rm -f /etc/modules-load.d/ds5bridge-uinput.conf

if command -v udevadm > /dev/null 2>&1; then
  udevadm control --reload || true
fi

if command -v update-desktop-database > /dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

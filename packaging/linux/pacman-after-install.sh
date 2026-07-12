#!/bin/sh
# DS5 Bridge pacman post-install: activate the packaged udev rules, make sure
# uinput (chord key injection) is available now and on boot, and perform the
# steps electron-builder's default hook would have done (this script replaces
# it): sandbox SUID bit and desktop database refresh.
set -e

# Electron sandbox helper needs the SUID bit where user namespaces are off.
chmod 4755 '/opt/DS5 Bridge/chrome-sandbox' 2> /dev/null || true

if command -v update-desktop-database > /dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

if command -v udevadm > /dev/null 2>&1; then
  udevadm control --reload || true
  udevadm trigger || true
fi

mkdir -p /etc/modules-load.d
echo uinput > /etc/modules-load.d/ds5bridge-uinput.conf
modprobe uinput 2> /dev/null || true

# Refresh the icon cache so the app shows an icon in the menu.
if command -v gtk-update-icon-cache > /dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2> /dev/null || true
fi

echo "DS5 Bridge: udev rules active. Unplug and replug the bridge dongle once."
echo "DS5 Bridge: a WirePlumber rule was installed to fix controller audio/haptics."
echo "            Restart audio to apply it:  systemctl --user restart wireplumber pipewire pipewire-pulse"
echo "            (or just log out and back in / reboot)."

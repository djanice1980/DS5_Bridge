#!/usr/bin/env python3
"""
trigger-hold.py - continuously assert an adaptive-trigger effect, like a game.

The companion probe (trigger-probe.py) can only fire a one-shot trigger command,
which the controller then holds until it decays to a "click". A real game instead
re-sends the DualSense OUTPUT report every frame, continuously re-asserting the
effect. This tool does the same: it writes the exact feedback effect the firmware
uses, to the controller's HID gamepad interface, at a game-like rate.

Use it to answer: does a *continuously maintained* trigger hold under audio, or
still collapse to a click? Play audio through the controller, run this, and feel
the triggers.

  - If the triggers HOLD firm resistance while audio plays -> continuous
    maintenance beats the audio contention (the interleave earns its keep).
  - If they still only click while audio plays and firm up ~a few seconds after
    audio stops -> it's the controller's ceiling; maintenance can't help.

Linux only (writes the gamepad hidraw device directly; no dependencies).
Requires write access to /dev/hidrawN (the ds5bridge udev rule grants it; else
run with sudo). Close nothing -- this uses the gamepad interface, not the
companion interface, so it can run alongside the DS5 Bridge app.

Usage:
  python3 trigger-hold.py                 # both triggers, ~10 ms, until Ctrl+C
  python3 trigger-hold.py --seconds 20     # run for 20 s then release
  python3 trigger-hold.py --target r2      # right trigger only
  python3 trigger-hold.py --strength 8 --position 3
"""

import argparse
import glob
import os
import sys
import time

DS_VID = "054C"
DS_PID = "0CE6"

# DualSense output-report layout (src/dualsense_output.h)
USB_OUTPUT_REPORT_ID = 0x02
COMMON_PAYLOAD_SIZE = 47
FLAG0_RIGHT_TRIGGER = 0x04
FLAG0_LEFT_TRIGGER = 0x08
TRIGGER_EFFECT_RIGHT_OFF = 10   # payload offsets
TRIGGER_EFFECT_LEFT_OFF = 21
TRIGGER_EFFECT_SIZE = 11
EFFECT_OFF = 0x05
EFFECT_FEEDBACK = 0x21


def build_feedback_effect(position, strength):
    """Replicates set_trigger_feedback() from src/bt.cpp exactly."""
    eff = bytearray(TRIGGER_EFFECT_SIZE)
    if strength <= 0:
        eff[0] = EFFECT_OFF
        return eff
    position = min(position, 9)
    strength = min(strength, 8)
    force_value = (strength - 1) & 0x07
    active_zones = 0
    force_zones = 0
    for zone in range(position, 10):
        active_zones |= (1 << zone)
        force_zones |= (force_value << (3 * zone))
    eff[0] = EFFECT_FEEDBACK
    eff[1] = active_zones & 0xFF
    eff[2] = (active_zones >> 8) & 0xFF
    eff[3] = force_zones & 0xFF
    eff[4] = (force_zones >> 8) & 0xFF
    eff[5] = (force_zones >> 16) & 0xFF
    eff[6] = (force_zones >> 24) & 0xFF
    return eff


def build_report(right_eff, left_eff):
    """A 48-byte USB DualSense output report (0x02) carrying the trigger effects."""
    r = bytearray(1 + COMMON_PAYLOAD_SIZE)
    r[0] = USB_OUTPUT_REPORT_ID
    payload = 1  # payload starts right after the report id
    r[payload + 0] = FLAG0_RIGHT_TRIGGER | FLAG0_LEFT_TRIGGER  # valid flag0
    r[payload + TRIGGER_EFFECT_RIGHT_OFF: payload + TRIGGER_EFFECT_RIGHT_OFF + TRIGGER_EFFECT_SIZE] = right_eff
    r[payload + TRIGGER_EFFECT_LEFT_OFF: payload + TRIGGER_EFFECT_LEFT_OFF + TRIGGER_EFFECT_SIZE] = left_eff
    return bytes(r)


def find_gamepad_hidraw():
    """Return /dev/hidrawN for the DualSense GAMEPAD interface (not the keyboard)."""
    for sys_path in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        node = "/dev/" + os.path.basename(sys_path)
        try:
            with open(os.path.join(sys_path, "device", "uevent")) as f:
                uevent = f.read().upper()
        except OSError:
            continue
        if DS_VID not in uevent or DS_PID not in uevent:
            continue
        try:
            with open(os.path.join(sys_path, "device", "report_descriptor"), "rb") as f:
                rdesc = f.read()
        except OSError:
            rdesc = b""
        # Generic Desktop (05 01) + Usage Gamepad (09 05); the keyboard iface is 09 06.
        if b"\x05\x01\x09\x05" in rdesc:
            return node
    return None


def main():
    if sys.platform != "linux":
        sys.exit("trigger-hold.py is Linux-only (writes the gamepad hidraw device). "
                 "Run it on the BC-250.")

    ap = argparse.ArgumentParser(description="Continuously assert an adaptive-trigger effect")
    ap.add_argument("--target", choices=["both", "l2", "r2"], default="both")
    ap.add_argument("--strength", type=int, default=8, help="1-8 (default 8, matches 100%%)")
    ap.add_argument("--position", type=int, default=3, help="0-9 start zone (default 3)")
    ap.add_argument("--interval", type=float, default=10.0, help="ms between reports (default 10)")
    ap.add_argument("--seconds", type=float, default=0.0, help="0 = until Ctrl+C")
    ap.add_argument("--device", help="explicit /dev/hidrawN (skip auto-detect)")
    args = ap.parse_args()

    node = args.device or find_gamepad_hidraw()
    if not node:
        sys.exit("Could not find the DualSense gamepad hidraw device. Is a controller "
                 "connected to the bridge? (Pass --device /dev/hidrawN to override.)")

    on = build_feedback_effect(args.position, args.strength)
    off = build_feedback_effect(0, 0)
    right = on if args.target in ("both", "r2") else off
    left = on if args.target in ("both", "l2") else off
    report = build_report(right, left)
    release = build_report(off, off)

    try:
        fd = os.open(node, os.O_WRONLY)
    except PermissionError:
        sys.exit(f"Permission denied on {node}. Run with sudo, or ensure the ds5bridge "
                 f"udev rule is installed.")
    except OSError as e:
        sys.exit(f"Could not open {node}: {e}")

    print(f"Holding {args.target} trigger (strength {args.strength}, pos {args.position}) "
          f"on {node} every {args.interval:.0f} ms.")
    print("Play audio through the controller now. Ctrl+C to release.\n"
          "  Firm, steady resistance while audio plays -> maintenance beats it.\n"
          "  Still just a click until audio stops -> controller ceiling.")

    interval = args.interval / 1000.0
    deadline = time.monotonic() + args.seconds if args.seconds > 0 else None
    sent = 0
    try:
        while True:
            try:
                os.write(fd, report)
                sent += 1
            except OSError as e:
                print(f"write failed: {e}")
                break
            if sent % 100 == 0:
                print(f"  ... {sent} reports sent", end="\r")
            if deadline and time.monotonic() >= deadline:
                break
            time.sleep(interval)
    except KeyboardInterrupt:
        pass
    finally:
        # A single release frame can be lost in transit or fail to reset the
        # trigger motor -- the DualSense latches its last effect, so one lone
        # "off" report right before we close often doesn't clear the hold
        # (reopening the app, a full state reset, is what clears it). Assert the
        # released state as a short burst, the same way the hold was asserted.
        released = False
        for _ in range(12):
            try:
                os.write(fd, release)
                released = True
            except OSError:
                break
            time.sleep(0.008)
        os.close(fd)
        tail = "" if released else " (release write failed -- squeeze the triggers or reopen the app to clear)"
        print(f"\nDone ({sent} reports). Trigger released.{tail}")


if __name__ == "__main__":
    main()

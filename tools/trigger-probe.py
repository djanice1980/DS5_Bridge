#!/usr/bin/env python3
"""
trigger-probe.py - DS5 Bridge trigger + latency probe.

Drives the DS5 Bridge AudioHelper's `--companion-transport` mode (NDJSON over
stdio) so you can, from the console, WITHOUT the GUI:

  1. Manually engage the adaptive triggers (the same TEST_ADAPTIVE_TRIGGERS
     command the GUI's "Test Triggers" button sends). This isolates whether a
     "trigger won't fully engage" problem is the companion app's flow or the
     firmware/Bluetooth link -- exactly the trick that showed the haptics issue
     was app-side. If the trigger engages fully here but not from the GUI, the
     GUI/flow is the suspect.

  2. Measure the command round-trip (send -> firmware ACK). This is a USB-level
     latency (the firmware ACKs when it PARSES the command, not when it reaches
     the controller over Bluetooth), so it is a sanity check, not the BT latency.

  3. On a DIAGNOSTICS firmware built with `-DDS5_DIAGNOSTICS_PRESET=traces`,
     read the firmware's trigger-trace ring (report 0x09) and show the internal
     stage timeline Host -> BridgeIn -> BridgeOut -> Bt with per-stage
     timestamps. BridgeIn -> BridgeOut is the queue latency the audio/controller
     interleave affects. Run it with audio idle, then with audio playing, and
     compare -- that is the real "does audio delay the controller" measurement.

IMPORTANT: close the DS5 Bridge GUI first. It holds the companion USB interface
exclusively (libusb claim), so this tool cannot attach while it is running.

Examples:
  # interactive menu (auto-detects the AudioHelper)
  python3 trigger-probe.py

  # one-shot: engage both triggers in weapon mode
  python3 trigger-probe.py engage --mode weapon --target both

  # latency: 50 rapid commands, print min/avg/max (run twice: silent, then
  # with audio playing, and compare)
  python3 trigger-probe.py latency --count 50

  # trace timeline of one command (requires a `traces` firmware)
  python3 trigger-probe.py trace

  # point at a specific helper binary
  python3 trigger-probe.py --helper "/opt/DS5 Bridge/resources/native/AudioHelper/AudioHelper" engage
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

REPORT_LENGTH = 64
REPORT_ID_COMMAND = 0x02
REPORT_ID_ACK = 0x03
REPORT_ID_TRIGGER_TRACE = 0x09
MAGIC = (0x44, 0x53, 0x35, 0x42)  # "DS5B"
PROTOCOL_MAJOR = 1
PROTOCOL_MINOR = 16

# Command ids (companion.cpp CommandId / protocol.ts COMMAND_ID).
CMD_SET_TRIGGER_EFFECT_INTENSITY = 0x0C
CMD_TEST_ADAPTIVE_TRIGGERS = 0x0D
CMD_TEST_CLASSIC_RUMBLE = 0x14
CMD_PREVIEW_ADAPTIVE_TRIGGER_EFFECT = 0x1F

# TEST_ADAPTIVE_TRIGGERS value = mode | (target << 8).
TRIGGER_MODES = {"feedback": 0, "weapon": 1, "vibration": 2}
TRIGGER_TARGETS = {"both": 0, "l2": 1, "r2": 2}

# ACK result codes (companion.cpp AckResult).
ACK_NAMES = {
    0x00: "OK", 0x01: "BAD_MAGIC", 0x02: "BAD_VERSION", 0x03: "BAD_LENGTH",
    0x04: "INVALID_VALUE", 0x05: "UNKNOWN_COMMAND", 0x06: "NOT_CONNECTED",
    0x07: "BUSY",
}

# Trigger-trace stages (companion.h CompanionTriggerTraceStage).
STAGE_NAMES = {1: "Host", 2: "BridgeIn", 3: "BridgeOut", 4: "Bt", 5: "Drop"}

# Trigger-trace wire layout (parsed from the 64-byte report 0x09).
TRACE_RECORD_COUNT_OFF = 7
TRACE_RECORD_SIZE_OFF = 8
TRACE_DROPPED_OFF = 13
TRACE_FIRST_RECORD_OFF = 15
TRACE_RECORD_SIZE = 38


def u16(buf, off):
    return buf[off] | (buf[off + 1] << 8)


def u32(buf, off):
    return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)


DEFAULT_HELPER_PATHS = [
    # Linux
    "/opt/DS5 Bridge/resources/native/AudioHelper/AudioHelper",
    os.path.expanduser("~/Applications/DS5 Bridge/resources/native/AudioHelper/AudioHelper"),
    "/usr/lib/ds5-bridge/resources/native/AudioHelper/AudioHelper",
    # Windows
    os.path.expandvars(r"%PROGRAMFILES%\DS5 Bridge\resources\native\AudioHelper\AudioHelper.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\DS5 Bridge\resources\native\AudioHelper\AudioHelper.exe"),
]


def find_helper(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"AudioHelper not found at: {explicit}")
        return explicit
    for path in DEFAULT_HELPER_PATHS:
        if os.path.exists(path):
            return path
    on_path = shutil.which("AudioHelper")
    if on_path:
        return on_path
    sys.exit(
        "Could not find the AudioHelper binary. Pass --helper with its full path.\n"
        "On CachyOS/Linux it is usually:\n"
        "  /opt/DS5 Bridge/resources/native/AudioHelper/AudioHelper\n"
        "(for an AppImage, extract it first with --appimage-extract and point --helper inside squashfs-root)."
    )


class Transport:
    """Thin NDJSON client over `AudioHelper --companion-transport`."""

    def __init__(self, helper_path):
        self.helper_path = helper_path
        self.proc = None
        self._next_id = 1

    def open(self):
        self.proc = subprocess.Popen(
            [self.helper_path, "--companion-transport"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        hello = self._read_line()
        if hello is None:
            code = self.proc.wait()
            if code == 2:
                sys.exit("The bridge/controller is not reachable (helper exit 2). "
                         "Plug in the Pico bridge with a DATA cable, power on the controller, "
                         "and close the DS5 Bridge GUI (it holds the interface).")
            sys.exit(f"AudioHelper exited before the hello line (code {code}).")
        if not (hello.get("ok") and hello.get("id") == 0 and hello.get("path")):
            sys.exit(f"Unexpected hello from AudioHelper: {hello}")
        print(f"Attached to bridge: {hello['path']}")

    def _read_line(self):
        line = self.proc.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            return self._read_line()
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            return self._read_line()

    def _request(self, obj):
        obj_id = self._next_id
        self._next_id += 1
        obj["id"] = obj_id
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()
        while True:
            resp = self._read_line()
            if resp is None:
                raise RuntimeError("AudioHelper closed the transport unexpectedly.")
            if resp.get("id") == obj_id:
                return resp

    def set_report(self, report):
        resp = self._request({"op": "set", "report": list(report)})
        if not resp.get("ok"):
            raise RuntimeError(f"set failed: {resp.get('error')}")

    def get_report(self, report_id):
        resp = self._request({"op": "get", "reportId": report_id & 0xff})
        if not resp.get("ok"):
            raise RuntimeError(f"get 0x{report_id:02x} failed: {resp.get('error')}")
        return resp["report"]

    def close(self):
        if not self.proc:
            return
        try:
            self._request({"op": "close"})
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass


def build_command(cmd, seq, value, payload=()):
    r = [0] * REPORT_LENGTH
    r[0] = REPORT_ID_COMMAND
    r[1], r[2], r[3], r[4] = MAGIC
    r[5] = PROTOCOL_MAJOR
    r[6] = PROTOCOL_MINOR
    r[7] = cmd & 0xff
    r[8] = seq & 0xff
    r[9] = value & 0xff
    r[10] = (value >> 8) & 0xff
    for i, b in enumerate(payload):
        if 11 + i < REPORT_LENGTH:
            r[11 + i] = b & 0xff
    return r


class Probe:
    def __init__(self, transport):
        self.t = transport
        self._seq = 0

    def _seq_next(self):
        self._seq = (self._seq + 1) & 0xff
        return self._seq

    def send(self, cmd, value=0, payload=()):
        """Send a command; return (ack_result_code, round_trip_ms)."""
        seq = self._seq_next()
        report = build_command(cmd, seq, value, payload)
        start = time.perf_counter()
        self.t.set_report(report)
        ack = self.t.get_report(REPORT_ID_ACK)
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        # The ACK report mirrors the command frame: [7]=command_id, [8]=sequence,
        # and the result byte follows. Correlate by sequence when we can.
        result = None
        if len(ack) >= 10 and ack[7] == (cmd & 0xff):
            result = ack[9] if ack[8] == seq else ack[9]
        return result, elapsed_ms

    def set_trigger_intensity(self, percent=100):
        return self.send(CMD_SET_TRIGGER_EFFECT_INTENSITY, value=percent & 0xff)

    def engage_trigger(self, mode="feedback", target="both"):
        value = TRIGGER_MODES[mode] | (TRIGGER_TARGETS[target] << 8)
        return self.send(CMD_TEST_ADAPTIVE_TRIGGERS, value=value)

    def classic_rumble(self):
        return self.send(CMD_TEST_CLASSIC_RUMBLE, value=0)

    def read_trace_events(self, max_reads=400):
        """Drain the trigger-trace ring (report 0x09). One record per GET."""
        events = []
        supported = True
        for _ in range(max_reads):
            try:
                report = self.t.get_report(REPORT_ID_TRIGGER_TRACE)
            except RuntimeError:
                supported = False
                break
            count = report[TRACE_RECORD_COUNT_OFF]
            if count == 0:
                break
            off = TRACE_FIRST_RECORD_OFF
            events.append({
                "sequence": u16(report, off + 0),
                "timestamp_ms": u32(report, off + 2),
                "stage": report[off + 6],
                "report_id": report[off + 7],
                "length": report[off + 8],
                "sequence_tag": report[off + 9],
                "motor_power": report[off + 13],
                "decision": report[off + 14],
                "right_trigger": list(report[off + 15:off + 26]),
                "left_trigger": list(report[off + 26:off + 37]),
            })
        return events, supported


def ack_str(result):
    if result is None:
        return "ack?"
    return ACK_NAMES.get(result, f"0x{result:02x}")


def cmd_engage(probe, args):
    print(f"Setting trigger effect intensity to {args.intensity}% ...")
    r, ms = probe.set_trigger_intensity(args.intensity)
    print(f"  intensity -> {ack_str(r)} ({ms:.2f} ms)")
    print(f"Engaging triggers: mode={args.mode} target={args.target} ...")
    r, ms = probe.engage_trigger(args.mode, args.target)
    print(f"  TEST_ADAPTIVE_TRIGGERS -> {ack_str(r)} ({ms:.2f} ms)")
    print("You should feel the trigger(s) engage now. If it does NOT engage here "
          "but does from a game/other tool, or vice-versa, that narrows the cause.")


def cmd_rumble(probe, args):
    print("Firing TEST_CLASSIC_RUMBLE (routes through the classified output path, "
          "so it produces BridgeIn->BridgeOut->Bt traces on a traces firmware) ...")
    r, ms = probe.classic_rumble()
    print(f"  TEST_CLASSIC_RUMBLE -> {ack_str(r)} ({ms:.2f} ms)")


def cmd_latency(probe, args):
    print(f"Setting intensity {args.intensity}% ...")
    probe.set_trigger_intensity(args.intensity)
    times = []
    acks_ok = 0
    print(f"Firing {args.count} x {args.command} commands ...")
    for _ in range(args.count):
        if args.command == "rumble":
            r, ms = probe.classic_rumble()
        else:
            r, ms = probe.engage_trigger(args.mode, args.target)
        times.append(ms)
        if r == 0x00:
            acks_ok += 1
        time.sleep(args.gap / 1000.0)
    times.sort()
    n = len(times)
    avg = sum(times) / n
    p50 = times[n // 2]
    p95 = times[min(n - 1, int(n * 0.95))]
    print("\nsend -> ACK round-trip (USB-level; not the Bluetooth send latency):")
    print(f"  count={n}  ok={acks_ok}/{n}")
    print(f"  min={times[0]:.2f}  p50={p50:.2f}  avg={avg:.2f}  p95={p95:.2f}  max={times[-1]:.2f}  (ms)")
    print("Tip: run this once with audio idle and once with audio playing and compare. "
          "For the true controller-vs-audio latency, use `trace` on a traces firmware.")


AUDIO_REPORT_ID = 0x36  # DualSense audio-out report; floods the trace during playback


def cmd_trace(probe, args):
    # Clear any stale ring, fire one command, then read the resulting timeline.
    probe.read_trace_events()
    probe.set_trigger_intensity(args.intensity)
    if args.command == "rumble":
        print("Firing TEST_CLASSIC_RUMBLE (classified output path) and reading the firmware trace ...")
        probe.classic_rumble()
    else:
        print("Firing TEST_ADAPTIVE_TRIGGERS and reading the firmware trace ...")
        print("(adaptive-trigger commands take the urgent path; use --command rumble "
              "to exercise the classified path that audio can drop.)")
        probe.engage_trigger(args.mode, args.target)
    time.sleep(0.05)
    events, supported = probe.read_trace_events()
    if not supported:
        print("\nThis firmware does not expose trigger traces (report 0x09).")
        print("Flash the diagnostics build (DS5-Bridge-Firmware-Traces-v*.uf2), then retry.")
        return
    if not events:
        print("\nNo trace events captured. Try again, or --command rumble.")
        return

    # Separate the audio spam from the controller-state packets we care about.
    audio = [e for e in events if e["report_id"] == AUDIO_REPORT_ID]
    state = [e for e in events if e["report_id"] != AUDIO_REPORT_ID]
    print(f"\n{len(events)} trace events: {len(audio)} audio (0x36), {len(state)} controller-state (non-audio).")

    if audio:
        span = audio[-1]["timestamp_ms"] - audio[0]["timestamp_ms"]
        rate = f"{span / max(1, len(audio) - 1):.1f} ms/pkt" if len(audio) > 1 else "n/a"
        print(f"  audio: {len(audio)} Bt packets over {span} ms ({rate}) -> audio IS streaming over Bluetooth.")

    if not state:
        print("\n  *** NO controller-state (trigger/rumble/lightbar) packets reached the Bluetooth link. ***")
        print("  With audio streaming, the firmware's audio-protection guard drops classified")
        print("  controller-state output before it is ever queued. That is the drop to fix.")
        print("  (Re-run this with audio stopped: you should then see 0x31 state packets appear.)")
        return

    print(f"\n  controller-state packets:")
    print(f"  {'stage':<10} {'t(ms)':>10} {'rpt':>5} {'motor':>6}  triggers(R|L first bytes)")
    stage_ts = {}
    for e in state:
        ts = e["timestamp_ms"]
        stage_ts.setdefault(e["stage"], ts)
        rt = " ".join(f"{b:02x}" for b in e["right_trigger"][:4])
        lt = " ".join(f"{b:02x}" for b in e["left_trigger"][:4])
        print(f"  {STAGE_NAMES.get(e['stage'], e['stage']):<10} {ts:>10} "
              f"0x{e['report_id']:02x} {e['motor_power']:>6}  {rt} | {lt}")
    if 2 in stage_ts and 3 in stage_ts:
        print(f"\n  BridgeIn -> BridgeOut (firmware queue latency): {stage_ts[3] - stage_ts[2]} ms")
    if 3 in stage_ts and 4 in stage_ts:
        print(f"  BridgeOut -> Bt (Bluetooth transmit): {stage_ts[4] - stage_ts[3]} ms")


def interactive(probe):
    menu = (
        "\nDS5 Bridge trigger probe -- commands:\n"
        "  e            engage triggers (feedback/both)\n"
        "  e <mode> <target>   e.g. 'e weapon r2'  (modes: feedback weapon vibration; targets: both l2 r2)\n"
        "  r            fire classic rumble (classified path)\n"
        "  l [count]    latency test (send->ack)\n"
        "  t            trace timeline (needs traces firmware)\n"
        "  q            quit\n"
    )
    print(menu)
    probe.set_trigger_intensity(100)
    while True:
        try:
            line = input("probe> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        parts = line.split()
        cmd = parts[0].lower()
        if cmd in ("q", "quit", "exit"):
            return
        elif cmd == "e":
            mode = parts[1] if len(parts) > 1 and parts[1] in TRIGGER_MODES else "feedback"
            target = parts[2] if len(parts) > 2 and parts[2] in TRIGGER_TARGETS else "both"
            r, ms = probe.engage_trigger(mode, target)
            print(f"  engage {mode}/{target} -> {ack_str(r)} ({ms:.2f} ms)")
        elif cmd == "r":
            r, ms = probe.classic_rumble()
            print(f"  rumble -> {ack_str(r)} ({ms:.2f} ms)")
        elif cmd == "l":
            count = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 30
            ns = argparse.Namespace(count=count, gap=20, command="trigger",
                                    mode="feedback", target="both", intensity=100)
            cmd_latency(probe, ns)
        elif cmd == "t":
            ns = argparse.Namespace(command="rumble", mode="feedback",
                                    target="both", intensity=100)
            cmd_trace(probe, ns)
        else:
            print(menu)


def main():
    ap = argparse.ArgumentParser(description="DS5 Bridge trigger + latency probe")
    ap.add_argument("--helper", help="Full path to the AudioHelper binary")
    sub = ap.add_subparsers(dest="sub")

    def add_common(p):
        p.add_argument("--mode", choices=list(TRIGGER_MODES), default="feedback")
        p.add_argument("--target", choices=list(TRIGGER_TARGETS), default="both")
        p.add_argument("--intensity", type=int, default=100)

    pe = sub.add_parser("engage", help="Engage the adaptive triggers once")
    add_common(pe)

    pr = sub.add_parser("rumble", help="Fire classic rumble (classified output path)")
    add_common(pr)

    pl = sub.add_parser("latency", help="Time N commands (send->ack)")
    add_common(pl)
    pl.add_argument("--count", type=int, default=30)
    pl.add_argument("--gap", type=int, default=20, help="ms between sends")
    pl.add_argument("--command", choices=["trigger", "rumble"], default="trigger")

    pt = sub.add_parser("trace", help="Show the firmware trace timeline (traces firmware)")
    add_common(pt)
    pt.add_argument("--command", choices=["trigger", "rumble"], default="rumble")

    args = ap.parse_args()
    helper = find_helper(args.helper)
    transport = Transport(helper)
    transport.open()
    probe = Probe(transport)
    try:
        if args.sub == "engage":
            cmd_engage(probe, args)
        elif args.sub == "rumble":
            cmd_rumble(probe, args)
        elif args.sub == "latency":
            cmd_latency(probe, args)
        elif args.sub == "trace":
            cmd_trace(probe, args)
        else:
            interactive(probe)
    finally:
        transport.close()


if __name__ == "__main__":
    main()

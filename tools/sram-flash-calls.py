#!/usr/bin/env python3
"""List every direct call from SRAM-resident code into XIP flash.

Code that runs from SRAM still stalls on the XIP cache (and stops while flash is being
written) whenever it calls into flash. This disassembles the linked firmware, follows
every direct branch out of SRAM -- including the long-branch veneers the linker inserts
for SRAM->flash calls -- and reports each flash target with the SRAM functions that
reach it. Indirect calls (function pointers, vtables) are not visible here.

With --data, lists instead the read-only data objects in flash (tables, strings, vtables)
whose addresses SRAM code loads from its literal pools: whole-object relocation moves code,
not .rodata, so a table read per packet stays behind the XIP cache unless placed explicitly.

usage: tools/sram-flash-calls.py build/companion/ds5-bridge.elf [--data] [--objdump PATH]
"""
import argparse
import collections
import re
import shutil
import subprocess
import sys

SRAM = (0x20000000, 0x20082000)
FLASH = (0x10000000, 0x12000000)

FUNC_RE = re.compile(r"^([0-9a-f]{8}) <([^>]+)>:$")
# bl/blx/b/b.w/bne.w/cbz... <addr> <sym+off>
BRANCH_RE = re.compile(
    r"^\s*([0-9a-f]+):\s+(?:[0-9a-f]{4}\s+){1,2}\s*(b[a-z]*(?:\.w|\.n)?|cbn?z)\s+(?:[a-z0-9]+,\s*)?([0-9a-f]+)\s+<([^>]+)>"
)
LITERAL_RE = re.compile(r"^\s*[0-9a-f]+:\s+([0-9a-f]{8})\s+\.word\s+0x([0-9a-f]{8})")


def in_range(addr, span):
    return span[0] <= addr < span[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("elf")
    parser.add_argument("--data", action="store_true", help="list flash data referenced by SRAM code")
    parser.add_argument("--objdump", default=shutil.which("arm-none-eabi-objdump") or "arm-none-eabi-objdump")
    args = parser.parse_args()

    out = subprocess.run([args.objdump, "-d", args.elf], capture_output=True, text=True, check=True).stdout

    if args.data:
        return report_data(args, out)

    # Pass 1: function boundaries, and the flash target of each SRAM veneer.
    funcs = []
    veneer_target = {}
    current = None
    for line in out.splitlines():
        m = FUNC_RE.match(line)
        if m:
            current = (int(m.group(1), 16), m.group(2))
            funcs.append(current)
            continue
        if current and current[1].endswith("_veneer") and in_range(current[0], SRAM):
            lm = LITERAL_RE.match(line)
            if lm:
                target = int(lm.group(2), 16) & ~1
                if in_range(target, FLASH):
                    veneer_target[current[1]] = target

    names_by_addr = {addr: name for addr, name in funcs}

    # Pass 2: branches out of SRAM functions.
    callers = collections.defaultdict(set)
    current = None
    for line in out.splitlines():
        m = FUNC_RE.match(line)
        if m:
            current = (int(m.group(1), 16), m.group(2))
            continue
        if current is None or not in_range(current[0], SRAM) or current[1].endswith("_veneer"):
            continue
        bm = BRANCH_RE.match(line)
        if not bm:
            continue
        target = int(bm.group(3), 16)
        label = bm.group(4)
        base = label.split("+")[0]
        if in_range(target, FLASH):
            callers[base].add(current[1])
        elif base in veneer_target:
            flash_addr = veneer_target[base]
            callers[names_by_addr.get(flash_addr, base.removeprefix("__").removesuffix("_veneer"))].add(current[1])

    if not callers:
        print("No direct SRAM -> flash calls.")
        return 0
    print(f"{len(callers)} flash functions reached directly from SRAM code:\n")
    for target in sorted(callers, key=lambda t: (-len(callers[t]), t)):
        names = sorted(callers[target])
        shown = ", ".join(names[:6]) + (f", ... (+{len(names) - 6})" if len(names) > 6 else "")
        print(f"{target}\n    <- {shown}")
    return 0


def report_data(args, disassembly):
    """Flash data objects whose address appears in an SRAM function's literal pool."""
    nm = shutil.which("arm-none-eabi-nm") or "arm-none-eabi-nm"
    table = subprocess.run([nm, "-S", "--defined-only", args.elf], capture_output=True, text=True, check=True).stdout
    objects = []  # (start, end, name) of flash data symbols
    for line in table.splitlines():
        parts = line.split()
        if len(parts) == 4 and parts[2] in ("R", "r", "V", "v", "D", "d"):
            start = int(parts[0], 16)
            if in_range(start, FLASH):
                objects.append((start, start + int(parts[1], 16), parts[3]))
    objects.sort()
    starts = [o[0] for o in objects]

    import bisect

    def owner(addr):
        i = bisect.bisect_right(starts, addr) - 1
        if i >= 0 and objects[i][0] <= addr < objects[i][1]:
            return objects[i]
        return None

    users = collections.defaultdict(set)
    current = None
    for line in disassembly.splitlines():
        m = FUNC_RE.match(line)
        if m:
            current = (int(m.group(1), 16), m.group(2))
            continue
        if current is None or not in_range(current[0], SRAM) or current[1].endswith("_veneer"):
            continue
        lm = LITERAL_RE.match(line)
        if not lm:
            continue
        found = owner(int(lm.group(2), 16))
        if found:
            users[found].add(current[1])

    if not users:
        print("No flash data referenced from SRAM code.")
        return 0
    print(f"{len(users)} flash data objects referenced from SRAM code (largest first):\n")
    for obj in sorted(users, key=lambda o: -(o[1] - o[0])):
        names = sorted(users[obj])
        shown = ", ".join(names[:5]) + (f", ... (+{len(names) - 5})" if len(names) > 5 else "")
        print(f"{obj[1] - obj[0]:6d} B  {obj[2]}\n    <- {shown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// RP2040 bootloader volumes are labeled RPI-RP2, RP2350 bootloader volumes RP2350.
const PICO_BOOTLOADER_VOLUME_LABEL_PATTERN = /^(RPI-RP2|RP2350)$/i;
const MOUNT_ATTEMPT_COOLDOWN_MS = 2000;
const LSBLK_TIMEOUT_MS = 5000;
const UDISKS_MOUNT_TIMEOUT_MS = 10000;

let lastMountAttemptAt = 0;

function defaultMediaBaseDirs(): string[] {
  const username = os.userInfo().username;
  return [`/run/media/${username}`, `/media/${username}`, '/media'];
}

// Every directory under the usual automount bases is a candidate drive root;
// the caller decides whether it holds a UF2 bootloader by reading INFO_UF2.TXT.
export function linuxRemovableMediaRoots(baseDirs = defaultMediaBaseDirs()): string[] {
  const roots: string[] = [];
  for (const base of baseDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        roots.push(path.join(base, entry.name));
      }
    }
  }
  return roots;
}

interface LsblkDevice {
  name?: string;
  label?: string;
  fstype?: string;
  mountpoint?: string | null;
  children?: LsblkDevice[];
}

async function findUnmountedPicoBlockDevice(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'lsblk',
      ['-J', '-o', 'NAME,LABEL,FSTYPE,MOUNTPOINT'],
      { timeout: LSBLK_TIMEOUT_MS }
    );
    const parsed = JSON.parse(stdout) as { blockdevices?: LsblkDevice[] };
    const queue = [...(parsed.blockdevices ?? [])];
    while (queue.length > 0) {
      const device = queue.shift();
      if (!device) {
        continue;
      }
      if (device.children) {
        queue.push(...device.children);
      }
      if (!device.label || !PICO_BOOTLOADER_VOLUME_LABEL_PATTERN.test(device.label)) {
        continue;
      }
      if (device.mountpoint) {
        continue;
      }
      if (device.fstype && device.fstype !== 'vfat') {
        continue;
      }
      if (device.name) {
        return device.name;
      }
    }
  } catch {
    // lsblk missing or unparseable output; the plain mount-root scan still applies.
  }
  return null;
}

// Sessions without an automounter (for example a gamescope Steam session) never
// mount the UF2 drive on their own. udisks2 lets the active seat user mount
// removable media without elevation, so ask it directly.
export async function tryMountPicoBootloaderBlockDevice(): Promise<string | null> {
  if (process.platform !== 'linux') {
    return null;
  }
  const now = Date.now();
  if (now - lastMountAttemptAt < MOUNT_ATTEMPT_COOLDOWN_MS) {
    return null;
  }
  lastMountAttemptAt = now;

  const deviceName = await findUnmountedPicoBlockDevice();
  if (!deviceName) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(
      'udisksctl',
      ['mount', '-b', `/dev/${deviceName}`, '--no-user-interaction'],
      { timeout: UDISKS_MOUNT_TIMEOUT_MS }
    );
    // "Mounted /dev/sda1 at /run/media/user/RP2350." (trailing period on older udisks2)
    const match = stdout.match(/ at (\S+?)\.?\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

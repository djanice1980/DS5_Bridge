import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTOSTART_DESKTOP_FILE = 'ds5-bridge.desktop';

export interface LinuxAutostartOptions {
  execPath: string;
  args: string[];
  configHome?: string;
  appImagePath?: string;
}

function xdgConfigHome(override?: string): string {
  if (override) {
    return override;
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

// Desktop Entry Exec quoting: wrap in double quotes and escape the reserved
// characters (backslash first), per the freedesktop.org spec.
function quoteExecArgument(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  return `"${escaped}"`;
}

export function linuxAutostartDesktopPath(configHome?: string): string {
  return path.join(xdgConfigHome(configHome), 'autostart', AUTOSTART_DESKTOP_FILE);
}

export function buildAutostartDesktopEntry(options: LinuxAutostartOptions): string {
  // An AppImage must relaunch itself through the .AppImage file, not the
  // extracted inner binary that execPath points at while running.
  const target = options.appImagePath ?? process.env.APPIMAGE ?? options.execPath;
  const execLine = [target, ...options.args].map(quoteExecArgument).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=DS5 Bridge',
    'Comment=DS5 Bridge companion',
    `Exec=${execLine}`,
    'Icon=ds5-bridge',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

export function applyLinuxLaunchAtStartup(enabled: boolean, options: LinuxAutostartOptions): void {
  const desktopPath = linuxAutostartDesktopPath(options.configHome);
  if (!enabled) {
    fs.rmSync(desktopPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(desktopPath, buildAutostartDesktopEntry(options), 'utf8');
}

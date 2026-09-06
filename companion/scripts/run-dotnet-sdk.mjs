// Runs `dotnet <args>` with the first SDK-capable dotnet found: DOTNET_ROOT first, then a
// per-user install under %LOCALAPPDATA%\dotnet (what dotnet-install.ps1 -InstallDir writes
// without admin rights), then whatever is on PATH. A machine-wide runtime-only
// C:\Program Files\dotnet shadows a user SDK on PATH, which is why PATH is tried last.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const executableName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
const roots = [process.env.DOTNET_ROOT, process.env.DOTNET_ROOT_X64];
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  roots.push(path.join(process.env.LOCALAPPDATA, 'dotnet'));
}

const candidates = roots
  .filter((root) => typeof root === 'string' && root.trim().length > 0)
  .map((root) => path.join(root, executableName))
  .filter((candidate) => existsSync(candidate));
candidates.push('dotnet');

let selected = null;
for (const candidate of new Set(candidates)) {
  const probe = spawnSync(candidate, ['--list-sdks'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0 && probe.stdout.trim().length > 0) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  console.error(
    'No .NET SDK found. Install the .NET 9 SDK, or set DOTNET_ROOT to a directory that contains an SDK-enabled dotnet executable.'
  );
  process.exit(1);
}

const result = spawnSync(selected, process.argv.slice(2), { stdio: 'inherit', windowsHide: true });
if (result.error) {
  console.error(`Unable to launch ${selected}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

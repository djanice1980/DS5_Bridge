#!/usr/bin/env node
// The firmware version must agree everywhere it appears. It is defined ONCE, as the three
// DS5_BRIDGE_VERSION_* set() lines in CMakeLists.txt; the program-info string and the STATUS
// report bytes in companion.cpp both derive from those at build time. The companion's
// BUNDLED_FIRMWARE_VERSION is the one copy that cannot derive (different build system), so it
// is checked here instead.
//
// History says this check earns its keep: 1.6.69 shipped while companion.cpp still carried a
// hardcoded kFirmwarePatch = 68 that no checker covered, so a freshly flashed bridge reported
// the previous version and made a successful flash look like a failed one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function extract(relativePath, pattern, label) {
  const match = read(relativePath).match(pattern);
  if (!match) {
    throw new Error(`Could not find ${label} in ${relativePath}`);
  }
  return match[1];
}

const cmake = 'CMakeLists.txt';
const major = extract(cmake, /set\(DS5_BRIDGE_VERSION_MAJOR\s+(\d+)\)/, 'DS5_BRIDGE_VERSION_MAJOR');
const minor = extract(cmake, /set\(DS5_BRIDGE_VERSION_MINOR\s+(\d+)\)/, 'DS5_BRIDGE_VERSION_MINOR');
const patch = extract(cmake, /set\(DS5_BRIDGE_VERSION_PATCH\s+(\d+)\)/, 'DS5_BRIDGE_VERSION_PATCH');
const cmakeVersion = `${major}.${minor}.${patch}`;

const bundled = extract(
  'companion/src/main/bridge-service.ts',
  /BUNDLED_FIRMWARE_VERSION\s*=\s*'([^']+)'/,
  'BUNDLED_FIRMWARE_VERSION'
);

console.log(`${cmakeVersion}  CMakeLists.txt (DS5_BRIDGE_VERSION_*)`);
console.log(`${bundled}  companion/src/main/bridge-service.ts (BUNDLED_FIRMWARE_VERSION)`);

let failed = false;
if (cmakeVersion !== bundled) {
  console.error(`\nFAIL: CMake says ${cmakeVersion} but the companion bundles ${bundled}`);
  failed = true;
}

// companion.cpp must DERIVE its version bytes, never carry them. A literal here is exactly the
// 1.6.69 bug growing back.
const companionCpp = read('src/companion.cpp');
for (const name of ['kFirmwareMajor', 'kFirmwareMinor', 'kFirmwarePatch']) {
  const literal = companionCpp.match(new RegExp(`${name}\\s*=\\s*(\\d+)\\s*;`));
  if (literal) {
    console.error(`\nFAIL: ${name} is hardcoded to ${literal[1]} in src/companion.cpp; it must use the DS5_BRIDGE_VERSION_* defines`);
    failed = true;
  }
  if (!new RegExp(`${name}\\s*=\\s*DS5_BRIDGE_VERSION_(MAJOR|MINOR|PATCH)`).test(companionCpp)) {
    console.error(`\nFAIL: ${name} in src/companion.cpp does not derive from the DS5_BRIDGE_VERSION_* defines`);
    failed = true;
  }
}

// Nothing should reintroduce a literal version into pico_set_program_version either.
if (!/pico_set_program_version\(ds5-bridge\s+"\$\{DS5_BRIDGE_VERSION\}"\)/.test(read(cmake))) {
  console.error('\nFAIL: pico_set_program_version must use ${DS5_BRIDGE_VERSION}, not a literal');
  failed = true;
}

// The release workflow reads the version too. It broke silently for three releases when the
// kFirmware* constants it grepped from companion.cpp were removed by the single-sourcing this
// checker enforces -- so the checker now also proves the workflow reads the surviving source.
const releaseWorkflow = read('.github/workflows/release.yml');
if (/kFirmware(Major|Minor|Patch)/.test(releaseWorkflow)) {
  console.error('\nFAIL: .github/workflows/release.yml still greps kFirmware* from companion.cpp; those constants no longer exist');
  failed = true;
}
if (!/DS5_BRIDGE_VERSION_MAJOR/.test(releaseWorkflow)) {
  console.error('\nFAIL: .github/workflows/release.yml must read the firmware version from CMakeLists.txt (DS5_BRIDGE_VERSION_*)');
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log(`\nPASS firmware version is ${cmakeVersion} everywhere, with no stray literals`);

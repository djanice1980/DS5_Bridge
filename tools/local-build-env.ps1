<#
.SYNOPSIS
    Put the local firmware/companion build toolchain on PATH for the current shell.

.DESCRIPTION
    Dot-source this, do not run it -- it has to modify the CURRENT shell:

        . .\tools\local-build-env.ps1

    Everything it points at is installed per-user; nothing here needs admin.

    Provenance of each piece, and why the pinned versions matter:

    * Pico SDK, ARM toolchain, picotool, cmake, ninja come from the Raspberry Pi Pico
      VS Code extension, which installs them under ~/.pico-sdk in exactly the layout the
      top-level CMakeLists already expects (sdkVersion / toolchainVersion / picotoolVersion).
      Install with:
          winget install --id Microsoft.VisualStudioCode --scope user
          code --install-extension raspberry-pi.raspberry-pi-pico
      then open this repo in VS Code once so the extension fetches the toolchain.

    * TinyUSB MUST be 0.20.0. The extension ships SDK 2.2.0 with TinyUSB 0.18.0, but CI
      pins 0.20.0 (TINYUSB_REF in .github/workflows/build.yml) and the difference is not
      cosmetic -- 0.20.0 is where the tud_deinit behaviour this firmware depends on lives.
      A local build against 0.18.0 is NOT the firmware being tested. This script checks it
      and tells you how to fix it rather than silently building the wrong thing.

    * g++ for the HOST tests (tests/firmware) comes from WinLibs, a portable zip install:
          winget install --id BrechtSanders.WinLibs.POSIX.UCRT --scope user
      The firmware source guards compile for the PC, not for ARM, so the ARM toolchain
      cannot run them.

    * DOTNET_ROLL_FORWARD=Major lets the net9.0 AudioHelper tests run on a newer installed
      .NET runtime, so no separate .NET 9 runtime install (which needs elevation) is needed.

    * ENABLE_COMPANION defaults to OFF in CMakeLists, and CI always passes ON. A build
      directory configured WITHOUT it -- which is what the VS Code extension creates, since it
      configures with defaults -- compiles out companion_init() and
      usb_attach_companion_only_idle() entirely. That firmware boots and runs, but with no
      controller attached it presents NO USB device at all: the app reports "no bridge
      detected", the bridge looks dead, and nothing in the build output says why. This script
      checks every build directory for it, because the failure is silent and looks like
      broken hardware.

.EXAMPLE
    . .\tools\local-build-env.ps1
    cmake -S . -B build/local -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_COMPANION=ON
    cmake --build build/local --target ds5-bridge
    # -> build/local/ds5-bridge.uf2

.EXAMPLE
    . .\tools\local-build-env.ps1
    cd companion
    npm test              # vitest + installer + native + firmware source guards
    npm run package:win   # full app, with a freshly built flash nuke
#>

$picoSdkRoot = Join-Path $env:USERPROFILE '.pico-sdk'
$sdkVersion = '2.2.0'
$toolchainVersion = '14_2_Rel1'
$picotoolVersion = '2.2.0-a4'
$requiredTinyUsb = '0.20.0'

if (-not (Test-Path $picoSdkRoot)) {
    Write-Warning "No $picoSdkRoot. Install VS Code + the raspberry-pi.raspberry-pi-pico extension and open this repo once (see the notes at the top of this script)."
    return
}

# Newest installed cmake/ninja under ~/.pico-sdk, so a toolchain refresh does not strand this.
function Get-NewestChild {
    param([string] $Path)
    if (-not (Test-Path $Path)) { return $null }
    Get-ChildItem $Path -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}

$parts = @(
    Get-NewestChild (Join-Path $picoSdkRoot 'cmake') | ForEach-Object { Join-Path $_ 'bin' }
    Get-NewestChild (Join-Path $picoSdkRoot 'ninja')
    Join-Path $picoSdkRoot "toolchain\$toolchainVersion\bin"
    Join-Path $picoSdkRoot "picotool\$picotoolVersion\picotool"
) | Where-Object { $_ -and (Test-Path $_) }

# WinLibs g++ for the host-side firmware tests. Optional: firmware and app builds do not
# need it, only tests/firmware does.
$winLibs = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') `
    -Directory -Filter '*WinLibs*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'mingw64\bin' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if ($winLibs) {
    # AFTER the Pico entries: WinLibs also ships cmake and ninja, and the pinned Pico ones win.
    $parts += $winLibs
} else {
    Write-Warning "WinLibs g++ not found -- 'npm run test:firmware' will fail. Install with: winget install --id BrechtSanders.WinLibs.POSIX.UCRT --scope user"
}

$env:PATH = ($parts -join ';') + ';' + $env:PATH
# The flash-nuke build needs this explicitly; the main CMakeLists resolves it via the
# extension's pico-vscode.cmake shim.
$env:PICO_SDK_PATH = Join-Path $picoSdkRoot "sdk\$sdkVersion"
$env:DOTNET_ROLL_FORWARD = 'Major'

# Any build directory configured with ENABLE_COMPANION=OFF produces firmware that silently
# never enumerates when no controller is attached. Nothing in the build output hints at it, so
# check the configured caches and say so loudly.
$repoRoot = Split-Path $PSScriptRoot -Parent
$companionOffDirs = Get-ChildItem $repoRoot -Directory -Filter 'build*' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem $_.FullName -Recurse -Depth 1 -Filter 'CMakeCache.txt' -ErrorAction SilentlyContinue } |
    Where-Object {
        $cache = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
        # Only firmware build dirs define this option at all; the host-test dirs do not.
        $cache -match 'ENABLE_COMPANION:BOOL=OFF'
    } |
    ForEach-Object { Split-Path $_.FullName -Parent }

if ($companionOffDirs) {
    Write-Warning "These build directories have ENABLE_COMPANION=OFF. Firmware built there has NO companion interface and will NOT enumerate over USB unless a controller is already connected:"
    foreach ($dir in $companionOffDirs) { Write-Warning "  $dir" }
    Write-Warning "Reconfigure (or build in a fresh directory) with the flags CI uses:"
    Write-Warning "  cmake -S . -B build/companion -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_COMPANION=ON"
}

$tinyUsb = Join-Path $env:PICO_SDK_PATH 'lib\tinyusb'
$tinyUsbVersion = (& git -C $tinyUsb describe --tags 2>$null)
if ($tinyUsbVersion -ne $requiredTinyUsb) {
    Write-Warning "TinyUSB is '$tinyUsbVersion', CI pins $requiredTinyUsb. Builds will NOT match the firmware under test. Fix with:"
    Write-Warning "  git -C `"$tinyUsb`" fetch --depth 1 origin refs/tags/${requiredTinyUsb}:refs/tags/$requiredTinyUsb"
    Write-Warning "  git -C `"$tinyUsb`" checkout --detach $requiredTinyUsb"
} else {
    Write-Host "Local build environment ready (SDK $sdkVersion, TinyUSB $tinyUsbVersion, toolchain $toolchainVersion)." -ForegroundColor Green
}

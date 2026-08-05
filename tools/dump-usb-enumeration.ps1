<#
.SYNOPSIS
    Dump what Windows actually enumerated for the DS5 Bridge, including the MS OS descriptor
    cache that decides whether WinUSB binds.

.DESCRIPTION
    Uses only built-in PowerShell -- no SDK, no usbview, nothing to install.

    The usbflags section records the MS OS 1.0 string-descriptor probe, NOT MS OS 2.0.
    Windows probes once per VID/PID/REV and caches the answer under
    HKLM\SYSTEM\CurrentControlSet\Control\usbflags\<VID><PID><REV> as a value named 'osvc';
    00 00 means "does not support MS OS 1.0 descriptors" and it will not ask again.

    This firmware uses MS OS 2.0, which is fetched via BOS instead, so an ABSENT or 00 00
    osvc entry is normal here and does not by itself explain a missing WinUSB binding. Read
    the ProblemCode in the first section for that. -ClearOsDescriptorCache is kept because
    clearing the entry also forces a fresh device install, which is occasionally useful.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\dump-usb-enumeration.ps1

.EXAMPLE
    # Also clear a poisoned MS OS cache entry (needs an elevated prompt).
    powershell -ExecutionPolicy Bypass -File tools\dump-usb-enumeration.ps1 -ClearOsDescriptorCache
#>

[CmdletBinding()]
param(
    # Product ids to inspect. Defaults to the bridge's three identities.
    [string[]] $ProductId = @('0CE6', '0CE7', '0DF2'),
    [string]   $VendorId  = '054C',
    # Delete the cached MS OS descriptor verdict so Windows re-queries on next plug-in.
    [switch]   $ClearOsDescriptorCache
)

$ErrorActionPreference = 'Stop'

function Write-Section([string] $Title) {
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

Write-Section 'Present USB devices'
$found = $false
foreach ($pidValue in $ProductId) {
    $pattern = "USB\VID_$VendorId&PID_$pidValue*"
    $devices = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -like $pattern }

    if (-not $devices) {
        Write-Host ("PID {0}: not present" -f $pidValue) -ForegroundColor DarkGray
        continue
    }

    $found = $true
    foreach ($device in $devices) {
        Write-Host ("PID {0}: {1}" -f $pidValue, $device.FriendlyName) -ForegroundColor Green
        Write-Host ("  Status      : {0}" -f $device.Status)
        Write-Host ("  Class       : {0}" -f $device.Class)
        Write-Host ("  InstanceId  : {0}" -f $device.InstanceId)

        # The bound driver is the whole question: WinUSB or nothing.
        foreach ($name in 'DEVPKEY_Device_Service', 'DEVPKEY_Device_DriverDesc', 'DEVPKEY_Device_ProblemCode') {
            $value = Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName $name -ErrorAction SilentlyContinue
            if ($value -and $null -ne $value.Data -and "$($value.Data)" -ne '') {
                Write-Host ("  {0,-12}: {1}" -f $name.Replace('DEVPKEY_Device_', ''), $value.Data)
            }
        }
    }
}

if (-not $found) {
    Write-Host 'No bridge device is present. Plug it in, or the firmware is not attaching at all.' -ForegroundColor Yellow
}

Write-Section 'MS OS 1.0 descriptor cache (usbflags)'
Write-Host 'This is the MS OS 1.0 probe only. This firmware uses MS OS 2.0 (fetched via BOS),'
Write-Host 'so absent or 00 00 here is EXPECTED and is not the reason WinUSB failed to bind.'
Write-Host ''

$usbflags = 'HKLM:\SYSTEM\CurrentControlSet\Control\usbflags'
$entries = Get-ChildItem $usbflags -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -like "$VendorId*" }

if (-not $entries) {
    Write-Host 'No usbflags entries for this vendor id yet.' -ForegroundColor DarkGray
}

foreach ($entry in $entries) {
    $key = $entry.PSChildName          # VVVVPPPPRRRR
    $entryPid = $key.Substring(4, 4)
    if ($ProductId -notcontains $entryPid) { continue }

    $osvc = (Get-ItemProperty $entry.PSPath -Name 'osvc' -ErrorAction SilentlyContinue).osvc
    $text = if ($null -eq $osvc) { '(absent -- will be queried on next plug-in)' }
            else { ($osvc | ForEach-Object { '{0:X2}' -f $_ }) -join ' ' }

    Write-Host ("{0}  osvc = {1}" -f $key, $text) -ForegroundColor DarkGray

    if ($ClearOsDescriptorCache) {
        try {
            Remove-Item $entry.PSPath -Recurse -Force
            Write-Host ("   deleted {0} -- unplug and replug the bridge" -f $key) -ForegroundColor Yellow
        } catch {
            Write-Host ("   could not delete {0}: {1}" -f $key, $_.Exception.Message) -ForegroundColor Red
            Write-Host '   Run this script from an ELEVATED PowerShell prompt.' -ForegroundColor Yellow
        }
    }
}

Write-Section 'Companion WinUSB interface'
# The GUID the firmware advertises in its MS OS 2.0 registry property. If the device is
# present but this is missing, the descriptor was served but WinUSB still did not bind.
$guid = '{e4c8b2a9-87f5-4c4c-9e52-2b4c1b8b4f62}'
$interfaces = Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\$guid" -ErrorAction SilentlyContinue
if ($interfaces) {
    foreach ($item in $interfaces) {
        Write-Host ("  {0}" -f $item.PSChildName) -ForegroundColor Green
    }
} else {
    Write-Host '  No device interfaces registered for the companion GUID.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. Re-run after each plug-in to see what changed.' -ForegroundColor Cyan

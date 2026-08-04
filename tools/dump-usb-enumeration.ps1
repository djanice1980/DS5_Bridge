<#
.SYNOPSIS
    Dump what Windows actually enumerated for the DS5 Bridge, including the MS OS descriptor
    cache that decides whether WinUSB binds.

.DESCRIPTION
    Uses only built-in PowerShell -- no SDK, no usbview, nothing to install.

    The interesting part is usbflags. Windows queries a device's MS OS descriptors ONCE per
    VID/PID/REV and caches the answer under
    HKLM\SYSTEM\CurrentControlSet\Control\usbflags\<VID><PID><REV> as a value named 'osvc'.
    If the first enumeration failed to produce a usable descriptor, osvc is cached as
    00 00 ("does not support MS OS descriptors") and Windows NEVER ASKS AGAIN -- so a later,
    fixed firmware still will not get a WinUSB binding until that cache entry is removed.

    That matters here: the companion-only device (PID 0x0CE7) first enumerated with a broken
    MS OS 2.0 descriptor, so its cache entry is very likely poisoned.

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

Write-Section 'MS OS descriptor cache (usbflags)'
Write-Host 'osvc = 01 00 -> Windows queried and the device answered (WinUSB can bind).'
Write-Host 'osvc = 00 00 -> cached as "no MS OS support"; Windows will NOT ask again.'
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

    $poisoned = ($null -ne $osvc) -and ($osvc.Length -ge 1) -and ($osvc[0] -eq 0)
    $colour = if ($poisoned) { 'Red' } else { 'Green' }
    Write-Host ("{0}  osvc = {1}" -f $key, $text) -ForegroundColor $colour
    if ($poisoned) {
        Write-Host '   ^ POISONED: Windows cached "no MS OS descriptors" for this VID/PID/REV.' -ForegroundColor Red
        Write-Host '     WinUSB will not bind until this entry is deleted, however correct the firmware is.' -ForegroundColor Red
    }

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

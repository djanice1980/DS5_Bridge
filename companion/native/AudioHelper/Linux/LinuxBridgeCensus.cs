using System.Text.Json;

// Linux implementation of --list-bridges, the device census behind the companion's DEVICES
// list and the tester's active-bridge dropdown.
//
// BridgeCensus.cs (the Windows twin) is built on device-interface GUIDs and container ids,
// neither of which exists here, so this was simply missing: the Linux helper fell through to
// an unrelated message, the companion's JSON.parse threw, and bridgeCensus stayed null. The
// visible result was "no bridge detected" even with a healthy, connected transport.
//
// Shapes must match the BridgeCensus interface in src/main/audio-helper.ts.
static class LinuxBridgeCensus
{
    private const ushort SonyVendorId = 0x054C;

    internal readonly record struct HidDeviceInfo(
        string Path,
        ushort VendorId,
        ushort ProductId,
        string? Product,
        string? ContainerId);

    internal sealed record BridgeEntry(string Path, string? ContainerId);

    internal sealed record HidEntry(
        string Path,
        int ProductId,
        string? Product,
        string? ContainerId,
        bool IsBridge);

    internal sealed record Census(IReadOnlyList<BridgeEntry> Bridges, IReadOnlyList<HidEntry> HidDevices);

    public static int Run()
    {
        var census = Build(LinuxUsbBridgeTransport.Enumerate(), ReadHidDevices());
        Console.Out.Write(ToJson(census));
        Console.Out.Flush();
        return 0;
    }

    internal static Census Build(
        IReadOnlyList<LinuxUsbBridgeTransport.BridgeDeviceInfo> usbDevices,
        IReadOnlyList<HidDeviceInfo> hidDevices)
    {
        // Only devices carrying the vendor-class interface are bridges. A DualSense plugged
        // straight into the PC shares the 0ce6 product id and would otherwise be offered as a
        // bridge the app could never talk to.
        var bridges = usbDevices
            .Where(device => device.HasVendorInterface)
            .Select(device => new BridgeEntry(device.Path, device.Path))
            .GroupBy(entry => entry.Path)
            .Select(group => group.First())
            .ToList();

        var bridgePorts = bridges.Select(bridge => bridge.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var hid = hidDevices
            .Select(device => new HidEntry(
                device.Path,
                device.ProductId,
                device.Product,
                device.ContainerId,
                device.ContainerId is not null && bridgePorts.Contains(device.ContainerId)))
            .ToList();

        return new Census(bridges, hid);
    }

    internal static string ToJson(Census census) => JsonSerializer.Serialize(new
    {
        bridges = census.Bridges.Select(bridge => new
        {
            path = bridge.Path,
            containerId = bridge.ContainerId
        }),
        hidDevices = census.HidDevices.Select(device => new
        {
            path = device.Path,
            productId = device.ProductId,
            product = device.Product,
            containerId = device.ContainerId,
            isBridge = device.IsBridge
        })
    });

    // Walk /sys/class/hidraw. Each node's uevent carries HID_ID=bus:vendor:product and
    // HID_NAME; the USB port path comes from the sysfs link, so a hidraw node can be tied back
    // to the same dongle the USB census saw.
    private static List<HidDeviceInfo> ReadHidDevices()
    {
        var devices = new List<HidDeviceInfo>();
        const string hidrawRoot = "/sys/class/hidraw";
        if (!Directory.Exists(hidrawRoot))
        {
            return devices;
        }

        foreach (var entry in Directory.EnumerateDirectories(hidrawRoot))
        {
            try
            {
                var ueventPath = Path.Combine(entry, "device", "uevent");
                if (!File.Exists(ueventPath))
                {
                    continue;
                }

                ushort vendor = 0;
                ushort product = 0;
                string? name = null;
                foreach (var line in File.ReadAllLines(ueventPath))
                {
                    if (line.StartsWith("HID_ID=", StringComparison.Ordinal))
                    {
                        // HID_ID=0003:0000054C:00000CE6
                        var parts = line[7..].Split(':');
                        if (parts.Length == 3
                            && uint.TryParse(parts[1], System.Globalization.NumberStyles.HexNumber, null, out var vendorId)
                            && uint.TryParse(parts[2], System.Globalization.NumberStyles.HexNumber, null, out var productId))
                        {
                            vendor = (ushort)vendorId;
                            product = (ushort)productId;
                        }
                    }
                    else if (line.StartsWith("HID_NAME=", StringComparison.Ordinal))
                    {
                        name = line[9..].Trim();
                    }
                }

                if (vendor != SonyVendorId)
                {
                    continue;
                }

                devices.Add(new HidDeviceInfo(
                    $"/dev/{Path.GetFileName(entry)}",
                    vendor,
                    product,
                    name,
                    ResolvePortPath(entry)));
            }
            catch
            {
                // A device can disappear mid-walk; skip it rather than failing the census.
            }
        }

        return devices;
    }

    // /sys/class/hidraw/hidrawN is a symlink into /sys/devices/...; the USB port path only
    // appears once it is fully resolved, so the link has to be followed to its final target
    // rather than merely normalised.
    internal static string? ResolvePortPath(string hidrawSysfsPath)
    {
        try
        {
            var resolved = Directory.ResolveLinkTarget(hidrawSysfsPath, returnFinalTarget: true)?.FullName
                ?? Path.GetFullPath(hidrawSysfsPath);
            return PortPathFromSysfsPath(resolved);
        }
        catch
        {
            // An unresolvable path just means this node is not grouped with a bridge.
            return null;
        }
    }

    // Turn a resolved sysfs path into the same "usb:5-1.3" form LinuxUsbBridgeTransport
    // reports, so census entries and the active transport path compare equal.
    // e.g. /sys/devices/.../usb5/5-1/5-1.3/5-1.3:1.3/0003:054C:0CE6.0018/hidraw/hidraw15
    internal static string? PortPathFromSysfsPath(string sysfsPath)
    {
        if (string.IsNullOrEmpty(sysfsPath))
        {
            return null;
        }

        // Walk outwards from the leaf: the nearest USB interface/device segment wins.
        foreach (var segment in sysfsPath.Split('/').Reverse())
        {
            // "5-1.3:1.3" is an interface, "5-1.3" the device; both carry the port path.
            var portPart = segment.Split(':')[0];
            var dash = portPart.IndexOf('-');
            if (dash <= 0 || dash == portPart.Length - 1)
            {
                continue;
            }
            if (!int.TryParse(portPart[..dash], out var bus))
            {
                continue;
            }
            var ports = portPart[(dash + 1)..];
            if (ports.Length > 0 && ports.All(character => char.IsDigit(character) || character == '.')
                && !ports.StartsWith('.') && !ports.EndsWith('.'))
            {
                return $"usb:{bus}-{ports}";
            }
        }
        return null;
    }
}

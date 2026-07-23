using System.Text.Json;
using HidSharp;

// --list-bridges: JSON census of every present DS5 Bridge (companion WinUSB
// interface path + physical container ID) and every DualSense-family HID
// device, tagged with whether it belongs to a bridge (container match) or is a
// directly-attached controller. Consumed by the companion app's multi-bridge
// device selector.
static class BridgeCensus
{
    private const int SonyVendorId = 0x054C;

    private static readonly int[] KnownProductIds =
    [
        0x0CE6, // DualSense
        0x0DF2, // DualSense Edge
        0x05C4, // DualShock 4 v1
        0x09CC  // DualShock 4 v2
    ];

    public static void PrintJson()
    {
        var bridges = BridgeDeviceIdentity.ListBridges();
        var bridgeContainers = bridges
            .Select(bridge => bridge.ContainerId)
            .Where(container => container != Guid.Empty)
            .ToHashSet();

        var hidDevices = new List<object>();
        foreach (var device in DeviceList.Local.GetHidDevices(SonyVendorId))
        {
            if (!KnownProductIds.Contains(device.ProductID))
            {
                continue;
            }
            Guid container = Guid.Empty;
            try
            {
                BridgeDeviceIdentity.TryGetContainerIdForInterfacePath(device.DevicePath, out container);
            }
            catch
            {
                // Census stays best-effort per device.
            }
            string? product = null;
            try
            {
                product = device.GetProductName();
            }
            catch
            {
            }
            hidDevices.Add(new
            {
                path = device.DevicePath,
                productId = device.ProductID,
                product,
                containerId = container == Guid.Empty ? null : container.ToString(),
                isBridge = container != Guid.Empty && bridgeContainers.Contains(container)
            });
        }

        var payload = new
        {
            bridges = bridges.Select(bridge => new
            {
                path = bridge.DevicePath,
                containerId = bridge.ContainerId == Guid.Empty ? null : bridge.ContainerId.ToString()
            }),
            hidDevices
        };
        Console.WriteLine(JsonSerializer.Serialize(payload));
    }
}

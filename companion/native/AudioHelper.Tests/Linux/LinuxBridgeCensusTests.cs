using Xunit;

// The census feeds the companion's DEVICES list and the tester's active-bridge dropdown.
// It was never implemented on Linux: --list-bridges fell through to an unrelated error string,
// listBridges() failed to parse it, bridgeCensus stayed null, and the dropdown rendered "no
// bridge detected" even while the transport was connected and working.
public class LinuxBridgeCensusTests
{
    private const ushort Sony = 0x054C;

    private static LinuxUsbBridgeTransport.BridgeDeviceInfo Bridge(
        string path,
        ushort product,
        bool hasVendorInterface = true) =>
        new(path, Sony, product, 5, 12, hasVendorInterface);

    [Fact]
    public void ListsAnIdleBridge()
    {
        var census = LinuxBridgeCensus.Build(
            new[] { Bridge("usb:5-1.3", 0x0CE7) },
            Array.Empty<LinuxBridgeCensus.HidDeviceInfo>());

        var only = Assert.Single(census.Bridges);
        Assert.Equal("usb:5-1.3", only.Path);
        Assert.Equal("usb:5-1.3", only.ContainerId);
    }

    [Fact]
    public void GroupsBothEnumerationsOfOneDongleUnderOneContainer()
    {
        // The same physical dongle across a controller power cycle: idle, then full. The port
        // path is what makes these the same device to the app.
        var idle = LinuxBridgeCensus.Build(new[] { Bridge("usb:5-1.3", 0x0CE7) }, Array.Empty<LinuxBridgeCensus.HidDeviceInfo>());
        var full = LinuxBridgeCensus.Build(new[] { Bridge("usb:5-1.3", 0x0CE6) }, Array.Empty<LinuxBridgeCensus.HidDeviceInfo>());

        Assert.Equal(idle.Bridges[0].ContainerId, full.Bridges[0].ContainerId);
        Assert.Equal(idle.Bridges[0].Path, full.Bridges[0].Path);
    }

    [Fact]
    public void DoesNotListADualSensePluggedStraightIntoThePc()
    {
        // Same 0ce6 product id as a bridge, but no vendor-class interface.
        var census = LinuxBridgeCensus.Build(
            new[] { Bridge("usb:5-2", 0x0CE6, hasVendorInterface: false) },
            Array.Empty<LinuxBridgeCensus.HidDeviceInfo>());

        Assert.Empty(census.Bridges);
    }

    [Fact]
    public void MarksHidDevicesOnABridgePortAsBridges()
    {
        var census = LinuxBridgeCensus.Build(
            new[] { Bridge("usb:5-1.3", 0x0CE6) },
            new[]
            {
                new LinuxBridgeCensus.HidDeviceInfo("/dev/hidraw15", Sony, 0x0CE6, "DualSense Wireless Controller", "usb:5-1.3"),
                new LinuxBridgeCensus.HidDeviceInfo("/dev/hidraw9", Sony, 0x0CE6, "DualSense Wireless Controller", "usb:5-2")
            });

        var bridgeHid = Assert.Single(census.HidDevices, device => device.IsBridge);
        Assert.Equal("/dev/hidraw15", bridgeHid.Path);

        // The one on a different port is a directly-connected controller, and the app lists it
        // separately so tests and audio never target the wrong device.
        var direct = Assert.Single(census.HidDevices, device => !device.IsBridge);
        Assert.Equal("/dev/hidraw9", direct.Path);
    }

    [Fact]
    public void SerialisesTheContractTheCompanionParses()
    {
        var json = LinuxBridgeCensus.ToJson(LinuxBridgeCensus.Build(
            new[] { Bridge("usb:5-1.3", 0x0CE7) },
            new[] { new LinuxBridgeCensus.HidDeviceInfo("/dev/hidraw15", Sony, 0x0CE6, "DualSense Wireless Controller", "usb:5-1.3") }));

        // Property names must match the BridgeCensus interface in audio-helper.ts exactly.
        Assert.Contains("\"bridges\"", json);
        Assert.Contains("\"hidDevices\"", json);
        Assert.Contains("\"containerId\"", json);
        Assert.Contains("\"productId\"", json);
        Assert.Contains("\"isBridge\"", json);
        Assert.Contains("\"path\"", json);
        // Must be parseable on its own: the companion runs JSON.parse over stdout.
        using var document = System.Text.Json.JsonDocument.Parse(json);
        Assert.Equal(1, document.RootElement.GetProperty("bridges").GetArrayLength());
    }

    [Theory]
    // The real sysfs layout for a bridge, taken from this machine's kernel log.
    [InlineData("/sys/devices/pci0000:00/0000:00:08.3/0000:26:00.3/usb5/5-1/5-1.3/5-1.3:1.3/0003:054C:0CE6.0018/hidraw/hidraw15", "usb:5-1.3")]
    // Directly on a root-hub port, no intermediate hub.
    [InlineData("/sys/devices/pci0000:00/usb1/1-2/1-2:1.0/0003:054C:0CE6.0001/hidraw/hidraw3", "usb:1-2")]
    // Deeper hub chain.
    [InlineData("/sys/devices/pci0000:00/usb5/5-1/5-1.4/5-1.4.2/5-1.4.2:1.3/hidraw/hidraw9", "usb:5-1.4.2")]
    public void DerivesThePortPathFromASysfsPath(string sysfs, string expected)
    {
        Assert.Equal(expected, LinuxBridgeCensus.PortPathFromSysfsPath(sysfs));
    }

    [Theory]
    [InlineData("")]
    [InlineData("/sys/devices/virtual/misc/uinput")]
    [InlineData("/sys/devices/pci0000:00/0000:00:08.3")]
    public void ReturnsNoPortPathForNonUsbPaths(string sysfs)
    {
        Assert.Null(LinuxBridgeCensus.PortPathFromSysfsPath(sysfs));
    }

    [Fact]
    public void PortPathMatchesTheFormatTheTransportReports()
    {
        // If these two ever diverge the census can never mark a bridge "connected", because
        // bridgeDevicesSnapshot() compares census paths against the live transport path.
        var fromSysfs = LinuxBridgeCensus.PortPathFromSysfsPath(
            "/sys/devices/pci0000:00/usb5/5-1/5-1.3/5-1.3:1.3/0003:054C:0CE6.0018/hidraw/hidraw15");
        Assert.StartsWith("usb:", fromSysfs);
        Assert.Matches(@"^usb:\d+-[\d.]+$", fromSysfs);
    }

    [Fact]
    public void ReportsAControllerWhoseHidTheKernelRejected()
    {
        // The charging case seen on real hardware: the controller is live on the bridge over
        // BT and plugged in over USB. The kernel rejects the USB twin as a duplicate MAC and
        // tears down its hidraw, so the device exists on the bus with no HID at all.
        var census = LinuxBridgeCensus.Build(
            new[]
            {
                Bridge("usb:5-1.3", 0x0CE6),                             // the bridge, full mode
                Bridge("usb:5-1.1.2", 0x0CE6, hasVendorInterface: false) // the real controller
            },
            new[]
            {
                // Only the bridge's gamepad interface survives as hidraw.
                new LinuxBridgeCensus.HidDeviceInfo("/dev/hidraw15", Sony, 0x0CE6, "DualSense Wireless Controller", "usb:5-1.3")
            });

        var charging = Assert.Single(census.HidDevices, device => device.HidUnavailable);
        Assert.Equal("usb:5-1.1.2", charging.Path);
        Assert.False(charging.IsBridge);
    }

    [Fact]
    public void DoesNotDuplicateAControllerThatHasAWorkingHidNode()
    {
        // Controller off, then plugged in: no bridge conflict, hidraw exists -- the USB-level
        // sighting must not produce a second entry for the same dongle.
        var census = LinuxBridgeCensus.Build(
            new[] { Bridge("usb:5-2", 0x0CE6, hasVendorInterface: false) },
            new[]
            {
                new LinuxBridgeCensus.HidDeviceInfo("/dev/hidraw9", Sony, 0x0CE6, "DualSense Wireless Controller", "usb:5-2")
            });

        var only = Assert.Single(census.HidDevices);
        Assert.Equal("/dev/hidraw9", only.Path);
        Assert.False(only.HidUnavailable);
    }

    [Fact]
    public void ProducesValidJsonWhenNothingIsPluggedIn()
    {
        var json = LinuxBridgeCensus.ToJson(LinuxBridgeCensus.Build(
            Array.Empty<LinuxUsbBridgeTransport.BridgeDeviceInfo>(),
            Array.Empty<LinuxBridgeCensus.HidDeviceInfo>()));

        using var document = System.Text.Json.JsonDocument.Parse(json);
        Assert.Equal(0, document.RootElement.GetProperty("bridges").GetArrayLength());
        Assert.Equal(0, document.RootElement.GetProperty("hidDevices").GetArrayLength());
    }
}

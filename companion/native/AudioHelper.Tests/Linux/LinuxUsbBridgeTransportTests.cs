using Xunit;

// Regression coverage for the bridge's two enumeration shapes.
//
// The bug these exist for: with no controller connected the firmware enumerates companion-only
// as pid 0x0CE7 with a single vendor interface renumbered to 0. The Linux transport filtered on
// a product-id list that omitted 0x0CE7 and hard-coded interface 5 for the claim, so an idle
// bridge was skipped during enumeration and the app reported no bridge at all -- the exact
// state a user sits in before they have ever paired a controller.
public class LinuxUsbBridgeTransportTests
{
    private const ushort SonyVendorId = 0x054C;
    private const ushort IdleProductId = 0x0CE7;
    private const byte VendorClass = 0xFF;
    private const byte BulkOutEndpoint = 0x07;

    [Theory]
    [InlineData(0x054C, 0x0CE6)] // DualSense
    [InlineData(0x054C, 0x0DF2)] // DualSense Edge
    [InlineData(0x054C, 0x09CC)] // DualShock 4
    [InlineData(0x1209, 0xDB05)] // Xbox 360 persona
    [InlineData(SonyVendorId, IdleProductId)] // companion-only idle
    public void RecognisesEveryEnumerationTheFirmwareCanPresent(ushort vendor, ushort product)
    {
        Assert.True(LinuxUsbBridgeTransport.IsKnownBridgeUsbId(vendor, product));
    }

    [Fact]
    public void DoesNotClaimAControllerPluggedStraightIntoThePc()
    {
        // 0x0BA0 is the Sony USB wireless adapter, not a bridge.
        Assert.False(LinuxUsbBridgeTransport.IsKnownBridgeUsbId(SonyVendorId, 0x0BA0));
    }

    [Fact]
    public void PicksInterfaceZeroForTheIdleEnumeration()
    {
        // Companion-only: one interface, vendor class, bulk OUT on EP 0x07.
        var candidates = new[]
        {
            new BridgeInterfaceCandidate(0, VendorClass, new byte[] { BulkOutEndpoint })
        };

        var (interfaceNumber, endpoint) = LinuxUsbBridgeTransport.SelectBridgeInterface(candidates, IdleProductId);

        Assert.Equal(0, interfaceNumber);
        Assert.Equal(BulkOutEndpoint, endpoint);
    }

    [Fact]
    public void PrefersInterfaceFiveOnTheFullCompositeDevice()
    {
        // The composite device also exposes HID and audio interfaces; only interface 5 is the
        // bridge. Taking the first vendor-class match would be wrong here.
        var candidates = new[]
        {
            new BridgeInterfaceCandidate(0, 0x03, Array.Empty<byte>()),        // HID
            new BridgeInterfaceCandidate(1, 0x01, Array.Empty<byte>()),        // audio control
            new BridgeInterfaceCandidate(5, VendorClass, new byte[] { BulkOutEndpoint })
        };

        var (interfaceNumber, endpoint) = LinuxUsbBridgeTransport.SelectBridgeInterface(candidates, 0x0CE6);

        Assert.Equal(5, interfaceNumber);
        Assert.Equal(BulkOutEndpoint, endpoint);
    }

    [Fact]
    public void IgnoresVendorInterfacesWithNoBulkOutEndpoint()
    {
        var candidates = new[]
        {
            new BridgeInterfaceCandidate(2, VendorClass, Array.Empty<byte>()),
            new BridgeInterfaceCandidate(3, VendorClass, new byte[] { 0x09 })
        };

        var (interfaceNumber, endpoint) = LinuxUsbBridgeTransport.SelectBridgeInterface(candidates, 0x0CE6);

        Assert.Equal(3, interfaceNumber);
        Assert.Equal(0x09, endpoint);
    }

    [Fact]
    public void FallsBackToTheIdleInterfaceWhenDescriptorsAreUnreadable()
    {
        // Descriptor parsing failed: guess from the product id rather than assuming interface 5,
        // which does not exist on the idle device.
        var (interfaceNumber, endpoint) = LinuxUsbBridgeTransport.SelectBridgeInterface(
            Array.Empty<BridgeInterfaceCandidate>(),
            IdleProductId);

        Assert.Equal(0, interfaceNumber);
        Assert.Equal(BulkOutEndpoint, endpoint);
    }

    [Fact]
    public void FallsBackToInterfaceFiveForTheFullDevice()
    {
        var (interfaceNumber, _) = LinuxUsbBridgeTransport.SelectBridgeInterface(
            Array.Empty<BridgeInterfaceCandidate>(),
            0x0CE6);

        Assert.Equal(5, interfaceNumber);
    }
}

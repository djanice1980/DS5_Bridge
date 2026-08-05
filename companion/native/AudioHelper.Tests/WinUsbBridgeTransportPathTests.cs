using Xunit;

// The bridge changes USB shape depending on whether a controller is attached, and the device
// path changes with it. Requiring "mi_05" made the companion blind to the companion-only
// bridge -- Windows had bound WinUSB to it, but every enumeration path in the helper skipped
// it, so the app reported no bridge exactly when Pair/Forget were the only useful actions.
public sealed class WinUsbBridgeTransportPathTests
{
    [Fact]
    public void AcceptsTheCompositeBridgeInterface()
    {
        Assert.True(WinUsbBridgeTransport.IsBridgeInterfacePath(
            @"\\?\usb#vid_054c&pid_0ce6&mi_05#8&aa3fc5f&1&0005#{e4c8b2a9-87f5-4c4c-9e52-2b4c1b8b4f62}"));
    }

    [Fact]
    public void AcceptsTheCompanionOnlyBridgeWhichHasNoInterfaceSegment()
    {
        Assert.True(WinUsbBridgeTransport.IsBridgeInterfacePath(
            @"\\?\usb#vid_054c&pid_0ce7#7&dd2a026&0&3#{e4c8b2a9-87f5-4c4c-9e52-2b4c1b8b4f62}"));
    }

    [Theory]
    [InlineData(@"\\?\usb#vid_054c&pid_0ce6&mi_00#8&aa3fc5f&1&0000#{e4c8b2a9-87f5-4c4c-9e52-2b4c1b8b4f62}")]
    [InlineData(@"\\?\usb#vid_054c&pid_0ce6&mi_03#8&aa3fc5f&1&0003#{e4c8b2a9-87f5-4c4c-9e52-2b4c1b8b4f62}")]
    [InlineData(@"\\?\usb#vid_054c&pid_0ce6&mi_04#8&aa3fc5f&1&0004#{e4c8b2a9-87f5-4c4c-9e52-2b4c1b8b4f62}")]
    public void RejectsOtherInterfacesOfTheCompositeDevice(string path)
    {
        // Relaxing the marker must not turn into "accept any interface": on the composite
        // device the audio and HID children are not the bridge control interface.
        Assert.False(WinUsbBridgeTransport.IsBridgeInterfacePath(path));
    }
}

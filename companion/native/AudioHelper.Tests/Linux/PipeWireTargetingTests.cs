using Xunit;

// Sink selection with two identically-named devices present. The bridge impersonates a
// DualSense, so a real controller plugged in alongside it produces two "DualSense Wireless
// Controller" sinks; before port-path targeting, whichever enumerated first won, and a test
// tone or haptics buzz could land on the wrong physical device.
public class PipeWireTargetingTests
{
    private static PipeWireNode Sink(string name, string? portPath, int id = 1) => new(
        Id: id,
        Serial: id,
        MediaClass: "Audio/Sink",
        Name: name,
        Description: "DualSense wireless controller (PS5) Analog Surround 4.0",
        State: "idle",
        ProcessId: 0,
        ApplicationName: "",
        ProcessBinary: "",
        PortPath: portPath);

    private static PipeWireSnapshot Snap(params PipeWireNode[] nodes) =>
        new(new List<PipeWireNode>(nodes), "", "");

    [Fact]
    public void PicksTheSinkOnTheTargetPort()
    {
        var bridge = Sink("alsa_output.usb-Sony_DualSense-00.analog-surround-40", "usb:5-1.3", 1);
        var controller = Sink("alsa_output.usb-Sony_DualSense-01.analog-surround-40", "usb:5-1.1.2", 2);

        Assert.Same(controller, LinuxEndpointManager.SelectBridgeSink(Snap(bridge, controller), "usb:5-1.1.2"));
        Assert.Same(bridge, LinuxEndpointManager.SelectBridgeSink(Snap(bridge, controller), "usb:5-1.3"));
    }

    [Fact]
    public void RefusesToGuessWhenTheTargetIsAbsent()
    {
        // Only the controller's sink exists but the app is targeting the bridge (say, idle mode
        // with no audio interface). Falling back would buzz the wrong device -- the exact bug
        // this replaces -- so the answer is "not found".
        var controller = Sink("alsa_output.usb-Sony_DualSense-00.analog-surround-40", "usb:5-1.1.2");

        Assert.Null(LinuxEndpointManager.SelectBridgeSink(Snap(controller), "usb:5-1.3"));
    }

    [Fact]
    public void DegradesToAliasMatchingWhereNoPortsResolve()
    {
        // Environments where device.sysfs.path is unavailable keep the old behaviour rather
        // than losing audio entirely.
        var only = Sink("alsa_output.usb-Sony_DualSense-00.analog-surround-40", null);

        Assert.Same(only, LinuxEndpointManager.SelectBridgeSink(Snap(only), "usb:5-1.3"));
    }

    [Fact]
    public void NoTargetKeepsLegacyFirstMatch()
    {
        var first = Sink("alsa_output.usb-Sony_DualSense-00.analog-surround-40", "usb:5-1.3", 1);
        var second = Sink("alsa_output.usb-Sony_DualSense-01.analog-surround-40", "usb:5-1.1.2", 2);

        Assert.Same(first, LinuxEndpointManager.SelectBridgeSink(Snap(first, second), null));
    }

    [Fact]
    public void ResolvesNodePortsFromTheDeviceObjects()
    {
        // A miniature pw-dump: one Device carrying the sysfs path, one Node referencing it.
        const string dump = """
        [
          {
            "id": 89,
            "type": "PipeWire:Interface:Device",
            "info": { "props": {
              "device.name": "alsa_card.usb-Sony-00",
              "device.sysfs.path": "/devices/pci0000:00/0000:00:08.3/0000:26:00.3/usb5/5-1/5-1.1/5-1.1.2/5-1.1.2:1.0/sound/card3"
            } }
          },
          {
            "id": 130,
            "type": "PipeWire:Interface:Node",
            "info": { "state": "idle", "props": {
              "media.class": "Audio/Sink",
              "node.name": "alsa_output.usb-Sony-00.analog-surround-40",
              "node.description": "DualSense wireless controller (PS5) Analog Surround 4.0",
              "device.id": 89
            } }
          }
        ]
        """;

        var snapshot = PipeWireAudio.Parse(dump);

        var node = Assert.Single(snapshot.Nodes);
        Assert.Equal("usb:5-1.1.2", node.PortPath);
        Assert.Same(node, LinuxEndpointManager.SelectBridgeSink(snapshot, "usb:5-1.1.2"));
        Assert.Null(LinuxEndpointManager.SelectBridgeSink(snapshot, "usb:5-1.3"));
    }
}

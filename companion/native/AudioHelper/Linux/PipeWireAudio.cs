using System.Diagnostics;
using System.Text.Json;

// PipeWire integration built on the CLI tools that ship with every PipeWire
// install (pw-dump/pw-record/pw-play from `pipewire`, wpctl from
// `wireplumber`). No native bindings, so the helper stays dependency-free.

sealed record PipeWireNode(
    int Id,
    long Serial,
    string MediaClass,
    string Name,
    string Description,
    string State,
    int ProcessId,
    string ApplicationName,
    string ProcessBinary,
    string? PortPath = null);

sealed record PipeWireSnapshot(
    List<PipeWireNode> Nodes,
    string DefaultSinkName,
    string DefaultSourceName)
{
    public PipeWireNode? FindByName(string name)
    {
        return Nodes.FirstOrDefault(node => string.Equals(node.Name, name, StringComparison.Ordinal));
    }

    public PipeWireNode? DefaultSink => string.IsNullOrEmpty(DefaultSinkName) ? null : FindByName(DefaultSinkName);
}

static class PipeWireAudio
{
    public static PipeWireSnapshot Query()
    {
        var stdout = RunTool("pw-dump", Array.Empty<string>(), timeoutMs: 5000);
        return Parse(stdout);
    }

    internal static PipeWireSnapshot Parse(string dumpJson)
    {
        var nodes = new List<PipeWireNode>();
        var defaultSink = "";
        var defaultSource = "";
        // Device id -> USB port path ("usb:5-1.1.2"), resolved from device.sysfs.path -- the
        // same identity currency the census uses. This is what tells two identically-named
        // "DualSense Wireless Controller" sinks apart: the bridge IMPERSONATES a DualSense, so
        // when a real controller is also plugged in, name matching alone picks whichever
        // enumerated first and can buzz the wrong device.
        var devicePorts = new Dictionary<int, string>();

        using var document = JsonDocument.Parse(dumpJson);
        // Devices first: nodes reference them by device.id, and pw-dump does not promise an
        // ordering between the two.
        foreach (var element in document.RootElement.EnumerateArray())
        {
            var type = element.TryGetProperty("type", out var typeElement) ? typeElement.GetString() ?? "" : "";
            if (type != "PipeWire:Interface:Device")
            {
                continue;
            }
            if (!element.TryGetProperty("id", out var idElement)
                || !element.TryGetProperty("info", out var deviceInfo)
                || deviceInfo.ValueKind != JsonValueKind.Object
                || !deviceInfo.TryGetProperty("props", out var deviceProps))
            {
                continue;
            }
            var sysfsPath = GetString(deviceProps, "device.sysfs.path");
            if (sysfsPath.Length == 0)
            {
                continue;
            }
            var portPath = LinuxBridgeCensus.PortPathFromSysfsPath(sysfsPath);
            if (portPath is not null)
            {
                devicePorts[idElement.GetInt32()] = portPath;
            }
        }

        foreach (var element in document.RootElement.EnumerateArray())
        {
            var type = element.TryGetProperty("type", out var typeElement) ? typeElement.GetString() ?? "" : "";
            if (type == "PipeWire:Interface:Node")
            {
                var node = ParseNode(element, devicePorts);
                if (node is not null)
                {
                    nodes.Add(node);
                }
            }
            else if (type == "PipeWire:Interface:Metadata")
            {
                if (!element.TryGetProperty("props", out var props)
                    || !props.TryGetProperty("metadata.name", out var metadataName)
                    || metadataName.GetString() != "default")
                {
                    continue;
                }
                if (!element.TryGetProperty("metadata", out var entries))
                {
                    continue;
                }
                foreach (var entry in entries.EnumerateArray())
                {
                    var key = entry.TryGetProperty("key", out var keyElement) ? keyElement.GetString() : null;
                    if (key != "default.audio.sink" && key != "default.audio.source")
                    {
                        continue;
                    }
                    if (!entry.TryGetProperty("value", out var value))
                    {
                        continue;
                    }
                    var name = value.ValueKind == JsonValueKind.Object && value.TryGetProperty("name", out var nameElement)
                        ? nameElement.GetString() ?? ""
                        : "";
                    if (key == "default.audio.sink")
                    {
                        defaultSink = name;
                    }
                    else
                    {
                        defaultSource = name;
                    }
                }
            }
        }

        return new PipeWireSnapshot(nodes, defaultSink, defaultSource);
    }

    private static PipeWireNode? ParseNode(JsonElement element, IReadOnlyDictionary<int, string> devicePorts)
    {
        if (!element.TryGetProperty("id", out var idElement))
        {
            return null;
        }
        var info = element.TryGetProperty("info", out var infoElement) ? infoElement : default;
        if (info.ValueKind != JsonValueKind.Object || !info.TryGetProperty("props", out var props))
        {
            return null;
        }

        var mediaClass = GetString(props, "media.class");
        if (mediaClass.Length == 0)
        {
            return null;
        }

        var deviceId = (int)GetLong(props, "device.id");
        return new PipeWireNode(
            Id: idElement.GetInt32(),
            Serial: GetLong(props, "object.serial"),
            MediaClass: mediaClass,
            Name: GetString(props, "node.name"),
            Description: FirstNonEmpty(
                GetString(props, "node.description"),
                GetString(props, "node.nick"),
                GetString(props, "node.name")),
            State: GetString(info, "state"),
            ProcessId: (int)GetLong(props, "application.process.id"),
            ApplicationName: GetString(props, "application.name"),
            ProcessBinary: GetString(props, "application.process.binary"),
            PortPath: devicePorts.TryGetValue(deviceId, out var portPath) ? portPath : null);
    }

    private static string GetString(JsonElement element, string property)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value))
        {
            if (value.ValueKind == JsonValueKind.String)
            {
                return value.GetString() ?? "";
            }
            if (value.ValueKind is JsonValueKind.Number)
            {
                return value.GetRawText();
            }
        }
        return "";
    }

    private static long GetLong(JsonElement element, string property)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value))
        {
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
            {
                return number;
            }
            if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out var parsed))
            {
                return parsed;
            }
        }
        return 0;
    }

    private static string FirstNonEmpty(params string[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }
        return "";
    }

    public static string RunTool(string tool, string[] arguments, int timeoutMs)
    {
        var startInfo = new ProcessStartInfo(tool)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)
            ?? throw new IOException($"{tool} could not be started.");
        var stderrTask = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = stderrTask.GetAwaiter().GetResult();
        if (!process.WaitForExit(timeoutMs))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best effort.
            }
            throw new IOException($"{tool} timed out after {timeoutMs} ms.");
        }
        if (process.ExitCode != 0)
        {
            var detail = stderr.Trim();
            throw new IOException($"{tool} failed ({process.ExitCode}){(detail.Length > 0 ? $": {detail}" : ".")}");
        }
        return stdout;
    }

    public static Process StartCapture(string targetNodeName, bool captureSink, int channels)
    {
        var startInfo = new ProcessStartInfo("pw-record")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        // Headerless PCM to the pipe. Without --raw, pw-record/pw-play route the
        // stream through libsndfile, which fails on a headerless pipe with
        // "Format not recognised" and the process exits immediately.
        startInfo.ArgumentList.Add("--raw");
        startInfo.ArgumentList.Add("--format");
        startInfo.ArgumentList.Add("s16");
        startInfo.ArgumentList.Add("--rate");
        startInfo.ArgumentList.Add(AudioConstants.TargetSampleRate.ToString());
        startInfo.ArgumentList.Add("--channels");
        startInfo.ArgumentList.Add(channels.ToString());
        if (channels == 2)
        {
            // Pull only the front pair. When the capture target is the bridge's
            // own 4.0 sink monitor, this keeps our haptics (on RL/RR) out of the
            // captured signal so the DSP can't feed back on itself.
            startInfo.ArgumentList.Add("--channel-map");
            startInfo.ArgumentList.Add("FL,FR");
        }
        if (captureSink)
        {
            startInfo.ArgumentList.Add("-P");
            startInfo.ArgumentList.Add("{ stream.capture.sink = true }");
        }
        if (!string.IsNullOrEmpty(targetNodeName))
        {
            startInfo.ArgumentList.Add("--target");
            startInfo.ArgumentList.Add(targetNodeName);
        }
        startInfo.ArgumentList.Add("-");
        return Process.Start(startInfo) ?? throw new IOException("pw-record could not be started.");
    }

    public static Process StartPlayback(string targetNodeName, int channels, string channelMap, double volume)
    {
        var startInfo = new ProcessStartInfo("pw-play")
        {
            RedirectStandardInput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        // Read headerless PCM from the pipe (matches StartCapture). Without
        // --raw, pw-play asks libsndfile to detect a container on stdin and dies
        // with "Format not recognised".
        startInfo.ArgumentList.Add("--raw");
        startInfo.ArgumentList.Add("--format");
        startInfo.ArgumentList.Add("s16");
        startInfo.ArgumentList.Add("--rate");
        startInfo.ArgumentList.Add(AudioConstants.TargetSampleRate.ToString());
        startInfo.ArgumentList.Add("--channels");
        startInfo.ArgumentList.Add(channels.ToString());
        if (!string.IsNullOrEmpty(channelMap))
        {
            startInfo.ArgumentList.Add("--channel-map");
            startInfo.ArgumentList.Add(channelMap);
        }
        if (volume >= 0)
        {
            startInfo.ArgumentList.Add("--volume");
            startInfo.ArgumentList.Add(volume.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        }
        if (!string.IsNullOrEmpty(targetNodeName))
        {
            startInfo.ArgumentList.Add("--target");
            startInfo.ArgumentList.Add(targetNodeName);
        }
        startInfo.ArgumentList.Add("-");
        return Process.Start(startInfo) ?? throw new IOException("pw-play could not be started.");
    }
}

static class LinuxEndpointManager
{
    // The bridge's UAC card shows up under the persona's USB product string.
    private static readonly string[] BridgeAliases =
    {
        "ds5 bridge",
        "ds5bridge",
        "dualsense",
        "wireless controller",
        "wireless_controller",
        "xbox 360 controller"
    };

    public static bool IsBridgeNode(PipeWireNode node)
    {
        return MatchesAliases(node.Name) || MatchesAliases(node.Description);
    }

    private static bool MatchesAliases(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }
        var lowered = value.ToLowerInvariant();
        foreach (var alias in BridgeAliases)
        {
            if (lowered.Contains(alias))
            {
                return true;
            }
        }
        return false;
    }

    // Target-aware pick. targetContainer is the USB port path the app manages ("usb:5-1.3"),
    // the same identity the census reports; null keeps the legacy first-alias behaviour.
    //
    // STRICT on purpose: when a target is named and the alias candidates expose port paths but
    // none matches, this returns null rather than falling back to "some DualSense-named sink".
    // The bridge impersonates a DualSense, so with a real controller also plugged in the
    // fallback would be indistinguishable from the bug this exists to fix -- audio or a haptics
    // buzz landing on the wrong physical device. Only when NO candidate resolves a port (an
    // environment where ports cannot be read at all) does it degrade to the alias pick.
    private static PipeWireNode? PickTargeted(
        IEnumerable<PipeWireNode> candidates,
        string? targetContainer)
    {
        var list = candidates.ToList();
        if (string.IsNullOrEmpty(targetContainer))
        {
            return list.FirstOrDefault();
        }
        var exact = list.FirstOrDefault(node =>
            node.PortPath is not null
            && string.Equals(node.PortPath, targetContainer, StringComparison.OrdinalIgnoreCase));
        if (exact is not null)
        {
            return exact;
        }
        return list.Any(node => node.PortPath is not null) ? null : list.FirstOrDefault();
    }

    public static PipeWireNode? SelectBridgeSink(PipeWireSnapshot snapshot, string? targetContainer = null)
    {
        return PickTargeted(
            snapshot.Nodes.Where(node => node.MediaClass == "Audio/Sink" && IsBridgeNode(node)),
            targetContainer);
    }

    // The app-facing "Speaker" sink the ALSA UCM split exposes is stereo and
    // hides the two haptic channels. The raw hw device (Audio/Sink/Internal,
    // node.name alsa_output.hw_*) carries all four USB channels, so haptics
    // must target it to reach channels 2/3. Falls back to the plain sink.
    public static PipeWireNode? SelectBridgeRawSink(PipeWireSnapshot snapshot, string? targetContainer = null)
    {
        return PickTargeted(
                snapshot.Nodes.Where(node =>
                    node.MediaClass == "Audio/Sink/Internal"
                    && (IsBridgeNode(node) || node.Name.StartsWith("alsa_output.hw_", StringComparison.Ordinal))),
                targetContainer)
            ?? SelectBridgeSink(snapshot, targetContainer);
    }

    public static PipeWireNode? SelectBridgeSource(PipeWireSnapshot snapshot, string? targetContainer = null)
    {
        return PickTargeted(
            snapshot.Nodes.Where(node => node.MediaClass == "Audio/Source" && IsBridgeNode(node)),
            targetContainer);
    }

    public static void PrintDefaultRenderStatus(string? targetContainer = null)
    {
        var snapshot = PipeWireAudio.Query();
        var defaultSink = snapshot.DefaultSink;
        // With a target named, "is the managed endpoint" also requires the port to agree (or be
        // unresolvable); an identically-named sink on another port is a different device.
        var isManaged = defaultSink is not null && IsBridgeNode(defaultSink)
            && (string.IsNullOrEmpty(targetContainer)
                || defaultSink.PortPath is null
                || string.Equals(defaultSink.PortPath, targetContainer, StringComparison.OrdinalIgnoreCase));
        var payload = new
        {
            deviceName = defaultSink?.Description ?? snapshot.DefaultSinkName,
            isBridgeEndpoint = isManaged
        };
        Console.Out.WriteLine(JsonSerializer.Serialize(payload));
    }

    public static void SetDefaultRenderBridge(string? targetContainer = null)
    {
        var snapshot = PipeWireAudio.Query();
        var bridgeSink = SelectBridgeSink(snapshot, targetContainer)
            ?? throw new IOException("DS5 Bridge audio endpoint was not found.");
        _ = PipeWireAudio.RunTool("wpctl", new[] { "set-default", bridgeSink.Id.ToString() }, timeoutMs: 5000);
        Console.Error.WriteLine($"status: default-render-set device='{StatusText.Escape(bridgeSink.Description)}'");
    }

    // With UCM disabled the controller presents a proper 4.0 sink, so stereo
    // maps to the front pair at unity — no path loss to compensate. But the
    // raw hardware volume defaults low (~40%), so just raise a still-quiet sink
    // to a clean 100%. Anything the user has already set to a usable level
    // (>= 50%) is left alone; nothing is ever boosted past 100%.
    public static void ApplySpeakerCompensation(double factor, string? targetContainer = null)
    {
        _ = factor;
        var snapshot = PipeWireAudio.Query();
        var sink = SelectBridgeSink(snapshot, targetContainer);
        if (sink is null)
        {
            Console.Error.WriteLine("status: speaker-level-skipped reason=no-sink");
            return;
        }

        // Pin the controller speaker to unity (100%). With UCM disabled the ACP
        // profile exposes the sink at ~40% by default (too quiet), and a boost
        // applied by an older build can persist at 200% (distorts). Normalize
        // either way so "100%" in the app is 100% at the controller.
        var current = TryGetNodeVolume(sink.Id);
        if (current is double vol && vol >= 0.97 && vol <= 1.03)
        {
            Console.Error.WriteLine(
                $"status: speaker-level-skipped reason=already-unity volume={FormatFactor(vol)}");
            return;
        }

        _ = PipeWireAudio.RunTool(
            "wpctl",
            new[] { "set-volume", sink.Id.ToString(), "1.0" },
            timeoutMs: 5000);
        Console.Error.WriteLine(
            $"status: speaker-level-set volume=1.0 previous={(current is double p ? FormatFactor(p) : "unknown")} device='{StatusText.Escape(sink.Description)}'");
    }

    private static double? TryGetNodeVolume(int nodeId)
    {
        try
        {
            var stdout = PipeWireAudio.RunTool("wpctl", new[] { "get-volume", nodeId.ToString() }, timeoutMs: 5000);
            var match = System.Text.RegularExpressions.Regex.Match(stdout, @"Volume:\s*([0-9]+(?:\.[0-9]+)?)");
            if (match.Success
                && double.TryParse(
                    match.Groups[1].Value,
                    System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var vol))
            {
                return vol;
            }
        }
        catch
        {
            // Unknown volume — caller treats null as "safe to apply".
        }
        return null;
    }

    private static string FormatFactor(double value)
    {
        return value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
    }

    public static void ListDevices()
    {
        var snapshot = PipeWireAudio.Query();
        foreach (var node in snapshot.Nodes)
        {
            if (node.MediaClass != "Audio/Sink" && node.MediaClass != "Audio/Source")
            {
                continue;
            }
            var isDefault = node.Name == snapshot.DefaultSinkName || node.Name == snapshot.DefaultSourceName;
            Console.Error.WriteLine(
                $"{node.MediaClass}: '{node.Description}' name='{node.Name}' id={node.Id} state={node.State}{(isDefault ? " default" : "")}{(IsBridgeNode(node) ? " bridge" : "")}");
        }
    }
}

static class StatusText
{
    // Mirrors EscapeStatusValue in the Windows helper.
    public static string Escape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("'", "\\'");
    }
}

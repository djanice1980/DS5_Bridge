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
    string ProcessBinary);

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

        using var document = JsonDocument.Parse(dumpJson);
        foreach (var element in document.RootElement.EnumerateArray())
        {
            var type = element.TryGetProperty("type", out var typeElement) ? typeElement.GetString() ?? "" : "";
            if (type == "PipeWire:Interface:Node")
            {
                var node = ParseNode(element);
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

    private static PipeWireNode? ParseNode(JsonElement element)
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
            ProcessBinary: GetString(props, "application.process.binary"));
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
        startInfo.ArgumentList.Add("--format");
        startInfo.ArgumentList.Add("s16");
        startInfo.ArgumentList.Add("--rate");
        startInfo.ArgumentList.Add(AudioConstants.TargetSampleRate.ToString());
        startInfo.ArgumentList.Add("--channels");
        startInfo.ArgumentList.Add(channels.ToString());
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

    public static PipeWireNode? SelectBridgeSink(PipeWireSnapshot snapshot)
    {
        return snapshot.Nodes.FirstOrDefault(node =>
            node.MediaClass == "Audio/Sink" && IsBridgeNode(node));
    }

    public static PipeWireNode? SelectBridgeSource(PipeWireSnapshot snapshot)
    {
        return snapshot.Nodes.FirstOrDefault(node =>
            node.MediaClass == "Audio/Source" && IsBridgeNode(node));
    }

    public static void PrintDefaultRenderStatus()
    {
        var snapshot = PipeWireAudio.Query();
        var defaultSink = snapshot.DefaultSink;
        var payload = new
        {
            deviceName = defaultSink?.Description ?? snapshot.DefaultSinkName,
            isBridgeEndpoint = defaultSink is not null && IsBridgeNode(defaultSink)
        };
        Console.Out.WriteLine(JsonSerializer.Serialize(payload));
    }

    public static void SetDefaultRenderBridge()
    {
        var snapshot = PipeWireAudio.Query();
        var bridgeSink = SelectBridgeSink(snapshot)
            ?? throw new IOException("DS5 Bridge audio endpoint was not found.");
        _ = PipeWireAudio.RunTool("wpctl", new[] { "set-default", bridgeSink.Id.ToString() }, timeoutMs: 5000);
        Console.Error.WriteLine($"status: default-render-set device='{StatusText.Escape(bridgeSink.Description)}'");
    }

    // Compensate the ~6 dB the Linux USB-audio path loses when it spreads
    // stereo across the controller's 4 channels: boost the controller sink's
    // software volume so a given firmware gain level matches Windows. Applied
    // only to a pristine (~100%) sink so it never fights a user adjustment.
    public static void ApplySpeakerCompensation(double factor)
    {
        var snapshot = PipeWireAudio.Query();
        var sink = SelectBridgeSink(snapshot);
        if (sink is null)
        {
            Console.Error.WriteLine("status: speaker-compensation-skipped reason=no-sink");
            return;
        }

        var current = TryGetNodeVolume(sink.Id);
        if (current is double vol && Math.Abs(vol - 1.0) > 0.02)
        {
            Console.Error.WriteLine(
                $"status: speaker-compensation-skipped reason=user-set volume={FormatFactor(vol)}");
            return;
        }

        _ = PipeWireAudio.RunTool(
            "wpctl",
            new[] { "set-volume", sink.Id.ToString(), FormatFactor(factor) },
            timeoutMs: 5000);
        Console.Error.WriteLine(
            $"status: speaker-compensation-applied volume={FormatFactor(factor)} device='{StatusText.Escape(sink.Description)}'");
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

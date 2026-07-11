using System.Text.Json;

// Linux twin of AudioSessionMonitor: NDJSON snapshots of per-app audio
// sessions, sourced from PipeWire stream nodes instead of WASAPI sessions.
// Same stdout schema, same stdin commands (refresh / stop).
static class LinuxAudioSessionMonitor
{
    private const int PollIntervalMs = 2000;

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private sealed record SessionRecord(
        int ProcessId,
        string? DisplayName,
        string? ExecutableName,
        string? ProcessPath,
        string? IconPath,
        string? IconDataUrl,
        string? SessionIdentifier,
        string? SessionInstanceIdentifier,
        string State,
        string EndpointName,
        bool IsSelected);

    public static int Run()
    {
        Console.Error.WriteLine("status: audio-session-monitor-started");

        using var stopRequested = new ManualResetEventSlim(false);
        using var refreshRequested = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stopRequested.Set();
        };

        var stdinThread = new Thread(() =>
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                var command = line.Trim().ToLowerInvariant();
                if (command == "refresh")
                {
                    refreshRequested.Set();
                }
                else if (command == "stop")
                {
                    break;
                }
            }
            stopRequested.Set();
        })
        {
            IsBackground = true
        };
        stdinThread.Start();

        string lastSnapshotJson = "";
        while (!stopRequested.IsSet)
        {
            var forced = refreshRequested.IsSet;
            refreshRequested.Reset();

            string json;
            try
            {
                json = BuildSnapshotJson();
            }
            catch
            {
                json = lastSnapshotJson;
            }

            if (json.Length > 0 && (forced || !string.Equals(json, lastSnapshotJson, StringComparison.Ordinal)))
            {
                lastSnapshotJson = json;
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }

            if (stopRequested.Wait(PollIntervalMs))
            {
                break;
            }
        }

        Console.Error.WriteLine("status: audio-session-monitor-stopped");
        return 0;
    }

    private static string BuildSnapshotJson()
    {
        var snapshot = PipeWireAudio.Query();
        var sessions = ListSessions(snapshot);
        return JsonSerializer.Serialize(new { type = "snapshot", sessions }, SerializerOptions);
    }

    private static List<SessionRecord> ListSessions(PipeWireSnapshot snapshot)
    {
        var sessions = new List<SessionRecord>();
        var seenKeys = new HashSet<string>();
        var defaultSinkName = snapshot.DefaultSink?.Description ?? snapshot.DefaultSinkName;

        foreach (var node in snapshot.Nodes)
        {
            if (node.MediaClass != "Stream/Output/Audio")
            {
                continue;
            }
            // The bridge companion's own streams are not selectable sources.
            if (LinuxEndpointManager.IsBridgeNode(node))
            {
                continue;
            }

            var processPath = ResolveProcessPath(node.ProcessId);
            var executableName = node.ProcessBinary.Length > 0
                ? node.ProcessBinary
                : (processPath is not null ? Path.GetFileName(processPath) : null);
            var displayName = FirstNonEmpty(node.ApplicationName, node.Description, executableName ?? "", $"PID {node.ProcessId}");

            var key = processPath?.ToLowerInvariant()
                ?? executableName?.ToLowerInvariant()
                ?? $"pid:{node.ProcessId}";
            if (!seenKeys.Add(key))
            {
                continue;
            }

            sessions.Add(new SessionRecord(
                ProcessId: Math.Max(0, node.ProcessId),
                DisplayName: displayName,
                ExecutableName: executableName,
                ProcessPath: processPath,
                IconPath: LinuxIconResolver.ResolveIconPath(executableName, node.ApplicationName),
                IconDataUrl: null,
                SessionIdentifier: node.Name.Length > 0 ? node.Name : null,
                SessionInstanceIdentifier: node.Serial > 0 ? node.Serial.ToString() : null,
                State: node.State == "running" ? "active" : "inactive",
                EndpointName: defaultSinkName,
                IsSelected: false));
        }

        return sessions
            .OrderByDescending(session => session.State == "active")
            .ThenBy(session => session.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string? ResolveProcessPath(int processId)
    {
        if (processId <= 0)
        {
            return null;
        }
        try
        {
            var target = new FileInfo($"/proc/{processId}/exe").LinkTarget;
            return string.IsNullOrEmpty(target) ? null : target;
        }
        catch
        {
            return null;
        }
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
}

// Best-effort freedesktop icon lookup: gives the Electron side a PNG path it
// can turn into a data URL (it falls back to a generic icon otherwise).
static class LinuxIconResolver
{
    private static readonly string[] IconDirectories =
    {
        "/usr/share/icons/hicolor/48x48/apps",
        "/usr/share/icons/hicolor/64x64/apps",
        "/usr/share/icons/hicolor/128x128/apps",
        "/usr/share/icons/hicolor/256x256/apps",
        "/usr/share/pixmaps"
    };

    public static string? ResolveIconPath(string? executableName, string? applicationName)
    {
        foreach (var candidate in IconNameCandidates(executableName, applicationName))
        {
            foreach (var directory in IconDirectories)
            {
                var pngPath = Path.Combine(directory, candidate + ".png");
                if (File.Exists(pngPath))
                {
                    return pngPath;
                }
            }
        }
        return null;
    }

    public static int RunResolveDataUrl(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            Console.Out.WriteLine();
            return 0;
        }

        var extension = Path.GetExtension(path).ToLowerInvariant();
        var mimeType = extension switch
        {
            ".png" => "image/png",
            ".svg" => "image/svg+xml",
            ".jpg" or ".jpeg" => "image/jpeg",
            _ => null
        };
        if (mimeType is null)
        {
            Console.Out.WriteLine();
            return 0;
        }

        try
        {
            var bytes = File.ReadAllBytes(path);
            Console.Out.WriteLine($"data:{mimeType};base64,{Convert.ToBase64String(bytes)}");
        }
        catch
        {
            Console.Out.WriteLine();
        }
        return 0;
    }

    private static IEnumerable<string> IconNameCandidates(string? executableName, string? applicationName)
    {
        if (!string.IsNullOrWhiteSpace(executableName))
        {
            var name = Path.GetFileNameWithoutExtension(executableName);
            yield return name;
            yield return name.ToLowerInvariant();
        }
        if (!string.IsNullOrWhiteSpace(applicationName))
        {
            yield return applicationName;
            yield return applicationName.ToLowerInvariant();
            yield return applicationName.ToLowerInvariant().Replace(' ', '-');
        }
    }
}

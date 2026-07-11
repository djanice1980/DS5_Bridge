using System.Diagnostics;

// Linux twin of the Windows --haptics-only engine: capture the user's default
// output (or one app's stream), run the reactive-haptics DSP, and lay the
// result onto channels 2/3 of the bridge's 4-channel endpoint. Status-line
// vocabulary matches the Windows helper exactly so bridge-service.ts needs no
// platform branches.
static class LinuxHapticsMirror
{
    private const int CaptureChannels = 2;
    private const int OutputChannels = 4;
    private const int BytesPerSample = 2;
    private const int ChunkFrames = 480; // 10 ms at 48 kHz
    private const int RouteWatchIntervalMs = 1000;

    public static int Run(LinuxHelperOptions options)
    {
        PipeWireSnapshot snapshot;
        try
        {
            snapshot = PipeWireAudio.Query();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                $"status: capture-unavailable reason=helper-exit device='{StatusText.Escape(error.Message)}'");
            return 1;
        }

        var isAppSession = options.AppProcessId is not null
            || !string.IsNullOrEmpty(options.AppProcessPath)
            || !string.IsNullOrEmpty(options.AppExecutableName);

        PipeWireNode? captureNode;
        bool captureSinkMonitor;
        if (isAppSession)
        {
            captureNode = ResolveAppStreamNode(snapshot, options);
            captureSinkMonitor = false;
            if (captureNode is null)
            {
                Console.Error.WriteLine(
                    $"status: capture-unavailable reason=app-session-unavailable processId={options.AppProcessId?.ToString() ?? "none"} processPath='{StatusText.Escape(options.AppProcessPath ?? "")}' executable='{StatusText.Escape(options.AppExecutableName ?? "")}'");
                return 1;
            }
        }
        else
        {
            captureNode = snapshot.DefaultSink;
            captureSinkMonitor = true;
            if (captureNode is null)
            {
                Console.Error.WriteLine(
                    "status: capture-unavailable reason=device-invalidated device='no default output'");
                return 1;
            }

            // Feedback-loop guard: mirroring the bridge into itself would echo.
            if (LinuxEndpointManager.IsBridgeNode(captureNode))
            {
                Console.Error.WriteLine(
                    $"status: system-haptics-bypassed reason=source-is-bridge device='{StatusText.Escape(captureNode.Description)}'");
                return 0;
            }
        }

        var targetNode = LinuxEndpointManager.SelectBridgeSink(snapshot);
        if (targetNode is null)
        {
            Console.Error.WriteLine(
                "status: capture-unavailable reason=target-unavailable device='DS5 Bridge audio endpoint not found'");
            return 1;
        }

        var dsp = new ReactiveHapticsDsp(
            options.HapticsGainPercent,
            options.HapticsBassFocus,
            options.HapticsResponse,
            options.HapticsAttack,
            options.HapticsRelease);

        Process? capture = null;
        Process? playback = null;
        try
        {
            capture = PipeWireAudio.StartCapture(captureNode.Name, captureSinkMonitor, CaptureChannels);
            playback = PipeWireAudio.StartPlayback(targetNode.Name, OutputChannels, "FL,FR,RL,RR", volume: -1);
        }
        catch (Exception error)
        {
            capture?.Kill(entireProcessTree: true);
            Console.Error.WriteLine(
                $"status: capture-unavailable reason=helper-exit device='{StatusText.Escape(error.Message)}'");
            return 1;
        }

        Console.Error.WriteLine(
            $"status: audio-capture-format source=system-haptics-mirror device='{StatusText.Escape(captureNode.Description)}' target='{StatusText.Escape(targetNode.Description)}' sampleRate={AudioConstants.TargetSampleRate} channels={CaptureChannels} bits=16 encoding=Pcm targetRate={AudioConstants.TargetSampleRate} targetChannels={OutputChannels} targetBits=16 targetEncoding=Pcm bufferMs=10");

        using var stopRequested = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stopRequested.Set();
        };

        // Live retune plus shutdown-on-EOF, mirroring ProcessControlLine.
        var controlThread = new Thread(() =>
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (parts.Length >= 4
                    && string.Equals(parts[0], "haptics-config", StringComparison.OrdinalIgnoreCase)
                    && int.TryParse(parts[1], out var gain))
                {
                    dsp.Configure(
                        gain,
                        LinuxHelperOptions.ParseHapticsBassFocus(parts[2]),
                        LinuxHelperOptions.ParseHapticsResponse(parts[3]),
                        parts.Length > 4 ? LinuxHelperOptions.ParseHapticsAttack(parts[4]) : 1,
                        parts.Length > 5 ? LinuxHelperOptions.ParseHapticsRelease(parts[5]) : 1);
                }
            }
            stopRequested.Set();
        })
        {
            IsBackground = true
        };
        controlThread.Start();

        // Route watching: default-output changes restart the engine, a dead
        // app session stops it — both handled by the parent on 'route-changed'.
        var routeChangeReason = "";
        var routeThread = new Thread(() =>
        {
            while (!stopRequested.Wait(RouteWatchIntervalMs))
            {
                try
                {
                    if (isAppSession)
                    {
                        if (captureNode.ProcessId > 0 && !Directory.Exists($"/proc/{captureNode.ProcessId}"))
                        {
                            routeChangeReason = "app-session-exited";
                            stopRequested.Set();
                            return;
                        }
                    }
                    else
                    {
                        var current = PipeWireAudio.Query();
                        if (!string.Equals(current.DefaultSinkName, snapshot.DefaultSinkName, StringComparison.Ordinal))
                        {
                            routeChangeReason = "default-render-changed";
                            stopRequested.Set();
                            return;
                        }
                    }
                }
                catch
                {
                    // Transient pw-dump failure; keep mirroring.
                }
            }
        })
        {
            IsBackground = true
        };
        routeThread.Start();

        var exitCode = 0;
        var recordingAnnounced = false;
        try
        {
            var captureStream = capture.StandardOutput.BaseStream;
            var playbackStream = playback.StandardInput.BaseStream;
            var captureChunk = new byte[ChunkFrames * CaptureChannels * BytesPerSample];
            var outputChunk = new byte[ChunkFrames * OutputChannels * BytesPerSample];

            while (!stopRequested.IsSet)
            {
                var read = FillChunk(captureStream, captureChunk);
                if (read <= 0)
                {
                    if (!stopRequested.IsSet)
                    {
                        Console.Error.WriteLine(
                            "status: capture-unavailable reason=helper-exit device='pw-record stream ended'");
                        exitCode = 1;
                    }
                    break;
                }

                if (!recordingAnnounced)
                {
                    recordingAnnounced = true;
                    Console.Error.WriteLine("status: recording-started");
                }

                var frames = read / (CaptureChannels * BytesPerSample);
                Array.Clear(outputChunk, 0, frames * OutputChannels * BytesPerSample);
                for (var frame = 0; frame < frames; frame++)
                {
                    var inputOffset = frame * CaptureChannels * BytesPerSample;
                    var left = BitConverter.ToInt16(captureChunk, inputOffset) / 32768f;
                    var right = BitConverter.ToInt16(captureChunk, inputOffset + BytesPerSample) / 32768f;
                    var processed = dsp.ProcessSample(left, right);

                    var outputOffset = frame * OutputChannels * BytesPerSample;
                    WriteInt16(outputChunk, outputOffset + BytesPerSample * 2, processed.Left);
                    WriteInt16(outputChunk, outputOffset + BytesPerSample * 3, processed.Right);
                }

                playbackStream.Write(outputChunk, 0, frames * OutputChannels * BytesPerSample);
                playbackStream.Flush();
            }
        }
        catch (IOException)
        {
            if (!stopRequested.IsSet)
            {
                Console.Error.WriteLine(
                    "status: capture-unavailable reason=helper-exit device='haptics mirror pipe closed'");
                exitCode = 1;
            }
        }
        finally
        {
            KillQuietly(capture);
            KillQuietly(playback);
        }

        if (routeChangeReason.Length > 0)
        {
            Console.Error.WriteLine($"status: route-changed reason={routeChangeReason}");
        }
        return exitCode;
    }

    private static int FillChunk(Stream stream, byte[] buffer)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer, total, buffer.Length - total);
            if (read <= 0)
            {
                break;
            }
            total += read;
        }
        return total;
    }

    private static void WriteInt16(byte[] buffer, int offset, float sample)
    {
        var value = (short)Math.Round(Math.Clamp(sample, -1f, 1f) * short.MaxValue);
        buffer[offset] = (byte)(value & 0xff);
        buffer[offset + 1] = (byte)((value >> 8) & 0xff);
    }

    private static PipeWireNode? ResolveAppStreamNode(PipeWireSnapshot snapshot, LinuxHelperOptions options)
    {
        var streams = snapshot.Nodes
            .Where(node => node.MediaClass == "Stream/Output/Audio")
            .ToList();

        if (options.AppProcessId is int processId && processId > 0)
        {
            var byPid = streams.FirstOrDefault(node => node.ProcessId == processId);
            if (byPid is not null)
            {
                return byPid;
            }
        }

        if (!string.IsNullOrEmpty(options.AppProcessPath))
        {
            var wantedBinary = Path.GetFileName(options.AppProcessPath);
            var byPath = streams.FirstOrDefault(node =>
                !string.IsNullOrEmpty(node.ProcessBinary)
                && string.Equals(node.ProcessBinary, wantedBinary, StringComparison.OrdinalIgnoreCase));
            if (byPath is not null)
            {
                return byPath;
            }
        }

        if (!string.IsNullOrEmpty(options.AppExecutableName))
        {
            var wanted = Path.GetFileNameWithoutExtension(options.AppExecutableName);
            var byBinary = streams.FirstOrDefault(node =>
                (!string.IsNullOrEmpty(node.ProcessBinary)
                    && string.Equals(Path.GetFileNameWithoutExtension(node.ProcessBinary), wanted, StringComparison.OrdinalIgnoreCase))
                || (!string.IsNullOrEmpty(node.ApplicationName)
                    && string.Equals(node.ApplicationName, wanted, StringComparison.OrdinalIgnoreCase)));
            if (byBinary is not null)
            {
                return byBinary;
            }
        }

        return null;
    }

    private static void KillQuietly(Process? process)
    {
        if (process is null)
        {
            return;
        }
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort.
        }
    }
}

using System.Diagnostics;

// Linux twin of the Windows --haptics-only engine.
//
// Primary path (--stdout-only, what bridge-service uses on Linux): capture the
// chosen audio source, run the reactive-haptics DSP, pack the result into the
// firmware's 264-byte compact frames (haptic buckets, no Opus), and write those
// frames to stdout. The Electron main process forwards them over the vendor USB
// interface it already holds. This delivers haptics the same way Windows does,
// completely independent of the controller's UAC audio channels (which a UCM
// split hides on Linux), and with no feedback loop — so it works even when the
// controller is the default output.
//
// Fallback path (no --stdout-only): render the haptics onto channels 2/3 of the
// bridge's 4-channel audio sink. Kept for completeness; requires the sink to
// expose those channels.
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

            // Feedback-loop guard only matters for the audio-render fallback,
            // where mirroring the bridge into itself would echo. Frames over
            // USB never feed back, so the stdout path can safely capture the
            // bridge's own monitor (game audio going to the controller).
            if (!options.StdoutOnly && LinuxEndpointManager.IsBridgeNode(captureNode))
            {
                Console.Error.WriteLine(
                    $"status: system-haptics-bypassed reason=source-is-bridge device='{StatusText.Escape(captureNode.Description)}'");
                return 0;
            }
        }

        PipeWireNode? targetNode = null;
        if (!options.StdoutOnly)
        {
            targetNode = LinuxEndpointManager.SelectBridgeSink(snapshot);
            if (targetNode is null)
            {
                Console.Error.WriteLine(
                    "status: capture-unavailable reason=target-unavailable device='DS5 Bridge audio endpoint not found'");
                return 1;
            }
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
            if (!options.StdoutOnly)
            {
                playback = PipeWireAudio.StartPlayback(targetNode!.Name, OutputChannels, "FL,FR,RL,RR", volume: -1);
            }
        }
        catch (Exception error)
        {
            capture?.Kill(entireProcessTree: true);
            Console.Error.WriteLine(
                $"status: capture-unavailable reason=helper-exit device='{StatusText.Escape(error.Message)}'");
            return 1;
        }

        var transport = options.StdoutOnly ? "usb-frames" : "audio-mirror";
        Console.Error.WriteLine(
            $"status: audio-capture-format source=system-haptics-mirror device='{StatusText.Escape(captureNode.Description)}' target='{StatusText.Escape(targetNode?.Description ?? "usb-frames")}' sampleRate={AudioConstants.TargetSampleRate} channels={CaptureChannels} bits=16 encoding=Pcm bufferMs=10 transport={transport}");

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
        // In stdout/USB mode a default-output change is fine (we still capture
        // whatever the new default plays), so only watch app-session liveness.
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
                    else if (!options.StdoutOnly)
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

        var exitCode = options.StdoutOnly
            ? RunFrameLoop(capture, dsp, stopRequested)
            : RunAudioLoop(capture, playback!, dsp, stopRequested);

        KillQuietly(capture);
        KillQuietly(playback);

        if (routeChangeReason.Length > 0)
        {
            Console.Error.WriteLine($"status: route-changed reason={routeChangeReason}");
        }
        return exitCode;
    }

    // Capture -> DSP -> 264-byte compact frames -> stdout. The parent forwards
    // each frame over the vendor USB interface.
    private static int RunFrameLoop(Process capture, ReactiveHapticsDsp dsp, ManualResetEventSlim stopRequested)
    {
        var recordingAnnounced = false;
        var stdout = Console.OpenStandardOutput();
        var hapticLeftBlock = new float[AudioConstants.PicoInputBlockFrames];
        var hapticRightBlock = new float[AudioConstants.PicoInputBlockFrames];
        var blockIndex = 0;
        var frame = new byte[AudioConstants.CompactFrameBytes];
        var prefix = new byte[2];
        var captureChunk = new byte[ChunkFrames * CaptureChannels * BytesPerSample];

        try
        {
            var captureStream = capture.StandardOutput.BaseStream;
            while (!stopRequested.IsSet)
            {
                var read = FillChunk(captureStream, captureChunk);
                if (read <= 0)
                {
                    if (!stopRequested.IsSet)
                    {
                        Console.Error.WriteLine(
                            "status: capture-unavailable reason=helper-exit device='pw-record stream ended'");
                        return 1;
                    }
                    break;
                }

                if (!recordingAnnounced)
                {
                    recordingAnnounced = true;
                    Console.Error.WriteLine("status: recording-started");
                }

                var frames = read / (CaptureChannels * BytesPerSample);
                for (var i = 0; i < frames; i++)
                {
                    var inputOffset = i * CaptureChannels * BytesPerSample;
                    var left = BitConverter.ToInt16(captureChunk, inputOffset) / 32768f;
                    var right = BitConverter.ToInt16(captureChunk, inputOffset + BytesPerSample) / 32768f;
                    var processed = dsp.ProcessSample(left, right);
                    hapticLeftBlock[blockIndex] = processed.Left;
                    hapticRightBlock[blockIndex] = processed.Right;
                    blockIndex++;
                    if (blockIndex >= AudioConstants.PicoInputBlockFrames)
                    {
                        BuildHapticFrame(frame, hapticLeftBlock, hapticRightBlock);
                        LegacyFramePacketizer.WriteStdoutFrame(stdout, prefix, frame);
                        blockIndex = 0;
                    }
                }
            }
        }
        catch (IOException)
        {
            if (!stopRequested.IsSet)
            {
                Console.Error.WriteLine(
                    "status: capture-unavailable reason=helper-exit device='haptics frame pipe closed'");
                return 1;
            }
        }
        return 0;
    }

    // Fallback: render haptics onto channels 2/3 of the bridge audio sink.
    private static int RunAudioLoop(Process capture, Process playback, ReactiveHapticsDsp dsp, ManualResetEventSlim stopRequested)
    {
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
                        return 1;
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
                return 1;
            }
        }
        return 0;
    }

    // Pack 512 haptic samples into the firmware's 264-byte compact frame:
    // 32 buckets of interleaved int8 L/R (bytes 0..63), no Opus (bytes 64..263
    // stay zero). Mirrors BuildReport in the Windows helper for haptics-only.
    private static void BuildHapticFrame(byte[] destination, float[] hapticLeftBlock, float[] hapticRightBlock)
    {
        Array.Clear(destination);
        for (var bucket = 0; bucket < AudioConstants.HapticBuckets; bucket++)
        {
            var left = ResampleHapticBucket(hapticLeftBlock, bucket);
            var right = ResampleHapticBucket(hapticRightBlock, bucket);
            destination[bucket * 2] = FloatToInt8(left);
            destination[bucket * 2 + 1] = FloatToInt8(right);
        }
    }

    private static float ResampleHapticBucket(float[] samples, int bucket)
    {
        var sourcePosition = ((bucket + 0.5) * AudioConstants.PicoInputBlockFrames / AudioConstants.HapticBuckets) - 0.5;
        var sourceIndex = Math.Clamp((int)Math.Floor(sourcePosition), 0, AudioConstants.PicoInputBlockFrames - 1);
        var nextIndex = Math.Min(sourceIndex + 1, AudioConstants.PicoInputBlockFrames - 1);
        var fraction = Math.Clamp(sourcePosition - sourceIndex, 0, 1);
        return Lerp(samples[sourceIndex], samples[nextIndex], fraction);
    }

    private static float Lerp(float a, float b, double amount)
    {
        return (float)(a + ((b - a) * amount));
    }

    private static byte FloatToInt8(float sample)
    {
        return unchecked((byte)(sbyte)Math.Round(Math.Clamp(sample, -1f, 1f) * sbyte.MaxValue));
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

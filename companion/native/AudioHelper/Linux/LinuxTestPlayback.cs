using System.Diagnostics;

// Linux twins of AudioHelperTestTone / AudioHelperTestHaptics. The haptics
// test prefers the exact Windows primary path (264-byte frames over the
// vendor bulk pipe) and falls back to rendering channels 2/3 of the bridge's
// 4-channel endpoint.
static class LinuxTestPlayback
{
    private const int PacketCount = 36;
    private const int PrerollPacketCount = 3;
    private const int NeutralPacketCount = 5;
    private const int BaseAmplitude = 72;
    private const int MaxGainPercent = 200;

    public static void PlayTestTone(LinuxHelperOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.TestAudioPath))
        {
            throw new InvalidOperationException("Test audio path was not provided.");
        }
        if (!File.Exists(options.TestAudioPath))
        {
            throw new FileNotFoundException("Test audio file was not found.", options.TestAudioPath);
        }

        var snapshot = PipeWireAudio.Query();
        var device = LinuxEndpointManager.SelectBridgeSink(snapshot)
            ?? throw new IOException("DS5 Bridge audio endpoint was not found.");

        var volume = Math.Clamp(options.SpeakerVolumePercent, 0, 100) / 100.0;
        var startInfo = new ProcessStartInfo("pw-play")
        {
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add("--target");
        startInfo.ArgumentList.Add(device.Name);
        startInfo.ArgumentList.Add("--volume");
        startInfo.ArgumentList.Add(volume.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        startInfo.ArgumentList.Add(options.TestAudioPath);

        using var playback = Process.Start(startInfo)
            ?? throw new IOException("pw-play could not be started.");
        var stderrTask = playback.StandardError.ReadToEndAsync();
        if (!playback.WaitForExit(8000))
        {
            try
            {
                playback.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best effort.
            }
            playback.WaitForExit(500);
        }
        else if (playback.ExitCode != 0)
        {
            var detail = stderrTask.GetAwaiter().GetResult().Trim();
            throw new IOException(
                $"pw-play failed ({playback.ExitCode}){(detail.Length > 0 ? $": {detail}" : ".")} The bundled MP3 needs an mpg123-enabled libsndfile.");
        }
        Console.Error.WriteLine($"status: test-tone-played '{StatusText.Escape(device.Description)}'");
    }

    public static void PlayTestHaptics(LinuxHelperOptions options)
    {
        // The running companion app holds the vendor USB interface, so a second
        // process can't send frames over it. Play the test pattern into the
        // controller's haptic audio channels (2/3) instead — the same path
        // Audio Haptics uses. This is also a clean go/no-go for whether writing
        // those channels reaches the firmware at all.
        PlayViaRenderEndpoint(options);
    }

    private static void PlayViaRenderEndpoint(LinuxHelperOptions options)
    {
        PipeWireSnapshot snapshot;
        PipeWireNode? device;
        try
        {
            snapshot = PipeWireAudio.Query();
            device = LinuxEndpointManager.SelectBridgeSink(snapshot);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"status: test-haptics-unavailable reason='{StatusText.Escape(error.Message)}'");
            return;
        }
        if (device is null)
        {
            Console.Error.WriteLine("status: test-haptics-unavailable reason=no-sink");
            return;
        }

        var pcm = BuildTestPcm(options.HapticsGainPercent);
        try
        {
            using var playback = PipeWireAudio.StartPlayback(device.Name, channels: 4, channelMap: "FL,FR,RL,RR", volume: -1);
            var stdin = playback.StandardInput.BaseStream;
            stdin.Write(pcm, 0, pcm.Length);
            stdin.Flush();
            stdin.Close();
            if (!playback.WaitForExit(3000))
            {
                try
                {
                    playback.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Best effort.
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"status: test-haptics-unavailable reason='{StatusText.Escape(error.Message)}'");
            return;
        }
        Console.Error.WriteLine($"status: test-haptics-played device='{StatusText.Escape(device.Description)}' channels=RL,RR");
    }

    // Same waveform as AudioHelperTestHaptics.BuildTestFrames: 3 silent
    // preroll frames, 36 alternating-polarity square frames, 5 neutral tail.
    internal static byte[][] BuildTestFrames(int gainPercent)
    {
        var packetTotal = PrerollPacketCount + PacketCount + NeutralPacketCount;
        var frames = new byte[packetTotal][];
        for (var index = 0; index < frames.Length; index++)
        {
            frames[index] = new byte[AudioConstants.CompactFrameBytes];
        }

        var gain = Math.Clamp(gainPercent, 0, MaxGainPercent);
        for (var packet = 0; packet < PacketCount; packet++)
        {
            var amplitude = TestAmplitude(BaseAmplitude, gain);
            if (amplitude <= 0)
            {
                continue;
            }

            var packetsRemaining = PacketCount - packet;
            var positivePhase = (packetsRemaining & 1) != 0;
            var left = positivePhase ? amplitude : -amplitude;
            var right = positivePhase ? -amplitude : amplitude;
            var frame = frames[PrerollPacketCount + packet];

            for (var index = 0; index < AudioConstants.HapticBuckets * 2; index += 2)
            {
                frame[index] = unchecked((byte)(sbyte)left);
                frame[index + 1] = unchecked((byte)(sbyte)right);
            }
        }

        return frames;
    }

    // 48 kHz 16-bit 4-channel PCM equivalent of BuildTestPcm: each packet
    // spans 512 frames, haptics on channels 2/3 only.
    internal static byte[] BuildTestPcm(int gainPercent)
    {
        const int channels = 4;
        const int bytesPerSample = 2;
        const int blockAlign = channels * bytesPerSample;
        var framesPerPacket = AudioConstants.PicoInputBlockFrames;
        var packetTotal = PrerollPacketCount + PacketCount + NeutralPacketCount;
        var buffer = new byte[packetTotal * framesPerPacket * blockAlign];
        var gain = Math.Clamp(gainPercent, 0, MaxGainPercent);

        for (var packet = 0; packet < PacketCount; packet++)
        {
            var amplitude = TestAmplitude(BaseAmplitude, gain) / 127.0f;
            if (amplitude <= 0)
            {
                continue;
            }
            var packetsRemaining = PacketCount - packet;
            var positivePhase = (packetsRemaining & 1) != 0;
            var left = positivePhase ? amplitude : -amplitude;
            var right = positivePhase ? -amplitude : amplitude;
            var packetFrameStart = (PrerollPacketCount + packet) * framesPerPacket;

            for (var frame = 0; frame < framesPerPacket; frame++)
            {
                var offset = (packetFrameStart + frame) * blockAlign;
                WriteInt16(buffer, offset + bytesPerSample * 2, left);
                WriteInt16(buffer, offset + bytesPerSample * 3, right);
            }
        }

        return buffer;
    }

    private static int TestAmplitude(int baseAmplitude, int gainPercent)
    {
        var scaled = baseAmplitude * Math.Clamp(gainPercent, 0, MaxGainPercent) * 100;
        return Math.Min(127, scaled / 10000);
    }

    private static void WriteInt16(byte[] buffer, int offset, float sample)
    {
        var value = (short)Math.Round(Math.Clamp(sample, -1f, 1f) * short.MaxValue);
        buffer[offset] = (byte)(value & 0xff);
        buffer[offset + 1] = (byte)((value >> 8) & 0xff);
    }

    private static void WaitUntil(Stopwatch stopwatch, long targetTicks)
    {
        while (true)
        {
            var remainingTicks = targetTicks - stopwatch.ElapsedTicks;
            if (remainingTicks <= 0)
            {
                return;
            }

            var remainingMs = remainingTicks * 1000 / Stopwatch.Frequency;
            if (remainingMs > 2)
            {
                Thread.Sleep(1);
            }
            else
            {
                Thread.Yield();
            }
        }
    }
}

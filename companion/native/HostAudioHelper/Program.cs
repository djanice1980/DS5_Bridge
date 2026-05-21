using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using Concentus.Enums;
using Concentus.Structs;
using HidSharp;
using NAudio.CoreAudioApi;
using NAudio.Wave;

var options = HelperOptions.Parse(args);
if (options.PlayTestTone)
{
    HostAudioTestTone.Play(options);
    return;
}

using var helper = new HostAudioHelper(options);
await helper.RunAsync();

static class AudioConstants
{
    public const int TargetSampleRate = 48000;
    public const int PicoInputBlockFrames = 512;
    public const int OpusFrameSamples = 480;
    public const int OpusPacketBytes = 200;
    public const int CompactFrameBytes = 264;
    public const int HapticBuckets = 32;
    public const int WasapiBufferMilliseconds = 10;
    public const int MaxQueuedReports = 8;
    public const int MaxBufferedReports = 4;
    public const byte HostAudioStreamReportId = 0x07;
    public const byte FastFrameFragmentType = 0x08;
    public const int FastPayloadBytes = 57;
    public const int HidReportBytes = 64;
    public const int HidWriteTimeoutMilliseconds = 4;
    public const int CaptureCallbackGapWarningUs = 20000;
    public const int WriterScheduleLateWarningUs = 8000;
    public const int HidWriteLateWarningUs = 8000;
    public const int DiagnosticsIntervalMilliseconds = 2000;
    public static readonly bool DiagnosticsEnabled = false;
    public const int MicKeepaliveBufferMilliseconds = 10;
    public const float SpeakerGainRampStepPermille = 1000f / (TargetSampleRate * 0.02f);
    public static readonly long FrameIntervalTicks = Stopwatch.Frequency * PicoInputBlockFrames / TargetSampleRate;
}

static class HostAudioTestTone
{
    public static void Play(HelperOptions options)
    {
        using var enumerator = new MMDeviceEnumerator();
        var device = HostAudioHelper.SelectRenderEndpoint(enumerator, options.DeviceName);
        using var output = new WasapiOut(device, AudioClientShareMode.Shared, false, 120);
        using var fileReader = OpenTestAudioFile(options.TestAudioPath);
        using var playbackStopped = new ManualResetEventSlim(false);
        fileReader.Volume = Math.Clamp(options.SpeakerVolumePercent, 0, 100) / 100.0f;
        output.PlaybackStopped += (_, _) => playbackStopped.Set();
        output.Init(fileReader);
        output.Play();
        if (!playbackStopped.Wait(TimeSpan.FromSeconds(8)))
        {
            output.Stop();
            playbackStopped.Wait(TimeSpan.FromMilliseconds(500));
        }
        Console.Error.WriteLine($"status: test-tone-played '{device.FriendlyName}'");
    }

    private static AudioFileReader OpenTestAudioFile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Test audio path was not provided.");
        }
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("Test audio file was not found.", path);
        }
        return new AudioFileReader(path);
    }
}

sealed class HostAudioHelper : IDisposable
{
    private readonly HelperOptions options;
    private readonly OpusEncoder encoder;
    private readonly object sync = new();
    private readonly byte[] opusScratch = new byte[1275];
    private readonly short[] speakerPcm = new short[AudioConstants.OpusFrameSamples * 2];
    private readonly float[] speakerBlock = new float[AudioConstants.PicoInputBlockFrames * 2];
    private readonly float[] hapticLeftBlock = new float[AudioConstants.PicoInputBlockFrames];
    private readonly float[] hapticRightBlock = new float[AudioConstants.PicoInputBlockFrames];
    private readonly byte[] writePrefix = new byte[2];
    private readonly byte[] hidReport = new byte[AudioConstants.HidReportBytes];
    private readonly byte[] report = new byte[AudioConstants.CompactFrameBytes];
    private readonly BlockingCollection<byte[]> reportQueue = new(AudioConstants.MaxQueuedReports);
    private readonly ManualResetEventSlim stopped = new(false);
    private readonly Task writerTask;
    private readonly Task? diagnosticsTask;
    private MMDeviceEnumerator? enumerator;
    private MMDevice? renderDevice;
    private WasapiLoopbackCapture? capture;
    private WasapiCapture? micCapture;
    private HidStream? hidStream;
    private int picoBlockFrameIndex;
    private bool picoBlockHasHaptics;
    private double resampleCredit;
    private long capturedFrames;
    private long encodedReports;
    private long writtenReports;
    private long writtenFragments;
    private long droppedReports;
    private long writeLateEvents;
    private long maxWriteLateUs;
    private long lastCaptureCallbackTicks;
    private long captureCallbackGapEvents;
    private long captureCallbackGapMaxUs;
    private long writerScheduleLateEvents;
    private long writerScheduleLateMaxUs;
    private long hidWriteLateEvents;
    private long hidWriteLateMaxUs;
    private ushort frameSequence;
    private int peakSamplePermille;
    private long capturedCallbacks;
    private long micCallbacks;
    private long micCapturedFrames;
    private int micPeakPermille;
    private int targetSpeakerGainPermille;
    private float currentSpeakerGainPermille;
    private bool disposed;

    public HostAudioHelper(HelperOptions options)
    {
        this.options = options;
        targetSpeakerGainPermille = VolumePercentToPermille(options.SpeakerVolumePercent);
        currentSpeakerGainPermille = 0f;
        RaiseSchedulingPriority();
        encoder = new OpusEncoder(AudioConstants.TargetSampleRate, 2, OpusApplication.OPUS_APPLICATION_AUDIO)
        {
            Bitrate = 160000,
            Complexity = 0,
            UseVBR = false
        };
        writerTask = Task.Run(WriteReports);
        diagnosticsTask = AudioConstants.DiagnosticsEnabled ? Task.Run(WriteDiagnostics) : null;
    }

    public async Task RunAsync()
    {
        if (options.ListDevices)
        {
            ListDevices();
            return;
        }

        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            Stop();
        };

        _ = Task.Run(() =>
        {
            try
            {
                string? line;
                while ((line = Console.In.ReadLine()) is not null)
                {
                    ProcessControlLine(line);
                }
            }
            catch (IOException)
            {
            }
            Stop();
        });

        Start();
        await Task.Run(() => stopped.Wait());
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        Stop();
        capture?.Dispose();
        micCapture?.Dispose();
        hidStream?.Dispose();
        enumerator?.Dispose();
        reportQueue.CompleteAdding();
        try
        {
            writerTask.Wait(TimeSpan.FromSeconds(1));
            diagnosticsTask?.Wait(TimeSpan.FromSeconds(1));
        }
        catch (AggregateException)
        {
        }
        reportQueue.Dispose();
        stopped.Dispose();
    }

    private void Start()
    {
        enumerator = new MMDeviceEnumerator();
        if (options.MicKeepaliveOnly)
        {
            StartMicKeepalive(enumerator);
            return;
        }

        TryOpenCompanionHid();
        var device = SelectRenderEndpoint(enumerator, options.DeviceName);
        renderDevice = device;
        capture = new WasapiLoopbackCapture(device);
        SetWasapiBufferMilliseconds(capture, AudioConstants.WasapiBufferMilliseconds);
        capture.DataAvailable += OnDataAvailable;
        capture.RecordingStopped += (_, eventArgs) =>
        {
            if (eventArgs.Exception is not null)
            {
                Console.Error.WriteLine($"error: capture stopped: {eventArgs.Exception.Message}");
            }
            stopped.Set();
        };

        if (AudioConstants.DiagnosticsEnabled)
        {
            Console.Error.WriteLine(
                $"status: capturing '{device.FriendlyName}' {capture.WaveFormat.SampleRate}Hz {capture.WaveFormat.Channels}ch {capture.WaveFormat.BitsPerSample}bit {capture.WaveFormat.Encoding}");
        }
        capture.StartRecording();
        Console.Error.WriteLine("status: recording-started");
    }

    private void Stop()
    {
        try
        {
            micCapture?.StopRecording();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"error: mic keepalive stop failed: {error.Message}");
        }
        try
        {
            capture?.StopRecording();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"error: stop failed: {error.Message}");
        }
        stopped.Set();
    }

    private void StartMicKeepalive(MMDeviceEnumerator enumerator)
    {
        var device = SelectCaptureEndpoint(enumerator, options.MicDeviceName ?? options.DeviceName);
        micCapture = new WasapiCapture(device, false, AudioConstants.MicKeepaliveBufferMilliseconds);
        micCapture.DataAvailable += OnMicDataAvailable;
        micCapture.RecordingStopped += (_, eventArgs) =>
        {
            if (eventArgs.Exception is not null)
            {
                Console.Error.WriteLine($"error: mic keepalive stopped: {eventArgs.Exception.Message}");
            }
            stopped.Set();
        };

        if (AudioConstants.DiagnosticsEnabled)
        {
            Console.Error.WriteLine(
                $"status: mic keepalive opening '{device.FriendlyName}' {micCapture.WaveFormat.SampleRate}Hz {micCapture.WaveFormat.Channels}ch {micCapture.WaveFormat.BitsPerSample}bit {micCapture.WaveFormat.Encoding}");
        }
        micCapture.StartRecording();
        if (AudioConstants.DiagnosticsEnabled)
        {
            Console.Error.WriteLine("status: mic keepalive started");
        }
    }

    private void TryOpenCompanionHid()
    {
        if (string.IsNullOrWhiteSpace(options.HidPath))
        {
            return;
        }

        var device = DeviceList.Local.GetHidDevices()
            .FirstOrDefault(candidate => string.Equals(candidate.DevicePath, options.HidPath, StringComparison.OrdinalIgnoreCase));
        if (device is null)
        {
            if (AudioConstants.DiagnosticsEnabled)
            {
                Console.Error.WriteLine("status: companion HID path not found; using stdout frame transport");
            }
            return;
        }

        try
        {
            hidStream = device.Open();
            hidStream.WriteTimeout = AudioConstants.HidWriteTimeoutMilliseconds;
            if (AudioConstants.DiagnosticsEnabled)
            {
                Console.Error.WriteLine($"status: companion HID direct output active maxOutput={device.GetMaxOutputReportLength()}");
            }
        }
        catch (Exception error)
        {
            hidStream = null;
            if (AudioConstants.DiagnosticsEnabled)
            {
                Console.Error.WriteLine($"status: companion HID direct output unavailable: {error.Message}; using stdout frame transport");
            }
        }
    }

    public static MMDevice SelectRenderEndpoint(MMDeviceEnumerator enumerator, string? deviceName)
    {
        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .ToArray();

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            var exact = devices.FirstOrDefault(device =>
                string.Equals(device.FriendlyName, deviceName, StringComparison.OrdinalIgnoreCase));
            if (exact is not null)
            {
                return exact;
            }

            var contains = devices.FirstOrDefault(device =>
                device.FriendlyName.Contains(deviceName, StringComparison.OrdinalIgnoreCase));
            if (contains is not null)
            {
                return contains;
            }

            if (deviceName.Contains("DS5 Bridge", StringComparison.OrdinalIgnoreCase))
            {
                var alias = FindKnownBridgeEndpoint(devices);
                if (alias is not null)
                {
                    if (AudioConstants.DiagnosticsEnabled)
                    {
                        Console.Error.WriteLine($"status: endpoint alias '{alias.FriendlyName}' matched for '{deviceName}'");
                    }
                    return alias;
                }
            }

            var available = string.Join(", ", devices.Select(device => $"'{device.FriendlyName}'"));
            throw new InvalidOperationException($"Render endpoint matching '{deviceName}' was not found. Available endpoints: {available}");
        }

        var ds5Bridge = FindKnownBridgeEndpoint(devices);
        if (ds5Bridge is not null)
        {
            return ds5Bridge;
        }

        return enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    }

    private static MMDevice SelectCaptureEndpoint(MMDeviceEnumerator enumerator, string? deviceName)
    {
        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
            .ToArray();

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            var exact = devices.FirstOrDefault(device =>
                string.Equals(device.FriendlyName, deviceName, StringComparison.OrdinalIgnoreCase));
            if (exact is not null)
            {
                return exact;
            }

            var contains = devices.FirstOrDefault(device =>
                device.FriendlyName.Contains(deviceName, StringComparison.OrdinalIgnoreCase));
            if (contains is not null)
            {
                return contains;
            }

            if (deviceName.Contains("DS5 Bridge", StringComparison.OrdinalIgnoreCase))
            {
                var alias = FindKnownBridgeEndpoint(devices);
                if (alias is not null)
                {
                    if (AudioConstants.DiagnosticsEnabled)
                    {
                        Console.Error.WriteLine($"status: capture endpoint alias '{alias.FriendlyName}' matched for '{deviceName}'");
                    }
                    return alias;
                }
            }

            var available = string.Join(", ", devices.Select(device => $"'{device.FriendlyName}'"));
            throw new InvalidOperationException($"Capture endpoint matching '{deviceName}' was not found. Available endpoints: {available}");
        }

        var ds5Bridge = FindKnownBridgeEndpoint(devices);
        if (ds5Bridge is not null)
        {
            return ds5Bridge;
        }

        return enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
    }

    private static MMDevice? FindKnownBridgeEndpoint(IEnumerable<MMDevice> devices)
    {
        var names = new[]
        {
            "DS5 Bridge",
            "DualSense Wireless Controller"
        };

        foreach (var name in names)
        {
            var match = devices.FirstOrDefault(device =>
                device.FriendlyName.Contains(name, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                return match;
            }
        }

        return null;
    }

    private static void ListDevices()
    {
        using var enumerator = new MMDeviceEnumerator();
        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            Console.Error.WriteLine($"render-device: {device.FriendlyName}");
        }
        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        {
            Console.Error.WriteLine($"capture-device: {device.FriendlyName}");
        }
    }

    private static void SetWasapiBufferMilliseconds(WasapiLoopbackCapture capture, int milliseconds)
    {
        var field = typeof(WasapiCapture).GetField("audioBufferMillisecondsLength", BindingFlags.Instance | BindingFlags.NonPublic);
        field?.SetValue(capture, milliseconds);
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs eventArgs)
    {
        var format = capture?.WaveFormat;
        if (format is null || eventArgs.BytesRecorded <= 0)
        {
            return;
        }

        NoteCaptureCallback(eventArgs.BytesRecorded);
        lock (sync)
        {
            ProcessPcm(eventArgs.Buffer, eventArgs.BytesRecorded, format);
        }
    }

    private void OnMicDataAvailable(object? sender, WaveInEventArgs eventArgs)
    {
        var format = micCapture?.WaveFormat;
        if (format is null || eventArgs.BytesRecorded <= 0)
        {
            return;
        }

        var channels = Math.Max(1, format.Channels);
        var bytesPerSample = Math.Max(1, format.BitsPerSample / 8);
        var frameBytes = Math.Max(1, channels * bytesPerSample);
        var frameCount = eventArgs.BytesRecorded / frameBytes;
        if (AudioConstants.DiagnosticsEnabled)
        {
            Interlocked.Increment(ref micCallbacks);
            Interlocked.Add(ref micCapturedFrames, frameCount);

            var peak = 0;
            for (var frame = 0; frame < frameCount; frame++)
            {
                var offset = frame * frameBytes;
                for (var channel = 0; channel < channels; channel++)
                {
                    var sample = Math.Abs(ReadSample(eventArgs.Buffer, eventArgs.BytesRecorded, offset + channel * bytesPerSample, format));
                    peak = Math.Max(peak, (int)Math.Round(sample * 1000));
                }
            }
            if (peak > micPeakPermille)
            {
                Interlocked.Exchange(ref micPeakPermille, peak);
            }
        }
    }

    private void ProcessPcm(byte[] buffer, int byteCount, WaveFormat format)
    {
        var channels = Math.Max(1, format.Channels);
        var bytesPerSample = Math.Max(1, format.BitsPerSample / 8);
        var frameBytes = channels * bytesPerSample;
        var frameCount = byteCount / frameBytes;
        var outputPerInput = AudioConstants.TargetSampleRate / (double)format.SampleRate;
        if (AudioConstants.DiagnosticsEnabled)
        {
            capturedCallbacks++;
            capturedFrames += frameCount;
        }

        for (var frame = 0; frame < frameCount; frame++)
        {
            var offset = frame * frameBytes;
            var left = ReadSample(buffer, byteCount, offset, format);
            var right = channels > 1 ? ReadSample(buffer, byteCount, offset + bytesPerSample, format) : left;
            var hapticLeft = channels > 2 ? ReadSample(buffer, byteCount, offset + bytesPerSample * 2, format) : 0;
            var hapticRight = channels > 3 ? ReadSample(buffer, byteCount, offset + bytesPerSample * 3, format) : hapticLeft;
            if (AudioConstants.DiagnosticsEnabled)
            {
                var peak = (int)Math.Round(Math.Max(Math.Abs(left), Math.Abs(right)) * 1000);
                if (peak > peakSamplePermille)
                {
                    Interlocked.Exchange(ref peakSamplePermille, peak);
                }
            }

            resampleCredit += outputPerInput;
            while (resampleCredit >= 1)
            {
                PushPicoInputSample(left, right, hapticLeft, hapticRight, channels >= 4);
                resampleCredit -= 1;
            }
        }
    }

    private void NoteCaptureCallback(int bytesRecorded)
    {
        if (!AudioConstants.DiagnosticsEnabled)
        {
            return;
        }

        var nowTicks = Stopwatch.GetTimestamp();
        var previousTicks = Interlocked.Exchange(ref lastCaptureCallbackTicks, nowTicks);
        if (previousTicks == 0)
        {
            return;
        }

        var gapUs = (nowTicks - previousTicks) * 1000000 / Stopwatch.Frequency;
        UpdateMax(ref captureCallbackGapMaxUs, gapUs);
        if (gapUs <= AudioConstants.CaptureCallbackGapWarningUs)
        {
            return;
        }

        Interlocked.Increment(ref captureCallbackGapEvents);
        LogHelperEvent("capture-gap", $"gapUs={gapUs} bytes={bytesRecorded}");
    }

    private static float ReadSample(byte[] buffer, int byteCount, int offset, WaveFormat format)
    {
        if (offset < 0 || offset >= byteCount)
        {
            return 0;
        }

        if (format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
        {
            return Math.Clamp(BitConverter.ToSingle(buffer, offset), -1, 1);
        }

        return format.BitsPerSample switch
        {
            16 when offset + 1 < byteCount => BinaryPrimitives.ReadInt16LittleEndian(buffer.AsSpan(offset, 2)) / 32768f,
            24 when offset + 2 < byteCount => ReadInt24(buffer, offset) / 8388608f,
            32 when offset + 3 < byteCount && format.Encoding == WaveFormatEncoding.Pcm =>
                BinaryPrimitives.ReadInt32LittleEndian(buffer.AsSpan(offset, 4)) / 2147483648f,
            32 when offset + 3 < byteCount => Math.Clamp(BitConverter.ToSingle(buffer, offset), -1, 1),
            _ => 0
        };
    }

    private static int ReadInt24(byte[] buffer, int offset)
    {
        var value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
        if ((value & 0x800000) != 0)
        {
            value |= unchecked((int)0xff000000);
        }
        return value;
    }

    private void PushPicoInputSample(float left, float right, float hapticLeft, float hapticRight, bool hasHaptics)
    {
        speakerBlock[picoBlockFrameIndex * 2] = left;
        speakerBlock[picoBlockFrameIndex * 2 + 1] = right;
        hapticLeftBlock[picoBlockFrameIndex] = hapticLeft;
        hapticRightBlock[picoBlockFrameIndex] = hapticRight;
        picoBlockHasHaptics |= hasHaptics;

        picoBlockFrameIndex++;
        if (picoBlockFrameIndex < AudioConstants.PicoInputBlockFrames)
        {
            return;
        }

        EmitReport(picoBlockHasHaptics);
        picoBlockFrameIndex = 0;
        picoBlockHasHaptics = false;
    }

    private void EmitReport(bool hasHaptics)
    {
        ResampleSpeakerBlock();
        var encodedBytes = encoder.Encode(speakerPcm, 0, AudioConstants.OpusFrameSamples, opusScratch, 0, AudioConstants.OpusPacketBytes);
        if (AudioConstants.DiagnosticsEnabled)
        {
            encodedReports++;
        }
        BuildReport(report, opusScratch, encodedBytes, hasHaptics, hapticLeftBlock, hapticRightBlock);
        var frame = new byte[AudioConstants.CompactFrameBytes];
        Buffer.BlockCopy(report, 0, frame, 0, frame.Length);
        while (reportQueue.Count >= AudioConstants.MaxBufferedReports)
        {
            if (!reportQueue.TryTake(out _))
            {
                break;
            }
            if (AudioConstants.DiagnosticsEnabled)
            {
                droppedReports++;
            }
        }
        if (!reportQueue.TryAdd(frame))
        {
            _ = reportQueue.TryTake(out _);
            if (AudioConstants.DiagnosticsEnabled)
            {
                droppedReports++;
            }
            _ = reportQueue.TryAdd(frame);
        }
    }

    private void ResampleSpeakerBlock()
    {
        const double ratio = AudioConstants.PicoInputBlockFrames / (double)AudioConstants.OpusFrameSamples;
        var currentGainPermille = currentSpeakerGainPermille;
        var targetGainPermille = Volatile.Read(ref targetSpeakerGainPermille);
        for (var frame = 0; frame < AudioConstants.OpusFrameSamples; frame++)
        {
            var gainDelta = targetGainPermille - currentGainPermille;
            currentGainPermille += Math.Clamp(
                gainDelta,
                -AudioConstants.SpeakerGainRampStepPermille,
                AudioConstants.SpeakerGainRampStepPermille
            );
            var speakerGain = currentGainPermille / 1000f;
            var sourcePosition = (frame + 0.5) * ratio - 0.5;
            var sourceIndex = Math.Clamp((int)Math.Floor(sourcePosition), 0, AudioConstants.PicoInputBlockFrames - 1);
            var nextIndex = Math.Min(sourceIndex + 1, AudioConstants.PicoInputBlockFrames - 1);
            var fraction = Math.Clamp(sourcePosition - sourceIndex, 0, 1);
            var left = Lerp(speakerBlock[sourceIndex * 2], speakerBlock[nextIndex * 2], fraction);
            var right = Lerp(speakerBlock[sourceIndex * 2 + 1], speakerBlock[nextIndex * 2 + 1], fraction);
            speakerPcm[frame * 2] = FloatToInt16(left * speakerGain);
            speakerPcm[frame * 2 + 1] = FloatToInt16(right * speakerGain);
        }
        currentSpeakerGainPermille = currentGainPermille;
    }

    private void ProcessControlLine(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0)
        {
            return;
        }

        var parts = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (
            parts.Length == 2
            && string.Equals(parts[0], "speaker-volume", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(parts[1], out var speakerVolumePercent)
        )
        {
            Volatile.Write(ref targetSpeakerGainPermille, VolumePercentToPermille(speakerVolumePercent));
            return;
        }
    }

    private static void BuildReport(
        byte[] destination,
        byte[] opus,
        int encodedBytes,
        bool hasHaptics,
        float[] hapticLeftBlock,
        float[] hapticRightBlock)
    {
        Array.Clear(destination);

        for (var bucket = 0; bucket < AudioConstants.HapticBuckets; bucket++)
        {
            var left = hasHaptics ? AverageHapticBucket(hapticLeftBlock, bucket) : 0;
            var right = hasHaptics ? AverageHapticBucket(hapticRightBlock, bucket) : 0;
            destination[bucket * 2] = FloatToInt8(left);
            destination[bucket * 2 + 1] = FloatToInt8(right);
        }

        Buffer.BlockCopy(opus, 0, destination, 64, Math.Min(encodedBytes, AudioConstants.OpusPacketBytes));
    }

    private static float AverageHapticBucket(float[] samples, int bucket)
    {
        var start = bucket * AudioConstants.PicoInputBlockFrames / AudioConstants.HapticBuckets;
        var end = (bucket + 1) * AudioConstants.PicoInputBlockFrames / AudioConstants.HapticBuckets;
        var sum = 0.0;
        for (var index = start; index < end; index++)
        {
            sum += samples[index];
        }
        return (float)(sum / Math.Max(1, end - start));
    }

    private static float Lerp(float a, float b, double amount)
    {
        return (float)(a + ((b - a) * amount));
    }

    private void WriteReports()
    {
        try
        {
            TrySetThreadPriority(ThreadPriority.AboveNormal);
            var stdout = Console.OpenStandardOutput();
            var stopwatch = Stopwatch.StartNew();
            var nextWriteTicks = 0L;

            foreach (var frame in reportQueue.GetConsumingEnumerable())
            {
                var nowTicks = stopwatch.ElapsedTicks;
                if (nextWriteTicks == 0 || nowTicks - nextWriteTicks > AudioConstants.FrameIntervalTicks * 2)
                {
                    nextWriteTicks = nowTicks;
                }
                else
                {
                    WaitUntil(stopwatch, nextWriteTicks);
                }

                if (AudioConstants.DiagnosticsEnabled)
                {
                    var lateTicks = Math.Max(0, stopwatch.ElapsedTicks - nextWriteTicks);
                    if (lateTicks > 0)
                    {
                        var lateUs = lateTicks * 1000000 / Stopwatch.Frequency;
                        if (lateUs > 500)
                        {
                            writeLateEvents++;
                            if (lateUs > maxWriteLateUs)
                            {
                                maxWriteLateUs = lateUs;
                            }
                        }
                        if (lateUs > AudioConstants.WriterScheduleLateWarningUs)
                        {
                            Interlocked.Increment(ref writerScheduleLateEvents);
                            UpdateMax(ref writerScheduleLateMaxUs, lateUs);
                            LogHelperEvent("writer-schedule-late", $"lateUs={lateUs}");
                        }
                    }
                }

                if (hidStream is not null)
                {
                    if (!TryWriteFrameToHid(frame))
                    {
                        continue;
                    }
                }
                else
                {
                    WriteFrameToStdout(stdout, frame);
                }
                if (AudioConstants.DiagnosticsEnabled)
                {
                    writtenReports++;
                }
                nextWriteTicks += AudioConstants.FrameIntervalTicks;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"error: writer stopped: {error.GetType().Name}: {error.Message}");
        }
    }

    private void WriteFrameToStdout(Stream stdout, byte[] frame)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(writePrefix, (ushort)frame.Length);
        stdout.Write(writePrefix);
        stdout.Write(frame);
        stdout.Flush();
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

    private bool TryWriteFrameToHid(byte[] frame)
    {
        var sequence = frameSequence++;
        var fragmentIndex = 0;
        var fragmentCount = (frame.Length + AudioConstants.FastPayloadBytes - 1) / AudioConstants.FastPayloadBytes;
        for (var offset = 0; offset < frame.Length; offset += AudioConstants.FastPayloadBytes)
        {
            Array.Clear(hidReport);
            var payloadLength = Math.Min(AudioConstants.FastPayloadBytes, frame.Length - offset);
            hidReport[0] = AudioConstants.HostAudioStreamReportId;
            hidReport[1] = AudioConstants.FastFrameFragmentType;
            hidReport[2] = (byte)(sequence & 0xff);
            hidReport[3] = (byte)(sequence >> 8);
            hidReport[4] = (byte)fragmentIndex;
            hidReport[5] = (byte)fragmentCount;
            hidReport[6] = (byte)payloadLength;
            Buffer.BlockCopy(frame, offset, hidReport, 7, payloadLength);
            if (!TryWriteHidReport(hidReport))
            {
                return false;
            }
            if (AudioConstants.DiagnosticsEnabled)
            {
                writtenFragments++;
            }
            fragmentIndex++;
        }
        return true;
    }

    private bool TryWriteHidReport(byte[] report)
    {
        var stream = hidStream;
        if (stream is null)
        {
            return false;
        }

        try
        {
            if (!AudioConstants.DiagnosticsEnabled)
            {
                stream.Write(report, 0, report.Length);
                return true;
            }

            var start = Stopwatch.GetTimestamp();
            stream.Write(report, 0, report.Length);
            var elapsedUs = (Stopwatch.GetTimestamp() - start) * 1000000 / Stopwatch.Frequency;
            if (elapsedUs > AudioConstants.HidWriteTimeoutMilliseconds * 1000)
            {
                writeLateEvents++;
                if (elapsedUs > maxWriteLateUs)
                {
                    maxWriteLateUs = elapsedUs;
                }
            }
            if (elapsedUs > AudioConstants.HidWriteLateWarningUs)
            {
                Interlocked.Increment(ref hidWriteLateEvents);
                UpdateMax(ref hidWriteLateMaxUs, elapsedUs);
                LogHelperEvent("hid-write-late", $"elapsedUs={elapsedUs}");
            }
            return true;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"status: companion HID direct output failed: {error.GetType().Name}: {error.Message}; using stdout frame transport");
            DisableHidTransport();
            return false;
        }
    }

    private static void RaiseSchedulingPriority()
    {
        try
        {
            Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.High;
        }
        catch
        {
        }
    }

    private static void TrySetThreadPriority(ThreadPriority priority)
    {
        try
        {
            Thread.CurrentThread.Priority = priority;
        }
        catch
        {
        }
    }

    private void DisableHidTransport()
    {
        var stream = hidStream;
        hidStream = null;
        try
        {
            stream?.Dispose();
        }
        catch
        {
        }
    }

    private static void UpdateMax(ref long target, long value)
    {
        while (true)
        {
            var current = Interlocked.Read(ref target);
            if (value <= current)
            {
                return;
            }

            if (Interlocked.CompareExchange(ref target, value, current) == current)
            {
                return;
            }
        }
    }

    private void LogHelperEvent(string eventName, string details)
    {
        if (!AudioConstants.DiagnosticsEnabled)
        {
            return;
        }

        Console.Error.WriteLine(
            $"stage=helper-event {eventName} {details} queuedReports={reportQueue.Count} callbacks={Interlocked.Read(ref capturedCallbacks)} capturedFrames={Interlocked.Read(ref capturedFrames)} encodedReports={Interlocked.Read(ref encodedReports)} writtenReports={Interlocked.Read(ref writtenReports)} writtenFragments={Interlocked.Read(ref writtenFragments)}");
    }

    private void WriteDiagnostics()
    {
        while (!stopped.Wait(AudioConstants.DiagnosticsIntervalMilliseconds))
        {
            var peak = Interlocked.Exchange(ref peakSamplePermille, 0);
            var micPeak = Interlocked.Exchange(ref micPeakPermille, 0);
            var writerState = writerTask.IsFaulted ? "faulted" : writerTask.IsCompleted ? "stopped" : "running";
            Console.Error.WriteLine(
                $"stage=helper transport={(hidStream is null ? "stdout" : "hid")} writer={writerState} callbacks={Interlocked.Read(ref capturedCallbacks)} capturedFrames={Interlocked.Read(ref capturedFrames)} encodedReports={Interlocked.Read(ref encodedReports)} queuedReports={reportQueue.Count} droppedReports={Interlocked.Read(ref droppedReports)} writtenReports={Interlocked.Read(ref writtenReports)} writtenFragments={Interlocked.Read(ref writtenFragments)} writeLateEvents={Interlocked.Read(ref writeLateEvents)} maxWriteLateUs={Interlocked.Read(ref maxWriteLateUs)} captureGapMaxUs={Interlocked.Read(ref captureCallbackGapMaxUs)} captureGapOver20ms={Interlocked.Read(ref captureCallbackGapEvents)} writerScheduleLateOver8ms={Interlocked.Read(ref writerScheduleLateEvents)} writerScheduleLateMaxUs={Interlocked.Read(ref writerScheduleLateMaxUs)} hidWriteOver8ms={Interlocked.Read(ref hidWriteLateEvents)} hidWriteMaxUs={Interlocked.Read(ref hidWriteLateMaxUs)} peakPermille={peak} micCallbacks={Interlocked.Read(ref micCallbacks)} micCapturedFrames={Interlocked.Read(ref micCapturedFrames)} micPeakPermille={micPeak}");
        }
    }

    private static short FloatToInt16(float sample)
    {
        return (short)Math.Round(Math.Clamp(sample, -1, 1) * short.MaxValue);
    }

    private static int VolumePercentToPermille(int percent)
    {
        return Math.Clamp(percent, 0, 100) * 10;
    }

    private static byte FloatToInt8(float sample)
    {
        return unchecked((byte)(sbyte)Math.Round(Math.Clamp(sample, -1, 1) * sbyte.MaxValue));
    }
}

sealed record HelperOptions(
    string? DeviceName,
    string? HidPath,
    bool ListDevices,
    bool MicKeepaliveOnly,
    string? MicDeviceName,
    int SpeakerVolumePercent,
    string? TestAudioPath,
    bool PlayTestTone)
{
    public static HelperOptions Parse(string[] args)
    {
        string? deviceName = null;
        string? hidPath = null;
        string? micDeviceName = null;
        var speakerVolumePercent = 100;
        string? testAudioPath = null;
        var listDevices = false;
        var micKeepaliveOnly = false;
        var playTestTone = false;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--device-name" when index + 1 < args.Length:
                    deviceName = args[++index];
                    break;
                case "--hid-path" when index + 1 < args.Length:
                    hidPath = args[++index];
                    break;
                case "--mic-device-name" when index + 1 < args.Length:
                    micDeviceName = args[++index];
                    break;
                case "--speaker-volume" when index + 1 < args.Length:
                    if (int.TryParse(args[++index], out var parsedSpeakerVolumePercent))
                    {
                        speakerVolumePercent = parsedSpeakerVolumePercent;
                    }
                    break;
                case "--test-audio-path" when index + 1 < args.Length:
                    testAudioPath = args[++index];
                    break;
                case "--list-devices":
                    listDevices = true;
                    break;
                case "--mic-keepalive-only":
                    micKeepaliveOnly = true;
                    break;
                case "--play-test-tone":
                    playTestTone = true;
                    break;
            }
        }

        return new HelperOptions(
            deviceName,
            hidPath,
            listDevices,
            micKeepaliveOnly,
            micDeviceName,
            speakerVolumePercent,
            testAudioPath,
            playTestTone);
    }
}

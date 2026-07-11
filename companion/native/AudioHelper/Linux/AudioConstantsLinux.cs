// Linux-target twin of the AudioConstants block in Program.cs (which is
// Windows-only). Values must stay identical to the Windows helper so shared
// files (LegacyFramePacketizer) and ported DSP behave the same.
static class AudioConstants
{
    public const int TargetSampleRate = 48000;
    public const int PicoInputBlockFrames = 512;
    public const int OpusFrameSamples = 480;
    public const int OpusPacketBytes = 200;
    public const int CompactFrameBytes = 264;
    public const int HapticBuckets = 32;
    public const float HapticsGateThreshold = 0.003f;
    public const float HapticsEnvelopeAttack = 0.40f;
    public const float HapticsEnvelopeRelease = 0.025f;
    public const float HapticsGateOpenRate = 0.035f;
    public const float HapticsGateCloseRate = 0.004f;
    public const float HapticsOutputRampStep = 0.004f;
    public const byte LegacyAudioStreamReportId = 0x07;
    public const byte FastFrameFragmentType = 0x08;
    public const int FastPayloadBytes = 57;
    public const int HidReportBytes = 64;
    public static readonly bool DiagnosticsEnabled =
        Environment.GetEnvironmentVariable("DS5_BRIDGE_AUDIO_HELPER_DIAGNOSTICS") == "1";
    public static readonly long FrameIntervalTicks =
        System.Diagnostics.Stopwatch.Frequency * PicoInputBlockFrames / TargetSampleRate;
}

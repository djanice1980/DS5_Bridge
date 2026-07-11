using System.Text.Json;

// Entry point for the Linux helper build. Mirrors the mode dispatch order of
// the Windows Program.cs so the same CLI surface behaves the same way; the
// only additional mode is --uinput-keyboard (chord key injection).
static class LinuxProgram
{
    private static async Task<int> Main(string[] args)
    {
        var options = LinuxHelperOptions.Parse(args);
        try
        {
            if (options.MediaDebugClock || options.MediaSessionCommand is not null)
            {
                // Media-session integration (GSMTC on Windows) has no caller in
                // the companion app; answer with the CLI's failure shape.
                Console.Out.WriteLine(JsonSerializer.Serialize(new
                {
                    available = false,
                    error = "Media session integration is not implemented on Linux.",
                    volumePercent = 0
                }));
                return 0;
            }
            if (options.ResolveIconDataUrlPath is not null)
            {
                return LinuxIconResolver.RunResolveDataUrl(options.ResolveIconDataUrlPath);
            }
            if (options.CompanionTransport)
            {
                return await LinuxCompanionTransportServer.RunAsync();
            }
            if (options.PlayTestTone)
            {
                LinuxTestPlayback.PlayTestTone(options);
                return 0;
            }
            if (options.PlayTestHaptics)
            {
                LinuxTestPlayback.PlayTestHaptics(options);
                return 0;
            }
            if (options.MonitorAudioSessions)
            {
                return LinuxAudioSessionMonitor.Run();
            }
            if (options.ListDevices)
            {
                LinuxEndpointManager.ListDevices();
                return 0;
            }
            if (options.DefaultRenderStatus)
            {
                LinuxEndpointManager.PrintDefaultRenderStatus();
                return 0;
            }
            if (options.SetDefaultRenderBridge)
            {
                LinuxEndpointManager.SetDefaultRenderBridge();
                return 0;
            }
            if (options.UinputKeyboard)
            {
                return LinuxUinputKeyboard.Run();
            }
            if (options.MicKeepaliveOnly)
            {
                return LinuxMicKeepalive.Run();
            }
            if (options.HapticsOnly)
            {
                return LinuxHapticsMirror.Run(options);
            }

            Console.Error.WriteLine(
                "error: The streaming audio helper mode is not used on Linux; the firmware ingests UAC audio directly.");
            return 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"error: {error.Message}");
            return 1;
        }
    }
}

// CLI surface compatible with HelperOptions.Parse in the Windows Program.cs
// (unknown flags are tolerated so both helpers accept the same spawns).
sealed class LinuxHelperOptions
{
    public bool CompanionTransport;
    public bool PlayTestTone;
    public bool PlayTestHaptics;
    public bool MonitorAudioSessions;
    public bool ListDevices;
    public bool DefaultRenderStatus;
    public bool SetDefaultRenderBridge;
    public bool MicKeepaliveOnly;
    public bool UinputKeyboard;
    public bool HapticsOnly;
    public bool StdoutOnly;
    public bool MediaDebugClock;
    public string? MediaSessionCommand;
    public string? ResolveIconDataUrlPath;
    public string? BridgePersona;
    public string? DeviceName;
    public string? MicDeviceName;
    public string? TestAudioPath;
    public string? Source;
    public int SpeakerVolumePercent = 100;
    public int HapticsGainPercent = 100;
    public int HapticsBassFocus = 1;
    public int HapticsResponse = 1;
    public int HapticsAttack = 1;
    public int HapticsRelease = 1;
    public int? AppProcessId;
    public string? AppProcessPath;
    public string? AppExecutableName;

    public static LinuxHelperOptions Parse(string[] args)
    {
        var options = new LinuxHelperOptions();
        for (var index = 0; index < args.Length; index++)
        {
            var argument = args[index];
            switch (argument)
            {
                case "--companion-transport":
                    options.CompanionTransport = true;
                    break;
                case "--play-test-tone":
                    options.PlayTestTone = true;
                    break;
                case "--play-test-haptics":
                    options.PlayTestHaptics = true;
                    break;
                case "--monitor-audio-sessions":
                    options.MonitorAudioSessions = true;
                    break;
                case "--list-devices":
                    options.ListDevices = true;
                    break;
                case "--default-render-status":
                    options.DefaultRenderStatus = true;
                    break;
                case "--set-default-render-bridge":
                    options.SetDefaultRenderBridge = true;
                    break;
                case "--mic-keepalive-only":
                    options.MicKeepaliveOnly = true;
                    break;
                case "--uinput-keyboard":
                    options.UinputKeyboard = true;
                    break;
                case "--haptics-only":
                    options.HapticsOnly = true;
                    break;
                case "--stdout-only":
                    options.StdoutOnly = true;
                    break;
                case "--media-debug-clock":
                    options.MediaDebugClock = true;
                    break;
                case "--media-session":
                    options.MediaSessionCommand = NextValue(args, ref index);
                    break;
                case "--resolve-icon-data-url":
                    options.ResolveIconDataUrlPath = NextValue(args, ref index);
                    break;
                case "--bridge-persona":
                    options.BridgePersona = NextValue(args, ref index);
                    break;
                case "--device-name":
                    options.DeviceName = NextValue(args, ref index);
                    break;
                case "--mic-device-name":
                    options.MicDeviceName = NextValue(args, ref index);
                    break;
                case "--test-audio-path":
                    options.TestAudioPath = NextValue(args, ref index);
                    break;
                case "--source":
                    options.Source = NextValue(args, ref index);
                    break;
                case "--speaker-volume":
                    options.SpeakerVolumePercent = ParseInt(NextValue(args, ref index), 0, 100, 100);
                    break;
                case "--haptics-gain":
                    options.HapticsGainPercent = ParseInt(NextValue(args, ref index), 0, 200, 100);
                    break;
                case "--haptics-bass-focus":
                    options.HapticsBassFocus = ParseHapticsBassFocus(NextValue(args, ref index));
                    break;
                case "--haptics-response":
                    options.HapticsResponse = ParseHapticsResponse(NextValue(args, ref index));
                    break;
                case "--haptics-attack":
                    options.HapticsAttack = ParseHapticsAttack(NextValue(args, ref index));
                    break;
                case "--haptics-release":
                    options.HapticsRelease = ParseHapticsRelease(NextValue(args, ref index));
                    break;
                case "--haptics-app-process-id":
                    {
                        var value = NextValue(args, ref index);
                        options.AppProcessId = int.TryParse(value, out var processId) && processId > 0 ? processId : null;
                        break;
                    }
                case "--haptics-app-process-path":
                    options.AppProcessPath = NextValue(args, ref index);
                    break;
                case "--haptics-app-executable":
                    options.AppExecutableName = NextValue(args, ref index);
                    break;
                default:
                    // Tolerate Windows-only flags (frame dumps, hid paths...)
                    // so shared spawn sites never crash the Linux helper.
                    break;
            }
        }
        return options;
    }

    private static string? NextValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length)
        {
            return null;
        }
        index++;
        return args[index];
    }

    private static int ParseInt(string? value, int min, int max, int fallback)
    {
        return int.TryParse(value, out var parsed) ? Math.Clamp(parsed, min, max) : fallback;
    }

    // Word -> mode mappings match HelperOptions in the Windows Program.cs.
    public static int ParseHapticsBassFocus(string? value) => value?.ToLowerInvariant() switch
    {
        "deep" => 0,
        "punchy" => 2,
        "wide" => 3,
        _ => 1
    };

    public static int ParseHapticsResponse(string? value) => value?.ToLowerInvariant() switch
    {
        "subtle" => 0,
        "strong" => 2,
        _ => 1
    };

    public static int ParseHapticsAttack(string? value) => value?.ToLowerInvariant() switch
    {
        "soft" => 0,
        "fast" => 2,
        "sharp" => 3,
        _ => 1
    };

    public static int ParseHapticsRelease(string? value) => value?.ToLowerInvariant() switch
    {
        "tight" => 0,
        "smooth" => 2,
        "long" => 3,
        _ => 1
    };
}

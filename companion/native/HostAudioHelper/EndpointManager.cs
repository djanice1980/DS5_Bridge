using NAudio.CoreAudioApi;

sealed class EndpointManager
{
    private static readonly string[] RawPcmEndpointNames =
    [
        "DS5 Bridge Raw PCM"
    ];

    private static readonly string[] BridgeEndpointAliases =
    [
        "DS5 Bridge",
        "DualSense Wireless Controller"
    ];

    public static MMDevice SelectRenderEndpoint(MMDeviceEnumerator enumerator, string? deviceName)
    {
        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .ToArray();

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            return SelectNamedEndpoint(devices, deviceName, "Render");
        }

        var bridge = FindKnownBridgeEndpoint(devices);
        if (bridge is not null)
        {
            return bridge;
        }

        return enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    }

    public static MMDevice SelectCaptureEndpoint(MMDeviceEnumerator enumerator, string? deviceName)
    {
        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
            .ToArray();

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            return SelectNamedEndpoint(devices, deviceName, "Capture");
        }

        var bridge = FindKnownBridgeEndpoint(devices);
        if (bridge is not null)
        {
            return bridge;
        }

        return enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
    }

    public static MMDevice SelectRawPcmCaptureEndpoint(MMDeviceEnumerator enumerator, string? deviceName)
    {
        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
            .ToArray();

        var exactRawPcm = SelectNamedRawPcmEndpoint(devices, deviceName)
            ?? SelectNamedRawPcmEndpoint(devices, RawPcmEndpointNames[0]);
        if (exactRawPcm is not null)
        {
            return exactRawPcm;
        }

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            var named = SelectPreferredNamedCaptureEndpoint(devices, deviceName, IsRawPcmEndpoint, allowFallback: false);
            if (named is not null)
            {
                return named;
            }
        }

        var bridge = SelectPreferredBridgeCaptureEndpoint(devices, IsRawPcmEndpoint, allowFallback: false);
        if (bridge is not null)
        {
            return bridge;
        }

        var target = string.IsNullOrWhiteSpace(deviceName)
            ? string.Join("' or '", RawPcmEndpointNames)
            : deviceName;
        var available = string.Join(", ", devices.Select(device => $"'{device.FriendlyName}'"));
        throw new InvalidOperationException(
            $"Raw PCM capture endpoint matching '{target}' was not found. Available capture endpoints: {available}");
    }

    public static MMDevice SelectMicCaptureEndpoint(MMDeviceEnumerator enumerator, string? deviceName)
    {
        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
            .ToArray();

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            var named = SelectPreferredNamedCaptureEndpoint(devices, deviceName, IsMicEndpoint);
            if (named is not null)
            {
                return named;
            }
        }

        var bridge = SelectPreferredBridgeCaptureEndpoint(devices, IsMicEndpoint);
        if (bridge is not null)
        {
            return bridge;
        }

        return SelectCaptureEndpoint(enumerator, deviceName);
    }

    public static MMDevice? FindKnownBridgeEndpoint(IEnumerable<MMDevice> devices)
    {
        foreach (var name in BridgeEndpointAliases)
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

    public static void ListDevices()
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

    private static MMDevice SelectNamedEndpoint(MMDevice[] devices, string deviceName, string role)
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
        throw new InvalidOperationException($"{role} endpoint matching '{deviceName}' was not found. Available endpoints: {available}");
    }

    private static MMDevice? SelectPreferredNamedCaptureEndpoint(
        MMDevice[] devices,
        string deviceName,
        Func<MMDevice, bool> preferred,
        bool allowFallback = true)
    {
        var matches = devices
            .Where(device =>
                string.Equals(device.FriendlyName, deviceName, StringComparison.OrdinalIgnoreCase)
                || device.FriendlyName.Contains(deviceName, StringComparison.OrdinalIgnoreCase)
                || (deviceName.Contains("DS5 Bridge", StringComparison.OrdinalIgnoreCase)
                    && IsKnownBridgeEndpoint(device)))
            .ToArray();

        return SelectPreferredEndpoint(matches, preferred, allowFallback);
    }

    private static MMDevice? SelectNamedRawPcmEndpoint(MMDevice[] devices, string? deviceName)
    {
        if (string.IsNullOrWhiteSpace(deviceName))
        {
            return null;
        }

        var exact = devices.FirstOrDefault(device =>
            IsRawPcmEndpoint(device)
            && string.Equals(device.FriendlyName, deviceName, StringComparison.OrdinalIgnoreCase));
        if (exact is not null)
        {
            return exact;
        }

        return devices.FirstOrDefault(device =>
            IsRawPcmEndpoint(device)
            && device.FriendlyName.Contains(deviceName, StringComparison.OrdinalIgnoreCase));
    }

    private static MMDevice? SelectPreferredBridgeCaptureEndpoint(
        MMDevice[] devices,
        Func<MMDevice, bool> preferred,
        bool allowFallback = true)
    {
        foreach (var name in BridgeEndpointAliases)
        {
            var matches = devices
                .Where(device => device.FriendlyName.Contains(name, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            var preferredEndpoint = SelectPreferredEndpoint(matches, preferred, allowFallback);
            if (preferredEndpoint is not null)
            {
                return preferredEndpoint;
            }
        }

        return null;
    }

    private static MMDevice? SelectPreferredEndpoint(MMDevice[] devices, Func<MMDevice, bool> preferred, bool allowFallback)
    {
        var preferredEndpoint = devices.FirstOrDefault(preferred);
        if (preferredEndpoint is not null)
        {
            return preferredEndpoint;
        }

        return allowFallback ? devices.FirstOrDefault() : null;
    }

    private static bool IsKnownBridgeEndpoint(MMDevice device)
    {
        return BridgeEndpointAliases.Any(alias =>
            device.FriendlyName.Contains(alias, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsRawPcmEndpoint(MMDevice device)
    {
        return device.FriendlyName.Contains("Raw PCM", StringComparison.OrdinalIgnoreCase)
            || device.FriendlyName.Contains("Line", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsMicEndpoint(MMDevice device)
    {
        return device.FriendlyName.Contains("Microphone", StringComparison.OrdinalIgnoreCase)
            || device.FriendlyName.Contains("Headset", StringComparison.OrdinalIgnoreCase);
    }
}

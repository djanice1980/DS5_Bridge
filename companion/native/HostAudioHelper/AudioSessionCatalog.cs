using System.Diagnostics;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

sealed record AudioSessionInfo(
    int ProcessId,
    string DisplayName,
    string? ExecutableName,
    string? ProcessPath,
    string? IconPath,
    string? SessionIdentifier,
    string? SessionInstanceIdentifier,
    string State,
    string EndpointName,
    bool IsSelected);

static class AudioSessionCatalog
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    public static void WriteJson(int? selectedProcessId, string? selectedPath, string? selectedExecutableName)
    {
        using var enumerator = new MMDeviceEnumerator();
        var sessions = List(enumerator, selectedProcessId, selectedPath, selectedExecutableName);
        Console.Out.WriteLine(JsonSerializer.Serialize(sessions, JsonOptions));
    }

    public static AudioSessionInfo? ResolveAppSession(int? processId, string? processPath, string? executableName)
    {
        if (processId is > 0)
        {
            var liveProcess = TryGetProcessInfo(processId.Value);
            if (liveProcess is not null && ProcessInfoMatches(liveProcess, processPath, executableName))
            {
                return new AudioSessionInfo(
                    processId.Value,
                    liveProcess.DisplayName,
                    liveProcess.ExecutableName,
                    liveProcess.ProcessPath,
                    null,
                    null,
                    null,
                    "running",
                    "Process",
                    true);
            }
        }

        using var enumerator = new MMDeviceEnumerator();
        var sessionMatch = List(enumerator, null, processPath, executableName)
            .Where(session => SessionMatches(session, null, processPath, executableName))
            .OrderByDescending(session => session.State.Equals("active", StringComparison.OrdinalIgnoreCase))
            .ThenBy(session => session.DisplayName, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (sessionMatch is not null)
        {
            return sessionMatch;
        }

        return FindRunningProcess(processPath, executableName);
    }

    private static IReadOnlyList<AudioSessionInfo> List(
        MMDeviceEnumerator enumerator,
        int? selectedProcessId,
        string? selectedPath,
        string? selectedExecutableName)
    {
        var sessions = new Dictionary<string, AudioSessionInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var endpoint in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            SessionCollection? collection = null;
            try
            {
                collection = endpoint.AudioSessionManager.Sessions;
                for (var index = 0; index < collection.Count; index++)
                {
                    var session = collection[index];
                    var processId = unchecked((int)session.GetProcessID);
                    if (processId <= 0 || session.IsSystemSoundsSession)
                    {
                        continue;
                    }

                    var process = TryGetProcessInfo(processId);
                    var executableName = process?.ExecutableName;
                    var processPath = process?.ProcessPath;
                    var displayName = FirstNonBlank(
                        session.DisplayName,
                        process?.DisplayName,
                        executableName,
                        $"Process {processId}");
                    var info = new AudioSessionInfo(
                        processId,
                        displayName,
                        executableName,
                        processPath,
                        EmptyToNull(session.IconPath),
                        EmptyToNull(session.GetSessionIdentifier),
                        EmptyToNull(session.GetSessionInstanceIdentifier),
                        SessionStateName(session.State),
                        endpoint.FriendlyName,
                        false);
                    info = info with
                    {
                        IsSelected = SessionMatches(info, selectedProcessId, selectedPath, selectedExecutableName)
                    };

                    var key = SessionStableKey(info);
                    if (!sessions.TryGetValue(key, out var existing)
                        || SessionRank(info) > SessionRank(existing))
                    {
                        sessions[key] = info;
                    }
                }
            }
            catch (Exception error)
            {
                if (AudioConstants.DiagnosticsEnabled)
                {
                    Console.Error.WriteLine(
                        $"status: audio-session-list-unavailable endpoint='{EscapeStatusValue(endpoint.FriendlyName)}' error='{EscapeStatusValue(error.Message)}'");
                }
            }
        }

        return sessions.Values
            .OrderByDescending(session => session.IsSelected)
            .ThenByDescending(session => session.State.Equals("active", StringComparison.OrdinalIgnoreCase))
            .ThenBy(session => session.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(session => session.ProcessId)
            .ToArray();
    }

    private static int SessionRank(AudioSessionInfo session)
    {
        var rank = 0;
        if (session.State.Equals("active", StringComparison.OrdinalIgnoreCase)) rank += 4;
        if (!string.IsNullOrWhiteSpace(session.ProcessPath)) rank += 2;
        if (!string.IsNullOrWhiteSpace(session.IconPath)) rank += 1;
        return rank;
    }

    private static bool SessionMatches(
        AudioSessionInfo session,
        int? selectedProcessId,
        string? selectedPath,
        string? selectedExecutableName)
    {
        if (selectedProcessId is > 0 && session.ProcessId == selectedProcessId.Value)
        {
            return true;
        }
        if (!string.IsNullOrWhiteSpace(selectedPath)
            && !string.IsNullOrWhiteSpace(session.ProcessPath)
            && string.Equals(session.ProcessPath, selectedPath, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        if (!string.IsNullOrWhiteSpace(selectedExecutableName)
            && !string.IsNullOrWhiteSpace(session.ExecutableName)
            && string.Equals(session.ExecutableName, selectedExecutableName, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return false;
    }

    private static AudioSessionInfo? FindRunningProcess(string? processPath, string? executableName)
    {
        if (string.IsNullOrWhiteSpace(processPath) && string.IsNullOrWhiteSpace(executableName))
        {
            return null;
        }

        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                var info = TryGetProcessInfo(process.Id);
                if (info is null || !ProcessInfoMatches(info, processPath, executableName))
                {
                    continue;
                }
                return new AudioSessionInfo(
                    process.Id,
                    info.DisplayName,
                    info.ExecutableName,
                    info.ProcessPath,
                    null,
                    null,
                    null,
                    "running",
                    "Process",
                    true);
            }
        }

        return null;
    }

    private static bool ProcessInfoMatches(ProcessInfo info, string? processPath, string? executableName)
    {
        if (!string.IsNullOrWhiteSpace(processPath)
            && !string.IsNullOrWhiteSpace(info.ProcessPath)
            && !string.Equals(info.ProcessPath, processPath, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        if (!string.IsNullOrWhiteSpace(executableName)
            && !string.IsNullOrWhiteSpace(info.ExecutableName)
            && !string.Equals(info.ExecutableName, executableName, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        return true;
    }

    private static string SessionStableKey(AudioSessionInfo session)
    {
        if (!string.IsNullOrWhiteSpace(session.ProcessPath))
        {
            return $"path:{session.ProcessPath}";
        }
        if (!string.IsNullOrWhiteSpace(session.ExecutableName))
        {
            return $"exe:{session.ExecutableName}";
        }
        return $"pid:{session.ProcessId}";
    }

    private static ProcessInfo? TryGetProcessInfo(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            var processPath = TryGetProcessPath(process);
            var executableName = !string.IsNullOrWhiteSpace(processPath)
                ? Path.GetFileName(processPath)
                : TryGetProcessName(process);
            var displayName = FirstNonBlank(
                TryGetFileDescription(process),
                process.MainWindowTitle,
                Path.GetFileNameWithoutExtension(executableName),
                process.ProcessName,
                $"Process {processId}");
            return new ProcessInfo(displayName, executableName, processPath);
        }
        catch
        {
            return null;
        }
    }

    private static string? TryGetProcessPath(Process process)
    {
        try
        {
            return EmptyToNull(process.MainModule?.FileName);
        }
        catch
        {
            return null;
        }
    }

    private static string? TryGetProcessName(Process process)
    {
        try
        {
            return EmptyToNull(process.ProcessName);
        }
        catch
        {
            return null;
        }
    }

    private static string? TryGetFileDescription(Process process)
    {
        try
        {
            var fileName = process.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return null;
            }
            return EmptyToNull(FileVersionInfo.GetVersionInfo(fileName).FileDescription);
        }
        catch
        {
            return null;
        }
    }

    private static string SessionStateName(AudioSessionState state)
    {
        return state switch
        {
            AudioSessionState.AudioSessionStateActive => "active",
            AudioSessionState.AudioSessionStateInactive => "inactive",
            AudioSessionState.AudioSessionStateExpired => "expired",
            _ => state.ToString()
        };
    }

    private static string FirstNonBlank(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }
        return "Unknown";
    }

    private static string? EmptyToNull(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string EscapeStatusValue(string value)
    {
        return value.Replace("\\", "\\\\").Replace("'", "\\'");
    }

    private sealed record ProcessInfo(string DisplayName, string? ExecutableName, string? ProcessPath);
}

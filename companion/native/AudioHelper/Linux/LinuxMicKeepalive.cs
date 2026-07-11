using System.Diagnostics;

// Holds the bridge's UAC microphone stream open so the dongle keeps the
// controller mic clocked — same purpose as the WASAPI keepalive on Windows.
static class LinuxMicKeepalive
{
    public static int Run()
    {
        PipeWireNode? source;
        try
        {
            var snapshot = PipeWireAudio.Query();
            source = LinuxEndpointManager.SelectBridgeSource(snapshot);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"error: mic keepalive failed: {error.Message}");
            return 1;
        }

        if (source is null)
        {
            Console.Error.WriteLine("error: mic keepalive capture endpoint was not found");
            return 1;
        }

        Process capture;
        try
        {
            capture = PipeWireAudio.StartCapture(source.Name, captureSink: false, channels: 1);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"error: mic keepalive failed: {error.Message}");
            return 1;
        }

        Console.Error.WriteLine($"status: mic keepalive started device='{StatusText.Escape(source.Description)}'");

        using var stopRequested = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stopRequested.Set();
        };
        var stdinThread = new Thread(() =>
        {
            while (Console.In.ReadLine() is not null)
            {
                // Drain until EOF; the parent closing stdin means stop.
            }
            stopRequested.Set();
        })
        {
            IsBackground = true
        };
        stdinThread.Start();

        var drainThread = new Thread(() =>
        {
            var buffer = new byte[4096];
            try
            {
                var stream = capture.StandardOutput.BaseStream;
                while (stream.Read(buffer, 0, buffer.Length) > 0)
                {
                    // Discard: the open stream is the point.
                }
            }
            catch
            {
                // Stream closed.
            }
            stopRequested.Set();
        })
        {
            IsBackground = true
        };
        drainThread.Start();

        stopRequested.Wait();
        try
        {
            if (!capture.HasExited)
            {
                capture.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort.
        }
        Console.Error.WriteLine("status: mic keepalive stopped");
        return 0;
    }
}

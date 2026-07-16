using System.Runtime.InteropServices;
using System.Text;

// Linux only: grabs the DualSense touchpad's evdev node (EVIOCGRAB) so it stops
// acting as a system mouse/pointer for the desktop and games. The grab is held
// until the parent closes stdin (or SIGINT), which releases it and restores the
// touchpad. Polls once a second so it re-grabs across controller reconnects.
//
// Needs read access to the touchpad's /dev/input/event* node, granted by the
// uaccess rule in packaging/linux/60-ds5bridge.rules. errno 13 (EACCES) on open
// means that rule is missing; errno 16 (EBUSY) on grab means another client
// (e.g. Steam Input) already holds the touchpad.
static class LinuxTouchpadInhibitor
{
    private const int O_RDONLY = 0;
    private const int O_NONBLOCK = 0x800;
    private const ushort SonyVendor = 0x054C;

    // DualSense, DualSense Edge, DS4 personas — the bridge personas with a touchpad.
    private static readonly ushort[] TouchpadProducts = { 0x0CE6, 0x0DF2, 0x09CC };

    // evdev ioctl request codes.
    //   EVIOCGRAB    = _IOW('E', 0x90, int)          grab/ungrab exclusive access
    //   EVIOCGID     = _IOR('E', 0x02, input_id[8])  bus/vendor/product/version
    //   EVIOCGNAME(n)= _IOC(_IOC_READ,'E',0x06,n)    device name string
    private static readonly nuint EVIOCGRAB = (nuint)(0x40000000u | ((uint)sizeof(int) << 16) | (0x45u << 8) | 0x90u);
    private static readonly nuint EVIOCGID = (nuint)(0x80000000u | (8u << 16) | (0x45u << 8) | 0x02u);
    private static nuint EviocgName(int length) => (nuint)(0x80000000u | ((uint)length << 16) | (0x45u << 8) | 0x06u);

    public static int Run()
    {
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

        Console.Error.WriteLine("status: touchpad-inhibit started");

        int grabbedFd = -1;
        string grabbedPath = string.Empty;
        string lastWaitNote = string.Empty;
        try
        {
            while (!stopRequested.IsSet)
            {
                if (grabbedFd >= 0)
                {
                    // Release the grab if the controller went away (node removed); the
                    // next scan will re-grab a fresh node when it reconnects.
                    if (!File.Exists(grabbedPath))
                    {
                        Libc.close(grabbedFd);
                        grabbedFd = -1;
                        grabbedPath = string.Empty;
                        lastWaitNote = string.Empty;
                        Console.Error.WriteLine("status: touchpad-inhibit released reason=device-gone");
                    }
                    else
                    {
                        stopRequested.Wait(1000);
                        continue;
                    }
                }

                var (fd, path, note) = TryGrabTouchpad();
                if (fd >= 0)
                {
                    grabbedFd = fd;
                    grabbedPath = path;
                    lastWaitNote = string.Empty;
                    Console.Error.WriteLine($"status: touchpad-inhibit grabbed device='{note}'");
                }
                else if (note.Length > 0 && note != lastWaitNote)
                {
                    lastWaitNote = note;
                    Console.Error.WriteLine($"status: touchpad-inhibit waiting reason={note}");
                }

                stopRequested.Wait(1000);
            }
        }
        finally
        {
            if (grabbedFd >= 0)
            {
                Libc.ioctl(grabbedFd, EVIOCGRAB, 0);
                Libc.close(grabbedFd);
            }
        }

        Console.Error.WriteLine("status: touchpad-inhibit stopped");
        return 0;
    }

    private static (int fd, string path, string note) TryGrabTouchpad()
    {
        string[] nodes;
        try
        {
            nodes = Directory.GetFiles("/dev/input", "event*");
        }
        catch (Exception error)
        {
            return (-1, string.Empty, $"enumerate-failed:{error.Message}");
        }

        string lastNote = "not-found";
        foreach (var path in nodes)
        {
            int fd = Libc.open(path, O_RDONLY | O_NONBLOCK);
            if (fd < 0)
            {
                lastNote = $"open-denied-errno-{Marshal.GetLastPInvokeError()}";
                continue;
            }

            if (!IsDualSenseTouchpad(fd))
            {
                Libc.close(fd);
                continue;
            }

            if (Libc.ioctl(fd, EVIOCGRAB, 1) == 0)
            {
                return (fd, path, ReadName(fd));
            }

            lastNote = $"grab-busy-errno-{Marshal.GetLastPInvokeError()}";
            Libc.close(fd);
        }

        return (-1, string.Empty, lastNote);
    }

    private static bool IsDualSenseTouchpad(int fd)
    {
        var id = new InputId();
        if (Libc.ioctl(fd, EVIOCGID, ref id) < 0)
        {
            return false;
        }
        if (id.vendor != SonyVendor || Array.IndexOf(TouchpadProducts, id.product) < 0)
        {
            return false;
        }
        // Both the gamepad and the touchpad share the DualSense VID/PID; only the
        // touchpad node carries "Touchpad" in its evdev name.
        return ReadName(fd).Contains("Touchpad", StringComparison.OrdinalIgnoreCase);
    }

    private static string ReadName(int fd)
    {
        var buffer = new byte[256];
        int length = Libc.ioctl(fd, EviocgName(buffer.Length), buffer);
        if (length <= 0)
        {
            return string.Empty;
        }
        int end = Array.IndexOf(buffer, (byte)0, 0, Math.Min(length, buffer.Length));
        if (end < 0)
        {
            end = Math.Min(length, buffer.Length);
        }
        return Encoding.UTF8.GetString(buffer, 0, end);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct InputId
    {
        public ushort bustype;
        public ushort vendor;
        public ushort product;
        public ushort version;
    }

    private static class Libc
    {
        [DllImport("libc", SetLastError = true)]
        public static extern int open(string path, int flags);

        [DllImport("libc", SetLastError = true)]
        public static extern int close(int fd);

        [DllImport("libc", SetLastError = true)]
        public static extern int ioctl(int fd, nuint request, int argument);

        [DllImport("libc", SetLastError = true)]
        public static extern int ioctl(int fd, nuint request, byte[] argument);

        [DllImport("libc", SetLastError = true)]
        public static extern int ioctl(int fd, nuint request, ref InputId argument);
    }
}

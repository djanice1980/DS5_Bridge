using System.Runtime.InteropServices;

// Persistent /dev/uinput virtual keyboard for chord key injection.
//
// Protocol with the Electron main process:
//   stderr "status: uinput-ready" once the device is registered
//   stderr "status: uinput-unavailable reason=..." + exit 1 on failure
//   stdin  "keys <vk>,<vk>,..." -> press in order, 20 ms, release in reverse
//   stdout "ok" per request, or "error: <message>"
//   stdin EOF -> destroy device, exit 0
//
// Key codes on the wire are Windows virtual-key codes — the companion app's
// internal key currency — mapped to evdev here so the TS side stays identical
// across platforms.
static class LinuxUinputKeyboard
{
    private const int KeyHoldMilliseconds = 20;
    private const int DeviceSettleMilliseconds = 250;

    private const int EvSyn = 0x00;
    private const int EvKey = 0x01;
    private const int SynReport = 0;

    private const int OWronly = 0x0001;
    private const int ONonblock = 0x0800;

    public static int Run()
    {
        int fd;
        try
        {
            fd = CreateKeyboardDevice();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"status: uinput-unavailable reason='{error.Message.Replace('\'', ' ')}'");
            return 1;
        }

        // Give the compositor a moment to pick the new device up before
        // declaring readiness; without this the first chord can be dropped.
        Thread.Sleep(DeviceSettleMilliseconds);
        Console.Error.WriteLine("status: uinput-ready");

        try
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }
                try
                {
                    HandleRequest(fd, trimmed);
                    Console.Out.WriteLine("ok");
                }
                catch (Exception error)
                {
                    Console.Out.WriteLine($"error: {error.Message}");
                }
                Console.Out.Flush();
            }
        }
        finally
        {
            DestroyKeyboardDevice(fd);
        }
        return 0;
    }

    private static void HandleRequest(int fd, string line)
    {
        if (!line.StartsWith("keys ", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Unknown request '{line}'.");
        }

        var codes = new List<int>();
        foreach (var part in line[5..].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!int.TryParse(part, out var virtualKey))
            {
                throw new InvalidOperationException($"Invalid key code '{part}'.");
            }
            if (!VirtualKeyToEvdev.TryGetValue(virtualKey, out var evdevCode))
            {
                throw new InvalidOperationException($"Unsupported key code {virtualKey}.");
            }
            codes.Add(evdevCode);
        }

        if (codes.Count == 0)
        {
            return;
        }

        foreach (var code in codes)
        {
            EmitKey(fd, code, pressed: true);
        }
        Thread.Sleep(KeyHoldMilliseconds);
        for (var index = codes.Count - 1; index >= 0; index--)
        {
            EmitKey(fd, codes[index], pressed: false);
        }
    }

    private static int CreateKeyboardDevice()
    {
        var fd = Libc.open("/dev/uinput", OWronly | ONonblock);
        if (fd < 0)
        {
            var errno = Marshal.GetLastPInvokeError();
            throw new IOException(errno == 13
                ? "permission denied opening /dev/uinput (install the DS5 Bridge udev rules)"
                : $"failed to open /dev/uinput (errno {errno})");
        }

        try
        {
            IoctlOrThrow(fd, UiSetEvbit, EvKey, "UI_SET_EVBIT EV_KEY");
            IoctlOrThrow(fd, UiSetEvbit, EvSyn, "UI_SET_EVBIT EV_SYN");
            foreach (var evdevCode in VirtualKeyToEvdev.Values.Distinct())
            {
                IoctlOrThrow(fd, UiSetKeybit, evdevCode, "UI_SET_KEYBIT");
            }

            var setup = new UinputSetup
            {
                id = new InputId
                {
                    bustype = 0x06, // BUS_VIRTUAL
                    vendor = 0x054C,
                    product = 0x0CE6,
                    version = 1
                },
                ff_effects_max = 0
            };
            var name = "DS5 Bridge Chord Keyboard"u8;
            unsafe
            {
                for (var index = 0; index < name.Length && index < 79; index++)
                {
                    setup.name[index] = name[index];
                }
            }

            if (Libc.ioctl(fd, UiDevSetup, ref setup) < 0)
            {
                throw new IOException($"UI_DEV_SETUP failed (errno {Marshal.GetLastPInvokeError()})");
            }
            if (Libc.ioctl(fd, UiDevCreate, IntPtr.Zero) < 0)
            {
                throw new IOException($"UI_DEV_CREATE failed (errno {Marshal.GetLastPInvokeError()})");
            }
            return fd;
        }
        catch
        {
            _ = Libc.close(fd);
            throw;
        }
    }

    private static void DestroyKeyboardDevice(int fd)
    {
        _ = Libc.ioctl(fd, UiDevDestroy, IntPtr.Zero);
        _ = Libc.close(fd);
    }

    private static void EmitKey(int fd, int code, bool pressed)
    {
        WriteEvent(fd, EvKey, code, pressed ? 1 : 0);
        WriteEvent(fd, EvSyn, SynReport, 0);
    }

    private static void WriteEvent(int fd, int type, int code, int value)
    {
        var inputEvent = new InputEvent
        {
            type = (ushort)type,
            code = (ushort)code,
            value = value
        };
        var size = Marshal.SizeOf<InputEvent>();
        var written = Libc.write(fd, ref inputEvent, (nuint)size);
        if (written != size)
        {
            throw new IOException($"uinput write failed (errno {Marshal.GetLastPInvokeError()})");
        }
    }

    private static void IoctlOrThrow(int fd, nuint request, int argument, string label)
    {
        if (Libc.ioctl(fd, request, argument) < 0)
        {
            throw new IOException($"{label} failed (errno {Marshal.GetLastPInvokeError()})");
        }
    }

    // _IOW('U', nr, size) and _IO('U', nr) request codes.
    private static nuint Iow(int number, int size) => (nuint)(0x40000000u | ((uint)size << 16) | (0x55u << 8) | (uint)number);
    private static nuint Io(int number) => (nuint)((0x55u << 8) | (uint)number);

    private static readonly nuint UiSetEvbit = Iow(100, sizeof(int));
    private static readonly nuint UiSetKeybit = Iow(101, sizeof(int));
    private static readonly nuint UiDevSetup = Iow(3, Marshal.SizeOf<UinputSetup>());
    private static readonly nuint UiDevCreate = Io(1);
    private static readonly nuint UiDevDestroy = Io(2);

    [StructLayout(LayoutKind.Sequential)]
    private struct InputId
    {
        public ushort bustype;
        public ushort vendor;
        public ushort product;
        public ushort version;
    }

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct UinputSetup
    {
        public InputId id;
        public fixed byte name[80];
        public uint ff_effects_max;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct InputEvent
    {
        public nint tv_sec;
        public nint tv_usec;
        public ushort type;
        public ushort code;
        public int value;
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
        public static extern int ioctl(int fd, nuint request, IntPtr argument);

        [DllImport("libc", SetLastError = true)]
        public static extern int ioctl(int fd, nuint request, ref UinputSetup setup);

        [DllImport("libc", SetLastError = true)]
        public static extern nint write(int fd, ref InputEvent inputEvent, nuint size);
    }

    // Windows virtual-key code -> Linux evdev KEY_* code, covering the full
    // VIRTUAL_KEY_CODES table in bridge-service.ts.
    private static readonly Dictionary<int, int> VirtualKeyToEvdev = BuildVirtualKeyMap();

    private static Dictionary<int, int> BuildVirtualKeyMap()
    {
        var map = new Dictionary<int, int>
        {
            [0x08] = 14,   // BACKSPACE -> KEY_BACKSPACE
            [0x09] = 15,   // TAB -> KEY_TAB
            [0x0d] = 28,   // ENTER -> KEY_ENTER
            [0x10] = 42,   // SHIFT -> KEY_LEFTSHIFT
            [0x11] = 29,   // CTRL -> KEY_LEFTCTRL
            [0x12] = 56,   // ALT -> KEY_LEFTALT
            [0x13] = 119,  // PAUSE -> KEY_PAUSE
            [0x14] = 58,   // CAPSLOCK -> KEY_CAPSLOCK
            [0x1b] = 1,    // ESC -> KEY_ESC
            [0x20] = 57,   // SPACE -> KEY_SPACE
            [0x21] = 104,  // PAGEUP -> KEY_PAGEUP
            [0x22] = 109,  // PAGEDOWN -> KEY_PAGEDOWN
            [0x23] = 107,  // END -> KEY_END
            [0x24] = 102,  // HOME -> KEY_HOME
            [0x25] = 105,  // LEFT -> KEY_LEFT
            [0x26] = 103,  // UP -> KEY_UP
            [0x27] = 106,  // RIGHT -> KEY_RIGHT
            [0x28] = 108,  // DOWN -> KEY_DOWN
            [0x2c] = 99,   // PRINTSCREEN -> KEY_SYSRQ
            [0x2d] = 110,  // INSERT -> KEY_INSERT
            [0x2e] = 111,  // DELETE -> KEY_DELETE
            [0x5b] = 125,  // WIN -> KEY_LEFTMETA
            [0x5d] = 127,  // MENU -> KEY_COMPOSE
            [0x90] = 69,   // NUMLOCK -> KEY_NUMLOCK
            [0x91] = 70,   // SCROLLLOCK -> KEY_SCROLLLOCK
            [0xb3] = 164,  // PLAYPAUSE -> KEY_PLAYPAUSE
            [0xb0] = 163,  // NEXTTRACK -> KEY_NEXTSONG
            [0xb1] = 165,  // PREVIOUSTRACK -> KEY_PREVIOUSSONG
            [0xad] = 113,  // VOLUMEMUTE -> KEY_MUTE
            [0xaf] = 115,  // VOLUMEUP -> KEY_VOLUMEUP
            [0xae] = 114   // VOLUMEDOWN -> KEY_VOLUMEDOWN
        };

        // Letters A-Z (VK 0x41..0x5a) -> QWERTY evdev codes.
        int[] letterCodes =
        {
            30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50,
            49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44
        };
        for (var index = 0; index < 26; index++)
        {
            map[0x41 + index] = letterCodes[index];
        }

        // Digits 0-9 (VK 0x30..0x39): KEY_0 = 11, KEY_1..KEY_9 = 2..10.
        map[0x30] = 11;
        for (var digit = 1; digit <= 9; digit++)
        {
            map[0x30 + digit] = 1 + digit;
        }

        // Numpad 0-9 (VK 0x60..0x69).
        int[] numpadCodes = { 82, 79, 80, 81, 75, 76, 77, 71, 72, 73 };
        for (var digit = 0; digit <= 9; digit++)
        {
            map[0x60 + digit] = numpadCodes[digit];
        }

        // F1-F24 (VK 0x70..0x87): F1-F10 = 59..68, F11 = 87, F12 = 88, F13-F24 = 183..194.
        for (var index = 0; index < 10; index++)
        {
            map[0x70 + index] = 59 + index;
        }
        map[0x7a] = 87;
        map[0x7b] = 88;
        for (var index = 0; index < 12; index++)
        {
            map[0x7c + index] = 183 + index;
        }

        return map;
    }
}

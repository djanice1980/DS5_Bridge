using System.Runtime.InteropServices;

// libusb-1.0 twin of WinUsbBridgeTransport: same control-transfer setup packets
// (GET 0xC1/0x31, SET 0x41/0x32, wIndex = interface 5) and 64-byte bulk OUT
// writes. Discovery is VID/PID + bInterfaceNumber 5 + class 0xFF instead of
// the Windows device-interface GUIDs, which do not exist on Linux.
sealed class LinuxUsbBridgeTransport : IDisposable
{
    private const byte ControlGetReport = 0x31;
    private const byte ControlSetReport = 0x32;

    // HOST_BRIDGE_INTERFACE_NUMBER in firmware: the bridge's slot on the full composite
    // device. Companion-only ("idle") renumbers it to 0 because a configuration must number
    // its interfaces from zero -- see HOST_BRIDGE_IDLE_INTERFACE_NUMBER in host_bridge.h.
    // Never assume either one: read the number off the descriptors and carry it.
    private const int FullBridgeInterfaceNumber = 5;
    private const int IdleBridgeInterfaceNumber = 0;
    private const byte FallbackBulkOutEndpoint = 0x07; // HOST_BRIDGE_EP_OUT in firmware
    private const byte VendorInterfaceClass = 0xFF;
    private const int ReportBytes = 64;
    private const uint ControlTransferTimeoutMs = 1000;
    private const uint BridgeOutTransferTimeoutMs = 35;

    // HOST_BRIDGE_IDLE_PRODUCT_ID in firmware.
    private const ushort IdleProductId = 0x0CE7;

    // Every identity the firmware can present. The idle id is not a persona -- with no
    // controller attached the bridge enumerates as a single vendor interface under its own
    // product id, which is exactly when Pair and Forget are wanted. Omitting it here made the
    // bridge invisible to the Linux app until a controller connected.
    private static readonly (ushort Vendor, ushort Product)[] BridgeUsbIds =
    {
        (0x054C, 0x0CE6),      // DualSense
        (0x054C, 0x0DF2),      // DualSense Edge
        (0x054C, 0x09CC),      // DualShock 4
        (0x1209, 0xDB05),      // Xbox 360 persona
        (0x054C, IdleProductId) // companion-only idle enumeration
    };

    private readonly IntPtr context;
    private readonly IntPtr deviceHandle;
    private readonly byte outEndpoint;
    private readonly int interfaceNumber;
    private bool disposed;

    private LinuxUsbBridgeTransport(
        string devicePath,
        IntPtr context,
        IntPtr deviceHandle,
        int interfaceNumber,
        byte outEndpoint)
    {
        DevicePath = devicePath;
        this.context = context;
        this.deviceHandle = deviceHandle;
        this.interfaceNumber = interfaceNumber;
        this.outEndpoint = outEndpoint;
    }

    public string DevicePath { get; }

    // One entry per bridge-shaped USB device present, for the companion's device census.
    internal readonly record struct BridgeDeviceInfo(
        string Path,
        ushort VendorId,
        ushort ProductId,
        byte BusNumber,
        byte DeviceAddress,
        bool HasVendorInterface);

    // A stable identity for a physical dongle: bus plus the chain of hub ports it hangs off,
    // e.g. "usb:5-1.3". Deliberately NOT the device address, which the kernel reassigns on
    // every enumeration -- the bridge changes address each time it flips between the idle and
    // full shapes, so an address-based path would invalidate the user's saved bridge selection
    // every time they turned a controller on.
    internal static string DescribePortPath(IntPtr device)
    {
        var bus = LibUsb.libusb_get_bus_number(device);
        var ports = new byte[8];
        var count = LibUsb.libusb_get_port_numbers(device, ports, ports.Length);
        if (count <= 0)
        {
            return $"usb:{bus}-?{LibUsb.libusb_get_device_address(device)}";
        }
        return $"usb:{bus}-{string.Join(".", ports.Take(count))}";
    }

    // Every bridge-shaped device on the bus. Used by the census; does not open anything, so it
    // works even while another process holds the interface.
    internal static List<BridgeDeviceInfo> Enumerate()
    {
        var found = new List<BridgeDeviceInfo>();
        var context = IntPtr.Zero;
        try
        {
            if (LibUsb.libusb_init(ref context) < 0)
            {
                return found;
            }
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            return found;
        }

        var listPtr = IntPtr.Zero;
        try
        {
            var count = LibUsb.libusb_get_device_list(context, ref listPtr);
            for (var index = 0; index < count; index++)
            {
                var device = Marshal.ReadIntPtr(listPtr, index * IntPtr.Size);
                if (LibUsb.libusb_get_device_descriptor(device, out var descriptor) < 0)
                {
                    continue;
                }
                if (!IsBridgeUsbId(descriptor.idVendor, descriptor.idProduct))
                {
                    continue;
                }
                found.Add(new BridgeDeviceInfo(
                    DescribePortPath(device),
                    descriptor.idVendor,
                    descriptor.idProduct,
                    LibUsb.libusb_get_bus_number(device),
                    LibUsb.libusb_get_device_address(device),
                    HasVendorInterface(device)));
            }
        }
        finally
        {
            if (listPtr != IntPtr.Zero)
            {
                LibUsb.libusb_free_device_list(listPtr, 1);
            }
            LibUsb.libusb_exit(context);
        }
        return found;
    }

    // What separates a bridge from a DualSense plugged straight into the PC: both answer to
    // 054c:0ce6, but only the bridge carries the vendor-class interface with a bulk OUT.
    private static bool HasVendorInterface(IntPtr device)
    {
        if (LibUsb.libusb_get_active_config_descriptor(device, out var configPtr) < 0 || configPtr == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            return ReadInterfaces(configPtr).Any(candidate =>
                candidate.InterfaceClass == VendorInterfaceClass && candidate.BulkOutEndpoints.Count > 0);
        }
        catch
        {
            return false;
        }
        finally
        {
            LibUsb.libusb_free_config_descriptor(configPtr);
        }
    }

    public static LinuxUsbBridgeTransport Open() => Open(null);

    public static LinuxUsbBridgeTransport Open(string? preferredPath)
    {
        var context = IntPtr.Zero;
        int initResult;
        try
        {
            initResult = LibUsb.libusb_init(ref context);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            // Without this the load failure is indistinguishable from "no dongle plugged in",
            // and the two have completely different fixes.
            throw new IOException(
                "DS5 Bridge USB interface could not be opened: libusb-1.0 is not installed. "
                + "Install it (CachyOS/Arch: sudo pacman -S libusb) and restart the app.",
                error);
        }
        if (initResult < 0)
        {
            throw new IOException($"DS5 Bridge USB interface could not be opened: libusb init failed ({LibUsb.ErrorName(initResult)}).");
        }

        Exception? lastError = null;
        var listPtr = IntPtr.Zero;
        try
        {
            var count = LibUsb.libusb_get_device_list(context, ref listPtr);
            if (count < 0)
            {
                LibUsb.libusb_exit(context);
                throw new IOException($"DS5 Bridge USB interface could not be opened: device enumeration failed ({LibUsb.ErrorName((int)count)}).");
            }

            // Two passes so a saved bridge selection wins over whichever device libusb happens
            // to list first, but an unavailable selection still falls back rather than failing.
            for (var pass = 0; pass < (string.IsNullOrEmpty(preferredPath) ? 1 : 2); pass++)
            {
            var preferOnly = pass == 0 && !string.IsNullOrEmpty(preferredPath);
            for (var index = 0; index < count; index++)
            {
                var device = Marshal.ReadIntPtr(listPtr, index * IntPtr.Size);
                if (LibUsb.libusb_get_device_descriptor(device, out var descriptor) < 0)
                {
                    continue;
                }
                if (!IsBridgeUsbId(descriptor.idVendor, descriptor.idProduct))
                {
                    continue;
                }
                var portPath = DescribePortPath(device);
                if (preferOnly && !string.Equals(portPath, preferredPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    var (bridgeInterface, outEndpoint) = FindBridgeInterface(device, descriptor.idProduct);
                    var openResult = LibUsb.libusb_open(device, out var handle);
                    if (openResult < 0)
                    {
                        throw new IOException(DescribeOpenFailure(openResult, descriptor.idProduct));
                    }

                    try
                    {
                        _ = LibUsb.libusb_set_auto_detach_kernel_driver(handle, 1);
                        var claimResult = LibUsb.libusb_claim_interface(handle, bridgeInterface);
                        if (claimResult < 0)
                        {
                            throw new IOException(
                                $"USB bridge interface {bridgeInterface} claim failed: {LibUsb.ErrorName(claimResult)}.");
                        }

                        return new LinuxUsbBridgeTransport(portPath, context, handle, bridgeInterface, outEndpoint);
                    }
                    catch
                    {
                        LibUsb.libusb_close(handle);
                        throw;
                    }
                }
                catch (Exception error)
                {
                    lastError = error;
                }
            }
            }
        }
        finally
        {
            if (listPtr != IntPtr.Zero)
            {
                LibUsb.libusb_free_device_list(listPtr, 1);
            }
        }

        LibUsb.libusb_exit(context);
        throw new IOException(
            lastError is null
                ? "DS5 Bridge USB interface was not found."
                : $"DS5 Bridge USB interface could not be opened: {lastError.Message}");
    }

    public static LinuxUsbBridgeTransport? TryOpen()
    {
        try
        {
            return Open();
        }
        catch
        {
            return null;
        }
    }

    public byte[] GetReport(byte reportId)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var report = new byte[ReportBytes];
        var transferred = LibUsb.libusb_control_transfer(
            deviceHandle,
            0xC1,
            ControlGetReport,
            reportId,
            (ushort)interfaceNumber,
            report,
            ReportBytes,
            ControlTransferTimeoutMs);
        if (transferred < 0)
        {
            throw new IOException($"USB bridge GET_REPORT failed: {LibUsb.ErrorName(transferred)}.");
        }
        if (transferred != ReportBytes)
        {
            Array.Resize(ref report, transferred);
        }
        return report;
    }

    public void WriteReport(byte[] report)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (report.Length != ReportBytes)
        {
            throw new ArgumentException($"Bridge reports must be {ReportBytes} bytes.", nameof(report));
        }

        for (var attempt = 0; attempt < 2; attempt++)
        {
            var result = LibUsb.libusb_bulk_transfer(
                deviceHandle,
                outEndpoint,
                report,
                ReportBytes,
                out var transferred,
                BridgeOutTransferTimeoutMs);
            if (result == 0)
            {
                if (transferred != ReportBytes)
                {
                    throw new IOException($"USB bridge write was short: {transferred}/{ReportBytes} bytes.");
                }
                return;
            }

            if (result != LibUsb.ErrorTimeout || attempt != 0)
            {
                throw new IOException($"USB bridge write failed: {LibUsb.ErrorName(result)}.");
            }
        }
    }

    public void SetReport(byte[] report)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (report.Length != ReportBytes)
        {
            throw new ArgumentException($"Bridge reports must be {ReportBytes} bytes.", nameof(report));
        }
        var transferred = LibUsb.libusb_control_transfer(
            deviceHandle,
            0x41,
            ControlSetReport,
            report[0],
            (ushort)interfaceNumber,
            report,
            ReportBytes,
            ControlTransferTimeoutMs);
        if (transferred < 0)
        {
            throw new IOException($"USB bridge SET_REPORT failed: {LibUsb.ErrorName(transferred)}.");
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        _ = LibUsb.libusb_release_interface(deviceHandle, interfaceNumber);
        LibUsb.libusb_close(deviceHandle);
        LibUsb.libusb_exit(context);
    }

    private static bool IsBridgeUsbId(ushort vendor, ushort product)
    {
        foreach (var id in BridgeUsbIds)
        {
            if (id.Vendor == vendor && id.Product == product)
            {
                return true;
            }
        }
        return false;
    }

    private static string DescribeOpenFailure(int errorCode, ushort productId)
    {
        var name = LibUsb.ErrorName(errorCode);
        if (errorCode == LibUsb.ErrorAccess)
        {
            var idleHint = productId == IdleProductId
                ? " This is the bridge's companion-only enumeration (pid 0ce7); rules older than"
                    + " this release do not cover it, so reinstall them rather than assuming they are current."
                : string.Empty;
            return $"USB bridge open failed: {name}. Install the DS5 Bridge udev rules "
                + $"(60-ds5bridge.rules), then unplug and replug the bridge.{idleHint}";
        }
        return $"USB bridge open failed: {name}.";
    }

    // Walk the active configuration for the bridge's vendor-class (0xFF) interface and return
    // both its number and its bulk OUT endpoint.
    //
    // The number is NOT fixed. On the full composite device the bridge sits at interface 5; in
    // companion-only mode it is the only interface and therefore number 0. Hard-coding 5 made
    // libusb_claim_interface fail against an idle bridge, which surfaced as "no bridge found"
    // -- so prefer 5 when the composite device offers it, and otherwise take whichever vendor
    // interface owns a bulk OUT endpoint.
    internal static (int InterfaceNumber, byte OutEndpoint) FindBridgeInterface(IntPtr device, ushort productId)
    {
        if (LibUsb.libusb_get_active_config_descriptor(device, out var configPtr) < 0 || configPtr == IntPtr.Zero)
        {
            return (DefaultInterfaceNumberFor(productId), FallbackBulkOutEndpoint);
        }

        try
        {
            return SelectBridgeInterface(ReadInterfaces(configPtr), productId);
        }
        catch
        {
            // Fall through to the firmware defaults.
            return (DefaultInterfaceNumberFor(productId), FallbackBulkOutEndpoint);
        }
        finally
        {
            LibUsb.libusb_free_config_descriptor(configPtr);
        }
    }

    private static List<BridgeInterfaceCandidate> ReadInterfaces(IntPtr configPtr)
    {
        var candidates = new List<BridgeInterfaceCandidate>();
        var config = Marshal.PtrToStructure<LibUsb.ConfigDescriptor>(configPtr);
        var interfaceSize = Marshal.SizeOf<LibUsb.Interface>();
        var altsettingSize = Marshal.SizeOf<LibUsb.InterfaceDescriptor>();
        var endpointSize = Marshal.SizeOf<LibUsb.EndpointDescriptor>();

        for (var interfaceIndex = 0; interfaceIndex < config.bNumInterfaces; interfaceIndex++)
        {
            var iface = Marshal.PtrToStructure<LibUsb.Interface>(config.@interface + (interfaceIndex * interfaceSize));
            for (var altIndex = 0; altIndex < iface.num_altsetting; altIndex++)
            {
                var descriptor = Marshal.PtrToStructure<LibUsb.InterfaceDescriptor>(iface.altsetting + (altIndex * altsettingSize));
                var bulkOutEndpoints = new List<byte>();
                for (var endpointIndex = 0; endpointIndex < descriptor.bNumEndpoints; endpointIndex++)
                {
                    var endpoint = Marshal.PtrToStructure<LibUsb.EndpointDescriptor>(descriptor.endpoint + (endpointIndex * endpointSize));
                    var isBulk = (endpoint.bmAttributes & 0x03) == 0x02;
                    var isOut = (endpoint.bEndpointAddress & 0x80) == 0;
                    if (isBulk && isOut)
                    {
                        bulkOutEndpoints.Add(endpoint.bEndpointAddress);
                    }
                }
                candidates.Add(new BridgeInterfaceCandidate(
                    descriptor.bInterfaceNumber,
                    descriptor.bInterfaceClass,
                    bulkOutEndpoints));
            }
        }
        return candidates;
    }

    // Pure selection policy, split out from the descriptor marshalling so it can be tested
    // without a real device on the bus. The idle case -- one vendor interface, number 0 -- is
    // the one that regressed.
    internal static (int InterfaceNumber, byte OutEndpoint) SelectBridgeInterface(
        IReadOnlyList<BridgeInterfaceCandidate> candidates,
        ushort productId)
    {
        (int Interface, byte Endpoint)? fallbackCandidate = null;
        foreach (var candidate in candidates)
        {
            if (candidate.InterfaceClass != VendorInterfaceClass || candidate.BulkOutEndpoints.Count == 0)
            {
                continue;
            }
            var endpoint = candidate.BulkOutEndpoints[0];
            if (candidate.InterfaceNumber == FullBridgeInterfaceNumber)
            {
                return (FullBridgeInterfaceNumber, endpoint);
            }
            fallbackCandidate ??= (candidate.InterfaceNumber, endpoint);
        }

        return fallbackCandidate ?? (DefaultInterfaceNumberFor(productId), FallbackBulkOutEndpoint);
    }

    internal static int DefaultInterfaceNumberFor(ushort productId) =>
        productId == IdleProductId ? IdleBridgeInterfaceNumber : FullBridgeInterfaceNumber;

    internal static bool IsKnownBridgeUsbId(ushort vendor, ushort product) => IsBridgeUsbId(vendor, product);
}

internal readonly record struct BridgeInterfaceCandidate(
    int InterfaceNumber,
    byte InterfaceClass,
    IReadOnlyList<byte> BulkOutEndpoints);

static class LibUsb
{
    private const string Library = "libusb-1.0.so.0";

    public const int ErrorTimeout = -7;
    public const int ErrorAccess = -3;

    [StructLayout(LayoutKind.Sequential)]
    public struct DeviceDescriptor
    {
        public byte bLength;
        public byte bDescriptorType;
        public ushort bcdUSB;
        public byte bDeviceClass;
        public byte bDeviceSubClass;
        public byte bDeviceProtocol;
        public byte bMaxPacketSize0;
        public ushort idVendor;
        public ushort idProduct;
        public ushort bcdDevice;
        public byte iManufacturer;
        public byte iProduct;
        public byte iSerialNumber;
        public byte bNumConfigurations;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ConfigDescriptor
    {
        public byte bLength;
        public byte bDescriptorType;
        public ushort wTotalLength;
        public byte bNumInterfaces;
        public byte bConfigurationValue;
        public byte iConfiguration;
        public byte bmAttributes;
        public byte MaxPower;
        public IntPtr @interface;
        public IntPtr extra;
        public int extra_length;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Interface
    {
        public IntPtr altsetting;
        public int num_altsetting;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct InterfaceDescriptor
    {
        public byte bLength;
        public byte bDescriptorType;
        public byte bInterfaceNumber;
        public byte bAlternateSetting;
        public byte bNumEndpoints;
        public byte bInterfaceClass;
        public byte bInterfaceSubClass;
        public byte bInterfaceProtocol;
        public byte iInterface;
        public IntPtr endpoint;
        public IntPtr extra;
        public int extra_length;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct EndpointDescriptor
    {
        public byte bLength;
        public byte bDescriptorType;
        public byte bEndpointAddress;
        public byte bmAttributes;
        public ushort wMaxPacketSize;
        public byte bInterval;
        public byte bRefresh;
        public byte bSynchAddress;
        public IntPtr extra;
        public int extra_length;
    }

    [DllImport(Library)]
    public static extern int libusb_init(ref IntPtr context);

    [DllImport(Library)]
    public static extern void libusb_exit(IntPtr context);

    [DllImport(Library)]
    public static extern nint libusb_get_device_list(IntPtr context, ref IntPtr list);

    [DllImport(Library)]
    public static extern void libusb_free_device_list(IntPtr list, int unrefDevices);

    [DllImport(Library)]
    public static extern int libusb_get_device_descriptor(IntPtr device, out DeviceDescriptor descriptor);

    [DllImport(Library)]
    public static extern int libusb_get_active_config_descriptor(IntPtr device, out IntPtr config);

    [DllImport(Library)]
    public static extern void libusb_free_config_descriptor(IntPtr config);

    [DllImport(Library)]
    public static extern int libusb_open(IntPtr device, out IntPtr handle);

    [DllImport(Library)]
    public static extern void libusb_close(IntPtr handle);

    [DllImport(Library)]
    public static extern int libusb_set_auto_detach_kernel_driver(IntPtr handle, int enable);

    [DllImport(Library)]
    public static extern int libusb_claim_interface(IntPtr handle, int interfaceNumber);

    [DllImport(Library)]
    public static extern int libusb_release_interface(IntPtr handle, int interfaceNumber);

    [DllImport(Library)]
    public static extern byte libusb_get_bus_number(IntPtr device);

    [DllImport(Library)]
    public static extern byte libusb_get_device_address(IntPtr device);

    [DllImport(Library)]
    public static extern int libusb_get_port_numbers(IntPtr device, [Out] byte[] portNumbers, int portNumbersLen);

    [DllImport(Library)]
    public static extern int libusb_control_transfer(
        IntPtr handle,
        byte requestType,
        byte request,
        ushort value,
        ushort index,
        byte[] data,
        ushort length,
        uint timeout);

    [DllImport(Library)]
    public static extern int libusb_bulk_transfer(
        IntPtr handle,
        byte endpoint,
        byte[] data,
        int length,
        out int transferred,
        uint timeout);

    [DllImport(Library)]
    private static extern IntPtr libusb_error_name(int errorCode);

    public static string ErrorName(int errorCode)
    {
        var namePtr = libusb_error_name(errorCode);
        return namePtr == IntPtr.Zero
            ? $"LIBUSB_ERROR_{errorCode}"
            : Marshal.PtrToStringAnsi(namePtr) ?? $"LIBUSB_ERROR_{errorCode}";
    }
}

using System.Runtime.InteropServices;

// libusb-1.0 twin of WinUsbBridgeTransport: same control-transfer setup packets
// (GET 0xC1/0x31, SET 0x41/0x32, wIndex = interface 5) and 64-byte bulk OUT
// writes. Discovery is VID/PID + bInterfaceNumber 5 + class 0xFF instead of
// the Windows device-interface GUIDs, which do not exist on Linux.
sealed class LinuxUsbBridgeTransport : IDisposable
{
    private const byte ControlGetReport = 0x31;
    private const byte ControlSetReport = 0x32;
    private const int BridgeInterfaceNumber = 5;
    private const byte FallbackBulkOutEndpoint = 0x07; // HOST_BRIDGE_EP_OUT in firmware
    private const int ReportBytes = 64;
    private const uint ControlTransferTimeoutMs = 1000;
    private const uint BridgeOutTransferTimeoutMs = 35;

    // Every persona identity the firmware can present.
    private static readonly (ushort Vendor, ushort Product)[] BridgeUsbIds =
    {
        (0x054C, 0x0CE6), // DualSense
        (0x054C, 0x0DF2), // DualSense Edge
        (0x054C, 0x09CC), // DualShock 4
        (0x1209, 0xDB05)  // Xbox 360 persona
    };

    private readonly IntPtr context;
    private readonly IntPtr deviceHandle;
    private readonly byte outEndpoint;
    private bool disposed;

    private LinuxUsbBridgeTransport(string devicePath, IntPtr context, IntPtr deviceHandle, byte outEndpoint)
    {
        DevicePath = devicePath;
        this.context = context;
        this.deviceHandle = deviceHandle;
        this.outEndpoint = outEndpoint;
    }

    public string DevicePath { get; }

    public static LinuxUsbBridgeTransport Open()
    {
        var context = IntPtr.Zero;
        var initResult = LibUsb.libusb_init(ref context);
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

                try
                {
                    var outEndpoint = FindBridgeBulkOutEndpoint(device);
                    var openResult = LibUsb.libusb_open(device, out var handle);
                    if (openResult < 0)
                    {
                        throw new IOException(DescribeOpenFailure(openResult));
                    }

                    try
                    {
                        _ = LibUsb.libusb_set_auto_detach_kernel_driver(handle, 1);
                        var claimResult = LibUsb.libusb_claim_interface(handle, BridgeInterfaceNumber);
                        if (claimResult < 0)
                        {
                            throw new IOException($"USB bridge interface claim failed: {LibUsb.ErrorName(claimResult)}.");
                        }

                        var bus = LibUsb.libusb_get_bus_number(device);
                        var address = LibUsb.libusb_get_device_address(device);
                        var path = $"usb:{bus:D3}:{address:D3} {descriptor.idVendor:x4}:{descriptor.idProduct:x4} if{BridgeInterfaceNumber}";
                        return new LinuxUsbBridgeTransport(path, context, handle, outEndpoint);
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
            BridgeInterfaceNumber,
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
            BridgeInterfaceNumber,
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
        _ = LibUsb.libusb_release_interface(deviceHandle, BridgeInterfaceNumber);
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

    private static string DescribeOpenFailure(int errorCode)
    {
        var name = LibUsb.ErrorName(errorCode);
        if (errorCode == LibUsb.ErrorAccess)
        {
            return $"USB bridge open failed: {name}. Install the DS5 Bridge udev rules (60-ds5bridge.rules), then unplug and replug the bridge.";
        }
        return $"USB bridge open failed: {name}.";
    }

    // Walk the active configuration for interface 5 (vendor class 0xFF) and
    // return its bulk OUT endpoint; fall back to the firmware's fixed EP 0x07
    // if descriptor parsing fails.
    private static byte FindBridgeBulkOutEndpoint(IntPtr device)
    {
        if (LibUsb.libusb_get_active_config_descriptor(device, out var configPtr) < 0 || configPtr == IntPtr.Zero)
        {
            return FallbackBulkOutEndpoint;
        }

        try
        {
            var config = Marshal.PtrToStructure<LibUsb.ConfigDescriptor>(configPtr);
            var interfaceSize = Marshal.SizeOf<LibUsb.Interface>();
            for (var interfaceIndex = 0; interfaceIndex < config.bNumInterfaces; interfaceIndex++)
            {
                var iface = Marshal.PtrToStructure<LibUsb.Interface>(config.@interface + (interfaceIndex * interfaceSize));
                var altsettingSize = Marshal.SizeOf<LibUsb.InterfaceDescriptor>();
                for (var altIndex = 0; altIndex < iface.num_altsetting; altIndex++)
                {
                    var descriptor = Marshal.PtrToStructure<LibUsb.InterfaceDescriptor>(iface.altsetting + (altIndex * altsettingSize));
                    if (descriptor.bInterfaceNumber != BridgeInterfaceNumber || descriptor.bInterfaceClass != 0xFF)
                    {
                        continue;
                    }
                    var endpointSize = Marshal.SizeOf<LibUsb.EndpointDescriptor>();
                    for (var endpointIndex = 0; endpointIndex < descriptor.bNumEndpoints; endpointIndex++)
                    {
                        var endpoint = Marshal.PtrToStructure<LibUsb.EndpointDescriptor>(descriptor.endpoint + (endpointIndex * endpointSize));
                        var isBulk = (endpoint.bmAttributes & 0x03) == 0x02;
                        var isOut = (endpoint.bEndpointAddress & 0x80) == 0;
                        if (isBulk && isOut)
                        {
                            return endpoint.bEndpointAddress;
                        }
                    }
                }
            }
        }
        catch
        {
            // Fall through to the firmware default.
        }
        finally
        {
            LibUsb.libusb_free_config_descriptor(configPtr);
        }

        return FallbackBulkOutEndpoint;
    }
}

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

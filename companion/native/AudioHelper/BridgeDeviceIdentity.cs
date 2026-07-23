using System.Runtime.InteropServices;
using System.Text;
using NAudio.CoreAudioApi;

// Resolves which Windows audio endpoints belong to the PHYSICAL bridge device.
//
// The bridge deliberately masquerades as a stock DualSense, so its audio
// endpoint's friendly name is identical to a real DualSense plugged straight
// into the PC -- name-based endpoint selection picks whichever twin Windows
// enumerates first (observed: the app's Haptic test firing on a USB-connected
// controller instead of the bridge). The one thing only the bridge has is its
// companion WinUSB interface; every Windows device interface/devnode carries a
// container ID that identifies the physical device it belongs to, so matching
// the audio endpoint's container ID against the companion interface's
// container ID targets the bridge unambiguously no matter how many
// identically-named controllers are attached.
static class BridgeDeviceIdentity
{
    private const string MmDeviceInstancePrefix = "SWD\\MMDEVAPI\\";

    // Windows assigns this sentinel container to devices that are not part of
    // a removable physical container (e.g. onboard audio). Never match on it:
    // two unrelated devices can both carry it.
    private static readonly Guid NullContainer = new("00000000-0000-0000-ffff-ffffffffffff");

    // Returns the container IDs of every present bridge (normally one).
    // Enumeration does not open the device, so this works while the companion
    // app holds the WinUSB interface.
    public static HashSet<Guid> GetBridgeContainerIds()
    {
        var containers = new HashSet<Guid>();
        foreach (var interfaceGuid in WinUsbBridgeTransport.BridgeDeviceInterfaceGuids)
        {
            foreach (var path in NativeMethods.EnumerateDeviceInterfacePaths(interfaceGuid))
            {
                if (!path.Contains("mi_05", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (TryGetInterfaceContainerId(path, out var container)
                    && container != NullContainer)
                {
                    containers.Add(container);
                }
            }
        }
        return containers;
    }

    public static bool TryGetEndpointContainerId(MMDevice device, out Guid containerId)
    {
        // Audio endpoints are software devnodes under SWD\MMDEVAPI whose
        // container ID Windows sets to the underlying (e.g. USB) device's
        // container -- the same grouping the Sound control panel uses.
        return TryGetDevNodeContainerId(MmDeviceInstancePrefix + device.ID, out containerId);
    }

    private static bool TryGetInterfaceContainerId(string interfacePath, out Guid containerId)
    {
        containerId = Guid.Empty;
        if (!TryGetInterfaceInstanceId(interfacePath, out var instanceId))
        {
            return false;
        }
        return TryGetDevNodeContainerId(instanceId, out containerId);
    }

    private static bool TryGetInterfaceInstanceId(string interfacePath, out string instanceId)
    {
        instanceId = string.Empty;
        var key = CmNative.DevpkeyDeviceInstanceId;
        uint size = 0;
        var result = CmNative.CM_Get_Device_Interface_PropertyW(
            interfacePath, ref key, out var propType, null, ref size, 0);
        if (result != CmNative.CrBufferSmall || size == 0)
        {
            return false;
        }
        var buffer = new byte[size];
        result = CmNative.CM_Get_Device_Interface_PropertyW(
            interfacePath, ref key, out propType, buffer, ref size, 0);
        if (result != CmNative.CrSuccess || propType != CmNative.DevpropTypeString)
        {
            return false;
        }
        instanceId = Encoding.Unicode.GetString(buffer).TrimEnd('\0');
        return instanceId.Length > 0;
    }

    private static bool TryGetDevNodeContainerId(string instanceId, out Guid containerId)
    {
        containerId = Guid.Empty;
        var locate = CmNative.CM_Locate_DevNodeW(
            out var devInst, instanceId, CmNative.LocateDevnodePhantom);
        if (locate != CmNative.CrSuccess)
        {
            return false;
        }
        var key = CmNative.DevpkeyDeviceContainerId;
        var buffer = new byte[16];
        uint size = (uint)buffer.Length;
        var result = CmNative.CM_Get_DevNode_PropertyW(
            devInst, ref key, out var propType, buffer, ref size, 0);
        if (result != CmNative.CrSuccess || propType != CmNative.DevpropTypeGuid || size != 16)
        {
            return false;
        }
        containerId = new Guid(buffer);
        return containerId != Guid.Empty;
    }

    private static class CmNative
    {
        public const int CrSuccess = 0;
        public const int CrBufferSmall = 26;
        public const uint LocateDevnodePhantom = 1;
        public const uint DevpropTypeString = 0x00000012;
        public const uint DevpropTypeGuid = 0x0000000D;

        // DEVPKEY_Device_InstanceId = {78c34fc8-104a-4aca-9ea4-524d52996e57}, 256
        public static DevPropKey DevpkeyDeviceInstanceId = new()
        {
            fmtid = new Guid("78c34fc8-104a-4aca-9ea4-524d52996e57"),
            pid = 256
        };

        // DEVPKEY_Device_ContainerId = {8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c}, 2
        public static DevPropKey DevpkeyDeviceContainerId = new()
        {
            fmtid = new Guid("8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c"),
            pid = 2
        };

        [StructLayout(LayoutKind.Sequential)]
        public struct DevPropKey
        {
            public Guid fmtid;
            public uint pid;
        }

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        public static extern int CM_Get_Device_Interface_PropertyW(
            string pszDeviceInterface,
            ref DevPropKey propertyKey,
            out uint propertyType,
            byte[]? propertyBuffer,
            ref uint propertyBufferSize,
            uint ulFlags);

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        public static extern int CM_Locate_DevNodeW(
            out uint pdnDevInst,
            string pDeviceID,
            uint ulFlags);

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        public static extern int CM_Get_DevNode_PropertyW(
            uint dnDevInst,
            ref DevPropKey propertyKey,
            out uint propertyType,
            byte[] propertyBuffer,
            ref uint propertyBufferSize,
            uint ulFlags);
    }
}

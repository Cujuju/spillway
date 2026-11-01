# Called by scripts/dev-shortcut.mjs: writes a Start Menu shortcut with an app ID and a tile manifest.
# Electron's shell.writeShortcutLink can't set the manifest hint, which gives the Start tile its large logo.
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Target,
    [Parameter(Mandatory)][string]$Arguments,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$Icon,
    [Parameter(Mandatory)][string]$AppId,
    [Parameter(Mandatory)][string]$TileManifest
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace SpillwayShortcut {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out ushort hotkey);
        void SetHotkey(ushort hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid FormatId; public uint PropertyId; }

    // PROPVARIANT holding VT_LPWSTR; 24 bytes on x64.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Value; }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLinkCoClass { }

    public static class Link {
        const ushort VT_LPWSTR = 31;
        static readonly Guid AppUserModelFormat = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        // propkey.h: PKEY_AppUserModel_ID and PKEY_AppUserModel_VisualElementsManifestHintPath.
        const uint AppUserModelIdProperty = 5;
        const uint TileManifestHintProperty = 31;
        const uint SHCNE_UPDATEITEM = 0x2000;
        // SHCNF_PATHW | SHCNF_FLUSH.
        const uint SHCNF_PATH_FLUSHED = 0x1005;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);

        static void SetString(IPropertyStore store, uint propertyId, string text) {
            var key = new PropertyKey { FormatId = AppUserModelFormat, PropertyId = propertyId };
            var value = new PropVariant { Type = VT_LPWSTR, Value = Marshal.StringToCoTaskMemUni(text) };
            try { store.SetValue(ref key, ref value); } finally { Marshal.FreeCoTaskMem(value.Value); }
        }

        public static void Save(string path, string target, string arguments, string workingDir, string icon, string appId, string tileManifest) {
            var link = (IShellLinkW)new ShellLinkCoClass();
            link.SetPath(target);
            link.SetArguments(arguments);
            link.SetWorkingDirectory(workingDir);
            link.SetIconLocation(icon, 0);
            link.SetDescription("Spillway Dev, run from the repo");
            var store = (IPropertyStore)link;
            SetString(store, AppUserModelIdProperty, appId);
            SetString(store, TileManifestHintProperty, tileManifest);
            store.Commit();
            ((IPersistFile)link).Save(path, true);
            // Start caches a shortcut's tile; this makes it read the shortcut again.
            SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATH_FLUSHED, path, IntPtr.Zero);
        }
    }
}
'@
[SpillwayShortcut.Link]::Save($Path, $Target, $Arguments, $WorkingDirectory, $Icon, $AppId, $TileManifest)

using System.Runtime.InteropServices;

namespace DataDesk.Engine;

/// <summary>
/// Provides direct access to the Windows API for deep telemetry diagnostics.
/// These calls are significantly faster and more reliable than WMI or PowerShell.
/// </summary>
internal static class NativeMethods
{
    // --- GDI & USER Object Leaks ---
    // Essential for identifying when an OpenFin renderer is "zombifying" and leaking resources.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetGuiResources(IntPtr hProcess, uint uiFlags);

    public const uint GR_GDIOBJECTS = 0;
    public const uint GR_USEROBJECTS = 1;

    // --- I/O Counters ---
    // Direct access to byte-level disk/network impact per process.
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessIoCounters(IntPtr hProcess, out IO_COUNTERS lpIoCounters);

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    // --- Thread-Level Context Switching ---
    // Identifying core-level bottlenecks in high-frequency trading apps.
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr hProcess, out long lpCreationTime, out long lpExitTime, out long lpKernelTime, out long lpUserTime);
}

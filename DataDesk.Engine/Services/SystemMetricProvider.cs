using System.Diagnostics;
using System.Runtime.InteropServices;
using DataDesk.Engine.Models;

namespace DataDesk.Engine.Services;

public class SystemMetricProvider
{
    private long _lastIdleTime;
    private long _lastKernelTime;
    private long _lastUserTime;

    public SystemMetricProvider()
    {
        // Initial snapshot for delta calculation
        NativeMethods.GetSystemTimes(out _lastIdleTime, out _lastKernelTime, out _lastUserTime);
    }

    public TelemetryPayload GetCurrentMetrics()
    {
        var payload = new TelemetryPayload();
        
        // 1. CPU Metrics via Native kernel32!GetSystemTimes (Zero NuGet)
        if (NativeMethods.GetSystemTimes(out long currentIdle, out long currentKernel, out long currentUser))
        {
            long idleDelta = currentIdle - _lastIdleTime;
            long kernelDelta = currentKernel - _lastKernelTime;
            long userDelta = currentUser - _lastUserTime;
            long totalDelta = kernelDelta + userDelta;

            if (totalDelta > 0)
            {
                payload.Cpu.Usage = (float)(100.0 * (totalDelta - idleDelta) / totalDelta);
            }

            _lastIdleTime = currentIdle;
            _lastKernelTime = currentKernel;
            _lastUserTime = currentUser;
        }

        // 2. Memory Metrics via Native kernel32!GlobalMemoryStatusEx (Zero NuGet)
        var memStatus = new NativeMethods.MEMORYSTATUSEX();
        if (NativeMethods.GlobalMemoryStatusEx(memStatus))
        {
            payload.Mem.Percent = memStatus.dwMemoryLoad;
            payload.Mem.Avail = (long)(memStatus.ullAvailPhys / 1024 / 1024);
            payload.Mem.CommitPct = (float)((double)(memStatus.ullTotalPageFile - memStatus.ullAvailPageFile) / memStatus.ullTotalPageFile * 100);
            
            // For BrowserMonitor synchronization
            payload.BrowserMonitor.SysMem.Total = (float)(memStatus.ullTotalPhys / 1024 / 1024 / 1024.0);
            payload.BrowserMonitor.SysMem.Used = (float)((memStatus.ullTotalPhys - memStatus.ullAvailPhys) / 1024 / 1024 / 1024.0);
            payload.BrowserMonitor.SysMem.Free = (float)(memStatus.ullAvailPhys / 1024 / 1024 / 1024.0);
            payload.BrowserMonitor.SysMem.Pct = memStatus.dwMemoryLoad;
        }

        // 3. System Info
        payload.SysUpSecs = (long)(NativeMethods.GetTickCount64() / 1000);
        var uptimeSpan = TimeSpan.FromSeconds(payload.SysUpSecs);
        payload.Uptime = $"{(int)uptimeSpan.TotalHours:D2}:{uptimeSpan.Minutes:D2}:{uptimeSpan.Seconds:D2}";
        
        payload.Sys.Os = RuntimeInformation.OSDescription;
        payload.Sys.User = Environment.UserName;
        payload.Sys.Boot = DateTime.Now.AddSeconds(-payload.SysUpSecs).ToString("yyyy-MM-dd HH:mm:ss");
        payload.Sys.Ip = "127.0.0.1"; // Default for offline mode
        
        return payload;
    }
}

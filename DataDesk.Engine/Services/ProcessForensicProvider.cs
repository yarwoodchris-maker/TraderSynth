using System.Diagnostics;
using DataDesk.Engine.Models;

namespace DataDesk.Engine.Services;

public class ProcessForensicProvider
{
    private readonly string[] _targetProcesses = { "openfin", "chrome", "msedge", "msedgewebview2", "tradersynth", "datadesk", "engine" };
    private readonly Dictionary<int, (TimeSpan CPU, DateTime Sample)> _cpuHistory = new();
    private readonly Dictionary<int, long> _lastMem = new();
    
    public List<ProcessMetric> CaptureForensics()
    {
        var metrics = new List<ProcessMetric>();
        var allProcs = Process.GetProcesses();

        foreach (var p in allProcs)
        {
            try
            {
                string procName = p.ProcessName.ToLower();
                bool isTarget = false;
                foreach (var target in _targetProcesses)
                {
                    if (procName.Contains(target)) { isTarget = true; break; }
                }

                if (!isTarget) continue;

                var m = new ProcessMetric
                {
                    Name = p.ProcessName,
                    Pid = p.Id,
                    Ram = (float)(p.PrivateMemorySize64 / 1024 / 1024),
                    Threads = p.Threads.Count,
                    Handles = (uint)p.HandleCount
                };

                // 1. CPU Calculation
                try
                {
                    if (_cpuHistory.TryGetValue(p.Id, out var last))
                    {
                        var cpuDelta = p.TotalProcessorTime - last.CPU;
                        var timeDelta = DateTime.Now - last.Sample;
                        if (timeDelta.TotalMilliseconds > 0)
                        {
                            m.Cpu = (float)((cpuDelta.TotalMilliseconds / (Environment.ProcessorCount * timeDelta.TotalMilliseconds)) * 100);
                        }
                    }
                    _cpuHistory[p.Id] = (p.TotalProcessorTime, DateTime.Now);
                }
                catch { /* Access denied to processor time */ }

                // 2. IO Tracking
                if (NativeMethods.GetProcessIoCounters(p.Handle, out var io))
                {
                    m.IoReadBytes = io.ReadTransferCount;
                }

                // 3. Stutter / Responsiveness
                if (!p.Responding) m.Stutter = 1000;
                else if (p.MainWindowHandle != IntPtr.Zero && NativeMethods.IsHungAppWindow(p.MainWindowHandle)) m.Stutter = 500;

                metrics.Add(m);
            }
            catch
            {
                // Access restricted or process exited
            }
            finally
            {
                p.Dispose();
            }
        }

        // Cleanup stale PID references
        if (_cpuHistory.Count > 200) _cpuHistory.Clear();

        return metrics;
    }

    public void PopulateBrowserMonitor(TelemetryPayload payload, List<ProcessMetric> allProcs)
    {
        payload.BrowserMonitor.Active = true;
        
        var chromeProcs = allProcs.Where(p => p.Name.ToLower().Contains("chrome")).ToList();
        var edgeProcs = allProcs.Where(p => p.Name.ToLower().Contains("msedge") || p.Name.ToLower().Contains("webview2")).ToList();

        payload.BrowserMonitor.Chrome = MapBrowserStats(chromeProcs);
        payload.BrowserMonitor.Edge = MapBrowserStats(edgeProcs);
    }

    private BrowserStats MapBrowserStats(List<ProcessMetric> procs)
    {
        var stats = new BrowserStats();
        if (procs.Count == 0) return stats;

        stats.Active = true;
        stats.Procs = procs.Count;
        stats.Tabs = procs.Count(p => p.Handles > 500); // Heuristic for tabs
        stats.WorkingSet = procs.Sum(p => p.Ram);
        stats.Private = stats.WorkingSet * 0.8f; // Estimation
        stats.SysPct = (float)Math.Round(procs.Sum(p => p.Cpu), 1);

        stats.TopProcs = procs.OrderByDescending(p => p.Ram).Take(5).Select(p => new BrowserProc
        {
            Pid = p.Pid,
            Type = p.Handles > 1000 ? "Tab/Renderer" : "Service/Utility",
            WorkingSet = p.Ram,
            Private = p.Ram * 0.8f,
            Threads = p.Threads,
            Cpu = p.Cpu.ToString("F1")
        }).ToList();

        return stats;
    }
}

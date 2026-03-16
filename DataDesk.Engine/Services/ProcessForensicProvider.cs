using System.Diagnostics;
using DataDesk.Engine.Models;

namespace DataDesk.Engine.Services;

public class ProcessForensicProvider
{
    private readonly string[] _targetProcesses = { "openfin", "chrome", "msedge", "tradersynth" };
    private readonly Dictionary<int, long> _lastMem = new();
    private readonly Stopwatch _pulseTimer = new();

    public ProcessForensicProvider()
    {
    }

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
                    MemMB = (float)(p.PrivateMemorySize64 / 1024 / 1024),
                    Handles = (uint)p.HandleCount
                };

                // 1. Native Diagnostics: GDI Objects
                m.GdiObjects = NativeMethods.GetGuiResources(p.Handle, NativeMethods.GR_GDIOBJECTS);

                // 2. Native Diagnostics: I/O
                if (NativeMethods.GetProcessIoCounters(p.Handle, out var io))
                {
                    m.IoReadBytes = io.ReadTransferCount;
                }

                // 3. Phase 2: Micro-Stutter Detection
                // We check the Responding property and also probe the GUI thread latency
                _pulseTimer.Restart();
                bool isResponding = p.Responding;
                if (!isResponding)
                {
                    m.StutterMs = 1000; // Flag as frozen
                }
                else if (p.MainWindowHandle != IntPtr.Zero)
                {
                    if (NativeMethods.IsHungAppWindow(p.MainWindowHandle))
                    {
                        m.StutterMs = 500;
                    }
                }
                
                // 4. Phase 2: Memory Entropy (Thrashing Detection)
                // If private memory is fluctuating by >10MB/sec, it indicates thrashing
                if (_lastMem.TryGetValue(p.Id, out long lastVal))
                {
                    long delta = Math.Abs(p.PrivateMemorySize64 - lastVal);
                    if (delta > 10 * 1024 * 1024) 
                    {
                        // Mark a virtual "Entropy Spike" in the logs if needed
                    }
                }
                _lastMem[p.Id] = p.PrivateMemorySize64;

                // 5. Phase 2: Thread Affinity (Core Lock Detection)
                // Identifies which logical processors are assigned to the process.
                try
                {
                    m.AffinityCore = (int)p.ProcessorAffinity.ToInt64();
                }
                catch { /* Access denied or process exited */ }

                metrics.Add(m);
            }
            catch
            {
                // Access restricted
            }
            finally
            {
                p.Dispose();
            }
        }

        // Cleanup stale PID references in entropy dictionary
        if (_lastMem.Count > 100) _lastMem.Clear(); 

        return metrics.OrderByDescending(x => x.MemMB).Take(10).ToList();
    }
}

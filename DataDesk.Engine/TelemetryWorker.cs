using System.Diagnostics;
using DataDesk.Engine.Services;
using DataDesk.Engine.Models;

namespace DataDesk.Engine;

public class TelemetryWorker
{
    private readonly SystemMetricProvider _metrics;
    private readonly ProcessForensicProvider _forensics;
    private readonly TelemetryCache _cache;
    private readonly Stopwatch _stopwatch = new();
    private readonly int _myPid;

    public TelemetryWorker(SystemMetricProvider metrics, ProcessForensicProvider forensics, TelemetryCache cache)
    {
        _metrics = metrics;
        _forensics = forensics;
        _cache = cache;
        _myPid = Process.GetCurrentProcess().Id;
    }

    public async Task StartAsync(CancellationToken stoppingToken)
    {
        Console.WriteLine("[*] Telemetry Loop Started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            _stopwatch.Restart();

            try
            {
                var payload = _metrics.GetCurrentMetrics();
                var allProcs = _forensics.CaptureForensics();

                // 1. Process List for Main Consumers
                payload.Procs = allProcs.OrderByDescending(p => p.Cpu).Take(15).ToList();

                // 2. Thread List for Surveillance Card
                payload.Threads = allProcs.OrderByDescending(p => p.Threads).Take(10).ToList();

                // 3. Browser Monitoring Structure
                _forensics.PopulateBrowserMonitor(payload, allProcs);

                // 4. Engine Overhead
                var self = allProcs.FirstOrDefault(p => p.Pid == _myPid);
                if (self != null)
                {
                    payload.Overhead.Engine.Pid = self.Pid;
                    payload.Overhead.Engine.Cpu = self.Cpu;
                    payload.Overhead.Engine.Ram = self.Ram;
                }

                // 5. Risk / Zombies
                payload.Risk.Zombies = allProcs.Count(p => p.Stutter > 0);
                payload.Risk.ZombieList = allProcs.Where(p => p.Stutter > 0).ToList();
                if (payload.Risk.Zombies > 0)
                {
                    payload.ForensicLog.Add(new SystemEvent { 
                        Category = "Risk", 
                        Message = $"Detected {payload.Risk.Zombies} unresponsive processes." 
                    });
                }

                // 6. Global Score Calculation
                int score = 100;
                if (payload.Cpu.Usage > 80) score -= 10;
                if (payload.Mem.Percent > 80) score -= 10;
                score -= (payload.Risk.Zombies * 5);
                payload.Score = Math.Max(0, score);

                _cache.Latest = payload;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[!] Collector Error: {ex.Message}");
            }

            int elapsed = (int)_stopwatch.ElapsedMilliseconds;
            int delay = Math.Max(10, 1000 - elapsed);
            await Task.Delay(delay, stoppingToken);
        }
    }
}

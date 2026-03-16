using System.Text.Json.Serialization;

namespace DataDesk.Engine.Models;

public class TelemetryPayload
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "active";

    [JsonPropertyName("cpu")]
    public CpuMetrics Cpu { get; set; } = new();

    [JsonPropertyName("mem")]
    public MemMetrics Mem { get; set; } = new();

    [JsonPropertyName("gpu")]
    public GpuMetrics Gpu { get; set; } = new();

    [JsonPropertyName("sys")]
    public SysMetrics Sys { get; set; } = new();

    [JsonPropertyName("procs")]
    public List<ProcessMetric> Procs { get; set; } = new();

    [JsonPropertyName("threads")]
    public List<ProcessMetric> Threads { get; set; } = new();

    [JsonPropertyName("overhead")]
    public OverheadMetrics Overhead { get; set; } = new();

    [JsonPropertyName("risk")]
    public RiskMetrics Risk { get; set; } = new();

    [JsonPropertyName("browserMonitor")]
    public BrowserMonitor BrowserMonitor { get; set; } = new();

    [JsonPropertyName("forensicLog")]
    public List<SystemEvent> ForensicLog { get; set; } = new();

    [JsonPropertyName("score")]
    public int Score { get; set; } = 100;

    [JsonPropertyName("sysUpSecs")]
    public long SysUpSecs { get; set; }

    [JsonPropertyName("uptime")]
    public string Uptime { get; set; } = "00:00:00";

    [JsonPropertyName("jitterInfo")]
    public string JitterInfo { get; set; } = "Deterministic matrix stable.";

    [JsonPropertyName("sync")]
    public string Sync { get; set; } = DateTime.Now.ToString("HH:mm:ss.fff");
}

public class ProcessMetric
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("pid")]
    public int Pid { get; set; }

    [JsonPropertyName("cpu")]
    public float Cpu { get; set; }

    [JsonPropertyName("ram")]
    public float Ram { get; set; }

    [JsonPropertyName("th")]
    public int Threads { get; set; }

    [JsonPropertyName("handles")]
    public uint Handles { get; set; }

    [JsonPropertyName("ioRead")]
    public ulong IoReadBytes { get; set; }

    [JsonPropertyName("stutter")]
    public int Stutter { get; set; }
}

public class OverheadMetrics
{
    [JsonPropertyName("engine")]
    public EngineStats Engine { get; set; } = new();
}

public class EngineStats
{
    [JsonPropertyName("pid")]
    public int Pid { get; set; }

    [JsonPropertyName("cpu")]
    public float Cpu { get; set; }

    [JsonPropertyName("ram")]
    public float Ram { get; set; }
}

public class RiskMetrics
{
    [JsonPropertyName("zombies")]
    public int Zombies { get; set; }

    [JsonPropertyName("zombieList")]
    public List<ProcessMetric> ZombieList { get; set; } = new();
}

public class BrowserMonitor
{
    [JsonPropertyName("active")]
    public bool Active { get; set; } = true;

    [JsonPropertyName("sysMem")]
    public BrowserSysMem SysMem { get; set; } = new();

    [JsonPropertyName("chrome")]
    public BrowserStats Chrome { get; set; } = new();

    [JsonPropertyName("edge")]
    public BrowserStats Edge { get; set; } = new();
}

public class BrowserSysMem
{
    [JsonPropertyName("total")]
    public float Total { get; set; }
    [JsonPropertyName("used")]
    public float Used { get; set; }
    [JsonPropertyName("free")]
    public float Free { get; set; }
    [JsonPropertyName("pct")]
    public float Pct { get; set; }
}

public class BrowserStats
{
    [JsonPropertyName("active")]
    public bool Active { get; set; }
    [JsonPropertyName("procs")]
    public int Procs { get; set; }
    [JsonPropertyName("tabs")]
    public int Tabs { get; set; }
    [JsonPropertyName("ws")]
    public float WorkingSet { get; set; }
    [JsonPropertyName("priv")]
    public float Private { get; set; }
    [JsonPropertyName("sysPct")]
    public float SysPct { get; set; }
    [JsonPropertyName("topProcs")]
    public List<BrowserProc> TopProcs { get; set; } = new();
}

public class BrowserProc
{
    [JsonPropertyName("pid")]
    public int Pid { get; set; }
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;
    [JsonPropertyName("ws")]
    public float WorkingSet { get; set; }
    [JsonPropertyName("priv")]
    public float Private { get; set; }
    [JsonPropertyName("threads")]
    public int Threads { get; set; }
    [JsonPropertyName("cpu")]
    public string Cpu { get; set; } = "0.0";
}

public class SystemEvent
{
    [JsonPropertyName("ts")]
    public string Time { get; set; } = DateTime.Now.ToString("HH:mm:ss");
    
    [JsonPropertyName("cat")]
    public string Category { get; set; } = "Engine";

    [JsonPropertyName("msg")]
    public string Message { get; set; } = string.Empty;
}

public class CpuMetrics
{
    [JsonPropertyName("usage")]
    public float Usage { get; set; }
    
    [JsonPropertyName("cores")]
    public List<float> Cores { get; set; } = new();
}

public class MemMetrics
{
    [JsonPropertyName("percent")]
    public float Percent { get; set; }

    [JsonPropertyName("avail")]
    public long Avail { get; set; }
    
    [JsonPropertyName("commitPct")]
    public float CommitPct { get; set; }
}

public class GpuMetrics
{
    [JsonPropertyName("usage")]
    public float Usage { get; set; }

    [JsonPropertyName("vramMB")]
    public float? VramMB { get; set; }
}

public class SysMetrics
{
    [JsonPropertyName("os")]
    public string Os { get; set; } = string.Empty;

    [JsonPropertyName("user")]
    public string User { get; set; } = string.Empty;

    [JsonPropertyName("ip")]
    public string Ip { get; set; } = string.Empty;

    [JsonPropertyName("subnet")]
    public string Subnet { get; set; } = "255.255.255.0";

    [JsonPropertyName("boot")]
    public string Boot { get; set; } = string.Empty;
}

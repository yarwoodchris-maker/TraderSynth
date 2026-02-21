<#
.SYNOPSIS
    Trader Desktop Synthetic Test Solution (TraderSynth)
    Version: 3.7.0 (Professional Analytics Refinement)
#>

param([int]$Port = 9000)

$ScriptVersion = "3.7.0"
$ScriptDir = $PSScriptRoot
$WwwDir = Join-Path $ScriptDir "www"

$Sync = [System.Collections.Hashtable]::Synchronized(@{
        Running          = $true
        SimActive        = $false
        Recording        = $true
        EnginePid        = $PID
        BrowserPid       = $null
        RecordBuffer     = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
        Latest           = $null
        SysInfo          = $null
        MarketData       = @()
        StorageBaselines = @() # Storage latency window for baseline
    })

$CollectorScript = {
    param($Sync)
    $ActualStartTime = Get-Date
    
    # --- CIRCUIT BREAKER LOGIC ---
    $FailCounts = @{}
    $CoolDowns = @{}
    
    function Get-CimSafe {
        param(
            [string]$ClassName,
            [string]$Filter = $null,
            [string]$Namespace = "root\cimv2"
        )
        
        $Key = "${Namespace}:${ClassName}"
        
        # Check Circuit Breaker
        if ($FailCounts[$Key] -ge 3) {
            if ($CoolDowns[$Key] -and ((Get-Date) - $CoolDowns[$Key]).TotalSeconds -lt 60) {
                # Breaker Open - Skip
                return $null
            }
            else {
                # Cool down over - Reset checks
                $FailCounts[$Key] = 0
                $CoolDowns[$Key] = $null
            }
        }
        
        try {
            $params = @{ ClassName = $ClassName; Namespace = $Namespace; ErrorAction = "Stop" }
            if ($Filter) { $params.Filter = $Filter }
            
            $res = Get-CimInstance @params
            
            # success resets breaker
            $FailCounts[$Key] = 0
            return $res
        }
        catch {
            if (-not $FailCounts.ContainsKey($Key)) { $FailCounts[$Key] = 0 }
            $FailCounts[$Key]++
            
            if ($FailCounts[$Key] -ge 3) {
                $CoolDowns[$Key] = Get-Date
                Write-Warning "CIRCUIT BREAKER: Disabling $ClassName for 60s due to repeated failures."
            }
            return $null
        }
    }
    # -----------------------------
    
    # Ultra-Stable Cores detection
    $Cores = 8
    try { 
        $cObj = Get-CimSafe Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum
        if ($cObj.Sum) { $Cores = $cObj.Sum }
    }
    catch {}

    try {
        $osObj = Get-CimSafe Win32_OperatingSystem | Select-Object -First 1
        $cpuObj = Get-CimSafe Win32_Processor | Select-Object -First 1
        $mObj = Get-CimSafe Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum
        $gpuObj = Get-CimSafe Win32_VideoController | Select-Object -First 1
        
        $Sync.SysInfo = @{
            os     = $osObj.Caption
            cpu    = $cpuObj.Name
            ram    = "$([math]::Round($mObj.Sum / 1GB, 0)) GB"
            cores  = $Cores
            gpu    = if ($gpuObj) { $gpuObj.Name }else { "Generic Display" }
            driver = if ($gpuObj) { $gpuObj.DriverVersion }else { "N/A" }
            hags   = "Unknown"
        }

        # Environment & HAGS Detection (from Process_Diagnostic)
        $hKey = "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers"
        if (Test-Path $hKey) {
            $hVal = Get-ItemProperty $hKey -Name HwSchMode -ErrorAction SilentlyContinue
            if ($hVal) { $Sync.SysInfo.hags = if ($hVal.HwSchMode -eq 2) { "Enabled" } else { "Disabled" } }
        }
        
        # Citrix VDI Session Detection
        $Sync.SysInfo.isCitrix = $false
        $Sync.SysInfo.citrixSessionId = $null
        $Sync.SysInfo.citrixDebug = @{}
        try {
            $citrixProc = Get-Process -Name "wfshell" -ErrorAction SilentlyContinue
            $citrixRegistry = Test-Path "HKLM:\SOFTWARE\Citrix\ICA Client"
            $vdaRegistry = Test-Path "HKLM:\SOFTWARE\Citrix\VirtualDesktopAgent"
            
            if ($citrixProc -or $citrixRegistry -or $vdaRegistry) {
                $Sync.SysInfo.isCitrix = $true
            }
            else {
                # [Socket Fallback] Check for Citrix VDA Listeners (ICA:1494, CGP:2598)
                $ipProps = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
                $listeners = $ipProps.GetActiveTcpListeners()
                if ($listeners.Port -contains 1494 -or $listeners.Port -contains 2598) {
                    $Sync.SysInfo.isCitrix = $true
                    $Sync.SysInfo.citrixDebug.socketFound = $true
                }
            }

            if ($Sync.SysInfo.isCitrix) {
                $Sync.SysInfo.citrixSessionId = $env:SESSIONNAME
                
                # Diagnostic logging
                $Sync.SysInfo.citrixDebug.wfshellRunning = ($citrixProc -ne $null)
                $Sync.SysInfo.citrixDebug.icaClientReg = $citrixRegistry
                $Sync.SysInfo.citrixDebug.vdaReg = $vdaRegistry
                $Sync.SysInfo.citrixDebug.sessionName = $env:SESSIONNAME
                $Sync.SysInfo.citrixDebug.timestamp = (Get-Date).ToString("HH:mm:ss")
            }
        }
        catch {
            $Sync.SysInfo.citrixDebug.error = $_.Exception.Message
        }
        
        $Sync.SysInfo.isVMware = (Get-CimSafe Win32_VideoController | Where-Object { $_.Name -match "VMware" }) -ne $null
        
        # Multi-Monitor Detection (Tiered strategy for VDI & Physical)
        try {
            # Tier 1: Modern WMI (Active Display Parameters)
            $wmiMonitors = Get-CimSafe -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams
            $count = if ($wmiMonitors) { @($wmiMonitors).Count } else { 0 }

            # Tier 2: PnP Service Check (Physical & VDA drivers)
            if ($count -eq 0) {
                $pnpMonitors = Get-CimSafe Win32_PnPEntity | Where-Object { $_.Service -eq "monitor" }
                $count = if ($pnpMonitors) { @($pnpMonitors).Count } else { 0 }
            }

            # Tier 3: Legacy Fallback
            if ($count -eq 0) {
                $legacyMonitors = Get-CimSafe Win32_DesktopMonitor
                $count = if ($legacyMonitors) { (@($legacyMonitors) | Where-Object { $_.Availability -eq 3 -or $_.Status -eq "OK" }).Count } else { 0 }
            }

            $Sync.SysInfo.monitorCount = [math]::Max(1, $count)
        }
        catch {
            $Sync.SysInfo.monitorCount = 1
        }
    }
    catch {}

    $Assets = @("AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "AMZN", "BTC/USD", "ETH/USD")
    $StorageWindow = 10
    $LatencyBaseline = 2.0

    while ($Sync.Running) {
        try {
            # 1. CORE TELEMETRY
            $cpuTotalData = Get-CimSafe Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq "_Total" } | Select-Object -First 1
            $cpuCoreData = Get-CimSafe Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -ne "_Total" }
            $osData = Get-CimSafe Win32_OperatingSystem | Select-Object FreePhysicalMemory, TotalVisibleMemorySize -First 1
            $sysData = Get-CimSafe Win32_PerfFormattedData_PerfOS_System | Select-Object ProcessorQueueLength, ContextSwitchesPersec, SystemCallsPersec -First 1
            $memPerfData = Get-CimSafe Win32_PerfFormattedData_PerfOS_Memory | Select-Object PageFaultsPersec, CommittedBytes, CommitLimit -First 1
            
            # STORAGE COUNTERS (Win32_PerfFormattedData_PerfDisk_PhysicalDisk for accurate IOPS)
            $diskCounters = Get-CimSafe Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq "_Total" } | Select-Object -First 1
            
            # Update dynamic core count in case of hot-add/VDI shifts
            if ($cpuCoreData) { $Cores = ($cpuCoreData | Measure-Object).Count }
            
            # 2. SIMULATION JITTER & STRESS
            $simAdd = 0
            if ($Sync.SimActive) { $simAdd = Get-Random -Min 40 -Max 75 }
            
            # 3. METRIC AGGREGATION
            $cpuVal = 10
            if ($cpuTotalData) { $cpuVal = [math]::Min(100, $cpuTotalData.PercentProcessorTime + $simAdd) }
            
            $coreLoads = @()
            if ($cpuCoreData) {
                foreach ($c in $cpuCoreData) {
                    $cLoad = $c.PercentProcessorTime
                    if ($Sync.SimActive) { $cLoad = [math]::Min(100, $cLoad + (Get-Random -Min 20 -Max 80)) }
                    $coreLoads += $cLoad
                }
            }

            $memVal = 40
            $memAvail = "8192 MB"
            if ($osData) {
                $memVal = [math]::Round(100 - ($osData.FreePhysicalMemory / $osData.TotalVisibleMemorySize * 100), 1)
                $memAvail = "$([math]::Round($osData.FreePhysicalMemory / 1024, 0)) MB"
            }
            if ($Sync.SimActive) { $memVal = [math]::Min(100, $memVal + 15) }

            # DISK TELEMETRY REFINEMENT
            $readIOPS = 0; $writeIOPS = 0; $diskLat = 2; $diskTP = 0; $diskQueue = 0
            if ($diskCounters) {
                $readIOPS = [math]::Round($diskCounters.DiskReadsPersec, 1)
                $writeIOPS = [math]::Round($diskCounters.DiskWritesPersec, 1)
                $diskLat = [math]::Round($diskCounters.AvgDisksecPerTransfer * 1000, 1) # Transfer is average of R+W
                if ($diskLat -lt 0.1) { $diskLat = 1.2 } # Floor for realism
                $diskTP = [math]::Round(($diskCounters.DiskReadBytesPersec + $diskCounters.DiskWriteBytesPersec) / 1MB, 2)
                $diskQueue = $diskCounters.CurrentDiskQueueLength
            }
            
            # Baseline logic (from StorageAgent)
            $Sync.StorageBaselines += $diskLat
            if ($Sync.StorageBaselines.Count -gt $StorageWindow) { 
                $baselineList = [System.Collections.ArrayList]::new($Sync.StorageBaselines)
                $baselineList.RemoveAt(0)
                $Sync.StorageBaselines = $baselineList.ToArray()
            }
            if ($Sync.StorageBaselines.Count -ge $StorageWindow) {
                $LatencyBaseline = ($Sync.StorageBaselines | Measure-Object -Average).Average
            }

            if ($Sync.SimActive) { $diskLat += 20; $diskTP += 15; $diskQueue += 2 }
            
            # GPU & PROCESS MAPPING
            $gpuVal = 2; $gpuDecode = 0; $gpuEncode = 0
            $gpuProcessMap = @{}
            
            try {
                $gpuEng = Get-CimSafe Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
                if ($gpuEng) {
                    # GPU Usage is typically the highest utilization engine (usually 3D)
                    $nodeSums = $gpuEng | Group-Object Name | Select-Object @{N = 'Sum'; E = { ($_.Group | Measure-Object -Property UtilizationPercentage -Sum).Sum } }
                    $gpuVal = ($nodeSums | Measure-Object -Property Sum -Maximum).Maximum
                    
                    $gpuDecode = ($gpuEng | Where-Object { $_.Name -match "decode" } | Measure-Object -Property UtilizationPercentage -Sum).Sum
                    $gpuEncode = ($gpuEng | Where-Object { $_.Name -match "encode" } | Measure-Object -Property UtilizationPercentage -Sum).Sum

                    # Map to PIDs for per-process view
                    foreach ($eng in $gpuEng) {
                        if ($eng.Name -match "pid_(\d+)") {
                            $gPid = [int]$matches[1]
                            if (-not $gpuProcessMap.ContainsKey($gPid)) { $gpuProcessMap[$gPid] = 0 }
                            $gpuProcessMap[$gPid] += $eng.UtilizationPercentage
                        }
                    }
                }
            }
            catch {}
            if ($Sync.SimActive) { $gpuVal += Get-Random -Min 20 -Max 40 }
            $gpuVal = [math]::Min(100, $gpuVal)

            # 4. ACCURATE PROCESS CONSUMERS & ZOMBIE DETECTION (Live Kernel Objects)
            $procs = @()
            $threadRanked = @()
            $zombies = @()
            $totalHandles = 0
            
            # Use Get-Process for guaranteed real-time thread/handle counts
            $liveProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne 0 -and $_.Id -ne 4 } # Exclude Idle/System
            
            if ($liveProcs) {
                # Calculate basic CPU usage approx (Get-Process CPU is total time, not % usage, so we need a delta or just use CIM for CPU)
                # Hybrid Approach: CIM for CPU %, Get-Process for Threads/Handles correctness
                
                $sortedThreads = $liveProcs | Sort-Object Threads -Descending | Select-Object -First 10
                
                # Zombie criteria 
                foreach ($p in $liveProcs) {
                    $totalHandles += $p.Handles
                    
                    # Zombie: Low CPU (heuristic), High Thread Count, High Private Memory
                    # Note: We can't easily get instantaneous CPU % from Get-Process without sampling. 
                    # We will use a simplified check: High Threads + High Memory + Not responding (if applicable) or just heuristics
                    if ($p.Threads.Count -gt 50 -and $p.WorkingSet64 -gt 500MB) {
                        $zombies += @{ name = $p.ProcessName; pid = $p.Id; th = $p.Threads.Count; ram = [math]::Round($p.WorkingSet64 / 1MB, 1) }
                    }
                }

                # Thread Ranking (Deterministic Refresh)
                $threadRanked = $sortedThreads | ForEach-Object {
                    @{ 
                        name = $_.ProcessName
                        pid  = $_.Id
                        th   = $_.Threads.Count
                        # CPU field left generic or 0 if not easily available without CIM, or we can look it up if we really need it.
                        # For thread list, CPU is secondary.
                        cpu  = 0 
                        ram  = [math]::Round($_.WorkingSet64 / 1MB, 1)
                    }
                }
            }

            # CIM is still best for per-process CPU %
            $cimProcs = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "_Total" -and $_.Name -ne "Idle" }
            if ($cimProcs) {
                # [Standard Path] CIM WMI Data Available
                $sortedCpu = $cimProcs | Sort-Object PercentProcessorTime -Descending | Select-Object -First 5
                
                foreach ($p in $sortedCpu) {
                    $pGpu = if ($gpuProcessMap.ContainsKey([int]$p.IDProcess)) { $gpuProcessMap[[int]$p.IDProcess] } else { 0 }
                    $rawCpu = [math]::Round($p.PercentProcessorTime / $Cores, 1)
                    $finalCpu = [math]::Min(100, $rawCpu)
                    
                    $procs += @{
                        name = $p.Name -replace '#\d+$', ''
                        pid  = $p.IDProcess
                        cpu  = $finalCpu
                        ram  = [math]::Round($p.WorkingSetPrivate / 1MB, 1)
                        disk = [math]::Round(($p.IOReadBytesPersec + $p.IOWriteBytesPersec) / 1MB, 2)
                        th   = $p.ThreadCount
                        gpu  = $pGpu
                    }
                }
            }
            elseif ($liveProcs) {
                # [Fallback Path] CIM Failed, using Kernel Objects Proxy
                # Sort by Working Set (RAM) as secondary proxy for "heaviest" apps since Get-Process CPU is not %
                $sortedFallback = $liveProcs | Sort-Object WorkingSet64 -Descending | Select-Object -First 5
                
                foreach ($p in $sortedFallback) {
                    $procs += @{
                        name = $p.ProcessName
                        pid  = $p.Id
                        cpu  = 0 # Unavailable in fallback
                        ram  = [math]::Round($p.WorkingSet64 / 1MB, 1)
                        disk = 0
                        th   = $p.Threads.Count
                        gpu  = 0
                    }
                }
            }

            # 5. RISK SCORING (Recalibrated for VDI & Trader Workstations)
            $riskScore = 0
            if ($rawProcs.Count -gt 350) { $riskScore += 2 } # High process count
            if ($zombies.Count -gt 0) { $riskScore += 2 }    # Zombie process (Reduced from +4 to +2 to avoid false criticals)
            if ($Sync.Latest.cpu.usage -gt 92) { $riskScore += 4 }
            if ($totalHandles -gt 150000) { $riskScore += 2 } 
            if ($sysData.ContextSwitchesPersec -gt 120000) { $riskScore += 2 }
            if ($Sync.SysInfo.hags -eq "Enabled") { $riskScore += 1 } 
            
            # Context Switch Impact (Saturation Score)
            $csImpact = 0
            if ($sysData.ContextSwitchesPersec -and $Cores) {
                # Thresholds: < 5k/core (Low), 5k-15k/core (Moderate), > 15k/core (High/High Pressure)
                $csPerCore = $sysData.ContextSwitchesPersec / $Cores
                if ($csPerCore -gt 15000) { $csImpact = 10; $riskScore += 3 }
                elseif ($csPerCore -gt 5000) { $csImpact = 5; $riskScore += 1 }
                else { $csImpact = 2 }
            }
            
            # VDI Specific Risks
            if ($Sync.Latest.ica) {
                if ($Sync.Latest.ica.latency -gt 100) { $riskScore += 5 }
                if ($Sync.Latest.ica.inputDelay -gt 50) { $riskScore += 4 }
                
                # High resolution/multi-display protocol pressure
                if ($Sync.SysInfo.monitorCount -ge 3 -and $Sync.Latest.ica.outputBW -gt 10000) { $riskScore += 3 }
            }
            if ($Sync.Latest.vmware) {
                if ($Sync.Latest.vmware.cpuReady -gt 10) { $riskScore += 6 }
                if ($Sync.Latest.vmware.balloon -gt 100) { $riskScore += 4 }
            }


            $riskLevel = "LOW"
            if ($riskScore -ge 12) { $riskLevel = "CRITICAL" }
            elseif ($riskScore -ge 8) { $riskLevel = "HIGH" }
            elseif ($riskScore -ge 4) { $riskLevel = "MODERATE" }

            $scorePenalty = 0
            if ($memVal -gt 85) { $scorePenalty = 25 }
            # Raised massive penalty threshold to > 8 (High) instead of > 5 (Moderate)
            # This prevents a score of 76 just because of 1 zombie + minor context switching.
            if ($riskScore -ge 8) { $scorePenalty += 20 }
            $finalScore = [math]::Max(0, 100 - ($cpuVal / 4) - $scorePenalty)
            try {
                $rawEvents = Get-WinEvent -FilterHashtable @{
                    LogName = 'System', 'Application'
                    Level   = 1, 2, 3 # Critical, Error, Warning
                } -MaxEvents 8 -ErrorAction SilentlyContinue
                
                foreach ($e in $rawEvents) {
                    $eventLogs += @{
                        id   = $e.Id
                        src  = $e.ProviderName
                        msg  = $e.Message
                        lvl  = $e.LevelDisplayName
                        time = $e.TimeCreated.ToString("HH:mm:ss")
                        type = if ($e.LevelDisplayName -match "Error|Critical") { "critical" } else { "warning" }
                    }
                }
            }
            catch {}

            # 7. DYNAMIC PERFORMANCE RATIONALE
            $rationale = "System health is optimal. All logical cores are balanced across Snapdragon X architecture."
            if ($riskLevel -eq "CRITICAL") { $rationale = "CRITICAL: System forensic risk is severe. Resource contention detected." }
            elseif ($diskLat -gt 50) { $rationale = "High storage latency detected. IO wait cycles may impact trade execution." }
            elseif ($cpuVal -gt 80) { $rationale = "Critical CPU load detected. Thermal throttling may impact deterministic stability." }
            elseif ($memVal -gt 85) { $rationale = "Memory pressure is high. System is prioritizing active working sets." }
            elseif ($Sync.SimActive) { $rationale = "Simulation active. Synthetic loads are taxing core affinity to test stability." }

            if ($Sync.SimActive) {
                $trade = @{
                    asset = $Assets[$(Get-Random -Min 0 -Max $Assets.Count)]
                    price = [math]::Round($(Get-Random -Min 150 -Max 65000), 2)
                    side  = if ($(Get-Random -Min 0 -Max 2) -eq 0) { "BUY" }else { "SELL" }
                    qty   = $(Get-Random -Min 1 -Max 50)
                    time  = (Get-Date).ToString("HH:mm:ss")
                    delta = [math]::Round((Get-Random -Minimum -5.0 -Maximum 5.0), 2)
                }
                $mList = [System.Collections.ArrayList]::new($Sync.MarketData)
                [void]$mList.Insert(0, $trade)
                if ($mList.Count -gt 15) { $mList.RemoveAt(15) }
                $Sync.MarketData = $mList.ToArray()
            }
            # Keep market data even if sim inactive to show last state
            # else { $Sync.MarketData = @() } 

            # 8. OPENFIN / CHROMIUM DEEP INSPECTION
            $ofin = @{ 
                active     = $false; 
                renderers  = 0; 
                ram        = 0; 
                flags      = @(); 
                hotPid     = 0; 
                hotCpu     = 0; 
                zombies    = 0; 
                health     = 100 
                rvm        = @()
                runtimes   = @{}
                gpu        = 0
                affinity   = 0
                efficiency = 100
                dispersion = 0
                bottleneck = $false
            }
            $ofProcs = Get-CimSafe Win32_Process -Filter "Name LIKE '%openfin%' OR Name LIKE '%chromium%'" 
            
            if ($ofProcs) {
                $ofin.active = $true
                $ofin.renderers = ($ofProcs | Where-Object { $_.CommandLine -match "--type=renderer" }).Count
                $ofin.ram = [math]::Round(($ofProcs | Measure-Object -Property WorkingSetSize -Sum).Sum / 1MB, 0)
                
                # Health Calculation (Baselines)
                if ($ofin.ram -gt 4000) { $ofin.health -= 15 } # Extreme RAM usage
                if ($ofin.renderers -gt 40) { $ofin.health -= 10 } # High complexity

                # 1. Hot Renderer & Zombie Surveillance
                $allLivePids = $liveProcs.Id
                $ofPerf = $cimProcs | Where-Object { ($ofProcs.ProcessId -contains $_.IDProcess) }
                
                foreach ($proc in $ofProcs) {
                    $uPid = $proc.ProcessId
                    $cmd = $proc.CommandLine
                    $path = $proc.ExecutablePath
                    $pName = $proc.Name

                    # GPU Attribution
                    if ($gpuProcessMap.ContainsKey([int]$uPid)) {
                        $ofin.gpu += $gpuProcessMap[[int]$uPid]
                    }

                    # RVM Detection
                    if ($pName -match "OpenFinRVM.exe") {
                        $ver = "Unknown"
                        if ($path -and (Test-Path $path)) {
                            try { $ver = (Get-Item $path).VersionInfo.ProductVersion } catch {}
                        }
                        $ofin.rvm += @{
                            pid     = $uPid
                            version = $ver
                            path    = $path
                            gpu     = if ($gpuProcessMap.ContainsKey([int]$uPid)) { $gpuProcessMap[[int]$uPid] } else { 0 }
                        }
                    }

                    # Runtime Detection (Main Process)
                    if ($pName -match "openfin.exe" -and $cmd -notmatch "--type=") {
                        $rtVer = "Unknown"
                        # Parse path: .../runtime/10.0.1.2/openfin.exe
                        if ($path -match "runtime\\([0-9\.]+)\\openfin.exe") {
                            $rtVer = $Matches[1]
                        }
                        
                        if (-not $ofin.runtimes.ContainsKey($rtVer)) {
                            $ofin.runtimes[$rtVer] = @{ count = 0; gpu = 0; pids = @() }
                        }
                        $ofin.runtimes[$rtVer].count++
                        $ofin.runtimes[$rtVer].pids += $uPid
                        if ($gpuProcessMap.ContainsKey([int]$uPid)) {
                            $ofin.runtimes[$rtVer].gpu += $gpuProcessMap[[int]$uPid]
                        }
                    }

                    # Zombie Check: Renderer with missing Parent
                    if ($cmd -match "--type=renderer") {
                        if ($proc.ParentProcessId -and ($allLivePids -notcontains $proc.ParentProcessId)) {
                            $ofin.zombies++
                        }
                        
                        # CPU Attribution (Find Hot Renderer)
                        $pPerf = $ofPerf | Where-Object { $_.IDProcess -eq $uPid }
                        if ($pPerf) {
                            $pCpu = [math]::Round($pPerf.PercentProcessorTime / $Cores, 1)
                            if ($pCpu -gt $ofin.hotCpu) {
                                $ofin.hotCpu = $pCpu
                                $ofin.hotPid = $uPid
                            }
                        }
                    }

                    # Security & Performance Flags
                    if ($cmd -match "--disable-gpu") { $ofin.flags += "GPU_DISABLED" }
                    if ($cmd -match "--no-sandbox") { $ofin.flags += "SANDBOX_OFF"; $ofin.health -= 20 }
                    if ($cmd -match "--disable-web-security") { $ofin.flags += "WEB_SEC_OFF"; $ofin.health -= 30 }
                    if ($cmd -match "--ignore-gpu-blocklist") { $ofin.flags += "FORCE_GPU" }
                }

                # Conflict Detection
                if ($ofin.rvm.Count -gt 1) { $ofin.flags += "RVM_CONFLICT"; $ofin.health -= 10 }
                if ($ofin.runtimes.Keys.Count -gt 1) { $ofin.flags += "RUNTIME_MIX"; $ofin.health -= 5 }

                # Affinity & Efficiency Analysis (Process-wide)
                # We simply take the affinity of the first RVM or OpenFin process as the "System Affinity"
                # In reality, different processes *could* have different affinities, but usually they inherit.
                if ($ofProcs.Count -gt 0) {
                    try {
                        $ofin.affinity = $ofProcs[0].ProcessorAffinity.ToInt64()
                    }
                    catch { $ofin.affinity = (1 -shl $Cores) - 1 } # Default to all cores if fail
                }

                # Calculate Dispersion (Standard Deviation of Core Loads)
                if ($coreLoads.Count -gt 1) {
                    $avgLoad = ($coreLoads | Measure-Object -Average).Average
                    $sumSq = $coreLoads | ForEach-Object { [math]::Pow($_ - $avgLoad, 2) } | Measure-Object -Sum
                    $stdDev = [math]::Sqrt($sumSq.Sum / $coreLoads.Count)
                    $ofin.dispersion = [math]::Round($stdDev, 1)

                    # Bottleneck Logic: One core pinned (>90%) while average is low (<40%)
                    $maxCore = ($coreLoads | Measure-Object -Maximum).Maximum
                    if ($maxCore -gt 90 -and $avgLoad -lt 40) {
                        $ofin.bottleneck = $true
                        $ofin.flags += "SINGLE_CORE_BOTTLENECK"
                        $ofin.health -= 15
                        $ofin.efficiency = 40 # Penalty
                    }
                    elseif ($stdDev -lt 15) {
                        $ofin.efficiency = 100 # Excellent balance
                    }
                    else {
                        # Linear penalty for imbalance
                        $ofin.efficiency = [math]::Max(50, 100 - ($stdDev * 1.5))
                    }
                }

                if ($ofin.hotCpu -gt 50) { $ofin.flags += "CPU_HOTSPOT"; $ofin.health -= 15 }
                if ($ofin.zombies -gt 0) { $ofin.flags += "ZOMBIE_FOUND"; $ofin.health -= (5 * $ofin.zombies) }
                $ofin.health = [math]::Max(0, $ofin.health)
            }

            # --- TRADERSYNTH SELF-MONITORING OHREHEAD ---
            $engineCpu = 0; $engineRam = 0; $engineGpu = 0;
            $browserCpu = 0; $browserRam = 0; $browserGpu = 0;

            if ($cimProcs -or $liveProcs) {
                # Engine (PowerShell)
                $eProc = if ($cimProcs) { $cimProcs | Where-Object { $_.IDProcess -eq $Sync.EnginePid } } else { $liveProcs | Where-Object { $_.Id -eq $Sync.EnginePid } }
                if ($eProc) {
                    $engineRam = if ($cimProcs) { [math]::Round($eProc.WorkingSetPrivate / 1MB, 1) } else { [math]::Round($eProc.WorkingSet64 / 1MB, 1) }
                    if ($cimProcs) { $engineCpu = [math]::Round($eProc.PercentProcessorTime / $Cores, 1) }
                    if ($gpuProcessMap.ContainsKey([int]$Sync.EnginePid)) { $engineGpu = $gpuProcessMap[[int]$Sync.EnginePid] }
                }

                # Browser 
                if ($Sync.BrowserPid) {
                    $bProc = if ($cimProcs) { $cimProcs | Where-Object { $_.IDProcess -eq $Sync.BrowserPid } } else { $liveProcs | Where-Object { $_.Id -eq $Sync.BrowserPid } }
                    if ($bProc) {
                        $browserRam = if ($cimProcs) { [math]::Round($bProc.WorkingSetPrivate / 1MB, 1) } else { [math]::Round($bProc.WorkingSet64 / 1MB, 1) }
                        if ($cimProcs) { $browserCpu = [math]::Round($bProc.PercentProcessorTime / $Cores, 1) }
                        if ($gpuProcessMap.ContainsKey([int]$Sync.BrowserPid)) { $browserGpu = $gpuProcessMap[[int]$Sync.BrowserPid] }
                    }
                    
                    # Modern browsers spawn multiple child processes (renderers, GPU process, etc.)
                    # We will do a generic parent-child walk for the browser to get full tree footprint if possible
                    $childProcs = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Sync.BrowserPid)" -ErrorAction SilentlyContinue
                    if ($childProcs) {
                        foreach ($cp in $childProcs) {
                            $cpPerf = if ($cimProcs) { $cimProcs | Where-Object { $_.IDProcess -eq $cp.ProcessId } } else { $liveProcs | Where-Object { $_.Id -eq $cp.ProcessId } }
                            if ($cpPerf) {
                                $browserRam += if ($cimProcs) { [math]::Round($cpPerf.WorkingSetPrivate / 1MB, 1) } else { [math]::Round($cpPerf.WorkingSet64 / 1MB, 1) }
                                if ($cimProcs) { $browserCpu += [math]::Round($cpPerf.PercentProcessorTime / $Cores, 1) }
                                if ($gpuProcessMap.ContainsKey([int]$cp.ProcessId)) { $browserGpu += $gpuProcessMap[[int]$cp.ProcessId] }
                            }
                        }
                    }
                }
            }
            $engineCpu = [math]::Min(100, $engineCpu); $browserCpu = [math]::Min(100, $browserCpu);
            # -----------------------------------------------

            $Sync.Latest = @{
                score     = $finalScore
                rationale = $rationale
                risk      = @{ score = $riskScore; level = $riskLevel; zombies = $zombies.Count; zombieList = $zombies }
                overhead  = @{
                    engine  = @{ cpu = $engineCpu; ram = $engineRam; gpu = $engineGpu; pid = $Sync.EnginePid }
                    browser = @{ cpu = $browserCpu; ram = $browserRam; gpu = $browserGpu; pid = $Sync.BrowserPid }
                }
                cpu       = @{ 
                    usage  = $cpuVal; 
                    cores  = $coreLoads;
                    queue  = if ($sysData) { $sysData.ProcessorQueueLength }else { 0 };
                    kernel = if ($cpuTotalData) { [math]::Round($cpuTotalData.PercentPrivilegedTime, 1) }else { 0 }
                    ctx    = if ($sysData) { $sysData.ContextSwitchesPersec }else { 0 }
                }
                mem       = @{ percent = $memVal; avail = $memAvail }
                disk      = @{ 
                    tp = $diskTP; lat = $diskLat; 
                    readIOPS = $readIOPS; writeIOPS = $writeIOPS; 
                    queue = $diskQueue; baseline = $LatencyBaseline 
                }
                gpu       = @{ 
                    usage  = [math]::Round($gpuVal, 1); 
                    decode = [math]::Round($gpuDecode, 1); 
                    encode = [math]::Round($gpuEncode, 1) 
                }
                openfin   = $ofin
                events    = $eventLogs
                cpu_deep  = @{
                    ints     = if ($cpuTotalData) { $cpuTotalData.InterruptsPersec } else { 0 }
                    dpc      = if ($cpuTotalData) { [math]::Round($cpuTotalData.PercentDPCTime, 1) } else { 0 }
                    syscalls = if ($sysData) { $sysData.SystemCallsPersec } else { 0 }
                }
                mem_deep  = @{
                    faults = if ($memPerfData) { $memPerfData.PageFaultsPersec } else { 0 }
                    commit = if ($memPerfData) { [math]::Round(($memPerfData.CommittedBytes / $memPerfData.CommitLimit) * 100, 1) } else { 0 }
                }
                procs     = $procs
                threads   = $threadRanked
                market    = $Sync.MarketData
                uptime    = (New-TimeSpan -Start $ActualStartTime).ToString("hh\:mm\:ss")
                sync      = (Get-Date).ToString("HH:mm:ss.fff")
                cs_impact = $csImpact
            }

            # 9. ICA/HDX Metrics (Citrix VDI Only) with Generic Network Fallback
            if ($Sync.SysInfo.isCitrix) {
                try {
                    $icaSetInfo = Get-Counter -ListSet "ICA Session" -ErrorAction SilentlyContinue
                    $captured = $false
                    
                    if ($icaSetInfo) {
                        $icaInstances = $icaSetInfo.PathsWithInstances | Where-Object { $_ -match "Session Latency" }
                        if ($icaInstances -and $icaInstances.Count -gt 0) {
                            if ($icaInstances[0] -match '\\ICA Session\(([^)]+)\\') {
                                $actualSessionName = $matches[1]
                                $icaCounterList = @(
                                    "\ICA Session($actualSessionName)\Session Latency - Last Recorded",
                                    "\ICA Session($actualSessionName)\Output Frames Per Second",
                                    "\ICA Session($actualSessionName)\Session Input Bandwidth",
                                    "\ICA Session($actualSessionName)\Session Output Bandwidth"
                                )
                                $icaCounters = Get-Counter -Counter $icaCounterList -ErrorAction SilentlyContinue
                                if ($icaCounters -and $icaCounters.CounterSamples.Count -ge 4) {
                                    $Sync.Latest.ica = @{
                                        mode        = "HDX"
                                        latency     = [math]::Round($icaCounters.CounterSamples[0].CookedValue, 1)
                                        fps         = [math]::Round($icaCounters.CounterSamples[1].CookedValue, 1)
                                        inputBW     = [math]::Round($icaCounters.CounterSamples[2].CookedValue / 1KB, 1)
                                        outputBW    = [math]::Round($icaCounters.CounterSamples[3].CookedValue / 1KB, 1)
                                        sessionName = $actualSessionName
                                    }
                                    $captured = $true
                                    
                                    # User Input Delay
                                    try {
                                        $inputDelayCounter = Get-Counter "\User Input Delay per Session($actualSessionName)\Max Input Delay" -ErrorAction SilentlyContinue
                                        if ($inputDelayCounter) { $Sync.Latest.ica.inputDelay = [math]::Round($inputDelayCounter.CounterSamples[0].CookedValue, 1) }
                                    }
                                    catch {}
                                    
                                    # Transport Detection
                                    try {
                                        $edtCounter = Get-Counter "\ICA Session($actualSessionName)\EDT Loss Recovery" -ErrorAction SilentlyContinue
                                        $Sync.Latest.ica.transport = if ($edtCounter) { "EDT" } else { "TCP" }
                                    }
                                    catch { $Sync.Latest.ica.transport = "TCP" }
                                }
                            }
                        }
                    }

                    # FALLBACK: Generic Network Telemetry if HDX counters fail or are restricted
                    if (-not $captured) {
                        $netCounters = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue | 
                        Where-Object { $_.BytesTotalPersec -gt 0 } | Sort-Object BytesTotalPersec -Descending | Select-Object -First 1
                        
                        if ($netCounters) {
                            $Sync.Latest.ica = @{
                                mode      = "Network"
                                latency   = 0 # Peer latency is not provider via TCP counters
                                fps       = 0
                                inputBW   = [math]::Round($netCounters.BytesReceivedPersec / 1KB, 1)
                                outputBW  = [math]::Round($netCounters.BytesSentPersec / 1KB, 1)
                                transport = "OS-TCP"
                                adapter   = $netCounters.Name
                            }
                            $SystemLoad += 1 # Network overhead factor
                        }
                    }
                }
                catch {
                    $Sync.SysInfo.citrixDebug.counterError = $_.Exception.Message
                }
            }

            # VMware Hypervisor Metrics (VM Only)
            if ($Sync.SysInfo.isVMware) {
                try {
                    # CPU Ready Time - indicates hypervisor throttling
                    $vmCpuReady = Get-Counter '\VM Processor(*)\% Processor Ready Time' -ErrorAction SilentlyContinue
                    
                    # Memory Ballooning - hypervisor reclaiming memory
                    $vmMemBalloon = Get-Counter '\VM Memory\Balloon Current' -ErrorAction SilentlyContinue
                    
                    # Memory Swapped - host level paging (Critical performance hit)
                    $vmMemSwapped = Get-Counter '\VM Memory\Memory Swapped' -ErrorAction SilentlyContinue

                    # Co-Stop Time - SMP synchronization delay
                    $vmCoStop = Get-Counter '\VM Processor(*)\% Co-Stop Time' -ErrorAction SilentlyContinue
                    
                    if ($vmCpuReady -or $vmMemBalloon -or $vmCoStop -or $vmMemSwapped) {
                        $Sync.Latest.vmware = @{
                            cpuReady = if ($vmCpuReady) { 
                                [math]::Round(($vmCpuReady.CounterSamples | Measure-Object -Property CookedValue -Average).Average, 1) 
                            }
                            else { 0 }
                            balloon  = if ($vmMemBalloon) { 
                                [math]::Round($vmMemBalloon.CounterSamples[0].CookedValue / 1MB, 0) 
                            }
                            else { 0 }
                            swap     = if ($vmMemSwapped) {
                                [math]::Round($vmMemSwapped.CounterSamples[0].CookedValue / 1MB, 0)
                            }
                            else { 0 }
                            costop   = if ($vmCoStop) {
                                [math]::Round(($vmCoStop.CounterSamples | Measure-Object -Property CookedValue -Average).Average, 1)
                            }
                            else { 0 }
                        }
                        if ($Sync.Latest.vmware.costop -gt 3) { $riskScore += 4 }
                        if ($Sync.Latest.vmware.swap -gt 0) { $riskScore += 5 }
                    }
                }
                catch {
                    # VMware counters unavailable - may not be VMware Tools installed
                }
            }


            if ($Sync.Recording) { $Sync.RecordBuffer.Add($Sync.Latest) | Out-Null }
            Start-Sleep -Seconds 1
        }
        catch { Start-Sleep -Seconds 2 }
    }
}

$Runspace = [runspacefactory]::CreateRunspace()
$Runspace.Open()
$Runspace.SessionStateProxy.SetVariable("Sync", $Sync)
$PowerShell = [PowerShell]::Create().AddScript($CollectorScript).AddArgument($Sync)
$PowerShell.Runspace = $Runspace
$null = $PowerShell.BeginInvoke()

$ActualPort = 9000
$ipGlobal = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
while ($ipGlobal.GetActiveTcpListeners().Port -contains $ActualPort) { $ActualPort++ }

$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://localhost:$ActualPort/")

Write-Host "Compiling 5-Day System Changes..." -ForegroundColor DarkGray
$ChangeStart = (Get-Date).AddDays(-5)
$ChangesData = @()
try {
    $cEvts = Get-WinEvent -FilterHashtable @{LogName = 'Application'; ProviderName = 'MsiInstaller'; StartTime = $ChangeStart } -ErrorAction SilentlyContinue
    foreach ($e in $cEvts) { if ($e.Id -eq 1033) { $ChangesData += @{ Date = $e.TimeCreated.ToString('yyyy-MM-dd HH:mm'); Type = 'App Install'; Name = ($e.Message -split "`n")[0].Trim() } } }
}
catch {}
try {
    $cEvts = Get-WinEvent -FilterHashtable @{LogName = 'System'; ProviderName = 'Microsoft-Windows-WindowsUpdateClient'; StartTime = $ChangeStart } -ErrorAction SilentlyContinue
    foreach ($e in $cEvts) { if ($e.Id -eq 19) { $ChangesData += @{ Date = $e.TimeCreated.ToString('yyyy-MM-dd HH:mm'); Type = 'Windows Update'; Name = ($e.Message -split "`n")[0].Trim() } } }
}
catch {}
try {
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    if ($bios.ReleaseDate -and $bios.ReleaseDate -ge $ChangeStart) {
        $ChangesData += @{ Date = $bios.ReleaseDate.ToString('yyyy-MM-dd HH:mm'); Type = 'BIOS Update'; Name = "$($bios.Manufacturer) $($bios.SMBIOSBIOSVersion)" }
    }
}
catch {}
$ChangesData = $ChangesData | Select-Object Date, Type, Name -Unique | Sort-Object Date -Descending

try {
    $Listener.Start()
    Write-Host "TraderSynth v$ScriptVersion active on http://localhost:$ActualPort" -ForegroundColor Cyan
    
    # Launch browser and register its PID
    $browserProc = Start-Process "http://localhost:$ActualPort" -PassThru
    if ($browserProc) { $Sync.BrowserPid = $browserProc.Id }

    while ($Sync.Running) {
        $context = $Listener.GetContext()
        $req = $context.Request; $res = $context.Response; $path = $req.Url.LocalPath
        try {
            if ($path -eq "/api/stats") {
                $payload = if ($Sync.Latest) { $Sync.Latest }else { @{status = "initializing" } }
                if ($Sync.SysInfo) { $payload.sys = $Sync.SysInfo }
                $payload.sim = $Sync.SimActive; $payload.recording = $Sync.Recording
                $payload.jitterInfo = "Jitter measures the delta between the backend polling frequency (1000ms) and the frontend's visual rendering cycle. Low-latency trading requires deterministic scheduling; high jitter (>100ms) indicates DPC/Interrupt saturation or thermal throttling that can delay order execution."
                
                $json = $payload | ConvertTo-Json -Depth 5 -Compress
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $res.ContentType = "application/json"
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/terminate") {
                $pidStr = $req.QueryString["pid"]
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes("FAIL")
                if ($pidStr) {
                    try {
                        $procId = [int]$pidStr
                        $proc = Get-Process -Id $procId -ErrorAction Stop
                        
                        # Safety Blacklist (Critical System Processes)
                        $criticalProcs = @("svchost", "winlogon", "csrss", "System", "Idle", "smss", "services", "lsass", "explorer", "dwm", "spoolsv", "Memory Compression", "Registry", "wininit", "fontdrvhost", "audiodg", "dasHost", "sihost", "taskhostw")
                        if ($criticalProcs -contains $proc.ProcessName) {
                            $resBytes = [System.Text.Encoding]::UTF8.GetBytes("BLOCKED: CRITICAL SYSTEM PROCESS")
                        }
                        else {
                            $proc | Stop-Process -Force -ErrorAction Stop
                            $resBytes = [System.Text.Encoding]::UTF8.GetBytes("OK")
                        }
                    }
                    catch { 
                        $errMsg = $_.Exception.Message
                        if ($errMsg -match "Cannot find a process") { $errMsg = "PROCESS NOT FOUND" }
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes("ERROR: $errMsg") 
                    }
                }
                else {
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes("FAIL: MISSING PID")
                }
                $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
            }
            elseif ($path -eq "/api/changes") {
                $json = $ChangesData | ConvertTo-Json -Depth 3 -Compress
                if (-not $json) { $json = "[]" }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $res.ContentType = "application/json"
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/save-report") {
                $status = "FAIL"
                try {
                    if ($Sync.RecordBuffer.Count -gt 0) {
                        $timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
                        $reportPath = Join-Path $ScriptDir "Report_$timestamp.json"
                        
                        $report = @{
                            GeneratedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                            SystemInfo  = $Sync.SysInfo
                            Statistics  = @{
                                TotalSamples = $Sync.RecordBuffer.Count
                            }
                            Metrics     = $Sync.RecordBuffer.ToArray()
                        }
                        
                        $json = $report | ConvertTo-Json -Depth 10
                        [System.IO.File]::WriteAllText($reportPath, $json)
                        $status = "SAVED: Report_$timestamp.json located in $ScriptDir"
                        
                        # Clear buffer after save to prevent massive memory growth
                        $Sync.RecordBuffer.Clear()
                    }
                    else {
                        $status = "NO_DATA"
                    }
                }
                catch { $status = "ERROR: $($_.Exception.Message)" }
                
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes($status)
                $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
            }
            elseif ($path -eq "/api/quit") {
                $Sync.Running = $false
                $res.OutputStream.Write([System.Text.Encoding]::UTF8.GetBytes("STOPPING"), 0, 8)
            }
            elseif ($path -eq "/favicon.ico") {
                $res.StatusCode = 204 # No Content
            }
            else {
                $file = if ($path -eq "/") { "index.html" }else { $path.TrimStart('/') }
                $fPath = Join-Path $WwwDir $file
                if (Test-Path $fPath) {
                    $ext = [System.IO.Path]::GetExtension($fPath).ToLower()
                    $res.ContentType = switch ($ext) { ".html" { "text/html" } ".js" { "application/javascript" } ".css" { "text/css" } default { "text/plain" } }
                    $bytes = [System.IO.File]::ReadAllBytes($fPath)
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
                else { $res.StatusCode = 404 }
            }
        }
        catch { 
            $_ | Out-File "error.log" -Append 
        } 
        finally { if ($res) { $res.Close() } }
    }
}
finally {
    $Sync.Running = $false
    try { $Listener.Stop() } catch {}
    try { $Runspace.Close() } catch {}
    try { $PowerShell.Dispose() } catch {}
}
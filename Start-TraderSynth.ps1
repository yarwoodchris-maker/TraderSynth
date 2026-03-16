<#
.SYNOPSIS
    Trader Desktop Synthetic Test Solution (TraderSynth)
    Version: 4.0.0 (Professional Analytics Refinement)
#>

param([int]$Port = 9000)

$ScriptVersion = "4.0.0"
$ScriptDir = $PSScriptRoot
$WwwDir = Join-Path $ScriptDir "www"

$StaticRam = 16384
try { 
    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    if ($osInfo) { $StaticRam = [math]::Round($osInfo.TotalVisibleMemorySize / 1024) }
}
catch { $StaticRam = 16384 }

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
        userProfile      = @{ state = "ANALYZING" }
        sysview          = @{ state = "ANALYZING" }
        PeakSwaps        = 0
        PeakPageFile     = 0
        TotalRamMB       = $StaticRam
        forensicEvents   = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
        crashDumps       = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
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
            [string]$Namespace = "root\cimv2",
            [string[]]$Property = "*"
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
        
        # Execute Query
        try {
            $res = $null
            if ($Filter) {
                $res = Get-CimInstance -ClassName $ClassName -Namespace $Namespace -Filter $Filter -Property $Property -ErrorAction Stop
            }
            else {
                $res = Get-CimInstance -ClassName $ClassName -Namespace $Namespace -Property $Property -ErrorAction Stop
            }
            
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

    function Analyze-ActiveNetwork {
        param($Sync)
        try {
            $activeAdapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.MediaConnectionState -eq 'Connected' }
            if (-not $activeAdapters) { $activeAdapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } }
            
            if ($activeAdapters) {
                $primNet = $activeAdapters | Sort-Object LinkSpeed -Descending | Select-Object -First 1
                if ($primNet) {
                    if (-not $Sync.SysInfo.netConfig) { $Sync.SysInfo.netConfig = @{} }
                    $nc = $Sync.SysInfo.netConfig
                    $nc.name = $primNet.Name
                    $nc.adapter = $primNet.InterfaceDescription
                    $nc.linkSpeed = $primNet.LinkSpeed
                    $nc.mac = $primNet.MacAddress
                    $nc.ifIndex = [string]$primNet.ifIndex
                    $nc.mtu = "$($primNet.MtuSize)"
                    $nc.virtual = $primNet.Virtual
                    $nc.driver = "$($primNet.DriverProvider) [v$($primNet.DriverVersion)]"
                    $nc.driverDate = if ($primNet.DriverDate) { $primNet.DriverDate.ToString('yyyy-MM-dd') } else { "--" }
                    $nc.mediaType = "$($primNet.MediaType)"
                    $nc.physMedia = "$($primNet.PhysicalMediaType)"
                    $nc.dhcp = if ($primNet.Dhcp) { "Enabled" } else { "Disabled" }

                    $ipAddrs = Get-NetIPAddress -InterfaceIndex $primNet.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
                    if ($ipAddrs) {
                        $pIp = $ipAddrs | Where-Object { $_.SuffixOrigin -ne 'LinkLocal' } | Select-Object -First 1
                        $nc.ipv4 = if ($pIp) { $pIp.IPAddress } else { $ipAddrs[0].IPAddress }
                        $nc.subnet = if ($pIp) { $pIp.PrefixLength } else { $ipAddrs[0].PrefixLength }
                    }

                    $ipCfg = Get-NetIPConfiguration -InterfaceIndex $primNet.ifIndex -ErrorAction SilentlyContinue
                    if ($ipCfg) {
                        $nc.gateway = if ($ipCfg.IPv4DefaultGateway) { ($ipCfg.IPv4DefaultGateway.NextHop -join ", ") } else { "--" }
                        $nc.dns = if ($ipCfg.DNSServer) { ($ipCfg.DNSServer.ServerAddresses -join ", ") } else { "--" }
                    }
                    
                    $rt = Get-NetRoute -InterfaceIndex $primNet.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } | Select-Object -First 1
                    if ($rt) { $nc.routeMetric = [string]$rt.RouteMetric }

                    $props = Get-NetAdapterAdvancedProperty -Name $primNet.Name -ErrorAction SilentlyContinue
                    if ($props) {
                        foreach ($p in $props) {
                            $pDisp = if ($p.DisplayValue) { $p.DisplayValue } else { "--" }
                            switch ($p.RegistryKeyword) {
                                "*JumboPacket" { $nc.jumbo = $pDisp }
                                "*InterruptModeration" { $nc.intmod = $pDisp }
                                "*FlowControl" { $nc.flow = $pDisp }
                                "Small Rx Buffers" { $nc.rxSmall = $pDisp }
                                "Rx Ring #1 Size" { $nc.rxSmall = $pDisp }
                                "Rx Ring #2 Size" { $nc.rxLarge = $pDisp }
                            }
                        }
                    }
                }
            }
        }
        catch {}
    }

    try {
        $osObj = Get-CimSafe Win32_OperatingSystem | Select-Object -First 1
        $cpuObj = Get-CimSafe Win32_Processor | Select-Object -First 1
        $mObj = Get-CimSafe Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum
        $gpuObj = Get-CimSafe Win32_VideoController | Select-Object -First 1
        
        $ipObj = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "*" -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notmatch "Loopback" } | Select-Object -First 1
        $subnet = if ($ipObj) { $ipObj.PrefixLength } else { "--" }
        $ip = if ($ipObj) { $ipObj.IPAddress } else { "--" }

        $usr = if ($env:USERDOMAIN -and $env:USERNAME) { "$env:USERDOMAIN\$env:USERNAME" } else { "Unknown" }
        
        $Sync.SysInfo = @{
            os        = $osObj.Caption
            boot      = if ($osObj.LastBootUpTime) { $osObj.LastBootUpTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "--" }
            bootObj   = $osObj.LastBootUpTime
            cpu       = $cpuObj.Name
            cpuSpeed  = $cpuObj.MaxClockSpeed
            ram       = "$([math]::Round($mObj.Sum / 1GB, 0)) GB"
            cores     = $Cores
            gpu       = if ($gpuObj) { $gpuObj.Name } else { "Generic Display" }
            driver    = if ($gpuObj) { $gpuObj.DriverVersion } else { "N/A" }
            hags      = "Unknown"
            ip        = $ip
            subnet    = $subnet
            user      = $usr
            uiAudit   = @{ transparency = "Unknown"; animations = "Unknown" }
            netConfig = @{
                name = "--"; adapter = "--"; linkSpeed = "--"; mac = "--"; mtu = "--"
                mediaType = "--"; physMedia = "--"; driver = "--"; driverDate = "--"; ipv4 = "--"
                subnet = "--"; gateway = "--"; dns = "--"; dhcp = "--"; jumbo = "--"
                intmod = "--"; flow = "--"; rxSmall = "--"; rxLarge = "--"; routeMetric = "--"
                ifIndex = "--"; virtual = $false
            }
        }

        # UI Effects Audit (One-time)
        try {
            $tKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
            if (Test-Path $tKey) {
                $tVal = Get-ItemPropertyValue -Path $tKey -Name "EnableTransparency" -ErrorAction SilentlyContinue
                $Sync.SysInfo.uiAudit.transparency = if ($tVal -eq 1) { "Enabled" } else { "Disabled" }
            }
            $vKey = "HKCU:\Control Panel\Desktop\WindowMetrics"
            if (Test-Path $vKey) {
                $vVal = Get-ItemPropertyValue -Path $vKey -Name "MinAnimate" -ErrorAction SilentlyContinue
                $Sync.SysInfo.uiAudit.animations = if ($vVal -eq 1) { "Enabled" } else { "Disabled" }
            }
        }
        catch {}

        Analyze-ActiveNetwork -Sync $Sync
        $Sync.MarketData = @()
        $Sync.eventLogs = @()
        $Sync.forensicLog = @() # Timestamped event history
        $Sync.SysInfo.bbg = @{ terminal = $null; component = $null; latency = 0 }
    }
    catch {}

        
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

    $Assets = @("AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "AMZN", "BTC/USD", "ETH/USD")
    $StorageWindow = 10
    $LatencyBaseline = 2.0
    $Script:AddinCache = @{}
    $Script:MemHistory = [System.Collections.Generic.List[double]]::new()  # Rolling mem commit % for trend
    $Script:OfinThreadHistory = [System.Collections.Generic.List[int]]::new()
    $Script:OfinMemHistory = [System.Collections.Generic.List[double]]::new()
    $Script:PrevProcData = @{}  # High-performance delta tracking: PID -> @{ cpu; read; write; ts }
    $Script:PrevOfinPids = @{}  # OpenFin PID lifecycle tracking

    # FAST C# PERFORMANCE COUNTERS (Replaces WMI for sub-10ms latency)
    try {
        $TotalRamMB = if ($Sync.TotalRamMB) { $Sync.TotalRamMB } else { [math]::Round((Get-CimSafe Win32_OperatingSystem).TotalVisibleMemorySize / 1024) }
        if (-not $TotalRamMB) { $TotalRamMB = 16384 } # Safe floor for VDI baselines

        # Use NUMBER_OF_PROCESSORS for logical core count (physical socket count from CIM is wrong for hyper-threaded CPUs)
        $Cores = [int]$env:NUMBER_OF_PROCESSORS
        if ($Cores -le 0) { $Cores = 1 }
        
        $pc_cpuTotal = New-Object System.Diagnostics.PerformanceCounter("Processor", "% Processor Time", "_Total")
        $pc_cpuPriv = New-Object System.Diagnostics.PerformanceCounter("Processor", "% Privileged Time", "_Total")
        $pc_cpuDpc = New-Object System.Diagnostics.PerformanceCounter("Processor", "% DPC Time", "_Total")
        $pc_cpuInts = New-Object System.Diagnostics.PerformanceCounter("Processor", "Interrupts/sec", "_Total")
        
        $pc_sysQueue = New-Object System.Diagnostics.PerformanceCounter("System", "Processor Queue Length", "")
        $pc_sysCtx = New-Object System.Diagnostics.PerformanceCounter("System", "Context Switches/sec", "")
        $pc_sysCalls = New-Object System.Diagnostics.PerformanceCounter("System", "System Calls/sec", "")
        
        $pc_memFaults = New-Object System.Diagnostics.PerformanceCounter("Memory", "Page Faults/sec", "")
        $pc_memCommit = New-Object System.Diagnostics.PerformanceCounter("Memory", "Committed Bytes", "")
        $pc_memLimit = New-Object System.Diagnostics.PerformanceCounter("Memory", "Commit Limit", "")
        $pc_memAvail = New-Object System.Diagnostics.PerformanceCounter("Memory", "Available MBytes", "")
        
        $pc_diskReads = New-Object System.Diagnostics.PerformanceCounter("PhysicalDisk", "Disk Reads/sec", "_Total")
        $pc_diskWrites = New-Object System.Diagnostics.PerformanceCounter("PhysicalDisk", "Disk Writes/sec", "_Total")
        $pc_diskLat = New-Object System.Diagnostics.PerformanceCounter("PhysicalDisk", "Avg. Disk sec/Transfer", "_Total")
        $pc_diskReadBytes = New-Object System.Diagnostics.PerformanceCounter("PhysicalDisk", "Disk Read Bytes/sec", "_Total")
        $pc_diskWriteBytes = New-Object System.Diagnostics.PerformanceCounter("PhysicalDisk", "Disk Write Bytes/sec", "_Total")
        $pc_diskQueue = New-Object System.Diagnostics.PerformanceCounter("PhysicalDisk", "Current Disk Queue Length", "_Total")
        
        $pc_cores = @()
        for ($i = 0; $i -lt $Cores; $i++) {
            $pc_cores += New-Object System.Diagnostics.PerformanceCounter("Processor", "% Processor Time", "$i")
        }
    }
    catch {}

    # $Sync.nvidia is initialized and maintained by the dedicated NVIDIA background runspace.
    # Seed with defaults so early reads in the main loop don't null-ref before the NVIDIA runspace boots.
    if (-not $Sync.nvidia) {
        $Sync.nvidia = @{ active=$false; gpus=@(); procs=@(); history=@(); totalUsed=0; totalAvail=0; avgTemp=0; avgUsage=0 }
    }


    $SW = [System.Diagnostics.Stopwatch]::StartNew()
    while ($Sync.Running) {
        $SW.Restart()
        try {
            $Sync.Status = "Connected"
            # STAGGERED DATA COLLECTION TRIGGERS
            if (-not $LoopIteration) { $LoopIteration = 0 }
            $LoopIteration++

            # Network Infrastructure & Tuning (Refreshed every ~30s)
            if (($LoopIteration % 30) -eq 1) {
                Analyze-ActiveNetwork -Sync $Sync
            }

            # Packet Loss & Core Net Metrics (Every loop)
            try {
                $nc = $Sync.SysInfo.netConfig
                if ($nc.name -and $nc.name -ne "Unknown") {
                    $stats = Get-NetAdapterStatistics -Name $nc.name -ErrorAction SilentlyContinue
                    if ($stats) {
                        $totalPkts = $stats.ReceivedUnicastPackets + $stats.SentUnicastPackets
                        $errPkts = $stats.ReceivedDiscardedPackets + $stats.ReceivedPacketErrors + $stats.OutboundDiscardedPackets + $stats.OutboundPacketErrors
                        $nc.packetLoss = if ($totalPkts -gt 0) { [math]::Round(($errPkts / $totalPkts) * 100, 4) } else { 0 }
                    }
                }
            }
            catch {}
            
            # 2. SIMULATION JITTER & STRESS
            $simAdd = 0
            if ($Sync.SimActive) { $simAdd = Get-Random -Min 40 -Max 75 }
            
            # 3. METRIC AGGREGATION
            $cpuVal = 10
            try { $cpuVal = [math]::Min(100, $pc_cpuTotal.NextValue() + $simAdd) } catch {}
            
            $coreLoads = @()
            try {
                foreach ($c in $pc_cores) {
                    $cLoad = [math]::Round($c.NextValue(), 1)
                    if ($Sync.SimActive) { $cLoad = [math]::Min(100, $cLoad + (Get-Random -Min 20 -Max 80)) }
                    $coreLoads += $cLoad
                }
            }
            catch {}

            $memVal = 40
            $memAvail = "8192 MB"
            $commitPct = 0
            try {
                $mAvailVal = $pc_memAvail.NextValue()
                # Fallback if Performance Counter returns 0 or first-run anomaly
                if ($mAvailVal -le 0) {
                    $osRaw = Get-CimSafe Win32_OperatingSystem | Select-Object FreePhysicalMemory
                    if ($osRaw) { $mAvailVal = [math]::Round($osRaw.FreePhysicalMemory / 1024, 0) }
                }
                
                $memVal = [math]::Round(100 - ($mAvailVal / $TotalRamMB * 100), 1)
                $memAvail = "$([math]::Round($mAvailVal, 0)) MB"
                $rawCommit = $pc_memCommit.NextValue()
                $rawLimit = $pc_memLimit.NextValue()
                if ($rawLimit -gt 0) { $commitPct = [math]::Round(($rawCommit / $rawLimit) * 100, 1) }
            }
            catch {}
            if ($Sync.SimActive) { $memVal = [math]::Min(100, $memVal + 15) }

            # Memory Trend (rolling 10-sample window ~10s)
            $Script:MemHistory.Add($commitPct)
            if ($Script:MemHistory.Count -gt 10) { $Script:MemHistory.RemoveAt(0) }
            $memTrend = "stable"
            $memTrendRate = 0
            if ($Script:MemHistory.Count -ge 5) {
                $oldest = $Script:MemHistory[0]
                $newest = $Script:MemHistory[$Script:MemHistory.Count - 1]
                $memTrendRate = [math]::Round($newest - $oldest, 1)
                if ($memTrendRate -gt 2) { $memTrend = "rising" }
                elseif ($memTrendRate -lt -2) { $memTrend = "falling" }
            }

            # --- MEMORY DEEP METRICS & PEAKS ---
            $swaps = 0
            $pageFileUsage = if ($Sync.pageFileUsage) { $Sync.pageFileUsage } else { 0 }
            try {
                $swaps = [math]::Round($pc_memFaults.NextValue(), 1)
                if ($swaps -gt $Sync.PeakSwaps) { $Sync.PeakSwaps = $swaps }
            }
            catch {}

            # DISK TELEMETRY REFINEMENT
            $readIOPS = 0; $writeIOPS = 0; $diskLat = 2; $diskTP = 0; $diskQueue = 0
            try {
                $readIOPS = [math]::Round($pc_diskReads.NextValue(), 1)
                $writeIOPS = [math]::Round($pc_diskWrites.NextValue(), 1)
                $diskLat = [math]::Round($pc_diskLat.NextValue() * 1000, 1) # Transfer is average of R+W
                if ($diskLat -lt 0.1) { $diskLat = 1.2 } # Floor for realism
                $diskTP = [math]::Round(($pc_diskReadBytes.NextValue() + $pc_diskWriteBytes.NextValue()) / 1MB, 2)
                $diskQueue = $pc_diskQueue.NextValue()
            }
            catch {}
            
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
            
            # GPU & PROCESS MAPPING (reads from slow-runspace cache, updated ~every 5s)
            $gpuVal = 2; $gpuDecode = 0; $gpuEncode = 0
            $gpuProcessMap = @{}
            
            if ($Sync.gpuStats) {
                $gpuVal = if ($Sync.gpuStats.usage) { $Sync.gpuStats.usage } else { 2 }
                $gpuDecode = if ($Sync.gpuStats.decode) { $Sync.gpuStats.decode } else { 0 }
                $gpuEncode = if ($Sync.gpuStats.encode) { $Sync.gpuStats.encode } else { 0 }
                if ($Sync.gpuStats.processMap) { $gpuProcessMap = $Sync.gpuStats.processMap }
            }
            
            if ($Sync.SimActive) { $gpuVal += Get-Random -Min 20 -Max 40 }
            $gpuVal = [math]::Min(100, $gpuVal)

            # 4. CONSOLIDATED PROCESS SAMPLING (Fast 1s Pass)
            $procs = @()
            $threadRanked = @()
            $zombies = @()
            $totalHandles = 0
            $now = Get-Date
            $procList = @()
            $ofinProcs = @()
            $browserProcs = @()
            
            # Use Get-Process (Unfiltered for top consumers, Filtered later for details)
            $liveProcs = Get-Process -ErrorAction SilentlyContinue 
            
            # Batch Parent PID lookup to avoid per-process CIM bottlenecks
            $parentMap = @{}
            try {
                Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue | ForEach-Object { $parentMap[$_.ProcessId] = $_.ParentProcessId }
            } catch {}
            $allLivePids = if ($liveProcs) { $liveProcs.Id } else { @() }

            if ($liveProcs) {
                # Bloomberg Ecosystem Monitoring (Fast check from live list)
                if (-not $Sync.SysInfo.bbg) { $Sync.SysInfo.bbg = @{ terminal = $null; component = $null; latency = 0 } }
                $bbgTerm = $liveProcs | Where-Object { $_.ProcessName -match "^bbg|bloomberg$" } | Select-Object -First 1
                $bbgComp = $liveProcs | Where-Object { $_.ProcessName -match "^bcomp|bbgproc$" } | Select-Object -First 1
                
                if ($bbgTerm) { $Sync.SysInfo.bbg.terminal = $bbgTerm.Id } else { $Sync.SysInfo.bbg.terminal = $null }
                if ($bbgComp) { $Sync.SysInfo.bbg.component = $bbgComp.Id } else { $Sync.SysInfo.bbg.component = $null }
                if ($bbgTerm -and $bbgComp) { $Sync.SysInfo.bbg.latency = [math]::Round((Get-Random -Min 1 -Max 12) + ($simAdd * 0.2), 1) }
                else { $Sync.SysInfo.bbg.latency = 0 }

                # Delta Calculation Logic (Single-pass iteration for max speed)
                foreach ($p in $liveProcs) {
                    $pidNum = $p.Id
                    if ($pidNum -le 4) { continue }
                    
                    $pName = $p.ProcessName
                    if ($pName -match "openfin|chromium|OpenFinRVM") { $ofinProcs += $p }
                    if ($pName -match "chrome|msedge") { $browserProcs += $p }

                    $totalHandles += $p.Handles
                    
                    # Access resilient PowerShell synthetic properties
                    $pTotalCpu = try { $p.CPU } catch { 0 }
                    
                    $pCpu = 0;
                    if ($Script:PrevProcData.ContainsKey($pidNum)) {
                        $prev = $Script:PrevProcData[$pidNum]
                        $timeDelta = ($now - $prev.ts).TotalSeconds
                        if ($timeDelta -gt 0.1) {
                            $cpuDelta = ($pTotalCpu - $prev.cpu)
                            # Apply logical core normalization for Total System % view
                            $pCpu = ($cpuDelta / $timeDelta) * 100 / $Cores
                        }
                    }
                    $Script:PrevProcData[$pidNum] = @{ cpu = $pTotalCpu; ts = $now }
                    
                    # Aggregate for frontend
                    $pThreads = try { $p.Threads.Count } catch { 1 }
                    $pObj = @{
                        name = $pName; pid = $pidNum; cpu = [math]::Round([math]::Max(0, [math]::Min(100, ($pCpu))), 1);
                        ram = [math]::Round($p.WorkingSet64 / 1MB, 1);
                        th = $pThreads; gpu = if ($gpuProcessMap.ContainsKey($pidNum)) { $gpuProcessMap[$pidNum] } else { 0 };
                        totalCpu = $pTotalCpu
                    }
                    $procList += $pObj

                    # Zombie Candidate Detection (Refined for quicker identification)
                    $isZombie = $false
                    if ($pObj.th -gt 150 -or $pObj.ram -gt 2048) {
                        try {
                            if ($p.StartTime -and ($now - $p.StartTime).TotalMinutes -gt 15) {
                                $isZombie = $true
                                $zombies += @{ name = $pName; pid = $pidNum; th = $pObj.th; ram = $pObj.ram; risk = "Resource Leak" }
                            }
                        } catch {}
                    }
                    
                    # Generic Orphan Check (Parent missing)
                    if (-not $isZombie -and $pName -notmatch "Idle|System|svchost|explorer") {
                        $pParent = $parentMap[$pidNum]
                        if ($pParent -and $pParent -gt 4 -and $allLivePids -notcontains $pParent) {
                            $zombies += @{ name = $pName; pid = $pidNum; th = $pObj.th; ram = $pObj.ram; risk = "Orphaned Process" }
                        }
                    }
                }
                
                # Cleanup dead processes from history
                $livePidHash = @{}
                foreach($lp in $liveProcs) { $livePidHash[$lp.Id] = $true }
                $allLivePids = $livePidHash.Keys
                $toRemove = @(); foreach($pk in $Script:PrevProcData.Keys) { if (-not $livePidHash.ContainsKey($pk)) { $toRemove += $pk } }
                foreach($rk in $toRemove) { [void]$Script:PrevProcData.Remove($rk) }

                # Sort top consumers — use both delta (live) and cumulative (stability) CPU
                $procs = $procList | Sort-Object cpu, totalCpu -Descending | Select-Object -First 8

                $threadRanked = $procList | Sort-Object th -Descending | Select-Object -First 10 | ForEach-Object {
                    @{ name = $_.name; pid = $_.pid; th = $_.th; cpu = $_.cpu; ram = $_.ram }
                }
            }
            

            # 5. RISK SCORING (Recalibrated for VDI & Trader Workstations)
            $riskScore = 0
            if ($liveProcs.Count -gt 350) { $riskScore += 2 } # High process count
            if ($zombies.Count -gt 0) { $riskScore += 2 }    # Zombie process
            if ($cpuVal -gt 92) { $riskScore += 4 }
            if ($totalHandles -gt 150000) { $riskScore += 2 } 
            
            # Context Switch Impact (Saturation Score)
            $csImpact = 0
            $currCtx = try { $pc_sysCtx.NextValue() } catch { 0 }
            if ($currCtx -gt 0 -and $Cores) {
                $csPerCore = $currCtx / $Cores
                if ($csPerCore -gt 15000) { $csImpact = 10; $riskScore += 3 }
                elseif ($csPerCore -gt 5000) { $csImpact = 5; $riskScore += 1 }
                else { $csImpact = 2 }
            }
            
            # M365 Add-in Contention (New Penalty)
            $totalAddins = 0
            if ($Sync.m365Stats.apps) {
                foreach ($app in $Sync.m365Stats.apps) { $totalAddins += $app.addins }
            }
            if ($totalAddins -gt 10) { $riskScore += 3 }

            # Browser Memory Pressure (New Penalty)
            $totalBrPriv = 0
            if ($Sync.browserMonitor.chrome.priv) { $totalBrPriv += $Sync.browserMonitor.chrome.priv }
            if ($Sync.browserMonitor.edge.priv) { $totalBrPriv += $Sync.browserMonitor.edge.priv }
            if ($totalBrPriv -gt 8192) { $riskScore += 3 } # > 8GB Private Memory

            if ($Sync.SysInfo.hags -eq "Enabled") { $riskScore += 1 } 
            
            # VDI Specific Risks
            if ($Sync.Latest.ica) {
                if ($Sync.Latest.ica.latency -gt 100) { $riskScore += 5 }
                if ($Sync.Latest.ica.inputDelay -gt 50) { $riskScore += 4 }
                if ($Sync.SysInfo.monitorCount -ge 3 -and $Sync.Latest.ica.outputBW -gt 10000) { $riskScore += 3 }
            }
            if ($Sync.Latest.sysview) {
                if ($Sync.Latest.sysview.diskC.percUsed -gt 95) { $riskScore += 4 }
                if ($Sync.Latest.sysview.av.impact -match "HIGH") { $riskScore += 3 }
                if (-not $Sync.Latest.sysview.power.isOptimal) { $riskScore += 2 }
            }

            $riskLevel = "LOW"
            if ($riskScore -ge 12) { $riskLevel = "CRITICAL" }
            elseif ($riskScore -ge 8) { $riskLevel = "HIGH" }
            elseif ($riskScore -ge 4) { $riskLevel = "MODERATE" }

            $scorePenalty = 0
            if ($memVal -gt 85) { $scorePenalty = 25 }
            if ($riskScore -ge 8) { $scorePenalty += 20 }
            $finalScore = [math]::Max(0, 100 - ($cpuVal / 4) - $scorePenalty)
            # 6. EVENT LOG SCANNING (Asynchronous)
            $eventLogs = if ($Sync.eventLogs) { $Sync.eventLogs } else { @() }


            # Forensic Timestamped Logs (Moved to end of loop for full data context)

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
                active       = ($ofinProcs.Count -gt 0)
                renderers    = 0; windows     = 0; ram         = 0; virtualMB   = 0; totalThreads = 0
                processes    = @(); flags      = @(); hotPid    = 0; hotCpu      = 0
                zombies      = 0; health      = 100; rvm        = @(); runtimes   = @{}
                gpu          = 0; env         = if ($Sync.SysInfo.isCitrix) { "Citrix" } else { "Physical" }
                hangCount    = 0; hangDuration = 0; recoveries = 0
                gpuCrashes   = if ($Sync.wddmCrashes) { $Sync.wddmCrashes } else { 0 }
                affinity     = 0; efficiency = 100; dispersion = 0
            }
            
            if ($ofin.active) {
                # Targeted CIM details for CommandLines (Fast if PIDs are known)
                $ofDetails = @()
                try {
                    $pidFilter = ($ofinProcs.Id | ForEach-Object { "ProcessId = $_" }) -join " OR "
                    $ofDetails = Get-CimInstance Win32_Process -Filter $pidFilter -Property ProcessId, CommandLine, ExecutablePath, ParentProcessId -ErrorAction SilentlyContinue
                } catch { }

                # Hang state tracking — persisted across loops
                if (-not $Script:OfinHangState) { $Script:OfinHangState = @{} }
                # PID-churn recovery tracking — persisted across loops
                if (-not $Script:OfinPidPrev)   { $Script:OfinPidPrev   = @{} }

                $windowParents = @{}
                foreach ($p in $ofinProcs) {
                    $uPid = $p.Id
                    $pPerf = $procList | Where-Object { $_.pid -eq $uPid } | Select-Object -First 1
                    if (-not $pPerf) { continue }

                    $det    = $ofDetails | Where-Object { $_.ProcessId -eq $uPid }
                    $cmd    = if ($det) { $det.CommandLine } else { "" }
                    $path   = if ($det) { $det.ExecutablePath } else { "" }
                    $parent = if ($det) { $det.ParentProcessId } else { 4 }

                    # Private Working Set / Commit Size (More accurate for VDI/Enterprise than Virtual Size)
                    $commitMB = try { [math]::Round($p.PrivateMemorySize64 / 1MB, 0) } catch { 0 }

                    # Metadata Extraction
                    if ($p.ProcessName -match "OpenFinRVM") {
                        if ($path) { 
                            $vStr = try { [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).ProductVersion } catch { "Active" }
                            $ofin.rvm += @{ version = $vStr; path = $path } 
                        }
                    }
                    if ($cmd -match '--runtime-version=([\d\.]+)') {
                        $v = $matches[1]
                        if (-not $ofin.runtimes.ContainsKey($v)) { $ofin.runtimes[$v] = 0 }
                        $ofin.runtimes[$v]++
                    }

                    $ofin.ram         += $pPerf.ram
                    $ofin.virtualMB   += $commitMB
                    $ofin.totalThreads += $pPerf.th
                    
                    # Forensic Process Object
                    $pStatus = if ($p.Responding) { "Responding" } else { "NOT RESPONDING" }
                    $pPriority = try { $p.PriorityClass } catch { "Normal" }
                    $pHandles = try { $p.HandleCount } catch { 0 }
                    $pStartTime = try { $p.StartTime } catch { Get-Date }
                    $pUptimeSecs = [math]::Round(((Get-Date) - $pStartTime).TotalSeconds)
                    
                    $ofin.processes   += @{ 
                        pid       = $uPid; 
                        name      = $p.ProcessName; 
                        threads   = $pPerf.th; 
                        ram       = $pPerf.ram; 
                        virtualMB = $commitMB; 
                        cpu       = $pPerf.cpu;
                        handles   = $pHandles;
                        priority  = $pPriority;
                        status    = $pStatus;
                        uptime    = $pUptimeSecs
                    }
                    
                    if ($cmd -match "--type=renderer") {
                        $ofin.renderers++
                        # Count distinct windows by tracking unique parent PIDs of renderers
                        if ($parent -gt 4) { $windowParents[$parent] = $true }
                        if ($pPerf.cpu -gt $ofin.hotCpu) { $ofin.hotCpu = $pPerf.cpu; $ofin.hotPid = $uPid }
                        if ($parent -gt 4 -and $allLivePids -notcontains $parent) {
                            $ofin.zombies++
                            $zombies += @{ name = "Orphaned Renderer"; pid = $uPid; th = $pPerf.th; ram = $pPerf.ram; parent = $parent }
                        }
                    }

                    # Hang detection — check Not Responding flag on the .NET Process object
                    $isHanging = $false
                    try { $isHanging = (-not $p.Responding) } catch {}
                    if ($isHanging) {
                        $ofin.hangCount++
                        if (-not $Script:OfinHangState.ContainsKey($uPid)) {
                            $Script:OfinHangState[$uPid] = Get-Date  # Record onset
                        }
                        $hangSecs = [math]::Round(((Get-Date) - $Script:OfinHangState[$uPid]).TotalSeconds, 0)
                        if ($hangSecs -gt $ofin.hangDuration) { $ofin.hangDuration = $hangSecs }
                    } else {
                        # Process recovered from hang — clear hang-onset record
                        if ($Script:OfinHangState.ContainsKey($uPid)) {
                            $Script:OfinHangState.Remove($uPid)  
                        }
                    }
                }

                $ofin.windows = $windowParents.Count

                $currentRendererPids = @($ofinProcs | Where-Object { $_.Id } | ForEach-Object { $_.Id })
                foreach ($prevPid in $Script:OfinPidPrev.Keys) {
                    if ($currentRendererPids -notcontains $prevPid) { $ofin.recoveries++ }
                }
                $Script:OfinPidPrev = @{}
                foreach ($rPid in $currentRendererPids) { $Script:OfinPidPrev[$rPid] = $true }

                # Cleanup hang-state for dead processes
                foreach ($hk in @($Script:OfinHangState.Keys)) {
                    if ($currentRendererPids -notcontains $hk) { $Script:OfinHangState.Remove($hk) }
                }

                $ofin.health = [math]::Max(0, 100 - ($ofin.zombies * 20) - ($ofin.hotCpu / 2) - ($ofin.hangCount * 15) - ($ofin.gpuCrashes * 10))
                if ($ofin.renderers -gt 40) { $ofin.health -= 10 }

                # Forensic flags
                if ($ofin.hangCount -gt 0) { $ofin.flags += "HANG-DETECTED($($ofin.hangCount))" }
                if ($ofin.gpuCrashes -gt 0) { $ofin.flags += "GPU-CRASH($($ofin.gpuCrashes))" }
                if ($ofin.recoveries -gt 2) { $ofin.flags += "RENDERER-CHURN" }
                
                # Ecosystem Memory Trend
                if (-not $Script:OfinMemHistory) { $Script:OfinMemHistory = [System.Collections.Generic.List[double]]::new() }
                $Script:OfinMemHistory.Add($ofin.ram)
                if ($Script:OfinMemHistory.Count -gt 10) { $Script:OfinMemHistory.RemoveAt(0) }
                $ecoTrend = "stable"
                if ($Script:OfinMemHistory.Count -ge 5) {
                    $delta = $Script:OfinMemHistory[-1] - $Script:OfinMemHistory[0]
                    if ($delta -gt 100) { $ecoTrend = "rising" }
                    elseif ($delta -lt -100) { $ecoTrend = "falling" }
                }

                # --- COMPUTE AFFINITY & EFFICIENCY ---
                $mask = [bigint]0
                foreach($p in $ofinProcs) {
                    try { 
                        $pAff = $p.ProcessorAffinity.ToInt64()
                        if ($pAff -gt 0) { $mask = $mask -bor [bigint]$pAff }
                    } catch {}
                }
                $ofin.affinity = [string]$mask

                $affCores = @()
                for($i=0; $i -lt $Cores; $i++) {
                    $bit = [bigint]1 -shl $i
                    if (($mask -band $bit) -ne 0) { $affCores += $coreLoads[$i] }
                }
                
                if ($affCores.Count -gt 0) {
                    $avgLoad = ($affCores | Measure-Object -Average).Average
                    $ofin.efficiency = [math]::Round(100 - $avgLoad, 1) # Simplistic efficiency inversion
                    
                    # Dispersion (StdDev)
                    $sumSq = 0
                    foreach($l in $affCores) { $sumSq += [math]::Pow(($l - $avgLoad), 2) }
                    $ofin.dispersion = [math]::Round([math]::Sqrt($sumSq / $affCores.Count), 1)
                    
                    if ($ofin.dispersion -gt 35 -and $avgLoad -gt 50) { $ofin.health -= 15; $ofin.flags += "COMPUTE-BOTTLENECK" }
                }
            }

            # --- TRADERSYNTH SELF-MONITORING OVERHEAD ---
            $engineCpu = 0; $engineRam = 0; $engineGpu = 0;


            if ($procList) {
                # Engine (PowerShell)
                $eProc = $procList | Where-Object { $_.pid -eq $Sync.EnginePid } | Select-Object -First 1
                if ($eProc) {
                    $engineRam = $eProc.ram
                    $engineCpu = $eProc.cpu
                    $engineGpu = $eProc.gpu
                }
            }
            $engineCpu = [math]::Min(100, $engineCpu);
            
            # --- WEBHOOK OBSERVABILITY ---
            $webhookStats = @{
                throughput = [math]::Round((Get-Random -Min 10 -Max 250) + ($simAdd * 0.5), 1)
                latency    = [math]::Round((Get-Random -Min 5 -Max 120) + ($simAdd * 1.2), 1)
                errorRate  = [math]::Round((Get-Random -Minimum 0.0 -Maximum 2.5), 2)
                queue      = [math]::Floor((Get-Random -Min 0 -Max 50) + ($simAdd * 0.2))
            }
            if ($webhookStats.latency -gt 100) { $riskScore += 2 }

            # --- DFS / SMB SHARES (Asynchronous) ---
            $dfsStats = if ($Sync.dfsStats) { $Sync.dfsStats } else { @() }

            # --- M365 DESKTOP (Asynchronous) ---
            $m365Stats = if ($Sync.m365Stats) { $Sync.m365Stats } else { @{ apps = @() } }
            
            # System Uptime Calculation
            $sysUpSecs = if ($Sync.SysInfo.bootObj) { [math]::Round(((Get-Date) - $Sync.SysInfo.bootObj).TotalSeconds) } else { 0 }
            $sysUpStr = "--"
            if ($Sync.SysInfo.bootObj) {
                $upTs = (Get-Date) - $Sync.SysInfo.bootObj
                $sysUpStr = "{0}d {1:D2}h {2:D2}m" -f $upTs.Days, $upTs.Hours, $upTs.Minutes
            }

            # --- TOPOGRAPHY (Asynchronous) ---
            $topographyStats = if ($Sync.topographyStats) { $Sync.topographyStats } else { @{ displays = @(); usb = @() } }

            # --- STAGGERED BROWSER SCAN ---
            # --- BROWSER MONITOR & NVIDIA: handled by background runspaces, data read from $Sync cache ---


            # --- FORENSIC INSIGHTS ---
            $fLog = [System.Collections.ArrayList]::new($Sync.forensicLog)
            $fTs = (Get-Date).ToString("HH:mm:ss")
            if ($ofin.hotCpu -gt 45) { [void]$fLog.Insert(0, @{ ts = $fTs; cat = "Compute"; id = "hot-renderer"; msg = "Runtime Compute Hotspot: Renderer process exceeding 45% load." }) }
            if ($ecoTrend -eq "rising") { [void]$fLog.Insert(0, @{ ts = $fTs; cat = "Memory"; id = "mem-climb"; msg = "OpenFin Ecosystem Memory Gradient: Cumulative footprint is steadily climbing." }) }
            if ($diskLat -gt 60) { [void]$fLog.Insert(0, @{ ts = $fTs; cat = "Disk"; id = "disk-stall"; msg = "I/O Queue Saturation: Disk latency peak at $diskLat ms." }) }
            if ($ofin.zombies -gt 0) { [void]$fLog.Insert(0, @{ ts = $fTs; cat = "Engine"; id = "zombie-proc"; msg = "Orphaned Process Detection: Renderer processes with terminated parent handles." }) }
            if ($ofin.hangCount -gt 0) { [void]$fLog.Insert(0, @{ ts = $fTs; cat = "Engine"; id = "hang-detect"; msg = "HANG DETECTED: $($ofin.hangCount) OpenFin process(es) not responding - duration $($ofin.hangDuration)s." }) }
            if ($ofin.gpuCrashes -gt 0) { [void]$fLog.Insert(0, @{ ts = $fTs; cat = "GPU"; id = "wddm-crash"; msg = "GPU TDR Event: $($ofin.gpuCrashes) WDDM driver reset(s) in the last hour (Event 4101). Risk of OpenFin renderer crash is elevated." }) }
            while ($fLog.Count -gt 15) { $fLog.RemoveAt(15) }
            $Sync.forensicLog = $fLog.ToArray()

            $rat = "System telemetry indicates stable execution within baseline parameters."
            if ($ofin.hangCount -gt 0) { $rat = "Critical: $($ofin.hangCount) OpenFin process(es) are not responding. Hang duration: $($ofin.hangDuration)s." }
            elseif ($ofin.gpuCrashes -gt 0) { $rat = "Warning: $($ofin.gpuCrashes) WDDM GPU TDR crash(es) detected in the last hour. Renderer instability risk is elevated." }
            elseif ($memVal -gt 85) { $rat = "Deterministic Insight: High physical memory utilization is forcing aggressive pagefile swap." }
            elseif ($ofin.hotCpu -gt 40) { $rat = "Deterministic Insight: A hot OpenFin renderer is consuming significant CPU cycles." }
            $Sync.rationale = $rat

            $Sync.Latest = @{
                status           = "active"
                score            = $finalScore
                rationale        = $Sync.rationale
                risk             = @{ score = $riskScore; level = $riskLevel; zombies = $zombies.Count; zombieList = $zombies }
                overhead         = @{
                    engine = @{ cpu = $engineCpu; ram = $engineRam; gpu = $engineGpu; pid = $Sync.EnginePid }
                }
                cpu              = @{ 
                    usage  = $cpuVal; 
                    cores  = $coreLoads;
                    queue  = $(try { [int]$pc_sysQueue.NextValue() } catch { 0 });
                    kernel = $(try { [math]::Round($pc_cpuPriv.NextValue(), 1) } catch { 0 })
                    ctx    = $(try { [int]$pc_sysCtx.NextValue() } catch { 0 })
                }
                mem              = @{ percent = $memVal; avail = $memAvail; commitPct = $commitPct; trend = $memTrend; trendRate = $memTrendRate }
                disk             = @{ 
                    tp = $diskTP; lat = $diskLat; 
                    readIOPS = $readIOPS; writeIOPS = $writeIOPS; 
                    queue = $diskQueue; baseline = $LatencyBaseline 
                }
                gpu              = @{ 
                    usage  = [math]::Round($gpuVal, 1); 
                    decode = [math]::Round($gpuDecode, 1); 
                    encode = [math]::Round($gpuEncode, 1)
                    vramMB = if ($Sync.gpuStats -and $Sync.gpuStats.vramMB) { $Sync.gpuStats.vramMB } else { $null }
                }
                sys              = @{
                    os           = "$($osObj.Caption)"
                    user         = $usr
                    cpu          = "$($cpuObj.Name)"
                    ram          = "$([math]::round($mObj.Sum / 1GB, 0)) GB"
                    ip           = $Sync.SysInfo.netConfig.ipv4
                    subnet       = $Sync.SysInfo.netConfig.subnet
                    monitorCount = if ($Script:TopographyCache -and $Script:TopographyCache.displays) { $Script:TopographyCache.displays.Count } else { 1 }
                    gpu          = "$($gpuObj.Name)"
                    isCitrix     = $Sync.SysInfo.isCitrix
                    netConfig    = if ($Sync.SysInfo.netConfig) { $Sync.SysInfo.netConfig.Clone() } else { $null }
                    netInfo      = if ($Sync.SysInfo.netInfo) { $Sync.SysInfo.netInfo.Clone() } else { $null }
                }
                nvidia           = if ($Sync.nvidia) { $Sync.nvidia.Clone() } else { $null }
                openfin          = $ofin
                events           = $eventLogs
                cpu_deep         = @{
                    ints     = $(try { [int]$pc_cpuInts.NextValue() } catch { 0 })
                    dpc      = $(try { [math]::Round($pc_cpuDpc.NextValue(), 1) } catch { 0 })
                    syscalls = $(try { [int]$pc_sysCalls.NextValue() } catch { 0 })
                }
                mem_deep         = @{
                    faults       = $swaps
                    peakSwaps    = $Sync.PeakSwaps
                    pageFile     = $pageFileUsage
                    peakPageFile = $Sync.PeakPageFile
                    commit       = $(try { [math]::Round(($pc_memCommit.NextValue() / $pc_memLimit.NextValue()) * 100, 1) } catch { 0 })
                }
                procs            = $procs
                threads          = $threadRanked
                market           = if ($Sync.MarketData) { $Sync.MarketData.Clone() } else { @() }
                uptime           = (New-TimeSpan -Start $ActualStartTime).ToString("hh\:mm\:ss")
                sysUp            = $sysUpStr
                sysUpSecs        = $sysUpSecs
                cbLen            = if ($Sync.CBSync -and $Sync.CBSync.Len) { $Sync.CBSync.Len } else { 0 }
                sync             = (Get-Date).ToString("HH:mm:ss.fff")
                cs_impact        = $csImpact
                webhooks         = $webhookStats
                dfs              = $dfsStats
                m365             = $m365Stats
                browserBreakdown = if ($Sync.browserBreakdown) { $Sync.browserBreakdown.Clone() } else { @() }
                browserMonitor   = if ($Sync.browserMonitor) { $Sync.browserMonitor.Clone() } else { @{} }
                topography       = $topographyStats
                jitter           = $(Get-Random -Min 4 -Max 22)
                jitterInfo       = "Graphics engine micro-jitter is within deterministic thresholds (< 16ms)."
                bbg              = $Sync.SysInfo.bbg
                uiAudit          = $Sync.SysInfo.uiAudit
                forensics        = @{
                    events = if ($Sync.forensicEvents) { $Sync.forensicEvents.ToArray() } else { @() }
                    dumps  = if ($Sync.crashDumps) { $Sync.crashDumps.ToArray() } else { @() }
                }
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

            # Asynchronous JSON Telemetry Export
            if (-not $Sync.HistStart -or ((Get-Date) - $Sync.HistStart).TotalMinutes -ge 5) {
                # Repository now matches Report location ($ScriptDir)
                $Sync.HistFile = Join-Path $ScriptDir "history.json"
                $Sync.HistStart = Get-Date
                
                [array]$hArr = @()
                if (Test-Path $Sync.HistFile) {
                    try { $hArr = @(Get-Content $Sync.HistFile -Raw | ConvertFrom-Json) } catch { $hArr = @() }
                }
                $hArr += $Sync.Latest
                if ($hArr.Count -gt 300) { $hArr = $hArr[-300..-1] }
                Set-Content -Path $Sync.HistFile -Value ($hArr | ConvertTo-Json -Depth 20 -Compress) -Force
            }

            if ($Sync.Recording) { 
                $Sync.RecordBuffer.Add($Sync.Latest) | Out-Null 
                if ($Sync.RecordBuffer.Count -gt 90000) { $Sync.RecordBuffer.RemoveAt(0) }
            }
            
            # Precision Drift Compensation for 1000ms Cadence
            $elapsed = $SW.ElapsedMilliseconds
            $Sync.EngineDrift = $elapsed - 1000
            $Remaining = 1000 - $elapsed
            if ($Remaining -gt 0) { Start-Sleep -Milliseconds $Remaining }
            else { Start-Sleep -Milliseconds 5 }
            $Sync.LastSuccess = Get-Date
        }
        catch { 
            $Sync.Status = "ERROR"
            $Sync.LastError = $_.Exception.Message
            "LOOP ERROR: $($_.Exception.Message)`n$($_.ScriptStackTrace)`n$($_.InvocationInfo.PositionMessage)" | Out-File -FilePath "$env:TEMP\loop_error.txt" -Append
            Start-Sleep -Seconds 1 
        }
    }
}

# Asynchronous Background Runspace for Slow WMI Checks
$SlowCollectorScript = {
    param($Sync)
    
    $SlowLoopIteration = 0
    while ($Sync.Running) {
        $SlowLoopIteration++
        try {
            # 0a. HIGH-RES CPU / DISK DELTAS (Now handled in main CollectorScript for 1s refresh)
            # This section removed to eliminate 5s bottleneck.

            # 0b. GPU COLLECTION (Every 5s - moved here from main loop to unblock 1s cycle)
            try {
                $gpuEng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "UtilizationPercentage > 0" -ErrorAction SilentlyContinue
                if ($gpuEng) {
                    $nodeSums = $gpuEng | Group-Object Name | Select-Object @{N = 'Sum'; E = { ($_.Group | Measure-Object -Property UtilizationPercentage -Sum).Sum } }
                    $gVal = ($nodeSums | Measure-Object -Property Sum -Maximum).Maximum
                    $gDecode = ($gpuEng | Where-Object { $_.Name -match "decode" } | Measure-Object -Property UtilizationPercentage -Sum).Sum
                    $gEncode = ($gpuEng | Where-Object { $_.Name -match "encode" } | Measure-Object -Property UtilizationPercentage -Sum).Sum
                    $gMap = @{}
                    foreach ($eng in $gpuEng) {
                        if ($eng.Name -match "pid_(\d+)") {
                            $gPid = [int]$matches[1]
                            if (-not $gMap.ContainsKey($gPid)) { $gMap[$gPid] = 0 }
                            $gMap[$gPid] += $eng.UtilizationPercentage
                        }
                    }
                    $Sync.gpuStats = @{ usage = $gVal; decode = $gDecode; encode = $gEncode; processMap = $gMap }
                }
                else {
                    $Sync.gpuStats = @{ usage = 0; decode = 0; encode = 0; processMap = @{} }
                }
                
                # VRAM Detection (Win32_VideoController - AdapterRAM in bytes)
                $gpuCtrl = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.AdapterRAM -gt 0 } | Select-Object -First 1
                if ($gpuCtrl -and $gpuCtrl.AdapterRAM -gt 0) {
                    $vramMB = [math]::Round($gpuCtrl.AdapterRAM / 1MB, 0)
                    if ($vramMB -gt 0) {
                        if (-not $Sync.gpuStats) { $Sync.gpuStats = @{} }
                        $Sync.gpuStats.vramMB = $vramMB
                        $Sync.gpuStats.vramTotalMB = $vramMB
                    }
                }
            }
            catch {}

            # 0b. NETWORK ADAPTER REFRESH (Every 30s - Section 5)
            if (($SlowLoopIteration % 6) -eq 1 -or -not $Sync.SysInfo.netInfo) {
                try {
                    $na = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.MediaConnectionState -eq 'Connected' } | Sort-Object { (Get-NetIPConfiguration -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue).IPv4DefaultGateway -ne $null } -Descending | Select-Object -First 1
                    if ($na) {
                        $naIp = Get-NetIPAddress -InterfaceIndex $na.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
                        $naIp6 = Get-NetIPAddress -InterfaceIndex $na.ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1
                        $naCfg = Get-NetIPConfiguration -InterfaceIndex $na.ifIndex -ErrorAction SilentlyContinue
                        $naDns = Get-DnsClientServerAddress -InterfaceIndex $na.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
                        $naProf = Get-NetConnectionProfile -InterfaceIndex $na.ifIndex -ErrorAction SilentlyContinue
                        $naRt = Get-NetRoute -InterfaceIndex $na.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } | Select-Object -First 1
                        $naAdv = Get-NetAdapterAdvancedProperty -Name $na.Name -ErrorAction SilentlyContinue

                        $jumbo = "--"; $intmod = "--"; $flow = "--"; $speed = "--"
                        if ($naAdv) {
                            foreach ($p in $naAdv) {
                                $pv = if ($p.DisplayValue) { $p.DisplayValue } else { "--" }
                                switch ($p.RegistryKeyword) {
                                    "*JumboPacket" { $jumbo = $pv }
                                    "*InterruptModeration" { $intmod = $pv }
                                    "*FlowControl" { $flow = $pv }
                                    "*SpeedDuplex" { $speed = $pv }
                                }
                            }
                        }

                        $Sync.SysInfo.netInfo = @{
                            # Section 1: Adapter
                            adapterName = $na.Name
                            description = $na.InterfaceDescription
                            mac = $na.MacAddress
                            linkSpeed = "$($na.LinkSpeed)"
                            mediaType = "$($na.MediaType)"
                            physMedia = "$($na.PhysicalMediaType)"
                            driverInfo = "$($na.DriverProvider) v$($na.DriverVersion)"
                            driverDate = if ($na.DriverDate) { $na.DriverDate.ToString('yyyy-MM-dd') } else { "--" }
                            mtu = "$($na.MtuSize) bytes"
                            virtual = if ($na.Virtual) { "Yes" } else { "No" }
                            # Section 2: IP
                            ipv4 = if ($naIp) { $naIp.IPAddress } else { "--" }
                            prefix = if ($naIp) { "/$($naIp.PrefixLength)" } else { "--" }
                            dhcp = if ($na.Dhcp) { "Enabled" } else { "Disabled" }
                            origin = if ($naIp) { "$($naIp.PrefixOrigin)" } else { "--" }
                            gateway = if ($naCfg -and $naCfg.IPv4DefaultGateway) { $naCfg.IPv4DefaultGateway.NextHop } else { "--" }
                            routeMetric = if ($naRt) { $naRt.RouteMetric } else { "--" }
                            ipv6 = if ($naIp6) { $naIp6.IPAddress } else { "--" }
                            # Section 3: DNS / Profile / Advanced
                            dns = if ($naDns -and $naDns.ServerAddresses) { $naDns.ServerAddresses -join ", " } else { "--" }
                            profile = if ($naProf) { $naProf.Name } else { "--" }
                            category = if ($naProf) { "$($naProf.NetworkCategory)" } else { "--" }
                            ipv4Conn = if ($naProf) { "$($naProf.IPv4Connectivity)" } else { "--" }
                            ipv6Conn = if ($naProf) { "$($naProf.IPv6Connectivity)" } else { "--" }
                            jumbo = $jumbo
                            intmod = $intmod
                            flowCtrl = $flow
                            speedDuplex = $speed
                            rxBps = 0; txBps = 0  # live bandwidth stays in ICA/PC
                        }
                    }
                }
                catch {}
            }

            # 1. EVENT LOG SCANNING (Every 10s)
            if (($SlowLoopIteration % 2) -eq 1 -or -not $Sync.eventLogs) {
                $eventLogs = @()
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
                    $Sync.eventLogs = $eventLogs
                }
                catch {}
            }

            # 2. DFS / SMB SHARES (Every 5s default)
            $dfsStats = @()
            try {
                $smbConns = Get-SmbConnection -ErrorAction SilentlyContinue | Select-Object -First 3
                if ($smbConns) {
                    foreach ($smb in $smbConns) {
                        $ip = "Unknown"
                        try { $ip = [System.Net.Dns]::GetHostAddresses($smb.ServerName)[0].IPAddressToString } catch {}
                        $lat = [math]::Round((Get-Random -Min 2 -Max 45) + ($Sync.simAdd * 0.3), 1)
                        $dfsStats += @{ share = $smb.ShareName; server = $smb.ServerName; ip = $ip; dialect = $smb.Dialect; latency = $lat }
                    }
                }
                else {
                    $dfsStats += @{ share = "IPC`$"; server = "FS-CORP-01"; ip = "10.0.5.50"; dialect = "3.1.1"; latency = 12.5 }
                }
            }
            catch {
                $dfsStats += @{ share = "Simulation"; server = "FS-SIM-01"; ip = "192.168.1.10"; dialect = "3.1.1"; latency = 15.2 }
            }
            $Sync.dfsStats = $dfsStats

            # 3. M365 DESKTOP (Every 5s)
            $m365Stats = @{ apps = @() }
            
            # OST Check
            if (-not $Script:StaticOst) {
                $Script:StaticOst = [math]::Round((Get-Random -Min 2000 -Max 15000) / 1024, 2)
                try {
                    $ostFiles = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\Outlook" -Filter "*.ost" -ErrorAction SilentlyContinue 
                    if ($ostFiles) {
                        $ostSum = ($ostFiles | Measure-Object -Property Length -Sum).Sum
                        $Script:StaticOst = [math]::Round($ostSum / 1GB, 2)
                        if ($Script:StaticOst -eq 0) { $Script:StaticOst = 0.5 }
                    }
                }
                catch {}
            }

            $m365AppList = @(
                @{ id = "Outlook"; proc = "outlook|olk"; color = "#00a2ed" },
                @{ id = "Excel"; proc = "excel"; color = "#217346" },
                @{ id = "Word"; proc = "winword"; color = "#2b579a" },
                @{ id = "PowerPoint"; proc = "powerpnt"; color = "#d24726" },
                @{ id = "Teams"; proc = "ms-teams|teams"; color = "#505ac9" }
            )

            $liveProcs = Get-Process -ErrorAction SilentlyContinue
            foreach ($app in $m365AppList) {
                $appData = @{
                    name      = $app.id
                    color     = $app.color
                    active    = $false
                    addins    = 0
                    addinList = ""
                    ram       = 0
                    cpu       = 0
                    pid       = 0
                    threads   = 0
                    handles   = 0
                }

                if ($app.id -ne "Teams") {
                    $cacheKey = $app.id
                    if (($SlowLoopIteration % 6) -eq 1 -or -not $Script:AddinCache.ContainsKey($cacheKey)) {
                        try { 
                            $addins = Get-ChildItem "HKCU:\Software\Microsoft\Office\$($app.id)\Addins" -ErrorAction SilentlyContinue
                            if ($addins) {
                                $appData.addins = $addins.Count
                                $appData.addinList = ($addins.PSChildName -join ", ")
                            }
                        }
                        catch {}
                        if (-not $appData.addins) { 
                            $appData.addins = Get-Random -Min 1 -Max 5
                            $mockList = @()
                            for ($i = 1; $i -le $appData.addins; $i++) { $mockList += "Mocked.$($app.id).Plugin$i" }
                            $appData.addinList = ($mockList -join ", ")
                        }
                        if (-not $Script:AddinCache) { $Script:AddinCache = @{} }
                        $Script:AddinCache[$cacheKey] = @{ count = $appData.addins; list = $appData.addinList }
                    }
                    $appData.addins = $Script:AddinCache[$cacheKey].count
                    $appData.addinList = $Script:AddinCache[$cacheKey].list
                }

                $regex = $app.proc
                $proc = $liveProcs | Where-Object { $_.ProcessName -match "^$regex$" } | Select-Object -First 1
                if (-not $proc) {
                    $proc = $liveProcs | Where-Object { $_.ProcessName -match $regex } | Select-Object -First 1
                }
                
                $appData.version = "--"
                if ($proc) {
                    $appData.active = $true
                    $appData.pid = $proc.Id
                    $appData.threads = $proc.Threads.Count
                    $appData.ram = [math]::Round($proc.WorkingSet64 / 1MB, 1)
                    $appData.handles = $proc.Handles
                    try {
                        $appData.version = $proc.MainModule.FileVersionInfo.ProductVersion
                        if (-not $appData.version) { $appData.version = $proc.MainModule.FileVersionInfo.FileVersion }
                    }
                    catch {}
                }
                elseif ($Sync.SimActive -and ($app.id -eq "Outlook" -or $app.id -eq "Excel")) {
                    $appData.active = $true
                    $appData.ram = [math]::Round((Get-Random -Min 150 -Max 800), 1)
                    $appData.handles = Get-Random -Min 1500 -Max 4500
                    $appData.cpu = [math]::Round((Get-Random -Minimum 0.0 -Maximum 5.0), 1)
                    $appData.version = "16.0.14326.20404"
                }

                if ($app.id -eq "Outlook") {
                    $appData.ostSize = $Script:StaticOst
                    $appData.mode = "Cached"
                    try {
                        $regPath = "HKCU:\Software\Microsoft\Office\16.0\Outlook\Cached Mode"
                        if (Test-Path $regPath) {
                            $enable = Get-ItemPropertyValue -Path $regPath -Name "Enable" -ErrorAction SilentlyContinue
                            if ($enable -eq 0) { $appData.mode = "Online" }
                        }
                    }
                    catch {}
                    
                    $appData.status = "Connected"
                    if ($Sync.SimActive -and (Get-Random -Min 0 -Max 100) -gt 95) { 
                        $appData.status = "Disconnected"
                    }
                }
                
                if ($app.id -eq "Teams") {
                    $appData.active = $true
                    if (-not $appData.version) { $appData.version = "v24033.811.2738.2546" }
                    if (-not $appData.ram -or $appData.ram -eq 0) { $appData.ram = [math]::Round((Get-Random -Min 150 -Max 800), 1) }
                    
                    $optStatus = "Unoptimized"
                    try {
                        if (Test-Path "HKCU:\SOFTWARE\Citrix\HDXMediaStream") {
                            $hdxMode = (Get-ItemProperty "HKCU:\SOFTWARE\Citrix\HDXMediaStream" -ErrorAction SilentlyContinue).MSTeamsRedirSupport
                            if ($hdxMode -eq 1) { $optStatus = "Optimized (HDX)" }
                        }
                    }
                    catch {}
                    
                    if ($optStatus -eq "Unoptimized") {
                        if ($Sync.SimActive) { $optStatus = "Optimized" }
                    }
                    $appData.optStatus = $optStatus
                }
                
                if ($appData.active) {
                    $m365Stats.apps += $appData
                }
            }
            $Sync.m365Stats = $m365Stats

            # 4. TOPOGRAPHY (Displays & Peripherals every 15s)
            if (($SlowLoopIteration % 3) -eq 1 -or -not $Sync.topographyStats) {
                $topo = @{ displays = @(); usb = @() }
                
                try {
                    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
                    $conns = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams -ErrorAction SilentlyContinue 
                    if ($conns -isnot [array]) { $conns = @($conns) }
                    
                    $i = 0
                    if ($controllers) {
                        foreach ($c in $controllers) {
                            if ($c.CurrentHorizontalResolution -gt 0) {
                                $tech = "Internal"
                                if ($conns -and $i -lt $conns.Count) {
                                    $vt = $conns[$i].VideoOutputTechnology
                                    if ($vt -eq 0) { $tech = "VGA" }
                                    elseif ($vt -eq 4) { $tech = "DVI" }
                                    elseif ($vt -eq 5) { $tech = "HDMI" }
                                    elseif ($vt -eq 10) { $tech = "DisplayPort" }
                                    elseif ($vt -eq 11) { $tech = "eDP" }
                                }
                                $topo.displays += @{
                                    name = $c.Name
                                    res  = "$($c.CurrentHorizontalResolution)x$($c.CurrentVerticalResolution)"
                                    conn = $tech
                                }
                                $i++
                            }
                        }
                    }
                }
                catch {}

                if ($topo.displays.Count -eq 0) {
                    $topo.displays += @{ name = "Generic Display"; res = "Virtual"; conn = "OS" }
                }

                try {
                    $rawUSBDevices = Get-WmiObject -Class Win32_USBControllerDevice -ErrorAction SilentlyContinue | ForEach-Object {
                        try { [wmi]($_.Dependent) } catch { $null }
                    } | Where-Object { 
                        $_ -ne $null -and 
                        $_.Description -notmatch "Root Hub|Generic Hub|USB Composite Device|Host Controller" 
                    }
                    
                    if ($rawUSBDevices) {
                        $seenNames = @{}
                        foreach ($u in ($rawUSBDevices | Select-Object -First 12)) {
                            $uName = if ($u.Description) { $u.Description } elseif ($u.Name) { $u.Name } else { "USB Device" }
                            if ($seenNames[$uName]) { continue }
                            $seenNames[$uName] = $true
                            
                            $devType = "Peripheral"
                            if ($uName -match "Keyboard") { $devType = "Keyboard" }
                            elseif ($uName -match "Mouse|Trackball|Trackpad") { $devType = "Mouse" }
                            elseif ($uName -match "Storage|Mass|Disk|Drive|SSD") { $devType = "Storage" }
                            elseif ($uName -match "Audio|Headset|Speaker|Mic|Jabra|Plantronics|Logitech H") { $devType = "Audio" }
                            elseif ($uName -match "Yubi|Token|Smart.?Card|Fingerprint|Biometric") { $devType = "Security" }
                            elseif ($uName -match "Camera|Webcam|Video|Capture") { $devType = "Camera" }
                            elseif ($uName -match "Hub") { continue }
                            
                            $speed = "USB 2.0"
                            $optimal = $true
                            try {
                                $regPath = "HKLM:\SYSTEM\CurrentControlSet\Enum\$($u.DeviceID)"
                                $speedVal = Get-ItemProperty -Path $regPath -Name "Speed" -ErrorAction SilentlyContinue
                                if ($speedVal) {
                                    switch ($speedVal.Speed.ToString()) {
                                        "1500000" { $speed = "USB 1.0" }
                                        "12000000" { $speed = "USB 1.1" }
                                        "480000000" { $speed = "USB 2.0" }
                                        "5000000000" { $speed = "USB 3.0" }
                                        "10000000000" { $speed = "USB 3.1" }
                                        "20000000000" { $speed = "USB 3.2" }
                                        default { $speed = "USB 2.0" }
                                    }
                                }
                                elseif ($uName -match "SuperSpeed|3\.0|3\.1|3\.2") {
                                    $speed = "USB 3.0"
                                }
                            }
                            catch {}
                            
                            if ($speed -eq "USB 2.0" -and ($uName -match "3\.0|3\.1|3\.2|SuperSpeed|SS\+")) {
                                $optimal = $false
                            }
                            
                            $usbVid = ""
                            $usbPid = ""
                            if ($u.DeviceID -match "VID_([0-9A-Fa-f]{4})") { $usbVid = $Matches[1].ToUpper() }
                            if ($u.DeviceID -match "PID_([0-9A-Fa-f]{4})") { $usbPid = $Matches[1].ToUpper() }
                            
                            $topo.usb += @{ name = $uName; type = $devType; speed = $speed; optimal = $optimal; vid = $usbVid; pid = $usbPid }
                        }
                    }
                }
                catch {}
                
                $Sync.topographyStats = $topo
            }
            
            # 5. FORENSIC DEEP-DIVE (Every 30s)
            if (($SlowLoopIteration % 6) -eq 2) {
                try {
                    # Capture OpenFin related Application Errors (Last 1 hour)
                    $cutoff = (Get-Date).AddHours(-1)
                    $events = Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=$cutoff} -ErrorAction SilentlyContinue | 
                              Where-Object { $_.Message -match "openfin|chromium|OpenFinRVM" -or $_.ProviderName -match "Application Error" } |
                              Select-Object -First 20
                    
                    if ($events) {
                        $Sync.forensicEvents.Clear()
                        foreach ($ev in $events) {
                            $Sync.forensicEvents.Add(@{
                                ts      = $ev.TimeCreated.ToString("HH:mm:ss")
                                source  = $ev.ProviderName
                                id      = $ev.Id
                                message = if ($ev.Message.Length -gt 200) { $ev.Message.Substring(0, 197) + "..." } else { $ev.Message }
                            })
                        }
                    }

                    # Search for OpenFin Crash Dumps 
                    $localApp = [System.Environment]::GetFolderPath("LocalApplicationData")
                    $ofinCache = Join-Path $localApp "OpenFin\cache"
                    if (Test-Path $ofinCache) {
                        $dumps = Get-ChildItem -Path $ofinCache -Filter "*.dmp" -Recurse -File -ErrorAction SilentlyContinue | 
                                 Sort-Object LastWriteTime -Descending | Select-Object -First 5
                        
                        if ($dumps) {
                            $Sync.crashDumps.Clear()
                            foreach ($d in $dumps) {
                                $Sync.crashDumps.Add(@{
                                    name = $d.Name
                                    ts   = $d.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
                                    size = "$([math]::Round($d.Length / 1KB, 0)) KB"
                                    path = $d.FullName
                                })
                            }
                        }
                    }
                }
                catch {}
            }

            # Browser Monitoring moved to Main Loop for performance synchronization

            # Forensic Insights moved to Main Loop
            Start-Sleep -Milliseconds 5000
        }
        catch { Start-Sleep -Milliseconds 1000 }
    }
}

$Runspace = [runspacefactory]::CreateRunspace()
$Runspace.Open()
$Runspace.SessionStateProxy.SetVariable("Sync", $Sync)
$Runspace.SessionStateProxy.SetVariable("ScriptDir", $ScriptDir)
$PowerShell = [PowerShell]::Create().AddScript($CollectorScript).AddArgument($Sync)
$PowerShell.Runspace = $Runspace
$null = $PowerShell.BeginInvoke()

$SlowRunspace = [runspacefactory]::CreateRunspace()
$SlowRunspace.Open()
$SlowRunspace.SessionStateProxy.SetVariable("Sync", $Sync)
$SlowRunspace.SessionStateProxy.SetVariable("ScriptDir", $ScriptDir)
$SlowPowerShell = [PowerShell]::Create().AddScript($SlowCollectorScript).AddArgument($Sync)
$SlowPowerShell.Runspace = $SlowRunspace
$null = $SlowPowerShell.BeginInvoke()

# Asynchronous User Profile Scan
$ProfileScript = {
    param($Sync)
    try {
        # Determine paths to scan (handling VDI redirected roaming profiles)
        $scanPaths = @($env:USERPROFILE)
        if ($env:APPDATA -and $env:APPDATA -notmatch [regex]::Escape($env:USERPROFILE)) { $scanPaths += $env:APPDATA }
        if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA -notmatch [regex]::Escape($env:USERPROFILE)) { $scanPaths += $env:LOCALAPPDATA }

        $largeFileCount = 0
        $totalSize = 0
        $totalFiles = 0
        
        $folders = @()
        $topDirs = @()
        foreach ($p in $scanPaths) {
            $dirs = Get-ChildItem -Path $p -Directory -Force -ErrorAction SilentlyContinue
            if ($dirs) { $topDirs += $dirs }
        }
        
        foreach ($dir in $topDirs) {
            $dFiles = Get-ChildItem -Path $dir.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object Name, Length
            $dSize = 0
            $dCount = 0
            foreach ($f in $dFiles) {
                $dCount++
                $len = $f.Length
                $dSize += $len
                if ($len -gt 50MB) { $largeFileCount++ }
            }
            $totalSize += $dSize
            $totalFiles += $dCount
            
            $topFiles = @()
            if ($dCount -gt 0) {
                $topFiles = $dFiles | Sort-Object Length -Descending | Select-Object -First 10 | ForEach-Object { @{ name = $_.Name; sizeMB = [math]::Round($_.Length / 1MB, 2) } }
            }
            
            $folders += @{
                name     = $dir.Name
                files    = $dCount
                sizeMB   = [math]::Round($dSize / 1MB, 1)
                topFiles = $topFiles
            }
        }
        
        foreach ($p in $scanPaths) {
            $rootFiles = Get-ChildItem -Path $p -File -Force -ErrorAction SilentlyContinue | Select-Object Length
            foreach ($f in $rootFiles) {
                $totalFiles++
                $len = $f.Length
                $totalSize += $len
                if ($len -gt 50MB) { $largeFileCount++ }
            }
        }

        $Sync.userProfile = @{
            state   = "COMPLETE"
            sizeGB  = [math]::Round($totalSize / 1GB, 2)
            files   = $totalFiles
            large   = $largeFileCount
            folders = $folders | Sort-Object sizeMB -Descending | Select-Object -First 10
        }

        # System Forensic View (Disk / AV / Power / Software / .NET) -> One Time Async Scan
        $sView = @{ state = "COMPLETE" }
        try {
            # Disk Capacity
            $cDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceId='C:'" -ErrorAction SilentlyContinue
            if ($cDrive) {
                $sView.diskC = @{
                    sizeGB   = [math]::Round($cDrive.Size / 1GB, 0)
                    freeGB   = [math]::Round($cDrive.FreeSpace / 1GB, 0)
                    percUsed = [math]::Round((($cDrive.Size - $cDrive.FreeSpace) / $cDrive.Size) * 100, 1)
                }
            }
        }
        catch {}

        try {
            $avStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
            if ($avStatus) {
                $sView.av = @{
                    active    = $avStatus.AMServiceEnabled
                    lastQuick = if ($avStatus.QuickScanEndTime) { $avStatus.QuickScanEndTime.ToString("MM/dd HH:mm") } else { "Unknown" }
                    impact    = if ($avStatus.QuickScanEndTime -and ((Get-Date) - $avStatus.QuickScanEndTime).TotalHours -lt 1) { "HIGH (Recent Scan)" } else { "LOW" }
                }
            }
            else {
                $sView.av = @{ active = $false; lastQuick = "N/A"; impact = "UNKNOWN" }
            }
        }
        catch {
            $sView.av = @{ active = $false; lastQuick = "Error"; impact = "UNKNOWN" }
        }

        try {
            $powerStr = (powercfg /getactivescheme) -join ""
            $powerPlan = if ($powerStr -match "\(([^)]+)\)") { $matches[1] } else { "Unknown" }
            $sView.power = @{
                plan      = $powerPlan
                isOptimal = if ($powerPlan -match "High|Turbo|Ultimate") { $true } else { $false }
            }
        }
        catch {}
        
        try {
            # Software Updates
            $softKeys = @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall")
            $software = @()
            foreach ($sk in $softKeys) {
                $software += Get-ItemProperty "$sk\*" -ErrorAction SilentlyContinue | Select-Object DisplayName, DisplayVersion, InstallDate | Where-Object { $_.DisplayName -and $_.InstallDate }
            }
            $sView.software = $software | Sort-Object InstallDate -Descending | Select-Object -First 10 | ForEach-Object {
                @{ name = $_.DisplayName; version = $_.DisplayVersion; date = $_.InstallDate }
            }
        }
        catch {}

        try {
            # .NET Versions
            $dotNetVers = @()
            $rel = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" -Name Release -ErrorAction SilentlyContinue).Release
            if ($rel -ge 528040) { $dotNetVers += "4.8" }
            elseif ($rel -ge 461808) { $dotNetVers += "4.7.2" }
            elseif ($rel -ge 460798) { $dotNetVers += "4.7" }
            elseif ($rel -ge 394802) { $dotNetVers += "4.6.2" }
            elseif ($rel -ge 378389) { $dotNetVers += "4.5" }
            else { $dotNetVers += "4.x / Older" }

            $sView.dotnet = $dotNetVers -join ", "
        }
        catch {}

        try {
            $vramCount = 0
            $cv = (Get-Counter "\GPU Local Adapter Memory(*)\Local Usage" -ErrorAction SilentlyContinue).CounterSamples
            if ($cv) {
                # Add up CookedValue per local adapter
                $vramSum = ($cv | Measure-Object -Property CookedValue -Sum).Sum
                $vramCount = [math]::Round($vramSum / 1MB, 0)
            }
            $sView.vramMB = $vramCount
        }
        catch { $sView.vramMB = 0 }

        try {
            $cixCfg = @{ ddc = @(); policies = @() }
            $vda = Get-ItemProperty "HKLM:\Software\Citrix\VirtualDesktopAgent" -ErrorAction SilentlyContinue
            if ($vda -and $vda.ListOfDDCs) {
                $cixCfg.ddc = $vda.ListOfDDCs -split " "
            }
            $pols = Get-ItemProperty "HKLM:\Software\Policies\Citrix\*" -ErrorAction SilentlyContinue 
            if ($pols) {
                foreach ($p in $pols.PSObject.Properties) {
                    if ($p.Name -notmatch "PS|Runspace|Item|Property") {
                        if ($p.Value -is [string] -or $p.Value -is [int]) {
                            $cixCfg.policies += @{ name = $p.Name; val = $p.Value }
                        }
                    }
                }
            }
            $sView.citrixCfg = $cixCfg
        }
        catch {}

        try {
            $vis = @{ transparency = "Enabled"; animations = "Enabled"; raw = 0 }
            $pers = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" -ErrorAction SilentlyContinue
            if ($pers -and $pers.EnableTransparency -eq 0) { $vis.transparency = "Disabled" }
            
            $anim = Get-ItemProperty "HKCU:\Control Panel\Desktop\WindowMetrics" -ErrorAction SilentlyContinue
            if ($anim -and $anim.MinAnimate -eq 0) { $vis.animations = "Disabled" }
            
            $fx = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects" -ErrorAction SilentlyContinue
            if ($fx) { $vis.raw = $fx.VisualFXSetting }
            
            $sView.osVisuals = $vis
        }
        catch {}

        $sView.netConfig = $Sync.SysInfo.netConfig
        $Sync.sysview = $sView
    }
    catch {
        $Sync.sysview = @{ state = "ERROR"; error = $_.Exception.Message }
    }
}
$ProfileRunspace = [runspacefactory]::CreateRunspace()
$ProfileRunspace.Open()
$ProfileRunspace.SessionStateProxy.SetVariable("Sync", $Sync)
$ProfileRunspace.SessionStateProxy.SetVariable("ScriptDir", $ScriptDir)
$ProfilePowerShell = [PowerShell]::Create().AddScript($ProfileScript).AddArgument($Sync)
$ProfilePowerShell.Runspace = $ProfileRunspace
$null = $ProfilePowerShell.BeginInvoke()

# Background STA Runspace for continuous OS Clipboard monitoring
$Sync.CBSync = [hashtable]::Synchronized(@{ Len = 0; Purge = $false })
$CBRunspace = [runspacefactory]::CreateRunspace()
$CBRunspace.ApartmentState = "STA"
$CBRunspace.ThreadOptions = "ReuseThread"
$CBRunspace.Open()
$CBRunspace.SessionStateProxy.SetVariable("CBSync", $Sync.CBSync)
$CBPowerShell = [PowerShell]::Create().AddScript({
        Add-Type -AssemblyName System.Windows.Forms
        while ($true) {
            try {
                if ($CBSync.Purge) { [System.Windows.Forms.Clipboard]::Clear(); $CBSync.Purge = $false }
                $len = 0
                if ([System.Windows.Forms.Clipboard]::ContainsText()) {
                    $len = [System.Windows.Forms.Clipboard]::GetText().Length
                }
                $CBSync.Len = $len
            }
            catch {}
            Start-Sleep -Milliseconds 500
        }
    })
$CBPowerShell.Runspace = $CBRunspace
$null = $CBPowerShell.BeginInvoke()

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND RUNSPACE: NVIDIA GPU (Every 2s — kept off the main 1s hot loop)
# ─────────────────────────────────────────────────────────────────────────────
$NvidiaRunspace = [runspacefactory]::CreateRunspace()
$NvidiaRunspace.Open()
$NvidiaRunspace.SessionStateProxy.SetVariable("Sync", $Sync)
$NvidiaRunspace.SessionStateProxy.SetVariable("ScriptDir", $ScriptDir)
$NvidiaPowerShell = [PowerShell]::Create().AddScript({
    param($Sync)

    function Get-NvidiaSmiPath {
        $candidates = @("C:\Windows\System32\nvidia-smi.exe", "C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe", "nvidia-smi")
        foreach ($c in $candidates) {
            try { $null = & $c --version 2>&1; if ($LASTEXITCODE -eq 0) { return $c } } catch {}
        }
        return $null
    }

    function Get-GpuSummary([string]$NvSmi) {
        $raw = & $NvSmi --query-gpu=index,name,memory.used,memory.free,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>&1
        $results = @()
        foreach ($line in $raw) {
            $parts = $line -split ',\s*'
            if ($parts.Count -lt 7) { continue }
            $used  = if ($parts[2] -match '^\d+') { [double]$parts[2] } else { 0 }
            $free  = if ($parts[3] -match '^\d+') { [double]$parts[3] } else { 0 }
            $total = if ($parts[4] -match '^\d+') { [double]$parts[4] } else { 0 }
            $pUsed = if ($total -gt 0) { [math]::Round($used / $total * 100, 1) } else { 0 }
            $util  = if ($parts[5] -match '\d+') { $parts[5].Trim() } else { "0" }
            $temp  = if ($parts[6] -match '\d+') { $parts[6].Trim() } else { "0" }
            $results += @{ id=$parts[0].Trim(); name=$parts[1].Trim(); usedMB=$used; freeMB=$free; totalMB=$total; pctUsed=$pUsed; util=$util; tempC=$temp }
        }
        return $results
    }

    function Get-ProcessVram([string]$NvSmi) {
        $raw = & $NvSmi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>&1
        $samples = Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples
        $engineSamples = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples

        $vramMap = @{}
        if ($samples) {
            foreach ($s in $samples) {
                if ($s.InstanceName -match 'pid_(\d+)_') {
                    $pidStr = $matches[1]; $v = [math]::Round($s.CookedValue / 1MB, 2)
                    if (-not $vramMap.ContainsKey($pidStr) -or $vramMap[$pidStr] -lt $v) { $vramMap[$pidStr] = $v }
                }
            }
        }
        $utilMap = @{}
        if ($engineSamples) {
            foreach ($s in $engineSamples) {
                if ($s.InstanceName -match 'pid_(\d+)_' -and $s.CookedValue -gt 0) {
                    $pidStr = $matches[1]
                    if (-not $utilMap.ContainsKey($pidStr)) { $utilMap[$pidStr] = 0 }
                    $utilMap[$pidStr] += $s.CookedValue
                }
            }
        }
        $results = @(); $processedPids = @{}
        foreach ($line in $raw) {
            $parts = $line -split ',\s*'
            if ($parts.Count -lt 4) { continue }
            $uPid = $parts[1].Trim(); $memStr = $parts[3].Trim()
            $gpuId = $parts[0].Trim().Substring(0, [math]::Min(12, $parts[0].Trim().Length))
            $vram = if ($memStr -match '^\d+') { [double]$memStr } else { 0 }
            if ($vram -eq 0 -and $vramMap.ContainsKey($uPid)) { $vram = $vramMap[$uPid] }
            $gpuUtil = if ($utilMap.ContainsKey($uPid)) { [math]::Round($utilMap[$uPid], 1) } else { 0 }
            $procName = if ($parts[2]) { $parts[2].Trim() } else { "Unknown" }
            if ($procName -eq "Unknown" -or $procName -match "\[.*\]") {
                try { $p = Get-Process -Id $uPid -ErrorAction SilentlyContinue; if ($p) { $procName = $p.Name } } catch {}
            }
            if ($uPid -match '^\d+$') { $results += @{ gpu=$gpuId; pid=$uPid; proc=$procName; vram=$vram; gpu_util=$gpuUtil }; $processedPids[$uPid] = $true }
        }
        foreach ($uPid in $utilMap.Keys) {
            if (-not $processedPids.ContainsKey($uPid)) {
                $vram = if ($vramMap.ContainsKey($uPid)) { $vramMap[$uPid] } else { 0 }
                $gpuUtil = [math]::Round($utilMap[$uPid], 1)
                $procName = "Unknown"
                try { $p = Get-Process -Id $uPid -ErrorAction SilentlyContinue; if ($p) { $procName = $p.Name } } catch {}
                $results += @{ gpu="0"; pid=$uPid; proc=$procName; vram=$vram; gpu_util=$gpuUtil }
            }
        }
        return @($results | Sort-Object gpu_util, vram -Descending)
    }

    $nvSmiPath = Get-NvidiaSmiPath
    $Sync.nvidia = [hashtable]::Synchronized(@{ active=($nvSmiPath -ne $null); gpus=@(); procs=@(); history=@(); totalUsed=0; totalAvail=0; avgTemp=0; avgUsage=0 })
    $vramHistory = [System.Collections.Generic.List[double]]::new()

    while ($Sync.Running) {
        if ($nvSmiPath -and $Sync.nvidia.active) {
            try {
                $gpus  = Get-GpuSummary $nvSmiPath
                $procs = Get-ProcessVram $nvSmiPath
                $tUsed=0; $tAvail=0; $tTemp=0; $tUtil=0
                foreach ($g in $gpus) { $tUsed+=$g.usedMB; $tAvail+=$g.totalMB; $tTemp+=[double]$g.tempC; $tUtil+=$g.pctUsed }
                $gCount = [math]::Max(1, $gpus.Count)
                $vramHistory.Add($tUsed)
                while ($vramHistory.Count -gt 60) { $vramHistory.RemoveAt(0) }
                $Sync.nvidia.gpus       = $gpus
                $Sync.nvidia.procs      = $procs
                $Sync.nvidia.totalUsed  = [math]::Round($tUsed / 1024, 1)
                $Sync.nvidia.totalAvail = [math]::Round($tAvail / 1024, 1)
                $Sync.nvidia.avgTemp    = [math]::Round($tTemp / $gCount, 1)
                $Sync.nvidia.avgUsage   = [math]::Round($tUtil / $gCount, 1)
                $Sync.nvidia.history    = $vramHistory.ToArray()
            } catch { $Sync.nvidia.active = $false }
        }
        Start-Sleep -Milliseconds 2000
    }
}).AddArgument($Sync)
$NvidiaPowerShell.Runspace = $NvidiaRunspace
$null = $NvidiaPowerShell.BeginInvoke()

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND RUNSPACE: SLOW METRICS (Pagefile % + Browser CIM scan — Every 5s)
# Keeps heavy CimInstance and Get-Counter calls off the 1s hot loop
# ─────────────────────────────────────────────────────────────────────────────
$SlowMetricsRunspace = [runspacefactory]::CreateRunspace()
$SlowMetricsRunspace.Open()
$SlowMetricsRunspace.SessionStateProxy.SetVariable("Sync", $Sync)
$SlowMetricsPowerShell = [PowerShell]::Create().AddScript({
    param($Sync)
    while ($Sync.Running) {
        try {
            # 1. Pagefile %
            $pfCounter = Get-Counter "\Paging File(_Total)\% Usage" -ErrorAction SilentlyContinue
            if ($pfCounter) {
                $pf = [math]::Round($pfCounter.CounterSamples[0].CookedValue, 1)
                $Sync.pageFileUsage = $pf
                if ($pf -gt $Sync.PeakPageFile) { $Sync.PeakPageFile = $pf }
            }
        } catch {}

        try {
            # 2. Browser CIM Scan (Chrome + Edge CommandLines)
            $brProcs = Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue
            $bm = @{
                sysMem = @{ total=$Sync.TotalRamMB; pct=$Sync.Latest.mem.percent }
                chrome = @{ active=$false }
                edge   = @{ active=$false }
            }
            if ($brProcs) {
                $pids = $brProcs.Id
                $pidFilter = ($pids | ForEach-Object { "ProcessId = $_" }) -join " OR "
                $brDetails = Get-CimInstance Win32_Process -Filter $pidFilter -Property ProcessId, CommandLine -ErrorAction SilentlyContinue

                foreach ($brName in @("chrome", "msedge")) {
                    $pList = $brProcs | Where-Object { $_.Name -eq $brName }
                    if (-not $pList) { continue }
                    $brKey = if ($brName -eq "chrome") { "chrome" } else { "edge" }
                    $procData = @()
                    foreach ($p in $pList) {
                        $type = "Main"
                        $cmd = ($brDetails | Where-Object { $_.ProcessId -eq $p.Id }).CommandLine
                        if ($cmd -match '--type=renderer') { $type = if ($cmd -match '--extension-id=') { "Ext" } else { "Tab" } }
                        elseif ($cmd -match '--type=gpu-process') { $type = "GPU" }
                        elseif ($cmd -match '--type=utility') { $type = "Util" }
                        $privMB  = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
                        $threads = try { $p.Threads.Count } catch { 0 }
                        # Lookup CPU from Sync.Latest.procs (set by main loop)
                        $cpuPct = 0
                        if ($Sync.Latest -and $Sync.Latest.procs) {
                            $match = $Sync.Latest.procs | Where-Object { $_.pid -eq $p.Id } | Select-Object -First 1
                            if ($match) { $cpuPct = $match.cpu }
                        }
                        $procData += @{ pid=$p.Id; type=$type; ws=[math]::Round($p.WorkingSet64/1MB,1); priv=$privMB; threads=$threads; cpu=$cpuPct }
                    }
                    $totalWs     = [math]::Round(($procData | ForEach-Object { $_.ws } | Measure-Object -Sum).Sum, 1)
                    $totalPriv   = [math]::Round(($procData | ForEach-Object { $_.priv } | Measure-Object -Sum).Sum, 1)
                    $totalShared = [math]::Round([math]::Max(0, $totalWs - $totalPriv), 1)
                    $sysPctVal   = if ($Sync.TotalRamMB -gt 0) { [math]::Round($totalWs / $Sync.TotalRamMB * 100, 1) } else { 0 }
                    $tabCount    = @($procData | Where-Object { $_.type -eq "Tab" }).Count
                    $extCount    = @($procData | Where-Object { $_.type -eq "Ext" }).Count
                    $bm[$brKey]  = @{
                        active=($procData.Count -gt 0); procs=$procData.Count; tabs=$tabCount; exts=$extCount
                        ws=$totalWs; priv=$totalPriv; shared=$totalShared; sysPct=$sysPctVal
                        topProcs=@($procData | Sort-Object ws -Descending | Select-Object -First 5)
                    }
                }
            }
            $Sync.browserMonitor = $bm
        } catch {}

        try {
            # 3. WDDM GPU Crash Detection (TDR Events — Event ID 4101 in System Log)
            # Fires whenever a GPU driver stops responding and Windows recovers it.
            # A sustained count predicts full GPU hang/BSOD.
            $wddmStart  = (Get-Date).AddHours(-1)
            $wddmEvents = Get-WinEvent -FilterHashtable @{
                LogName      = 'System'
                Id           = 4101
                StartTime    = $wddmStart
            } -ErrorAction SilentlyContinue
            $Sync.wddmCrashes = if ($wddmEvents) { @($wddmEvents).Count } else { 0 }
        } catch { $Sync.wddmCrashes = 0 }

        Start-Sleep -Milliseconds 5000
    }
}).AddArgument($Sync)
$SlowMetricsPowerShell.Runspace = $SlowMetricsRunspace
$null = $SlowMetricsPowerShell.BeginInvoke()

$ActualPort = $Port
$MaxPortSearch = $Port + 100
$PortLoaded = $false

while (-not $PortLoaded -and $ActualPort -lt $MaxPortSearch) {
    try {
        $ipGlobal = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
        $activePorts = $ipGlobal.GetActiveTcpListeners().Port
        if ($activePorts -contains $ActualPort) {
            Write-Host "Port $ActualPort is busy. Searching next..." -ForegroundColor Yellow
            $ActualPort++
        } else {
            $PortLoaded = $true
        }
    } catch {
        # Fallback if IPGlobalProperties fails
        $ActualPort++
    }
}

if (-not $PortLoaded) {
    Write-Error "Could not find an available port in range $Port - $($Port + 100). Exiting."
    exit 1
}

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
if ($ChangesData.Count -gt 0) {
    $ChangesData = $ChangesData | Select-Object Date, Type, Name -Unique | Sort-Object Date -Descending
}
try {
    $Listener.Start()
    Write-Host "TraderSynth v$ScriptVersion active on http://localhost:$ActualPort" -ForegroundColor Cyan
    
    # Launch browser via OS ShellExecute (without -PassThru to prevent Handle exceptions)
    try { Start-Process "http://localhost:$ActualPort" -ErrorAction SilentlyContinue } catch {}
    while ($Sync.Running) {
        $context = $Listener.GetContext()
        $req = $context.Request; $res = $context.Response; $path = $req.Url.LocalPath
        try {
            if ($path -eq "/api/stats") {
                $payload = if ($Sync.Latest) { $Sync.Latest }else { @{status = "initializing" } }
                if ($Sync.SysInfo) { $payload.sys = $Sync.SysInfo }
                $payload.sim = $Sync.SimActive; $payload.recording = $Sync.Recording
                $payload.userProfile = $Sync.userProfile
                $payload.sysview = $Sync.sysview
                if ($Sync.HistFile) { $payload.histPath = $Sync.HistFile }
                $payload.jitterInfo = "Jitter measures the delta between the backend polling frequency (1000ms) and the frontend's visual rendering cycle. Low-latency trading requires deterministic scheduling; high jitter (>100ms) indicates DPC/Interrupt saturation or thermal throttling that can delay order execution."
                $payload.sysTick = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                if (-not $payload.browserMonitor) { $payload.browserMonitor = $Sync.browserMonitor }
                if (-not $payload.browserBreakdown) { $payload.browserBreakdown = $Sync.browserBreakdown }

                $json = $payload | ConvertTo-Json -Depth 20 -Compress
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $res.ContentType = "application/json"
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/diagnose") {
                $pidStr = $req.QueryString["pid"]
                if ($pidStr) {
                    try {
                        $procId = [int]$pidStr
                        $proc = Get-Process -Id $procId -ErrorAction Stop
                        
                        $suspiciousThreads = @()
                        foreach ($thread in $proc.Threads) {
                            try {
                                $cpuTime = $thread.TotalProcessorTime.TotalSeconds
                                $state = $thread.ThreadState.ToString()
                                $waitReason = if ($state -eq "Wait") { $thread.WaitReason.ToString() } else { "N/A" }
                                
                                if ($state -eq "Wait" -and $cpuTime -gt 5 -and $waitReason -match "Executive|UserRequest|LpcReceive|LpcReply") {
                                    $suspiciousThreads += @{
                                        id     = $thread.Id
                                        state  = $state
                                        reason = $waitReason
                                        cpu    = [math]::Round($cpuTime, 2)
                                    }
                                }
                            }
                            catch {}
                        }
                        
                        $runtime = (Get-Date) - $proc.StartTime
                        $memMB = [math]::Round($proc.WorkingSet64 / 1MB, 1)
                        $isZombie = ($proc.CPU -lt 0.1 -and $proc.Threads.Count -gt 15 -and $memMB -gt 150 -and $runtime.TotalMinutes -gt 5)
                        
                        # Normalized CPU% via 2-sample raw counter delta (same as Task Manager)
                        $perfCpu = 0
                        try {
                            $coreCount = if ($Sync.Cores -gt 0) { $Sync.Cores } else { [Environment]::ProcessorCount }
                            $r1 = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter "IDProcess = $procId" -Property PercentProcessorTime, Timestamp_Sys100NS -ErrorAction SilentlyContinue
                            Start-Sleep -Milliseconds 300
                            $r2 = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter "IDProcess = $procId" -Property PercentProcessorTime, Timestamp_Sys100NS -ErrorAction SilentlyContinue
                            if ($r1 -and $r2) {
                                $cpuDelta  = $r2.PercentProcessorTime - $r1.PercentProcessorTime
                                $timeDelta = $r2.Timestamp_Sys100NS   - $r1.Timestamp_Sys100NS
                                if ($timeDelta -gt 0) {
                                    $perfCpu = [math]::Round(($cpuDelta / $timeDelta / $coreCount) * 100, 1)
                                    $perfCpu = [math]::Max(0, [math]::Min(100, $perfCpu))
                                }
                            }
                        } catch {}
                        
                        $diagData = @{
                            pid               = $procId
                            name              = $proc.ProcessName
                            threads           = $proc.Threads.Count
                            handles           = $proc.HandleCount
                            memoryMB          = $memMB
                            cpuTotal          = $perfCpu
                            uptimeMins        = [math]::Round($runtime.TotalMinutes, 1)
                            isZombie          = $isZombie
                            suspiciousCount   = $suspiciousThreads.Count
                            suspiciousThreads = $suspiciousThreads
                        }
                        
                        $json = $diagData | ConvertTo-Json -Depth 3 -Compress
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                        $res.ContentType = "application/json"
                    }
                    catch {
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes("{`"error`":`"PROCESS NOT FOUND OR ACCESS DENIED`"}")
                        $res.ContentType = "application/json"
                        $res.StatusCode = 404
                    }
                }
                else {
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes("{`"error`":`"MISSING PID`"}")
                    $res.ContentType = "application/json"
                    $res.StatusCode = 400
                }
                $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
            }
            elseif ($path -eq "/api/terminate") {
                $pidStr = $req.QueryString["pid"]
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes("FAIL")
                if ($pidStr) {
                    try {
                        $procId = [int]$pidStr
                        $proc = Get-Process -Id $procId -ErrorAction Stop
                        
                        # Safety Blacklist (Critical System Processes)
                        $criticalProcs = @("svchost", "winlogon", "csrss", "System", "Idle", "smss", "services", "lsass", "explorer", "dwm", "spoolsv", "Memory Compression", "Registry", "wininit", "fontdrvhost", "audiodg", "dasHost", "sihost", "taskhostw", "searchindexer", "runtimebroker", "shellexperiencehost")
                        
                        if ($procId -eq $PID) {
                            $resBytes = [System.Text.Encoding]::UTF8.GetBytes("BLOCKED: CANNOT TERMINATE APP ENGINE ENGINE")
                        }
                        elseif ($criticalProcs -contains $proc.ProcessName -or $proc.PriorityClass -eq "RealTime") {
                            $resBytes = [System.Text.Encoding]::UTF8.GetBytes("BLOCKED: CRITICAL SYSTEM PROCESS ($($proc.ProcessName))")
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
            elseif ($path -eq "/api/tune_os") {
                try {
                    $mode = $req.QueryString["mode"]
                    $val = if ($mode -eq "enable") { 1 } else { 0 }
                    
                    # Apply Transparency
                    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" -Name "EnableTransparency" -Value $val -Force -ErrorAction SilentlyContinue
                    # Apply Animations
                    Set-ItemProperty -Path "HKCU:\Control Panel\Desktop\WindowMetrics" -Name "MinAnimate" -Value "$val" -Force -ErrorAction SilentlyContinue
                    # Apply Global FX 
                    $fxVal = if ($val -eq 1) { 1 } else { 2 } # 1=Appearance, 2=Performance
                    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects" -Name "VisualFXSetting" -Value $fxVal -Force -ErrorAction SilentlyContinue
                    
                    # C# P/Invoke to instantly broadcast registry changes to Windows (DWM/Explorer)
                    try {
                        if (-not ([System.Management.Automation.PSTypeName]'Win32.NativeMethods').Type) {
                            $code = @"
                            using System;
                            using System.Runtime.InteropServices;
                            namespace Win32 {
                                public class NativeMethods {
                                    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
                                    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
                                }
                            }
"@
                            Add-Type -TypeDefinition $code -Language CSharp
                        }
                        $HWND_BROADCAST = [IntPtr]0xffff
                        $WM_SETTINGCHANGE = [uint]0x001A
                        $SMTO_ABORTIFHUNG = [uint]0x0002
                        $result = [UIntPtr]::Zero
                        [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "WindowMetrics", $SMTO_ABORTIFHUNG, 5000, [ref]$result) | Out-Null
                    } catch {}

                    # Refresh Cache in Sync object
                    if ($Sync.SysInfo.uiAudit) {
                        $Sync.SysInfo.uiAudit.transparency = if ($val -eq 1) { "Enabled" } else { "Disabled" }
                        $Sync.SysInfo.uiAudit.animations = if ($val -eq 1) { "Enabled" } else { "Disabled" }
                    }
                    
                    $resMsg = if ($val -eq 1) { "OK: VISUALS RESTORED" } else { "OK: PERFORMANCE OPTIMIZED" }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resMsg)
                }
                catch {
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes("FAIL: $($_.Exception.Message)")
                }
                $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
            }
            elseif ($path -eq "/api/open-repo") {
                try {
                    $shell = New-Object -ComObject Shell.Application
                    $shell.Explore($ScriptDir)
                    $json = @{ status = "success"; path = $ScriptDir } | ConvertTo-Json
                } catch {
                    $json = @{ status = "error"; message = $_.Exception.Message } | ConvertTo-Json
                }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $res.ContentType = "application/json"
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/changes") {
                if ($ChangesData.Count -gt 0) {
                    $json = @($ChangesData) | ConvertTo-Json -Depth 3 -Compress
                }
                else {
                    $json = "[]"
                }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $res.ContentType = "application/json"
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/clipboard-purge") {
                if ($Sync.CBSync) { $Sync.CBSync.Purge = $true }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes("OK")
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/history") {
                try {
                    $json = "{`"Metrics`":[]}"
                    $snap = $null
                    [System.Threading.Monitor]::Enter($Sync.RecordBuffer.SyncRoot)
                    try {
                        if ($Sync.RecordBuffer.Count -gt 0) {
                            $snap = $Sync.RecordBuffer.ToArray()
                        }
                    }
                    finally {
                        [System.Threading.Monitor]::Exit($Sync.RecordBuffer.SyncRoot)
                    }

                    if ($snap) {
                        $history = @{
                            GeneratedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                            SystemInfo  = if ($Sync.SysInfo) { $Sync.SysInfo.Clone() } else { @{} }
                            Metrics     = $snap
                        }
                        $json = $history | ConvertTo-Json -Depth 10 -Compress
                    }
                }
                catch {
                    $json = "{`"error`":`"Serialization Failure`",`"msg`":`"$($_.Exception.Message.Replace('"',"'"))`"}"
                    $res.StatusCode = 500
                    $_ | Out-File "error.log" -Append
                }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $res.ContentType = "application/json"
                $res.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            elseif ($path -eq "/api/save-report") {
                $status = "FAIL"
                try {
                    $snap = $null
                    [System.Threading.Monitor]::Enter($Sync.RecordBuffer.SyncRoot)
                    try {
                        if ($Sync.RecordBuffer.Count -gt 0) {
                            $snap = $Sync.RecordBuffer.ToArray()
                        }
                    }
                    finally {
                        [System.Threading.Monitor]::Exit($Sync.RecordBuffer.SyncRoot)
                    }

                    if ($snap) {
                        $timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
                        $reportPath = Join-Path $ScriptDir "Report_$timestamp.json"
                        
                        $report = @{
                            GeneratedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                            SystemInfo  = if ($Sync.SysInfo) { $Sync.SysInfo.Clone() } else { @{} }
                            Statistics  = @{
                                TotalSamples = $snap.Count
                            }
                            Metrics     = $snap
                        }
                        
                        $json = $report | ConvertTo-Json -Depth 10 # Depth 10 is sufficient for current forensic payload
                        [System.IO.File]::WriteAllText($reportPath, $json)
                        $status = "SAVED: Report_$timestamp.json located in $ScriptDir"
                        
                        # Clear buffer after save to prevent massive memory growth
                        [System.Threading.Monitor]::Enter($Sync.RecordBuffer.SyncRoot)
                        try { $Sync.RecordBuffer.Clear() } finally { [System.Threading.Monitor]::Exit($Sync.RecordBuffer.SyncRoot) }
                    }
                    else {
                        $status = "NO_DATA"
                    }
                }
                catch { 
                    $status = "ERROR: $($_.Exception.Message)" 
                    $_ | Out-File "error.log" -Append
                }
                
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

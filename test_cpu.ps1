$prev = @{};
$iters = 5;
for ($i=0; $i -lt $iters; $i++) {
    $procs = Get-Process -ErrorAction SilentlyContinue
    $arr = @()
    foreach ($p in $procs) {
        try {
            $secs = $p.TotalProcessorTime.TotalSeconds
            if ($prev.ContainsKey($p.Id)) {
                $delta = ($secs - $prev[$p.Id]) * 100 / $env:NUMBER_OF_PROCESSORS
                if ($delta -gt 0) { $arr += @{ n=$p.ProcessName; c=$delta } }
            }
            $prev[$p.Id] = $secs
        } catch {}
    }
    $arr = $arr | Sort-Object c -Descending | Select -First 3
    Write-Host "Iter $i"
    $arr | Format-Table
    Start-Sleep -Seconds 1
}

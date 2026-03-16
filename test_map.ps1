$pCpu = Get-Counter "\Process(*)\% Processor Time" -ErrorAction SilentlyContinue
$pId = Get-Counter "\Process(*)\ID Process" -ErrorAction SilentlyContinue
$map = @{}
$idMap = @{}
if ($pCpu -and $pId) {
    foreach ($samp in $pId.CounterSamples) {
        if ($samp.Path -match "process\(([^)]+)\)\\id process") {
            $idMap[$matches[1]] = $samp.CookedValue
        }
    }
    foreach ($samp in $pCpu.CounterSamples) {
        if ($samp.Path -match "process\(([^)]+)\)\\") {
            $inst = $matches[1]
            if ($idMap.ContainsKey($inst)) {
                $pidNum = [int]$idMap[$inst]
                $map[$pidNum] = $samp.CookedValue / $env:NUMBER_OF_PROCESSORS
            }
        }
    }
}
$map.GetEnumerator() | Sort-Object Value -Descending | Select -First 3 | ConvertTo-Json

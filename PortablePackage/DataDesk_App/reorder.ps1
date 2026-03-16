$html = Get-Content -Raw "index.html" -Encoding UTF8

function Get-Block($marker) {
    if (-not $html.Contains($marker)) { return "" }
    $start = $html.IndexOf($marker)
    $divStart = $html.IndexOf("<div", $start)
    $count = 0
    $end = $divStart
    while ($end -lt $html.Length) {
        if ($html.Substring($end, 4) -eq "<div") {
            $count++
            $end += 4
        }
        elseif ($html.Substring($end, 5) -eq "</div") {
            $count--
            $end += 5
            if ($count -eq 0) {
                $end = $html.IndexOf(">", $end) + 1
                return $html.Substring($start, $end - $start)
            }
        }
        else {
            $end++
        }
    }
    return ""
}

$net = Get-Block "<!-- NETWORK INFRASTRUCTURE (Simplified & Redesigned) -->"
$html = $html.Replace($net, "")

$periph = Get-Block "<!-- PERIPHERALS & TOPOGRAPHY -->"
$html = $html.Replace($periph, "")

$browser = Get-Block "<!-- BROWSER MEMORY MONITOR (EXPANDED) -->"
$html = $html.Replace($browser, "")

$m365 = Get-Block "<!-- M365 DESKTOP INFRASTRUCTURE -->"
$html = $html.Replace($m365, "")

$forensics = Get-Block "<!-- ROW 5: UNIFIED FORENSIC INTELLIGENCE -->"
$html = $html.Replace($forensics, "")

# Remove row wrappers
$r2Start = $html.IndexOf("<!-- ROW 2: NETWORK & PERIPHERALS CLUSTER")
$r2EndDiv = $html.IndexOf("</div>", $r2Start) + 6
$html = $html.Remove($r2Start, $r2EndDiv - $r2Start)

$r3bStart = $html.IndexOf("<!-- ROW 3b: EXPANDED BROWSER & M365")
$r3bEndDiv = $html.IndexOf("</div>", $r3bStart) + 6
$html = $html.Remove($r3bStart, $r3bEndDiv - $r3bStart)

# Insert points
$r1Start = $html.IndexOf("<!-- ROW 1: PRIMARY COMPUTE STACK")
$end = $html.IndexOf("<div", $r1Start)
$count = 0
while ($end -lt $html.Length) {
    if ($html.Substring($end, 4) -eq "<div") {
        $count++; $end += 4
    }
    elseif ($html.Substring($end, 5) -eq "</div") {
        $count--; $end += 5
        if ($count -eq 0) {
            $end = $html.IndexOf(">", $end) + 1
            break
        }
    }
    else { $end++ }
}
$r1End = $end

$newRow2 = "`r`n`r`n                    <!-- NEW ROW 2 (Promoted): UNIFIED FORENSIC INTELLIGENCE -->`r`n                    " + $forensics + "`r`n"
$newRow3 = "`r`n`r`n                    <!-- NEW ROW 3 (Swapped): NETWORK & BROWSER CLUSTER (2-Card Wide) -->`r`n                    <div style=`"display:grid; grid-template-columns: 1fr 1fr; gap:25px; margin-bottom:25px;`">`r`n                        " + $net + "`r`n                        " + $browser + "`r`n                    </div>`r`n"

$html = $html.Insert($r1End, $newRow2 + $newRow3)

$r3aStart = $html.IndexOf("<!-- ROW 3a: SUPPORTING TELEMETRY (3-Card Layout) -->")
$end = $html.IndexOf("<div", $r3aStart)
$count = 0
while ($end -lt $html.Length) {
    if ($html.Substring($end, 4) -eq "<div") {
        $count++; $end += 4
    }
    elseif ($html.Substring($end, 5) -eq "</div") {
        $count--; $end += 5
        if ($count -eq 0) {
            $end = $html.IndexOf(">", $end) + 1
            break
        }
    }
    else { $end++ }
}
$r3aEnd = $end

$newRow4b = "`r`n`r`n                    <!-- NEW ROW 4b: EXPANDED PERIPHERALS & M365 (2-Card Layout) -->`r`n                    <div id=`"telemetry-addon-row-b`" style=`"display:grid; grid-template-columns: 1.5fr 1fr; gap:20px; margin-bottom:25px;`">`r`n                        " + $periph + "`r`n                        " + $m365 + "`r`n                    </div>`r`n"

$html = $html.Insert($r3aEnd, $newRow4b)

# Save
Set-Content "index.html" $html -Encoding UTF8
Write-Host "Done"

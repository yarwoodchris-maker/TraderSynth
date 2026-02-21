function safeSetText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
}

console.log("TraderSynth Report Viewer: Initialization starting...");

window.onload = async function () {
    console.log("TraderSynth Report Viewer: Window loaded, checking storage...");
    try {
        var dataStr = await storage.loadReport();
        if (!dataStr) {
            console.error("TraderSynth Report Viewer: No data found in storage");
            document.body.innerHTML = "<div style='padding:100px; text-align:center; color:#fff;'><h1>NO DATA FOUND</h1><p>Please open a report from the main dashboard.</p></div>";
            return;
        }

        console.log("TraderSynth Report Viewer: Parsing " + dataStr.length + " bytes of JSON data...");
        var report = JSON.parse(dataStr);
        renderVisualReport(report);
    } catch (e) {
        console.error("TraderSynth Report Viewer: Error loading/parsing report", e);
        document.body.innerHTML = "<div style='padding:100px; text-align:center; color:#fff;'><h1>CORRUPT OR MISSING REPORT DATA</h1><p>" + e.message + "</p></div>";
    }
};

function renderVisualReport(report) {
    console.log("TraderSynth Report Viewer: Rendering visual report...");
    if (!report || !report.Metrics || report.Metrics.length === 0) {
        console.warn("TraderSynth Report Viewer: Report contains no metrics.");
        return;
    }

    var ms = report.Metrics;
    var count = ms.length;
    var sumHealth = 0, sumCpu = 0, sumMem = 0;
    var cpuData = [], memData = [];
    var topProcsMap = {};
    var vmIssues = [];

    for (var i = 0; i < count; i++) {
        var m = ms[i];
        sumHealth += (m.score || 0);

        if (m.cpu) {
            var cVal = m.cpu.usage || 0;
            sumCpu += cVal;
            cpuData.push(cVal);
        }

        if (m.mem) {
            var mVal = m.mem.percent || 0;
            sumMem += mVal;
            memData.push(mVal);
        }

        if (m.vmware) {
            if (m.vmware.costop > 3 && vmIssues.indexOf("CPU Co-Stop Contentions") === -1) vmIssues.push("CPU Co-Stop Contentions");
            if (m.vmware.swap > 0 && vmIssues.indexOf("Hypervisor Memory Swapping") === -1) vmIssues.push("Hypervisor Memory Swapping");
            if (m.vmware.cpuReady > 10 && vmIssues.indexOf("CPU Ready Latency spikes") === -1) vmIssues.push("CPU Ready Latency spikes");
        }

        if (m.procs) {
            for (var p = 0; p < Math.min(m.procs.length, 3); p++) {
                var proc = m.procs[p];
                if (!topProcsMap[proc.name]) topProcsMap[proc.name] = { count: 0, avgCpu: 0 };
                topProcsMap[proc.name].count++;
                topProcsMap[proc.name].avgCpu += (proc.cpu || 0);
            }
        }
    }

    safeSetText("rep-health", Math.round(sumHealth / count));
    safeSetText("rep-samples", count);
    safeSetText("rep-duration", ms[count - 1].uptime || "--");
    safeSetText("rep-timestamp", report.GeneratedAt || "--");
    safeSetText("rep-cpu-avg", Math.round(sumCpu / count));
    safeSetText("rep-mem-avg", Math.round(sumMem / count));

    drawReportChart("rep-cpu-svg", cpuData, 100);
    drawReportChart("rep-mem-svg", memData, 100);

    var vmEl = document.getElementById("rep-vm-events");
    if (vmEl) {
        if (vmIssues.length > 0) {
            var h = "⚠️ <b style='color:var(--accent-red)'>Performance Risks Identified:</b><br><ul style='padding-left:15px; margin-top:10px;'>";
            for (var j = 0; j < vmIssues.length; j++) h += "<li>" + vmIssues[j] + "</li>";
            h += "</ul>";
            vmEl.innerHTML = h;
        } else {
            vmEl.innerHTML = "✅ <b style='color:var(--accent-green)'>Optimal Virtualization State:</b><br>No significant SMP scheduling delays detected.";
        }
    }

    var tpEl = document.getElementById("rep-top-procs");
    if (tpEl) {
        var sorted = [];
        for (var name in topProcsMap) sorted.push({ name: name, freq: topProcsMap[name].count, cpu: topProcsMap[name].avgCpu / topProcsMap[name].count });
        sorted.sort((a, b) => b.cpu - a.cpu);

        var tpH = "";
        for (var k = 0; k < Math.min(sorted.length, 6); k++) {
            var s = sorted[k];
            tpH += `<div style="background:rgba(255,255,255,0.03); padding:15px; border-radius:12px; border:1px solid rgba(255,255,255,0.05); transition:transform 0.2s;">
                <div style="font-weight:800; font-size:0.8rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#fff;">${s.name}</div>
                <div style="font-size:0.6rem; color:var(--accent-blue); font-weight:700; margin-top:6px;">AVG LOAD: ${s.cpu.toFixed(1)}%</div>
            </div>`;
        }
        tpEl.innerHTML = tpH;
    }
    console.log("TraderSynth Report Viewer: Rendering complete.");
}

function drawReportChart(id, data, max) {
    var svg = document.getElementById(id);
    if (!svg) return;
    var w = 300, h = 100, l = data.length;
    if (l < 2) return;

    var pts = "";
    for (var i = 0; i < l; i++) {
        var x = (i / (l - 1)) * w;
        var y = h - (Math.min(data[i], max) / max) * 85 - 5;
        pts += (i === 0 ? "M " : " L ") + x + " " + y;
    }

    var line = svg.querySelector(".spark-path");
    var fill = svg.querySelector(".rep-fill");

    if (line) line.setAttribute("d", pts);
    if (fill) fill.setAttribute("d", pts + " L " + w + " " + h + " L 0 " + h + " Z");
}

const definitions = {
    health: {
        title: "TRADER HEALTH SCORE CALCULATION",
        text: "The score represents the 'deterministic stability' of the system over the trace duration. It starts at 100 and is reduced based on: (1) Core CPU load (1 point per 4% load), (2) Memory Pressure (25-point penalty if RAM > 85%), (3) Forensic Hazard Markers (20-point penalty for zombie processes, high kernel latency, or SMP synchronization delays). Range: 100-80 (Optimal), 79-60 (Moderate Contention), <60 (Critical Instability)."
    }
};

function showDef(type) {
    const def = definitions[type];
    if (!def) return;
    document.getElementById("modal-title").textContent = def.title;
    document.getElementById("modal-body").textContent = def.text;
    document.getElementById("info-modal").style.display = "block";
}

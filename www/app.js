// TraderSynth v3.7.0 - ANALYTICS PRO
// Strictly SES-Safe: No console, no .map, no .forEach

var metrics = {
    cpu: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    mem: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    disk: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    gpu: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    netIn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    netOut: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
};

var isSimOn = false;
var isRecordingOn = false;
var activeSlots = ["", "", "", "", ""]; // Reduced to Top 5
var activeReq = false;
var jLog = [];
var jitterExplanationGlobal = "";
var lastFrameTime = Date.now();
var ultraTickerCanvas = null;
var ultraTickerCtx = null;
var ultraTickerData = [];
var lastUltraTick = 0;
var isRunning = true;
var cpuSpark = [];
var memSpark = [];
var diskSpark = [];
var pendingPurgePid = null;
const MAX_SPARK = 50;
var localUptimeSeconds = 0;
var lastUptimeSync = "";
var lastThreadCounts = {};

function safeSetText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
}

function formatSeconds(s) {
    if (isNaN(s) || s < 0) return "00:00:00";
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ":" + (sec < 10 ? "0" + sec : sec);
}

function tickUptime() {
    // Legacy tick function removed; driven strictly by backend data.uptime now.
}

function initUltraTicker() {
    ultraTickerCanvas = document.getElementById("ultra-ticker-canvas");
    if (ultraTickerCanvas) {
        ultraTickerCtx = ultraTickerCanvas.getContext("2d");
        requestAnimationFrame(renderUltraTicker);
    }
}

function renderUltraTicker(time) {
    if (!ultraTickerCtx) {
        requestAnimationFrame(renderUltraTicker);
        return;
    }
    if (!isSimOn) {
        ultraTickerCtx.clearRect(0, 0, ultraTickerCanvas.width, ultraTickerCanvas.height);
        ultraTickerCtx.fillStyle = "#444";
        ultraTickerCtx.font = "italic 12px Inter";
        ultraTickerCtx.fillText("SIMULATION IDLE - WAITING FOR PACKETS...", 20, 35);
        requestAnimationFrame(renderUltraTicker);
        return;
    }

    if (time - lastUltraTick > 16) {
        lastUltraTick = time;
        var lastPrice = ultraTickerData.length > 0 ? ultraTickerData[ultraTickerData.length - 1].price : 45000.00;
        var change = (Math.random() - 0.5) * 10;
        ultraTickerData.push({ price: lastPrice + change, time: Date.now() });
        if (ultraTickerData.length > 50) ultraTickerData.shift();
    }

    ultraTickerCtx.clearRect(0, 0, ultraTickerCanvas.width, ultraTickerCanvas.height);
    ultraTickerCtx.strokeStyle = "#00d2ff";
    ultraTickerCtx.lineWidth = 2;
    ultraTickerCtx.beginPath();
    for (var i = 0; i < ultraTickerData.length; i++) {
        var x = (i / 50) * ultraTickerCanvas.width;
        var y = 60 - ((ultraTickerData[i].price - 44900) / 200) * 60;
        if (i === 0) ultraTickerCtx.moveTo(x, y);
        else ultraTickerCtx.lineTo(x, y);
    }
    ultraTickerCtx.stroke();

    if (ultraTickerData.length > 0) {
        var p = ultraTickerData[ultraTickerData.length - 1];
        ultraTickerCtx.fillStyle = "var(--text-main)";
        ultraTickerCtx.font = "bold 16px Outfit";
        ultraTickerCtx.fillText("$" + p.price.toFixed(2), ultraTickerCanvas.width - 120, 35);
        ultraTickerCtx.fillStyle = "#30d158";
        ultraTickerCtx.font = "8px Inter";
        ultraTickerCtx.fillText("REALTIME TICK FEED", ultraTickerCanvas.width - 120, 48);
    }
    requestAnimationFrame(renderUltraTicker);
}

function getDiagnosticColor(val, levels) {
    if (val <= levels[0]) return "var(--accent-blue)"; // Idle
    if (val <= levels[1]) return "var(--accent-green)"; // Nominal
    if (val <= levels[2]) return "#ffcc00"; // Warning (Yellow/Orange)
    return "var(--accent-red)"; // Critical
}

function drawAreaChart(id, data, max) {
    var svg = document.getElementById(id);
    if (!svg) return;
    var w = 300, h = 100, l = data.length;
    var pts = [];
    max = Math.max(max, 10); // Minimum scale floor

    // Safety
    if (l === 0) return;

    for (var i = 0; i < l; i++) {
        var x = (i / (l - 1)) * w;
        var y = h - (Math.min(data[i], max) / max) * 75 - 20; // Bound mapping with pad
        pts.push({ x: x, y: y });
    }

    var d = "M " + pts[0].x + "," + pts[0].y;
    for (var i = 1; i < l; i++) {
        var p = pts[i - 1], c = pts[i];
        var mx = (p.x + c.x) / 2;
        d += " C " + mx + "," + p.y + " " + mx + "," + c.y + " " + c.x + "," + c.y; // Spline curve mapping
    }

    var line = svg.querySelector(".spark-path"), fill = svg.querySelector(".spark-fill");
    if (line) line.setAttribute("d", d);
    if (fill) fill.setAttribute("d", d + " L " + w + " " + (h - 10) + " L 0 " + (h - 10) + " Z");

    // Dynamic Axes Injection
    var axes = svg.querySelector(".axes-group");
    if (!axes) {
        axes = document.createElementNS("http://www.w3.org/2000/svg", "g");
        axes.setAttribute("class", "axes-group");
        svg.appendChild(axes);
    }
    axes.innerHTML = "<line x1='0' y1='" + (h - 12) + "' x2='" + w + "' y2='" + (h - 12) + "' stroke='rgba(var(--text-rgb),0.2)' stroke-dasharray='4' stroke-width='1'/>" +
        "<line x1='0' y1='10' x2='" + w + "' y2='10' stroke='var(--border-light)' stroke-dasharray='2' stroke-width='1'/>" +
        "<text x='2' y='20' fill='rgba(var(--text-rgb),0.4)' font-size='10' font-family='monospace'>MAX:" + Math.round(max) + "</text>" +
        "<text x='2' y='" + (h - 16) + "' fill='rgba(var(--text-rgb),0.4)' font-size='10' font-family='monospace'>0</text>" +
        "<text x='" + (w - 25) + "' y='" + (h - 2) + "' fill='rgba(var(--text-rgb),0.4)' font-size='9'>NOW</text>" +
        "<text x='2' y='" + (h - 2) + "' fill='rgba(var(--text-rgb),0.4)' font-size='9'>-60s</text>";
}

function drawNetworkChart(inData, outData) {
    var svg = document.getElementById("net-spark-svg");
    if (!svg) return;
    var w = 300, h = 100, l = inData.length;
    var maxVal = 50;
    for (var i = 0; i < l; i++) {
        if (inData[i] > maxVal) maxVal = inData[i];
        if (outData[i] > maxVal) maxVal = outData[i];
    }

    function genSpline(arrData) {
        if (l === 0) return "";
        var cp = [];
        for (var i = 0; i < l; i++) {
            var x = (i / (l - 1)) * w;
            var y = h - (Math.min(arrData[i], maxVal) / maxVal) * 75 - 20;
            cp.push({ x: x, y: y });
        }
        var dt = "M " + cp[0].x + "," + cp[0].y;
        for (var i = 1; i < l; i++) {
            var p = cp[i - 1], c = cp[i], mx = (p.x + c.x) / 2;
            dt += " C " + mx + "," + p.y + " " + mx + "," + c.y + " " + c.x + "," + c.y;
        }
        return dt;
    }

    var pIn = document.getElementById("net-in-path");
    var pOut = document.getElementById("net-out-path");
    if (pIn) pIn.setAttribute("d", genSpline(inData));
    if (pOut) pOut.setAttribute("d", genSpline(outData));

    var pt = document.getElementById("net-peak-label");
    if (pt) pt.textContent = "PEAK: " + Math.round(maxVal);

    var axes = svg.querySelector(".axes-group");
    if (!axes) {
        axes = document.createElementNS("http://www.w3.org/2000/svg", "g");
        axes.setAttribute("class", "axes-group");
        svg.appendChild(axes);
    }
    axes.innerHTML = "<line x1='0' y1='" + (h - 1) + "' x2='" + w + "' y2='" + (h - 1) + "' stroke='rgba(var(--text-rgb),0.2)' stroke-dasharray='4' stroke-width='1'/>";
}

function updateHeatmap(id, loads, affinity) {
    var c = document.getElementById(id);
    if (!c || !loads) return;
    var h = "";
    var aff = affinity ? BigInt(affinity) : null;

    for (var i = 0; i < loads.length; i++) {
        var l = loads[i];
        var col = "rgba(0, 210, 255, 0.15)"; // Default Idle Blue
        var op = 0.3 + (l / 100) * 0.7;

        if (l < 5) {
            col = "rgba(0, 210, 255, " + op + ")"; // Idle Steel Blue
        } else if (l < 80) {
            // Gradient Green to Yellow
            var green = 209;
            var red = Math.floor((l / 80) * 255);
            col = "rgba(" + red + ", " + green + ", 88, " + op + ")";
        } else {
            // Stress Red
            col = "rgba(255, 55, 95, " + op + ")";
        }

        var border = "1px solid var(--border-light)";
        var title = 'Core C' + i + ': ' + Math.round(l) + '%';

        // Affinity Visualization
        if (aff !== null) {
            var allowed = (aff & (1n << BigInt(i))) !== 0n;
            if (allowed) {
                border = "1px solid var(--accent-blue)";
                title += " [OpenFin Allowed]";
            } else {
                col = "rgba(50,50,50,0.3)"; // Dim disallowed cores
                title += " [OpenFin Restricted]";
            }
        }

        h += '<div class="core-box ' + (l > 80 ? 'core-critical' : '') + '" style="background:' + col + '; border:' + border + '" title="' + title + '">C' + i + '</div>';
    }
    c.innerHTML = h;
}

function initStaticSlots() {
    var g = document.getElementById("process-grid-target");
    if (!g) return;
    var h = "";
    for (var i = 0; i < 5; i++) {
        h += '<div id="proc-slot-' + i + '" class="proc-card-row empty-slot">' +
            '<div style="display:flex; justify-content:space-between; font-size:0.75rem; font-weight:700;">' +
            '<span class="slot-name">--</span>' +
            '<span class="slot-th" style="opacity:0.4; font-size:0.65rem;">-- THREADS</span>' +
            '</div>' +
            '<div class="bar-bg-stripe"><div class="bar-fill-stripe" style="width:0%"></div></div>' +
            '<div style="display:flex; justify-content:space-between; font-size:0.6rem; margin-top:8px; opacity:0.6;">' +
            '<span class="slot-stats">--% LOAD | -- MB/s IO</span>' +
            '<span class="slot-ram">-- MB</span>' +
            '</div>' +
            '</div>';
    }
    g.innerHTML = h;
}

function updateTicker(market) {
    var t = document.getElementById("ticker-track");
    if (!t || !market || market.length === 0) return;
    var h = "";
    for (var i = 0; i < market.length; i++) {
        var tx = market[i];
        var col = tx.side === "BUY" ? "var(--accent-green)" : "var(--accent-red)";
        var ind = tx.side === "BUY" ? "+" : "-";
        h += '<div class="ticker-item">' +
            '<span>' + tx.asset + '</span>' +
            '<span style="color:' + col + '">' + ind + ' ' + tx.side + '</span>' +
            '<span style="font-family:monospace">$' + tx.price + '</span>' +
            '</div>';
    }
    t.innerHTML = h + h;
}

var globalHistPath = "";
function openHistory() {
    if (globalHistPath) {
        alert("Encrypted JSON Telemetry History Stream saved locally to:\n\n" + globalHistPath + "\n\nYou can upload this file into a secondary analytics workspace.");
    }
}

function purgeClipboard() {
    var cb = document.getElementById("cb-size-val");
    if (cb) cb.textContent = "PURGING...";
    fetch("/api/clipboard-purge").then(r => r.text()).catch(e => { });
}

function updateFrame(data) {
    if (!data) return;
    if (data.sysUp) safeSetText("sys-uptime-val", data.sysUp);
    if (data.uptime) safeSetText("uptime-display", data.uptime);
    if (data.cbLen !== undefined) {
        var cb = document.getElementById("cb-size-val");
        if (cb && cb.textContent.indexOf("PURGING") === -1) {
            var formatted = "0 KB";
            if (data.cbLen > 0) {
                if (data.cbLen > 1048576) {
                    formatted = (data.cbLen / 1048576).toFixed(1) + " MB";
                } else if (data.cbLen > 1024) {
                    formatted = (data.cbLen / 1024).toFixed(1) + " KB";
                } else {
                    formatted = data.cbLen + " B";
                }
            }
            cb.textContent = formatted;

            if (data.cbLen > 5242880) cb.style.color = "var(--accent-red)"; // > 5MB = Red
            else if (data.cbLen > 1048576) cb.style.color = "#ffcc00";      // > 1MB = Yellow
            else cb.style.color = "var(--accent-blue)";
        }
    }
    if (data.histPath) {
        globalHistPath = data.histPath;
        var hBtn = document.getElementById("hist-btn");
        if (hBtn) hBtn.style.display = "inline-block";
    }
    if (data.sys) {
        safeSetText("profile-os", data.sys.os);
        safeSetText("profile-user", data.sys.user || "--");
        safeSetText("profile-cpu", data.sys.cpu);
        safeSetText("profile-boot", data.sys.boot || "--");
        safeSetText("profile-ram", data.sys.ram);
        safeSetText("profile-ip", (data.sys.ip || "--") + " / " + (data.sys.subnet || "--"));
        safeSetText("profile-displays", data.sys.monitorCount || "1");
        if (document.getElementById("gpu-name")) document.getElementById("gpu-name").textContent = data.sys.gpu;
    }
    if (data.status === "initializing") return;

    try {
        jitterExplanationGlobal = data.jitterInfo || "Jitter not defined.";
        isSimOn = true;

        // 1. Hero Updates
        var hScore = Math.round(data.score || 0);
        var hEl = document.getElementById("health-score-text");
        if (hEl) {
            hEl.textContent = hScore;
            if (hScore === 100) hEl.style.color = "var(--accent-green)";
            else if (hScore >= 80) hEl.style.color = "var(--accent-blue)";
            else if (hScore >= 60) hEl.style.color = "#ffcc00";
            else hEl.style.color = "var(--accent-red)";
        }

        var uptimeEl = document.getElementById("uptime-display");
        if (uptimeEl && data.uptime && data.uptime !== lastUptimeSync) {
            lastUptimeSync = data.uptime;
            // Sync local timer with server (e.g. 01:23:45)
            var parts = data.uptime.split(':');
            if (parts.length === 3) {
                var s = (parseInt(parts[0]) * 3600) + (parseInt(parts[1]) * 60) + parseInt(parts[2]);
                if (!isNaN(s)) localUptimeSeconds = s;
            }
        }

        var simInd = document.getElementById("sim-status-indicator");
        if (simInd) {
            simInd.textContent = "LIVE";
            simInd.className = "status-neon-green";
        }

        if (data.market) {
            updateTicker(data.market);
        }

        if (data.overhead) {
            safeSetText("engine-pid-val", data.overhead.engine.pid || "--");
            safeSetText("engine-cpu-val", (data.overhead.engine.cpu || 0).toFixed(1) + "%");
            safeSetText("engine-ram-val", (data.overhead.engine.ram || 0).toFixed(0) + " MB");

            safeSetText("browser-pid-val", data.overhead.browser.pid || "--");
            var bCpu = data.overhead.browser.cpu || 0;
            // Provide visual indicator for browser CPU overhead mapping to actual usage
            var bCpuEl = document.getElementById("browser-cpu-val");
            if (bCpuEl) {
                bCpuEl.textContent = bCpu.toFixed(1) + "%";
                if (bCpu > 15) bCpuEl.style.color = "var(--accent-red)";
                else if (bCpu > 5) bCpuEl.style.color = "#ffcc00";
            }
            safeSetText("browser-ram-val", (data.overhead.browser.ram || 0).toFixed(0) + " MB");
        }

        // 2. Metrics 
        if (data.cpu) {
            safeSetText("cpu-usage-percent", (data.cpu.usage || 0).toFixed(1) + "%");

            var qEl = document.getElementById("cpu-queue-val");
            if (qEl) {
                qEl.textContent = data.cpu.queue;
                qEl.style.color = getDiagnosticColor(data.cpu.queue, [0, 2, 5]);
            }

            var kEl = document.getElementById("cpu-kernel-val");
            if (kEl) {
                kEl.textContent = (data.cpu.kernel || 0) + "%";
                kEl.style.color = getDiagnosticColor(data.cpu.kernel, [5, 15, 30]);
            }

            var ctxEl = document.getElementById("cpu-ctx-val");
            if (ctxEl) ctxEl.textContent = (data.cpu.ctx || 0).toLocaleString();

            metrics.cpu.shift(); metrics.cpu.push(data.cpu.usage || 0);
            drawAreaChart("cpu-spark-svg", metrics.cpu, 100);
            if (data.cpu.cores) updateHeatmap("cpu-core-grid", data.cpu.cores, data.openfin ? data.openfin.affinity : null);

            // Context Switch Saturation Visualization
            var dots = document.querySelectorAll(".cs-dot");
            var impact = data.cs_impact || 0;
            for (var i = 0; i < dots.length; i++) {
                if (i < impact / 2) {
                    var col = "var(--accent-blue)";
                    if (impact > 8) col = "var(--accent-red)";
                    else if (impact > 4) col = "#ffcc00";
                    dots[i].style.background = col;
                    dots[i].style.boxShadow = "0 0 5px " + col;
                } else {
                    dots[i].style.background = "rgba(var(--text-rgb),0.1)";
                    dots[i].style.boxShadow = "none";
                }
            }
        }

        if (data.mem) {
            safeSetText("mem-usage-percent", (data.mem.percent || 0).toFixed(1) + "%");
            safeSetText("mem-available-box", "Available: " + (data.mem.avail || 0));
            metrics.mem.shift(); metrics.mem.push(data.mem.percent || 0);
            drawAreaChart("mem-spark-svg", metrics.mem, 100);
        }

        if (data.disk) {
            safeSetText("disk-tp-box", (data.disk.tp || 0).toFixed(1) + " MB/S");
            safeSetText("disk-lat-box", "LATENCY: " + (data.disk.lat || 0) + "ms");
            safeSetText("disk-queue-box", "QUEUE: " + (data.disk.queue || 0));
            safeSetText("disk-read-iops", "R: " + (data.disk.readIOPS || 0));
            safeSetText("disk-write-iops", "W: " + (data.disk.writeIOPS || 0));

            metrics.disk.shift(); metrics.disk.push(data.disk.tp || 0);
            drawAreaChart("disk-spark-svg", metrics.disk, Math.max(15, data.disk.tp || 0));

            var baseEl = document.getElementById("disk-baseline-info");
            if (baseEl) {
                if (data.disk.baseline) {
                    baseEl.textContent = "Baseline: " + data.disk.baseline.toFixed(1) + "ms";
                } else {
                    baseEl.textContent = "Baseline: Initializing...";
                }
            }
        }

        if (data.sys) {
            var cpuModel = document.getElementById("cpu-model-name");
            if (cpuModel) cpuModel.textContent = data.sys.cpuModel || "";

            var osInfo = document.getElementById("os-info-box");
            if (osInfo) osInfo.textContent = data.sys.os || "";
        }

        if (data.gpu) {
            safeSetText("gpu-usage-val", (data.gpu.usage || 0).toFixed(1) + "%");
            safeSetText("gpu-enc-val", (data.gpu.encode || 0) + "%");
            safeSetText("gpu-dec-val", (data.gpu.decode || 0) + "%");

            var encBar = document.getElementById("gpu-enc-bar");
            if (encBar) encBar.style.width = (data.gpu.encode || 0) + "%";

            var decBar = document.getElementById("gpu-dec-bar");
            if (decBar) decBar.style.width = (data.gpu.decode || 0) + "%";

            metrics.gpu.shift(); metrics.gpu.push(data.gpu.usage || 0);
            drawAreaChart("gpu-spark-svg", metrics.gpu, 100);
        }

        // OpenFin Forensic Intel
        var ofinCard = document.getElementById("openfin-card");
        if (ofinCard && data.openfin) {
            if (data.openfin.active) {
                var hTag = document.getElementById("ofin-health-tag");
                if (hTag) {
                    var h = data.openfin.health || 0;
                    hTag.textContent = h + "% HEALTH";
                    hTag.className = h > 80 ? "status-neon-green" : (h > 50 ? "status-warning" : "status-critical");
                    if (h <= 50) hTag.style.color = "var(--accent-red)";
                    else if (h <= 80) hTag.style.color = "#ffcc00";
                    else hTag.style.color = "var(--accent-green)";
                }

                safeSetText("ofin-renderers", data.openfin.renderers || 0);
                safeSetText("ofin-ram", (data.openfin.ram || 0).toLocaleString() + " MB");

                // RVM & Runtime Details
                var rvmBox = document.getElementById("ofin-rvm-details");
                if (rvmBox) {
                    if (data.openfin.rvm && data.openfin.rvm.length > 0) {
                        rvmBox.style.display = "block";
                        var rvmH = "";

                        // RVM Section
                        var rvmVer = data.openfin.rvm[0].version || "Unknown";
                        if (data.openfin.rvm.length > 1) rvmVer = "<span style='color:var(--accent-red)'>MULTIPLE (" + data.openfin.rvm.length + ")</span>";

                        rvmH += `<div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:8px;">
                                    <div style="font-size:0.55rem; opacity:0.5;">RVM VERSION</div>
                                    <div style="font-size:0.8rem; font-weight:700; color:var(--text-main);">${rvmVer}</div>
                                 </div>`;

                        // Runtime Section
                        if (data.openfin.runtimes) {
                            var rtKeys = Object.keys(data.openfin.runtimes);
                            if (rtKeys.length > 0) {
                                rvmH += `<div style="font-size:0.55rem; opacity:0.5; margin-bottom:4px;">ACTIVE RUNTIMES</div>`;
                                for (var k = 0; k < rtKeys.length; k++) {
                                    var ver = rtKeys[k];
                                    var info = data.openfin.runtimes[ver];
                                    var verColor = rtKeys.length > 1 ? "#ffcc00" : "var(--text-main)";
                                    var gpuTxt = info.gpu > 0 ? `<span style="color:var(--accent-blue); font-weight:700;">GPU ${Number(info.gpu).toFixed(0)}%</span>` : `<span style="opacity:0.3;">GPU 0%</span>`;

                                    rvmH += `<div style="font-size:0.65rem; margin-bottom:3px; display:flex; justify-content:space-between; background:var(--bg-card); padding:4px 6px; border-radius:4px;">
                                                    <span style="color:${verColor}; font-weight:600;">${ver}</span>
                                                    <div style="display:flex; gap:8px;">
                                                        <span style="opacity:0.6;">${info.count} PIDs</span>
                                                        ${gpuTxt}
                                                    </div>
                                               </div>`;
                                }
                            }
                        }
                        // Thread Efficiency
                        if (data.openfin.efficiency !== undefined) {
                            var eff = data.openfin.efficiency;
                            var effColor = eff > 90 ? "var(--accent-green)" : (eff < 50 ? "var(--accent-red)" : "#ffcc00");

                            rvmH += `<div style="margin-top:8px; border-top:1px solid var(--border-light); padding-top:6px;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <span style="font-size:0.55rem; opacity:0.5;">THREAD EFFICIENCY</span>
                                    <span style="font-size:0.7rem; font-weight:700; color:${effColor};">${eff}%</span>
                                </div>
                                <div style="font-size:0.5rem; color:var(--text-dim); margin-top:2px;">
                                    Dispersion: ${data.openfin.dispersion || 0} (StdDev)
                                </div>
                            </div>`;

                            if (data.openfin.bottleneck) {
                                rvmH += `<div style="margin-top:4px; font-size:0.55rem; color:var(--accent-red); font-weight:700; background:rgba(255,55,95,0.1); padding:4px; border-radius:4px; text-align:center;">
                                    ⚠️ SINGLE CORE BOTTLENECK DETECTED
                                </div>`;
                            }
                        }
                        rvmBox.innerHTML = rvmH;
                    } else {
                        rvmBox.style.display = "none";
                    }
                }

                var hotBox = document.getElementById("ofin-hot-box");
                if (hotBox) {
                    if (data.openfin.hotPid > 0 && data.openfin.hotCpu > 5) {
                        hotBox.style.display = "block";
                        safeSetText("ofin-hot-id", "PID " + data.openfin.hotPid);
                        safeSetText("ofin-hot-cpu", (data.openfin.hotCpu || 0).toFixed(1) + "%");
                    } else {
                        hotBox.style.display = "none";
                    }
                }

                var flagsH = "";
                var fs = data.openfin.flags || [];
                if (fs.length > 0) {
                    for (var f = 0; f < fs.length; f++) {
                        var fName = fs[f];
                        var fCol = "var(--accent-blue)";
                        var fBg = "rgba(0,210,255,0.1)";
                        if (fName.indexOf("OFF") !== -1 || fName.indexOf("HOT") !== -1 || fName.indexOf("ZOMBIE") !== -1) {
                            fCol = "var(--accent-red)";
                            fBg = "rgba(255,55,95,0.1)";
                        }
                        flagsH += `<div style="font-size:0.5rem; padding:3px 6px; background:${fBg}; border:1px solid ${fCol}; border-radius:4px; color:${fCol}; font-weight:700;">${fName}</div>`;
                    }
                } else if (data.openfin.active) {
                    flagsH = '<div style="font-size:0.5rem; padding:3px 6px; background:var(--border-light); border-radius:4px; color:var(--text-dim);">SECURE_BASELINE</div>';
                }
                document.getElementById("ofin-flags").innerHTML = flagsH;
            } else {
                var hTag = document.getElementById("ofin-health-tag");
                if (hTag) {
                    hTag.textContent = "RUNTIME IDLE";
                    hTag.className = "status-dim";
                    hTag.style.color = "var(--text-dim)";
                }
                safeSetText("ofin-renderers", "--");
                safeSetText("ofin-ram", "-- MB");
                var flagsEl = document.getElementById("ofin-flags");
                if (flagsEl) flagsEl.innerHTML = '<div style="font-size:0.55rem; padding:4px 8px; background:var(--border-light); border-radius:4px; color:var(--text-dim);">OpenFin Not Detected</div>';
            }
        }

        // Citrix ICA/HDX Card Rendering (VDI Only)
        var citrixCard = document.getElementById("citrix-hdx-card");
        if (citrixCard && (data.ica || (data.sys && data.sys.isCitrix))) {
            citrixCard.style.display = "block";

            if (data.ica) {
                var isNetworkMode = data.ica.mode === "Network";

                // Dynamic header labeling
                var cardLabel = citrixCard.querySelector(".card-label-small");
                if (cardLabel) cardLabel.textContent = isNetworkMode ? "Network Stack" : "HDX Protocol";

                // Render bandwidth (common to both modes)
                if (data.ica) {
                    var inBW = Number(data.ica.inputBW);
                    if (isNaN(inBW)) inBW = 0;

                    var outBW = Number(data.ica.outputBW);
                    if (isNaN(outBW)) outBW = 0;

                    safeSetText("ica-bw-in", inBW.toFixed(1));
                    safeSetText("ica-bw-out", outBW.toFixed(1));

                    var transportMode = document.getElementById("hdx-transport-mode");
                    if (transportMode) {
                        transportMode.textContent = isNetworkMode ? (data.ica.transport || "OS-TCP") : (data.ica.transport || "TCP");
                        transportMode.className = (data.ica.transport === "EDT" || isNetworkMode) ? "status-neon-green" : "status-dim";
                        if (isNetworkMode && data.ica.adapter) transportMode.title = "Adapter: " + data.ica.adapter;
                    }
                }

                if (isNetworkMode) {
                    var latEl = document.getElementById("ica-latency-val");
                    if (latEl) latEl.parentElement.style.display = "none";
                    var fpsEl = document.getElementById("ica-fps-val");
                    if (fpsEl) fpsEl.parentElement.style.display = "none";
                    var delayEl = document.getElementById("ica-input-delay");
                    if (delayEl) delayEl.parentElement.style.display = "none";
                } else {
                    var latEl = document.getElementById("ica-latency-val");
                    if (latEl) {
                        latEl.parentElement.style.display = "block";
                        safeSetText("ica-latency-val", (data.ica.latency || 0).toFixed(1) + " ms");
                    }
                    var fpsEl = document.getElementById("ica-fps-val");
                    if (fpsEl) {
                        fpsEl.parentElement.style.display = "block";
                        safeSetText("ica-fps-val", (data.ica.fps || 0).toFixed(1) + " fps");
                    }
                    var delayEl = document.getElementById("ica-input-delay");
                    if (delayEl) {
                        delayEl.parentElement.style.display = "block";
                        safeSetText("ica-input-delay", (data.ica.inputDelay || 0).toFixed(1));
                    }
                }

                // Alert coloring (Only if not N/A)
                if (!isNetworkMode) {
                    var latencyEl = document.getElementById("ica-latency-val");
                    if (latencyEl) {
                        latencyEl.style.opacity = "1";
                        var lat = data.ica.latency || 0;
                        if (lat > 100) latencyEl.style.color = "var(--accent-red)";
                        else if (lat > 50) latencyEl.style.color = "#ffcc00";
                        else latencyEl.style.color = "var(--accent-blue)";
                    }

                    var inputDelayEl = document.getElementById("ica-input-delay");
                    if (inputDelayEl) {
                        var delay = data.ica.inputDelay || 0;
                        if (delay > 50) inputDelayEl.style.color = "var(--accent-red)";
                        else if (delay > 30) inputDelayEl.style.color = "#ffcc00";
                        else inputDelayEl.style.color = "var(--accent-green)";
                    }

                    var fpsEl = document.getElementById("ica-fps-val");
                    if (fpsEl) {
                        fpsEl.style.opacity = "1";
                        var fps = data.ica.fps || 0;
                        if (fps < 20) fpsEl.style.color = "var(--accent-red)";
                        else if (fps < 30) fpsEl.style.color = "#ffcc00";
                        else fpsEl.style.color = "var(--accent-blue)";
                    }
                } else {
                    // Reset colors and dim for network mode (N/A)
                    if (document.getElementById("ica-fps-val")) {
                        var el = document.getElementById("ica-fps-val");
                        el.style.color = "var(--text-dim)";
                        el.style.opacity = "0.4";
                    }
                }

                // Push bandwith to sparklines
                if (data.ica) {
                    var safeIn = Number(data.ica.inputBW);
                    var safeOut = Number(data.ica.outputBW);

                    if (isNaN(safeIn)) safeIn = 0;
                    if (isNaN(safeOut)) safeOut = 0;

                    metrics.netIn.shift(); metrics.netIn.push(safeIn);
                    metrics.netOut.shift(); metrics.netOut.push(safeOut);
                } else {
                    metrics.netIn.shift(); metrics.netIn.push(0);
                    metrics.netOut.shift(); metrics.netOut.push(0);
                }

                if (metrics.netIn && metrics.netOut) {
                    drawNetworkChart(metrics.netIn, metrics.netOut);
                }

                // Adapter Detail
                var adapterEl = document.getElementById("ica-adapter-name");
                if (adapterEl) {
                    if (isNetworkMode && data.ica.adapter) {
                        adapterEl.textContent = data.ica.adapter;
                        adapterEl.style.display = "block";
                    } else if (!isNetworkMode && data.ica.sessionName) {
                        adapterEl.textContent = "ICA Session: " + data.ica.sessionName;
                        adapterEl.style.display = "block";
                    } else {
                        adapterEl.style.display = "none";
                    }
                }

                // Overlay Low Latency network items
                if (data.sys && data.sys.netConfig) {
                    safeSetText("net-link-speed", data.sys.netConfig.speed);
                    safeSetText("net-config-status", data.sys.netConfig.name);
                    safeSetText("net-speed", data.sys.netConfig.speed);
                    safeSetText("net-jumbo", data.sys.netConfig.jumbo);
                    safeSetText("net-intmod", data.sys.netConfig.intmod);
                    safeSetText("net-flow", data.sys.netConfig.flow);

                    if (data.sys.netConfig.rxSmall !== "--" && data.sys.netConfig.rxSmall !== "N/A") {
                        document.getElementById("net-vmxnet-rx1").style.display = "flex";
                        safeSetText("net-rxSmall", data.sys.netConfig.rxSmall);
                    } else {
                        document.getElementById("net-vmxnet-rx1").style.display = "none";
                    }

                    if (data.sys.netConfig.rxLarge !== "--" && data.sys.netConfig.rxLarge !== "N/A") {
                        document.getElementById("net-vmxnet-rx2").style.display = "flex";
                        safeSetText("net-rxLarge", data.sys.netConfig.rxLarge);
                    } else {
                        document.getElementById("net-vmxnet-rx2").style.display = "none";
                    }
                } else {
                    safeSetText("net-link-speed", "--");
                    safeSetText("net-config-status", "--");
                }
            } else if (data.sys && data.sys.isCitrix) {
                // Citrix detected but counters unavailable - show diagnostic
                safeSetText("ica-latency-val", "N/A");
                // Hide metrics that aren't available in Network mode
                var fpsLabel = document.getElementById("ica-fps-val");
                if (fpsLabel) fpsLabel.parentElement.style.display = "none";

                var latLabel = document.getElementById("ica-input-delay");
                if (latLabel) latLabel.parentElement.style.display = "none";

                var latValLabel = document.getElementById("ica-latency-val");
                if (latValLabel) latValLabel.parentElement.style.display = "none";

                safeSetText("ica-bw-in", "--");
                safeSetText("ica-bw-out", "--");

                var transportMode = document.getElementById("hdx-transport-mode");
                if (transportMode) {
                    transportMode.textContent = "DETECTED";
                    transportMode.className = "status-dim";

                    // Add diagnostic tooltip if available
                    if (data.sys.citrixDebug && data.sys.citrixDebug.error) {
                        transportMode.title = "Citrix VDI detected but counters unavailable: " + data.sys.citrixDebug.error;
                    }
                }
            }
        }

        // Physical System Health Card Rendering (Disk/AV/Power)
        var sysCard = document.getElementById("sysview-health-card");
        if (sysCard) {
            sysCard.style.display = "block";

            var d = data.sysview || {};

            if (d.diskC) {
                var used = d.diskC.percUsed || 0;
                safeSetText("sysview-disk-perc", used.toFixed(1) + " %");
                safeSetText("sysview-disk-free", (d.diskC.freeGB || 0) + " GB");

                var pEl = document.getElementById("sysview-disk-perc");
                if (pEl) {
                    if (used > 95) pEl.style.color = "var(--accent-red)";
                    else if (used > 85) pEl.style.color = "#ffcc00";
                    else pEl.style.color = "var(--accent-blue)";
                }
            } else {
                safeSetText("sysview-disk-perc", "-- %");
                safeSetText("sysview-disk-free", "-- GB");
            }

            if (d.av) {
                var avEl = document.getElementById("sysview-av-status");
                safeSetText("sysview-av-status", d.av.active ? "Scan: " + d.av.lastQuick : "DISABLED / NOT FOUND");
                if (avEl) {
                    if (d.av.impact && d.av.impact.indexOf("HIGH") !== -1) {
                        avEl.style.color = "var(--accent-red)";
                    } else if (d.av.active) {
                        avEl.style.color = "var(--text-main)";
                    } else {
                        avEl.style.color = "var(--text-dim)";
                    }
                }
            } else {
                safeSetText("sysview-av-status", "--");
            }

            if (d.power) {
                safeSetText("sysview-power-plan", d.power.plan || "Unknown");
                var pwrEl = document.getElementById("sysview-power-plan");
                if (pwrEl) {
                    if (d.power.isOptimal) pwrEl.style.color = "var(--accent-green)";
                    else pwrEl.style.color = "var(--accent-red)";
                }
            } else {
                safeSetText("sysview-power-plan", "--");
            }

            if (d.dotnet) safeSetText("sysview-dotnet", d.dotnet);

            var sTarg = document.getElementById("sysview-software-target");
            if (sTarg && d.software && d.software.length > 0) {
                if (sTarg.innerHTML.indexOf("Scanning") !== -1) {
                    var sHtml = "";
                    for (var si = 0; si < d.software.length; si++) {
                        var sw = d.software[si];
                        var name = sw.name || "Unknown Update";
                        var rawDate = sw.date ? sw.date.toString() : "";
                        var fmtDate = rawDate.length === 8 ? rawDate.substring(0, 4) + "-" + rawDate.substring(4, 6) + "-" + rawDate.substring(6, 8) : rawDate;
                        sHtml += '<div style="display:flex; justify-content:space-between; background:var(--bg-overlay); padding:4px 6px; border-radius:4px; font-size:0.55rem; align-items:center;">' +
                            '<span style="color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;" title="' + name + '">' + name + '</span>' +
                            '<span style="color:var(--text-dim);">' + fmtDate + '</span></div>';
                    }
                    sTarg.innerHTML = sHtml;
                }
            } else if (sTarg && d.state === "COMPLETE" && (!d.software || d.software.length === 0)) {
                if (sTarg.innerHTML.indexOf("Scanning") !== -1) {
                    sTarg.innerHTML = '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:15px;">No recent changes found.</div>';
                }
            }

            if (d.vramMB !== undefined) {
                var vEl = document.getElementById("gpu-vram-val");
                if (vEl) vEl.textContent = d.vramMB + " MB";
            }

            if (d.citrixCfg) {
                var cTarg = document.getElementById("citrix-config-list");
                if (cTarg && cTarg.innerHTML.indexOf("Scanning") !== -1) {
                    var html = "";
                    if (d.citrixCfg.ddc && d.citrixCfg.ddc.length > 0) {
                        html += '<div style="margin-bottom:8px;">' +
                            '<span style="color:var(--accent-blue); font-weight:800; display:block; margin-bottom:4px;">CLOUD CONNECTORS (DDC)</span>';
                        for (var hi = 0; hi < d.citrixCfg.ddc.length; hi++) {
                            html += '<span style="display:inline-block; background:var(--border-light); padding:2px 4px; margin:2px; border-radius:4px; font-weight:700; color:var(--text-main);">' + d.citrixCfg.ddc[hi] + '</span>';
                        }
                        html += '</div>';
                    }
                    if (d.citrixCfg.policies && d.citrixCfg.policies.length > 0) {
                        html += '<div style="margin-top:5px;"><span style="color:var(--accent-green); font-weight:800; display:block; margin-bottom:4px;">VDA CONFIGURATION Registry Policies</span>';
                        for (var pi = 0; pi < d.citrixCfg.policies.length; pi++) {
                            html += '<div style="display:flex; justify-content:space-between; margin-bottom:4px; padding:2px 4px; background:var(--bg-overlay); border-radius:3px;"><span style="word-break:break-all; max-width:80%;">' + d.citrixCfg.policies[pi].name + '</span><span style="color:var(--text-main); font-weight:700;">' + d.citrixCfg.policies[pi].val + '</span></div>';
                        }
                        html += '</div>';
                    }
                    if (html === "") {
                        html = '<div style="opacity:0.3; text-align:center;">No direct VDA policies found.</div>';
                    }
                    cTarg.innerHTML = html;
                }
            }

            if (d.diskC && d.av && d.power) {
                safeSetText("sysview-status-tag", "ONLINE");
            } else {
                safeSetText("sysview-status-tag", "ANALYZING");
            }
        }

        // User Profile Card Rendering
        if (data.userProfile) {
            var up = data.userProfile;
            var bState = document.getElementById("profile-state-badge");
            if (up.state === "COMPLETE") {
                if (bState) { bState.textContent = "SCANNED"; bState.className = "status-neon-green"; }
                safeSetText("prof-size-val", (up.sizeGB || 0) + " GB");
                safeSetText("prof-files-val", (up.files || 0).toLocaleString());
                safeSetText("prof-large-val", (up.large || 0).toLocaleString());

                var targ = document.getElementById("profile-folders-target");
                if (targ && up.folders && up.folders.length > 0) {
                    var html = "";
                    for (var fi = 0; fi < Math.min(up.folders.length, 50); fi++) {
                        var f = up.folders[fi];
                        html += '<div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-overlay); padding:6px; border-radius:6px; border:1px solid var(--border-light);">' +
                            '<div style="font-weight:700; font-size:0.6rem; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px;" title="' + f.name + '">' + f.name + '</div>' +
                            '<div style="font-size:0.55rem; color:var(--text-dim);"><span style="color:var(--accent-blue); font-weight:700;">' + f.sizeMB + ' MB</span> | ' + f.files + ' files</div>' +
                            '</div>';
                    }
                    targ.innerHTML = html;
                } else if (targ && up.folders && up.folders.length === 0) {
                    targ.innerHTML = '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:20px;">No folders found.</div>';
                }
            } else if (up.state === "ERROR") {
                if (bState) { bState.textContent = "SCAN ERROR"; bState.className = "status-dim"; bState.style.color = "var(--accent-red)"; }
                var errTarg = document.getElementById("profile-folders-target");
                if (errTarg) errTarg.innerHTML = '<div style="color:var(--accent-red); font-size:0.6rem; padding:10px;">Error reading profile: ' + up.error + '</div>';
            } else {
                if (bState) { bState.textContent = "ANALYZING"; bState.className = "status-dim"; }
            }
        }

        // Webhooks Add-on
        if (data.webhooks) {
            safeSetText("wh-throughput", data.webhooks.throughput || 0);
            safeSetText("wh-latency", (data.webhooks.latency || 0) + " ms");
            var lat = data.webhooks.latency || 0;
            var latEl = document.getElementById("wh-latency");
            if (latEl) {
                if (lat > 100) latEl.style.color = "var(--accent-red)";
                else if (lat > 50) latEl.style.color = "#ffcc00";
                else latEl.style.color = "var(--accent-blue)";
            }
            safeSetText("wh-error-rate", (data.webhooks.errorRate || 0).toFixed(1) + "%");
            safeSetText("wh-queue", data.webhooks.queue || 0);
        }

        // DFS Add-on
        if (data.dfs && Array.isArray(data.dfs)) {
            safeSetText("dfs-count", data.dfs.length);
            var dfsHtml = "";
            for (var d_i = 0; d_i < data.dfs.length; d_i++) {
                var d = data.dfs[d_i];
                var latColor = "var(--accent-blue)";
                if (d.latency > 50) latColor = "var(--accent-red)";
                else if (d.latency > 20) latColor = "#ffcc00";
                dfsHtml += `<div style="background:var(--bg-overlay); padding:6px; border-radius:6px; border-left:3px solid ${latColor}; display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <div>
                        <div style="font-size:0.65rem; font-weight:700; color:var(--text-main);">${d.share}</div>
                        <div style="font-size:0.5rem; color:var(--text-dim);">${d.server} (${d.ip})</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:0.65rem; font-weight:700; color:${latColor};">${d.latency} ms</div>
                        <div style="font-size:0.5rem; color:var(--text-dim);">SMB ${d.dialect}</div>
                    </div>
                </div>`;
            }
            var tgt = document.getElementById("dfs-list-target");
            if (tgt) tgt.innerHTML = dfsHtml || '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:20px;">No SMB Connections</div>';
        }

        // Network Low-Latency Stack
        if (data.sys && data.sys.netConfig) {
            safeSetText("net-config-status", "DETECTED");
            document.getElementById("net-config-status").className = "status-neon-green";
            safeSetText("net-jumbo", data.sys.netConfig.jumbo);
            safeSetText("net-intmod", data.sys.netConfig.intmod);
            safeSetText("net-buffers", data.sys.netConfig.buffers);
            safeSetText("net-flow", data.sys.netConfig.flow);
            safeSetText("net-eee", data.sys.netConfig.eee);
            safeSetText("net-speed", data.sys.netConfig.speed);

            // Hypervisor (VMXNET) overlays
            if (data.sys.netConfig.isVmxnet) {
                document.getElementById("net-vmxnet-rx1").style.display = "flex";
                document.getElementById("net-vmxnet-rx2").style.display = "flex";
                safeSetText("net-rxSmall", data.sys.netConfig.rxSmall);
                safeSetText("net-rxLarge", data.sys.netConfig.rxLarge);
            } else {
                document.getElementById("net-vmxnet-rx1").style.display = "none";
                document.getElementById("net-vmxnet-rx2").style.display = "none";
            }
        } else {
            safeSetText("net-config-status", "UNAVAILABLE");
            var el = document.getElementById("net-config-status");
            if (el) el.className = "status-dim";
        }

        // M365 Add-on
        if (data.m365 && data.m365.apps) {
            var tgt = document.getElementById("m365-apps-target");
            if (tgt) {
                var h = "";
                for (var i = 0; i < data.m365.apps.length; i++) {
                    var appNode = data.m365.apps[i];
                    var clr = appNode.color || "var(--accent-blue)";

                    var versionDisplay = appNode.version && appNode.version !== "Unknown" ? ` | <span style="color:var(--text-dim);">v${appNode.version}</span>` : "";

                    let explicitAddinsList = "";
                    if (appNode.addinList) {
                        let listItems = appNode.addinList.split(',').map(s => s.trim());
                        if (listItems.length > 0 && listItems[0] !== "") {
                            explicitAddinsList = `<div style="margin-top:5px; font-size:0.5rem; color:var(--text-dim); background: rgba(var(--bg-rgb),0.2); border-radius:4px; padding:4px;">
                                 <div style="font-weight:700; margin-bottom:2px; color:var(--text-main);">Loaded Add-ins:</div>
                                 <div style="white-space:normal; overflow-wrap:anywhere;">${listItems.join('<br>')}</div>
                             </div>`;
                        }
                    }

                    var subtitle = "";
                    if (appNode.name === "Outlook") {
                        subtitle = `<span>${appNode.addins} Add-ins</span> | <span>${appNode.ostSize || 0} GB OST</span>${versionDisplay}
                                    <div style="font-size:0.5rem; margin-top:3px;">
                                        <span style="color:var(--text-dim);">${appNode.mode} Mode</span> |
                                        <span style="color:${appNode.status === 'Connected' ? 'var(--accent-green)' : 'var(--accent-red)'}; font-weight:bold;">${appNode.status}</span>
                                    </div>
                                    ${explicitAddinsList}`;
                    } else if (appNode.name === "Teams") {
                        subtitle = `<span>Collaboration Platform</span>${versionDisplay}
                                    <div style="font-size:0.5rem; margin-top:3px;">
                                        <span style="color:var(--text-dim);">Optimization:</span> 
                                        <span style="color:${appNode.optStatus === 'Optimized (HDX)' || appNode.optStatus === 'Optimized' ? 'var(--accent-green)' : 'var(--accent-red)'}; font-weight:bold;">${appNode.optStatus || 'Unknown'}</span>
                                    </div>`;
                    } else {
                        subtitle = `<span>${appNode.addins} Add-ins</span>${versionDisplay}
                                    ${explicitAddinsList}`;
                    }

                    h += `<div style="background:var(--bg-overlay); padding:6px; border-radius:6px; border:1px solid var(--border-light); display:flex; justify-content:space-between; align-items:flex-start;">
                            <div>
                                <div style="font-size:0.65rem; font-weight:700; color:${clr};">${appNode.name}</div>
                                <div style="font-size:0.5rem; color:var(--text-dim);">${subtitle}</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:0.65rem; color:var(--text-main);" title="Memory, CPU"><span style="color:var(--accent-green);">${Math.round(appNode.ram)} MB</span> | <span style="color:var(--accent-blue);">${Number(appNode.cpu).toFixed(1)}%</span></div>
                                <div style="font-size:0.5rem; color:var(--text-dim);">${appNode.handles} Handles</div>
                            </div>
                        </div>`;
                }
                tgt.innerHTML = h;
            }
        }

        // 3. Card-Level Consumers (Top 3)
        if (data.procs && Array.isArray(data.procs)) {
            var pList = data.procs;

            // CPU Top 3
            var cpuSorted = [].concat(pList).sort((a, b) => (Number(b.cpu) || 0) - (Number(a.cpu) || 0));
            var cpuH = "";
            for (var i = 0; i < Math.min(3, cpuSorted.length); i++) {
                var cVal = Number(cpuSorted[i].cpu || 0).toFixed(1);
                var pName = cpuSorted[i].name || 'Unknown';
                cpuH += `<div class="mini-consumer-item"><span>${pName}</span><span style="color:var(--accent-blue)">${cVal}%</span></div>`;
            }
            var cpuEl = document.getElementById("cpu-top-3");
            if (cpuEl) cpuEl.innerHTML = cpuH;

            // RAM Top 3
            var ramSorted = [].concat(pList).sort((a, b) => (Number(b.ram) || 0) - (Number(a.ram) || 0));
            var ramH = "";
            for (var j = 0; j < Math.min(3, ramSorted.length); j++) {
                var rVal = Number(ramSorted[j].ram || 0).toFixed(0);
                var pName = ramSorted[j].name || 'Unknown';
                ramH += `<div class="mini-consumer-item"><span>${pName}</span><span style="color:var(--accent-green)">${rVal} MB</span></div>`;
            }
            var memEl = document.getElementById("mem-top-3");
            if (memEl) memEl.innerHTML = ramH;

            // GPU Top 3
            var gpuSorted = [].concat(pList).sort((a, b) => (Number(b.gpu) || 0) - (Number(a.gpu) || 0));
            var gpuH = "";
            for (var k = 0; k < Math.min(3, gpuSorted.length); k++) {
                var gVal = Number(gpuSorted[k].gpu || 0).toFixed(1);
                var pName = gpuSorted[k].name || 'Unknown';
                if (gVal == "0.0" && isSimOn) gVal = (Math.random() * 5).toFixed(1);
                gpuH += `<div class="mini-consumer-item"><span>${pName}</span><span style="color:var(--accent-blue)">${gVal}%</span></div>`;
            }
            var gpuEl = document.getElementById("gpu-top-3");
            if (gpuEl) gpuEl.innerHTML = gpuH; // CRITICAL: This was missing in HTML, causing crash

            // Main Side Pane Rank
            var html = "";
            for (var i = 0; i < Math.min(pList.length, 5); i++) {
                var p = pList[i];
                if (!p) continue; // Skip null entries
                var pCpu = Number(p.cpu || 0);
                var pRam = Number(p.ram || 0);
                var pName = p.name || 'Unknown';
                var pPid = p.pid || '?';

                html += `<div class="proc-card-row">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="font-weight:700; font-size:0.75rem;">${pName} <span style="opacity:0.3; font-size:0.6rem;">PID ${pPid}</span></div>
                        <div style="font-weight:800; color:var(--accent-blue);">${pCpu.toFixed(1)}%</div>
                    </div>
                    <div class="bar-bg-stripe"><div class="bar-fill-stripe" style="width:${Math.min(pCpu, 100)}%;"></div></div>
                    <div style="display:flex; justify-content:space-between; font-size:0.55rem; opacity:0.5; margin-top:5px;">
                        <span>${p.th || 0} THREADS</span>
                        <span>${pRam.toFixed(0)} MB</span>
                    </div>
                </div>`;
            }
            document.getElementById("process-grid-target").innerHTML = html;
        } else {
            // Explicit error if procs missing
            document.getElementById("process-grid-target").innerHTML = '<div style="color:red; padding:10px; font-weight:bold;">NO PROCESS DATA RECEIVED</div>';
        }

        // 3. Side Panel (Thread-Level Saturation - Hardened Sync)
        // 3. Thread / Threads Saturation (Hardened Sync)
        var threadTarget = document.getElementById("thread-grid-target");
        if (threadTarget && data.procs) {

            var tHtml = "";
            // Sort by Thread count descending
            var sortedThreads = [].concat(data.procs).sort((a, b) => (b.th || 0) - (a.th || 0));

            for (var i = 0; i < Math.min(6, sortedThreads.length); i++) {
                var t = sortedThreads[i];
                var tKey = t.pid.toString();
                var prevTh = lastThreadCounts[tKey] || t.th;

                var thDelta = t.th - prevTh;
                var deltaIndicator = "";
                if (thDelta > 0) {
                    deltaIndicator = `<span style="color:var(--accent-red); margin-left:8px; font-size:0.6rem;" title="Thread Count Increased">▲ ${thDelta}</span>`;
                } else if (thDelta < 0) {
                    deltaIndicator = `<span style="color:var(--accent-green); margin-left:8px; font-size:0.6rem;" title="Thread Count Decreased">▼ ${Math.abs(thDelta)}</span>`;
                } else {
                    deltaIndicator = `<span style="color:var(--text-dim); margin-left:8px; font-size:0.6rem;" title="Thread Count Stable">-</span>`;
                }

                var thColor = "var(--accent-green)";
                if (t.th > 100) thColor = "var(--accent-red)";
                else if (t.th > 40) thColor = "#ffcc00"; // Yellow

                tHtml += `<div class="proc-card-row">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-weight:700;">
                        <span>${t.name}</span>
                        <div style="display:flex; align-items:center;"><span style="color:${thColor}; font-size:1.1rem;">${t.th}</span>${deltaIndicator}</div>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:0.55rem; opacity:0.5; margin-top:2px;">
                        <span>PID ${t.pid} | CPU: ${t.cpu}%</span>
                        <span>THREADS</span>
                    </div>
                    <div style="text-align:right; margin-top:6px;">
                        <button class="kill-btn-mini" onclick="confirmPurge(${t.pid}, '${t.name.replace(/'/g, "\\'")}')" style="width:auto; padding:4px 12px; font-size:0.55rem; letter-spacing:1px; background:rgba(255,55,95,0.15); border:1px solid var(--accent-red); color:var(--accent-red); border-radius:4px; font-weight:700;">TERMINATE</button>
                    </div>
                </div>`;
            }
            threadTarget.innerHTML = tHtml;

            // GC Update for historic thread count logic
            var newThreadCounts = {};
            for (var p = 0; p < data.procs.length; p++) {
                if (data.procs[p] && data.procs[p].pid) {
                    newThreadCounts[data.procs[p].pid.toString()] = data.procs[p].th || 0;
                }
            }
            lastThreadCounts = newThreadCounts;
        }

        // C. Zombies (Simulated or Real)
        var zombieTarget = document.getElementById("zombie-monitor-sidebar");
        if (zombieTarget) {
            if (data.risk && data.risk.zombies > 0) {
                var zHtml = "";
                for (var z = 0; z < data.risk.zombieList.length; z++) {
                    var zm = data.risk.zombieList[z];
                    zHtml += `<div style="padding:10px; background:rgba(255,55,95,0.1); border-left:3px solid var(--accent-red); margin-bottom:5px;">
                        <div style="font-weight:700; color:var(--accent-red);">${zm.name}</div>
                        <div style="font-size:0.6rem; opacity:0.7;">PID ${zm.pid} | ${zm.ram} MB LEAK</div>
                     </div>`;
                }
                zombieTarget.innerHTML = zHtml;
            } else {
                zombieTarget.innerHTML = '<div style="opacity:0.3; padding:10px;">NONE FOUND</div>';
            }
        }

        // D. Event Logs (Inline Detail - No Popup Required)
        var evtTarget = document.getElementById("event-log-target");
        if (evtTarget && data.events) {
            var eHtml = "";
            if (data.events.length > 0) {
                for (var e = 0; e < Math.min(4, data.events.length); e++) {
                    var ev = data.events[e];
                    var color = ev.type === "critical" ? "var(--accent-red)" : "#ffcc00";

                    eHtml += `<div class="event-item" style="background:var(--bg-card); padding:8px; border-radius:6px; border-left:3px solid ${color}; margin-bottom:10px;">
                        <div style="display:flex; justify-content:space-between; font-size:0.55rem; opacity:0.6; margin-bottom:4px;">
                            <span>${ev.time}</span>
                            <span style="letter-spacing:1px;">ID ${ev.id}</span>
                        </div>
                        <div style="font-size:0.65rem; font-weight:700; color:var(--text-main); margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ev.src}</div>
                        <div style="font-size:0.6rem; color:rgba(var(--text-rgb),0.5); line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${ev.msg}</div>
                    </div>`;
                }
            } else {
                eHtml = '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding:20px;">NO RECENT CRITICAL EVENTS</div>';
            }
            if (evtTarget.innerHTML !== eHtml) evtTarget.innerHTML = eHtml;
        }

        // 4. Forensics View Rendering
        var detailRisk = document.getElementById("risk-factors-detailed");
        if (detailRisk && data.risk) {
            var factors = [];
            if (data.risk.score >= 12) factors.push("<span style='color:var(--accent-red)'>[CRITICAL] SYSTEM INSTABILITY HAZARD</span>");
            else if (data.risk.score >= 8) factors.push("<span style='color:var(--accent-red)'>[HIGH] SCHEDULING DISRUPTION DETECTED</span>");
            else if (data.risk.score >= 4) factors.push("<span style='color:#ffaa00'>[MODERATE] ELEVATED RESOURCE CONTENTION</span>");

            if (data.disk && data.disk.lat > 50) factors.push("<span style='color:#ffaa00'>[IO] LATENCY THRESHOLD BREACH (" + data.disk.lat + "ms)</span>");
            if (data.risk.zombies > 0) factors.push("<span style='color:var(--accent-red)'>[ZOMBIE] ORPHANED KERNEL OBJECTS DETECTED (" + data.risk.zombies + ")</span>");
            if (data.cpu && data.cpu.queue > 5) factors.push("<span style='color:#ffaa00'>[Affinity] CPU READY QUEUE DELAY</span>");
            if (data.cpu && data.cpu.ctx > 120000) factors.push("<span style='color:#ffaa00'>[Kernel] HIGH CONTEXT SWITCH VOLUME</span>");

            detailRisk.innerHTML = factors.length > 0 ? factors.join("<br>") : "<span style='color:var(--accent-green)'>[SAFE] DETERMINISTIC BASELINE VALIDATED</span>";
        }

        var zTarget = document.getElementById("zombie-list-target");
        var zSidebar = document.getElementById("zombie-monitor-sidebar");
        if (data.risk && data.risk.zombieList) {
            if (data.risk.zombies > 0) {
                var zHtml = "";
                var zsHtml = "";
                for (var z = 0; z < data.risk.zombieList.length; z++) {
                    var zp = data.risk.zombieList[z];
                    var row = `<div style="display:flex; justify-content:space-between; padding:8px; background:rgba(255,55,95,0.05); border-radius:8px; margin-bottom:10px; border:1px solid rgba(255,55,95,0.1);">
                        <div style="font-weight:700; color:var(--accent-red);">${zp.name || 'Unknown'}</div>
                        <div style="opacity:0.6;">PID: ${zp.pid}</div>
                        <button class="terminate-btn" onclick="confirmPurge(${zp.pid}, '${(zp.name || '').replace(/'/g, "\\'")}')">PURGE</button>
                    </div>`;
                    zHtml += row;
                    zsHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; border-bottom:1px solid var(--bg-card); padding-bottom:5px;">
                        <div>
                            <div style="color:var(--accent-red); font-weight:700; font-size:0.7rem;">${zp.name || 'Unknown'}</div>
                            <div style="opacity:0.5; font-size:0.6rem;">PID ${zp.pid}</div>
                        </div>
                        <button onclick="confirmPurge(${zp.pid}, '${(zp.name || '').replace(/'/g, "\\'")}')" 
                                style="background:rgba(255,55,95,0.2); border:1px solid var(--accent-red); color:var(--accent-red); font-size:0.55rem; padding:2px 6px; cursor:pointer; border-radius:4px;">
                            PURGE
                        </button>
                    </div>`;
                }
                if (zTarget) zTarget.innerHTML = zHtml;
                if (zSidebar) zSidebar.innerHTML = zsHtml;
            } else {
                if (zTarget) zTarget.innerHTML = '<p style="text-align:center; color:#444; padding-top:40px;">No zombie processes detected.</p>';
                if (zSidebar) zSidebar.innerHTML = 'NONE FOUND';
            }
        }

        var fGrid = document.getElementById("forensic-thread-grid");
        if (fGrid && data.threads) {
            var fgHtml = "";
            for (var ft = 0; ft < Math.min(data.threads.length, 10); ft++) {
                var th = data.threads[ft];
                fgHtml += `<div style="background:var(--bg-overlay); padding:12px; border-radius:12px; border:1px solid var(--border-light);">
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="font-weight:800; font-size:0.75rem;">${th.name}</span>
                        <span style="color:var(--accent-blue); font-weight:800;">${th.cpu}%</span>
                    </div>
                    <div style="font-size:0.6rem; opacity:0.5;">THREADS: ${th.th} | PID: ${th.pid}</div>
                </div>`;
            }
            fGrid.innerHTML = fgHtml;
        }

    } catch (e) {
        // SES Safe: No console.error
        var errBox = document.getElementById("process-grid-target");
        if (errBox) errBox.innerHTML = '<div style="color:var(--accent-red); background:rgba(255,0,0,0.1); padding:10px;">RENDERING ERROR: ' + e.message + '</div>';
    }
}

function confirmPurge(pid, name) {
    pendingPurgePid = pid;
    var modal = document.getElementById("purge-modal");
    if (modal) {
        document.getElementById("purge-target-name").textContent = name;
        document.getElementById("purge-target-pid").textContent = "PID " + pid;
        modal.style.display = "flex";
    }
}

function closePurgeModal() {
    var modal = document.getElementById("purge-modal");
    if (modal) modal.style.display = "none";
    pendingPurgePid = null;
}

function executePurge() {
    if (!pendingPurgePid) return;
    var pid = pendingPurgePid;
    closePurgeModal();

    fetch("/api/terminate?pid=" + pid)
        .then(r => r.text())
        .then(txt => {
            // Log result to event log UI area for visibility
            var evtTarget = document.getElementById("event-log-target");
            if (evtTarget) {
                var color = txt === "OK" ? "var(--accent-blue)" : "var(--accent-red)";
                var msg = txt === "OK" ? "TERMINATION COMMAND SENT FOR PID " + pid : "PURGE FAILED: " + txt;

                // UX: Explicit Alert for Blocked Actions
                if (txt.indexOf("BLOCKED") !== -1) {
                    alert("⛔ SYSTEM SAFETY TRIGGER\n\n" + txt + "\n\nThis process is protected to prevent system instability.");
                }

                evtTarget.insertAdjacentHTML('afterbegin', `<div class="event-item" style="background:var(--bg-card); padding:8px; border-radius:6px; border-left:3px solid ${color}; margin-bottom:10px; animation: pulse-blue 1s;">
                    <div style="font-size:0.65rem; font-weight:700; color:var(--text-main);">SYSTEM COMMAND</div>
                    <div style="font-size:0.6rem; color:rgba(var(--text-rgb),0.7);">${msg}</div>
                </div>`);
            }
        });
}

async function generateReport() {
    var btn = document.getElementById("report-btn");
    if (btn) {
        btn.textContent = "SAVING...";
        btn.style.borderColor = "#ffcc00";
        btn.style.color = "#ffcc00";
    }

    try {
        const response = await fetch("/api/save-report");
        const txt = await response.text();

        if (txt.indexOf("SAVED") !== -1) {
            if (btn) {
                btn.textContent = "REPORT SAVED";
                btn.style.borderColor = "var(--accent-green)";
                btn.style.color = "var(--accent-green)";

                // Detailed path logging in event log area
                var evtTarget = document.getElementById("event-log-target");
                if (evtTarget) {
                    evtTarget.insertAdjacentHTML('afterbegin', `<div class="event-item" style="background:rgba(48,209,88,0.1); padding:8px; border-radius:6px; border-left:3px solid var(--accent-green); margin-bottom:10px;">
                        <div style="font-size:0.65rem; font-weight:700; color:var(--text-main);">SYSTEM REPORT GENERATED</div>
                        <div style="font-size:0.6rem; color:rgba(var(--text-rgb),0.7);">${txt}</div>
                    </div>`);
                }

                setTimeout(() => {
                    btn.textContent = "GENERATE FORENSIC REPORT";
                    btn.style.borderColor = "var(--accent-blue)";
                    btn.style.color = "var(--accent-blue)";
                }, 3000);
            }
        } else {
            if (btn) {
                btn.textContent = "NO DATA TO SAVE";
                btn.style.borderColor = "var(--accent-red)";
                btn.style.color = "var(--accent-red)";
                setTimeout(() => {
                    btn.textContent = "GENERATE FORENSIC REPORT";
                    btn.style.borderColor = "var(--accent-blue)";
                    btn.style.color = "var(--accent-blue)";
                }, 3000);
            }
        }
    } catch (e) {
        if (btn) btn.textContent = "ERROR";
    }
}


async function handleReportFile(input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    var reader = new FileReader();
    reader.onload = async function (e) {
        try {
            // Validate JSON before passing to next window
            JSON.parse(e.target.result);
            await window.reportStorage.saveReport(e.target.result);
            window.open('report.html', '_blank', 'width=1200,height=800');
        } catch (err) {
            alert("Failed to parse report: " + err.message);
        }
    };
    reader.readAsText(file);
    input.value = "";
}



async function quitApp() {
    try {
        await fetch("/api/quit");
        window.close();
    } catch (e) {
        document.body.innerHTML = "<div style='padding:50px; text-align:center;'><h1>ENGINE DISCONNECTED</h1><p>The backend process has exited.</p></div>";
    }
}

function switchView(id) {
    var vs = document.getElementsByClassName("view-page-container");
    for (var i = 0; i < vs.length; i++) vs[i].style.display = "none";
    document.getElementById(id).style.display = "block";
    var ns = document.getElementsByClassName("nav-stripe-item");
    for (var j = 0; j < ns.length; j++) ns[j].classList.remove("item-active");
    var map = { 'view-dash': 'nav-dash', 'view-forensics': 'nav-dash' }; // map forensics back to dash for now or add its own nav
    var b = document.getElementById(map[id]);
    if (b) b.classList.add("item-active");
}

const definitions = {
    cpu: {
        title: "PROCESSOR & LATENCY DYNAMICS",
        text: "Low-latency trading requires deterministic thread scheduling. We monitor Interrupts/sec and DPC (Deferred Procedure Call) time to identify driver-level micro-stutters. High System Calls/sec indicates OS overhead that can cause 'slippage' in high-frequency order execution."
    },
    mem: {
        title: "MEMORY PRESSURE & PAGING",
        text: "Traders require rapid access to the entire working set. We monitor Commit Charge percentage and Page Faults/sec. Persistent page faulting indicates disk-swapping, which introduces millisecond-level latencies unacceptable for visual ticker fidelity."
    },
    disk: {
        title: "STORAGE I/O DETERMINISM",
        text: "Logs and trace capturing must not block the main processing thread. We monitor Queue Depth and IOPS. A queue depth > 1 indicates storage saturation, which can backpressure the entire telemetry engine and delay real-time alerts."
    },
    gpu: {
        title: "GRAPHICS ENGINE JITTER",
        text: "Jitter measures the delta between backend polling and frontend rendering. Professional desktops target < 16ms (60FPS). High jitter (>100ms) indicates scheduling saturation or thermal throttling, leading to 'stale' visual representation of market data."
    },
    health: {
        title: "TRADER HEALTH SCORE CALCULATION",
        text: "The score represents the real-time 'deterministic stability' of the system. It starts at 100 and is reduced based on: (1) Core CPU load (1 point per 4% load), (2) Memory Pressure (25-point penalty if RAM > 85%), (3) Forensic Hazard Markers (20-point penalty for zombie processes, high kernel latency, or SMP synchronization delays). Range: 100-80 (Optimal), 79-60 (Moderate Contention), <60 (Critical Instability)."
    },
    zombie: {
        title: "ZOMBIE PROCESS SURVEILLANCE",
        text: "Zombie processes are 'dead' child processes that have completed execution but still have an entry in the process table (pid) because the parent process has not read the child's exit status. Accumulation of zombies indicates a resource leak in the parent application and can lead to PID starvation, eventually stabilizing the OS scheduler."
    },
    webhook: {
        title: "WEBHOOK OBSERVABILITY",
        text: "Synchronous webhook delivery within desktop applications creates execution bottlenecks. If the main application thread pauses to process incoming API events (like order updates or stream signals), UI responsiveness degrades. We monitor Queue Depth and generic throughput to assure API limits aren't causing backpressure latency."
    },
    dfs: {
        title: "DFS / SMB SHARE LATENCY",
        text: "Storage mapped to wide-area Distributed File Systems (DFS) fluctuates in latency based on backend node performance and network routing. Sluggish SMB responses will hard-lock Windows Explorer threads and delay application file-reads. We actively monitor the ping distance and dialect of these active SMB endpoints."
    },
    m365: {
        title: "M365 DESKTOP FORENSICS & ADD-INS",
        text: "Bloated Outlook Offline Storage Tables (OST) >10GB and excessive COM Add-ins are primary performance killers in trading environments. They monopolize kernel handles and cause thread contention during background synchronization.<br><br><span style='color:var(--accent-blue); font-weight:700;'>DYNAMIC TELEMETRY</span><br>This module actively scans and tracks processes for Microsoft Outlook, Excel, Word, PowerPoint, and Teams. Hover your mouse over the <span style='color:var(--text-main); font-weight:700;'>Add-ins</span> count for any active application to view a tooltip revealing the exact names of the loaded COM add-ins causing potential instability.<br><br>To avoid generating additional disk I/O, the local Outlook OST file size is calculated once on startup and persistently cached."
    },
    citrix: {
        title: "HDX PROTOCOL & VDI LATENCY",
        text: "In Virtual Desktop Infrastructure (VDI) environments, generic OS metrics do not show true user experience. This card polls Citrix ICA/HDX protocol APIs to measure true round trip latency and protocol Frames Per Second (FPS). High protocol latency results in perceived input lag and 'stale' application paints for remote users."
    },
    openfin: {
        title: "OPENFIN RUNTIME STABILITY",
        text: "Financial desktop applications increasingly rely on Chromium-based containers like OpenFin. We monitor individual Renderer threads and the core Runtime Process to detect 'Hot Renderers' (single PIDs pinning CPU cores). High dispersion across cores causes single-thread bottlenecks, restricting complex grid updates."
    },
    sysview: {
        title: "PHYSICAL HEALTH & ENDPOINT FORENSICS",
        text: "Measures core environmental limits governing the physical workstation. Active AV scans and Background Defender sweeps introduce massive disk/CPU overhead impacting deterministic execution. Additionally, power plans such as 'Balanced' introduce core parking & DPC latency; an Ultra-High Performance power plan is required for low-latency trading."
    },
    cpuTop: {
        title: "PROCESS RESOURCE SURVEILLANCE",
        text: "Identifies the highest consuming application processes on the local machine. Rapidly oscillating loads indicate unstable background services stealing priority cycles from low-latency financial tasks. Identifying these rogue processes is the first step in restoring determinism."
    },
    threadSat: {
        title: "THREAD LEAKAGE & SATURATION",
        text: "Monitors deep OS-level thread counts spawned by specific applications. Multi-threaded software with unclosed run-loops will steadily leak active thread objects. An escalating thread count eventually hits Windows scheduler limits, causing the entire desktop to micro-stutter.<br><br><span style='color:var(--accent-blue); font-weight:700;'>TRAFFIC LIGHT SCORING</span><br><span style='color:var(--accent-green)'>■ 0 - 40 (Optimal)</span><br><span style='color:#ffcc00'>■ 41 - 100 (Elevated)</span><br><span style='color:var(--accent-red)'>■ > 100 (Hazardous)</span>"
    },
    eventLog: {
        title: "SYSTEM AUDIT DIAGNOSTICS",
        text: "Monitors the localized Windows Event Viewer streams for transient Critical and Error states that don't trigger direct OS bluescreens but degrade subsystem performance quietly (such as driver failovers, network adapter resets, or disk timeouts)."
    },
    sysChanges: {
        title: "CONFIGURATION DRIFT TRACKING",
        text: "Tracks historical environmental changes. Installing new applications, Windows Updates, or applying registry modifications introduces variables that could break heavily tuned deterministic parameters. Knowing recent changes accelerates root cause analysis when synthetic baselines fail."
    },
    userProfile: {
        title: "USER PROFILE FOOTPRINT",
        text: "Identifies the capacity footprint and file complexity within the active user session. Highly bloated user profiles (specifically in roaming/virtual environments) incur significant disk overhead when the Operating System handles profile synchronization sweeps or index searching over vast file structures."
    },
    risk: {
        title: "FORENSIC HAZARD CALCULATION",
        text: "Synthesizes low-level metrics crossing CPU queue lines, context switching volume, latency spikes, and zombie process accumulations into singular human-readable hazard statements. Determines if the core OS scheduling layer is actively compromised."
    },
    trace: {
        title: "THREAD DISPATCHER DEEP-TRACE",
        text: "A direct view into isolated kernel threads executing per PID context. Tracking explicit CPU load down to the application's children threads gives granular visibility into exactly which module is deadlocking user interfaces."
    },
    netStack: {
        title: "VMWARE VMXNET3 & NIC TUNING",
        text: "Physical Network Interface Controllers (NICs) batch TCP payloads via 'Interrupt Moderation' & 'Jumbo Frames' to save CPU cycles. However, this caching induces microscopic rendering delays for real-time UDP multicast packets critical to sub-millisecond market data ingestion.<br><br><span style='color:var(--accent-blue); font-weight:700;'>VMWARE INTEGRATION</span><br>When running within a Virtual Desktop Infrastructure (VDI), the hypervisor manages these flows via the **VMXNET3 virtual adapter**. If this adapter is detected, we expose its **Rx Ring 1 (Small Buffers)** and **Rx Ring 2 (Large Buffers)** queue sizes. Untuned VMXNET3 Rx Rings are known to silently drop high-frequency UDP stock ticks when the virtual buffer instantaneously overflows."
    }
};

function showDef(type) {
    const def = definitions[type];
    if (!def) return;
    document.getElementById("modal-title").textContent = def.title;
    document.getElementById("modal-body").innerHTML = def.text;
    document.getElementById("info-modal").style.display = "block";
}

function showEvent(id, src, msg) {
    document.getElementById("ev-pop-title").textContent = "EVENT " + id + ": " + src;
    document.getElementById("ev-pop-body").textContent = msg;
    document.getElementById("event-popup").style.display = "block";
}

function toggleSimulation() {
    var target = document.getElementById("process-grid-target");
    if (target) target.innerHTML = '<div style="color:var(--accent-red); padding:10px;">SIMULATION CONTROLS REMOVED FOR VDI OPTIMIZATION</div>';
}

async function loop() {
    if (activeReq) return;
    activeReq = true;
    try {
        var now = Date.now();
        var interval = now - lastFrameTime;
        lastFrameTime = now;

        // Jitter is variance from the 1000ms polling expectation
        jLog.push(Math.abs(interval - 1000));
        if (jLog.length > 5) jLog.shift();
        var sum = 0; for (var j = 0; j < jLog.length; j++) sum += jLog[j];
        var jScore = Math.round(sum / jLog.length);

        var jitterVal = document.getElementById("gpu-jitter-val") || document.getElementById("render-jitter-val");
        if (jitterVal) jitterVal.textContent = jScore + " MS";

        // Fetch Data relative to current host
        const response = await fetch('/api/stats');
        const data = await response.json();

        // Inject frontend-calculated jitter
        data.jitterInfo = jScore + "ms";

        updateFrame(data);
    } catch (e) { } finally { activeReq = false; }
}

function fetchSystemChanges() {
    fetch('/api/changes')
        .then(res => res.json())
        .then(data => {
            if (!Array.isArray(data)) {
                if (data && typeof data === 'object' && data.Date) data = [data]; // Single object
                else data = [];
            }
            if (data.length > 0 && data[0].Date === null) {
                data = []; // Prevents rendering an empty row if PowerShell returns a nullized array via Select-Object
            }
            var target = document.getElementById("system-changes-target");
            var badge = document.getElementById("changes-count-badge");
            if (target && badge) {
                badge.textContent = data.length + " UPDATES";
                badge.className = data.length > 0 ? "status-neon-green" : "status-dim";
                if (data.length === 0) {
                    target.innerHTML = '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:40px;">No recorded application crashes, hangs, or configuration drift detected within the last 5 days.</div>';
                    return;
                }
                var html = "";
                for (var i = 0; i < data.length; i++) {
                    var c = data[i];
                    var col = "var(--accent-blue)";
                    var icon = "📦";
                    if (c.Type === "Windows Update") { col = "var(--accent-green)"; icon = "🔄"; }
                    else if (c.Type === "BIOS Update") { col = "var(--accent-red)"; icon = "💻"; }

                    html += `<div style="background:var(--bg-card); padding:10px; border-radius:8px; border-left:3px solid ${col};">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span style="font-size:0.65rem; color:${col}; font-weight:800;">${icon} ${c.Type}</span>
                            <span style="font-size:0.6rem; opacity:0.6; font-family:monospace;">${c.Date}</span>
                        </div>
                        <div style="font-size:0.75rem; color:var(--text-main); word-break:break-word;">${c.Name}</div>
                    </div>`;
                }
                target.innerHTML = html;
            }
        }).catch(err => console.log(err));
}

async function start() {
    initStaticSlots();
    fetchSystemChanges();
    setInterval(fetchSystemChanges, 300000); // refresh every 5 min
    setInterval(loop, 1000);
    setInterval(tickUptime, 1000);
    loop();
}

function toggleTheme() {
    var isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('tradersynth-theme', isLight ? 'light' : 'dark');
}

// Initialize theme on load
if (localStorage.getItem('tradersynth-theme') === 'light') {
    document.body.classList.add('light-theme');
}

start();
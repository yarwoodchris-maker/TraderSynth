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
    localUptimeSeconds++;
    safeSetText("uptime-display", formatSeconds(localUptimeSeconds));
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
        ultraTickerCtx.fillStyle = "#fff";
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
    var w = 300, h = 100, l = data.length, pts = "";
    for (var i = 0; i < l; i++) {
        var x = (i / (l - 1)) * w;
        var y = h - (Math.min(data[i], max) / max) * 85 - 10; // Vertical padding for axes labels
        pts += (i === 0 ? "M " : " L ") + x + " " + y;
    }
    var line = svg.querySelector(".spark-path"), fill = svg.querySelector(".spark-fill");
    if (line) line.setAttribute("d", pts);
    if (fill) fill.setAttribute("d", pts + " L " + w + " " + h + " L 0 " + h + " Z");
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

    var ptsIn = "", ptsOut = "";
    for (var j = 0; j < l; j++) {
        var x = (j / (l - 1)) * w;
        var yIn = h - (Math.min(inData[j], maxVal) / maxVal) * 90 - 5;
        var yOut = h - (Math.min(outData[j], maxVal) / maxVal) * 90 - 5;
        ptsIn += (j === 0 ? "M " : " L ") + x + " " + yIn;
        ptsOut += (j === 0 ? "M " : " L ") + x + " " + yOut;
    }

    var pIn = document.getElementById("net-in-path");
    var pOut = document.getElementById("net-out-path");
    if (pIn) pIn.setAttribute("d", ptsIn);
    if (pOut) pOut.setAttribute("d", ptsOut);
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

        var border = "1px solid rgba(255,255,255,0.05)";
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

function updateFrame(data) {
    if (!data) return;
    if (data.sys) {
        safeSetText("profile-os", data.sys.os);
        safeSetText("profile-cpu", data.sys.cpu);
        safeSetText("profile-ram", data.sys.ram);
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
                    dots[i].style.background = "rgba(255,255,255,0.1)";
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
                                    <div style="font-size:0.8rem; font-weight:700; color:#fff;">${rvmVer}</div>
                                 </div>`;

                        // Runtime Section
                        if (data.openfin.runtimes) {
                            var rtKeys = Object.keys(data.openfin.runtimes);
                            if (rtKeys.length > 0) {
                                rvmH += `<div style="font-size:0.55rem; opacity:0.5; margin-bottom:4px;">ACTIVE RUNTIMES</div>`;
                                for (var k = 0; k < rtKeys.length; k++) {
                                    var ver = rtKeys[k];
                                    var info = data.openfin.runtimes[ver];
                                    var verColor = rtKeys.length > 1 ? "#ffcc00" : "#fff";
                                    var gpuTxt = info.gpu > 0 ? `<span style="color:var(--accent-blue); font-weight:700;">GPU ${Number(info.gpu).toFixed(0)}%</span>` : `<span style="opacity:0.3;">GPU 0%</span>`;

                                    rvmH += `<div style="font-size:0.65rem; margin-bottom:3px; display:flex; justify-content:space-between; background:rgba(255,255,255,0.03); padding:4px 6px; border-radius:4px;">
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

                            rvmH += `<div style="margin-top:8px; border-top:1px solid rgba(255,255,255,0.05); padding-top:6px;">
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
                    flagsH = '<div style="font-size:0.5rem; padding:3px 6px; background:rgba(255,255,255,0.05); border-radius:4px; color:var(--text-dim);">SECURE_BASELINE</div>';
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
                if (flagsEl) flagsEl.innerHTML = '<div style="font-size:0.55rem; padding:4px 8px; background:rgba(255,255,255,0.05); border-radius:4px; color:var(--text-dim);">OpenFin Not Detected</div>';
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

        // VMware Health Card Rendering
        var vmCard = document.getElementById("vmware-health-card");
        if (vmCard && (data.vmware || (data.sys && data.sys.isVMware))) {
            vmCard.style.display = "block";
            if (data.vmware) {
                safeSetText("vm-ready-val", (data.vmware.cpuReady || 0).toFixed(1) + " %");
                safeSetText("vm-balloon-val", (data.vmware.balloon || 0) + " MB");
                safeSetText("vm-swap-val", (data.vmware.swap || 0) + " MB");
                safeSetText("vm-costop-val", (data.vmware.costop || 0).toFixed(1) + " %");

                var readyEl = document.getElementById("vm-ready-val");
                if (readyEl) {
                    var ready = data.vmware.cpuReady || 0;
                    if (ready > 10) readyEl.style.color = "var(--accent-red)";
                    else if (ready > 5) readyEl.style.color = "#ffcc00";
                    else readyEl.style.color = "var(--accent-blue)";
                }

                var costopEl = document.getElementById("vm-costop-val");
                if (costopEl) {
                    var csVal = data.vmware.costop || 0;
                    if (csVal > 3) costopEl.style.color = "var(--accent-red)";
                    else if (csVal > 1) costopEl.style.color = "#ffcc00";
                    else costopEl.style.color = "#fff";
                }

                var balloonEl = document.getElementById("vm-balloon-val");
                if (balloonEl) {
                    if ((data.vmware.balloon || 0) > 0) balloonEl.style.color = "var(--accent-red)";
                    else balloonEl.style.color = "var(--accent-blue)";
                }

                var swapEl = document.getElementById("vm-swap-val");
                if (swapEl) {
                    if ((data.vmware.swap || 0) > 0) swapEl.style.color = "var(--accent-red)";
                    else swapEl.style.color = "var(--accent-blue)";
                }
            } else {
                safeSetText("vm-ready-val", "0.0 %");
                safeSetText("vm-balloon-val", "0 MB");
                safeSetText("vm-swap-val", "0 MB");
                safeSetText("vm-costop-val", "0.0 %");
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
                tHtml += `<div class="proc-card-row">
                    <div style="display:flex; justify-content:space-between; font-weight:700;">
                        <span>${t.name}</span>
                        <span style="color:var(--accent-red); font-size:1.1rem;">${t.th}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:0.55rem; opacity:0.5;">
                        <span>PID ${t.pid} | CPU: ${t.cpu}%</span>
                        <span>THREADS</span>
                    </div>
                    <div style="text-align:right; margin-top:6px;">
                        <button class="kill-btn-mini" onclick="confirmPurge(${t.pid}, '${t.name.replace(/'/g, "\\'")}')" style="width:auto; padding:4px 12px; font-size:0.55rem; letter-spacing:1px; background:rgba(255,55,95,0.15); border:1px solid var(--accent-red); color:var(--accent-red); border-radius:4px; font-weight:700;">TERMINATE</button>
                    </div>
                </div>`;
            }
            threadTarget.innerHTML = tHtml;
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

                    eHtml += `<div class="event-item" style="background:rgba(255,255,255,0.03); padding:8px; border-radius:6px; border-left:3px solid ${color}; margin-bottom:10px;">
                        <div style="display:flex; justify-content:space-between; font-size:0.55rem; opacity:0.6; margin-bottom:4px;">
                            <span>${ev.time}</span>
                            <span style="letter-spacing:1px;">ID ${ev.id}</span>
                        </div>
                        <div style="font-size:0.65rem; font-weight:700; color:#fff; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ev.src}</div>
                        <div style="font-size:0.6rem; color:rgba(255,255,255,0.5); line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${ev.msg}</div>
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
                    zsHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; border-bottom:1px solid rgba(255,255,255,0.03); padding-bottom:5px;">
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
                fgHtml += `<div style="background:rgba(255,255,255,0.02); padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.05);">
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

                evtTarget.insertAdjacentHTML('afterbegin', `<div class="event-item" style="background:rgba(255,255,255,0.03); padding:8px; border-radius:6px; border-left:3px solid ${color}; margin-bottom:10px; animation: pulse-blue 1s;">
                    <div style="font-size:0.65rem; font-weight:700; color:#fff;">SYSTEM COMMAND</div>
                    <div style="font-size:0.6rem; color:rgba(255,255,255,0.7);">${msg}</div>
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
                        <div style="font-size:0.65rem; font-weight:700; color:#fff;">SYSTEM REPORT GENERATED</div>
                        <div style="font-size:0.6rem; color:rgba(255,255,255,0.7);">${txt}</div>
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
            await storage.saveReport(e.target.result);
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
    }
};

function showDef(type) {
    const def = definitions[type];
    if (!def) return;
    document.getElementById("modal-title").textContent = def.title;
    document.getElementById("modal-body").textContent = def.text;
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
            var target = document.getElementById("system-changes-target");
            var badge = document.getElementById("changes-count-badge");
            if (target && badge) {
                badge.textContent = data.length + " UPDATES";
                badge.className = data.length > 0 ? "status-neon-green" : "status-dim";
                if (data.length === 0) {
                    target.innerHTML = '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:40px;">No recent changes found.</div>';
                    return;
                }
                var html = "";
                for (var i = 0; i < data.length; i++) {
                    var c = data[i];
                    var col = "var(--accent-blue)";
                    var icon = "📦";
                    if (c.Type === "Windows Update") { col = "var(--accent-green)"; icon = "🔄"; }
                    else if (c.Type === "BIOS Update") { col = "var(--accent-red)"; icon = "💻"; }

                    html += `<div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border-left:3px solid ${col};">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span style="font-size:0.65rem; color:${col}; font-weight:800;">${icon} ${c.Type}</span>
                            <span style="font-size:0.6rem; opacity:0.6; font-family:monospace;">${c.Date}</span>
                        </div>
                        <div style="font-size:0.75rem; color:#fff; word-break:break-word;">${c.Name}</div>
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

start();

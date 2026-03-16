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
var localSysUptimeSeconds = 0;
var lastUptimeSync = "";
var bootTimeBase = null; 
var lastThreadCounts = {};
var threadHistory = {}; // Track first appearance for "NEW" tags
var loadingStartTime = Date.now();
var LOADING_MIN_MS = 1000; // Reduced for better UX
var loadingDismissed = false;  // Guards against double-dismiss
var loadingDataReady = false;

function dismissLoadingOverlay() {
    if (loadingDismissed) return;
    var elapsed = Date.now() - loadingStartTime;
    var remaining = Math.max(0, LOADING_MIN_MS - elapsed);

    // Update status text
    var status = document.getElementById("loading-status");
    if (status) status.textContent = remaining > 0 ? "Engine ready. Launching dashboard..." : "Data received. Loading dashboard...";

    // Wait for remaining minimum time, then fade out
    setTimeout(function () {
        if (loadingDismissed) return;
        loadingDismissed = true;
        var overlay = document.getElementById("loading-overlay");
        if (overlay) {
            overlay.style.transition = "opacity 0.7s ease";
            overlay.style.opacity = "0";
            setTimeout(function () { if (overlay) overlay.style.display = "none"; }, 750);
        }
    }, remaining);
}

var animatingTexts = {};

function safeSetTextAnimated(id, endValue, formatter, duration) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!duration) duration = 800; // default 800ms

    var endNum = parseFloat(endValue) || 0;
    var currentText = el.textContent || "0";
    var startNum = parseFloat(currentText.replace(/[^0-9.-]/g, ''));
    if (isNaN(startNum)) startNum = 0;

    if (animatingTexts[id] && animatingTexts[id].target === endNum) return;

    if (animatingTexts[id] && animatingTexts[id].frame) {
        cancelAnimationFrame(animatingTexts[id].frame);
    }

    var startTime = null;
    var step = function (timestamp) {
        if (!startTime) startTime = timestamp;
        var progress = Math.min((timestamp - startTime) / duration, 1);
        var easeOut = 1 - Math.pow(1 - progress, 3); // Cubic easeOut
        var current = startNum + (endNum - startNum) * easeOut;

        el.textContent = formatter ? formatter(current) : Math.round(current);

        if (progress < 1) {
            animatingTexts[id].frame = requestAnimationFrame(step);
        } else {
            el.textContent = formatter ? formatter(endNum) : Math.round(endNum);
            delete animatingTexts[id];
        }
    };

    animatingTexts[id] = { target: endNum, frame: requestAnimationFrame(step) };
}

function safeSetText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
}

function safeSetHTML(id, val) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = val;
}

function safeSetClass(id, cls) {
    var el = document.getElementById(id);
    if (el) el.className = cls;
}

function safeSetStyle(id, prop, val) {
    var el = document.getElementById(id);
    if (el) el.style[prop] = val;
}

function formatSeconds(s) {
    if (isNaN(s) || s < 0) return "00:00:00";
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ":" + (sec < 10 ? "0" + sec : sec);
}

function formatSecondsLong(s) {
    if (isNaN(s) || s < 0) return "0d 00:00:00";
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return d + "d " + (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ":" + (sec < 10 ? "0" + sec : sec);
}

var engineStartTime = Date.now();
function tickUptime() {
    var now = Date.now();
    localUptimeSeconds = Math.floor((now - engineStartTime) / 1000);
    
    safeSetText("uptime-display", formatSeconds(localUptimeSeconds));
    
    if (bootTimeBase && !isNaN(bootTimeBase.getTime())) {
        var diffSeconds = Math.floor((now - bootTimeBase.getTime()) / 1000);
        if (diffSeconds > 0) {
            localSysUptimeSeconds = diffSeconds;
            safeSetText("sys-uptime-val", formatSeconds(localSysUptimeSeconds));
        }
    }
}

// Standalone High-Precision Clock Loop (Independent of /api/stats)
function startStandaloneClock() {
    function clockStep() {
        tickUptime();
        requestAnimationFrame(clockStep);
    }
    requestAnimationFrame(clockStep);
}

async function openRepository() {
    try {
        const response = await fetch('/api/open-repo');
        const res = await response.json();
        if (res.status === "error") {
            alert("FAILED TO OPEN REPOSITORY: " + res.message);
        }
    } catch (err) {
        alert("ENGINE COMMUNICATION ERROR: " + err.message);
    }
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
    if (l < 2 || isNaN(max) || max <= 0) return;

    for (var i = 0; i < l; i++) {
        var x = (i / (l - 1)) * w;
        var val = parseFloat(data[i]);
        if (isNaN(val)) val = 0;
        var y = h - (Math.min(val, max) / max) * 90 - 5;
        pts.push({ x: x, y: y });
    }

    var d = "M " + pts[0].x + "," + (isNaN(pts[0].y) ? h : pts[0].y);
    for (var i = 1; i < l; i++) {
        var p = pts[i - 1], c = pts[i];
        if (isNaN(p.y) || isNaN(c.y)) continue;
        var mx = (p.x + c.x) / 2;
        d += " C " + mx + "," + p.y + " " + mx + "," + c.y + " " + c.x + "," + c.y;
    }

    var line = svg.querySelector(".spark-path"), fill = svg.querySelector(".spark-fill");
    if (line) line.setAttribute("d", d);
    if (fill) {
        var fillPath = d + " L " + w + " " + h + " L 0 " + h + " Z";
        if (fillPath.indexOf("NaN") === -1) fill.setAttribute("d", fillPath);
    }

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
        "<text x='2' y='" + (h - 2) + "' fill='rgba(var(--text-rgb),0.4)' font-size='9'>baseline</text>";
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
            var y = h - (Math.min(arrData[i], maxVal) / maxVal) * 90 - 5;
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
        var col = "rgba(0, 210, 255, 0.15)";
        var op = 0.4 + (l / 100) * 0.6;

        if (l < 2) {
            col = "rgba(0, 210, 255, 0.1)"; // Deep Idle
        } else if (l < 40) {
            // Cool Blue to Cyan
            col = "rgba(0, 210, 255, " + op + ")";
        } else if (l < 75) {
            // Cyan to Greenish
            var green = 200 + Math.floor((l / 75) * 55);
            col = "rgba(48, " + green + ", 88, " + op + ")";
        } else if (l < 90) {
            // Orange Heat
            col = "rgba(255, 204, 0, " + op + ")";
        } else {
            // Critical Red
            col = "rgba(255, 55, 95, " + op + ")";
        }

        var border = "1px solid rgba(255,255,255,0.05)";
        var title = 'Core C' + i + ': ' + Math.round(l) + '%';

        if (aff !== null) {
            var allowed = (aff & (1n << BigInt(i))) !== 0n;
            if (allowed) {
                border = "1px solid var(--accent-blue)";
                title += " [Affinity Set]";
            } else {
                col = "rgba(20,20,25,0.4)";
                title += " [Restricted]";
            }
        }

        h += '<div class="core-box ' + (l > 85 ? 'core-critical' : '') + '" style="background:' + col + '; border:' + border + '" title="' + title + '">C' + i + '</div>';
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
    // --- INTEGRATE AI HEURISTICS ---
    const aiResults = window.HeuristicsEngine ? window.HeuristicsEngine.processPayload(data) : null;

    if (!data) return;

    // Uptime Syncing (Soft correction to prevent interval drift)
    if (data.uptime) {
        var parts = data.uptime.split(':');
        if (parts.length === 3) {
            var s = (parseInt(parts[0]) * 3600) + (parseInt(parts[1]) * 60) + parseInt(parts[2]);
            if (!isNaN(s)) localUptimeSeconds = s;
        }
    }
    if (data.sysUpSecs) {
        localSysUptimeSeconds = data.sysUpSecs;
    }

    if (data.cbLen !== undefined) {
        var cb = document.getElementById("cb-size-val");
        if (cb) {
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
            safeSetText("cb-size-val", formatted);
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
        safeSetText("gpu-name", data.sys.gpu || "--");
    }
    if (data.status === "initializing") return;

    try {
        jitterExplanationGlobal = data.jitterInfo || "Jitter not defined.";
        isSimOn = true;

        // Browser Memory Monitor Rendering
        if (data.browserMonitor) {
            var bm = data.browserMonitor;

            // Header: Time
            safeSetText("br-monitor-time", new Date().toLocaleTimeString() + "." + String(new Date().getMilliseconds()).padStart(3, '0'));

            // System Memory Section (Safe checks as this may be removed)
            safeSetText("br-sys-total", (bm.sysMem.total || 0) + " GB");
            safeSetText("br-sys-used", (bm.sysMem.used || 0) + " GB");
            safeSetText("br-sys-free", (bm.sysMem.free || 0) + " GB");
            safeSetText("br-sys-pct-text", (bm.sysMem.pct || 0) + "%");
            var sysBar = document.getElementById("br-sys-bar");
            if (sysBar) sysBar.style.width = (bm.sysMem.pct || 0) + "%";

            // Browser Summaries & Tables
            var keys = ["chrome", "edge"];
            for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                var bObj = bm[key];
                if (bObj && bObj.active) {
                    // Summary Stats
                    safeSetText(key + "-proc-count", bObj.procs);
                    safeSetText(key + "-tab-count", bObj.tabs);
                    safeSetText(key + "-ext-count", bObj.exts);
                    safeSetText(key + "-ws", bObj.ws + " MB");
                    safeSetText(key + "-priv", bObj.priv + " MB");
                    safeSetText(key + "-shared", bObj.shared + " MB (" + bObj.sysPct + "%)");
                    safeSetText(key + "-sys-pct", bObj.sysPct + "%");

                    var bar = document.getElementById(key + "-sys-bar");
                    if (bar) bar.style.width = Math.min(bObj.sysPct * 2, 100) + "%";

                    // Process Table
                    var tbody = document.getElementById(key + "-proc-table-body");
                    if (tbody && bObj.topProcs) {
                        var html = "";
                        for (var i = 0; i < bObj.topProcs.length; i++) {
                            var p = bObj.topProcs[i];
                            html += '<tr>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); color:var(--accent-blue); font-weight:800; border-right:1px solid rgba(255,255,255,0.03);">' + p.pid + '</td>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); opacity:0.8; border-right:1px solid rgba(255,255,255,0.03);">' + p.type + '</td>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); color:var(--accent-green); font-weight:800; border-right:1px solid rgba(255,255,255,0.03);">' + p.ws + ' MB</td>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); color:#ff9966; font-weight:800; border-right:1px solid rgba(255,255,255,0.03);">' + p.priv + ' MB</td>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); opacity:0.6; border-right:1px solid rgba(255,255,255,0.03); text-align:center;">' + p.threads + '</td>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); text-align:right; font-weight:800;">' + p.cpu + '</td>' +
                                '<td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); text-align:center; vertical-align:middle;">' +
                                    '<button class="footer-btn" style="padding:2px 6px; font-size:0.6rem; margin:0;" onclick="analyzeProcess(' + p.pid + ', \'' + p.type + '\')">Analyze</button>' +
                                '</td>' +
                            '</tr>';
                        }
                        safeSetHTML(key + "-proc-table-body", html);
                    }

                    // Footer Stats
                    if (key === "chrome") safeSetText("footer-chrome-stats", (bObj.tabs || 0) + " tabs, " + (bObj.ws || 0) + " MB");
                    if (key === "edge") safeSetText("footer-edge-stats", (bObj.tabs || 0) + " tabs, " + (bObj.ws || 0) + " MB");
                }
            }

            // Footer Update Time
            safeSetText("footer-update-time", (data.loopTime || 0) + "ms");
        }

        // 4. Update Graphs
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

        // Calculate actual Windows System Uptime from bootTime
        if (data.sys && data.sys.boot) {
            try {
                var bootDate = new Date(data.sys.boot);
                if (!isNaN(bootDate.getTime())) {
                    bootTimeBase = bootDate;
                }
            } catch (e) {
                console.error("Error parsing boot time:", e);
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
        }

        // 2. Metrics 
        if (data.cpu) {
            safeSetTextAnimated("cpu-usage-percent", data.cpu.usage || 0, function (v) { return v.toFixed(1) + "%"; });

            var qEl = document.getElementById("cpu-queue-val");
            var kEl = document.getElementById("cpu-kernel-val");
            var ctxEl = document.getElementById("cpu-ctx-val");

            if (qEl) {
                qEl.textContent = data.cpu.queue || 0;
                qEl.style.color = getDiagnosticColor(data.cpu.queue, [0, 2, 5]);
            }
            if (kEl) {
                kEl.textContent = (data.cpu.kernel || 0) + "%";
                kEl.style.color = getDiagnosticColor(data.cpu.kernel, [5, 15, 30]);
            }
            if (ctxEl) {
                ctxEl.textContent = (data.cpu.ctx || 0).toLocaleString();
            }

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

        // 3. New Intelligence Features
        if (data.uiAudit) {
            safeSetText("os-transparency-val", data.uiAudit.transparency);
            safeSetText("os-animations-val", data.uiAudit.animations);
            var statusBadge = document.getElementById("ui-tuning-status");
            if (statusBadge) {
                statusBadge.textContent = (data.uiAudit.transparency === "Disabled" && data.uiAudit.animations === "Disabled") ? "OPTIMIZED" : "AUDITED";
                statusBadge.className = statusBadge.textContent === "OPTIMIZED" ? "status-neon-green" : "status-dim";
            }
        }

        if (data.bbg) {
            safeSetText("bbg-terminal-pid", data.bbg.terminal || "OFFLINE");
            safeSetText("bbg-component-pid", data.bbg.component || "OFFLINE");
            safeSetText("bbg-link-lat", data.bbg.latency > 0 ? data.bbg.latency + " ms" : "-- ms");
            var bbgBadge = document.getElementById("bbg-status-badge");
            if (bbgBadge) {
                if (data.bbg.terminal) {
                    bbgBadge.textContent = "ONLINE";
                    bbgBadge.className = "status-neon-green";
                    if (bbgBadge.parentElement && bbgBadge.parentElement.parentElement) {
                        bbgBadge.parentElement.parentElement.style.borderTop = "1px solid var(--accent-blue)";
                    }
                } else {
                    bbgBadge.textContent = "OFFLINE";
                    bbgBadge.className = "status-dim";
                    if (bbgBadge.parentElement && bbgBadge.parentElement.parentElement) {
                        bbgBadge.parentElement.parentElement.style.borderTop = "none";
                    }
                }
            }
        }

        if (data.mem) {
            safeSetTextAnimated("mem-usage-percent", data.mem.percent || 0, function (v) { return v.toFixed(1) + "%"; });
            safeSetText("mem-available-box", "Available: " + (data.mem.avail || 0));
            metrics.mem.shift(); metrics.mem.push(data.mem.percent || 0);
            drawAreaChart("mem-spark-svg", metrics.mem, 100);

            // Memory trend arrow (Item 3)
            var trendEl = document.getElementById("mem-trend-arrow");
            if (trendEl && data.mem.trend) {
                var tArrow = data.mem.trend === "rising" ? "↑" : (data.mem.trend === "falling" ? "↓" : "→");
                var tColor = data.mem.trend === "rising" ? "var(--accent-red)" : (data.mem.trend === "falling" ? "var(--accent-green)" : "var(--text-dim)");
                trendEl.textContent = tArrow + " " + (data.mem.trendRate > 0 ? "+" : "") + (data.mem.trendRate || 0).toFixed(1) + "% / 10s";
                trendEl.style.color = tColor;
            }
        }
        if (data.mem_deep) {
            safeSetText("mem-commit-val", (data.mem.commitPct || data.mem_deep.commit || 0) + "%");

            // Current & Peak Swaps/Pagefile
            safeSetText("mem-swaps-val", (data.mem_deep.faults || 0).toLocaleString());
            safeSetText("mem-swaps-peak", (data.mem_deep.peakSwaps || 0).toLocaleString());
            safeSetText("mem-pagefile-val", (data.mem_deep.pageFile || 0).toFixed(1) + "%");
            safeSetText("mem-pagefile-peak", (data.mem_deep.peakPageFile || 0).toFixed(1) + "%");

            var cEl = document.getElementById("mem-commit-val");
            if (cEl) {
                var cmtVal = data.mem.commitPct || data.mem_deep.commit || 0;
                if (cmtVal > 90) cEl.style.color = "var(--accent-red)";
                else if (cmtVal > 75) cEl.style.color = "#ffcc00";
                else cEl.style.color = "var(--accent-blue)";
            }
        } else if (data.mem && data.mem.commitPct !== undefined) {
            safeSetText("mem-commit-val", data.mem.commitPct + "%");
            var cEl = document.getElementById("mem-commit-val");
            if (cEl) {
                if (data.mem.commitPct > 90) cEl.style.color = "var(--accent-red)";
                else if (data.mem.commitPct > 75) cEl.style.color = "#ffcc00";
                else cEl.style.color = "var(--accent-blue)";
            }
        }

        if (data.disk) {
            safeSetTextAnimated("disk-tp-box", data.disk.tp || 0, function (v) { return v.toFixed(1) + " MB/S"; });
            safeSetTextAnimated("disk-lat-box", data.disk.lat || 0, function (v) { return "LATENCY: " + Math.round(v) + "ms"; });
            safeSetTextAnimated("disk-queue-box", data.disk.queue || 0, function (v) { return "QUEUE: " + Math.round(v); });
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

        if (data.nvidia) {
            var nv = data.nvidia;
            if (nv.active) {
                // Ensure arrays are preserved in JS even if unrolled by PowerShell 5.1
                var gpusArr = Array.isArray(nv.gpus) ? nv.gpus : (nv.gpus ? [nv.gpus] : []);
                var procsArr = Array.isArray(nv.procs) ? nv.procs : (nv.procs ? [nv.procs] : []);

                // Render Top GPUs
                var gpuHtml = "";
                if (gpusArr.length > 0) {
                    for (var i = 0; i < gpusArr.length; i++) {
                        var g = gpusArr[i];
                        var pColor = g.pctUsed > 80 ? 'var(--accent-red)' : (g.pctUsed > 50 ? 'var(--accent-yellow)' : 'var(--accent-green)');
                        gpuHtml += `<div class="metric-glass-card" style="min-height:500px; display:flex; flex-direction:column; padding:15px; border-top: 1px solid var(--accent-blue); position:relative; overflow:hidden;">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                                <div style="font-size:0.75rem; color:var(--text-dim); text-transform:uppercase; font-weight:800; letter-spacing:1px;">
                                    GPU ${g.id} &bull; VRAM<br/>
                                    <span style="color:var(--text-main); font-size:1rem; font-weight:700;">${g.name}</span>
                                </div>
                                <span class="info-bubble" onclick="showDef('vram')" title="VRAM Monitor">?</span>
                            </div>
                            
                            <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
                                <div style="text-align:center; font-family:'Outfit'; font-weight:800; font-size:4rem; color:${pColor}; margin-bottom:10px; line-height:1;">${g.pctUsed.toFixed(1)}%</div>
                                <div class="bar-bg-stripe" style="height:12px; border-radius:6px; margin-bottom:15px; background:rgba(255,255,255,0.05);">
                                    <div class="bar-fill-stripe" style="height:100%; border-radius:6px; width:${Math.min(g.pctUsed, 100)}%; background:${pColor};"></div>
                                </div>
                                <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:20px;">
                                    <div style="font-size:0.7rem; color:var(--text-dim); text-transform:uppercase; font-weight:800; letter-spacing:1px;">VRAM USAGE</div>
                                    <div style="font-size:1rem; font-family:monospace; font-weight:700;">${g.usedMB} MB / ${g.totalMB} MB</div>
                                </div>
                            </div>
                            
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; text-align:center; margin-top:auto;">
                                <div style="border:1px solid rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                                    <div style="color:var(--accent-blue); font-weight:800; font-size:1.1rem;">${g.freeMB}</div>
                                    <div style="font-size:0.6rem; color:var(--text-dim); text-transform:uppercase; font-weight:800;">FREE MB</div>
                                </div>
                                <div style="border:1px solid rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                                    <div style="color:var(--accent-blue); font-weight:800; font-size:1.1rem;">${g.util}%</div>
                                    <div style="font-size:0.6rem; color:var(--text-dim); text-transform:uppercase; font-weight:800;">GPU UTIL</div>
                                </div>
                                <div style="border:1px solid rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                                    <div style="color:var(--accent-blue); font-weight:800; font-size:1.1rem;">${g.tempC}&deg;C</div>
                                    <div style="font-size:0.6rem; color:var(--text-dim); text-transform:uppercase; font-weight:800;">TEMP</div>
                                </div>
                            </div>
                        </div>`;
                    }
                } else {
                    gpuHtml = '<div class="metric-glass-card" style="min-height:500px; display:flex; align-items:center; justify-content:center; opacity:0.5; font-size:0.8rem; text-align:center;">No GPUs Detected</div>';
                }
                safeSetHTML("vram-gpus-container", gpuHtml);
            } else {
                safeSetHTML("vram-gpus-container", '<div style="opacity:0.5; font-size:0.8rem; text-align:center; padding:20px; grid-column:1/-1;">NVIDIA SMI Not Available on this Host</div>');
            }
        }

            // Network Card Updates (Integrated Analysis)
            if (data.sys && data.sys.netConfig) {
                var nc = data.sys.netConfig;
                safeSetText("net-desc", nc.adapter || "Unknown Adapter");
                safeSetText("net-driver-full", (nc.driver || "N/A") + (nc.driverDate ? " [" + nc.driverDate + "]" : ""));
                safeSetText("net-mac", nc.mac || "--");
                safeSetText("net-id-virt", (nc.ifIndex || "--") + " / " + (nc.virtual ? "Virtual" : "Physical"));
                safeSetText("net-media-phys", (nc.mediaType || "--") + " / " + (nc.physMedia || "--"));
                safeSetText("net-link-speed", nc.linkSpeed || "--");

                // IP & Routing
                safeSetText("net-ipv4", (nc.ipv4 || "--") + " / " + (nc.subnet || "--"));
                safeSetText("net-gateway", nc.gateway || "--");
                safeSetText("net-dns", (nc.dns || "--").split(',')[0]);
                safeSetText("net-dhcp", nc.dhcp || "--");
                safeSetText("net-metric-mtu", "Metric: " + (nc.routeMetric || "--") + " / MTU: " + (nc.mtu || "--"));

                // Tuning Parameters
                safeSetText("net-jumbo", nc.jumbo || "--");
                safeSetText("net-intmod", nc.intmod || "--");
                safeSetText("net-flow", nc.flow || "--");
                safeSetText("net-rxSmall", nc.rxSmall || "--");
                safeSetText("net-rxLarge", nc.rxLarge || "--");

                if (data.cpu_deep) safeSetText("net-ints", (data.cpu_deep.ints || 0).toLocaleString());

                var plVal = document.getElementById("net-packet-loss");
                if (plVal) {
                    var pl = nc.packetLoss || 0;
                    plVal.textContent = pl.toFixed(4) + "%";
                    if (pl > 0.05) plVal.style.color = "var(--accent-red)";
                    else if (pl > 0.01) plVal.style.color = "#ffcc00";
                    else plVal.style.color = "var(--accent-green)";
                }
            }



        // OpenFin Forensic Intel
        var ofinCard = document.getElementById("openfin-card");
        if (ofinCard && data.openfin) {
            if (data.openfin.active) {
                var hTag = document.getElementById("ofin-health-tag");
                if (data.openfin.health !== undefined) {
                    var hTag = document.getElementById("ofin-health-tag");
                    if (hTag) {
                        hTag.textContent = data.openfin.health + "% HEALTH";
                        hTag.className = data.openfin.health > 80 ? "status-neon-green" : (data.openfin.health < 50 ? "status-neon-red" : "status-dim");
                    }
                }

                safeSetText("ofin-env-tag", data.openfin.env || "PHYSICAL");

                var riskEl = document.getElementById("ofin-hang-risk");
                if (riskEl) {
                    var hr = data.openfin.hangRisk || "NORMAL";
                    riskEl.textContent = hr;
                    if (hr === "CRITICAL" || hr === "HIGH") riskEl.style.color = "var(--accent-red)";
                    else if (hr === "ELEVATED") riskEl.style.color = "#ffcc00";
                    else riskEl.style.color = "var(--accent-green)";
                }

                var growthEl = document.getElementById("ofin-thread-growth");
                if (growthEl) {
                    var gr = data.openfin.growth || "STABLE";
                    growthEl.textContent = gr;
                    growthEl.style.color = (gr === "RAPID") ? "var(--accent-red)" : (gr === "ELEVATED" ? "#ffcc00" : "var(--accent-blue)");
                }

                safeSetText("ofin-renderers", data.openfin.renderers || 0);
                safeSetText("ofin-ram", (data.openfin.ram || 0).toLocaleString() + " MB");

                var ecoTarget = document.getElementById("ofin-eco-ram");
                if (ecoTarget && data.openfin.ecosystemRam !== undefined) {
                    var trendChar = data.openfin.ecoTrend === "rising" ? "↗" : (data.openfin.ecoTrend === "falling" ? "↘" : "→");
                    var trendColor = data.openfin.ecoTrend === "rising" ? "var(--accent-red)" : (data.openfin.ecoTrend === "falling" ? "var(--accent-green)" : "var(--text-dim)");

                    ecoTarget.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:0.7rem; opacity:0.5; font-weight:800; text-transform:uppercase;">Ecosystem RSS</div>
                                <div style="font-size:1.1rem; font-weight:800; color:var(--text-main);">${data.openfin.ecosystemRam.toLocaleString()} MB <span style="color:${trendColor}; font-size:0.8rem;">${trendChar}</span></div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:0.7rem; opacity:0.5; font-weight:800; text-transform:uppercase;">Total Threads</div>
                                <div style="font-size:1.1rem; font-weight:800; color:var(--accent-blue);">${data.openfin.totalThreads || 0}</div>
                            </div>
                        </div>`;
                }

                // Lifecycle Logging (Consolidated & Consistent)
                if (data.openfin && data.openfin.lifecycle) {
                    var logBox = document.getElementById("ofin-lifecycle-log");
                    if (logBox) {
                        var lc = data.openfin.lifecycle;
                        if ((lc.spawned && lc.spawned.length > 0) || (lc.crashed && lc.crashed.length > 0)) {
                            var logTs = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

                            if (logBox.innerHTML.includes("Awaiting")) logBox.innerHTML = "";

                            for (var k = 0; k < lc.spawned.length; k++) {
                                var p = lc.spawned[k];
                                logBox.insertAdjacentHTML('afterbegin', '<div style="color:var(--accent-green); font-size:0.65rem; border-bottom:1px solid rgba(255,255,255,0.02); padding:3px 0; font-family:monospace;">[' + logTs + '] SPAWN: ' + p + '</div>');
                            }
                            for (var l = 0; l < lc.crashed.length; l++) {
                                var p = lc.crashed[l];
                                logBox.insertAdjacentHTML('afterbegin', '<div style="color:var(--accent-red); font-size:0.65rem; border-bottom:1px solid rgba(255,255,255,0.02); padding:3px 0; font-family:monospace;">[' + logTs + '] CRASH: ' + p + '</div>');
                            }

                            while (logBox.children.length > 10) logBox.removeChild(logBox.lastChild);
                        }
                    }
                }

                // OpenFin Core Metrics Surfacing
                if (data.openfin) {
                    safeSetText("ofin-window-count", (data.openfin.windows || 0));
                    safeSetText("ofin-virtual-mb", (data.openfin.virtualMB || 0).toLocaleString() + " MB");
                    safeSetText("ofin-recovery-count", (data.openfin.recoveries || 0));
                    safeSetText("ofin-gpu-crashes", (data.openfin.gpuCrashes || 0));

                    // Hang State Surfacing
                    var hangEl = document.getElementById("ofin-hang-state");
                    if (hangEl) {
                        if (data.openfin.hangCount > 0) {
                            hangEl.innerText = "HANGING (" + data.openfin.hangCount + ") - " + data.openfin.hangDuration + "s";
                            hangEl.style.color = "var(--accent-red)";
                            hangEl.classList.add("neon-pulse-red");
                        } else {
                            hangEl.innerText = "CLEAN";
                            hangEl.style.color = "var(--accent-green)";
                            hangEl.classList.remove("neon-pulse-red");
                        }
                    }

                    // Process Breakdown Table
                    if (data.openfin.processes) {
                        var tableBody = document.getElementById("ofin-process-table-body");
                        if (tableBody) {
                            // Manual sort to avoid spread/ES6
                            var sortedProcs = [];
                            for (var i = 0; i < data.openfin.processes.length; i++) {
                                sortedProcs.push(data.openfin.processes[i]);
                            }
                            sortedProcs.sort(function(a, b) { return b.ram - a.ram; });

                            var pHtml = "";
                            for (var j = 0; j < sortedProcs.length; j++) {
                                var p = sortedProcs[j];
                                var pName = p.name ? p.name.replace(".exe", "") : "Unknown";
                                var cpuColor = p.cpu > 20 ? "var(--accent-red)" : (p.cpu > 5 ? "var(--accent-blue)" : "var(--text-dim)");
                                pHtml += '<tr style="border-bottom:1px solid rgba(255,255,255,0.02);">' +
                                    '<td style="padding:2px; color:var(--text-dim);">' + p.pid + '</td>' +
                                    '<td style="padding:2px; color:var(--text-main); font-weight:700;">' + pName + '</td>' +
                                    '<td style="padding:2px; text-align:right; color:' + cpuColor + ';">' + p.cpu.toFixed(1) + '%</td>' +
                                    '<td style="padding:2px; text-align:right; color:var(--accent-blue); font-weight:800;">' + p.ram.toFixed(1) + '</td>' +
                                    '<td style="padding:2px; text-align:right; color:var(--text-dim); opacity:0.6;">' + (p.virtualMB || 0) + '</td>' +
                                    '<td style="padding:2px; text-align:right;">' +
                                        '<button class="footer-btn" style="padding:2px 6px; font-size:0.55rem; margin:0; border:1px solid var(--accent-blue); color:var(--accent-blue); background:rgba(0,210,255,0.1);" onclick="analyzeProcess(' + p.pid + ', \'' + pName + '\')">ACT</button>' +
                                    '</td>' +
                                '</tr>';
                            }
                            tableBody.innerHTML = pHtml;
                        }
                    }
                }

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
                                    <div style="font-size:0.7rem; opacity:0.5;">RVM VERSION</div>
                                    <div style="font-size:0.65rem; font-weight:700; color:var(--text-main);">${rvmVer}</div>
                                 </div>`;

                        // Runtime Section
                        if (data.openfin.runtimes) {
                            var rtKeys = Object.keys(data.openfin.runtimes).filter(k => k !== "Unknown");
                            if (rtKeys.length > 0) {
                                rvmH += `<div style="font-size:0.7rem; opacity:0.5; margin-bottom:4px; margin-top:8px;">ACTIVE RUNTIMES</div>`;
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

                            rvmH += '<div style="margin-top:8px; border-top:1px solid var(--border-light); padding-top:6px;">' +
                                '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                                    '<span style="font-size:0.55rem; opacity:0.5;">THREAD EFFICIENCY</span>' +
                                    '<span style="font-size:0.7rem; font-weight:700; color:' + effColor + ';">' + eff + '%</span>' +
                                '</div>' +
                                '<div style="font-size:0.5rem; color:var(--text-dim); margin-top:2px;">' +
                                    'Dispersion: ' + (data.openfin.dispersion || 0) + ' (StdDev)' +
                                '</div>' +
                            '</div>';

                            if (eff < 45) {
                                rvmH += '<div style="margin-top:4px; font-size:0.55rem; color:var(--accent-red); font-weight:700; background:rgba(255,55,95,0.1); padding:4px; border-radius:4px; text-align:center;">' +
                                        'SINGLE CORE BOTTLENECK DETECTED' +
                                    '</div>';
                            }
                        }
                        safeSetHTML("ofin-rvm-details", rvmH);
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
                safeSetHTML("ofin-flags", flagsH);
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
        // Network & Citrix ICA/HDX Consolidation
        var citrixCard = document.getElementById("citrix-hdx-card");
        if (citrixCard) {
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
                    safeSetHTML("sysview-software-target", sHtml);
                }
            } else if (sTarg && d.state === "COMPLETE" && (!d.software || d.software.length === 0)) {
                safeSetHTML("sysview-software-target", '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:15px;">No recent changes found.</div>');
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
                    safeSetHTML("citrix-config-list", html);
                }
            }

            if (d.diskC && d.av && d.power) {
                safeSetText("sysview-status-tag", "ONLINE");
            } else {
                safeSetText("sysview-status-tag", "ANALYZING");
            }
        }

        // --- NEW: Dynamic CPU Data Population ---
        if (data.sys) {
            if (data.sys.cpu) {
                var cpuName = data.sys.cpu.replace("(R)", "").replace("(TM)", "").trim();
                safeSetText("cpu-model-display", cpuName);
                safeSetText("env-cpu-name", cpuName);
            }
            if (data.sys.cpuSpeed) {
                var speedStr = (data.sys.cpuSpeed / 1000).toFixed(2) + " GHz";
                safeSetText("cpu-speed-display", speedStr);
                safeSetText("env-cpu-speed", speedStr);
            }
        }
        // ----------------------------------------

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
                    for (var fi = 0; fi < Math.min(up.folders.length, 10); fi++) {
                        var f = up.folders[fi];
                        var folderName = f.name.toLowerCase();
                        var remediationTag = "";

                        if (folderName === "downloads") {
                            remediationTag = '<span style="font-size:0.6rem; background:rgba(255,55,95,0.15); color:var(--accent-red); padding:2px 6px; border-radius:4px; margin-left:8px;" title="Review and delete unneeded installers or large ISO files to free up space.">REVIEW & DELETE</span>';
                        } else if (folderName === "documents" || folderName === "desktop" || folderName === "pictures") {
                            remediationTag = '<span style="font-size:0.6rem; background:rgba(0,210,255,0.15); color:var(--accent-blue); padding:2px 6px; border-radius:4px; margin-left:8px;" title="Consider migrating local files to OneDrive/SharePoint to prevent data loss.">MOVE TO ONEDRIVE</span>';
                        } else if (folderName === "appdata") {
                            remediationTag = '<span style="font-size:0.6rem; background:rgba(255,204,0,0.15); color:#ffcc00; padding:2px 6px; border-radius:4px; margin-left:8px;" title="Contains application caches. Safe to clear %TEMP% or browser caches if storage gets extremely low.">TEMP / CACHE</span>';
                        } else if (folderName === "videos") {
                            remediationTag = '<span style="font-size:0.6rem; background:rgba(255,55,95,0.15); color:var(--accent-red); padding:2px 6px; border-radius:4px; margin-left:8px;" title="Media files consume significant network bandwidth during backups. Relocate to cloud storage or delete.">RELOCATE MEDIA</span>';
                        }

                        var topFilesJson = f.topFiles ? encodeURIComponent(JSON.stringify(f.topFiles)) : "[]";

                        html += '<div onclick="showProfileFiles(\'' + f.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\', \'' + topFilesJson + '\')" style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-overlay); padding:8px; border-radius:8px; border:1px solid var(--border-light); cursor:pointer; transition:all 0.2s ease;" onmouseover="this.style.borderColor=\'var(--accent-blue)\'" onmouseout="this.style.borderColor=\'var(--border-light)\'">' +
                            '<div style="font-weight:700; font-size:0.8rem; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px;" title="' + f.name + '">' + f.name + remediationTag + '</div>' +
                            '<div style="font-size:0.75rem; color:var(--text-dim);"><span style="color:var(--accent-blue); font-weight:700;">' + f.sizeMB + ' MB</span> | ' + f.files + ' files</div>' +
                            '</div>';
                    }
                    safeSetHTML("profile-folders-target", html);
                } else if (targ && up.folders && up.folders.length === 0) {
                    safeSetHTML("profile-folders-target", '<div style="opacity:0.3; font-size:0.6rem; text-align:center; padding-top:20px;">No folders found.</div>');
                }
            } else if (up.state === "ERROR") {
                if (bState) { bState.textContent = "SCAN ERROR"; bState.className = "status-dim"; bState.style.color = "var(--accent-red)"; }
                var errTarg = document.getElementById("profile-folders-target");
                safeSetHTML("profile-folders-target", '<div style="color:var(--accent-red); font-size:0.6rem; padding:10px;">Error reading profile: ' + up.error + '</div>');
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
        // DFS/SMB Optimization
        if (data.dfs && Array.isArray(data.dfs)) {
            safeSetText("dfs-count", data.dfs.length);
            var dfsHtml = "";
            for (var d of data.dfs) {
                dfsHtml += `<div style="background:var(--bg-overlay); padding:4px 8px; border-radius:4px; border:1px solid var(--border-light); display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <div style="font-size:0.55rem; color:var(--text-main); font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80px;" title="${d.name}">${d.name}</div>
                    <div style="text-align:right;">
                        <div style="font-size:0.5rem; color:var(--accent-green); font-weight:700;">${d.ip}</div>
                        <div style="font-size:0.45rem; color:var(--text-dim);">SMB ${d.dialect}</div>
                    </div>
                </div>`;
            }
            var tgt = document.getElementById("dfs-list-target");
            safeSetHTML("dfs-list-target", dfsHtml || '<div style="opacity:0.3; font-size:0.55rem; text-align:center; padding-top:15px;">No active shares</div>');
        }

        // 8. Network Stack Card — 3-section layout (Item 5)
        var netSrc = (data.sys && data.sys.netInfo) ? data.sys.netInfo : (data.sys && data.sys.netConfig ? data.sys.netConfig : null);
        if (netSrc) {
            safeSetText("net-config-status", "ACTIVE");
            var nStat = document.getElementById("net-config-status");
            if (nStat) nStat.className = "status-neon-green";

            var netTarget = document.getElementById("net-info-render");
            if (netTarget) {
                var ni = netSrc;
                // Section 1: Adapter / Hardware
                var sec1 = [
                    { label: "Adapter", val: ni.adapterName || ni.name || "--" },
                    { label: "Description", val: ni.description || ni.adapter || "--" },
                    { label: "MAC Address", val: ni.mac || "--" },
                    { label: "Link Speed", val: ni.linkSpeed || "--" },
                    { label: "Media Type", val: ni.mediaType || ni.media || "--" },
                    { label: "Physical Medium", val: ni.physMedia || "--" },
                    { label: "Driver", val: ni.driverInfo || ni.driver || "--" },
                    { label: "Driver Date", val: ni.driverDate || "--" },
                    { label: "MTU Size", val: ni.mtu || "--" },
                    { label: "Virtual Adapter", val: ni.virtual || "--" }
                ];
                // Section 2: IP Configuration
                var sec2 = [
                    { label: "IPv4 Address", val: (ni.ipv4 || ni.ip || "--") + (ni.prefix || (ni.subnet ? "/" + ni.subnet : "")) },
                    { label: "DHCP", val: ni.dhcp || "--" },
                    { label: "Address Origin", val: ni.origin || ni.addrOrigin || "--" },
                    { label: "Gateway", val: ni.gateway || "--" },
                    { label: "Route Metric", val: ni.routeMetric !== undefined ? ni.routeMetric : "--" },
                    { label: "IPv6 Address", val: ni.ipv6 || "--" }
                ];
                // Section 3: DNS / Profile / Advanced
                var sec3 = [
                    { label: "DNS Servers", val: ni.dns || "--" },
                    { label: "Network Profile", val: ni.profile || "--" },
                    { label: "Category", val: ni.category || "--" },
                    { label: "IPv4 Connectivity", val: ni.ipv4Conn || ni.connectivity || "--" },
                    { label: "IPv6 Connectivity", val: ni.ipv6Conn || "--" },
                    { label: "Jumbo Frame", val: ni.jumbo || "--" },
                    { label: "Int. Moderation", val: ni.intmod || "--" },
                    { label: "Flow Control", val: ni.flowCtrl || ni.flow || "--" },
                    { label: "Speed/Duplex", val: ni.speedDuplex || ni.speed || "--" }
                ];

                function renderNetSection(title, rows) {
                    var h = '<div style="margin-bottom:8px;"><div style="font-size:0.5rem;font-weight:800;color:var(--accent-blue);letter-spacing:0.08em;margin-bottom:4px;border-bottom:1px solid var(--border-light);padding-bottom:2px;">' + title + '</div>';
                    for (var ri = 0; ri < rows.length; ri++) {
                        var r = rows[ri];
                        h += '<div style="display:flex;justify-content:space-between;font-size:0.55rem;margin-bottom:2px;">' +
                            '<span style="opacity:0.5;white-space:nowrap;min-width:90px;">' + r.label + '</span>' +
                            '<span style="color:var(--text-main);font-weight:600;text-align:right;word-break:break-all;max-width:160px;" title="' + r.val + '">' + r.val + '</span>' +
                            '</div>';
                    }
                    h += '</div>';
                    return h;
                }

                safeSetHTML("net-info-render",
                    renderNetSection("ADAPTER / HARDWARE", sec1) +
                    renderNetSection("IP CONFIGURATION", sec2) +
                    renderNetSection("DNS / PROFILE / ADVANCED", sec3));
            }
        }

        // 5. Unified Forensic Intelligence
        var ratioTgt = document.getElementById("forensic-rationale-target");
        var aiStatusBadge = document.getElementById("ai-status-badge");

        if (ratioTgt) {
            if (aiResults && aiResults.status === 'CALIBRATING') {
                if (aiStatusBadge) {
                    aiStatusBadge.textContent = "CALIBRATING";
                    aiStatusBadge.className = "status-dim";
                }
                ratioTgt.innerHTML = `
                    <div class="calibration-container">
                        <div style="font-size:0.7rem; font-weight:900; color:var(--accent-blue); text-transform:uppercase; letter-spacing:1px; margin-bottom:5px;">
                            Analyzing System Baseline
                        </div>
                        <div class="calibration-bar-bg">
                            <div class="calibration-bar-fill" style="width: ${aiResults.progress}%"></div>
                        </div>
                        <div style="font-size:0.85rem; color:var(--text-main); font-weight:700;">
                            ${aiResults.progress}% Complete
                        </div>
                        <div style="font-size:0.65rem; color:var(--text-dim); margin-top:10px; line-height:1.4;">
                            Establishing deterministic reference matrix for compute, memory, and graphics. Proactive anomaly detection will engage shortly.
                        </div>
                    </div>
                `;
            } else {
                if (aiStatusBadge) {
                    aiStatusBadge.textContent = (aiResults && aiResults.status === 'ANOMALY') ? "DEVIATION DETECTED" : "HEALTH OPTIMAL";
                    aiStatusBadge.className = (aiResults && aiResults.status === 'ANOMALY') ? "status-neon-red" : "status-neon-green";
                }

                const categories = [
                    { id: 'compute', label: 'Compute & Logic', icon: 'CPU' },
                    { id: 'memory', label: 'Memory & Cache', icon: 'MEM' },
                    { id: 'graphics', label: 'Graphics & Render', icon: 'GPU' },
                    { id: 'engine', label: 'Internal Engine', icon: 'SYS' }
                ];

                // Combine backend logs and AI alerts
                var combinedLogs = [];
                if (data.forensicLog) {
                    for (var m = 0; m < data.forensicLog.length; m++) {
                        var l = data.forensicLog[m];
                        var cat = l.cat ? l.cat.toLowerCase() : 'engine';
                        if (cat === 'disk') cat = 'engine';
                        if (cat === 'browser') cat = 'memory';
                        combinedLogs.push({ ts: l.ts, cat: cat, msg: l.msg, source: 'backend' });
                    }
                }
                if (aiResults && aiResults.alerts) {
                    for (var n = 0; n < aiResults.alerts.length; n++) {
                        var a = aiResults.alerts[n];
                        combinedLogs.push({ ts: a.ts, cat: a.group || 'engine', msg: (a.msg || "").replace(/\[.*?\]\s*/, ""), source: 'heuristics' });
                    }
                }

                // Sort combined logs by time descending per category
                combinedLogs.sort((a, b) => b.ts.localeCompare(a.ts));

                let baselineProgressHtml = "";
                if (aiResults && aiResults.refreshProgress !== undefined) {
                    baselineProgressHtml = `
                        <div style="margin-top:20px; padding-top:15px; border-top:1px solid rgba(255,255,255,0.05);">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                <div style="font-size:0.6rem; color:var(--accent-blue); font-weight:900; letter-spacing:1px; text-transform:uppercase;">Baseline Review Cycle</div>
                                <div style="font-size:0.6rem; color:var(--text-dim); font-weight:800;">RENEWAL IN ${60 - Math.round(aiResults.refreshProgress * 0.6)}s</div>
                            </div>
                            <div class="calibration-bar-bg" style="height:2px;">
                                <div class="calibration-bar-fill" style="width: ${aiResults.refreshProgress}%; background: var(--accent-blue); height:100%;"></div>
                            </div>
                        </div>
                    `;
                }

                let ih = `
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
                `;
                for (var o = 0; o < categories.length; o++) {
                    var cat = categories[o];
                    var findings = (aiResults && aiResults.groupedFindings) ? (aiResults.groupedFindings[cat.id] || []) : [];
                    
                    // Manual filter for catLogs
                    var catLogs = [];
                    for (var p = 0; p < combinedLogs.length; p++) {
                        if (combinedLogs[p].cat === cat.id) {
                            catLogs.push(combinedLogs[p]);
                            if (catLogs.length >= 3) break; // mimic .slice(0,3)
                        }
                    }

                    var hasAnomalies = findings.length > 0 || catLogs.length > 0;
                    var color = hasAnomalies ? "var(--accent-red)" : "var(--accent-blue)";
                    var opacity = hasAnomalies ? "1" : "0.5";

                    // Helper to generate SVG path (Refactored for SES)
                    var generateForensicSpark = function(label) {
                        if (!aiResults || !aiResults.metricHistory || !aiResults.metricHistory[label]) return "";
                        var hist = aiResults.metricHistory[label];
                        var actuals = hist.actual;
                        var baseline = isNaN(hist.baseline) ? 0 : hist.baseline;

                        var width = 140;
                        var height = 24;
                        
                        // Manual Max calculation to avoid spread [...]
                        var maxVal = baseline * 1.5;
                        if (maxVal < 0.1) maxVal = 0.1;
                        for (var q = 0; q < actuals.length; q++) {
                            if (!isNaN(actuals[q]) && actuals[q] > maxVal) maxVal = actuals[q];
                        }
                        var safeMax = maxVal;

                        var getX = function(i) { return (i / (actuals.length - 1)) * width; };
                        var getY = function(v) {
                            var val = isNaN(v) ? 0 : v;
                            return height - ((val / safeMax) * (height - 4)) - 2;
                        };

                        // Manual map for actualPath
                        var actualPath = "";
                        for (var r = 0; r < actuals.length; r++) {
                            var x = getX(r);
                            var y = getY(actuals[r]);
                            var safeX = isNaN(x) ? 0 : x;
                            var safeY = isNaN(y) ? height : y;
                            actualPath += (r === 0 ? 'M' : 'L') + ' ' + safeX + ' ' + safeY;
                        }
                        
                        var baselineY = getY(baseline);
                        var safeBaselineY = (isNaN(baselineY) || baselineY === null) ? height : baselineY;
                        var baselinePath = "M 0 " + safeBaselineY + " L " + width + " " + safeBaselineY;

                        // Manual .some check
                        var isMetricAnomaly = false;
                        for (var s = 0; s < findings.length; s++) {
                            if (findings[s].metric === label) {
                                isMetricAnomaly = true;
                                break;
                            }
                        }

                        return '<div class="forensic-spark-container" style="width: 140px; background: none; border-radius:0;">' +
                                '<svg width="100%" height="100%" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" style="overflow:visible;">' +
                                    '<path d="' + baselinePath + '" class="spark-path-baseline" style="stroke: rgba(255,255,255,0.4); stroke-width: 1; stroke-dasharray: 2,2;" />' +
                                    '<path d="' + actualPath + '" class="spark-path-actual ' + (isMetricAnomaly ? 'is-anomaly' : '') + '" />' +
                                '</svg>' +
                                '<div style="position:absolute; top:0; right:0; font-size:0.45rem; opacity:0.3; font-weight:800;">baseline</div>' +
                            '</div>';
                    };

                    ih += '<div class="ai-category-group" style="border-color: ' + (hasAnomalies ? 'rgba(255,55,95,0.3)' : 'rgba(var(--text-rgb), 0.08)') + '; margin-bottom: 0px; display:flex; flex-direction:column;">' +
                            '<div class="ai-category-title" style="color:' + color + '; opacity:' + opacity + '; display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">' +
                                '<div>' +
                                    '<span style="font-size:0.75rem; font-weight:900;">' + cat.label + '</span>' +
                                    '<span style="font-size:0.6rem; opacity:0.6; margin-left:8px;">' + cat.icon + '</span>' +
                                '</div>' +
                                (hasAnomalies ? '<span style="font-size:0.55rem; background:rgba(255,55,95,0.15); color:var(--accent-red); padding:2px 6px; border-radius:4px; font-weight:900;">DEVIATION</span>' : '<span style="font-size:0.55rem; opacity:0.4; font-weight:900;">STABLE</span>') +
                            '</div>' +
                            
                            '<div style="display:flex; flex-direction:column; gap:12px; border-top: 1px solid rgba(255,255,255,0.03); padding-top:8px; flex:1;">' +
                                '<!-- Current Findings & Sparks -->' +
                                '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:10px;">';
                    
                    if (aiResults && aiResults.metricHistory) {
                        var metricKeys = Object.keys(aiResults.metricHistory);
                        var groups = {
                            compute: ['Wait Queue', 'Context Switches', 'System Calls'],
                            memory: ['Memory Commit', 'Page Faults', 'Swaps'],
                            graphics: ['GPU Usage', 'GPU Decode', 'VRAM Usage'],
                            engine: ['Engine CPU', 'OpenFin CPU', 'Web Latency', 'Disk Latency']
                        };
                        var relevantMetrics = groups[cat.id];
                        for (var t = 0; t < metricKeys.length; t++) {
                            var label = metricKeys[t];
                            var isRelevant = false;
                            for (var u = 0; u < relevantMetrics.length; u++) {
                                if (relevantMetrics[u] === label) { isRelevant = true; break; }
                            }
                            if (isRelevant) {
                                // Manual find for findings
                                var f = null;
                                for (var v = 0; v < findings.length; v++) {
                                    if (findings[v].metric === label) { f = findings[v]; break; }
                                }
                                ih += '<div style="background:var(--panel-inner-bg); padding:8px; border-radius:8px; border:1px solid var(--border-light);">' +
                                        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
                                            '<span style="color:var(--text-main); font-weight:700; font-size:0.65rem; opacity:0.8;">' + label + '</span>' +
                                            (f ? '<span class="ai-deviation-tag" style="font-size:0.6rem;">' + f.deviation + '</span>' : '') +
                                        '</div>' +
                                        generateForensicSpark(label) +
                                    '</div>';
                            }
                        }
                    } else {
                        ih += '<div style="font-size:0.65rem; color:var(--text-dim); font-style:italic; opacity:0.3;">Within baseline</div>';
                    }

                    ih += '</div>' +
                            '<!-- Alerts History -->' +
                            '<div style="margin-top:auto; border-top: 1px solid var(--border-light); padding-top:8px;">' +
                                '<div style="font-size:0.55rem; color:var(--text-dim); text-transform:uppercase; margin-bottom:6px; font-weight:800; opacity:0.6;">Forensic Thread</div>';
                    
                    if (catLogs.length > 0) {
                        for (var w = 0; w < catLogs.length; w++) {
                            var l = catLogs[w];
                            ih += '<div style="font-size:0.65rem; color:var(--text-main); margin-bottom:6px; border-left:2px solid ' + (l.source === 'heuristics' ? 'var(--accent-red)' : '#ffcc00') + '; padding-left:8px; line-height:1.2;">' +
                                    '<div style="font-size:0.55rem; opacity:0.5; font-weight:800;">[' + l.ts + ']</div>' +
                                    '<div style="margin-top:2px; font-weight:500;">' + l.msg + '</div>' +
                                '</div>';
                        }
                    } else {
                        ih += '<div style="font-size:0.6rem; color:var(--text-dim); font-style:italic; opacity:0.3;">No historical markers</div>';
                    }
                    ih += '</div></div></div>';
                }
                ih += `</div>${baselineProgressHtml}`;
                safeSetHTML("forensic-rationale-target", ih);
            }
        }

        // VMware Discovery Logic
        var vmBadge = document.getElementById("vmware-discovery-badge");
        var vmTag = document.getElementById("vmware-tag-container");
        if (netSrc && (netSrc.virtual === "Yes" || netSrc.virtual === true || (netSrc.description && netSrc.description.toLowerCase().includes("vmware")))) {
            if (vmBadge) vmBadge.style.display = "block";
            if (vmTag) vmTag.style.display = "inline";
        } else {
            if (vmBadge) vmBadge.style.display = "none";
            if (vmTag) vmTag.style.display = "none";
        }

        // OS Tuning Status
        if (data.sysview && data.sysview.osVisuals) {
            var v = data.sysview.osVisuals;
            var tEl = document.getElementById("os-transparency-val");
            var aEl = document.getElementById("os-animations-val");
            var sTag = document.getElementById("ui-tuning-status");
            var tuneBtn = document.querySelector('button[onclick="tuneOSPerformance()"]');

            if (tEl) {
                tEl.textContent = v.transparency;
                tEl.style.color = v.transparency === "Enabled" ? "var(--accent-blue)" : "var(--accent-green)";
            }
            if (aEl) {
                aEl.textContent = v.animations;
                aEl.style.color = v.animations === "Enabled" ? "var(--accent-blue)" : "var(--accent-green)";
            }

            if (v.transparency === "Disabled" && v.animations === "Disabled") {
                if (sTag) {
                    sTag.textContent = "OPTIMIZED";
                    sTag.className = "status-neon-green";
                }
                if (tuneBtn) tuneBtn.textContent = "REVERT VISUALS";
            } else {
                if (sTag) {
                    sTag.textContent = "SUB-OPTIMAL";
                    sTag.className = "status-accent-red";
                }
                if (tuneBtn) tuneBtn.textContent = "OPTIMIZE VISUALS";
            }
        }


        // M365 Desktop Telemetry (Direct List & Versions)
        if (data.m365 && data.m365.apps) {
            var m365Tgt = document.getElementById("m365-apps-target");
            if (m365Tgt) {
                var mH = "";
                for (var app of data.m365.apps) {
                    var clr = app.active ? (app.color || "var(--accent-blue)") : "var(--text-dim)";
                    var opac = app.active ? "1" : "0.4";
                    var addInArr = app.addinList ? app.addinList.split(', ') : [];
                    var addInH = "";
                    if (addInArr.length > 0) {
                        addInH = `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:5px;">`;
                        for (var a of addInArr) {
                            addInH += `<span style="background:var(--panel-inner-bg); color:var(--accent-blue); padding:2px 6px; border-radius:3px; font-size:0.75rem; border:1px solid var(--border-light);">${a}</span>`;
                        }
                        addInH += `</div>`;
                    } else {
                        addInH = '<div style="opacity:0.4; font-size:0.75rem; margin-top:4px;">No active add-ins detected</div>';
                    }

                    mH += `<div style="background:var(--bg-overlay); padding:10px; border-radius:10px; border:1px solid var(--border-light); margin-bottom:10px; opacity:${opac};">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; border-bottom:1px solid var(--border-light); padding-bottom:5px;">
                            <div style="min-width:0; flex:1;">
                                <div style="font-size:0.85rem; font-weight:800; color:${clr}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${app.name} <span style="font-size:0.7rem; opacity:0.4; font-weight:normal;">[${app.version || '...'}]</span></div>
                                <div style="font-size:0.7rem; opacity:0.6; font-family:monospace;">PID: ${app.pid || '--'} | Threads: ${app.threads || 0}</div>
                            </div>
                            <div style="font-size:0.85rem; color:var(--text-main); font-weight:700; text-align:right;">
                                ${Math.round(app.ram)}MB | ${Number(app.cpu).toFixed(1)}%
                            </div>
                        </div>
                        <div style="font-size:0.75rem; line-height:1.2;">
                            <span style="color:var(--accent-blue); font-weight:900; text-transform:uppercase; font-size:0.7rem; letter-spacing:0.5px;">Forensic Add-in Audit:</span>
                            ${addInH}
                        </div>
                    </div>`;
                }
                m365Tgt.innerHTML = mH || '<div style="opacity:0.3; text-align:center; padding-top:15px;">No apps detected</div>';
            }
        }

        // Peripherals & Display Topography
        if (data.topography) {
            var disTgt = document.getElementById("topo-displays-target");
            if (disTgt && data.topography.displays) {
                var dh = "";
                for (var d of data.topography.displays) {
                    dh += `<div style="display:flex; justify-content:space-between; font-size:0.75rem; margin-bottom:3px;">
                        <span style="color:var(--text-dim); text-overflow:ellipsis; overflow:hidden; padding-right:10px;">${d.name}</span>
                        <span style="color:var(--accent-blue); font-weight:700; white-space:nowrap;">${d.res}</span>
                    </div>`;
                }
                disTgt.innerHTML = dh;
            }
            var usbTgt = document.getElementById("topo-usb-target");
            if (usbTgt && data.topography.usb) {
                var uh = "";
                for (var u of data.topography.usb) {
                    var uColor = u.optimal ? "var(--accent-green)" : "var(--accent-red)";
                    var speedLabel = u.speed ? `<span style="color:${uColor}; font-size:0.7rem; opacity:0.8; font-weight:700;">${u.speed}</span>` : "";
                    var optimalityLine = u.optimal ? "" : `<div style="font-size:0.7rem; color:var(--accent-red); margin-top:2px; font-weight:700;">[PROTOCOL MISMATCH]</div>`;
                    var vidPidLine = (u.vid || u.pid) ? `<div style="font-size:0.7rem; color:#00d2ff; font-family:monospace; margin-top:2px; opacity:0.6;">VID:${u.vid} PID:${u.pid}</div>` : "";

                    uh += `<div style="font-size:0.85rem; display:flex; justify-content:space-between; margin-bottom:8px; border-bottom:1px solid var(--border-light); padding-bottom:5px;" title="${u.name} - ${u.speed}">
                        <div style="min-width:0; flex:1; padding-right:10px;">
                            <div style="color:${uColor}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">${u.name}</div>
                            ${optimalityLine}
                            ${vidPidLine}
                        </div>
                        <div style="text-align:right;">
                            <div style="opacity:0.6; font-size:0.7rem; text-transform:uppercase;">${u.type}</div>
                            ${speedLabel}
                        </div>
                    </div>`;
                }
                safeSetHTML("topo-usb-target", uh || '<div style="opacity:0.2; text-align:center;">Empty Bus</div>');
            }
        }

        // 3. Process & Thread Surveillance Logic
        if (data.procs && Array.isArray(data.procs)) {
            safeSetText("proc-count-badge", data.procs.length + " PIDS");

            // CPU Top 3 (on Graphics Card)
            var cpuSorted = [].concat(data.procs).sort((a, b) => (Number(b.totalCpu) || Number(b.cpu) || 0) - (Number(a.totalCpu) || Number(a.cpu) || 0));
            var cpuH = "";
            for (var i = 0; i < Math.min(3, cpuSorted.length); i++) {
                var cVal = Number(cpuSorted[i].cpu || 0).toFixed(1);
                var pName = cpuSorted[i].name || 'Unknown';
                cpuH += `<div class="mini-consumer-item" style="display:flex; justify-content:space-between; font-size:0.8rem; padding:2px 0;"><span>${pName}</span><span style="color:var(--accent-blue); font-weight:bold;">${cVal}%</span></div>`;
            }
            var cpuEl = document.getElementById("gpu-top-3");
            safeSetHTML("gpu-top-3", cpuH);

            // Main List (Process Surveillance Card)
            var html = "";
            var displayProcs = cpuSorted.slice(0, 6);
            for (var p of displayProcs) {
                var pCpu = Number(p.cpu || 0);
                var pRam = Number(p.ram || 0);
                var pPid = p.pid || "--";
                var barColor = pCpu > 50 ? 'var(--accent-red)' : (pCpu > 20 ? '#ffcc00' : 'var(--accent-blue)');

                html += `<div style="margin-bottom:12px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-weight:700;">
                        <span style="color:var(--text-main); font-size:0.85rem;">${p.name || 'Unknown'}</span>
                        <span style="color:${barColor}; font-family:monospace; font-size:0.85rem;">${pCpu.toFixed(1)}%</span>
                    </div>
                    <div class="bar-bg-stripe" style="height:6px; background:var(--border-light); margin-top:4px; border-radius:3px; overflow:hidden;">
                        <div class="bar-fill-stripe" style="width:${Math.min(pCpu, 100)}%; height:100%; background:${barColor}; transition: width 0.3s ease;"></div>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:0.75rem; opacity:0.6; margin-top:6px; font-family:monospace;">
                        <span>PID:${pPid}</span>
                        <span style="color:var(--accent-green); font-weight:700;">${pRam.toFixed(0)}MB</span>
                    </div>
                </div>`;
            }
            var pTarget = document.getElementById("top-procs-list");
            safeSetHTML("top-procs-list", html);
        }

        // 4. Threads & Zombies Monitoring
        var threadTarget = document.getElementById("thread-grid-target");
        if (threadTarget && data.threads) {
            var tHtml = "";
            var sortedThreads = data.threads || [];
            var now = Date.now();

            for (var i = 0; i < Math.min(10, sortedThreads.length); i++) {
                var t = sortedThreads[i];
                var tKey = t.pid.toString() + "-" + (t.name || 'proc');
                
                // Track first-seen timestamp
                if (!threadHistory[tKey]) {
                    threadHistory[tKey] = now;
                }
                
                var isNew = (now - threadHistory[tKey]) < 5000; // Tag as NEW if seen in last 5 seconds
                var newTag = isNew ? '<span style="font-size:0.55rem; background:var(--accent-blue); color:white; padding:1px 4px; border-radius:3px; margin-left:5px; font-weight:900; animation: pulse-blue 1s infinite;">NEW</span>' : '';

                var prevTh = lastThreadCounts[tKey] || t.th;
                var thDelta = t.th - prevTh;
                var deltaUI = thDelta > 0 ? `<span style="color:var(--accent-red); font-weight:800;">▲${thDelta}</span>` : (thDelta < 0 ? `<span style="color:var(--accent-green); font-weight:800;">▼${Math.abs(thDelta)}</span>` : '<span style="opacity:0.2;">-</span>');
                
                // Entrance animation for new rows
                var rowStyle = isNew ? 'animation: slideInRight 0.4s ease-out;' : '';
                
                lastThreadCounts[tKey] = t.th;

                tHtml += `<div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.03); ${rowStyle}">
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; font-weight:600;">
                        ${t.name} <span style="opacity:0.4; font-size:0.75rem;">${t.pid}</span>${newTag}
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:0.7rem; color:var(--text-dim); opacity:0.6; min-width:20px; text-align:right;">${prevTh}</span>
                        <span style="font-size:0.6rem; color:var(--text-dim); opacity:0.4;">→</span>
                        <span style="font-weight:800; color:${t.th > 100 ? 'var(--accent-red)' : 'var(--text-main)'}; min-width:20px; text-align:right;">${t.th}</span>
                        <span style="font-size:0.75rem; min-width:30px; text-align:right;">${deltaUI}</span>
                    </div>
                </div>`;
            }
            safeSetHTML("thread-grid-target", tHtml);
            
            // Cleanup old threadHistory to prevent memory leaks (keep if seen in last minute)
            var tenMinutesAgo = now - 600000;
            for (var key in threadHistory) {
                if (threadHistory[key] < tenMinutesAgo) delete threadHistory[key];
            }
        }

        var zSidebar = document.getElementById("zombie-monitor-sidebar");
        if (zSidebar) {
            if (data.risk && data.risk.zombieList && data.risk.zombies > 0) {
                var zsHtml = "";
                for (var zp of data.risk.zombieList) {
                    zsHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,55,95,0.1); padding:8px; border-radius:6px; margin-bottom:6px;">
                        <div>
                            <div style="color:var(--accent-red); font-weight:800; font-size:0.85rem;">${zp.name}</div>
                            <div style="opacity:0.5; font-size:0.75rem;">LEAK DETECTED</div>
                        </div>
                        <button onclick="confirmPurge(${zp.pid}, '${zp.name}')" style="background:var(--accent-red); color:white; border:none; border-radius:4px; font-size:0.75rem; padding:4px 10px; cursor:pointer;">TERMINATE</button>
                    </div>`;
                }
                safeSetHTML("zombie-monitor-sidebar", zsHtml);
            } else {
                safeSetHTML("zombie-monitor-sidebar", '<div style="opacity:0.3; text-align:center; padding:15px; font-size:0.8rem;">NO ZOMBIE PROCESSES</div>');
            }
        }

        // 5. System Events Surveillance
        var evtTarget = document.getElementById("event-log-target");
        if (evtTarget && data.events) {
            var eHtml = "";
            var evs = (data.events || []).slice(0, 5);
            for (var ev of evs) {
                var borderClr = ev.type === "critical" ? "var(--accent-red)" : "#ffcc00";
                eHtml += `<div style="background:rgba(255,255,255,0.02); padding:10px; border-left:4px solid ${borderClr}; border-radius:6px; margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; font-size:0.75rem; opacity:0.6;"><span>${ev.time}</span><span>ID ${ev.id}</span></div>
                    <div style="font-size:0.85rem; font-weight:700; color:var(--text-main); margin-top:4px;">${ev.src}</div>
                    <div style="font-size:0.8rem; color:var(--text-dim); line-height:1.4; margin-top:2px;">${ev.msg}</div>
                </div>`;
            }
            safeSetHTML("event-log-target", eHtml || '<div style="opacity:0.3; text-align:center; padding-top:40px; font-size:0.85rem;">CLEAN EVENT LOG</div>');
        }

    } catch (e) {
        // SES Safe: No console.error
        var errBox = document.getElementById("top-procs-list");
        if (errBox) errBox.innerHTML = '<div style="color:var(--accent-red); background:rgba(255,0,0,0.1); padding:10px;">RENDERING ERROR: ' + e.message + '</div>';
    }
}

const protectedProcs = ["svchost", "winlogon", "csrss", "System", "Idle", "smss", "services", "lsass", "explorer", "dwm", "spoolsv", "Memory Compression", "Registry", "wininit", "fontdrvhost", "audiodg", "dasHost", "sihost", "taskhostw", "searchindexer", "runtimebroker", "shellexperiencehost"];

function confirmPurge(pid, name) {
    pendingPurgePid = pid;
    var modal = document.getElementById("purge-modal");
    if (modal) {
        document.getElementById("purge-target-name").textContent = name;
        document.getElementById("purge-target-pid").textContent = "PID " + pid;
        
        var isProtected = protectedProcs.includes(name.toLowerCase());
        var btn = modal.querySelector('button[onclick="executePurge()"]');
        var warnText = modal.querySelector('p');
        
        if (isProtected) {
            if (btn) {
                btn.disabled = true;
                btn.style.opacity = "0.3";
                btn.style.cursor = "not-allowed";
                btn.textContent = "SYSTEM PROTECTED";
            }
            if (warnText) {
                warnText.innerHTML = `<span style="color:var(--accent-red); font-weight:900;">⚠️ CRITICAL SYSTEM PROCESS PROTECTION</span><br><br>The process <b>${name}</b> is essential for Windows stability and cannot be terminated.`;
            }
        } else {
            if (btn) {
                btn.disabled = false;
                btn.style.opacity = "1";
                btn.style.cursor = "pointer";
                btn.textContent = "TERMINATE NOW";
            }
            if (warnText) {
                warnText.innerHTML = `You are about to force-terminate <b id="purge-target-name" style="color:var(--text-main);">${name}</b> (<span id="purge-target-pid" style="color:var(--accent-blue);">PID ${pid}</span>). This action is irreversible and may cause unsaved data loss.`;
            }
        }
        
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
            var evtTarget = document.getElementById("event-log-target");
            if (evtTarget) {
                var color = txt === "OK" ? "var(--accent-blue)" : "var(--accent-red)";
                var msg = txt === "OK" ? "TERMINATION COMMAND SENT FOR PID " + pid : "PURGE FAILED: " + txt;

                // UX: Explicit Alert for Blocked Actions
                if (txt.indexOf("BLOCKED") !== -1) {
                    alert("⛔ SYSTEM SAFETY TRIGGER\n\n" + txt + "\n\nThis process is protected to prevent system instability.");
                }

                evtTarget.insertAdjacentHTML('afterbegin', `< div class="event-item" style = "background:var(--bg-card); padding:8px; border-radius:6px; border-left:3px solid ${color}; margin-bottom:10px; animation: pulse-blue 1s;" >
                    <div style="font-size:0.65rem; font-weight:700; color:var(--text-main);">SYSTEM COMMAND</div>
                    <div style="font-size:0.6rem; color:rgba(var(--text-rgb),0.7);">${msg}</div>
                </div > `);
            }
        });
}

async function generateReport() {
    var btn = document.getElementById("report-btn");
    if (btn) {
        btn.textContent = "COLLECTING...";
        btn.style.borderColor = "#ffcc00";
        btn.style.color = "#ffcc00";
    }

    try {
        // Fetch full history from engine
        const histResponse = await fetch("/api/history");
        if (!histResponse.ok) {
            const errBody = await histResponse.text();
            throw new Error(`Server Response Error (${histResponse.status}): ${errBody}`);
        }
        const histData = await histResponse.json();

        if (histData && histData.Metrics && histData.Metrics.length > 0) {
            // Attach AI Persistent Logs for the report
            histData.aiLogs = window.HeuristicsEngine ? window.HeuristicsEngine.getPersistentLogs() : [];

            // Save to IndexedDB for report.html to consume
            await window.reportStorage.saveReport(JSON.stringify(histData));

            if (btn) {
                btn.textContent = "OPENING REPORT...";
                btn.style.borderColor = "var(--accent-green)";
                btn.style.color = "var(--accent-green)";
            }

            // Also trigger a physical save on server as fallback/archive
            fetch("/api/save-report");

            window.open("report.html", "_blank");

            setTimeout(() => {
                btn.textContent = "GENERATE FORENSIC EXPORT";
                btn.style.borderColor = "var(--accent-blue)";
                btn.style.color = "var(--accent-blue)";
            }, 3000);
        } else {
            if (btn) {
                btn.textContent = "NO DATA RECORDED";
                btn.style.borderColor = "var(--accent-red)";
                btn.style.color = "var(--accent-red)";
                setTimeout(() => {
                    btn.textContent = "GENERATE FORENSIC EXPORT";
                    btn.style.borderColor = "var(--accent-blue)";
                    btn.style.color = "var(--accent-blue)";
                }, 3000);
            }
        }
    } catch (e) {
        console.error("Report Generation Error:", e);
        if (btn) {
            btn.textContent = "EXPORT ERROR";
            btn.style.borderColor = "var(--accent-red)";
            btn.style.color = "var(--accent-red)";
            setTimeout(() => {
                btn.textContent = "GENERATE FORENSIC EXPORT";
                btn.style.borderColor = "var(--accent-blue)";
                btn.style.color = "var(--accent-blue)";
            }, 3000);
        }
    }
}

async function handleReportFile(input) {
    if (input.files && input.files[0]) {
        var file = input.files[0];
        var reader = new FileReader();
        reader.onload = async function (e) {
            var content = e.target.result;
            try {
                // Validate if it's JSON
                var test = JSON.parse(content);
                if (!test.Metrics) throw new Error("Missing Metrics payload");

                await window.reportStorage.saveReport(content);
                window.open("report.html", "_blank");
            } catch (err) {
                alert("FAILED TO PARSE REPORT: " + err.message);
            }
        };
        reader.readAsText(file);
    }
}

async function loop() {
    if (activeReq) return;
    activeReq = true;
    var startT = performance.now();
    try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        data.loopTime = Math.round(performance.now() - startT);

        // Only dismiss loading once we have computed data
        var isReady = data &&
            data.status !== "initializing" &&
            (data.sys && data.sys.os);

        if (isReady && !loadingDismissed) {
            // Add a small artificial buffer to let the UI settle
            setTimeout(dismissLoadingOverlay, 800);
        } else if (!loadingDismissed) {
            // Still initializing — update the loading status text
            var lStatus = document.getElementById("loading-status");
            if (lStatus) lStatus.textContent = "Computing forensic telemetry data...";
        }

        updateFrame(data);
    } catch (e) {
        // Backend not yet ready
        var status = document.getElementById("loading-status");
        if (status && !loadingDismissed) status.textContent = "Waiting for engine...";
    } finally {
        activeReq = false;
    }
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
    engine: {
        title: "ENGINE EXECUTION PERSISTENCE",
        text: "Tracks the core TraderSynth data collection engine's lifespan and CPU/RAM overhead. Advanced persistence monitoring ensures the telemetry engine itself operates with < 1% impact on deterministic application cycles."
    },
    risk: {
        title: "PROACTIVE AI HEURISTICS & CALIBRATION",
        text: "Performs real-time mathematical assessment of all telemetry. The module uses a 60-second 'Golden Score' calibration phase to establish system-specific baselines before engaging 2-sigma deviation detection across Compute, Memory, Graphics, and Engine metrics."
    },
    browserBreakdown: {
        title: "BROWSER RESOURCE ARCHITECTURE",
        text: "Deconstructs Chrome and Edge process trees into functional categories (Tabs, GPU, Extensions, Background Services). This forensic view identifies if a specific trading tab or a rogue extension is silting up the workstation's kernel handles or exhausting physical memory.",
    },
    browserMonitor: {
        title: "BROWSER TELEMETRY MONITOR",
        text: "Real-time auditing of Chromium-based browser memory architecture. <b>Working Set</b> represents the physical RAM currently mapped to a process, while <b>Private Bytes</b> is unique to that process and cannot be shared. <br><br>Elevated private memory in 'Tab' processes often indicates memory leaks in complex web applications. The <b>Shared/Cached</b> metric identifies memory optimized by the OS through page-sharing and file-backed caching."
    },
    intelligence: {
        title: "FORENSIC INTELLIGENCE INSIGHTS",
        text: "An active heuristic layer that evaluates real-time OS telemetry to identify root-causes for application stutter, UI starvation, or market data jitter. <br><br><span style='color:var(--accent-blue); font-weight:700;'>BASELINE CALIBRATION</span><br>The system establishes a unique performance baseline during the initial 60-second 'Golden Score' phase. It calculates the statistical mean and variance (standard deviation) for Compute, Memory, and Graphics metrics tailored specifically to your workstation's hardware capability.<br><br><span style='color:var(--accent-green); font-weight:700;'>DEVIATION DETECTION</span><br>Alerts signify a <b>2-sigma deviation</b> from your established baseline. This tells you that current performance is statistically abnormal, identifying hardware or background software interference that typical threshold-based monitors would overlook."
    },
    cpu: {
        title: "PROCESSOR & LATENCY DYNAMICS",
        text: "Low-latency trading requires deterministic thread scheduling. We monitor Interrupts/sec and DPC (Deferred Procedure Call) time to identify driver-level micro-stutters. High System Calls/sec indicates OS overhead that can cause 'slippage' in high-frequency order execution."
    },
    mem: {
        title: "MEMORY DETERMINISM & PRESSURE",
        text: "Traders require rapid access to the entire working set without page-faulting. We monitor <b>Commit Charge</b> and <b>Page Swaps/sec</b>. Persistent hardware faults indicate disk-swapping (paging), which introduces millisecond-level latencies fatal to visual ticker fidelity."
    },
    disk: {
        title: "STORAGE I/O DETERMINISM",
        text: "Logs and trace capturing must not block the main processing thread. We monitor Queue Depth and IOPS. A queue depth > 1 indicates storage saturation, which can backpressure the entire telemetry engine and delay real-time alerts."
    },
    gpu: {
        title: "GRAPHICS RENDERING JITTER",
        text: "Measures the delta between backend polling and frontend rendering. Professional desktops target < 16ms (60FPS). High jitter (>100ms) indicates scheduling saturation or thermal throttling, leading to 'stale' visual representation of market data."
    },
    health: {
        title: "TRADER HEALTH SCORE CALCULATION",
        text: "The score represents the real-time 'deterministic stability' of the system. It starts at 100 and is reduced based on: (1) Core CPU load (1 point per 4% load), (2) Memory Pressure (25-point penalty if RAM > 85%), (3) Forensic Hazard Markers (20-point penalty for zombie processes, high kernel latency, or M365 add-in contention). Range: 100-80 (Optimal), 79-60 (Moderate Contention), <60 (Critical Instability)."
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
    vram: {
        title: "NVIDIA VRAM MONITOR",
        text: "Video RAM (VRAM) is the dedicated high-speed memory on your GPU used exclusively for graphics workloads. Unlike system RAM, VRAM is shared across all rendering applications simultaneously.<br><br><span style='color:var(--accent-blue); font-weight:700;'>DATA SOURCE</span><br>This monitor queries <b>nvidia-smi</b> for precise VRAM allocation, GPU core utilization %, and thermal readings. Data refreshes every 2 seconds.<br><br><span style='color:var(--accent-green)'>■ &lt;50% — Nominal</span><br><span style='color:#ffcc00'>■ 50–80% — Elevated</span><br><span style='color:var(--accent-red)'>■ &gt;80% — Critical Risk of VRAM Eviction</span><br><br>VRAM pressure above 80% forces the GPU to evict texture data to system RAM, causing significant graphical stutter in 3D financial platforms and multi-monitor environments."
    },
    citrix: {
        title: "VDI TOPOLOGY & HDX PROTOCOL",
        text: "In Virtual Desktop Infrastructure (VDI) environments, generic OS metrics can be deceptive. This engine identifies Citrix environments via wfshell process discovery, VDA registry markers, and HDX socket listeners (ICA:1494). It monitors round-trip latency and protocol framing to ensure remote rendering does not introduce stale market data paints."
    },
    openfin: {
        title: "OPENFIN RUNTIME STABILITY",
        text: "Financial desktop applications increasingly rely on Chromium-based containers like OpenFin. We monitor individual Renderer threads and the core Runtime Process to detect 'Hot Renderers' (single PIDs pinning CPU cores). High dispersion across cores causes single-thread bottlenecks, restricting complex grid updates.<br><br><b>DETERMINISTIC DIAGNOSTICS:</b> Click the 'Analyze' button next to any renderer process to launch a real-time deep diagnostic canvas, allowing you to trace thread wait-reasons and memory contention without leaving the dashboard."
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
        text: "Identifies the capacity footprint and file complexity within the active user session. Highly bloated user profiles (specifically in roaming/virtual environments) incur significant disk overhead when the Operating System handles profile synchronization sweeps or index searching over vast file structures.<br><br><b>FOLDER ANALYSIS:</b> Click any of the top folder rows (e.g., Downloads, Documents) to securely open the <i>Folder Scope</i> modal. This lists the exact files causing the bloat, helping you execute guided remediation (such as deleting installers or migrating to OneDrive)."
    },
    trace: {
        title: "THREAD DISPATCHER DEEP-TRACE",
        text: "A direct view into isolated kernel threads executing per PID context. Tracking explicit CPU load down to the application's children threads gives granular visibility into exactly which module is deadlocking user interfaces."
    },

    topography: {
        title: 'HARDWARE BUS TOPOGRAPHY',
        text: 'Hardware bus diagnostics for Display (HDMI, DisplayPort, Virtual) and Universal Serial Bus (USB). Identifies suboptimal device connections such as SuperSpeed (USB 3.0) webcams or storage devices operating at High-Speed (USB 2.0) limits, causing I/O rendering jitter or bandwidth starvation.'
    },
    netStack: {
        title: "NETWORK STACK DETERMINISM",
        text: "Low-latency trading requires bypassing generic OS buffering. We monitor high-performance adapter settings: (1) **Jumbo Packets** reduce interrupt overhead for large data streams. (2) **Interrupt Moderation** should be disabled or tuned for 'Extreme' to minimize micro-stutters. (3) **Flow Control** can introduce pause-frame latency and should typically be disabled on a deterministic fabric. (4) **Offloading** ensures the NIC handles checksums, freeing cycles for the trading application."
    },
    health_audit: {
        title: "DETERMINISTIC STABILITY SCORE AUDIT",
        text: "The Holistic Health Score (0-100) measures execution determinism. **100-80 (Nominal):** Kernel cycles are focused on the trading application. **79-60 (Warning):** Background sync (M365, DFS) or visual effects (Transparency) are introducing CPU jitter. **<60 (Critical):** Immediate risk of order-flow micro-stutters due to thread dispersion or memory pressure."
    }
}

function tuneOSPerformance() {
    var modal = document.getElementById("tune-os-modal");
    if (!modal) return;

    var tEl = document.getElementById("os-transparency-val");
    var aEl = document.getElementById("os-animations-val");
    var transparency = tEl ? tEl.textContent : "Enabled";
    var animations = aEl ? aEl.textContent : "Enabled";
    var isOptimized = (transparency === "Disabled" && animations === "Disabled");

    var title = document.getElementById("tune-modal-title");
    var body = document.getElementById("tune-modal-body");
    var confirmBtn = document.getElementById("tune-confirm-btn");
    var tag = document.getElementById("tune-mode-tag");

    if (isOptimized) {
        title.textContent = "RESTORE VISUAL EFFECTS?";
        tag.textContent = "OS RESTORATION";
        confirmBtn.textContent = "RESTORE DEFAULTS";
        confirmBtn.style.background = "var(--accent-green) !important";
        confirmBtn.style.borderColor = "var(--accent-green) !important";
        body.innerHTML = `You have already optimized visual effects.Would you like to restore standard Windows aesthetics ?
            <ul style="margin-top:10px; margin-left:20px; color:var(--text-main);">
                <li>Enable Windows Transparency</li>
                <li>Enable Window Animations</li>
            </ul>
            <div style="margin-top:15px; font-size:0.75rem; color:#ffcc00; font-weight:700;">
                Note: This may slightly increase CPU jitter during rapid trade executions.
            </div>`;
    } else {
        title.textContent = "OPTIMIZE VISUAL EFFECTS?";
        tag.textContent = "SAFETY CHALLENGE";
        confirmBtn.textContent = "CONFIRM OPTIMIZATION";
        confirmBtn.style.background = "var(--accent-blue) !important";
        confirmBtn.style.borderColor = "var(--accent-blue) !important";
        body.innerHTML = `This action will modify high - level OS parameters to reclaim kernel cycles for deterministic trading:
            <ul style="margin-top:10px; margin-left:20px; color:var(--text-main);">
                <li>Disable Windows Transparency (Mica/Acrylic)</li>
                <li>Disable Window Minimize/Maximize Animations</li>
            </ul>
            <div style="margin-top:15px; font-size:0.75rem; color:var(--accent-red); font-weight:700;">
                Note: This improves UI responsiveness under heavy order flow.
            </div>`;
    }

    modal.style.display = "flex";

    confirmBtn.onclick = function () {
        modal.style.display = "none";
        var cmd = isOptimized ? "enable" : "disable";

        // Find the original button in the dashboard to update its state
        var mainBtn = document.querySelector("#os-tuning-card .footer-btn");
        if (!mainBtn) mainBtn = { textContent: "", style: {}, disabled: false }; // fallback

        var originalText = mainBtn.textContent;
        mainBtn.textContent = isOptimized ? "RESTORING..." : "OPTIMIZING...";
        mainBtn.disabled = true;

        fetch("/api/tune_os?mode=" + cmd)
            .then(r => r.text())
            .then(txt => {
                mainBtn.textContent = isOptimized ? "RESTORED" : "OPTIMIZED";
                mainBtn.style.color = "var(--accent-green)";
                setTimeout(() => {
                    mainBtn.textContent = originalText;
                    mainBtn.disabled = false;
                    mainBtn.style.color = "";
                }, 3000);
            })
            .catch(err => {
                mainBtn.textContent = "FAILED";
                mainBtn.style.color = "var(--accent-red)";
                setTimeout(() => {
                    mainBtn.textContent = originalText;
                    mainBtn.disabled = false;
                    mainBtn.style.color = "";
                }, 3000);
            });
    };
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
                var html = '';
                for (var i = 0; i < data.length; i++) {
                    var c = data[i];
                    var col = 'var(--accent-blue)';
                    var icon = '[PKG]';
                    if (c.Type === "Windows Update") { col = 'var(--accent-green)'; icon = '[UPD]'; }
                    else if (c.Type === "BIOS Update") { col = 'var(--accent-red)'; icon = '[SYS]'; }

                    html += '<div style="background:var(--bg-card); padding:10px; border-radius:8px; border-left:3px solid ' + col + ';">' +
                        '<div style="display:flex; justify-content:space-between; margin-bottom:4px;">' +
                            '<span style="font-size:0.65rem; color:' + col + '; font-weight:800;">' + icon + ' ' + c.Type + '</span>' +
                            '<span style="font-size:0.6rem; opacity:0.6; font-family:monospace;">' + c.Date + '</span>' +
                        '</div>' +
                        '<div style="font-size:0.75rem; color:var(--text-main); word-break:break-word;">' + c.Name + '</div>' +
                    '</div>';
                }
                target.innerHTML = html;
            }
        });
}

async function start() {
    initStaticSlots();
    fetchSystemChanges();
    setInterval(fetchSystemChanges, 300000); // refresh every 5 min
    setInterval(loop, 1000);
    startStandaloneClock();
    loop();
}

function showDef(key) {
    // Mapping legacy 'risk' or 'sysChanges' to modern definitions if needed
    if (key === 'risk') key = 'intelligence';
    if (key === 'sysChanges') key = 'intelligence';

    var def = definitions[key];
    if (!def) return;
    var modal = document.getElementById("info-modal");
    var title = document.getElementById("modal-title");
    var body = document.getElementById("modal-body");
    if (!modal || !title || !body) return;
    title.textContent = def.title;
    safeSetHTML("modal-body", def.text);
    modal.style.display = "flex";
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

// ---------------------------------------------------- //
// INTERACTIVE PROCESS DIAGNOSTICS (ON-DEMAND)
// ---------------------------------------------------- //
let activeDiagnosticPid = null;
let diagnosticPollTimer = null;

function analyzeProcess(pid, name) {
    activeDiagnosticPid = pid;

    // Reset UI
    document.getElementById("diag-proc-name").textContent = name || "Unknown";
    document.getElementById("diag-proc-pid").textContent = pid;
    document.getElementById("diag-time").textContent = "--:--:--";
    document.getElementById("diag-mem").textContent = "--";
    document.getElementById("diag-cpu").textContent = "--";
    document.getElementById("diag-threads").textContent = "--";
    document.getElementById("diag-uptime").textContent = "--";
    document.getElementById("diag-thread-list").innerHTML = '<tr><td colspan="4" style="padding:15px; text-align:center; opacity:0.4;">Polling backend for thread states...</td></tr>';
    document.getElementById("diag-alert-pane").style.display = "none";
    document.getElementById("diag-status-tag").textContent = "ANALYZING";
    document.getElementById("diag-status-tag").className = "status-dim";

    // Show Modal
    document.getElementById("diagnose-modal").style.display = "flex";

    // Immediate First Fetch
    fetchDiagnosticData();

    // Start 3-second Polling to avoid jitter
    if (diagnosticPollTimer) clearInterval(diagnosticPollTimer);
    diagnosticPollTimer = setInterval(fetchDiagnosticData, 3000);
}

function closeDiagnosticCanvas() {
    activeDiagnosticPid = null;
    if (diagnosticPollTimer) {
        clearInterval(diagnosticPollTimer);
        diagnosticPollTimer = null;
    }
    document.getElementById("diagnose-modal").style.display = "none";
}

async function fetchDiagnosticData() {
    if (!activeDiagnosticPid) return;

    try {
        const response = await fetch(`/api/diagnose?pid=${activeDiagnosticPid}`);
        const data = await response.json();

        if (data.error) {
            document.getElementById("diag-thread-list").innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:var(--accent-red);">${data.error}</td></tr>`;
            document.getElementById("diag-status-tag").textContent = "ERROR";
            return;
        }

        const now = new Date();
        document.getElementById("diag-time").textContent = now.toLocaleTimeString([], { hour12: false });

        document.getElementById("diag-status-tag").textContent = "LIVE DATA";
        document.getElementById("diag-status-tag").className = "status-neon-green";

        // Metrics
        document.getElementById("diag-mem").textContent = data.memoryMB;
        document.getElementById("diag-cpu").textContent = data.cpuTotal;
        document.getElementById("diag-threads").textContent = data.threads;
        document.getElementById("diag-uptime").textContent = data.uptimeMins;

        // Alerts / Vulnerabilities
        var alerts = [];
        if (data.isZombie) alerts.push("Process identified as ZOMBIE (High memory, low CPU, >5 min active). Consider terminating.");
        if (data.suspiciousCount > 0) alerts.push(data.suspiciousCount + " threads are in suspicious Wait States (LpcReceive, Executive, etc.) indicating deadlocks.");
        if (data.threads > 500) alerts.push("Thread Count (" + data.threads + ") exceeds safe thresholds, causing DPC context-switching overhead.");

        var alertPane = document.getElementById("diag-alert-pane");
        var alertList = document.getElementById("diag-alert-list");
        if (alerts.length > 0) {
            alertPane.style.display = "block";
            var aHtml = "";
            for (var i = 0; i < alerts.length; i++) {
                aHtml += "<li>" + alerts[i] + "</li>";
            }
            alertList.innerHTML = aHtml;
        } else {
            alertPane.style.display = "none";
        }

        // Deep Thread Table
        var tbody = document.getElementById("diag-thread-list");
        if (data.suspiciousThreads && data.suspiciousThreads.length > 0) {
            var tHtml = "";
            for (var j = 0; j < data.suspiciousThreads.length; j++) {
                var t = data.suspiciousThreads[j];
                tHtml += '<tr>' +
                    '<td style="padding:6px 10px; color:var(--text-dim);">' + t.id + '</td>' +
                    '<td style="padding:6px 10px; color:var(--accent-red); font-weight:700;">' + t.state + '</td>' +
                    '<td style="padding:6px 10px; color:var(--text-main);">' + t.reason + '</td>' +
                    '<td style="padding:6px 10px; text-align:right; font-weight:800; color:var(--accent-blue);">' + t.cpu + '</td>' +
                '</tr>';
            }
            tbody.innerHTML = tHtml;
        } else {
            tbody.innerHTML = '<tr><td colspan="4" style="padding:15px; text-align:center; opacity:0.6; color:var(--accent-green);">No suspicious or hung threads detected. Operation normal.</td></tr>';
        }

    } catch (e) {
        document.getElementById("diag-thread-list").innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:var(--accent-red);">Connection lost to local engine</td></tr>`;
    }
}

// ---------------------------------------------------- //
// USER PROFILE EXPLORER (ON-DEMAND)
// ---------------------------------------------------- //
function showProfileFiles(folderName, encodedFiles) {
    document.getElementById("profile-files-title").textContent = folderName + " - LARGEST FILES";
    var tbody = document.getElementById("profile-files-tbody");
    tbody.innerHTML = "";

    try {
        var files = JSON.parse(decodeURIComponent(encodedFiles));
        if (!files || files.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2" style="padding:15px; text-align:center; color:var(--text-dim);">No significant files located in this directory.</td></tr>';
        } else {
            var fHtml = "";
            for (var k = 0; k < files.length; k++) {
                var f = files[k];
                fHtml += '<tr>' +
                    '<td style="padding:8px 12px; color:var(--text-main); font-family:monospace; word-break:break-all;">' + f.name + '</td>' +
                    '<td style="padding:8px 12px; color:var(--accent-blue); text-align:right; font-weight:700;">' + f.sizeMB.toFixed(2) + '</td>' +
                '</tr>';
            }
            tbody.innerHTML = fHtml;
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="2" style="padding:15px; text-align:center; color:var(--accent-red);">Error displaying payload.</td></tr>';
    }

    document.getElementById("profile-files-modal").style.display = "flex";
}

// ---------------------------------------------------- //
// GLOBAL THEME PERSISTENCE (Syncs with report.html)
// ---------------------------------------------------- //
(function () {
    function syncThemeToStorage() {
        const bodyClass = document.body.className;
        // Save focus theme (e.g. 'light-theme') to storage
        if (bodyClass.includes('light-theme')) {
            localStorage.setItem('tradersynth-theme', 'light-theme');
        } else {
            localStorage.setItem('tradersynth-theme', 'dark-theme');
        }
    }

    // Initial sync
    window.addEventListener('DOMContentLoaded', syncThemeToStorage);

    // Mutation observer to catch dynamic theme swaps
    const observer = new MutationObserver(syncThemeToStorage);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();

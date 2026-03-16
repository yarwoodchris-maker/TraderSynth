/**
 * TraderSynth AI Heuristics Engine
 * Performs mathematical analysis on rolling 60-second windows to detect
 * deviations from "Normal" system behavior.
 */

window.HeuristicsEngine = (function () {
    const WINDOW_SIZE = 60; // 60 seconds (1Hz ticks)
    let history = [];
    let alerts = []; // UI rolling alerts (last 60s)
    let persistentLogs = []; // Full history for the report
    let state = 'CALIBRATING';
    let referenceStats = null; // Snapshot of baseline stats
    let ticksSinceLastRefresh = 0;

    // Keys grouped by category
    const METRIC_GROUPS = {
        compute: [
            { label: 'Wait Queue', path: 'cpu.queue' },
            { label: 'Context Switches', path: 'cpu.ctx' },
            { label: 'System Calls', path: 'cpu_deep.syscalls' }
        ],
        memory: [
            { label: 'Memory Commit', path: 'mem_deep.commit' },
            { label: 'Page Faults', path: 'mem_deep.faults' },
            { label: 'Swaps', path: 'mem_deep.peakSwaps' }
        ],
        graphics: [
            { label: 'GPU Usage', path: 'gpu.usage' },
            { label: 'GPU Decode', path: 'gpu.decode' },
            { label: 'VRAM Usage', path: 'gpu.vramMB' }
        ],
        engine: [
            { label: 'Engine CPU', path: 'overhead.engine.cpu' },
            { label: 'OpenFin CPU', path: 'openfin.ecosystemCpu' },
            { label: 'Web Latency', path: 'webhook.latency' },
            { label: 'Disk Latency', path: 'disk.lat' }
        ]
    };

    function getNestedValue(obj, path) {
        return path.split('.').reduce((prev, curr) => (prev ? prev[curr] : null), obj);
    }

    function calculateStats(values) {
        if (!values || values.length === 0) return { mean: 0, stdDev: 0 };
        const valid = values.filter(v => typeof v === 'number' && !isNaN(v));
        if (valid.length === 0) return { mean: 0, stdDev: 0 };
        
        const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
        const squareDiffs = valid.map(v => Math.pow(v - mean, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / valid.length;
        const stdDev = Math.sqrt(avgSquareDiff);
        return { mean, stdDev };
    }

    function recalibrate() {
        const newStats = {};
        Object.keys(METRIC_GROUPS).forEach(group => {
            METRIC_GROUPS[group].forEach(m => {
                const historicalValues = history.map(h => getNestedValue(h, m.path)).filter(v => v !== null);
                newStats[m.label] = calculateStats(historicalValues);
            });
        });
        referenceStats = newStats;
        ticksSinceLastRefresh = 0;
    }

    return {
        processPayload: function (data) {
            if (!data) return null;

            // Add to rolling history
            const tick = JSON.parse(JSON.stringify(data));
            tick.internalTs = Date.now();
            history.push(tick);
            if (history.length > WINDOW_SIZE) history.shift();

            // Prune UI alerts older than 60 seconds
            const now = Date.now();
            alerts = alerts.filter(a => (now - a.internalTs) < 60000);

            if (history.length < WINDOW_SIZE) {
                state = 'CALIBRATING';
                return {
                    status: 'CALIBRATING',
                    progress: Math.floor((history.length / WINDOW_SIZE) * 100),
                    samples: history.length
                };
            }

            // Periodic Recalibration Logic (Every 60s)
            ticksSinceLastRefresh++;
            if (!referenceStats || ticksSinceLastRefresh >= WINDOW_SIZE) {
                recalibrate();
            }

            state = 'ACTIVE';
            const groupedFindings = { compute: [], memory: [], graphics: [], engine: [] };

            Object.keys(METRIC_GROUPS).forEach(group => {
                METRIC_GROUPS[group].forEach(m => {
                    const currentVal = getNestedValue(data, m.path);
                    if (currentVal === null || currentVal === undefined) return;

                    const stats = referenceStats[m.label];
                    if (!stats) return;

                    // 2-Sigma Deviation against SNAPSHOT baseline
                    const threshold = stats.mean + (2 * stats.stdDev);

                    // Only alert if currentVal exceeds threshold AND shows meaningful rise (>15% above mean)
                    if (currentVal > threshold && (currentVal - stats.mean) > (stats.mean * 0.15)) {
                        const finding = {
                            metric: m.label,
                            current: currentVal.toFixed(2),
                            baseline: stats.mean.toFixed(2),
                            deviation: "+" + (((currentVal / stats.mean) - 1) * 100).toFixed(1) + '%'
                        };
                        groupedFindings[group].push(finding);

                        // Alert logic
                        const ts = new Date().toLocaleTimeString();
                        const msg = `[${ts}] DEVIATION: ${m.label} is ${finding.deviation} above baseline (${finding.current} vs avg ${finding.baseline})`;

                        // Add to UI rolling alerts
                        if (!alerts.some(a => a.msg === msg)) {
                            const alertObj = { ts, msg, group, id: now + Math.random(), internalTs: now };
                            alerts.unshift(alertObj);
                            // Add to Persistent Report logs
                            persistentLogs.unshift(alertObj);
                        }
                    }
                });
            });

            const hasFindings = Object.values(groupedFindings).some(g => g.length > 0);

            // Generate rolling 60s history for all metrics (Actual vs Baseline)
            const metricHistory = {};
            Object.keys(METRIC_GROUPS).forEach(group => {
                METRIC_GROUPS[group].forEach(m => {
                    const historicalValues = history.map(h => {
                        const val = getNestedValue(h, m.path);
                        return (val !== null && val !== undefined) ? val : 0;
                    });

                    const stats = referenceStats[m.label] || { mean: 0 };
                    metricHistory[m.label] = {
                        actual: historicalValues,
                        baseline: stats.mean
                    };
                });
            });

            return {
                status: hasFindings ? 'ANOMALY' : 'OPTIMAL',
                groupedFindings: groupedFindings,
                metricHistory: metricHistory,
                alerts: alerts,
                samples: history.length,
                refreshProgress: Math.floor((ticksSinceLastRefresh / WINDOW_SIZE) * 100)
            };
        },

        getPersistentLogs: () => persistentLogs,
        getState: () => state
    };
})();

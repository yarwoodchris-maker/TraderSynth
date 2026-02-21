# TraderSynth

**TraderSynth** is an advanced, PowerShell-based synthetic testing and telemetry suite built specifically for high-performance trader desktops and Virtual Desktop Infrastructure (VDI) environments. It provides deep, real-time forensic analysis of system health, identifying micro-stutters, scheduler contention, and protocol latency that can impact high-frequency trading workflows.

## Features

TraderSynth monitors the entire desktop stack, from the host kernel up to the application rendering layers, providing a professional, glassmorphism-styled local web dashboard for real-time observation.

* **Core Telemetry & Processor Dynamics**: Deep inspection of CPU usage, context switches, thread queues, and DPC latency to identify scheduling saturation.
* **Storage I/O Determinism**: Tracks queue depth and physical disk IOPS to detect storage bottlenecks impacting real-time trade execution.
* **Graphics & Encode/Decode Pipeline**: Granular GPU analysis breaking down 3D usage vs. encode/decode hardware utilization.
* **OpenFin & Chromium Deep Inspection**: Surveillance of OpenFin Run Time Engines (RVM), renderer thread dispersion, memory pressure, and "zombie" process detection.
* **VDI Protocol Integration**: Native integration with Citrix HDX performance counters (ICA latency, Output FPS, Input Delay) and a fallback generic network stack inspector.
* **VMware Hypervisor Stats**: Captures VM CPU Ready Time, Memory Ballooning, and Co-Stop Time to alert on host-layer contention.
* **Environmental History**: A built-in "System Changes" module tracking recent Application Installs, Windows Updates, and BIOS upgrades in the last 5 days.

## Installation & Usage

1. **Clone the repository:**
   ```powershell
   git clone https://github.com/yarwoodchris-maker/TraderSynth.git
   cd TraderSynth
   ```

2. **Run the Engine:**
   Launch the PowerShell script with Administrator privileges (required for deep CIM/WMI metric collection and Citrix/VMware counter access).
   ```powershell
   .\Start-TraderSynth.ps1
   ```

3. **Access the Dashboard:**
   The script will automatically instantiate a local web server (defaults to port 9000) and launch your default browser to `http://localhost:9000`. 

## Architecture

TraderSynth consists of two main tiers:
1. **The PowerShell Engine (`Start-TraderSynth.ps1`)**: Runs a highly optimized loop utilizing strictly non-blocking CIM calls, caching mechanisms, and localized fallback algorithms. It spins up an asynchronous runspace and a self-hosted `System.Net.HttpListener` to act as an offline REST API.
2. **The Front-End (`www/`)**: A pure vanilla HTML/JS/CSS application utilizing sophisticated `Chart.js`-style vanilla canvas implementations for extreme low-latency metric rendering. It queries the local PowerShell engine via asynchronous fetches to update the DOM without causing memory leaks or UI thread blocking.

## Reporting

The tool includes a feature to generate comprehensive, point-in-time JSON forensic reports. These reports capture the aggregate bounds of all captured telemetry during a session and can be reloaded directly into the UI at a later time for post-incident analysis.

## Security & Privacy 

TraderSynth operates completely locally and offline. No telemetry data, system state, or analysis results are transmitted externally. The web server listens exclusively on `localhost`.

---

*This tool requires Windows PowerShell 5.1+ or PowerShell 7+ on a Windows OS.*

using System.Net;
using System.Text.Json;
using System.Diagnostics;
using DataDesk.Engine.Services;
using DataDesk.Engine.Models;

namespace DataDesk.Engine;

class Program
{
    private static readonly TelemetryCache _cache = new();
    private static SystemMetricProvider? _metrics;
    private static ProcessForensicProvider? _forensics;

    static async Task Main(string[] args)
    {
        Console.WriteLine("--- DataDesk Engine V5 [Zero-Dependency Mode] ---");
        
        // 1. Initialize Providers
        _metrics = new SystemMetricProvider();
        _forensics = new ProcessForensicProvider();

        // 2. Start Background Collector
        var cts = new CancellationTokenSource();
        var worker = new TelemetryWorker(_metrics, _forensics, _cache);
        _ = Task.Run(() => worker.StartAsync(cts.Token));

        // 3. Start Native HTTP Listener with Dynamic Port Negotiation
        int port = 9014;
        bool started = false;
        HttpListener? listener = null;

        while (!started && port < 9100)
        {
            listener = new HttpListener();
            try
            {
                listener.Prefixes.Add($"http://localhost:{port}/");
                listener.Start();
                started = true;
                Console.WriteLine($"[*] Listening on http://localhost:{port}/");
            }
            catch (HttpListenerException ex) when (ex.ErrorCode == 32 || ex.ErrorCode == 183)
            {
                Console.WriteLine($"[!] Port {port} in use, trying next...");
                listener.Close();
                port++;
            }
        }

        if (!started || listener == null)
        {
            Console.WriteLine("[!] Could not find an available port. Exiting.");
            return;
        }

        // 4. Auto-Launch Browser
        string url = $"http://localhost:{port}/";
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[!] Could not auto-launch browser: {ex.Message}");
        }

        while (true)
        {
            var context = await listener.GetContextAsync();
            _ = Task.Run(() => HandleRequest(context));
        }
    }

    private static void HandleRequest(HttpListenerContext context)
    {
        var response = context.Response;
        string path = context.Request.Url?.AbsolutePath ?? "/";
        if (path == "/") path = "/index.html";

        string safePath = path.TrimStart('/').Replace("/", Path.DirectorySeparatorChar.ToString());
        string filePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, safePath);

        try
        {
            if (path == "/api/stats")
            {
                var data = _cache.Latest ?? new TelemetryPayload { Status = "initializing" };
                string json = JsonSerializer.Serialize(data);
                byte[] buffer = System.Text.Encoding.UTF8.GetBytes(json);
                
                response.ContentType = "application/json";
                response.ContentLength64 = buffer.Length;
                response.OutputStream.Write(buffer, 0, buffer.Length);
            }
            else if (path == "/api/ping")
            {
                byte[] buffer = System.Text.Encoding.UTF8.GetBytes("{\"status\":\"UP\"}");
                response.OutputStream.Write(buffer, 0, buffer.Length);
            }
            else if (File.Exists(filePath))
            {
                // Serve Static File
                byte[] buffer = File.ReadAllBytes(filePath);
                response.ContentType = GetContentType(path);
                response.ContentLength64 = buffer.Length;
                response.OutputStream.Write(buffer, 0, buffer.Length);
            }
            else
            {
                response.StatusCode = 404;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[!] API Error: {ex.Message}");
            response.StatusCode = 500;
        }
        finally
        {
            response.Close();
        }
    }

    private static string GetContentType(string path)
    {
        string ext = Path.GetExtension(path).ToLower();
        return ext switch
        {
            ".html" => "text/html",
            ".js" => "application/javascript",
            ".css" => "text/css",
            ".json" => "application/json",
            ".png" => "image/png",
            ".jpg" => "image/jpeg",
            ".svg" => "image/svg+xml",
            _ => "application/octet-stream"
        };
    }
}

public class TelemetryCache
{
    public TelemetryPayload? Latest { get; set; }
}

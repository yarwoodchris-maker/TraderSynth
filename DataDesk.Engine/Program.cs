using DataDesk.Engine;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

// Register the telemetry background service
builder.Services.AddHostedService<TelemetryWorker>();

// Register Windows Service support for enterprise deployment
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "DataDesk Telemetry Engine";
});

var host = builder.Build();
host.Run();

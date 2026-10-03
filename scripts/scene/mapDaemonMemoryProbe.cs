// Validation-only host: executes the selected compiled production daemon unchanged.
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var producer = Path.GetFullPath(args[0]);
var assembly = Assembly.LoadFrom(producer);
var host = assembly.GetType("BridgeDaemonHost", throwOnError: true)!;
var run = host.GetMethod("RunAsync", BindingFlags.Public | BindingFlags.Static)!;
var map = assembly.GetType("MapStaticGeometryService", throwOnError: true)!;
var cacheField = map.GetField("ResourceCache", BindingFlags.NonPublic | BindingFlags.Static)!;
object? observedCache = null;
var watch = Stopwatch.StartNew();
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

void Sample(string stage)
{
    using var process = Process.GetCurrentProcess();
    var attachedCache = cacheField.GetValue(null);
    if (attachedCache is not null) Interlocked.Exchange(ref observedCache, attachedCache);
    var cache = Volatile.Read(ref observedCache);
    // Retain the observed cache object through daemon detach so its actual
    // disposed snapshot can prove release without creating a new cache.
    var snapshot = cache?.GetType().GetMethod("Snapshot", BindingFlags.NonPublic | BindingFlags.Instance);
    Console.Error.WriteLine("[SF_MAP_PROFILE_MEMORY] " + JsonSerializer.Serialize(new
    {
        stage,
        elapsedMs = watch.Elapsed.TotalMilliseconds,
        processId = Environment.ProcessId,
        managedHeapBytes = GC.GetTotalMemory(forceFullCollection: false),
        lastGcHeapBytes = GC.GetGCMemoryInfo().HeapSizeBytes,
        allocatedBytes = GC.GetTotalAllocatedBytes(precise: false),
        rssBytes = process.WorkingSet64,
        gc0 = GC.CollectionCount(0), gc1 = GC.CollectionCount(1), gc2 = GC.CollectionCount(2),
        // Do not create a cache merely by observing startup.
        cacheAttached = attachedCache is not null,
        cache = snapshot?.Invoke(cache, null)
    }, json));
}

Console.Error.WriteLine("[SF_MAP_PROFILE_PRODUCER] " + JsonSerializer.Serialize(new
{
    path = producer,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(producer))).ToLowerInvariant(),
    scope = "Compiled production BridgeDaemonHost in an owned observation process; no Electron or GPU"
}, json));
Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
await using var stdin = Console.OpenStandardInput();
await using var stdout = Console.OpenStandardOutput();
using var reader = new StreamReader(stdin, new UTF8Encoding(false), false, 64 * 1024, true);
await using var writer = new StreamWriter(stdout, new UTF8Encoding(false), 64 * 1024, true)
{ AutoFlush = true, NewLine = "\n" };
await using (var timer = new Timer(_ => Sample("sample"), null, 0, 25))
{
    await (Task)run.Invoke(null, new object[] { reader, writer, CancellationToken.None })!;
}
Sample("daemon-exited");
// This collection occurs after the daemon and timed requests have ended.
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Sample("after-release-collection");

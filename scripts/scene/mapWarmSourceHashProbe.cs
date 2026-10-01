// Validation only: invoke the selected compiled producer, never a copied parser.
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

var dll = Path.GetFullPath(args[0]);
var file = Path.GetFullPath(args[1]);
var procRoot = args.Length > 2 ? Path.GetFullPath(args[2]) : "/proc";
var original = File.ReadAllBytes(file);
var mtime = File.GetLastWriteTimeUtc(file);
var originalHash = Hash(original);
var producerHash = Hash(File.ReadAllBytes(dll));
var assembly = Assembly.LoadFrom(dll);
var type = assembly.GetType("BridgeCommandService", true)!;
var service = Activator.CreateInstance(type, true)!;
var execute = type.GetMethod("ExecuteAsync")!;
var map = assembly.GetType("MapStaticGeometryService", true)!;
var reset = map.GetMethod("Reset", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
var observation = map.GetMethod("ResourceCacheObservation", BindingFlags.NonPublic | BindingFlags.Static)!;
var lookup = map.GetMethod("TryGet", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
var controls = new List<object>();
reset.Invoke(null, null);

string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
JsonNode Cache() => JsonSerializer.SerializeToNode(observation.Invoke(null, null), json)!;
string SessionHash(string token)
{
    var values = new object?[] { token, null };
    Require((bool)lookup.Invoke(null, values)!, "SESSION_MISSING");
    return (string)values[1]!.GetType().GetField("FileHash")!.GetValue(values[1])!;
}
async Task<(JsonNode Data, long Allocated, double Ms)> Read(string token = "", string cursor = "",
    CancellationToken cancellation = default)
{
    var options = JsonSerializer.SerializeToElement(new
        { modelName = "allocationFixture", sessionToken = token, cursor, ownerLeaseId = "warm-hash-negative" });
    var values = execute.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : Type.Missing).ToArray();
    values[0] = "read-map-static-geometry"; values[1] = file; values[2] = cancellation; values[4] = options;
    var before = GC.GetTotalAllocatedBytes(true);
    var watch = Stopwatch.StartNew();
    var task = (Task)execute.Invoke(service, values)!;
    await task;
    var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
    var bytes = JsonSerializer.SerializeToUtf8Bytes(result, result.GetType(), json);
    return (JsonNode.Parse(bytes)!, GC.GetTotalAllocatedBytes(true) - before, watch.Elapsed.TotalMilliseconds);
}
string Geometry(JsonNode result)
{
    var chunks = result["data"]?["chunks"]?.AsArray();
    Require(chunks?.Count == 1, "FIXTURE_MUST_EMIT_ONE_CHUNK");
    var chunk = chunks![0]!;
    Require(chunk["emittedVertexCount"]!.GetValue<int>() == 3 && chunk["emittedIndexCount"]!.GetValue<int>() == 3,
        "FIXTURE_GEOMETRY_COUNTS_WRONG");
    return chunk["positionsBase64"]!.GetValue<string>() + chunk["indicesBase64"]!.GetValue<string>();
}
bool HasCode(JsonNode result, string code) => result["diagnostics"]!.AsArray()
    .Any(n => n!["code"]?.GetValue<string>() == code);

try
{
    var cold = await Read();
    var token = cold.Data["data"]?["sessionToken"]?.GetValue<string>() ?? throw new Exception(cold.Data.ToJsonString());
    var geometry = Geometry(cold.Data);
    var warm = await Read(token);
    Require(Geometry(warm.Data) == geometry, "WARM_GEOMETRY_CHANGED");
    var allocationOk = warm.Allocated < original.Length / 2;
    Console.Error.WriteLine("[SF_MAP_WARM_ALLOCATION] " + JsonSerializer.Serialize(new
        { dllSha256 = Hash(File.ReadAllBytes(dll)), coldAllocated = cold.Allocated,
            warmAllocated = warm.Allocated, sourceBytes = original.Length, allocationOk }, json));

    var changed = (byte[])original.Clone(); changed[^1] ^= 1;
    File.WriteAllBytes(file, changed); File.SetLastWriteTimeUtc(file, mtime);
    Require(HasCode((await Read(token)).Data, "MAP_STATIC_SESSION_EXPIRED"), "SAME_SIZE_MTIME_RESTORE_MUST_EXPIRE");
    controls.Add(new { kind = "same-size-timestamp-restored-mutation", passed = true });
    var reopened = await Read();
    Require(Geometry(reopened.Data) == geometry, "CHANGED_CONTENT_REOPEN_GEOMETRY_WRONG");
    Require(SessionHash(reopened.Data["data"]!["sessionToken"]!.GetValue<string>()) == Hash(changed),
        "REOPENED_SESSION_HASH_NOT_CURRENT_CONTENT");
    controls.Add(new { kind = "content-changed-reopen-current-hash", passed = true });
    File.WriteAllBytes(file, original); File.SetLastWriteTimeUtc(file, mtime);

    var fallback = await Read(new string('f', 32));
    Require(Geometry(fallback.Data) == geometry, "UNKNOWN_SESSION_COLD_FALLBACK_CHANGED");
    Require(SessionHash(fallback.Data["data"]!["sessionToken"]!.GetValue<string>()) == originalHash,
        "COLD_FALLBACK_HASH_NOT_PARSED_BYTES");
    controls.Add(new { kind = "unknown-session-cold-fallback-current-hash", passed = true });
    Require(HasCode((await Read(token, "invalid-cursor")).Data, "MAP_STATIC_CURSOR_INVALID"), "INVALID_CURSOR_NOT_REJECTED");
    controls.Add(new { kind = "invalid-cursor-rejection", passed = true });

    // A pre-cancelled command must not publish geometry or alter the cache.
    var beforeCancel = Cache();
    using (var cancelled = new CancellationTokenSource())
    {
        cancelled.Cancel();
        try { await Read(token, cancellation: cancelled.Token); throw new Exception("PRE_CANCEL_RETURNED_GEOMETRY"); }
        catch (OperationCanceledException) { }
    }
    Require(JsonNode.DeepEquals(beforeCancel, Cache()), "PRE_CANCEL_CHANGED_CACHE");
    controls.Add(new { kind = "pre-cancel-no-geometry-or-cache-publication", passed = true });

    if (OperatingSystem.IsLinux())
    {
        // A sparse enlarged source prolongs hashing without allocating or parsing
        // another large geometry. Observe reads on the command's native thread
        // while the real source descriptor is open (.NET uses positional reads,
        // so Linux fdinfo.pos does not measure its progress).
        // before cancelling, so this proves active hashing rather than queue timing.
        const long extendedLength = 128L * 1024 * 1024;
        using (var extend = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.Read)) extend.SetLength(extendedLength);
        using var cancellation = new CancellationTokenSource();
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var ready = new ManualResetEventSlim();
        using var begin = new ManualResetEventSlim();
        var nativeThreadId = 0;
        var thread = new Thread(() =>
        {
            try
            {
                nativeThreadId = LinuxThread.GetTid(); ready.Set(); begin.Wait();
                Read(token, cancellation: cancellation.Token).GetAwaiter().GetResult(); finished.SetResult();
            }
            catch (Exception error) { finished.SetException(error); }
            finally { ready.Set(); }
        }) { IsBackground = true };
        thread.Start();
        long ReadChars() => long.Parse(File.ReadLines($"{procRoot}/self/task/{nativeThreadId}/io")
            .First(line => line.StartsWith("rchar:"))[6..].Trim());
        var observedReadBytes = 0L;
        try
        {
            Require(ready.Wait(TimeSpan.FromSeconds(5)), "ACTIVE_HASH_THREAD_READINESS_TIMEOUT");
            if (finished.Task.IsFaulted) await finished.Task;
            var initialReadChars = ReadChars();
            begin.Set();
            var deadline = Stopwatch.StartNew();
            while (!finished.Task.IsCompleted && deadline.Elapsed < TimeSpan.FromSeconds(5) && observedReadBytes < 64 * 1024)
            {
                foreach (var fd in Directory.EnumerateFiles($"{procRoot}/self/fd"))
                {
                    try
                    {
                        if (File.ResolveLinkTarget(fd, false)?.FullName != file) continue;
                        observedReadBytes = Math.Max(observedReadBytes, ReadChars() - initialReadChars);
                    }
                    catch (IOException) { /* The command may have just closed its descriptor. */ }
                }
                if (observedReadBytes < 64 * 1024) Thread.Yield();
            }
            cancellation.Cancel();
            try { await finished.Task.WaitAsync(TimeSpan.FromSeconds(5)); throw new Exception("ACTIVE_CANCEL_RETURNED_RESULT"); }
            catch (OperationCanceledException) { }
        }
        finally
        {
            // Release the worker even if setup or /proc observation fails.
            begin.Set(); cancellation.Cancel();
            Require(thread.Join(TimeSpan.FromSeconds(5)), "ACTIVE_HASH_THREAD_RELEASE_TIMEOUT");
        }
        Require(observedReadBytes >= 64 * 1024 && observedReadBytes < extendedLength,
            "ACTIVE_HASH_CANCELLATION_NOT_OBSERVED");
        Require(JsonNode.DeepEquals(beforeCancel, Cache()), "ACTIVE_CANCEL_CHANGED_CACHE");
        Require(SessionHash(token) == originalHash, "ACTIVE_CANCEL_PUBLISHED_PARTIAL_HASH");
        using (var exclusive = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            exclusive.SetLength(original.Length);
        File.SetLastWriteTimeUtc(file, mtime);
        var resumed = await Read(token);
        Require(Geometry(resumed.Data) == geometry && resumed.Allocated < original.Length / 2,
            "ACTIVE_CANCEL_REOPEN_OR_BOUNDED_ALLOCATION_FAILED");
        controls.Add(new { kind = "active-streamed-hash-cancel-no-publication-and-file-release", passed = true,
            observedReadBytes, extendedLength, resumedAllocated = resumed.Allocated });
    }
    else controls.Add(new { kind = "active-streamed-hash-cancel", status = "not_run", reason = "Linux descriptor observation required" });

    reset.Invoke(null, null);
    var released = Cache();
    Require(released["readyBytes"]!.GetValue<long>() == 0 && released["inFlightBytes"]!.GetValue<long>() == 0
        && released["entryCount"]!.GetValue<int>() == 0, "RESOURCE_RELEASE_NOT_EMPTY");
    controls.Add(new { kind = "resource-reset-releases-all-entries", passed = true });
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        passed = allocationOk, dll, dllSha256 = producerHash, sourceSha256 = originalHash,
        sourceBytes = original.Length, coldAllocated = cold.Allocated, warmAllocated = warm.Allocated,
        coldMs = cold.Ms, warmMs = warm.Ms, geometryIdentical = true, allocationLimit = original.Length / 2,
        controls, releaseObservation = released
    }, json));
    Environment.ExitCode = allocationOk ? 0 : 1;
}
finally
{
    File.WriteAllBytes(file, original); File.SetLastWriteTimeUtc(file, mtime);
    reset.Invoke(null, null);
    Require(Hash(File.ReadAllBytes(file)) == originalHash, "OWNED_SOURCE_NOT_RESTORED");
    Require(Hash(File.ReadAllBytes(dll)) == producerHash, "PRODUCER_CHANGED_DURING_FIXTURE");
}

internal static class LinuxThread
{
    [DllImport("libc", EntryPoint = "gettid")]
    internal static extern int GetTid();
}

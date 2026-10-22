using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

var producer = Path.GetFullPath(args[0]);
var source = Path.GetFullPath(args[1]);
var replacement = File.ReadAllBytes(args[2]);
var original = File.ReadAllBytes(source);
var timestamp = File.GetLastWriteTimeUtc(source);
var producerHash = Hash(File.ReadAllBytes(producer));
var assembly = Assembly.LoadFrom(producer);
var command = assembly.GetType("BridgeCommandService", true)!;
var service = Activator.CreateInstance(command, true)!;
var execute = command.GetMethod("ExecuteAsync")!;
var map = assembly.GetType("MapStaticGeometryService", true)!;
var reset = map.GetMethod("Reset", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
var telemetry = assembly.GetType("BridgeTelemetry", true)!;
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
void Require(bool passed, string message) { if (!passed) throw new Exception(message); }
async Task<JsonNode> Read(string token = "")
{
    var values = execute.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : Type.Missing).ToArray();
    values[0] = "read-map-static-geometry"; values[1] = source; values[2] = CancellationToken.None;
    values[4] = JsonSerializer.SerializeToElement(new { modelName = "allocationFixture", sessionToken = token });
    var task = (Task)execute.Invoke(service, values)!; await task;
    var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
    return JsonSerializer.SerializeToNode(result, result.GetType(), json)!;
}
float X(JsonNode result)
{
    var chunks = result["data"]?["chunks"]?.AsArray();
    Require(chunks?.Count == 1, "ONE_NATIVE_CHUNK_REQUIRED:" + result.ToJsonString());
    return BitConverter.ToSingle(Convert.FromBase64String(chunks![0]!["positionsBase64"]!.GetValue<string>()), 12);
}
string FileHash(JsonNode result)
{
    var token = result["data"]!["sessionToken"]!.GetValue<string>();
    var lookup = map.GetMethod("TryGet", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
    var values = new object?[] { token, null };
    Require((bool)lookup.Invoke(null, values)!, "SESSION_MISSING");
    return (string)values[1]!.GetType().GetField("FileHash")!.GetValue(values[1])!;
}
reset.Invoke(null, null);
try
{
    var first = await Read(); Require(X(first) == 1, "ORIGINAL_GEOMETRY_WRONG");
    var originalToken = first["data"]!["sessionToken"]!.GetValue<string>();
    Require(original.Length == replacement.Length, "SAME_SIZE_NEGATIVE_REQUIRED");
    File.WriteAllBytes(source, replacement); File.SetLastWriteTimeUtc(source, timestamp);
    var stale = await Read(originalToken);
    Require(stale["diagnostics"]!.AsArray().Any(d => d!["code"]!.GetValue<string>() == "MAP_STATIC_SESSION_EXPIRED"),
        "OLD_SESSION_ACCEPTED_REPLACEMENT");
    var reopened = await Read();
    Require(FileHash(reopened) == Hash(replacement), "NEW_SESSION_HASH_NOT_CURRENT_SOURCE");
    Require(X(reopened) == 2, "FRESH_HASH_PAIRED_WITH_STALE_COMPRESSED_GEOMETRY");
    long Inflates() => (long)telemetry.GetField("DcxInflateCount", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    var inflatesBeforeFallback = Inflates();
    var fallback = await Read(new string('f', 32));
    Require(X(fallback) == 2 && FileHash(fallback) == Hash(replacement), "UNKNOWN_TOKEN_FALLBACK_NOT_CAPTURED_SOURCE");
    var controls = new List<string> { "same-size/restored-mtime compressed replacement", "old-session expiry",
        "cold reopen binds current geometry/hash", "unknown-token fallback binds captured bytes" };
    if (source.EndsWith(".mapbnd.dcx", StringComparison.Ordinal))
    {
        Require(Inflates() == inflatesBeforeFallback, "BYTE_IDENTICAL_CAPTURE_DID_NOT_REUSE_CONTAINER");
        // Capturing A while the path now contains B must not bless A with B's
        // metadata and leak it to the legacy path-reading adapter.
        var writer = assembly.GetType("Bnd4NativeWriter", true)!;
        var captured = writer.GetMethod("GetBinderFromCapturedBytes")!.Invoke(null, new object?[] { source, original, null })!;
        var capturedDcx = captured.GetType().GetField("Item1")!.GetValue(captured)!;
        Require((string)capturedDcx.GetType().GetProperty("SourceHash")!.GetValue(capturedDcx)! == Hash(original),
            "CAPTURED_ARRAY_REOPENED_CURRENT_PATH");
        var pathResult = writer.GetMethod("GetCachedBinder")!.Invoke(null, new object?[] { source, null })!;
        var pathDcx = pathResult.GetType().GetField("Item1")!.GetValue(pathResult)!;
        Require((string)pathDcx.GetType().GetProperty("SourceHash")!.GetValue(pathDcx)! == Hash(replacement),
            "CAPTURED_ARRAY_POISONED_PATH_METADATA_CACHE");
        controls.Add("byte-identical container reuse"); controls.Add("captured arrays cannot poison path metadata");
    }
    Require(Hash(File.ReadAllBytes(producer)) == producerHash, "PRODUCER_CHANGED");
    Console.WriteLine(JsonSerializer.Serialize(new { passed = true, producerHash,
        originalHash = Hash(original), replacementHash = Hash(replacement), bytes = replacement.Length,
        originalX = X(first), reopenedX = X(reopened), fallbackX = X(fallback),
        container = source.EndsWith(".mapbnd.dcx", StringComparison.Ordinal) ? "DFLT BND4" : "DFLT FLVER",
        controls }, json));
}
finally
{
    File.WriteAllBytes(source, original); File.SetLastWriteTimeUtc(source, timestamp); reset.Invoke(null, null);
}

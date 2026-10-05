using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

var producer = Path.GetFullPath(args[0]);
var source = Path.GetFullPath(args[1]);
var replacement = File.ReadAllBytes(args[2]);
var expectedChild = File.ReadAllBytes(args[3]);
var expectedPayload = File.ReadAllBytes(args[4]);
var expectedName = args[5];
var original = File.ReadAllBytes(source);
var mtime = File.GetLastWriteTimeUtc(source);
var originalHash = Hash(original);
var producerHash = Hash(File.ReadAllBytes(producer));
var assembly = Assembly.LoadFrom(producer);
var type = assembly.GetType("BridgeCommandService", true)!;
var service = Activator.CreateInstance(type, true)!;
var execute = type.GetMethod("ExecuteAsync")!;
var writer = assembly.GetType("Bnd4NativeWriter", true)!;
var invalidate = writer.GetMethod("InvalidateCache")!;
var telemetry = assembly.GetType("BridgeTelemetry", true)!;
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
void Require(bool value, string message) { if (!value) throw new Exception(message); }
long Inflates() => (long)telemetry.GetField("DcxInflateCount", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
async Task<JsonNode> Read(string name, object? options = null, string? output = null)
{
    var values = execute.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : Type.Missing).ToArray();
    values[0] = name; values[1] = source; values[2] = CancellationToken.None;
    values[4] = JsonSerializer.SerializeToElement(options ?? new { }); values[5] = output;
    var task = (Task)execute.Invoke(service, values)!; await task;
    var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
    var node = JsonSerializer.SerializeToNode(result, result.GetType(), json)!;
    Require(node["parseStatus"]!.GetValue<string>() != "failed", node.ToJsonString());
    return node["data"]!;
}
var observations = new List<object>();
try
{
    Require(original.Length == replacement.Length, "SAME_SIZE_NEGATIVE_REQUIRED");
    foreach (var command in new[] { "read-dcx-document", "list-bnd4-entries", "snapshot-bnd4-child", "extract-bnd4-child" })
    {
        invalidate.Invoke(null, new object[] { source });
        File.WriteAllBytes(source, original); File.SetLastWriteTimeUtc(source, mtime);
        var first = await Read("list-bnd4-entries", new { includeContentHashes = true });
        Require(first["sourceHash"]!.GetValue<string>() == originalHash, "ORIGINAL_PHYSICAL_HASH_WRONG");
        var beforeRepeat = Inflates();
        var same = await Read("list-bnd4-entries", new { includeContentHashes = true });
        Require(Inflates() == beforeRepeat && same["sourceHash"]!.GetValue<string>() == originalHash,
            "UNCHANGED_PATH_DID_NOT_REUSE_DECODED_CONTAINER");
        File.WriteAllBytes(source, replacement); File.SetLastWriteTimeUtc(source, mtime);
        var output = Path.Combine(Path.GetDirectoryName(source)!, "extracted.flver");
        var result = await Read(command, new { entryIndex = 0, includePayload = true, includeContentHashes = true,
            expectedChildHash = expectedName == "replacementFixture.flver" ? Hash(expectedChild) : null },
            command == "extract-bnd4-child" ? output : null);
        var observed = result["sourceHash"]!.GetValue<string>();
        var current = observed == Hash(replacement);
        var childOk = command switch
        {
            "list-bnd4-entries" => result["entries"]![0]!["contentHash"]!.GetValue<string>() == Hash(expectedChild),
            "snapshot-bnd4-child" => Convert.FromBase64String(result["contentBase64"]!.GetValue<string>()).AsSpan().SequenceEqual(expectedChild),
            "extract-bnd4-child" => File.ReadAllBytes(output).AsSpan().SequenceEqual(expectedChild),
            _ => result["payloadHash"]!.GetValue<string>() == Hash(expectedPayload)
                && Convert.FromBase64String(result["payloadBase64"]!.GetValue<string>()).AsSpan().SequenceEqual(expectedPayload)
        };
        var observedName = command switch
        {
            "list-bnd4-entries" => result["entries"]![0]!["name"]!.GetValue<string>(),
            "snapshot-bnd4-child" or "extract-bnd4-child" => result["name"]!.GetValue<string>(),
            _ => result["nested"]!["entries"]![0]!["name"]!.GetValue<string>()
        };
        observations.Add(new { command, currentPhysicalHash = current, currentChild = childOk,
            currentMetadata = observedName == expectedName, observedHash = observed, observedName });
    }
    Require(Hash(File.ReadAllBytes(producer)) == producerHash, "PRODUCER_CHANGED");
    var passed = observations.All(row => (bool)row.GetType().GetProperty("currentPhysicalHash")!.GetValue(row)!
        && (bool)row.GetType().GetProperty("currentChild")!.GetValue(row)!
        && (bool)row.GetType().GetProperty("currentMetadata")!.GetValue(row)!);
    Console.WriteLine(JsonSerializer.Serialize(new { passed, producerHash, bytes = original.Length,
        originalHash, replacementHash = Hash(replacement), childHash = Hash(expectedChild), observations }, json));
    Environment.ExitCode = passed ? 0 : 1;
}
finally
{
    File.WriteAllBytes(source, original); File.SetLastWriteTimeUtc(source, mtime);
    invalidate.Invoke(null, new object[] { source });
    Require(Hash(File.ReadAllBytes(source)) == originalHash, "OWNED_SOURCE_NOT_RESTORED");
}

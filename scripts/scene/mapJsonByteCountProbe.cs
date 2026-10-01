// Validation only. Load and call the actual compiled generic JSON byte counter.
using System.Buffers.Binary;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var producer = Path.GetFullPath(args[0]);
var producerHash = Hash(File.ReadAllBytes(producer));
var inputHashes = args.Skip(1).Select(path => new { path = Path.GetFullPath(path), hash = Hash(File.ReadAllBytes(path)) }).ToArray();
var assembly = Assembly.LoadFrom(producer);
const BindingFlags StaticFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
var counter = assembly.GetType("JsonByteCounter", true)!.GetMethod("Count", StaticFlags)!;
Require(counter.IsGenericMethodDefinition, "ACTUAL_GENERIC_COUNTER_REQUIRED");
var cases = new List<object>();
var controls = new List<object>();
const long FrameBytes = 8L * 1024 * 1024;
const long SafeChunkBytes = FrameBytes - 64L * 1024;

string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
void Require(bool condition, string reason) { if (!condition) throw new Exception(reason); }
object? Invoke(MethodInfo method, object? instance, object?[]? values)
{
    try { return method.Invoke(instance, values); }
    catch (TargetInvocationException error) when (error.InnerException is not null)
    {
        ExceptionDispatchInfo.Capture(error.InnerException).Throw();
        throw;
    }
}
long ActualCount<T>(T value) => (long)Invoke(counter.MakeGenericMethod(typeof(T)), null, new object?[] { value })!;
long Check<T>(string name, T value, long? expected = null)
{
    var byteArrayLength = JsonSerializer.SerializeToUtf8Bytes(value).LongLength;
    var stringByteLength = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(value));
    var actual = ActualCount(value);
    Require(actual == byteArrayLength && actual == stringByteLength, "JSON_COUNT_DIFFERENCE:" + name);
    Require(expected is null || actual == expected, "EXACT_THRESHOLD_SIZE_WRONG:" + name);
    cases.Add(new { name, genericType = typeof(T).FullName, byteArrayLength, stringByteLength, actual });
    return actual;
}
string Failure(Action action)
{
    try { action(); }
    catch (Exception error) { return error.GetType().FullName!; }
    throw new Exception("SERIALIZATION_FAILURE_REQUIRED");
}
void CheckFailure<T>(string name, T value)
{
    var bytesFailure = Failure(() => { JsonSerializer.SerializeToUtf8Bytes(value); });
    var stringFailure = Failure(() => { JsonSerializer.Serialize(value); });
    var actualFailure = Failure(() => { ActualCount(value); });
    Require(bytesFailure == stringFailure && bytesFailure == actualFailure, "SERIALIZATION_EXCEPTION_CHANGED:" + name);
    cases.Add(new { name, bytesFailure, stringFailure, actualFailure });
}

try
{
    Check<object?>("null-object", null, 4);
    Check("empty-string", "", 2);
    Check("empty-array", Array.Empty<int>(), 2);
    Check("empty-dictionary", new Dictionary<string, object?>(), 2);
    Check("escaped-metadata-and-nested-values", new
    {
        modelName = "地图模型/é/😀\"\\\n\r\t\u0000\u0001<>&+'",
        materialName = "雪/cloth+\"quoted\"",
        texturePreviewToken = "++++////====",
        positionsBase64 = Convert.ToBase64String(new byte[] { 0xfb, 0xef, 0xff, 0, 1, 2 }),
        nullableValue = (string?)null,
        nested = new object?[] { null, "", true, 123, new { values = new[] { 1.5, -2.0, 0.0 } } }
    });
    // Count<T> must preserve the same compile-time contract as each serializer.
    object boxed = new CounterDerived { BaseValue = "base", DerivedValue = "+derived" };
    Check("object-runtime-contract", boxed);
    CounterBase baseView = (CounterBase)boxed;
    Check("declared-base-contract", baseView);
    IReadOnlyDictionary<string, object?> interfaceView = new Dictionary<string, object?> { ["非ASCII+key"] = null, ["items"] = new[] { "", "\n", "+" } };
    Check("declared-interface-contract", interfaceView);
    Require(ActualCount(boxed) != ActualCount(baseView), "GENERIC_CONTRACT_FIXTURE_NOT_DISTINCT");

    foreach (var threshold in new[] { SafeChunkBytes, FrameBytes })
    {
        foreach (var delta in new[] { -1, 0, 1 })
        {
            var empty = new { data = "" };
            var emptyLength = JsonSerializer.SerializeToUtf8Bytes(empty).LongLength;
            var target = threshold + delta;
            var value = new { data = new string('a', checked((int)(target - emptyLength))) };
            var actual = Check($"boundary-{threshold}-{delta}", value, target);
            Require((actual < threshold) == (delta < 0), "STRICT_SIZE_COMPARISON_CHANGED");
        }
    }
    var failurePrefix = new string('a', 64 * 1024);
    CheckFailure("nonfinite-number-after-prefix", new { prefix = failurePrefix, value = double.NaN });
    var cycle = new CounterCycle(); cycle.Next = cycle;
    CheckFailure("cyclic-object-after-prefix", new { prefix = failurePrefix, value = cycle });
    CheckFailure("throwing-property-after-prefix", new { prefix = failurePrefix, value = new CounterThrowingProperty() });
    Check("successful-count-after-failures", new { value = "recovered+雪" });

    if (args.Length == 3)
    {
        var map = assembly.GetType("MapStaticGeometryService", true)!;
        var native = assembly.GetType("FlverNativeDocument", true)!;
        var telemetry = assembly.GetType("BridgeTelemetry", true)!;
        var reset = map.GetMethod("Reset", StaticFlags)!;
        var resetTelemetry = telemetry.GetMethod("Reset", StaticFlags)!;
        var create = map.GetMethod("GetOrCreate", StaticFlags)!;
        var build = map.GetMethod("BuildChunk", StaticFlags)!;
        var decodeCursor = map.GetMethod("TryDecodeOpaqueCursor", StaticFlags)!;
        Require((long)map.GetField("SafeChunkFrameBytes", StaticFlags)!.GetRawConstantValue()! == SafeChunkBytes,
            "PRODUCTION_SAFE_CHUNK_THRESHOLD_CHANGED");
        Require((long)map.GetField("MaxSerializedFrameBytes", StaticFlags)!.GetRawConstantValue()! == FrameBytes,
            "PRODUCTION_FRAME_THRESHOLD_CHANGED");
        object Session(string path)
        {
            var source = File.ReadAllBytes(path);
            var document = Invoke(native.GetMethod("Read", StaticFlags)!, null, new object?[] { source })!;
            var values = create.GetParameters().Select(parameter => parameter.HasDefaultValue ? parameter.DefaultValue : Type.Missing).ToArray();
            values[0] = path; values[1] = "jsonCountFixture"; values[2] = null; values[3] = Hash(source);
            values[4] = document; values[5] = "jsonCountFixture.flver"; values[6] = "json-count-fixture";
            return Invoke(create, null, values)!;
        }
        (object chunk, string? next, bool complete) Chunk(object session, string token, int mesh = 0, int sourceIndex = 0)
        {
            Invoke(resetTelemetry, null, null);
            var values = new object?[] { session, mesh, sourceIndex, null, false, token, null };
            var chunk = Invoke(build, null, values);
            Require(chunk is not null, "ACTUAL_CHUNK_REQUIRED");
            return (chunk!, (string?)values[3], (bool)values[4]!);
        }
        JsonElement Element(object chunk) => JsonSerializer.SerializeToElement(chunk);
        uint[] Sources(object chunk)
        {
            var bytes = Convert.FromBase64String(Element(chunk).GetProperty("sourceVertexIndicesBase64").GetString()!);
            Require(bytes.Length % 4 == 0, "SOURCE_INDEX_WIDTH_WRONG");
            return Enumerable.Range(0, bytes.Length / 4).Select(index => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(index * 4, 4))).ToArray();
        }
        Invoke(reset, null, null);
        try
        {
            var two = Session(Path.GetFullPath(args[1]));
            var one = Session(Path.GetFullPath(args[2]));
            var full = Chunk(two, "");
            var single = Chunk(one, "");
            Require(full.complete && full.next is null && Element(full.chunk).GetProperty("triangleCount").GetInt32() == 2,
                "TWO_TRIANGLE_NATIVE_FIXTURE_WRONG");
            Require(single.complete && single.next is null && Element(single.chunk).GetProperty("triangleCount").GetInt32() == 1,
                "ONE_TRIANGLE_NATIVE_FIXTURE_WRONG");
            var twoBytes = Check("actual-two-triangle-chunk", full.chunk);
            var oneBytes = Check("actual-one-triangle-chunk", single.chunk);
            Require(twoBytes > oneBytes + 6, "BOUNDED_SHRINK_WINDOW_MISSING");
            // '+' is encoded as six UTF-8 bytes by the retained default encoder.
            Require(Encoding.UTF8.GetByteCount(JsonSerializer.Serialize("+")) == 8, "DEFAULT_PLUS_ESCAPE_CHANGED");
            var tokenLength = checked((int)((SafeChunkBytes - 1 - oneBytes) / 6));
            Require(oneBytes + 6L * tokenLength < SafeChunkBytes && twoBytes + 6L * tokenLength >= SafeChunkBytes,
                "ARITHMETIC_SHRINK_WINDOW_WRONG");
            var prefix = Chunk(two, new string('+', tokenLength));
            Require(!prefix.complete && prefix.next is not null && Element(prefix.chunk).GetProperty("triangleCount").GetInt32() == 1,
                "AUTHORITATIVE_WIRE_CHECK_DID_NOT_SHRINK_ONE_PREFIX");
            Require(Sources(prefix.chunk).SequenceEqual(new uint[] { 0, 1, 2 }), "FIRST_PREFIX_SOURCE_ORDER_CHANGED");
            var prefixBytes = Check("actual-plus-token-shrunk-prefix", prefix.chunk);
            Require(prefixBytes < SafeChunkBytes, "SHRUNK_CHUNK_NOT_WITHIN_SAFE_BUDGET");
            controls.Add(new { kind = "two-triangle-one-prefix-shrink", passed = true, tokenLength, twoBytes, oneBytes, prefixBytes });

            var cursorValues = new object?[] { two, prefix.next, 0, 0 };
            Require((bool)Invoke(decodeCursor, null, cursorValues)!, "OPAQUE_CONTINUATION_NOT_ACCEPTED");
            Require((int)cursorValues[2]! == 0 && (int)cursorValues[3]! == 3, "OPAQUE_CONTINUATION_BOUNDARY_WRONG");
            var resumed = Chunk(two, "", (int)cursorValues[2]!, (int)cursorValues[3]!);
            Require(resumed.complete && resumed.next is null && Element(resumed.chunk).GetProperty("triangleCount").GetInt32() == 1,
                "SECOND_TRIANGLE_DID_NOT_COMPLETE");
            Require(Element(resumed.chunk).GetProperty("sourceTriangleStart").GetInt32() == 1 && Sources(resumed.chunk).SequenceEqual(new uint[] { 3, 4, 5 }),
                "OPAQUE_CONTINUATION_SKIPPED_OR_REPLAYED_TRIANGLE");
            Check("actual-resumed-second-triangle", resumed.chunk);
            controls.Add(new { kind = "opaque-continuation-no-skip-or-replay", passed = true });

            var failureTokenLength = checked((int)((SafeChunkBytes - oneBytes + 5) / 6));
            try
            {
                Chunk(one, new string('+', failureTokenLength));
                throw new Exception("ONE_TRIANGLE_WIRE_FAILURE_REQUIRED");
            }
            catch (InvalidDataException error)
            {
                Require(error.Message.Contains("one legal triangle exceeds the serialized frame budget", StringComparison.Ordinal),
                    "WRONG_BUDGET_FAILURE_PATH:" + error.Message);
            }
            controls.Add(new { kind = "one-triangle-serialized-budget-failure", passed = true, failureTokenLength });
        }
        finally { Invoke(reset, null, null); }
    }
    else Require(args.Length == 1, "PASS_BOTH_TWO_AND_ONE_TRIANGLE_INPUTS_OR_NEITHER");
}
finally
{
    Require(Hash(File.ReadAllBytes(producer)) == producerHash, "PRODUCER_CHANGED_DURING_PROBE");
    foreach (var input in inputHashes)
        Require(Hash(File.ReadAllBytes(input.path)) == input.hash, "INPUT_CHANGED_DURING_PROBE");
}
Console.WriteLine(JsonSerializer.Serialize(new
{
    passed = true, producerHash, inputHashes, cases, controls,
    buildChunk = args.Length == 3 ? "executed" : "not_run", thresholds = new { FrameBytes, SafeChunkBytes },
    scope = "Actual compiled default JSON counter and optional native BuildChunk; synthetic CPU only, no daemon/GPU/game"
}));

public class CounterBase { public string BaseValue { get; set; } = ""; }
public sealed class CounterDerived : CounterBase { public string DerivedValue { get; set; } = ""; }
public sealed class CounterCycle { public CounterCycle? Next { get; set; } }
public sealed class CounterThrowingProperty { public string Value => throw new InvalidOperationException("expected-fixture-getter-failure"); }

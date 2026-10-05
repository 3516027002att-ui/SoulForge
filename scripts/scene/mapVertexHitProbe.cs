// Validation only: actual private compiled helper, reflection only outside timing.
using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

internal static class Program
{
    private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    private const string NativeSourceHash = "db03ec79dff8e6e3dab4fadcc2b76edebfe6726a99b6ea42070179751710b4aa";
    private const string MapSourceHash = "832fdec7e02be37d0b779426bba59ff3863aa5acc7ebc41707af73ac18b308f1";
    private delegate int VertexDecoder<TSession, TMesh, TDescriptor, TBuffers>(
        TSession session, TMesh mesh, TDescriptor descriptor, uint source,
        Dictionary<uint, int> sourceToDense, TBuffers buffers,
        Span<float> position, Span<float> normal, Span<float> uv, Span<float> weights, Span<ushort> indices);

    public static int Main(string[] args)
    {
        try
        {
            Require(args.Length is >= 4 and <= 7,
                "Usage: Probe.dll <producer.dll> <input.flver> <expected-producer-sha256> <expected-input-sha256> [samples=9] [warmups=5] [triples=300000]");
            var samples = Bounded(args, 4, 9, 1, 25);
            var warmups = Bounded(args, 5, 5, 1, 10);
            var triples = Bounded(args, 6, 300_000, 1_000, 2_000_000);
            var producer = Path.GetFullPath(args[0]);
            var input = Path.GetFullPath(args[1]);
            var guards = new List<FileGuard>
            {
                Guard("producer", producer, args[2]),
                Guard("input", input, args[3]),
                Guard("native-source", "bridge/SoulForge.Bridge/FlverNativeDocument.cs", NativeSourceHash),
                Guard("map-source", "bridge/SoulForge.Bridge/MapStaticGeometryService.cs", MapSourceHash)
            };
            var library = Path.Combine(Path.GetDirectoryName(producer)!, "libSoulForge.Hksc.Native.so");
            if (File.Exists(library)) guards.Add(Guard("producer-adjacent-native-library", library, null));
            var source = File.ReadAllBytes(input);
            Require(Hash(source) == guards[1].sha256Before, "INPUT_CHANGED_DURING_READ");
            var assembly = Assembly.LoadFrom(producer);
            Require(Path.GetFullPath(assembly.Location) == producer, "LOADED_DIFFERENT_PRODUCER");
            var native = assembly.GetType("FlverNativeDocument", true)!;
            var map = assembly.GetType("MapStaticGeometryService", true)!;
            var reset = map.GetMethod("Reset", Members)!;
            var helper = map.GetMethod("DecodeChunkVertex", Members)!;
            var telemetry = assembly.GetType("BridgeTelemetry", true)!;
            var counters = new[] { "MapTypedPositionDecodeCount", "MapTypedNormalDecodeCount", "MapTypedUvDecodeCount" }
                .Select(name => telemetry.GetField(name, Members)!).ToArray();
            object result;
            reset.Invoke(null, null);
            try
            {
                var document = native.GetMethod("Read", Members)!.Invoke(null, new object[] { source })!;
                var create = map.GetMethod("GetOrCreate", Members)!;
                var values = create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : Type.Missing).ToArray();
                values[0] = input; values[1] = "helper-hit-probe"; values[2] = null;
                values[3] = guards[1].sha256Before; values[4] = document; values[5] = Path.GetFileName(input);
                values[6] = "helper-hit-probe";
                var session = create.Invoke(null, values)!;
                var meshes = (IEnumerable)Field(session, "Meshes")!;
                var mesh = meshes.Cast<object>().First();
                var descriptor = Field(mesh, "Descriptor")!;
                Require(ReferenceEquals(Field(session, "Flver"), document), "SESSION_DOCUMENT_IDENTITY_CHANGED");
                var parameterTypes = helper.GetParameters();
                var run = typeof(Program).GetMethod(nameof(Run), Members)!.MakeGenericMethod(
                    parameterTypes[0].ParameterType, parameterTypes[1].ParameterType,
                    parameterTypes[2].ParameterType, parameterTypes[5].ParameterType);
                result = run.Invoke(null, new object[] { session, mesh, descriptor, helper, counters, samples, warmups, triples })!;
            }
            finally { reset.Invoke(null, null); }
            Require(Hash(source) == guards[1].sha256Before, "PARSED_SOURCE_BYTES_CHANGED");
            foreach (var guard in guards)
            {
                guard.sha256After = HashFile(guard.path);
                Require(guard.sha256After == guard.sha256Before, "BOUND_FILE_CHANGED:" + guard.kind);
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                passed = true, files = guards, sourceBytes = source.Length,
                producerAssembly = assembly.GetName().FullName, moduleVersionId = assembly.ManifestModule.ModuleVersionId,
                runtime = new { framework = RuntimeInformation.FrameworkDescription,
                    architecture = RuntimeInformation.ProcessArchitecture.ToString(), processorCount = Environment.ProcessorCount,
                    settings = new[] { "DOTNET_TieredCompilation", "DOTNET_TieredPGO", "DOTNET_ReadyToRun",
                            "COMPlus_TieredCompilation", "COMPlus_TieredPGO", "COMPlus_ReadyToRun" }
                        .ToDictionary(name => name, name => Environment.GetEnvironmentVariable(name) ?? "runtime default") },
                result,
                scope = "Actual compiled DecodeChunkVertex hit path with runtime-closed strongly typed generic delegate and concrete Span parameters. Reflection, parse/session setup, telemetry reads and assertions outside timing. Repeated three-key hot dictionary, synthetic CPU only; direct BCL lookup is diagnostic. Includes delegate-call and loop/checksum overhead. Does not establish full-pipeline latency, chunk-size/cache effects, real-map/GPU performance or an optimization speedup. No product, JIT, security or concurrency changes by this host."
            }));
            return 0;
        }
        catch (Exception failure)
        {
            Console.Error.WriteLine(failure is TargetInvocationException { InnerException: { } inner } ? inner : failure);
            return 1;
        }
    }

    private static object Run<TSession, TMesh, TDescriptor, TBuffers>(object sessionObject, object meshObject,
        object descriptorObject, MethodInfo helperMethod, FieldInfo[] counters, int sampleCount, int warmupCount, int triples)
        where TSession : class where TMesh : class where TDescriptor : class where TBuffers : class
    {
        var session = (TSession)sessionObject;
        var mesh = (TMesh)meshObject;
        var descriptor = (TDescriptor)descriptorObject;
        var decoder = helperMethod.CreateDelegate<VertexDecoder<TSession, TMesh, TDescriptor, TBuffers>>();
        var vertexCount = (int)Property(descriptor, "SourceVertexCount")!;
        Require(vertexCount >= 4, "FOUR_SOURCE_VERTICES_REQUIRED");
        var plan = Property(descriptor, "DataPlan")!;
        var hasNormals = Field(plan, "Normal") is not null;
        var hasUvs = (int)Property(descriptor, "UvSetCount")! > 0;
        var sources = new List<uint>();
        var positions = new List<float>();
        var normals = hasNormals ? new List<float>() : null;
        var uvs = hasUvs ? new List<float>() : null;
        var denseIndices = new List<uint>();
        var buffers = (TBuffers)Activator.CreateInstance(typeof(TBuffers), nonPublic: true)!;
        Set(buffers, "SourceVertexIndices", sources); Set(buffers, "Positions", positions);
        Set(buffers, "Normals", normals); Set(buffers, "Uvs", uvs); Set(buffers, "DenseIndices", denseIndices);
        var mapping = new Dictionary<uint, int>();
        Span<float> position = stackalloc float[3];
        Span<float> normal = stackalloc float[3];
        Span<float> uv = stackalloc float[2];
        Span<float> weights = stackalloc float[4];
        Span<ushort> indices = stackalloc ushort[4];
        Counts Snapshot() => new((long)counters[0].GetValue(null)!, (long)counters[1].GetValue(null)!, (long)counters[2].GetValue(null)!);
        Counts Expected(int count) => new(count, hasNormals ? count : 0, hasUvs ? count : 0);
        var beforeSeeds = Snapshot();
        for (uint source = 0; source < 3; source++)
            Require(decoder(session, mesh, descriptor, source, mapping, buffers, position, normal, uv, weights, indices) == (int)source,
                "SEED_DENSE_ID_WRONG");
        var afterSeeds = Snapshot();
        Require(afterSeeds - beforeSeeds == Expected(3), "SEED_DECODE_COUNTERS_WRONG");
        Require(sources.SequenceEqual(new uint[] { 0, 1, 2 }) && positions.Count == 9
            && (normals?.Count ?? 0) == (hasNormals ? 9 : 0) && (uvs?.Count ?? 0) == (hasUvs ? 6 : 0)
            && denseIndices.Count == 0 && mapping.Count == 3, "SEED_BUFFER_COUNTS_WRONG");
        string BufferHash()
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(MemoryMarshal.AsBytes(CollectionsMarshal.AsSpan(sources)));
            hash.AppendData(MemoryMarshal.AsBytes(CollectionsMarshal.AsSpan(positions)));
            if (normals is not null) hash.AppendData(MemoryMarshal.AsBytes(CollectionsMarshal.AsSpan(normals)));
            if (uvs is not null) hash.AppendData(MemoryMarshal.AsBytes(CollectionsMarshal.AsSpan(uvs)));
            hash.AppendData(MemoryMarshal.AsBytes(CollectionsMarshal.AsSpan(denseIndices)));
            foreach (var name in new[] { "MinX", "MinY", "MinZ", "MaxX", "MaxY", "MaxZ" })
                hash.AppendData(BitConverter.GetBytes((float)Field(buffers, name)!));
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        var bufferHashBeforeHits = BufferHash();
        var measured = new List<object>();
        var actualTimes = new List<double>();
        var dictionaryTimes = new List<double>();
        long actualAllocations = 0, dictionaryAllocations = 0;
        for (var pass = 0; pass < warmupCount + sampleCount; pass++)
        {
            var before = Snapshot();
            Timed actual, bcl;
            if ((pass & 1) == 0)
            {
                actual = MeasureActual(decoder, session, mesh, descriptor, mapping, buffers, triples);
                bcl = MeasureDictionary(mapping, triples);
            }
            else
            {
                bcl = MeasureDictionary(mapping, triples);
                actual = MeasureActual(decoder, session, mesh, descriptor, mapping, buffers, triples);
            }
            var after = Snapshot();
            Require(after == before && after == afterSeeds, "CACHED_HIT_PERFORMED_TYPED_DECODE");
            Require(actual.badIds == 0 && bcl.badIds == 0 && actual.checksum == 3L * triples
                && bcl.checksum == 3L * triples, "HIT_DENSE_IDS_WRONG");
            Require(mapping.Count == 3 && sources.Count == 3, "CACHED_HIT_ADDED_SOURCE");
            if (pass < warmupCount) continue;
            actualTimes.Add(actual.wallMs); dictionaryTimes.Add(bcl.wallMs);
            actualAllocations += actual.allocatedBytes; dictionaryAllocations += bcl.allocatedBytes;
            measured.Add(new { sample = pass - warmupCount, actualFirst = (pass & 1) == 0,
                hits = checked(3 * triples), actual, bclDictionaryDiagnostic = bcl,
                countersBefore = before, countersAfter = after, counterDelta = after - before });
        }
        var afterHits = Snapshot();
        var bufferHashAfterHits = BufferHash();
        Require(bufferHashAfterHits == bufferHashBeforeHits, "CACHED_HIT_MUTATED_BUFFERS");
        var controlDense = decoder(session, mesh, descriptor, 3, mapping, buffers, position, normal, uv, weights, indices);
        var afterFirstSeen = Snapshot();
        Require(controlDense == 3 && afterFirstSeen - afterHits == Expected(1)
            && sources.SequenceEqual(new uint[] { 0, 1, 2, 3 }) && mapping.Count == 4 && positions.Count == 12
            && (normals?.Count ?? 0) == (hasNormals ? 12 : 0) && (uvs?.Count ?? 0) == (hasUvs ? 8 : 0),
            "FIRST_SEEN_CONTROL_FAILED");
        Require(decoder(session, mesh, descriptor, 3, mapping, buffers, position, normal, uv, weights, indices) == 3
            && Snapshot() == afterFirstSeen, "FIRST_SEEN_REPEATED_HIT_FAILED");
        var actualMedian = Median(actualTimes); var bclMedian = Median(dictionaryTimes);
        return new
        {
            actualTypes = new[] { typeof(TSession).FullName, typeof(TMesh).FullName, typeof(TDescriptor).FullName, typeof(TBuffers).FullName },
            actualMethod = helperMethod.ToString(), vertexCount, hasNormals, hasUvs,
            seed = new { sources = new uint[] { 0, 1, 2 }, denseIds = new[] { 0, 1, 2 }, countersBefore = beforeSeeds,
                countersAfter = afterSeeds, counterDelta = afterSeeds - beforeSeeds, passed = true },
            warmupCount, sampleCount, triplesPerPass = triples, hitsPerPass = checked(3 * triples),
            measuredActualHits = (long)sampleCount * 3 * triples,
            allActualHitsIncludingWarmups = (long)(warmupCount + sampleCount) * 3 * triples,
            actualMedianMs = actualMedian, bclDictionaryDiagnosticMedianMs = bclMedian,
            actualMedianNanosecondsPerHit = actualMedian * 1_000_000 / (3L * triples),
            bclDictionaryDiagnosticMedianNanosecondsPerHit = bclMedian * 1_000_000 / (3L * triples),
            diagnosticDifferenceNanosecondsPerHit = (actualMedian - bclMedian) * 1_000_000 / (3L * triples),
            measuredActualAllocatedBytes = actualAllocations, measuredBclDiagnosticAllocatedBytes = dictionaryAllocations,
            countersAfterHits = afterHits, totalHitDecodeCounterDelta = afterHits - afterSeeds,
            bufferHashBeforeHits, bufferHashAfterHits, samples = measured,
            firstSeenControl = new { source = 3, denseId = controlDense, passed = true,
                countersBefore = afterHits, countersAfter = afterFirstSeen, counterDelta = afterFirstSeen - afterHits,
                repeatedHitDecodeDelta = Snapshot() - afterFirstSeen },
            diagnosticLimitation = "Direct BCL TryGetValue has no generic delegate call or large helper/Span argument list. Difference is a harness diagnostic, not isolated helper prologue cost or a predicted hot/cold-split/full-pipeline speedup. Default tiered JIT may evolve between short passes; samples and order are reported."
        };
    }

    private static Timed MeasureActual<TSession, TMesh, TDescriptor, TBuffers>(
        VertexDecoder<TSession, TMesh, TDescriptor, TBuffers> decoder, TSession session, TMesh mesh, TDescriptor descriptor,
        Dictionary<uint, int> mapping, TBuffers buffers, int triples)
    {
        Span<float> position = stackalloc float[3]; Span<float> normal = stackalloc float[3];
        Span<float> uv = stackalloc float[2]; Span<float> weights = stackalloc float[4];
        Span<ushort> indices = stackalloc ushort[4];
        long checksum = 0; var bad = 0;
        var allocatedBefore = GC.GetAllocatedBytesForCurrentThread(); var start = Stopwatch.GetTimestamp();
        for (var i = 0; i < triples; i++)
        {
            var a = decoder(session, mesh, descriptor, 2, mapping, buffers, position, normal, uv, weights, indices);
            var b = decoder(session, mesh, descriptor, 0, mapping, buffers, position, normal, uv, weights, indices);
            var c = decoder(session, mesh, descriptor, 1, mapping, buffers, position, normal, uv, weights, indices);
            bad |= (a ^ 2) | b | (c ^ 1); checksum += a + b + c;
        }
        var stop = Stopwatch.GetTimestamp(); var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        return new((stop - start) * 1000d / Stopwatch.Frequency, allocated, checksum, bad);
    }

    private static Timed MeasureDictionary(Dictionary<uint, int> mapping, int triples)
    {
        long checksum = 0; var bad = 0;
        var allocatedBefore = GC.GetAllocatedBytesForCurrentThread(); var start = Stopwatch.GetTimestamp();
        for (var i = 0; i < triples; i++)
        {
            var a = mapping.TryGetValue(2, out var av) ? av : -1;
            var b = mapping.TryGetValue(0, out var bv) ? bv : -1;
            var c = mapping.TryGetValue(1, out var cv) ? cv : -1;
            bad |= (a ^ 2) | b | (c ^ 1); checksum += a + b + c;
        }
        var stop = Stopwatch.GetTimestamp(); var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        return new((stop - start) * 1000d / Stopwatch.Frequency, allocated, checksum, bad);
    }

    private readonly record struct Timed(double wallMs, long allocatedBytes, long checksum, int badIds);
    private readonly record struct Counts(long position, long normal, long uv)
    { public static Counts operator -(Counts a, Counts b) => new(a.position - b.position, a.normal - b.normal, a.uv - b.uv); }
    private sealed record FileGuard(string kind, string path, string? expectedSha256, string sha256Before)
    { public string? sha256After { get; set; } }
    private static FileGuard Guard(string kind, string path, string? expected)
    {
        path = Path.GetFullPath(path); var hash = HashFile(path);
        Require(expected is null || hash == expected.ToLowerInvariant(), "BOUND_HASH_MISMATCH:" + kind);
        return new(kind, path, expected, hash);
    }
    private static object? Field(object target, string name) => target.GetType().GetField(name, Members)!.GetValue(target);
    private static object? Property(object target, string name) => target.GetType().GetProperty(name, Members)!.GetValue(target);
    private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Members)!.SetValue(target, value);
    private static void Require(bool condition, string reason) { if (!condition) throw new InvalidOperationException(reason); }
    private static string Hash(byte[] source) => Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant();
    private static string HashFile(string path) { using var stream = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); }
    private static int Bounded(string[] args, int offset, int fallback, int min, int max)
    { var value = args.Length > offset ? int.Parse(args[offset]) : fallback; Require(value >= min && value <= max, "ARGUMENT_OUT_OF_BOUNDS:" + offset); return value; }
    private static double Median(List<double> values)
    { var sorted = values.Order().ToArray(); var mid = sorted.Length / 2; return sorted.Length % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]; }
}

using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

[Collection("Bridge result transport")]
public sealed class MsbNativeTimingTests
{
    private static JsonElement Enabled(bool value = true) => JsonSerializer.SerializeToElement(new { diagnosticTimings = value });
    private static MapTimingCollector Collector()
    {
        var collector = MapTimingCollector.TryCreate("read-msb-document", Enabled(), Stopwatch.GetTimestamp());
        Assert.NotNull(collector); return collector!;
    }

    [Fact]
    public void OptInUsesCommandSpecificBoundedPhasesAndPreservesStaticMapSchema()
    {
        Assert.Null(MapTimingCollector.TryCreate("read-msb-document", default, Stopwatch.GetTimestamp()));
        Assert.Null(MapTimingCollector.TryCreate("read-msb-document", Enabled(false), Stopwatch.GetTimestamp()));
        Assert.Null(MapTimingCollector.TryCreate("inspect", Enabled(), Stopwatch.GetTimestamp()));
        var collector = Collector(); using (collector.Measure("msbReadMs")) { }
        for (var index = 0; index < 100; index++) using (collector.Measure("unknown" + index)) { }
        using var msb = JsonDocument.Parse(JsonSerializer.Serialize(collector.Snapshot()));
        var counts = msb.RootElement.GetProperty("phaseCounts"); Assert.Single(counts.EnumerateObject());
        Assert.Equal(1, counts.GetProperty("msbReadMs").GetInt32());
        Assert.Equal(JsonValueKind.Null, msb.RootElement.GetProperty("verifyRoundTripMs").ValueKind);
        var map = MapTimingCollector.TryCreate("read-map-static-geometry", Enabled(), Stopwatch.GetTimestamp()); Assert.NotNull(map);
        using var legacy = JsonDocument.Parse(JsonSerializer.Serialize(map!.Snapshot()));
        Assert.True(legacy.RootElement.TryGetProperty("flverReadMs", out _));
        Assert.False(legacy.RootElement.TryGetProperty("msbReadMs", out _));
        Assert.False(legacy.RootElement.TryGetProperty("physicalSourceHash", out _));
    }

    [Fact]
    public async Task RealServicePhasesBindOuterAndLeafFromOneDfltSnapshotWithoutChangingResult()
    {
        var leaf = EmptyMsb(); var outer = Dflt(leaf);
        var root = Path.Combine(Path.GetTempPath(), "sf-msb-timing-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var path = Path.Combine(root, "fixture.msb.dcx"); File.WriteAllBytes(path, outer);
        try
        {
            var service = new BridgeCommandService(); var expected = await service.ExecuteAsync("read-msb-document", path, CancellationToken.None);
            var collector = Collector(); var observed = await service.ExecuteAsync("read-msb-document", path, CancellationToken.None, options: Enabled(), mapTiming: collector);
            Assert.Equal("partial", observed.ParseStatus);
            Assert.Equal(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(observed));
            using var snapshot = JsonDocument.Parse(JsonSerializer.Serialize(collector.Snapshot())); var value = snapshot.RootElement;
            Assert.Equal(Hash(outer), value.GetProperty("physicalSourceHash").GetString());
            Assert.Equal(Hash(leaf), value.GetProperty("decodedSourceHash").GetString());
            Assert.NotEqual(value.GetProperty("physicalSourceHash").GetString(), value.GetProperty("decodedSourceHash").GetString());
            Assert.Equal(outer.Length, value.GetProperty("physicalSourceBytes").GetInt32());
            Assert.Equal(leaf.Length, value.GetProperty("decodedSourceBytes").GetInt32());
            Assert.Empty(value.GetProperty("unavailablePhases").EnumerateArray());
            Assert.Equal(6, value.GetProperty("phaseCounts").EnumerateObject().Count());
            Assert.All(value.GetProperty("phaseCounts").EnumerateObject(), phase => Assert.Equal(1, phase.Value.GetInt32()));
            Assert.True(value.GetProperty("nativeEnqueuedAtUnixMs").GetDouble() <= value.GetProperty("nativeStartedAtUnixMs").GetDouble());
            Assert.True(value.GetProperty("nativeStartedAtUnixMs").GetDouble() <= value.GetProperty("nativeCompletedAtUnixMs").GetDouble());
            Assert.Equal(5, value.GetProperty("clockAlignmentToleranceMs").GetDouble());
            Assert.Equal(outer, File.ReadAllBytes(path));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task FailedReadLeavesUnexecutedPhasesAndSourceIdentityUnavailable()
    {
        var collector = Collector(); var missing = Path.Combine(Path.GetTempPath(), "sf-msb-missing-" + Guid.NewGuid().ToString("N"));
        var result = await new BridgeCommandService().ExecuteAsync("read-msb-document", missing, CancellationToken.None, options: Enabled(), mapTiming: collector);
        Assert.Equal("failed", result.ParseStatus);
        using var snapshot = JsonDocument.Parse(JsonSerializer.Serialize(collector.Snapshot())); var value = snapshot.RootElement;
        Assert.Equal(JsonValueKind.Null, value.GetProperty("physicalSourceHash").ValueKind);
        Assert.Equal(JsonValueKind.Null, value.GetProperty("decodedSourceHash").ValueKind);
        Assert.Empty(value.GetProperty("phaseCounts").EnumerateObject());
        Assert.Equal(6, value.GetProperty("unavailablePhases").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, value.GetProperty("verifyRoundTripMs").ValueKind);
    }

    [Fact]
    public async Task FailedParseRetainsOnlyExecutedPhasesAndObservedPhysicalSource()
    {
        var path = Path.Combine(Path.GetTempPath(), "sf-msb-invalid-" + Guid.NewGuid().ToString("N"));
        var bytes = new byte[32]; File.WriteAllBytes(path, bytes);
        try
        {
            var collector = Collector(); var result = await new BridgeCommandService().ExecuteAsync("read-msb-document", path, CancellationToken.None, options: Enabled(), mapTiming: collector);
            Assert.Equal("failed", result.ParseStatus);
            using var snapshot = JsonDocument.Parse(JsonSerializer.Serialize(collector.Snapshot())); var value = snapshot.RootElement;
            Assert.Equal(Hash(bytes), value.GetProperty("physicalSourceHash").GetString());
            Assert.Equal(JsonValueKind.Null, value.GetProperty("decodedSourceHash").ValueKind);
            Assert.Equal(4, value.GetProperty("phaseCounts").EnumerateObject().Count());
            Assert.Equal(2, value.GetProperty("unavailablePhases").GetArrayLength());
        }
        finally { File.Delete(path); }
    }

    private static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private static byte[] EmptyMsb()
    {
        var families = new[] { "MODEL_PARAM_ST", "EVENT_PARAM_ST", "POINT_PARAM_ST", "ROUTE_PARAM_ST", "LAYER_PARAM_ST", "PARTS_PARAM_ST", "MAPSTUDIO_PARTS_POSE_ST", "MAPSTUDIO_BONE_NAME_STRING" };
        var bytes = new byte[0x500]; "MSB "u8.CopyTo(bytes); BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(4), 3);
        for (var index = 0; index < families.Length; index++)
        {
            var offset = 0x10 + index * 0x80;
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset), 1);
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset + 4), 1);
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset + 8), offset + 0x20);
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset + 16), index == families.Length - 1 ? 0 : offset + 0x80);
            Encoding.Unicode.GetBytes(families[index] + "\0").CopyTo(bytes, offset + 0x20);
        }
        return bytes;
    }

    private static byte[] Dflt(byte[] leaf)
    {
        using var memory = new MemoryStream(); using (var zlib = new ZLibStream(memory, CompressionLevel.Optimal, leaveOpen: true)) zlib.Write(leaf);
        var compressed = memory.ToArray(); var source = new byte[0x4C + compressed.Length];
        "DCX\0"u8.CopyTo(source); "DCS\0"u8.CopyTo(source.AsSpan(0x18)); "DCP\0"u8.CopyTo(source.AsSpan(0x24)); "DFLT"u8.CopyTo(source.AsSpan(0x28)); "DCA\0"u8.CopyTo(source.AsSpan(0x44));
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x1C), leaf.Length); BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x20), compressed.Length); BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x48), 8);
        compressed.CopyTo(source, 0x4C); return source;
    }
}

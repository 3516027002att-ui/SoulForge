using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

// DaemonState attaches a process-wide geometry cache. Keep this collection
// exclusive so the tests retain its real ownership/cleanup behavior.
[CollectionDefinition("Bridge result transport", DisableParallelization = true)]
public sealed class BridgeResultTransportCollection;

[Collection("Bridge result transport")]
public sealed class BridgeResultTransportTests
{
    private const int FrameLimit = 1024 * 1024;
    private static JsonSerializerOptions Options => (JsonSerializerOptions)typeof(BridgeDaemonHost)
        .GetField("JsonOptions", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;

    [Fact]
    public void InlineSerializerOutputPreservesUnicodeNumbersNullsAndNestedValues()
    {
        using var host = new ActualState();
        var result = Fixture(0);
        var before = JsonSerializer.SerializeToUtf8Bytes(result, Options);
        var frame = host.Send(result);
        Assert.True(frame.Length <= FrameLimit);
        using var document = JsonDocument.Parse(frame);
        var payload = document.RootElement.GetProperty("payload");
        Assert.Equal("candidate", payload.GetProperty("authority").GetString());
        Assert.False(payload.GetProperty("nativeFormatAuthority").GetBoolean());
        var emitted = payload.GetProperty("result");
        Assert.Equal(Encoding.UTF8.GetString(before), emitted.GetRawText());
        Assert.False(emitted.GetProperty("data").TryGetProperty("fileBacked", out _));
        Assert.Empty(Directory.GetFiles(host.ArtifactRoot));
        Assert.Equal(before, JsonSerializer.SerializeToUtf8Bytes(result, Options));
    }

    [Fact]
    public async Task FileBackedSerializerOutputKeepsExactArtifactAndDescriptorMetadata()
    {
        using var host = new ActualState();
        var result = Fixture(2 * FrameLimit);
        var before = JsonSerializer.SerializeToUtf8Bytes(result, Options);
        var frame = host.Send(result);
        using var document = JsonDocument.Parse(frame);
        var emitted = document.RootElement.GetProperty("payload").GetProperty("result");
        var descriptor = emitted.GetProperty("data").GetProperty("fileBacked");
        Assert.True(Encoding.UTF8.GetByteCount(frame) <= FrameLimit);
        Assert.Equal("bridge-result-json", descriptor.GetProperty("payloadFormat").GetString());
        Assert.Equal(1, descriptor.GetProperty("payloadVersion").GetInt32());
        Assert.Equal(before.Length, descriptor.GetProperty("byteLength").GetInt32());
        Assert.Equal("source-revision-中文-😀", descriptor.GetProperty("sourceRevision").GetString());
        Assert.Equal("file://fixture", descriptor.GetProperty("sourceUri").GetString());
        Assert.Equal(1.25, descriptor.GetProperty("duration").GetDouble());
        Assert.Equal(17, descriptor.GetProperty("frameCount").GetInt64());
        Assert.Equal(3, descriptor.GetProperty("boneCount").GetInt64());
        var diagnostics = emitted.GetProperty("diagnostics").EnumerateArray().ToArray();
        Assert.Equal(2, diagnostics.Length);
        Assert.Equal("fixture", diagnostics[0].GetProperty("code").GetString());
        Assert.Equal("BRIDGE_RESULT_FILE_BACKED", diagnostics[1].GetProperty("code").GetString());
        var details = diagnostics[1].GetProperty("details");
        Assert.Equal("read-msb-document", details.GetProperty("command").GetString());
        Assert.True(details.GetProperty("serializedBytes").GetInt32() > FrameLimit);
        Assert.Equal(FrameLimit, details.GetProperty("maxFrameBytes").GetInt32());
        var token = descriptor.GetProperty("artifactToken").GetString()!;
        Assert.Equal(token, details.GetProperty("artifactToken").GetString());
        Assert.Equal(before.Length, details.GetProperty("artifactByteLength").GetInt32());
        var chunkSize = descriptor.GetProperty("chunkSize").GetInt32();
        Assert.InRange(chunkSize, 1, FrameLimit);
        Assert.Equal(chunkSize, details.GetProperty("artifactChunkSize").GetInt32());
        Assert.Equal(details.GetProperty("serializedBytes").GetInt32(), descriptor.GetProperty("diagnostics").GetProperty("serializedBytes").GetInt32());
        var stored = File.ReadAllBytes(Path.Combine(host.ArtifactRoot, token + ".json"));
        Assert.Equal(before, stored);
        Assert.Equal(SHA256.HashData(before), SHA256.HashData(stored));
        using var full = new MemoryStream();
        for (var offset = 0; offset < before.Length;)
        {
            var count = Math.Min(chunkSize, before.Length - offset);
            var chunk = await host.Read(token, offset, count, CancellationToken.None);
            Assert.Equal("partial", chunk.ParseStatus);
            var data = JsonSerializer.SerializeToElement(chunk.Data, Options);
            var bytes = Convert.FromBase64String(data.GetProperty("dataBase64").GetString()!);
            Assert.Equal(count, bytes.Length);
            Assert.Equal(before.Length, data.GetProperty("totalLength").GetInt32());
            Assert.Equal(offset + count == before.Length, data.GetProperty("complete").GetBoolean());
            // Send the real chunk result through the actual serializer/queue as
            // well as reconstructing it through the real artifact command.
            var chunkFrame = host.Send(chunk);
            Assert.True(Encoding.UTF8.GetByteCount(chunkFrame.TrimEnd('\n')) <= FrameLimit);
            using var chunkDocument = JsonDocument.Parse(chunkFrame);
            Assert.Equal(data.GetProperty("dataBase64").GetString(), chunkDocument.RootElement
                .GetProperty("payload").GetProperty("result").GetProperty("data").GetProperty("dataBase64").GetString());
            full.Write(bytes); offset += count;
        }
        Assert.Equal(before, full.ToArray());
        Assert.Equal(before, JsonSerializer.SerializeToUtf8Bytes(result, Options));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DefaultFrameLimitSelectsInlineOrArtifactWithinThirtyTwoBytes(bool oversized)
    {
        using var host = new ActualState();
        var empty = BridgeResult<object>.Ok("result-transport-fixture.msb", "msb", new { blob = "" });
        var overhead = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(host.MakeFrame(empty), Options));
        // Real CreateFrame timestamps can vary in fractional precision. Keep
        // the case within 32 bytes of the real default gate without a clock seam.
        var payloadLength = FrameLimit - overhead + (oversized ? 16 : -16);
        var result = empty with { Data = new { blob = new string('a', payloadLength) } };
        var frame = host.Send(result);
        using var doc = JsonDocument.Parse(frame);
        var data = doc.RootElement.GetProperty("payload").GetProperty("result").GetProperty("data");
        Assert.Equal(oversized, data.TryGetProperty("fileBacked", out var descriptor));
        if (oversized)
            Assert.InRange(descriptor.GetProperty("diagnostics").GetProperty("serializedBytes").GetInt32(), FrameLimit + 1, FrameLimit + 32);
        else
            Assert.InRange(Encoding.UTF8.GetByteCount(frame.TrimEnd('\n')), FrameLimit - 32, FrameLimit);
    }

    [Fact]
    public async Task FileBackedResultAvoidsASecondFullUtf16CopyAtTheActualBoundary()
    {
        using var host = new ActualState();
        const int payloadBytes = 4 * FrameLimit;
        var result = BridgeResult<object>.Ok("result-transport-fixture.msb", "msb", new { sourceHash = "revision", blob = new string('a', payloadBytes) });
        var resultBytes = JsonSerializer.SerializeToUtf8Bytes(result, Options).Length;
        for (var warmup = 0; warmup < 3; warmup++) _ = host.Send(result);
        host.Writer.Arm();
        var thread = Environment.CurrentManagedThreadId;
        var before = GC.GetAllocatedBytesForCurrentThread();
        var task = host.Write(result);
        Assert.True(task.IsCompletedSuccessfully, "This calling-thread bound requires synchronous enqueue with no backlog.");
        await task;
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(thread, Environment.CurrentManagedThreadId);
        host.Writer.WaitFlushed();
        // This ASCII fixture has one large value and tiny structural metadata.
        // Existing full-frame UTF16 (2N), result UTF8 (N), and parsed UTF8 (N)
        // account for about 4N. One N plus 256 KiB is headroom for serializer,
        // DOM/descriptor/queue setup, not a process/page/retained-heap budget.
        // Reintroducing the explicit full UTF16 decode adds 2N and fails here.
        var limit = 5L * resultBytes + 256 * 1024;
        Assert.True(allocated < limit,
            $"Actual WriteResultAsync allocated {allocated} calling-thread bytes for {resultBytes} UTF8 result bytes; limit {limit} excludes a redundant full UTF16 copy.");
    }

    [Fact]
    public async Task ArtifactReadsHonorCancellationAndClosedOutputRejectsAdmission()
    {
        using var host = new ActualState();
        var result = Fixture(2 * FrameLimit);
        using var frame = JsonDocument.Parse(host.Send(result));
        var descriptor = frame.RootElement.GetProperty("payload").GetProperty("result").GetProperty("data").GetProperty("fileBacked");
        var token = descriptor.GetProperty("artifactToken").GetString()!;
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => host.Read(token, 0, 1, cancelled.Token));
        Assert.Equal(BridgeCancelDisposition.NotFound, host.Cancel("unadmitted-request"));
        host.Stop();
        var inline = Fixture(0);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => host.Write(inline));
        Assert.Single(Directory.GetFiles(host.ArtifactRoot));
    }

    [Fact]
    public void DisposingStateRemovesOnlyItsOwnArtifactDirectory()
    {
        var host = new ActualState();
        var root = host.ArtifactRoot;
        var sibling = Path.Combine(Path.GetDirectoryName(root)!, "sentinel-" + Guid.NewGuid().ToString("N"));
        File.WriteAllText(sibling, "preserve sibling ownership");
        try
        {
            _ = host.Send(Fixture(2 * FrameLimit));
            Assert.Single(Directory.GetFiles(root));
            host.Dispose();
            Assert.False(Directory.Exists(root));
            Assert.Equal("preserve sibling ownership", File.ReadAllText(sibling));
        }
        finally { host.Dispose(); File.Delete(sibling); }
    }

    private static BridgeResult<object> Fixture(int padding) => BridgeResult<object>.Partial(
        "result-transport-fixture.msb", "msb", new[] { new Diagnostic("info", "fixture", "中文 😀 \"slash\\\n\t\u0001", "file://fixture") },
        new { sourceHash = "source-revision-中文-😀", animationContainerHash = "unused-fallback", duration = 1.25, frameCount = 17L, boneCount = 3L,
            text = "中文 😀 \"quote\" \\ slash\n\r\t\u0000\u001f", small = 0.000003d, negativeZero = -0d, maximum = long.MaxValue,
            nan = double.NaN, positiveInfinity = double.PositiveInfinity, negativeInfinity = double.NegativeInfinity, omitted = (string?)null,
            nested = new object?[] { null, new { value = "嵌套 😀", flag = true }, 1.5d }, blob = new string('a', padding) });

    private sealed class ActualState : IDisposable
    {
        private readonly object state;
        private readonly Func<BridgeInboundFrame, string, string, BridgeResult<object>, Task> write;
        private readonly Func<JsonElement?, string, CancellationToken, Task<BridgeResult<object>>> read;
        private readonly Func<string, string?, string?, string?, object, BridgeOutboundFrame> create;
        private readonly Func<Task> stop;
        private readonly BridgeInboundFrame request = new() { ProtocolVersion = "1.0.0", Kind = "request", RequestId = "fixture-request", WorkspaceSessionId = "fixture-workspace", ResourceUri = "file://fixture" };
        private bool stopped;
        private bool disposed;
        public CaptureWriter Writer { get; } = new();
        public string ArtifactRoot { get; }
        public Func<string, BridgeCancelDisposition> Cancel { get; }
        public ActualState()
        {
            var type = typeof(BridgeDaemonHost).GetNestedType("DaemonState", BindingFlags.NonPublic)!;
            var cache = MapStaticGeometryService.CreateResourceCache();
            state = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Single().Invoke(new object[] { Writer, cache });
            write = Bind<Func<BridgeInboundFrame, string, string, BridgeResult<object>, Task>>(type, "WriteResultAsync");
            read = Bind<Func<JsonElement?, string, CancellationToken, Task<BridgeResult<object>>>>(type, "ReadArtifactAsync");
            create = Bind<Func<string, string?, string?, string?, object, BridgeOutboundFrame>>(type, "CreateFrame");
            stop = Bind<Func<Task>>(type, "StopAsync");
            Cancel = Bind<Func<string, BridgeCancelDisposition>>(type, "CancelRequest");
            var artifacts = type.GetField("_artifacts", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(state)!;
            ArtifactRoot = (string)typeof(BridgeArtifactStore).GetField("root", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(artifacts)!;
            Assert.Equal(FrameLimit, type.GetProperty("MaxFrameBytes")!.GetValue(state));
            Assert.Equal(1, type.GetProperty("MaxConcurrency")!.GetValue(state));
        }
        private T Bind<T>(Type type, string name) where T : Delegate =>
            (T)type.GetMethod(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!.CreateDelegate(typeof(T), state);
        public Task Write(BridgeResult<object> result) => write(request, "read-msb-document", "candidate", result);
        public string Send(BridgeResult<object> result)
        {
            Writer.Arm(); Write(result).GetAwaiter().GetResult(); Writer.WaitFlushed(); return Writer.Snapshot();
        }
        public BridgeOutboundFrame MakeFrame(BridgeResult<object> result) => create("result", request.RequestId, request.WorkspaceSessionId, request.ResourceUri,
            new { authority = "candidate", nativeFormatAuthority = false, result });
        public Task<BridgeResult<object>> Read(string token, int offset, int length, CancellationToken cancellationToken) =>
            read(JsonSerializer.SerializeToElement(new { artifactToken = token, offset, length }, Options), "result-transport-fixture.msb", cancellationToken);
        public void Stop() { if (!stopped) { stop().GetAwaiter().GetResult(); stopped = true; } }
        public void Dispose()
        {
            if (disposed) return;
            try { Stop(); }
            finally { ((IDisposable)state).Dispose(); Writer.Dispose(); disposed = true; }
        }
    }

    public sealed class CaptureWriter : TextWriter
    {
        private readonly StringBuilder output = new(FrameLimit + 1024);
        private readonly ManualResetEventSlim flushed = new(false);
        public override Encoding Encoding => Encoding.UTF8;
        public void Arm() { flushed.Reset(); output.Clear(); }
        public override Task WriteAsync(ReadOnlyMemory<char> text, CancellationToken cancellationToken = default)
        { output.Append(text.Span); return Task.CompletedTask; }
        public override Task FlushAsync() { flushed.Set(); return Task.CompletedTask; }
        public void WaitFlushed() => Assert.True(flushed.Wait(TimeSpan.FromSeconds(10)), "Actual output pump did not flush.");
        public string Snapshot() => output.ToString();
        protected override void Dispose(bool disposing) { if (disposing) flushed.Dispose(); base.Dispose(disposing); }
    }
}

using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

[Collection("Bridge result transport")]
public sealed class BridgeInlineStreamTests
{
    private const int Limit = 16 * 1024 * 1024;
    private static readonly BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
    private static JsonSerializerOptions Options => (JsonSerializerOptions)typeof(BridgeDaemonHost)
        .GetField("JsonOptions", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
    private static Type SinkType => typeof(BridgeDaemonHost).Assembly.GetType("BridgeUtf8StreamWriter")
        ?? throw new Xunit.Sdk.XunitException("The separately named borrowed UTF8 stream sink is missing.");
    private static TextWriter Sink(Stream stream) => (TextWriter)Activator.CreateInstance(SinkType, stream)!;

    [Fact]
    public async Task StreamEntryPreservesLegacyEntryAndBorrowedStreamLifecycle()
    {
        Assert.Single(typeof(BridgeDaemonHost).GetMethods(), method => method.Name == "RunAsync");
        Assert.Single(typeof(BridgeDaemonHost).GetNestedType("DaemonState", BindingFlags.NonPublic)!.GetConstructors(PrivateInstance));
        var method = typeof(BridgeDaemonHost).GetMethod("RunStreamAsync");
        Assert.NotNull(method);
        using var actual = new RecordingStream();
        await (Task)method!.Invoke(null, new object[] { new StringReader("{}\n"), actual, CancellationToken.None })!;
        using var reference = new RecordingStream();
        await using (var writer = new StreamWriter(reference, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
        { AutoFlush = true, NewLine = "\n" })
            await BridgeDaemonHost.RunAsync(new StringReader("{}\n"), writer, CancellationToken.None);
        Assert.Equal(Normalize(reference.Bytes()), Normalize(actual.Bytes()));
        Assert.Equal(reference.Events, actual.Events);
        Assert.False(actual.Disposed);
        Assert.False(actual.Bytes().AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }));
        Assert.Equal((byte)'\n', actual.Bytes()[^1]);
    }

    [Fact]
    public async Task PreCancelledEntryDrainsAndDoesNotCloseBorrowedOutput()
    {
        var method = typeof(BridgeDaemonHost).GetMethod("RunStreamAsync"); Assert.NotNull(method);
        using var stream = new RecordingStream(); using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        await (Task)method!.Invoke(null, new object[] { new StringReader("{}\n"), stream, cancellation.Token })!;
        Assert.Empty(stream.Bytes()); Assert.False(stream.Disposed);
        Assert.Equal(new[] { "sync-flush", "flush" }, stream.Events);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task StartupAndFinalFlushFailuresPreserveExceptionAndBorrowedOwnership(bool startup)
    {
        var method = typeof(BridgeDaemonHost).GetMethod("RunStreamAsync"); Assert.NotNull(method);
        using var stream = new RecordingStream { FailSyncFlush = startup, FailAsyncFlush = startup ? 0 : 4 };
        var exception = await Assert.ThrowsAsync<IOException>(() => (Task)method!.Invoke(null,
            new object[] { new StringReader("{}\n"), stream, CancellationToken.None })!);
        Assert.Same(stream.Failure, exception); Assert.False(stream.Disposed);
        if (startup) Assert.Empty(stream.Bytes());
        else Assert.Equal((byte)'\n', stream.Bytes()[^1]);
    }

    [Fact]
    public async Task SerializationAndBodyWriteFailuresDoNotReplayOrEmitSuccessfulResult()
    {
        using var stream = new RecordingStream { FailWrite = true }; using var state = new ActualState(Sink(stream));
        var cycle = new Dictionary<string, object>(); cycle["self"] = cycle;
        await Assert.ThrowsAsync<JsonException>(() => state.Write(BridgeResult<object>.Ok("inline.msb", "msb", cycle)));
        Assert.Empty(stream.Bytes()); Assert.Equal(0, state.ArtifactCount);
        await state.Write(BridgeResult<object>.Ok("inline.msb", "msb", new { value = 1 }));
        var exception = await Assert.ThrowsAsync<IOException>(() => state.Stop());
        Assert.Same(stream.Failure, exception); Assert.Empty(stream.Bytes());
        Assert.Equal(1, stream.Events.Count(value => value == "body")); Assert.False(stream.Disposed);
    }

    [Fact]
    public async Task ActualHandshakeCancelAndWorkspaceCloseKeepLegacyTerminalFrames()
    {
        var method = typeof(BridgeDaemonHost).GetMethod("RunStreamAsync"); Assert.NotNull(method);
        var frames = new object[]
        {
            new { protocolVersion = "1.0.0", kind = "handshake", requestId = "h", workspaceSessionId = "owned",
                payload = new { allowedRoots = new[] { Path.GetTempPath() }, maxFrameBytes = Limit, maxConcurrency = 1 } },
            new { protocolVersion = "1.0.0", kind = "cancel", requestId = "c", workspaceSessionId = "owned", payload = new { targetRequestId = "missing" } },
            new { protocolVersion = "1.0.0", kind = "workspace/close", requestId = "x", workspaceSessionId = "owned" }
        };
        var input = string.Join('\n', frames.Select(frame => JsonSerializer.Serialize(frame, Options))) + "\n";
        using var actual = new RecordingStream(); using var reference = new RecordingStream();
        await (Task)method!.Invoke(null, new object[] { new StringReader(input), actual, CancellationToken.None })!;
        await using (var writer = new StreamWriter(reference, new UTF8Encoding(false), 64 * 1024, leaveOpen: true) { AutoFlush = true, NewLine = "\n" })
            await BridgeDaemonHost.RunAsync(new StringReader(input), writer, CancellationToken.None);
        var actualFrames = Encoding.UTF8.GetString(actual.Bytes()).TrimEnd('\n').Split('\n');
        var referenceFrames = Encoding.UTF8.GetString(reference.Bytes()).TrimEnd('\n').Split('\n');
        Assert.Equal(referenceFrames.Select(frame => Normalize(Encoding.UTF8.GetBytes(frame + "\n"))),
            actualFrames.Select(frame => Normalize(Encoding.UTF8.GetBytes(frame + "\n"))));
        Assert.Equal("BRIDGE_REQUEST_NOT_ACTIVE", JsonNode.Parse(actualFrames[1])!["payload"]!["code"]!.GetValue<string>());
        Assert.Equal(reference.Events, actual.Events); Assert.False(actual.Disposed);
    }

    [Fact]
    public void ActualFrameFactoryAndOptionsProduceByteIdenticalUtf8()
    {
        using var stream = new RecordingStream(); using var state = new ActualState(Sink(stream));
        var result = BridgeResult<object>.Ok("中文", "msb", new { text = "😀\u0001\"\\", nan = double.NaN, integer = long.MaxValue, omitted = (string?)null });
        var frame = state.MakeFrame(result);
        var item = state.Serialize(frame);
        Assert.Equal(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(frame, Options)), item.Utf8);
        Assert.Equal(item.Utf8!.Length + 1, item.ByteLength); Assert.Null(item.Json);
    }

    [Fact]
    public async Task InlineFramesPreserveCompleteUnicodeNumbersDiagnosticsAndTerminalOrder()
    {
        using var stream = new RecordingStream(); using var state = new ActualState(Sink(stream));
        var result = BridgeResult<object>.Partial("inline-中文.msb", "msb", new[] { new Diagnostic("info", "fixture", "😀\n\t", "file://fixture") },
            new { text = "中文 😀 \"quote\" \\ \n\r\t\u0000", nan = double.NaN, inf = double.PositiveInfinity,
                negativeZero = -0d, maximum = long.MaxValue, omitted = (string?)null, nested = new object?[] { null, true, 1.25d } });
        await state.Write(result);
        await state.WriteFrame("cancelled", "cancel", new { code = "BRIDGE_REQUEST_CANCELLED" });
        await state.WriteFrame("failed", "fail", new { code = "BRIDGE_REQUEST_FAILED" });
        await state.Stop();
        var frames = Encoding.UTF8.GetString(stream.Bytes()).TrimEnd('\n').Split('\n');
        Assert.Equal(3, frames.Length);
        using var first = JsonDocument.Parse(frames[0]);
        Assert.Equal(JsonSerializer.SerializeToElement(result, Options).GetRawText(), first.RootElement.GetProperty("payload").GetProperty("result").GetRawText());
        Assert.Equal(new[] { "result", "cancelled", "failed" }, frames.Select(frame => JsonNode.Parse(frame)!["kind"]!.GetValue<string>()));
        Assert.Equal(0, state.ArtifactCount);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => state.Write(result));
        Assert.False(stream.Disposed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NormalSixteenMiBGateStillUsesExactEncodedBytes(bool oversized)
    {
        using var stream = new RecordingStream(); using var state = new ActualState(Sink(stream));
        var empty = BridgeResult<object>.Ok("inline.msb", "msb", new { blob = "" });
        var overhead = JsonSerializer.SerializeToUtf8Bytes(state.MakeFrame(empty), Options).Length;
        var result = empty with { Data = new { blob = new string('a', Limit - overhead + (oversized ? 16 : -16)) } };
        await state.Write(result); await state.Stop();
        var bytes = stream.Bytes(); using var frame = JsonDocument.Parse(bytes.AsMemory(0, bytes.Length - 1));
        var data = frame.RootElement.GetProperty("payload").GetProperty("result").GetProperty("data");
        Assert.Equal(oversized, data.TryGetProperty("fileBacked", out _));
        Assert.Equal(oversized ? 1 : 0, state.ArtifactCount);
        if (!oversized) Assert.InRange(bytes.Length - 1, Limit - 32, Limit);
        else
        {
            using var stored = File.OpenRead(state.SingleArtifactPath);
            Assert.Equal(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(result, Options)), SHA256.HashData(stored));
        }
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task BodyNewlineAndExplicitFlushFailuresRemainObservable(int failingFlush)
    {
        using var stream = new RecordingStream { FailAsyncFlush = failingFlush };
        using var state = new ActualState(Sink(stream));
        await state.WriteFrame("failed", "fault", new { code = "fixture" });
        var exception = await Assert.ThrowsAsync<IOException>(() => state.Stop());
        Assert.Same(stream.Failure, exception);
        Assert.Equal(failingFlush, stream.AsyncFlushes);
        Assert.Equal(failingFlush > 1, stream.Bytes()[^1] == (byte)'\n');
        Assert.False(stream.Disposed);
    }

    [Fact]
    public async Task ByteQueuePreservesCapacityCancellationAndProgressMovesToTail()
    {
        BridgeOutputItem Item(string text, bool progress = false, string? id = null)
        {
            var constructor = typeof(BridgeOutputItem).GetConstructor(new[] { typeof(byte[]), typeof(bool), typeof(string) });
            Assert.NotNull(constructor);
            return (BridgeOutputItem)constructor!.Invoke(new object?[] { Encoding.UTF8.GetBytes(text), progress, id });
        }
        var queue = new BoundedOutputQueue(12);
        await queue.EnqueueAsync(Item("旧", true, "r"), CancellationToken.None); // four bytes with LF
        await queue.EnqueueAsync(Item("other"), CancellationToken.None);
        await queue.EnqueueAsync(Item("新", true, "r"), CancellationToken.None);
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => queue.EnqueueAsync(Item("xx"), cancelled.Token));
        await Assert.ThrowsAsync<InvalidDataException>(() => queue.EnqueueAsync(Item(new string('x', 12)), CancellationToken.None));
        queue.Complete();
        var drained = new List<BridgeOutputItem>(); await foreach (var item in queue.ReadAllAsync(CancellationToken.None)) drained.Add(item);
        Assert.Equal(new[] { 6, 4 }, drained.Select(item => item.ByteLength));
        var bytes = typeof(BridgeOutputItem).GetProperty("Utf8")!;
        Assert.Equal(new[] { "other", "新" }, drained.Select(item => Encoding.UTF8.GetString((byte[])bytes.GetValue(item)!)));
        await Assert.ThrowsAsync<ObjectDisposedException>(() => queue.EnqueueAsync(Item("x"), CancellationToken.None));
        Assert.Equal(0L, typeof(BoundedOutputQueue).GetField("_bytes", PrivateInstance)!.GetValue(queue));
    }

    private static string Normalize(byte[] bytes)
    {
        var node = JsonNode.Parse(bytes.AsSpan(0, bytes.Length - 1))!; node["timestampUtc"] = "clock"; return node.ToJsonString();
    }

    private sealed class ActualState : IDisposable
    {
        private readonly object state;
        private readonly Type type = typeof(BridgeDaemonHost).GetNestedType("DaemonState", BindingFlags.NonPublic)!;
        private readonly BridgeInboundFrame request = new() { ProtocolVersion = "1.0.0", Kind = "request", RequestId = "inline", WorkspaceSessionId = "owned", ResourceUri = "file://fixture" };
        private bool stopped;
        public ActualState(TextWriter writer)
        {
            state = type.GetConstructors(PrivateInstance).Single().Invoke(new object[] { writer, MapStaticGeometryService.CreateResourceCache() });
            type.GetMethod("Configure")!.Invoke(state, new object?[] { "owned", Array.Empty<string>(), Array.Empty<string>(), Limit, 1, null });
        }
        public Task Write(BridgeResult<object> result) => (Task)type.GetMethod("WriteResultAsync")!.Invoke(state, new object[] { request, "read-msb-document", "candidate", result })!;
        public Task WriteFrame(string kind, string id, object payload) => (Task)type.GetMethod("WriteAsync")!.Invoke(state, new object?[] { kind, id, "owned", "file://fixture", payload })!;
        public BridgeOutboundFrame MakeFrame(BridgeResult<object> result) => (BridgeOutboundFrame)type.GetMethod("CreateFrame", PrivateInstance)!.Invoke(state,
            new object?[] { "result", request.RequestId, request.WorkspaceSessionId, request.ResourceUri, new { authority = "candidate", nativeFormatAuthority = false, result } })!;
        public BridgeOutputItem Serialize(BridgeOutboundFrame frame) => (BridgeOutputItem)type.GetMethod("SerializeFrame", PrivateInstance)!.Invoke(state, new object?[] { frame, "result", request.RequestId })!;
        private string ArtifactRoot => (string)typeof(BridgeArtifactStore).GetField("root", PrivateInstance)!.GetValue(type.GetField("_artifacts", PrivateInstance)!.GetValue(state)!)!;
        public int ArtifactCount => Directory.GetFiles(ArtifactRoot).Length;
        public string SingleArtifactPath => Directory.GetFiles(ArtifactRoot).Single();
        public Task Stop() { stopped = true; return (Task)type.GetMethod("StopAsync")!.Invoke(state, null)!; }
        public void Dispose() { try { if (!stopped) Stop().GetAwaiter().GetResult(); } finally { ((IDisposable)state).Dispose(); } }
    }

    private sealed class RecordingStream : Stream
    {
        private readonly MemoryStream buffer = new();
        public List<string> Events { get; } = new();
        public IOException Failure { get; } = new("owned flush failure");
        public int FailAsyncFlush { get; init; }
        public bool FailSyncFlush { get; init; }
        public bool FailWrite { get; init; }
        public int AsyncFlushes { get; private set; }
        public bool Disposed { get; private set; }
        public byte[] Bytes() => buffer.ToArray();
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => buffer.Length; public override long Position { get => buffer.Position; set => throw new NotSupportedException(); }
        public override void Flush() { Events.Add("sync-flush"); if (FailSyncFlush) throw Failure; }
        public override Task FlushAsync(CancellationToken cancellationToken = default)
        { Events.Add("flush"); AsyncFlushes++; return AsyncFlushes == FailAsyncFlush ? Task.FromException(Failure) : Task.CompletedTask; }
        public override void Write(byte[] bytes, int offset, int count) => buffer.Write(bytes, offset, count);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken = default)
        { Events.Add(bytes.Span.SequenceEqual("\n"u8) ? "newline" : "body"); if (FailWrite) return ValueTask.FromException(Failure); buffer.Write(bytes.Span); return ValueTask.CompletedTask; }
        public override int Read(byte[] bytes, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { Disposed = true; if (disposing) buffer.Dispose(); base.Dispose(disposing); }
    }
}

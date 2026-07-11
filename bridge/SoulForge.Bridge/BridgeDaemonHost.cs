using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class BridgeDaemonHost
{
    internal const string ProtocolVersion = "1.0.0";
    private const int DefaultMaxFrameBytes = 1024 * 1024;
    // Large PARAM/MSB child snapshots are base64-framed over NDJSON.
    private const int AbsoluteMaxFrameBytes = 32 * 1024 * 1024;
    private const int MaxAllowedRoots = 16;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    public static async Task RunAsync(
        TextReader input,
        TextWriter output,
        CancellationToken cancellationToken)
    {
        var state = new DaemonState(output);
        var running = new ConcurrentDictionary<string, Task>(StringComparer.Ordinal);

        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await input.ReadLineAsync(cancellationToken);
            if (line is null) break;
            if (string.IsNullOrWhiteSpace(line)) continue;

            if (Encoding.UTF8.GetByteCount(line) > state.MaxFrameBytes)
            {
                await state.WriteFailureAsync(null, null, "BRIDGE_FRAME_TOO_LARGE", "NDJSON frame exceeds the negotiated byte limit.");
                continue;
            }

            BridgeInboundFrame? frame;
            try
            {
                frame = JsonSerializer.Deserialize<BridgeInboundFrame>(line, JsonOptions);
            }
            catch (JsonException ex)
            {
                await state.WriteFailureAsync(null, null, "BRIDGE_INVALID_FRAME", ex.Message);
                continue;
            }

            if (frame is null || string.IsNullOrWhiteSpace(frame.Kind))
            {
                await state.WriteFailureAsync(frame?.RequestId, frame?.WorkspaceSessionId, "BRIDGE_INVALID_FRAME", "Frame kind is required.");
                continue;
            }
            if (!string.Equals(frame.ProtocolVersion, ProtocolVersion, StringComparison.Ordinal))
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_PROTOCOL_MISMATCH", $"Expected protocol {ProtocolVersion}.");
                continue;
            }

            switch (frame.Kind)
            {
                case "handshake":
                    await HandleHandshakeAsync(frame, state);
                    break;
                case "health":
                    await EnsureSessionAndWriteAsync(frame, state, "health", new
                    {
                        status = "ok",
                        processId = Environment.ProcessId,
                        runtime = Environment.Version.ToString(),
                        activeRequests = state.ActiveRequestCount,
                        oodleRuntime = OodleRuntimeLocator.Probe(state.OodleRuntimeRoot).Runtime
                    });
                    break;
                case "capabilities":
                    await EnsureSessionAndWriteAsync(frame, state, "capabilities", BuildCapabilities(state.OodleRuntimeRoot));
                    break;
                case "cancel":
                    await HandleCancelAsync(frame, state);
                    break;
                case "request":
                    if (!state.IsSessionValid(frame.WorkspaceSessionId))
                    {
                        await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_SESSION_INVALID", "A valid handshake is required before requests.");
                        break;
                    }
                    if (string.IsNullOrWhiteSpace(frame.RequestId))
                    {
                        await state.WriteFailureAsync(null, frame.WorkspaceSessionId, "BRIDGE_REQUEST_ID_REQUIRED", "requestId is required.");
                        break;
                    }
                    if (running.ContainsKey(frame.RequestId))
                    {
                        await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_DUPLICATE_REQUEST", "requestId is already active.");
                        break;
                    }

                    var requestId = frame.RequestId!;
                    await state.WriteAsync("request/accepted", requestId, frame.WorkspaceSessionId, frame.ResourceUri, new
                    {
                        acceptedAt = DateTimeOffset.UtcNow
                    });
                    var requestTask = HandleRequestAsync(frame, state);
                    running[requestId] = requestTask;
                    _ = requestTask.ContinueWith(
                        completedTask => running.TryRemove(requestId, out _),
                        CancellationToken.None,
                        TaskContinuationOptions.ExecuteSynchronously,
                        TaskScheduler.Default);
                    break;
                default:
                    await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_FRAME_KIND_UNKNOWN", $"Unknown frame kind: {frame.Kind}");
                    break;
            }
        }

        await Task.WhenAll(running.Values);
        state.Dispose();
    }

    private static async Task HandleHandshakeAsync(BridgeInboundFrame frame, DaemonState state)
    {
        if (state.IsConfigured)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_ALREADY_HANDSHAKEN", "Bridge daemon accepts exactly one workspace handshake per process.");
            return;
        }
        if (string.IsNullOrWhiteSpace(frame.RequestId) || string.IsNullOrWhiteSpace(frame.WorkspaceSessionId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_HANDSHAKE_INVALID", "requestId and workspaceSessionId are required.");
            return;
        }

        BridgeHandshakePayload? payload;
        try
        {
            if (frame.Payload is not { ValueKind: JsonValueKind.Object } payloadElement)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_HANDSHAKE_INVALID", "Handshake payload must be an object.");
                return;
            }
            payload = payloadElement.Deserialize<BridgeHandshakePayload>(JsonOptions);
        }
        catch (JsonException ex)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_HANDSHAKE_INVALID", ex.Message);
            return;
        }

        if (payload?.AllowedRoots is null || payload.AllowedRoots.Length is < 1 or > MaxAllowedRoots)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_ALLOWED_ROOTS_INVALID", $"Handshake requires 1-{MaxAllowedRoots} allowed roots.");
            return;
        }

        var roots = new List<string>(payload.AllowedRoots.Length);
        foreach (var root in payload.AllowedRoots)
        {
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_ALLOWED_ROOT_INVALID", "Every allowed root must be an existing directory.");
                return;
            }
            roots.Add(BridgePathBoundary.ResolveExistingPath(root));
        }

        var configuredWritableRoots = payload.WritableRoots ?? Array.Empty<string>();
        var writableRoots = new List<string>(configuredWritableRoots.Length);
        foreach (var root in configuredWritableRoots)
        {
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_WRITABLE_ROOT_INVALID", "Every writable root must be an existing directory.");
                return;
            }
            var boundary = BridgePathBoundary.Verify(root, roots);
            if (!boundary.Ok)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_WRITABLE_ROOT_OUTSIDE_ALLOWED_ROOTS", "Writable roots must also be included in allowedRoots.");
                return;
            }
            writableRoots.Add(boundary.CanonicalPath);
        }

        string? oodleRuntimeRoot = null;
        if (!string.IsNullOrWhiteSpace(payload.OodleRuntimeRoot))
        {
            if (!Directory.Exists(payload.OodleRuntimeRoot))
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "OODLE_GAME_ROOT_MISSING", "Configured Sekiro game root does not exist.");
                return;
            }
            var boundary = BridgePathBoundary.Verify(payload.OodleRuntimeRoot, roots);
            if (!boundary.Ok)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, boundary.Code, boundary.Message);
                return;
            }
            oodleRuntimeRoot = boundary.CanonicalPath;
        }

        state.Configure(
            frame.WorkspaceSessionId,
            roots,
            writableRoots,
            Math.Clamp(payload.MaxFrameBytes ?? DefaultMaxFrameBytes, 64 * 1024, AbsoluteMaxFrameBytes),
            Math.Clamp(payload.MaxConcurrency ?? 2, 1, 8),
            oodleRuntimeRoot);

        await state.WriteAsync("handshake", frame.RequestId, frame.WorkspaceSessionId, null, new
        {
            bridgeId = "SoulForge.Bridge",
            protocolVersion = ProtocolVersion,
            processId = Environment.ProcessId,
            runtime = Environment.Version.ToString(),
            maxFrameBytes = state.MaxFrameBytes,
            maxConcurrency = state.MaxConcurrency,
            authorityLevels = new[] { "unsupported", "candidate", "fixture-confirmed", "native-verified" },
            capabilities = BuildCapabilities(state.OodleRuntimeRoot)
        });
    }

    private static async Task HandleRequestAsync(BridgeInboundFrame frame, DaemonState state)
    {
        BridgeRequestPayload? payload;
        try
        {
            if (frame.Payload is not { ValueKind: JsonValueKind.Object } payloadElement)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_REQUEST_INVALID", "Request payload must be an object.");
                return;
            }
            payload = payloadElement.Deserialize<BridgeRequestPayload>(JsonOptions);
        }
        catch (JsonException ex)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_REQUEST_INVALID", ex.Message);
            return;
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.Command) || string.IsNullOrWhiteSpace(payload.FilePath))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_REQUEST_INVALID", "command and filePath are required.");
            return;
        }

        var boundary = BridgePathBoundary.Verify(payload.FilePath, state.AllowedRoots);
        if (!boundary.Ok)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, boundary.Code, boundary.Message);
            return;
        }

        string? outputPath = null;
        if (payload.Command.Equals("write-bnd4", StringComparison.OrdinalIgnoreCase)
            || payload.Command.Equals("write-fmg", StringComparison.OrdinalIgnoreCase)
            || payload.Command.Equals("write-param", StringComparison.OrdinalIgnoreCase)
            || payload.Command.Equals("write-emevd", StringComparison.OrdinalIgnoreCase)
            || payload.Command.Equals("write-msb", StringComparison.OrdinalIgnoreCase))
        {
            if (payload.Options is not { ValueKind: JsonValueKind.Object }
                || !payload.Options.Value.TryGetProperty("outputPath", out var outputElement)
                || outputElement.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(outputElement.GetString()))
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_OUTPUT_PATH_REQUIRED", "Bridge writer command requires options.outputPath.");
                return;
            }
            outputPath = outputElement.GetString();
            if (state.WritableRoots.Count == 0)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_WRITABLE_ROOT_REQUIRED", "Bridge writer command requires a main-owned writable root.");
                return;
            }
            var outputBoundary = BridgePathBoundary.Verify(outputPath!, state.WritableRoots);
            if (!outputBoundary.Ok)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS", "Bridge writer output must stay inside a negotiated writable root.");
                return;
            }
            outputPath = outputBoundary.CanonicalPath;
        }

        using var requestCts = CancellationTokenSource.CreateLinkedTokenSource(state.ShutdownToken);
        if (frame.DeadlineUtc is { } deadline)
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_DEADLINE_EXCEEDED", "Request deadline has already elapsed.");
                return;
            }
            requestCts.CancelAfter(remaining);
        }

        if (!state.TryAddRequest(frame.RequestId!, requestCts))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_DUPLICATE_REQUEST", "requestId is already active.");
            return;
        }

        try
        {
            await state.Concurrency.WaitAsync(requestCts.Token);
            try
            {
                await state.WriteAsync("progress", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
                {
                    phase = "started",
                    completed = 0,
                    total = 1
                });
                var service = new BridgeCommandService();
                var result = await service.ExecuteAsync(
                    payload.Command,
                    boundary.CanonicalPath,
                    requestCts.Token,
                    state.OodleRuntimeRoot,
                    payload.Options ?? default,
                    outputPath);
                requestCts.Token.ThrowIfCancellationRequested();
                await state.WriteAsync("progress", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
                {
                    phase = "completed",
                    completed = 1,
                    total = 1
                });
                var authority = result.Diagnostics.Any(item => item.Code.Contains("SYNTHETIC", StringComparison.OrdinalIgnoreCase))
                    ? "fixture-confirmed"
                    : result.ParseStatus == "unsupported" ? "unsupported" : "candidate";
                await state.WriteAsync("result", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
                {
                    authority,
                    nativeFormatAuthority = false,
                    result
                });
            }
            finally
            {
                state.Concurrency.Release();
            }
        }
        catch (OperationCanceledException)
        {
            await state.WriteAsync("cancelled", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
            {
                code = "BRIDGE_REQUEST_CANCELLED",
                message = "Bridge request was cancelled or exceeded its deadline."
            });
        }
        catch (BridgeOutboundFrameTooLargeException)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_OUTBOUND_FRAME_TOO_LARGE", "Bridge result exceeds the negotiated frame-size limit; use a file-backed command instead.");
        }
        catch (Exception ex)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_REQUEST_FAILED", ex.Message);
        }
        finally
        {
            state.RemoveRequest(frame.RequestId!);
        }
    }

    private static async Task HandleCancelAsync(BridgeInboundFrame frame, DaemonState state)
    {
        if (!state.IsSessionValid(frame.WorkspaceSessionId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_SESSION_INVALID", "A valid handshake is required before cancellation.");
            return;
        }
        BridgeCancelPayload? payload;
        try
        {
            if (frame.Payload is not { ValueKind: JsonValueKind.Object } payloadElement)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_CANCEL_INVALID", "Cancel payload must be an object.");
                return;
            }
            payload = payloadElement.Deserialize<BridgeCancelPayload>(JsonOptions);
        }
        catch (JsonException)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_CANCEL_INVALID", "Cancel payload is invalid.");
            return;
        }
        if (payload is null || string.IsNullOrWhiteSpace(payload.TargetRequestId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_CANCEL_INVALID", "targetRequestId is required.");
            return;
        }
        if (!state.CancelRequest(payload.TargetRequestId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_REQUEST_NOT_ACTIVE", "The target request is not active.");
        }
    }

    private static async Task EnsureSessionAndWriteAsync(
        BridgeInboundFrame frame,
        DaemonState state,
        string kind,
        object payload)
    {
        if (!state.IsSessionValid(frame.WorkspaceSessionId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_SESSION_INVALID", "A valid handshake is required.");
            return;
        }
        await state.WriteAsync(kind, frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, payload);
    }

    private static object BuildCapabilities(string? oodleRuntimeRoot) => new
    {
        authority = "candidate",
        nativeFormatAuthority = false,
        commands = new[] { "inspect", "validate", "read-dcx-document", "snapshot-bnd4-child", "write-bnd4", "read-fmg-document", "write-fmg", "read-param-document", "write-param", "read-emevd-document", "write-emevd", "read-msb-document", "write-msb", "export-event", "export-map", "export-param", "export-msg", "probe-oodle" },
        envelopes = new[] { "DFLT-candidate", "KRAK-runtime-dependent", "BND4-unsupported" },
        oodleRuntime = OodleRuntimeLocator.Probe(oodleRuntimeRoot).Runtime,
        cancellation = true,
        progress = true
    };

    private sealed class DaemonState : IDisposable
    {
        private readonly TextWriter _output;
        private readonly SemaphoreSlim _outputLock = new(1, 1);
        private readonly ConcurrentDictionary<string, CancellationTokenSource> _requests = new(StringComparer.Ordinal);
        private readonly CancellationTokenSource _shutdown = new();
        private string? _workspaceSessionId;

        public DaemonState(TextWriter output)
        {
            _output = output;
            Concurrency = new SemaphoreSlim(1, 1);
        }

        public int MaxFrameBytes { get; private set; } = DefaultMaxFrameBytes;
        public int MaxConcurrency { get; private set; } = 1;
        public IReadOnlyList<string> AllowedRoots { get; private set; } = Array.Empty<string>();
        public IReadOnlyList<string> WritableRoots { get; private set; } = Array.Empty<string>();
        public string? OodleRuntimeRoot { get; private set; }
        public SemaphoreSlim Concurrency { get; private set; }
        public CancellationToken ShutdownToken => _shutdown.Token;
        public int ActiveRequestCount => _requests.Count;
        public bool IsConfigured => !string.IsNullOrWhiteSpace(_workspaceSessionId);

        public void Configure(
            string workspaceSessionId,
            IReadOnlyList<string> allowedRoots,
            IReadOnlyList<string> writableRoots,
            int maxFrameBytes,
            int maxConcurrency,
            string? oodleRuntimeRoot)
        {
            _workspaceSessionId = workspaceSessionId;
            AllowedRoots = allowedRoots;
            WritableRoots = writableRoots;
            MaxFrameBytes = maxFrameBytes;
            MaxConcurrency = maxConcurrency;
            OodleRuntimeRoot = oodleRuntimeRoot;
            var previous = Concurrency;
            Concurrency = new SemaphoreSlim(maxConcurrency, maxConcurrency);
            previous.Dispose();
        }

        public bool IsSessionValid(string? workspaceSessionId) =>
            !string.IsNullOrWhiteSpace(_workspaceSessionId)
            && string.Equals(_workspaceSessionId, workspaceSessionId, StringComparison.Ordinal);

        public bool TryAddRequest(string requestId, CancellationTokenSource cts) => _requests.TryAdd(requestId, cts);
        public void RemoveRequest(string requestId) => _requests.TryRemove(requestId, out _);
        public bool CancelRequest(string requestId)
        {
            if (!_requests.TryGetValue(requestId, out var cts)) return false;
            cts.Cancel();
            return true;
        }

        public async Task WriteFailureAsync(string? requestId, string? workspaceSessionId, string code, string message)
        {
            await WriteAsync("failed", requestId, workspaceSessionId, null, new
            {
                code,
                message,
                retryable = code is "BRIDGE_REQUEST_FAILED" or "BRIDGE_REQUEST_NOT_ACTIVE"
            });
        }

        public async Task WriteAsync(
            string kind,
            string? requestId,
            string? workspaceSessionId,
            string? resourceUri,
            object payload)
        {
            var frame = new BridgeOutboundFrame
            {
                ProtocolVersion = ProtocolVersion,
                Kind = kind,
                RequestId = requestId,
                WorkspaceSessionId = workspaceSessionId,
                ResourceUri = resourceUri,
                TimestampUtc = DateTimeOffset.UtcNow,
                Payload = payload
            };
            var json = JsonSerializer.Serialize(frame, JsonOptions);
            if (Encoding.UTF8.GetByteCount(json) > MaxFrameBytes)
            {
                throw new BridgeOutboundFrameTooLargeException();
            }
            await _outputLock.WaitAsync();
            try
            {
                await _output.WriteLineAsync(json);
                await _output.FlushAsync();
            }
            finally
            {
                _outputLock.Release();
            }
        }

        public void Dispose()
        {
            _shutdown.Cancel();
            foreach (var cts in _requests.Values) cts.Cancel();
            Concurrency.Dispose();
            _outputLock.Dispose();
            _shutdown.Dispose();
        }
    }
}

internal sealed class BridgeOutboundFrameTooLargeException : Exception;

internal sealed class BridgeInboundFrame
{
    public string? ProtocolVersion { get; init; }
    public string? Kind { get; init; }
    public string? RequestId { get; init; }
    public string? WorkspaceSessionId { get; init; }
    public DateTimeOffset? DeadlineUtc { get; init; }
    public string? ResourceUri { get; init; }
    public JsonElement? Payload { get; init; }
}

internal sealed class BridgeOutboundFrame
{
    public required string ProtocolVersion { get; init; }
    public required string Kind { get; init; }
    public string? RequestId { get; init; }
    public string? WorkspaceSessionId { get; init; }
    public string? ResourceUri { get; init; }
    public DateTimeOffset TimestampUtc { get; init; }
    public required object Payload { get; init; }
}

internal sealed class BridgeHandshakePayload
{
    public string[]? AllowedRoots { get; init; }
    public string[]? WritableRoots { get; init; }
    public string? OodleRuntimeRoot { get; init; }
    public int? MaxFrameBytes { get; init; }
    public int? MaxConcurrency { get; init; }
}

internal sealed class BridgeRequestPayload
{
    public string? Command { get; init; }
    public string? FilePath { get; init; }
    public JsonElement? Options { get; init; }
}

internal sealed class BridgeCancelPayload
{
    public string? TargetRequestId { get; init; }
}

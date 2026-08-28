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
        // 启动期自检：写盘命令注册表必须与能力声明一致。
        // 放在读第一帧之前——注册表漂移意味着某个写命令可能完全跳过 writable-root
        // 校验，那种状态下不应该开始服务任何请求。抛出即拒绝启动（fail-closed）。
        VerifyDiskWriteRegistry();

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

    /// <summary>
    /// 每一个会按 options.outputPath 落盘的命令。
    ///
    /// 为什么必须是一处注册表而不是 if 链：此前这里是六个 Equals 串起来的条件，
    /// 而 extract-bnd4-child 也按 options.outputPath 落盘
    /// （Bnd4NativeWriter.ExtractChild → File.WriteAllBytes）却漏在链外。
    /// 漏掉的后果不是报错而是**没有 writable-root 校验**：输出路径只受
    /// AllowedRoots 约束，而 AllowedRoots 必须包含原版游戏目录（Oodle 需要），
    /// 于是指向工作区外（含未打开的游戏目录）的 outputPath 会被放行。
    ///
    /// if 链的问题在于「新增写命令时必须记得同步改它」，而漏改既不会有编译错误
    /// 也不会有测试失败。注册表把它变成一处显式声明，并由 VerifyDiskWriteRegistry
    /// 在启动时与能力声明对账，失败关闭。
    /// </summary>
    private static readonly HashSet<string> DiskWritingCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "write-bnd4",
        "write-fmg",
        "write-param",
        "write-emevd",
        "write-msb",
        "write-gparam",
        "write-flver",
        "write-tpf-texture-replace",
        "write-mtd-document",
        "write-esd-document",
        "write-tae-document",
        "write-fxr-document",
        // list-ffxbnd-entries 是纯只读列目录，不得进写盘集合。
        // 误登记会强制 options.outputPath，IPC 不传时左栏永远 BRIDGE_OUTPUT_PATH_REQUIRED。
        "export-tpf-texture",
        "extract-bnd4-child"
    };

    /// <summary>
    /// 启动期自检：DiskWritingCommands 必须与能力声明保持一致。
    ///
    /// 上面的注释此前承诺「由 VerifyDiskWriteRegistry 在启动时与实际 dispatch 表
    /// 对账，失败关闭」，但该方法**从未存在**——全仓只有那一行注释命中，无定义
    /// 无调用。也就是说注释描述的保护机制是空的：新增写命令时漏登记注册表，
    /// 既无编译错误、无测试失败，也没有任何启动期检查会拦住它，
    /// 而后果是该命令完全跳过 writable-root 校验（见上方注释）。
    ///
    /// 判据：能力声明里每个以 "write-" 开头的命令都必须已登记进注册表。
    /// 这一条抓的正是「新增了写命令但忘了登记」这个真实场景——写命令的命名约定
    /// 是稳定的（write-bnd4/write-fmg/write-param/write-emevd/write-msb），
    /// 新增一个不叫 write-* 的落盘命令属于另一类问题，由外部门禁
    /// test:bridge-write-boundary 的双向对账覆盖（它直接解析本注册表与门禁清单）。
    ///
    /// **不做反向检查（注册表 → 能力声明）**：实测过，那样会误报。第一版自检按
    /// 「注册表必须是能力声明的子集」判定，启动时即以 export-tpf-texture
    /// 「不存在」拒绝服务——那是判据锚点选错，不是注册表漂移。
    ///
    /// 当时能力声明确实不是实现全集：它漏了 6 个已实现命令（export-tpf-texture、
    /// inventory-asset-resources、read-flver-dummies / -skeleton / -texture-slots、
    /// read-mtd-document）。这一漂移已由 AdvertisedCommands 补齐并撤下 MTD 修正，
    /// 现由 test:bridge-command-advertisement 做三方对账守住。
    /// 但**反向检查仍然不做**：广告面与写盘注册表回答的是不同问题，且判据方向
    /// 一旦反过来，任何「已实现但按裁定不该广告」的命令都会让 daemon 拒绝启动。
    ///
    /// 为什么不反射 dispatch 表：ExecuteAsync 是 if 链 + switch 混合形态，
    /// 不是可枚举结构，运行期读不到。真正的全集对账留给外部门禁做源码解析。
    /// </summary>
    private static void VerifyDiskWriteRegistry()
    {
        var capabilities = BuildCapabilities(null);
        var declared = (string[])capabilities.GetType()
            .GetProperty("commands")!.GetValue(capabilities)!;

        var missing = declared
            .Where(name => name.StartsWith("write-", StringComparison.OrdinalIgnoreCase))
            .Where(name => !DiskWritingCommands.Contains(name))
            .ToArray();
        if (missing.Length > 0)
        {
            throw new InvalidOperationException(
                "BRIDGE_DISK_WRITE_REGISTRY_INCOMPLETE: 能力声明里的写命令未登记进"
                + $" DiskWritingCommands：{string.Join(", ", missing)}。"
                + "未登记的写命令会完全跳过 writable-root 校验，写入会落到未打开的路径。");
        }
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
        if (DiskWritingCommands.Contains(payload.Command))
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
                    outputPath,
                    state.AllowedRoots,
                    frame.WorkspaceSessionId);
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
            // 带上异常类型名与首行堆栈。
            //
            // 此前只回 ex.Message，实测踩过一次：PARAM 读取失败回的是
            // "Operation is not valid due to the current state of the object."
            // ——那是 InvalidOperationException 的默认文案，既看不出类型也看不出
            // 出处，而 read-param-document 的 catch 只捕获 InvalidDataException /
            // NotSupportedException / IOException，于是真实原因被兜底吞掉。
            // 兜底 catch 的职责是「不让进程崩」，不是「让原因消失」。
            var origin = (ex.StackTrace ?? string.Empty)
                .Split('\n')
                .FirstOrDefault(line => line.Contains("SoulForge.Bridge", StringComparison.Ordinal))
                ?.Trim() ?? "(no SoulForge frame)";
            await state.WriteFailureAsync(
                frame.RequestId,
                frame.WorkspaceSessionId,
                "BRIDGE_REQUEST_FAILED",
                $"{ex.GetType().Name}: {ex.Message} | at {origin}");
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

    /// <summary>
    /// 能力声明里广告的命令集。
    ///
    /// 此前是 BuildCapabilities 里的一个内联字面量数组，与 BridgeCommandService
    /// 的实际 dispatch 分开演进，于是漂移无人发现：实测广告 24 条、实际 dispatch
    /// 26 条，**6 个已实现命令从未被广告**（inventory-asset-resources、
    /// export-tpf-texture、read-flver-skeleton/-texture-slots/-dummies、
    /// read-mtd-document）。漂移之所以能长期存在，是因为消费端
    /// bridgeDaemonClient.capabilities() 全仓零调用者——广告没人读，就没人发现它错。
    ///
    /// 提成常量是为了给它一个单一声明点，让 test:bridge-command-advertisement
    /// 能把它与 dispatch 集双向对账（与 DiskWritingCommands 同一范式）。
    ///
    /// 语义边界：广告表示「该命令会被受理」，**不表示**对应格式具备 native
    /// parser/writer authority——authority 由各能力格自行裁定。
    /// </summary>
    internal static readonly string[] AdvertisedCommands =
    {
        "inspect", "validate", "read-dcx-document", "list-bnd4-entries", "snapshot-bnd4-child",
        "extract-bnd4-child", "write-bnd4", "inventory-asset-resources",
        "read-fmg-document", "write-fmg", "read-param-document", "write-param",
        "read-gparam-document", "write-gparam", "write-flver", "read-text-catalog",
        "read-emevd-document", "write-emevd", "read-msb-document", "write-msb",
        "read-tpf-document", "export-tpf-texture", "read-tpf-texture-preview",
        "write-tpf-texture-replace", "read-tae-document",
        "read-tae-event-params", "read-tae-animation-clip", "sample-tae-animation-pose",
        "read-chrbnd-flver-preview",
        "read-map-part-flver-preview",
        "read-map-static-geometry",
        "read-flver-document", "read-flver-mesh", "read-flver-skeleton",
        "read-flver-texture-slots", "read-flver-dummies", "read-esd-document",
        "write-esd-document", "write-tae-document",
        "write-fxr-document",
        "list-ffxbnd-entries",
        "read-mtd-document", "write-mtd-document", "read-fxr-document",
        "export-event", "export-map", "export-param",
        "export-msg", "probe-oodle", "probe-document-locator"
    };

    private static object BuildCapabilities(string? oodleRuntimeRoot) => new
    {
        authority = "candidate",
        nativeFormatAuthority = false,
        commands = AdvertisedCommands,
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

internal sealed class BridgeOutboundFrameTooLargeException : Exception { }

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

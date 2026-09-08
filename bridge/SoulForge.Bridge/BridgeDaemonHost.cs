using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

internal static class BridgeDaemonHost
{
    internal const string ProtocolVersion = "1.0.0";
    private const int DefaultMaxFrameBytes = 1024 * 1024;
    // Large PARAM/MSB child snapshots are base64-framed over NDJSON.
    private const int AbsoluteMaxFrameBytes = 32 * 1024 * 1024;
    private const int MaxAllowedRoots = 16;
    private const int MaxQueuedRequests = 64;
    private const int MaxOutputQueueBytes = 64 * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    // This is intentionally a source-visible declaration. The advertisement
    // gate reads this exact set and reconciles it with service dispatch and
    // both TypeScript command unions. BridgeCommandDescriptorCatalog provides
    // the descriptor projection, and the startup check below keeps both
    // runtime projections closed over the same names.
    internal static readonly string[] AdvertisedCommands =
    {
        "inspect",
        "validate",
        "probe-oodle",
        "probe-document-locator",
        "read-dcx-document",
        "list-bnd4-entries",
        "snapshot-bnd4-child",
        "extract-bnd4-child",
        "write-bnd4",
        "inventory-asset-resources",
        "read-fmg-document",
        "write-fmg",
        "read-param-document",
        "write-param",
        "read-gparam-document",
        "write-gparam",
        "read-text-catalog",
        "read-emevd-document",
        "write-emevd",
        "read-msb-document",
        "write-msb",
        "read-tpf-document",
        "export-tpf-texture",
        "read-tpf-texture-preview",
        "write-tpf-texture-replace",
        "read-tae-document",
        "read-tae-event-params",
        "read-tae-animation-clip",
        "sample-tae-animation-pose",
        "read-bridge-artifact",
        "read-chrbnd-flver-preview",
        "read-map-part-flver-preview",
        "read-map-static-geometry",
        "read-flver-document",
        "write-flver",
        "read-flver-mesh",
        "read-flver-skeleton",
        "read-flver-texture-slots",
        "read-flver-dummies",
        "read-esd-document",
        "write-esd-document",
        "write-tae-document",
        "write-fxr-document",
        "read-mtd-document",
        "write-mtd-document",
        "read-fxr-document",
        "list-ffxbnd-entries",
        "read-luabnd-document",
        "inspect-luabnd",
        "read-luabnd-script",
        "write-luabnd-script",
        "export-luabnd",
        "export-event",
        "export-map",
        "export-param",
        "export-msg"
    };

    public static async Task RunAsync(
        TextReader input,
        TextWriter output,
        CancellationToken cancellationToken)
    {
        // 启动期自检：描述源必须覆盖能力、实际入口和所有输出路径。
        // 漂移时 fail-closed，不能在尚未确认写路径边界的状态下接收请求。
        VerifyDiskWriteRegistry();

        using var reader = BoundedNdjsonReader.FromTextReader(
            input,
            DefaultMaxFrameBytes,
            AbsoluteMaxFrameBytes);
        var resourceCache = MapStaticGeometryService.CreateResourceCache();
        var state = new DaemonState(output, resourceCache);
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                string? line;
                try
                {
                    line = await reader.ReadFrameAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (BoundedNdjsonException ex)
                {
                    await state.WriteFailureAsync(null, null, ex.Code, ex.Message, new { byteCount = ex.ByteCount });
                    break;
                }

                if (line is null) break;
                if (string.IsNullOrWhiteSpace(line)) continue;

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
                        await HandleHandshakeAsync(frame, state, reader);
                        break;
                    case "health":
                        await EnsureSessionAndWriteAsync(frame, state, "health", new
                        {
                            status = "ok",
                            processId = Environment.ProcessId,
                            runtime = Environment.Version.ToString(),
                            activeRequests = state.ActiveRequestCount,
                            queuedRequests = state.QueuedRequestCount,
                            queueLimit = MaxQueuedRequests,
                            oodleRuntime = OodleRuntimeLocator.Probe(state.OodleRuntimeRoot).Runtime
                        });
                        break;
                    case "capabilities":
                        await EnsureSessionAndWriteAsync(frame, state, "capabilities", BuildCapabilities(state.OodleRuntimeRoot));
                        break;
                    case "cancel":
                        await HandleCancelAsync(frame, state);
                        break;
                    case "workspace/close":
                        await HandleWorkspaceCloseAsync(frame, state);
                        break;
                    case "request":
                        await AcceptRequestAsync(frame, state);
                        break;
                    default:
                        await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_FRAME_KIND_UNKNOWN", $"Unknown frame kind: {frame.Kind}");
                        break;
                }
            }
        }
        finally
        {
            await state.StopAsync().ConfigureAwait(false);
            state.Dispose();
        }
    }

    private static async Task HandleHandshakeAsync(
        BridgeInboundFrame frame,
        DaemonState state,
        BoundedNdjsonReader reader)
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

        if (payload.MaxFrameBytes is { } requestedMaxFrameBytes
            && (requestedMaxFrameBytes < 64 * 1024 || requestedMaxFrameBytes > AbsoluteMaxFrameBytes))
        {
            await state.WriteFailureAsync(
                frame.RequestId,
                frame.WorkspaceSessionId,
                "BRIDGE_HANDSHAKE_INVALID",
                $"maxFrameBytes must be between 65536 and {AbsoluteMaxFrameBytes}.");
            return;
        }

        state.Configure(
            frame.WorkspaceSessionId,
            roots,
            writableRoots,
            Math.Clamp(payload.MaxFrameBytes ?? DefaultMaxFrameBytes, 64 * 1024, AbsoluteMaxFrameBytes),
            Math.Clamp(payload.MaxConcurrency ?? 2, 1, 8),
            oodleRuntimeRoot);
        reader.SetMaxFrameBytes(state.MaxFrameBytes);

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
    // Keep this declaration source-visible for the runtime write-boundary
    // gate. The descriptor catalog is checked against it during startup, so a
    // new output-path command cannot silently skip writable-root validation.
    private static readonly HashSet<string> DiskWritingCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "extract-bnd4-child",
        "write-bnd4",
        "export-tpf-texture",
        "write-fmg",
        "write-param",
        "write-emevd",
        "write-msb",
        "write-flver",
        "write-gparam",
        "write-tpf-texture-replace",
        "write-mtd-document",
        "write-esd-document",
        "write-tae-document",
        "write-fxr-document",
        "write-luabnd-script",
        "export-luabnd"
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
        BridgeCommandDescriptorCatalog.Verify();

        var advertisedFromDescriptors = BridgeCommandDescriptorCatalog.All
            .Where(item => item.Advertised)
            .Select(item => item.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var advertisedFromCapabilities = AdvertisedCommands.ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!advertisedFromDescriptors.SetEquals(advertisedFromCapabilities))
            throw new InvalidOperationException("BRIDGE_COMMAND_ADVERTISEMENT_PROJECTION_DRIFT");

        var diskFromDescriptors = BridgeCommandDescriptorCatalog.All
            .Where(item => item.RequiresOutputPath)
            .Select(item => item.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!diskFromDescriptors.SetEquals(DiskWritingCommands))
            throw new InvalidOperationException("BRIDGE_DISK_WRITE_PROJECTION_DRIFT");

        var unbound = BridgeCommandDescriptorCatalog.All
            .Where(item => !BridgeCommandDescriptorCatalog.DispatchCommands.Contains(item.Name))
            .Select(item => item.Name)
            .ToArray();
        if (unbound.Length > 0)
            throw new InvalidOperationException(
                $"BRIDGE_COMMAND_DISPATCH_REGISTRY_INCOMPLETE: {string.Join(", ", unbound)}");
    }

    private static async Task AcceptRequestAsync(BridgeInboundFrame frame, DaemonState state)
    {
        if (!state.IsSessionValid(frame.WorkspaceSessionId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_SESSION_INVALID", "A valid handshake is required before requests.");
            return;
        }
        if (string.IsNullOrWhiteSpace(frame.RequestId))
        {
            await state.WriteFailureAsync(null, frame.WorkspaceSessionId, "BRIDGE_REQUEST_ID_REQUIRED", "requestId is required.");
            return;
        }

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

        var command = payload.Command.Trim().ToLowerInvariant();
        if (!BridgeCommandDescriptorCatalog.TryGet(command, out var descriptor))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "UNKNOWN_COMMAND", $"Unknown bridge command: {command}");
            return;
        }

        var boundary = BridgePathBoundary.Verify(payload.FilePath, state.AllowedRoots);
        if (!boundary.Ok)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, boundary.Code, boundary.Message);
            return;
        }

        string? outputPath = null;
        if (descriptor.RequiresOutputPath)
        {
            if (payload.Options is not { ValueKind: JsonValueKind.Object }
                || !payload.Options.Value.TryGetProperty("outputPath", out var outputElement)
                || outputElement.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(outputElement.GetString()))
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_OUTPUT_PATH_REQUIRED", "Bridge writer/export command requires options.outputPath.");
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
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS", "Bridge writer/export output must stay inside a negotiated writable root.");
                return;
            }
            outputPath = outputBoundary.CanonicalPath;
        }

        if (!BridgeRequestPriorityParser.TryParse(payload.Priority, descriptor.CostClass, out var priority))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_PRIORITY_INVALID", "priority must be interactive, foreground or background.");
            return;
        }

        var requestCts = CancellationTokenSource.CreateLinkedTokenSource(state.ShutdownToken);
        if (frame.DeadlineUtc is { } deadline)
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_DEADLINE_EXCEEDED", "Request deadline has already elapsed.");
                requestCts.Dispose();
                return;
            }
            requestCts.CancelAfter(remaining);
        }

        var work = new BridgeRequestWorkItem
        {
            Frame = frame,
            Payload = payload,
            Descriptor = descriptor,
            CanonicalFilePath = boundary.CanonicalPath,
            OutputPath = outputPath,
            CancellationSource = requestCts,
            Priority = priority,
            EnqueuedAt = DateTimeOffset.UtcNow,
            EnqueuedTimestamp = Stopwatch.GetTimestamp()
        };

        if (state.HasRequest(frame.RequestId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_DUPLICATE_REQUEST", "requestId is already queued or active.");
            requestCts.Dispose();
            return;
        }

        if (!state.TryReserveRequest(work))
        {
            await state.WriteFailureAsync(
                frame.RequestId,
                frame.WorkspaceSessionId,
                "BRIDGE_BUSY",
                "Bridge request queue is full; retry with bounded backoff before the deadline.",
                new
                {
                    retryAfterMs = 100,
                    queueLimit = MaxQueuedRequests,
                    queuedRequests = state.QueuedRequestCount,
                    activeRequests = state.ActiveRequestCount
                });
            requestCts.Dispose();
            return;
        }

        try
        {
            await state.WriteAsync("request/accepted", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
            {
                acceptedAt = DateTimeOffset.UtcNow,
                queuePosition = state.QueuedRequestCount,
                priority = priority.ToString().ToLowerInvariant()
            });
            state.CommitRequest(work);
        }
        catch
        {
            state.AbortReservation(work);
            throw;
        }
    }

    private static async Task ExecuteRequestAsync(BridgeRequestWorkItem work, DaemonState state)
    {
        var frame = work.Frame;
        var payload = work.Payload;
        var mapTiming = MapTimingCollector.TryCreate(
            payload.Command,
            payload.Options ?? default,
            work.EnqueuedTimestamp);
        try
        {
            if (frame.DeadlineUtc is { } deadline && deadline <= DateTimeOffset.UtcNow)
            {
                await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_DEADLINE_EXCEEDED", "Request deadline elapsed while it was queued.");
                return;
            }

            await state.WriteAsync("progress", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
            {
                phase = "started",
                completed = 0,
                total = 1
            });
            using var resourceScope = MapStaticGeometryService.EnterRequestScope(
                work.CancellationSource.Token,
                frame.WorkspaceSessionId ?? string.Empty);
            BridgeResult<object> result;
            if (string.Equals(payload.Command, "read-bridge-artifact", StringComparison.OrdinalIgnoreCase))
            {
                result = await state.ReadArtifactAsync(
                    payload.Options,
                    work.CanonicalFilePath,
                    work.CancellationSource.Token);
            }
            else
            {
                var service = new BridgeCommandService();
                result = await service.ExecuteAsync(
                    payload.Command!,
                    work.CanonicalFilePath,
                    work.CancellationSource.Token,
                    state.OodleRuntimeRoot,
                    payload.Options ?? default,
                    work.OutputPath,
                    state.AllowedRoots,
                    frame.WorkspaceSessionId,
                    mapTiming);
            }
            work.CancellationSource.Token.ThrowIfCancellationRequested();
            if (string.Equals(payload.Command, "read-map-static-geometry", StringComparison.OrdinalIgnoreCase))
            {
                var cache = MapStaticGeometryService.ResourceCacheObservation();
                var diagnostics = result.Diagnostics.Append(new Diagnostic(
                    "info",
                    "MAP_RESOURCE_CACHE_SNAPSHOT",
                    "地图静态几何资源 lease cache 状态快照。",
                    result.SourceUri,
                    cache));
                if (mapTiming is not null)
                {
                    diagnostics = diagnostics.Append(new Diagnostic(
                        "info",
                        "MAP_NATIVE_TIMINGS",
                        "地图静态几何 native 读链路的 opt-in 计时快照。",
                        result.SourceUri,
                        mapTiming.Snapshot()));
                }
                result = result with
                {
                    Diagnostics = diagnostics.ToArray()
                };
            }
            await state.WriteAsync("progress", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
            {
                phase = "completed",
                completed = 1,
                total = 1
            });
            var authority = result.Diagnostics.Any(item => item.Code.Contains("SYNTHETIC", StringComparison.OrdinalIgnoreCase))
                ? "fixture-confirmed"
                : result.ParseStatus == "unsupported" ? "unsupported" : "candidate";
            await state.WriteResultAsync(frame, payload.Command!, authority, result);
        }
        catch (OperationCanceledException)
        {
            await state.WriteAsync("cancelled", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
            {
                code = "BRIDGE_REQUEST_CANCELLED",
                message = "Bridge request was cancelled, queued past its deadline, or exceeded its deadline."
            });
        }
        catch (BridgeOutboundFrameTooLargeException ex)
        {
            await state.WriteFailureAsync(
                frame.RequestId,
                frame.WorkspaceSessionId,
                "BRIDGE_OUTBOUND_FRAME_TOO_LARGE",
                "Bridge result exceeds the negotiated frame-size limit; use a file-backed command instead.",
                new
                {
                    command = payload.Command,
                    frameKind = ex.FrameKind,
                    serializedBytes = ex.SerializedBytes,
                    maxFrameBytes = ex.MaxFrameBytes,
                    resourceUri = frame.ResourceUri
                });
        }
        catch (Exception ex)
        {
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
            state.FinishRequest(work);
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
        var cancellation = state.CancelRequest(payload.TargetRequestId);
        if (cancellation == BridgeCancelDisposition.Queued)
        {
            await state.WriteAsync("cancelled", payload.TargetRequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
            {
                code = "BRIDGE_REQUEST_CANCELLED",
                message = "Queued Bridge request was cancelled before it acquired an active slot."
            });
            return;
        }
        if (cancellation != BridgeCancelDisposition.Active)
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_REQUEST_NOT_ACTIVE", "The target request is not active.");
        }
    }

    private static async Task HandleWorkspaceCloseAsync(BridgeInboundFrame frame, DaemonState state)
    {
        if (!state.IsSessionValid(frame.WorkspaceSessionId))
        {
            await state.WriteFailureAsync(frame.RequestId, frame.WorkspaceSessionId, "BRIDGE_SESSION_INVALID", "A valid handshake is required.");
            return;
        }

        await state.WriteAsync("workspace/closed", frame.RequestId, frame.WorkspaceSessionId, frame.ResourceUri, new
        {
            status = "closing",
            activeRequests = state.ActiveRequestCount,
            queuedRequests = state.QueuedRequestCount
        });
        state.CompleteAcceptingRequests();
        // Workspace close is a cache-generation boundary.  Clear the session
        // table and retire in-flight/ready geometry before a late builder can
        // publish a value belonging to the closed workspace.
        MapStaticGeometryService.Reset();
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
    private static object BuildCapabilities(string? oodleRuntimeRoot) => new
    {
        authority = "candidate",
        nativeFormatAuthority = false,
        commands = AdvertisedCommands,
        commandDescriptors = BridgeCommandDescriptorCatalog.AdvertisedDescriptors,
        envelopes = new[] { "DFLT-candidate", "KRAK-runtime-dependent", "BND4-unsupported" },
        oodleRuntime = OodleRuntimeLocator.Probe(oodleRuntimeRoot).Runtime,
        cancellation = true,
        progress = true,
        queueLimit = MaxQueuedRequests,
        scheduling = new { priorities = new[] { "interactive", "foreground", "background" }, quota = new[] { 5, 2, 1 }, aging = true }
    };

    private sealed class DaemonState : IDisposable
    {
        private readonly TextWriter _output;
        private readonly ResourceLeaseCache<MapStaticGeometryService.GeometryResource> _resourceCache;
        private readonly BoundedOutputQueue _outputQueue = new(MaxOutputQueueBytes);
        private readonly Task _outputPump;
        private readonly CancellationTokenSource _shutdown = new();
        private readonly BridgeArtifactStore _artifacts = new();
        private BridgeRequestScheduler? _scheduler;
        private string? _workspaceSessionId;

        public DaemonState(
            TextWriter output,
            ResourceLeaseCache<MapStaticGeometryService.GeometryResource> resourceCache)
        {
            _output = output;
            _resourceCache = resourceCache;
            MapStaticGeometryService.AttachResourceCache(resourceCache);
            _outputPump = PumpOutputAsync();
        }

        public int MaxFrameBytes { get; private set; } = DefaultMaxFrameBytes;
        public int MaxConcurrency { get; private set; } = 1;
        public IReadOnlyList<string> AllowedRoots { get; private set; } = Array.Empty<string>();
        public IReadOnlyList<string> WritableRoots { get; private set; } = Array.Empty<string>();
        public string? OodleRuntimeRoot { get; private set; }
        public CancellationToken ShutdownToken => _shutdown.Token;
        public int ActiveRequestCount => _scheduler?.ActiveCount ?? 0;
        public int QueuedRequestCount => _scheduler?.QueuedCount ?? 0;
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
            _scheduler = new BridgeRequestScheduler(
                maxConcurrency,
                MaxQueuedRequests,
                work => ExecuteRequestAsync(work, this));
            _scheduler.Start();
        }

        public bool IsSessionValid(string? workspaceSessionId) =>
            !string.IsNullOrWhiteSpace(_workspaceSessionId)
            && string.Equals(_workspaceSessionId, workspaceSessionId, StringComparison.Ordinal);

        public bool TryReserveRequest(BridgeRequestWorkItem work) =>
            _scheduler?.TryReserve(work) == true;

        public bool HasRequest(string requestId) => _scheduler?.Contains(requestId) == true;

        public void CommitRequest(BridgeRequestWorkItem work) =>
            (_scheduler ?? throw new InvalidOperationException("Bridge scheduler is not configured.")).Commit(work);

        public void AbortReservation(BridgeRequestWorkItem work) =>
            _scheduler?.AbortReservation(work);

        public void FinishRequest(BridgeRequestWorkItem work)
        {
            _scheduler?.Finish(work);
        }

        public BridgeCancelDisposition CancelRequest(string requestId) =>
            _scheduler?.Cancel(requestId) ?? BridgeCancelDisposition.NotFound;

        public void CompleteAcceptingRequests() => _scheduler?.Complete();

        public async Task StopAsync()
        {
            if (_scheduler is not null)
                await _scheduler.StopAsync().ConfigureAwait(false);
            _outputQueue.Complete();
            await _outputPump.ConfigureAwait(false);
        }

        public async Task WriteFailureAsync(
            string? requestId,
            string? workspaceSessionId,
            string code,
            string message,
            object? details = null)
        {
            await WriteAsync("failed", requestId, workspaceSessionId, null, new
            {
                code,
                message,
                retryable = code is "BRIDGE_REQUEST_FAILED" or "BRIDGE_REQUEST_NOT_ACTIVE" or "BRIDGE_BUSY",
                details
            });
        }

        public async Task WriteResultAsync(
            BridgeInboundFrame request,
            string command,
            string authority,
            BridgeResult<object> result)
        {
            var payload = new
            {
                authority,
                nativeFormatAuthority = false,
                result
            };
            var frame = CreateFrame("result", request.RequestId, request.WorkspaceSessionId, request.ResourceUri, payload);
            var json = JsonSerializer.Serialize(frame, JsonOptions);
            var serializedBytes = Encoding.UTF8.GetByteCount(json);
            if (serializedBytes <= MaxFrameBytes)
            {
                await WriteSerializedAsync(json, "result", request.RequestId);
                return;
            }

            var resultJson = JsonSerializer.SerializeToUtf8Bytes(result, JsonOptions);
            var artifact = _artifacts.Store(resultJson);
            var resultNode = JsonNode.Parse(Encoding.UTF8.GetString(resultJson))?.AsObject()
                ?? throw new InvalidDataException("Bridge result could not be converted to a JSON object.");
            var diagnosticArray = resultNode["diagnostics"] as JsonArray ?? new JsonArray();
            diagnosticArray.Add(JsonSerializer.SerializeToNode(new
            {
                severity = "info",
                code = "BRIDGE_RESULT_FILE_BACKED",
                message = "Bridge result exceeded one negotiated frame and was moved to a daemon-owned artifact.",
                sourceUri = request.ResourceUri,
                details = new
                {
                    command,
                    serializedBytes,
                    maxFrameBytes = MaxFrameBytes,
                    artifactToken = artifact.Token,
                    artifactByteLength = artifact.ByteLength,
                    artifactChunkSize = artifact.ChunkSize
                }
            }, JsonOptions));
            resultNode["diagnostics"] = diagnosticArray;
            resultNode["data"] = JsonSerializer.SerializeToNode(new
            {
                fileBacked = new
                {
                    artifactToken = artifact.Token,
                    payloadFormat = "bridge-result-json",
                    payloadVersion = 1,
                    byteLength = artifact.ByteLength,
                    chunkSize = artifact.ChunkSize,
                    sourceUri = request.ResourceUri,
                    sourceRevision = ReadString(resultNode["data"], "sourceHash")
                        ?? ReadString(resultNode["data"], "animationContainerHash"),
                    duration = ReadDouble(resultNode["data"], "duration"),
                    frameCount = ReadLong(resultNode["data"], "frameCount"),
                    boneCount = ReadLong(resultNode["data"], "boneCount"),
                    diagnostics = new { serializedBytes, maxFrameBytes = MaxFrameBytes }
                }
            }, JsonOptions);

            await WriteAsync("result", request.RequestId, request.WorkspaceSessionId, request.ResourceUri, new
            {
                authority,
                nativeFormatAuthority = false,
                result = resultNode
            });
        }

        public async Task<BridgeResult<object>> ReadArtifactAsync(
            JsonElement? options,
            string sourcePath,
            CancellationToken cancellationToken)
        {
            if (options is not { ValueKind: JsonValueKind.Object }
                || !options.Value.TryGetProperty("artifactToken", out var tokenElement)
                || tokenElement.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(tokenElement.GetString())
                || !options.Value.TryGetProperty("offset", out var offsetElement)
                || !offsetElement.TryGetInt64(out var offset)
                || !options.Value.TryGetProperty("length", out var lengthElement)
                || !lengthElement.TryGetInt32(out var length))
            {
                return BridgeResult<object>.Failed(sourcePath, "unknown", "BRIDGE_ARTIFACT_REQUEST_INVALID", "artifactToken、offset 和 length 是必需的。");
            }

            try
            {
                var chunk = _artifacts.Read(tokenElement.GetString()!, offset, length, cancellationToken);
                return BridgeResult<object>.Partial(sourcePath, "unknown", new[]
                {
                    new Diagnostic("info", "BRIDGE_ARTIFACT_CHUNK_READ", "Bridge file-backed artifact chunk 已读取。", BridgeResult<object>.MakeSourceUri(sourcePath))
                }, new
                {
                    artifactToken = tokenElement.GetString()!,
                    offset,
                    length = chunk.Bytes.Length,
                    totalLength = chunk.TotalLength,
                    complete = offset + chunk.Bytes.Length >= chunk.TotalLength,
                    dataBase64 = Convert.ToBase64String(chunk.Bytes)
                });
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidDataException or IOException)
            {
                return BridgeResult<object>.Failed(sourcePath, "unknown", "BRIDGE_ARTIFACT_READ_FAILED", ex.Message, new
                {
                    artifactToken = tokenElement.GetString(),
                    offset,
                    length
                });
            }
        }

        public async Task WriteAsync(
            string kind,
            string? requestId,
            string? workspaceSessionId,
            string? resourceUri,
            object payload)
        {
            var frame = CreateFrame(kind, requestId, workspaceSessionId, resourceUri, payload);
            var json = JsonSerializer.Serialize(frame, JsonOptions);
            var serializedBytes = Encoding.UTF8.GetByteCount(json);
            if (serializedBytes > MaxFrameBytes)
                throw new BridgeOutboundFrameTooLargeException(kind, requestId, serializedBytes, MaxFrameBytes);
            await WriteSerializedAsync(json, kind, requestId);
        }

        private BridgeOutboundFrame CreateFrame(
            string kind,
            string? requestId,
            string? workspaceSessionId,
            string? resourceUri,
            object payload) => new()
        {
            ProtocolVersion = ProtocolVersion,
            Kind = kind,
            RequestId = requestId,
            WorkspaceSessionId = workspaceSessionId,
            ResourceUri = resourceUri,
            TimestampUtc = DateTimeOffset.UtcNow,
            Payload = payload
        };

        private Task WriteSerializedAsync(string json, string kind, string? requestId) =>
            _outputQueue.EnqueueAsync(
                new BridgeOutputItem(json, kind == "progress", requestId),
                _shutdown.Token);

        private async Task PumpOutputAsync()
        {
            await foreach (var item in _outputQueue.ReadAllAsync(_shutdown.Token).ConfigureAwait(false))
            {
                await _output.WriteAsync(item.Json.AsMemory()).ConfigureAwait(false);
                await _output.WriteAsync("\n".AsMemory()).ConfigureAwait(false);
                await _output.FlushAsync().ConfigureAwait(false);
            }
        }

        private static string? ReadString(JsonNode? node, string propertyName)
        {
            if (node is not JsonObject obj || obj[propertyName] is not JsonValue value) return null;
            return value.TryGetValue<string>(out var result) ? result : null;
        }

        private static double? ReadDouble(JsonNode? node, string propertyName)
        {
            if (node is not JsonObject obj || obj[propertyName] is not JsonValue value) return null;
            return value.TryGetValue<double>(out var result) ? result : null;
        }

        private static long? ReadLong(JsonNode? node, string propertyName)
        {
            if (node is not JsonObject obj || obj[propertyName] is not JsonValue value) return null;
            return value.TryGetValue<long>(out var result) ? result : null;
        }

        public void Dispose()
        {
            _shutdown.Cancel();
            _scheduler?.CancelAll();
            _outputQueue.Complete();
            MapStaticGeometryService.DetachResourceCache(_resourceCache);
            _resourceCache.Dispose();
            _shutdown.Dispose();
            _artifacts.Dispose();
        }
    }
}

internal enum BridgeRequestPriority
{
    Interactive = 0,
    Foreground = 1,
    Background = 2
}

internal static class BridgeRequestPriorityParser
{
    public static bool TryParse(
        string? requested,
        string descriptorCostClass,
        out BridgeRequestPriority priority)
    {
        var value = string.IsNullOrWhiteSpace(requested) ? descriptorCostClass : requested.Trim();
        if (string.Equals(value, "interactive", StringComparison.OrdinalIgnoreCase))
        {
            priority = BridgeRequestPriority.Interactive;
            return true;
        }
        if (string.Equals(value, "foreground", StringComparison.OrdinalIgnoreCase))
        {
            priority = BridgeRequestPriority.Foreground;
            return true;
        }
        if (string.Equals(value, "background", StringComparison.OrdinalIgnoreCase))
        {
            priority = BridgeRequestPriority.Background;
            return true;
        }
        priority = default;
        return false;
    }
}

internal sealed class BridgeRequestWorkItem
{
    public required BridgeInboundFrame Frame { get; init; }
    public required BridgeRequestPayload Payload { get; init; }
    public required BridgeCommandDescriptor Descriptor { get; init; }
    public required string CanonicalFilePath { get; init; }
    public string? OutputPath { get; init; }
    public required CancellationTokenSource CancellationSource { get; init; }
    public required BridgeRequestPriority Priority { get; init; }
    public required DateTimeOffset EnqueuedAt { get; init; }
    public required long EnqueuedTimestamp { get; init; }
    public LinkedListNode<BridgeRequestWorkItem>? QueueNode { get; set; }
}

internal enum BridgeCancelDisposition
{
    NotFound,
    Queued,
    Active
}

internal sealed class BridgeRequestScheduler
{
    private static readonly int[] WeightedQuota = { 0, 0, 0, 0, 0, 1, 1, 2 };
    private static readonly TimeSpan AgingThreshold = TimeSpan.FromMilliseconds(250);

    private readonly object _gate = new();
    private readonly int _maxConcurrency;
    private readonly int _queueLimit;
    private readonly Func<BridgeRequestWorkItem, Task> _execute;
    private readonly LinkedList<BridgeRequestWorkItem>[] _queues =
    {
        new(), new(), new()
    };
    private readonly Dictionary<string, BridgeRequestWorkItem> _requests = new(StringComparer.Ordinal);
    private readonly List<Task> _workers = new();
    private TaskCompletionSource<bool> _signal = NewSignal();
    private bool _started;
    private bool _completed;
    private int _queuedCount;
    private int _activeCount;
    private int _quotaCursor;

    public BridgeRequestScheduler(
        int maxConcurrency,
        int queueLimit,
        Func<BridgeRequestWorkItem, Task> execute)
    {
        _maxConcurrency = Math.Clamp(maxConcurrency, 1, 8);
        _queueLimit = Math.Max(1, queueLimit);
        _execute = execute;
    }

    public int ActiveCount
    {
        get { lock (_gate) return _activeCount; }
    }

    public int QueuedCount
    {
        get { lock (_gate) return _queuedCount; }
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_started) return;
            _started = true;
            for (var i = 0; i < _maxConcurrency; i++)
                _workers.Add(WorkerLoopAsync());
        }
    }

    public bool TryReserve(BridgeRequestWorkItem work)
    {
        lock (_gate)
        {
            if (!_started || _completed || _queuedCount >= _queueLimit)
                return false;
            if (_requests.ContainsKey(work.Frame.RequestId!))
                return false;
            _requests.Add(work.Frame.RequestId!, work);
            _queuedCount++;
            return true;
        }
    }

    public bool Contains(string requestId)
    {
        lock (_gate) return _requests.ContainsKey(requestId);
    }

    public void Commit(BridgeRequestWorkItem work)
    {
        lock (_gate)
        {
            if (_completed)
            {
                _requests.Remove(work.Frame.RequestId!);
                _queuedCount = Math.Max(0, _queuedCount - 1);
                work.CancellationSource.Cancel();
                return;
            }
            var node = _queues[(int)work.Priority].AddLast(work);
            work.QueueNode = node;
            Pulse_NoLock();
        }
    }

    public void AbortReservation(BridgeRequestWorkItem work)
    {
        lock (_gate)
        {
            if (_requests.Remove(work.Frame.RequestId!))
                _queuedCount = Math.Max(0, _queuedCount - 1);
        }
        work.CancellationSource.Dispose();
    }

    public BridgeCancelDisposition Cancel(string requestId)
    {
        BridgeRequestWorkItem? removed = null;
        lock (_gate)
        {
            if (!_requests.TryGetValue(requestId, out var work))
                return BridgeCancelDisposition.NotFound;

            if (work.QueueNode is not null)
            {
                _queues[(int)work.Priority].Remove(work.QueueNode);
                work.QueueNode = null;
                _requests.Remove(requestId);
                _queuedCount = Math.Max(0, _queuedCount - 1);
                removed = work;
                Pulse_NoLock();
            }
            else
            {
                work.CancellationSource.Cancel();
                return BridgeCancelDisposition.Active;
            }
        }

        removed!.CancellationSource.Cancel();
        removed.CancellationSource.Dispose();
        return BridgeCancelDisposition.Queued;
    }

    public void Finish(BridgeRequestWorkItem work)
    {
        lock (_gate)
        {
            _requests.Remove(work.Frame.RequestId!);
        }
    }

    public void Complete()
    {
        lock (_gate)
        {
            _completed = true;
            Pulse_NoLock();
        }
    }

    public async Task StopAsync()
    {
        Complete();
        Task[] workers;
        lock (_gate) workers = _workers.ToArray();
        await Task.WhenAll(workers).ConfigureAwait(false);
    }

    public void CancelAll()
    {
        lock (_gate)
        {
            foreach (var work in _requests.Values)
                work.CancellationSource.Cancel();
            _completed = true;
            Pulse_NoLock();
        }
    }

    private async Task WorkerLoopAsync()
    {
        while (true)
        {
            BridgeRequestWorkItem? work;
            Task waitTask;
            lock (_gate)
            {
                work = TakeNext_NoLock();
                if (work is null)
                {
                    if (_completed) return;
                    waitTask = _signal.Task;
                }
                else
                {
                    _activeCount++;
                    waitTask = Task.CompletedTask;
                }
            }

            if (work is null)
            {
                await waitTask.ConfigureAwait(false);
                continue;
            }

            try
            {
                await _execute(work).ConfigureAwait(false);
            }
            finally
            {
                lock (_gate)
                {
                    _activeCount = Math.Max(0, _activeCount - 1);
                    _requests.Remove(work.Frame.RequestId!);
                }
                work.CancellationSource.Dispose();
            }
        }
    }

    private BridgeRequestWorkItem? TakeNext_NoLock()
    {
        BridgeRequestWorkItem? oldest = null;
        foreach (var queue in _queues)
        {
            var candidate = queue.First?.Value;
            if (candidate is null) continue;
            if (oldest is null || candidate.EnqueuedAt < oldest.EnqueuedAt)
                oldest = candidate;
        }

        if (oldest is not null && DateTimeOffset.UtcNow - oldest.EnqueuedAt >= AgingThreshold)
            return RemoveFirstMatching_NoLock(oldest);

        for (var attempt = 0; attempt < WeightedQuota.Length; attempt++)
        {
            var index = (_quotaCursor + attempt) % WeightedQuota.Length;
            var queueIndex = WeightedQuota[index];
            if (_queues[queueIndex].First is null) continue;
            _quotaCursor = (index + 1) % WeightedQuota.Length;
            var node = _queues[queueIndex].First!;
            _queues[queueIndex].RemoveFirst();
            node.Value.QueueNode = null;
            _queuedCount = Math.Max(0, _queuedCount - 1);
            return node.Value;
        }

        return null;
    }

    private BridgeRequestWorkItem RemoveFirstMatching_NoLock(BridgeRequestWorkItem target)
    {
        var queue = _queues[(int)target.Priority];
        var node = target.QueueNode ?? queue.First!;
        queue.Remove(node);
        target.QueueNode = null;
        _queuedCount = Math.Max(0, _queuedCount - 1);
        return target;
    }

    private void Pulse_NoLock()
    {
        _signal.TrySetResult(true);
        _signal = NewSignal();
    }

    private static TaskCompletionSource<bool> NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed record BridgeOutputItem(string Json, bool IsProgress, string? RequestId)
{
    public int ByteLength => Encoding.UTF8.GetByteCount(Json) + 1;
}

internal sealed class BoundedOutputQueue
{
    private readonly object _gate = new();
    private readonly long _capacityBytes;
    private readonly LinkedList<BridgeOutputItem> _items = new();
    private readonly Dictionary<string, LinkedListNode<BridgeOutputItem>> _progress = new(StringComparer.Ordinal);
    private TaskCompletionSource<bool> _signal = NewSignal();
    private long _bytes;
    private bool _completed;

    public BoundedOutputQueue(long capacityBytes)
    {
        _capacityBytes = Math.Max(1, capacityBytes);
    }

    public async Task EnqueueAsync(BridgeOutputItem item, CancellationToken cancellationToken)
    {
        if (item.ByteLength > _capacityBytes)
            throw new InvalidDataException("Bridge output frame exceeds the bounded output queue capacity.");

        while (true)
        {
            Task waitTask;
            lock (_gate)
            {
                if (_completed)
                    throw new ObjectDisposedException(nameof(BoundedOutputQueue));

                if (item.IsProgress && !string.IsNullOrWhiteSpace(item.RequestId)
                    && _progress.TryGetValue(item.RequestId!, out var previous))
                {
                    _items.Remove(previous);
                    _bytes -= previous.Value.ByteLength;
                    _progress.Remove(item.RequestId!);
                }

                if (_bytes + item.ByteLength <= _capacityBytes)
                {
                    var node = _items.AddLast(item);
                    _bytes += item.ByteLength;
                    if (item.IsProgress && !string.IsNullOrWhiteSpace(item.RequestId))
                        _progress[item.RequestId!] = node;
                    Pulse_NoLock();
                    return;
                }

                waitTask = _signal.Task;
            }
            await waitTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public async IAsyncEnumerable<BridgeOutputItem> ReadAllAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        while (true)
        {
            BridgeOutputItem? item = null;
            Task waitTask;
            var completed = false;
            lock (_gate)
            {
                if (_items.First is not null)
                {
                    var node = _items.First;
                    _items.RemoveFirst();
                    item = node.Value;
                    _bytes -= item.ByteLength;
                    if (item.IsProgress && !string.IsNullOrWhiteSpace(item.RequestId)
                        && _progress.TryGetValue(item.RequestId!, out var progressNode)
                        && ReferenceEquals(progressNode, node))
                    {
                        _progress.Remove(item.RequestId!);
                    }
                    Pulse_NoLock();
                    waitTask = Task.CompletedTask;
                }
                else
                {
                    completed = _completed;
                    waitTask = completed ? Task.CompletedTask : _signal.Task;
                }
            }

            if (completed) yield break;

            if (item is not null)
            {
                yield return item;
                continue;
            }
            await waitTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public void Complete()
    {
        lock (_gate)
        {
            _completed = true;
            Pulse_NoLock();
        }
    }

    private void Pulse_NoLock()
    {
        _signal.TrySetResult(true);
        _signal = NewSignal();
    }

    private static TaskCompletionSource<bool> NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed class BridgeOutboundFrameTooLargeException : Exception
{
    public BridgeOutboundFrameTooLargeException(string frameKind, string? requestId, int serializedBytes, int maxFrameBytes)
        : base($"Outbound frame {frameKind} is {serializedBytes} bytes; negotiated maximum is {maxFrameBytes}.")
    {
        FrameKind = frameKind;
        RequestId = requestId;
        SerializedBytes = serializedBytes;
        MaxFrameBytes = maxFrameBytes;
    }

    public string FrameKind { get; }
    public string? RequestId { get; }
    public int SerializedBytes { get; }
    public int MaxFrameBytes { get; }
}

internal sealed class BridgeArtifactStore : IDisposable
{
    private const int MaxArtifactBytes = 512 * 1024 * 1024;
    // Must fit inside the protocol's minimum negotiated 64 KiB frame after
    // base64 expansion and the result envelope. Keeping one conservative size
    // makes the artifact command safe even when a caller deliberately uses the
    // minimum frame budget for a transport regression test.
    public const int ChunkSize = 32 * 1024;
    private readonly string root;
    private readonly ConcurrentDictionary<string, string> files = new(StringComparer.Ordinal);

    public BridgeArtifactStore()
    {
        root = Path.Combine(Path.GetTempPath(), "SoulForge.Bridge", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
    }

    public ArtifactRecord Store(byte[] bytes)
    {
        if (bytes.Length <= 0 || bytes.Length > MaxArtifactBytes)
            throw new InvalidDataException($"Bridge artifact size {bytes.Length} is outside the allowed range.");
        var token = Guid.NewGuid().ToString("N");
        var path = Path.Combine(root, token + ".json");
        File.WriteAllBytes(path, bytes);
        if (!files.TryAdd(token, path))
        {
            File.Delete(path);
            throw new IOException("Bridge artifact token collision.");
        }
        return new ArtifactRecord(token, bytes.Length, ChunkSize);
    }

    public ArtifactChunk Read(string token, long offset, int length, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token) || !files.TryGetValue(token, out var path))
            throw new InvalidDataException("Bridge artifact token is unknown or expired.");
        if (offset < 0 || length <= 0 || length > ChunkSize)
            throw new ArgumentOutOfRangeException(nameof(length), "Bridge artifact chunk range is invalid.");

        var totalLength = checked((int)new FileInfo(path).Length);
        if (offset >= totalLength || offset + length > totalLength)
            throw new InvalidDataException("Bridge artifact chunk range exceeds the artifact.");

        var bytes = new byte[length];
        using var stream = File.OpenRead(path);
        stream.Position = offset;
        cancellationToken.ThrowIfCancellationRequested();
        stream.ReadExactly(bytes, 0, bytes.Length);
        return new ArtifactChunk(bytes, totalLength);
    }

    public void Dispose()
    {
        files.Clear();
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public sealed record ArtifactRecord(string Token, int ByteLength, int ChunkSize);
    public sealed record ArtifactChunk(byte[] Bytes, int TotalLength);
}

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
    public string? Priority { get; init; }
}

internal sealed class BridgeCancelPayload
{
    public string? TargetRequestId { get; init; }
}

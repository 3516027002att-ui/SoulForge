using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using SoulForge.Bridge.Hkx;

// 物理身份：rowIndex + expectedId + expectedDataHash 贯穿 DTO/Map/key，重复 ID 的 id-only 写入必须拒绝，页 DTO 携带 dataHash。
internal sealed class BridgeCommandService
{
    private const int MaxPrefixBytes = 512 * 1024;
    // read-emevd-document 单页最大指令数。真实 common.emevd 有 33266 条，取 65536
    // 可让常见事件文件一帧读完；再大的 EMEVD 仍需分页（帧上限 16 MiB）。
    private const int MaxInstructionPageSize = 65536;
    // read-tpf-texture-preview 的预览边长上限。与 DdsCodec.DecodeDdsToPngPreview
    // 配合：全分辨率 PNG 的 base64 会超 bridge 帧上限，预览受界下采样到该边长。
    private const int PreviewMaxDimension = 512;

    public async Task<BridgeResult<object>> ExecuteAsync(
        string rawCommand,
        string file,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null,
        JsonElement options = default,
        string? outputPath = null,
        IReadOnlyList<string>? allowedRoots = null,
        string? workspaceSessionId = null)
    {
        var command = rawCommand.Trim().ToLowerInvariant();

        // options 的默认值是 default(JsonElement)，其 ValueKind 为 Undefined。
        // 对 Undefined 调 TryGetProperty 抛 InvalidOperationException
        // ("Operation is not valid due to the current state of the object.")。
        //
        // 实测踩过：read-param-document 在调用方不传 commandOptions 时必然抛这个，
        // 而本方法的 catch 只捕获 InvalidDataException / NotSupportedException /
        // IOException，于是异常逃到守护进程兜底、被压成无出处的
        // BRIDGE_REQUEST_FAILED。表面症状是「PARAM 读不出来」，真实原因是
        // 「分页参数缺省时没有守卫」——两者相差很远，而原来的错误信息指不出方向。
        //
        // 统一走 OptionInt：它先验 ValueKind，缺省即取默认值。
        // 此前 :221 的 EMEVD 分页有 optionsObject 守卫而 PARAM/FLVER 没有，
        // 同一文件里两种写法并存，正是这类缺陷的温床。
        var optionsIsObject = options.ValueKind == JsonValueKind.Object;

        int OptionInt(string name, int fallback)
        {
            if (!optionsIsObject) return fallback;
            if (!options.TryGetProperty(name, out var element)) return fallback;
            if (element.ValueKind != JsonValueKind.Number) return fallback;
            return element.TryGetInt32(out var parsed) ? parsed : fallback;
        }

        long OptionInt64(string name, long fallback)
        {
            if (!optionsIsObject) return fallback;
            if (!options.TryGetProperty(name, out var element)) return fallback;
            if (element.ValueKind != JsonValueKind.Number) return fallback;
            return element.TryGetInt64(out var parsed) ? parsed : fallback;
        }

        bool OptionBool(string name, bool fallback)
        {
            if (!optionsIsObject) return fallback;
            if (!options.TryGetProperty(name, out var element)) return fallback;
            if (element.ValueKind != JsonValueKind.True && element.ValueKind != JsonValueKind.False) return fallback;
            return element.GetBoolean();
        }

        string OptionString(string name, string fallback)
        {
            if (!optionsIsObject) return fallback;
            if (!options.TryGetProperty(name, out var element)) return fallback;
            if (element.ValueKind != JsonValueKind.String) return fallback;
            var value = element.GetString();
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        string OptionPath(string name, string fallback)
        {
            var candidate = OptionString(name, fallback);
            var roots = allowedRoots is { Count: > 0 }
                ? allowedRoots
                : new[] { Path.GetDirectoryName(file) ?? file };
            var boundary = BridgePathBoundary.Verify(candidate, roots);
            if (!boundary.Ok)
                throw new InvalidDataException($"{boundary.Code}: options.{name} 不在当前 Bridge allowed roots 内：{candidate}");
            return boundary.CanonicalPath;
        }

        var resourceKind = command switch
        {
            "export-event" => "event",
            "export-map" => "map",
            "export-param" => "param",
            "export-msg" => "msg",
            _ => GuessKindFromPath(file)
        };

        if (command == "probe-oodle")
        {
            var probe = OodleRuntimeLocator.Probe(file, BridgeResult<object>.MakeSourceUri(file));
            return BridgeResult<object>.Partial(file, "unknown", probe.Diagnostics, probe);
        }

        if (command == "probe-document-locator")
        {
            return ProbeDocumentLocator(file, oodleRuntimeRoot, resourceKind);
        }

        if (command == "inventory-asset-resources")
        {
            return InventoryAssetResources(file, options, oodleRuntimeRoot, cancellationToken);
        }

        if (!File.Exists(file))
        {
            return BridgeResult<object>.Failed(file, resourceKind, "FILE_NOT_FOUND", "Input file does not exist.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        if (command is "inspect" or "validate")
        {
            return await InspectEnvelopeAsync(file, command == "validate", cancellationToken, oodleRuntimeRoot);
        }

        if (command == "read-dcx-document")
        {
            try
            {
                var document = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        roundTrip.PayloadIdentical ? "info" : "warning",
                        roundTrip.PayloadIdentical ? "DCX_DOCUMENT_ROUNDTRIP_PAYLOAD_VERIFIED" : "DCX_DOCUMENT_ROUNDTRIP_UNVERIFIED",
                        roundTrip.PayloadIdentical
                            ? "DCX 完整 payload 重建、重读和哈希验证通过。"
                            : roundTrip.Note ?? "DCX 完整文档 roundtrip 尚未验证。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                // includePayload=true 且 payload 足够小时返回 payloadBase64：供
                // 测试/工具拿到解压后的裸 payload（如 GPARAM loose 样本）。
                var includePayload = optionsIsObject
                    && options.TryGetProperty("includePayload", out var includeEl)
                    && includeEl.ValueKind == JsonValueKind.True;
                return BridgeResult<object>.Partial(file, GuessKindFromPath(file), diagnostics,
                    document.ToEnvelope(roundTrip, includePayload));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or InvalidOperationException or IOException)
            {
                return BridgeResult<object>.Failed(file, GuessKindFromPath(file), "DCX_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "list-bnd4-entries")
        {
            try
            {
                var includeContentHashes = OptionBool("includeContentHashes", false);
                var (dcx, binder) = Bnd4NativeWriter.GetCachedBinder(file, oodleRuntimeRoot);
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        "info",
                        "BND4_ENTRIES_LISTED",
                        $"BND4 条目已列出：{binder.Entries.Count} 项（{dcx.CompressionFormat}）。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { entryCount = binder.Entries.Count, compressionFormat = dcx.CompressionFormat })
                };
                var entries = binder.Entries.Select(entry => new
                {
                    index = entry.Index,
                    id = entry.Id,
                    name = entry.Name,
                    flags = entry.Flags,
                    unknown = entry.Unknown,
                    duplicateOrdinal = entry.DuplicateOrdinal,
                    compressedSize = entry.CompressedSize,
                    uncompressedSize = entry.UncompressedSize,
                    dataOffset = entry.DataOffset,
                    nameOffset = entry.NameOffset,
                    contentHash = includeContentHashes ? entry.ContentHash : null,
                    size = entry.UncompressedSize
                }).ToArray();
                var payload = new
                {
                    format = "DCX",
                    compressionFormat = dcx.CompressionFormat,
                    variant = dcx.Variant,
                    sourceSize = dcx.SourceBytes.Length,
                    sourceHash = dcx.SourceHash,
                    payloadHash = dcx.PayloadHash,
                    entryCount = binder.Entries.Count,
                    entries,
                    telemetry = BridgeTelemetry.Snapshot(),
                    workspaceSessionId,
                    pathSourceGeneration = OptionInt64("pathSourceGeneration", 0)
                };
                diagnostics.Add(new Diagnostic("info", "BRIDGE_TELEMETRY", "telemetry", BridgeResult<object>.MakeSourceUri(file), BridgeTelemetry.Snapshot()));
                return BridgeResult<object>.Partial(file, resourceKind, diagnostics, payload);
            }
            catch (OodleRuntimeUnavailableException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_LIST_KRAK_OODLE_UNAVAILABLE", "这份容器是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再列目录。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or InvalidOperationException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_LIST_FAILED", ex.Message);
            }
        }

        if (command == "snapshot-bnd4-child")
        {
            try
            {
                var snapshot = Bnd4NativeWriter.SnapshotChild(file, options, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_CHILD_SNAPSHOT_CAPTURED", "BND4 子项快照已捕获，可用于条目级逆操作。", BridgeResult<object>.MakeSourceUri(file), snapshot)
                }, snapshot);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_SNAPSHOT_FAILED", ex.Message);
            }
        }

        if (command == "extract-bnd4-child")
        {
            // outputPath 必须用 daemon 已校验并规范化的那一个，不能让 writer 自己再从
            // options 里取原始字符串：daemon 侧对 writable-root 的判定是针对
            // BridgePathBoundary.Verify 的 CanonicalPath 做的，writer 若绕回原始值，
            // 「..」「符号链接」「大小写差异」这类等价路径就能落在校验之外——校验通过、
            // 落盘却在别处。CLI 直调模式没有 daemon 协商的 writableRoots，此时
            // outputPath 为 null，仍回落到 options（与其他 writer 命令一致）。
            if (string.IsNullOrWhiteSpace(outputPath))
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_OUTPUT_REQUIRED",
                    "extract-bnd4-child 需要 options.outputPath，且必须经 writable-root 校验。");
            }
            try
            {
                var result = Bnd4NativeWriter.ExtractChild(file, outputPath, options, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_CHILD_EXTRACTED", "BND4 子项已提取到文件。", BridgeResult<object>.MakeSourceUri(file), result)
                }, result);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_EXTRACT_FAILED", ex.Message);
            }
        }

        if (command == "read-fmg-document")
        {
            try
            {
                var document = FmgNativeDocument.Read(NativeLeafPayload.Resolve(file, oodleRuntimeRoot, ".fmg"));
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "FMG_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "FMG_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "FMG 无修改往返字节级一致。"
                                : "FMG 无修改往返语义一致（布局归一化后哈希不同仍可接受）。")
                            : "FMG 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "msg", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "msg", "FMG_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-fmg")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "msg", "BRIDGE_OUTPUT_PATH_REQUIRED", "FMG writer requires a validated staging output path.");
            try
            {
                var written = await FmgNativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, "msg", new[]
                {
                    new Diagnostic("info", "FMG_STAGING_WRITE_VERIFIED", "FMG 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "msg", "FMG_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-text-catalog")
        {
            // TEXT-20A：容器级文本目录。tableEntryIndex 缺省只返回目录元数据；
            // 指定时额外返回该表完整条目（主进程缓存后分页，不经临时文件）。
            var tableEntryIndex = optionsIsObject
                && options.TryGetProperty("tableEntryIndex", out var entryIndexEl)
                && entryIndexEl.ValueKind == JsonValueKind.Number
                && entryIndexEl.TryGetInt32(out var parsedEntryIndex)
                ? parsedEntryIndex
                : (int?)null;
            try
            {
                var catalog = FmgTextCatalogReader.Read(file, oodleRuntimeRoot, tableEntryIndex);
                return BridgeResult<object>.Partial(file, "msg", new[]
                {
                    new Diagnostic("info", "TEXT_CATALOG_CONFIRMED",
                        $"Bridge 已确认文本容器：{catalog.LanguageId}/{catalog.ContainerKind}，{catalog.TableCount} 个 FMG 表。",
                        BridgeResult<object>.MakeSourceUri(file), catalog)
                }, catalog);
            }
            catch (NotSupportedException ex)
            {
                return BridgeResult<object>.Failed(file, "msg", "TEXT_CATALOG_ROUTE_REJECTED", ex.Message);
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, "msg", "TEXT_CATALOG_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-param-document")
        {
            try
            {
                if (OptionBool("headerOnly", false))
                {
                    var header = ParamNativeDocument.ReadHeaderFile(file);
                    return BridgeResult<object>.Partial(
                        file,
                        "param",
                        new[]
                        {
                            new Diagnostic(
                                "info",
                                "PARAM_HEADER_READ",
                                "PARAM 头部已读取；未解析行数据。",
                                BridgeResult<object>.MakeSourceUri(file))
                        },
                        header);
                }
                var expectedRowDataSize = OptionInt("expectedRowDataSize", 0);
                var rowPage = OptionInt("rowPage", 0);
                var rowPageSize = OptionInt("rowPageSize", 0);
                var includeAllPayloads = OptionBool("includeAllPayloads", false);
                var includeRowHashes = OptionBool("includeRowHashes", false);
                bool? includeRowPayloads = null;
                if (optionsIsObject && options.TryGetProperty("includeRowPayloads", out var irpEl))
                {
                    if (irpEl.ValueKind == JsonValueKind.True) includeRowPayloads = true;
                    else if (irpEl.ValueKind == JsonValueKind.False) includeRowPayloads = false;
                }
                var pathSourceGeneration = OptionInt64("pathSourceGeneration", 0);
                var entryIdentity = OptionString("entryIdentity", string.Empty);
                var documentSession = OptionString("documentSession", string.Empty);
                var correlationId = OptionString("correlationId", Guid.NewGuid().ToString("N"));
                int[]? rowIds = null;
                if (optionsIsObject && options.TryGetProperty("rowIds", out var rowIdsElement)
                    && rowIdsElement.ValueKind == JsonValueKind.Array)
                {
                    var ids = new List<int>();
                    foreach (var item in rowIdsElement.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out var id))
                            ids.Add(id);
                    }
                    if (ids.Count > 0) rowIds = ids.ToArray();
                }
                List<(int rowIndex, int expectedId, string expectedDataHash)>? rowSelections = null;
                if (optionsIsObject && options.TryGetProperty("rowSelections", out var rsEl)
                    && rsEl.ValueKind == JsonValueKind.Array)
                {
                    var list = new List<(int, int, string)>();
                    foreach (var item in rsEl.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object) continue;
                        if (!item.TryGetProperty("rowIndex", out var riEl) || !riEl.TryGetInt32(out var ri)) continue;
                        if (!item.TryGetProperty("expectedId", out var eiEl) || !eiEl.TryGetInt32(out var ei)) continue;
                        if (!item.TryGetProperty("expectedDataHash", out var ehEl) || ehEl.ValueKind != JsonValueKind.String) continue;
                        var eh = ehEl.GetString() ?? string.Empty;
                        list.Add((ri, ei, eh));
                    }
                    if (list.Count > 0) rowSelections = list;
                }
                // session-aware: try token first, else open/get by key (single parse)
                ParamDocumentSessionCache.Entry entry;
                string sessionToken;
                bool isNewSession = false;
                string curSourceHash = string.Empty;
                if (!string.IsNullOrWhiteSpace(documentSession)
                    && ParamDocumentSessionCache.TryGetByToken(documentSession, file, workspaceSessionId ?? string.Empty, pathSourceGeneration, out var hit, out curSourceHash))
                {
                    entry = hit;
                    sessionToken = documentSession;
                }
                else if (!string.IsNullOrWhiteSpace(documentSession))
                {
                    return BridgeResult<object>.Failed(file, "param", "PARAM_DOCUMENT_SESSION_EXPIRED", "PARAM 文档会话已过期或与当前文件/工作区不匹配，请重开会话。");
                }
                else
                {
                    entry = ParamDocumentSessionCache.GetOrOpen(file, workspaceSessionId ?? string.Empty, oodleRuntimeRoot, pathSourceGeneration, expectedRowDataSize, entryIdentity, out sessionToken, out isNewSession, out curSourceHash);
                }
                var document = entry.Document;
                var roundTrip = entry.RoundTrip;
                // B4 slim: rowSelections path — validates physical identity, no partial success
                if (rowSelections is not null)
                {
                    const int batchMax = 256;
                    if (rowSelections.Count > batchMax)
                        return BridgeResult<object>.Failed(file, "param", "PARAM_ROW_PAYLOAD_BATCH_EXCEEDED", $"单次 rowSelections {rowSelections.Count} 超过上限 {batchMax}。");
                    if (string.IsNullOrWhiteSpace(documentSession))
                        return BridgeResult<object>.Failed(file, "param", "PARAM_DOCUMENT_SESSION_EXPIRED", "rowSelections 需要 documentSession。");
                    bool slimIncludePayload = includeRowPayloads != false;
                    // includeRowPayloads must be true for rowSelections with payload; enforce explicit opt-in
                    if (includeRowPayloads == false)
                        return BridgeResult<object>.Failed(file, "param", "PARAM_ROW_IDENTITY_MISMATCH", "rowSelections 与 includeRowPayloads=false 不兼容。");
                    // validate all identities atomically before emitting any payload
                    var slimRows = new List<object>(rowSelections.Count);
                    foreach (var sel in rowSelections)
                    {
                        if (sel.rowIndex < 0 || sel.rowIndex >= document.Rows.Count)
                            return BridgeResult<object>.Failed(file, "param", "PARAM_ROW_IDENTITY_MISMATCH", $"物理行索引 {sel.rowIndex} 越界（rowCount={document.Rows.Count}）。");
                        var actual = document.Rows[sel.rowIndex];
                        if (actual.Id != sel.expectedId)
                            return BridgeResult<object>.Failed(file, "param", "PARAM_ROW_IDENTITY_MISMATCH", $"行 {sel.rowIndex} 的 id 已变化：expected={sel.expectedId} actual={actual.Id}。");
                        var actualHash = ParamNativeDocument.ComputeRowDataHash(actual.Data);
                        if (!string.Equals(actualHash, sel.expectedDataHash, StringComparison.OrdinalIgnoreCase))
                            return BridgeResult<object>.Failed(file, "param", "PARAM_ROW_IDENTITY_MISMATCH", $"行 {sel.rowIndex} 的 dataHash 已变化。");
                        slimRows.Add(new { rowIndex = sel.rowIndex, id = actual.Id, name = actual.Name, dataBase64 = slimIncludePayload ? Convert.ToBase64String(actual.Data) : null, dataHash = actualHash });
                    }
                    var slimEnvelope = new { format = "PARAM", typeName = document.TypeName, dataVersion = document.DataVersion, rowCount = document.Rows.Count, rowDataSize = document.RowDataSize, layout = document.Layout == ParamLayout.Standard32 ? "standard-32" : "long-64", sourceSize = document.SourceBytes.Length, sourceHash = document.SourceHash, rows = slimRows.ToArray(), payloadsIncluded = slimIncludePayload, sessionToken, workspaceSessionId, sourceHash2 = curSourceHash, pathSourceGeneration, correlationId };
                    var slimData = new Dictionary<string, object?>(StringComparer.Ordinal);
                    foreach (var p in slimEnvelope.GetType().GetProperties()) slimData[p.Name] = p.GetValue(slimEnvelope);
                    slimData["sessionToken"] = sessionToken;
                    slimData["workspaceSessionId"] = workspaceSessionId;
                    slimData["sourceHash"] = curSourceHash;
                    slimData["pathSourceGeneration"] = pathSourceGeneration;
                    slimData["correlationId"] = correlationId;
                    slimData["telemetry"] = BridgeTelemetry.Snapshot();
                    System.Threading.Interlocked.Add(ref BridgeTelemetry.ParamSerializedRowsCount, slimRows.Count);
                    var slimDiags = new List<Diagnostic>
                    {
                        new Diagnostic(roundTrip.SemanticIdentical ? "info" : "error", roundTrip.SemanticIdentical ? "PARAM_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "PARAM_DOCUMENT_ROUNDTRIP_FAILED", roundTrip.SemanticIdentical ? (roundTrip.ByteIdentical ? "PARAM 无修改往返字节级一致。" : "PARAM 无修改往返语义一致。") : "PARAM 无修改往返语义不一致。", BridgeResult<object>.MakeSourceUri(file), roundTrip),
                        new Diagnostic("info", "PARAM_DOCUMENT_SESSION", $"session {sessionToken} gen {pathSourceGeneration} parse {(isNewSession?1:0)}", BridgeResult<object>.MakeSourceUri(file), new { sessionToken, workspaceSessionId, sourceHash = curSourceHash, pathSourceGeneration, entryIdentity, correlationId, isNewSession, telemetry = BridgeTelemetry.Snapshot() })
                    };
                    return BridgeResult<object>.Partial(file, "param", slimDiags.ToArray(), slimData);
                }
                // Slim index: includeRowPayloads == false forces no payload regardless of budget
                bool forceSlimIndex = includeRowPayloads == false;
                // page projection defaults to 20 rows when caller asks for page without explicit size
                if (rowPageSize == 0 && rowIds == null && !includeAllPayloads)
                {
                    // index projection when no page requested: return all rows as index (no hash unless requested)
                    // page projection when page requested: rowPageSize defaults to 20
                    // Caller explicitly sets rowPageSize for page; index caller leaves it 0
                }
                else if (rowPageSize == 0 && rowIds == null)
                {
                    // explicit page index without size means page size 20 per spec
                }
                // For page requests where caller set rowPage but not rowPageSize, default 20
                if (rowPageSize == 0 && (OptionBool("isPageRequest", false) || rowPage > 0))
                    rowPageSize = 20;
                // If caller did not specify includeRowHashes, index (no page) stays without hash, page gets hash
                bool effectiveIncludeHashes = includeRowHashes;
                if (!optionsIsObject || !options.TryGetProperty("includeRowHashes", out _))
                {
                    // default false for index; page requests automatically get hashes
                    if (rowPageSize > 0 || rowIds != null) effectiveIncludeHashes = true;
                    else effectiveIncludeHashes = false;
                }
                if (rowPageSize == 0 && rowIds == null && !includeAllPayloads && effectiveIncludeHashes == false)
                {
                    // index already false
                }
                var envelope = document.ToEnvelope(roundTrip, rowPageSize: rowPageSize, rowPage: rowPage,
                    includeAllPayloads: includeAllPayloads, rowIds: rowIds, includeRowHashes: effectiveIncludeHashes);
                // track serialized rows
                var rowsInEnvelope = 0;
                if (envelope is not null)
                {
                    try { var prop = envelope.GetType().GetProperty("rows"); if (prop != null) { var arr = prop.GetValue(envelope) as System.Collections.ICollection; if (arr != null) rowsInEnvelope = arr.Count; } } catch {}
                }
                System.Threading.Interlocked.Add(ref BridgeTelemetry.ParamSerializedRowsCount, rowsInEnvelope);
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "PARAM_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "PARAM_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "PARAM 无修改往返字节级一致。"
                                : "PARAM 无修改往返语义一致。")
                            : "PARAM 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                diagnostics.Add(new Diagnostic("info", "PARAM_DOCUMENT_SESSION", $"session {sessionToken} gen {pathSourceGeneration} parse {(isNewSession?1:0)}", BridgeResult<object>.MakeSourceUri(file), new { sessionToken, workspaceSessionId, sourceHash = curSourceHash, pathSourceGeneration, entryIdentity, correlationId, isNewSession, telemetry = BridgeTelemetry.Snapshot() }));
                // Keep the legacy PARAM envelope fields at data.*. Session metadata is
                // additive; nesting the envelope under data.envelope breaks existing
                // callers that read data.rowDataSize / data.rows / data.sourceHash.
                var responseData = new Dictionary<string, object?>(StringComparer.Ordinal);
                if (envelope is not null)
                    foreach (var property in envelope.GetType().GetProperties())
                        responseData[property.Name] = property.GetValue(envelope);
                if (forceSlimIndex && responseData.TryGetValue("rows", out var rowsObj) && rowsObj is System.Collections.IEnumerable rowsEnum)
                {
                    var slimRows = new List<object>();
                    foreach (var item in rowsEnum)
                    {
                        if (item == null) continue;
                        var t = item.GetType();
                        var ri = (int)(t.GetProperty("rowIndex")?.GetValue(item) ?? 0);
                        var id = (int)(t.GetProperty("Id")?.GetValue(item) ?? t.GetProperty("id")?.GetValue(item) ?? 0);
                        var name = t.GetProperty("Name")?.GetValue(item) ?? t.GetProperty("name")?.GetValue(item);
                        var dh = t.GetProperty("dataHash")?.GetValue(item);
                        slimRows.Add(new { rowIndex = ri, id, name, dataBase64 = (string?)null, dataHash = dh });
                    }
                    responseData["rows"] = slimRows.ToArray();
                    responseData["payloadsIncluded"] = false;
                }
                responseData["sessionToken"] = sessionToken;
                responseData["workspaceSessionId"] = workspaceSessionId;
                responseData["sourceHash"] = curSourceHash;
                responseData["pathSourceGeneration"] = pathSourceGeneration;
                responseData["correlationId"] = correlationId;
                responseData["telemetry"] = BridgeTelemetry.Snapshot();
                return BridgeResult<object>.Partial(file, "param", diagnostics.ToArray(),
                    responseData);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                var code = ex.Message.Contains("需要 PARAMDEF 行宽", StringComparison.Ordinal)
                    ? "PARAM_ROW_SIZE_REQUIRED"
                    : ex.Message.Contains("首行数据偏移", StringComparison.Ordinal)
                        ? "PARAM_LAYOUT_UNSUPPORTED"
                        : "PARAM_DOCUMENT_READ_FAILED";
                return BridgeResult<object>.Failed(file, "param", code, ex.Message);
            }
        }

        if (command == "read-gparam-document")
        {
            try
            {
                // 支持 loose .gparam 与 .gparam.dcx：DCX 由 DcxNativeDocument 解压，
                // 裸文件直接读字节。GPARAM 解析不借用 PARAM parser —— group/param
                // 嵌套与值类型是独立格式家族（见 GparamNativeDocument 布局说明）。
                var sourceBytes = Path.GetExtension(file).Equals(".dcx", StringComparison.OrdinalIgnoreCase)
                    ? DcxNativeDocument.Read(file, oodleRuntimeRoot).Payload
                    : File.ReadAllBytes(file);
                var document = GparamNativeDocument.Read(sourceBytes);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "GPARAM_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "GPARAM_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "GPARAM 无修改往返字节级一致。"
                                : "GPARAM 无修改往返语义一致。")
                            : roundTrip.Note ?? "GPARAM 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                // 分页参数来自请求 options；groupPageSize=0 时全量返回（实测
                // 34 个样本均 ≤ 23 group × ≤ 25 param × 255 值，单帧在 1MB 内）。
                var groupPage = OptionInt("groupPage", 0);
                var groupPageSize = OptionInt("groupPageSize", 0);
                return BridgeResult<object>.Partial(file, "gparam", diagnostics,
                    document.ToEnvelope(roundTrip, groupPage: groupPage, groupPageSize: groupPageSize));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                var code = ex is NotSupportedException
                    ? "GPARAM_GAME_UNSUPPORTED"
                    : "GPARAM_DOCUMENT_READ_FAILED";
                return BridgeResult<object>.Failed(file, "gparam", code, ex.Message);
            }
        }

        if (command == "write-gparam")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "gparam", "BRIDGE_OUTPUT_PATH_REQUIRED", "GPARAM writer requires a validated staging output path.");
            try
            {
                var written = await GparamNativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, "gparam", new[]
                {
                    new Diagnostic("info", "GPARAM_STAGING_WRITE_VERIFIED", "GPARAM 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or FormatException)
            {
                return BridgeResult<object>.Failed(file, "gparam", "GPARAM_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "write-param")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "param", "BRIDGE_OUTPUT_PATH_REQUIRED", "PARAM writer requires a validated staging output path.");
            try
            {
                var written = await ParamNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "param", new[]
                {
                    new Diagnostic("info", "PARAM_STAGING_WRITE_VERIFIED", "PARAM 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or FormatException)
            {
                return BridgeResult<object>.Failed(file, "param", "PARAM_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-emevd-document")
        {
            try
            {
                // EVENT-30A: production open accepts the outer source resource
                // as-is — raw .emevd OR DFLT/KRAK-wrapped .dcx. DCX unwrap is
                // native (DcxNativeDocument), so the TypeScript side never
                // imports a second DCX parser and never hands back a
                // decompressed temp file to be reused as the Patch target.
                // 分页读同一份文件时，DCX inflate / EMEVD 解析 / VerifyRoundTrip
                // 三步的结果与 page 无关，经 EmevdDocumentSessionCache 复用。
                // 键含外层文件完整 SHA-256（不是 mtime + length）：外部工具做等长
                // 改写并回写原 mtime 时，前者能看出内容变了，后者看不出。
                // cachePolicy=bypass 无条件重读磁盘，既不命中也不写缓存 —— 提交前
                // 的新鲜读与写回后的重读用它。
                var cachePolicy = OptionString("cachePolicy", "default") == "bypass"
                    ? EmevdDocumentSessionCache.CachePolicy.Bypass
                    : EmevdDocumentSessionCache.CachePolicy.Default;
                var resumeSession = OptionString("documentSession", "");
                EmevdDocumentSessionCache.Lookup cached;
                var hooks = EmevdDocumentSessionCache.TestHooksEnabled
                    ? new EmevdDocumentSessionCache.TestHooks
                    {
                        HoldUntilFile = EmptyToNull(OptionString("testHoldUntilFile", "")),
                        RewriteAfterRead = EmptyToNull(OptionString("testRewriteAfterRead", "")),
                        CompletedFile = EmptyToNull(OptionString("testCompletedFile", "")),
                        SignalFile = EmptyToNull(OptionString("testSignalFile", ""))
                    }
                    : null;
                async Task<EmevdDocumentSessionCache.Lookup> LoadThroughCache() =>
                    await EmevdDocumentSessionCache.GetOrAddAsync(
                        file,
                        oodleRuntimeRoot,
                        (bytes, loadToken) =>
                        {
                            loadToken.ThrowIfCancellationRequested();
                            string loadedFormat;
                            string? loadedOuterHash;
                            EmevdNativeDocument loaded;
                            if (IsDcxBytes(bytes))
                            {
                                var dcx = DcxNativeDocument.Read(bytes, oodleRuntimeRoot, file);
                                loadToken.ThrowIfCancellationRequested();
                                loaded = EmevdNativeDocument.Read(dcx.Payload, loadToken);
                                loadedFormat = "dcx";
                                loadedOuterHash = dcx.SourceHash;
                            }
                            else
                            {
                                loaded = EmevdNativeDocument.Read(bytes, loadToken);
                                loadedFormat = "emevd";
                                loadedOuterHash = loaded.SourceHash;
                            }
                            loadToken.ThrowIfCancellationRequested();
                            return new EmevdDocumentSessionCache.Entry(
                                loaded, loaded.VerifyRoundTrip(loadToken), loadedFormat, loadedOuterHash);
                        },
                        cachePolicy,
                        cancellationToken,
                        hooks);
                if (resumeSession.Length > 0)
                {
                    var sessionKind = EmevdDocumentSessionCache.TryGetSession(
                        resumeSession, file, oodleRuntimeRoot, out var sessionHit);
                    if (sessionKind == EmevdDocumentSessionCache.SessionLookupKind.Mismatch)
                    {
                        return BridgeResult<object>.Failed(
                            file,
                            "event",
                            "EMEVD_DOCUMENT_SESSION_MISMATCH",
                            "文档会话与请求的文件不一致，已拒绝以免返回错误文档。");
                    }
                    cached = sessionKind == EmevdDocumentSessionCache.SessionLookupKind.Hit
                        ? sessionHit
                        : await LoadThroughCache();
                }
                else
                {
                    cached = await LoadThroughCache();
                }
                var document = cached.Entry.Document;
                var sourceFormat = cached.Entry.SourceFormat;
                var outerFileHash = cached.Entry.OuterFileHash;
                var roundTrip = cached.Entry.RoundTrip;
                var requestedPage = OptionInt("instructionPage", 0);
                var page = requestedPage >= 0 ? requestedPage : 0;
                // 上限提到 MaxInstructionPageSize：一次拿完 33266 条指令只需一帧，
                // 省掉 64 次 NDJSON 往返。分页能力保留（超大 EMEVD 仍会超帧上限）。
                var requestedPageSize = OptionInt("instructionPageSize", 256);
                var pageSize = requestedPageSize >= 1 && requestedPageSize <= MaxInstructionPageSize
                    ? requestedPageSize
                    : 256;
                var cacheObservation = cached.Observation;
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "EMEVD_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "EMEVD_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "EMEVD 无修改往返字节级一致。"
                                : "EMEVD 事件表语义往返一致。")
                            : "EMEVD 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip),
                    // 缓存行为在进程外不可见：命中与「重解析出同样内容」返回的字节完全
                    // 相同。这条 info 诊断是同文件并发合并、bypass 不写缓存、不同文件
                    // 不在全局锁上串行这几条属性唯一的确定性观测口。
                    new Diagnostic(
                        "info",
                        "EMEVD_DOCUMENT_CACHE_STATE",
                        $"EMEVD 文档缓存：{cacheObservation.State}。",
                        BridgeResult<object>.MakeSourceUri(file),
                        cacheObservation)
                };
                return BridgeResult<object>.Partial(file, "event", diagnostics,
                    document.ToEnvelope(roundTrip, page, pageSize, sourceFormat, outerFileHash, cached.SessionToken));
            }
            catch (OodleRuntimeUnavailableException)
            {
                // KRAK 压缩且本机没有可用的 Oodle 运行库（未挂原版目录 / 缺 dll）。
                // 与 MSB 同一套可行动话术：告诉用户去哪挂原版，而不是只丢一个失败码。
                return BridgeResult<object>.Failed(
                    file,
                    "event",
                    "EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE",
                    "这份事件是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or InvalidOperationException)
            {
                return BridgeResult<object>.Failed(file, "event", "EMEVD_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-emevd")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "event", "BRIDGE_OUTPUT_PATH_REQUIRED", "EMEVD writer requires a validated staging output path.");
            try
            {
                var written = await EmevdNativeWriter.WriteAsync(file, outputPath, oodleRuntimeRoot, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "event", new[]
                {
                    new Diagnostic("info", "EMEVD_STAGING_WRITE_VERIFIED", "EMEVD 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (OodleRuntimeUnavailableException)
            {
                // KRAK outer 写回需要 Oodle 压缩运行库；缺它时给出与读链一致的可行动提示。
                return BridgeResult<object>.Failed(
                    file,
                    "event",
                    "EMEVD_STAGING_WRITE_KRAK_OODLE_UNAVAILABLE",
                    "这份事件是 KRAK 压缩，写回需要 Oodle 运行库：到「开始」页选择含 sekiro.exe 的原版目录后再保存。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "event", "EMEVD_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-msb-document")
        {
            try
            {
                var document = MsbNativeDocument.Read(NativeLeafPayload.Resolve(file, oodleRuntimeRoot));
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "MSB_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "MSB_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"MSB 已解析 models={document.Models.Count}, parts={document.Parts.Count}；part transform 可写。"
                            : "MSB 语义往返失败。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "map", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (OodleRuntimeUnavailableException)
            {
                // mods 里 9 张 DFLT 图不挂原版也能开；只有原版 KRAK 图需要 Oodle。
                // 失败码 + 可行动话术直接进编辑区，不再让用户翻日志猜「头 4 字节」。
                return BridgeResult<object>.Failed(
                    file,
                    "map",
                    "MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE",
                    "这份地图是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-tpf-document")
        {
            try
            {
                var payload = NativeLeafPayload.Resolve(file, oodleRuntimeRoot, ".tpf");
                var document = TpfNativeDocument.Read(payload);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.ByteIdentical ? "info" : "error",
                        roundTrip.ByteIdentical ? "TPF_DOCUMENT_ROUNDTRIP_BYTE_VERIFIED" : "TPF_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.ByteIdentical
                            ? "TPF 无修改往返字节级一致。"
                            : "TPF 无修改往返字节不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "texture", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "export-tpf-texture")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_EXPORT_OUTPUT_REQUIRED", "export-tpf-texture 需要 options.outputPath。");
            }
            int textureIndex = 0;
            if (options.ValueKind == JsonValueKind.Object
                && options.TryGetProperty("textureIndex", out var indexElement)
                && indexElement.ValueKind == JsonValueKind.Number)
            {
                textureIndex = indexElement.GetInt32();
            }
            string format = "dds";
            if (options.ValueKind == JsonValueKind.Object
                && options.TryGetProperty("format", out var formatElement)
                && formatElement.ValueKind == JsonValueKind.String)
            {
                format = formatElement.GetString() ?? "dds";
            }
            try
            {
                var document = TpfNativeDocument.Read(NativeLeafPayload.Resolve(file, oodleRuntimeRoot, ".tpf"));
                var dds = document.GetTextureData(textureIndex);
                byte[] outputBytes;
                string code;
                string? pngColorSpace = null;
                if (format.Equals("png", StringComparison.OrdinalIgnoreCase))
                {
                    // 必须用带色彩空间的重载：DXGI 的 *_UNORM 与 *_UNORM_SRGB 解出的
                    // 像素值完全相同，区分只存在于头部声明里。丢掉它不会让任何断言
                    // 变红，只会让色彩管理的查看器按自己的假设解释亮度。
                    var (width, height, rgba, colorSpace) = DdsCodec.DecodeDdsWithColorSpace(dds);
                    outputBytes = DdsCodec.EncodePng(width, height, rgba, colorSpace);
                    pngColorSpace = colorSpace switch
                    {
                        DdsCodec.DdsColorSpace.Srgb => "srgb",
                        DdsCodec.DdsColorSpace.Linear => "linear",
                        _ => "unknown"
                    };
                    code = $"PNG {width}x{height}";
                }
                else
                {
                    outputBytes = dds;
                    code = "DDS";
                }
                // temp + Move(overwrite)，与五个 native writer 一致：直接写目标文件时
                // 中途失败（取消、磁盘满）会留下截断的图片，而它看起来像导出成功。
                var exportDirectory = Path.GetDirectoryName(outputPath);
                if (string.IsNullOrEmpty(exportDirectory))
                {
                    return BridgeResult<object>.Failed(file, "texture", "TPF_EXPORT_OUTPUT_INVALID", "outputPath 没有父目录。");
                }
                Directory.CreateDirectory(exportDirectory);
                var exportTemporary = Path.Combine(exportDirectory, $".soulforge-tpf-{Guid.NewGuid():N}.tmp");
                try
                {
                    await File.WriteAllBytesAsync(exportTemporary, outputBytes, cancellationToken);
                    File.Move(exportTemporary, outputPath, overwrite: true);
                }
                finally
                {
                    if (File.Exists(exportTemporary)) File.Delete(exportTemporary);
                }
                var entry = document.Textures[textureIndex];
                var exportDiagnostics = new List<Diagnostic>
                {
                    new Diagnostic("info", "TPF_TEXTURE_EXPORTED",
                        $"TPF 纹理 {textureIndex} 已导出为 {code}（{outputBytes.Length} 字节）。",
                        BridgeResult<object>.MakeSourceUri(file))
                };
                // 色彩空间未声明必须可见：不写诊断的话，「DDS 头没给信息」与「已确认线性」
                // 在产物上完全一样（都没有 sRGB chunk），下游无从区分（硬约束 7/8）。
                if (pngColorSpace == "unknown")
                {
                    exportDiagnostics.Add(new Diagnostic("warn", "TPF_TEXTURE_COLOR_SPACE_UNDECLARED",
                        "DDS 头未声明色彩空间（非 DX10 的 fourCC 形态不携带该信息），"
                        + "PNG 因此不写 sRGB/gAMA/cHRM chunk。这是「未声明」而非「已确认线性」；"
                        + "色彩管理的查看器会按自身默认假设解释，亮度可能与游戏内不一致。",
                        BridgeResult<object>.MakeSourceUri(file)));
                }
                return BridgeResult<object>.Partial(file, "texture", exportDiagnostics.ToArray(), new
                {
                    textureIndex,
                    name = entry.Name,
                    format,
                    outputPath,
                    byteLength = outputBytes.Length,
                    // 只在 PNG 路径有意义；DDS 直传不解码也不重写头，故为 null。
                    colorSpace = pngColorSpace
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_TEXTURE_EXPORT_FAILED", ex.Message);
            }
        }

        if (command == "read-tpf-texture-preview")
        {
            int textureIndex = 0;
            if (options.ValueKind == JsonValueKind.Object
                && options.TryGetProperty("textureIndex", out var indexElement)
                && indexElement.ValueKind == JsonValueKind.Number)
            {
                textureIndex = indexElement.GetInt32();
            }
            try
            {
                var document = TpfNativeDocument.Read(NativeLeafPayload.Resolve(file, oodleRuntimeRoot, ".tpf"));
                var (name, sourceWidth, sourceHeight, _, _) = document.GetTextureMetadata(textureIndex);
                var dds = document.GetTextureData(textureIndex);
                // 预览必须受界下采样：全分辨率 PNG 的 base64 会超 bridge 帧上限
                // （实测 BRIDGE_OUTBOUND_FRAME_TOO_LARGE）。原始尺寸经
                // sourceWidth/sourceHeight 上报，工作台属性栏仍能显示真实分辨率。
                var (width, height, png, colorSpace) = DdsCodec.DecodeDdsToPngPreview(dds, PreviewMaxDimension);
                var colorSpaceName = colorSpace switch
                {
                    DdsCodec.DdsColorSpace.Srgb => "srgb",
                    DdsCodec.DdsColorSpace.Linear => "linear",
                    _ => "unknown"
                };
                var previewToken = "data:image/png;base64," + Convert.ToBase64String(png);
                return BridgeResult<object>.Partial(file, "texture",
                    new[]
                    {
                        new Diagnostic("info", "TPF_TEXTURE_PREVIEW_READY",
                            $"TPF 纹理 {textureIndex} 预览已生成（{width}x{height} PNG，原始 {sourceWidth}x{sourceHeight}）。",
                            BridgeResult<object>.MakeSourceUri(file))
                    },
                    new
                    {
                        textureIndex,
                        name,
                        width,
                        height,
                        sourceWidth,
                        sourceHeight,
                        colorSpace = colorSpaceName,
                        mediaType = "image/png",
                        byteLength = png.Length,
                        previewToken
                    });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_TEXTURE_PREVIEW_FAILED", ex.Message);
            }
        }

        if (command == "write-tpf-texture-replace")
        {
            // TEXTURE-52C：TPF 单纹理替换写回。只收 typed replace（textureIndex +
            // newTextureBase64），outputPath 必须是已校验的暂存区路径（越界之外的
            // 边界检查由 BridgeDaemonHost 的 DiskWritingCommands 门在分派前完成）。
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "texture", "BRIDGE_OUTPUT_PATH_REQUIRED", "TPF writer requires a validated staging output path.");
            try
            {
                var written = await TpfNativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, "texture", new[]
                {
                    new Diagnostic("info", "TPF_STAGING_WRITE_VERIFIED", "TPF 纹理已替换并写入暂存区且重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-tae-document")
        {
            try
            {
                // T3（2026-08-15）：`*.anibnd.dcx` 是 DCX(DFLT)→BND4 容器，内含多个
                // 独立 TAE 条目。解 DCX→解析 BND4→按 "TAE " 魔数挑主 TAE
                // （优先 id 5000000，其次字节最大的 TAE 条目）→TaeNativeDocument.Read。
                // hkx 是逐条 DCX，本命令不读。envelope 合并提取来源诊断，使 UI 能
                // 显示「从 anibnd 提取」而不是把 BND4 子项当成容器打开。
                // S17：提取逻辑抽成 OpenTaeDocument，read-tae-event-params 共用，
                // 不再维护第二份 anibnd 解包。
                var (document, extractionDiagnostics) = OpenTaeDocument(file, oodleRuntimeRoot);

                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "TAE_DOCUMENT_ROUNDTRIP_VERIFIED" : "TAE_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"TAE 只读往返验证通过；animations={document.Animations.Count}, events={document.TotalEventCount}, groups={document.TotalGroupCount}。"
                            : "TAE 只读往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                }.Concat(extractionDiagnostics).ToArray();
                // 分页参数（默认全量）：animationPage / animationPageSize；兼容 pageSize 别名。
                int? animationPage = null;
                int? animationPageSize = null;
                if (optionsIsObject)
                {
                    if (options.TryGetProperty("animationPage", out var pageEl)
                        && pageEl.ValueKind == JsonValueKind.Number
                        && pageEl.TryGetInt32(out var parsedPage)
                        && parsedPage >= 0)
                        animationPage = parsedPage;
                    if (optionsIsObject
                        && options.TryGetProperty("animationPageSize", out var sizeEl)
                        && sizeEl.ValueKind == JsonValueKind.Number
                        && sizeEl.TryGetInt32(out var parsedSize)
                        && parsedSize > 0)
                        animationPageSize = parsedSize;
                    else if (optionsIsObject
                        && options.TryGetProperty("pageSize", out var altSizeEl)
                        && altSizeEl.ValueKind == JsonValueKind.Number
                        && altSizeEl.TryGetInt32(out var altParsedSize)
                        && altParsedSize > 0)
                        animationPageSize = altParsedSize;
                }
                IReadOnlyDictionary<int, TaeFieldLayout[]>? templateLayouts = null;
                if (optionsIsObject
                    && options.TryGetProperty("templateLayouts", out var layoutsEl)
                    && layoutsEl.ValueKind == JsonValueKind.Object)
                {
                    var dict = new Dictionary<int, TaeFieldLayout[]>();
                    foreach (var prop in layoutsEl.EnumerateObject())
                    {
                        if (!int.TryParse(prop.Name, out var typeId)) continue;
                        if (prop.Value.ValueKind != JsonValueKind.Array) continue;
                        var list = new List<TaeFieldLayout>();
                        foreach (var fieldEl in prop.Value.EnumerateArray())
                        {
                            if (fieldEl.ValueKind != JsonValueKind.Object) continue;
                            if (!fieldEl.TryGetProperty("name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String) continue;
                            if (!fieldEl.TryGetProperty("kind", out var kindEl) || kindEl.ValueKind != JsonValueKind.String) continue;
                            if (!fieldEl.TryGetProperty("slotSize", out var slotEl) || slotEl.ValueKind != JsonValueKind.Number) continue;
                            var name = nameEl.GetString();
                            var kind = kindEl.GetString();
                            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(kind)) continue;
                            if (!slotEl.TryGetInt32(out var slotSize)) continue;
                            list.Add(new TaeFieldLayout(name, kind, slotSize));
                        }
                        if (list.Count > 0) dict[typeId] = list.ToArray();
                    }
                    if (dict.Count > 0) templateLayouts = dict;
                }
                return BridgeResult<object>.Partial(file, "action", diagnostics, document.ToEnvelope(roundTrip, extractionDiagnostics, templateLayouts, animationPage, animationPageSize));
            }
            catch (TaeEntryMissingException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_ANIBND_NO_TAE_ENTRY", "anibnd 容器内未找到 TAE 魔数条目。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-tae-event-params")
        {
            try
            {
                // S17：按需读取单个事件参数体。paramSize 由 main 从本机
                // TAE.Template.SDT.xml 的布局算出（无模板的事件传 0 → 只给前 16 字节
                // hex 作「未解码」证据）；Bridge 按长度截取并越界失败关闭。
                var (document, _) = OpenTaeDocument(file, oodleRuntimeRoot);
                var animId = OptionInt64("animId", -1);
                var eventIndex = OptionInt("eventIndex", -1);
                var paramSize = OptionInt("paramSize", 0);
                var ev = document.FindEvent(animId, eventIndex);
                if (ev is null)
                    throw new InvalidDataException($"TAE 动画 {animId} 事件下标 {eventIndex} 不存在。");
                var length = paramSize > 0 ? paramSize : Math.Min(16, (int)Math.Max(0, ev.ParameterDataOffset));
                var raw = document.ReadParameterBody(ev, length);
                return BridgeResult<object>.Partial(file, "action", new[]
                {
                    new Diagnostic(
                        "info",
                        "TAE_EVENT_PARAMS_READ",
                        $"TAE 事件参数体已读取：animId={animId} eventIndex={eventIndex} type={ev.EventTypeId} bytes={raw.Length}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    animId,
                    eventIndex,
                    eventTypeId = ev.EventTypeId,
                    paramDataOffset = ev.ParameterDataOffset,
                    paramHex = Convert.ToHexString(raw).ToLowerInvariant(),
                    paramSize = raw.Length
                });
            }
            catch (TaeEntryMissingException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_ANIBND_NO_TAE_ENTRY", "anibnd 容器内未找到 TAE 魔数条目。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_EVENT_PARAMS_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-tae-animation-clip")
        {
            try
            {
                var animId = OptionInt64("animId", 0);
                string[]? flverBoneNames = null;
                if (optionsIsObject && options.TryGetProperty("flverBoneNames", out var boneNamesEl) && boneNamesEl.ValueKind == JsonValueKind.Array)
                {
                    flverBoneNames = boneNamesEl.EnumerateArray()
                        .Where(e => e.ValueKind == JsonValueKind.String)
                        .Select(e => e.GetString()!)
                        .ToArray();
                }

                var animationContainerPath = OptionPath("animationContainerPath", file);
                var skeletonContainerPath = OptionPath("skeletonContainerPath", file);
                var includeRawSplinePayload = OptionBool("includeRawSplinePayload", false);
                var (skeleton, animation, binding, motionAnimId, sourceContainer) =
                    ResolveTaeAnimationContext(file, animId, oodleRuntimeRoot, animationContainerPath, skeletonContainerPath);

                var (trackToHkxBone, _) = ActionAnimationSemantics.ValidateTrackBinding(
                    binding.TransformTrackToBoneIndices,
                    animation.NumberOfTransformTracks,
                    skeleton.Bones.Count);
                _ = new HkxContinuousSampler(skeleton, animation, binding);

                var hkxBoneNames = skeleton.Bones.Select(b => b.Name).ToArray();
                int[]? hkxToFlverMap = null;
                if (flverBoneNames != null && flverBoneNames.Length > 0)
                {
                    hkxToFlverMap = ActionAnimationSemantics.BuildHkxToFlverBoneMap(hkxBoneNames, flverBoneNames);
                }

                int frameCount = animation is HkxSplineCompressedAnimation sc ? sc.NumFrames : (animation is HkxInterleavedAnimation ia ? ia.NumFrames : 0);
                float frameDuration = animation is HkxSplineCompressedAnimation scf ? scf.FrameDuration : (animation is HkxInterleavedAnimation iaf ? iaf.FrameDuration : (1f / 30f));

                var hkxRefTransforms = skeleton.Transforms.Select(t => new
                {
                    translation = new[] { t.Translation.X, t.Translation.Y, t.Translation.Z },
                    rotation = new[] { t.Rotation.X, t.Rotation.Y, t.Rotation.Z, t.Rotation.W },
                    scale = new[] { t.Scale.X, t.Scale.Y, t.Scale.Z }
                }).ToArray();

                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        "info",
                        "TAE_ANIMATION_CLIP_READ",
                        $"TAE 动画 clip 已成功读取：animId={animId} (motionAnimId={motionAnimId}) tracks={animation.NumberOfTransformTracks} bones={skeleton.Bones.Count} duration={animation.Duration:F2}s。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { animId, motionAnimId, sourceContainer, duration = animation.Duration, frameCount, frameDuration }),
                    new Diagnostic(
                        "warning",
                        "ACTION_ROOT_MOTION_UNSUPPORTED",
                        "当前 clip 只返回 local skeletal pose；未实现 hkaDefaultAnimatedReferenceFrame/root motion 提取。",
                        BridgeResult<object>.MakeSourceUri(file))
                };

                object? splineBlocksData = null;
                object? interleavedTransformsData = null;
                string? splineRawPayloadBase64 = null;
                int? splineMaskAndQuantizationSize = null;
                int? splineNumBlocks = null;
                uint[]? splineBlockOffsets = null;
                uint[]? splineFloatBlockOffsets = null;
                uint[]? splineTransformOffsets = null;
                uint[]? splineFloatOffsets = null;
                float? splineBlockDuration = null;
                float? splineBlockInverseDuration = null;
                int maxFramesPerBlock = 0;

                if (animation is HkxSplineCompressedAnimation scAnim && scAnim.Blocks != null)
                {
                    maxFramesPerBlock = scAnim.MaxFramesPerBlock;
                    splineBlockDuration = scAnim.BlockDuration;
                    splineBlockInverseDuration = scAnim.BlockInverseDuration;
                    if (includeRawSplinePayload)
                    {
                        splineRawPayloadBase64 = Convert.ToBase64String(scAnim.Data);
                        splineMaskAndQuantizationSize = scAnim.MaskAndQuantizationSize;
                        splineNumBlocks = scAnim.NumBlocks;
                        splineBlockOffsets = scAnim.BlockOffsets;
                        splineFloatBlockOffsets = scAnim.FloatBlockOffsets;
                        splineTransformOffsets = scAnim.TransformOffsets;
                        splineFloatOffsets = scAnim.FloatOffsets;
                    }
                    splineBlocksData = scAnim.Blocks.Select(b => new
                    {
                        tracks = b.Tracks.Select(t => new
                        {
                            staticPosition = new[] { t.StaticPosition.X, t.StaticPosition.Y, t.StaticPosition.Z },
                            staticRotation = new[] { t.StaticRotation.X, t.StaticRotation.Y, t.StaticRotation.Z, t.StaticRotation.W },
                            staticScale = new[] { t.StaticScale.X, t.StaticScale.Y, t.StaticScale.Z },
                            positionMask = t.PositionMask,
                            positionStaticMask = t.PositionStaticMask,
                            positionSplineMask = t.PositionSplineMask,
                            rotationMask = t.RotationMask,
                            rotationHasStatic = t.RotationHasStatic,
                            rotationHasSpline = t.RotationHasSpline,
                            scaleMask = t.ScaleMask,
                            scaleStaticMask = t.ScaleStaticMask,
                            scaleSplineMask = t.ScaleSplineMask,
                            positionQuantizationType = t.PositionQuantizationType,
                            rotationQuantizationType = t.RotationQuantizationType,
                            scaleQuantizationType = t.ScaleQuantizationType,
                            positionX = t.PositionX == null ? null : new { degree = t.PositionX.Degree, knots = t.PositionX.Knots, controlPoints = t.PositionX.ControlPoints },
                            positionY = t.PositionY == null ? null : new { degree = t.PositionY.Degree, knots = t.PositionY.Knots, controlPoints = t.PositionY.ControlPoints },
                            positionZ = t.PositionZ == null ? null : new { degree = t.PositionZ.Degree, knots = t.PositionZ.Knots, controlPoints = t.PositionZ.ControlPoints },
                            rotation = t.Rotation == null ? null : new { degree = t.Rotation.Degree, knots = t.Rotation.Knots, controlPoints = t.Rotation.ControlPoints.Select(q => new[] { q.X, q.Y, q.Z, q.W }).ToArray() },
                            scaleX = t.ScaleX == null ? null : new { degree = t.ScaleX.Degree, knots = t.ScaleX.Knots, controlPoints = t.ScaleX.ControlPoints },
                            scaleY = t.ScaleY == null ? null : new { degree = t.ScaleY.Degree, knots = t.ScaleY.Knots, controlPoints = t.ScaleY.ControlPoints },
                            scaleZ = t.ScaleZ == null ? null : new { degree = t.ScaleZ.Degree, knots = t.ScaleZ.Knots, controlPoints = t.ScaleZ.ControlPoints }
                        }).ToArray()
                    }).ToArray();
                }
                else if (animation is HkxInterleavedAnimation iaAnim && iaAnim.Transforms != null)
                {
                    interleavedTransformsData = iaAnim.Transforms.Select(t => new
                    {
                        translation = new[] { t.Translation.X, t.Translation.Y, t.Translation.Z },
                        rotation = new[] { t.Rotation.X, t.Rotation.Y, t.Rotation.Z, t.Rotation.W },
                        scale = new[] { t.Scale.X, t.Scale.Y, t.Scale.Z }
                    }).ToArray();
                }

                return BridgeResult<object>.Partial(file, "action", diagnostics.ToArray(), new
                {
                    animId,
                    motionAnimId,
                    sourceContainer = Path.GetFileName(sourceContainer),
                    animationType = animation.AnimationType.ToString(),
                    duration = animation.Duration,
                    frameCount,
                    frameDuration,
                    transformTrackCount = animation.NumberOfTransformTracks,
                    hkxBoneCount = skeleton.Bones.Count,
                    hkxBoneNames,
                    hkxParentIndices = skeleton.ParentIndices.Select(index => (int)index).ToArray(),
                    hkxReferencePose = hkxRefTransforms,
                    trackToHkxBone,
                    hkxToFlverBoneMap = hkxToFlverMap,
                    sourceHash = HashHex(File.ReadAllBytes(file)),
                    animationContainerHash = HashHex(File.ReadAllBytes(sourceContainer)),
                    binding = new
                    {
                        originalSkeletonName = binding.OriginalSkeletonName,
                        transformTrackToBoneIndices = trackToHkxBone
                    },
                    skeleton = new
                    {
                        name = skeleton.Name
                    },
                    splineBlocks = splineBlocksData,
                    interleavedTransforms = interleavedTransformsData,
                    maxFramesPerBlock,
                    blockDuration = splineBlockDuration,
                    blockInverseDuration = splineBlockInverseDuration,
                    splineRawPayloadBase64,
                    splineMaskAndQuantizationSize,
                    splineNumBlocks,
                    splineBlockOffsets,
                    splineFloatBlockOffsets,
                    splineTransformOffsets,
                    splineFloatOffsets,
                    rootMotionSupported = false
                });
            }
            catch (TaeEntryMissingException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_ANIBND_NO_TAE_ENTRY", "anibnd 容器内未找到 TAE 魔数条目。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "action", ActionFailureCode(ex, "TAE_ANIMATION_CLIP_READ_FAILED"), ex.Message);
            }
        }

        if (command == "sample-tae-animation-pose")
        {
            try
            {
                var animId = OptionInt64("animId", 0);
                float timeSeconds = 0f;
                if (optionsIsObject && options.TryGetProperty("timeSeconds", out var timeEl) && timeEl.ValueKind == JsonValueKind.Number)
                {
                    timeSeconds = (float)timeEl.GetDouble();
                }
                bool loop = OptionBool("loop", true);

                string[]? flverBoneNames = null;
                if (optionsIsObject && options.TryGetProperty("flverBoneNames", out var boneNamesEl) && boneNamesEl.ValueKind == JsonValueKind.Array)
                {
                    flverBoneNames = boneNamesEl.EnumerateArray()
                        .Where(e => e.ValueKind == JsonValueKind.String)
                        .Select(e => e.GetString()!)
                        .ToArray();
                }

                var animationContainerPath = OptionPath("animationContainerPath", file);
                var skeletonContainerPath = OptionPath("skeletonContainerPath", file);
                var (skeleton, animation, binding, motionAnimId, sourceContainer) =
                    ResolveTaeAnimationContext(file, animId, oodleRuntimeRoot, animationContainerPath, skeletonContainerPath);

                var sampler = new HkxContinuousSampler(skeleton, animation, binding);
                var hkxPose = sampler.SampleLocalPose(timeSeconds, loop);

                var hkxBoneNames = skeleton.Bones.Select(b => b.Name).ToArray();

                if (flverBoneNames != null && flverBoneNames.Length > 0)
                {
                    var hkxToFlver = ActionAnimationSemantics.BuildHkxToFlverBoneMap(hkxBoneNames, flverBoneNames);

                    // Build FLVER default reference pose
                    var flverRefPose = new BoneTransform[flverBoneNames.Length];
                    BoneTransform[]? explicitFlverRef = null;
                    if (optionsIsObject && options.TryGetProperty("flverReferencePose", out var refPoseEl) && refPoseEl.ValueKind == JsonValueKind.Array)
                    {
                        var explicitList = new List<BoneTransform>();
                        foreach (var item in refPoseEl.EnumerateArray())
                        {
                            var pos = Vector3.Zero;
                            var rot = Quaternion.Identity;
                            var scale = Vector3.One;
                            if (item.TryGetProperty("translation", out var tEl) && tEl.ValueKind == JsonValueKind.Array)
                            {
                                var arr = tEl.EnumerateArray().Select(v => (float)v.GetDouble()).ToArray();
                                if (arr.Length >= 3) pos = new Vector3(arr[0], arr[1], arr[2]);
                            }
                            if (item.TryGetProperty("rotation", out var rEl) && rEl.ValueKind == JsonValueKind.Array)
                            {
                                var arr = rEl.EnumerateArray().Select(v => (float)v.GetDouble()).ToArray();
                                if (arr.Length == 4) rot = new Quaternion(arr[0], arr[1], arr[2], arr[3]);
                                else if (arr.Length == 3)
                                {
                                    throw new InvalidDataException($"ACTION_FLVER_REFERENCE_POSE_ROTATION_ARITY: expected 4, got 3 at FLVER rotation {string.Join(',', arr)}.");
                                }
                            }
                            if (item.TryGetProperty("scale", out var sEl) && sEl.ValueKind == JsonValueKind.Array)
                            {
                                var arr = sEl.EnumerateArray().Select(v => (float)v.GetDouble()).ToArray();
                                if (arr.Length >= 3) scale = new Vector3(arr[0], arr[1], arr[2]);
                            }
                            explicitList.Add(new BoneTransform(pos, rot, scale));
                        }
                        explicitFlverRef = explicitList.ToArray();
                    }

                    if (explicitFlverRef != null && explicitFlverRef.Length != flverBoneNames.Length)
                        throw new InvalidDataException($"ACTION_FLVER_REFERENCE_POSE_MISMATCH: FLVER bones={flverBoneNames.Length}, referencePose={explicitFlverRef.Length}。");

                    var flverToHkx = new Dictionary<int, int>();
                    for (var hkxIndex = 0; hkxIndex < hkxToFlver.Length; hkxIndex++)
                    {
                        var flverIndex = hkxToFlver[hkxIndex];
                        if (flverIndex < 0) continue;
                        if (!flverToHkx.TryAdd(flverIndex, hkxIndex))
                            throw new InvalidDataException($"ACTION_FLVER_BONE_MAP_AMBIGUOUS: FLVER bone index {flverIndex} has multiple HKX name matches.");
                    }

                    for (int fi = 0; fi < flverBoneNames.Length; fi++)
                    {
                        if (explicitFlverRef != null)
                        {
                            flverRefPose[fi] = explicitFlverRef[fi];
                        }
                        else
                        {
                            if (flverToHkx.TryGetValue(fi, out var hkxIdx) && hkxIdx < skeleton.Transforms.Count)
                            {
                                flverRefPose[fi] = skeleton.Transforms[hkxIdx];
                            }
                            else
                            {
                                throw new InvalidDataException($"ACTION_FLVER_REFERENCE_POSE_REQUIRED: FLVER bone '{flverBoneNames[fi]}' is not present in HKX skeleton and no real FLVER reference pose was supplied.");
                            }
                        }
                    }

                    var flverPose = ActionAnimationSemantics.RemapPoseToFlver(hkxPose, hkxToFlver, flverRefPose);

                    var flverOutput = flverPose.Select(p => new
                    {
                        translation = new[] { p.Translation.X, p.Translation.Y, p.Translation.Z },
                        rotation = new[] { p.Rotation.X, p.Rotation.Y, p.Rotation.Z, p.Rotation.W },
                        scale = new[] { p.Scale.X, p.Scale.Y, p.Scale.Z }
                    }).ToArray();

                    return BridgeResult<object>.Partial(file, "action", new[]
                    {
                        new Diagnostic(
                            "info",
                            "TAE_ANIMATION_POSE_SAMPLED",
                            $"TAE 动画位姿已采样（FLVER 空间）：animId={animId} t={timeSeconds:F3}s bones={flverOutput.Length}。",
                            BridgeResult<object>.MakeSourceUri(file)),
                        new Diagnostic(
                            "warning",
                            "ACTION_ROOT_MOTION_UNSUPPORTED",
                            "当前 pose 只包含 local skeletal pose；root motion 未提取，调用方不得将其当作完整世界位移。",
                            BridgeResult<object>.MakeSourceUri(file))
                    }, new
                    {
                        animId,
                        motionAnimId,
                        timeSeconds,
                        duration = animation.Duration,
                        boneCount = flverOutput.Length,
                        sampledPose = flverOutput,
                        rootMotionSupported = false
                    });
                }
                else
                {
                    var hkxOutput = hkxPose.Select(p => new
                    {
                        translation = new[] { p.Translation.X, p.Translation.Y, p.Translation.Z },
                        rotation = new[] { p.Rotation.X, p.Rotation.Y, p.Rotation.Z, p.Rotation.W },
                        scale = new[] { p.Scale.X, p.Scale.Y, p.Scale.Z }
                    }).ToArray();

                    return BridgeResult<object>.Partial(file, "action", new[]
                    {
                        new Diagnostic(
                            "info",
                            "TAE_ANIMATION_POSE_SAMPLED",
                            $"TAE 动画位姿已采样（HKX 空间）：animId={animId} t={timeSeconds:F3}s bones={hkxOutput.Length}。",
                            BridgeResult<object>.MakeSourceUri(file)),
                        new Diagnostic(
                            "warning",
                            "ACTION_ROOT_MOTION_UNSUPPORTED",
                            "当前 pose 只包含 local skeletal pose；root motion 未提取，调用方不得将其当作完整世界位移。",
                            BridgeResult<object>.MakeSourceUri(file))
                    }, new
                    {
                        animId,
                        motionAnimId,
                        timeSeconds,
                        duration = animation.Duration,
                        boneCount = hkxOutput.Length,
                        sampledPose = hkxOutput,
                        rootMotionSupported = false
                    });
                }
            }
            catch (TaeEntryMissingException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_ANIBND_NO_TAE_ENTRY", "anibnd 容器内未找到 TAE 魔数条目。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "action", ActionFailureCode(ex, "TAE_ANIMATION_POSE_SAMPLE_FAILED"), ex.Message);
            }
        }

        if (command == "read-chrbnd-flver-preview")
        {
            try
            {
                // Character/parts containers are atomic preview resources. A partsbnd may
                // contain several FLVER entries, each with an independent bone namespace;
                // enumerate and parse each entry once rather than restarting the Bridge per mesh.
                var maxVertices = OptionInt("maxVertices", 1_000_000);
                var maxIndices = OptionInt("maxIndices", 3_000_000);
                var leaves = NativeLeafPayload.ResolveAll(file, oodleRuntimeRoot, ".flver");
                var models = new List<object>(leaves.Count);
                var totalMeshes = 0;
                long totalVertices = 0;
                var leaderBoneCount = -1;
                var leaderModelId = string.Empty;
                foreach (var leaf in leaves)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var flver = FlverNativeDocument.Read(leaf.Payload);
                    var meshes = BuildFlverMeshBundle(flver, maxVertices, maxIndices, cancellationToken);
                    var modelId = $"entry:{leaf.Index}:{leaf.Id}:{leaf.DuplicateOrdinal}:{leaf.ContentHash[..Math.Min(16, leaf.ContentHash.Length)]}";
                    if (flver.BoneCount > leaderBoneCount)
                    {
                        leaderBoneCount = flver.BoneCount;
                        leaderModelId = modelId;
                    }
                    totalMeshes += flver.MeshCount;
                    totalVertices += flver.Meshes.Sum(mesh => (long)mesh.VertexCount);
                    models.Add(new
                    {
                        modelId,
                        entry = new
                        {
                            index = leaf.Index,
                            id = leaf.Id,
                            name = leaf.Name,
                            duplicateOrdinal = leaf.DuplicateOrdinal,
                            contentHash = leaf.ContentHash
                        },
                        meshCount = flver.MeshCount,
                        boneCount = flver.BoneCount,
                        meshes,
                        bones = BuildFlverSkeleton(flver)
                    });
                }
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "CHRBND_FLVER_PREVIEW_BUNDLE_EXTRACTED",
                        $"容器内 FLVER 已一次解包并完整提取；entries={models.Count} meshes={totalMeshes} vertices={totalVertices}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    meshCount = totalMeshes,
                    vertexCount = totalVertices,
                    boneCount = Math.Max(0, leaderBoneCount),
                    leaderModelId,
                    models
                });
            }
            catch (OodleRuntimeUnavailableException)
            {
                return BridgeResult<object>.Failed(
                    file,
                    "chr",
                    "CHRBND_KRAK_OODLE_UNAVAILABLE",
                    "这份模型（chrbnd）是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再看预览。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "CHRBND_FLVER_PREVIEW_FAILED", ex.Message);
            }
        }

        if (command == "read-map-part-flver-preview")
        {
            try
            {
                // S23：地图 viewport 读 part 模型——mapbnd（DCX→BND4）内按条目名
                // 精确匹配 <modelName>（如 m10_00_00_00_A10_00_00.flver），取 FLVER
                // 网格/骨骼一次返回。与 chrbnd 预览同一套提取逻辑，只是匹配规则
                // 换成「条目名以 modelName 开头且是 .flver」。
                var modelName = OptionString("modelName", "");
                if (string.IsNullOrWhiteSpace(modelName))
                {
                    return BridgeResult<object>.Failed(file, "map", "MAPBND_MODEL_NAME_MISSING", "需要 modelName 才能定位 mapbnd 内的 FLVER 条目。");
                }
                var sourceBytes = File.ReadAllBytes(file);
                var payload = sourceBytes;
                if (payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
                {
                    payload = DcxNativeDocument.Read(file, oodleRuntimeRoot).Payload;
                }
                if (payload.Length < 4 || !payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
                {
                    return BridgeResult<object>.Failed(file, "map", "MAPBND_BND4_EXPECTED", "mapbnd 解 DCX 后必须是 BND4 容器。");
                }
                var binder = Bnd4NativeDocument.Read(payload);
                // modelName 可能含 Windows 路径，条目名是完整 N:\... 路径；应按后缀匹配而非开头。
                // 追加：m000010 这类 MSB 短名（m + 6位）与 mapbnd 长名 m10_00_00_00_000010
                // 的映射。条目如 .../m10_00_00_00_000010/m10_00_00_00_000010.flver，其
                // 尾段的 000010 恰是短名去前缀 m 后的 suffix。优先用包含匹配兜住短名。
                var variants = new List<string> { modelName };
                var baseName = System.IO.Path.GetFileName(modelName.Replace('\\', '/'));
                if (!string.Equals(baseName, modelName, StringComparison.Ordinal))
                    variants.Add(baseName);
                var shortMatch = System.Text.RegularExpressions.Regex.Match(
                    baseName, @"^m(\d{6})$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (shortMatch.Success)
                {
                    var suffix = shortMatch.Groups[1].Value;
                    variants.Add(suffix);
                    variants.Add(suffix + ".flver");
                }
                Bnd4Entry? entry = null;
                foreach (var variant in variants)
                {
                    entry = binder.Entries.FirstOrDefault(item =>
                        item.Name.EndsWith(variant, StringComparison.OrdinalIgnoreCase)
                        || item.Name.EndsWith(variant + ".flver", StringComparison.OrdinalIgnoreCase));
                    if (entry is not null) break;
                }
                if (entry is null)
                {
                    foreach (var variant in variants)
                    {
                        entry = binder.Entries.FirstOrDefault(item =>
                            item.Name.IndexOf(variant, StringComparison.OrdinalIgnoreCase) >= 0
                            && item.Name.EndsWith(".flver", StringComparison.OrdinalIgnoreCase));
                        if (entry is not null) break;
                    }
                }
                if (entry is null)
                {
                    return BridgeResult<object>.Failed(
                        file,
                        "map",
                        "MAPBND_MODEL_NOT_FOUND",
                        $"mapbnd 里没有找到 {modelName} 的模型（.flver 条目）；该 part 用线框占位显示。");
                }
                var entryBytes = binder.GetStoredBytes(entry.Index);
                var flver = FlverNativeDocument.Read(entryBytes);
                var meshIndex = OptionInt("meshIndex", 0);
                var maxVertices = OptionInt("maxVertices", 10_000);
                var maxIndices = OptionInt("maxIndices", 30_000);
                var includeAllMeshes = OptionBool("includeAllMeshes", false);
                if (includeAllMeshes)
                {
                    var meshes = BuildFlverMeshBundle(flver, maxVertices, maxIndices, cancellationToken);
                    return BridgeResult<object>.Partial(file, "map", new[]
                    {
                        new Diagnostic("info", "MAP_PART_FLVER_BUNDLE_EXTRACTED",
                            $"mapbnd 条目 {entry.Name} 的 FLVER 已一次解析并提取全部网格；meshes={meshes.Length} bones={flver.BoneCount}。",
                            BridgeResult<object>.MakeSourceUri(file))
                    }, new
                    {
                        entryName = entry.Name,
                        meshCount = flver.MeshCount,
                        boneCount = flver.BoneCount,
                        meshes,
                        bones = BuildFlverSkeleton(flver)
                    });
                }
                var positions = flver.GetMeshPositionsBase64(meshIndex, maxVertices);
                if (positions == null)
                {
                    return BridgeResult<object>.Failed(file, "map", "FLVER_MESH_NOT_FOUND", $"网格索引 {meshIndex} 超出范围或数据不可用。");
                }
                var indices = flver.GetMeshIndicesBase64(meshIndex, maxIndices);
                var uvs = flver.GetMeshUVsBase64(meshIndex, maxVertices);
                var normals = flver.GetMeshNormalsBase64(meshIndex, maxVertices);
                var boneWeights = flver.GetMeshBoneWeightsBase64(meshIndex, maxVertices);
                var boneIndices = flver.GetMeshBoneIndicesBase64(meshIndex, maxVertices);
                var mesh = flver.Meshes[meshIndex];
                return BridgeResult<object>.Partial(file, "map", new[]
                {
                    new Diagnostic("info", "MAP_PART_FLVER_EXTRACTED",
                        $"mapbnd 条目 {entry.Name} 的 FLVER 网格已提取；mesh={meshIndex} vertexCount={mesh.VertexCount} bones={flver.BoneCount}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    entryName = entry.Name,
                    meshIndex,
                    vertexCount = mesh.VertexCount,
                    indexSize = flver.GetMeshIndexSize(meshIndex),
                    positionsBase64 = positions,
                    indicesBase64 = indices,
                    uvsBase64 = uvs,
                    normalsBase64 = normals,
                    boneWeightsBase64 = boneWeights,
                    boneIndicesBase64 = boneIndices,
                    bones = BuildFlverSkeleton(flver),
                    boneCount = flver.BoneCount,
                    meshCount = flver.MeshCount
                });
            }
            catch (OodleRuntimeUnavailableException)
            {
                return BridgeResult<object>.Failed(
                    file,
                    "map",
                    "MAPBND_KRAK_OODLE_UNAVAILABLE",
                    "这份地图模型（mapbnd）是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再看模型。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MAPBND_FLVER_PREVIEW_FAILED", ex.Message);
            }
        }

        if (command == "read-map-static-geometry")
        {
            try
            {
                var modelName = OptionString("modelName", "");
                var sessionToken = OptionString("sessionToken", "");
                var cursor = OptionString("cursor", "");
                // Resolve file hash for session validation
                var fileBytesForHash = File.ReadAllBytes(file);
                var fileHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fileBytesForHash)).ToLowerInvariant();

                MapStaticGeometryService.SessionEntry? session = null;
                string? entryNameForNew = null;
                FlverNativeDocument? flverForNew = null;

                if (!string.IsNullOrWhiteSpace(sessionToken) && MapStaticGeometryService.TryGet(sessionToken, out var existing))
                {
                    // Validate cursor if provided
                    if (!string.IsNullOrWhiteSpace(cursor))
                    {
                        // nextCursor is an opaque random token bound to this exact session.
                        // The legacy Base64 "mesh:triangle" decoder cannot decode it and
                        // caused every multi-page model to fail on page two.
                        if (!MapStaticGeometryService.TryDecodeOpaqueCursor(existing!, cursor, out _, out _))
                            return BridgeResult<object>.Failed(file, "map", "MAP_STATIC_CURSOR_INVALID", "cursor 无法解析。");
                    }
                    session = existing;
                    // Ensure file hash matches session's hash (stale content)
                    if (session!.FileHash != fileHash)
                        return BridgeResult<object>.Failed(file, "map", "MAP_STATIC_SESSION_EXPIRED", "文件内容已变化，session 已过期。");
                }
                else
                {
                    if (string.IsNullOrWhiteSpace(modelName))
                        return BridgeResult<object>.Failed(file, "map", "MAPBND_MODEL_NAME_MISSING", "需要 modelName 才能定位 mapbnd 内的 FLVER 条目。");

                    // Resolve FLVER payload: BND4 container or direct FLVER
                    var sourceBytes = fileBytesForHash;
                    byte[] payload = sourceBytes;
                    bool isDcx = payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8);
                    if (isDcx)
                    {
                        payload = DcxNativeDocument.Read(file, oodleRuntimeRoot).Payload;
                    }
                    string resolvedEntryName = modelName;
                    byte[]? flverBytes = null;
                    if (payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
                    {
                        var binder = Bnd4NativeDocument.Read(payload);
                        var variants = new List<string> { modelName };
                        var baseName = System.IO.Path.GetFileName(modelName.Replace('\\', '/'));
                        if (!string.Equals(baseName, modelName, StringComparison.Ordinal)) variants.Add(baseName);
                        var shortMatch = System.Text.RegularExpressions.Regex.Match(baseName, @"^m(\d{6})$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                        if (shortMatch.Success)
                        {
                            var suffix = shortMatch.Groups[1].Value;
                            variants.Add(suffix);
                            variants.Add(suffix + ".flver");
                        }
                        Bnd4Entry? entry = null;
                        foreach (var variant in variants)
                        {
                            entry = binder.Entries.FirstOrDefault(item =>
                                item.Name.EndsWith(variant, StringComparison.OrdinalIgnoreCase)
                                || item.Name.EndsWith(variant + ".flver", StringComparison.OrdinalIgnoreCase));
                            if (entry is not null) break;
                        }
                        if (entry is null)
                        {
                            foreach (var variant in variants)
                            {
                                entry = binder.Entries.FirstOrDefault(item =>
                                    item.Name.IndexOf(variant, StringComparison.OrdinalIgnoreCase) >= 0
                                    && item.Name.EndsWith(".flver", StringComparison.OrdinalIgnoreCase));
                                if (entry is not null) break;
                            }
                        }
                        if (entry is null)
                            return BridgeResult<object>.Failed(file, "map", "MAPBND_MODEL_NOT_FOUND", $"mapbnd 里没有找到 {modelName} 的模型（.flver 条目）；该 part 用线框占位显示。");
                        flverBytes = binder.GetStoredBytes(entry.Index);
                        resolvedEntryName = entry.Name;
                    }
                    else
                    {
                        flverBytes = payload;
                    }
                    flverForNew = FlverNativeDocument.Read(flverBytes);
                    entryNameForNew = resolvedEntryName;
                    var ownerLeaseId = OptionString("ownerLeaseId", "");
                    var resourceCacheKey = OptionString("resourceCacheKey", "");
                    // Create session
                    session = MapStaticGeometryService.GetOrCreate(file, modelName, null, fileHash, flverForNew, entryNameForNew, ownerLeaseId, resourceCacheKey);
                    // If cursor was supplied with new session, validate it starts at 0
                    if (!string.IsNullOrWhiteSpace(cursor) && cursor != MapStaticGeometryService.EncodeCursor(0,0))
                        return BridgeResult<object>.Failed(file, "map", "MAP_STATIC_CURSOR_MISMATCH", "新 session 的 cursor 必须为空或指向起点。");
                }

                // Determine start position from cursor (if sessionToken provided, cursor indicates next; else start 0,0)
                int startMesh = 0, startTri = 0;
                if (!string.IsNullOrWhiteSpace(cursor))
                {
                    if (!MapStaticGeometryService.TryDecodeOpaqueCursor(session!, cursor, out startMesh, out startTri))
                        return BridgeResult<object>.Failed(file, "map", "MAP_STATIC_CURSOR_INVALID", "cursor 无法解析。");
                }
                else if (!string.IsNullOrWhiteSpace(sessionToken))
                {
                    // resume without cursor -> start at 0 (should not happen, but handle)
                    startMesh = 0; startTri = 0;
                }

                var chunkObj = MapStaticGeometryService.BuildChunk(session!, startMesh, startTri, out var nextCursor, out var complete);
                // If no chunk (empty), return complete
                if (chunkObj == null)
                {
                    return BridgeResult<object>.Partial(file, "map", new[]
                    {
                        new Diagnostic("info", "MAP_STATIC_GEOMETRY_COMPLETE", "静态几何已全部传输。", BridgeResult<object>.MakeSourceUri(file))
                    }, new
                    {
                        sessionToken = session!.Token,
                        nextCursor = (string?)null,
                        complete = true,
                        chunks = Array.Empty<object>(),
                        telemetry = new { skin = MapStaticGeometryService.SkinCalls, skeleton = MapStaticGeometryService.SkeletonCalls, parse = MapStaticGeometryService.ParseCount }
                    });
                }

                var chunks = new[] { chunkObj };
                // Validate outbound JSON size <8 MiB (estimate). If would exceed, we already limited to one chunk.
                var payloadObj = new
                {
                    sessionToken = session!.Token,
                    nextCursor,
                    complete,
                    chunks,
                    telemetry = new { skin = MapStaticGeometryService.SkinCalls, skeleton = MapStaticGeometryService.SkeletonCalls, parse = MapStaticGeometryService.ParseCount }
                };
                // Quick size check: serialize and check byte count
                var json = System.Text.Json.JsonSerializer.Serialize(payloadObj);
                if (System.Text.Encoding.UTF8.GetByteCount(json) >= 8 * 1024 * 1024)
                    return BridgeResult<object>.Failed(file, "map", "MAP_STATIC_CHUNK_TOO_LARGE", "单个静态几何响应超过 8 MiB 限制。");

                return BridgeResult<object>.Partial(file, "map", new[]
                {
                    new Diagnostic("info", "MAP_STATIC_GEOMETRY_CHUNK", $"静态几何 chunk 已生成；mesh={startMesh} triStart={startTri} complete={complete}。", BridgeResult<object>.MakeSourceUri(file))
                }, payloadObj);
            }
            catch (OodleRuntimeUnavailableException)
            {
                return BridgeResult<object>.Failed(file, "map", "MAPBND_KRAK_OODLE_UNAVAILABLE", "这份地图模型（mapbnd）是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再看模型。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MAP_STATIC_GEOMETRY_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-document")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                // 措辞与判据对齐：FLVER 无 writer，能验证的只是「同一输入两次解析
                // 得到相同结论」，不是「重建后逐字节一致」。旧码 *_ROUNDTRIP_BYTE_VERIFIED
                // 对一个只读解析器是过强表述，会被读成无损可写的证据。
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.ByteIdentical ? "info" : "error",
                        roundTrip.ByteIdentical ? "FLVER_DOCUMENT_REPARSE_DETERMINISTIC" : "FLVER_DOCUMENT_REPARSE_NONDETERMINISTIC",
                        roundTrip.ByteIdentical
                            ? $"FLVER 重解析确定（只读，无 writer；不构成无损可写声明）；materials={document.MaterialCount}, bones={document.BoneCount}, meshes={document.MeshCount}。"
                            : "FLVER 重解析结果不确定：同一输入两次解析结论不同。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "chr", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-mesh")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                // 同 PARAM：不传 commandOptions 时裸 TryGetProperty 会抛。
                var meshIndex = OptionInt("meshIndex", 0);
                var maxVertices = OptionInt("maxVertices", 10_000);
                var maxIndices = OptionInt("maxIndices", 30_000);
                var positions = document.GetMeshPositionsBase64(meshIndex, maxVertices);
                var indices = document.GetMeshIndicesBase64(meshIndex, maxIndices);
                var uvs = document.GetMeshUVsBase64(meshIndex, maxVertices);
                var normals = document.GetMeshNormalsBase64(meshIndex, maxVertices);
                var boneWeights = document.GetMeshBoneWeightsBase64(meshIndex, maxVertices);
                var boneIndices = document.GetMeshBoneIndicesBase64(meshIndex, maxVertices);
                if (positions == null)
                    return BridgeResult<object>.Failed(file, "chr", "FLVER_MESH_NOT_FOUND", $"网格索引 {meshIndex} 超出范围或数据不可用。");
                var mesh = document.Meshes[meshIndex];
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_MESH_DATA_EXTRACTED",
                        $"FLVER 网格 {meshIndex} 顶点/索引/UV/法线/骨骼权重/骨骼索引数据已提取；vertexCount={mesh.VertexCount}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    meshIndex,
                    vertexCount = mesh.VertexCount,
                    vertexStride = mesh.VertexStride,
                    bufferLayoutIndex = mesh.BufferLayoutIndex,
                    materialIndex = mesh.MaterialIndex,
                    indexFormat = mesh.IndexFormat,
                    indexSize = document.GetMeshIndexSize(meshIndex),
                    positionsBase64 = positions,
                    indicesBase64 = indices,
                    uvsBase64 = uvs,
                    normalsBase64 = normals,
                    boneWeightsBase64 = boneWeights,
                    boneIndicesBase64 = boneIndices
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_MESH_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-skeleton")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var bones = document.Bones.Select(b => new
                {
                    index = b.Index,
                    name = b.Name,
                    parentIndex = b.ParentIndex,
                    nextSiblingIndex = b.NextSiblingIndex,
                    translation = new[] { b.TranslationX, b.TranslationY, b.TranslationZ },
                    rotation = new[] { b.RotationX, b.RotationY, b.RotationZ },
                    scale = new[] { b.ScaleX, b.ScaleY, b.ScaleZ },
                    rotationOrder = "XZY"
                }).ToArray();
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_SKELETON_EXTRACTED",
                        $"FLVER 骨骼层级已提取；boneCount={document.BoneCount}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    boneCount = document.BoneCount,
                    bones
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_SKELETON_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-texture-slots")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var slots = document.GetTextureSlots();
                var textures = slots.Select(t => new
                {
                    index = t.Index,
                    type = t.Type,
                    path = t.Path,
                    materialIndex = t.MaterialIndex
                }).ToArray();
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_TEXTURE_SLOTS_EXTRACTED",
                        $"FLVER 纹理槽位已提取；textureCount={slots.Count}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    textureCount = slots.Count,
                    textures
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_TEXTURE_SLOTS_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-dummies")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var dummies = document.GetDummies();
                var entries = dummies.Select(d => new
                {
                    index = d.Index,
                    position = new[] { d.PositionX, d.PositionY, d.PositionZ },
                    referenceId = d.ReferenceId,
                    parentBoneIndex = d.ParentBoneIndex,
                    attachBoneIndex = d.AttachBoneIndex
                }).ToArray();
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_DUMMIES_EXTRACTED",
                        $"FLVER Dummy 挂点已提取；dummyCount={dummies.Count}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    dummyCount = dummies.Count,
                    dummies = entries
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_DUMMIES_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-flver")
        {
            // MODEL-51C：FLVER 材质槽写回。字节补丁 writer，outputPath 必须
            // 是已校验的暂存区路径（BRIDGE_OUTPUT_PATH_REQUIRED 之外的边界
            // 检查由 BridgeDaemonHost 的 DiskWritingCommands 门在分派前完成）。
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "chr", "BRIDGE_OUTPUT_PATH_REQUIRED", "FLVER writer requires a validated staging output path.");
            try
            {
                var written = await FlverNativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_STAGING_WRITE_VERIFIED", "FLVER 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-mtd-document")
        {
            // MATERIAL-53A：恢复 read-mtd-document。MTD 是 user-approved 的 V0.6
            // 延期项（scope.json 的 SCOPE-ASSET-MTD，authorityAtRuling=unverified），
            // 按 resumeRequires 走通用承接流程时恢复三处入口：本分支、
            // AdvertisedCommands 与两侧 TS union（test:bridge-command-advertisement
            // 会在任一处漏掉时失败关闭）。
            //
            // MtdNativeDocument 是**只读安全 XML 投影**：无 writer、无字节重建、
            // 无 schema 语义解释（infer-mtd-schema 永久禁令），authority 上限
            // candidate——发现未识别 XML 元素/属性（unparsedGaps）或重复解析
            // 不一致时降 partial。resourceKind 用 "material"。
            try
            {
                var document = MtdNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyStructure();
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        roundTrip.Consistent ? "info" : "error",
                        roundTrip.Consistent ? "MTD_DOCUMENT_ROUNDTRIP_VERIFIED" : "MTD_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.Consistent
                            ? $"MTD 只读重解析确定性通过；params={document.Params.Count}, textures={document.Textures.Count}。本项只证明同一份字节解析两遍一致，不构成解析完整性声明。"
                            : "MTD 只读往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                // 未识别结构必须单列诊断，不能只靠 authority 降级：消费方常只读
                // authority，而「哪几项没解析全」才是排查入口（硬约束 8 要求
                // partial 返回结构化诊断）。
                if (document.UnparsedGaps.Count > 0)
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "MTD_STRUCTURE_NOT_PARSED_IN_SCOPE",
                        $"MTD 未识别以下 XML 元素/属性：{string.Join("; ", document.UnparsedGaps)}。authority 已降为 partial。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { unparsedGaps = document.UnparsedGaps }));
                }
                return BridgeResult<object>.Partial(file, "material", diagnostics.ToArray(), document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "material", "MTD_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-mtd-document")
        {
            // MATERIAL-53C：MTD 材质属性写回。只收 typed property set（paramId +
            // newValue），outputPath 必须是已校验的暂存区路径（越界之外的边界检查由
            // BridgeDaemonHost 的 DiskWritingCommands 门在分派前完成）。
            //
            // 字节外科替换：目标 param 文本值之外的一切字节原样保留，未知字段无损；
            // 目标 param 文本内容区间含 XML 标记时 MtdWriteBlockedException →
            // MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE（结构化诊断，不写坏）。
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "material", "BRIDGE_OUTPUT_PATH_REQUIRED", "MTD writer requires a validated staging output path.");
            try
            {
                var written = await MtdNativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, "material", new[]
                {
                    new Diagnostic("info", "MTD_STAGING_WRITE_VERIFIED", "MTD 材质属性已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (MtdWriteBlockedException ex)
            {
                return BridgeResult<object>.Failed(file, "material", "MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE", ex.Message, ex.Details);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "material", "MTD_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-fxr-document")
        {
            // VFX-54A：FXR3 只读。FXR 是 ffxbnd.dcx 容器内子项，支持三种输入形态：
            //   ① 裸 .fxr 文件 → 直接解析；
            //   ② .dcx 容器 → DcxNativeDocument 解压，再判定 BND4 容器定位 FXR 子项；
            //   ③ ffxbnd.dcx 容器 → Bnd4NativeDocument 定位 .fxr 子项。
            // 与 read-tpf-document 同构：TS 侧不维护第二套 native parser，
            // 容器解压与子项定位全在 C# 侧完成。
            //
            // authority 上限 candidate（无 writer、Section11 无 schema、Section9/
            // Section12-14 未在真实样本验证），真实语料恒为 partial——发现未识别
            // node type（unparsedGaps）或重复解析不一致时降 partial。
            // resourceKind 用 "sfx"（VFX/effect 资源族）。
            try
            {
                var sourceBytes = File.ReadAllBytes(file);
                byte[] fxrPayload = sourceBytes;
                if (sourceBytes.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
                {
                    var dcx = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                    fxrPayload = dcx.Payload;
                }
                object[] containerEntries = Array.Empty<object>();
                int? selectedEntryIndex = null;
                string? selectedEntryName = null;
                if (fxrPayload.AsSpan(0, 4).SequenceEqual("BND4"u8))
                {
                    var binder = Bnd4NativeDocument.Read(fxrPayload);
                    var fxrEntries = binder.Entries
                        .Where(e => e.Name.EndsWith(".fxr", StringComparison.OrdinalIgnoreCase))
                        .ToArray();
                    if (fxrEntries.Length == 0)
                        throw new InvalidDataException("BND4 容器中没有 .fxr 子项。");
                    containerEntries = fxrEntries
                        .Select(e => (object)new { entryIndex = e.Index, entryName = e.Name })
                        .ToArray();
                    var wantName = OptionString("entryName", "");
                    var wantIndex = OptionInt("entryIndex", -1);
                    Bnd4Entry? selected = null;
                    if (!string.IsNullOrEmpty(wantName))
                    {
                        selected = fxrEntries.FirstOrDefault(e =>
                            string.Equals(BinderEntryBasename(e.Name), BinderEntryBasename(wantName), StringComparison.OrdinalIgnoreCase)
                            || e.Name.EndsWith(wantName, StringComparison.OrdinalIgnoreCase));
                    }
                    else if (wantIndex >= 0)
                    {
                        selected = fxrEntries.FirstOrDefault(e => e.Index == wantIndex);
                    }
                    selected ??= fxrEntries[0];
                    selectedEntryIndex = selected.Index;
                    selectedEntryName = selected.Name;
                    try
                    {
                        fxrPayload = binder.GetStoredBytes(selected.Index);
                    }
                    catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
                    {
                        return BridgeResult<object>.Failed(
                            file, "sfx", "FXR_DOCUMENT_READ_FAILED",
                            ex.Message,
                            new { containerEntries, selectedEntryIndex, selectedEntryName });
                    }
                }
                try
                {
                    var document = FxrNativeDocument.Read(fxrPayload);
                    var roundTrip = document.VerifyRoundTrip();
                    var diagnostics = new List<Diagnostic>
                    {
                        new Diagnostic(
                            roundTrip.Consistent ? "info" : "error",
                            roundTrip.Consistent ? "FXR_DOCUMENT_ROUNDTRIP_VERIFIED" : "FXR_DOCUMENT_ROUNDTRIP_FAILED",
                            roundTrip.Consistent
                                ? $"FXR3 只读重解析确定性通过；rootNodes={document.RootNodeCount}, nodes={document.TotalSection4NodeCount}, hosts={document.Hosts.Count}, properties={document.Section7Total}。本项只证明同一份字节解析两遍一致，不构成解析完整性声明。"
                                : "FXR3 只读往返语义不一致。",
                            BridgeResult<object>.MakeSourceUri(file),
                            roundTrip)
                    };
                    // 能力边界必须单列诊断，不能只靠 authority 降级：消费方常只读
                    // authority，而「哪几项没解析全」才是排查入口（硬约束 8）。
                    var fxrUnparsedGaps = document.UnparsedGaps();
                    if (fxrUnparsedGaps.Length > 0)
                    {
                        diagnostics.Add(new Diagnostic(
                            "warning",
                            "FXR_STRUCTURE_NOT_PARSED_IN_SCOPE",
                            $"FXR3 刻意不解析以下区间：{string.Join("; ", fxrUnparsedGaps)}。"
                            + "Section11 无 schema 按不透明 int 数组上报；Section9/Section12-14"
                            + "未在真实样本验证。authority 已降为 partial。",
                            BridgeResult<object>.MakeSourceUri(file),
                            new { unparsedGaps = fxrUnparsedGaps }));
                    }
                    return BridgeResult<object>.Partial(
                        file, "sfx", diagnostics.ToArray(),
                        document.ToEnvelope(roundTrip, containerEntries, selectedEntryIndex, selectedEntryName));
                }
                catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
                {
                    // 一条子项解析失败不得抹掉同包兄弟列表。
                    return BridgeResult<object>.Failed(
                        file, "sfx", "FXR_DOCUMENT_READ_FAILED",
                        ex.Message,
                        new { containerEntries, selectedEntryIndex, selectedEntryName });
                }
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "sfx", "FXR_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "list-ffxbnd-entries")
        {
            // S24：ffxbnd 效果库的 .fxr 子项清单（逻辑名，UI 左栏逐条列出）。
            // 只列条目名，不解析任何 effect——一条失败不应把整包判死。
            try
            {
                var sourceBytes = File.ReadAllBytes(file);
                var payload = sourceBytes;
                if (payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
                {
                    payload = DcxNativeDocument.Read(file, oodleRuntimeRoot).Payload;
                }
                if (payload.Length < 4 || !payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
                {
                    return BridgeResult<object>.Failed(file, "sfx", "FFXBND_BND4_EXPECTED", "输入不是 ffxbnd 容器（解 DCX 后必须是 BND4）。");
                }
                var binder = Bnd4NativeDocument.Read(payload);
                var entries = binder.Entries
                    .Where(e => e.Name.EndsWith(".fxr", StringComparison.OrdinalIgnoreCase))
                    .Select(e => e.Name)
                    .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                return BridgeResult<object>.Ok(file, "sfx", new { entries });
            }
            catch (OodleRuntimeUnavailableException)
            {
                return BridgeResult<object>.Failed(
                    file,
                    "sfx",
                    "FFXBND_KRAK_OODLE_UNAVAILABLE",
                    "这份效果库（ffxbnd）是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再列条目。");
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "sfx", "FFXBND_LIST_FAILED", ex.Message);
            }
        }

        if (command == "read-esd-document")
        {
            try
            {
                var payload = NativeLeafPayload.Resolve(file, oodleRuntimeRoot, ".esd");
                var document = EsdNativeDocument.Read(payload);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "ESD_DOCUMENT_ROUNDTRIP_VERIFIED" : "ESD_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"ESD 只读重解析确定性通过；stateGroups={document.StateGroups.Count}, states={document.ParsedStateCount}, conditions={document.ParsedConditionCount}。本项只证明同一份字节解析两遍一致，不构成解析完整性声明。"
                            : "ESD 只读往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                // 覆盖率残缺必须单列诊断，不能只靠 authority 降级：消费方常只读
                // authority，而「哪几项没解析全」才是排查入口（硬约束 8 要求
                // partial 返回结构化诊断）。
                if (!document.CoverageComplete)
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "ESD_DECLARED_PARSED_DIVERGED",
                        $"ESD 声明量与实解析量不一致：{string.Join("; ", document.CoverageShortfalls())}。authority 已降为 partial。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { coverageShortfalls = document.CoverageShortfalls() }));
                }
                // 本版刻意未解析的字段区间**单列诊断码**，不并进上面那条。
                // 两者都会压 authority，但处置方向相反：DIVERGED 指向「去查 parser
                // 为什么少读了」，而这一条指向「本版范围如此，要做得先走 V0.6 承接」。
                // 混成一条会让下一个人去修一个不存在的 bug（ESD 哨兵那次就是这么
                // 被误判的），也会让真实的解析缺口被结构性缺口的噪音盖住。
                var esdUnparsedGaps = document.UnparsedGaps();
                if (esdUnparsedGaps.Length > 0)
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "ESD_STRUCTURE_NOT_PARSED_IN_SCOPE",
                        $"ESD 刻意不解码以下区间：{string.Join("; ", esdUnparsedGaps)}。"
                        + "RPN 字节码按不透明 (offset,length) 上报——scope.json 的 "
                        + "SCOPE-BEHAVIOR-ESD 把「未知表达式或命令不得重编码」列为永久禁令，"
                        + "不解码是刻意的，不是解析缺陷；但 authority 因此不得停留在 candidate，"
                        + "已降为 partial。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { unparsedGaps = esdUnparsedGaps }));
                }
                // 跳转图不闭合必须单列：悬空目标意味着写入会破坏状态机可达性
                // （scope.json 的 resumeRequires 明写这一条）。与「刻意不解码」分开，
                // 因为处置完全不同——那个是范围，这个是数据有问题。
                if (!document.TransitionGraphClosed)
                {
                    diagnostics.Add(new Diagnostic(
                        "error",
                        "ESD_TRANSITION_GRAPH_NOT_CLOSED",
                        $"ESD 跳转图不闭合：悬空目标 {document.DanglingEdges.Count} 条、"
                        + $"指向尾随哨兵槽 {document.SentinelTargetEdges.Count} 条。"
                        + "悬空目标指向的偏移不落在任何语义 state 记录起点上；"
                        + "指向哨兵说明哨兵被当成可跳转状态。两者都会让状态机的可达性判断失效，"
                        + "写入前必须先解决（真实语料实测 192/192 文件闭合，出现此诊断说明遇到了"
                        + "未登记形态）。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new
                        {
                            dangling = document.DanglingEdges.Count,
                            sentinelTargets = document.SentinelTargetEdges.Count
                        }));
                }
                return BridgeResult<object>.Partial(file, "script", diagnostics.ToArray(), document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "script", "ESD_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-esd-document")
        {
            // BEHAVIOR-55C：ESD 状态转移写回（behavior-transition-upsert）。
            // 只收 typed transition mutation：set-transition-target（字节级外科替换
            // 条件记录的 targetStateOffset）/ insert-transition（entry 表内新增
            // 裸跳转条件）/ set-command-arg（命令参数体是 RPN 字节码，永久不解码
            // gap → ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE，fail-closed）。
            // outputPath 必须是已校验的暂存区路径（越界之外的边界检查由
            // BridgeDaemonHost 的 DiskWritingCommands 门在分派前完成）。
            // writer 只接受 loose .esd；talkesdbnd.dcx 容器外层重建由
            // Patch Engine 在 main 侧完成，本层不重复实现容器逻辑。
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "script", "BRIDGE_OUTPUT_PATH_REQUIRED", "ESD writer requires a validated staging output path.");
            try
            {
                var written = await EsdNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "script", new[]
                {
                    new Diagnostic("info", "ESD_STAGING_WRITE_VERIFIED", "ESD 状态转移已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (EsdWriteBlockedException ex)
            {
                return BridgeResult<object>.Failed(file, "script", "ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE", ex.Message, ex.Details);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "script", "ESD_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "write-tae-document")
        {
            // ANIMATION-56C：TAE 事件写回（tae-event-upsert）。
            // 只收 typed event upsert mutation：update-event-times（字节级外科替换
            // 事件 startTime/endTime，时间槽被兄弟共享时 fail-closed）/ insert-event
            // （事件参数体按模板逐字节拷贝后追加新事件，布局不连续时
            // TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE，fail-closed）。
            // outputPath 必须是已校验的暂存区路径（越界之外的边界检查由
            // BridgeDaemonHost 的 DiskWritingCommands 门在分派前完成）。
            // writer 只接受 loose .tae；anibnd.dcx 容器外层重建由
            // Patch Engine 在 main 侧完成，本层不重复实现容器逻辑。
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "action", "BRIDGE_OUTPUT_PATH_REQUIRED", "TAE writer requires a validated staging output path.");
            try
            {
                var written = await TaeNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "action", new[]
                {
                    new Diagnostic("info", "TAE_STAGING_WRITE_VERIFIED", "TAE 事件写回已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (TaeWriteBlockedException ex)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE", ex.Message, ex.Details);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "write-fxr-document")
        {
            // VFX-54C：FXR3 字段写回（vfx-field-set）。
            // 只收 typed mutation：vfx-field-set 字节级外科替换某个「已知布局」容器
            // （host/property/section8）里 Section11 的一个 Int32。未知 node type、
            // layout warning、Section9 非空或 Section12-14 非空都视为未知结构 →
            // FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE，fail-closed。
            // outputPath 必须是已校验的暂存区路径（越界之外的边界检查由
            // BridgeDaemonHost 的 DiskWritingCommands 门在分派前完成）。
            // writer 只接受 loose .fxr；ffxbnd.dcx 容器外层重建由
            // Patch Engine 在 main 侧完成，本层不重复实现容器逻辑。
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "sfx", "BRIDGE_OUTPUT_PATH_REQUIRED", "FXR writer requires a validated staging output path.");
            try
            {
                var written = await FxrNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "sfx", new[]
                {
                    new Diagnostic("info", "FXR_STAGING_WRITE_VERIFIED", "FXR 字段已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (FxrWriteBlockedException ex)
            {
                return BridgeResult<object>.Failed(file, "sfx", "FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE", ex.Message, ex.Details);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "sfx", "FXR_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "write-msb")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "map", "BRIDGE_OUTPUT_PATH_REQUIRED", "MSB writer requires a validated staging output path.");
            try
            {
                var written = await MsbNativeWriter.WriteAsync(file, outputPath, oodleRuntimeRoot, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "map", new[]
                {
                    new Diagnostic("info", "MSB_STAGING_WRITE_VERIFIED", "MSB 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (OodleRuntimeUnavailableException)
            {
                return BridgeResult<object>.Failed(
                    file,
                    "map",
                    "MSB_STAGING_WRITE_KRAK_OODLE_UNAVAILABLE",
                    "这份地图是 KRAK 压缩，写回需要 Oodle 运行库：到「开始」页选择含 sekiro.exe 的原版目录后再保存。");
            }
            catch (MsbUnregisteredEntityException ex)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_UNREGISTERED_ENTITY_TYPE", ex.Message);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "write-bnd4")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, resourceKind, "BRIDGE_OUTPUT_PATH_REQUIRED", "BND4 writer requires a validated staging output path.");
            try
            {
                var written = await Bnd4NativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_STAGING_WRITE_VERIFIED", "BND4 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        return command switch
        {
            "export-event" => ExportSemanticCandidate(file, "event", "Semantic EMEVD export is not implemented yet; inspect returns the audit envelope first."),
            "export-map" => ExportSemanticCandidate(file, "map", "Semantic MSB export is not implemented yet; inspect returns the audit envelope first."),
            "export-param" => ExportSemanticCandidate(file, "param", "Semantic PARAM export is not implemented yet; inspect returns the audit envelope first."),
            "export-msg" => MsgTextExport.Export(file),
            _ => BridgeResult<object>.Failed(file, resourceKind, "UNKNOWN_COMMAND", $"Unknown bridge command: {command}")
        };
    }

    private static object BuildFlverMeshPreview(
        FlverNativeDocument flver,
        int meshIndex,
        int maxVertices,
        int maxIndices)
    {
        var positions = flver.GetMeshPositionsBase64(meshIndex, maxVertices);
        if (positions == null)
            throw new InvalidDataException($"FLVER_MESH_NOT_FOUND: 网格索引 {meshIndex} 超出范围或数据不可用。");
        var indices = flver.GetMeshIndicesBase64(meshIndex, maxIndices);
        if (indices == null)
            throw new InvalidDataException(
                $"FLVER_MESH_INDICES_UNAVAILABLE: 网格 {meshIndex} 的完整 triangle-list 无法在上限 {maxIndices} 内导出。");
        var mesh = flver.Meshes[meshIndex];
        var skinning = flver.GetMeshSkinning(meshIndex, maxVertices);
        return new
        {
            meshIndex,
            vertexCount = mesh.VertexCount,
            indexSize = flver.GetMeshIndexSize(meshIndex),
            positionsBase64 = positions,
            indicesBase64 = indices,
            uvsBase64 = flver.GetMeshUVsBase64(meshIndex, maxVertices),
            normalsBase64 = flver.GetMeshNormalsBase64(meshIndex, maxVertices),
            boneWeightsBase64 = skinning.BoneWeightsBase64,
            boneIndicesBase64 = skinning.BoneIndicesBase64,
            skinningMode = skinning.SkinningMode,
            boneIndexSpace = skinning.BoneIndexSpace
        };
    }

    private static object[] BuildFlverMeshBundle(
        FlverNativeDocument flver,
        int maxVertices,
        int maxIndices,
        CancellationToken cancellationToken)
    {
        var meshes = new object[flver.MeshCount];
        for (var meshIndex = 0; meshIndex < flver.MeshCount; meshIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            meshes[meshIndex] = BuildFlverMeshPreview(flver, meshIndex, maxVertices, maxIndices);
        }
        return meshes;
    }

    private static object[] BuildFlverSkeleton(FlverNativeDocument flver)
    {
        System.Threading.Interlocked.Increment(ref MapStaticGeometryService.SkeletonCalls);
        var hierarchyIds = new string[flver.Bones.Count];
        var visiting = new HashSet<int>();

        string BuildHierarchyId(int index)
        {
            if (index < 0 || index >= flver.Bones.Count)
                throw new InvalidDataException($"FLVER_BONE_INDEX_INVALID: {index}。");
            if (!string.IsNullOrEmpty(hierarchyIds[index])) return hierarchyIds[index];
            if (!visiting.Add(index))
                throw new InvalidDataException($"FLVER_BONE_HIERARCHY_CYCLE: 骨骼 {index} 的 parent 链存在环。");

            var bone = flver.Bones[index];
            var parentId = bone.ParentIndex >= 0
                && bone.ParentIndex < flver.Bones.Count
                && bone.ParentIndex != index
                ? BuildHierarchyId(bone.ParentIndex)
                : "root";
            var occurrence = 0;
            for (var candidate = 0; candidate < index; candidate++)
            {
                var sibling = flver.Bones[candidate];
                if (sibling.ParentIndex == bone.ParentIndex
                    && string.Equals(sibling.Name, bone.Name, StringComparison.Ordinal))
                    occurrence++;
            }
            var id = $"{parentId}/{bone.Name}#{occurrence}";
            hierarchyIds[index] = id;
            visiting.Remove(index);
            return id;
        }

        for (var index = 0; index < flver.Bones.Count; index++)
            _ = BuildHierarchyId(index);

        return flver.Bones.Select(b => (object)new
        {
            index = b.Index,
            name = b.Name,
            parentIndex = b.ParentIndex,
            childIndex = b.ChildIndex,
            nextSiblingIndex = b.NextSiblingIndex,
            hierarchyId = hierarchyIds[b.Index],
            translation = new[] { b.TranslationX, b.TranslationY, b.TranslationZ },
            rotation = new[] { b.RotationX, b.RotationY, b.RotationZ },
            scale = new[] { b.ScaleX, b.ScaleY, b.ScaleZ },
            rotationOrder = "XZY"
        }).ToArray();
    }

    public static string GuessKindFromPath(string file)
    {
        var normalized = file.Replace('\\', '/').ToLowerInvariant();
        foreach (var kind in new[] { "event", "map", "param", "msg", "menu", "script", "action", "ai", "sfx" })
        {
            if (normalized.Contains($"/{kind}/")) return kind;
        }

        var name = Path.GetFileName(file).ToLowerInvariant();
        if (name.Contains("emevd")) return "event";
        if (name.Contains("msb")) return "map";
        if (name.Contains("param")) return "param";
        if (name.Contains("msg") || name.EndsWith(".fmg")) return "msg";
        if (name.EndsWith(".tae")) return "action";
        if (name.EndsWith(".flver")) return "chr";
        if (name.EndsWith(".esd")) return "script";
        return "unknown";
    }

    private static BridgeResult<object> ExportSemanticCandidate(
        string file,
        string resourceKind,
        string unsupportedMessage)
    {
        return SemanticCandidateExports.TryExport(file, resourceKind)
            ?? BridgeResult<object>.Unsupported(file, resourceKind, unsupportedMessage);
    }

    /// <summary>
    /// NATIVE-03: Bridge-confirmed document locator probe。
    ///
    /// 只对「真实读取外层后确认的 magic」产生 `confirmedBy: "bridge"` 层；
    /// suffix/path hint 永远不能构造层。KRAK 且无可用 Oodle runtime 时返回
    /// LOCATOR_RUNTIME_BLOCKED（可重试），不是格式失败。同名 child 出现两个
    /// 不兼容 confirmed leaf 时返回 probeStatus=conflict 且不静默单选。
    /// 响应只携带脱敏标识符与哈希，不含主机路径。
    /// </summary>
    private static BridgeResult<object> ProbeDocumentLocator(
        string file,
        string? oodleRuntimeRoot,
        string resourceKind)
    {
        var sourceUri = BridgeResult<object>.MakeSourceUri(file);
        try
        {
            var source = File.ReadAllBytes(file);
            var outerHash = HashHex(source);
            var layers = new List<BridgeDocumentLocatorLayerDto>();
            var confirmedStackIds = new List<string>();
            byte[] payload = source;
            var layerIndex = 0;

            if (source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            {
                DcxNativeDocument dcx;
                try
                {
                    dcx = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                }
                catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException or InvalidDataException)
                {
                    // KRAK 且 Oodle runtime 未挂载/版本不匹配 → 运行时缺失，
                    // 按「可重试的 blocked」返回，不伪装成格式失败。
                    return BridgeResult<object>.Failed(file, resourceKind, "LOCATOR_RUNTIME_BLOCKED",
                        $"无法解压外层 DCX：{ex.Message}",
                        new { compressionRuntime = "oodle-unavailable", retryable = true });
                }
                var dcxFormatId = dcx.CompressionFormat == "KRAK" ? "dcx-krak" : "dcx-dflt";
                layers.Add(new BridgeDocumentLocatorLayerDto(layerIndex++, dcxFormatId, "bridge", null, null));
                payload = dcx.Payload;
            }

            if (payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
            {
                var binder = Bnd4NativeDocument.Read(payload);
                var containerRole = GuessContainerRole(binder, file);
                // 冲突判定按「原始 entry 名」分组：同名 child（含 DuplicateOrdinal
                // 重复名）只要出现两个不兼容 confirmed leaf 即 conflict，禁止静默单选。
                var leafByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var stackIdByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var conflicts = new List<string>();
                var childLayers = new List<BridgeDocumentLocatorLayerDto>();

                for (var index = 0; index < binder.Entries.Count; index++)
                {
                    var entry = binder.Entries[index];
                    var entryBytes = binder.GetStoredBytes(index);
                    var leaf = DetectLeafFormat(entryBytes);
                    var stableEntryId = BuildStableEntryId(index, entry.Name);
                    var stackId = $"locator:{outerHash[..12]}:bnd4:{stableEntryId}";
                    if (leaf != "unknown")
                    {
                        if (leafByName.TryGetValue(entry.Name, out var existing) && existing != leaf)
                        {
                            // 同一 child 两个不兼容 confirmed leaf → conflict，禁止静默单选。
                            if (conflicts.Count == 0 && stackIdByName.TryGetValue(entry.Name, out var firstStackId))
                            {
                                confirmedStackIds.Add(firstStackId);
                            }
                            conflicts.Add(stackId);
                            confirmedStackIds.Add(stackId);
                            continue;
                        }
                        leafByName[entry.Name] = leaf;
                        stackIdByName[entry.Name] = stackId;
                        confirmedStackIds.Add(stackId);
                        childLayers.Add(new BridgeDocumentLocatorLayerDto(
                            layerIndex++,
                            leaf,
                            "bridge",
                            stableEntryId,
                            new BridgeDocumentLocatorEntryDto(
                                stableEntryId,
                                index,
                                entry.Name,
                                entry.ContentHash)));
                    }
                    else
                    {
                        // suffix-only 或未知 magic：只作为容器 child 存在，不构成 confirmed leaf。
                        childLayers.Add(new BridgeDocumentLocatorLayerDto(
                            layerIndex++,
                            "unknown",
                            "bridge",
                            stableEntryId,
                            new BridgeDocumentLocatorEntryDto(
                                stableEntryId,
                                index,
                                entry.Name,
                                entry.ContentHash)));
                    }
                }

                layers.Add(new BridgeDocumentLocatorLayerDto(layerIndex++, "bnd4", "bridge", null, null));
                layers.AddRange(childLayers);

                var leafFormatId = childLayers.Count > 0
                    ? (conflicts.Count > 0 ? "bnd4" : MostSpecificLeaf(leafByName.Values))
                    : "bnd4";
                var probeStatus = conflicts.Count > 0 ? "conflict" : "confirmed";
                var value = new
                {
                    outerResourceId = $"resource:{outerHash[..16]}",
                    outerByteLength = source.Length,
                    outerHash,
                    containerRole,
                    layers,
                    leafFormatId,
                    probeStatus,
                    reasonCode = conflicts.Count > 0 ? "conflicting-confirmed-leaf" : (string?)null,
                    confirmedStackIds
                };
                var diagnostics = new[]
                {
                    new Diagnostic(
                        conflicts.Count > 0 ? "error" : "info",
                        conflicts.Count > 0 ? "LOCATOR_CONFLICTING_LEAF" : "LOCATOR_STACK_CONFIRMED",
                        conflicts.Count > 0
                            ? $"外层容器内同名 child 出现不兼容的 confirmed leaf（{string.Join("; ", conflicts)}），禁止静默单选。"
                            : $"Bridge 已确认格式栈：dcx-dflt/bnd4 + {confirmedStackIds.Count} 个 confirmed child。",
                        sourceUri,
                        value)
                };
                return BridgeResult<object>.Partial(file, resourceKind, diagnostics, value);
            }

            // Loose (non-container) resource：只按 payload magic 确认一层。
            var looseLeaf = DetectLeafFormat(payload);
            if (looseLeaf == "unknown")
            {
                return BridgeResult<object>.Failed(file, resourceKind, "LOCATOR_FORMAT_UNCONFIRMED",
                    "输入内容没有可确认的 native magic；suffix/path 只构成 candidate，不构成 confirmed stack。");
            }
            layers.Add(new BridgeDocumentLocatorLayerDto(0, looseLeaf, "bridge", null, null));
            var looseStackId = $"locator:{outerHash[..12]}:loose";
            var looseValue = new
            {
                outerResourceId = $"resource:{outerHash[..16]}",
                outerByteLength = source.Length,
                outerHash,
                containerRole = "none",
                layers,
                leafFormatId = looseLeaf,
                probeStatus = "confirmed",
                reasonCode = (string?)null,
                confirmedStackIds = new[] { looseStackId }
            };
            return BridgeResult<object>.Partial(file, resourceKind, new[]
            {
                new Diagnostic("info", "LOCATOR_STACK_CONFIRMED",
                    $"Bridge 已确认 loose 格式栈：{looseLeaf}。",
                    sourceUri, looseValue)
            }, looseValue);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
        {
            return BridgeResult<object>.Failed(file, resourceKind, "LOCATOR_PROBE_FAILED", ex.Message);
        }
    }

    private static string DetectLeafFormat(byte[] payload)
    {
        if (payload.Length < 4) return "unknown";
        if (payload.AsSpan(0, 4).SequenceEqual("PARA"u8)) return "param";
        if (payload.AsSpan(0, 4).SequenceEqual("FMG\0"u8)) return "fmg";
        if (payload.AsSpan(0, 4).SequenceEqual("EVD\0"u8)) return "emevd";
        if (payload.AsSpan(0, 4).SequenceEqual("MSB\0"u8)) return "msb";
        if (payload.AsSpan(0, 4).SequenceEqual("BND4"u8)) return "bnd4";
        return "unknown";
    }

    /// <summary>
    /// probe-document-locator 的层 DTO。全局序列化配置是 WhenWritingNull，
    /// 但 TS 侧契约要求容器层必须出现显式 `entry: null`（缺键会被 TS 运行时
    /// 读成 undefined，与 `null | {...}` 契约不符）——所以这里属性级强制
    /// JsonIgnoreCondition.Never，绕过全局省略。
    /// </summary>
    private sealed record BridgeDocumentLocatorLayerDto(
        int LayerIndex,
        string FormatId,
        string ConfirmedBy,
        string? ChildStableId,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
        BridgeDocumentLocatorEntryDto? Entry);

    private sealed record BridgeDocumentLocatorEntryDto(
        string StableEntryId,
        int EntryIndex,
        string EntryName,
        string ExpectedEntryHash);

    /// <summary>
    /// container role 与 byte format 分开：角色是语义分类（gameparam 参数集、
    /// msg 文本集、script 脚本集……），format 是字节 magic。判定优先看 entry
    /// 名（Sekiro 的 parambnd 内是 ItemParam/SpEffectParam 这类真名），fallback
    /// 到外层文件名（gameparam.parambnd.dcx、msg_*.dcx 这类惯例名）。
    /// </summary>
    private static string GuessContainerRole(Bnd4NativeDocument binder, string file)
    {
        var names = binder.Entries.Select(entry => entry.Name.ToLowerInvariant()).ToList();
        var fileName = System.IO.Path.GetFileName(file).ToLowerInvariant();

        if (names.Any(name => name.Contains("gameparam")) || fileName.Contains("gameparam")) return "gameparam-binder";
        if (names.Any(name => name.Contains("drawparam")) || fileName.Contains("drawparam")) return "drawparam-binder";
        if (names.Any(name => name.EndsWith(".fmg") || name.Contains(".msg")) || fileName.Contains("msg")) return "msg-binder";
        if (names.Any(name => name.EndsWith(".lua") || name.Contains("script")) || fileName.Contains("script")) return "script-binder";
        if (names.Any(name => name.Contains("behavior") || name.Contains("_ai_")) || fileName.Contains("behavior")) return "behavior-binder";
        if (names.Any(name => name.EndsWith(".anibnd") || name.Contains("anibnd") || name.Contains("_anim")) || fileName.Contains("anibnd")) return "animation-binder";
        if (names.Any(name => name.Contains("texture") || name.EndsWith(".texbnd")) || fileName.Contains("texbnd")) return "texture-binder";
        if (names.Any(name => name.Contains("vfx") || name.Contains("fx")) || fileName.Contains("vfx")) return "vfx-binder";
        return "generic-binder";
    }

    private static string BuildStableEntryId(int index, string name)
    {
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name))).ToLowerInvariant();
        return $"bnd4:{index}:{digest[..12]}";
    }

    private static string MostSpecificLeaf(IEnumerable<string> leaves)
    {
        var distinct = leaves.Distinct().ToArray();
        return distinct.Length == 1 ? distinct[0] : "bnd4";
    }

    private static string HashHex(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string ActionFailureCode(Exception error, string fallback)
    {
        var token = error.Message
            .Split(new[] { ' ', ':', ';', '\r', '\n', '\t' }, 2, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        return token is not null && token.StartsWith("ACTION_", StringComparison.Ordinal)
            ? token
            : fallback;
    }

    /// <summary>
    /// Cheap magic check (4 bytes) so read-emevd-document can dispatch to the
    /// native DCX unwrap without loading the full file twice.
    /// </summary>
    // S18 会话缓存（EmevdDocumentCache）与命令分发表同程序集共享；合并 7c5639a
    // 曾把可见性回退成 private 导致编译红，这里固定为 internal。
    internal static bool IsDcxFile(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4);
            Span<byte> magic = stackalloc byte[4];
            var read = fs.Read(magic);
            return read == 4 && magic.SequenceEqual("DCX\0"u8);
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static bool IsDcxBytes(byte[] bytes) =>
        bytes.Length >= 4 && bytes.AsSpan(0, 4).SequenceEqual("DCX\0"u8);

    private static string? EmptyToNull(string value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    /// <summary>
    /// 是否为 TAE 打包容器（anibnd）。T3（2026-08-15）：动作域的 `*.anibnd.dcx`
    /// 在 TAE 读链里由 Bridge 提取内部 TAE，不落 BND4 通用容器页。
    /// </summary>
    private static bool IsAnibndPath(string path)
    {
        var lower = path.ToLowerInvariant();
        return lower.EndsWith(".anibnd.dcx") || lower.EndsWith(".anibnd");
    }

    /// <summary>
    /// 打开 TAE 文档：anibnd 容器提取主 TAE（id 5000000 优先，其次字节最大），
    /// 裸 .tae 直接读。S17：read-tae-document 与 read-tae-event-params 共用，
    /// 不再维护第二份 anibnd 解包。找不到 TAE 条目抛 TaeEntryMissingException，
    /// 命令层映射 TAE_ANIBND_NO_TAE_ENTRY。
    /// </summary>
    private static (TaeNativeDocument Document, Diagnostic[] ExtractionDiagnostics) OpenTaeDocument(
        string file,
        string? oodleRuntimeRoot)
    {
        if (!IsAnibndPath(file))
            return (TaeNativeDocument.ReadFile(file), Array.Empty<Diagnostic>());
        var dcx = DcxNativeDocument.Read(file, oodleRuntimeRoot);
        var bnd4 = Bnd4NativeDocument.Read(dcx.Payload);
        int? mainIndex = null;
        var taeEntryCount = 0;
        var largestIndex = -1;
        var largestBytes = -1L;
        for (var i = 0; i < bnd4.Entries.Count; i++)
        {
            var bytes = bnd4.GetStoredBytes(i);
            if (bytes.Length < 4 || !bytes.AsSpan(0, 4).SequenceEqual("TAE "u8)) continue;
            taeEntryCount++;
            if (bnd4.Entries[i].Id == 5000000)
            {
                mainIndex = i;
                break;
            }
            if (bytes.Length > largestBytes)
            {
                largestBytes = bytes.Length;
                largestIndex = i;
            }
        }
        mainIndex ??= largestIndex >= 0 ? largestIndex : null;
        if (mainIndex is null)
            throw new TaeEntryMissingException("anibnd 容器内未找到 TAE 魔数条目。");
        var mainBytes = bnd4.GetStoredBytes(mainIndex.Value);
        var mainEntryId = bnd4.Entries[mainIndex.Value].Id;
        var diagnostics = new[]
        {
            new Diagnostic(
                "info",
                "TAE_FROM_ANIBND_EXTRACTED",
                $"从 anibnd 容器提取 TAE（BND4 内 {taeEntryCount} 个 TAE 条目，本次打开 id={mainEntryId}，大小 {mainBytes.Length} 字节）。hkx 未读取。",
                BridgeResult<object>.MakeSourceUri(file),
                new { taeEntryCount, mainEntryId, mainTaeBytes = mainBytes.Length })
        };
        return (TaeNativeDocument.Read(mainBytes), diagnostics);
    }

    /// <summary>
    /// Container-level asset inventory (candidate): unpack outer DCX, enumerate BND4
    /// entries and classify by extension/magic without decoding child semantics.
    /// Output is limited to logical entry names, counts and category aggregates —
    /// never host paths, payload content or full child dumps.
    /// </summary>
    private static BridgeResult<object> InventoryAssetResources(
        string file,
        JsonElement options,
        string? oodleRuntimeRoot,
        CancellationToken cancellationToken)
    {
        const int maxEntries = 1_000_000;
        const int sampleLimit = 64;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var source = File.ReadAllBytes(file);
            byte[] payload = source;
            string? outerCompression = null;
            if (source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            {
                var dcx = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                payload = dcx.Payload;
                outerCompression = dcx.CompressionFormat;
            }

            if (payload.AsSpan(0, 4).SequenceEqual("BND3"u8))
                throw new NotSupportedException("BND3 容器尚不支持 inventory 枚举。");

            if (!payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
            {
                // Non-container resource: classify the payload itself as a single entry.
                var kind = ClassifyAssetKind(payload);
                var envelope = new
                {
                    format = outerCompression is null ? "raw" : $"DCX-{outerCompression}",
                    containerType = "none",
                    entryCount = 1,
                    resourceKinds = new Dictionary<string, int> { [kind] = 1 },
                    extensions = new Dictionary<string, int> { [GuessExtension(payload)] = 1 },
                    sampleEntries = new[] { new { name = Path.GetFileName(file), id = 0 } },
                    authority = "candidate"
                };
                return BridgeResult<object>.Partial(file, GuessKindFromPath(file), new[]
                {
                    new Diagnostic("info", "ASSET_INVENTORY_SINGLE_RESOURCE",
                        "输入不是容器；按单资源分类。", BridgeResult<object>.MakeSourceUri(file), envelope)
                }, envelope);
            }

            var binder = Bnd4NativeDocument.Read(payload);
            if (binder.Entries.Count > maxEntries)
                throw new InvalidDataException($"BND4 条目数 {binder.Entries.Count} 超出安全上限。");
            cancellationToken.ThrowIfCancellationRequested();

            var kindCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            var extCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var samples = new List<object>(sampleLimit);
            for (var index = 0; index < binder.Entries.Count; index++)
            {
                var entry = binder.Entries[index];
                var ext = GetExtension(entry.Name);
                extCounts[ext] = extCounts.GetValueOrDefault(ext) + 1;
                var kind = ClassifyAssetKind(entry.Name);
                kindCounts[kind] = kindCounts.GetValueOrDefault(kind) + 1;
                if (samples.Count < sampleLimit)
                {
                    samples.Add(new { name = entry.Name, id = entry.Id });
                }
            }

            var bnd4Envelope = new
            {
                format = outerCompression is null ? "BND4" : $"DCX-{outerCompression}->BND4",
                containerType = "bnd4",
                entryCount = binder.Entries.Count,
                resourceKinds = kindCounts.OrderByDescending(pair => pair.Value).ToDictionary(pair => pair.Key, pair => pair.Value),
                extensions = extCounts.OrderByDescending(pair => pair.Value).ToDictionary(pair => pair.Key, pair => pair.Value),
                sampleEntries = samples,
                authority = "candidate"
            };
            return BridgeResult<object>.Partial(file, GuessKindFromPath(file), new[]
            {
                new Diagnostic("info", "ASSET_INVENTORY_ENUMERATED",
                    $"BND4 容器条目已枚举：{binder.Entries.Count} 条，类别分布见 details。",
                    BridgeResult<object>.MakeSourceUri(file), bnd4Envelope)
            }, bnd4Envelope);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
        {
            return BridgeResult<object>.Failed(file, GuessKindFromPath(file), "ASSET_INVENTORY_FAILED", ex.Message);
        }
    }

    private static string ClassifyAssetKind(string name)
    {
        var lower = name.ToLowerInvariant();
        if (lower.Contains("event") || lower.EndsWith(".emevd")) return "event";
        if (lower.EndsWith(".msb")) return "map";
        if (lower.Contains("param") || lower.EndsWith(".param")) return "param";
        if (lower.Contains("msg") || lower.EndsWith(".fmg") || lower.EndsWith(".msgbnd")) return "msg";
        if (lower.EndsWith(".luagnl") || lower.EndsWith(".luainfo") || lower.EndsWith(".lua")
            || lower.EndsWith(".esd") || lower.EndsWith(".talkesdbnd")) return "script";
        if (lower.EndsWith(".tae") || lower.EndsWith(".hkx") || lower.EndsWith(".hks")
            || lower.EndsWith(".hkt") || lower.EndsWith(".anibnd") || lower.EndsWith(".behbnd")) return "action";
        if (lower.EndsWith(".flver") || lower.EndsWith(".tpf") || lower.EndsWith(".dds")
            || lower.EndsWith(".mtd") || lower.EndsWith(".matbin") || lower.EndsWith(".texbnd")
            || lower.EndsWith(".objbnd") || lower.EndsWith(".partsbnd") || lower.EndsWith(".mapbnd")
            || lower.EndsWith(".chrbnd")) return "chr";
        return "other";
    }

    private static string ClassifyAssetKind(byte[] sample)
    {
        if (sample.AsSpan(0, 4).SequenceEqual("EVD\0"u8)) return "event";
        if (sample.AsSpan(0, 4).SequenceEqual("FMG\0"u8)) return "msg";
        if (sample.AsSpan(0, 4).SequenceEqual("PARA"u8)) return "param";
        if (sample.AsSpan(0, 4).SequenceEqual("MSB\0"u8)) return "map";
        if (sample.AsSpan(0, 4).SequenceEqual("FLVE"u8)) return "chr";
        return "other";
    }

    private static string GuessExtension(byte[] sample)
    {
        if (sample.AsSpan(0, 4).SequenceEqual("EVD\0"u8)) return ".emevd";
        if (sample.AsSpan(0, 4).SequenceEqual("FMG\0"u8)) return ".fmg";
        if (sample.AsSpan(0, 4).SequenceEqual("PARA"u8)) return ".param";
        if (sample.AsSpan(0, 4).SequenceEqual("MSB\0"u8)) return ".msb";
        return "(unknown)";
    }

    private static string GetExtension(string name)
    {
        var fileName = name.Replace('\\', '/').Split('/').LastOrDefault() ?? name;
        var dot = fileName.LastIndexOf('.');
        return dot >= 0 && dot < fileName.Length - 1 ? fileName[dot..].ToLowerInvariant() : "(none)";
    }

    private static string BinderEntryBasename(string name)
    {
        var normalized = name.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        return slash >= 0 ? normalized[(slash + 1)..] : normalized;
    }

    private static async Task<BridgeResult<object>> InspectEnvelopeAsync(
        string file,
        bool includeReadableValidation,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        var fileInfo = new FileInfo(file);
        var sample = await ReadBoundedPrefixAsync(file, MaxPrefixBytes, cancellationToken);
        var inspection = EnvelopeInspection.Inspect(
            file,
            sample,
            fileInfo.Length,
            MaxPrefixBytes,
            oodleRuntimeRoot);
        var diagnostics = includeReadableValidation
            ? inspection.Diagnostics.Prepend(new Diagnostic(
                "info",
                "VALIDATION_READABLE",
                "File exists and its bounded prefix can be opened for read validation. No unpacking, decompression, or semantic parsing was attempted.",
                BridgeResult<object>.MakeSourceUri(file))).ToArray()
            : inspection.Diagnostics;

        return BridgeResult<object>.Partial(file, inspection.ResourceKind, diagnostics, inspection);
    }

    private static async Task<byte[]> ReadBoundedPrefixAsync(
        string file,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        if (maxBytes < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes), "Maximum prefix size must be non-negative.");
        }

        var fileInfo = new FileInfo(file);
        if (!fileInfo.Exists) throw new FileNotFoundException("Input file does not exist.", file);

        var bytesToRead = (int)Math.Min(fileInfo.Length, maxBytes);
        if (bytesToRead == 0) return Array.Empty<byte>();

        var buffer = new byte[bytesToRead];
        await using var stream = new FileStream(
            file,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            bufferSize: 64 * 1024,
            options: FileOptions.Asynchronous | FileOptions.SequentialScan);

        var totalRead = 0;
        while (totalRead < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(totalRead), cancellationToken);
            if (read == 0) break;
            totalRead += read;
        }

        if (totalRead == buffer.Length) return buffer;
        Array.Resize(ref buffer, totalRead);
        return buffer;
    }

    private static (HkxSkeleton Skeleton, HkxAnimation Animation, HkxAnimationBinding Binding, long MotionAnimId, string SourceContainerPath)
        ResolveTaeAnimationContext(
            string file,
            long animId,
            string? oodleRuntimeRoot,
            string? animationContainerPath = null,
            string? skeletonContainerPath = null)
    {
        var (document, _) = OpenTaeDocument(file, oodleRuntimeRoot);
        var references = SekiroTaeMotionReferenceReader.ReadAll(document);
        long motionAnimId = ActionAnimationSemantics.ResolveMotionAnimationId(references, animId);

        Bnd4NativeDocument ReadBnd(string path)
        {
            var dcx = DcxNativeDocument.Read(path, oodleRuntimeRoot);
            return Bnd4NativeDocument.Read(dcx.Payload);
        }

        byte[] ReadEntryBytes(Bnd4NativeDocument bnd4, Bnd4Entry entry)
        {
            var raw = bnd4.GetStoredBytes(entry.Index);
            return raw.Length >= 4 && raw.AsSpan(0, 4).SequenceEqual("DCX\0"u8)
                ? DcxNativeDocument.Read(raw, oodleRuntimeRoot).Payload
                : raw;
        }

        // TAE and its selected ANIBND are the only authoritative relation available
        // to this command. Do not scan sibling files by filename prefix: that can
        // select a valid-looking HKX from an unrelated character and silently play
        // the wrong animation. If the selected container lacks the logical motion,
        // fail closed and require an explicit higher-level import relation.
        var foundContainer = animationContainerPath ?? file;
        var targetBnd = ReadBnd(foundContainer);
        var targetEntryIndex = ActionAnimationSemantics.ResolveAnimationBinderEntryIndex(
            targetBnd.Entries.Select(e => (e.Index, (long)e.Id)).ToArray(),
            motionAnimId);
        var animHkxBytes = ReadEntryBytes(
            targetBnd,
            targetBnd.Entries.Single(entry => entry.Index == targetEntryIndex));

        var compendiumEntries = targetBnd.Entries
            .Where(entry => entry.Name.EndsWith(".compendium", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (compendiumEntries.Length > 1)
            throw new InvalidDataException($"ACTION_HKX_COMPENDIUM_AMBIGUOUS: target ANIBND contains {compendiumEntries.Length} compendium entries.");
        byte[]? compendiumBytes = compendiumEntries.Length == 1
            ? ReadEntryBytes(targetBnd, compendiumEntries[0])
            : null;

        var skeletonSourceBnd = targetBnd;
        var skeletonCompendiumBytes = compendiumBytes;
        var skeletonEntries = targetBnd.Entries
            .Where(entry => entry.Id == 4000000 || entry.Name.EndsWith("skeleton.hkx", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (skeletonEntries.Length == 0
            && !string.IsNullOrWhiteSpace(skeletonContainerPath)
            && !string.Equals(Path.GetFullPath(skeletonContainerPath), Path.GetFullPath(foundContainer), StringComparison.OrdinalIgnoreCase))
        {
            skeletonSourceBnd = ReadBnd(skeletonContainerPath);
            var skeletonCompendiumEntries = skeletonSourceBnd.Entries
                .Where(entry => entry.Name.EndsWith(".compendium", StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (skeletonCompendiumEntries.Length > 1)
                throw new InvalidDataException($"ACTION_HKX_COMPENDIUM_AMBIGUOUS: skeleton container contains {skeletonCompendiumEntries.Length} compendium entries.");
            if (skeletonCompendiumEntries.Length == 1)
                skeletonCompendiumBytes = ReadEntryBytes(skeletonSourceBnd, skeletonCompendiumEntries[0]);
            skeletonEntries = skeletonSourceBnd.Entries
                .Where(entry => entry.Id == 4000000 || entry.Name.EndsWith("skeleton.hkx", StringComparison.OrdinalIgnoreCase))
                .ToArray();
        }
        if (skeletonEntries.Length > 1)
            throw new InvalidDataException($"ACTION_HKX_SKELETON_AMBIGUOUS: target ANIBND contains {skeletonEntries.Length} skeleton entries.");
        byte[]? skeletonHkxBytes = skeletonEntries.Length == 1
            ? ReadEntryBytes(skeletonSourceBnd, skeletonEntries[0])
            : null;

        if (skeletonHkxBytes == null)
        {
            throw new InvalidDataException(
                "ACTION_HKX_SKELETON_MISSING: target ANIBND 没有 skeleton.hkx；拒绝按文件名猜测 companion skeleton。");
        }

        var animContainer = HkxAnimationReader.ReadContainer(animHkxBytes, compendiumBytes);
        var boundCandidates = animContainer.Bindings
            .Where(binding => binding.AnimationObjectOffset >= 0)
            .Select(binding => new
            {
                Binding = binding,
                Animation = animContainer.Animations.SingleOrDefault(animation =>
                    animation.NativeObjectOffset == binding.AnimationObjectOffset)
            })
            .Where(candidate => candidate.Animation != null)
            .ToArray();

        if (boundCandidates.Length == 0)
            throw new InvalidDataException("ACTION_HKX_BINDING_MISSING: HKX 中没有能通过 native animation object identity 解析的 hkaAnimationBinding。");
        if (boundCandidates.Length > 1)
            throw new InvalidDataException($"ACTION_HKX_BINDING_AMBIGUOUS: HKX 中有 {boundCandidates.Length} 个 binding/animation identity 候选。");

        var binding = boundCandidates[0].Binding;
        var animation = boundCandidates[0].Animation!;
        HkxSkeleton skeleton;

        if (animContainer.Skeletons.Count > 0)
        {
            skeleton = ResolveUniqueAnimationSkeleton(
                animContainer.Skeletons,
                binding.OriginalSkeletonName,
                "animation HKX");
        }
        else if (skeletonHkxBytes != null)
        {
            var skelContainer = HkxAnimationReader.ReadContainer(skeletonHkxBytes, skeletonCompendiumBytes);
            skeleton = ResolveUniqueAnimationSkeleton(
                skelContainer.Skeletons,
                binding.OriginalSkeletonName,
                "companion skeleton HKX");
        }
        else
        {
            throw new InvalidDataException("ACTION_HKX_SKELETON_MISSING: 未能获取动画所需的骨骼 (hkaSkeleton) 数据。");
        }

        return (skeleton, animation, binding, motionAnimId, foundContainer);
    }

    private static HkxSkeleton ResolveUniqueAnimationSkeleton(
        IReadOnlyList<HkxSkeleton> skeletons,
        string originalSkeletonName,
        string sourceDescription)
    {
        if (skeletons.Count == 0)
            throw new InvalidDataException($"ACTION_HKX_SKELETON_MISSING: {sourceDescription} 中没有 hkaSkeleton。");

        if (!string.IsNullOrWhiteSpace(originalSkeletonName))
        {
            var named = skeletons
                .Where(skeleton => string.Equals(skeleton.Name, originalSkeletonName, StringComparison.Ordinal))
                .ToArray();
            if (named.Length == 1) return named[0];
            if (named.Length > 1)
                throw new InvalidDataException($"ACTION_HKX_SKELETON_AMBIGUOUS: {sourceDescription} 中 skeleton '{originalSkeletonName}' 有 {named.Length} 个匹配。");
            throw new InvalidDataException($"ACTION_HKX_SKELETON_MISSING: {sourceDescription} 中没有匹配 binding.originalSkeletonName='{originalSkeletonName}' 的 hkaSkeleton。");
        }

        if (skeletons.Count != 1)
            throw new InvalidDataException($"ACTION_HKX_SKELETON_AMBIGUOUS: {sourceDescription} 中有 {skeletons.Count} 个 skeleton，binding 未提供 originalSkeletonName。");
        return skeletons[0];
    }
}

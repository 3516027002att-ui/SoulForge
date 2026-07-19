using System.Text.Json;

internal sealed class BridgeCommandService
{
    private const int MaxPrefixBytes = 512 * 1024;

    public async Task<BridgeResult<object>> ExecuteAsync(
        string rawCommand,
        string file,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null,
        JsonElement options = default,
        string? outputPath = null)
    {
        var command = rawCommand.Trim().ToLowerInvariant();
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
                var diagnostics = new[]
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
                return BridgeResult<object>.Partial(file, GuessKindFromPath(file), diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or InvalidOperationException or IOException)
            {
                return BridgeResult<object>.Failed(file, GuessKindFromPath(file), "DCX_DOCUMENT_READ_FAILED", ex.Message);
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
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, resourceKind, "BRIDGE_OUTPUT_PATH_REQUIRED", "BND4 extraction requires a validated staging output path.");
            try
            {
                var extracted = await Bnd4NativeWriter.ExtractChildAsync(
                    file,
                    outputPath,
                    options,
                    cancellationToken,
                    oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_CHILD_EXTRACTED_TO_STAGING", "BND4 子项已提取到受控暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), extracted)
                }, extracted);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_EXTRACTION_FAILED", ex.Message);
            }
        }

        if (command == "read-fmg-document")
        {
            try
            {
                var document = FmgNativeDocument.ReadFile(file);
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
                var written = await FmgNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
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

        if (command == "read-param-document")
        {
            try
            {
                var document = ParamNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var rowOffset = OptionalInt(options, "rowOffset", 0);
                var rowLimit = OptionalInt(options, "rowLimit", 32);
                var rowId = OptionalNullableInt(options, "rowId");
                var includePayloads = OptionalBool(options, "includePayloads", true);
                var diagnostics = new[]
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
                return BridgeResult<object>.Partial(
                    file,
                    "param",
                    diagnostics,
                    document.ToEnvelope(roundTrip, rowOffset, rowLimit, rowId, includePayloads));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                var code = ex.Message.StartsWith("PARAM read options:", StringComparison.Ordinal)
                    ? "PARAM_READ_OPTIONS_INVALID"
                    : ex.Message.Contains("首行数据偏移", StringComparison.Ordinal)
                        ? "PARAM_LAYOUT_UNSUPPORTED"
                        : "PARAM_DOCUMENT_READ_FAILED";
                return BridgeResult<object>.Failed(file, "param", code, ex.Message);
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
                var source = EmevdNativeSource.Read(file, oodleRuntimeRoot);
                var document = source.Document;
                var roundTrip = document.VerifyRoundTrip();
                int? focusEventIndex = null;
                int? focusInstructionLocalIndex = null;
                int? snapshotEventIndex = null;
                long? snapshotEventIdOverride = null;
                int? snapshotInstructionEventIndex = null;
                int? snapshotInstructionLocalIndex = null;
                int? instructionOrderEventIndex = null;
                EmevdInstructionAuthoringRequest? instructionAuthoringRequest = null;
                if (options.ValueKind == JsonValueKind.Object)
                {
                    if (options.TryGetProperty("focusEventIndex", out var fei)
                        && fei.ValueKind == JsonValueKind.Number)
                        focusEventIndex = fei.GetInt32();
                    if (options.TryGetProperty("focusInstructionLocalIndex", out var fii)
                        && fii.ValueKind == JsonValueKind.Number)
                        focusInstructionLocalIndex = fii.GetInt32();
                    if (options.TryGetProperty("snapshotEventIndex", out var sei)
                        && sei.ValueKind == JsonValueKind.Number)
                        snapshotEventIndex = sei.GetInt32();
                    if (options.TryGetProperty("snapshotEventIdOverride", out var seio)
                        && seio.ValueKind == JsonValueKind.Number)
                        snapshotEventIdOverride = seio.GetInt64();
                    if (options.TryGetProperty("snapshotInstructionEventIndex", out var siei)
                        && siei.ValueKind == JsonValueKind.Number)
                        snapshotInstructionEventIndex = siei.GetInt32();
                    if (options.TryGetProperty("snapshotInstructionLocalIndex", out var sili)
                        && sili.ValueKind == JsonValueKind.Number)
                        snapshotInstructionLocalIndex = sili.GetInt32();
                    if (options.TryGetProperty("instructionOrderEventIndex", out var ioei)
                        && ioei.ValueKind == JsonValueKind.Number)
                        instructionOrderEventIndex = ioei.GetInt32();

                    var hasAuthorEventIndex = options.TryGetProperty(
                        "authorInstructionEventIndex",
                        out var authorEventIndex);
                    var hasAuthorInstructionIndex = options.TryGetProperty(
                        "authorInstructionIndex",
                        out var authorInstructionIndex);
                    var hasAuthorBank = options.TryGetProperty(
                        "authorInstructionBank",
                        out var authorBank);
                    var hasAuthorInstructionId = options.TryGetProperty(
                        "authorInstructionId",
                        out var authorInstructionId);
                    var hasAuthorArgsBase64 = options.TryGetProperty(
                        "authorInstructionArgsBase64",
                        out var authorArgsBase64);
                    if (hasAuthorEventIndex
                        || hasAuthorInstructionIndex
                        || hasAuthorBank
                        || hasAuthorInstructionId
                        || hasAuthorArgsBase64)
                    {
                        if (!hasAuthorEventIndex
                            || !authorEventIndex.TryGetInt32(out var parsedAuthorEventIndex)
                            || !hasAuthorInstructionIndex
                            || !authorInstructionIndex.TryGetInt32(out var parsedAuthorInstructionIndex)
                            || !hasAuthorBank
                            || !authorBank.TryGetInt32(out var parsedAuthorBank)
                            || !hasAuthorInstructionId
                            || !authorInstructionId.TryGetInt32(out var parsedAuthorInstructionId)
                            || !hasAuthorArgsBase64
                            || authorArgsBase64.ValueKind != JsonValueKind.String
                            || authorArgsBase64.GetString() is not string parsedAuthorArgsBase64)
                            throw new InvalidDataException(
                                "EMEVD instruction authoring 字段必须完整提供且类型正确。");
                        instructionAuthoringRequest = new EmevdInstructionAuthoringRequest(
                            parsedAuthorEventIndex,
                            parsedAuthorInstructionIndex,
                            parsedAuthorBank,
                            parsedAuthorInstructionId,
                            parsedAuthorArgsBase64);
                    }
                }
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
                        roundTrip)
                };
                return BridgeResult<object>.Partial(
                    file,
                    "event",
                    diagnostics,
                    document.ToEnvelope(
                        roundTrip,
                        source.Describe(),
                        focusEventIndex,
                        focusInstructionLocalIndex,
                        snapshotEventIndex,
                        snapshotEventIdOverride,
                        snapshotInstructionEventIndex,
                        snapshotInstructionLocalIndex,
                        instructionOrderEventIndex,
                        instructionAuthoringRequest));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or InvalidOperationException or IOException)
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
                var written = await EmevdNativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, "event", new[]
                {
                    new Diagnostic("info", "EMEVD_STAGING_WRITE_VERIFIED", "EMEVD 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or InvalidOperationException or IOException)
            {
                return BridgeResult<object>.Failed(file, "event", "EMEVD_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-msb-document")
        {
            try
            {
                var document = MsbNativeDocument.ReadFile(file);
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
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-msb")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "map", "BRIDGE_OUTPUT_PATH_REQUIRED", "MSB writer requires a validated staging output path.");
            try
            {
                var written = await MsbNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "map", new[]
                {
                    new Diagnostic("info", "MSB_STAGING_WRITE_VERIFIED", "MSB 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
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

    private static int OptionalInt(JsonElement options, string field, int defaultValue)
    {
        if (options.ValueKind != JsonValueKind.Object || !options.TryGetProperty(field, out var value))
            return defaultValue;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var parsed))
            throw new InvalidDataException($"PARAM read options: {field} 必须是整数。");
        return parsed;
    }

    private static int? OptionalNullableInt(JsonElement options, string field)
    {
        if (options.ValueKind != JsonValueKind.Object || !options.TryGetProperty(field, out var value))
            return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var parsed))
            throw new InvalidDataException($"PARAM read options: {field} 必须是整数。");
        return parsed;
    }

    private static bool OptionalBool(JsonElement options, string field, bool defaultValue)
    {
        if (options.ValueKind != JsonValueKind.Object || !options.TryGetProperty(field, out var value))
            return defaultValue;
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException($"PARAM read options: {field} 必须是布尔值。");
        return value.GetBoolean();
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
}

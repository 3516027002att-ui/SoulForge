using System.Text;
using System.Text.RegularExpressions;

static class SemanticCandidateExports
{
    private const int MaxReadBytes = 4 * 1024 * 1024;
    private const int MaxCandidates = 300;

    public static BridgeResult<object>? TryExport(string sourcePath, string resourceKind, string? oodleRuntimeRoot = null)
    {
        return resourceKind switch
        {
            "event" => TryExportEvent(sourcePath, oodleRuntimeRoot),
            "map" => TryExportMap(sourcePath, oodleRuntimeRoot),
            "param" => TryExportParam(sourcePath, oodleRuntimeRoot),
            _ => null
        };
    }

    private static BridgeResult<object>? TryExportEvent(string sourcePath, string? oodleRuntimeRoot)
    {
        var sample = ReadPrefix(sourcePath);

        var synthetic = SyntheticFixtureExports.TryExport(sourcePath, "event");
        if (synthetic is not null) return synthetic;

        if (!IsPackedContainer(sample) && !StartsWith(sample, (byte)'E', (byte)'V', (byte)'D', 0)) return null;

        try
        {
            var payload = NativeLeafPayload.Resolve(sourcePath, oodleRuntimeRoot, ".emevd");
            if (!StartsWith(payload, (byte)'E', (byte)'V', (byte)'D', 0))
                return NativeUnsupported(sourcePath, "event", "Resolved payload is not a Sekiro EMEVD document.");

            var document = EmevdNativeDocument.Read(payload);
            var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
            var mapId = InferMapId(sourcePath);
            var events = new object[document.Events.Count];
            for (var eventIndex = 0; eventIndex < document.Events.Count; eventIndex++)
            {
                var ev = document.Events[eventIndex];
                if (ev.InstructionsOffset % EmevdNativeDocument.InstructionSize != 0)
                    throw new InvalidDataException($"EMEVD 事件 {ev.Id} 的指令偏移未对齐。");
                var instructionStart = checked((int)(ev.InstructionsOffset / EmevdNativeDocument.InstructionSize));
                var instructionCount = checked((int)ev.InstructionCount);
                if (instructionStart < 0 || instructionCount < 0
                    || instructionStart > document.Instructions.Count - instructionCount)
                    throw new InvalidDataException($"EMEVD 事件 {ev.Id} 的指令范围越界。");

                var eventUri = $"event://{mapId ?? "unknown"}/{ev.Id}";
                var instructions = new object[instructionCount];
                for (var instructionIndex = 0; instructionIndex < instructionCount; instructionIndex++)
                {
                    var instruction = document.Instructions[instructionStart + instructionIndex];
                    instructions[instructionIndex] = new
                    {
                        uri = $"{eventUri}/instruction/{instructionIndex}",
                        index = instructionIndex,
                        name = $"bank:{instruction.Bank} id:{instruction.Id}",
                        args = Array.Empty<object>(),
                        raw = new
                        {
                            parser = "sekiro-emevd-native-v1",
                            sourceHash = document.SourceHash,
                            bank = instruction.Bank,
                            id = instruction.Id,
                            argsLength = instruction.ArgsLength,
                            argsBase64 = Convert.ToBase64String(instruction.Args),
                            argsOffset = instruction.ArgsOffset,
                            layerOffset = instruction.LayerOffset,
                            confidence = "medium"
                        }
                    };
                }

                events[eventIndex] = new
                {
                    uri = eventUri,
                    sourceUri,
                    mapId,
                    eventId = ev.Id,
                    name = $"event_{ev.Id}",
                    sourceHash = document.SourceHash,
                    instructions,
                    raw = new
                    {
                        parser = "sekiro-emevd-native-v1",
                        eventIndex,
                        instructionCount = ev.InstructionCount,
                        instructionsOffset = ev.InstructionsOffset,
                        parameterCount = ev.ParameterCount,
                        parametersOffset = ev.ParametersOffset,
                        restBehavior = ev.RestBehavior,
                        confidence = "medium"
                    }
                };
            }

            return BridgeResult<object>.Partial(
                sourcePath,
                "event",
                new[]
                {
                    new Diagnostic(
                        "info",
                        "EMEVD_NATIVE_SEMANTIC_EXPORT",
                        "已由原生 EMEVD 文档解析器展开事件表和指令表；指令参数保留为未类型化原生布局元数据。",
                        sourceUri,
                        new { parser = "sekiro-emevd-native-v1", events = events.Length, instructions = document.Instructions.Count, sourceHash = document.SourceHash })
                },
                new { mapId, sourceHash = document.SourceHash, events });
        }
        catch (Exception ex) when (IsNativeReadException(ex))
        {
            return NativeFailed(sourcePath, "event", "EMEVD_NATIVE_EXPORT_FAILED", "原生 EMEVD 语义导出失败。", ex);
        }
    }

    private static BridgeResult<object>? TryExportParam(string sourcePath, string? oodleRuntimeRoot)
    {
        var sample = ReadPrefix(sourcePath);

        var synthetic = SyntheticFixtureExports.TryExport(sourcePath, "param");
        if (synthetic is not null) return synthetic;

        // 真实工作区的 gameparam 是 DCX+BND4；这一分支必须走完整 child 枚举，
        // 不能退回「扫几个 int32 当 row id」的候选输出。
        if (IsPackedContainer(sample)) return TryExportNativeParams(sourcePath, oodleRuntimeRoot);

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var paramName = InferParamName(sourcePath);
        if (!LooksLikeParam(sourcePath, sample)) return null;

        var ids = ScanInt32Candidates(sample)
            .Where(value => value >= 0 && value <= 2_000_000_000)
            .Distinct()
            .OrderBy(value => value)
            .Take(MaxCandidates)
            .ToArray();

        if (ids.Length == 0) return null;

        var rows = ids.Select((rowId, index) => new
        {
            uri = $"param://{paramName}/{rowId}",
            sourceUri,
            paramName,
            rowId,
            rowName = $"row_candidate_{rowId}",
            fields = Array.Empty<object>(),
            raw = new { parser = "param-row-id-candidate-scan", index, confidence = "low" }
        }).ToArray();

        return BridgeResult<object>.Partial(
            sourcePath,
            "param",
            new[]
            {
                new Diagnostic(
                    "info",
                    "PARAM_ROW_ID_CANDIDATES",
                    "Exported low-confidence PARAM row ID candidates. Fields and row layout are not parsed yet.",
                    sourceUri,
                    new { paramName, candidates = rows.Length, maxCandidates = MaxCandidates })
            },
            new { paramName, rows });
    }

    private static BridgeResult<object>? TryExportMap(string sourcePath, string? oodleRuntimeRoot)
    {
        var sample = ReadPrefix(sourcePath);

        var synthetic = SyntheticMapFixtureExports.TryExport(sourcePath);
        if (synthetic is not null) return synthetic;

        if (IsPackedContainer(sample) || StartsWith(sample, (byte)'M', (byte)'S', (byte)'B', (byte)' '))
        {
            try
            {
                var payload = NativeLeafPayload.Resolve(sourcePath, oodleRuntimeRoot, ".msb");
                if (!StartsWith(payload, (byte)'M', (byte)'S', (byte)'B', (byte)' '))
                    return NativeUnsupported(sourcePath, "map", "Resolved payload is not a Sekiro MSB document.");

                var document = MsbNativeDocument.Read(payload);
                var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
                var mapId = InferMapId(sourcePath) ?? Path.GetFileNameWithoutExtension(sourcePath).ToLowerInvariant();
                var partOccurrences = new Dictionary<string, int>(StringComparer.Ordinal);
                var regionOccurrences = new Dictionary<string, int>(StringComparer.Ordinal);
                var entities = new object[document.Parts.Count];
                for (var index = 0; index < document.Parts.Count; index++)
                {
                    var part = document.Parts[index];
                    var name = string.IsNullOrWhiteSpace(part.Name) ? $"part_{index}" : part.Name;
                    var uri = UniqueMapUri(mapId, "part", name, partOccurrences);
                    var modelName = part.ModelIndex >= 0 && part.ModelIndex < document.Models.Count
                        ? document.Models[part.ModelIndex].Name
                        : null;
                    entities[index] = new
                    {
                        uri,
                        sourceUri,
                        mapId,
                        entityId = part.EntityId,
                        name,
                        kind = GuessNativeMapEntityKind(part.TypeId, name),
                        model = modelName,
                        modelIndex = part.ModelIndex,
                        sourceHash = document.SourceHash,
                        position = new[] { part.PosX, part.PosY, part.PosZ },
                        rotation = new[] { part.RotX, part.RotY, part.RotZ },
                        scale = new[] { part.ScaleX, part.ScaleY, part.ScaleZ },
                        raw = new
                        {
                            parser = "sekiro-msb-native-v1",
                            family = "part",
                            partIndex = index,
                            nativeOffset = part.Offset,
                            typeId = part.TypeId,
                            modelIndex = part.ModelIndex,
                            confidence = "high"
                        }
                    };
                }

                var regions = new object[document.Regions.Count];
                for (var index = 0; index < document.Regions.Count; index++)
                {
                    var region = document.Regions[index];
                    var name = string.IsNullOrWhiteSpace(region.Name) ? $"region_{index}" : region.Name;
                    var uri = UniqueMapUri(mapId, "region", name, regionOccurrences);
                    regions[index] = new
                    {
                        uri,
                        sourceUri,
                        mapId,
                        entityId = region.EntityId,
                        name,
                        sourceHash = document.SourceHash,
                        position = new[] { region.PosX, region.PosY, region.PosZ },
                        rotation = new[] { region.RotX, region.RotY, region.RotZ },
                        raw = new
                        {
                            parser = "sekiro-msb-native-v1",
                            family = "region",
                            regionIndex = index,
                            nativeOffset = region.Offset,
                            typeId = region.TypeId,
                            scale = new[] { region.ScaleX, region.ScaleY, region.ScaleZ },
                            confidence = "high"
                        }
                    };
                }

                return BridgeResult<object>.Partial(
                    sourcePath,
                    "map",
                    new[]
                    {
                        new Diagnostic(
                            "info",
                            "MSB_NATIVE_SEMANTIC_EXPORT",
                            "已由原生 MSB 文档解析器展开完整 part/region 表、模型绑定和变换。",
                            sourceUri,
                            new { parser = "sekiro-msb-native-v1", mapId, parts = entities.Length, regions = regions.Length, models = document.Models.Count, sourceHash = document.SourceHash })
                    },
                    new { mapId, sourceHash = document.SourceHash, entities, regions });
            }
            catch (Exception ex) when (IsNativeReadException(ex))
            {
                return NativeFailed(sourcePath, "map", "MSB_NATIVE_EXPORT_FAILED", "原生 MSB 语义导出失败。", ex);
            }
        }

        var fallbackSourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var mapIdFallback = InferMapId(sourcePath) ?? Path.GetFileNameWithoutExtension(sourcePath).ToLowerInvariant();
        if (!LooksLikeMap(sourcePath, sample)) return null;

        var names = ExtractStrings(sample)
            .Where(value => LooksLikeMapSymbolName(value.Text))
            .GroupBy(value => value.Text)
            .Select(group => group.First())
            .Take(MaxCandidates)
            .ToArray();

        if (names.Length == 0) return null;

        var entitiesFallback = names.Select((name, index) => new
        {
            uri = $"map://{mapIdFallback}/entity/candidate_{index}",
            sourceUri = fallbackSourceUri,
            mapId = mapIdFallback,
            name = name.Text,
            kind = GuessMapEntityKind(name.Text),
            raw = new { parser = "msb-visible-name-candidate-scan", offset = name.Offset, encoding = name.Encoding, confidence = "low" }
        }).ToArray();

        return BridgeResult<object>.Partial(
            sourcePath,
            "map",
            new[]
            {
                new Diagnostic(
                    "info",
                    "MSB_ENTITY_NAME_CANDIDATES",
                    "Exported low-confidence map entity name candidates from visible strings. Entity tables, transforms, and regions are not parsed yet.",
                    fallbackSourceUri,
                    new { mapId = mapIdFallback, candidates = entitiesFallback.Length, maxCandidates = MaxCandidates })
            },
            new { mapId = mapIdFallback, entities = entitiesFallback, regions = Array.Empty<object>() });
    }

    private static BridgeResult<object> TryExportNativeParams(string sourcePath, string? oodleRuntimeRoot)
    {
        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        try
        {
            var leaves = NativeLeafPayload.ResolveAll(sourcePath, oodleRuntimeRoot, ".param");
            var projections = new List<NativeParamProjection>(leaves.Count);
            var diagnostics = new List<Diagnostic>();
            foreach (var leaf in leaves)
            {
                try
                {
                    var document = ParamNativeDocument.Read(leaf.Payload);
                    var paramName = string.IsNullOrWhiteSpace(document.TypeName)
                        ? NativeLeafBaseName(leaf.Name)
                        : document.TypeName;
                    var rowOccurrences = new Dictionary<int, int>();
                    var rows = new object[document.Rows.Count];
                    for (var rowIndex = 0; rowIndex < document.Rows.Count; rowIndex++)
                    {
                        var row = document.Rows[rowIndex];
                        rowOccurrences.TryGetValue(row.Id, out var occurrence);
                        rowOccurrences[row.Id] = occurrence + 1;
                        var rowUri = $"param://{paramName}/{row.Id}"
                            + (occurrence == 0 ? string.Empty : $"~{rowIndex}");
                        rows[rowIndex] = new
                        {
                            uri = rowUri,
                            sourceUri,
                            paramName,
                            rowId = row.Id,
                            rowName = row.Name,
                            sourceHash = document.SourceHash,
                            fields = Array.Empty<object>(),
                            raw = new
                            {
                                parser = "sekiro-param-native-v1",
                                entryIndex = leaf.Index,
                                entryName = NativeLeafBaseName(leaf.Name),
                                rowIndex,
                                nativeNameOffset = row.OriginalNameOffset,
                                nativeDataOffset = row.OriginalDataOffset,
                                dataLength = row.Data.Length,
                                dataHash = ParamNativeDocument.ComputeRowDataHash(row.Data),
                                confidence = "high"
                            }
                        };
                    }

                    projections.Add(new NativeParamProjection(
                        paramName,
                        document.SourceHash,
                        leaf.Index,
                        NativeLeafBaseName(leaf.Name),
                        rows));
                }
                catch (Exception ex) when (IsNativeReadException(ex))
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "PARAM_NATIVE_CHILD_SKIPPED",
                        "BND4 中的 PARAM 子项无法由原生解析器读取，已保留结构化诊断并继续其它子项。",
                        sourceUri,
                        new { entryIndex = leaf.Index, entryName = NativeLeafBaseName(leaf.Name), error = ex.Message }));
                }
            }

            if (projections.Count == 0)
                return NativeFailedWithDiagnostics(sourcePath, "param", "PARAM_NATIVE_EXPORT_FAILED", "没有可读取的原生 PARAM 子项。", diagnostics);

            var payload = projections.Select(item => new
            {
                paramName = item.ParamName,
                sourceHash = item.SourceHash,
                entryIndex = item.EntryIndex,
                entryName = item.EntryName,
                rows = item.Rows
            }).ToArray();
            var data = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["params"] = payload
            };
            // 保留单 PARAM 调用方的旧形状；多表结果通过 params[] 明确表达。
            if (projections.Count == 1)
            {
                var first = projections[0];
                data["paramName"] = first.ParamName;
                data["sourceHash"] = first.SourceHash;
                data["rows"] = first.Rows;
            }
            diagnostics.Insert(0, new Diagnostic(
                "info",
                "PARAM_NATIVE_SEMANTIC_EXPORT",
                "已由原生 PARAM 文档解析器展开 BND4 子项、行 ID、行名和原始行身份；字段值等待 Paramdef 投影。",
                sourceUri,
                new { parser = "sekiro-param-native-v1", paramsCount = projections.Count, rows = projections.Sum(item => item.Rows.Length) }));
            return BridgeResult<object>.Partial(sourcePath, "param", diagnostics, data);
        }
        catch (Exception ex) when (IsNativeReadException(ex))
        {
            return NativeFailed(sourcePath, "param", "PARAM_NATIVE_EXPORT_FAILED", "原生 PARAM 容器语义导出失败。", ex);
        }
    }

    private static string UniqueMapUri(string mapId, string family, string name, IDictionary<string, int> occurrences)
    {
        occurrences.TryGetValue(name, out var occurrence);
        occurrences[name] = occurrence + 1;
        var suffix = occurrence == 0 ? string.Empty : $"~{occurrence}";
        return $"map://{mapId}/{family}/{Uri.EscapeDataString(name)}{suffix}";
    }

    private static string GuessNativeMapEntityKind(int typeId, string name)
    {
        return typeId switch
        {
            0 => "mapPiece",
            1 or 9 or 10 => "object",
            2 or 4 or 11 => "character",
            5 => "collision",
            _ => GuessMapEntityKind(name)
        };
    }

    private static string NativeLeafBaseName(string value)
    {
        var normalized = value.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        return slash >= 0 ? normalized[(slash + 1)..] : normalized;
    }

    private static BridgeResult<object> NativeUnsupported(string sourcePath, string resourceKind, string message)
    {
        return new BridgeResult<object>(
            BridgeResult<object>.MakeSourceUri(sourcePath),
            sourcePath,
            BridgeResult<object>.GameUnknown,
            resourceKind,
            "unsupported",
            new[]
            {
                new Diagnostic(
                    "warning",
                    "SEMANTIC_EXPORT_NATIVE_FORMAT_UNSUPPORTED",
                    message,
                    BridgeResult<object>.MakeSourceUri(sourcePath))
            });
    }

    private static BridgeResult<object> NativeFailed(string sourcePath, string resourceKind, string code, string message, Exception ex)
    {
        return BridgeResult<object>.Failed(
            sourcePath,
            resourceKind,
            code,
            $"{message} {ex.Message}",
            new { parser = "native-semantic-export", exception = ex.GetType().Name });
    }

    private static BridgeResult<object> NativeFailedWithDiagnostics(
        string sourcePath,
        string resourceKind,
        string code,
        string message,
        IEnumerable<Diagnostic> diagnostics)
    {
        var all = new List<Diagnostic>
        {
            new("error", code, message, BridgeResult<object>.MakeSourceUri(sourcePath))
        };
        all.AddRange(diagnostics);
        return new BridgeResult<object>(
            BridgeResult<object>.MakeSourceUri(sourcePath),
            sourcePath,
            BridgeResult<object>.GameUnknown,
            resourceKind,
            "failed",
            all);
    }

    private static bool IsNativeReadException(Exception ex)
    {
        return ex is InvalidDataException
            or NotSupportedException
            or IOException
            or OverflowException
            or ArgumentOutOfRangeException;
    }

    private sealed record NativeParamProjection(
        string ParamName,
        string SourceHash,
        int EntryIndex,
        string EntryName,
        object[] Rows);

    private static bool LooksLikeParam(string sourcePath, byte[] sample)
    {
        var lower = sourcePath.ToLowerInvariant();
        if (lower.Contains("param")) return true;
        return StartsWith(sample, (byte)'P', (byte)'A', (byte)'R', (byte)'A');
    }

    private static bool LooksLikeMap(string sourcePath, byte[] sample)
    {
        var lower = sourcePath.ToLowerInvariant();
        if (lower.Contains(".msb") || Regex.IsMatch(lower, @"m\d{2}_\d{2}_\d{2}_\d{2}")) return true;
        return StartsWith(sample, (byte)'M', (byte)'S', (byte)'B', 0);
    }

    private static bool IsPackedContainer(byte[] sample)
    {
        return StartsWith(sample, (byte)'D', (byte)'C', (byte)'X', 0)
            || StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'3')
            || StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'4');
    }

    private static IEnumerable<int> ScanInt32Candidates(byte[] sample)
    {
        for (var offset = 0; offset + 4 <= sample.Length; offset += 4)
        {
            var little = sample[offset] | sample[offset + 1] << 8 | sample[offset + 2] << 16 | sample[offset + 3] << 24;
            if (little >= 0) yield return little;
        }
    }

    private static IEnumerable<TextRun> ExtractStrings(byte[] sample)
    {
        foreach (var item in ExtractAscii(sample, 3)) yield return item;
        foreach (var item in ExtractUtf16(sample, 3, littleEndian: true)) yield return item;
        foreach (var item in ExtractUtf16(sample, 3, littleEndian: false)) yield return item;
    }

    private static IEnumerable<TextRun> ExtractAscii(byte[] sample, int minChars)
    {
        var start = -1;
        var builder = new StringBuilder();
        for (var i = 0; i < sample.Length; i += 1)
        {
            var value = sample[i];
            if (value >= 32 && value <= 126)
            {
                if (start < 0) start = i;
                builder.Append((char)value);
                continue;
            }

            if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), "ascii");
            start = -1;
            builder.Clear();
        }
        if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), "ascii");
    }

    private static IEnumerable<TextRun> ExtractUtf16(byte[] sample, int minChars, bool littleEndian)
    {
        var start = -1;
        var builder = new StringBuilder();
        for (var i = 0; i + 1 < sample.Length; i += 2)
        {
            var code = littleEndian ? sample[i] | sample[i + 1] << 8 : sample[i] << 8 | sample[i + 1];
            var ch = (char)code;
            if (ch >= 32 && ch <= 126)
            {
                if (start < 0) start = i;
                builder.Append(ch);
                continue;
            }

            if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
            start = -1;
            builder.Clear();
        }
        if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
    }

    private static bool LooksLikeMapSymbolName(string value)
    {
        if (value.Length is < 3 or > 80) return false;
        var lower = value.ToLowerInvariant();
        return Regex.IsMatch(lower, @"^(c|o|m|aeg|h|s)\d{3,}")
            || lower.Contains("enemy")
            || lower.Contains("obj")
            || lower.Contains("region")
            || lower.Contains("collision")
            || lower.Contains("map_piece");
    }

    private static string GuessMapEntityKind(string value)
    {
        var lower = value.ToLowerInvariant();
        if (lower.StartsWith("c")) return "character";
        if (lower.StartsWith("o") || lower.Contains("obj")) return "object";
        if (lower.Contains("collision")) return "collision";
        if (lower.StartsWith("m") || lower.Contains("map_piece")) return "mapPiece";
        if (lower.StartsWith("aeg")) return "asset";
        return "unknown";
    }

    private static string? InferMapId(string sourcePath)
    {
        var match = Regex.Match(sourcePath.ToLowerInvariant(), @"m\d{2}_\d{2}_\d{2}_\d{2}");
        return match.Success ? match.Value : null;
    }

    private static string InferParamName(string sourcePath)
    {
        var name = Path.GetFileNameWithoutExtension(sourcePath);
        while (name.EndsWith(".dcx", StringComparison.OrdinalIgnoreCase)) name = Path.GetFileNameWithoutExtension(name);
        return string.IsNullOrWhiteSpace(name) ? "unknown_param" : name;
    }

    private static byte[] ReadPrefix(string sourcePath)
    {
        var info = new FileInfo(sourcePath);
        var count = (int)Math.Min(info.Length, MaxReadBytes);
        using var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var buffer = new byte[count];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer, total, buffer.Length - total);
            if (read == 0) break;
            total += read;
        }
        if (total == buffer.Length) return buffer;
        Array.Resize(ref buffer, total);
        return buffer;
    }

    private static bool StartsWith(byte[] sample, byte a, byte b, byte c, byte d)
    {
        return sample.Length >= 4 && sample[0] == a && sample[1] == b && sample[2] == c && sample[3] == d;
    }

    private sealed record TextRun(int Offset, string Text, string Encoding);
}

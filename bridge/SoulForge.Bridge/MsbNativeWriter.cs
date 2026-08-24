using System.Text.Json;

internal static class MsbNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        string? oodleRuntimeRoot,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        // 与 write-emevd 同一套：外层是 .dcx 时按 outer 写回 —— unwrap → mutate →
        // 原生重建 DCX（DFLT zlib / KRAK via Oodle）。TypeScript 侧永不压缩，
        // 也永不把解压后的临时路径当 Patch 目标。
        if (source.Length >= 4 && source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            return await WriteDcxOuterAsync(sourcePath, outputPath, oodleRuntimeRoot, options, cancellationToken);
        return await WriteRawAsync(sourcePath, outputPath, source, options, cancellationToken);
    }

    /// <summary>Raw .msb payload path（原行为）。</summary>
    private static async Task<object> WriteRawAsync(
        string sourcePath,
        string outputPath,
        byte[] source,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var document = MsbNativeDocument.Read(source);
        var patches = PreparePatches(document, options);
        cancellationToken.ThrowIfCancellationRequested();
        var rebuilt = document.ApplyMutations(patches);
        await AtomicWriteAsync(outputPath, rebuilt, cancellationToken);
        var reread = MsbNativeDocument.ReadFile(outputPath);
        VerifyMutations(reread, patches);
        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            modelCount = reread.Models.Count,
            partCount = reread.Parts.Count,
            regionCount = reread.Regions.Count,
            eventCount = reread.Events.Count,
            outputSize = reread.SourceBytes.Length,
            sourceFormat = "msb",
            rereadVerified = true
        };
    }

    /// <summary>
    /// Outer .dcx 路径：暂存产物是重建后的 DCX，外层文件哈希是 file_replace
    /// PatchIR 的 sealed 预期；payload 语义经原生 unwrap 重读验证。
    /// </summary>
    private static async Task<object> WriteDcxOuterAsync(
        string sourcePath,
        string outputPath,
        string? oodleRuntimeRoot,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        var document = MsbNativeDocument.Read(dcx.Payload);
        var patches = PreparePatches(document, options);
        cancellationToken.ThrowIfCancellationRequested();
        var rebuiltPayload = document.ApplyMutations(patches);
        byte[] rebuiltOuter;
        if (dcx.CompressionFormat == "DFLT")
        {
            rebuiltOuter = dcx.RebuildDflt(rebuiltPayload);
        }
        else if (dcx.CompressionFormat == "KRAK")
        {
            using var opened = OodleRuntimeLocator.Open(oodleRuntimeRoot, BridgeResult<object>.MakeSourceUri(sourcePath));
            if (opened.Session is null)
                throw new OodleRuntimeUnavailableException(
                    opened.Diagnostics.FirstOrDefault()?.Message ?? "Oodle 运行库不可用；无法重建 KRAK outer。");
            rebuiltOuter = dcx.RebuildKrak(rebuiltPayload, opened.Session);
        }
        else
        {
            throw new NotSupportedException($"DCX 压缩格式 {dcx.CompressionFormat} 尚不支持 outer 写回。");
        }
        await AtomicWriteAsync(outputPath, rebuiltOuter, cancellationToken);

        // 重新经原生 unwrap 打开暂存 outer 产物并逐条验证 mutation。
        var rereadDcx = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var reread = MsbNativeDocument.Read(rereadDcx.Payload);
        VerifyMutations(reread, patches);
        return new
        {
            mutationCount = patches.Count,
            // file_replace 的 sealed 预期 = 提交后的 .msb.dcx 外层字节。
            outputHash = rereadDcx.SourceHash,
            outerFileHash = rereadDcx.SourceHash,
            // payload 身份（Bridge read-msb-document 的 sourceHash 报告的是 payload）。
            payloadHash = reread.SourceHash,
            modelCount = reread.Models.Count,
            partCount = reread.Parts.Count,
            regionCount = reread.Regions.Count,
            eventCount = reread.Events.Count,
            outputSize = rereadDcx.SourceBytes.Length,
            sourceFormat = "dcx",
            rereadVerified = true
        };
    }

    /// <summary>哈希校验 + 解析 mutations + 唯一目标解析（两条路径共用）。</summary>
    private static List<MsbPatch> PreparePatches(MsbNativeDocument document, JsonElement options)
    {
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "MSB source hash");
        var patches = new List<MsbPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
                patches.Add(ParsePatch(item));
        }
        else
        {
            patches.Add(ParsePatch(options));
        }
        if (patches.Count == 0) throw new InvalidDataException("MSB writer 需要至少一条 mutation。");
        var reservedNewNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var patch in patches)
        {
            if (patch.Kind is "duplicate_part" or "create_part")
            {
                var templateMatches = document.Parts.Count(item => item.Name == patch.PartName);
                if (templateMatches != 1)
                    throw new InvalidDataException($"MSB part 模板必须唯一：{patch.PartName}; matches={templateMatches}。");
                if (string.IsNullOrWhiteSpace(patch.NewName) || patch.NewName == patch.PartName)
                    throw new InvalidDataException($"{patch.Kind} 需要与模板不同的非空 newName。");
                if (document.Parts.Any(item => item.Name == patch.NewName)
                    || document.Regions.Any(item => item.Name == patch.NewName)
                    || document.Events.Any(item => item.Name == patch.NewName)
                    || document.Models.Any(item => item.Name == patch.NewName))
                    throw new InvalidDataException($"MSB newName 已被占用：{patch.NewName}。");
                if (!reservedNewNames.Add(patch.NewName))
                    throw new InvalidDataException($"MSB 同一批 mutation 重复声明 newName：{patch.NewName}。");
                if (patch.ModelName is not null && !document.Models.Any(item => item.Name == patch.ModelName))
                    throw new InvalidDataException($"MSB model 不存在：{patch.ModelName}");
                if (patch.ModelIndex is not null && (patch.ModelIndex < 0 || patch.ModelIndex >= document.Models.Count))
                    throw new InvalidDataException($"MSB modelIndex 越界：{patch.ModelIndex}");
                continue;
            }
            var matches = patch.Kind switch
            {
                "set_region_position" or "set_region_transform" or "delete_region" => document.Regions.Count(item => item.Name == patch.PartName),
                "delete_event" => document.Events.Count(item => item.Name == patch.PartName),
                "delete_route" => document.Routes.Count(item => item.Name == patch.PartName),
                "set_property" or "set_entity_id" => document.Parts.Count(item => item.Name == patch.PartName)
                    + document.Regions.Count(item => item.Name == patch.PartName),
                _ => document.Parts.Count(item => item.Name == patch.PartName),
            };
            if (patch.Kind is "set_property" or "set_entity_id"
                && document.Events.Any(item => item.Name == patch.PartName))
            {
                throw new InvalidDataException(
                    $"MSB entityId 属性不支持 Event：{patch.PartName}；Event +0x08 是 eventId，不能按通用 entityId 写入。");
            }
            if (matches != 1)
                throw new InvalidDataException($"MSB mutation target must resolve uniquely: {patch.PartName}; matches={matches}.");
        }
        return patches;
    }

    private static void VerifyMutations(MsbNativeDocument reread, List<MsbPatch> patches)
    {
        foreach (var patch in patches)
        {
            if (patch.Kind is "delete_part" or "delete_region" or "delete_event" or "delete_route")
            {
                // 删除后重读必须确认目标已从对应家族消失。
                var stillPresent = patch.Kind switch
                {
                    "delete_part" => reread.Parts.Any(p => p.Name == patch.PartName),
                    "delete_region" => reread.Regions.Any(r => r.Name == patch.PartName),
                    "delete_event" => reread.Events.Any(e => e.Name == patch.PartName),
                    _ => reread.Routes.Any(route => route.Name == patch.PartName),
                };
                if (stillPresent)
                    throw new InvalidDataException($"MSB delete 后目标仍存在：{patch.PartName}。");
                continue;
            }

            if (patch.Kind == "set_region_position" || patch.Kind == "set_region_transform")
            {
                var region = reread.Regions.FirstOrDefault(r => r.Name == patch.PartName)
                    ?? throw new InvalidDataException($"MSB mutation 后找不到 region {patch.PartName}。");
                if (patch.PosX is not null && Math.Abs(region.PosX - patch.PosX.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region posX 未按预期更新。");
                if (patch.PosY is not null && Math.Abs(region.PosY - patch.PosY.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region posY 未按预期更新。");
                if (patch.PosZ is not null && Math.Abs(region.PosZ - patch.PosZ.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region posZ 未按预期更新。");
                if (patch.RotX is not null && Math.Abs(region.RotX - patch.RotX.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region rotX 未按预期更新。");
                if (patch.RotY is not null && Math.Abs(region.RotY - patch.RotY.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region rotY 未按预期更新。");
                if (patch.RotZ is not null && Math.Abs(region.RotZ - patch.RotZ.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region rotZ 未按预期更新。");
                if (patch.ScaleX is not null && Math.Abs(region.ScaleX - patch.ScaleX.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region scaleX 未按预期更新。");
                if (patch.ScaleY is not null && Math.Abs(region.ScaleY - patch.ScaleY.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region scaleY 未按预期更新。");
                if (patch.ScaleZ is not null && Math.Abs(region.ScaleZ - patch.ScaleZ.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region scaleZ 未按预期更新。");
                continue;
            }

            if (patch.Kind == "change_model" || patch.Kind == "set_part_model")
            {
                var partWithModel = reread.Parts.FirstOrDefault(p => p.Name == patch.PartName)
                    ?? throw new InvalidDataException($"MSB mutation 后找不到 part {patch.PartName}。");
                if (patch.ModelIndex is not null && partWithModel.ModelIndex != patch.ModelIndex.Value)
                    throw new InvalidDataException("MSB part modelIndex 未按预期更新。");
                continue;
            }

            if (patch.Kind is "duplicate_part" or "create_part")
            {
                var source = reread.Parts.FirstOrDefault(part => part.Name == patch.PartName)
                    ?? throw new InvalidDataException($"MSB template part 重读后缺失：{patch.PartName}。");
                var clone = reread.Parts.FirstOrDefault(part => part.Name == patch.NewName)
                    ?? throw new InvalidDataException($"MSB cloned part 重读后缺失：{patch.NewName}。");
                if (clone.TypeId != source.TypeId)
                    throw new InvalidDataException($"MSB cloned part subtype 不一致：{patch.NewName}。");
                VerifyClonedPart(reread, source, clone, patch);
                continue;
            }

            if (patch.Kind is "set_property" or "set_entity_id")
            {
                if (patch.EntityId is null)
                    throw new InvalidDataException("MSB set_property 缺少 entityId。");
                var partEntity = reread.Parts.FirstOrDefault(p => p.Name == patch.PartName);
                if (partEntity is not null)
                {
                    if (partEntity.EntityId != patch.EntityId.Value)
                        throw new InvalidDataException("MSB part entityId 未按预期更新。");
                    continue;
                }
                var regionEntity = reread.Regions.FirstOrDefault(r => r.Name == patch.PartName);
                if (regionEntity is not null)
                {
                    if (regionEntity.EntityId != patch.EntityId.Value)
                        throw new InvalidDataException("MSB region entityId 未按预期更新。");
                    continue;
                }
                if (reread.Events.Any(e => e.Name == patch.PartName))
                    throw new InvalidDataException(
                        $"MSB entityId 属性不支持 Event：{patch.PartName}；不能把 eventId 当作 entityId 验证。");
                throw new InvalidDataException($"MSB mutation 后找不到支持 entityId 的实体 {patch.PartName}。");
            }

            var part = reread.Parts.FirstOrDefault(p => p.Name == patch.PartName)
                ?? throw new InvalidDataException($"MSB mutation 后找不到 part {patch.PartName}。");
            if (patch.PosX is not null && Math.Abs(part.PosX - patch.PosX.Value) > 0.0001f)
                throw new InvalidDataException("MSB posX 未按预期更新。");
            if (patch.PosY is not null && Math.Abs(part.PosY - patch.PosY.Value) > 0.0001f)
                throw new InvalidDataException("MSB posY 未按预期更新。");
            if (patch.PosZ is not null && Math.Abs(part.PosZ - patch.PosZ.Value) > 0.0001f)
                throw new InvalidDataException("MSB posZ 未按预期更新。");
            if (patch.RotX is not null && Math.Abs(part.RotX - patch.RotX.Value) > 0.0001f)
                throw new InvalidDataException("MSB rotX 未按预期更新。");
            if (patch.RotY is not null && Math.Abs(part.RotY - patch.RotY.Value) > 0.0001f)
                throw new InvalidDataException("MSB rotY 未按预期更新。");
            if (patch.RotZ is not null && Math.Abs(part.RotZ - patch.RotZ.Value) > 0.0001f)
                throw new InvalidDataException("MSB rotZ 未按预期更新。");
            if (patch.ScaleX is not null && Math.Abs(part.ScaleX - patch.ScaleX.Value) > 0.0001f)
                throw new InvalidDataException("MSB scaleX 未按预期更新。");
            if (patch.ScaleY is not null && Math.Abs(part.ScaleY - patch.ScaleY.Value) > 0.0001f)
                throw new InvalidDataException("MSB scaleY 未按预期更新。");
            if (patch.ScaleZ is not null && Math.Abs(part.ScaleZ - patch.ScaleZ.Value) > 0.0001f)
                throw new InvalidDataException("MSB scaleZ 未按预期更新。");
        }
    }

    private static void VerifyClonedPart(
        MsbNativeDocument reread,
        MsbPart source,
        MsbPart clone,
        MsbPatch patch)
    {
        var expectedModelIndex = patch.ModelIndex
            ?? (patch.ModelName is not null
                ? reread.Models.FirstOrDefault(model => model.Name == patch.ModelName)?.Offset is int
                    ? reread.Models.ToList().FindIndex(model => model.Name == patch.ModelName)
                    : throw new InvalidDataException($"MSB cloned part model 重读后缺失：{patch.ModelName}")
                : source.ModelIndex);
        if (clone.ModelIndex != expectedModelIndex)
            throw new InvalidDataException($"MSB cloned part model 未按预期复制：{patch.NewName}。");
        if (clone.EntityId != (patch.EntityId ?? source.EntityId))
            throw new InvalidDataException($"MSB cloned part entityId 未按预期复制：{patch.NewName}。");

        var expected = new[]
        {
            patch.PosX ?? source.PosX,
            patch.PosY ?? source.PosY,
            patch.PosZ ?? source.PosZ,
            patch.RotX ?? source.RotX,
            patch.RotY ?? source.RotY,
            patch.RotZ ?? source.RotZ,
            patch.ScaleX ?? source.ScaleX,
            patch.ScaleY ?? source.ScaleY,
            patch.ScaleZ ?? source.ScaleZ
        };
        var actual = new[]
        {
            clone.PosX, clone.PosY, clone.PosZ,
            clone.RotX, clone.RotY, clone.RotZ,
            clone.ScaleX, clone.ScaleY, clone.ScaleZ
        };
        for (var i = 0; i < expected.Length; i++)
        {
            if (Math.Abs(expected[i] - actual[i]) > 0.0001f)
                throw new InvalidDataException($"MSB cloned part transform 未按预期复制：{patch.NewName}。");
        }
    }

    private static async Task AtomicWriteAsync(string outputPath, byte[] bytes, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static MsbPatch ParsePatch(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation")
            .Trim()
            .ToLowerInvariant();
        var partName = RequiredString(item, item.TryGetProperty("partName", out _) ? "partName" : "name");
        return new MsbPatch(
            kind,
            partName,
            OptionalFloat(item, "posX"),
            OptionalFloat(item, "posY"),
            OptionalFloat(item, "posZ"),
            OptionalFloat(item, "rotX"),
            OptionalFloat(item, "rotY"),
            OptionalFloat(item, "rotZ"),
            OptionalFloat(item, "scaleX"),
            OptionalFloat(item, "scaleY"),
            OptionalFloat(item, "scaleZ"),
            OptionalString(item, "modelName") ?? OptionalString(item, "newModelName"),
            OptionalInt(item, "modelIndex"),
            OptionalInt(item, "entityId"),
            OptionalString(item, "newName"));
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static string? OptionalString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString() : null;

    private static float? OptionalFloat(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetSingle() : null;

    private static int? OptionalInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32() : null;
}

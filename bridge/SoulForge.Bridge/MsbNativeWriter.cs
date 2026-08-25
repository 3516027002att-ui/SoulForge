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

    /// <summary>哈希校验 + 解析 mutations + native identity 目标解析（两条路径共用）。</summary>
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
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "set_region_position":
                case "set_region_transform":
                case "delete_region":
                    _ = document.ResolveRegion(patch);
                    break;
                case "delete_event":
                    _ = document.ResolveEvent(patch);
                    break;
                case "set_property":
                case "set_entity_id":
                    if (patch.Family == "part") _ = document.ResolvePart(patch);
                    else if (patch.Family == "region") _ = document.ResolveRegion(patch);
                    else throw new InvalidDataException($"MSB mutation family 不支持：{patch.Family}。");
                    break;
                default:
                    _ = document.ResolvePart(patch);
                    break;
            }
        }
        return patches;
    }

    private static void VerifyMutations(MsbNativeDocument reread, List<MsbPatch> patches)
    {
        // A transaction can intentionally touch one native identity more than
        // once (for example set_transform followed by batch_transform).  The
        // writer applies those patches in order; verification must compare the
        // final reread against the final transform for that identity, not an
        // intermediate state that no longer exists in the output.
        var lastTransformIndex = new Dictionary<(string Family, long NativeOffset), int>();
        for (var i = 0; i < patches.Count; i++)
        {
            var patch = patches[i];
            if (patch.Kind is "set_part_position" or "set_part_transform"
                or "set_region_position" or "set_region_transform")
                lastTransformIndex[(patch.Family, patch.NativeOffset)] = i;
        }

        for (var i = 0; i < patches.Count; i++)
        {
            var patch = patches[i];
            if ((patch.Kind is "set_part_position" or "set_part_transform"
                or "set_region_position" or "set_region_transform")
                && lastTransformIndex[(patch.Family, patch.NativeOffset)] != i)
                continue;
            if (patch.Kind is "delete_part" or "delete_region" or "delete_event")
            {
                // 删除后重读必须确认目标已从对应家族消失。
                var stillPresent = patch.Kind switch
                {
                    "delete_part" => reread.Parts.Any(p => p.Offset == patch.NativeOffset),
                    "delete_region" => reread.Regions.Any(r => r.Offset == patch.NativeOffset),
                    _ => reread.Events.Any(e => e.Offset == patch.NativeOffset),
                };
                if (stillPresent)
                    throw new InvalidDataException($"MSB delete 后目标仍存在：family={patch.Family} nativeOffset=0x{patch.NativeOffset:X}。");
                continue;
            }

            if (patch.Kind == "set_region_position" || patch.Kind == "set_region_transform")
            {
                var region = reread.ResolveRegion(patch);
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
                var partWithModel = reread.ResolvePart(patch);
                if (patch.ModelIndex is not null && partWithModel.ModelIndex != patch.ModelIndex.Value)
                    throw new InvalidDataException("MSB part modelIndex 未按预期更新。");
                if (patch.ModelName is not null)
                {
                    var model = partWithModel.ModelIndex >= 0 && partWithModel.ModelIndex < reread.Models.Count
                        ? reread.Models[partWithModel.ModelIndex]
                        : null;
                    if (model is null || !model.Name.Equals(patch.ModelName, StringComparison.Ordinal))
                        throw new InvalidDataException("MSB part modelName 未按预期更新。");
                }
                continue;
            }

            if (patch.Kind is "set_property" or "set_entity_id")
            {
                if (patch.EntityId is null) throw new InvalidDataException("MSB entityId mutation 缺少 entityId。");
                if (patch.Family == "part")
                {
                    var partWithEntityId = reread.ResolvePart(patch);
                    if (partWithEntityId.EntityId != patch.EntityId.Value)
                        throw new InvalidDataException("MSB part entityId 未按预期更新。");
                }
                else if (patch.Family == "region")
                {
                    var regionWithEntityId = reread.ResolveRegion(patch);
                    if (regionWithEntityId.EntityId != patch.EntityId.Value)
                        throw new InvalidDataException("MSB region entityId 未按预期更新。");
                }
                else
                {
                    throw new InvalidDataException($"MSB entityId mutation family 不支持：{patch.Family}。");
                }
                continue;
            }

            var part = reread.ResolvePart(patch);
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
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation").ToLowerInvariant();
        var family = RequiredString(item, "family").ToLowerInvariant();
        var nativeOffset = RequiredInt64(item, "nativeOffset");
        if (nativeOffset < 0) throw new InvalidDataException("options.nativeOffset 必须是非负整数。");
        return new MsbPatch(
            kind,
            family,
            nativeOffset,
            OptionalString(item, "expectedName"),
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
            OptionalInt(item, "entityId"));
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

    private static long RequiredInt64(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64() : throw new InvalidDataException($"options.{field} 是必填整数。");
}

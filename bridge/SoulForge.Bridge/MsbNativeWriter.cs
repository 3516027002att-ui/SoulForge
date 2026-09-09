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
        VerifyMutations(reread, patches, document);
        VerifyRawByteDiff(document.SourceBytes, reread.SourceBytes, patches, document);
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
        VerifyMutations(reread, patches, document);
        VerifyRawByteDiff(document.SourceBytes, reread.SourceBytes, patches, document);
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
        var rootCert = ParseCertificate(options);
        var patches = new List<MsbPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
                patches.Add(ParsePatch(item, rootCert));
        }
        else
        {
            patches.Add(ParsePatch(options, rootCert));
        }
        if (patches.Count == 0) throw new InvalidDataException("MSB writer 需要至少一条 mutation。");
        foreach (var patch in patches)
        {
            if (patch.Kind is "delete_part" or "delete_region" or "delete_event" or "delete")
            {
                if (patch.Certificate is null || !patch.Certificate.Complete)
                    throw new MsbSafetyGateException("MSB_REFERENCE_COVERAGE_INCOMPLETE", "MSB 结构删除引用闭包尚未完成，删除已被安全门禁拦截。");
            }
            if (patch.Kind is "set_entity_id" || (patch.Kind is "set_property" && patch.EntityId is not null))
            {
                if (patch.Family is not ("part" or "region"))
                    throw new MsbSafetyGateException("MSB_ENTITY_SCHEMA_UNVERIFIED", $"MSB EntityID schema 尚未通过 native 验证，写入已被安全门禁拦截：family={patch.Family}。");
                if (patch.EntityId is null)
                    throw new InvalidDataException("options.entityId 是必填整数。");
                _ = document.ResolveEntityIdAddress(patch);
            }
            if (patch.Family == "region" && (patch.ScaleX is not null || patch.ScaleY is not null || patch.ScaleZ is not null))
                throw new MsbSafetyGateException("MSB_REGION_SCALE_UNSUPPORTED", "MSB Region 不支持 scale 写入。");
            if (patch.Kind == "set_region_shape")
                throw new MsbSafetyGateException("SHAPE_OPERATION_UNSUPPORTED", "MSB Region shape 尺寸写回尚未开放，缺少独立布局验证。");

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

    private static void VerifyMutations(MsbNativeDocument reread, List<MsbPatch> patches, MsbNativeDocument? originalDoc = null)
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

        var lastEntityIdByTarget = new Dictionary<(string Family, long NativeOffset), int>();
        foreach (var patch in patches)
        {
            if ((patch.Kind is "set_property" or "set_entity_id") && patch.EntityId is not null)
            {
                lastEntityIdByTarget[(patch.Family, patch.NativeOffset)] = patch.EntityId.Value;
            }
        }

        foreach (var (key, expectedEntityId) in lastEntityIdByTarget)
        {
            if (key.Family == "part")
            {
                var rereadPart = reread.Parts.SingleOrDefault(p => p.Offset == key.NativeOffset)
                    ?? throw new InvalidDataException($"MSB part 0x{key.NativeOffset:X} 在重读时未找到。");
                if (rereadPart.EntityId != expectedEntityId)
                    throw new InvalidDataException($"MSB part entityId 未按预期更新：actual={rereadPart.EntityId} expected={expectedEntityId}。");
                if (originalDoc != null)
                {
                    var origPart = originalDoc.Parts.Single(p => p.Offset == key.NativeOffset);
                    if (rereadPart.InternalEntryId != origPart.InternalEntryId)
                        throw new InvalidDataException($"MSB part internalEntryId 被非法修改：orig={origPart.InternalEntryId} reread={rereadPart.InternalEntryId}。");
                }
            }
            else if (key.Family == "region")
            {
                var rereadRegion = reread.Regions.SingleOrDefault(r => r.Offset == key.NativeOffset)
                    ?? throw new InvalidDataException($"MSB region 0x{key.NativeOffset:X} 在重读时未找到。");
                if (rereadRegion.EntityId != expectedEntityId)
                    throw new InvalidDataException($"MSB region entityId 未按预期更新：actual={rereadRegion.EntityId} expected={expectedEntityId}。");
                if (originalDoc != null)
                {
                    var origRegion = originalDoc.Regions.Single(r => r.Offset == key.NativeOffset);
                    if (rereadRegion.InternalEntryId != origRegion.InternalEntryId)
                        throw new InvalidDataException($"MSB region internalEntryId 被非法修改：orig={origRegion.InternalEntryId} reread={rereadRegion.InternalEntryId}。");
                }
            }
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
                // Handled in lastEntityIdByTarget check above.
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

    private static void VerifyRawByteDiff(byte[] original, byte[] modified, List<MsbPatch> patches, MsbNativeDocument document)
    {
        if (original.Length != modified.Length)
            throw new InvalidDataException($"MSB raw mutation 文件大小发生变化：original={original.Length} modified={modified.Length}。");

        var allowedIndices = new HashSet<int>();
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "set_part_position":
                {
                    var part = document.ResolvePart(patch);
                    var baseOff = part.Offset + 0x20;
                    for (var i = 0; i < 12; i++) allowedIndices.Add(baseOff + i);
                    break;
                }
                case "set_part_transform":
                {
                    var part = document.ResolvePart(patch);
                    if (patch.PosX is not null || patch.PosY is not null || patch.PosZ is not null)
                    {
                        for (var i = 0; i < 12; i++) allowedIndices.Add(part.Offset + 0x20 + i);
                    }
                    if (patch.RotX is not null || patch.RotY is not null || patch.RotZ is not null)
                    {
                        for (var i = 0; i < 12; i++) allowedIndices.Add(part.Offset + 0x2C + i);
                    }
                    if (patch.ScaleX is not null || patch.ScaleY is not null || patch.ScaleZ is not null)
                    {
                        for (var i = 0; i < 12; i++) allowedIndices.Add(part.Offset + 0x38 + i);
                    }
                    break;
                }
                case "set_region_position":
                {
                    var region = document.ResolveRegion(patch);
                    for (var i = 0; i < 12; i++) allowedIndices.Add(region.Offset + 0x14 + i);
                    break;
                }
                case "set_region_transform":
                {
                    var region = document.ResolveRegion(patch);
                    if (patch.PosX is not null || patch.PosY is not null || patch.PosZ is not null)
                    {
                        for (var i = 0; i < 12; i++) allowedIndices.Add(region.Offset + 0x14 + i);
                    }
                    if (patch.RotX is not null || patch.RotY is not null || patch.RotZ is not null)
                    {
                        for (var i = 0; i < 12; i++) allowedIndices.Add(region.Offset + 0x20 + i);
                    }
                    break;
                }
                case "change_model":
                case "set_part_model":
                {
                    var part = document.ResolvePart(patch);
                    for (var i = 0; i < 4; i++) allowedIndices.Add(part.Offset + 0x10 + i);
                    break;
                }
                case "set_property":
                case "set_entity_id":
                {
                    var addr = document.ResolveEntityIdAddress(patch);
                    for (var i = 0; i < 4; i++) allowedIndices.Add(addr + i);
                    break;
                }
                case "delete_part":
                {
                    if (document.Params.TryGetValue("PARTS_PARAM_ST", out var p))
                    {
                        var start = (int)p.Offset;
                        var end = (int)(p.Offset + MsbNativeDocument.ParamHeaderSize + (p.EntryOffsets.Length + 1) * 8);
                        for (var i = start; i < end; i++) allowedIndices.Add(i);
                    }
                    break;
                }
                case "delete_region":
                {
                    if (document.Params.TryGetValue("POINT_PARAM_ST", out var p))
                    {
                        var start = (int)p.Offset;
                        var end = (int)(p.Offset + MsbNativeDocument.ParamHeaderSize + (p.EntryOffsets.Length + 1) * 8);
                        for (var i = start; i < end; i++) allowedIndices.Add(i);
                    }
                    break;
                }
                case "delete_event":
                {
                    if (document.Params.TryGetValue("EVENT_PARAM_ST", out var p))
                    {
                        var start = (int)p.Offset;
                        var end = (int)(p.Offset + MsbNativeDocument.ParamHeaderSize + (p.EntryOffsets.Length + 1) * 8);
                        for (var i = start; i < end; i++) allowedIndices.Add(i);
                    }
                    break;
                }
            }
        }

        for (var i = 0; i < original.Length; i++)
        {
            if (original[i] != modified[i] && !allowedIndices.Contains(i))
            {
                throw new InvalidDataException($"MSB raw mutation 出现越界或非预期的字节变动：offset=0x{i:X}。");
            }
        }

        foreach (var patch in patches)
        {
            if (patch.Family == "region")
            {
                var region = document.ResolveRegion(patch);
                if (!original.AsSpan((int)region.Offset + 0x30, 16).SequenceEqual(modified.AsSpan((int)region.Offset + 0x30, 16)))
                {
                    throw new InvalidDataException($"MSB Region 数据指针被意外破坏：offset=0x{region.Offset:X} (+0x30/+0x38)。");
                }
            }
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

    private static ReferenceCoverageCertificate? ParseCertificate(JsonElement item)
    {
        if (item.TryGetProperty("certificate", out var cElem) && cElem.ValueKind == JsonValueKind.Object)
        {
            bool complete = cElem.TryGetProperty("complete", out var comp) && comp.GetBoolean();
            string gameProfile = cElem.TryGetProperty("gameProfile", out var gp) ? gp.GetString() ?? "" : "";
            string readerSchemaHash = cElem.TryGetProperty("readerSchemaHash", out var rsh) ? rsh.GetString() ?? "" : "";
            string sourceHash = cElem.TryGetProperty("sourceHash", out var sh) ? sh.GetString() ?? "" : "";
            var unverifiedRefs = new List<int>();
            if (cElem.TryGetProperty("unverifiedReferences", out var urElem) && urElem.ValueKind == JsonValueKind.Array)
            {
                foreach (var u in urElem.EnumerateArray())
                    if (u.TryGetInt32(out var uv)) unverifiedRefs.Add(uv);
            }
            var coveredFamilies = new List<string>();
            if (cElem.TryGetProperty("coveredFamilies", out var cfElem) && cfElem.ValueKind == JsonValueKind.Array)
            {
                foreach (var cf in cfElem.EnumerateArray())
                {
                    var s = cf.GetString();
                    if (s is not null) coveredFamilies.Add(s);
                }
            }
            var notes = new List<string>();
            if (cElem.TryGetProperty("closureNotes", out var cnElem) && cnElem.ValueKind == JsonValueKind.Array)
            {
                foreach (var cn in cnElem.EnumerateArray())
                {
                    var s = cn.GetString();
                    if (s is not null) notes.Add(s);
                }
            }
            return new ReferenceCoverageCertificate(gameProfile, readerSchemaHash, sourceHash, unverifiedRefs.ToArray(), coveredFamilies.ToArray(), notes.ToArray(), complete);
        }
        return null;
    }

    private static MsbPatch ParsePatch(JsonElement item, ReferenceCoverageCertificate? defaultCert = null)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation").ToLowerInvariant();
        var family = RequiredString(item, "family").ToLowerInvariant();
        if (kind == "delete")
        {
            kind = family switch
            {
                "part" => "delete_part",
                "region" => "delete_region",
                "event" => "delete_event",
                _ => "delete"
            };
        }
        var nativeOffset = RequiredInt64(item, "nativeOffset");
        if (nativeOffset < 0) throw new InvalidDataException("options.nativeOffset 必须是非负整数。");

        var cert = ParseCertificate(item) ?? defaultCert;

        if (family == "region")
        {
            if (item.TryGetProperty("scaleX", out _) ||
                item.TryGetProperty("scaleY", out _) ||
                item.TryGetProperty("scaleZ", out _) ||
                item.TryGetProperty("scaleMultiplier", out _) ||
                item.TryGetProperty("scaleDelta", out _) ||
                item.TryGetProperty("scale", out _))
            {
                throw new MsbSafetyGateException("MSB_REGION_SCALE_UNSUPPORTED", "MSB Region 不支持 scale/scaleDelta/scaleMultiplier 字段。");
            }
        }
        if (kind is "delete_part" or "delete_region" or "delete_event" or "delete")
        {
            if (cert is null || !cert.Complete)
            {
                throw new MsbSafetyGateException("MSB_REFERENCE_COVERAGE_INCOMPLETE", "MSB 结构删除引用闭包尚未完成，删除已被安全门禁拦截。");
            }
        }
        if (kind is "set_region_shape")
        {
            throw new MsbSafetyGateException("SHAPE_OPERATION_UNSUPPORTED", "MSB Region shape 尺寸写回尚未开放，缺少独立布局验证。");
        }

        int? entityId = OptionalInt(item, "entityId")
            ?? (item.TryGetProperty("property", out var prop) && prop.GetString() == "entityId" ? OptionalInt(item, "value") : null)
            ?? (kind is "set_entity_id" ? OptionalInt(item, "value") : null);

        if (kind is "set_entity_id" || (kind is "set_property" && (item.TryGetProperty("entityId", out _) || (item.TryGetProperty("property", out var prop2) && prop2.GetString() == "entityId"))))
        {
            if (family is not ("part" or "region"))
            {
                throw new MsbSafetyGateException("MSB_ENTITY_SCHEMA_UNVERIFIED", "MSB EntityID schema 尚未通过 native 验证，写入已被安全门禁拦截。");
            }
            if (entityId is null)
            {
                throw new MsbSafetyGateException("MSB_MUTATION_OUT_OF_RANGE", "set_entity_id 需要提供有效的 32 位整数 entityId。");
            }
        }

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
            entityId,
            cert);
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
    {
        if (options.TryGetProperty(field, out var value))
        {
            if (value.ValueKind == JsonValueKind.Number)
            {
                if (value.TryGetInt32(out var intVal))
                    return intVal;
                throw new MsbSafetyGateException("MSB_MUTATION_OUT_OF_RANGE", $"options.{field} 必须在 32 位带符号整数范围内。");
            }
            throw new MsbSafetyGateException("MSB_MUTATION_OUT_OF_RANGE", $"options.{field} 必须是数值。");
        }
        return null;
    }

    private static long RequiredInt64(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64() : throw new InvalidDataException($"options.{field} 是必填整数。");
}

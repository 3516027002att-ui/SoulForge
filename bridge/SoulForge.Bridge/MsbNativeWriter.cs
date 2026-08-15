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
        // S19: 写目标是外层源资源。源是 .dcx 包装时，staged artifact 必须保持
        // 外层——unwrap → mutate payload → native 重建 DCX（DFLT zlib / KRAK
        // via Oodle），与 EmevdNativeWriter 同一套。TypeScript 侧不压缩，也
        // 不把解压临时路径当 Patch 目标。
        if (source.Length >= 4 && source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            return await WriteDcxOuterAsync(sourcePath, outputPath, oodleRuntimeRoot, options, cancellationToken);
        return await WriteRawAsync(sourcePath, outputPath, source, options, cancellationToken);
    }

    /// <summary>Raw .msb payload path（保持原行为）。</summary>
    private static async Task<object> WriteRawAsync(
        string sourcePath,
        string outputPath,
        byte[] source,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var document = MsbNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "MSB source hash");
        var patches = ParsePatches(options);
        if (patches.Count == 0) throw new InvalidDataException("MSB writer 需要至少一条 mutation。");
        ValidateTargets(document, patches);
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
    /// Outer .dcx path：staged artifact 是重建的 DCX，其外层文件哈希是
    /// file_replace PatchIR 的 sealed 期望值。payload 语义经 native unwrap
    /// 重读做 mutation verify。
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
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "MSB source hash");
        var patches = ParsePatches(options);
        if (patches.Count == 0) throw new InvalidDataException("MSB writer 需要至少一条 mutation。");
        ValidateTargets(document, patches);
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
                throw new InvalidOperationException(
                    opened.Diagnostics.FirstOrDefault()?.Message ?? "Oodle 运行库不可用；无法重建 KRAK outer。");
            rebuiltOuter = dcx.RebuildKrak(rebuiltPayload, opened.Session);
        }
        else
        {
            throw new NotSupportedException($"DCX 压缩格式 {dcx.CompressionFormat} 尚不支持 outer 写回。");
        }
        await AtomicWriteAsync(outputPath, rebuiltOuter, cancellationToken);

        // 重开 staged outer artifact，native 解压后验证每条 mutation。
        var rereadDcx = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var reread = MsbNativeDocument.Read(rereadDcx.Payload);
        VerifyMutations(reread, patches);
        return new
        {
            mutationCount = patches.Count,
            // file_replace 的 sealed 期望：提交的 .dcx 文件字节。
            outputHash = rereadDcx.SourceHash,
            outerFileHash = rereadDcx.SourceHash,
            // payload 身份（Bridge read-msb-document 报 sourceHash 的是 payload）。
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

    /// <summary>每条 mutation 的目标在源文档里必须唯一可解析。</summary>
    private static void ValidateTargets(MsbNativeDocument document, List<MsbPatch> patches)
    {
        foreach (var patch in patches)
        {
            var matches = patch.Kind switch
            {
                "set_region_position" or "delete_region" => document.Regions.Count(item => item.Name == patch.PartName),
                "delete_event" => document.Events.Count(item => item.Name == patch.PartName),
                _ => document.Parts.Count(item => item.Name == patch.PartName),
            };
            if (matches != 1)
                throw new InvalidDataException($"MSB mutation target must resolve uniquely: {patch.PartName}; matches={matches}.");
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

    private static void VerifyMutations(MsbNativeDocument reread, List<MsbPatch> patches)
    {
        foreach (var patch in patches)
        {
            if (patch.Kind is "delete_part" or "delete_region" or "delete_event")
            {
                // 删除后重读必须确认目标已从对应家族消失。
                var stillPresent = patch.Kind switch
                {
                    "delete_part" => reread.Parts.Any(p => p.Name == patch.PartName),
                    "delete_region" => reread.Regions.Any(r => r.Name == patch.PartName),
                    _ => reread.Events.Any(e => e.Name == patch.PartName),
                };
                if (stillPresent)
                    throw new InvalidDataException($"MSB delete 后目标仍存在：{patch.PartName}。");
                continue;
            }

            if (patch.Kind == "set_region_position")
            {
                var region = reread.Regions.FirstOrDefault(r => r.Name == patch.PartName)
                    ?? throw new InvalidDataException($"MSB mutation 后找不到 region {patch.PartName}。");
                if (patch.PosX is not null && Math.Abs(region.PosX - patch.PosX.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region posX 未按预期更新。");
                if (patch.PosY is not null && Math.Abs(region.PosY - patch.PosY.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region posY 未按预期更新。");
                if (patch.PosZ is not null && Math.Abs(region.PosZ - patch.PosZ.Value) > 0.0001f)
                    throw new InvalidDataException("MSB region posZ 未按预期更新。");
                continue;
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
            if (patch.ScaleX is not null && Math.Abs(part.ScaleX - patch.ScaleX.Value) > 0.0001f)
                throw new InvalidDataException("MSB scaleX 未按预期更新。");
            if (patch.ScaleY is not null && Math.Abs(part.ScaleY - patch.ScaleY.Value) > 0.0001f)
                throw new InvalidDataException("MSB scaleY 未按预期更新。");
            if (patch.ScaleZ is not null && Math.Abs(part.ScaleZ - patch.ScaleZ.Value) > 0.0001f)
                throw new InvalidDataException("MSB scaleZ 未按预期更新。");
        }
    }

    private static List<MsbPatch> ParsePatches(JsonElement options)
    {
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
        return patches;
    }

    private static MsbPatch ParsePatch(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation").ToLowerInvariant();
        var partName = RequiredString(item, "partName");
        return new MsbPatch(
            kind,
            partName,
            OptionalFloat(item, "posX"),
            OptionalFloat(item, "posY"),
            OptionalFloat(item, "posZ"),
            OptionalFloat(item, "rotX"),
            OptionalFloat(item, "scaleX"),
            OptionalFloat(item, "scaleY"),
            OptionalFloat(item, "scaleZ"));
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static float? OptionalFloat(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetSingle() : null;
}

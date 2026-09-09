using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;

internal static class FmgNativeWriter
{
    /// <summary>
    /// 写一个或多个 FMG mutation，按源资源的 storage profile 分派：
    ///
    /// · loose profile —— 源是裸 FMG v2 文件（marker 0x00020000），直接重建；
    /// · msgbnd/DCX profile —— options 带 `entryIndex` 时把源当作
    ///   DCX(BND4(…FMG child…)) 容器：只改 entryIndex 指向的那张 FMG 表，
    ///   其余 child 与容器结构原样保留（交给 Bnd4NativeWriter 的布局保持重建）。
    ///
    /// 两条路径都做三层写后验证：密封期望（hash 前置）→ 写盘 → 重读输出 → 目标
    /// mutation 生效 + 非目标 sibling 条目逐槽保留。失败全部 fail-closed：抛
    /// InvalidDataException/NotSupportedException，由调度器转成
    /// FMG_STAGING_WRITE_FAILED 结构化诊断，且不落盘半成品。
    ///
    /// 文本编码加固：FMG 用 UTF-16 空终止串，含 U+0000 或孤立代理项的文本无法
    /// 无损表示，写链在重建前拒绝（FMG_ENCODING_UNSUPPORTED），而不是让重读
    /// 验证打出误导性的「内容不匹配」。
    /// </summary>
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null)
    {
        if (options.TryGetProperty("tables", out var tablesElement) && tablesElement.ValueKind == JsonValueKind.Array)
        {
            return await WriteContainerMultiTableAsync(
                sourcePath, outputPath, options, tablesElement, cancellationToken, oodleRuntimeRoot);
        }

        var patches = ReadPatches(options);
        if (patches.Count == 0) throw new InvalidDataException("FMG writer 需要至少一条 mutation。");
        ValidateEncoding(patches);
        cancellationToken.ThrowIfCancellationRequested();

        if (TryGetEntryIndex(options, out var containerEntryIndex))
        {
            return await WriteContainerAsync(
                sourcePath, outputPath, options, patches, containerEntryIndex, cancellationToken, oodleRuntimeRoot);
        }

        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        return await WriteLooseAsync(source, outputPath, options, patches, cancellationToken);
    }

    // -----------------------------------------------------------------------
    // 写入
    // -----------------------------------------------------------------------

    private static async Task<object> WriteLooseAsync(
        byte[] source,
        string outputPath,
        JsonElement options,
        IReadOnlyList<FmgPatch> patches,
        CancellationToken cancellationToken)
    {
        var document = FmgNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "FMG source hash");
        var originalSlots = document.Entries.ToList();
        var disallowAmbiguous = options.TryGetProperty("disallowAmbiguous", out var da) && (da.ValueKind == JsonValueKind.True);
        var rebuilt = document.ApplyMutations(patches, disallowAmbiguous);
        await WriteOutput(outputPath, rebuilt, cancellationToken);
        var reread = Reopen(outputPath);
        VerifyMutations(reread, patches);
        VerifySiblingPreservation(originalSlots, reread, patches);
        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            entryCount = reread.Entries.Count,
            groupCount = reread.Groups.Count,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            storageProfile = "loose"
        };
    }

    /// <summary>
    /// msgbnd/DCX 容器写：密封期望是整容器 DCX hash（与 renderer 的 fmgSourceHash
    /// 一致），目标 child 由 entryIndex 定位。容器重建委托给 Bnd4NativeWriter（布局
    /// 保持重建 + 重压缩 + 容器级 reopen 验证），FMG 层验证在本方法内做。
    /// </summary>
    private static async Task<object> WriteContainerAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        IReadOnlyList<FmgPatch> patches,
        int entryIndex,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        var containerBefore = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        RequireHash(options, "expectedDocumentHash", containerBefore.SourceHash, "FMG msgbnd/DCX source hash");
        if (containerBefore.CompressionFormat is not ("DFLT" or "KRAK"))
            throw new NotSupportedException($"FMG 容器写不支持 {containerBefore.CompressionFormat} 外层压缩。");
        var binder = Bnd4NativeDocument.Read(containerBefore.Payload);
        if (entryIndex < 0 || entryIndex >= binder.Entries.Count)
            throw new InvalidDataException($"FMG 容器 entryIndex {entryIndex} 越界。");

        var childBytes = binder.GetStoredBytes(entryIndex);
        if (childBytes.Length < 0x28 || BinaryPrimitives.ReadInt32LittleEndian(childBytes.AsSpan(0, 4)) != 0x00020000)
            throw new NotSupportedException("FMG 容器目标 child 不是 FMG v2；写链拒绝。");
        var childDoc = FmgNativeDocument.Read(childBytes);
        var childBefore = childDoc.Entries.ToList();
        var disallowAmbiguous = options.TryGetProperty("disallowAmbiguous", out var da) && (da.ValueKind == JsonValueKind.True);
        var rebuiltChild = childDoc.ApplyMutations(patches, disallowAmbiguous);
        var childVerification = FmgNativeDocument.Read(rebuiltChild);
        VerifyMutations(childVerification, patches);
        VerifySiblingPreservation(childBefore, childVerification, patches);

        // 委托容器重建：replace 只动 entryIndex 那一个 child，其余 child 布局保持。
        var replaceOptions = JsonSerializer.SerializeToElement(new
        {
            mutation = "replace",
            entryIndex,
            expectedContainerHash = containerBefore.SourceHash,
            expectedChildHash = binder.Entries[entryIndex].ContentHash,
            contentBase64 = Convert.ToBase64String(rebuiltChild)
        });
        await Bnd4NativeWriter.WriteAsync(sourcePath, outputPath, replaceOptions, cancellationToken, oodleRuntimeRoot);

        // 容器级 reopen：输出重读 → 目标表验证 → sibling（其余 child）原样。
        var outDcx = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var outBinder = Bnd4NativeDocument.Read(outDcx.Payload);
        var outChildBytes = outBinder.GetStoredBytes(entryIndex);
        var outChild = FmgNativeDocument.Read(outChildBytes);
        VerifyMutations(outChild, patches);
        VerifySiblingPreservation(childBefore, outChild, patches);

        return new
        {
            mutationCount = patches.Count,
            outputHash = outDcx.SourceHash,
            entryCount = outChild.Entries.Count,
            groupCount = outChild.Groups.Count,
            outputSize = outDcx.SourceBytes.Length,
            rereadVerified = true,
            storageProfile = "msgbnd",
            containerEntryIndex = entryIndex,
            containerChildCount = outBinder.Entries.Count
        };
    }

    private static async Task<object> WriteContainerMultiTableAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        JsonElement tablesElement,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        var containerBefore = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        RequireHash(options, "expectedDocumentHash", containerBefore.SourceHash, "FMG msgbnd/DCX source hash");
        if (containerBefore.CompressionFormat is not ("DFLT" or "KRAK"))
            throw new NotSupportedException($"FMG 容器写不支持 {containerBefore.CompressionFormat} 外层压缩。");
        var binder = Bnd4NativeDocument.Read(containerBefore.Payload);

        var bnd4Mutations = new List<object>();
        var tableVerifications = new List<(int entryIndex, IReadOnlyList<FmgEntry> childBefore, IReadOnlyList<FmgPatch> patches)>();
        var totalMutationCount = 0;
        var disallowAmbiguous = options.TryGetProperty("disallowAmbiguous", out var da) && (da.ValueKind == JsonValueKind.True);

        foreach (var tableItem in tablesElement.EnumerateArray())
        {
            if (!TryGetEntryIndex(tableItem, out var entryIndex))
                throw new InvalidDataException("FMG 容器多表写每一项必须指定 entryIndex。");
            if (entryIndex < 0 || entryIndex >= binder.Entries.Count)
                throw new InvalidDataException($"FMG 容器目标 entryIndex {entryIndex} 越界。");

            var patches = ReadPatches(tableItem);
            ValidateEncoding(patches);
            totalMutationCount += patches.Count;

            var childBytes = binder.GetStoredBytes(entryIndex);
            if (childBytes.Length < 0x28 || BinaryPrimitives.ReadInt32LittleEndian(childBytes.AsSpan(0, 4)) != 0x00020000)
                throw new NotSupportedException($"FMG 容器目标 child (index {entryIndex}) 不是 FMG v2；写链拒绝。");

            var childDoc = FmgNativeDocument.Read(childBytes);
            var childBefore = childDoc.Entries.ToList();
            var rebuiltChild = childDoc.ApplyMutations(patches, disallowAmbiguous);
            var childVerification = FmgNativeDocument.Read(rebuiltChild);
            VerifyMutations(childVerification, patches);
            VerifySiblingPreservation(childBefore, childVerification, patches);

            bnd4Mutations.Add(new
            {
                mutation = "replace",
                entryIndex,
                expectedChildHash = binder.Entries[entryIndex].ContentHash,
                contentBase64 = Convert.ToBase64String(rebuiltChild)
            });
            tableVerifications.Add((entryIndex, childBefore, patches));
        }

        var replaceOptions = JsonSerializer.SerializeToElement(new
        {
            expectedContainerHash = containerBefore.SourceHash,
            mutations = bnd4Mutations
        });
        await Bnd4NativeWriter.WriteAsync(sourcePath, outputPath, replaceOptions, cancellationToken, oodleRuntimeRoot);

        // 容器级 reopen：输出重读 → 每一个目标表验证 → sibling（其余 child）原样
        var outDcx = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var outBinder = Bnd4NativeDocument.Read(outDcx.Payload);
        foreach (var (entryIndex, childBefore, patches) in tableVerifications)
        {
            var outChildBytes = outBinder.GetStoredBytes(entryIndex);
            var outChild = FmgNativeDocument.Read(outChildBytes);
            VerifyMutations(outChild, patches);
            VerifySiblingPreservation(childBefore, outChild, patches);
        }

        return new
        {
            mutationCount = totalMutationCount,
            tableCount = tableVerifications.Count,
            outputHash = outDcx.SourceHash,
            outputSize = outDcx.SourceBytes.Length,
            rereadVerified = true,
            storageProfile = "msgbnd",
            containerChildCount = outBinder.Entries.Count
        };
    }

    private static async Task WriteOutput(string outputPath, byte[] bytes, CancellationToken cancellationToken)
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

    // -----------------------------------------------------------------------
    // mutation 解析与前置校验
    // -----------------------------------------------------------------------

    private static IReadOnlyList<FmgPatch> ReadPatches(JsonElement options)
    {
        var patches = new List<FmgPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
            {
                var kind = RequiredString(item, "kind").ToLowerInvariant();
                var id = RequiredInt(item, "id");
                string? text = null;
                if (item.TryGetProperty("text", out var textElement))
                {
                    if (textElement.ValueKind == JsonValueKind.String)
                    {
                        try
                        {
                            text = textElement.GetString();
                        }
                        catch (InvalidOperationException ex)
                        {
                            throw new InvalidDataException($"FMG_ENCODING_UNSUPPORTED: 文本含孤立代理项（unpaired surrogate）: {ex.Message}");
                        }
                    }
                    else if (textElement.ValueKind == JsonValueKind.Null)
                        text = null;
                    else
                        throw new InvalidDataException("FMG patch text 必须是字符串或 null。");
                }
                int? slotIndex = null;
                if (item.TryGetProperty("slotIndex", out var slotEl) && slotEl.ValueKind == JsonValueKind.Number)
                    slotIndex = slotEl.GetInt32();
                patches.Add(new FmgPatch(kind, id, text, slotIndex));
            }
        }
        else
        {
            var kind = RequiredString(options, "mutation").ToLowerInvariant();
            var id = RequiredInt(options, "id");
            string? text = null;
            if (options.TryGetProperty("text", out var textElement))
            {
                if (textElement.ValueKind == JsonValueKind.String)
                {
                    try
                    {
                        text = textElement.GetString();
                    }
                    catch (InvalidOperationException ex)
                    {
                        throw new InvalidDataException($"FMG_ENCODING_UNSUPPORTED: 文本含孤立代理项（unpaired surrogate）: {ex.Message}");
                    }
                }
                else if (textElement.ValueKind == JsonValueKind.Null)
                    text = null;
                else
                    throw new InvalidDataException("FMG patch text 必须是字符串或 null。");
            }
            int? slotIndex = null;
            if (options.TryGetProperty("slotIndex", out var slotEl) && slotEl.ValueKind == JsonValueKind.Number)
                slotIndex = slotEl.GetInt32();
            patches.Add(new FmgPatch(kind, id, text, slotIndex));
        }
        return patches;
    }

    private static void ValidateEncoding(IReadOnlyList<FmgPatch> patches)
    {
        foreach (var patch in patches)
        {
            if (patch.Text is null) continue;
            if (patch.Text.IndexOf('\0') >= 0)
                throw new InvalidDataException("FMG_ENCODING_UNSUPPORTED: 文本包含 U+0000，无法以 FMG UTF-16 空终止串无损存储。");
            if (HasUnpairedSurrogate(patch.Text))
                throw new InvalidDataException("FMG_ENCODING_UNSUPPORTED: 文本含孤立代理项（unpaired surrogate），无法无损编码。");
        }
    }

    private static bool HasUnpairedSurrogate(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= text.Length || !char.IsLowSurrogate(text[i + 1])) return true;
                i++;
            }
            else if (char.IsLowSurrogate(c))
            {
                return true;
            }
        }
        return false;
    }

    private static bool TryGetEntryIndex(JsonElement options, out int entryIndex)
    {
        if (options.TryGetProperty("entryIndex", out var value) && value.ValueKind == JsonValueKind.Number)
        {
            entryIndex = value.GetInt32();
            return true;
        }
        entryIndex = 0;
        return false;
    }

    // -----------------------------------------------------------------------
    // 写后重读与验证
    // -----------------------------------------------------------------------

    private static FmgNativeDocument Reopen(string outputPath)
    {
        try
        {
            return FmgNativeDocument.ReadFile(outputPath);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
        {
            throw new InvalidDataException($"FMG_REOPEN_FAILED: 写出后重读失败：{ex.Message}");
        }
    }

    private static void VerifyMutations(FmgNativeDocument reread, IReadOnlyList<FmgPatch> patches)
    {
        // 同目标多次更新采用最后状态：按目标 (slotIndex or id) 聚合成有效最终状态
        var effectivePatches = new Dictionary<string, FmgPatch>();
        foreach (var patch in patches)
        {
            var key = patch.SlotIndex.HasValue ? $"slot:{patch.SlotIndex.Value}" : $"id:{patch.Id}";
            effectivePatches[key] = patch;
        }

        foreach (var patch in effectivePatches.Values)
        {
            if (patch.Kind is "delete")
            {
                if (patch.SlotIndex.HasValue)
                {
                    var targetSlot = patch.SlotIndex.Value;
                    if (targetSlot < reread.Entries.Count && reread.Entries[targetSlot].Id == patch.Id)
                        throw new InvalidDataException($"FMG delete 后 slotIndex {targetSlot} 处 ID {patch.Id} 仍存在。");
                }
                else
                {
                    var entry = reread.Entries.FirstOrDefault(e => e.Id == patch.Id);
                    if (entry is not null) throw new InvalidDataException($"FMG delete 后 ID {patch.Id} 仍存在。");
                }
            }
            else
            {
                FmgEntry? entry;
                if (patch.SlotIndex.HasValue)
                {
                    var targetSlot = patch.SlotIndex.Value;
                    if (targetSlot < 0 || targetSlot >= reread.Entries.Count)
                        throw new InvalidDataException($"FMG mutation 后 slotIndex {targetSlot} 越界。");
                    entry = reread.Entries[targetSlot];
                    if (entry.Id != patch.Id)
                        throw new InvalidDataException($"FMG mutation 后 slotIndex {targetSlot} 的 ID 为 {entry.Id}，与期望 {patch.Id} 不一致。");
                }
                else
                {
                    entry = reread.Entries.FirstOrDefault(e => e.Id == patch.Id);
                }

                if (entry is null)
                    throw new InvalidDataException($"FMG mutation 后 ID {patch.Id} 不存在。");
                if (entry.Text != patch.Text)
                    throw new InvalidDataException($"FMG mutation 后 ID {patch.Id} 内容不匹配（期望 '{(patch.Text is null ? "<null>" : patch.Text)}'，实际 '{(entry.Text is null ? "<null>" : entry.Text)}'）。");
            }
        }
    }

    /// <summary>
    /// sibling 保留：凡 id 不在任一 mutation 目标里的条目，重建后必须逐槽保留
    /// （id + text 完全一致）。这堵住「目标条目写对了、旁边条目被重建改坏」的
    /// 静默损坏——正是 roundtrip 无损与「未知字段变化阻止提交」在写链上的落点。
    /// </summary>
    private static void VerifySiblingPreservation(
        IReadOnlyList<FmgEntry> original,
        FmgNativeDocument reread,
        IReadOnlyList<FmgPatch> patches)
    {
        var targetedSlots = new HashSet<int>();
        var targetedIds = new HashSet<int>();
        foreach (var patch in patches)
        {
            if (patch.SlotIndex.HasValue)
                targetedSlots.Add(patch.SlotIndex.Value);
            else
                targetedIds.Add(patch.Id);
        }

        var expected = new Dictionary<(int Id, string? Text), int>();
        for (var i = 0; i < original.Count; i++)
        {
            var entry = original[i];
            if (targetedSlots.Contains(i) || targetedIds.Contains(entry.Id)) continue;
            var key = (entry.Id, entry.Text);
            expected[key] = expected.GetValueOrDefault(key) + 1;
        }

        foreach (var entry in reread.Entries)
        {
            if (targetedSlots.Contains(entry.StringIndex) || targetedIds.Contains(entry.Id)) continue;
            var key = (entry.Id, entry.Text);
            if (!expected.TryGetValue(key, out var count) || count == 0)
                throw new InvalidDataException("FMG_SIBLING_PRESERVATION_FAILED: 非目标条目被改变。");
            expected[key] = count - 1;
        }
        if (expected.Any(pair => pair.Value != 0))
            throw new InvalidDataException("FMG_SIBLING_PRESERVATION_FAILED: 非目标条目缺失。");
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        var expected = RequiredString(options, field);
        if (!expected.Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement element, string field)
        => element.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static int RequiredInt(JsonElement element, string field)
        => element.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32() : throw new InvalidDataException($"options.{field} 是必填整数。");
}

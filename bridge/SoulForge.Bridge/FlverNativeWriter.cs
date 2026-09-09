using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;

/// <summary>
/// FLVER2 材质槽写回（MODEL-51C）——字节补丁 writer，不做整文件重序列化。
///
/// 为什么必须是字节补丁而不是重建：FLVER 里存在本实现**未解析**的字段
/// （GX payload、已定义未实现的顶点语义等，见 FlverNativeDocument 的
/// unparsedGaps）。重序列化需要先「无损读出全部字段」才能「无损写回」，
/// 而未知字段读不出来，重建就必然丢数据——这违反硬约束「未知字段无法无损
/// 保留时不得开放 writer」。字节补丁只改 mesh 表里目标 entry 的
/// materialIndex 一个 int32，其余字节按构造逐字节保留，无损可写成立。
///
/// mesh 表布局（FlverNativeDocument 的解析顺序，偏移是权威依据）：
///   Header(0x80) → Dummies(64B×skeletonTransformCount) → Materials(32B×
///   materialCount) → Bones(128B×boneCount) → Meshes(48B×meshCount)。
///   mesh entry 的 materialIndex 在 +0x04。于是
///   meshTableBase = 0x80 + skeletonTransformCount×64 + materialCount×32
///                   + boneCount×128；
///   mesh[i].materialIndex 的绝对偏移 = meshTableBase + i×48 + 0x04。
///
/// 结构偏移可信度前置：layoutWarnings.Count &gt; 0 时**拒绝写**。布局警告意味着
/// 「读到的东西不对」（越界引用、未知 member 大小等），此时 section 表偏移
/// 不可信，补丁会落到错误字节。unparsedGaps **不阻止**：那是「有东西没读」
/// 的能力边界，不影响 mesh 表定位；而字节补丁恰恰是「没读全也能安全改」的
/// 写法的存在理由。
///
/// 写后验证三件套（与 FmgNativeWriter 同范式）：
///  ① VerifyMutations：reopen 后 mesh[i].MaterialIndex == 目标 —— 抓「补丁
///     落在错误偏移、值确实写进去但写错了地方」；
///  ② VerifySiblingPreservation：source 与 output 逐字节 diff，变化偏移集合
///     必须**恰好等于**目标偏移集合（既不能多改别处，目标偏移也不能漏改）；
///  ③ reopen 本身证明输出仍是可解析的合法 FLVER（输出由
///     FlverNativeDocument.ReadFile 重读成功）。
///
/// storage profile 两路：loose（裸 .flver）直接补丁；chrbnd/DCX（options 带
/// entryIndex）把源当 DCX(BND4(…FLVER child…)) 容器，只 replace 目标 child，
/// 其余 child 与容器结构原样保留（委托 Bnd4NativeWriter 的布局保持重建）。
/// 两条路径失败全部 fail-closed：抛 InvalidDataException/NotSupportedException，
/// 由调度器转成 FLVER_STAGING_WRITE_FAILED 结构化诊断，且不落盘半成品。
/// </summary>
internal static class FlverNativeWriter
{
    // mesh 表定位常量（与 FlverNativeDocument 的布局顺序一致，见类注释）。
    private const int HeaderSize = 0x80;
    private const int DummySize = 64;
    private const int MaterialSize = 32;
    private const int BoneSize = 128;
    private const int MeshSize = 48;
    private const int MaterialIndexOffsetWithinMesh = 0x04;

    /// <summary>FLVER mesh 只有一个材质槽；slotIndex 恒为 0。</summary>
    private const int SupportedSlotCount = 1;

    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null)
    {
        var patches = ReadPatches(options);
        if (patches.Count == 0) throw new InvalidDataException("FLVER writer 需要至少一条 material-slot-set mutation。");
        cancellationToken.ThrowIfCancellationRequested();

        if (TryGetEntryIndex(options, out var containerEntryIndex))
        {
            return await WriteContainerAsync(
                sourcePath, outputPath, options, patches, containerEntryIndex, cancellationToken, oodleRuntimeRoot);
        }

        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        return WriteLoose(source, outputPath, options, patches);
    }

    // -----------------------------------------------------------------------
    // 写入
    // -----------------------------------------------------------------------

    private static object WriteLoose(
        byte[] source,
        string outputPath,
        JsonElement options,
        IReadOnlyList<FlverMaterialSlotPatch> patches)
    {
        var document = FlverNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "FLVER source hash");
        RejectLayoutWarnings(document);
        var targetOffsets = ResolveTargetOffsets(document, patches);
        var rebuilt = ApplyPatches(source, targetOffsets, patches);
        WriteOutput(outputPath, rebuilt);
        var reread = Reopen(outputPath);
        VerifyMutations(reread, patches);
        VerifySiblingPreservation(source, rebuilt, targetOffsets);
        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            meshCount = reread.MeshCount,
            materialCount = reread.MaterialCount,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            storageProfile = "loose"
        };
    }

    /// <summary>
    /// chrbnd/DCX 容器写：密封期望是整容器 DCX hash（与 renderer 的
    /// expectedDocumentHash 一致），目标 child 由 entryIndex 定位。容器重建
    /// 委托给 Bnd4NativeWriter（布局保持重建 + 重压缩 + 容器级 reopen 验证），
    /// FLVER 层验证在本方法内做。
    /// </summary>
    private static async Task<object> WriteContainerAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        IReadOnlyList<FlverMaterialSlotPatch> patches,
        int entryIndex,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        var containerBefore = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        RequireHash(options, "expectedDocumentHash", containerBefore.SourceHash, "FLVER chrbnd/DCX source hash");
        if (containerBefore.CompressionFormat is not ("DFLT" or "KRAK"))
            throw new NotSupportedException($"FLVER 容器写不支持 {containerBefore.CompressionFormat} 外层压缩。");
        var binder = Bnd4NativeDocument.Read(containerBefore.Payload);
        if (entryIndex < 0 || entryIndex >= binder.Entries.Count)
            throw new InvalidDataException($"FLVER 容器 entryIndex {entryIndex} 越界。");

        var childBytes = binder.GetStoredBytes(entryIndex);
        var childDoc = FlverNativeDocument.Read(childBytes);
        RejectLayoutWarnings(childDoc);
        var targetOffsets = ResolveTargetOffsets(childDoc, patches);
        var rebuiltChild = ApplyPatches(childBytes, targetOffsets, patches);
        var childVerification = FlverNativeDocument.Read(rebuiltChild);
        VerifyMutations(childVerification, patches);
        VerifySiblingPreservation(childBytes, rebuiltChild, targetOffsets);

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

        // 容器级 reopen：输出重读 → 目标 mesh 验证 → sibling（容器里其余 child）原样。
        var outDcx = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var outBinder = Bnd4NativeDocument.Read(outDcx.Payload);
        var outChildBytes = outBinder.GetStoredBytes(entryIndex);
        var outChild = FlverNativeDocument.Read(outChildBytes);
        VerifyMutations(outChild, patches);
        VerifySiblingPreservation(childBytes, outChildBytes, targetOffsets);

        return new
        {
            mutationCount = patches.Count,
            outputHash = outDcx.SourceHash,
            meshCount = outChild.MeshCount,
            materialCount = outChild.MaterialCount,
            outputSize = outDcx.SourceBytes.Length,
            rereadVerified = true,
            storageProfile = "chrbnd",
            containerEntryIndex = entryIndex,
            containerChildCount = outBinder.Entries.Count
        };
    }

    private static void WriteOutput(string outputPath, byte[] bytes)
    {
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllBytes(temporary, bytes);
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

    private static IReadOnlyList<FlverMaterialSlotPatch> ReadPatches(JsonElement options)
    {
        var patches = new List<FlverMaterialSlotPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
                patches.Add(ReadSinglePatch(item));
        }
        else
        {
            patches.Add(ReadSinglePatch(options));
        }
        return patches;
    }

    /// <summary>解析单条 material-slot-set。stable ID 形态与 renderer 端一致：
    /// mesh 用 "mesh:N"、材质用 "material:N"。FLVER mesh 只有一个材质槽，slotIndex 必须为 0。</summary>
    private static FlverMaterialSlotPatch ReadSinglePatch(JsonElement element)
    {
        var kind = RequiredString(element, "kind").ToLowerInvariant();
        if (kind != "material-slot-set")
            throw new NotSupportedException($"FLVER writer 只支持 material-slot-set mutation，收到 {kind}。");
        var meshIndex = ParseStableId(RequiredString(element, "meshStableId"), "mesh");
        var slotIndex = RequiredInt(element, "slotIndex");
        if (slotIndex != 0)
            throw new NotSupportedException($"FLVER mesh 只有一个材质槽（slot 0），收到 slotIndex={slotIndex}。");
        var targetMaterialIndex = ParseStableId(RequiredString(element, "materialStableId"), "material");
        return new FlverMaterialSlotPatch(meshIndex, targetMaterialIndex);
    }

    private static int ParseStableId(string stableId, string prefix)
    {
        var prefixWithColon = prefix + ":";
        if (stableId.StartsWith(prefixWithColon, StringComparison.Ordinal)
            && int.TryParse(stableId[prefixWithColon.Length..], out var value))
        {
            return value;
        }
        throw new InvalidDataException($"FLVER stable ID \"{stableId}\" 不是 {prefix}:N 形态。");
    }

    /// <summary>
    /// 把 patches 解析成目标字节偏移，并做全部结构前置校验。
    /// mesh 表定位基于头部计数（SkeletonTransformCount/MaterialCount/BoneCount），
    /// 这正是 layoutWarnings 必须为空的原因——计数可信是偏移可信的前提。
    /// </summary>
    private static IReadOnlyList<int> ResolveTargetOffsets(FlverNativeDocument document, IReadOnlyList<FlverMaterialSlotPatch> patches)
    {
        if (patches.Count != patches.Select(p => p.MeshIndex).Distinct().Count())
            throw new InvalidDataException("FLVER_MUTATION_DUPLICATE_MESH: 同一 mesh 出现多条 mutation，写入目标不唯一。");

        var meshTableBase = HeaderSize
            + document.SkeletonTransformCount * DummySize
            + document.MaterialCount * MaterialSize
            + document.BoneCount * BoneSize;
        var offsets = new List<int>(patches.Count);
        foreach (var patch in patches)
        {
            if (patch.MeshIndex < 0 || patch.MeshIndex >= document.MeshCount)
                throw new InvalidDataException($"FLVER mesh 索引 {patch.MeshIndex} 越界（meshCount={document.MeshCount}）。");
            if (patch.TargetMaterialIndex < 0 || patch.TargetMaterialIndex >= document.MaterialCount)
                throw new InvalidDataException($"FLVER 目标材质 {patch.TargetMaterialIndex} 越界（materialCount={document.MaterialCount}）。");
            var current = document.Meshes[patch.MeshIndex].MaterialIndex;
            if (current == patch.TargetMaterialIndex)
                throw new InvalidDataException($"FLVER mesh[{patch.MeshIndex}] 已是材质 {patch.TargetMaterialIndex}，no-op mutation 拒绝。");
            offsets.Add(meshTableBase + patch.MeshIndex * MeshSize + MaterialIndexOffsetWithinMesh);
        }
        return offsets;
    }

    private static void RejectLayoutWarnings(FlverNativeDocument document)
    {
        if (document.LayoutWarnings.Count > 0)
            throw new InvalidDataException(
                $"FLVER_LAYOUT_WARNINGS_BLOCK_WRITE: 结构偏移不可信"
                + $"（{document.LayoutWarnings.Count} 条数据警告），拒绝写。"
                + " byte-patch 依赖 section 表偏移精确，布局可疑时补丁会落到错误字节。");
    }

    private static byte[] ApplyPatches(byte[] source, IReadOnlyList<int> targetOffsets, IReadOnlyList<FlverMaterialSlotPatch> patches)
    {
        var rebuilt = source.ToArray();
        for (var i = 0; i < patches.Count; i++)
        {
            var offset = targetOffsets[i];
            BinaryPrimitives.WriteInt32LittleEndian(rebuilt.AsSpan(offset, 4), patches[i].TargetMaterialIndex);
        }
        return rebuilt;
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

    private static FlverNativeDocument Reopen(string outputPath)
    {
        try
        {
            return FlverNativeDocument.ReadFile(outputPath);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
        {
            throw new InvalidDataException($"FLVER_REOPEN_FAILED: 写出后重读失败：{ex.Message}");
        }
    }

    /// <summary>重读后目标 mesh 的 materialIndex 必须等于目标值——抓「补丁落到错误偏移」。</summary>
    private static void VerifyMutations(FlverNativeDocument reread, IReadOnlyList<FlverMaterialSlotPatch> patches)
    {
        foreach (var patch in patches)
        {
            var mesh = reread.Meshes[patch.MeshIndex];
            if (mesh.MaterialIndex != patch.TargetMaterialIndex)
                throw new InvalidDataException(
                    $"FLVER mutation 后 mesh[{patch.MeshIndex}] materialIndex={mesh.MaterialIndex}"
                    + $" 与目标 {patch.TargetMaterialIndex} 不匹配。");
        }
    }

    /// <summary>
    /// sibling 保留：字节补丁后，source 与 output 的差异必须**恰好**是目标偏移
    /// 集合。这堵住两类静默损坏：目标写对了、旁边被多改（changed 里出现目标外
    /// 偏移），以及目标漏改（目标偏移没出现在 changed 里）。
    /// </summary>
    private static void VerifySiblingPreservation(byte[] source, byte[] rebuilt, IReadOnlyList<int> targetOffsets)
    {
        if (source.Length != rebuilt.Length)
            throw new InvalidDataException("FLVER_SIBLING_PRESERVATION_FAILED: 输出长度与源不一致（字节补丁不应改变长度）。");
        var changed = new List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] != rebuilt[i]) changed.Add(i);
        }
        var targetSet = new HashSet<int>(targetOffsets);
        var changedSet = new HashSet<int>(changed);
        if (!targetSet.SetEquals(changedSet))
        {
            var unexpected = changedSet.Except(targetSet).OrderBy(x => x).ToArray();
            var untouched = targetSet.Except(changedSet).OrderBy(x => x).ToArray();
            throw new InvalidDataException(
                "FLVER_SIBLING_PRESERVATION_FAILED: 字节补丁出现非目标改动。"
                + $" 目标偏移之外被改 {unexpected.Length} 个（前 8：{string.Join(",", unexpected.Take(8))}）；"
                + $" 目标偏移漏改 {untouched.Length} 个。");
        }
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

    /// <summary>一条 material-slot-set：把 mesh[<see cref="MeshIndex"/>] 的材质槽
    /// 换成 material[<see cref="TargetMaterialIndex"/>]。</summary>
    private sealed record FlverMaterialSlotPatch(int MeshIndex, int TargetMaterialIndex);
}

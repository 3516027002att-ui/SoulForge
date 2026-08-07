using System.Security.Cryptography;
using System.Text.Json;

internal static class Bnd4NativeWriter
{
    public static object SnapshotChild(string sourcePath, JsonElement options, string? oodleRuntimeRoot)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        if (dcx.CompressionFormat is not ("DFLT" or "KRAK"))
            throw new NotSupportedException($"BND4 snapshot 不支持 {dcx.CompressionFormat} 外层压缩。");
        var binder = Bnd4NativeDocument.Read(dcx.Payload);
        var index = ResolveEntryIndex(options, binder);
        var entry = binder.Entries[index];
        if (options.TryGetProperty("expectedChildHash", out var expectedHashElement)
            && expectedHashElement.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(expectedHashElement.GetString())
            && !entry.ContentHash.Equals(expectedHashElement.GetString(), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("BND4 child hash 不匹配。");
        }
        var bytes = binder.GetStoredBytes(index);
        return new
        {
            sourceHash = dcx.SourceHash,
            payloadHash = dcx.PayloadHash,
            index = entry.Index,
            flags = entry.Flags,
            unknown = entry.Unknown,
            id = entry.Id,
            name = entry.Name,
            duplicateOrdinal = entry.DuplicateOrdinal,
            contentHash = entry.ContentHash,
            contentBase64 = Convert.ToBase64String(bytes),
            compressedSize = entry.CompressedSize,
            uncompressedSize = entry.UncompressedSize
        };
    }

    public static async Task<object> WriteAsync(string sourcePath, string outputPath, JsonElement options, CancellationToken cancellationToken, string? oodleRuntimeRoot)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        if (dcx.CompressionFormat is not ("DFLT" or "KRAK"))
            throw new NotSupportedException($"BND4 writer 不支持 {dcx.CompressionFormat} 外层压缩。");
        RequireHash(options, "expectedContainerHash", dcx.SourceHash, "DCX source hash");
        var binder = Bnd4NativeDocument.Read(dcx.Payload);
        var entries = binder.ToRepackEntries().ToList();
        var affectedIndexes = new List<int>();
        var contentReplacedKeys = new HashSet<string>(StringComparer.Ordinal);
        var plan = ReadMutationPlan(options);
        foreach (var (mutation, step) in plan)
            ApplyMutation(mutation, step, entries, affectedIndexes, contentReplacedKeys);
        cancellationToken.ThrowIfCancellationRequested();
        var rebuiltBinder = binder.Repack(entries);
        byte[] rebuiltDcx;
        if (dcx.CompressionFormat == "KRAK")
        {
            var oodle = OodleRuntimeLocator.Open(oodleRuntimeRoot);
            if (oodle.Session == null || !oodle.Session.CanCompress)
                throw new NotSupportedException("KRAK 写回需要支持压缩的 Oodle 运行库。");
            using var session = oodle.Session;
            rebuiltDcx = dcx.RebuildKrak(rebuiltBinder, session);
        }
        else
        {
            rebuiltDcx = dcx.RebuildDflt(rebuiltBinder);
        }
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, rebuiltDcx, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        var reread = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var rereadBinder = Bnd4NativeDocument.Read(reread.Payload);
        if (reread.PayloadHash != Hash(rebuiltBinder) || rereadBinder.Entries.Count != entries.Count)
            throw new InvalidDataException("BND4 writer 输出重读验证失败。");
        var preservation = binder.ComparePreservation(rereadBinder, contentReplacedKeys);
        return new
        {
            mutations = plan.Select(step => step.Mutation).ToArray(),
            affectedIndex = affectedIndexes.Count == 1 ? (object)affectedIndexes[0] : null,
            affectedIndexes = affectedIndexes.ToArray(),
            outputHash = reread.SourceHash,
            payloadHash = reread.PayloadHash,
            entryCount = rereadBinder.Entries.Count,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            preservation,
            fieldPreservation = rereadBinder.VerifyFieldPreservation()
        };
    }

    private static IReadOnlyList<(string Mutation, JsonElement Options)> ReadMutationPlan(JsonElement options)
    {
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            var plan = new List<(string, JsonElement)>();
            for (var i = 0; i < mutations.GetArrayLength(); i++)
            {
                var step = mutations[i];
                if (step.ValueKind != JsonValueKind.Object) throw new InvalidDataException($"BND4 mutations[{i}] 必须是对象。");
                plan.Add((RequiredString(step, "mutation").ToLowerInvariant(), step));
            }
            if (plan.Count == 0) throw new InvalidDataException("BND4 mutations 数组不能为空。");
            return plan;
        }
        return new[] { (RequiredString(options, "mutation").ToLowerInvariant(), options) };
    }

    private static void ApplyMutation(string mutation, JsonElement options, List<Bnd4RepackEntry> entries, List<int> affectedIndexes, HashSet<string> contentReplacedKeys)
    {
        switch (mutation)
        {
            case "replace":
            {
                var index = ResolveEntryIndex(options, entries);
                RequireHash(options, "expectedChildHash", Hash(entries[index].StoredBytes), "BND4 child hash");
                var replacement = RequiredBase64(options, "contentBase64");
                contentReplacedKeys.Add($"{entries[index].Id}:{entries[index].Name}");
                entries[index] = entries[index] with { StoredBytes = replacement, UncompressedSize = replacement.Length };
                affectedIndexes.Add(index);
                break;
            }
            case "delete":
            {
                var index = ResolveEntryIndex(options, entries);
                RequireHash(options, "expectedChildHash", Hash(entries[index].StoredBytes), "BND4 child hash");
                entries.RemoveAt(index);
                affectedIndexes.Add(index);
                break;
            }
            case "rename":
            {
                var index = ResolveEntryIndex(options, entries);
                RequireHash(options, "expectedChildHash", Hash(entries[index].StoredBytes), "BND4 child hash");
                entries[index] = entries[index] with { Name = RequiredString(options, "newName") };
                affectedIndexes.Add(index);
                break;
            }
            case "move":
            {
                var index = ResolveEntryIndex(options, entries);
                var toIndex = RequiredInt(options, "toIndex");
                if (toIndex < 0 || toIndex >= entries.Count) throw new InvalidDataException("BND4 move toIndex 越界。");
                var moving = entries[index]; entries.RemoveAt(index); entries.Insert(toIndex, moving);
                affectedIndexes.Add(index);
                break;
            }
            case "add":
            {
                var content = RequiredBase64(options, "contentBase64");
                entries.Add(new Bnd4RepackEntry(
                    options.TryGetProperty("flags", out var flags) ? flags.GetInt32() : 0x40,
                    options.TryGetProperty("unknown", out var unknown) ? unknown.GetInt32() : -1,
                    RequiredInt(options, "id"), RequiredString(options, "name"), content, content.Length));
                affectedIndexes.Add(entries.Count - 1);
                break;
            }
            default: throw new InvalidDataException($"未知 BND4 mutation：{mutation}。");
        }
    }

    private static int ResolveEntryIndex(JsonElement options, Bnd4NativeDocument binder)
        => ResolveEntryIndexCore(options, binder.Entries.Count, i => binder.Entries[i].Name);

    private static int ResolveEntryIndex(JsonElement options, IReadOnlyList<Bnd4RepackEntry> entries)
        => ResolveEntryIndexCore(options, entries.Count, i => entries[i].Name);

    private static int ResolveEntryIndexCore(JsonElement options, int count, Func<int, string> nameAt)
    {
        if (options.TryGetProperty("entryIndex", out var explicitIndex) && explicitIndex.ValueKind == JsonValueKind.Number)
        {
            var index = explicitIndex.GetInt32();
            if (index < 0 || index >= count) throw new InvalidDataException("BND4 entryIndex 越界。");
            return index;
        }
        var selector = RequiredString(options, "childPath").Replace('\\', '/');
        var matches = Enumerable.Range(0, count)
            .Where(i => nameAt(i).Replace('\\', '/').Equals(selector, StringComparison.OrdinalIgnoreCase)
                || nameAt(i).Replace('\\', '/').EndsWith('/' + selector, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (matches.Length != 1) throw new InvalidDataException($"BND4 childPath 必须唯一匹配，实际 {matches.Length} 项。");
        return matches[0];
    }
    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException($"{label} 不匹配。");
    }
    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");
    private static int RequiredInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt32() : throw new InvalidDataException($"options.{field} 是必填整数。");
    private static byte[] RequiredBase64(JsonElement options, string field)
    {
        try { return Convert.FromBase64String(RequiredString(options, field)); }
        catch (FormatException) { throw new InvalidDataException($"options.{field} 不是有效 Base64。"); }
    }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>
    /// Extract a BND4 child entry directly to a file on disk.
    /// Returns metadata only (no content in response frame), safe for large assets.
    ///
    /// outputPath 由调用方传入而不是从 options 自取：daemon 已对它做过
    /// writable-root 边界校验并规范化，writer 再从 options 取原始字符串会让等价
    /// 但不同形态的路径（..、符号链接、大小写）绕过那次校验。
    /// </summary>
    public static object ExtractChild(string sourcePath, string outputPath, JsonElement options, string? oodleRuntimeRoot)
    {
        if (string.IsNullOrWhiteSpace(outputPath))
        {
            throw new InvalidDataException("extract-bnd4-child 需要已校验的 outputPath。");
        }
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        var binder = Bnd4NativeDocument.Read(dcx.Payload);
        var index = ResolveEntryIndex(options, binder);
        var entry = binder.Entries[index];
        var bytes = binder.GetStoredBytes(index);
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        // temp + Move(overwrite) 与其余五个 writer 一致：直接 WriteAllBytes 在写入
        // 中途失败会留下截断的半个文件，而它看起来像一次成功的提取。
        var temporary = Path.Combine(directory, $".soulforge-extract-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllBytes(temporary, bytes);
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        return new
        {
            sourceHash = dcx.SourceHash,
            index = entry.Index,
            id = entry.Id,
            name = entry.Name,
            contentHash = entry.ContentHash,
            contentSize = bytes.Length,
            outputPath
        };
    }
}

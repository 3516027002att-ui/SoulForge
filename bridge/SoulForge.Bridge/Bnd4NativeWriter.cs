using System.Security.Cryptography;
using System.Text.Json;

internal static class Bnd4NativeWriter
{
    public static object SnapshotChild(string sourcePath, JsonElement options, string? oodleRuntimeRoot)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        if (dcx.CompressionFormat != "DFLT") throw new NotSupportedException("BND4 snapshot 当前只允许已验证的 DFLT 外层。");
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
        if (dcx.CompressionFormat != "DFLT") throw new NotSupportedException("BND4 writer 当前只允许已验证的 DFLT 外层。");
        RequireHash(options, "expectedContainerHash", dcx.SourceHash, "DCX source hash");
        var binder = Bnd4NativeDocument.Read(dcx.Payload);
        var entries = binder.ToRepackEntries().ToList();
        var mutation = RequiredString(options, "mutation").ToLowerInvariant();
        var affectedIndex = -1;
        switch (mutation)
        {
            case "replace":
                affectedIndex = ResolveEntryIndex(options, binder);
                RequireHash(options, "expectedChildHash", binder.Entries[affectedIndex].ContentHash, "BND4 child hash");
                var replacement = RequiredBase64(options, "contentBase64");
                entries[affectedIndex] = entries[affectedIndex] with { StoredBytes = replacement, UncompressedSize = replacement.Length };
                break;
            case "delete":
                affectedIndex = ResolveEntryIndex(options, binder);
                RequireHash(options, "expectedChildHash", binder.Entries[affectedIndex].ContentHash, "BND4 child hash");
                entries.RemoveAt(affectedIndex);
                break;
            case "rename":
                affectedIndex = ResolveEntryIndex(options, binder);
                RequireHash(options, "expectedChildHash", binder.Entries[affectedIndex].ContentHash, "BND4 child hash");
                entries[affectedIndex] = entries[affectedIndex] with { Name = RequiredString(options, "newName") };
                break;
            case "move":
                affectedIndex = ResolveEntryIndex(options, binder);
                var toIndex = RequiredInt(options, "toIndex");
                if (toIndex < 0 || toIndex >= entries.Count) throw new InvalidDataException("BND4 move toIndex 越界。");
                var moving = entries[affectedIndex]; entries.RemoveAt(affectedIndex); entries.Insert(toIndex, moving);
                break;
            case "add":
                var content = RequiredBase64(options, "contentBase64");
                entries.Add(new Bnd4RepackEntry(
                    options.TryGetProperty("flags", out var flags) ? flags.GetInt32() : 0x40,
                    options.TryGetProperty("unknown", out var unknown) ? unknown.GetInt32() : -1,
                    RequiredInt(options, "id"), RequiredString(options, "name"), content, content.Length));
                affectedIndex = entries.Count - 1;
                break;
            default: throw new InvalidDataException($"未知 BND4 mutation：{mutation}。");
        }
        cancellationToken.ThrowIfCancellationRequested();
        var rebuiltBinder = binder.Repack(entries);
        var rebuiltDcx = dcx.RebuildDflt(rebuiltBinder);
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
        return new { mutation, affectedIndex, outputHash = reread.SourceHash, payloadHash = reread.PayloadHash, entryCount = rereadBinder.Entries.Count, outputSize = reread.SourceBytes.Length, rereadVerified = true };
    }

    private static int ResolveEntryIndex(JsonElement options, Bnd4NativeDocument binder)
    {
        if (options.TryGetProperty("entryIndex", out var explicitIndex) && explicitIndex.ValueKind == JsonValueKind.Number)
        {
            var index = explicitIndex.GetInt32();
            if (index < 0 || index >= binder.Entries.Count) throw new InvalidDataException("BND4 entryIndex 越界。");
            return index;
        }
        var selector = RequiredString(options, "childPath").Replace('\\', '/');
        var matches = binder.Entries.Where(entry => entry.Name.Replace('\\', '/').Equals(selector, StringComparison.OrdinalIgnoreCase)
            || entry.Name.Replace('\\', '/').EndsWith('/' + selector, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length != 1) throw new InvalidDataException($"BND4 childPath 必须唯一匹配，实际 {matches.Length} 项。");
        return matches[0].Index;
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
}

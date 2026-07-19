using System.Security.Cryptography;
using System.Text.Json;

internal static class FmgNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        var document = FmgNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "FMG source hash");

        var patches = new List<FmgPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
            {
                var kind = RequiredString(item, "kind").ToLowerInvariant();
                var id = RequiredInt(item, "id");
                string? text = null;
                if (item.TryGetProperty("text", out var textElement) && textElement.ValueKind == JsonValueKind.String)
                    text = textElement.GetString();
                var stringIndex = OptionalInt(item, "stringIndex");
                var beforeStringIndex = OptionalInt(item, "beforeStringIndex");
                var beforeId = OptionalInt(item, "beforeId");
                patches.Add(new FmgPatch(kind, id, text, stringIndex, beforeStringIndex, beforeId));
            }
        }
        else
        {
            // Single-mutation shorthand.
            var kind = RequiredString(options, "mutation").ToLowerInvariant();
            var id = RequiredInt(options, "id");
            string? text = null;
            if (options.TryGetProperty("text", out var textElement) && textElement.ValueKind == JsonValueKind.String)
                text = textElement.GetString();
            var stringIndex = OptionalInt(options, "stringIndex");
            var beforeStringIndex = OptionalInt(options, "beforeStringIndex");
            var beforeId = OptionalInt(options, "beforeId");
            patches.Add(new FmgPatch(kind, id, text, stringIndex, beforeStringIndex, beforeId));
        }

        if (patches.Count == 0) throw new InvalidDataException("FMG writer 需要至少一条 mutation。");
        cancellationToken.ThrowIfCancellationRequested();
        var rebuilt = document.ApplyMutations(patches);
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, rebuilt, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        var reread = FmgNativeDocument.ReadFile(outputPath);
        if (reread.Entries.Count < 0) throw new InvalidDataException("FMG writer 输出重读失败。");
        // Verify each mutation effect against the pre-mutation document when possible.
        foreach (var patch in patches)
        {
            if (patch.Kind is "delete")
            {
                if (patch.StringIndex is int deleteIndex)
                {
                    if (deleteIndex < 0 || deleteIndex >= document.Entries.Count)
                        throw new InvalidDataException("FMG slot delete 校验缺少有效 stringIndex。");
                    if (reread.Entries.Count != document.Entries.Count - 1)
                        throw new InvalidDataException("FMG slot delete 后 entryCount 未减少 1。");
                    for (var i = 0; i < deleteIndex; i++)
                    {
                        if (reread.Entries[i].Id != document.Entries[i].Id
                            || reread.Entries[i].Text != document.Entries[i].Text)
                            throw new InvalidDataException($"FMG slot delete 破坏了前置槽位 {i}。");
                    }
                    for (var i = deleteIndex; i < reread.Entries.Count; i++)
                    {
                        if (reread.Entries[i].Id != document.Entries[i + 1].Id
                            || reread.Entries[i].Text != document.Entries[i + 1].Text)
                            throw new InvalidDataException($"FMG slot delete 后槽位 {i} 与预期不一致。");
                    }
                }
                else if (reread.Entries.Any(e => e.Id == patch.Id))
                {
                    throw new InvalidDataException($"FMG delete 后 ID {patch.Id} 仍存在。");
                }
                continue;
            }

            if (patch.Kind is "insert")
            {
                if (patch.StringIndex is not int insertIndex
                    || insertIndex < 0
                    || insertIndex > document.Entries.Count)
                    throw new InvalidDataException("FMG insert 校验需要有效 stringIndex。");
                if (reread.Entries.Count != document.Entries.Count + 1)
                    throw new InvalidDataException("FMG insert 后 entryCount 未增加 1。");
                if (insertIndex >= reread.Entries.Count
                    || reread.Entries[insertIndex].Id != patch.Id
                    || reread.Entries[insertIndex].Text != (patch.Text ?? string.Empty))
                    throw new InvalidDataException($"FMG insert 后 stringIndex {insertIndex} 内容不匹配。");
                continue;
            }

            if (patch.Kind is "reorder")
            {
                if (patch.StringIndex is not int sourceIndex
                    || sourceIndex < 0
                    || sourceIndex >= document.Entries.Count)
                    throw new InvalidDataException("FMG reorder 校验需要有效的源 stringIndex。");
                if (document.Entries[sourceIndex].Id != patch.Id)
                    throw new InvalidDataException("FMG reorder 校验的源 ID 不匹配。");
                if ((patch.BeforeStringIndex is null) != (patch.BeforeId is null))
                    throw new InvalidDataException("FMG reorder 校验的锚点身份不完整。");

                var expected = document.Entries
                    .Select(entry => new { entry.Id, entry.Text })
                    .ToList();
                int insertionIndex;
                if (patch.BeforeStringIndex is int beforeIndex
                    && patch.BeforeId is int beforeId)
                {
                    if (beforeIndex < 0 || beforeIndex >= expected.Count || beforeIndex == sourceIndex)
                        throw new InvalidDataException("FMG reorder 校验的锚点 stringIndex 无效。");
                    if (expected[beforeIndex].Id != beforeId)
                        throw new InvalidDataException("FMG reorder 校验的锚点 ID 不匹配。");
                    insertionIndex = beforeIndex - (sourceIndex < beforeIndex ? 1 : 0);
                }
                else
                {
                    insertionIndex = expected.Count - 1;
                }
                if (insertionIndex == sourceIndex)
                    throw new InvalidDataException("FMG reorder 校验拒绝空操作。");
                var moved = expected[sourceIndex];
                expected.RemoveAt(sourceIndex);
                expected.Insert(insertionIndex, moved);
                if (reread.Entries.Count != expected.Count)
                    throw new InvalidDataException("FMG reorder 后 entryCount 发生变化。");
                for (var i = 0; i < expected.Count; i++)
                {
                    if (reread.Entries[i].Id != expected[i].Id
                        || reread.Entries[i].Text != expected[i].Text)
                        throw new InvalidDataException($"FMG reorder 后槽位 {i} 与完整预期顺序不一致。");
                }
                continue;
            }

            var entry = patch.StringIndex is int stringIndex
                && stringIndex >= 0
                && stringIndex < reread.Entries.Count
                    ? reread.Entries[stringIndex]
                    : reread.Entries.FirstOrDefault(e => e.Id == patch.Id);
            if (entry is null
                || entry.Id != patch.Id
                || entry.Text != (patch.Text ?? string.Empty))
                throw new InvalidDataException($"FMG mutation 后 ID {patch.Id} 内容不匹配。");
        }

        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            entryCount = reread.Entries.Count,
            groupCount = reread.Groups.Count,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true
        };
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static int RequiredInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32() : throw new InvalidDataException($"options.{field} 是必填整数。");

    private static int? OptionalInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.ValueKind == JsonValueKind.Number
                ? value.GetInt32()
                : throw new InvalidDataException($"options.{field} 必须是整数。")
            : null;
}

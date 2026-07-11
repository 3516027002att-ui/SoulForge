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
                patches.Add(new FmgPatch(kind, id, text));
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
            patches.Add(new FmgPatch(kind, id, text));
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
        // Verify each mutation effect.
        foreach (var patch in patches)
        {
            var entry = reread.Entries.FirstOrDefault(e => e.Id == patch.Id);
            if (patch.Kind is "delete")
            {
                if (entry is not null) throw new InvalidDataException($"FMG delete 后 ID {patch.Id} 仍存在。");
            }
            else
            {
                if (entry is null || entry.Text != (patch.Text ?? string.Empty))
                    throw new InvalidDataException($"FMG mutation 后 ID {patch.Id} 内容不匹配。");
            }
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
}

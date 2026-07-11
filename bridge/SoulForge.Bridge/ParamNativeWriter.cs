using System.Text.Json;

internal static class ParamNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        var document = ParamNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "PARAM source hash");

        var patches = new List<ParamPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
            {
                patches.Add(ParsePatch(item));
            }
        }
        else
        {
            patches.Add(ParsePatch(options));
        }
        if (patches.Count == 0) throw new InvalidDataException("PARAM writer 需要至少一条 mutation。");
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

        var reread = ParamNativeDocument.ReadFile(outputPath);
        foreach (var patch in patches)
        {
            var row = reread.Rows.FirstOrDefault(r => r.Id == patch.Id);
            if (patch.Kind is "delete")
            {
                if (row is not null) throw new InvalidDataException($"PARAM delete 后 ID {patch.Id} 仍存在。");
            }
            else
            {
                if (row is null) throw new InvalidDataException($"PARAM mutation 后缺少 ID {patch.Id}。");
                if (patch.DataBase64 is not null)
                {
                    var expected = Convert.FromBase64String(patch.DataBase64);
                    if (!row.Data.AsSpan().SequenceEqual(expected))
                        throw new InvalidDataException($"PARAM mutation 后 ID {patch.Id} 数据不匹配。");
                }
            }
        }

        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            rowCount = reread.Rows.Count,
            typeName = reread.TypeName,
            rowDataSize = reread.RowDataSize,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true
        };
    }

    private static ParamPatch ParsePatch(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation").ToLowerInvariant();
        var id = RequiredInt(item, "id");
        string? data = null;
        if (item.TryGetProperty("dataBase64", out var dataElement) && dataElement.ValueKind == JsonValueKind.String)
            data = dataElement.GetString();
        string? name = null;
        if (item.TryGetProperty("name", out var nameElement) && nameElement.ValueKind == JsonValueKind.String)
            name = nameElement.GetString();
        return new ParamPatch(kind, id, data, name);
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

using System.Text.Json;

// 物理身份：rowIndex + expectedId + expectedDataHash 贯穿 DTO/Map/key，重复 ID 的 id-only 写入必须拒绝，页 DTO 携带 dataHash。
internal static class ParamNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        int? expectedRowDataSize = null;
        if (options.TryGetProperty("expectedRowDataSize", out var rowSizeElement)
            && rowSizeElement.ValueKind == JsonValueKind.Number)
            expectedRowDataSize = rowSizeElement.GetInt32();
        var document = ParamNativeDocument.Read(source, expectedRowDataSize);
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
        var plan = document.PlanMutations(patches);
        var rebuilt = plan.RebuiltBytes;
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

        var reread = ParamNativeDocument.ReadFile(outputPath, document.RowDataSize > 0 ? document.RowDataSize : null);
        ParamMutationPlan.VerifyFinalParamProjection(plan.ExpectedProjection, reread);

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
        
        var nameAction = ParamNameAction.Keep;
        string? name = null;
        if (item.TryGetProperty("name", out var nameElement))
        {
            if (nameElement.ValueKind == JsonValueKind.Null)
            {
                nameAction = ParamNameAction.Clear;
            }
            else if (nameElement.ValueKind == JsonValueKind.String)
            {
                nameAction = ParamNameAction.Set;
                name = nameElement.GetString();
            }
            else
            {
                throw new InvalidDataException("PARAM patch 'name' 属性必须是字符串或 null。");
            }
        }

        int? rowIndex = null;
        if (item.TryGetProperty("rowIndex", out var rowIndexElement)
            && rowIndexElement.ValueKind == JsonValueKind.Number)
            rowIndex = rowIndexElement.GetInt32();
        string? expectedDataHash = null;
        if (item.TryGetProperty("expectedDataHash", out var hashElement)
            && hashElement.ValueKind == JsonValueKind.String)
            expectedDataHash = hashElement.GetString();
        return new ParamPatch(kind, id, data, name, rowIndex, expectedDataHash, nameAction);
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
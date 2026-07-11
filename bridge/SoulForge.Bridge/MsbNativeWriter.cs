using System.Text.Json;

internal static class MsbNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        var document = MsbNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "MSB source hash");

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
        if (patches.Count == 0) throw new InvalidDataException("MSB writer 需要至少一条 mutation。");
        foreach (var patch in patches)
        {
            var matches = patch.Kind == "set_region_position"
                ? document.Regions.Count(item => item.Name == patch.PartName)
                : document.Parts.Count(item => item.Name == patch.PartName);
            if (matches != 1)
                throw new InvalidDataException($"MSB mutation target must resolve uniquely: {patch.PartName}; matches={matches}.");
        }
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

        var reread = MsbNativeDocument.ReadFile(outputPath);
        foreach (var patch in patches)
        {
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
        }

        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            modelCount = reread.Models.Count,
            partCount = reread.Parts.Count,
            regionCount = reread.Regions.Count,
            eventCount = reread.Events.Count,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true
        };
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

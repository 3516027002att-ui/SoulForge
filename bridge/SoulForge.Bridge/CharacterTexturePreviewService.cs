using System.IO;
using System.Text.RegularExpressions;

/// <summary>
/// 从 FLVER 的 material 表和伴生 TPF 包中解析材质级 albedo 预览。
/// FLVER 的 texture slot path 在 Sekiro 语料中经常为空，因此不能把整套模型
/// 盲目套到第一张纹理上：每个网格必须按自己的 material index 选择纹理。
/// </summary>
internal static class CharacterTexturePreviewService
{
    private const int PreviewMaxDimension = 256;

    // 这些是跨角色命名中稳定的语义族；它们只用于预览匹配，不是原生格式解析。
    private static readonly (string Canonical, string[] Aliases)[] SemanticAliases =
    {
        ("top", new[] { "top", "tops", "upper", "shirt", "jacket", "coat" }),
        ("bottom", new[] { "bottom", "bottoms", "lower", "pants", "trouser" }),
        ("cloth", new[] { "cloth", "komono", "kimono", "looser", "fabric", "obi" }),
        ("head", new[] { "head", "face", "hair", "kamen", "mask" }),
        // 手部纹理不是身体纹理；把 hand 从 body 族移出，否则 bd 的
        // material=body 会稳定地选中 FC_A_0000_Hand_a，表现为只有衣服、
        // 皮肤区域没有正确纹理。
        ("skin", new[] { "body", "skin", "naked" }),
        ("hand", new[] { "hand", "hands", "glove" }),
        ("armor", new[] { "armor", "armour", "metal" }),
        ("chain", new[] { "chain", "mail", "maille" }),
        ("rope", new[] { "rope", "cord", "string" }),
        ("weapon", new[] { "weapon", "wepon", "sword", "katana", "kunai" }),
        ("tiling", new[] { "tiling", "tile", "tess", "tilingset" }),
        ("fray", new[] { "fray", "frary" }),
        ("artificial", new[] { "artificial", "prosthetic", "prosthesis" }),
        ("stone", new[] { "stone", "rock" }),
        ("paint", new[] { "paint" }),
        ("court", new[] { "court" })
    };

    public static CharacterTexturePreview? Resolve(
        FlverNativeDocument flver,
        string flverEntryName,
        IReadOnlyList<NativeLeafEntry> textureLeaves) =>
        ResolveAll(flver, flverEntryName, textureLeaves).FirstOrDefault()?.Preview;

    public static IReadOnlyList<CharacterTexturePreviewBinding> ResolveAll(
        FlverNativeDocument flver,
        string flverEntryName,
        IReadOnlyList<NativeLeafEntry> textureLeaves)
    {
        if (textureLeaves.Count == 0 || flver.Materials.Count == 0)
            return Array.Empty<CharacterTexturePreviewBinding>();

        var modelStem = Path.GetFileNameWithoutExtension(
            flverEntryName.Replace('\\', Path.DirectorySeparatorChar));
        var candidates = ReadColorTextureCandidates(textureLeaves);
        if (candidates.Count == 0)
            return Array.Empty<CharacterTexturePreviewBinding>();

        // 同一 TPF 纹理可能被多个 material 使用；解码只做一次。
        var decoded = new Dictionary<string, CharacterTexturePreview?>(StringComparer.Ordinal);
        var bindings = new List<CharacterTexturePreviewBinding>();
        foreach (var material in flver.Materials)
        {
            var ranked = candidates
                .Select(candidate => new
                {
                    Candidate = candidate,
                    Score = ScoreMaterial(material, modelStem, candidate)
                })
                .Where(item => item.Score > 0)
                .OrderByDescending(item => item.Score)
                .ThenBy(item => item.Candidate.Order)
                .ThenBy(item => item.Candidate.LeafName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.Candidate.TextureIndex)
                .ToArray();

            foreach (var item in ranked)
            {
                var candidate = item.Candidate;
                var cacheKey = $"{candidate.LeafName}\0{candidate.TextureIndex}";
                if (!decoded.TryGetValue(cacheKey, out var preview))
                {
                    preview = TryDecode(candidate);
                    decoded[cacheKey] = preview;
                }
                if (preview is null) continue;
                bindings.Add(new CharacterTexturePreviewBinding(material.Index, preview));
                break;
            }
        }
        return bindings;
    }

    private static List<TextureCandidate> ReadColorTextureCandidates(
        IReadOnlyList<NativeLeafEntry> textureLeaves)
    {
        var candidates = new List<TextureCandidate>();
        for (var leafOrder = 0; leafOrder < textureLeaves.Count; leafOrder++)
        {
            var leaf = textureLeaves[leafOrder];
            try
            {
                // 每个 leaf 只解析一次 TPF，避免 material 数量放大 native 解析成本。
                var tpf = TpfNativeDocument.Read(leaf.Payload);
                for (var textureIndex = 0; textureIndex < tpf.Textures.Count; textureIndex++)
                {
                    var textureName = tpf.Textures[textureIndex].Name;
                    if (!IsAlbedoTexture(textureName)) continue;
                    candidates.Add(new TextureCandidate(
                        tpf,
                        textureIndex,
                        leaf.Name,
                        leafOrder,
                        textureName));
                }
            }
            catch (Exception ex) when (ex is InvalidDataException
                or NotSupportedException
                or ArgumentOutOfRangeException
                or IOException)
            {
                // 一个包不是 TPF 或含不支持纹理格式时，继续处理其它包；
                // 最终没有 binding 会由上层返回结构化的无纹理诊断。
            }
        }
        return candidates;
    }

    private static CharacterTexturePreview? TryDecode(TextureCandidate candidate)
    {
        try
        {
            var dds = candidate.Document.GetTextureData(candidate.TextureIndex);
            var (width, height, png, colorSpace) =
                DdsCodec.DecodeDdsToPngPreview(dds, PreviewMaxDimension);
            return new CharacterTexturePreview(
                candidate.LeafName,
                candidate.TextureName,
                width,
                height,
                $"data:image/png;base64,{Convert.ToBase64String(png)}",
                colorSpace.ToString());
        }
        catch (Exception ex) when (ex is InvalidDataException
            or NotSupportedException
            or ArgumentOutOfRangeException
            or IOException)
        {
            return null;
        }
    }

    private static int ScoreMaterial(
        FlverMaterialEntry material,
        string modelStem,
        TextureCandidate candidate)
    {
        var materialTokens = SemanticTokens(material.Name, modelStem);
        var mtdTokens = SemanticTokens(
            Path.GetFileNameWithoutExtension(material.MtdPath.Replace('\\', Path.DirectorySeparatorChar)),
            modelStem);
        var textureTokens = SemanticTokens(candidate.TextureName, modelStem);
        var score = 0;
        var matched = false;

        // MTD basename 是比显示名更可靠的语义来源。
        foreach (var token in mtdTokens)
        {
            if (!textureTokens.Contains(token)) continue;
            score += 72;
            matched = true;
        }
        foreach (var token in materialTokens)
        {
            if (!textureTokens.Contains(token)) continue;
            score += 46;
            matched = true;
        }

        // 同一语义族（如 Chainmail ↔ Chain_Maille、body ↔ skin）允许跨命名风格匹配。
        var aliasMatches = mtdTokens
            .Where(token => token.StartsWith("@", StringComparison.Ordinal))
            .Concat(materialTokens.Where(token => token.StartsWith("@", StringComparison.Ordinal)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count(textureTokens.Contains);
        if (aliasMatches > 0)
        {
            score += aliasMatches * 38;
            matched = true;
        }

        // model stem 只作为同包/同角色的轻微 tie-breaker，禁止它单独给整套 FLVER
        // 绑定一张衣服纹理。
        if (candidate.MatchesModel(modelStem) && matched) score += 16;
        if (HasAlbedoSuffix(candidate.TextureName)) score += 3;
        return matched ? score : 0;
    }

    private static HashSet<string> SemanticTokens(string value, string modelStem)
    {
        var tokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var normalized = value.Replace('\\', '/').ToLowerInvariant();
        var modelCompact = Compact(modelStem);
        foreach (Match match in Regex.Matches(normalized, "[a-z0-9]+"))
        {
            var token = RemoveTrailingDigits(match.Value);
            if (token.Length < 3 || token is "mat" or "material" or "tpf" or "dcx") continue;
            if (modelCompact.Length >= 3 && Compact(token) == modelCompact) continue;
            tokens.Add(token);
        }

        var compact = Compact(normalized);
        foreach (var (canonical, aliases) in SemanticAliases)
        {
            if (aliases.Any(alias => compact.Contains(alias, StringComparison.Ordinal)))
                tokens.Add($"@{canonical}");
        }
        return tokens;
    }

    private static string RemoveTrailingDigits(string value)
    {
        var end = value.Length;
        while (end > 0 && char.IsDigit(value[end - 1])) end--;
        return value[..end];
    }

    private static string Compact(string value) =>
        new(value.Where(char.IsLetterOrDigit).ToArray());

    private static bool IsAlbedoTexture(string name)
    {
        var lower = name.ToLowerInvariant();
        if (lower.Contains("normal", StringComparison.Ordinal)
            || lower.Contains("mask", StringComparison.Ordinal)
            || lower.Contains("rough", StringComparison.Ordinal)
            || lower.Contains("spec", StringComparison.Ordinal)
            || lower.Contains("reflect", StringComparison.Ordinal)
            || lower.Contains("height", StringComparison.Ordinal)
            || lower.Contains("metallic", StringComparison.Ordinal))
            return false;
        if (lower.EndsWith("_n", StringComparison.Ordinal)
            || lower.EndsWith("_m", StringComparison.Ordinal)
            || lower.EndsWith("_s", StringComparison.Ordinal)
            || lower.EndsWith("_r", StringComparison.Ordinal))
            return false;
        return HasAlbedoSuffix(lower);
    }

    private static bool HasAlbedoSuffix(string name) =>
        name.EndsWith("_a", StringComparison.OrdinalIgnoreCase)
        || name.EndsWith("_albedo", StringComparison.OrdinalIgnoreCase)
        || name.EndsWith("_diffuse", StringComparison.OrdinalIgnoreCase)
        || name.EndsWith("_color", StringComparison.OrdinalIgnoreCase);

    private sealed record TextureCandidate(
        TpfNativeDocument Document,
        int TextureIndex,
        string LeafName,
        int Order,
        string TextureName)
    {
        public bool MatchesModel(string modelStem)
        {
            var candidate = Compact(TextureName);
            var model = Compact(modelStem);
            return model.Length >= 3 && candidate.StartsWith(model, StringComparison.OrdinalIgnoreCase);
        }
    }
}

internal sealed record CharacterTexturePreviewBinding(
    int MaterialIndex,
    CharacterTexturePreview Preview);

internal sealed record CharacterTexturePreview(
    string PackageEntryName,
    string TextureName,
    int Width,
    int Height,
    string PreviewToken,
    string ColorSpace);

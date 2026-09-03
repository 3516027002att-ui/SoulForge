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
    private static readonly IReadOnlyList<string> EmptyTextureStems =
        Array.Empty<string>();

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
        IReadOnlyList<NativeLeafEntry> textureLeaves,
        string? gameRoot = null,
        IReadOnlyList<string>? materialRoots = null) =>
        ResolveAll(flver, flverEntryName, textureLeaves, gameRoot, materialRoots).FirstOrDefault()?.Preview;

    /// <summary>
    /// Resolve one explicitly named preview texture. This is intentionally
    /// exact basename matching: it is used only by an already verified
    /// compatibility assembly mapping, never by ordinary material fallback.
    /// </summary>
    public static CharacterTexturePreview? ResolveExact(
        IReadOnlyList<NativeLeafEntry> textureLeaves,
        string? textureName)
    {
        if (textureLeaves.Count == 0 || string.IsNullOrWhiteSpace(textureName)) return null;
        var target = TextureBasename(textureName);
        if (target.Length == 0) return null;
        foreach (var candidate in ReadColorTextureCandidates(textureLeaves))
        {
            if (!string.Equals(TextureBasename(candidate.TextureName), target, StringComparison.OrdinalIgnoreCase))
                continue;
            var preview = TryDecode(candidate);
            if (preview is not null) return preview;
        }
        return null;
    }

    public static IReadOnlyList<CharacterTexturePreviewBinding> ResolveAll(
        FlverNativeDocument flver,
        string flverEntryName,
        IReadOnlyList<NativeLeafEntry> textureLeaves,
        string? gameRoot = null,
        IReadOnlyList<string>? materialRoots = null)
    {
        if (textureLeaves.Count == 0 || flver.Materials.Count == 0)
            return Array.Empty<CharacterTexturePreviewBinding>();

        var modelStem = Path.GetFileNameWithoutExtension(
            flverEntryName.Replace('\\', Path.DirectorySeparatorChar));
        var candidates = ReadColorTextureCandidates(textureLeaves);
        if (candidates.Count == 0)
            return Array.Empty<CharacterTexturePreviewBinding>();

        // 原生 FLVER texture slot 是 material 到纹理的唯一直接关系。先用
        // slot 的真实 basename 精确绑定，只有没有命中时才退回语义 token；
        // 否则 body/cloth 等通用词会把整套角色稳定地套到一张衣服纹理上。
        var slotsByMaterial = flver.GetTextureSlots()
            .Where(slot => slot.MaterialIndex >= 0 && !string.IsNullOrWhiteSpace(slot.Path))
            .GroupBy(slot => slot.MaterialIndex)
            .ToDictionary(
                group => group.Key,
                group => GetAlbedoSlotPaths(group),
                EqualityComparer<int>.Default);

        // 角色 FLVER 也可能省略 texture slot Path。此时从真实 MTD4 的
        // AlbedoMap slot 读取精确虚拟路径，并把 basename 与 TPF texture
        // 名称做 exact 绑定；只有 MTD/slot 都没有可读身份时才保留下面的
        // 语义回退。这样不会再因为 material=body 把整套角色套成一件衣服。
        var nativeTextureStemsByMaterial = new Dictionary<int, IReadOnlyList<string>>();
        foreach (var material in flver.Materials)
        {
            // Keep the native order. MTD files often expose several albedo-like
            // layers (for example head damage, expression and skin variants), and
            // their order is meaningful once the primary shader slot is known.
            var stems = new List<string>();
            if (slotsByMaterial.TryGetValue(material.Index, out var slotStems))
            {
                foreach (var stem in slotStems)
                {
                    if (stem.Length > 0 && !stems.Contains(stem, StringComparer.OrdinalIgnoreCase))
                        stems.Add(stem);
                }
            }
            if (!string.IsNullOrWhiteSpace(gameRoot) && !string.IsNullOrWhiteSpace(material.MtdPath))
            {
                foreach (var path in NativeMtdTextureLocator.ResolveAlbedoTexturePaths(
                    material.MtdPath,
                    gameRoot,
                    materialRoots))
                {
                    var stem = NormalizeTextureStem(path);
                    if (stem.Length > 0 && !stems.Contains(stem, StringComparer.OrdinalIgnoreCase))
                        stems.Add(stem);
                }
            }
            nativeTextureStemsByMaterial[material.Index] = stems;
        }

        // 同一 TPF 纹理可能被多个 material 使用；解码只做一次。
        var decoded = new Dictionary<string, CharacterTexturePreview?>(StringComparer.Ordinal);
        var bindings = new List<CharacterTexturePreviewBinding>();
        foreach (var material in flver.Materials)
        {
            var ranked = candidates
                .Select(candidate => new
                {
                        Candidate = candidate,
                        Score = ScoreMaterial(
                            material,
                            modelStem,
                            candidate,
                            nativeTextureStemsByMaterial.TryGetValue(material.Index, out var textureStems)
                            ? textureStems
                            : EmptyTextureStems)
                })
                .Where(item => item.Score > 0)
                .OrderByDescending(item => item.Score)
                .ThenBy(item => item.Candidate.Order)
                .ThenBy(item => item.Candidate.LeafName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.Candidate.TextureIndex)
                .ToArray();

            var primaryItem = ranked.FirstOrDefault();
            if (primaryItem is null) continue;
            var primaryCandidate = primaryItem.Candidate;
            var primaryCacheKey = $"{primaryCandidate.LeafName}\0{primaryCandidate.TextureIndex}";
            if (!decoded.TryGetValue(primaryCacheKey, out var preview))
            {
                preview = TryDecode(primaryCandidate);
                decoded[primaryCacheKey] = preview;
            }
            if (preview is null) continue;

            // A second albedo is valid only when the native MTD lookup gave us
            // another exact slot identity. Do not turn a semantic tie-breaker
            // into an invented material layer.
            var nativeStems = nativeTextureStemsByMaterial.TryGetValue(material.Index, out var materialStems)
                ? materialStems
                : EmptyTextureStems;
            var secondaryItem = nativeStems.Count > 1
                ? ranked.FirstOrDefault(item =>
                    !ReferenceEquals(item.Candidate, primaryCandidate)
                    && FindNativeTextureIndex(
                        nativeStems,
                        NormalizeTextureStem(item.Candidate.TextureName)) > 0)
                : null;
            CharacterTexturePreview? albedo2 = null;
            CharacterTexturePreview? normal2 = null;
            if (secondaryItem is not null)
            {
                var secondaryCandidate = secondaryItem.Candidate;
                var secondaryCacheKey = $"{secondaryCandidate.LeafName}\0{secondaryCandidate.TextureIndex}";
                if (!decoded.TryGetValue(secondaryCacheKey, out albedo2))
                {
                    albedo2 = TryDecode(secondaryCandidate);
                    decoded[secondaryCacheKey] = albedo2;
                }
                if (albedo2 is not null)
                    normal2 = TryDecodeCompanion(secondaryCandidate, "n", "linear", decoded);
            }

            // Sekiro character TPFs keep non-color maps beside the albedo
            // using the same stem (`*_n` normal, `*_m` material mask). Resolve
            // them only from the exact selected albedo candidate and its own
            // TPF; never use a global first-match.
            var normal = TryDecodeCompanion(primaryCandidate, "n", "linear", decoded);
            var metalness = TryDecodeCompanion(primaryCandidate, "m", "linear", decoded);
            // Native Mask1 is a material colour-blend input in the mature
            // FLVER viewers, not a coverage/opacity map. Only keep it for
            // the two source-mapped material families whose native MTD
            // declares the same-TPF companion; the generic renderer must
            // not reinterpret it as alphaMap.
            var mask1 = UsesNativeBlendMask(material.MtdPath)
                ? TryDecodeCompanion(primaryCandidate, "1m", "linear", decoded)
                : null;
            bindings.Add(new CharacterTexturePreviewBinding(
                material.Index,
                preview with
                {
                    Normal = normal,
                    Metalness = metalness,
                    Mask1 = mask1,
                    Albedo2 = albedo2,
                    Normal2 = normal2,
                    DiffuseBlend = albedo2 is not null
                        ? ResolveDiffuseBlend(material.MtdPath)
                        : null,
                    AlphaMode = ResolvePreviewAlphaMode(material.MtdPath)
                }));
        }
        return bindings;
    }

    /// <summary>
    /// Preserve the alpha policy declared by the native shader family.
    ///
    /// The mature DSAnimStudio SDT config for Character_AMSN_[AO_SSS]_[Cs]
    /// sets EnableAlphas=false. Sekiro's FC_M_0200 HeadA_a consequently uses
    /// its RGBA payload as color data; treating that alpha as a cutout removes
    /// almost the entire face and leaves the eye/mouth cards floating on a
    /// black surface. Unknown MTD families stay conservative and remain
    /// cutout-rendered until their shader semantics are known.
    /// </summary>
    private static string ResolvePreviewAlphaMode(string? materialMtdPath)
    {
        var name = Path.GetFileNameWithoutExtension(
            (materialMtdPath ?? string.Empty).Replace('\\', Path.DirectorySeparatorChar));
        return name.Contains("_[AO_SSS]", StringComparison.OrdinalIgnoreCase)
            && !name.Contains("decal", StringComparison.OrdinalIgnoreCase)
            ? "opaque"
            : "cutout";
    }

    private static bool UsesNativeBlendMask(string? materialMtdPath)
    {
        var name = Path.GetFileNameWithoutExtension(
            (materialMtdPath ?? string.Empty).Replace('\\', Path.DirectorySeparatorChar));
        return name.Contains("CatEye", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith("_Mouth", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Mouth", StringComparison.OrdinalIgnoreCase);
    }

    private static CharacterTextureDiffuseBlend? ResolveDiffuseBlend(string? materialMtdPath)
    {
        var name = Path.GetFileNameWithoutExtension(
            (materialMtdPath ?? string.Empty).Replace('\\', Path.DirectorySeparatorChar));
        // These values come from the mature DSAnimStudio SDT configs for the
        // Character_AMSN_[AO_SSS] family: Albedo1 uses UV0, Albedo2 uses UV1,
        // undefined blend mask is 1, and diffuse blending is Multiply. The
        // [Cs] variant does not consume texture alpha; the base variant also
        // multiplies the blend amount by Albedo2 alpha.
        if (name.Contains("_[AO_SSS]_[Cs]", StringComparison.OrdinalIgnoreCase))
        {
            return new CharacterTextureDiffuseBlend("multiply", 1, 0, 1f, false, false);
        }
        if (name.EndsWith("_[AO_SSS]", StringComparison.OrdinalIgnoreCase))
        {
            return new CharacterTextureDiffuseBlend("multiply", 1, 0, 1f, false, true);
        }
        return null;
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
                    // 部分角色的专用头部包会带一个名为 dammy/dummy 的占位贴图。
                    // 它虽然使用 _a 后缀，却是空白纹理；不能让它遮蔽 common_body
                    // 中真正的角色脸部贴图。
                    if (!IsAlbedoTexture(textureName) || IsPlaceholderTexture(textureName))
                        continue;
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

    private static CharacterTexturePreview? TryDecodeCompanion(
        TextureCandidate albedo,
        string suffix,
        string colorSpaceOverride,
        IDictionary<string, CharacterTexturePreview?> decoded)
    {
        var companion = FindCompanion(albedo, suffix);
        if (companion is null) return null;
        var cacheKey = $"{companion.LeafName}\0{companion.TextureIndex}\0{colorSpaceOverride}";
        if (decoded.TryGetValue(cacheKey, out var preview)) return preview;
        preview = TryDecode(companion, colorSpaceOverride);
        decoded[cacheKey] = preview;
        return preview;
    }

    private static TextureCandidate? FindCompanion(TextureCandidate albedo, string suffix)
    {
        // NormalizeTextureStem intentionally compacts separators for semantic
        // scoring. Companion lookup is different: `_a`/`_n`/`_m` are an exact
        // filename convention, so preserve underscores and compare basenames.
        var stem = TextureBasename(albedo.TextureName);
        var baseStem = stem.EndsWith("_a", StringComparison.OrdinalIgnoreCase)
            ? stem[..^2]
            : stem;
        var target = $"{baseStem}_{suffix}";
        for (var index = 0; index < albedo.Document.Textures.Count; index++)
        {
            var name = albedo.Document.Textures[index].Name;
            if (!string.Equals(TextureBasename(name), target, StringComparison.OrdinalIgnoreCase))
                continue;
            return new TextureCandidate(albedo.Document, index, albedo.LeafName, albedo.Order, name);
        }
        return null;
    }

    private static string TextureBasename(string value)
    {
        var normalized = value.Trim().Replace('\\', '/');
        var basename = normalized.Split('/').LastOrDefault() ?? normalized;
        var stem = basename;
        for (var i = 0; i < 4; i++)
        {
            var extension = Path.GetExtension(stem);
            if (string.IsNullOrWhiteSpace(extension)
                || extension is not (".tif" or ".tga" or ".dds" or ".png" or ".tex" or ".tpf" or ".dcx"))
                break;
            stem = stem[..^extension.Length];
        }
        return stem;
    }

    private static CharacterTexturePreview? TryDecode(
        TextureCandidate candidate,
        string? colorSpaceOverride = null)
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
                colorSpaceOverride ?? colorSpace.ToString());
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
        TextureCandidate candidate,
        IReadOnlyList<string> nativeTextureStems)
    {
        var candidateStem = NormalizeTextureStem(candidate.TextureName);
        var nativeIndex = candidateStem.Length == 0
            ? -1
            : FindNativeTextureIndex(nativeTextureStems, candidateStem);
        if (nativeIndex >= 0)
        {
            // 这是 native slot 的 exact match，不是猜测。保留 native 顺序，
            // 让 MTD 声明的主 albedo 胜过 damage/expression 等辅助层。
            return 3000 - Math.Min(nativeIndex, 999)
                + (candidate.MatchesModel(modelStem) ? 16 : 0);
        }

        // Once the native FLVER/MTD has declared an albedo identity, a semantic
        // name match is not a safe fallback. It can bind a different atlas to a
        // mesh that happens to contain the word "head" (the concrete failure was
        // HD_M_9510's native `HD_M_9510_dammy_a` being replaced by
        // `FC_M_0000_head_a`). Keep the mesh untextured and let the caller report
        // the missing native asset instead of rendering a plausible but false
        // material.
        if (nativeTextureStems.Count > 0) return 0;

        var materialTokens = SemanticTokens(material.Name, modelStem);
        var mtdTokens = SemanticTokens(
            Path.GetFileNameWithoutExtension(material.MtdPath.Replace('\\', Path.DirectorySeparatorChar)),
            modelStem);
        var textureTokens = SemanticTokens(candidate.TextureName, modelStem);
        var score = 0;
        var matched = false;

        // Sekiro 的头部 FLVER 经常把 texture slot path 留空。此时原生的
        // `HD_` 模型身份仍然能确定材质角色；在公共包候选中，显式的 `head`
        // token 比 `hairface` 等派生/遮罩命名更接近真实脸部 albedo。这个分支
        // 只在头部模型上生效，不把任意第一张纹理当作全身贴图。
        if (IsHeadModel(modelStem))
        {
            if (textureTokens.Contains("head"))
            {
                score += 240;
                matched = true;
            }
            else if (textureTokens.Contains("@head"))
            {
                score += 120;
                matched = true;
            }
        }

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

    private static IReadOnlyList<string> GetAlbedoSlotPaths(
        IEnumerable<FlverTextureSlotEntry> slots)
    {
        var all = slots
            .Select(slot => NormalizeTextureStem(slot.Path))
            .Where(stem => stem.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var albedo = slots
            .Where(slot => IsLikelyAlbedoSlot(slot.Type, slot.Path))
            .Select(slot => NormalizeTextureStem(slot.Path))
            .Where(stem => stem.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return albedo.Length > 0 ? albedo : all;
    }

    private static int FindNativeTextureIndex(
        IReadOnlyList<string> nativeTextureStems,
        string candidateStem)
    {
        for (var index = 0; index < nativeTextureStems.Count; index++)
        {
            if (string.Equals(nativeTextureStems[index], candidateStem, StringComparison.OrdinalIgnoreCase))
                return index;
        }
        return -1;
    }

    private static bool IsLikelyAlbedoSlot(string type, string path)
    {
        var value = $"{type} {path}".ToLowerInvariant();
        if (value.Contains("normal") || value.Contains("bump") || value.Contains("spec")
            || value.Contains("rough") || value.Contains("mask")
            || value.Contains("metallic"))
            return false;
        return type.Contains("albedo", StringComparison.OrdinalIgnoreCase)
            || type.Contains("diffuse", StringComparison.OrdinalIgnoreCase)
            || type.Contains("basecolor", StringComparison.OrdinalIgnoreCase)
            || value.Contains("diffuse") || value.Contains("albedo") || value.Contains("basecolor")
            || path.EndsWith("_a.tif", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("_d.tif", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("_a.dds", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("_d.dds", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeTextureStem(string value)
    {
        var normalized = value.Trim().Replace('\\', '/');
        var basename = normalized.Split('/').LastOrDefault() ?? normalized;
        var stem = basename;
        for (var i = 0; i < 4; i++)
        {
            var extension = Path.GetExtension(stem);
            if (string.IsNullOrWhiteSpace(extension)
                || extension is not (".tif" or ".tga" or ".dds" or ".png" or ".tex" or ".tpf" or ".dcx"))
                break;
            stem = stem[..^extension.Length];
        }
        return Compact(stem);
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

    private static bool IsPlaceholderTexture(string name) =>
        name.Contains("dammy", StringComparison.OrdinalIgnoreCase)
        || name.Contains("dummy", StringComparison.OrdinalIgnoreCase)
        || name.Contains("placeholder", StringComparison.OrdinalIgnoreCase);

    private static bool IsHeadModel(string modelStem) =>
        modelStem.StartsWith("HD_", StringComparison.OrdinalIgnoreCase)
        || modelStem.StartsWith("HEAD_", StringComparison.OrdinalIgnoreCase);

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
    string ColorSpace,
    string AlphaMode = "cutout",
    CharacterTexturePreview? Normal = null,
    CharacterTexturePreview? Metalness = null,
    CharacterTexturePreview? Mask1 = null,
    CharacterTexturePreview? Albedo2 = null,
    CharacterTexturePreview? Normal2 = null,
    CharacterTextureDiffuseBlend? DiffuseBlend = null);

internal sealed record CharacterTextureDiffuseBlend(
    string Mode,
    int Albedo2UvIndex,
    int BlendMaskUvIndex,
    float UndefinedBlendMaskValue,
    bool EnableTextureAlpha,
    bool MultiplyBlendMaskByAlbedo2Alpha);

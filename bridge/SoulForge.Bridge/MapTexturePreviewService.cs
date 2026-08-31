using System.Text.RegularExpressions;

/// <summary>
/// 地图材质的只读预览解析：FLVER material name -> map/*.tpfbhd entry -> DCX -> TPF -> DDS。
///
/// FLVER2 的 texture slot 在 Sekiro 地图里经常没有真实路径，不能把 slot 的空 Path
/// 当成纹理缺失，更不能在 renderer 猜路径。这里由 Bridge 根据已解析的 material name
/// 和地图包目录做有界、大小写不敏感的查找，renderer 只接收 PNG data URI。
/// </summary>
internal static class MapTexturePreviewService
{
    private const int MaxTexturePackages = 64;
    private const int PreviewMaxDimension = 512;
    private const int PreviewCacheCapacity = 512;

    private static readonly object CacheGate = new();
    private static readonly Dictionary<string, CachedPackage> PackageCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, MapTexturePreviewResult> PreviewCache = new(StringComparer.OrdinalIgnoreCase);

    public static MapTexturePreviewResult Resolve(
        string mapbndPath,
        string materialName,
        string? oodleRuntimeRoot,
        string? texturePath = null)
    {
        return ResolveCore(
            mapbndPath,
            materialName,
            "",
            oodleRuntimeRoot,
            string.IsNullOrWhiteSpace(texturePath) ? Array.Empty<string>() : new[] { texturePath });
    }

    public static MapTexturePreviewResult ResolveMany(
        string mapbndPath,
        string materialName,
        string? materialMtdPath,
        string? oodleRuntimeRoot,
        IReadOnlyList<string>? texturePaths)
    {
        return ResolveCore(mapbndPath, materialName, materialMtdPath ?? "", oodleRuntimeRoot, texturePaths ?? Array.Empty<string>());
    }

    private static MapTexturePreviewResult ResolveCore(
        string mapbndPath,
        string materialName,
        string materialMtdPath,
        string? oodleRuntimeRoot,
        IReadOnlyList<string> texturePaths)
    {
        var normalizedTexturePaths = texturePaths
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => path.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (string.IsNullOrWhiteSpace(materialName) && normalizedTexturePaths.Length == 0)
            return MapTexturePreviewResult.Missing("MAP_TEXTURE_MATERIAL_NAME_EMPTY", "FLVER mesh 没有可用于纹理查找的 material name 或 texture slot path。");

        var textureRoots = ResolveTextureRoots(mapbndPath, oodleRuntimeRoot);
        if (textureRoots.Count == 0)
            return MapTexturePreviewResult.Missing("MAP_TEXTURE_ROOT_UNRESOLVED", "无法从 mapbnd 路径定位地图纹理包目录。");

        var packagePaths = new List<string>();
        var mapGroupName = ExtractMapGroupName(mapbndPath);
        try
        {
            foreach (var textureRoot in textureRoots)
            {
                var packagePrefix = mapGroupName ?? new DirectoryInfo(textureRoot).Name;
                foreach (var path in Directory.EnumerateFiles(textureRoot, "*.tpfbhd", SearchOption.TopDirectoryOnly)
                    .Where(path => string.IsNullOrWhiteSpace(packagePrefix)
                        || Path.GetFileName(path).StartsWith(packagePrefix + "_", StringComparison.OrdinalIgnoreCase))
                    .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
                {
                    if (!packagePaths.Contains(path, StringComparer.OrdinalIgnoreCase)) packagePaths.Add(path);
                    if (packagePaths.Count >= MaxTexturePackages) break;
                }
                if (packagePaths.Count >= MaxTexturePackages) break;
            }
        }
        catch (IOException ex)
        {
            return MapTexturePreviewResult.Failed("MAP_TEXTURE_PACKAGE_ENUMERATION_FAILED", ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            return MapTexturePreviewResult.Failed("MAP_TEXTURE_PACKAGE_ENUMERATION_FAILED", ex.Message);
        }

        if (packagePaths.Count == 0)
            return MapTexturePreviewResult.Missing("MAP_TEXTURE_PACKAGES_NOT_FOUND", "地图目录中没有可读取的 tpfbhd/tpfbdt 纹理包。");

        MapTexturePreviewResult? firstFailure = null;
        foreach (var headerPath in packagePaths)
        {
            var dataPath = BdfSiblingPath(headerPath);
            if (dataPath is null || !File.Exists(dataPath)) continue;

            CachedPackage? package;
            try
            {
                package = GetCachedPackage(headerPath, dataPath);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or UnauthorizedAccessException)
            {
                firstFailure ??= MapTexturePreviewResult.Failed("MAP_TEXTURE_BXF4_READ_FAILED", ex.Message);
                continue;
            }

            var cacheKey = BuildPreviewCacheKey(package, materialName, materialMtdPath, normalizedTexturePaths);
            lock (CacheGate)
            {
                if (PreviewCache.TryGetValue(cacheKey, out var cached)) return cached;
            }

            var entry = package.Document.FindEntry(
                BuildEntryNames(mapGroupName, materialName, materialMtdPath, normalizedTexturePaths).ToArray());
            if (entry is null) continue;

            try
            {
                var stored = package.Document.ReadStoredBytes(entry);
                var dcx = DcxNativeDocument.Read(stored, oodleRuntimeRoot, entry.Name);
                if (!dcx.Payload.AsSpan().StartsWith("TPF\0"u8))
                    throw new InvalidDataException($"纹理条目 {entry.Name} 解压后不是 TPF。");
                var tpf = TpfNativeDocument.Read(dcx.Payload);
                var textureIndex = SelectAlbedoTexture(tpf);
                var textureData = tpf.GetTextureData(textureIndex);
                var (width, height, png, colorSpace) = DdsCodec.DecodeDdsToPngPreview(textureData, PreviewMaxDimension);
                var result = MapTexturePreviewResult.Ready(new MapTexturePreview(
                    materialName,
                    entry.Name,
                    tpf.Textures[textureIndex].Name,
                    width,
                    height,
                    $"data:image/png;base64,{Convert.ToBase64String(png)}",
                    colorSpace.ToString()));
                StorePreview(cacheKey, result);
                return result;
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException or InvalidOperationException)
            {
                firstFailure ??= MapTexturePreviewResult.Failed("MAP_TEXTURE_PREVIEW_DECODE_FAILED", ex.Message);
            }
        }

        return firstFailure ?? MapTexturePreviewResult.Missing(
            "MAP_TEXTURE_ENTRY_NOT_FOUND",
            $"纹理包中没有找到材质 {materialName} 的 albedo TPF 条目。");
    }

    private static CachedPackage GetCachedPackage(string headerPath, string dataPath)
    {
        var headerInfo = new FileInfo(headerPath);
        var dataInfo = new FileInfo(dataPath);
        var key = headerPath;
        var signature = new PackageSignature(
            headerInfo.Length,
            headerInfo.LastWriteTimeUtc.Ticks,
            dataInfo.Length,
            dataInfo.LastWriteTimeUtc.Ticks);
        lock (CacheGate)
        {
            if (PackageCache.TryGetValue(key, out var cached) && cached.Signature == signature)
                return cached;
        }

        var opened = new CachedPackage(signature, Bxf4NativeDocument.Open(headerPath, dataPath));
        lock (CacheGate)
        {
            PackageCache[key] = opened;
            if (PackageCache.Count > MaxTexturePackages * 2)
            {
                var oldKey = PackageCache.Keys.FirstOrDefault(candidate => !string.Equals(candidate, key, StringComparison.OrdinalIgnoreCase));
                if (oldKey is not null) PackageCache.Remove(oldKey);
            }
        }
        return opened;
    }

    private static void StorePreview(string key, MapTexturePreviewResult result)
    {
        lock (CacheGate)
        {
            PreviewCache[key] = result;
            if (PreviewCache.Count > PreviewCacheCapacity)
            {
                var oldKey = PreviewCache.Keys.FirstOrDefault(candidate => !string.Equals(candidate, key, StringComparison.OrdinalIgnoreCase));
                if (oldKey is not null) PreviewCache.Remove(oldKey);
            }
        }
    }

    private static string BuildPreviewCacheKey(
        CachedPackage package,
        string materialName,
        string materialMtdPath,
        IReadOnlyList<string> texturePaths) =>
        $"{package.Document.HeaderPath}|{package.Signature.HeaderLength}:{package.Signature.HeaderMtimeTicks}|{package.Signature.DataLength}:{package.Signature.DataMtimeTicks}|{materialName}|{materialMtdPath}|{string.Join('\u001f', texturePaths)}";

    private static int SelectAlbedoTexture(TpfNativeDocument document)
    {
        var albedo = document.Textures.FirstOrDefault(texture =>
            texture.Name.Contains("_a", StringComparison.OrdinalIgnoreCase)
            || texture.Name.Contains("albedo", StringComparison.OrdinalIgnoreCase));
        return albedo?.Index ?? (document.Textures.Count > 0 ? 0 : throw new InvalidDataException("TPF 没有纹理条目。"));
    }

    private static IReadOnlyList<string> ResolveTextureRoots(string mapbndPath, string? oodleRuntimeRoot)
    {
        var roots = new List<string>();
        void Add(string? candidate)
        {
            if (string.IsNullOrWhiteSpace(candidate) || !Directory.Exists(candidate)) return;
            if (!roots.Contains(candidate, StringComparer.OrdinalIgnoreCase)) roots.Add(candidate);
        }

        var modelDirectory = Directory.GetParent(mapbndPath)?.FullName;
        var groupName = ExtractMapGroupName(mapbndPath);
        if (modelDirectory is not null && groupName is not null)
        {
            // Overlay mapbnd files normally live under map/mXX_scene; the
            // shared texture packages live next to that scene directory in
            // map/mXX. Keep this candidate first so a mod texture overrides
            // the mounted vanilla package.
            var sceneDirectory = new DirectoryInfo(modelDirectory);
            Add(Path.Combine(sceneDirectory.Parent?.FullName ?? "", groupName));

            var mapDirectory = FindAncestorDirectory(sceneDirectory, "map");
            Add(mapDirectory is null ? null : Path.Combine(mapDirectory.FullName, groupName));
        }

        if (!string.IsNullOrWhiteSpace(oodleRuntimeRoot) && groupName is not null)
        {
            var baseRoot = new DirectoryInfo(oodleRuntimeRoot);
            Add(baseRoot.Name.Equals("map", StringComparison.OrdinalIgnoreCase)
                ? Path.Combine(baseRoot.FullName, groupName)
                : Path.Combine(baseRoot.FullName, "map", groupName));
        }

        return roots;
    }

    private static DirectoryInfo? FindAncestorDirectory(DirectoryInfo start, string name)
    {
        for (var current = start; current is not null; current = current.Parent)
        {
            if (current.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return current;
        }
        return null;
    }

    private static string? ExtractMapGroupName(string path)
    {
        var fileName = Path.GetFileName(path).Replace('\\', '/').Split('/').LastOrDefault() ?? "";
        var fromFile = TryMapGroupName(fileName);
        if (fromFile is not null) return fromFile;

        var directory = Directory.GetParent(path);
        while (directory is not null)
        {
            var fromDirectory = TryMapGroupName(directory.Name);
            if (fromDirectory is not null) return fromDirectory;
            directory = directory.Parent;
        }
        return null;
    }

    private static string? TryMapGroupName(string value)
    {
        var prefix = value.Split('_', 2)[0];
        if (prefix.Length != 3 || (prefix[0] != 'm' && prefix[0] != 'M')) return null;
        return char.IsDigit(prefix[1]) && char.IsDigit(prefix[2]) ? prefix.ToLowerInvariant() : null;
    }

    private static IReadOnlyList<string> BuildEntryNames(
        string? mapGroupName,
        string materialName,
        string materialMtdPath,
        IReadOnlyList<string> texturePaths)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string? name)
        {
            if (!string.IsNullOrWhiteSpace(name)) names.Add(name.Trim());
        }

        foreach (var texturePath in texturePaths)
        {
            if (string.IsNullOrWhiteSpace(texturePath)) continue;
            var normalized = texturePath.Trim().Replace('\\', '/');
            var basename = normalized.Split('/').LastOrDefault() ?? normalized;
            Add(basename);
            if (basename.EndsWith(".tpf.dcx", StringComparison.OrdinalIgnoreCase))
            {
                Add(basename);
            }
            else if (basename.EndsWith(".tpf", StringComparison.OrdinalIgnoreCase))
            {
                Add($"{basename}.dcx");
            }
            else
            {
                var dot = basename.LastIndexOf('.');
                var stem = dot > 0 ? basename[..dot] : basename;
                Add($"{stem}.tpf.dcx");
            }
        }

        foreach (var name in BuildMtdEntryNames(mapGroupName, materialMtdPath)) Add(name);

        if (!string.IsNullOrWhiteSpace(materialName))
        {
            Add($"{materialName}_a.tpf.dcx");
            Add($"{materialName}_albedo.tpf.dcx");
            Add($"{materialName}_d.tpf.dcx");
            Add($"{materialName}.tpf.dcx");
        }
        return names.ToArray();
    }

    private static IEnumerable<string> BuildMtdEntryNames(string? mapGroupName, string materialMtdPath)
    {
        if (string.IsNullOrWhiteSpace(materialMtdPath)) yield break;
        var normalized = materialMtdPath.Trim().Replace('\\', '/');
        var basename = normalized.Split('/').LastOrDefault() ?? normalized;
        if (basename.EndsWith(".mtd", StringComparison.OrdinalIgnoreCase))
            basename = basename[..^4];

        // Sekiro map MTDs use names such as M[m10_00]_Rock1 and Cliff1.
        // Their numbered albedo entries use the same family plus a two-digit
        // suffix. Generate only that exact, bounded convention; do not pick a
        // random rock/stone texture merely because its English token matches.
        var match = Regex.Match(
            basename,
            @"(?:^|_)(?<family>rock|cliff|soil|stonefloor)(?<number>\d+)(?:_|$)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (!match.Success) yield break;
        var family = match.Groups["family"].Value.ToLowerInvariant() switch
        {
            "stonefloor" => "StoneFloor",
            _ => match.Groups["family"].Value.ToLowerInvariant()
        };
        if (!int.TryParse(match.Groups["number"].Value, out var number) || number < 0 || number > 999)
            yield break;
        var numberText = number.ToString("00", System.Globalization.CultureInfo.InvariantCulture);
        var prefix = string.IsNullOrWhiteSpace(mapGroupName) ? "" : $"{mapGroupName}_";
        yield return $"{prefix}{family}_{numberText}_a.tpf.dcx";
        yield return $"{prefix}{family}_{number}_a.tpf.dcx";
    }

    private static string? BdfSiblingPath(string headerPath)
    {
        const string headerSuffix = ".tpfbhd";
        if (!headerPath.EndsWith(headerSuffix, StringComparison.OrdinalIgnoreCase)) return null;
        return headerPath[..^headerSuffix.Length] + ".tpfbdt";
    }

    private sealed record CachedPackage(PackageSignature Signature, Bxf4NativeDocument Document);

    private sealed record PackageSignature(
        long HeaderLength,
        long HeaderMtimeTicks,
        long DataLength,
        long DataMtimeTicks);
}

internal sealed record MapTexturePreview(
    string MaterialName,
    string PackageEntryName,
    string TextureName,
    int Width,
    int Height,
    string PreviewToken,
    string ColorSpace);

internal sealed record MapTexturePreviewResult(
    string Status,
    MapTexturePreview? Preview,
    string? Code,
    string? Message)
{
    public static MapTexturePreviewResult Ready(MapTexturePreview preview) => new("ready", preview, null, null);

    public static MapTexturePreviewResult Missing(string code, string message) => new("missing", null, code, message);

    public static MapTexturePreviewResult Failed(string code, string message) => new("failed", null, code, message);
}

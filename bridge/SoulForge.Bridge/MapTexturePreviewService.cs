using System.Security;
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
    // Map groups normally have only a handful of TPF packages, but keep the
    // bound high enough for modded groups without turning a malformed folder
    // into an unbounded scan.
    private const int MaxTexturePackages = 256;
    private const int PreviewMaxDimension = 512;
    private const int PreviewCacheCapacity = 512;
    private const int PackageCatalogCapacity = 32;

    private static readonly object CacheGate = new();
    // The daemon can request several chunks at once. Serialize only the
    // initial BXF4 header/index open so concurrent materials do not reopen and
    // re-index the same package; steady-state lookups remain cache reads.
    private static readonly object PackageLoadGate = new();
    private static readonly Dictionary<string, CachedPackage> PackageCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, CachedPackageCatalog> PackageCatalogCache = new(StringComparer.OrdinalIgnoreCase);
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
        IReadOnlyList<string>? texturePaths,
        string? mapGroupName = null)
    {
        return ResolveCore(
            mapbndPath,
            materialName,
            materialMtdPath ?? "",
            oodleRuntimeRoot,
            texturePaths ?? Array.Empty<string>(),
            mapGroupName);
    }

    private static MapTexturePreviewResult ResolveCore(
        string mapbndPath,
        string materialName,
        string materialMtdPath,
        string? oodleRuntimeRoot,
        IReadOnlyList<string> texturePaths,
        string? requestedMapGroupName = null)
    {
        var normalizedTexturePaths = texturePaths
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => path.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (string.IsNullOrWhiteSpace(materialName) && normalizedTexturePaths.Length == 0)
            return MapTexturePreviewResult.Missing("MAP_TEXTURE_MATERIAL_NAME_EMPTY", "FLVER mesh 没有可用于纹理查找的 material name 或 texture slot path。");

        // objbnd 的 TPF 与 FLVER 同在一个原生容器内。这里必须先按 FLVER
        // texture slot 做 exact basename 匹配，不能让对象落入“材质语义猜一张
        // 地图纹理”的路径；否则最常见的结果就是模型有了、贴图全丢。
        if (IsObjectBinderPath(mapbndPath))
        {
            var embedded = ResolveEmbeddedPreview(
                mapbndPath,
                materialName,
                oodleRuntimeRoot,
                normalizedTexturePaths);
            if (embedded is not null) return embedded;
        }

        var mapGroup = NormalizeMapGroupName(requestedMapGroupName) ?? ExtractMapGroupName(mapbndPath);
        var textureRoots = ResolveTextureRoots(mapbndPath, oodleRuntimeRoot, mapGroup);
        if (textureRoots.Count == 0)
            return MapTexturePreviewResult.Missing("MAP_TEXTURE_ROOT_UNRESOLVED", "无法从 mapbnd 路径定位地图纹理包目录。");

        // Sekiro 地图 FLVER 的 texture slot 经常只有 slot 名，真正的
        // `m10_xxx_a.tif` 关系在 MTD4 的 AlbedoMap slot 中。按原生 MTD
        // 关系补齐候选，再交给 BXF4 的精确 entry 查找；没有匹配时仍然
        // 失败关闭，不退回“随便找一张岩石贴图”。
        var mtdTexturePaths = NativeMtdTextureLocator.ResolveAlbedoTexturePaths(
            materialMtdPath,
            oodleRuntimeRoot,
            ResolveMaterialRoots(mapbndPath));
        var resolvedTexturePaths = normalizedTexturePaths
            .Concat(mtdTexturePaths)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (!TryGetPackagePaths(
                textureRoots,
                mapGroup,
                out var packagePaths,
                out var packageEnumerationError))
            return MapTexturePreviewResult.Failed("MAP_TEXTURE_PACKAGE_ENUMERATION_FAILED", packageEnumerationError!);

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
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or UnauthorizedAccessException or SecurityException)
            {
                firstFailure ??= MapTexturePreviewResult.Failed("MAP_TEXTURE_BXF4_READ_FAILED", ex.Message);
                continue;
            }

            var cacheKey = BuildPreviewCacheKey(package, materialName, materialMtdPath, resolvedTexturePaths);
            lock (CacheGate)
            {
                if (PreviewCache.TryGetValue(cacheKey, out var cached)) return cached;
            }

            var entry = FindExactEntry(
                package,
                BuildEntryNames(mapGroup, materialName, materialMtdPath, resolvedTexturePaths));
            if (entry is null) continue;

            try
            {
                var stored = package.Document.ReadStoredBytes(entry);
                var dcx = DcxNativeDocument.Read(stored, oodleRuntimeRoot, entry.Name);
                if (!dcx.Payload.AsSpan().StartsWith("TPF\0"u8))
                    throw new InvalidDataException($"纹理条目 {entry.Name} 解压后不是 TPF。");
                var tpf = TpfNativeDocument.Read(dcx.Payload);
                var textureIndex = SelectAlbedoTexture(tpf, resolvedTexturePaths, entry.Name);
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

        lock (PackageLoadGate)
        {
            lock (CacheGate)
            {
                if (PackageCache.TryGetValue(key, out var cached) && cached.Signature == signature)
                    return cached;
            }

            var document = Bxf4NativeDocument.Open(headerPath, dataPath);
            var opened = new CachedPackage(signature, document, BuildEntryIndex(document.Entries));
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
    }

    private static bool TryGetPackagePaths(
        IReadOnlyList<string> textureRoots,
        string? mapGroupName,
        out IReadOnlyList<string> packagePaths,
        out string? error)
    {
        var roots = textureRoots
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var signatures = roots.Select(ReadDirectorySignature).ToArray();
        var key = $"{mapGroupName ?? string.Empty}\0{string.Join('\u001f', roots)}";
        lock (CacheGate)
        {
            if (PackageCatalogCache.TryGetValue(key, out var cached)
                && SameDirectorySignatures(cached.Signatures, signatures))
            {
                packagePaths = cached.Paths;
                error = cached.Paths.Count == 0 ? cached.EnumerationError : null;
                return error is null;
            }
        }

        var discovered = new List<string>();
        string? firstEnumerationError = null;
        try
        {
            foreach (var textureRoot in roots)
            {
                try
                {
                    var packagePrefix = mapGroupName ?? new DirectoryInfo(textureRoot).Name;
                    foreach (var path in Directory.EnumerateFiles(textureRoot, "*.tpfbhd", SearchOption.TopDirectoryOnly)
                        .Where(path => string.IsNullOrWhiteSpace(packagePrefix)
                            || Path.GetFileName(path).StartsWith(packagePrefix + "_", StringComparison.OrdinalIgnoreCase))
                        .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
                    {
                        if (!discovered.Contains(path, StringComparer.OrdinalIgnoreCase)) discovered.Add(path);
                        if (discovered.Count >= MaxTexturePackages) break;
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or SecurityException)
                {
                    // An inaccessible overlay must not hide readable vanilla
                    // packages from the next root. Keep the first error for the
                    // all-roots-failed case below.
                    firstEnumerationError ??= ex.Message;
                }
                if (discovered.Count >= MaxTexturePackages) break;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or SecurityException)
        {
            // The outer guard covers an unexpected failure while enumerating
            // the root list itself; keep the same failure-closed result.
            packagePaths = Array.Empty<string>();
            error = ex.Message;
            return false;
        }

        if (discovered.Count == 0 && firstEnumerationError is not null)
        {
            packagePaths = Array.Empty<string>();
            error = firstEnumerationError;
            return false;
        }

        var catalog = new CachedPackageCatalog(signatures, discovered.ToArray(), firstEnumerationError);
        lock (CacheGate)
        {
            PackageCatalogCache[key] = catalog;
            while (PackageCatalogCache.Count > PackageCatalogCapacity)
            {
                var oldKey = PackageCatalogCache.Keys.FirstOrDefault(candidate => !string.Equals(candidate, key, StringComparison.OrdinalIgnoreCase));
                if (oldKey is null) break;
                PackageCatalogCache.Remove(oldKey);
            }
        }
        packagePaths = catalog.Paths;
        error = null;
        return true;
    }

    private static DirectorySignature ReadDirectorySignature(string path)
    {
        try
        {
            var info = new DirectoryInfo(path);
            return new DirectorySignature(path, info.Exists ? info.LastWriteTimeUtc.Ticks : -1);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or SecurityException)
        {
            return new DirectorySignature(path, -1);
        }
    }

    private static bool SameDirectorySignatures(
        IReadOnlyList<DirectorySignature> left,
        IReadOnlyList<DirectorySignature> right) =>
        left.Count == right.Count
        && left.Zip(right).All(pair =>
            string.Equals(pair.First.Path, pair.Second.Path, StringComparison.OrdinalIgnoreCase)
            && pair.First.LastWriteTicks == pair.Second.LastWriteTicks);

    private static IReadOnlyDictionary<string, Bxf4Entry[]> BuildEntryIndex(
        IReadOnlyList<Bxf4Entry> entries)
    {
        var index = new Dictionary<string, List<Bxf4Entry>>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries)
        {
            if (!index.TryGetValue(entry.Name, out var bucket))
            {
                bucket = new List<Bxf4Entry>();
                index[entry.Name] = bucket;
            }
            bucket.Add(entry);
        }
        return index.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.ToArray(),
            StringComparer.OrdinalIgnoreCase);
    }

    private static Bxf4Entry? FindExactEntry(
        CachedPackage package,
        IReadOnlyList<string> names)
    {
        foreach (var name in names)
        {
            if (string.IsNullOrWhiteSpace(name)
                || !package.EntriesByName.TryGetValue(name, out var entries))
                continue;

            // Duplicate BXF4 names are not safe to select by ordinal. Try the
            // next independently justified candidate instead of guessing.
            if (entries.Length == 1) return entries[0];
        }
        return null;
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

    private static int SelectAlbedoTexture(
        TpfNativeDocument document,
        IReadOnlyList<string> requestedTexturePaths,
        string packageEntryName)
    {
        var albedo = document.Textures
            .Where(texture => IsAlbedoTexture(texture.Name))
            .ToArray();
        if (albedo.Length == 0)
            throw new InvalidDataException("TPF 没有明确的 albedo 纹理；拒绝使用首个纹理作为猜测。");

        var requestedStems = requestedTexturePaths
            .Concat(new[] { packageEntryName })
            .Select(NormalizeTextureStem)
            .Where(stem => stem.Length > 0)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var exact = albedo
            .Where(texture => requestedStems.Contains(NormalizeTextureStem(texture.Name)))
            .ToArray();
        if (exact.Length == 1) return exact[0].Index;
        if (albedo.Length == 1) return albedo[0].Index;
        throw new InvalidDataException(
            $"TPF 含 {albedo.Length} 个 albedo 纹理且无法由 texture slot 精确区分；拒绝猜测。");
    }

    private static MapTexturePreviewResult? ResolveEmbeddedPreview(
        string objectBinderPath,
        string materialName,
        string? oodleRuntimeRoot,
        IReadOnlyList<string> texturePaths)
    {
        var requestedStems = texturePaths
            .Select(NormalizeTextureStem)
            .Where(stem => stem.Length > 0)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (requestedStems.Count == 0) return null;

        string cacheKey;
        try
        {
            var info = new FileInfo(objectBinderPath);
            cacheKey = $"embedded:{objectBinderPath}|{info.Length}:{info.LastWriteTimeUtc.Ticks}|{string.Join('\u001f', requestedStems.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))}";
            lock (CacheGate)
            {
                if (PreviewCache.TryGetValue(cacheKey, out var cached)) return cached;
            }
        }
        catch (IOException)
        {
            cacheKey = $"embedded:{objectBinderPath}|{string.Join('\u001f', requestedStems.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))}";
        }
        catch (UnauthorizedAccessException)
        {
            cacheKey = $"embedded:{objectBinderPath}|{string.Join('\u001f', requestedStems.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))}";
        }

        IReadOnlyList<NativeLeafEntry> leaves;
        try
        {
            leaves = NativeLeafPayload.ResolveAll(objectBinderPath, oodleRuntimeRoot, ".tpf");
        }
        catch (Exception ex) when (ex is InvalidDataException
            or NotSupportedException
            or IOException
            or UnauthorizedAccessException)
        {
            return null;
        }

        foreach (var leaf in leaves)
        {
            TpfNativeDocument tpf;
            try
            {
                tpf = TpfNativeDocument.Read(leaf.Payload);
            }
            catch (Exception ex) when (ex is InvalidDataException
                or NotSupportedException
                or ArgumentOutOfRangeException)
            {
                continue;
            }

            foreach (var texture in tpf.Textures)
            {
                if (!IsAlbedoTexture(texture.Name)
                    || !requestedStems.Contains(NormalizeTextureStem(texture.Name)))
                    continue;
                try
                {
                    var textureData = tpf.GetTextureData(texture.Index);
                    var (width, height, png, colorSpace) =
                        DdsCodec.DecodeDdsToPngPreview(textureData, PreviewMaxDimension);
                    var result = MapTexturePreviewResult.Ready(new MapTexturePreview(
                        materialName,
                        leaf.Name,
                        texture.Name,
                        width,
                        height,
                        $"data:image/png;base64,{Convert.ToBase64String(png)}",
                        colorSpace.ToString()));
                    StorePreview(cacheKey, result);
                    return result;
                }
                catch (Exception ex) when (ex is InvalidDataException
                    or NotSupportedException
                    or ArgumentOutOfRangeException
                    or IOException
                    or InvalidOperationException)
                {
                    // 该 slot 的纹理无法解码时继续检查同一容器的其它 exact leaf；
                    // 不把一张坏贴图升级为整个对象的错误路由。
                }
            }
        }
        return null;
    }

    private static bool IsObjectBinderPath(string path) =>
        Regex.IsMatch(
            Path.GetFileName(path),
            @"\.objbnd(?:\.dcx)?$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static bool IsAlbedoTexture(string name)
    {
        var lower = name.ToLowerInvariant();
        if (lower.Contains("normal", StringComparison.Ordinal)
            || lower.Contains("mask", StringComparison.Ordinal)
            || lower.Contains("rough", StringComparison.Ordinal)
            || lower.Contains("spec", StringComparison.Ordinal)
            || lower.Contains("metallic", StringComparison.Ordinal)
            || lower.EndsWith("_n", StringComparison.Ordinal)
            || lower.EndsWith("_m", StringComparison.Ordinal)
            || lower.EndsWith("_s", StringComparison.Ordinal)
            || lower.EndsWith("_r", StringComparison.Ordinal))
            return false;
        return lower.EndsWith("_a", StringComparison.Ordinal)
            || lower.EndsWith("_d", StringComparison.Ordinal)
            || lower.EndsWith("_albedo", StringComparison.Ordinal)
            || lower.EndsWith("_diffuse", StringComparison.Ordinal)
            || lower.EndsWith("_color", StringComparison.Ordinal);
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
        return new string(stem.Where(char.IsLetterOrDigit).ToArray());
    }

    private static string? NormalizeMapGroupName(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : TryMapGroupName(value.Trim());

    private static IReadOnlyList<string> ResolveTextureRoots(
        string mapbndPath,
        string? oodleRuntimeRoot,
        string? mapGroupName = null)
    {
        var roots = new List<string>();
        void Add(string? candidate)
        {
            if (string.IsNullOrWhiteSpace(candidate) || !Directory.Exists(candidate)) return;
            if (!roots.Contains(candidate, StringComparer.OrdinalIgnoreCase)) roots.Add(candidate);
        }

        var modelDirectory = Directory.GetParent(mapbndPath)?.FullName;
        var groupName = mapGroupName ?? ExtractMapGroupName(mapbndPath);
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

    private static IReadOnlyList<string> ResolveMaterialRoots(string mapbndPath)
    {
        var roots = new List<string>();
        var directory = Directory.GetParent(mapbndPath);
        var mapDirectory = directory is null ? null : FindAncestorDirectory(directory, "map");
        var gameRoot = mapDirectory?.Parent?.FullName;
        if (!string.IsNullOrWhiteSpace(gameRoot)) roots.Add(gameRoot);
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

    private sealed record CachedPackage(
        PackageSignature Signature,
        Bxf4NativeDocument Document,
        IReadOnlyDictionary<string, Bxf4Entry[]> EntriesByName);

    private sealed record CachedPackageCatalog(
        IReadOnlyList<DirectorySignature> Signatures,
        IReadOnlyList<string> Paths,
        string? EnumerationError);

    private sealed record DirectorySignature(string Path, long LastWriteTicks);

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

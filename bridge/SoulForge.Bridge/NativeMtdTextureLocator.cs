using System.Text;
using System.Text.RegularExpressions;
using System.Security;

/// <summary>
/// 从原生 MTD4 材质定义中提取 albedo 的虚拟纹理路径。
///
/// Sekiro 的 MTD 不是 XML：真实的 allmaterialbnd.mtdbnd.dcx 条目以 MTD 4
/// 二进制结构保存，FLVER 的 texture slot 也可能只有 slot 名而没有 Path。这里
/// 只读取已经确认的 MTD4 字符串布局，利用 AlbedoMap/Diffuse/BaseColor slot 与
/// 紧邻路径之间的原生关系得到 texture basename；不解析 shader 数值，也不猜
/// “第一张岩石贴图”。这只是预览定位辅助，不提升 MTD parser authority。
/// </summary>
internal static class NativeMtdTextureLocator
{
    private const int MaxMtdPackages = 64;
    private const int MaxMtdEntries = 20_000;
    private const int MaxTexturePaths = 64;
    private const int MaxMtdBytes = 16 * 1024 * 1024;
    private const int MaxSlotToPathDistance = 1024;
    private const int RootCatalogCapacity = 32;
    private const int ResolutionCacheCapacity = 512;

    private static readonly object CacheGate = new();
    // ResolveAlbedoTexturePaths can be called concurrently for many map meshes.
    // Keep the expensive first package open single-flight; the BND4 index itself
    // remains shared through PackageCache after this gate is released.
    private static readonly object PackageLoadGate = new();
    private static readonly Dictionary<string, CachedPackage> PackageCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, CachedRootCatalog> RootCatalogCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, IReadOnlyList<string>> ResolutionCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Regex TexturePathPattern = new(
        @"(?<path>(?:[A-Za-z]:)?[\\/][^\x00-\x1f\x7f]{1,768}?\.(?:tif|tga|dds|png))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly Regex TextureSlotPattern = new(
        // Capture every Texture2D slot, not only albedo slots. A normal/mask
        // slot often sits between two albedo slots; if it is not captured, a
        // nearest-slot lookup would incorrectly attach its path to the prior
        // albedo slot.
        @"(?<slot>[A-Za-z0-9_]*Texture2D_[A-Za-z0-9_]+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static IReadOnlyList<string> ResolveAlbedoTexturePaths(
        string? materialMtdPath,
        string? gameRoot,
        IEnumerable<string>? additionalRoots = null)
    {
        var materialName = GetMaterialName(materialMtdPath);
        if (materialName.Length == 0) return Array.Empty<string>();

        var roots = ResolveMtdRoots(gameRoot, additionalRoots);
        if (roots.Count == 0) return Array.Empty<string>();

        // Enumerate each mtd root once per directory revision. The old path
        // walked *.mtdbnd* for every FLVER material, which multiplied the same
        // filesystem work across hundreds of map models.
        var catalogs = roots.Select(GetRootCatalog).ToArray();
        var candidates = EnumerateCandidates(materialName, catalogs).ToArray();
        var resolutionKey = BuildResolutionCacheKey(materialName, gameRoot, candidates);
        lock (CacheGate)
        {
            if (ResolutionCache.TryGetValue(resolutionKey, out var cached)) return cached;
        }

        var packageCount = 0;
        var hadCandidateFailure = false;
        foreach (var candidate in candidates)
        {
            if (packageCount++ >= MaxMtdPackages) break;
            try
            {
                var bytes = candidate.IsLoose
                    ? ReadLooseMtd(candidate.Path, gameRoot)
                    : ReadPackagedMtd(candidate.Path, materialName, gameRoot);
                if (bytes is null) continue;
                var paths = ExtractAlbedoTexturePaths(bytes);
                if (paths.Count > 0)
                {
                    if (!hadCandidateFailure) StoreResolution(resolutionKey, paths);
                    return paths;
                }
            }
            catch (Exception ex) when (ex is InvalidDataException
                or NotSupportedException
                or IOException
                or UnauthorizedAccessException
                or SecurityException)
            {
                // 预览定位是 best-effort。某个覆盖包损坏或使用当前 Bridge 不支持的
                // 压缩时继续看原版包，不能让一张材质拖垮整张地图。
                hadCandidateFailure = true;
            }
        }
        var empty = Array.Empty<string>();
        if (!hadCandidateFailure) StoreResolution(resolutionKey, empty);
        return empty;
    }

    private static byte[]? ReadLooseMtd(string path, string? gameRoot)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length <= 0 || info.Length > MaxMtdBytes) return null;
        var source = File.ReadAllBytes(path);
        if (source.Length >= 4 && source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            return DcxNativeDocument.Read(source, gameRoot, path).Payload;
        return source;
    }

    private static byte[]? ReadPackagedMtd(string packagePath, string materialName, string? gameRoot)
    {
        var package = GetCachedPackage(packagePath, gameRoot);
        if (!package.EntryIndexes.TryGetValue(materialName, out var indexes) || indexes.Count != 1)
            return null;
        return package.Document.GetStoredBytes(indexes[0]);
    }

    private static CachedPackage GetCachedPackage(string packagePath, string? gameRoot)
    {
        var info = new FileInfo(packagePath);
        var signature = new PackageSignature(info.Length, info.LastWriteTimeUtc.Ticks);
        lock (CacheGate)
        {
            if (PackageCache.TryGetValue(packagePath, out var cached) && cached.Signature == signature)
                return cached;
        }

        lock (PackageLoadGate)
        {
            // Re-check after waiting for the in-flight opener. Without this
            // second lookup, concurrent map chunks would still parse the same
            // allmaterialbnd package once per caller.
            lock (CacheGate)
            {
                if (PackageCache.TryGetValue(packagePath, out var cached) && cached.Signature == signature)
                    return cached;
            }

            var payload = File.ReadAllBytes(packagePath);
            if (payload.Length < 4 || !payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
                throw new InvalidDataException($"MTD 包 {packagePath} 不是 DCX。 ");
            // Reuse the already-read source bytes. Besides avoiding a second
            // full-file read, this keeps the signature and parsed bytes from
            // crossing an external rewrite between two opens.
            payload = DcxNativeDocument.Read(payload, gameRoot, packagePath).Payload;
            if (payload.Length < 4 || !payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
                throw new InvalidDataException($"MTD 包 {packagePath} 解压后不是 BND4。 ");

            var document = Bnd4NativeDocument.Read(payload);
            if (document.Entries.Count > MaxMtdEntries)
                throw new InvalidDataException($"MTD 包条目数量 {document.Entries.Count} 超出安全上限 {MaxMtdEntries}。 ");
            var entryIndexes = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in document.Entries)
            {
                var name = GetMaterialName(entry.Name);
                if (name.Length == 0) continue;
                (entryIndexes.TryGetValue(name, out var indexes)
                    ? indexes
                    : entryIndexes[name] = new List<int>()).Add(entry.Index);
            }

            var opened = new CachedPackage(signature, document, entryIndexes);
            lock (CacheGate)
            {
                PackageCache[packagePath] = opened;
                while (PackageCache.Count > MaxMtdPackages * 2)
                {
                    var oldKey = PackageCache.Keys.FirstOrDefault(key =>
                        !string.Equals(key, packagePath, StringComparison.OrdinalIgnoreCase));
                    if (oldKey is null) break;
                    PackageCache.Remove(oldKey);
                }
            }
            return opened;
        }
    }

    private static IReadOnlyList<string> ExtractAlbedoTexturePaths(byte[] source)
    {
        if (source.Length <= 0 || source.Length > MaxMtdBytes) return Array.Empty<string>();

        // MTD4 的字符串区是 ASCII；用路径/slot 的可验证字符串关系读取，避免把
        // 二进制中的任意单词当作纹理路径。Regex 会在 .tif/.tga/.dds/.png 处截断
        // 后面的 MTD 数值字段，所以路径尾部的长度/flag 不会进入结果。
        var ascii = Encoding.ASCII.GetString(source);
        var slots = TextureSlotPattern.Matches(ascii);
        var candidates = new List<AlbedoTexturePathCandidate>();
        var order = 0;
        foreach (Match pathMatch in TexturePathPattern.Matches(ascii))
        {
            var nearestSlot = slots
                .Cast<Match>()
                .Where(slot => slot.Index < pathMatch.Index)
                .OrderByDescending(slot => slot.Index)
                .FirstOrDefault();
            if (nearestSlot is null
                || pathMatch.Index - (nearestSlot.Index + nearestSlot.Length) > MaxSlotToPathDistance
                || !IsAlbedoSlot(nearestSlot.Value))
                continue;

            var path = pathMatch.Groups["path"].Value.Trim();
            if (path.Length == 0) continue;
            var slotName = nearestSlot.Value;
            var slotIndex = ExtractTextureSlotIndex(slotName);
            candidates.Add(new AlbedoTexturePathCandidate(
                path,
                IsPrimaryAlbedoSlot(slotName, slotIndex),
                order++));
        }

        // A native MTD can list multiple color layers. The primary slot is a
        // shader-family fact: common Character/AO-SSS/Fresnel materials use
        // Texture2D_2, DetailBlend uses Texture2D_7, and Fur_NTC uses
        // Texture2D_1. Preserve native order for the remaining layers.
        var paths = candidates
            .OrderBy(candidate => candidate.IsPrimary ? 0 : 1)
            .ThenBy(candidate => candidate.Order)
            .Select(candidate => candidate.Path)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(MaxTexturePaths)
            .ToArray();

        // 少数 MTD 变体可能省略 slot 名，但使用原生 albedo 后缀；只在路径本身
        // 已明确是颜色纹理时接受该回退，仍不按材质语义选择候选。
        if (paths.Length == 0)
        {
            var fallback = new List<string>();
            foreach (Match pathMatch in TexturePathPattern.Matches(ascii))
            {
                var path = pathMatch.Groups["path"].Value.Trim();
                if (!HasAlbedoSuffix(path)
                    || fallback.Contains(path, StringComparer.OrdinalIgnoreCase)) continue;
                fallback.Add(path);
                if (fallback.Count >= MaxTexturePaths) break;
            }
            paths = fallback.ToArray();
        }
        return paths;
    }

    private static int ExtractTextureSlotIndex(string slotName)
    {
        const string marker = "Texture2D_";
        var markerIndex = slotName.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0) return -1;
        var start = markerIndex + marker.Length;
        var end = start;
        while (end < slotName.Length && char.IsDigit(slotName[end])) end++;
        return end > start && int.TryParse(slotName[start..end], out var index)
            ? index
            : -1;
    }

    private static bool IsPrimaryAlbedoSlot(string slotName, int slotIndex)
    {
        if (slotIndex < 0) return false;
        var lower = slotName.ToLowerInvariant();
        var primaryIndex = lower.Contains("detailblend", StringComparison.Ordinal)
            ? 7
            : (lower.Contains("fur_ntc", StringComparison.Ordinal)
                || lower.Contains("furntc", StringComparison.Ordinal))
                ? 1
                : lower.Contains("meshdecal", StringComparison.Ordinal)
                    ? 0
                    : 2;
        return slotIndex == primaryIndex;
    }

    private static bool IsAlbedoSlot(string value)
    {
        var lower = value.ToLowerInvariant();
        return (lower.Contains("albedomap", StringComparison.Ordinal)
                || lower.Contains("diffuse", StringComparison.Ordinal)
                || lower.Contains("basecolor", StringComparison.Ordinal)
                || lower.Contains("colormap", StringComparison.Ordinal))
            && !lower.Contains("normal", StringComparison.Ordinal)
            && !lower.Contains("mask", StringComparison.Ordinal)
            && !lower.Contains("metallic", StringComparison.Ordinal)
            && !lower.Contains("rough", StringComparison.Ordinal);
    }

    private static bool HasAlbedoSuffix(string path)
    {
        var lower = path.ToLowerInvariant();
        return lower.EndsWith("_a.tif", StringComparison.Ordinal)
            || lower.EndsWith("_a.tga", StringComparison.Ordinal)
            || lower.EndsWith("_a.dds", StringComparison.Ordinal)
            || lower.EndsWith("_d.tif", StringComparison.Ordinal)
            || lower.EndsWith("_d.tga", StringComparison.Ordinal)
            || lower.EndsWith("_d.dds", StringComparison.Ordinal)
            || lower.EndsWith("_albedo.tif", StringComparison.Ordinal)
            || lower.EndsWith("_albedo.tga", StringComparison.Ordinal)
            || lower.EndsWith("_albedo.dds", StringComparison.Ordinal);
    }

    private static IReadOnlyList<string> ResolveMtdRoots(
        string? gameRoot,
        IEnumerable<string>? additionalRoots)
    {
        var roots = new List<string>();
        void AddRoot(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            try
            {
                var path = Path.GetFullPath(value);
                var mtdRoot = new DirectoryInfo(path).Name.Equals("mtd", StringComparison.OrdinalIgnoreCase)
                    ? path
                    : Path.Combine(path, "mtd");

                // `additionalRoots` comes from the workspace boundary and may contain
                // a renderer-sanitized or stale path. A missing root is not a material
                // read failure; skip it before touching Directory.EnumerateFiles.
                if (Directory.Exists(mtdRoot)
                    && !roots.Contains(mtdRoot, StringComparer.OrdinalIgnoreCase))
                    roots.Add(mtdRoot);
            }
            catch (Exception ex) when (ex is ArgumentException
                or IOException
                or NotSupportedException
                or UnauthorizedAccessException
                or SecurityException)
            {
                // Texture lookup is best-effort. Ignore one invalid/stale root and
                // continue with the other roots, including the original game root.
            }
        }

        if (additionalRoots is not null)
        {
            foreach (var root in additionalRoots) AddRoot(root);
        }
        AddRoot(gameRoot);
        return roots;
    }

    private static CachedRootCatalog GetRootCatalog(string root)
    {
        DirectorySignature signature;
        try
        {
            var info = new DirectoryInfo(root);
            signature = new DirectorySignature(root, info.Exists ? info.LastWriteTimeUtc.Ticks : -1);
        }
        catch (Exception ex) when (ex is ArgumentException
            or IOException
            or NotSupportedException
            or UnauthorizedAccessException
            or SecurityException)
        {
            signature = new DirectorySignature(root, -1);
        }

        lock (CacheGate)
        {
            if (RootCatalogCache.TryGetValue(root, out var cached)
                && cached.Signature == signature)
                return cached;
        }

        List<string> packages;
        try
        {
            packages = Directory.EnumerateFiles(root, "*.mtdbnd*", SearchOption.TopDirectoryOnly)
                .OrderBy(path => Path.GetFileName(path).Equals("allmaterialbnd.mtdbnd.dcx", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch (Exception ex) when (ex is ArgumentException
            or IOException
            or NotSupportedException
            or UnauthorizedAccessException
            or SecurityException)
        {
            // A disappearing/inaccessible overlay directory must not prevent
            // lookup from continuing for the next root.
            packages = new List<string>();
        }

        var catalog = new CachedRootCatalog(signature, packages.ToArray());
        lock (CacheGate)
        {
            RootCatalogCache[root] = catalog;
            while (RootCatalogCache.Count > RootCatalogCapacity)
            {
                var oldKey = RootCatalogCache.Keys.FirstOrDefault(key =>
                    !string.Equals(key, root, StringComparison.OrdinalIgnoreCase));
                if (oldKey is null) break;
                RootCatalogCache.Remove(oldKey);
            }
        }
        return catalog;
    }

    private static IEnumerable<MtdCandidate> EnumerateCandidates(
        string materialName,
        IReadOnlyList<CachedRootCatalog> catalogs)
    {
        var yielded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var catalog in catalogs)
        {
            var root = catalog.Signature.Path;
            IReadOnlyList<string> looseCandidates;
            try
            {
                looseCandidates = new[]
                {
                    Path.Combine(root, materialName),
                    Path.Combine(root, $"{materialName}.dcx"),
                    Path.Combine(root, "map", materialName),
                    Path.Combine(root, "map", $"{materialName}.dcx")
                };
            }
            catch (ArgumentException)
            {
                looseCandidates = Array.Empty<string>();
            }
            foreach (var loose in looseCandidates)
            {
                if (File.Exists(loose) && yielded.Add(loose)) yield return new MtdCandidate(loose, true);
            }

            foreach (var package in catalog.PackagePaths)
                if (yielded.Add(package))
                    yield return new MtdCandidate(package, false);
        }
    }

    private static string BuildResolutionCacheKey(
        string materialName,
        string? gameRoot,
        IReadOnlyList<MtdCandidate> candidates)
    {
        var parts = new List<string>(candidates.Count + 2)
        {
            materialName,
            gameRoot?.Trim() ?? string.Empty
        };
        foreach (var candidate in candidates)
        {
            var signature = ReadFileSignature(candidate.Path);
            parts.Add($"{(candidate.IsLoose ? 'l' : 'p')}:{candidate.Path}:{signature.Length}:{signature.LastWriteTicks}");
        }
        return string.Join('\u001f', parts);
    }

    private static FileSignature ReadFileSignature(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return new FileSignature(info.Exists ? info.Length : -1, info.Exists ? info.LastWriteTimeUtc.Ticks : -1);
        }
        catch (Exception ex) when (ex is ArgumentException
            or IOException
            or NotSupportedException
            or UnauthorizedAccessException
            or SecurityException)
        {
            return new FileSignature(-1, -1);
        }
    }

    private static void StoreResolution(string key, IReadOnlyList<string> paths)
    {
        lock (CacheGate)
        {
            ResolutionCache[key] = paths.ToArray();
            while (ResolutionCache.Count > ResolutionCacheCapacity)
            {
                var oldKey = ResolutionCache.Keys.FirstOrDefault(candidate =>
                    !string.Equals(candidate, key, StringComparison.OrdinalIgnoreCase));
                if (oldKey is null) break;
                ResolutionCache.Remove(oldKey);
            }
        }
    }

    private static string GetMaterialName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var normalized = value.Trim().Replace('\\', '/');
        var name = normalized.Split('/').LastOrDefault() ?? string.Empty;
        for (var i = 0; i < 2; i++)
        {
            if (name.EndsWith(".dcx", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
            else if (name.EndsWith(".mtd", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
            else break;
        }
        return name.Length > 0 ? $"{name}.mtd" : string.Empty;
    }

    private sealed record MtdCandidate(string Path, bool IsLoose);

    private sealed record AlbedoTexturePathCandidate(
        string Path,
        bool IsPrimary,
        int Order);

    private sealed record CachedPackage(
        PackageSignature Signature,
        Bnd4NativeDocument Document,
        IReadOnlyDictionary<string, List<int>> EntryIndexes);

    private sealed record PackageSignature(long Length, long LastWriteTicks);

    private sealed record CachedRootCatalog(
        DirectorySignature Signature,
        IReadOnlyList<string> PackagePaths);

    private sealed record DirectorySignature(string Path, long LastWriteTicks);

    private sealed record FileSignature(long Length, long LastWriteTicks);
}

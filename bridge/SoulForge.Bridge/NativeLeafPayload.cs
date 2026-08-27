/// <summary>
/// Unwrap DCX and/or BND4 to a leaf payload, same shape as read-fxr-document.
/// Used by TPF/ESD so TS does not keep a second native unpacker.
/// Loose files that are already the leaf format pass through unchanged.
/// </summary>
internal static class NativeLeafPayload
{
    /// <summary>
    /// Enumerates every matching native leaf in one container read. Entry identity is
    /// preserved because display names are not unique inside BND4 files.
    /// </summary>
    public static IReadOnlyList<NativeLeafEntry> ResolveAll(
        string path,
        string? oodleRuntimeRoot,
        params string[] childNameSuffixes)
    {
        var sourceBytes = File.ReadAllBytes(path);
        var payload = sourceBytes;
        if (payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
        {
            payload = DcxNativeDocument.Read(path, oodleRuntimeRoot).Payload;
        }
        if (payload.Length < 4 || !payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
        {
            return new[]
            {
                new NativeLeafEntry(
                    0,
                    -1,
                    Path.GetFileName(path),
                    0,
                    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(payload)).ToLowerInvariant(),
                    payload)
            };
        }
        if (childNameSuffixes.Length == 0)
        {
            throw new InvalidDataException("输入是 BND4 容器，但本命令没有指定要读的子项后缀。");
        }

        var binder = Bnd4NativeDocument.Read(payload);
        var matches = binder.Entries.Where(item =>
            childNameSuffixes.Any(suffix => item.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)))
            .ToArray();
        if (matches.Length == 0)
        {
            throw new InvalidDataException(
                $"BND4 容器中没有匹配 {string.Join(", ", childNameSuffixes)} 的子项。");
        }

        return matches.Select(entry =>
        {
            var leaf = binder.GetStoredBytes(entry.Index);
            if (leaf.Length >= 4 && leaf.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            {
                throw new InvalidDataException(
                    $"BND4 FLVER 子项 {entry.Name} 仍是 DCX，本命令拒绝隐式多层解包。");
            }
            return new NativeLeafEntry(
                entry.Index,
                entry.Id,
                entry.Name,
                entry.DuplicateOrdinal,
                entry.ContentHash,
                leaf);
        }).ToArray();
    }

    public static byte[] Resolve(string path, string? oodleRuntimeRoot, params string[] childNameSuffixes)
    {
        var sourceBytes = File.ReadAllBytes(path);
        var payload = sourceBytes;
        if (payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
        {
            payload = DcxNativeDocument.Read(path, oodleRuntimeRoot).Payload;
        }
        if (payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
        {
            if (childNameSuffixes.Length == 0)
            {
                throw new InvalidDataException("输入是 BND4 容器，但本命令没有指定要读的子项后缀。");
            }
            var binder = Bnd4NativeDocument.Read(payload);
            var entry = binder.Entries.FirstOrDefault(item =>
                childNameSuffixes.Any(suffix =>
                    item.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)));
            if (entry is null)
            {
                throw new InvalidDataException(
                    $"BND4 容器中没有匹配 {string.Join(", ", childNameSuffixes)} 的子项。");
            }
            payload = binder.GetStoredBytes(entry.Index);
            if (payload.Length >= 4 && payload.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            {
                throw new InvalidDataException(
                    "BND4 子项仍是 DCX，本命令只解一层容器。请先抽出子项再读。");
            }
        }
        return payload;
    }

    /// <summary>
    /// Resolve a leaf only when the native container has exactly one matching
    /// entry.  Action previews have no safe display-name fallback: selecting
    /// the first FLVER from a multi-entry chrbnd can attach the wrong skeleton
    /// and silently corrupt the pose space.
    /// </summary>
    public static byte[] ResolveUnique(string path, string? oodleRuntimeRoot, params string[] childNameSuffixes)
    {
        var matches = ResolveAll(path, oodleRuntimeRoot, childNameSuffixes);
        if (matches.Count > 1)
        {
            throw new InvalidDataException(
                $"ACTION_FLVER_AMBIGUOUS: BND4 容器中有 {matches.Count} 个匹配 FLVER 子项，必须提供唯一 native entry identity。");
        }
        return matches[0].Payload;
    }
}

internal sealed record NativeLeafEntry(
    int Index,
    int Id,
    string Name,
    int DuplicateOrdinal,
    string ContentHash,
    byte[] Payload);

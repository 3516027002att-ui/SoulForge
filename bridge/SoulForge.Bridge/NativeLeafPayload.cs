/// <summary>
/// Unwrap DCX and/or BND4 to a leaf payload, same shape as read-fxr-document.
/// Used by TPF/ESD so TS does not keep a second native unpacker.
/// Loose files that are already the leaf format pass through unchanged.
/// </summary>
internal static class NativeLeafPayload
{
    public static byte[] Resolve(string path, string? oodleRuntimeRoot, params string[] childNameSuffixes)
        => Resolve(path, oodleRuntimeRoot, null, childNameSuffixes);

    /// <summary>
    /// Resolve a leaf with an optional Bridge-confirmed BND4 entry index.
    ///
    /// A suffix is only a fallback for legacy callers.  Production editor
    /// document reads pass the index returned by probe-document-locator so two
    /// children with the same extension cannot silently select the wrong one.
    /// </summary>
    public static byte[] Resolve(
        string path,
        string? oodleRuntimeRoot,
        int? entryIndex,
        params string[] childNameSuffixes)
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
            Bnd4Entry? entry;
            if (entryIndex is int selectedIndex)
            {
                if (selectedIndex < 0 || selectedIndex >= binder.Entries.Count)
                    throw new InvalidDataException($"BND4 entryIndex={selectedIndex} 越界。");
                entry = binder.Entries[selectedIndex];
                if (childNameSuffixes.Length > 0
                    && !childNameSuffixes.Any(suffix =>
                        entry.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)))
                {
                    throw new InvalidDataException(
                        $"BND4 entryIndex={selectedIndex} 的条目 {entry.Name} 不匹配 {string.Join(", ", childNameSuffixes)}。");
                }
            }
            else
            {
                entry = binder.Entries.FirstOrDefault(item =>
                    childNameSuffixes.Any(suffix =>
                        item.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)));
            }
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
}

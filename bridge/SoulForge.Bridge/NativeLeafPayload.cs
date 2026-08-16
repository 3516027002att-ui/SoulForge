/// <summary>
/// Unwrap DCX and/or BND4 to a leaf payload, same shape as read-fxr-document.
/// Used by TPF/ESD so TS does not keep a second native unpacker.
/// Loose files that are already the leaf format pass through unchanged.
/// </summary>
internal static class NativeLeafPayload
{
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
}

using System.Text;

static class SyntheticBinderFixtureExports
{
    private const int MaxChildren = 300;
    private const int ChildRowStride = 32;
    private static readonly byte[] Marker = { (byte)'S', (byte)'F', (byte)'B', (byte)'N' };

    public static BridgeResult<object>? TryExport(string sourcePath)
    {
        var sample = ReadAll(sourcePath, maxBytes: 4 * 1024 * 1024);
        if (!StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'4') && !StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'3')) return null;
        if (!MatchesMarker(sample, 4, Marker)) return null;

        var version = ReadInt32(sample, 8);
        var childCount = ReadInt32(sample, 12);
        var childTableStart = ReadInt32(sample, 16);
        var stringPoolStart = ReadInt32(sample, 20);

        if (version != 1) return null;
        if (childCount < 0 || childCount > MaxChildren) return null;
        if (!IsRangeInside(sample, childTableStart, (long)childCount * ChildRowStride)) return null;
        if (stringPoolStart <= 0 || stringPoolStart >= sample.Length) return null;

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var children = new List<object>();

        for (var index = 0; index < childCount; index += 1)
        {
            var row = childTableStart + index * ChildRowStride;
            var childId = ReadInt32(sample, row);
            var nameOffset = stringPoolStart + ReadInt32(sample, row + 4);
            var dataOffset = ReadInt64(sample, row + 8);
            var packedSize = ReadInt64(sample, row + 16);
            var unpackedSize = ReadInt64(sample, row + 24);

            if (childId < 0) return null;
            if (!IsRangeInside(sample, nameOffset, 2)) return null;
            if (dataOffset < 0 || packedSize < 0 || unpackedSize < 0) return null;

            var name = ReadUtf16Le(sample, nameOffset) ?? $"child_{childId}";
            children.Add(new
            {
                id = childId,
                name,
                resourceKind = GuessResourceKind(name),
                offset = dataOffset,
                packedSize,
                unpackedSize,
                raw = new
                {
                    parser = "soulforge-synthetic-binder-fixture-v1",
                    rowIndex = index,
                    rowOffset = row,
                    nameOffset,
                    confidence = "high",
                    nativeFormatAuthority = false
                }
            });
        }

        return BridgeResult<object>.Partial(
            sourcePath,
            "file",
            new[]
            {
                new Diagnostic(
                    "info",
                    "BND_SYNTHETIC_FIXTURE_CONFIRMED",
                    "Exported child inventory from the reviewed SoulForge synthetic BND fixture layout. This confirms parser plumbing and fixture behavior, not native game-format authority.",
                    sourceUri,
                    new { children = children.Count, version })
            },
            new { children });
    }

    private static string GuessResourceKind(string name)
    {
        var lower = name.ToLowerInvariant();
        if (lower.Contains("event") || lower.EndsWith(".emevd") || lower.EndsWith(".emevd.dcx")) return "event";
        if (lower.Contains("map") || lower.EndsWith(".msb") || lower.EndsWith(".msb.dcx")) return "map";
        if (lower.Contains("param") || lower.EndsWith(".param") || lower.EndsWith(".parambnd.dcx")) return "param";
        if (lower.Contains("msg") || lower.EndsWith(".fmg") || lower.EndsWith(".msgbnd.dcx")) return "msg";
        if (lower.Contains("menu")) return "menu";
        if (lower.Contains("script")) return "script";
        if (lower.Contains("action")) return "action";
        if (lower.Contains("ai")) return "ai";
        if (lower.Contains("sfx")) return "sfx";
        return "unknown";
    }

    private static string? ReadUtf16Le(byte[] sample, int offset)
    {
        var builder = new StringBuilder();
        for (var cursor = offset; cursor + 1 < sample.Length && builder.Length < 1024; cursor += 2)
        {
            var code = ReadUInt16(sample, cursor);
            if (code == 0) break;
            var ch = (char)code;
            if (!IsReadable(ch)) return null;
            builder.Append(ch);
        }
        return builder.Length == 0 ? null : builder.ToString();
    }

    private static byte[] ReadAll(string sourcePath, int maxBytes)
    {
        var info = new FileInfo(sourcePath);
        var count = (int)Math.Min(info.Length, maxBytes);
        using var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var buffer = new byte[count];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer, total, buffer.Length - total);
            if (read == 0) break;
            total += read;
        }
        if (total == buffer.Length) return buffer;
        Array.Resize(ref buffer, total);
        return buffer;
    }

    private static int ReadInt32(byte[] sample, int offset)
    {
        if (offset < 0 || offset + 4 > sample.Length) return -1;
        return sample[offset] | sample[offset + 1] << 8 | sample[offset + 2] << 16 | sample[offset + 3] << 24;
    }

    private static long ReadInt64(byte[] sample, int offset)
    {
        if (offset < 0 || offset + 8 > sample.Length) return -1;
        var lo = (uint)(sample[offset] | sample[offset + 1] << 8 | sample[offset + 2] << 16 | sample[offset + 3] << 24);
        var hi = (uint)(sample[offset + 4] | sample[offset + 5] << 8 | sample[offset + 6] << 16 | sample[offset + 7] << 24);
        return (long)((ulong)hi << 32 | lo);
    }

    private static int ReadUInt16(byte[] sample, int offset)
    {
        if (offset < 0 || offset + 2 > sample.Length) return -1;
        return sample[offset] | sample[offset + 1] << 8;
    }

    private static bool StartsWith(byte[] sample, byte a, byte b, byte c, byte d)
    {
        return sample.Length >= 4 && sample[0] == a && sample[1] == b && sample[2] == c && sample[3] == d;
    }

    private static bool MatchesMarker(byte[] sample, int offset, byte[] marker)
    {
        if (offset < 0 || offset + marker.Length > sample.Length) return false;
        for (var index = 0; index < marker.Length; index += 1)
        {
            if (sample[offset + index] != marker[index]) return false;
        }
        return true;
    }

    private static bool IsRangeInside(byte[] sample, int offset, long length)
    {
        if (offset < 0 || length < 0) return false;
        return offset + length <= sample.Length;
    }

    private static bool IsReadable(char ch)
    {
        return !char.IsControl(ch)
            && !char.IsSurrogate(ch)
            && (ch >= ' ' && ch <= '~'
                || char.IsLetterOrDigit(ch)
                || char.IsPunctuation(ch)
                || ch is >= '\u4E00' and <= '\u9FFF'
                || ch is >= '\u3040' and <= '\u30FF');
    }
}

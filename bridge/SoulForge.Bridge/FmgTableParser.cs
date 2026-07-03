using System.Text;

static class FmgTableParser
{
    private const int MaxEntries = 2000;
    private static readonly int[] CountOffsets = { 8, 12, 16, 20, 24, 28, 32 };
    private static readonly int[] TableStarts = { 16, 20, 24, 28, 32, 40, 48, 64 };
    private static readonly int[] Strides = { 8, 12, 16 };

    public static FmgParseCandidate? TryParse(byte[] sample, string sourceUri, string category)
    {
        if (!StartsWith(sample, (byte)'F', (byte)'M', (byte)'G', 0)) return null;

        FmgParseCandidate? best = null;
        foreach (var littleEndian in new[] { true, false })
        {
            foreach (var countOffset in CountOffsets)
            {
                var count = ReadInt32(sample, countOffset, littleEndian);
                if (count is < 1 or > MaxEntries) continue;

                foreach (var tableStart in TableStarts)
                {
                    foreach (var stride in Strides)
                    {
                        var candidate = ReadCandidate(sample, sourceUri, category, littleEndian, countOffset, count, tableStart, stride);
                        if (candidate == null) continue;
                        if (best == null || candidate.Score > best.Score) best = candidate;
                    }
                }
            }
        }

        return best?.Entries.Count >= 1 ? best : null;
    }

    private static FmgParseCandidate? ReadCandidate(
        byte[] sample,
        string sourceUri,
        string category,
        bool littleEndian,
        int countOffset,
        int count,
        int tableStart,
        int stride)
    {
        var tableLength = (long)count * stride;
        if (tableStart < 0 || tableStart + tableLength > sample.Length) return null;

        var entries = new List<object>();
        var ids = new HashSet<int>();
        var offsets = new HashSet<int>();
        var validRows = 0;

        for (var index = 0; index < count; index += 1)
        {
            var row = tableStart + index * stride;
            var id = ReadInt32(sample, row, littleEndian);
            var offset = ReadInt32(sample, row + 4, littleEndian);
            if (id < 0 || offset <= tableStart || offset >= sample.Length) continue;

            var text = ReadTextAt(sample, offset, littleEndian) ?? ReadTextAt(sample, offset, !littleEndian);
            if (text == null) continue;

            validRows += 1;
            ids.Add(id);
            offsets.Add(offset);
            entries.Add(new
            {
                uri = $"msg://{category}/{id}",
                sourceUri,
                category,
                textId = id,
                text = text.Text,
                raw = new
                {
                    table = "fmg-candidate",
                    rowIndex = index,
                    rowOffset = row,
                    textOffset = offset,
                    encoding = text.Encoding,
                    endian = littleEndian ? "little" : "big",
                    stride,
                    confidence = "medium"
                }
            });
        }

        if (validRows == 0) return null;
        var uniquenessBonus = ids.Count + offsets.Count;
        var score = validRows * 10 + uniquenessBonus - Math.Abs(count - validRows);
        if (validRows < Math.Min(count, 2) && count > 1) score -= 20;

        return new FmgParseCandidate(
            Entries: entries,
            Score: score,
            Metadata: new
            {
                parser = "fmg-table-candidate",
                countOffset,
                declaredCount = count,
                tableStart,
                stride,
                endian = littleEndian ? "little" : "big",
                validRows,
                uniqueIds = ids.Count,
                uniqueTextOffsets = offsets.Count
            });
    }

    private static TextValue? ReadTextAt(byte[] sample, int offset, bool littleEndian)
    {
        var builder = new StringBuilder();
        for (var cursor = offset; cursor + 1 < sample.Length && builder.Length < 4096; cursor += 2)
        {
            var code = littleEndian ? sample[cursor] | sample[cursor + 1] << 8 : sample[cursor] << 8 | sample[cursor + 1];
            if (code == 0) break;
            var ch = (char)code;
            if (!IsReadable(ch)) return null;
            builder.Append(ch);
        }

        if (builder.Length == 0) return null;
        return new TextValue(builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
    }

    private static int ReadInt32(byte[] sample, int offset, bool littleEndian)
    {
        if (offset < 0 || offset + 4 > sample.Length) return -1;
        return littleEndian
            ? sample[offset] | sample[offset + 1] << 8 | sample[offset + 2] << 16 | sample[offset + 3] << 24
            : sample[offset] << 24 | sample[offset + 1] << 16 | sample[offset + 2] << 8 | sample[offset + 3];
    }

    private static bool StartsWith(byte[] sample, byte a, byte b, byte c, byte d)
    {
        return sample.Length >= 4 && sample[0] == a && sample[1] == b && sample[2] == c && sample[3] == d;
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

    private sealed record TextValue(string Text, string Encoding);
}

sealed record FmgParseCandidate(IReadOnlyList<object> Entries, int Score, object Metadata);

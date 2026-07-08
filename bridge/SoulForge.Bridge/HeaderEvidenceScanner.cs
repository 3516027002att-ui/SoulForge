using System.Text;

static class HeaderEvidenceScanner
{
    private const int HeaderWindow = 256;

    public static IReadOnlyList<FormatEvidence> Scan(byte[] sample, string rootFormat)
    {
        if (sample.Length == 0) return Array.Empty<FormatEvidence>();

        return new[]
        {
            new FormatEvidence(
                "headerSummary",
                0,
                new
                {
                    rootFormat,
                    sampleLength = sample.Length,
                    headerWindow = Math.Min(sample.Length, HeaderWindow),
                    prefixHex = ToHex(sample, 0, Math.Min(sample.Length, 32)),
                    prefixAscii = ToAscii(sample, 0, Math.Min(sample.Length, 32)),
                    endianProbe = BuildEndianProbe(sample),
                    visibleHeaderTexts = ExtractVisibleTexts(sample).Take(24).ToArray(),
                    source = "bounded-prefix-header-scan",
                    authoritativeLayout = false
                },
                rootFormat == "unknown" ? "low" : "medium")
        };
    }

    private static object BuildEndianProbe(byte[] sample)
    {
        return new
        {
            u32le04 = ReadUInt32Le(sample, 4),
            u32be04 = ReadUInt32Be(sample, 4),
            u32le08 = ReadUInt32Le(sample, 8),
            u32be08 = ReadUInt32Be(sample, 8),
            u32le0c = ReadUInt32Le(sample, 12),
            u32be0c = ReadUInt32Be(sample, 12),
            u64le10 = ReadUInt64Le(sample, 16),
            u64be10 = ReadUInt64Be(sample, 16)
        };
    }

    private static IEnumerable<object> ExtractVisibleTexts(byte[] sample)
    {
        var limit = Math.Min(sample.Length, HeaderWindow);
        var start = -1;
        var builder = new StringBuilder();

        for (var index = 0; index < limit; index += 1)
        {
            var value = sample[index];
            if (value >= 32 && value <= 126)
            {
                if (start < 0) start = index;
                builder.Append((char)value);
                continue;
            }

            if (start >= 0 && builder.Length >= 3)
            {
                yield return new { offset = start, text = builder.ToString() };
            }
            start = -1;
            builder.Clear();
        }

        if (start >= 0 && builder.Length >= 3)
        {
            yield return new { offset = start, text = builder.ToString() };
        }
    }

    private static uint? ReadUInt32Le(byte[] sample, int offset)
    {
        if (offset < 0 || offset + 4 > sample.Length) return null;
        return (uint)(sample[offset] | sample[offset + 1] << 8 | sample[offset + 2] << 16 | sample[offset + 3] << 24);
    }

    private static uint? ReadUInt32Be(byte[] sample, int offset)
    {
        if (offset < 0 || offset + 4 > sample.Length) return null;
        return (uint)(sample[offset] << 24 | sample[offset + 1] << 16 | sample[offset + 2] << 8 | sample[offset + 3]);
    }

    private static ulong? ReadUInt64Le(byte[] sample, int offset)
    {
        var lo = ReadUInt32Le(sample, offset);
        var hi = ReadUInt32Le(sample, offset + 4);
        return lo.HasValue && hi.HasValue ? (ulong)hi.Value << 32 | lo.Value : null;
    }

    private static ulong? ReadUInt64Be(byte[] sample, int offset)
    {
        var hi = ReadUInt32Be(sample, offset);
        var lo = ReadUInt32Be(sample, offset + 4);
        return lo.HasValue && hi.HasValue ? (ulong)hi.Value << 32 | lo.Value : null;
    }

    private static string ToHex(byte[] sample, int offset, int count)
    {
        return string.Join(" ", sample.Skip(offset).Take(count).Select(value => value.ToString("X2")));
    }

    private static string ToAscii(byte[] sample, int offset, int count)
    {
        return new string(sample.Skip(offset).Take(count).Select(value => value >= 32 && value <= 126 ? (char)value : '.').ToArray());
    }
}

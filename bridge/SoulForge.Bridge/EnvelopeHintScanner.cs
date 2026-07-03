using System.Text;

static class EnvelopeHintScanner
{
    private const int MaxHints = 100;

    public static IReadOnlyList<FormatEvidence> Scan(byte[] sample)
    {
        var hints = new List<FormatEvidence>();
        foreach (var path in ExtractAsciiPathHints(sample))
        {
            hints.Add(new FormatEvidence("pathHint", path.Offset, new { path = path.Text, encoding = path.Encoding }, "low"));
            if (hints.Count >= MaxHints) return hints;
        }

        foreach (var path in ExtractUtf16PathHints(sample, littleEndian: true))
        {
            hints.Add(new FormatEvidence("pathHint", path.Offset, new { path = path.Text, encoding = path.Encoding }, "low"));
            if (hints.Count >= MaxHints) return hints;
        }

        foreach (var path in ExtractUtf16PathHints(sample, littleEndian: false))
        {
            hints.Add(new FormatEvidence("pathHint", path.Offset, new { path = path.Text, encoding = path.Encoding }, "low"));
            if (hints.Count >= MaxHints) return hints;
        }

        return hints;
    }

    private static IEnumerable<Hint> ExtractAsciiPathHints(byte[] sample)
    {
        var start = -1;
        var builder = new StringBuilder();
        for (var i = 0; i < sample.Length; i += 1)
        {
            var value = sample[i];
            if (value >= 32 && value <= 126)
            {
                if (start < 0) start = i;
                builder.Append((char)value);
                continue;
            }

            if (start >= 0 && IsUsefulPath(builder.ToString())) yield return new Hint(start, builder.ToString(), "ascii");
            start = -1;
            builder.Clear();
        }

        if (start >= 0 && IsUsefulPath(builder.ToString())) yield return new Hint(start, builder.ToString(), "ascii");
    }

    private static IEnumerable<Hint> ExtractUtf16PathHints(byte[] sample, bool littleEndian)
    {
        var start = -1;
        var builder = new StringBuilder();
        for (var i = 0; i + 1 < sample.Length; i += 2)
        {
            var code = littleEndian ? sample[i] | sample[i + 1] << 8 : sample[i] << 8 | sample[i + 1];
            var ch = (char)code;
            if (ch >= 32 && ch <= 126)
            {
                if (start < 0) start = i;
                builder.Append(ch);
                continue;
            }

            if (start >= 0 && IsUsefulPath(builder.ToString())) yield return new Hint(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
            start = -1;
            builder.Clear();
        }

        if (start >= 0 && IsUsefulPath(builder.ToString())) yield return new Hint(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
    }

    private static bool IsUsefulPath(string value)
    {
        if (value.Length < 4 || value.Length > 260) return false;
        var lower = value.ToLowerInvariant().Replace('\\', '/');
        if (lower.Contains("/")) return HasKnownResourceToken(lower);
        return lower.EndsWith(".dcx")
            || lower.EndsWith(".fmg")
            || lower.EndsWith(".emevd")
            || lower.EndsWith(".msb")
            || lower.EndsWith(".param")
            || lower.EndsWith(".tpf")
            || lower.EndsWith(".flver")
            || lower.EndsWith(".hkx");
    }

    private static bool HasKnownResourceToken(string lower)
    {
        return lower.Contains("event/")
            || lower.Contains("map/")
            || lower.Contains("msg/")
            || lower.Contains("param/")
            || lower.Contains("chr/")
            || lower.Contains("obj/")
            || lower.Contains("sfx/")
            || lower.Contains("script/");
    }

    private sealed record Hint(int Offset, string Text, string Encoding);
}

using System.Text;

static class BinderChildCandidateScanner
{
    private const int MaxCandidates = 200;

    public static IReadOnlyList<FormatEvidence> Scan(byte[] sample)
    {
        if (!IsBinder(sample)) return Array.Empty<FormatEvidence>();

        var candidates = new List<FormatEvidence>();
        foreach (var hint in ExtractPathLikeStrings(sample))
        {
            var kind = GuessResourceKind(hint.Text);
            candidates.Add(new FormatEvidence(
                "binderChildCandidate",
                hint.Offset,
                new
                {
                    path = hint.Text,
                    resourceKind = kind,
                    extensionChain = BuildExtensionChain(hint.Text),
                    encoding = hint.Encoding,
                    source = "visible-string-scan"
                },
                "low"));

            if (candidates.Count >= MaxCandidates) break;
        }

        return candidates;
    }

    private static bool IsBinder(byte[] sample)
    {
        return StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'3')
            || StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'4');
    }

    private static bool StartsWith(byte[] sample, byte a, byte b, byte c, byte d)
    {
        return sample.Length >= 4 && sample[0] == a && sample[1] == b && sample[2] == c && sample[3] == d;
    }

    private static IEnumerable<PathHint> ExtractPathLikeStrings(byte[] sample)
    {
        foreach (var item in ExtractAscii(sample)) if (IsUsefulChildPath(item.Text)) yield return item;
        foreach (var item in ExtractUtf16(sample, littleEndian: true)) if (IsUsefulChildPath(item.Text)) yield return item;
        foreach (var item in ExtractUtf16(sample, littleEndian: false)) if (IsUsefulChildPath(item.Text)) yield return item;
    }

    private static IEnumerable<PathHint> ExtractAscii(byte[] sample)
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

            if (start >= 0) yield return new PathHint(start, builder.ToString(), "ascii");
            start = -1;
            builder.Clear();
        }

        if (start >= 0) yield return new PathHint(start, builder.ToString(), "ascii");
    }

    private static IEnumerable<PathHint> ExtractUtf16(byte[] sample, bool littleEndian)
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

            if (start >= 0) yield return new PathHint(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
            start = -1;
            builder.Clear();
        }

        if (start >= 0) yield return new PathHint(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
    }

    private static bool IsUsefulChildPath(string value)
    {
        if (value.Length < 4 || value.Length > 260) return false;
        var lower = value.ToLowerInvariant().Replace('\\', '/');
        if (lower.Contains("..")) return false;
        if (lower.Contains('/')) return HasKnownResourceToken(lower) || HasKnownExtension(lower);
        return HasKnownExtension(lower);
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
            || lower.Contains("script/")
            || lower.Contains("menu/");
    }

    private static bool HasKnownExtension(string lower)
    {
        return lower.EndsWith(".dcx")
            || lower.EndsWith(".fmg")
            || lower.EndsWith(".emevd")
            || lower.EndsWith(".msb")
            || lower.EndsWith(".param")
            || lower.EndsWith(".tpf")
            || lower.EndsWith(".flver")
            || lower.EndsWith(".hkx")
            || lower.EndsWith(".matbin")
            || lower.EndsWith(".luagnl")
            || lower.EndsWith(".talkesdbnd");
    }

    private static string GuessResourceKind(string value)
    {
        var lower = value.ToLowerInvariant().Replace('\\', '/');
        if (lower.Contains("emevd") || lower.Contains("event/")) return "event";
        if (lower.Contains("msb") || lower.Contains("map/")) return "map";
        if (lower.Contains("param")) return "param";
        if (lower.Contains("msg") || lower.EndsWith(".fmg")) return "msg";
        if (lower.Contains("menu/")) return "menu";
        if (lower.Contains("sfx/")) return "sfx";
        return "unknown";
    }

    private static IReadOnlyList<string> BuildExtensionChain(string value)
    {
        var name = value.Replace('\\', '/').Split('/').LastOrDefault() ?? value;
        var parts = name.ToLowerInvariant().Split('.', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length <= 1 ? Array.Empty<string>() : parts.Skip(1).Select(part => "." + part).ToArray();
    }

    private sealed record PathHint(int Offset, string Text, string Encoding);
}

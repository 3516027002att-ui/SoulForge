using System.Text;

static class MsgTextExport
{
    private const int MaxReadBytes = 4 * 1024 * 1024;
    private const int MaxEntries = 500;

    public static BridgeResult<object> Export(string sourcePath)
    {
        var info = new FileInfo(sourcePath);
        var sample = ReadPrefix(sourcePath, (int)Math.Min(info.Length, MaxReadBytes));
        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var category = SafeCategory(Path.GetFileNameWithoutExtension(sourcePath));

        if (IsPackedContainer(sample))
        {
            return Unsupported(sourcePath, "MSG_CONTAINER_BOUNDARY", "Message export stopped at a packed container boundary. Use inspect evidence until unpacking exists.");
        }

        var table = FmgTableParser.TryParse(sample, sourceUri, category);
        if (table != null)
        {
            var confirmedFixture = table.Confidence == "confirmed-fixture";
            return BridgeResult<object>.Partial(
                sourcePath,
                "msg",
                new[]
                {
                    new Diagnostic(
                        "info",
                        confirmedFixture ? "MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED" : "MSG_FMG_TABLE_CANDIDATE",
                        confirmedFixture
                            ? "Exported message entries from the reviewed SoulForge synthetic FMG fixture layout. This confirms parser plumbing and fixture behavior, not native game-format authority."
                            : "Exported message entries from a guarded FMG table candidate. This is stronger than raw string scan, but still requires fixture review before being treated as authoritative.",
                        sourceUri,
                        table.Metadata)
                },
                new { category, entries = table.Entries });
        }

        var entries = ExtractStrings(sample)
            .GroupBy(item => new { item.Offset, item.Text })
            .Select(group => group.First())
            .OrderBy(item => item.Offset)
            .Take(MaxEntries)
            .Select(item => new
            {
                uri = $"msg://{category}/{item.Offset}",
                sourceUri,
                category,
                textId = item.Offset,
                text = item.Text,
                raw = new { offset = item.Offset, encoding = item.Encoding, confidence = item.Confidence }
            })
            .ToArray();

        if (entries.Length == 0)
        {
            return Unsupported(sourcePath, "MSG_NO_READABLE_STRINGS", "No readable message strings were found in the bounded scan window.");
        }

        return BridgeResult<object>.Partial(
            sourcePath,
            "msg",
            new[]
            {
                new Diagnostic(
                    "info",
                    "MSG_TEXT_EXPORT_PARTIAL",
                    "Exported readable strings from a bounded raw scan. File offsets are temporary text IDs until authoritative FMG tables are implemented.",
                    sourceUri,
                    new { entries = entries.Length, maxReadBytes = MaxReadBytes })
            },
            new { category, entries });
    }

    private static BridgeResult<object> Unsupported(string sourcePath, string code, string message)
    {
        return new BridgeResult<object>(
            BridgeResult<object>.MakeSourceUri(sourcePath),
            sourcePath,
            "unknown",
            "msg",
            "unsupported",
            new[] { new Diagnostic("info", code, message, BridgeResult<object>.MakeSourceUri(sourcePath)) });
    }

    private static bool IsPackedContainer(byte[] sample)
    {
        return StartsWith(sample, (byte)'D', (byte)'C', (byte)'X', 0)
            || StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'3')
            || StartsWith(sample, (byte)'B', (byte)'N', (byte)'D', (byte)'4');
    }

    private static bool StartsWith(byte[] sample, byte a, byte b, byte c, byte d)
    {
        return sample.Length >= 4 && sample[0] == a && sample[1] == b && sample[2] == c && sample[3] == d;
    }

    private static byte[] ReadPrefix(string sourcePath, int count)
    {
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

    private static IEnumerable<TextRun> ExtractStrings(byte[] sample)
    {
        foreach (var item in ExtractAscii(sample, 4)) yield return item;
        foreach (var item in ExtractUtf16(sample, 2, littleEndian: true)) yield return item;
        foreach (var item in ExtractUtf16(sample, 2, littleEndian: false)) yield return item;
    }

    private static IEnumerable<TextRun> ExtractAscii(byte[] sample, int minChars)
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
            if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), "ascii", "low");
            start = -1;
            builder.Clear();
        }
        if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), "ascii", "low");
    }

    private static IEnumerable<TextRun> ExtractUtf16(byte[] sample, int minChars, bool littleEndian)
    {
        var start = -1;
        var builder = new StringBuilder();
        for (var i = 0; i + 1 < sample.Length; i += 2)
        {
            var code = littleEndian ? sample[i] | sample[i + 1] << 8 : sample[i] << 8 | sample[i + 1];
            var ch = (char)code;
            if (IsReadable(ch))
            {
                if (start < 0) start = i;
                builder.Append(ch);
                continue;
            }
            if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be", "medium");
            start = -1;
            builder.Clear();
        }
        if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be", "medium");
    }

    private static bool IsReadable(char ch)
    {
        return !char.IsControl(ch) && !char.IsSurrogate(ch) && (ch >= ' ' && ch <= '~' || char.IsLetterOrDigit(ch) || char.IsPunctuation(ch) || ch is >= '\u4E00' and <= '\u9FFF' || ch is >= '\u3040' and <= '\u30FF');
    }

    private static string SafeCategory(string value)
    {
        return string.Concat(value.Select(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-' ? ch : '_')).Trim('_').ToLowerInvariant();
    }

    private sealed record TextRun(int Offset, string Text, string Encoding, string Confidence);
}

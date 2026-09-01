using System.Text;

static class MsgTextExport
{
    private const int MaxReadBytes = 4 * 1024 * 1024;
    private const int MaxEntries = 500;

    public static BridgeResult<object> Export(string sourcePath, string? oodleRuntimeRoot = null)
    {
        var info = new FileInfo(sourcePath);
        var sample = ReadPrefix(sourcePath, (int)Math.Min(info.Length, MaxReadBytes));
        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var category = SafeCategory(Path.GetFileNameWithoutExtension(sourcePath));

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

        // Native FMG v2 uses the integer marker 0x00020000 rather than the
        // synthetic fixture's "FMG\0" marker.  Packed msgbnd files must be
        // expanded here so the index receives one typed catalog per FMG child.
        if (IsPackedContainer(sample) || IsNativeFmg(sample))
            return ExportNative(sourcePath, oodleRuntimeRoot);

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

    private static BridgeResult<object> ExportNative(string sourcePath, string? oodleRuntimeRoot)
    {
        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        try
        {
            var leaves = NativeLeafPayload.ResolveAll(sourcePath, oodleRuntimeRoot, ".fmg", ".msg");
            var tables = new List<NativeMsgTable>(leaves.Count);
            var diagnostics = new List<Diagnostic>();
            foreach (var leaf in leaves)
            {
                try
                {
                    var document = FmgNativeDocument.Read(leaf.Payload);
                    var category = BuildNativeCategory(sourcePath, leaf.Name);
                    var idOccurrences = new Dictionary<int, int>();
                    var entries = new object[document.Entries.Count];
                    for (var index = 0; index < document.Entries.Count; index++)
                    {
                        var entry = document.Entries[index];
                        idOccurrences.TryGetValue(entry.Id, out var occurrence);
                        idOccurrences[entry.Id] = occurrence + 1;
                        var suffix = occurrence == 0 ? string.Empty : $"~{index}";
                        entries[index] = new
                        {
                            uri = $"msg://{category}/{entry.Id}{suffix}",
                            sourceUri,
                            category,
                            textId = entry.Id,
                            text = entry.Text,
                            confidence = "high",
                            raw = new
                            {
                                parser = "sekiro-fmg-native-v2",
                                entryIndex = leaf.Index,
                                tableEntryName = NativeLeafBaseName(leaf.Name),
                                stringIndex = entry.StringIndex,
                                sourceOffset = entry.SourceOffset,
                                confidence = "high"
                            }
                        };
                    }
                    tables.Add(new NativeMsgTable(
                        category,
                        document.SourceHash,
                        leaf.Index,
                        NativeLeafBaseName(leaf.Name),
                        entries));
                }
                catch (Exception ex) when (IsNativeReadException(ex))
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "MSG_FMG_NATIVE_CHILD_SKIPPED",
                        "消息容器中的子项不是可读取的 Sekiro FMG v2，已保留诊断并继续其它子项。",
                        sourceUri,
                        new { entryIndex = leaf.Index, entryName = NativeLeafBaseName(leaf.Name), error = ex.Message }));
                }
            }

            if (tables.Count == 0)
            {
                var all = new List<Diagnostic>
                {
                    new("error", "MSG_FMG_NATIVE_EXPORT_FAILED", "没有可读取的原生 FMG 子项。", sourceUri)
                };
                all.AddRange(diagnostics);
                return new BridgeResult<object>(sourceUri, sourcePath, BridgeResult<object>.GameUnknown, "msg", "failed", all);
            }

            var msgPayload = tables.Select(table => new
            {
                category = table.Category,
                sourceHash = table.SourceHash,
                entryIndex = table.EntryIndex,
                entryName = table.EntryName,
                entries = table.Entries
            }).ToArray();
            var data = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["msgs"] = msgPayload
            };
            // 保留单 FMG 调用方的旧形状；多表结果通过 msgs[] 明确表达。
            if (tables.Count == 1)
            {
                var first = tables[0];
                data["category"] = first.Category;
                data["sourceHash"] = first.SourceHash;
                data["entries"] = first.Entries;
            }
            diagnostics.Insert(0, new Diagnostic(
                "info",
                "MSG_FMG_NATIVE_SEMANTIC_EXPORT",
                "已由原生 FMG v2 解析器展开消息容器中的全部文本表、文本 ID 和 UTF-16 文本。",
                sourceUri,
                new { parser = "sekiro-fmg-native-v2", tables = tables.Count, entries = tables.Sum(table => table.Entries.Length) }));
            return BridgeResult<object>.Partial(sourcePath, "msg", diagnostics, data);
        }
        catch (Exception ex) when (IsNativeReadException(ex))
        {
            return BridgeResult<object>.Failed(
                sourcePath,
                "msg",
                "MSG_FMG_NATIVE_EXPORT_FAILED",
                $"原生 FMG 消息语义导出失败。 {ex.Message}",
                new { parser = "sekiro-fmg-native-v2", exception = ex.GetType().Name });
        }
    }

    private static string BuildNativeCategory(string sourcePath, string leafName)
    {
        var language = Path.GetFileName(Path.GetDirectoryName(sourcePath) ?? string.Empty) ?? string.Empty;
        var container = NativeLeafBaseName(sourcePath);
        foreach (var suffix in new[] { ".dcx", ".msgbnd", ".msg", ".fmg" })
        {
            if (container.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                container = container[..^suffix.Length];
        }
        var table = NativeLeafBaseName(leafName);
        if (table.EndsWith(".fmg", StringComparison.OrdinalIgnoreCase))
            table = table[..^4];
        var parts = new[] { SafeCategory(language), SafeCategory(container), SafeCategory(table) }
            .Where(part => part.Length > 0)
            .ToArray();
        return parts.Length > 0 ? string.Join('/', parts) : "native-fmg";
    }

    private static string NativeLeafBaseName(string value)
    {
        var normalized = value.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        return slash >= 0 ? normalized[(slash + 1)..] : normalized;
    }

    private static bool IsNativeFmg(byte[] sample)
    {
        return sample.Length >= 4 && sample[0] == 0 && sample[1] == 0 && sample[2] == 2 && sample[3] == 0;
    }

    private static bool IsNativeReadException(Exception ex)
    {
        return ex is InvalidDataException
            or NotSupportedException
            or IOException
            or OverflowException
            or ArgumentOutOfRangeException;
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

    private sealed record NativeMsgTable(
        string Category,
        string SourceHash,
        int EntryIndex,
        string EntryName,
        object[] Entries);

    private sealed record TextRun(int Offset, string Text, string Encoding, string Confidence);
}

using System.Text;
using System.Text.RegularExpressions;

static class SemanticCandidateExports
{
    private const int MaxReadBytes = 4 * 1024 * 1024;
    private const int MaxCandidates = 300;

    public static BridgeResult<object>? TryExport(string sourcePath, string resourceKind)
    {
        return resourceKind switch
        {
            "event" => TryExportEvent(sourcePath),
            "map" => TryExportMap(sourcePath),
            "param" => TryExportParam(sourcePath),
            _ => null
        };
    }

    private static BridgeResult<object>? TryExportEvent(string sourcePath)
    {
        var sample = ReadPrefix(sourcePath);
        if (!StartsWith(sample, (byte)'E', (byte)'V', (byte)'D', 0)) return null;

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var mapId = InferMapId(sourcePath);
        var ids = ScanInt32Candidates(sample)
            .Where(value => value == 0 || value >= 1000)
            .Where(value => value <= 2_000_000_000)
            .Distinct()
            .OrderBy(value => value)
            .Take(MaxCandidates)
            .ToArray();

        if (ids.Length == 0) return null;

        var events = ids.Select((eventId, index) => new
        {
            uri = $"event://{mapId ?? "unknown"}/{eventId}",
            sourceUri,
            mapId,
            eventId,
            name = $"event_candidate_{eventId}",
            instructions = Array.Empty<object>(),
            raw = new { parser = "emevd-id-candidate-scan", index, confidence = "low" }
        }).ToArray<object>();

        return BridgeResult<object>.Partial(
            sourcePath,
            "event",
            new[]
            {
                new Diagnostic(
                    "info",
                    "EMEVD_EVENT_ID_CANDIDATES",
                    "Exported low-confidence event ID candidates from an EMEVD payload. Instruction tables are not parsed yet.",
                    sourceUri,
                    new { candidates = events.Length, maxCandidates = MaxCandidates })
            },
            new { mapId, events });
    }

    private static BridgeResult<object>? TryExportParam(string sourcePath)
    {
        var sample = ReadPrefix(sourcePath);
        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var paramName = InferParamName(sourcePath);
        if (!LooksLikeParam(sourcePath, sample)) return null;

        var ids = ScanInt32Candidates(sample)
            .Where(value => value >= 0 && value <= 2_000_000_000)
            .Distinct()
            .OrderBy(value => value)
            .Take(MaxCandidates)
            .ToArray();

        if (ids.Length == 0) return null;

        var rows = ids.Select((rowId, index) => new
        {
            uri = $"param://{paramName}/{rowId}",
            sourceUri,
            paramName,
            rowId,
            rowName = $"row_candidate_{rowId}",
            fields = Array.Empty<object>(),
            raw = new { parser = "param-row-id-candidate-scan", index, confidence = "low" }
        }).ToArray();

        return BridgeResult<object>.Partial(
            sourcePath,
            "param",
            new[]
            {
                new Diagnostic(
                    "info",
                    "PARAM_ROW_ID_CANDIDATES",
                    "Exported low-confidence PARAM row ID candidates. Fields and row layout are not parsed yet.",
                    sourceUri,
                    new { paramName, candidates = rows.Length, maxCandidates = MaxCandidates })
            },
            new { paramName, rows });
    }

    private static BridgeResult<object>? TryExportMap(string sourcePath)
    {
        var sample = ReadPrefix(sourcePath);
        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var mapId = InferMapId(sourcePath) ?? Path.GetFileNameWithoutExtension(sourcePath).ToLowerInvariant();
        if (!LooksLikeMap(sourcePath, sample)) return null;

        var names = ExtractStrings(sample)
            .Where(value => LooksLikeMapSymbolName(value.Text))
            .GroupBy(value => value.Text)
            .Select(group => group.First())
            .Take(MaxCandidates)
            .ToArray();

        if (names.Length == 0) return null;

        var entities = names.Select((name, index) => new
        {
            uri = $"map://{mapId}/entity/candidate_{index}",
            sourceUri,
            mapId,
            name = name.Text,
            kind = GuessMapEntityKind(name.Text),
            raw = new { parser = "msb-visible-name-candidate-scan", offset = name.Offset, encoding = name.Encoding, confidence = "low" }
        }).ToArray();

        return BridgeResult<object>.Partial(
            sourcePath,
            "map",
            new[]
            {
                new Diagnostic(
                    "info",
                    "MSB_ENTITY_NAME_CANDIDATES",
                    "Exported low-confidence map entity name candidates from visible strings. Entity tables, transforms, and regions are not parsed yet.",
                    sourceUri,
                    new { mapId, candidates = entities.Length, maxCandidates = MaxCandidates })
            },
            new { mapId, entities, regions = Array.Empty<object>() });
    }

    private static bool LooksLikeParam(string sourcePath, byte[] sample)
    {
        var lower = sourcePath.ToLowerInvariant();
        if (lower.Contains("param")) return true;
        return StartsWith(sample, (byte)'P', (byte)'A', (byte)'R', (byte)'A');
    }

    private static bool LooksLikeMap(string sourcePath, byte[] sample)
    {
        var lower = sourcePath.ToLowerInvariant();
        if (lower.Contains(".msb") || Regex.IsMatch(lower, @"m\d{2}_\d{2}_\d{2}_\d{2}")) return true;
        return StartsWith(sample, (byte)'M', (byte)'S', (byte)'B', 0);
    }

    private static IEnumerable<int> ScanInt32Candidates(byte[] sample)
    {
        for (var offset = 0; offset + 4 <= sample.Length; offset += 4)
        {
            var little = sample[offset] | sample[offset + 1] << 8 | sample[offset + 2] << 16 | sample[offset + 3] << 24;
            if (little >= 0) yield return little;
        }
    }

    private static IEnumerable<TextRun> ExtractStrings(byte[] sample)
    {
        foreach (var item in ExtractAscii(sample, 3)) yield return item;
        foreach (var item in ExtractUtf16(sample, 3, littleEndian: true)) yield return item;
        foreach (var item in ExtractUtf16(sample, 3, littleEndian: false)) yield return item;
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

            if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), "ascii");
            start = -1;
            builder.Clear();
        }
        if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), "ascii");
    }

    private static IEnumerable<TextRun> ExtractUtf16(byte[] sample, int minChars, bool littleEndian)
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

            if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
            start = -1;
            builder.Clear();
        }
        if (start >= 0 && builder.Length >= minChars) yield return new TextRun(start, builder.ToString(), littleEndian ? "utf-16le" : "utf-16be");
    }

    private static bool LooksLikeMapSymbolName(string value)
    {
        if (value.Length is < 3 or > 80) return false;
        var lower = value.ToLowerInvariant();
        return Regex.IsMatch(lower, @"^(c|o|m|aeg|h|s)\d{3,}")
            || lower.Contains("enemy")
            || lower.Contains("obj")
            || lower.Contains("region")
            || lower.Contains("collision")
            || lower.Contains("map_piece");
    }

    private static string GuessMapEntityKind(string value)
    {
        var lower = value.ToLowerInvariant();
        if (lower.StartsWith("c")) return "character";
        if (lower.StartsWith("o") || lower.Contains("obj")) return "object";
        if (lower.Contains("collision")) return "collision";
        if (lower.StartsWith("m") || lower.Contains("map_piece")) return "mapPiece";
        if (lower.StartsWith("aeg")) return "asset";
        return "unknown";
    }

    private static string? InferMapId(string sourcePath)
    {
        var match = Regex.Match(sourcePath.ToLowerInvariant(), @"m\d{2}_\d{2}_\d{2}_\d{2}");
        return match.Success ? match.Value : null;
    }

    private static string InferParamName(string sourcePath)
    {
        var name = Path.GetFileNameWithoutExtension(sourcePath);
        while (name.EndsWith(".dcx", StringComparison.OrdinalIgnoreCase)) name = Path.GetFileNameWithoutExtension(name);
        return string.IsNullOrWhiteSpace(name) ? "unknown_param" : name;
    }

    private static byte[] ReadPrefix(string sourcePath)
    {
        var info = new FileInfo(sourcePath);
        var count = (int)Math.Min(info.Length, MaxReadBytes);
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

    private static bool StartsWith(byte[] sample, byte a, byte b, byte c, byte d)
    {
        return sample.Length >= 4 && sample[0] == a && sample[1] == b && sample[2] == c && sample[3] == d;
    }

    private sealed record TextRun(int Offset, string Text, string Encoding);
}

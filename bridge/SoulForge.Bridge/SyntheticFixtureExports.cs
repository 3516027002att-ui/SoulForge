using System.Text;
using System.Text.RegularExpressions;

static class SyntheticFixtureExports
{
    private const int MaxItems = 300;
    private const int ParamRowStride = 16;
    private const int EventRowStride = 16;
    private const int InstructionRowStride = 24;

    private static readonly byte[] ParamMarker = { (byte)'S', (byte)'F', (byte)'P', (byte)'R' };
    private static readonly byte[] EventMarker = { (byte)'S', (byte)'F', (byte)'E', (byte)'V' };

    public static BridgeResult<object>? TryExport(string sourcePath, string resourceKind)
    {
        var sample = ReadAll(sourcePath, maxBytes: 4 * 1024 * 1024);
        return resourceKind switch
        {
            "event" => TryExportEvent(sourcePath, sample),
            "param" => TryExportParam(sourcePath, sample),
            _ => null
        };
    }

    private static BridgeResult<object>? TryExportParam(string sourcePath, byte[] sample)
    {
        if (!StartsWith(sample, (byte)'P', (byte)'A', (byte)'R', (byte)'A')) return null;
        if (!MatchesMarker(sample, 4, ParamMarker)) return null;

        var version = ReadInt32(sample, 8);
        var rowCount = ReadInt32(sample, 12);
        var rowTableStart = ReadInt32(sample, 16);
        var stringPoolStart = ReadInt32(sample, 20);

        if (version != 1 || rowCount is < 1 or > MaxItems) return null;
        if (!IsRangeInside(sample, rowTableStart, (long)rowCount * ParamRowStride)) return null;
        if (stringPoolStart <= rowTableStart || stringPoolStart >= sample.Length) return null;

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var paramName = InferParamName(sourcePath);
        var rows = new List<object>();

        for (var index = 0; index < rowCount; index += 1)
        {
            var rowOffset = rowTableStart + index * ParamRowStride;
            var rowId = ReadInt32(sample, rowOffset);
            var rowNameOffset = stringPoolStart + ReadInt32(sample, rowOffset + 4);
            var value = ReadInt32(sample, rowOffset + 8);
            var typeCode = ReadInt32(sample, rowOffset + 12);
            if (rowId < 0 || !IsRangeInside(sample, rowNameOffset, 2)) return null;

            object fieldValue = typeCode == 2 ? value != 0 : value;

            rows.Add(new
            {
                uri = $"param://{paramName}/{rowId}",
                sourceUri,
                paramName,
                rowId,
                rowName = ReadUtf16Le(sample, rowNameOffset) ?? $"row_{rowId}",
                fields = new object[]
                {
                    new
                    {
                        name = "value",
                        type = typeCode == 2 ? "bool32" : "int32",
                        value = fieldValue
                    }
                },
                raw = new
                {
                    parser = "soulforge-synthetic-param-fixture-v1",
                    rowIndex = index,
                    rowOffset,
                    rowNameOffset,
                    confidence = "high",
                    nativeFormatAuthority = false
                }
            });
        }

        return BridgeResult<object>.Partial(
            sourcePath,
            "param",
            new[]
            {
                new Diagnostic(
                    "info",
                    "PARAM_SYNTHETIC_FIXTURE_CONFIRMED",
                    "Exported PARAM rows from the reviewed SoulForge synthetic PARAM fixture layout. This confirms parser plumbing and fixture behavior, not native game-format authority.",
                    sourceUri,
                    new { paramName, rows = rows.Count, version, rowTableStart, stringPoolStart })
            },
            new { paramName, rows });
    }

    private static BridgeResult<object>? TryExportEvent(string sourcePath, byte[] sample)
    {
        if (!StartsWith(sample, (byte)'E', (byte)'V', (byte)'D', 0)) return null;
        if (!MatchesMarker(sample, 4, EventMarker)) return null;

        var version = ReadInt32(sample, 8);
        var eventCount = ReadInt32(sample, 12);
        var eventTableStart = ReadInt32(sample, 16);

        if (version != 1 || eventCount is < 1 or > MaxItems) return null;
        if (!IsRangeInside(sample, eventTableStart, (long)eventCount * EventRowStride)) return null;

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var mapId = InferMapId(sourcePath);
        var events = new List<object>();

        for (var eventIndex = 0; eventIndex < eventCount; eventIndex += 1)
        {
            var eventRow = eventTableStart + eventIndex * EventRowStride;
            var eventId = ReadInt32(sample, eventRow);
            var instructionCount = ReadInt32(sample, eventRow + 4);
            var instructionTableStart = ReadInt32(sample, eventRow + 8);
            if (eventId < 0 || instructionCount < 0 || instructionCount > MaxItems) return null;
            if (!IsRangeInside(sample, instructionTableStart, (long)instructionCount * InstructionRowStride)) return null;

            var eventUri = $"event://{mapId ?? "unknown"}/{eventId}";
            var instructions = new List<object>();

            for (var instructionIndex = 0; instructionIndex < instructionCount; instructionIndex += 1)
            {
                var row = instructionTableStart + instructionIndex * InstructionRowStride;
                var declaredIndex = ReadInt32(sample, row);
                var opcode = ReadInt32(sample, row + 4);
                var role = RoleFromCode(ReadInt32(sample, row + 8));
                var argValue = ReadInt32(sample, row + 12);
                var paramName = ParamNameFromCode(ReadInt32(sample, row + 16));

                instructions.Add(new
                {
                    uri = $"{eventUri}/instruction/{instructionIndex}",
                    index = declaredIndex >= 0 ? declaredIndex : instructionIndex,
                    name = $"synthetic_instruction_{opcode}",
                    category = "synthetic-fixture",
                    args = new object[]
                    {
                        new
                        {
                            name = role == "unknown" ? "arg0" : role,
                            value = argValue,
                            role,
                            paramName,
                            confidence = "high"
                        }
                    },
                    raw = new
                    {
                        parser = "soulforge-synthetic-event-fixture-v1",
                        instructionRow = row,
                        opcode,
                        confidence = "high",
                        nativeFormatAuthority = false
                    }
                });
            }

            events.Add(new
            {
                uri = eventUri,
                sourceUri,
                mapId,
                eventId,
                name = $"synthetic_event_{eventId}",
                instructions = instructions.ToArray(),
                raw = new
                {
                    parser = "soulforge-synthetic-event-fixture-v1",
                    eventIndex,
                    eventRow,
                    instructionTableStart,
                    confidence = "high",
                    nativeFormatAuthority = false
                }
            });
        }

        return BridgeResult<object>.Partial(
            sourcePath,
            "event",
            new[]
            {
                new Diagnostic(
                    "info",
                    "EMEVD_SYNTHETIC_FIXTURE_CONFIRMED",
                    "Exported events and instruction rows from the reviewed SoulForge synthetic EMEVD fixture layout. This confirms parser plumbing and fixture behavior, not native game-format authority.",
                    sourceUri,
                    new { mapId, events = events.Count, version, eventTableStart })
            },
            new { mapId, events });
    }

    private static string RoleFromCode(int value)
    {
        return value switch
        {
            1 => "flag",
            2 => "eventId",
            3 => "entityId",
            4 => "regionId",
            5 => "paramId",
            6 => "textId",
            _ => "unknown"
        };
    }

    private static string? ParamNameFromCode(int value)
    {
        return value switch
        {
            1 => "SpEffectParam",
            2 => "EquipParamGoods",
            3 => "NpcParam",
            _ => null
        };
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

using System.Text;
using System.Text.RegularExpressions;

static class SyntheticMapFixtureExports
{
    private const int MaxItems = 300;
    private const int EntityRowStride = 40;
    private const int RegionRowStride = 36;
    private static readonly byte[] Marker = { (byte)'S', (byte)'F', (byte)'M', (byte)'P' };

    public static BridgeResult<object>? TryExport(string sourcePath)
    {
        var sample = ReadAll(sourcePath, maxBytes: 4 * 1024 * 1024);
        if (!StartsWith(sample, (byte)'M', (byte)'S', (byte)'B', 0)) return null;
        if (!MatchesMarker(sample, 4, Marker)) return null;

        var version = ReadInt32(sample, 8);
        var entityCount = ReadInt32(sample, 12);
        var entityTableStart = ReadInt32(sample, 16);
        var regionCount = ReadInt32(sample, 20);
        var regionTableStart = ReadInt32(sample, 24);
        var stringPoolStart = ReadInt32(sample, 28);

        if (version != 1) return null;
        if (entityCount < 0 || entityCount > MaxItems) return null;
        if (regionCount < 0 || regionCount > MaxItems) return null;
        if (!IsRangeInside(sample, entityTableStart, (long)entityCount * EntityRowStride)) return null;
        if (!IsRangeInside(sample, regionTableStart, (long)regionCount * RegionRowStride)) return null;
        if (stringPoolStart <= 0 || stringPoolStart >= sample.Length) return null;

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var mapId = InferMapId(sourcePath) ?? Path.GetFileNameWithoutExtension(sourcePath).ToLowerInvariant();
        var entities = new List<object>();
        var regions = new List<object>();

        for (var index = 0; index < entityCount; index += 1)
        {
            var row = entityTableStart + index * EntityRowStride;
            var entityId = ReadInt32(sample, row);
            var nameOffset = stringPoolStart + ReadInt32(sample, row + 4);
            var kindCode = ReadInt32(sample, row + 8);
            if (entityId < 0 || !IsRangeInside(sample, nameOffset, 2)) return null;

            entities.Add(new
            {
                uri = $"map://{mapId}/entity/{entityId}",
                sourceUri,
                mapId,
                entityId,
                name = ReadUtf16Le(sample, nameOffset) ?? $"entity_{entityId}",
                kind = MapKindFromCode(kindCode),
                position = new[] { ReadFloat32(sample, row + 12), ReadFloat32(sample, row + 16), ReadFloat32(sample, row + 20) },
                rotation = new[] { ReadFloat32(sample, row + 24), ReadFloat32(sample, row + 28), ReadFloat32(sample, row + 32) },
                raw = new
                {
                    parser = "soulforge-synthetic-map-fixture-v1",
                    rowIndex = index,
                    rowOffset = row,
                    nameOffset,
                    confidence = "high",
                    nativeFormatAuthority = false
                }
            });
        }

        for (var index = 0; index < regionCount; index += 1)
        {
            var row = regionTableStart + index * RegionRowStride;
            var entityId = ReadInt32(sample, row);
            var nameOffset = stringPoolStart + ReadInt32(sample, row + 4);
            var shapeCode = ReadInt32(sample, row + 8);
            if (entityId < 0 || !IsRangeInside(sample, nameOffset, 2)) return null;

            regions.Add(new
            {
                uri = $"map://{mapId}/region/{entityId}",
                sourceUri,
                mapId,
                entityId,
                name = ReadUtf16Le(sample, nameOffset) ?? $"region_{entityId}",
                shape = ShapeFromCode(shapeCode),
                position = new[] { ReadFloat32(sample, row + 12), ReadFloat32(sample, row + 16), ReadFloat32(sample, row + 20) },
                size = new[] { ReadFloat32(sample, row + 24), ReadFloat32(sample, row + 28), ReadFloat32(sample, row + 32) },
                raw = new
                {
                    parser = "soulforge-synthetic-map-fixture-v1",
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
            "map",
            new[]
            {
                new Diagnostic(
                    "info",
                    "MSB_SYNTHETIC_FIXTURE_CONFIRMED",
                    "Exported map entities and regions from the reviewed SoulForge synthetic MSB fixture layout. This confirms parser plumbing and fixture behavior, not native game-format authority.",
                    sourceUri,
                    new { mapId, entities = entities.Count, regions = regions.Count, version })
            },
            new { mapId, entities, regions });
    }

    private static string MapKindFromCode(int value)
    {
        return value switch
        {
            1 => "character",
            2 => "object",
            3 => "asset",
            4 => "collision",
            5 => "mapPiece",
            _ => "unknown"
        };
    }

    private static string ShapeFromCode(int value)
    {
        return value switch
        {
            1 => "point",
            2 => "sphere",
            3 => "box",
            4 => "cylinder",
            _ => "unknown"
        };
    }

    private static string? InferMapId(string sourcePath)
    {
        var match = Regex.Match(sourcePath.ToLowerInvariant(), @"m\d{2}_\d{2}_\d{2}_\d{2}");
        return match.Success ? match.Value : null;
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

    private static float ReadFloat32(byte[] sample, int offset)
    {
        return BitConverter.Int32BitsToSingle(ReadInt32(sample, offset));
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

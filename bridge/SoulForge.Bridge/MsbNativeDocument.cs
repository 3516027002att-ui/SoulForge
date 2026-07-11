using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro MSB (magic "MSB ") native document with models + parts transforms.
/// Parts entry stride and transform offsets derived from private m10_00_00_00.msb corpus.
/// Unknown trailing part fields and other sections are preserved via source-bytes rewrite.
/// </summary>
internal sealed class MsbNativeDocument
{
    private const int MaxSourceBytes = 128 * 1024 * 1024;
    private const int PartEntrySize = 0x348;
    private const int ModelEntrySize = 0xC0;
    private const int PartTransformOffset = 0x28;
    private const int MaxParts = 50_000;
    private const int MaxModels = 10_000;

    private const int RegionTransformOffset = 0x14;
    private const int EventEntrySize = 0xA0;
    private const int MaxRegions = 50_000;
    private const int MaxEvents = 50_000;

    private MsbNativeDocument(
        byte[] sourceBytes,
        int version,
        IReadOnlyList<MsbModel> models,
        IReadOnlyList<MsbPart> parts,
        IReadOnlyList<MsbRegion> regions,
        IReadOnlyList<MsbMapEvent> events,
        int partsSectionOffset,
        int firstPartOffset)
    {
        SourceBytes = sourceBytes;
        Version = version;
        Models = models;
        Parts = parts;
        Regions = regions;
        Events = events;
        PartsSectionOffset = partsSectionOffset;
        FirstPartOffset = firstPartOffset;
    }

    public byte[] SourceBytes { get; }
    public int Version { get; }
    public IReadOnlyList<MsbModel> Models { get; }
    public IReadOnlyList<MsbPart> Parts { get; }
    public IReadOnlyList<MsbRegion> Regions { get; }
    public IReadOnlyList<MsbMapEvent> Events { get; }
    public int PartsSectionOffset { get; }
    public int FirstPartOffset { get; }
    public string SourceHash => Hash(SourceBytes);

    public static MsbNativeDocument Read(byte[] source)
    {
        if (source.Length < 0x40 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"MSB 大小 {source.Length} 超出安全范围。");
        if (!source.AsSpan(0, 4).SequenceEqual("MSB "u8))
            throw new InvalidDataException("输入不是 MSB（缺少 \"MSB \" 魔数）。");
        var version = ReadInt32(source, 4);
        if (version is not (1 or 2 or 3))
            throw new NotSupportedException($"不支持的 MSB 版本 {version}。");

        var models = ReadModels(source);
        var (partsSectionOffset, firstPartOffset, parts) = ReadParts(source);
        var regions = ReadRegions(source);
        var events = ReadMapEvents(source);

        return new MsbNativeDocument(
            source, version, models, parts, regions, events, partsSectionOffset, firstPartOffset);
    }

    public static MsbNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("MSB 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"MSB 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    public MsbRoundTripReport VerifyRoundTrip()
    {
        // No-op rebuild is source-preserving.
        var rebuilt = SourceBytes.ToArray();
        var reparsed = Read(rebuilt);
        var modelsEqual = reparsed.Models.Count == Models.Count
            && reparsed.Models.Zip(Models).All(pair => pair.First.Name == pair.Second.Name);
        var partsEqual = reparsed.Parts.Count == Parts.Count
            && reparsed.Parts.Zip(Parts).All(pair =>
                pair.First.Name == pair.Second.Name
                && Nearly(pair.First.PosX, pair.Second.PosX)
                && Nearly(pair.First.PosY, pair.Second.PosY)
                && Nearly(pair.First.PosZ, pair.Second.PosZ));
        return new MsbRoundTripReport(
            true,
            modelsEqual && partsEqual,
            SourceHash,
            Hash(rebuilt),
            Version,
            Models.Count,
            Parts.Count,
            SourceBytes.Length);
    }

    public byte[] ApplyMutations(IReadOnlyList<MsbPatch> patches)
    {
        var rebuilt = SourceBytes.ToArray();
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "set_part_position":
                {
                    var index = Parts.ToList().FindIndex(p => p.Name == patch.PartName);
                    if (index < 0) throw new InvalidDataException($"MSB part 不存在：{patch.PartName}");
                    if (patch.PosX is null || patch.PosY is null || patch.PosZ is null)
                        throw new InvalidDataException("set_part_position 需要 posX/posY/posZ。");
                    var part = Parts[index];
                    var baseOff = part.Offset + PartTransformOffset;
                    WriteFloat(rebuilt, baseOff, patch.PosX.Value);
                    WriteFloat(rebuilt, baseOff + 4, patch.PosY.Value);
                    WriteFloat(rebuilt, baseOff + 8, patch.PosZ.Value);
                    break;
                }
                case "set_part_transform":
                {
                    var index = Parts.ToList().FindIndex(p => p.Name == patch.PartName);
                    if (index < 0) throw new InvalidDataException($"MSB part 不存在：{patch.PartName}");
                    var part = Parts[index];
                    var baseOff = part.Offset + PartTransformOffset;
                    if (patch.PosX is not null) WriteFloat(rebuilt, baseOff, patch.PosX.Value);
                    if (patch.PosY is not null) WriteFloat(rebuilt, baseOff + 4, patch.PosY.Value);
                    if (patch.PosZ is not null) WriteFloat(rebuilt, baseOff + 8, patch.PosZ.Value);
                    if (patch.RotX is not null) WriteFloat(rebuilt, baseOff + 12, patch.RotX.Value);
                    if (patch.ScaleX is not null) WriteFloat(rebuilt, baseOff + 16, patch.ScaleX.Value);
                    if (patch.ScaleY is not null) WriteFloat(rebuilt, baseOff + 20, patch.ScaleY.Value);
                    if (patch.ScaleZ is not null) WriteFloat(rebuilt, baseOff + 24, patch.ScaleZ.Value);
                    break;
                }
                case "set_region_position":
                {
                    var index = Regions.ToList().FindIndex(r => r.Name == patch.PartName);
                    if (index < 0) throw new InvalidDataException($"MSB region 不存在：{patch.PartName}");
                    if (patch.PosX is null || patch.PosY is null || patch.PosZ is null)
                        throw new InvalidDataException("set_region_position 需要 posX/posY/posZ。");
                    var region = Regions[index];
                    var baseOff = region.Offset + RegionTransformOffset;
                    WriteFloat(rebuilt, baseOff, patch.PosX.Value);
                    WriteFloat(rebuilt, baseOff + 4, patch.PosY.Value);
                    WriteFloat(rebuilt, baseOff + 8, patch.PosZ.Value);
                    break;
                }
                default:
                    throw new InvalidDataException($"未知或尚未支持的 MSB mutation：{patch.Kind}。");
            }
        }
        return rebuilt;
    }

    public object ToEnvelope(MsbRoundTripReport? report = null) => new
    {
        format = "MSB",
        version = Version,
        sourceSize = SourceBytes.Length,
        sourceHash = SourceHash,
        modelCount = Models.Count,
        partCount = Parts.Count,
        regionCount = Regions.Count,
        eventCount = Events.Count,
        partsSectionOffset = PartsSectionOffset,
        firstPartOffset = FirstPartOffset,
        models = Models.Take(64).Select(m => new { m.Name, m.SibPath, m.TypeId, m.Offset }).ToArray(),
        parts = Parts.Take(64).Select(p => new
        {
            p.Name,
            p.Offset,
            p.PosX,
            p.PosY,
            p.PosZ,
            p.RotX,
            p.ScaleX,
            p.ScaleY,
            p.ScaleZ
        }).ToArray(),
        regions = Regions.Take(64).Select(r => new
        {
            r.Name,
            r.Offset,
            r.TypeId,
            r.PosX,
            r.PosY,
            r.PosZ
        }).ToArray(),
        events = Events.Take(64).Select(e => new
        {
            e.Name,
            e.Offset,
            e.TypeId
        }).ToArray(),
        modelsTruncated = Models.Count > 64,
        partsTruncated = Parts.Count > 64,
        regionsTruncated = Regions.Count > 64,
        eventsTruncated = Events.Count > 64,
        roundTrip = report ?? VerifyRoundTrip(),
        // Heuristic section scans do not establish complete native semantics.
        authority = "candidate",
        entityEdit = "part-transform+region-position-supported",
        sceneProjection = "pending-p4-gpu-chunks"
    };

    private static List<MsbModel> ReadModels(byte[] source)
    {
        var models = new List<MsbModel>();
        // 0x10 holds MODEL_PARAM_ST + model entry count; offsets start at 0x18.
        var declared = ReadInt32(source, 0x10);
        if (declared < 1 || declared > MaxModels + 1)
            throw new InvalidDataException($"MSB model 声明数量异常：{declared}。");
        // Skip index 0 (MODEL_PARAM_ST section header).
        for (var i = 1; i < declared; i++)
        {
            var tableOff = 0x18 + i * 8;
            if (tableOff + 8 > source.Length)
                throw new InvalidDataException("MSB model 偏移表越界。");
            var entryOff = ReadInt32(source, tableOff);
            var pad = ReadInt32(source, tableOff + 4);
            if (entryOff <= 0 || entryOff + 0x30 > source.Length || pad != 0)
                throw new InvalidDataException($"MSB model 偏移无效：index={i}。");
            var nameRel = ReadInt32(source, entryOff);
            if (nameRel is < 0x10 or > 0x80)
                throw new InvalidDataException($"MSB model 名称偏移异常：index={i}。");
            var name = ReadUtf16(source, entryOff + nameRel);
            if (string.IsNullOrEmpty(name) || name.Contains("PARAM_ST", StringComparison.Ordinal))
                throw new InvalidDataException($"MSB model 名称无效：index={i}。");
            var sibRel = ReadInt32(source, entryOff + 0x10);
            var typeId = ReadInt32(source, entryOff + 0x18);
            string? sib = null;
            if (sibRel > 0 && entryOff + sibRel + 2 < source.Length)
                sib = ReadUtf16(source, entryOff + sibRel);
            models.Add(new MsbModel(entryOff, name, sib, typeId));
        }
        return models;
    }

    private static (int sectionOffset, int firstPartOffset, List<MsbPart> parts) ReadParts(byte[] source)
    {
        var sectionOffset = FindUtf16(source, "PARTS_PARAM_ST");
        if (sectionOffset < 0)
            throw new InvalidDataException("MSB 未找到 PARTS_PARAM_ST 段。");
        // Section name is UTF-16 "PARTS_PARAM_ST\0" (30 bytes), entries begin at +32.
        var firstPartOffset = sectionOffset + 32;
        if (firstPartOffset + PartEntrySize > source.Length)
            throw new InvalidDataException("MSB PARTS 段过短。");

        var parts = new List<MsbPart>();
        for (var off = firstPartOffset; off + PartEntrySize <= source.Length && parts.Count < MaxParts; off += PartEntrySize)
        {
            var nameRel = ReadInt32(source, off);
            if (nameRel is <= 0 or > 0x400) break;
            var name = ReadUtf16(source, off + nameRel);
            if (string.IsNullOrEmpty(name) || name.Length > 80) break;
            // Disallow section headers mistaken as parts.
            if (name.EndsWith("PARAM_ST", StringComparison.Ordinal)) break;

            var t = off + PartTransformOffset;
            var posX = ReadFloat(source, t);
            var posY = ReadFloat(source, t + 4);
            var posZ = ReadFloat(source, t + 8);
            var rotX = ReadFloat(source, t + 12);
            var scaleX = ReadFloat(source, t + 16);
            var scaleY = ReadFloat(source, t + 20);
            var scaleZ = ReadFloat(source, t + 24);
            // Scale fields are finite for valid map pieces; stop on garbage.
            if (!IsFinite(posX) || !IsFinite(posY) || !IsFinite(posZ)) break;
            parts.Add(new MsbPart(off, name, posX, posY, posZ, rotX, scaleX, scaleY, scaleZ));
        }
        if (parts.Count == 0)
            throw new InvalidDataException("MSB PARTS 段未解析到任何 part。");
        return (sectionOffset, firstPartOffset, parts);
    }

    /// <summary>
    /// POINT_PARAM_ST regions: variable-size entries, common nameRel=0x60, position at +0x14.
    /// Walk scan-forward until ROUTE_PARAM_ST.
    /// </summary>
    private static List<MsbRegion> ReadRegions(byte[] source)
    {
        var sectionOffset = FindUtf16(source, "POINT_PARAM_ST");
        if (sectionOffset < 0) return new List<MsbRegion>();
        var end = FindUtf16(source, "ROUTE_PARAM_ST");
        if (end < 0) end = FindUtf16(source, "PARTS_PARAM_ST");
        if (end <= sectionOffset) return new List<MsbRegion>();

        var regions = new List<MsbRegion>();
        var off = sectionOffset + 0x20;
        while (off + 0x20 < end && regions.Count < MaxRegions)
        {
            if (!IsRegionEntry(source, off, end))
            {
                var found = -1;
                var limit = Math.Min(off + 0x400, end);
                for (var s = off + 4; s < limit; s += 4)
                {
                    if (IsRegionEntry(source, s, end))
                    {
                        found = s;
                        break;
                    }
                }
                if (found < 0) break;
                off = found;
            }

            var nameRel = ReadInt32(source, off);
            var name = ReadUtf16(source, off + nameRel);
            var typeId = ReadInt32(source, off + 8);
            var t = off + RegionTransformOffset;
            var posX = ReadFloat(source, t);
            var posY = ReadFloat(source, t + 4);
            var posZ = ReadFloat(source, t + 8);
            regions.Add(new MsbRegion(off, name, typeId, posX, posY, posZ));

            // Advance past name; next entry discovered by scan.
            var nameBytes = Encoding.Unicode.GetByteCount(name) + 2;
            off = Align4(off + nameRel + nameBytes);
        }
        return regions;
    }

    private static bool IsRegionEntry(byte[] source, int off, int end)
    {
        if (off + 0x20 >= end) return false;
        var nameRel = ReadInt32(source, off);
        if (nameRel is not (0x40 or 0x50 or 0x60 or 0x70 or 0x80 or 0x90 or 0xA0)) return false;
        if (off + nameRel + 2 >= end) return false;
        var name = ReadUtf16(source, off + nameRel);
        if (string.IsNullOrEmpty(name) || name.Length > 100) return false;
        if (name.Contains("PARAM_ST", StringComparison.Ordinal)) return false;
        var typeId = ReadInt32(source, off + 8);
        if (typeId is < -1 or > 64) return false;
        var t = off + RegionTransformOffset;
        return IsFinite(ReadFloat(source, t))
            && IsFinite(ReadFloat(source, t + 4))
            && IsFinite(ReadFloat(source, t + 8))
            && Math.Abs(ReadFloat(source, t)) < 1e6f
            && Math.Abs(ReadFloat(source, t + 4)) < 1e6f
            && Math.Abs(ReadFloat(source, t + 8)) < 1e6f;
    }

    /// <summary>
    /// EVENT_PARAM_ST map events: fixed 0xA0 stride on Sekiro m10 sample.
    /// </summary>
    private static List<MsbMapEvent> ReadMapEvents(byte[] source)
    {
        var sectionOffset = FindUtf16(source, "EVENT_PARAM_ST");
        if (sectionOffset < 0) return new List<MsbMapEvent>();
        var end = FindUtf16(source, "POINT_PARAM_ST");
        if (end < 0) end = FindUtf16(source, "ROUTE_PARAM_ST");
        if (end <= sectionOffset) return new List<MsbMapEvent>();

        var events = new List<MsbMapEvent>();
        var first = sectionOffset + 0x20;
        for (var off = first; off + EventEntrySize <= end && events.Count < MaxEvents; off += EventEntrySize)
        {
            var nameRel = ReadInt32(source, off);
            if (nameRel is < 0x20 or > 0x100) break;
            var name = ReadUtf16(source, off + nameRel);
            if (string.IsNullOrEmpty(name) || name.Length > 80) break;
            if (name.Contains("PARAM_ST", StringComparison.Ordinal)) break;
            var typeId = ReadInt32(source, off + 8);
            events.Add(new MsbMapEvent(off, name, typeId));
        }
        return events;
    }

    private static int Align4(int value) => (value + 3) & ~3;

    private static int FindUtf16(byte[] source, string text)
    {
        var needle = Encoding.Unicode.GetBytes(text + "\0");
        var span = source.AsSpan();
        for (var i = 0; i <= source.Length - needle.Length; i += 2)
        {
            if (span.Slice(i, needle.Length).SequenceEqual(needle)) return i;
        }
        return -1;
    }

    private static string ReadUtf16(byte[] source, int offset)
    {
        if (offset < 0 || offset + 2 > source.Length) return string.Empty;
        var end = offset;
        while (end + 1 < source.Length && !(source[end] == 0 && source[end + 1] == 0))
        {
            end += 2;
            if (end - offset > 512) throw new InvalidDataException("MSB UTF-16 字符串过长。");
        }
        return Encoding.Unicode.GetString(source, offset, end - offset);
    }

    private static bool IsFinite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
    private static bool Nearly(float a, float b) => Math.Abs(a - b) <= 0.0001f;
    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static float ReadFloat(byte[] source, int offset) => BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(offset, 4));
    private static void WriteFloat(byte[] target, int offset, float value) => BinaryPrimitives.WriteSingleLittleEndian(target.AsSpan(offset, 4), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record MsbModel(int Offset, string Name, string? SibPath, int TypeId);
internal sealed record MsbPart(
    int Offset,
    string Name,
    float PosX,
    float PosY,
    float PosZ,
    float RotX,
    float ScaleX,
    float ScaleY,
    float ScaleZ);
internal sealed record MsbRegion(
    int Offset,
    string Name,
    int TypeId,
    float PosX,
    float PosY,
    float PosZ);
internal sealed record MsbMapEvent(
    int Offset,
    string Name,
    int TypeId);
internal sealed record MsbPatch(
    string Kind,
    string PartName,
    float? PosX,
    float? PosY,
    float? PosZ,
    float? RotX,
    float? ScaleX,
    float? ScaleY,
    float? ScaleZ);
internal sealed record MsbRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int Version,
    int ModelCount,
    int PartCount,
    int SourceSize);

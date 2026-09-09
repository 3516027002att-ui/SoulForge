using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// GPARAM 值类型（Sekiro 版，与 SoulsFormats ParamType 一一对应）。
/// </summary>
internal enum GparamValueType : byte
{
    /// <summary>单个 u8。</summary>
    Byte = 0x1,
    /// <summary>单个 i16。</summary>
    Short = 0x2,
    /// <summary>单个 i32。</summary>
    IntA = 0x3,
    /// <summary>单个 bool。</summary>
    BoolA = 0x5,
    /// <summary>单个 i32。</summary>
    IntB = 0x7,
    /// <summary>单个 f32。</summary>
    Float = 0x9,
    /// <summary>单个 bool。</summary>
    BoolB = 0xB,
    /// <summary>两个 f32 + 8 个保留字节（必须为 0）。</summary>
    Float2 = 0xC,
    /// <summary>三个 f32 + 4 个保留字节（必须为 0）。</summary>
    Float3 = 0xD,
    /// <summary>四个 f32。</summary>
    Float4 = 0xE,
    /// <summary>四个字节，BGRA。</summary>
    Byte4 = 0xF,
}

/// <summary>GPARAM 值类型的尺寸表（读与写共用，避免两处定义漂移）。</summary>
internal static class GparamValueTypeSizes
{
    public static int SizeOf(GparamValueType type) => type switch
    {
        GparamValueType.Byte => 1,
        GparamValueType.Short => 2,
        GparamValueType.IntA => 4,
        GparamValueType.BoolA => 1,
        GparamValueType.IntB => 4,
        GparamValueType.Float => 4,
        GparamValueType.BoolB => 1,
        // Float2 = 2×f32 + 8 保留；Float3 = 3×f32 + 4 保留；Float4 = 4×f32。
        GparamValueType.Float2 => 16,
        GparamValueType.Float3 => 16,
        GparamValueType.Float4 => 16,
        GparamValueType.Byte4 => 4,
        _ => throw new InvalidDataException($"未知 GPARAM 值类型 {(int)type}。")
    };

    /// <summary>该类型承载的 f32/分量数（Byte4 为 4 个 u8，其余单值为 1）。</summary>
    public static int FloatCount(GparamValueType type) => type switch
    {
        GparamValueType.Byte4 => 4,
        GparamValueType.Float2 => 2,
        GparamValueType.Float3 => 3,
        GparamValueType.Float4 => 4,
        _ => 1
    };
}

/// <summary>
/// GPARAM 里的一个参数：同一组值控制同一图形参数的多个情景。
/// </summary>
internal sealed class GparamParam
{
    public required string Name1 { get; init; }
    public required string Name2 { get; init; }
    public required GparamValueType Type { get; init; }
    public required int ValueCount { get; init; }
    /// <summary>解码后的值：byte/short/int/float → 数值；bool → 0/1；byte4 → 4 个 0-255；float2/3/4 → 2/3/4 个 f32。double 同时精确表示 int32 与 float 的位模式，写回无损。</summary>
    public required double[] Values { get; init; }
    public required int[] ValueIds { get; init; }
    public required float[] UnkFloats { get; init; }
    public int TypeSize => GparamValueTypeSizes.SizeOf(Type);
}

/// <summary>GPARAM 里的一个 group（编辑面板），含 0..N 个 param。</summary>
internal sealed class GparamGroup
{
    public required string Name1 { get; init; }
    public required string Name2 { get; init; }
    public required IReadOnlyList<GparamParam> Params { get; init; }
}

/// <summary>
/// Sekiro GPARAM（.gparam / .gparam.dcx）无损文档。
///
/// 布局从零逆向，来源为真实语料 mods/param/drawparam/*.gparam.dcx：
/// m10_00_0001 与 m15_00_0001 双样本逐字段解析一致，并与 SoulsFormats
/// GPARAM.cs（社区权威 writer，仅作行为对照、不复制实现）交叉验证。
///
/// Header（0x54 字节，Sekiro v5）:
///   0x00 "filt" UTF-16LE（8 字节）
///   0x08 game = 5（Sekiro）
///   0x0C u8 0；0x0D bool Unk0D；0x0E-0x0F i16 0
///   0x10 groupCount；0x14 Unk14
///   0x18 HeaderSize（0x54）
///   0x1C GroupHeadersOffset（group 头区）
///   0x20 ParamHeaderOffsetsOffset（param 头偏移表区）
///   0x24 ParamHeadersOffset（param 头区）
///   0x28 ValuesOffset；0x2C ValueIDsOffset
///   0x30 Unk2Offset（=Unk3Offset 时 UnkBlock2 为空）
///   0x34 Unk3Count；0x38 Unk3Offset；0x3C Unk3ValueIDsOffset
///   0x40 u32 0（断言）
///   0x44 CommentOffsetsOffsetsOffset；0x48 CommentOffsetsOffset
///   0x4C CommentsOffset；0x50 Unk50（f32，仅 Sekiro）
///
/// 区布局（实测 m10_00_0001）:
///   0x54   GroupHeaders 偏移表（groupCount × i32，相对 group 头区）
///   0xB0   group 头：paramCount、paramHeaderOffsetsOffset（相对
///          param 头偏移表区）、Name1 UTF-16、Name2 UTF-16、pad4
///   0x71C  param 头偏移表（每 group paramCount × i32，相对 param 头区）
///   0x828  param 头：valuesOffset（相对 Values 区）、valueIDsOffset
///          （相对 ValueIDs 区）、type u8、valueCount u8、0、0、Name1、
///          Name2、pad4
///   0x2470 Values 区：每 param valueCount × TypeSize，pad4
///   0x284C ValueIDs 区：每 param valueCount ×（i32 + f32）[Sekiro]
///   0x2C14 UnkBlock2（Unk2..Unk3 原始字节，本实现无损保留）
///   0x2C14 Unk3 头区（unk3Count × 16：groupIndex、count、valueIDsOffset、
///           Unk0C）
///   0x2D84 Unk3 值区
///   0x2DB0 CommentOffsetsOffsets（groupCount × i32，相对 CommentOffsets 区）
///   0x2E0C CommentOffsets（相对 Comments 区）
///   0x2E38 Comments（UTF-16 串，pad4）
///
/// 本解析器不借用 PARAM parser：GPARAM 的 group/param 嵌套、值类型与
/// PARAM 行/paramdef 是两套独立格式家族。
/// </summary>
internal sealed class GparamNativeDocument
{
    private const int HeaderSize = 0x54;
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private const int MaxGroups = 4096;
    private const int MaxParams = 4096;
    private const int MaxValueCount = 4096;
    private const int MaxNameBytes = 4096;

    private readonly int _unk3SourceOffset;

    private GparamNativeDocument(
        byte[] sourceBytes,
        bool unk0D,
        int groupCount,
        int unk14,
        int unk3Count,
        float unk50,
        int unk3SourceOffset,
        byte[] unkBlock2,
        IReadOnlyList<string>[] commentGroups,
        IReadOnlyList<GparamGroup> groups)
    {
        SourceBytes = sourceBytes;
        Unk0D = unk0D;
        GroupCount = groupCount;
        Unk14 = unk14;
        Unk3Count = unk3Count;
        Unk50 = unk50;
        _unk3SourceOffset = unk3SourceOffset;
        UnkBlock2 = unkBlock2;
        CommentGroups = commentGroups;
        Groups = groups;
    }

    public byte[] SourceBytes { get; }
    public bool Unk0D { get; }
    public int GroupCount { get; }
    public int Unk14 { get; }
    public int Unk3Count { get; }
    public float Unk50 { get; }
    /// <summary>Unk2..Unk3 之间的原始字节（结构未解析，无损保留）。</summary>
    public byte[] UnkBlock2 { get; }
    /// <summary>每 group 的注释列表。</summary>
    public IReadOnlyList<string>[] CommentGroups { get; }
    public IReadOnlyList<GparamGroup> Groups { get; }
    public string SourceHash => Hash(SourceBytes);

    public static GparamNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"GPARAM 大小 {source.Length} 超出安全范围。");
        if (source.Length < 8 || source[0] != 0x66 || source[1] != 0x00
            || source[2] != 0x69 || source[3] != 0x00
            || source[4] != 0x6c || source[5] != 0x00
            || source[6] != 0x74 || source[7] != 0x00)
            throw new InvalidDataException("GPARAM magic 不是 UTF-16LE \"filt\"。");
        var game = ReadUInt32(source, 0x08);
        if (game != 5)
            throw new NotSupportedException($"仅支持 Sekiro GPARAM（game=5），收到 game={game}。");
        if (source[0x0C] != 0)
            throw new InvalidDataException("GPARAM 头 0x0C 应为 0。");
        if (ReadInt32(source, 0x18) != HeaderSize)
            throw new InvalidDataException($"GPARAM 头大小不是 {HeaderSize}。");

        var groupCount = ReadInt32(source, 0x10);
        if (groupCount < 0 || groupCount > MaxGroups)
            throw new InvalidDataException($"GPARAM group 数 {groupCount} 超出安全范围。");
        var unk14 = ReadInt32(source, 0x14);
        var groupHeadersOffset = ReadInt32(source, 0x1C);
        var paramHeaderOffsetsOffset = ReadInt32(source, 0x20);
        var paramHeadersOffset = ReadInt32(source, 0x24);
        var valuesOffset = ReadInt32(source, 0x28);
        var valueIdsOffset = ReadInt32(source, 0x2C);
        var unk2Offset = ReadInt32(source, 0x30);
        var unk3Count = ReadInt32(source, 0x34);
        var unk3Offset = ReadInt32(source, 0x38);
        var unk3ValueIdsOffset = ReadInt32(source, 0x3C);
        var commentOffsetsOffsetsOffset = ReadInt32(source, 0x44);
        var commentOffsetsOffset = ReadInt32(source, 0x48);
        var commentsOffset = ReadInt32(source, 0x4C);
        var unk50 = ReadSingle(source, 0x50);
        if (unk3Count < 0 || unk3Count > MaxGroups)
            throw new InvalidDataException($"GPARAM unk3 数 {unk3Count} 超出安全范围。");

        // 区域偏移必须严格递增且落在文件内。
        var regions = new[]
        {
            HeaderSize + groupCount * 4, groupHeadersOffset, paramHeaderOffsetsOffset,
            paramHeadersOffset, valuesOffset, valueIdsOffset, unk2Offset, unk3Offset,
            unk3ValueIdsOffset, commentOffsetsOffsetsOffset, commentOffsetsOffset,
            commentsOffset, source.Length
        };
        for (var i = 1; i < regions.Length; i++)
        {
            if (regions[i - 1] > regions[i] || regions[i] > source.Length)
                throw new InvalidDataException("GPARAM 区域偏移顺序非法。");
        }

        var groups = new List<GparamGroup>(groupCount);
        for (var g = 0; g < groupCount; g++)
        {
            var groupHeaderOffset = ReadInt32(source, HeaderSize + g * 4);
            var gh = groupHeadersOffset + groupHeaderOffset;
            if (gh < groupHeadersOffset || gh + 8 > source.Length)
                throw new InvalidDataException($"GPARAM group {g} 头偏移越界。");
            var paramCount = ReadInt32(source, gh);
            if (paramCount < 0 || paramCount > MaxParams)
                throw new InvalidDataException($"GPARAM group {g} param 数 {paramCount} 超出安全范围。");
            var paramHeaderOffsetsRel = ReadInt32(source, gh + 4);
            var name1 = ReadUtf16Z(source, gh + 8, g, "group");
            var name2 = ReadUtf16Z(source, gh + 8 + Utf16ZLength(name1), g, "group");
            // param 头偏移表必须完整落在 param 头偏移表区内。
            if (paramHeaderOffsetsRel < 0
                || (long)paramHeaderOffsetsRel + paramCount * 4 > paramHeadersOffset - paramHeaderOffsetsOffset)
                throw new InvalidDataException($"GPARAM group {g} param 头偏移表越界。");

            var paramsInGroup = new List<GparamParam>(paramCount);
            for (var p = 0; p < paramCount; p++)
            {
                var paramHeaderOffset = ReadInt32(source, paramHeaderOffsetsOffset + paramHeaderOffsetsRel + p * 4);
                var ph = paramHeadersOffset + paramHeaderOffset;
                if (ph < paramHeadersOffset || ph + 12 > source.Length)
                    throw new InvalidDataException($"GPARAM group {g} param {p} 头偏移越界。");
                var valuesRel = ReadInt32(source, ph);
                var valueIdsRel = ReadInt32(source, ph + 4);
                var type = (GparamValueType)source[ph + 8];
                var valueCount = source[ph + 9];
                if (valueCount < 0 || valueCount > MaxValueCount)
                    throw new InvalidDataException($"GPARAM group {g} param {p} 值数 {valueCount} 超出安全范围。");
                var pName1 = ReadUtf16Z(source, ph + 12, p, "param");
                var pName2 = ReadUtf16Z(source, ph + 12 + Utf16ZLength(pName1), p, "param");

                var typeSize = GparamValueTypeSizes.SizeOf(type);
                var floatCount = GparamValueTypeSizes.FloatCount(type);
                var values = new double[valueCount * floatCount];
                var vBase = valuesOffset + valuesRel;
                if (vBase < valuesOffset || vBase + (long)valueCount * typeSize > source.Length)
                    throw new InvalidDataException($"GPARAM group {g} param {p} 值区越界。");
                for (var k = 0; k < valueCount; k++)
                {
                    var o = vBase + k * typeSize;
                    switch (type)
                    {
                        case GparamValueType.Byte:
                            values[k] = source[o];
                            break;
                        case GparamValueType.Short:
                            values[k] = ReadInt16(source, o);
                            break;
                        case GparamValueType.BoolA:
                        case GparamValueType.BoolB:
                            values[k] = source[o] != 0 ? 1 : 0;
                            break;
                        case GparamValueType.Byte4:
                            for (var b = 0; b < 4; b++) values[k * 4 + b] = source[o + b];
                            break;
                        case GparamValueType.Float:
                            values[k] = ReadSingle(source, o);
                            break;
                        case GparamValueType.Float2:
                        case GparamValueType.Float3:
                        case GparamValueType.Float4:
                            for (var c = 0; c < floatCount; c++)
                                values[k * floatCount + c] = ReadSingle(source, o + c * 4);
                            // 保留字节必须为 0（格式断言），否则重建无法无损。
                            for (var r = floatCount * 4; r < typeSize; r++)
                            {
                                if (source[o + r] != 0)
                                    throw new InvalidDataException($"GPARAM group {g} param {p} 值保留字节非零。");
                            }
                            break;
                        default:
                            // IntA/IntB：double 精确表示 int32，写回无损
                            values[k] = ReadInt32(source, o);
                            break;
                    }
                }

                var idsBase = valueIdsOffset + valueIdsRel;
                if (idsBase < valueIdsOffset || idsBase + (long)valueCount * 8 > source.Length)
                    throw new InvalidDataException($"GPARAM group {g} param {p} 值 ID 区越界。");
                var valueIds = new int[valueCount];
                var unkFloats = new float[valueCount];
                for (var k = 0; k < valueCount; k++)
                {
                    valueIds[k] = ReadInt32(source, idsBase + k * 8);
                    unkFloats[k] = ReadSingle(source, idsBase + k * 8 + 4);
                }

                paramsInGroup.Add(new GparamParam
                {
                    Name1 = pName1,
                    Name2 = pName2,
                    Type = type,
                    ValueCount = valueCount,
                    Values = values,
                    ValueIds = valueIds,
                    UnkFloats = unkFloats
                });
            }
            groups.Add(new GparamGroup { Name1 = name1, Name2 = name2, Params = paramsInGroup });
        }

        if (unk2Offset < 0 || unk3Offset < unk2Offset)
            throw new InvalidDataException("GPARAM UnkBlock2 区间非法。");
        var unkBlock2 = source.AsSpan(unk2Offset, unk3Offset - unk2Offset).ToArray();

        // Unk3 区结构校验：groupIndex、count、valueIDsOffset、unk0C。
        for (var u = 0; u < unk3Count; u++)
        {
            var o = unk3Offset + u * 16;
            if (o + 16 > source.Length)
                throw new InvalidDataException($"GPARAM unk3 {u} 越界。");
            var groupIndex = ReadInt32(source, o);
            var count = ReadInt32(source, o + 4);
            if (groupIndex < 0 || groupIndex >= groupCount)
                throw new InvalidDataException($"GPARAM unk3 {u} groupIndex {groupIndex} 越界。");
            if (count < 0 || count > MaxValueCount)
                throw new InvalidDataException($"GPARAM unk3 {u} count {count} 超出安全范围。");
            var valueIdsRel = ReadInt32(source, o + 8);
            var base2 = unk3ValueIdsOffset + valueIdsRel;
            if (base2 < unk3ValueIdsOffset || base2 + count * 4 > source.Length)
                throw new InvalidDataException($"GPARAM unk3 {u} 值区越界。");
        }

        // Comments：偏移表相对 CommentOffsets 区，串相对 Comments 区。
        var commentGroups = new IReadOnlyList<string>[groupCount];
        for (var g = 0; g < groupCount; g++)
        {
            var offsetsOff = ReadInt32(source, commentOffsetsOffsetsOffset + g * 4);
            var nextOff = g + 1 < groupCount
                ? ReadInt32(source, commentOffsetsOffsetsOffset + (g + 1) * 4)
                : commentsOffset - commentOffsetsOffset;
            if (offsetsOff < 0 || nextOff < offsetsOff || (nextOff - offsetsOff) % 4 != 0)
                throw new InvalidDataException($"GPARAM comment 偏移表越界（group {g}）。");
            var commentCount = (nextOff - offsetsOff) / 4;
            var comments = new List<string>(commentCount);
            for (var c = 0; c < commentCount; c++)
            {
                var commentRel = ReadInt32(source, commentOffsetsOffset + offsetsOff + c * 4);
                if (commentRel < 0 || commentsOffset + commentRel >= source.Length)
                    throw new InvalidDataException($"GPARAM comment {g}:{c} 越界。");
                comments.Add(ReadUtf16Z(source, commentsOffset + commentRel, c, "comment"));
            }
            commentGroups[g] = comments;
        }

        return new GparamNativeDocument(
            source, source[0x0D] != 0, groupCount, unk14, unk3Count, unk50,
            unk3Offset, unkBlock2, commentGroups, groups);
    }

    public static GparamNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("GPARAM 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"GPARAM 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    public GparamRoundTripReport VerifyRoundTrip()
    {
        var rebuilt = Rebuild();
        GparamNativeDocument reparsed;
        try
        {
            reparsed = Read(rebuilt);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException)
        {
            return new GparamRoundTripReport(false, false, SourceHash, Hash(rebuilt),
                GroupCount, TotalParamCount, TotalValueCount, ex.Message);
        }
        var semantic = GroupsEqual(Groups, reparsed.Groups)
            // List<string> 未重写 Equals，SequenceEqual 会做引用比较 —— 必须逐元素比较内容
            && CommentGroups.Zip(reparsed.CommentGroups).All(pair => pair.First.SequenceEqual(pair.Second))
            && UnkBlock2.AsSpan().SequenceEqual(reparsed.UnkBlock2);
        return new GparamRoundTripReport(
            SourceBytes.AsSpan().SequenceEqual(rebuilt),
            semantic,
            SourceHash,
            Hash(rebuilt),
            GroupCount,
            TotalParamCount,
            TotalValueCount,
            null);
    }

    /// <summary>
    /// 按格式规则完整重建字节。Unk0D/Unk14/Unk50 取解析值，UnkBlock2 与
    /// Unk3 区原样保留，因此无修改重建应与源字节一致。
    /// </summary>
    /// <summary>
    /// 返回 groups 被替换后的新文档实例（其余头字段、Unk 区、注释原样保留）。
    ///
    /// 供 GparamNativeWriter 使用：typed field-set 只改目标 param 的 Values，
    /// 其余字节不动 —— 通过「替换 groups → Rebuild」完成，而不是直接改源字节
    /// （那样要重算全部偏移，等价于手写一遍 PlanOffsets）。
    /// </summary>
    public GparamNativeDocument WithGroups(IReadOnlyList<GparamGroup> groups)
    {
        return new GparamNativeDocument(
            SourceBytes,
            Unk0D,
            groups.Count,
            Unk14,
            Unk3Count,
            Unk50,
            _unk3SourceOffset,
            UnkBlock2,
            CommentGroups,
            groups);
    }

    public byte[] Rebuild()
    {
        var plan = PlanOffsets();
        var rebuilt = new byte[plan.FileSize];
        WriteHeader(rebuilt, plan);
        WriteGroups(rebuilt, plan);
        WriteParams(rebuilt, plan);
        WriteValues(rebuilt, plan);
        WriteValueIds(rebuilt, plan);
        // UnkBlock2 原样
        UnkBlock2.CopyTo(rebuilt, plan.Unk2Start);
        // Unk3 头区 + 值区原样（结构未解析、未变更，整体搬移）
        var unk3Bytes = Unk3SourceBytes();
        unk3Bytes.CopyTo(rebuilt, plan.Unk3Start);
        WriteComments(rebuilt, plan);
        return rebuilt;
    }

    private GparamLayoutPlan PlanOffsets()
    {
        var totalParams = TotalParamCount;
        // group 头区起点（= header 0x1C 的值，group 头偏移表固定位于 HeaderSize）
        var groupHeadersStart = HeaderSize + GroupCount * 4;
        var cursor = groupHeadersStart;
        var groupHeaderOffsets = new int[GroupCount];
        var paramHeaderTableOffsets = new int[GroupCount];
        var paramHeaderOffsets = new int[totalParams];
        var valuesRel = new int[totalParams];
        var valueIdsRel = new int[totalParams];
        var paramIndex = 0;
        for (var g = 0; g < GroupCount; g++)
        {
            var group = Groups[g];
            groupHeaderOffsets[g] = cursor - groupHeadersStart;
            cursor += 8 + Utf16ZLength(group.Name1) + Utf16ZLength(group.Name2);
            cursor = Pad4(cursor);
        }
        // param 头偏移表区起点 = group 头区结束（= header 0x20）
        var paramHeaderOffsetsStart = cursor;
        var tableCursor = paramHeaderOffsetsStart;
        for (var g = 0; g < GroupCount; g++)
        {
            paramHeaderTableOffsets[g] = tableCursor;
            tableCursor += Groups[g].Params.Count * 4;
        }
        // param 头区起点 = 偏移表区 + 全部偏移表（= header 0x24）
        var paramHeadersStart = paramHeaderOffsetsStart + totalParams * 4;
        cursor = paramHeadersStart;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var param in Groups[g].Params)
            {
                paramHeaderOffsets[paramIndex] = cursor - paramHeadersStart;
                cursor += 12 + Utf16ZLength(param.Name1) + Utf16ZLength(param.Name2);
                cursor = Pad4(cursor);
                paramIndex++;
            }
        }
        var valuesStart = cursor;
        paramIndex = 0;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var param in Groups[g].Params)
            {
                valuesRel[paramIndex] = cursor - valuesStart;
                cursor += param.ValueCount * param.TypeSize;
                cursor = Pad4(cursor);
                paramIndex++;
            }
        }
        var valueIdsStart = cursor;
        paramIndex = 0;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var param in Groups[g].Params)
            {
                valueIdsRel[paramIndex] = cursor - valueIdsStart;
                cursor += param.ValueCount * 8;
                paramIndex++;
            }
        }
        var unk2Start = cursor;
        cursor += UnkBlock2.Length;
        var unk3Start = cursor;
        var unk3ValueIdsStart = cursor + Unk3Count * 16;
        // Unk3 值区总字节数（从源 Unk3 头算 count 之和）
        var unk3ValuesTotal = 0;
        for (var u = 0; u < Unk3Count; u++)
            unk3ValuesTotal += ReadInt32(SourceBytes, _unk3SourceOffset + u * 16 + 4);
        cursor = unk3ValueIdsStart + unk3ValuesTotal * 4;
        var commentOffsetsOffsetsStart = cursor;
        var commentOffsetsStart = commentOffsetsOffsetsStart + GroupCount * 4;
        var commentTotal = 0;
        for (var g = 0; g < GroupCount; g++) commentTotal += CommentGroups[g].Count;
        var commentsStart = commentOffsetsStart + commentTotal * 4;
        cursor = commentsStart;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var comment in CommentGroups[g])
            {
                cursor += Utf16ZLength(comment);
                cursor = Pad4(cursor);
            }
        }

        return new GparamLayoutPlan(
            groupHeaderOffsets, paramHeaderTableOffsets, paramHeaderOffsets,
            valuesRel, valueIdsRel, cursor,
            groupHeadersStart, paramHeaderOffsetsStart, paramHeadersStart,
            valuesStart, valueIdsStart, unk2Start, unk3Start, unk3ValueIdsStart,
            commentOffsetsOffsetsStart, commentOffsetsStart, commentsStart);
    }

    private void WriteHeader(byte[] target, GparamLayoutPlan plan)
    {
        WriteUtf16Raw(target, 0, "filt");
        WriteInt32(target, 0x08, 5);
        target[0x0C] = 0;
        target[0x0D] = Unk0D ? (byte)1 : (byte)0;
        WriteInt16(target, 0x0E, 0);
        WriteInt32(target, 0x10, GroupCount);
        WriteInt32(target, 0x14, Unk14);
        WriteInt32(target, 0x18, HeaderSize);
        WriteInt32(target, 0x1C, plan.GroupHeadersStart);
        WriteInt32(target, 0x20, plan.ParamHeaderOffsetsStart);
        WriteInt32(target, 0x24, plan.ParamHeadersStart);
        WriteInt32(target, 0x28, plan.ValuesStart);
        WriteInt32(target, 0x2C, plan.ValueIdsStart);
        WriteInt32(target, 0x30, plan.Unk2Start);
        WriteInt32(target, 0x34, Unk3Count);
        WriteInt32(target, 0x38, plan.Unk3Start);
        WriteInt32(target, 0x3C, plan.Unk3ValueIdsStart);
        WriteInt32(target, 0x40, 0);
        WriteInt32(target, 0x44, plan.CommentOffsetsOffsetsStart);
        WriteInt32(target, 0x48, plan.CommentOffsetsStart);
        WriteInt32(target, 0x4C, plan.CommentsStart);
        WriteSingle(target, 0x50, Unk50);
    }

    private void WriteGroups(byte[] target, GparamLayoutPlan plan)
    {
        // group 头偏移表固定在 HeaderSize 处，偏移相对 group 头区
        for (var g = 0; g < GroupCount; g++)
            WriteInt32(target, HeaderSize + g * 4, plan.GroupHeaderOffsets[g]);
        var cursor = plan.GroupHeadersStart;
        for (var g = 0; g < GroupCount; g++)
        {
            var group = Groups[g];
            WriteInt32(target, cursor, group.Params.Count);
            WriteInt32(target, cursor + 4, plan.ParamHeaderTableOffsets[g] - plan.ParamHeaderOffsetsStart);
            WriteUtf16Z(target, cursor + 8, group.Name1);
            cursor += 8 + Utf16ZLength(group.Name1);
            WriteUtf16Z(target, cursor, group.Name2);
            cursor += Utf16ZLength(group.Name2);
            cursor = Pad4(cursor);
        }
    }

    private void WriteParams(byte[] target, GparamLayoutPlan plan)
    {
        // param 头偏移表（每 group）
        var tableCursor = plan.ParamHeaderOffsetsStart;
        var paramIndex = 0;
        for (var g = 0; g < GroupCount; g++)
        {
            for (var p = 0; p < Groups[g].Params.Count; p++)
            {
                WriteInt32(target, tableCursor, plan.ParamHeaderOffsets[paramIndex]);
                tableCursor += 4;
                paramIndex++;
            }
        }
        // param 头
        var cursor = plan.ParamHeadersStart;
        paramIndex = 0;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var param in Groups[g].Params)
            {
                WriteInt32(target, cursor, plan.ValuesRel[paramIndex]);
                WriteInt32(target, cursor + 4, plan.ValueIdsRel[paramIndex]);
                target[cursor + 8] = (byte)param.Type;
                target[cursor + 9] = (byte)param.ValueCount;
                target[cursor + 10] = 0;
                target[cursor + 11] = 0;
                WriteUtf16Z(target, cursor + 12, param.Name1);
                cursor += 12 + Utf16ZLength(param.Name1);
                WriteUtf16Z(target, cursor, param.Name2);
                cursor += Utf16ZLength(param.Name2);
                cursor = Pad4(cursor);
                paramIndex++;
            }
        }
    }

    private void WriteValues(byte[] target, GparamLayoutPlan plan)
    {
        var cursor = plan.ValuesStart;
        var paramIndex = 0;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var param in Groups[g].Params)
            {
                var o = cursor;
                var typeSize = param.TypeSize;
                var floatCount = GparamValueTypeSizes.FloatCount(param.Type);
                for (var k = 0; k < param.ValueCount; k++)
                {
                    switch (param.Type)
                    {
                        case GparamValueType.Byte:
                            target[o] = (byte)param.Values[k];
                            break;
                        case GparamValueType.Short:
                            WriteInt16(target, o, (short)param.Values[k]);
                            break;
                        case GparamValueType.BoolA:
                        case GparamValueType.BoolB:
                            target[o] = param.Values[k] != 0 ? (byte)1 : (byte)0;
                            break;
                        case GparamValueType.Byte4:
                            for (var b = 0; b < 4; b++) target[o + b] = (byte)param.Values[k * 4 + b];
                            break;
                        case GparamValueType.Float:
                            WriteSingle(target, o, (float)param.Values[k]);
                            break;
                        case GparamValueType.Float2:
                        case GparamValueType.Float3:
                        case GparamValueType.Float4:
                            for (var c = 0; c < floatCount; c++)
                                WriteSingle(target, o + c * 4, (float)param.Values[k * floatCount + c]);
                            // 保留字节为 0（解析时已断言）
                            for (var r = floatCount * 4; r < typeSize; r++) target[o + r] = 0;
                            break;
                        default:
                            // IntA/IntB：(int)double 精确还原 int32
                            WriteInt32(target, o, (int)param.Values[k]);
                            break;
                    }
                    o += typeSize;
                }
                cursor += param.ValueCount * typeSize;
                cursor = Pad4(cursor);
                paramIndex++;
            }
        }
    }

    private void WriteValueIds(byte[] target, GparamLayoutPlan plan)
    {
        var cursor = plan.ValueIdsStart;
        for (var g = 0; g < GroupCount; g++)
        {
            foreach (var param in Groups[g].Params)
            {
                var o = cursor;
                for (var k = 0; k < param.ValueCount; k++)
                {
                    WriteInt32(target, o, param.ValueIds[k]);
                    WriteSingle(target, o + 4, param.UnkFloats[k]);
                    o += 8;
                }
                cursor += param.ValueCount * 8;
            }
        }
    }

    private void WriteComments(byte[] target, GparamLayoutPlan plan)
    {
        var cursor = plan.CommentOffsetsOffsetsStart;
        var commentOffsetsCursor = plan.CommentOffsetsStart;
        var commentsCursor = plan.CommentsStart;
        for (var g = 0; g < GroupCount; g++)
        {
            WriteInt32(target, cursor, commentOffsetsCursor - plan.CommentOffsetsStart);
            foreach (var comment in CommentGroups[g])
            {
                WriteInt32(target, commentOffsetsCursor, commentsCursor - plan.CommentsStart);
                commentOffsetsCursor += 4;
                WriteUtf16Z(target, commentsCursor, comment);
                commentsCursor += Utf16ZLength(comment);
                commentsCursor = Pad4(commentsCursor);
            }
            cursor += 4;
        }
    }

    private byte[] Unk3SourceBytes()
    {
        var unk3ValuesTotal = 0;
        for (var u = 0; u < Unk3Count; u++)
            unk3ValuesTotal += ReadInt32(SourceBytes, _unk3SourceOffset + u * 16 + 4);
        var unk3ValueIdsStart = ReadInt32(SourceBytes, 0x3C);
        var end = unk3ValueIdsStart + unk3ValuesTotal * 4;
        if (end > SourceBytes.Length)
            throw new InvalidDataException("GPARAM Unk3 值区越界。");
        return SourceBytes.AsSpan(_unk3SourceOffset, end - _unk3SourceOffset).ToArray();
    }

    private int TotalParamCount => Groups.Sum(g => g.Params.Count);
    private int TotalValueCount => Groups.Sum(g => g.Params.Sum(p => p.ValueCount));

    private static bool GroupsEqual(IReadOnlyList<GparamGroup> a, IReadOnlyList<GparamGroup> b)
    {
        if (a.Count != b.Count) return false;
        for (var g = 0; g < a.Count; g++)
        {
            if (a[g].Name1 != b[g].Name1 || a[g].Name2 != b[g].Name2) return false;
            var pa = a[g].Params;
            var pb = b[g].Params;
            if (pa.Count != pb.Count) return false;
            for (var p = 0; p < pa.Count; p++)
            {
                var x = pa[p];
                var y = pb[p];
                if (x.Name1 != y.Name1 || x.Name2 != y.Name2 || x.Type != y.Type
                    || x.ValueCount != y.ValueCount
                    || !x.Values.AsSpan().SequenceEqual(y.Values)
                    || !x.ValueIds.AsSpan().SequenceEqual(y.ValueIds)
                    || !x.UnkFloats.AsSpan().SequenceEqual(y.UnkFloats))
                    return false;
            }
        }
        return true;
    }

    /// <summary>
    /// 分页 envelope。groupPageSize &gt; 0 时只返回请求的 group 页；
    /// param 值始终全量（单 param 值数 ≤ 255，最大 255 × 16 字节 ≈ 4 KB）。
    /// </summary>
    public object ToEnvelope(GparamRoundTripReport? report = null, int groupPage = 0, int groupPageSize = 0)
    {
        var totalGroups = Groups.Count;
        var effectivePageSize = groupPageSize > 0 ? groupPageSize : totalGroups;
        var pageCount = effectivePageSize > 0 ? (int)Math.Ceiling((double)totalGroups / effectivePageSize) : 1;
        var clampedPage = Math.Clamp(groupPage, 0, Math.Max(0, pageCount - 1));
        var firstGroup = clampedPage * effectivePageSize;
        var pageGroups = Groups.Skip(firstGroup).Take(effectivePageSize).ToArray();

        return new
        {
            format = "GPARAM",
            game = "sekiro",
            groupCount = totalGroups,
            unk14 = Unk14,
            unk50 = Unk50,
            unk0D = Unk0D,
            unk3Count = Unk3Count,
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            groups = pageGroups.Select((group, i) => new
            {
                groupId = firstGroup + i,
                name1 = group.Name1,
                name2 = group.Name2,
                paramCount = group.Params.Count,
                comments = CommentGroups[firstGroup + i],
                paramPreviewLimit = 64,
                @params = group.Params.Select((param, j) => new
                {
                    paramId = j,
                    name1 = param.Name1,
                    name2 = param.Name2,
                    type = TypeName(param.Type),
                    typeCode = (int)param.Type,
                    valueCount = param.ValueCount,
                    values = param.Values,
                    valueIds = param.ValueIds,
                    unkFloats = param.UnkFloats
                }).ToArray()
            }).ToArray(),
            groupPage = clampedPage,
            groupPageSize = effectivePageSize,
            groupPageCount = pageCount,
            groupsTruncated = groupPageSize <= 0 && totalGroups > effectivePageSize,
            roundTrip = report ?? VerifyRoundTrip(),
            authority = report is { SemanticIdentical: true } ? "native-verified" : "candidate",
            fieldLayout = "typed-gparam-values"
        };
    }

    internal static string TypeName(GparamValueType type) => type switch
    {
        GparamValueType.Byte => "byte",
        GparamValueType.Short => "short",
        GparamValueType.IntA => "int",
        GparamValueType.IntB => "int",
        GparamValueType.BoolA => "bool",
        GparamValueType.BoolB => "bool",
        GparamValueType.Float => "float",
        GparamValueType.Float2 => "float2",
        GparamValueType.Float3 => "float3",
        GparamValueType.Float4 => "float4",
        GparamValueType.Byte4 => "byte4",
        _ => $"unknown-{(int)type}"
    };

    private static int Pad4(int value) => (value + 3) & ~3;
    private static int Utf16ZLength(string text) => (text.Length + 1) * 2;

    private static string ReadUtf16Z(byte[] source, int offset, int index, string what)
    {
        if (offset < 0 || offset >= source.Length)
            throw new InvalidDataException($"GPARAM {what} {index} 名称偏移越界。");
        var end = offset;
        while (end + 1 < source.Length && end - offset < MaxNameBytes)
        {
            if (source[end] == 0 && source[end + 1] == 0) break;
            end += 2;
        }
        if (end - offset >= MaxNameBytes && !(end + 1 < source.Length && source[end] == 0 && source[end + 1] == 0))
            throw new InvalidDataException($"GPARAM {what} {index} 名称过长。");
        try
        {
            return Encoding.Unicode.GetString(source, offset, end - offset);
        }
        catch (DecoderFallbackException)
        {
            throw new InvalidDataException($"GPARAM {what} {index} 名称不是合法 UTF-16。");
        }
    }

    private static int ReadInt16(byte[] source, int offset) => BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(offset, 2));
    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static uint ReadUInt32(byte[] source, int offset) => BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
    private static float ReadSingle(byte[] source, int offset) => BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(offset, 4));
    private static void WriteInt16(byte[] target, int offset, short value) => BinaryPrimitives.WriteInt16LittleEndian(target.AsSpan(offset, 2), value);
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteSingle(byte[] target, int offset, float value) => BinaryPrimitives.WriteSingleLittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUtf16Raw(byte[] target, int offset, string text) => Encoding.Unicode.GetBytes(text).CopyTo(target, offset);
    private static void WriteUtf16Z(byte[] target, int offset, string text)
    {
        WriteUtf16Raw(target, offset, text);
        target[offset + text.Length * 2] = 0;
        target[offset + text.Length * 2 + 1] = 0;
    }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

/// <summary>GPARAM 重建时各区的偏移计划。</summary>
internal sealed record GparamLayoutPlan(
    int[] GroupHeaderOffsets,
    int[] ParamHeaderTableOffsets,
    int[] ParamHeaderOffsets,
    int[] ValuesRel,
    int[] ValueIdsRel,
    int FileSize,
    int GroupHeadersStart,
    int ParamHeaderOffsetsStart,
    int ParamHeadersStart,
    int ValuesStart,
    int ValueIdsStart,
    int Unk2Start,
    int Unk3Start,
    int Unk3ValueIdsStart,
    int CommentOffsetsOffsetsStart,
    int CommentOffsetsStart,
    int CommentsStart);

/// <summary>GPARAM 无修改往返报告。</summary>
internal sealed record GparamRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int GroupCount,
    int ParamCount,
    int ValueCount,
    string? Note);

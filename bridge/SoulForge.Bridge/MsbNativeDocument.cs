using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro MSB (magic "MSB ") native document.
///
/// 布局以 SoulsFormats MSBS 为对照，并用 9 个真实地图（m10/m11/m11_01/m11_02/m13/m15/m17/m20/m25）
/// 的并集验证：文件由 8 个连续 param 组成（MODEL_PARAM_ST → EVENT_PARAM_ST → POINT_PARAM_ST →
/// ROUTE_PARAM_ST → LAYER_PARAM_ST → PARTS_PARAM_ST → MAPSTUDIO_PARTS_POSE_ST →
/// MAPSTUDIO_BONE_NAME_STRING），每个 param 头为
///   int32 Version, int32 offsetCount, int64 nameOffset, int64[offsetCount-1] entryOffsets, int64 nextParamOffset。
/// 实体条目偏移全部是绝对文件偏移；条目数量 = offsetCount - 1，无截断。
///
/// 各家族 type/名称/变换字段偏移（相对条目起点，已逐一对照真实字节）：
///   Model  : nameRel@+0x00, type@+0x08, id@+0x0C, sibRel@+0x10, instanceCount@+0x18
///   Event  : nameRel@+0x00, eventId@+0x08, type@+0x0C
///   Region : nameRel@+0x00, type@+0x08, id@+0x0C, shape@+0x10, position@+0x14
///   Route  : nameRel@+0x00, unk08@+0x08, unk0C@+0x0C, type@+0x10, id@+0x14
///   Part   : nameRel@+0x00, type@+0x08, id@+0x0C, modelIndex@+0x10, sibRel@+0x18,
///            position@+0x20, rotation@+0x2C, scale@+0x38
///
/// 条目内层载荷（entityData/typeData/gparam 子块）不做语义解析，仅通过源字节重写保持无损。
/// 类型注册表（MsbEntityTypeRegistry）覆盖 5 个家族的分类型判别值；对未注册类型的
/// mutation 失败关闭并返回结构化诊断。
/// </summary>
internal sealed class MsbNativeDocument
{
    private const int MaxSourceBytes = 128 * 1024 * 1024;
    private const int MaxEntriesPerParam = 1_000_000;

    // Family field offsets (relative to entry start).
    private const int NameRelOffset = 0x00;
    private const int PartTypeOffset = 0x08;
    private const int PartModelIndexOffset = 0x10;
    private const int PartTransformOffset = 0x20;
    private const int PartRotationOffset = 0x2C;
    private const int PartScaleOffset = 0x38;
    private const int RegionTypeOffset = 0x08;
    private const int RegionTransformOffset = 0x14;
    private const int ModelTypeOffset = 0x08;
    private const int ModelSibOffset = 0x10;
    private const int EventTypeOffset = 0x0C;
    private const int RouteTypeOffset = 0x10;

    private const int ParamHeaderSize = 0x10;
    private const int FirstParamOffset = 0x10;

    private MsbNativeDocument(
        byte[] sourceBytes,
        int version,
        IReadOnlyList<MsbModel> models,
        IReadOnlyList<MsbPart> parts,
        IReadOnlyList<MsbRegion> regions,
        IReadOnlyList<MsbMapEvent> events,
        IReadOnlyList<MsbRoute> routes,
        IReadOnlyDictionary<string, MsbParam> paramsByFamily,
        int partsSectionOffset,
        int firstPartOffset)
    {
        SourceBytes = sourceBytes;
        Version = version;
        Models = models;
        Parts = parts;
        Regions = regions;
        Events = events;
        Routes = routes;
        Params = paramsByFamily;
        PartsSectionOffset = partsSectionOffset;
        FirstPartOffset = firstPartOffset;
    }

    public byte[] SourceBytes { get; }
    public int Version { get; }
    public IReadOnlyList<MsbModel> Models { get; }
    public IReadOnlyList<MsbPart> Parts { get; }
    public IReadOnlyList<MsbRegion> Regions { get; }
    public IReadOnlyList<MsbMapEvent> Events { get; }
    public IReadOnlyList<MsbRoute> Routes { get; }
    /// <summary>8 个 param 链的原始索引，delete mutation 需要重写偏移表。</summary>
    private IReadOnlyDictionary<string, MsbParam> Params { get; }
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

        var paramsByFamily = ReadParams(source);

        var models = ReadModels(source, paramsByFamily["MODEL_PARAM_ST"]);
        var events = ReadEvents(source, paramsByFamily["EVENT_PARAM_ST"]);
        var regions = ReadRegions(source, paramsByFamily["POINT_PARAM_ST"]);
        var routes = ReadRoutes(source, paramsByFamily["ROUTE_PARAM_ST"]);
        var partsParam = paramsByFamily["PARTS_PARAM_ST"];
        var parts = ReadParts(source, partsParam);

        return new MsbNativeDocument(
            source,
            version,
            models,
            parts,
            regions,
            events,
            routes,
            paramsByFamily,
            partsParam.Offset,
            parts.Count > 0 ? (int)partsParam.EntryOffsets[0] : 0);
    }

    public static MsbNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("MSB 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"MSB 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    /// <summary>
    /// 链式读取全部 8 个 param，按参数名索引。Layers/PartsPoses/BoneNames 为空 param
    /// （offsetCount=1、无条目），仍须存在以保持链式顺序。
    /// </summary>
    private static Dictionary<string, MsbParam> ReadParams(byte[] source)
    {
        var result = new Dictionary<string, MsbParam>(StringComparer.Ordinal);
        var start = FirstParamOffset;
        var seen = new HashSet<int>();
        while (start > 0 && start + ParamHeaderSize <= source.Length)
        {
            if (!seen.Add(start))
                throw new InvalidDataException($"MSB param 链出现循环：0x{start:X}。");
            var version = ReadInt32(source, start);
            var offsetCount = ReadInt32(source, start + 4);
            if (offsetCount < 1 || offsetCount > MaxEntriesPerParam + 1)
                throw new InvalidDataException($"MSB param offsetCount 异常：{offsetCount}。");
            var nameOffset = ReadInt64(source, start + 8);
            if (start + ParamHeaderSize + (long)offsetCount * 8 > source.Length)
                throw new InvalidDataException("MSB param 偏移表越界。");
            var entryOffsets = new long[offsetCount - 1];
            for (var k = 0; k < offsetCount - 1; k++)
                entryOffsets[k] = ReadInt64(source, start + ParamHeaderSize + k * 8);
            var nextOffset = ReadInt64(source, start + ParamHeaderSize + (offsetCount - 1) * 8);
            var name = nameOffset > 0 && nameOffset < source.Length ? ReadUtf16(source, (int)nameOffset) : string.Empty;
            if (!string.IsNullOrEmpty(name))
                result[name] = new MsbParam(start, version, name, nameOffset, entryOffsets, nextOffset);
            if (nextOffset <= 0 || nextOffset >= source.Length || nextOffset <= start)
                break;
            start = (int)nextOffset;
        }
        var missing = new[] { "MODEL_PARAM_ST", "EVENT_PARAM_ST", "POINT_PARAM_ST", "ROUTE_PARAM_ST", "PARTS_PARAM_ST" }
            .FirstOrDefault(key => !result.ContainsKey(key));
        if (missing != null)
            throw new InvalidDataException($"MSB 缺少必需 param 段：{missing}。");
        return result;
    }

    private static List<MsbModel> ReadModels(byte[] source, MsbParam param)
    {
        var models = new List<MsbModel>(param.EntryOffsets.Length);
        foreach (var rawOff in param.EntryOffsets)
        {
            var off = ValidateEntryOffset(source, param, rawOff, "model");
            var nameRel = ReadInt64(source, off + NameRelOffset);
            var name = ReadEntryName(source, off, nameRel);
            if (name.Contains("PARAM_ST", StringComparison.Ordinal)) continue;
            var typeId = ReadInt32(source, off + ModelTypeOffset);
            var sibRel = ReadInt64(source, off + ModelSibOffset);
            string? sib = null;
            if (sibRel > 0 && off + sibRel + 2 < source.Length && sibRel < 0x4000)
                sib = ReadUtf16(source, off + (int)sibRel);
            models.Add(new MsbModel(off, name, sib, typeId));
        }
        return models;
    }

    private static List<MsbMapEvent> ReadEvents(byte[] source, MsbParam param)
    {
        var events = new List<MsbMapEvent>(param.EntryOffsets.Length);
        foreach (var rawOff in param.EntryOffsets)
        {
            var off = ValidateEntryOffset(source, param, rawOff, "event");
            var nameRel = ReadInt64(source, off + NameRelOffset);
            var name = ReadEntryName(source, off, nameRel);
            if (name.Contains("PARAM_ST", StringComparison.Ordinal)) continue;
            var eventId = ReadInt32(source, off + 0x08);
            var typeId = ReadInt32(source, off + EventTypeOffset);
            events.Add(new MsbMapEvent(off, name, eventId, typeId));
        }
        return events;
    }

    private static List<MsbRegion> ReadRegions(byte[] source, MsbParam param)
    {
        var regions = new List<MsbRegion>(param.EntryOffsets.Length);
        foreach (var rawOff in param.EntryOffsets)
        {
            var off = ValidateEntryOffset(source, param, rawOff, "region");
            var nameRel = ReadInt64(source, off + NameRelOffset);
            var name = ReadEntryName(source, off, nameRel);
            if (name.Contains("PARAM_ST", StringComparison.Ordinal)) continue;
            var typeId = ReadInt32(source, off + RegionTypeOffset);
            var t = off + RegionTransformOffset;
            var posX = ReadFloat(source, t);
            var posY = ReadFloat(source, t + 4);
            var posZ = ReadFloat(source, t + 8);
            if (!IsFinite(posX) || !IsFinite(posY) || !IsFinite(posZ))
                throw new InvalidDataException($"MSB region {name} 位置不是有限浮点。");
            // Region rotation/scale 位于 t+0x0C/0x1C，与 Part 同布局，后续 scene-ir 可用。
            var rotX = ReadFloat(source, t + 12);
            var rotY = ReadFloat(source, t + 16);
            var rotZ = ReadFloat(source, t + 20);
            var scaleX = ReadFloat(source, t + 28);
            var scaleY = ReadFloat(source, t + 32);
            var scaleZ = ReadFloat(source, t + 36);
            var entityId = ReadInt32(source, off + 0x0C);
            regions.Add(new MsbRegion(off, name, typeId, posX, posY, posZ, rotX, rotY, rotZ, scaleX, scaleY, scaleZ, entityId));
        }
        return regions;
    }

    private static List<MsbRoute> ReadRoutes(byte[] source, MsbParam param)
    {
        var routes = new List<MsbRoute>(param.EntryOffsets.Length);
        foreach (var rawOff in param.EntryOffsets)
        {
            var off = ValidateEntryOffset(source, param, rawOff, "route");
            var nameRel = ReadInt64(source, off + NameRelOffset);
            var name = ReadEntryName(source, off, nameRel);
            if (name.Contains("PARAM_ST", StringComparison.Ordinal)) continue;
            var unk08 = ReadInt32(source, off + 0x08);
            var unk0C = ReadInt32(source, off + 0x0C);
            var typeId = ReadInt32(source, off + RouteTypeOffset);
            var id = ReadInt32(source, off + 0x14);
            routes.Add(new MsbRoute(off, name, typeId, id, unk08, unk0C));
        }
        return routes;
    }

    private static List<MsbPart> ReadParts(byte[] source, MsbParam param)
    {
        var parts = new List<MsbPart>(param.EntryOffsets.Length);
        foreach (var rawOff in param.EntryOffsets)
        {
            var off = ValidateEntryOffset(source, param, rawOff, "part");
            var nameRel = ReadInt64(source, off + NameRelOffset);
            var name = ReadEntryName(source, off, nameRel);
            if (name.Contains("PARAM_ST", StringComparison.Ordinal)) continue;
            var typeId = ReadInt32(source, off + PartTypeOffset);
            var modelIndex = ReadInt32(source, off + PartModelIndexOffset);
            var t = off + PartTransformOffset;
            var posX = ReadFloat(source, t);
            var posY = ReadFloat(source, t + 4);
            var posZ = ReadFloat(source, t + 8);
            if (!IsFinite(posX) || !IsFinite(posY) || !IsFinite(posZ))
                throw new InvalidDataException($"MSB part {name} 位置不是有限浮点。");
            var rotX = ReadFloat(source, off + PartRotationOffset);
            var rotY = ReadFloat(source, off + PartRotationOffset + 4);
            var rotZ = ReadFloat(source, off + PartRotationOffset + 8);
            var scaleX = ReadFloat(source, off + PartScaleOffset);
            var scaleY = ReadFloat(source, off + PartScaleOffset + 4);
            var scaleZ = ReadFloat(source, off + PartScaleOffset + 8);
            var entityId = ReadInt32(source, off + 0x0C);
            parts.Add(new MsbPart(off, name, typeId, modelIndex, posX, posY, posZ, rotX, rotY, rotZ, scaleX, scaleY, scaleZ, entityId));
        }
        return parts;
    }

    private static int ValidateEntryOffset(byte[] source, MsbParam param, long rawOff, string family)
    {
        if (rawOff <= 0 || rawOff >= source.Length || rawOff + 0xA0 > source.Length)
            throw new InvalidDataException($"MSB {family} 条目偏移越界：0x{rawOff:X}。");
        // 条目必须落在所属 param 段起点与下一 param 起点之间，杜绝跨段误读。
        var end = param.NextOffset > 0 && param.NextOffset <= source.Length ? param.NextOffset : source.Length;
        if (rawOff < param.Offset || rawOff >= end)
            throw new InvalidDataException($"MSB {family} 条目 0x{rawOff:X} 越出 param 段 {param.Name}。");
        return (int)rawOff;
    }

    private static string ReadEntryName(byte[] source, int entryOffset, long nameRel)
    {
        if (nameRel is < 0x10 or > 0x2000 || entryOffset + nameRel + 2 >= source.Length)
            throw new InvalidDataException($"MSB 条目名称偏移异常：rel=0x{nameRel:X}。");
        return ReadUtf16(source, entryOffset + (int)nameRel);
    }

    public MsbRoundTripReport VerifyRoundTrip()
    {
        // 注意这条往返验证的真实判别力边界，不要按名字理解它。
        //
        // rebuilt 是**源字节的拷贝**，不是经 writer 重建的产物。因此：
        //  · ByteIdentical 恒真——它比较的是源与源，永远相等；
        //  · 真正被验证的只有 SemanticIdentical，即「重新解析同一批字节能否得到
        //    同样的模型/部件/区域/事件/路线集合」，也就是 **parser 的自洽性**，
        //    不是 writer 的无损性。
        //
        // MSB 当前没有 writer（全仓无 write-msb 落盘路径），所以这里
        // 不存在可比的重建产物。保持现状是诚实的，但 ByteIdentical 字段名会让
        // 读者误以为它证明了写回无损，故显式传 false 并让语义项承载结论。
        //
        // 若将来接入 MSB writer，这里必须改成 Rebuild() 的真实产物再比较；
        // 那时 ByteIdentical 才有意义。
        var rebuilt = SourceBytes.ToArray();
        var reparsed = Read(rebuilt);
        var modelsEqual = reparsed.Models.Count == Models.Count
            && reparsed.Models.Zip(Models).All(pair => pair.First.Offset == pair.Second.Offset
                && pair.First.Name == pair.Second.Name);
        var partsEqual = reparsed.Parts.Count == Parts.Count
            && reparsed.Parts.Zip(Parts).All(pair =>
                pair.First.Offset == pair.Second.Offset
                && pair.First.Name == pair.Second.Name
                && pair.First.TypeId == pair.Second.TypeId
                && Nearly(pair.First.PosX, pair.Second.PosX)
                && Nearly(pair.First.PosY, pair.Second.PosY)
                && Nearly(pair.First.PosZ, pair.Second.PosZ));
        var regionsEqual = reparsed.Regions.Count == Regions.Count
            && reparsed.Regions.Zip(Regions).All(pair =>
                pair.First.Offset == pair.Second.Offset
                && pair.First.Name == pair.Second.Name
                && pair.First.TypeId == pair.Second.TypeId
                && Nearly(pair.First.PosX, pair.Second.PosX)
                && Nearly(pair.First.PosY, pair.Second.PosY)
                && Nearly(pair.First.PosZ, pair.Second.PosZ));
        var eventsEqual = reparsed.Events.Count == Events.Count
            && reparsed.Events.Zip(Events).All(pair =>
                pair.First.Offset == pair.Second.Offset
                && pair.First.Name == pair.Second.Name
                && pair.First.TypeId == pair.Second.TypeId);
        var routesEqual = reparsed.Routes.Count == Routes.Count
            && reparsed.Routes.Zip(Routes).All(pair =>
                pair.First.Offset == pair.Second.Offset
                && pair.First.Name == pair.Second.Name
                && pair.First.TypeId == pair.Second.TypeId);
        return new MsbRoundTripReport(
            // ByteIdentical=false：没有经 writer 重建的产物可比（见上方注释）。
            // 原先硬编码 true，比较的是源与源自身的拷贝，是恒真判据。
            false,
            modelsEqual && partsEqual && regionsEqual && eventsEqual && routesEqual,
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
        var deletedPartOffsets = new HashSet<long>();
        var deletedRegionOffsets = new HashSet<long>();
        var deletedEventOffsets = new HashSet<long>();

        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "set_part_position":
                case "set_part_transform":
                {
                    var part = ResolvePart(patch);
                    GuardRegisteredPart(part);
                    var baseOff = part.Offset + PartTransformOffset;
                    if (patch.Kind == "set_part_position")
                    {
                        if (patch.PosX is null || patch.PosY is null || patch.PosZ is null)
                            throw new InvalidDataException("set_part_position 需要 posX/posY/posZ。");
                        WriteFloat(rebuilt, baseOff, patch.PosX.Value);
                        WriteFloat(rebuilt, baseOff + 4, patch.PosY.Value);
                        WriteFloat(rebuilt, baseOff + 8, patch.PosZ.Value);
                    }
                    else
                    {
                        if (patch.PosX is not null) WriteFloat(rebuilt, baseOff, patch.PosX.Value);
                        if (patch.PosY is not null) WriteFloat(rebuilt, baseOff + 4, patch.PosY.Value);
                        if (patch.PosZ is not null) WriteFloat(rebuilt, baseOff + 8, patch.PosZ.Value);
                        if (patch.RotX is not null) WriteFloat(rebuilt, part.Offset + PartRotationOffset, patch.RotX.Value);
                        if (patch.RotY is not null) WriteFloat(rebuilt, part.Offset + PartRotationOffset + 4, patch.RotY.Value);
                        if (patch.RotZ is not null) WriteFloat(rebuilt, part.Offset + PartRotationOffset + 8, patch.RotZ.Value);
                        if (patch.ScaleX is not null) WriteFloat(rebuilt, part.Offset + PartScaleOffset, patch.ScaleX.Value);
                        if (patch.ScaleY is not null) WriteFloat(rebuilt, part.Offset + PartScaleOffset + 4, patch.ScaleY.Value);
                        if (patch.ScaleZ is not null) WriteFloat(rebuilt, part.Offset + PartScaleOffset + 8, patch.ScaleZ.Value);
                    }
                    break;
                }
                case "set_region_position":
                case "set_region_transform":
                {
                    var region = ResolveRegion(patch);
                    GuardRegisteredRegion(region);
                    var t = region.Offset + RegionTransformOffset;
                    if (patch.Kind == "set_region_position")
                    {
                        if (patch.PosX is null || patch.PosY is null || patch.PosZ is null)
                            throw new InvalidDataException("set_region_position 需要 posX/posY/posZ。");
                        WriteFloat(rebuilt, t, patch.PosX.Value);
                        WriteFloat(rebuilt, t + 4, patch.PosY.Value);
                        WriteFloat(rebuilt, t + 8, patch.PosZ.Value);
                    }
                    else
                    {
                        if (patch.PosX is not null) WriteFloat(rebuilt, t, patch.PosX.Value);
                        if (patch.PosY is not null) WriteFloat(rebuilt, t + 4, patch.PosY.Value);
                        if (patch.PosZ is not null) WriteFloat(rebuilt, t + 8, patch.PosZ.Value);
                        if (patch.RotX is not null) WriteFloat(rebuilt, t + 12, patch.RotX.Value);
                        if (patch.RotY is not null) WriteFloat(rebuilt, t + 16, patch.RotY.Value);
                        if (patch.RotZ is not null) WriteFloat(rebuilt, t + 20, patch.RotZ.Value);
                        if (patch.ScaleX is not null) WriteFloat(rebuilt, t + 28, patch.ScaleX.Value);
                        if (patch.ScaleY is not null) WriteFloat(rebuilt, t + 32, patch.ScaleY.Value);
                        if (patch.ScaleZ is not null) WriteFloat(rebuilt, t + 36, patch.ScaleZ.Value);
                    }
                    break;
                }
                case "set_part_model":
                case "change_model":
                {
                    var part = ResolvePart(patch);
                    GuardRegisteredPart(part);
                    if (patch.ModelIndex is null && patch.ModelName is not null)
                    {
                         var mIdx = Models.ToList().FindIndex(m => m.Name == patch.ModelName);
                        if (mIdx < 0) throw new InvalidDataException($"MSB model 不存在：{patch.ModelName}");
                        WriteInt32(rebuilt, part.Offset + PartModelIndexOffset, mIdx);
                    }
                    else if (patch.ModelIndex is not null)
                    {
                        WriteInt32(rebuilt, part.Offset + PartModelIndexOffset, patch.ModelIndex.Value);
                    }
                    break;
                }
                case "set_property":
                case "set_entity_id":
                {
                    if (patch.EntityId is null) throw new InvalidDataException("set_property/set_entity_id 需要 entityId。");
                    if (patch.Family == "part")
                    {
                        var part = ResolvePart(patch);
                        GuardRegisteredPart(part);
                        WriteInt32(rebuilt, part.Offset + 0x0C, patch.EntityId.Value);
                        break;
                    }
                    if (patch.Family == "region")
                    {
                        var reg = ResolveRegion(patch);
                        GuardRegisteredRegion(reg);
                        WriteInt32(rebuilt, reg.Offset + 0x0C, patch.EntityId.Value);
                        break;
                    }
                    // Event +0x08 is eventId, not entityId. Do not silently
                    // reinterpret an event identity mutation as an entityId write.
                    throw new InvalidDataException($"MSB entityId 目标 family 不支持：{patch.Family}");
                }
                case "delete_part":
                {
                    var part = ResolvePart(patch);
                    GuardRegisteredPart(part);
                    deletedPartOffsets.Add(part.Offset);
                    break;
                }
                case "delete_region":
                {
                    var region = ResolveRegion(patch);
                    GuardRegisteredRegion(region);
                    deletedRegionOffsets.Add(region.Offset);
                    break;
                }
                case "delete_event":
                {
                    var ev = ResolveEvent(patch);
                    GuardRegisteredEvent(ev);
                    deletedEventOffsets.Add(ev.Offset);
                    break;
                }
                default:
                    throw new InvalidDataException($"未知或尚未支持的 MSB mutation：{patch.Kind}。");
            }
        }

        // Batch rewrite param offset tables once per family
        if (deletedPartOffsets.Count > 0)
            BatchRemoveEntriesFromParam(rebuilt, Params["PARTS_PARAM_ST"], deletedPartOffsets);
        if (deletedRegionOffsets.Count > 0)
            BatchRemoveEntriesFromParam(rebuilt, Params["POINT_PARAM_ST"], deletedRegionOffsets);
        if (deletedEventOffsets.Count > 0)
            BatchRemoveEntriesFromParam(rebuilt, Params["EVENT_PARAM_ST"], deletedEventOffsets);

        return rebuilt;
    }

    internal MsbPart ResolvePart(MsbPatch patch)
    {
        RequireFamily(patch, "part");
        var part = Parts.SingleOrDefault(item => item.Offset == patch.NativeOffset)
            ?? throw new InvalidDataException($"MSB native identity 不存在：family=part nativeOffset=0x{patch.NativeOffset:X}");
        VerifyExpectedName(part.Name, patch);
        return part;
    }

    internal MsbRegion ResolveRegion(MsbPatch patch)
    {
        RequireFamily(patch, "region");
        var region = Regions.SingleOrDefault(item => item.Offset == patch.NativeOffset)
            ?? throw new InvalidDataException($"MSB native identity 不存在：family=region nativeOffset=0x{patch.NativeOffset:X}");
        VerifyExpectedName(region.Name, patch);
        return region;
    }

    internal MsbMapEvent ResolveEvent(MsbPatch patch)
    {
        RequireFamily(patch, "event");
        var ev = Events.SingleOrDefault(item => item.Offset == patch.NativeOffset)
            ?? throw new InvalidDataException($"MSB native identity 不存在：family=event nativeOffset=0x{patch.NativeOffset:X}");
        VerifyExpectedName(ev.Name, patch);
        return ev;
    }

    private static void RequireFamily(MsbPatch patch, string expected)
    {
        if (!patch.Family.Equals(expected, StringComparison.Ordinal))
            throw new InvalidDataException($"MSB mutation family 不匹配：expected={expected} actual={patch.Family}");
    }

    private static void VerifyExpectedName(string actualName, MsbPatch patch)
    {
        if (patch.ExpectedName is not null && !actualName.Equals(patch.ExpectedName, StringComparison.Ordinal))
            throw new InvalidDataException($"MSB native identity expectedName 不匹配：family={patch.Family} nativeOffset=0x{patch.NativeOffset:X} expectedName={patch.ExpectedName} actualName={actualName}");
    }

    private static void GuardRegisteredPart(MsbPart part)
    {
        if (!MsbEntityTypeRegistry.PartTypes.Contains(part.TypeId))
            throw new MsbUnregisteredEntityException("part", part.Name, part.TypeId);
    }

    private static void GuardRegisteredRegion(MsbRegion region)
    {
        if (!MsbEntityTypeRegistry.RegionTypes.Contains(region.TypeId))
            throw new MsbUnregisteredEntityException("region", region.Name, region.TypeId);
    }

    private static void GuardRegisteredEvent(MsbMapEvent ev)
    {
        if (!MsbEntityTypeRegistry.EventTypes.Contains(ev.TypeId))
            throw new MsbUnregisteredEntityException("event", ev.Name, ev.TypeId);
    }

    /// <summary>
    /// 从 param 偏移表批量删除指定条目（软删除）。
    /// 单个 batch 只重建一次偏移表，杜绝多次删除时使用旧索引覆盖的问题。
    /// </summary>
    private static void BatchRemoveEntriesFromParam(byte[] target, MsbParam param, HashSet<long> offsetsToRemove)
    {
        var oldCount = param.EntryOffsets.Length;
        var remaining = param.EntryOffsets.Where(off => !offsetsToRemove.Contains(off)).ToArray();
        var newCount = remaining.Length;
        if (newCount == oldCount) return;

        WriteInt32(target, param.Offset, param.Version);
        WriteInt32(target, param.Offset + 4, newCount + 1);
        WriteInt64(target, param.Offset + 8, param.NameOffset);
        for (var i = 0; i < newCount; i++)
        {
            WriteInt64(target, param.Offset + ParamHeaderSize + i * 8, remaining[i]);
        }
        WriteInt64(target, param.Offset + ParamHeaderSize + newCount * 8, param.NextOffset);
        var freedStart = param.Offset + ParamHeaderSize + (newCount + 1) * 8;
        var oldEnd = param.Offset + ParamHeaderSize + (oldCount + 1) * 8;
        for (var i = freedStart; i < oldEnd; i++) target[i] = 0;
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
        routeCount = Routes.Count,
        partsSectionOffset = PartsSectionOffset,
        firstPartOffset = FirstPartOffset,
        models = Models.Select(m => new { family = "model", m.Name, m.SibPath, m.TypeId, offset = m.Offset, nativeOffset = m.Offset }).ToArray(),
        parts = Parts.Select(p => new
        {
            family = "part",
            p.Name,
            offset = p.Offset,
            nativeOffset = p.Offset,
            p.TypeId,
            p.ModelIndex,
            p.PosX,
            p.PosY,
            p.PosZ,
            p.RotX,
            p.RotY,
            p.RotZ,
            p.ScaleX,
            p.ScaleY,
            p.ScaleZ,
            entityId = p.EntityId
        }).ToArray(),
        regions = Regions.Select(r => new
        {
            family = "region",
            r.Name,
            offset = r.Offset,
            nativeOffset = r.Offset,
            r.TypeId,
            r.PosX,
            r.PosY,
            r.PosZ,
            r.RotX,
            r.RotY,
            r.RotZ,
            r.ScaleX,
            r.ScaleY,
            r.ScaleZ,
            entityId = r.EntityId
        }).ToArray(),
        events = Events.Select(e => new
        {
            family = "event",
            e.Name,
            offset = e.Offset,
            nativeOffset = e.Offset,
            e.TypeId,
            e.EventId
        }).ToArray(),
        routes = Routes.Select(r => new
        {
            family = "route",
            r.Name,
            offset = r.Offset,
            nativeOffset = r.Offset,
            r.TypeId,
            r.Id
        }).ToArray(),
        // 三层截断已移除：Bridge 返回完整实体表；TS 侧按 scaleAccess=bounded-window
        // 通过显式有界窗口 / chunking 分页。
        modelsTruncated = false,
        partsTruncated = false,
        regionsTruncated = false,
        eventsTruncated = false,
        roundTrip = report ?? VerifyRoundTrip(),
        authority = "native-verified",
        authorityScope = "entries+types+transforms（偏移表驱动全枚举）；per-type 内层载荷未语义解析，源字节重写保持无损",
        entityEdit = "part-transform+region-position-supported",
        sceneProjection = "pending-p4-gpu-chunks"
    };

    private static int Align4(int value) => (value + 3) & ~3;

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
    private static long ReadInt64(byte[] source, int offset) => BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
    private static float ReadFloat(byte[] source, int offset) => BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(offset, 4));
    private static void WriteFloat(byte[] target, int offset, float value) => BinaryPrimitives.WriteSingleLittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteInt64(byte[] target, int offset, long value) => BinaryPrimitives.WriteInt64LittleEndian(target.AsSpan(offset, 8), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private sealed record MsbParam(int Offset, int Version, string Name, long NameOffset, long[] EntryOffsets, long NextOffset);
}

/// <summary>
/// 未注册实体类型的编辑守卫异常：对不在 Sekiro MSB 实体类型注册表内的
/// 实体 type 进行 mutation 时失败关闭。Bridge 层映射为结构化诊断
/// MSB_UNREGISTERED_ENTITY_TYPE。
/// </summary>
internal sealed class MsbUnregisteredEntityException : Exception
{
    public MsbUnregisteredEntityException(string family, string entityName, int typeId)
        : base($"MSB 实体类型未注册，拒绝编辑：family={family} typeId={typeId} name={entityName}。")
    {
    }
}

/// <summary>
/// Sekiro MSB 实体类型注册表（SoulForge Bridge 侧投影）。
/// 全集 = 9 个真实地图（m10/m11/m11_01/m11_02/m13/m15/m17/m20/m25）实体类型并集。
/// TypeId 0xFFFFFFFF（即 int32 -1）为 Other 哨兵值，属注册表内类型。
/// </summary>
internal static class MsbEntityTypeRegistry
{
    public static readonly HashSet<int> ModelTypes = new() { 0, 1, 2, 4, 5 };
    public static readonly HashSet<int> PartTypes = new() { 0, 1, 2, 4, 5, 9, 10, 11 };
    public static readonly HashSet<int> RegionTypes = new()
        { 0, 1, 2, 4, 5, 6, 8, 11, 13, 14, 15, 17, 18, 20, 21, 23, 24, 25, 26, -1 };
    public static readonly HashSet<int> EventTypes = new()
        { 4, 5, 7, 9, 14, 15, 17, 18, 20, 21, 22, 23, 24, -1 };
    public static readonly HashSet<int> RouteTypes = new() { 3, 4 };
}

internal sealed record MsbModel(int Offset, string Name, string? SibPath, int TypeId);
internal sealed record MsbPart(
    int Offset,
    string Name,
    int TypeId,
    int ModelIndex,
    float PosX,
    float PosY,
    float PosZ,
    float RotX,
    float RotY,
    float RotZ,
    float ScaleX,
    float ScaleY,
    float ScaleZ,
    int EntityId = 0);
internal sealed record MsbRegion(
    int Offset,
    string Name,
    int TypeId,
    float PosX,
    float PosY,
    float PosZ,
    float RotX,
    float RotY,
    float RotZ,
    float ScaleX,
    float ScaleY,
    float ScaleZ,
    int EntityId = 0);
internal sealed record MsbMapEvent(
    int Offset,
    string Name,
    int EventId,
    int TypeId);
internal sealed record MsbRoute(
    int Offset,
    string Name,
    int TypeId,
    int Id,
    int Unk08,
    int Unk0C);
internal sealed record MsbPatch(
    string Kind,
    string Family,
    long NativeOffset,
    string? ExpectedName,
    float? PosX,
    float? PosY,
    float? PosZ,
    float? RotX,
    float? RotY,
    float? RotZ,
    float? ScaleX,
    float? ScaleY,
    float? ScaleZ,
    string? ModelName = null,
    int? ModelIndex = null,
    int? EntityId = null);
internal sealed record MsbRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int Version,
    int ModelCount,
    int PartCount,
    int SourceSize);

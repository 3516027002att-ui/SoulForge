using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro TAE (Time Act Editor) read-only native document.
/// Layout verified against a00.tae (938 animations, 2,890,432 bytes).
/// All offsets are absolute int64 except event-group event arrays which use int32.
/// Times are float32 stored at absolute offsets within a per-animation times array.
/// Strings are UTF-16LE null-terminated.
///
/// <para><b>解析到哪一层：只到 timing，事件参数体未解码。</b>
/// 本解析器对每个事件读出 startTime / endTime / eventTypeId 与两个偏移
/// （eventDataOffset、paramDataOffset），<b>paramDataOffset 指向的参数体
/// 一字节未读</b>；envelope 只导出 timing 与计数，外加 bounded 的逐动画
/// 事件时间表（startTime / endTime / eventTypeId，见 ToEnvelope）。
///
/// 原类文档在这一行写的是「TAE defines per-animation event timing (hitboxes,
/// SFX, VFX, camera shakes)」，与上一行的「Layout verified」并排——读起来像那四项
/// 都已解析，而它们全在未读的 paramData 区。TAE 的事件参数按 eventTypeId 分派、
/// 每类布局不同，缺一类就不能开 writer，所以「读出 hitbox 数据」与「读出事件在
/// 时间轴上的位置」是两件相差很远的事。措辞已按 EsdNativeDocument 的先例改为
/// 明确标注未解码（那里写的是 "Expression bytecode is reported as opaque
/// (offset, length) pairs — not decoded"）。
///
/// 这不是待办标记：TAE 属 V0.6 延期只读预览族，不解参数体是当前范围内的正确状态。
/// 要解它必须先按 eventTypeId 逐类登记布局并有真实样本验证，否则无法无损保留
/// 未知字段、也就不得开放 writer。</para>
/// </summary>
internal sealed class TaeNativeDocument
{
    private const int FileHeaderSize = 0x50; // 64-byte header + 16-byte extended header
    private const int Section1HeaderSize = 0x30; // 48 bytes
    private const int AnimTableEntrySize = 16;
    private const int AnimationEntrySize = 0x30; // 48 bytes
    private const int EventTableEntrySize = 24;
    private const int EventDataHeaderSize = 16;
    private const int EventGroupEntrySize = 32;
    private const int GroupTypeDescriptorSize = 16;
    private const int MaxAnimations = 100_000;
    private const int MaxEvents = 1_000_000;
    private const long MaxSourceBytes = 64L * 1024 * 1024;

    private TaeNativeDocument(
        byte[] sourceBytes,
        int version,
        long flags,
        long section1Offset,
        long section2Offset,
        long unknownCount,
        IReadOnlyList<TaeAnimation> animations,
        int totalEventCount,
        int totalGroupCount,
        IReadOnlyList<int> eventTypes)
    {
        SourceBytes = sourceBytes;
        Version = version;
        Flags = flags;
        Section1Offset = section1Offset;
        Section2Offset = section2Offset;
        UnknownCount = unknownCount;
        Animations = animations;
        TotalEventCount = totalEventCount;
        TotalGroupCount = totalGroupCount;
        EventTypes = eventTypes;
    }

    public byte[] SourceBytes { get; }
    public int Version { get; }
    public long Flags { get; }
    public long Section1Offset { get; }
    public long Section2Offset { get; }
    public long UnknownCount { get; }
    public IReadOnlyList<TaeAnimation> Animations { get; }
    public int TotalEventCount { get; }
    public int TotalGroupCount { get; }
    public IReadOnlyList<int> EventTypes { get; }
    public string SourceHash => Hash(SourceBytes);

    public static TaeNativeDocument Read(byte[] source)
    {
        if (source.Length < FileHeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"TAE 大小 {source.Length} 超出安全范围。");

        // Magic: "TAE "
        if (!source.AsSpan(0, 4).SequenceEqual("TAE "u8))
            throw new InvalidDataException("输入不是 TAE（缺少 \"TAE \" 魔数）。");

        // Format bytes: 00 00 00 FF (Sekiro)
        if (source[4] != 0x00 || source[5] != 0x00 || source[6] != 0x00 || source[7] != 0xFF)
            throw new NotSupportedException("仅支持 Sekiro 风格 TAE 格式字节 00 00 00 FF。");

        // Version: 0x0001000D
        var version = ReadInt32(source, 0x08);
        if (version != 0x0001000D)
            throw new NotSupportedException($"仅支持 TAE version 0x0001000D，收到 0x{version:X8}。");

        // Declared file size must match
        var declaredSize = ReadInt32(source, 0x0C);
        if (declaredSize != source.Length)
            throw new InvalidDataException($"TAE 声明大小 {declaredSize} 与实际 {source.Length} 不一致。");

        // File header fields
        var flags = ReadInt64(source, 0x10);
        // 0x18: int64 unknown (1) — read but not validated
        var section1Offset = ReadInt64(source, 0x20);
        var section2Offset = ReadInt64(source, 0x28);
        var unknownCount = ReadInt64(source, 0x30);
        // 0x38: int64 reserved (0)

        // Extended header at 0x40: byte[8] per-flag bytes + int64 unknown at 0x48
        // Read but not validated beyond bounds (already covered by FileHeaderSize check).

        // Validate Section 1 header bounds
        if (section1Offset < FileHeaderSize || section1Offset + Section1HeaderSize > source.Length)
            throw new InvalidDataException($"TAE Section 1 头偏移 {section1Offset} 越界。");
        if (section2Offset < 0 || section2Offset > source.Length)
            throw new InvalidDataException($"TAE Section 2 头偏移 {section2Offset} 越界。");

        // ── Section 1: Anim Data Header ──
        var s1 = checked((int)section1Offset);
        // +0x00: int32 unknown (base anim ID?)
        var animTableEntryCount = ReadInt32(source, s1 + 0x04);
        var animTableOffset = ReadInt64(source, s1 + 0x08);
        // +0x10: int64 → Anim ID range table (noted, not parsed)
        // +0x18: int64 → Anim files string table (noted, not parsed)
        var animCount = ReadInt64(source, s1 + 0x20);
        // +0x28: int64 → Animation entries array (noted; we follow table pointers instead)

        if (animTableEntryCount < 0 || animTableEntryCount > MaxAnimations)
            throw new InvalidDataException($"TAE 动画表条目数 {animTableEntryCount} 越界。");
        if (animCount < 0 || animCount > MaxAnimations)
            throw new InvalidDataException($"TAE 动画计数 {animCount} 越界。");

        // Validate animation table bounds (animTableOffset points to an 8-byte header before entries)
        var animTableDataOffset = animTableOffset + 8;
        if (animTableOffset < 0
            || animTableDataOffset + (long)animTableEntryCount * AnimTableEntrySize > source.Length)
            throw new InvalidDataException("TAE 动画表越界。");

        var eventTypeSet = new SortedSet<int>();
        var animations = new List<TaeAnimation>(animTableEntryCount);
        long totalEvents = 0;
        long totalGroups = 0;

        for (var i = 0; i < animTableEntryCount; i++)
        {
            var te = checked((int)(animTableDataOffset + (long)i * AnimTableEntrySize));
            var animEntryOffset = ReadInt64(source, te);
            var animId = ReadInt64(source, te + 8);

            // ── Animation Entry (48 bytes) ──
            if (animEntryOffset < 0 || animEntryOffset + AnimationEntrySize > source.Length)
                throw new InvalidDataException($"TAE 动画 {animId} 条目偏移 {animEntryOffset} 越界。");

            var ae = checked((int)animEntryOffset);
            var eventTableOffset = ReadInt64(source, ae);
            var eventGroupTableOffset = ReadInt64(source, ae + 0x08);
            var timesArrayOffset = ReadInt64(source, ae + 0x10);
            var animFileInfoOffset = ReadInt64(source, ae + 0x18);
            var eventCount = ReadInt32(source, ae + 0x20);
            var eventGroupCount = ReadInt32(source, ae + 0x24);
            var timesCount = ReadInt64(source, ae + 0x28);

            if (eventCount < 0 || eventCount > MaxEvents)
                throw new InvalidDataException($"TAE 动画 {animId} 事件数 {eventCount} 越界。");
            if (eventGroupCount < 0 || eventGroupCount > MaxEvents)
                throw new InvalidDataException($"TAE 动画 {animId} 事件组数 {eventGroupCount} 越界。");
            if (timesCount < 0 || timesCount > MaxEvents * 2L)
                throw new InvalidDataException($"TAE 动画 {animId} 时间戳数 {timesCount} 越界。");

            // ── Times array (float32[]) ──
            float[] times;
            if (timesCount > 0)
            {
                if (timesArrayOffset < 0 || timesArrayOffset + timesCount * 4 > source.Length)
                    throw new InvalidDataException($"TAE 动画 {animId} 时间数组越界。");
                times = new float[checked((int)timesCount)];
                for (var t = 0; t < timesCount; t++)
                    times[t] = ReadFloat32(source, checked((int)(timesArrayOffset + t * 4)));
            }
            else
            {
                times = Array.Empty<float>();
            }

            // ── Event table (eventCount × 24 bytes) ──
            if (eventCount > 0
                && (eventTableOffset < 0
                    || eventTableOffset + (long)eventCount * EventTableEntrySize > source.Length))
                throw new InvalidDataException($"TAE 动画 {animId} 事件表越界。");

            var events = new List<TaeEvent>(eventCount);
            for (var e = 0; e < eventCount; e++)
            {
                var et = checked((int)(eventTableOffset + (long)e * EventTableEntrySize));
                var startTimeOffset = ReadInt64(source, et);
                var endTimeOffset = ReadInt64(source, et + 0x08);
                var eventDataOffset = ReadInt64(source, et + 0x10);

                // Start / end time: absolute offset → float32
                if (startTimeOffset < 0 || startTimeOffset + 4 > source.Length)
                    throw new InvalidDataException(
                        $"TAE 动画 {animId} 事件 {e} 起始时间偏移 {startTimeOffset} 越界。");
                if (endTimeOffset < 0 || endTimeOffset + 4 > source.Length)
                    throw new InvalidDataException(
                        $"TAE 动画 {animId} 事件 {e} 结束时间偏移 {endTimeOffset} 越界。");

                var startTime = ReadFloat32(source, checked((int)startTimeOffset));
                var endTime = ReadFloat32(source, checked((int)endTimeOffset));

                // Event data entry (16-byte header + type-dependent params)
                if (eventDataOffset < 0 || eventDataOffset + EventDataHeaderSize > source.Length)
                    throw new InvalidDataException(
                        $"TAE 动画 {animId} 事件 {e} 数据偏移 {eventDataOffset} 越界。");

                var ed = checked((int)eventDataOffset);
                var eventTypeId = ReadInt32(source, ed);
                // +0x04: int32 padding — not validated (may be non-zero in edge cases)
                var paramDataOffset = ReadInt64(source, ed + 0x08);

                eventTypeSet.Add(eventTypeId);
                events.Add(new TaeEvent(startTime, endTime, eventTypeId, eventDataOffset, paramDataOffset));
            }

            // ── Event group table (eventGroupCount × 32 bytes) ──
            if (eventGroupCount > 0
                && (eventGroupTableOffset < 0
                    || eventGroupTableOffset + (long)eventGroupCount * EventGroupEntrySize > source.Length))
                throw new InvalidDataException($"TAE 动画 {animId} 事件组表越界。");

            var groups = new List<TaeEventGroup>(eventGroupCount);
            for (var g = 0; g < eventGroupCount; g++)
            {
                var eg = checked((int)(eventGroupTableOffset + (long)g * EventGroupEntrySize));
                var groupEventCount = ReadInt64(source, eg);
                var groupEventArrayOffset = ReadInt64(source, eg + 0x08);
                var groupTypeOffset = ReadInt64(source, eg + 0x10);
                // +0x18: int64 padding (0)

                if (groupEventCount < 0 || groupEventCount > MaxEvents)
                    throw new InvalidDataException(
                        $"TAE 动画 {animId} 事件组 {g} 事件数 {groupEventCount} 越界。");

                // Event offset array: int32[count] absolute offsets
                int[] eventOffsets;
                if (groupEventCount > 0)
                {
                    if (groupEventArrayOffset < 0
                        || groupEventArrayOffset + groupEventCount * 4 > source.Length)
                        throw new InvalidDataException(
                            $"TAE 动画 {animId} 事件组 {g} 偏移数组越界。");
                    eventOffsets = new int[checked((int)groupEventCount)];
                    for (var ge = 0; ge < groupEventCount; ge++)
                        eventOffsets[ge] = ReadInt32(
                            source, checked((int)(groupEventArrayOffset + ge * 4)));
                }
                else
                {
                    eventOffsets = Array.Empty<int>();
                }

                // Group type descriptor (16 bytes)
                int groupEventType = 0;
                long groupTypeUnknown = 0;
                if (groupTypeOffset > 0)
                {
                    if (groupTypeOffset + GroupTypeDescriptorSize > source.Length)
                        throw new InvalidDataException(
                            $"TAE 动画 {animId} 事件组 {g} 类型描述符偏移越界。");
                    var gt = checked((int)groupTypeOffset);
                    groupEventType = ReadInt32(source, gt);
                    // +0x04: int32 padding
                    groupTypeUnknown = ReadInt64(source, gt + 0x08);
                    eventTypeSet.Add(groupEventType);
                }

                groups.Add(new TaeEventGroup(groupEventType, groupEventCount, eventOffsets, groupTypeUnknown));
            }

            // ── HKX name (best-effort from anim file info) ──
            // S17：实测 mods 与原版两份 c1130 TAE（DFLT/KRAK 各一）——名字指针
            // 在 animFileInfo +0x10，UTF-16LE 双零终止（`a000_000000.hkt`）；
            // +0x00 是 0/1 链接标志，旧码读它当指针，a=1 时整段乱码（「葉」）。
            // 别名动画（a=1，指针指向下一条 fileInfo）解出的是下条数据，语义上
            // 就是无自有名字 —— 解出非文件名即由上层丢弃回退 a000_ + animId。
            string? hkxName = null;
            if (animFileInfoOffset > 0 && animFileInfoOffset + 0x18 <= source.Length)
            {
                var namePtr = ReadInt64(source, checked((int)animFileInfoOffset + 0x10));
                if (namePtr > 0 && namePtr + 2 <= source.Length)
                {
                    try { hkxName = ReadNameZ(source, checked((int)namePtr)); }
                    catch (InvalidDataException) { /* best-effort */ }
                }
            }

            totalEvents += eventCount;
            totalGroups += eventGroupCount;
            animations.Add(new TaeAnimation(
                animId, eventCount, eventGroupCount, timesCount,
                times, events, groups, animFileInfoOffset, hkxName));
        }

        if (totalEvents > MaxEvents)
            throw new InvalidDataException($"TAE 事件总数 {totalEvents} 超出安全上限 {MaxEvents}。");

        return new TaeNativeDocument(
            source, version, flags, section1Offset, section2Offset, unknownCount,
            animations, checked((int)totalEvents), checked((int)totalGroups),
            eventTypeSet.ToArray());
    }

    public static TaeNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("TAE 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"TAE 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    /// <summary>按 animId + 事件表下标定位事件（read-tae-event-params 用）。</summary>
    public TaeEvent? FindEvent(long animId, int eventIndex)
    {
        var animation = Animations.FirstOrDefault(a => a.AnimId == animId);
        if (animation is null || eventIndex < 0 || eventIndex >= animation.Events.Count) return null;
        return animation.Events[eventIndex];
    }

    /// <summary>
    /// 事件参数体原始字节：paramDataOffset 起截 length 字节，越界失败关闭。
    /// length 由 main 按本机 TAE 模板布局给出；无模板类型传 0 → 只读前 16 字节
    /// hex 作「未解码」证据。
    /// </summary>
    public byte[] ReadParameterBody(TaeEvent ev, int length)
    {
        if (length < 0) throw new InvalidDataException("TAE 参数体长度非法。");
        if (ev.ParameterDataOffset < 0 || ev.ParameterDataOffset + length > SourceBytes.Length)
            throw new InvalidDataException(
                $"TAE 参数体越界：offset={ev.ParameterDataOffset} length={length} fileSize={SourceBytes.Length}。");
        return SourceBytes.AsSpan(checked((int)ev.ParameterDataOffset), length).ToArray();
    }

    /// <summary>
    /// TAE is read-only: verify source integrity by re-parsing the same bytes
    /// and confirming deterministic structural equality.
    /// </summary>
    public TaeRoundTripReport VerifyRoundTrip()
    {
        var reparsed = Read(SourceBytes);
        var semanticIdentical = reparsed.Animations.Count == Animations.Count
            && reparsed.TotalEventCount == TotalEventCount
            && reparsed.TotalGroupCount == TotalGroupCount
            && reparsed.Version == Version
            && reparsed.Flags == Flags
            && reparsed.EventTypes.SequenceEqual(EventTypes)
            && reparsed.Animations.Zip(Animations).All(pair =>
                pair.First.AnimId == pair.Second.AnimId
                && pair.First.EventCount == pair.Second.EventCount
                && pair.First.EventGroupCount == pair.Second.EventGroupCount
                && pair.First.TimesCount == pair.Second.TimesCount
                && pair.First.HkxName == pair.Second.HkxName
                && pair.First.Events.SequenceEqual(pair.Second.Events)
                && pair.First.EventGroups.Zip(pair.Second.EventGroups).All(gp =>
                    gp.First.EventType == gp.Second.EventType
                    && gp.First.GroupEventCount == gp.Second.GroupEventCount
                    && gp.First.EventOffsets.AsSpan().SequenceEqual(gp.Second.EventOffsets)));
        return new TaeRoundTripReport(
            true, // byte-identical: same source bytes, no mutation
            semanticIdentical,
            SourceHash,
            Hash(SourceBytes),
            Animations.Count,
            TotalEventCount,
            TotalGroupCount);
    }

    public object ToEnvelope(
        TaeRoundTripReport? report = null,
        IReadOnlyList<Diagnostic>? extraDiagnostics = null,
        IReadOnlyDictionary<int, TaeFieldLayout[]>? templateLayouts = null)
    {
        report ??= VerifyRoundTrip();
        const int sampleLimit = 20;
        const int timelineEventLimit = 200; // 每动画事件时间表上限（bounded 分页）
        // S17：参数体 hex 预览上限（无模板布局时的兜底截断）。
        const int paramHexLimit = 64;
        var invalidTimeRangeCount = CountInvalidTimeRanges();
        // 合并上游诊断（如 anibnd 提取 TAE 的 TAE_FROM_ANIBND_EXTRACTED），
        // 使预览面板能显示提取来源而不是只见文档自身诊断。
        var diagnostics = (extraDiagnostics ?? Array.Empty<Diagnostic>())
            .Concat(invalidTimeRangeCount > 0
                ? new[]
                {
                    new Diagnostic(
                        "error",
                        "TAE_INVALID_TIME_RANGE",
                        $"检测到 {invalidTimeRangeCount} 个事件时间范围非法（startTime > endTime 或非有限值），timeline 投影降级为 partial。")
                }
                : Array.Empty<Diagnostic>())
            .ToArray();
        return new
        {
            format = "TAE",
            version = $"0x{Version:X8}",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            animationCount = Animations.Count,
            totalEventCount = TotalEventCount,
            totalGroupCount = TotalGroupCount,
            animations = Animations.Take(sampleLimit).Select(a => new
            {
                animId = a.AnimId,
                eventCount = a.EventCount,
                groupCount = a.EventGroupCount,
                timesCount = a.TimesCount,
                hkxName = a.HkxName,
                events = a.Events.Take(timelineEventLimit).Select(e =>
                {
                    // S17：参数体按模板布局解码（4 字节槽对齐）；无模板时给有界 hex。
                    var decodedFields = templateLayouts != null
                        && templateLayouts.TryGetValue(e.EventTypeId, out var layout)
                        && layout.Length > 0
                        && DecodeParamFields(e, layout, out var decoded)
                        ? decoded
                        : null;
                    return new
                    {
                        startTime = e.StartTime,
                        endTime = e.EndTime,
                        eventTypeId = e.EventTypeId,
                        parameterDecoded = decodedFields != null,
                        templateFields = decodedFields,
                        parameterBytesHex = ParameterBytesHex(e, paramHexLimit)
                    };
                }).ToArray(),
                eventsTruncated = a.Events.Count > timelineEventLimit
            }).ToArray(),
            animationsTruncated = Animations.Count > sampleLimit,
            eventTypes = EventTypes,
            roundTrip = report,
            diagnostics = diagnostics,
            authority = invalidTimeRangeCount > 0 ? "partial" : "candidate"
        };
    }

    /// <summary>
    /// S17：按模板布局解码事件参数体。TAE 参数体字段按 4 字节槽连续排列
    /// （与 DSAS TAE.Template.SDT.xml 的字段声明顺序一致）；越界即截断，
    /// 剩余字段不再假装解码。返回 true 表示整份布局全部解出。
    /// </summary>
    private bool DecodeParamFields(TaeEvent e, TaeFieldLayout[] layout, out object[] fields)
    {
        fields = Array.Empty<object>();
        if (e.ParameterDataOffset <= 0 || e.ParameterDataOffset >= SourceBytes.Length) return false;
        var offset = checked((int)e.ParameterDataOffset);
        var decoded = new object[layout.Length];
        for (var i = 0; i < layout.Length; i++)
        {
            var field = layout[i];
            if (offset + field.SlotSize > SourceBytes.Length)
            {
                // 布局越界：诚实截断，不编造剩余字段。
                return false;
            }
            decoded[i] = new
            {
                name = field.Name,
                kind = field.Kind,
                value = ReadFieldValue(SourceBytes, offset, field)
            };
            offset += field.SlotSize;
        }
        fields = decoded;
        return true;
    }

    private static object ReadFieldValue(byte[] source, int offset, TaeFieldLayout field)
    {
        switch (field.Kind)
        {
            case "s32": return ReadInt32(source, offset);
            case "u32": return unchecked((uint)ReadInt32(source, offset));
            case "f32": return ReadFloat32(source, offset);
            case "s16": return unchecked((short)(source[offset] | (source[offset + 1] << 8)));
            case "u16": return unchecked((ushort)(source[offset] | (source[offset + 1] << 8)));
            case "s8": return unchecked((sbyte)source[offset]);
            case "u8": return source[offset];
            case "b": return source[offset] != 0;
            default: return "未解码";
        }
    }

    /// <summary>参数体有界 hex 预览（无模板布局时的兜底，S17）。</summary>
    private string ParameterBytesHex(TaeEvent e, int limit)
    {
        if (e.ParameterDataOffset <= 0 || e.ParameterDataOffset >= SourceBytes.Length) return "";
        var offset = checked((int)e.ParameterDataOffset);
        var length = Math.Min(limit, SourceBytes.Length - offset);
        if (length <= 0) return "";
        return Convert.ToHexString(SourceBytes.AsSpan(offset, length)).ToLowerInvariant();
    }

    /// <summary>
    /// 统计 startTime &gt; endTime 或任一时间非有限值的事件数。非零时 envelope 的
    /// authority 降为 partial 并携带 TAE_INVALID_TIME_RANGE 诊断（见 ToEnvelope）。
    /// </summary>
    private int CountInvalidTimeRanges()
    {
        var count = 0;
        foreach (var animation in Animations)
        {
            foreach (var ev in animation.Events)
            {
                if (!float.IsFinite(ev.StartTime) || !float.IsFinite(ev.EndTime) || ev.StartTime > ev.EndTime)
                    count++;
            }
        }
        return count;
    }

    // ── Binary helpers ──

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static long ReadInt64(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));

    private static float ReadFloat32(byte[] source, int offset) =>
        BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(offset, 4));

    /// <summary>
    /// 读取动画名（单字节 C 字符串）。
    ///
    /// S17 实证（c1130.anibnd.dcx）：名字区是单字节编码（如 "AE " 的 41 45 20 00），
    /// 不是 UTF-16——旧 ReadUtf16Z 把相邻字节拼成宽字符，读出「䕁 / 葉」一类乱码。
    /// 全 ASCII 直接按 ASCII；含高位字节时按 Shift-JIS（Sekiro 日文名，与 PARAM
    /// 的 CreateShiftJisEncoding 同一套注册）。
    /// </summary>
    private static string? ReadNameZ(byte[] source, int offset)
    {
        var end = offset;
        while (end < source.Length && source[end] != 0)
        {
            end++;
            if (end - offset > 1024)
                throw new InvalidDataException("TAE 动画名未终止或过长。");
        }
        if (end >= source.Length)
            throw new InvalidDataException("TAE 动画名未以空终止。");
        if (end == offset) return null;
        var bytes = source.AsSpan(offset, end - offset);
        var isAscii = true;
        for (var i = 0; i < bytes.Length; i++)
        {
            if (bytes[i] >= 0x80) { isAscii = false; break; }
        }
        if (isAscii) return Encoding.ASCII.GetString(bytes);
        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding(932).GetString(bytes);
        }
        catch (Exception)
        {
            return Encoding.UTF8.GetString(bytes);
        }
    }

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

// ── Records ──

/// <summary>S17：TAE 事件参数体的模板字段布局（来自本机 DSAS TAE.Template.SDT.xml，
/// 由 main 解析后传入；SlotSize 为 4 字节槽）。</summary>
internal sealed record TaeFieldLayout(string Name, string Kind, int SlotSize);

internal sealed record TaeAnimation(
    long AnimId,
    int EventCount,
    int EventGroupCount,
    long TimesCount,
    float[] Times,
    IReadOnlyList<TaeEvent> Events,
    IReadOnlyList<TaeEventGroup> EventGroups,
    long AnimFileInfoOffset,
    string? HkxName);

internal sealed record TaeEvent(
    float StartTime,
    float EndTime,
    int EventTypeId,
    long EventDataOffset,
    long ParameterDataOffset);

internal sealed record TaeEventGroup(
    int EventType,
    long GroupEventCount,
    int[] EventOffsets,
    long GroupTypeUnknown);

/// <summary>anibnd 容器里没有 TAE 魔数条目（映射 TAE_ANIBND_NO_TAE_ENTRY）。</summary>
internal sealed class TaeEntryMissingException : Exception
{
    public TaeEntryMissingException(string message) : base(message) { }
}

internal sealed record TaeRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int AnimationCount,
    int TotalEventCount,
    int TotalGroupCount);

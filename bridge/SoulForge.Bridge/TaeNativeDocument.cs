using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro 1.6.x TAE native document. The Bridge decodes the binary layout and
/// projects event parameters through the embedded first-party schema. Source
/// bytes and native parameter tails remain available to typed writeback.
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
        long eventBank,
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
        EventBank = eventBank;
        // Compatibility alias for older diagnostics. TAE header offset 0x30
        // is the event bank, not an arbitrary counter.
        UnknownCount = eventBank;
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
    public long EventBank { get; }
    public int? SchemaBankId => EventBank is >= int.MinValue and <= int.MaxValue
        && (EventBank == 13 || EventBank == 14)
        ? (int)EventBank
        : null;
    public long UnknownCount { get; }
    public IReadOnlyList<TaeAnimation> Animations { get; }
    public int TotalEventCount { get; }
    public int TotalGroupCount { get; }
    public IReadOnlyList<int> EventTypes { get; }
    public string SourceHash => Hash(SourceBytes);
    internal int InvalidTimeRangeCount => CountInvalidTimeRanges();

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
        var eventBank = ReadInt64(source, 0x30);
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
                // flag at +0x00 == 1 表示别名链接，无自有名字
                var aliasFlag = ReadInt64(source, checked((int)animFileInfoOffset));
                if (aliasFlag != 1)
                {
                    var namePtr = ReadInt64(source, checked((int)animFileInfoOffset + 0x10));
                    if (namePtr > 0 && namePtr + 2 <= source.Length)
                    {
                        try { hkxName = ReadNameUtf16Z(source, checked((int)namePtr)); }
                        catch (InvalidDataException) { /* best-effort */ }
                    }
                }
            }

            totalEvents += eventCount;
            totalGroups += eventGroupCount;
            animations.Add(new TaeAnimation(
                animId, eventCount, eventGroupCount, timesCount,
                times, events, groups, eventGroupTableOffset, animFileInfoOffset, hkxName));
        }

        if (totalEvents > MaxEvents)
            throw new InvalidDataException($"TAE 事件总数 {totalEvents} 超出安全上限 {MaxEvents}。");

        return new TaeNativeDocument(
            source, version, flags, section1Offset, section2Offset, eventBank,
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
    /// Returns the exact native parameter span for one event. The span is
    /// bounded by the next event-data header (or this animation's event-group
    /// table for the last event), matching the public SoulsFormats TAE reader.
    /// A schema may decode a prefix of this span; the remaining bytes are
    /// preserved as a native tail rather than silently discarded.
    /// </summary>
    public int GetParameterLength(long animId, int eventIndex)
    {
        var animation = Animations.FirstOrDefault(a => a.AnimId == animId)
            ?? throw new InvalidDataException($"TAE 动画 animId={animId} 不存在。");
        return GetParameterLength(animation, eventIndex);
    }

    public int GetParameterLength(TaeAnimation animation, int eventIndex)
    {
        if (eventIndex < 0 || eventIndex >= animation.Events.Count)
            throw new InvalidDataException($"TAE 事件索引 {eventIndex} 越界。");
        var ev = animation.Events[eventIndex];
        if (ev.ParameterDataOffset == 0) return 0;
        if (ev.ParameterDataOffset < ev.EventDataOffset + EventDataHeaderSize)
            throw new InvalidDataException("TAE 参数体偏移早于事件头结束，布局无效。");
        var end = eventIndex + 1 < animation.Events.Count
            ? animation.Events[eventIndex + 1].EventDataOffset
            : animation.EventGroupTableOffset > 0
                ? animation.EventGroupTableOffset
                : SourceBytes.Length;
        var length = end - ev.ParameterDataOffset;
        if (length < 0 || length > MaxSourceBytes || length > int.MaxValue)
            throw new InvalidDataException($"TAE 参数体长度 {length} 越界。");
        return checked((int)length);
    }

    public TaeSchemaCoverage GetSchemaCoverage()
    {
        var covered = 0;
        var unknownEvents = 0;
        var lengthMismatches = 0;
        var ambiguous = 0;
        var assertFailures = 0;
        var unknownIds = new SortedSet<int>();
        var assertFailureDetails = new List<TaeSchemaAssertFailure>();
        foreach (var animation in Animations)
        {
            for (var index = 0; index < animation.Events.Count; index++)
            {
                var ev = animation.Events[index];
                var length = GetParameterLength(animation, index);
                var resolution = TaeFirstPartySchema.Resolve(ev.EventTypeId, length, SchemaBankId);
                if (resolution.Event is null)
                {
                    if (resolution.Candidates.Count == 0)
                    {
                        unknownEvents++;
                        unknownIds.Add(ev.EventTypeId);
                    }
                    else
                    {
                        lengthMismatches++;
                    }
                    continue;
                }
                covered++;
                if (resolution.Ambiguous) ambiguous++;
                var decoded = TaeFirstPartySchema.Decode(
                    ev.EventTypeId,
                    ReadParameterBody(ev, length),
                    SchemaBankId);
                assertFailures += decoded.AssertFailures.Count;
                if (decoded.AssertFailures.Count > 0)
                {
                    assertFailureDetails.Add(new TaeSchemaAssertFailure(
                        animation.AnimId,
                        index,
                        ev.EventTypeId,
                        length,
                        decoded.AssertFailures));
                }
            }
        }
        return new TaeSchemaCoverage(
            covered,
            unknownEvents,
            lengthMismatches,
            ambiguous,
            assertFailures,
            unknownIds.ToArray(),
            assertFailureDetails);
    }

    /// <summary>
    /// 事件参数体原始字节：paramDataOffset 起截 length 字节，越界失败关闭。
    /// length 由 TAE 原生事件边界确定；first-party schema 只消费对应前缀，
    /// 任何剩余尾部由调用方作为原始 bytes 保留。
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
    /// Verify source integrity by re-parsing the same bytes and confirming
    /// deterministic structural equality before any typed mutation is staged.
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
        IReadOnlyDictionary<int, TaeFieldLayout[]>? templateLayouts = null,
        int? animationPage = null,
        int? animationPageSize = null)
    {
        report ??= VerifyRoundTrip();
        const int timelineEventLimit = 200; // 每动画事件时间表上限（bounded 分页）
        // S17：参数体 hex 预览上限（无模板布局时的兜底截断）。
        const int paramHexLimit = 64;
        var invalidTimeRangeCount = CountInvalidTimeRanges();
        var motionReferences = new Dictionary<long, ActionAnimationSemantics.TaeMotionReference>();
        var motionAnimationIds = new Dictionary<long, long>();
        var motionDiagnostics = new List<Diagnostic>();
        foreach (var animation in Animations)
        {
            try
            {
                var reference = SekiroTaeMotionReferenceReader.ReadOne(SourceBytes, animation);
                if (!motionReferences.TryAdd(animation.AnimId, reference))
                {
                    motionDiagnostics.Add(new Diagnostic(
                        "error",
                        "TAE_MOTION_IDENTITY_DUPLICATE_ANIMATION_ID",
                        $"TAE animation {animation.AnimId} 出现重复 ID，motion identity 无法唯一确定。"));
                }
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException)
            {
                motionDiagnostics.Add(new Diagnostic(
                    "warning",
                    "TAE_MOTION_REFERENCE_UNAVAILABLE",
                    $"TAE animation {animation.AnimId} 的 motion reference 无法可靠投影：{ex.Message}"));
            }
        }
        foreach (var animation in Animations)
        {
            if (!motionReferences.ContainsKey(animation.AnimId)) continue;
            try
            {
                motionAnimationIds[animation.AnimId] =
                    ActionAnimationSemantics.ResolveMotionAnimationId(motionReferences, animation.AnimId);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException)
            {
                motionDiagnostics.Add(new Diagnostic(
                    "warning",
                    "TAE_MOTION_IDENTITY_UNRESOLVED",
                    $"TAE animation {animation.AnimId} 的 motion identity 无法可靠解析：{ex.Message}"));
            }
        }
        // 合并上游诊断（如 anibnd 提取 TAE 的 TAE_FROM_ANIBND_EXTRACTED），
        // 使预览面板能显示提取来源而不是只见文档自身诊断。
        var schemaCoverage = GetSchemaCoverage();
        var schemaDiagnostics = schemaCoverage.Complete
            ? Array.Empty<Diagnostic>()
            : new[]
            {
                new Diagnostic(
                    "error",
                    "TAE_SCHEMA_COVERAGE_GAP",
                    $"SoulForge 内置 TAE schema 覆盖缺口：未知事件 {schemaCoverage.UnknownEventCount}，"
                    + $"长度不匹配 {schemaCoverage.LengthMismatchCount}，断言失败 {schemaCoverage.AssertFailureCount}。当前范围不会伪造字段或源码。",
                    null,
                    schemaCoverage)
            };
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
            .Concat(motionDiagnostics)
            .Concat(schemaDiagnostics)
            .ToArray();
        return new
        {
            format = "TAE",
            version = $"0x{Version:X8}",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            eventBank = EventBank,
            schemaBankId = SchemaBankId,
            animationCount = Animations.Count,
            totalEventCount = TotalEventCount,
            totalGroupCount = TotalGroupCount,
            animations = (animationPage.HasValue && animationPageSize.HasValue
                ? Animations.Skip(animationPage.Value * animationPageSize.Value).Take(animationPageSize.Value)
                : Animations).Select(a => ToAnimationEnvelope(
                    a,
                    motionAnimationIds.TryGetValue(a.AnimId, out var motionAnimId)
                        ? motionAnimId
                        : (long?)null,
                    templateLayouts,
                    timelineEventLimit,
                    paramHexLimit)).ToArray(),
            animationsTruncated = animationPage.HasValue && animationPageSize.HasValue
                ? Animations.Count > (animationPage.Value + 1) * animationPageSize.Value
                : false,
            eventTypes = EventTypes,
            schema = TaeFirstPartySchema.Metadata(),
            schemaCoverage,
            roundTrip = report,
            diagnostics = diagnostics,
            authority = invalidTimeRangeCount > 0 || motionDiagnostics.Count > 0 || !schemaCoverage.Complete ? "partial" : "candidate"
        };
    }

    /// <summary>
    /// Projects one native animation without changing its source document.  The
    /// optional provenance fields are emitted only for an ANIBND aggregate; the
    /// naked .tae envelope therefore keeps its existing shape.
    /// </summary>
    internal object ToAnimationEnvelope(
        TaeAnimation animation,
        long? motionAnimId,
        IReadOnlyDictionary<int, TaeFieldLayout[]>? templateLayouts,
        int timelineEventLimit,
        int paramHexLimit,
        int? taeEntryIndex = null,
        long? taeEntryId = null,
        string? taeEntryName = null,
        string? taeGroup = null)
    {
        var events = animation.Events.Take(timelineEventLimit).Select((e, eventIndex) =>
        {
            var parameterLength = GetParameterLength(animation, eventIndex);
            var resolution = TaeFirstPartySchema.Resolve(e.EventTypeId, parameterLength, SchemaBankId);
            var decodedResult = resolution.Event is null
                ? null
                : TaeFirstPartySchema.Decode(e.EventTypeId, ReadParameterBody(e, parameterLength), SchemaBankId);
            var decoded = decodedResult?.Fields;
            var decodedComplete = decodedResult?.Complete == true;
            return new
            {
                startTime = e.StartTime,
                endTime = e.EndTime,
                eventTypeId = e.EventTypeId,
                parameterLength,
                parameterDecoded = decodedComplete,
                templateFields = decodedComplete ? decoded : null,
                schemaBankId = resolution.Event?.BankId,
                schemaBankName = resolution.Event?.BankName,
                schemaVariantCount = resolution.Candidates.Count,
                schemaVariant = resolution.Event?.VariantKind,
                parameterBytesHex = ParameterBytesHex(e, parameterLength, paramHexLimit),
                parameterTailLength = resolution.Event is null
                    ? parameterLength
                    : Math.Max(0, parameterLength - resolution.Event.ParamSize)
            };
        }).ToArray();

        if (!taeEntryIndex.HasValue
            && !taeEntryId.HasValue
            && taeEntryName is null
            && taeGroup is null)
        {
            return new
            {
                animId = animation.AnimId,
                eventCount = animation.EventCount,
                groupCount = animation.EventGroupCount,
                timesCount = animation.TimesCount,
                hkxName = animation.HkxName,
                motionAnimId,
                events,
                eventsTruncated = animation.Events.Count > timelineEventLimit
            };
        }

        return new
        {
            taeEntryIndex,
            taeEntryId,
            taeEntryName,
            taeGroup,
            animId = animation.AnimId,
            eventCount = animation.EventCount,
            groupCount = animation.EventGroupCount,
            timesCount = animation.TimesCount,
            hkxName = animation.HkxName,
            motionAnimId,
            events,
            eventsTruncated = animation.Events.Count > timelineEventLimit
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
    private string ParameterBytesHex(TaeEvent e, int parameterLength, int limit)
    {
        if (e.ParameterDataOffset <= 0 || e.ParameterDataOffset >= SourceBytes.Length) return "";
        var offset = checked((int)e.ParameterDataOffset);
        var length = Math.Min(Math.Min(limit, parameterLength), SourceBytes.Length - offset);
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
    private static string? ReadNameUtf16Z(byte[] source, int offset)
    {
        var end = offset;
        while (end + 1 < source.Length && !(source[end] == 0 && source[end + 1] == 0))
        {
            end += 2;
            if (end - offset > 2048)
                throw new InvalidDataException("TAE 动画名未终止或过长。");
        }
        if (end + 1 >= source.Length)
            throw new InvalidDataException("TAE 动画名未以空终止。");
        if (end == offset) return null;
        var text = Encoding.Unicode.GetString(source, offset, end - offset);
        if (string.IsNullOrWhiteSpace(text)) return null;
        return text;
    }

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

// ── Records ──

/// <summary>Legacy layout shape retained for compatibility with older callers;
/// production decoding uses the embedded TaeFirstPartySchema directly.</summary>
internal sealed record TaeFieldLayout(string Name, string Kind, int SlotSize);

internal sealed record TaeAnimation(
    long AnimId,
    int EventCount,
    int EventGroupCount,
    long TimesCount,
    float[] Times,
    IReadOnlyList<TaeEvent> Events,
    IReadOnlyList<TaeEventGroup> EventGroups,
    long EventGroupTableOffset,
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

internal sealed record TaeSchemaCoverage(
    int CoveredEventCount,
    int UnknownEventCount,
    int LengthMismatchCount,
    int AmbiguousEventCount,
    int AssertFailureCount,
    IReadOnlyList<int> UnknownEventTypeIds,
    IReadOnlyList<TaeSchemaAssertFailure> AssertFailureDetails)
{
    public bool Complete => UnknownEventCount == 0
        && LengthMismatchCount == 0
        && AmbiguousEventCount == 0
        && AssertFailureCount == 0;
}

internal sealed record TaeSchemaAssertFailure(
    long AnimId,
    int EventIndex,
    int EventTypeId,
    int ParameterLength,
    IReadOnlyList<string> Fields);

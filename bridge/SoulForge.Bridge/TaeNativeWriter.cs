using System.Buffers.Binary;
using System.Text.Json;

/// <summary>
/// Sekiro TAE (Time Act Editor) event writer（ANIMATION-56C）。
///
/// 只接受 typed event upsert mutation（tae-event-upsert），两个 kind：
///   · <c>update-event-times</c> —— **字节级外科替换**某动画某个事件的
///     startTime/endTime float32。目标动画按 animId 定位，目标事件按事件表下标
///     eventIndex 定位。守卫：新时间必须有限且 start &lt;= end（无效时间区间
///     fail-closed，见 ANIMATION-56A 的 TAE_INVALID_TIME_RANGE）；目标事件的
///     start/end 时间槽必须**不被本动画其他事件共享**（sibling verify：共享槽
///     改写会非预期地改动兄弟事件，拒绝而非静默改多）；事件 start/end 指向同一
///     时间槽（零时长点事件）时新 start 必须等于新 end。
///   · <c>insert-event</c> —— 在动画事件表内**新增事件**。事件参数体
///     （paramData）按 eventTypeId 分派、每类布局不同且本版刻意未解码，因此新
///     事件的参数体必须**逐字节拷贝自模板事件**（templateEventIndex 定位），
///     拷贝长度由「同一动画内事件数据块连续排列」这一在真实 a00.tae 上实测
///     890/890 个非空动画成立的布局不变量确定；不变量不成立即
///     <see cref="TaeWriteBlockedException"/>（TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE）。
///     新增后：动画 eventCount+1，事件表整表复制到文件末尾并重定位事件表指针；
///     新时间追加为新 float32 槽（不与既有事件共享）。新事件**不自动登记进
///     事件组**（组语义按 eventTypeId 分派，未知时不得猜测；卡片 flow 只要求
///     container rebuild/Patch/reopen/time/sibling verify/rollback）。
///
/// 无损策略：update 是纯字节外科（目标时间槽之外的一切字节原样保留）；insert
/// 只追加新块并复制既有事件表，旧字节逐位保留。两者写回重读后，output 与写前
/// 逐字节比对必须只差预期的区间（外科替换区间 / 追加区与动画条目的
/// eventTableOffset+eventCount），这是「未知字段/未解析 gap 逐字节无损保留」的
/// 可判定证据——TAE reader 没有 unparsedGaps（参数体按不透明 offset 上报），
/// 字节级 diff 是比 gap 清单更强的不变式。
///
/// DCX：TAE 在 Sekiro 中位于 anibnd.dcx 容器内子项；容器外层重建由 Patch Engine
/// 在 main 侧完成（与 MTD/ESD 同一分工）。本 writer 只接受 loose .tae，不接受
/// DCX/BND 外壳——单文件 TAE 的写由 writer 负责，容器层不重复。
/// </summary>
internal static class TaeNativeWriter
{
    // ── Layout constants（与 TaeNativeDocument.cs 同源；改动必须同步）──
    private const int FileHeaderSize = 0x50;
    private const int Section1HeaderSize = 0x30;
    private const int AnimTableEntrySize = 16;
    private const int AnimationEntrySize = 0x30;
    private const int EventTableEntrySize = 24;
    private const int EventDataHeaderSize = 16;
    private const int EventGroupEntrySize = 32;
    private const long MaxSourceBytes = 64L * 1024 * 1024;

    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        if (source.Length < FileHeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"TAE 大小 {source.Length} 超出安全范围。");
        // 只接受 loose .tae：DCX/BND 容器外层重建由 Patch Engine 在 main 侧完成，
        // 本 writer 不重复实现容器逻辑（硬约束「不要发明第二套容器重建逻辑」）。
        if (source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            throw new InvalidDataException("write-tae-document 只接受 loose .tae；DCX/BND 容器外层重建由 Patch Engine 在 main 侧完成。");
        var document = TaeNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "TAE source hash");

        var mutations = new List<TaeMutation>();
        if (options.TryGetProperty("mutations", out var mutationArray) && mutationArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutationArray.EnumerateArray())
                mutations.Add(ParseMutation(item));
        }
        else
        {
            mutations.Add(ParseMutation(options));
        }
        if (mutations.Count == 0)
            throw new InvalidDataException("TAE writer 需要至少一条 mutation。");

        var context = new WriteContext(source);
        var appliedResults = new List<TaeApplied>(mutations.Count);
        foreach (var mutation in mutations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            // BeforeBytes：本条 mutation 应用前的字节快照。校验时 output 与它比较，
            // 这样多条 mutation 的顺序应用各自只对「自己的增量」负责。
            var before = (byte[])context.Bytes.Clone();
            var applied = context.Apply(mutation);
            applied.BeforeBytes = before;
            appliedResults.Add(applied);
        }

        var rebuilt = context.Bytes;
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-tae-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, rebuilt, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        // ── Reopen reread 校验：语义 + 字节级外科 / 无意外变化 ──
        var reread = TaeNativeDocument.ReadFile(outputPath);
        var roundTrip = reread.VerifyRoundTrip();
        if (!roundTrip.SemanticIdentical)
            throw new InvalidDataException("重读后 TAE 语义往返不一致。");
        if (reread.Animations.Count != document.Animations.Count)
            throw new InvalidDataException(
                $"重读后动画数 {reread.Animations.Count} ≠ 写前 {document.Animations.Count}。");

        var insertCount = mutations.Count(m => m.Kind == "insert-event");
        var updateCount = mutations.Count(m => m.Kind == "update-event-times");
        var expectedTotalEvents = document.TotalEventCount + insertCount;
        if (reread.TotalEventCount != expectedTotalEvents)
            throw new InvalidDataException(
                $"重读后事件总数 {reread.TotalEventCount} ≠ 写前 {document.TotalEventCount} + {insertCount}。");

        var summaries = new List<object>(mutations.Count);
        for (var i = 0; i < mutations.Count; i++)
        {
            context.VerifyReread(mutations[i], appliedResults[i], reread);
            summaries.Add(appliedResults[i].ToSummary());
        }

        // ── 整体字节级外科：output 相对源基线只允许「全部 mutation 的预期区间」
        //    不同。这是「未知字段/未解析 gap 逐字节无损保留」的可判定证据，且天然
        //    兼容多 mutation 顺序应用（每条的预期区间都在源坐标上累加）。 ──
        context.VerifySurgicalAgainstSource(reread.SourceBytes);

        return new
        {
            mutationCount = mutations.Count,
            updateCount,
            insertCount,
            outputHash = reread.SourceHash,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            structurePreserved = true,
            byteSurgical = insertCount == 0 && appliedResults.All(a => a.Kind == "update-event-times"),
            mutations = summaries
        };
    }

    private static TaeMutation ParseMutation(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("mutation", out _) ? "mutation" : "kind").ToLowerInvariant();
        switch (kind)
        {
            case "update-event-times":
            {
                var animId = RequiredInt64(item, "animId");
                var eventIndex = RequiredInt32(item, "eventIndex");
                var startTime = RequiredFloat(item, "startTime");
                var endTime = RequiredFloat(item, "endTime");
                return new TaeMutation(kind, animId, eventIndex, null, null, startTime, endTime);
            }
            case "insert-event":
            {
                var animId = RequiredInt64(item, "animId");
                var templateEventIndex = RequiredInt32(item, "templateEventIndex");
                var eventTypeId = OptionalInt32(item, "eventTypeId");
                var startTime = RequiredFloat(item, "startTime");
                var endTime = RequiredFloat(item, "endTime");
                return new TaeMutation(kind, animId, null, templateEventIndex, eventTypeId, startTime, endTime);
            }
            default:
                throw new InvalidDataException($"未知 TAE mutation 类型：{kind}");
        }
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static long RequiredInt64(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)
            ? parsed : throw new InvalidDataException($"options.{field} 是必填整数。");

    private static int RequiredInt32(JsonElement options, string field)
    {
        var value = RequiredInt64(options, field);
        if (value is < int.MinValue or > int.MaxValue) throw new InvalidDataException($"options.{field} 超出 int32 范围。");
        return (int)value;
    }

    private static int? OptionalInt32(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)
            ? parsed : null;

    private static float RequiredFloat(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetSingle(out var parsed)
            ? parsed : throw new InvalidDataException($"options.{field} 是必填浮点数。");

    private static void ValidateTimes(float startTime, float endTime)
    {
        // ANIMATION-56A：无效时间区间（start > end 或非有限值）为 partial/error。
        // writer 收到这类区间直接 fail-closed，不写坏时间轴。
        if (!float.IsFinite(startTime) || !float.IsFinite(endTime) || startTime > endTime)
            throw new InvalidDataException(
                $"无效时间区间：startTime={startTime} endTime={endTime}（必须有限且 start ≤ end）。");
    }

    private static void WriteFloat32(byte[] data, int offset, float value) =>
        BinaryPrimitives.WriteSingleLittleEndian(data.AsSpan(offset, 4), value);

    /// <summary>
    /// 一个 TAE event upsert mutation 的解析后形态。source 定位统一用
    /// animId（读信封的 stable id）+ eventIndex / templateEventIndex（事件表下标）。
    /// </summary>
    private sealed record TaeMutation(
        string Kind,
        long AnimId,
        int? EventIndex,
        int? TemplateEventIndex,
        int? EventTypeId,
        float StartTime,
        float EndTime);

    /// <summary>
    /// writer 对一个 mutation 的应用结果（含写后校验所需的已计算偏移与旧值）。
    /// <see cref="BeforeBytes"/> 是本条 mutation 应用前的字节快照，用于逐条做
    /// 字节级外科 / 无意外变化校验。
    /// </summary>
    private sealed class TaeApplied
    {
        public required string Kind { get; init; }
        public long AnimId { get; init; }
        public int? EventIndex { get; init; }
        public int? TemplateEventIndex { get; init; }
        public float StartTime { get; init; }
        public float EndTime { get; init; }
        public byte[] BeforeBytes { get; set; } = Array.Empty<byte>();
        // update-event-times 专用
        public int? StartTimeAbs { get; init; }
        public int? EndTimeAbs { get; init; }
        // insert-event 专用
        public int? NewEventIndex { get; init; }
        public int? NewEventTypeId { get; init; }
        public int ParamBytesCopied { get; init; }
        public int? NewTableAbs { get; init; }
        /// <summary>目标动画条目的绝对偏移（源布局，写入后不变）。</summary>
        public int AnimEntryAbs { get; init; }
        /// <summary>模板事件参数体的绝对偏移（源布局，写入后不变）。</summary>
        public int TemplateParamAbs { get; init; }
        /// <summary>追加区起点（本条 mutation 应用前的工作字节长度）。</summary>
        public int AppendStart { get; init; }
        /// <summary>目标动画写前事件数。</summary>
        public int OldEventCount { get; init; }

        public object ToSummary() => Kind switch
        {
            "update-event-times" => new
            {
                mutation = Kind,
                animId = AnimId,
                eventIndex = EventIndex,
                startTime = StartTime,
                endTime = EndTime,
                byteSurgical = true
            },
            _ => new
            {
                mutation = Kind,
                animId = AnimId,
                templateEventIndex = TemplateEventIndex,
                newEventIndex = NewEventIndex,
                eventTypeId = NewEventTypeId,
                startTime = StartTime,
                endTime = EndTime,
                paramBytesCopied = ParamBytesCopied,
                eventTableRelocated = true,
                newEventTableRelOffset = NewTableAbs
            }
        };
    }

    /// <summary>
    /// 写上下文：持有源字节与工作字节，提供 layout 遍历、字节读写与追加。
    /// 事件定位用绝对偏移（TAE 的 offset 本就是绝对 int64/int32）。
    /// </summary>
    private sealed class WriteContext
    {
        private readonly byte[] _source;
        private byte[] _bytes;
        private TaeLayout _layout;
        private readonly List<(int Start, int End)> _expectedRegions = new();

        public WriteContext(byte[] source)
        {
            _source = source;
            _bytes = (byte[])source.Clone();
            _layout = TaeLayout.Read(source);
        }

        public byte[] Bytes => _bytes;

        /// <summary>全部 mutation 预期的改动区间（相对源坐标；insert 的追加区为其
        /// 起点到自身结束后的长度）。最终一次性对照源字节做外科校验。</summary>
        public IReadOnlyList<(int Start, int End)> ExpectedRegions => _expectedRegions;

        /// <summary>
        /// output 相对源基线只允许在 <see cref="ExpectedRegions"/> 内不同；这是
        /// 全部 mutation 顺序应用后「未知结构逐字节无损保留」的可判定证据。
        /// </summary>
        public void VerifySurgicalAgainstSource(byte[] output)
        {
            if (output.Length < _source.Length)
                throw new InvalidDataException($"重读 output 长度 {output.Length} 短于源 {_source.Length}。");
            for (var i = 0; i < _source.Length; i++)
            {
                var inRegion = _expectedRegions.Any(r => i >= r.Start && i < r.End);
                if (!inRegion && output[i] != _source[i])
                    throw new InvalidDataException($"重读 output 在偏移 {i} 与源不一致（预期改动区间外）。");
            }
        }

        public TaeApplied Apply(TaeMutation mutation)
        {
            // 逐条 mutation 前重走**当前工作字节**的布局：insert 会重定位事件表
            // 指针并追加新表，下一条 mutation 必须基于当前指针而非初始指针定位。
            _layout = TaeLayout.Read(_bytes);
            return mutation.Kind switch
            {
                "update-event-times" => ApplyUpdateEventTimes(mutation),
                "insert-event" => ApplyInsertEvent(mutation),
                _ => throw new InvalidDataException($"未知 TAE mutation 类型：{mutation.Kind}")
            };
        }

        // ── update-event-times ──

        private TaeApplied ApplyUpdateEventTimes(TaeMutation mutation)
        {
            ValidateTimes(mutation.StartTime, mutation.EndTime);
            var anim = ResolveAnim(mutation.AnimId);
            var ev = ResolveEvent(anim, mutation.EventIndex!.Value);
            // sibling verify：时间槽不得被兄弟事件共享。共享槽改写会非预期地
            // 改动兄弟事件，不是「单事件外科更新」，拒绝而非静默改多。
            foreach (var other in anim.Events)
            {
                if (other.Index == ev.Index) continue;
                if (other.StartTimeAbs == ev.StartTimeAbs)
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 事件 {ev.Index} 的起始时间槽被事件 {other.Index} 共享；"
                        + "改写会非预期地改动兄弟事件（sibling verify 失败），拒绝写回。",
                        new { mutation = mutation.Kind, reason = "shared-start-time-slot" });
                if (other.EndTimeAbs == ev.EndTimeAbs)
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 事件 {ev.Index} 的结束时间槽被事件 {other.Index} 共享；"
                        + "改写会非预期地改动兄弟事件（sibling verify 失败），拒绝写回。",
                        new { mutation = mutation.Kind, reason = "shared-end-time-slot" });
            }
            // 零时长点事件（start/end 指向同一时间槽）：只能写入同一个值。
            if (ev.StartTimeAbs == ev.EndTimeAbs && mutation.StartTime != mutation.EndTime)
                throw new TaeWriteBlockedException(
                    $"TAE 动画 {mutation.AnimId} 事件 {ev.Index} 的 start/end 指向同一时间槽（点事件），"
                    + $"要求 startTime == endTime，收到 {mutation.StartTime} ≠ {mutation.EndTime}。",
                    new { mutation = mutation.Kind, reason = "point-event-single-slot" });

            WriteFloat32(_bytes, ev.StartTimeAbs, mutation.StartTime);
            if (ev.EndTimeAbs != ev.StartTimeAbs)
                WriteFloat32(_bytes, ev.EndTimeAbs, mutation.EndTime);
            // 预期改动区间（相对源坐标）：两个时间槽（可能重合为 1 个）。
            _expectedRegions.Add((ev.StartTimeAbs, ev.StartTimeAbs + 4));
            if (ev.EndTimeAbs != ev.StartTimeAbs)
                _expectedRegions.Add((ev.EndTimeAbs, ev.EndTimeAbs + 4));

            return new TaeApplied
            {
                Kind = mutation.Kind,
                AnimId = mutation.AnimId,
                EventIndex = mutation.EventIndex,
                StartTime = mutation.StartTime,
                EndTime = mutation.EndTime,
                StartTimeAbs = ev.StartTimeAbs,
                EndTimeAbs = ev.EndTimeAbs,
                AnimEntryAbs = anim.AnimEntryAbs
            };
        }

        private void VerifyUpdateEventTimesReread(TaeMutation mutation, TaeApplied applied, TaeNativeDocument reread)
        {
            var output = reread.SourceBytes;
            if (BinaryPrimitives.ReadSingleLittleEndian(output.AsSpan(applied.StartTimeAbs!.Value, 4)) != mutation.StartTime)
                throw new InvalidDataException($"重读后事件 {mutation.EventIndex} 的 startTime 与写入不一致。");
            if (applied.EndTimeAbs!.Value != applied.StartTimeAbs.Value
                && BinaryPrimitives.ReadSingleLittleEndian(output.AsSpan(applied.EndTimeAbs.Value, 4)) != mutation.EndTime)
                throw new InvalidDataException($"重读后事件 {mutation.EventIndex} 的 endTime 与写入不一致。");
            // 字节级外科（逐字节无意外变化）在 WriteAsync 末尾对源基线一次性校验，
            // 这里只做本条 mutation 的语义命中校验（多 mutation 顺序应用时 output
            // 含后续 mutation 的改动，逐字节比对必须用源基线而非本条写前快照）。
        }

        // ── insert-event ──

        private TaeApplied ApplyInsertEvent(TaeMutation mutation)
        {
            ValidateTimes(mutation.StartTime, mutation.EndTime);
            var anim = ResolveAnim(mutation.AnimId);
            var template = ResolveEvent(anim, mutation.TemplateEventIndex!.Value);

            // 事件参数体布局不变量：同一动画内事件数据块连续排列（真实 a00.tae
            // 890/890 个非空动画成立）。不成立时 span 不可判定，插入会猜错参数体
            // 长度 → fail-closed，不开放该 mutation。
            for (var i = 0; i < anim.Events.Count - 1; i++)
            {
                var cur = anim.Events[i];
                var nxt = anim.Events[i + 1];
                if (cur.ParamDataAbs != 0
                    && (cur.ParamDataAbs < cur.EventDataAbs + EventDataHeaderSize || cur.ParamDataAbs > nxt.EventDataAbs))
                {
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 事件 {cur.Index} 的参数体偏移 {cur.ParamDataAbs} 不在"
                        + $"[eventData+16={cur.EventDataAbs + EventDataHeaderSize}, nextEventData={nxt.EventDataAbs}) 内，"
                        + "事件数据块不连续，无法无损判定参数体长度，拒绝插入新事件。",
                        new { mutation = mutation.Kind, reason = "event-param-layout-not-contiguous" });
                }
            }
            var last = anim.Events[^1];
            if (last.ParamDataAbs != 0
                && (last.ParamDataAbs < last.EventDataAbs + EventDataHeaderSize || last.ParamDataAbs > anim.EventGroupTableAbs))
            {
                throw new TaeWriteBlockedException(
                    $"TAE 动画 {mutation.AnimId} 事件 {last.Index} 的参数体偏移 {last.ParamDataAbs} 越出"
                    + $"[eventData+16={last.EventDataAbs + EventDataHeaderSize}, eventGroupTable={anim.EventGroupTableAbs})，"
                    + "无法无损判定末尾事件参数体长度，拒绝插入新事件。",
                    new { mutation = mutation.Kind, reason = "last-event-param-layout-unknown" });
            }

            // 模板参数体 span：param==0 → 空参数体；否则到下一个事件数据头 / 事件组表。
            var templateSpan = template.ParamDataAbs == 0
                ? 0
                : template.Index < anim.Events.Count - 1
                    ? anim.Events[template.Index + 1].EventDataAbs - template.ParamDataAbs
                    : anim.EventGroupTableAbs - template.ParamDataAbs;
            if (templateSpan < 0)
                throw new TaeWriteBlockedException(
                    $"TAE 动画 {mutation.AnimId} 模板事件 {template.Index} 参数体长度为负，布局不可信，拒绝插入。",
                    new { mutation = mutation.Kind, reason = "negative-param-span" });

            var eventTypeId = mutation.EventTypeId ?? template.EventTypeId;
            if (mutation.EventTypeId is { } requestedType && requestedType != template.EventTypeId)
                throw new InvalidDataException(
                    $"insert-event 的 eventTypeId {requestedType} 与模板事件 {template.Index} 的类型 {template.EventTypeId} 不一致"
                    + "（参数体按模板逐字节拷贝，类型必须一致才有意义）。");

            var beforeLength = _bytes.Length;

            // 1) 新时间槽：追加两个 float32（不与既有事件共享）。
            var startTimeAbs = Append(BitConverter.GetBytes(mutation.StartTime));
            var endTimeAbs = Append(BitConverter.GetBytes(mutation.EndTime));

            // 2) 新参数体：从当前工作字节逐字节拷贝模板参数体。
            var paramDataAbs = 0;
            if (templateSpan > 0)
            {
                var paramCopy = new byte[templateSpan];
                Buffer.BlockCopy(_bytes, template.ParamDataAbs, paramCopy, 0, templateSpan);
                paramDataAbs = Append(paramCopy);
            }

            // 3) 新事件数据头（16 字节）：类型 + 模板的 padding 逐字节拷贝 + 参数体偏移。
            var header = new byte[EventDataHeaderSize];
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0, 4), eventTypeId);
            // +0x04 int32 padding：reader 不校验，这里逐字节拷贝模板 header 的 padding
            // （真实格式可能在用，未知即保留）。
            Buffer.BlockCopy(_bytes, template.EventDataAbs + 4, header, 4, 4);
            BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(8, 8), paramDataAbs);
            var eventDataAbs = Append(header);

            // 4) 新事件表 = 当前事件表（逐字节拷贝）+ 新 24 字节条目；重定位动画事件表指针。
            var oldTable = new byte[checked((int)(anim.EventCount * EventTableEntrySize))];
            Buffer.BlockCopy(_bytes, anim.EventTableAbs, oldTable, 0, oldTable.Length);
            var newEntry = new byte[EventTableEntrySize];
            BinaryPrimitives.WriteInt64LittleEndian(newEntry.AsSpan(0, 8), startTimeAbs);
            BinaryPrimitives.WriteInt64LittleEndian(newEntry.AsSpan(8, 8), endTimeAbs);
            BinaryPrimitives.WriteInt64LittleEndian(newEntry.AsSpan(16, 8), eventDataAbs);
            var newTable = new byte[oldTable.Length + newEntry.Length];
            Buffer.BlockCopy(oldTable, 0, newTable, 0, oldTable.Length);
            Buffer.BlockCopy(newEntry, 0, newTable, oldTable.Length, newEntry.Length);
            var newTableAbs = Append(newTable);

            // 5) 动画条目：重定位事件表指针 + eventCount+1。
            BinaryPrimitives.WriteInt64LittleEndian(_bytes.AsSpan(anim.AnimEntryAbs, 8), newTableAbs);
            BinaryPrimitives.WriteInt32LittleEndian(_bytes.AsSpan(anim.AnimEntryAbs + 0x20, 4), anim.EventCount + 1);

            // 6) 文件头声明大小（0x0C int32）：追加后必须与实际长度一致，
            //    否则 TaeNativeDocument.Read 的「声明大小与实际不一致」会拒读。
            BinaryPrimitives.WriteInt32LittleEndian(_bytes.AsSpan(0x0C, 4), _bytes.Length);
            // 预期改动区间（相对源坐标）：声明大小 + 动画条目事件表指针/eventCount
            // + 本次追加区（起点 = 本条 mutation 应用前的工作字节长度，终点 = 追加后）。
            _expectedRegions.Add((0x0C, 0x10));
            _expectedRegions.Add((anim.AnimEntryAbs, anim.AnimEntryAbs + 8));
            _expectedRegions.Add((anim.AnimEntryAbs + 0x20, anim.AnimEntryAbs + 0x24));
            _expectedRegions.Add((beforeLength, _bytes.Length));

            return new TaeApplied
            {
                Kind = mutation.Kind,
                AnimId = mutation.AnimId,
                TemplateEventIndex = mutation.TemplateEventIndex,
                StartTime = mutation.StartTime,
                EndTime = mutation.EndTime,
                NewEventIndex = anim.EventCount, // 新事件是追加在事件表末尾的最后一个
                NewEventTypeId = eventTypeId,
                ParamBytesCopied = templateSpan,
                NewTableAbs = newTableAbs,
                AnimEntryAbs = anim.AnimEntryAbs,
                TemplateParamAbs = template.ParamDataAbs,
                AppendStart = beforeLength, // 追加区起点：新时间槽之前
                OldEventCount = anim.EventCount
            };
        }

        private void VerifyInsertEventReread(TaeMutation mutation, TaeApplied applied, TaeNativeDocument reread)
        {
            var output = reread.SourceBytes;
            var before = applied.BeforeBytes;
            // 新事件表首指针命中动画条目。
            if (BinaryPrimitives.ReadInt64LittleEndian(output.AsSpan(applied.AnimEntryAbs, 8)) != applied.NewTableAbs)
                throw new InvalidDataException($"重读后动画 {applied.AnimId} 的事件表指针未指向新表。");
            // 动画事件数 +1、新事件时间/类型命中。
            var animReread = reread.Animations.First(a => a.AnimId == applied.AnimId);
            if (animReread.EventCount != applied.OldEventCount + 1)
                throw new InvalidDataException(
                    $"重读后动画 {applied.AnimId} 事件数 {animReread.EventCount} ≠ 写前 {applied.OldEventCount} + 1。");
            var newEv = animReread.Events[^1];
            if (Math.Abs(newEv.StartTime - applied.StartTime) > 0.0001f
                || Math.Abs(newEv.EndTime - applied.EndTime) > 0.0001f)
                throw new InvalidDataException(
                    $"重读后新事件时间 {newEv.StartTime}/{newEv.EndTime} ≠ 写入 {applied.StartTime}/{applied.EndTime}。");
            if (newEv.EventTypeId != applied.NewEventTypeId)
                throw new InvalidDataException($"重读后新事件类型 {newEv.EventTypeId} ≠ 写入 {applied.NewEventTypeId}。");
            // 新事件参数体逐字节等于模板（写前快照里的模板区域）：无损拷贝的直接证据。
            if (applied.ParamBytesCopied > 0)
            {
                var newParamAbs = checked((int)newEv.ParameterDataOffset);
                for (var i = 0; i < applied.ParamBytesCopied; i++)
                {
                    if (output[newParamAbs + i] != before[applied.TemplateParamAbs + i])
                        throw new InvalidDataException("新事件参数体与模板不一致（模板 span 定位错误）。");
                }
            }
            // 字节级外科（逐字节无意外变化）在 WriteAsync 末尾对源基线一次性校验，
            // 这里只做本条 mutation 的语义命中校验（见 VerifyUpdateEventTimesReread）。
        }

        // ── 公共校验入口 ──

        public void VerifyReread(TaeMutation mutation, TaeApplied applied, TaeNativeDocument reread)
        {
            switch (mutation.Kind)
            {
                case "update-event-times":
                    VerifyUpdateEventTimesReread(mutation, applied, reread);
                    break;
                case "insert-event":
                    VerifyInsertEventReread(mutation, applied, reread);
                    break;
            }
        }

        // ── layout 定位 ──

        private TaeLayout.AnimInfo ResolveAnim(long animId)
        {
            var anim = _layout.FindAnim(animId);
            if (anim is null)
                throw new InvalidDataException($"TAE 动画 animId={animId} 不存在。");
            return anim;
        }

        private static TaeLayout.EventInfo ResolveEvent(TaeLayout.AnimInfo anim, int eventIndex)
        {
            if (eventIndex < 0 || eventIndex >= anim.Events.Count)
                throw new InvalidDataException(
                    $"TAE 动画 {anim.AnimId} 事件下标 {eventIndex} 越界（事件数 {anim.Events.Count}）。");
            return anim.Events[eventIndex];
        }

        // ── 字节级工具 ──

        private int Append(byte[] block)
        {
            var abs = _bytes.Length;
            var next = new byte[_bytes.Length + block.Length];
            Buffer.BlockCopy(_bytes, 0, next, 0, _bytes.Length);
            Buffer.BlockCopy(block, 0, next, _bytes.Length, block.Length);
            _bytes = next;
            return abs;
        }
    }

    /// <summary>
    /// 从源字节轻量重走 TAE 布局：动画条目 → 事件表 → 事件数据块，供
    /// update/insert 定位事件与校验布局。与 TaeNativeDocument.Read 的布局口径
    /// 一致（TaeNativeDocument 已先通过校验，这里只在它之上做 writer 需要的
    /// byte 级定位）。
    /// </summary>
    private sealed class TaeLayout
    {
        private readonly Dictionary<long, AnimInfo> _animations;

        private TaeLayout(Dictionary<long, AnimInfo> animations)
        {
            _animations = animations;
        }

        public AnimInfo? FindAnim(long animId) => _animations.TryGetValue(animId, out var anim) ? anim : null;

        public sealed class AnimInfo
        {
            public required long AnimId { get; init; }
            public required int AnimEntryAbs { get; init; }
            public required int EventTableAbs { get; init; }
            public required int EventGroupTableAbs { get; init; }
            public required int EventCount { get; init; }
            public required List<EventInfo> Events { get; init; } = new();
        }

        public sealed class EventInfo
        {
            public required int Index { get; init; }
            public required int StartTimeAbs { get; init; }
            public required int EndTimeAbs { get; init; }
            public required int EventDataAbs { get; init; }
            public required int EventTypeId { get; init; }
            public required int ParamDataAbs { get; init; }
        }

        public static TaeLayout Read(byte[] source)
        {
            if (source.Length < FileHeaderSize || source.Length > MaxSourceBytes)
                throw new InvalidDataException("TAE 大小超出安全范围。");
            if (!source.AsSpan(0, 4).SequenceEqual("TAE "u8))
                throw new InvalidDataException("输入不是 TAE（缺少 \"TAE \" 魔数）。");

            var section1Offset = ReadInt64(source, 0x20);
            if (section1Offset < FileHeaderSize || section1Offset + Section1HeaderSize > source.Length)
                throw new InvalidDataException("TAE Section 1 头偏移越界。");
            var s1 = checked((int)section1Offset);
            var animTableEntryCount = ReadInt32(source, s1 + 0x04);
            var animTableOffset = ReadInt64(source, s1 + 0x08);
            if (animTableEntryCount < 0 || animTableEntryCount > 100_000)
                throw new InvalidDataException("TAE 动画表条目数越界。");
            var animTableDataOffset = animTableOffset + 8;
            if (animTableOffset < 0 || animTableDataOffset + (long)animTableEntryCount * AnimTableEntrySize > source.Length)
                throw new InvalidDataException("TAE 动画表越界。");

            var animations = new Dictionary<long, AnimInfo>(animTableEntryCount);
            for (var i = 0; i < animTableEntryCount; i++)
            {
                var te = checked((int)(animTableDataOffset + (long)i * AnimTableEntrySize));
                var animEntryOffset = ReadInt64(source, te);
                var animId = ReadInt64(source, te + 8);
                if (animEntryOffset < 0 || animEntryOffset + AnimationEntrySize > source.Length)
                    throw new InvalidDataException($"TAE 动画 {animId} 条目偏移越界。");
                var ae = checked((int)animEntryOffset);
                var eventTableOffset = ReadInt64(source, ae);
                var eventGroupTableOffset = ReadInt64(source, ae + 0x08);
                var eventCount = ReadInt32(source, ae + 0x20);
                var eventGroupCount = ReadInt32(source, ae + 0x24);
                if (eventCount < 0 || eventCount > 1_000_000)
                    throw new InvalidDataException($"TAE 动画 {animId} 事件数越界。");
                if (eventGroupCount < 0 || eventGroupCount > 1_000_000)
                    throw new InvalidDataException($"TAE 动画 {animId} 事件组数越界。");
                if (eventCount > 0
                    && (eventTableOffset < 0 || eventTableOffset + (long)eventCount * EventTableEntrySize > source.Length))
                    throw new InvalidDataException($"TAE 动画 {animId} 事件表越界。");
                if (eventGroupCount > 0
                    && (eventGroupTableOffset < 0
                        || eventGroupTableOffset + (long)eventGroupCount * EventGroupEntrySize > source.Length))
                    throw new InvalidDataException($"TAE 动画 {animId} 事件组表越界。");

                var events = new List<EventInfo>(eventCount);
                for (var e = 0; e < eventCount; e++)
                {
                    var et = checked((int)(eventTableOffset + (long)e * EventTableEntrySize));
                    var startTimeOffset = ReadInt64(source, et);
                    var endTimeOffset = ReadInt64(source, et + 0x08);
                    var eventDataOffset = ReadInt64(source, et + 0x10);
                    if (startTimeOffset < 0 || startTimeOffset + 4 > source.Length
                        || endTimeOffset < 0 || endTimeOffset + 4 > source.Length)
                        throw new InvalidDataException($"TAE 动画 {animId} 事件 {e} 时间偏移越界。");
                    if (eventDataOffset < 0 || eventDataOffset + EventDataHeaderSize > source.Length)
                        throw new InvalidDataException($"TAE 动画 {animId} 事件 {e} 数据偏移越界。");
                    var ed = checked((int)eventDataOffset);
                    var eventTypeId = ReadInt32(source, ed);
                    var paramDataOffset = ReadInt64(source, ed + 0x08);
                    if (paramDataOffset is < 0 or > int.MaxValue)
                        throw new InvalidDataException($"TAE 动画 {animId} 事件 {e} 参数体偏移异常。");
                    events.Add(new EventInfo
                    {
                        Index = e,
                        StartTimeAbs = checked((int)startTimeOffset),
                        EndTimeAbs = checked((int)endTimeOffset),
                        EventDataAbs = checked((int)eventDataOffset),
                        EventTypeId = eventTypeId,
                        ParamDataAbs = (int)paramDataOffset
                    });
                }

                animations[animId] = new AnimInfo
                {
                    AnimId = animId,
                    AnimEntryAbs = ae,
                    EventTableAbs = checked((int)eventTableOffset),
                    EventGroupTableAbs = checked((int)eventGroupTableOffset),
                    EventCount = eventCount,
                    Events = events
                };
            }
            return new TaeLayout(animations);
        }

        private static int ReadInt32(byte[] source, int offset) =>
            BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

        private static long ReadInt64(byte[] source, int offset) =>
            BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
    }
}

/// <summary>
/// TAE writer 的 fail-closed block 异常：未知结构无法无损保留时抛出，
/// dispatch 捕获后映射为 TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE + 结构化诊断。
/// 照 EsdWriteBlockedException / MtdWriteBlockedException 模式。
/// </summary>
internal sealed class TaeWriteBlockedException : Exception
{
    public TaeWriteBlockedException(string message, object? details = null) : base(message)
    {
        Details = details;
    }

    public object? Details { get; }
}

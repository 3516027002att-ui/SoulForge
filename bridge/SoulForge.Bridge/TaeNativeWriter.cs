using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// Sekiro TAE (Time Act Editor) event writer (ANIMATION-56C / SF-11).
///
/// 遵循 SF-11 规范：
/// 1. 彻底移除 m 份整文件克隆快照 (BeforeBytes)，改由不可变基线与 ByteRangeWritePlan 管理；
/// 2. 非共享槽保留原位写入；共享槽变更/点事件拆分按动画追加完整时间表，重定位已知指针，不覆盖旧共享槽；
/// 3. 时间表与事件插入共同规划，保留原时间表、未知区及其它动画的字节，未知布局仍拒绝写回；
/// 4. 动画内多事件插入按动画分组 (Grouped by Animation)，每个动画仅计算并追加一次最终 eventTable，杜绝 O(mB) 复制开销；
/// 5. 写入前对修改区间进行 O(M log M) 排序合并，输出后对基线未触及区间与追加块执行流式逐字节验证。
/// </summary>
internal static class TaeNativeWriter
{
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

        var layout = TaeLayout.Read(source);
        var timeSlotMap = BuildGlobalTimeSlotMap(layout);
        var templates = ResolveInsertionTemplates(mutations, layout, source);

        // 1. 全量静态前置校验；共享槽由后续完整时间表 COW 计划处理。
        ValidateMutations(mutations, layout, source, templates);

        // 2. 构建区间写入计划 (SF-11 §2.6.3)
        var plan = new ByteRangeWritePlan(source);
        var appliedSummaries = BuildAndApplyPlan(mutations, layout, plan, source, templates, timeSlotMap);

        if (plan.CurrentAppendOffset > MaxSourceBytes)
            throw new InvalidDataException("TAE 写入后大小超出安全范围。");

        // 3. 单次分配最终输出 (O(B+A))
        var rebuilt = plan.Apply();

        // 5. 重读验证：语义一致性 + 动画数 + 事件数
        var reread = TaeNativeDocument.Read(rebuilt);
        var roundTrip = reread.VerifyRoundTrip();
        if (!roundTrip.SemanticIdentical)
            throw new InvalidDataException("重读后 TAE 语义往返不一致。");
        if (reread.Animations.Count != document.Animations.Count)
            throw new InvalidDataException($"重读后动画数 {reread.Animations.Count} ≠ 写前 {document.Animations.Count}。");

        var insertCount = mutations.Count(m => m.Kind == "insert-event");
        var updateCount = mutations.Count(m => m.Kind == "update-event-times");
        var fieldUpdateCount = mutations.Count(m => m.Kind == "set-event-field");
        var expectedTotalEvents = document.TotalEventCount + insertCount;
        if (reread.TotalEventCount != expectedTotalEvents)
            throw new InvalidDataException($"重读后事件总数 {reread.TotalEventCount} ≠ 写前 {document.TotalEventCount} + {insertCount}。");

        // 6. 流式逐字节未触及区间证明 (SF-11 §2.6.4)
        plan.VerifyStreamingUntouched(reread.SourceBytes);

        // 7. 语义命中与兄弟事件零污染核对 (Sibling verify)
        VerifyMutationResults(mutations, appliedSummaries, layout, reread, source, templates, plan);

        // 4. 原子安全写入暂存区
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

        return new
        {
            mutationCount = mutations.Count,
            updateCount,
            insertCount,
            fieldUpdateCount,
            outputHash = reread.SourceHash,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            structurePreserved = true,
            byteSurgical = plan.Appends.Count == 0,
            mutations = appliedSummaries
        };
    }

    // ── 全局时间槽倒排索引 (SF-11 §2.6.2) ──

    private sealed record TimeSlotUser(long AnimId, int EventIndex, bool IsStart);

    private static Dictionary<int, List<TimeSlotUser>> BuildGlobalTimeSlotMap(TaeLayout layout)
    {
        var map = new Dictionary<int, List<TimeSlotUser>>();
        foreach (var anim in layout.Animations.Values)
        {
            foreach (var ev in anim.Events)
            {
                if (!map.TryGetValue(ev.StartTimeAbs, out var startUsers))
                {
                    startUsers = new List<TimeSlotUser>();
                    map[ev.StartTimeAbs] = startUsers;
                }
                startUsers.Add(new TimeSlotUser(anim.AnimId, ev.Index, true));

                if (!map.TryGetValue(ev.EndTimeAbs, out var endUsers))
                {
                    endUsers = new List<TimeSlotUser>();
                    map[ev.EndTimeAbs] = endUsers;
                }
                endUsers.Add(new TimeSlotUser(anim.AnimId, ev.Index, false));
            }
        }
        return map;
    }

    private static void ValidateMutations(
        List<TaeMutation> mutations,
        TaeLayout layout,
        byte[] source, Dictionary<TaeMutation, TemplateSpec> templates)
    {
        foreach (var mutation in mutations)
        {
            var anim = layout.FindAnim(mutation.AnimId)
                ?? throw new InvalidDataException($"TAE 动画 animId={mutation.AnimId} 不存在。");

            if (mutation.Kind == "update-event-times")
            {
                ValidateTimes(mutation.StartTime!.Value, mutation.EndTime!.Value);
                _ = ResolveEvent(anim, mutation.EventIndex!.Value);
            }
            else if (mutation.Kind == "insert-event")
            {
                ValidateTimes(mutation.StartTime!.Value, mutation.EndTime!.Value);
                var templateSpec = templates[mutation];
                var template = templateSpec.Event;

                // 事件参数体连续性检查
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
                            "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE",
                            new { mutation = mutation.Kind, reason = "event-param-layout-not-contiguous" });
                    }
                }
                var last = anim.Events.LastOrDefault();
                if (last is not null && last.ParamDataAbs != 0
                    && (last.ParamDataAbs < last.EventDataAbs + EventDataHeaderSize || last.ParamDataAbs > anim.EventGroupTableAbs))
                {
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 事件 {last.Index} 的参数体偏移 {last.ParamDataAbs} 越出"
                        + $"[eventData+16={last.EventDataAbs + EventDataHeaderSize}, eventGroupTable={anim.EventGroupTableAbs})，"
                        + "无法无损判定末尾事件参数体长度，拒绝插入新事件。",
                        "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE",
                        new { mutation = mutation.Kind, reason = "last-event-param-layout-unknown" });
                }

                var templateSpan = templateSpec.Parameters.Length;
                if (templateSpan < 0)
                {
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 模板事件 {template.Index} 参数体长度为负，布局不可信，拒绝插入。",
                        "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE",
                        new { mutation = mutation.Kind, reason = "negative-param-span" });
                }

                if (mutation.EventTypeId is { } reqType && reqType != template.EventTypeId)
                {
                    throw new InvalidDataException(
                        $"insert-event 的 eventTypeId {reqType} 与模板事件 {template.Index} 的类型 {template.EventTypeId} 不一致"
                        + "（参数体按模板逐字节拷贝，类型必须一致才有意义）。");
                }
            }
            else if (mutation.Kind == "set-event-field")
            {
                _ = ResolveFieldWrite(mutation, layout, anim, source);
            }
        }
    }

    private sealed record TemplateSpec(byte[] Source, TaeLayout.EventInfo Event, byte[] Parameters);

    private static Dictionary<TaeMutation, TemplateSpec> ResolveInsertionTemplates(
        List<TaeMutation> mutations, TaeLayout layout, byte[] source)
    {
        var result = new Dictionary<TaeMutation, TemplateSpec>();
        var documents = new Dictionary<string, (byte[] Source, TaeLayout Layout, string Encoded)>();
        foreach (var mutation in mutations.Where(m => m.Kind == "insert-event"))
        {
            var templateSource = source; var templateLayout = layout;
            if (mutation.TemplateDocumentBase64 is { } encoded)
            {
                if (encoded.Length > (MaxSourceBytes + 2) / 3 * 4)
                    throw new TaeWriteBlockedException("TAE 模板超过安全大小。", "TAE_TEMPLATE_INVALID");
                var hash = mutation.ExpectedTemplateDocumentHash
                    ?? throw new TaeWriteBlockedException("外部 TAE 模板需要内容哈希。", "TAE_TEMPLATE_HASH_REQUIRED");
                if (!documents.TryGetValue(hash, out var cached) || cached.Encoded != encoded)
                {
                    byte[] bytes;
                    try { bytes = Convert.FromBase64String(encoded); }
                    catch (FormatException) { throw new TaeWriteBlockedException("TAE 模板编码无效。", "TAE_TEMPLATE_INVALID"); }
                    var doc = TaeNativeDocument.Read(bytes);
                    if (!doc.SourceHash.Equals(hash, StringComparison.OrdinalIgnoreCase))
                        throw new TaeWriteBlockedException("TAE 模板内容哈希不匹配。", "TAE_TEMPLATE_HASH_MISMATCH");
                    cached = (bytes, TaeLayout.Read(bytes), encoded); documents[hash] = cached;
                }
                templateSource = cached.Source; templateLayout = cached.Layout;
            }
            if (templateLayout.SchemaBankId != layout.SchemaBankId)
                throw new TaeWriteBlockedException("模板和目标 TAE schema bank 不一致。", "TAE_TEMPLATE_BANK_MISMATCH");
            var anim = templateLayout.FindAnim(mutation.TemplateAnimId ?? mutation.AnimId)
                ?? throw new TaeWriteBlockedException("TAE 模板动作不存在。", "TAE_TEMPLATE_NOT_FOUND");
            var ev = ResolveEvent(anim, mutation.TemplateEventIndex!.Value);
            var length = GetParameterSpan(anim, ev, templateSource.Length);
            var parameters = length > 0 ? templateSource.AsSpan(ev.ParamDataAbs, length).ToArray() : Array.Empty<byte>();
            if (mutation.FieldOverrides is { } fields)
            {
                if (fields.ValueKind != JsonValueKind.Array)
                    throw new TaeWriteBlockedException("fieldOverrides 必须是字段数组。", "TAE_TEMPLATE_FIELDS_INVALID");
                foreach (var field in fields.EnumerateArray())
                {
                    if (!field.TryGetProperty("value", out var value))
                        throw new TaeWriteBlockedException("模板字段覆盖缺少 value。", "TAE_TEMPLATE_FIELDS_INVALID");
                    var edit = new TaeMutation("set-event-field", anim.AnimId, ev.Index, null, null, null, null,
                        OptionalInt32(field, "fieldIndex"), OptionalString(field, "fieldName"), value.Clone(), mutation.SchemaBankId);
                    var write = ResolveFieldWrite(edit, templateLayout, anim, templateSource);
                    write.Bytes.CopyTo(parameters, write.Field.Offset);
                }
            }
            result.Add(mutation, new TemplateSpec(templateSource, ev, parameters));
        }
        return result;
    }

    private static int GetTemplateSpan(TaeLayout.AnimInfo anim, TaeLayout.EventInfo template)
    {
        if (template.ParamDataAbs == 0) return 0;
        return template.Index < anim.Events.Count - 1
            ? anim.Events[template.Index + 1].EventDataAbs - template.ParamDataAbs
            : anim.EventGroupTableAbs - template.ParamDataAbs;
    }

    private static int GetParameterSpan(TaeLayout.AnimInfo anim, TaeLayout.EventInfo ev, int sourceLength)
    {
        if (ev.ParamDataAbs == 0) return 0;
        if (ev.ParamDataAbs < ev.EventDataAbs + EventDataHeaderSize)
            throw new TaeWriteBlockedException(
                $"TAE 动画 {anim.AnimId} 事件 {ev.Index} 参数体偏移早于事件头结束。",
                "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE",
                new { mutation = "set-event-field", reason = "parameter-offset-before-header" });
        var end = ev.Index < anim.Events.Count - 1
            ? anim.Events[ev.Index + 1].EventDataAbs
            : anim.EventGroupTableAbs > 0 ? anim.EventGroupTableAbs : sourceLength;
        var length = end - ev.ParamDataAbs;
        if (length < 0 || ev.ParamDataAbs + length > sourceLength)
            throw new TaeWriteBlockedException(
                $"TAE 动画 {anim.AnimId} 事件 {ev.Index} 参数体边界无效。",
                "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE",
                new { mutation = "set-event-field", reason = "parameter-span-invalid", parameterOffset = ev.ParamDataAbs, length });
        return length;
    }

    private static FieldWriteSpec ResolveFieldWrite(
        TaeMutation mutation,
        TaeLayout layout,
        TaeLayout.AnimInfo anim,
        byte[] source)
    {
        var ev = ResolveEvent(anim, mutation.EventIndex
            ?? throw new InvalidDataException("set-event-field 需要 eventIndex。"));
        var parameterLength = GetParameterSpan(anim, ev, source.Length);
        if (parameterLength == 0 || ev.ParamDataAbs == 0)
        {
            throw new TaeWriteBlockedException(
                $"TAE 动画 {anim.AnimId} 事件 {ev.Index} 没有可写参数体。",
                "TAE_SCHEMA_EVENT_NO_PARAMETERS",
                new { mutation = mutation.Kind, eventTypeId = ev.EventTypeId, parameterLength });
        }

        var schemaBankId = mutation.SchemaBankId ?? layout.SchemaBankId;
        if (mutation.SchemaBankId.HasValue
            && layout.SchemaBankId.HasValue
            && mutation.SchemaBankId.Value != layout.SchemaBankId.Value)
        {
            throw new TaeWriteBlockedException(
                $"set-event-field 的 schemaBankId={mutation.SchemaBankId.Value} 与 TAE EventBank={layout.SchemaBankId.Value} 不一致。",
                "TAE_SCHEMA_BANK_MISMATCH",
                new { mutation = mutation.Kind, eventTypeId = ev.EventTypeId, requestedBankId = mutation.SchemaBankId, documentBankId = layout.SchemaBankId });
        }
        var resolution = TaeFirstPartySchema.Resolve(ev.EventTypeId, parameterLength, schemaBankId);
        if (resolution.Event is null)
        {
            var code = resolution.Candidates.Count == 0
                ? "TAE_SCHEMA_EVENT_UNKNOWN"
                : "TAE_SCHEMA_LENGTH_MISMATCH";
            throw new TaeWriteBlockedException(
                $"SoulForge 内置 TAE schema 无法覆盖 eventTypeId={ev.EventTypeId} length={parameterLength}。",
                code,
                new
                {
                    mutation = mutation.Kind,
                    eventTypeId = ev.EventTypeId,
                    parameterLength,
                    schema = TaeFirstPartySchema.Metadata(),
                    variants = resolution.Candidates.Select(item => new { item.BankId, item.BankName, item.ParamSize }).ToArray()
                });
        }
        if (resolution.Ambiguous)
        {
            throw new TaeWriteBlockedException(
                $"eventTypeId={ev.EventTypeId} 在当前参数长度下对应多个 first-party TAE bank，写入必须带 schemaBankId。",
                "TAE_SCHEMA_VARIANT_AMBIGUOUS",
                new
                {
                    mutation = mutation.Kind,
                    eventTypeId = ev.EventTypeId,
                    parameterLength,
                    documentBankId = layout.SchemaBankId,
                    variants = resolution.Candidates.Select(item => new { item.BankId, item.BankName, item.ParamSize }).ToArray()
                });
        }

        var decoded = TaeFirstPartySchema.Decode(
            ev.EventTypeId,
            source.AsSpan(ev.ParamDataAbs, parameterLength),
            schemaBankId);
        if (!decoded.Complete)
        {
            var code = decoded.AssertFailures.Count > 0
                ? "TAE_SCHEMA_ASSERT_FAILED"
                : "TAE_SCHEMA_COVERAGE_GAP";
            throw new TaeWriteBlockedException(
                $"TAE 事件 {ev.Index} 的 first-party schema 现有字节未通过完整校验。",
                code,
                new
                {
                    mutation = mutation.Kind,
                    eventTypeId = ev.EventTypeId,
                    parameterLength,
                    assertFailures = decoded.AssertFailures,
                    schema = TaeFirstPartySchema.Metadata()
                });
        }

        var schemaEvent = resolution.Event;
        var byIndex = mutation.FieldIndex is { } requestedIndex
            ? schemaEvent.Fields.FirstOrDefault(field => field.Index == requestedIndex)
            : null;
        var byName = !string.IsNullOrWhiteSpace(mutation.FieldName)
            ? schemaEvent.Fields.FirstOrDefault(field => string.Equals(field.Name, mutation.FieldName, StringComparison.Ordinal))
            : null;
        var field = byIndex ?? byName;
        if (field is null)
        {
            throw new TaeWriteBlockedException(
                $"TAE 事件 {ev.Index} 的字段选择器未命中 first-party schema。",
                "TAE_SCHEMA_FIELD_UNKNOWN",
                new { mutation = mutation.Kind, eventTypeId = ev.EventTypeId, fieldIndex = mutation.FieldIndex, fieldName = mutation.FieldName });
        }
        if (byIndex is not null && byName is not null && !ReferenceEquals(byIndex, byName))
        {
            throw new TaeWriteBlockedException(
                $"TAE 事件 {ev.Index} 的 fieldIndex 与 fieldName 指向不同字段。",
                "TAE_SCHEMA_FIELD_SELECTOR_CONFLICT",
                new { mutation = mutation.Kind, fieldIndex = mutation.FieldIndex, fieldName = mutation.FieldName });
        }
        if (TaeFirstPartySchema.IsPaddingField(field))
        {
            throw new TaeWriteBlockedException(
                $"TAE 事件 {ev.Index} 的字段 {field.Name} 是 assert/padding 字段，不允许作为语义字段写入。",
                "TAE_SCHEMA_PADDING_READONLY",
                new { mutation = mutation.Kind, eventTypeId = ev.EventTypeId, fieldIndex = field.Index, fieldName = field.Name, assert = field.Assert });
        }

        var bytes = TaeFirstPartySchema.EncodeValue(
            field,
            mutation.FieldValue ?? throw new InvalidDataException("set-event-field 需要 value。"));
        if (field.Offset < 0 || field.Offset + bytes.Length > parameterLength)
            throw new TaeWriteBlockedException(
                $"TAE 事件 {ev.Index} 的字段 {field.Name} 越过参数体边界。",
                "TAE_SCHEMA_FIELD_OUT_OF_RANGE",
                new { mutation = mutation.Kind, fieldIndex = field.Index, fieldName = field.Name, parameterLength });
        return new FieldWriteSpec(mutation, ev, schemaEvent, field, bytes, parameterLength);
    }

    private static string DescribeJsonValue(JsonElement? value) => value is null
        ? string.Empty
        : value.Value.ValueKind == JsonValueKind.String
            ? value.Value.GetString() ?? string.Empty
            : value.Value.ToString();

    // ── 分组构建写入计划 (SF-11 §2.6.3) ──

    private sealed record InsertSpec(
        TaeMutation Mutation,
        int NewEventIndex,
        int EventTypeId,
        int TemplateSpan,
        int StartTimeAbs,
        int EndTimeAbs,
        int ParamDataAbs,
        int EventDataAbs);

    private sealed record FieldWriteSpec(
        TaeMutation Mutation,
        TaeLayout.EventInfo Event,
        TaeSchemaEvent SchemaEvent,
        TaeSchemaField Field,
        byte[] Bytes,
        int ParameterLength);

    private sealed record RelocatedTimeTable(
        Dictionary<int, int> OffsetsByBits,
        (int Start, int End)[] ExistingEventTimes);

    private sealed record KnownRegion(int Offset, int Length, string Kind, long? AnimId = null)
    {
        public long End => (long)Offset + Length;
    }

    private static int AppendChecked(ByteRangeWritePlan plan, byte[] bytes, string owner, int alignment = 1)
    {
        var padding = (alignment - plan.CurrentAppendOffset % alignment) % alignment;
        var end = checked((long)plan.CurrentAppendOffset + padding + bytes.LongLength);
        if (end > MaxSourceBytes || end > int.MaxValue)
            throw new InvalidDataException("TAE 追加数据超出文件大小安全范围。");
        return plan.Append(bytes, owner, alignment);
    }

    private static bool SameTime(float left, float right) =>
        BitConverter.SingleToInt32Bits(left) == BitConverter.SingleToInt32Bits(right);

    private static TaeWriteBlockedException UnknownTimeLayout(string reason) => new(
        $"TAE 时间表不能无损重定位：{reason}。",
        "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE", new { reason });

    private static Dictionary<long, RelocatedTimeTable> BuildRelocatedTimeTables(
        List<TaeMutation> mutations, TaeLayout layout, ByteRangeWritePlan plan, byte[] source,
        Dictionary<int, List<TimeSlotUser>> timeSlotMap)
    {
        var updates = mutations.Where(m => m.Kind == "update-event-times")
            .GroupBy(m => (m.AnimId, EventIndex: m.EventIndex!.Value))
            .ToDictionary(g => g.Key, g => g.Last());
        var inserts = mutations.Where(m => m.Kind == "insert-event")
            .GroupBy(m => m.AnimId).ToDictionary(g => g.Key, g => g.ToList());

        // Cross-animation references are valid only when they refer to a known
        // declared float slot. An arbitrary in-bounds pointer is not authority
        // to treat opaque bytes as a timestamp. Merge aligned ranges once.
        var timeRanges = new List<(int Start, int End)>();
        foreach (var anim in layout.Animations.Values.Where(a => a.TimesCount > 0).OrderBy(a => a.TimesArrayAbs))
        {
            if (anim.TimesArrayAbs % 4 != 0) throw UnknownTimeLayout("unaligned-declared-time-table");
            var end = checked(anim.TimesArrayAbs + anim.TimesCount * 4);
            if (timeRanges.Count > 0 && anim.TimesArrayAbs <= timeRanges[^1].End)
                timeRanges[^1] = (timeRanges[^1].Start, Math.Max(timeRanges[^1].End, end));
            else timeRanges.Add((anim.TimesArrayAbs, end));
        }
        bool IsDeclaredSlot(int offset)
        {
            if (offset % 4 != 0) return false;
            int lo = 0, hi = timeRanges.Count - 1;
            while (lo <= hi)
            {
                var mid = lo + (hi - lo) / 2; var range = timeRanges[mid];
                if (offset < range.Start) hi = mid - 1;
                else if ((long)offset + 4 > range.End) lo = mid + 1;
                else return true;
            }
            return false;
        }
        bool SharedWithOtherEvent(int offset, long animId, int index) => timeSlotMap[offset]
            .Any(user => user.AnimId != animId || user.EventIndex != index);
        bool RequiresCopy(TaeMutation mutation)
        {
            var ev = layout.FindAnim(mutation.AnimId)!.Events[mutation.EventIndex!.Value];
            if (!IsDeclaredSlot(ev.StartTimeAbs) || !IsDeclaredSlot(ev.EndTimeAbs))
                throw UnknownTimeLayout("event-time-pointer-outside-declared-tables");
            return (ev.StartTimeAbs == ev.EndTimeAbs && !SameTime(mutation.StartTime!.Value, mutation.EndTime!.Value))
                || (SharedWithOtherEvent(ev.StartTimeAbs, mutation.AnimId, ev.Index)
                    && !SameTime(mutation.StartTime!.Value, BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(ev.StartTimeAbs, 4))))
                || (SharedWithOtherEvent(ev.EndTimeAbs, mutation.AnimId, ev.Index)
                    && !SameTime(mutation.EndTime!.Value, BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(ev.EndTimeAbs, 4))));
        }
        var copyIds = new HashSet<long>(inserts.Keys);
        foreach (var mutation in updates.Values)
            if (RequiresCopy(mutation)) copyIds.Add(mutation.AnimId);
        var result = new Dictionary<long, RelocatedTimeTable>();
        if (copyIds.Count == 0) return result;

        // Appending must not extend an event whose parameter extent has no
        // explicit group-table boundary. The external SDT reader uses the end
        // of the event header even when its parameter pointer is zero, and can
        // infer the final body's end from EOF; zero is NOT proof of no bytes.
        foreach (var anim in layout.Animations.Values)
            if (anim.Events.Count > 0 && anim.EventGroupTableAbs == 0)
                throw UnknownTimeLayout("unbounded-parameter-tail");
        var regions = BuildKnownTimeRelocationRegions(layout, source);
        var protectedRegions = regions.Where(r => r.Kind != "time-table" && r.Length > 0).OrderBy(r => r.Offset).ToArray();
        var maxEnds = new long[protectedRegions.Length];
        for (var i = 0; i < maxEnds.Length; i++) maxEnds[i] = Math.Max(i == 0 ? 0 : maxEnds[i - 1], protectedRegions[i].End);
        bool IsStructuralSlot(int offset)
        {
            int lo = 0, hi = maxEnds.Length;
            while (lo < hi)
            {
                var mid = lo + (hi - lo) / 2;
                if (maxEnds[mid] <= offset) lo = mid + 1; else hi = mid;
            }
            for (var index = lo; index < protectedRegions.Length && protectedRegions[index].Offset < (long)offset + 4; index++)
                if (protectedRegions[index].End > offset) return true;
            return false;
        }
        foreach (var animId in copyIds.OrderBy(id => id))
        {
            var anim = layout.FindAnim(animId)!;
            var emptyNameField = FindEmptyNameTimeAlias(anim, source);
            ValidateTimeRelocationOwnership(anim, regions, emptyNameField);
            var eventBits = new (int Start, int End)[anim.Events.Count];
            var uniqueBits = new HashSet<int>();
            void Add(int bits)
            {
                if (!float.IsFinite(BitConverter.Int32BitsToSingle(bits)))
                    throw UnknownTimeLayout("non-finite-preserved-time");
                uniqueBits.Add(bits);
            }
            foreach (var ev in anim.Events)
            {
                if (!IsDeclaredSlot(ev.StartTimeAbs) || !IsDeclaredSlot(ev.EndTimeAbs))
                    throw UnknownTimeLayout("event-time-pointer-outside-declared-tables");
                if (IsStructuralSlot(ev.StartTimeAbs) || IsStructuralSlot(ev.EndTimeAbs))
                    throw UnknownTimeLayout("time-slot-overlaps-known-structure");
                var hasUpdate = updates.TryGetValue((animId, ev.Index), out var update);
                var startBits = hasUpdate ? BitConverter.SingleToInt32Bits(update!.StartTime!.Value)
                    : BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(ev.StartTimeAbs, 4));
                var endBits = hasUpdate ? BitConverter.SingleToInt32Bits(update!.EndTime!.Value)
                    : BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(ev.EndTimeAbs, 4));
                Add(startBits); Add(endBits); eventBits[ev.Index] = (startBits, endBits);
            }
            if (inserts.TryGetValue(animId, out var additions))
                foreach (var addition in additions)
                {
                    Add(BitConverter.SingleToInt32Bits(addition.StartTime!.Value));
                    Add(BitConverter.SingleToInt32Bits(addition.EndTime!.Value));
                }
            // Preserve exact float bits (including signed zero) of unchanged
            // events. Only the newly appended active table is canonicalized;
            // the old table and unused/opaque source bytes are never moved.
            var orderedBits = uniqueBits.OrderBy(BitConverter.Int32BitsToSingle).ThenBy(bits => bits).ToArray();
            if (orderedBits.Length > 2_000_000) throw UnknownTimeLayout("time-count-limit");
            var bytes = new byte[checked(orderedBits.Length * 4)];
            for (var i = 0; i < orderedBits.Length; i++)
                BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(i * 4, 4), orderedBits[i]);
            var tableAbs = AppendChecked(plan, bytes, $"anim:{animId}:complete_time_table", alignment: 4);
            var offsets = orderedBits.Select((bits, index) => (bits, offset: checked(tableAbs + index * 4)))
                .ToDictionary(pair => pair.bits, pair => pair.offset);
            var eventTimes = eventBits.Select(pair => (Start: offsets[pair.Start], End: offsets[pair.End])).ToArray();
            plan.AddOrUpdateInterval(anim.AnimEntryAbs + 0x10, BitConverter.GetBytes((long)tableAbs), $"anim:{animId}:times:offset", "relocate-times");
            // SDT count is int32 followed by a reserved int32; do not rewrite
            // unrelated padding as if it were part of an int64 count.
            plan.AddOrUpdateInterval(anim.AnimEntryAbs + 0x28, BitConverter.GetBytes(orderedBits.Length), $"anim:{animId}:times:count", "count-times");
            if (emptyNameField is { } nameField)
            {
                // A SDT empty filename can alias the old timesOffset. Moving
                // that table must not turn the old floats into a filename.
                // Give this private, proven name field a real UTF-16 empty
                // string. Eight bytes also preserve the external reader's
                // bounded int64 lookahead; no miniheader/opaque block is moved.
                var emptyNameAbs = AppendChecked(plan, new byte[8], $"anim:{animId}:empty-animation-name", alignment: 2);
                plan.AddOrUpdateInterval(nameField, BitConverter.GetBytes((long)emptyNameAbs),
                    $"anim:{animId}:empty-name-pointer", "detach-empty-name-from-time-table");
            }
            if (!inserts.ContainsKey(animId))
                foreach (var ev in anim.Events)
                {
                    var at = checked(anim.EventTableAbs + ev.Index * EventTableEntrySize);
                    plan.AddOrUpdateInterval(at, BitConverter.GetBytes((long)eventTimes[ev.Index].Start), $"anim:{animId}:event:{ev.Index}:start-pointer", "relocate-time-pointer");
                    plan.AddOrUpdateInterval(at + 8, BitConverter.GetBytes((long)eventTimes[ev.Index].End), $"anim:{animId}:event:{ev.Index}:end-pointer", "relocate-time-pointer");
                }
            result.Add(animId, new RelocatedTimeTable(offsets, eventTimes));
        }
        return result;
    }

    private static int? FindEmptyNameTimeAlias(TaeLayout.AnimInfo anim, byte[] source)
    {
        if (anim.AnimFileInfoAbs == 0) return null;
        var info = anim.AnimFileInfoAbs;
        if (info > source.Length - 16) throw UnknownTimeLayout("miniheader-out-of-bounds");
        var field = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(info + 8, 8));
        if (field == 0) return null; // Known null miniheader.
        if (field != (long)info + 16 || info > source.Length - 24)
            throw UnknownTimeLayout("unknown-miniheader-name-field");
        var nameOffset = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(info + 16, 8));
        if (nameOffset != anim.TimesArrayAbs) return null;
        var type = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(info, 8));
        if (type is not (0 or 1)) throw UnknownTimeLayout("unknown-miniheader-type");
        return info + 16;
    }

    private static List<KnownRegion> BuildKnownTimeRelocationRegions(TaeLayout layout, byte[] source)
    {
        var regions = new List<KnownRegion>
        {
            new(0, FileHeaderSize, "file-header"),
            new(layout.Section1Abs, Section1HeaderSize, "section-header"),
            new(layout.AnimTableAbs, checked(layout.Animations.Count * AnimTableEntrySize), "animation-table")
        };
        foreach (var anim in layout.Animations.Values)
        {
            regions.Add(new(anim.AnimEntryAbs, AnimationEntrySize, "animation-entry", anim.AnimId));
            regions.Add(new(anim.EventTableAbs, checked(anim.EventCount * EventTableEntrySize), "event-table", anim.AnimId));
            regions.Add(new(anim.TimesArrayAbs, checked(anim.TimesCount * 4), "time-table", anim.AnimId));
            regions.Add(new(anim.EventGroupTableAbs, checked(anim.EventGroupCount * EventGroupEntrySize), "group-table", anim.AnimId));
            if (anim.AnimFileInfoAbs > 0)
            {
                if (anim.AnimFileInfoAbs > source.Length - 16) throw UnknownTimeLayout("miniheader-out-of-bounds");
                var nameField = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(anim.AnimFileInfoAbs + 8, 8));
                var size = nameField == (long)anim.AnimFileInfoAbs + 16 ? 24 : 16;
                if (anim.AnimFileInfoAbs > source.Length - size) throw UnknownTimeLayout("miniheader-out-of-bounds");
                regions.Add(new(anim.AnimFileInfoAbs, size, "miniheader", anim.AnimId));
            }
            foreach (var ev in anim.Events)
            {
                var end = ev.ParamDataAbs == 0 ? ev.EventDataAbs + EventDataHeaderSize
                    : checked(ev.ParamDataAbs + GetParameterSpan(anim, ev, source.Length));
                regions.Add(new(ev.EventDataAbs, checked(end - ev.EventDataAbs), "event-data", anim.AnimId));
            }
            for (var index = 0; index < anim.EventGroupCount; index++)
            {
                var at = checked(anim.EventGroupTableAbs + index * EventGroupEntrySize);
                var count = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(at, 8));
                var offset = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(at + 8, 8));
                var type = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(at + 16, 8));
                if (count > 0) regions.Add(new(checked((int)offset), checked((int)count * 4), "group-members", anim.AnimId));
                if (type > 0) regions.Add(new(checked((int)type), 16, "group-type", anim.AnimId));
            }
        }
        return regions;
    }

    private static void ValidateTimeRelocationOwnership(TaeLayout.AnimInfo anim, List<KnownRegion> regions, int? emptyNameField)
    {
        List<KnownRegion> writes = [
            new(anim.AnimEntryAbs, AnimationEntrySize, "animation-entry", anim.AnimId),
            new(anim.EventTableAbs, checked(anim.EventCount * EventTableEntrySize), "event-table", anim.AnimId)
        ];
        if (emptyNameField is { } nameField) writes.Add(new(nameField, 8, "miniheader", anim.AnimId));
        foreach (var write in writes)
            foreach (var region in regions)
            {
                if (region.Length == 0 || write.Length == 0 || (region.AnimId == anim.AnimId && region.Kind == write.Kind)) continue;
                if (write.Offset < region.End && region.Offset < write.End)
                    throw UnknownTimeLayout($"overlapping-{write.Kind}-and-{region.Kind}");
            }
    }

    private static List<object> BuildAndApplyPlan(
        List<TaeMutation> mutations,
        TaeLayout layout,
        ByteRangeWritePlan plan,
        byte[] source, Dictionary<TaeMutation, TemplateSpec> templates,
        Dictionary<int, List<TimeSlotUser>> timeSlotMap)
    {
        var summaries = new List<object>(mutations.Count);
        var relocatedTimes = BuildRelocatedTimeTables(mutations, layout, plan, source, timeSlotMap);

        // 1. 处理所有 update-event-times
        foreach (var m in mutations.Where(m => m.Kind == "update-event-times"))
        {
            var anim = layout.FindAnim(m.AnimId)!;
            var ev = ResolveEvent(anim, m.EventIndex!.Value);

            if (!relocatedTimes.ContainsKey(m.AnimId))
            {
                var startBytes = BitConverter.GetBytes(m.StartTime!.Value);
                plan.AddOrUpdateInterval(ev.StartTimeAbs, startBytes, $"anim:{m.AnimId}:event:{ev.Index}:start", $"set-start:{m.StartTime}");
                if (ev.EndTimeAbs != ev.StartTimeAbs)
                {
                    var endBytes = BitConverter.GetBytes(m.EndTime!.Value);
                    plan.AddOrUpdateInterval(ev.EndTimeAbs, endBytes, $"anim:{m.AnimId}:event:{ev.Index}:end", $"set-end:{m.EndTime}");
                }
            }

            summaries.Add(new
            {
                mutation = m.Kind,
                animId = m.AnimId,
                eventIndex = m.EventIndex,
                startTime = m.StartTime,
                endTime = m.EndTime,
                byteSurgical = !relocatedTimes.ContainsKey(m.AnimId)
            });
        }

        // 2. 处理已由 first-party schema 精确解析的字段写入。
        foreach (var m in mutations.Where(m => m.Kind == "set-event-field"))
        {
            var anim = layout.FindAnim(m.AnimId)!;
            var spec = ResolveFieldWrite(m, layout, anim, source);
            plan.AddOrUpdateInterval(
                checked(spec.Event.ParamDataAbs + spec.Field.Offset),
                spec.Bytes,
                $"anim:{m.AnimId}:event:{spec.Event.Index}:field:{spec.Field.Index}",
                $"set-field:{spec.Field.Name}");
            summaries.Add(new
            {
                mutation = m.Kind,
                animId = m.AnimId,
                eventIndex = m.EventIndex,
                fieldIndex = spec.Field.Index,
                fieldName = spec.Field.Name,
                fieldType = spec.Field.Type,
                value = DescribeJsonValue(m.FieldValue),
                parameterLength = spec.ParameterLength,
                byteOffset = spec.Event.ParamDataAbs + spec.Field.Offset,
                byteLength = spec.Bytes.Length,
                byteSurgical = true
            });
        }

        // 3. 按动画分组处理所有 insert-event (避免逐事件复制表产生 O(mB) 重建成本)
        var insertsByAnim = mutations
            .Where(m => m.Kind == "insert-event")
            .GroupBy(m => m.AnimId)
            .ToDictionary(g => g.Key, g => g.ToList());

        foreach (var (animId, animInserts) in insertsByAnim)
        {
            var anim = layout.FindAnim(animId)!;
            var insertSpecs = new List<InsertSpec>(animInserts.Count);
            var currentEventCount = anim.EventCount;

            // All new and retained events reference the one complete table
            // already appended for this animation (not orphaned float slots).
            var timeTable = relocatedTimes[animId];
            var newTimes = animInserts.Select(m => (Mutation: m,
                Start: timeTable.OffsetsByBits[BitConverter.SingleToInt32Bits(m.StartTime!.Value)],
                End: timeTable.OffsetsByBits[BitConverter.SingleToInt32Bits(m.EndTime!.Value)])).ToArray();
            var relocatedHeaders = new List<int>();
            foreach (var ev in anim.Events)
            {
                var span = GetParameterSpan(anim, ev, source.Length);
                var prefix = ev.ParamDataAbs == 0 ? EventDataHeaderSize : ev.ParamDataAbs - ev.EventDataAbs;
                var copy = source.AsSpan(ev.EventDataAbs, checked(prefix + span)).ToArray();
                // Existing field writes must survive relocation as well as the
                // retained old region referenced by the immutable baseline.
                foreach (var interval in plan.Intervals.Values)
                    if (interval.Offset >= ev.EventDataAbs && interval.Offset + interval.Length <= ev.EventDataAbs + copy.Length)
                        interval.NewBytes.CopyTo(copy, interval.Offset - ev.EventDataAbs);
                var headerAbs = plan.CurrentAppendOffset;
                BinaryPrimitives.WriteInt64LittleEndian(copy.AsSpan(8, 8), ev.ParamDataAbs == 0 ? 0 : headerAbs + prefix);
                relocatedHeaders.Add(AppendChecked(plan, copy, $"anim:{animId}:old_event_{ev.Index}:data"));
            }
            foreach (var (insertMutation, startTimeAbs, endTimeAbs) in newTimes)
            {
                var templateSpec = templates[insertMutation];
                var template = templateSpec.Event;
                var templateSpan = templateSpec.Parameters.Length;
                var eventTypeId = insertMutation.EventTypeId ?? template.EventTypeId;
                var data = new byte[EventDataHeaderSize + templateSpan];
                templateSpec.Source.AsSpan(template.EventDataAbs, EventDataHeaderSize).CopyTo(data);
                BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(0, 4), eventTypeId);
                var eventDataAbs = plan.CurrentAppendOffset;
                var paramDataAbs = templateSpan > 0 ? eventDataAbs + EventDataHeaderSize : 0;
                BinaryPrimitives.WriteInt64LittleEndian(data.AsSpan(8, 8), paramDataAbs);
                if (templateSpan > 0) templateSpec.Parameters.CopyTo(data, EventDataHeaderSize);
                AppendChecked(plan, data, $"anim:{animId}:new_event_{currentEventCount}:data");
                insertSpecs.Add(new InsertSpec(insertMutation, currentEventCount++, eventTypeId, templateSpan,
                    startTimeAbs, endTimeAbs, paramDataAbs, eventDataAbs));
            }

            var groupTableAbs = plan.CurrentAppendOffset;
            var groupTable = source.AsSpan(anim.EventGroupTableAbs, checked(anim.EventGroupCount * EventGroupEntrySize)).ToArray();
            var arrays = new List<byte[]>();
            var cursor = checked(groupTableAbs + groupTable.Length);
            for (var g = 0; g < anim.EventGroupCount; g++)
            {
                var count = BinaryPrimitives.ReadInt64LittleEndian(groupTable.AsSpan(g * EventGroupEntrySize, 8));
                var offset = BinaryPrimitives.ReadInt64LittleEndian(groupTable.AsSpan(g * EventGroupEntrySize + 8, 8));
                if (count < 0 || count > anim.EventCount || offset < 0 || offset > source.Length - count * 4)
                    throw new TaeWriteBlockedException("TAE 事件组引用数组越界。", "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE");
                var array = source.AsSpan(checked((int)offset), checked((int)count * 4)).ToArray();
                for (var i = 0; i < count; i++)
                {
                    var oldOffset = BinaryPrimitives.ReadInt32LittleEndian(array.AsSpan(i * 4, 4));
                    if (oldOffset < anim.EventTableAbs || (oldOffset - anim.EventTableAbs) % EventTableEntrySize != 0
                        || (oldOffset - anim.EventTableAbs) / EventTableEntrySize >= anim.EventCount)
                        throw new TaeWriteBlockedException("TAE 事件组不是已知的事件表引用布局。", "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE");
                }
                BinaryPrimitives.WriteInt64LittleEndian(groupTable.AsSpan(g * EventGroupEntrySize + 8, 8), cursor);
                arrays.Add(array); cursor = checked(cursor + array.Length);
            }
            var newTableAbs = checked((cursor + 7) & ~7);
            foreach (var array in arrays)
                for (var i = 0; i < array.Length / 4; i++)
                {
                    var oldOffset = BinaryPrimitives.ReadInt32LittleEndian(array.AsSpan(i * 4, 4));
                    BinaryPrimitives.WriteInt32LittleEndian(array.AsSpan(i * 4, 4), newTableAbs + oldOffset - anim.EventTableAbs);
                }
            AppendChecked(plan, groupTable, $"anim:{animId}:groups");
            foreach (var array in arrays) AppendChecked(plan, array, $"anim:{animId}:group_event_refs");

            var oldTableSize = checked(anim.EventCount * EventTableEntrySize);
            var finalTable = new byte[checked(currentEventCount * EventTableEntrySize)];
            Buffer.BlockCopy(source, anim.EventTableAbs, finalTable, 0, oldTableSize);
            for (var i = 0; i < relocatedHeaders.Count; i++)
            {
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(i * EventTableEntrySize, 8), timeTable.ExistingEventTimes[i].Start);
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(i * EventTableEntrySize + 8, 8), timeTable.ExistingEventTimes[i].End);
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(i * EventTableEntrySize + 16, 8), relocatedHeaders[i]);
            }
            for (var k = 0; k < insertSpecs.Count; k++)
            {
                var spec = insertSpecs[k]; var entryOffset = oldTableSize + k * EventTableEntrySize;
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(entryOffset, 8), spec.StartTimeAbs);
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(entryOffset + 8, 8), spec.EndTimeAbs);
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(entryOffset + 16, 8), spec.EventDataAbs);
            }
            if (AppendChecked(plan, finalTable, $"anim:{animId}:final_event_table", alignment: 8) != newTableAbs)
                throw new InvalidDataException("TAE 插入计划偏移不一致。");
            plan.AddOrUpdateInterval(anim.AnimEntryAbs, BitConverter.GetBytes((long)newTableAbs), $"anim:{animId}:entry:table_offset", $"table:{newTableAbs}");
            plan.AddOrUpdateInterval(anim.AnimEntryAbs + 8, BitConverter.GetBytes((long)groupTableAbs), $"anim:{animId}:entry:group_offset", $"groups:{groupTableAbs}");
            plan.AddOrUpdateInterval(anim.AnimEntryAbs + 0x20, BitConverter.GetBytes(currentEventCount), $"anim:{animId}:entry:event_count", $"count:{currentEventCount}");

            foreach (var spec in insertSpecs)
            {
                summaries.Add(new
                {
                    mutation = spec.Mutation.Kind,
                    animId,
                    templateEventIndex = spec.Mutation.TemplateEventIndex,
                    newEventIndex = spec.NewEventIndex,
                    eventTypeId = spec.EventTypeId,
                    startTime = spec.Mutation.StartTime,
                    endTime = spec.Mutation.EndTime,
                    paramBytesCopied = spec.TemplateSpan,
                    eventTableRelocated = true,
                    newEventTableRelOffset = newTableAbs
                });
            }
        }

        // 4. 时间表 COW 与事件插入均需同步文件头声明大小。
        if (plan.Appends.Count > 0)
        {
            var finalSize = plan.CurrentAppendOffset;
            plan.AddOrUpdateInterval(0x0C, BitConverter.GetBytes(finalSize), "header:declared_size", $"declared_size:{finalSize}");
        }

        return summaries;
    }

    private static void VerifyMutationResults(
        List<TaeMutation> mutations,
        List<object> summaries,
        TaeLayout layout,
        TaeNativeDocument reread,
        byte[] source, Dictionary<TaeMutation, TemplateSpec> templates, ByteRangeWritePlan plan)
    {
        var rereadAnims = reread.Animations.ToDictionary(a => a.AnimId);

        // 1. 验证 update 命中与兄弟事件零污染 (SF-11 §2.6.4: 重复更新同一事件只对比最终时间)
        var finalUpdates = mutations
            .Where(m => m.Kind == "update-event-times")
            .GroupBy(m => (m.AnimId, m.EventIndex!.Value))
            .Select(g => g.Last())
            .ToList();

        var updatedEventsSet = finalUpdates.Select(m => (m.AnimId, m.EventIndex!.Value)).ToHashSet();

        foreach (var m in finalUpdates)
        {
            var animReread = rereadAnims[m.AnimId];
            var evReread = animReread.Events[m.EventIndex!.Value];

            if (!SameTime(evReread.StartTime, m.StartTime!.Value) || !SameTime(evReread.EndTime, m.EndTime!.Value))
            {
                throw new InvalidDataException($"重读后事件 {m.EventIndex} 时间 {evReread.StartTime}/{evReread.EndTime} ≠ 写入 {m.StartTime}/{m.EndTime}。");
            }
        }

        // Sibling verify：同动画其它未修改事件时间必须完全保持
        foreach (var animOrig in layout.Animations.Values)
        {
            if (!rereadAnims.TryGetValue(animOrig.AnimId, out var animReread)) continue;
            for (var i = 0; i < animOrig.Events.Count; i++)
            {
                if (updatedEventsSet.Contains((animOrig.AnimId, i))) continue;

                var origEv = animOrig.Events[i];
                var rereadOtherEv = animReread.Events[i];
                var origStart = BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(origEv.StartTimeAbs, 4));
                var origEnd = BinaryPrimitives.ReadSingleLittleEndian(source.AsSpan(origEv.EndTimeAbs, 4));

                if (!SameTime(rereadOtherEv.StartTime, origStart) || !SameTime(rereadOtherEv.EndTime, origEnd))
                {
                    throw new InvalidDataException($"兄弟事件 {i} 时间发生非预期变更: 原 {origStart}/{origEnd}，重读 {rereadOtherEv.StartTime}/{rereadOtherEv.EndTime}。");
                }
            }
        }

        // Append-only relocation must preserve every original event header's
        // type/padding and exact native parameter extent/body, including tails.
        // First-party field writes are the only permitted body exceptions.
        if (plan.Appends.Count > 0)
        {
            var writes = plan.GetSortedMergedIntervals();
            foreach (var anim in layout.Animations.Values)
                foreach (var ev in anim.Events)
                {
                    var after = rereadAnims[anim.AnimId].Events[ev.Index];
                    if (!source.AsSpan(ev.EventDataAbs, 8).SequenceEqual(reread.SourceBytes.AsSpan(checked((int)after.EventDataOffset), 8)))
                        throw new InvalidDataException("TAE 原事件类型或未知头部字节发生改变。");
                    var length = GetParameterSpan(anim, ev, source.Length);
                    if (reread.GetParameterLength(rereadAnims[anim.AnimId], ev.Index) != length)
                        throw new InvalidDataException("TAE 原事件参数体长度发生改变。");
                    if (ev.ParamDataAbs == 0)
                    {
                        if (after.ParameterDataOffset != 0) throw new InvalidDataException("TAE 原空参数指针发生改变。");
                        continue;
                    }
                    var prefix = ev.ParamDataAbs - ev.EventDataAbs - EventDataHeaderSize;
                    if (after.ParameterDataOffset - after.EventDataOffset - EventDataHeaderSize != prefix
                        || !source.AsSpan(ev.EventDataAbs + EventDataHeaderSize, prefix).SequenceEqual(
                            reread.SourceBytes.AsSpan(checked((int)after.EventDataOffset + EventDataHeaderSize), prefix)))
                        throw new InvalidDataException("TAE 原事件参数前的未知字节发生改变。");
                    var actual = reread.SourceBytes.AsSpan(checked((int)after.ParameterDataOffset), length);
                    var cursor = 0;
                    foreach (var write in writes.Where(w => w.Offset >= ev.ParamDataAbs && (long)w.Offset + w.Length <= (long)ev.ParamDataAbs + length))
                    {
                        var relative = write.Offset - ev.ParamDataAbs;
                        if (!source.AsSpan(ev.ParamDataAbs + cursor, relative - cursor).SequenceEqual(actual.Slice(cursor, relative - cursor))
                            || !write.NewBytes.AsSpan().SequenceEqual(actual.Slice(relative, write.Length)))
                            throw new InvalidDataException("TAE 原事件参数体未按声明字段写入保留。");
                        cursor = relative + write.Length;
                    }
                    if (!source.AsSpan(ev.ParamDataAbs + cursor, length - cursor).SequenceEqual(actual[cursor..]))
                        throw new InvalidDataException("TAE 原事件参数尾部发生改变。");
                }
        }

        // Exact appended indices, rather than time matching an existing event.
        foreach (var group in mutations.Where(m => m.Kind == "insert-event").GroupBy(m => m.AnimId))
        {
            var nextIndex = layout.FindAnim(group.Key)!.EventCount;
            var animReread = rereadAnims[group.Key];
            foreach (var m in group)
            {
                var spec = templates[m];
                var newEv = animReread.Events[nextIndex++];
                if (newEv.EventTypeId != spec.Event.EventTypeId
                    || !SameTime(newEv.StartTime, m.StartTime!.Value)
                    || !SameTime(newEv.EndTime, m.EndTime!.Value))
                    throw new InvalidDataException("新增 TAE 事件的类型或时间不符合请求。");
                if (reread.GetParameterLength(animReread, nextIndex - 1) != spec.Parameters.Length
                    || (spec.Parameters.Length > 0 && !reread.SourceBytes.AsSpan(
                        checked((int)newEv.ParameterDataOffset), spec.Parameters.Length).SequenceEqual(spec.Parameters)))
                    throw new InvalidDataException("新增 TAE 事件参数与模板及字段覆盖不一致。");
            }
        }

        // 3. 验证 first-party schema 字段写入命中正确的原生参数区间。
        if (mutations.Any(m => m.Kind == "set-event-field"))
        {
            var rereadLayout = TaeLayout.Read(reread.SourceBytes);
            foreach (var m in mutations.Where(m => m.Kind == "set-event-field"))
            {
                var anim = rereadLayout.FindAnim(m.AnimId)
                    ?? throw new InvalidDataException($"重读后找不到 TAE 动画 {m.AnimId}。" );
                var spec = ResolveFieldWrite(m, rereadLayout, anim, reread.SourceBytes);
                var offset = checked(spec.Event.ParamDataAbs + spec.Field.Offset);
                if (!reread.SourceBytes.AsSpan(offset, spec.Bytes.Length).SequenceEqual(spec.Bytes))
                {
                    throw new InvalidDataException(
                        $"重读后 TAE 字段 {spec.Field.Name} 未保持写入值（animId={m.AnimId}, eventIndex={spec.Event.Index}）。");
                }
            }
        }
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
                return new TaeMutation(kind, animId, eventIndex, null, null, startTime, endTime, null, null, null, null);
            }
            case "insert-event":
            {
                var animId = RequiredInt64(item, "animId");
                var templateEventIndex = RequiredInt32(item, "templateEventIndex");
                var eventTypeId = OptionalInt32(item, "eventTypeId");
                var startTime = RequiredFloat(item, "startTime");
                var endTime = RequiredFloat(item, "endTime");
                return new TaeMutation(kind, animId, null, templateEventIndex, eventTypeId, startTime, endTime, null, null, null, OptionalInt32(item, "schemaBankId"))
                {
                    TemplateAnimId = item.TryGetProperty("templateAnimId", out _) ? RequiredInt64(item, "templateAnimId") : null,
                    TemplateDocumentBase64 = OptionalString(item, "templateDocumentBase64"),
                    ExpectedTemplateDocumentHash = OptionalString(item, "expectedTemplateDocumentHash"),
                    FieldOverrides = item.TryGetProperty("fieldOverrides", out var fields) ? fields.Clone() : null
                };
            }
            case "set-event-field":
            {
                var animId = RequiredInt64(item, "animId");
                var eventIndex = RequiredInt32(item, "eventIndex");
                var fieldIndex = OptionalInt32(item, "fieldIndex");
                var fieldName = OptionalString(item, "fieldName");
                if (!fieldIndex.HasValue && string.IsNullOrWhiteSpace(fieldName))
                    throw new InvalidDataException("set-event-field 需要 fieldIndex 或 fieldName。" );
                if (!item.TryGetProperty("value", out var fieldValue)
                    || fieldValue.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                    throw new InvalidDataException("set-event-field 需要 value。" );
                var schemaBankId = OptionalInt32(item, "schemaBankId");
                return new TaeMutation(kind, animId, eventIndex, null, null, null, null, fieldIndex, fieldName, fieldValue.Clone(), schemaBankId);
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

    private static string? OptionalString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static float RequiredFloat(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetSingle(out var parsed)
            ? parsed : throw new InvalidDataException($"options.{field} 是必填浮点数。");

    private static void ValidateTimes(float startTime, float endTime)
    {
        if (!float.IsFinite(startTime) || !float.IsFinite(endTime) || startTime > endTime)
            throw new InvalidDataException($"无效时间区间：startTime={startTime} endTime={endTime}（必须有限且 start ≤ end）。");
    }

    private static TaeLayout.EventInfo ResolveEvent(TaeLayout.AnimInfo anim, int eventIndex)
    {
        if (eventIndex < 0 || eventIndex >= anim.Events.Count)
            throw new InvalidDataException($"TAE 动画 {anim.AnimId} 事件下标 {eventIndex} 越界（事件数 {anim.Events.Count}）。");
        return anim.Events[eventIndex];
    }

    private sealed record TaeMutation(
        string Kind,
        long AnimId,
        int? EventIndex,
        int? TemplateEventIndex,
        int? EventTypeId,
        float? StartTime,
        float? EndTime,
        int? FieldIndex,
        string? FieldName,
        JsonElement? FieldValue,
        int? SchemaBankId)
    {
        public long? TemplateAnimId { get; init; }
        public string? TemplateDocumentBase64 { get; init; }
        public string? ExpectedTemplateDocumentHash { get; init; }
        public JsonElement? FieldOverrides { get; init; }
    }

    private sealed class TaeLayout
    {
        public Dictionary<long, AnimInfo> Animations { get; }
        public int? SchemaBankId { get; }
        public int Section1Abs { get; }
        public int AnimTableAbs { get; }

        private TaeLayout(Dictionary<long, AnimInfo> animations, int? schemaBankId, int section1Abs, int animTableAbs)
        {
            Animations = animations;
            SchemaBankId = schemaBankId;
            Section1Abs = section1Abs;
            AnimTableAbs = animTableAbs;
        }

        public AnimInfo? FindAnim(long animId) => Animations.TryGetValue(animId, out var anim) ? anim : null;

        public sealed class AnimInfo
        {
            public required long AnimId { get; init; }
            public required int AnimEntryAbs { get; init; }
            public required int EventTableAbs { get; init; }
            public required int EventGroupTableAbs { get; init; }
            public required int EventCount { get; init; }
            public required int EventGroupCount { get; init; }
            public required int TimesArrayAbs { get; init; }
            public required int TimesCount { get; init; }
            public required int AnimFileInfoAbs { get; init; }
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
            var eventBank = ReadInt64(source, 0x30);
            var schemaBankId = eventBank is 13 or 14 ? (int)eventBank : (int?)null;
            if (section1Offset < FileHeaderSize || section1Offset + Section1HeaderSize > source.Length)
                throw new InvalidDataException("TAE Section 1 头偏移越界。");
            var s1 = checked((int)section1Offset);
            var animTableEntryCount = ReadInt32(source, s1 + 0x04);
            var animTableOffset = ReadInt64(source, s1 + 0x08);
            if (animTableEntryCount < 0 || animTableEntryCount > 100_000)
                throw new InvalidDataException("TAE 动画表条目数越界。");
            var animTableDataOffset = animTableOffset;
            if (animTableOffset < 0 || animTableOffset > source.Length
                || (long)animTableEntryCount * AnimTableEntrySize > source.Length - animTableOffset)
                throw new InvalidDataException("TAE 动画表越界。");

            var animations = new Dictionary<long, AnimInfo>(animTableEntryCount);
            for (var i = 0; i < animTableEntryCount; i++)
            {
                var te = checked((int)(animTableDataOffset + (long)i * AnimTableEntrySize));
                var animId = ReadInt64(source, te);
                var animEntryOffset = ReadInt64(source, te + 8);
                if (animEntryOffset < 0 || animEntryOffset > source.Length - AnimationEntrySize)
                    throw new InvalidDataException($"TAE 动画 {animId} 条目偏移越界。");
                var ae = checked((int)animEntryOffset);
                var eventTableOffset = ReadInt64(source, ae);
                var eventGroupTableOffset = ReadInt64(source, ae + 0x08);
                var timesArrayOffset = ReadInt64(source, ae + 0x10);
                var animFileInfoOffset = ReadInt64(source, ae + 0x18);
                var eventCount = ReadInt32(source, ae + 0x20);
                var eventGroupCount = ReadInt32(source, ae + 0x24);
                var timesCount = ReadInt64(source, ae + 0x28);
                if (eventCount < 0 || eventCount > 1_000_000)
                    throw new InvalidDataException($"TAE 动画 {animId} 事件数越界。");
                if (eventGroupCount < 0 || eventGroupCount > 1_000_000)
                    throw new InvalidDataException($"TAE 动画 {animId} 事件组数越界。");
                if (timesCount < 0 || timesCount > 2_000_000 || timesArrayOffset < 0 || timesArrayOffset > source.Length
                    || timesCount * 4 > source.Length - timesArrayOffset)
                    throw new InvalidDataException($"TAE 动画 {animId} 时间数组越界。");
                if (animFileInfoOffset < 0 || animFileInfoOffset > source.Length)
                    throw UnknownTimeLayout("miniheader-out-of-bounds");
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

                var animation = new AnimInfo
                {
                    AnimId = animId,
                    AnimEntryAbs = ae,
                    EventTableAbs = checked((int)eventTableOffset),
                    EventGroupTableAbs = checked((int)eventGroupTableOffset),
                    EventCount = eventCount,
                    EventGroupCount = eventGroupCount,
                    TimesArrayAbs = checked((int)timesArrayOffset),
                    TimesCount = checked((int)timesCount),
                    AnimFileInfoAbs = checked((int)animFileInfoOffset),
                    Events = events
                };
                if (!animations.TryAdd(animId, animation))
                    throw UnknownTimeLayout("duplicate-animation-id");
            }
            return new TaeLayout(animations, schemaBankId, s1, checked((int)animTableOffset));
        }

        private static int ReadInt32(byte[] source, int offset) =>
            BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

        private static long ReadInt64(byte[] source, int offset) =>
            BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
    }
}

internal sealed class TaeWriteBlockedException : Exception
{
    public TaeWriteBlockedException(string message, string code = "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE", object? details = null) : base(message)
    {
        Code = code;
        Details = details;
    }

    public string Code { get; }
    public object? Details { get; }
}

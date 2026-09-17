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
/// 2. 全文跨动画共享时间槽检查：建立 timeSlotOffset → 使用者集合，跨动画/同动画共享槽拒绝并返回 TAE_SHARED_TIME_SLOT_WRITE_UNSUPPORTED；
/// 3. 单事件点事件 (start==end 共享槽) 强制一致性值写入，避免前后覆盖；
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

        // 1. 全量静态前置校验：跨动画共享时间槽与参数连续性检查 (SF-11 §2.6.2)
        ValidateMutations(mutations, layout, timeSlotMap, source);

        // 2. 构建区间写入计划 (SF-11 §2.6.3)
        var plan = new ByteRangeWritePlan(source);
        var appliedSummaries = BuildAndApplyPlan(mutations, layout, plan, source);

        // 3. 单次分配最终输出 (O(B+A))
        var rebuilt = plan.Apply();

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

        // 5. 重读验证：语义一致性 + 动画数 + 事件数
        var reread = TaeNativeDocument.ReadFile(outputPath);
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
        VerifyMutationResults(mutations, appliedSummaries, layout, reread, source);

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
            byteSurgical = insertCount == 0,
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
        Dictionary<int, List<TimeSlotUser>> timeSlotMap,
        byte[] source)
    {
        foreach (var mutation in mutations)
        {
            var anim = layout.FindAnim(mutation.AnimId)
                ?? throw new InvalidDataException($"TAE 动画 animId={mutation.AnimId} 不存在。");

            if (mutation.Kind == "update-event-times")
            {
                ValidateTimes(mutation.StartTime!.Value, mutation.EndTime!.Value);
                var ev = ResolveEvent(anim, mutation.EventIndex!.Value);

                // 全文时间槽使用者检查：不能被本动画其它事件或其它动画的事件共享 (SF-11 §2.6.2)
                if (timeSlotMap.TryGetValue(ev.StartTimeAbs, out var startUsers))
                {
                    var otherStartUsers = startUsers.Where(u => u.AnimId != anim.AnimId || u.EventIndex != ev.Index).ToList();
                    if (otherStartUsers.Count > 0)
                    {
                        var firstOther = otherStartUsers[0];
                        throw new TaeWriteBlockedException(
                            $"TAE 动画 {mutation.AnimId} 事件 {ev.Index} 的起始时间槽被动画 {firstOther.AnimId} 事件 {firstOther.EventIndex} 共享；"
                            + "改写会非预期地改动兄弟事件（sibling verify 失败），拒绝写回。",
                            "TAE_SHARED_TIME_SLOT_WRITE_UNSUPPORTED",
                            new { mutation = mutation.Kind, reason = "shared-start-time-slot", sharedWithAnim = firstOther.AnimId, sharedWithEvent = firstOther.EventIndex });
                    }
                }

                if (timeSlotMap.TryGetValue(ev.EndTimeAbs, out var endUsers))
                {
                    var otherEndUsers = endUsers.Where(u => u.AnimId != anim.AnimId || u.EventIndex != ev.Index).ToList();
                    if (otherEndUsers.Count > 0)
                    {
                        var firstOther = otherEndUsers[0];
                        throw new TaeWriteBlockedException(
                            $"TAE 动画 {mutation.AnimId} 事件 {ev.Index} 的结束时间槽被动画 {firstOther.AnimId} 事件 {firstOther.EventIndex} 共享；"
                            + "改写会非预期地改动兄弟事件（sibling verify 失败），拒绝写回。",
                            "TAE_SHARED_TIME_SLOT_WRITE_UNSUPPORTED",
                            new { mutation = mutation.Kind, reason = "shared-end-time-slot", sharedWithAnim = firstOther.AnimId, sharedWithEvent = firstOther.EventIndex });
                    }
                }

                // 零时长点事件（start/end 指向同一时间槽）：只能写入同一个值 (SF-11 §2.6.2)
                if (ev.StartTimeAbs == ev.EndTimeAbs && mutation.StartTime!.Value != mutation.EndTime!.Value)
                {
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 事件 {ev.Index} 的 start/end 指向同一时间槽（点事件），"
                        + $"要求 startTime == endTime，收到 {mutation.StartTime} ≠ {mutation.EndTime}。",
                        "TAE_SHARED_TIME_SLOT_WRITE_UNSUPPORTED",
                        new { mutation = mutation.Kind, reason = "point-event-single-slot" });
                }
            }
            else if (mutation.Kind == "insert-event")
            {
                ValidateTimes(mutation.StartTime!.Value, mutation.EndTime!.Value);
                var template = ResolveEvent(anim, mutation.TemplateEventIndex!.Value);

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
                var last = anim.Events[^1];
                if (last.ParamDataAbs != 0
                    && (last.ParamDataAbs < last.EventDataAbs + EventDataHeaderSize || last.ParamDataAbs > anim.EventGroupTableAbs))
                {
                    throw new TaeWriteBlockedException(
                        $"TAE 动画 {mutation.AnimId} 事件 {last.Index} 的参数体偏移 {last.ParamDataAbs} 越出"
                        + $"[eventData+16={last.EventDataAbs + EventDataHeaderSize}, eventGroupTable={anim.EventGroupTableAbs})，"
                        + "无法无损判定末尾事件参数体长度，拒绝插入新事件。",
                        "TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE",
                        new { mutation = mutation.Kind, reason = "last-event-param-layout-unknown" });
                }

                var templateSpan = GetTemplateSpan(anim, template);
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

    private static List<object> BuildAndApplyPlan(
        List<TaeMutation> mutations,
        TaeLayout layout,
        ByteRangeWritePlan plan,
        byte[] source)
    {
        var summaries = new List<object>(mutations.Count);

        // 1. 处理所有 update-event-times
        foreach (var m in mutations.Where(m => m.Kind == "update-event-times"))
        {
            var anim = layout.FindAnim(m.AnimId)!;
            var ev = ResolveEvent(anim, m.EventIndex!.Value);

            var startBytes = BitConverter.GetBytes(m.StartTime!.Value);
            plan.AddOrUpdateInterval(ev.StartTimeAbs, startBytes, $"anim:{m.AnimId}:event:{ev.Index}:start", $"set-start:{m.StartTime}");

            if (ev.EndTimeAbs != ev.StartTimeAbs)
            {
                var endBytes = BitConverter.GetBytes(m.EndTime!.Value);
                plan.AddOrUpdateInterval(ev.EndTimeAbs, endBytes, $"anim:{m.AnimId}:event:{ev.Index}:end", $"set-end:{m.EndTime}");
            }

            summaries.Add(new
            {
                mutation = m.Kind,
                animId = m.AnimId,
                eventIndex = m.EventIndex,
                startTime = m.StartTime,
                endTime = m.EndTime,
                byteSurgical = true
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

            // 为该动画的每个新增事件分配时间槽、参数体与事件头
            foreach (var insertMutation in animInserts)
            {
                var template = ResolveEvent(anim, insertMutation.TemplateEventIndex!.Value);
                var templateSpan = GetTemplateSpan(anim, template);
                var eventTypeId = insertMutation.EventTypeId ?? template.EventTypeId;

                // 2.1 新时间槽
                var startTimeAbs = plan.Append(BitConverter.GetBytes(insertMutation.StartTime!.Value), $"anim:{animId}:new_event_{currentEventCount}:start");
                var endTimeAbs = plan.Append(BitConverter.GetBytes(insertMutation.EndTime!.Value), $"anim:{animId}:new_event_{currentEventCount}:end");

                // 2.2 新参数体 (逐字节拷贝模板参数体)
                var paramDataAbs = 0;
                if (templateSpan > 0)
                {
                    var paramCopy = source.AsSpan(template.ParamDataAbs, templateSpan).ToArray();
                    paramDataAbs = plan.Append(paramCopy, $"anim:{animId}:new_event_{currentEventCount}:param");
                }

                // 2.3 新事件数据头 (16 字节)
                var header = new byte[EventDataHeaderSize];
                BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0, 4), eventTypeId);
                Buffer.BlockCopy(source, template.EventDataAbs + 4, header, 4, 4); // 模板保留 padding
                BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(8, 8), paramDataAbs);
                var eventDataAbs = plan.Append(header, $"anim:{animId}:new_event_{currentEventCount}:header", alignment: 8);

                insertSpecs.Add(new InsertSpec(
                    insertMutation,
                    currentEventCount,
                    eventTypeId,
                    templateSpan,
                    startTimeAbs,
                    endTimeAbs,
                    paramDataAbs,
                    eventDataAbs));

                currentEventCount++;
            }

            // 2.4 一次性构建并追加该动画的最终事件表 (Final eventTable)
            var oldTableSize = checked((int)(anim.EventCount * EventTableEntrySize));
            var newTableSize = oldTableSize + insertSpecs.Count * EventTableEntrySize;
            var finalTable = new byte[newTableSize];

            // 拷贝原事件表
            Buffer.BlockCopy(source, anim.EventTableAbs, finalTable, 0, oldTableSize);

            // 写入所有新增事件条目
            for (var k = 0; k < insertSpecs.Count; k++)
            {
                var spec = insertSpecs[k];
                var entryOffset = oldTableSize + k * EventTableEntrySize;
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(entryOffset, 8), spec.StartTimeAbs);
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(entryOffset + 8, 8), spec.EndTimeAbs);
                BinaryPrimitives.WriteInt64LittleEndian(finalTable.AsSpan(entryOffset + 16, 8), spec.EventDataAbs);
            }

            var newTableAbs = plan.Append(finalTable, $"anim:{animId}:final_event_table", alignment: 8);

            // 2.5 更新动画条目：指针重定位与事件数 (通过 WriteInterval)
            plan.AddOrUpdateInterval(anim.AnimEntryAbs, BitConverter.GetBytes((long)newTableAbs), $"anim:{animId}:entry:table_offset", $"table:{newTableAbs}");
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

        // 4. 若发生插入追加，同步文件头声明大小 (0x0C int32)
        if (insertsByAnim.Count > 0)
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
        byte[] source)
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

            if (Math.Abs(evReread.StartTime - m.StartTime!.Value) > 0.0001f || Math.Abs(evReread.EndTime - m.EndTime!.Value) > 0.0001f)
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

                if (Math.Abs(rereadOtherEv.StartTime - origStart) > 0.0001f || Math.Abs(rereadOtherEv.EndTime - origEnd) > 0.0001f)
                {
                    throw new InvalidDataException($"兄弟事件 {i} 时间发生非预期变更: 原 {origStart}/{origEnd}，重读 {rereadOtherEv.StartTime}/{rereadOtherEv.EndTime}。");
                }
            }
        }

        // 2. 验证 insert 命中与模板参数一致性
        foreach (var m in mutations.Where(m => m.Kind == "insert-event"))
        {
            var animOrig = layout.FindAnim(m.AnimId)!;
            var animReread = rereadAnims[m.AnimId];
            var template = animOrig.Events[m.TemplateEventIndex!.Value];
            var templateSpan = GetTemplateSpan(animOrig, template);

            var newEv = animReread.Events.FirstOrDefault(e =>
                Math.Abs(e.StartTime - m.StartTime!.Value) < 0.0001f
                && Math.Abs(e.EndTime - m.EndTime!.Value) < 0.0001f
                && e.EventTypeId == (m.EventTypeId ?? template.EventTypeId));

            if (newEv == null)
            {
                throw new InvalidDataException($"重读后未找到新增事件: animId={m.AnimId}, time={m.StartTime}..{m.EndTime}。");
            }

            // 参数体逐字节核验
            if (templateSpan > 0)
            {
                var newParamOffset = checked((int)newEv.ParameterDataOffset);
                if (!reread.SourceBytes.AsSpan(newParamOffset, templateSpan).SequenceEqual(source.AsSpan(template.ParamDataAbs, templateSpan)))
                {
                    throw new InvalidDataException($"新增事件参数体与模板事件不一致。");
                }
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
                return new TaeMutation(kind, animId, null, templateEventIndex, eventTypeId, startTime, endTime, null, null, null, null);
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
        int? SchemaBankId);

    private sealed class TaeLayout
    {
            public Dictionary<long, AnimInfo> Animations { get; }
            public int? SchemaBankId { get; }

        private TaeLayout(Dictionary<long, AnimInfo> animations, int? schemaBankId)
        {
            Animations = animations;
            SchemaBankId = schemaBankId;
        }

        public AnimInfo? FindAnim(long animId) => Animations.TryGetValue(animId, out var anim) ? anim : null;

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
            var eventBank = ReadInt64(source, 0x30);
            var schemaBankId = eventBank is 13 or 14 ? (int)eventBank : (int?)null;
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
            return new TaeLayout(animations, schemaBankId);
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

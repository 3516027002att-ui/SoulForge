using System.Buffers.Binary;
using System.Text.Json;

/// <summary>
/// Sekiro ESD (Event State Definition) transition writer（BEHAVIOR-55C）。
///
/// 只接受 typed transition mutation（behavior-transition-upsert），三个 kind：
///   · <c>set-transition-target</c> —— **字节级外科替换**某条件记录 +0x00 的
///     targetStateOffset（相对 DataStart 的 int64），把它重指向另一条已解析
///     state 记录的起点（或 -1 清空转移）。目标条件必须属于给定状态的
///     条件偏移数组（唯一性守卫），目标状态必须命中语义 state 记录起点。
///   · <c>insert-transition</c> —— **在 entry 表内新增转移**：追加一条裸跳转
///     条件（无 evaluator、无 pass 命令，targetStateOffset 指向目标状态）到
///     数据区末尾，把该状态的条件偏移数组与全局 condition-offset 表
///     （文件头 0x4C/0x50）原样复制 + 追加新条目后重定位，并更新 dataSize、
///     声明条件数与 0x54–0x6B 的 dataSize 镜像字段。任一未知模式
///     （表计数与声明条件数不符、镜像字段与 dataSize 不一致）即 fail-closed。
///   · <c>set-command-arg</c> —— **恒 fail-closed**：命令参数体是 RPN 字节码，
///     EsdNativeDocument 按不透明 (offset,length) 上报；scope.json 的
///     SCOPE-BEHAVIOR-ESD 把「未知表达式或命令不得重编码」列为永久禁令，
///     本 writer 不解码也不重编码，改写条件命令参数即摧毁未知结构 →
///     <see cref="EsdWriteBlockedException"/>（ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE）。
///
/// 无损策略：set-transition-target 是纯字节外科（目标条件记录之外的一切字节
/// 原样保留，含 RPN 字节码与 unparsedGaps）；insert-transition 只追加新结构
/// 并复制既有表，旧字节逐位保留。两者写回重读后 unparsedGaps 必须逐项一致，
/// 作为「未知字段无损保留」的可判定证据；重读后 CoverageComplete 必须保持。
///
/// DCX：ESD 在 Sekiro 中位于 talkesdbnd.dcx 容器内子项；容器外层重建由
/// Patch Engine 在 main 侧完成（与 MTD/TPF 同一分工）。本 writer 只接受
/// loose .esd，不接受 DCX 外壳——单文件 ESD 的写由 writer 负责，容器层不重复。
/// </summary>
internal static class EsdNativeWriter
{
    // ── Layout constants（与 EsdNativeDocument.cs 同源；改动必须同步）──
    private const int FileHeaderSize = 0x6C;   // 108
    private const int DataStart = 0x6C;
    private const int DataHeaderSize = 0x48;   // 72
    private const int StateGroupEntrySize = 0x20;
    private const int StateEntrySize = 0x48;
    private const int ConditionEntrySize = 0x38;
    private const long MaxSourceBytes = 64L * 1024 * 1024;

    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        if (source.Length < FileHeaderSize + DataHeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"ESD 大小 {source.Length} 超出安全范围。");
        // 只接受 loose .esd：DCX/BND 容器外层重建由 Patch Engine 在 main 侧完成，
        // 本 writer 不重复实现容器逻辑（硬约束「不要发明第二套容器重建逻辑」）。
        if (source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            throw new InvalidDataException("write-esd-document 只接受 loose .esd；DCX/BND 容器外层重建由 Patch Engine 在 main 侧完成。");
        var document = EsdNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "ESD source hash");

        var mutations = new List<EsdMutation>();
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
            throw new InvalidDataException("ESD writer 需要至少一条 mutation。");

        var context = new WriteContext(source, document);
        var appliedResults = new List<EsdApplied>(mutations.Count);
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
        var temporary = Path.Combine(directory, $".soulforge-esd-{Guid.NewGuid():N}.tmp");
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
        var reread = EsdNativeDocument.ReadFile(outputPath);
        if (!reread.CoverageComplete)
            throw new InvalidDataException(
                $"重读后 ESD 覆盖率不再完整：{string.Join("; ", reread.CoverageShortfalls())}");
        if (!reread.UnparsedGaps().SequenceEqual(document.UnparsedGaps()))
            throw new InvalidDataException("重读后 unparsedGaps 变化（未知结构未无损保留）。");
        var insertCount = mutations.Count(m => m.Kind == "insert-transition");
        if (reread.DeclaredConditionCount != document.DeclaredConditionCount + insertCount)
            throw new InvalidDataException(
                $"重读后声明条件数 {reread.DeclaredConditionCount} ≠ 写前 {document.DeclaredConditionCount} + {insertCount}。");
        if (reread.ParsedConditionCount != document.ParsedConditionCount + insertCount)
            throw new InvalidDataException(
                $"重读后解析条件数 {reread.ParsedConditionCount} ≠ 写前 {document.ParsedConditionCount} + {insertCount}。");

        // 未被本调用重定向的旧条件，转移目标必须逐项不变。
        var retargeted = mutations
            .Where(m => m.Kind == "set-transition-target")
            .Select(m => m.ConditionRelOffset!.Value)
            .ToHashSet();
        var rereadTargets = reread.TransitionEdges.ToDictionary(e => e.ConditionRelOffset, e => e.TargetStateRelOffset);
        foreach (var pair in context.SourceConditionTargets)
        {
            if (retargeted.Contains(pair.Key)) continue;
            if (!rereadTargets.TryGetValue(pair.Key, out var after) || after != pair.Value)
                throw new InvalidDataException(
                    $"重读后条件 relOffset={pair.Key} 的转移目标变化（{pair.Value} → {after}），非预期修改。");
        }

        var summaries = new List<object>(mutations.Count);
        for (var i = 0; i < mutations.Count; i++)
        {
            context.VerifyReread(mutations[i], appliedResults[i], reread);
            summaries.Add(appliedResults[i].ToSummary());
        }

        return new
        {
            mutationCount = mutations.Count,
            insertCount,
            outputHash = reread.SourceHash,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            structurePreserved = true,
            byteSurgical = appliedResults.All(a => a.Kind == "set-transition-target"),
            mutations = summaries
        };
    }

    private static EsdMutation ParseMutation(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation").ToLowerInvariant();
        var stateRel = OptionalInt64(item, "stateRelOffset");
        var conditionRel = OptionalInt64(item, "conditionRelOffset");
        var targetRel = OptionalInt64(item, "targetStateRelOffset");
        switch (kind)
        {
            case "set-transition-target":
                if (stateRel is null) throw new InvalidDataException("set-transition-target 需要 stateRelOffset。");
                if (conditionRel is null) throw new InvalidDataException("set-transition-target 需要 conditionRelOffset。");
                if (targetRel is null) throw new InvalidDataException("set-transition-target 需要 targetStateRelOffset（-1 表示清空转移）。");
                return new EsdMutation(kind, stateRel.Value, conditionRel, targetRel.Value);
            case "insert-transition":
                if (stateRel is null) throw new InvalidDataException("insert-transition 需要 stateRelOffset。");
                if (targetRel is null) throw new InvalidDataException("insert-transition 需要 targetStateRelOffset。");
                return new EsdMutation(kind, stateRel.Value, null, targetRel.Value);
            case "set-command-arg":
                // RPN 字节码是永久不解码 gap（scope.json SCOPE-BEHAVIOR-ESD），
                // 本 kind 恒在 Apply 阶段 fail-closed；不需要定位字段。
                return new EsdMutation(kind, stateRel ?? 0, conditionRel, targetRel ?? 0);
            default:
                throw new InvalidDataException($"未知 ESD mutation 类型：{kind}");
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

    private static long? OptionalInt64(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)
            ? parsed : null;

    private static int ReadInt32(byte[] data, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4));

    private static long ReadInt64(byte[] data, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(data.AsSpan(offset, 8));

    private static void WriteInt32(byte[] data, int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(offset, 4), value);

    private static void WriteInt64LE(byte[] data, int offset, long value) =>
        BinaryPrimitives.WriteInt64LittleEndian(data.AsSpan(offset, 8), value);

    private static byte[] EncodeInt64Array(long[] values)
    {
        var bytes = new byte[values.Length * 8];
        for (var i = 0; i < values.Length; i++)
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(i * 8, 8), values[i]);
        return bytes;
    }

    /// <summary>
    /// 一个 transition mutation 的解析后形态。source 定位统一用 relOffset
    /// （读信封的 sourceStateRelOffset / conditionRelOffset）：ESD 状态没有
    /// 字符串名，(groupId, stateId) 不在读信封里暴露，relOffset 才是 stable id。
    /// </summary>
    private sealed record EsdMutation(
        string Kind,
        long StateRelOffset,
        long? ConditionRelOffset,
        long TargetStateRelOffset);

    /// <summary>
    /// writer 对一个 mutation 的应用结果（含写后校验所需的已计算偏移与旧值）。
    /// <see cref="BeforeBytes"/> 是本条 mutation 应用前的字节快照，用于逐条做
    /// 字节级外科 / 无意外变化校验。
    /// </summary>
    private sealed class EsdApplied
    {
        public required string Kind { get; init; }
        public long StateRel { get; init; }
        public long ConditionRel { get; init; }
        public long TargetStateRel { get; init; }
        public byte[] BeforeBytes { get; set; } = Array.Empty<byte>();
        // insert-transition 专用
        public long OldCondArrCount { get; init; }
        public long[] OldCondArrEntries { get; init; } = Array.Empty<long>();
        public int NewConditionRel { get; init; }
        public int NewArrayRel { get; init; }
        public int? NewTableRel { get; init; }
        public bool TableRelocated { get; init; }
        public long[] OldTableEntries { get; init; } = Array.Empty<long>();
        public bool ReservedEndOffsetsUpdated { get; init; }
        public int? SentinelAbs { get; init; }
        public int TotalAppended { get; init; }

        public object ToSummary() => new
        {
            mutation = Kind,
            stateRelOffset = StateRel,
            conditionRelOffset = ConditionRel,
            targetStateRelOffset = TargetStateRel,
            inserted = Kind == "insert-transition" ? new
            {
                conditionRelOffset = NewConditionRel,
                arrayRelOffset = NewArrayRel,
                tableRelOffset = NewTableRel,
                tableRelocated = TableRelocated,
                reservedEndOffsetsUpdated = ReservedEndOffsetsUpdated
            } : null
        };
    }

    /// <summary>
    /// 写上下文：持有源字节与工作字节，提供 layout 遍历、字节读写与追加。
    /// 所有 relOffset 均相对 DataStart（与 EsdNativeDocument 同口径）。
    /// </summary>
    private sealed class WriteContext
    {
        private readonly byte[] _source;
        private byte[] _bytes;
        private readonly EsdLayout _layout;
        private readonly Dictionary<long, long> _sourceConditionTargets;

        public WriteContext(byte[] source, EsdNativeDocument document)
        {
            _source = source;
            _bytes = (byte[])source.Clone();
            _layout = EsdLayout.Read(source);
            _sourceConditionTargets = document.TransitionEdges.ToDictionary(
                e => e.ConditionRelOffset, e => e.TargetStateRelOffset);
        }

        public byte[] Bytes => _bytes;

        public IReadOnlyDictionary<long, long> SourceConditionTargets => _sourceConditionTargets;

        public EsdApplied Apply(EsdMutation mutation) => mutation.Kind switch
        {
            "set-transition-target" => ApplySetTransitionTarget(mutation),
            "insert-transition" => ApplyInsertTransition(mutation),
            "set-command-arg" => throw new EsdWriteBlockedException(
                "ESD 命令参数体是 RPN 字节码，按不透明 (offset,length) 上报；"
                + "scope.json 的 SCOPE-BEHAVIOR-ESD 把「未知表达式或命令不得重编码」列为永久禁令，"
                + "本 writer 不解码也不重编码，改写条件命令参数即摧毁未知结构，拒绝写回。",
                new { mutation = mutation.Kind, reason = "rpn-bytecode-not-decodable" }),
            _ => throw new InvalidDataException($"未知 ESD mutation 类型：{mutation.Kind}")
        };

        // ── set-transition-target ──

        private EsdApplied ApplySetTransitionTarget(EsdMutation mutation)
        {
            var stateRel = mutation.StateRelOffset;
            var conditionRel = mutation.ConditionRelOffset!.Value;
            var targetRel = mutation.TargetStateRelOffset;
            // 目标状态先于任何写字节校验：目标不存在 → fail-closed，不半写。
            ResolveTargetState(targetRel);
            // 条件必须唯一地属于该状态的条件偏移数组（「按唯一状态/条件定位」守卫）。
            LocateConditionIndex(stateRel, conditionRel);
            WriteInt64LE(_bytes, Abs(conditionRel), targetRel);
            return new EsdApplied
            {
                Kind = mutation.Kind,
                StateRel = stateRel,
                ConditionRel = conditionRel,
                TargetStateRel = targetRel
            };
        }

        private void VerifySetTransitionTargetReread(EsdMutation mutation, EsdApplied applied, EsdNativeDocument reread)
        {
            var output = reread.SourceBytes;
            var conditionAbs = Abs(applied.ConditionRel);
            var actual = BinaryPrimitives.ReadInt64LittleEndian(output.AsSpan(conditionAbs, 8));
            if (actual != mutation.TargetStateRelOffset)
                throw new InvalidDataException(
                    $"重读后条件 relOffset={applied.ConditionRel} 的转移目标 {actual} ≠ 写入 {mutation.TargetStateRelOffset}。");
            var edge = reread.TransitionEdges.FirstOrDefault(e => e.ConditionRelOffset == applied.ConditionRel)
                ?? throw new InvalidDataException($"重读后找不到条件 relOffset={applied.ConditionRel}。");
            if (edge.TargetStateRelOffset != mutation.TargetStateRelOffset)
                throw new InvalidDataException("重读后转移边目标与写入不一致。");
            VerifySurgicalDiff(output, conditionAbs, 8, applied.BeforeBytes);
        }

        // ── insert-transition ──

        private EsdApplied ApplyInsertTransition(EsdMutation mutation)
        {
            var stateRel = mutation.StateRelOffset;
            var targetRel = mutation.TargetStateRelOffset;
            if (targetRel < 0)
                throw new InvalidDataException("insert-transition 的目标不能是 -1（新增转移必须指向一个真实状态）。");
            ValidateState(stateRel);
            ResolveTargetState(targetRel);

            var beforeLength = _bytes.Length;
            var oldDataSize = _bytes.Length - DataStart;
            var condArrRel = ReadDataInt64(stateRel + 0x08);
            var condArrCount = ReadDataInt64(stateRel + 0x10);
            if (condArrRel >= 0 && (condArrCount < 0 || DataStart + condArrRel + condArrCount * 8 > _bytes.Length))
                throw new InvalidDataException("ESD 源状态条件偏移数组越界。");
            var oldCondArrEntries = condArrRel >= 0 && condArrCount > 0
                ? ReadCondArrEntries(condArrRel, (int)condArrCount)
                : Array.Empty<long>();

            // 1) 新条件记录：裸跳转（无 evaluator / 无 pass 命令），targetStateOffset 指向目标状态。
            var newCondition = new byte[ConditionEntrySize];
            WriteInt64LE(newCondition, 0x00, targetRel);
            WriteInt64LE(newCondition, 0x08, -1); // passCmdRel
            WriteInt64LE(newCondition, 0x10, 0);  // passCmdCount
            WriteInt64LE(newCondition, 0x18, -1); // subcondRel
            WriteInt64LE(newCondition, 0x20, 0);  // subcondCount
            WriteInt64LE(newCondition, 0x28, -1); // evalRel
            WriteInt64LE(newCondition, 0x30, 0);  // evalLength
            var newConditionRel = Append(newCondition);

            // 2) 新条件偏移数组 = 旧数组 + 新条件 rel；重定位后回写状态。
            var newArrEntries = new long[oldCondArrEntries.Length + 1];
            Array.Copy(oldCondArrEntries, newArrEntries, oldCondArrEntries.Length);
            newArrEntries[^1] = newConditionRel;
            var newArrayRel = Append(EncodeInt64Array(newArrEntries));
            WriteInt64LE(_bytes, Abs(stateRel + 0x08), newArrayRel);
            WriteInt64LE(_bytes, Abs(stateRel + 0x10), newArrEntries.Length);

            // 2b) 尾随哨兵槽 = 本组 slot 0 的逐字节副本（EsdNativeDocument 哨兵模型）。
            //     insert 修改了状态记录：若该状态是组内 slot 0，哨兵必须随之刷新，
            //     否则重读的 StateRecordModelConsistent 会把哨兵判成「携带独有数据」
            //     而降 partial——那是把布局漂移误报成解析缺陷。
            var stateIndex = _layout.StateIndexFor(stateRel);
            int? sentinelAbs = null;
            if (stateIndex == 0)
            {
                var groupInfo = _layout.GroupInfoFor(stateRel);
                var sentinelRel = groupInfo.StatesRel + groupInfo.StateCount * StateEntrySize;
                sentinelAbs = Abs(sentinelRel);
                Buffer.BlockCopy(_bytes, Abs(groupInfo.StatesRel), _bytes, sentinelAbs.Value, StateEntrySize);
            }

            // 3) 全局 condition-offset 表（entry 表内操作）：复制旧表 + 追加新条目。
            var currentTableOffset = ReadInt32(_bytes, 0x4C);
            var currentTableCount = ReadInt32(_bytes, 0x50);
            var currentDeclaredConditionCount = ReadInt32(_bytes, 0x38);
            var tableRelocated = false;
            int? newTableRel = null;
            long[] oldTableEntries = Array.Empty<long>();
            if (currentTableCount > 0)
            {
                if (currentTableCount != currentDeclaredConditionCount)
                    throw new EsdWriteBlockedException(
                        $"ESD 全局 condition-offset 表计数 {currentTableCount} 与声明条件数 {currentDeclaredConditionCount} 不一致，"
                        + "表语义不可信，拒绝在 entry 表内新增转移。",
                        new { reason = "cond-offset-table-count-mismatch" });
                oldTableEntries = ReadCondArrEntries(currentTableOffset, currentTableCount);
                var newTableEntries = new long[oldTableEntries.Length + 1];
                Array.Copy(oldTableEntries, newTableEntries, oldTableEntries.Length);
                newTableEntries[^1] = newConditionRel;
                newTableRel = Append(EncodeInt64Array(newTableEntries));
                WriteInt32(_bytes, 0x4C, newTableRel.Value);
                WriteInt32(_bytes, 0x50, newTableEntries.Length);
                tableRelocated = true;
            }
            else if (currentTableOffset != 0)
            {
                throw new EsdWriteBlockedException(
                    "ESD 全局 condition-offset 表偏移非零但计数为零，表语义未知，拒绝在 entry 表内新增转移。",
                    new { reason = "cond-offset-table-ambiguous" });
            }

            // 4) 头部 dataSize 与声明条件数。
            var newDataSize = _bytes.Length - DataStart;
            WriteInt32(_bytes, 0x14, newDataSize);
            WriteInt32(_bytes, 0x38, currentDeclaredConditionCount + 1);

            // 5) 0x54–0x6B 的 dataSize 镜像：仅当三个 int64 全部等于旧 dataSize
            //    （明确「数据区末尾」语义）时更新，否则 fail-closed。
            var reserved = new[] { ReadInt64(_bytes, 0x54), ReadInt64(_bytes, 0x5C), ReadInt64(_bytes, 0x64) };
            var reservedUpdated = false;
            if (reserved.All(v => v == oldDataSize))
            {
                WriteInt64LE(_bytes, 0x54, newDataSize);
                WriteInt64LE(_bytes, 0x5C, newDataSize);
                WriteInt64LE(_bytes, 0x64, newDataSize);
                reservedUpdated = true;
            }
            else
            {
                throw new EsdWriteBlockedException(
                    $"ESD 0x54–0x6B 的 dataSize 镜像字段与 dataSize 不一致（{string.Join(",", reserved)} vs {oldDataSize}），"
                    + "语义未知，拒绝在 entry 表内新增转移。",
                    new { reason = "reserved-end-offsets-ambiguous" });
            }

            return new EsdApplied
            {
                Kind = mutation.Kind,
                StateRel = stateRel,
                ConditionRel = newConditionRel,
                TargetStateRel = targetRel,
                OldCondArrCount = condArrCount,
                OldCondArrEntries = oldCondArrEntries,
                NewConditionRel = newConditionRel,
                NewArrayRel = newArrayRel,
                NewTableRel = newTableRel,
                TableRelocated = tableRelocated,
                OldTableEntries = tableRelocated ? oldTableEntries : Array.Empty<long>(),
                ReservedEndOffsetsUpdated = reservedUpdated,
                SentinelAbs = sentinelAbs,
                TotalAppended = _bytes.Length - beforeLength
            };
        }

        private void VerifyInsertTransitionReread(EsdMutation mutation, EsdApplied applied, EsdNativeDocument reread)
        {
            var output = reread.SourceBytes;
            // 新条件目标命中。
            var rereadTargets = reread.TransitionEdges.ToDictionary(e => e.ConditionRelOffset, e => e.TargetStateRelOffset);
            if (!rereadTargets.TryGetValue(applied.NewConditionRel, out var newTarget) || newTarget != applied.TargetStateRel)
                throw new InvalidDataException(
                    $"重读后新增条件 relOffset={applied.NewConditionRel} 的转移目标 {newTarget} ≠ {applied.TargetStateRel}。");
            VerifyInsertByteStructure(applied, output);
        }

        private void VerifyInsertByteStructure(EsdApplied applied, byte[] output)
        {
            var before = applied.BeforeBytes;
            if (output.Length < before.Length + applied.TotalAppended)
                throw new InvalidDataException(
                    $"insert 后 output 长度 {output.Length} 小于预期 {before.Length + applied.TotalAppended}。");
            var regions = new List<(int AbsStart, int AbsEnd)>
            {
                (0x14, 0x18),                          // dataSize
                (0x38, 0x3C)                           // declaredConditionCount
            };
            if (applied.TableRelocated) regions.Add((0x4C, 0x54));           // condOffsets offset+count
            if (applied.ReservedEndOffsetsUpdated) regions.Add((0x54, 0x6C)); // dataSize 镜像
            var stateAbs = Abs(applied.StateRel);
            regions.Add((stateAbs + 0x08, stateAbs + 0x18)); // condArrRel + condArrCount
            if (applied.SentinelAbs is { } sentinelAbs)
                regions.Add((sentinelAbs, sentinelAbs + StateEntrySize)); // 哨兵槽随 slot 0 刷新
            for (var i = 0; i < before.Length; i++)
            {
                if (output[i] != before[i])
                {
                    var inRegion = regions.Any(r => i >= r.AbsStart && i < r.AbsEnd);
                    if (!inRegion)
                        throw new InvalidDataException($"insert 后 output 在偏移 {i} 与源不一致（非预期变化）。");
                }
            }

            // 本次追加结构：新条件记录 → 新条件数组 → 新表。
            var pos = before.Length;
            for (var f = 0; f < ConditionEntrySize; f += 8)
            {
                var value = BinaryPrimitives.ReadInt64LittleEndian(output.AsSpan(pos + f, 8));
                var expected = f switch
                {
                    0x00 => applied.TargetStateRel,
                    0x08 or 0x18 or 0x28 => -1L,
                    _ => 0L
                };
                if (value != expected)
                    throw new InvalidDataException($"追加条件记录字段 +0x{f:X2} 值 {value} ≠ 预期 {expected}。");
            }
            pos += ConditionEntrySize;
            var expectedArr = new long[applied.OldCondArrEntries.Length + 1];
            Array.Copy(applied.OldCondArrEntries, expectedArr, applied.OldCondArrEntries.Length);
            expectedArr[^1] = applied.NewConditionRel;
            VerifyInt64Sequence(output, pos, expectedArr);
            pos += expectedArr.Length * 8;
            if (applied.TableRelocated && applied.NewTableRel is { } newTableRel)
            {
                if (pos != DataStart + newTableRel)
                    throw new InvalidDataException($"新表位置 {pos} ≠ 预期 {DataStart + newTableRel}。");
                // 全局 condition-offset 表条目数 = 全部条件数（该状态条件数组只是它的一部分），
                // 必须用旧表条目 + 新条件单独核对，不能用状态条件数组的 expectedArr。
                var expectedTable = new long[applied.OldTableEntries.Length + 1];
                Array.Copy(applied.OldTableEntries, expectedTable, applied.OldTableEntries.Length);
                expectedTable[^1] = applied.NewConditionRel;
                VerifyInt64Sequence(output, pos, expectedTable);
            }
        }

        private static void VerifyInt64Sequence(byte[] output, int absStart, long[] expected)
        {
            for (var i = 0; i < expected.Length; i++)
            {
                var value = BinaryPrimitives.ReadInt64LittleEndian(output.AsSpan(absStart + i * 8, 8));
                if (value != expected[i])
                    throw new InvalidDataException($"追加的 int64 序列第 {i} 项 {value} ≠ 预期 {expected[i]}。");
            }
        }

        // ── 公共校验入口 ──

        public void VerifyReread(EsdMutation mutation, EsdApplied applied, EsdNativeDocument reread)
        {
            switch (mutation.Kind)
            {
                case "set-transition-target":
                    VerifySetTransitionTargetReread(mutation, applied, reread);
                    break;
                case "insert-transition":
                    VerifyInsertTransitionReread(mutation, applied, reread);
                    break;
            }
        }

        // ── layout 定位 ──

        private void ValidateState(long stateRel)
        {
            if (!_layout.StateByRelOffset.ContainsKey(stateRel))
                throw new InvalidDataException($"ESD 源状态 relOffset={stateRel} 不存在。");
        }

        private void ResolveTargetState(long targetRel)
        {
            if (targetRel < 0) return; // -1 = 清空转移
            if (!_layout.StateByRelOffset.ContainsKey(targetRel))
                throw new InvalidDataException(
                    $"ESD 目标状态 relOffset={targetRel} 不存在（转移目标必须落在语义 state 记录起点上）。");
        }

        /// <summary>
        /// 条件必须唯一地出现在该状态的条件偏移数组里（0 或 >1 都 fail-closed）。
        /// 返回其数组下标（供诊断）。
        /// </summary>
        private int LocateConditionIndex(long stateRel, long conditionRel)
        {
            ValidateState(stateRel);
            var condArrRel = ReadDataInt64(stateRel + 0x08);
            var condArrCount = ReadDataInt64(stateRel + 0x10);
            if (condArrRel < 0 || condArrCount <= 0)
                throw new InvalidDataException(
                    $"ESD 状态 relOffset={stateRel} 没有条件数组，条件 relOffset={conditionRel} 不属于它。");
            if (condArrCount > 1_000_000 || DataStart + condArrRel + condArrCount * 8 > _bytes.Length)
                throw new InvalidDataException("ESD 条件偏移数组越界。");
            var matches = 0;
            var matchIndex = -1;
            for (var i = 0; i < (int)condArrCount; i++)
            {
                var entry = ReadDataInt64(condArrRel + i * 8);
                if (entry == conditionRel) { matches++; matchIndex = i; }
            }
            if (matches != 1)
                throw new InvalidDataException(
                    $"ESD 条件 relOffset={conditionRel} 在状态 relOffset={stateRel} 的条件数组中出现 {matches} 次（必须唯一）。");
            return matchIndex;
        }

        private long[] ReadCondArrEntries(long relOffset, int count)
        {
            var entries = new long[count];
            for (var i = 0; i < count; i++)
                entries[i] = ReadDataInt64(relOffset + i * 8);
            return entries;
        }

        // ── 字节级工具 ──

        private long ReadDataInt64(long relOffset) =>
            BinaryPrimitives.ReadInt64LittleEndian(_bytes.AsSpan(Abs(relOffset), 8));

        private static int Abs(long relOffset) => checked((int)(DataStart + relOffset));

        private int Append(byte[] block)
        {
            var rel = _bytes.Length - DataStart;
            var next = new byte[_bytes.Length + block.Length];
            Buffer.BlockCopy(_bytes, 0, next, 0, _bytes.Length);
            Buffer.BlockCopy(block, 0, next, _bytes.Length, block.Length);
            _bytes = next;
            return rel;
        }

        /// <summary>
        /// 重读 output 除指定绝对区间外必须与 before 逐字节一致（字节外科的直接证据）。
        /// </summary>
        private void VerifySurgicalDiff(byte[] output, long absRegionStart, int length, byte[] before)
        {
            if (output.Length != before.Length)
                throw new InvalidDataException($"重读 output 长度 {output.Length} 与写前 {before.Length} 不一致。");
            for (var i = 0; i < output.Length; i++)
            {
                var inRegion = i >= absRegionStart && i < absRegionStart + length;
                if (!inRegion && output[i] != before[i])
                    throw new InvalidDataException($"重读 output 在偏移 {i} 与写前不一致（外科替换区间外）。");
            }
        }
    }

    /// <summary>
    /// 从源字节轻量重走 ESD 布局：分组 → 状态的 relOffset 集合，供
    /// set-transition-target / insert-transition 定位源状态与校验目标状态。
    /// 与 EsdNativeDocument.Read 的布局口径一致（EsdNativeDocument 已先通过校验，
    /// 这里只在它之上做 writer 需要的 byte 级定位）。
    /// </summary>
    private sealed class EsdLayout
    {
        public IReadOnlyDictionary<long, (long GroupId, long StateId, int GroupIndex, int StateIndex)> StateByRelOffset { get; private init; } =
            new Dictionary<long, (long, long, int, int)>();

        /// <summary>每组 (statesRel, stateCount)，供哨兵槽定位。</summary>
        public IReadOnlyList<(long StatesRel, long StateCount)> Groups { get; private init; } =
            Array.Empty<(long, long)>();

        /// <summary>某状态所属组的尾随哨兵槽 relOffset（= statesRel + stateCount * 0x48）。</summary>
        public long SentinelRelFor(long stateRel) => GroupInfoFor(stateRel).StatesRel + GroupInfoFor(stateRel).StateCount * StateEntrySize;

        /// <summary>某状态在组内的下标；0 = 该组 slot 0（哨兵的镜像源）。</summary>
        public int StateIndexFor(long stateRel) => StateByRelOffset[stateRel].StateIndex;

        public (long StatesRel, long StateCount) GroupInfoFor(long stateRel) =>
            Groups[StateByRelOffset[stateRel].GroupIndex];

        public static EsdLayout Read(byte[] source)
        {
            if (source.Length < FileHeaderSize + DataHeaderSize || source.Length > MaxSourceBytes)
                throw new InvalidDataException("ESD 大小超出安全范围。");
            var stateGroupsRelOffset = ReadInt64(source, 0x84);
            var declaredStateGroupCount = ReadInt32(source, 0x28);
            if (declaredStateGroupCount < 0 || declaredStateGroupCount > 100_000)
                throw new InvalidDataException("ESD 状态组数量越界。");
            if (stateGroupsRelOffset < 0 || DataStart + stateGroupsRelOffset + (long)declaredStateGroupCount * StateGroupEntrySize > source.Length)
                throw new InvalidDataException("ESD 状态组表越界。");
            var map = new Dictionary<long, (long, long, int, int)>();
            var groups = new List<(long, long)>(declaredStateGroupCount);
            for (var g = 0; g < declaredStateGroupCount; g++)
            {
                var gAbs = (int)(DataStart + stateGroupsRelOffset + (long)g * StateGroupEntrySize);
                if (gAbs + StateGroupEntrySize > source.Length)
                    throw new InvalidDataException("ESD 状态组表越界。");
                var groupId = ReadInt64(source, gAbs);
                var statesRel = ReadInt64(source, gAbs + 0x08);
                var stateCount = ReadInt64(source, gAbs + 0x10);
                if (stateCount < 0 || stateCount > 1_000_000)
                    throw new InvalidDataException($"ESD 状态组 {groupId} 状态数越界。");
                if (statesRel < 0 || DataStart + statesRel + stateCount * StateEntrySize > source.Length)
                    throw new InvalidDataException($"ESD 状态组 {groupId} 状态表越界。");
                groups.Add((statesRel, stateCount));
                for (var s = 0; s < (int)stateCount; s++)
                {
                    var stateRel = statesRel + (long)s * StateEntrySize;
                    var stateId = ReadInt64(source, (int)(DataStart + stateRel));
                    map[stateRel] = (groupId, stateId, g, s);
                }
            }
            return new EsdLayout { StateByRelOffset = map, Groups = groups };
        }
    }
}

/// <summary>
/// ESD writer 的 fail-closed block 异常：未知结构无法无损保留时抛出，
/// dispatch 捕获后映射为 ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE + 结构化诊断。
/// 照 MtdWriteBlockedException 模式。
/// </summary>
internal sealed class EsdWriteBlockedException : Exception
{
    public EsdWriteBlockedException(string message, object? details = null) : base(message)
    {
        Details = details;
    }

    public object? Details { get; }
}

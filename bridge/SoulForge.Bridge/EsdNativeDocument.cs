using System.Buffers.Binary;
using System.Security.Cryptography;

/// <summary>
/// Sekiro ESD (Event State Definition) read-only native document.
/// Layout verified against sample.esd (59,189 bytes, 64-bit long format).
/// ESD defines per-NPC state machines: state groups → states → conditions → command calls.
/// File header (0x00–0x6B) uses absolute int32 fields; data header starts at 0x6C.
/// All post-header offsets are relative to dataStart (0x6C).
/// Expression bytecode is reported as opaque (offset, length) pairs — not decoded.
///
/// <para><b>State 记录数 vs 语义状态数（0x30 的单位）。</b>
/// 文件头 0x30 计的是**物理 State 记录数**，不是语义状态数。每个 state group 的
/// states 数组实际占 <c>stateCount + 1</c> 个 72 字节槽：索引 0..stateCount-1 是
/// 真实状态，第 stateCount 槽是一个**尾随哨兵**，与该组 slot 0 逐字节相同。
/// 因此恒有 <c>0x30 == Σ(stateCount) + stateGroupCount</c>。
///
/// 实测依据（Sekiro 本机语料，只读）：script/talk 全部 10 个 talkesdbnd 容器共
/// 194 个 .esd、4957 个 state group——恒等式 194/194 成立；尾随槽与本组 slot 0
/// 逐字节相同 4957/4957；state 区按 <c>(stateCount+1)*72</c> 连续铺排无洞无重叠，
/// 铺满槽数精确等于 0x30。另在 436 组上做全文件 int64 扫描：尾随槽的相对偏移
/// 被引用 0/436，而 slot 0 的相对偏移被引用 436/436——尾随槽不可达，不携带独有数据。
///
/// 所以哨兵槽**不能**当成语义状态计入：那会把每组首状态重复计一次，让面板把
/// 659 个真实状态显示成 707。覆盖率判据因此按**记录数**对齐 0x30
/// （<see cref="ParsedStateRecordCount"/>），语义状态数单列
/// （<see cref="ParsedStateCount"/>）。这不是放宽判据——同时新增了
/// <see cref="StateRecordModelConsistent"/>：逐组核对尾随槽确实是 slot 0 的副本，
/// 布局一旦漂移（哨兵携带独有数据 = 它其实是真状态）立刻降 partial 并列出组号。</para>
/// </summary>
internal sealed class EsdNativeDocument
{
    // ── Layout constants ──
    private const int FileHeaderSize = 0x6C;   // 108 bytes
    private const int DataStart = 0x6C;         // all relative offsets anchor here
    private const int DataHeaderSize = 0x48;    // 72 bytes (0x6C–0xB3)
    private const int MinFileSize = FileHeaderSize + DataHeaderSize; // 180

    // ── Header constant expectations ──
    private const int ExpectedVersion = 1;
    private const int ExpectedDarkSoulsCount = 3;
    private const int ExpectedHeaderSize = 0x54;
    private const int ExpectedUnk18 = 6;
    private const int ExpectedConditionSize = 0x48;
    private const int ExpectedUnk20 = 1;
    private const int ExpectedStateGroupSize = 0x20;
    private const int ExpectedStateSize = 0x48;
    private const int ExpectedConditionStructSize = 0x38;
    private const int ExpectedCommandCallSize = 0x18;
    private const int ExpectedCommandArgSize = 0x10;

    // ── Struct entry sizes (for offset arithmetic) ──
    private const int StateGroupEntrySize = 32;   // 4 × int64
    private const int StateEntrySize = 72;         // 9 × int64
    private const int ConditionEntrySize = 56;     // 7 × int64
    private const int CommandCallEntrySize = 24;   // 2 × int32 + 2 × int64
    private const int CommandArgEntrySize = 16;    // 2 × int64

    // ── Safety bounds ──
    private const int MaxStateGroups = 100_000;
    private const int MaxStates = 1_000_000;
    private const int MaxConditions = 1_000_000;
    private const long MaxSourceBytes = 64L * 1024 * 1024;
    private const int MaxConditionDepth = 64;

    private EsdNativeDocument(
        byte[] sourceBytes,
        int version,
        int dataSize,
        int declaredStateGroupCount,
        int declaredStateCount,
        int declaredConditionCount,
        int declaredCommandCallCount,
        int declaredCommandArgCount,
        IReadOnlyList<EsdStateGroupInfo> stateGroups,
        int parsedStateCount,
        int parsedStateRecordCount,
        IReadOnlyList<long> sentinelDivergentGroupIds,
        int parsedConditionCount,
        int parsedCommandCallCount,
        int parsedCommandArgCount,
        IReadOnlyList<int> commandBanks,
        IReadOnlyList<EsdBytecodeRegion> bytecodeRegions)
    {
        SourceBytes = sourceBytes;
        Version = version;
        DataSize = dataSize;
        DeclaredStateGroupCount = declaredStateGroupCount;
        DeclaredStateCount = declaredStateCount;
        DeclaredConditionCount = declaredConditionCount;
        DeclaredCommandCallCount = declaredCommandCallCount;
        DeclaredCommandArgCount = declaredCommandArgCount;
        StateGroups = stateGroups;
        ParsedStateCount = parsedStateCount;
        ParsedStateRecordCount = parsedStateRecordCount;
        SentinelDivergentGroupIds = sentinelDivergentGroupIds;
        ParsedConditionCount = parsedConditionCount;
        ParsedCommandCallCount = parsedCommandCallCount;
        ParsedCommandArgCount = parsedCommandArgCount;
        CommandBanks = commandBanks;
        BytecodeRegions = bytecodeRegions;
    }

    public byte[] SourceBytes { get; }
    public int Version { get; }
    public int DataSize { get; }
    public int DeclaredStateGroupCount { get; }
    public int DeclaredStateCount { get; }
    public int DeclaredConditionCount { get; }
    public int DeclaredCommandCallCount { get; }
    public int DeclaredCommandArgCount { get; }
    public IReadOnlyList<EsdStateGroupInfo> StateGroups { get; }

    /// <summary>语义状态数：Σ(stateCount)，不含每组尾随哨兵槽。面板应显示这个。</summary>
    public int ParsedStateCount { get; }

    /// <summary>
    /// 物理 State 记录数：Σ(stateCount + 1)，含尾随哨兵槽。与文件头 0x30 同单位，
    /// 覆盖率判据比的是这一项。
    /// </summary>
    public int ParsedStateRecordCount { get; }

    /// <summary>
    /// 尾随槽与本组 slot 0 **不**逐字节相同的组 ID。实测语料下应为空；非空表示
    /// 哨兵模型不成立（那一槽可能携带独有数据 = 它其实是个真状态），必须降 partial。
    /// </summary>
    public IReadOnlyList<long> SentinelDivergentGroupIds { get; }

    public int ParsedConditionCount { get; }
    public int ParsedCommandCallCount { get; }
    public int ParsedCommandArgCount { get; }
    public IReadOnlyList<int> CommandBanks { get; }
    public IReadOnlyList<EsdBytecodeRegion> BytecodeRegions { get; }
    public string SourceHash => Hash(SourceBytes);

    // ══════════════════════════════════════════════════════════════
    //  Read
    // ══════════════════════════════════════════════════════════════

    public static EsdNativeDocument Read(byte[] source)
    {
        if (source.Length < MinFileSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException(
                $"ESD 大小 {source.Length} 超出安全范围（最小 {MinFileSize}，最大 {MaxSourceBytes}）。");

        // ── Magic "fsSL" ──
        if (!source.AsSpan(0, 4).SequenceEqual("fsSL"u8))
            throw new InvalidDataException("输入不是 ESD（缺少 \"fsSL\" 魔数）。");

        // ── Version ──
        var version = ReadInt32(source, 0x04);
        if (version != ExpectedVersion)
            throw new NotSupportedException($"仅支持 ESD version {ExpectedVersion}，收到 {version}。");

        // ── Dark Souls counts ──
        var darkSoulsCount = ReadInt32(source, 0x08);
        var darkSoulsCount2 = ReadInt32(source, 0x0C);
        if (darkSoulsCount != ExpectedDarkSoulsCount)
            throw new InvalidDataException(
                $"ESD darkSoulsCount {darkSoulsCount} 不匹配；期望 {ExpectedDarkSoulsCount}。");
        if (darkSoulsCount2 != darkSoulsCount)
            throw new InvalidDataException(
                $"ESD darkSoulsCount2 {darkSoulsCount2} 与 darkSoulsCount {darkSoulsCount} 不一致。");

        // ── Struct size constants ──
        ValidateConst(source, 0x10, ExpectedHeaderSize, "headerSize");
        var dataSize = ReadInt32(source, 0x14);
        ValidateConst(source, 0x18, ExpectedUnk18, "unk18");
        ValidateConst(source, 0x1C, ExpectedConditionSize, "conditionSize");
        ValidateConst(source, 0x20, ExpectedUnk20, "unk20");
        ValidateConst(source, 0x24, ExpectedStateGroupSize, "stateGroupSize");
        var declaredStateGroupCount = ReadInt32(source, 0x28);
        ValidateConst(source, 0x2C, ExpectedStateSize, "stateSize");
        var declaredStateCount = ReadInt32(source, 0x30);
        ValidateConst(source, 0x34, ExpectedConditionStructSize, "conditionStructSize");
        var declaredConditionCount = ReadInt32(source, 0x38);
        ValidateConst(source, 0x3C, ExpectedCommandCallSize, "commandCallSize");
        var declaredCommandCallCount = ReadInt32(source, 0x40);
        ValidateConst(source, 0x44, ExpectedCommandArgSize, "commandArgSize");
        var declaredCommandArgCount = ReadInt32(source, 0x48);
        // 0x4C: condOffsetsOffset, 0x50: condOffsetsCount — read but not structurally required
        // 0x54–0x6B: name block offsets / reserved — skipped

        // ── Bounds on declared counts ──
        if (declaredStateGroupCount < 0 || declaredStateGroupCount > MaxStateGroups)
            throw new InvalidDataException(
                $"ESD 状态组数量 {declaredStateGroupCount} 超出安全上限 {MaxStateGroups}。");
        if (declaredStateCount < 0 || declaredStateCount > MaxStates)
            throw new InvalidDataException(
                $"ESD 状态数量 {declaredStateCount} 超出安全上限 {MaxStates}。");
        if (declaredConditionCount < 0 || declaredConditionCount > MaxConditions)
            throw new InvalidDataException(
                $"ESD 条件数量 {declaredConditionCount} 超出安全上限 {MaxConditions}。");
        if (declaredCommandCallCount < 0 || declaredCommandCallCount > MaxStates)
            throw new InvalidDataException(
                $"ESD 命令调用数量 {declaredCommandCallCount} 超出安全上限。");
        if (declaredCommandArgCount < 0 || declaredCommandArgCount > MaxStates)
            throw new InvalidDataException(
                $"ESD 命令参数数量 {declaredCommandArgCount} 超出安全上限。");

        // ── dataSize must match actual payload ──
        if (dataSize != source.Length - DataStart)
            throw new InvalidDataException(
                $"ESD dataSize {dataSize} 与实际数据大小 {source.Length - DataStart} 不一致。");

        // ── Data header (0x6C–0xB3) ──
        var one = ReadInt32(source, 0x6C);
        if (one != 1)
            throw new InvalidDataException($"ESD 数据头 one={one}；期望 1。");

        // 0x70–0x7F: hash-like values — read for future use, not validated
        var stateGroupsRelOffset = ReadInt64(source, 0x84);
        var dataHeaderGroupCount = ReadInt64(source, 0x8C);
        if (dataHeaderGroupCount != declaredStateGroupCount)
            throw new InvalidDataException(
                $"ESD 数据头状态组数 {dataHeaderGroupCount} 与文件头 {declaredStateGroupCount} 不一致。");

        // ── Resolve state group table ──
        var stateGroupsAbs = DataStart + stateGroupsRelOffset;
        if (stateGroupsRelOffset < 0
            || stateGroupsAbs + (long)declaredStateGroupCount * StateGroupEntrySize > source.Length)
            throw new InvalidDataException(
                $"ESD 状态组表越界：relOffset={stateGroupsRelOffset}, count={declaredStateGroupCount}。");

        // ── Parse hierarchy ──
        var stateGroups = new List<EsdStateGroupInfo>(declaredStateGroupCount);
        var visitedConditions = new HashSet<long>();
        var visitedCalls = new HashSet<long>();
        var visitedArgs = new HashSet<long>();
        var banks = new SortedSet<int>();
        var bytecode = new List<EsdBytecodeRegion>();
        var totalParsedStates = 0;
        var totalStateRecords = 0;
        var sentinelDivergent = new List<long>();

        for (var g = 0; g < declaredStateGroupCount; g++)
        {
            var gOff = checked((int)(stateGroupsAbs + (long)g * StateGroupEntrySize));
            var groupId = ReadInt64(source, gOff);
            var statesRel = ReadInt64(source, gOff + 0x08);
            var stateCount = ReadInt64(source, gOff + 0x10);
            var statesRel2 = ReadInt64(source, gOff + 0x18);

            if (statesRel != statesRel2)
                throw new InvalidDataException(
                    $"ESD 状态组 {groupId} statesOffset {statesRel} 与 statesOffset2 {statesRel2} 不一致。");
            if (stateCount < 0 || stateCount > MaxStates)
                throw new InvalidDataException(
                    $"ESD 状态组 {groupId} 状态数 {stateCount} 越界。");

            var statesAbs = DataStart + statesRel;
            // 边界必须按 (stateCount + 1) 算：每组 states 数组尾随一个哨兵槽，
            // 下面要读它来核对哨兵模型。按 stateCount 算会让哨兵读取越出已校验范围。
            if (statesRel < 0 || statesAbs + (stateCount + 1) * StateEntrySize > source.Length)
                throw new InvalidDataException(
                    $"ESD 状态组 {groupId} 状态表越界：relOffset={statesRel}, count={stateCount}"
                    + "（含尾随哨兵槽共 count+1 条记录）。");

            var stateIds = new long[checked((int)stateCount)];
            for (var s = 0; s < (int)stateCount; s++)
            {
                var sOff = checked((int)(statesAbs + (long)s * StateEntrySize));
                var stateId = ReadInt64(source, sOff);
                stateIds[s] = stateId;

                // ── Condition offset array ──
                var condArrRel = ReadInt64(source, sOff + 0x08);
                var condArrCount = ReadInt64(source, sOff + 0x10);
                if (condArrRel >= 0 && condArrCount > 0)
                {
                    var condArrAbs = DataStart + condArrRel;
                    if (condArrAbs + condArrCount * 8 > source.Length)
                        throw new InvalidDataException(
                            $"ESD 状态 {stateId} 条件偏移数组越界。");
                    for (var c = 0; c < (int)condArrCount; c++)
                    {
                        var condRel = ReadInt64(source, checked((int)(condArrAbs + (long)c * 8)));
                        ParseCondition(source, condRel, 0,
                            visitedConditions, visitedCalls, visitedArgs, banks, bytecode);
                    }
                }

                // ── Entry / Exit / While command arrays ──
                ParseCommandArray(source,
                    ReadInt64(source, sOff + 0x18), ReadInt64(source, sOff + 0x20),
                    visitedCalls, visitedArgs, banks, bytecode);
                ParseCommandArray(source,
                    ReadInt64(source, sOff + 0x28), ReadInt64(source, sOff + 0x30),
                    visitedCalls, visitedArgs, banks, bytecode);
                ParseCommandArray(source,
                    ReadInt64(source, sOff + 0x38), ReadInt64(source, sOff + 0x40),
                    visitedCalls, visitedArgs, banks, bytecode);

                totalParsedStates++;
            }

            // ── 尾随哨兵槽 ──
            // 索引 stateCount 处还有一条 State 记录，头 0x30 把它计入总数。它实测
            // 恒为本组 slot 0 的逐字节副本、且其偏移不被任何字段引用，因此**不计入
            // 语义状态**（计入会让每组首状态重复一次），只计入记录数以对齐 0x30。
            // 逐组核对副本关系：不成立就说明这一槽携带独有数据，哨兵模型失效。
            var sentinelOff = checked((int)(statesAbs + stateCount * StateEntrySize));
            var slot0Off = checked((int)statesAbs);
            if (!source.AsSpan(sentinelOff, StateEntrySize)
                    .SequenceEqual(source.AsSpan(slot0Off, StateEntrySize)))
            {
                sentinelDivergent.Add(groupId);
            }
            totalStateRecords += checked((int)stateCount + 1);

            stateGroups.Add(new EsdStateGroupInfo(groupId, checked((int)stateCount), stateIds));
        }

        return new EsdNativeDocument(
            source, version, dataSize,
            declaredStateGroupCount, declaredStateCount,
            declaredConditionCount, declaredCommandCallCount, declaredCommandArgCount,
            stateGroups, totalParsedStates, totalStateRecords, sentinelDivergent,
            visitedConditions.Count, visitedCalls.Count, visitedArgs.Count,
            banks.ToArray(), bytecode);
    }

    public static EsdNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("ESD 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"ESD 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    // ══════════════════════════════════════════════════════════════
    //  Recursive condition / command parsing
    // ══════════════════════════════════════════════════════════════

    private static void ParseCondition(
        byte[] source,
        long condRelOffset,
        int depth,
        HashSet<long> visitedConditions,
        HashSet<long> visitedCalls,
        HashSet<long> visitedArgs,
        SortedSet<int> banks,
        List<EsdBytecodeRegion> bytecode)
    {
        if (condRelOffset < 0) return; // −1 sentinel
        if (depth > MaxConditionDepth)
            throw new InvalidDataException($"ESD 条件嵌套深度超过 {MaxConditionDepth}。");

        var abs = DataStart + condRelOffset;
        if (abs + ConditionEntrySize > source.Length)
            throw new InvalidDataException($"ESD 条件偏移 {condRelOffset}（绝对 {abs}）越界。");
        if (!visitedConditions.Add(abs)) return; // already parsed (shared condition)

        var a = checked((int)abs);
        // +0x00: targetStateOffset (graph edge, not followed)
        var passCmdRel = ReadInt64(source, a + 0x08);
        var passCmdCount = ReadInt64(source, a + 0x10);
        var subcondRel = ReadInt64(source, a + 0x18);
        var subcondCount = ReadInt64(source, a + 0x20);
        var evalRel = ReadInt64(source, a + 0x28);
        var evalLength = ReadInt64(source, a + 0x30);

        // Evaluator bytecode region (opaque)
        if (evalRel >= 0 && evalLength > 0)
        {
            var evalAbs = DataStart + evalRel;
            if (evalAbs + evalLength > source.Length)
                throw new InvalidDataException(
                    $"ESD 条件表达式字节码越界：offset={evalAbs}, length={evalLength}。");
            bytecode.Add(new EsdBytecodeRegion(evalAbs, checked((int)evalLength), "evaluator"));
        }

        // Pass commands
        ParseCommandArray(source, passCmdRel, passCmdCount,
            visitedCalls, visitedArgs, banks, bytecode);

        // Sub-conditions (recursive)
        if (subcondRel >= 0 && subcondCount > 0)
        {
            var subAbs = DataStart + subcondRel;
            if (subAbs + subcondCount * 8 > source.Length)
                throw new InvalidDataException(
                    $"ESD 子条件偏移数组越界：offset={subAbs}, count={subcondCount}。");
            for (var i = 0; i < (int)subcondCount; i++)
            {
                var childRel = ReadInt64(source, checked((int)(subAbs + (long)i * 8)));
                ParseCondition(source, childRel, depth + 1,
                    visitedConditions, visitedCalls, visitedArgs, banks, bytecode);
            }
        }
    }

    private static void ParseCommandArray(
        byte[] source,
        long relOffset,
        long count,
        HashSet<long> visitedCalls,
        HashSet<long> visitedArgs,
        SortedSet<int> banks,
        List<EsdBytecodeRegion> bytecode)
    {
        if (relOffset < 0 || count <= 0) return; // −1 sentinel or empty

        var abs = DataStart + relOffset;
        if (abs + count * CommandCallEntrySize > source.Length)
            throw new InvalidDataException(
                $"ESD 命令调用数组越界：offset={abs}, count={count}。");

        for (var i = 0; i < (int)count; i++)
        {
            var cOff = checked((int)(abs + (long)i * CommandCallEntrySize));
            if (!visitedCalls.Add(cOff)) continue; // shared call, already counted

            var bank = ReadInt32(source, cOff);
            // +0x04: commandID (read but only bank is aggregated)
            var argsRel = ReadInt64(source, cOff + 0x08);
            var argsCount = ReadInt64(source, cOff + 0x10);

            banks.Add(bank);

            if (argsRel < 0 || argsCount <= 0) continue;

            var argsAbs = DataStart + argsRel;
            if (argsAbs + argsCount * CommandArgEntrySize > source.Length)
                throw new InvalidDataException(
                    $"ESD 命令参数数组越界：offset={argsAbs}, count={argsCount}。");

            for (var a = 0; a < (int)argsCount; a++)
            {
                var aOff = checked((int)(argsAbs + (long)a * CommandArgEntrySize));
                if (!visitedArgs.Add(aOff)) continue;

                var bcRel = ReadInt64(source, aOff);
                var bcSize = ReadInt64(source, aOff + 0x08);

                if (bcRel >= 0 && bcSize > 0)
                {
                    var bcAbs = DataStart + bcRel;
                    if (bcAbs + bcSize > source.Length)
                        throw new InvalidDataException(
                            $"ESD 参数表达式字节码越界：offset={bcAbs}, size={bcSize}。");
                    bytecode.Add(new EsdBytecodeRegion(bcAbs, checked((int)bcSize), "commandArg"));
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  Round-trip verification (read-only: re-parse same bytes)
    // ══════════════════════════════════════════════════════════════

    public EsdRoundTripReport VerifyRoundTrip()
    {
        var reparsed = Read(SourceBytes);
        var semanticIdentical =
            reparsed.Version == Version
            && reparsed.DeclaredStateGroupCount == DeclaredStateGroupCount
            && reparsed.DeclaredStateCount == DeclaredStateCount
            && reparsed.DeclaredConditionCount == DeclaredConditionCount
            && reparsed.DeclaredCommandCallCount == DeclaredCommandCallCount
            && reparsed.DeclaredCommandArgCount == DeclaredCommandArgCount
            && reparsed.ParsedStateCount == ParsedStateCount
            && reparsed.ParsedStateRecordCount == ParsedStateRecordCount
            && reparsed.SentinelDivergentGroupIds.SequenceEqual(SentinelDivergentGroupIds)
            && reparsed.ParsedConditionCount == ParsedConditionCount
            && reparsed.ParsedCommandCallCount == ParsedCommandCallCount
            && reparsed.ParsedCommandArgCount == ParsedCommandArgCount
            && reparsed.CommandBanks.SequenceEqual(CommandBanks)
            && reparsed.StateGroups.Count == StateGroups.Count
            && reparsed.StateGroups.Zip(StateGroups).All(pair =>
                pair.First.GroupId == pair.Second.GroupId
                && pair.First.StateCount == pair.Second.StateCount
                && pair.First.StateIds.AsSpan().SequenceEqual(pair.Second.StateIds));

        return new EsdRoundTripReport(
            true, // byte-identical: same source bytes, no mutation
            semanticIdentical,
            SourceHash,
            Hash(SourceBytes),
            StateGroups.Count,
            ParsedStateCount,
            ParsedStateRecordCount,
            ParsedConditionCount,
            ParsedCommandCallCount,
            ParsedCommandArgCount);
    }

    // ══════════════════════════════════════════════════════════════
    //  Envelope
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// 声明量与实解析量的差值。四对计数此前双双导出却从不比较——declared=500
    /// 而 parsed=3 时 SemanticIdentical 仍为真（它拿同一份字节解析两遍自比，
    /// parser 确定性下恒真），上层照样发 ESD_DOCUMENT_ROUNDTRIP_VERIFIED，
    /// 而消息体里还把 parsed 的 3 插在「验证通过」后面。覆盖率数据在手却没
    /// 变成判据。
    ///
    /// 判据刻意定在**独立字段 + 诊断码 + authority**，不并进 SemanticIdentical：
    /// 后者管的是「同一份字节解析两遍是否一致」（parser 确定性），与「解析
    /// 得是否完整」是正交语义。混进去会让往返确定性这个概念失去意义。
    /// </summary>
    ///
    /// <para>states 一项比的是 <see cref="ParsedStateRecordCount"/>（物理记录数），
    /// 因为 0x30 计的就是记录数——详见类型注释。语义状态数
    /// （<see cref="ParsedStateCount"/>）与 0x30 天然差一个 stateGroupCount，
    /// 拿它去比会恒定报红。哨兵模型本身由
    /// <see cref="StateRecordModelConsistent"/> 独立守着，没有失去检出能力。</para>
    public bool CoverageComplete =>
        ParsedStateRecordCount == DeclaredStateCount
        && StateRecordModelConsistent
        && ParsedConditionCount == DeclaredConditionCount
        && ParsedCommandCallCount == DeclaredCommandCallCount
        && ParsedCommandArgCount == DeclaredCommandArgCount;

    /// <summary>
    /// 哨兵模型是否成立：每组尾随槽都是本组 slot 0 的逐字节副本。
    /// 不成立说明那一槽携带独有数据（即它其实是个真状态），语义状态数就少算了。
    /// </summary>
    public bool StateRecordModelConsistent => SentinelDivergentGroupIds.Count == 0;

    /// <summary>逐项列出未解析完整的计数，供诊断引用。</summary>
    public string[] CoverageShortfalls()
    {
        var gaps = new List<string>();
        if (ParsedStateRecordCount != DeclaredStateCount)
            gaps.Add($"stateRecords declared={DeclaredStateCount} parsed={ParsedStateRecordCount}"
                + $"（语义状态 {ParsedStateCount} + 每组尾随哨兵 {StateGroups.Count}）");
        if (!StateRecordModelConsistent)
            gaps.Add("stateSentinelModel 失效：以下状态组的尾随槽不是本组 slot 0 的副本，"
                + "该槽可能是未被计入的真实状态 → groupIds="
                + string.Join(",", SentinelDivergentGroupIds.Take(20))
                + (SentinelDivergentGroupIds.Count > 20 ? $" …共 {SentinelDivergentGroupIds.Count} 组" : ""));
        if (ParsedConditionCount != DeclaredConditionCount)
            gaps.Add($"conditions declared={DeclaredConditionCount} parsed={ParsedConditionCount}");
        if (ParsedCommandCallCount != DeclaredCommandCallCount)
            gaps.Add($"commandCalls declared={DeclaredCommandCallCount} parsed={ParsedCommandCallCount}");
        if (ParsedCommandArgCount != DeclaredCommandArgCount)
            gaps.Add($"commandArgs declared={DeclaredCommandArgCount} parsed={ParsedCommandArgCount}");
        return gaps.ToArray();
    }

    public object ToEnvelope(EsdRoundTripReport? report = null)
    {
        report ??= VerifyRoundTrip();
        const int sampleLimit = 10;
        return new
        {
            format = "ESD",
            version = Version,
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            stateGroupCount = DeclaredStateGroupCount,
            // ⚠️ 裸名 conditionCount/commandCallCount/... 携带的是**声明量**，而
            // EsdWorkbenchPanel.tsx:51 把它显示成「N conds」。只解析出 3 个而声明
            // 500 时，界面会说 500——违反硬约束 7（界面必须能回答「已解析多少」）。
            // 裸名保留以兼容既有消费方，同时补 declared* 显式名与 parsed* 对照，
            // UI 应改用后两组。
            //
            // 裸名 stateCount 是例外：它此前挂 DeclaredStateCount，于是面板把 659 个
            // 真实状态显示成 707——那 48 是每组的尾随哨兵槽，不是状态。这里改挂
            // **语义状态数**，与它下方 stateGroups[].stateCount（同样是语义数）单位
            // 一致，也与面板「状态数」的字面含义一致。声明量仍可由 declaredStateCount
            // 取到，未丢信息。
            stateCount = ParsedStateCount,
            conditionCount = DeclaredConditionCount,
            commandCallCount = DeclaredCommandCallCount,
            commandArgCount = DeclaredCommandArgCount,
            declaredStateGroupCount = DeclaredStateGroupCount,
            declaredStateCount = DeclaredStateCount,
            declaredConditionCount = DeclaredConditionCount,
            declaredCommandCallCount = DeclaredCommandCallCount,
            declaredCommandArgCount = DeclaredCommandArgCount,
            // parsedStateCount 是语义状态数；parsedStateRecordCount 是与 0x30 同单位的
            // 物理记录数（含每组尾随哨兵）。两者相差恰好 stateGroupCount。
            parsedStateCount = ParsedStateCount,
            parsedStateRecordCount = ParsedStateRecordCount,
            stateSentinelPerGroup = 1,
            stateSentinelModelConsistent = StateRecordModelConsistent,
            stateSentinelDivergentGroupIds = SentinelDivergentGroupIds,
            parsedConditionCount = ParsedConditionCount,
            parsedCommandCallCount = ParsedCommandCallCount,
            parsedCommandArgCount = ParsedCommandArgCount,
            stateGroups = StateGroups.Take(sampleLimit).Select(g => new
            {
                groupId = g.GroupId,
                stateCount = g.StateCount
            }).ToArray(),
            stateGroupsTruncated = StateGroups.Count > sampleLimit,
            commandBanks = CommandBanks,
            bytecodeRegionCount = BytecodeRegions.Count,
            coverageComplete = CoverageComplete,
            coverageShortfalls = CoverageShortfalls(),
            roundTrip = report,
            // 解析不完整时不得停留在 candidate——candidate 表示「结构已认出、
            // 待真实语料确认」，而「声明 500 只读出 3」是另一回事：那是解析
            // 覆盖面残缺，必须降到 partial 并附结构化诊断（硬约束 8）。
            //
            // 上限就是 candidate：ESD 是 user-approved 的 V0.6 延期项
            // （scope.json SCOPE-BEHAVIOR-ESD，authorityAtRuling=candidate）。
            // 计数对齐只说明**结构计数**已闭合，不构成表达式 schema、writer 或
            // 真实游戏加载的验证——RPN 字节码仍按不透明 (offset,length) 上报。
            authority = CoverageComplete ? "candidate" : "partial"
        };
    }

    // ══════════════════════════════════════════════════════════════
    //  Binary helpers
    // ══════════════════════════════════════════════════════════════

    private static void ValidateConst(byte[] source, int offset, int expected, string name)
    {
        var actual = ReadInt32(source, offset);
        if (actual != expected)
            throw new InvalidDataException(
                $"ESD {name} 0x{actual:X} 不匹配；期望 0x{expected:X}。");
    }

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static long ReadInt64(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

// ── Records ──

internal sealed record EsdStateGroupInfo(
    long GroupId,
    int StateCount,
    long[] StateIds);

internal sealed record EsdBytecodeRegion(
    long AbsoluteOffset,
    int Length,
    string Kind);

internal sealed record EsdRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int StateGroupCount,
    int StateCount,
    int StateRecordCount,
    int ConditionCount,
    int CommandCallCount,
    int CommandArgCount);

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
/// <para><b>解析到哪一层：状态机图已构建，RPN 字节码仍不解码。</b>
/// 本解析器认出 state group → state → condition → command call 的结构与计数，
/// 并在 2026-08-08 按**用户裁定**（ESD 由 deferred 改回 supported）补齐两处此前
/// 读都没读的字段区间：
/// <list type="bullet">
///   <item>condition 的 <c>+0x00 targetStateOffset</c>（跳转目标）——现已跟随并解析成
///     (groupId, stateId)，四态判定见 ResolveEdges。此前「节点全解析、一条边没连」。</item>
///   <item>command call 的 <c>+0x04 commandID</c>——现已读出，并按 entry / exit /
///     while / condition-pass 分槽上报。此前只聚合 <c>bank</c>，命令身份无从回答。</item>
/// </list>
///
/// 真实语料验证（192 个 .esd / 4894 个 state group / 41467 个 condition，
/// 经生产命令 read-esd-document 复核，与独立字节量测逐项一致）：
/// 转移边 41467 条 = resolved 30893 + none(−1) 10574，**悬空 0、指向哨兵 0**，
/// 192/192 文件跳转图闭合；命令调用 23626 条（entry/exit/while/condition-pass 四槽），
/// commandID 取值跨度极大（−1、小整数 11/39/40/68/101/103，以及接近 int.MaxValue 的
/// 2147483642/3/6），故实现**不做任何范围假设**，原样上报。
///
/// <b>仍不解码的是 RPN 字节码</b>（condition evaluator 与 command 参数体），
/// 按不透明 (offset, length) 上报——scope.json 的 resumeRequires 里
/// 「未知表达式或命令不得重编码」是**永久禁令**，不解码是刻意的，但必须可见：
/// 它登记在 <see cref="UnparsedGaps"/> 里并压 authority 至 partial。
///
/// <b>写能力仍未开放</b>：<c>any-esd-write-in-v05</c> 与 <c>raw-hex-write</c> 属
/// unsupportedOperations，且开放前需要条件表达式与命令块的未知字段无损往返证据。
/// 本轮只做只读解析，不碰 writer。
///
/// <b>两类缺口刻意分开，不合并进 <see cref="CoverageShortfalls"/></b>：后者表示
/// 「声明量与实解析量不符」= 数据可疑或 parser 漏读；<see cref="UnparsedGaps"/>
/// 表示「这一段刻意不解码」= 能力边界。混在一起会让「结构性未实现」看起来像
/// 「解析出错」，下一个人会去修一个不存在的 bug。</para>
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
    private const int MaxConditionSamples = 200;

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
        IReadOnlyList<EsdBytecodeRegion> bytecodeRegions,
        IReadOnlyList<EsdTransitionEdge> transitionEdges,
        IReadOnlyList<EsdCommandCall> commandCalls,
        IReadOnlyList<EsdConditionInfo> conditionInfos)
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
        TransitionEdges = transitionEdges;
        CommandCalls = commandCalls;
        ConditionInfos = conditionInfos;
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

    /// <summary>状态转移边（condition 的 targetStateOffset 跟随结果）。四态见 ResolveEdges。</summary>
    public IReadOnlyList<EsdTransitionEdge> TransitionEdges { get; }

    /// <summary>命令调用（含此前未读的 commandID），按 entry/exit/while/condition-pass 分槽。</summary>
    public IReadOnlyList<EsdCommandCall> CommandCalls { get; }

    /// <summary>
    /// 每个唯一 condition 一行的轻量明细（相对偏移、跳转目标、子条件数、evaluator 长度、
    /// condition-pass 命令数）。行数与 <see cref="ParsedConditionCount"/> 一致——两者都
    /// 在 visitedConditions 去重后登记，共享 condition 只占一行。供工作台条件页做
    /// bounded 列表，只携带元数据，不含 evaluator/命令参数体的字节内容。
    /// </summary>
    public IReadOnlyList<EsdConditionInfo> ConditionInfos { get; }

    /// <summary>悬空目标的边：既非 −1 也不落在任何语义 state 记录起点上。</summary>
    public IReadOnlyList<EsdTransitionEdge> DanglingEdges =>
        TransitionEdges.Where(e => e.Resolution == "dangling").ToArray();

    /// <summary>指向尾随哨兵槽的边。实测应为空；非空说明哨兵被当成可跳转状态。</summary>
    public IReadOnlyList<EsdTransitionEdge> SentinelTargetEdges =>
        TransitionEdges.Where(e => e.Resolution == "sentinel").ToArray();

    /// <summary>
    /// 跳转图是否闭合：没有悬空目标、也没有指向哨兵的边。
    /// scope.json 的 resumeRequires 要求「跳转关系要能构成闭合图并检出悬空目标」，
    /// 这个属性就是那条要求的可判定形式。
    /// </summary>
    public bool TransitionGraphClosed =>
        DanglingEdges.Count == 0 && SentinelTargetEdges.Count == 0;

    public string SourceHash => Hash(SourceBytes);

    /// <summary>
    /// **本版刻意未解析的字段区间**（能力边界，不是解析错误）。详见类型注释。
    ///
    /// 与 <see cref="CoverageShortfalls"/> 的区别是语义而非程度：那里是「声明量与
    /// 实解析量不符」= 数据可疑；这里是「这段本版就没读」= 范围边界。两者混报会让
    /// 结构性未实现看起来像 parser 出错，把下一个人引向修一个不存在的 bug。
    ///
    /// 为什么用**计算属性**而不是解析时累积的集合：这两处缺口是**结构性**的
    /// ——只要文件里存在 condition / command call，对应字段就必然未被读取，
    /// 不存在「这个文件读了、那个文件没读」。用可变集合累积反而会引入
    /// 「探测过才可见」的时序陷阱（FLVER 就为此专门加了 EnsureVertexSemanticGapsProbed：
    /// 缺口在取顶点数据时才登记，authority 若先被读取就会把「没探测过」
    /// 误报成「没有缺口」）。这里没有那个时序问题，所以不引入它。
    /// </summary>
    public string[] UnparsedGaps()
    {
        var gaps = new List<string>();
        // ⚠️ 原先这里登记两条缺口：「targetStateOffset 未跟随」与「commandID 未读」。
        // 两者**已在 2026-08-08 按用户裁定实现**（ESD 由 deferred 改回 supported），
        // 故不再登记——留着就是把已交付能力报成缺口。
        //
        // 剩下的真实缺口只有一条：命令参数体的 RPN 字节码不解码。它与 condition 的
        // evaluator 字节码同一性质（按不透明 (offset, length) 上报），
        // 且 resumeRequires 里「未知表达式或命令不得重编码」是**永久禁令**——
        // 不解码是刻意的，但必须可见。
        if (BytecodeRegions.Count > 0)
        {
            var totalBytes = BytecodeRegions.Sum(r => (long)r.Length);
            gaps.Add($"bytecode:RPN 字节码不解码（condition evaluator 与 command 参数体，"
                + $"按不透明 (offset,length) 上报）；regions={BytecodeRegions.Count}, bytes={totalBytes}");
        }
        return gaps.ToArray();
    }

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
        var edges = new List<EsdTransitionEdge>();
        var commandCalls = new List<EsdCommandCall>();
        var conditionInfos = new List<EsdConditionInfo>();
        // state 相对偏移 → (groupId, stateId)。转移边的目标是**相对偏移**，
        // 解析成状态需要这张表；表只能在全部 group 遍历完后才完整，
        // 所以边先记原始偏移，最后统一解析（见 ResolveEdges）。
        var stateByRelOffset = new Dictionary<long, (long GroupId, long StateId)>();
        var sentinelRelOffsets = new HashSet<long>();

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
                // 登记「相对偏移 → 状态」。哨兵槽刻意**不登记**（见下方哨兵段）：
                // 实测 30893 个非 −1 目标从不指向哨兵，若把哨兵也登记进来，
                // 「目标指向哨兵」这种异常就会被悄悄当成正常解析。
                stateByRelOffset[statesRel + (long)s * StateEntrySize] = (groupId, stateId);

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
                            visitedConditions, visitedCalls, visitedArgs, banks, bytecode, conditionInfos,
                            groupId, statesRel + (long)s * StateEntrySize, edges, commandCalls);
                    }
                }

                // ── Entry / Exit / While command arrays ──
                // slot 名跟随规范里的三个槽位，便于消费方区分「进入状态时执行」与
                // 「离开时执行」——只报总数会丢掉这个区别。
                var ownerStateRel = statesRel + (long)s * StateEntrySize;
                ParseCommandArray(source,
                    ReadInt64(source, sOff + 0x18), ReadInt64(source, sOff + 0x20),
                    visitedCalls, visitedArgs, banks, bytecode,
                    groupId, ownerStateRel, "entry", commandCalls);
                ParseCommandArray(source,
                    ReadInt64(source, sOff + 0x28), ReadInt64(source, sOff + 0x30),
                    visitedCalls, visitedArgs, banks, bytecode,
                    groupId, ownerStateRel, "exit", commandCalls);
                ParseCommandArray(source,
                    ReadInt64(source, sOff + 0x38), ReadInt64(source, sOff + 0x40),
                    visitedCalls, visitedArgs, banks, bytecode,
                    groupId, ownerStateRel, "while", commandCalls);

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
            sentinelRelOffsets.Add(statesRel + stateCount * StateEntrySize);
            totalStateRecords += checked((int)stateCount + 1);

            stateGroups.Add(new EsdStateGroupInfo(groupId, checked((int)stateCount), stateIds));
        }

        // 全部 state 就位后再解析转移边目标，并检出悬空目标。
        var resolvedEdges = ResolveEdges(edges, stateByRelOffset, sentinelRelOffsets);

        return new EsdNativeDocument(
            source, version, dataSize,
            declaredStateGroupCount, declaredStateCount,
            declaredConditionCount, declaredCommandCallCount, declaredCommandArgCount,
            stateGroups, totalParsedStates, totalStateRecords, sentinelDivergent,
            visitedConditions.Count, visitedCalls.Count, visitedArgs.Count,
            banks.ToArray(), bytecode, resolvedEdges, commandCalls, conditionInfos);
    }

    /// <summary>
    /// 把转移边的目标**相对偏移**解析成 (groupId, stateId)，并给出四态判定。
    ///
    /// 四态刻意分开而不是布尔「有效/无效」——四种情形的处置完全不同：
    ///   · <c>none</c>      目标为 −1：本条件不跳转。这是**正常形态**，实测占 10574/41467。
    ///   · <c>resolved</c>  命中某个语义 state 记录的起点。实测 30893/30893 非 −1 目标全部如此。
    ///   · <c>sentinel</c>  命中某组的尾随哨兵槽。实测**零命中**；真出现说明哨兵被当成
    ///                      可跳转状态，那会让状态机多出一个本不存在的节点。
    ///   · <c>dangling</c>  既非 −1 也不落在任何 state 记录起点上：**悬空目标**。
    ///                      scope.json 的 resumeRequires 明确要求「跳转关系要能构成闭合图
    ///                      并检出悬空目标，否则写入会破坏状态机可达性」——这一态就是那道检出。
    ///
    /// 判据用「起点精确命中」而不是「落在 state 区间内」：偏移指到某条 state 记录的
    /// 中间（例如差 8 字节）在字节上仍属该区间，但那是错位引用，按区间判会把它当成
    /// 正常边放过去。实测 30893 个目标全部精确命中起点，说明精确判据不会误伤。
    /// </summary>
    private static IReadOnlyList<EsdTransitionEdge> ResolveEdges(
        List<EsdTransitionEdge> edges,
        Dictionary<long, (long GroupId, long StateId)> stateByRelOffset,
        HashSet<long> sentinelRelOffsets)
    {
        var resolved = new List<EsdTransitionEdge>(edges.Count);
        foreach (var edge in edges)
        {
            if (edge.TargetStateRelOffset < 0)
            {
                resolved.Add(edge with { Resolution = "none" });
                continue;
            }
            if (stateByRelOffset.TryGetValue(edge.TargetStateRelOffset, out var hit))
            {
                resolved.Add(edge with
                {
                    TargetGroupId = hit.GroupId,
                    TargetStateId = hit.StateId,
                    Resolution = "resolved"
                });
                continue;
            }
            if (sentinelRelOffsets.Contains(edge.TargetStateRelOffset))
            {
                resolved.Add(edge with { Resolution = "sentinel" });
                continue;
            }
            resolved.Add(edge with { Resolution = "dangling" });
        }
        return resolved;
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
        List<EsdBytecodeRegion> bytecode,
        List<EsdConditionInfo> conditionInfos,
        long ownerGroupId,
        long ownerStateRelOffset,
        List<EsdTransitionEdge> edges,
        List<EsdCommandCall> commandCalls)
    {
        if (condRelOffset < 0) return; // −1 sentinel
        if (depth > MaxConditionDepth)
            throw new InvalidDataException($"ESD 条件嵌套深度超过 {MaxConditionDepth}。");

        var abs = DataStart + condRelOffset;
        if (abs + ConditionEntrySize > source.Length)
            throw new InvalidDataException($"ESD 条件偏移 {condRelOffset}（绝对 {abs}）越界。");
        if (!visitedConditions.Add(abs)) return; // already parsed (shared condition)

        var a = checked((int)abs);
        // +0x00: targetStateOffset —— 跳转目标（状态转移边的终点），现已跟随。
        //
        // 语义依据（2026-08-08 真实语料实测，192 个 .esd / 4894 个 state group /
        // 41467 个 condition）：非 −1 的目标共 30893 个，**100% 命中语义 state 记录的
        // 相对偏移**，悬空 0 个，且**从不指向尾随哨兵槽**（哨兵不可达这条独立结论因此
        // 又被交叉印证一次）。−1 共 10574 个，是「本条件不跳转」的哨兵。
        //
        // 目标解析（相对偏移 → groupId/stateId）不在这里做：此刻 state 表还在构建中，
        // 无法把偏移映射回状态。故先原样记录 targetStateRelOffset，
        // 由 ResolveEdges 在全部 state 就位后统一解析并检出悬空目标。
        var targetStateRel = ReadInt64(source, a + 0x00);
        edges.Add(new EsdTransitionEdge(
            ownerGroupId, ownerStateRelOffset, condRelOffset, targetStateRel,
            // 下面三项在 ResolveEdges 里回填。
            TargetGroupId: null, TargetStateId: null, Resolution: "pending"));

        var passCmdRel = ReadInt64(source, a + 0x08);
        var passCmdCount = ReadInt64(source, a + 0x10);
        var subcondRel = ReadInt64(source, a + 0x18);
        var subcondCount = ReadInt64(source, a + 0x20);
        var evalRel = ReadInt64(source, a + 0x28);
        var evalLength = ReadInt64(source, a + 0x30);

        // ── Condition 明细行（只登记已读出的元数据，不改变任何解析语义）──
        // 与 visitedConditions 同生命周期：每个唯一 condition 恰好一行，
        // 因此行数恒等于 ParsedConditionCount。evaluator 与命令参数体仍按
        // 不透明 (offset, length) 上报，这里只带长度计数，不含字节内容。
        conditionInfos.Add(new EsdConditionInfo(
            condRelOffset, ownerGroupId, ownerStateRelOffset, targetStateRel,
            checked((int)Math.Max(0, subcondCount)),
            checked((int)Math.Max(0, evalLength)),
            checked((int)Math.Max(0, passCmdCount))));

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
            visitedCalls, visitedArgs, banks, bytecode,
            ownerGroupId, ownerStateRelOffset, "condition-pass", commandCalls);

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
                    visitedConditions, visitedCalls, visitedArgs, banks, bytecode, conditionInfos,
                    ownerGroupId, ownerStateRelOffset, edges, commandCalls);
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
        List<EsdBytecodeRegion> bytecode,
        long ownerGroupId,
        long ownerStateRelOffset,
        string slot,
        List<EsdCommandCall> commandCalls)
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
            // +0x04: commandID —— 现已读出。
            //
            // 此处原有一句注释写「read but only bank is aggregated」，那句话是**错的**：
            // 代码从未对 cOff + 0x04 发起读取，不是「读了但没聚合」。注释自称读过而
            // 实际没读比不写注释更有害——它让审阅者以为字段已在手、只差往外导。
            // 保留这段说明是为了防同一处再次退化，不是为了记录历史。
            //
            // 实测取值范围很宽：真实语料里既有小整数（bank 1 的 11/19/62/103/130…），
            // 也有接近 int.MaxValue 的值（bank 6 的 2147483613/2147483614/2147483643/
            // 2147483647），还有 −1（bank 7）。所以**不做任何范围假设**，原样上报。
            var commandId = ReadInt32(source, cOff + 0x04);
            var argsRel = ReadInt64(source, cOff + 0x08);
            var argsCount = ReadInt64(source, cOff + 0x10);

            banks.Add(bank);
            commandCalls.Add(new EsdCommandCall(
                ownerGroupId, ownerStateRelOffset, slot, bank, commandId,
                checked((int)Math.Max(0, argsCount))));

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
            // ── 条件明细页（bounded：按 conditionRelOffset 排序取前 MaxConditionSamples 行）──
            // 行数恒等于 parsedConditionCount（同一 visitedConditions 去重生命周期）；
            // 只携带元数据，不含 evaluator 字节。工作台条件页用它做列表；
            // 完整分页需按当前治理承接分页 channel。
            conditionSamples = ConditionInfos
                .OrderBy(c => c.ConditionRelOffset)
                .Take(MaxConditionSamples)
                .Select(c => new
                {
                    conditionRelOffset = c.ConditionRelOffset,
                    sourceGroupId = c.SourceGroupId,
                    sourceStateRelOffset = c.SourceStateRelOffset,
                    targetStateRelOffset = c.TargetStateRelOffset,
                    subConditionCount = c.SubConditionCount,
                    evaluatorLength = c.EvaluatorLength,
                    passCommandCount = c.PassCommandCount
                }).ToArray(),
            conditionSamplesTruncated = ConditionInfos.Count > MaxConditionSamples,
            // ── 状态转移图（此前整体缺失：节点全解析、一条边没连）──
            transitionGraph = new
            {
                edgeCount = TransitionEdges.Count,
                // 四态各自计数：none 是正常的「不跳转」，不是缺陷。
                resolved = TransitionEdges.Count(e => e.Resolution == "resolved"),
                none = TransitionEdges.Count(e => e.Resolution == "none"),
                sentinel = SentinelTargetEdges.Count,
                dangling = DanglingEdges.Count,
                closed = TransitionGraphClosed,
                // 悬空与哨兵目标必须能被定位到具体条件，否则「有 N 条悬空」无法排查。
                danglingSamples = DanglingEdges.Take(sampleLimit).Select(e => new
                {
                    sourceGroupId = e.SourceGroupId,
                    sourceStateRelOffset = e.SourceStateRelOffset,
                    conditionRelOffset = e.ConditionRelOffset,
                    targetStateRelOffset = e.TargetStateRelOffset
                }).ToArray(),
                sentinelSamples = SentinelTargetEdges.Take(sampleLimit).Select(e => new
                {
                    sourceGroupId = e.SourceGroupId,
                    conditionRelOffset = e.ConditionRelOffset,
                    targetStateRelOffset = e.TargetStateRelOffset
                }).ToArray(),
                edges = TransitionEdges.Take(sampleLimit).Select(e => new
                {
                    sourceGroupId = e.SourceGroupId,
                    conditionRelOffset = e.ConditionRelOffset,
                    targetGroupId = e.TargetGroupId,
                    targetStateId = e.TargetStateId,
                    resolution = e.Resolution
                }).ToArray(),
                edgesTruncated = TransitionEdges.Count > sampleLimit
            },
            // ── 命令调用（含此前未读的 commandID）──
            commandCalls = new
            {
                total = CommandCalls.Count,
                distinctCommandIds = CommandCalls.Select(c => c.CommandId).Distinct().Count(),
                // 按槽位分布：只报总数会丢掉 entry/exit/while 的区别。
                bySlot = CommandCalls.GroupBy(c => c.Slot)
                    .OrderBy(g => g.Key, StringComparer.Ordinal)
                    .Select(g => new { slot = g.Key, count = g.Count() }).ToArray(),
                samples = CommandCalls.Take(sampleLimit).Select(c => new
                {
                    sourceGroupId = c.SourceGroupId,
                    slot = c.Slot,
                    bank = c.Bank,
                    commandId = c.CommandId,
                    argCount = c.ArgCount
                }).ToArray(),
                samplesTruncated = CommandCalls.Count > sampleLimit
            },
            coverageComplete = CoverageComplete,
            coverageShortfalls = CoverageShortfalls(),
            // 本版刻意未解析的字段区间。与 coverageShortfalls 分列（一个是能力边界、
            // 一个是数据可疑），两者都会压 authority 但指向完全不同的处置。
            unparsedGaps = UnparsedGaps(),
            roundTrip = report,
            // 解析不完整时不得停留在 candidate——candidate 表示「结构已认出、
            // 待真实语料确认」，而「声明 500 只读出 3」是另一回事：那是解析
            // 覆盖面残缺，必须降到 partial 并附结构化诊断（硬约束 8）。
            //
            // 上限就是 candidate：ESD 当前仍受 scope.json 的
            // （scope.json SCOPE-BEHAVIOR-ESD，authorityAtRuling=candidate）。
            // 计数对齐只说明**结构计数**已闭合，不构成表达式 schema、writer 或
            // 真实游戏加载的验证——RPN 字节码仍按不透明 (offset,length) 上报。
            //
            // 三条降级依据，缺一条都不足：
            //   ① CoverageComplete：声明量与实解析量一致（数据可疑面）。
            //   ② UnparsedGaps 为空：没有已知未解析结构（能力边界面）。
            //   ③ TransitionGraphClosed：跳转图闭合、无悬空目标（可达性面）。
            // ③ 是本轮新增的必要条件——resumeRequires 明写「跳转关系要能构成闭合图并
            // 检出悬空目标，否则写入会破坏状态机可达性」。图不闭合时即使前两条都成立，
            // 也不能声称结构已认全。
            //
            // 上限仍是 candidate：ESD 虽已由用户裁定改回 supported，但 candidate →
            // native-verified 需要真实语料的往返与游戏加载证据，不由解析完整性推导。
            // RPN 字节码不解码这条缺口恒存在（BytecodeRegions 非空即登记），
            // 所以真实语料下 authority 实际仍为 partial —— 这是如实结论，不是回退。
            authority = CoverageComplete && UnparsedGaps().Length == 0 && TransitionGraphClosed
                ? "candidate"
                : "partial"
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

/// <summary>
/// 一条状态转移边：某个 state 上的某个 condition 指向的跳转目标。
///
/// <paramref name="TargetStateRelOffset"/> 是文件里的原始值（相对 DataStart），
/// 原样保留以便对照字节；<paramref name="TargetGroupId"/> / <paramref name="TargetStateId"/>
/// 是解析结果，仅在 <paramref name="Resolution"/> == "resolved" 时非 null。
/// Resolution 四态：none（−1，不跳转）/ resolved / sentinel / dangling，见 ResolveEdges。
/// </summary>
internal sealed record EsdTransitionEdge(
    long SourceGroupId,
    long SourceStateRelOffset,
    long ConditionRelOffset,
    long TargetStateRelOffset,
    long? TargetGroupId,
    long? TargetStateId,
    string Resolution);

/// <summary>
/// 一条命令调用。<paramref name="Slot"/> 区分 entry / exit / while / condition-pass ——
/// 只报总数会丢掉「进入状态时执行」与「离开时执行」的区别。
/// <paramref name="CommandId"/> 是此前从未读取的 +0x04 字段。
/// 参数体仍按不透明 (offset, length) 上报，这里只带参数个数。
/// </summary>
internal sealed record EsdCommandCall(
    long SourceGroupId,
    long SourceStateRelOffset,
    string Slot,
    int Bank,
    int CommandId,
    int ArgCount);

/// <summary>
/// 一个 condition 的轻量元数据行。只登记解析中已读出的字段，不改变解析语义，
/// 供工作台条件页做 bounded 列表。<paramref name="ConditionRelOffset"/> 是条件记录
/// 的相对偏移（相对 DataStart），是 stable identity，envelope 里按它排序取前 N。
/// </summary>
internal sealed record EsdConditionInfo(
    long ConditionRelOffset,
    long SourceGroupId,
    long SourceStateRelOffset,
    long TargetStateRelOffset,
    int SubConditionCount,
    int EvaluatorLength,
    int PassCommandCount);

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

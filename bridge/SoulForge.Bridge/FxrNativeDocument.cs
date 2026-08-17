using System.Buffers.Binary;
using System.Security.Cryptography;

/// <summary>
/// Sekiro-era FXR3（FFX particle effect）只读原生文档解析器（VFX-54A）。
///
/// 布局依据：121 个真实 Sekiro FXR 样本对拍验证的逆向结论（version 恒为 5，小端，
/// 文件头 0x90）。DS3(v4) 头止于 0x6C，本机未验证 → 见 <see cref="UnparsedGaps"/>。
///
/// 结构总览：14 节（Section1..Section14）+ 递归树。
///   - Section1（0x10/条，count 恒 1）→ Section2 表；
///   - Section2（0x10/条）→ Section3 表；
///   - Section3（0x60/条）→ 两个 Section11 偏移（各 1 个 Int32，float 位模式）；
///   - Section4（0x30/条，递归树节点）→ 子 Section4（紧随父节点）+ Section5/Section6；
///   - Section5（0x20/条）→ Section6 表；
///   - Section6 = FFXDrawEntityHost（0x40/条）→ Section7 属性 ×2 + Section10 + Section11；
///   - Section7 = FFXProperty（0x28/条）→ Section11 + Section8；
///   - Section8（0x20/条）→ Section11 + Section9；
///   - Section9（0x18/条）→ Section11（121 样本全部未出现，布局取自 SoulsFormats）；
///   - Section10（0x10/条）→ Section11；
///   - Section11 = Int32 数组（混合 int/float 位模式，无 schema，按不透明数组上报）；
///   - Section12/13/14 = Sekiro 专属 Int32 数组，样本恒空。
///
/// <b>刻意不解析的区间（能力边界，不是解析错误）：</b>
///   ① Section11 无 schema → 按不透明 int 数组上报，登记
///     <c>section11:opaque-int-array</c> 并降 partial；
///   ② Section9 从未在任何真实样本中实测 → 登记 <c>section9-not-verified</c> + partial；
///   ③ Section12/13/14 真实样本恒空，非空布局未验证 → 登记
///     <c>section12-14-empty-samples-only</c> + partial。
///   这三条刻意与「解析出错」分开：它们表示「这段本版就没读/没验证」，不是数据可疑。
///
/// authority 判据：
///   - magic/version 不对 → NotSupportedException / InvalidDataException（failed）；
///   - 任意 offset 解引用越界 → InvalidDataException（blocked，上抛）；
///   - version ∉ {5} → NotSupportedException（DS3 v4 无真实样本，blocked）；
///   - 节点 type 不在闭集 → unparsedGaps + partial；
///   - 完整 + 无 gap → 上限 candidate（不能推导 native-verified，无 writer、
///     Section11 无 schema）；
///   - 真实语料恒为 partial（Section11 恒有数据 + Section12-14 结构性缺口）。
///
/// 安全上限：文件 ≤ 12MB；Section2/3 ≤ 1,000,000；Section6 ≤ 100,000；
/// FFXProperty ≤ 1,000,000；Section11 总条数 ≤ 1,000,000；Section4 树深 ≤ 64、
/// 总节点 ≤ 100,000；每 host 属性 ≤ 100,000。每个 offset 解引用前验证
/// <c>0 &lt;= offset &amp;&amp; offset + count×size &lt;= fileLength</c>。
/// 本格式无字符串字段。
/// </summary>
internal sealed class FxrNativeDocument
{
    private const int HeaderSize = 0x90;
    private const int ExpectedVersion = 5;
    private const long MaxSourceBytes = 12L * 1024 * 1024;

    private const int MaxSection23Count = 1_000_000;
    private const int MaxSection6Count = 100_000;
    private const int MaxPropertyCount = 1_000_000;
    private const int MaxSection11Values = 1_000_000;
    private const int MaxTreeDepth = 64;
    private const int MaxSection4Nodes = 100_000;
    private const int MaxHostProperties = 100_000;

    // ── 节条目尺寸 ──
    private const int Section1Size = 0x10;
    private const int Section2Size = 0x10;
    private const int Section3Size = 0x60;
    private const int Section4Size = 0x30;
    private const int Section5Size = 0x20;
    private const int Section6Size = 0x40;
    private const int Section7Size = 0x28;
    private const int Section8Size = 0x20;
    private const int Section9Size = 0x18;
    private const int Section10Size = 0x10;
    private const int Section11ValueSize = 4;

    // ── node type 闭集（121 样本实测）──
    private static readonly HashSet<int> Section4Types = new() { 2000, 2001, 2002, 2200, 2202 };
    private static readonly HashSet<int> Section5Types = new() { 1002, 1004, 1005 };
    private static readonly HashSet<int> Section6Types = new()
    {
        0, 1, 15, 34, 35, 36, 46, 55, 60, 64, 65, 75, 83, 84, 105, 106, 113, 122,
        128, 129, 130, 131, 132, 133, 199, 200, 201, 300, 301, 399, 400, 401, 403, 404, 405,
        500, 501, 502, 503, 600, 602, 603, 604, 605, 606, 607, 608, 609, 732,
        10012, 10100, 10300, 10400, 10500
    };
    private static readonly HashSet<int> Section7Types = new()
    {
        0, 3, 16, 19, 32, 35, 48, 64, 66, 67, 83, 96, 99,
        4147, 4160, 4162, 4163, 4176, 4178, 4192, 4194
    };
    private static readonly HashSet<int> Section8Types = new() { 0xD050, 0xD053, 0xF050 };

    private const int SampleLimit = 64;

    private readonly SortedSet<string> _unknownTypeGaps;
    private readonly List<string> _layoutWarnings;

    private FxrNativeDocument(
        byte[] sourceBytes,
        int version,
        int id,
        int section1Count,
        int section2Count,
        int section3Count,
        int section4Count,
        int section5Count,
        int section6Count,
        int section7Count,
        int section8Count,
        int section9Count,
        int section10Count,
        int section11Count,
        int section12Count,
        int section13Count,
        int section14Count,
        IReadOnlyList<FxrSection4Node> rootNodes,
        int totalSection4NodeCount,
        IReadOnlyList<FxrSection6Host> hosts,
        int section7Total,
        int section8Total,
        int section9Total,
        int section10Total,
        int section11Total,
        SortedSet<string> unknownTypeGaps,
        List<string> layoutWarnings)
    {
        SourceBytes = sourceBytes;
        Version = version;
        Id = id;
        Section1Count = section1Count;
        Section2Count = section2Count;
        Section3Count = section3Count;
        Section4Count = section4Count;
        Section5Count = section5Count;
        Section6Count = section6Count;
        Section7Count = section7Count;
        Section8Count = section8Count;
        Section9Count = section9Count;
        Section10Count = section10Count;
        Section11Count = section11Count;
        Section12Count = section12Count;
        Section13Count = section13Count;
        Section14Count = section14Count;
        RootNodes = rootNodes;
        TotalSection4NodeCount = totalSection4NodeCount;
        Hosts = hosts;
        Section7Total = section7Total;
        Section8Total = section8Total;
        Section9Total = section9Total;
        Section10Total = section10Total;
        Section11Total = section11Total;
        _unknownTypeGaps = unknownTypeGaps;
        _layoutWarnings = layoutWarnings;
    }

    public byte[] SourceBytes { get; }
    public int Version { get; }
    public int Id { get; }

    // 声明的节计数（文件头原样）。parsed 量见 Section7Total/Section8Total/...
    public int Section1Count { get; }
    public int Section2Count { get; }
    public int Section3Count { get; }
    public int Section4Count { get; }
    public int Section5Count { get; }
    public int Section6Count { get; }
    public int Section7Count { get; }
    public int Section8Count { get; }
    public int Section9Count { get; }
    public int Section10Count { get; }
    public int Section11Count { get; }
    public int Section12Count { get; }
    public int Section13Count { get; }
    public int Section14Count { get; }

    public IReadOnlyList<FxrSection4Node> RootNodes { get; }
    public int TotalSection4NodeCount { get; }
    public IReadOnlyList<FxrSection6Host> Hosts { get; }
    public int RootNodeCount => RootNodes.Count;

    /// <summary>实解析的 Section7 属性总数（跨全部 host，Properties1+Properties2）。</summary>
    public int Section7Total { get; }
    public int Section8Total { get; }
    public int Section9Total { get; }
    public int Section10Total { get; }
    public int Section11Total { get; }

    public IReadOnlyList<string> LayoutWarnings => _layoutWarnings;
    public string SourceHash => Hash(SourceBytes);

    /// <summary>
    /// 本版刻意未解析/未验证的区间（能力边界）。见类型注释。与 LayoutWarnings
    /// （数据可疑）刻意分开：混在一起会把「我没读」误报成「文件坏了」。
    /// </summary>
    public string[] UnparsedGaps()
    {
        var gaps = new List<string>();
        if (Section11Total > 0)
        {
            gaps.Add($"section11:opaque-int-array（混合 int/float 位模式，无 schema，"
                + $"按不透明 int 数组上报）；values={Section11Total}");
        }
        if (Section9Total > 0)
        {
            gaps.Add("section9-not-verified（121 个真实样本全部未出现该节，布局取自 "
                + "SoulsFormats，未实测验证）");
        }
        if (Section12Count == 0 && Section13Count == 0 && Section14Count == 0)
        {
            gaps.Add("section12-14-empty-samples-only（真实样本恒空，非空布局未验证）");
        }
        else
        {
            gaps.Add("section12-14:opaque-int-array（非空时按不透明 int 数组上报，布局未验证）");
        }
        gaps.AddRange(_unknownTypeGaps);
        return gaps.ToArray();
    }

    /// <summary>
    /// authority：有 unparsedGaps（能力边界）即 partial；无 gap 才 candidate。
    /// candidate 是上限，不可推导 native-verified（无 writer、Section11 无 schema、
    /// 无真实语料往返与游戏加载验证）。
    /// </summary>
    public string Authority => UnparsedGaps().Length > 0 ? "partial" : "candidate";

    // ══════════════════════════════════════════════════════════════
    //  Read
    // ══════════════════════════════════════════════════════════════

    public static FxrNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException(
                $"FXR 大小 {source.Length} 超出安全范围（最小 {HeaderSize}，最大 {MaxSourceBytes}）。");

        if (!source.AsSpan(0, 4).SequenceEqual("FXR\0"u8))
            throw new InvalidDataException("输入不是 FXR（缺少 \"FXR\\0\" 魔数）。");

        var version = ReadUInt16(source, 0x06);
        if (version != ExpectedVersion)
            throw new NotSupportedException($"仅支持 FXR3 version {ExpectedVersion}，收到 {version}。");

        var headerOne = ReadInt32(source, 0x08);
        if (headerOne != 1)
            throw new InvalidDataException($"FXR 文件头 0x08 应为 1，实际 {headerOne}。");
        var id = ReadInt32(source, 0x0C);

        var section1Offset = ReadInt32(source, 0x10);
        var section1Count = ReadInt32(source, 0x14);
        var section2Offset = ReadInt32(source, 0x18);
        var section2Count = ReadInt32(source, 0x1C);
        var section3Offset = ReadInt32(source, 0x20);
        var section3Count = ReadInt32(source, 0x24);
        var section4Offset = ReadInt32(source, 0x28);
        var section4Count = ReadInt32(source, 0x2C);
        var section5Offset = ReadInt32(source, 0x30);
        var section5Count = ReadInt32(source, 0x34);
        var section6Offset = ReadInt32(source, 0x38);
        var section6Count = ReadInt32(source, 0x3C);
        var section7Offset = ReadInt32(source, 0x40);
        var section7Count = ReadInt32(source, 0x44);
        var section8Offset = ReadInt32(source, 0x48);
        var section8Count = ReadInt32(source, 0x4C);
        var section9Offset = ReadInt32(source, 0x50);
        var section9Count = ReadInt32(source, 0x54);
        var section10Offset = ReadInt32(source, 0x58);
        var section10Count = ReadInt32(source, 0x5C);
        var section11Offset = ReadInt32(source, 0x60);
        var section11Count = ReadInt32(source, 0x64);
        var unk68 = ReadInt32(source, 0x68);
        var unk6C = ReadInt32(source, 0x6C);
        var section12Offset = ReadInt32(source, 0x70);
        var section12Count = ReadInt32(source, 0x74);
        var section13Offset = ReadInt32(source, 0x78);
        var section13Count = ReadInt32(source, 0x7C);
        var section14Offset = ReadInt32(source, 0x80);
        var section14Count = ReadInt32(source, 0x84);

        if (unk68 != 1) throw new InvalidDataException($"FXR 文件头 0x68 应为 1，实际 {unk68}。");
        if (unk6C != 0) throw new InvalidDataException($"FXR 文件头 0x6C 应为 0，实际 {unk6C}。");
        if (section1Count != 1)
            throw new InvalidDataException($"FXR Section1 count 应为 1（恒 1），实际 {section1Count}。");

        // ── count 上限 ──
        if (section2Count is < 0 or > MaxSection23Count)
            throw new InvalidDataException($"FXR Section2 count {section2Count} 超出安全上限 {MaxSection23Count}。");
        if (section3Count is < 0 or > MaxSection23Count)
            throw new InvalidDataException($"FXR Section3 count {section3Count} 超出安全上限 {MaxSection23Count}。");
        if (section4Count is < 0 or > MaxSection4Nodes)
            throw new InvalidDataException($"FXR Section4 count {section4Count} 超出安全上限 {MaxSection4Nodes}。");
        if (section5Count is < 0 or > MaxSection23Count)
            throw new InvalidDataException($"FXR Section5 count {section5Count} 超出安全上限 {MaxSection23Count}。");
        if (section6Count is < 0 or > MaxSection6Count)
            throw new InvalidDataException($"FXR Section6 count {section6Count} 超出安全上限 {MaxSection6Count}。");
        if (section7Count is < 0 or > MaxPropertyCount)
            throw new InvalidDataException($"FXR Section7 count {section7Count} 超出安全上限 {MaxPropertyCount}。");
        if (section8Count is < 0 or > MaxPropertyCount)
            throw new InvalidDataException($"FXR Section8 count {section8Count} 超出安全上限 {MaxPropertyCount}。");
        if (section9Count is < 0 or > MaxSection23Count)
            throw new InvalidDataException($"FXR Section9 count {section9Count} 超出安全上限 {MaxSection23Count}。");
        if (section10Count is < 0 or > MaxSection23Count)
            throw new InvalidDataException($"FXR Section10 count {section10Count} 超出安全上限 {MaxSection23Count}。");
        if (section11Count is < 0 or > MaxSection11Values)
            throw new InvalidDataException($"FXR Section11 count {section11Count} 超出安全上限 {MaxSection11Values}。");
        if (section12Count is < 0 or > MaxSection11Values)
            throw new InvalidDataException($"FXR Section12 count {section12Count} 超出安全上限。");
        if (section13Count is < 0 or > MaxSection11Values)
            throw new InvalidDataException($"FXR Section13 count {section13Count} 超出安全上限。");
        if (section14Count is < 0 or > MaxSection11Values)
            throw new InvalidDataException($"FXR Section14 count {section14Count} 超出安全上限。");

        // ── 节范围校验（每个 offset 解引用前验证）──
        ValidateRange(source, section1Offset, section1Count, Section1Size, "Section1");
        ValidateRange(source, section2Offset, section2Count, Section2Size, "Section2");
        ValidateRange(source, section3Offset, section3Count, Section3Size, "Section3");
        ValidateRange(source, section4Offset, section4Count, Section4Size, "Section4");
        ValidateRange(source, section5Offset, section5Count, Section5Size, "Section5");
        ValidateRange(source, section6Offset, section6Count, Section6Size, "Section6");
        ValidateRange(source, section7Offset, section7Count, Section7Size, "Section7");
        ValidateRange(source, section8Offset, section8Count, Section8Size, "Section8");
        ValidateRange(source, section9Offset, section9Count, Section9Size, "Section9");
        ValidateRange(source, section10Offset, section10Count, Section10Size, "Section10");
        ValidateRange(source, section11Offset, section11Count, Section11ValueSize, "Section11");
        ValidateRange(source, section12Offset, section12Count, Section11ValueSize, "Section12");
        ValidateRange(source, section13Offset, section13Count, Section11ValueSize, "Section13");
        ValidateRange(source, section14Offset, section14Count, Section11ValueSize, "Section14");

        var gaps = new SortedSet<string>(StringComparer.Ordinal);
        var warnings = new List<string>();
        var section11Total = 0;

        // ── Section1 链：Section1(恒1) → Section2 → Section3 ──
        // Section1 条目本身也携带 section2Count/section2Offset（0x04/0x08）。
        // 与文件头对拍：不一致说明布局与已登记形态不同，失败关闭（blocked）。
        var s1 = section1Offset;
        var s1Unk0 = ReadInt32(source, s1 + 0x00);
        var s1Section2Count = ReadInt32(source, s1 + 0x04);
        var s1Section2Offset = ReadInt32(source, s1 + 0x08);
        var s1UnkC = ReadInt32(source, s1 + 0x0C);
        if (s1Section2Count != section2Count || s1Section2Offset != section2Offset)
        {
            throw new InvalidDataException(
                $"FXR Section1 条目声明的 Section2 表（count={s1Section2Count}, offset={s1Section2Offset}）"
                + $"与文件头（count={section2Count}, offset={section2Offset}）不一致。");
        }
        if (s1Unk0 != 0 || s1UnkC != 0)
            warnings.Add($"Section1[0]:+0x00/+0x0C 应为 0，实际 {s1Unk0}/{s1UnkC}（布局可能与已登记形态不同）。");

        var section3TotalFromChain = 0;
        for (var i = 0; i < section2Count; i++)
        {
            var s2 = section2Offset + i * Section2Size;
            var s2Unk0 = ReadInt32(source, s2 + 0x00);
            var s2Section3Count = ReadInt32(source, s2 + 0x04);
            var s2Section3Offset = ReadInt32(source, s2 + 0x08);
            var s2UnkC = ReadInt32(source, s2 + 0x0C);
            if (s2Unk0 != 0 || s2UnkC != 0)
                warnings.Add($"Section2[{i}]:+0x00/+0x0C 应为 0，实际 {s2Unk0}/{s2UnkC}。");
            ValidateRange(source, s2Section3Offset, s2Section3Count, Section3Size, "Section3 (via Section2)");
            section3TotalFromChain = checked(section3TotalFromChain + s2Section3Count);
            if (section3TotalFromChain > MaxSection23Count)
                throw new InvalidDataException($"FXR Section3 累计条数超过安全上限 {MaxSection23Count}。");
        }

        for (var i = 0; i < section3Count; i++)
        {
            var s3 = section3Offset + i * Section3Size;
            // Section3 条目内两个 section11 偏移各指 1 个 Int32。偏移为 0 表示无。
            var s11Offset1 = ReadInt32(source, s3 + 0x20);
            var s11Offset2 = ReadInt32(source, s3 + 0x48);
            if (s11Offset1 != 0)
            {
                ValidateRange(source, s11Offset1, 1, Section11ValueSize, "Section11 (Section3 offset1)");
                section11Total += 1;
            }
            if (s11Offset2 != 0)
            {
                ValidateRange(source, s11Offset2, 1, Section11ValueSize, "Section11 (Section3 offset2)");
                section11Total += 1;
            }
        }

        // ── Section4 递归树 ──
        // S24：Section4 的 count 是**整张扁平表**（槽 = section4Offset + i*0x30），
        // 子节点就住在紧随其后的槽里。旧实现把每个槽都当根递归，孩子先被父节点
        // 走一遍、再被 i 循环当第二棵根走一遍 → visited 撞出「假环」把整包判死。
        // 现在先扫一遍所有槽的 childOffset 引用，根 = 未被任何父引用的槽；递归时
        // 用「递归栈」判真环（孩子指祖先），用「已访问」跳过共享/重复槽。
        var referenced4 = new HashSet<int>();
        for (var i = 0; i < section4Count; i++)
        {
            var off = section4Offset + i * Section4Size;
            ValidateRange(source, off, 1, Section4Size, "Section4 节点");
            var childCount = ReadInt32(source, off + 0x10);
            var childOffset = ReadInt32(source, off + 0x28);
            if (childCount <= 0 || childOffset <= 0) continue;
            ValidateRange(source, childOffset, childCount, Section4Size, "Section4 子节点");
            for (var c = 0; c < childCount; c++)
            {
                referenced4.Add(childOffset + c * Section4Size);
            }
        }
        var rootNodes = new List<FxrSection4Node>(section4Count);
        var visited4 = new HashSet<int>();
        var stack4 = new HashSet<int>();
        var nodeCount = 0;
        for (var i = 0; i < section4Count; i++)
        {
            var off = section4Offset + i * Section4Size;
            if (referenced4.Contains(off)) continue;
            rootNodes.Add(ParseSection4Node(source, off, 0,
                stack4, visited4, ref nodeCount, gaps));
        }

        // ── 从树收集 FFXDrawEntityHost（Section6）与属性树 ──
        var hosts = new List<FxrSection6Host>();
        var visited6 = new HashSet<int>();
        var section7Total = 0;
        var section8Total = 0;
        var section9Total = 0;
        var section10Total = 0;
        foreach (var node in rootNodes)
        {
            CollectHosts(source, node, visited6, hosts, gaps,
                ref section7Total, ref section8Total, ref section9Total, ref section10Total, ref section11Total);
        }

        return new FxrNativeDocument(
            source, version, id,
            section1Count, section2Count, section3Count, section4Count,
            section5Count, section6Count, section7Count, section8Count, section9Count,
            section10Count, section11Count, section12Count, section13Count, section14Count,
            rootNodes, nodeCount, hosts,
            section7Total, section8Total, section9Total, section10Total, section11Total,
            gaps, warnings);
    }

    public static FxrNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("FXR 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"FXR 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    /// <summary>
    /// 递归解析一个 Section4 节点。子节点紧随父节点（offset = 父 + 0x30）是实测布局，
    /// 但解析以节点内 +0x28 字段为准并校验范围。
    /// 防环（S24）：`stack` 是当前递归栈（祖先链），重复 = 真环失败关闭；`visited`
    /// 是全局已访问表，已被其它父/根走过的槽直接跳过（扁平表共享布局不是错误）。
    /// </summary>
    private static FxrSection4Node ParseSection4Node(
        byte[] source,
        int offset,
        int depth,
        HashSet<int> stack,
        HashSet<int> visited,
        ref int nodeCount,
        SortedSet<string> gaps)
    {
        if (depth > MaxTreeDepth)
            throw new InvalidDataException($"FXR Section4 树深度超过安全上限 {MaxTreeDepth}。");
        if (nodeCount >= MaxSection4Nodes)
            throw new InvalidDataException($"FXR Section4 节点总数超过安全上限 {MaxSection4Nodes}。");
        if (!stack.Add(offset))
            throw new InvalidDataException($"FXR Section4 树出现循环引用（offset 0x{offset:X} 指向祖先）。");
        if (!visited.Add(offset))
        {
            // 已被其它树访问过：共享/扁平布局，跳过而不是判死。
            stack.Remove(offset);
            return new FxrSection4Node(0, 0, 0, 0, 0, 0, 0, new List<FxrSection4Node>());
        }
        nodeCount++;

        try
        {
            ValidateRange(source, offset, 1, Section4Size, "Section4 节点");

            var typeId = ReadInt16(source, offset + 0x00);
            var section5Count = ReadInt32(source, offset + 0x08);
            var section6Count = ReadInt32(source, offset + 0x0C);
            var childCount = ReadInt32(source, offset + 0x10);
            var section5Offset = ReadInt32(source, offset + 0x18);
            var section6Offset = ReadInt32(source, offset + 0x20);
            var childOffset = ReadInt32(source, offset + 0x28);

            if (!Section4Types.Contains(typeId))
                gaps.Add($"unknown-type:section4:{typeId}");

            if (section5Count is < 0 or > MaxSection23Count)
                throw new InvalidDataException($"FXR Section4[{offset:X}] section5Count {section5Count} 越界。");
            if (section6Count is < 0 or > MaxSection6Count)
                throw new InvalidDataException($"FXR Section4[{offset:X}] section6Count {section6Count} 越界。");
            if (childCount is < 0 or > MaxSection4Nodes)
                throw new InvalidDataException($"FXR Section4[{offset:X}] childCount {childCount} 越界。");
            ValidateRange(source, section5Offset, section5Count, Section5Size, "Section5 (via Section4)");
            ValidateRange(source, section6Offset, section6Count, Section6Size, "Section6 (via Section4)");
            ValidateRange(source, childOffset, childCount, Section4Size, "Section4 子节点");

            var children = new List<FxrSection4Node>(childCount);
            for (var c = 0; c < childCount; c++)
            {
                children.Add(ParseSection4Node(source, childOffset + c * Section4Size, depth + 1,
                    stack, visited, ref nodeCount, gaps));
            }

            return new FxrSection4Node(typeId, section5Count, section6Count, childCount,
                section5Offset, section6Offset, childOffset, children);
        }
        finally
        {
            stack.Remove(offset);
        }
    }

    private static void CollectHosts(
        byte[] source,
        FxrSection4Node node,
        HashSet<int> visited6,
        List<FxrSection6Host> hosts,
        SortedSet<string> gaps,
        ref int section7Total,
        ref int section8Total,
        ref int section9Total,
        ref int section10Total,
        ref int section11Total)
    {
        // 直接引用的 Section6 host
        for (var i = 0; i < node.Section6Count; i++)
        {
            ParseHostAt(source, node.Section6Offset + i * Section6Size, visited6, hosts, gaps,
                ref section7Total, ref section8Total, ref section9Total, ref section10Total, ref section11Total);
        }
        // Section5 → Section6 host
        for (var i = 0; i < node.Section5Count; i++)
        {
            var s5 = node.Section5Offset + i * Section5Size;
            var s5TypeId = ReadInt16(source, s5 + 0x00);
            var s5Section6Count = ReadInt32(source, s5 + 0x0C);
            var s5Section6Offset = ReadInt32(source, s5 + 0x18);
            if (!Section5Types.Contains(s5TypeId))
                gaps.Add($"unknown-type:section5:{s5TypeId}");
            if (s5Section6Count is < 0 or > MaxSection6Count)
                throw new InvalidDataException($"FXR Section5[{s5:X}] section6Count {s5Section6Count} 越界。");
            ValidateRange(source, s5Section6Offset, s5Section6Count, Section6Size, "Section6 (via Section5)");
            for (var j = 0; j < s5Section6Count; j++)
            {
                ParseHostAt(source, s5Section6Offset + j * Section6Size, visited6, hosts, gaps,
                    ref section7Total, ref section8Total, ref section9Total, ref section10Total, ref section11Total);
            }
        }
        foreach (var child in node.Children)
        {
            CollectHosts(source, child, visited6, hosts, gaps,
                ref section7Total, ref section8Total, ref section9Total, ref section10Total, ref section11Total);
        }
    }

    private static void ParseHostAt(
        byte[] source,
        int offset,
        HashSet<int> visited6,
        List<FxrSection6Host> hosts,
        SortedSet<string> gaps,
        ref int section7Total,
        ref int section8Total,
        ref int section9Total,
        ref int section10Total,
        ref int section11Total)
    {
        if (visited6.Add(offset))
        {
            hosts.Add(ParseSection6Host(source, offset, gaps,
                ref section7Total, ref section8Total, ref section9Total, ref section10Total, ref section11Total));
        }
    }

    /// <summary>FFXDrawEntityHost：→ Properties1/Properties2（连续排在 section7Offset）+ Section10 + Section11。</summary>
    private static FxrSection6Host ParseSection6Host(
        byte[] source,
        int offset,
        SortedSet<string> gaps,
        ref int section7Total,
        ref int section8Total,
        ref int section9Total,
        ref int section10Total,
        ref int section11Total)
    {
        ValidateRange(source, offset, 1, Section6Size, "Section6 host");

        var typeId = ReadInt16(source, offset + 0x00);
        var unk02 = source[offset + 0x02];
        var unk03 = source[offset + 0x03];
        var unk04 = ReadInt32(source, offset + 0x04);
        var section11Count1 = ReadInt32(source, offset + 0x08);
        var section10Count = ReadInt32(source, offset + 0x0C);
        var section7Count1 = ReadInt32(source, offset + 0x10);
        var section11Count2 = ReadInt32(source, offset + 0x14);
        var section7Count2 = ReadInt32(source, offset + 0x1C);
        var section11Offset = ReadInt32(source, offset + 0x20);
        var section10Offset = ReadInt32(source, offset + 0x28);
        var section7Offset = ReadInt32(source, offset + 0x30);

        if (!Section6Types.Contains(typeId))
            gaps.Add($"unknown-type:section6:{typeId}");

        if (section11Count1 is < 0 or > MaxSection11Values
            || section11Count2 is < 0 or > MaxSection11Values
            || section10Count is < 0 or > MaxSection23Count
            || section7Count1 is < 0 or > MaxHostProperties
            || section7Count2 is < 0 or > MaxHostProperties)
            throw new InvalidDataException($"FXR Section6[{offset:X}] 计数越界。");
        if (section7Count1 + section7Count2 > MaxHostProperties)
            throw new InvalidDataException($"FXR Section6[{offset:X}] 属性总数超过每 host 上限 {MaxHostProperties}。");

        ValidateRange(source, section11Offset, section11Count1 + section11Count2, Section11ValueSize, "Section11 (host)");
        ValidateRange(source, section10Offset, section10Count, Section10Size, "Section10 (host)");
        ValidateRange(source, section7Offset, section7Count1 + section7Count2, Section7Size, "Section7 (host)");

        section11Total += section11Count1 + section11Count2;
        section10Total += section10Count;

        // Properties1 与 Properties2 连续排在 section7Offset。
        var properties1 = new List<FxrSection7Property>(section7Count1);
        for (var i = 0; i < section7Count1; i++)
        {
            properties1.Add(ParseSection7Property(source, section7Offset + i * Section7Size, gaps,
                ref section7Total, ref section8Total, ref section9Total, ref section11Total));
        }
        var properties2 = new List<FxrSection7Property>(section7Count2);
        for (var i = 0; i < section7Count2; i++)
        {
            properties2.Add(ParseSection7Property(source, section7Offset + (section7Count1 + i) * Section7Size, gaps,
                ref section7Total, ref section8Total, ref section9Total, ref section11Total));
        }

        var section11Values = ReadSection11Values(source, section11Offset, section11Count1 + section11Count2);
        var section10Entries = new List<FxrSection10Entry>(section10Count);
        for (var i = 0; i < section10Count; i++)
        {
            var s10 = section10Offset + i * Section10Size;
            var s10Section11Offset = ReadInt32(source, s10 + 0x00);
            var s10Section11Count = ReadInt32(source, s10 + 0x08);
            if (s10Section11Count is < 0 or > MaxSection11Values)
                throw new InvalidDataException($"FXR Section10[{s10:X}] section11Count {s10Section11Count} 越界。");
            ValidateRange(source, s10Section11Offset, s10Section11Count, Section11ValueSize, "Section11 (via Section10)");
            section11Total += s10Section11Count;
            section10Entries.Add(new FxrSection10Entry(s10Section11Offset, s10Section11Count));
        }

        return new FxrSection6Host(typeId, unk02, unk03, unk04,
            section11Count1, section10Count, section7Count1, section11Count2, section7Count2,
            properties1, properties2, section11Values, section10Entries);
    }

    private static FxrSection7Property ParseSection7Property(
        byte[] source,
        int offset,
        SortedSet<string> gaps,
        ref int section7Total,
        ref int section8Total,
        ref int section9Total,
        ref int section11Total)
    {
        ValidateRange(source, offset, 1, Section7Size, "Section7 属性");
        section7Total++;

        var typeId = ReadInt16(source, offset + 0x00);
        var unk04 = ReadInt32(source, offset + 0x04);
        var section11Count = ReadInt32(source, offset + 0x08);
        var section11Offset = ReadInt32(source, offset + 0x10);
        var section8Offset = ReadInt32(source, offset + 0x18);
        var section8Count = ReadInt32(source, offset + 0x20);

        if (!Section7Types.Contains(typeId))
            gaps.Add($"unknown-type:section7:{typeId}");

        if (section11Count is < 0 or > MaxSection11Values || section8Count is < 0 or > MaxPropertyCount)
            throw new InvalidDataException($"FXR Section7[{offset:X}] 计数越界。");
        ValidateRange(source, section11Offset, section11Count, Section11ValueSize, "Section11 (property)");
        ValidateRange(source, section8Offset, section8Count, Section8Size, "Section8 (property)");
        section11Total += section11Count;

        var values = ReadSection11Values(source, section11Offset, section11Count);
        var section8Entries = new List<FxrSection8Entry>(section8Count);
        for (var i = 0; i < section8Count; i++)
        {
            section8Entries.Add(ParseSection8Entry(source, section8Offset + i * Section8Size, gaps,
                ref section8Total, ref section9Total, ref section11Total));
        }

        return new FxrSection7Property(typeId, unk04, section11Count, section8Count, values, section8Entries);
    }

    private static FxrSection8Entry ParseSection8Entry(
        byte[] source,
        int offset,
        SortedSet<string> gaps,
        ref int section8Total,
        ref int section9Total,
        ref int section11Total)
    {
        ValidateRange(source, offset, 1, Section8Size, "Section8 条目");
        section8Total++;

        var typeId = ReadUInt16(source, offset + 0x00);
        var unk04 = ReadInt32(source, offset + 0x04);
        var section11Count = ReadInt32(source, offset + 0x08);
        var section9Count = ReadInt32(source, offset + 0x0C);
        var section11Offset = ReadInt32(source, offset + 0x10);
        var section9Offset = ReadInt32(source, offset + 0x18);

        if (!Section8Types.Contains(typeId))
            gaps.Add($"unknown-type:section8:0x{typeId:X4}");

        if (section11Count is < 0 or > MaxSection11Values || section9Count is < 0 or > MaxSection23Count)
            throw new InvalidDataException($"FXR Section8[{offset:X}] 计数越界。");
        ValidateRange(source, section11Offset, section11Count, Section11ValueSize, "Section11 (section8)");
        ValidateRange(source, section9Offset, section9Count, Section9Size, "Section9 (section8)");
        section11Total += section11Count;
        section9Total += section9Count;

        var values = ReadSection11Values(source, section11Offset, section11Count);
        var section9Entries = new List<FxrSection9Entry>(section9Count);
        for (var i = 0; i < section9Count; i++)
        {
            section9Entries.Add(ParseSection9Entry(source, section9Offset + i * Section9Size, gaps, ref section11Total));
        }

        return new FxrSection8Entry(typeId, unk04, section11Count, section9Count, values, section9Entries);
    }

    /// <summary>Section9 布局来自 SoulsFormats，121 样本全部未出现 → 未实测验证（gap 在 UnparsedGaps 里登记）。</summary>
    private static FxrSection9Entry ParseSection9Entry(
        byte[] source,
        int offset,
        SortedSet<string> gaps,
        ref int section11Total)
    {
        ValidateRange(source, offset, 1, Section9Size, "Section9 条目");

        var typeId = ReadInt16(source, offset + 0x00);
        var unk04 = ReadInt32(source, offset + 0x04);
        var section11Count = ReadInt32(source, offset + 0x08);
        var section11Offset = ReadInt32(source, offset + 0x10);

        if (typeId != 48)
            gaps.Add($"unexpected-type:section9:{typeId}（SoulsFormats 布局预期 48）");
        if (section11Count is < 0 or > MaxSection11Values)
            throw new InvalidDataException($"FXR Section9[{offset:X}] section11Count {section11Count} 越界。");
        ValidateRange(source, section11Offset, section11Count, Section11ValueSize, "Section11 (section9)");
        section11Total += section11Count;

        var values = ReadSection11Values(source, section11Offset, section11Count);
        return new FxrSection9Entry(typeId, unk04, section11Count, values);
    }

    private static IReadOnlyList<int> ReadSection11Values(byte[] source, int offset, int count)
    {
        if (count <= 0) return Array.Empty<int>();
        ValidateRange(source, offset, count, Section11ValueSize, "Section11 values");
        var values = new int[count];
        for (var i = 0; i < count; i++)
            values[i] = ReadInt32(source, offset + i * Section11ValueSize);
        return values;
    }

    // ══════════════════════════════════════════════════════════════
    //  Round-trip（只读：重复解析同一份字节，验证确定性）
    // ══════════════════════════════════════════════════════════════

    public FxrRoundTripReport VerifyRoundTrip()
    {
        var reparsed = Read(SourceBytes.ToArray());
        var consistent = reparsed.Version == Version
            && reparsed.Id == Id
            && reparsed.RootNodeCount == RootNodeCount
            && reparsed.TotalSection4NodeCount == TotalSection4NodeCount
            && reparsed.Section7Total == Section7Total
            && reparsed.Section8Total == Section8Total
            && reparsed.Section9Total == Section9Total
            && reparsed.Section11Total == Section11Total
            && reparsed.UnparsedGaps().SequenceEqual(UnparsedGaps());
        return new FxrRoundTripReport(
            consistent,
            SourceHash,
            reparsed.SourceHash,
            TotalSection4NodeCount,
            Section7Total,
            Section11Total,
            consistent ? null : "FXR 重复解析的结构投影不一致。");
    }

    // ══════════════════════════════════════════════════════════════
    //  Envelope（effect / node / field 三页）
    // ══════════════════════════════════════════════════════════════

    public object ToEnvelope(FxrRoundTripReport? report = null)
    {
        report ??= VerifyRoundTrip();
        // 顺序要紧：authority 触发 UnparsedGaps 计算；先算再读 gaps 保持一致。
        var authority = Authority;
        var gaps = UnparsedGaps();

        return new
        {
            format = "FXR3",
            formatId = "fxr",
            version = Version,
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            resourceId = Id,
            rootNodeCount = RootNodeCount,
            totalNodeCount = TotalSection4NodeCount,
            hostCount = Hosts.Count,
            propertyCount = Section7Total,
            section11ValueCount = Section11Total,
            // 文件头声明的各节计数（declared）。实解析量见 hostCount/propertyCount/...
            sectionCounts = new
            {
                section1 = Section1Count,
                section2 = Section2Count,
                section3 = Section3Count,
                section4 = Section4Count,
                section5 = Section5Count,
                section6 = Section6Count,
                section7 = Section7Count,
                section8 = Section8Count,
                section9 = Section9Count,
                section10 = Section10Count,
                section11 = Section11Count,
                section12 = Section12Count,
                section13 = Section13Count,
                section14 = Section14Count
            },
            // ── effect page：文档头 + 根节点树 ──
            effect = new
            {
                format = "FXR3",
                version = Version,
                resourceId = Id,
                rootNodeCount = RootNodeCount,
                nodes = RootNodes.Take(SampleLimit).Select(n => ProjectNode(n, 0)).ToArray(),
                nodesTruncated = RootNodes.Count > SampleLimit
            },
            // ── node page：全部 Section4 节点按 type 聚合 ──
            nodes = new
            {
                total = TotalSection4NodeCount,
                byType = RootNodes.SelectMany(FlattenNodes)
                    .GroupBy(n => n.TypeId)
                    .OrderBy(g => g.Key)
                    .Select(g => new { typeId = g.Key, count = g.Count() })
                    .ToArray()
            },
            // ── field page：host 属性树（bounded samples）──
            fields = new
            {
                hosts = Hosts.Take(SampleLimit).Select(h => new
                {
                    typeId = h.TypeId,
                    unk02 = h.Unk02,
                    unk03 = h.Unk03,
                    unk04 = h.Unk04,
                    section11Count = h.Section11Count1 + h.Section11Count2,
                    section10Count = h.Section10Count,
                    section7Count = h.Section7Count1 + h.Section7Count2,
                    properties = h.Properties1.Concat(h.Properties2).Take(SampleLimit).Select(p => new
                    {
                        typeId = p.TypeId,
                        unk04 = p.Unk04,
                        section11Count = p.Section11Count,
                        section8Count = p.Section8Count,
                        values = p.Section11Values.Take(SampleLimit),
                        valuesTruncated = p.Section11Values.Count > SampleLimit,
                        section8 = p.Section8Entries.Take(SampleLimit).Select(e => new
                        {
                            typeId = e.TypeId,
                            unk04 = e.Unk04,
                            section11Count = e.Section11Count,
                            section9Count = e.Section9Count,
                            values = e.Section11Values.Take(SampleLimit),
                            valuesTruncated = e.Section11Values.Count > SampleLimit,
                            section9 = e.Section9Entries.Take(SampleLimit).Select(s9 => new
                            {
                                typeId = s9.TypeId,
                                unk04 = s9.Unk04,
                                section11Count = s9.Section11Count,
                                values = s9.Section11Values.Take(SampleLimit)
                            }).ToArray(),
                            section9Truncated = e.Section9Entries.Count > SampleLimit
                        }).ToArray(),
                        section8Truncated = p.Section8Entries.Count > SampleLimit
                    }).ToArray(),
                    propertiesTruncated = h.Properties1.Count + h.Properties2.Count > SampleLimit,
                    section10 = h.Section10Entries.Take(SampleLimit).Select(s10 => new
                    {
                        section11Offset = s10.Section11Offset,
                        section11Count = s10.Section11Count
                    }).ToArray(),
                    section10Truncated = h.Section10Entries.Count > SampleLimit,
                    values = h.Section11Values.Take(SampleLimit),
                    valuesTruncated = h.Section11Values.Count > SampleLimit
                }).ToArray(),
                hostsTruncated = Hosts.Count > SampleLimit
            },
            // 能力边界（与 layoutWarnings 分列：一个是「没读」，一个是「数据可疑」）。
            unparsedGaps = gaps,
            layoutWarnings = _layoutWarnings.ToArray(),
            roundTrip = report,
            authority
        };
    }

    private static IEnumerable<FxrSection4Node> FlattenNodes(FxrSection4Node node)
    {
        yield return node;
        foreach (var child in node.Children)
        {
            foreach (var nested in FlattenNodes(child))
                yield return nested;
        }
    }

    private static object ProjectNode(FxrSection4Node node, int depth)
    {
        return new
        {
            typeId = node.TypeId,
            childCount = node.ChildCount,
            drawEntityCount = node.Section6Count,
            drawEntityRefCount = node.Section5Count,
            children = node.Children.Take(SampleLimit).Select(c => ProjectNode(c, depth + 1)).ToArray(),
            childrenTruncated = node.Children.Count > SampleLimit
        };
    }

    // ── helpers ──

    private static void ValidateRange(byte[] source, int offset, int count, int entrySize, string name)
    {
        if (count < 0)
            throw new InvalidDataException($"FXR {name} count {count} 为负。");
        if (offset < 0 || offset + (long)count * entrySize > source.Length)
            throw new InvalidDataException(
                $"FXR {name} 越界：offset={offset}, count={count}, size={entrySize}, fileLength={source.Length}。");
    }

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static ushort ReadUInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));

    private static short ReadInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(offset, 2));

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

// ── Records ──

internal sealed record FxrSection4Node(
    int TypeId,
    int Section5Count,
    int Section6Count,
    int ChildCount,
    int Section5Offset,
    int Section6Offset,
    int ChildOffset,
    IReadOnlyList<FxrSection4Node> Children);

/// <summary>FFXDrawEntityHost。Properties1 与 Properties2 连续排在 section7Offset。</summary>
internal sealed record FxrSection6Host(
    int TypeId,
    byte Unk02,
    byte Unk03,
    int Unk04,
    int Section11Count1,
    int Section10Count,
    int Section7Count1,
    int Section11Count2,
    int Section7Count2,
    IReadOnlyList<FxrSection7Property> Properties1,
    IReadOnlyList<FxrSection7Property> Properties2,
    IReadOnlyList<int> Section11Values,
    IReadOnlyList<FxrSection10Entry> Section10Entries);

internal sealed record FxrSection7Property(
    int TypeId,
    int Unk04,
    int Section11Count,
    int Section8Count,
    IReadOnlyList<int> Section11Values,
    IReadOnlyList<FxrSection8Entry> Section8Entries);

internal sealed record FxrSection8Entry(
    int TypeId,
    int Unk04,
    int Section11Count,
    int Section9Count,
    IReadOnlyList<int> Section11Values,
    IReadOnlyList<FxrSection9Entry> Section9Entries);

internal sealed record FxrSection9Entry(
    int TypeId,
    int Unk04,
    int Section11Count,
    IReadOnlyList<int> Section11Values);

internal sealed record FxrSection10Entry(int Section11Offset, int Section11Count);

internal sealed record FxrRoundTripReport(
    bool Consistent,
    string SourceHash,
    string ReparsedHash,
    int NodeCount,
    int PropertyCount,
    int Section11ValueCount,
    string? Note);

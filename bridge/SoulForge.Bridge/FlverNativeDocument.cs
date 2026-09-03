using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro-era FLVER2（Flexible VERsion）只读原生文档解析器。
///
/// 权威布局来源：SoulsFormats（JKAnderson）FLVER2 家族结构，逐条与真实只狼样本
/// （c1020/c1700/c1220/c1360/c1400/c5030/c6210/c8010 等 chrbnd 内层 + m10 mapbnd 内层
/// 地图 FLVER）对拍验证。修复了旧实现的两处致命偏移错误：
///   1. meshCount@0x20 与 vertexBufferCount@0x24 被交换读取；
///   2. mesh 表基址多加了 16 字节（boneEnd+16），且字段映射与真实 Mesh 结构不符。
///
/// 本实现按 SoulsFormats 结构顺序连续解析：Header → Dummies(64B) → Materials(32B) →
/// Bones(128B) → Meshes(48B) → FaceSets(32B) → VertexBuffers(32B) → BufferLayouts
/// (16B header + 20B member) → Textures(32B) → SekiroUnk（version ≥ 0x2001A）。
/// 顶点 stride 一律取自 VertexBuffer.VertexSize@0x08（不假定 40）；每个语义的字节偏移
/// 取自该 mesh 实际使用的 BufferLayout.LayoutMember（Unk00@0/StructOffset@4/Type@8/
/// Semantic@0xC/Index@0x10）。
///
/// 只读 authority，无 writer。解码约定与 SoulsFormats FLVER.Vertex 一致：
///   Position：Float3 / Float4（取 xyz）
///   Normal：Byte4* = (byte-127)/127；Float3/Float4 直接取 xyz
///   UV：UVPair/UV = int16/2048（version ≥ 0x2000F）；Float2 直接取
///   BoneWeights：Byte4C = byte/255；Byte4A = sbyte/127
///   BoneIndices：Byte4B/Byte4E 原样字节
///   VertexColor：Float4 保留 RGBA float；Color/UByte4Norm 按 RGBA byte/255 读取
/// </summary>
internal sealed class FlverNativeDocument
{
    private static readonly byte[] MagicBytes = { 0x46, 0x4C, 0x56, 0x45, 0x52, 0x00 };
    private const int HeaderSize = 0x80;

    /// <summary>
    /// 已在真实语料上验证过的 FLVER internalVersion 闭集。
    ///
    /// 2026-08-08 实测 Sekiro mods/chr 全部 11 个 chrbnd 的 FLVER 子项：
    /// 0x2001A ×8、0x20014 ×3（c5030 / c6210 / c8010），endian 标记全部 "L\0"。
    ///
    /// ⚠️ 这两个值都必须在集合里。我第一版只抽了 2 个 chrbnd 就把闭集定成
    /// 0x2001A 单值，随即被 bridge:verify:flver-multi 打断——c5030 是 0x20014。
    /// 抽样定闭集会把已验证路径判成不支持。扩这个集合必须先有该版本的真实样本
    /// 与往返验证，不能凭「大概兼容」加进来——那等于在未验证的前提下扩大 native
    /// 声明面；同理，缩小它会让已验证的样本失去支持。
    /// </summary>
    private static readonly int[] SupportedInternalVersions = { 0x20014, 0x2001A };
    private const int DummySize = 64;
    private const int MaterialSize = 32;
    private const int BoneSize = 128;
    private const int MeshSize = 48;
    private const int FaceSetSize = 32;
    private const int VertexBufferSize = 32;
    private const int BufferLayoutHeaderSize = 16;
    private const int LayoutMemberSize = 20;
    private const int TextureSize = 32;
    private const int SekiroUnkHeaderSize = 28;

    private const int MaxSkeletonTransforms = 100_000;
    private const int MaxMaterials = 10_000;
    private const int MaxBones = 100_000;
    private const int MaxMeshes = 100_000;
    private const int MaxVertexBuffers = 200_000;
    private const int MaxFaceSets = 500_000;
    private const int MaxBufferLayouts = 10_000;
    private const int MaxTextures = 500_000;
    private const int MaxMembersPerLayout = 64;
    private const long MaxSourceBytes = 512L * 1024 * 1024;
    private const int SampleLimit = 10;
    private const int MaxStringBytes = 1024;
    private const int MaxIndexCount = 2_000_000;

    // FLVER2 LayoutType（SoulsFormats FLVER.LayoutMember.LayoutType）
    private const uint TypeFloat2 = 0x01;
    private const uint TypeFloat3 = 0x02;
    private const uint TypeFloat4 = 0x03;
    private const uint TypeByte4A = 0x10;
    private const uint TypeColor = TypeByte4A;       // LayoutType.Color
    private const uint TypeByte4B = 0x11;
    private const uint TypeShort2toFloat2 = 0x12;
    private const uint TypeByte4C = 0x13;
    private const uint TypeUByte4Norm = TypeByte4C;  // LayoutType.UByte4Norm
    private const uint TypeUV = 0x15;
    private const uint TypeUVPair = 0x16;
    private const uint TypeShortBoneIndices = 0x18;
    private const uint TypeShort4toFloat4A = 0x1A;
    private const uint TypeShort4toFloat4B = 0x2E;
    private const uint TypeByte4E = 0x2F;
    private const uint TypeEdgeCompressed = 0xF0;

    // FLVER2 LayoutSemantic
    private const uint SemPosition = 0;
    private const uint SemBoneWeights = 1;
    private const uint SemBoneIndices = 2;
    private const uint SemNormal = 3;
    private const uint SemUV = 5;
    private const uint SemTangent = 6;
    private const uint SemBitangent = 7;
    private const uint SemVertexColor = 10;

    private readonly byte[] _source;
    private readonly bool _unicode;
    private readonly IReadOnlyList<FlverDummyEntry> _dummies;
    private readonly IReadOnlyList<FlverVertexBufferEntry> _vertexBuffers;
    private readonly IReadOnlyList<FlverBufferLayoutEntry> _bufferLayouts;
    private readonly IReadOnlyList<FlverFaceSetEntry> _faceSets;
    private readonly IReadOnlyList<FlverTextureSlotEntry> _textureSlots;
    private readonly List<string> _layoutWarnings;

    /// <summary>
    /// 已识别但**本实现未解析**的结构缺口。与 <see cref="_layoutWarnings"/> 刻意分成两个集合：
    ///
    ///   layoutWarnings = 「读到的东西不对」（越界引用、未知 member 大小、structOffset 越界）
    ///                    → 数据可疑，是**异常**。
    ///   unparsedGaps   = 「有东西我根本没读」（已定义未实现的语义、未读的字段区间）
    ///                    → 数据没问题，是**能力边界**。
    ///
    /// 为什么必须分开：把缺口塞进 layoutWarnings 会让 11 个真实样本全部出现「警告」，
    /// 而它们的数据其实完好——那是**误报**，且会淹没真正的越界警告（后者才需要人去查
    /// 数据）。反过来，缺口若不进入任何集合，就是当前的状态：不可见。
    ///
    /// 两者都参与 <see cref="Authority"/> 的降级判定，但语义与诊断分开呈现。
    /// 项目红线「未有真实 parser 时不得声称格式已解析」的执行机制正是这一条：
    /// 让 authority 对缺口敏感，而不是让缺口悄悄通过。
    /// </summary>
    private readonly SortedSet<string> _unparsedGaps;

    private FlverNativeDocument(
        byte[] sourceBytes,
        string versionString,
        int internalVersion,
        int dataStart,
        int dataLength,
        int skeletonTransformCount,
        int materialCount,
        int boneCount,
        int vertexBufferCount,
        int meshCount,
        int faceSetCount,
        int bufferLayoutCount,
        int textureCount,
        bool unicode,
        float boundingBoxMinX, float boundingBoxMinY, float boundingBoxMinZ,
        float boundingBoxMaxX, float boundingBoxMaxY, float boundingBoxMaxZ,
        int faceCount,
        int totalFaceCount,
        IReadOnlyList<FlverDummyEntry> dummies,
        IReadOnlyList<FlverMaterialEntry> materials,
        IReadOnlyList<FlverBoneEntry> bones,
        IReadOnlyList<FlverMeshEntry> meshes,
        IReadOnlyList<FlverVertexBufferEntry> vertexBuffers,
        IReadOnlyList<FlverBufferLayoutEntry> bufferLayouts,
        IReadOnlyList<FlverFaceSetEntry> faceSets,
        IReadOnlyList<FlverTextureSlotEntry> textureSlots,
        List<string> layoutWarnings)
    {
        SourceBytes = sourceBytes;
        _source = sourceBytes;
        VersionString = versionString;
        InternalVersion = internalVersion;
        _unicode = unicode;
        DataStart = dataStart;
        DataLength = dataLength;
        SkeletonTransformCount = skeletonTransformCount;
        MaterialCount = materialCount;
        BoneCount = boneCount;
        VertexBufferCount = vertexBufferCount;
        MeshCount = meshCount;
        FaceSetCount = faceSetCount;
        BufferLayoutCount = bufferLayoutCount;
        TextureCount = textureCount;
        BoundingBoxMinX = boundingBoxMinX;
        BoundingBoxMinY = boundingBoxMinY;
        BoundingBoxMinZ = boundingBoxMinZ;
        BoundingBoxMaxX = boundingBoxMaxX;
        BoundingBoxMaxY = boundingBoxMaxY;
        BoundingBoxMaxZ = boundingBoxMaxZ;
        FaceCount = faceCount;
        TotalFaceCount = totalFaceCount;
        Materials = materials;
        Bones = bones;
        Meshes = meshes;
        _dummies = dummies;
        _vertexBuffers = vertexBuffers;
        _bufferLayouts = bufferLayouts;
        _faceSets = faceSets;
        _textureSlots = textureSlots;
        _layoutWarnings = layoutWarnings;
        _unparsedGaps = new SortedSet<string>(StringComparer.Ordinal);
        RecordMaterialUnparsedTail();
    }

    public byte[] SourceBytes { get; }
    public string VersionString { get; }
    public int InternalVersion { get; }
    public int DataStart { get; }
    public int DataLength { get; }
    public int SkeletonTransformCount { get; }
    public int MaterialCount { get; }
    public int BoneCount { get; }
    public int VertexBufferCount { get; }
    public int MeshCount { get; }
    public int FaceSetCount { get; }
    public int BufferLayoutCount { get; }
    public int TextureCount { get; }
    public float BoundingBoxMinX { get; }
    public float BoundingBoxMinY { get; }
    public float BoundingBoxMinZ { get; }
    public float BoundingBoxMaxX { get; }
    public float BoundingBoxMaxY { get; }
    public float BoundingBoxMaxZ { get; }
    public int FaceCount { get; }
    public int TotalFaceCount { get; }
    public IReadOnlyList<FlverMaterialEntry> Materials { get; }
    public IReadOnlyList<FlverBoneEntry> Bones { get; }
    public IReadOnlyList<FlverMeshEntry> Meshes { get; }
    public IReadOnlyList<FlverDummyEntry> Dummies => _dummies;
    public string SourceHash => Hash(_source);

    /// <summary>首个 mesh 首 vertex buffer 的 stride；无 mesh 时为 0（兼容旧 envelope 字段）。</summary>
    public int VertexStride => Meshes.Count > 0 ? Meshes[0].VertexStride : 0;

    /// <summary>全部 vertex buffer 出现过的不同 stride（升序）。</summary>
    public int[] DistinctVertexStrides =>
        _vertexBuffers.Select(vb => vb.VertexSize).Distinct().OrderBy(s => s).ToArray();

    public IReadOnlyList<string> LayoutWarnings => _layoutWarnings;

    public FlverFaceSetEntry? GetFaceSet(int index) => index >= 0 && index < _faceSets.Count ? _faceSets[index] : null;
    public IReadOnlyList<FlverFaceSetEntry> GetFaceSets() => _faceSets;

    /// <summary>
    /// Returns the back-face policy of the same display FaceSet used by
    /// <see cref="GetMeshIndicesBase64"/>. Keeping this lookup on the native
    /// document prevents the renderer from silently defaulting every FLVER
    /// material to double-sided rendering.
    /// </summary>
    public bool? GetMeshCullBackfaces(int meshIndex)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var selection = SelectDisplayFaceSet(meshIndex, Meshes[meshIndex]);
        return selection.Failure == FaceSetSelectionFailure.None
            ? selection.FaceSet!.CullBackfaces
            : null;
    }

    /// <summary>
    /// 已识别但未解析的结构缺口（能力边界，不是数据异常）。
    /// 访问前会触发一次 mesh plan 构建，确保顶点语义缺口已被登记——否则「没人调用过
    /// BuildMeshPlan」与「真的没有缺口」不可区分。
    /// </summary>
    public IReadOnlyList<string> UnparsedGaps
    {
        get
        {
            EnsureVertexSemanticGapsProbed();
            return _unparsedGaps.ToArray();
        }
    }

    /// <summary>
    /// 依据解析完整性计算 authority。
    ///
    /// 降级依据有**两条**，不是一条：
    ///   ① _layoutWarnings：读到的东西不对（数据可疑）。
    ///   ② _unparsedGaps：有东西没读（能力边界）。
    ///
    /// ⚠️ 此前只有 ①。那让这个 getter 成为一批缺口的**共同放大器**：
    /// SemTangent/SemBitangent/SemVertexColor 三个语义声明后零引用、顶点语义 switch
    /// 无 default 分支、material 后 16 字节从未读取——全都在不写 warning 的路径上，
    /// 于是 11 个真实 Sekiro 样本一律报 native-verified、warnings=0（2026-08-08 实测），
    /// 而实际未解析的 member 有 194 个（tangent 93 / bitangent 22 / vertexColor 79），
    /// 每个 material 的后 16 字节（含 gxIndex，实测 11 个样本 505 条 material **全部**
    /// 非零）也从未读出。缺口不进入任何集合，就等于对上层不存在。
    ///
    /// 现在缺口会把 authority 降到 partial。这是**故意收紧**：native-verified 的含义
    /// 回到「本实现读到的东西已覆盖它宣称的结构」，而不是「没报错就算全对」。
    /// </summary>
    public string Authority
    {
        get
        {
            // 先探测再判定。顺序反了会有一个真实漏洞：BuildMeshPlan 自己也会写
            // layoutWarnings（越界引用等），若在探测之前就读 _layoutWarnings.Count，
            // 探测过程中新发现的警告在本次调用里看不到。
            EnsureVertexSemanticGapsProbed();
            if (_layoutWarnings.Count > 0) return "partial";
            if (_unparsedGaps.Count > 0) return "partial";
            try
            {
                for (var i = 0; i < Math.Min(Meshes.Count, 4); i++)
                {
                    if (GetMeshPositionsBase64(i, 8, allowTruncation: true) != null) return "native-verified";
                }
            }
            catch (Exception)
            {
                return "partial";
            }
            return "partial";
        }
    }

    // ------------------------------------------------------------------
    // 顶点/index 数据提取
    // ------------------------------------------------------------------

    /// <summary>单个语义在某个 vertex buffer 中的访问计划。</summary>
    private sealed class VertexMemberAccess
    {
        public int MemberIndex;
        public int VertexBufferIndex;
        public int BufferLayoutIndex;
        public int DataBase;   // 顶点 0 数据的绝对偏移
        public int Stride;     // VertexBuffer.VertexSize
        public int Count;      // VertexBuffer.VertexCount
        public int Offset;     // LayoutMember.StructOffset
        public uint Type;      // LayoutMember.Type
    }

    /// <summary>一个原生 VertexColor member；保留所有 member，不折叠重复语义。</summary>
    private sealed class VertexColorMemberCandidate
    {
        public int MemberIndex;
        public uint Type;
        public int VertexBufferIndex;
        public int BufferLayoutIndex;
        public int StructOffset;
        public VertexMemberAccess? Access;
    }

    /// <summary>一个 mesh 的顶点解码计划：按语义从该 mesh 各 vertex buffer 合并取址。</summary>
    private sealed class MeshDataPlan
    {
        public int VertexCount;
        public VertexMemberAccess? Position;
        public VertexMemberAccess? Normal;
        /// <summary>
        /// FLVER 的一个 UV member 不一定只包含一组坐标：UVPair/Short4/Half4 和
        /// UByte4Norm 都会按成熟 SoulsFormats 读取器展开成两组。保留 layout
        /// 顺序，供 MTD 的 Albedo1UVIndex/Albedo2UVIndex 选择。
        /// </summary>
        public List<VertexMemberAccess> UVs { get; } = new();
        public List<VertexColorMemberCandidate> VertexColors { get; } = new();
        public VertexMemberAccess? Weights;
        public VertexMemberAccess? BoneIndices;
    }

    private MeshDataPlan? BuildMeshPlan(int meshIndex)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        if (mesh.VertexBufferIndices.Count == 0) return null;

        var plan = new MeshDataPlan { VertexCount = mesh.VertexCount };
        foreach (var vbIndex in mesh.VertexBufferIndices)
        {
            if (vbIndex < 0 || vbIndex >= _vertexBuffers.Count)
            {
                AddLayoutWarning($"mesh[{meshIndex}] 引用越界 vertex buffer {vbIndex}。");
                continue;
            }
            var vb = _vertexBuffers[vbIndex];
            if (vb.LayoutIndex < 0 || vb.LayoutIndex >= _bufferLayouts.Count)
            {
                AddLayoutWarning($"vertex buffer[{vbIndex}] 引用越界 layout {vb.LayoutIndex}。");
                continue;
            }
            var layout = _bufferLayouts[vb.LayoutIndex];
            var dataBase = (long)DataStart + vb.BufferOffset;
            if (dataBase < 0 || dataBase + (long)vb.VertexSize > _source.Length)
            {
                AddLayoutWarning($"vertex buffer[{vbIndex}] 数据越界 dataBase=0x{dataBase:X}。");
                continue;
            }
            var count = Math.Min(plan.VertexCount, vb.VertexCount);
            foreach (var member in layout.Members)
            {
                VertexColorMemberCandidate? vertexColorCandidate = null;
                if (member.Semantic == SemVertexColor)
                {
                    vertexColorCandidate = new VertexColorMemberCandidate
                    {
                        MemberIndex = member.Index,
                        Type = member.Type,
                        VertexBufferIndex = vbIndex,
                        BufferLayoutIndex = vb.LayoutIndex,
                        StructOffset = member.StructOffset
                    };
                    plan.VertexColors.Add(vertexColorCandidate);
                }
                var memberSize = MemberTypeSize(member.Type);
                if (memberSize <= 0)
                {
                    AddLayoutWarning($"layout[{vb.LayoutIndex}] member type=0x{member.Type:X} 未知大小。");
                    if (vertexColorCandidate is not null)
                        AddUnparsedGap(DescribeVertexColorMember(vertexColorCandidate) + " layout 大小未知，失败关闭。");
                    continue;
                }
                if (member.StructOffset < 0 || member.StructOffset + memberSize > vb.VertexSize)
                {
                    AddLayoutWarning($"layout[{vb.LayoutIndex}] member structOffset={member.StructOffset} size={memberSize} 越界 stride={vb.VertexSize}。");
                    if (vertexColorCandidate is not null)
                        AddUnparsedGap(DescribeVertexColorMember(vertexColorCandidate) + " structOffset 越界，失败关闭。");
                    continue;
                }
                var access = new VertexMemberAccess
                {
                    MemberIndex = member.Index,
                    VertexBufferIndex = vbIndex,
                    BufferLayoutIndex = vb.LayoutIndex,
                    DataBase = (int)dataBase,
                    Stride = vb.VertexSize,
                    Count = count,
                    Offset = member.StructOffset,
                    Type = member.Type
                };
                // 语义分派。位置、法线、权重、骨骼索引保留首个原生 member；
                // VertexColor 保留全部 member，供只读诊断完整传递。
                // UV 必须保留全部 member，因为一个 UV member 还可能展开为两组 UV。
                //
                // ⚠️ 这个 switch 此前没有 default 分支，于是两类东西被静默丢弃：
                //   ① 已定义但未实现的语义（SemTangent/SemBitangent）；
                //   ② 被 `when plan.X == null` 守卫挡掉的**第二个及以后**的同语义 member
                //      —— 实测 Sekiro 样本中这些重复 UV 正是材质第二层所需的坐标。
                switch (member.Semantic)
                {
                    case SemPosition when plan.Position == null: plan.Position = access; break;
                    case SemNormal when plan.Normal == null: plan.Normal = access; break;
                    case SemUV: plan.UVs.Add(access); break;
                    case SemBoneWeights when plan.Weights == null: plan.Weights = access; break;
                    case SemBoneIndices when plan.BoneIndices == null: plan.BoneIndices = access; break;
                    case SemVertexColor:
                        vertexColorCandidate!.Access = access;
                        if (!IsSupportedVertexColorType(member.Type))
                        {
                            AddUnparsedGap(DescribeVertexColorMember(vertexColorCandidate)
                                + " 只读 RGBA 仅支持 Float4/Color/UByte4Norm，失败关闭。");
                        }
                        break;

                    case SemTangent:
                        AddUnparsedGap($"vertex-semantic:tangent(0x{SemTangent:X}) 已定义未解析（type=0x{member.Type:X}）");
                        break;
                    case SemBitangent:
                        AddUnparsedGap($"vertex-semantic:bitangent(0x{SemBitangent:X}) 已定义未解析（type=0x{member.Type:X}）");
                        break;
                    // 被守卫挡掉的重复语义：数据完好，但本实现只取首个，其余未投影。
                    case SemPosition:
                    case SemNormal:
                    case SemBoneWeights:
                    case SemBoneIndices:
                        AddUnparsedGap($"vertex-semantic:0x{member.Semantic:X} 的第 2+ 个 member 未投影（index={member.Index} type=0x{member.Type:X}）");
                        break;

                    default:
                        AddUnparsedGap($"vertex-semantic:0x{member.Semantic:X} 未识别（type=0x{member.Type:X}）");
                        break;
                }
            }
        }
        return plan;
    }

    private bool TryExtractFloat3(VertexMemberAccess a, int vertexIndex, out float x, out float y, out float z)
    {
        x = y = z = 0f;
        var off = a.DataBase + (long)vertexIndex * a.Stride + a.Offset;
        if (off < 0 || off + 12 > _source.Length) return false;
        if (a.Type == TypeFloat3)
        {
            x = ReadFloat32(_source, (int)off);
            y = ReadFloat32(_source, (int)off + 4);
            z = ReadFloat32(_source, (int)off + 8);
            return float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z);
        }
        if (a.Type == TypeFloat4)
        {
            x = ReadFloat32(_source, (int)off);
            y = ReadFloat32(_source, (int)off + 4);
            z = ReadFloat32(_source, (int)off + 8);
            return float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z);
        }
        if (a.Type == TypeEdgeCompressed)
            return false; // 边压缩顶点不支持直接解码
        if (a.Type == TypeByte4A || a.Type == TypeByte4B || a.Type == TypeByte4C || a.Type == TypeByte4E)
        {
            x = (ReadByte(_source, (int)off) - 127) / 127f;
            y = (ReadByte(_source, (int)off + 1) - 127) / 127f;
            z = (ReadByte(_source, (int)off + 2) - 127) / 127f;
            return true;
        }
        if (a.Type == TypeShort4toFloat4A)
        {
            x = ReadInt16(_source, (int)off) / 32767f;
            y = ReadInt16(_source, (int)off + 2) / 32767f;
            z = ReadInt16(_source, (int)off + 4) / 32767f;
            return true;
        }
        if (a.Type == TypeShort4toFloat4B)
        {
            x = (ReadUInt16(_source, (int)off) - 32767) / 32767f;
            y = (ReadUInt16(_source, (int)off + 2) - 32767) / 32767f;
            z = (ReadUInt16(_source, (int)off + 4) - 32767) / 32767f;
            return true;
        }
        return false;
    }

    /// <summary>提取网格顶点位置（float[3] 每顶点）为 base64。stride 与 position 偏移取自真实 layout。</summary>
    public string? GetMeshPositionsBase64(int meshIndex, int maxVertices = 10_000, bool allowTruncation = false)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.Position == null || plan.VertexCount <= 0) return null;
        if (!allowTruncation && plan.VertexCount > maxVertices) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var positions = new float[vertexCount * 3];
        for (var v = 0; v < vertexCount; v++)
        {
            if (!TryExtractFloat3(plan.Position, v, out var x, out var y, out var z)) return null;
            positions[v * 3] = x;
            positions[v * 3 + 1] = y;
            positions[v * 3 + 2] = z;
        }
        var bytes = new byte[positions.Length * 4];
        Buffer.BlockCopy(positions, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>提取网格顶点法线（float[3] 每顶点，已按布局类型解码）为 base64。</summary>
    public string? GetMeshNormalsBase64(int meshIndex, int maxVertices = 10_000, bool allowTruncation = false)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.Normal == null || plan.VertexCount <= 0) return null;
        if (!allowTruncation && plan.VertexCount > maxVertices) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var normals = new float[vertexCount * 3];
        for (var v = 0; v < vertexCount; v++)
        {
            if (!TryExtractFloat3(plan.Normal, v, out var x, out var y, out var z)) return null;
            normals[v * 3] = x;
            normals[v * 3 + 1] = y;
            normals[v * 3 + 2] = z;
        }
        var bytes = new byte[normals.Length * 4];
        Buffer.BlockCopy(normals, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>
    /// 提取网格全部原生 UV 组（每组 float[2] 每顶点）为 base64。
    /// 展开顺序与 SoulsFormats Vertex.UVs 一致：一个 UVPair/Short4/Half4
    /// member 会产生连续的两组 UV，后续 layout member 接着编号。
    /// </summary>
    public IReadOnlyList<string>? GetMeshUVSetsBase64(int meshIndex, int maxVertices = 10_000, bool allowTruncation = false)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan is null || plan.UVs.Count == 0 || plan.VertexCount <= 0) return null;
        if (!allowTruncation && plan.VertexCount > maxVertices) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var uvFactor = InternalVersion >= 0x2000F ? 2048f : 1024f;
        var sets = new List<float[]>();
        Span<float> values = stackalloc float[4];
        foreach (var access in plan.UVs)
        {
            var setCount = UVSetCount(access.Type);
            if (setCount <= 0)
            {
                AddUnparsedGap($"vertex-semantic:UV type=0x{access.Type:X} 未支持；无法导出 UV 组");
                return null;
            }
            var decodedSets = new float[setCount][];
            for (var set = 0; set < setCount; set++)
                decodedSets[set] = new float[vertexCount * 2];

            for (var vertex = 0; vertex < vertexCount; vertex++)
            {
                if (!TryReadUVValues(access, vertex, uvFactor, values, out var decodedCount)
                    || decodedCount != setCount)
                    return null;
                for (var set = 0; set < decodedCount; set++)
                {
                    var target = decodedSets[set];
                    target[vertex * 2] = values[set * 2];
                    target[vertex * 2 + 1] = values[set * 2 + 1];
                }
            }
            sets.AddRange(decodedSets);
        }

        return sets.Select(values =>
        {
            var bytes = new byte[values.Length * sizeof(float)];
            Buffer.BlockCopy(values, 0, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }).ToArray();
    }

    /// <summary>提取网格第一组 UV（float[2] 每顶点）为 base64，兼容旧调用方。</summary>
    public string? GetMeshUVsBase64(int meshIndex, int maxVertices = 10_000, bool allowTruncation = false)
    {
        var sets = GetMeshUVSetsBase64(meshIndex, maxVertices, allowTruncation);
        return sets is { Count: > 0 } ? sets[0] : null;
    }

    private static int UVSetCount(uint type) => type switch
    {
        TypeFloat2 or TypeFloat3
            or TypeByte4A or TypeByte4B or TypeShort2toFloat2 or TypeUV => 1,
        TypeFloat4 or TypeByte4C or TypeUVPair or TypeShort4toFloat4B => 2,
        _ => 0
    };

    private bool TryReadUVValues(
        VertexMemberAccess access,
        int vertexIndex,
        float uvFactor,
        Span<float> output,
        out int setCount)
    {
        setCount = UVSetCount(access.Type);
        var offset = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (setCount <= 0 || offset < 0 || offset + MemberTypeSize(access.Type) > _source.Length)
        {
            setCount = 0;
            return false;
        }

        switch (access.Type)
        {
            case TypeFloat2:
            case TypeFloat3:
                output[0] = ReadFloat32(_source, (int)offset);
                output[1] = ReadFloat32(_source, (int)offset + 4);
                break;
            case TypeFloat4:
                output[0] = ReadFloat32(_source, (int)offset);
                output[1] = ReadFloat32(_source, (int)offset + 4);
                output[2] = ReadFloat32(_source, (int)offset + 8);
                output[3] = ReadFloat32(_source, (int)offset + 12);
                break;
            case TypeByte4A:
            case TypeByte4B:
            case TypeShort2toFloat2:
            case TypeUV:
                output[0] = ReadInt16(_source, (int)offset) / uvFactor;
                output[1] = ReadInt16(_source, (int)offset + 2) / uvFactor;
                break;
            case TypeByte4C:
                output[0] = ReadByte(_source, (int)offset) / 255f;
                output[1] = ReadByte(_source, (int)offset + 1) / 255f;
                output[2] = ReadByte(_source, (int)offset + 2) / 255f;
                output[3] = ReadByte(_source, (int)offset + 3) / 255f;
                break;
            case TypeUVPair:
            case TypeShort4toFloat4B:
                output[0] = ReadInt16(_source, (int)offset) / uvFactor;
                output[1] = ReadInt16(_source, (int)offset + 2) / uvFactor;
                output[2] = ReadInt16(_source, (int)offset + 4) / uvFactor;
                output[3] = ReadInt16(_source, (int)offset + 6) / uvFactor;
                break;
            default:
                setCount = 0;
                return false;
        }

        for (var index = 0; index < setCount * 2; index++)
        {
            if (!float.IsFinite(output[index]))
            {
                setCount = 0;
                return false;
            }
        }
        return true;
    }

    /// <summary>
    /// 按 SoulsFormats 的 VertexColor 读取分派，完整提取每一个 VertexColor member 的
    /// RGBA。Float4 保留原始 float（包括负值或大于 1 的值）；Color/UByte4Norm
    /// 按四个原生 byte 除以 255。结果是只读诊断，不是材质透明度，也不会把 alpha
    /// 投影成全局 opacity。未知/越界 layout 失败关闭且不返回部分颜色。
    /// </summary>
    public FlverVertexColorReadResult GetMeshVertexColorDiagnostics(
        int meshIndex, int maxVertices = 10_000, bool allowTruncation = false)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan is null || plan.VertexColors.Count == 0)
            return new FlverVertexColorReadResult("absent", Array.Empty<FlverVertexColorDiagnostic>(), null, null);
        if (plan.VertexCount <= 0)
        {
            return new FlverVertexColorReadResult(
                "invalid", Array.Empty<FlverVertexColorDiagnostic>(),
                "vertex-semantic:vertexColor 没有可读取的顶点。", null);
        }
        if (maxVertices <= 0)
        {
            return new FlverVertexColorReadResult(
                "invalid", Array.Empty<FlverVertexColorDiagnostic>(),
                "vertex-semantic:vertexColor maxVertices 必须大于 0。", null);
        }
        if (!allowTruncation && plan.VertexCount > maxVertices)
        {
            return new FlverVertexColorReadResult(
                "truncated", Array.Empty<FlverVertexColorDiagnostic>(),
                $"vertex-semantic:vertexColor 顶点数 {plan.VertexCount} 超过上限 {maxVertices}，未导出。", null);
        }

        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        if (vertexCount > int.MaxValue / 4)
        {
            return new FlverVertexColorReadResult(
                "invalid", Array.Empty<FlverVertexColorDiagnostic>(),
                $"vertex-semantic:vertexColor 顶点数 {vertexCount} 导出缓冲区过大，失败关闭。", null);
        }

        var members = new List<FlverVertexColorDiagnostic>(plan.VertexColors.Count);
        string? firstAlphaBase64 = null;
        Span<float> rgba = stackalloc float[4];
        for (var ordinal = 0; ordinal < plan.VertexColors.Count; ordinal++)
        {
            var candidate = plan.VertexColors[ordinal];
            var access = candidate.Access;
            if (access is null || !IsSupportedVertexColorType(candidate.Type))
            {
                var failure = DescribeVertexColorMember(candidate)
                    + " 未支持或布局无效；仅支持 Float4/Color/UByte4Norm，失败关闭。";
                AddUnparsedGap(failure);
                return new FlverVertexColorReadResult(
                    "unsupported", Array.Empty<FlverVertexColorDiagnostic>(), failure, null);
            }

            var values = new float[vertexCount * 4];
            var alpha = ordinal == 0 ? new float[vertexCount] : null;
            for (var vertex = 0; vertex < vertexCount; vertex++)
            {
                if (!TryReadVertexColor(access, vertex, rgba))
                {
                    var failure = DescribeVertexColorMember(candidate)
                        + $" 顶点 {vertex} RGBA 数据越界或非有限，失败关闭。";
                    AddUnparsedGap(failure);
                    return new FlverVertexColorReadResult(
                        "invalid", Array.Empty<FlverVertexColorDiagnostic>(), failure, null);
                }
                for (var channel = 0; channel < 4; channel++)
                    values[vertex * 4 + channel] = rgba[channel];
                if (alpha is not null)
                    alpha[vertex] = rgba[3];
            }

            members.Add(new FlverVertexColorDiagnostic(
                ordinal,
                candidate.MemberIndex,
                candidate.Type,
                VertexColorLayoutTypeName(candidate.Type),
                candidate.VertexBufferIndex,
                candidate.BufferLayoutIndex,
                candidate.StructOffset,
                EncodeFloatArray(values)));
            if (alpha is not null)
                firstAlphaBase64 = EncodeFloatArray(alpha);
        }

        return new FlverVertexColorReadResult("decoded", members, null, firstAlphaBase64);
    }

    /// <summary>
    /// 兼容旧调用方的首个 VertexColor alpha 投影。它只是独立只读属性/诊断，绝不是
    /// 全局透明度；完整 RGBA 必须消费 GetMeshVertexColorDiagnostics。
    /// </summary>
    public string? GetMeshVertexAlphaBase64(int meshIndex, int maxVertices = 10_000, bool allowTruncation = false)
        => GetMeshVertexColorDiagnostics(meshIndex, maxVertices, allowTruncation).FirstAlphaBase64;

    /// <summary>
    /// Extracts a complete GPU skin binding. Sekiro-era FLVER (> 0x2000D)
    /// stores vertex bone indices in the FLVER-global namespace; the per-mesh
    /// palette is only authoritative for older versions. Rigid vertices use
    /// NormalW (or the mesh default bone) with weight 1.
    /// </summary>
    public FlverMeshSkinning GetMeshSkinning(int meshIndex, int maxVertices = 10_000)
    {
        System.Threading.Interlocked.Increment(ref MapStaticGeometryService.SkinCalls);
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return FlverMeshSkinning.Static;
        var mesh = Meshes[meshIndex];
        var plan = BuildMeshPlan(meshIndex);
        if (plan == null || plan.VertexCount <= 0 || plan.VertexCount > maxVertices || Bones.Count == 0)
            return FlverMeshSkinning.Static;
        if (InternalVersion <= 0x2000D && mesh.BoneCount > 0 && mesh.BoneIndices.Count != mesh.BoneCount)
            return FlverMeshSkinning.Static;

        var weights = new float[plan.VertexCount * 4];
        var indices = new ushort[plan.VertexCount * 4];
        var allRigid = true;

        bool TryResolveIndex(int rawIndex, out ushort resolved)
        {
            var globalIndex = rawIndex;
            if (InternalVersion <= 0x2000D && mesh.BoneIndices.Count > 0)
            {
                if (rawIndex < 0 || rawIndex >= mesh.BoneIndices.Count)
                {
                    resolved = 0;
                    return false;
                }
                globalIndex = mesh.BoneIndices[rawIndex];
            }
            if (globalIndex < 0 || globalIndex >= Bones.Count || globalIndex > ushort.MaxValue)
            {
                resolved = 0;
                return false;
            }
            resolved = (ushort)globalIndex;
            return true;
        }

        Span<float> vertexWeights = stackalloc float[4];
        Span<int> rawIndices = stackalloc int[4];
        for (var vertex = 0; vertex < plan.VertexCount; vertex++)
        {
            vertexWeights.Clear();
            rawIndices.Clear();
            var hasDecodedWeights = plan.Weights != null
                && TryReadBoneWeights(plan.Weights, vertex, vertexWeights);
            var sum = hasDecodedWeights
                ? vertexWeights[0] + vertexWeights[1] + vertexWeights[2] + vertexWeights[3]
                : 0f;

            var hasDecodedIndices = plan.BoneIndices != null
                && TryReadBoneIndices(plan.BoneIndices, vertex, rawIndices);

            if (sum > 1e-5f && hasDecodedIndices)
            {
                allRigid = false;
                ushort firstResolved = 0;
                var hasResolved = false;
                for (var influence = 0; influence < 4; influence++)
                {
                    var weight = float.IsFinite(vertexWeights[influence])
                        ? Math.Max(0f, vertexWeights[influence]) / sum
                        : 0f;
                    weights[vertex * 4 + influence] = weight;
                    if (weight <= 1e-5f) continue;
                    if (!TryResolveIndex(rawIndices[influence], out var globalIndex))
                        return FlverMeshSkinning.Static;
                    indices[vertex * 4 + influence] = globalIndex;
                    if (!hasResolved)
                    {
                        firstResolved = globalIndex;
                        hasResolved = true;
                    }
                }
                if (!hasResolved) return FlverMeshSkinning.Static;
                for (var influence = 0; influence < 4; influence++)
                {
                    if (weights[vertex * 4 + influence] <= 1e-5f)
                        indices[vertex * 4 + influence] = firstResolved;
                }
                continue;
            }

            var rigidRawIndex = TryReadNormalW(plan.Normal, vertex, out var normalW)
                ? normalW
                : mesh.DefaultBoneIndex;
            if (!TryResolveIndex(rigidRawIndex, out var rigidIndex))
            {
                if (hasDecodedIndices && TryResolveIndex(rawIndices[0], out var firstIndex))
                    rigidIndex = firstIndex;
                else
                    return FlverMeshSkinning.Static;
            }
            for (var influence = 0; influence < 4; influence++)
                indices[vertex * 4 + influence] = rigidIndex;
            weights[vertex * 4] = 1f;
        }

        var weightBytes = new byte[weights.Length * sizeof(float)];
        var indexBytes = new byte[indices.Length * sizeof(ushort)];
        Buffer.BlockCopy(weights, 0, weightBytes, 0, weightBytes.Length);
        Buffer.BlockCopy(indices, 0, indexBytes, 0, indexBytes.Length);
        return new FlverMeshSkinning(
            allRigid ? "rigid" : "weighted",
            "flver-global",
            Convert.ToBase64String(weightBytes),
            Convert.ToBase64String(indexBytes));
    }

    public string? GetMeshBoneWeightsBase64(int meshIndex, int maxVertices = 10_000)
        => GetMeshSkinning(meshIndex, maxVertices).BoneWeightsBase64;

    public string? GetMeshBoneIndicesBase64(int meshIndex, int maxVertices = 10_000)
        => GetMeshSkinning(meshIndex, maxVertices).BoneIndicesBase64;

    private bool TryReadBoneWeights(VertexMemberAccess access, int vertexIndex, Span<float> output)
    {
        var offset = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (offset < 0) return false;
        switch (access.Type)
        {
            case TypeByte4C:
                if (offset + 4 > _source.Length) return false;
                for (var i = 0; i < 4; i++) output[i] = ReadByte(_source, (int)offset + i) / 255f;
                return true;
            case TypeByte4A:
                if (offset + 4 > _source.Length) return false;
                for (var i = 0; i < 4; i++) output[i] = Math.Max(0f, ReadSByte(_source, (int)offset + i) / 127f);
                return true;
            case TypeUVPair:
            case TypeShort4toFloat4A:
                if (offset + 8 > _source.Length) return false;
                for (var i = 0; i < 4; i++) output[i] = Math.Max(0f, ReadInt16(_source, (int)offset + i * 2) / 32767f);
                return true;
            default:
                return false;
        }
    }

    private bool TryReadBoneIndices(VertexMemberAccess access, int vertexIndex, Span<int> output)
    {
        var offset = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (offset < 0) return false;
        if (access.Type == TypeShortBoneIndices)
        {
            if (offset + 8 > _source.Length) return false;
            for (var i = 0; i < 4; i++) output[i] = ReadUInt16(_source, (int)offset + i * 2);
            return true;
        }
        if (access.Type is TypeByte4B or TypeByte4E)
        {
            if (offset + 4 > _source.Length) return false;
            for (var i = 0; i < 4; i++) output[i] = ReadByte(_source, (int)offset + i);
            return true;
        }
        return false;
    }

    private bool TryReadVertexColor(VertexMemberAccess access, int vertexIndex, Span<float> rgba)
    {
        rgba.Clear();
        if (vertexIndex < 0 || vertexIndex >= access.Count) return false;
        var byteCount = access.Type == TypeFloat4 ? 16 : 4;
        var offset = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (offset < 0 || offset > _source.Length || byteCount > _source.Length - offset)
            return false;

        switch (access.Type)
        {
            case TypeFloat4:
                for (var channel = 0; channel < 4; channel++)
                    rgba[channel] = ReadFloat32(_source, (int)offset + channel * sizeof(float));
                break;
            case TypeColor:
            case TypeUByte4Norm:
                for (var channel = 0; channel < 4; channel++)
                    rgba[channel] = ReadByte(_source, (int)offset + channel) / 255f;
                break;
            default:
                return false;
        }

        for (var channel = 0; channel < 4; channel++)
        {
            if (!float.IsFinite(rgba[channel])) return false;
        }
        return true;
    }

    private static bool IsSupportedVertexColorType(uint type)
        => type is TypeFloat4 or TypeColor or TypeUByte4Norm;

    private static string VertexColorLayoutTypeName(uint type) => type switch
    {
        TypeFloat4 => "Float4",
        TypeColor => "Color",
        TypeUByte4Norm => "UByte4Norm",
        _ => $"Unknown(0x{type:X})"
    };

    private static string DescribeVertexColorMember(VertexColorMemberCandidate member)
        => $"vertex-semantic:vertexColor memberIndex={member.MemberIndex} type=0x{member.Type:X} "
            + $"vertexBuffer={member.VertexBufferIndex} layout={member.BufferLayoutIndex} "
            + $"structOffset={member.StructOffset}";

    private static string EncodeFloatArray(float[] values)
    {
        var bytes = new byte[checked(values.Length * sizeof(float))];
        Buffer.BlockCopy(values, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    private bool TryReadNormalW(VertexMemberAccess? access, int vertexIndex, out int normalW)
    {
        normalW = -1;
        if (access == null) return false;
        var offset = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (offset < 0) return false;
        if (access.Type is TypeByte4A or TypeByte4B or TypeByte4C or TypeByte4E)
        {
            if (offset + 4 > _source.Length) return false;
            normalW = ReadByte(_source, (int)offset + 3);
            return true;
        }
        if (access.Type is TypeShort4toFloat4A or TypeShort4toFloat4B)
        {
            if (offset + 8 > _source.Length) return false;
            normalW = ReadUInt16(_source, (int)offset + 6);
            return true;
        }
        if (access.Type == TypeFloat4)
        {
            if (offset + 16 > _source.Length) return false;
            var value = ReadFloat32(_source, (int)offset + 12);
            if (!float.IsFinite(value)) return false;
            normalW = checked((int)MathF.Round(value));
            return true;
        }
        return false;
    }

    /// <summary>
    /// 受界 FaceSet 诊断：只在失败路径使用，说明当前 parser 沿 mesh reference order
    /// 实际看到了哪些 FaceSet，用于再次定位 FaceSet capability boundary。
    /// 不记录 index 数据、Base64、vertex payload；面集数量本身由 FLVER 决定且通常很小。
    /// </summary>
    private string DescribeMeshFaceSetCandidates(int meshIndex, FlverMeshEntry mesh)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append($"meshIndex={meshIndex}; faceSetRefs={mesh.FaceSetIndices.Count};");
        for (var ord = 0; ord < mesh.FaceSetIndices.Count; ord++)
        {
            var global = mesh.FaceSetIndices[ord];
            if (global < 0 || global >= _faceSets.Count)
            {
                sb.Append($" [ord={ord} global={global} OUT_OF_RANGE]");
                continue;
            }
            var fs = _faceSets[global];
            sb.Append($" [ord={ord} global={global} flags={fs.Flags}(0x{fs.Flags:X8})"
                + $" strip={(fs.TriangleStrip ? 1 : 0)} cull={(fs.CullBackfaces ? 1 : 0)}"
                + $" idxSize={fs.IndexSize} idxCount={fs.IndexCount}]");
        }
        return sb.ToString();
    }

    // FaceSet.Flags 的位含义以成熟工具（SoulsFormats FLVER2.FaceSet.FSFlags）作为语义对照，
    // 但授权来自本项目自己 parser 在真实 Sekiro 语料上的解析结果。
    private const uint FaceSetFlagLodLevel1 = 0x0100_0000u;
    private const uint FaceSetFlagLodLevel2 = 0x0200_0000u;
    private const uint FaceSetFlagMotionBlur = 0x8000_0000u;
    private const uint FaceSetFlagEdgeCompressed = 0x4000_0000u;

    /// <summary>
    /// 已经证明不改变 index 数据编码的 flag 位集合。
    /// LodLevel1 / LodLevel2 / MotionBlur 只描述这一份面集的显示用途，
    /// 索引仍按 IndexSize 16/32 原样解码。EdgeCompressed（indexSize==8 的边压缩表）
    /// 明确不在其列：它改变的是索引本身的编码，任何情况下都不放行。
    /// </summary>
    private const uint FaceSetFlagsIndexEncodingNeutral =
        FaceSetFlagLodLevel1 | FaceSetFlagLodLevel2 | FaceSetFlagMotionBlur;

    /// <summary>
    /// 该面集是否能被当前 parser 以现有 index representation 完整解码。
    /// 任何出现在中性集合之外的位（含 EdgeCompressed 与未来未知位）都视为不安全。
    /// </summary>
    private static bool IsFaceSetIndexDecodable(FlverFaceSetEntry fs)
        => (fs.Flags & ~FaceSetFlagsIndexEncodingNeutral) == 0
            && (fs.IndexSize == 16 || fs.IndexSize == 32);

    /// <summary>
    /// 按 mesh reference order 选出本 mesh 唯一的 V1 display FaceSet。
    ///
    /// 真实 Sekiro 地图语料已经证明：合法地图数据中存在「该 mesh 引用的全部 FaceSet
    /// 都不是 Flags==0」的情况（m10_00_00_00 前 80 模型中 19 个整模型因此失败，
    /// 且这 19 个 mesh 每个都只引用 1 个 FaceSet，flags 为 LodLevel1/LodLevel2）。
    /// 因此「没有 Flags==0 就整 mesh 失败」不是可接受的 display projection 规则。
    ///
    /// 规则（严格按 reference order，永不重排、永不合并、永不向后扫描）：
    /// 1. candidates 为空 / 引用越界 / 没有候选 -> 调用方 fail closed，不伪造 geometry。
    /// 2. 存在 Flags==0 -> 取 reference order 中第一个（多个不再视为错误，reference order 已提供确定性）。
    /// 3. 不存在 Flags==0 -> 只看 reference order 中的第一项：
    ///    只有它能被当前 parser 完整解码（非 EdgeCompressed、IndexSize 16/32、无未知 flag 位）才选中；
    ///    否则 fail closed。绝不跳过它去找后面一个「碰巧能画」的面集。
    ///
    /// 本 helper 只做选择：不展开 triangle strip、不改 IndexSize、不截断、不过滤退化三角形、不做几何修复、不吞异常。
    /// </summary>
    private enum FaceSetSelectionFailure
    {
        None,
        /// <summary>mesh 没有引用任何 FaceSet；或引用越界。历史上 GetMeshIndexSize 抛、GetMeshIndicesBase64 返回 null。</summary>
        NoCandidate,
        /// <summary>没有 Flags==0，且 reference order 第一项不能被当前 parser 解码。两个调用方都 fail closed 抛异常。</summary>
        NotDecodable
    }

    private readonly record struct FaceSetSelection(
        FaceSetSelectionFailure Failure,
        FlverFaceSetEntry? FaceSet,
        int GlobalIndex,
        string? Diagnostic);

    private FaceSetSelection SelectDisplayFaceSet(int meshIndex, FlverMeshEntry mesh)
    {
        var diagnostic = DescribeMeshFaceSetCandidates(meshIndex, mesh);

        if (mesh.FaceSetIndices.Count == 0)
            return new FaceSetSelection(FaceSetSelectionFailure.NoCandidate, null, -1, diagnostic);

        foreach (var global in mesh.FaceSetIndices)
        {
            if (global < 0 || global >= _faceSets.Count)
                return new FaceSetSelection(FaceSetSelectionFailure.NoCandidate, null, -1, diagnostic);
        }

        foreach (var global in mesh.FaceSetIndices)
        {
            if (_faceSets[global].Flags == 0)
                return new FaceSetSelection(FaceSetSelectionFailure.None, _faceSets[global], global, diagnostic);
        }

        // 没有 Flags==0：只评估 reference order 的第一项，不向后扫描。
        var firstGlobal = mesh.FaceSetIndices[0];
        var first = _faceSets[firstGlobal];
        if (IsFaceSetIndexDecodable(first))
            return new FaceSetSelection(FaceSetSelectionFailure.None, first, firstGlobal, diagnostic);

        var message = (first.Flags & FaceSetFlagEdgeCompressed) != 0
            ? $"FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED: first referenced FaceSet is EdgeCompressed; {diagnostic}"
            : $"FLVER_DISPLAY_FACESET_UNSUPPORTED: no Flags==0 FaceSet and first referenced FaceSet is not decodable by this parser; {diagnostic}";
        return new FaceSetSelection(FaceSetSelectionFailure.NotDecodable, null, -1, message);
    }

    /// <summary>
    /// 当前 mesh 被选中的 display FaceSet 的全局序号（与 GetMeshIndicesBase64 使用同一个选择规则）。
    /// 供需要在 DTO 中回写 selectedFaceSetOrdinals 的调用方使用，避免各处复制一份选择逻辑。
    /// 选择失败时返回 -1，由调用方决定 fail closed 还是跳过。
    /// </summary>
    internal int GetDisplayFaceSetOrdinal(int meshIndex)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return -1;
        return SelectDisplayFaceSet(meshIndex, Meshes[meshIndex]).GlobalIndex;
    }

    /// <summary>获取网格主 FaceSet 的索引位宽（16 或 32 位）。display FaceSet 由 SelectDisplayFaceSet 统一决定。</summary>
    public int GetMeshIndexSize(int meshIndex)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) throw new InvalidDataException("FLVER_DISPLAY_FACESET_UNSUPPORTED: meshIndex out of range");
        var mesh = Meshes[meshIndex];
        // EdgeCompressed 由 flag 判定而非 indexSize 8；该判定已收进 SelectDisplayFaceSet。
        var selection = SelectDisplayFaceSet(meshIndex, mesh);
        if (selection.Failure != FaceSetSelectionFailure.None)
            throw new InvalidDataException($"FLVER_DISPLAY_FACESET_UNSUPPORTED: {selection.Diagnostic}");
        var selected = selection.FaceSet!;
        if (selected.IndexSize != 16 && selected.IndexSize != 32)
            throw new InvalidDataException($"FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED: effective IndexSize {selected.IndexSize} not in {{16,32}}");
        return selected.IndexSize == 32 ? 32 : 16;
    }

    /// <summary>
    /// 提取网格三角形索引为 base64。输出契约始终是 triangle-list；FLVER
    /// triangle strip 会在 Bridge 内按原生 primitive-restart / winding 语义展开。
    /// 索引位宽仍由 face set 的 IndexSize 决定，不允许调用方猜测。
    /// display FaceSet 由 SelectDisplayFaceSet 统一决定，与 GetMeshIndexSize 必然选中同一个面集：
    /// 优先 reference order 中第一个 Flags==0；不存在时只评估第一项，且其必须是当前 parser
    /// 可完整解码的非 EdgeCompressed 面集，否则 fail closed。CullBackfaces 保留在 record。
    /// </summary>
    public string? GetMeshIndicesBase64(int meshIndex, int maxIndices = 30_000, bool allowTruncation = false)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];

        // 与 GetMeshIndexSize 共用同一个选择规则，保证两个函数永远选中同一个 FaceSet。
        var selection = SelectDisplayFaceSet(meshIndex, mesh);
        // 没有候选（mesh 未引用 FaceSet / 引用越界）保持原有「跳过该 mesh」行为，不伪造 geometry。
        if (selection.Failure == FaceSetSelectionFailure.NoCandidate) return null;
        // 无法被当前 parser 解码 -> fail closed，不向后扫描找「碰巧能画」的面集。
        if (selection.Failure == FaceSetSelectionFailure.NotDecodable)
            throw new InvalidDataException(selection.Diagnostic!);
        var fs = selection.FaceSet!;
        if (fs.IndexSize != 16 && fs.IndexSize != 32) throw new InvalidDataException($"FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED: IndexSize {fs.IndexSize} not in {{16,32}}");
        if (fs.IndexCount <= 0 || fs.IndexCount > MaxIndexCount || maxIndices < 3) return null;
        var indexDataOffset = (long)DataStart + fs.IndicesOffset;
        var byteLen = fs.IndexCount * (fs.IndexSize / 8);
        if (indexDataOffset < 0 || indexDataOffset + byteLen > _source.Length) return null;

        var sourceIndices = new uint[fs.IndexCount];
        var stride = fs.IndexSize / 8;
        for (var i = 0; i < fs.IndexCount; i++)
        {
            var offset = checked((int)indexDataOffset + i * stride);
            sourceIndices[i] = fs.IndexSize == 32
                ? ReadUInt32(_source, offset)
                : ReadUInt16(_source, offset);
        }

        // Bounds validation: every source index must be < vertexCount before triangulation
        for (var i = 0; i < sourceIndices.Length; i++)
        {
            var idx = sourceIndices[i];
            if (idx == ushort.MaxValue && fs.TriangleStrip && mesh.VertexCount < 65535) continue; // sentinel allowed only when restart enabled
            if (idx >= (uint)mesh.VertexCount)
                throw new InvalidDataException($"FLVER_INDEX_OUT_OF_BOUNDS: mesh[{meshIndex}] index {idx} >= vertexCount {mesh.VertexCount}");
        }

        uint[] triangleList;
        if (fs.TriangleStrip)
        {
            var allowPrimitiveRestarts = mesh.VertexCount < 65535;
            triangleList = TriangulateFaceSet(sourceIndices, fs.IndexSize, allowPrimitiveRestarts);
        }
        else
        {
            // A non-strip face set is already a triangle list. A trailing partial
            // triangle is malformed and must not leak to Three.js as plausible data.
            if (sourceIndices.Length % 3 != 0) return null;
            triangleList = sourceIndices;
        }

        // Post-triangulation bounds: triangle list indices already bounds-checked via source, but degenerate removal keeps subset
        if (!allowTruncation && triangleList.Length > maxIndices) return null;
        var outputCount = Math.Min(triangleList.Length, maxIndices);
        outputCount -= outputCount % 3;
        if (outputCount <= 0) return null;
        var output = new byte[checked(outputCount * stride)];
        for (var i = 0; i < outputCount; i++)
        {
            var value = triangleList[i];
            if (fs.IndexSize == 16)
            {
                if (value > ushort.MaxValue) return null;
                BinaryPrimitives.WriteUInt16LittleEndian(output.AsSpan(i * stride, stride), (ushort)value);
            }
            else
            {
                BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(i * stride, stride), value);
            }
        }
        return Convert.ToBase64String(output);
    }

    /// <summary>
    /// 为已确认的角色投影材质导出其原生投影接收面。
    ///
    /// Sekiro 的 <c>P_FB_M_9510_Decal</c> FLVER 不是一张普通 UV 表面：同一个
    /// display FaceSet 内包含一个连续的皮肤接收面，以及眼睛、嘴、发片和辅助
    /// 投影岛。成熟工具会保留这些原生面集，只有在拥有对应游戏 shader 时才
    /// 把它们交给 shader。SoulForge 的兼容预览没有该 shader，因此只将原生
    /// triangle-list 中最大的连续接收面投影到显式兼容贴图；这不是按坐标或
    /// 名称猜测几何，也不修改 native payload，只是一个有边界的只读显示投影。
    ///
    /// 调用方必须已经依据 MTD 语义确认这是兼容投影路径；普通 FLVER 永远使用
    /// GetMeshIndicesBase64。组件选择保持三角形原顺序和原生索引位宽。
    /// </summary>
    public string? GetMeshProjectionReceiverIndicesBase64(int meshIndex, int maxIndices = 30_000)
    {
        if (maxIndices < 3) return null;
        var sourceBase64 = GetMeshIndicesBase64(meshIndex, MaxIndexCount, allowTruncation: false);
        if (sourceBase64 is null) return null;
        var indexSize = GetMeshIndexSize(meshIndex);
        var indexStride = indexSize / 8;
        if (indexStride is not (2 or 4)) return null;

        byte[] sourceBytes;
        try
        {
            sourceBytes = Convert.FromBase64String(sourceBase64);
        }
        catch (FormatException)
        {
            return null;
        }
        if (sourceBytes.Length == 0 || sourceBytes.Length % (indexStride * 3) != 0)
            return null;

        var vertexCount = Meshes[meshIndex].VertexCount;
        if (vertexCount <= 0) return null;
        var parent = new int[vertexCount];
        var rank = new byte[vertexCount];
        for (var vertex = 0; vertex < parent.Length; vertex++) parent[vertex] = vertex;

        int Find(int value)
        {
            var root = value;
            while (parent[root] != root) root = parent[root];
            while (parent[value] != value)
            {
                var next = parent[value];
                parent[value] = root;
                value = next;
            }
            return root;
        }

        void Union(int left, int right)
        {
            var leftRoot = Find(left);
            var rightRoot = Find(right);
            if (leftRoot == rightRoot) return;
            if (rank[leftRoot] < rank[rightRoot])
            {
                parent[leftRoot] = rightRoot;
            }
            else if (rank[leftRoot] > rank[rightRoot])
            {
                parent[rightRoot] = leftRoot;
            }
            else
            {
                parent[rightRoot] = leftRoot;
                rank[leftRoot]++;
            }
        }

        var indexCount = sourceBytes.Length / indexStride;
        var indices = new uint[indexCount];
        for (var index = 0; index < indexCount; index++)
        {
            var offset = index * indexStride;
            indices[index] = indexSize == 16
                ? ReadUInt16(sourceBytes, offset)
                : ReadUInt32(sourceBytes, offset);
            if (indices[index] >= (uint)vertexCount) return null;
        }

        var triangleCountByRoot = new Dictionary<int, int>();
        for (var triangle = 0; triangle < indexCount / 3; triangle++)
        {
            var offset = triangle * 3;
            var a = checked((int)indices[offset]);
            var b = checked((int)indices[offset + 1]);
            var c = checked((int)indices[offset + 2]);
            if (a == b || b == c || c == a) continue;
            Union(a, b);
            Union(b, c);
        }
        for (var triangle = 0; triangle < indexCount / 3; triangle++)
        {
            var offset = triangle * 3;
            var a = checked((int)indices[offset]);
            var b = checked((int)indices[offset + 1]);
            var c = checked((int)indices[offset + 2]);
            if (a == b || b == c || c == a) continue;
            var root = Find(a);
            triangleCountByRoot[root] = triangleCountByRoot.TryGetValue(root, out var count)
                ? count + 1
                : 1;
        }
        if (triangleCountByRoot.Count == 0) return null;

        // Deterministic tie-breaker: native triangle order has already been
        // preserved; the smallest root keeps identical inputs stable.
        var receiverRoot = triangleCountByRoot
            .OrderByDescending(pair => pair.Value)
            .ThenBy(pair => pair.Key)
            .First()
            .Key;
        var receiver = new List<uint>(triangleCountByRoot[receiverRoot] * 3);
        for (var triangle = 0; triangle < indexCount / 3; triangle++)
        {
            var offset = triangle * 3;
            var a = checked((int)indices[offset]);
            var b = checked((int)indices[offset + 1]);
            var c = checked((int)indices[offset + 2]);
            if (a == b || b == c || c == a || Find(a) != receiverRoot) continue;
            receiver.Add(indices[offset]);
            receiver.Add(indices[offset + 1]);
            receiver.Add(indices[offset + 2]);
        }
        if (receiver.Count == 0 || receiver.Count > maxIndices) return null;

        var output = new byte[checked(receiver.Count * indexStride)];
        for (var index = 0; index < receiver.Count; index++)
        {
            var value = receiver[index];
            var offset = index * indexStride;
            if (indexSize == 16)
                BinaryPrimitives.WriteUInt16LittleEndian(output.AsSpan(offset, indexStride), checked((ushort)value));
            else
                BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(offset, indexStride), value);
        }
        return Convert.ToBase64String(output);
    }

    /// <summary>
    /// SoulsFormats-compatible FLVER strip expansion. Degenerate triangles are
    /// omitted, winding flips after every strip step, and a restart resets the
    /// winding parity. Kept internal so synthetic regression fixtures can exercise
    /// the format rule without involving renderer behavior.
    /// Mature order: even step (a,b,c), odd step (c,b,a) per SoulsFormats.
    /// </summary>
    internal static uint[] TriangulateFaceSet(
        IReadOnlyList<uint> indices,
        int indexSize,
        bool allowPrimitiveRestarts)
    {
        if (indices.Count < 3) return Array.Empty<uint>();
        // SoulsFormats/FLVER2 uses the 16-bit primitive-restart sentinel for
        // both 16- and 32-bit face sets. It is not the uint32 max value.
        // Rule: only when triangleStrip && vertexCount < 65535, 0xFFFF restarts.
        var restart = (uint)ushort.MaxValue;
        var triangles = new List<uint>(Math.Max(0, (indices.Count - 2) * 3));
        var flip = false;
        for (var i = 0; i < indices.Count - 2; i++)
        {
            var a = indices[i];
            var b = indices[i + 1];
            var c = indices[i + 2];
            if (allowPrimitiveRestarts && (a == restart || b == restart || c == restart))
            {
                flip = false;
                continue;
            }

            if (a != b && b != c && c != a)
            {
                if (flip)
                {
                    triangles.Add(c);
                    triangles.Add(b);
                    triangles.Add(a);
                }
                else
                {
                    triangles.Add(a);
                    triangles.Add(b);
                    triangles.Add(c);
                }
            }
            flip = !flip;
        }
        return triangles.ToArray();
    }

    // ------------------------------------------------------------------
    // 纹理槽位与 Dummy
    // ------------------------------------------------------------------

    /// <summary>FLVER2 纹理槽位表（type/path 及所属材质）。</summary>
    public IReadOnlyList<FlverTextureSlotEntry> GetTextureSlots() => _textureSlots;

    /// <summary>FLVER2 Dummy 表（挂点）。</summary>
    public IReadOnlyList<FlverDummyEntry> GetDummies() => Dummies;

    // ------------------------------------------------------------------
    // 解析
    // ------------------------------------------------------------------

    public static FlverNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"FLVER 大小 {source.Length} 超出安全范围。");

        for (var i = 0; i < MagicBytes.Length; i++)
        {
            if (source[i] != MagicBytes[i])
                throw new InvalidDataException($"FLVER 魔数不匹配；偏移 {i} 处为 0x{source[i]:X2}，期望 0x{MagicBytes[i]:X2}。");
        }

        // 0x06 的两字节是 endian 标记（"L\0" = little-endian、"B\0" = big-endian）。
        //
        // 此前它只被当 UTF-16 字符串读走（versionString）却从不判断，而本类的全部
        // 读原语（ReadInt32/ReadInt64/ReadFloat32，见文件末尾）都硬绑 LittleEndian。
        // 于是 big-endian FLVER 的失效形态是**静默错解**而不是报错：魔数 FLVER\0
        // 与小端文件完全相同，必然通过上面那道检查，随后每个字段都被按小端错读，
        // 产出基于错位偏移的结果——而若那些垃圾值恰好落在越界检查的合法范围内
        // （:611 与 ComputeSectionEnd 是概率性拦截），还会带着 authority 一路上报。
        //
        // 照 TaeNativeDocument.cs:74 与 EsdNativeDocument.cs 的先例做**前置拒绝**
        // 而不是记 layoutWarning：warning 只降 authority，而这里的问题是「读出来的
        // 每个数都不可信」，继续解析没有意义。
        if (source[0x06] != (byte)'L' || source[0x07] != 0x00)
        {
            throw new NotSupportedException(
                $"仅支持 little-endian FLVER（偏移 0x06 处为 \"L\\0\"），"
                + $"收到 0x{source[0x06]:X2} 0x{source[0x07]:X2}。"
                + " big-endian 与 FLVER0 变体的魔数与小端文件相同，若不前置拒绝会被按"
                + " 小端静默错解——本解析器的读原语全部硬绑 LittleEndian。");
        }

        var versionString = ReadUtf16NullTerminated(source, 0x06, 4);
        var internalVersion = ReadInt32(source, 0x08);

        // internalVersion 白名单。此前只读不判，而 :388（UV 除数 2048 vs 1024）与
        // :704（indexSize 字段是否存在）已经在按 version 分支——也就是说不同版本的
        // 布局**确实不同**，读到未登记版本时那些分支会按错误假设走。
        //
        // 闭集刻意只含本机真实语料实测出现过的值（2026-08-08 实测 Sekiro
        // mods/chr 的 chrbnd：endian 恒 "L\0"、internalVersion 恒 0x2001A）。
        // 扩这个集合必须先有该版本的真实样本与往返验证，不能凭「大概兼容」加进来
        // ——那等于在未验证的前提下扩大 native 声明面。
        if (Array.IndexOf(SupportedInternalVersions, internalVersion) < 0)
        {
            var supported = string.Join(
                ", ",
                Array.ConvertAll(SupportedInternalVersions, v => $"0x{v:X}"));
            throw new NotSupportedException(
                $"仅支持已验证的 FLVER internalVersion（{supported}），"
                + $"收到 0x{internalVersion:X}。"
                + " 不同 version 的 UV 除数与 FaceSet indexSize 字段布局不同"
                + "（见本类的 version 分支），未登记版本会被按错误布局解析。"
                + " 要支持新版本需先登记该版本的真实样本并通过往返验证。");
        }

        var dataStart = ReadInt32(source, 0x0C);
        var dataLength = ReadInt32(source, 0x10);

        var skeletonTransformCount = ReadInt32(source, 0x14);
        var materialCount = ReadInt32(source, 0x18);
        var boneCount = ReadInt32(source, 0x1C);
        var meshCount = ReadInt32(source, 0x20);
        var vertexBufferCount = ReadInt32(source, 0x24);

        float bbMinX = ReadFloat32(source, 0x28);
        float bbMinY = ReadFloat32(source, 0x2C);
        float bbMinZ = ReadFloat32(source, 0x30);
        float bbMaxX = ReadFloat32(source, 0x34);
        float bbMaxY = ReadFloat32(source, 0x38);
        float bbMaxZ = ReadFloat32(source, 0x3C);

        var faceCount = ReadInt32(source, 0x40);
        var totalFaceCount = ReadInt32(source, 0x44);
        var vertexIndicesSize = ReadByte(source, 0x48);
        var unicode = source[0x49] != 0;

        var faceSetCount = ReadInt32(source, 0x50);
        var bufferLayoutCount = ReadInt32(source, 0x54);
        var textureCount = ReadInt32(source, 0x58);

        if (skeletonTransformCount < 0 || skeletonTransformCount > MaxSkeletonTransforms)
            throw new InvalidDataException($"FLVER skeletonTransformCount={skeletonTransformCount} 超出安全范围。");
        if (materialCount < 0 || materialCount > MaxMaterials)
            throw new InvalidDataException($"FLVER materialCount={materialCount} 超出安全范围。");
        if (boneCount < 0 || boneCount > MaxBones)
            throw new InvalidDataException($"FLVER boneCount={boneCount} 超出安全范围。");
        if (meshCount < 0 || meshCount > MaxMeshes)
            throw new InvalidDataException($"FLVER meshCount={meshCount} 超出安全范围。");
        if (vertexBufferCount < 0 || vertexBufferCount > MaxVertexBuffers)
            throw new InvalidDataException($"FLVER vertexBufferCount={vertexBufferCount} 超出安全范围。");
        if (faceSetCount < 0 || faceSetCount > MaxFaceSets)
            throw new InvalidDataException($"FLVER faceSetCount={faceSetCount} 超出安全范围。");
        if (bufferLayoutCount < 0 || bufferLayoutCount > MaxBufferLayouts)
            throw new InvalidDataException($"FLVER bufferLayoutCount={bufferLayoutCount} 超出安全范围。");
        if (textureCount < 0 || textureCount > MaxTextures)
            throw new InvalidDataException($"FLVER textureCount={textureCount} 超出安全范围。");
        if (dataStart < 0 || dataStart > source.Length)
            throw new InvalidDataException($"FLVER dataStart={dataStart} 超出文件大小 {source.Length}。");
        if (dataLength < 0 || (long)dataStart + dataLength > source.Length)
            throw new InvalidDataException($"FLVER dataStart+dataLength={dataStart}+{dataLength} 超出文件大小 {source.Length}。");

        var warnings = new List<string>();
        var sectionEnd = ComputeSectionEnd(source, skeletonTransformCount, materialCount, boneCount, meshCount,
            faceSetCount, vertexBufferCount, bufferLayoutCount, textureCount, internalVersion);
        if (sectionEnd > dataStart)
        {
            // 结构表理应结束于 dataStart 之前；越界说明计数或长度被破坏。
            throw new InvalidDataException($"FLVER 结构表越过 dataStart：sectionEnd=0x{sectionEnd:X} dataStart=0x{dataStart:X}。");
        }

        var off = HeaderSize;
        // --- Dummies（64B/条）---
        var dummies = new List<FlverDummyEntry>(skeletonTransformCount);
        for (var i = 0; i < skeletonTransformCount; i++, off += DummySize)
        {
            float posX = ReadFloat32(source, off + 0x00);
            float posY = ReadFloat32(source, off + 0x04);
            float posZ = ReadFloat32(source, off + 0x08);
            short referenceId = ReadInt16(source, off + 0x1C);
            short parentBoneIndex = ReadInt16(source, off + 0x1E);
            short attachBoneIndex = ReadInt16(source, off + 0x2C);
            dummies.Add(new FlverDummyEntry(i, posX, posY, posZ, referenceId, parentBoneIndex, attachBoneIndex));
        }

        // --- Materials（32B/条）---
        // 全 32 字节都读：前 16 是名字/MTD/贴图索引，后 16 是 Flags / GxOffset / Unk18 /
        // 保留字段。后 16 字节此前整段未读（只登记为缺口），现按双源核对的规范解析。
        var materials = new List<FlverMaterialEntry>(materialCount);
        for (var i = 0; i < materialCount; i++, off += MaterialSize)
        {
            int nameOffset = ReadInt32(source, off + 0x00);
            int mtdOffset = ReadInt32(source, off + 0x04);
            int textureCountInMaterial = ReadInt32(source, off + 0x08);
            int firstTextureIndex = ReadInt32(source, off + 0x0C);
            int flags = ReadInt32(source, off + 0x10);
            int gxOffset = ReadInt32(source, off + 0x14);
            int unk18 = ReadInt32(source, off + 0x18);
            int reserved = ReadInt32(source, off + 0x1C);
            string name = ReadStringAtOffset(source, nameOffset, unicode);
            string mtdPath = ReadStringAtOffset(source, mtdOffset, unicode);

            // 规范要求 +0x1C 恒为 0（两份实现都是 AssertInt32(0)）。实测 505/505 成立。
            // 这里**不抛异常**而是记 layoutWarning：FLVER 是只读预览路径，为一个保留
            // 字段拒绝整个文件会把「布局有出入」升级成「文件不可读」，代价不对等。
            if (reserved != 0)
                warnings.Add($"material[{i}]:+0x1C 保留字段应为 0，实际 {reserved}（布局可能与已登记形态不同）。");

            FlverGxList? gxList = null;
            if (gxOffset != 0)
            {
                gxList = TryReadGxList(source, gxOffset, out var gxError);
                // 解析失败必须留痕：GX 列表读不出来时若静默置 null，
                // 「该 material 没有 GX 列表」与「有但没读懂」在输出上不可区分。
                if (gxList is null)
                    warnings.Add($"material[{i}]:GX 列表解析失败（gxOffset={gxOffset}）：{gxError}");
            }

            materials.Add(new FlverMaterialEntry(
                i, name, mtdPath, textureCountInMaterial, firstTextureIndex,
                flags, gxOffset, unk18, gxList));
        }

        // --- Bones（128B/条）---
        var bones = new List<FlverBoneEntry>(boneCount);
        for (var i = 0; i < boneCount; i++, off += BoneSize)
        {
            float translationX = ReadFloat32(source, off + 0x00);
            float translationY = ReadFloat32(source, off + 0x04);
            float translationZ = ReadFloat32(source, off + 0x08);
            int nameOffset = ReadInt32(source, off + 0x0C);
            float rotationX = ReadFloat32(source, off + 0x10);
            float rotationY = ReadFloat32(source, off + 0x14);
            float rotationZ = ReadFloat32(source, off + 0x18);
            short parentIndex = ReadInt16(source, off + 0x1C);
            short childIndex = ReadInt16(source, off + 0x1E);
            float scaleX = ReadFloat32(source, off + 0x20);
            float scaleY = ReadFloat32(source, off + 0x24);
            float scaleZ = ReadFloat32(source, off + 0x28);
            short nextSiblingIndex = ReadInt16(source, off + 0x2C);
            string name = ReadStringAtOffset(source, nameOffset, unicode);
            bones.Add(new FlverBoneEntry(i, name, nextSiblingIndex, parentIndex, childIndex,
                translationX, translationY, translationZ,
                rotationX, rotationY, rotationZ,
                scaleX, scaleY, scaleZ));
        }

        // --- Meshes（48B/条）---
        var meshes = new List<FlverMeshEntry>(meshCount);
        for (var i = 0; i < meshCount; i++, off += MeshSize)
        {
            byte dynamic = ReadByte(source, off + 0x00);
            int materialIndex = ReadInt32(source, off + 0x04);
            int defaultBoneIndex = ReadInt32(source, off + 0x10);
            int boneCountInMesh = ReadInt32(source, off + 0x14);
            int boneOffset = ReadInt32(source, off + 0x1C);
            int faceSetCountInMesh = ReadInt32(source, off + 0x20);
            int faceSetOffset = ReadInt32(source, off + 0x24);
            int vertexBufferCountInMesh = ReadInt32(source, off + 0x28);
            int vertexBufferOffset = ReadInt32(source, off + 0x2C);

            // Mesh.BoneIndices is a palette of global skeleton indices. Its
            // bounds are the skeleton bone table, not the mesh table; using
            // meshCount here silently discarded valid palettes whenever a
            // mesh referenced a bone index above the number of meshes.
            var boneIndices = ReadIndexArray(source, boneOffset, boneCountInMesh, boneCount);
            var faceSetIndices = ReadIndexArray(source, faceSetOffset, faceSetCountInMesh, faceSetCount);
            var vertexBufferIndices = ReadIndexArray(source, vertexBufferOffset, vertexBufferCountInMesh, vertexBufferCount);

            // 解析 mesh 的顶点信息：从该 mesh 引用的第一个 vertex buffer 取 stride/layout/vertexCount。
            int vertexCount = 0, vertexStride = 0, bufferLayoutIndex = -1, indexFormat = 0;
            var firstVbIndex = vertexBufferIndices.Count > 0 ? vertexBufferIndices[0] : -1;
            if (firstVbIndex >= 0 && firstVbIndex < vertexBufferCount)
            {
                // vertex buffer 段在 mesh 表之后；延迟到 vertex buffer 段解析后回填。
            }
            meshes.Add(new FlverMeshEntry(i, dynamic, materialIndex, defaultBoneIndex,
                vertexBufferCountInMesh, vertexBufferIndices,
                vertexCount, vertexStride, bufferLayoutIndex,
                faceSetCountInMesh, faceSetIndices, indexFormat,
                boneCountInMesh, boneIndices));
        }

        // --- FaceSets（32B/条）---
        var faceSets = new List<FlverFaceSetEntry>(faceSetCount);
        for (var i = 0; i < faceSetCount; i++, off += FaceSetSize)
        {
            uint flags = ReadUInt32(source, off + 0x00);
            bool triangleStrip = source[off + 0x04] != 0;
            bool cullBackfaces = source[off + 0x05] != 0; // SoulsFormats FLVER2.FaceSet.CullBackfaces at 0x05
            int indexCount = ReadInt32(source, off + 0x08);
            int indicesOffset = ReadInt32(source, off + 0x0C);
            int indexSize = internalVersion > 0x20005 ? ReadInt32(source, off + 0x18) : 0;
            if (indexSize == 0) indexSize = vertexIndicesSize;
            // Validate CullBackfaces only when Flags already known; record raw for DTO
            faceSets.Add(new FlverFaceSetEntry(flags, triangleStrip, cullBackfaces, indexCount, indicesOffset, indexSize));
        }

        // --- VertexBuffers（32B/条）---
        var vertexBuffers = new List<FlverVertexBufferEntry>(vertexBufferCount);
        for (var i = 0; i < vertexBufferCount; i++, off += VertexBufferSize)
        {
            int bufferIndex = ReadInt32(source, off + 0x00);
            int layoutIndex = ReadInt32(source, off + 0x04);
            int vertexSize = ReadInt32(source, off + 0x08);
            int vertexCountInBuffer = ReadInt32(source, off + 0x0C);
            int bufferLength = ReadInt32(source, off + 0x18);
            int bufferOffset = ReadInt32(source, off + 0x1C);
            vertexBuffers.Add(new FlverVertexBufferEntry(bufferIndex, layoutIndex, vertexSize, vertexCountInBuffer, bufferLength, bufferOffset));
        }

        // --- BufferLayouts（16B header + 20B member）---
        var bufferLayouts = new List<FlverBufferLayoutEntry>(bufferLayoutCount);
        for (var i = 0; i < bufferLayoutCount; i++, off += BufferLayoutHeaderSize)
        {
            int memberCount = ReadInt32(source, off + 0x00);
            int memberOffset = ReadInt32(source, off + 0x0C);
            if (memberCount < 0 || memberCount > MaxMembersPerLayout)
                throw new InvalidDataException($"FLVER bufferLayout[{i}] memberCount={memberCount} 超出安全范围。");
            var members = new List<FlverLayoutMemberEntry>(memberCount);
            var memberBase = (long)memberOffset;
            if (memberBase + (long)memberCount * LayoutMemberSize > dataStart)
                throw new InvalidDataException($"FLVER bufferLayout[{i}] member 表越界。");
            for (var m = 0; m < memberCount; m++)
            {
                var e = (int)memberBase + m * LayoutMemberSize;
                int unk00 = ReadInt32(source, e + 0x00);
                int structOffset = ReadInt32(source, e + 0x04);
                uint type = ReadUInt32(source, e + 0x08);
                uint semantic = ReadUInt32(source, e + 0x0C);
                int index = ReadInt32(source, e + 0x10);
                members.Add(new FlverLayoutMemberEntry(unk00, structOffset, type, semantic, index));
            }
            bufferLayouts.Add(new FlverBufferLayoutEntry(members));
        }

        // --- Textures（32B/条）---
        var textureSlots = new List<FlverTextureSlotEntry>(textureCount);
        for (var i = 0; i < textureCount; i++, off += TextureSize)
        {
            int pathOffset = ReadInt32(source, off + 0x00);
            int typeOffset = ReadInt32(source, off + 0x04);
            string path = ReadStringAtOffset(source, pathOffset, unicode);
            string type = ReadStringAtOffset(source, typeOffset, unicode);

            int materialIndex = -1;
            for (var m = 0; m < materials.Count; m++)
            {
                int first = materials[m].FirstTextureIndex;
                int count = materials[m].TextureCount;
                if (i >= first && i < first + count) { materialIndex = m; break; }
            }
            textureSlots.Add(new FlverTextureSlotEntry(i, type, path, materialIndex));
        }

        // --- 回填 mesh 顶点信息（vertex buffer/layout 段已解析）---
        var resolvedMeshes = new List<FlverMeshEntry>(meshes.Count);
        foreach (var mesh in meshes)
        {
            int vertexCount = 0, vertexStride = 0, bufferLayoutIndex = -1, indexFormat = 0;
            if (mesh.VertexBufferIndices.Count > 0)
            {
                var vbIndex = mesh.VertexBufferIndices[0];
                if (vbIndex >= 0 && vbIndex < vertexBuffers.Count)
                {
                    var vb = vertexBuffers[vbIndex];
                    vertexCount = vb.VertexCount;
                    vertexStride = vb.VertexSize;
                    bufferLayoutIndex = vb.LayoutIndex;
                }
                else
                {
                    warnings.Add($"mesh[{mesh.Index}] 引用的 vertex buffer {vbIndex} 越界。");
                }
            }
            // 24.9.1: mesh-level display FaceSet 选择必须按 mesh 引用顺序选 Flags==0，不 fallback。
            // N4 旧代码用 FirstOrDefault(int) 恒返回 0 导致死代码 + file-level faceSets[0]  scope 错误。
            int? resolvedFsIndex = null;
            var meshCandidates = mesh.FaceSetIndices
                .Where(idx => idx >= 0 && idx < faceSets.Count)
                .Select(idx => idx)
                .ToList();
            var hasDisplay = meshCandidates.Any(idx => faceSets[idx].Flags == 0);
            if (hasDisplay)
            {
                resolvedFsIndex = meshCandidates.First(idx => faceSets[idx].Flags == 0);
            }
            else
            {
                // No display FaceSet: do not fallback to mesh's first or file's faceSets[0]; leave indexFormat 0 to signal unsupported
                resolvedFsIndex = null;
            }
            if (resolvedFsIndex.HasValue && resolvedFsIndex.Value >= 0 && resolvedFsIndex.Value < faceSets.Count)
                indexFormat = faceSets[resolvedFsIndex.Value].IndexSize;

            resolvedMeshes.Add(mesh with
            {
                VertexCount = vertexCount,
                VertexStride = vertexStride,
                BufferLayoutIndex = bufferLayoutIndex,
                IndexFormat = indexFormat
            });
        }

        return new FlverNativeDocument(
            source, versionString, internalVersion, dataStart, dataLength,
            skeletonTransformCount, materialCount, boneCount, vertexBufferCount, meshCount,
            faceSetCount, bufferLayoutCount, textureCount, unicode,
            bbMinX, bbMinY, bbMinZ, bbMaxX, bbMaxY, bbMaxZ,
            faceCount, totalFaceCount,
            dummies, materials, bones, resolvedMeshes, vertexBuffers, bufferLayouts, faceSets, textureSlots,
            warnings);
    }

    /// <summary>
    /// 按 FLVER2 规范读一个 GX 列表。失败返回 null 并通过 <paramref name="error"/> 给出原因，
    /// **不抛异常**——FLVER 是只读预览路径，为一处未识别的材质扩展拒绝整个模型文件，
    /// 会把「布局有出入」升级成「文件不可读」，代价不对等。失败原因由调用方记进
    /// layoutWarnings，从而压 authority 到 partial：读不懂也必须留痕。
    ///
    /// ── 结构依据（双源核对，2026-08-08）──
    /// JKAnderson/SoulsFormats 与 soulsmods/SoulsFormatsNEXT 的 FLVER2 GXList/GXItem
    /// 逐字段一致：
    ///   · item 循环：读到 <c>id == int.MaxValue</c> 或 <c>id == -1</c> 即停，该 id 是终止 ID；
    ///   · item 头 12 字节：id(int32) / unk04(int32) / length(int32)，
    ///     payload 长度 = length − 12，**length 含头**；
    ///   · 终止记录：终止 id 之后紧跟恒为 100 的 int32，再一个 int32，
    ///     真实填充长度 = 该值 − 0xC，填充区按规范全零。
    ///
    /// ── 真实语料验证 ──
    /// 11 个 Sekiro chrbnd 的 505 条 material（全部 gxOffset 非零）：
    /// **505/505 解析成功、零错误**；常量 100 命中 505/505；填充全零 505/505；
    /// item 数分布 1×392 / 2×56 / 3×8 / 5×34 / 7×14 / 9×1；
    /// ID 为 4 字节 ASCII（GX00 505、GXMD 64、GX04 49、GX15 41、GX80/GX81 各 34…）。
    ///
    /// ── 两处与本文件旧注释的分歧（旧注释已作废）──
    /// ① 旧注释称 material +0x10 是 <c>gxIndex</c>。**不对**：+0x10 是 <c>Flags</c>，
    ///    +0x14 才是 GX 列表的**字节偏移**。两份实现都是先 <c>Flags = ReadInt32()</c>
    ///    再 <c>int gxOffset = ReadInt32()</c>；实测 505 条的 +0x14 逐条严格单调递增、
    ///    相邻差值以 64 为主（384/504 条），且全部 &lt; dataOffset —— 偏移的形态，
    ///    不是索引。SoulsFormats 的公开属性 <c>GXIndex</c> 是**去重后**的列表序号
    ///    （由 gxOffset → 列表表的映射得来），不是文件里的字段。
    /// ② SoulsFormatsNEXT 把 +0x18 命名为 <c>Index</c>，但实测它**不是 material 序号**：
    ///    11 个样本无一满足 <c>+0x18 == i</c>（c1020 前五条是 0,1,2,2,0）。故此处保留
    ///    中性名 <c>Unk18</c> 并如实标注，不按上游命名反推语义。
    ///
    /// payload 一律**不解释**：各 GX ID 的字段语义按材质着色参数分歧，
    /// 未经真实往返验证解码它就是在未验证前提下扩大 native 声明面。
    /// 这里只导出 (id, unk04, length) 与长度，与 ESD 的 RPN 字节码同一口径。
    /// </summary>
    private static FlverGxList? TryReadGxList(byte[] source, int gxOffset, out string error)
    {
        error = string.Empty;
        // 上界用 12 而不是 0：终止记录本身就要 12 字节，连它都放不下时偏移必然不合法。
        if (gxOffset < 0 || (long)gxOffset + 12 > source.Length)
        {
            error = $"偏移越界（文件 {source.Length} 字节）";
            return null;
        }

        var items = new List<FlverGxItem>();
        var position = gxOffset;
        // 上限防御：畸形长度可能构造出不前进的循环。505 条实测最多 9 项，
        // 512 留足余量而不至于让坏数据把进程拖死。
        const int maxItems = 512;
        while (true)
        {
            if (items.Count > maxItems)
            {
                error = $"item 数超过安全上限 {maxItems}";
                return null;
            }
            if ((long)position + 12 > source.Length)
            {
                error = "item 头越界";
                return null;
            }
            var id = ReadInt32(source, position);
            if (id == int.MaxValue || id == -1) break;   // 终止哨兵
            var unk04 = ReadInt32(source, position + 4);
            var itemLength = ReadInt32(source, position + 8);
            // itemLength 含 12 字节头，故 < 12 不合法；== 12 是合法的「无 payload」。
            // 不校验这一条会让 itemLength <= 0 造出原地死循环。
            if (itemLength < 12 || (long)position + itemLength > source.Length)
            {
                error = $"item 长度不合法（{itemLength}）";
                return null;
            }
            var idAscii = System.Text.Encoding.ASCII.GetString(source, position, 4);
            items.Add(new FlverGxItem(idAscii, id, unk04, itemLength, itemLength - 12));
            position += itemLength;
        }

        var terminatorId = ReadInt32(source, position);
        var hundred = ReadInt32(source, position + 4);
        if (hundred != 100)
        {
            // 规范里这是 AssertInt32(100)。实测 505/505 命中，不符说明布局与已登记形态
            // 不同——如实报失败而不是猜着往下读。
            error = $"终止记录的常量应为 100，实际 {hundred}";
            return null;
        }
        var rawLength = ReadInt32(source, position + 8);
        var terminatorLength = rawLength - 0xC;
        if (terminatorLength < 0 || (long)position + 12 + terminatorLength > source.Length)
        {
            error = $"终止填充长度不合法（{terminatorLength}）";
            return null;
        }
        var paddingAllZero = true;
        for (var k = 0; k < terminatorLength; k++)
        {
            if (source[position + 12 + k] != 0) { paddingAllZero = false; break; }
        }

        var endOffset = position + 12 + terminatorLength;
        return new FlverGxList(items, terminatorId, terminatorLength, paddingAllZero, endOffset - gxOffset);
    }

    private static long ComputeSectionEnd(
        byte[] source,
        int dummyCount, int materialCount, int boneCount, int meshCount,
        int faceSetCount, int vertexBufferCount, int bufferLayoutCount, int textureCount,
        int internalVersion)
    {
        long off = HeaderSize;
        off += (long)dummyCount * DummySize;
        off += (long)materialCount * MaterialSize;
        off += (long)boneCount * BoneSize;
        off += (long)meshCount * MeshSize;
        off += (long)faceSetCount * FaceSetSize;
        off += (long)vertexBufferCount * VertexBufferSize;
        off += (long)bufferLayoutCount * BufferLayoutHeaderSize;
        off += (long)textureCount * TextureSize;
        if (internalVersion >= 0x2001A)
            off += SekiroUnkHeaderSize; // SekiroUnk 为变长；仅统计固定头部用于越界判断
        return off;
    }

    private static List<int> ReadIndexArray(byte[] source, int offset, int count, int maxValid)
    {
        if (count < 0 || count > maxValid) return new List<int>();
        if (offset < 0 || (long)offset + (long)count * 4 > source.Length) return new List<int>();
        var list = new List<int>(count);
        for (var i = 0; i < count; i++)
            list.Add(ReadInt32(source, offset + i * 4));
        return list;
    }

    public static FlverNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("FLVER 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"FLVER 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    /// <summary>
    /// 重解析确定性检查（**不是**字节级往返验证）。
    ///
    /// FLVER 没有 writer，因此不存在「重建后与源比对」这件事可做。此前这里写的是
    /// <c>_source.AsSpan().SequenceEqual(reparsed.SourceBytes)</c>——而 Read(_source)
    /// 保存的就是同一个数组引用，所以那是「数组与自身比」，恒真。上层却据此发出
    /// FLVER_DOCUMENT_ROUNDTRIP_BYTE_VERIFIED 与「字节级一致」的文案，对一个无
    /// writer 的解析器是过强表述。
    ///
    /// 现在如实表达能验证的东西：同一输入两次解析必须得到相同的结构化结论
    /// （ReparseDeterministic）。这能抓到解析器里的可变静态状态、缓存污染、
    /// 依赖迭代顺序的哈希等真实缺陷；它**不**证明无损可写。
    /// </summary>
    public FlverRoundTripReport VerifyRoundTrip()
    {
        // 刻意从字节副本重新解析，而不是复用 _source 引用：只有这样两次解析才是
        // 真正独立的两次，恒真的自比对才被消除。
        var reparsed = Read(_source.ToArray());
        var byteIdentical = _source.AsSpan().SequenceEqual(reparsed.SourceBytes);
        var semanticIdentical = byteIdentical
            && reparsed.InternalVersion == InternalVersion
            && reparsed.SkeletonTransformCount == SkeletonTransformCount
            && reparsed.MaterialCount == MaterialCount
            && reparsed.BoneCount == BoneCount
            && reparsed.MeshCount == MeshCount
            && reparsed.FaceCount == FaceCount
            && reparsed.TotalFaceCount == TotalFaceCount
            && reparsed.Materials.Count == Materials.Count
            && reparsed.Bones.Count == Bones.Count
            && reparsed.Meshes.Count == Meshes.Count;
        return new FlverRoundTripReport(
            byteIdentical, semanticIdentical,
            SourceHash, Hash(reparsed.SourceBytes),
            SkeletonTransformCount, MaterialCount, BoneCount, MeshCount);
    }

    public object ToEnvelope(FlverRoundTripReport? report = null)
    {
        var rt = report ?? VerifyRoundTrip();
        // 顺序要紧：Authority 会触发缺口探测，必须在读 gaps 之前求值，
        // 否则 envelope 里的 unparsedGaps 会比 authority 少看到一轮登记。
        var authority = Authority;
        var gaps = UnparsedGaps;
        var meshSamples = Meshes.Take(SampleLimit).Select(m => new
        {
            index = m.Index,
            dynamic = m.Dynamic,
            materialIndex = m.MaterialIndex,
            defaultBoneIndex = m.DefaultBoneIndex,
            vertexCount = m.VertexCount,
            vertexStride = m.VertexStride,
            bufferLayoutIndex = m.BufferLayoutIndex,
            faceSetCount = m.FaceSetCount,
            boneCount = m.BoneCount,
            indexFormat = m.IndexFormat
        }).ToArray();
        var layoutSamples = _bufferLayouts.Take(SampleLimit).Select((l, i) => new
        {
            index = i,
            members = l.Members.Select(mem => new
            {
                unk00 = mem.Unk00,
                structOffset = mem.StructOffset,
                type = $"0x{mem.Type:X}",
                semantic = $"0x{mem.Semantic:X}",
                index = mem.Index
            }).ToArray()
        }).ToArray();
        return new
        {
            format = "FLVER",
            version = VersionString,
            internalVersion = $"0x{InternalVersion:X}",
            sourceSize = _source.Length,
            sourceHash = SourceHash,
            skeletonTransformCount = SkeletonTransformCount,
            materialCount = MaterialCount,
            boneCount = BoneCount,
            vertexBufferCount = VertexBufferCount,
            meshCount = MeshCount,
            faceSetCount = FaceSetCount,
            bufferLayoutCount = BufferLayoutCount,
            textureCount = TextureCount,
            faceCount = FaceCount,
            totalFaceCount = TotalFaceCount,
            vertexStride = VertexStride,
            vertexStrides = DistinctVertexStrides,
            unicode = _unicode,
            boundingBox = new
            {
                min = new[] { BoundingBoxMinX, BoundingBoxMinY, BoundingBoxMinZ },
                max = new[] { BoundingBoxMaxX, BoundingBoxMaxY, BoundingBoxMaxZ }
            },
            materials = Materials.Take(SampleLimit).Select(m => new
            {
                name = m.Name,
                mtdPath = m.MtdPath,
                textureCount = m.TextureCount,
                // material 后 16 字节（此前整段未读）。gxOffset==0 表示该 material 无 GX 列表；
                // gxList 为 null 且 gxOffset!=0 表示解析失败（另有 layoutWarning）。
                flags = m.Flags,
                gxOffset = m.GxOffset,
                unk18 = m.Unk18,
                gxList = m.GxList is null ? null : new
                {
                    itemCount = m.GxList.Items.Count,
                    byteLength = m.GxList.ByteLength,
                    terminatorId = m.GxList.TerminatorId,
                    terminatorLength = m.GxList.TerminatorLength,
                    terminatorPaddingAllZero = m.GxList.TerminatorPaddingAllZero,
                    // payload 只报长度不报内容：语义未验证，见 TryReadGxList 注释。
                    items = m.GxList.Items.Select(x => new
                    {
                        id = x.Id,
                        unk04 = x.Unk04,
                        itemLength = x.ItemLength,
                        dataLength = x.DataLength
                    }).ToArray()
                }
            }).ToArray(),
            materialsTruncated = Materials.Count > SampleLimit,
            // 全量 GX 覆盖面（不受 SampleLimit 截断影响）：消费方要能判断
            // 「样本里没有 GX 列表」与「整个文件都没有」的区别。
            gxCoverage = new
            {
                materialsWithGxOffset = Materials.Count(m => m.GxOffset != 0),
                gxListsParsed = Materials.Count(m => m.GxList is not null),
                gxListsFailed = Materials.Count(m => m.GxOffset != 0 && m.GxList is null),
                gxItemsTotal = Materials.Where(m => m.GxList is not null).Sum(m => m.GxList!.Items.Count),
                gxPayloadBytesUndecoded = Materials.Where(m => m.GxList is not null)
                    .Sum(m => (long)m.GxList!.Items.Sum(x => x.DataLength)),
                distinctItemIds = Materials.Where(m => m.GxList is not null)
                    .SelectMany(m => m.GxList!.Items.Select(x => x.Id))
                    .Distinct().OrderBy(id => id, StringComparer.Ordinal).ToArray()
            },
            bones = Bones.Take(SampleLimit).Select(b => new
            {
                name = b.Name,
                parentIndex = b.ParentIndex,
                nextSiblingIndex = b.NextSiblingIndex
            }).ToArray(),
            bonesTruncated = Bones.Count > SampleLimit,
            meshes = meshSamples,
            meshesTruncated = Meshes.Count > SampleLimit,
            bufferLayouts = layoutSamples,
            // 纹理槽表（MODEL-51A：material-slot page 从主文档直接可读，不必再单独发
            // read-flver-texture-slots）。每个槽已按 material 的 firstTextureIndex/
            // textureCount 归好所属材质；未命中任何材质时为 -1。
            textureSlots = _textureSlots.Take(SampleLimit).Select(t => new
            {
                index = t.Index,
                type = t.Type,
                path = t.Path,
                materialIndex = t.MaterialIndex
            }).ToArray(),
            texturesTruncated = _textureSlots.Count > SampleLimit,
            layoutWarnings = _layoutWarnings.ToArray(),
            // 与 layoutWarnings 并列而不是合并：前者是「数据可疑」，本项是「能力边界」。
            // 上层若把两者混为一谈，就会把「我没读」误报成「文件坏了」。
            unparsedGaps = gaps,
            roundTrip = rt,
            authority
        };
    }

    private void AddLayoutWarning(string message)
    {
        if (_layoutWarnings.Count < 64)
            _layoutWarnings.Add(message);
    }

    /// <summary>
    /// 登记一个「已识别但未解析」的缺口。用 SortedSet 去重：194 个未解析 member 会产生
    /// 大量同文本条目，逐条堆积只是噪音；缺口的价值在**种类**，不在计数。
    /// </summary>
    private void AddUnparsedGap(string message)
    {
        if (_unparsedGaps.Count < 64)
            _unparsedGaps.Add(message);
    }

    /// <summary>
    /// material 后 16 字节的缺口登记。
    ///
    /// **历史**：本方法原先无条件登记「后 16/32 字节未解析（含 FLVER2 gxIndex →
    /// GXList 引用）」。那条缺口现已消除——32 字节全部读出（Flags / GxOffset / Unk18 /
    /// 保留字段），GX 列表按双源核对的规范解析，真实语料 505/505 成功。
    /// 原注释还有两处事实错误（+0x10 不是 gxIndex 而是 Flags；+0x14 是字节偏移不是
    /// 索引），已在 <see cref="TryReadGxList"/> 的注释里逐条更正。
    ///
    /// **保留本方法的理由**：GX item 的 <b>payload 仍不解释</b>。各 ID（GX00/GXMD/GX04…）
    /// 的字段语义按材质着色参数分歧，未经真实往返验证解码就是在未验证前提下扩大 native
    /// 声明面。所以缺口从「整段未读」收窄为「payload 未解码」——**收窄不等于消失**，
    /// 仍须让 authority 看见（与 ESD 的 RPN 字节码同一口径）。
    ///
    /// 判据挂在「确实存在 payload」上而不是无条件登记：全部 item 都是 length==12
    /// （无 payload）时没有未解码内容，此时报缺口是假缺口，会稀释真信号。
    /// </summary>
    private void RecordMaterialUnparsedTail()
    {
        if (Materials.Count == 0) return;

        var listCount = 0;
        var itemCount = 0;
        var payloadBytes = 0L;
        var failedLists = 0;
        foreach (var material in Materials)
        {
            if (material.GxOffset == 0) continue;
            if (material.GxList is null) { failedLists += 1; continue; }
            listCount += 1;
            foreach (var item in material.GxList.Items)
            {
                itemCount += 1;
                payloadBytes += item.DataLength;
            }
        }

        // 只登记种类，不逐条展开（去重由 AddUnparsedGap 的 SortedSet 完成）。
        if (payloadBytes > 0)
        {
            AddUnparsedGap(
                $"material:GX item payload 未解码（按 ID 分歧的材质着色参数，只按 (id, unk04, length) 上报）；"
                + $"lists={listCount}, items={itemCount}, payloadBytes={payloadBytes}");
        }
        // 解析失败与「未解码」是两件事：前者是读不懂（数据可疑，已另记 layoutWarning），
        // 这里再登记一次能力边界，确保即使 payload 为 0 也不会把失败掩盖成「无缺口」。
        if (failedLists > 0)
        {
            AddUnparsedGap($"material:GX 列表解析失败 {failedLists} 条（布局与已登记形态不同）");
        }
    }

    /// <summary>
    /// 确保顶点语义缺口已被探测过。
    ///
    /// 缺口是在 <see cref="BuildMeshPlan"/> 里登记的，而 BuildMeshPlan 只在真正取顶点
    /// 数据时才被调用。若 Authority 在任何 plan 构建之前被读取，_unparsedGaps 会是空的
    /// ——那样「没探测过」会被误读成「没有缺口」，正是本次要修的那类不可见性。
    /// 故此处对全部 mesh 各构建一次 plan（幂等，只为登记缺口）。
    /// </summary>
    private void EnsureVertexSemanticGapsProbed()
    {
        if (_vertexSemanticGapsProbed) return;
        _vertexSemanticGapsProbed = true;
        for (var i = 0; i < Meshes.Count; i++)
        {
            try { BuildMeshPlan(i); }
            catch (Exception) { AddLayoutWarning($"mesh[{i}] 语义缺口探测抛出异常。"); }
        }
    }

    private bool _vertexSemanticGapsProbed;

    // --- Private helpers ---

    /// <summary>LayoutType 的字节宽度（SoulsFormats LayoutMember.Size）。未知类型返回 0。</summary>
    private static int MemberTypeSize(uint type) => type switch
    {
        TypeEdgeCompressed => 1,
        TypeFloat2 or TypeByte4A or TypeByte4B or TypeShort2toFloat2 or TypeByte4C or TypeUV or TypeByte4E => 4,
        TypeFloat3 => 12,
        TypeFloat4 => 16,
        TypeUVPair or TypeShortBoneIndices or TypeShort4toFloat4A or TypeShort4toFloat4B => 8,
        _ => 0
    };

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static uint ReadUInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));

    private static short ReadInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(offset, 2));

    private static ushort ReadUInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));

    private static byte ReadByte(byte[] source, int offset) => source[offset];

    private static sbyte ReadSByte(byte[] source, int offset) => unchecked((sbyte)source[offset]);

    private static float ReadFloat32(byte[] source, int offset) =>
        BitConverter.Int32BitsToSingle(ReadInt32(source, offset));

    private static string ReadStringAtOffset(byte[] source, int absoluteOffset, bool unicode)
    {
        if (absoluteOffset <= HeaderSize || absoluteOffset >= source.Length)
            return string.Empty;
        return unicode
            ? ReadUtf16NullTerminated(source, absoluteOffset, MaxStringBytes)
            : ReadAsciiOrLatin1NullTerminated(source, absoluteOffset, MaxStringBytes);
    }

    private static string ReadUtf16NullTerminated(byte[] source, int offset, int maxBytes)
    {
        if (offset < 0 || offset >= source.Length)
            return string.Empty;
        var end = Math.Min(offset + maxBytes, source.Length - 1);
        var pos = offset;
        while (pos < end)
        {
            if (source[pos] == 0 && source[pos + 1] == 0)
                break;
            pos += 2;
        }
        var byteLength = pos - offset;
        if (byteLength <= 0) return string.Empty;
        return Encoding.Unicode.GetString(source, offset, byteLength);
    }

    private static string ReadAsciiOrLatin1NullTerminated(byte[] source, int offset, int maxBytes)
    {
        if (offset < 0 || offset >= source.Length)
            return string.Empty;
        var end = Math.Min(offset + maxBytes, source.Length);
        var pos = offset;
        while (pos < end && source[pos] != 0)
            pos++;
        var byteLength = pos - offset;
        if (byteLength <= 0) return string.Empty;
        return Encoding.Latin1.GetString(source, offset, byteLength);
    }

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record FlverMaterialEntry(
    int Index, string Name, string MtdPath, int TextureCount, int FirstTextureIndex,
    // ── material 32 字节的后 16 字节（此前整段未读）──
    // 字段语义经**双源核对**（JKAnderson/SoulsFormats 与 soulsmods/SoulsFormatsNEXT
    // 的 FLVER2/Material.cs 逐字段一致）。注意与本文件旧注释的分歧：旧注释把 +0x10
    // 说成 gxIndex，实测与两份实现都表明 **+0x10 是 Flags**、+0x14 才是 GX 列表的
    // **字节偏移**（不是索引）。旧注释的说法已作废，理由见 ReadGxList 的注释。
    int Flags,            // +0x10
    int GxOffset,         // +0x14：GX 列表字节偏移；0 表示该 material 无 GX 列表
    int Unk18,            // +0x18：SoulsFormatsNEXT 命名为 Index，但实测非序号（见注释）
    FlverGxList? GxList); // 按 GxOffset 解析出的列表；null 表示 GxOffset==0 或解析失败

/// <summary>
/// FLVER2 GX 列表：一串 <see cref="FlverGxItem"/> 后跟一个终止记录。
///
/// 结构双源核对（2026-08-08，两份独立实现逐字段一致）：
///   循环读 item 直到 id == int.MaxValue 或 id == -1；该 id 即 TerminatorId，
///   其后紧跟一个恒为 100 的 int32，再一个 int32 长度（真实填充长度 = 该值 - 0xC），
///   填充区按规范应为全零。
///
/// 真实语料验证（11 个 Sekiro chrbnd、505 条 material，全部 gxOffset 非零）：
/// 505/505 按本结构解析成功、零错误；terminator 后的常量 100 命中 505/505；
/// 填充区全零 505/505；item 数分布 1×392、2×56、3×8、5×34、7×14、9×1；
/// item ID 是 4 字节 ASCII 标签（GX00 505、GXMD 64、GX04 49、GX15 41、GX80/GX81 各 34…）。
/// </summary>
internal sealed record FlverGxList(
    IReadOnlyList<FlverGxItem> Items,
    int TerminatorId,
    int TerminatorLength,
    bool TerminatorPaddingAllZero,
    int ByteLength);

/// <summary>
/// GX 列表里的一项。<c>Data</c> 按 <see cref="DataLength"/> 原样保留但**不解释**——
/// 各 ID 的 payload 语义按材质着色参数分歧，未经真实往返验证不做解码
/// （否则就是在未验证前提下扩大 native 声明面）。
/// </summary>
internal sealed record FlverGxItem(
    string Id,          // 4 字节 ASCII（如 "GX00"）
    int RawId,          // 同一 4 字节的 int32 视图，便于与规范里的 int 比较
    int Unk04,
    int ItemLength,     // 含 12 字节头
    int DataLength);    // ItemLength - 12

internal sealed record FlverBoneEntry(
    int Index, string Name, short NextSiblingIndex, short ParentIndex, short ChildIndex,
    float TranslationX, float TranslationY, float TranslationZ,
    float RotationX, float RotationY, float RotationZ,
    float ScaleX, float ScaleY, float ScaleZ);

internal sealed record FlverMeshEntry(
    int Index,
    byte Dynamic,
    int MaterialIndex,
    int DefaultBoneIndex,
    int VertexBufferCount,
    IReadOnlyList<int> VertexBufferIndices,
    int VertexCount,
    int VertexStride,
    int BufferLayoutIndex,
    int FaceSetCount,
    IReadOnlyList<int> FaceSetIndices,
    int IndexFormat,
    int BoneCount,
    IReadOnlyList<int> BoneIndices);

internal sealed record FlverVertexBufferEntry(
    int BufferIndex, int LayoutIndex, int VertexSize, int VertexCount, int BufferLength, int BufferOffset);

internal sealed record FlverLayoutMemberEntry(
    int Unk00, int StructOffset, uint Type, uint Semantic, int Index);

internal sealed record FlverBufferLayoutEntry(IReadOnlyList<FlverLayoutMemberEntry> Members);

internal sealed record FlverFaceSetEntry(
    uint Flags, bool TriangleStrip, bool CullBackfaces, int IndexCount, int IndicesOffset, int IndexSize);

internal sealed record FlverTextureSlotEntry(
    int Index, string Type, string Path, int MaterialIndex);

internal sealed record FlverDummyEntry(
    int Index, float PositionX, float PositionY, float PositionZ,
    short ReferenceId, short ParentBoneIndex, short AttachBoneIndex);

internal sealed record FlverMeshSkinning(
    string SkinningMode,
    string BoneIndexSpace,
    string? BoneWeightsBase64,
    string? BoneIndicesBase64)
{
    public static FlverMeshSkinning Static { get; } = new("static", "none", null, null);
}

/// <summary>一个原生 VertexColor member 的完整 RGBA 只读诊断。</summary>
internal sealed record FlverVertexColorDiagnostic(
    int MemberOrdinal,
    int MemberIndex,
    uint LayoutType,
    string LayoutTypeName,
    int VertexBufferIndex,
    int BufferLayoutIndex,
    int StructOffset,
    string RgbaBase64);

/// <summary>VertexColor 诊断结果；失败时 Members 始终为空，避免部分颜色被误用。</summary>
internal sealed record FlverVertexColorReadResult(
    string Status,
    IReadOnlyList<FlverVertexColorDiagnostic> Members,
    string? Failure,
    string? FirstAlphaBase64);

internal sealed record FlverRoundTripReport(
    bool ByteIdentical, bool SemanticIdentical,
    string SourceHash, string RebuiltHash,
    int SkeletonTransformCount, int MaterialCount, int BoneCount, int MeshCount);

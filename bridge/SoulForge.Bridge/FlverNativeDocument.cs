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
/// </summary>
internal sealed class FlverNativeDocument
{
    private static readonly byte[] MagicBytes = { 0x46, 0x4C, 0x56, 0x45, 0x52, 0x00 };
    private const int HeaderSize = 0x80;
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
    private const uint TypeByte4B = 0x11;
    private const uint TypeShort2toFloat2 = 0x12;
    private const uint TypeByte4C = 0x13;
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

    /// <summary>依据解析完整性计算 authority：无降级警告且至少一个 mesh 顶点可解码 → native-verified。</summary>
    public string Authority
    {
        get
        {
            if (_layoutWarnings.Count > 0) return "partial";
            try
            {
                for (var i = 0; i < Math.Min(Meshes.Count, 4); i++)
                {
                    if (GetMeshPositionsBase64(i, 8) != null) return "native-verified";
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
        public int DataBase;   // 顶点 0 数据的绝对偏移
        public int Stride;     // VertexBuffer.VertexSize
        public int Count;      // VertexBuffer.VertexCount
        public int Offset;     // LayoutMember.StructOffset
        public uint Type;      // LayoutMember.Type
    }

    /// <summary>一个 mesh 的顶点解码计划：按语义从该 mesh 各 vertex buffer 合并取址。</summary>
    private sealed class MeshDataPlan
    {
        public int VertexCount;
        public VertexMemberAccess? Position;
        public VertexMemberAccess? Normal;
        public VertexMemberAccess? UV;
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
                var memberSize = MemberTypeSize(member.Type);
                if (memberSize <= 0)
                {
                    AddLayoutWarning($"layout[{vb.LayoutIndex}] member type=0x{member.Type:X} 未知大小。");
                    continue;
                }
                if (member.StructOffset < 0 || member.StructOffset + memberSize > vb.VertexSize)
                {
                    AddLayoutWarning($"layout[{vb.LayoutIndex}] member structOffset={member.StructOffset} size={memberSize} 越界 stride={vb.VertexSize}。");
                    continue;
                }
                var access = new VertexMemberAccess
                {
                    DataBase = (int)dataBase,
                    Stride = vb.VertexSize,
                    Count = count,
                    Offset = member.StructOffset,
                    Type = member.Type
                };
                switch (member.Semantic)
                {
                    case SemPosition when plan.Position == null: plan.Position = access; break;
                    case SemNormal when plan.Normal == null: plan.Normal = access; break;
                    case SemUV when plan.UV == null: plan.UV = access; break;
                    case SemBoneWeights when plan.Weights == null: plan.Weights = access; break;
                    case SemBoneIndices when plan.BoneIndices == null: plan.BoneIndices = access; break;
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
    public string? GetMeshPositionsBase64(int meshIndex, int maxVertices = 10_000)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.Position == null || plan.VertexCount <= 0) return null;
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
    public string? GetMeshNormalsBase64(int meshIndex, int maxVertices = 10_000)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.Normal == null || plan.VertexCount <= 0) return null;
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

    /// <summary>提取网格第一组 UV（float[2] 每顶点）为 base64。</summary>
    public string? GetMeshUVsBase64(int meshIndex, int maxVertices = 10_000)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.UV == null || plan.VertexCount <= 0) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var uvFactor = InternalVersion >= 0x2000F ? 2048f : 1024f;
        var uvs = new float[vertexCount * 2];
        var a = plan.UV;
        for (var v = 0; v < vertexCount; v++)
        {
            var off = a.DataBase + (long)v * a.Stride + a.Offset;
            if (off < 0 || off + 4 > _source.Length) return null;
            float u, vt;
            switch (a.Type)
            {
                case TypeFloat2:
                case TypeFloat4:
                    u = ReadFloat32(_source, (int)off);
                    vt = ReadFloat32(_source, (int)off + 4);
                    break;
                case TypeFloat3:
                    u = ReadFloat32(_source, (int)off);
                    vt = ReadFloat32(_source, (int)off + 4);
                    break;
                case TypeUVPair:
                case TypeUV:
                case TypeByte4A:
                case TypeByte4B:
                case TypeByte4C:
                case TypeShort2toFloat2:
                    u = ReadInt16(_source, (int)off) / uvFactor;
                    vt = ReadInt16(_source, (int)off + 2) / uvFactor;
                    break;
                default:
                    return null;
            }
            if (!float.IsFinite(u) || !float.IsFinite(vt)) return null;
            uvs[v * 2] = u;
            uvs[v * 2 + 1] = vt;
        }
        var bytes = new byte[uvs.Length * 4];
        Buffer.BlockCopy(uvs, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>提取网格骨骼权重（float[4] 每顶点，Byte4C=byte/255）为 base64。</summary>
    public string? GetMeshBoneWeightsBase64(int meshIndex, int maxVertices = 10_000)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.Weights == null || plan.VertexCount <= 0) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var a = plan.Weights;
        var weights = new float[vertexCount * 4];
        for (var v = 0; v < vertexCount; v++)
        {
            var off = a.DataBase + (long)v * a.Stride + a.Offset;
            if (off < 0 || off + 4 > _source.Length) return null;
            switch (a.Type)
            {
                case TypeByte4C:
                    weights[v * 4] = ReadByte(_source, (int)off) / 255f;
                    weights[v * 4 + 1] = ReadByte(_source, (int)off + 1) / 255f;
                    weights[v * 4 + 2] = ReadByte(_source, (int)off + 2) / 255f;
                    weights[v * 4 + 3] = ReadByte(_source, (int)off + 3) / 255f;
                    break;
                case TypeByte4A:
                    weights[v * 4] = ReadSByte(_source, (int)off) / 127f;
                    weights[v * 4 + 1] = ReadSByte(_source, (int)off + 1) / 127f;
                    weights[v * 4 + 2] = ReadSByte(_source, (int)off + 2) / 127f;
                    weights[v * 4 + 3] = ReadSByte(_source, (int)off + 3) / 127f;
                    break;
                case TypeUVPair:
                case TypeShort4toFloat4A:
                    weights[v * 4] = ReadInt16(_source, (int)off) / 32767f;
                    weights[v * 4 + 1] = ReadInt16(_source, (int)off + 2) / 32767f;
                    weights[v * 4 + 2] = ReadInt16(_source, (int)off + 4) / 32767f;
                    weights[v * 4 + 3] = ReadInt16(_source, (int)off + 6) / 32767f;
                    break;
                default:
                    return null;
            }
        }
        var bytes = new byte[weights.Length * 4];
        Buffer.BlockCopy(weights, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>提取网格骨骼索引（4 字节/顶点原样）为 base64。</summary>
    public string? GetMeshBoneIndicesBase64(int meshIndex, int maxVertices = 10_000)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.BoneIndices == null || plan.VertexCount <= 0) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var a = plan.BoneIndices;
        var indices = new byte[vertexCount * 4];
        for (var v = 0; v < vertexCount; v++)
        {
            var off = a.DataBase + (long)v * a.Stride + a.Offset;
            if (off < 0 || off + 4 > _source.Length) return null;
            if (a.Type == TypeShortBoneIndices)
            {
                indices[v * 4] = ReadByte(_source, (int)off);
                indices[v * 4 + 1] = ReadByte(_source, (int)off + 2);
                indices[v * 4 + 2] = ReadByte(_source, (int)off + 4);
                indices[v * 4 + 3] = ReadByte(_source, (int)off + 6);
            }
            else if (a.Type is TypeByte4B or TypeByte4E)
            {
                indices[v * 4] = ReadByte(_source, (int)off);
                indices[v * 4 + 1] = ReadByte(_source, (int)off + 1);
                indices[v * 4 + 2] = ReadByte(_source, (int)off + 2);
                indices[v * 4 + 3] = ReadByte(_source, (int)off + 3);
            }
            else
            {
                return null;
            }
        }
        return Convert.ToBase64String(indices);
    }

    /// <summary>
    /// 提取网格三角形索引为 base64（原样 u16 或 u32，随 faceSet.IndexSize）。
    /// 优先取 Flags==0（None / 最高细节）的 face set，其次第一个可解码的。
    /// </summary>
    public string? GetMeshIndicesBase64(int meshIndex, int maxIndices = 30_000)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        if (mesh.FaceSetIndices.Count == 0) return null;

        var candidates = mesh.FaceSetIndices
            .Where(i => i >= 0 && i < _faceSets.Count)
            .Select(i => (Index: i, FaceSet: _faceSets[i]))
            .ToList();
        if (candidates.Count == 0) return null;
        var selected = candidates.FirstOrDefault(c => c.FaceSet.Flags == 0);
        if (selected.FaceSet == null) selected = candidates[0];

        var fs = selected.FaceSet;
        if (fs.IndexSize != 16 && fs.IndexSize != 32) return null; // 边压缩（8）等不支持
        if (fs.IndexCount <= 0 || fs.IndexCount > MaxIndexCount) return null;
        var count = Math.Min(fs.IndexCount, maxIndices);
        var indexDataOffset = (long)DataStart + fs.IndicesOffset;
        var byteLen = count * (fs.IndexSize / 8);
        if (indexDataOffset < 0 || indexDataOffset + byteLen > _source.Length) return null;

        var raw = new byte[byteLen];
        Buffer.BlockCopy(_source, (int)indexDataOffset, raw, 0, byteLen);
        return Convert.ToBase64String(raw);
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

        var versionString = ReadUtf16NullTerminated(source, 0x06, 4);
        var internalVersion = ReadInt32(source, 0x08);
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
        var materials = new List<FlverMaterialEntry>(materialCount);
        for (var i = 0; i < materialCount; i++, off += MaterialSize)
        {
            int nameOffset = ReadInt32(source, off + 0x00);
            int mtdOffset = ReadInt32(source, off + 0x04);
            int textureCountInMaterial = ReadInt32(source, off + 0x08);
            int firstTextureIndex = ReadInt32(source, off + 0x0C);
            string name = ReadStringAtOffset(source, nameOffset, unicode);
            string mtdPath = ReadStringAtOffset(source, mtdOffset, unicode);
            materials.Add(new FlverMaterialEntry(i, name, mtdPath, textureCountInMaterial, firstTextureIndex));
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
            short nextSiblingIndex = ReadInt16(source, off + 0x2C);
            string name = ReadStringAtOffset(source, nameOffset, unicode);
            bones.Add(new FlverBoneEntry(i, name, nextSiblingIndex, parentIndex, childIndex,
                translationX, translationY, translationZ,
                rotationX, rotationY, rotationZ));
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

            var boneIndices = ReadIndexArray(source, boneOffset, boneCountInMesh, meshCount);
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
            int indexCount = ReadInt32(source, off + 0x08);
            int indicesOffset = ReadInt32(source, off + 0x0C);
            int indexSize = internalVersion > 0x20005 ? ReadInt32(source, off + 0x18) : 0;
            if (indexSize == 0) indexSize = vertexIndicesSize;
            faceSets.Add(new FlverFaceSetEntry(flags, triangleStrip, indexCount, indicesOffset, indexSize));
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
            // 主 face set 的 index 格式：优先 Flags==0，其次第一个。
            var fsIndex = mesh.FaceSetIndices.FirstOrDefault(i => i >= 0 && i < faceSets.Count && faceSets[i].Flags == 0);
            if (fsIndex < 0 && mesh.FaceSetIndices.Count > 0) fsIndex = mesh.FaceSetIndices[0];
            if (fsIndex >= 0 && fsIndex < faceSets.Count) indexFormat = faceSets[fsIndex].IndexSize;

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

    public FlverRoundTripReport VerifyRoundTrip()
    {
        var reparsed = Read(_source);
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
        var authority = Authority;
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
                textureCount = m.TextureCount
            }).ToArray(),
            materialsTruncated = Materials.Count > SampleLimit,
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
            layoutWarnings = _layoutWarnings.ToArray(),
            roundTrip = rt,
            authority
        };
    }

    private void AddLayoutWarning(string message)
    {
        if (_layoutWarnings.Count < 64)
            _layoutWarnings.Add(message);
    }

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
    int Index, string Name, string MtdPath, int TextureCount, int FirstTextureIndex);

internal sealed record FlverBoneEntry(
    int Index, string Name, short NextSiblingIndex, short ParentIndex, short ChildIndex,
    float TranslationX, float TranslationY, float TranslationZ,
    float RotationX, float RotationY, float RotationZ);

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
    uint Flags, bool TriangleStrip, int IndexCount, int IndicesOffset, int IndexSize);

internal sealed record FlverTextureSlotEntry(
    int Index, string Type, string Path, int MaterialIndex);

internal sealed record FlverDummyEntry(
    int Index, float PositionX, float PositionY, float PositionZ,
    short ReferenceId, short ParentBoneIndex, short AttachBoneIndex);

internal sealed record FlverRoundTripReport(
    bool ByteIdentical, bool SemanticIdentical,
    string SourceHash, string RebuiltHash,
    int SkeletonTransformCount, int MaterialCount, int BoneCount, int MeshCount);

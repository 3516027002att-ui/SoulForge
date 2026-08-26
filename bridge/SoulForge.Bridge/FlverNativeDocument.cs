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
/// 取自该 mesh 实际使用的 BufferLayout.LayoutMember。
/// </summary>
internal sealed class FlverNativeDocument
{
    private static readonly byte[] MagicBytes = { 0x46, 0x4C, 0x56, 0x45, 0x52, 0x00 };
    private const int HeaderSize = 0x80;
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
    private const float SkinWeightEpsilon = 1e-5f;

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
    public int VertexStride => Meshes.Count > 0 ? Meshes[0].VertexStride : 0;
    public int[] DistinctVertexStrides => _vertexBuffers.Select(vb => vb.VertexSize).Distinct().OrderBy(s => s).ToArray();
    public IReadOnlyList<string> LayoutWarnings => _layoutWarnings;

    public IReadOnlyList<string> UnparsedGaps
    {
        get
        {
            EnsureVertexSemanticGapsProbed();
            return _unparsedGaps.ToArray();
        }
    }

    public string Authority
    {
        get
        {
            EnsureVertexSemanticGapsProbed();
            if (_layoutWarnings.Count > 0 || _unparsedGaps.Count > 0) return "partial";
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

    private sealed class VertexMemberAccess
    {
        public int DataBase;
        public int Stride;
        public int Count;
        public int Offset;
        public uint Type;
    }

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
                    case SemTangent:
                        AddUnparsedGap($"vertex-semantic:tangent(0x{SemTangent:X}) 已定义未解析（type=0x{member.Type:X}）");
                        break;
                    case SemBitangent:
                        AddUnparsedGap($"vertex-semantic:bitangent(0x{SemBitangent:X}) 已定义未解析（type=0x{member.Type:X}）");
                        break;
                    case SemVertexColor:
                        AddUnparsedGap($"vertex-semantic:vertexColor(0x{SemVertexColor:X}) 已定义未解析（type=0x{member.Type:X}）");
                        break;
                    case SemPosition:
                    case SemNormal:
                    case SemUV:
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

    private bool HasMemberBytes(VertexMemberAccess access, int vertexIndex)
    {
        var memberSize = MemberTypeSize(access.Type);
        if (memberSize <= 0) return false;
        var off = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        return off >= 0 && off + memberSize <= _source.Length;
    }

    private bool TryExtractFloat3(VertexMemberAccess access, int vertexIndex, out float x, out float y, out float z)
    {
        x = y = z = 0f;
        if (!HasMemberBytes(access, vertexIndex)) return false;
        var off = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (access.Type is TypeFloat3 or TypeFloat4)
        {
            x = ReadFloat32(_source, (int)off);
            y = ReadFloat32(_source, (int)off + 4);
            z = ReadFloat32(_source, (int)off + 8);
        }
        else if (access.Type is TypeByte4A or TypeByte4B or TypeByte4C or TypeByte4E)
        {
            x = ReadByteNorm((int)off);
            y = ReadByteNorm((int)off + 1);
            z = ReadByteNorm((int)off + 2);
        }
        else if (access.Type == TypeShort4toFloat4A)
        {
            x = ReadInt16(_source, (int)off) / 32767f;
            y = ReadInt16(_source, (int)off + 2) / 32767f;
            z = ReadInt16(_source, (int)off + 4) / 32767f;
        }
        else if (access.Type == TypeShort4toFloat4B)
        {
            x = ReadHalf(_source, (int)off);
            y = ReadHalf(_source, (int)off + 2);
            z = ReadHalf(_source, (int)off + 4);
        }
        else
        {
            return false;
        }
        return float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z);
    }

    /// <summary>
    /// Decode FLVER normal.xyz and preserve normal.w. SoulsFormats treats normal.w
    /// as a real single-bone binding index on rigid meshes; dropping it turns that
    /// mesh class into an unbound SkinnedMesh and can collapse the whole character.
    /// </summary>
    private bool TryExtractNormal(
        VertexMemberAccess access,
        int vertexIndex,
        out float x,
        out float y,
        out float z,
        out int? normalW)
    {
        x = y = z = 0f;
        normalW = null;
        if (!HasMemberBytes(access, vertexIndex)) return false;
        var off = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;

        switch (access.Type)
        {
            case TypeFloat3:
                x = ReadFloat32(_source, (int)off);
                y = ReadFloat32(_source, (int)off + 4);
                z = ReadFloat32(_source, (int)off + 8);
                break;
            case TypeFloat4:
            {
                x = ReadFloat32(_source, (int)off);
                y = ReadFloat32(_source, (int)off + 4);
                z = ReadFloat32(_source, (int)off + 8);
                var w = ReadFloat32(_source, (int)off + 12);
                if (float.IsFinite(w) && MathF.Truncate(w) == w && w >= int.MinValue && w <= int.MaxValue)
                    normalW = (int)w;
                break;
            }
            case TypeByte4A:
            case TypeByte4B:
            case TypeByte4C:
            case TypeByte4E:
                x = ReadByteNorm((int)off);
                y = ReadByteNorm((int)off + 1);
                z = ReadByteNorm((int)off + 2);
                normalW = ReadByte(_source, (int)off + 3);
                break;
            case TypeShort2toFloat2:
                // SoulsFormats Normal + Short2toFloat2 stores W first, then Z/Y/X
                // as signed normalized bytes.
                normalW = ReadByte(_source, (int)off);
                z = ReadSByte(_source, (int)off + 1) / 127f;
                y = ReadSByte(_source, (int)off + 2) / 127f;
                x = ReadSByte(_source, (int)off + 3) / 127f;
                break;
            case TypeShort4toFloat4A:
                x = ReadInt16(_source, (int)off) / 32767f;
                y = ReadInt16(_source, (int)off + 2) / 32767f;
                z = ReadInt16(_source, (int)off + 4) / 32767f;
                normalW = ReadInt16(_source, (int)off + 6);
                break;
            case TypeShort4toFloat4B:
                x = ReadHalf(_source, (int)off);
                y = ReadHalf(_source, (int)off + 2);
                z = ReadHalf(_source, (int)off + 4);
                normalW = ReadInt16(_source, (int)off + 6);
                break;
            default:
                return false;
        }

        return float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z);
    }

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

    public string? GetMeshNormalsBase64(int meshIndex, int maxVertices = 10_000)
    {
        var plan = BuildMeshPlan(meshIndex);
        if (plan?.Normal == null || plan.VertexCount <= 0) return null;
        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        var normals = new float[vertexCount * 3];
        for (var v = 0; v < vertexCount; v++)
        {
            if (!TryExtractNormal(plan.Normal, v, out var x, out var y, out var z, out _)) return null;
            normals[v * 3] = x;
            normals[v * 3 + 1] = y;
            normals[v * 3 + 2] = z;
        }
        var bytes = new byte[normals.Length * 4];
        Buffer.BlockCopy(normals, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

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
            if (!HasMemberBytes(a, v)) return null;
            var off = a.DataBase + (long)v * a.Stride + a.Offset;
            float u, vt;
            switch (a.Type)
            {
                case TypeFloat2:
                case TypeFloat3:
                case TypeFloat4:
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

    /// <summary>
    /// Build one renderer-ready skin binding. Weighted vertices use Mesh.BoneIndices
    /// as the local→global palette. Zero-weight slots are deliberately ignored so
    /// sentinel values such as 255 cannot invalidate an otherwise valid vertex.
    /// If explicit weights are absent (or a vertex has a zero influence sum),
    /// NormalW provides the authoritative rigid single-bone binding.
    /// </summary>
    private bool TryBuildMeshSkinning(
        int meshIndex,
        int maxVertices,
        out ushort[] globalIndices,
        out float[] normalizedWeights)
    {
        globalIndices = Array.Empty<ushort>();
        normalizedWeights = Array.Empty<float>();
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return false;
        var mesh = Meshes[meshIndex];
        var plan = BuildMeshPlan(meshIndex);
        if (plan == null || plan.VertexCount <= 0) return false;
        if (mesh.BoneCount > 0 && mesh.BoneIndices.Count != mesh.BoneCount) return false;

        var vertexCount = Math.Min(plan.VertexCount, maxVertices);
        globalIndices = new ushort[vertexCount * 4];
        normalizedWeights = new float[vertexCount * 4];

        bool TryRemapPaletteIndex(int localIndex, out ushort globalIndex)
        {
            if (mesh.BoneIndices.Count > 0)
            {
                if (localIndex >= 0 && localIndex < mesh.BoneIndices.Count)
                {
                    var candidate = mesh.BoneIndices[localIndex];
                    if (candidate >= 0 && candidate < Bones.Count)
                    {
                        globalIndex = checked((ushort)candidate);
                        return true;
                    }
                }
                globalIndex = 0;
                return false;
            }

            if (localIndex >= 0 && localIndex < Bones.Count)
            {
                globalIndex = checked((ushort)localIndex);
                return true;
            }
            globalIndex = 0;
            return false;
        }

        bool TryRigidNormalW(int vertexIndex, out ushort globalIndex)
        {
            globalIndex = 0;
            if (plan.Normal == null) return false;
            if (!TryExtractNormal(plan.Normal, vertexIndex, out _, out _, out _, out var normalW)) return false;
            if (normalW is null || normalW < 0 || normalW >= Bones.Count) return false;
            globalIndex = checked((ushort)normalW.Value);
            return true;
        }

        for (var vertex = 0; vertex < vertexCount; vertex++)
        {
            var output = vertex * 4;
            Span<float> weights = stackalloc float[4];
            Span<int> rawIndices = stackalloc int[4];
            var hasWeightedBinding = plan.Weights != null
                && plan.BoneIndices != null
                && TryReadWeights(plan.Weights, vertex, weights)
                && TryReadBoneIndices(plan.BoneIndices, vertex, rawIndices);

            if (hasWeightedBinding)
            {
                var sum = 0f;
                for (var slot = 0; slot < 4; slot++)
                {
                    var weight = float.IsFinite(weights[slot]) ? Math.Max(0f, weights[slot]) : 0f;
                    weights[slot] = weight;
                    sum += weight;
                }

                if (sum > SkinWeightEpsilon)
                {
                    for (var slot = 0; slot < 4; slot++)
                    {
                        var weight = weights[slot] / sum;
                        normalizedWeights[output + slot] = weight;
                        if (weight <= SkinWeightEpsilon)
                        {
                            globalIndices[output + slot] = 0;
                            continue;
                        }
                        if (!TryRemapPaletteIndex(rawIndices[slot], out globalIndices[output + slot]))
                            return false;
                    }
                    continue;
                }
            }

            if (!TryRigidNormalW(vertex, out var rigidBone)) return false;
            globalIndices[output] = rigidBone;
            normalizedWeights[output] = 1f;
        }

        return true;
    }

    private bool TryReadWeights(VertexMemberAccess access, int vertexIndex, Span<float> weights)
    {
        if (weights.Length < 4 || !HasMemberBytes(access, vertexIndex)) return false;
        var off = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        switch (access.Type)
        {
            case TypeByte4C:
                for (var i = 0; i < 4; i++) weights[i] = ReadByte(_source, (int)off + i) / 255f;
                return true;
            case TypeByte4A:
                for (var i = 0; i < 4; i++) weights[i] = Math.Max(0f, ReadSByte(_source, (int)off + i) / 127f);
                return true;
            case TypeUVPair:
            case TypeShort4toFloat4A:
                for (var i = 0; i < 4; i++) weights[i] = Math.Max(0f, ReadInt16(_source, (int)off + i * 2) / 32767f);
                return true;
            default:
                return false;
        }
    }

    private bool TryReadBoneIndices(VertexMemberAccess access, int vertexIndex, Span<int> indices)
    {
        if (indices.Length < 4 || !HasMemberBytes(access, vertexIndex)) return false;
        var off = access.DataBase + (long)vertexIndex * access.Stride + access.Offset;
        if (access.Type == TypeShortBoneIndices)
        {
            for (var i = 0; i < 4; i++) indices[i] = ReadUInt16(_source, (int)off + i * 2);
            return true;
        }
        if (access.Type is TypeByte4B or TypeByte4E)
        {
            for (var i = 0; i < 4; i++) indices[i] = ReadByte(_source, (int)off + i);
            return true;
        }
        return false;
    }

    public string? GetMeshBoneWeightsBase64(int meshIndex, int maxVertices = 10_000)
    {
        if (!TryBuildMeshSkinning(meshIndex, maxVertices, out _, out var weights)) return null;
        var bytes = new byte[weights.Length * 4];
        Buffer.BlockCopy(weights, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    public string? GetMeshBoneIndicesBase64(int meshIndex, int maxVertices = 10_000)
    {
        if (!TryBuildMeshSkinning(meshIndex, maxVertices, out var indices, out _)) return null;
        var bytes = new byte[indices.Length * 2];
        Buffer.BlockCopy(indices, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    public int GetMeshIndexSize(int meshIndex)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return 16;
        var mesh = Meshes[meshIndex];
        if (mesh.FaceSetIndices.Count == 0) return 16;
        var candidates = mesh.FaceSetIndices
            .Where(i => i >= 0 && i < _faceSets.Count)
            .Select(i => _faceSets[i])
            .ToList();
        if (candidates.Count == 0) return 16;
        var selected = candidates.FirstOrDefault(fs => fs.Flags == 0) ?? candidates[0];
        return selected.IndexSize == 32 ? 32 : 16;
    }

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
        if (fs.IndexSize != 16 && fs.IndexSize != 32) return null;
        if (fs.IndexCount <= 0 || fs.IndexCount > MaxIndexCount || maxIndices < 3) return null;

        var bytesPerIndex = fs.IndexSize / 8;
        var indexDataOffset = (long)DataStart + fs.IndicesOffset;
        var sourceByteLength = (long)fs.IndexCount * bytesPerIndex;
        if (indexDataOffset < 0 || indexDataOffset + sourceByteLength > _source.Length) return null;

        var sourceIndices = new uint[fs.IndexCount];
        for (var i = 0; i < sourceIndices.Length; i++)
        {
            var offset = checked((int)(indexDataOffset + (long)i * bytesPerIndex));
            sourceIndices[i] = fs.IndexSize == 32 ? ReadUInt32(_source, offset) : ReadUInt16(_source, offset);
        }

        var triangleIndices = FlverTriangleTopology.ToTriangleList(
            sourceIndices,
            fs.TriangleStrip,
            mesh.VertexCount < ushort.MaxValue,
            maxIndices);
        if (triangleIndices.Length == 0) return null;
        if (triangleIndices.Any(index => index >= mesh.VertexCount)) return null;

        var raw = new byte[triangleIndices.Length * bytesPerIndex];
        for (var i = 0; i < triangleIndices.Length; i++)
        {
            var offset = i * bytesPerIndex;
            if (fs.IndexSize == 32)
            {
                BinaryPrimitives.WriteUInt32LittleEndian(raw.AsSpan(offset, 4), triangleIndices[i]);
            }
            else
            {
                if (triangleIndices[i] > ushort.MaxValue) return null;
                BinaryPrimitives.WriteUInt16LittleEndian(raw.AsSpan(offset, 2), (ushort)triangleIndices[i]);
            }
        }
        return Convert.ToBase64String(raw);
    }

    public IReadOnlyList<FlverTextureSlotEntry> GetTextureSlots() => _textureSlots;
    public IReadOnlyList<FlverDummyEntry> GetDummies() => Dummies;

    public static FlverNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"FLVER 大小 {source.Length} 超出安全范围。");

        for (var i = 0; i < MagicBytes.Length; i++)
        {
            if (source[i] != MagicBytes[i])
                throw new InvalidDataException($"FLVER 魔数不匹配；偏移 {i} 处为 0x{source[i]:X2}，期望 0x{MagicBytes[i]:X2}。");
        }

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
        if (Array.IndexOf(SupportedInternalVersions, internalVersion) < 0)
        {
            var supported = string.Join(", ", Array.ConvertAll(SupportedInternalVersions, v => $"0x{v:X}"));
            throw new NotSupportedException(
                $"仅支持已验证的 FLVER internalVersion（{supported}），收到 0x{internalVersion:X}。"
                + " 不同 version 的 UV 除数与 FaceSet indexSize 字段布局不同；"
                + "要支持新版本需先登记真实样本并通过往返验证。");
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
            throw new InvalidDataException($"FLVER 结构表越过 dataStart：sectionEnd=0x{sectionEnd:X} dataStart=0x{dataStart:X}。");

        var off = HeaderSize;
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
            if (reserved != 0)
                warnings.Add($"material[{i}]:+0x1C 保留字段应为 0，实际 {reserved}（布局可能与已登记形态不同）。");

            FlverGxList? gxList = null;
            if (gxOffset != 0)
            {
                gxList = TryReadGxList(source, gxOffset, out var gxError);
                if (gxList is null)
                    warnings.Add($"material[{i}]:GX 列表解析失败（gxOffset={gxOffset}）：{gxError}");
            }
            materials.Add(new FlverMaterialEntry(
                i, name, mtdPath, textureCountInMaterial, firstTextureIndex,
                flags, gxOffset, unk18, gxList));
        }

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
                translationX, translationY, translationZ, rotationX, rotationY, rotationZ));
        }

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

            var boneIndices = ReadIndexArray(source, boneOffset, boneCountInMesh, boneCount);
            var faceSetIndices = ReadIndexArray(source, faceSetOffset, faceSetCountInMesh, faceSetCount);
            var vertexBufferIndices = ReadIndexArray(source, vertexBufferOffset, vertexBufferCountInMesh, vertexBufferCount);
            meshes.Add(new FlverMeshEntry(i, dynamic, materialIndex, defaultBoneIndex,
                vertexBufferCountInMesh, vertexBufferIndices,
                0, 0, -1,
                faceSetCountInMesh, faceSetIndices, 0,
                boneCountInMesh, boneIndices));
        }

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
                members.Add(new FlverLayoutMemberEntry(
                    ReadInt32(source, e + 0x00),
                    ReadInt32(source, e + 0x04),
                    ReadUInt32(source, e + 0x08),
                    ReadUInt32(source, e + 0x0C),
                    ReadInt32(source, e + 0x10)));
            }
            bufferLayouts.Add(new FlverBufferLayoutEntry(members));
        }

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
            var primaryFaceSet = mesh.FaceSetIndices
                .Where(index => index >= 0 && index < faceSets.Count)
                .Select(index => faceSets[index])
                .FirstOrDefault(faceSet => faceSet.Flags == 0)
                ?? mesh.FaceSetIndices
                    .Where(index => index >= 0 && index < faceSets.Count)
                    .Select(index => faceSets[index])
                    .FirstOrDefault();
            if (primaryFaceSet != null) indexFormat = primaryFaceSet.IndexSize;

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

    private static FlverGxList? TryReadGxList(byte[] source, int gxOffset, out string error)
    {
        error = string.Empty;
        if (gxOffset < 0 || (long)gxOffset + 12 > source.Length)
        {
            error = $"偏移越界（文件 {source.Length} 字节）";
            return null;
        }

        var items = new List<FlverGxItem>();
        var position = gxOffset;
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
            if (id == int.MaxValue || id == -1) break;
            var unk04 = ReadInt32(source, position + 4);
            var itemLength = ReadInt32(source, position + 8);
            if (itemLength < 12 || (long)position + itemLength > source.Length)
            {
                error = $"item 长度不合法（{itemLength}）";
                return null;
            }
            var idAscii = Encoding.ASCII.GetString(source, position, 4);
            items.Add(new FlverGxItem(idAscii, id, unk04, itemLength, itemLength - 12));
            position += itemLength;
        }

        var terminatorId = ReadInt32(source, position);
        var hundred = ReadInt32(source, position + 4);
        if (hundred != 100)
        {
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
        if (internalVersion >= 0x2001A) off += SekiroUnkHeaderSize;
        return off;
    }

    private static List<int> ReadIndexArray(byte[] source, int offset, int count, int maxValid)
    {
        if (count < 0 || count > maxValid) return new List<int>();
        if (offset < 0 || (long)offset + (long)count * 4 > source.Length) return new List<int>();
        var list = new List<int>(count);
        for (var i = 0; i < count; i++) list.Add(ReadInt32(source, offset + i * 4));
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
            textureSlots = _textureSlots.Take(SampleLimit).Select(t => new
            {
                index = t.Index,
                type = t.Type,
                path = t.Path,
                materialIndex = t.MaterialIndex
            }).ToArray(),
            texturesTruncated = _textureSlots.Count > SampleLimit,
            layoutWarnings = _layoutWarnings.ToArray(),
            unparsedGaps = gaps,
            roundTrip = rt,
            authority
        };
    }

    private void AddLayoutWarning(string message)
    {
        if (_layoutWarnings.Count < 64) _layoutWarnings.Add(message);
    }

    private void AddUnparsedGap(string message)
    {
        if (_unparsedGaps.Count < 64) _unparsedGaps.Add(message);
    }

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

        if (payloadBytes > 0)
        {
            AddUnparsedGap(
                $"material:GX item payload 未解码（按 ID 分歧的材质着色参数，只按 (id, unk04, length) 上报）；"
                + $"lists={listCount}, items={itemCount}, payloadBytes={payloadBytes}");
        }
        if (failedLists > 0)
            AddUnparsedGap($"material:GX 列表解析失败 {failedLists} 条（布局与已登记形态不同）");
    }

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

    private static int MemberTypeSize(uint type) => type switch
    {
        TypeEdgeCompressed => 1,
        TypeFloat2 or TypeByte4A or TypeByte4B or TypeShort2toFloat2 or TypeByte4C or TypeUV or TypeByte4E => 4,
        TypeFloat3 => 12,
        TypeFloat4 => 16,
        TypeUVPair or TypeShortBoneIndices or TypeShort4toFloat4A or TypeShort4toFloat4B => 8,
        _ => 0
    };

    private float ReadByteNorm(int offset) => (ReadByte(_source, offset) - 127) / 127f;

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
    private static float ReadFloat32(byte[] source, int offset) => BitConverter.Int32BitsToSingle(ReadInt32(source, offset));
    private static float ReadHalf(byte[] source, int offset) => (float)BitConverter.UInt16BitsToHalf(ReadUInt16(source, offset));

    private static string ReadStringAtOffset(byte[] source, int absoluteOffset, bool unicode)
    {
        if (absoluteOffset <= HeaderSize || absoluteOffset >= source.Length) return string.Empty;
        return unicode
            ? ReadUtf16NullTerminated(source, absoluteOffset, MaxStringBytes)
            : ReadAsciiOrLatin1NullTerminated(source, absoluteOffset, MaxStringBytes);
    }

    private static string ReadUtf16NullTerminated(byte[] source, int offset, int maxBytes)
    {
        if (offset < 0 || offset >= source.Length) return string.Empty;
        var end = Math.Min(offset + maxBytes, source.Length - 1);
        var pos = offset;
        while (pos < end)
        {
            if (source[pos] == 0 && source[pos + 1] == 0) break;
            pos += 2;
        }
        var byteLength = pos - offset;
        return byteLength <= 0 ? string.Empty : Encoding.Unicode.GetString(source, offset, byteLength);
    }

    private static string ReadAsciiOrLatin1NullTerminated(byte[] source, int offset, int maxBytes)
    {
        if (offset < 0 || offset >= source.Length) return string.Empty;
        var end = Math.Min(offset + maxBytes, source.Length);
        var pos = offset;
        while (pos < end && source[pos] != 0) pos++;
        var byteLength = pos - offset;
        return byteLength <= 0 ? string.Empty : Encoding.Latin1.GetString(source, offset, byteLength);
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record FlverMaterialEntry(
    int Index, string Name, string MtdPath, int TextureCount, int FirstTextureIndex,
    int Flags, int GxOffset, int Unk18, FlverGxList? GxList);
internal sealed record FlverGxList(
    IReadOnlyList<FlverGxItem> Items, int TerminatorId, int TerminatorLength,
    bool TerminatorPaddingAllZero, int ByteLength);
internal sealed record FlverGxItem(string Id, int RawId, int Unk04, int ItemLength, int DataLength);
internal sealed record FlverBoneEntry(
    int Index, string Name, short NextSiblingIndex, short ParentIndex, short ChildIndex,
    float TranslationX, float TranslationY, float TranslationZ,
    float RotationX, float RotationY, float RotationZ);
internal sealed record FlverMeshEntry(
    int Index, byte Dynamic, int MaterialIndex, int DefaultBoneIndex,
    int VertexBufferCount, IReadOnlyList<int> VertexBufferIndices,
    int VertexCount, int VertexStride, int BufferLayoutIndex,
    int FaceSetCount, IReadOnlyList<int> FaceSetIndices, int IndexFormat,
    int BoneCount, IReadOnlyList<int> BoneIndices);
internal sealed record FlverVertexBufferEntry(
    int BufferIndex, int LayoutIndex, int VertexSize, int VertexCount, int BufferLength, int BufferOffset);
internal sealed record FlverLayoutMemberEntry(int Unk00, int StructOffset, uint Type, uint Semantic, int Index);
internal sealed record FlverBufferLayoutEntry(IReadOnlyList<FlverLayoutMemberEntry> Members);
internal sealed record FlverFaceSetEntry(uint Flags, bool TriangleStrip, int IndexCount, int IndicesOffset, int IndexSize);
internal sealed record FlverTextureSlotEntry(int Index, string Type, string Path, int MaterialIndex);
internal sealed record FlverDummyEntry(
    int Index, float PositionX, float PositionY, float PositionZ,
    short ReferenceId, short ParentBoneIndex, short AttachBoneIndex);
internal sealed record FlverRoundTripReport(
    bool ByteIdentical, bool SemanticIdentical,
    string SourceHash, string RebuiltHash,
    int SkeletonTransformCount, int MaterialCount, int BoneCount, int MeshCount);

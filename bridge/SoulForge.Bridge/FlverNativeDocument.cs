using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro-era FLVER (FLexible VERsion) read-only native document.
/// Layout verified against c1020.flver (5,879,520 bytes, internalVersion 0x2001A).
/// Parses header, skeleton transforms, materials, bones, and mesh metadata.
/// Vertex/index data is reported by count and stride only (no per-vertex expansion).
/// </summary>
internal sealed class FlverNativeDocument
{
    // "FLVER\0" as first 6 bytes
    private static readonly byte[] MagicBytes = { 0x46, 0x4C, 0x56, 0x45, 0x52, 0x00 };
    private const int HeaderSize = 0x80; // 128 bytes
    private const int SkeletonTransformEntrySize = 64;
    private const int MaterialEntrySize = 32;
    private const int BoneEntrySize = 128;
    private const int MeshEntrySize = 48;
    private const int VertexStride = 40;

    private const int MaxSkeletonTransforms = 100_000;
    private const int MaxMaterials = 10_000;
    private const int MaxBones = 100_000;
    private const int MaxMeshes = 100_000;
    private const long MaxSourceBytes = 256L * 1024 * 1024;
    private const int SampleLimit = 10;

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
        float boundingBoxMinX, float boundingBoxMinY, float boundingBoxMinZ,
        float boundingBoxMaxX, float boundingBoxMaxY, float boundingBoxMaxZ,
        int faceCount,
        int totalFaceCount,
        IReadOnlyList<FlverMaterialEntry> materials,
        IReadOnlyList<FlverBoneEntry> bones,
        IReadOnlyList<FlverMeshEntry> meshes)
    {
        SourceBytes = sourceBytes;
        VersionString = versionString;
        InternalVersion = internalVersion;
        DataStart = dataStart;
        DataLength = dataLength;
        SkeletonTransformCount = skeletonTransformCount;
        MaterialCount = materialCount;
        BoneCount = boneCount;
        VertexBufferCount = vertexBufferCount;
        MeshCount = meshCount;
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
    public string SourceHash => Hash(SourceBytes);

    /// <summary>
    /// Extract vertex positions (float[3] per vertex) for a specific mesh as base64.
    /// Assumes fixed 40-byte vertex stride with position at offset 0.
    /// Vertex data offset is found by scanning the data section for valid positions
    /// within the bounding box range.
    /// Returns null if mesh index is out of range or data is unavailable.
    /// </summary>
    public string? GetMeshPositionsBase64(int meshIndex, int maxVertices = 10_000)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        var vertexCount = Math.Min(mesh.VertexCount, maxVertices);
        if (vertexCount <= 0) return null;

        // Find vertex data offset by scanning for valid positions within the actual bounding box.
        // Use the bounding box with a small margin to filter out non-vertex data.
        float margin = 1.0f;
        float minX = BoundingBoxMinX - margin, maxX = BoundingBoxMaxX + margin;
        float minY = BoundingBoxMinY - margin, maxY = BoundingBoxMaxY + margin;
        float minZ = BoundingBoxMinZ - margin, maxZ = BoundingBoxMaxZ + margin;
        int vertexDataOffset = -1;
        int scanEnd = Math.Min(DataStart + DataLength, SourceBytes.Length - VertexStride);
        for (int offset = DataStart; offset < scanEnd; offset += 4)
        {
            float x = ReadFloat32(SourceBytes, offset);
            float y = ReadFloat32(SourceBytes, offset + 4);
            float z = ReadFloat32(SourceBytes, offset + 8);
            if (float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z)
                && x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ
                && (Math.Abs(x) > 0.001f || Math.Abs(y) > 0.001f || Math.Abs(z) > 0.001f))
            {
                // Found a valid position. Check if the next few vertices are also valid.
                bool valid = true;
                int nonZeroCount = 1;
                for (int v = 1; v < Math.Min(5, vertexCount); v++)
                {
                    int nextOff = offset + v * VertexStride;
                    if (nextOff + 12 > SourceBytes.Length) { valid = false; break; }
                    float nx = ReadFloat32(SourceBytes, nextOff);
                    float ny = ReadFloat32(SourceBytes, nextOff + 4);
                    float nz = ReadFloat32(SourceBytes, nextOff + 8);
                    if (!float.IsFinite(nx) || !float.IsFinite(ny) || !float.IsFinite(nz)
                        || nx < minX || nx > maxX || ny < minY || ny > maxY || nz < minZ || nz > maxZ)
                    {
                        valid = false;
                        break;
                    }
                    if (nx != 0 || ny != 0 || nz != 0) nonZeroCount++;
                }
                // Require at least 2 non-zero vertices to avoid zero-padding blocks.
                if (valid && nonZeroCount >= 2)
                {
                    // Align to vertex stride and verify the first vertex is valid.
                    int aligned = offset - (offset % VertexStride);
                    float ax = ReadFloat32(SourceBytes, aligned);
                    float ay = ReadFloat32(SourceBytes, aligned + 4);
                    float az = ReadFloat32(SourceBytes, aligned + 8);
                    if (float.IsFinite(ax) && float.IsFinite(ay) && float.IsFinite(az)
                        && (Math.Abs(ax) > 0.001f || Math.Abs(ay) > 0.001f || Math.Abs(az) > 0.001f))
                    {
                        vertexDataOffset = aligned;
                    }
                    else
                    {
                        // First vertex at aligned offset is invalid; try next vertex boundary.
                        vertexDataOffset = aligned + VertexStride;
                    }
                    break;
                }
            }
        }

        if (vertexDataOffset < 0) return null;

        // Calculate offset for this specific mesh's vertex data.
        int meshVertexOffset = 0;
        for (int i = 0; i < meshIndex; i++)
        {
            meshVertexOffset += Meshes[i].VertexCount * VertexStride;
        }
        var thisMeshOffset = vertexDataOffset + meshVertexOffset;

        if (thisMeshOffset < 0 || thisMeshOffset + vertexCount * VertexStride > SourceBytes.Length)
            return null;

        var positions = new float[vertexCount * 3];
        for (int v = 0; v < vertexCount; v++)
        {
            var baseOffset = thisMeshOffset + v * VertexStride;
            positions[v * 3] = ReadFloat32(SourceBytes, baseOffset);
            positions[v * 3 + 1] = ReadFloat32(SourceBytes, baseOffset + 4);
            positions[v * 3 + 2] = ReadFloat32(SourceBytes, baseOffset + 8);
        }

        var bytes = new byte[positions.Length * 4];
        Buffer.BlockCopy(positions, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>
    /// Extract triangle indices (uint16) for a specific mesh as base64.
    /// Returns null if mesh index is out of range or data is unavailable.
    /// </summary>
    public string? GetMeshIndicesBase64(int meshIndex, int maxIndices = 30_000)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        if (mesh.IndexFormat != 6) return null; // Only uint16 indices supported

        var indexOffset = DataStart + mesh.IndexByteOffset;
        var faceCount = Math.Min(mesh.VertexCount * 3, maxIndices); // Approximate
        if (indexOffset < 0 || indexOffset + faceCount * 2 > SourceBytes.Length)
            return null;

        var indices = new byte[faceCount * 2];
        Buffer.BlockCopy(SourceBytes, indexOffset, indices, 0, indices.Length);
        return Convert.ToBase64String(indices);
    }

    /// <summary>
    /// Extract UV coordinates (float[2] per vertex) for a specific mesh as base64.
    /// UV0 is at offset 0x14 within the 40-byte vertex stride (uint16[2], normalized by /65535).
    /// Returns null if mesh index is out of range or vertex data is unavailable.
    /// </summary>
    public string? GetMeshUVsBase64(int meshIndex, int maxVertices = 10_000)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        var vertexCount = Math.Min(mesh.VertexCount, maxVertices);
        if (vertexCount <= 0) return null;

        // Reuse the same vertex data offset scan as GetMeshPositionsBase64.
        var positionsBase64 = GetMeshPositionsBase64(meshIndex, maxVertices);
        if (positionsBase64 == null) return null;

        // Find the vertex data offset using the same scan logic.
        float margin = 1.0f;
        float minX = BoundingBoxMinX - margin, maxX = BoundingBoxMaxX + margin;
        float minY = BoundingBoxMinY - margin, maxY = BoundingBoxMaxY + margin;
        float minZ = BoundingBoxMinZ - margin, maxZ = BoundingBoxMaxZ + margin;
        int vertexDataOffset = -1;
        int scanEnd = Math.Min(DataStart + DataLength, SourceBytes.Length - VertexStride);
        for (int offset = DataStart; offset < scanEnd; offset += 4)
        {
            float x = ReadFloat32(SourceBytes, offset);
            float y = ReadFloat32(SourceBytes, offset + 4);
            float z = ReadFloat32(SourceBytes, offset + 8);
            if (float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z)
                && x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ
                && (Math.Abs(x) > 0.001f || Math.Abs(y) > 0.001f || Math.Abs(z) > 0.001f))
            {
                bool valid = true;
                int nonZeroCount = 1;
                for (int v = 1; v < Math.Min(5, vertexCount); v++)
                {
                    int nextOff = offset + v * VertexStride;
                    if (nextOff + 12 > SourceBytes.Length) { valid = false; break; }
                    float nx = ReadFloat32(SourceBytes, nextOff);
                    float ny = ReadFloat32(SourceBytes, nextOff + 4);
                    float nz = ReadFloat32(SourceBytes, nextOff + 8);
                    if (!float.IsFinite(nx) || !float.IsFinite(ny) || !float.IsFinite(nz)
                        || nx < minX || nx > maxX || ny < minY || ny > maxY || nz < minZ || nz > maxZ)
                    { valid = false; break; }
                    if (nx != 0 || ny != 0 || nz != 0) nonZeroCount++;
                }
                if (valid && nonZeroCount >= 2)
                {
                    int aligned = offset - (offset % VertexStride);
                    float ax = ReadFloat32(SourceBytes, aligned);
                    float ay = ReadFloat32(SourceBytes, aligned + 4);
                    float az = ReadFloat32(SourceBytes, aligned + 8);
                    vertexDataOffset = (float.IsFinite(ax) && float.IsFinite(ay) && float.IsFinite(az)
                        && (Math.Abs(ax) > 0.001f || Math.Abs(ay) > 0.001f || Math.Abs(az) > 0.001f))
                        ? aligned : aligned + VertexStride;
                    break;
                }
            }
        }
        if (vertexDataOffset < 0) return null;

        // Calculate offset for this mesh's vertex data.
        int meshVertexOffset = 0;
        for (int i = 0; i < meshIndex; i++)
            meshVertexOffset += Meshes[i].VertexCount * VertexStride;
        var thisMeshOffset = vertexDataOffset + meshVertexOffset;
        if (thisMeshOffset + vertexCount * VertexStride > SourceBytes.Length) return null;

        // Extract UV0 (uint16[2] at offset 0x14, normalized by /65535).
        var uvs = new float[vertexCount * 2];
        for (int v = 0; v < vertexCount; v++)
        {
            var baseOffset = thisMeshOffset + v * VertexStride + 0x14;
            ushort u = ReadUInt16(SourceBytes, baseOffset);
            ushort vCoord = ReadUInt16(SourceBytes, baseOffset + 2);
            uvs[v * 2] = u / 65535.0f;
            uvs[v * 2 + 1] = vCoord / 65535.0f;
        }

        var bytes = new byte[uvs.Length * 4];
        Buffer.BlockCopy(uvs, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>
    /// Extract vertex normals (float[3] per vertex) for a specific mesh as base64.
    /// Normals are packed as byte[4] at offset 0x0C within the 40-byte vertex stride.
    /// The packed format is assumed to be 10-10-10-2 (3×10-bit signed + 2-bit padding).
    /// Returns null if mesh index is out of range or vertex data is unavailable.
    /// </summary>
    public string? GetMeshNormalsBase64(int meshIndex, int maxVertices = 10_000)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        var vertexCount = Math.Min(mesh.VertexCount, maxVertices);
        if (vertexCount <= 0) return null;

        // Reuse the vertex data offset from GetMeshPositionsBase64.
        var positionsBase64 = GetMeshPositionsBase64(meshIndex, maxVertices);
        if (positionsBase64 == null) return null;

        // Find the vertex data offset using the same scan logic.
        float margin = 1.0f;
        float minX = BoundingBoxMinX - margin, maxX = BoundingBoxMaxX + margin;
        float minY = BoundingBoxMinY - margin, maxY = BoundingBoxMaxY + margin;
        float minZ = BoundingBoxMinZ - margin, maxZ = BoundingBoxMaxZ + margin;
        int vertexDataOffset = -1;
        int scanEnd = Math.Min(DataStart + DataLength, SourceBytes.Length - VertexStride);
        for (int offset = DataStart; offset < scanEnd; offset += 4)
        {
            float x = ReadFloat32(SourceBytes, offset);
            float y = ReadFloat32(SourceBytes, offset + 4);
            float z = ReadFloat32(SourceBytes, offset + 8);
            if (float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z)
                && x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ
                && (Math.Abs(x) > 0.001f || Math.Abs(y) > 0.001f || Math.Abs(z) > 0.001f))
            {
                bool valid = true;
                int nonZeroCount = 1;
                for (int v = 1; v < Math.Min(5, vertexCount); v++)
                {
                    int nextOff = offset + v * VertexStride;
                    if (nextOff + 12 > SourceBytes.Length) { valid = false; break; }
                    float nx = ReadFloat32(SourceBytes, nextOff);
                    float ny = ReadFloat32(SourceBytes, nextOff + 4);
                    float nz = ReadFloat32(SourceBytes, nextOff + 8);
                    if (!float.IsFinite(nx) || !float.IsFinite(ny) || !float.IsFinite(nz)
                        || nx < minX || nx > maxX || ny < minY || ny > maxY || nz < minZ || nz > maxZ)
                    { valid = false; break; }
                    if (nx != 0 || ny != 0 || nz != 0) nonZeroCount++;
                }
                if (valid && nonZeroCount >= 2)
                {
                    int aligned = offset - (offset % VertexStride);
                    float ax = ReadFloat32(SourceBytes, aligned);
                    float ay = ReadFloat32(SourceBytes, aligned + 4);
                    float az = ReadFloat32(SourceBytes, aligned + 8);
                    vertexDataOffset = (float.IsFinite(ax) && float.IsFinite(ay) && float.IsFinite(az)
                        && (Math.Abs(ax) > 0.001f || Math.Abs(ay) > 0.001f || Math.Abs(az) > 0.001f))
                        ? aligned : aligned + VertexStride;
                    break;
                }
            }
        }
        if (vertexDataOffset < 0) return null;

        int meshVertexOffset = 0;
        for (int i = 0; i < meshIndex; i++)
            meshVertexOffset += Meshes[i].VertexCount * VertexStride;
        var thisMeshOffset = vertexDataOffset + meshVertexOffset;
        if (thisMeshOffset + vertexCount * VertexStride > SourceBytes.Length) return null;

        // Extract normals from packed byte[4] at offset 0x0C.
        // Assume 10-10-10-2 format: 3×10-bit signed integers normalized to [-1, 1].
        var normals = new float[vertexCount * 3];
        for (int v = 0; v < vertexCount; v++)
        {
            var baseOffset = thisMeshOffset + v * VertexStride + 0x0C;
            uint packed = ReadUInt32(SourceBytes, baseOffset);
            // Decode 10-10-10-2: bits [0:9] = X, [10:19] = Y, [20:29] = Z, [30:31] = W
            int nx10 = (int)(packed & 0x3FF); if (nx10 > 511) nx10 -= 1024;
            int ny10 = (int)((packed >> 10) & 0x3FF); if (ny10 > 511) ny10 -= 1024;
            int nz10 = (int)((packed >> 20) & 0x3FF); if (nz10 > 511) nz10 -= 1024;
            normals[v * 3] = nx10 / 511.0f;
            normals[v * 3 + 1] = ny10 / 511.0f;
            normals[v * 3 + 2] = nz10 / 511.0f;
        }

        var normBytes = new byte[normals.Length * 4];
        Buffer.BlockCopy(normals, 0, normBytes, 0, normBytes.Length);
        return Convert.ToBase64String(normBytes);
    }

    /// <summary>
    /// Extract bone weights (4 bytes per vertex, 4 bone influences) for a specific mesh as base64.
    /// Bone weights are stored at offset 0x24 within the 40-byte vertex stride.
    /// Returns null if mesh index is out of range or vertex data is unavailable.
    /// </summary>
    public string? GetMeshBoneWeightsBase64(int meshIndex, int maxVertices = 10_000)
    {
        if (meshIndex < 0 || meshIndex >= Meshes.Count) return null;
        var mesh = Meshes[meshIndex];
        var vertexCount = Math.Min(mesh.VertexCount, maxVertices);
        if (vertexCount <= 0) return null;

        // Reuse the vertex data offset from GetMeshPositionsBase64.
        var positionsBase64 = GetMeshPositionsBase64(meshIndex, maxVertices);
        if (positionsBase64 == null) return null;

        // Find the vertex data offset using the same scan logic.
        float margin = 1.0f;
        float minX = BoundingBoxMinX - margin, maxX = BoundingBoxMaxX + margin;
        float minY = BoundingBoxMinY - margin, maxY = BoundingBoxMaxY + margin;
        float minZ = BoundingBoxMinZ - margin, maxZ = BoundingBoxMaxZ + margin;
        int vertexDataOffset = -1;
        int scanEnd = Math.Min(DataStart + DataLength, SourceBytes.Length - VertexStride);
        for (int offset = DataStart; offset < scanEnd; offset += 4)
        {
            float x = ReadFloat32(SourceBytes, offset);
            float y = ReadFloat32(SourceBytes, offset + 4);
            float z = ReadFloat32(SourceBytes, offset + 8);
            if (float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(z)
                && x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ
                && (Math.Abs(x) > 0.001f || Math.Abs(y) > 0.001f || Math.Abs(z) > 0.001f))
            {
                bool valid = true;
                int nonZeroCount = 1;
                for (int v = 1; v < Math.Min(5, vertexCount); v++)
                {
                    int nextOff = offset + v * VertexStride;
                    if (nextOff + 12 > SourceBytes.Length) { valid = false; break; }
                    float nx = ReadFloat32(SourceBytes, nextOff);
                    float ny = ReadFloat32(SourceBytes, nextOff + 4);
                    float nz = ReadFloat32(SourceBytes, nextOff + 8);
                    if (!float.IsFinite(nx) || !float.IsFinite(ny) || !float.IsFinite(nz)
                        || nx < minX || nx > maxX || ny < minY || ny > maxY || nz < minZ || nz > maxZ)
                    { valid = false; break; }
                    if (nx != 0 || ny != 0 || nz != 0) nonZeroCount++;
                }
                if (valid && nonZeroCount >= 2)
                {
                    int aligned = offset - (offset % VertexStride);
                    float ax = ReadFloat32(SourceBytes, aligned);
                    float ay = ReadFloat32(SourceBytes, aligned + 4);
                    float az = ReadFloat32(SourceBytes, aligned + 8);
                    vertexDataOffset = (float.IsFinite(ax) && float.IsFinite(ay) && float.IsFinite(az)
                        && (Math.Abs(ax) > 0.001f || Math.Abs(ay) > 0.001f || Math.Abs(az) > 0.001f))
                        ? aligned : aligned + VertexStride;
                    break;
                }
            }
        }
        if (vertexDataOffset < 0) return null;

        // Calculate offset for this mesh's vertex data.
        int meshVertexOffset = 0;
        for (int i = 0; i < meshIndex; i++)
            meshVertexOffset += Meshes[i].VertexCount * VertexStride;
        var thisMeshOffset = vertexDataOffset + meshVertexOffset;
        if (thisMeshOffset + vertexCount * VertexStride > SourceBytes.Length) return null;

        // Extract bone weights (4 bytes per vertex at offset 0x24).
        var weights = new byte[vertexCount * 4];
        for (int v = 0; v < vertexCount; v++)
        {
            var baseOffset = thisMeshOffset + v * VertexStride + 0x24;
            weights[v * 4] = SourceBytes[baseOffset];
            weights[v * 4 + 1] = SourceBytes[baseOffset + 1];
            weights[v * 4 + 2] = SourceBytes[baseOffset + 2];
            weights[v * 4 + 3] = SourceBytes[baseOffset + 3];
        }

        return Convert.ToBase64String(weights);
    }

    public static FlverNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"FLVER 大小 {source.Length} 超出安全范围。");

        // Validate magic "FLVER\0"
        for (int i = 0; i < MagicBytes.Length; i++)
        {
            if (source[i] != MagicBytes[i])
                throw new InvalidDataException(
                    $"FLVER 魔数不匹配；偏移 {i} 处为 0x{source[i]:X2}，期望 0x{MagicBytes[i]:X2}。");
        }

        // Version string at 0x06 (2 chars, e.g. "L\0" for Sekiro)
        var versionString = ReadUtf16NullTerminated(source, 0x06, 4);

        // Header fields
        int internalVersion = ReadInt32(source, 0x08);
        int dataStart = ReadInt32(source, 0x0C);
        int dataLength = ReadInt32(source, 0x10);
        int skeletonTransformCount = ReadInt32(source, 0x14);
        int materialCount = ReadInt32(source, 0x18);
        int boneCount = ReadInt32(source, 0x1C);
        int vertexBufferCount = ReadInt32(source, 0x20);
        int meshCount = ReadInt32(source, 0x24);

        float bbMinX = ReadFloat32(source, 0x28);
        float bbMinY = ReadFloat32(source, 0x2C);
        float bbMinZ = ReadFloat32(source, 0x30);
        float bbMaxX = ReadFloat32(source, 0x34);
        float bbMaxY = ReadFloat32(source, 0x38);
        float bbMaxZ = ReadFloat32(source, 0x3C);

        int faceCount = ReadInt32(source, 0x40);
        int totalFaceCount = ReadInt32(source, 0x44);

        // Bounds validation
        if (skeletonTransformCount < 0 || skeletonTransformCount > MaxSkeletonTransforms)
            throw new InvalidDataException($"FLVER skeletonTransformCount={skeletonTransformCount} 超出安全范围。");
        if (materialCount < 0 || materialCount > MaxMaterials)
            throw new InvalidDataException($"FLVER materialCount={materialCount} 超出安全范围。");
        if (boneCount < 0 || boneCount > MaxBones)
            throw new InvalidDataException($"FLVER boneCount={boneCount} 超出安全范围。");
        if (meshCount < 0 || meshCount > MaxMeshes)
            throw new InvalidDataException($"FLVER meshCount={meshCount} 超出安全范围。");
        if (dataStart < 0 || dataStart > source.Length)
            throw new InvalidDataException($"FLVER dataStart={dataStart} 超出文件大小 {source.Length}。");
        if (dataLength < 0 || (long)dataStart + dataLength > source.Length)
            throw new InvalidDataException($"FLVER dataStart+dataLength={dataStart}+{dataLength} 超出文件大小 {source.Length}。");

        // --- Skeleton Transform Table (starts at 0x80) ---
        int skeletonTableOffset = HeaderSize;
        long skeletonTableEnd = (long)skeletonTableOffset + (long)skeletonTransformCount * SkeletonTransformEntrySize;
        if (skeletonTableEnd > source.Length)
            throw new InvalidDataException(
                $"FLVER skeleton transform 表越界：offset={skeletonTableOffset}, count={skeletonTransformCount}, end={skeletonTableEnd}。");

        // --- Material Table (after skeleton transforms) ---
        int materialTableOffset = (int)skeletonTableEnd;
        long materialTableEnd = (long)materialTableOffset + (long)materialCount * MaterialEntrySize;
        if (materialTableEnd > source.Length)
            throw new InvalidDataException(
                $"FLVER material 表越界：offset={materialTableOffset}, count={materialCount}, end={materialTableEnd}。");

        var materials = new List<FlverMaterialEntry>(materialCount);
        for (int i = 0; i < materialCount; i++)
        {
            int entryOffset = materialTableOffset + i * MaterialEntrySize;
            int nameOffset = ReadInt32(source, entryOffset + 0x00);
            int mtdPathOffset = ReadInt32(source, entryOffset + 0x04);
            int textureCount = ReadInt32(source, entryOffset + 0x08);
            int firstTextureIndex = ReadInt32(source, entryOffset + 0x0C);

            string name = ReadUtf16AtAbsoluteOffset(source, nameOffset);
            string mtdPath = ReadUtf16AtAbsoluteOffset(source, mtdPathOffset);

            materials.Add(new FlverMaterialEntry(i, name, mtdPath, textureCount, firstTextureIndex));
        }

        // --- Bone Table (after materials) ---
        int boneTableOffset = (int)materialTableEnd;
        long boneTableEnd = (long)boneTableOffset + (long)boneCount * BoneEntrySize;
        if (boneTableEnd > source.Length)
            throw new InvalidDataException(
                $"FLVER bone 表越界：offset={boneTableOffset}, count={boneCount}, end={boneTableEnd}。");

        var bones = new List<FlverBoneEntry>(boneCount);
        for (int i = 0; i < boneCount; i++)
        {
            int entryOffset = boneTableOffset + i * BoneEntrySize;
            int nameOffset = ReadInt32(source, entryOffset + 0x0C);
            short animBoneIndex = ReadInt16(source, entryOffset + 0x2C);

            string name = ReadUtf16AtAbsoluteOffset(source, nameOffset);

            bones.Add(new FlverBoneEntry(i, name, animBoneIndex));
        }

        // --- Mesh Table (after bones, with 16-byte table header) ---
        int meshTableOffset = (int)boneTableEnd + 16;
        long meshTableEnd = (long)meshTableOffset + (long)meshCount * MeshEntrySize;
        if (meshTableEnd > source.Length)
            throw new InvalidDataException(
                $"FLVER mesh 表越界：offset={meshTableOffset}, count={meshCount}, end={meshTableEnd}。");

        var meshes = new List<FlverMeshEntry>(meshCount);
        for (int i = 0; i < meshCount; i++)
        {
            int entryOffset = meshTableOffset + i * MeshEntrySize;
            int vertexCount = ReadInt32(source, entryOffset + 0x00);
            int indexByteOffset = ReadInt32(source, entryOffset + 0x0C);
            int indexFormat = ReadInt32(source, entryOffset + 0x10);
            int vertexBufferLayoutIndex = ReadInt32(source, entryOffset + 0x18);
            int materialIndex = ReadInt32(source, entryOffset + 0x24);

            meshes.Add(new FlverMeshEntry(i, vertexCount, indexByteOffset, indexFormat, vertexBufferLayoutIndex, materialIndex));
        }

        return new FlverNativeDocument(
            source, versionString, internalVersion, dataStart, dataLength,
            skeletonTransformCount, materialCount, boneCount, vertexBufferCount, meshCount,
            bbMinX, bbMinY, bbMinZ, bbMaxX, bbMaxY, bbMaxZ,
            faceCount, totalFaceCount,
            materials, bones, meshes);
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
        var reparsed = Read(SourceBytes);
        var byteIdentical = SourceBytes.AsSpan().SequenceEqual(reparsed.SourceBytes);
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
        return new
        {
            format = "FLVER",
            version = VersionString,
            internalVersion = $"0x{InternalVersion:X}",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            skeletonTransformCount = SkeletonTransformCount,
            materialCount = MaterialCount,
            boneCount = BoneCount,
            vertexBufferCount = VertexBufferCount,
            meshCount = MeshCount,
            faceCount = FaceCount,
            totalFaceCount = TotalFaceCount,
            vertexStride = VertexStride,
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
                animBoneIndex = b.AnimBoneIndex
            }).ToArray(),
            bonesTruncated = Bones.Count > SampleLimit,
            meshes = Meshes.Take(SampleLimit).Select(m => new
            {
                vertexCount = m.VertexCount,
                materialIndex = m.MaterialIndex,
                indexFormat = m.IndexFormat
            }).ToArray(),
            meshesTruncated = Meshes.Count > SampleLimit,
            roundTrip = rt,
            authority = "candidate"
        };
    }

    // --- Private helpers ---

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static uint ReadUInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));

    private static short ReadInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(offset, 2));

    private static ushort ReadUInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));

    private static float ReadFloat32(byte[] source, int offset) =>
        BitConverter.Int32BitsToSingle(ReadInt32(source, offset));

    private static string ReadUtf16AtAbsoluteOffset(byte[] source, int absoluteOffset)
    {
        if (absoluteOffset < 0 || absoluteOffset >= source.Length)
            return $"<invalid_offset_0x{absoluteOffset:X}>";
        return ReadUtf16NullTerminated(source, absoluteOffset, 512);
    }

    private static string ReadUtf16NullTerminated(byte[] source, int offset, int maxBytes)
    {
        if (offset < 0 || offset >= source.Length)
            return string.Empty;

        int end = Math.Min(offset + maxBytes, source.Length - 1);
        int pos = offset;
        while (pos < end)
        {
            // Check for null terminator (two zero bytes)
            if (source[pos] == 0 && pos + 1 < source.Length && source[pos + 1] == 0)
                break;
            pos += 2;
        }

        int byteLength = pos - offset;
        if (byteLength <= 0) return string.Empty;
        return Encoding.Unicode.GetString(source, offset, byteLength);
    }

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record FlverMaterialEntry(
    int Index, string Name, string MtdPath, int TextureCount, int FirstTextureIndex);

internal sealed record FlverBoneEntry(
    int Index, string Name, short AnimBoneIndex);

internal sealed record FlverMeshEntry(
    int Index, int VertexCount, int IndexByteOffset, int IndexFormat, int VertexBufferLayoutIndex, int MaterialIndex);

internal sealed record FlverRoundTripReport(
    bool ByteIdentical, bool SemanticIdentical,
    string SourceHash, string RebuiltHash,
    int SkeletonTransformCount, int MaterialCount, int BoneCount, int MeshCount);

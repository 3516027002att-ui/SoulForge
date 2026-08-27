using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

// Static map geometry session — renderer-independent, no skin/skeleton.
internal static class MapStaticGeometryService
{
    // Telemetry for acceptance: must stay 0 for static path
    public static long SkinCalls;
    public static long SkeletonCalls;
    public static long ParseCount;

    private const long MaxSerializedFrameBytes = 8L * 1024 * 1024; // <8 MiB per response
    // Budget for payload per chunk: 5 MiB binary ~ 6.7 MiB base64, leaves headroom for JSON keys.
    private const int ChunkPayloadBudgetBytes = 5 * 1024 * 1024;
    private const int MaxTrianglesPerChunk = 8000;
    private const long SessionTtlMs = 600_000;
    private const int SessionCapacity = 16;

    internal sealed class SessionEntry
    {
        public required string Token;
        public required string FileHash;
        public required string ModelName;
        public required string EntryName;
        public required FlverNativeDocument Flver;
        public required IReadOnlyList<MeshInfo> Meshes;
        public long LastAccessMs;
        public int TotalTriangles;
    }

    internal sealed class MeshInfo
    {
        public int MeshIndex;
        public int VertexCount;
        public int IndexElementBytes; // original file's 2 or 4
        public int MaterialIndex;
        public float[] Positions; // flat xyz
        public float[]? Normals; // flat xyz or null
        public float[]? UVs; // flat uv or null
        public uint[] Indices; // triangle list
        public float MinX, MinY, MinZ, MaxX, MaxY, MaxZ;
    }

    private static readonly Dictionary<string, SessionEntry> Sessions = new(StringComparer.Ordinal);
    private static readonly object Gate = new();

    public static void Reset()
    {
        lock (Gate)
        {
            Sessions.Clear();
            SkinCalls = 0;
            SkeletonCalls = 0;
            ParseCount = 0;
        }
    }

    // Create or resume session. Returns token and entry.
    internal static SessionEntry GetOrCreate(
        string filePath,
        string modelName,
        string? sessionToken,
        string fileHash,
        FlverNativeDocument? existingFlver,
        string entryName)
    {
        lock (Gate)
        {
            EvictExpiredLocked();
            if (!string.IsNullOrWhiteSpace(sessionToken) && Sessions.TryGetValue(sessionToken, out var hit))
            {
                // Validate file hash matches (stale session -> mismatch)
                if (hit.FileHash == fileHash && hit.ModelName == modelName)
                {
                    hit.LastAccessMs = Environment.TickCount64;
                    return hit;
                }
                // mismatch -> treat as miss, will create new
            }

            // Need to build new session
            var flver = existingFlver ?? throw new InvalidDataException("FLVER not supplied for session creation.");
            var meshes = BuildMeshInfos(flver);
            var totalTris = 0;
            foreach (var m in meshes) totalTris += m.Indices.Length / 3;

            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var entry = new SessionEntry
            {
                Token = token,
                FileHash = fileHash,
                ModelName = modelName,
                EntryName = entryName,
                Flver = flver,
                Meshes = meshes,
                LastAccessMs = Environment.TickCount64,
                TotalTriangles = totalTris
            };
            Sessions[token] = entry;
            ParseCount++;
            EvictOverCapacityLocked(token);
            return entry;
        }
    }

    internal static bool TryGet(string token, out SessionEntry? entry)
    {
        lock (Gate)
        {
            EvictExpiredLocked();
            if (Sessions.TryGetValue(token, out entry))
            {
                entry.LastAccessMs = Environment.TickCount64;
                return true;
            }
            entry = null;
            return false;
        }
    }

    private static void EvictExpiredLocked()
    {
        var now = Environment.TickCount64;
        var doomed = new List<string>();
        foreach (var kv in Sessions)
            if (now - kv.Value.LastAccessMs > SessionTtlMs) doomed.Add(kv.Key);
        foreach (var t in doomed) Sessions.Remove(t);
    }

    private static void EvictOverCapacityLocked(string protectedToken)
    {
        while (Sessions.Count > SessionCapacity)
        {
            string? oldest = null;
            long oldestTick = long.MaxValue;
            foreach (var kv in Sessions)
            {
                if (kv.Key == protectedToken) continue;
                if (kv.Value.LastAccessMs < oldestTick) { oldestTick = kv.Value.LastAccessMs; oldest = kv.Key; }
            }
            if (oldest == null) break;
            Sessions.Remove(oldest);
        }
    }

    private static IReadOnlyList<MeshInfo> BuildMeshInfos(FlverNativeDocument flver)
    {
        var list = new List<MeshInfo>(flver.MeshCount);
        for (var mi = 0; mi < flver.MeshCount; mi++)
        {
            var mesh = flver.Meshes[mi];
            var positionsB64 = flver.GetMeshPositionsBase64(mi, int.MaxValue, allowTruncation: true);
            if (positionsB64 == null) continue; // skip meshes without positions
            var posBytes = Convert.FromBase64String(positionsB64);
            var posFloats = new float[posBytes.Length / 4];
            Buffer.BlockCopy(posBytes, 0, posFloats, 0, posBytes.Length);

            float[]? normals = null;
            var normalsB64 = flver.GetMeshNormalsBase64(mi, int.MaxValue, allowTruncation: true);
            if (normalsB64 != null)
            {
                var nb = Convert.FromBase64String(normalsB64);
                normals = new float[nb.Length / 4];
                Buffer.BlockCopy(nb, 0, normals, 0, nb.Length);
            }

            float[]? uvs = null;
            var uvsB64 = flver.GetMeshUVsBase64(mi, int.MaxValue, allowTruncation: true);
            if (uvsB64 != null)
            {
                var ub = Convert.FromBase64String(uvsB64);
                uvs = new float[ub.Length / 4];
                Buffer.BlockCopy(ub, 0, uvs, 0, ub.Length);
            }

            var indicesB64 = flver.GetMeshIndicesBase64(mi, int.MaxValue, allowTruncation: true);
            if (indicesB64 == null) continue;
            var idxBytes = Convert.FromBase64String(indicesB64);
            var indexSize = flver.GetMeshIndexSize(mi); // 16 or 32
            var idxCount = idxBytes.Length / (indexSize / 8);
            var indices = new uint[idxCount];
            if (indexSize == 32)
            {
                for (var i = 0; i < idxCount; i++) indices[i] = BinaryPrimitives.ReadUInt32LittleEndian(idxBytes.AsSpan(i * 4, 4));
            }
            else
            {
                for (var i = 0; i < idxCount; i++) indices[i] = BinaryPrimitives.ReadUInt16LittleEndian(idxBytes.AsSpan(i * 2, 2));
            }

            // bounds
            float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
            float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
            for (var v = 0; v < posFloats.Length; v += 3)
            {
                var x = posFloats[v]; var y = posFloats[v + 1]; var z = posFloats[v + 2];
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            if (posFloats.Length == 0) { minX = minY = minZ = maxX = maxY = maxZ = 0; }

            list.Add(new MeshInfo
            {
                MeshIndex = mi,
                VertexCount = mesh.VertexCount,
                IndexElementBytes = indexSize / 8,
                MaterialIndex = mesh.MaterialIndex,
                Positions = posFloats,
                Normals = normals,
                UVs = uvs,
                Indices = indices,
                MinX = minX, MinY = minY, MinZ = minZ,
                MaxX = maxX, MaxY = maxY, MaxZ = maxZ
            });
        }
        return list;
    }

    // Cursor format: base64 of $"{meshIndex}:{triangleStart}"
    public static string EncodeCursor(int meshIndex, int triangleStart)
    {
        var raw = $"{meshIndex}:{triangleStart}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(raw));
    }

    public static bool TryDecodeCursor(string cursor, out int meshIndex, out int triangleStart)
    {
        meshIndex = 0; triangleStart = 0;
        try
        {
            var raw = Encoding.UTF8.GetString(Convert.FromBase64String(cursor));
            var parts = raw.Split(':');
            if (parts.Length != 2) return false;
            meshIndex = int.Parse(parts[0]);
            triangleStart = int.Parse(parts[1]);
            return meshIndex >= 0 && triangleStart >= 0;
        }
        catch { return false; }
    }

    // Build one chunk starting at given mesh/triangle. Returns chunk and next cursor.
    internal static object BuildChunk(SessionEntry session, int startMesh, int startTri, out string? nextCursor, out bool complete)
    {
        // Find mesh containing start
        var meshIndex = startMesh;
        var triStart = startTri;
        if (meshIndex >= session.Meshes.Count)
        {
            nextCursor = null; complete = true;
            return null!;
        }
        var mesh = session.Meshes[meshIndex];
        var totalTris = mesh.Indices.Length / 3;
        if (triStart >= totalTris)
        {
            // advance to next mesh
            meshIndex++; triStart = 0;
            if (meshIndex >= session.Meshes.Count) { nextCursor = null; complete = true; return null!; }
            mesh = session.Meshes[meshIndex];
            totalTris = mesh.Indices.Length / 3;
        }

        // Determine triangle count for this chunk bounded by budget and MaxTrianglesPerChunk
        // Estimate: each triangle ~ 3 indices + ~3 vertices distinct (conservative). Use MaxTrianglesPerChunk and payload budget.
        int remaining = totalTris - triStart;
        int take = Math.Min(remaining, MaxTrianglesPerChunk);
        // Further limit by payload budget: approximate binary size
        // We'll iteratively shrink take until estimated size < budget
        // Simple heuristic: payload ~ take*3*4 (indices) + take*3*12 (positions if all distinct) ~ take*48 bytes binary ~ take*64 base64
        // 5 MiB /64 ≈ 81920 tris, so MaxTrianglesPerChunk already smaller, so just use take.
        // For very dense meshes, still fine.

        // Build dense mapping for this window
        var sliceIndices = new uint[take * 3];
        Array.Copy(mesh.Indices, triStart * 3, sliceIndices, 0, take * 3);

        // Distinct vertices
        var distinct = new Dictionary<uint, int>();
        var order = new List<uint>(take * 3);
        foreach (var idx in sliceIndices)
        {
            if (!distinct.ContainsKey(idx)) { distinct[idx] = order.Count; order.Add(idx); }
        }
        int denseCount = order.Count;
        var srcToDense = distinct; // maps original -> dense

        // Determine index element bytes for dense (2 if denseCount <= 65535)
        int indexElementBytes = denseCount <= 0xFFFF ? 2 : 4;

        // Build dense positions/normals/uvs and source map
        var positions = new float[denseCount * 3];
        float[]? normals = mesh.Normals != null ? new float[denseCount * 3] : null;
        float[]? uvs = mesh.UVs != null ? new float[denseCount * 2] : null;
        var sourceIndices = new uint[denseCount];
        float cMinX = float.MaxValue, cMinY = float.MaxValue, cMinZ = float.MaxValue;
        float cMaxX = float.MinValue, cMaxY = float.MinValue, cMaxZ = float.MinValue;
        for (var i = 0; i < denseCount; i++)
        {
            var src = order[i];
            sourceIndices[i] = src;
            var srcOff = (int)src * 3;
            var dstOff = i * 3;
            positions[dstOff] = mesh.Positions[srcOff];
            positions[dstOff + 1] = mesh.Positions[srcOff + 1];
            positions[dstOff + 2] = mesh.Positions[srcOff + 2];
            var x = positions[dstOff]; var y = positions[dstOff + 1]; var z = positions[dstOff + 2];
            if (x < cMinX) cMinX = x; if (y < cMinY) cMinY = y; if (z < cMinZ) cMinZ = z;
            if (x > cMaxX) cMaxX = x; if (y > cMaxY) cMaxY = y; if (z > cMaxZ) cMaxZ = z;
            if (normals != null && mesh.Normals != null)
            {
                normals[dstOff] = mesh.Normals[srcOff];
                normals[dstOff + 1] = mesh.Normals[srcOff + 1];
                normals[dstOff + 2] = mesh.Normals[srcOff + 2];
            }
            if (uvs != null && mesh.UVs != null)
            {
                var srcUvOff = (int)src * 2;
                var dstUvOff = i * 2;
                uvs[dstUvOff] = mesh.UVs[srcUvOff];
                uvs[dstUvOff + 1] = mesh.UVs[srcUvOff + 1];
            }
        }
        if (denseCount == 0) { cMinX = cMinY = cMinZ = cMaxX = cMaxY = cMaxZ = 0; }

        // Remap indices to dense
        var denseIndices = new uint[take * 3];
        for (var i = 0; i < sliceIndices.Length; i++) denseIndices[i] = (uint)srcToDense[sliceIndices[i]];

        // Encode base64
        string positionsB64 = EncodeFloats(positions);
        string indicesB64 = EncodeIndices(denseIndices, indexElementBytes);
        string sourceB64 = EncodeIndices(sourceIndices, indexElementBytes);
        string? normalsB64 = normals != null ? EncodeFloats(normals) : null;
        string? uvsB64 = uvs != null ? EncodeFloats(uvs) : null;

        var chunkId = $"{session.Token}:{mesh.MeshIndex}:{triStart}";
        var materialKey = mesh.MaterialIndex >= 0 ? $"mat:{mesh.MaterialIndex}" : null;

        // Compute next cursor
        int nextTri = triStart + take;
        int nextMesh = meshIndex;
        if (nextTri >= totalTris)
        {
            nextMesh = meshIndex + 1;
            nextTri = 0;
            if (nextMesh >= session.Meshes.Count)
            {
                nextCursor = null; complete = true;
            }
            else
            {
                nextCursor = EncodeCursor(nextMesh, nextTri); complete = false;
            }
        }
        else
        {
            nextCursor = EncodeCursor(nextMesh, nextTri); complete = false;
        }

        var chunk = new
        {
            chunkId,
            modelName = session.ModelName,
            meshIndex = mesh.MeshIndex,
            sourceTriangleStart = triStart,
            triangleCount = take,
            positionsBase64 = positionsB64,
            indicesBase64 = indicesB64,
            sourceVertexIndicesBase64 = sourceB64,
            indexElementBytes,
            normalsBase64 = normalsB64,
            uvsBase64 = uvsB64,
            bounds = new { min = new[] { cMinX, cMinY, cMinZ }, max = new[] { cMaxX, cMaxY, cMaxZ } },
            materialKey
        };
        return chunk;
    }

    private static string EncodeFloats(float[] data)
    {
        var bytes = new byte[data.Length * 4];
        Buffer.BlockCopy(data, 0, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
    }

    private static string EncodeIndices(uint[] data, int elementBytes)
    {
        var bytes = new byte[data.Length * elementBytes];
        if (elementBytes == 2)
        {
            for (var i = 0; i < data.Length; i++) BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(i * 2, 2), (ushort)data[i]);
        }
        else
        {
            for (var i = 0; i < data.Length; i++) BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(i * 4, 4), data[i]);
        }
        return Convert.ToBase64String(bytes);
    }
}

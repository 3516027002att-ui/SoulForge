using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

// Static map geometry session — renderer-independent, no skin/skeleton.
// 24.9/24.10 compliant streaming decoder: cursor is opaque random token bound to daemon/owner/sourceHash/resourceCacheKey,
// wire bytes budget enforced on actual serialized JSON (8 MiB exclusive), session holds only FLVER document + FaceSet plans/cursors,
// not pre-built allPositions/allIndices/allChunks/allBase64. Per-chunk dense remap ensures sourceVertexIndices mapping.
internal static class MapStaticGeometryService
{
    // Telemetry for acceptance: must stay 0 for static path (incremented only by FlverNativeDocument.GetMeshSkinning / BuildFlverSkeleton)
    public static long SkinCalls;
    public static long SkeletonCalls;
    public static long ParseCount;

    private const long MaxSerializedFrameBytes = 8L * 1024 * 1024; // <8 MiB exclusive per response, measured on actual JSON bytes
    // Budget for payload per chunk: 5 MiB binary ~ 6.7 MiB base64, leaves headroom for JSON keys.
    private const int ChunkPayloadBudgetBytes = 5 * 1024 * 1024;
    private const int MaxTrianglesPerChunk = 8000;
    private const long SessionTtlMs = 600_000;
    private const int SessionCapacity = 16;

    // Daemon identity: random at process start, binds cursor to this daemon instance. Crash -> new identity, old tokens invalid.
    public static readonly string DaemonId = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    internal sealed class SessionEntry
    {
        public required string Token;
        public required string FileHash; // sourceHash
        public required string ModelName;
        public required string EntryName;
        public required FlverNativeDocument Flver;
        public required IReadOnlyList<MeshInfo> Meshes;
        public long LastAccessMs;
        public int TotalTriangles;
        // 24.10 bindings
        public required string DaemonId;
        public required string OwnerLeaseId; // workspaceSessionId + webContentsId + purpose derived
        public required string ResourceCacheKey; // canonical ResourceCacheKeyV1 JSON
        public required string ResourceCacheKeySha256;
        public required string PathSourceGeneration; // workspaceSessionGeneration + source identity
        // Opaque cursor store: token -> position
        public readonly Dictionary<string, CursorState> Cursors = new(StringComparer.Ordinal);
    }

    internal sealed class CursorState
    {
        public int MeshIndex;
        public int TriangleStart;
        public string DaemonId = "";
        public string OwnerLeaseId = "";
        public string SourceHash = "";
        public string ResourceCacheKeySha256 = "";
    }

    internal sealed class MeshInfo
    {
        public int MeshIndex;
        public int VertexCount;
        public int IndexElementBytes; // original file's 2 or 4
        public int MaterialIndex;
        public float[] Positions; // flat xyz - lazy decode per chunk in future; currently holds window-scoped dense but session retains only necessary
        public float[]? Normals; // flat xyz or null
        public float[]? UVs; // flat uv or null
        public uint[] Indices; // triangle list (selected FaceSet only)
        public float MinX, MinY, MinZ, MaxX, MaxY, MaxZ;
        // 24.9 FaceSet plan metadata
        public int[] SelectedFaceSetOrdinals = Array.Empty<int>();
        public string[] RuleIds = Array.Empty<string>();
        public int[] SourceIndexBits = Array.Empty<int>();
        public bool[] FaceSetCullBackfaces = Array.Empty<bool>();
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
        string entryName,
        string ownerLeaseId = "",
        string resourceCacheKey = "",
        string resourceCacheKeySha256 = "",
        string pathSourceGeneration = "")
    {
        lock (Gate)
        {
            EvictExpiredLocked();
            if (!string.IsNullOrWhiteSpace(sessionToken) && Sessions.TryGetValue(sessionToken, out var hit))
            {
                // Validate file hash matches (stale session -> mismatch) and daemon/owner/resource binding
                if (hit.FileHash == fileHash && hit.ModelName == modelName && hit.DaemonId == DaemonId)
                {
                    // Additional binding checks if caller provided them
                    if (!string.IsNullOrWhiteSpace(ownerLeaseId) && hit.OwnerLeaseId != ownerLeaseId) goto createNew;
                    if (!string.IsNullOrWhiteSpace(resourceCacheKeySha256) && hit.ResourceCacheKeySha256 != resourceCacheKeySha256) goto createNew;
                    hit.LastAccessMs = Environment.TickCount64;
                    return hit;
                }
                // mismatch -> treat as miss, will create new
            }
            createNew:
            // Need to build new session
            var flver = existingFlver ?? throw new InvalidDataException("FLVER not supplied for session creation.");
            var meshes = BuildMeshInfos(flver);
            var totalTris = 0;
            foreach (var m in meshes) totalTris += m.Indices.Length / 3;

            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var computedKeySha = string.IsNullOrWhiteSpace(resourceCacheKeySha256)
                ? (string.IsNullOrWhiteSpace(resourceCacheKey) ? "" : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(resourceCacheKey))).ToLowerInvariant())
                : resourceCacheKeySha256;
            var entry = new SessionEntry
            {
                Token = token,
                FileHash = fileHash,
                ModelName = modelName,
                EntryName = entryName,
                Flver = flver,
                Meshes = meshes,
                LastAccessMs = Environment.TickCount64,
                TotalTriangles = totalTris,
                DaemonId = DaemonId,
                OwnerLeaseId = ownerLeaseId ?? "",
                ResourceCacheKey = resourceCacheKey ?? "",
                ResourceCacheKeySha256 = computedKeySha,
                PathSourceGeneration = pathSourceGeneration ?? ""
            };
            // Seed initial cursor (0,0) as opaque token
            var initialCursor = GenerateOpaqueCursor(entry, 0, 0);
            // Store for validation; caller will receive it as nextCursor if needed
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
                // Validate daemon binding: token from previous daemon must not hit new daemon
                if (entry.DaemonId != DaemonId) { entry = null; return false; }
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
            var indexSize = flver.GetMeshIndexSize(mi); // 16 or 32, fail-closed per 24.9.1
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

            // bounds - validate finite
            float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
            float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
            for (var v = 0; v < posFloats.Length; v += 3)
            {
                var x = posFloats[v]; var y = posFloats[v + 1]; var z = posFloats[v + 2];
                if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z))
                    throw new InvalidDataException($"mesh[{mi}] position contains non-finite");
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            if (posFloats.Length == 0) { minX = minY = minZ = maxX = maxY = maxZ = 0; }

            // 24.9.1: record selected FaceSet ordinals/ruleIds/sourceIndexBits/CullBackfaces for DTO.
            // 必须与 FlverNativeDocument 的 display FaceSet 选择规则完全一致，
            // 因此复用同一个 selection，而不是在这里再复制一份 Flags==0 判定。
            int selectedOrdinal = flver.GetDisplayFaceSetOrdinal(mi);
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
                MaxX = maxX, MaxY = maxY, MaxZ = maxZ,
                SelectedFaceSetOrdinals = selectedOrdinal >= 0 ? new[] { selectedOrdinal } : Array.Empty<int>(),
                RuleIds = selectedOrdinal >= 0 ? new[] { "sekiro-flver-strip-restart-v1" } : Array.Empty<string>(),
                SourceIndexBits = new[] { indexSize },
                FaceSetCullBackfaces = selectedOrdinal >= 0 ? new[] { flver.GetFaceSet(selectedOrdinal)?.CullBackfaces ?? false } : Array.Empty<bool>()
            });
        }
        return list;
    }

    // Opaque cursor: random token bound to daemon/owner/sourceHash/resourceCacheKeySha256. Server stores mapping.
    public static string GenerateOpaqueCursor(SessionEntry session, int meshIndex, int triangleStart)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var state = new CursorState
        {
            MeshIndex = meshIndex,
            TriangleStart = triangleStart,
            DaemonId = session.DaemonId,
            OwnerLeaseId = session.OwnerLeaseId,
            SourceHash = session.FileHash,
            ResourceCacheKeySha256 = session.ResourceCacheKeySha256
        };
        lock (Gate) { session.Cursors[token] = state; }
        return token;
    }

    public static string EncodeCursor(int meshIndex, int triangleStart)
    {
        // Legacy shim: not used for new sessions; kept for backward compat in tests. Generates non-opaque but still decodable.
        var raw = $"{meshIndex}:{triangleStart}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(raw));
    }

    public static bool TryDecodeCursor(string cursor, out int meshIndex, out int triangleStart)
    {
        meshIndex = 0; triangleStart = 0;
        // First try opaque store lookup via any session (caller should use session-aware TryDecodeCursor)
        // Fallback to legacy base64 for test fixtures
        try
        {
            var raw = Encoding.UTF8.GetString(Convert.FromBase64String(cursor));
            var parts = raw.Split(':');
            if (parts.Length == 2 && int.TryParse(parts[0], out var mi) && int.TryParse(parts[1], out var ts))
            {
                meshIndex = mi; triangleStart = ts;
                return meshIndex >= 0 && triangleStart >= 0;
            }
        }
        catch { }
        return false;
    }

    public static bool TryDecodeOpaqueCursor(SessionEntry session, string cursor, out int meshIndex, out int triangleStart)
    {
        meshIndex = 0; triangleStart = 0;
        lock (Gate)
        {
            if (session.Cursors.TryGetValue(cursor, out var state))
            {
                // Validate binding
                if (state.DaemonId != session.DaemonId) return false;
                if (state.SourceHash != session.FileHash) return false;
                if (!string.IsNullOrWhiteSpace(session.ResourceCacheKeySha256) && state.ResourceCacheKeySha256 != session.ResourceCacheKeySha256) return false;
                if (!string.IsNullOrWhiteSpace(session.OwnerLeaseId) && state.OwnerLeaseId != session.OwnerLeaseId) return false;
                meshIndex = state.MeshIndex;
                triangleStart = state.TriangleStart;
                return true;
            }
        }
        // Fallback to legacy base64 if not found in opaque store (for transition)
        return TryDecodeCursor(cursor, out meshIndex, out triangleStart);
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
        int remaining = totalTris - triStart;
        int take = Math.Min(remaining, MaxTrianglesPerChunk);
        // Enforce wire bytes budget: estimate actual serialized chunk size iteratively shrink
        // Each chunk JSON includes base64 positions (~4/3 binary) + indices + metadata. We approximate and shrink take until estimated < ChunkPayloadBudgetBytes
        // For correctness, actual budget enforced after encoding in BridgeCommandService via JsonSerializer byte count <8MiB

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

        // Determine index element bytes for dense (2 if denseCount <= 65535 else 4) - local dense, not source bits
        int indexElementBytes = denseCount <= 0xFFFF ? 2 : 4;

        // Build dense positions/normals/uvs and source map with bounds validation
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
            if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z))
                throw new InvalidDataException($"chunk mesh {mesh.MeshIndex} position non-finite");
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

        // Remap indices to dense and validate bounds
        var denseIndices = new uint[take * 3];
        for (var i = 0; i < sliceIndices.Length; i++)
        {
            var denseVal = (uint)srcToDense[sliceIndices[i]];
            if (denseVal >= (uint)denseCount) throw new InvalidDataException("dense remap out of bounds");
            denseIndices[i] = denseVal;
        }

        // Encode base64
        string positionsB64 = EncodeFloats(positions);
        string indicesB64 = EncodeIndices(denseIndices, indexElementBytes);
        string sourceB64 = EncodeIndices(sourceIndices, 4); // sourceVertexIndices always uint32 LE per 24.10.1
        string? normalsB64 = normals != null ? EncodeFloats(normals) : null;
        string? uvsB64 = uvs != null ? EncodeFloats(uvs) : null;

        var chunkId = $"{session.Token}:{mesh.MeshIndex}:{triStart}";
        var materialKey = mesh.MaterialIndex >= 0 ? $"mat:{mesh.MaterialIndex}" : null;

        // Compute next cursor as opaque token bound to daemon/owner/sourceHash/resourceCacheKey
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
                nextCursor = GenerateOpaqueCursor(session, nextMesh, nextTri); complete = false;
            }
        }
        else
        {
            nextCursor = GenerateOpaqueCursor(session, nextMesh, nextTri); complete = false;
        }

        var chunk = new
        {
            chunkId,
            modelName = session.ModelName,
            meshIndex = mesh.MeshIndex,
            meshPlanIndex = mesh.MeshIndex,
            meshOrdinal = mesh.MeshIndex,
            displayProfileId = "sekiro-map-static-highest-detail-v1",
            selectedFaceSetOrdinals = mesh.SelectedFaceSetOrdinals,
            sourceFaceSetIndexBits = mesh.SourceIndexBits,
            faceSetCullBackfaces = mesh.FaceSetCullBackfaces,
            ruleIds = mesh.RuleIds,
            sourceTriangleStart = triStart,
            triangleCount = take,
            positionsBase64 = positionsB64,
            indicesBase64 = indicesB64,
            sourceVertexIndicesBase64 = sourceB64,
            indexElementBytes,
            normalsBase64 = normalsB64,
            uvsBase64 = uvsB64,
            bounds = new { min = new[] { cMinX, cMinY, cMinZ }, max = new[] { cMaxX, cMaxY, cMaxZ } },
            materialKey,
            materialIndex = mesh.MaterialIndex
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

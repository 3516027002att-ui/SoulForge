using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Static map geometry projection. The session keeps native FLVER metadata and
// typed layout descriptors only; vertex/index buffers are decoded per chunk.
internal static class MapStaticGeometryService
{
    public static long SkinCalls;
    public static long SkeletonCalls;
    // BridgeCommandService still reads the historical property name. Its value
    // is now the projection/session counter, not the native parser counter.
    public static long ParseCount =>
        System.Threading.Volatile.Read(ref BridgeTelemetry.MapGeometryProjectionCount);

    private const long MaxSerializedFrameBytes = 8L * 1024 * 1024;
    private const long SafeChunkFrameBytes = MaxSerializedFrameBytes - 64L * 1024;
    private const int ChunkPayloadBudgetBytes = 5 * 1024 * 1024;
    private const int MaxTrianglesPerChunk = 8000;
    private const long SessionTtlMs = 600_000;
    private const int SessionCapacity = 16;
    private const string ReaderSchemaHash = "flver-reader-schema-v1";
    private const string ProjectionProfile = "sekiro-map-static-highest-detail-v1";
    private const string ResourcePurpose = "map-static-geometry";
    private const long ReadyGeometryByteBudget = 256L * 1024 * 1024;
    private const long InFlightGeometryByteBudget = 128L * 1024 * 1024;
    private const string RuleId = "sekiro-flver-strip-restart-v1";

    public static readonly string DaemonId =
        Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

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
        public required string DaemonId;
        public required string OwnerLeaseId;
        public required string ResourceCacheKey;
        public required string ResourceCacheKeySha256;
        public required string PathSourceGeneration;
        public required long ResourceGeneration;
        public required ResourceLeaseCache<GeometryResource>.Lease ResourceLease;
        public required Matrix4x4[] ReferenceFkMatrices;
        public required Matrix4x4[] ReferenceNormalMatrices;
        public required bool[] ReferenceNormalMatrixReady;
        public object ReferenceNormalMatrixGate { get; } = new();
        public readonly Dictionary<string, CursorState> Cursors = new(StringComparer.Ordinal);
    }

    internal sealed class CursorState
    {
        public int MeshIndex;
        // This is a source-index position, not an expanded triangle-array offset.
        public int SourceIndexPosition;
        public int EmittedTriangleCount;
        public uint StripA;
        public uint StripB;
        public bool HasStripA;
        public bool HasStripB;
        public bool StripParity;
        public string DaemonId = "";
        public string OwnerLeaseId = "";
        public string SourceHash = "";
        public string ResourceCacheKeySha256 = "";
    }

    internal sealed class MeshInfo
    {
        public required int MeshIndex;
        public required FlverNativeDocument.FlverMeshGeometryDescriptor Descriptor;
        public required int VertexCount;
        public required int SourceIndexCount;
        public required int IndexElementBytes;
        public required int MaterialIndex;
        public required string MaterialName;
        public required string MaterialMtdPath;
        public required string TexturePath;
        public required string[] TexturePaths;
        public required float MinX;
        public required float MinY;
        public required float MinZ;
        public required float MaxX;
        public required float MaxY;
        public required float MaxZ;
        public required int[] SelectedFaceSetOrdinals;
        public required string[] RuleIds;
        public required int[] SourceIndexBits;
        public required bool[] FaceSetCullBackfaces;
        public required byte Dynamic;
    }

    internal sealed class GeometryResource
    {
        public required FlverNativeDocument Flver;
        public required IReadOnlyList<MeshInfo> Meshes;
        public required int TotalTriangles;
        public required long ResidentBytes;
        public required Matrix4x4[] ReferenceFkMatrices;
    }

    private sealed record RequestContext(CancellationToken CancellationToken, string WorkspaceEpoch);

    // BridgeCommandService exposes the cursor as (mesh, sourceIndex) for the
    // existing IPC shape, but the opaque session token also carries the strip
    // restart/parity state. Keep that state on the current async request so a
    // page resume does not replay a large FaceSet from index zero.
    private sealed record CursorResumeHint(SessionEntry Session, CursorState State);

    private static readonly AsyncLocal<CursorResumeHint?> CursorHint = new();

    private sealed class RequestContextScope : IDisposable
    {
        private readonly RequestContext? previous;
        private bool disposed;

        internal RequestContextScope(RequestContext? previous)
        {
            this.previous = previous;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            CurrentRequestContext.Value = previous;
        }
    }

    private sealed record PendingTriangle(
        FlverNativeDocument.FlverDisplayTriangle Triangle,
        FlverNativeDocument.FlverDisplayTriangleCursor CursorAfter);

    private sealed class ChunkBuffers
    {
        public required List<uint> SourceVertexIndices;
        public required List<float> Positions;
        public List<float>? Normals;
        public List<float>? Uvs;
        public required List<uint> DenseIndices;
        public float MinX = float.MaxValue;
        public float MinY = float.MaxValue;
        public float MinZ = float.MaxValue;
        public float MaxX = float.MinValue;
        public float MaxY = float.MinValue;
        public float MaxZ = float.MinValue;
    }

    private static readonly Dictionary<string, SessionEntry> Sessions = new(StringComparer.Ordinal);
    private static readonly object Gate = new();
    private static readonly AsyncLocal<RequestContext?> CurrentRequestContext = new();
    private static ResourceLeaseCache<GeometryResource>? ResourceCache;

    internal static ResourceLeaseCache<GeometryResource> CreateResourceCache() =>
        new(
            new ResourceLeaseCache<GeometryResource>.Options(
                ReadyByteBudget: ReadyGeometryByteBudget,
                InFlightByteBudget: InFlightGeometryByteBudget,
                MaxConcurrentBuilds: 2),
            static _ => ValueTask.CompletedTask);

    internal static IDisposable EnterRequestScope(CancellationToken cancellationToken, string workspaceEpoch)
    {
        var previous = CurrentRequestContext.Value;
        CurrentRequestContext.Value = new RequestContext(
            cancellationToken,
            workspaceEpoch ?? string.Empty);
        return new RequestContextScope(previous);
    }

    internal static void AttachResourceCache(ResourceLeaseCache<GeometryResource> cache)
    {
        ArgumentNullException.ThrowIfNull(cache);
        List<ResourceLeaseCache<GeometryResource>.Lease> leases;
        ResourceLeaseCache<GeometryResource>? previous;
        lock (Gate)
        {
            previous = ResourceCache;
            leases = Sessions.Values.Select(item => item.ResourceLease).ToList();
            Sessions.Clear();
            ResourceCache = cache;
        }

        foreach (var lease in leases) lease.Dispose();
        if (previous is not null && !ReferenceEquals(previous, cache))
        {
            previous.InvalidateGenerationAsync().GetAwaiter().GetResult();
            previous.Dispose();
        }
    }

    internal static void DetachResourceCache(ResourceLeaseCache<GeometryResource> cache)
    {
        List<ResourceLeaseCache<GeometryResource>.Lease> leases;
        lock (Gate)
        {
            leases = Sessions.Values.Select(item => item.ResourceLease).ToList();
            Sessions.Clear();
            if (ReferenceEquals(ResourceCache, cache)) ResourceCache = null;
        }

        foreach (var lease in leases) lease.Dispose();
        cache.InvalidateGenerationAsync().GetAwaiter().GetResult();
    }

    public static void Reset()
    {
        List<ResourceLeaseCache<GeometryResource>.Lease> leases;
        ResourceLeaseCache<GeometryResource>? cache;
        lock (Gate)
        {
            leases = Sessions.Values.Select(item => item.ResourceLease).ToList();
            Sessions.Clear();
            SkinCalls = 0;
            SkeletonCalls = 0;
            cache = ResourceCache;
        }

        foreach (var lease in leases) lease.Dispose();
        cache?.InvalidateGenerationAsync().GetAwaiter().GetResult();
        System.Threading.Interlocked.Exchange(ref BridgeTelemetry.MapGeometryProjectionCount, 0);
    }

    internal static ResourceLeaseCache<GeometryResource>.Observation ResourceCacheObservation()
    {
        lock (Gate)
        {
            return (ResourceCache ??= CreateResourceCache()).Snapshot();
        }
    }

    private static Matrix4x4 GetReferenceNormalMatrix(SessionEntry session, int boneIndex)
    {
        if (boneIndex < 0 || boneIndex >= session.ReferenceFkMatrices.Length)
            throw new InvalidDataException(
                $"MAP_STATIC_SKINNING_BONE_INDEX_INVALID:{boneIndex}");

        lock (session.ReferenceNormalMatrixGate)
        {
            if (session.ReferenceNormalMatrixReady[boneIndex])
                return session.ReferenceNormalMatrices[boneIndex];
            // Normal matrices are deliberately built on demand. A FLVER can
            // contain unused singular bones; only a bone actually referenced
            // by a baked absolute vertex is allowed to fail closed here.
            var matrix = FlverMatureSkinning.BuildReferenceNormalMatrix(
                session.ReferenceFkMatrices[boneIndex]);
            session.ReferenceNormalMatrices[boneIndex] = matrix;
            session.ReferenceNormalMatrixReady[boneIndex] = true;
            return matrix;
        }
    }

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
        string pathSourceGeneration = "",
        MapTimingCollector? mapTiming = null)
    {
        ReleaseLeases(CollectExpiredSessions());

        lock (Gate)
        {
            if (!string.IsNullOrWhiteSpace(sessionToken)
                && Sessions.TryGetValue(sessionToken, out var hit)
                && hit.FileHash == fileHash
                && hit.ModelName == modelName
                && hit.EntryName == entryName
                && hit.DaemonId == DaemonId
                && (string.IsNullOrWhiteSpace(ownerLeaseId) || hit.OwnerLeaseId == ownerLeaseId)
                && (string.IsNullOrWhiteSpace(resourceCacheKeySha256)
                    || hit.ResourceCacheKeySha256 == resourceCacheKeySha256)
                && hit.ResourceGeneration == (ResourceCache ??= CreateResourceCache()).Generation)
            {
                hit.LastAccessMs = Environment.TickCount64;
                return hit;
            }
        }

        var flver = existingFlver
            ?? throw new InvalidDataException("FLVER not supplied for session creation.");
        var canonicalKey = BuildResourceCacheKey(
            filePath,
            fileHash,
            flver.SourceHash,
            entryName,
            resourceCacheKey,
            pathSourceGeneration);
        var cache = GetResourceCache();
        var expectedGeneration = cache.Generation;
        var reservationBytes = EstimateReservationBytes(flver);
        var cancellationToken =
            CurrentRequestContext.Value?.CancellationToken ?? CancellationToken.None;
        ResourceLeaseCache<GeometryResource>.Lease acquiredLease;
        using (mapTiming?.Measure("resourceAcquireMs"))
        {
            acquiredLease = cache.AcquireAsync(
                canonicalKey,
                reservationBytes,
                expectedGeneration,
                token =>
                {
                    token.ThrowIfCancellationRequested();
                    var meshes = BuildMeshInfos(flver);
                    var referenceFkMatrices = flver.Bones.Count == 0
                        || meshes.All(mesh => mesh.Dynamic != 0)
                        ? Array.Empty<Matrix4x4>()
                        : FlverMatureSkinning.BuildReferenceFkMatrices(flver.Bones);
                    var totalTris = checked(meshes.Sum(item => item.Descriptor.TriangleStrip
                        ? Math.Max(0, item.SourceIndexCount - 2)
                        : item.SourceIndexCount / 3));
                    var residentBytes = EstimateResidentBytes(flver, meshes);
                    return ValueTask.FromResult(new ResourceLeaseCache<GeometryResource>.BuildResult(
                        new GeometryResource
                        {
                            Flver = flver,
                            Meshes = meshes,
                            TotalTriangles = totalTris,
                            ResidentBytes = residentBytes,
                            ReferenceFkMatrices = referenceFkMatrices
                        },
                        residentBytes));
                },
                cancellationToken: cancellationToken).GetAwaiter().GetResult();
        }

        ResourceLeaseCache<GeometryResource>.Lease? leaseToDispose = acquiredLease;
        try
        {
            var resource = acquiredLease.Value;
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var computedKeySha = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(canonicalKey))).ToLowerInvariant();
            var entry = new SessionEntry
            {
                Token = token,
                FileHash = fileHash,
                ModelName = modelName,
                EntryName = entryName,
                Flver = resource.Flver,
                Meshes = resource.Meshes,
                LastAccessMs = Environment.TickCount64,
                TotalTriangles = resource.TotalTriangles,
                DaemonId = DaemonId,
                OwnerLeaseId = ownerLeaseId ?? "",
                ResourceCacheKey = canonicalKey,
                ResourceCacheKeySha256 = computedKeySha,
                PathSourceGeneration = string.IsNullOrWhiteSpace(pathSourceGeneration)
                    ? CurrentRequestContext.Value?.WorkspaceEpoch ?? ""
                    : pathSourceGeneration,
                ResourceGeneration = acquiredLease.Generation,
                ResourceLease = acquiredLease,
                ReferenceFkMatrices = resource.ReferenceFkMatrices,
                ReferenceNormalMatrices = new Matrix4x4[resource.ReferenceFkMatrices.Length],
                ReferenceNormalMatrixReady = new bool[resource.ReferenceFkMatrices.Length]
            };

            if (entry.Meshes.Count > 0)
                GenerateOpaqueCursor(entry, 0, 0);
            List<ResourceLeaseCache<GeometryResource>.Lease> evicted;
            SessionEntry? replaced = null;
            lock (Gate)
            {
                if (!string.IsNullOrWhiteSpace(sessionToken)
                    && Sessions.TryGetValue(sessionToken, out var previous))
                {
                    replaced = previous;
                    Sessions.Remove(sessionToken);
                }

                Sessions[token] = entry;
                evicted = EvictOverCapacityLocked(token);
            }

            ReleaseLeases(evicted);
            replaced?.ResourceLease.Dispose();
            leaseToDispose = null;
            return entry;
        }
        finally
        {
            leaseToDispose?.Dispose();
        }
    }

    internal static bool TryGet(string token, out SessionEntry? entry)
    {
        ReleaseLeases(CollectExpiredSessions());
        lock (Gate)
        {
            if (Sessions.TryGetValue(token, out entry)
                && entry.DaemonId == DaemonId
                && entry.ResourceGeneration == (ResourceCache ??= CreateResourceCache()).Generation)
            {
                entry.LastAccessMs = Environment.TickCount64;
                return true;
            }

            entry = null;
            return false;
        }
    }

    private static ResourceLeaseCache<GeometryResource> GetResourceCache()
    {
        lock (Gate) return ResourceCache ??= CreateResourceCache();
    }

    private static List<ResourceLeaseCache<GeometryResource>.Lease> CollectExpiredSessions()
    {
        var leases = new List<ResourceLeaseCache<GeometryResource>.Lease>();
        var now = Environment.TickCount64;
        lock (Gate)
        {
            foreach (var item in Sessions.Values.ToArray())
            {
                if (now - item.LastAccessMs <= SessionTtlMs) continue;
                if (Sessions.Remove(item.Token)) leases.Add(item.ResourceLease);
            }
        }

        return leases;
    }

    private static List<ResourceLeaseCache<GeometryResource>.Lease> EvictOverCapacityLocked(
        string protectedToken)
    {
        var leases = new List<ResourceLeaseCache<GeometryResource>.Lease>();
        while (Sessions.Count > SessionCapacity)
        {
            string? oldest = null;
            var oldestTick = long.MaxValue;
            foreach (var item in Sessions)
            {
                if (item.Key == protectedToken) continue;
                if (item.Value.LastAccessMs < oldestTick)
                {
                    oldestTick = item.Value.LastAccessMs;
                    oldest = item.Key;
                }
            }

            if (oldest is null) break;
            if (Sessions.Remove(oldest, out var session))
                leases.Add(session.ResourceLease);
        }

        return leases;
    }

    private static void ReleaseLeases(
        IEnumerable<ResourceLeaseCache<GeometryResource>.Lease> leases)
    {
        foreach (var lease in leases) lease.Dispose();
    }

    private static string BuildResourceCacheKey(
        string filePath,
        string fileHash,
        string payloadHash,
        string entryName,
        string callerResourceKey,
        string pathSourceGeneration)
    {
        var context = CurrentRequestContext.Value;
        var workspaceEpoch = !string.IsNullOrWhiteSpace(pathSourceGeneration)
            ? pathSourceGeneration
            : !string.IsNullOrWhiteSpace(context?.WorkspaceEpoch)
                ? context!.WorkspaceEpoch
                : "daemon:" + DaemonId;
        return JsonSerializer.Serialize(new
        {
            schema = "ResourceCacheKeyV1",
            workspaceEpoch,
            canonicalOuterId = Path.GetFullPath(filePath),
            outerHash = fileHash,
            childIdentity = entryName,
            payloadHash,
            readerSchemaHash = ReaderSchemaHash,
            projectionProfile = ProjectionProfile,
            purpose = ResourcePurpose,
            callerResourceKey = callerResourceKey ?? string.Empty
        });
    }

    private static long EstimateReservationBytes(FlverNativeDocument flver)
    {
        // The native source remains resident for the descriptor lifetime; it
        // therefore participates in the byte budget even though it is not
        // duplicated by MeshInfo.
        var estimate = Math.Max(1, flver.SourceBytes.LongLength)
            + Math.Max(1, flver.MeshCount) * 16L * 1024L
            + flver.Bones.Count * 64L;
        return Math.Min(InFlightGeometryByteBudget - 1, Math.Max(1, estimate));
    }

    private static long EstimateResidentBytes(
        FlverNativeDocument flver,
        IReadOnlyList<MeshInfo> meshes)
    {
        long bytes = Math.Max(1, flver.SourceBytes.LongLength);
        bytes = AddBytes(bytes, flver.Bones.Count * 64L);
        foreach (var mesh in meshes)
        {
            bytes = AddBytes(bytes, 4096);
            bytes = AddBytes(bytes, mesh.TexturePaths.Sum(StringBytes));
            bytes = AddBytes(bytes, StringBytes(mesh.MaterialName));
            bytes = AddBytes(bytes, StringBytes(mesh.MaterialMtdPath));
            bytes = AddBytes(bytes, mesh.RuleIds.Sum(StringBytes));
        }

        return Math.Max(1, bytes);
    }

    private static long StringBytes(string value) =>
        string.IsNullOrEmpty(value) ? 0 : Encoding.UTF8.GetByteCount(value);

    private static long AddBytes(long current, long additional)
    {
        try { return checked(current + Math.Max(0, additional)); }
        catch (OverflowException) { return long.MaxValue; }
    }

    private static IReadOnlyList<MeshInfo> BuildMeshInfos(FlverNativeDocument flver)
    {
        var list = new List<MeshInfo>(flver.MeshCount);
        for (var meshIndex = 0; meshIndex < flver.MeshCount; meshIndex++)
        {
            // This is metadata-only: no Base64 wrapper, vertex allocation, or
            // full index array is touched while the session is created.
            var descriptor = flver.GetMeshGeometryDescriptor(meshIndex);
            if (descriptor is null) continue;

            var nativeMesh = flver.Meshes[meshIndex];
            var material = nativeMesh.MaterialIndex >= 0
                && nativeMesh.MaterialIndex < flver.Materials.Count
                ? flver.Materials[nativeMesh.MaterialIndex]
                : null;
            var texturePaths = FindAlbedoTexturePaths(flver, nativeMesh.MaterialIndex);
            var min = descriptor.NativeBoundsMin;
            var max = descriptor.NativeBoundsMax;
            list.Add(new MeshInfo
            {
                MeshIndex = meshIndex,
                Descriptor = descriptor,
                VertexCount = descriptor.SourceVertexCount,
                SourceIndexCount = descriptor.SourceIndexCount,
                IndexElementBytes = descriptor.IndexElementBytes,
                MaterialIndex = nativeMesh.MaterialIndex,
                MaterialName = material?.Name ?? "",
                MaterialMtdPath = material?.MtdPath ?? "",
                TexturePath = texturePaths.FirstOrDefault() ?? "",
                TexturePaths = texturePaths,
                MinX = min[0],
                MinY = min[1],
                MinZ = min[2],
                MaxX = max[0],
                MaxY = max[1],
                MaxZ = max[2],
                SelectedFaceSetOrdinals = new[] { descriptor.DisplayFaceSetOrdinal },
                RuleIds = new[] { RuleId },
                SourceIndexBits = new[] { descriptor.IndexElementBytes * 8 },
                FaceSetCullBackfaces = new[] { descriptor.CullBackfaces },
                Dynamic = nativeMesh.Dynamic
            });
        }

        System.Threading.Interlocked.Increment(ref BridgeTelemetry.MapGeometryProjectionCount);
        return list;
    }

    private static string[] FindAlbedoTexturePaths(
        FlverNativeDocument flver,
        int materialIndex)
    {
        if (materialIndex < 0) return Array.Empty<string>();
        var slots = flver.GetTextureSlots()
            .Where(slot => slot.MaterialIndex == materialIndex
                && !string.IsNullOrWhiteSpace(slot.Path))
            .ToArray();
        if (slots.Length == 0) return Array.Empty<string>();

        var albedo = slots.Where(slot => IsLikelyAlbedo(slot.Type, slot.Path));
        var candidates = albedo.Any() ? albedo : slots;
        return candidates
            .Select(slot => slot.Path)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static bool IsLikelyAlbedo(string type, string path)
    {
        var value = (type + " " + path).ToLowerInvariant();
        if (value.Contains("normal") || value.Contains("bump") || value.Contains("spec")
            || value.Contains("rough") || value.Contains("mask"))
            return false;
        return type.Contains("albedo", StringComparison.OrdinalIgnoreCase)
            || type.Contains("diffuse", StringComparison.OrdinalIgnoreCase)
            || type.Contains("basecolor", StringComparison.OrdinalIgnoreCase)
            || value.Contains("diffuse") || value.Contains("albedo")
            || value.Contains("basecolor")
            || path.EndsWith("_a.tif", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("_d.tif", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("_a.dds", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("_d.dds", StringComparison.OrdinalIgnoreCase);
    }

    // New cursors are opaque random tokens. The old EncodeCursor format is
    // retained solely so the command can reject it at a new-session boundary.
    public static string GenerateOpaqueCursor(
        SessionEntry session,
        int meshIndex,
        int sourceIndexPosition)
    {
        var state = BuildCursorState(session, meshIndex, sourceIndexPosition);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        lock (Gate) session.Cursors[token] = state;
        return token;
    }

    private static string GenerateOpaqueCursor(
        SessionEntry session,
        int meshIndex,
        int sourceIndexPosition,
        FlverNativeDocument.FlverDisplayTriangleCursor topology)
    {
        var state = BuildCursorState(
            session,
            meshIndex,
            sourceIndexPosition,
            topology);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        lock (Gate) session.Cursors[token] = state;
        return token;
    }

    private static CursorState BuildCursorState(
        SessionEntry session,
        int meshIndex,
        int sourceIndexPosition,
        FlverNativeDocument.FlverDisplayTriangleCursor? topology = null)
    {
        var state = new CursorState
        {
            MeshIndex = meshIndex,
            SourceIndexPosition = sourceIndexPosition,
            DaemonId = session.DaemonId,
            OwnerLeaseId = session.OwnerLeaseId,
            SourceHash = session.FileHash,
            ResourceCacheKeySha256 = session.ResourceCacheKeySha256
        };

        if (topology is { } current)
        {
            state.EmittedTriangleCount = current.EmittedTriangleCount;
            state.StripA = current.StripA;
            state.StripB = current.StripB;
            state.HasStripA = current.HasStripA;
            state.HasStripB = current.HasStripB;
            state.StripParity = current.StripParity;
        }
        else if (meshIndex >= 0 && meshIndex < session.Meshes.Count)
        {
            var descriptor = session.Meshes[meshIndex].Descriptor;
            if (sourceIndexPosition >= 0
                && sourceIndexPosition <= descriptor.SourceIndexCount)
            {
                var replay = session.Flver.CreateDisplayTriangleCursor(
                    descriptor,
                    sourceIndexPosition);
                state.EmittedTriangleCount = replay.EmittedTriangleCount;
                state.StripA = replay.StripA;
                state.StripB = replay.StripB;
                state.HasStripA = replay.HasStripA;
                state.HasStripB = replay.HasStripB;
                state.StripParity = replay.StripParity;
            }
        }

        return state;
    }

    public static string EncodeCursor(int meshIndex, int triangleStart)
    {
        var raw = meshIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + ":" + triangleStart.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(raw));
    }

    public static bool TryDecodeCursor(
        string cursor,
        out int meshIndex,
        out int triangleStart)
    {
        meshIndex = 0;
        triangleStart = 0;
        // The pre-SF-14 cursor was a base64 encoded `mesh:triangle` pair. It
        // did not carry the daemon/session/source identity and could therefore
        // resume the wrong FLVER after a cache or workspace change. Keep this
        // method only as an explicit compatibility probe: production resume
        // must go through TryDecodeOpaqueCursor below.
        return false;
    }

    public static bool TryDecodeOpaqueCursor(
        SessionEntry session,
        string cursor,
        out int meshIndex,
        out int sourceIndexPosition)
    {
        meshIndex = 0;
        sourceIndexPosition = 0;
        CursorHint.Value = null;
        lock (Gate)
        {
            if (!session.Cursors.TryGetValue(cursor, out var state))
                return false;
            if (session.DaemonId != DaemonId
                || state.DaemonId != DaemonId
                || state.DaemonId != session.DaemonId
                || state.SourceHash != session.FileHash
                || state.ResourceCacheKeySha256 != session.ResourceCacheKeySha256
                || state.OwnerLeaseId != session.OwnerLeaseId)
                return false;

            if (state.MeshIndex < 0 || state.MeshIndex >= session.Meshes.Count
                || state.SourceIndexPosition < 0
                || state.SourceIndexPosition
                    > session.Meshes[state.MeshIndex].Descriptor.SourceIndexCount
                || state.EmittedTriangleCount < 0)
                return false;

            meshIndex = state.MeshIndex;
            sourceIndexPosition = state.SourceIndexPosition;
            session.LastAccessMs = Environment.TickCount64;
            CursorHint.Value = new CursorResumeHint(session, state);
            return true;
        }
    }

    private static bool TryGetCursorTopology(
        SessionEntry session,
        int meshIndex,
        int sourceIndexPosition,
        out FlverNativeDocument.FlverDisplayTriangleCursor topology)
    {
        topology = default;
        var hint = CursorHint.Value;
        if (hint is null
            || !ReferenceEquals(hint.Session, session)
            || hint.State.MeshIndex != meshIndex
            || hint.State.SourceIndexPosition != sourceIndexPosition)
            return false;

        topology = new FlverNativeDocument.FlverDisplayTriangleCursor
        {
            SourceIndexPosition = hint.State.SourceIndexPosition,
            EmittedTriangleCount = hint.State.EmittedTriangleCount,
            StripA = hint.State.StripA,
            StripB = hint.State.StripB,
            HasStripA = hint.State.HasStripA,
            HasStripB = hint.State.HasStripB,
            StripParity = hint.State.StripParity
        };
        return true;
    }

    private static bool TryConsumeCursorTopology(
        SessionEntry session,
        int meshIndex,
        int sourceIndexPosition,
        out FlverNativeDocument.FlverDisplayTriangleCursor topology)
    {
        var found = TryGetCursorTopology(
            session,
            meshIndex,
            sourceIndexPosition,
            out topology);
        if (found) CursorHint.Value = null;
        return found;
    }

    private static bool TryFindRenderableMesh(
        SessionEntry session,
        int startMesh,
        int startSourceIndex,
        out int meshListIndex,
        out int sourceIndexPosition,
        out MeshInfo? mesh)
    {
        meshListIndex = -1;
        sourceIndexPosition = 0;
        mesh = null;
        if (startMesh < 0 || startSourceIndex < 0 || startMesh >= session.Meshes.Count)
            return false;

        for (var index = startMesh; index < session.Meshes.Count; index++)
        {
            var candidate = session.Meshes[index];
            var position = index == startMesh ? startSourceIndex : 0;
            if (position > candidate.Descriptor.SourceIndexCount)
            {
                if (index == startMesh)
                    throw new InvalidDataException(
                        "MAP_STATIC_CURSOR_RANGE_INVALID: source index position exceeds FaceSet");
                continue;
            }

            if (!HasDisplayTriangle(session, index, candidate.Descriptor, position))
                continue;

            meshListIndex = index;
            sourceIndexPosition = position;
            mesh = candidate;
            return true;
        }

        return false;
    }

    internal static MeshInfo? GetMeshForChunk(
        SessionEntry session,
        int startMesh,
        int startSourceIndex)
    {
        return TryFindRenderableMesh(
            session,
            startMesh,
            startSourceIndex,
            out _,
            out _,
            out var mesh)
            ? mesh
            : null;
    }

    private static bool HasDisplayTriangle(
        FlverNativeDocument flver,
        FlverNativeDocument.FlverMeshGeometryDescriptor descriptor,
        int sourceIndexPosition)
    {
        if (sourceIndexPosition < 0 || sourceIndexPosition > descriptor.SourceIndexCount)
            return false;
        var cursor = flver.CreateDisplayTriangleCursor(descriptor, sourceIndexPosition);
        return flver.TryReadDisplayTriangle(descriptor, ref cursor, out _);
    }

    private static bool HasDisplayTriangle(
        SessionEntry session,
        int cursorMeshIndex,
        FlverNativeDocument.FlverMeshGeometryDescriptor descriptor,
        int sourceIndexPosition)
    {
        if (sourceIndexPosition < 0 || sourceIndexPosition > descriptor.SourceIndexCount)
            return false;
        var cursor = TryGetCursorTopology(
                session,
                cursorMeshIndex,
                sourceIndexPosition,
                out var resumed)
            ? resumed
            : session.Flver.CreateDisplayTriangleCursor(descriptor, sourceIndexPosition);
        return session.Flver.TryReadDisplayTriangle(descriptor, ref cursor, out _);
    }

    internal static object? BuildChunk(
        SessionEntry session,
        int startMesh,
        int startSourceIndex,
        out string? nextCursor,
        out bool complete,
        string? texturePreviewToken = null,
        string? textureColorSpace = null)
    {
        nextCursor = null;
        complete = false;
        if (startMesh < 0 || startSourceIndex < 0)
            throw new InvalidDataException("MAP_STATIC_CURSOR_RANGE_INVALID");

        if (!TryFindRenderableMesh(
                session,
                startMesh,
                startSourceIndex,
                out var meshListIndex,
                out var sourceIndexPosition,
                out var mesh)
            || mesh is null)
        {
            complete = true;
            return null;
        }

        var descriptor = mesh.Descriptor;
        var initialTopology = TryConsumeCursorTopology(
                session,
                meshListIndex,
                sourceIndexPosition,
                out var resumedTopology)
            ? resumedTopology
            : session.Flver.CreateDisplayTriangleCursor(descriptor, sourceIndexPosition);
        var sourceTriangleStart = initialTopology.EmittedTriangleCount;
        var sourceIndexStart = initialTopology.SourceIndexPosition;
        var candidateTopology = initialTopology;
        var accepted = new List<PendingTriangle>(Math.Min(MaxTrianglesPerChunk, 1024));
        var acceptedSources = new HashSet<uint>();
        var wireFloatComponentsPerVertex = 3
            + (descriptor.DataPlan.Normal is null ? 0 : 3)
            + (descriptor.UvSetCount > 0 ? 2 : 0);
        var wireMetadataBytes = EstimateWireMetadataBytes(
            session,
            mesh,
            texturePreviewToken,
            textureColorSpace);

        // Discover topology boundaries before decoding any vertex payload. A
        // candidate that exceeds the binary budget never mutates the accepted
        // cursor, so a page boundary cannot replay or skip a strip triangle.
        while (accepted.Count < MaxTrianglesPerChunk
            && session.Flver.TryReadDisplayTriangle(
                descriptor,
                ref candidateTopology,
                out var triangle))
        {
            // Keep the native A/B/C first-seen order without allocating a
            // three-item array or a LINQ result for every candidate. OOB
            // validation intentionally remains before either budget check.
            var addA = !acceptedSources.Contains(triangle.A);
            var addB = triangle.B != triangle.A && !acceptedSources.Contains(triangle.B);
            var addC = triangle.C != triangle.A
                && triangle.C != triangle.B
                && !acceptedSources.Contains(triangle.C);
            if (addA && triangle.A >= (uint)descriptor.SourceVertexCount)
                throw new InvalidDataException(
                    "MAP_STATIC_SOURCE_VERTEX_OUT_OF_BOUNDS: source vertex index exceeds descriptor");
            if (addB && triangle.B >= (uint)descriptor.SourceVertexCount)
                throw new InvalidDataException(
                    "MAP_STATIC_SOURCE_VERTEX_OUT_OF_BOUNDS: source vertex index exceeds descriptor");
            if (addC && triangle.C >= (uint)descriptor.SourceVertexCount)
                throw new InvalidDataException(
                    "MAP_STATIC_SOURCE_VERTEX_OUT_OF_BOUNDS: source vertex index exceeds descriptor");
            var newSourceCount = (addA ? 1 : 0) + (addB ? 1 : 0) + (addC ? 1 : 0);

            var estimatedBytes = EstimateBinaryPayloadBytes(
                descriptor,
                acceptedSources.Count + newSourceCount,
                accepted.Count + 1);
            var estimatedWireBytes = EstimateWirePayloadBytes(
                descriptor,
                acceptedSources.Count + newSourceCount,
                accepted.Count + 1,
                wireFloatComponentsPerVertex,
                wireMetadataBytes);
            if (estimatedBytes > ChunkPayloadBudgetBytes
                || estimatedWireBytes >= SafeChunkFrameBytes)
            {
                if (accepted.Count == 0)
                    throw new InvalidDataException(
                        "MAP_STATIC_CHUNK_BUDGET_EXCEEDED: one legal triangle exceeds the chunk budget");
                break;
            }

            accepted.Add(new PendingTriangle(triangle, candidateTopology));
            if (addA) acceptedSources.Add(triangle.A);
            if (addB) acceptedSources.Add(triangle.B);
            if (addC) acceptedSources.Add(triangle.C);
        }

        if (accepted.Count == 0)
        {
            // TryFindRenderableMesh guarantees a current candidate. Reaching
            // this branch means the native cursor contract changed underneath
            // the projection, which must fail closed rather than loop forever.
            throw new InvalidDataException(
                "MAP_STATIC_CURSOR_REPLAY_FAILED: renderable FaceSet had no readable triangle");
        }

        // Decode only the final accepted prefix. The real JSON serialization
        // is the authoritative wire-budget check; if metadata/base64 overhead
        // pushes the page over the frame limit, shrink and rebuild the same
        // immutable topology prefix.
        ChunkBuffers buffers;
        object chunk;
        var acceptedCount = accepted.Count;
        while (true)
        {
            buffers = DecodeChunkBuffers(session, mesh, accepted, acceptedCount);
            var indexElementBytes = buffers.SourceVertexIndices.Count <= ushort.MaxValue ? 2 : 4;
            chunk = BuildChunkObject(
                session,
                mesh,
                sourceTriangleStart,
                sourceIndexStart,
                acceptedCount,
                buffers.SourceVertexIndices,
                buffers.Positions,
                buffers.Normals,
                buffers.Uvs,
                buffers.DenseIndices,
                descriptor,
                buffers.MinX,
                buffers.MinY,
                buffers.MinZ,
                buffers.MaxX,
                buffers.MaxY,
                buffers.MaxZ,
                indexElementBytes,
                texturePreviewToken,
                textureColorSpace);
            var serializedBytes = JsonSerializer.SerializeToUtf8Bytes(chunk).LongLength;
            if (serializedBytes < SafeChunkFrameBytes) break;
            if (acceptedCount <= 1)
                throw new InvalidDataException(
                    "MAP_STATIC_CHUNK_BUDGET_EXCEEDED: one legal triangle exceeds the serialized frame budget");
            acceptedCount -= 1;
        }

        var finalTopology = accepted[acceptedCount - 1].CursorAfter;
        var nextSourcePosition = finalTopology.SourceIndexPosition;
        // finalTopology already contains the native strip/list state at the
        // page boundary. Probe a copy directly; calling HasDisplayTriangle
        // here would recreate a cursor at source position zero after the
        // resume hint was consumed above, replaying the whole FaceSet prefix
        // once per page.
        var lookahead = finalTopology;
        if (session.Flver.TryReadDisplayTriangle(descriptor, ref lookahead, out _))
        {
            nextCursor = GenerateOpaqueCursor(
                session,
                meshListIndex,
                nextSourcePosition,
                finalTopology);
        }
        else if (TryFindRenderableMesh(
                     session,
                     meshListIndex + 1,
                     0,
                     out var nextMeshListIndex,
                     out _,
                     out _))
        {
            // Store the next mesh boundary directly instead of an opaque state
            // that only replays trailing restart/degenerate indices.
            nextCursor = GenerateOpaqueCursor(session, nextMeshListIndex, 0);
        }
        else
        {
            complete = true;
        }

        return chunk;
    }

    private static long EstimateBinaryPayloadBytes(
        FlverNativeDocument.FlverMeshGeometryDescriptor descriptor,
        int sourceVertexCount,
        int triangleCount)
    {
        var floatComponentsPerVertex = 3
            + (descriptor.DataPlan.Normal is null ? 0 : 3)
            + (descriptor.UvSetCount > 0 ? 2 : 0);
        var denseIndexBytes = sourceVertexCount <= ushort.MaxValue ? 2 : 4;
        return checked(
            (long)sourceVertexCount * sizeof(uint)
            + (long)sourceVertexCount * floatComponentsPerVertex * sizeof(float)
            + (long)triangleCount * 3 * denseIndexBytes);
    }

    private static long EstimateWirePayloadBytes(
        FlverNativeDocument.FlverMeshGeometryDescriptor descriptor,
        int sourceVertexCount,
        int triangleCount,
        int floatComponentsPerVertex,
        long metadataBytes)
    {
        var denseIndexBytes = sourceVertexCount <= ushort.MaxValue ? 2 : 4;
        var positionsBytes = checked((long)sourceVertexCount * 3 * sizeof(float));
        var normalsBytes = descriptor.DataPlan.Normal is null
            ? 0L
            : checked((long)sourceVertexCount * 3 * sizeof(float));
        var uvsBytes = descriptor.UvSetCount > 0
            ? checked((long)sourceVertexCount * 2 * sizeof(float))
            : 0L;
        var indicesBytes = checked((long)triangleCount * 3 * denseIndexBytes);
        var sourceIndicesBytes = checked((long)sourceVertexCount * sizeof(uint));
        var wireBytes = Base64EncodedBytes(positionsBytes)
            + Base64EncodedBytes(indicesBytes)
            + Base64EncodedBytes(sourceIndicesBytes)
            + Base64EncodedBytes(normalsBytes)
            + Base64EncodedBytes(uvsBytes);
        return checked(wireBytes + metadataBytes + floatComponentsPerVertex);
    }

    private static long EstimateWireMetadataBytes(
        SessionEntry session,
        MeshInfo mesh,
        string? texturePreviewToken,
        string? textureColorSpace)
    {
        // Numeric fields, bounds, material identity and rule arrays are small
        // but real JSON bytes. Keep a conservative fixed envelope and include
        // all variable strings so the candidate budget never assumes that
        // metadata is free. This is invariant for one BuildChunk call.
        return 16L * 1024L
            + StringBytes(session.ModelName)
            + StringBytes(mesh.MaterialName)
            + StringBytes(mesh.MaterialMtdPath)
            + mesh.RuleIds.Sum(StringBytes)
            + StringBytes(texturePreviewToken ?? string.Empty)
            + StringBytes(textureColorSpace ?? string.Empty);
    }

    private static long Base64EncodedBytes(long byteCount)
    {
        if (byteCount <= 0) return 0;
        return checked(((byteCount + 2) / 3) * 4);
    }

    private static ChunkBuffers DecodeChunkBuffers(
        SessionEntry session,
        MeshInfo mesh,
        IReadOnlyList<PendingTriangle> triangles,
        int triangleCount)
    {
        var descriptor = mesh.Descriptor;
        var sourceToDense = new Dictionary<uint, int>();
        var sourceVertexIndices = new List<uint>();
        var positions = new List<float>();
        var normals = descriptor.DataPlan.Normal is not null ? new List<float>() : null;
        var uvs = descriptor.UvSetCount > 0 ? new List<float>() : null;
        var denseIndices = new List<uint>(checked(triangleCount * 3));
        var buffers = new ChunkBuffers
        {
            SourceVertexIndices = sourceVertexIndices,
            Positions = positions,
            Normals = normals,
            Uvs = uvs,
            DenseIndices = denseIndices
        };
        Span<float> positionScratch = stackalloc float[3];
        Span<float> normalScratch = stackalloc float[3];
        Span<float> uvScratch = stackalloc float[2];
        Span<float> skinWeights = stackalloc float[4];
        Span<ushort> skinIndices = stackalloc ushort[4];

        for (var triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++)
        {
            var triangle = triangles[triangleIndex].Triangle;
            DecodeChunkVertex(
                session,
                mesh,
                descriptor,
                triangle.A,
                sourceToDense,
                buffers,
                positionScratch,
                normalScratch,
                uvScratch,
                skinWeights,
                skinIndices);
            DecodeChunkVertex(
                session,
                mesh,
                descriptor,
                triangle.B,
                sourceToDense,
                buffers,
                positionScratch,
                normalScratch,
                uvScratch,
                skinWeights,
                skinIndices);
            DecodeChunkVertex(
                session,
                mesh,
                descriptor,
                triangle.C,
                sourceToDense,
                buffers,
                positionScratch,
                normalScratch,
                uvScratch,
                skinWeights,
                skinIndices);

            if (!sourceToDense.TryGetValue(triangle.A, out var denseA)
                || !sourceToDense.TryGetValue(triangle.B, out var denseB)
                || !sourceToDense.TryGetValue(triangle.C, out var denseC))
                throw new InvalidDataException(
                    "MAP_STATIC_DENSE_INDEX_BUILD_FAILED: triangle source was not decoded");
            denseIndices.Add((uint)denseA);
            denseIndices.Add((uint)denseB);
            denseIndices.Add((uint)denseC);
        }

        return buffers;
    }

    private static void DecodeChunkVertex(
        SessionEntry session,
        MeshInfo mesh,
        FlverNativeDocument.FlverMeshGeometryDescriptor descriptor,
        uint source,
        Dictionary<uint, int> sourceToDense,
        ChunkBuffers buffers,
        Span<float> positionScratch,
        Span<float> normalScratch,
        Span<float> uvScratch,
        Span<float> skinWeights,
        Span<ushort> skinIndices)
    {
        if (sourceToDense.ContainsKey(source)) return;
        if (source >= (uint)descriptor.SourceVertexCount)
            throw new InvalidDataException(
                "MAP_STATIC_SOURCE_VERTEX_OUT_OF_BOUNDS: source vertex index exceeds descriptor");

        var dense = buffers.SourceVertexIndices.Count;
        sourceToDense.Add(source, dense);
        buffers.SourceVertexIndices.Add(source);
        if (!session.Flver.DecodePositionInto(
                descriptor,
                checked((int)source),
                positionScratch))
            throw new InvalidDataException(
                "MAP_STATIC_POSITION_DECODE_FAILED: typed position decoder rejected source vertex");
        if (!float.IsFinite(positionScratch[0])
            || !float.IsFinite(positionScratch[1])
            || !float.IsFinite(positionScratch[2]))
            throw new InvalidDataException(
                "MAP_STATIC_POSITION_NONFINITE: typed position is not finite");

        var bakeReferencePose = mesh.Dynamic == 0 && session.Flver.Bones.Count > 0;
        if (bakeReferencePose)
        {
            var mode = session.Flver.DecodeMapVertexSkinning(
                descriptor,
                checked((int)source),
                skinWeights,
                skinIndices,
                out var skinFailure);
            if (mode == FlverMatureSkinning.VertexMode.Invalid)
                throw new InvalidDataException(
                    $"MAP_STATIC_SKINNING_INVALID:{skinFailure ?? "unknown"}");
            if (mode == FlverMatureSkinning.VertexMode.Weighted)
                throw new InvalidDataException(
                    "MAP_STATIC_SKINNING_WEIGHTED_UNSUPPORTED: absolute reference bake is only verified for rigid vertices");

            var boneIndex = skinIndices[0];
            if (boneIndex >= session.ReferenceFkMatrices.Length)
                throw new InvalidDataException(
                    $"MAP_STATIC_SKINNING_BONE_INDEX_INVALID:{boneIndex}");
            var transformedPosition = Vector3.Transform(
                new Vector3(positionScratch[0], positionScratch[1], positionScratch[2]),
                session.ReferenceFkMatrices[boneIndex]);
            if (!float.IsFinite(transformedPosition.X)
                || !float.IsFinite(transformedPosition.Y)
                || !float.IsFinite(transformedPosition.Z))
                throw new InvalidDataException(
                    "MAP_STATIC_POSITION_NONFINITE: reference FK produced a non-finite position");
            positionScratch[0] = transformedPosition.X;
            positionScratch[1] = transformedPosition.Y;
            positionScratch[2] = transformedPosition.Z;
        }
        buffers.Positions.Add(positionScratch[0]);
        buffers.Positions.Add(positionScratch[1]);
        buffers.Positions.Add(positionScratch[2]);
        buffers.MinX = Math.Min(buffers.MinX, positionScratch[0]);
        buffers.MinY = Math.Min(buffers.MinY, positionScratch[1]);
        buffers.MinZ = Math.Min(buffers.MinZ, positionScratch[2]);
        buffers.MaxX = Math.Max(buffers.MaxX, positionScratch[0]);
        buffers.MaxY = Math.Max(buffers.MaxY, positionScratch[1]);
        buffers.MaxZ = Math.Max(buffers.MaxZ, positionScratch[2]);

        if (buffers.Normals is not null)
        {
            if (!session.Flver.DecodeNormalInto(
                    descriptor,
                    checked((int)source),
                    normalScratch))
                throw new InvalidDataException(
                    "MAP_STATIC_NORMAL_DECODE_FAILED: typed normal decoder rejected source vertex");

            if (!float.IsFinite(normalScratch[0])
                || !float.IsFinite(normalScratch[1])
                || !float.IsFinite(normalScratch[2]))
                throw new InvalidDataException(
                    "MAP_STATIC_NORMAL_NONFINITE: typed normal is not finite");
            if (bakeReferencePose)
            {
                var normalMatrix = GetReferenceNormalMatrix(session, skinIndices[0]);
                var transformedNormal = Vector3.TransformNormal(
                    new Vector3(normalScratch[0], normalScratch[1], normalScratch[2]),
                    normalMatrix);
                if (!float.IsFinite(transformedNormal.X)
                    || !float.IsFinite(transformedNormal.Y)
                    || !float.IsFinite(transformedNormal.Z))
                    throw new InvalidDataException(
                        "MAP_STATIC_NORMAL_NONFINITE: reference FK produced a non-finite normal");
                var lengthSquared = transformedNormal.LengthSquared();
                if (lengthSquared > 1e-20f)
                    transformedNormal /= MathF.Sqrt(lengthSquared);
                else
                    transformedNormal = Vector3.Zero;
                normalScratch[0] = transformedNormal.X;
                normalScratch[1] = transformedNormal.Y;
                normalScratch[2] = transformedNormal.Z;
            }
            buffers.Normals.Add(normalScratch[0]);
            buffers.Normals.Add(normalScratch[1]);
            buffers.Normals.Add(normalScratch[2]);
        }

        if (buffers.Uvs is not null)
        {
            if (!session.Flver.DecodeUvInto(
                    descriptor,
                    0,
                    checked((int)source),
                    uvScratch))
                throw new InvalidDataException(
                    "MAP_STATIC_UV_DECODE_FAILED: typed UV decoder rejected source vertex");
            buffers.Uvs.Add(uvScratch[0]);
            buffers.Uvs.Add(uvScratch[1]);
        }
    }

    private static object BuildChunkObject(
        SessionEntry session,
        MeshInfo mesh,
        int sourceTriangleStart,
        int sourceIndexStart,
        int triangleCount,
        IReadOnlyList<uint> sourceVertexIndices,
        IReadOnlyList<float> positions,
        IReadOnlyList<float>? normals,
        IReadOnlyList<float>? uvs,
        IReadOnlyList<uint> denseIndices,
        FlverNativeDocument.FlverMeshGeometryDescriptor descriptor,
        float emittedMinX,
        float emittedMinY,
        float emittedMinZ,
        float emittedMaxX,
        float emittedMaxY,
        float emittedMaxZ,
        int indexElementBytes,
        string? texturePreviewToken,
        string? textureColorSpace)
    {
        var boundsMin = descriptor.HasNativeBounds
            ? descriptor.NativeBoundsMin
            : new[] { emittedMinX, emittedMinY, emittedMinZ };
        var boundsMax = descriptor.HasNativeBounds
            ? descriptor.NativeBoundsMax
            : new[] { emittedMaxX, emittedMaxY, emittedMaxZ };
        var boundsStatus = descriptor.HasNativeBounds ? "native" : "partial";
        var materialKey = mesh.MaterialIndex >= 0 ? "mat:" + mesh.MaterialIndex : null;

        return new
        {
            chunkId = session.Token + ":" + mesh.MeshIndex + ":" + sourceIndexStart,
            modelName = session.ModelName,
            meshIndex = mesh.MeshIndex,
            meshPlanIndex = mesh.MeshIndex,
            meshOrdinal = mesh.MeshIndex,
            displayProfileId = ProjectionProfile,
            selectedFaceSetOrdinals = mesh.SelectedFaceSetOrdinals,
            sourceFaceSetIndexBits = mesh.SourceIndexBits,
            faceSetCullBackfaces = mesh.FaceSetCullBackfaces,
            ruleIds = mesh.RuleIds,
            sourceTriangleStart,
            triangleCount,
            sourceIndexStart,
            sourceIndexCount = descriptor.SourceIndexCount,
            sourceVertexCount = descriptor.SourceVertexCount,
            emittedVertexCount = sourceVertexIndices.Count,
            emittedIndexCount = denseIndices.Count,
            positionsBase64 = EncodeFloats(positions),
            indicesBase64 = EncodeIndices(denseIndices, indexElementBytes),
            sourceVertexIndicesBase64 = EncodeIndices(sourceVertexIndices, 4),
            indexElementBytes,
            normalsBase64 = normals is null ? null : EncodeFloats(normals),
            uvsBase64 = uvs is null ? null : EncodeFloats(uvs),
            boundsStatus,
            boundsPartial = !descriptor.HasNativeBounds,
            bounds = new { min = boundsMin, max = boundsMax },
            emittedBounds = new
            {
                min = new[] { emittedMinX, emittedMinY, emittedMinZ },
                max = new[] { emittedMaxX, emittedMaxY, emittedMaxZ }
            },
            materialKey,
            materialIndex = mesh.MaterialIndex,
            materialName = mesh.MaterialName,
            texturePreviewToken,
            textureColorSpace,
            telemetry = BridgeTelemetry.Snapshot()
        };
    }

    private static string EncodeFloats(IReadOnlyList<float> values)
    {
        var bytes = new byte[checked(values.Count * sizeof(float))];
        for (var i = 0; i < values.Count; i++)
            BinaryPrimitives.WriteInt32LittleEndian(
                bytes.AsSpan(i * sizeof(float), sizeof(float)),
                BitConverter.SingleToInt32Bits(values[i]));
        return Convert.ToBase64String(bytes);
    }

    private static string EncodeIndices(
        IReadOnlyList<uint> values,
        int elementBytes)
    {
        var bytes = new byte[checked(values.Count * elementBytes)];
        if (elementBytes == 2)
        {
            for (var i = 0; i < values.Count; i++)
            {
                if (values[i] > ushort.MaxValue)
                    throw new InvalidDataException(
                        "MAP_STATIC_LOCAL_INDEX_OVERFLOW: dense index does not fit uint16");
                BinaryPrimitives.WriteUInt16LittleEndian(
                    bytes.AsSpan(i * 2, 2),
                    (ushort)values[i]);
            }
        }
        else if (elementBytes == 4)
        {
            for (var i = 0; i < values.Count; i++)
                BinaryPrimitives.WriteUInt32LittleEndian(
                    bytes.AsSpan(i * 4, 4),
                    values[i]);
        }
        else
        {
            throw new InvalidDataException(
                "MAP_STATIC_INDEX_ELEMENT_BYTES_INVALID: expected 2 or 4");
        }

        return Convert.ToBase64String(bytes);
    }
}

using System.Collections.Concurrent;
using System.Security.Cryptography;

internal static class ParamDocumentSessionCache
{
    private const int SessionCapacity = 16;
    private const long SessionTtlMs = 600_000;
    private const long MaxSessionBytes = 96L * 1024 * 1024;

    internal sealed class Entry
    {
        private readonly object _materializationGate = new();
        private readonly byte[] _sourceBytes;
        private readonly int? _expectedRowDataSize;

        private Entry(
            byte[] sourceBytes,
            string fileHash,
            int expectedRowDataSize,
            ParamNativeIndex? index,
            ParamNativeDocument? document,
            ParamRoundTripReport? roundTrip)
        {
            _sourceBytes = sourceBytes;
            _expectedRowDataSize = expectedRowDataSize > 0 ? expectedRowDataSize : null;
            FileHash = fileHash;
            ExpectedRowDataSize = expectedRowDataSize;
            Index = index;
            Document = document;
            RoundTrip = roundTrip;
        }

        public ParamNativeIndex? Index { get; private set; }
        public ParamNativeDocument? Document { get; private set; }
        public ParamRoundTripReport? RoundTrip { get; private set; }
        public string FileHash { get; }
        public int ExpectedRowDataSize { get; }
        public long EstimatedBytes { get; set; }

        internal static Entry Create(
            byte[] sourceBytes,
            string fileHash,
            int expectedRowDataSize,
            bool preferLazy)
        {
            if (preferLazy)
            {
                var index = ParamNativeIndex.Read(sourceBytes, expectedRowDataSize > 0 ? expectedRowDataSize : null);
                System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamStructuralValidationCount);
                return new Entry(sourceBytes, fileHash, expectedRowDataSize, index, null, null);
            }

            System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamParseCount);
            var document = ParamNativeDocument.Read(sourceBytes, expectedRowDataSize > 0 ? expectedRowDataSize : null);
            var roundTrip = document.VerifyRoundTrip();
            System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamStructuralValidationCount);
            return new Entry(sourceBytes, fileHash, expectedRowDataSize, null, document, roundTrip);
        }

        internal ParamNativeIndex GetIndex()
        {
            lock (_materializationGate)
            {
                if (Index is not null) return Index;
                Index = ParamNativeIndex.Read(_sourceBytes, _expectedRowDataSize);
                System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamStructuralValidationCount);
                return Index;
            }
        }

        internal ParamNativeDocument GetDocument()
        {
            lock (_materializationGate)
            {
                if (Document is not null) return Document;
                System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamParseCount);
                Document = ParamNativeDocument.Read(_sourceBytes, _expectedRowDataSize);
                return Document;
            }
        }

        internal ParamRoundTripReport GetRoundTrip()
        {
            lock (_materializationGate)
            {
                if (RoundTrip is not null) return RoundTrip;
                var document = GetDocument();
                RoundTrip = document.VerifyRoundTrip();
                System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamStructuralValidationCount);
                return RoundTrip;
            }
        }

        internal long EstimateBytes()
        {
            var index = Index;
            if (index is not null)
                return _sourceBytes.LongLength + index.Rows.Count * 64L;
            var document = Document;
            return document is null
                ? _sourceBytes.LongLength
                : _sourceBytes.LongLength + document.Rows.Count * (long)(document.RowDataSize + 32);
        }
    }

    private sealed class Session
    {
        public required string Token { get; init; }
        public required Entry Entry { get; init; }
        public required string CanonicalPath { get; init; }
        public required string WorkspaceSessionId { get; init; }
        public required string SourceHash { get; init; }
        public required long PathSourceGeneration { get; init; }
        public required string EntryIdentity { get; init; }
        public long LastAccessMs { get; set; }
        public long EstimatedBytes { get; init; }
    }

    private readonly record struct Key(string WorkspaceSessionId, string CanonicalPath, string SourceHash, long PathSourceGeneration, string EntryIdentity, int ExpectedRowDataSize, string OodleRoot);

    private static readonly Dictionary<Key, Session> Sessions = new();
    private static readonly Dictionary<string, Session> ByToken = new(StringComparer.Ordinal);
    private static readonly object Gate = new();

    internal static string NormalizeRoot(string? root)
    {
        if (string.IsNullOrWhiteSpace(root)) return string.Empty;
        try { return Path.GetFullPath(root); } catch { return root; }
    }

    internal static Entry GetOrOpen(
        string file,
        string workspaceSessionId,
        string? oodleRuntimeRoot,
        long pathSourceGeneration,
        int expectedRowDataSize,
        string entryIdentity,
        bool preferLazy,
        out string token,
        out bool isNew,
        out string sourceHash)
    {
        var canonical = Path.GetFullPath(file);
        var bytes = File.ReadAllBytes(file);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        sourceHash = hash;
        var key = new Key(workspaceSessionId ?? string.Empty, canonical, hash, pathSourceGeneration, entryIdentity ?? string.Empty, expectedRowDataSize, NormalizeRoot(oodleRuntimeRoot));
        lock (Gate)
        {
            EvictExpiredLocked();
            if (Sessions.TryGetValue(key, out var existing))
            {
                existing.LastAccessMs = Environment.TickCount64;
                token = existing.Token;
                isNew = false;
                return existing.Entry;
            }
            // The session editor opens a validated directory first. The legacy
            // route remains available when callers explicitly need a full document
            // and round-trip report for native writes.
            var entry = Entry.Create(bytes, hash, expectedRowDataSize, preferLazy);
            var est = entry.EstimateBytes();
            entry.EstimatedBytes = est;
            var newToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var session = new Session
            {
                Token = newToken,
                Entry = entry,
                CanonicalPath = canonical,
                WorkspaceSessionId = workspaceSessionId ?? string.Empty,
                SourceHash = hash,
                PathSourceGeneration = pathSourceGeneration,
                EntryIdentity = entryIdentity ?? string.Empty,
                LastAccessMs = Environment.TickCount64,
                EstimatedBytes = est,
            };
            Sessions[key] = session;
            ByToken[newToken] = session;
            System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamSessionOpenCount);
            EvictOverBudgetLocked(newToken);
            token = newToken;
            isNew = true;
            return entry;
        }
    }

    internal static bool TryGetByToken(string token, string file, string workspaceSessionId, long pathSourceGeneration, out Entry entry, out string sourceHash)
    {
        entry = null!;
        sourceHash = string.Empty;
        if (string.IsNullOrWhiteSpace(token)) return false;
        lock (Gate)
        {
            EvictExpiredLocked();
            if (!ByToken.TryGetValue(token, out var session)) return false;
            // validate binding
            var canonical = Path.GetFullPath(file);
            if (!string.Equals(session.CanonicalPath, canonical, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.Equals(session.WorkspaceSessionId, workspaceSessionId ?? string.Empty, StringComparison.Ordinal)) return false;
            // if pathSourceGeneration mismatch -> stale
            if (session.PathSourceGeneration != pathSourceGeneration) return false;
            // file hash must still match
            var bytes = File.ReadAllBytes(file);
            var curHash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            sourceHash = curHash;
            if (!string.Equals(curHash, session.SourceHash, StringComparison.OrdinalIgnoreCase)) return false;
            session.LastAccessMs = Environment.TickCount64;
            entry = session.Entry;
            return true;
        }
    }

    private static void EvictExpiredLocked()
    {
        var now = Environment.TickCount64;
        var doomed = new List<Key>();
        foreach (var kv in Sessions)
            if (now - kv.Value.LastAccessMs > SessionTtlMs) doomed.Add(kv.Key);
        foreach (var k in doomed)
        {
            if (Sessions.Remove(k, out var s)) ByToken.Remove(s.Token);
        }
    }

    private static void EvictOverBudgetLocked(string? protectedToken)
    {
        while (Sessions.Count > SessionCapacity)
        {
            var oldest = FindOldest(protectedToken);
            if (oldest == null) break;
            if (Sessions.Remove(oldest.Value, out var s)) ByToken.Remove(s.Token);
        }
        while (true)
        {
            long total = 0;
            foreach (var sess in Sessions.Values) total += sess.EstimatedBytes;
            if (total <= MaxSessionBytes) break;
            var oldest = FindOldest(protectedToken);
            if (oldest == null) break;
            if (Sessions.Remove(oldest.Value, out var evicted)) ByToken.Remove(evicted.Token);
        }
    }

    private static Key? FindOldest(string? protectedToken)
    {
        Key? oldest = null;
        long oldestTick = long.MaxValue;
        foreach (var kv in Sessions)
        {
            if (protectedToken != null && kv.Value.Token == protectedToken) continue;
            if (kv.Value.LastAccessMs >= oldestTick) continue;
            oldestTick = kv.Value.LastAccessMs;
            oldest = kv.Key;
        }
        return oldest;
    }

    internal static void Reset()
    {
        lock (Gate)
        {
            Sessions.Clear();
            ByToken.Clear();
        }
    }
}

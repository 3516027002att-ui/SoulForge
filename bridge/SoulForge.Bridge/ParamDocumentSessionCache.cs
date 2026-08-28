using System.Collections.Concurrent;
using System.Security.Cryptography;

internal static class ParamDocumentSessionCache
{
    private const int SessionCapacity = 16;
    private const long SessionTtlMs = 600_000;
    private const long MaxSessionBytes = 96L * 1024 * 1024;

    internal sealed record Entry(
        ParamNativeDocument Document,
        ParamRoundTripReport RoundTrip,
        string FileHash,
        int ExpectedRowDataSize,
        long EstimatedBytes);

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

    private static long EstimateBytes(Entry entry)
    {
        long total = entry.Document.SourceBytes.LongLength;
        total += entry.Document.Rows.Count * (long)(entry.Document.RowDataSize + 32);
        return total;
    }

    internal static Entry GetOrOpen(
        string file,
        string workspaceSessionId,
        string? oodleRuntimeRoot,
        long pathSourceGeneration,
        int expectedRowDataSize,
        string entryIdentity,
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
            // single parse
            System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamParseCount);
            var doc = ParamNativeDocument.Read(bytes, expectedRowDataSize > 0 ? expectedRowDataSize : null);
            var rt = doc.VerifyRoundTrip();
            System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamStructuralValidationCount);
            var entry = new Entry(doc, rt, hash, expectedRowDataSize, 0);
            var est = EstimateBytes(entry);
            entry = entry with { EstimatedBytes = est };
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

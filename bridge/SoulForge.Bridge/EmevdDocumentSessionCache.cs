using System.Security.Cryptography;

/// <summary>
/// 守护进程级的 EMEVD 已解析文档缓存 + 短命分页会话。
///
/// 身份是外层文件完整 SHA-256，不是 mtime + length。哈希、DCX 解压与 EMEVD
/// 解析消费同一份已读入内存的字节：先哈希再重新打开会在两次打开之间被外部
/// 工具改写，造成「用 A 的键缓存 B 的文档」。
///
/// single-flight 不用 <see cref="Lazy{T}"/>。Lazy 会捕获第一个调用者传入工厂
/// 的 CancellationToken：owner 取消会让所有 waiter 一起失败，waiter 自己取消
/// 仍会同步卡在 Lazy.Value 上。这里用独立的 in-flight 对象：共享 CTS 只在
/// waiter 引用计数归零时取消，任一调用者的 token 都不拥有底层装载。
///
/// 长期缓存（4 条 / 96 MiB）与分页会话分开。bypass 不写长期缓存，但会签发
/// 短命 session，让同一次多页读取从同一快照切片，而不是每页重解析。
/// </summary>
internal static class EmevdDocumentSessionCache
{
    private const int Capacity = 4;
    private const long MaxBytes = 96L * 1024 * 1024;
    private const int SessionCapacity = 8;
    // 超大文档分页可能跨越数分钟（850k 指令的 VerifyRoundTrip 就可能超过 60s）。
    // 60s TTL 会让「可保留 session」在下一页到达前过期，退回重解析。
    private const long SessionTtlMs = 600_000;
    internal const string TestHooksEnv = "SOULFORGE_EMEVD_CACHE_TEST_HOOKS";

    internal enum CachePolicy
    {
        Default,
        Bypass
    }

    internal sealed record Entry(
        EmevdNativeDocument Document,
        EmevdRoundTripReport RoundTrip,
        string SourceFormat,
        string? OuterFileHash);

    internal readonly record struct Observation(
        string State,
        long Hits,
        long Misses,
        long Loads,
        long Coalesced,
        long Bypasses,
        long Oversized,
        long CancelledLoads,
        int PeakConcurrentLoads,
        long SessionsIssued,
        long SessionHits);

    internal sealed record Lookup(Entry Entry, Observation Observation, string? SessionToken);

    internal sealed class TestHooks
    {
        internal string? HoldUntilFile;
        internal string? RewriteAfterRead;
        internal string? CompletedFile;
        internal string? SignalFile;
    }

    private readonly record struct Key(string Path, string FileHash, string OodleRoot);

    private readonly record struct PathKey(string Path, string OodleRoot);

    internal enum SessionLookupKind
    {
        Hit,
        Miss,
        Mismatch
    }

    private sealed class Inflight
    {
        internal readonly TaskCompletionSource<Entry> Completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly CancellationTokenSource SharedCts = new();
        internal int Waiters;
        internal Task? Run;
        internal string PublishState = "loaded";
        internal string? SessionToken;
        internal PathKey PathKey;
    }

    private sealed class Slot
    {
        internal Inflight? Inflight { get; set; }
        internal Entry? Ready { get; set; }
        internal long EstimatedBytes { get; set; }
        internal long Tick { get; set; }
    }

    private sealed class Session
    {
        internal required string Token { get; init; }
        internal required Entry Entry { get; init; }
        internal required long EstimatedBytes { get; init; }
        internal required string Path { get; init; }
        internal required string FileHash { get; init; }
        internal required string OodleRoot { get; init; }
        internal long LastAccessMs { get; set; }
    }

    private static readonly Dictionary<Key, Slot> Cache = new();
    private static readonly Dictionary<PathKey, Inflight> PathInflight = new();
    private static readonly Dictionary<string, Session> Sessions = new(StringComparer.Ordinal);
    private static readonly Dictionary<Key, string> SessionByKey = new();
    private static readonly object Gate = new();
    private static long tickCounter;

    private static long hits;
    private static long misses;
    private static long loads;
    private static long coalesced;
    private static long bypasses;
    private static long oversized;
    private static long cancelledLoads;
    private static long sessionsIssued;
    private static long sessionHits;
    private static int concurrentLoads;
    private static int peakConcurrentLoads;

    // Read-count diagnostics are deliberately kept beside the active session
    // cache.  EmevdDocumentCache was the pre-session implementation and is no
    // longer on the production read path; keeping its counters there made the
    // reportReadCounts smoke observe an always-empty/dead cache.
    internal static long DcxReadCount;
    internal static long EmevdReadCount;

    internal static void RecordDcxRead() => Interlocked.Increment(ref DcxReadCount);

    internal static void RecordEmevdRead() => Interlocked.Increment(ref EmevdReadCount);

    internal static bool TestHooksEnabled =>
        string.Equals(Environment.GetEnvironmentVariable(TestHooksEnv), "1", StringComparison.Ordinal);

    private static Observation SnapshotLocked(string state) => new(
        state,
        hits,
        misses,
        loads,
        coalesced,
        bypasses,
        oversized,
        cancelledLoads,
        Volatile.Read(ref peakConcurrentLoads),
        sessionsIssued,
        sessionHits);

    private static Observation Snapshot(string state)
    {
        lock (Gate) return SnapshotLocked(state);
    }

    internal static SessionLookupKind TryGetSession(
        string token,
        string file,
        string? oodleRuntimeRoot,
        out Lookup lookup)
    {
        lookup = null!;
        if (string.IsNullOrWhiteSpace(token)) return SessionLookupKind.Miss;
        string canonical;
        try { canonical = Path.GetFullPath(file); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException)
        {
            return SessionLookupKind.Miss;
        }
        var oodleRoot = NormalizeRoot(oodleRuntimeRoot);
        lock (Gate)
        {
            EvictExpiredSessionsLocked();
            if (!Sessions.TryGetValue(token, out var session)) return SessionLookupKind.Miss;
            if (!string.Equals(session.Path, canonical, StringComparison.Ordinal)
                || !string.Equals(session.OodleRoot, oodleRoot, StringComparison.Ordinal))
            {
                return SessionLookupKind.Mismatch;
            }
            session.LastAccessMs = Environment.TickCount64;
            sessionHits++;
            lookup = new Lookup(session.Entry, SnapshotLocked("session"), session.Token);
            return SessionLookupKind.Hit;
        }
    }

    internal static async Task<Lookup> GetOrAddAsync(
        string file,
        string? oodleRuntimeRoot,
        Func<byte[], CancellationToken, Entry> parseFromBytes,
        CachePolicy policy = CachePolicy.Default,
        CancellationToken cancellationToken = default,
        TestHooks? testHooks = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var hooks = TestHooksEnabled ? testHooks : null;
        var oodleRoot = NormalizeRoot(oodleRuntimeRoot);
        string canonicalPath;
        try
        {
            canonicalPath = Path.GetFullPath(file);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException)
        {
            lock (Gate)
            {
                misses++;
            }
            var unkeyed = await Task.Run(
                () => ParseTrackedAsync(file, parseFromBytes, cancellationToken, hooks),
                CancellationToken.None).ConfigureAwait(false);
            return new Lookup(unkeyed, Snapshot("unkeyed"), null);
        }

        var pathKey = new PathKey(canonicalPath, oodleRoot);
        Inflight inflight;
        bool owner;
        lock (Gate)
        {
            if (PathInflight.TryGetValue(pathKey, out var existing))
            {
                misses++;
                coalesced++;
                existing.Waiters++;
                inflight = existing;
                owner = false;
            }
            else
            {
                misses++;
                if (policy == CachePolicy.Bypass)
                {
                    bypasses++;
                    RemoveByPath(canonicalPath);
                }
                inflight = new Inflight { Waiters = 1, PathKey = pathKey };
                PathInflight[pathKey] = inflight;
                owner = true;
            }
        }

        if (owner)
        {
            // 必须投递到线程池：无 hold 时 HoldIfRequested 的 await 同步完成，
            // 若在请求线程上启动，CPU 解析会在 WaitAsync 之前跑完，取消无效。
            inflight.Run = Task.Run(
                () => RunLoadAsync(file, pathKey, inflight, parseFromBytes, policy, hooks),
                CancellationToken.None);
        }

        SignalJoined(hooks, owner);
        try
        {
            var entry = await inflight.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            OnWaiterLeft(pathKey, inflight, false);
            var state = inflight.PublishState;
            if (policy == CachePolicy.Bypass && owner) state = "bypass";
            else if (!owner && state == "loaded") state = "coalesced";
            return new Lookup(entry, Snapshot(state), inflight.SessionToken);
        }
        catch (Exception ex)
        {
            OnWaiterLeft(pathKey, inflight, ex is OperationCanceledException && cancellationToken.IsCancellationRequested);
            throw;
        }
    }

    private static async Task RunLoadAsync(
        string file,
        PathKey pathKey,
        Inflight inflight,
        Func<byte[], CancellationToken, Entry> parseFromBytes,
        CachePolicy policy,
        TestHooks? hooks)
    {
        var shared = inflight.SharedCts.Token;
        Key? publishedKey = null;
        Slot? slot = null;
        try
        {
            await HoldIfRequestedAsync(hooks, shared).ConfigureAwait(false);
            shared.ThrowIfCancellationRequested();
            var snapshot = ReadConsistentSnapshot(file, hooks);
            var key = new Key(pathKey.Path, snapshot.Hash, pathKey.OodleRoot);
            lock (Gate)
            {
                if (policy != CachePolicy.Bypass
                    && Cache.TryGetValue(key, out var cached) && cached.Ready is { } ready)
                {
                    cached.Tick = ++tickCounter;
                    hits++;
                    inflight.PublishState = "hit";
                    inflight.SessionToken = IssueSessionLocked(ready, key);
                    inflight.Completion.TrySetResult(ready);
                    return;
                }
                slot = new Slot { Inflight = inflight, Tick = ++tickCounter };
                Cache[key] = slot;
                publishedKey = key;
            }
            var entry = TrackedLoad(() => parseFromBytes(snapshot.Bytes, shared));
            WriteCompleted(hooks);
            if (!TryPublish(key, slot, inflight, entry, policy))
            {
                inflight.Completion.TrySetCanceled(shared);
                return;
            }
            inflight.SessionToken = IssueSession(entry, key);
            inflight.Completion.TrySetResult(entry);
        }
        catch (Exception ex)
        {
            lock (Gate)
            {
                if (publishedKey is { } doomed
                    && Cache.TryGetValue(doomed, out var current)
                    && slot is not null
                    && ReferenceEquals(current, slot))
                {
                    Cache.Remove(doomed);
                }
                if (ex is OperationCanceledException) cancelledLoads++;
            }
            if (ex is OperationCanceledException oce)
            {
                inflight.Completion.TrySetCanceled(oce.CancellationToken);
            }
            else
            {
                inflight.Completion.TrySetException(ex);
            }
        }
        finally
        {
            lock (Gate)
            {
                if (PathInflight.TryGetValue(pathKey, out var current) && ReferenceEquals(current, inflight))
                {
                    PathInflight.Remove(pathKey);
                }
            }
            inflight.SharedCts.Dispose();
        }
    }

    private static bool TryPublish(Key key, Slot slot, Inflight inflight, Entry entry, CachePolicy policy)
    {
        var estimated = EstimateBytes(entry.Document);
        lock (Gate)
        {
            if (!Cache.TryGetValue(key, out var current) || !ReferenceEquals(current, slot))
            {
                cancelledLoads++;
                return false;
            }
            if (inflight.Waiters <= 0 || inflight.SharedCts.IsCancellationRequested)
            {
                Cache.Remove(key);
                cancelledLoads++;
                return false;
            }
            slot.EstimatedBytes = estimated;
            slot.Inflight = null;
            if (policy == CachePolicy.Bypass)
            {
                Cache.Remove(key);
                inflight.PublishState = "bypass";
                return true;
            }
            slot.Ready = entry;
            if (!EvictWhileOverBudget(key))
            {
                Cache.Remove(key);
                oversized++;
                inflight.PublishState = "oversize";
            }
            else
            {
                inflight.PublishState = "loaded";
            }
            return true;
        }
    }

    private static void OnWaiterLeft(PathKey pathKey, Inflight inflight, bool _)
    {
        lock (Gate)
        {
            inflight.Waiters--;
            if (inflight.Waiters > 0) return;
            if (inflight.Completion.Task.IsCompletedSuccessfully) return;
            try { inflight.SharedCts.Cancel(); }
            catch (ObjectDisposedException) { }
            if (PathInflight.TryGetValue(pathKey, out var current) && ReferenceEquals(current, inflight))
            {
                PathInflight.Remove(pathKey);
            }
        }
    }

    private static async Task<Entry> ParseTrackedAsync(
        string file,
        Func<byte[], CancellationToken, Entry> parseFromBytes,
        CancellationToken cancellationToken,
        TestHooks? hooks)
    {
        var snapshot = ReadSnapshot(file);
        ApplyRewriteAfterRead(file, hooks);
        return await ParseTrackedAsync(file, parseFromBytes, snapshot.Bytes, cancellationToken, hooks)
            .ConfigureAwait(false);
    }

    private static async Task<Entry> ParseTrackedAsync(
        string file,
        Func<byte[], CancellationToken, Entry> parseFromBytes,
        byte[] bytes,
        CancellationToken cancellationToken,
        TestHooks? hooks)
    {
        await HoldIfRequestedAsync(hooks, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        var entry = TrackedLoad(() => parseFromBytes(bytes, cancellationToken));
        WriteCompleted(hooks);
        return entry;
    }

    private readonly record struct FileSnapshot(byte[] Bytes, string Hash);

    private static FileSnapshot ReadConsistentSnapshot(string file, TestHooks? hooks)
    {
        var first = ReadSnapshot(file);
        ApplyRewriteAfterRead(file, hooks);
        if (hooks?.RewriteAfterRead is { Length: > 0 }) return first;
        const int attempts = 3;
        for (var attempt = 1; attempt <= attempts; attempt += 1)
        {
            var second = ReadSnapshot(file);
            if (second.Hash == first.Hash) return second;
            first = second;
        }
        throw new IOException("EMEVD 源文件在读取期间被改写，无法得到一致快照。");
    }

    private static FileSnapshot ReadSnapshot(string file)
    {
        const int attempts = 5;
        for (var attempt = 1; ; attempt += 1)
        {
            try
            {
                using var stream = new FileStream(
                    file,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite,
                    bufferSize: 1024 * 1024,
                    FileOptions.SequentialScan);
                if (stream.Length <= 0 || stream.Length > int.MaxValue)
                    throw new InvalidDataException($"EMEVD 快照大小 {stream.Length} 超出安全范围。");
                var bytes = new byte[stream.Length];
                var read = 0;
                while (read < bytes.Length)
                {
                    var n = stream.Read(bytes, read, bytes.Length - read);
                    if (n <= 0) throw new EndOfStreamException("读取 EMEVD 快照时文件被截断。");
                    read += n;
                }
                var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                return new FileSnapshot(bytes, hash);
            }
            catch (IOException) when (attempt < attempts)
            {
                Thread.Sleep(5 * attempt);
            }
        }
    }

    private static void ApplyRewriteAfterRead(string file, TestHooks? hooks)
    {
        if (hooks?.RewriteAfterRead is not { Length: > 0 } rewrite) return;
        File.Copy(rewrite, file, overwrite: true);
    }

    private static async Task HoldIfRequestedAsync(TestHooks? hooks, CancellationToken cancellationToken)
    {
        if (hooks?.HoldUntilFile is not { Length: > 0 } gate) return;
        if (hooks.SignalFile is { Length: > 0 } held)
        {
            AppendAllTextRetry(held, "held\n");
        }
        while (!File.Exists(gate))
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(5, cancellationToken).ConfigureAwait(false);
        }
    }

    private static void SignalJoined(TestHooks? hooks, bool owner)
    {
        if (hooks?.SignalFile is not { Length: > 0 } path) return;
        AppendAllTextRetry(path, owner ? "owner\n" : "waiter\n");
    }

    private static void WriteCompleted(TestHooks? hooks)
    {
        if (hooks?.CompletedFile is not { Length: > 0 } path) return;
        WriteAllTextRetry(path, "completed");
    }

    private static void AppendAllTextRetry(string path, string contents)
    {
        const int attempts = 8;
        for (var attempt = 1; ; attempt += 1)
        {
            try
            {
                File.AppendAllText(path, contents);
                return;
            }
            catch (IOException) when (attempt < attempts)
            {
                Thread.Sleep(5 * attempt);
            }
        }
    }

    private static void WriteAllTextRetry(string path, string contents)
    {
        const int attempts = 8;
        for (var attempt = 1; ; attempt += 1)
        {
            try
            {
                File.WriteAllText(path, contents);
                return;
            }
            catch (IOException) when (attempt < attempts)
            {
                Thread.Sleep(5 * attempt);
            }
        }
    }

    private static string? IssueSession(Entry entry, Key key)
    {
        lock (Gate) return IssueSessionLocked(entry, key);
    }

    private static string? IssueSessionLocked(Entry entry, Key key)
    {
        EvictExpiredSessionsLocked();
        if (SessionByKey.TryGetValue(key, out var existingToken)
            && Sessions.ContainsKey(existingToken))
        {
            Sessions[existingToken] = new Session
            {
                Token = existingToken,
                Entry = entry,
                EstimatedBytes = EstimateBytes(entry.Document),
                Path = key.Path,
                FileHash = key.FileHash,
                OodleRoot = key.OodleRoot,
                LastAccessMs = Environment.TickCount64
            };
            return existingToken;
        }
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var estimated = EstimateBytes(entry.Document);
        RememberSessionLocked(token, new Session
        {
            Token = token,
            Entry = entry,
            EstimatedBytes = estimated,
            Path = key.Path,
            FileHash = key.FileHash,
            OodleRoot = key.OodleRoot,
            LastAccessMs = Environment.TickCount64
        }, key);
        sessionsIssued++;
        EvictSessionsOverBudgetLocked(token);
        if (!Sessions.ContainsKey(token))
        {
            // 超预算也不能返回已经淘汰的 token。单条就装不下时保留这一条。
            RememberSessionLocked(token, new Session
            {
                Token = token,
                Entry = entry,
                EstimatedBytes = estimated,
                Path = key.Path,
                FileHash = key.FileHash,
                OodleRoot = key.OodleRoot,
                LastAccessMs = Environment.TickCount64
            }, key);
        }
        return token;
    }

    private static void RememberSessionLocked(string token, Session session, Key key)
    {
        Sessions[token] = session;
        SessionByKey[key] = token;
    }

    private static void RemoveSessionLocked(string token)
    {
        if (!Sessions.Remove(token, out var session)) return;
        var key = new Key(session.Path, session.FileHash, session.OodleRoot);
        if (SessionByKey.TryGetValue(key, out var mapped) && mapped == token)
        {
            SessionByKey.Remove(key);
        }
    }

    private static void EvictExpiredSessionsLocked()
    {
        var now = Environment.TickCount64;
        var doomed = new List<string>();
        foreach (var pair in Sessions)
        {
            if (now - pair.Value.LastAccessMs > SessionTtlMs) doomed.Add(pair.Key);
        }
        foreach (var token in doomed) RemoveSessionLocked(token);
    }

    private static void EvictSessionsOverBudgetLocked(string? protectedToken = null)
    {
        while (Sessions.Count > SessionCapacity)
        {
            if (!TryFindOldestSession(protectedToken, out var oldest) || oldest is null) break;
            RemoveSessionLocked(oldest);
        }
        while (true)
        {
            long total = 0;
            foreach (var session in Sessions.Values) total += session.EstimatedBytes;
            if (total <= MaxBytes) return;
            if (!TryFindOldestSession(protectedToken, out var oldest) || oldest is null) return;
            RemoveSessionLocked(oldest);
        }
    }

    private static bool TryFindOldestSession(string? protectedToken, out string? oldest)
    {
        oldest = null;
        var oldestTick = long.MaxValue;
        foreach (var pair in Sessions)
        {
            if (protectedToken is not null && pair.Key == protectedToken) continue;
            if (pair.Value.LastAccessMs >= oldestTick) continue;
            oldestTick = pair.Value.LastAccessMs;
            oldest = pair.Key;
        }
        return oldest is not null;
    }

    private static Entry TrackedLoad(Func<Entry> load)
    {
        Interlocked.Increment(ref loads);
        var current = Interlocked.Increment(ref concurrentLoads);
        try
        {
            var observed = Volatile.Read(ref peakConcurrentLoads);
            while (current > observed)
            {
                var witnessed = Interlocked.CompareExchange(ref peakConcurrentLoads, current, observed);
                if (witnessed == observed) break;
                observed = witnessed;
            }
            return load();
        }
        finally
        {
            Interlocked.Decrement(ref concurrentLoads);
        }
    }

    private static bool EvictWhileOverBudget(Key protectedKey)
    {
        while (true)
        {
            var readyCount = 0;
            long totalBytes = 0;
            var oldestKey = default(Key);
            var oldestTick = long.MaxValue;
            var found = false;
            foreach (var pair in Cache)
            {
                if (pair.Value.Ready is null) continue;
                readyCount++;
                totalBytes += pair.Value.EstimatedBytes;
                if (pair.Key.Equals(protectedKey)) continue;
                if (pair.Value.Tick >= oldestTick) continue;
                oldestTick = pair.Value.Tick;
                oldestKey = pair.Key;
                found = true;
            }
            if (readyCount <= Capacity && totalBytes <= MaxBytes) return true;
            if (!found) return false;
            Cache.Remove(oldestKey);
        }
    }

    private static void RemoveByPath(string canonicalPath)
    {
        var doomed = new List<Key>();
        foreach (var pair in Cache)
        {
            if (string.Equals(pair.Key.Path, canonicalPath, StringComparison.OrdinalIgnoreCase))
            {
                doomed.Add(pair.Key);
            }
        }
        foreach (var key in doomed) Cache.Remove(key);
    }

    private static long EstimateBytes(EmevdNativeDocument document)
    {
        long total = document.SourceBytes.LongLength;
        foreach (var instruction in document.Instructions)
        {
            total += 64 + 24 + instruction.Args.LongLength;
        }
        total += document.Events.Count * 64L;
        return total;
    }

    private static string NormalizeRoot(string? oodleRuntimeRoot)
    {
        if (string.IsNullOrWhiteSpace(oodleRuntimeRoot)) return string.Empty;
        try
        {
            return Path.GetFullPath(oodleRuntimeRoot);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException)
        {
            return oodleRuntimeRoot;
        }
    }

    internal static void Reset()
    {
        lock (Gate)
        {
            Cache.Clear();
            PathInflight.Clear();
            Sessions.Clear();
            SessionByKey.Clear();
            hits = 0;
            misses = 0;
            loads = 0;
            coalesced = 0;
            bypasses = 0;
            oversized = 0;
            cancelledLoads = 0;
            sessionsIssued = 0;
            sessionHits = 0;
            DcxReadCount = 0;
            EmevdReadCount = 0;
            tickCounter = 0;
            Volatile.Write(ref concurrentLoads, 0);
            Volatile.Write(ref peakConcurrentLoads, 0);
        }
    }
}

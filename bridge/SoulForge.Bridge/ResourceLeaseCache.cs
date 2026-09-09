/// <summary>
/// Daemon-owned resource cache with one build per key and leases for callers.
///
/// The cache deliberately keeps all expensive work outside <see cref="gate"/>:
/// the lock only protects identity lookup, state publication, lease counts and
/// byte accounting.  A cancelled subscriber therefore cannot cancel a build
/// that still has another subscriber, while the last subscriber can request
/// cancellation without allowing a second build for the same key to start.
/// </summary>
internal sealed class ResourceLeaseCache<T> : IDisposable
{
    internal sealed record Options(
        long ReadyByteBudget = 256L * 1024 * 1024,
        long InFlightByteBudget = 128L * 1024 * 1024,
        int MaxConcurrentBuilds = 2);

    internal readonly record struct BuildResult(T Value, long ResidentBytes);

    internal readonly record struct Observation(
        string State,
        long Hits,
        long Misses,
        long Builds,
        long Coalesced,
        long CancelledBuilds,
        long ReadyBytes,
        long InFlightBytes,
        int EntryCount,
        int QuarantinedCount,
        int PeakConcurrentBuilds,
        long Generation);

    internal sealed class Lease : IDisposable
    {
        private ResourceLeaseCache<T>? owner;
        private Entry? entry;

        internal Lease(ResourceLeaseCache<T> owner, Entry entry)
        {
            this.owner = owner;
            this.entry = entry;
        }

        internal T Value => entry is { ValueSet: true } current
            ? current.Value!
            : throw new ObjectDisposedException(nameof(Lease));

        internal string Key => entry?.Key ?? string.Empty;
        internal long Generation => entry?.Generation ?? 0;

        public void Dispose()
        {
            var currentOwner = Interlocked.Exchange(ref owner, null);
            var currentEntry = Interlocked.Exchange(ref entry, null);
            if (currentOwner is not null && currentEntry is not null)
                currentOwner.Release(currentEntry);
        }
    }

    internal sealed class Entry
    {
        internal required string Key;
        internal required long Generation;
        internal required CancellationTokenSource BuildCancellation;
        internal required TaskCompletionSource<BuildResult> Completion;
        internal required Func<T, ValueTask> DisposeAsync;
        internal ResourceLeaseCacheState State;
        internal long ReservedBytes;
        internal long ResidentBytes;
        internal long LastUsedSequence;
        internal int LeaseCount;
        internal bool Settled;
        internal bool ValueSet;
        internal bool Retired;
        internal T? Value;
    }

    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Entry> quarantined = new(StringComparer.Ordinal);
    private readonly HashSet<Entry> retired = new();
    private readonly SemaphoreSlim buildSlots;
    private readonly long readyByteBudget;
    private readonly long inFlightByteBudget;
    private readonly Func<T, ValueTask> defaultDisposeAsync;

    private long generation = 1;
    private long sequence;
    private long readyBytes;
    private long inFlightBytes;
    private long hits;
    private long misses;
    private long builds;
    private long coalesced;
    private long cancelledBuilds;
    private int concurrentBuilds;
    private int peakConcurrentBuilds;
    private bool disposed;

    internal ResourceLeaseCache(Options? options = null, Func<T, ValueTask>? disposeAsync = null)
    {
        var selected = options ?? new Options();
        if (selected.ReadyByteBudget <= 0) throw new ArgumentOutOfRangeException(nameof(options));
        if (selected.InFlightByteBudget <= 0) throw new ArgumentOutOfRangeException(nameof(options));
        if (selected.MaxConcurrentBuilds <= 0) throw new ArgumentOutOfRangeException(nameof(options));

        readyByteBudget = selected.ReadyByteBudget;
        inFlightByteBudget = selected.InFlightByteBudget;
        buildSlots = new SemaphoreSlim(selected.MaxConcurrentBuilds, selected.MaxConcurrentBuilds);
        defaultDisposeAsync = disposeAsync ?? ((_) => ValueTask.CompletedTask);
    }

    internal long Generation
    {
        get
        {
            lock (gate) return generation;
        }
    }

    internal async Task<Lease> AcquireAsync(
        string key,
        long reservationBytes,
        long expectedGeneration,
        Func<CancellationToken, ValueTask<BuildResult>> builder,
        Func<T, ValueTask>? disposeAsync = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(key))
            throw new ResourceLeaseCacheException("CACHE_KEY_REQUIRED", "resource cache key is required");
        if (reservationBytes <= 0)
            throw new ResourceLeaseCacheException("CACHE_RESERVATION_INVALID", "in-flight reservation must be positive");
        ArgumentNullException.ThrowIfNull(builder);
        cancellationToken.ThrowIfCancellationRequested();

        Entry entry;
        var owner = false;
        lock (gate)
        {
            ThrowIfDisposedLocked();
            if (expectedGeneration != generation)
                throw new ResourceLeaseCacheException("CACHE_GENERATION_STALE", "resource generation is no longer current");
            if (quarantined.ContainsKey(key))
                throw new ResourceLeaseCacheException("CACHE_KEY_QUARANTINED", "resource key is quarantined after a failed dispose");

            if (entries.TryGetValue(key, out var existing))
            {
                if (existing.Generation != generation || existing.Retired)
                    throw new ResourceLeaseCacheException("CACHE_GENERATION_STALE", "resource entry belongs to an old generation");

                if (existing.State == ResourceLeaseCacheState.Ready && existing.ValueSet)
                {
                    existing.LeaseCount++;
                    existing.LastUsedSequence = ++sequence;
                    hits++;
                    return new Lease(this, existing);
                }

                if (existing.State == ResourceLeaseCacheState.Building)
                {
                    existing.LeaseCount++;
                    existing.LastUsedSequence = ++sequence;
                    coalesced++;
                    entry = existing;
                    goto waitForBuild;
                }

                if (existing.State == ResourceLeaseCacheState.Cancelling)
                    throw new ResourceLeaseCacheException("BUILD_CANCELLING", "same-key build is cancelling and remains reserved until it settles");
                if (existing.State == ResourceLeaseCacheState.Evicting)
                    throw new ResourceLeaseCacheException("CACHE_EVICTING", "same-key resource is being disposed");
                throw new ResourceLeaseCacheException("CACHE_ENTRY_UNAVAILABLE", $"resource entry is in state {existing.State}");
            }

            if (reservationBytes > inFlightByteBudget)
                throw new ResourceLeaseCacheException("CACHE_ITEM_TOO_LARGE", "in-flight reservation exceeds the configured budget");
            if (inFlightBytes > inFlightByteBudget - reservationBytes)
                throw new ResourceLeaseCacheException("CACHE_INFLIGHT_BACKPRESSURE", "in-flight byte budget is pinned by other builds");

            entry = new Entry
            {
                Key = key,
                Generation = generation,
                BuildCancellation = new CancellationTokenSource(),
                Completion = new TaskCompletionSource<BuildResult>(TaskCreationOptions.RunContinuationsAsynchronously),
                DisposeAsync = disposeAsync ?? defaultDisposeAsync,
                State = ResourceLeaseCacheState.Building,
                ReservedBytes = reservationBytes,
                LeaseCount = 1,
                LastUsedSequence = ++sequence
            };
            entries.Add(key, entry);
            inFlightBytes += reservationBytes;
            misses++;
            owner = true;

        waitForBuild:;
        }

        if (owner)
        {
            // Do not let a synchronously completing builder run on the request
            // thread.  The task is also what keeps the cache lock short for
            // builders that perform synchronous native decoding before their
            // first await.
            _ = Task.Run(() => RunBuildAsync(entry, builder), CancellationToken.None);
        }

        return await AwaitBuildAsync(entry, cancellationToken).ConfigureAwait(false);
    }

    internal Observation Snapshot()
    {
        lock (gate)
        {
            var state = disposed
                ? ResourceLeaseCacheState.Disposed.ToString().ToLowerInvariant()
                : entries.Values.Select(item => (ResourceLeaseCacheState?)item.State).Distinct().OrderBy(item => item).FirstOrDefault()?.ToString().ToLowerInvariant()
                    ?? (quarantined.Count > 0 ? ResourceLeaseCacheState.Quarantined.ToString().ToLowerInvariant() : "empty");
            return new Observation(
                state,
                hits,
                misses,
                builds,
                coalesced,
                cancelledBuilds,
                readyBytes,
                inFlightBytes,
                entries.Count,
                quarantined.Count,
                peakConcurrentBuilds,
                generation);
        }
    }

    /// <summary>
    /// Retire all entries from the current generation.  A late builder can
    /// finish, but it cannot publish into the new generation.
    /// </summary>
    internal async Task InvalidateGenerationAsync()
    {
        List<Entry> disposeNow;
        List<CancellationTokenSource> cancel;
        lock (gate)
        {
            if (disposed) return;
            generation++;
            disposeNow = new List<Entry>();
            cancel = new List<CancellationTokenSource>();
            foreach (var entry in entries.Values.ToArray())
            {
                if (entry.State == ResourceLeaseCacheState.Building)
                {
                    entry.State = ResourceLeaseCacheState.Cancelling;
                    cancel.Add(entry.BuildCancellation);
                    continue;
                }
                if (entry.State != ResourceLeaseCacheState.Ready) continue;

                entries.Remove(entry.Key);
                entry.Retired = true;
                if (entry.LeaseCount == 0)
                {
                    entry.State = ResourceLeaseCacheState.Evicting;
                    disposeNow.Add(entry);
                }
                else
                {
                    // A generation change makes the value unpublishable, but
                    // an existing lease still owns it until release.
                    entry.State = ResourceLeaseCacheState.Evicting;
                    retired.Add(entry);
                }
            }
        }

        foreach (var source in cancel) CancelNoThrow(source);
        await DisposeEntriesAsync(disposeNow).ConfigureAwait(false);
    }

    internal async Task RetryQuarantinedAsync(string key)
    {
        Entry? entry;
        lock (gate)
        {
            if (!quarantined.TryGetValue(key, out entry)) return;
            entry.State = ResourceLeaseCacheState.Evicting;
            // Keep the quarantine marker and add an evicting identity tombstone
            // until disposal succeeds; a retry must not race a new build for
            // the same native value.
            entries[key] = entry;
        }
        await DisposeEntriesAsync(new List<Entry> { entry }).ConfigureAwait(false);
    }

    public void Dispose()
    {
        DisposeAsync().GetAwaiter().GetResult();
        GC.SuppressFinalize(this);
    }

    private async Task DisposeAsync()
    {
        List<Entry> disposeNow;
        List<CancellationTokenSource> cancel;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            generation++;
            disposeNow = new List<Entry>();
            cancel = new List<CancellationTokenSource>();
            foreach (var entry in entries.Values.ToArray())
            {
                entries.Remove(entry.Key);
                entry.Retired = true;
                if (entry.State == ResourceLeaseCacheState.Building)
                {
                    entry.State = ResourceLeaseCacheState.Cancelling;
                    cancel.Add(entry.BuildCancellation);
                    continue;
                }
                if (entry.State == ResourceLeaseCacheState.Ready
                    && entry.ValueSet
                    && entry.LeaseCount == 0)
                {
                    entry.State = ResourceLeaseCacheState.Evicting;
                    disposeNow.Add(entry);
                }
                else if (entry.State == ResourceLeaseCacheState.Ready && entry.ValueSet)
                {
                    entry.State = ResourceLeaseCacheState.Evicting;
                    retired.Add(entry);
                }
            }
            foreach (var entry in retired.ToArray())
            {
                retired.Remove(entry);
                if (entry.ValueSet && entry.LeaseCount == 0)
                {
                    entry.State = ResourceLeaseCacheState.Evicting;
                    disposeNow.Add(entry);
                }
                else if (entry.ValueSet)
                {
                    // An active lease owns the value until it is released. The
                    // cache must not dispose underneath that caller.
                    retired.Add(entry);
                }
            }
            foreach (var entry in quarantined.Values)
            {
                if (entry.ValueSet) disposeNow.Add(entry);
            }
            quarantined.Clear();
            inFlightBytes = 0;
        }

        foreach (var source in cancel) CancelNoThrow(source);
        await DisposeEntriesAsync(disposeNow).ConfigureAwait(false);
        buildSlots.Dispose();
    }

    private async Task<Lease> AwaitBuildAsync(Entry entry, CancellationToken cancellationToken)
    {
        try
        {
            await entry.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            lock (gate)
            {
                if (entry.State != ResourceLeaseCacheState.Ready || !entry.ValueSet)
                    throw new ResourceLeaseCacheException("CACHE_ENTRY_UNAVAILABLE", "build completed without a ready resource");
                return new Lease(this, entry);
            }
        }
        catch
        {
            CancelSubscriber(entry);
            throw;
        }
    }

    private async Task RunBuildAsync(Entry entry, Func<CancellationToken, ValueTask<BuildResult>> builder)
    {
        var slotHeld = false;
        try
        {
            await buildSlots.WaitAsync(entry.BuildCancellation.Token).ConfigureAwait(false);
            slotHeld = true;
            var active = Interlocked.Increment(ref concurrentBuilds);
            UpdatePeak(active);
            Interlocked.Increment(ref builds);

            var result = await builder(entry.BuildCancellation.Token).ConfigureAwait(false);
            if (result.ResidentBytes <= 0)
                throw new ResourceLeaseCacheException("CACHE_RESIDENT_BYTES_INVALID", "resource resident byte count must be positive");
            if (result.ResidentBytes > readyByteBudget)
                throw new ResourceLeaseCacheException("CACHE_ITEM_TOO_LARGE", "resource exceeds ready byte budget");

            await PublishAsync(entry, result).ConfigureAwait(false);
        }
        catch (OperationCanceledException ex)
        {
            lock (gate) cancelledBuilds++;
            CompleteFailure(entry, ex, cancelled: true);
        }
        catch (Exception ex)
        {
            CompleteFailure(entry, ex, cancelled: false);
        }
        finally
        {
            if (slotHeld)
            {
                Interlocked.Decrement(ref concurrentBuilds);
                try { buildSlots.Release(); } catch (ObjectDisposedException) { }
            }
            entry.BuildCancellation.Dispose();
        }
    }

    private async Task PublishAsync(Entry entry, BuildResult result)
    {
        List<Entry> evictions;
        ResourceLeaseCacheException? preparationError = null;
        lock (gate)
        {
            if (!CanPublishLocked(entry))
            {
                preparationError = new ResourceLeaseCacheException("CACHE_GENERATION_STALE", "late build cannot publish into the current generation");
                evictions = new List<Entry>();
            }
            else
            {
                evictions = SelectEvictionsLocked(result.ResidentBytes, entry.Key);
                if (evictions is null)
                {
                    preparationError = new ResourceLeaseCacheException("CACHE_BUDGET_PINNED", "ready byte budget is pinned by leased resources");
                    evictions = new List<Entry>();
                }
            }
        }

        if (preparationError is not null)
        {
            await DisposeValueAsync(entry, result.Value).ConfigureAwait(false);
            CompleteFailure(entry, preparationError, cancelled: false);
            return;
        }

        await DisposeEntriesAsync(evictions).ConfigureAwait(false);

        var publish = false;
        ResourceLeaseCacheException? publishError = null;
        lock (gate)
        {
            if (!CanPublishLocked(entry))
            {
                publishError = new ResourceLeaseCacheException("CACHE_GENERATION_STALE", "late build cannot publish after eviction work");
            }
            else if (readyBytes > readyByteBudget - result.ResidentBytes)
            {
                publishError = new ResourceLeaseCacheException("CACHE_DISPOSAL_INCOMPLETE", "dispose did not reclaim enough resident bytes");
            }
            else
            {
                entry.Value = result.Value;
                entry.ValueSet = true;
                entry.ResidentBytes = result.ResidentBytes;
                entry.State = ResourceLeaseCacheState.Ready;
                entry.LastUsedSequence = ++sequence;
                readyBytes += result.ResidentBytes;
                ReleaseReservationLocked(entry);
                entry.Settled = true;
                entry.Completion.TrySetResult(result);
                publish = true;
            }
        }

        if (!publish)
        {
            await DisposeValueAsync(entry, result.Value).ConfigureAwait(false);
            CompleteFailure(entry, publishError ?? new ResourceLeaseCacheException("CACHE_PUBLISH_FAILED", "resource could not be published"), cancelled: false);
        }
    }

    private List<Entry>? SelectEvictionsLocked(long requiredBytes, string protectedKey)
    {
        if (readyBytes <= readyByteBudget - requiredBytes) return new List<Entry>();

        var candidates = entries.Values
            .Where(item => item.Key != protectedKey
                && item.State == ResourceLeaseCacheState.Ready
                && item.LeaseCount == 0
                && item.ValueSet
                && !item.Retired)
            .OrderBy(item => item.LastUsedSequence)
            .ToArray();
        var reclaimable = 0L;
        var selected = new List<Entry>();
        foreach (var candidate in candidates)
        {
            selected.Add(candidate);
            reclaimable = checked(reclaimable + candidate.ResidentBytes);
            if (readyBytes <= readyByteBudget - requiredBytes + reclaimable) break;
        }
        if (readyBytes > readyByteBudget - requiredBytes + reclaimable) return null;

        foreach (var candidate in selected)
        {
            // Keep an evicting tombstone in the identity map until disposal is
            // confirmed. Otherwise a same-key request could start a second
            // build while the old native value is still being destroyed.
            candidate.State = ResourceLeaseCacheState.Evicting;
        }
        return selected;
    }

    private async Task DisposeEntriesAsync(IReadOnlyList<Entry> doomed)
    {
        foreach (var entry in doomed)
        {
            if (!entry.ValueSet) continue;
            try
            {
                await entry.DisposeAsync(entry.Value!).ConfigureAwait(false);
                lock (gate)
                {
                    if (entries.TryGetValue(entry.Key, out var current)
                        && ReferenceEquals(current, entry))
                        entries.Remove(entry.Key);
                    quarantined.Remove(entry.Key);
                    readyBytes = Math.Max(0, readyBytes - entry.ResidentBytes);
                    entry.ResidentBytes = 0;
                    entry.Value = default;
                    entry.ValueSet = false;
                    entry.State = ResourceLeaseCacheState.Disposed;
                    retired.Remove(entry);
                }
            }
            catch (Exception ex)
            {
                lock (gate)
                {
                    if (entries.TryGetValue(entry.Key, out var current)
                        && ReferenceEquals(current, entry))
                        entries.Remove(entry.Key);
                    // Resident bytes intentionally remain charged.  A failed
                    // dispose is not free memory and must not be resurrected.
                    entry.State = ResourceLeaseCacheState.Quarantined;
                    quarantined[entry.Key] = entry;
                    retired.Remove(entry);
                }
                _ = ex;
            }
        }
    }

    private async ValueTask DisposeValueAsync(Entry entry, T value)
    {
        try
        {
            await entry.DisposeAsync(value).ConfigureAwait(false);
        }
        catch
        {
            // A build that never became resident cannot corrupt resident byte
            // accounting.  The build is still failed closed.
        }
    }

    private void Release(Entry entry)
    {
        CancellationTokenSource? cancel = null;
        Entry? retiredEntry = null;
        lock (gate)
        {
            if (entry.LeaseCount <= 0) return;
            entry.LeaseCount--;
            entry.LastUsedSequence = ++sequence;
            if (entry.LeaseCount == 0 && entry.State == ResourceLeaseCacheState.Building && !entry.Settled)
            {
                entry.State = ResourceLeaseCacheState.Cancelling;
                cancelledBuilds++;
                cancel = entry.BuildCancellation;
            }
            else if (entry.LeaseCount == 0 && entry.Retired && entry.State == ResourceLeaseCacheState.Evicting)
            {
                retired.Remove(entry);
                retiredEntry = entry;
            }
        }
        if (cancel is not null) CancelNoThrow(cancel);
        if (retiredEntry is not null)
            _ = DisposeEntriesAsync(new[] { retiredEntry });
    }

    private void CancelSubscriber(Entry entry)
    {
        CancellationTokenSource? cancel = null;
        lock (gate)
        {
            if (entry.LeaseCount <= 0) return;
            entry.LeaseCount--;
            entry.LastUsedSequence = ++sequence;
            if (entry.LeaseCount == 0 && entry.State == ResourceLeaseCacheState.Building && !entry.Settled)
            {
                entry.State = ResourceLeaseCacheState.Cancelling;
                cancelledBuilds++;
                cancel = entry.BuildCancellation;
            }
        }
        if (cancel is not null) CancelNoThrow(cancel);
    }

    private bool CanPublishLocked(Entry entry) =>
        !disposed
        && entry.Generation == generation
        && entries.TryGetValue(entry.Key, out var current)
        && ReferenceEquals(current, entry)
        && entry.State == ResourceLeaseCacheState.Building
        && !entry.BuildCancellation.IsCancellationRequested
        && entry.LeaseCount > 0;

    private void CompleteFailure(Entry entry, Exception error, bool cancelled)
    {
        lock (gate)
        {
            if (entry.Settled) return;
            entry.State = cancelled ? ResourceLeaseCacheState.Cancelling : ResourceLeaseCacheState.Failed;
            if (entries.TryGetValue(entry.Key, out var current) && ReferenceEquals(current, entry))
                entries.Remove(entry.Key);
            ReleaseReservationLocked(entry);
            entry.Settled = true;
            if (cancelled) entry.Completion.TrySetCanceled();
            else entry.Completion.TrySetException(error);
        }
    }

    private void ReleaseReservationLocked(Entry entry)
    {
        if (entry.ReservedBytes <= 0) return;
        inFlightBytes = Math.Max(0, inFlightBytes - entry.ReservedBytes);
        entry.ReservedBytes = 0;
    }

    private void ThrowIfDisposedLocked()
    {
        if (disposed) throw new ResourceLeaseCacheException("CACHE_DISPOSED", "resource cache is disposed");
    }

    private void UpdatePeak(int active)
    {
        while (true)
        {
            var previous = Volatile.Read(ref peakConcurrentBuilds);
            if (active <= previous || Interlocked.CompareExchange(ref peakConcurrentBuilds, active, previous) == previous) return;
        }
    }

    private static void CancelNoThrow(CancellationTokenSource source)
    {
        try { source.Cancel(); } catch (ObjectDisposedException) { }
    }
}

internal enum ResourceLeaseCacheState
{
    Building,
    Cancelling,
    Ready,
    Failed,
    Evicting,
    Quarantined,
    Disposed
}

internal sealed class ResourceLeaseCacheException : Exception
{
    internal ResourceLeaseCacheException(string code, string message)
        : base($"{code}: {message}")
    {
        Code = code;
    }

    internal string Code { get; }
}

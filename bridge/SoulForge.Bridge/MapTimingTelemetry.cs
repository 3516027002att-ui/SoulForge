using System.Diagnostics;
using System.Text.Json;

/// <summary>
/// Opt-in timing for the production MAP static-geometry read path.
///
/// This is deliberately a request-local, bounded diagnostic. It does not alter
/// scheduling, cache policy, freshness checks, or the native authority of the
/// result. The queue wait is measured by the daemon worker before command
/// execution; resource-cache acquisition (including its build semaphore wait)
/// is reported separately as resourceAcquireMs.
/// </summary>
internal sealed class MapTimingCollector
{
    private static readonly string[] MeasurementPhases =
    {
        "fileReadMs",
        "sourceHashMs",
        "sessionLookupMs",
        "bndResolveMs",
        "flverReadMs",
        "sessionCreateMs",
        "resourceAcquireMs",
        "textureResolveManyMs",
        "buildChunkMs",
        "serializeMs"
    };

    private static readonly string[] MsbDocumentPhases =
    {
        "fileReadMs", "sourceHashMs", "dcxResolveMs", "msbReadMs", "verifyRoundTripMs", "toEnvelopeMs"
    };

    private readonly Stopwatch _total = Stopwatch.StartNew();
    private readonly double _startedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly Dictionary<string, double> _durations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _phaseCounts = new(StringComparer.Ordinal);
    private readonly string[] _measurementPhases;
    private string? _physicalSourceHash;
    private long? _physicalSourceBytes;
    private string? _decodedSourceHash;
    private long? _decodedSourceBytes;

    private MapTimingCollector(double queueWaitMs, bool msbDocument)
    {
        QueueWaitMs = Sanitize(queueWaitMs);
        IsMsbDocument = msbDocument;
        _measurementPhases = msbDocument ? MsbDocumentPhases : MeasurementPhases;
    }

    public double? QueueWaitMs { get; }
    public bool IsMsbDocument { get; }

    public static MapTimingCollector? TryCreate(
        string? command,
        JsonElement options,
        long enqueuedTimestamp)
    {
        var msbDocument = string.Equals(command, "read-msb-document", StringComparison.OrdinalIgnoreCase);
        if ((!msbDocument && !string.Equals(command, "read-map-static-geometry", StringComparison.OrdinalIgnoreCase))
            || options.ValueKind != JsonValueKind.Object
            || !options.TryGetProperty("diagnosticTimings", out var enabled)
            || enabled.ValueKind != JsonValueKind.True
            || !enabled.GetBoolean())
        {
            return null;
        }

        return new MapTimingCollector(
            Stopwatch.GetElapsedTime(enqueuedTimestamp).TotalMilliseconds, msbDocument);
    }

    // Store scalar receipts only, never source buffers or filesystem paths.
    public void ObserveMsbSource(string? physicalHash, long physicalBytes, string? decodedHash = null, long? decodedBytes = null)
    {
        if (!IsMsbDocument) return;
        _physicalSourceHash = SanitizeHash(physicalHash);
        _physicalSourceBytes = physicalBytes >= 0 ? physicalBytes : null;
        _decodedSourceHash = SanitizeHash(decodedHash);
        _decodedSourceBytes = decodedBytes >= 0 ? decodedBytes : null;
    }

    public IDisposable Measure(string phase)
    {
        if (string.IsNullOrWhiteSpace(phase)) return NoopScope.Instance;
        return new TimingScope(this, phase);
    }

    public object Snapshot()
    {
        var totalMs = Sanitize(_total.Elapsed.TotalMilliseconds);
        var unavailablePhases = _measurementPhases
            .Where(phase => !_durations.ContainsKey(phase))
            .ToArray();
        if (QueueWaitMs is null)
            unavailablePhases = unavailablePhases.Append("queueWaitMs").ToArray();
        if (IsMsbDocument)
        {
            return new
            {
                schemaVersion = 1, unit = "ms", scope = "msb-document", queueWaitMs = QueueWaitMs,
                nativeEnqueuedAtUnixMs = _startedAtUnixMs - QueueWaitMs,
                nativeStartedAtUnixMs = _startedAtUnixMs,
                nativeCompletedAtUnixMs = _startedAtUnixMs + totalMs,
                clockAlignmentToleranceMs = 5,
                physicalSourceHash = _physicalSourceHash, physicalSourceBytes = _physicalSourceBytes,
                decodedSourceHash = _decodedSourceHash, decodedSourceBytes = _decodedSourceBytes,
                fileReadMs = Get("fileReadMs"), sourceHashMs = Get("sourceHashMs"), dcxResolveMs = Get("dcxResolveMs"),
                msbReadMs = Get("msbReadMs"), verifyRoundTripMs = Get("verifyRoundTripMs"), toEnvelopeMs = Get("toEnvelopeMs"),
                totalMs,
                phaseCounts = _phaseCounts.ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal),
                unavailablePhases,
                unavailableSourceFields = new[] { _physicalSourceHash is null ? "physicalSourceHash" : null,
                    _decodedSourceHash is null ? "decodedSourceHash" : null }.Where(field => field is not null).ToArray()
            };
        }
        return new
        {
            schemaVersion = 1,
            unit = "ms",
            queueWaitMs = QueueWaitMs,
            nativeEnqueuedAtUnixMs = _startedAtUnixMs - QueueWaitMs,
            nativeStartedAtUnixMs = _startedAtUnixMs,
            nativeCompletedAtUnixMs = _startedAtUnixMs + totalMs,
            clockAlignmentToleranceMs = 5,
            fileReadMs = Get("fileReadMs"),
            sourceHashMs = Get("sourceHashMs"),
            sessionLookupMs = Get("sessionLookupMs"),
            bndResolveMs = Get("bndResolveMs"),
            flverReadMs = Get("flverReadMs"),
            sessionCreateMs = Get("sessionCreateMs"),
            resourceAcquireMs = Get("resourceAcquireMs"),
            textureResolveManyMs = Get("textureResolveManyMs"),
            buildChunkMs = Get("buildChunkMs"),
            serializeMs = Get("serializeMs"),
            totalMs,
            phaseCounts = _phaseCounts.ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal),
            unavailablePhases
        };
    }

    private double? Get(string phase) =>
        _durations.TryGetValue(phase, out var value) ? Sanitize(value) : null;

    private void Add(string phase, double elapsedMs)
    {
        if (!_measurementPhases.Contains(phase, StringComparer.Ordinal)) return;
        // The phase set is fixed above; this guard keeps a future accidental
        // diagnostic key from becoming an unbounded per-request payload.
        if (_durations.Count >= _measurementPhases.Length && !_durations.ContainsKey(phase)) return;
        var sanitized = Sanitize(elapsedMs);
        if (sanitized is null) return;
        _durations[phase] = _durations.TryGetValue(phase, out var existing)
            ? existing + sanitized.Value
            : sanitized.Value;
        _phaseCounts[phase] = _phaseCounts.TryGetValue(phase, out var count) ? count + 1 : 1;
    }

    private static double? Sanitize(double value) =>
        double.IsFinite(value) && value >= 0 ? value : null;

    private static string? SanitizeHash(string? hash) =>
        hash is { Length: 64 } && hash.All(Uri.IsHexDigit) ? hash : null;

    private sealed class TimingScope : IDisposable
    {
        private readonly MapTimingCollector _owner;
        private readonly string _phase;
        private readonly long _startedAt;
        private bool _disposed;

        public TimingScope(MapTimingCollector owner, string phase)
        {
            _owner = owner;
            _phase = phase;
            _startedAt = Stopwatch.GetTimestamp();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _owner.Add(_phase, Stopwatch.GetElapsedTime(_startedAt).TotalMilliseconds);
        }
    }

    private sealed class NoopScope : IDisposable
    {
        public static readonly NoopScope Instance = new();
        public void Dispose() { }
    }
}

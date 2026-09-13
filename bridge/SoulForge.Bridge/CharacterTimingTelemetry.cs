using System.Diagnostics;
using System.Text.Json;

/// <summary>
/// Opt-in timing for the native character FLVER preview path.
///
/// This schema is intentionally separate from MapTimingCollector: the static
/// MAP timing contract must remain stable while character previews expose the
/// cold path that resolves FLVERs, texture packages, previews, and materials.
/// The payload contains only bounded durations and counts; it never contains a
/// source path or native resource identity.
/// </summary>
internal sealed class CharacterTimingCollector
{
    private static readonly string[] MeasurementPhases =
    {
        "resolveFlverLeavesMs",
        "flverReadMs",
        "texturePackageResolveMs",
        "texturePreviewMs",
        "materialResolveMs",
        "buildOutputMs"
    };

    private readonly Stopwatch _total = Stopwatch.StartNew();
    private readonly Dictionary<string, double> _durations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _phaseCounts = new(StringComparer.Ordinal);

    private CharacterTimingCollector(double queueWaitMs)
    {
        QueueWaitMs = Sanitize(queueWaitMs);
    }

    public double? QueueWaitMs { get; }

    public static CharacterTimingCollector? TryCreate(
        string? command,
        JsonElement options,
        long enqueuedTimestamp)
    {
        if (!string.Equals(command, "read-chrbnd-flver-preview", StringComparison.OrdinalIgnoreCase)
            || options.ValueKind != JsonValueKind.Object
            || !options.TryGetProperty("diagnosticTimings", out var enabled)
            || enabled.ValueKind != JsonValueKind.True
            || !enabled.GetBoolean())
        {
            return null;
        }

        return new CharacterTimingCollector(
            Stopwatch.GetElapsedTime(enqueuedTimestamp).TotalMilliseconds);
    }

    public IDisposable Measure(string phase)
    {
        if (string.IsNullOrWhiteSpace(phase)) return NoopScope.Instance;
        return new TimingScope(this, phase);
    }

    public object Snapshot()
    {
        var unavailablePhases = MeasurementPhases
            .Where(phase => !_durations.ContainsKey(phase))
            .ToArray();
        return new
        {
            schemaVersion = 1,
            unit = "ms",
            queueWaitMs = QueueWaitMs,
            resolveFlverLeavesMs = Get("resolveFlverLeavesMs"),
            flverReadMs = Get("flverReadMs"),
            texturePackageResolveMs = Get("texturePackageResolveMs"),
            texturePreviewMs = Get("texturePreviewMs"),
            materialResolveMs = Get("materialResolveMs"),
            buildOutputMs = Get("buildOutputMs"),
            totalMs = Sanitize(_total.Elapsed.TotalMilliseconds),
            phaseCounts = _phaseCounts.ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal),
            unavailablePhases
        };
    }

    private double? Get(string phase) =>
        _durations.TryGetValue(phase, out var value) ? Sanitize(value) : null;

    private void Add(string phase, double elapsedMs)
    {
        if (!MeasurementPhases.Contains(phase, StringComparer.Ordinal)) return;
        // The phase set is fixed above; unknown scopes must never make the
        // diagnostic payload grow with input-controlled keys.
        if (_durations.Count >= MeasurementPhases.Length && !_durations.ContainsKey(phase)) return;
        var sanitized = Sanitize(elapsedMs);
        if (sanitized is null) return;
        _durations[phase] = _durations.TryGetValue(phase, out var existing)
            ? existing + sanitized.Value
            : sanitized.Value;
        _phaseCounts[phase] = _phaseCounts.TryGetValue(phase, out var count) ? count + 1 : 1;
    }

    private static double? Sanitize(double value) =>
        double.IsFinite(value) && value >= 0 ? value : null;

    private sealed class TimingScope : IDisposable
    {
        private readonly CharacterTimingCollector _owner;
        private readonly string _phase;
        private readonly long _startedAt;
        private bool _disposed;

        public TimingScope(CharacterTimingCollector owner, string phase)
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

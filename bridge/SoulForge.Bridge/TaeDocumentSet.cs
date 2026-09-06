using System.Globalization;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// A read-only set of independent TAE documents.
///
/// An ANIBND is not a TAE file with concatenated sections: each BND4 TAE child
/// has its own header, absolute offsets and source bytes.  This type keeps that
/// boundary explicit while providing a deterministic, globally paged projection
/// for callers that need to browse the whole container.
/// </summary>
internal sealed class TaeDocumentSet
{
    private sealed record MotionReferenceState(
        IReadOnlyDictionary<long, ActionAnimationSemantics.TaeMotionReference>? References,
        string? Error);

    private readonly MotionReferenceState[] _motionReferenceStates;

    private TaeDocumentSet(
        bool isContainer,
        string? containerSourceHash,
        int? containerSourceSize,
        IReadOnlyList<TaeDocumentSetEntry> entries)
    {
        if (entries.Count == 0)
            throw new TaeEntryMissingException("没有可用的 TAE 文档。");

        IsContainer = isContainer;
        ContainerSourceHash = containerSourceHash;
        ContainerSourceSize = containerSourceSize;
        Entries = entries;
        _motionReferenceStates = entries.Select(ReadMotionReferences).ToArray();
        SourceHash = isContainer
            ? ComputeAggregateHash(entries.Select(entry => entry.Document.SourceHash).ToArray(), containerSourceHash)
            : entries[0].Document.SourceHash;
    }

    public bool IsContainer { get; }
    public string? ContainerSourceHash { get; }
    public int? ContainerSourceSize { get; }
    public IReadOnlyList<TaeDocumentSetEntry> Entries { get; }
    public string SourceHash { get; }

    public int AnimationCount => checked(Entries.Sum(entry => entry.Document.Animations.Count));
    public int TotalEventCount => checked(Entries.Sum(entry => entry.Document.TotalEventCount));
    public int TotalGroupCount => checked(Entries.Sum(entry => entry.Document.TotalGroupCount));
    public IReadOnlyList<int> EventTypes => Entries
        .SelectMany(entry => entry.Document.EventTypes)
        .Distinct()
        .OrderBy(typeId => typeId)
        .ToArray();

    public static TaeDocumentSet FromRaw(TaeNativeDocument document) => new(
        false,
        null,
        null,
        new[] { new TaeDocumentSetEntry(null, null, null, null, document) });

    public static TaeDocumentSet FromAnibnd(
        string containerSourceHash,
        int containerSourceSize,
        IReadOnlyList<TaeDocumentSetEntry> entries)
    {
        if (string.IsNullOrWhiteSpace(containerSourceHash))
            throw new InvalidDataException("TAE 聚合缺少 BND4 source hash。");
        if (containerSourceSize < 0)
            throw new InvalidDataException("TAE 聚合的 BND4 source size 非法。");
        if (entries.Any(entry => !entry.TaeEntryIndex.HasValue
            || !entry.TaeEntryId.HasValue
            || string.IsNullOrWhiteSpace(entry.TaeEntryName)
            || string.IsNullOrWhiteSpace(entry.TaeGroup)))
            throw new InvalidDataException("TAE 聚合条目缺少 BND4 child identity。");
        return new TaeDocumentSet(true, containerSourceHash, containerSourceSize, entries.ToArray());
    }

    /// <summary>
    /// Enumerates animations in BND4 order, then in the native order of each
    /// child TAE.  EntryOrdinal is an internal stable discriminator for the
    /// current set; the public identity is child entry identity + AnimId.
    /// </summary>
    public IEnumerable<TaeAnimationLocation> EnumerateAnimations()
    {
        for (var ordinal = 0; ordinal < Entries.Count; ordinal++)
        {
            var entry = Entries[ordinal];
            foreach (var animation in entry.Document.Animations)
                yield return new TaeAnimationLocation(ordinal, entry, animation);
        }
    }

    public TaeAnimationLocation ResolveAnimation(
        long animId,
        int? taeEntryIndex = null,
        long? taeEntryId = null,
        string? taeEntryName = null,
        string? taeGroup = null)
    {
        var selectedEntries = SelectEntries(taeEntryIndex, taeEntryId, taeEntryName, taeGroup);
        var matches = new List<TaeAnimationLocation>();
        foreach (var entry in selectedEntries)
        {
            var ordinal = EntryOrdinal(entry);
            matches.AddRange(entry.Document.Animations
                .Where(animation => animation.AnimId == animId)
                .Select(animation => new TaeAnimationLocation(ordinal, entry, animation)));
        }

        if (matches.Count == 1) return matches[0];
        if (matches.Count == 0)
        {
            var selector = DescribeSelector(taeEntryIndex, taeEntryId, taeEntryName, taeGroup);
            throw new InvalidDataException(
                $"ACTION_TAE_ANIMATION_NOT_FOUND: animId={animId} {selector} 在 TAE 集合中不存在。");
        }

        var identities = string.Join(", ", matches.Select(DescribeIdentity));
        throw new InvalidDataException(
            $"ACTION_TAE_ANIMATION_ID_AMBIGUOUS: animId={animId} 命中 {matches.Count} 个 TAE 动画；必须提供 taeEntryIndex、taeEntryId 或 taeEntryName。matches={identities}");
    }

    public TaeEventLocation ResolveEvent(
        long animId,
        int eventIndex,
        int? taeEntryIndex = null,
        long? taeEntryId = null,
        string? taeEntryName = null,
        string? taeGroup = null)
    {
        var animation = ResolveAnimation(animId, taeEntryIndex, taeEntryId, taeEntryName, taeGroup);
        if (eventIndex < 0 || eventIndex >= animation.Animation.Events.Count)
            throw new InvalidDataException(
                $"TAE 事件不存在：{DescribeIdentity(animation)} eventIndex={eventIndex}。");
        return new TaeEventLocation(
            animation.Entry,
            animation.Animation,
            animation.Animation.Events[eventIndex]);
    }

    public long ResolveMotionAnimationId(TaeAnimationLocation animation)
    {
        if (!TryResolveMotionAnimationId(animation, out var motionAnimId, out var error))
            throw new InvalidDataException(error ??
                $"ACTION_TAE_MOTION_IDENTITY_UNAVAILABLE: {DescribeIdentity(animation)} 的 motion identity 不可用。");
        return motionAnimId;
    }

    public bool TryResolveMotionAnimationId(
        TaeAnimationLocation animation,
        out long motionAnimId,
        out string? error)
    {
        motionAnimId = 0;
        error = null;
        if (animation.EntryOrdinal < 0 || animation.EntryOrdinal >= _motionReferenceStates.Length)
        {
            error = "ACTION_TAE_MOTION_ENTRY_ORDINAL_INVALID: TAE child ordinal 不属于当前文档集合。";
            return false;
        }

        var state = _motionReferenceStates[animation.EntryOrdinal];
        if (state.References is null)
        {
            error = $"ACTION_TAE_MOTION_REFERENCE_UNAVAILABLE: {DescribeIdentity(animation)} 的 motion references 读取失败：{state.Error}";
            return false;
        }

        try
        {
            motionAnimId = ActionAnimationSemantics.ResolveMotionAnimationId(
                state.References,
                animation.Animation.AnimId);
            return true;
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException)
        {
            error = $"ACTION_TAE_MOTION_IDENTITY_UNRESOLVED: {DescribeIdentity(animation)} 的 motion identity 无法解析：{ex.Message}";
            return false;
        }
    }

    public TaeRoundTripReport VerifyRoundTrip()
    {
        if (!IsContainer)
            return Entries[0].Document.VerifyRoundTrip();

        var childReports = Entries.Select(entry => entry.Document.VerifyRoundTrip()).ToArray();
        var rebuiltHash = ComputeAggregateHash(
            childReports.Select(report => report.RebuiltHash).ToArray(),
            ContainerSourceHash);
        return new TaeRoundTripReport(
            childReports.All(report => report.ByteIdentical),
            childReports.All(report => report.SemanticIdentical),
            SourceHash,
            rebuiltHash,
            AnimationCount,
            TotalEventCount,
            TotalGroupCount);
    }

    public object ToEnvelope(
        TaeRoundTripReport? report = null,
        IReadOnlyList<Diagnostic>? extraDiagnostics = null,
        IReadOnlyDictionary<int, TaeFieldLayout[]>? templateLayouts = null,
        int? animationPage = null,
        int? animationPageSize = null)
    {
        // Keep the naked .tae envelope shape unchanged.  The additional
        // provenance fields are only needed for an ANIBND aggregate.
        if (!IsContainer)
            return Entries[0].Document.ToEnvelope(
                report,
                extraDiagnostics,
                templateLayouts,
                animationPage,
                animationPageSize);

        report ??= VerifyRoundTrip();
        const int timelineEventLimit = 200;
        const int paramHexLimit = 64;
        var allAnimations = EnumerateAnimations().ToArray();
        var invalidTimeRangeCount = Entries.Sum(entry => entry.Document.InvalidTimeRangeCount);
        var motionIds = new Dictionary<(int EntryOrdinal, long AnimId), long>();
        var motionDiagnostics = new List<Diagnostic>();

        for (var ordinal = 0; ordinal < Entries.Count; ordinal++)
        {
            var entry = Entries[ordinal];
            var state = _motionReferenceStates[ordinal];
            if (state.References is null)
            {
                motionDiagnostics.Add(new Diagnostic(
                    "warning",
                    "TAE_MOTION_REFERENCE_ENTRY_UNAVAILABLE",
                    $"TAE child {entry.TaeEntryName} 的 motion references 读取失败：{state.Error}。",
                    null,
                    new
                    {
                        taeEntryIndex = entry.TaeEntryIndex,
                        taeEntryId = entry.TaeEntryId,
                        taeEntryName = entry.TaeEntryName,
                        taeGroup = entry.TaeGroup
                    }));
                continue;
            }

            foreach (var animation in entry.Document.Animations)
            {
                var location = new TaeAnimationLocation(ordinal, entry, animation);
                if (TryResolveMotionAnimationId(location, out var motionAnimId, out var error))
                {
                    motionIds[(ordinal, animation.AnimId)] = motionAnimId;
                }
                else
                {
                    motionDiagnostics.Add(new Diagnostic(
                        "warning",
                        "TAE_MOTION_IDENTITY_UNRESOLVED",
                        error ?? $"{DescribeIdentity(location)} 的 motion identity 无法解析。",
                        null,
                        new
                        {
                            taeEntryIndex = entry.TaeEntryIndex,
                            taeEntryId = entry.TaeEntryId,
                            taeEntryName = entry.TaeEntryName,
                            taeGroup = entry.TaeGroup
                        }));
                }
            }
        }

        var diagnostics = (extraDiagnostics ?? Array.Empty<Diagnostic>())
            .Concat(invalidTimeRangeCount > 0
                ? new[]
                {
                    new Diagnostic(
                        "error",
                        "TAE_INVALID_TIME_RANGE",
                        $"检测到 {invalidTimeRangeCount} 个事件时间范围非法（startTime > endTime 或非有限值），timeline 投影降级为 partial。")
                }
                : Array.Empty<Diagnostic>())
            .Concat(motionDiagnostics)
            .ToArray();

        var versionValues = Entries.Select(entry => entry.Document.Version).Distinct().ToArray();
        var animationStart = animationPage.HasValue && animationPageSize.HasValue
            ? (long)animationPage.Value * animationPageSize.Value
            : 0L;
        var pagedAnimations = animationPage.HasValue && animationPageSize.HasValue
            ? animationStart >= allAnimations.Length
                ? Enumerable.Empty<TaeAnimationLocation>()
                : allAnimations.Skip(checked((int)animationStart)).Take(animationPageSize.Value)
            : allAnimations.AsEnumerable();
        var sourceSize = checked(Entries.Sum(entry => (long)entry.Document.SourceBytes.Length));

        return new
        {
            format = "TAE",
            version = versionValues.Length == 1
                ? $"0x{versionValues[0]:X8}"
                : "aggregate",
            versions = versionValues.Select(version => $"0x{version:X8}").ToArray(),
            sourceSize,
            sourceSizeSemantics = "独立 TAE child SourceBytes 的总和；未拼接或伪造 TAE 二进制。",
            sourceHash = SourceHash,
            aggregateIdentity = true,
            containerSourceSize = ContainerSourceSize,
            containerSourceHash = ContainerSourceHash,
            taeEntryCount = Entries.Count,
            taeEntries = Entries.Select(entry => new
            {
                entryIndex = entry.TaeEntryIndex!.Value,
                entryId = entry.TaeEntryId!.Value,
                entryName = entry.TaeEntryName!,
                taeGroup = entry.TaeGroup!,
                animationCount = entry.Document.Animations.Count,
                sourceSize = entry.Document.SourceBytes.Length,
                sourceHash = entry.Document.SourceHash
            }).ToArray(),
            animationCount = AnimationCount,
            totalEventCount = TotalEventCount,
            totalGroupCount = TotalGroupCount,
            animations = pagedAnimations.Select(animation =>
            {
                motionIds.TryGetValue((animation.EntryOrdinal, animation.Animation.AnimId), out var motionAnimId);
                return animation.Entry.Document.ToAnimationEnvelope(
                    animation.Animation,
                    motionIds.ContainsKey((animation.EntryOrdinal, animation.Animation.AnimId))
                        ? motionAnimId
                        : null,
                    templateLayouts,
                    timelineEventLimit,
                    paramHexLimit,
                    animation.Entry.TaeEntryIndex,
                    animation.Entry.TaeEntryId,
                    animation.Entry.TaeEntryName,
                    animation.Entry.TaeGroup);
            }).ToArray(),
            animationsTruncated = animationPage.HasValue && animationPageSize.HasValue
                && animationStart + animationPageSize.Value < allAnimations.Length,
            eventTypes = EventTypes,
            roundTrip = report,
            diagnostics,
            authority = !report.ByteIdentical || !report.SemanticIdentical
                || invalidTimeRangeCount > 0 || motionDiagnostics.Count > 0
                ? "partial"
                : "candidate"
        };
    }

    private IReadOnlyList<TaeDocumentSetEntry> SelectEntries(
        int? taeEntryIndex,
        long? taeEntryId,
        string? taeEntryName,
        string? taeGroup)
    {
        var hasSelector = taeEntryIndex.HasValue
            || taeEntryId.HasValue
            || !string.IsNullOrWhiteSpace(taeEntryName)
            || !string.IsNullOrWhiteSpace(taeGroup);
        if (!IsContainer)
        {
            if (hasSelector)
                throw new InvalidDataException("ACTION_TAE_ENTRY_SELECTOR_UNSUPPORTED: 裸 .tae 没有 BND4 child identity。");
            return Entries;
        }

        if (taeEntryIndex is < 0)
            throw new InvalidDataException("ACTION_TAE_ENTRY_SELECTOR_INVALID: taeEntryIndex 必须为非负整数。");

        var normalizedName = string.IsNullOrWhiteSpace(taeEntryName)
            ? null
            : LogicalBasename(taeEntryName);
        var normalizedGroup = string.IsNullOrWhiteSpace(taeGroup)
            ? null
            : LogicalGroup(taeGroup);
        var matches = Entries
            .Where(entry => (!taeEntryIndex.HasValue || entry.TaeEntryIndex == taeEntryIndex)
                && (!taeEntryId.HasValue || entry.TaeEntryId == taeEntryId)
                && (normalizedName is null
                    || string.Equals(entry.TaeEntryName, normalizedName, StringComparison.OrdinalIgnoreCase))
                && (normalizedGroup is null
                    || string.Equals(entry.TaeGroup, normalizedGroup, StringComparison.OrdinalIgnoreCase)))
            .ToArray();
        if (matches.Length == 0)
            throw new InvalidDataException(
                $"ACTION_TAE_ENTRY_SELECTOR_NOT_FOUND: {DescribeSelector(taeEntryIndex, taeEntryId, taeEntryName, taeGroup)} 未匹配任何 TAE child。");
        return matches;
    }

    private static MotionReferenceState ReadMotionReferences(TaeDocumentSetEntry entry)
    {
        try
        {
            return new MotionReferenceState(
                SekiroTaeMotionReferenceReader.ReadAll(entry.Document),
                null);
        }
        catch (Exception ex) when (ex is InvalidDataException
            or NotSupportedException
            or OverflowException
            or ArgumentException
            or IndexOutOfRangeException)
        {
            return new MotionReferenceState(null, ex.Message);
        }
    }

    private static string DescribeIdentity(TaeAnimationLocation animation)
    {
        var entry = animation.Entry;
        return entry.TaeEntryIndex.HasValue
            ? $"taeEntryIndex={entry.TaeEntryIndex} taeEntryId={entry.TaeEntryId} taeEntryName={entry.TaeEntryName} animId={animation.Animation.AnimId}"
            : $"animId={animation.Animation.AnimId}";
    }

    private static string DescribeSelector(int? index, long? id, string? name, string? group)
    {
        var safeName = "null";
        if (!string.IsNullOrWhiteSpace(name))
        {
            try { safeName = LogicalBasename(name); }
            catch (InvalidDataException) { safeName = "<invalid>"; }
        }
        var safeGroup = string.IsNullOrWhiteSpace(group) ? "null" : LogicalGroup(group);
        return $"selector(taeEntryIndex={index?.ToString(CultureInfo.InvariantCulture) ?? "null"}, taeEntryId={id?.ToString(CultureInfo.InvariantCulture) ?? "null"}, taeEntryName={safeName}, taeGroup={safeGroup})";
    }

    /// <summary>Returns only the logical final component of a BND4 name.</summary>
    public static string LogicalBasename(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidDataException("TAE child 名称为空。");
        var normalized = name.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        var basename = slash >= 0 ? normalized[(slash + 1)..] : normalized;
        if (string.IsNullOrWhiteSpace(basename) || basename.Contains(':'))
            throw new InvalidDataException("TAE child 名称没有合法的逻辑 basename。");
        return basename;
    }

    public static string LogicalGroup(string name)
    {
        var basename = LogicalBasename(name);
        return basename.EndsWith(".tae", StringComparison.OrdinalIgnoreCase)
            ? basename[..^4]
            : basename;
    }

    private string ComputeAggregateHash(IReadOnlyList<string> childHashes, string? containerHash)
    {
        if (childHashes.Count != Entries.Count)
            throw new InvalidDataException("TAE 聚合 hash 的 child 数量不一致。");
        var canonical = new StringBuilder("SoulForge.TAE.aggregate.v1\n");
        AppendToken(canonical, containerHash);
        for (var i = 0; i < Entries.Count; i++)
        {
            var entry = Entries[i];
            AppendToken(canonical, entry.TaeEntryIndex?.ToString(CultureInfo.InvariantCulture));
            AppendToken(canonical, entry.TaeEntryId?.ToString(CultureInfo.InvariantCulture));
            AppendToken(canonical, entry.TaeEntryName);
            AppendToken(canonical, entry.TaeGroup);
            AppendToken(canonical, entry.Document.SourceBytes.Length.ToString(CultureInfo.InvariantCulture));
            AppendToken(canonical, childHashes[i]);
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()))).ToLowerInvariant();
    }

    private int EntryOrdinal(TaeDocumentSetEntry target)
    {
        for (var ordinal = 0; ordinal < Entries.Count; ordinal++)
        {
            if (ReferenceEquals(Entries[ordinal], target)) return ordinal;
        }
        throw new InvalidDataException("TAE child identity 不属于当前文档集合。");
    }

    private static void AppendToken(StringBuilder target, string? value)
    {
        var bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
        target.Append(bytes.Length.ToString(CultureInfo.InvariantCulture));
        target.Append(':');
        target.Append(Convert.ToBase64String(bytes));
        target.Append('|');
    }
}

internal sealed record TaeDocumentSetEntry(
    int? TaeEntryIndex,
    long? TaeEntryId,
    string? TaeEntryName,
    string? TaeGroup,
    TaeNativeDocument Document);

internal sealed record TaeAnimationLocation(
    int EntryOrdinal,
    TaeDocumentSetEntry Entry,
    TaeAnimation Animation);

internal sealed record TaeEventLocation(
    TaeDocumentSetEntry Entry,
    TaeAnimation Animation,
    TaeEvent Event);

using System.Text.Json;

internal record MsbReferenceDescriptor(
    string OwnerHandle,
    string OwnerProperty,
    long StorageOffset,
    string StorageType,
    string TargetIndexDomain,
    string? TargetResolutionRule,
    int Value,
    int NullSentinel,
    bool Nullable,
    string OnDeletePolicy,
    string SourceSchemaHash
);

internal record ReferenceCoverageCertificate(
    string GameProfile,
    string ReaderSchemaHash,
    string SourceHash,
    int[] PresentTypeIds,
    string[] DecodedReferenceKinds,
    string[] UnknownReferenceRegions,
    bool Complete
);

internal static class MsbReferencePlan
{
    public static (int[] Map, List<MsbReferenceDescriptor> Rewritten) RemapReferences(
        int oldCount,
        int[] removedIndices,
        List<MsbReferenceDescriptor> references,
        bool complete)
    {
        if (!complete)
        {
            throw new MsbSafetyGateException("REFERENCE_COVERAGE_INCOMPLETE", "引用覆盖凭证不完整，禁止重映射引用");
        }

        if (oldCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(oldCount), "oldCount 必须是非负整数");
        }

        var removed = new HashSet<int>();
        foreach (var index in removedIndices)
        {
            if (index < 0 || index >= oldCount)
            {
                throw new ArgumentOutOfRangeException(nameof(removedIndices), $"删除索引越界: {index} (oldCount={oldCount})");
            }

            if (!removed.Add(index))
            {
                throw new MsbSafetyGateException("DUPLICATE_DELETE", $"检测到重复删除索引: {index}");
            }
        }

        var map = new int[oldCount];
        int next = 0;
        for (int i = 0; i < oldCount; i++)
        {
            map[i] = removed.Contains(i) ? -1 : next++;
        }

        var rewritten = new List<MsbReferenceDescriptor>(references.Count);
        foreach (var r in references)
        {
            if (r.Value < -1 || r.Value >= oldCount)
            {
                throw new ArgumentOutOfRangeException(nameof(r.Value), $"引用值越界: {r.Value} (oldCount={oldCount})");
            }

            if (r.Value == r.NullSentinel || r.Value == -1)
            {
                rewritten.Add(r with { });
                continue;
            }

            int mapped = map[r.Value];
            if (mapped == -1)
            {
                if (r.Nullable && r.OnDeletePolicy == "clear")
                {
                    rewritten.Add(r with { Value = r.NullSentinel });
                }
                else
                {
                    throw new MsbSafetyGateException("DELETE_REFERENCED_TARGET", $"引用目标已删除且不可自动清除: {r.OwnerHandle}.{r.OwnerProperty} (targetIndex={r.Value})");
                }
            }
            else
            {
                rewritten.Add(r with { Value = mapped });
            }
        }

        return (map, rewritten);
    }
}

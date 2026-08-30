using System.Collections.ObjectModel;

/// <summary>
/// Renderer-independent ACTION identity / mapping rules for Sekiro animation playback.
///
/// These rules deliberately live outside the HKX decoder. They are the semantic boundary between
/// TAE/ANIBND/HKX data and the renderer, and must never be replaced with positional guesses.
///
/// Mature-tool references used to establish behavior:
/// - DSAnimStudio: TAE ImportOtherAnim / ImportsHKX resolution, binder-entry animation identity,
///   hkaAnimationBinding transformTrackToBoneIndices, and HKX-vs-FLVER skeleton remapping.
/// - Smithbox (MIT): SoulsFormats.HKX / animation binding and skeleton data structures.
///
/// No GPL source code is copied here; this is a small independent implementation of the observed
/// data semantics.
/// </summary>
public static class ActionAnimationSemantics
{
    public const long SekiroAnimationBinderIdBase = 1_000_000_000L;

    public enum MotionReferenceKind
    {
        OwnHkx,
        ImportHkx,
        ImportOtherAnimation
    }

    public sealed record TaeMotionReference(
        long AnimationId,
        MotionReferenceKind Kind,
        long? SourceAnimationId = null);

    /// <summary>
    /// Minimal skeleton identity plus reference local transform used by the
    /// duplicate-name forensic report. The transform is diagnostic evidence;
    /// it is never used as a fuzzy or nearest-neighbour mapping score.
    /// </summary>
    public sealed record BoneIdentityNode(
        int Index,
        string Name,
        int ParentIndex,
        float[] Translation,
        float[] Rotation,
        float[] Scale);

    /// <summary>
    /// Resolves a selected TAE animation to the animation ID whose HKX motion must be loaded.
    /// ImportOtherAnimation follows the referenced TAE entry recursively. ImportHkx points directly
    /// at an HKX animation ID and therefore terminates immediately. Cycles and missing references fail
    /// closed rather than falling back to the selected animation ID.
    /// </summary>
    public static long ResolveMotionAnimationId(
        IReadOnlyDictionary<long, TaeMotionReference> animations,
        long selectedAnimationId)
    {
        var visited = new HashSet<long>();
        var current = selectedAnimationId;

        while (true)
        {
            if (!visited.Add(current))
                throw new InvalidDataException(
                    $"TAE animation import cycle detected while resolving {selectedAnimationId}: {current} was visited twice.");

            if (!animations.TryGetValue(current, out var reference))
                throw new InvalidDataException(
                    $"TAE animation {current} is required by {selectedAnimationId}, but its motion reference is unavailable.");

            switch (reference.Kind)
            {
                case MotionReferenceKind.OwnHkx:
                    return reference.AnimationId;

                case MotionReferenceKind.ImportHkx:
                    if (reference.SourceAnimationId is null || reference.SourceAnimationId < 0)
                        throw new InvalidDataException(
                            $"TAE animation {reference.AnimationId} imports HKX but has no valid source animation ID.");
                    return reference.SourceAnimationId.Value;

                case MotionReferenceKind.ImportOtherAnimation:
                    if (reference.SourceAnimationId is null || reference.SourceAnimationId < 0)
                        throw new InvalidDataException(
                            $"TAE animation {reference.AnimationId} imports another animation but has no valid source animation ID.");
                    current = reference.SourceAnimationId.Value;
                    break;

                default:
                    throw new InvalidDataException($"Unknown TAE motion reference kind: {reference.Kind}.");
            }
        }
    }

    /// <summary>
    /// Finds the ANIBND entry for a resolved HKX animation identity using the mature-tool binder-ID
    /// invariant: Sekiro animation entries occupy the 1,000,000,000+ ID range and the logical animation
    /// ID is entryId modulo 1,000,000,000. File names are intentionally not part of identity.
    /// </summary>
    public static int ResolveAnimationBinderEntryIndex(
        IReadOnlyList<(int Index, long EntryId)> entries,
        long motionAnimationId)
    {
        if (motionAnimationId < 0 || motionAnimationId >= SekiroAnimationBinderIdBase)
            throw new InvalidDataException($"Invalid Sekiro HKX animation ID {motionAnimationId}.");

        var matches = entries
            .Where(entry => entry.EntryId >= SekiroAnimationBinderIdBase
                && entry.EntryId % SekiroAnimationBinderIdBase == motionAnimationId)
            .ToArray();

        return matches.Length switch
        {
            1 => matches[0].Index,
            0 => throw new InvalidDataException(
                $"ANIBND contains no animation entry with logical HKX ID {motionAnimationId}."),
            _ => throw new InvalidDataException(
                $"ANIBND contains {matches.Length} entries with logical HKX ID {motionAnimationId}; identity is ambiguous.")
        };
    }

    /// <summary>
    /// Validates hkaAnimationBinding.transformTrackToBoneIndices and constructs its inverse.
    /// There is deliberately no track[i] -> bone[i] fallback. Missing binding data is an error.
    /// </summary>
    public static (int[] TrackToHkxBone, int[] HkxBoneToTrack) ValidateTrackBinding(
        IReadOnlyList<int>? transformTrackToBoneIndices,
        int transformTrackCount,
        int hkxBoneCount)
    {
        if (transformTrackCount < 0 || hkxBoneCount < 0)
            throw new ArgumentOutOfRangeException(nameof(transformTrackCount));
        if (transformTrackToBoneIndices is null)
            throw new InvalidDataException("HKX animation has no hkaAnimationBinding transform-track mapping.");
        if (transformTrackToBoneIndices.Count != transformTrackCount)
            throw new InvalidDataException(
                $"HKX binding track count mismatch: binding={transformTrackToBoneIndices.Count}, animation={transformTrackCount}.");

        var trackToBone = new int[transformTrackCount];
        var boneToTrack = Enumerable.Repeat(-1, hkxBoneCount).ToArray();

        for (var track = 0; track < transformTrackCount; track++)
        {
            var bone = transformTrackToBoneIndices[track];
            if (bone < 0 || bone >= hkxBoneCount)
                throw new InvalidDataException(
                    $"HKX binding track {track} targets bone {bone}, outside skeleton range 0..{hkxBoneCount - 1}.");
            if (boneToTrack[bone] >= 0)
                throw new InvalidDataException(
                    $"HKX binding maps both track {boneToTrack[bone]} and track {track} to bone {bone}; mapping is ambiguous.");

            trackToBone[track] = bone;
            boneToTrack[bone] = track;
        }

        return (trackToBone, boneToTrack);
    }

    /// <summary>
    /// Maps HKX skeleton bones to FLVER bones by canonical name and, when
    /// needed, hierarchy identity. HKX and FLVER bone indices are independent
    /// namespaces; index equality is never assumed. Duplicate FLVER names
    /// which are not actually present in HKX are ignored. A duplicate name is
    /// resolved only when the parent identity (and matching sibling cardinality)
    /// proves one target; otherwise mapping fails closed.
    /// </summary>
    public static int[] BuildHkxToFlverBoneMap(
        IReadOnlyList<string> hkxBoneNames,
        IReadOnlyList<string> flverBoneNames)
    {
        return BuildHkxToFlverBoneMap(hkxBoneNames, null, flverBoneNames, null);
    }

    /// <summary>
    /// Hierarchy-aware overload used by the native ACTION bridge. Parent
    /// identity is the first discriminator for duplicate names; full hierarchy
    /// IDs are used as a consistency check. If either side has no parent data,
    /// a same-name duplicate is intentionally ambiguous.
    /// </summary>
    public static int[] BuildHkxToFlverBoneMap(
        IReadOnlyList<string> hkxBoneNames,
        IReadOnlyList<int>? hkxParentIndices,
        IReadOnlyList<string> flverBoneNames,
        IReadOnlyList<int>? flverParentIndices)
    {
        if ((hkxParentIndices is null) != (flverParentIndices is null))
            throw new InvalidDataException("ACTION_BONE_HIERARCHY_METADATA_INCOMPLETE: HKX and FLVER parent arrays must be supplied together.");
        if (hkxParentIndices is not null && hkxParentIndices.Count != hkxBoneNames.Count)
            throw new InvalidDataException("ACTION_HKX_PARENT_INDEX_COUNT_MISMATCH: HKX parent metadata does not match bone count.");
        if (flverParentIndices is not null && flverParentIndices.Count != flverBoneNames.Count)
            throw new InvalidDataException("ACTION_FLVER_PARENT_INDEX_COUNT_MISMATCH: FLVER parent metadata does not match bone count.");

        ValidateBoneNames(hkxBoneNames, "HKX");
        ValidateBoneNames(flverBoneNames, "FLVER");

        var flverByName = BuildNameIndex(flverBoneNames);
        var hkxHierarchy = hkxParentIndices is not null
            ? BuildHierarchyIds(hkxBoneNames, hkxParentIndices)
            : null;
        var flverHierarchy = flverParentIndices is not null
            ? BuildHierarchyIds(flverBoneNames, flverParentIndices)
            : null;

        var map = new int[hkxBoneNames.Count];
        for (var hkxBone = 0; hkxBone < hkxBoneNames.Count; hkxBone++)
        {
            if (!flverByName.TryGetValue(hkxBoneNames[hkxBone], out var namedCandidates)
                || namedCandidates.Count == 0)
            {
                map[hkxBone] = -1;
                continue;
            }
            if (namedCandidates.Count == 1)
            {
                map[hkxBone] = namedCandidates[0];
                continue;
            }
            if (hkxParentIndices is null || flverParentIndices is null
                || hkxHierarchy is null || flverHierarchy is null)
            {
                throw new InvalidDataException(
                    $"ACTION_FLVER_BONE_MAP_AMBIGUOUS: FLVER contains duplicate bone name '{hkxBoneNames[hkxBone]}' but hierarchy metadata was not supplied.");
            }

            var hkxParentIdentity = ParentIdentity(hkxBone, hkxParentIndices, hkxHierarchy);
            var compatible = namedCandidates
                .Where(flverBone => ParentIdentity(flverBone, flverParentIndices, flverHierarchy) == hkxParentIdentity)
                .ToArray();
            if (compatible.Length == 0)
            {
                // The name exists only in a structurally different helper
                // branch. It is safer to leave this HKX bone unmapped than to
                // transfer a transform across unrelated hierarchy branches.
                map[hkxBone] = -1;
                continue;
            }
            if (compatible.Length > 1)
            {
                throw new InvalidDataException(
                    $"ACTION_FLVER_BONE_MAP_AMBIGUOUS: bone '{hkxBoneNames[hkxBone]}' has {compatible.Length} FLVER candidates with the same parent identity.");
            }

            var hkxSiblingCount = CountSameNameAndParent(
                hkxBoneNames, hkxParentIndices, hkxHierarchy, hkxBone, hkxParentIdentity);
            var flverCandidate = compatible[0];
            var flverSiblingCount = CountSameNameAndParent(
                flverBoneNames, flverParentIndices, flverHierarchy, flverCandidate, hkxParentIdentity);
            if (hkxSiblingCount != flverSiblingCount)
            {
                throw new InvalidDataException(
                    $"ACTION_FLVER_BONE_MAP_AMBIGUOUS: bone '{hkxBoneNames[hkxBone]}' has different same-parent cardinality HKX={hkxSiblingCount} FLVER={flverSiblingCount}.");
            }

            var exactHierarchyMatches = compatible
                .Where(flverBone => flverHierarchy[flverBone] == hkxHierarchy[hkxBone])
                .ToArray();
            if (exactHierarchyMatches.Length != 1)
            {
                throw new InvalidDataException(
                    $"ACTION_FLVER_BONE_MAP_AMBIGUOUS: bone '{hkxBoneNames[hkxBone]}' has no unique full hierarchy identity.");
            }
            map[hkxBone] = exactHierarchyMatches[0];
        }
        return map;
    }

    /// <summary>
    /// Emits all duplicate-name groups with enough identity context to inspect
    /// a real corpus: parent/ancestor identity, children, and reference local
    /// transforms. This is diagnostic-only and deliberately has no selection
    /// policy.
    /// </summary>
    public static object[] BuildDuplicateBoneForensics(IReadOnlyList<BoneIdentityNode> bones)
    {
        var groups = bones
            .GroupBy(bone => bone.Name, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .OrderBy(group => group.Key, StringComparer.Ordinal);
        return groups.Select(group => (object)new
        {
            name = group.Key,
            bones = group.OrderBy(bone => bone.Index).Select(bone => new
            {
                index = bone.Index,
                name = bone.Name,
                parentIndex = bone.ParentIndex,
                parentName = bone.ParentIndex >= 0 && bone.ParentIndex < bones.Count
                    ? bones[bone.ParentIndex].Name
                    : null,
                ancestorChain = BuildAncestorChain(bones, bone.Index),
                childNames = bones
                    .Where(candidate => candidate.ParentIndex == bone.Index)
                    .OrderBy(candidate => candidate.Index)
                    .Select(candidate => $"{candidate.Name}[{candidate.Index}]")
                    .ToArray(),
                referenceTranslation = bone.Translation,
                referenceRotation = bone.Rotation,
                referenceScale = bone.Scale
            }).ToArray()
        }).ToArray();
    }

    /// <summary>
    /// Projects an HKX-local pose into FLVER bone order. Bones with no animation track must have already
    /// been filled from the HKX skeleton reference pose by the decoder/sampler. Bones with no HKX name
    /// match retain the FLVER bind/reference local transform supplied by the caller.
    /// </summary>
    public static T[] RemapPoseToFlver<T>(
        IReadOnlyList<T> hkxLocalPose,
        IReadOnlyList<int> hkxToFlverBone,
        IReadOnlyList<T> flverReferenceLocalPose)
    {
        if (hkxLocalPose.Count != hkxToFlverBone.Count)
            throw new InvalidDataException(
                $"HKX pose/mapping length mismatch: pose={hkxLocalPose.Count}, map={hkxToFlverBone.Count}.");

        var result = flverReferenceLocalPose.ToArray();
        for (var hkxBone = 0; hkxBone < hkxToFlverBone.Count; hkxBone++)
        {
            var flverBone = hkxToFlverBone[hkxBone];
            if (flverBone < 0) continue;
            if (flverBone >= result.Length)
                throw new InvalidDataException(
                    $"HKX->FLVER map targets bone {flverBone}, outside FLVER skeleton range 0..{result.Length - 1}.");
            result[flverBone] = hkxLocalPose[hkxBone];
        }
        return result;
    }

    private static void ValidateBoneNames(IReadOnlyList<string> names, string skeletonKind)
    {
        for (var i = 0; i < names.Count; i++)
        {
            var name = names[i];
            if (string.IsNullOrEmpty(name))
                throw new InvalidDataException($"{skeletonKind} skeleton bone {i} has an empty name.");
        }
    }

    private static Dictionary<string, List<int>> BuildNameIndex(IReadOnlyList<string> names)
    {
        var result = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        for (var i = 0; i < names.Count; i++)
        {
            if (!result.TryGetValue(names[i], out var indices))
            {
                indices = new List<int>();
                result.Add(names[i], indices);
            }
            indices.Add(i);
        }
        return result;
    }

    private static string[] BuildHierarchyIds(
        IReadOnlyList<string> names,
        IReadOnlyList<int> parentIndices)
    {
        var result = new string[names.Count];
        var visiting = new HashSet<int>();
        string Build(int index)
        {
            if (!string.IsNullOrEmpty(result[index])) return result[index];
            if (!visiting.Add(index))
                throw new InvalidDataException($"ACTION_BONE_HIERARCHY_CYCLE: bone {index} has a parent cycle.");
            var parent = parentIndices[index];
            if (parent < -1 || parent >= names.Count || parent == index)
                throw new InvalidDataException($"ACTION_BONE_PARENT_INDEX_INVALID: bone {index} parent={parent}.");
            var parentId = parent >= 0 ? Build(parent) : "root";
            var occurrence = 0;
            for (var candidate = 0; candidate < index; candidate++)
            {
                if (parentIndices[candidate] == parent && names[candidate] == names[index]) occurrence++;
            }
            result[index] = $"{parentId}/{names[index]}#{occurrence}";
            visiting.Remove(index);
            return result[index];
        }

        for (var index = 0; index < names.Count; index++) _ = Build(index);
        return result;
    }

    private static string ParentIdentity(
        int index,
        IReadOnlyList<int> parentIndices,
        IReadOnlyList<string> hierarchyIds)
    {
        var parent = parentIndices[index];
        return parent >= 0 ? hierarchyIds[parent] : "root";
    }

    private static int CountSameNameAndParent(
        IReadOnlyList<string> names,
        IReadOnlyList<int> parentIndices,
        IReadOnlyList<string> hierarchyIds,
        int index,
        string parentIdentity)
    {
        return Enumerable.Range(0, names.Count)
            .Count(candidate => names[candidate] == names[index]
                && ParentIdentity(candidate, parentIndices, hierarchyIds) == parentIdentity);
    }

    private static string[] BuildAncestorChain(IReadOnlyList<BoneIdentityNode> bones, int index)
    {
        var chain = new List<string>();
        var visited = new HashSet<int>();
        var current = index;
        while (current >= 0 && current < bones.Count && visited.Add(current))
        {
            var bone = bones[current];
            chain.Add($"{bone.Name}[{bone.Index}]");
            current = bone.ParentIndex;
        }
        chain.Reverse();
        return chain.ToArray();
    }
}

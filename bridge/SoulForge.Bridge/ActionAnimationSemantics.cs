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
    /// Maps HKX skeleton bones to FLVER bones by canonical bone name. HKX and FLVER bone indices are
    /// independent namespaces; index equality is never assumed. Unmatched HKX bones remain -1 because
    /// not every animation/skeleton helper bone must exist in the render skeleton.
    /// </summary>
    public static int[] BuildHkxToFlverBoneMap(
        IReadOnlyList<string> hkxBoneNames,
        IReadOnlyList<string> flverBoneNames)
    {
        var flverByName = BuildUniqueNameIndex(flverBoneNames, "FLVER");
        _ = BuildUniqueNameIndex(hkxBoneNames, "HKX"); // validate source skeleton too

        var map = new int[hkxBoneNames.Count];
        for (var hkxBone = 0; hkxBone < hkxBoneNames.Count; hkxBone++)
        {
            map[hkxBone] = flverByName.TryGetValue(hkxBoneNames[hkxBone], out var flverBone)
                ? flverBone
                : -1;
        }
        return map;
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

    private static ReadOnlyDictionary<string, int> BuildUniqueNameIndex(
        IReadOnlyList<string> names,
        string skeletonKind)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < names.Count; i++)
        {
            var name = names[i];
            if (string.IsNullOrEmpty(name))
                throw new InvalidDataException($"{skeletonKind} skeleton bone {i} has an empty name.");
            if (!result.TryAdd(name, i))
                throw new InvalidDataException(
                    $"{skeletonKind} skeleton contains duplicate bone name '{name}'; name-based remapping is ambiguous.");
        }
        return new ReadOnlyDictionary<string, int>(result);
    }
}

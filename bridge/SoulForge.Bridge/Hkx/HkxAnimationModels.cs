// MIT License
// Copyright (c) 2026 SoulForge Authors
// Clean-room data models for Havok animation structures.
// References: SoulsFormats (MIT) by TKGP/vawser and HKLib (MIT) by The12thAvenger.

using System.Numerics;

namespace SoulForge.Bridge.Hkx;

public readonly record struct BoneTransform(Vector3 Translation, Quaternion Rotation, Vector3 Scale);

/// <summary>
/// One native hkaDefaultAnimatedReferenceFrame sample. Havok stores the
/// translation components in XYZ and the reference-frame rotation component
/// in W. Keep the raw vector so a consumer can apply the game's coordinate and
/// reference-frame convention without losing information at this boundary.
/// </summary>
public readonly record struct HkxReferenceFrameSample(Vector4 Raw)
{
    public Vector3 Translation => new(Raw.X, Raw.Y, Raw.Z);
    public float RotationAngle => Raw.W;
}

public sealed class HkxExtractedMotion
{
    public int FrameType { get; init; }
    public Vector4 Up { get; init; }
    public Vector4 Forward { get; init; }
    public float Duration { get; init; }
    public HkxReferenceFrameSample[] Samples { get; init; } = Array.Empty<HkxReferenceFrameSample>();
}

public enum HkxAnimationType
{
    Unknown = 0,
    Interleaved = 1,
    Mirrored = 2,
    SplineCompressed = 3,
    QuantizedCompressed = 4,
    PredictiveCompressed = 5,
    ReferencePose = 6
}

public sealed class HkxBone
{
    public string Name { get; init; } = string.Empty;
    public bool LockTranslation { get; init; }
}

public sealed class HkxSkeleton
{
    public string Name { get; init; } = string.Empty;
    public IReadOnlyList<HkxBone> Bones { get; init; } = Array.Empty<HkxBone>();
    public IReadOnlyList<short> ParentIndices { get; init; } = Array.Empty<short>();
    public IReadOnlyList<BoneTransform> Transforms { get; init; } = Array.Empty<BoneTransform>();
}

public abstract class HkxAnimation
{
    public HkxAnimationType AnimationType { get; init; }
    public float Duration { get; init; }
    public int NumberOfTransformTracks { get; init; }
    public int NumberOfFloatTracks { get; init; }
    public bool HasExtractedMotion { get; init; }
    public HkxExtractedMotion? ExtractedMotion { get; init; }
}

public sealed class HkxAnimationBinding
{
    public string OriginalSkeletonName { get; init; } = string.Empty;
    public IReadOnlyList<int> TransformTrackToBoneIndices { get; init; } = Array.Empty<int>();
    public IReadOnlyList<int> FloatTrackToFloatSlotIndices { get; init; } = Array.Empty<int>();
    public IReadOnlyList<int> PartitionIndices { get; init; } = Array.Empty<int>();
    public int BlendHint { get; init; }
    public HkxAnimation? Animation { get; set; }
}

public sealed class HkxAnimationContainer
{
    /// <summary>
    /// Native HKX container family used for this object graph.  This is part of
    /// the production evidence boundary: a TAG0 decode must not be reported as
    /// if it came from the packfile reader (or vice versa).
    /// </summary>
    public string SourceFormat { get; init; } = string.Empty;
    public IReadOnlyList<HkxSkeleton> Skeletons { get; init; } = Array.Empty<HkxSkeleton>();
    public IReadOnlyList<HkxAnimation> Animations { get; init; } = Array.Empty<HkxAnimation>();
    public IReadOnlyList<HkxAnimationBinding> Bindings { get; init; } = Array.Empty<HkxAnimationBinding>();
}

public sealed class HkxSplineCompressedAnimation : HkxAnimation
{
    public int NumFrames { get; init; }
    public int NumBlocks { get; init; }
    public int MaxFramesPerBlock { get; init; }
    public int MaskAndQuantizationSize { get; init; }
    public float BlockDuration { get; init; }
    public float BlockInverseDuration { get; init; }
    public float FrameDuration { get; init; }
    public uint[] BlockOffsets { get; init; } = Array.Empty<uint>();
    public uint[] FloatBlockOffsets { get; init; } = Array.Empty<uint>();
    public uint[] TransformOffsets { get; init; } = Array.Empty<uint>();
    public uint[] FloatOffsets { get; init; } = Array.Empty<uint>();
    public byte[] Data { get; init; } = Array.Empty<byte>();

    public SplineBlock[] Blocks { get; set; } = Array.Empty<SplineBlock>();
}

public sealed class HkxInterleavedAnimation : HkxAnimation
{
    public int NumFrames { get; init; }
    public float FrameDuration { get; init; }
    public BoneTransform[] Transforms { get; init; } = Array.Empty<BoneTransform>();
}

public sealed class SplineBlock
{
    public TransformSplineTrack[] Tracks { get; set; } = Array.Empty<TransformSplineTrack>();
}

public sealed class TransformSplineTrack
{
    public byte PositionQuantization { get; set; }
    public byte RotationQuantization { get; set; }
    public byte ScaleQuantization { get; set; }
    public byte PositionMask { get; set; }
    public byte RotationMask { get; set; }
    public byte ScaleMask { get; set; }

    // These masks preserve the distinction between an explicitly encoded channel and
    // a channel which is absent from the compressed track.  An absent channel must
    // inherit the skeleton reference pose; zero/identity/one are not valid substitutes.
    public byte PositionStaticMask { get; set; }
    public byte PositionSplineMask { get; set; }
    public bool RotationHasStatic { get; set; }
    public bool RotationHasSpline { get; set; }
    public byte ScaleStaticMask { get; set; }
    public byte ScaleSplineMask { get; set; }

    public Vector3 StaticPosition { get; set; }
    public Quaternion StaticRotation { get; set; }
    public Vector3 StaticScale { get; set; }

    public SplineCurve? PositionX { get; set; }
    public SplineCurve? PositionY { get; set; }
    public SplineCurve? PositionZ { get; set; }

    public SplineQuatCurve? Rotation { get; set; }

    public SplineCurve? ScaleX { get; set; }
    public SplineCurve? ScaleY { get; set; }
    public SplineCurve? ScaleZ { get; set; }
}

public sealed class SplineCurve
{
    public int Degree { get; set; }
    public float[] Knots { get; set; } = Array.Empty<float>();
    public float[] ControlPoints { get; set; } = Array.Empty<float>();
}

public sealed class SplineQuatCurve
{
    public int Degree { get; set; }
    public float[] Knots { get; set; } = Array.Empty<float>();
    public Quaternion[] ControlPoints { get; set; } = Array.Empty<Quaternion>();
}

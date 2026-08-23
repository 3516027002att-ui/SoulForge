// MIT License
// Copyright (c) 2026 SoulForge Authors
// Clean-room data models for Havok animation structures.
// References: SoulsFormats (MIT) by TKGP/vawser and HKLib (MIT) by The12thAvenger.

using System.Numerics;

namespace SoulForge.Bridge.Hkx;

public readonly record struct BoneTransform(Vector3 Translation, Quaternion Rotation, Vector3 Scale);

public enum HkxAnimationType
{
    Unknown = 0,
    Interleaved = 1,
    Mirrored = 2,
    SplineCompressed = 3,
    QuantizedCompressed = 4,
    PredictiveCompressed = 5
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
}

public sealed class HkxAnimationBinding
{
    public string OriginalSkeletonName { get; init; } = string.Empty;
    public IReadOnlyList<int> TransformTrackToBoneIndices { get; init; } = Array.Empty<int>();
    public HkxAnimation? Animation { get; set; }
}

public sealed class HkxAnimationContainer
{
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
    public byte PositionMask { get; set; }
    public byte RotationMask { get; set; }
    public byte ScaleMask { get; set; }

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

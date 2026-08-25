// MIT License
// Copyright (c) 2026 SoulForge Authors
// Authoritative continuous-time sampler for HKX animations.
// References: SoulsFormats (MIT) by TKGP/vawser and HKLib (MIT) by The12thAvenger.

using System.Numerics;

namespace SoulForge.Bridge.Hkx;

internal sealed class HkxContinuousSampler
{
    public HkxSkeleton Skeleton { get; }
    public HkxAnimation Animation { get; }
    public HkxAnimationBinding Binding { get; }

    public HkxContinuousSampler(HkxSkeleton skeleton, HkxAnimation animation, HkxAnimationBinding binding)
    {
        Skeleton = skeleton ?? throw new ArgumentNullException(nameof(skeleton));
        Animation = animation ?? throw new ArgumentNullException(nameof(animation));
        Binding = binding ?? throw new ArgumentNullException(nameof(binding));

        if (skeleton.Bones.Count == 0)
            throw new InvalidDataException("ACTION_HKX_SKELETON_EMPTY: hkaSkeleton 没有骨骼。");
        if (skeleton.Transforms.Count != skeleton.Bones.Count)
            throw new InvalidDataException($"ACTION_HKX_REFERENCE_POSE_MISMATCH: bones={skeleton.Bones.Count}, transforms={skeleton.Transforms.Count}。");
        if (!float.IsFinite(animation.Duration) || animation.Duration < 0f)
            throw new InvalidDataException($"ACTION_HKX_DURATION_INVALID: duration={animation.Duration}。");
        if (binding.Animation == null)
            throw new InvalidDataException("ACTION_HKX_BINDING_MISSING: hkaAnimationBinding 没有关联 animation object。");
        if (binding.AnimationObjectOffset >= 0 && binding.Animation.NativeObjectOffset != binding.AnimationObjectOffset)
            throw new InvalidDataException($"ACTION_HKX_IDENTITY_MISMATCH: binding animation offset={binding.AnimationObjectOffset}, resolved animation offset={binding.Animation.NativeObjectOffset}。");

        ActionAnimationSemantics.ValidateTrackBinding(
            binding.TransformTrackToBoneIndices,
            animation.NumberOfTransformTracks,
            skeleton.Bones.Count);

        switch (animation)
        {
            case HkxInterleavedAnimation interleaved:
                ValidateInterleaved(interleaved);
                break;
            case HkxSplineCompressedAnimation spline:
                ValidateSpline(spline);
                break;
            default:
                throw new NotSupportedException($"ACTION_HKX_ANIMATION_UNSUPPORTED: {animation.AnimationType}。");
        }

        foreach (var transform in skeleton.Transforms)
            ValidateTransform(transform, "reference pose");
    }

    public BoneTransform[] SampleLocalPose(float timeSeconds, bool loop = true)
    {
        int boneCount = Skeleton.Bones.Count;
        var pose = new BoneTransform[boneCount];

        // The native skeleton reference pose is authoritative for every bone. A missing transform is
        // malformed input, rejected by the constructor; never manufacture an identity pose here.
        for (int i = 0; i < boneCount; i++)
            pose[i] = Skeleton.Transforms[i];

        float duration = Animation.Duration;
        float clampedTime = timeSeconds;
        if (duration > 0f)
        {
            if (loop)
            {
                clampedTime = timeSeconds % duration;
                if (clampedTime < 0f) clampedTime += duration;
            }
            else
            {
                clampedTime = Math.Clamp(timeSeconds, 0f, duration);
            }
        }
        else
        {
            clampedTime = 0f;
        }

        if (Animation is HkxInterleavedAnimation interleaved)
        {
            SampleInterleaved(interleaved, clampedTime, pose);
        }
        else if (Animation is HkxSplineCompressedAnimation spline)
        {
            SampleSpline(spline, clampedTime, pose);
        }

        return pose;
    }

    private void SampleInterleaved(HkxInterleavedAnimation interleaved, float time, BoneTransform[] pose)
    {
        int numFrames = interleaved.NumFrames;
        int numTracks = interleaved.NumberOfTransformTracks;

        float frameDuration = interleaved.FrameDuration;
        float framePos = time / frameDuration;

        int frame0 = (int)MathF.Floor(framePos);
        int frame1 = (int)MathF.Ceiling(framePos);

        frame0 = Math.Clamp(frame0, 0, numFrames - 1);
        frame1 = Math.Clamp(frame1, 0, numFrames - 1);
        float alpha = Math.Clamp(framePos - frame0, 0f, 1f);

        for (int t = 0; t < numTracks; t++)
        {
            int boneIdx = Binding.TransformTrackToBoneIndices[t];

            int idx0 = frame0 * numTracks + t;
            int idx1 = frame1 * numTracks + t;

            var t0 = interleaved.Transforms[idx0];
            var t1 = interleaved.Transforms[idx1];

            var pos = Vector3.Lerp(t0.Translation, t1.Translation, alpha);
            var rot = Quaternion.Normalize(Quaternion.Slerp(t0.Rotation, t1.Rotation, alpha));
            var scale = Vector3.Lerp(t0.Scale, t1.Scale, alpha);

            pose[boneIdx] = new BoneTransform(pos, rot, scale);
        }
    }

    private void SampleSpline(HkxSplineCompressedAnimation spline, float time, BoneTransform[] pose)
    {
        int numTracks = spline.NumberOfTransformTracks;

        float frameDuration = spline.FrameDuration;
        int blockIdx = 0;
        float blockFrame;

        // Havok's block domain is time-based.  maxFramesPerBlock is a storage
        // hint, not a substitute for blockDuration when the final block is
        // shorter or the corpus uses a non-default domain.
        if (spline.NumBlocks > 1 && spline.BlockDuration > 0f && float.IsFinite(spline.BlockDuration))
        {
            blockIdx = (int)MathF.Floor(time * spline.BlockInverseDuration);
            blockIdx = Math.Clamp(blockIdx, 0, spline.NumBlocks - 1);
            blockFrame = MathF.Max(0f, (time - (blockIdx * spline.BlockDuration)) / frameDuration);
        }
        else
        {
            float frame = time / frameDuration;
            if (spline.MaxFramesPerBlock > 0 && spline.NumBlocks > 1)
            {
                blockIdx = (int)(frame / spline.MaxFramesPerBlock);
                blockIdx = Math.Clamp(blockIdx, 0, spline.NumBlocks - 1);
                blockFrame = frame - (blockIdx * spline.MaxFramesPerBlock);
            }
            else
            {
                blockFrame = frame;
            }
        }

        var block = spline.Blocks[blockIdx];

        for (int t = 0; t < numTracks; t++)
        {
            int boneIdx = Binding.TransformTrackToBoneIndices[t];
            var track = block.Tracks[t];

            // Sample Position
            var reference = pose[boneIdx];
            float px = track.PositionX != null
                ? HkxDecompressor.EvaluateBSpline(track.PositionX, blockFrame)
                : HasMask(track.PositionStaticMask, HkxNativeAnimation.FlagOffset.StaticX) ? track.StaticPosition.X : reference.Translation.X;
            float py = track.PositionY != null
                ? HkxDecompressor.EvaluateBSpline(track.PositionY, blockFrame)
                : HasMask(track.PositionStaticMask, HkxNativeAnimation.FlagOffset.StaticY) ? track.StaticPosition.Y : reference.Translation.Y;
            float pz = track.PositionZ != null
                ? HkxDecompressor.EvaluateBSpline(track.PositionZ, blockFrame)
                : HasMask(track.PositionStaticMask, HkxNativeAnimation.FlagOffset.StaticZ) ? track.StaticPosition.Z : reference.Translation.Z;

            // Sample Rotation. A track with no rotation mask preserves the
            // native skeleton reference pose; Identity is never manufactured.
            var rot = track.Rotation != null
                ? HkxDecompressor.EvaluateBSplineQuat(track.Rotation, blockFrame)
                : track.RotationHasStatic ? track.StaticRotation : reference.Rotation;

            // Sample Scale
            float sx = track.ScaleX != null
                ? HkxDecompressor.EvaluateBSpline(track.ScaleX, blockFrame)
                : HasMask(track.ScaleStaticMask, HkxNativeAnimation.FlagOffset.StaticX) ? track.StaticScale.X : reference.Scale.X;
            float sy = track.ScaleY != null
                ? HkxDecompressor.EvaluateBSpline(track.ScaleY, blockFrame)
                : HasMask(track.ScaleStaticMask, HkxNativeAnimation.FlagOffset.StaticY) ? track.StaticScale.Y : reference.Scale.Y;
            float sz = track.ScaleZ != null
                ? HkxDecompressor.EvaluateBSpline(track.ScaleZ, blockFrame)
                : HasMask(track.ScaleStaticMask, HkxNativeAnimation.FlagOffset.StaticZ) ? track.StaticScale.Z : reference.Scale.Z;

            pose[boneIdx] = new BoneTransform(
                new Vector3(px, py, pz),
                Quaternion.Normalize(rot),
                new Vector3(sx, sy, sz)
            );
        }
    }

    private static bool HasMask(byte mask, HkxNativeAnimation.FlagOffset flag) => (mask & (byte)flag) != 0;

    private void ValidateInterleaved(HkxInterleavedAnimation animation)
    {
        if (animation.NumFrames <= 0 || animation.NumberOfTransformTracks <= 0)
            throw new InvalidDataException($"ACTION_HKX_INTERLEAVED_METADATA_INVALID: frames={animation.NumFrames}, tracks={animation.NumberOfTransformTracks}。");
        if (!float.IsFinite(animation.FrameDuration) || animation.FrameDuration <= 0f)
            throw new InvalidDataException($"ACTION_HKX_FRAME_DURATION_INVALID: frameDuration={animation.FrameDuration}。");
        var expected = checked(animation.NumFrames * animation.NumberOfTransformTracks);
        if (animation.Transforms.Length != expected)
            throw new InvalidDataException($"ACTION_HKX_INTERLEAVED_DATA_MISMATCH: expected {expected} transforms, got {animation.Transforms.Length}。");
        foreach (var transform in animation.Transforms)
            ValidateTransform(transform, "interleaved transform");
    }

    private static void ValidateSpline(HkxSplineCompressedAnimation animation)
    {
        if (animation.NumFrames <= 0 || animation.NumBlocks <= 0 || animation.MaxFramesPerBlock <= 0 || animation.NumberOfTransformTracks <= 0)
            throw new InvalidDataException($"ACTION_HKX_SPLINE_METADATA_INVALID: frames={animation.NumFrames}, blocks={animation.NumBlocks}, maxFramesPerBlock={animation.MaxFramesPerBlock}, tracks={animation.NumberOfTransformTracks}。");
        if (!float.IsFinite(animation.FrameDuration) || animation.FrameDuration <= 0f)
            throw new InvalidDataException($"ACTION_HKX_FRAME_DURATION_INVALID: frameDuration={animation.FrameDuration}。");
        if (animation.Blocks.Length != animation.NumBlocks)
            throw new InvalidDataException($"ACTION_HKX_SPLINE_BLOCK_COUNT_MISMATCH: metadata={animation.NumBlocks}, decoded={animation.Blocks.Length}。");
        ValidateOffsets(animation.BlockOffsets, animation.NumBlocks, animation.Data.Length, "blockOffsets");
        if (animation.FloatBlockOffsets.Length > 0)
            ValidateOffsets(animation.FloatBlockOffsets, animation.NumBlocks, animation.Data.Length, "floatBlockOffsets", allowEnd: true);
        if (animation.TransformOffsets.Length > 0)
            ValidateOffsets(animation.TransformOffsets, animation.TransformOffsets.Length, animation.Data.Length, "transformOffsets", allowEnd: true);
        if (animation.FloatOffsets.Length > 0)
            ValidateOffsets(animation.FloatOffsets, animation.FloatOffsets.Length, animation.Data.Length, "floatOffsets", allowEnd: true);
        for (var blockIndex = 0; blockIndex < animation.Blocks.Length; blockIndex++)
        {
            var block = animation.Blocks[blockIndex];
            if (block.Tracks.Length != animation.NumberOfTransformTracks)
                throw new InvalidDataException($"ACTION_HKX_SPLINE_TRACK_COUNT_MISMATCH: block={blockIndex}, expected={animation.NumberOfTransformTracks}, got={block.Tracks.Length}。");
            foreach (var track in block.Tracks)
            {
                ValidateTransform(new BoneTransform(track.StaticPosition, track.StaticRotation, track.StaticScale), $"spline block={blockIndex} static");
                ValidateCurve(track.PositionX, "positionX", blockIndex);
                ValidateCurve(track.PositionY, "positionY", blockIndex);
                ValidateCurve(track.PositionZ, "positionZ", blockIndex);
                ValidateCurve(track.ScaleX, "scaleX", blockIndex);
                ValidateCurve(track.ScaleY, "scaleY", blockIndex);
                ValidateCurve(track.ScaleZ, "scaleZ", blockIndex);
                ValidateCurve(track.Rotation, "rotation", blockIndex);
            }
        }
    }

    private static void ValidateOffsets(IReadOnlyList<uint> offsets, int expectedCount, int dataLength, string name, bool allowEnd = false)
    {
        if (offsets.Count != expectedCount)
            throw new InvalidDataException($"ACTION_HKX_SPLINE_OFFSETS_INVALID: {name} expected={expectedCount} actual={offsets.Count}。");
        uint previous = 0;
        for (var i = 0; i < offsets.Count; i++)
        {
            var offset = offsets[i];
            if ((allowEnd ? offset > dataLength : offset >= dataLength) || (i > 0 && offset < previous))
                throw new InvalidDataException($"ACTION_HKX_SPLINE_OFFSET_BOUNDS_INVALID: {name}[{i}]={offset} dataLength={dataLength}。");
            previous = offset;
        }
    }

    private static void ValidateCurve(SplineCurve? curve, string component, int blockIndex)
    {
        if (curve == null) return;
        if (curve.Degree < 0 || curve.Degree > 4 || curve.ControlPoints.Length == 0 || curve.Knots.Length != curve.ControlPoints.Length + curve.Degree + 1)
            throw new InvalidDataException($"ACTION_HKX_SPLINE_CURVE_INVALID: block={blockIndex} component={component} degree={curve.Degree}, knots={curve.Knots.Length}, controlPoints={curve.ControlPoints.Length}。");
        for (var i = 0; i < curve.Knots.Length; i++)
        {
            if (!float.IsFinite(curve.Knots[i]) || (i > 0 && curve.Knots[i] < curve.Knots[i - 1]))
                throw new InvalidDataException($"ACTION_HKX_SPLINE_CURVE_NONFINITE_OR_UNORDERED: block={blockIndex} component={component}。");
        }
        if (curve.ControlPoints.Any(value => !float.IsFinite(value)))
            throw new InvalidDataException($"ACTION_HKX_SPLINE_CURVE_NONFINITE: block={blockIndex} component={component}。");
    }

    private static void ValidateCurve(SplineQuatCurve? curve, string component, int blockIndex)
    {
        if (curve == null) return;
        if (curve.Degree < 0 || curve.Degree > 4 || curve.ControlPoints.Length == 0 || curve.Knots.Length != curve.ControlPoints.Length + curve.Degree + 1)
            throw new InvalidDataException($"ACTION_HKX_SPLINE_CURVE_INVALID: block={blockIndex} component={component} degree={curve.Degree}, knots={curve.Knots.Length}, controlPoints={curve.ControlPoints.Length}。");
        for (var i = 0; i < curve.Knots.Length; i++)
        {
            if (!float.IsFinite(curve.Knots[i]) || (i > 0 && curve.Knots[i] < curve.Knots[i - 1]))
                throw new InvalidDataException($"ACTION_HKX_SPLINE_CURVE_NONFINITE_OR_UNORDERED: block={blockIndex} component={component}。");
        }
        foreach (var value in curve.ControlPoints) ValidateTransform(new BoneTransform(Vector3.Zero, value, Vector3.One), $"spline {component}");
    }

    private static void ValidateTransform(BoneTransform transform, string description)
    {
        if (!float.IsFinite(transform.Translation.X) || !float.IsFinite(transform.Translation.Y) || !float.IsFinite(transform.Translation.Z) ||
            !float.IsFinite(transform.Rotation.X) || !float.IsFinite(transform.Rotation.Y) || !float.IsFinite(transform.Rotation.Z) || !float.IsFinite(transform.Rotation.W) ||
            !float.IsFinite(transform.Scale.X) || !float.IsFinite(transform.Scale.Y) || !float.IsFinite(transform.Scale.Z) ||
            transform.Rotation.LengthSquared() <= 1e-8f)
            throw new InvalidDataException($"ACTION_HKX_TRANSFORM_INVALID: {description}。");
    }
}

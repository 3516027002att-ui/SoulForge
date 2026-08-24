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
            throw new InvalidDataException("HKX skeleton has no bones; animation sampling is not authoritative.");
        if (skeleton.Transforms.Count != skeleton.Bones.Count)
            throw new InvalidDataException(
                $"HKX skeleton reference-pose count mismatch: bones={skeleton.Bones.Count}, transforms={skeleton.Transforms.Count}.");
        if (binding.BlendHint != 0)
            throw new NotSupportedException(
                $"HKX additive animation blend hint {binding.BlendHint} is not supported by the absolute-pose clip contract.");
        if (!float.IsFinite(animation.Duration) || animation.Duration <= 0f)
            throw new InvalidDataException("HKX animation has a non-positive or non-finite duration.");
        if (animation.HasExtractedMotion != (animation.ExtractedMotion is not null))
            throw new InvalidDataException(
                "HKX extracted-motion presence flag does not match its decoded reference-frame payload.");
        if (animation.ExtractedMotion is { } extractedMotion)
        {
            if (!float.IsFinite(extractedMotion.Duration) || extractedMotion.Duration <= 0f)
                throw new InvalidDataException("HKX extracted-motion duration is non-positive or non-finite.");
            if (extractedMotion.Samples.Length == 0)
                throw new InvalidDataException("HKX extracted-motion reference-frame sample array is empty.");
        }
        for (int i = 0; i < skeleton.Transforms.Count; i++)
        {
            ValidateTransform(skeleton.Transforms[i], $"skeleton reference pose {i}");
        }

        // Validate binding
        ActionAnimationSemantics.ValidateTrackBinding(
            binding.TransformTrackToBoneIndices,
            animation.NumberOfTransformTracks,
            skeleton.Bones.Count);
    }

    public BoneTransform[] SampleLocalPose(float timeSeconds, bool loop = true)
    {
        int boneCount = Skeleton.Bones.Count;
        var pose = new BoneTransform[boneCount];

        // 1. Fill default reference pose for all bones
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
        // 2. Sample each track according to animation type
        if (Animation is HkxInterleavedAnimation interleaved)
        {
            SampleInterleaved(interleaved, clampedTime, pose);
        }
        else if (Animation is HkxSplineCompressedAnimation spline)
        {
            SampleSpline(spline, clampedTime, pose);
        }
        else
        {
            throw new NotSupportedException($"HKX animation type {Animation.AnimationType} cannot be sampled.");
        }

        return pose;
    }

    /// <summary>
    /// Samples the native reference-frame motion separately from the local bone
    /// pose. The UI may remain in-place, but the translation and rotation lane
    /// are retained and available to an engine integrator.
    /// </summary>
    public HkxReferenceFrameSample SampleExtractedMotion(float timeSeconds, bool loop = true)
    {
        if (!float.IsFinite(timeSeconds))
            throw new InvalidDataException("HKX extracted-motion sample time must be finite.");
        var motion = Animation.ExtractedMotion
            ?? throw new NotSupportedException("HKX animation has no extracted-motion reference frame.");
        var samples = motion.Samples;
        if (samples.Length == 0)
            throw new InvalidDataException("HKX extracted-motion sample array is empty.");
        if (samples.Length == 1)
            return samples[0];

        float time = timeSeconds;
        if (loop)
        {
            time %= motion.Duration;
            if (time < 0f) time += motion.Duration;
        }
        else
        {
            time = Math.Clamp(time, 0f, motion.Duration);
        }

        float frame = time / motion.Duration * (samples.Length - 1);
        int frame0 = Math.Clamp((int)MathF.Floor(frame), 0, samples.Length - 1);
        int frame1 = Math.Clamp((int)MathF.Ceiling(frame), 0, samples.Length - 1);
        float alpha = Math.Clamp(frame - frame0, 0f, 1f);
        return new HkxReferenceFrameSample(Vector4.Lerp(samples[frame0].Raw, samples[frame1].Raw, alpha));
    }

    private void SampleInterleaved(HkxInterleavedAnimation interleaved, float time, BoneTransform[] pose)
    {
        int numFrames = interleaved.NumFrames;
        int numTracks = interleaved.NumberOfTransformTracks;
        if (numFrames <= 0 || numTracks <= 0)
            throw new InvalidDataException("HKX interleaved animation has no transform frames or tracks.");
        if (interleaved.Transforms.Length != checked(numFrames * numTracks))
            throw new InvalidDataException(
                $"HKX interleaved transform count mismatch: expected={checked(numFrames * numTracks)}, actual={interleaved.Transforms.Length}.");

        if (!float.IsFinite(interleaved.FrameDuration) || interleaved.FrameDuration <= 0f)
            throw new InvalidDataException("HKX interleaved animation has an invalid frame duration.");
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
            if (boneIdx < 0 || boneIdx >= pose.Length)
                throw new InvalidDataException($"HKX interleaved track {t} targets invalid bone {boneIdx}.");

            int idx0 = frame0 * numTracks + t;
            int idx1 = frame1 * numTracks + t;

            var t0 = interleaved.Transforms[idx0];
            var t1 = interleaved.Transforms[idx1];

            var pos = Vector3.Lerp(t0.Translation, t1.Translation, alpha);
            var rot = NormalizeQuaternionStrict(Quaternion.Slerp(t0.Rotation, t1.Rotation, alpha),
                $"interleaved track {t} rotation");
            var scale = Vector3.Lerp(t0.Scale, t1.Scale, alpha);

            var sampled = new BoneTransform(pos, rot, scale);
            ValidateTransform(sampled, $"interleaved track {t}");
            pose[boneIdx] = sampled;
        }
    }

    private void SampleSpline(HkxSplineCompressedAnimation spline, float time, BoneTransform[] pose)
    {
        int numTracks = spline.NumberOfTransformTracks;
        if (numTracks <= 0)
            throw new InvalidDataException("HKX spline animation has no transform tracks.");
        if (spline.Blocks.Length != spline.NumBlocks || spline.NumBlocks <= 0)
            throw new InvalidDataException(
                $"HKX spline block count mismatch: header={spline.NumBlocks}, parsed={spline.Blocks.Length}.");

        // Determine block and local frame
        if (!float.IsFinite(spline.FrameDuration) || spline.FrameDuration <= 0f)
            throw new InvalidDataException("HKX spline animation has an invalid frame duration.");
        float frameDuration = spline.FrameDuration;
        float frame = time / frameDuration;
        int blockIdx = 0;
        float blockFrame = frame;

        if (spline.MaxFramesPerBlock > 0 && spline.NumBlocks > 1)
        {
            blockIdx = (int)(frame / spline.MaxFramesPerBlock);
            blockIdx = Math.Clamp(blockIdx, 0, spline.NumBlocks - 1);
            blockFrame = frame - (blockIdx * spline.MaxFramesPerBlock);
        }

        var block = spline.Blocks[blockIdx];
        if (block.Tracks == null || block.Tracks.Length != numTracks)
            throw new InvalidDataException(
                $"HKX spline block {blockIdx} track count mismatch: expected={numTracks}, actual={block.Tracks?.Length ?? 0}.");

        for (int t = 0; t < numTracks; t++)
        {
            int boneIdx = Binding.TransformTrackToBoneIndices[t];
            if (boneIdx < 0 || boneIdx >= pose.Length)
                throw new InvalidDataException($"HKX spline track {t} targets invalid bone {boneIdx}.");

            var track = block.Tracks[t];
            var reference = pose[boneIdx];

            // Sample Position
            float px = ResolveScalarChannel(track.PositionX, (track.PositionStaticMask & 0x01) != 0,
                (track.PositionSplineMask & 0x01) != 0, track.StaticPosition.X, reference.Translation.X,
                blockFrame, $"track {t} position X");
            float py = ResolveScalarChannel(track.PositionY, (track.PositionStaticMask & 0x02) != 0,
                (track.PositionSplineMask & 0x02) != 0, track.StaticPosition.Y, reference.Translation.Y,
                blockFrame, $"track {t} position Y");
            float pz = ResolveScalarChannel(track.PositionZ, (track.PositionStaticMask & 0x04) != 0,
                (track.PositionSplineMask & 0x04) != 0, track.StaticPosition.Z, reference.Translation.Z,
                blockFrame, $"track {t} position Z");

            // Sample Rotation
            Quaternion rot;
            if (track.Rotation != null)
            {
                rot = HkxDecompressor.EvaluateBSplineQuat(track.Rotation, blockFrame);
            }
            else if (track.RotationHasStatic)
            {
                rot = track.StaticRotation;
            }
            else if (track.RotationHasSpline)
            {
                throw new InvalidDataException($"HKX spline {t} rotation declares a spline channel but has no curve.");
            }
            else
            {
                rot = reference.Rotation;
            }

            // Sample Scale
            float sx = ResolveScalarChannel(track.ScaleX, (track.ScaleStaticMask & 0x01) != 0,
                (track.ScaleSplineMask & 0x01) != 0, track.StaticScale.X, reference.Scale.X,
                blockFrame, $"track {t} scale X");
            float sy = ResolveScalarChannel(track.ScaleY, (track.ScaleStaticMask & 0x02) != 0,
                (track.ScaleSplineMask & 0x02) != 0, track.StaticScale.Y, reference.Scale.Y,
                blockFrame, $"track {t} scale Y");
            float sz = ResolveScalarChannel(track.ScaleZ, (track.ScaleStaticMask & 0x04) != 0,
                (track.ScaleSplineMask & 0x04) != 0, track.StaticScale.Z, reference.Scale.Z,
                blockFrame, $"track {t} scale Z");

            var sampledPose = new BoneTransform(
                new Vector3(px, py, pz),
                NormalizeQuaternionStrict(rot, $"spline track {t} rotation"),
                new Vector3(sx, sy, sz)
            );
            ValidateTransform(sampledPose, $"spline track {t}");
            pose[boneIdx] = sampledPose;
        }
    }

    private static float ResolveScalarChannel(
        SplineCurve? curve,
        bool hasStaticValue,
        bool hasSplineValue,
        float staticValue,
        float referenceValue,
        float parameter,
        string label)
    {
        if (curve != null)
            return HkxDecompressor.EvaluateBSpline(curve, parameter);
        if (hasStaticValue)
            return staticValue;
        if (hasSplineValue)
            throw new InvalidDataException($"HKX {label} declares a spline channel but has no curve.");
        return referenceValue;
    }

    private static Quaternion NormalizeQuaternionStrict(Quaternion value, string label)
    {
        if (!float.IsFinite(value.X) || !float.IsFinite(value.Y)
            || !float.IsFinite(value.Z) || !float.IsFinite(value.W))
            throw new InvalidDataException($"HKX {label} contains a non-finite quaternion.");
        var lengthSquared = value.LengthSquared();
        if (!float.IsFinite(lengthSquared) || lengthSquared <= 1e-12f)
            throw new InvalidDataException($"HKX {label} contains a zero-length quaternion.");
        return Quaternion.Normalize(value);
    }

    private static void ValidateTransform(BoneTransform transform, string label)
    {
        if (!float.IsFinite(transform.Translation.X) || !float.IsFinite(transform.Translation.Y)
            || !float.IsFinite(transform.Translation.Z) || !float.IsFinite(transform.Scale.X)
            || !float.IsFinite(transform.Scale.Y) || !float.IsFinite(transform.Scale.Z))
            throw new InvalidDataException($"HKX {label} contains non-finite transform values.");
        _ = NormalizeQuaternionStrict(transform.Rotation, label + " rotation");
    }
}

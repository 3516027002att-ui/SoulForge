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
        {
            if (i < Skeleton.Transforms.Count)
            {
                pose[i] = Skeleton.Transforms[i];
            }
            else
            {
                pose[i] = new BoneTransform(Vector3.Zero, Quaternion.Identity, Vector3.One);
            }
        }

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

        // 2. Sample each track according to animation type
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
        if (numFrames <= 0 || numTracks <= 0 || interleaved.Transforms.Length == 0) return;

        float frameDuration = interleaved.FrameDuration > 0 ? interleaved.FrameDuration : (1f / 30f);
        float framePos = time / frameDuration;

        int frame0 = (int)MathF.Floor(framePos);
        int frame1 = (int)MathF.Ceiling(framePos);

        frame0 = Math.Clamp(frame0, 0, numFrames - 1);
        frame1 = Math.Clamp(frame1, 0, numFrames - 1);
        float alpha = Math.Clamp(framePos - frame0, 0f, 1f);

        for (int t = 0; t < numTracks && t < Binding.TransformTrackToBoneIndices.Count; t++)
        {
            int boneIdx = Binding.TransformTrackToBoneIndices[t];
            if (boneIdx < 0 || boneIdx >= pose.Length) continue;

            int idx0 = frame0 * numTracks + t;
            int idx1 = frame1 * numTracks + t;

            if (idx0 < interleaved.Transforms.Length && idx1 < interleaved.Transforms.Length)
            {
                var t0 = interleaved.Transforms[idx0];
                var t1 = interleaved.Transforms[idx1];

                var pos = Vector3.Lerp(t0.Translation, t1.Translation, alpha);
                var rot = Quaternion.Normalize(Quaternion.Slerp(t0.Rotation, t1.Rotation, alpha));
                var scale = Vector3.Lerp(t0.Scale, t1.Scale, alpha);

                pose[boneIdx] = new BoneTransform(pos, rot, scale);
            }
        }
    }

    private void SampleSpline(HkxSplineCompressedAnimation spline, float time, BoneTransform[] pose)
    {
        int numTracks = spline.NumberOfTransformTracks;
        if (spline.Blocks.Length == 0 || numTracks <= 0) return;

        // Determine block and local frame
        float frameDuration = spline.FrameDuration > 0 ? spline.FrameDuration : (1f / 30f);
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
        if (block.Tracks == null) return;

        for (int t = 0; t < numTracks && t < Binding.TransformTrackToBoneIndices.Count; t++)
        {
            int boneIdx = Binding.TransformTrackToBoneIndices[t];
            if (boneIdx < 0 || boneIdx >= pose.Length) continue;

            if (t >= block.Tracks.Length) continue;
            var track = block.Tracks[t];

            // Sample Position
            float px = track.PositionX != null ? HkxDecompressor.EvaluateBSpline(track.PositionX, blockFrame) : track.StaticPosition.X;
            float py = track.PositionY != null ? HkxDecompressor.EvaluateBSpline(track.PositionY, blockFrame) : track.StaticPosition.Y;
            float pz = track.PositionZ != null ? HkxDecompressor.EvaluateBSpline(track.PositionZ, blockFrame) : track.StaticPosition.Z;

            // Sample Rotation
            var rot = track.Rotation != null ? HkxDecompressor.EvaluateBSplineQuat(track.Rotation, blockFrame) : track.StaticRotation;

            // Sample Scale
            float sx = track.ScaleX != null ? HkxDecompressor.EvaluateBSpline(track.ScaleX, blockFrame) : track.StaticScale.X;
            float sy = track.ScaleY != null ? HkxDecompressor.EvaluateBSpline(track.ScaleY, blockFrame) : track.StaticScale.Y;
            float sz = track.ScaleZ != null ? HkxDecompressor.EvaluateBSpline(track.ScaleZ, blockFrame) : track.StaticScale.Z;

            pose[boneIdx] = new BoneTransform(
                new Vector3(px, py, pz),
                Quaternion.Normalize(rot),
                new Vector3(sx, sy, sz)
            );
        }
    }
}

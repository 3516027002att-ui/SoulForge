// MIT License
// Copyright (c) 2026 SoulForge Authors
// High-level reader for Havok animation structures from HkxPackfile.
// References: SoulsFormats (MIT) by TKGP/vawser and HKLib (MIT) by The12thAvenger.

using System.Buffers.Binary;
using System.Numerics;
using System.Text;
using SoulForge.Bridge;

namespace SoulForge.Bridge.Hkx;

internal static class HkxAnimationReader
{
    public static HkxAnimationContainer ReadContainer(byte[] hkxBytes, byte[]? compendiumBytes = null)
    {
        if (hkxBytes.Length >= 4 && BinaryPrimitives.ReadUInt32LittleEndian(hkxBytes.AsSpan(0, 4)) == HkxPackfile.Magic0)
        {
            return ReadPackfileContainer(hkxBytes);
        }

        if (hkxBytes.Length >= 8 &&
            (Encoding.ASCII.GetString(hkxBytes, 4, 4) is "TAG0" or "TCM0" ||
             Encoding.ASCII.GetString(hkxBytes, 0, 4) is "TAG0" or "TCM0"))
        {
            return HkxTagfileReader.ReadTagfile(hkxBytes, compendiumBytes);
        }

        throw new InvalidDataException($"未知或不受支持的 HKX 格式标头（首 4 字节：0x{BinaryPrimitives.ReadUInt32LittleEndian(hkxBytes.AsSpan(0, 4)):X8}）。");
    }

    private static HkxAnimationContainer ReadPackfileContainer(byte[] hkxBytes)
    {
        var packfile = HkxPackfile.Read(hkxBytes);
        var dataSec = packfile.DataSection;
        var data = dataSec.SectionData;

        var skeletons = new List<HkxSkeleton>();
        var animations = new List<HkxAnimation>();
        var bindings = new List<HkxAnimationBinding>();
        var seenSkeletonOffsets = new HashSet<int>();
        var seenAnimationOffsets = new HashSet<int>();
        var seenBindingOffsets = new HashSet<int>();

        // Look through virtual fixups to discover all instantiated objects
        foreach (var vf in dataSec.VirtualFixups)
        {
            var className = packfile.GetClassNameAtVirtualOffset(vf.Src);
            if (className == null) continue;

            int objOffset = (int)vf.Src;
            if (objOffset < 0 || objOffset >= data.Length) continue;

            if (className == "hkaSkeleton")
            {
                if (!seenSkeletonOffsets.Add(objOffset)) continue;
                var skel = ReadSkeleton(packfile, objOffset);
                if (skel != null) skeletons.Add(skel);
            }
            else if (className == "hkaAnimationBinding")
            {
                if (!seenBindingOffsets.Add(objOffset)) continue;
                var binding = ReadBinding(packfile, objOffset);
                if (binding != null) bindings.Add(binding);
            }
            else if (className is "hkaSplineCompressedAnimation" or "hkaInterleavedUncompressedAnimation" or "hkaAnimation")
            {
                if (!seenAnimationOffsets.Add(objOffset)) continue;
                var anim = ReadAnimation(packfile, objOffset, className);
                if (anim != null) animations.Add(anim);
            }
        }

        return new HkxAnimationContainer
        {
            Skeletons = skeletons,
            Animations = animations,
            Bindings = bindings
        };
    }

    public static HkxSkeleton? ReadSkeleton(HkxPackfile packfile, int offset)
    {
        var data = packfile.DataSection.SectionData;
        if (offset + 0x48 > data.Length) return null;

        // +0x10: name ptr (hkStringPtr)
        string name = ReadStringPtr(packfile, (uint)(offset + 0x10)) ?? string.Empty;

        // +0x18: parentIndices (hkArray<hkInt16>)
        var parentIndices = ReadInt16Array(packfile, (uint)(offset + 0x18));

        // +0x28: bones (hkArray<hkaBone>)
        var bones = ReadBoneArray(packfile, (uint)(offset + 0x28));

        // +0x38: transforms (hkArray<hkQsTransform>)
        var transforms = ReadQsTransformArray(packfile, (uint)(offset + 0x38));

        return new HkxSkeleton
        {
            Name = name,
            NativeObjectOffset = offset,
            ParentIndices = parentIndices,
            Bones = bones,
            Transforms = transforms
        };
    }

    public static HkxAnimationBinding? ReadBinding(HkxPackfile packfile, int offset)
    {
        var data = packfile.DataSection.SectionData;
        if (offset + 0x30 > data.Length) return null;

        // +0x10: originalSkeletonName (hkStringPtr)
        string originalSkeletonName = ReadStringPtr(packfile, (uint)(offset + 0x10)) ?? string.Empty;

        // +0x18: animation ptr
        HkxAnimation? animation = null;
        if (packfile.DataSection.LocalFixupMap.TryGetValue((uint)(offset + 0x18), out var animOffset))
        {
            var animClass = packfile.GetClassNameAtVirtualOffset(animOffset);
            if (animClass != null)
            {
                animation = ReadAnimation(packfile, (int)animOffset, animClass);
            }
        }

        // +0x20: transformTrackToBoneIndices (hkArray<hkInt16>)
        var trackToBone = ReadInt16Array(packfile, (uint)(offset + 0x20))
            .Select(s => (int)s)
            .ToArray();

        return new HkxAnimationBinding
        {
            NativeObjectOffset = offset,
            AnimationObjectOffset = animation != null ? (int)animOffset : -1,
            OriginalSkeletonName = originalSkeletonName,
            TransformTrackToBoneIndices = trackToBone,
            Animation = animation
        };
    }

    public static HkxAnimation? ReadAnimation(HkxPackfile packfile, int offset, string className)
    {
        var data = packfile.DataSection.SectionData;
        if (offset + 0x28 > data.Length) return null;

        // +0x10: type (int32)
        int animTypeInt = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x10, 4));
        var animType = (HkxAnimationType)animTypeInt;

        // +0x18: duration (float)
        float duration = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(offset + 0x18, 4));

        // +0x1C: numberOfTransformTracks (int32)
        int numTracks = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x1C, 4));

        // +0x20: numberOfFloatTracks (int32)
        int numFloatTracks = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x20, 4));

        HkxAnimation animation;
        if (className == "hkaSplineCompressedAnimation" || animType == HkxAnimationType.SplineCompressed)
        {
            animation = ReadSplineCompressedAnimation(packfile, offset, duration, numTracks, numFloatTracks);
        }
        else if (className == "hkaInterleavedUncompressedAnimation" || animType == HkxAnimationType.Interleaved)
        {
            animation = ReadInterleavedAnimation(packfile, offset, duration, numTracks, numFloatTracks);
        }
        else
        {
            throw new NotSupportedException($"未支持的 HKX 动画类型：{className} (type={(int)animType})。");
        }

        animation.NativeObjectOffset = offset;
        return animation;
    }

    private static HkxSplineCompressedAnimation ReadSplineCompressedAnimation(
        HkxPackfile packfile, int offset, float duration, int numTracks, int numFloatTracks)
    {
        var data = packfile.DataSection.SectionData;
        if (offset + 0xB0 > data.Length)
            throw new InvalidDataException("hkaSplineCompressedAnimation 头部截断。");

        int numFrames = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x40, 4));
        int numBlocks = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x44, 4));
        int maxFramesPerBlock = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x48, 4));
        int maskAndQuantSize = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x4C, 4));
        float blockDuration = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(offset + 0x50, 4));
        float blockInverseDuration = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(offset + 0x54, 4));
        float frameDuration = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(offset + 0x58, 4));

        // +0x60: blockOffsets (hkArray<hkUint32>)
        var blockOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x60));

        // +0x70: floatBlockOffsets
        var floatBlockOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x70));

        // +0x80: transformOffsets
        var transformOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x80));

        // +0x90: floatOffsets
        var floatOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x90));

        // +0xA0: data (hkArray<hkUint8>)
        var animData = ReadByteArray(packfile, (uint)(offset + 0xA0));

        var anim = new HkxSplineCompressedAnimation
        {
            AnimationType = HkxAnimationType.SplineCompressed,
            Duration = duration,
            NumberOfTransformTracks = numTracks,
            NumberOfFloatTracks = numFloatTracks,
            NumFrames = numFrames,
            NumBlocks = numBlocks,
            MaxFramesPerBlock = maxFramesPerBlock,
            MaskAndQuantizationSize = maskAndQuantSize,
            BlockDuration = blockDuration,
            BlockInverseDuration = blockInverseDuration,
            FrameDuration = frameDuration,
            BlockOffsets = blockOffsets,
            FloatBlockOffsets = floatBlockOffsets,
            TransformOffsets = transformOffsets,
            FloatOffsets = floatOffsets,
            Data = animData
        };

        // Parse spline blocks and tracks
        anim.Blocks = ParseSplineBlocks(anim);
        return anim;
    }

    private static HkxInterleavedAnimation ReadInterleavedAnimation(
        HkxPackfile packfile, int offset, float duration, int numTracks, int numFloatTracks)
    {
        var data = packfile.DataSection.SectionData;
        if (offset + 0x50 > data.Length)
            throw new InvalidDataException("hkaInterleavedUncompressedAnimation 头部截断。");

        // +0x40: transforms (hkArray<hkQsTransform>)
        var transforms = ReadQsTransformArray(packfile, (uint)(offset + 0x40));
        int numFrames = numTracks > 0 ? transforms.Length / numTracks : 0;
        float frameDuration = numFrames > 1 ? duration / (numFrames - 1) : 1f / 30f;

        return new HkxInterleavedAnimation
        {
            AnimationType = HkxAnimationType.Interleaved,
            Duration = duration,
            NumberOfTransformTracks = numTracks,
            NumberOfFloatTracks = numFloatTracks,
            NumFrames = numFrames,
            FrameDuration = frameDuration,
            Transforms = transforms
        };
    }

    internal static SplineBlock[] ParseSplineBlocks(HkxSplineCompressedAnimation anim)
    {
        if (anim.Data.Length == 0 || anim.NumBlocks <= 0 || anim.NumberOfTransformTracks <= 0)
            throw new InvalidDataException("ACTION_SPLINE_DATA_MISSING: HKX spline animation has no block data.");
        if (anim.BlockOffsets.Length != anim.NumBlocks)
            throw new InvalidDataException($"ACTION_SPLINE_BLOCK_OFFSETS_INVALID: expected {anim.NumBlocks} block offsets, got {anim.BlockOffsets.Length}.");

        var blocks = new SplineBlock[anim.NumBlocks];
        for (var blockIndex = 0; blockIndex < anim.NumBlocks; blockIndex++)
        {
            var blockStart = checked((int)anim.BlockOffsets[blockIndex]);
            var blockEnd = blockIndex + 1 < anim.BlockOffsets.Length
                ? checked((int)anim.BlockOffsets[blockIndex + 1])
                : anim.Data.Length;
            if (blockStart < 0 || blockEnd > anim.Data.Length || blockStart >= blockEnd)
                throw new InvalidDataException($"ACTION_SPLINE_BLOCK_BOUNDS_INVALID: block={blockIndex} start={blockStart} end={blockEnd} dataLength={anim.Data.Length}.");

            var blockBytes = anim.Data.AsSpan(blockStart, blockEnd - blockStart).ToArray();
            HkxNativeAnimation.TransformTrack[] parsedTracks;
            try
            {
                var parsed = HkxNativeAnimation.ReadSplineCompressedAnimByteBlock(
                    blockBytes,
                    anim.NumberOfTransformTracks,
                    numBlocks: 1);
                if (parsed.Count != 1 || parsed[0].Length != anim.NumberOfTransformTracks)
                    throw new InvalidDataException("decoded track count does not match animation metadata");
                parsedTracks = parsed[0];
            }
            catch (Exception ex) when (ex is InvalidDataException or EndOfStreamException or IOException or ArgumentException)
            {
                throw new InvalidDataException(
                    $"ACTION_SPLINE_BLOCK_DECODE_FAILED: block={blockIndex} start={blockStart} length={blockBytes.Length}: {ex.Message}",
                    ex);
            }

            blocks[blockIndex] = new SplineBlock
            {
                Tracks = parsedTracks.Select((track, trackIndex) => ConvertSplineTrack(track, blockIndex, trackIndex)).ToArray()
            };
        }

        return blocks;
    }

    private static TransformSplineTrack ConvertSplineTrack(
        HkxNativeAnimation.TransformTrack source,
        int blockIndex,
        int trackIndex)
    {
        if (source.Mask == null)
            throw new InvalidDataException($"ACTION_SPLINE_TRACK_MASK_MISSING: block={blockIndex} track={trackIndex}.");

        var position = source.SplinePosition;
        var scale = source.SplineScale;
        var result = new TransformSplineTrack
        {
            PositionMask = BuildMask(source.Mask.PositionTypes),
            PositionStaticMask = BuildMask(source.Mask.PositionTypes.Where(flag => IsStaticFlag(flag)).ToArray()),
            PositionSplineMask = BuildMask(source.Mask.PositionTypes.Where(flag => !IsStaticFlag(flag)).ToArray()),
            RotationMask = BuildMask(source.Mask.RotationTypes),
            RotationHasStatic = source.Mask.RotationTypes.Any(IsStaticFlag),
            RotationHasSpline = source.Mask.RotationTypes.Any(flag => !IsStaticFlag(flag)),
            ScaleMask = BuildMask(source.Mask.ScaleTypes),
            ScaleStaticMask = BuildMask(source.Mask.ScaleTypes.Where(flag => IsStaticFlag(flag)).ToArray()),
            ScaleSplineMask = BuildMask(source.Mask.ScaleTypes.Where(flag => !IsStaticFlag(flag)).ToArray()),
            PositionQuantizationType = (int)source.Mask.PositionQuantizationType,
            RotationQuantizationType = (int)source.Mask.RotationQuantizationType,
            ScaleQuantizationType = (int)source.Mask.ScaleQuantizationType,
            StaticPosition = new Vector3(
                ReadStatic(position?.ChannelX, source.StaticPosition.X, "positionX", blockIndex, trackIndex),
                ReadStatic(position?.ChannelY, source.StaticPosition.Y, "positionY", blockIndex, trackIndex),
                ReadStatic(position?.ChannelZ, source.StaticPosition.Z, "positionZ", blockIndex, trackIndex)),
            StaticRotation = source.StaticRotation,
            StaticScale = new Vector3(
                ReadStatic(scale?.ChannelX, source.StaticScale.X, "scaleX", blockIndex, trackIndex),
                ReadStatic(scale?.ChannelY, source.StaticScale.Y, "scaleY", blockIndex, trackIndex),
                ReadStatic(scale?.ChannelZ, source.StaticScale.Z, "scaleZ", blockIndex, trackIndex))
        };

        if (position != null)
        {
            result.PositionX = ConvertScalarCurve(position, position.ChannelX, "positionX", blockIndex, trackIndex);
            result.PositionY = ConvertScalarCurve(position, position.ChannelY, "positionY", blockIndex, trackIndex);
            result.PositionZ = ConvertScalarCurve(position, position.ChannelZ, "positionZ", blockIndex, trackIndex);
        }
        if (source.SplineRotation != null)
        {
            var rotation = source.SplineRotation;
            ValidateSplineShape(rotation.Knots, rotation.Channel.Values.Count, rotation.Degree, "rotation", blockIndex, trackIndex);
            result.Rotation = new SplineQuatCurve
            {
                Degree = rotation.Degree,
                Knots = rotation.Knots.Select(value => (float)value).ToArray(),
                ControlPoints = rotation.Channel.Values.ToArray()
            };
        }
        if (scale != null)
        {
            result.ScaleX = ConvertScalarCurve(scale, scale.ChannelX, "scaleX", blockIndex, trackIndex);
            result.ScaleY = ConvertScalarCurve(scale, scale.ChannelY, "scaleY", blockIndex, trackIndex);
            result.ScaleZ = ConvertScalarCurve(scale, scale.ChannelZ, "scaleZ", blockIndex, trackIndex);
        }

        return result;
    }

    private static byte BuildMask(IReadOnlyList<HkxNativeAnimation.FlagOffset> flags)
    {
        byte result = 0;
        foreach (var flag in flags) result |= (byte)flag;
        return result;
    }

    private static bool IsStaticFlag(HkxNativeAnimation.FlagOffset flag) =>
        flag is HkxNativeAnimation.FlagOffset.StaticX
            or HkxNativeAnimation.FlagOffset.StaticY
            or HkxNativeAnimation.FlagOffset.StaticZ
            or HkxNativeAnimation.FlagOffset.StaticW;

    private static float ReadStatic(
        HkxNativeAnimation.SplineChannel<float>? channel,
        float fallback,
        string component,
        int blockIndex,
        int trackIndex)
    {
        if (channel == null || channel.IsDynamic) return fallback;
        if (channel.Values.Count != 1 || !float.IsFinite(channel.Values[0]))
            throw new InvalidDataException($"ACTION_SPLINE_STATIC_VALUE_INVALID: block={blockIndex} track={trackIndex} component={component}.");
        return channel.Values[0];
    }

    private static SplineCurve? ConvertScalarCurve(
        HkxNativeAnimation.SplineTrackVector3 vector,
        HkxNativeAnimation.SplineChannel<float>? channel,
        string component,
        int blockIndex,
        int trackIndex)
    {
        if (channel == null || !channel.IsDynamic) return null;
        ValidateSplineShape(vector.Knots, channel.Values.Count, vector.Degree, component, blockIndex, trackIndex);
        return new SplineCurve
        {
            Degree = vector.Degree,
            Knots = vector.Knots.Select(value => (float)value).ToArray(),
            ControlPoints = channel.Values.ToArray()
        };
    }

    private static void ValidateSplineShape(
        IReadOnlyList<byte> knots,
        int controlPointCount,
        int degree,
        string component,
        int blockIndex,
        int trackIndex)
    {
        if (degree < 0 || degree > 4 || controlPointCount <= 0 || knots.Count != controlPointCount + degree + 1)
            throw new InvalidDataException($"ACTION_SPLINE_KNOT_VECTOR_INVALID: block={blockIndex} track={trackIndex} component={component} degree={degree} knots={knots.Count} controlPoints={controlPointCount}.");
        for (var i = 1; i < knots.Count; i++)
        {
            if (knots[i] < knots[i - 1])
                throw new InvalidDataException($"ACTION_SPLINE_KNOT_ORDER_INVALID: block={blockIndex} track={trackIndex} component={component} index={i}.");
        }
    }

    private static string? ReadStringPtr(HkxPackfile packfile, uint pointerOffset)
    {
        if (!packfile.DataSection.LocalFixupMap.TryGetValue(pointerOffset, out var targetOffset))
            return null;

        var data = packfile.DataSection.SectionData;
        if (targetOffset >= data.Length) return null;

        int nullIdx = Array.IndexOf(data, (byte)0, (int)targetOffset);
        if (nullIdx < 0) nullIdx = data.Length;
        int len = nullIdx - (int)targetOffset;
        return len > 0 ? Encoding.UTF8.GetString(data, (int)targetOffset, len) : string.Empty;
    }

    private static short[] ReadInt16Array(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        var data = packfile.DataSection.SectionData;
        if (arrayHeaderOffset + 16 > data.Length) return Array.Empty<short>();

        int size = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan((int)arrayHeaderOffset + 8, 4));
        if (size <= 0) return Array.Empty<short>();

        if (!packfile.DataSection.LocalFixupMap.TryGetValue(arrayHeaderOffset, out var dataOffset))
            return Array.Empty<short>();

        if (dataOffset + size * 2 > data.Length) return Array.Empty<short>();

        var result = new short[size];
        for (int i = 0; i < size; i++)
        {
            result[i] = BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan((int)dataOffset + i * 2, 2));
        }
        return result;
    }

    private static uint[] ReadUInt32Array(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        var data = packfile.DataSection.SectionData;
        if (arrayHeaderOffset + 16 > data.Length) return Array.Empty<uint>();

        int size = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan((int)arrayHeaderOffset + 8, 4));
        if (size <= 0) return Array.Empty<uint>();

        if (!packfile.DataSection.LocalFixupMap.TryGetValue(arrayHeaderOffset, out var dataOffset))
            return Array.Empty<uint>();

        if (dataOffset + size * 4 > data.Length) return Array.Empty<uint>();

        var result = new uint[size];
        for (int i = 0; i < size; i++)
        {
            result[i] = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan((int)dataOffset + i * 4, 4));
        }
        return result;
    }

    private static byte[] ReadByteArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        var data = packfile.DataSection.SectionData;
        if (arrayHeaderOffset + 16 > data.Length) return Array.Empty<byte>();

        int size = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan((int)arrayHeaderOffset + 8, 4));
        if (size <= 0) return Array.Empty<byte>();

        if (!packfile.DataSection.LocalFixupMap.TryGetValue(arrayHeaderOffset, out var dataOffset))
            return Array.Empty<byte>();

        if (dataOffset + size > data.Length) return Array.Empty<byte>();

        var result = new byte[size];
        Array.Copy(data, (int)dataOffset, result, 0, size);
        return result;
    }

    private static HkxBone[] ReadBoneArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        var data = packfile.DataSection.SectionData;
        if (arrayHeaderOffset + 16 > data.Length) return Array.Empty<HkxBone>();

        int size = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan((int)arrayHeaderOffset + 8, 4));
        if (size <= 0) return Array.Empty<HkxBone>();

        if (!packfile.DataSection.LocalFixupMap.TryGetValue(arrayHeaderOffset, out var dataOffset))
            return Array.Empty<HkxBone>();

        var result = new HkxBone[size];
        for (int i = 0; i < size; i++)
        {
            uint boneOffset = (uint)(dataOffset + i * 16);
            string name = ReadStringPtr(packfile, boneOffset) ?? string.Empty;
            bool lockTrans = boneOffset + 8 < data.Length && data[boneOffset + 8] != 0;
            result[i] = new HkxBone { Name = name, LockTranslation = lockTrans };
        }
        return result;
    }

    private static BoneTransform[] ReadQsTransformArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        var data = packfile.DataSection.SectionData;
        if (arrayHeaderOffset + 16 > data.Length) return Array.Empty<BoneTransform>();

        int size = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan((int)arrayHeaderOffset + 8, 4));
        if (size <= 0) return Array.Empty<BoneTransform>();

        if (!packfile.DataSection.LocalFixupMap.TryGetValue(arrayHeaderOffset, out var dataOffset))
            return Array.Empty<BoneTransform>();

        if (dataOffset + size * 48 > data.Length) return Array.Empty<BoneTransform>();

        var result = new BoneTransform[size];
        for (int i = 0; i < size; i++)
        {
            int p = (int)(dataOffset + i * 48);
            float tx = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 0, 4));
            float ty = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 4, 4));
            float tz = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 8, 4));

            float rx = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 16, 4));
            float ry = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 20, 4));
            float rz = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 24, 4));
            float rw = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 28, 4));

            float sx = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 32, 4));
            float sy = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 36, 4));
            float sz = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(p + 40, 4));

            result[i] = new BoneTransform(
                new Vector3(tx, ty, tz),
                Quaternion.Normalize(new Quaternion(rx, ry, rz, rw)),
                new Vector3(sx, sy, sz)
            );
        }
        return result;
    }
}

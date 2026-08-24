// MIT License
// Copyright (c) 2026 SoulForge Authors
// High-level reader for Havok animation structures from HKX packfiles.
// The reader is deliberately checked and fail-closed: a malformed or
// unverified codec never becomes an identity pose.

using System.Buffers.Binary;
using System.Numerics;
using System.Text;

namespace SoulForge.Bridge.Hkx;

internal static class HkxAnimationReader
{
    private const int PointerSize64 = 8;

    [Flags]
    private enum TransformChannel : byte
    {
        StaticX = 0x01,
        StaticY = 0x02,
        StaticZ = 0x04,
        StaticW = 0x08,
        SplineX = 0x10,
        SplineY = 0x20,
        SplineZ = 0x40,
        SplineW = 0x80
    }

    private readonly record struct TransformMask(
        byte PositionQuantization,
        byte RotationQuantization,
        byte ScaleQuantization,
        byte Position,
        byte Rotation,
        byte Scale);

    public static HkxAnimationContainer ReadContainer(byte[] hkxBytes, byte[]? compendiumBytes = null)
    {
        if (hkxBytes is null || hkxBytes.Length < 4)
            throw new InvalidDataException("HKX input is shorter than its format marker.");

        if (BinaryPrimitives.ReadUInt32LittleEndian(hkxBytes.AsSpan(0, 4)) == HkxPackfile.Magic0)
            return ReadPackfileContainer(hkxBytes);

        bool isTagfile = hkxBytes.Length >= 8
            && (Encoding.ASCII.GetString(hkxBytes, 4, 4) is "TAG0" or "TCM0"
                || Encoding.ASCII.GetString(hkxBytes, 0, 4) is "TAG0" or "TCM0");
        if (isTagfile)
            return HkxTagfileReader.ReadTagfile(hkxBytes, compendiumBytes);

        uint marker = BinaryPrimitives.ReadUInt32LittleEndian(hkxBytes.AsSpan(0, 4));
        throw new InvalidDataException($"未知或不受支持的 HKX 格式标头（首 4 字节：0x{marker:X8}）。");
    }

    private static HkxAnimationContainer ReadPackfileContainer(byte[] hkxBytes)
    {
        var packfile = HkxPackfile.Read(hkxBytes);
        var dataSection = packfile.DataSection;
        var data = dataSection.SectionData;

        var skeletons = new List<HkxSkeleton>();
        var animations = new List<HkxAnimation>();
        var bindings = new List<HkxAnimationBinding>();
        var seenSkeletonOffsets = new HashSet<int>();
        var seenBindingOffsets = new HashSet<int>();
        var animationsByOffset = new Dictionary<int, HkxAnimation>();

        foreach (var fixup in dataSection.VirtualFixups)
        {
            if (fixup.Src > int.MaxValue) continue;
            int objectOffset = (int)fixup.Src;
            string? className = packfile.GetClassNameAtVirtualOffset(fixup.Src);
            if (className is null) continue;

            if (className == "hkaSkeleton")
            {
                if (!seenSkeletonOffsets.Add(objectOffset)) continue;
                skeletons.Add(ReadSkeleton(packfile, objectOffset)
                    ?? throw new InvalidDataException($"hkaSkeleton at 0x{objectOffset:X} could not be decoded."));
            }
            else if (className is "hkaSplineCompressedAnimation"
                or "hkaInterleavedUncompressedAnimation"
                or "hkaAnimation")
            {
                if (animationsByOffset.ContainsKey(objectOffset)) continue;
                var animation = ReadAnimation(packfile, objectOffset, className)
                    ?? throw new InvalidDataException($"{className} at 0x{objectOffset:X} could not be decoded.");
                animationsByOffset.Add(objectOffset, animation);
                animations.Add(animation);
            }
        }

        foreach (var fixup in dataSection.VirtualFixups)
        {
            if (fixup.Src > int.MaxValue) continue;
            int objectOffset = (int)fixup.Src;
            string? className = packfile.GetClassNameAtVirtualOffset(fixup.Src);
            if (className != "hkaAnimationBinding" || !seenBindingOffsets.Add(objectOffset)) continue;

            var binding = ReadBinding(packfile, objectOffset, animationsByOffset);
            bindings.Add(binding ?? throw new InvalidDataException(
                $"hkaAnimationBinding at 0x{objectOffset:X} could not be decoded."));
        }

        if (animations.Count == 0 && bindings.Count > 0)
            throw new InvalidDataException("HKX contains bindings but no decodable animation object.");
        foreach (var binding in bindings)
        {
            if (binding.Animation is null)
                throw new InvalidDataException("HKX animation binding has no explicit animation pointer.");
        }

        return new HkxAnimationContainer
        {
            SourceFormat = "packfile",
            Skeletons = skeletons,
            Animations = animations,
            Bindings = bindings
        };
    }

    public static HkxSkeleton? ReadSkeleton(HkxPackfile packfile, int offset)
    {
        var data = packfile.DataSection.SectionData;
        RequireRange(data, offset, 0x48, "hkaSkeleton");

        string name = ReadStringPtr(packfile, (uint)(offset + 0x10))
            ?? throw new InvalidDataException($"hkaSkeleton at 0x{offset:X} has no name pointer.");
        var parentIndices = ReadInt16Array(packfile, (uint)(offset + 0x18));
        var bones = ReadBoneArray(packfile, (uint)(offset + 0x28));
        var transforms = ReadQsTransformArray(packfile, (uint)(offset + 0x38));

        if (bones.Length == 0)
            throw new InvalidDataException($"hkaSkeleton '{name}' has no bones.");
        if (parentIndices.Length != bones.Length)
            throw new InvalidDataException(
                $"hkaSkeleton '{name}' parent-index count mismatch: parents={parentIndices.Length}, bones={bones.Length}.");
        if (transforms.Length != bones.Length)
            throw new InvalidDataException(
                $"hkaSkeleton '{name}' reference-pose count mismatch: transforms={transforms.Length}, bones={bones.Length}.");
        for (int i = 0; i < parentIndices.Length; i++)
        {
            short parent = parentIndices[i];
            if (parent < -1 || parent >= bones.Length)
                throw new InvalidDataException($"hkaSkeleton '{name}' has invalid parent index {parent} at bone {i}.");
        }

        return new HkxSkeleton
        {
            Name = name,
            ParentIndices = parentIndices,
            Bones = bones,
            Transforms = transforms
        };
    }

    public static HkxAnimationBinding? ReadBinding(HkxPackfile packfile, int offset)
    {
        return ReadBinding(packfile, offset, new Dictionary<int, HkxAnimation>());
    }

    private static HkxAnimationBinding? ReadBinding(
        HkxPackfile packfile,
        int offset,
        IDictionary<int, HkxAnimation> animationsByOffset)
    {
        var data = packfile.DataSection.SectionData;
        // 64-bit packfile layout: transform map @0x20, float map @0x30,
        // optional partition map @0x40, blend hint @0x50.
        RequireRange(data, offset, 0x51, "hkaAnimationBinding");

        string originalSkeletonName = ReadStringPtr(packfile, (uint)(offset + 0x10)) ?? string.Empty;
        if (!packfile.DataSection.LocalFixupMap.TryGetValue((uint)(offset + 0x18), out uint animationOffset))
            throw new InvalidDataException($"hkaAnimationBinding at 0x{offset:X} has no animation pointer fixup.");
        if (animationOffset > int.MaxValue)
            throw new InvalidDataException($"hkaAnimationBinding at 0x{offset:X} has an invalid animation offset.");

        string animationClass = packfile.GetClassNameAtVirtualOffset(animationOffset)
            ?? throw new InvalidDataException($"HKX animation pointer 0x{animationOffset:X} has no class fixup.");
        if (!animationsByOffset.TryGetValue((int)animationOffset, out var animation))
        {
            animation = ReadAnimation(packfile, (int)animationOffset, animationClass)
                ?? throw new InvalidDataException($"HKX animation at 0x{animationOffset:X} could not be decoded.");
            animationsByOffset.Add((int)animationOffset, animation);
        }

        var trackToBone = ReadInt16Array(packfile, (uint)(offset + 0x20))
            .Select(static value => (int)value)
            .ToArray();
        if (trackToBone.Length != animation.NumberOfTransformTracks)
            throw new InvalidDataException(
                $"HKX binding track count mismatch: binding={trackToBone.Length}, animation={animation.NumberOfTransformTracks}.");

        var floatTrackToSlot = ReadInt16Array(packfile, (uint)(offset + 0x30))
            .Select(static value => (int)value)
            .ToArray();
        if (floatTrackToSlot.Length != animation.NumberOfFloatTracks)
            throw new InvalidDataException(
                $"HKX binding float-track count mismatch: binding={floatTrackToSlot.Length}, animation={animation.NumberOfFloatTracks}.");

        var partitionIndices = ReadInt16Array(packfile, (uint)(offset + 0x40))
            .Select(static value => (int)value)
            .ToArray();
        int blendHint = data[offset + 0x50];
        if (blendHint is not 0 and not 1 and not 2)
            throw new NotSupportedException(
                $"HKX binding uses unsupported blend hint {blendHint}; only NORMAL (0) and ADDITIVE (1/2) are recognized.");

        return new HkxAnimationBinding
        {
            OriginalSkeletonName = originalSkeletonName,
            TransformTrackToBoneIndices = trackToBone,
            FloatTrackToFloatSlotIndices = floatTrackToSlot,
            PartitionIndices = partitionIndices,
            BlendHint = blendHint,
            Animation = animation
        };
    }

    public static HkxAnimation? ReadAnimation(HkxPackfile packfile, int offset, string className)
    {
        var data = packfile.DataSection.SectionData;
        RequireRange(data, offset, 0x20, className);

        int animTypeValue = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x10, 4));
        var animationType = (HkxAnimationType)animTypeValue;
        float duration = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(offset + 0x14, 4));
        int numTracks = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x18, 4));
        int numFloatTracks = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 0x1C, 4));

        if (!float.IsFinite(duration) || duration <= 0f)
            throw new InvalidDataException($"{className} has an invalid duration {duration}.");
        if (numTracks <= 0 || numFloatTracks < 0)
            throw new InvalidDataException(
                $"{className} has invalid track counts: transforms={numTracks}, floats={numFloatTracks}.");

        var extractedMotion = ReadExtractedMotion(packfile, (uint)(offset + 0x20), className);

        if (className == "hkaSplineCompressedAnimation")
        {
            if (animationType != HkxAnimationType.SplineCompressed)
                throw new InvalidDataException(
                    $"hkaSplineCompressedAnimation type field is {animTypeValue}, not { (int)HkxAnimationType.SplineCompressed }.");
            return ReadSplineCompressedAnimation(packfile, offset, duration, numTracks, numFloatTracks, extractedMotion);
        }
        if (className == "hkaInterleavedUncompressedAnimation")
        {
            if (animationType != HkxAnimationType.Interleaved)
                throw new InvalidDataException(
                    $"hkaInterleavedUncompressedAnimation type field is {animTypeValue}, not { (int)HkxAnimationType.Interleaved }.");
            return ReadInterleavedAnimation(packfile, offset, duration, numTracks, numFloatTracks, extractedMotion);
        }

        throw new NotSupportedException($"未支持的 HKX 动画类型：{className} (type={animTypeValue})。");
    }

    private static HkxExtractedMotion? ReadExtractedMotion(
        HkxPackfile packfile,
        uint pointerFieldOffset,
        string animationClassName)
    {
        if (!packfile.DataSection.LocalFixupMap.TryGetValue(pointerFieldOffset, out uint referenceFrameOffset))
            return null;
        if (referenceFrameOffset > int.MaxValue)
            throw new InvalidDataException(
                $"{animationClassName}.extractedMotion points outside the supported __data__ range.");

        string referenceFrameClassName = packfile.GetClassNameAtVirtualOffset(referenceFrameOffset)
            ?? throw new InvalidDataException(
                $"{animationClassName}.extractedMotion points to an object without a Havok class fixup.");
        if (referenceFrameClassName != "hkaDefaultAnimatedReferenceFrame")
            throw new NotSupportedException(
                $"{animationClassName}.extractedMotion uses unsupported reference-frame class '{referenceFrameClassName}'.");

        var data = packfile.DataSection.SectionData;
        int offset = (int)referenceFrameOffset;
        RequireRange(data, offset, 0x60, "hkaDefaultAnimatedReferenceFrame");
        int frameType = ReadInt32(data, offset + 0x18);
        if (frameType is < 0 or > 2)
            throw new NotSupportedException(
                $"hkaDefaultAnimatedReferenceFrame uses unsupported frame type {frameType}.");

        var up = ReadVector4(data, offset + 0x20, "hkaDefaultAnimatedReferenceFrame.up");
        var forward = ReadVector4(data, offset + 0x30, "hkaDefaultAnimatedReferenceFrame.forward");
        float duration = ReadSingle(data, offset + 0x40);
        if (!float.IsFinite(duration) || duration <= 0f)
            throw new InvalidDataException(
                $"hkaDefaultAnimatedReferenceFrame has invalid duration {duration}.");

        int sampleCount = ReadArraySize(packfile, (uint)(offset + 0x48), "reference-frame sample array");
        if (sampleCount <= 0)
            throw new InvalidDataException("hkaDefaultAnimatedReferenceFrame has no reference-frame samples.");
        uint sampleDataOffset = ReadArrayDataOffset(
            packfile,
            (uint)(offset + 0x48),
            checked(sampleCount * 16),
            "reference-frame sample array");
        var samples = new HkxReferenceFrameSample[sampleCount];
        for (int i = 0; i < sampleCount; i++)
        {
            var raw = ReadVector4(
                data,
                checked((int)sampleDataOffset + i * 16),
                $"hkaDefaultAnimatedReferenceFrame.referenceFrameSamples[{i}]");
            samples[i] = new HkxReferenceFrameSample(raw);
        }

        return new HkxExtractedMotion
        {
            FrameType = frameType,
            Up = up,
            Forward = forward,
            Duration = duration,
            Samples = samples
        };
    }

    private static void ValidateExtractedMotion(
        HkxExtractedMotion? extractedMotion,
        float animationDuration,
        int frameCount,
        string animationClassName)
    {
        if (extractedMotion is null)
            return;
        if (extractedMotion.Samples.Length != frameCount)
            throw new InvalidDataException(
                $"{animationClassName}.extractedMotion sample count mismatch: "
                + $"samples={extractedMotion.Samples.Length}, animationFrames={frameCount}.");
        if (MathF.Abs(extractedMotion.Duration - animationDuration) > MathF.Max(1e-3f, animationDuration * 1e-3f))
            throw new InvalidDataException(
                $"{animationClassName}.extractedMotion duration mismatch: "
                + $"motion={extractedMotion.Duration}, animation={animationDuration}.");
    }

    private static HkxSplineCompressedAnimation ReadSplineCompressedAnimation(
        HkxPackfile packfile,
        int offset,
        float duration,
        int numTracks,
        int numFloatTracks,
        HkxExtractedMotion? extractedMotion)
    {
        var data = packfile.DataSection.SectionData;
        RequireRange(data, offset, 0xA8, "hkaSplineCompressedAnimation");

        int numFrames = ReadInt32(data, offset + 0x38);
        int numBlocks = ReadInt32(data, offset + 0x3C);
        int maxFramesPerBlock = ReadInt32(data, offset + 0x40);
        int maskAndQuantSize = ReadInt32(data, offset + 0x44);
        float blockDuration = ReadSingle(data, offset + 0x48);
        float blockInverseDuration = ReadSingle(data, offset + 0x4C);
        float frameDuration = ReadSingle(data, offset + 0x50);

        if (numFrames <= 0 || numBlocks <= 0 || maxFramesPerBlock <= 0 || maskAndQuantSize <= 0)
            throw new InvalidDataException(
                $"hkaSplineCompressedAnimation has invalid block metadata: frames={numFrames}, blocks={numBlocks}, maxFrames={maxFramesPerBlock}, maskBytes={maskAndQuantSize}.");
        if (!float.IsFinite(blockDuration) || !float.IsFinite(blockInverseDuration)
            || !float.IsFinite(frameDuration) || frameDuration <= 0f)
            throw new InvalidDataException("hkaSplineCompressedAnimation has non-finite block or frame timing.");
        if (numFloatTracks != 0)
            throw new NotSupportedException("HKX float animation tracks are not yet wired into the ACTION clip contract.");

        // The 64-bit Havok layout places these hkArrays at 0x58, 0x68, 0x78,
        // 0x88 and 0x98 respectively. transformOffsets are optional in the
        // Sekiro stream; when present they are block-relative units of 4 bytes.
        var blockOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x58));
        var floatBlockOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x68));
        var transformOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x78));
        var floatOffsets = ReadUInt32Array(packfile, (uint)(offset + 0x88));
        var animationData = ReadByteArray(packfile, (uint)(offset + 0x98));

        if (blockOffsets.Length != numBlocks)
            throw new InvalidDataException(
                $"hkaSplineCompressedAnimation block-offset count mismatch: expected={numBlocks}, actual={blockOffsets.Length}.");
        if (transformOffsets.Length != 0 && transformOffsets.Length != numTracks)
            throw new InvalidDataException(
                $"hkaSplineCompressedAnimation transform-offset count mismatch: expected 0 or {numTracks}, actual={transformOffsets.Length}.");
        if (floatBlockOffsets.Length != 0 || floatOffsets.Length != 0)
            throw new InvalidDataException("HKX float offset arrays are present although the clip declares no float tracks.");
        if (animationData.Length == 0)
            throw new InvalidDataException("hkaSplineCompressedAnimation data array is empty.");
        ValidateExtractedMotion(extractedMotion, duration, numFrames, "hkaSplineCompressedAnimation");

        var animation = new HkxSplineCompressedAnimation
        {
            AnimationType = HkxAnimationType.SplineCompressed,
            Duration = duration,
            NumberOfTransformTracks = numTracks,
            NumberOfFloatTracks = numFloatTracks,
            HasExtractedMotion = extractedMotion is not null,
            ExtractedMotion = extractedMotion,
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
            Data = animationData
        };
        animation.Blocks = ParseSplineBlocks(animation);
        return animation;
    }

    private static HkxInterleavedAnimation ReadInterleavedAnimation(
        HkxPackfile packfile,
        int offset,
        float duration,
        int numTracks,
        int numFloatTracks,
        HkxExtractedMotion? extractedMotion)
    {
        var data = packfile.DataSection.SectionData;
        RequireRange(data, offset, 0x58, "hkaInterleavedUncompressedAnimation");

        // hkaAnimation has extractedMotion at 0x20 and annotationTracks at
        // 0x28; the interleaved subclass starts its transforms at 0x38.
        var transforms = ReadQsTransformArray(packfile, (uint)(offset + 0x38));
        if (transforms.Length == 0 || transforms.Length % numTracks != 0)
            throw new InvalidDataException(
                $"hkaInterleavedUncompressedAnimation transform array is not divisible by its track count: transforms={transforms.Length}, tracks={numTracks}.");
        int numFrames = transforms.Length / numTracks;
        if (numFrames <= 0)
            throw new InvalidDataException("hkaInterleavedUncompressedAnimation has no frames.");
        ValidateExtractedMotion(extractedMotion, duration, numFrames, "hkaInterleavedUncompressedAnimation");

        if (numFloatTracks > 0)
            throw new NotSupportedException("HKX float animation tracks are not yet wired into the ACTION clip contract.");

        float frameDuration = numFrames > 1 ? duration / (numFrames - 1) : duration;
        if (!float.IsFinite(frameDuration) || frameDuration <= 0f)
            throw new InvalidDataException("hkaInterleavedUncompressedAnimation has an invalid frame duration.");

        return new HkxInterleavedAnimation
        {
            AnimationType = HkxAnimationType.Interleaved,
            Duration = duration,
            NumberOfTransformTracks = numTracks,
            NumberOfFloatTracks = numFloatTracks,
            HasExtractedMotion = extractedMotion is not null,
            ExtractedMotion = extractedMotion,
            NumFrames = numFrames,
            FrameDuration = frameDuration,
            Transforms = transforms
        };
    }

    internal static SplineBlock[] ParseSplineBlocks(HkxSplineCompressedAnimation animation)
    {
        if (animation.BlockOffsets.Length != animation.NumBlocks)
            throw new InvalidDataException("HKX spline block offsets are incomplete.");

        var blocks = new SplineBlock[animation.NumBlocks];
        for (int blockIndex = 0; blockIndex < animation.NumBlocks; blockIndex++)
        {
            int blockStart = ToIntOffset(animation.BlockOffsets[blockIndex], "spline block start");
            int blockEnd = blockIndex + 1 < animation.NumBlocks
                ? ToIntOffset(animation.BlockOffsets[blockIndex + 1], "spline block end")
                : animation.Data.Length;
            if (blockStart < 0 || blockStart >= animation.Data.Length || blockEnd <= blockStart
                || blockEnd > animation.Data.Length)
                throw new InvalidDataException(
                    $"HKX spline block {blockIndex} bounds are invalid: start={blockStart}, end={blockEnd}, data={animation.Data.Length}.");

            int maskEnd = checked(blockStart + animation.MaskAndQuantizationSize);
            if (maskEnd > blockEnd)
                throw new InvalidDataException(
                    $"HKX spline block {blockIndex} mask region exceeds the block: maskEnd={maskEnd}, blockEnd={blockEnd}.");

            var maskReader = new CheckedReader(animation.Data, blockStart, maskEnd);
            var masks = new TransformMask[animation.NumberOfTransformTracks];
            for (int trackIndex = 0; trackIndex < masks.Length; trackIndex++)
                masks[trackIndex] = ReadTransformMask(maskReader, trackIndex);
            maskReader.Align(4);
            if (maskReader.Position > maskEnd)
                throw new InvalidDataException($"HKX spline block {blockIndex} mask region is truncated.");

            var tracks = new TransformSplineTrack[animation.NumberOfTransformTracks];
            if (animation.TransformOffsets.Length == 0)
            {
                var reader = new CheckedReader(animation.Data, maskEnd, blockEnd);
                for (int trackIndex = 0; trackIndex < masks.Length; trackIndex++)
                    tracks[trackIndex] = ReadTransformTrack(reader, masks[trackIndex], trackIndex);
                reader.Align(16);
                if (reader.Position != blockEnd)
                    throw new InvalidDataException(
                        $"HKX spline block {blockIndex} has an unparsed transform payload: cursor={reader.Position}, end={blockEnd}.");
            }
            else
            {
                var trackStarts = new int[masks.Length];
                for (int trackIndex = 0; trackIndex < masks.Length; trackIndex++)
                {
                    ulong relativeBytes = (ulong)animation.TransformOffsets[trackIndex] * 4UL;
                    if (relativeBytes > int.MaxValue)
                        throw new InvalidDataException($"HKX spline track {trackIndex} offset overflows the reader.");
                    int trackStart = checked(blockStart + (int)relativeBytes);
                    if (trackStart < maskEnd || trackStart >= blockEnd)
                        throw new InvalidDataException(
                            $"HKX spline track {trackIndex} offset {trackStart} is outside block {blockIndex}.");
                    trackStarts[trackIndex] = trackStart;
                }

                for (int trackIndex = 0; trackIndex < masks.Length; trackIndex++)
                {
                    int nextStart = blockEnd;
                    for (int other = 0; other < trackStarts.Length; other++)
                    {
                        if (trackStarts[other] > trackStarts[trackIndex])
                            nextStart = Math.Min(nextStart, trackStarts[other]);
                    }
                    var reader = new CheckedReader(animation.Data, trackStarts[trackIndex], nextStart);
                    tracks[trackIndex] = ReadTransformTrack(reader, masks[trackIndex], trackIndex);
                    reader.Align(4);
                    if (reader.Position > nextStart)
                        throw new InvalidDataException(
                            $"HKX spline track {trackIndex} overlaps the next transform offset.");
                }

                int maxTrackEnd = tracks.Length == 0 ? maskEnd : trackStarts.Max();
                _ = maxTrackEnd;
            }

            blocks[blockIndex] = new SplineBlock { Tracks = tracks };
        }
        return blocks;
    }

    private static TransformMask ReadTransformMask(CheckedReader reader, int trackIndex)
    {
        byte packedQuantization = reader.ReadByte();
        byte position = reader.ReadByte();
        byte rotation = reader.ReadByte();
        byte scale = reader.ReadByte();

        byte positionQuantization = (byte)(packedQuantization & 0x03);
        byte rotationQuantization = (byte)((packedQuantization >> 2) & 0x0F);
        byte scaleQuantization = (byte)((packedQuantization >> 6) & 0x03);
        if (positionQuantization > 1 || scaleQuantization > 1)
            throw new NotSupportedException(
                $"HKX spline track {trackIndex} uses an unsupported scalar quantization ({positionQuantization}/{scaleQuantization}).");
        if (rotationQuantization > 5)
            throw new NotSupportedException(
                $"HKX spline track {trackIndex} uses an unsupported rotation quantization {rotationQuantization}.");
        if ((position & 0x88) != 0 || (scale & 0x88) != 0)
            throw new InvalidDataException(
                $"HKX spline track {trackIndex} has unsupported vector-mask bits: position=0x{position:X2}, scale=0x{scale:X2}. "
                + "The raw W channel must be explicitly classified before it can be projected.");

        return new TransformMask(
            positionQuantization,
            rotationQuantization,
            scaleQuantization,
            position,
            rotation,
            scale);
    }

    private static TransformSplineTrack ReadTransformTrack(
        CheckedReader reader,
        TransformMask mask,
        int trackIndex)
    {
        var track = new TransformSplineTrack
        {
            PositionMask = mask.Position,
            RotationMask = mask.Rotation,
            ScaleMask = mask.Scale,
            StaticPosition = Vector3.Zero,
            StaticRotation = Quaternion.Identity,
            StaticScale = Vector3.One
        };

        bool hasPositionSpline = HasSpline(mask.Position);
        if (hasPositionSpline)
        {
            var vector = ReadVectorSpline(reader, mask.Position, mask.PositionQuantization, true, trackIndex);
            track.PositionStaticMask = vector.StaticMask;
            track.PositionSplineMask = vector.SplineMask;
            track.StaticPosition = vector.StaticValue;
            track.PositionX = vector.X;
            track.PositionY = vector.Y;
            track.PositionZ = vector.Z;
        }
        else
        {
            var staticPosition = track.StaticPosition;
            track.PositionStaticMask = ReadStaticVector(reader, mask.Position, ref staticPosition);
            track.StaticPosition = staticPosition;
        }
        reader.Align(4);

        bool hasRotationSpline = HasSpline(mask.Rotation);
        bool hasRotationStatic = HasStatic(mask.Rotation);
        // Havok's quaternion sub-track is encoded as one atomically packed
        // quaternion stream whenever any rotation spline bit is present.  The
        // low nibble still records the static/identity classification of the
        // source mask (real Sekiro clips use mixed masks such as 0x5A), but it
        // does not introduce a second scalar payload between the spline header
        // and the packed quaternion controls.  Keep both flags for provenance;
        // consume the complete quaternion stream once and let sampling use the
        // decoded curve rather than fabricating static components.
        track.RotationHasSpline = hasRotationSpline;
        track.RotationHasStatic = hasRotationStatic;
        if (hasRotationSpline)
        {
            track.Rotation = ReadQuaternionSpline(reader, mask.RotationQuantization, trackIndex);
        }
        else if (hasRotationStatic)
        {
            reader.Align(GetRotationAlignment(mask.RotationQuantization));
            track.StaticRotation = ReadQuantizedQuaternion(reader, mask.RotationQuantization, trackIndex);
        }
        reader.Align(4);

        bool hasScaleSpline = HasSpline(mask.Scale);
        if (hasScaleSpline)
        {
            var vector = ReadVectorSpline(reader, mask.Scale, mask.ScaleQuantization, false, trackIndex);
            track.ScaleStaticMask = vector.StaticMask;
            track.ScaleSplineMask = vector.SplineMask;
            track.StaticScale = vector.StaticValue;
            track.ScaleX = vector.X;
            track.ScaleY = vector.Y;
            track.ScaleZ = vector.Z;
        }
        else
        {
            var staticScale = track.StaticScale;
            track.ScaleStaticMask = ReadStaticVector(reader, mask.Scale, ref staticScale);
            track.StaticScale = staticScale;
        }
        reader.Align(4);
        return track;
    }

    private sealed record VectorSplineData(
        byte StaticMask,
        byte SplineMask,
        Vector3 StaticValue,
        SplineCurve? X,
        SplineCurve? Y,
        SplineCurve? Z);

    private static VectorSplineData ReadVectorSpline(
        CheckedReader reader,
        byte mask,
        byte quantization,
        bool isPosition,
        int trackIndex)
    {
        short num = reader.ReadInt16();
        byte degree = reader.ReadByte();
        if (num < 0 || degree > 3)
            throw new InvalidDataException(
                $"HKX spline track {trackIndex} {(isPosition ? "position" : "scale")} has invalid NURBS header: num={num}, degree={degree}.");
        int controlPointCount = num + 1;
        int knotCount = checked(controlPointCount + degree + 1);
        var knots = reader.ReadBytes(knotCount).Select(static value => (float)value).ToArray();
        reader.Align(4);

        var staticValue = isPosition ? Vector3.Zero : Vector3.One;
        byte staticMask = 0;
        byte splineMask = 0;
        float minX = 0f, maxX = 0f, minY = 0f, maxY = 0f, minZ = 0f, maxZ = 0f;
        ReadVectorChannel(reader, mask, TransformChannel.StaticX, TransformChannel.SplineX,
            ref staticValue.X, ref minX, ref maxX, ref staticMask, ref splineMask, 0, trackIndex, isPosition);
        ReadVectorChannel(reader, mask, TransformChannel.StaticY, TransformChannel.SplineY,
            ref staticValue.Y, ref minY, ref maxY, ref staticMask, ref splineMask, 1, trackIndex, isPosition);
        ReadVectorChannel(reader, mask, TransformChannel.StaticZ, TransformChannel.SplineZ,
            ref staticValue.Z, ref minZ, ref maxZ, ref staticMask, ref splineMask, 2, trackIndex, isPosition);

        var valuesX = (splineMask & 0x01) != 0 ? new List<float>(controlPointCount) : null;
        var valuesY = (splineMask & 0x02) != 0 ? new List<float>(controlPointCount) : null;
        var valuesZ = (splineMask & 0x04) != 0 ? new List<float>(controlPointCount) : null;
        for (int i = 0; i < controlPointCount; i++)
        {
            if (valuesX != null) valuesX.Add(ReadQuantizedScalar(reader, minX, maxX, quantization));
            if (valuesY != null) valuesY.Add(ReadQuantizedScalar(reader, minY, maxY, quantization));
            if (valuesZ != null) valuesZ.Add(ReadQuantizedScalar(reader, minZ, maxZ, quantization));
        }

        return new VectorSplineData(
            staticMask,
            splineMask,
            staticValue,
            valuesX == null ? null : new SplineCurve { Degree = degree, Knots = knots, ControlPoints = valuesX.ToArray() },
            valuesY == null ? null : new SplineCurve { Degree = degree, Knots = knots, ControlPoints = valuesY.ToArray() },
            valuesZ == null ? null : new SplineCurve { Degree = degree, Knots = knots, ControlPoints = valuesZ.ToArray() });
    }

    private static void ReadVectorChannel(
        CheckedReader reader,
        byte mask,
        TransformChannel staticFlag,
        TransformChannel splineFlag,
        ref float staticValue,
        ref float min,
        ref float max,
        ref byte staticMask,
        ref byte splineMask,
        int component,
        int trackIndex,
        bool isPosition)
    {
        if ((mask & (byte)splineFlag) != 0)
        {
            min = reader.ReadSingle();
            max = reader.ReadSingle();
            if (!float.IsFinite(min) || !float.IsFinite(max) || max < min)
                throw new InvalidDataException(
                    $"HKX spline track {trackIndex} {(isPosition ? "position" : "scale")} component {component} has invalid quantization range.");
            splineMask |= (byte)(1 << component);
        }
        else if ((mask & (byte)staticFlag) != 0)
        {
            staticValue = reader.ReadSingle();
            if (!float.IsFinite(staticValue))
                throw new InvalidDataException($"HKX spline track {trackIndex} has a non-finite static vector component.");
            staticMask |= (byte)(1 << component);
        }
    }

    private static byte ReadStaticVector(CheckedReader reader, byte mask, ref Vector3 value)
    {
        byte staticMask = 0;
        if ((mask & (byte)TransformChannel.StaticX) != 0)
        {
            value.X = reader.ReadSingle();
            staticMask |= 0x01;
        }
        if ((mask & (byte)TransformChannel.StaticY) != 0)
        {
            value.Y = reader.ReadSingle();
            staticMask |= 0x02;
        }
        if ((mask & (byte)TransformChannel.StaticZ) != 0)
        {
            value.Z = reader.ReadSingle();
            staticMask |= 0x04;
        }
        if (!float.IsFinite(value.X) || !float.IsFinite(value.Y) || !float.IsFinite(value.Z))
            throw new InvalidDataException("HKX spline static vector contains a non-finite component.");
        return staticMask;
    }

    private static SplineQuatCurve ReadQuaternionSpline(CheckedReader reader, byte quantization, int trackIndex)
    {
        short num = reader.ReadInt16();
        byte degree = reader.ReadByte();
        if (num < 0 || degree > 3)
            throw new InvalidDataException($"HKX spline track {trackIndex} has an invalid quaternion NURBS header.");
        int controlPointCount = num + 1;
        int knotCount = checked(controlPointCount + degree + 1);
        var knots = reader.ReadBytes(knotCount).Select(static value => (float)value).ToArray();
        reader.Align(GetRotationAlignment(quantization));

        var controls = new Quaternion[controlPointCount];
        for (int i = 0; i < controls.Length; i++)
            controls[i] = ReadQuantizedQuaternion(reader, quantization, trackIndex);
        return new SplineQuatCurve { Degree = degree, Knots = knots, ControlPoints = controls };
    }

    private static float ReadQuantizedScalar(CheckedReader reader, float min, float max, byte quantization)
    {
        float value = quantization switch
        {
            0 => min + (max - min) * (reader.ReadByte() / 255f),
            1 => min + (max - min) * (reader.ReadUInt16() / 65535f),
            _ => throw new NotSupportedException($"HKX scalar quantization {quantization} is unsupported.")
        };
        if (!float.IsFinite(value))
            throw new InvalidDataException("HKX quantized scalar decoded to a non-finite value.");
        return value;
    }

    private static Quaternion ReadQuantizedQuaternion(CheckedReader reader, byte quantization, int trackIndex)
    {
        int bytes = GetQuaternionByteCount(quantization);
        var encoded = reader.ReadBytes(bytes);
        return quantization switch
        {
            0 => HkxDecompressor.UnpackPolar32(BinaryPrimitives.ReadUInt32LittleEndian(encoded)),
            1 => HkxDecompressor.UnpackThreeComp40(encoded),
            2 => HkxDecompressor.UnpackThreeComp48(encoded),
            3 => HkxDecompressor.UnpackThreeComp24(encoded),
            4 => HkxDecompressor.UnpackStraight16(encoded),
            5 => HkxDecompressor.UnpackUncompressedQuat(encoded),
            _ => throw new NotSupportedException($"HKX track {trackIndex} rotation quantization {quantization} is unsupported.")
        };
    }

    private static int GetQuaternionByteCount(byte quantization) => quantization switch
    {
        0 => 4,
        1 => 5,
        2 => 6,
        3 => 3,
        4 => 2,
        5 => 16,
        _ => throw new NotSupportedException($"HKX rotation quantization {quantization} is unsupported.")
    };

    private static int GetRotationAlignment(byte quantization) => quantization switch
    {
        0 => 4,
        1 => 1,
        2 => 2,
        3 => 1,
        4 => 2,
        5 => 4,
        _ => throw new NotSupportedException($"HKX rotation quantization {quantization} is unsupported.")
    };

    private static bool HasStatic(byte mask) => (mask & 0x0F) != 0;
    private static bool HasSpline(byte mask) => (mask & 0xF0) != 0;

    private static int ToIntOffset(uint value, string label)
    {
        if (value > int.MaxValue)
            throw new InvalidDataException($"HKX {label} {value} exceeds the supported address range.");
        return (int)value;
    }

    private static string? ReadStringPtr(HkxPackfile packfile, uint pointerOffset)
    {
        if (!packfile.DataSection.LocalFixupMap.TryGetValue(pointerOffset, out uint targetOffset))
            return null;
        var data = packfile.DataSection.SectionData;
        if (targetOffset >= data.Length)
            throw new InvalidDataException($"HKX string pointer target 0x{targetOffset:X} is outside __data__.");
        int end = Array.IndexOf(data, (byte)0, (int)targetOffset);
        if (end < 0)
            throw new InvalidDataException($"HKX string at 0x{targetOffset:X} is not NUL terminated.");
        return Encoding.UTF8.GetString(data, (int)targetOffset, end - (int)targetOffset);
    }

    private static short[] ReadInt16Array(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        int size = ReadArraySize(packfile, arrayHeaderOffset, "int16 array");
        if (size == 0) return Array.Empty<short>();
        uint dataOffset = ReadArrayDataOffset(packfile, arrayHeaderOffset, size * 2, "int16 array");
        var data = packfile.DataSection.SectionData;
        var result = new short[size];
        for (int i = 0; i < size; i++)
            result[i] = BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan((int)dataOffset + i * 2, 2));
        return result;
    }

    private static uint[] ReadUInt32Array(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        int size = ReadArraySize(packfile, arrayHeaderOffset, "uint32 array");
        if (size == 0) return Array.Empty<uint>();
        uint dataOffset = ReadArrayDataOffset(packfile, arrayHeaderOffset, checked(size * 4), "uint32 array");
        var data = packfile.DataSection.SectionData;
        var result = new uint[size];
        for (int i = 0; i < size; i++)
            result[i] = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan((int)dataOffset + i * 4, 4));
        return result;
    }

    private static byte[] ReadByteArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        int size = ReadArraySize(packfile, arrayHeaderOffset, "byte array");
        if (size == 0) return Array.Empty<byte>();
        uint dataOffset = ReadArrayDataOffset(packfile, arrayHeaderOffset, size, "byte array");
        var result = new byte[size];
        Array.Copy(packfile.DataSection.SectionData, (int)dataOffset, result, 0, size);
        return result;
    }

    private static float[] ReadFloatArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        int size = ReadArraySize(packfile, arrayHeaderOffset, "float array");
        if (size == 0) return Array.Empty<float>();
        uint dataOffset = ReadArrayDataOffset(packfile, arrayHeaderOffset, checked(size * 4), "float array");
        var result = new float[size];
        for (int i = 0; i < size; i++)
            result[i] = BinaryPrimitives.ReadSingleLittleEndian(packfile.DataSection.SectionData.AsSpan((int)dataOffset + i * 4, 4));
        return result;
    }

    private static int ReadArraySize(HkxPackfile packfile, uint arrayHeaderOffset, string label)
    {
        var data = packfile.DataSection.SectionData;
        if (arrayHeaderOffset > int.MaxValue || (ulong)arrayHeaderOffset + 16 > (ulong)data.Length)
            throw new InvalidDataException($"HKX {label} header is outside __data__.");
        int size = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan((int)arrayHeaderOffset + 8, 4));
        if (size < 0 || size > 10_000_000)
            throw new InvalidDataException($"HKX {label} has invalid element count {size}.");
        return size;
    }

    private static uint ReadArrayDataOffset(HkxPackfile packfile, uint arrayHeaderOffset, int byteLength, string label)
    {
        if (!packfile.DataSection.LocalFixupMap.TryGetValue(arrayHeaderOffset, out uint dataOffset))
            throw new InvalidDataException($"HKX {label} has no local fixup for its data pointer.");
        var data = packfile.DataSection.SectionData;
        if (dataOffset > int.MaxValue || (ulong)dataOffset + (ulong)byteLength > (ulong)data.Length)
            throw new InvalidDataException($"HKX {label} data range is outside __data__.");
        return dataOffset;
    }

    private static HkxBone[] ReadBoneArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        int size = ReadArraySize(packfile, arrayHeaderOffset, "bone array");
        if (size == 0) return Array.Empty<HkxBone>();
        uint dataOffset = ReadArrayDataOffset(packfile, arrayHeaderOffset, checked(size * 16), "bone array");
        var result = new HkxBone[size];
        var data = packfile.DataSection.SectionData;
        for (int i = 0; i < size; i++)
        {
            uint boneOffset = checked(dataOffset + (uint)(i * 16));
            string name = ReadStringPtr(packfile, boneOffset)
                ?? throw new InvalidDataException($"HKX bone {i} has no name pointer.");
            bool lockTranslation = data[(int)boneOffset + 8] != 0;
            result[i] = new HkxBone { Name = name, LockTranslation = lockTranslation };
        }
        return result;
    }

    private static BoneTransform[] ReadQsTransformArray(HkxPackfile packfile, uint arrayHeaderOffset)
    {
        int size = ReadArraySize(packfile, arrayHeaderOffset, "hkQsTransform array");
        if (size == 0) return Array.Empty<BoneTransform>();
        uint dataOffset = ReadArrayDataOffset(packfile, arrayHeaderOffset, checked(size * 48), "hkQsTransform array");
        var data = packfile.DataSection.SectionData;
        var result = new BoneTransform[size];
        for (int i = 0; i < size; i++)
        {
            int p = checked((int)dataOffset + i * 48);
            float tx = ReadSingle(data, p);
            float ty = ReadSingle(data, p + 4);
            float tz = ReadSingle(data, p + 8);
            float rx = ReadSingle(data, p + 16);
            float ry = ReadSingle(data, p + 20);
            float rz = ReadSingle(data, p + 24);
            float rw = ReadSingle(data, p + 28);
            float sx = ReadSingle(data, p + 32);
            float sy = ReadSingle(data, p + 36);
            float sz = ReadSingle(data, p + 40);
            if (!float.IsFinite(tx) || !float.IsFinite(ty) || !float.IsFinite(tz)
                || !float.IsFinite(sx) || !float.IsFinite(sy) || !float.IsFinite(sz)
                || !float.IsFinite(rx) || !float.IsFinite(ry) || !float.IsFinite(rz) || !float.IsFinite(rw))
                throw new InvalidDataException($"HKX reference pose transform {i} contains non-finite values.");
            var rotation = new Quaternion(rx, ry, rz, rw);
            if (rotation.LengthSquared() <= 1e-12f)
                throw new InvalidDataException($"HKX reference pose transform {i} has a zero-length rotation.");
            result[i] = new BoneTransform(new Vector3(tx, ty, tz), Quaternion.Normalize(rotation), new Vector3(sx, sy, sz));
        }
        return result;
    }

    private static int ReadInt32(byte[] data, int offset)
    {
        RequireRange(data, offset, 4, "HKX int32");
        return BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4));
    }

    private static float ReadSingle(byte[] data, int offset)
    {
        RequireRange(data, offset, 4, "HKX float");
        return BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan(offset, 4));
    }

    private static Vector4 ReadVector4(byte[] data, int offset, string label)
    {
        RequireRange(data, offset, 16, label);
        var value = new Vector4(
            ReadSingle(data, offset),
            ReadSingle(data, offset + 4),
            ReadSingle(data, offset + 8),
            ReadSingle(data, offset + 12));
        if (!float.IsFinite(value.X) || !float.IsFinite(value.Y)
            || !float.IsFinite(value.Z) || !float.IsFinite(value.W))
            throw new InvalidDataException($"{label} contains a non-finite component.");
        return value;
    }

    private static void RequireRange(byte[] data, int offset, int length, string label)
    {
        if (offset < 0 || length < 0 || (ulong)offset + (ulong)length > (ulong)data.Length)
            throw new InvalidDataException($"{label} is truncated at offset 0x{offset:X}.");
    }

    private sealed class CheckedReader
    {
        private readonly byte[] _data;
        private readonly int _start;
        private readonly int _end;
        private int _position;

        public CheckedReader(byte[] data, int start, int end)
        {
            if (start < 0 || end < start || end > data.Length)
                throw new InvalidDataException("HKX checked reader bounds are invalid.");
            _data = data;
            _start = start;
            _end = end;
            _position = start;
        }

        public int Position => _position;

        public byte ReadByte()
        {
            Ensure(1);
            return _data[_position++];
        }

        public short ReadInt16()
        {
            Ensure(2);
            short value = BinaryPrimitives.ReadInt16LittleEndian(_data.AsSpan(_position, 2));
            _position += 2;
            return value;
        }

        public ushort ReadUInt16()
        {
            Ensure(2);
            ushort value = BinaryPrimitives.ReadUInt16LittleEndian(_data.AsSpan(_position, 2));
            _position += 2;
            return value;
        }

        public float ReadSingle()
        {
            Ensure(4);
            float value = BinaryPrimitives.ReadSingleLittleEndian(_data.AsSpan(_position, 4));
            _position += 4;
            return value;
        }

        public byte[] ReadBytes(int count)
        {
            if (count < 0) throw new InvalidDataException("HKX reader received a negative byte count.");
            Ensure(count);
            var result = new byte[count];
            Array.Copy(_data, _position, result, 0, count);
            _position += count;
            return result;
        }

        public void Align(int alignment)
        {
            if (alignment <= 0) return;
            int remainder = _position % alignment;
            if (remainder == 0) return;
            int padding = alignment - remainder;
            Ensure(padding);
            _position += padding;
        }

        private void Ensure(int count)
        {
            if (count < 0 || (ulong)_position + (ulong)count > (ulong)_end)
                throw new InvalidDataException(
                    $"HKX compressed payload truncated at 0x{_position:X}: need {count} bytes, block end 0x{_end:X}.");
        }
    }
}

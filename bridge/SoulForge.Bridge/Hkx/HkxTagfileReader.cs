// MIT License
// Copyright (c) 2026 SoulForge Authors
// ACTION projection for Havok 2014 TAG0 files.
//
// Havoc is the sole TAG0/TCRF object decoder. This adapter only projects the
// decoded, typed object graph into the checked Hkx* models used by the common
// animation sampler; it does not parse TAG0 bytes a second time.

using System.IO;
using System.Numerics;
using Havoc.IO.Tagfile.Binary;
using Havoc.Objects;

namespace SoulForge.Bridge.Hkx;

internal static class HkxTagfileReader
{
    public static HkxAnimationContainer ReadTagfile(byte[] tagfileBytes, byte[]? compendiumBytes = null)
    {
        if (tagfileBytes is null || tagfileBytes.Length == 0)
            throw new InvalidDataException("HKX tagfile is empty.");
        if (compendiumBytes is null || compendiumBytes.Length == 0)
            throw new InvalidDataException("HKX tagfile requires its referenced compendium; none was supplied.");

        var root = HkBinaryTagfileReader.Read(new MemoryStream(tagfileBytes), compendiumBytes);
        var objects = FlattenObjects(root).ToArray();
        var classes = objects
            .OfType<HkClass>()
            .ToArray();

        var animationClasses = classes
            .Where(static value => value.Type.Name is "hkaSplineCompressedAnimation"
                or "hkaInterleavedUncompressedAnimation")
            .ToArray();
        var skeletonClasses = classes
            .Where(static value => value.Type.Name == "hkaSkeleton")
            .ToArray();
        var bindingClasses = classes
            .Where(static value => value.Type.Name == "hkaAnimationBinding")
            .ToArray();

        var unsupportedActionClasses = classes
            .Where(static value => value.Type.Name.StartsWith("hka", StringComparison.Ordinal))
            .Select(static value => value.Type.Name)
            .Where(static name => name is not "hkaAnimationContainer"
                and not "hkaAnnotationTrack"
                and not "hkaAnimationBinding"
                and not "hkaSkeleton"
                and not "hkaBone"
                and not "hkaDefaultAnimatedReferenceFrame"
                and not "hkaSplineCompressedAnimation"
                and not "hkaInterleavedUncompressedAnimation")
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        if (unsupportedActionClasses.Length > 0)
            throw new NotSupportedException(
                $"HKX TAG0 ACTION projection encountered unsupported Havok classes: {string.Join(", ", unsupportedActionClasses)}.");

        var animationsByClass = new Dictionary<HkClass, HkxAnimation>(ReferenceEqualityComparer.Instance);
        var animations = new List<HkxAnimation>(animationClasses.Length);
        foreach (var animationClass in animationClasses)
        {
            var animation = ReadAnimation(animationClass);
            animationsByClass.Add(animationClass, animation);
            animations.Add(animation);
        }

        var bindings = new List<HkxAnimationBinding>(bindingClasses.Length);
        foreach (var bindingClass in bindingClasses)
            bindings.Add(ReadBinding(bindingClass, animationsByClass));

        var skeletons = skeletonClasses.Select(ReadSkeleton).ToArray();
        if (animations.Count == 0 && bindings.Count == 0 && skeletons.Length == 0)
        {
            var typeNames = objects
                .Select(static value => value.Type.Name)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static name => name, StringComparer.Ordinal)
                .ToArray();
            throw new NotSupportedException(
                $"HKX TAG0 object decode succeeded but contains no ACTION skeleton, binding, or supported animation: {string.Join(", ", typeNames)}.");
        }

        return new HkxAnimationContainer
        {
            SourceFormat = "tagfile",
            Skeletons = skeletons,
            Animations = animations,
            Bindings = bindings
        };
    }

    private static HkxAnimation ReadAnimation(HkClass animationClass)
    {
        string className = animationClass.Type.Name;
        int typeValue = ReadInt(RequiredField(animationClass, "type"), $"{className}.type");
        float duration = ReadFloat(RequiredField(animationClass, "duration"), $"{className}.duration");
        int numberOfTransformTracks = ReadInt(
            RequiredField(animationClass, "numberOfTransformTracks"),
            $"{className}.numberOfTransformTracks");
        int numberOfFloatTracks = ReadInt(
            RequiredField(animationClass, "numberOfFloatTracks"),
            $"{className}.numberOfFloatTracks");
        ValidateAnimationBase(className, duration, numberOfTransformTracks, numberOfFloatTracks);
        var extractedMotion = ReadExtractedMotion(
            TryField(animationClass, "extractedMotion"),
            $"{className}.extractedMotion");

        if (className == "hkaSplineCompressedAnimation")
        {
            if (typeValue != (int)HkxAnimationType.SplineCompressed)
                throw new InvalidDataException(
                    $"{className}.type is {typeValue}, expected {(int)HkxAnimationType.SplineCompressed} for the Havok enum.");
            return ReadSplineAnimation(animationClass, duration, numberOfTransformTracks, numberOfFloatTracks, extractedMotion);
        }

        if (className == "hkaInterleavedUncompressedAnimation")
        {
            if (typeValue != (int)HkxAnimationType.Interleaved)
                throw new InvalidDataException(
                    $"{className}.type is {typeValue}, expected {(int)HkxAnimationType.Interleaved} for the Havok enum.");
            return ReadInterleavedAnimation(animationClass, duration, numberOfTransformTracks, numberOfFloatTracks, extractedMotion);
        }

        throw new NotSupportedException($"未支持的 HKX TAG0 动画类型：{className} (type={typeValue})。");
    }

    private static HkxSplineCompressedAnimation ReadSplineAnimation(
        HkClass animationClass,
        float duration,
        int numberOfTransformTracks,
        int numberOfFloatTracks,
        HkxExtractedMotion? extractedMotion)
    {
        string className = animationClass.Type.Name;
        int numFrames = ReadInt(RequiredField(animationClass, "numFrames"), $"{className}.numFrames");
        int numBlocks = ReadInt(RequiredField(animationClass, "numBlocks"), $"{className}.numBlocks");
        int maxFramesPerBlock = ReadInt(
            RequiredField(animationClass, "maxFramesPerBlock"),
            $"{className}.maxFramesPerBlock");
        int maskAndQuantizationSize = ReadInt(
            RequiredField(animationClass, "maskAndQuantizationSize"),
            $"{className}.maskAndQuantizationSize");
        float blockDuration = ReadFloat(RequiredField(animationClass, "blockDuration"), $"{className}.blockDuration");
        float blockInverseDuration = ReadFloat(
            RequiredField(animationClass, "blockInverseDuration"),
            $"{className}.blockInverseDuration");
        float frameDuration = ReadFloat(RequiredField(animationClass, "frameDuration"), $"{className}.frameDuration");
        int endian = ReadInt(RequiredField(animationClass, "endian"), $"{className}.endian");

        if (endian != 0)
            throw new NotSupportedException($"{className} uses unsupported endian marker {endian}; only little-endian TAG0 data is verified.");
        if (numFrames <= 0 || numBlocks <= 0 || maxFramesPerBlock <= 0 || maskAndQuantizationSize <= 0)
            throw new InvalidDataException(
                $"{className} has invalid block metadata: frames={numFrames}, blocks={numBlocks}, max={maxFramesPerBlock}, maskBytes={maskAndQuantizationSize}.");
        if (!float.IsFinite(blockDuration) || !float.IsFinite(blockInverseDuration)
            || !float.IsFinite(frameDuration) || frameDuration <= 0f)
            throw new InvalidDataException($"{className} has non-finite block or frame timing.");
        if (numberOfFloatTracks != 0)
            throw new NotSupportedException("HKX float animation tracks are not yet wired into the ACTION clip contract.");

        var blockOffsets = ReadUInt32Array(RequiredField(animationClass, "blockOffsets"), $"{className}.blockOffsets");
        var floatBlockOffsets = ReadUInt32Array(
            RequiredField(animationClass, "floatBlockOffsets"),
            $"{className}.floatBlockOffsets");
        var transformOffsets = ReadUInt32Array(
            RequiredField(animationClass, "transformOffsets"),
            $"{className}.transformOffsets");
        var floatOffsets = ReadUInt32Array(RequiredField(animationClass, "floatOffsets"), $"{className}.floatOffsets");
        var data = ReadByteArray(RequiredField(animationClass, "data"), $"{className}.data");

        if (blockOffsets.Length != numBlocks)
            throw new InvalidDataException(
                $"{className} block-offset count mismatch: expected={numBlocks}, actual={blockOffsets.Length}.");
        if (transformOffsets.Length != 0 && transformOffsets.Length != numberOfTransformTracks)
            throw new InvalidDataException(
                $"{className} transform-offset count mismatch: expected 0 or {numberOfTransformTracks}, actual={transformOffsets.Length}.");
        HkxAnimationReader.ValidateBlockRelativeOffsets(
            blockOffsets, floatBlockOffsets, data.Length, numBlocks, className);
        if (blockOffsets.Length > 0 && blockOffsets[0] != 0)
            throw new InvalidDataException($"{className}.blockOffsets must begin at data offset 0, got {blockOffsets[0]}.");
        ValidateExtractedMotion(extractedMotion, duration, numFrames, className);

        var animation = new HkxSplineCompressedAnimation
        {
            AnimationType = HkxAnimationType.SplineCompressed,
            Duration = duration,
            NumberOfTransformTracks = numberOfTransformTracks,
            NumberOfFloatTracks = numberOfFloatTracks,
            HasExtractedMotion = extractedMotion is not null,
            ExtractedMotion = extractedMotion,
            NumFrames = numFrames,
            NumBlocks = numBlocks,
            MaxFramesPerBlock = maxFramesPerBlock,
            MaskAndQuantizationSize = maskAndQuantizationSize,
            BlockDuration = blockDuration,
            BlockInverseDuration = blockInverseDuration,
            FrameDuration = frameDuration,
            BlockOffsets = blockOffsets,
            FloatBlockOffsets = floatBlockOffsets,
            TransformOffsets = transformOffsets,
            FloatOffsets = floatOffsets,
            Data = data
        };
        animation.Blocks = HkxAnimationReader.ParseSplineBlocks(animation);
        return animation;
    }

    private static HkxInterleavedAnimation ReadInterleavedAnimation(
        HkClass animationClass,
        float duration,
        int numberOfTransformTracks,
        int numberOfFloatTracks,
        HkxExtractedMotion? extractedMotion)
    {
        if (numberOfFloatTracks > 0)
            throw new NotSupportedException("HKX float animation tracks are not yet wired into the ACTION clip contract.");
        var transformObjects = ReadArray(RequiredField(animationClass, "transforms"), $"{animationClass.Type.Name}.transforms");
        if (transformObjects.Count == 0 || transformObjects.Count % numberOfTransformTracks != 0)
            throw new InvalidDataException(
                $"{animationClass.Type.Name} transform count is not divisible by its track count: transforms={transformObjects.Count}, tracks={numberOfTransformTracks}.");
        int numFrames = transformObjects.Count / numberOfTransformTracks;
        float frameDuration = numFrames > 1 ? duration / (numFrames - 1) : duration;
        if (!float.IsFinite(frameDuration) || frameDuration <= 0f)
            throw new InvalidDataException($"{animationClass.Type.Name} has an invalid frame duration.");
        ValidateExtractedMotion(extractedMotion, duration, numFrames, animationClass.Type.Name);
        return new HkxInterleavedAnimation
        {
            AnimationType = HkxAnimationType.Interleaved,
            Duration = duration,
            NumberOfTransformTracks = numberOfTransformTracks,
            NumberOfFloatTracks = numberOfFloatTracks,
            HasExtractedMotion = extractedMotion is not null,
            ExtractedMotion = extractedMotion,
            NumFrames = numFrames,
            FrameDuration = frameDuration,
            Transforms = transformObjects
                .Select((value, index) => ReadQsTransform(value, $"{animationClass.Type.Name}.transforms[{index}]"))
                .ToArray()
        };
    }

    private static HkxAnimationBinding ReadBinding(
        HkClass bindingClass,
        IReadOnlyDictionary<HkClass, HkxAnimation> animationsByClass)
    {
        var animationObject = Unwrap(RequiredField(bindingClass, "animation"));
        if (animationObject is not HkClass animationClass)
            throw new InvalidDataException($"{bindingClass.Type.Name}.animation is not an explicit Havok animation object.");
        if (!animationsByClass.TryGetValue(animationClass, out var animation))
            throw new InvalidDataException(
                $"{bindingClass.Type.Name}.animation points to unsupported or unindexed type '{animationClass.Type.Name}'.");

        var transformTrackToBoneIndices = ReadIntArray(
            RequiredField(bindingClass, "transformTrackToBoneIndices"),
            $"{bindingClass.Type.Name}.transformTrackToBoneIndices");
        var floatTrackToSlotIndices = ReadIntArray(
            RequiredField(bindingClass, "floatTrackToFloatSlotIndices"),
            $"{bindingClass.Type.Name}.floatTrackToFloatSlotIndices");
        var partitionIndices = ReadIntArray(
            RequiredField(bindingClass, "partitionIndices"),
            $"{bindingClass.Type.Name}.partitionIndices");
        if (transformTrackToBoneIndices.Count != animation.NumberOfTransformTracks)
            throw new InvalidDataException(
                $"{bindingClass.Type.Name} transform map count mismatch: binding={transformTrackToBoneIndices.Count}, animation={animation.NumberOfTransformTracks}.");
        if (floatTrackToSlotIndices.Count != animation.NumberOfFloatTracks)
            throw new InvalidDataException(
                $"{bindingClass.Type.Name} float map count mismatch: binding={floatTrackToSlotIndices.Count}, animation={animation.NumberOfFloatTracks}.");

        int blendHint = ReadInt(RequiredField(bindingClass, "blendHint"), $"{bindingClass.Type.Name}.blendHint");
        if (blendHint is not 0 and not 1)
            throw new NotSupportedException(
                $"{bindingClass.Type.Name} uses unsupported blend hint {blendHint}; only NORMAL (0) and ADDITIVE (1) are defined by Havok.");
        return new HkxAnimationBinding
        {
            OriginalSkeletonName = ReadOptionalString(TryField(bindingClass, "originalSkeletonName")),
            TransformTrackToBoneIndices = transformTrackToBoneIndices,
            FloatTrackToFloatSlotIndices = floatTrackToSlotIndices,
            PartitionIndices = partitionIndices,
            BlendHint = blendHint,
            Animation = animation
        };
    }

    private static HkxSkeleton ReadSkeleton(HkClass skeletonClass)
    {
        string name = ReadOptionalString(TryField(skeletonClass, "name"));
        var parentIndices = ReadIntArray(RequiredField(skeletonClass, "parentIndices"), $"{skeletonClass.Type.Name}.parentIndices");
        var boneObjects = ReadArray(RequiredField(skeletonClass, "bones"), $"{skeletonClass.Type.Name}.bones");
        var poseObjects = ReadArray(RequiredField(skeletonClass, "referencePose"), $"{skeletonClass.Type.Name}.referencePose");
        if (boneObjects.Count == 0)
            throw new InvalidDataException($"hkaSkeleton '{name}' has no bones.");
        if (parentIndices.Count != boneObjects.Count || poseObjects.Count != boneObjects.Count)
            throw new InvalidDataException(
                $"hkaSkeleton '{name}' count mismatch: parents={parentIndices.Count}, bones={boneObjects.Count}, pose={poseObjects.Count}.");

        var bones = boneObjects.Select((value, index) => ReadBone(value, $"{skeletonClass.Type.Name}.bones[{index}]")).ToArray();
        var transforms = poseObjects.Select((value, index) => ReadQsTransform(value, $"{skeletonClass.Type.Name}.referencePose[{index}]")).ToArray();
        for (int i = 0; i < parentIndices.Count; i++)
        {
            int parent = parentIndices[i];
            if (parent < -1 || parent >= bones.Length)
                throw new InvalidDataException($"hkaSkeleton '{name}' has invalid parent index {parent} at bone {i}.");
        }
        return new HkxSkeleton
        {
            Name = name,
            Bones = bones,
            ParentIndices = parentIndices.Select(static value => checked((short)value)).ToArray(),
            Transforms = transforms
        };
    }

    private static HkxBone ReadBone(IHkObject value, string label)
    {
        if (Unwrap(value) is not HkClass boneClass)
            throw new InvalidDataException($"{label} is not an hkaBone class.");
        string name = ReadOptionalString(TryField(boneClass, "name"));
        var lockValue = TryField(boneClass, "lockTranslation");
        bool lockTranslation = lockValue is not null && ReadInt(lockValue, $"{label}.lockTranslation") != 0;
        return new HkxBone { Name = name, LockTranslation = lockTranslation };
    }

    private static BoneTransform ReadQsTransform(IHkObject value, string label)
    {
        if (Unwrap(value) is not HkClass transformClass)
            throw new InvalidDataException($"{label} is not an hkQsTransform class.");
        var translation = ReadVector4Components(
            RequiredField(transformClass, "translation"),
            $"{label}.translation");
        var rotationValues = ReadComponents(RequiredField(transformClass, "rotation"), 4, $"{label}.rotation");
        var scale = ReadVector4Components(RequiredField(transformClass, "scale"), $"{label}.scale");
        var rotation = new Quaternion(rotationValues[0], rotationValues[1], rotationValues[2], rotationValues[3]);
        ValidateFinite(translation, $"{label}.translation");
        ValidateFinite(scale, $"{label}.scale");
        if (!float.IsFinite(rotation.X) || !float.IsFinite(rotation.Y)
            || !float.IsFinite(rotation.Z) || !float.IsFinite(rotation.W)
            || rotation.LengthSquared() <= 1e-12f)
            throw new InvalidDataException($"{label}.rotation is non-finite or zero-length.");
        return new BoneTransform(
            new Vector3(translation[0], translation[1], translation[2]),
            Quaternion.Normalize(rotation),
            new Vector3(scale[0], scale[1], scale[2]));
    }

    private static float[] ReadVector4Components(IHkObject value, string label)
    {
        // hkQsTransform stores translation and scale as hkVector4.  The W
        // component is part of the native representation even though the
        // editor's local-pose model projects only XYZ; validate it before the
        // deliberate projection so malformed data cannot become a silent pose.
        return ReadComponents(value, 4, label);
    }

    private static float[] ReadComponents(IHkObject value, int expectedCount, string label)
    {
        var values = ReadArray(value, label);
        if (values.Count != expectedCount)
            throw new InvalidDataException($"{label} expected {expectedCount} components, got {values.Count}.");
        return values.Select((item, index) => ReadFloat(item, $"{label}[{index}]")).ToArray();
    }

    private static HkxExtractedMotion? ReadExtractedMotion(IHkObject? value, string label)
    {
        var unwrapped = Unwrap(value);
        if (unwrapped is null)
            return null;
        if (unwrapped is not HkClass referenceFrame)
            throw new InvalidDataException($"{label} is not a Havok reference-frame class.");
        if (referenceFrame.Type.Name != "hkaDefaultAnimatedReferenceFrame")
            throw new NotSupportedException(
                $"{label} uses unsupported reference-frame class '{referenceFrame.Type.Name}'.");

        int frameType = ReadInt(RequiredField(referenceFrame, "frameType"), $"{label}.frameType");
        if (frameType is < 0 or > 2)
            throw new NotSupportedException($"{label}.frameType={frameType} is unsupported.");
        var upValues = ReadComponents(RequiredField(referenceFrame, "up"), 4, $"{label}.up");
        var forwardValues = ReadComponents(RequiredField(referenceFrame, "forward"), 4, $"{label}.forward");
        float duration = ReadFloat(RequiredField(referenceFrame, "duration"), $"{label}.duration");
        if (duration <= 0f)
            throw new InvalidDataException($"{label}.duration must be positive.");

        var sampleObjects = ReadArray(
            RequiredField(referenceFrame, "referenceFrameSamples"),
            $"{label}.referenceFrameSamples");
        if (sampleObjects.Count == 0)
            throw new InvalidDataException($"{label}.referenceFrameSamples is empty.");
        var samples = sampleObjects.Select((sample, index) =>
        {
            var values = ReadComponents(sample, 4, $"{label}.referenceFrameSamples[{index}]");
            return new HkxReferenceFrameSample(new Vector4(values[0], values[1], values[2], values[3]));
        }).ToArray();

        return new HkxExtractedMotion
        {
            FrameType = frameType,
            Up = new Vector4(upValues[0], upValues[1], upValues[2], upValues[3]),
            Forward = new Vector4(forwardValues[0], forwardValues[1], forwardValues[2], forwardValues[3]),
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

    private static void ValidateAnimationBase(string className, float duration, int numberOfTransformTracks, int numberOfFloatTracks)
    {
        if (!float.IsFinite(duration) || duration <= 0f)
            throw new InvalidDataException($"{className} has invalid duration {duration}.");
        if (numberOfTransformTracks <= 0 || numberOfFloatTracks < 0)
            throw new InvalidDataException(
                $"{className} has invalid track counts: transforms={numberOfTransformTracks}, floats={numberOfFloatTracks}.");
    }

    private static void ValidateOffsets(IReadOnlyList<uint> offsets, int dataLength, string label, bool requireFirstZero)
    {
        if (offsets.Count == 0)
            return;
        if (requireFirstZero && offsets[0] != 0)
            throw new InvalidDataException($"{label} must begin at data offset 0, got {offsets[0]}.");
        uint previous = 0;
        for (int i = 0; i < offsets.Count; i++)
        {
            uint current = offsets[i];
            if (i > 0 && current < previous)
                throw new InvalidDataException($"{label} is not monotonic at index {i}: {previous} -> {current}.");
            if (current > dataLength)
                throw new InvalidDataException($"{label}[{i}]={current} exceeds data length {dataLength}.");
            previous = current;
        }
    }

    private static IHkObject RequiredField(HkClass value, string name)
    {
        var field = TryField(value, name);
        return field ?? throw new InvalidDataException($"{value.Type.Name} has no required field '{name}'.");
    }

    private static IHkObject? TryField(HkClass value, string name)
    {
        var matches = value.Value.Where(pair => pair.Key.Name == name).Select(pair => pair.Value).ToArray();
        if (matches.Length > 1)
            throw new InvalidDataException($"{value.Type.Name} has ambiguous field '{name}' ({matches.Length} entries).");
        return matches.Length == 0 ? null : matches[0];
    }

    private static IHkObject? Unwrap(IHkObject? value)
    {
        var current = value;
        while (current is HkPtr pointer)
            current = pointer.Value;
        return current;
    }

    private static IReadOnlyList<IHkObject> ReadArray(IHkObject value, string label)
    {
        var unwrapped = Unwrap(value);
        if (unwrapped is null)
            return Array.Empty<IHkObject>();
        if (unwrapped is not HkArray array)
            throw new InvalidDataException($"{label} is {unwrapped.Type.Name}, expected hkArray.");
        return array.Value ?? Array.Empty<IHkObject>();
    }

    private static IReadOnlyList<int> ReadIntArray(IHkObject value, string label)
    {
        return ReadArray(value, label).Select((item, index) => ReadInt(item, $"{label}[{index}]")).ToArray();
    }

    private static uint[] ReadUInt32Array(IHkObject value, string label)
    {
        return ReadArray(value, label).Select((item, index) =>
        {
            long number = ReadInt64(item, $"{label}[{index}]");
            if (number < 0 || number > uint.MaxValue)
                throw new InvalidDataException($"{label}[{index}]={number} is outside uint32 range.");
            return (uint)number;
        }).ToArray();
    }

    private static byte[] ReadByteArray(IHkObject value, string label)
    {
        return ReadArray(value, label).Select((item, index) =>
        {
            long number = ReadInt64(item, $"{label}[{index}]");
            if (number < 0 || number > byte.MaxValue)
                throw new InvalidDataException($"{label}[{index}]={number} is outside byte range.");
            return (byte)number;
        }).ToArray();
    }

    private static string ReadOptionalString(IHkObject? value)
    {
        var unwrapped = Unwrap(value);
        if (unwrapped is null)
            return string.Empty;
        if (unwrapped is not HkString text)
            throw new InvalidDataException($"{unwrapped.Type.Name} is not a Havok string.");
        return text.Value ?? string.Empty;
    }

    private static int ReadInt(IHkObject value, string label)
    {
        long result = ReadInt64(value, label);
        if (result < int.MinValue || result > int.MaxValue)
            throw new InvalidDataException($"{label}={result} is outside int32 range.");
        return (int)result;
    }

    private static long ReadInt64(IHkObject value, string label)
    {
        var unwrapped = Unwrap(value);
        if (unwrapped is null)
            throw new InvalidDataException($"{label} is null.");
        try
        {
            return unwrapped.Value switch
            {
                sbyte signedByte => signedByte,
                byte unsignedByte => unsignedByte,
                short signedShort => signedShort,
                ushort unsignedShort => unsignedShort,
                int signedInt => signedInt,
                uint unsignedInt => checked((long)unsignedInt),
                long signedLong => signedLong,
                ulong unsignedLong => checked((long)unsignedLong),
                bool boolean => boolean ? 1L : 0L,
                _ => throw new InvalidDataException($"{label} has unsupported primitive value type '{unwrapped.Value.GetType().Name}'.")
            };
        }
        catch (OverflowException ex)
        {
            throw new InvalidDataException($"{label} is outside int64 range.", ex);
        }
    }

    private static float ReadFloat(IHkObject value, string label)
    {
        var unwrapped = Unwrap(value);
        if (unwrapped is null)
            throw new InvalidDataException($"{label} is null.");
        float result;
        try
        {
            result = unwrapped.Value switch
            {
                float single => single,
                double doubleValue => checked((float)doubleValue),
                Half half => (float)half,
                _ => throw new InvalidDataException($"{label} has unsupported primitive value type '{unwrapped.Value.GetType().Name}'.")
            };
        }
        catch (OverflowException ex)
        {
            throw new InvalidDataException($"{label} is outside float range.", ex);
        }
        if (!float.IsFinite(result))
            throw new InvalidDataException($"{label} is non-finite.");
        return result;
    }

    private static void ValidateFinite(IReadOnlyList<float> values, string label)
    {
        if (values.Any(value => !float.IsFinite(value)))
            throw new InvalidDataException($"{label} contains a non-finite component.");
    }

    private static IEnumerable<IHkObject> FlattenObjects(IHkObject root)
    {
        var seen = new HashSet<IHkObject>(ReferenceEqualityComparer.Instance);
        return Flatten(root, seen);
    }

    private static IEnumerable<IHkObject> Flatten(IHkObject? value, ISet<IHkObject> seen)
    {
        if (value is null || !seen.Add(value))
            yield break;
        yield return value;
        switch (value)
        {
            case HkClass hkClass:
                foreach (var child in hkClass.Value.Values.SelectMany(child => Flatten(child, seen)))
                    yield return child;
                break;
            case HkPtr pointer:
                foreach (var child in Flatten(pointer.Value, seen))
                    yield return child;
                break;
            case HkArray array when array.Value is not null:
                foreach (var child in array.Value.SelectMany(item => Flatten(item, seen)))
                    yield return child;
                break;
        }
    }
}

// MIT License
// Copyright (c) 2026 SoulForge Authors
// Clean-room parser for Havok 2014 Tagfiles (TAG0) and Compendiums (TCM0).
// References: TagTools (MIT) by blueskythlikesclouds and LibXenoverse (MIT) by Olganix.

using System.Buffers.Binary;
using System.Numerics;
using System.Text;

namespace SoulForge.Bridge.Hkx;

internal sealed class HkxTagfileReader
{
    public sealed class TagType
    {
        public string Name { get; set; } = string.Empty;
        public TagType? Parent { get; set; }
        public int Flags { get; set; }
        public int SubTypeFlags { get; set; }
        public TagType? PointerType { get; set; }
        public int ByteSize { get; set; }
        public int Alignment { get; set; }
        public List<TagMember> Members { get; } = new();

        public int SubType => SubTypeFlags & 0xFF;

        public TagType EffectiveType()
        {
            var current = this;
            var seen = new HashSet<TagType>();
            while ((current.Flags & 0x01) == 0)
            {
                if (current.Parent == null || !seen.Add(current))
                    throw new InvalidDataException($"TAGFILE_TYPE_INHERITANCE_INVALID: type={Name}");
                current = current.Parent;
            }

            return current;
        }

        public IEnumerable<TagMember> AllMembers()
        {
            if (Parent != null)
            {
                foreach (var member in Parent.AllMembers())
                    yield return member;
            }

            foreach (var member in Members)
                yield return member;
        }
    }

    public sealed class TagMember
    {
        public string Name { get; set; } = string.Empty;
        public int Flags { get; set; }
        public int ByteOffset { get; set; }
        public TagType? MemberType { get; set; }
    }

    public sealed class TagItem
    {
        public TagType? ItemType { get; set; }
        public bool IsPointer { get; set; }
        public int DataOffset { get; set; }
        public int Count { get; set; }
    }

    private sealed class TagValue
    {
        public TagType Type { get; }
        public object? Value { get; }
        public int ItemIndex { get; }
        public int DataOffset { get; }

        public TagValue(TagType type, object? value, int itemIndex = -1, int dataOffset = -1)
        {
            Type = type;
            Value = value;
            ItemIndex = itemIndex;
            DataOffset = dataOffset;
        }
    }

    public byte[] Data { get; }
    public List<TagType?> Types { get; private set; } = new();
    public List<TagItem> Items { get; } = new();
    public byte[] DataPayload { get; private set; } = Array.Empty<byte>();

    private readonly Dictionary<int, IReadOnlyList<TagValue>> itemValues = new();
    private readonly HashSet<int> activeItems = new();

    public HkxTagfileReader(byte[] data)
    {
        Data = data;
    }

    public static HkxAnimationContainer ReadTagfile(byte[] tagfileBytes, byte[]? compendiumBytes = null)
    {
        var reader = new HkxTagfileReader(tagfileBytes);
        HkxTagfileReader? compendiumReader = null;
        if (compendiumBytes != null && compendiumBytes.Length > 0)
        {
            compendiumReader = new HkxTagfileReader(compendiumBytes);
            compendiumReader.Parse();
        }

        reader.Parse(compendiumReader);
        return reader.ExtractAnimationContainer();
    }

    public void Parse(HkxTagfileReader? compendium = null)
    {
        if (Data.Length < 8)
            throw new InvalidDataException($"HKX tagfile length {Data.Length} is too short.");

        int offset = 0;
        uint rootHeader = BinaryPrimitives.ReadUInt32BigEndian(Data.AsSpan(offset, 4));
        int rootSize = checked((int)(rootHeader & 0x3FFFFFFF));
        string rootSig = Encoding.ASCII.GetString(Data, offset + 4, 4);
        offset += 8;

        if (rootSig is not "TAG0" and not "TCM0")
            throw new InvalidDataException($"Invalid Tagfile root signature: '{rootSig}', expected 'TAG0' or 'TCM0'.");

        int rootEnd = Math.Min(Data.Length, checked(offset - 8 + rootSize));

        while (offset + 8 <= rootEnd)
        {
            uint chunkHeader = BinaryPrimitives.ReadUInt32BigEndian(Data.AsSpan(offset, 4));
            int chunkSize = checked((int)(chunkHeader & 0x3FFFFFFF));
            string sig = Encoding.ASCII.GetString(Data, offset + 4, 4);
            int chunkDataOffset = offset + 8;
            int chunkEnd = Math.Min(rootEnd, offset + chunkSize);

            if (chunkSize < 8 || chunkEnd <= offset)
                throw new InvalidDataException($"TAGFILE_CHUNK_INVALID: signature={sig} size={chunkSize} offset={offset}");

            if (sig == "DATA")
            {
                int dataLen = chunkSize - 8;
                DataPayload = new byte[dataLen];
                Array.Copy(Data, chunkDataOffset, DataPayload, 0, dataLen);
            }
            else if (sig == "TYPE")
            {
                ParseTypeChunk(chunkDataOffset, chunkEnd);
            }
            else if (sig == "TCRF")
            {
                if (compendium == null || compendium.Types.Count == 0)
                    throw new InvalidDataException("ACTION_HKX_TAGFILE_COMPENDIUM_REQUIRED: TAG0 uses TCRF but no parsed compendium was supplied.");
                Types = compendium.Types;
            }
            else if (sig == "INDX")
            {
                ParseIndexChunk(chunkDataOffset, chunkEnd);
            }

            offset = chunkEnd;
        }

        if (rootSig == "TAG0")
        {
            if (DataPayload.Length == 0)
                throw new InvalidDataException("TAGFILE_DATA_MISSING: TAG0 has no DATA payload.");
            if (Items.Count == 0)
                throw new InvalidDataException("TAGFILE_ITEMS_MISSING: TAG0 has no INDX/ITEM records.");
        }
        else if (Types.Count == 0)
        {
            throw new InvalidDataException("TAGFILE_TYPES_MISSING: TCM0 has no parsed TYPE section.");
        }
    }

    private void ParseTypeChunk(int startOffset, int endOffset)
    {
        int offset = startOffset;
        var typeStrings = new List<string>();
        var fieldStrings = new List<string>();

        while (offset + 8 <= endOffset)
        {
            uint subHeader = BinaryPrimitives.ReadUInt32BigEndian(Data.AsSpan(offset, 4));
            int subSize = checked((int)(subHeader & 0x3FFFFFFF));
            string subSig = Encoding.ASCII.GetString(Data, offset + 4, 4);
            int subDataOffset = offset + 8;
            int subEnd = Math.Min(endOffset, offset + subSize);

            if (subSize < 8 || subEnd <= offset)
                throw new InvalidDataException($"TAGFILE_TYPE_SUBCHUNK_INVALID: signature={subSig} size={subSize}");

            if (subSig == "TSTR")
            {
                int len = subSize - 8;
                if (len > 0 && subDataOffset + len <= Data.Length)
                {
                    var rawStr = Encoding.ASCII.GetString(Data, subDataOffset, len);
                    typeStrings = rawStr.Split('\0', StringSplitOptions.None).ToList();
                }
            }
            else if (subSig is "TNAM" or "TNA1")
            {
                int p = subDataOffset;
                int typeCount = ReadPacked(Data, ref p);
                Types = new List<TagType?>(new TagType?[typeCount]);

                for (int i = 1; i < typeCount; i++)
                {
                    int nameIdx = ReadPacked(Data, ref p);
                    string name = (nameIdx >= 0 && nameIdx < typeStrings.Count) ? typeStrings[nameIdx] : string.Empty;
                    var t = new TagType { Name = name, Flags = 0x01 };

                    int templateCount = ReadPacked(Data, ref p);
                    for (int j = 0; j < templateCount; j++)
                    {
                        ReadPacked(Data, ref p); // template name
                        ReadPacked(Data, ref p); // template value
                    }
                    Types[i] = t;
                }
            }
            else if (subSig == "FSTR")
            {
                int len = subSize - 8;
                if (len > 0 && subDataOffset + len <= Data.Length)
                {
                    var rawStr = Encoding.ASCII.GetString(Data, subDataOffset, len);
                    fieldStrings = rawStr.Split('\0').ToList();
                }
            }
            else if (subSig is "TBOD" or "TBDY")
            {
                int p = subDataOffset;
                while (p < subEnd)
                {
                    int typeIndex = ReadPacked(Data, ref p);
                    if (typeIndex == 0) continue;
                    if (typeIndex < 0 || typeIndex >= Types.Count)
                        throw new InvalidDataException($"TAGFILE_TYPE_INDEX_INVALID: index={typeIndex} count={Types.Count}");

                    var typ = Types[typeIndex];
                    if (typ == null) continue;

                    int parentIdx = ReadPacked(Data, ref p);
                    if (parentIdx >= 0 && parentIdx < Types.Count) typ.Parent = Types[parentIdx];

                    typ.Flags = ReadPacked(Data, ref p);
                    if ((typ.Flags & 0x01) != 0) typ.SubTypeFlags = ReadPacked(Data, ref p);
                    if ((typ.Flags & 0x02) != 0 && (typ.SubTypeFlags & 0xFF) >= 6)
                    {
                        int pointerTypeIndex = ReadPacked(Data, ref p);
                        if (pointerTypeIndex < 0 || pointerTypeIndex >= Types.Count)
                            throw new InvalidDataException($"TAGFILE_POINTER_TYPE_INVALID: type={typ.Name} index={pointerTypeIndex}");
                        typ.PointerType = Types[pointerTypeIndex];
                    }
                    if ((typ.Flags & 0x04) != 0) ReadPacked(Data, ref p); // version
                    if ((typ.Flags & 0x08) != 0)
                    {
                        typ.ByteSize = ReadPacked(Data, ref p);
                        typ.Alignment = ReadPacked(Data, ref p);
                    }
                    if ((typ.Flags & 0x10) != 0) ReadPacked(Data, ref p); // abstract
                    if ((typ.Flags & 0x20) != 0) // members
                    {
                        int memberCount = ReadPacked(Data, ref p);
                        for (int m = 0; m < memberCount; m++)
                        {
                            int nameIdx = ReadPacked(Data, ref p);
                            int flags = ReadPacked(Data, ref p);
                            int byteOffset = ReadPacked(Data, ref p);
                            int memberTypeIdx = ReadPacked(Data, ref p);

                            string memberName = (nameIdx >= 0 && nameIdx < fieldStrings.Count) ? fieldStrings[nameIdx] : string.Empty;
                            TagType? memberType = (memberTypeIdx >= 0 && memberTypeIdx < Types.Count) ? Types[memberTypeIdx] : null;

                            typ.Members.Add(new TagMember
                            {
                                Name = memberName,
                                Flags = flags,
                                ByteOffset = byteOffset,
                                MemberType = memberType
                            });
                        }
                    }
                    if ((typ.Flags & 0x40) != 0) // interfaces
                    {
                        int ifaceCount = ReadPacked(Data, ref p);
                        for (int k = 0; k < ifaceCount; k++)
                        {
                            ReadPacked(Data, ref p);
                            ReadPacked(Data, ref p);
                        }
                    }
                    if ((typ.Flags & 0x80) != 0)
                        throw new InvalidDataException($"TAGFILE_TYPE_FLAGS_UNSUPPORTED: type={typ.Name} flags=0x{typ.Flags:X}");
                }
            }

            offset = subEnd;
        }
    }

    private void ParseIndexChunk(int startOffset, int endOffset)
    {
        int offset = startOffset;
        while (offset + 8 <= endOffset)
        {
            uint subHeader = BinaryPrimitives.ReadUInt32BigEndian(Data.AsSpan(offset, 4));
            int subSize = checked((int)(subHeader & 0x3FFFFFFF));
            string subSig = Encoding.ASCII.GetString(Data, offset + 4, 4);
            int subDataOffset = offset + 8;
            int subEnd = Math.Min(endOffset, offset + subSize);

            if (subSize < 8 || subEnd <= offset)
                throw new InvalidDataException($"TAGFILE_INDEX_SUBCHUNK_INVALID: signature={subSig} size={subSize}");

            if (subSig == "ITEM")
            {
                int p = subDataOffset;
                while (p < subEnd)
                {
                    if (p + 12 > subEnd)
                        throw new InvalidDataException("TAGFILE_ITEM_RECORD_TRUNCATED: INDX/ITEM record is not 12-byte aligned.");
                    uint flag = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p, 4));
                    uint dataOffset = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p + 4, 4));
                    uint count = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p + 8, 4));
                    p += 12;

                    int typeIdx = (int)(flag & 0x00FFFFFF);
                    if (typeIdx < 0 || typeIdx >= Types.Count)
                        throw new InvalidDataException($"TAGFILE_ITEM_TYPE_INVALID: item={Items.Count} typeIndex={typeIdx} count={Types.Count}");
                    if (dataOffset > DataPayload.Length)
                        throw new InvalidDataException($"TAGFILE_ITEM_OFFSET_INVALID: item={Items.Count} offset={dataOffset} dataLength={DataPayload.Length}");
                    if (count > int.MaxValue)
                        throw new InvalidDataException($"TAGFILE_ITEM_COUNT_INVALID: item={Items.Count} count={count}");
                    bool isPtr = (flag & 0x10000000) != 0;
                    var itemType = (typeIdx >= 0 && typeIdx < Types.Count) ? Types[typeIdx] : null;

                    Items.Add(new TagItem
                    {
                        ItemType = itemType,
                        IsPointer = isPtr,
                        DataOffset = (int)dataOffset,
                        Count = (int)count
                    });
                }
            }
            else if (subSig == "PTCH")
            {
                // PTCH is an index of pointer locations. Pointer fields themselves contain
                // item indices, so object decoding does not need to apply the patches, but
                // validating the table catches truncated or out-of-range tagfiles before
                // any semantic projection is attempted.
                int p = subDataOffset;
                while (p < subEnd)
                {
                    if (p + 8 > subEnd)
                        throw new InvalidDataException("TAGFILE_PATCH_GROUP_TRUNCATED: INDX/PTCH group header is incomplete.");
                    int typeIndex = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p, 4)));
                    int patchCount = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p + 4, 4)));
                    p += 8;
                    if (typeIndex < 0 || typeIndex >= Types.Count || patchCount < 0)
                        throw new InvalidDataException($"TAGFILE_PATCH_GROUP_INVALID: typeIndex={typeIndex} count={patchCount}");
                    if (patchCount > (subEnd - p) / 4)
                        throw new InvalidDataException($"TAGFILE_PATCH_GROUP_TRUNCATED: typeIndex={typeIndex} count={patchCount}");
                    for (int i = 0; i < patchCount; i++)
                    {
                        uint patchOffset = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p, 4));
                        p += 4;
                        if (patchOffset >= DataPayload.Length)
                            throw new InvalidDataException($"TAGFILE_PATCH_OFFSET_INVALID: typeIndex={typeIndex} offset={patchOffset} dataLength={DataPayload.Length}");
                    }
                }
            }

            offset = subEnd;
        }
    }

    public HkxAnimationContainer ExtractAnimationContainer()
    {
        var skeletons = new List<HkxSkeleton>();
        var animations = new List<HkxAnimation>();
        var bindings = new List<HkxAnimationBinding>();
        var animationByItemIndex = new Dictionary<int, HkxAnimation>();

        // TAG0 ITEM[0] is the null item. Decode the concrete animation objects first;
        // bindings refer to those objects by item index and are linked in a second pass.
        for (int itemIndex = 0; itemIndex < Items.Count; itemIndex++)
        {
            var item = Items[itemIndex];
            if (item.ItemType == null) continue;
            string typeName = item.ItemType.Name;

            if (typeName == "hkaSkeleton")
            {
                var skel = ExtractSkeleton(itemIndex, item);
                if (skel != null) skeletons.Add(skel);
            }
            else if (typeName is "hkaSplineCompressedAnimation" or "hkaInterleavedUncompressedAnimation" or "hkaAnimation")
            {
                var anim = ExtractAnimation(itemIndex, item);
                if (anim != null)
                {
                    animations.Add(anim);
                    animationByItemIndex[itemIndex] = anim;
                }
            }
        }

        for (int itemIndex = 0; itemIndex < Items.Count; itemIndex++)
        {
            var item = Items[itemIndex];
            if (item.ItemType?.Name != "hkaAnimationBinding") continue;

            var binding = ExtractBinding(itemIndex, item);
            if (binding != null)
            {
                if (binding.AnimationObjectOffset >= 0)
                {
                    var animationItemIndex = FindItemIndexByDataOffset(binding.AnimationObjectOffset);
                    if (animationItemIndex < 0 || !animationByItemIndex.TryGetValue(animationItemIndex, out var animation))
                    {
                        throw new InvalidDataException(
                            $"ACTION_HKX_TAGFILE_BINDING_TARGET_INVALID: bindingOffset={binding.NativeObjectOffset} animationOffset={binding.AnimationObjectOffset}");
                    }
                    binding.Animation = animation;
                }
                bindings.Add(binding);
            }
        }

        return new HkxAnimationContainer
        {
            Skeletons = skeletons,
            Animations = animations,
            Bindings = bindings
        };
    }

    private HkxSkeleton? ExtractSkeleton(int itemIndex, TagItem item)
    {
        var value = ReadSingleItem(itemIndex, item);
        var fields = RequireFields(value, item.ItemType?.Name ?? "hkaSkeleton", item.DataOffset);
        var bones = ReadFields(fields, "bones").Select(ReadBone).ToArray();
        var transforms = ReadFields(fields, "referencePose", "transforms")
            .Select(ReadBoneTransform)
            .ToArray();

        if (bones.Length == 0 || transforms.Length == 0 || bones.Length != transforms.Length)
        {
            throw new InvalidDataException(
                $"ACTION_HKX_TAGFILE_SKELETON_INVALID: offset={item.DataOffset} bones={bones.Length} transforms={transforms.Length}");
        }

        return new HkxSkeleton
        {
            Name = ReadStringField(fields, "name"),
            NativeObjectOffset = item.DataOffset,
            ParentIndices = ReadIntFields(fields, "parentIndices"),
            Bones = bones,
            Transforms = transforms
        };
    }

    private HkxAnimationBinding? ExtractBinding(int itemIndex, TagItem item)
    {
        var value = ReadSingleItem(itemIndex, item);
        var fields = RequireFields(value, item.ItemType?.Name ?? "hkaAnimationBinding", item.DataOffset);
        var animation = TryGetField(fields, "animation");
        if (animation?.ItemIndex is not > 0 || animation.ItemIndex >= Items.Count)
        {
            throw new InvalidDataException(
                $"ACTION_HKX_TAGFILE_BINDING_MISSING: bindingOffset={item.DataOffset} animation pointer is null or out of range.");
        }
        var animationItem = Items[animation.ItemIndex];
        if (animationItem.ItemType == null || animationItem.DataOffset < 0 || animationItem.DataOffset >= DataPayload.Length)
        {
            throw new InvalidDataException(
                $"ACTION_HKX_TAGFILE_BINDING_TARGET_INVALID: bindingOffset={item.DataOffset} animationItem={animation.ItemIndex}.");
        }
        var animationOffset = animationItem.DataOffset;

        return new HkxAnimationBinding
        {
            NativeObjectOffset = item.DataOffset,
            AnimationObjectOffset = animationOffset,
            OriginalSkeletonName = ReadStringField(fields, "originalSkeletonName"),
            TransformTrackToBoneIndices = ReadIntFields(fields, "transformTrackToBoneIndices")
                .Select(index => (int)index)
                .ToArray()
        };
    }

    private HkxAnimation? ExtractAnimation(int itemIndex, TagItem item)
    {
        var value = ReadSingleItem(itemIndex, item);
        var fields = RequireFields(value, item.ItemType?.Name ?? "hkaAnimation", item.DataOffset);
        var typeName = item.ItemType?.Name ?? string.Empty;
        var duration = ReadFloatField(fields, "duration");
        var transformTrackCount = ReadIntField(fields, "numberOfTransformTracks");
        var floatTrackCount = ReadIntField(fields, "numberOfFloatTracks");

        if (typeName is "hkaSplineCompressedAnimation" or "hkaAnimation" && HasField(fields, "numFrames", "numberOfFrames"))
        {
            var animation = new HkxSplineCompressedAnimation
            {
                AnimationType = HkxAnimationType.SplineCompressed,
                NativeObjectOffset = item.DataOffset,
                Duration = duration,
                NumberOfTransformTracks = transformTrackCount,
                NumberOfFloatTracks = floatTrackCount,
                NumFrames = ReadIntField(fields, "numFrames", "numberOfFrames"),
                NumBlocks = ReadIntField(fields, "numBlocks", "numberOfBlocks"),
                MaxFramesPerBlock = ReadIntField(fields, "maxFramesPerBlock", "framesPerBlock"),
                MaskAndQuantizationSize = ReadIntField(fields, "maskAndQuantizationSize", "maskAndQuantization"),
                BlockDuration = ReadFloatField(fields, "blockDuration"),
                BlockInverseDuration = ReadFloatField(fields, "blockInverseDuration", "inverseBlockDuration"),
                FrameDuration = ReadFloatField(fields, "frameDuration"),
                BlockOffsets = ReadUIntFields(fields, "blockOffsets"),
                FloatBlockOffsets = ReadUIntFields(fields, "floatBlockOffsets"),
                TransformOffsets = ReadUIntFields(fields, "transformOffsets"),
                FloatOffsets = ReadUIntFields(fields, "floatOffsets"),
                Data = ReadByteFields(fields, "data")
            };

            if (animation.NumBlocks <= 0 || animation.NumberOfTransformTracks <= 0)
                throw new InvalidDataException($"ACTION_HKX_TAGFILE_SPLINE_METADATA_INVALID: offset={item.DataOffset}");
            animation.Blocks = HkxAnimationReader.ParseSplineBlocks(animation);
            return animation;
        }

        if (typeName == "hkaInterleavedUncompressedAnimation")
        {
            var transforms = ReadFields(fields, "transforms")
                .Select(ReadBoneTransform)
                .ToArray();
            var numFrames = transformTrackCount > 0 ? transforms.Length / transformTrackCount : 0;
            return new HkxInterleavedAnimation
            {
                AnimationType = HkxAnimationType.Interleaved,
                NativeObjectOffset = item.DataOffset,
                Duration = duration,
                NumberOfTransformTracks = transformTrackCount,
                NumberOfFloatTracks = floatTrackCount,
                NumFrames = numFrames,
                FrameDuration = numFrames > 1 ? duration / (numFrames - 1) : 1f / 30f,
                Transforms = transforms
            };
        }

        throw new NotSupportedException(
            $"ACTION_HKX_TAGFILE_ANIMATION_UNSUPPORTED: {typeName} (itemOffset={item.DataOffset}).");
    }

    private TagValue ReadSingleItem(int itemIndex, TagItem item)
    {
        if (item.Count != 1 || item.ItemType == null)
            throw new InvalidDataException($"TAGFILE_SINGLE_ITEM_REQUIRED: item={itemIndex} type={item.ItemType?.Name ?? "<null>"} count={item.Count}");
        return ReadItemValues(itemIndex)[0];
    }

    private IReadOnlyList<TagValue> ReadItemValues(int itemIndex)
    {
        if (itemIndex <= 0 || itemIndex >= Items.Count)
            throw new InvalidDataException($"TAGFILE_ITEM_REFERENCE_INVALID: itemIndex={itemIndex} itemCount={Items.Count}");
        if (itemValues.TryGetValue(itemIndex, out var cached))
            return cached;
        if (!activeItems.Add(itemIndex))
            throw new InvalidDataException($"TAGFILE_ITEM_REFERENCE_CYCLE: itemIndex={itemIndex}");

        try
        {
            var item = Items[itemIndex];
            if (item.ItemType == null)
                throw new InvalidDataException($"TAGFILE_ITEM_TYPE_MISSING: itemIndex={itemIndex}");
            var elementType = item.ItemType.EffectiveType();
            var elementSize = elementType.ByteSize;
            if (elementSize <= 0)
                throw new InvalidDataException($"TAGFILE_ITEM_SIZE_MISSING: itemIndex={itemIndex} type={item.ItemType.Name}");
            if (item.Count < 0 || item.Count > (DataPayload.Length - item.DataOffset) / elementSize)
                throw new InvalidDataException($"TAGFILE_ITEM_BOUNDS_INVALID: itemIndex={itemIndex} offset={item.DataOffset} count={item.Count} elementSize={elementSize} dataLength={DataPayload.Length}");

            var values = new List<TagValue>(item.Count);
            for (int i = 0; i < item.Count; i++)
            {
                int elementOffset = checked(item.DataOffset + i * elementSize);
                values.Add(ReadObject(item.ItemType, elementOffset, itemIndex));
            }
            itemValues[itemIndex] = values;
            return values;
        }
        finally
        {
            activeItems.Remove(itemIndex);
        }
    }

    private TagValue ReadObject(TagType type, int offset, int sourceItemIndex = -1)
    {
        if (offset < 0 || offset > DataPayload.Length)
            throw new InvalidDataException($"TAGFILE_OBJECT_OFFSET_INVALID: type={type.Name} offset={offset}");

        var effective = type.EffectiveType();
        var size = effective.ByteSize;
        if (size <= 0 || offset + size > DataPayload.Length)
            throw new InvalidDataException($"TAGFILE_OBJECT_BOUNDS_INVALID: type={type.Name} effective={effective.Name} offset={offset} size={size} dataLength={DataPayload.Length}");

        return effective.SubType switch
        {
            0x02 => new TagValue(type, ReadBool(effective.SubTypeFlags, offset), sourceItemIndex, offset),
            0x03 => ReadStringPointer(type, offset),
            0x04 => new TagValue(type, ReadInteger(effective.SubTypeFlags, effective.ByteSize, offset), sourceItemIndex, offset),
            0x05 => new TagValue(type, BinaryPrimitives.ReadSingleLittleEndian(DataPayload.AsSpan(offset, 4)), sourceItemIndex, offset),
            0x06 when effective.Name == "hkStringPtr" => ReadStringPointer(type, offset),
            0x06 => ReadPointer(type, offset),
            0x07 => ReadClass(type, effective, offset, sourceItemIndex),
            0x08 => ReadArray(type, offset),
            0x28 => ReadTuple(type, effective, offset, sourceItemIndex),
            _ => throw new NotSupportedException($"ACTION_HKX_TAGFILE_TYPE_UNSUPPORTED: type={type.Name} subtype=0x{effective.SubType:X2}")
        };
    }

    private TagValue ReadPointer(TagType type, int offset)
    {
        int itemIndex = ReadItemIndex(offset, type.Name);
        if (itemIndex == 0)
            return new TagValue(type, null, 0, -1);

        var values = ReadItemValues(itemIndex);
        if (values.Count != 1)
        {
            return new TagValue(type, values, itemIndex, Items[itemIndex].DataOffset);
        }

        return new TagValue(type, values[0].Value, itemIndex, values[0].DataOffset);
    }

    private TagValue ReadArray(TagType type, int offset)
    {
        int itemIndex = ReadItemIndex(offset, type.Name);
        if (itemIndex == 0)
            return new TagValue(type, Array.Empty<TagValue>(), 0, -1);
        return new TagValue(type, ReadItemValues(itemIndex), itemIndex, Items[itemIndex].DataOffset);
    }

    private TagValue ReadClass(TagType type, TagType effective, int offset, int sourceItemIndex)
    {
        var fields = new Dictionary<string, TagValue>(StringComparer.Ordinal);
        foreach (var member in effective.AllMembers())
        {
            if (member.MemberType == null)
                throw new InvalidDataException($"TAGFILE_MEMBER_TYPE_MISSING: type={effective.Name} member={member.Name}");
            int memberOffset = checked(offset + member.ByteOffset);
            fields[member.Name] = ReadObject(member.MemberType, memberOffset, sourceItemIndex);
        }
        return new TagValue(type, fields, sourceItemIndex, offset);
    }

    private TagValue ReadTuple(TagType type, TagType effective, int offset, int sourceItemIndex)
    {
        if (effective.PointerType == null)
            throw new InvalidDataException($"TAGFILE_TUPLE_ELEMENT_TYPE_MISSING: type={effective.Name}");
        int tupleSize = effective.SubTypeFlags >> 8;
        int elementSize = effective.PointerType.EffectiveType().ByteSize;
        if (tupleSize <= 0 || elementSize <= 0 || checked(tupleSize * elementSize) > effective.ByteSize)
            throw new InvalidDataException($"TAGFILE_TUPLE_LAYOUT_INVALID: type={effective.Name} tupleSize={tupleSize} elementSize={elementSize} byteSize={effective.ByteSize}");

        var values = new List<TagValue>(tupleSize);
        for (int i = 0; i < tupleSize; i++)
            values.Add(ReadObject(effective.PointerType, checked(offset + i * elementSize), sourceItemIndex));
        return new TagValue(type, values, sourceItemIndex, offset);
    }

    private int ReadItemIndex(int offset, string fieldName)
    {
        if (offset < 0 || offset + 4 > DataPayload.Length)
            throw new InvalidDataException($"TAGFILE_ITEM_POINTER_BOUNDS_INVALID: field={fieldName} offset={offset}");
        uint raw = BinaryPrimitives.ReadUInt32LittleEndian(DataPayload.AsSpan(offset, 4));
        if (raw > int.MaxValue)
            throw new InvalidDataException($"TAGFILE_ITEM_POINTER_INVALID: field={fieldName} value={raw}");
        int itemIndex = (int)raw;
        if (itemIndex >= Items.Count)
            throw new InvalidDataException($"TAGFILE_ITEM_POINTER_INVALID: field={fieldName} value={itemIndex} itemCount={Items.Count}");
        return itemIndex;
    }

    private TagValue ReadStringPointer(TagType type, int offset)
    {
        int itemIndex = ReadItemIndex(offset, "hkStringPtr");
        if (itemIndex == 0) return new TagValue(type, string.Empty, 0, -1);
        var values = ReadItemValues(itemIndex);
        var chars = new List<char>(values.Count);
        foreach (var value in values)
        {
            int code = checked((int)ReadIntValue(value, "hkStringPtr"));
            if (code == 0) break;
            if (code < 0 || code > char.MaxValue)
                throw new InvalidDataException($"TAGFILE_STRING_VALUE_INVALID: value={code}");
            chars.Add((char)code);
        }
        return new TagValue(type, new string(chars.ToArray()), itemIndex, Items[itemIndex].DataOffset);
    }

    private bool ReadBool(int flags, int offset)
    {
        return ReadInteger(flags, 1, offset) != 0;
    }

    private long ReadInteger(int flags, int byteSize, int offset)
    {
        bool signed = (flags & 0x200) != 0;
        int width = (flags & 0x2000) != 0 ? 1
            : (flags & 0x4000) != 0 ? 2
            : (flags & 0x8000) != 0 ? 4
            : (flags & 0x10000) != 0 ? 8
            : byteSize;
        if (width is not (1 or 2 or 4 or 8))
            throw new InvalidDataException($"TAGFILE_INTEGER_WIDTH_INVALID: flags=0x{flags:X} byteSize={byteSize}");
        var span = DataPayload.AsSpan(offset, width);
        return width switch
        {
            1 => signed ? (sbyte)span[0] : span[0],
            2 => signed ? BinaryPrimitives.ReadInt16LittleEndian(span) : BinaryPrimitives.ReadUInt16LittleEndian(span),
            4 => signed ? BinaryPrimitives.ReadInt32LittleEndian(span) : BinaryPrimitives.ReadUInt32LittleEndian(span),
            8 => signed ? BinaryPrimitives.ReadInt64LittleEndian(span) : checked((long)BinaryPrimitives.ReadUInt64LittleEndian(span)),
            _ => throw new InvalidDataException($"TAGFILE_INTEGER_WIDTH_INVALID: width={width}")
        };
    }

    private int FindItemIndexByDataOffset(int dataOffset)
    {
        for (int i = 1; i < Items.Count; i++)
        {
            if (Items[i].DataOffset == dataOffset)
                return i;
        }
        return -1;
    }

    private static Dictionary<string, TagValue> RequireFields(TagValue value, string typeName, int offset)
    {
        if (value.Value is Dictionary<string, TagValue> fields)
            return fields;
        throw new InvalidDataException($"TAGFILE_CLASS_VALUE_INVALID: type={typeName} offset={offset}");
    }

    private static TagValue? TryGetField(Dictionary<string, TagValue> fields, params string[] names)
    {
        foreach (var name in names)
        {
            if (fields.TryGetValue(name, out var value))
                return value;
        }
        return null;
    }

    private static bool HasField(Dictionary<string, TagValue> fields, params string[] names)
        => TryGetField(fields, names) != null;

    private static TagValue RequireField(Dictionary<string, TagValue> fields, params string[] names)
        => TryGetField(fields, names) ?? throw new InvalidDataException($"TAGFILE_FIELD_MISSING: expected={string.Join('|', names)}");

    private static string ReadStringField(Dictionary<string, TagValue> fields, params string[] names)
    {
        var value = RequireField(fields, names).Value;
        return value as string ?? throw new InvalidDataException($"TAGFILE_STRING_FIELD_INVALID: field={string.Join('|', names)}");
    }

    private static int ReadIntField(Dictionary<string, TagValue> fields, params string[] names)
        => checked((int)ReadIntValue(RequireField(fields, names), string.Join('|', names)));

    private static float ReadFloatField(Dictionary<string, TagValue> fields, params string[] names)
    {
        var value = RequireField(fields, names).Value;
        if (value is float f && float.IsFinite(f)) return f;
        if (value is double d && double.IsFinite(d)) return checked((float)d);
        throw new InvalidDataException($"TAGFILE_FLOAT_FIELD_INVALID: field={string.Join('|', names)}");
    }

    private static long ReadIntValue(TagValue value, string fieldName)
    {
        return value.Value switch
        {
            byte number => number,
            sbyte number => number,
            short number => number,
            ushort number => number,
            int number => number,
            uint number => checked((long)number),
            long number => number,
            ulong number => checked((long)number),
            _ => throw new InvalidDataException($"TAGFILE_INTEGER_FIELD_INVALID: field={fieldName} type={value.Value?.GetType().Name ?? "null"}")
        };
    }

    private static IReadOnlyList<TagValue> ReadFields(Dictionary<string, TagValue> fields, params string[] names)
    {
        var value = RequireField(fields, names).Value;
        if (value is IReadOnlyList<TagValue> list) return list;
        if (value is IEnumerable<TagValue> enumerable) return enumerable.ToArray();
        throw new InvalidDataException($"TAGFILE_ARRAY_FIELD_INVALID: field={string.Join('|', names)}");
    }

    private static short[] ReadIntFields(Dictionary<string, TagValue> fields, params string[] names)
        => ReadFields(fields, names).Select(value => checked((short)ReadIntValue(value, string.Join('|', names)))).ToArray();

    private static uint[] ReadUIntFields(Dictionary<string, TagValue> fields, params string[] names)
        => ReadFields(fields, names).Select(value => checked((uint)ReadIntValue(value, string.Join('|', names)))).ToArray();

    private static byte[] ReadByteFields(Dictionary<string, TagValue> fields, params string[] names)
        => ReadFields(fields, names).Select(value => checked((byte)ReadIntValue(value, string.Join('|', names)))).ToArray();

    private static HkxBone ReadBone(TagValue value)
    {
        var fields = RequireFields(value, "hkaBone", value.DataOffset);
        var lockTranslation = TryGetField(fields, "lockTranslation")?.Value switch
        {
            bool flag => flag,
            null => false,
            _ => ReadIntValue(RequireField(fields, "lockTranslation"), "lockTranslation") != 0
        };
        return new HkxBone
        {
            Name = ReadStringField(fields, "name"),
            LockTranslation = lockTranslation
        };
    }

    private static BoneTransform ReadBoneTransform(TagValue value)
    {
        var fields = RequireFields(value, "hkQsTransformf", value.DataOffset);
        return new BoneTransform(
            ReadVector3(RequireField(fields, "translation"), "translation"),
            ReadQuaternion(RequireField(fields, "rotation"), "rotation"),
            ReadVector3(RequireField(fields, "scale"), "scale"));
    }

    private static Vector3 ReadVector3(TagValue value, string fieldName)
    {
        var values = FlattenNumbers(value);
        if (values.Count < 3)
            throw new InvalidDataException($"TAGFILE_VECTOR_FIELD_INVALID: field={fieldName} count={values.Count}");
        return new Vector3(values[0], values[1], values[2]);
    }

    private static Quaternion ReadQuaternion(TagValue value, string fieldName)
    {
        var values = FlattenNumbers(value);
        if (values.Count < 4)
            throw new InvalidDataException($"TAGFILE_QUATERNION_FIELD_INVALID: field={fieldName} count={values.Count}");
        var quaternion = new Quaternion(values[0], values[1], values[2], values[3]);
        if (!float.IsFinite(quaternion.X) || !float.IsFinite(quaternion.Y)
            || !float.IsFinite(quaternion.Z) || !float.IsFinite(quaternion.W)
            || quaternion.LengthSquared() < 1e-12f)
        {
            throw new InvalidDataException($"TAGFILE_QUATERNION_VALUE_INVALID: field={fieldName}");
        }
        return Quaternion.Normalize(quaternion);
    }

    private static List<float> FlattenNumbers(TagValue value)
    {
        if (value.Value is float f) return new List<float> { f };
        if (value.Value is double d) return new List<float> { checked((float)d) };
        if (value.Value is Dictionary<string, TagValue> fields)
        {
            var values = new List<float>();
            foreach (var name in new[] { "x", "y", "z", "w" })
            {
                if (fields.TryGetValue(name, out var component))
                    values.AddRange(FlattenNumbers(component));
            }
            if (values.Count > 0) return values;
            foreach (var component in fields.Values)
                values.AddRange(FlattenNumbers(component));
            return values;
        }
        if (value.Value is IReadOnlyList<TagValue> list)
        {
            var values = new List<float>();
            foreach (var component in list)
                values.AddRange(FlattenNumbers(component));
            return values;
        }
        return new List<float>();
    }

    public static int ReadPacked(ReadOnlySpan<byte> buf, ref int offset)
    {
        if (offset >= buf.Length) throw new InvalidDataException("TAGFILE_PACKED_VALUE_TRUNCATED");
        byte b0 = buf[offset++];
        if ((b0 & 0x80) == 0) return b0;
        if ((b0 & 0x40) == 0)
        {
            RequirePackedBytes(buf, offset, 1);
            return ((b0 & 0x3F) << 8) | buf[offset++];
        }
        if ((b0 & 0x20) == 0)
        {
            RequirePackedBytes(buf, offset, 2);
            int value = ((b0 & 0x1F) << 16) | (buf[offset] << 8) | buf[offset + 1];
            offset += 2;
            return value;
        }
        RequirePackedBytes(buf, offset, 3);
        int large = ((b0 & 0x07) << 24) | (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
        offset += 3;
        return large;
    }

    private static void RequirePackedBytes(ReadOnlySpan<byte> buf, int offset, int count)
    {
        if (offset < 0 || count < 0 || offset > buf.Length - count)
            throw new InvalidDataException("TAGFILE_PACKED_VALUE_TRUNCATED");
    }
}

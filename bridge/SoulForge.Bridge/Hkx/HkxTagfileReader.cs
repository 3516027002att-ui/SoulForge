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
        public int ByteSize { get; set; }
        public int Alignment { get; set; }
        public List<TagMember> Members { get; } = new();
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

    public byte[] Data { get; }
    public List<TagType?> Types { get; private set; } = new();
    public List<TagItem> Items { get; } = new();
    public byte[] DataPayload { get; private set; } = Array.Empty<byte>();

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
        int rootSize = (int)(rootHeader & 0x3FFFFFFF);
        string rootSig = Encoding.ASCII.GetString(Data, offset + 4, 4);
        offset += 8;

        if (rootSig is not "TAG0" and not "TCM0")
            throw new InvalidDataException($"Invalid Tagfile root signature: '{rootSig}', expected 'TAG0' or 'TCM0'.");

        int rootEnd = Math.Min(Data.Length, offset - 8 + rootSize);

        while (offset + 8 <= rootEnd)
        {
            uint chunkHeader = BinaryPrimitives.ReadUInt32BigEndian(Data.AsSpan(offset, 4));
            int chunkSize = (int)(chunkHeader & 0x3FFFFFFF);
            string sig = Encoding.ASCII.GetString(Data, offset + 4, 4);
            int chunkDataOffset = offset + 8;
            int chunkEnd = Math.Min(rootEnd, offset + chunkSize);

            if (chunkSize < 8) break;

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
                if (compendium != null)
                {
                    Types = compendium.Types;
                }
            }
            else if (sig == "INDX")
            {
                ParseIndexChunk(chunkDataOffset, chunkEnd);
            }

            offset = chunkEnd;
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
            int subSize = (int)(subHeader & 0x3FFFFFFF);
            string subSig = Encoding.ASCII.GetString(Data, offset + 4, 4);
            int subDataOffset = offset + 8;
            int subEnd = Math.Min(endOffset, offset + subSize);

            if (subSig == "TSTR")
            {
                int len = subSize - 8;
                if (len > 0 && subDataOffset + len <= Data.Length)
                {
                    var rawStr = Encoding.ASCII.GetString(Data, subDataOffset, len);
                    typeStrings = rawStr.Split('\0').ToList();
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
                    var t = new TagType { Name = name };

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
                    if (typeIndex >= Types.Count) break;

                    var typ = Types[typeIndex];
                    if (typ == null) continue;

                    int parentIdx = ReadPacked(Data, ref p);
                    if (parentIdx >= 0 && parentIdx < Types.Count) typ.Parent = Types[parentIdx];

                    typ.Flags = ReadPacked(Data, ref p);
                    if ((typ.Flags & 0x01) != 0) typ.SubTypeFlags = ReadPacked(Data, ref p);
                    if ((typ.Flags & 0x02) != 0 && (typ.SubTypeFlags & 0x0F) >= 6) ReadPacked(Data, ref p);
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
            int subSize = (int)(subHeader & 0x3FFFFFFF);
            string subSig = Encoding.ASCII.GetString(Data, offset + 4, 4);
            int subDataOffset = offset + 8;
            int subEnd = Math.Min(endOffset, offset + subSize);

            if (subSig == "ITEM")
            {
                int p = subDataOffset;
                while (p + 12 <= subEnd)
                {
                    uint flag = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p, 4));
                    uint dataOffset = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p + 4, 4));
                    uint count = BinaryPrimitives.ReadUInt32LittleEndian(Data.AsSpan(p + 8, 4));
                    p += 12;

                    int typeIdx = (int)(flag & 0x00FFFFFF);
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

            offset = subEnd;
        }
    }

    public HkxAnimationContainer ExtractAnimationContainer()
    {
        var skeletons = new List<HkxSkeleton>();
        var animations = new List<HkxAnimation>();
        var bindings = new List<HkxAnimationBinding>();

        // If items are present, find animation, skeleton, and binding items
        foreach (var item in Items)
        {
            if (item.ItemType == null) continue;
            string typeName = item.ItemType.Name;

            if (typeName == "hkaSkeleton")
            {
                var skel = ExtractSkeleton(item);
                if (skel != null) skeletons.Add(skel);
            }
            else if (typeName == "hkaAnimationBinding")
            {
                var binding = ExtractBinding(item);
                if (binding != null) bindings.Add(binding);
            }
            else if (typeName is "hkaSplineCompressedAnimation" or "hkaInterleavedUncompressedAnimation" or "hkaAnimation")
            {
                var anim = ExtractAnimation(item);
                if (anim != null) animations.Add(anim);
            }
        }

        foreach (var b in bindings)
        {
            if (b.Animation == null && animations.Count > 0)
            {
                b.Animation = animations[0];
            }
        }

        return new HkxAnimationContainer
        {
            Skeletons = skeletons,
            Animations = animations,
            Bindings = bindings
        };
    }

    private HkxSkeleton? ExtractSkeleton(TagItem item)
    {
        // Tagfile skeleton extraction
        return new HkxSkeleton
        {
            Name = "SekiroSkeleton",
            Bones = Array.Empty<HkxBone>(),
            ParentIndices = Array.Empty<short>(),
            Transforms = Array.Empty<BoneTransform>()
        };
    }

    private HkxAnimationBinding? ExtractBinding(TagItem item)
    {
        return new HkxAnimationBinding
        {
            OriginalSkeletonName = string.Empty,
            TransformTrackToBoneIndices = Array.Empty<int>()
        };
    }

    private HkxAnimation? ExtractAnimation(TagItem item)
    {
        return null;
    }

    public static int ReadPacked(ReadOnlySpan<byte> buf, ref int offset)
    {
        if (offset >= buf.Length) return 0;
        byte b0 = buf[offset++];
        if ((b0 & 0x80) == 0) return b0;
        if (offset >= buf.Length) return b0 & 0x7F;
        byte b1 = buf[offset++];
        if ((b0 & 0x40) == 0) return ((b0 & 0x3F) << 8) | b1;
        if (offset >= buf.Length) return ((b0 & 0x3F) << 8) | b1;
        byte b2 = buf[offset++];
        if ((b0 & 0x20) == 0) return ((b0 & 0x1F) << 16) | (b1 << 8) | b2;
        if (offset >= buf.Length) return ((b0 & 0x1F) << 16) | (b1 << 8) | b2;
        byte b3 = buf[offset++];
        if ((b0 & 0x10) == 0) return ((b0 & 0x0F) << 24) | (b1 << 16) | (b2 << 8) | b3;
        if (offset >= buf.Length) return ((b0 & 0x0F) << 24) | (b1 << 16) | (b2 << 8) | b3;
        byte b4 = buf[offset++];
        return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
    }
}

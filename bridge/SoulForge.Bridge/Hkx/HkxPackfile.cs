// MIT License
// Copyright (c) 2026 SoulForge Authors
// Derived clean-room implementation of Havok 2014 binary packfile format (0x57E0E057).
// References: SoulsFormats (MIT) by TKGP/vawser and HKLib (MIT) by The12thAvenger.

using System.Buffers.Binary;
using System.Text;

namespace SoulForge.Bridge.Hkx;

/// <summary>
/// Low-level Havok 2014.1.0-r1 (0x57E0E057) binary packfile parser.
/// Reads __classnames__, __types__, and __data__ sections, including local, virtual, and global fixups.
/// </summary>
internal sealed class HkxPackfile
{
    public const uint Magic0 = 0x57E0E057;
    public const uint Magic1 = 0x10C0C010;

    public sealed class Header
    {
        public uint Magic0;
        public uint Magic1;
        public int UserTag;
        public int Version;
        public byte PointerSize;
        public byte Endian;
        public byte PaddingOption;
        public byte BaseClass;
        public int SectionCount;
        public int ContentsSectionIndex;
        public int ContentsSectionOffset;
        public int ContentsClassNameSectionIndex;
        public int ContentsClassNameSectionOffset;
        public string ContentsVersionString = string.Empty;
        public int Flags;
        public short SectionOffset;
    }

    public sealed class LocalFixup
    {
        public uint Src;
        public uint Dst;
    }

    public sealed class GlobalFixup
    {
        public uint Src;
        public uint DstSectionIndex;
        public uint Dst;
    }

    public sealed class VirtualFixup
    {
        public uint Src;
        public uint SectionIndex;
        public uint NameOffset;
    }

    public sealed class Section
    {
        public int SectionId;
        public string SectionTag = string.Empty;
        public uint AbsoluteDataStart;
        public uint LocalFixupsOffset;
        public uint GlobalFixupsOffset;
        public uint VirtualFixupsOffset;
        public uint ExportsOffset;
        public uint ImportsOffset;
        public uint EndOffset;
        public byte[] SectionData = Array.Empty<byte>();

        public List<LocalFixup> LocalFixups = new();
        public List<GlobalFixup> GlobalFixups = new();
        public List<VirtualFixup> VirtualFixups = new();

        public Dictionary<uint, uint> LocalFixupMap = new();
        public Dictionary<uint, uint> VirtualFixupMap = new();
    }

    public Header PackfileHeader { get; }
    public Section ClassSection { get; }
    public Section TypeSection { get; }
    public Section DataSection { get; }
    public Dictionary<uint, string> ClassNamesByOffset { get; } = new();

    public HkxPackfile(Header header, Section classSection, Section typeSection, Section dataSection, Dictionary<uint, string> classNames)
    {
        PackfileHeader = header;
        ClassSection = classSection;
        TypeSection = typeSection;
        DataSection = dataSection;
        ClassNamesByOffset = classNames;
    }

    public static HkxPackfile Read(byte[] bytes)
    {
        if (bytes.Length < 0x40)
            throw new InvalidDataException($"HKX byte length {bytes.Length} is too short for a packfile header.");

        var magic0 = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(0, 4));
        var magic1 = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4, 4));
        if (magic0 != Magic0 || magic1 != Magic1)
            throw new InvalidDataException($"Invalid HKX magic: 0x{magic0:X8} 0x{magic1:X8}, expected 0x{Magic0:X8} 0x{Magic1:X8}.");

        var header = new Header
        {
            Magic0 = magic0,
            Magic1 = magic1,
            UserTag = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(8, 4)),
            Version = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(12, 4)),
            PointerSize = bytes[16],
            Endian = bytes[17],
            PaddingOption = bytes[18],
            BaseClass = bytes[19],
            SectionCount = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(20, 4)),
            ContentsSectionIndex = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(24, 4)),
            ContentsSectionOffset = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(28, 4)),
            ContentsClassNameSectionIndex = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(32, 4)),
            ContentsClassNameSectionOffset = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(36, 4)),
            ContentsVersionString = Encoding.ASCII.GetString(bytes, 40, 16).TrimEnd('\0', ' '),
            Flags = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(56, 4))
        };

        if (header.SectionCount < 3)
            throw new InvalidDataException($"HKX section count is {header.SectionCount}, expected at least 3.");

        int sectionHeaderOffset = 0x40;
        if (header.Version >= 0x0B)
        {
            header.SectionOffset = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(60, 2));
            sectionHeaderOffset = 0x40 + header.SectionOffset;
        }

        var sections = new List<Section>();
        int curHeaderOffset = sectionHeaderOffset;
        for (int i = 0; i < header.SectionCount; i++)
        {
            if (curHeaderOffset + 0x30 > bytes.Length)
                throw new InvalidDataException($"HKX truncated while reading section header {i}.");

            var sec = new Section
            {
                SectionId = i,
                SectionTag = Encoding.ASCII.GetString(bytes, curHeaderOffset, 19).TrimEnd('\0', ' '),
                AbsoluteDataStart = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x14, 4)),
                LocalFixupsOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x18, 4)),
                GlobalFixupsOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x1C, 4)),
                VirtualFixupsOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x20, 4)),
                ExportsOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x24, 4)),
                ImportsOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x28, 4)),
                EndOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(curHeaderOffset + 0x2C, 4))
            };

            int dataSize = (int)(sec.LocalFixupsOffset != 0xFFFFFFFF
                ? sec.LocalFixupsOffset
                : (sec.GlobalFixupsOffset != 0xFFFFFFFF
                    ? sec.GlobalFixupsOffset
                    : (sec.VirtualFixupsOffset != 0xFFFFFFFF
                        ? sec.VirtualFixupsOffset
                        : (sec.EndOffset != 0xFFFFFFFF ? sec.EndOffset : 0))));

            int absStart = (int)sec.AbsoluteDataStart;
            if (absStart + dataSize <= bytes.Length && dataSize > 0)
            {
                sec.SectionData = new byte[dataSize];
                Array.Copy(bytes, absStart, sec.SectionData, 0, dataSize);
            }

            // Read Local Fixups
            if (sec.LocalFixupsOffset != 0xFFFFFFFF && sec.LocalFixupsOffset != sec.GlobalFixupsOffset)
            {
                int p = (int)(absStart + sec.LocalFixupsOffset);
                while (p + 8 <= bytes.Length)
                {
                    uint src = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p, 4));
                    uint dst = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p + 4, 4));
                    p += 8;
                    if (src == 0xFFFFFFFF) break;
                    sec.LocalFixups.Add(new LocalFixup { Src = src, Dst = dst });
                    sec.LocalFixupMap[src] = dst;
                }
            }

            // Read Global Fixups
            if (sec.GlobalFixupsOffset != 0xFFFFFFFF && sec.GlobalFixupsOffset != sec.VirtualFixupsOffset)
            {
                int p = (int)(absStart + sec.GlobalFixupsOffset);
                while (p + 12 <= bytes.Length)
                {
                    uint src = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p, 4));
                    uint secIdx = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p + 4, 4));
                    uint dst = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p + 8, 4));
                    p += 12;
                    if (src == 0xFFFFFFFF) break;
                    sec.GlobalFixups.Add(new GlobalFixup { Src = src, DstSectionIndex = secIdx, Dst = dst });
                }
            }

            // Read Virtual Fixups
            if (sec.VirtualFixupsOffset != 0xFFFFFFFF && sec.VirtualFixupsOffset != sec.ExportsOffset)
            {
                int p = (int)(absStart + sec.VirtualFixupsOffset);
                while (p + 12 <= bytes.Length)
                {
                    uint src = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p, 4));
                    uint secIdx = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p + 4, 4));
                    uint nameOff = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(p + 8, 4));
                    p += 12;
                    if (src == 0xFFFFFFFF) break;
                    sec.VirtualFixups.Add(new VirtualFixup { Src = src, SectionIndex = secIdx, NameOffset = nameOff });
                    sec.VirtualFixupMap[src] = nameOff;
                }
            }

            sections.Add(sec);
            curHeaderOffset += 0x30;
        }

        var classSec = sections[0];
        var typeSec = sections[1];
        var dataSec = sections[2];

        // Parse __classnames__ table
        var classNamesByOffset = new Dictionary<uint, string>();
        if (classSec.SectionData.Length > 0)
        {
            int p = 0;
            while (p < classSec.SectionData.Length)
            {
                uint strOffset = (uint)p;
                if (p + 4 > classSec.SectionData.Length) break;
                // In Havok packfiles, classname entries typically start with 4-byte signature or 1 byte pad
                if (classSec.SectionData[p] == 0)
                {
                    p++;
                    continue;
                }
                // Skip 4-byte signature and 1-byte separator if present
                int nameStart = p;
                if (p + 5 < classSec.SectionData.Length && (classSec.SectionData[p + 4] == 0x09 || classSec.SectionData[p + 4] == 0x00))
                {
                    nameStart = p + 5;
                }
                int nullPos = Array.IndexOf(classSec.SectionData, (byte)0, nameStart);
                if (nullPos < 0) nullPos = classSec.SectionData.Length;
                int len = nullPos - nameStart;
                if (len > 0)
                {
                    string className = Encoding.ASCII.GetString(classSec.SectionData, nameStart, len);
                    classNamesByOffset[strOffset] = className;
                }
                p = nullPos + 1;
            }
        }

        return new HkxPackfile(header, classSec, typeSec, dataSec, classNamesByOffset);
    }

    public string? GetClassNameAtVirtualOffset(uint srcOffset)
    {
        if (DataSection.VirtualFixupMap.TryGetValue(srcOffset, out var nameOffset))
        {
            if (ClassNamesByOffset.TryGetValue(nameOffset, out var name))
                return name;
        }
        return null;
    }
}

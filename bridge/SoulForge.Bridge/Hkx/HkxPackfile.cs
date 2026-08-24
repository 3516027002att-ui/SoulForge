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

    private delegate bool FixupReader(ReadOnlySpan<byte> span, int index);

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

        if (header.Endian != 0)
            throw new NotSupportedException($"HKX endian mode {header.Endian} is not supported; only little-endian packfiles are authoritative.");
        if (header.PointerSize != 8)
            throw new NotSupportedException($"HKX pointer size {header.PointerSize} is not supported by the Sekiro reader; expected 8.");

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
            // Sekiro's DS3/Havok packfile section header is 0x40 bytes:
            // 20 bytes of tag/padding, seven offsets, and four reserved
            // uint32 values.  Advancing by 0x30 shifts every section after
            // the first and makes all fixups look valid but point elsewhere.
            if (curHeaderOffset < 0 || curHeaderOffset + 0x40 > bytes.Length)
                throw new InvalidDataException($"HKX truncated while reading section header {i}.");

            if (bytes[curHeaderOffset + 19] != 0xFF)
                throw new InvalidDataException($"HKX section {i} has an invalid section-header separator.");

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

            int absStart = ToIntOffset(sec.AbsoluteDataStart, $"section {i} data start");
            int dataSize = ToSectionOffset(sec.LocalFixupsOffset, sec.GlobalFixupsOffset,
                sec.VirtualFixupsOffset, sec.ExportsOffset, sec.EndOffset, $"section {i} data");
            RequireFileRange(bytes, absStart, dataSize, $"section {i} data");
            sec.SectionData = new byte[dataSize];
            Array.Copy(bytes, absStart, sec.SectionData, 0, dataSize);

            ReadLocalFixups(bytes, sec, absStart, sec.LocalFixupsOffset, sec.GlobalFixupsOffset);
            ReadGlobalFixups(bytes, sec, absStart, sec.GlobalFixupsOffset, sec.VirtualFixupsOffset);
            ReadVirtualFixups(bytes, sec, absStart, sec.VirtualFixupsOffset, sec.ExportsOffset);

            sections.Add(sec);
            curHeaderOffset += 0x40;
        }

        var classSec = sections[0];
        var typeSec = sections[1];
        var dataSec = sections[2];

        // Parse __classnames__ table
        var classNamesByOffset = new Dictionary<uint, string>();
        if (classSec.SectionData.Length > 0)
        {
            int p = 0;
            while (p + 5 <= classSec.SectionData.Length)
            {
                if (classSec.SectionData[p] == 0xFF)
                    break;
                int nameStart = p + 5;
                int nullPos = Array.IndexOf(classSec.SectionData, (byte)0, nameStart);
                if (nullPos < 0)
                    throw new InvalidDataException("HKX __classnames__ contains an unterminated class name.");
                if (classSec.SectionData[p + 4] != 0x09)
                    throw new InvalidDataException($"HKX __classnames__ entry at 0x{p:X} has an invalid separator.");
                classNamesByOffset[(uint)nameStart] = Encoding.ASCII.GetString(
                    classSec.SectionData, nameStart, nullPos - nameStart);
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

    private static int ToSectionOffset(
        uint local,
        uint global,
        uint virtualOffset,
        uint exports,
        uint end,
        string label)
    {
        uint[] candidates = { local, global, virtualOffset, exports, end };
        foreach (uint candidate in candidates)
        {
            if (candidate != 0xFFFFFFFF)
            {
                if (candidate > int.MaxValue)
                    throw new InvalidDataException($"HKX {label} offset {candidate} exceeds the supported range.");
                return (int)candidate;
            }
        }
        throw new InvalidDataException($"HKX {label} has no section-data boundary.");
    }

    private static int ToIntOffset(uint value, string label)
    {
        if (value > int.MaxValue)
            throw new InvalidDataException($"HKX {label} offset {value} exceeds the supported range.");
        return (int)value;
    }

    private static void RequireFileRange(byte[] bytes, int offset, int length, string label)
    {
        if (offset < 0 || length < 0 || (ulong)offset + (ulong)length > (ulong)bytes.Length)
            throw new InvalidDataException($"HKX {label} is outside the input file.");
    }

    private static void ReadLocalFixups(
        byte[] bytes,
        Section section,
        int absoluteStart,
        uint start,
        uint end)
    {
        ReadFixupRange(bytes, absoluteStart, start, end, 8, "local", (span, _) =>
        {
            uint src = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(0, 4));
            if (src == 0xFFFFFFFF) return false;
            uint dst = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(4, 4));
            section.LocalFixups.Add(new LocalFixup { Src = src, Dst = dst });
            section.LocalFixupMap[src] = dst;
            return true;
        });
    }

    private static void ReadGlobalFixups(
        byte[] bytes,
        Section section,
        int absoluteStart,
        uint start,
        uint end)
    {
        ReadFixupRange(bytes, absoluteStart, start, end, 12, "global", (span, _) =>
        {
            uint src = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(0, 4));
            if (src == 0xFFFFFFFF) return false;
            section.GlobalFixups.Add(new GlobalFixup
            {
                Src = src,
                DstSectionIndex = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(4, 4)),
                Dst = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(8, 4))
            });
            return true;
        });
    }

    private static void ReadVirtualFixups(
        byte[] bytes,
        Section section,
        int absoluteStart,
        uint start,
        uint end)
    {
        ReadFixupRange(bytes, absoluteStart, start, end, 12, "virtual", (span, _) =>
        {
            uint src = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(0, 4));
            if (src == 0xFFFFFFFF) return false;
            uint nameOffset = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(8, 4));
            section.VirtualFixups.Add(new VirtualFixup
            {
                Src = src,
                SectionIndex = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(4, 4)),
                NameOffset = nameOffset
            });
            section.VirtualFixupMap[src] = nameOffset;
            return true;
        });
    }

    private static void ReadFixupRange(
        byte[] bytes,
        int absoluteStart,
        uint start,
        uint end,
        int recordSize,
        string label,
        FixupReader readRecord)
    {
        if (start == 0xFFFFFFFF || end == 0xFFFFFFFF || end < start)
            return;
        uint length = end - start;
        if (length % (uint)recordSize != 0)
            throw new InvalidDataException($"HKX {label} fixup range has a partial record.");
        if (start > int.MaxValue || length > int.MaxValue)
            throw new InvalidDataException($"HKX {label} fixup range exceeds the supported address space.");
        int rangeStart = checked(absoluteStart + (int)start);
        RequireFileRange(bytes, rangeStart, (int)length, $"HKX {label} fixups");
        int count = (int)length / recordSize;
        for (int i = 0; i < count; i++)
        {
            var span = bytes.AsSpan(rangeStart + i * recordSize, recordSize);
            if (!readRecord(span, i))
                break;
        }
    }
}

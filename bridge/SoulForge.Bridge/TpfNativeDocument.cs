using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro-era TPF (Texture Package File) read-only native document.
/// Layout verified against c4510.tpf (16 textures, PC DX10 platform).
/// Each texture blob is a standalone DDS file.
/// </summary>
internal sealed class TpfNativeDocument
{
    private const uint Magic = 0x00465054; // "TPF\0"
    private const int HeaderSize = 0x10;
    private const int EntrySize = 20;
    private const int MaxTextureCount = 100_000;
    private const long MaxSourceBytes = 256L * 1024 * 1024;
    private const int DdsHeaderMinSize = 128; // "DDS " + 124-byte header

    private TpfNativeDocument(
        byte[] sourceBytes,
        uint dataLength,
        byte platform,
        byte encoding,
        byte flags,
        byte pad,
        IReadOnlyList<TpfTextureEntry> textures)
    {
        SourceBytes = sourceBytes;
        DataLength = dataLength;
        Platform = platform;
        EncodingByte = encoding;
        Flags = flags;
        Pad = pad;
        Textures = textures;
    }

    public byte[] SourceBytes { get; }
    public uint DataLength { get; }
    public byte Platform { get; }
    public byte EncodingByte { get; }
    public byte Flags { get; }
    public byte Pad { get; }
    public IReadOnlyList<TpfTextureEntry> Textures { get; }
    public string SourceHash => Hash(SourceBytes);

    public static TpfNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"TPF 大小 {source.Length} 超出安全范围。");

        var magic = ReadUInt32(source, 0);
        if (magic != Magic)
            throw new InvalidDataException($"TPF 魔数 0x{magic:X8} 不匹配；期望 0x{Magic:X8}。");

        var dataLength = ReadUInt32(source, 4);
        var textureCount = ReadUInt32(source, 8);
        var platform = source[0x0C];
        var encoding = source[0x0D];
        var flags = source[0x0E];
        var pad = source[0x0F];

        if (textureCount > MaxTextureCount)
            throw new InvalidDataException($"TPF 纹理数量 {textureCount} 超出安全上限 {MaxTextureCount}。");

        var entryTableEnd = checked(HeaderSize + (int)textureCount * EntrySize);
        if (entryTableEnd > source.Length)
            throw new InvalidDataException($"TPF 条目表越界：需要 {entryTableEnd} 字节，实际 {source.Length}。");

        var textures = new List<TpfTextureEntry>((int)textureCount);
        for (var i = 0; i < (int)textureCount; i++)
        {
            var o = HeaderSize + i * EntrySize;
            var dataOffset = ReadUInt32(source, o);
            var dataSize = ReadUInt32(source, o + 4);
            var format = source[o + 8];
            var unknown = source[o + 9];
            var mipCount = ReadUInt16(source, o + 10);
            var nameOffset = ReadUInt32(source, o + 12);
            var reserved = ReadUInt32(source, o + 16);

            // Validate data bounds
            if (dataOffset + (long)dataSize > source.Length)
                throw new InvalidDataException($"TPF 纹理 {i} 数据范围越界：offset={dataOffset}, size={dataSize}, fileSize={source.Length}。");

            // Validate name offset
            if (nameOffset >= source.Length)
                throw new InvalidDataException($"TPF 纹理 {i} 名称偏移 {nameOffset} 越界。");

            // Read UTF-16LE null-terminated name
            var name = ReadUtf16Z(source, (int)nameOffset);

            // Validate DDS blob
            uint width = 0, height = 0;
            string ddsFourCC = "";
            if (dataSize >= DdsHeaderMinSize)
            {
                var blobStart = (int)dataOffset;
                var ddsMagic = ReadUInt32(source, blobStart);
                if (ddsMagic != 0x20534444) // "DDS "
                    throw new InvalidDataException($"TPF 纹理 {i} DDS 魔数 0x{ddsMagic:X8} 不匹配；期望 0x20534444 (\"DDS \")。");
                height = ReadUInt32(source, blobStart + 12);
                width = ReadUInt32(source, blobStart + 16);
                ddsFourCC = ReadAscii(source, blobStart + 84, 4);
            }

            textures.Add(new TpfTextureEntry(
                i, name, format, unknown, mipCount,
                dataOffset, dataSize, nameOffset, reserved,
                width, height, ddsFourCC));
        }

        return new TpfNativeDocument(source, dataLength, platform, encoding, flags, pad, textures);
    }

    public static TpfNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("TPF 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"TPF 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    public TpfRoundTripReport VerifyRoundTrip()
    {
        var rebuilt = Rebuild();
        var reparsed = Read(rebuilt);
        var byteIdentical = SourceBytes.AsSpan().SequenceEqual(rebuilt);
        var semanticIdentical = reparsed.Textures.Count == Textures.Count
            && reparsed.DataLength == DataLength
            && reparsed.Platform == Platform
            && reparsed.EncodingByte == EncodingByte
            && reparsed.Flags == Flags
            && reparsed.Textures.Zip(Textures).All(pair =>
                pair.First.Name == pair.Second.Name
                && pair.First.Format == pair.Second.Format
                && pair.First.MipCount == pair.Second.MipCount
                && pair.First.DataOffset == pair.Second.DataOffset
                && pair.First.DataSize == pair.Second.DataSize
                && pair.First.Width == pair.Second.Width
                && pair.First.Height == pair.Second.Height
                && pair.First.DdsFourCC == pair.Second.DdsFourCC);
        return new TpfRoundTripReport(
            byteIdentical,
            semanticIdentical,
            SourceHash,
            Hash(rebuilt),
            Textures.Count);
    }

    /// <summary>
    /// Extract the raw DDS blob for a texture by index.
    /// </summary>
    public byte[] GetTextureData(int index)
    {
        if (index < 0 || index >= Textures.Count)
            throw new ArgumentOutOfRangeException(nameof(index), $"TPF 纹理索引 {index} 越界；有效范围 0..{Textures.Count - 1}。");
        var entry = Textures[index];
        return SourceBytes.AsSpan((int)entry.DataOffset, (int)entry.DataSize).ToArray();
    }

    public object ToEnvelope(TpfRoundTripReport? report = null) => new
    {
        format = "TPF",
        sourceSize = SourceBytes.Length,
        sourceHash = SourceHash,
        textureCount = Textures.Count,
        dataLength = DataLength,
        platform = Platform,
        encoding = EncodingByte,
        flags = Flags,
        textures = Textures.Select(t => new
        {
            index = t.Index,
            name = t.Name,
            format = FormatName(t.Format),
            formatByte = t.Format,
            mipCount = t.MipCount,
            dataOffset = t.DataOffset,
            dataSize = t.DataSize,
            width = t.Width,
            height = t.Height,
            ddsFourCC = t.DdsFourCC
        }).ToArray(),
        roundTrip = report ?? VerifyRoundTrip(),
        authority = "candidate"
    };

    private byte[] Rebuild()
    {
        var rebuilt = new byte[SourceBytes.Length];

        // Header
        WriteUInt32(rebuilt, 0, Magic);
        WriteUInt32(rebuilt, 4, DataLength);
        WriteUInt32(rebuilt, 8, (uint)Textures.Count);
        rebuilt[0x0C] = Platform;
        rebuilt[0x0D] = EncodingByte;
        rebuilt[0x0E] = Flags;
        rebuilt[0x0F] = Pad;

        // Entry table
        for (var i = 0; i < Textures.Count; i++)
        {
            var t = Textures[i];
            var o = HeaderSize + i * EntrySize;
            WriteUInt32(rebuilt, o, t.DataOffset);
            WriteUInt32(rebuilt, o + 4, t.DataSize);
            rebuilt[o + 8] = t.Format;
            rebuilt[o + 9] = t.Unknown;
            WriteUInt16(rebuilt, o + 10, t.MipCount);
            WriteUInt32(rebuilt, o + 12, t.NameOffset);
            WriteUInt32(rebuilt, o + 16, t.Reserved);
        }

        // Names — re-encode from parsed strings at their original offsets
        foreach (var t in Textures)
        {
            var nameBytes = Encoding.Unicode.GetBytes(t.Name + "\0");
            nameBytes.CopyTo(rebuilt, (int)t.NameOffset);
        }

        // Texture data blobs — copy from source
        foreach (var t in Textures)
        {
            SourceBytes.AsSpan((int)t.DataOffset, (int)t.DataSize)
                .CopyTo(rebuilt.AsSpan((int)t.DataOffset));
        }

        return rebuilt;
    }

    private static string FormatName(byte format) => format switch
    {
        0x00 => "BC1",
        0x01 => "BC1-alpha",
        0x67 => "BC4",
        0x6A => "BC5",
        0x6B => "BC5",
        _ => $"0x{format:X2}"
    };

    private static string ReadUtf16Z(byte[] source, int offset)
    {
        var end = offset;
        while (end + 1 < source.Length && !(source[end] == 0 && source[end + 1] == 0))
        {
            end += 2;
            if (end - offset > 1024 * 1024) throw new InvalidDataException("TPF 名称字符串未终止或过长。");
        }
        if (end + 1 >= source.Length) throw new InvalidDataException("TPF 名称字符串未以 UTF-16 空终止。");
        return Encoding.Unicode.GetString(source, offset, end - offset);
    }

    private static string ReadAscii(byte[] source, int offset, int length)
    {
        if (offset + length > source.Length) return "";
        return Encoding.ASCII.GetString(source, offset, length).TrimEnd('\0');
    }

    private static uint ReadUInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
    private static ushort ReadUInt16(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
    private static void WriteUInt32(byte[] target, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt16(byte[] target, int offset, ushort value) =>
        BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), value);
    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record TpfTextureEntry(
    int Index,
    string Name,
    byte Format,
    byte Unknown,
    ushort MipCount,
    uint DataOffset,
    uint DataSize,
    uint NameOffset,
    uint Reserved,
    uint Width,
    uint Height,
    string DdsFourCC);

internal sealed record TpfRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int TextureCount);

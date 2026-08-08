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

    public object ToEnvelope(TpfRoundTripReport? report = null)
    {
        // 全部纹理均含合法 DDS 头（解析时已校验 DDS 魔数；此处要求宽高>0）→ native-verified，否则 partial。
        var authority = Textures.Count > 0 && Textures.All(t =>
            t.DataSize >= DdsHeaderMinSize && t.Width > 0 && t.Height > 0)
            ? "native-verified"
            : "partial";
        return new
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
            // 覆盖面报告随 envelope 上报：无修改重建的无损性依赖「未覆盖区在源里
            // 全零」这个前提，不上报的话消费方只能看到一个 byteIdentical 布尔，
            // 无从判断 false 是因为丢了 padding 还是因为解析错了。
            rebuildCoverage = MeasureUncoveredBytes(),
            authority
        };
    }

    /// <summary>
    /// 无修改重建。**只回填四个区**：头部（0x00-0x0F）、条目表、名字区、纹理数据。
    /// 缓冲是 new byte[] 全零起始，所以源文件里这四区之外的字节（padding、对齐
    /// 间隙、未建模的尾部区域）会被写成 0。
    ///
    /// 这不是缺陷但是个**条件性无损**：只要源文件那些区本来就是全零，重建就逐字节
    /// 一致。ByteIdentical（VerifyRoundTrip :128）是真实重建比对，所以 padding 非零
    /// 时它会如实报 false——但报了 false 也说不清差异在哪。
    /// <see cref="MeasureUncoveredBytes"/> 把这件事变成可核对的数字。
    /// </summary>
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

    /// <summary>
    /// 统计 Rebuild() 未回填的字节区间，以及其中有多少在源文件里**非零**。
    ///
    /// 为什么需要它：Rebuild 的无损性依赖「未覆盖区在源里恰好全零」这个前提，
    /// 而此前没有任何地方核对过这个前提。2026-08-08 实测四个真实 texbnd 的 TPF，
    /// 未覆盖字节数分别是 108/54/144/126、**全部为零**——所以真实语料上无损。
    /// 但「实测恰好成立」与「被证明成立」是两件事：换一批语料、或将来有人改了
    /// 名字区布局，前提可能不再成立，而那时 ByteIdentical 只会报一个 false。
    ///
    /// 判据刻意分两个数：uncoveredBytes（覆盖面缺口有多大）与
    /// uncoveredNonZeroBytes（其中多少会真的丢信息）。只报后者的话，
    /// 「Rebuild 把整个文件都覆盖了」与「未覆盖区恰好全零」无法区分——前者是
    /// 更强的无损保证，后者是运气。
    /// </summary>
    public TpfCoverageReport MeasureUncoveredBytes()
    {
        var covered = new bool[SourceBytes.Length];

        void Mark(long start, long length)
        {
            if (start < 0 || length <= 0) return;
            var from = (int)Math.Min(start, SourceBytes.Length);
            var to = (int)Math.Min(start + length, SourceBytes.Length);
            for (var i = from; i < to; i++) covered[i] = true;
        }

        Mark(0, HeaderSize);
        for (var i = 0; i < Textures.Count; i++) Mark(HeaderSize + i * EntrySize, EntrySize);
        foreach (var t in Textures)
        {
            // 名字是 UTF-16LE + null 终止，与 Rebuild :227 的编码方式一致。
            Mark(t.NameOffset, Encoding.Unicode.GetBytes(t.Name + "\0").Length);
            Mark(t.DataOffset, t.DataSize);
        }

        var uncovered = 0;
        var uncoveredNonZero = 0;
        var firstNonZeroOffset = -1;
        for (var i = 0; i < covered.Length; i++)
        {
            if (covered[i]) continue;
            uncovered++;
            if (SourceBytes[i] == 0) continue;
            uncoveredNonZero++;
            if (firstNonZeroOffset < 0) firstNonZeroOffset = i;
        }

        return new TpfCoverageReport(uncovered, uncoveredNonZero, firstNonZeroOffset);
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

/// <summary>
/// Rebuild() 的覆盖面报告。<paramref name="UncoveredBytes"/> 是未回填的字节数，
/// <paramref name="UncoveredNonZeroBytes"/> 是其中在源文件里非零的字节数——
/// 后者大于 0 就意味着无修改重建会丢信息，ByteIdentical 必然为 false。
/// <paramref name="FirstNonZeroOffset"/> 给出第一处，便于定位而不必自己扫全文。
/// </summary>
internal sealed record TpfCoverageReport(
    int UncoveredBytes,
    int UncoveredNonZeroBytes,
    int FirstNonZeroOffset);

internal sealed record TpfRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int TextureCount);

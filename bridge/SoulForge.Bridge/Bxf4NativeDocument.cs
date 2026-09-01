using System.Buffers.Binary;
using System.Text;

/// <summary>
/// Sekiro BXF4 的只读索引视图。
///
/// BXF4 将 BND4 的文件头表放在 BHF4、子项字节放在 BDF4；这里不重建也不写盘，
/// 只读取经过边界校验的条目。地图材质包的子项本身是 DCX，所以读取到的仍是
/// 完整 DCX 字节，后续再走既有 DCX -> TPF -> DDS 读链。
/// </summary>
internal sealed class Bxf4NativeDocument
{
    private const int HeaderSize = 0x40;
    private const int FileHeaderSize = 0x24;
    private const int DataHeaderSize = 0x30;
    private const int MaxEntryCount = 100_000;
    private const long MaxHeaderBytes = 64L * 1024 * 1024;
    private const long MaxStoredEntryBytes = 256L * 1024 * 1024;

    private Bxf4NativeDocument(
        string headerPath,
        string dataPath,
        long dataLength,
        IReadOnlyList<Bxf4Entry> entries)
    {
        HeaderPath = headerPath;
        DataPath = dataPath;
        DataLength = dataLength;
        Entries = entries;
    }

    public string HeaderPath { get; }
    public string DataPath { get; }
    public long DataLength { get; }
    public IReadOnlyList<Bxf4Entry> Entries { get; }

    public static Bxf4NativeDocument Open(string headerPath, string dataPath)
    {
        var headerInfo = new FileInfo(headerPath);
        if (!headerInfo.Exists) throw new FileNotFoundException("BXF4 BHF4 头文件不存在。", headerPath);
        if (headerInfo.Length < HeaderSize || headerInfo.Length > MaxHeaderBytes)
            throw new InvalidDataException($"BXF4 BHF4 大小 {headerInfo.Length} 超出安全范围。");

        var dataInfo = new FileInfo(dataPath);
        if (!dataInfo.Exists) throw new FileNotFoundException("BXF4 BDF4 数据文件不存在。", dataPath);
        if (dataInfo.Length < DataHeaderSize)
            throw new InvalidDataException($"BXF4 BDF4 大小 {dataInfo.Length} 小于数据头。");

        var header = File.ReadAllBytes(headerPath);
        ValidateHeader(header);
        ValidateDataHeader(dataPath, dataInfo.Length);

        var fileCount = ReadInt32Le(header, 0x0C);
        var declaredHeaderSize = ReadInt64Le(header, 0x10);
        var declaredFileHeaderSize = ReadInt64Le(header, 0x20);
        var hashTableOffset = ReadInt64Le(header, 0x38);
        if (fileCount < 0 || fileCount > MaxEntryCount
            || declaredHeaderSize != HeaderSize
            || declaredFileHeaderSize != FileHeaderSize)
        {
            throw new InvalidDataException(
                $"不支持的 BXF4 BHF4 header：count={fileCount}, headerSize={declaredHeaderSize}, fileHeaderSize={declaredFileHeaderSize}。");
        }

        var tableEnd = checked((long)HeaderSize + (long)fileCount * FileHeaderSize);
        if (tableEnd > header.Length || hashTableOffset < tableEnd || hashTableOffset > header.Length)
            throw new InvalidDataException("BXF4 BHF4 文件头表或名称区越界。");

        var entries = new List<Bxf4Entry>(fileCount);
        var seenNames = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < fileCount; index++)
        {
            var offset = checked(HeaderSize + index * FileHeaderSize);
            var flags = ReadInt32Le(header, offset);
            var unknown = ReadInt32Le(header, offset + 4);
            var storedSize = ReadInt64Le(header, offset + 8);
            var uncompressedSize = ReadInt64Le(header, offset + 16);
            var dataOffset = ReadUInt32Le(header, offset + 24);
            var id = ReadInt32Le(header, offset + 28);
            var nameOffset = ReadUInt32Le(header, offset + 32);

            if (storedSize < 0 || uncompressedSize < 0 || storedSize > MaxStoredEntryBytes
                || dataOffset < DataHeaderSize
                || (long)dataOffset + storedSize > dataInfo.Length)
            {
                throw new InvalidDataException($"BXF4 第 {index} 个子项数据范围越界。");
            }
            if (uncompressedSize != storedSize)
                throw new NotSupportedException($"BXF4 第 {index} 个子项使用了额外压缩，当前只接受原始存储条目。");

            var name = ReadName(header, checked((int)nameOffset), checked((int)hashTableOffset));
            seenNames.TryGetValue(name, out var previousOrdinal);
            var duplicateOrdinal = seenNames.ContainsKey(name) ? previousOrdinal + 1 : 0;
            seenNames[name] = duplicateOrdinal;
            entries.Add(new Bxf4Entry(
                index,
                flags,
                unknown,
                id,
                name,
                duplicateOrdinal,
                checked((int)dataOffset),
                checked((int)storedSize),
                checked((int)uncompressedSize)));
        }

        return new Bxf4NativeDocument(headerPath, dataPath, dataInfo.Length, entries);
    }

    public Bxf4Entry? FindEntry(params string[] names)
    {
        foreach (var name in names)
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            var exact = Entries.FirstOrDefault(entry =>
                string.Equals(entry.Name, name, StringComparison.OrdinalIgnoreCase));
            if (exact is not null) return exact;
        }
        return null;
    }

    public byte[] ReadStoredBytes(Bxf4Entry entry)
    {
        if (entry.Index < 0 || entry.Index >= Entries.Count)
            throw new ArgumentOutOfRangeException(nameof(entry));
        if (!ReferenceEquals(entry, Entries[entry.Index])
            && !string.Equals(entry.Name, Entries[entry.Index].Name, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("BXF4 条目不属于当前文档。");

        var bytes = new byte[entry.StoredSize];
        using var stream = new FileStream(DataPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        stream.Seek(entry.DataOffset, SeekOrigin.Begin);
        stream.ReadExactly(bytes);
        return bytes;
    }

    private static void ValidateHeader(byte[] header)
    {
        if (!header.AsSpan(0, 4).SequenceEqual("BHF4"u8))
            throw new InvalidDataException("输入不是 BXF4 的 BHF4 头文件。");
    }

    private static void ValidateDataHeader(string dataPath, long dataLength)
    {
        using var stream = new FileStream(dataPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        Span<byte> prefix = stackalloc byte[0x20];
        stream.ReadExactly(prefix);
        if (!prefix[..4].SequenceEqual("BDF4"u8))
            throw new InvalidDataException("输入不是 BXF4 的 BDF4 数据文件。");
        var headerSize = BinaryPrimitives.ReadInt64LittleEndian(prefix[0x10..0x18]);
        if (headerSize != DataHeaderSize || dataLength < headerSize)
            throw new InvalidDataException($"BXF4 BDF4 数据头大小 {headerSize} 不受支持。");
    }

    private static string ReadName(byte[] source, int offset, int nameAreaEnd)
    {
        if (offset < 0 || offset >= nameAreaEnd || offset >= source.Length)
            throw new InvalidDataException("BXF4 名称偏移越界。");

        // Sekiro 的 BHF4 使用 UTF-16LE 名称。保留一个 UTF-8 fallback，供同一
        // 格式的非 Unicode 变体读取，但两种编码都要求在名称区内找到终止符。
        var isUtf16 = offset + 1 < nameAreaEnd && source[offset + 1] == 0;
        if (isUtf16)
        {
            var cursor = offset;
            while (cursor + 1 < nameAreaEnd)
            {
                if (source[cursor] == 0 && source[cursor + 1] == 0)
                    return Encoding.Unicode.GetString(source, offset, cursor - offset);
                cursor += 2;
            }
            throw new InvalidDataException("BXF4 UTF-16 名称缺少终止符。");
        }

        var end = offset;
        while (end < nameAreaEnd && source[end] != 0) end++;
        if (end >= nameAreaEnd) throw new InvalidDataException("BXF4 名称缺少终止符。");
        return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
            .GetString(source, offset, end - offset);
    }

    private static int ReadInt32Le(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static long ReadInt64Le(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));

    private static uint ReadUInt32Le(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
}

internal sealed record Bxf4Entry(
    int Index,
    int Flags,
    int Unknown,
    int Id,
    string Name,
    int DuplicateOrdinal,
    int DataOffset,
    int StoredSize,
    int UncompressedSize);

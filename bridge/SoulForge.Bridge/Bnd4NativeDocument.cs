using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

internal sealed class Bnd4NativeDocument
{
    private Bnd4NativeDocument(byte[] source, int dataOffset, int fileHeaderSize, IReadOnlyList<Bnd4Entry> entries, IReadOnlyList<byte[]> entryBytes)
    {
        SourceBytes = source;
        DataOffset = dataOffset;
        FileHeaderSize = fileHeaderSize;
        Entries = entries;
        EntryBytes = entryBytes;
    }

    public byte[] SourceBytes { get; }
    public int DataOffset { get; }
    public int FileHeaderSize { get; }
    public IReadOnlyList<Bnd4Entry> Entries { get; }
    private IReadOnlyList<byte[]> EntryBytes { get; }
    public string SourceHash => Hash(SourceBytes);

    public static Bnd4NativeDocument Read(byte[] source)
    {
        if (source.Length < 0x40 || !source.AsSpan(0, 4).SequenceEqual("BND4"u8))
            throw new InvalidDataException("输入不是 BND4 文档。");
        var fileCount = ReadInt32Le(source, 0x0C);
        var headerSize = ReadInt64Le(source, 0x10);
        var fileHeaderSize = ReadInt64Le(source, 0x20);
        var dataOffset = ReadInt64Le(source, 0x28);
        if (fileCount < 0 || fileCount > 1_000_000 || headerSize != 0x40 || fileHeaderSize != 0x24)
            throw new InvalidDataException($"不支持的 BND4 header：count={fileCount}, headerSize={headerSize}, fileHeaderSize={fileHeaderSize}。");
        if (dataOffset < headerSize || dataOffset > source.Length)
            throw new InvalidDataException("BND4 dataOffset 越界。");
        var tableEnd = checked((long)headerSize + (long)fileCount * fileHeaderSize);
        if (tableEnd > dataOffset || tableEnd > source.Length)
            throw new InvalidDataException("BND4 文件头表越界或与数据区重叠。");
        var entries = new List<Bnd4Entry>(fileCount);
        var entryBytes = new List<byte[]>(fileCount);
        var seenNames = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < fileCount; index++)
        {
            var offset = checked((int)(headerSize + index * fileHeaderSize));
            var flags = ReadInt32Le(source, offset);
            var unknown = ReadInt32Le(source, offset + 4);
            var compressedSize = ReadInt64Le(source, offset + 8);
            var uncompressedSize = ReadInt64Le(source, offset + 16);
            var entryDataOffset = ReadUInt32Le(source, offset + 24);
            var id = ReadInt32Le(source, offset + 28);
            var nameOffset = ReadUInt32Le(source, offset + 32);
            if (compressedSize < 0 || uncompressedSize < 0 || compressedSize > int.MaxValue
                || entryDataOffset > source.Length || entryDataOffset + compressedSize > source.Length)
                throw new InvalidDataException($"BND4 第 {index} 个子项范围越界。");
            var name = ReadNullTerminatedUtf8(source, checked((int)nameOffset));
            seenNames.TryGetValue(name, out var duplicateIndex);
            var duplicateOrdinal = seenNames.ContainsKey(name) ? duplicateIndex + 1 : 0;
            seenNames[name] = duplicateOrdinal;
            var bytes = source.AsSpan(checked((int)entryDataOffset), checked((int)compressedSize)).ToArray();
            entryBytes.Add(bytes);
            entries.Add(new Bnd4Entry(
                index, flags, unknown, id, name, duplicateOrdinal, checked((int)nameOffset),
                checked((int)entryDataOffset), checked((int)compressedSize), checked((int)uncompressedSize),
                Hash(bytes)));
        }
        return new Bnd4NativeDocument(source, checked((int)dataOffset), checked((int)fileHeaderSize), entries, entryBytes);
    }

    public Bnd4RoundTripReport VerifyRoundTrip()
    {
        var reparsed = Read(SourceBytes.ToArray());
        var entriesEqual = reparsed.Entries.Count == Entries.Count
            && reparsed.Entries.Zip(Entries).All(pair => pair.First == pair.Second);
        return new Bnd4RoundTripReport(
            true,
            entriesEqual,
            SourceHash,
            reparsed.SourceHash,
            Entries.Count,
            Entries.Count(entry => entry.DuplicateOrdinal > 0));
    }

    public byte[] ReplaceEntrySameSize(int index, byte[] replacement, string expectedHash)
    {
        if (index < 0 || index >= Entries.Count) throw new ArgumentOutOfRangeException(nameof(index));
        var entry = Entries[index];
        if (!entry.ContentHash.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("BND4 子项 expectedHash 不匹配。");
        if (replacement.Length != entry.CompressedSize || entry.CompressedSize != entry.UncompressedSize)
            throw new NotSupportedException("当前安全替换仅允许未压缩且长度不变的 BND4 子项；变长 repack 尚未启用。");
        var rebuilt = SourceBytes.ToArray();
        replacement.CopyTo(rebuilt.AsSpan(entry.DataOffset, entry.CompressedSize));
        return rebuilt;
    }

    public byte[] Repack(IReadOnlyList<Bnd4RepackEntry> nextEntries)
    {
        if (nextEntries.Count > 1_000_000) throw new InvalidDataException("BND4 子项数量超出安全上限。");
        var unicodeNames = Entries.Count == 0 || Entries.Any(entry => IsUtf16Name(entry.NameOffset));
        var nameBytes = new List<byte[]>();
        foreach (var entry in nextEntries)
        {
            if (entry.StoredBytes.Length < 0) throw new InvalidDataException("BND4 子项大小无效。");
            nameBytes.Add(EncodeName(entry.Name, unicodeNames));
        }
        var tableEnd = checked(0x40 + nextEntries.Count * 0x24);
        var namesLength = nameBytes.Sum(bytes => bytes.Length);
        var dataOffset = Align(checked(tableEnd + namesLength), 0x10);
        var totalData = nextEntries.Sum(entry => Align(entry.StoredBytes.Length, 0x10));
        var rebuilt = new byte[checked(dataOffset + totalData)];
        Buffer.BlockCopy(SourceBytes, 0, rebuilt, 0, Math.Min(0x40, SourceBytes.Length));
        WriteInt32Le(rebuilt, 0x0C, nextEntries.Count);
        WriteInt64Le(rebuilt, 0x10, 0x40);
        WriteInt64Le(rebuilt, 0x20, 0x24);
        WriteInt64Le(rebuilt, 0x28, dataOffset);
        var nameCursor = tableEnd;
        var dataCursor = dataOffset;
        for (var index = 0; index < nextEntries.Count; index++)
        {
            var entry = nextEntries[index];
            var header = 0x40 + index * 0x24;
            WriteInt32Le(rebuilt, header, entry.Flags);
            WriteInt32Le(rebuilt, header + 4, entry.Unknown);
            WriteInt64Le(rebuilt, header + 8, entry.StoredBytes.Length);
            WriteInt64Le(rebuilt, header + 16, entry.UncompressedSize ?? entry.StoredBytes.Length);
            WriteUInt32Le(rebuilt, header + 24, checked((uint)dataCursor));
            WriteInt32Le(rebuilt, header + 28, entry.Id);
            WriteUInt32Le(rebuilt, header + 32, checked((uint)nameCursor));
            nameBytes[index].CopyTo(rebuilt.AsSpan(nameCursor));
            entry.StoredBytes.CopyTo(rebuilt.AsSpan(dataCursor));
            nameCursor += nameBytes[index].Length;
            dataCursor += Align(entry.StoredBytes.Length, 0x10);
        }
        return rebuilt;
    }

    public IReadOnlyList<Bnd4RepackEntry> ToRepackEntries() => Entries.Select((entry, index) => new Bnd4RepackEntry(
        entry.Flags, entry.Unknown, entry.Id, entry.Name, EntryBytes[index].ToArray(), entry.UncompressedSize)).ToArray();

    public byte[] GetStoredBytes(int index)
    {
        if (index < 0 || index >= EntryBytes.Count) throw new ArgumentOutOfRangeException(nameof(index));
        return EntryBytes[index].ToArray();
    }

    public Bnd4CrudVerification VerifyCrud()
    {
        if (Entries.Count == 0) return new Bnd4CrudVerification(false, false, false, false, false, "BND4 没有可验证子项。");
        var source = ToRepackEntries().ToList();
        var first = source[0];
        var renamed = source.ToList();
        renamed[0] = first with { Name = first.Name + ".soulforge-test" };
        var renameOk = Read(Repack(renamed)).Entries[0].Name == renamed[0].Name;

        var moved = source.ToList();
        moved.RemoveAt(0); moved.Add(first);
        var movedDoc = Read(Repack(moved));
        var moveOk = movedDoc.Entries[^1].Id == first.Id && movedDoc.Entries.Count == source.Count;

        var deleted = source.Take(source.Count - 1).ToList();
        var deleteOk = Read(Repack(deleted)).Entries.Count == source.Count - 1;

        var added = source.ToList();
        added.Add(first with { Id = int.MaxValue, Name = first.Name, StoredBytes = "SoulForge-BND4-add"u8.ToArray(), UncompressedSize = 18 });
        var addedDoc = Read(Repack(added));
        var addOk = addedDoc.Entries.Count == source.Count + 1
            && addedDoc.Entries[^1].DuplicateOrdinal > 0;

        var replaced = source.ToList();
        var replacement = first.StoredBytes.Concat(new byte[] { 0x53, 0x46 }).ToArray();
        replaced[0] = first with { StoredBytes = replacement, UncompressedSize = replacement.Length };
        var replacedDoc = Read(Repack(replaced));
        var replaceOk = replacedDoc.Entries[0].ContentHash == Hash(replacement);
        return new Bnd4CrudVerification(renameOk, moveOk, deleteOk, addOk, replaceOk, null);
    }

    public object ToEnvelope() => new
    {
        format = "BND4",
        sourceSize = SourceBytes.Length,
        sourceHash = SourceHash,
        dataOffset = DataOffset,
        fileHeaderSize = FileHeaderSize,
        entryCount = Entries.Count,
        duplicateNameCount = Entries.Count(entry => entry.DuplicateOrdinal > 0),
        entries = Entries.Select(entry => new
        {
            entry.Index,
            entry.Flags,
            entry.Unknown,
            entry.Id,
            entry.Name,
            entry.DuplicateOrdinal,
            entry.NameOffset,
            entry.DataOffset,
            entry.CompressedSize,
            entry.UncompressedSize,
            entry.ContentHash
        }).ToArray(),
        roundTrip = VerifyRoundTrip(),
        crud = VerifyCrud(),
        authority = "candidate"
    };

    private static string ReadNullTerminatedUtf8(byte[] source, int offset)
    {
        if (offset < 0 || offset >= source.Length) throw new InvalidDataException("BND4 nameOffset 越界。");
        if (offset + 1 < source.Length && source[offset + 1] == 0)
        {
            var utf16End = offset;
            while (utf16End + 1 < source.Length && (source[utf16End] != 0 || source[utf16End + 1] != 0))
                utf16End += 2;
            if (utf16End + 1 >= source.Length || utf16End - offset > 8192)
                throw new InvalidDataException("BND4 UTF-16 子项名称未终止或过长。");
            return Encoding.Unicode.GetString(source, offset, utf16End - offset);
        }
        var end = offset;
        while (end < source.Length && source[end] != 0) end++;
        if (end == source.Length || end - offset > 4096) throw new InvalidDataException("BND4 子项名称未终止或过长。");
        return Encoding.UTF8.GetString(source, offset, end - offset);
    }
    private bool IsUtf16Name(int offset) => offset + 1 < SourceBytes.Length && SourceBytes[offset + 1] == 0;
    private static byte[] EncodeName(string value, bool unicode)
        => unicode ? Encoding.Unicode.GetBytes(value + "\0") : Encoding.UTF8.GetBytes(value + "\0");
    private static int Align(int value, int alignment) => checked((value + alignment - 1) / alignment * alignment);
    private static int ReadInt32Le(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static uint ReadUInt32Le(byte[] source, int offset) => BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
    private static long ReadInt64Le(byte[] source, int offset) => BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
    private static void WriteInt32Le(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt32Le(byte[] target, int offset, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteInt64Le(byte[] target, int offset, long value) => BinaryPrimitives.WriteInt64LittleEndian(target.AsSpan(offset, 8), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record Bnd4Entry(
    int Index,
    int Flags,
    int Unknown,
    int Id,
    string Name,
    int DuplicateOrdinal,
    int NameOffset,
    int DataOffset,
    int CompressedSize,
    int UncompressedSize,
    string ContentHash);

internal sealed record Bnd4RoundTripReport(
    bool ByteIdentical,
    bool EntriesIdentical,
    string SourceHash,
    string RebuiltHash,
    int EntryCount,
    int DuplicateNameCount);

internal sealed record Bnd4RepackEntry(
    int Flags,
    int Unknown,
    int Id,
    string Name,
    byte[] StoredBytes,
    int? UncompressedSize);

internal sealed record Bnd4CrudVerification(
    bool Rename,
    bool Move,
    bool Delete,
    bool Add,
    bool Replace,
    string? Note)
{
    public bool AllPassed => Rename && Move && Delete && Add && Replace;
}

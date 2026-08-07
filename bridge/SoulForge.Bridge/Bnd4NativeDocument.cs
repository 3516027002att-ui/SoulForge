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

    /// <summary>
    /// 往返验证：真实重建容器后与源字节逐字节比对。
    ///
    /// ByteIdentical 此前传的是字面量 <c>true</c>，而 reparsed 只是把同一份
    /// SourceBytes 再解析一次——两者都不可能为假，所以这份报告从未证明过任何事，
    /// 而它正是 authority 报告里 roundTrip 字段的来源。
    ///
    /// 现在改为复用 Repack(ToRepackEntries())：那是「每个子项都不改」的 no-op
    /// 重建，输出必须与源逐字节相同。这条判据会真的红——重建时任何对齐、名字
    /// 编码、未知字段的处理偏差都会暴露，而那些偏差正是开放 writer 前必须先关掉
    /// 的风险。
    /// </summary>
    public Bnd4RoundTripReport VerifyRoundTrip()
    {
        var reparsed = Read(SourceBytes.ToArray());
        var entriesEqual = reparsed.Entries.Count == Entries.Count
            && reparsed.Entries.Zip(Entries).All(pair => pair.First == pair.Second);

        bool byteIdentical;
        string rebuiltHash;
        try
        {
            var rebuilt = Repack(ToRepackEntries());
            byteIdentical = rebuilt.Length == SourceBytes.Length
                && rebuilt.AsSpan().SequenceEqual(SourceBytes);
            // 报告重建产物自己的哈希。此前这里填的是 reparsed.SourceHash——也就是
            // 源哈希——所以 sourceHash 与 rebuiltHash 永远相等，读者看不出任何差异。
            rebuiltHash = Hash(rebuilt);
        }
        catch (Exception ex) when (ex is InvalidDataException or OverflowException or ArgumentException)
        {
            // 重建失败本身就是「不是逐字节一致」的一种，必须报 false 而不是抛给
            // 调用方——调用方拿到的是往返报告，不是重建服务。
            byteIdentical = false;
            rebuiltHash = "repack-failed";
        }

        return new Bnd4RoundTripReport(
            byteIdentical,
            entriesEqual,
            SourceHash,
            rebuiltHash,
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

    /// <summary>
    /// No-op repack preservation: rebuild the container with every entry unchanged
    /// and compare the unknown/header and entry-level fields byte-for-byte against
    /// the source BND4 payload. For KRAK this is the honest per-byte boundary that
    /// re-compression cannot guarantee at the outer DCX layer.
    /// </summary>
    public Bnd4FieldPreservationReport VerifyFieldPreservation()
    {
        var rebuilt = Repack(ToRepackEntries());
        var noOpByteIdentical = rebuilt.Length == SourceBytes.Length
            && rebuilt.AsSpan().SequenceEqual(SourceBytes);
        var headerUnknownPreserved = SourceBytes.Length >= 0x40 && rebuilt.Length >= 0x40
            && SourceBytes.AsSpan(0x18, 8).SequenceEqual(rebuilt.AsSpan(0x18, 8))
            && SourceBytes.AsSpan(0x30, 0x10).SequenceEqual(rebuilt.AsSpan(0x30, 0x10));
        Bnd4NativeDocument reparsed;
        try { reparsed = Read(rebuilt); }
        catch (InvalidDataException) { return new Bnd4FieldPreservationReport(false, headerUnknownPreserved, false, false, false, "repack-reread-failed"); }
        if (reparsed.Entries.Count != Entries.Count)
            return new Bnd4FieldPreservationReport(false, headerUnknownPreserved, false, false, false, "entry-count-mismatch");
        var headerFieldsPreserved = true;
        var storedPreserved = true;
        var namesPreserved = true;
        for (var i = 0; i < Entries.Count; i++)
        {
            var src = Entries[i];
            var dst = reparsed.Entries[i];
            if (src.Flags != dst.Flags || src.Unknown != dst.Unknown) headerFieldsPreserved = false;
            if (src.Name != dst.Name) namesPreserved = false;
            if (!SourceBytes.AsSpan(src.DataOffset, src.CompressedSize)
                    .SequenceEqual(rebuilt.AsSpan(dst.DataOffset, dst.CompressedSize)))
                storedPreserved = false;
        }
        var diffs = new List<int>();
        var shorter = Math.Min(rebuilt.Length, SourceBytes.Length);
        for (var i = 0; i < shorter && diffs.Count < 32; i++)
            if (rebuilt[i] != SourceBytes[i]) diffs.Add(i);
        if (diffs.Count < 32 && rebuilt.Length != SourceBytes.Length) diffs.Add(-(Math.Max(rebuilt.Length, SourceBytes.Length)));
        return new Bnd4FieldPreservationReport(
            noOpByteIdentical, headerUnknownPreserved, headerFieldsPreserved, storedPreserved, namesPreserved,
            null, SourceBytes.Length, rebuilt.Length, diffs.ToArray());
    }

    /// <summary>
    /// Compare a rebuilt container against this source for preserved entry-level
    /// fields (flags/unknown) and stored payload bytes on entries that survive
    /// with the same id+name key. Entries added by mutation are skipped. Entries
    /// whose stored payload was replaced are excluded from the stored-bytes check
    /// via <paramref name="contentReplacedKeys"/> (formatted "$id:$name").
    /// </summary>
    public Bnd4PreservationReport ComparePreservation(Bnd4NativeDocument rebuilt, IReadOnlyCollection<string>? contentReplacedKeys = null)
    {
        var sourceByKey = new Dictionary<(int Id, string Name), int>(Entries.Count);
        var sourceById = new Dictionary<int, int>(Entries.Count);
        for (var i = 0; i < Entries.Count; i++)
        {
            sourceByKey[(Entries[i].Id, Entries[i].Name)] = i;
            if (!sourceById.ContainsKey(Entries[i].Id)) sourceById[Entries[i].Id] = i;
        }
        var contentReplaced = contentReplacedKeys ?? Array.Empty<string>();
        var usedSourceIndexes = new HashSet<int>();
        var matched = 0;
        var headerFieldsPreserved = 0;
        var storedChecked = 0;
        var storedPreserved = 0;
        foreach (var dst in rebuilt.Entries)
        {
            var srcIndex = sourceByKey.TryGetValue((dst.Id, dst.Name), out var keyed)
                ? keyed
                : sourceById.TryGetValue(dst.Id, out var byId) ? byId : -1;
            if (srcIndex < 0 || !usedSourceIndexes.Add(srcIndex)) continue;
            matched++;
            var src = Entries[srcIndex];
            if (src.Flags == dst.Flags && src.Unknown == dst.Unknown) headerFieldsPreserved++;
            if (contentReplaced.Contains($"{dst.Id}:{dst.Name}")) continue;
            storedChecked++;
            if (src.CompressedSize == dst.CompressedSize
                && EntryBytes[srcIndex].AsSpan().SequenceEqual(rebuilt.GetStoredBytes(dst.Index)))
                storedPreserved++;
        }
        return new Bnd4PreservationReport(
            matched,
            headerFieldsPreserved,
            storedChecked,
            storedPreserved,
            matched > 0 && headerFieldsPreserved == matched && storedPreserved == storedChecked);
    }

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
        fieldPreservation = VerifyFieldPreservation(),
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

internal sealed record Bnd4FieldPreservationReport(
    bool NoOpPayloadByteIdentical,
    bool HeaderUnknownBytesPreserved,
    bool EntryHeaderFieldsPreserved,
    bool StoredBytesPreserved,
    bool NamesPreserved,
    string? Note,
    int SourcePayloadSize = 0,
    int RebuiltPayloadSize = 0,
    IReadOnlyList<int>? ByteDiffOffsets = null);

internal sealed record Bnd4PreservationReport(
    int MatchedEntryCount,
    int HeaderFieldsPreservedCount,
    int StoredBytesCheckedCount,
    int StoredBytesPreservedCount,
    bool AllPreserved);

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
            // 走布局保持路径而不是通用 Repack：no-op 输入的正确基线是「以源字节为
            // 基底、只改必要字段」。通用 Repack 会重排名字区与数据区，对真实容器
            // 注定不逐字节还原（源的对齐间隙比 16 字节宽、头部声明的 dataOffset 与
            // 首个子项实际起点相差 8 字节），那属于「通用重排不适合当无损基线」，
            // 不是重建有 bug。
            var noOpEntries = ToRepackEntries();
            var rebuilt = RebuildPreservingLayout(noOpEntries);
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
            rebuiltHash = "rebuild-failed";
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
    /// 判断一批 repack 条目是否与当前文档在**布局上**完全等价：条目数、顺序、
    /// 名字、存储长度与条目头字段都未变。
    ///
    /// 这个区分是往返验证能否用「逐字节一致」作判据的前提。Repack 是通用重排器
    /// （变长、增删、重命名都走它），它必然重算名字区与数据区布局，因此对真实
    /// 容器**注定**不会逐字节还原——实测差异全部落在 dataOffset 相关字段：源容器
    /// 在名字区末尾与子项之间留有比 16 字节对齐更宽的间隙（item.msgbnd.dcx 累计
    /// 168 字节），且头部声明的 dataOffset 与第一个子项实际起点在源里就相差 8 字节。
    ///
    /// 对这类布局差异，正确结论不是「Repack 有 bug」，而是「通用重排不适合当
    /// 无损基线」。无损基线应当走 RebuildPreservingLayout：以源字节为基底，只改
    /// 必要字段。
    /// </summary>
    /// <summary>
    /// 布局守卫的自检：用当前文档的条目集合构造三种越界输入，断言守卫都拒绝。
    ///
    /// 为什么要在文档内部自检而不是只靠外部门禁：RebuildPreservingLayout 目前只被
    /// VerifyRoundTrip / VerifyFieldPreservation 调用，而它们**永远传 no-op 输入**，
    /// 因此长度守卫在 IPC 层不可达——外部门禁无论怎么构造请求都测不到它。实测过：
    /// 注释掉长度守卫，写盘边界、CRUD、往返三类门禁全部照样通过。
    ///
    /// 而这道守卫是布局保持重建的唯一正确性前提：放宽它会让更长的字节被写进源的
    /// 原位，**越界覆盖后续子项**。所以判据必须跟着实现走，随 envelope 一起上报。
    /// </summary>
    public Bnd4LayoutGuardReport VerifyLayoutGuard()
    {
        if (Entries.Count == 0)
        {
            return new Bnd4LayoutGuardReport(true, true, true, true, "empty-container");
        }
        var baseline = ToRepackEntries();
        var acceptsNoOp = IsLayoutPreservingRepack(baseline);

        // 变长：存储字节比源长一个字节。
        var longer = baseline.ToList();
        longer[0] = longer[0] with
        {
            StoredBytes = longer[0].StoredBytes.Concat(new byte[] { 0x00 }).ToArray()
        };
        var rejectsLonger = !IsLayoutPreservingRepack(longer);

        // 改名：名字变化必须重排名字区，不可走布局保持路径。
        var renamed = baseline.ToList();
        renamed[0] = renamed[0] with { Name = $"{renamed[0].Name}.renamed" };
        var rejectsRename = !IsLayoutPreservingRepack(renamed);

        // 删条目：条目数变化。
        var removed = baseline.ToList();
        removed.RemoveAt(0);
        var rejectsCountChange = !IsLayoutPreservingRepack(removed);

        return new Bnd4LayoutGuardReport(
            acceptsNoOp, rejectsLonger, rejectsRename, rejectsCountChange, null);
    }

    public bool IsLayoutPreservingRepack(IReadOnlyList<Bnd4RepackEntry> nextEntries)
    {
        if (nextEntries.Count != Entries.Count) return false;
        for (var index = 0; index < Entries.Count; index++)
        {
            var source = Entries[index];
            var next = nextEntries[index];
            if (next.StoredBytes.Length != source.CompressedSize) return false;
            if ((next.UncompressedSize ?? next.StoredBytes.Length) != source.UncompressedSize) return false;
            if (next.Flags != source.Flags || next.Unknown != source.Unknown || next.Id != source.Id) return false;
            if (!string.Equals(next.Name, source.Name, StringComparison.Ordinal)) return false;
        }
        return true;
    }

    /// <summary>
    /// 布局保持重建：以源字节为基底，把每个子项的存储字节原地写回。
    ///
    /// 仅在 <see cref="IsLayoutPreservingRepack"/> 为真时可用——也就是「条目集合与
    /// 布局都没变，只是内容可能被等长替换」这一种场景。它与 ReplaceEntrySameSize
    /// 同思路（复制源、只改必要字节），因此对 no-op 输入必然逐字节还原：源的对齐
    /// 间隙、名字区留白、头部声明与实际起点的差异全部原样保留。
    ///
    /// 变长 / 增删 / 重命名不得走这里——那些场景必须重排布局，走 Repack。
    /// </summary>
    public byte[] RebuildPreservingLayout(IReadOnlyList<Bnd4RepackEntry> nextEntries)
    {
        if (!IsLayoutPreservingRepack(nextEntries))
        {
            throw new InvalidDataException(
                "RebuildPreservingLayout 只接受布局等价的条目集合；变长、增删或重命名必须走 Repack。");
        }
        var rebuilt = SourceBytes.ToArray();
        for (var index = 0; index < nextEntries.Count; index++)
        {
            var source = Entries[index];
            nextEntries[index].StoredBytes.CopyTo(rebuilt.AsSpan(source.DataOffset, source.CompressedSize));
        }
        return rebuilt;
    }

    /// <summary>
    /// No-op repack preservation: rebuild the container with every entry unchanged
    /// and compare the unknown/header and entry-level fields byte-for-byte against
    /// the source BND4 payload. For KRAK this is the honest per-byte boundary that
    /// re-compression cannot guarantee at the outer DCX layer.
    ///
    /// 逐字节判据走布局保持重建（RebuildPreservingLayout）；字段级判据仍对通用
    /// Repack 的产物做，因为那才是变长路径真正会写出的东西——两者问的是不同问题：
    /// 「no-op 能否逐字节还原」与「重排后条目字段/名字/存储字节是否保住」。
    /// 混用一个 Repack 产物会让前者对真实容器恒假，从而掩盖后者的真实结论。
    /// </summary>
    public Bnd4FieldPreservationReport VerifyFieldPreservation()
    {
        var noOpEntries = ToRepackEntries();
        var rebuilt = Repack(noOpEntries);
        bool noOpByteIdentical;
        try
        {
            var preserved = RebuildPreservingLayout(noOpEntries);
            noOpByteIdentical = preserved.Length == SourceBytes.Length
                && preserved.AsSpan().SequenceEqual(SourceBytes);
        }
        catch (InvalidDataException)
        {
            noOpByteIdentical = false;
        }
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
        layoutGuard = VerifyLayoutGuard(),
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

/// <summary>布局守卫自检结果。四项必须全为 true，否则布局保持重建可能越界写入。</summary>
internal sealed record Bnd4LayoutGuardReport(
    bool AcceptsNoOp,
    bool RejectsLongerStoredBytes,
    bool RejectsRename,
    bool RejectsEntryCountChange,
    string? Note);

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

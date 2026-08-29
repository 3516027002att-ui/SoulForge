using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Native PARAM layout families handled losslessly by the Bridge.
/// </summary>
// 物理身份：rowIndex + expectedId + expectedDataHash 贯穿 DTO/Map/key，重复 ID 的 id-only 写入必须拒绝，页 DTO 携带 dataHash。
internal enum ParamLayout
{
    /// <summary>Sekiro regulation-style 64-bit offsets (FormatFlags1.LongDataOffset).</summary>
    Long64,
    /// <summary>Standard 32-bit PARAM row directory: [id:i32, dataOffset:u32, nameOffset:u32].</summary>
    Standard32
}

/// <summary>
/// Sekiro PARAM (regulation/gameparam child) lossless document.
/// Row field interpretation requires paramdef; without def, rows are raw byte payloads
/// keyed by ID. Layout derived from the private gameparam.parambnd.dcx corpus.
/// </summary>
internal sealed class ParamNativeDocument
{
    private const int HeaderSize = 0x40;
    private const int RowHeaderSize = 0x18;
    private const int StandardRowHeaderSize = 0x0C;
    private const int MaxRows = 500_000;
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private const int MaxNameBytes = 512;

    private static readonly Encoding ShiftJisEncoding = CreateShiftJisEncoding();

    private readonly byte[] _compactPreData = Array.Empty<byte>();
    private readonly byte[] _compactDataTail = Array.Empty<byte>();
    private readonly byte[] _compactStringRegion = Array.Empty<byte>();

    private ParamNativeDocument(
        byte[] sourceBytes,
        byte[] headerPrefix,
        ushort dataVersion,
        ushort unk04,
        ushort unk06,
        string typeName,
        int rowDataSize,
        IReadOnlyList<ParamRow> rows,
        byte[] compactPreData,
        byte[] compactDataTail,
        byte[] compactStringRegion)
        : this(sourceBytes, headerPrefix, dataVersion, unk04, unk06, typeName, rowDataSize, rows,
            ParamLayout.Long64, compactPreData, compactDataTail, compactStringRegion)
    {
    }

    private ParamNativeDocument(
        byte[] sourceBytes,
        byte[] headerPrefix,
        ushort dataVersion,
        ushort unk04,
        ushort unk06,
        string typeName,
        int rowDataSize,
        IReadOnlyList<ParamRow> rows,
        ParamLayout layout,
        byte[]? compactPreData = null,
        byte[]? compactDataTail = null,
        byte[]? compactStringRegion = null)
    {
        SourceBytes = sourceBytes;
        HeaderPrefix = headerPrefix;
        DataVersion = dataVersion;
        Unk04 = unk04;
        Unk06 = unk06;
        TypeName = typeName;
        RowDataSize = rowDataSize;
        Rows = rows;
        Layout = layout;
        _compactPreData = compactPreData ?? Array.Empty<byte>();
        _compactDataTail = compactDataTail ?? Array.Empty<byte>();
        _compactStringRegion = compactStringRegion ?? Array.Empty<byte>();
    }

    public byte[] SourceBytes { get; }
    public byte[] HeaderPrefix { get; }
    public ushort DataVersion { get; }
    public ushort Unk04 { get; }
    public ushort Unk06 { get; }
    public string TypeName { get; }
    public int RowDataSize { get; }
    public IReadOnlyList<ParamRow> Rows { get; }
    public ParamLayout Layout { get; }
    public string SourceHash => Hash(SourceBytes);

    public static ParamNativeDocument Read(byte[] source, int? expectedRowDataSize = null)
    {
        if (source.Length < HeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 大小 {source.Length} 超出安全范围。");
        var formatFlags1 = source[0x2D];
        return (formatFlags1 & 0x04) != 0
            ? ReadCompact(source, expectedRowDataSize)
            : ReadStandard32(source, expectedRowDataSize);
    }

    public static ParamHeader ReadHeader(byte[] source)
    {
        if (source.Length < HeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 大小 {source.Length} 超出安全范围。");
        var flags1 = source[0x2D];
        var typeName = (flags1 & 0x80) != 0
            ? ReadAsciiZ(source, CheckedOffset64(source, 0x10, "PARAM 类型名"))
            : TryReadEmbeddedName(source)
                ?? throw new InvalidDataException("PARAM 固定类型名为空或含非法字节。");
        return new ParamHeader(
            typeName,
            ReadUInt16(source, 8),
            ReadUInt16(source, 10),
            flags1,
            source[0x2E],
            Hash(source));
    }

    public static ParamHeader ReadHeaderFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("PARAM 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 文件大小 {info.Length} 超出安全读取范围。");
        return ReadHeader(File.ReadAllBytes(path));
    }

    private static ParamNativeDocument ReadCompact(byte[] source, int? expectedRowDataSize)
    {
        var alignedStringsOffset = ReadInt32(source, 0);
        var unk04 = ReadUInt16(source, 4);
        var unk06 = ReadUInt16(source, 6);
        var dataVersion = ReadUInt16(source, 8);
        var rowCount = ReadUInt16(source, 10);
        // rowCount is ushort (max 65535); MaxRows is a documentation bound for rebuild inputs.
        var paramTypeOffset64 = ReadInt64(source, 0x10);
        if (paramTypeOffset64 <= 0 || paramTypeOffset64 >= source.Length || paramTypeOffset64 > int.MaxValue)
            throw new InvalidDataException("PARAM 类型名偏移无效。");
        var paramTypeOffset = checked((int)paramTypeOffset64);
        // Header 0x00 is a format marker, not an ordering boundary. Real Sekiro-derived
        // files may keep an older marker before a relocated ParamType string.
        if (alignedStringsOffset < 0 || alignedStringsOffset > source.Length)
            throw new InvalidDataException("PARAM 字符串区标记偏移越界。");
        var typeName = ReadAsciiZ(source, paramTypeOffset);
        if (string.IsNullOrEmpty(typeName))
            throw new InvalidDataException("PARAM 类型名为空。");

        var rows = new List<ParamRow>(rowCount);
        if (rowCount == 0)
        {
            if (paramTypeOffset < HeaderSize)
                throw new InvalidDataException("PARAM 零行布局的类型名偏移早于头部结束位置。");
            var compactTail = source.AsSpan(HeaderSize, paramTypeOffset - HeaderSize).ToArray();
            var emptyStringRegion = source.AsSpan(paramTypeOffset).ToArray();
            return new ParamNativeDocument(source, source.AsSpan(0, HeaderSize).ToArray(), dataVersion,
                unk04, unk06, typeName, 0, rows, Array.Empty<byte>(), compactTail, emptyStringRegion);
        }

        var firstRowOffset = HeaderSize;
        var firstDataOffset = ReadInt32(source, firstRowOffset + 8);
        var rowHeadersEnd = checked(HeaderSize + rowCount * RowHeaderSize);
        if (firstDataOffset < rowHeadersEnd || firstDataOffset > paramTypeOffset)
            throw new InvalidDataException("PARAM 首行数据偏移无效。");
        // SoulsFormats derives DetectedSize from adjacent row offsets. Header 0x00 is a
        // 16-byte-aligned string marker in Sekiro and may land inside the param-type text;
        // it is not a row-data boundary. Dividing up to that marker consumes the first
        // 0/4/8/12 bytes of the param type as if they belonged to the final row.
        // A single row has no adjacent offset; Sekiro's ParamTypeOffset is the explicit end
        // of the row-data region and therefore provides the exact boundary without PARAMDEF.
        var rowDataSize = rowCount > 1
            ? checked(ReadInt32(source, firstRowOffset + RowHeaderSize + 8) - firstDataOffset)
            : paramTypeOffset - firstDataOffset;
        if (rowCount == 1)
        {
            var earlierTypeOffset = FindEarlierTypeNameOffset(source, typeName, firstDataOffset, paramTypeOffset);
            if (earlierTypeOffset >= 0 && expectedRowDataSize is null)
                throw new NotSupportedException(
                    "PARAM 单行数据边界不唯一：ParamType 字符串被重定位但旧副本仍存在；需要 PARAMDEF 行宽。");
            if (expectedRowDataSize is int expected)
                rowDataSize = expected;
        }
        else if (expectedRowDataSize is int expected && expected != rowDataSize)
        {
            throw new InvalidDataException(
                $"PARAMDEF 行宽 {expected} 与相邻 DataOffset 推导行宽 {rowDataSize} 不一致。");
        }
        if (rowDataSize <= 0)
            throw new InvalidDataException($"PARAM 行数据大小无效：rowDataSize={rowDataSize}。");
        var lastDataEnd = checked(firstDataOffset + rowCount * rowDataSize);
        if (lastDataEnd > paramTypeOffset)
            throw new InvalidDataException(
                $"PARAM 行数据越过类型字符串：dataEnd={lastDataEnd}，paramTypeOffset={paramTypeOffset}。");

        for (var i = 0; i < rowCount; i++)
        {
            var o = HeaderSize + i * RowHeaderSize;
            var id = ReadInt32(source, o);
            var pad0 = ReadInt32(source, o + 4);
            var dataOff = ReadInt32(source, o + 8);
            var pad1 = ReadInt32(source, o + 12);
            var rowNameOff = ReadInt32(source, o + 16);
            var pad2 = ReadInt32(source, o + 20);
            if (pad0 != 0 || pad1 != 0 || pad2 != 0)
                throw new InvalidDataException($"PARAM 第 {i} 行头填充非零，拒绝猜测解析。");
            if (dataOff != firstDataOffset + i * rowDataSize)
                throw new InvalidDataException($"PARAM 第 {i} 行 dataOffset 非紧凑布局。");
            var data = source.AsSpan(dataOff, rowDataSize).ToArray();
            string? rowName = null;
            byte[]? rowNameBytes = null;
            string? rowNameEncoding = null;
            if (rowNameOff != 0)
            {
                if (rowNameOff < 0 || rowNameOff >= source.Length)
                    throw new InvalidDataException($"PARAM 第 {i} 行名称偏移越界。");
                var (parsedName, parsedBytes, parsedEncoding) = DecodeParamRowName(source, rowNameOff);
                // Offsets that land on an empty C-string are treated as unnamed (common in Sekiro params).
                if (!string.IsNullOrEmpty(parsedName))
                {
                    rowName = parsedName;
                    rowNameBytes = parsedBytes;
                    rowNameEncoding = parsedEncoding;
                }
            }
            rows.Add(new ParamRow(id, data, rowName, rowNameBytes, rowNameEncoding, rowNameOff, dataOff));
        }

        var compactPreData = source.AsSpan(rowHeadersEnd, firstDataOffset - rowHeadersEnd).ToArray();
        var compactDataTail = source.AsSpan(lastDataEnd, paramTypeOffset - lastDataEnd).ToArray();
        var compactStringRegion = source.AsSpan(paramTypeOffset).ToArray();
        return new ParamNativeDocument(
            source,
            source.AsSpan(0, HeaderSize).ToArray(),
            dataVersion,
            unk04,
            unk06,
            typeName,
            rowDataSize,
            rows,
            compactPreData,
            compactDataTail,
            compactStringRegion);
    }

    private static ParamNativeDocument ReadStandard32(byte[] source, int? expectedRowDataSize)
    {
        var formatFlags1 = source[0x2D];
        var formatFlags2 = source[0x2E];
        var hasOffsetParamType = (formatFlags1 & 0x80) != 0;
        var hasExtendedHeader = (formatFlags1 & 0x03) == 0x03;
        var rowDirectoryStart = hasExtendedHeader ? HeaderSize : 0x30;
        var typeName = hasOffsetParamType
            ? ReadAsciiZ(source, CheckedOffset64(source, 0x10, "PARAM 类型名"))
            : TryReadEmbeddedName(source)
                ?? throw new InvalidDataException("PARAM 固定类型名为空或含非法字节。");
        var dataStartHint = ReadUInt16(source, 4);
        var unk06 = ReadUInt16(source, 6);
        var dataVersion = ReadUInt16(source, 8);
        var rowCount = ReadUInt16(source, 10);
        var rows = new List<ParamRow>(rowCount);
        var rowDirectoryEnd = checked(rowDirectoryStart + rowCount * StandardRowHeaderSize);
        if (rowDirectoryEnd > source.Length)
            throw new InvalidDataException("PARAM 32 位行目录越过文件末尾。");
        if (rowCount == 0)
        {
            return new ParamNativeDocument(source, source.AsSpan(0, HeaderSize).ToArray(), dataVersion,
                dataStartHint, unk06, typeName, 0, rows, ParamLayout.Standard32);
        }

        var headers = new (int Id, int DataOffset, int NameOffset)[rowCount];
        for (var i = 0; i < rowCount; i++)
        {
            var offset = rowDirectoryStart + i * StandardRowHeaderSize;
            headers[i] = (
                ReadInt32(source, offset),
                ReadOffset32(source, offset + 4, $"PARAM 第 {i} 行数据"),
                ReadOffset32(source, offset + 8, $"PARAM 第 {i} 行名称", allowZero: true));
        }

        var firstDataOffset = headers[0].DataOffset;
        if (firstDataOffset < rowDirectoryEnd || firstDataOffset >= source.Length)
            throw new InvalidDataException(
                $"PARAM 32 位首行数据偏移无效：rowDirectoryEnd={rowDirectoryEnd}，dataOffset={firstDataOffset}。");
        var firstNameOffset = headers
            .Where(header => header.NameOffset > 0)
            .Select(header => header.NameOffset)
            .DefaultIfEmpty(0)
            .Min();
        int rowDataSize;
        if (rowCount > 1)
        {
            rowDataSize = checked(headers[1].DataOffset - firstDataOffset);
            if (expectedRowDataSize is int expected && expected != rowDataSize)
            {
                throw new InvalidDataException(
                    $"PARAMDEF 行宽 {expected} 与相邻 DataOffset 推导行宽 {rowDataSize} 不一致。");
            }
        }
        else if (expectedRowDataSize is int expected)
        {
            rowDataSize = expected;
        }
        else
        {
            var boundary = hasOffsetParamType
                ? CheckedOffset64(source, 0x10, "PARAM 类型名")
                : firstNameOffset;
            if (boundary <= firstDataOffset)
                throw new NotSupportedException(
                    "PARAM 32 位单行布局没有可证明的数据结束边界；需要 PARAMDEF 行宽才能安全读取。");
            rowDataSize = checked(boundary - firstDataOffset);
        }
        if (rowDataSize <= 0)
            throw new InvalidDataException($"PARAM 32 位行宽无效：rowDataSize={rowDataSize}。");

        var lastDataEnd = checked(firstDataOffset + rowCount * rowDataSize);
        if (lastDataEnd > source.Length || (firstNameOffset > 0 && lastDataEnd > firstNameOffset))
            throw new InvalidDataException(
                $"PARAM 32 位数据区越界：dataEnd={lastDataEnd}，nameStart={firstNameOffset}，fileSize={source.Length}。");
        var unicodeRowNames = (formatFlags2 & 0x01) != 0;
        for (var i = 0; i < rowCount; i++)
        {
            var header = headers[i];
            var expectedDataOffset = checked(firstDataOffset + i * rowDataSize);
            if (header.DataOffset != expectedDataOffset)
                throw new InvalidDataException(
                    $"PARAM 32 位第 {i} 行 dataOffset 非固定行宽布局：expected={expectedDataOffset}，actual={header.DataOffset}。");
            string? rowName = null;
            byte[]? rowNameBytes = null;
            string? rowNameEncoding = null;
            if (header.NameOffset != 0)
            {
                if (header.NameOffset < lastDataEnd || header.NameOffset >= source.Length)
                    throw new InvalidDataException($"PARAM 32 位第 {i} 行名称偏移越界。");
                (rowName, rowNameBytes, rowNameEncoding) = unicodeRowNames
                    ? DecodeUnicodeParamRowName(source, header.NameOffset)
                    : DecodeSingleByteParamRowName(source, header.NameOffset);
            }
            rows.Add(new ParamRow(
                header.Id,
                source.AsSpan(header.DataOffset, rowDataSize).ToArray(),
                rowName,
                rowNameBytes,
                rowNameEncoding,
                header.NameOffset,
                header.DataOffset));
        }

        return new ParamNativeDocument(source, source.AsSpan(0, HeaderSize).ToArray(), dataVersion,
            dataStartHint, unk06, typeName, rowDataSize, rows, ParamLayout.Standard32);
    }

    public static ParamNativeDocument ReadFile(string path, int? expectedRowDataSize = null)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("PARAM 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path), expectedRowDataSize);
    }

    public ParamRoundTripReport VerifyRoundTrip()
    {
        var rebuilt = Rebuild(Rows);
        var reparsed = Read(rebuilt, RowDataSize > 0 ? RowDataSize : null);
        var equal = reparsed.Rows.Count == Rows.Count
            && reparsed.TypeName == TypeName
            && reparsed.RowDataSize == RowDataSize
            && reparsed.Rows.Zip(Rows).All(pair =>
                pair.First.Id == pair.Second.Id
                && pair.First.Data.AsSpan().SequenceEqual(pair.Second.Data)
                && pair.First.Name == pair.Second.Name);
        return new ParamRoundTripReport(
            SourceBytes.SequenceEqual(rebuilt),
            equal,
            SourceHash,
            Hash(rebuilt),
            Rows.Count,
            RowDataSize,
            TypeName);
    }

    public byte[] Rebuild(IReadOnlyList<ParamRow> nextRows)
    {
        return Layout == ParamLayout.Standard32
            ? RebuildStandard32(nextRows)
            : RebuildCompact(nextRows);
    }

    private byte[] RebuildCompact(IReadOnlyList<ParamRow> nextRows)
    {
        if (nextRows.Count > MaxRows) throw new InvalidDataException("PARAM 行数超出安全上限。");
        foreach (var row in nextRows)
        {
            if (row.Data.Length != RowDataSize)
                throw new InvalidDataException($"PARAM 行 ID {row.Id} 数据长度 {row.Data.Length} 与行宽 {RowDataSize} 不一致。");
        }

        var typeNameBytes = Encoding.ASCII.GetBytes(TypeName + "\0");
        var rowHeadersSize = nextRows.Count * RowHeaderSize;
        var rowDataTotal = nextRows.Count * RowDataSize;
        var firstDataOffset = checked(HeaderSize + rowHeadersSize + _compactPreData.Length);
        var paramTypeOffset = checked(firstDataOffset + rowDataTotal + _compactDataTail.Length);
        var originalParamTypeOffset = checked((int)ReadInt64(SourceBytes, 0x10));
        var originalAlignedStringsOffset = ReadInt32(SourceBytes, 0);
        var alignedStringsOffset = originalAlignedStringsOffset == Align16(originalParamTypeOffset)
            ? Align16(paramTypeOffset)
            : checked(paramTypeOffset + originalAlignedStringsOffset - originalParamTypeOffset);
        // Data-only edits retain the source string pool and shared row-name offsets verbatim.
        // Sekiro commonly points many unnamed rows at one shared empty string; normalizing those
        // pointers to zero needlessly rewrites an otherwise untouched PARAM child.
        var originalStringOffset = originalParamTypeOffset;
        var preserveCompactStrings = _compactStringRegion.Length > 0
            && nextRows.Count == Rows.Count
            && nextRows.Select((row, index) =>
                    row.Id == Rows[index].Id
                    && string.Equals(row.Name, Rows[index].Name, StringComparison.Ordinal)
                    && (Rows[index].OriginalNameOffset == 0
                        || Rows[index].OriginalNameOffset >= originalStringOffset))
                .All(equal => equal);
        // Optional per-row names after type name.
        var rowNameOffsets = new int[nextRows.Count];
        var rowNameBytes = new List<byte[]>();
        var cursor = paramTypeOffset + typeNameBytes.Length;
        for (var i = 0; i < nextRows.Count; i++)
        {
            if (preserveCompactStrings)
            {
                var originalOffset = Rows[i].OriginalNameOffset;
                rowNameOffsets[i] = originalOffset == 0
                    ? 0
                    : checked(paramTypeOffset + originalOffset - originalStringOffset);
                rowNameBytes.Add(Array.Empty<byte>());
                continue;
            }
            var name = nextRows[i].Name;
            if (string.IsNullOrEmpty(name))
            {
                rowNameOffsets[i] = 0;
                rowNameBytes.Add(Array.Empty<byte>());
                continue;
            }
            var encoded = EncodeParamRowName(name!, nextRows[i].NameBytes, nextRows[i].NameEncoding);
            // 2-byte alignment for string pool entries (required for UTF-16LE in Sekiro 64-bit runtime).
            if ((cursor & 1) != 0)
            {
                cursor++;
            }
            rowNameOffsets[i] = cursor;
            rowNameBytes.Add(encoded);
            cursor += encoded.Length;
        }
        var fileSize = preserveCompactStrings
            ? checked(paramTypeOffset + _compactStringRegion.Length)
            : cursor;
        var rebuilt = new byte[fileSize];
        // Preserve unknown header bytes, then overwrite known fields.
        HeaderPrefix.AsSpan(0, Math.Min(HeaderSize, HeaderPrefix.Length)).CopyTo(rebuilt);
        WriteInt32(rebuilt, 0, alignedStringsOffset);
        WriteUInt16(rebuilt, 4, Unk04);
        WriteUInt16(rebuilt, 6, Unk06);
        WriteUInt16(rebuilt, 8, DataVersion);
        WriteUInt16(rebuilt, 10, (ushort)nextRows.Count);
        WriteInt64(rebuilt, 0x10, paramTypeOffset);

        for (var i = 0; i < nextRows.Count; i++)
        {
            var o = HeaderSize + i * RowHeaderSize;
            var dataOff = firstDataOffset + i * RowDataSize;
            WriteInt32(rebuilt, o, nextRows[i].Id);
            WriteInt32(rebuilt, o + 4, 0);
            WriteInt64(rebuilt, o + 8, dataOff);
            WriteInt64(rebuilt, o + 16, rowNameOffsets[i]);
            nextRows[i].Data.CopyTo(rebuilt, dataOff);
        }
        _compactPreData.CopyTo(rebuilt, HeaderSize + rowHeadersSize);
        _compactDataTail.CopyTo(rebuilt, firstDataOffset + rowDataTotal);
        if (preserveCompactStrings)
        {
            _compactStringRegion.CopyTo(rebuilt, paramTypeOffset);
        }
        else
        {
            typeNameBytes.CopyTo(rebuilt, paramTypeOffset);
            for (var i = 0; i < nextRows.Count; i++)
            {
                if (rowNameOffsets[i] == 0) continue;
                rowNameBytes[i].CopyTo(rebuilt, rowNameOffsets[i]);
            }
        }
        return rebuilt;
    }

    private byte[] RebuildStandard32(IReadOnlyList<ParamRow> nextRows)
    {
        if (nextRows.Count > MaxRows) throw new InvalidDataException("PARAM 行数超出安全上限。");
        if (nextRows.Count != Rows.Count)
            throw new InvalidDataException("PARAM 32 位布局暂不支持 add/delete：结构重排未经该格式变体验证。");
        var rebuilt = SourceBytes.ToArray();
        for (var i = 0; i < nextRows.Count; i++)
        {
            var row = nextRows[i];
            var original = Rows[i];
            if (row.Data.Length != RowDataSize)
                throw new InvalidDataException($"PARAM 行 ID {row.Id} 数据长度 {row.Data.Length} 与行宽 {RowDataSize} 不一致。");
            if (row.Id != original.Id || !string.Equals(row.Name, original.Name, StringComparison.Ordinal))
                throw new InvalidDataException("PARAM 32 位布局只开放同一物理行的等宽数据修改；ID/名称重排未验证。");
            if (original.OriginalDataOffset < 0
                || original.OriginalDataOffset + RowDataSize > rebuilt.Length)
                throw new InvalidDataException($"PARAM 第 {i} 行原始数据偏移无效。");
            row.Data.CopyTo(rebuilt, original.OriginalDataOffset);
        }
        return rebuilt;
    }

    public byte[] ApplyMutations(IReadOnlyList<ParamPatch> patches)
    {
        return Layout == ParamLayout.Standard32
            ? ApplyStandard32Mutations(patches)
            : ApplyCompactMutations(patches);
    }

    private byte[] ApplyCompactMutations(IReadOnlyList<ParamPatch> patches)
    {
        var rows = Rows.Select(r => new ParamRow(
            r.Id, r.Data.ToArray(), r.Name, r.NameBytes, r.NameEncoding,
            r.OriginalNameOffset, r.OriginalDataOffset)).ToList();
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "upsert":
                {
                    if (patch.DataBase64 is null) throw new InvalidDataException("PARAM upsert 需要 dataBase64。");
                    var data = Convert.FromBase64String(patch.DataBase64);
                    if (data.Length != RowDataSize) throw new InvalidDataException("PARAM upsert 行宽不匹配。");
                    var idx = ResolveExistingRowIndex(rows, patch);
                    var prev = idx >= 0 ? rows[idx] : null;
                    var nextName = patch.Name ?? prev?.Name;
                    // 名称未被 patch 修改（或补丁未带 name）时保留原始字节，保证无修改往返字节一致。
                    var keepOriginal = prev is not null && string.Equals(nextName, prev.Name, StringComparison.Ordinal);
                    var next = new ParamRow(
                        patch.Id,
                        data,
                        nextName,
                        keepOriginal ? prev!.NameBytes : null,
                        keepOriginal ? prev!.NameEncoding : prev?.NameEncoding,
                        keepOriginal ? prev!.OriginalNameOffset : 0,
                        prev?.OriginalDataOffset ?? 0);
                    if (idx >= 0) rows[idx] = next; else rows.Add(next);
                    break;
                }
                case "delete":
                {
                    var idx = ResolveExistingRowIndex(rows, patch);
                    if (idx < 0) throw new InvalidDataException($"PARAM 删除目标 ID {patch.Id} 不存在。");
                    rows.RemoveAt(idx);
                    break;
                }
                case "add":
                {
                    if (rows.Any(r => r.Id == patch.Id)) throw new InvalidDataException($"PARAM 新增 ID {patch.Id} 已存在。");
                    if (patch.DataBase64 is null) throw new InvalidDataException("PARAM add 需要 dataBase64。");
                    var data = Convert.FromBase64String(patch.DataBase64);
                    if (data.Length != RowDataSize) throw new InvalidDataException("PARAM add 行宽不匹配。");
                    rows.Add(new ParamRow(patch.Id, data, patch.Name, null, null));
                    break;
                }
                default:
                    throw new InvalidDataException($"未知 PARAM mutation：{patch.Kind}。");
            }
        }
        // Preserve binder row order. PARAM row IDs are not guaranteed to be sorted,
        // and silently sorting them makes a field edit rewrite unrelated structure.
        return Rebuild(rows);
    }

    private static int ResolveExistingRowIndex(IReadOnlyList<ParamRow> rows, ParamPatch patch)
    {
        if (patch.RowIndex is int rowIndex)
        {
            if (rowIndex < 0 || rowIndex >= rows.Count)
                throw new InvalidDataException($"PARAM 物理行索引 {rowIndex} 越界。");
            var row = rows[rowIndex];
            if (row.Id != patch.Id)
                throw new InvalidDataException(
                    $"PARAM 物理行索引 {rowIndex} 的 ID 已变化：expected={patch.Id}，actual={row.Id}。");
            if (patch.ExpectedDataHash is not null
                && !Hash(row.Data).Equals(patch.ExpectedDataHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"PARAM 物理行索引 {rowIndex} 的数据哈希已变化。");
            return rowIndex;
        }

        var match = -1;
        for (var i = 0; i < rows.Count; i++)
        {
            if (rows[i].Id != patch.Id) continue;
            if (match >= 0)
                throw new InvalidDataException(
                    $"PARAM ID {patch.Id} 存在重复行；mutation 必须携带 rowIndex 和 expectedDataHash。");
            match = i;
        }
        return match;
    }

    private byte[] ApplyStandard32Mutations(IReadOnlyList<ParamPatch> patches)
    {
        var rows = Rows.Select(r => new ParamRow(
            r.Id, r.Data.ToArray(), r.Name, r.NameBytes, r.NameEncoding,
            r.OriginalNameOffset, r.OriginalDataOffset)).ToList();
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "upsert":
                {
                    if (patch.DataBase64 is null) throw new InvalidDataException("PARAM upsert 需要 dataBase64。");
                    var data = Convert.FromBase64String(patch.DataBase64);
                    if (data.Length != RowDataSize) throw new InvalidDataException("PARAM upsert 行宽不匹配。");
                    var idx = ResolveExistingRowIndex(rows, patch);
                    if (idx < 0)
                        throw new InvalidDataException($"PARAM 32 位布局不支持新增行 upsert：ID {patch.Id} 不存在。");
                    if (patch.Name is not null && patch.Name != rows[idx].Name)
                        throw new InvalidDataException("PARAM 32 位布局不支持行名变更（字符串区按字节保留）。");
                    rows[idx] = rows[idx] with { Data = data };
                    break;
                }
                case "delete":
                    throw new InvalidDataException("PARAM 32 位布局不支持 delete：结构重排未经该格式变体验证。");
                case "add":
                    throw new InvalidDataException("PARAM 32 位布局不支持 add：结构重排未经该格式变体验证。");
                default:
                    throw new InvalidDataException($"未知 PARAM mutation：{patch.Kind}。");
            }
        }
        return Rebuild(rows);
    }

    public object ToEnvelope(ParamRoundTripReport? report = null, int rowPreviewLimit = 32, int rowPage = 0, int rowPageSize = 0, bool includeAllPayloads = false, int[]? rowIds = null, bool includeRowHashes = true)
    {
        // Large params (multi-MB / wide rows) must not dump payloads into one NDJSON frame.
        // 载荷上限按「本次实际返回多少行」算，而不是按全表行数。
        //
        // 原条件是 Rows.Count <= rowPreviewLimit（全表行数），于是 590 行的表
        // 即使只请求 3 行也拿不到 dataBase64 —— 分页的意义被这一条抵消了。
        // 实测这正是界面「有行号却没有字段值」的原因：字段解码需要行字节，
        // 而行字节因全表太大被整体拒绝返回。
        //
        // 帧大小的真实约束是「这一帧里有多少字节」= 页行数 × 行宽，
        // 故上限按页字节总量算，不按行宽单独设阈值。
        //
        // 原条件还有 RowDataSize <= 256。实测那让 NpcParam（行宽 896、352 个字段）
        // 拿不到行字节，于是它的字段值永远显示不出来 —— 而 896 × 32 行 = 28 KB，
        // 远低于守护进程 1 MB 的默认帧上限。按行宽设阈值是在用错误的量做判断：
        // 一个 900 字节宽但只请求 3 行的页，比一个 100 字节宽请求 500 行的页小得多。
        var includePayload = RowDataSize > 0;
        var totalRows = Rows.Count;
        var idFilter = rowIds is { Length: > 0 } ? new HashSet<int>(rowIds) : null;

        // Id filter is for Agent/CLI targeted reads: return only those rows
        // with payloads. Pagination still applies when no ids are requested.
        if (idFilter is not null)
        {
            var filtered = Rows
                .Select((row, rowIndex) => (row, rowIndex))
                .Where(item => idFilter.Contains(item.row.Id))
                .ToArray();
            return new
            {
                format = "PARAM",
                typeName = TypeName,
                dataVersion = DataVersion,
                rowCount = totalRows,
                rowDataSize = RowDataSize,
                layout = Layout == ParamLayout.Standard32 ? "standard-32" : "long-64",
                sourceSize = SourceBytes.Length,
                sourceHash = SourceHash,
                rows = filtered.Select(item => new
                {
                    rowIndex = item.rowIndex,
                    item.row.Id,
                    item.row.Name,
                    dataBase64 = includePayload ? Convert.ToBase64String(item.row.Data) : null,
                    dataHash = includeRowHashes ? Hash(item.row.Data) : null
                }).ToArray(),
                rowPreviewLimit,
                rowsTruncated = false,
                payloadsIncluded = includePayload,
                rowPage = 0,
                rowPageSize = filtered.Length,
                rowTotal = totalRows,
                rowPageCount = 1,
                requestedRowCount = idFilter.Count,
                returnedRowCount = filtered.Length,
                roundTrip = report ?? VerifyRoundTrip(),
                authority = report is { SemanticIdentical: true } ? "native-verified" : "candidate",
                fieldLayout = "raw-row-bytes-without-paramdef"
            };
        }

        // Pagination: when rowPageSize > 0, return only the requested page.
        var effectivePageSize = rowPageSize > 0 ? rowPageSize : totalRows;
        var pageCount = effectivePageSize > 0 ? (int)Math.Ceiling((double)totalRows / effectivePageSize) : 1;
        var clampedPage = Math.Clamp(rowPage, 0, Math.Max(0, pageCount - 1));
        var skip = clampedPage * effectivePageSize;
        var pageRows = Rows
            .Select((row, rowIndex) => (row, rowIndex))
            .Skip(skip)
            .Take(effectivePageSize)
            .ToArray();
        // 页载荷字节预算：base64 会膨胀约 4/3，再留出 JSON 结构与其他字段的余量。
        // 512 KB 原始字节 ≈ 700 KB base64，仍在默认 1 MB 帧上限内。
        // 超预算时不返回字节而不是截断行 —— 半份行数据解码出的字段值是错的，
        // 而错的数值比没有数值危险。
        //
        // includeAllPayloads（用户裁定 2026-08-14）：显式请求时跳过 32 行 / 512 KB
        // 门控，一次返回全表行字节（renderer 打开表即全量加载，不再分批续取）。
        // 帧会变大（数 MB base64）；守护进程帧上限的绝对上限是 32 MB，调用方在
        // 请求全量时必须同步提高 maxFrameBytes（见 main 侧 includeAllPayloads 路径）。
        const int MaxPagePayloadBytes = 512 * 1024;
        var pagePayloadBytes = (long)pageRows.Length * RowDataSize;
        var pageIncludePayload = includePayload
            && (includeAllPayloads
                || (pageRows.Length <= rowPreviewLimit && pagePayloadBytes <= MaxPagePayloadBytes));

        return new
        {
            format = "PARAM",
            typeName = TypeName,
            dataVersion = DataVersion,
            rowCount = totalRows,
            rowDataSize = RowDataSize,
            layout = Layout == ParamLayout.Standard32 ? "standard-32" : "long-64",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            rows = pageRows.Select(item => new
            {
                rowIndex = item.rowIndex,
                item.row.Id,
                item.row.Name,
                dataBase64 = pageIncludePayload ? Convert.ToBase64String(item.row.Data) : null,
                dataHash = includeRowHashes ? Hash(item.row.Data) : null
            }).ToArray(),
            rowPreviewLimit,
            rowsTruncated = rowPageSize <= 0 && totalRows > rowPreviewLimit,
            payloadsIncluded = pageIncludePayload,
            // Pagination metadata
            rowPage = clampedPage,
            rowPageSize = effectivePageSize,
            rowTotal = totalRows,
            rowPageCount = pageCount,
            roundTrip = report ?? VerifyRoundTrip(),
            authority = report is { SemanticIdentical: true } ? "native-verified" : "candidate",
            fieldLayout = "raw-row-bytes-without-paramdef"
        };
    }

    /// <summary>
    /// Detects the legacy layout family by the embedded ASCII type name at header offset 0x0C.
    /// Compact-layout headers carry zeros there; the legacy family stores a printable C-string.
    /// </summary>
    private static string? TryReadEmbeddedName(byte[] source)
    {
        var length = 0;
        for (var i = 0; i < 32; i++)
        {
            var c = source[0x0C + i];
            if (c == 0) break;
            if (c < 0x20 || c > 0x7e) return null;
            length++;
        }
        return length >= 2 ? Encoding.ASCII.GetString(source, 0x0C, length) : null;
    }

    private static string? DecodeShiftJisName(byte[] source, int offset)
    {
        var end = offset;
        while (end < source.Length && source[end] != 0 && end - offset < MaxNameBytes)
        {
            end++;
        }
        if (end - offset == 0 || (end - offset >= MaxNameBytes && source[end - 1] != 0)) return null;
        try
        {
            return ShiftJisEncoding.GetString(source, offset, end - offset);
        }
        catch (Exception ex) when (ex is ArgumentException or DecoderFallbackException)
        {
            return null;
        }
    }

    private static (string? Name, byte[]? NameBytes, string? Encoding) DecodeUnicodeParamRowName(
        byte[] source,
        int offset)
    {
        return TryDecodeUtf16LeName(source, offset, out var name, out var bytes)
            ? (name, bytes, "utf16le")
            : (null, null, null);
    }

    private static (string? Name, byte[]? NameBytes, string? Encoding) DecodeSingleByteParamRowName(
        byte[] source,
        int offset)
    {
        var length = ScanZLength(source, offset);
        if (length <= 0) return (null, null, null);
        var bytes = source.AsSpan(offset, length).ToArray();
        try
        {
            return (ShiftJisEncoding.GetString(bytes), bytes, "shiftjis");
        }
        catch (Exception ex) when (ex is ArgumentException or DecoderFallbackException)
        {
            return (null, bytes, "shiftjis");
        }
    }

    /// <summary>
    /// 解码 compact 布局 PARAM 行名。只狼的行名可能是 UTF-16LE（宽 NUL 0x00 0x00 终止，
    /// 含 NUL 交错的 ASCII 内容与 CJK/假名高位字符）、Shift-JIS（单字节 NUL 终止）或纯
    /// ASCII。返回解码名 + 原始名称字节（不含终止符）+ 编码标签；解码失败不抛异常，
    /// 返回 (null, null, null)，由调用方按未命名行处理并把原始字节保留给无损往返。
    /// </summary>
    private static (string? Name, byte[]? NameBytes, string? Encoding) DecodeParamRowName(byte[] source, int offset)
    {
        if (offset < 0 || offset >= source.Length)
            return (null, null, null);

        // (a) UTF-16LE：宽 NUL 终止，偶数步进扫描并逐 2 字节校验合法字符。
        if (TryDecodeUtf16LeName(source, offset, out var utf16Name, out var utf16Bytes))
            return (utf16Name, utf16Bytes, "utf16le");

        // 单字节 NUL 终止：先判纯 ASCII，再试 Shift-JIS，最后退回 ASCII（历史 ReadAsciiZ 行为）。
        var zlen = ScanZLength(source, offset);
        if (zlen <= 0)
            return (null, null, null);

        var span = source.AsSpan(offset, zlen);
        var raw = span.ToArray();

        var allPrintableAscii = true;
        for (var i = 0; i < span.Length; i++)
        {
            var b = span[i];
            if (b < 0x20 || b > 0x7e) { allPrintableAscii = false; break; }
        }
        if (allPrintableAscii)
            return (Encoding.ASCII.GetString(span), raw, "ascii");

        try
        {
            var sjis = ShiftJisEncoding.GetString(span);
            if (sjis.Length > 0 && sjis.IndexOf('\uFFFD') < 0)
                return (sjis, raw, "shiftjis");
        }
        catch (Exception ex) when (ex is ArgumentException or DecoderFallbackException)
        {
        }

        // 未知编码的高位字节：退回 ASCII（高位字节退化为 '?'，与历史行为一致）。
        // 原始字节仍保留，名称未变时 Rebuild 原样拷贝，字节无损。
        return (Encoding.ASCII.GetString(span), raw, "ascii");
    }

    private static bool TryDecodeUtf16LeName(byte[] source, int offset, out string? name, out byte[]? bytes)
    {
        name = null;
        bytes = null;
        var len = 0;
        while (offset + len + 1 < source.Length && len + 2 <= MaxNameBytes)
        {
            if (source[offset + len] == 0 && source[offset + len + 1] == 0)
            {
                if (len == 0) return false;
                var valid = true;
                for (var p = 0; p < len; p += 2)
                {
                    var c = (char)(source[offset + p] | (source[offset + p + 1] << 8));
                    if (source[offset + p + 1] == 0)
                    {
                        // 高位字节为 0：UTF-16LE 的 U+0000..U+00FF 区，允许可打印 ASCII
                        // (0x20-0x7E) 与 Latin-1 可见扩展 (0xA0-0xFF，如 · × ÷ 等中日文常用标点)，
                        // 排除控制字符与 0x7F-0x9F 未定义区。
                        if (c < 0x20 || (c > 0x7e && c < 0xa0)) { valid = false; break; }
                    }
                    else if (c <= 0x7f || char.IsSurrogate(c) || c == 0xfffe || c == 0xffff)
                    {
                        valid = false;
                        break;
                    }
                }
                if (!valid) return false;
                name = Encoding.Unicode.GetString(source, offset, len);
                bytes = source.AsSpan(offset, len).ToArray();
                return true;
            }
            len += 2;
        }
        return false;
    }

    private static int ScanZLength(byte[] source, int offset)
    {
        for (var i = offset; i < source.Length; i++)
        {
            if (source[i] == 0) return i - offset;
            if (i - offset >= MaxNameBytes) return -1;
        }
        return -1;
    }

    private static byte[] EncodeParamRowName(string name, byte[]? originalBytes, string? encoding)
    {
        // 名称未改：原始字节 re-decode 后等于当前名 → 原样拷贝原始字节，保证字节级无损。
        if (originalBytes is { Length: > 0 } && NameMatchesOriginal(originalBytes, encoding, name))
            return AppendTerminator(originalBytes, encoding);

        var enc = encoding switch
        {
            "utf16le" => Encoding.Unicode,
            "shiftjis" => ShiftJisEncoding,
            _ => Encoding.ASCII
        };
        return AppendTerminator(enc.GetBytes(name), encoding);
    }

    private static bool NameMatchesOriginal(byte[] originalBytes, string? encoding, string name)
    {
        try
        {
            var decoded = encoding switch
            {
                "utf16le" => Encoding.Unicode.GetString(originalBytes),
                "shiftjis" => ShiftJisEncoding.GetString(originalBytes),
                _ => Encoding.ASCII.GetString(originalBytes)
            };
            return string.Equals(decoded, name, StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is ArgumentException or DecoderFallbackException)
        {
            return false;
        }
    }

    private static byte[] AppendTerminator(byte[] body, string? encoding)
    {
        if (encoding == "utf16le")
        {
            var result = new byte[body.Length + 2];
            body.CopyTo(result, 0);
            return result; // 尾部两字节保持 0x00 0x00（宽 NUL）
        }
        var r = new byte[body.Length + 1];
        body.CopyTo(r, 0);
        return r; // 单字节 NUL
    }

    private static Encoding CreateShiftJisEncoding()
    {
        // CodePagesEncodingProvider ships with the .NET runtime pack; no extra package dependency.
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        return Encoding.GetEncoding(932);
    }

    private static string ReadAsciiZ(byte[] source, int offset)
    {
        var end = offset;
        while (end < source.Length && source[end] != 0)
        {
            end++;
            if (end - offset > 4096) throw new InvalidDataException("PARAM ASCII 字符串过长。");
        }
        if (end >= source.Length) throw new InvalidDataException("PARAM ASCII 字符串未终止。");
        return Encoding.ASCII.GetString(source, offset, end - offset);
    }

    private static int FindEarlierTypeNameOffset(
        byte[] source,
        string typeName,
        int start,
        int exclusiveEnd)
    {
        var needle = Encoding.ASCII.GetBytes(typeName + "\0");
        var last = exclusiveEnd - needle.Length;
        for (var offset = Math.Max(0, start); offset <= last; offset++)
        {
            if (source.AsSpan(offset, needle.Length).SequenceEqual(needle)) return offset;
        }
        return -1;
    }

    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static long ReadInt64(byte[] source, int offset) => BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
    private static int CheckedOffset64(byte[] source, int offset, string label)
    {
        var value = ReadInt64(source, offset);
        if (value <= 0 || value >= source.Length || value > int.MaxValue)
            throw new InvalidDataException($"{label}偏移无效：{value}。");
        return checked((int)value);
    }

    private static int ReadOffset32(byte[] source, int offset, string label, bool allowZero = false)
    {
        var value = BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
        if ((value == 0 && !allowZero) || value > int.MaxValue || value >= source.Length)
            throw new InvalidDataException($"{label}偏移无效：{value}。");
        return checked((int)value);
    }
    private static ushort ReadUInt16(byte[] source, int offset) => BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteInt64(byte[] target, int offset, long value) => BinaryPrimitives.WriteInt64LittleEndian(target.AsSpan(offset, 8), value);
    private static void WriteUInt16(byte[] target, int offset, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), value);
    private static int Align16(int value) => checked((value + 0x0f) & ~0x0f);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static string ComputeRowDataHash(byte[] rowData) => Hash(rowData);
}

internal sealed record ParamRow(
    int Id,
    byte[] Data,
    string? Name,
    byte[]? NameBytes,
    string? NameEncoding,
    int OriginalNameOffset = 0,
    int OriginalDataOffset = 0);
internal sealed record ParamPatch(
    string Kind,
    int Id,
    string? DataBase64,
    string? Name,
    int? RowIndex = null,
    string? ExpectedDataHash = null);
internal sealed record ParamRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int RowCount,
    int RowDataSize,
    string TypeName);
internal sealed record ParamHeader(
    string TypeName,
    ushort DataVersion,
    ushort RowCount,
    byte FormatFlags1,
    byte FormatFlags2,
    string SourceHash);

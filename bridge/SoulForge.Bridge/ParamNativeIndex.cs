using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Read-only PARAM row directory used by the session IPC path.
///
/// The native parser remains ParamNativeDocument for writes and explicit
/// round-trip checks. This index only validates header/row offsets and keeps
/// row identity plus raw offsets; it does not construct ParamRow payloads.
/// A payload is copied only when the caller asks for that physical row.
/// </summary>
internal sealed class ParamNativeIndex
{
    private const int HeaderSize = 0x40;
    private const int RowHeaderSize = 0x18;
    private const int StandardRowHeaderSize = 0x0C;
    private const int MaxNameBytes = 512;
    private const int MaxRows = 500_000;
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private static readonly Encoding ShiftJisEncoding = CreateShiftJisEncoding();

    internal sealed record Row(
        int RowIndex,
        int Id,
        string? Name,
        int DataOffset,
        int DataLength,
        string DataHash);

    private ParamNativeIndex(
        byte[] sourceBytes,
        ParamHeader header,
        ParamLayout layout,
        int rowDataSize,
        IReadOnlyList<Row> rows)
    {
        SourceBytes = sourceBytes;
        SourceHash = header.SourceHash;
        TypeName = header.TypeName;
        DataVersion = header.DataVersion;
        Layout = layout;
        RowDataSize = rowDataSize;
        Rows = rows;
    }

    public byte[] SourceBytes { get; }
    public string SourceHash { get; }
    public string TypeName { get; }
    public ushort DataVersion { get; }
    public ParamLayout Layout { get; }
    public int RowDataSize { get; }
    public IReadOnlyList<Row> Rows { get; }

    public static ParamNativeIndex Read(byte[] source, int? expectedRowDataSize = null)
    {
        if (source.Length < HeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 大小 {source.Length} 超出安全范围。");

        var header = ParamNativeDocument.ReadHeader(source);
        return (header.FormatFlags1 & 0x04) != 0
            ? ReadCompact(source, header, expectedRowDataSize)
            : ReadStandard32(source, header, expectedRowDataSize);
    }

    public Row GetRow(int rowIndex)
    {
        if (rowIndex < 0 || rowIndex >= Rows.Count)
            throw new InvalidDataException($"PARAM 物理行索引 {rowIndex} 越界（rowCount={Rows.Count}）。");
        return Rows[rowIndex];
    }

    public byte[] ReadRowBytes(Row row)
    {
        System.Threading.Interlocked.Increment(ref BridgeTelemetry.ParamDecodedRowsCount);
        return SourceBytes.AsSpan(row.DataOffset, row.DataLength).ToArray();
    }

    /// <summary>
    /// Project the same legacy PARAM envelope from the directory. The caller
    /// may attach a round-trip report when it deliberately chose the full
    /// document path; the normal session path leaves it absent.
    /// </summary>
    public object ToEnvelope(
        ParamRoundTripReport? report = null,
        int rowPreviewLimit = 32,
        int rowPage = 0,
        int rowPageSize = 0,
        bool includeAllPayloads = false,
        int[]? rowIds = null,
        bool includeRowHashes = true,
        bool includePayloads = true)
    {
        var totalRows = Rows.Count;
        var includePayload = RowDataSize > 0;
        IEnumerable<Row> selectedRows;
        int effectivePageSize;
        int clampedPage;
        int pageCount;

        if (rowIds is { Length: > 0 })
        {
            var idFilter = new HashSet<int>(rowIds);
            selectedRows = Rows.Where(row => idFilter.Contains(row.Id));
            effectivePageSize = totalRows;
            clampedPage = 0;
            pageCount = 1;
        }
        else
        {
            effectivePageSize = rowPageSize > 0 ? rowPageSize : totalRows;
            pageCount = effectivePageSize > 0
                ? (int)Math.Ceiling((double)totalRows / effectivePageSize)
                : 1;
            clampedPage = Math.Clamp(rowPage, 0, Math.Max(0, pageCount - 1));
            var skip = checked(clampedPage * effectivePageSize);
            selectedRows = Rows.Skip(skip).Take(effectivePageSize);
        }

        var materializedRows = selectedRows.ToArray();
        var pagePayloadBytes = (long)materializedRows.Length * RowDataSize;
        const int maxPagePayloadBytes = 512 * 1024;
        var pageIncludePayload = includePayloads && includePayload
            && (includeAllPayloads
                || (materializedRows.Length <= rowPreviewLimit && pagePayloadBytes <= maxPagePayloadBytes));

        var outputRows = new List<object>(materializedRows.Length);
        foreach (var row in materializedRows)
        {
            outputRows.Add(new
            {
                rowIndex = row.RowIndex,
                id = row.Id,
                name = row.Name,
                dataBase64 = pageIncludePayload ? Convert.ToBase64String(ReadRowBytes(row)) : null,
                dataHash = includeRowHashes ? row.DataHash : null
            });
        }

        var response = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["format"] = "PARAM",
            ["typeName"] = TypeName,
            ["dataVersion"] = DataVersion,
            ["rowCount"] = totalRows,
            ["rowDataSize"] = RowDataSize,
            ["layout"] = Layout == ParamLayout.Standard32 ? "standard-32" : "long-64",
            ["sourceSize"] = SourceBytes.Length,
            ["sourceHash"] = SourceHash,
            ["rows"] = outputRows.ToArray(),
            ["rowPreviewLimit"] = rowPreviewLimit,
            ["rowsTruncated"] = rowPageSize <= 0 && totalRows > rowPreviewLimit,
            ["payloadsIncluded"] = pageIncludePayload,
            ["rowPage"] = clampedPage,
            ["rowPageSize"] = rowIds is { Length: > 0 } ? materializedRows.Length : effectivePageSize,
            ["rowTotal"] = totalRows,
            ["rowPageCount"] = pageCount,
            ["requestedRowCount"] = rowIds?.Length,
            ["returnedRowCount"] = materializedRows.Length,
            ["authority"] = report is { SemanticIdentical: true } ? "native-verified" : "candidate",
            ["fieldLayout"] = "raw-row-bytes-without-paramdef"
        };
        if (report is not null) response["roundTrip"] = report;
        return response;
    }

    private static ParamNativeIndex ReadCompact(
        byte[] source,
        ParamHeader header,
        int? expectedRowDataSize)
    {
        var alignedStringsOffset = ReadInt32(source, 0);
        var paramTypeOffset = ReadCheckedOffset64(source, 0x10, "PARAM 类型名");
        if (alignedStringsOffset < 0 || alignedStringsOffset > source.Length)
            throw new InvalidDataException("PARAM 字符串区标记偏移越界。");

        var rowCount = header.RowCount;
        if (rowCount == 0)
            return new ParamNativeIndex(source, header, ParamLayout.Long64, 0, Array.Empty<Row>());

        var rowHeadersEnd = checked(HeaderSize + rowCount * RowHeaderSize);
        var firstDataOffset = ReadInt32(source, HeaderSize + 8);
        if (firstDataOffset < rowHeadersEnd || firstDataOffset > paramTypeOffset)
            throw new InvalidDataException("PARAM 首行数据偏移无效。");

        var rowDataSize = rowCount > 1
            ? checked(ReadInt32(source, HeaderSize + RowHeaderSize + 8) - firstDataOffset)
            : paramTypeOffset - firstDataOffset;
        if (rowCount == 1)
        {
            var earlierTypeOffset = FindEarlierTypeNameOffset(source, header.TypeName, firstDataOffset, paramTypeOffset);
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

        var rows = new List<Row>(rowCount);
        for (var i = 0; i < rowCount; i++)
        {
            var offset = HeaderSize + i * RowHeaderSize;
            var id = ReadInt32(source, offset);
            var pad0 = ReadInt32(source, offset + 4);
            var dataOffset = ReadInt32(source, offset + 8);
            var pad1 = ReadInt32(source, offset + 12);
            var nameOffset = ReadInt32(source, offset + 16);
            var pad2 = ReadInt32(source, offset + 20);
            if (pad0 != 0 || pad1 != 0 || pad2 != 0)
                throw new InvalidDataException($"PARAM 第 {i} 行头填充非零，拒绝猜测解析。");
            if (dataOffset != firstDataOffset + i * rowDataSize)
                throw new InvalidDataException($"PARAM 第 {i} 行 dataOffset 非紧凑布局。");
            var name = DecodeCompactName(source, nameOffset);
            rows.Add(new Row(i, id, name, dataOffset, rowDataSize, Hash(source, dataOffset, rowDataSize)));
        }

        return new ParamNativeIndex(source, header, ParamLayout.Long64, rowDataSize, rows);
    }

    private static ParamNativeIndex ReadStandard32(
        byte[] source,
        ParamHeader header,
        int? expectedRowDataSize)
    {
        var rowDirectoryStart = (header.FormatFlags1 & 0x03) == 0x03 ? HeaderSize : 0x30;
        var rowCount = header.RowCount;
        var rowDirectoryEnd = checked(rowDirectoryStart + rowCount * StandardRowHeaderSize);
        if (rowDirectoryEnd > source.Length)
            throw new InvalidDataException("PARAM 32 位行目录越过文件末尾。");
        if (rowCount == 0)
            return new ParamNativeIndex(source, header, ParamLayout.Standard32, 0, Array.Empty<Row>());

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
            .Where(headerItem => headerItem.NameOffset > 0)
            .Select(headerItem => headerItem.NameOffset)
            .DefaultIfEmpty(0)
            .Min();
        int rowDataSize;
        if (rowCount > 1)
        {
            rowDataSize = checked(headers[1].DataOffset - firstDataOffset);
            if (expectedRowDataSize is int expected && expected != rowDataSize)
                throw new InvalidDataException(
                    $"PARAMDEF 行宽 {expected} 与相邻 DataOffset 推导行宽 {rowDataSize} 不一致。");
        }
        else if (expectedRowDataSize is int expected)
        {
            rowDataSize = expected;
        }
        else
        {
            var boundary = (header.FormatFlags1 & 0x80) != 0
                ? ReadCheckedOffset64(source, 0x10, "PARAM 类型名")
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

        var unicodeRowNames = (header.FormatFlags2 & 0x01) != 0;
        var rows = new List<Row>(rowCount);
        for (var i = 0; i < rowCount; i++)
        {
            var item = headers[i];
            var expectedDataOffset = checked(firstDataOffset + i * rowDataSize);
            if (item.DataOffset != expectedDataOffset)
                throw new InvalidDataException(
                    $"PARAM 32 位第 {i} 行 dataOffset 非固定行宽布局：expected={expectedDataOffset}，actual={item.DataOffset}。");
            var name = DecodeStandardName(source, item.NameOffset, unicodeRowNames);
            rows.Add(new Row(i, item.Id, name, item.DataOffset, rowDataSize, Hash(source, item.DataOffset, rowDataSize)));
        }

        return new ParamNativeIndex(source, header, ParamLayout.Standard32, rowDataSize, rows);
    }

    private static string? DecodeCompactName(byte[] source, int offset)
    {
        if (offset == 0) return null;
        if (offset < 0 || offset >= source.Length)
            throw new InvalidDataException("PARAM 行名称偏移越界。");
        if (TryDecodeUtf16LeName(source, offset, out var utf16Name)) return utf16Name;
        var length = ScanZLength(source, offset);
        if (length <= 0) return null;
        var bytes = source.AsSpan(offset, length).ToArray();
        var ascii = bytes.All(value => value is >= 0x20 and <= 0x7e);
        if (ascii) return Encoding.ASCII.GetString(bytes);
        try
        {
            var sjis = ShiftJisEncoding.GetString(bytes);
            return sjis.IndexOf('\uFFFD') < 0 ? sjis : Encoding.ASCII.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.ASCII.GetString(bytes);
        }
    }

    private static string? DecodeStandardName(byte[] source, int offset, bool unicode)
    {
        if (offset == 0) return null;
        if (offset < 0 || offset >= source.Length)
            throw new InvalidDataException("PARAM 行名称偏移越界。");
        if (unicode)
        {
            return TryDecodeUtf16LeName(source, offset, out var name) ? name : null;
        }
        var length = ScanZLength(source, offset);
        if (length <= 0) return null;
        return ShiftJisEncoding.GetString(source, offset, length);
    }

    private static bool TryDecodeUtf16LeName(byte[] source, int offset, out string? name)
    {
        name = null;
        var length = 0;
        while (offset + length + 1 < source.Length && length + 2 <= MaxNameBytes)
        {
            if (source[offset + length] == 0 && source[offset + length + 1] == 0)
            {
                if (length == 0) return false;
                for (var p = 0; p < length; p += 2)
                {
                    var code = source[offset + p] | source[offset + p + 1] << 8;
                    if (source[offset + p + 1] == 0)
                    {
                        if (code < 0x20 || (code > 0x7e && code < 0xa0)) return false;
                    }
                    else if (code <= 0x7f || char.IsSurrogate((char)code) || code is 0xfffe or 0xffff)
                    {
                        return false;
                    }
                }
                name = Encoding.Unicode.GetString(source, offset, length);
                return true;
            }
            length += 2;
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

    private static int FindEarlierTypeNameOffset(byte[] source, string typeName, int start, int exclusiveEnd)
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

    private static int ReadCheckedOffset64(byte[] source, int offset, string label)
    {
        var value = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
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

    private static string Hash(byte[] source, int offset, int length) =>
        Convert.ToHexString(SHA256.HashData(source.AsSpan(offset, length))).ToLowerInvariant();

    private static Encoding CreateShiftJisEncoding()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        return Encoding.GetEncoding(932);
    }
}

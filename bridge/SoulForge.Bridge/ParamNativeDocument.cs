using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro PARAM (regulation/gameparam child) lossless document.
/// Row field interpretation requires paramdef; without def, rows are raw byte payloads
/// keyed by ID. Layout derived from private gameparam.parambnd.dcx corpus.
/// </summary>
internal sealed class ParamNativeDocument
{
    private const int MaxInlineRowPayloadBytes = 256 * 1024;
    private const int MaxRowPageSize = 500;
    private const int LongHeaderSize = 0x40;
    private const int LongRowHeaderSize = 0x18;
    private const int EmbeddedHeaderSize = 0x30;
    private const int EmbeddedRowHeaderSize = 0x0C;
    private const int EmbeddedTypeNameFormatFlags = 0x100;
    private const int EmbeddedTypeNameCompactFormatFlags = 0x200;
    private const int MaxRows = 500_000;
    private const int MaxSourceBytes = 64 * 1024 * 1024;

    private ParamNativeDocument(
        byte[] sourceBytes,
        byte[] headerPrefix,
        ushort dataVersion,
        ushort unk04,
        ushort unk06,
        string typeName,
        int rowDataSize,
        ParamLayout layout,
        byte[] dataGapBytes,
        IReadOnlyList<ParamRow> rows)
    {
        SourceBytes = sourceBytes;
        HeaderPrefix = headerPrefix;
        DataVersion = dataVersion;
        Unk04 = unk04;
        Unk06 = unk06;
        TypeName = typeName;
        RowDataSize = rowDataSize;
        Layout = layout;
        DataGapBytes = dataGapBytes;
        Rows = rows;
    }

    public byte[] SourceBytes { get; }
    public byte[] HeaderPrefix { get; }
    public ushort DataVersion { get; }
    public ushort Unk04 { get; }
    public ushort Unk06 { get; }
    public string TypeName { get; }
    public int RowDataSize { get; }
    public ParamLayout Layout { get; }
    private byte[] DataGapBytes { get; }
    public IReadOnlyList<ParamRow> Rows { get; }
    public string SourceHash => Hash(SourceBytes);

    public static ParamNativeDocument Read(byte[] source)
    {
        if (source.Length < EmbeddedHeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 大小 {source.Length} 超出安全范围。");
        var nameOffset = ReadInt32(source, 0);
        var unk04 = ReadUInt16(source, 4);
        var unk06 = ReadUInt16(source, 6);
        var dataVersion = ReadUInt16(source, 8);
        var rowCount = ReadUInt16(source, 10);
        var formatFlags = ReadInt32(source, 0x2C);
        var layout = formatFlags is EmbeddedTypeNameFormatFlags or EmbeddedTypeNameCompactFormatFlags
            ? ParamLayout.EmbeddedTypeName
            : ParamLayout.LongOffsets;
        var headerSize = layout == ParamLayout.EmbeddedTypeName ? EmbeddedHeaderSize : LongHeaderSize;
        var rowHeaderSize = layout == ParamLayout.EmbeddedTypeName ? EmbeddedRowHeaderSize : LongRowHeaderSize;
        // rowCount is ushort (max 65535); MaxRows is a documentation bound for rebuild inputs.
        if (nameOffset <= 0 || nameOffset >= source.Length)
            throw new InvalidDataException("PARAM 名称区偏移无效。");
        var typeName = layout == ParamLayout.EmbeddedTypeName
            ? ReadAsciiZBounded(source, 0x0C, 0x20)
            : ReadAsciiZ(source, nameOffset);
        if (string.IsNullOrEmpty(typeName))
            throw new InvalidDataException("PARAM 类型名为空。");

        var rows = new List<ParamRow>(rowCount);
        if (rowCount == 0)
        {
            return new ParamNativeDocument(
                source,
                source.AsSpan(0, headerSize).ToArray(),
                dataVersion,
                unk04,
                unk06,
                typeName,
                0,
                layout,
                Array.Empty<byte>(),
                rows);
        }

        var tableEnd = checked(headerSize + rowCount * rowHeaderSize);
        var firstRowOffset = headerSize;
        var firstDataOffset = ReadInt32(
            source,
            firstRowOffset + (layout == ParamLayout.EmbeddedTypeName ? 4 : 8));
        if (firstDataOffset < tableEnd || firstDataOffset > nameOffset)
            throw new InvalidDataException("PARAM 首行数据偏移无效。");
        var dataGapBytes = source.AsSpan(tableEnd, firstDataOffset - tableEnd).ToArray();
        var rowDataSize = rowCount > 0 ? (nameOffset - firstDataOffset) / rowCount : 0;
        if (rowDataSize < 0 || firstDataOffset + rowCount * rowDataSize != nameOffset)
            throw new InvalidDataException($"PARAM 行数据大小不一致：rowDataSize={rowDataSize}。");

        for (var i = 0; i < rowCount; i++)
        {
            var o = headerSize + i * rowHeaderSize;
            var id = ReadInt32(source, o);
            int dataOff;
            int rowNameOff;
            if (layout == ParamLayout.EmbeddedTypeName)
            {
                dataOff = ReadInt32(source, o + 4);
                rowNameOff = ReadInt32(source, o + 8);
            }
            else
            {
                var pad0 = ReadInt32(source, o + 4);
                dataOff = ReadInt32(source, o + 8);
                var pad1 = ReadInt32(source, o + 12);
                rowNameOff = ReadInt32(source, o + 16);
                var pad2 = ReadInt32(source, o + 20);
                if (pad0 != 0 || pad1 != 0 || pad2 != 0)
                    throw new InvalidDataException($"PARAM 第 {i} 行头填充非零，拒绝猜测解析。");
            }
            if (dataOff != firstDataOffset + i * rowDataSize)
                throw new InvalidDataException($"PARAM 第 {i} 行 dataOffset 非紧凑布局。");
            var data = source.AsSpan(dataOff, rowDataSize).ToArray();
            string? rowName = null;
            byte[]? rowNameBytes = null;
            if (rowNameOff != 0)
            {
                if (rowNameOff < 0 || rowNameOff >= source.Length)
                    throw new InvalidDataException($"PARAM 第 {i} 行名称偏移越界。");
                rowNameBytes = ReadNullTerminatedBytes(source, rowNameOff);
                var parsedName = Encoding.ASCII.GetString(rowNameBytes);
                // Offsets that land on an empty C-string are treated as unnamed (common in Sekiro params).
                rowName = string.IsNullOrEmpty(parsedName) ? null : parsedName;
            }
            rows.Add(new ParamRow(id, data, rowName, rowNameBytes, dataOff));
        }

        return new ParamNativeDocument(
            source,
            source.AsSpan(0, headerSize).ToArray(),
            dataVersion,
            unk04,
            unk06,
            typeName,
            rowDataSize,
            layout,
            dataGapBytes,
            rows);
    }

    public static ParamNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("PARAM 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    public ParamRoundTripReport VerifyRoundTrip()
    {
        var rebuilt = Rebuild(Rows);
        var reparsed = Read(rebuilt);
        var equal = reparsed.Rows.Count == Rows.Count
            && reparsed.TypeName == TypeName
            && reparsed.RowDataSize == RowDataSize
            && reparsed.Rows.Zip(Rows).All(pair =>
                pair.First.Id == pair.Second.Id
                && pair.First.Data.AsSpan().SequenceEqual(pair.Second.Data)
                && pair.First.Name == pair.Second.Name
                && EqualOptionalBytes(pair.First.NameBytes, pair.Second.NameBytes));
        return new ParamRoundTripReport(
            SourceBytes.SequenceEqual(rebuilt),
            equal,
            SourceHash,
            Hash(rebuilt),
            FirstDifferenceOffset(SourceBytes, rebuilt),
            SourceBytes.Length,
            rebuilt.Length,
            Rows.Count,
            RowDataSize,
            TypeName);
    }

    public byte[] Rebuild(IReadOnlyList<ParamRow> nextRows)
    {
        if (nextRows.Count > MaxRows) throw new InvalidDataException("PARAM 行数超出安全上限。");
        foreach (var row in nextRows)
        {
            if (row.Data.Length != RowDataSize)
                throw new InvalidDataException($"PARAM 行 ID {row.Id} 数据长度 {row.Data.Length} 与行宽 {RowDataSize} 不一致。");
        }

        if (CanRewriteRowsInPlace(nextRows))
        {
            var rewritten = SourceBytes.ToArray();
            for (var index = 0; index < nextRows.Count; index++)
                nextRows[index].Data.CopyTo(rewritten, Rows[index].DataOffset);
            return rewritten;
        }

        var embeddedTypeName = Layout == ParamLayout.EmbeddedTypeName;
        var headerSize = embeddedTypeName ? EmbeddedHeaderSize : LongHeaderSize;
        var rowHeaderSize = embeddedTypeName ? EmbeddedRowHeaderSize : LongRowHeaderSize;
        var typeNameBytes = embeddedTypeName ? Array.Empty<byte>() : Encoding.ASCII.GetBytes(TypeName + "\0");
        var rowHeadersSize = nextRows.Count * rowHeaderSize;
        var rowDataTotal = nextRows.Count * RowDataSize;
        var tableEnd = headerSize + rowHeadersSize;
        var firstDataOffset = tableEnd + DataGapBytes.Length;
        var nameOffset = firstDataOffset + rowDataTotal;
        // Optional per-row names after type name.
        var rowNameOffsets = new int[nextRows.Count];
        var rowNameBytes = new List<byte[]>();
        var cursor = nameOffset + typeNameBytes.Length;
        for (var i = 0; i < nextRows.Count; i++)
        {
            if (string.IsNullOrEmpty(nextRows[i].Name) && nextRows[i].NameBytes is null)
            {
                rowNameOffsets[i] = 0;
                rowNameBytes.Add(Array.Empty<byte>());
                continue;
            }
            var rawName = nextRows[i].NameBytes?.ToArray() ?? EncodeAsciiName(nextRows[i].Name!);
            var encoded = new byte[rawName.Length + 1];
            rawName.CopyTo(encoded, 0);
            rowNameOffsets[i] = cursor;
            rowNameBytes.Add(encoded);
            cursor += encoded.Length;
        }
        var fileSize = cursor;
        var rebuilt = new byte[fileSize];
        // Preserve unknown header bytes, then overwrite known fields.
        HeaderPrefix.AsSpan(0, Math.Min(headerSize, HeaderPrefix.Length)).CopyTo(rebuilt);
        WriteInt32(rebuilt, 0, nameOffset);
        WriteUInt16(rebuilt, 4, Unk04);
        WriteUInt16(rebuilt, 6, Unk06);
        WriteUInt16(rebuilt, 8, DataVersion);
        WriteUInt16(rebuilt, 10, (ushort)nextRows.Count);
        if (!embeddedTypeName) WriteInt32(rebuilt, 0x10, nameOffset);
        DataGapBytes.CopyTo(rebuilt, tableEnd);

        for (var i = 0; i < nextRows.Count; i++)
        {
            var o = headerSize + i * rowHeaderSize;
            var dataOff = firstDataOffset + i * RowDataSize;
            WriteInt32(rebuilt, o, nextRows[i].Id);
            if (embeddedTypeName)
            {
                WriteInt32(rebuilt, o + 4, dataOff);
                WriteInt32(rebuilt, o + 8, rowNameOffsets[i]);
            }
            else
            {
                WriteInt32(rebuilt, o + 4, 0);
                WriteInt32(rebuilt, o + 8, dataOff);
                WriteInt32(rebuilt, o + 12, 0);
                WriteInt32(rebuilt, o + 16, rowNameOffsets[i]);
                WriteInt32(rebuilt, o + 20, 0);
            }
            nextRows[i].Data.CopyTo(rebuilt, dataOff);
        }
        typeNameBytes.CopyTo(rebuilt, nameOffset);
        for (var i = 0; i < nextRows.Count; i++)
        {
            if (rowNameOffsets[i] == 0) continue;
            rowNameBytes[i].CopyTo(rebuilt, rowNameOffsets[i]);
        }
        return rebuilt;
    }

    public byte[] ApplyMutations(IReadOnlyList<ParamPatch> patches)
    {
        var rows = Rows.Select(r => new ParamRow(
            r.Id,
            r.Data.ToArray(),
            r.Name,
            r.NameBytes?.ToArray(),
            r.DataOffset)).ToList();
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "upsert":
                {
                    if (patch.DataBase64 is null) throw new InvalidDataException("PARAM upsert 需要 dataBase64。");
                    var data = Convert.FromBase64String(patch.DataBase64);
                    if (data.Length != RowDataSize) throw new InvalidDataException("PARAM upsert 行宽不匹配。");
                    var idx = rows.FindIndex(r => r.Id == patch.Id);
                    var next = new ParamRow(
                        patch.Id,
                        data,
                        patch.Name ?? (idx >= 0 ? rows[idx].Name : null),
                        patch.Name is null && idx >= 0 ? rows[idx].NameBytes?.ToArray() : null,
                        idx >= 0 ? rows[idx].DataOffset : -1);
                    if (idx >= 0) rows[idx] = next; else rows.Add(next);
                    break;
                }
                case "delete":
                {
                    var before = rows.Count;
                    rows = rows.Where(r => r.Id != patch.Id).ToList();
                    if (rows.Count == before) throw new InvalidDataException($"PARAM 删除目标 ID {patch.Id} 不存在。");
                    break;
                }
                case "add":
                {
                    if (rows.Any(r => r.Id == patch.Id)) throw new InvalidDataException($"PARAM 新增 ID {patch.Id} 已存在。");
                    if (patch.DataBase64 is null) throw new InvalidDataException("PARAM add 需要 dataBase64。");
                    var data = Convert.FromBase64String(patch.DataBase64);
                    if (data.Length != RowDataSize) throw new InvalidDataException("PARAM add 行宽不匹配。");
                    rows.Add(new ParamRow(patch.Id, data, patch.Name, null, -1));
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

    public object ToEnvelope(
        ParamRoundTripReport? report = null,
        int rowOffset = 0,
        int rowLimit = 32,
        int? rowId = null,
        bool includePayloads = true)
    {
        if (rowOffset < 0)
            throw new InvalidDataException("PARAM read options: rowOffset 不能小于 0。");
        if (rowLimit < 1 || rowLimit > MaxRowPageSize)
            throw new InvalidDataException($"PARAM read options: rowLimit 必须在 1..{MaxRowPageSize}。");

        // Large params must be paged. A row-id filter is used by typed field
        // mutation so the caller never needs to fetch an unbounded table.
        var selectedRows = rowId.HasValue
            ? Rows.Where(row => row.Id == rowId.Value).Take(1).ToArray()
            : Rows.Skip(rowOffset).Take(rowLimit).ToArray();
        var selectedPayloadBytes = selectedRows.Sum(row => (long)row.Data.Length);
        var includePayload = includePayloads
            && selectedPayloadBytes <= MaxInlineRowPayloadBytes;
        var effectiveOffset = rowId.HasValue && selectedRows.Length > 0
            ? Rows.ToList().FindIndex(row => row.Id == rowId.Value)
            : rowOffset;
        return new
        {
            format = "PARAM",
            typeName = TypeName,
            dataVersion = DataVersion,
            rowCount = Rows.Count,
            rowDataSize = RowDataSize,
            layout = Layout == ParamLayout.EmbeddedTypeName ? "embedded-type-name-0x30-0x0c" : "long-offsets-0x40-0x18",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            rows = selectedRows.Select(r => new
            {
                r.Id,
                r.Name,
                dataBase64 = includePayload ? Convert.ToBase64String(r.Data) : null,
                dataHash = Hash(r.Data)
            }).ToArray(),
            rowOffset = effectiveOffset,
            rowLimit,
            rowFilterId = rowId,
            rowsReturned = selectedRows.Length,
            rowsTruncated = !rowId.HasValue && rowOffset + selectedRows.Length < Rows.Count,
            payloadsIncluded = includePayload,
            payloadOmissionReason = includePayloads && !includePayload
                ? $"selected-row-payloads-exceed-{MaxInlineRowPayloadBytes}-bytes"
                : null,
            roundTrip = report ?? VerifyRoundTrip(),
            authority = report is { SemanticIdentical: true } ? "native-verified" : "candidate",
            fieldLayout = "raw-row-bytes-without-paramdef"
        };
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

    private static byte[] ReadNullTerminatedBytes(byte[] source, int offset)
    {
        var end = offset;
        while (end < source.Length && source[end] != 0)
        {
            end++;
            if (end - offset > 4096) throw new InvalidDataException("PARAM 行名称过长。");
        }
        if (end >= source.Length) throw new InvalidDataException("PARAM 行名称未终止。");
        return source.AsSpan(offset, end - offset).ToArray();
    }

    private static byte[] EncodeAsciiName(string value)
    {
        if (value.Any(character => character > 0x7F))
            throw new InvalidDataException("PARAM 新行名称当前只允许 ASCII；现有非 ASCII 名称会按原始字节无损保留。");
        return Encoding.ASCII.GetBytes(value);
    }

    private static bool EqualOptionalBytes(byte[]? left, byte[]? right)
        => left is null ? right is null : right is not null && left.AsSpan().SequenceEqual(right);

    private bool CanRewriteRowsInPlace(IReadOnlyList<ParamRow> nextRows)
    {
        if (nextRows.Count != Rows.Count) return false;
        for (var index = 0; index < nextRows.Count; index++)
        {
            var before = Rows[index];
            var after = nextRows[index];
            if (before.Id != after.Id
                || before.Name != after.Name
                || !EqualOptionalBytes(before.NameBytes, after.NameBytes)
                || before.DataOffset < 0
                || before.DataOffset + after.Data.Length > SourceBytes.Length)
                return false;
        }
        return true;
    }

    private static int? FirstDifferenceOffset(byte[] left, byte[] right)
    {
        var sharedLength = Math.Min(left.Length, right.Length);
        for (var index = 0; index < sharedLength; index++)
        {
            if (left[index] != right[index]) return index;
        }
        return left.Length == right.Length ? null : sharedLength;
    }

    private static string ReadAsciiZBounded(byte[] source, int offset, int maxLength)
    {
        var limit = Math.Min(source.Length, checked(offset + maxLength));
        var end = offset;
        while (end < limit && source[end] != 0) end++;
        if (end == limit) throw new InvalidDataException("PARAM 固定类型名未在头部范围内终止。");
        return Encoding.ASCII.GetString(source, offset, end - offset);
    }

    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static ushort ReadUInt16(byte[] source, int offset) => BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt16(byte[] target, int offset, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal enum ParamLayout
{
    LongOffsets,
    EmbeddedTypeName
}

internal sealed record ParamRow(int Id, byte[] Data, string? Name, byte[]? NameBytes, int DataOffset);
internal sealed record ParamPatch(string Kind, int Id, string? DataBase64, string? Name);
internal sealed record ParamRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int? FirstDifferenceOffset,
    int SourceSize,
    int RebuiltSize,
    int RowCount,
    int RowDataSize,
    string TypeName);

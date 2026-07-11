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
    private const int HeaderSize = 0x40;
    private const int RowHeaderSize = 0x18;
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
        IReadOnlyList<ParamRow> rows)
    {
        SourceBytes = sourceBytes;
        HeaderPrefix = headerPrefix;
        DataVersion = dataVersion;
        Unk04 = unk04;
        Unk06 = unk06;
        TypeName = typeName;
        RowDataSize = rowDataSize;
        Rows = rows;
    }

    public byte[] SourceBytes { get; }
    public byte[] HeaderPrefix { get; }
    public ushort DataVersion { get; }
    public ushort Unk04 { get; }
    public ushort Unk06 { get; }
    public string TypeName { get; }
    public int RowDataSize { get; }
    public IReadOnlyList<ParamRow> Rows { get; }
    public string SourceHash => Hash(SourceBytes);

    public static ParamNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 大小 {source.Length} 超出安全范围。");
        var nameOffset = ReadInt32(source, 0);
        var unk04 = ReadUInt16(source, 4);
        var unk06 = ReadUInt16(source, 6);
        var dataVersion = ReadUInt16(source, 8);
        var rowCount = ReadUInt16(source, 10);
        // rowCount is ushort (max 65535); MaxRows is a documentation bound for rebuild inputs.
        if (nameOffset <= 0 || nameOffset >= source.Length)
            throw new InvalidDataException("PARAM 类型名偏移无效。");
        var typeName = ReadAsciiZ(source, nameOffset);
        if (string.IsNullOrEmpty(typeName))
            throw new InvalidDataException("PARAM 类型名为空。");

        var rows = new List<ParamRow>(rowCount);
        if (rowCount == 0)
        {
            return new ParamNativeDocument(source, source.AsSpan(0, HeaderSize).ToArray(), dataVersion, unk04, unk06, typeName, 0, rows);
        }

        var firstRowOffset = HeaderSize;
        var firstDataOffset = ReadInt32(source, firstRowOffset + 8);
        if (firstDataOffset < HeaderSize + rowCount * RowHeaderSize || firstDataOffset > nameOffset)
            throw new InvalidDataException("PARAM 首行数据偏移无效。");
        var rowDataSize = rowCount > 0 ? (nameOffset - firstDataOffset) / rowCount : 0;
        if (rowDataSize < 0 || firstDataOffset + rowCount * rowDataSize != nameOffset)
            throw new InvalidDataException($"PARAM 行数据大小不一致：rowDataSize={rowDataSize}。");

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
            if (rowNameOff != 0)
            {
                if (rowNameOff < 0 || rowNameOff >= source.Length)
                    throw new InvalidDataException($"PARAM 第 {i} 行名称偏移越界。");
                var parsedName = ReadAsciiZ(source, rowNameOff);
                // Offsets that land on an empty C-string are treated as unnamed (common in Sekiro params).
                rowName = string.IsNullOrEmpty(parsedName) ? null : parsedName;
            }
            rows.Add(new ParamRow(id, data, rowName));
        }

        return new ParamNativeDocument(
            source,
            source.AsSpan(0, HeaderSize).ToArray(),
            dataVersion,
            unk04,
            unk06,
            typeName,
            rowDataSize,
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
        if (nextRows.Count > MaxRows) throw new InvalidDataException("PARAM 行数超出安全上限。");
        foreach (var row in nextRows)
        {
            if (row.Data.Length != RowDataSize)
                throw new InvalidDataException($"PARAM 行 ID {row.Id} 数据长度 {row.Data.Length} 与行宽 {RowDataSize} 不一致。");
        }

        var typeNameBytes = Encoding.ASCII.GetBytes(TypeName + "\0");
        var rowHeadersSize = nextRows.Count * RowHeaderSize;
        var rowDataTotal = nextRows.Count * RowDataSize;
        var firstDataOffset = HeaderSize + rowHeadersSize;
        var nameOffset = firstDataOffset + rowDataTotal;
        // Optional per-row names after type name.
        var rowNameOffsets = new int[nextRows.Count];
        var rowNameBytes = new List<byte[]>();
        var cursor = nameOffset + typeNameBytes.Length;
        for (var i = 0; i < nextRows.Count; i++)
        {
            if (string.IsNullOrEmpty(nextRows[i].Name))
            {
                rowNameOffsets[i] = 0;
                rowNameBytes.Add(Array.Empty<byte>());
                continue;
            }
            var encoded = Encoding.ASCII.GetBytes(nextRows[i].Name! + "\0");
            rowNameOffsets[i] = cursor;
            rowNameBytes.Add(encoded);
            cursor += encoded.Length;
        }
        var fileSize = cursor;
        var rebuilt = new byte[fileSize];
        // Preserve unknown header bytes, then overwrite known fields.
        HeaderPrefix.AsSpan(0, Math.Min(HeaderSize, HeaderPrefix.Length)).CopyTo(rebuilt);
        WriteInt32(rebuilt, 0, nameOffset);
        WriteUInt16(rebuilt, 4, Unk04);
        WriteUInt16(rebuilt, 6, Unk06);
        WriteUInt16(rebuilt, 8, DataVersion);
        WriteUInt16(rebuilt, 10, (ushort)nextRows.Count);
        WriteInt32(rebuilt, 0x10, nameOffset);

        for (var i = 0; i < nextRows.Count; i++)
        {
            var o = HeaderSize + i * RowHeaderSize;
            var dataOff = firstDataOffset + i * RowDataSize;
            WriteInt32(rebuilt, o, nextRows[i].Id);
            WriteInt32(rebuilt, o + 4, 0);
            WriteInt32(rebuilt, o + 8, dataOff);
            WriteInt32(rebuilt, o + 12, 0);
            WriteInt32(rebuilt, o + 16, rowNameOffsets[i]);
            WriteInt32(rebuilt, o + 20, 0);
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
        var rows = Rows.Select(r => new ParamRow(r.Id, r.Data.ToArray(), r.Name)).ToList();
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
                    var next = new ParamRow(patch.Id, data, patch.Name ?? (idx >= 0 ? rows[idx].Name : null));
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
                    rows.Add(new ParamRow(patch.Id, data, patch.Name));
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

    public object ToEnvelope(ParamRoundTripReport? report = null, int rowPreviewLimit = 32)
    {
        // Large params (multi-MB / wide rows) must not dump payloads into one NDJSON frame.
        var includePayload = RowDataSize > 0 && RowDataSize <= 256 && Rows.Count <= rowPreviewLimit;
        return new
        {
            format = "PARAM",
            typeName = TypeName,
            dataVersion = DataVersion,
            rowCount = Rows.Count,
            rowDataSize = RowDataSize,
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            rows = Rows.Take(Math.Max(0, rowPreviewLimit)).Select(r => new
            {
                r.Id,
                r.Name,
                dataBase64 = includePayload ? Convert.ToBase64String(r.Data) : null,
                dataHash = Hash(r.Data)
            }).ToArray(),
            rowPreviewLimit,
            rowsTruncated = Rows.Count > rowPreviewLimit,
            payloadsIncluded = includePayload,
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

    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static ushort ReadUInt16(byte[] source, int offset) => BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt16(byte[] target, int offset, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record ParamRow(int Id, byte[] Data, string? Name);
internal sealed record ParamPatch(string Kind, int Id, string? DataBase64, string? Name);
internal sealed record ParamRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int RowCount,
    int RowDataSize,
    string TypeName);

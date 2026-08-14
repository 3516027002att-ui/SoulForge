using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Native PARAM layout families handled losslessly by the Bridge.
/// </summary>
internal enum ParamLayout
{
    /// <summary>Sekiro regulation-style: type name at file end (header 0x40, row headers 0x18).</summary>
    Compact,
    /// <summary>
    /// Old gameparam-default style (default_AIStandardInfoBank / default_EnemyBehaviorBank /
    /// MenuColorTableParam): embedded ASCII type name at header 0x0C, (rowCount-1) row headers of
    /// 12 bytes [dataEndOffset, nameOffset, id], a variable zero tail before the data region,
    /// fixed-size data rows and a verbatim Shift-JIS name region at the end. The last data row has
    /// no row header (its id/name are not stored). Layout rules derived from and verified against
    /// the private gameparam.parambnd.dcx corpus (index 32/33/81).
    /// </summary>
    Legacy
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
    private const int LegacyRowHeaderSize = 0x0C;
    private const int MaxRows = 500_000;
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private const int MaxNameBytes = 512;

    private static readonly Encoding ShiftJisEncoding = CreateShiftJisEncoding();

    private readonly int[] _legacyNameOffsets = Array.Empty<int>();
    private readonly byte[] _legacyTail = Array.Empty<byte>();
    private readonly byte[] _legacyNameRegion = Array.Empty<byte>();

    private ParamNativeDocument(
        byte[] sourceBytes,
        byte[] headerPrefix,
        ushort dataVersion,
        ushort unk04,
        ushort unk06,
        string typeName,
        int rowDataSize,
        IReadOnlyList<ParamRow> rows)
        : this(sourceBytes, headerPrefix, dataVersion, unk04, unk06, typeName, rowDataSize, rows,
            ParamLayout.Compact, Array.Empty<int>(), Array.Empty<byte>(), Array.Empty<byte>())
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
        int[] legacyNameOffsets,
        byte[] legacyTail,
        byte[] legacyNameRegion)
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
        _legacyNameOffsets = legacyNameOffsets;
        _legacyTail = legacyTail;
        _legacyNameRegion = legacyNameRegion;
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

    public static ParamNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize + 4 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"PARAM 大小 {source.Length} 超出安全范围。");
        var embeddedName = TryReadEmbeddedName(source);
        if (embeddedName is not null)
            return ReadLegacy(source, embeddedName);
        return ReadCompact(source);
    }

    private static ParamNativeDocument ReadCompact(byte[] source)
    {
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
            rows.Add(new ParamRow(id, data, rowName, rowNameBytes, rowNameEncoding));
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

    private static ParamNativeDocument ReadLegacy(byte[] source, string embeddedName)
    {
        var nameDataStart = ReadInt32(source, 0);
        var dataStart = ReadUInt16(source, 4);
        var unk06 = ReadUInt16(source, 6);
        var dataVersion = ReadUInt16(source, 8);
        var rowCount = ReadUInt16(source, 10);
        if (string.IsNullOrEmpty(embeddedName))
            throw new InvalidDataException("PARAM 旧布局类型名为空。");
        if (dataStart < HeaderSize || nameDataStart < dataStart || nameDataStart > source.Length)
            throw new InvalidDataException($"PARAM 旧布局区段偏移无效：dataStart={dataStart}，nameDataStart={nameDataStart}。");

        var rows = new List<ParamRow>(rowCount);
        var nameOffsets = new int[rowCount];
        if (rowCount == 0)
        {
            var emptyTail = source.AsSpan(HeaderSize, dataStart - HeaderSize).ToArray();
            var emptyNameRegion = source.AsSpan(nameDataStart, source.Length - nameDataStart).ToArray();
            return new ParamNativeDocument(source, source.AsSpan(0, HeaderSize).ToArray(), dataVersion, dataStart, unk06,
                embeddedName, 0, rows, ParamLayout.Legacy, nameOffsets, emptyTail, emptyNameRegion);
        }

        var rowDataSize = (nameDataStart - dataStart) / rowCount;
        if (rowDataSize <= 0 || rowDataSize * rowCount != nameDataStart - dataStart)
            throw new InvalidDataException($"PARAM 旧布局行数据大小不一致：rowDataSize={rowDataSize}。");

        // Row headers: rows 0..rowCount-2 carry one 12-byte header each; the last data row is the
        // headerless default row (id/name not stored). A variable zero tail (possibly absent or, in
        // MenuColorTableParam, overlapping the data region by up to one header) separates the header
        // region from the data region.
        var headerEnd = HeaderSize + (rowCount - 1) * LegacyRowHeaderSize;
        var tailLen = dataStart - headerEnd;
        if (tailLen < -LegacyRowHeaderSize)
            throw new InvalidDataException($"PARAM 旧布局行头区与数据区重叠超出单行头宽度：tail={tailLen}。");
        if (tailLen > 0)
        {
            for (var p = headerEnd; p < dataStart; p++)
            {
                if (source[p] != 0)
                    throw new InvalidDataException($"PARAM 旧布局行头区尾部非零，拒绝猜测解析。");
            }
        }

        for (var i = 0; i < rowCount; i++)
        {
            var dataOff = dataStart + i * rowDataSize;
            rows.Add(new ParamRow(0, source.AsSpan(dataOff, rowDataSize).ToArray(), null, null, null));
        }

        for (var k = 0; k < rowCount - 1; k++)
        {
            var o = HeaderSize + k * LegacyRowHeaderSize;
            var dataEnd = ReadInt32(source, o);
            var nameOff = ReadInt32(source, o + 4);
            var id = ReadInt32(source, o + 8);
            if (dataEnd != dataStart + (k + 1) * rowDataSize)
                throw new InvalidDataException($"PARAM 旧布局第 {k} 行 dataEnd 非紧凑布局。");
            string? name = null;
            if (nameOff != 0)
            {
                if (nameOff < nameDataStart || nameOff >= source.Length)
                    throw new InvalidDataException($"PARAM 旧布局第 {k} 行名称偏移越界。");
                name = DecodeShiftJisName(source, nameOff);
                nameOffsets[k] = nameOff;
            }
            rows[k] = new ParamRow(id, rows[k].Data, name, null, null);
        }

        var tail = tailLen > 0 ? source.AsSpan(headerEnd, tailLen).ToArray() : Array.Empty<byte>();
        var nameRegion = source.AsSpan(nameDataStart, source.Length - nameDataStart).ToArray();
        return new ParamNativeDocument(source, source.AsSpan(0, HeaderSize).ToArray(), dataVersion, dataStart, unk06,
            embeddedName, rowDataSize, rows, ParamLayout.Legacy, nameOffsets, tail, nameRegion);
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
        return Layout == ParamLayout.Legacy
            ? RebuildLegacy(nextRows)
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
        var firstDataOffset = HeaderSize + rowHeadersSize;
        var nameOffset = firstDataOffset + rowDataTotal;
        // Optional per-row names after type name.
        var rowNameOffsets = new int[nextRows.Count];
        var rowNameBytes = new List<byte[]>();
        var cursor = nameOffset + typeNameBytes.Length;
        for (var i = 0; i < nextRows.Count; i++)
        {
            var name = nextRows[i].Name;
            if (string.IsNullOrEmpty(name))
            {
                rowNameOffsets[i] = 0;
                rowNameBytes.Add(Array.Empty<byte>());
                continue;
            }
            var encoded = EncodeParamRowName(name!, nextRows[i].NameBytes, nextRows[i].NameEncoding);
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

    private byte[] RebuildLegacy(IReadOnlyList<ParamRow> nextRows)
    {
        if (nextRows.Count > MaxRows) throw new InvalidDataException("PARAM 行数超出安全上限。");
        if (nextRows.Count != Rows.Count)
            throw new InvalidDataException("PARAM 旧布局行数不可变更：add/delete 会破坏无行头末行与可变尾部的无损性。");
        foreach (var row in nextRows)
        {
            if (row.Data.Length != RowDataSize)
                throw new InvalidDataException($"PARAM 行 ID {row.Id} 数据长度 {row.Data.Length} 与行宽 {RowDataSize} 不一致。");
        }

        var n = nextRows.Count;
        var dataStart = Unk04;
        // For the zero-row edge the name region offset comes straight from the source header;
        // otherwise it follows the recomputed data region.
        var nameDataStart = n == 0
            ? ReadInt32(SourceBytes, 0)
            : dataStart + n * RowDataSize;
        var headerEnd = HeaderSize + Math.Max(0, n - 1) * LegacyRowHeaderSize;
        var fileSize = nameDataStart + _legacyNameRegion.Length;
        var rebuilt = new byte[fileSize];
        // Preserve the full 0x40 header verbatim, then overwrite the layout-defining fields.
        HeaderPrefix.AsSpan(0, Math.Min(HeaderSize, HeaderPrefix.Length)).CopyTo(rebuilt);
        WriteInt32(rebuilt, 0, nameDataStart);
        WriteUInt16(rebuilt, 4, (ushort)dataStart);
        WriteUInt16(rebuilt, 6, Unk06);
        WriteUInt16(rebuilt, 8, DataVersion);
        WriteUInt16(rebuilt, 10, (ushort)n);
        WriteInt32(rebuilt, 0x34, dataStart);
        WriteInt32(rebuilt, 0x38, nameDataStart);

        for (var k = 0; k < n - 1; k++)
        {
            var o = HeaderSize + k * LegacyRowHeaderSize;
            WriteInt32(rebuilt, o, dataStart + (k + 1) * RowDataSize);
            WriteInt32(rebuilt, o + 4, _legacyNameOffsets[k]);
            WriteInt32(rebuilt, o + 8, nextRows[k].Id);
        }
        _legacyTail.CopyTo(rebuilt, headerEnd);
        for (var i = 0; i < n; i++)
        {
            nextRows[i].Data.CopyTo(rebuilt, dataStart + i * RowDataSize);
        }
        _legacyNameRegion.CopyTo(rebuilt, nameDataStart);
        return rebuilt;
    }

    public byte[] ApplyMutations(IReadOnlyList<ParamPatch> patches)
    {
        return Layout == ParamLayout.Legacy
            ? ApplyLegacyMutations(patches)
            : ApplyCompactMutations(patches);
    }

    private byte[] ApplyCompactMutations(IReadOnlyList<ParamPatch> patches)
    {
        var rows = Rows.Select(r => new ParamRow(r.Id, r.Data.ToArray(), r.Name, r.NameBytes, r.NameEncoding)).ToList();
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
                    var prev = idx >= 0 ? rows[idx] : null;
                    var nextName = patch.Name ?? prev?.Name;
                    // 名称未被 patch 修改（或补丁未带 name）时保留原始字节，保证无修改往返字节一致。
                    var keepOriginal = prev is not null && string.Equals(nextName, prev.Name, StringComparison.Ordinal);
                    var next = new ParamRow(
                        patch.Id,
                        data,
                        nextName,
                        keepOriginal ? prev!.NameBytes : null,
                        keepOriginal ? prev!.NameEncoding : prev?.NameEncoding);
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

    private byte[] ApplyLegacyMutations(IReadOnlyList<ParamPatch> patches)
    {
        var rows = Rows.Select(r => new ParamRow(r.Id, r.Data.ToArray(), r.Name, r.NameBytes, r.NameEncoding)).ToList();
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
                    if (idx < 0)
                        throw new InvalidDataException($"PARAM 旧布局不支持新增行 upsert：ID {patch.Id} 不存在且无行头可无损新增。");
                    if (patch.Name is not null && patch.Name != rows[idx].Name)
                        throw new InvalidDataException("PARAM 旧布局不支持行名变更（名称区按字节保留）。");
                    rows[idx] = new ParamRow(patch.Id, data, rows[idx].Name, null, null);
                    break;
                }
                case "delete":
                    throw new InvalidDataException("PARAM 旧布局不支持 delete：无行头末行与可变尾部无法无损删除。");
                case "add":
                    throw new InvalidDataException("PARAM 旧布局不支持 add：末行无行头，新增行无法无损落位。");
                default:
                    throw new InvalidDataException($"未知 PARAM mutation：{patch.Kind}。");
            }
        }
        return Rebuild(rows);
    }

    public object ToEnvelope(ParamRoundTripReport? report = null, int rowPreviewLimit = 32, int rowPage = 0, int rowPageSize = 0, bool includeAllPayloads = false)
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

        // Pagination: when rowPageSize > 0, return only the requested page.
        var effectivePageSize = rowPageSize > 0 ? rowPageSize : totalRows;
        var pageCount = effectivePageSize > 0 ? (int)Math.Ceiling((double)totalRows / effectivePageSize) : 1;
        var clampedPage = Math.Clamp(rowPage, 0, Math.Max(0, pageCount - 1));
        var skip = clampedPage * effectivePageSize;
        var pageRows = Rows.Skip(skip).Take(effectivePageSize).ToArray();
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
            layout = Layout == ParamLayout.Legacy ? "legacy" : "compact",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            rows = pageRows.Select(r => new
            {
                r.Id,
                r.Name,
                dataBase64 = pageIncludePayload ? Convert.ToBase64String(r.Data) : null,
                dataHash = Hash(r.Data)
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

    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static ushort ReadUInt16(byte[] source, int offset) => BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt16(byte[] target, int offset, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record ParamRow(int Id, byte[] Data, string? Name, byte[]? NameBytes, string? NameEncoding);
internal sealed record ParamPatch(string Kind, int Id, string? DataBase64, string? Name);
internal sealed record ParamRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int RowCount,
    int RowDataSize,
    string TypeName);

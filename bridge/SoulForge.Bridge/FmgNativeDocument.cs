using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Sekiro-era FMG version 2 (marker 0x00020000) lossless document.
/// Layout derived from private DFLT msgbnd.dcx corpus; no third-party parser dependency.
/// </summary>
internal sealed class FmgNativeDocument
{
    private const int HeaderSize = 0x28;
    private const int GroupSize = 0x10;
    private const int MaxEntries = 200_000;
    private const int MaxSourceBytes = 32 * 1024 * 1024;

    private FmgNativeDocument(
        byte[] sourceBytes,
        int versionMarker,
        int unk1,
        int unk2,
        IReadOnlyList<FmgGroup> groups,
        IReadOnlyList<FmgEntry> entries,
        int reserved0,
        int reserved1,
        int reserved2)
    {
        SourceBytes = sourceBytes;
        VersionMarker = versionMarker;
        Unk1 = unk1;
        Unk2 = unk2;
        Groups = groups;
        Entries = entries;
        Reserved0 = reserved0;
        Reserved1 = reserved1;
        Reserved2 = reserved2;
    }

    public byte[] SourceBytes { get; }
    public int VersionMarker { get; }
    public int Unk1 { get; }
    public int Unk2 { get; }
    public int Reserved0 { get; }
    public int Reserved1 { get; }
    public int Reserved2 { get; }
    public IReadOnlyList<FmgGroup> Groups { get; }
    public IReadOnlyList<FmgEntry> Entries { get; }
    public string SourceHash => Hash(SourceBytes);

    public static FmgNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"FMG 大小 {source.Length} 超出安全范围。");
        var versionMarker = ReadInt32(source, 0);
        if (versionMarker != 0x00020000)
            throw new NotSupportedException($"不支持的 FMG 版本标记 0x{versionMarker:X8}；当前仅支持 Sekiro v2 (0x00020000)。");
        var declaredSize = ReadInt32(source, 4);
        if (declaredSize != source.Length)
            throw new InvalidDataException($"FMG 声明大小 {declaredSize} 与实际 {source.Length} 不一致。");
        var unk1 = ReadInt32(source, 8);
        var groupCount = ReadInt32(source, 12);
        var stringCount = ReadInt32(source, 16);
        var unk2 = ReadInt32(source, 20);
        var stringOffsetsOffset = ReadInt32(source, 24);
        var reserved0 = ReadInt32(source, 28);
        var reserved1 = ReadInt32(source, 32);
        var reserved2 = ReadInt32(source, 36);
        if (groupCount < 0 || groupCount > MaxEntries || stringCount < 0 || stringCount > MaxEntries)
            throw new InvalidDataException($"FMG 组/字符串数量越界：groups={groupCount}, strings={stringCount}。");
        var groupsEnd = checked(HeaderSize + groupCount * GroupSize);
        if (stringOffsetsOffset < groupsEnd || stringOffsetsOffset > source.Length)
            throw new InvalidDataException("FMG stringOffsetsOffset 越界。");
        if (stringOffsetsOffset + (long)stringCount * 4 > source.Length)
            throw new InvalidDataException("FMG 字符串偏移表越界。");

        var groups = new List<FmgGroup>(groupCount);
        for (var i = 0; i < groupCount; i++)
        {
            var o = HeaderSize + i * GroupSize;
            var offsetIndex = ReadInt32(source, o);
            var firstId = ReadInt32(source, o + 4);
            var lastId = ReadInt32(source, o + 8);
            var groupUnk = ReadInt32(source, o + 12);
            if (lastId < firstId) throw new InvalidDataException($"FMG 组 {i} 的 ID 范围无效。");
            var count = checked(lastId - firstId + 1);
            if (offsetIndex < 0 || offsetIndex + count > stringCount)
                throw new InvalidDataException($"FMG 组 {i} 的 offsetIndex 越界。");
            groups.Add(new FmgGroup(offsetIndex, firstId, lastId, groupUnk));
        }

        var offsets = new int[stringCount];
        for (var i = 0; i < stringCount; i++)
            offsets[i] = ReadInt32(source, stringOffsetsOffset + i * 4);

        var entries = new List<FmgEntry>(stringCount);
        var covered = new bool[stringCount];
        // Sekiro FMG may repeat the same ID across groups (often one empty + one real slot).
        // Preserve every slot for lossless rebuild; semantic lookups use last-wins.
        foreach (var group in groups)
        {
            for (var id = group.FirstId; id <= group.LastId; id++)
            {
                var index = group.OffsetIndex + (id - group.FirstId);
                covered[index] = true;
                var offset = offsets[index];
                string text;
                if (offset == 0) text = string.Empty;
                else
                {
                    if (offset < 0 || offset + 2 > source.Length)
                        throw new InvalidDataException($"FMG 字符串偏移 {offset} 越界。");
                    text = ReadUtf16Z(source, offset);
                }
                entries.Add(new FmgEntry(id, text, index, offset));
            }
        }
        for (var i = 0; i < stringCount; i++)
        {
            if (!covered[i])
                throw new InvalidDataException($"FMG 字符串槽 {i} 未被任何组覆盖。");
        }
        entries.Sort((left, right) => left.StringIndex.CompareTo(right.StringIndex));

        return new FmgNativeDocument(source, versionMarker, unk1, unk2, groups, entries, reserved0, reserved1, reserved2);
    }

    public static FmgNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("FMG 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"FMG 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    public FmgRoundTripReport VerifyRoundTrip()
    {
        var rebuilt = Rebuild(Entries.Select(e => new FmgMutationEntry(e.Id, e.Text)).ToList());
        var reparsed = Read(rebuilt);
        var entriesEqual = reparsed.Entries.Count == Entries.Count
            && reparsed.Entries.Zip(Entries).All(pair => pair.First.Id == pair.Second.Id && pair.First.Text == pair.Second.Text);
        var lastWinsEqual = LastWinsMap(Entries).OrderBy(kv => kv.Key)
            .SequenceEqual(LastWinsMap(reparsed.Entries).OrderBy(kv => kv.Key));
        return new FmgRoundTripReport(
            SourceBytes.SequenceEqual(rebuilt),
            entriesEqual && lastWinsEqual,
            SourceHash,
            Hash(rebuilt),
            Entries.Count,
            Groups.Count);
    }

    private static Dictionary<int, string> LastWinsMap(IEnumerable<FmgEntry> entries)
    {
        var map = new Dictionary<int, string>();
        foreach (var entry in entries) map[entry.Id] = entry.Text;
        return map;
    }

    public byte[] Rebuild(IReadOnlyList<FmgMutationEntry> nextEntries)
    {
        if (nextEntries.Count > MaxEntries) throw new InvalidDataException("FMG 条目数量超出安全上限。");
        // Preserve caller order (string-slot order). Duplicate IDs are allowed and become separate groups.
        var ordered = nextEntries.ToList();

        // Coalesce only strictly ascending consecutive IDs; identical adjacent IDs stay split.
        var groupUnkByFirstId = new Dictionary<int, int>();
        foreach (var group in Groups)
        {
            groupUnkByFirstId.TryAdd(group.FirstId, group.Unk);
        }

        var groups = new List<FmgGroup>();
        if (ordered.Count > 0)
        {
            var start = 0;
            while (start < ordered.Count)
            {
                var end = start;
                while (end + 1 < ordered.Count && ordered[end + 1].Id == ordered[end].Id + 1)
                    end++;
                var firstId = ordered[start].Id;
                var lastId = ordered[end].Id;
                var unk = groupUnkByFirstId.TryGetValue(firstId, out var u) ? u : 0;
                groups.Add(new FmgGroup(start, firstId, lastId, unk));
                start = end + 1;
            }
        }

        // Encode strings; offset 0 means empty.
        var stringBytes = new List<byte[]>();
        var offsets = new int[ordered.Count];
        // Placeholder; filled after layout known.
        var headerAndTables = HeaderSize + groups.Count * GroupSize + ordered.Count * 4;
        // Align string pool start to 2 for UTF-16.
        var stringPoolStart = headerAndTables;
        if ((stringPoolStart & 1) != 0) stringPoolStart++;

        var cursor = stringPoolStart;
        for (var i = 0; i < ordered.Count; i++)
        {
            var text = ordered[i].Text ?? string.Empty;
            if (text.Length == 0)
            {
                offsets[i] = 0;
                stringBytes.Add(Array.Empty<byte>());
                continue;
            }
            var encoded = Encoding.Unicode.GetBytes(text + "\0");
            offsets[i] = cursor;
            stringBytes.Add(encoded);
            cursor = checked(cursor + encoded.Length);
        }

        var fileSize = cursor;
        var rebuilt = new byte[fileSize];
        WriteInt32(rebuilt, 0, VersionMarker);
        WriteInt32(rebuilt, 4, fileSize);
        WriteInt32(rebuilt, 8, Unk1);
        WriteInt32(rebuilt, 12, groups.Count);
        WriteInt32(rebuilt, 16, ordered.Count);
        WriteInt32(rebuilt, 20, Unk2);
        var stringOffsetsOffset = HeaderSize + groups.Count * GroupSize;
        WriteInt32(rebuilt, 24, stringOffsetsOffset);
        WriteInt32(rebuilt, 28, Reserved0);
        WriteInt32(rebuilt, 32, Reserved1);
        WriteInt32(rebuilt, 36, Reserved2);

        for (var g = 0; g < groups.Count; g++)
        {
            var group = groups[g];
            var o = HeaderSize + g * GroupSize;
            WriteInt32(rebuilt, o, group.OffsetIndex);
            WriteInt32(rebuilt, o + 4, group.FirstId);
            WriteInt32(rebuilt, o + 8, group.LastId);
            WriteInt32(rebuilt, o + 12, group.Unk);
        }
        for (var i = 0; i < ordered.Count; i++)
            WriteInt32(rebuilt, stringOffsetsOffset + i * 4, offsets[i]);
        for (var i = 0; i < ordered.Count; i++)
        {
            if (offsets[i] == 0) continue;
            stringBytes[i].CopyTo(rebuilt, offsets[i]);
        }
        return rebuilt;
    }

    public byte[] ApplyMutations(IReadOnlyList<FmgPatch> patches)
    {
        // Work on ordered slots so duplicate IDs stay addressable; last-wins for upsert by id.
        var slots = Entries.Select(e => new FmgMutationEntry(e.Id, e.Text)).ToList();
        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "upsert":
                {
                    var updated = false;
                    for (var i = 0; i < slots.Count; i++)
                    {
                        if (slots[i].Id != patch.Id) continue;
                        slots[i] = new FmgMutationEntry(patch.Id, patch.Text ?? string.Empty);
                        updated = true;
                    }
                    if (!updated) slots.Add(new FmgMutationEntry(patch.Id, patch.Text ?? string.Empty));
                    break;
                }
                case "delete":
                {
                    var before = slots.Count;
                    slots = slots.Where(s => s.Id != patch.Id).ToList();
                    if (slots.Count == before)
                        throw new InvalidDataException($"FMG 删除目标 ID {patch.Id} 不存在。");
                    break;
                }
                case "add":
                    if (slots.Any(s => s.Id == patch.Id))
                        throw new InvalidDataException($"FMG 新增 ID {patch.Id} 已存在。");
                    slots.Add(new FmgMutationEntry(patch.Id, patch.Text ?? string.Empty));
                    break;
                default:
                    throw new InvalidDataException($"未知 FMG mutation：{patch.Kind}。");
            }
        }
        return Rebuild(slots);
    }

    public object ToEnvelope(FmgRoundTripReport? report = null) => new
    {
        format = "FMG",
        versionMarker = VersionMarker,
        version = 2,
        sourceSize = SourceBytes.Length,
        sourceHash = SourceHash,
        groupCount = Groups.Count,
        entryCount = Entries.Count,
        unk1 = Unk1,
        unk2 = Unk2,
        entries = Entries.Select(e => new { e.Id, e.Text, e.StringIndex, e.SourceOffset }).ToArray(),
        groups = Groups.Select(g => new { g.OffsetIndex, g.FirstId, g.LastId, g.Unk }).ToArray(),
        roundTrip = report ?? VerifyRoundTrip(),
        authority = report is { SemanticIdentical: true } ? "native-verified" : "candidate"
    };

    private static string ReadUtf16Z(byte[] source, int offset)
    {
        var end = offset;
        while (end + 1 < source.Length && !(source[end] == 0 && source[end + 1] == 0))
        {
            end += 2;
            if (end - offset > 1024 * 1024) throw new InvalidDataException("FMG 字符串未终止或过长。");
        }
        if (end + 1 >= source.Length) throw new InvalidDataException("FMG 字符串未以 UTF-16 空终止。");
        return Encoding.Unicode.GetString(source, offset, end - offset);
    }

    private static int ReadInt32(byte[] source, int offset) => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static void WriteInt32(byte[] target, int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record FmgGroup(int OffsetIndex, int FirstId, int LastId, int Unk);
internal sealed record FmgEntry(int Id, string Text, int StringIndex, int SourceOffset);
internal sealed record FmgMutationEntry(int Id, string Text);
internal sealed record FmgPatch(string Kind, int Id, string? Text);
internal sealed record FmgRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int EntryCount,
    int GroupCount);

using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

/// <summary>
/// FromSoftware *.luabnd / *.luabnd.dcx 专有解析与处理模块。
/// 解析 BND4 容器内部的 Lua AI 脚本、.luagnl 全局符号名列表与 .luainfo 目标元数据。
/// </summary>
internal sealed class LuabndNativeDocument
{
    private LuabndNativeDocument(
        string sourcePath,
        string dcxCompressionFormat,
        byte[] sourceBytes,
        byte[] payloadBytes,
        Bnd4NativeDocument binder,
        IReadOnlyList<LuabndScriptItem> scripts,
        LuagnlDocument? gnl,
        Bnd4Entry? gnlEntry,
        LuainfoDocument? info,
        Bnd4Entry? infoEntry)
    {
        SourcePath = sourcePath;
        DcxCompressionFormat = dcxCompressionFormat;
        SourceBytes = sourceBytes;
        PayloadBytes = payloadBytes;
        Binder = binder;
        Scripts = scripts;
        Gnl = gnl;
        GnlEntry = gnlEntry;
        Info = info;
        InfoEntry = infoEntry;
    }

    public string SourcePath { get; }
    public string DcxCompressionFormat { get; }
    public byte[] SourceBytes { get; }
    public byte[] PayloadBytes { get; }
    public Bnd4NativeDocument Binder { get; }
    public IReadOnlyList<LuabndScriptItem> Scripts { get; }
    public LuagnlDocument? Gnl { get; }
    public Bnd4Entry? GnlEntry { get; }
    public LuainfoDocument? Info { get; }
    public Bnd4Entry? InfoEntry { get; }

    public string SourceHash => Hash(SourceBytes);
    public string PayloadHash => Hash(PayloadBytes);
    public int EntryCount => Binder.Entries.Count;
    public int ScriptCount => Scripts.Count;
    public bool HasGnl => Gnl != null;
    public bool HasInfo => Info != null;

    public static LuabndNativeDocument Read(string filePath, string? oodleRuntimeRoot = null)
    {
        if (!File.Exists(filePath))
            throw new FileNotFoundException($"文件不存在: {filePath}", filePath);

        var fileBytes = File.ReadAllBytes(filePath);
        return ReadBytes(fileBytes, filePath, oodleRuntimeRoot);
    }

    public static LuabndNativeDocument ReadBytes(byte[] sourceBytes, string sourcePath = "memory.luabnd.dcx", string? oodleRuntimeRoot = null)
    {
        string compressionFormat = "None";
        byte[] payloadBytes;

        if (sourceBytes.Length >= 4 && sourceBytes.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
        {
            var dcx = DcxNativeDocument.Read(sourceBytes, oodleRuntimeRoot, sourcePath);
            compressionFormat = dcx.CompressionFormat;
            payloadBytes = dcx.Payload;
        }
        else
        {
            payloadBytes = sourceBytes;
        }

        if (payloadBytes.Length < 4 || !payloadBytes.AsSpan(0, 4).SequenceEqual("BND4"u8))
        {
            throw new InvalidDataException("解压后的载荷不是有效 BND4 容器。");
        }

        var binder = Bnd4NativeDocument.Read(payloadBytes);
        var scripts = new List<LuabndScriptItem>();
        LuagnlDocument? gnl = null;
        Bnd4Entry? gnlEntry = null;
        LuainfoDocument? info = null;
        Bnd4Entry? infoEntry = null;

        for (var i = 0; i < binder.Entries.Count; i++)
        {
            var entry = binder.Entries[i];
            var lowerName = entry.Name.ToLowerInvariant();
            var sanitizedName = SanitizeEntryBasename(entry.Name);
            var storedBytes = binder.GetStoredBytes(i);

            if (lowerName.EndsWith(".lua", StringComparison.Ordinal) || lowerName.EndsWith(".hks", StringComparison.Ordinal))
            {
                var inspection = LuaScriptInspector.Inspect(storedBytes, sanitizedName);
                scripts.Add(new LuabndScriptItem(
                    entry.Index,
                    entry.Id,
                    entry.Name,
                    sanitizedName,
                    storedBytes.Length,
                    entry.UncompressedSize,
                    entry.ContentHash,
                    inspection.IsBytecode,
                    inspection.Magic,
                    inspection.Variant,
                    inspection.IsPlainText,
                    inspection.HeaderHex,
                    inspection.EmbeddedSymbols.Take(16).ToArray()));
            }
            else if (lowerName.EndsWith(".luagnl", StringComparison.Ordinal))
            {
                gnlEntry = entry;
                try
                {
                    gnl = LuagnlParser.Parse(storedBytes);
                }
                catch (Exception ex) when (ex is InvalidDataException or ArgumentException)
                {
                    gnl = new LuagnlDocument(Array.Empty<string>(), false, "error: " + ex.Message);
                }
            }
            else if (lowerName.EndsWith(".luainfo", StringComparison.Ordinal))
            {
                infoEntry = entry;
                try
                {
                    info = LuainfoParser.Parse(storedBytes);
                }
                catch (Exception ex) when (ex is InvalidDataException or ArgumentException)
                {
                    info = new LuainfoDocument(Array.Empty<LuainfoGoal>(), false, "error: " + ex.Message);
                }
            }
        }

        return new LuabndNativeDocument(
            sourcePath,
            compressionFormat,
            sourceBytes,
            payloadBytes,
            binder,
            scripts,
            gnl,
            gnlEntry,
            info,
            infoEntry);
    }

    public LuabndScriptDetail ReadScript(string childPathOrIndex)
    {
        var entryIndex = ResolveScriptIndex(childPathOrIndex);
        var entry = Binder.Entries[entryIndex];
        var storedBytes = Binder.GetStoredBytes(entryIndex);
        var sanitizedName = SanitizeEntryBasename(entry.Name);
        var inspection = LuaScriptInspector.Inspect(storedBytes, sanitizedName);

        return new LuabndScriptDetail(
            SourcePath,
            SourceHash,
            PayloadHash,
            entry.Index,
            entry.Id,
            entry.Name,
            sanitizedName,
            storedBytes.Length,
            entry.UncompressedSize,
            entry.ContentHash,
            inspection.IsBytecode,
            inspection.IsPlainText,
            inspection.Magic,
            inspection.Variant,
            inspection.HeaderHex,
            Convert.ToBase64String(storedBytes),
            inspection.TextContent,
            inspection.TextPreview,
            inspection.LineCount,
            inspection.EmbeddedSymbols);
    }

    public object ExportAll(string outputDirectory, bool includeMetadataJson = true)
    {
        Directory.CreateDirectory(outputDirectory);
        var exportedFiles = new List<object>();

        // 导出每个 Lua 脚本
        foreach (var script in Scripts)
        {
            var rawBytes = Binder.GetStoredBytes(script.Index);
            var destPath = Path.Combine(outputDirectory, script.SanitizedName);
            File.WriteAllBytes(destPath, rawBytes);
            exportedFiles.Add(new
            {
                kind = "script",
                name = script.SanitizedName,
                path = destPath,
                size = rawBytes.Length,
                hash = script.ContentHash,
                isBytecode = script.IsBytecode,
                magic = script.Magic
            });
        }

        // 导出 LUAGNL
        if (GnlEntry != null && Gnl != null)
        {
            var gnlBytes = Binder.GetStoredBytes(GnlEntry.Index);
            var gnlDest = Path.Combine(outputDirectory, SanitizeEntryBasename(GnlEntry.Name));
            File.WriteAllBytes(gnlDest, gnlBytes);
            exportedFiles.Add(new
            {
                kind = "luagnl_raw",
                name = Path.GetFileName(gnlDest),
                path = gnlDest,
                size = gnlBytes.Length,
                hash = GnlEntry.ContentHash,
                symbolCount = Gnl.Count
            });

            if (includeMetadataJson)
            {
                var jsonDest = Path.Combine(outputDirectory, "luagnl.symbols.json");
                var jsonText = JsonSerializer.Serialize(new
                {
                    format = "LUAGNL",
                    sourceEntry = GnlEntry.Name,
                    symbolCount = Gnl.Count,
                    is64Bit = Gnl.Is64Bit,
                    symbols = Gnl.Symbols
                }, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(jsonDest, jsonText, new UTF8Encoding(false));
                exportedFiles.Add(new
                {
                    kind = "luagnl_json",
                    name = "luagnl.symbols.json",
                    path = jsonDest,
                    symbolCount = Gnl.Count
                });
            }
        }

        // 导出 LUAINFO
        if (InfoEntry != null && Info != null)
        {
            var infoBytes = Binder.GetStoredBytes(InfoEntry.Index);
            var infoDest = Path.Combine(outputDirectory, SanitizeEntryBasename(InfoEntry.Name));
            File.WriteAllBytes(infoDest, infoBytes);
            exportedFiles.Add(new
            {
                kind = "luainfo_raw",
                name = Path.GetFileName(infoDest),
                path = infoDest,
                size = infoBytes.Length,
                hash = InfoEntry.ContentHash,
                goalCount = Info.Count
            });

            if (includeMetadataJson)
            {
                var jsonDest = Path.Combine(outputDirectory, "luainfo.goals.json");
                var jsonText = JsonSerializer.Serialize(new
                {
                    format = "LUAINFO",
                    sourceEntry = InfoEntry.Name,
                    goalCount = Info.Count,
                    is64Bit = Info.Is64Bit,
                    goals = Info.Goals
                }, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(jsonDest, jsonText, new UTF8Encoding(false));
                exportedFiles.Add(new
                {
                    kind = "luainfo_json",
                    name = "luainfo.goals.json",
                    path = jsonDest,
                    goalCount = Info.Count
                });
            }
        }

        // 导出清单
        if (includeMetadataJson)
        {
            var manifestDest = Path.Combine(outputDirectory, "luabnd.manifest.json");
            var manifestJson = JsonSerializer.Serialize(new
            {
                sourceContainer = Path.GetFileName(SourcePath),
                sourceHash = SourceHash,
                payloadHash = PayloadHash,
                compression = DcxCompressionFormat,
                totalEntries = Binder.Entries.Count,
                scriptCount = Scripts.Count,
                exportedCount = exportedFiles.Count,
                scripts = Scripts.Select(s => new
                {
                    s.Index,
                    s.Id,
                    s.SanitizedName,
                    s.Size,
                    s.ContentHash,
                    s.IsBytecode,
                    s.Magic,
                    s.Variant
                }).ToArray()
            }, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(manifestDest, manifestJson, new UTF8Encoding(false));
        }

        return new
        {
            outputDirectory,
            exportedFilesCount = exportedFiles.Count,
            scriptCount = Scripts.Count,
            hasLuagnl = HasGnl,
            hasLuainfo = HasInfo,
            files = exportedFiles
        };
    }

    public static async Task<object> WriteScriptAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        string contentBase64;
        if (options.TryGetProperty("contentBase64", out var base64El) && base64El.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(base64El.GetString()))
        {
            contentBase64 = base64El.GetString()!;
        }
        else if (options.TryGetProperty("text", out var textEl) && textEl.ValueKind == JsonValueKind.String)
        {
            var textBytes = Encoding.UTF8.GetBytes(textEl.GetString()!);
            contentBase64 = Convert.ToBase64String(textBytes);
        }
        else
        {
            throw new InvalidDataException("write-luabnd-script 需要 options.contentBase64 或 options.text。");
        }

        var childSelector = options.TryGetProperty("childPath", out var childPathEl) ? childPathEl.GetString() : null;
        var entryIndex = options.TryGetProperty("entryIndex", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number ? idxEl.GetInt32() : -1;

        if (string.IsNullOrWhiteSpace(childSelector) && entryIndex < 0)
        {
            throw new InvalidDataException("write-luabnd-script 需要 options.childPath 或 options.entryIndex 定位要替换的子项。");
        }

        var mutationObject = new Dictionary<string, object>
        {
            ["mutation"] = "replace",
            ["contentBase64"] = contentBase64
        };

        if (entryIndex >= 0)
        {
            mutationObject["entryIndex"] = entryIndex;
        }
        else
        {
            mutationObject["childPath"] = childSelector!;
        }

        if (options.TryGetProperty("expectedChildHash", out var expChildHash) && expChildHash.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(expChildHash.GetString()))
        {
            mutationObject["expectedChildHash"] = expChildHash.GetString()!;
        }
        else
        {
            var baseDoc = Read(sourcePath, oodleRuntimeRoot);
            var baseIdx = baseDoc.ResolveScriptIndex(childSelector ?? entryIndex.ToString());
            mutationObject["expectedChildHash"] = baseDoc.Binder.Entries[baseIdx].ContentHash;
        }

        var writerOptions = new Dictionary<string, object>
        {
            ["expectedContainerHash"] = options.TryGetProperty("expectedContainerHash", out var expContHash) && expContHash.ValueKind == JsonValueKind.String
                ? expContHash.GetString()!
                : throw new InvalidDataException("write-luabnd-script 需要 options.expectedContainerHash。"),
            ["mutations"] = new[] { mutationObject }
        };

        var writerJson = JsonSerializer.SerializeToElement(writerOptions);

        var bndWriteResult = await Bnd4NativeWriter.WriteAsync(sourcePath, outputPath, writerJson, cancellationToken, oodleRuntimeRoot);

        var rereadLuabnd = Read(outputPath, oodleRuntimeRoot);

        return new
        {
            outputPath,
            rereadVerified = true,
            container = new
            {
                sourceHash = rereadLuabnd.SourceHash,
                payloadHash = rereadLuabnd.PayloadHash,
                entryCount = rereadLuabnd.EntryCount,
                scriptCount = rereadLuabnd.ScriptCount,
                dcxCompression = rereadLuabnd.DcxCompressionFormat
            },
            bndWriteResult
        };
    }

    public object ToEnvelope()
    {
        return new
        {
            format = "LUABND",
            authority = "candidate",
            sourcePath = SourcePath,
            dcxCompression = DcxCompressionFormat,
            sourceHash = SourceHash,
            payloadHash = PayloadHash,
            sourceSize = SourceBytes.Length,
            payloadSize = PayloadBytes.Length,
            entryCount = EntryCount,
            scriptCount = ScriptCount,
            hasLuagnl = HasGnl,
            hasLuainfo = HasInfo,
            scripts = Scripts.Select(s => new
            {
                s.Index,
                s.Id,
                s.Name,
                s.SanitizedName,
                s.Size,
                s.UncompressedSize,
                s.ContentHash,
                s.IsBytecode,
                s.Magic,
                s.Variant,
                s.IsPlainText,
                s.HeaderHex,
                s.EmbeddedSymbolsSample
            }).ToArray(),
            luagnl = Gnl == null ? null : new
            {
                entryIndex = GnlEntry?.Index,
                id = GnlEntry?.Id,
                name = GnlEntry?.Name,
                sanitizedName = GnlEntry != null ? SanitizeEntryBasename(GnlEntry.Name) : null,
                symbolCount = Gnl.Count,
                is64Bit = Gnl.Is64Bit,
                encoding = Gnl.Encoding,
                symbolsSample = Gnl.Symbols.Take(30).ToArray()
            },
            luainfo = Info == null ? null : new
            {
                entryIndex = InfoEntry?.Index,
                id = InfoEntry?.Id,
                name = InfoEntry?.Name,
                sanitizedName = InfoEntry != null ? SanitizeEntryBasename(InfoEntry.Name) : null,
                goalCount = Info.Count,
                is64Bit = Info.Is64Bit,
                goalsSample = Info.Goals.Take(30).Select(g => new
                {
                    g.GoalId,
                    g.Flags,
                    g.Name,
                    g.InterruptName
                }).ToArray()
            },
            roundTrip = Binder.VerifyRoundTrip(),
            fieldPreservation = Binder.VerifyFieldPreservation(),
            layoutGuard = Binder.VerifyLayoutGuard()
        };
    }

    public int ResolveScriptIndex(string childPathOrIndex)
    {
        if (int.TryParse(childPathOrIndex, out var idx) && idx >= 0 && idx < Binder.Entries.Count)
        {
            return idx;
        }

        var normalizedSelector = childPathOrIndex.Replace('\\', '/').Trim();
        var matches = new List<int>();

        for (var i = 0; i < Binder.Entries.Count; i++)
        {
            var rawName = Binder.Entries[i].Name.Replace('\\', '/');
            var baseName = SanitizeEntryBasename(rawName);

            if (string.Equals(rawName, normalizedSelector, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(baseName, normalizedSelector, StringComparison.OrdinalIgnoreCase) ||
                rawName.EndsWith('/' + normalizedSelector, StringComparison.OrdinalIgnoreCase))
            {
                matches.Add(i);
            }
        }

        if (matches.Count == 0)
        {
            throw new InvalidDataException($"在 luabnd 中未找到匹配的脚本条目: {childPathOrIndex}。");
        }
        if (matches.Count > 1)
        {
            throw new InvalidDataException($"脚本条目匹配不唯一（匹配到 {matches.Count} 项）: {childPathOrIndex}。");
        }

        return matches[0];
    }

    private static string SanitizeEntryBasename(string name)
    {
        var normalized = name.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        return slash >= 0 ? normalized[(slash + 1)..] : normalized;
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record LuabndScriptItem(
    int Index,
    int Id,
    string Name,
    string SanitizedName,
    int Size,
    int UncompressedSize,
    string ContentHash,
    bool IsBytecode,
    string Magic,
    string Variant,
    bool IsPlainText,
    string HeaderHex,
    IReadOnlyList<string> EmbeddedSymbolsSample);

internal sealed record LuabndScriptDetail(
    string ContainerPath,
    string ContainerHash,
    string PayloadHash,
    int Index,
    int Id,
    string Name,
    string SanitizedName,
    int Size,
    int UncompressedSize,
    string ContentHash,
    bool IsBytecode,
    bool IsPlainText,
    string Magic,
    string Variant,
    string HeaderHex,
    string ContentBase64,
    string? TextContent,
    string TextPreview,
    int LineCount,
    IReadOnlyList<string> EmbeddedSymbols);

internal sealed class LuagnlDocument
{
    public LuagnlDocument(IReadOnlyList<string> symbols, bool is64Bit, string encoding)
    {
        Symbols = symbols;
        Is64Bit = is64Bit;
        Encoding = encoding;
    }

    public IReadOnlyList<string> Symbols { get; }
    public int Count => Symbols.Count;
    public bool Is64Bit { get; }
    public string Encoding { get; }
}

internal static class LuagnlParser
{
    public static LuagnlDocument Parse(byte[] source)
    {
        if (source.Length < 8)
            return new LuagnlDocument(Array.Empty<string>(), false, "empty");

        var firstOffset = BinaryPrimitives.ReadUInt64LittleEndian(source.AsSpan(0, 8));
        if (firstOffset > 0 && firstOffset <= (ulong)source.Length && firstOffset % 8 == 0)
        {
            var slotCount = checked((int)(firstOffset / 8));
            var symbols = new List<string>(Math.Min(slotCount, 100_000));

            for (var i = 0; i < slotCount; i++)
            {
                var off = BinaryPrimitives.ReadUInt64LittleEndian(source.AsSpan(i * 8, 8));
                if (off == 0) break;
                if (off >= (ulong)source.Length) break;

                var str = ReadNullTerminatedUtf16(source, (int)off);
                symbols.Add(str);
            }

            return new LuagnlDocument(symbols, is64Bit: true, encoding: "UTF-16LE");
        }

        var firstOffset32 = BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(0, 4));
        if (firstOffset32 > 0 && firstOffset32 <= (uint)source.Length && firstOffset32 % 4 == 0)
        {
            var slotCount = checked((int)(firstOffset32 / 4));
            var symbols = new List<string>(Math.Min(slotCount, 100_000));

            for (var i = 0; i < slotCount; i++)
            {
                var off = BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(i * 4, 4));
                if (off == 0) break;
                if (off >= (uint)source.Length) break;

                var str = ReadNullTerminatedUtf8(source, (int)off);
                symbols.Add(str);
            }

            return new LuagnlDocument(symbols, is64Bit: false, encoding: "UTF-8");
        }

        throw new InvalidDataException("无法识别的 LUAGNL 符号表偏移结构。");
    }

    private static string ReadNullTerminatedUtf16(byte[] source, int offset)
    {
        if (offset < 0 || offset >= source.Length) return string.Empty;
        var end = offset;
        while (end + 1 < source.Length && (source[end] != 0 || source[end + 1] != 0))
        {
            end += 2;
        }
        return Encoding.Unicode.GetString(source, offset, end - offset);
    }

    private static string ReadNullTerminatedUtf8(byte[] source, int offset)
    {
        if (offset < 0 || offset >= source.Length) return string.Empty;
        var end = offset;
        while (end < source.Length && source[end] != 0)
        {
            end++;
        }
        return Encoding.UTF8.GetString(source, offset, end - offset);
    }
}

internal sealed record LuainfoGoal(int GoalId, int Flags, string Name, string? InterruptName);

internal sealed class LuainfoDocument
{
    public LuainfoDocument(IReadOnlyList<LuainfoGoal> goals, bool is64Bit, string? note = null)
    {
        Goals = goals;
        Is64Bit = is64Bit;
        Note = note;
    }

    public IReadOnlyList<LuainfoGoal> Goals { get; }
    public int Count => Goals.Count;
    public bool Is64Bit { get; }
    public string? Note { get; }
}

internal static class LuainfoParser
{
    public static LuainfoDocument Parse(byte[] source)
    {
        if (source.Length < 16 || !source.AsSpan(0, 4).SequenceEqual("LUAI"u8))
            throw new InvalidDataException("输入不是 LUAINFO 格式（缺少 LUAI 魔数）。");

        var is64 = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(4, 4)) == 1;

        if (is64)
        {
            var count = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(8, 8));
            if (count < 0 || count > 100_000)
                throw new InvalidDataException($"LUAINFO goal 数量无效: {count}。");

            var goals = new List<LuainfoGoal>((int)count);
            for (var i = 0; i < count; i++)
            {
                var entryOffset = 0x10 + i * 24;
                if (entryOffset + 24 > source.Length)
                    throw new InvalidDataException($"LUAINFO 第 {i} 个目标头越界。");

                var goalId = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(entryOffset, 4));
                var flags = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(entryOffset + 4, 4));
                var nameOffset = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(entryOffset + 8, 8));
                var interruptOffset = BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(entryOffset + 16, 8));

                var name = ReadNullTerminatedUtf16(source, checked((int)nameOffset));
                string? interruptName = interruptOffset > 0 ? ReadNullTerminatedUtf16(source, checked((int)interruptOffset)) : null;

                goals.Add(new LuainfoGoal(goalId, flags, name, interruptName));
            }

            return new LuainfoDocument(goals, is64Bit: true);
        }
        else
        {
            var count = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(8, 4));
            if (count < 0 || count > 100_000)
                throw new InvalidDataException($"LUAINFO goal 数量无效: {count}。");

            var goals = new List<LuainfoGoal>(count);
            for (var i = 0; i < count; i++)
            {
                var entryOffset = 0x0C + i * 16;
                if (entryOffset + 16 > source.Length)
                    throw new InvalidDataException($"LUAINFO 第 {i} 个目标头越界。");

                var goalId = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(entryOffset, 4));
                var flags = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(entryOffset + 4, 4));
                var nameOffset = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(entryOffset + 8, 4));
                var interruptOffset = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(entryOffset + 12, 4));

                var name = ReadNullTerminatedUtf8(source, nameOffset);
                string? interruptName = interruptOffset > 0 ? ReadNullTerminatedUtf8(source, interruptOffset) : null;

                goals.Add(new LuainfoGoal(goalId, flags, name, interruptName));
            }

            return new LuainfoDocument(goals, is64Bit: false);
        }
    }

    private static string ReadNullTerminatedUtf16(byte[] source, int offset)
    {
        if (offset < 0 || offset >= source.Length) return string.Empty;
        var end = offset;
        while (end + 1 < source.Length && (source[end] != 0 || source[end + 1] != 0))
        {
            end += 2;
        }
        return Encoding.Unicode.GetString(source, offset, end - offset);
    }

    private static string ReadNullTerminatedUtf8(byte[] source, int offset)
    {
        if (offset < 0 || offset >= source.Length) return string.Empty;
        var end = offset;
        while (end < source.Length && source[end] != 0)
        {
            end++;
        }
        return Encoding.UTF8.GetString(source, offset, end - offset);
    }
}

internal sealed record LuaInspectionResult(
    bool IsBytecode,
    bool IsPlainText,
    string Magic,
    string Variant,
    string HeaderHex,
    IReadOnlyList<string> EmbeddedSymbols,
    string? TextContent,
    string TextPreview,
    int LineCount);

internal static class LuaScriptInspector
{
    private static readonly Regex IdentifierRegex = new(@"^[A-Za-z_][A-Za-z0-9_]{2,63}$", RegexOptions.Compiled);

    public static LuaInspectionResult Inspect(byte[] source, string scriptName)
    {
        if (source.Length >= 4 && source[0] == 0x1B && source[1] == 0x4C && source[2] == 0x75 && source[3] == 0x61)
        {
            var versionByte = source.Length > 4 ? source[4] : (byte)0;
            var magic = versionByte switch
            {
                0x50 => "\\x1bLuaP",
                0x51 => "\\x1bLuaQ",
                0x52 => "\\x1bLuaR (5.2)",
                0x53 => "\\x1bLuaS (5.3)",
                0x54 => "\\x1bLuaT (5.4)",
                _ => $"\\x1bLua(0x{versionByte:X2})"
            };

            var variant = versionByte switch
            {
                0x50 => "Lua 5.1 (Havok Script / Sekiro variant)",
                0x51 => "Lua 5.1 (Standard bytecode)",
                _ => $"Lua (version 0x{versionByte:X2})"
            };

            var headerHex = Convert.ToHexString(source.AsSpan(0, Math.Min(32, source.Length)));
            var symbols = ExtractEmbeddedSymbols(source);

            var sb = new StringBuilder();
            sb.AppendLine($"-- [SoulForge Lua Bytecode Preview: {scriptName}]");
            sb.AppendLine($"-- Format: {variant}");
            sb.AppendLine($"-- Header magic: {magic} (32-byte header: {headerHex})");
            sb.AppendLine($"-- Size: {source.Length} bytes");
            sb.AppendLine($"-- Detected embedded symbols/identifiers ({symbols.Count}):");
            if (symbols.Count == 0)
            {
                sb.AppendLine("--   (No printable symbol strings detected)");
            }
            else
            {
                foreach (var sym in symbols.Take(25))
                {
                    sb.AppendLine($"--   {sym}");
                }
                if (symbols.Count > 25)
                {
                    sb.AppendLine($"--   ... ({symbols.Count - 25} more symbols)");
                }
            }
            sb.AppendLine("--");
            sb.AppendLine("-- Note: SoulForge does not present disassembled bytecode as editable source code.");

            return new LuaInspectionResult(
                IsBytecode: true,
                IsPlainText: false,
                Magic: magic,
                Variant: variant,
                HeaderHex: headerHex,
                EmbeddedSymbols: symbols,
                TextContent: null,
                TextPreview: sb.ToString(),
                LineCount: 0);
        }

        if (IsPrintableUtf8(source, out var text))
        {
            var lines = text.Split('\n');
            var previewLines = lines.Take(50).ToArray();
            var textPreview = string.Join("\n", previewLines);
            if (lines.Length > 50)
            {
                textPreview += $"\n\n-- ... [预览已截断，共 {lines.Length} 行] ...";
            }

            return new LuaInspectionResult(
                IsBytecode: false,
                IsPlainText: true,
                Magic: "PLAIN_TEXT",
                Variant: "Plain Text Lua",
                HeaderHex: Convert.ToHexString(source.AsSpan(0, Math.Min(16, source.Length))),
                EmbeddedSymbols: Array.Empty<string>(),
                TextContent: text,
                TextPreview: textPreview,
                LineCount: lines.Length);
        }

        var unknownHex = Convert.ToHexString(source.AsSpan(0, Math.Min(32, source.Length)));
        return new LuaInspectionResult(
            IsBytecode: false,
            IsPlainText: false,
            Magic: "UNKNOWN_BINARY",
            Variant: "Unknown Binary",
            HeaderHex: unknownHex,
            EmbeddedSymbols: Array.Empty<string>(),
            TextContent: null,
            TextPreview: $"-- [未知二进制格式: {scriptName}, header: {unknownHex}]",
            LineCount: 0);
    }

    private static IReadOnlyList<string> ExtractEmbeddedSymbols(byte[] source)
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        var cur = new List<char>();

        for (var i = 0; i < source.Length; i++)
        {
            var b = source[i];
            if (b >= 32 && b < 127)
            {
                cur.Add((char)b);
            }
            else
            {
                if (cur.Count >= 3)
                {
                    var word = new string(cur.ToArray());
                    if (IdentifierRegex.IsMatch(word) && !IsNoiseWord(word))
                    {
                        found.Add(word);
                    }
                }
                cur.Clear();
            }
        }

        if (cur.Count >= 3)
        {
            var word = new string(cur.ToArray());
            if (IdentifierRegex.IsMatch(word) && !IsNoiseWord(word))
            {
                found.Add(word);
            }
        }

        return found.OrderBy(s => s, StringComparer.Ordinal).ToArray();
    }

    private static bool IsNoiseWord(string s) => s is "LuaP" or "LuaQ" or "none";

    private static bool IsPrintableUtf8(byte[] source, out string text)
    {
        text = string.Empty;
        if (source.Length == 0) return true;

        try
        {
            var decoded = Encoding.UTF8.GetString(source);
            var printableCount = 0;

            for (var i = 0; i < decoded.Length; i++)
            {
                var ch = decoded[i];
                if (char.IsControl(ch) && ch != '\r' && ch != '\n' && ch != '\t')
                {
                    return false;
                }
                if (!char.IsControl(ch))
                {
                    printableCount++;
                }
            }

            var ratio = (double)printableCount / Math.Max(1, decoded.Length);
            if (ratio >= 0.80)
            {
                text = decoded;
                return true;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }
}

using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// Sekiro TPF texture replace writer（TEXTURE-52C）。
///
/// 只接受 typed replace：定位纹理索引 → 校验替换 DDS 的 dimensions / format /
/// color-space / mipmap 与目标纹理一致 → 替换 blob → 重建 → 输出后重读验证。
/// 不提供「通用 bytes replace fallback」：没有 typed 定位就没有写入口。
///
/// 重建策略：名字区与条目表位置不动，数据区从名字区末尾（4 字节对齐）起
/// 紧凑重排。TPF 的 dataLength 字段语义是「数据区含起始 padding 的总长」
/// （= 文件总长 − 名字区末尾），重排后同步更新。替换后 dataSize 可不同于
/// 原值（数据区整体重排，其他纹理偏移随之更新）——要求新 DDS 尺寸/格式/
/// mipmap 与目标一致，但 blob 大小不必相同。
///
/// 校验基准是**目标纹理 DDS 头声明的 fourCC/DXGI**，不是 TPF 条目表的
/// format 字段：TEXTURE-52A 实测条目表 formatByte 查表结果与 DDS 真实格式
/// 系统性错配（52 纹理错 24），拿它当替换判据会把合法替换误拒或放行错格式。
/// DX10 的 DXGI 值同时编码 block 格式与色彩空间（*_UNORM vs *_UNORM_SRGB），
/// 要求 DXGI 一致即同时校验了格式与色彩空间。
/// </summary>
internal static class TpfNativeWriter
{
    private const int DdsHeaderMinSize = 128;
    private const int Dxt10HeaderSize = 148;

    private static readonly HashSet<string> LegacyFourCc = new(StringComparer.Ordinal)
    {
        "DXT1", "DXT3", "DXT5", "ATI1", "ATI2", "BC4U", "BC5U"
    };

    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null)
    {
        var isDcx = Path.GetExtension(sourcePath).Equals(".dcx", StringComparison.OrdinalIgnoreCase);
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        // DCX 源：先解压再解析（与 read-tpf-document 同一路径）；写回时按原压缩
        // 格式重建（DFLT 内置、KRAK 需 Oodle compress session）。
        var payload = isDcx
            ? DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot).Payload
            : source;
        var document = TpfNativeDocument.Read(payload);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "TPF source hash");

        var textureIndex = RequiredInt(options, "textureIndex");
        var newTextureBase64 = RequiredString(options, "newTextureBase64");
        byte[] newDds;
        try
        {
            newDds = Convert.FromBase64String(newTextureBase64);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("newTextureBase64 不是合法的 base64。", ex);
        }

        // 越界必须是结构化失败（InvalidDataException → TPF_STAGING_WRITE_FAILED），
        // 不能靠 GetTextureMetadata 抛 ArgumentOutOfRangeException 变成 daemon
        // 崩溃语义（dispatch 的 catch 白名单不接后者）。
        if (textureIndex < 0 || textureIndex >= document.Textures.Count)
            throw new InvalidDataException($"TPF 纹理索引 {textureIndex} 越界；有效范围 0..{document.Textures.Count - 1}。");
        var (name, width, height, mipCount, _) = document.GetTextureMetadata(textureIndex);
        var targetDds = document.GetTextureData(textureIndex);
        ValidateReplacement(targetDds, newDds, name, width, height, mipCount);

        cancellationToken.ThrowIfCancellationRequested();
        var rebuilt = RebuildWithReplacement(document, textureIndex, newDds);
        // DCX 输出：按原压缩格式包回。KRAK 需要 compress session；无 session 时
        // 明确失败，不静默降级为 DFLT（那会改变 storage profile）。
        var output = isDcx
            ? RebuildDcx(sourcePath, rebuilt, oodleRuntimeRoot)
            : rebuilt;

        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, output, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        // 重读并逐项验证：目标纹理 blob 字节级一致、dataSize 匹配；未替换纹理的
        // dataSize 与名称不变（dataOffset 因重排必然变化，由重建不变性保证内容）。
        var rereadPayload = isDcx
            ? DcxNativeDocument.Read(outputPath, oodleRuntimeRoot).Payload
            : File.ReadAllBytes(outputPath);
        var reread = TpfNativeDocument.Read(rereadPayload);
        if (textureIndex >= reread.Textures.Count)
            throw new InvalidDataException($"重读后纹理 {textureIndex} 不存在。");
        var target = reread.Textures[textureIndex];
        if (target.DataSize != (uint)newDds.Length)
            throw new InvalidDataException($"重读后纹理 {textureIndex} dataSize {target.DataSize} 与写入 {newDds.Length} 不匹配。");
        if (target.Name != name)
            throw new InvalidDataException($"重读后纹理 {textureIndex} 名称变为 {target.Name}（期望 {name}）。");
        for (var i = 0; i < reread.Textures.Count; i++)
        {
            if (i == textureIndex) continue;
            if (reread.Textures[i].DataSize != document.Textures[i].DataSize)
                throw new InvalidDataException($"重读后未替换纹理 {i} dataSize 被改动（{reread.Textures[i].DataSize} vs {document.Textures[i].DataSize}）。");
            if (reread.Textures[i].Name != document.Textures[i].Name)
                throw new InvalidDataException($"重读后未替换纹理 {i} 名称被改动。");
        }
        var rereadBlob = reread.GetTextureData(textureIndex);
        if (!rereadBlob.AsSpan().SequenceEqual(newDds))
            throw new InvalidDataException("重读后替换纹理 blob 与写入不一致。");

        return new
        {
            textureIndex,
            name,
            outputHash = reread.SourceHash,
            outputSize = reread.SourceBytes.Length,
            dataSizeBefore = document.Textures[textureIndex].DataSize,
            dataSizeAfter = (uint)newDds.Length,
            rereadVerified = true
        };
    }

    /// <summary>
    /// 校验替换 DDS 与目标纹理一致：dimensions / format(fourCC) / color-space(DXGI) /
    /// mipmap。尺寸或 mip 不符、fourCC 不符、DX10 的 DXGI 不符（含色彩空间变体）、
    /// 像素数据不足以覆盖声明尺寸，一律拒绝——替换一个「看起来能解码但根本不是
    /// 同一张图」的纹理正是要挡住的形态。
    /// </summary>
    private static void ValidateReplacement(
        byte[] targetDds, byte[] newDds, string name, uint width, uint height, ushort mipCount)
    {
        if (newDds.Length < DdsHeaderMinSize
            || newDds[0] != (byte)'D' || newDds[1] != (byte)'D' || newDds[2] != (byte)'S' || newDds[3] != 0x20)
            throw new InvalidDataException("替换纹理不是合法的 DDS 文件。");

        var newHeight = BitConverter.ToInt32(newDds, 12);
        var newWidth = BitConverter.ToInt32(newDds, 16);
        var newMips = BitConverter.ToInt32(newDds, 28);
        if (newWidth <= 0 || newHeight <= 0)
            throw new InvalidDataException($"替换纹理声明尺寸非法：{newWidth}x{newHeight}。");
        if (newWidth != (int)width || newHeight != (int)height)
            throw new InvalidDataException(
                $"替换纹理尺寸 {newWidth}x{newHeight} 与目标纹理 {name} {width}x{height} 不一致，拒绝替换。");
        if (newMips != (int)mipCount)
            throw new InvalidDataException(
                $"替换纹理 mip 数 {newMips} 与目标纹理 {name} 的 {mipCount} 不一致，拒绝替换。");

        var targetFourCc = ReadAscii(targetDds, 84, 4);
        var newFourCc = ReadAscii(newDds, 84, 4);
        if (newFourCc != targetFourCc)
            throw new InvalidDataException(
                $"替换纹理格式 {newFourCc} 与目标纹理 {name} 的 {targetFourCc} 不一致，拒绝替换。");

        int dataOffset;
        string bcFormat;
        if (newFourCc == "DX10")
        {
            if (newDds.Length < Dxt10HeaderSize || targetDds.Length < Dxt10HeaderSize)
                throw new InvalidDataException("DX10 DDS 头不完整。");
            var targetDxgi = ReadUInt32(targetDds, 128);
            var newDxgi = ReadUInt32(newDds, 128);
            // DXGI 值同时编码 block 格式与色彩空间（72=BC1_UNORM_SRGB、71=BC1_UNORM），
            // 精确一致即格式与色彩空间都一致。
            if (targetDxgi != newDxgi)
                throw new InvalidDataException(
                    $"替换纹理 DXGI 格式/色彩空间 {newDxgi}（0x{newDxgi:X8}）与目标纹理 {name} 的 {targetDxgi}（0x{targetDxgi:X8}）不一致，拒绝替换。");
            bcFormat = newDxgi switch
            {
                71 or 72 => "BC1",
                77 or 78 => "BC3",
                80 or 81 => "BC4",
                83 or 84 => "BC5",
                98 or 99 => "BC7",
                _ => throw new NotSupportedException($"不支持的 DXGI 格式：{newDxgi}。")
            };
            dataOffset = Dxt10HeaderSize;
        }
        else
        {
            if (!LegacyFourCc.Contains(newFourCc))
                throw new NotSupportedException($"不支持的 DDS 压缩格式：{newFourCc}。");
            bcFormat = newFourCc switch
            {
                "DXT1" => "BC1",
                "DXT5" => "BC3",
                "ATI1" or "BC4U" => "BC4",
                "ATI2" or "BC5U" => "BC5",
                _ => "BC3"
            };
            dataOffset = DdsHeaderMinSize;
        }

        // 像素数据必须足以覆盖声明尺寸，否则「替换成功」的 blob 解码后会是黑图
        // （与 DdsCodec 的截断检查同一口径：需要的字节数可算，缺了必须失败关闭）。
        var blocksWide = Math.Max(1, (newWidth + 3) / 4);
        var blocksHigh = Math.Max(1, (newHeight + 3) / 4);
        var blockBytes = bcFormat == "BC1" || bcFormat == "BC4" ? 8 : 16;
        long requiredBytes = (long)blocksWide * blocksHigh * blockBytes;
        long availableBytes = newDds.Length - dataOffset;
        if (availableBytes < requiredBytes)
        {
            throw new InvalidDataException(
                $"替换纹理像素数据被截断：{bcFormat} {newWidth}x{newHeight} 需要 {requiredBytes} 字节，"
                + $"实际只有 {availableBytes} 字节。");
        }
    }

    /// <summary>
    /// 替换一个纹理后重建整个 TPF 字节。
    ///
    /// 布局保持：header、条目表、名字区及其与数据区之间的 padding 原样保留
    /// （从源字节 0..dataStart 整段拷贝）；数据区从 dataStart（名字区末尾按 4 对齐）
    /// 起紧凑重排，各条目的 dataOffset/dataSize 随之更新；dataLength 更新为新的
    /// 数据区总长（含 dataStart 前的 padding，语义与源文件一致）。
    /// </summary>
    private static byte[] RebuildWithReplacement(TpfNativeDocument document, int textureIndex, byte[] newDds)
    {
        long namesEnd = 0;
        foreach (var t in document.Textures)
        {
            var end = (long)t.NameOffset + Encoding.Unicode.GetBytes(t.Name + "\0").Length;
            if (end > namesEnd) namesEnd = end;
        }
        var dataStart = Align4(namesEnd);

        var newOffsets = new uint[document.Textures.Count];
        var newSizes = new uint[document.Textures.Count];
        long cursor = dataStart;
        for (var i = 0; i < document.Textures.Count; i++)
        {
            var data = i == textureIndex ? newDds : document.GetTextureData(i);
            newOffsets[i] = (uint)cursor;
            newSizes[i] = (uint)data.Length;
            cursor += data.Length;
        }
        var newDataLength = (uint)(cursor - namesEnd);

        var rebuilt = new byte[cursor];
        // header + entries + names + padding 原样（header 的 dataLength 随后覆盖）。
        document.SourceBytes.AsSpan(0, (int)dataStart).CopyTo(rebuilt.AsSpan(0, (int)dataStart));
        WriteUInt32(rebuilt, 4, newDataLength);
        for (var i = 0; i < document.Textures.Count; i++)
        {
            var t = document.Textures[i];
            var o = 16 + i * 20;
            WriteUInt32(rebuilt, o, newOffsets[i]);
            WriteUInt32(rebuilt, o + 4, newSizes[i]);
            WriteUInt16(rebuilt, o + 10, t.MipCount);
        }
        for (var i = 0; i < document.Textures.Count; i++)
        {
            var data = i == textureIndex ? newDds : document.GetTextureData(i);
            data.CopyTo(rebuilt, (int)newOffsets[i]);
        }
        return rebuilt;
    }

    private static byte[] RebuildDcx(string sourcePath, byte[] nextPayload, string? oodleRuntimeRoot)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        if (dcx.CompressionFormat == "DFLT") return dcx.RebuildDflt(nextPayload);
        if (dcx.CompressionFormat == "KRAK")
        {
            var oodle = OodleRuntimeLocator.Open(oodleRuntimeRoot);
            if (oodle.Session == null || !oodle.Session.CanCompress)
                throw new NotSupportedException("KRAK 写回需要支持压缩的 Oodle 运行库。");
            using var session = oodle.Session;
            return dcx.RebuildKrak(nextPayload, session);
        }
        throw new NotSupportedException($"DCX 压缩格式 {dcx.CompressionFormat} 无法重建。");
    }

    private static long Align4(long value) => (value + 3) & ~3L;

    private static string ReadAscii(byte[] source, int offset, int length)
    {
        if (offset + length > source.Length) return "";
        return Encoding.ASCII.GetString(source, offset, length).TrimEnd('\0');
    }

    private static uint ReadUInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
    private static void WriteUInt32(byte[] target, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt16(byte[] target, int offset, ushort value) =>
        BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), value);

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static int RequiredInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32() : throw new InvalidDataException($"options.{field} 是必填整数。");
}

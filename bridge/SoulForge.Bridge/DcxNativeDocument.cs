using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;

internal sealed class DcxNativeDocument
{
    private const int MaxSourceBytes = 512 * 1024 * 1024;
    private const int MaxPayloadBytes = 512 * 1024 * 1024;

    private DcxNativeDocument(
        byte[] sourceBytes,
        string compressionFormat,
        string variant,
        int payloadOffset,
        int compressedSize,
        int uncompressedSize,
        byte[] payload)
    {
        SourceBytes = sourceBytes;
        CompressionFormat = compressionFormat;
        Variant = variant;
        PayloadOffset = payloadOffset;
        CompressedSize = compressedSize;
        UncompressedSize = uncompressedSize;
        Payload = payload;
    }

    public byte[] SourceBytes { get; }
    public string CompressionFormat { get; }
    public string Variant { get; }
    public int PayloadOffset { get; }
    public int CompressedSize { get; }
    public int UncompressedSize { get; }
    public byte[] Payload { get; }
    public string SourceHash => HexHash(SourceBytes);
    public string PayloadHash => HexHash(Payload);

    public static DcxNativeDocument Read(string path, string? oodleRuntimeRoot = null)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("DCX 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"DCX 文件大小 {info.Length} 超出安全读取范围。");
        var source = File.ReadAllBytes(path);
        if (source.Length < 0x4C || !source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            throw new InvalidDataException("输入不是受支持的 DCX 文档。");
        if (!source.AsSpan(0x18, 4).SequenceEqual("DCS\0"u8)
            || !source.AsSpan(0x24, 4).SequenceEqual("DCP\0"u8))
            throw new InvalidDataException("DCX DCS/DCP 头缺失或位置不受支持。");
        var uncompressed = checked((int)ReadUInt32Be(source, 0x1C));
        var compressed = checked((int)ReadUInt32Be(source, 0x20));
        if (uncompressed <= 0 || uncompressed > MaxPayloadBytes || compressed <= 0 || compressed > MaxPayloadBytes)
            throw new InvalidDataException("DCX 压缩或解压大小超出安全范围。");
        var format = System.Text.Encoding.ASCII.GetString(source, 0x28, 4);
        var dca = FindMagic(source, "DCA\0"u8, 0x30, Math.Min(source.Length, 0x100));
        if (dca < 0) throw new InvalidDataException("DCX DCA 头缺失。");
        var dcaLength = checked((int)ReadUInt32Be(source, dca + 4));
        var payloadOffset = checked(dca + dcaLength);
        if (dcaLength < 8 || payloadOffset < 0 || payloadOffset + compressed > source.Length)
            throw new InvalidDataException("DCX payload 边界无效。");
        var compressedPayload = source.AsSpan(payloadOffset, compressed).ToArray();
        var payload = format switch
        {
            "DFLT" => DecompressDflt(compressedPayload, uncompressed),
            "KRAK" => DecompressKraken(compressedPayload, uncompressed, oodleRuntimeRoot, path),
            _ => throw new NotSupportedException($"DCX 压缩格式 {format} 尚不支持完整文档读取。")
        };
        var variant = ClassifyVariant(source, format);
        return new DcxNativeDocument(source, format, variant, payloadOffset, compressed, uncompressed, payload);
    }

    public DcxRoundTripReport VerifyRoundTrip()
    {
        if (CompressionFormat != "DFLT")
        {
            return new DcxRoundTripReport(false, false, false, SourceHash, null, PayloadHash, null,
                "KRAK 当前仅验证读取；未启用未经真实运行库验证的重压缩。");
        }
        var rebuilt = RebuildDflt(Payload);
        var reparsed = ReadBytes(rebuilt);
        return new DcxRoundTripReport(
            SourceBytes.SequenceEqual(rebuilt),
            Payload.SequenceEqual(reparsed.Payload),
            Variant == reparsed.Variant,
            SourceHash,
            HexHash(rebuilt),
            PayloadHash,
            reparsed.PayloadHash,
            null);
    }

    public byte[] RebuildDflt(byte[] nextPayload)
    {
        if (CompressionFormat != "DFLT") throw new NotSupportedException("只有 DFLT 文档可重建。");
        if (nextPayload.Length <= 0 || nextPayload.Length > MaxPayloadBytes)
            throw new InvalidDataException("重建 payload 大小超出安全范围。");
        byte[] compressed;
        using (var output = new MemoryStream())
        {
            using (var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true))
                zlib.Write(nextPayload);
            compressed = output.ToArray();
        }
        var suffixOffset = checked(PayloadOffset + CompressedSize);
        var rebuilt = new byte[checked(PayloadOffset + compressed.Length + (SourceBytes.Length - suffixOffset))];
        Buffer.BlockCopy(SourceBytes, 0, rebuilt, 0, PayloadOffset);
        Buffer.BlockCopy(compressed, 0, rebuilt, PayloadOffset, compressed.Length);
        Buffer.BlockCopy(SourceBytes, suffixOffset, rebuilt, PayloadOffset + compressed.Length, SourceBytes.Length - suffixOffset);
        WriteUInt32Be(rebuilt, 0x1C, checked((uint)nextPayload.Length));
        WriteUInt32Be(rebuilt, 0x20, checked((uint)compressed.Length));
        return rebuilt;
    }

    public object ToEnvelope(DcxRoundTripReport report)
    {
        object? nested = null;
        bool? nestedDcxRebuildVerified = null;
        if (Payload.AsSpan(0, Math.Min(Payload.Length, 4)).SequenceEqual("BND4"u8))
        {
            var binder = Bnd4NativeDocument.Read(Payload);
            nested = binder.ToEnvelope();
            if (CompressionFormat == "DFLT" && binder.Entries.Count > 0)
            {
                var entries = binder.ToRepackEntries().ToList();
                entries[0] = entries[0] with { Name = entries[0].Name + ".dcx-roundtrip" };
                var rebuiltDcx = RebuildDflt(binder.Repack(entries));
                var reparsedDcx = ReadBytes(rebuiltDcx);
                var reparsedBinder = Bnd4NativeDocument.Read(reparsedDcx.Payload);
                nestedDcxRebuildVerified = reparsedBinder.Entries[0].Name == entries[0].Name;
            }
        }
        return new
    {
        format = "DCX",
        compressionFormat = CompressionFormat,
        variant = Variant,
        sourceSize = SourceBytes.Length,
        sourceHash = SourceHash,
        payloadOffset = PayloadOffset,
        compressedSize = CompressedSize,
        uncompressedSize = UncompressedSize,
        payloadHash = PayloadHash,
        payloadPrefixHex = Convert.ToHexString(Payload.AsSpan(0, Math.Min(Payload.Length, 128))).ToLowerInvariant(),
        unknownDataPolicy = "source-header-and-trailing-bytes-preserved",
        roundTrip = report,
        nested,
        nestedDcxRebuildVerified
    };
    }

    private static DcxNativeDocument ReadBytes(byte[] bytes)
    {
        var temporary = Path.Combine(Path.GetTempPath(), $"soulforge-dcx-{Guid.NewGuid():N}.dcx");
        try
        {
            File.WriteAllBytes(temporary, bytes);
            return Read(temporary);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static byte[] DecompressDflt(byte[] compressed, int expectedSize)
    {
        using var input = new MemoryStream(compressed, writable: false);
        using var zlib = new ZLibStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream(expectedSize);
        zlib.CopyTo(output);
        var payload = output.ToArray();
        if (payload.Length != expectedSize)
            throw new InvalidDataException($"DFLT 解压大小不一致：预期 {expectedSize}，实际 {payload.Length}。");
        return payload;
    }

    private static byte[] DecompressKraken(byte[] compressed, int expectedSize, string? root, string path)
    {
        using var opened = OodleRuntimeLocator.Open(root, BridgeResult<object>.MakeSourceUri(path));
        if (opened.Session is null)
            throw new InvalidOperationException(opened.Diagnostics.FirstOrDefault()?.Message ?? "Oodle 运行库不可用。");
        return opened.Session.Decompress(compressed, expectedSize);
    }

    private static string ClassifyVariant(byte[] source, string format)
    {
        var version = ReadUInt32Be(source, 0x04);
        var hint = ReadUInt32Be(source, 0x10);
        var level = source[0x30];
        var sub = source[0x38];
        return $"{format}_{version:X}_{hint:X}_{level}_{sub}";
    }

    private static int FindMagic(byte[] source, ReadOnlySpan<byte> magic, int start, int end)
    {
        for (var i = start; i <= end - magic.Length; i++)
            if (source.AsSpan(i, magic.Length).SequenceEqual(magic)) return i;
        return -1;
    }
    private static uint ReadUInt32Be(byte[] source, int offset) => BinaryPrimitives.ReadUInt32BigEndian(source.AsSpan(offset, 4));
    private static void WriteUInt32Be(byte[] target, int offset, uint value) => BinaryPrimitives.WriteUInt32BigEndian(target.AsSpan(offset, 4), value);
    private static string HexHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record DcxRoundTripReport(
    bool ByteIdentical,
    bool PayloadIdentical,
    bool VariantIdentical,
    string SourceHash,
    string? RebuiltHash,
    string PayloadHash,
    string? RebuiltPayloadHash,
    string? Note);

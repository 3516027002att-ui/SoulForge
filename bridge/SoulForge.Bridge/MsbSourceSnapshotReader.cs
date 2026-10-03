using System.Buffers.Binary;

// MSB-only admission before allocating the outer snapshot or inflating a leaf.
// The byte receipt still goes through the existing NativeLeafPayload/DCX codecs.
internal static class MsbSourceSnapshotReader
{
    public static byte[] Read(string path, CancellationToken cancellationToken)
    {
        // File.ReadAllBytes used FileShare.Read. Retain that Windows sharing
        // boundary and close this owned handle on every failure/cancellation.
        using var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 64 * 1024, options: FileOptions.SequentialScan);
        return Read(source, cancellationToken);
    }

    internal static byte[] Read(Stream source, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var length = source.Length;
        if (length < 0 || length > DcxNativeDocument.MaxSourceBytes)
            throw new InvalidDataException($"MSB 外层大小 {length} 超出 {DcxNativeDocument.MaxSourceBytes} 字节读取范围。");

        // The codec permits DCA magic at 0xFC; its length ends at 0x104.
        Span<byte> prefix = stackalloc byte[0x104];
        var magicLength = (int)Math.Min(length, 4);
        ReadExactly(source, prefix[..magicLength], DcxNativeDocument.MaxSourceBytes, cancellationToken);
        var dcx = magicLength == 4 && prefix[..4].SequenceEqual("DCX\0"u8);
        var maximum = dcx ? DcxNativeDocument.MaxSourceBytes : MsbNativeDocument.MaxSourceBytes;
        if (length > maximum || source.Length > maximum)
            throw new InvalidDataException($"MSB 源大小 {length} 超出 {maximum} 字节读取范围。");
        var prefixLength = (int)Math.Min(length, dcx ? prefix.Length : magicLength);
        ReadExactly(source, prefix.Slice(magicLength, prefixLength - magicLength), maximum, cancellationToken);

        // Preserve malformed/unknown-header and unsupported-codec diagnostics
        // from DcxNativeDocument. Only its recognizable supported envelopes
        // provide a declared leaf budget that can be checked before decode.
        if (dcx && prefixLength >= 0x4C
            && prefix.Slice(0x18, 4).SequenceEqual("DCS\0"u8)
            && prefix.Slice(0x24, 4).SequenceEqual("DCP\0"u8))
        {
            var declared = BinaryPrimitives.ReadUInt32BigEndian(prefix.Slice(0x1C, 4));
            var compressed = BinaryPrimitives.ReadUInt32BigEndian(prefix.Slice(0x20, 4));
            if (declared > DcxNativeDocument.MaxSourceBytes || compressed > DcxNativeDocument.MaxSourceBytes)
                throw new InvalidDataException("DCX 压缩或解压大小超出安全范围。");
            var supported = prefix.Slice(0x28, 4).SequenceEqual("DFLT"u8)
                || prefix.Slice(0x28, 4).SequenceEqual("KRAK"u8);
            var scanEnd = Math.Min(prefixLength, 0x100);
            var relativeDca = prefix.Slice(0x30, scanEnd - 0x30).IndexOf("DCA\0"u8);
            var dca = relativeDca < 0 ? -1 : 0x30 + relativeDca;
            var validDca = dca >= 0 && dca + 8 <= prefixLength;
            var dcaLength = validDca ? BinaryPrimitives.ReadUInt32BigEndian(prefix.Slice(dca + 4, 4)) : 0;
            // Check the MSB budget only after recognizing the envelope layout;
            // missing DCA/invalid sizes still reach the original decoder.
            if (supported && declared > MsbNativeDocument.MaxSourceBytes
                && compressed > 0 && compressed <= DcxNativeDocument.MaxSourceBytes
                && validDca && dcaLength >= 8 && (long)dca + dcaLength + compressed <= length)
                throw new InvalidDataException($"MSB 声明解压大小 {declared} 超出 {MsbNativeDocument.MaxSourceBytes} 字节范围。");
        }

        var bytes = length == 0 ? Array.Empty<byte>() : GC.AllocateUninitializedArray<byte>((int)length);
        prefix[..prefixLength].CopyTo(bytes);
        ReadExactly(source, bytes.AsSpan(prefixLength), maximum, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        Span<byte> extra = stackalloc byte[1];
        if (source.Length > maximum || source.Read(extra) != 0)
            throw new InvalidDataException("MSB 源在读取期间增长；拒绝返回截断或超预算快照。");
        return bytes;
    }

    private static void ReadExactly(Stream source, Span<byte> target, int maximum, CancellationToken cancellationToken)
    {
        while (!target.IsEmpty)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (source.Length > maximum)
                throw new InvalidDataException("MSB 源在读取期间增长并超出读取范围。");
            var read = source.Read(target);
            if (read == 0) throw new EndOfStreamException("MSB 源在读取期间缩短；拒绝返回不完整快照。");
            target = target[read..];
        }
    }
}

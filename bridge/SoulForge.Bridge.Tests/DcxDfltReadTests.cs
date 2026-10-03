using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using Xunit;

public sealed class DcxDfltReadTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(4096)]
    [InlineData(85000)]
    [InlineData(2 * 1024 * 1024)]
    public void ReadsExactDfltPayloadWithoutChangingSource(int length)
    {
        var payload = Enumerable.Range(0, length).Select(i => (byte)(i * 197 + (i >> 8))).ToArray();
        var source = MakeDcx(payload, length, trailing: new byte[] { 9, 8, 7 });
        var before = SHA256.HashData(source);
        var read = DcxNativeDocument.Read(source);
        Assert.Equal(payload, read.Payload);
        Assert.Equal("DFLT", read.CompressionFormat);
        Assert.Equal(before, SHA256.HashData(source));
    }

    [Fact]
    public void LargeValidDfltAllocatesOneOutputBuffer()
    {
        const int length = 2 * 1024 * 1024;
        var source = MakeDcx(new byte[length], length);
        _ = DcxNativeDocument.Read(source); // Exclude one-time runtime setup.
        var before = GC.GetAllocatedBytesForCurrentThread();
        var read = DcxNativeDocument.Read(source);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(length, read.Payload.Length);
        Assert.True(allocated < length + 192 * 1024,
            $"DFLT allocated {allocated} bytes for {length} output bytes; source-sized output copies remain.");
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(31, 32)]
    [InlineData(32, 31)]
    public void ShortAndOverlongOutputFailClosed(int actualSize, int declaredSize)
    {
        var source = MakeDcx(new byte[actualSize], declaredSize);
        Assert.Throws<InvalidDataException>(() => DcxNativeDocument.Read(source));
    }

    [Fact]
    public void OverlongDfltCannotAllocateAccordingToUntrustedExpandedStream()
    {
        var source = MakeDcx(new byte[2 * 1024 * 1024], 32);
        Assert.Throws<InvalidDataException>(() => DcxNativeDocument.Read(source)); // Runtime warmup.
        var before = GC.GetAllocatedBytesForCurrentThread();
        var error = Record.Exception(() => DcxNativeDocument.Read(source));
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.IsType<InvalidDataException>(error);
        Assert.True(allocated < 192 * 1024,
            $"Malformed DFLT allocated {allocated} bytes despite its declared 32-byte output.");
    }

    [Fact]
    public void CorruptZlibChecksumFailsClosed()
    {
        var source = MakeDcx(Enumerable.Range(0, 4096).Select(i => (byte)i).ToArray(), 4096);
        source[^1] ^= 1;
        Assert.Throws<InvalidDataException>(() => DcxNativeDocument.Read(source));
    }

    [Fact]
    public void TruncatedCompressedStreamWithShortOutputFailsClosed()
    {
        var source = MakeDcx(Enumerable.Range(0, 4096).Select(i => (byte)i).ToArray(), 4096);
        var compressedLength = BinaryPrimitives.ReadInt32BigEndian(source.AsSpan(0x20, 4));
        var truncatedLength = compressedLength / 2;
        Array.Resize(ref source, 0x4C + truncatedLength);
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x20, 4), truncatedLength);
        Assert.Throws<InvalidDataException>(() => DcxNativeDocument.Read(source));
    }

    [Fact]
    public void ExistingDcxSizeLimitRejectsBeforeOutputAllocation()
    {
        var source = MakeDcx(new byte[] { 1 }, 512 * 1024 * 1024 + 1);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var error = Record.Exception(() => DcxNativeDocument.Read(source));
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.IsType<InvalidDataException>(error);
        Assert.True(allocated < 192 * 1024);
    }

    private static byte[] MakeDcx(byte[] payload, int declaredSize, byte[]? trailing = null)
    {
        byte[] compressed;
        using (var output = new MemoryStream())
        {
            using (var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true))
                zlib.Write(payload);
            compressed = output.ToArray();
        }
        var source = new byte[0x4C + compressed.Length + (trailing?.Length ?? 0)];
        "DCX\0"u8.CopyTo(source);
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(4, 4), 0x10000);
        "DCS\0"u8.CopyTo(source.AsSpan(0x18));
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x1C, 4), declaredSize);
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x20, 4), compressed.Length);
        "DCP\0"u8.CopyTo(source.AsSpan(0x24));
        "DFLT"u8.CopyTo(source.AsSpan(0x28));
        "DCA\0"u8.CopyTo(source.AsSpan(0x44));
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x48, 4), 8);
        compressed.CopyTo(source, 0x4C);
        trailing?.CopyTo(source, 0x4C + compressed.Length);
        return source;
    }
}

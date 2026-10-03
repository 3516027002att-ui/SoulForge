using System.Buffers.Binary;
using System.Reflection;
using System.Text;
using Xunit;

public sealed class MsbSourceSnapshotTests
{
    private static byte[] Read(Stream stream, CancellationToken token = default)
    {
        var type = typeof(BridgeCommandService).Assembly.GetType("MsbSourceSnapshotReader"); Assert.NotNull(type);
        var method = type!.GetMethod("Read", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static, new[] { typeof(Stream), typeof(CancellationToken) }); Assert.NotNull(method);
        try { return (byte[])method!.Invoke(null, new object[] { stream, token })!; }
        catch (TargetInvocationException error) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SparseOuterRejectsBeforeFullAllocationOrBodyRead(bool dcx)
    {
        var prefix = new byte[0x4C]; (dcx ? "DCX\0"u8 : "MSB "u8).CopyTo(prefix);
        var length = (dcx ? 512L : 128L) * 1024 * 1024 + 1;
        using var stream = new VirtualSource(prefix, length);
        var before = GC.GetAllocatedBytesForCurrentThread(); Assert.Throws<InvalidDataException>(() => Read(stream));
        Assert.True(GC.GetAllocatedBytesForCurrentThread() - before < 64 * 1024);
        Assert.InRange(stream.BytesRead, 0, prefix.Length);
        Assert.False(stream.Disposed);
    }

    [Fact]
    public void DeclaredOversizedLeafRejectsBeforeBodyReadOrDecode()
    {
        var prefix = new byte[0x104]; "DCX\0"u8.CopyTo(prefix); "DCS\0"u8.CopyTo(prefix.AsSpan(0x18)); "DCP\0"u8.CopyTo(prefix.AsSpan(0x24)); "DFLT"u8.CopyTo(prefix.AsSpan(0x28)); "DCA\0"u8.CopyTo(prefix.AsSpan(0x44));
        BinaryPrimitives.WriteUInt32BigEndian(prefix.AsSpan(0x1C), 128 * 1024 * 1024 + 1);
        BinaryPrimitives.WriteInt32BigEndian(prefix.AsSpan(0x20), 1); BinaryPrimitives.WriteInt32BigEndian(prefix.AsSpan(0x48), 8);
        using var stream = new VirtualSource(prefix, 1024 * 1024);
        var before = GC.GetAllocatedBytesForCurrentThread(); Assert.Throws<InvalidDataException>(() => Read(stream));
        Assert.True(GC.GetAllocatedBytesForCurrentThread() - before < 64 * 1024);
        Assert.Equal(prefix.Length, stream.BytesRead);
    }

    [Fact]
    public void ShortReadsPreserveExactSnapshotAndGrowthIsRejected()
    {
        var bytes = new byte[128]; "MSB "u8.CopyTo(bytes); for (var index = 4; index < bytes.Length; index++) bytes[index] = (byte)index;
        using var shortReads = new VirtualSource(bytes, bytes.Length, maxRead: 3); Assert.Equal(bytes, Read(shortReads));
        using var growth = new VirtualSource(bytes, bytes.Length - 1, maxRead: 3); Assert.Throws<InvalidDataException>(() => Read(growth));
        Assert.False(shortReads.Disposed); Assert.False(growth.Disposed);
    }

    [Fact]
    public void CancellationDoesNotReturnPartialSource()
    {
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        using var stream = new VirtualSource(new byte[128], 128);
        Assert.ThrowsAny<OperationCanceledException>(() => Read(stream, cancellation.Token)); Assert.Equal(0, stream.BytesRead);
    }

    [Fact]
    public void OpenedSourceGrowingPastRawBudgetRejectsBeforeFullAllocation()
    {
        var prefix = new byte[0x4C]; "MSB "u8.CopyTo(prefix);
        using var stream = new VirtualSource(prefix, 128, grownLength: 128L * 1024 * 1024 + 1);
        var before = GC.GetAllocatedBytesForCurrentThread(); Assert.Throws<InvalidDataException>(() => Read(stream));
        Assert.True(GC.GetAllocatedBytesForCurrentThread() - before < 64 * 1024);
    }

    [Fact]
    public void UnknownCodecRemainsDiagnosedByExistingDcxDecoder()
    {
        var bytes = new byte[0x4D]; "DCX\0"u8.CopyTo(bytes); "DCS\0"u8.CopyTo(bytes.AsSpan(0x18)); "DCP\0"u8.CopyTo(bytes.AsSpan(0x24)); "????"u8.CopyTo(bytes.AsSpan(0x28)); "DCA\0"u8.CopyTo(bytes.AsSpan(0x44));
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x1C), 129 * 1024 * 1024); BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x20), 1); BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x48), 8);
        using var source = new VirtualSource(bytes, bytes.Length); var snapshot = Read(source);
        var error = Assert.Throws<NotSupportedException>(() => NativeLeafPayload.Resolve(snapshot, "diagnostic-source.msb.dcx", null));
        Assert.Contains("????", error.Message); Assert.Equal(bytes, snapshot);
    }

    [Fact]
    public void LastLegalDcaMagicStillChecksLengthFieldBeforeAllocatingSnapshot()
    {
        var bytes = new byte[1024 * 1024]; "DCX\0"u8.CopyTo(bytes); "DCS\0"u8.CopyTo(bytes.AsSpan(0x18)); "DCP\0"u8.CopyTo(bytes.AsSpan(0x24)); "DFLT"u8.CopyTo(bytes.AsSpan(0x28)); "DCA\0"u8.CopyTo(bytes.AsSpan(0xFC));
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x1C), 128 * 1024 * 1024 + 1); BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x20), 1); BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x100), 8);
        using var source = new MemoryStream(bytes, writable: false);
        var before = GC.GetAllocatedBytesForCurrentThread(); Assert.Throws<InvalidDataException>(() => Read(source));
        Assert.True(GC.GetAllocatedBytesForCurrentThread() - before < 64 * 1024);
    }

    private sealed class VirtualSource(byte[] bytes, long length, int maxRead = int.MaxValue, long? grownLength = null) : Stream
    {
        public int BytesRead { get; private set; } public bool Disposed { get; private set; }
        public override int Read(Span<byte> target)
        {
            var count = Math.Min(Math.Min(target.Length, maxRead), bytes.Length - BytesRead);
            bytes.AsSpan(BytesRead, count).CopyTo(target); BytesRead += count; return count;
        }
        public override int Read(byte[] target, int offset, int count) => Read(target.AsSpan(offset, count));
        public override long Length => BytesRead > 0 && grownLength.HasValue ? grownLength.Value : length;
        public override long Position { get => BytesRead; set => throw new NotSupportedException(); }
        public override bool CanRead => true; public override bool CanSeek => true; public override bool CanWrite => false;
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] source, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }
}

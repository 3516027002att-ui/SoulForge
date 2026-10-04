using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using Xunit;

public sealed class TaeSharedTimeWriteTests
{
    private static void I32(byte[] b, int at, int value) => BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(at), value);
    private static void I64(byte[] b, int at, long value) => BinaryPrimitives.WriteInt64LittleEndian(b.AsSpan(at), value);
    private static void F32(byte[] b, int at, float value) => BinaryPrimitives.WriteSingleLittleEndian(b.AsSpan(at), value);

    // Literal SDT layout; expected offsets/bytes below are not obtained from the
    // product parser, writer, write plan or a round-trip of product output.
    private static byte[] Fixture()
    {
        var b = new byte[0x300]; "TAE "u8.CopyTo(b); b[7] = 0xff;
        I32(b, 8, 0x1000d); I32(b, 12, b.Length); I64(b, 0x10, 64); I64(b, 0x18, 1);
        I64(b, 0x20, 0x50); I64(b, 0x28, 0x80); I64(b, 0x30, 13);
        I32(b, 0x54, 2); I64(b, 0x58, 0x80); I64(b, 0x70, 2);
        I64(b, 0x80, 10); I64(b, 0x88, 0xa0); I64(b, 0x90, 20); I64(b, 0x98, 0xd0);
        I64(b, 0xa0, 0x120); I64(b, 0xa8, 0x1b0); I64(b, 0xb0, 0x100); I64(b, 0xb8, 0x280);
        I32(b, 0xc0, 2); I32(b, 0xc4, 1); I32(b, 0xc8, 4);
        I64(b, 0xd0, 0x150); I64(b, 0xd8, 0x230); I64(b, 0xe0, 0x110); I64(b, 0xe8, 0x290);
        I32(b, 0xf0, 2); I32(b, 0xf4, 1); I32(b, 0xf8, 4);
        F32(b, 0x100, 0); F32(b, 0x104, 1); F32(b, 0x108, .5f); F32(b, 0x10c, 2);
        F32(b, 0x110, 0); F32(b, 0x114, 2); F32(b, 0x118, 0); F32(b, 0x11c, 2);
        I64(b, 0x120, 0x100); I64(b, 0x128, 0x104); I64(b, 0x130, 0x180);
        I64(b, 0x138, 0x100); I64(b, 0x140, 0x10c); I64(b, 0x148, 0x190);
        I64(b, 0x150, 0x110); I64(b, 0x158, 0x114); I64(b, 0x160, 0x200);
        I64(b, 0x168, 0x110); I64(b, 0x170, 0x114); I64(b, 0x178, 0x210);
        I32(b, 0x180, 16); I32(b, 0x184, 0x556677);
        I32(b, 0x190, 700); I64(b, 0x198, 0x1a0); b.AsSpan(0x1a0, 16).Fill(0xa7);
        I64(b, 0x1b0, 2); I64(b, 0x1b8, 0x1d0); I64(b, 0x1c0, 0x1e0);
        I32(b, 0x1d0, 0x120); I32(b, 0x1d4, 0x138); I32(b, 0x1e0, 16);
        I32(b, 0x200, 16); I32(b, 0x210, 16);
        I64(b, 0x230, 2); I64(b, 0x238, 0x250); I64(b, 0x240, 0x260);
        I32(b, 0x250, 0x150); I32(b, 0x254, 0x168); I32(b, 0x260, 16);
        b.AsSpan(0x270, 16).Fill(0xd7); b.AsSpan(0x2a0).Fill(0xb5);
        return b;
    }

    private static object Update(long animId = 10, int eventIndex = 0, float start = .25f, float end = 1.5f) =>
        new { mutation = "update-event-times", animId, eventIndex, startTime = start, endTime = end };

    private static object Insert() => new { mutation = "insert-event", animId = 10, templateEventIndex = 0, startTime = 3f, endTime = 4f };

    private static byte[] ExpectedCow(byte[] before, int entry, int table, float[] times, int[] slots)
    {
        var b = new byte[0x300 + times.Length * 4]; before.CopyTo(b, 0);
        I32(b, 12, b.Length); I64(b, entry + 16, 0x300); I32(b, entry + 40, times.Length);
        for (var i = 0; i < times.Length; i++) F32(b, 0x300 + i * 4, times[i]);
        I64(b, table, 0x300 + slots[0] * 4); I64(b, table + 8, 0x300 + slots[1] * 4);
        I64(b, table + 24, 0x300 + slots[2] * 4); I64(b, table + 32, 0x300 + slots[3] * 4);
        return b;
    }

    [Fact]
    public async Task SharedStartCopiesCompleteTimeTableAndPreservesAllOtherBytes()
    {
        var source = Fixture(); using var files = new WriterFiles(source);
        var receipt = await files.Write(Update());
        Assert.False(receipt.GetProperty("byteSurgical").GetBoolean());
        Assert.Equal(ExpectedCow(source, 0xa0, 0x120, [0, .25f, 1.5f, 2], [1, 2, 0, 3]), await files.ReadOutput());
        Assert.Equal(source, await File.ReadAllBytesAsync(files.Source));
    }

    [Fact]
    public async Task CrossAnimationSharedSlotDoesNotChangeItsOriginalOwner()
    {
        var source = Fixture(); I64(source, 0x150, 0x100); using var files = new WriterFiles(source);
        await files.Write(Update(20, 0, .75f, 1.5f));
        Assert.Equal(ExpectedCow(source, 0xd0, 0x150, [0, .75f, 1.5f, 2], [1, 2, 0, 3]), await files.ReadOutput());
    }

    [Fact]
    public async Task PointEventCanSplitItsSharedStartAndEndPointers()
    {
        var source = Fixture(); I64(source, 0x128, 0x100); using var files = new WriterFiles(source);
        await files.Write(Update());
        Assert.Equal(ExpectedCow(source, 0xa0, 0x120, [0, .25f, 1.5f, 2], [1, 2, 0, 3]), await files.ReadOutput());
    }

    [Fact]
    public async Task RepeatedUpdateUsesOneFinalTableAndTheLastValues()
    {
        var source = Fixture(); using var files = new WriterFiles(source);
        await files.Write(Update(), Update(start: .5f, end: 1.75f));
        Assert.Equal(ExpectedCow(source, 0xa0, 0x120, [0, .5f, 1.75f, 2], [1, 2, 0, 3]), await files.ReadOutput());
    }

    [Fact]
    public async Task UnsharedUpdateRetainsTheOriginalInPlaceContract()
    {
        var source = Fixture(); I64(source, 0x138, 0x108); using var files = new WriterFiles(source);
        var receipt = await files.Write(Update());
        var expected = (byte[])source.Clone(); F32(expected, 0x100, .25f); F32(expected, 0x104, 1.5f);
        Assert.True(receipt.GetProperty("byteSurgical").GetBoolean());
        Assert.Equal(expected, await files.ReadOutput());
    }

    [Fact]
    public async Task EmptyAnimationNameAliasGetsAnExplicitEmptyString()
    {
        var source = Fixture(); UseEmptyNameAlias(source);
        I64(source, 0x138, 0x108); I64(source, 0x150, 0x100); // Cross-animation shared start forces COW.
        using var files = new WriterFiles(source); await files.Write(Update(start: .3f));
        var expected = ExpectedCow(source, 0xa0, 0x120, [.3f, .5f, 1.5f, 2], [0, 2, 1, 3]);
        // The new first float .3 has nonzero low bytes and must not be treated
        // as UTF-16 text. Use an explicit empty string instead of a new alias.
        Array.Resize(ref expected, 0x318); I32(expected, 12, 0x318); I64(expected, 0x2b0, 0x310);
        var output = await files.ReadOutput(); Assert.Equal(expected, output);
        // Product ReadNameUtf16Z normalizes a leading NUL to null; the external
        // reader normalizes the same native empty string to String.Empty.
        Assert.Null(TaeNativeDocument.Read(source).Animations.Single(a => a.AnimId == 10).HkxName);
        Assert.Null(TaeNativeDocument.Read(output).Animations.Single(a => a.AnimId == 10).HkxName);
    }

    [Fact]
    public async Task SharedMiniheaderNameAliasRemainsBlockedInsteadOfChangingAnotherAnimation()
    {
        var source = Fixture(); UseEmptyNameAlias(source); I64(source, 0xe8, 0x2a0);
        using var files = new WriterFiles(source);
        var error = await Assert.ThrowsAsync<TaeWriteBlockedException>(() => files.Write(Update()));
        Assert.Equal("TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE", error.Code);
        Assert.False(File.Exists(files.Output));
    }

    private static void UseEmptyNameAlias(byte[] source)
    {
        I64(source, 0xb8, 0x2a0); source.AsSpan(0x2a0, 0x30).Clear();
        I64(source, 0x2a8, 0x2b0); I64(source, 0x2b0, 0x100);
    }

    [Fact]
    public async Task SharedNoOpDoesNotGrowTheDocument()
    {
        var source = Fixture(); using var files = new WriterFiles(source);
        var receipt = await files.Write(Update(start: 0, end: 1));
        Assert.True(receipt.GetProperty("byteSurgical").GetBoolean());
        Assert.Equal(source, await files.ReadOutput());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TimesAndInsertionShareOneTableRegardlessOfRequestOrder(bool insertFirst)
    {
        var source = Fixture(); using var files = new WriterFiles(source);
        await files.Write(insertFirst ? [Insert(), Update()] : [Update(), Insert()]);
        // Six final time values occupy 0x300..0x318. Event data, groups and
        // the final three headers follow at literal offsets; old bytes stay put.
        var expected = new byte[0x3c8]; source.CopyTo(expected, 0);
        I32(expected, 12, 0x3c8); I64(expected, 0xa0, 0x380); I64(expected, 0xa8, 0x358);
        I64(expected, 0xb0, 0x300); I32(expected, 0xc0, 3); I32(expected, 0xc8, 6);
        float[] times = [0, .25f, 1.5f, 2, 3, 4];
        for (var i = 0; i < times.Length; i++) F32(expected, 0x300 + i * 4, times[i]);
        source.AsSpan(0x180, 16).CopyTo(expected.AsSpan(0x318));
        source.AsSpan(0x190, 32).CopyTo(expected.AsSpan(0x328)); I64(expected, 0x330, 0x338);
        source.AsSpan(0x180, 16).CopyTo(expected.AsSpan(0x348));
        source.AsSpan(0x1b0, 32).CopyTo(expected.AsSpan(0x358)); I64(expected, 0x360, 0x378);
        I32(expected, 0x378, 0x380); I32(expected, 0x37c, 0x398);
        I64(expected, 0x380, 0x304); I64(expected, 0x388, 0x308); I64(expected, 0x390, 0x318);
        I64(expected, 0x398, 0x300); I64(expected, 0x3a0, 0x30c); I64(expected, 0x3a8, 0x328);
        I64(expected, 0x3b0, 0x310); I64(expected, 0x3b8, 0x314); I64(expected, 0x3c0, 0x348);
        Assert.Equal(expected, await files.ReadOutput());
    }

    [Theory]
    [InlineData("unowned-time-pointer")]
    [InlineData("unaligned-time-pointer")]
    [InlineData("unbounded-parameter-tail")]
    [InlineData("unbounded-zero-parameter-tail")]
    [InlineData("nonfinite-sibling")]
    [InlineData("overlapping-time-table")]
    [InlineData("time-table-in-event-data")]
    public async Task UnknownLayoutsDoNotOverwriteExistingOutput(string kind)
    {
        var source = Fixture();
        if (kind == "unowned-time-pointer") I64(source, 0x138, 0x2a0);
        if (kind == "unaligned-time-pointer") I64(source, 0x138, 0x101);
        if (kind == "unbounded-parameter-tail") { I64(source, 0xa8, 0); I32(source, 0xc4, 0); }
        if (kind == "unbounded-zero-parameter-tail") { I64(source, 0xd8, 0); I32(source, 0xf4, 0); }
        if (kind == "nonfinite-sibling") F32(source, 0x10c, float.NaN);
        if (kind == "overlapping-time-table") { I64(source, 0xb0, 0x120); I32(source, 0xc8, 4); }
        if (kind == "time-table-in-event-data")
        {
            I64(source, 0xb0, 0x180); I32(source, 0xc8, 8);
            I64(source, 0x120, 0x180); I64(source, 0x128, 0x184);
            I64(source, 0x138, 0x190); I64(source, 0x140, 0x194);
        }
        using var files = new WriterFiles(source); await File.WriteAllBytesAsync(files.Output, [7, 8, 9]);
        // Insertion always requires a new complete time table, even when the
        // corrupted sibling no longer shares the selected start slot.
        var error = await Assert.ThrowsAsync<TaeWriteBlockedException>(() => files.Write(Update(), Insert()));
        Assert.Equal("TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE", error.Code);
        Assert.Equal(new byte[] { 7, 8, 9 }, await files.ReadOutput());
        Assert.Equal(source, await File.ReadAllBytesAsync(files.Source));
    }

    [Fact]
    public async Task StaleHashAndInvalidRangeRemainFailClosed()
    {
        var source = Fixture(); using var files = new WriterFiles(source);
        await File.WriteAllBytesAsync(files.Output, [7, 8, 9]);
        await Assert.ThrowsAsync<InvalidDataException>(() => files.WriteWithHash(new string('0', 64), Update()));
        await Assert.ThrowsAsync<InvalidDataException>(() => files.Write(Update(start: 2, end: 1)));
        Assert.Equal(new byte[] { 7, 8, 9 }, await files.ReadOutput());
    }

    private sealed class WriterFiles : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "sf-tae-cow-" + Guid.NewGuid().ToString("N"));
        private readonly string hash;
        public string Source => Path.Combine(root, "source.tae");
        public string Output => Path.Combine(root, "output.tae");
        public WriterFiles(byte[] source)
        {
            Directory.CreateDirectory(root); File.WriteAllBytes(Source, source);
            hash = Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant();
        }
        public Task<JsonElement> Write(params object[] mutations) => WriteWithHash(hash, mutations);
        public async Task<JsonElement> WriteWithHash(string expectedDocumentHash, params object[] mutations)
        {
            var options = JsonSerializer.SerializeToElement(new { expectedDocumentHash, mutations });
            return JsonSerializer.SerializeToElement(await TaeNativeWriter.WriteAsync(Source, Output, options, CancellationToken.None));
        }
        public Task<byte[]> ReadOutput() => File.ReadAllBytesAsync(Output);
        public void Dispose() => Directory.Delete(root, recursive: true);
    }
}

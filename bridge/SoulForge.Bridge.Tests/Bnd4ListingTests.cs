using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

public sealed class Bnd4ListingTests
{
    private const long MaxLooseBnd4Bytes = 64L * 1024 * 1024;

    [Fact]
    public async Task ListsCompleteLooseBinderWithTruthfulSourceMetadataWithoutWritingIt()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-loose-bnd4-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var source = Path.Combine(root, "fixture.anibnd");
        var bytes = MakeBinder();
        await File.WriteAllBytesAsync(source, bytes);
        using var options = JsonDocument.Parse("{\"includeContentHashes\":true}");
        try
        {
            var result = await new BridgeCommandService().ExecuteAsync("list-bnd4-entries", source,
                CancellationToken.None, options: options.RootElement);
            Assert.Equal("partial", result.ParseStatus);
            Assert.Contains(result.Diagnostics, item => item.Code == "BND4_ENTRIES_LISTED");
            var data = JsonSerializer.SerializeToElement(result.Data);
            Assert.Equal("BND4", data.GetProperty("format").GetString());
            Assert.Equal(bytes.Length, data.GetProperty("sourceSize").GetInt32());
            Assert.Equal(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), data.GetProperty("sourceHash").GetString());
            Assert.Equal(JsonValueKind.Null, data.GetProperty("compressionFormat").ValueKind);
            Assert.Equal(2, data.GetProperty("entryCount").GetInt32());
            var entries = data.GetProperty("entries").EnumerateArray().ToArray();
            Assert.Equal(new[] { "first.lua", "second.lua" }, entries.Select(entry => entry.GetProperty("name").GetString()));
            Assert.Equal(new[] { 0, 1 }, entries.Select(entry => entry.GetProperty("index").GetInt32()));
            Assert.Equal(new[] { 10, 11 }, entries.Select(entry => entry.GetProperty("id").GetInt32()));
            Assert.Equal(new[] { 4, 4 }, entries.Select(entry => entry.GetProperty("compressedSize").GetInt32()));
            Assert.Equal(new[] { 4, 4 }, entries.Select(entry => entry.GetProperty("uncompressedSize").GetInt32()));
            Assert.Equal(new[] { HashAscii("one\n"), HashAscii("two\n") },
                entries.Select(entry => entry.GetProperty("contentHash").GetString()));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(source));
            Assert.Equal(new[] { source }, Directory.GetFiles(root));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task RejectsOversizedLooseBinderBeforeAllocatingOrParsingIt()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-loose-bnd4-limit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var source = Path.Combine(root, "sparse.bin");
        try
        {
            // SetLength creates a sparse logical file; only write its eight-byte
            // probe/header so the test never needs a 64 MiB managed buffer.
            await using (var stream = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            {
                stream.SetLength(MaxLooseBnd4Bytes + 1);
                await stream.WriteAsync("BND4\0\0\0\0"u8.ToArray());
            }

            Assert.True(LargeResourceReadCache.RequiresCache(source),
                "Oversized BND4 is normally intercepted by the existing read-only large-resource dispatcher; this unit test targets the list-only loose reader below that dispatch boundary.");
            var error = await Assert.ThrowsAsync<InvalidDataException>(
                () => BridgeCommandService.ReadLooseBnd4ForListingAsync(source, CancellationToken.None));
            Assert.Contains("64 MiB", error.Message, StringComparison.Ordinal);
            Assert.Equal(MaxLooseBnd4Bytes + 1, new FileInfo(source).Length);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task ExistingDcxListingStillUsesItsCurrentRoute()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-loose-bnd4-dcx-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var source = Path.Combine(root, "fixture.anibnd.dcx");
        var binder = MakeBinder();
        var bytes = WrapDcx(binder);
        await File.WriteAllBytesAsync(source, bytes);
        try
        {
            var result = await new BridgeCommandService().ExecuteAsync(
                "list-bnd4-entries", source, CancellationToken.None);
            Assert.Equal("partial", result.ParseStatus);
            var data = JsonSerializer.SerializeToElement(result.Data);
            Assert.Equal("DCX", data.GetProperty("format").GetString());
            Assert.Equal(bytes.Length, data.GetProperty("sourceSize").GetInt32());
            Assert.Equal("DFLT", data.GetProperty("compressionFormat").GetString());
            Assert.Equal(2, data.GetProperty("entryCount").GetInt32());
            Assert.Equal(bytes, await File.ReadAllBytesAsync(source));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static byte[] WrapDcx(byte[] binder)
    {
        using var output = new MemoryStream();
        using (var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true)) zlib.Write(binder);
        var compressed = output.ToArray();
        var bytes = new byte[0x4C + compressed.Length];
        "DCX\0"u8.CopyTo(bytes);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(4), 0x10000);
        "DCS\0"u8.CopyTo(bytes.AsSpan(0x18));
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x1C), binder.Length);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x20), compressed.Length);
        "DCP\0"u8.CopyTo(bytes.AsSpan(0x24));
        "DFLT"u8.CopyTo(bytes.AsSpan(0x28));
        "DCA\0"u8.CopyTo(bytes.AsSpan(0x44));
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0x48), 8);
        compressed.CopyTo(bytes, 0x4C);
        return bytes;
    }

    private static byte[] MakeBinder()
    {
        var names = new[] { "first.lua", "second.lua" }.Select(name => Encoding.UTF8.GetBytes(name + '\0')).ToArray();
        var tableEnd = 0x40 + 2 * 0x24;
        var dataOffset = (tableEnd + names.Sum(name => name.Length) + 15) & ~15;
        var bytes = new byte[dataOffset + 32];
        "BND4"u8.CopyTo(bytes);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(0x0C), 2);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x10), 0x40);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x20), 0x24);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x28), dataOffset);
        var nameOffset = tableEnd;
        for (var index = 0; index < 2; index++)
        {
            var entry = bytes.AsSpan(0x40 + index * 0x24, 0x24);
            BinaryPrimitives.WriteInt64LittleEndian(entry[8..], 4);
            BinaryPrimitives.WriteInt64LittleEndian(entry[16..], 4);
            BinaryPrimitives.WriteUInt32LittleEndian(entry[24..], (uint)(dataOffset + index * 16));
            BinaryPrimitives.WriteInt32LittleEndian(entry[28..], index + 10);
            BinaryPrimitives.WriteUInt32LittleEndian(entry[32..], (uint)nameOffset);
            names[index].CopyTo(bytes.AsSpan(nameOffset));
            nameOffset += names[index].Length;
            Encoding.ASCII.GetBytes(index == 0 ? "one\n" : "two\n").CopyTo(bytes.AsSpan(dataOffset + index * 16));
        }
        return bytes;
    }

    private static string HashAscii(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(value))).ToLowerInvariant();
}

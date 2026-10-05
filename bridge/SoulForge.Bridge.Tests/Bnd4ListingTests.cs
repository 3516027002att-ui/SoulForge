using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

public sealed class Bnd4ListingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ListsCompleteLooseOrDcxBinderWithTruthfulSourceMetadata(bool wrapped)
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-loose-bnd4-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        // This is a constructed native-layout fixture, not private game corpus.
        var source = Path.Combine(root, "fixture.anibnd");
        var binder = MakeBinder();
        var bytes = wrapped ? WrapDcx(binder) : binder;
        await File.WriteAllBytesAsync(source, bytes);
        using var options = JsonDocument.Parse("{\"includeContentHashes\":true}");
        try
        {
            var result = await new BridgeCommandService().ExecuteAsync("list-bnd4-entries", source,
                CancellationToken.None, options: options.RootElement);
            Assert.Equal("partial", result.ParseStatus);
            Assert.Contains(result.Diagnostics, item => item.Code == "BND4_ENTRIES_LISTED");
            var data = JsonSerializer.SerializeToElement(result.Data);
            Assert.Equal(wrapped ? "DCX" : "BND4", data.GetProperty("format").GetString());
            Assert.Equal(bytes.Length, data.GetProperty("sourceSize").GetInt32());
            Assert.Equal(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), data.GetProperty("sourceHash").GetString());
            if (wrapped) Assert.Equal("DFLT", data.GetProperty("compressionFormat").GetString());
            else Assert.Equal(JsonValueKind.Null, data.GetProperty("compressionFormat").ValueKind);
            Assert.Equal(2, data.GetProperty("entryCount").GetInt32());
            var entries = data.GetProperty("entries").EnumerateArray().ToArray();
            Assert.Equal(new[] { "first.lua", "second.lua" }, entries.Select(entry => entry.GetProperty("name").GetString()));
            Assert.All(entries, entry => Assert.Equal(64, entry.GetProperty("contentHash").GetString()!.Length));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(source));
            Assert.Equal(new[] { source }, Directory.GetFiles(root));
        }
        finally { Directory.Delete(root, true); }
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
            Encoding.ASCII.GetBytes("lua\n").CopyTo(bytes.AsSpan(dataOffset + index * 16));
        }
        return bytes;
    }
}

using System.Buffers.Binary;
using System.Text;
using Xunit;

public sealed class LuabndExportBoundaryTests
{
    [Theory]
    [InlineData("test.lua")]
    [InlineData("luabnd.manifest.json")]
    public async Task ExportRefusesExistingChildLinksOutsideStaging(string outputName)
    {
        if (OperatingSystem.IsWindows()) return; // Windows link privileges vary; Linux exercises the native link operation.
        var root = Path.Combine(Path.GetTempPath(), "sf-lua-export-" + Guid.NewGuid());
        var staging = Path.Combine(root, "staging"); Directory.CreateDirectory(staging);
        var outside = Path.Combine(root, "outside"); await File.WriteAllTextAsync(outside, "outside-original");
        File.CreateSymbolicLink(Path.Combine(staging, outputName), outside);
        try
        {
            var document = LuabndNativeDocument.ReadBytes(SyntheticScriptBinder());
            Assert.Throws<InvalidDataException>(() => document.ExportAll(staging));
            Assert.Equal("outside-original", await File.ReadAllTextAsync(outside));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task ExportStillWritesIntoNormalHostStaging()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-lua-export-valid-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            LuabndNativeDocument.ReadBytes(SyntheticScriptBinder()).ExportAll(root);
            Assert.Equal("return 1\n", await File.ReadAllTextAsync(Path.Combine(root, "test.lua")));
            Assert.True(File.Exists(Path.Combine(root, "luabnd.manifest.json")));
        }
        finally { Directory.Delete(root, true); }
    }

    internal static byte[] SyntheticScriptBinder()
    {
        var name = Encoding.UTF8.GetBytes("test.lua\0"); var payload = Encoding.UTF8.GetBytes("return 1\n");
        const int header = 0x40, entry = 0x24; var namesOffset = header + entry; var dataOffset = namesOffset + name.Length;
        var bytes = new byte[dataOffset + payload.Length]; "BND4"u8.CopyTo(bytes);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(0x0c), 1);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x10), header);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x20), entry);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x28), dataOffset);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(header), 0x40);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(header + 4), -1);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(header + 8), payload.Length);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(header + 0x10), payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(header + 0x18), (uint)dataOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(header + 0x20), (uint)namesOffset);
        name.CopyTo(bytes, namesOffset); payload.CopyTo(bytes, dataOffset); return bytes;
    }
}

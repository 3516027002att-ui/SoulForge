using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using Xunit;

public sealed class MapKrakDiagnosticTests
{
    [Theory]
    [InlineData("read-msb-document", "map.msb.dcx", "MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE")]
    [InlineData("read-map-static-geometry", "map.mapbnd.dcx", "MAPBND_KRAK_OODLE_UNAVAILABLE")]
    [InlineData("read-map-part-flver-preview", "map.mapbnd.dcx", "MAPBND_KRAK_OODLE_UNAVAILABLE")]
    public async Task UnavailableKrakPreservesCodeAndGivesPlatformAppropriateNextStep(
        string command, string name, string expectedCode)
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-map-krak-message-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, name);
        // Structurally valid outer header. With no game root, admission must
        // stop before any vendor library or compressed-payload decoding.
        var source = MakeUnavailableKrak();
        await File.WriteAllBytesAsync(path, source);
        try
        {
            using var options = JsonDocument.Parse("{\"modelName\":\"m000000\"}");
            var result = await new BridgeCommandService().ExecuteAsync(
                command, path, CancellationToken.None, options: options.RootElement);
            Assert.Equal("failed", result.ParseStatus);
            Assert.Equal("map", result.ResourceKind);
            var diagnostic = Assert.Single(result.Diagnostics);
            Assert.Equal(expectedCode, diagnostic.Code);
            if (OperatingSystem.IsWindows())
            {
                Assert.Equal(command == "read-msb-document"
                    ? "这份地图是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。"
                    : "这份地图模型（mapbnd）是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再看模型。", diagnostic.Message);
                Assert.DoesNotContain("当前平台没有可用", diagnostic.Message);
            }
            else
            {
                Assert.Contains("当前平台没有可用", diagnostic.Message);
                Assert.Contains("已解压", diagnostic.Message);
                Assert.Contains("Windows", diagnostic.Message);
                Assert.DoesNotContain("选择含 sekiro.exe 的原版目录", diagnostic.Message);
                if (command == "read-map-part-flver-preview")
                    Assert.DoesNotContain("FLVER", diagnostic.Message);
                if (command == "read-map-static-geometry")
                    Assert.Contains("FLVER", diagnostic.Message);
            }
            Assert.Equal(SHA256.HashData(source), SHA256.HashData(await File.ReadAllBytesAsync(path)));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static byte[] MakeUnavailableKrak()
    {
        var source = new byte[0x4C + 2];
        "DCX\0"u8.CopyTo(source);
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(4, 4), 0x11000);
        "DCS\0"u8.CopyTo(source.AsSpan(0x18));
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x1C, 4), 1);
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x20, 4), 2);
        "DCP\0"u8.CopyTo(source.AsSpan(0x24));
        "KRAK"u8.CopyTo(source.AsSpan(0x28));
        "DCA\0"u8.CopyTo(source.AsSpan(0x44));
        BinaryPrimitives.WriteInt32BigEndian(source.AsSpan(0x48, 4), 8);
        return source;
    }
}

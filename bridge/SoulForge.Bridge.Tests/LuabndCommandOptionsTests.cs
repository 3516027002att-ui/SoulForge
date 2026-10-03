using System.Text.Json;
using Xunit;

public sealed class LuabndCommandOptionsTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "sf-luabnd-options-" + Guid.NewGuid());
    private readonly string source;
    private readonly string output;

    public LuabndCommandOptionsTests()
    {
        Directory.CreateDirectory(root);
        source = Path.Combine(root, "fixture.luabnd");
        output = Path.Combine(root, "export");
        File.WriteAllBytes(source, LuabndExportBoundaryTests.SyntheticScriptBinder());
    }

    [Fact]
    public async Task MissingReadOptionsReturnSelectorDiagnostic()
    {
        var result = await new BridgeCommandService().ExecuteAsync("read-luabnd-script", source, CancellationToken.None);
        Assert.Contains(result.Diagnostics, item => item.Code == "LUABND_SELECTOR_REQUIRED");
    }

    [Theory]
    [InlineData("{\"childPath\":123}", "childPath")]
    [InlineData("{\"entryIndex\":\"zero\"}", "entryIndex")]
    [InlineData("{\"entryIndex\":0.5}", "entryIndex")]
    [InlineData("{\"entryIndex\":0,\"expectedContainerHash\":123}", "expectedContainerHash")]
    [InlineData("{\"entryIndex\":0,\"expectedChildHash\":true}", "expectedChildHash")]
    public async Task WrongReadOptionTypesReturnStructuredFailure(string json, string name)
    {
        using var options = JsonDocument.Parse(json);
        var result = await new BridgeCommandService().ExecuteAsync("read-luabnd-script", source, CancellationToken.None, options: options.RootElement);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("LUABND_SCRIPT_READ_FAILED", diagnostic.Code);
        Assert.Contains("BRIDGE_OPTIONS_INVALID", diagnostic.Message);
        Assert.Contains(name, diagnostic.Message);
    }

    [Theory]
    [InlineData("{\"entryIndex\":0}")]
    [InlineData("{\"childPath\":\"test.lua\"}")]
    public async Task ValidReadSelectorsStillReturnTheScript(string json)
    {
        using var options = JsonDocument.Parse(json);
        var result = await new BridgeCommandService().ExecuteAsync("read-luabnd-script", source, CancellationToken.None, options: options.RootElement);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("return 1\n", Assert.IsType<LuabndScriptDetail>(result.Data).TextContent);
    }

    [Theory]
    [InlineData("expectedContainerHash", "LUABND_CONTAINER_HASH_MISMATCH")]
    [InlineData("expectedChildHash", "LUABND_CHILD_HASH_MISMATCH")]
    public async Task ExpectedHashChecksStillRejectStaleReads(string name, string code)
    {
        using var options = JsonDocument.Parse(JsonSerializer.Serialize(new Dictionary<string, object> {
            ["entryIndex"] = 0, [name] = new string('0', 64)
        }));
        var result = await new BridgeCommandService().ExecuteAsync("read-luabnd-script", source, CancellationToken.None, options: options.RootElement);
        Assert.Contains(result.Diagnostics, item => item.Code == code);
    }

    [Fact]
    public async Task MatchingContainerAndChildHashesStillAllowReads()
    {
        var document = LuabndNativeDocument.Read(source);
        var script = document.ReadScript("0");
        using var options = JsonDocument.Parse(JsonSerializer.Serialize(new {
            entryIndex = 0, expectedContainerHash = document.SourceHash, expectedChildHash = script.ContentHash
        }));
        var result = await new BridgeCommandService().ExecuteAsync("read-luabnd-script", source, CancellationToken.None, options: options.RootElement);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(script.ContentHash, Assert.IsType<LuabndScriptDetail>(result.Data).ContentHash);
    }

    [Fact]
    public async Task MissingExportOptionsIncludeMetadataByDefault()
    {
        var result = await new BridgeCommandService().ExecuteAsync("export-luabnd", source, CancellationToken.None, outputPath: output);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("return 1\n", await File.ReadAllTextAsync(Path.Combine(output, "test.lua")));
        Assert.True(File.Exists(Path.Combine(output, "luabnd.manifest.json")));
    }

    [Theory]
    [InlineData("{\"includeMetadataJson\":123}")]
    [InlineData("{\"includeMetadataJson\":\"false\"}")]
    [InlineData("{\"includeMetadataJson\":null}")]
    public async Task WrongExportOptionTypesFailBeforeWriting(string json)
    {
        using var options = JsonDocument.Parse(json);
        var result = await new BridgeCommandService().ExecuteAsync("export-luabnd", source, CancellationToken.None, options: options.RootElement, outputPath: output);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("LUABND_EXPORT_FAILED", diagnostic.Code);
        Assert.Contains("BRIDGE_OPTIONS_INVALID", diagnostic.Message);
        Assert.Contains("includeMetadataJson", diagnostic.Message);
        Assert.False(Directory.Exists(output));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExplicitExportMetadataChoiceIsHonored(bool includeMetadata)
    {
        using var options = JsonDocument.Parse(JsonSerializer.Serialize(new { includeMetadataJson = includeMetadata }));
        var result = await new BridgeCommandService().ExecuteAsync("export-luabnd", source, CancellationToken.None, options: options.RootElement, outputPath: output);
        Assert.Empty(result.Diagnostics);
        Assert.True(File.Exists(Path.Combine(output, "test.lua")));
        Assert.Equal(includeMetadata, File.Exists(Path.Combine(output, "luabnd.manifest.json")));
    }

    [Theory]
    [InlineData("read-luabnd-script", "null", "LUABND_SCRIPT_READ_FAILED")]
    [InlineData("read-luabnd-script", "123", "LUABND_SCRIPT_READ_FAILED")]
    [InlineData("export-luabnd", "[]", "LUABND_EXPORT_FAILED")]
    [InlineData("export-luabnd", "true", "LUABND_EXPORT_FAILED")]
    public async Task NonObjectOptionsReturnStructuredFailure(string command, string json, string code)
    {
        using var options = JsonDocument.Parse(json);
        var result = await new BridgeCommandService().ExecuteAsync(command, source, CancellationToken.None, options: options.RootElement, outputPath: output);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal(code, diagnostic.Code);
        Assert.Contains("BRIDGE_OPTIONS_INVALID", diagnostic.Message);
        Assert.False(Directory.Exists(output));
    }

    public void Dispose() => Directory.Delete(root, true);
}

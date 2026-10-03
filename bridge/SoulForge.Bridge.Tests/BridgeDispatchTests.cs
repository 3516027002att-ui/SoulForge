using Xunit;

public sealed class BridgeDispatchTests
{
    [Fact]
    public async Task EveryDescriptorReachesAnActualDispatchBranchWithoutFileIo()
    {
        var service = new BridgeCommandService();
        foreach (var descriptor in BridgeCommandDescriptorCatalog.All.Where(item => item.IsServiceDispatch))
        {
            var result = await service.ProbeDispatchAsync(descriptor.Name);
            Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Code == "BRIDGE_COMMAND_DISPATCH_BOUND");
        }
        await BridgeCommandDispatchVerification.VerifyAsync(BridgeCommandDescriptorCatalog.All);
    }

    [Fact]
    public async Task DescriptorWithoutDispatchIsRejectedByActualDispatchVerification()
    {
        var declaredOnly = new BridgeCommandDescriptor { Name = "descriptor-without-handler", Effect = "read", Advertised = true, RequiredInputFields = new[] { "command", "filePath" }, RequiresOutputPath = false, CostClass = "interactive", CancelMode = "cooperative", Handler = "BridgeCommandService.ExecuteAsync" };
        await Assert.ThrowsAsync<InvalidOperationException>(() => BridgeCommandDispatchVerification.VerifyAsync(new[] { declaredOnly }));
    }

    [Fact]
    public void MalformedNativeFormatsFailClosed()
    {
        Assert.Throws<InvalidDataException>(() => DcxNativeDocument.Read(new byte[80]));
        Assert.Throws<InvalidDataException>(() => Bnd4NativeDocument.Read(new byte[80]));
        Assert.Throws<InvalidDataException>(() => FlverNativeDocument.Read(new byte[80]));
    }

    [Fact]
    public async Task PublicCommandOptionsCannotEnableTheInternalDispatchProbe()
    {
        using var json = System.Text.Json.JsonDocument.Parse("{\"dispatchProbe\":true}");
        var result = await new BridgeCommandService().ExecuteAsync("write-fmg", "missing-dispatch-probe.fmg", CancellationToken.None, options: json.RootElement);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Code == "BRIDGE_COMMAND_DISPATCH_BOUND");
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Code == "FILE_NOT_FOUND");
    }
    [Fact]
    public async Task StandaloneDiskCommandsRejectOptionsSuppliedOutputsBeforeParsing()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-cli-output-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        var source = Path.Combine(root, "fixture.luabnd");
        await File.WriteAllBytesAsync(source, new byte[] { 1, 2, 3 });
        using var json = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new {
            outputPath = Path.Combine(root, "untrusted-output"), outputDirectory = Path.Combine(root, "untrusted-export") }));
        try
        {
            foreach (var descriptor in BridgeCommandDescriptorCatalog.All.Where(item => item.RequiresOutputPath))
            {
                var result = await new BridgeCommandService().ExecuteAsync(descriptor.Name, source, CancellationToken.None, options: json.RootElement);
                Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Code == "BRIDGE_OUTPUT_PATH_REQUIRED");
            }
            Assert.Equal(new[] { source }, Directory.GetFiles(root));
            Assert.Empty(Directory.GetDirectories(root));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task ArtifactDescriptorCannotBindToAServiceOnlyCommand()
    {
        var wrongRoute = new BridgeCommandDescriptor { Name = "inspect", Effect = "read", Advertised = true,
            RequiredInputFields = new[] { "command", "filePath" }, RequiresOutputPath = false,
            CostClass = "interactive", CancelMode = "cooperative", Handler = "BridgeDaemonHost.DaemonState.ReadArtifactAsync" };
        await Assert.ThrowsAsync<InvalidOperationException>(() => BridgeCommandDispatchVerification.VerifyAsync(new[] { wrongRoute }));
    }

}

using Xunit;

public sealed class LargeResourceReadCacheTests
{
    [Theory]
    [InlineData("texture.tpf.dcx", "DCX\0")]
    [InlineData("model.flver.dcx", "DCX\0")]
    [InlineData("events.emevd.dcx", "DCX\0")]
    [InlineData("unknown.dcx", "DCX\0")]
    [InlineData("misnamed.chrbnd.dcx", "TPF\0")]
    [InlineData("misnamed.chrbnd", "TPF\0")]
    public void OversizedStandaloneOrMisnamedResourcesStayOnTheirNativeRoute(string name, string magic)
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-route-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, name);
            using (var stream = File.Create(source))
            {
                stream.Write(System.Text.Encoding.ASCII.GetBytes(magic));
                stream.SetLength(LargeResourceReadCache.MaxLeafBytes + 1);
            }
            Assert.False(LargeResourceReadCache.RequiresCache(source));
        }
        finally { Directory.Delete(root, true); }
    }

    [Theory]
    [InlineData("container.bin", "BND4", true)]
    [InlineData("c0000.CHRBND.DCX", "DCX\0", true)]
    [InlineData("container.chrbnd.dcx", "DCX\0", false)]
    public void CacheRoutingKeepsBoundedBinderDetectionAndTheSizeThreshold(string name, string magic, bool oversized)
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-binder-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, name);
            using (var stream = File.Create(source))
            {
                stream.Write(System.Text.Encoding.ASCII.GetBytes(magic));
                stream.SetLength(oversized ? LargeResourceReadCache.MaxLeafBytes + 1 : LargeResourceReadCache.MaxLeafBytes);
            }
            Assert.Equal(oversized, LargeResourceReadCache.RequiresCache(source));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task ImportedToolIdentityAlwaysHashesTheExecutableUnderHostPathSemantics()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-executable-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        var executable = Path.Combine(root, "WitchyBND.exe");
        await File.WriteAllBytesAsync(executable, new byte[] { 1, 2, 3 });
        await File.WriteAllBytesAsync(Path.Combine(root, "unchanged.dll"), new byte[] { 4, 5, 6 });
        try
        {
            var configured = OperatingSystem.IsWindows() ? executable.ToLowerInvariant() : executable;
            var tool = new WitchyBndReadOnlyUnpacker(configured);
            var original = tool.Identity;
            await File.WriteAllBytesAsync(executable, new byte[] { 7, 8, 9 });
            Assert.NotEqual(original, tool.Identity);
            Assert.Equal(new WitchyBndReadOnlyUnpacker(executable).Identity, tool.Identity);
            if (!OperatingSystem.IsWindows())
                Assert.Equal("LARGE_RESOURCE_UNPACKER_MISSING", Assert.Throws<LargeResourceCacheException>(
                    () => new WitchyBndReadOnlyUnpacker(Path.Combine(root, "witchybnd.exe")).Identity).Code);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task UnpackCacheIsContentBoundAndNeverPassesTheOriginalToTheTool()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-" + Guid.NewGuid());
        Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "effects.ffxbnd.dcx");
        await File.WriteAllBytesAsync(source, new byte[] { 1, 2, 3 });
        var tool = new FixtureUnpacker(source);
        var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), tool);
        try
        {
            var first = await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            Assert.Equal(7, first.Entries[0].Id);
            Assert.Contains(source.Replace('\\', '/'), first.EntrySourceUri(first.Entries[0]).Replace('\\', '/'));
            Assert.DoesNotContain("cache", first.EntrySourceUri(first.Entries[0]).Split('#')[1]);
            Assert.Equal(new byte[] { 4, 5, 6 }, first.ReadEntry(first.Entries[0]));
            await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            Assert.Equal(1, tool.Calls);
            await File.WriteAllBytesAsync(source, new byte[] { 3, 2, 1 });
            var changed = await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            Assert.NotEqual(first.SourceHash, changed.SourceHash);
            Assert.Equal(2, tool.Calls);
            Assert.Equal(new byte[] { 3, 2, 1 }, await File.ReadAllBytesAsync(source));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task MissingUnpackerAndUnsafeManifestFailWithStructuredReasons()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-negative-" + Guid.NewGuid());
        Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        try
        {
            var missing = new LargeResourceReadCache(Path.Combine(root, "cache"), new WitchyBndReadOnlyUnpacker(Path.Combine(root, "missing-tool")));
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => missing.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_UNPACKER_MISSING", error.Code);
            var unsafeCache = new LargeResourceReadCache(Path.Combine(root, "cache"), new FixtureUnpacker(source, unsafePath: true));
            error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => unsafeCache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_CACHE_PATH_UNSAFE", error.Code);
            Assert.Empty(Directory.GetFiles(Path.Combine(root, "cache"), "manifest.json", SearchOption.AllDirectories));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task TamperedCachedLeafIsNeverReadAsTheSourceVersion()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-tamper-" + Guid.NewGuid());
        Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), new FixtureUnpacker(source));
            var snapshot = await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            await File.WriteAllBytesAsync(Path.Combine(snapshot.Root, snapshot.Entries[0].RelativePath), new byte[] { 9 });
            Assert.Equal("LARGE_RESOURCE_CACHE_INVALID", Assert.Throws<LargeResourceCacheException>(() => snapshot.ReadEntry(snapshot.Entries[0])).Code);
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task CorruptWarmManifestFailsWithStructuredDiagnostic()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-corrupt-" + Guid.NewGuid());
        Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), new FixtureUnpacker(source));
            var snapshot = await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            await File.WriteAllTextAsync(Path.Combine(snapshot.Root, "manifest.json"), "{");
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_CACHE_INVALID", error.Code);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task UnsafeCacheManifestMetadataIsRejectedBeforeReturningAListing()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-metadata-" + Guid.NewGuid());
        Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), new FixtureUnpacker(source));
            var snapshot = await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            var manifest = new LargeResourceCacheManifest(1, snapshot.SourceHash, snapshot.UnpackerIdentity,
                new[] { snapshot.Entries[0] with { Size = -1 } });
            await File.WriteAllTextAsync(Path.Combine(snapshot.Root, "manifest.json"), System.Text.Json.JsonSerializer.Serialize(manifest));
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_CACHE_INVALID", error.Code);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task WindowsUnpackerOnLinuxReturnsUnsupportedWithoutExecutingIt()
    {
        if (OperatingSystem.IsWindows()) return;
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-platform-" + Guid.NewGuid()); Directory.CreateDirectory(root);
        var exe = Path.Combine(root, "WitchyBND.exe"); await File.WriteAllBytesAsync(exe, new byte[] { (byte)'M', (byte)'Z', 0, 0 });
        try
        {
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => new WitchyBndReadOnlyUnpacker(exe).UnpackAsync("unused", "unused", CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_UNPACKER_PLATFORM_UNSUPPORTED", error.Code);
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task CachedListingsPreserveNativeEntryFieldNames()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-list-" + Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), new FixtureUnpacker(source));
            var result = await LargeResourceBridgeReader.ReadAsync("list-bnd4-entries", source, default,
                new[] { Path.GetDirectoryName(source)! }, null, null, CancellationToken.None, cache);
            using var json = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(result.Data));
            var entry = json.RootElement.GetProperty("entries")[0];
            Assert.Equal(0, entry.GetProperty("index").GetInt32());
            Assert.Equal("effects\\effect.fxr", entry.GetProperty("name").GetString());
            Assert.Equal(3, entry.GetProperty("uncompressedSize").GetInt64());
            using var options = System.Text.Json.JsonDocument.Parse("{\"entryIndex\":0}");
            result = await LargeResourceBridgeReader.ReadAsync("snapshot-bnd4-child", source, options.RootElement,
                new[] { Path.GetDirectoryName(source)! }, null, null, CancellationToken.None, cache);
            using var snapshot = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(result.Data));
            Assert.Equal(0, snapshot.RootElement.GetProperty("index").GetInt32());
            Assert.Equal(new byte[] { 4, 5, 6 }, Convert.FromBase64String(snapshot.RootElement.GetProperty("contentBase64").GetString()!));
            Assert.Contains("#bnd/entry/0/child/", result.SourceUri);

        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task LeafReadsHonorCancellationBeforeDiskIo()
    {
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        var snapshot = new LargeResourceCacheSnapshot("unused", "unused", new string('a', 64), new string('b', 64), Array.Empty<CachedNativeEntry>());
        // Reading a missing path with an already cancelled token must report cancellation.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => snapshot.ReadEntryAsync(
            new CachedNativeEntry(0, 0, "missing", 0, "missing", 1, new string('c', 64)), cancelled.Token));
    }


    [Fact]
    public async Task ImportedToolIdentityIncludesConfigurationAndRefusesRecursiveConversion()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-tool-" + Guid.NewGuid()); Directory.CreateDirectory(root);
        var exe = Path.Combine(root, "WitchyBND.exe"); await File.WriteAllBytesAsync(exe, new byte[] { 1, 2, 3 });
        var config = Path.Combine(root, "appsettings.override.json");
        try
        {
            var tool = new WitchyBndReadOnlyUnpacker(exe);
            var original = tool.Identity;
            await File.WriteAllTextAsync(config, "{\"Recursive\":false,\"Parallel\":false}");
            Assert.NotEqual(original, tool.Identity);
            await File.WriteAllTextAsync(config, "{\"Recursive\":true}");
            Assert.Equal("LARGE_RESOURCE_UNPACKER_CONFIG_UNSAFE", Assert.Throws<LargeResourceCacheException>(() => tool.Identity).Code);
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task CancellationRemovesPendingCacheAndKeepsSourceBytes()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-cancel-" + Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        using var cancellation = new CancellationTokenSource();
        var tool = new ControlledUnpacker(async (_, destination, token) => {
            await File.WriteAllBytesAsync(Path.Combine(destination, "partial.fxr"), new byte[] { 4 }, token);
            cancellation.Cancel();
            await Task.Delay(Timeout.Infinite, token);
        });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), tool);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, cancellation.Token));
            Assert.Empty(Directory.GetFiles(Path.Combine(root, "cache"), "*", SearchOption.AllDirectories));
            Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(source));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task DiskBudgetStopsAnUnpackerBeforeItFinishes()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-budget-" + Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        var cancelled = false;
        var tool = new ControlledUnpacker(async (_, destination, token) => {
            using (var output = File.Create(Path.Combine(destination, "sparse.fxr"))) output.SetLength(8L * 1024 * 1024 * 1024 + 1);
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled = true; throw; }
        });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), tool);
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal("LARGE_RESOURCE_UNPACK_TOO_LARGE", error.Code);
            Assert.True(cancelled);
            Assert.Empty(Directory.GetFiles(Path.Combine(root, "cache"), "*", SearchOption.AllDirectories));
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task DuplicateManifestPhysicalPathsAreRejectedRatherThanAliased()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-duplicate-" + Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        var tool = new ControlledUnpacker(async (_, destination, token) => {
            await File.WriteAllBytesAsync(Path.Combine(destination, "effect.fxr"), new byte[] { 4 }, token);
            await File.WriteAllTextAsync(Path.Combine(destination, "_witchy-bnd4.xml"), "<bnd4><files><file><id>1</id><path>effect.fxr</path></file><file><id>2</id><path>effect.fxr</path></file></files></bnd4>", token);
        });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), tool);
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", error.Code);
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task WarmCacheRevalidatesSourceAfterToolIdentityCalculation()
    {
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-hit-change-" + Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        var mutate = false;
        var tool = new ControlledUnpacker((snapshot, destination, token) => new FixtureUnpacker(source).UnpackAsync(snapshot, destination, token), () => {
            if (mutate) { mutate = false; File.WriteAllBytes(source, new byte[] { 2 }); }
            return new string('a', 64);
        });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), tool);
            await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            mutate = true;
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_SOURCE_CHANGED", error.Code);
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task CancelledImportedToolDoesNotWaitForAnInheritedOutputPipe()
    {
        if (!OperatingSystem.IsLinux()) return;
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-pipe-" + Guid.NewGuid()); Directory.CreateDirectory(root);
        var executable = Path.Combine(root, "adapter.sh");
        await File.WriteAllTextAsync(executable, "#!/bin/sh\n(sleep 6) &\nexit 0\n");
        File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new WitchyBndReadOnlyUnpacker(executable)
                .UnpackAsync(Path.Combine(root, "snapshot.dcx"), Path.Combine(root, "unpacked"), cancellation.Token).WaitAsync(TimeSpan.FromSeconds(2)));
        }
        finally { Directory.Delete(root, true); }
    }


    [Fact]
    public async Task CancelledRequestNeverStartsAnImportedTool()
    {
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new WitchyBndReadOnlyUnpacker("missing-tool")
            .UnpackAsync("unused", "unused", cancelled.Token));
    }

    [Fact]
    public async Task WarmCacheDirectoryLinkCannotChangeItsStorageBoundary()
    {
        if (OperatingSystem.IsWindows()) return;
        var root = Path.Combine(Path.GetTempPath(), "sf-large-cache-root-link-" + Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(root, "source"));
        var source = Path.Combine(root, "source", "source.dcx"); await File.WriteAllBytesAsync(source, new byte[] { 1 });
        try
        {
            var cache = new LargeResourceReadCache(Path.Combine(root, "cache"), new FixtureUnpacker(source));
            var snapshot = await cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None);
            var outside = Path.Combine(root, "outside-cache"); Directory.Move(snapshot.Root, outside); Directory.CreateSymbolicLink(snapshot.Root, outside);
            var error = await Assert.ThrowsAsync<LargeResourceCacheException>(() => cache.GetAsync(source, new[] { Path.GetDirectoryName(source)! }, CancellationToken.None));
            Assert.Equal("LARGE_RESOURCE_CACHE_ROOT_UNSAFE", error.Code);
        }
        finally { Directory.Delete(root, true); }
    }

    private sealed class ControlledUnpacker(Func<string, string, CancellationToken, Task> run, Func<string>? identity = null) : ILargeResourceUnpacker
    {
        public string Identity => identity?.Invoke() ?? new string('a', 64);
        public Task UnpackAsync(string snapshot, string destination, CancellationToken cancellationToken) => run(snapshot, destination, cancellationToken);
    }

    private sealed class FixtureUnpacker(string original, bool unsafePath = false) : ILargeResourceUnpacker
    {
        public int Calls;
        public string Identity => new string('a', 64);
        public async Task UnpackAsync(string snapshot, string destination, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.NotEqual(original, snapshot);
            Directory.CreateDirectory(destination);
            await File.WriteAllBytesAsync(Path.Combine(destination, "effect.fxr"), new byte[] { 4, 5, 6 }, cancellationToken);
            var path = unsafePath ? "../escape.fxr" : "effect.fxr";
            await File.WriteAllTextAsync(Path.Combine(destination, "_witchy-bnd4.xml"), $"<bnd4><root>effects\\</root><files><file><id>7</id><path>{path}</path><flags>Flag1</flags></file></files></bnd4>", cancellationToken);
        }
    }
}

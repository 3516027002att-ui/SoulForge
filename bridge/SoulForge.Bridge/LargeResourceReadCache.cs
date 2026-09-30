using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

internal sealed class LargeResourceCacheException(string code, string message, Exception? cause = null)
    : IOException(message, cause)
{
    public string Code { get; } = code;
}

internal interface ILargeResourceUnpacker
{
    string Identity { get; }
    Task UnpackAsync(string snapshot, string destination, CancellationToken cancellationToken);
}

/// <summary>User-imported standalone tool. No tool binary/source is redistributed or linked.</summary>
internal sealed class WitchyBndReadOnlyUnpacker(string? executable) : ILargeResourceUnpacker
{
    public string Identity
    {
        get
        {
            if (string.IsNullOrWhiteSpace(executable) || !Path.IsPathFullyQualified(executable) || !File.Exists(executable))
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_MISSING", "Import a local WitchyBND installation and configure SOULFORGE_LARGE_RESOURCE_UNPACKER; no unpacker is bundled.");
            var directory = Path.GetDirectoryName(executable)!;
            var configurations = new[] { Path.Combine(directory, "appsettings.json"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WitchyBND", "appsettings.user.json"),
                Path.Combine(directory, "appsettings.override.json") };
            var recursive = false; var dcx = false; var defer = false;
            foreach (var path in configurations.Where(File.Exists))
            {
                if (new FileInfo(path).Length > 1024 * 1024)
                    throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_CONFIG_UNSAFE", "Imported tool configuration exceeds its bound.");
                try
                {
                    using var config = JsonDocument.Parse(File.ReadAllText(path));
                    if (config.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException();
                    foreach (var property in config.RootElement.EnumerateObject())
                    {
                        if (property.Name.Equals("Recursive", StringComparison.OrdinalIgnoreCase)) recursive = property.Value.GetBoolean();
                        if (property.Name.Equals("Dcx", StringComparison.OrdinalIgnoreCase)) dcx = property.Value.GetBoolean();
                        if (property.Name.Equals("DeferTools", StringComparison.OrdinalIgnoreCase) || property.Name.Equals("DeferToolPaths", StringComparison.OrdinalIgnoreCase))
                            defer = property.Value.ValueKind != JsonValueKind.Object || property.Value.EnumerateObject().Any();
                    }
                }
                catch (Exception error) when (error is JsonException or InvalidOperationException)
                { throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_CONFIG_UNSAFE", "Imported tool configuration is malformed.", error); }
            }
            if (recursive || dcx || defer)
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_CONFIG_UNSAFE", "Imported WitchyBND must disable recursive conversion, DCX-only conversion and deferred tools for basic unpack transport.");
            var components = Directory.EnumerateFiles(directory)
                .Where(path => path == executable || Path.GetExtension(path).Equals(".dll", StringComparison.OrdinalIgnoreCase)
                    || Path.GetExtension(path).Equals(".so", StringComparison.OrdinalIgnoreCase))
                .Concat(configurations.Where(File.Exists)).Distinct().OrderBy(path => path, StringComparer.Ordinal).ToArray();
            if (components.Length > 128 || components.Sum(path => new FileInfo(path).Length) > 512L * 1024 * 1024)
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_IDENTITY_INVALID", "Imported tool installation exceeds the bounded identity inventory.");
            var version = "soulforge-basic-unpack-v1|-u|-b|-p|-t|-l";
            foreach (var component in components) version += "|" + Path.GetFileName(component) + ":" + LargeResourceReadCache.HashFile(component);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(version))).ToLowerInvariant();
        }
    }

    public async Task UnpackAsync(string snapshot, string destination, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = Identity;
        using (var stream = File.OpenRead(executable!))
        {
            if (!OperatingSystem.IsWindows() && stream.ReadByte() == 'M' && stream.ReadByte() == 'Z')
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_PLATFORM_UNSUPPORTED", "A Windows unpacker cannot run natively on Linux. Use an authorized native adapter or an already materialized source-bound cache; no Windows Oodle DLL is loaded here.");
        }
        var isolatedUnixGroup = OperatingSystem.IsLinux() && File.Exists("/usr/bin/setsid");
        var start = new ProcessStartInfo(isolatedUnixGroup ? "/usr/bin/setsid" : executable!) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(snapshot)!,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, CreateNoWindow = true };
        // Unpack-only, basic BND, noninteractive, single-threaded. Never recursive
        // format conversion, repack, shell interpolation, or the original Mod path.
        if (isolatedUnixGroup) { start.ArgumentList.Add("--"); start.ArgumentList.Add(executable!); }
        foreach (var argument in new[] { "-u", "-b", "-p", "-t", "-l", destination, snapshot }) start.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = start };
        cancellationToken.ThrowIfCancellationRequested();
        try { if (!process.Start()) throw new IOException("Unpacker did not start."); }
        catch (Exception error) { throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_START_FAILED", "Could not start the imported unpacker.", error); }
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        var stdout = ReadBoundedTailAsync(process.StandardOutput, linked.Token);
        var stderr = ReadBoundedTailAsync(process.StandardError, linked.Token);
        var drains = Task.WhenAll(stdout, stderr);
        try
        {
            await process.WaitForExitAsync(linked.Token);
            // A child may keep an inherited pipe open after the main tool exits.
            await drains.WaitAsync(linked.Token);
        }
        catch (OperationCanceledException)
        {
            var groupStopped = isolatedUnixGroup && KillUnixGroup(-process.Id, 9) == 0;
            // Cancellation can arrive before setsid has created its group.
            if (!groupStopped && !process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) when (process.HasExited) { }
            }
            process.StandardOutput.Dispose(); process.StandardError.Dispose();
            try { await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
            try { await drains.WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
            if (cancellationToken.IsCancellationRequested) throw;
            throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_TIMEOUT", "Unpack or output drains exceeded the bounded five-minute deadline; no cache was published.");
        }
        var tails = await drains;
        if (process.ExitCode != 0) throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_FAILED", $"Imported unpacker exited {process.ExitCode}: {string.Join(' ', tails)}");
    }

    [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static extern int KillUnixGroup(int pid, int signal);

    private static async Task<string> ReadBoundedTailAsync(TextReader reader, CancellationToken cancellationToken)
    {
        var tail = new StringBuilder(); var buffer = new char[4096]; int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
        {
            tail.Append(buffer, 0, count);
            if (tail.Length > 32768) tail.Remove(0, tail.Length - 32768);
        }
        return tail.ToString();
    }
}

internal sealed record CachedNativeEntry(int Index, int Id, string Name, int DuplicateOrdinal, string RelativePath, long Size, string ContentHash);
internal sealed record LargeResourceCacheManifest(int SchemaVersion, string SourceHash, string UnpackerIdentity, IReadOnlyList<CachedNativeEntry> Entries);

internal sealed record LargeResourceCacheSnapshot(string Root, string SourcePath, string SourceHash, string UnpackerIdentity, IReadOnlyList<CachedNativeEntry> Entries)
{
    public string EntrySourceUri(CachedNativeEntry entry) =>
        $"{BridgeResult<object>.MakeSourceUri(SourcePath)}#bnd/entry/{entry.Index}/child/{Uri.EscapeDataString(entry.Name)}";

    public byte[] ReadEntry(CachedNativeEntry entry) => ReadEntryAsync(entry, CancellationToken.None).GetAwaiter().GetResult();

    public async Task<byte[]> ReadEntryAsync(CachedNativeEntry entry, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = LargeResourceReadCache.SafePath(Root, entry.RelativePath);
        if (entry.Size < 0 || entry.Size > LargeResourceReadCache.MaxLeafBytes)
            throw new LargeResourceCacheException("LARGE_RESOURCE_ENTRY_TOO_LARGE", "One unpacked leaf exceeds the bounded native read limit.");
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous);
        if (input.Length != entry.Size)
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Unpacked leaf changed after its source-bound receipt.");
        var bytes = new byte[checked((int)entry.Size)];
        try { await input.ReadExactlyAsync(bytes, cancellationToken); }
        catch (EndOfStreamException error) { throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Unpacked leaf changed during the bounded read.", error); }
        if (input.Length != entry.Size || Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != entry.ContentHash)
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Unpacked leaf changed during the read.");
        cancellationToken.ThrowIfCancellationRequested();
        return bytes;
    }

}

/// <summary>Read-only unpack transport. Bridge remains the native leaf parser.</summary>
internal sealed class LargeResourceReadCache(string cacheRoot, ILargeResourceUnpacker unpacker)
{
    internal const long MaxLeafBytes = 64L * 1024 * 1024;
    private const long MaxSnapshotBytes = 2L * 1024 * 1024 * 1024;
    private const long MaxUnpackedBytes = 8L * 1024 * 1024 * 1024;
    private const int MaxManifestBytes = 4 * 1024 * 1024;
    private const int MaxEntries = 100000;

    public static bool RequiresCache(string source) => new FileInfo(source).Length > MaxLeafBytes
        && (source.EndsWith(".dcx", StringComparison.OrdinalIgnoreCase) || Path.GetExtension(source).EndsWith("bnd", StringComparison.OrdinalIgnoreCase));

    public static LargeResourceReadCache FromEnvironment() => new(
        Environment.GetEnvironmentVariable("SOULFORGE_READ_CACHE_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SoulForge", "read-cache"),
        new WitchyBndReadOnlyUnpacker(Environment.GetEnvironmentVariable("SOULFORGE_LARGE_RESOURCE_UNPACKER")));

    public async Task<LargeResourceCacheSnapshot> GetAsync(string source, IReadOnlyList<string> sourceRoots, CancellationToken cancellationToken)
    {
        var sourceBoundary = BridgePathBoundary.Verify(Path.GetFullPath(source), sourceRoots);
        if (!sourceBoundary.Ok) throw new LargeResourceCacheException(sourceBoundary.Code, sourceBoundary.Message);
        var root = Path.GetFullPath(cacheRoot);
        RejectLinksInAncestors(root);
        if (sourceRoots.Any(readRoot => IsInside(Path.GetFullPath(readRoot), root)))
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_ROOT_UNSAFE", "The unpack cache must be outside the source game/Mod read roots.");
        if (new FileInfo(source).Length > MaxSnapshotBytes)
            throw new LargeResourceCacheException("LARGE_RESOURCE_SOURCE_TOO_LARGE", "Source exceeds the bounded on-disk snapshot budget.");
        cancellationToken.ThrowIfCancellationRequested();
        var sourceHash = await HashFileAsync(source, cancellationToken);
        var identity = unpacker.Identity;
        if (identity.Length != 64 || identity.Any(character => !Uri.IsHexDigit(character)))
            throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_IDENTITY_INVALID", "Unpacker identity must be a SHA-256 digest.");
        var parent = Path.Combine(root, sourceHash);
        var completed = Path.Combine(parent, identity);
        RejectLinksInAncestors(completed);
        if (Directory.Exists(completed))
        {
            var warm = Load(completed, source, sourceHash, identity);
            if (await HashFileAsync(source, cancellationToken) != sourceHash)
                throw new LargeResourceCacheException("LARGE_RESOURCE_SOURCE_CHANGED", "Source changed while validating the cached tool identity; refusing the stale cache.");
            return warm;
        }
        RejectLinksInAncestors(parent);
        Directory.CreateDirectory(parent);
        var pending = Path.Combine(parent, identity + ".pending-" + Guid.NewGuid());
        Directory.CreateDirectory(pending);
        try
        {
            var snapshot = Path.Combine(pending, Path.GetFileName(source));
            await using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            await using (var output = new FileStream(snapshot, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await CopySnapshotAsync(input, output, cancellationToken);
            if (await HashFileAsync(snapshot, cancellationToken) != sourceHash) throw new LargeResourceCacheException("LARGE_RESOURCE_SOURCE_CHANGED", "Source changed while creating the tool's independent input snapshot.");
            var outputRoot = Path.Combine(pending, "unpacked"); Directory.CreateDirectory(outputRoot);
            await UnpackBoundedAsync(snapshot, outputRoot, cancellationToken);
            var entries = await ReadWitchyManifestAsync(pending, outputRoot, cancellationToken);
            if (unpacker.Identity != identity)
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACKER_CHANGED", "Imported tool or configuration changed during unpack; no cache was published.");
            if (await HashFileAsync(source, cancellationToken) != sourceHash) throw new LargeResourceCacheException("LARGE_RESOURCE_SOURCE_CHANGED", "Source changed during unpack; no cache was published.");
            cancellationToken.ThrowIfCancellationRequested();
            var manifest = new LargeResourceCacheManifest(1, sourceHash, identity, entries);
            await File.WriteAllTextAsync(Path.Combine(pending, "manifest.json"), JsonSerializer.Serialize(manifest), cancellationToken);
            File.Delete(snapshot);
            try { Directory.Move(pending, completed); }
            catch (IOException) when (Directory.Exists(completed)) { /* Another matching invocation published first. */ }
            return Load(completed, source, sourceHash, identity);
        }
        catch (LargeResourceCacheException) { throw; }
        catch (OperationCanceledException) { throw; }
        catch (Exception error) { throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_FAILED", "Read-only unpack failed; source remains unchanged and no partial cache is accepted.", error); }
        finally { if (Directory.Exists(pending)) Directory.Delete(pending, recursive: true); }
    }

    private static async Task CopySnapshotAsync(Stream input, Stream output, CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024]; long copied = 0; int count;
        while ((count = await input.ReadAsync(buffer, cancellationToken)) > 0)
        {
            copied += count;
            if (copied > MaxSnapshotBytes)
                throw new LargeResourceCacheException("LARGE_RESOURCE_SOURCE_TOO_LARGE", "Source grew beyond the bounded snapshot budget.");
            await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
        }
    }

    private async Task UnpackBoundedAsync(string snapshot, string outputRoot, CancellationToken cancellationToken)
    {
        using var budgetCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var task = unpacker.UnpackAsync(snapshot, outputRoot, budgetCancellation.Token);
        try
        {
            while (!task.IsCompleted)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _ = EnumerateSafeFiles(outputRoot).Count();
                await Task.WhenAny(task, Task.Delay(200, cancellationToken));
            }
            await task;
            _ = EnumerateSafeFiles(outputRoot).Count();
        }
        catch
        {
            budgetCancellation.Cancel();
            try { await task; } catch { /* Preserve the cancellation/budget error. */ }
            throw;
        }
    }

    internal static async Task<string> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }

    private static async Task<IReadOnlyList<CachedNativeEntry>> ReadWitchyManifestAsync(string pending, string outputRoot, CancellationToken cancellationToken)
    {
        var files = EnumerateSafeFiles(outputRoot).ToArray();
        var manifests = files.Where(file => Path.GetFileName(file).Equals("_witchy-bnd4.xml", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (manifests.Length != 1 || new FileInfo(manifests[0]).Length > MaxManifestBytes)
            throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", "Expected exactly one bounded basic-BND4 manifest; recursive conversion output is not accepted.");
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxManifestBytes };
        using var reader = XmlReader.Create(manifests[0], settings);
        var xml = XDocument.Load(reader).Root;
        if (xml?.Name.LocalName.ToLowerInvariant() != "bnd4")
            throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", "Unpack manifest does not describe a BND4 container.");
        var nodes = xml.Element("files")?.Elements("file").ToArray() ?? Array.Empty<XElement>();
        if (nodes.Length > MaxEntries) throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", "Unpacked entry count exceeds its bound.");
        var binderRoot = xml.Element("root")?.Value ?? string.Empty;
        var duplicates = new Dictionary<string, int>(StringComparer.Ordinal);
        var physicalPaths = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        var entries = new List<CachedNativeEntry>();
        foreach (var node in nodes)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var relative = node.Element("path")?.Value ?? throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", "Entry path is missing.");
            var suffix = node.Element("suffix")?.Value ?? string.Empty;
            if (suffix.Length > 64 || suffix.IndexOfAny(new[] { '/', '\\', ':', '\0' }) >= 0)
                throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_PATH_UNSAFE", "Unpack suffix is not a filename-only suffix.");
            var normalized = relative.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);
            var file = SafePath(Path.GetDirectoryName(manifests[0])!, Path.Combine(Path.GetDirectoryName(normalized) ?? string.Empty,
                Path.GetFileNameWithoutExtension(normalized) + suffix + Path.GetExtension(normalized)));
            if (!physicalPaths.Add(file))
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", "Multiple manifest entries alias the same extracted file; physical identity cannot be established.");
            var name = binderRoot + relative;
            var ordinal = duplicates.GetValueOrDefault(name); duplicates[name] = ordinal + 1;
            if (!int.TryParse(node.Element("id")?.Value ?? "-1", out var id) || !File.Exists(file))
                throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_MANIFEST_INVALID", "Entry identity or materialized file is invalid.");
            entries.Add(new(entries.Count, id, name, ordinal, Path.GetRelativePath(pending, file), new FileInfo(file).Length, await HashFileAsync(file, cancellationToken)));
        }
        return entries;
    }

    private static LargeResourceCacheSnapshot Load(string root, string source, string sourceHash, string identity)
    {
        var path = SafePath(root, "manifest.json");
        if (!File.Exists(path) || new FileInfo(path).Length > MaxManifestBytes)
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Cache manifest is missing or too large.");
        LargeResourceCacheManifest? manifest;
        try { manifest = JsonSerializer.Deserialize<LargeResourceCacheManifest>(File.ReadAllText(path)); }
        catch (Exception error) when (error is JsonException or IOException)
        { throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Cache manifest is unreadable or malformed.", error); }
        if (manifest is null || manifest.SchemaVersion != 1 || manifest.SourceHash != sourceHash || manifest.UnpackerIdentity != identity
            || manifest.Entries is null || manifest.Entries.Count > MaxEntries)
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Cache identity or schema does not match the observed source version.");
        long totalSize = 0;
        for (var index = 0; index < manifest.Entries.Count; index++)
        {
            var entry = manifest.Entries[index];
            if (entry is null || entry.Index != index || entry.Size < 0 || entry.Size > MaxUnpackedBytes || entry.DuplicateOrdinal < 0
                || string.IsNullOrWhiteSpace(entry.Name) || entry.Name.Length > 4096 || !IsHash(entry.ContentHash))
                throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Cache entry identity, size or digest is invalid.");
            totalSize += entry.Size;
            if (totalSize > MaxUnpackedBytes)
                throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_INVALID", "Cache entries exceed the bounded disk budget.");
            _ = SafePath(root, entry.RelativePath);
        }
        return new(root, source, sourceHash, identity, manifest.Entries);
    }

    internal static bool IsHash(string? digest) => digest is { Length: 64 } && digest.All(Uri.IsHexDigit);

    internal static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    internal static string SafePath(string root, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || relative.Length > 4096 || relative.Contains(':') || Path.IsPathRooted(relative)
            || relative.Replace('\\', '/').Split('/').Any(segment => segment == ".."))
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_PATH_UNSAFE", "Unpack path escapes the cache boundary.");
        var path = Path.GetFullPath(Path.Combine(root, relative));
        if (!BridgePathBoundary.Verify(path, new[] { root }).Ok)
            throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_PATH_UNSAFE", "Unpack path crosses a link outside the cache boundary.");
        return path;
    }

    private static IEnumerable<string> EnumerateSafeFiles(string root)
    {
        var directories = new Stack<string>(); directories.Push(root); var count = 0; long total = 0;
        while (directories.Count > 0)
        {
            foreach (var item in new DirectoryInfo(directories.Pop()).EnumerateFileSystemInfos())
            {
                if (++count > MaxEntries || item.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_PATH_UNSAFE", "Unpack output contains a link or exceeds the bounded file count.");
                if (item is DirectoryInfo directory) directories.Push(directory.FullName);
                else { total += ((FileInfo)item).Length; if (total > MaxUnpackedBytes) throw new LargeResourceCacheException("LARGE_RESOURCE_UNPACK_TOO_LARGE", "Unpack output exceeds its on-disk budget."); yield return item.FullName; }
            }
        }
    }

    private static void RejectLinksInAncestors(string path)
    {
        for (var current = new DirectoryInfo(path); current is not null; current = current.Parent)
            if (current.Exists && current.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new LargeResourceCacheException("LARGE_RESOURCE_CACHE_ROOT_UNSAFE", "Cache root must not cross a directory link into source storage.");
    }

    private static bool IsInside(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        return relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) && !Path.IsPathRooted(relative);
    }
}

using System.Text.Json;

internal static class LargeResourceBridgeReader
{
    internal static bool Supports(string command) => command is "inspect" or "validate" or "read-dcx-document" or "list-bnd4-entries"
        or "list-ffxbnd-entries" or "read-fxr-document" or "snapshot-bnd4-child" or "extract-bnd4-child";

    internal static async Task<BridgeResult<object>> ReadAsync(string command, string source, JsonElement options,
        IReadOnlyList<string>? allowedRoots, string? outputPath, string? oodleRoot, CancellationToken cancellationToken, LargeResourceReadCache? cacheReader = null)
    {
        LargeResourceCacheSnapshot cache;
        try
        {
            cache = await (cacheReader ?? LargeResourceReadCache.FromEnvironment()).GetAsync(Path.GetFullPath(source),
                allowedRoots is { Count: > 0 } ? allowedRoots : new[] { Path.GetDirectoryName(Path.GetFullPath(source))! }, cancellationToken);
        }
        catch (LargeResourceCacheException error)
        {
            var status = error.Code is "LARGE_RESOURCE_UNPACKER_MISSING" or "LARGE_RESOURCE_UNPACKER_PLATFORM_UNSUPPORTED" ? "unsupported" : "failed";
            return new(BridgeResult<object>.MakeSourceUri(source), source, BridgeResult<object>.GameUnknown, BridgeCommandService.GuessKindFromPath(source), status,
                new[] { new Diagnostic(status == "failed" ? "error" : "warning", error.Code, error.Message, BridgeResult<object>.MakeSourceUri(source)) });
        }
        var provenance = new { sourceContainerHash = cache.SourceHash, unpackerIdentity = cache.UnpackerIdentity,
            unpacker = "user-imported-standalone-WitchyBND", readOnly = true, containerWriteSupported = false };
        var diagnostic = new Diagnostic("info", "LARGE_RESOURCE_READ_ONLY_CACHE", "Oversized container was unpacked into a source-hash-bound read cache. Bridge parses native leaves; this is not a container roundtrip or writer capability.", BridgeResult<object>.MakeSourceUri(source), provenance);
        var entries = cache.Entries.Select(entry => new { index = entry.Index, id = entry.Id, name = entry.Name,
            entryIndex = entry.Index, entryId = entry.Id, entryName = entry.Name, uncompressedSize = entry.Size, size = entry.Size,
            duplicateOrdinal = entry.DuplicateOrdinal, contentSize = entry.Size, contentHash = entry.ContentHash,
            sourceUri = cache.EntrySourceUri(entry), sourcePath = source, sourceContainerHash = cache.SourceHash }).ToArray();

        if (command == "list-ffxbnd-entries")
            return BridgeResult<object>.Partial(source, "sfx", new[] { diagnostic }, new {
                entries = cache.Entries.Where(entry => entry.Name.EndsWith(".fxr", StringComparison.OrdinalIgnoreCase)).Select(entry => entry.Name).ToArray(),
                nativeEntries = entries, provenance });
        if (command is "inspect" or "validate" or "read-dcx-document" or "list-bnd4-entries")
            return BridgeResult<object>.Partial(source, BridgeCommandService.GuessKindFromPath(source), new[] { diagnostic }, new {
                format = source.EndsWith(".dcx", StringComparison.OrdinalIgnoreCase) ? "DCX" : "BND4", sourceHash = cache.SourceHash, sourceSize = new FileInfo(source).Length,
                entryCount = entries.Length, entries, readOnly = true,
                nested = new { format = "BND4", entryCount = entries.Length, entries }, provenance,
                roundTrip = new { byteIdentical = false, payloadIdentical = false, note = "External unpack transport only; repack/outer-byte preservation was not verified." }
            });

        CachedNativeEntry? selected = null;
        string? optionName = null;
        int? optionIndex = null;
        if (options.ValueKind == JsonValueKind.Object)
        {
            foreach (var field in new[] { "entryName", "childPath" })
                if (options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String) optionName ??= value.GetString();
            foreach (var field in new[] { "entryIndex", "childIndex" })
                if (options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var index)) optionIndex ??= index;
        }
        var candidates = cache.Entries.Where(entry => command != "read-fxr-document" || entry.Name.EndsWith(".fxr", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (optionIndex is not null) selected = candidates.SingleOrDefault(entry => entry.Index == optionIndex);
        else if (!string.IsNullOrWhiteSpace(optionName))
        {
            var matches = candidates.Where(entry => entry.Name.Replace('\\', '/').Equals(optionName.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase)
                || entry.Name.Replace('\\', '/').EndsWith("/" + optionName.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches.Length > 1) return BridgeResult<object>.Failed(source, "sfx", "LARGE_RESOURCE_ENTRY_AMBIGUOUS", "Display name matches multiple physical entries; provide entryIndex.");
            selected = matches.SingleOrDefault();
        }
        else if (command == "read-fxr-document") selected = candidates.FirstOrDefault();
        if (selected is null) return BridgeResult<object>.Failed(source, "sfx", "LARGE_RESOURCE_ENTRY_NOT_FOUND", "Requested physical container entry was not found.");
        var sourceUri = cache.EntrySourceUri(selected);
        try
        {
            var bytes = await cache.ReadEntryAsync(selected, cancellationToken);
            if (options.ValueKind == JsonValueKind.Object)
                foreach (var expectation in new[] { ("expectedContainerHash", cache.SourceHash), ("expectedChildHash", selected.ContentHash) })
                    if (options.TryGetProperty(expectation.Item1, out var expected) && expected.ValueKind == JsonValueKind.String
                        && !string.Equals(expected.GetString(), expectation.Item2, StringComparison.OrdinalIgnoreCase))
                        return BridgeResult<object>.Failed(source, "unknown", "LARGE_RESOURCE_SOURCE_HASH_MISMATCH", "Requested source/leaf version does not match the hash-bound cache.");
            var receipt = new { index = selected.Index, id = selected.Id, name = selected.Name, sourceHash = cache.SourceHash,
                entryIndex = selected.Index, entryId = selected.Id, entryName = selected.Name, contentHash = selected.ContentHash,
                contentSize = bytes.Length, sourceUri, sourcePath = source, sourceContainerHash = cache.SourceHash, readOnly = true };
            if (command == "snapshot-bnd4-child")
                return BridgeResult<object>.Partial(source, "unknown", new[] { diagnostic }, new { index = selected.Index, id = selected.Id, name = selected.Name, duplicateOrdinal = selected.DuplicateOrdinal,
                    sourceHash = cache.SourceHash, contentHash = selected.ContentHash, uncompressedSize = selected.Size,
                    sourceUri, sourcePath = source, sourceContainerHash = cache.SourceHash, readOnly = true,
                    contentBase64 = Convert.ToBase64String(bytes), provenance }) with { SourceUri = sourceUri };
            if (command == "extract-bnd4-child")
            {
                // Only the daemon's already boundary-checked host staging output
                // is accepted here. CLI options cannot supply this trusted field.
                if (string.IsNullOrWhiteSpace(outputPath)) return BridgeResult<object>.Failed(source, "unknown", "BRIDGE_OUTPUT_PATH_REQUIRED", "A host-controlled staging output is required.");
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
                var temporary = Path.Combine(Path.GetDirectoryName(outputPath)!, ".soulforge-cache-extract-" + Guid.NewGuid() + ".tmp");
                try
                {
                    await File.WriteAllBytesAsync(temporary, bytes, cancellationToken);
                    cancellationToken.ThrowIfCancellationRequested();
                    File.Move(temporary, outputPath, overwrite: true);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
                return BridgeResult<object>.Partial(source, "unknown", new[] { diagnostic,
                    new Diagnostic("info", "BND4_CHILD_EXTRACTED", "Source-bound leaf copied into host staging; original container was not modified.", sourceUri, receipt) }, receipt) with { SourceUri = sourceUri };
            }
            if (bytes.AsSpan(0, Math.Min(bytes.Length, 4)).SequenceEqual("DCX\0"u8)) bytes = DcxNativeDocument.Read(bytes, oodleRoot, source).Payload;
            var document = FxrNativeDocument.Read(bytes);
            var roundTrip = document.VerifyRoundTrip();
            var data = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(document.ToEnvelope(roundTrip,
                candidates.Select(entry => (object)new { entryIndex = entry.Index, entryName = entry.Name }).ToArray(), selected.Index, selected.Name)))!;
            data["sourceUri"] = sourceUri; data["sourcePath"] = source; data["sourceContainerHash"] = cache.SourceHash; data["readOnlyCache"] = provenance;
            var diagnostics = new List<Diagnostic> { diagnostic,
                new("info", "FXR_DOCUMENT_ROUNDTRIP_VERIFIED", "Native leaf was deterministically reread; this does not verify outer-container reconstruction.", sourceUri, roundTrip) };
            var gaps = document.UnparsedGaps();
            if (gaps.Length > 0) diagnostics.Add(new("warning", "FXR_STRUCTURE_NOT_PARSED_IN_SCOPE", "Native FXR coverage remains partial; cached transport does not add format authority.", sourceUri, new { unparsedGaps = gaps }));
            return BridgeResult<object>.Partial(source, "sfx", diagnostics, data) with { SourceUri = sourceUri };
        }
        catch (LargeResourceCacheException error) { return BridgeResult<object>.Failed(source, "sfx", error.Code, error.Message) with { SourceUri = sourceUri }; }
        catch (Exception error) when (error is InvalidDataException or NotSupportedException or IOException)
        {
            return BridgeResult<object>.Failed(source, "sfx", "FXR_DOCUMENT_READ_FAILED", error.Message,
                new { selectedEntryIndex = selected.Index, selectedEntryName = selected.Name, sourceContainerHash = cache.SourceHash }) with { SourceUri = sourceUri };
        }
    }
}

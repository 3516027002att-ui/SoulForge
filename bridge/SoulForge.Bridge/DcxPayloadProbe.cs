using System.IO.Compression;
using System.Text;

static class DcxPayloadProbe
{
    private const int DcxMinimumHeaderBytes = 0x4C;
    private const int DcaSearchStart = 0x30;
    private const int DcaSearchLimit = 0x100;
    private const int MaxCompressedReadBytes = 64 * 1024 * 1024;
    private const int MaxDecompressedPreviewBytes = 512 * 1024;

    private static readonly MagicRule[] NestedMagicRules =
    {
        new("DCX", new byte[] { (byte)'D', (byte)'C', (byte)'X', 0 }),
        new("BND3", new byte[] { (byte)'B', (byte)'N', (byte)'D', (byte)'3' }),
        new("BND4", new byte[] { (byte)'B', (byte)'N', (byte)'D', (byte)'4' }),
        new("EMEVD", new byte[] { (byte)'E', (byte)'V', (byte)'D', 0 }),
        new("FMG", new byte[] { (byte)'F', (byte)'M', (byte)'G', 0 }),
        new("PARAM", new byte[] { (byte)'P', (byte)'A', (byte)'R', (byte)'A' }),
        new("MSB", new byte[] { (byte)'M', (byte)'S', (byte)'B', 0 })
    };

    public static DcxPayloadProbeResult? Probe(string sourcePath, byte[] sample, long fileLength)
    {
        if (!StartsWith(sample, "DCX\0")) return null;

        var sourceUri = BridgeResult<object>.MakeSourceUri(sourcePath);
        var diagnostics = new List<Diagnostic>();
        var evidence = new List<FormatEvidence>();

        if (sample.Length < DcxMinimumHeaderBytes)
        {
            diagnostics.Add(new Diagnostic(
                "warning",
                "DCX_HEADER_TRUNCATED",
                $"DCX header requires at least {DcxMinimumHeaderBytes} bytes, but only {sample.Length} byte(s) were available in the bounded prefix.",
                sourceUri,
                new { sampleLength = sample.Length, requiredBytes = DcxMinimumHeaderBytes }));

            return new DcxPayloadProbeResult(
                BoundaryStatus: "failed",
                CompressionFormat: "unknown",
                DcxType: "unknown",
                Header: new { sampleLength = sample.Length, requiredBytes = DcxMinimumHeaderBytes },
                Payload: null,
                Decompression: new { status = "not-attempted", reason = "dcx-header-truncated" },
                Evidence: evidence,
                Diagnostics: diagnostics);
        }

        var headerVersion = ReadUInt32Be(sample, 0x04);
        var dcsOffsetHint = ReadUInt32Be(sample, 0x08);
        var dcpOffsetHint = ReadUInt32Be(sample, 0x0C);
        var dcaOffsetOrSizeHint = ReadUInt32Be(sample, 0x10);
        var payloadOffsetHint = ReadUInt32Be(sample, 0x14);
        var uncompressedSize = ReadUInt32Be(sample, 0x1C);
        var compressedSize = ReadUInt32Be(sample, 0x20);
        var compressionFormat = ReadAscii(sample, 0x28, 4) ?? "unknown";
        var dcpHeaderLength = ReadUInt32Be(sample, 0x2C);
        var compressionLevel = sample.Length > 0x30 ? sample[0x30] : (byte)0;
        var compressionSubFlag = sample.Length > 0x38 ? sample[0x38] : (byte)0;
        var dcaStart = FindAscii(sample, "DCA\0", DcaSearchStart, Math.Min(sample.Length, DcaSearchLimit));
        var dcaHeaderLength = dcaStart >= 0 ? ReadUInt32Be(sample, dcaStart + 4) : 0;
        var payloadOffset = dcaStart >= 0 ? checked((long)dcaStart + dcaHeaderLength) : -1;
        var payloadEnd = payloadOffset >= 0 ? payloadOffset + compressedSize : -1;
        var hasExpectedDcs = StartsWith(sample, "DCS\0", 0x18);
        var hasExpectedDcp = StartsWith(sample, "DCP\0", 0x24);
        var hasDca = dcaStart >= 0;
        var payloadRangeValid = payloadOffset >= 0 && compressedSize > 0 && payloadEnd <= fileLength;
        var boundaryStatus = hasExpectedDcs && hasExpectedDcp && hasDca && payloadRangeValid ? "confirmed" : "failed";
        var dcxType = ClassifyDcxType(headerVersion, compressionFormat, compressionLevel, compressionSubFlag, dcaOffsetOrSizeHint);
        var header = new
        {
            headerVersion = ToHex32(headerVersion),
            dcsOffsetHint,
            dcpOffsetHint,
            dcaOffsetOrSizeHint,
            payloadOffsetHint,
            dcpHeaderLength,
            dcaStart = dcaStart >= 0 ? dcaStart : (int?)null,
            dcaHeaderLength,
            compressionLevel,
            compressionSubFlag,
            hasExpectedDcs,
            hasExpectedDcp,
            hasDca
        };
        var payload = new
        {
            offset = payloadOffset >= 0 ? payloadOffset : (long?)null,
            compressedSize,
            uncompressedSize,
            endOffset = payloadEnd >= 0 ? payloadEnd : (long?)null,
            rangeValid = payloadRangeValid,
            maxDecompressedPreviewBytes = MaxDecompressedPreviewBytes
        };

        evidence.Add(new FormatEvidence(
            "dcxPayloadBoundary",
            payloadOffset >= 0 && payloadOffset <= int.MaxValue ? (int)payloadOffset : 0,
            new
            {
                boundaryStatus,
                compressionFormat,
                dcxType,
                payload,
                header,
                source = "reviewed-dcx-header-probe",
                authoritativeLayout = compressionFormat is "DFLT" or "KRAK" or "ZSTD" or "EDGE"
            },
            boundaryStatus == "confirmed" ? "high" : "low"));

        diagnostics.Add(new Diagnostic(
            boundaryStatus == "confirmed" ? "info" : "warning",
            boundaryStatus == "confirmed" ? "DCX_PAYLOAD_BOUNDARY_CONFIRMED" : "DCX_PAYLOAD_BOUNDARY_UNCONFIRMED",
            boundaryStatus == "confirmed"
                ? $"Confirmed DCX {compressionFormat} payload boundary at byte offset {payloadOffset} with {compressedSize} compressed byte(s)."
                : "Could not confirm a valid DCX payload boundary from the bounded prefix and file length.",
            sourceUri,
            new { compressionFormat, dcxType, payloadOffset, compressedSize, uncompressedSize, fileLength, header }));

        var decompression = TryBuildDecompressedPreview(sourcePath, compressionFormat, payloadOffset, compressedSize, payloadRangeValid, sourceUri, evidence, diagnostics);

        return new DcxPayloadProbeResult(
            BoundaryStatus: boundaryStatus,
            CompressionFormat: compressionFormat,
            DcxType: dcxType,
            Header: header,
            Payload: payload,
            Decompression: decompression,
            Evidence: evidence,
            Diagnostics: diagnostics);
    }

    private static object TryBuildDecompressedPreview(
        string sourcePath,
        string compressionFormat,
        long payloadOffset,
        uint compressedSize,
        bool payloadRangeValid,
        string sourceUri,
        List<FormatEvidence> evidence,
        List<Diagnostic> diagnostics)
    {
        if (!payloadRangeValid)
        {
            return new { status = "not-attempted", reason = "invalid-payload-range" };
        }

        if (compressionFormat != "DFLT")
        {
            diagnostics.Add(new Diagnostic(
                "info",
                "DCX_DECOMPRESSION_NOT_ATTEMPTED",
                compressionFormat is "KRAK" or "EDGE" or "ZSTD"
                    ? $"DCX {compressionFormat} payload boundary was identified, but this bridge only previews DFLT/zlib payloads for now."
                    : $"DCX compression format {compressionFormat} is not supported for decompression preview yet.",
                sourceUri,
                new { compressionFormat }));

            return new
            {
                status = "unsupported",
                reason = compressionFormat is "KRAK" ? "oodle-kraken-required" : "compression-format-not-implemented",
                compressionFormat
            };
        }

        if (compressedSize > MaxCompressedReadBytes)
        {
            diagnostics.Add(new Diagnostic(
                "warning",
                "DCX_COMPRESSED_PAYLOAD_TOO_LARGE",
                $"Skipped DFLT decompression preview because compressed payload size {compressedSize} exceeds the preview read cap {MaxCompressedReadBytes}.",
                sourceUri,
                new { compressedSize, maxCompressedReadBytes = MaxCompressedReadBytes }));

            return new { status = "skipped", reason = "compressed-payload-too-large", compressedSize, maxCompressedReadBytes = MaxCompressedReadBytes };
        }

        try
        {
            var compressed = ReadRange(sourcePath, payloadOffset, checked((int)compressedSize));
            using var input = new MemoryStream(compressed, writable: false);
            using var zlib = new ZLibStream(input, CompressionMode.Decompress, leaveOpen: false);
            using var preview = new MemoryStream();
            var buffer = new byte[16 * 1024];

            while (preview.Length < MaxDecompressedPreviewBytes)
            {
                var remaining = MaxDecompressedPreviewBytes - (int)preview.Length;
                var read = zlib.Read(buffer, 0, Math.Min(buffer.Length, remaining));
                if (read == 0) break;
                preview.Write(buffer, 0, read);
            }

            var previewBytes = preview.ToArray();
            var nestedRootFormat = DetectNestedRootFormat(previewBytes);
            var result = new
            {
                status = previewBytes.Length == MaxDecompressedPreviewBytes ? "preview-truncated" : "preview-complete",
                compressionFormat,
                previewBytes = previewBytes.Length,
                maxPreviewBytes = MaxDecompressedPreviewBytes,
                nestedRootFormat,
                prefixHex = ToHex(previewBytes, 0, Math.Min(previewBytes.Length, 32)),
                prefixAscii = ToAscii(previewBytes, 0, Math.Min(previewBytes.Length, 32))
            };

            evidence.Add(new FormatEvidence(
                "dcxDecompressedPreview",
                0,
                new
                {
                    result.status,
                    result.compressionFormat,
                    result.previewBytes,
                    result.maxPreviewBytes,
                    result.nestedRootFormat,
                    result.prefixHex,
                    result.prefixAscii,
                    source = "dcx-dflt-zlib-preview",
                    authoritativeLayout = false
                },
                nestedRootFormat == "unknown" ? "medium" : "high"));

            diagnostics.Add(new Diagnostic(
                "info",
                "DCX_DFLT_DECOMPRESSED_PREVIEW_READY",
                nestedRootFormat == "unknown"
                    ? $"Read {previewBytes.Length} decompressed byte(s) from the DFLT/zlib DCX payload; nested root magic is unknown."
                    : $"Read {previewBytes.Length} decompressed byte(s) from the DFLT/zlib DCX payload; nested root magic looks like {nestedRootFormat}.",
                sourceUri,
                result));

            AddNestedPreviewEvidence(sourcePath, previewBytes, nestedRootFormat, sourceUri, evidence, diagnostics);

            return result;
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or NotSupportedException)
        {
            diagnostics.Add(new Diagnostic(
                "warning",
                "DCX_DFLT_DECOMPRESSION_PREVIEW_FAILED",
                $"DFLT/zlib DCX payload boundary was identified, but decompression preview failed: {ex.Message}",
                sourceUri,
                new { exception = ex.GetType().Name, ex.Message }));

            return new { status = "failed", reason = ex.Message, exception = ex.GetType().Name };
        }
    }

    private static void AddNestedPreviewEvidence(
        string sourcePath,
        byte[] previewBytes,
        string nestedRootFormat,
        string sourceUri,
        List<FormatEvidence> evidence,
        List<Diagnostic> diagnostics)
    {
        if (nestedRootFormat is not ("BND3" or "BND4")) return;

        var inventory = SyntheticBinderFixtureExports.TryInspect(sourcePath, previewBytes);
        if (inventory is null) return;

        evidence.Add(new FormatEvidence(
            "dcxNestedBinderChildTable",
            0,
            new
            {
                nestedRootFormat,
                inventory.Data,
                source = "dcx-dflt-preview-synthetic-binder-fixture-v1",
                authoritativeLayout = false
            },
            "high"));

        diagnostics.Add(new Diagnostic(
            "info",
            "DCX_DFLT_NESTED_BND_CHILD_TABLE_FOUND",
            "Detected a fixture-confirmed synthetic BND child table inside the decompressed DFLT/zlib DCX preview. This confirms nested plumbing only; it is not native binder authority.",
            sourceUri,
            new { nestedRootFormat }));
    }

    private static byte[] ReadRange(string sourcePath, long offset, int length)
    {
        var buffer = new byte[length];
        using var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        stream.Seek(offset, SeekOrigin.Begin);

        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer, total, buffer.Length - total);
            if (read == 0) break;
            total += read;
        }

        if (total == buffer.Length) return buffer;
        Array.Resize(ref buffer, total);
        return buffer;
    }

    private static string ClassifyDcxType(uint headerVersion, string compressionFormat, byte compressionLevel, byte compressionSubFlag, uint dcaOffsetOrSizeHint)
    {
        return compressionFormat switch
        {
            "DFLT" when headerVersion == 0x10000 && dcaOffsetOrSizeHint == 0x24 && compressionLevel == 9 && compressionSubFlag == 0 => "DCX_DFLT_10000_24_9",
            "DFLT" when headerVersion == 0x10000 && dcaOffsetOrSizeHint == 0x44 && compressionLevel == 9 && compressionSubFlag == 0 => "DCX_DFLT_10000_44_9",
            "DFLT" when headerVersion == 0x11000 && dcaOffsetOrSizeHint == 0x44 && compressionLevel == 8 && compressionSubFlag == 0 => "DCX_DFLT_11000_44_8",
            "DFLT" when headerVersion == 0x11000 && dcaOffsetOrSizeHint == 0x44 && compressionLevel == 9 && compressionSubFlag == 0 => "DCX_DFLT_11000_44_9",
            "DFLT" when headerVersion == 0x11000 && dcaOffsetOrSizeHint == 0x44 && compressionLevel == 9 && compressionSubFlag == 15 => "DCX_DFLT_11000_44_9_15",
            "KRAK" when compressionLevel == 6 => "DCX_KRAK_6",
            "KRAK" when compressionLevel == 9 => "DCX_KRAK_9",
            "ZSTD" => "DCX_ZSTD",
            "EDGE" => "DCX_EDGE",
            _ => $"DCX_{compressionFormat}"
        };
    }

    private static string DetectNestedRootFormat(byte[] sample)
    {
        foreach (var rule in NestedMagicRules)
        {
            if (StartsWith(sample, rule.Magic)) return rule.RootFormat;
        }

        return "unknown";
    }

    private static int FindAscii(byte[] sample, string text, int start, int endExclusive)
    {
        var bytes = Encoding.ASCII.GetBytes(text);
        for (var offset = Math.Max(0, start); offset + bytes.Length <= endExclusive; offset += 1)
        {
            var match = true;
            for (var index = 0; index < bytes.Length; index += 1)
            {
                if (sample[offset + index] == bytes[index]) continue;
                match = false;
                break;
            }

            if (match) return offset;
        }

        return -1;
    }

    private static bool StartsWith(byte[] sample, string text, int offset = 0)
    {
        return StartsWith(sample, Encoding.ASCII.GetBytes(text), offset);
    }

    private static bool StartsWith(byte[] sample, byte[] magic, int offset = 0)
    {
        if (offset < 0 || offset + magic.Length > sample.Length) return false;

        for (var index = 0; index < magic.Length; index += 1)
        {
            if (sample[offset + index] != magic[index]) return false;
        }

        return true;
    }

    private static string? ReadAscii(byte[] sample, int offset, int count)
    {
        if (offset < 0 || offset + count > sample.Length) return null;
        return Encoding.ASCII.GetString(sample, offset, count);
    }

    private static uint ReadUInt32Be(byte[] sample, int offset)
    {
        if (offset < 0 || offset + 4 > sample.Length) return 0;
        return (uint)(sample[offset] << 24 | sample[offset + 1] << 16 | sample[offset + 2] << 8 | sample[offset + 3]);
    }

    private static string ToHex32(uint value)
    {
        return $"0x{value:X8}";
    }

    private static string ToHex(byte[] sample, int offset, int count)
    {
        return string.Join(" ", sample.Skip(offset).Take(count).Select(value => value.ToString("X2")));
    }

    private static string ToAscii(byte[] sample, int offset, int count)
    {
        return new string(sample.Skip(offset).Take(count).Select(value => value >= 32 && value <= 126 ? (char)value : '.').ToArray());
    }

    private sealed record MagicRule(string RootFormat, byte[] Magic);
}

sealed record DcxPayloadProbeResult(
    string BoundaryStatus,
    string CompressionFormat,
    string DcxType,
    object Header,
    object? Payload,
    object Decompression,
    IReadOnlyList<FormatEvidence> Evidence,
    IReadOnlyList<Diagnostic> Diagnostics);

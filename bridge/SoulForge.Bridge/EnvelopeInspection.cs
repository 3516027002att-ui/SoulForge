static class EnvelopeInspection
{
    private static readonly MagicRule[] MagicRules =
    {
        new("DCX", new byte[] { (byte)'D', (byte)'C', (byte)'X', 0 }),
        new("BND3", new byte[] { (byte)'B', (byte)'N', (byte)'D', (byte)'3' }),
        new("BND4", new byte[] { (byte)'B', (byte)'N', (byte)'D', (byte)'4' }),
        new("EMEVD", new byte[] { (byte)'E', (byte)'V', (byte)'D', 0 }),
        new("FMG", new byte[] { (byte)'F', (byte)'M', (byte)'G', 0 })
    };

    public static InspectionResult Inspect(string sourcePath, byte[] sample, long length, int maxSampleBytes = 512 * 1024)
    {
        var extensionChain = BuildExtensionChain(sourcePath);
        var magicEvidence = new List<FormatEvidence>();
        var rootFormat = DetectRootFormat(sample, magicEvidence);
        var resourceKind = GuessKind(sourcePath);
        var headerEvidence = HeaderEvidenceScanner.Scan(sample, rootFormat);
        var pathHints = EnvelopeHintScanner.Scan(sample);
        var binderChildCandidates = BinderChildCandidateScanner.Scan(sample);
        var nestedMagicCandidates = NestedFormatScanner.Scan(sample);
        var dcxPayloadProbe = DcxPayloadProbe.Probe(sourcePath, sample, length);
        var syntheticBinderInventory = SyntheticBinderFixtureExports.TryInspect(sourcePath, sample);
        var diagnostics = new List<Diagnostic>
        {
            new(
                "info",
                "BOUNDED_PREFIX_READ",
                $"Read {sample.Length} byte(s) from the file prefix, capped at {maxSampleBytes} byte(s).",
                BridgeResult<object>.MakeSourceUri(sourcePath),
                new { fileLength = length, sampleLength = sample.Length, maxSampleBytes })
        };

        if (headerEvidence.Count > 0)
        {
            diagnostics.Add(new Diagnostic(
                "info",
                "HEADER_EVIDENCE_FOUND",
                "Captured bounded-prefix header evidence including prefix bytes, ASCII preview, and endian probes. This is not a confirmed native layout parser.",
                BridgeResult<object>.MakeSourceUri(sourcePath)));
        }

        if (rootFormat == "unknown")
        {
            diagnostics.Add(new Diagnostic(
                "warning",
                "ENVELOPE_MAGIC_UNKNOWN",
                "No supported DCX/BND/EMEVD/FMG magic was found at offset 0 in the bounded prefix.",
                BridgeResult<object>.MakeSourceUri(sourcePath)));
        }
        else
        {
            diagnostics.Add(new Diagnostic(
                "info",
                "ENVELOPE_MAGIC_RECOGNIZED",
                $"Recognized {rootFormat} envelope magic at offset 0. Semantic parsing was not attempted.",
                BridgeResult<object>.MakeSourceUri(sourcePath)));
        }

        if (pathHints.Count > 0)
        {
            diagnostics.Add(new Diagnostic(
                "info",
                "ENVELOPE_PATH_HINTS_FOUND",
                $"Found {pathHints.Count} visible path-like hint(s) in the bounded prefix.",
                BridgeResult<object>.MakeSourceUri(sourcePath)));
        }

        if (binderChildCandidates.Count > 0)
        {
            diagnostics.Add(new Diagnostic(
                "info",
                "BINDER_CHILD_CANDIDATES_FOUND",
                $"Found {binderChildCandidates.Count} low-confidence visible binder child candidate(s). This is not an authoritative binder table yet.",
                BridgeResult<object>.MakeSourceUri(sourcePath)));
        }

        if (nestedMagicCandidates.Count > 0)
        {
            diagnostics.Add(new Diagnostic(
                "info",
                "NESTED_MAGIC_CANDIDATES_FOUND",
                $"Found {nestedMagicCandidates.Count} low-confidence nested format magic candidate(s) in the bounded prefix.",
                BridgeResult<object>.MakeSourceUri(sourcePath)));
        }

        if (dcxPayloadProbe is not null)
        {
            diagnostics.AddRange(dcxPayloadProbe.Diagnostics);
        }

        if (syntheticBinderInventory is not null)
        {
            diagnostics.AddRange(syntheticBinderInventory.Diagnostics);
        }

        var evidence = new List<FormatEvidence>(magicEvidence)
        {
            new("extensionChain", 0, extensionChain, "medium")
        };
        evidence.AddRange(headerEvidence);
        evidence.AddRange(pathHints);
        evidence.AddRange(binderChildCandidates);
        evidence.AddRange(nestedMagicCandidates);
        if (dcxPayloadProbe is not null) evidence.AddRange(dcxPayloadProbe.Evidence);
        if (syntheticBinderInventory is not null) evidence.AddRange(syntheticBinderInventory.Evidence);

        var layers = new List<FormatLayer>
        {
            new(
                rootFormat,
                0,
                length,
                rootFormat == "unknown" ? "low" : "medium",
                new
                {
                    sampleBytes = sample.Length,
                    maxSampleBytes,
                    envelopeOnly = true,
                    headerEvidence = headerEvidence.Count,
                    pathHints = pathHints.Count,
                    binderChildCandidates = binderChildCandidates.Count,
                    nestedMagicCandidates = nestedMagicCandidates.Count,
                    dcxPayloadBoundary = dcxPayloadProbe?.BoundaryStatus,
                    dcxCompressionFormat = dcxPayloadProbe?.CompressionFormat,
                    dcxType = dcxPayloadProbe?.DcxType,
                    bndChildTableEvidence = syntheticBinderInventory is not null
                })
        };

        return new InspectionResult(
            File: new FileSummary(Path.GetFileName(sourcePath), length, Path.GetExtension(sourcePath).ToLowerInvariant(), extensionChain),
            ResourceKind: resourceKind,
            RootFormat: rootFormat,
            ParseStatus: "partial",
            Layers: layers,
            Evidence: evidence,
            Diagnostics: diagnostics,
            NextSteps: BuildNextSteps(rootFormat, resourceKind));
    }

    private static string DetectRootFormat(byte[] sample, List<FormatEvidence> evidence)
    {
        foreach (var rule in MagicRules)
        {
            if (!StartsWith(sample, rule.Magic))
            {
                continue;
            }

            evidence.Add(new FormatEvidence(
                "magic",
                0,
                new { hex = ToHex(sample, rule.Magic.Length), ascii = ToAscii(sample, rule.Magic.Length) },
                "high"));
            return rule.RootFormat;
        }

        evidence.Add(new FormatEvidence(
            "magic",
            0,
            new { hex = ToHex(sample, Math.Min(sample.Length, 16)), ascii = ToAscii(sample, Math.Min(sample.Length, 16)) },
            sample.Length == 0 ? "low" : "medium"));
        return "unknown";
    }

    private static string GuessKind(string sourcePath)
    {
        var name = Path.GetFileName(sourcePath).ToLowerInvariant();
        if (name.Contains("emevd")) return "event";
        if (name.Contains("msb")) return "map";
        if (name.Contains("param")) return "param";
        if (name.Contains("msg") || name.EndsWith(".fmg")) return "msg";
        return "unknown";
    }

    private static IReadOnlyList<string> BuildExtensionChain(string sourcePath)
    {
        var parts = Path.GetFileName(sourcePath).ToLowerInvariant().Split('.', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length <= 1 ? Array.Empty<string>() : parts.Skip(1).Select(part => "." + part).ToArray();
    }

    private static IReadOnlyList<string> BuildNextSteps(string rootFormat, string resourceKind)
    {
        var steps = new List<string>
        {
            "Treat inspect results as envelope evidence only; do not assume semantic parsing succeeded."
        };

        if (rootFormat == "DCX") steps.Add("Use dcxPayloadBoundary evidence for reviewed payload offsets; treat decompressed previews as format hints until semantic parsers consume the payload.");
        if (rootFormat is "BND3" or "BND4") steps.Add("Prefer binderChildTable evidence when present; otherwise treat binderChildCandidate visible strings only as low-confidence hints.");
        if (resourceKind == "event") steps.Add("Use EMEVD candidate exports as low-confidence IDs until instruction table parsing is fixture-confirmed.");
        if (resourceKind == "map") steps.Add("Use MSB candidate exports as low-confidence names until entity tables are fixture-confirmed.");
        if (resourceKind == "param") steps.Add("Use PARAM candidate exports as low-confidence row IDs until row layout is fixture-confirmed.");
        if (resourceKind == "msg") steps.Add("Implement fixture-confirmed FMG export in export-msg, not inspect.");
        if (rootFormat == "unknown") steps.Add("Keep semantic exports unsupported until a reviewed parser can produce structured symbols.");

        return steps;
    }

    private static bool StartsWith(byte[] sample, byte[] magic)
    {
        if (sample.Length < magic.Length)
        {
            return false;
        }

        for (var index = 0; index < magic.Length; index += 1)
        {
            if (sample[index] != magic[index])
            {
                return false;
            }
        }

        return true;
    }

    private static string ToHex(byte[] sample, int count)
    {
        return string.Join(" ", sample.Take(count).Select(value => value.ToString("X2")));
    }

    private static string ToAscii(byte[] sample, int count)
    {
        return new string(sample.Take(count).Select(value => value >= 32 && value <= 126 ? (char)value : '.').ToArray());
    }

    private sealed record MagicRule(string RootFormat, byte[] Magic);
}

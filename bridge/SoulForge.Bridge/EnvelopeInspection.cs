using System.Text;

static class EnvelopeInspection
{
    public static InspectionResult Inspect(string sourcePath, byte[] sample, long length)
    {
        var magic = sample.Length >= 4 ? Encoding.ASCII.GetString(sample, 0, 4) : string.Empty;
        var rootFormat = DetectRootFormat(sourcePath, magic);
        var resourceKind = GuessKind(sourcePath);
        var evidence = new List<FormatEvidence>
        {
            new("magic", 0, magic.Replace("\0", "\\0"), string.IsNullOrEmpty(magic) ? "low" : "high"),
            new("extensionChain", 0, BuildExtensionChain(sourcePath), "medium")
        };
        var layers = new List<FormatLayer>
        {
            new(rootFormat, 0, length, rootFormat == "unknown" ? "low" : "medium", new { sampleBytes = sample.Length, inferredFromPath = string.IsNullOrEmpty(magic) })
        };
        var diagnostics = new List<Diagnostic>
        {
            new("info", "ENVELOPE_INSPECTED", "Read-only envelope inspection completed.", MakeSourceUri(sourcePath))
        };
        return new InspectionResult(
            File: new FileSummary(Path.GetFileName(sourcePath), length, Path.GetExtension(sourcePath).ToLowerInvariant(), BuildExtensionChain(sourcePath)),
            ResourceKind: resourceKind,
            RootFormat: rootFormat,
            ParseStatus: "partial",
            Layers: layers,
            Evidence: evidence,
            Diagnostics: diagnostics,
            NextSteps: BuildNextSteps(rootFormat, resourceKind));
    }

    private static string DetectRootFormat(string sourcePath, string magic)
    {
        if (magic == "DCX\0") return "DCX";
        if (magic == "BND3") return "BND3";
        if (magic == "BND4") return "BND4";
        if (magic == "EVD\0") return "EMEVD";
        if (magic == "FMG\0") return "FMG";

        var name = Path.GetFileName(sourcePath).ToLowerInvariant();
        if (name.EndsWith(".dcx")) return "DCX";
        if (name.Contains(".bnd")) return "BND";
        if (name.Contains("emevd")) return "EMEVD";
        if (name.Contains("msb")) return "MSB";
        if (name.Contains("param")) return "PARAM";
        if (name.EndsWith(".fmg") || name.Contains("msg")) return "FMG";
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
        var steps = new List<string>();
        if (rootFormat == "DCX") steps.Add("Add reviewed DCX payload reader boundary.");
        if (rootFormat is "BND" or "BND3" or "BND4") steps.Add("Parse binder child file table with fixtures.");
        if (resourceKind == "event") steps.Add("Parse EMEVD event, instruction, and argument tables.");
        if (resourceKind == "map") steps.Add("Parse MSB entities and regions.");
        if (resourceKind == "param") steps.Add("Parse PARAM rows and fields.");
        if (resourceKind == "msg") steps.Add("Parse FMG ID table authoritatively.");
        return steps.Count == 0 ? new[] { "Add a resource-specific parser after fixtures exist." } : steps;
    }

    private static string MakeSourceUri(string sourcePath)
    {
        return string.IsNullOrWhiteSpace(sourcePath) ? "file://unknown" : $"file://{Uri.EscapeDataString(sourcePath)}";
    }
}

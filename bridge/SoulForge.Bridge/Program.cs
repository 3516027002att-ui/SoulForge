using System.Text.Json;
using System.Text.Json.Serialization;

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

try
{
    var result = Run(args);
    Console.Out.WriteLine(JsonSerializer.Serialize(result, jsonOptions));
    Environment.ExitCode = result.ParseStatus == "failed" ? 2 : 0;
}
catch (Exception ex)
{
    var failed = BridgeResult<object>.Failed(
        sourcePath: args.Length > 1 ? args[1] : string.Empty,
        resourceKind: "unknown",
        code: "BRIDGE_UNHANDLED_EXCEPTION",
        message: ex.Message,
        details: ex.ToString());

    Console.Out.WriteLine(JsonSerializer.Serialize(failed, jsonOptions));
    Environment.ExitCode = 2;
}

static BridgeResult<object> Run(string[] args)
{
    if (args.Length < 2)
    {
        return BridgeResult<object>.Failed(
            sourcePath: string.Empty,
            resourceKind: "unknown",
            code: "BRIDGE_USAGE_ERROR",
            message: "Usage: soulforge-bridge <inspect|export-event|export-map|export-param|export-msg|validate> <file>");
    }

    var command = args[0].Trim().ToLowerInvariant();
    var file = args[1];
    var resourceKind = command switch
    {
        "export-event" => "event",
        "export-map" => "map",
        "export-param" => "param",
        "export-msg" => "msg",
        "validate" => GuessKindFromPath(file),
        _ => GuessKindFromPath(file)
    };

    if (!File.Exists(file))
    {
        return BridgeResult<object>.Failed(file, resourceKind, "FILE_NOT_FOUND", "Input file does not exist.");
    }

    if (command == "inspect" || command == "validate")
    {
        var inspection = EnvelopeInspection.Inspect(file, Array.Empty<byte>(), new FileInfo(file).Length);
        return BridgeResult<object>.Partial(file, inspection.ResourceKind, inspection.Diagnostics, inspection);
    }

    return command switch
    {
        "export-event" => BridgeResult<object>.Unsupported(file, "event", "Semantic EMEVD export is not implemented yet; inspect returns the audit envelope first."),
        "export-map" => BridgeResult<object>.Unsupported(file, "map", "Semantic MSB export is not implemented yet; inspect returns the audit envelope first."),
        "export-param" => BridgeResult<object>.Unsupported(file, "param", "Semantic PARAM export is not implemented yet; inspect returns the audit envelope first."),
        "export-msg" => BridgeResult<object>.Unsupported(file, "msg", "Semantic FMG export is not implemented yet; inspect returns the audit envelope first."),
        _ => BridgeResult<object>.Failed(file, resourceKind, "UNKNOWN_COMMAND", $"Unknown bridge command: {command}")
    };
}

static string GuessKindFromPath(string file)
{
    var normalized = file.Replace('\\', '/').ToLowerInvariant();
    foreach (var kind in new[] { "event", "map", "param", "msg", "menu", "script", "action", "ai", "sfx" })
    {
        if (normalized.Contains($"/{kind}/")) return kind;
    }

    var name = Path.GetFileName(file).ToLowerInvariant();
    if (name.Contains("emevd")) return "event";
    if (name.Contains("msb")) return "map";
    if (name.Contains("param")) return "param";
    if (name.Contains("msg") || name.EndsWith(".fmg")) return "msg";
    return "unknown";
}

sealed record Diagnostic(string Severity, string Code, string Message, string? SourceUri = null, object? Details = null);

sealed record BridgeResult<T>(string SourceUri, string SourcePath, string Game, string ResourceKind, string ParseStatus, IReadOnlyList<Diagnostic> Diagnostics, T? Data = default)
{
    public static BridgeResult<T> Unsupported(string sourcePath, string resourceKind, string message)
    {
        return new BridgeResult<T>(MakeSourceUri(sourcePath), sourcePath, "unknown", resourceKind, "unsupported", new[] { new Diagnostic("info", "SEMANTIC_EXPORT_NOT_IMPLEMENTED", message, MakeSourceUri(sourcePath)) });
    }

    public static BridgeResult<T> Failed(string sourcePath, string resourceKind, string code, string message, object? details = null)
    {
        return new BridgeResult<T>(MakeSourceUri(sourcePath), sourcePath, "unknown", resourceKind, "failed", new[] { new Diagnostic("error", code, message, MakeSourceUri(sourcePath), details) });
    }

    public static BridgeResult<T> Partial(string sourcePath, string resourceKind, IEnumerable<Diagnostic> diagnostics, T? data)
    {
        return new BridgeResult<T>(MakeSourceUri(sourcePath), sourcePath, "unknown", resourceKind, "partial", diagnostics.ToArray(), data);
    }

    private static string MakeSourceUri(string sourcePath)
    {
        return string.IsNullOrWhiteSpace(sourcePath) ? "file://unknown" : $"file://{Uri.EscapeDataString(sourcePath)}";
    }
}
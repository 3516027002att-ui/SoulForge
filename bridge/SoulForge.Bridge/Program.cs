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

    var command = args[0];
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
        return BridgeResult<object>.Failed(
            sourcePath: file,
            resourceKind: resourceKind,
            code: "FILE_NOT_FOUND",
            message: "Input file does not exist.");
    }

    return command switch
    {
        "inspect" => BridgeResult<object>.Unsupported(file, resourceKind, new
        {
            fileName = Path.GetFileName(file),
            size = new FileInfo(file).Length,
            extension = Path.GetExtension(file)
        }),
        "export-event" => BridgeResult<object>.Unsupported(file, "event", null),
        "export-map" => BridgeResult<object>.Unsupported(file, "map", null),
        "export-param" => BridgeResult<object>.Unsupported(file, "param", null),
        "export-msg" => BridgeResult<object>.Unsupported(file, "msg", null),
        "validate" => BridgeResult<object>.Validated(file, resourceKind),
        _ => BridgeResult<object>.Failed(
            sourcePath: file,
            resourceKind: resourceKind,
            code: "UNKNOWN_COMMAND",
            message: $"Unknown bridge command: {command}")
    };
}

static string GuessKindFromPath(string file)
{
    var normalized = file.Replace('\\', '/').ToLowerInvariant();
    foreach (var kind in new[] { "event", "map", "param", "msg", "menu", "script", "action", "ai", "sfx" })
    {
        if (normalized.Contains($"/{kind}/")) return kind;
    }
    return "unknown";
}

sealed record Diagnostic(
    string Severity,
    string Code,
    string Message,
    string? SourceUri = null,
    object? Details = null);

sealed record BridgeResult<T>(
    string SourceUri,
    string SourcePath,
    string Game,
    string ResourceKind,
    string ParseStatus,
    IReadOnlyList<Diagnostic> Diagnostics,
    T? Data = default)
{
    public static BridgeResult<T> Unsupported(string sourcePath, string resourceKind, T? data)
    {
        return new BridgeResult<T>(
            SourceUri: $"file://{Uri.EscapeDataString(sourcePath)}",
            SourcePath: sourcePath,
            Game: "unknown",
            ResourceKind: resourceKind,
            ParseStatus: "unsupported",
            Diagnostics: new[]
            {
                new Diagnostic(
                    Severity: "info",
                    Code: "PARSER_NOT_IMPLEMENTED",
                    Message: "Bridge command exists, but real format parsing is not implemented yet.")
            },
            Data: data);
    }

    public static BridgeResult<T> Failed(string sourcePath, string resourceKind, string code, string message, object? details = null)
    {
        return new BridgeResult<T>(
            SourceUri: string.IsNullOrWhiteSpace(sourcePath) ? "file://unknown" : $"file://{Uri.EscapeDataString(sourcePath)}",
            SourcePath: sourcePath,
            Game: "unknown",
            ResourceKind: resourceKind,
            ParseStatus: "failed",
            Diagnostics: new[]
            {
                new Diagnostic(
                    Severity: "error",
                    Code: code,
                    Message: message,
                    Details: details)
            });
    }

    public static BridgeResult<object> Validated(string sourcePath, string resourceKind)
    {
        using var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return new BridgeResult<object>(
            SourceUri: $"file://{Uri.EscapeDataString(sourcePath)}",
            SourcePath: sourcePath,
            Game: "unknown",
            ResourceKind: resourceKind,
            ParseStatus: "partial",
            Diagnostics: new[]
            {
                new Diagnostic(
                    Severity: "info",
                    Code: "VALIDATION_READABLE",
                    Message: "File exists and can be opened for read validation. No binary format parsing was attempted.")
            },
            Data: new
            {
                fileName = Path.GetFileName(sourcePath),
                size = stream.Length,
                extension = Path.GetExtension(sourcePath),
                readable = true
            });
    }
}

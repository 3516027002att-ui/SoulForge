using System.Text.Json;
using System.Text.Json.Serialization;

const int MaxPrefixBytes = 512 * 1024;

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
    var sourcePath = args.Length > 1 ? args[1] : string.Empty;
    var failed = BridgeResult<object>.Failed(
        sourcePath: sourcePath,
        resourceKind: string.IsNullOrWhiteSpace(sourcePath) ? "unknown" : GuessKindFromPath(sourcePath),
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
        _ => GuessKindFromPath(file)
    };

    if (!File.Exists(file))
    {
        return BridgeResult<object>.Failed(file, resourceKind, "FILE_NOT_FOUND", "Input file does not exist.");
    }

    if (command == "inspect" || command == "validate")
    {
        return InspectEnvelope(file, command == "validate");
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

static BridgeResult<object> InspectEnvelope(string file, bool includeReadableValidation)
{
    var fileInfo = new FileInfo(file);
    var sample = ReadBoundedPrefix(file);
    var inspection = EnvelopeInspection.Inspect(file, sample, fileInfo.Length, MaxPrefixBytes);
    var diagnostics = includeReadableValidation
        ? inspection.Diagnostics.Prepend(new Diagnostic(
            "info",
            "VALIDATION_READABLE",
            "File exists and its bounded prefix can be opened for read validation. No unpacking, decompression, or semantic parsing was attempted.",
            BridgeResult<object>.MakeSourceUri(file))).ToArray()
        : inspection.Diagnostics;

    return BridgeResult<object>.Partial(file, inspection.ResourceKind, diagnostics, inspection);
}

static byte[] ReadBoundedPrefix(string file, int maxBytes = MaxPrefixBytes)
{
    if (maxBytes < 0)
    {
        throw new ArgumentOutOfRangeException(nameof(maxBytes), "Maximum prefix size must be non-negative.");
    }

    var fileInfo = new FileInfo(file);
    if (!fileInfo.Exists)
    {
        throw new FileNotFoundException("Input file does not exist.", file);
    }

    var bytesToRead = (int)Math.Min(fileInfo.Length, maxBytes);
    if (bytesToRead == 0)
    {
        return Array.Empty<byte>();
    }

    var buffer = new byte[bytesToRead];
    using var stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);

    var totalRead = 0;
    while (totalRead < buffer.Length)
    {
        var read = stream.Read(buffer, totalRead, buffer.Length - totalRead);
        if (read == 0)
        {
            break;
        }

        totalRead += read;
    }

    if (totalRead == buffer.Length)
    {
        return buffer;
    }

    Array.Resize(ref buffer, totalRead);
    return buffer;
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

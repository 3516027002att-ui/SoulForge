using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

// Windows console defaults are not UTF-8; NDJSON frames must preserve Unicode (FMG Chinese, paths).
Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

if (args.Length > 0 && args[0].Equals("daemon", StringComparison.OrdinalIgnoreCase))
{
    await using var stdin = Console.OpenStandardInput();
    await using var stdout = Console.OpenStandardOutput();
    using var reader = new StreamReader(stdin, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, bufferSize: 64 * 1024, leaveOpen: true);
    await using var writer = new StreamWriter(stdout, new UTF8Encoding(false), bufferSize: 64 * 1024, leaveOpen: true) { AutoFlush = true, NewLine = "\n" };
    await BridgeDaemonHost.RunAsync(reader, writer, CancellationToken.None);
    return;
}

var service = new BridgeCommandService();
var configuredOodleRoot = Environment.GetEnvironmentVariable("SOULFORGE_SEKIRO_GAME_ROOT");
try
{
    BridgeResult<object> result;
    if (args.Length < 2)
    {
        result = BridgeResult<object>.Failed(
            sourcePath: string.Empty,
            resourceKind: "unknown",
            code: "BRIDGE_USAGE_ERROR",
            message: "Usage: soulforge-bridge <daemon|inspect|read-dcx-document|export-event|export-map|export-param|export-msg|validate|probe-oodle> <file-or-game-root>");
    }
    else
    {
        result = await service.ExecuteAsync(args[0], args[1], CancellationToken.None, configuredOodleRoot);
    }

    Console.Out.WriteLine(JsonSerializer.Serialize(result, jsonOptions));
    Environment.ExitCode = result.ParseStatus == "failed" ? 2 : 0;
}
catch (Exception ex)
{
    var sourcePath = args.Length > 1 ? args[1] : string.Empty;
    var failed = BridgeResult<object>.Failed(
        sourcePath: sourcePath,
        resourceKind: string.IsNullOrWhiteSpace(sourcePath)
            ? "unknown"
            : BridgeCommandService.GuessKindFromPath(sourcePath),
        code: "BRIDGE_UNHANDLED_EXCEPTION",
        message: ex.Message,
        details: ex.ToString());

    Console.Out.WriteLine(JsonSerializer.Serialize(failed, jsonOptions));
    Environment.ExitCode = 2;
}

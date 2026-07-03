sealed record Diagnostic(string Severity, string Code, string Message, string? SourceUri = null, object? Details = null);

sealed record BridgeResult<T>(string SourceUri, string SourcePath, string Game, string ResourceKind, string ParseStatus, IReadOnlyList<Diagnostic> Diagnostics, T? Data = default)
{
    public static BridgeResult<T> Unsupported(string sourcePath, string resourceKind, string message)
    {
        if (resourceKind == "msg" && File.Exists(sourcePath) && typeof(T) == typeof(object))
        {
            return (BridgeResult<T>)(object)MsgTextExport.Export(sourcePath);
        }

        return new BridgeResult<T>(
            MakeSourceUri(sourcePath),
            sourcePath,
            "unknown",
            resourceKind,
            "unsupported",
            new[] { new Diagnostic("info", "SEMANTIC_EXPORT_NOT_IMPLEMENTED", message, MakeSourceUri(sourcePath)) });
    }

    public static BridgeResult<T> Failed(string sourcePath, string resourceKind, string code, string message, object? details = null)
    {
        return new BridgeResult<T>(
            MakeSourceUri(sourcePath),
            sourcePath,
            "unknown",
            resourceKind,
            "failed",
            new[] { new Diagnostic("error", code, message, MakeSourceUri(sourcePath), details) });
    }

    public static BridgeResult<T> Partial(string sourcePath, string resourceKind, IEnumerable<Diagnostic> diagnostics, T? data)
    {
        return new BridgeResult<T>(MakeSourceUri(sourcePath), sourcePath, "unknown", resourceKind, "partial", diagnostics.ToArray(), data);
    }

    public static string MakeSourceUri(string sourcePath)
    {
        if (string.IsNullOrWhiteSpace(sourcePath))
        {
            return "file://unknown";
        }

        try
        {
            return new Uri(Path.GetFullPath(sourcePath)).AbsoluteUri;
        }
        catch
        {
            return $"file://{Uri.EscapeDataString(sourcePath)}";
        }
    }
}

sealed record FileSummary(string FileName, long Size, string Extension, IReadOnlyList<string> ExtensionChain);
sealed record InspectionResult(FileSummary File, string ResourceKind, string RootFormat, string ParseStatus, IReadOnlyList<FormatLayer> Layers, IReadOnlyList<FormatEvidence> Evidence, IReadOnlyList<Diagnostic> Diagnostics, IReadOnlyList<string> NextSteps);
sealed record FormatLayer(string Format, int Offset, long Length, string Confidence, object? Metadata = null);
sealed record FormatEvidence(string Kind, int Offset, object Value, string Confidence);

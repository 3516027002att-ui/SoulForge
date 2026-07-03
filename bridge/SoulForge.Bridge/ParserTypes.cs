sealed record FileSummary(string FileName, long Size, string Extension, IReadOnlyList<string> ExtensionChain);
sealed record InspectionResult(FileSummary File, string ResourceKind, string RootFormat, string ParseStatus, IReadOnlyList<FormatLayer> Layers, IReadOnlyList<FormatEvidence> Evidence, IReadOnlyList<Diagnostic> Diagnostics, IReadOnlyList<string> NextSteps);
sealed record FormatLayer(string Format, int Offset, long Length, string Confidence, object? Metadata = null);
sealed record FormatEvidence(string Kind, int Offset, object Value, string Confidence);

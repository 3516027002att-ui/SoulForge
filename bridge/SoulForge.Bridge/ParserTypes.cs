sealed record Diagnostic(string Severity, string Code, string Message, string? SourceUri = null, object? Details = null);

/// <summary>
/// Bridge 结果信封。硬约束 9 要求每个资源输出都带 sourceUri / sourcePath /
/// game / resourceKind / diagnostics。
///
/// ⚠️ <see cref="GameUnknown"/>：Game 字段在 Bridge 侧**只能是占位值**，这不是
/// 待补的 TODO，是结构使然——握手 payload 不含 game（BridgeHandshakePayload 只有
/// allowedRoots / writableRoots / oodleRuntimeRoot / maxFrameBytes /
/// maxConcurrency），Bridge 从请求里无从得知游戏版本，而按路径猜测会在 mod 目录
/// 与解包目录上给出不同答案。
///
/// 权威来源在 TS 侧：IndexedFile.game 由 scanWorkspace 按工作区 session 元数据
/// 赋值（scanWorkspace.ts:131），原生写入门禁判的就是它
/// （apps/desktop/src/main/ipc.ts:621 rejectNonSekiroNativeWrite，非 sekiro 时报
/// NATIVE_WRITE_GAME_UNSUPPORTED 拒绝写入）。
///
/// 2026-08-08 实测：Bridge 信封的 game 字段**全仓零消费者**——ingestBridgeResult
/// 不读它，也没有任何一处读 result.game / envelope.game。所以现状不产生错误行为。
/// 但**不要**据此给它硬造一个 "sekiro"：那会让一个无依据的值看起来可信，而下游
/// 若真开始据它做判断，判断的基础是 Bridge 猜的而不是工作区声明的。
/// 要让 Bridge 报真实 game，正确做法是先在握手 payload 里增加该字段由 TS 侧传入。
/// </summary>
sealed record BridgeResult<T>(string SourceUri, string SourcePath, string Game, string ResourceKind, string ParseStatus, IReadOnlyList<Diagnostic> Diagnostics, T? Data = default)
{
    /// <summary>
    /// Bridge 侧 Game 字段的唯一合法取值。具名常量而非三处字面量：字面量散落时，
    /// 「为什么这里是 unknown」这个问题要在三个地方各答一次，而任何一处被人「顺手
    /// 填成 sekiro」都不会有编译错误或测试失败。
    /// </summary>
    public const string GameUnknown = "unknown";
    public static BridgeResult<T> Unsupported(string sourcePath, string resourceKind, string message)
    {
        return new BridgeResult<T>(
            MakeSourceUri(sourcePath),
            sourcePath,
            GameUnknown,
            resourceKind,
            "unsupported",
            new[] { new Diagnostic("info", "SEMANTIC_EXPORT_NOT_IMPLEMENTED", message, MakeSourceUri(sourcePath)) });
    }

    public static BridgeResult<T> Failed(string sourcePath, string resourceKind, string code, string message, object? details = null)
    {
        return new BridgeResult<T>(
            MakeSourceUri(sourcePath),
            sourcePath,
            GameUnknown,
            resourceKind,
            "failed",
            new[] { new Diagnostic("error", code, message, MakeSourceUri(sourcePath), details) });
    }

    public static BridgeResult<T> Partial(string sourcePath, string resourceKind, IEnumerable<Diagnostic> diagnostics, T? data)
    {
        return new BridgeResult<T>(MakeSourceUri(sourcePath), sourcePath, GameUnknown, resourceKind, "partial", diagnostics.ToArray(), data);
    }

    public static BridgeResult<T> Ok(string sourcePath, string resourceKind, T data)
    {
        return new BridgeResult<T>(
            MakeSourceUri(sourcePath),
            sourcePath,
            GameUnknown,
            resourceKind,
            "ok",
            Array.Empty<Diagnostic>(),
            data);
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

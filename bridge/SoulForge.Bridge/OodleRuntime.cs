using System.Diagnostics;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

internal static class OodleRuntimeLocator
{
    internal const string ExpectedRuntimeFileName = "oo2core_6_win64.dll";
    private const int ExpectedRuntimeMajor = 6;
    private static readonly string[] RequiredExports = { "OodleLZ_Decompress" };
    private static readonly string[] OptionalExports = { "OodleLZ_Compress" };

    public static OodleRuntimeOpenResult Open(string? gameRoot, string? sourceUri = null)
    {
        if (string.IsNullOrWhiteSpace(gameRoot))
        {
            return Failed(
                "not-configured",
                "none",
                "OODLE_RUNTIME_ROOT_NOT_CONFIGURED",
                "尚未挂载 Sekiro 原版游戏目录；KRAK 只能进行原始字节读取，不能解压。",
                sourceUri);
        }

        if (!Directory.Exists(gameRoot))
        {
            return Failed(
                "game-root-missing",
                "none",
                "OODLE_GAME_ROOT_MISSING",
                "已配置的 Sekiro 原版游戏目录不存在。",
                sourceUri);
        }

        var canonicalRoot = BridgePathBoundary.ResolveExistingPath(gameRoot);
        if (!File.Exists(Path.Combine(canonicalRoot, "sekiro.exe")))
        {
            return Failed(
                "game-executable-missing",
                "none",
                "OODLE_GAME_EXECUTABLE_MISSING",
                "所选目录中没有 sekiro.exe；拒绝从非 Sekiro 目录加载原生运行库。",
                sourceUri);
        }

        var expectedPath = Path.Combine(canonicalRoot, ExpectedRuntimeFileName);
        if (!File.Exists(expectedPath))
        {
            var otherVersions = Directory
                .EnumerateFiles(canonicalRoot, "oo2core_*_win64.dll", SearchOption.TopDirectoryOnly)
                .Select(Path.GetFileName)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                .ToArray();
            if (otherVersions.Length > 0)
            {
                return Failed(
                    "version-mismatch",
                    "none",
                    "OODLE_RUNTIME_VERSION_MISMATCH",
                    $"Sekiro 适配要求 {ExpectedRuntimeFileName}，但目录中只发现其他 Oodle 版本。",
                    sourceUri,
                    new { expected = ExpectedRuntimeFileName, found = otherVersions });
            }

            return Failed(
                "missing",
                "none",
                "OODLE_RUNTIME_MISSING",
                $"Sekiro 目录中缺少 {ExpectedRuntimeFileName}；不会从网络下载或随 SoulForge 分发该文件。",
                sourceUri,
                new { expected = ExpectedRuntimeFileName });
        }

        var boundary = BridgePathBoundary.Verify(expectedPath, new[] { canonicalRoot });
        if (!boundary.Ok)
        {
            return Failed(
                "path-unsafe",
                "none",
                boundary.Code,
                "Oodle 运行库路径越过了已授权的 Sekiro 目录。",
                sourceUri);
        }

        var pe = InspectPe(boundary.CanonicalPath);
        if (!pe.Ok)
        {
            return Failed(
                pe.Status,
                "none",
                pe.Code,
                pe.Message,
                sourceUri,
                new { runtimeFileName = ExpectedRuntimeFileName, architecture = pe.Architecture });
        }

        nint libraryHandle;
        try
        {
            libraryHandle = NativeLibrary.Load(boundary.CanonicalPath);
        }
        catch (Exception ex) when (ex is DllNotFoundException or BadImageFormatException or FileLoadException)
        {
            return Failed(
                "load-failed",
                "none",
                "OODLE_RUNTIME_LOAD_FAILED",
                "Sekiro Oodle 运行库存在，但无法由当前 Bridge 进程加载。",
                sourceUri,
                new { exception = ex.GetType().Name, ex.Message });
        }

        try
        {
            var available = new List<string>();
            var missing = new List<string>();
            foreach (var export in RequiredExports.Concat(OptionalExports))
            {
                if (NativeLibrary.TryGetExport(libraryHandle, export, out _)) available.Add(export);
                else if (RequiredExports.Contains(export, StringComparer.Ordinal)) missing.Add(export);
            }

            if (missing.Count > 0)
            {
                NativeLibrary.Free(libraryHandle);
                return Failed(
                    "export-missing",
                    "none",
                    "OODLE_RUNTIME_EXPORT_MISSING",
                    "Sekiro Oodle 运行库缺少 KRAK 解压所需导出，已拒绝使用。",
                    sourceUri,
                    new { runtimeFileName = ExpectedRuntimeFileName, missingExports = missing });
            }

            NativeLibrary.TryGetExport(libraryHandle, "OodleLZ_Decompress", out var decompressExport);
            var capability = available.Contains("OodleLZ_Compress", StringComparer.Ordinal)
                ? "compress-decompress"
                : "decompress-only";
            var info = BuildInfo(
                status: "ready",
                capability,
                boundary.CanonicalPath,
                pe.Architecture,
                available,
                Array.Empty<string>());
            var diagnostic = new Diagnostic(
                "info",
                "OODLE_RUNTIME_READY",
                capability == "compress-decompress"
                    ? "已验证 Sekiro Oodle 运行库的 KRAK 解压和压缩导出。"
                    : "已验证 Sekiro Oodle 运行库的 KRAK 解压导出；压缩导出不可用。",
                sourceUri,
                new
                {
                    info.RuntimeFileName,
                    info.RuntimeMajor,
                    info.Architecture,
                    info.Sha256,
                    info.Capability,
                    info.AvailableExports
                });
            return new OodleRuntimeOpenResult(
                info,
                new[] { diagnostic },
                new OodleRuntimeSession(libraryHandle, decompressExport));
        }
        catch
        {
            NativeLibrary.Free(libraryHandle);
            throw;
        }
    }

    public static OodleRuntimeProbeResult Probe(string? gameRoot, string? sourceUri = null)
    {
        using var opened = Open(gameRoot, sourceUri);
        return new OodleRuntimeProbeResult(opened.Info, opened.Diagnostics);
    }

    private static OodleRuntimeOpenResult Failed(
        string status,
        string capability,
        string code,
        string message,
        string? sourceUri,
        object? details = null)
    {
        return new OodleRuntimeOpenResult(
            new OodleRuntimePublicInfo(
                status,
                capability,
                null,
                null,
                null,
                null,
                Array.Empty<string>(),
                Array.Empty<string>()),
            new[] { new Diagnostic("warning", code, message, sourceUri, details) },
            null);
    }

    private static OodleRuntimePublicInfo BuildInfo(
        string status,
        string capability,
        string runtimePath,
        string architecture,
        IReadOnlyList<string> availableExports,
        IReadOnlyList<string> missingExports)
    {
        var version = FileVersionInfo.GetVersionInfo(runtimePath);
        return new OodleRuntimePublicInfo(
            status,
            capability,
            Path.GetFileName(runtimePath),
            ExpectedRuntimeMajor,
            architecture,
            Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(runtimePath))).ToLowerInvariant(),
            availableExports,
            missingExports,
            string.IsNullOrWhiteSpace(version.FileVersion) ? null : version.FileVersion);
    }

    private static PeInspection InspectPe(string runtimePath)
    {
        try
        {
            using var stream = File.Open(runtimePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var reader = new PEReader(stream, PEStreamOptions.LeaveOpen);
            if (!reader.HasMetadata && reader.PEHeaders.PEHeader is null)
            {
                return PeInspection.Failed("invalid-pe", "OODLE_RUNTIME_INVALID_PE", "Oodle 运行库不是有效的 Windows PE 文件。", "unknown");
            }
            var machine = reader.PEHeaders.CoffHeader.Machine;
            var architecture = machine.ToString();
            if (machine != System.Reflection.PortableExecutable.Machine.Amd64)
            {
                return PeInspection.Failed("architecture-mismatch", "OODLE_RUNTIME_ARCHITECTURE_MISMATCH", "Oodle 运行库不是 x64 架构。", architecture);
            }
            if (reader.PEHeaders.PEHeader?.Magic != PEMagic.PE32Plus)
            {
                return PeInspection.Failed("architecture-mismatch", "OODLE_RUNTIME_ARCHITECTURE_MISMATCH", "Oodle 运行库不是 PE32+ x64 文件。", architecture);
            }
            return new PeInspection(true, "ready", string.Empty, string.Empty, "x64");
        }
        catch (Exception ex) when (ex is BadImageFormatException or IOException)
        {
            return PeInspection.Failed(
                "invalid-pe",
                "OODLE_RUNTIME_INVALID_PE",
                "无法读取 Oodle 运行库的 PE 结构。",
                "unknown",
                ex.GetType().Name);
        }
    }

    private sealed record PeInspection(
        bool Ok,
        string Status,
        string Code,
        string Message,
        string Architecture,
        string? Exception = null)
    {
        public static PeInspection Failed(
            string status,
            string code,
            string message,
            string architecture,
            string? exception = null) => new(false, status, code, message, architecture, exception);
    }
}

internal sealed class OodleRuntimeSession : IDisposable
{
    private readonly nint _libraryHandle;
    private readonly OodleLzDecompress _decompress;
    private bool _disposed;

    public OodleRuntimeSession(nint libraryHandle, nint decompressExport)
    {
        _libraryHandle = libraryHandle;
        _decompress = Marshal.GetDelegateForFunctionPointer<OodleLzDecompress>(decompressExport);
    }

    public byte[] Decompress(ReadOnlySpan<byte> compressed, int uncompressedSize)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (compressed.IsEmpty) throw new InvalidDataException("KRAK compressed payload is empty.");
        if (uncompressedSize <= 0) throw new InvalidDataException("KRAK uncompressed size must be positive.");

        var compressedBytes = compressed.ToArray();
        var compressedPtr = Marshal.AllocHGlobal(compressedBytes.Length);
        var outputPtr = Marshal.AllocHGlobal(uncompressedSize);
        try
        {
            Marshal.Copy(compressedBytes, 0, compressedPtr, compressedBytes.Length);
            var written = _decompress(
                compressedPtr,
                (nuint)compressedBytes.Length,
                outputPtr,
                (nuint)uncompressedSize,
                fuzzSafe: 1,
                checkCrc: 0,
                verbosity: 0,
                decBufBase: nint.Zero,
                decBufSize: 0,
                callback: nint.Zero,
                callbackUserData: nint.Zero,
                decoderMemory: nint.Zero,
                decoderMemorySize: 0,
                threadPhase: 3);
            if (written != uncompressedSize)
            {
                throw new InvalidDataException($"OodleLZ_Decompress returned {written}, expected {uncompressedSize} byte(s).");
            }
            var output = new byte[uncompressedSize];
            Marshal.Copy(outputPtr, output, 0, output.Length);
            return output;
        }
        finally
        {
            Marshal.FreeHGlobal(outputPtr);
            Marshal.FreeHGlobal(compressedPtr);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        NativeLibrary.Free(_libraryHandle);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint OodleLzDecompress(
        nint compressedBuffer,
        nuint compressedSize,
        nint rawBuffer,
        nuint rawSize,
        int fuzzSafe,
        int checkCrc,
        int verbosity,
        nint decBufBase,
        nuint decBufSize,
        nint callback,
        nint callbackUserData,
        nint decoderMemory,
        nuint decoderMemorySize,
        int threadPhase);
}

internal sealed record OodleRuntimePublicInfo(
    string Status,
    string Capability,
    string? RuntimeFileName,
    int? RuntimeMajor,
    string? Architecture,
    string? Sha256,
    IReadOnlyList<string> AvailableExports,
    IReadOnlyList<string> MissingExports,
    string? FileVersion = null);

internal sealed record OodleRuntimeProbeResult(
    OodleRuntimePublicInfo Runtime,
    IReadOnlyList<Diagnostic> Diagnostics);

internal sealed record OodleRuntimeOpenResult(
    OodleRuntimePublicInfo Info,
    IReadOnlyList<Diagnostic> Diagnostics,
    OodleRuntimeSession? Session) : IDisposable
{
    public void Dispose() => Session?.Dispose();
}

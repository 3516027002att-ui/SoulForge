using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using SoulForge.Bridge.FirstParty.HksDecompiler;
using SoulForge.Bridge.FirstParty.HksDecompiler.LanguageDecompilers;
using SoulForge.Bridge.FirstParty.HksDecompiler.IR;
using SoulForge.Bridge.FirstParty.HksDecompiler.Utilities;

internal static class HksSemanticService
{
    public const string Dialect = "sekiro-hks-1.6.x";
    public const string Lua50Dialect = "sekiro-lua50-1.6.x";
    public const string Package = "soulforge-sekiro-hks-schema";
    public const string SchemaRevision = "2026.09.17";
    public const string CompilerRevision = "soulforge-hksc-sekiro-1";
    public const string DecompilerRevision = "soulforge-hks-ir-1";
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private const int MaxHksOpcode = 91;
    private const int MaxLua50Opcode = 34;
    private static readonly string[] OpcodeNames =
    {
        "GETFIELD", "TEST", "CALL_I", "CALL_C", "EQ", "EQ_BK", "GETGLOBAL", "MOVE", "SELF", "RETURN",
        "GETTABLE_S", "GETTABLE_N", "GETTABLE", "LOADBOOL", "TFORLOOP", "SETFIELD", "SETTABLE_S", "SETTABLE_S_BK",
        "SETTABLE_N", "SETTABLE_N_BK", "SETTABLE", "SETTABLE_BK", "TAILCALL_I", "TAILCALL_C", "TAILCALL_M", "LOADK",
        "LOADNIL", "SETGLOBAL", "JMP", "CALL_M", "CALL", "INTRINSIC_INDEX", "INTRINSIC_NEWINDEX", "INTRINSIC_SELF",
        "INTRINSIC_INDEX_LITERAL", "INTRINSIC_NEWINDEX_LITERAL", "INTRINSIC_SELF_LITERAL", "TAILCALL", "GETUPVAL", "SETUPVAL",
        "ADD", "ADD_BK", "SUB", "SUB_BK", "MUL", "MUL_BK", "DIV", "DIV_BK", "MOD", "MOD_BK", "POW", "POW_BK",
        "NEWTABLE", "UNM", "NOT", "LEN", "LT", "LT_BK", "LE", "LE_BK", "CONCAT", "TESTSET", "FORPREP", "FORLOOP",
        "SETLIST", "CLOSE", "CLOSURE", "VARARG", "TAILCALL_I_R1", "CALL_I_R1", "SETUPVAL_R1", "TEST_R1", "NOT_R1",
        "GETFIELD_R1", "SETFIELD_R1", "NEWSTRUCT", "DATA", "SETSLOTN", "SETSLOTI", "SETSLOT", "SETSLOTS", "SETSLOTMT",
        "CHECKTYPE", "CHECKTYPES", "GETSLOT", "GETSLOTMT", "SELFSLOT", "SELFSLOTMT", "GETFIELD_MM", "CHECKTYPE_D", "GETSLOT_D",
        "GETGLOBAL_MEM"
    };

    public static bool IsSekiroHks(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 14
        && bytes[0] == 0x1B && bytes[1] == (byte)'L' && bytes[2] == (byte)'u' && bytes[3] == (byte)'a'
        && bytes[4] == 0x51 && bytes[5] == 0x0E && bytes[6] == 0x00
        && bytes[7] == 0x04 && bytes[8] == 0x08 && bytes[9] == 0x04 && bytes[10] == 0x04
        && bytes[11] == 0x00 && bytes[12] == 0x03 && bytes[13] == 0x00;

    public static bool IsSekiroLua50(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 14
        && bytes[0] == 0x1B && bytes[1] == (byte)'L' && bytes[2] == (byte)'u' && bytes[3] == (byte)'a'
        && bytes[4] == 0x50
        // LuaP header: little-endian marker, 32-bit int/instruction and the
        // Sekiro Lua 5.0 field layout (6/8/9/9/8).
        && (bytes[5] == 0x00 || bytes[5] == 0x01)
        && bytes[6] == 0x04 && bytes[8] == 0x04 && bytes[9] == 0x06
        && bytes[10] == 0x08 && bytes[11] == 0x09 && bytes[12] == 0x09 && bytes[13] == 0x08;

    public static HksReadResult Read(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length <= 0 || bytes.Length > MaxSourceBytes)
            return HksReadResult.Failed("HKS_SOURCE_SIZE_INVALID", "HKS 源文件大小超出 64 MiB 安全范围。");
        var dialect = IsSekiroLua50(bytes)
            ? Lua50Dialect
            : IsSekiroHks(bytes)
                ? Dialect
                : null;
        if (dialect is null)
            return HksReadResult.Failed("HKS_DIALECT_NOT_SUPPORTED", "输入不是当前 Sekiro 1.6.x HKS dialect；未来版本不计入当前覆盖声明。");

        try
        {
            using var stream = new MemoryStream(bytes.ToArray(), writable: false);
            var reader = new BinaryReaderEx(false, stream);
            var lua = new LuaFile(reader);
            var coverage = InspectCoverage(lua.MainFunction, lua.Version);
            if (coverage.UnknownOpcodes.Count > 0)
            {
                return HksReadResult.Failed(
                    "HKS_OPCODE_COVERAGE_GAP",
                    $"当前 HKS 语料出现未知 opcode：{string.Join(", ", coverage.UnknownOpcodes)}。",
                    coverage);
            }

            var decompiler = new LuaDecompiler(new DecompilationOptions
            {
                CatchPassExceptions = true,
                ExtraValidation = true,
                OutputDebugComments = false,
                IgnoreDebugInfo = false
            });
            var main = new Function(lua.MainFunction.FunctionId);
            ILanguageDecompiler language = lua.Version switch
            {
                LuaFile.LuaVersion.Lua50 => new Lua50Decompiler(),
                LuaFile.LuaVersion.Lua51Hks => new HksDecompiler(),
                LuaFile.LuaVersion.Lua53Smash => new Lua53Decompiler(),
                _ => throw new NotSupportedException("未知 Lua 字节码版本。")
            };
            var result = decompiler.DecompileLuaFunction(language, main, lua.MainFunction);
            if (string.IsNullOrWhiteSpace(result.DecompiledSource))
            {
                return HksReadResult.Failed(
                    "HKS_DECOMPILATION_FAILED",
                    result.ErrorMessage ?? "SoulForge 内置 HKS IR 未能生成完整源码。",
                    coverage);
            }

            return HksReadResult.Succeeded(
                result.DecompiledSource,
                Hash(bytes),
                lua.FunctionCount(),
                coverage,
                dialect);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return HksReadResult.Failed("HKS_DOCUMENT_READ_FAILED", ex.Message);
        }
    }

    public static HksCompileResult Compile(string source, string? expectedDialect)
    {
        if (!string.IsNullOrWhiteSpace(expectedDialect)
            && !string.Equals(expectedDialect, Dialect, StringComparison.Ordinal)
            && !string.Equals(expectedDialect, Lua50Dialect, StringComparison.Ordinal))
        {
            return HksCompileResult.Failed("HKS_DIALECT_MISMATCH", $"只允许编译 {Dialect}，收到 {expectedDialect}。");
        }
        if (string.IsNullOrWhiteSpace(source))
            return HksCompileResult.Failed("HKS_SOURCE_EMPTY", "HKS 源码不能为空。");

        var sourceBytes = Encoding.UTF8.GetBytes(source);
        if (sourceBytes.Length > MaxSourceBytes)
            return HksCompileResult.Failed("HKS_SOURCE_SIZE_INVALID", "HKS 源码超过 64 MiB 安全范围。");
        var lua50 = string.Equals(expectedDialect, Lua50Dialect, StringComparison.Ordinal);
        if (!HksNativeCompiler.TryCompile(sourceBytes, out var compiled, out var error, out var code, lua50))
            return HksCompileResult.Failed(code, error, dialect: lua50 ? Lua50Dialect : Dialect);
        if (lua50)
        {
            if (!IsSekiroLua50(compiled))
                return HksCompileResult.Failed("LUA50_COMPILER_OUTPUT_DIALECT_INVALID", "内置编译器输出不是 Sekiro LuaP 0x50 dialect。", new HksCoverage(0, 0, 0, Array.Empty<string>(), MaxLua50Opcode + 1), Lua50Dialect);
        }
        else if (!IsSekiroHks(compiled))
        {
            return HksCompileResult.Failed("HKS_COMPILER_OUTPUT_DIALECT_INVALID", "内置编译器输出不是 Sekiro 1.6.x HKS dialect。", null, Dialect);
        }

        var read = Read(compiled);
        if (!read.Ok)
            return HksCompileResult.Failed(lua50 ? "LUA50_COMPILER_OUTPUT_INVALID" : "HKS_COMPILER_OUTPUT_INVALID", $"编译后 native 重读失败：{read.Message}", read.Coverage, lua50 ? Lua50Dialect : Dialect);
        return HksCompileResult.Succeeded(compiled, Hash(compiled), read.Coverage, read.FunctionCount, lua50 ? Lua50Dialect : Dialect);
    }

    private static HksCoverage InspectCoverage(LuaFile.Function function, LuaFile.LuaVersion version)
    {
        var unknown = new SortedSet<string>(StringComparer.Ordinal);
        var opcodeCount = 0;
        var instructionCount = 0;
        var functionCount = 0;

        void Visit(LuaFile.Function current)
        {
            functionCount++;
            for (var offset = 0; offset + 4 <= current.Bytecode.Length; offset += 4)
            {
                instructionCount++;
                var instruction = version == LuaFile.LuaVersion.Lua50
                    ? BinaryPrimitives.ReadUInt32LittleEndian(current.Bytecode.AsSpan(offset, 4))
                    : BinaryPrimitives.ReadUInt32BigEndian(current.Bytecode.AsSpan(offset, 4));
                var opcode = version == LuaFile.LuaVersion.Lua50
                    ? instruction & 0x3Fu
                    : (instruction >> 25) & 0x7Fu;
                opcodeCount++;
                var maxOpcode = version == LuaFile.LuaVersion.Lua50 ? MaxLua50Opcode : MaxHksOpcode;
                if (opcode > maxOpcode)
                    unknown.Add($"{opcode} (0x{opcode:X2})");
            }
            foreach (var child in current.ChildFunctions) Visit(child);
        }

        Visit(function);
        var coveredOpcodes = version == LuaFile.LuaVersion.Lua50 ? MaxLua50Opcode + 1 : OpcodeNames.Length;
        return new HksCoverage(functionCount, instructionCount, opcodeCount, unknown.ToArray(), coveredOpcodes);
    }

    private static string Hash(ReadOnlySpan<byte> bytes) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()}";

    private static string Hash(byte[] bytes) => Hash(bytes.AsSpan());

    public sealed record HksCoverage(
        int FunctionCount,
        int InstructionCount,
        int OpcodeCount,
        IReadOnlyList<string> UnknownOpcodes,
        int CoveredOpcodeCount);

    public sealed record HksReadResult(
        bool Ok,
        string? SourceText,
        string? SourceHash,
        int FunctionCount,
        string Message,
        HksCoverage Coverage,
        string Dialect)
    {
        public static HksReadResult Succeeded(string source, string hash, int functions, HksCoverage coverage, string dialect) =>
            new(true, source, hash, functions, string.Empty, coverage, dialect);

        public static HksReadResult Failed(string code, string message, HksCoverage? coverage = null) =>
            new(false, null, null, 0, $"{code}: {message}", coverage ?? new HksCoverage(0, 0, 0, Array.Empty<string>(), OpcodeNames.Length), "unknown");
    }

    public sealed record HksCompileResult(
        bool Ok,
        byte[] Bytes,
        string? OutputHash,
        HksCoverage Coverage,
        int FunctionCount,
        string Message,
        string Dialect)
    {
        public static HksCompileResult Succeeded(byte[] bytes, string hash, HksCoverage coverage, int functions, string dialect) =>
            new(true, bytes, hash, coverage, functions, string.Empty, dialect);

        public static HksCompileResult Failed(string code, string message, HksCoverage? coverage = null, string dialect = HksSemanticService.Dialect) =>
            new(false, Array.Empty<byte>(), null, coverage ?? new HksCoverage(0, 0, 0, Array.Empty<string>(), OpcodeNames.Length), 0, $"{code}: {message}", dialect);
    }
}

internal static class LuaFileCoverageExtensions
{
    public static int FunctionCount(this LuaFile file)
    {
        var count = 0;
        void Visit(LuaFile.Function function)
        {
            count++;
            foreach (var child in function.ChildFunctions) Visit(child);
        }
        Visit(file.MainFunction);
        return count;
    }
}

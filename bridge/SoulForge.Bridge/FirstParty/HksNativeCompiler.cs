using System.Runtime.InteropServices;

internal static class HksNativeCompiler
{
    private const string LibraryName = "SoulForge.Hksc.Native.dll";

    public static bool IsAvailable => File.Exists(Path.Combine(AppContext.BaseDirectory, LibraryName));

    static HksNativeCompiler()
    {
        NativeLibrary.SetDllImportResolver(typeof(HksNativeCompiler).Assembly, (name, _, _) =>
        {
            if (!string.Equals(name, LibraryName, StringComparison.OrdinalIgnoreCase)) return IntPtr.Zero;
            var path = Path.Combine(AppContext.BaseDirectory, LibraryName);
            return File.Exists(path) ? NativeLibrary.Load(path) : IntPtr.Zero;
        });
    }

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "SoulForgeHksCompile")]
    private static extern int CompileNative(
        [In] byte[] source,
        nuint sourceSize,
        out IntPtr output,
        out nuint outputSize,
        [Out] byte[] error,
        nuint errorSize);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "SoulForgeLua50Compile")]
    private static extern int CompileLua50Native(
        [In] byte[] source,
        nuint sourceSize,
        out IntPtr output,
        out nuint outputSize,
        [Out] byte[] error,
        nuint errorSize);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "SoulForgeHksFree")]
    private static extern void FreeNative(IntPtr pointer);

    private delegate int NativeCompileDelegate(
        [In] byte[] source,
        nuint sourceSize,
        out IntPtr output,
        out nuint outputSize,
        [Out] byte[] error,
        nuint errorSize);

    public static bool TryCompile(
        ReadOnlySpan<byte> source,
        out byte[] compiled,
        out string error,
        out string failureCode,
        bool lua50 = false)
    {
        compiled = Array.Empty<byte>();
        error = string.Empty;
        failureCode = string.Empty;
        var input = source.ToArray();
        var errorBytes = new byte[4096];
        IntPtr output = IntPtr.Zero;
        try
        {
            NativeCompileDelegate compile = lua50 ? CompileLua50Native : CompileNative;
            var status = compile(input, (nuint)input.Length, out output, out var outputSize, errorBytes, (nuint)errorBytes.Length);
            error = DecodeError(errorBytes);
            if (status != 0)
            {
                failureCode = status == 4 ? "HKS_COMPILER_OUT_OF_MEMORY" : "HKS_COMPILER_FAILED";
                return false;
            }
            if (output == IntPtr.Zero || outputSize == 0 || outputSize > 64u * 1024u * 1024u)
            {
                failureCode = "HKS_COMPILER_OUTPUT_INVALID";
                error = "SoulForge HKS compiler returned an invalid output buffer.";
                return false;
            }
            compiled = new byte[(int)outputSize];
            Marshal.Copy(output, compiled, 0, compiled.Length);
            return true;
        }
        catch (DllNotFoundException)
        {
            failureCode = "FIRST_PARTY_HKS_ENGINE_MISSING";
            error = "SoulForge 内置 HKS 编译资源缺失；不会尝试加载外部编译器。";
            return false;
        }
        catch (EntryPointNotFoundException)
        {
            failureCode = "FIRST_PARTY_HKS_ENGINE_INVALID";
            error = "SoulForge 内置 HKS 编译资源的 ABI 不匹配。";
            return false;
        }
        catch (BadImageFormatException)
        {
            failureCode = "FIRST_PARTY_HKS_ENGINE_ARCHITECTURE_MISMATCH";
            error = "SoulForge 内置 HKS 编译资源不是当前 Bridge 的 x64 架构。";
            return false;
        }
        finally
        {
            if (output != IntPtr.Zero)
            {
                try { FreeNative(output); } catch { /* native cleanup is best-effort */ }
            }
        }
    }

    private static string DecodeError(byte[] bytes)
    {
        var length = Array.IndexOf(bytes, (byte)0);
        if (length < 0) length = bytes.Length;
        return System.Text.Encoding.UTF8.GetString(bytes, 0, length).Trim();
    }
}

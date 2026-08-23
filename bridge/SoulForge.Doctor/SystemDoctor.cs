using System.Runtime.Versioning;
using Microsoft.Win32;

namespace SoulForge.Doctor;

[SupportedOSPlatform("windows")]
public static class SystemDoctor
{
    public const string VcRedistDownloadUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

    public static DoctorItem Inspect()
    {
        var item = new DoctorItem
        {
            Key = "system_vcredist",
            Title = "系统底层运行库 (VC++ 2015-2022 x64)",
            Fixable = false
        };

        if (!Environment.Is64BitOperatingSystem)
        {
            item.Status = DoctorStatus.Fail;
            item.Message = "SoulForge 要求 64 位 Windows 操作系统。";
            return item;
        }

        var isVcInstalled = false;
        string? version = null;

        if (OperatingSystem.IsWindows())
        {
            try
            {
                var keys = new[]
                {
                    @"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64",
                    @"SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\X64"
                };

                foreach (var k in keys)
                {
                    using var key = Registry.LocalMachine.OpenSubKey(k);
                    if (key != null)
                    {
                        var installed = key.GetValue("Installed");
                        if (installed is int intVal && intVal == 1)
                        {
                            isVcInstalled = true;
                            version = key.GetValue("Version") as string;
                            break;
                        }
                    }
                }
            }
            catch
            {
                // 忽略注册表访问错误
            }
        }

        item.Details = new
        {
            is64BitOs = Environment.Is64BitOperatingSystem,
            isVcInstalled,
            version,
            downloadUrl = VcRedistDownloadUrl
        };

        if (isVcInstalled)
        {
            item.Status = DoctorStatus.Pass;
            item.Message = $"已安装 Visual C++ 2015-2022 x64 运行库 (版本: {version ?? "14.x"})";
        }
        else
        {
            item.Status = DoctorStatus.Warn;
            item.Message = $"未检测到 VC++ 2015-2022 x64 运行库；若运行时发生 DLL 缺失错误，请前往下载安装：{VcRedistDownloadUrl}";
        }

        return item;
    }
}

using System.Runtime.Versioning;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace SoulForge.Doctor;

[SupportedOSPlatform("windows")]
public static class SteamLocator
{
    private const string SekiroAppId = "814380";

    public static List<string> LocateSekiroCandidates(string? manualPath = null)
    {
        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrWhiteSpace(manualPath) && Directory.Exists(manualPath))
        {
            if (IsValidSekiroDirectory(manualPath))
            {
                candidates.Add(Path.GetFullPath(manualPath));
            }
        }

        // 1. 扫描已知特定与常见路径
        var defaultCandidates = new[]
        {
            @"D:\mystream\Sekiro Shadows Die Twice\Sekiro",
            @"C:\Program Files (x86)\Steam\steamapps\common\Sekiro",
            @"C:\Program Files\Steam\steamapps\common\Sekiro",
            @"D:\SteamLibrary\steamapps\common\Sekiro",
            @"E:\SteamLibrary\steamapps\common\Sekiro",
            @"F:\SteamLibrary\steamapps\common\Sekiro",
            @"D:\Steam\steamapps\common\Sekiro",
            @"E:\Steam\steamapps\common\Sekiro",
            @"F:\Steam\steamapps\common\Sekiro",
            @"D:\Games\Sekiro",
            @"E:\Games\Sekiro",
            @"D:\Game\Sekiro",
            @"E:\Game\Sekiro"
        };

        foreach (var path in defaultCandidates)
        {
            if (IsValidSekiroDirectory(path))
            {
                candidates.Add(Path.GetFullPath(path));
            }
        }

        // 2. 扫描 Windows 卸载注册表 (Steam App 814380)
        try
        {
            if (OperatingSystem.IsWindows())
            {
                ScanUninstallRegistry(candidates);
            }
        }
        catch
        {
            // 忽略注册表读取权限限制
        }

        // 3. 扫描 Steam 安装目录与 libraryfolders.vdf
        try
        {
            if (OperatingSystem.IsWindows())
            {
                ScanSteamLibraries(candidates);
            }
        }
        catch
        {
            // 忽略读取异常
        }

        return candidates.ToList();
    }

    public static bool IsValidSekiroDirectory(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return false;
        var exePath = Path.Combine(path, "sekiro.exe");
        return File.Exists(exePath);
    }

    private static void ScanUninstallRegistry(HashSet<string> candidates)
    {
        var registryPaths = new[]
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App " + SekiroAppId,
            @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App " + SekiroAppId
        };

        foreach (var regPath in registryPaths)
        {
            using var key = Registry.LocalMachine.OpenSubKey(regPath) ?? Registry.CurrentUser.OpenSubKey(regPath);
            if (key != null)
            {
                var installLocation = key.GetValue("InstallLocation") as string;
                if (!string.IsNullOrWhiteSpace(installLocation) && IsValidSekiroDirectory(installLocation))
                {
                    candidates.Add(Path.GetFullPath(installLocation));
                }
            }
        }
    }

    private static void ScanSteamLibraries(HashSet<string> candidates)
    {
        string? steamPath = null;

        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
        {
            steamPath = key?.GetValue("SteamPath") as string;
        }

        if (string.IsNullOrWhiteSpace(steamPath))
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Valve\Steam")
                            ?? Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Valve\Steam");
            steamPath = key?.GetValue("InstallPath") as string;
        }

        if (string.IsNullOrWhiteSpace(steamPath) || !Directory.Exists(steamPath)) return;

        var vdfPath = Path.Combine(steamPath, "steamapps", "libraryfolders.vdf");
        if (!File.Exists(vdfPath)) return;

        var vdfContent = File.ReadAllText(vdfPath);
        var matches = Regex.Matches(vdfContent, @"""path""\s+""([^""]+)""", RegexOptions.IgnoreCase);

        foreach (Match match in matches)
        {
            if (match.Groups.Count > 1)
            {
                var rawPath = match.Groups[1].Value.Replace(@"\\", @"\");
                var sekiroPath = Path.Combine(rawPath, "steamapps", "common", "Sekiro");
                if (IsValidSekiroDirectory(sekiroPath))
                {
                    candidates.Add(Path.GetFullPath(sekiroPath));
                }
            }
        }
    }
}

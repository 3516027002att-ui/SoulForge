using System.Text.Json;

namespace SoulForge.Doctor;

public static class SoulForgeConfigProvisioner
{
    public static List<string> GetCandidateRecentPathsFiles()
    {
        var paths = new List<string>();

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (!string.IsNullOrWhiteSpace(appData))
        {
            paths.Add(Path.Combine(appData, "SoulForge", "recent-paths.json"));
            paths.Add(Path.Combine(appData, "soulforge", "recent-paths.json"));
        }

        // 本地仓库开发路径
        var currentDir = AppDomain.CurrentDomain.BaseDirectory;
        paths.Add(Path.Combine(currentDir, "recent-paths.json"));

        return paths;
    }

    public static bool UpdateRecentPaths(string sekiroDir, string modsDir)
    {
        var targets = GetCandidateRecentPathsFiles();
        var anySuccess = false;

        var data = new Dictionary<string, string>
        {
            ["base"] = Path.GetFullPath(sekiroDir),
            ["overlay"] = Path.GetFullPath(modsDir)
        };

        var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true });

        foreach (var target in targets)
        {
            try
            {
                var dir = Path.GetDirectoryName(target);
                if (!string.IsNullOrWhiteSpace(dir))
                {
                    Directory.CreateDirectory(dir);
                    File.WriteAllText(target, json);
                    anySuccess = true;
                }
            }
            catch
            {
                // 忽略个别无法写入的路径
            }
        }

        return anySuccess;
    }
}

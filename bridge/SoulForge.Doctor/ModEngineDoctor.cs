using System.Text.Json;

namespace SoulForge.Doctor;

public static class ModEngineDoctor
{
    public static readonly string[] StandardSubFolders = new[]
    {
        "action",
        "chr",
        "event",
        "map",
        "menu",
        "msg",
        "obj",
        "param",
        "script",
        "sfx"
    };

    public static DoctorItem Inspect(string? sekiroDir, string? modsDir)
    {
        var item = new DoctorItem
        {
            Key = "mod_engine_workspace",
            Title = "Mod 加载环境与 mods 工作区",
            Fixable = true,
            FixDescription = "一键初始化规范的只狼 Mod 工作区结构与 project.json"
        };

        if (string.IsNullOrWhiteSpace(sekiroDir) || !Directory.Exists(sekiroDir))
        {
            item.Status = DoctorStatus.Warn;
            item.Message = "未指定有效的只狼游戏目录，无法检查 Mod 工作区。";
            return item;
        }

        var dinput8Exists = File.Exists(Path.Combine(sekiroDir, "dinput8.dll"));
        var iniExists = File.Exists(Path.Combine(sekiroDir, "modengine.ini"));

        var effectiveModsDir = !string.IsNullOrWhiteSpace(modsDir)
            ? modsDir
            : Path.Combine(sekiroDir, "mods");

        var modsDirExists = Directory.Exists(effectiveModsDir);
        var projectJsonExists = modsDirExists && File.Exists(Path.Combine(effectiveModsDir, "project.json"));

        var details = new
        {
            sekiroDir,
            effectiveModsDir,
            dinput8Exists,
            iniExists,
            modsDirExists,
            projectJsonExists
        };
        item.Details = details;

        if (modsDirExists && projectJsonExists && dinput8Exists)
        {
            item.Status = DoctorStatus.Pass;
            item.Message = $"ModEngine 与工作区就绪 ({effectiveModsDir})";
        }
        else if (modsDirExists && projectJsonExists)
        {
            item.Status = DoctorStatus.Pass;
            item.Message = $"工作区已就绪 ({effectiveModsDir})；游戏目录尚未安装 ModEngine dinput8.dll (可选一键配置)";
        }
        else if (modsDirExists)
        {
            item.Status = DoctorStatus.Warn;
            item.Message = $"发现 mods 目录，但缺少 project.json 关联配置；建议一键补全。";
        }
        else
        {
            item.Status = DoctorStatus.Warn;
            item.Message = "尚未创建 mods 工作区目录；可点击一键创建标准 Mod 工作区脚手架。";
        }

        return item;
    }

    public static bool ScaffoldModWorkspace(string sekiroDir, string targetModsDir)
    {
        if (string.IsNullOrWhiteSpace(sekiroDir) || string.IsNullOrWhiteSpace(targetModsDir)) return false;

        Directory.CreateDirectory(targetModsDir);

        // 创建子目录
        foreach (var sub in StandardSubFolders)
        {
            Directory.CreateDirectory(Path.Combine(targetModsDir, sub));
        }

        // 写入 project.json
        var projectJsonPath = Path.Combine(targetModsDir, "project.json");
        if (!File.Exists(projectJsonPath))
        {
            var projectData = new Dictionary<string, object>
            {
                ["GameRoot"] = Path.GetFullPath(sekiroDir),
                ["GameType"] = "Sekiro",
                ["CreatedBy"] = "SoulForge Doctor",
                ["CreatedAt"] = DateTime.UtcNow.ToString("o"),
                ["Version"] = "1.0"
            };

            var jsonText = JsonSerializer.Serialize(projectData, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(projectJsonPath, jsonText);
        }

        // 写入默认 modengine.ini（如果只狼目录下没有）
        var modEngineIniPath = Path.Combine(sekiroDir, "modengine.ini");
        if (!File.Exists(modEngineIniPath))
        {
            var iniContent = @"; ========================================================
; ModEngine 配置文件 (由 SoulForge Doctor 自动生成)
; ========================================================
[files]
loadLooseParams=1
loadUXMFiles=0
useModOverrideDirectory=1
modOverrideDirectory=""\mods""

[debug]
showWarningPrompt=0
";
            try
            {
                File.WriteAllText(modEngineIniPath, iniContent);
            }
            catch
            {
                // 忽略权限问题
            }
        }

        return true;
    }
}

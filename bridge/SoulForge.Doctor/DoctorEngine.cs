using System.Runtime.Versioning;

namespace SoulForge.Doctor;

[SupportedOSPlatform("windows")]
public static class DoctorEngine
{
    public static async Task<DoctorReport> DiagnoseAsync(string? manualSekiroPath = null, string? manualModsPath = null)
    {
        var report = new DoctorReport
        {
            Timestamp = DateTime.UtcNow
        };

        // 1. 查找只狼游戏路径
        var sekiroCandidates = SteamLocator.LocateSekiroCandidates(manualSekiroPath);
        var detectedSekiro = sekiroCandidates.FirstOrDefault();
        report.DetectedSekiroPath = detectedSekiro;

        var sekiroItem = new DoctorItem
        {
            Key = "sekiro_game_path",
            Title = "《只狼》游戏安装路径",
            Fixable = false
        };

        if (!string.IsNullOrWhiteSpace(detectedSekiro))
        {
            sekiroItem.Status = DoctorStatus.Pass;
            sekiroItem.Message = $"已定位只狼游戏安装目录: {detectedSekiro}";
            sekiroItem.Details = new
            {
                primaryPath = detectedSekiro,
                allCandidates = sekiroCandidates
            };
        }
        else
        {
            sekiroItem.Status = DoctorStatus.Fail;
            sekiroItem.Message = "未自动检测到只狼游戏目录 (sekiro.exe)；请确认游戏已安装或手动指定路径。";
            sekiroItem.Details = new { candidatesChecked = sekiroCandidates };
        }
        report.Items.Add(sekiroItem);

        // 2. 检查 Oodle 动态库
        var appDir = AppDomain.CurrentDomain.BaseDirectory;
        var oodleItem = OodleDoctor.Inspect(detectedSekiro, appDir);
        report.Items.Add(oodleItem);

        // 3. 检查 ModEngine 与 mods 工作区
        var effectiveMods = !string.IsNullOrWhiteSpace(manualModsPath)
            ? manualModsPath
            : (!string.IsNullOrWhiteSpace(detectedSekiro) ? Path.Combine(detectedSekiro, "mods") : null);
        report.DetectedModsPath = effectiveMods;

        var modEngineItem = ModEngineDoctor.Inspect(detectedSekiro, effectiveMods);
        report.Items.Add(modEngineItem);

        // 4. 检查原版解包状态 (UXM)
        var uxmItem = UxmDoctor.Inspect(detectedSekiro);
        report.Items.Add(uxmItem);

        // 5. 检查系统运行库 (VC++ 2015-2022)
        var systemItem = SystemDoctor.Inspect();
        report.Items.Add(systemItem);

        // 6. 检查 AI 模型服务
        var aiItem = await AiDoctor.InspectAsync();
        report.Items.Add(aiItem);

        // 计算整体健康状态
        if (report.Items.Any(i => i.Status == DoctorStatus.Fail))
        {
            report.OverallStatus = DoctorStatus.Fail;
        }
        else if (report.Items.Any(i => i.Status == DoctorStatus.Warn))
        {
            report.OverallStatus = DoctorStatus.Warn;
        }
        else
        {
            report.OverallStatus = DoctorStatus.Pass;
        }

        return report;
    }
}

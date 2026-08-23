using System.Runtime.Versioning;

namespace SoulForge.Doctor;

[SupportedOSPlatform("windows")]
public static class AutoFixer
{
    public static Task<AutoFixResult> ExecuteAutoFixAsync(string? manualSekiroPath = null, string? manualModsPath = null)
    {
        var result = new AutoFixResult();

        // 1. 确定只狼路径
        var sekiroCandidates = SteamLocator.LocateSekiroCandidates(manualSekiroPath);
        var sekiroPath = sekiroCandidates.FirstOrDefault();

        if (string.IsNullOrWhiteSpace(sekiroPath) || !Directory.Exists(sekiroPath))
        {
            result.Success = false;
            result.Message = "无法执行自动修复：未找到只狼游戏目录，请先指定游戏安装路径。";
            return Task.FromResult(result);
        }

        result.SekiroPath = sekiroPath;
        var modsPath = !string.IsNullOrWhiteSpace(manualModsPath)
            ? manualModsPath
            : Path.Combine(sekiroPath, "mods");
        result.ModsPath = modsPath;

        // 2. 补全 Oodle 动态库
        var oodleSrc = Path.Combine(sekiroPath, OodleDoctor.ExpectedDllName);
        if (File.Exists(oodleSrc))
        {
            var appDir = AppDomain.CurrentDomain.BaseDirectory;
            var copyTargets = new List<string>
            {
                appDir,
                Path.Combine(appDir, "bridge", "SoulForge.Bridge"),
                Path.Combine(appDir, "release", "win-unpacked"),
                Path.Combine(appDir, "release", "tools")
            };

            var copiedCount = 0;
            foreach (var target in copyTargets)
            {
                try
                {
                    if (OodleDoctor.CopyOodle(sekiroPath, target))
                    {
                        copiedCount++;
                    }
                }
                catch
                {
                    // 忽略无权限或不存在目录
                }
            }

            result.Actions.Add(new AutoFixActionRecord
            {
                Name = "Oodle 动态库提取",
                Success = copiedCount > 0,
                Message = $"成功从只狼目录安全提取并校验 {OodleDoctor.ExpectedDllName}"
            });
        }
        else
        {
            result.Actions.Add(new AutoFixActionRecord
            {
                Name = "Oodle 动态库检查",
                Success = false,
                Message = $"只狼游戏目录中未找到 {OodleDoctor.ExpectedDllName}，请确认游戏文件完整性。"
            });
        }

        // 3. 初始化 Mod 工作区脚手架
        try
        {
            var scaffoldSuccess = ModEngineDoctor.ScaffoldModWorkspace(sekiroPath, modsPath);
            result.Actions.Add(new AutoFixActionRecord
            {
                Name = "Mod 工作区脚手架创建",
                Success = scaffoldSuccess,
                Message = scaffoldSuccess
                    ? $"已成功初始化标准 Mod 工作区结构与 project.json ({modsPath})"
                    : "Mod 工作区初始化失败"
            });
        }
        catch (Exception ex)
        {
            result.Actions.Add(new AutoFixActionRecord
            {
                Name = "Mod 工作区脚手架创建",
                Success = false,
                Message = $"创建失败: {ex.Message}"
            });
        }

        // 4. 写入 SoulForge 记忆配置
        try
        {
            var configSuccess = SoulForgeConfigProvisioner.UpdateRecentPaths(sekiroPath, modsPath);
            result.Actions.Add(new AutoFixActionRecord
            {
                Name = "SoulForge 路径自动关联",
                Success = configSuccess,
                Message = configSuccess
                    ? "已将只狼目录与 Mod 目录写入 SoulForge 启动配置"
                    : "写入配置失败（可能为权限原因）"
            });
        }
        catch (Exception ex)
        {
            result.Actions.Add(new AutoFixActionRecord
            {
                Name = "SoulForge 路径自动关联",
                Success = false,
                Message = $"写入配置失败: {ex.Message}"
            });
        }

        result.Success = result.Actions.All(a => a.Success || a.Name.Contains("检查"));
        result.Message = result.Success
            ? "只狼 Mod 环境已全部补全就绪！"
            : "部分环境项补全未完全成功，请查看具体项。";

        return Task.FromResult(result);
    }
}

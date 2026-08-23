using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;

namespace SoulForge.Doctor;

[SupportedOSPlatform("windows")]
internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        var jsonMode = false;
        var checkOnly = false;
        var fixOnly = false;
        var noLaunch = false;
        string? manualSekiro = null;
        string? manualMods = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg.Equals("--json", StringComparison.OrdinalIgnoreCase))
            {
                jsonMode = true;
            }
            else if (arg.Equals("--check", StringComparison.OrdinalIgnoreCase) || arg.Equals("--doctor", StringComparison.OrdinalIgnoreCase))
            {
                checkOnly = true;
            }
            else if (arg.Equals("--fix", StringComparison.OrdinalIgnoreCase) || arg.Equals("-f", StringComparison.OrdinalIgnoreCase))
            {
                fixOnly = true;
            }
            else if (arg.Equals("--no-launch", StringComparison.OrdinalIgnoreCase))
            {
                noLaunch = true;
            }
            else if (arg.Equals("--game-dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                manualSekiro = args[++i];
            }
            else if (arg.Equals("--mods-dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                manualMods = args[++i];
            }
        }

        // JSON 输出模式 (供外部调用)
        if (jsonMode)
        {
            if (fixOnly)
            {
                var fixResult = await AutoFixer.ExecuteAutoFixAsync(manualSekiro, manualMods);
                Console.WriteLine(JsonSerializer.Serialize(fixResult, new JsonSerializerOptions { WriteIndented = true }));
                return fixResult.Success ? 0 : 1;
            }
            else
            {
                var jsonReport = await DoctorEngine.DiagnoseAsync(manualSekiro, manualMods);
                Console.WriteLine(JsonSerializer.Serialize(jsonReport, new JsonSerializerOptions { WriteIndented = true }));
                return jsonReport.OverallStatus == DoctorStatus.Fail ? 1 : 0;
            }
        }

        PrintBanner();

        // 1. 初次诊断
        var report = await RunAndPrintDiagnosisAsync(manualSekiro, manualMods);

        // 如果未定位到只狼目录，提示用户手动输入
        while (report.OverallStatus == DoctorStatus.Fail && string.IsNullOrWhiteSpace(report.DetectedSekiroPath))
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("\n[?] 未自动找到只狼游戏目录，请输入只狼游戏安装路径（包含 sekiro.exe 的文件夹）:");
            Console.ResetColor();
            Console.Write("> ");
            var inputPath = Console.ReadLine()?.Trim('"', ' ', '\'');
            if (string.IsNullOrWhiteSpace(inputPath))
            {
                break;
            }

            if (SteamLocator.IsValidSekiroDirectory(inputPath))
            {
                manualSekiro = inputPath;
                report = await RunAndPrintDiagnosisAsync(manualSekiro, manualMods);
                break;
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("该目录下未找到 sekiro.exe，请重新输入或确认路径。");
                Console.ResetColor();
            }
        }

        // 2. 如果存在待补全项且非纯检查模式，自动执行补全
        if (!checkOnly && (report.OverallStatus != DoctorStatus.Pass || fixOnly))
        {
            await RunAndPrintFixAsync(manualSekiro, manualMods);
            report = await DoctorEngine.DiagnoseAsync(manualSekiro, manualMods);
        }

        // 3. 默认直接拉起主程序 (双击即用启动器模式)
        if (!checkOnly && !noLaunch && report.OverallStatus == DoctorStatus.Pass)
        {
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("🚀 环境已全部准备就绪，正在为您启动 SoulForge...");
            Console.ResetColor();
            await Task.Delay(1000);

            var launched = LaunchSoulForge();
            if (launched)
            {
                return 0;
            }
        }

        // 4. 循环交互菜单 (若没有自动启动或用户指定了 --check)
        while (true)
        {
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("操作选项:");
            Console.ResetColor();
            Console.WriteLine("  [1] 🚀 一键自动补全环境并启动 SoulForge");
            Console.WriteLine("  [2] 🔍 重新进行环境体检");
            Console.WriteLine("  [3] 🎮 直接启动 SoulForge 编辑器");
            Console.WriteLine("  [4] ❌ 退出");
            Console.Write("\n请输入数字 [1-4]: ");

            var input = Console.ReadLine()?.Trim();
            if (input == "1")
            {
                await RunAndPrintFixAsync(manualSekiro, manualMods);
                LaunchSoulForge();
                break;
            }
            else if (input == "2")
            {
                report = await RunAndPrintDiagnosisAsync(manualSekiro, manualMods);
            }
            else if (input == "3")
            {
                LaunchSoulForge();
                break;
            }
            else if (input == "4" || input?.Equals("q", StringComparison.OrdinalIgnoreCase) == true)
            {
                break;
            }
        }

        return 0;
    }

    private static void PrintBanner()
    {
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine(@"
╔══════════════════════════════════════════════════════════════════════╗
║              SoulForge 只狼 Mod 环境自愈与启动助手                  ║
║                  SoulForge Launcher & Doctor                         ║
╚══════════════════════════════════════════════════════════════════════╝");
        Console.ResetColor();
        Console.WriteLine("正在自动检测《只狼》路径、Oodle 动态库与 ModEngine 环境...\n");
    }

    private static async Task<DoctorReport> RunAndPrintDiagnosisAsync(string? manualSekiro, string? manualMods)
    {
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("──────────── [ 环境诊断报告 ] ────────────");
        Console.ResetColor();

        var report = await DoctorEngine.DiagnoseAsync(manualSekiro, manualMods);

        foreach (var item in report.Items)
        {
            switch (item.Status)
            {
                case DoctorStatus.Pass:
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.Write("  [√] 正常 ");
                    break;
                case DoctorStatus.Warn:
                    Console.ForegroundColor = ConsoleColor.Yellow;
                    Console.Write("  [!] 提示 ");
                    break;
                case DoctorStatus.Fail:
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.Write("  [X] 缺失 ");
                    break;
            }

            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine(item.Title);
            Console.ResetColor();

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine($"      └─ {item.Message}");
            Console.ResetColor();
        }

        return report;
    }

    private static async Task RunAndPrintFixAsync(string? manualSekiro, string? manualMods)
    {
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("正在执行一键自动环境补全...");
        Console.ResetColor();

        var result = await AutoFixer.ExecuteAutoFixAsync(manualSekiro, manualMods);

        foreach (var action in result.Actions)
        {
            if (action.Success)
            {
                Console.ForegroundColor = ConsoleColor.Green;
                Console.Write("  [成功] ");
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.Write("  [失败] ");
            }

            Console.ForegroundColor = ConsoleColor.White;
            Console.Write($"{action.Name}: ");
            Console.ResetColor();
            Console.WriteLine(action.Message);
        }

        Console.WriteLine();
        if (result.Success)
        {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"✅ {result.Message}");
        }
        else
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"⚠️ {result.Message}");
        }
        Console.ResetColor();
    }

    private static bool LaunchSoulForge()
    {
        var appDir = AppDomain.CurrentDomain.BaseDirectory;

        // 1. 优先使用本地 Electron 运行时直接拉起最新构建产物（秒开，体验最好）
        var electronExe = Path.Combine(appDir, "node_modules", "electron", "dist", "electron.exe");
        var mainEntry = Path.Combine(appDir, "apps", "desktop", "out", "main", "index.js");
        if (File.Exists(electronExe) && File.Exists(mainEntry))
        {
            try
            {
                var startInfo = new ProcessStartInfo(electronExe, $"\"{mainEntry}\"")
                {
                    WorkingDirectory = appDir,
                    UseShellExecute = true
                };
                Process.Start(startInfo);
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine($"已成功启动 SoulForge 桌面端 (基于本地构建产物)");
                Console.ResetColor();
                return true;
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine($"直接拉起 Electron 失败: {ex.Message}，尝试备选启动方式...");
                Console.ResetColor();
            }
        }

        // 2. 检查已打包的发行版 win-unpacked
        var unpackedExe = Path.Combine(appDir, "apps", "desktop", "release", "win-unpacked", "SoulForge.exe");
        if (File.Exists(unpackedExe))
        {
            try
            {
                Process.Start(new ProcessStartInfo(unpackedExe) { UseShellExecute = true });
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine($"已成功启动 SoulForge ({unpackedExe})");
                Console.ResetColor();
                return true;
            }
            catch { }
        }

        // 3. 源码开发态尝试 npm run dev
        var pkgJson = Path.Combine(appDir, "package.json");
        if (File.Exists(pkgJson))
        {
            try
            {
                Console.ForegroundColor = ConsoleColor.Cyan;
                Console.WriteLine("检测到当前为源码仓库环境，正在拉起开发服务 (npm run dev)...");
                Console.ResetColor();
                var startInfo = new ProcessStartInfo("cmd.exe", "/c npm run dev")
                {
                    WorkingDirectory = appDir,
                    UseShellExecute = true
                };
                Process.Start(startInfo);
                return true;
            }
            catch
            {
                // 忽略
            }
        }

        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("未找到可用的 SoulForge 启动环境，请在终端执行 npm run dev 或 npm run build。");
        Console.ResetColor();
        return false;
    }
}

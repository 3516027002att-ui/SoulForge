// SoulForge 本机开发启动器。
// Build:
//   "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /out:SoulForge.exe scripts\launch-soulforge.cs
//
// 双击仓库根目录的 SoulForge.exe 会在后台跑 `npm run dev`，只打开应用窗口。
// 不再弹出 cmd：/target:winexe 让启动器本身无控制台，子进程走 node + npm-cli.js
// 且 CreateNoWindow=true。需要看编译输出时设 SOULFORGE_DEV_CONSOLE=1。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

internal static class SoulForgeLauncher
{
    private const uint MbOk = 0x00000000;
    private const uint MbIconError = 0x00000010;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    [STAThread]
    private static int Main()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string workDir = exeDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (workDir.Length == 0) workDir = exeDir;

        bool showConsole = string.Equals(
            Environment.GetEnvironmentVariable("SOULFORGE_DEV_CONSOLE"),
            "1",
            StringComparison.Ordinal);

        try
        {
            ProcessStartInfo psi = showConsole
                ? VisibleNpmDev(workDir)
                : HiddenNpmDev(workDir);
            Process process = Process.Start(psi);
            if (process == null)
            {
                ShowError("无法启动开发进程。");
                return 1;
            }

            if (!showConsole && process.WaitForExit(1500) && process.ExitCode != 0)
            {
                ShowError("npm run dev 立即退出，退出码 " + process.ExitCode + "。确认已安装 Node.js，并在仓库根目录执行过 npm install。");
                return process.ExitCode;
            }

            return 0;
        }
        catch (Exception ex)
        {
            ShowError("无法启动 SoulForge：\n" + ex.Message + "\n\n请确认已安装 Node.js，并且 npm 在 PATH 中。");
            return 1;
        }
    }

    private static ProcessStartInfo VisibleNpmDev(string workDir)
    {
        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
        psi.Arguments = "/k npm run dev";
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;
        return psi;
    }

    private static ProcessStartInfo HiddenNpmDev(string workDir)
    {
        string nodePath = FindOnPath("node.exe");
        if (string.IsNullOrEmpty(nodePath))
        {
            throw new InvalidOperationException("PATH 里找不到 node.exe。");
        }

        string npmCli = Path.Combine(
            Path.GetDirectoryName(nodePath) ?? "",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js");

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        if (File.Exists(npmCli))
        {
            psi.FileName = nodePath;
            psi.Arguments = Quote(npmCli) + " run dev";
            return psi;
        }

        string npmCmd = FindOnPath("npm.cmd") ?? FindOnPath("npm.exe");
        if (string.IsNullOrEmpty(npmCmd))
        {
            throw new InvalidOperationException("找不到 npm-cli.js 或 npm.cmd。");
        }

        psi.FileName = npmCmd;
        psi.Arguments = "run dev";
        return psi;
    }

    private static string FindOnPath(string fileName)
    {
        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            string candidate = Path.Combine(dir.Trim().Trim('"'), fileName);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ShowError(string message)
    {
        MessageBoxW(IntPtr.Zero, message, "SoulForge", MbOk | MbIconError);
    }
}

// SoulForge 本机开发启动器。
// Build:
//   "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /out:SoulForge.exe scripts\launch-soulforge.cs
//
// 双击仓库根目录的 SoulForge.exe 会在后台跑 `npm run dev`，只打开应用窗口。
// 已经在跑时再次点击：唤起已有窗口，不再起第二套 vite/electron（端口占用会
// 被误报成「没装 Node」）。
// 不再弹出 cmd：/target:winexe 让启动器本身无控制台，子进程走 node + npm-cli.js
// 且 CreateNoWindow=true。需要看编译输出时设 SOULFORGE_DEV_CONSOLE=1。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class SoulForgeLauncher
{
    private const uint MbOk = 0x00000000;
    private const uint MbIconError = 0x00000010;
    private const int SwRestore = 9;
    private const string LauncherMutexName = "Local\\SoulForge.dev.launcher";

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [STAThread]
    private static int Main()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string workDir = exeDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (workDir.Length == 0) workDir = exeDir;

        bool createdNew;
        using (Mutex mutex = new Mutex(true, LauncherMutexName, out createdNew))
        {
            if (!createdNew)
            {
                WaitAndFocusExisting(workDir);
                return 0;
            }

            if (FocusExistingSoulForge(workDir))
            {
                return 0;
            }

            int built = TryLaunchBuiltDesktop(workDir);
            if (built >= 0) return built;

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

                if (showConsole)
                {
                    return 0;
                }

                string logPath = Path.Combine(workDir, ".tmp-soulforge-dev.log");
                return RunHiddenDev(process, workDir, logPath);
            }
            catch (Exception ex)
            {
                ShowError("无法启动 SoulForge：\n" + ex.Message + "\n\n请确认已安装 Node.js，并且 npm 在 PATH 中。");
                return 1;
            }
        }
    }

    private static void WaitAndFocusExisting(string workDir)
    {
        for (int i = 0; i < 25; i++)
        {
            if (FocusExistingSoulForge(workDir)) return;
            Thread.Sleep(200);
        }
    }

    /// <summary>
    /// 仓库已有 desktop 构建产物时直接拉起，不经过 Doctor 诊断页、也不走 npm run dev。
    /// 返回 -1 表示没有可用产物，交给 npm run dev；>=0 为进程退出码。
    /// </summary>
    private static int TryLaunchBuiltDesktop(string workDir)
    {
        string electronExe = Path.GetFullPath(Path.Combine(workDir, "node_modules", "electron", "dist", "electron.exe"));
        string mainEntry = Path.GetFullPath(Path.Combine(workDir, "apps", "desktop", "out", "main", "index.js"));
        if (!File.Exists(electronExe) || !File.Exists(mainEntry)) return -1;

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = electronExe;
        psi.Arguments = Quote(mainEntry);
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;
        Process process;
        try
        {
            process = Process.Start(psi);
        }
        catch (Exception ex)
        {
            ShowError("无法启动 SoulForge 桌面端：\n" + ex.Message);
            return 1;
        }
        if (process == null)
        {
            ShowError("无法启动 SoulForge 桌面端。");
            return 1;
        }

        DateTime deadline = DateTime.UtcNow.AddMinutes(2);
        while (DateTime.UtcNow < deadline)
        {
            if (FocusExistingSoulForge(workDir)) return 0;
            if (process.HasExited)
            {
                if (process.ExitCode == 0) return 0;
                ShowError("SoulForge 桌面进程已退出，退出码 " + process.ExitCode + "。");
                return process.ExitCode;
            }
            Thread.Sleep(200);
        }
        ShowError("SoulForge 窗口在 2 分钟内未出现。\n若确认启动失败，请先结束残留进程后重试。");
        return 1;
    }

    private static bool FocusExistingSoulForge(string workDir)
    {
        string electronExe = Path.GetFullPath(Path.Combine(workDir, "node_modules", "electron", "dist", "electron.exe"));
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (found != IntPtr.Zero) return false;
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return true;
            try
            {
                Process process = Process.GetProcessById((int)pid);
                string path = null;
                try { path = process.MainModule != null ? process.MainModule.FileName : null; }
                catch { path = null; }
                if (string.IsNullOrEmpty(path)) return true;
                if (!PathsEqual(path, electronExe)) return true;
                StringBuilder title = new StringBuilder(512);
                GetWindowText(hWnd, title, title.Capacity);
                string text = title.ToString();
                if (text.IndexOf("SoulForge", StringComparison.OrdinalIgnoreCase) < 0
                    && text.IndexOf("electron-vite", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    return true;
                }
                found = hWnd;
                return false;
            }
            catch
            {
                return true;
            }
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return HasRepoElectron(electronExe);

        if (IsIconic(found)) ShowWindow(found, SwRestore);
        SetForegroundWindow(found);
        return true;
    }

    private static bool HasRepoElectron(string electronExe)
    {
        Process[] processes = Process.GetProcessesByName("electron");
        for (int i = 0; i < processes.Length; i++)
        {
            try
            {
                string path = processes[i].MainModule != null ? processes[i].MainModule.FileName : null;
                if (!string.IsNullOrEmpty(path) && PathsEqual(path, electronExe))
                {
                    return true;
                }
            }
            catch
            {
            }
            finally
            {
                processes[i].Dispose();
            }
        }
        return false;
    }

    private static bool PathsEqual(string left, string right)
    {
        return string.Equals(
            Path.GetFullPath(left),
            Path.GetFullPath(right),
            StringComparison.OrdinalIgnoreCase);
    }

    private static int RunHiddenDev(Process process, string workDir, string logPath)
    {
        object gate = new object();
        StringBuilder output = new StringBuilder();
        DataReceivedEventHandler append = delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (gate)
            {
                if (output.Length > 0) output.AppendLine();
                output.Append(e.Data);
            }
            try
            {
                File.AppendAllText(logPath, e.Data + Environment.NewLine);
            }
            catch
            {
            }
        };
        process.OutputDataReceived += append;
        process.ErrorDataReceived += append;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // First 2.5s: if dev already exited (e.g. node missing) surface it at once.
        if (!process.WaitForExit(2500) && FocusExistingSoulForge(workDir))
        {
            return 0;
        }

        if (process.HasExited)
        {
            string captured;
            lock (gate) { captured = output.ToString(); }
            if (process.ExitCode == 0) return 0;
            if (LooksLikeAlreadyRunning(captured) && FocusExistingSoulForge(workDir)) return 0;
            ShowError(FormatStartFailure(process.ExitCode, captured));
            return process.ExitCode;
        }

        // dev is still alive (usually rebuilding the native binding or starting
        // vite). Keep watching for the window instead of exiting silently, so a
        // broken start surfaces a real error instead of looking like a no-op.
        DateTime deadline = DateTime.UtcNow.AddMinutes(10);
        while (DateTime.UtcNow < deadline)
        {
            if (FocusExistingSoulForge(workDir)) return 0;
            if (process.HasExited)
            {
                string captured;
                lock (gate) { captured = output.ToString(); }
                if (process.ExitCode == 0) return 0;
                if (LooksLikeAlreadyRunning(captured) && FocusExistingSoulForge(workDir)) return 0;
                ShowError(FormatStartFailure(process.ExitCode, captured));
                return process.ExitCode;
            }
            Thread.Sleep(500);
        }
        ShowError("SoulForge 窗口在 10 分钟内未出现，dev 进程仍在运行。\n"
            + "日志：" + logPath + "\n\n若确认启动失败，请先结束残留进程后重试。");
        return 1;
    }

    private static bool LooksLikeAlreadyRunning(string output)
    {
        if (string.IsNullOrEmpty(output)) return false;
        string lower = output.ToLowerInvariant();
        return lower.IndexOf("eaddrinuse") >= 0
            || lower.IndexOf("address already in use") >= 0
            || lower.IndexOf("port 5173 is in use") >= 0
            || lower.IndexOf("already running") >= 0;
    }

    private static string FormatStartFailure(int exitCode, string output)
    {
        string trimmed = string.IsNullOrWhiteSpace(output) ? "" : Tail(output.Trim(), 1200);
        if (trimmed.Length == 0)
        {
            return "npm run dev 立即退出，退出码 " + exitCode
                + "。\n\n若窗口已经打开，关掉这个提示即可，不要再重复点击。"
                + "\n若确实没启动：确认已安装 Node.js，并在仓库根目录执行过 npm install。";
        }
        return "npm run dev 立即退出，退出码 " + exitCode + "。\n\n" + trimmed;
    }

    private static string Tail(string text, int maxChars)
    {
        if (text.Length <= maxChars) return text;
        return text.Substring(text.Length - maxChars);
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
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;

        string nodeDir = Path.GetDirectoryName(nodePath);
        if (!string.IsNullOrEmpty(nodeDir))
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            psi.EnvironmentVariables["PATH"] = nodeDir + Path.PathSeparator + path;
        }

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

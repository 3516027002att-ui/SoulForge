// SoulForge dev launcher.
// Build: "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /optimize+ /out:SoulForge.exe scripts\launch-soulforge.cs
// Behavior: double-clicking SoulForge.exe in the repo root opens a cmd window
// that runs `npm run dev` (electron-vite dev) in the repo root, then the app window appears.
// Closing the cmd window (or Ctrl+C) stops the dev process.
using System;
using System.Diagnostics;

internal static class SoulForgeLauncher
{
    [STAThread]
    private static int Main()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string workDir = exeDir.TrimEnd('\\');
        if (workDir.Length == 0) workDir = exeDir;

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
            psi.Arguments = "/k npm run dev";
            psi.WorkingDirectory = workDir;
            psi.UseShellExecute = false;
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine("Failed to start SoulForge: " + ex.Message);
            Console.WriteLine("Make sure Node.js is installed and npm is on PATH.");
            Console.WriteLine("Press any key to exit...");
            Console.ReadKey();
            return 1;
        }
    }
}

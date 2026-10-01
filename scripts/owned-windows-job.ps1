$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class SoulForgeOwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessTime, PerJobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string application, string command, string cwd, Action<int> assigned, Action finished) {
    // The guardian is the only holder of this non-inheritable job handle.
    // Breakaway is not allowed. Every driver descendant belongs to this job.
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ProcessInfo process = new ProcessInfo();
    bool resumed = false;
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
      Startup startup = new Startup();
      startup.Size = (uint)Marshal.SizeOf(typeof(Startup)); startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      if (!CreateProcess(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, cwd, ref startup, out process)) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
      assigned((int)process.ProcessId); // Persist proof before any driver code runs.
      if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception();
      resumed = true;
      if (WaitForSingleObject(process.Process, UInt32.MaxValue) != 0) throw new Win32Exception();
      uint code;
      if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
      if (!TerminateJobObject(job, 1)) throw new Win32Exception();
      DateTime deadline = DateTime.UtcNow.AddSeconds(5);
      for (;;) {
        Accounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
        if (accounting.ActiveProcesses == 0) break;
        if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("OWNED_WINDOWS_JOB_TERMINATION_UNCERTAIN");
        Thread.Sleep(10);
      }
      finished();
      return unchecked((int)code);
    } finally {
      if (!resumed && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      CloseHandle(job); // Also kills members if the guardian is interrupted.
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
    }
  }
}
'@

$application = if ([IO.Path]::IsPathRooted($payload.command)) { $payload.command } else { (Get-Command -Name $payload.command -CommandType Application -ErrorAction Stop).Source }
$utf8 = New-Object Text.UTF8Encoding($false)
$proofs = @{}
$assigned = [Action[int]] {
  param($driver)
  foreach ($ticket in $payload.tickets) {
    $proof = [ordered]@{ schema = 'soulforge.windows-job.v1'; id = $payload.id; token = $ticket.token; observer = $payload.observer; supervisorPid = $payload.supervisorPid; guardianPid = $PID; driverPid = $driver; state = 'assigned'; killOnClose = $true }
    $path = [IO.Path]::Combine($ticket.root, ".soulforge-windows-job.$($payload.id).json")
    $bytes = $utf8.GetBytes(($proof | ConvertTo-Json -Compress))
    $file = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    $proofs[$path] = $proof
  }
}
$finished = [Action] {
  foreach ($path in $proofs.Keys) {
    $proof = $proofs[$path]; $proof.state = 'finished'
    $pending = "$path.$([Guid]::NewGuid()).next"
    [IO.File]::WriteAllText($pending, ($proof | ConvertTo-Json -Compress), $utf8)
    # Plain $null binds to an empty string for this .NET string parameter.
    # NullString preserves the required null backup path on Windows PowerShell.
    [IO.File]::Replace($pending, $path, [System.Management.Automation.Language.NullString]::Value)
  }
}
try {
  exit ([SoulForgeOwnedJob]::Run($application, $payload.commandLine, $payload.cwd, $assigned, $finished))
} catch {
  [Console]::Error.WriteLine("OWNED_WINDOWS_JOB_FAILED: " + $_.Exception.Message)
  exit 1
}

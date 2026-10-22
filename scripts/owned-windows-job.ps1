# Progress records reach a redirected stderr as CLIXML (for example "preparing modules for first use" with a fresh
# module analysis cache). An outer Windows PowerShell reading that stderr fails to parse it and stops draining the
# pipe, which freezes the whole owned run. The guardian never reports progress.
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
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
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup Info;
    public IntPtr AttributeList;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
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
    IntPtr attributes = IntPtr.Zero, jobSlot = IntPtr.Zero;
    bool resumed = false;
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: the driver is created inside the job.
      // There is no instant (former CreateProcess -> AssignProcessToJobObject)
      // where a guardian death could leave a suspended driver outside it.
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      IntPtr list = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) { Marshal.FreeHGlobal(list); throw new Win32Exception(); }
      attributes = list;
      jobSlot = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobSlot, job);
      if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobSlot, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      StartupEx startup = new StartupEx();
      startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupEx)); startup.Info.Flags = 0x100;
      startup.Info.Input = GetStdHandle(-10); startup.Info.Output = GetStdHandle(-11); startup.Info.Error = GetStdHandle(-12);
      startup.AttributeList = attributes;
      // CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT
      if (!CreateProcess(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000 | 0x00080000, IntPtr.Zero, cwd, ref startup, out process)) throw new Win32Exception();
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
      if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if (jobSlot != IntPtr.Zero) Marshal.FreeHGlobal(jobSlot);
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
    $proof = $proofs[$path]
    $assignedText = $proof | ConvertTo-Json -Compress
    $proof.state = 'finished'
    # Keep only the temporary sibling basename short: owned TEMP roots may already
    # be nested, while the published proof path remains part of owner identity.
    $pending = [IO.Path]::Combine([IO.Path]::GetDirectoryName($path), ".sf-wjob.$([Guid]::NewGuid()).next")
    $bytes = $utf8.GetBytes(($proof | ConvertTo-Json -Compress))
    $file = [IO.File]::Open($pending, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText $assignedText
  }
}
try {
  exit ([SoulForgeOwnedJob]::Run($application, $payload.commandLine, $payload.cwd, $assigned, $finished))
} catch {
  [Console]::Error.WriteLine("OWNED_WINDOWS_JOB_FAILED: " + $_.Exception.Message)
  exit 1
}

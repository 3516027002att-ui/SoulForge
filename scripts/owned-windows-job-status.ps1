# Replace only this guardian's already-created receipt. Never delete the target
# or replay the driver if an observer temporarily prevents atomic publication.
function Publish-SoulForgeOwnedJobProof {
  param(
    [string] $Pending,
    [string] $Path,
    [string] $AssignedText,
    [scriptblock] $Replace = {
      param($source, $target)
      # Plain $null binds to an empty string on Windows PowerShell.
      [IO.File]::Replace($source, $target, [System.Management.Automation.Language.NullString]::Value)
    },
    [scriptblock] $Pause = { param($milliseconds) [Threading.Thread]::Sleep($milliseconds) }
  )
  $finishedText = [IO.File]::ReadAllText($Pending)
  $waits = @(25, 50, 100, 200, 400)
  for ($attempt = 0; ; $attempt++) {
    try {
      # Recheck ownership/content after every wait; a different receipt must not
      # be overwritten by a retry of the previously authorized replacement.
      foreach ($entry in @(@($Path, $AssignedText), @($Pending, $finishedText))) {
        $attributes = [IO.File]::GetAttributes($entry[0])
        if (($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0 -or
            [IO.File]::ReadAllText($entry[0]) -cne $entry[1]) {
          throw [InvalidOperationException]::new('OWNED_WINDOWS_JOB_PROOF_CHANGED')
        }
      }
      & $Replace $Pending $Path
      return
    } catch {
      $failure = $_.Exception
      while ($failure.InnerException) { $failure = $failure.InnerException }
      # Win32 32 (sharing violation) and 1175 (unable to remove replaced) keep
      # both original paths. 1176/1177 can partially move them and MUST NOT retry.
      # https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew
      if ($failure -isnot [IO.IOException] -or $failure.HResult -notin @(-2147024864, -2147023721) -or $attempt -eq $waits.Length) { throw }
      & $Pause $waits[$attempt]
    }
  }
}

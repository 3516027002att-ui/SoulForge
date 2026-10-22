import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './subprocess-control.mjs';

const windows = { skip: process.platform !== 'win32' && 'Windows receipt API unavailable' };
const helper = await readFile(new URL('./owned-windows-job-status.ps1', import.meta.url), 'utf8');
const quote = value => `'${value.replaceAll("'", "''")}'`;

async function statusCase(body) {
  const root = await mkdtemp(join(tmpdir(), 'sf-windows-job-status-'));
  try {
    const source = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
      ${helper}
      $path=${quote(join(root, 'proof.json'))};$pending=${quote(join(root, 'proof.next'))};
      [IO.File]::WriteAllText($path,'assigned');[IO.File]::WriteAllText($pending,'finished');
      $script:calls=0;$script:waits=@();
      function Check($condition,$message) {if(-not $condition){throw $message}}
      ${body}
      [Console]::WriteLine('status-case-passed')`;
    const result = await runProcess({ command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      timeoutMs: 10000, detached: false });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /status-case-passed/);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const code of [32, 1175]) {
  test(`Windows receipt retries preserved-path error ${code} without rewriting either input`, windows, async () => {
    await statusCase(`
      Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText 'assigned' -Replace {
        param($source,$target)
        Check ($source -ceq $pending -and $target -ceq $path) 'replacement paths changed';$script:calls++
        if($script:calls -lt 3){throw [IO.IOException]::new('transient fixture',(-2147024896 + ${code}))}
        [IO.File]::Replace($source,$target,[System.Management.Automation.Language.NullString]::Value)
      } -Pause {
        param($milliseconds);$script:waits+=$milliseconds
        Check ([IO.File]::ReadAllText($path) -ceq 'assigned') 'assigned receipt was changed while waiting'
        Check ([IO.File]::ReadAllText($pending) -ceq 'finished') 'pending receipt was changed while waiting'
      }
      Check ($script:calls -eq 3) 'expected exactly three replacement attempts'
      Check (($script:waits -join ',') -ceq '25,50') 'unexpected retry delays'
      Check ([IO.File]::ReadAllText($path) -ceq 'finished') 'finished receipt not published'
      Check (-not [IO.File]::Exists($pending)) 'atomic replacement did not consume pending receipt'
    `);
  });

  test(`Windows receipt bounds persistent preserved-path error ${code} and keeps both files`, windows, async () => {
    await statusCase(`
      $failure=$null
      try {
        Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText 'assigned' -Replace {
          $script:calls++;throw [IO.IOException]::new('persistent fixture',(-2147024896 + ${code}))
        } -Pause {param($milliseconds);$script:waits+=$milliseconds}
      } catch {$failure=$_.Exception.GetBaseException()}
      Check ($failure -is [IO.IOException] -and $failure.HResult -eq (-2147024896 + ${code})) 'original failure was not propagated'
      Check ($script:calls -eq 6) 'persistent conflict was not bounded to six attempts'
      Check (($script:waits -join ',') -ceq '25,50,100,200,400') 'unexpected bounded delays'
      Check ([IO.File]::ReadAllText($path) -ceq 'assigned') 'persistent conflict destroyed assigned receipt'
      Check ([IO.File]::ReadAllText($pending) -ceq 'finished') 'persistent conflict destroyed pending evidence'
    `);
  });
}

for (const code of [2, 5, 33, 1176, 1177]) {
  test(`Windows receipt does not retry unapproved or partially-moving error ${code}`, windows, async () => {
    await statusCase(`
      $failure=$null
      try {
        Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText 'assigned' -Replace {
          $script:calls++;throw [IO.IOException]::new('non-retryable fixture',(-2147024896 + ${code}))
        } -Pause {param($milliseconds);$script:waits+=$milliseconds}
      } catch {$failure=$_.Exception.GetBaseException()}
      Check ($failure -is [IO.IOException] -and $failure.HResult -eq (-2147024896 + ${code})) 'original non-retryable error was not propagated'
      Check ($script:calls -eq 1 -and $script:waits.Count -eq 0) 'unapproved error was retried'
    `);
  });
}

for (const changed of ['path', 'pending']) {
  test(`Windows receipt refuses a changed ${changed} after a sharing-conflict wait`, windows, async () => {
    await statusCase(`
      $failure=$null
      try {
        Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText 'assigned' -Replace {
          $script:calls++;throw [IO.IOException]::new('transient fixture',-2147024864)
        } -Pause {[IO.File]::WriteAllText($${changed},'foreign-receipt')}
      } catch {$failure=$_.Exception.GetBaseException()}
      Check ($failure -is [InvalidOperationException] -and $failure.Message -ceq 'OWNED_WINDOWS_JOB_PROOF_CHANGED') 'changed proof must fail closed'
      Check ($script:calls -eq 1) 'changed proof reached another replacement attempt'
      Check ([IO.File]::ReadAllText($${changed}) -ceq 'foreign-receipt') 'foreign receipt was overwritten'
    `);
  });
}

test('Windows receipt permanently held by a real reader remains failed and intact', windows, async () => {
  await statusCase(`
    $reader=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $failure=$null
    try {
      try {Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText 'assigned' -Pause {
        param($milliseconds);$script:waits+=$milliseconds;[Threading.Thread]::Sleep($milliseconds)
      }} catch {$failure=$_.Exception.GetBaseException()}
    } finally {$reader.Dispose()}
    Check ($failure -is [IO.IOException] -and $failure.HResult -eq -2147024864) 'real sharing violation must remain failed'
    Check (($script:waits -join ',') -ceq '25,50,100,200,400') 'real sharing failure was not bounded'
    Check ([IO.File]::ReadAllText($path) -ceq 'assigned') 'real reader conflict destroyed original receipt'
    Check ([IO.File]::ReadAllText($pending) -ceq 'finished') 'real reader conflict destroyed pending evidence'
  `);
});

test('Windows receipt does not retry a real read-only access denial', windows, async () => {
  await statusCase(`
    [IO.File]::SetAttributes($path,[IO.FileAttributes]::ReadOnly);$failure=$null
    try {
      try {Publish-SoulForgeOwnedJobProof -Pending $pending -Path $path -AssignedText 'assigned' -Pause {
        param($milliseconds);$script:waits+=$milliseconds
      }} catch {$failure=$_.Exception.GetBaseException()}
    } finally {[IO.File]::SetAttributes($path,[IO.FileAttributes]::Normal);[IO.File]::SetAttributes($pending,[IO.FileAttributes]::Normal)}
    Check ($failure -is [UnauthorizedAccessException]) 'expected actual read-only access denial'
    Check ($script:waits.Count -eq 0) 'access denial was retried'
    Check ([IO.File]::ReadAllText($path) -ceq 'assigned') 'access denial destroyed original receipt'
    Check ([IO.File]::ReadAllText($pending) -ceq 'finished') 'access denial destroyed pending evidence'
  `);
});

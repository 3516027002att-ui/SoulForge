import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import {
  createBridgeDaemonScope,
  disposeBridgeClientPromises,
  disposeBridgeDaemonPool,
  runBridge
} from '../bridge/runBridge.js';

const execFileAsync = promisify(execFile);

interface OwnedBridgeProcess {
  pid: number;
  parentPid: number;
  creationTime: string;
  executablePath: string;
  name: string;
}

interface ScopedProcessLifecycle {
  status: 'verified' | 'skipped';
  scopeBKey?: string;
}

function main(): Promise<void> {
  return withSmokeWorkspace('bridge-client', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const executable = resolve(
    process.argv[2] ?? '../../bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
  );
  const eventDirectory = join(root, 'event');
  await mkdir(eventDirectory, { recursive: true });
  const filePath = join(eventDirectory, 'client-smoke.emevd');
  await writeFile(filePath, Buffer.from('EVD\0client-smoke', 'binary'));

  try {
    const progress: unknown[] = [];
    const first = await runBridge({
      bridgeExecutablePath: executable,
      command: 'inspect',
      filePath,
      resourceUri: 'file://event/client-smoke.emevd',
      allowedRoots: [root],
      workspaceSessionId: 'bridge-client-smoke',
      timeoutMs: 10_000,
      onProgress: (payload) => progress.push(payload)
    });
    if (first.parseStatus !== 'partial') {
      throw new Error(`First daemon request failed: ${JSON.stringify(first.diagnostics)}`);
    }

    const second = await runBridge({
      bridgeExecutablePath: executable,
      command: 'validate',
      filePath,
      resourceUri: 'file://event/client-smoke.emevd',
      allowedRoots: [root],
      workspaceSessionId: 'bridge-client-smoke',
      timeoutMs: 10_000
    });
    if (!second.diagnostics.some((item) => item.code === 'VALIDATION_READABLE')) {
      throw new Error(`Second pooled daemon request failed: ${JSON.stringify(second.diagnostics)}`);
    }
    if (progress.length < 2) throw new Error('Bridge client did not receive progress frames.');

    await verifyDisposeDrainsSettledClients();

    // Short-lived scopes must own only their clients. Disposing one scope must
    // not close a concurrent scope or the process-wide production pool.
    const processesBeforeScopes = await queryOwnedBridgeProcesses(executable);
    const scopeA = createBridgeDaemonScope();
    const scopeB = createBridgeDaemonScope();
    let processLifecycle: ScopedProcessLifecycle = { status: 'skipped' };
    try {
      const [scopedFirst, scopedSecond] = await Promise.all([
        scopeA.run({
          bridgeExecutablePath: executable,
          command: 'inspect',
          filePath,
          resourceUri: 'file://event/client-smoke.emevd',
          allowedRoots: [root],
          workspaceSessionId: 'bridge-client-scope-a',
          timeoutMs: 10_000
        }),
        scopeB.run({
          bridgeExecutablePath: executable,
          command: 'validate',
          filePath,
          resourceUri: 'file://event/client-smoke.emevd',
          allowedRoots: [root],
          workspaceSessionId: 'bridge-client-scope-b',
          timeoutMs: 10_000
        })
      ]);
      if (scopedFirst.parseStatus !== 'partial') {
        throw new Error(`Scoped inspect request failed: ${JSON.stringify(scopedFirst.diagnostics)}`);
      }
      if (!scopedSecond.diagnostics.some((item) => item.code === 'VALIDATION_READABLE')) {
        throw new Error(`Scoped validate request failed: ${JSON.stringify(scopedSecond.diagnostics)}`);
      }

      processLifecycle = await verifyScopedProcessLifecycle(
        executable,
        processesBeforeScopes,
        scopeA,
        scopeB
      );

      await scopeA.dispose();
      const closedScope = await scopeA.run({
        bridgeExecutablePath: executable,
        command: 'validate',
        filePath,
        resourceUri: 'file://event/client-smoke.emevd',
        allowedRoots: [root],
        workspaceSessionId: 'bridge-client-scope-a',
        timeoutMs: 10_000
      });
      if (closedScope.parseStatus !== 'failed'
        || !closedScope.diagnostics.some((item) => item.code === 'BRIDGE_SCOPE_CLOSED')) {
        throw new Error(`Closed Bridge scope was not rejected: ${JSON.stringify(closedScope)}`);
      }

      const survivingScope = await scopeB.run({
        bridgeExecutablePath: executable,
        command: 'validate',
        filePath,
        resourceUri: 'file://event/client-smoke.emevd',
        allowedRoots: [root],
        workspaceSessionId: 'bridge-client-scope-b',
        timeoutMs: 10_000
      });
      if (!survivingScope.diagnostics.some((item) => item.code === 'VALIDATION_READABLE')) {
        throw new Error(`Sibling Bridge scope did not survive disposal of scope A: ${JSON.stringify(survivingScope.diagnostics)}`);
      }
      if (processLifecycle.status === 'verified') {
        const afterScopeBReuse = await waitForOwnedBridgeProcessCount(executable, processesBeforeScopes.length + 1);
        assertBaselineProcesses(afterScopeBReuse, processesBeforeScopes, 'scope B reuse');
        if (!processLifecycle.scopeBKey || !afterScopeBReuse.some((item) => processKey(item) === processLifecycle.scopeBKey)) {
          throw new Error(`Scope B did not reuse its original PID+creation identity: ${JSON.stringify(afterScopeBReuse)}`);
        }
      }

      const startupScope = createBridgeDaemonScope();
      try {
        const startupRequest = startupScope.run({
          bridgeExecutablePath: executable,
          command: 'inspect',
          filePath,
          resourceUri: 'file://event/client-smoke.emevd',
          allowedRoots: [root],
          workspaceSessionId: 'bridge-client-scope-startup-dispose',
          timeoutMs: 10_000
        });
        // This call is intentionally made before awaiting the startup handshake.
        const startupDispose = startupScope.dispose();
        const [startupResult] = await Promise.all([startupRequest, startupDispose]);
        if (startupResult.parseStatus !== 'partial') {
          throw new Error(`Bridge scope dispose during startup interrupted the request: ${JSON.stringify(startupResult.diagnostics)}`);
        }
      } finally {
        await startupScope.dispose();
      }

      const inflightScope = createBridgeDaemonScope();
      let releaseProgress: (() => void) | undefined;
      const progressGate = new Promise<void>((resolveGate) => { releaseProgress = resolveGate; });
      let progressEnteredResolve: (() => void) | undefined;
      const progressEntered = new Promise<void>((resolveEntered) => { progressEnteredResolve = resolveEntered; });
      let inflightRequest: Promise<unknown> = Promise.resolve();
      try {
        const request = inflightScope.run({
          bridgeExecutablePath: executable,
          command: 'inspect',
          filePath,
          resourceUri: 'file://event/client-smoke.emevd',
          allowedRoots: [root],
          workspaceSessionId: 'bridge-client-scope-inflight-dispose',
          timeoutMs: 10_000,
          onProgress: async () => {
            progressEnteredResolve?.();
            await progressGate;
          }
        });
        inflightRequest = request;
        await Promise.race([
          progressEntered,
          delay(10_000).then(() => {
            throw new Error('Bridge in-flight dispose test did not receive a progress frame.');
          })
        ]);
        let disposeSettled = false;
        const inflightDispose = inflightScope.dispose().finally(() => { disposeSettled = true; });
        await delay(50);
        if (disposeSettled) {
          releaseProgress?.();
          await Promise.allSettled([request, inflightDispose]);
          throw new Error('Bridge scope dispose completed while its progress callback was still in flight.');
        }
        releaseProgress?.();
        const [inflightResult] = await Promise.all([request, inflightDispose]);
        if (inflightResult.parseStatus !== 'partial') {
          throw new Error(`Bridge scope dispose during in-flight progress failed the request: ${JSON.stringify(inflightResult.diagnostics)}`);
        }
      } finally {
        releaseProgress?.();
        await Promise.allSettled([inflightRequest, inflightScope.dispose()]);
      }
    } finally {
      await Promise.all([scopeA.dispose(), scopeB.dispose()]);
      if (processLifecycle.status === 'verified') {
        const afterScopeCleanup = await waitForOwnedBridgeProcessCount(executable, processesBeforeScopes.length);
        assertBaselineProcesses(afterScopeCleanup, processesBeforeScopes, 'scope cleanup');
      }
    }

    const globalAfterScopes = await runBridge({
      bridgeExecutablePath: executable,
      command: 'validate',
      filePath,
      resourceUri: 'file://event/client-smoke.emevd',
      allowedRoots: [root],
      workspaceSessionId: 'bridge-client-smoke',
      timeoutMs: 10_000
    });
    if (!globalAfterScopes.diagnostics.some((item) => item.code === 'VALIDATION_READABLE')) {
      throw new Error(`Global Bridge pool was affected by scoped disposal: ${JSON.stringify(globalAfterScopes.diagnostics)}`);
    }
    if (processLifecycle.status === 'verified') {
      const afterGlobalReuse = await waitForOwnedBridgeProcessCount(executable, processesBeforeScopes.length);
      assertBaselineProcesses(afterGlobalReuse, processesBeforeScopes, 'global pool reuse');
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'TypeScript Bridge 常驻客户端验证通过',
      firstStatus: first.parseStatus,
      secondStatus: second.parseStatus,
      scopedIsolation: true,
      progressFrames: progress.length,
      processLifecycle: processLifecycle.status
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

async function verifyDisposeDrainsSettledClients(): Promise<void> {
  const disposeFailure = new Error('synthetic dispose failure');
  let releaseDelayed: (() => void) | undefined;
  let delayedDisposed = false;
  const delayedDispose = new Promise<void>((resolveDelayed) => { releaseDelayed = resolveDelayed; });
  const completion = disposeBridgeClientPromises([
    Promise.resolve({
      dispose: async () => {
        throw disposeFailure;
      }
    }),
    Promise.resolve({
      dispose: async () => {
        await delayedDispose;
        delayedDisposed = true;
      }
    })
  ]).then(
    () => ({ ok: true as const, error: undefined }),
    (error: unknown) => ({ ok: false as const, error })
  );

  let completionSettled = false;
  void completion.finally(() => { completionSettled = true; });
  try {
    await delay(50);
    if (completionSettled) {
      throw new Error('Bridge scope dispose reported before the delayed sibling client settled.');
    }
  } finally {
    releaseDelayed?.();
  }
  const result = await completion;
  if (result.ok || !delayedDisposed || result.error !== disposeFailure) {
    throw new Error('Bridge scope dispose did not drain all clients before preserving its failure.');
  }
}

async function verifyScopedProcessLifecycle(
  executable: string,
  before: OwnedBridgeProcess[],
  scopeA: { dispose: () => Promise<void> },
  scopeB: { dispose: () => Promise<void> }
): Promise<ScopedProcessLifecycle> {
  if (process.platform !== 'win32') return { status: 'skipped' };

  const afterStart = await waitForOwnedBridgeProcessCount(executable, before.length + 2);
  assertBaselineProcesses(afterStart, before, 'scope start');
  const beforeKeys = new Set(before.map(processKey));
  const added = afterStart.filter((item) => !beforeKeys.has(processKey(item)));
  if (added.length !== 2 || added.some((item) => !item.creationTime)) {
    throw new Error(`Expected two newly-owned Bridge daemons with creation times, got ${JSON.stringify(added)}`);
  }

  await scopeA.dispose();
  const afterScopeA = await waitForOwnedBridgeProcessCount(executable, before.length + 1);
  assertBaselineProcesses(afterScopeA, before, 'scope A disposal');
  const surviving = added.filter((item) => afterScopeA.some((candidate) => processKey(candidate) === processKey(item)));
  const released = added.filter((item) => !afterScopeA.some((candidate) => processKey(candidate) === processKey(item)));
  if (surviving.length !== 1 || released.length !== 1) {
    throw new Error(`Scope A disposal did not release exactly one owned PID+creation identity: ${JSON.stringify({ added, afterScopeA })}`);
  }
  const scopeBProcess = surviving[0];
  if (!scopeBProcess) throw new Error('Scope B process identity was not observed after scope A disposal.');
  // Leave scope B alive for the sibling-survival assertion in the caller.
  void scopeB;
  return { status: 'verified', scopeBKey: processKey(scopeBProcess) };
}

async function queryOwnedBridgeProcesses(executable: string): Promise<OwnedBridgeProcess[]> {
  if (process.platform !== 'win32') return [];
  const command = [
    '$ErrorActionPreference = "Stop";',
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath |',
    'ConvertTo-Json -Compress'
  ].join(' ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout ?? '').trim() || '[]') as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const expectedPath = normalizeProcessPath(executable);
  return values
    .map(normalizeOwnedBridgeProcess)
    .filter((item): item is OwnedBridgeProcess => item !== undefined)
    .filter((item) => item.parentPid === process.pid
      && item.executablePath.length > 0
      && normalizeProcessPath(item.executablePath) === expectedPath);
}

function normalizeOwnedBridgeProcess(value: unknown): OwnedBridgeProcess | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const pid = Number(item.ProcessId);
  const parentPid = Number(item.ParentProcessId);
  const creationTime = normalizeCreationTime(item.CreationDate);
  const name = typeof item.Name === 'string' ? item.Name : '';
  const executablePath = typeof item.ExecutablePath === 'string' ? item.ExecutablePath : '';
  if (!Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(parentPid) || parentPid <= 0
    || !creationTime || !name) return undefined;
  return { pid, parentPid, creationTime, executablePath, name };
}

function normalizeCreationTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value);
  const dotNet = /^\/Date\((\d+)\)\/$/.exec(raw);
  if (dotNet) return new Date(Number(dotNet[1])).toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function normalizeProcessPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function processKey(process: OwnedBridgeProcess): string {
  return `${process.pid}:${process.creationTime}`;
}

async function waitForOwnedBridgeProcessCount(
  executable: string,
  expected: number,
  timeoutMs = 15_000
): Promise<OwnedBridgeProcess[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: OwnedBridgeProcess[] = [];
  while (Date.now() <= deadline) {
    latest = await queryOwnedBridgeProcesses(executable);
    if (latest.length === expected) return latest;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${expected} owned Bridge processes; observed ${latest.length}: ${JSON.stringify(latest)}`);
}

function assertBaselineProcesses(
  observed: OwnedBridgeProcess[],
  baseline: OwnedBridgeProcess[],
  phase: string
): void {
  const observedKeys = new Set(observed.map(processKey));
  const missing = baseline.filter((item) => !observedKeys.has(processKey(item)));
  if (missing.length > 0) {
    throw new Error(`Global Bridge baseline PID+creation identity disappeared during ${phase}: ${JSON.stringify(missing)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

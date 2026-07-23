import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import {
  type RuntimeProcessHandle,
  type RuntimeProcessHost
} from '../runtime/me3RuntimeAdapter.js';
import { TrustedMe3RuntimeAdapter } from '../runtime/trustedMe3RuntimeAdapter.js';

class FakeProcessHandle implements RuntimeProcessHandle {
  readonly pid = 4242;
  readonly killedSignals: NodeJS.Signals[] = [];
  private stdoutListener: ((chunk: Uint8Array | string) => void) | undefined;
  private stderrListener: ((chunk: Uint8Array | string) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;
  private exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  onStdout(listener: (chunk: Uint8Array | string) => void): void {
    this.stdoutListener = listener;
  }

  onStderr(listener: (chunk: Uint8Array | string) => void): void {
    this.stderrListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListener = listener;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedSignals.push(signal);
    queueMicrotask(() => this.exitListener?.(null, signal));
    return true;
  }

  emitStdout(value: string): void {
    this.stdoutListener?.(value);
  }

  emitStderr(value: string): void {
    this.stderrListener?.(value);
  }

  exit(code: number): void {
    this.exitListener?.(code, null);
  }
}

class FakeProcessHost implements RuntimeProcessHost {
  readonly handles: FakeProcessHandle[] = [];
  command = '';
  args: readonly string[] = [];
  cwd = '';

  spawn(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): RuntimeProcessHandle {
    const handle = new FakeProcessHandle();
    this.handles.push(handle);
    this.command = command;
    this.args = args;
    this.cwd = options.cwd;
    return handle;
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-me3-smoke-'));
  try {
    const overlayRoot = join(root, 'mod');
    const applicationDataRoot = join(root, 'app-data');
    const executablePath = join(root, process.platform === 'win32' ? 'me3.exe' : 'me3');
    await mkdir(overlayRoot, { recursive: true });
    await mkdir(applicationDataRoot, { recursive: true });
    await writeFile(executablePath, 'fixture-only', 'utf8');
    if (process.platform !== 'win32') await chmod(executablePath, 0o755);

    const workspace = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
    const processHost = new FakeProcessHost();
    const adapter = new TrustedMe3RuntimeAdapter({
      applicationDataRoot,
      executablePath,
      processHost,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      idFactory: () => 'fixed-id',
      maxOutputBytes: 64
    });

    const capability = await adapter.detect();
    assert.equal(capability.status, 'available');
    assert.equal(capability.executablePath, executablePath);

    const profile = await adapter.prepareProfile(workspace, {
      operationId: 'op-123',
      profileName: 'SoulForge Sekiro Smoke'
    });
    const profileText = await readFile(profile.profilePath, 'utf8');
    assert.match(profileText, /profileVersion = "v1"/);
    assert.match(profileText, /game = "sekiro"/);
    assert.match(profileText, /\[\[packages\]\]/);
    assert.match(profileText, /path = /);
    assert.equal(profile.operationId, 'op-123');
    assert.equal(profile.profilePath.startsWith(applicationDataRoot), true);
    assert.equal(profile.profilePath.startsWith(overlayRoot), false);

    const session = await adapter.launch(profile, { extraArgs: ['--auto-detect'] });
    assert.equal(processHost.command, executablePath);
    assert.deepEqual(processHost.args, ['launch', '-p', profile.profilePath, '--auto-detect']);
    assert.equal(processHost.cwd, join(applicationDataRoot, 'runtime', 'me3', 'profiles'));

    const firstHandle = processHost.handles[0];
    assert.ok(firstHandle);
    firstHandle.emitStdout('launching sekiro\n');
    firstHandle.emitStderr('fixture warning\n');
    firstHandle.exit(0);
    const snapshot = await session.waitForExit();
    assert.equal(snapshot.state, 'exited');
    assert.equal(snapshot.exitCode, 0);
    assert.match(snapshot.stdout, /launching sekiro/);

    const diagnostics = await adapter.collectDiagnostics(session);
    assert.equal(diagnostics.operationId, 'op-123');
    assert.equal(diagnostics.diagnostics.some((item) => item.code === 'ME3_PROCESS_EXITED_ZERO'), true);

    const secondSession = await adapter.launch(profile);
    const secondHandle = processHost.handles[1];
    assert.ok(secondHandle);
    await adapter.terminate(secondSession);
    const terminated = await secondSession.waitForExit();
    assert.equal(terminated.state, 'terminated');
    assert.deepEqual(secondHandle.killedSignals, ['SIGTERM']);

    const unsafeApplicationDataRoot = join(overlayRoot, 'unsafe-app-data');
    await mkdir(unsafeApplicationDataRoot, { recursive: true });
    const unsafeAdapter = new TrustedMe3RuntimeAdapter({
      applicationDataRoot: unsafeApplicationDataRoot,
      executablePath,
      processHost: new FakeProcessHost()
    });
    await assert.rejects(
      unsafeAdapter.prepareProfile(workspace),
      /Runtime metadata root must not be inside the Mod overlay/
    );
    await assert.rejects(access(join(unsafeApplicationDataRoot, 'runtime')), { code: 'ENOENT' });

    console.log(JSON.stringify({
      capability: capability.status,
      profile: profile.profileId,
      launchState: snapshot.state,
      terminatedState: terminated.state,
      unsafeBoundary: 'rejected-before-runtime-directory'
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

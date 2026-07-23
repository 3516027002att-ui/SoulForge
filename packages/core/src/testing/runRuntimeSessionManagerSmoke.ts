import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '@soulforge/shared';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import type {
  GameRuntimeAdapter,
  LaunchRuntimeOptions,
  LaunchSession,
  PrepareRuntimeProfileOptions,
  RuntimeCapability,
  RuntimeDiagnostics,
  RuntimeProcessSnapshot,
  RuntimeProfile
} from '../runtime/gameRuntimeAdapter.js';
import {
  MemoryRuntimeLaunchSessionStore,
  type RuntimeLaunchRecord
} from '../runtime/runtimeSessionStore.js';
import { RuntimeSessionManager } from '../runtime/runtimeSessionManager.js';

class ControlledSession implements LaunchSession {
  readonly adapterId = 'fixture-runtime';
  readonly sessionId: string;
  readonly profile: RuntimeProfile;
  readonly operationId: string | undefined;
  private state: RuntimeProcessSnapshot['state'] = 'running';
  private exitCode: number | undefined;
  private exitedAt: string | undefined;
  private resolveExit!: (snapshot: RuntimeProcessSnapshot) => void;
  private readonly done: Promise<RuntimeProcessSnapshot>;

  constructor(sessionId: string, profile: RuntimeProfile) {
    this.sessionId = sessionId;
    this.profile = profile;
    this.operationId = profile.operationId;
    this.done = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  snapshot(): RuntimeProcessSnapshot {
    return {
      pid: 777,
      state: this.state,
      startedAt: '2026-07-24T00:00:00.000Z',
      ...(this.exitedAt ? { exitedAt: this.exitedAt } : {}),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      stdout: this.state === 'running' ? 'fixture running\n' : 'fixture finished\n',
      stderr: '',
      outputTruncated: false
    };
  }

  waitForExit(): Promise<RuntimeProcessSnapshot> {
    return this.done;
  }

  finish(exitCode = 0): void {
    this.state = 'exited';
    this.exitCode = exitCode;
    this.exitedAt = '2026-07-24T00:00:01.000Z';
    this.resolveExit(this.snapshot());
  }

  terminate(): void {
    this.state = 'terminated';
    this.exitedAt = '2026-07-24T00:00:02.000Z';
    this.resolveExit(this.snapshot());
  }
}

class FixtureRuntimeAdapter implements GameRuntimeAdapter {
  readonly id = 'fixture-runtime';
  readonly sessions: ControlledSession[] = [];
  private nextSession = 1;

  detect(): Promise<RuntimeCapability> {
    return Promise.resolve({ adapterId: this.id, status: 'available', diagnostics: [] });
  }

  prepareProfile(
    workspace: Awaited<ReturnType<typeof openWorkspaceSession>>,
    options: PrepareRuntimeProfileOptions = {}
  ): Promise<RuntimeProfile> {
    return Promise.resolve({
      adapterId: this.id,
      profileId: 'fixture-profile',
      profilePath: join(workspace.layers.overlayRoot, '..', 'runtime', 'fixture.me3'),
      game: workspace.meta.game,
      workspaceId: workspace.meta.workspaceId,
      overlayRoot: workspace.layers.overlayRoot,
      createdAt: '2026-07-24T00:00:00.000Z',
      ...(options.operationId === undefined ? {} : { operationId: options.operationId })
    });
  }

  launch(profile: RuntimeProfile, _options?: LaunchRuntimeOptions): Promise<LaunchSession> {
    const session = new ControlledSession(`session-${this.nextSession++}`, profile);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  collectDiagnostics(session: LaunchSession): Promise<RuntimeDiagnostics> {
    const snapshot = session.snapshot();
    const diagnostics: Diagnostic[] = snapshot.state === 'exited' && snapshot.exitCode === 0
      ? [{
          severity: 'info',
          code: 'FIXTURE_EXIT_ZERO_UNVERIFIED',
          message: 'Fixture process exited; no real game verification was performed.'
        }]
      : [];
    return Promise.resolve({
      adapterId: this.id,
      sessionId: session.sessionId,
      ...(session.operationId === undefined ? {} : { operationId: session.operationId }),
      profilePath: session.profile.profilePath,
      process: snapshot,
      diagnostics
    });
  }

  async terminate(session: LaunchSession): Promise<void> {
    const controlled = session as ControlledSession;
    controlled.terminate();
    await controlled.waitForExit();
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-runtime-manager-'));
  try {
    const overlayRoot = join(root, 'mod');
    await mkdir(overlayRoot, { recursive: true });
    const workspace = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
    const store = new MemoryRuntimeLaunchSessionStore();
    const stale: RuntimeLaunchRecord = {
      sessionId: 'stale-session',
      workspaceId: workspace.meta.workspaceId,
      adapterId: 'fixture-runtime',
      profileId: 'stale-profile',
      profilePath: join(root, 'runtime', 'stale.me3'),
      verificationKind: 'manual',
      state: 'running',
      startedAt: '2026-07-23T23:00:00.000Z',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      diagnostics: [],
      updatedAt: '2026-07-23T23:00:00.000Z'
    };
    store.upsertRuntimeSession(stale);

    let tick = 0;
    const backgroundErrors: Error[] = [];
    const adapter = new FixtureRuntimeAdapter();
    const manager = new RuntimeSessionManager({
      adapter,
      workspace,
      store,
      now: () => new Date(`2026-07-24T00:00:0${Math.min(tick++, 9)}.000Z`),
      onBackgroundError: (error) => backgroundErrors.push(error)
    });

    assert.equal(await manager.recoverInterruptedSessions(), 1);
    assert.equal((await manager.get('stale-session'))?.state, 'orphaned');

    const launched = await manager.launch({
      operationId: 'op-commit',
      verificationKind: 'post_commit'
    });
    assert.equal(launched.record.state, 'running');
    assert.equal(launched.record.operationId, 'op-commit');
    assert.equal(manager.hasActiveSessions(), true);
    adapter.sessions[0]!.finish(0);
    const exited = await manager.waitForExit(launched.record.sessionId);
    assert.equal(exited.state, 'exited');
    assert.equal(exited.exitCode, 0);
    assert.equal(exited.diagnostics.some((item) => item.code === 'FIXTURE_EXIT_ZERO_UNVERIFIED'), true);

    const rollbackLaunch = await manager.launch({
      operationId: 'op-inverse',
      relatedOperationId: 'op-original',
      verificationKind: 'post_rollback'
    });
    assert.equal(rollbackLaunch.record.relatedOperationId, 'op-original');
    const terminated = await manager.terminate(rollbackLaunch.record.sessionId);
    assert.equal(terminated.state, 'terminated');

    const detachedLaunch = await manager.launch();
    assert.equal(detachedLaunch.record.verificationKind, 'manual');
    await manager.dispose();
    assert.equal((await store.getRuntimeSession(detachedLaunch.record.sessionId))?.state, 'orphaned');
    assert.deepEqual(backgroundErrors, []);

    const records = store.listRuntimeSessions(workspace.meta.workspaceId);
    assert.equal(records.length, 4);
    console.log(JSON.stringify({
      recovered: 1,
      exited: exited.state,
      terminated: terminated.state,
      detached: 'orphaned',
      persisted: records.length
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

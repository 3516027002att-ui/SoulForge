import type { Diagnostic } from '@soulforge/shared';
import type { RuntimeLaunchState, RuntimeProcessSnapshot } from './gameRuntimeAdapter.js';

export type RuntimeVerificationKind = 'manual' | 'post_commit' | 'post_rollback';
export type PersistedRuntimeLaunchState = RuntimeLaunchState | 'orphaned';

export interface RuntimeLaunchRecord {
  sessionId: string;
  workspaceId: string;
  adapterId: string;
  profileId: string;
  profilePath: string;
  operationId?: string;
  relatedOperationId?: string;
  verificationKind: RuntimeVerificationKind;
  state: PersistedRuntimeLaunchState;
  pid?: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  diagnostics: Diagnostic[];
  updatedAt: string;
}

export interface RuntimeLaunchSessionStore {
  upsertRuntimeSession(record: RuntimeLaunchRecord): void | Promise<void>;
  getRuntimeSession(sessionId: string): RuntimeLaunchRecord | undefined | Promise<RuntimeLaunchRecord | undefined>;
  listRuntimeSessions(workspaceId: string): RuntimeLaunchRecord[] | Promise<RuntimeLaunchRecord[]>;
}

export class MemoryRuntimeLaunchSessionStore implements RuntimeLaunchSessionStore {
  private readonly records = new Map<string, RuntimeLaunchRecord>();

  upsertRuntimeSession(record: RuntimeLaunchRecord): void {
    this.records.set(record.sessionId, cloneRecord(record));
  }

  getRuntimeSession(sessionId: string): RuntimeLaunchRecord | undefined {
    const record = this.records.get(sessionId);
    return record ? cloneRecord(record) : undefined;
  }

  listRuntimeSessions(workspaceId: string): RuntimeLaunchRecord[] {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(cloneRecord);
  }
}

export function isTerminalRuntimeState(state: PersistedRuntimeLaunchState): boolean {
  return state === 'exited' || state === 'failed' || state === 'terminated' || state === 'orphaned';
}

export function runtimeRecordFromSnapshot(input: {
  workspaceId: string;
  adapterId: string;
  profileId: string;
  profilePath: string;
  operationId?: string;
  relatedOperationId?: string;
  verificationKind: RuntimeVerificationKind;
  snapshot: RuntimeProcessSnapshot;
  diagnostics: readonly Diagnostic[];
  updatedAt: string;
}): RuntimeLaunchRecord {
  return {
    sessionId: '',
    workspaceId: input.workspaceId,
    adapterId: input.adapterId,
    profileId: input.profileId,
    profilePath: input.profilePath,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.relatedOperationId === undefined ? {} : { relatedOperationId: input.relatedOperationId }),
    verificationKind: input.verificationKind,
    state: input.snapshot.state,
    ...(input.snapshot.pid === undefined ? {} : { pid: input.snapshot.pid }),
    startedAt: input.snapshot.startedAt,
    ...(input.snapshot.exitedAt === undefined ? {} : { exitedAt: input.snapshot.exitedAt }),
    ...(input.snapshot.exitCode === undefined ? {} : { exitCode: input.snapshot.exitCode }),
    ...(input.snapshot.signal === undefined ? {} : { signal: input.snapshot.signal }),
    stdout: input.snapshot.stdout,
    stderr: input.snapshot.stderr,
    outputTruncated: input.snapshot.outputTruncated,
    diagnostics: input.diagnostics.map(cloneDiagnostic),
    updatedAt: input.updatedAt
  };
}

function cloneRecord(record: RuntimeLaunchRecord): RuntimeLaunchRecord {
  return {
    ...record,
    diagnostics: record.diagnostics.map(cloneDiagnostic)
  };
}

function cloneDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    ...(diagnostic.details === undefined
      ? {}
      : { details: structuredClone(diagnostic.details) })
  };
}

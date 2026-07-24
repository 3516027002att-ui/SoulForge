import type { Diagnostic } from '@soulforge/shared';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export type RuntimeCapabilityStatus = 'available' | 'unavailable' | 'blocked' | 'unverified';
export type RuntimeLaunchState = 'starting' | 'running' | 'exited' | 'failed' | 'terminated';

export interface RuntimeCapability {
  adapterId: string;
  status: RuntimeCapabilityStatus;
  executablePath?: string;
  version?: string;
  diagnostics: Diagnostic[];
}

export interface PrepareRuntimeProfileOptions {
  operationId?: string;
  profileName?: string;
}

export interface RuntimeProfile {
  adapterId: string;
  profileId: string;
  profilePath: string;
  game: string;
  workspaceId: string;
  overlayRoot: string;
  createdAt: string;
  operationId?: string;
}

export interface LaunchRuntimeOptions {
  signal?: AbortSignal;
  extraArgs?: readonly string[];
}

export interface RuntimeProcessSnapshot {
  pid?: number;
  state: RuntimeLaunchState;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface LaunchSession {
  adapterId: string;
  sessionId: string;
  profile: RuntimeProfile;
  operationId: string | undefined;
  snapshot(): RuntimeProcessSnapshot;
  waitForExit(): Promise<RuntimeProcessSnapshot>;
}

export interface RuntimeDiagnostics {
  adapterId: string;
  sessionId: string;
  operationId?: string;
  profilePath: string;
  process: RuntimeProcessSnapshot;
  diagnostics: Diagnostic[];
}

export interface GameRuntimeAdapter {
  readonly id: string;
  detect(): Promise<RuntimeCapability>;
  prepareProfile(
    workspace: WorkspaceSession,
    options?: PrepareRuntimeProfileOptions
  ): Promise<RuntimeProfile>;
  launch(profile: RuntimeProfile, options?: LaunchRuntimeOptions): Promise<LaunchSession>;
  collectDiagnostics(session: LaunchSession): Promise<RuntimeDiagnostics>;
  terminate(session: LaunchSession): Promise<void>;
}

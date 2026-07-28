import type { Diagnostic } from '@soulforge/shared';

export type RuntimeAuthority = 'unverified' | 'fixture-confirmed';

/** Runtime DTO diagnostics intentionally omit the resource path-bearing field. */
export type RuntimeDiagnostic = Omit<Diagnostic, 'sourceUri'>;

export type RuntimeOperationStatus =
  | 'succeeded'
  | 'unsupported'
  | 'failed'
  | 'timed-out'
  | 'cancelled';

export interface RuntimeCallContext {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RuntimeOperationResult<T> {
  ok: boolean;
  status: RuntimeOperationStatus;
  authority: RuntimeAuthority;
  data?: T;
  diagnostics: RuntimeDiagnostic[];
}

export type RuntimeCapabilityState =
  | 'not-found'
  | 'ambiguous'
  | 'malformed-version'
  | 'unsupported-version'
  | 'spawn-failed'
  | 'probe-failed'
  | 'timed-out'
  | 'cancelled'
  | 'policy-unset'
  | 'exit-zero-unverified';

export type RuntimeDiscoverySource =
  | 'registry'
  | 'well-known'
  | 'path'
  | 'none'
  | 'multiple';

export interface RuntimeCapability {
  adapterId: string;
  game: 'sekiro';
  state: RuntimeCapabilityState;
  detected: boolean;
  compatible: boolean;
  canPrepareProfile: boolean;
  canLaunch: boolean;
  discoverySource: RuntimeDiscoverySource;
  detectedVersion?: string;
  versionPolicyId?: string;
  authority: RuntimeAuthority;
  nativeRuntimeAuthority: false;
  diagnostics: RuntimeDiagnostic[];
}

export interface RuntimeWorkspaceRef {
  workspaceSessionId: string;
  game: 'sekiro';
}

export interface RuntimeProfileRef {
  profileId: string;
  workspaceSessionId: string;
  game: 'sekiro';
  profileVersion: 'v1';
  contentSha256: string;
}

export interface RuntimeLaunchRequest {
  profile: RuntimeProfileRef;
  operationId?: string;
}

export interface RuntimeLaunchSession {
  sessionId: string;
  operationId?: string;
  game: 'sekiro';
  state: 'starting' | 'running' | 'exited' | 'failed' | 'terminated';
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  diagnostics: RuntimeDiagnostic[];
}

export interface RuntimeDiagnostics {
  sessionId: string;
  observedAt: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface RuntimeTerminationResult {
  sessionId: string;
  terminated: boolean;
}

/**
 * Renderer-independent runtime boundary. Implementations may orchestrate a
 * privileged main-process gateway, but no filesystem path, process id, argv,
 * cwd, or environment value belongs in this contract.
 */
export interface GameRuntimeAdapter {
  readonly adapterId: string;
  readonly game: 'sekiro';

  detect(context: RuntimeCallContext): Promise<RuntimeCapability>;

  prepareProfile(
    workspace: RuntimeWorkspaceRef,
    context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeProfileRef>>;

  launch(
    request: RuntimeLaunchRequest,
    context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeLaunchSession>>;

  collectDiagnostics(
    session: RuntimeLaunchSession,
    context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeDiagnostics>>;

  terminate(
    session: RuntimeLaunchSession,
    context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeTerminationResult>>;
}

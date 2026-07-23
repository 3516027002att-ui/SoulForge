import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type {
  GameRuntimeAdapter,
  LaunchRuntimeOptions,
  LaunchSession,
  PrepareRuntimeProfileOptions,
  RuntimeCapability,
  RuntimeDiagnostics,
  RuntimeProfile
} from './gameRuntimeAdapter.js';
import {
  Me3RuntimeAdapter,
  type Me3RuntimeAdapterOptions,
  type RuntimeProcessHost
} from './me3RuntimeAdapter.js';

export interface TrustedMe3RuntimeAdapterOptions {
  applicationDataRoot: string;
  /**
   * Main-owned, user-confirmed me3 executable path. PATH discovery is
   * deliberately disabled at this public boundary.
   */
  executablePath: string;
  maxOutputBytes?: number;
  terminateGraceMs?: number;
  processHost?: RuntimeProcessHost;
  now?: () => Date;
  idFactory?: () => string;
}

/**
 * Public me3 adapter boundary.
 *
 * It intentionally requires a main-owned executable path and passes an empty
 * environment to the lower-level adapter's discovery logic, preventing an
 * untrusted PATH entry from becoming an executable launch authority.
 */
export class TrustedMe3RuntimeAdapter implements GameRuntimeAdapter {
  readonly id = 'me3';
  private readonly delegate: Me3RuntimeAdapter;

  constructor(options: TrustedMe3RuntimeAdapterOptions) {
    const delegateOptions: Me3RuntimeAdapterOptions = {
      applicationDataRoot: options.applicationDataRoot,
      executablePath: options.executablePath,
      environment: {},
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.terminateGraceMs === undefined ? {} : { terminateGraceMs: options.terminateGraceMs }),
      ...(options.processHost === undefined ? {} : { processHost: options.processHost }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory })
    };
    this.delegate = new Me3RuntimeAdapter(delegateOptions);
  }

  detect(): Promise<RuntimeCapability> {
    return this.delegate.detect();
  }

  prepareProfile(
    workspace: WorkspaceSession,
    options?: PrepareRuntimeProfileOptions
  ): Promise<RuntimeProfile> {
    return this.delegate.prepareProfile(workspace, options);
  }

  launch(profile: RuntimeProfile, options?: LaunchRuntimeOptions): Promise<LaunchSession> {
    return this.delegate.launch(profile, options);
  }

  collectDiagnostics(session: LaunchSession): Promise<RuntimeDiagnostics> {
    return this.delegate.collectDiagnostics(session);
  }

  terminate(session: LaunchSession): Promise<void> {
    return this.delegate.terminate(session);
  }
}

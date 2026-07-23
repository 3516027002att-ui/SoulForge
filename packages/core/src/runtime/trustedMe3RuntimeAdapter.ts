import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPathInside } from '../workspace/pathBoundary.js';
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
 *
 * Runtime metadata roots are physically checked before the lower-level adapter
 * may create a profile directory, so a rejected configuration cannot leave
 * files or directories inside the Mod overlay or read-only base directory.
 */
export class TrustedMe3RuntimeAdapter implements GameRuntimeAdapter {
  readonly id = 'me3';
  private readonly applicationDataRoot: string;
  private readonly delegate: Me3RuntimeAdapter;

  constructor(options: TrustedMe3RuntimeAdapterOptions) {
    this.applicationDataRoot = resolve(options.applicationDataRoot);
    const delegateOptions: Me3RuntimeAdapterOptions = {
      applicationDataRoot: this.applicationDataRoot,
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

  async prepareProfile(
    workspace: WorkspaceSession,
    options?: PrepareRuntimeProfileOptions
  ): Promise<RuntimeProfile> {
    await assertRuntimeMetadataRootOutsideWorkspace(this.applicationDataRoot, workspace);
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

async function assertRuntimeMetadataRootOutsideWorkspace(
  applicationDataRoot: string,
  workspace: WorkspaceSession
): Promise<void> {
  const info = await stat(applicationDataRoot);
  if (!info.isDirectory()) {
    throw new Error(`applicationDataRoot is not a directory: ${applicationDataRoot}`);
  }

  const physicalApplicationDataRoot = await realpath(applicationDataRoot);
  const physicalOverlayRoot = await realpath(workspace.layers.overlayRoot);
  if (isPathInside(physicalOverlayRoot, physicalApplicationDataRoot)) {
    throw new Error('Runtime metadata root must not be inside the Mod overlay.');
  }

  if (workspace.layers.baseRoot) {
    const physicalBaseRoot = await realpath(workspace.layers.baseRoot);
    if (isPathInside(physicalBaseRoot, physicalApplicationDataRoot)) {
      throw new Error('Runtime metadata root must not be inside the read-only base game directory.');
    }
  }
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isPathInside, verifyPathInsideRoot } from '../workspace/pathBoundary.js';
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
  type RuntimeProcessHandle,
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
 * It intentionally requires a main-owned executable path. PATH is removed only
 * from executable discovery; the already-confirmed process receives the normal
 * launch environment so Windows, Steam and me3 keep their expected variables.
 *
 * Runtime metadata roots and every profile-directory prefix are physically
 * checked before the lower-level adapter may write a profile. This prevents a
 * junction/symlink inside application data from redirecting profile creation.
 */
export class TrustedMe3RuntimeAdapter implements GameRuntimeAdapter {
  readonly id = 'me3';
  private readonly applicationDataRoot: string;
  private readonly delegate: Me3RuntimeAdapter;

  constructor(options: TrustedMe3RuntimeAdapterOptions) {
    this.applicationDataRoot = resolve(options.applicationDataRoot);
    const launchEnvironment = { ...process.env };
    const delegateOptions: Me3RuntimeAdapterOptions = {
      applicationDataRoot: this.applicationDataRoot,
      executablePath: options.executablePath,
      environment: environmentWithoutPath(launchEnvironment),
      processHost: createLaunchEnvironmentProcessHost(options.processHost, launchEnvironment),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.terminateGraceMs === undefined ? {} : { terminateGraceMs: options.terminateGraceMs }),
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
    await ensureTrustedProfileDirectory(this.applicationDataRoot);
    const effectiveOptions: PrepareRuntimeProfileOptions = {
      ...(options ?? {}),
      profileName: options?.profileName ?? makeWorkspaceProfileName(workspace.meta.workspaceId)
    };
    return this.delegate.prepareProfile(workspace, effectiveOptions);
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

async function ensureTrustedProfileDirectory(applicationDataRoot: string): Promise<void> {
  let current = applicationDataRoot;
  for (const segment of ['runtime', 'me3', 'profiles']) {
    const candidate = join(current, segment);
    await assertInsideApplicationData(applicationDataRoot, candidate);
    try {
      await mkdir(candidate);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const info = await stat(candidate);
    if (!info.isDirectory()) {
      throw new Error(`me3 profile path component is not a directory: ${candidate}`);
    }
    await assertInsideApplicationData(applicationDataRoot, candidate);
    current = candidate;
  }
}

async function assertInsideApplicationData(root: string, candidate: string): Promise<void> {
  const boundary = await verifyPathInsideRoot(root, candidate);
  if (!boundary.ok) {
    const reason = boundary.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ');
    throw new Error(`Refusing unsafe me3 profile directory: ${reason}`);
  }
}

function makeWorkspaceProfileName(workspaceId: string): string {
  const workspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
  return `soulforge-${workspaceKey}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}

function environmentWithoutPath(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'path') delete result[key];
  }
  return result;
}

function createLaunchEnvironmentProcessHost(
  injectedHost: RuntimeProcessHost | undefined,
  launchEnvironment: NodeJS.ProcessEnv
): RuntimeProcessHost {
  if (injectedHost) {
    return {
      spawn(command, args, options): RuntimeProcessHandle {
        return injectedHost.spawn(command, args, {
          cwd: options.cwd,
          env: launchEnvironment
        });
      }
    };
  }

  return {
    spawn(command, args, options): RuntimeProcessHandle {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: launchEnvironment,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        onStdout(listener) {
          child.stdout?.on('data', listener);
        },
        onStderr(listener) {
          child.stderr?.on('data', listener);
        },
        onError(listener) {
          child.once('error', listener);
        },
        onExit(listener) {
          child.once('exit', listener);
        },
        kill(signal) {
          return child.kill(signal);
        }
      };
    }
  };
}

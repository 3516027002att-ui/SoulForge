import { constants } from 'node:fs';
import { access, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Diagnostic } from '@soulforge/shared';
import { isPathInside, verifyPathInsideRoot } from '../workspace/pathBoundary.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type {
  GameRuntimeAdapter,
  LaunchRuntimeOptions,
  LaunchSession,
  PrepareRuntimeProfileOptions,
  RuntimeCapability,
  RuntimeDiagnostics,
  RuntimeProcessSnapshot,
  RuntimeProfile
} from './gameRuntimeAdapter.js';

export interface RuntimeProcessHandle {
  readonly pid?: number;
  onStdout(listener: (chunk: Uint8Array | string) => void): void;
  onStderr(listener: (chunk: Uint8Array | string) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface RuntimeProcessHost {
  spawn(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): RuntimeProcessHandle;
}

export interface Me3RuntimeAdapterOptions {
  applicationDataRoot: string;
  executablePath?: string;
  candidateExecutablePaths?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  terminateGraceMs?: number;
  processHost?: RuntimeProcessHost;
  now?: () => Date;
  idFactory?: () => string;
}

const ADAPTER_ID = 'me3';
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;

/**
 * Main-process/core adapter for launching a SoulForge workspace through me3.
 *
 * The adapter writes only a me3 profile into application data. It never writes
 * runtime metadata into the Mod overlay and it never uses a shell to launch me3.
 */
export class Me3RuntimeAdapter implements GameRuntimeAdapter {
  readonly id = ADAPTER_ID;

  private readonly applicationDataRoot: string;
  private readonly configuredExecutablePath: string | undefined;
  private readonly candidateExecutablePaths: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxOutputBytes: number;
  private readonly terminateGraceMs: number;
  private readonly processHost: RuntimeProcessHost;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private detectedExecutablePath?: string;
  private readonly sessions = new WeakSet<Me3LaunchSession>();

  constructor(options: Me3RuntimeAdapterOptions) {
    this.applicationDataRoot = resolve(options.applicationDataRoot);
    this.configuredExecutablePath = options.executablePath ? resolve(options.executablePath) : undefined;
    this.candidateExecutablePaths = options.candidateExecutablePaths ?? [];
    this.environment = options.environment ?? process.env;
    this.maxOutputBytes = Math.max(4_096, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.terminateGraceMs = Math.max(100, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
    this.processHost = options.processHost ?? createNodeRuntimeProcessHost();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? makeRuntimeId;
  }

  async detect(): Promise<RuntimeCapability> {
    const candidates = this.buildExecutableCandidates();
    const failures: Array<{ candidate: string; reason: string }> = [];

    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) {
          failures.push({ candidate, reason: 'not-a-file' });
          continue;
        }
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        const canonicalPath = await realpath(candidate);
        this.detectedExecutablePath = canonicalPath;
        return {
          adapterId: ADAPTER_ID,
          status: 'available',
          executablePath: canonicalPath,
          diagnostics: [{
            severity: 'info',
            code: 'ME3_EXECUTABLE_FOUND_UNVERIFIED',
            message: '已发现 me3 可执行文件；尚未执行真实 Sekiro 启动验证。',
            details: { executablePath: canonicalPath }
          }]
        };
      } catch (error) {
        failures.push({ candidate, reason: errorMessage(error) });
      }
    }

    return {
      adapterId: ADAPTER_ID,
      status: 'unavailable',
      diagnostics: [{
        severity: 'error',
        code: 'ME3_EXECUTABLE_NOT_FOUND',
        message: '未找到 me3 可执行文件。请由 main 进程配置可信路径，或将 me3 加入 PATH。',
        details: {
          candidateCount: candidates.length,
          failures: failures.slice(0, 20),
          failuresTruncated: failures.length > 20
        }
      }]
    };
  }

  async prepareProfile(
    workspace: WorkspaceSession,
    options: PrepareRuntimeProfileOptions = {}
  ): Promise<RuntimeProfile> {
    if (workspace.meta.game !== 'sekiro') {
      throw new Error(`Me3RuntimeAdapter currently accepts only game=sekiro, received ${workspace.meta.game}.`);
    }

    const profileRoot = join(this.applicationDataRoot, 'runtime', 'me3', 'profiles');
    await mkdir(profileRoot, { recursive: true });
    await assertProfileRootOutsideWorkspace(profileRoot, workspace);

    const profileId = sanitizeProfileName(options.profileName ?? `soulforge-${workspace.meta.workspaceId}-${this.idFactory()}`);
    const profilePath = join(profileRoot, `${profileId}.me3`);
    const boundary = await verifyPathInsideRoot(this.applicationDataRoot, profilePath);
    if (!boundary.ok) {
      throw new Error(`Refusing to write me3 profile outside application data: ${formatDiagnostics(boundary.diagnostics)}`);
    }

    const createdAt = this.now().toISOString();
    const content = renderSekiroProfile(workspace.layers.overlayRoot, workspace.meta.workspaceId);
    await writeFileAtomic(profilePath, content);

    return {
      adapterId: ADAPTER_ID,
      profileId,
      profilePath,
      game: 'sekiro',
      workspaceId: workspace.meta.workspaceId,
      overlayRoot: workspace.layers.overlayRoot,
      createdAt,
      ...(options.operationId === undefined ? {} : { operationId: options.operationId })
    };
  }

  async launch(profile: RuntimeProfile, options: LaunchRuntimeOptions = {}): Promise<LaunchSession> {
    if (options.signal?.aborted) throw createAbortError();
    if (profile.adapterId !== ADAPTER_ID) {
      throw new Error(`Profile belongs to adapter ${profile.adapterId}, expected ${ADAPTER_ID}.`);
    }
    await this.assertProfilePath(profile.profilePath);
    const executablePath = await this.requireExecutablePath();
    const extraArgs = validateExtraArgs(options.extraArgs ?? []);
    const args = ['launch', '-p', profile.profilePath, ...extraArgs];
    const processHandle = this.processHost.spawn(executablePath, args, {
      cwd: dirname(profile.profilePath),
      env: this.environment
    });
    const session = new Me3LaunchSession({
      sessionId: this.idFactory(),
      profile,
      processHandle,
      maxOutputBytes: this.maxOutputBytes,
      startedAt: this.now().toISOString(),
      now: this.now
    });

    this.sessions.add(session);

    if (options.signal) {
      if (options.signal.aborted) {
        await this.terminate(session);
      } else {
        options.signal.addEventListener('abort', () => {
          void this.terminate(session);
        }, { once: true });
      }
    }

    return session;
  }

  async collectDiagnostics(session: LaunchSession): Promise<RuntimeDiagnostics> {
    const processSnapshot = session.snapshot();
    const diagnostics: Diagnostic[] = [];

    if (processSnapshot.outputTruncated) {
      diagnostics.push({
        severity: 'warning',
        code: 'ME3_OUTPUT_TRUNCATED',
        message: 'me3 输出超过保留上限，较早内容已被截断。',
        details: { maxOutputBytes: this.maxOutputBytes }
      });
    }
    if (processSnapshot.state === 'failed') {
      diagnostics.push({
        severity: 'error',
        code: 'ME3_PROCESS_FAILED',
        message: 'me3 进程启动或运行失败。',
        details: { stderr: processSnapshot.stderr }
      });
    } else if (processSnapshot.state === 'exited'
      && processSnapshot.exitCode !== undefined
      && processSnapshot.exitCode !== 0) {
      diagnostics.push({
        severity: 'error',
        code: 'ME3_NONZERO_EXIT',
        message: 'me3 进程以非零退出码结束。',
        details: { exitCode: processSnapshot.exitCode, stderr: processSnapshot.stderr }
      });
    } else if (processSnapshot.state === 'running' || processSnapshot.state === 'starting') {
      diagnostics.push({
        severity: 'info',
        code: 'ME3_PROCESS_ACTIVE',
        message: 'me3 启动会话仍在运行。'
      });
    } else if (processSnapshot.state === 'terminated') {
      diagnostics.push({
        severity: 'info',
        code: 'ME3_PROCESS_TERMINATED',
        message: 'me3 启动会话已由 SoulForge 终止。',
        details: { signal: processSnapshot.signal }
      });
    } else if (processSnapshot.state === 'exited' && processSnapshot.signal) {
      diagnostics.push({
        severity: 'warning',
        code: 'ME3_PROCESS_EXITED_BY_SIGNAL',
        message: 'me3 进程因信号退出。',
        details: { signal: processSnapshot.signal }
      });
    } else if (processSnapshot.state === 'exited' && processSnapshot.exitCode === 0) {
      diagnostics.push({
        severity: 'info',
        code: 'ME3_PROCESS_EXITED_ZERO',
        message: 'me3 进程正常退出；这不等于真实 Sekiro Mod 已完成加载验证。'
      });
    }

    return {
      adapterId: ADAPTER_ID,
      sessionId: session.sessionId,
      ...(session.operationId === undefined ? {} : { operationId: session.operationId }),
      profilePath: session.profile.profilePath,
      process: processSnapshot,
      diagnostics
    };
  }

  async terminate(session: LaunchSession): Promise<void> {
    if (!(session instanceof Me3LaunchSession) || !this.sessions.has(session)) {
      throw new Error('Me3RuntimeAdapter can terminate only sessions created by this adapter instance.');
    }
    if (isTerminalState(session.snapshot().state)) return;

    session.requestTermination();
    session.kill('SIGTERM');
    const exited = await waitWithTimeout(session.waitForExit(), this.terminateGraceMs);
    if (exited) return;
    session.kill('SIGKILL');
    const forcedExit = await waitWithTimeout(session.waitForExit(), Math.min(this.terminateGraceMs, 1_000));
    if (!forcedExit) throw new Error('me3 process did not exit after SIGTERM and SIGKILL.');
  }

  private buildExecutableCandidates(): string[] {
    const candidates: string[] = [];
    if (this.configuredExecutablePath) candidates.push(this.configuredExecutablePath);
    for (const candidate of this.candidateExecutablePaths) candidates.push(resolve(candidate));

    const pathValue = this.environment.PATH ?? this.environment.Path ?? this.environment.path;
    if (pathValue) {
      const executableName = process.platform === 'win32' ? 'me3.exe' : 'me3';
      for (const segment of pathValue.split(delimiter)) {
        const trimmed = stripMatchingQuotes(segment.trim());
        if (trimmed.length > 0) candidates.push(resolve(trimmed, executableName));
      }
    }
    return [...new Set(candidates)];
  }

  private async requireExecutablePath(): Promise<string> {
    if (this.detectedExecutablePath) return this.detectedExecutablePath;
    const capability = await this.detect();
    if (capability.status !== 'available' || !capability.executablePath) {
      throw new Error(formatDiagnostics(capability.diagnostics));
    }
    return capability.executablePath;
  }

  private async assertProfilePath(profilePath: string): Promise<void> {
    const boundary = await verifyPathInsideRoot(this.applicationDataRoot, profilePath);
    if (!boundary.ok) {
      throw new Error(`Invalid me3 profile path: ${formatDiagnostics(boundary.diagnostics)}`);
    }
    const info = await stat(profilePath);
    if (!info.isFile()) throw new Error(`me3 profile is not a file: ${profilePath}`);
  }
}

interface Me3LaunchSessionOptions {
  sessionId: string;
  profile: RuntimeProfile;
  processHandle: RuntimeProcessHandle;
  maxOutputBytes: number;
  startedAt: string;
  now: () => Date;
}

class Me3LaunchSession implements LaunchSession {
  readonly adapterId = ADAPTER_ID;
  readonly sessionId: string;
  readonly profile: RuntimeProfile;
  readonly operationId: string | undefined;

  private readonly processHandle: RuntimeProcessHandle;
  private readonly stdout: BoundedTextBuffer;
  private readonly stderr: BoundedTextBuffer;
  private readonly now: () => Date;
  private readonly done: Promise<RuntimeProcessSnapshot>;
  private resolveDone!: (snapshot: RuntimeProcessSnapshot) => void;
  private state: RuntimeProcessSnapshot['state'] = 'starting';
  private readonly startedAt: string;
  private exitedAt?: string;
  private exitCode?: number;
  private exitSignal?: NodeJS.Signals;
  private settled = false;
  private terminationRequested = false;

  constructor(options: Me3LaunchSessionOptions) {
    this.sessionId = options.sessionId;
    this.profile = options.profile;
    this.operationId = options.profile.operationId;
    this.processHandle = options.processHandle;
    this.stdout = new BoundedTextBuffer(options.maxOutputBytes);
    this.stderr = new BoundedTextBuffer(options.maxOutputBytes);
    this.startedAt = options.startedAt;
    this.now = options.now;
    this.done = new Promise<RuntimeProcessSnapshot>((resolveDone) => {
      this.resolveDone = resolveDone;
    });

    this.processHandle.onStdout((chunk) => this.stdout.append(chunk));
    this.processHandle.onStderr((chunk) => this.stderr.append(chunk));
    this.processHandle.onError((error) => {
      this.stderr.append(error.message);
      this.finish('failed');
    });
    this.processHandle.onExit((code, signal) => {
      if (code !== null) this.exitCode = code;
      if (signal !== null) this.exitSignal = signal;
      this.finish(this.terminationRequested ? 'terminated' : 'exited');
    });
    this.state = 'running';
  }

  snapshot(): RuntimeProcessSnapshot {
    return {
      ...(this.processHandle.pid === undefined ? {} : { pid: this.processHandle.pid }),
      state: this.state,
      startedAt: this.startedAt,
      ...(this.exitedAt === undefined ? {} : { exitedAt: this.exitedAt }),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.exitSignal === undefined ? {} : { signal: this.exitSignal }),
      stdout: this.stdout.toString(),
      stderr: this.stderr.toString(),
      outputTruncated: this.stdout.truncated || this.stderr.truncated
    };
  }

  waitForExit(): Promise<RuntimeProcessSnapshot> {
    return this.done;
  }

  requestTermination(): void {
    this.terminationRequested = true;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.processHandle.kill(signal);
  }

  private finish(state: RuntimeProcessSnapshot['state']): void {
    if (this.settled) return;
    this.settled = true;
    this.state = state;
    this.exitedAt = this.now().toISOString();
    this.resolveDone(this.snapshot());
  }
}

class BoundedTextBuffer {
  private value = '';
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array | string): void {
    this.value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const buffer = Buffer.from(this.value, 'utf8');
    if (buffer.byteLength <= this.maxBytes) return;
    this.value = buffer.subarray(buffer.byteLength - this.maxBytes).toString('utf8');
    this.truncated = true;
  }

  toString(): string {
    return this.value;
  }
}

function createNodeRuntimeProcessHost(): RuntimeProcessHost {
  return {
    spawn(command, args, options): RuntimeProcessHandle {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
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

function renderSekiroProfile(overlayRoot: string, workspaceId: string): string {
  const portableOverlayPath = resolve(overlayRoot).replaceAll('\\', '/');
  return [
    'profileVersion = "v1"',
    '',
    '[[supports]]',
    'game = "sekiro"',
    '',
    '[[packages]]',
    `id = ${JSON.stringify(`soulforge-${workspaceId}`)}`,
    `path = ${JSON.stringify(portableOverlayPath)}`,
    ''
  ].join('\n');
}

async function assertProfileRootOutsideWorkspace(profileRoot: string, workspace: WorkspaceSession): Promise<void> {
  const canonicalProfileRoot = await realpath(profileRoot);
  const canonicalOverlayRoot = await realpath(workspace.layers.overlayRoot);
  if (isPathInside(canonicalOverlayRoot, canonicalProfileRoot)) {
    throw new Error('me3 runtime profiles must not be stored inside the Mod overlay.');
  }
  if (workspace.layers.baseRoot) {
    const canonicalBaseRoot = await realpath(workspace.layers.baseRoot);
    if (isPathInside(canonicalBaseRoot, canonicalProfileRoot)) {
      throw new Error('me3 runtime profiles must not be stored inside the read-only base game directory.');
    }
  }
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function validateExtraArgs(args: readonly string[]): string[] {
  const reserved = new Set(['launch', '-p', '--profile']);
  for (const arg of args) {
    if (reserved.has(arg) || arg.startsWith('--profile=') || arg.startsWith('-p=')) {
      throw new Error(`Reserved me3 argument cannot be overridden: ${arg}`);
    }
    if (arg.includes('\0')) throw new Error('me3 arguments must not contain NUL bytes.');
  }
  return [...args];
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

function createAbortError(): Error {
  const error = new Error('me3 launch aborted before process start.');
  error.name = 'AbortError';
  return error;
}

function sanitizeProfileName(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) throw new Error('me3 profile name is empty after sanitization.');
  return sanitized.slice(0, 120);
}

function isTerminalState(state: RuntimeProcessSnapshot['state']): boolean {
  return state === 'exited' || state === 'failed' || state === 'terminated';
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ');
}

function makeRuntimeId(): string {
  return `runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

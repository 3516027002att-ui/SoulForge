import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { BlenderJobManifest, BlenderJobState, BlenderResultManifest } from '@soulforge/shared';
import { validateBlenderJobManifest, validateBlenderResultManifest } from '@soulforge/shared';

export interface BlenderProcessLike {
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  once(event: 'close' | 'error', listener: (value: number | Error | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type BlenderSpawn = (file: string, args: readonly string[], options: { cwd: string; shell: false; stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }) => BlenderProcessLike;

export interface BlenderJobRequest {
  manifest: BlenderJobManifest;
  trustedBlenderPath: string;
  trustedAdapterPath: string;
  trustedManifestPath: string;
  stagingRoot: string;
  resultManifestPath?: string;
  approvedEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface BlenderJobResult {
  jobId: string;
  state: BlenderJobState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ code: string; message: string }>;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE = 8;

export function buildBlenderInvocation(input: Pick<BlenderJobRequest, 'trustedBlenderPath' | 'trustedAdapterPath' | 'trustedManifestPath'>): { file: string; args: string[] } {
  if (!isAbsolute(input.trustedBlenderPath) || !isAbsolute(input.trustedAdapterPath) || !isAbsolute(input.trustedManifestPath)) throw new Error('BLENDER_TRUSTED_PATH_REQUIRED');
  return {
    file: input.trustedBlenderPath,
    args: ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', input.trustedAdapterPath, '--', '--job', input.trustedManifestPath]
  };
}

export class BlenderJobService {
  private readonly queue: Array<{ request: BlenderJobRequest; resolve: (result: BlenderJobResult) => void }> = [];
  private active = false;

  constructor(private readonly spawn: BlenderSpawn = ((file, args, options) => nodeSpawn(file, [...args], options))) {}

  submit(request: BlenderJobRequest): Promise<BlenderJobResult> {
    validateBlenderJobManifest(request.manifest);
    if (this.queue.length >= MAX_QUEUE) return Promise.resolve(failed(request.manifest.jobId, 'BLENDER_QUEUE_FULL', 'Blender job queue is full.'));
    if (request.signal?.aborted) return Promise.resolve({ jobId: request.manifest.jobId, state: 'cancelled', exitCode: null, stdout: '', stderr: '', diagnostics: [{ code: 'BLENDER_CANCELLED_BEFORE_START', message: 'Job was cancelled before start.' }] });
    return new Promise((resolveResult) => {
      this.queue.push({ request, resolve: resolveResult });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = true;
    try { next.resolve(await this.run(next.request)); } finally { this.active = false; void this.drain(); }
  }

  private async run(request: BlenderJobRequest): Promise<BlenderJobResult> {
    const diagnostics: BlenderJobResult['diagnostics'] = [];
    const invocation = buildBlenderInvocation(request);
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      return next.length <= MAX_LOG_BYTES ? next : next.slice(next.length - MAX_LOG_BYTES);
    };
    let state: BlenderJobState = 'starting';
    let child: BlenderProcessLike;
    try {
      child = this.spawn(invocation.file, invocation.args, {
        cwd: request.stagingRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(request.approvedEnvironment ?? {}) }
      });
    } catch (error) {
      return failed(request.manifest.jobId, 'BLENDER_SPAWN_FAILED', error instanceof Error ? error.message : String(error));
    }
    state = 'running';
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const closePromise = new Promise<number | null>((resolveClose) => {
      child.once('error', (error) => {
        diagnostics.push({ code: 'BLENDER_PROCESS_ERROR', message: error instanceof Error ? error.message : String(error) });
        resolveClose(null);
      });
      child.once('close', (code) => resolveClose(typeof code === 'number' ? code : null));
    });
    const timeoutMs = Math.max(1, request.manifest.deadlineAt - Date.now());
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    const abortHandler = () => { cancelled = true; child.kill('SIGTERM'); };
    request.signal?.addEventListener('abort', abortHandler, { once: true });
    const exitCode = await closePromise;
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abortHandler);
    if (timedOut) return { jobId: request.manifest.jobId, state: 'timed_out', exitCode, stdout, stderr, diagnostics: [...diagnostics, { code: 'BLENDER_TIMEOUT', message: 'Blender job exceeded deadline.' }] };
    if (cancelled) return { jobId: request.manifest.jobId, state: 'cancelled', exitCode, stdout, stderr, diagnostics: [...diagnostics, { code: 'BLENDER_CANCELLED', message: 'Blender job cancelled.' }] };
    if (exitCode !== 0) return { jobId: request.manifest.jobId, state: 'failed', exitCode, stdout, stderr, diagnostics: [...diagnostics, { code: 'BLENDER_EXIT_NONZERO', message: `Blender exited with code ${exitCode ?? 'unknown'}.` }] };
    state = 'exit_observed';
    if (!request.resultManifestPath) return { jobId: request.manifest.jobId, state, exitCode, stdout, stderr, diagnostics: [{ code: 'BLENDER_RESULT_MANIFEST_MISSING', message: 'exit 0 is not a staged result without result manifest.' }] };
    try {
      const resultPath = safePath(request.stagingRoot, request.resultManifestPath);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as BlenderResultManifest;
      validateBlenderResultManifest(result, request.manifest);
      await validateOutputFiles(request.stagingRoot, result, request.manifest.maxOutputBytes);
      state = 'artifact_validated';
      state = 'staged';
      settled = true;
      return { jobId: request.manifest.jobId, state, exitCode, stdout, stderr, diagnostics };
    } catch (error) {
      return { jobId: request.manifest.jobId, state: 'failed', exitCode, stdout, stderr, diagnostics: [...diagnostics, { code: 'BLENDER_ARTIFACT_INVALID', message: error instanceof Error ? error.message : String(error) }] };
    } finally {
      void settled;
    }
  }
}

async function validateOutputFiles(root: string, result: BlenderResultManifest, maxBytes: number): Promise<void> {
  let total = 0;
  for (const output of result.outputs) {
    const outputPath = safePath(root, output.relativePath);
    const information = await stat(outputPath);
    if (!information.isFile()) throw new Error('BLENDER_OUTPUT_NOT_FILE');
    if (information.size !== output.byteLength) throw new Error('BLENDER_OUTPUT_SIZE_MISMATCH');
    total += information.size;
    if (total > maxBytes) throw new Error('BLENDER_OUTPUT_BUDGET_EXCEEDED');
    const hash = createHash('sha256').update(await readFile(outputPath)).digest('hex');
    if (hash !== output.sha256) throw new Error('BLENDER_OUTPUT_HASH_MISMATCH');
  }
}

function safePath(root: string, candidate: string): string {
  if (isAbsolute(candidate) || candidate.includes('..')) throw new Error('BLENDER_PATH_TRAVERSAL');
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidate);
  const escaped = relative(resolvedRoot, resolvedCandidate).startsWith('..');
  if (escaped) throw new Error('BLENDER_PATH_TRAVERSAL');
  return resolvedCandidate;
}

function failed(jobId: string, code: string, message: string): BlenderJobResult {
  return { jobId, state: 'failed', exitCode: null, stdout: '', stderr: '', diagnostics: [{ code, message }] };
}

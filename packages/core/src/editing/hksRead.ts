/**
 * Read one standalone Lua/HKS source file.
 *
 * This facade deliberately has no write side effect.  A `.hks`/`.lua` file
 * found by the workspace index is either decoded as plaintext (with the
 * existing plaintext classifier/encoder) or handed to the first-party Bridge
 * HKS reader when its real bytes carry the Lua bytecode signature.  BND/EMEVD
 * containers are not accepted here; their container-specific readers remain
 * separate tools.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import {
  classifyPlaintextBytes,
  decodePlaintext,
  encodePlaintext,
  type PlaintextEncoding
} from '../script/plaintextScriptEntry.js';
import type { NativeEditSession } from './nativeEditSession.js';
import { verifyPathInsideRoot, isPathInside } from '../workspace/pathBoundary.js';
import { makeFileResourceUri, toPosixPath } from '../workspace/resourceUri.js';

/** Maximum standalone source payload accepted by this read-only facade. */
export const HKS_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
// Native HKS decompilation is a semantic read rather than a bounded catalog
// probe; keep the same two-minute default used by the existing native read
// facades while still allowing the host to pass a shorter deadline.
export const HKS_DEFAULT_TIMEOUT_MS = 120_000;

export type HksSourceRepresentation = 'plaintext' | 'bytecode';

export interface HksNativeReadRequest {
  filePath: string;
  resourceUri: string;
  allowedRoots: string[];
  workspaceSessionId?: string;
  oodleRuntimeRoot?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Exact bytes classified by this helper, encoded for the Bridge request. */
  contentBase64: string;
}

export interface HksNativeReadResponse {
  data?: unknown;
  /** BridgeResult contract: read-hks-source is `ok` or `failed`, never a partial page. */
  parseStatus: string;
  diagnostics?: readonly (Diagnostic | StructuredDiagnostic)[];
}

/** Dependency-injection seam for tests; production delegates to runBridge. */
export type HksNativeReader = (
  request: HksNativeReadRequest
) => Promise<HksNativeReadResponse>;

export interface HksSourceReadSuccess {
  ok: true;
  /** Canonical logical URI, e.g. `file://action/script/c0000.hks`. */
  sourceUri: string;
  /** Alias consumed by source-window projections; equal to sourceUri. */
  logicalSource: string;
  /** Absolute path is core-side evidence only; renderer projections must omit it. */
  sourcePath: string;
  relativePath: string;
  logicalName: string;
  sourceHash: string;
  sourceText: string;
  representation: HksSourceRepresentation;
  encoding: PlaintextEncoding | 'utf8';
  diagnostics: StructuredDiagnostic[];
}

export interface HksSourceReadFailure {
  ok: false;
  code: string;
  message: string;
  sourceUri?: string;
  sourcePath?: string;
  diagnostics: StructuredDiagnostic[];
}

export type HksSourceReadResult = HksSourceReadSuccess | HksSourceReadFailure;

export interface ReadHksSourceInput {
  edit: NativeEditSession;
  /** Absolute or overlay-relative path. The registry resolves indexed tokens before calling. */
  file: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  nativeReader?: HksNativeReader;
}

interface ResolvedHksSource {
  filePath: string;
  sourceUri: string;
  relativePath: string;
  logicalName: string;
  allowedRoots: string[];
}

interface ReadControl {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeTimeout(timeoutMs: number | undefined): number | HksSourceReadFailure {
  const value = timeoutMs ?? HKS_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return failure('HKS_TIMEOUT_INVALID', 'HKS 源码读取 timeoutMs 必须是正的安全整数。');
  }
  return value;
}

function createReadControl(input: ReadHksSourceInput, timeoutMs: number): ReadControl {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(input.signal?.reason);
  };
  if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(new Error('HKS_READ_TIMEOUT'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/** Race an fs/Bridge operation with the single request-scoped cancellation signal. */
function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('HKS_READ_CANCELLED'));
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason ?? new Error('HKS_READ_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      }
    );
  });
}

function normalizeDiagnostics(
  diagnostics: readonly (Diagnostic | StructuredDiagnostic)[] | undefined
): StructuredDiagnostic[] {
  return (diagnostics ?? []).map((item) => {
    const value = item as StructuredDiagnostic & { targetUri?: string; recordedAt?: string };
    return {
      severity: value.severity,
      code: value.code,
      message: value.message,
      ...(value.targetUri !== undefined ? { targetUri: value.targetUri } : {}),
      ...(value.sourceUri !== undefined ? { sourceUri: value.sourceUri } : {}),
      ...(value.provenance !== undefined ? { provenance: value.provenance } : {}),
      ...(value.confidence !== undefined ? { confidence: value.confidence } : {}),
      ...(value.details !== undefined ? { details: value.details } : {}),
      ...(value.recordedAt !== undefined ? { recordedAt: value.recordedAt } : {})
    };
  });
}

function failure(
  code: string,
  message: string,
  extra: {
    sourceUri?: string;
    sourcePath?: string;
    diagnostics?: readonly StructuredDiagnostic[];
    details?: unknown;
  } = {}
): HksSourceReadFailure {
  const diagnostic = createDiagnostic({
    severity: 'error',
    code,
    message,
    ...(extra.sourceUri ? { sourceUri: extra.sourceUri } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {})
  });
  return {
    ok: false,
    code,
    message,
    ...(extra.sourceUri ? { sourceUri: extra.sourceUri } : {}),
    ...(extra.sourcePath ? { sourcePath: extra.sourcePath } : {}),
    diagnostics: [...(extra.diagnostics ?? []), diagnostic]
  };
}

function sourceFailureFromError(
  error: unknown,
  control: ReadControl,
  resolved?: ResolvedHksSource
): HksSourceReadFailure {
  const source = resolved
    ? { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath }
    : {};
  if (control.timedOut()) {
    return failure('HKS_READ_TIMEOUT', 'HKS 源码读取超时，未返回可用源码。', source);
  }
  if (control.signal.aborted) {
    return failure('HKS_READ_CANCELLED', 'HKS 源码读取已取消，未返回可用源码。', source);
  }
  const errorCode = errorCodeOf(error);
  if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
    return failure('HKS_SOURCE_NOT_FOUND', '找不到已解析的独立 HKS/Lua 源文件。', source);
  }
  return failure(
    'HKS_READ_FAILED',
    error instanceof Error ? error.message : '读取独立 HKS/Lua 源文件失败。',
    { ...source, details: { error: error instanceof Error ? error.message : String(error) } }
  );
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function pathFromToken(file: string): string {
  if (/^file:/iu.test(file)) {
    try {
      return fileURLToPath(file);
    } catch {
      // Let the overlay boundary produce a structured rejection for logical
      // URI tokens that are not local file URLs.
      return file;
    }
  }
  return file;
}

function standaloneExtension(pathValue: string): boolean {
  const extension = extname(pathValue).toLocaleLowerCase();
  return extension === '.hks' || extension === '.lua';
}

function boundaryDiagnostics(result: Awaited<ReturnType<typeof verifyPathInsideRoot>>): StructuredDiagnostic[] {
  return normalizeDiagnostics(result.diagnostics);
}

async function resolveSourcePath(
  input: ReadHksSourceInput,
  control: ReadControl
): Promise<ResolvedHksSource | HksSourceReadFailure> {
  const overlayRoot = resolve(input.edit.session.layers.overlayRoot);
  const token = pathFromToken(input.file.trim());
  const candidate = isAbsolute(token) ? resolve(token) : resolve(overlayRoot, token);

  // The root resolver is responsible for mapping an indexed source to the
  // current overlay. This helper repeats the overlay boundary check so a
  // direct caller cannot turn it into a base/container reader.
  if (!isPathInside(overlayRoot, candidate)) {
    return failure(
      'HKS_SOURCE_OUTSIDE_OVERLAY',
      '独立 HKS/Lua 源文件必须位于当前打开工作区 overlay 内。',
      { details: { candidate } }
    );
  }

  const overlayBoundary = await raceWithSignal(
    verifyPathInsideRoot(overlayRoot, candidate),
    control.signal
  );
  if (!overlayBoundary.ok) {
    return failure(
      'HKS_PATH_ESCAPE',
      '独立 HKS/Lua 路径经过了允许根目录之外的链接或联接点。',
      { diagnostics: boundaryDiagnostics(overlayBoundary), details: overlayBoundary }
    );
  }

  let allowedRoots: string[];
  try {
    allowedRoots = [...new Set(input.edit.allowedRoots().filter((root) => root.length > 0).map((root) => resolve(root)))];
  } catch (error) {
    return failure(
      'HKS_ALLOWED_ROOTS_UNAVAILABLE',
      '无法取得当前会话的 native allowedRoots，拒绝读取独立源码。',
      { details: { error: error instanceof Error ? error.message : String(error) } }
    );
  }
  if (allowedRoots.length === 0) {
    return failure('HKS_ALLOWED_ROOTS_REQUIRED', '当前会话没有提供 native allowedRoots，拒绝读取独立源码。');
  }

  let allowed = false;
  let lastBoundary: Awaited<ReturnType<typeof verifyPathInsideRoot>> | undefined;
  for (const root of allowedRoots) {
    const boundary = await raceWithSignal(verifyPathInsideRoot(root, candidate), control.signal);
    lastBoundary = boundary;
    if (boundary.ok) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    return failure(
      'HKS_PATH_NOT_ALLOWED',
      '独立 HKS/Lua 源文件不在当前会话的 native allowedRoots 内。',
      { diagnostics: lastBoundary ? boundaryDiagnostics(lastBoundary) : [] }
    );
  }

  const physicalPath = await raceWithSignal(realpath(candidate), control.signal);
  const physicalOverlay = await raceWithSignal(realpath(overlayRoot), control.signal);
  if (!isPathInside(physicalOverlay, physicalPath)) {
    return failure(
      'HKS_PATH_ESCAPE',
      '独立 HKS/Lua 源文件的真实路径逃出了当前 overlay。',
      { details: { candidate, physicalPath, physicalOverlay } }
    );
  }

  if (!standaloneExtension(candidate) || !standaloneExtension(physicalPath)) {
    return failure(
      'HKS_STANDALONE_EXTENSION_REQUIRED',
      '该读取器只接受独立 .hks 或 .lua 文件；BND/DCX/EMEVD 容器必须使用对应容器工具。'
    );
  }

  const fileStat = await raceWithSignal(stat(physicalPath), control.signal);
  if (!fileStat.isFile()) {
    return failure('HKS_SOURCE_NOT_FILE', '目标独立 HKS/Lua 路径不是普通文件。');
  }
  if (fileStat.size > HKS_MAX_SOURCE_BYTES) {
    return failure(
      'HKS_SOURCE_TOO_LARGE',
      `独立 HKS/Lua 源文件超过 ${HKS_MAX_SOURCE_BYTES} 字节上限，拒绝加载完整源码。`,
      { details: { size: fileStat.size, maxBytes: HKS_MAX_SOURCE_BYTES } }
    );
  }

  // Preserve the indexed/logical overlay spelling (including a selected
  // alias) while using the real path for the actual read and sourcePath
  // evidence. This keeps the returned sourceUri stable for the registry's
  // index identity and still prevents a reparse-point escape.
  const relativePath = toPosixPath(relative(overlayRoot, candidate));
  return {
    filePath: physicalPath,
    relativePath,
    sourceUri: makeFileResourceUri(relativePath),
    logicalName: basename(candidate),
    allowedRoots
  };
}

const defaultNativeReader: HksNativeReader = async (request) => {
  const result = await runBridge<Record<string, unknown>>({
    command: 'read-hks-source',
    filePath: request.filePath,
    resourceUri: request.resourceUri,
    allowedRoots: request.allowedRoots,
    ...(request.workspaceSessionId ? { workspaceSessionId: request.workspaceSessionId } : {}),
    ...(request.oodleRuntimeRoot ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    commandOptions: { contentBase64: request.contentBase64 },
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    // A 16 MiB input can produce a decompiled source larger than the default
    // frame. runBridge still owns its file-backed result protocol; this only
    // prevents the request envelope from being capped at 16 MiB.
    maxFrameBytes: 32 * 1024 * 1024
  });
  return {
    data: result.data,
    parseStatus: result.parseStatus,
    diagnostics: result.diagnostics
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

async function readBytecodeSource(
  input: ReadHksSourceInput,
  control: ReadControl,
  resolved: ResolvedHksSource,
  bytes: Uint8Array,
  sourceHash: string
): Promise<HksSourceReadResult> {
  const nativeReader = input.nativeReader ?? defaultNativeReader;
  const native = await raceWithSignal(nativeReader({
    filePath: resolved.filePath,
    resourceUri: resolved.sourceUri,
    allowedRoots: resolved.allowedRoots,
    workspaceSessionId: input.edit.session.meta.workspaceId,
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    timeoutMs: input.timeoutMs ?? HKS_DEFAULT_TIMEOUT_MS,
    signal: control.signal,
    contentBase64: Buffer.from(bytes).toString('base64')
  }), control.signal);
  const diagnostics = normalizeDiagnostics(native.diagnostics);
  const data = asRecord(native.data);
  if (native.parseStatus === 'failed' || !data) {
    const primary = diagnostics.find((item) => item.severity === 'error');
    return failure(
      primary?.code ? String(primary.code) : 'HKS_NATIVE_READ_FAILED',
      primary?.message ?? 'first-party Bridge 未能读取独立 HKS/Lua 字节码。',
      { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath, diagnostics }
    );
  }
  // The Bridge HKS command returns BridgeResult.Ok only after the decompiler
  // has produced its complete sourceText.  A partial/unsupported/truncated
  // native envelope must never be exposed to sourceTextPage as if it were the
  // whole file: cursor pagination would otherwise make a missing tail look
  // like an authoritative end of source.
  const explicitIncomplete = native.parseStatus !== 'ok'
    || data.sourceTextComplete === false
    || data.sourceTextTruncated === true
    || data.truncated === true
    || data.complete === false;
  if (explicitIncomplete) {
    return failure(
      'HKS_NATIVE_SOURCE_INCOMPLETE',
      'first-party Bridge 返回的 HKS 源码声明为 partial/truncated，拒绝作为完整源码分页。',
      {
        sourceUri: resolved.sourceUri,
        sourcePath: resolved.filePath,
        diagnostics,
        details: {
          parseStatus: native.parseStatus,
          sourceTextComplete: data.sourceTextComplete,
          sourceTextTruncated: data.sourceTextTruncated,
          truncated: data.truncated,
          complete: data.complete
        }
      }
    );
  }
  if (diagnostics.some((item) => item.severity === 'error')) {
    const primary = diagnostics.find((item) => item.severity === 'error')!;
    return failure(
      String(primary.code),
      primary.message,
      { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath, diagnostics }
    );
  }
  const sourceText = data.sourceText;
  const nativeSourceHash = data.sourceHash;
  if (typeof sourceText !== 'string') {
    return failure(
      'HKS_SOURCE_TEXT_MISSING',
      'first-party Bridge 返回的 HKS 结果没有完整 sourceText。',
      { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath, diagnostics }
    );
  }
  if (typeof nativeSourceHash !== 'string' || nativeSourceHash.length === 0) {
    return failure(
      'HKS_SOURCE_HASH_MISSING',
      'first-party Bridge 返回的 HKS 结果没有 sourceHash，拒绝把源码当作稳定读取。',
      { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath, diagnostics }
    );
  }
  return {
    ok: true,
    sourceUri: resolved.sourceUri,
    logicalSource: resolved.sourceUri,
    sourcePath: resolved.filePath,
    relativePath: resolved.relativePath,
    logicalName: resolved.logicalName,
    sourceHash: nativeSourceHash,
    sourceText,
    representation: 'bytecode',
    encoding: 'utf8',
    diagnostics: [
      ...diagnostics,
      createDiagnostic({
        severity: 'info',
        code: 'HKS_NATIVE_SOURCE_READ',
        message: '独立 HKS/Lua 字节码已由 first-party Bridge 读取为源码。',
        sourceUri: resolved.sourceUri,
        details: { sourceHash, nativeSourceHash }
      })
    ]
  };
}

export async function readHksSource(input: ReadHksSourceInput): Promise<HksSourceReadResult> {
  const timeout = normalizeTimeout(input.timeoutMs);
  if (typeof timeout !== 'number') return timeout;
  if (input.signal?.aborted) return failure('HKS_READ_CANCELLED', 'HKS 源码读取已取消，未返回可用源码。');

  const control = createReadControl(input, timeout);
  let resolved: ResolvedHksSource | undefined;
  try {
    const pathResult = await resolveSourcePath(input, control);
    if (!('filePath' in pathResult)) return pathResult;
    resolved = pathResult;
    if (control.signal.aborted) {
      return sourceFailureFromError(control.signal.reason, control, resolved);
    }

    const bytes = await raceWithSignal(readFile(resolved.filePath, { signal: control.signal }), control.signal);
    if (bytes.byteLength > HKS_MAX_SOURCE_BYTES) {
      return failure(
        'HKS_SOURCE_TOO_LARGE',
        `独立 HKS/Lua 源文件超过 ${HKS_MAX_SOURCE_BYTES} 字节上限，拒绝加载完整源码。`,
        { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath }
      );
    }
    const sourceHash = sha256(bytes);
    const verdict = classifyPlaintextBytes(bytes);
    if (control.signal.aborted) return sourceFailureFromError(control.signal.reason, control, resolved);

    if (!verdict.isPlaintext) {
      if (control.signal.aborted) return sourceFailureFromError(control.signal.reason, control, resolved);
      if (verdict.luaBytecodeMagic) {
        return await readBytecodeSource(input, control, resolved, bytes, sourceHash);
      }
      return failure(
        'HKS_UNKNOWN_BINARY',
        '独立 .hks/.lua 文件既不是可严格往返的明文，也没有 Lua/HKS 字节码签名；拒绝猜测其格式。',
        { sourceUri: resolved.sourceUri, sourcePath: resolved.filePath, diagnostics: verdict.diagnostics }
      );
    }

    const contentBytes = verdict.trailingPaddingBytes > 0
      ? bytes.subarray(0, bytes.length - verdict.trailingPaddingBytes)
      : bytes;
    let sourceText: string;
    try {
      sourceText = decodePlaintext(contentBytes, verdict.detectedEncoding);
    } catch (error) {
      return failure(
        'HKS_PLAINTEXT_DECODE_FAILED',
        '独立明文脚本无法按检测到的编码解码。',
        {
          sourceUri: resolved.sourceUri,
          sourcePath: resolved.filePath,
          diagnostics: verdict.diagnostics,
          details: { error: error instanceof Error ? error.message : String(error) }
        }
      );
    }
    const encoded = encodePlaintext(sourceText, verdict.detectedEncoding);
    if (!encoded.ok || !bytesEqual(encoded.bytes, contentBytes)) {
      const encoderDiagnostics = encoded.ok ? [] : normalizeDiagnostics(encoded.diagnostics);
      return failure(
        'HKS_PLAINTEXT_ROUND_TRIP_FAILED',
        '独立明文脚本的 decode→encode 不能逐字节还原；拒绝返回可能已损坏的源码。',
        {
          sourceUri: resolved.sourceUri,
          sourcePath: resolved.filePath,
          diagnostics: [...verdict.diagnostics, ...encoderDiagnostics],
          details: {
            encoding: verdict.detectedEncoding,
            encodedBytes: encoded.ok ? encoded.bytes.length : undefined,
            originalBytes: contentBytes.length,
            encoderCode: encoded.ok ? undefined : encoded.code
          }
        }
      );
    }
    if (control.signal.aborted) return sourceFailureFromError(control.signal.reason, control, resolved);

    return {
      ok: true,
      sourceUri: resolved.sourceUri,
      logicalSource: resolved.sourceUri,
      sourcePath: resolved.filePath,
      relativePath: resolved.relativePath,
      logicalName: resolved.logicalName,
      sourceHash,
      sourceText,
      representation: 'plaintext',
      encoding: verdict.detectedEncoding,
      diagnostics: [
        ...verdict.diagnostics,
        createDiagnostic({
          severity: 'info',
          code: 'HKS_PLAINTEXT_SOURCE_READ',
          message: '独立 HKS/Lua 明文已按检测到的编码严格往返验证后读取。',
          sourceUri: resolved.sourceUri,
          details: { encoding: verdict.detectedEncoding, sourceHash }
        })
      ]
    };
  } catch (error) {
    return sourceFailureFromError(error, control, resolved);
  } finally {
    control.dispose();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

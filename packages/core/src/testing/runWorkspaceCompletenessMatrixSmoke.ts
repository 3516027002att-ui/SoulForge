/**
 * 工作区完成度矩阵 L1+L2a：对 mods 里每一个索引文件问「后端能不能打开」。
 *
 * 禁止抽样。失败按文件记账。没有 parser / HKX 裁定挡住的记 blocked，
 * 不把它们算成通过，也不把它们当成解析失败。
 *
 * 大文件（≥32MB）只跑容器目录 / DCX 文档头，不解整包载荷。
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { disposeBridgeDaemonPool, runBridge, type BridgeCommand } from '../bridge/runBridge.js';
import { readFmgDocumentViaBridge } from '../editing/fmgBridgeCommit.js';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import { buildScriptContainerEvidence } from '../script/scriptContainerEvidence.js';
import { classifyPlaintextBytes, decodePlaintext } from '../script/plaintextScriptEntry.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { classifyNativeRead, summarizeNativeReads, verifyFileCoverage, type NativeReadStatus } from '../../../../scripts/native-read-acceptance.mjs';
import {
  classifyWorkspaceOpen,
  isSemanticOpenKind,
  type WorkspaceOpenKind
} from '@soulforge/shared';

const FILE_TIMEOUT_MS = 30_000;
const LARGE_FILE_BYTES = 32 * 1024 * 1024;

interface FileResult {
  relativePath: string;
  familyId: string;
  openKind: WorkspaceOpenKind;
  size: number;
  status: 'opened' | 'opened-list-only' | 'history' | 'blocked-no-parser' | 'blocked-scope' | 'binary' | 'unavailable' | 'failed' | 'timed-out';
  detail?: string;
}

interface HksReadData {
  sourceText?: string;
  sourceHash?: string;
  format?: string;
  dialect?: string;
}

interface HksReadReceipt {
  parseStatus: string;
  data?: HksReadData | null;
  diagnostics?: Array<{ code?: string; message?: string; severity?: string }>;
}

interface StandaloneScriptReadOptions {
  absolutePath: string;
  allowedRoots: string[];
  oodleRuntimeRoot?: string;
}

interface StandaloneScriptProbeDependencies {
  getFileSize?: (path: string) => Promise<number>;
  readBytes?: (path: string) => Promise<Uint8Array>;
  runHksSource?: (options: {
    command: 'read-hks-source';
    filePath: string;
    allowedRoots: string[];
    oodleRuntimeRoot?: string;
    commandOptions: Record<string, never>;
    timeoutMs: number;
    maxFrameBytes: number;
  }) => Promise<HksReadReceipt>;
}

/**
 * Mirror the standalone branch of `readScriptSource`: classify real bytes,
 * decode confirmed plaintext through the existing helper, and send bytecode
 * to the first-party native HKS reader. This is a reader-path probe, not a
 * second parser or a BND4 child projection.
 */
export async function probeStandaloneScriptFile(
  options: StandaloneScriptReadOptions,
  dependencies: StandaloneScriptProbeDependencies = {}
): Promise<{ status: 'opened' | 'failed' | 'unavailable'; detail: string }> {
  const getFileSize = dependencies.getFileSize ?? (async (path: string) => (await stat(path)).size);
  const readBytes = dependencies.readBytes ?? (async (path: string) => await readFile(path));
  const runHksSource = dependencies.runHksSource ?? ((input) => runBridge<HksReadData>(input));
  const maxScriptBytes = 64 * 1024 * 1024;
  const sourceSize = await getFileSize(options.absolutePath);
  if (sourceSize > maxScriptBytes) {
    return { status: 'failed', detail: 'SCRIPT_SOURCE_TOO_LARGE: 脚本文件超过 64 MiB 有界读取上限，未打开。' };
  }

  const bytes = await readBytes(options.absolutePath);
  if (bytes.length > maxScriptBytes) {
    return { status: 'failed', detail: 'SCRIPT_SOURCE_TOO_LARGE: 脚本文件超过 64 MiB 有界读取上限，未打开。' };
  }
  const verdict = classifyPlaintextBytes(bytes);
  if (verdict.isPlaintext) {
    const contentEnd = bytes.length - verdict.trailingPaddingBytes;
    decodePlaintext(bytes.subarray(0, contentEnd), verdict.detectedEncoding);
    return {
      status: 'opened',
      detail: `PLAINTEXT_CONFIRMED: ${verdict.detectedEncoding}; ${bytes.length} bytes`
    };
  }
  if (!verdict.luaBytecodeMagic) {
    const diagnostic = verdict.diagnostics[0];
    return {
      status: 'failed',
      detail: `SCRIPT_SOURCE_BYTECODE_UNSUPPORTED: ${diagnostic?.message ?? verdict.code}`
    };
  }

  const native = await runHksSource({
    command: 'read-hks-source',
    filePath: options.absolutePath,
    allowedRoots: options.allowedRoots,
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    // Match rawResourceService.readScriptSource: standalone bytes are opened
    // from filePath by Bridge, unlike BND4 child reads that carry contentBase64.
    commandOptions: {},
    timeoutMs: FILE_TIMEOUT_MS,
    maxFrameBytes: 32 * 1024 * 1024
  });
  const errorDiagnostic = native.diagnostics?.find((item) => item.severity === 'error');
  if (native.parseStatus === 'failed' || errorDiagnostic) {
    const diagnostic = errorDiagnostic ?? native.diagnostics?.[0];
    return {
      status: 'failed',
      detail: `${diagnostic?.code ?? 'SCRIPT_HKS_READ_FAILED'}: ${diagnostic?.message ?? '原生 HKS reader 未返回完整源码与 sourceHash。'}`
    };
  }
  if (native.parseStatus === 'unsupported' || native.parseStatus === 'unparsed') {
    const diagnostic = native.diagnostics?.[0];
    return {
      status: 'unavailable',
      detail: `${diagnostic?.code ?? 'HKS_DIALECT_NOT_SUPPORTED'}: ${diagnostic?.message ?? '当前 HKS dialect 不在支持范围内。'}`
    };
  }
  if (native.parseStatus !== 'ok' || !native.data?.sourceText || !native.data.sourceHash) {
    const diagnostic = native.diagnostics?.find((item) => item.severity === 'error') ?? native.diagnostics?.[0];
    return {
      status: 'failed',
      detail: `${diagnostic?.code ?? 'SCRIPT_HKS_READ_FAILED'}: ${diagnostic?.message ?? '原生 HKS reader 未返回完整源码与 sourceHash。'}`
    };
  }
  return {
    status: 'opened',
    detail: `HKS_NATIVE_READ_VERIFIED: ${native.data.dialect ?? native.data.format ?? 'first-party'}; ${native.data.sourceHash}`
  };
}

function resolveWorkspaceRoot(): string | null {
  const explicit = process.argv[2]?.trim();
  if (explicit) return resolve(explicit);
  const envRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!envRoot) return null;
  const mods = join(envRoot, 'mods');
  return existsSync(mods) ? resolve(mods) : resolve(envRoot);
}

function skipIndexedPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  return normalized.includes('/_DSAS_CACHE/')
    || normalized.includes('/_DSAS_TEMP/')
    || normalized.startsWith('_DSAS_CACHE/')
    || normalized.startsWith('_DSAS_TEMP/');
}

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), FILE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bridgeRead(
  command: BridgeCommand,
  filePath: string,
  allowedRoots: string[],
  oodleRuntimeRoot: string | undefined
): Promise<{ status: Exclude<NativeReadStatus, 'not_run'>; detail: string }> {
  const result = await runBridge({
    command,
    filePath,
    allowedRoots,
    timeoutMs: FILE_TIMEOUT_MS,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {})
  });
  const verdict = classifyNativeRead(result);
  return {
    status: verdict.status,
    detail: `${verdict.code}: ${verdict.message}`
  };
}

async function probeFile(
  absolutePath: string,
  relativePath: string,
  size: number,
  workspaceRoot: string,
  oodleRuntimeRoot: string | undefined
): Promise<FileResult> {
  const family = classifyWorkspaceOpen(relativePath);
  const base: Omit<FileResult, 'status'> = {
    relativePath,
    familyId: family.familyId,
    openKind: family.openKind,
    size
  };
  if (family.openKind === 'history') return { ...base, status: 'history' };
  if (family.openKind === 'blocked-no-parser') return { ...base, status: 'blocked-no-parser' };
  if (family.openKind === 'blocked-scope') return { ...base, status: 'blocked-scope' };
  if (family.openKind === 'binary') return { ...base, status: 'binary' };

  const allowedRoots = [workspaceRoot, dirname(absolutePath)];
  const large = size >= LARGE_FILE_BYTES;

  try {
    if (family.openKind === 'plain-text') {
      const bytes = await withTimeout(readFile(absolutePath), relativePath);
      return { ...base, status: 'opened', detail: `${bytes.length} bytes` };
    }

    if (large && (family.openKind === 'vfx' || family.openKind === 'container' || family.openKind === 'tpf')) {
      const listed = await withTimeout(
        bridgeRead('read-dcx-document', absolutePath, allowedRoots, oodleRuntimeRoot),
        relativePath
      );
      return listed.status === 'passed'
        ? { ...base, status: 'opened-list-only', detail: listed.detail }
        : { ...base, status: listed.status, detail: listed.detail };
    }

    if (family.openKind === 'fmg') {
      const result = await withTimeout(readFmgDocumentViaBridge({
        sourcePath: absolutePath,
        allowedRoots,
        timeoutMs: FILE_TIMEOUT_MS
      }), relativePath);
      return result.ok && result.data?.sourceHash
        ? { ...base, status: 'opened', detail: `${result.data.entryCount ?? 0} entries` }
        : { ...base, status: 'failed', detail: result.diagnostics[0]?.message ?? 'FMG_READ_FAILED' };
    }

    if (family.openKind === 'msb') {
      const result = await withTimeout(readMsbDocumentViaBridge({
        sourcePath: absolutePath,
        allowedRoots,
        timeoutMs: FILE_TIMEOUT_MS,
        ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {})
      }), relativePath);
      return result.ok
        ? { ...base, status: 'opened', detail: result.data ? 'msb' : 'ok' }
        : { ...base, status: 'failed', detail: result.diagnostics[0]?.message ?? 'MSB_READ_FAILED' };
    }

    if (family.openKind === 'script') {
      if (family.familyId === '.hks' || family.familyId === '.lua') {
        const result = await withTimeout(probeStandaloneScriptFile({
          absolutePath,
          allowedRoots,
          ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {})
        }), relativePath);
        return { ...base, status: result.status, detail: result.detail };
      }
      const result = await withTimeout(buildScriptContainerEvidence({
        containerPath: absolutePath,
        allowedRoots,
        ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
        timeoutMs: FILE_TIMEOUT_MS
      }), relativePath);
      return result.ok
        ? { ...base, status: 'opened', detail: `${result.entryCount} entries` }
        : { ...base, status: 'failed', detail: result.diagnostics[0]?.message ?? 'SCRIPT_EVIDENCE_FAILED' };
    }

    const commandByKind: Partial<Record<WorkspaceOpenKind, BridgeCommand>> = {
      emevd: 'read-emevd-document',
      gparam: 'read-gparam-document',
      'param-container': 'read-dcx-document',
      'param-rows': 'read-param-document',
      tpf: 'read-tpf-document',
      tae: 'read-tae-document',
      esd: 'read-esd-document',
      flver: 'read-flver-document',
      vfx: 'read-fxr-document',
      container: 'read-dcx-document'
    };
    const command = commandByKind[family.openKind];
    if (!command) {
      return { ...base, status: 'failed', detail: `NO_COMMAND_FOR_${family.openKind}` };
    }
    const read = await withTimeout(
      bridgeRead(command, absolutePath, allowedRoots, oodleRuntimeRoot),
      relativePath
    );
    return read.status === 'passed'
      ? { ...base, status: 'opened', detail: read.detail }
      : { ...base, status: read.status, detail: read.detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('TIMEOUT:')) {
      return { ...base, status: 'timed-out', detail: message };
    }
    return { ...base, status: 'failed', detail: message };
  }
}

async function main(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  if (workspaceRoot === null || !existsSync(workspaceRoot)) {
    console.log(JSON.stringify({
      ...summarizeNativeReads([{ family: 'native corpus', status: 'not_run' }]),
      smoke: 'workspace-completeness',
      reason: 'NATIVE_CORPUS_UNAVAILABLE',
      message: '本机 Mod 工作区不存在，跳过完成度矩阵。',
      hint: 'node scripts/with-local-has-game-env.mjs npm run test:workspace-completeness'
    }, null, 2));
    return;
  }

  const scan = await scanWorkspace({ workspaceRoot, game: 'sekiro' });
  const files = scan.files.filter((file) => !skipIndexedPath(file.relativePath));
  const scanDiagnostics = scan.diagnostics ?? [];
  // Failed enumeration/stat means the scanner may have omitted files. Hash
  // enrichment warnings retain their IndexedFile row, while informational
  // missing-resource-directory diagnostics do not apply to this whole-tree scan.
  const incompleteScanCodes = new Set([
    'WORKSPACE_ROOT_NOT_DIRECTORY',
    'DIRECTORY_READ_FAILED',
    'FILE_STAT_FAILED'
  ]);
  const incompleteScanDiagnostics = scanDiagnostics.filter((diagnostic) =>
    diagnostic.severity === 'error' || incompleteScanCodes.has(diagnostic.code));
  // A later reader open is not hash-bound to the indexed source version.
  const sourceHashUnverifiedDiagnostics = scanDiagnostics.filter((diagnostic) => diagnostic.code === 'FILE_HASH_FAILED');
  const sourceHashUnverifiedAbsolutePaths = new Set(sourceHashUnverifiedDiagnostics.flatMap((diagnostic) => {
    const details = diagnostic.details;
    const absolutePath = details !== null && typeof details === 'object'
      ? (details as Record<string, unknown>).absolutePath
      : undefined;
    return typeof absolutePath === 'string' ? [absolutePath] : [];
  }));
  const sourceHashUnverifiedRelativePaths = new Set(files
    .filter((file) => sourceHashUnverifiedAbsolutePaths.has(file.absolutePath))
    .map((file) => file.relativePath));
  const scanComplete = incompleteScanDiagnostics.length === 0;
  const withScanCoverage = (
    fileCoverage: ReturnType<typeof verifyFileCoverage>,
    scanHashesComplete = true
  ) => ({
    ...fileCoverage,
    inputOutputOk: fileCoverage.ok,
    scanComplete,
    scanHashesComplete,
    ok: fileCoverage.ok && scanComplete && scanHashesComplete,
    scope: 'All indexed files are classified; history/binary rows are excluded, and FILE_HASH_FAILED cannot prove the same source version.'
  });
  if (files.length === 0) {
    const fileCoverage = verifyFileCoverage([], []);
    const summary = {
      ...summarizeNativeReads(scanComplete
        ? [{ family: 'native corpus', status: 'not_run' }]
        : [{ family: 'workspace scan', status: 'failed' }]),
      smoke: 'workspace-completeness',
      reason: scanComplete ? 'NATIVE_CORPUS_EMPTY' : 'WORKSPACE_SCAN_INCOMPLETE',
      workspaceRoot,
      scanned: 0,
      coverage: withScanCoverage(fileCoverage),
      scanDiagnostics,
      incompleteScanDiagnostics,
      sourceHashUnverifiedDiagnostics,
      acceptanceUnavailable: [],
      acceptanceScope: {
        fourStateInputCount: 0,
        excluded: {
          history: { count: 0, reason: 'History entries are catalogued but excluded from the native-read acceptance gate.' },
          binary: { count: 0, reason: 'Opaque binary entries are catalogued but excluded from the native-read acceptance gate.' }
        }
      }
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!scanComplete) {
      throw new Error(`工作区完成度矩阵：扫描阶段有 ${incompleteScanDiagnostics.length} 项诊断影响文件枚举完整性。`);
    }
    return;
  }

  const oodleRuntimeRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || undefined;
  const results: FileResult[] = [];
  for (const file of files) {
    results.push(await probeFile(
      file.absolutePath,
      file.relativePath,
      file.size,
      workspaceRoot,
      oodleRuntimeRoot
    ));
  }

  const failed = results.filter((item) => item.status === 'failed' || item.status === 'timed-out');
  const semanticFailed = failed.filter((item) => isSemanticOpenKind(item.openKind));
  const byFamily = new Map<string, { familyId: string; openKind: WorkspaceOpenKind; total: number; opened: number; failed: number; blocked: number; unavailable: number }>();
  for (const item of results) {
    const current = byFamily.get(item.familyId) ?? {
      familyId: item.familyId,
      openKind: item.openKind,
      total: 0,
      opened: 0,
      failed: 0,
      blocked: 0,
      unavailable: 0
    };
    current.total += 1;
    if (item.status === 'opened' || item.status === 'opened-list-only') current.opened += 1;
    if (item.status === 'failed' || item.status === 'timed-out') current.failed += 1;
    if (item.status === 'blocked-no-parser' || item.status === 'blocked-scope') current.blocked += 1;
    if (item.status === 'unavailable') current.unavailable += 1;
    byFamily.set(item.familyId, current);
  }

  const nativeAcceptanceResults = results
    .filter((item) => item.status !== 'history' && item.status !== 'binary');
  const sourceHashUnverifiedResults = nativeAcceptanceResults
    .filter((item) => sourceHashUnverifiedRelativePaths.has(item.relativePath));
  const scanHashesComplete = sourceHashUnverifiedResults.length === 0;
  const acceptanceUnavailable = sourceHashUnverifiedResults
    .filter((item) => item.status !== 'failed' && item.status !== 'timed-out')
    .map((item) => ({
      relativePath: item.relativePath,
      diagnosticCode: 'FILE_HASH_FAILED',
      reason: 'A successful open without a verified scanner hash cannot prove it read the same source version.'
    }));
  const acceptanceRows: Array<{ relativePath: string; status: NativeReadStatus }> = nativeAcceptanceResults
    .map((item) => ({ relativePath: item.relativePath,
      status: item.status === 'failed' || item.status === 'timed-out' ? 'failed'
        : sourceHashUnverifiedRelativePaths.has(item.relativePath) ? 'unavailable'
          : item.status === 'opened' || item.status === 'opened-list-only' ? 'passed' : 'unavailable' }));
  const fileCoverage = verifyFileCoverage(files.map((file) => file.relativePath), results.map((item) => item.relativePath));
  const coverage = withScanCoverage(fileCoverage, scanHashesComplete);
  const acceptance = summarizeNativeReads([
    ...acceptanceRows,
    ...(!fileCoverage.ok ? [{ relativePath: 'input-output coverage', status: 'failed' as const }] : []),
    ...(!scanComplete ? [{ relativePath: 'workspace scan', status: 'failed' as const }] : [])
  ]);
  const historyCount = results.filter((item) => item.status === 'history').length;
  const binaryCount = results.filter((item) => item.status === 'binary').length;
  const summary = {
    ...acceptance,
    smoke: 'workspace-completeness',
    workspaceRoot,
    scanned: results.length,
    coverage,
    scanDiagnostics,
    incompleteScanDiagnostics,
    sourceHashUnverifiedDiagnostics,
    acceptanceUnavailable,
    acceptanceScope: {
      fourStateInputCount: acceptanceRows.length,
      excluded: {
        history: { count: historyCount, reason: 'History entries are catalogued but excluded from the native-read acceptance gate.' },
        binary: { count: binaryCount, reason: 'Opaque binary entries are catalogued but excluded from the native-read acceptance gate.' }
      }
    },
    opened: results.filter((item) => item.status === 'opened' || item.status === 'opened-list-only').length,
    failed,
    semanticFailed,
    blocked: results.filter((item) => item.status === 'blocked-no-parser' || item.status === 'blocked-scope'),
    unavailable: results.filter((item) => item.status === 'unavailable'),
    history: results.filter((item) => item.status === 'history').length,
    binary: results.filter((item) => item.status === 'binary').length,
    results,
    byFamily: [...byFamily.values()].sort((left, right) => right.total - left.total)
  };
  console.log(JSON.stringify(summary, null, 2));
  if (acceptance.status === 'failed') {
    throw new Error(`工作区完成度矩阵：${failed.length} 个文件打开失败；输入输出覆盖 ${fileCoverage.ok ? '一致' : '不一致'}；扫描完整性 ${scanComplete ? '完整' : `失败（${incompleteScanDiagnostics.length} 项诊断）`}；扫描哈希完整性 ${scanHashesComplete ? '完整' : '不完整'}。`);
  }
}

// Keep the CLI behavior for the direct smoke invocation while allowing its
// pure standalone-read contract to be exercised without scanning a workspace.
if (new Set(['runWorkspaceCompletenessMatrixSmoke.js', 'runWorkspaceCompletenessMatrixSmoke.ts'])
  .has(basename(process.argv[1] ?? ''))) {
  main().finally(() => disposeBridgeDaemonPool()).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

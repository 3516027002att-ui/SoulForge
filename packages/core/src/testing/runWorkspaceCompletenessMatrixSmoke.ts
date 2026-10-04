/**
 * 工作区完成度矩阵 L1+L2a：对 mods 里每一个索引文件问「后端能不能打开」。
 *
 * 禁止抽样。失败按文件记账。没有 parser / HKX 裁定挡住的记 blocked，
 * 不把它们算成通过，也不把它们当成解析失败。
 *
 * 大文件（≥32MB）只跑容器目录 / DCX 文档头，不解整包载荷。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { disposeBridgeDaemonPool, runBridge, type BridgeCommand } from '../bridge/runBridge.js';
import { readFmgDocumentViaBridge } from '../editing/fmgBridgeCommit.js';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import { buildScriptContainerEvidence } from '../script/scriptContainerEvidence.js';
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
  if (files.length === 0) {
    console.log(JSON.stringify({
      ...summarizeNativeReads([{ family: 'native corpus', status: 'not_run' }]),
      smoke: 'workspace-completeness',
      reason: 'NATIVE_CORPUS_EMPTY',
      workspaceRoot
    }, null, 2));
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

  const coverage = verifyFileCoverage(files.map((file) => file.relativePath), results.map((item) => item.relativePath));
  const acceptanceRows: Array<{ relativePath: string; status: NativeReadStatus }> = results
    .filter((item) => item.status !== 'history' && item.status !== 'binary')
    .map((item) => ({ relativePath: item.relativePath,
      status: item.status === 'opened' || item.status === 'opened-list-only' ? 'passed'
        : item.status === 'failed' || item.status === 'timed-out' ? 'failed' : 'unavailable' }));
  const acceptance = summarizeNativeReads([
    ...acceptanceRows,
    ...(!coverage.ok ? [{ relativePath: 'input-output coverage', status: 'failed' as const }] : [])
  ]);
  const summary = {
    ...acceptance,
    smoke: 'workspace-completeness',
    workspaceRoot,
    scanned: results.length,
    coverage,
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
    throw new Error(`工作区完成度矩阵：${failed.length} 个文件打开失败；输入输出覆盖 ${coverage.ok ? '一致' : '不一致'}。`);
  }
}

main().finally(() => disposeBridgeDaemonPool()).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

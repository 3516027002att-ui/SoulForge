/**
 * Agent / CLI 通用容器条目门面。
 *
 * 之前的缺口：`.anibnd` / `.chrbnd` / `.behbnd` / `.objbnd` / `.parambnd` /
 * `.msgbnd` / `.texbnd` / `.talkesdbnd` / `.sblytbnd` / `.ffxbnd` 这些 BND
 * 容器，工作区索引只能看到"外层文件"，Agent 拿不到里面的成员清单，也就无法
 * 从 `search_resources` 的候选走到具体条目。参考 CLI（SoulsFormats 适配器）
 * 一直能列，所以两边的读取口径在这一层是不对等的。
 *
 * 这里只做只读编排：真正的解析仍然是 C# Bridge（`list-bnd4-entries`）的
 * production authority，本模块负责挑命令、归一化字段、保留诊断，不做第二套
 * native parser。
 */
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Diagnostic } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import type { NativeEditSession } from './nativeEditSession.js';

/**
 * BND4 条目名是**打包机的绝对路径**，例如
 * `N:\NTC\data\Target\INTERROOT_win64\chr\c0000\hkx\skeleton.hkx`。这类名字
 * 直接交给模型有两个问题：既是宿主路径（会被脱敏成「[本机路径已隐藏]」，
 * 等于什么都没给），又不带容器内的定位语义。这里统一折算成"容器根之后的
 * 相对路径"：`chr/c0000/hkx/skeleton.hkx`。没有根锚点（如 `.fxr` 纯名字）
 * 时退回 basename，不会丢信息也不会伪造目录。
 */
export function logicalEntryName(raw: string): string {
  const normalized = raw.trim().replaceAll('\\', '/');
  if (!normalized) return '';
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return '';
  const anchor = segments.findIndex((segment) => /^INTERROOT_(?:win64|x64|win32)$/iu.test(segment));
  const dataIndex = segments.findIndex((segment) => segment.toLowerCase() === 'data');
  const start = anchor >= 0
    ? anchor + 1
    : dataIndex >= 0 && dataIndex < segments.length - 1
      ? dataIndex + 1
      : segments.length - 1;
  const tail = segments.slice(start);
  return tail.length > 0 ? tail.join('/') : segments[segments.length - 1] ?? normalized;
}

/** 一条容器成员。BND4 能给出 id/size，ffxbnd 的旧命令只给名字。 */
export interface ContainerEntry {
  /** BND4 里的条目序号（ffxbnd 名字清单按字典序，index 只是位置）。 */
  index: number;
  /** BND4 条目的 id（ffxbnd 名字清单没有稳定 id，固定 null）。 */
  id: number | null;
  name: string;
  /** 解压后字节数；未知为 null。 */
  size: number | null;
  compressedSize: number | null;
  /** 条目在容器内的偏移，未知为 null。 */
  dataOffset: number | null;
  /** 仅在 includeContentHashes 时由 Bridge 计算。 */
  contentHash: string | null;
  duplicateOrdinal: number | null;
}

export interface ContainerEntriesResult {
  ok: true;
  containerPath: string;
  sourceUri: string;
  sourceHash: string;
  /** 实际使用的 Bridge 命令，便于把口径差异讲清楚。 */
  command: 'list-bnd4-entries' | 'list-ffxbnd-entries';
  format: string;
  compressionFormat: string | null;
  variant: string | null;
  sourceSize: number | null;
  entryCount: number;
  /** 容器里出现的非空扩展名（小写、去重、排序），给调用方判断资源类型。 */
  extensions: string[];
  entries: ContainerEntry[];
  diagnostics: Diagnostic[];
  authority: 'partial';
}

export type ContainerEntriesFailure = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
  diagnostics: Diagnostic[];
};

/** 只读目录不产生写入依据，authority 固定 partial（Bridge 的 payload 也是 partial）。 */
const AUTHORITY = 'partial' as const;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 把 Bridge payload 归一化成稳定条目形状。
 * 纯函数：没有 Bridge、没有文件系统访问，方便单测覆盖两种命令的输出。
 */
export function normalizeContainerEntries(
  raw: unknown,
  command: 'list-bnd4-entries' | 'list-ffxbnd-entries'
): { entries: ContainerEntry[]; entryCount: number | null; extensions: string[] } {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = Array.isArray(data.entries) ? data.entries : [];
  const entries: ContainerEntry[] = [];
  list.forEach((item, position) => {
    if (typeof item === 'string') {
      // list-ffxbnd-entries 只返回名字数组。
      const name = logicalEntryName(item);
      if (!name) return;
      entries.push({
        index: position,
        id: null,
        name,
        size: null,
        compressedSize: null,
        dataOffset: null,
        contentHash: null,
        duplicateOrdinal: null
      });
      return;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const entry = item as Record<string, unknown>;
    const name = logicalEntryName(asString(entry.name) ?? '');
    if (!name) return;
    entries.push({
      index: asNumber(entry.index) ?? position,
      id: asNumber(entry.id),
      name,
      size: asNumber(entry.size) ?? asNumber(entry.uncompressedSize),
      compressedSize: asNumber(entry.compressedSize),
      dataOffset: asNumber(entry.dataOffset),
      contentHash: asString(entry.contentHash),
      duplicateOrdinal: asNumber(entry.duplicateOrdinal)
    });
  });

  const extensions = [...new Set(entries
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(dot) : '';
    })
    .filter((extension) => extension.length > 1))]
    .sort();

  return {
    entries,
    entryCount: asNumber(data.entryCount) ?? (command === 'list-ffxbnd-entries' ? entries.length : null),
    extensions
  };
}

/**
 * 条目清单的快照指纹：容器身份 + 成员名字集合。游标绑定它，容器一旦变化
 * （写入、替换、重新打包）旧 cursor 就必须失效，而不是把新条目当旧页续读。
 */
export function containerCatalogHash(
  sourceUri: string,
  sourceHash: string,
  entries: readonly ContainerEntry[]
): string {
  const hash = createHash('sha256');
  hash.update(`${sourceUri}\u0000${sourceHash}\u0000${entries.length}\u0000`);
  for (const entry of entries) hash.update(`${entry.index}\u0001${entry.name}\u0001`);
  return hash.digest('hex');
}

/** 按扩展名挑第一条 Bridge 命令；失败时由调用方决定是否回退。 */
function primaryCommand(file: string, includeContentHashes: boolean): {
  command: 'list-bnd4-entries' | 'list-ffxbnd-entries';
  payload: Record<string, unknown>;
} {
  const lower = file.toLowerCase();
  if (lower.endsWith('.ffxbnd') || lower.endsWith('.ffxbnd.dcx')) {
    // ffxbnd 专有命令只列 .fxr 名字，但能给 UI 用的字典序清单；带 hash 需求
    // 时直接走 BND4，那条命令才有 contentHash。
    if (!includeContentHashes) return { command: 'list-ffxbnd-entries', payload: {} };
  }
  return { command: 'list-bnd4-entries', payload: { includeContentHashes } };
}

async function resolveContainerPath(edit: NativeEditSession, file: string): Promise<string | null> {
  const overlay = edit.session.layers.overlayRoot;
  const base = edit.session.layers.baseRoot;
  const candidates: string[] = [];
  if (isAbsolute(file)) {
    candidates.push(file);
  } else {
    candidates.push(resolve(file));
    candidates.push(join(overlay, file));
    if (base) candidates.push(join(base, file));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function listContainerEntries(input: {
  edit: NativeEditSession;
  file: string;
  includeContentHashes?: boolean;
  /** KRAK 容器要 oodle DLL；生产约定是工作区 `baseRoot`（游戏根）。 */
  oodleRuntimeRoot?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ContainerEntriesResult | ContainerEntriesFailure> {
  const oodleRuntimeRoot = input.oodleRuntimeRoot ?? input.edit.oodleRuntimeRoot ?? input.edit.session.layers.baseRoot;
  const containerPath = await resolveContainerPath(input.edit, input.file);
  if (!containerPath) {
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: 'FILE_NOT_FOUND',
      message: `未找到容器文件: ${input.file}`,
      sourceUri: pathToFileURL(resolve(input.file)).href
    };
    return {
      ok: false,
      error: { code: 'FILE_NOT_FOUND', message: diagnostic.message },
      diagnostics: [diagnostic]
    };
  }

  const includeContentHashes = input.includeContentHashes === true;
  const primary = primaryCommand(containerPath, includeContentHashes);
  const runOnce = async (command: 'list-bnd4-entries' | 'list-ffxbnd-entries') => runBridge({
    command,
    filePath: containerPath,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    allowedRoots: input.edit.allowedRoots(),
    ...(command === 'list-ffxbnd-entries' ? {} : { commandOptions: primary.payload })
  });

  let attemptedCommand = primary.command;
  let bridgeResult = await runOnce(attemptedCommand);
  // .ffxbnd 的专用命令依赖 "解 DCX 后必须是 BND4"，遇到非 BND4 或名字清单
  // 拿不到成员身份时回退到通用 BND4 命令一次，而不是直接把容器判死。
  if (!bridgeResult.data && attemptedCommand === 'list-ffxbnd-entries') {
    const fallback = await runOnce('list-bnd4-entries');
    if (fallback.data) {
      bridgeResult = fallback;
      attemptedCommand = 'list-bnd4-entries';
    }
  }

  const diagnostics = bridgeResult.diagnostics ?? [];
  if (!bridgeResult.data) {
    const primaryError = diagnostics.find((item) => item.severity === 'error');
    return {
      ok: false,
      error: {
        code: primaryError?.code ?? 'CONTAINER_LIST_FAILED',
        message: primaryError?.message ?? '列出容器条目失败。',
        details: primaryError?.details
      },
      diagnostics
    };
  }

  const data = bridgeResult.data as Record<string, unknown>;
  const normalized = normalizeContainerEntries(data, attemptedCommand);
  const fileStat = await stat(containerPath);
  const sourceHash = asString(data.sourceHash)
    ?? asString(data.outerFileHash)
    ?? `${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}`;
  const sourceUri = pathToFileURL(containerPath).href;

  return {
    ok: true,
    containerPath,
    sourceUri,
    sourceHash,
    command: attemptedCommand,
    format: asString(data.format) ?? (attemptedCommand === 'list-ffxbnd-entries' ? 'FFXBND' : 'BND4'),
    compressionFormat: asString(data.compressionFormat),
    variant: asString(data.variant),
    sourceSize: asNumber(data.sourceSize) ?? fileStat.size,
    entryCount: normalized.entryCount ?? normalized.entries.length,
    extensions: normalized.extensions,
    entries: normalized.entries,
    diagnostics,
    authority: AUTHORITY
  };
}

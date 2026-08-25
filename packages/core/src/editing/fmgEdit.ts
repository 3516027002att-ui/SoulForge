/**
 * Agent / CLI FMG facade.
 *
 * Reads live text via read-text-catalog (confirmed tables only) and writes
 * through write-fmg mutations[] + applyNativeMutation. msgbnd never falls
 * back to a loose FMG write.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logicalFmgTableName, type Diagnostic } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { applyNativeMutation } from './editorMutationService.js';
import { commitFmgMutationsViaBridge, type FmgBridgeMutation } from './fmgBridgeCommit.js';
import type { NativeEditSession } from './nativeEditSession.js';

export interface FmgEntryEdit {
  table: string;
  id: number;
  text: string;
}

export interface FmgEntrySnapshot {
  table: string;
  id: number;
  text: string;
  /** Provenance returned by the same native catalog read. */
  sourceHash?: string;
  sourceRevision?: number;
}

export interface FmgEditFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type FmgReadResult =
  | { ok: true; containerPath: string; table: string; entries: FmgEntrySnapshot[]; diagnostics: Diagnostic[] }
  | { ok: false; error: FmgEditFailure; diagnostics: Diagnostic[] };

export type FmgSetResult =
  | {
      ok: true;
      containerPath: string;
      before: FmgEntrySnapshot[];
      after: FmgEntrySnapshot[];
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: FmgEditFailure; diagnostics: Diagnostic[]; before?: FmgEntrySnapshot[] };

interface CatalogTable {
  name: string;
  entryIndex: number;
  entryCount: number;
}

interface CatalogEnvelope {
  languageId?: string;
  containerKind?: string;
  outerHash?: string;
  tables?: Array<{
    stableId?: string;
    entryIndex?: number;
    entryName?: string;
    entryCount?: number;
  }>;
  entries?: Array<{ id?: number; text?: string }>;
}

/** 用户口语 / 英文表名 → 本机 BND 逻辑名（只狼 zhocn 包是日文文件名）。 */
const TABLE_ALIASES: Record<string, readonly string[]> = {
  title: ['アイテム名', 'title_items', 'goodsname'],
  item: ['アイテム名'],
  itemname: ['アイテム名'],
  goods: ['アイテム名'],
  物品名: ['アイテム名'],
  道具名: ['アイテム名'],
  weapon: ['武器名'],
  weaponname: ['武器名'],
  武器名: ['武器名'],
  npc: ['NPC名'],
  npcname: ['NPC名'],
  character: ['NPC名'],
  charactername: ['NPC名'],
  人物名: ['NPC名'],
  角色名: ['NPC名'],
  敌人名: ['NPC名'],
  description: ['アイテム説明'],
  itemdesc: ['アイテム説明'],
  说明: ['アイテム説明'],
  道具说明: ['アイテム説明']
};

function tableNeedles(wanted: string): string[] {
  const key = wanted.trim().toLowerCase();
  return [key, ...(TABLE_ALIASES[key] ?? []).map((item) => item.toLowerCase())];
}

export function groupFmgEdits(edits: FmgEntryEdit[]): Map<string, FmgEntryEdit[]> {
  const groups = new Map<string, FmgEntryEdit[]>();
  for (const edit of edits) {
    const key = edit.table.trim().toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(edit);
    groups.set(key, list);
  }
  return groups;
}

export async function readFmgEntries(input: {
  edit: NativeEditSession;
  table: string;
  ids: number[];
  containerPath?: string;
  lang?: string;
}): Promise<FmgReadResult> {
  if (input.ids.length === 0) {
    return { ok: false, error: { code: 'FMG_READ_EMPTY', message: '需要至少一个 id。' }, diagnostics: [] };
  }
  const resolved = await resolveFmgTable(input.edit, input.table, input.containerPath, input.lang);
  if (!resolved.ok) return resolved;
  const loaded = await loadTableEntries(input.edit, resolved);
  let sourceRevision: number | undefined;
  try {
    sourceRevision = (await stat(resolved.containerPath)).mtimeMs;
  } catch (error) {
    loaded.diagnostics.push({
      severity: 'warning',
      code: 'FMG_SOURCE_REVISION_UNAVAILABLE',
      message: error instanceof Error ? error.message : '无法读取 FMG 容器的 source revision。'
    });
  }
  if (!loaded.ok) return loaded;
  const entries: FmgEntrySnapshot[] = [];
  const missingIds: number[] = [];
  for (const id of input.ids) {
    const text = loaded.byId.get(id);
    if (text === undefined) {
      missingIds.push(id);
      continue;
    }
    entries.push({
      table: resolved.table,
      id,
      text,
      ...(resolved.outerHash ? { sourceHash: resolved.outerHash } : {}),
      ...(sourceRevision !== undefined ? { sourceRevision } : {})
    });
  }
  if (entries.length === 0 && input.ids.length > 0) {
    return {
      ok: false,
      error: { code: 'FMG_ENTRY_NOT_FOUND', message: `${resolved.table}#${input.ids.join(', ')} 均不存在。` },
      diagnostics: loaded.diagnostics
    };
  }
  const diagnostics = [...loaded.diagnostics];
  if (missingIds.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'FMG_ENTRY_PARTIAL_MISSING',
      message: `${resolved.table} 未找到 ID：${missingIds.join(', ')}。`
    });
  }
  return {
    ok: true,
    containerPath: resolved.containerPath,
    table: resolved.table,
    entries,
    diagnostics
  };
}

export async function setFmgEntries(input: {
  edit: NativeEditSession;
  edits: FmgEntryEdit[];
  containerPath?: string;
  lang?: string;
}): Promise<FmgSetResult> {
  if (input.edits.length === 0) {
    return { ok: false, error: { code: 'FMG_EDIT_EMPTY', message: '没有要写入的词条。' }, diagnostics: [] };
  }
  const grouped = groupFmgEdits(input.edits);
  if (grouped.size !== 1 && !input.containerPath) {
    // 多表可以分次提交，但一次 CLI 调用只允许一张表，避免跨容器哈希串扰。
    const tables = [...grouped.keys()];
    if (tables.length > 1) {
      return {
        ok: false,
        error: { code: 'FMG_MULTI_TABLE', message: `一次 set 只支持一张表，收到：${tables.join(', ')}` },
        diagnostics: []
      };
    }
  }
  const table = input.edits[0]!.table;
  const resolved = await resolveFmgTable(input.edit, table, input.containerPath, input.lang);
  if (!resolved.ok) return resolved;
  const loaded = await loadTableEntries(input.edit, resolved);
  if (!loaded.ok) return { ok: false, error: loaded.error, diagnostics: loaded.diagnostics };

  const before: FmgEntrySnapshot[] = [];
  const after: FmgEntrySnapshot[] = [];
  const mutations: FmgBridgeMutation[] = [];
  const seenIds = new Set<number>();
  for (const edit of input.edits) {
    if (seenIds.has(edit.id)) {
      return {
        ok: false,
        error: { code: 'FMG_DUPLICATE_EDIT_ID', message: `同一次请求重复编辑 ${resolved.table}#${edit.id}。` },
        diagnostics: loaded.diagnostics,
        before
      };
    }
    seenIds.add(edit.id);
    const current = loaded.byId.get(edit.id);
    if (current === undefined) {
      after.push({ table: resolved.table, id: edit.id, text: edit.text });
      mutations.push({ kind: 'add', id: edit.id, text: edit.text });
      continue;
    }
    before.push({ table: resolved.table, id: edit.id, text: current });
    after.push({ table: resolved.table, id: edit.id, text: edit.text });
    if (current !== edit.text) {
      mutations.push({ kind: 'upsert', id: edit.id, text: edit.text });
    }
  }
  if (mutations.length === 0) {
    return {
      ok: true,
      containerPath: resolved.containerPath,
      before,
      after,
      diagnostics: loaded.diagnostics
    };
  }

  const file = await input.edit.indexFile(resolved.containerPath, 'msg');
  const expectedHash = resolved.outerHash || file.sha256 || await sha256Of(resolved.containerPath);
  const outcome = await applyNativeMutation({
    file: { ...file, sha256: expectedHash },
    sourceUri: file.sourceUri,
    expectedHash,
    stagingRoot: input.edit.stagingRoot,
    allowedRoots: () => [...input.edit.allowedRoots()],
    stagingPrefix: 'fmg',
    stagingFileName: `${basename(resolved.containerPath)}.mut.fmg`,
    stageWrite: (context) => commitFmgMutationsViaBridge({
      sourcePath: resolved.containerPath,
      outputPath: context.outputPath,
      expectedDocumentHash: expectedHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations,
      entryIndex: resolved.entryIndex,
      timeoutMs: 120_000,
      ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
    }),
    title: `FMG upsert ${mutations.length} in ${resolved.table}`,
    confirmActionLabel: '提交 FMG 变更'
  }, { commit: input.edit.commitPort });

  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics = outcome.status === 'failed'
      ? outcome.diagnostics
      : outcome.status === 'committed'
        ? outcome.result.diagnostics
        : [{
          severity: 'error' as const,
          code: 'FMG_WRITE_CANCELLED',
          message: '写入被取消。',
          sourceUri: file.sourceUri
        }];
    return {
      ok: false,
      error: { code: diagnostics[0]?.code ?? 'FMG_WRITE_FAILED', message: diagnostics[0]?.message ?? 'FMG 写入失败。' },
      diagnostics,
      before
    };
  }
  return {
    ok: true,
    containerPath: resolved.containerPath,
    before,
    after,
    diagnostics: [...loaded.diagnostics, ...outcome.result.diagnostics]
  };
}

async function resolveFmgTable(
  edit: NativeEditSession,
  table: string,
  containerPath: string | undefined,
  lang: string | undefined
): Promise<
  | { ok: true; containerPath: string; table: string; entryIndex: number; outerHash: string }
  | { ok: false; error: FmgEditFailure; diagnostics: Diagnostic[] }
> {
  const wanted = table.trim();
  if (!wanted) {
    return { ok: false, error: { code: 'FMG_TABLE_REQUIRED', message: '需要表名。' }, diagnostics: [] };
  }
  let cleanContainer = containerPath?.trim();
  if (cleanContainer?.startsWith('file:///')) {
    try {
      cleanContainer = fileURLToPath(cleanContainer);
    } catch {
      cleanContainer = cleanContainer.slice(8);
    }
  } else if (cleanContainer?.startsWith('file://')) {
    cleanContainer = cleanContainer.slice(7);
  }
  const containers = cleanContainer
    ? [isAbsolute(cleanContainer) ? resolve(cleanContainer) : resolve(edit.session.layers.overlayRoot, cleanContainer)]
    : await findMsgbnds(edit.session.layers.overlayRoot, lang ?? 'zhocn');
  if (containers.length === 0) {
    return {
      ok: false,
      error: {
        code: 'FMG_CONTAINER_NOT_FOUND',
        message: '工作区里没有匹配的 .msgbnd.dcx。请传 --container，或确认存在 msg/zhocn。'
      },
      diagnostics: []
    };
  }
  const hits: Array<{ containerPath: string; table: string; entryIndex: number; outerHash: string }> = [];
  const available: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const needles = tableNeedles(wanted);
  for (const path of containers) {
    const catalog = await readCatalog(edit, path);
    diagnostics.push(...catalog.diagnostics);
    if (!catalog.ok) continue;
    for (const item of catalog.tables) available.push(item.name);
    const exact = catalog.tables.filter((item) => needles.includes(item.name.toLowerCase()));
    const prefixed = exact.length > 0
      ? exact
      : catalog.tables.filter((item) => {
        const name = item.name.toLowerCase();
        return needles.some((needle) => name === needle || name.startsWith(needle) || name.includes(needle));
      });
    if (prefixed.length !== 1) continue;
    const match = prefixed[0]!;
    hits.push({
      containerPath: path,
      table: match.name,
      entryIndex: match.entryIndex,
      outerHash: catalog.outerHash
    });
  }
  if (hits.length === 0) {
    return {
      ok: false,
      error: {
        code: 'FMG_TABLE_NOT_FOUND',
        message: `没有已确认的文本表 ${wanted}。可用：${[...new Set(available)].slice(0, 24).join(', ')}`,
        details: { available: [...new Set(available)] }
      },
      diagnostics
    };
  }
  if (hits.length > 1 && !containerPath) {
    return {
      ok: false,
      error: {
        code: 'FMG_TABLE_AMBIGUOUS',
        message: `表 ${wanted} 出现在多份容器里，请指定 --container：${hits.map((hit) => hit.containerPath).join(' | ')}`
      },
      diagnostics
    };
  }
  return { ok: true, ...hits[0]! };
}

async function loadTableEntries(
  edit: NativeEditSession,
  resolved: { containerPath: string; table: string; entryIndex: number }
): Promise<
  | { ok: true; byId: Map<number, string>; diagnostics: Diagnostic[] }
  | { ok: false; error: FmgEditFailure; diagnostics: Diagnostic[] }
> {
  const catalog = await readCatalog(edit, resolved.containerPath, resolved.entryIndex);
  if (!catalog.ok) {
    return {
      ok: false,
      error: { code: 'FMG_READ_FAILED', message: `无法读取表 ${resolved.table}。` },
      diagnostics: catalog.diagnostics
    };
  }
  return { ok: true, byId: catalog.entries, diagnostics: catalog.diagnostics };
}

async function readCatalog(
  edit: NativeEditSession,
  containerPath: string,
  tableEntryIndex?: number
): Promise<{
  ok: boolean;
  outerHash: string;
  tables: CatalogTable[];
  entries: Map<number, string>;
  diagnostics: Diagnostic[];
}> {
  const result = await runBridge<CatalogEnvelope>({
    command: 'read-text-catalog',
    filePath: containerPath,
    resourceUri: pathToFileURL(containerPath).href,
    allowedRoots: edit.allowedRoots(),
    ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
    timeoutMs: 60_000,
    ...(tableEntryIndex !== undefined ? { commandOptions: { tableEntryIndex } } : {})
  });
  const diagnostics = asDiagnostics(result.diagnostics);
  if (result.parseStatus === 'failed' || !result.data) {
    return { ok: false, outerHash: '', tables: [], entries: new Map(), diagnostics };
  }
  const seen = new Set<string>();
  const tables: CatalogTable[] = (result.data.tables ?? []).map((table) => ({
    name: logicalFmgTableName(table.entryName ?? `table_${table.entryIndex ?? 0}`, table.entryIndex ?? 0, seen),
    entryIndex: table.entryIndex ?? 0,
    entryCount: table.entryCount ?? 0
  }));
  const entries = new Map<number, string>();
  for (const entry of result.data.entries ?? []) {
    if (typeof entry.id === 'number' && typeof entry.text === 'string') {
      entries.set(entry.id, entry.text);
    }
  }
  return {
    ok: true,
    outerHash: result.data.outerHash ?? '',
    tables,
    entries,
    diagnostics
  };
}

async function findMsgbnds(overlayRoot: string, lang: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || hits.length > 24) return;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!name.toLowerCase().endsWith('.msgbnd.dcx')) continue;
      const normalized = full.replace(/\\/g, '/').toLowerCase();
      if (lang && !normalized.includes(`/${lang.toLowerCase()}/`)) continue;
      hits.push(full);
    }
  };
  await walk(join(overlayRoot, 'msg'), 0);
  if (hits.length === 0 && lang) await walk(overlayRoot, 0);
  return hits;
}

function asDiagnostics(
  items: Array<{ severity: string; code: string; message: string }>
): Diagnostic[] {
  return items.map((item) => ({
    severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error',
    code: item.code,
    message: item.message
  }));
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

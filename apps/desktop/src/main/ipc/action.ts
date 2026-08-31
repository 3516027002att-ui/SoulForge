import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import {
  ingestBridgeResult,
  ActionMotionIdentityCache,
  isLeaderRemappedBundle,
  readTaeEventTemplateFile,
  remapCharacterBundleToLeader,
  runBridge,
  type BinderMembershipMatch,
  type BinderMembershipCandidate,
  type TaeEventTemplateInfo,
  type WorkspaceIndex,
  type WorkspaceSession
} from '@soulforge/core';
import {
  isCharacterPreviewBundle,
  type CharacterPreviewBundle,
  type Diagnostic,
  type FlverPreviewModel,
  type IndexedFile
} from '@soulforge/shared';
import { sanitizeRendererValue } from '../rendererDto.js';
import {
  decodeTaeParamFields,
  getTaeTemplateCatalog
} from '../taeTemplateCatalog.js';
import {
  C0000_COMPATIBILITY_PART_SLOTS,
  canonicalCharacterStemForActionPath,
  planC0000CompatibilityCandidates,
  type C0000CompatibilityCandidateOrigin
} from './actionPreviewCompatibility.js';
import type { TrustedIpcHandle } from './registration.js';
// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsActionCounters = new Map<string, number>();
function _forensicsActionInc(key: string, delta = 1): void { _forensicsActionCounters.set(key, (_forensicsActionCounters.get(key) ?? 0) + delta); }
export function getActionForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsActionCounters); }

/* ------------------------------------------------------------------ */
/*  本机 DSAnimStudio TAE 词条只读导入（S17 动作域）                    */
/*                                                                    */
/*  DSAnimStudio 的 Res\TAE.Template.SDT.xml 是 Sekiro 事件类型词条表： */
/*  `0 JumpTable` 这类事件行「类型名」的来源，也带每类事件参数体的      */
/*  字段布局（name/kind/slotSize），随 read-tae-document 的             */
/*  templateLayouts 选项传给 Bridge 解码参数体。                        */
/*                                                                    */
/*  同 Yapped：本机第三方工具安装目录，只读、不入库、失败降级 ——        */
/*  拿不到就事件行显示裸 `{typeId}`、参数体不解码，绝不把「词条不可用」 */
/*  升级成「TAE 不可用」。                                              */
/* ------------------------------------------------------------------ */

/** S17 固定候选：本机 DSAnimStudio 发布包真实落地（grok 已求证存在）。 */
const TAE_TEMPLATE_FIXED_CANDIDATES = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\DSAnimStudio-4.9.9[Build 4999]'
    + '\\Res\\TAE.Template.SDT.xml'
];

/** TAE 模板在 tools/<一层子目录> 下的相对候选（DSAS 装在 Res/ 下）。 */
const TAE_TEMPLATE_RELATIVE_CANDIDATES = [
  'Res\\TAE.Template.SDT.xml',
  'TAE.Template.SDT.xml',
  'Res\\TAE.Template.xml'
];

let taeTemplateCache: {
  loaded: true;
  /** eventTypeId → 词条；null 表示本机无模板或读不到。 */
  byEventTypeId: ReadonlyMap<number, TaeEventTemplateInfo> | null;
} | null = null;

/**
 * 定位本机 DSAnimStudio 的 `TAE.Template.SDT.xml`。
 *
 * 候选顺序：SOULFORGE_TAE_TEMPLATE_PATH 显式环境变量 → 固定候选 → 已挂载
 * 会话兄弟 tools/<一层子目录>/Res/。找不到返回 null，由调用方降级到裸
 * typeId —— 这是可选增强，绝不能把「词条不可用」升级成「TAE 不可用」。
 */
function makeLocateTaeTemplatePathSync(deps: ActionIpcDeps): () => string | null {
  return (): string | null => {
    const probe = (candidate: string): boolean => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    };
    const explicit = process.env.SOULFORGE_TAE_TEMPLATE_PATH?.trim();
    if (explicit) {
      const candidate = resolve(explicit);
      if (probe(candidate)) return candidate;
    }
    for (const candidate of TAE_TEMPLATE_FIXED_CANDIDATES) {
      if (probe(candidate)) return candidate;
    }
    const roots: string[] = [];
    deps.pushToolsSubdirs(roots, deps.activeSession?.layers.baseRoot);
    const overlay = deps.activeSession?.layers.overlayRoot?.trim();
    if (overlay) deps.pushToolsSubdirs(roots, dirname(dirname(overlay)));
    const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
    if (gameRootEnv) deps.pushToolsSubdirs(roots, gameRootEnv);
    for (const root of roots) {
      for (const relative of TAE_TEMPLATE_RELATIVE_CANDIDATES) {
        const candidate = join(root, relative);
        if (probe(candidate)) return candidate;
      }
    }
    return null;
  };
}

/**
 * 惰性读本机 TAE 模板索引并缓存。只读一次（73KB 单文件），每次读 TAE
 * 都重跑会让打开卡顿。空/缺失回 null，不抛 —— 失败降级到裸 typeId。
 */
function makeLoadTaeEventTemplate(
  locateTaeTemplatePathSync: () => string | null
): () => Promise<ReadonlyMap<number, TaeEventTemplateInfo> | null> {
  return async (): Promise<ReadonlyMap<number, TaeEventTemplateInfo> | null> => {
    if (taeTemplateCache) return taeTemplateCache.byEventTypeId;
    const templatePath = locateTaeTemplatePathSync();
    const result = templatePath ? await readTaeEventTemplateFile(templatePath) : null;
    taeTemplateCache = {
      loaded: true,
      byEventTypeId: result?.ok ? result.byEventTypeId : null
    };
    return taeTemplateCache.byEventTypeId;
  };
}

/** read-tae-document 的 bridge options：templateLayouts（无模板时省略）。 */
function taeTemplateLayoutsOption(byEventTypeId: ReadonlyMap<number, TaeEventTemplateInfo> | null) {
  return byEventTypeId
    ? {
        templateLayouts: Object.fromEntries(
          [...byEventTypeId.entries()].map(([id, info]) => [
            String(id),
            info.fields.map((field) => ({ name: field.name, kind: field.kind, slotSize: field.slotSize }))
          ])
        )
      }
    : {};
}

export interface ActionIpcDeps {
  handle: TrustedIpcHandle;
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  readonly activeIndex: WorkspaceIndex | null;
  readonly activeWorkspaceSessionId: string | null;
  safeExists(path: string): boolean;
  pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void;
  asBasicDiagnostics(
    items: Array<{ severity: string; code: string; message: string; sourceUri?: string }>
  ): Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string; sourceUri?: string }>;
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  /** 等待 workspace.scan 的后台 ACTION membership 建立完成。 */
  waitForWorkspaceIndexing?: () => Promise<void>;
}

interface CompatibilityPartCandidate {
  origin: C0000CompatibilityCandidateOrigin;
  name: string;
  absolutePath: string;
}

async function readDirectoryNames(directory: string | null): Promise<string[]> {
  if (!directory) return [];
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const SEKIRO_ANIMATION_BINDER_ID_BASE = 1_000_000_000;
const ACTION_ANIBND_FILE_PATTERN = /\.anibnd(?:\.dcx)?$/i;
const ACTION_CHARACTER_FAMILY_PATTERN = /^c\d{4}$/i;

interface ActionFileRevision {
  key: string;
  mtimeMs: number;
}

interface ActionBinderCandidate {
  origin: 'overlay' | 'base';
  name: string;
  relativePath: string;
  absolutePath: string;
  revisionKey: string;
  physicalRevisionKey: string;
  catalogRevisionKey: string;
}

interface ActionBinderEntry {
  index: number;
  id: number;
  name: string;
  contentHash?: string;
}

type ActionBinderReadResult =
  | { ok: true; candidate: ActionBinderCandidate; entries: ActionBinderEntry[] }
  | { ok: false; candidate: ActionBinderCandidate; diagnostics: Diagnostic[] };

type ActionMotionIdentityResult =
  | { ok: true; motionAnimId: number }
  | { ok: false; diagnostics: Diagnostic[] };

type ActionAnimationContextResult =
  | {
      ok: true;
      sourceUri: string;
      file: IndexedFile;
      session: WorkspaceSession;
      sessionId: string;
      sourceRevision: ActionFileRevision;
      sourceRevisionKey: string;
      sourceCatalogRevisionKey: string;
      effectiveBase: string | null;
      allowedRoots: string[];
      motionAnimId: number;
      binder: ActionBinderCandidate;
      diagnostics: Diagnostic[];
    }
  | { ok: false; diagnostics: Diagnostic[] };

interface ActionDirectoryEntry {
  name: string;
  isFile: boolean;
  isSymbolicLink: boolean;
}

function actionDiagnostic(
  code: string,
  message: string,
  sourceUri?: string,
  details?: unknown
): Diagnostic {
  return {
    severity: 'error',
    code,
    message,
    ...(sourceUri ? { sourceUri } : {}),
    ...(details === undefined ? {} : { details })
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function compareActionNames(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readActionFileRevision(
  absolutePath: string,
  role: 'source' | 'binder',
  sourceUri: string
): Promise<{ ok: true; revision: ActionFileRevision } | { ok: false; diagnostic: Diagnostic }> {
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return {
        ok: false,
        diagnostic: actionDiagnostic(
          role === 'binder' ? 'ACTION_BINDER_MEMBERSHIP_READ_FAILED' : 'ACTION_SOURCE_REVISION_UNAVAILABLE',
          role === 'binder'
            ? 'ANIBND 候选不是普通文件，已拒绝读取 membership。'
            : 'TAE 源文件不是普通文件，无法确认 source revision。',
          sourceUri,
          { role, reason: info.isSymbolicLink() ? 'symbolic-link' : 'not-file' }
        )
      };
    }
    if (!Number.isFinite(info.mtimeMs) || !Number.isFinite(info.size) || !Number.isFinite(info.ctimeMs)) {
      return {
        ok: false,
        diagnostic: actionDiagnostic(
          role === 'binder' ? 'ACTION_BINDER_MEMBERSHIP_READ_FAILED' : 'ACTION_SOURCE_REVISION_UNAVAILABLE',
          role === 'binder'
            ? 'ANIBND 候选的文件 revision 不完整，已拒绝读取 membership。'
            : 'TAE 源文件的 revision 不完整，已拒绝复用旧 identity。',
          sourceUri,
          { role, reason: 'non-finite-stat' }
        )
      };
    }
    return {
      ok: true,
      revision: {
        key: [info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino].join(':'),
        mtimeMs: info.mtimeMs
      }
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: actionDiagnostic(
        role === 'binder' ? 'ACTION_BINDER_MEMBERSHIP_READ_FAILED' : 'ACTION_SOURCE_REVISION_UNAVAILABLE',
        role === 'binder'
          ? '读取 ANIBND 候选的文件 revision 失败，已拒绝复用旧 membership。'
          : '读取 TAE 源文件的 revision 失败，已拒绝复用旧 motion identity。',
        sourceUri,
        { role, errorName: error instanceof Error ? error.name : typeof error }
      )
    };
  }
}

function actionPathInsideRoot(root: string, candidate: string): boolean {
  const relative = relativePath(resolve(root), resolve(candidate));
  return relative.length === 0
    || (!isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${sep}`));
}

function actionPathsEqual(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

export function resolveActionEffectiveBaseRoot(session: WorkspaceSession): string | null {
  const explicit = session.layers.baseRoot?.trim();
  if (explicit && !actionPathsEqual(explicit, session.layers.overlayRoot)) return resolve(explicit);
  const overlayParent = dirname(session.layers.overlayRoot);
  if (actionPathsEqual(overlayParent, session.layers.overlayRoot)) return null;
  return existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'parts'))
    ? resolve(overlayParent)
    : null;
}

function appendActionAllowedRoot(roots: string[], root: string | null): void {
  if (!root) return;
  const normalized = resolve(root);
  if (!roots.some((item) => actionPathsEqual(item, normalized))) roots.push(normalized);
}

function actionCatalogRevisionKey(
  indexedFiles: readonly IndexedFile[],
  absolutePath: string
): string {
  const normalized = resolve(absolutePath).toLowerCase();
  const file = indexedFiles.find((item) => resolve(item.absolutePath).toLowerCase() === normalized);
  return file
    ? `${file.sourceUri}:${file.mtimeMs}:${file.sha256 ?? ''}`
    : 'not-indexed';
}

function actionBinderIdentityUri(candidate: ActionBinderCandidate): string {
  return `action-binder://${candidate.origin}/${candidate.relativePath.replace(/\\/g, '/')}`;
}

function actionBinderCandidateFromMembership(input: {
  match: BinderMembershipMatch;
  session: WorkspaceSession;
  effectiveBase: string | null;
}): { ok: true; candidate: ActionBinderCandidate } | { ok: false; diagnostic: Diagnostic } {
  const sourcePath = typeof input.match.sourcePath === 'string'
    ? input.match.sourcePath.replace(/\\/g, '/')
    : '';
  const sourceLayer = input.match.sourceLayer;
  const origin = sourceLayer === 'overlay' || sourceLayer === 'base' ? sourceLayer : null;
  const sourceRevision = typeof input.match.sourceRevision === 'string'
    ? input.match.sourceRevision
    : '';
  const separator = sourceRevision.indexOf('|');
  const physicalRevisionKey = separator > 0 ? sourceRevision.slice(0, separator) : '';
  const catalogRevisionKey = separator > 0 ? sourceRevision.slice(separator + 1) : '';
  const root = origin === 'overlay'
    ? input.session.layers.overlayRoot
    : origin === 'base'
      ? input.effectiveBase
      : null;
  const relativeSegments = sourcePath.split('/');
  const safeRelative = Boolean(sourcePath)
    && relativeSegments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && relativeSegments[0]?.toLowerCase() === 'chr';
  if (!root || !origin || !safeRelative || !physicalRevisionKey || !catalogRevisionKey) {
    return {
      ok: false,
      diagnostic: actionDiagnostic(
        'ACTION_BINDER_MEMBERSHIP_INDEX_INVALID',
        'WorkspaceIndex 返回的 Binder source identity 不完整，已拒绝从缓存重建容器路径。',
        input.match.sourceUri,
        { sourcePath, sourceLayer, hasRevision: Boolean(sourceRevision) }
      )
    };
  }
  const absolutePath = resolve(join(root, ...relativeSegments));
  if ((origin === 'overlay' && !input.session.isOverlayPath(absolutePath))
    || (origin === 'base' && !input.session.isBasePath(absolutePath) && !actionPathInsideRoot(root, absolutePath))) {
    return {
      ok: false,
      diagnostic: actionDiagnostic(
        'ACTION_BINDER_MEMBERSHIP_INDEX_INVALID',
        'WorkspaceIndex 返回的 Binder source path 越过当前会话 root，已拒绝读取。',
        input.match.sourceUri,
        { sourcePath, sourceLayer }
      )
    };
  }
  const candidate: ActionBinderCandidate = {
    origin,
    name: basename(sourcePath),
    relativePath: sourcePath,
    absolutePath,
    revisionKey: sourceRevision,
    physicalRevisionKey,
    catalogRevisionKey
  };
  if (actionBinderIdentityUri(candidate) !== input.match.sourceUri) {
    return {
      ok: false,
      diagnostic: actionDiagnostic(
        'ACTION_BINDER_MEMBERSHIP_INDEX_INVALID',
        'WorkspaceIndex Binder source URI 与 source path 不一致，已拒绝继续。',
        input.match.sourceUri,
        { sourcePath, sourceLayer }
      )
    };
  }
  return { ok: true, candidate };
}

async function readActionBinderDirectory(
  directory: string | null,
  origin: 'overlay' | 'base',
  characterFamily: string,
  sourceUri: string
): Promise<{ entries: ActionDirectoryEntry[]; diagnostics: Diagnostic[] }> {
  if (!directory) return { entries: [], diagnostics: [] };
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      entries: entries
        .filter((entry) => ACTION_ANIBND_FILE_PATTERN.test(entry.name)
          && canonicalCharacterStemForActionPath(entry.name).toLowerCase() === characterFamily.toLowerCase())
        .sort((left, right) => compareActionNames(left.name, right.name))
        .map((entry) => ({ name: entry.name, isFile: entry.isFile(), isSymbolicLink: entry.isSymbolicLink() })),
      diagnostics: []
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { entries: [], diagnostics: [] };
    return {
      entries: [],
      diagnostics: [actionDiagnostic(
        'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
        `读取 ${origin} 的 chr 目录失败，已拒绝推断 ANIBND membership。`,
        sourceUri,
        { origin, characterFamily, errorName: error instanceof Error ? error.name : typeof error }
      )]
    };
  }
}

async function enumerateActionBinderCandidates(input: {
  session: WorkspaceSession;
  effectiveBase: string | null;
  characterFamily: string;
  sourceUri: string;
  indexedFiles: readonly IndexedFile[];
}): Promise<{ candidates: ActionBinderCandidate[]; diagnostics: Diagnostic[] }> {
  const layers: Array<{ origin: 'overlay' | 'base'; root: string }> = [
    { origin: 'overlay', root: input.session.layers.overlayRoot },
    ...(input.effectiveBase ? [{ origin: 'base' as const, root: input.effectiveBase }] : [])
  ];
  const candidates: ActionBinderCandidate[] = [];
  const diagnostics: Diagnostic[] = [];
  const shadowedPaths = new Set<string>();

  for (const layer of layers) {
    const directory = join(layer.root, 'chr');
    const listed = await readActionBinderDirectory(directory, layer.origin, input.characterFamily, input.sourceUri);
    diagnostics.push(...listed.diagnostics);
    if (listed.diagnostics.length > 0) continue;
    for (const entry of listed.entries) {
      const relative = `chr/${entry.name}`;
      const shadowKey = relative.toLowerCase();
      if (shadowedPaths.has(shadowKey)) continue;
      // Mark an overlay name as shadowing base even if it is malformed or a link;
      // falling through to base would silently change the selected resource.
      shadowedPaths.add(shadowKey);
      const absolutePath = resolve(join(directory, entry.name));
      const contained = layer.origin === 'overlay'
        ? input.session.isOverlayPath(absolutePath)
        : (input.session.isBasePath(absolutePath) || actionPathInsideRoot(layer.root, absolutePath));
      if (!contained) {
        diagnostics.push(actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
          'ANIBND 候选路径不在当前会话允许的 root 内，已拒绝读取。',
          input.sourceUri,
          { origin: layer.origin, relativePath: relative, reason: 'path-containment' }
        ));
        continue;
      }
      if (!entry.isFile || entry.isSymbolicLink) {
        diagnostics.push(actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
          'ANIBND 候选不是普通文件，已拒绝读取并保持 overlay shadow。',
          input.sourceUri,
          { origin: layer.origin, relativePath: relative, reason: entry.isSymbolicLink ? 'symbolic-link' : 'not-file' }
        ));
        continue;
      }
      const revision = await readActionFileRevision(absolutePath, 'binder', input.sourceUri);
      if (!revision.ok) {
        diagnostics.push(revision.diagnostic);
        continue;
      }
      const catalogRevisionKey = actionCatalogRevisionKey(input.indexedFiles, absolutePath);
      candidates.push({
        origin: layer.origin,
        name: entry.name,
        relativePath: relative,
        absolutePath,
        revisionKey: `${revision.revision.key}|${catalogRevisionKey}`,
        physicalRevisionKey: revision.revision.key,
        catalogRevisionKey
      });
    }
  }

  return { candidates, diagnostics };
}

function parseActionBinderEntries(data: unknown, sourceUri: string): ActionBinderEntry[] | Diagnostic {
  const envelope = asRecord(data);
  const nested = asRecord(envelope?.nested);
  if (nested?.format !== 'BND4' || !Array.isArray(nested.entries)) {
    return actionDiagnostic(
      'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
      'Bridge 返回的 ANIBND 不是可验证的 BND4 membership envelope。',
      sourceUri,
      { reason: 'missing-bnd4-envelope' }
    );
  }
  const entries: ActionBinderEntry[] = [];
  for (const raw of nested.entries) {
    const record = asRecord(raw);
    const index = asSafeInteger(record?.index);
    const id = asSafeInteger(record?.id);
    const name = typeof record?.name === 'string' ? record.name : null;
    if (index === null || index < 0 || id === null || !name) {
      return actionDiagnostic(
        'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
        'Bridge 返回的 BND4 entry identity 不完整，已拒绝推断 membership。',
        sourceUri,
        { reason: 'invalid-entry-identity' }
      );
    }
    entries.push({
      index,
      id,
      name,
      ...(typeof record?.contentHash === 'string' ? { contentHash: record.contentHash } : {})
    });
  }
  return entries;
}

async function readActionBinderDocument(input: {
  candidate: ActionBinderCandidate;
  sourceUri: string;
  allowedRoots: string[];
  effectiveBase: string | null;
  sessionId: string;
}): Promise<ActionBinderReadResult> {
  try {
    const result = await runBridge<{ nested?: unknown }>({
      command: 'read-dcx-document',
      filePath: input.candidate.absolutePath,
      resourceUri: input.sourceUri,
      allowedRoots: input.allowedRoots,
      timeoutMs: 120_000,
      ...(input.effectiveBase ? { oodleRuntimeRoot: input.effectiveBase } : {}),
      workspaceSessionId: input.sessionId
    });
    if (result.parseStatus === 'failed' || !result.data) {
      return {
        ok: false,
        candidate: input.candidate,
        diagnostics: [
          actionDiagnostic(
            'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
            'Bridge 读取 ANIBND membership 失败，已拒绝继续定位动画。',
            input.sourceUri,
            {
              relativePath: input.candidate.relativePath,
              origin: input.candidate.origin,
              bridgeCodes: result.diagnostics.map((diagnostic) => diagnostic.code)
            }
          ),
          ...result.diagnostics
        ]
      };
    }
    const parsed = parseActionBinderEntries(result.data, input.sourceUri);
    if (!Array.isArray(parsed)) {
      return { ok: false, candidate: input.candidate, diagnostics: [parsed, ...result.diagnostics] };
    }
    const after = await readActionFileRevision(input.candidate.absolutePath, 'binder', input.sourceUri);
    if (!after.ok) {
      return { ok: false, candidate: input.candidate, diagnostics: [after.diagnostic] };
    }
    if (after.revision.key !== input.candidate.physicalRevisionKey) {
      return {
        ok: false,
        candidate: input.candidate,
        diagnostics: [actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
          'ANIBND 在 Bridge 读取期间发生 source revision 变化，已丢弃本次 membership。',
          input.sourceUri,
          { relativePath: input.candidate.relativePath, reason: 'changed-during-read' }
        )]
      };
    }
    return { ok: true, candidate: input.candidate, entries: parsed };
  } catch (error) {
    return {
      ok: false,
      candidate: input.candidate,
      diagnostics: [actionDiagnostic(
        'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
        '读取 ANIBND membership 时发生未预期错误，已 fail-closed。',
        input.sourceUri,
        { relativePath: input.candidate.relativePath, errorName: error instanceof Error ? error.name : typeof error }
      )]
    };
  }
}

async function discoverActionCharacterFamilies(input: {
  session: WorkspaceSession;
  effectiveBase: string | null;
  indexedFiles: readonly IndexedFile[];
}): Promise<{ families: string[]; diagnostics: Diagnostic[] }> {
  const families = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const file of input.indexedFiles) {
    if (ACTION_ANIBND_FILE_PATTERN.test(file.relativePath)) {
      const family = canonicalCharacterStemForActionPath(file.relativePath).toLowerCase();
      if (ACTION_CHARACTER_FAMILY_PATTERN.test(family)) families.add(family);
    }
  }
  const layers: Array<{ origin: 'overlay' | 'base'; root: string }> = [
    { origin: 'overlay', root: input.session.layers.overlayRoot },
    ...(input.effectiveBase ? [{ origin: 'base' as const, root: input.effectiveBase }] : [])
  ];
  for (const layer of layers) {
    const directory = join(layer.root, 'chr');
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!ACTION_ANIBND_FILE_PATTERN.test(entry.name)) continue;
        const family = canonicalCharacterStemForActionPath(entry.name).toLowerCase();
        if (ACTION_CHARACTER_FAMILY_PATTERN.test(family)) families.add(family);
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        diagnostics.push(actionDiagnostic(
          'ACTION_BINDER_INDEX_BUILD_FAILED',
          `读取 ${layer.origin} 的 chr 目录失败，无法建立完整 ACTION Binder membership index。`,
          `action-index://${layer.origin}/chr`,
          { origin: layer.origin, errorName: error instanceof Error ? error.name : typeof error }
        ));
      }
    }
  }
  return { families: [...families].sort(compareActionNames), diagnostics };
}

export interface ActionBinderMembershipIndexBuildResult {
  ok: boolean;
  characterFamilies: string[];
  candidates: BinderMembershipCandidate[];
  diagnostics: Diagnostic[];
}

/**
 * Build the complete ACTION Binder membership projection during workspace
 * indexing. The playback IPC path must consume this projection and must not
 * enumerate sibling ANIBND files or parse membership on demand.
 */
export async function buildActionBinderMembershipIndex(input: {
  session: WorkspaceSession;
  sessionId: string;
  effectiveBase: string | null;
  indexedFiles: readonly IndexedFile[];
  allowedRoots: readonly string[];
}): Promise<ActionBinderMembershipIndexBuildResult> {
  const discovered = await discoverActionCharacterFamilies(input);
  const diagnostics = [...discovered.diagnostics];
  const candidates: BinderMembershipCandidate[] = [];
  const allowedRoots = [...input.allowedRoots];
  appendActionAllowedRoot(allowedRoots, input.effectiveBase);

  for (const characterFamily of discovered.families) {
    const indexSourceUri = `action-index://${characterFamily}`;
    const plan = await enumerateActionBinderCandidates({
      session: input.session,
      effectiveBase: input.effectiveBase,
      characterFamily,
      sourceUri: indexSourceUri,
      indexedFiles: input.indexedFiles
    });
    diagnostics.push(...plan.diagnostics);
    for (const candidate of plan.candidates) {
      const sourceUri = actionBinderIdentityUri(candidate);
      const read = await readActionBinderDocument({
        candidate,
        sourceUri,
        allowedRoots,
        effectiveBase: input.effectiveBase,
        sessionId: input.sessionId
      });
      if (!read.ok) {
        diagnostics.push(...read.diagnostics);
        continue;
      }
      candidates.push({
        characterFamily,
        source: {
          sourceUri,
          sourcePath: candidate.relativePath,
          sourceRevision: candidate.revisionKey,
          sourceLayer: candidate.origin
        },
        entries: read.entries.map((entry) => ({
          entryId: entry.id,
          entryIndex: entry.index,
          entryName: entry.name
        }))
      });
    }
  }

  return {
    ok: diagnostics.length === 0,
    characterFamilies: discovered.families,
    candidates,
    diagnostics
  };
}

function findIndexedActionMotionIdentity(
  index: WorkspaceIndex | null,
  sourceUri: string,
  animId: number,
  sourceRevision: ActionFileRevision
): number | undefined {
  const lookup = index?.lookupTaeAnimation(sourceUri, animId);
  if (!lookup || lookup.status !== 'UNIQUE' || lookup.sourceRevision !== sourceRevision.mtimeMs) return undefined;
  const motionAnimId = lookup.animation.motionAnimId;
  return typeof motionAnimId === 'number'
    && Number.isSafeInteger(motionAnimId)
    && motionAnimId >= 0
    && motionAnimId < SEKIRO_ANIMATION_BINDER_ID_BASE
    ? motionAnimId
    : undefined;
}

/**
 * 角色 FLVER 的纹理不是 FLVER 内嵌资源：chrbnd 通常配套同名 texbnd，
 * partsbnd 还会共享 parts/common_body.tpf。只把真实存在且位于 Bridge
 * allowed roots 的候选传给 Bridge，避免 renderer 猜本机绝对路径。
 */
export function characterTexturePackagePaths(modelPath: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (!existsSync(candidate)) return;
    if (!candidates.some((path) => path.toLowerCase() === candidate.toLowerCase())) {
      candidates.push(candidate);
    }
  };
  const lower = modelPath.toLowerCase();
  if (lower.endsWith('.chrbnd.dcx')) {
    const stem = modelPath.slice(0, -'.chrbnd.dcx'.length);
    add(`${stem}.texbnd.dcx`);
    add(`${stem}.texbnd`);
  } else if (lower.endsWith('.chrbnd')) {
    const stem = modelPath.slice(0, -'.chrbnd'.length);
    add(`${stem}.texbnd`);
    add(`${stem}.texbnd.dcx`);
  }
  if (basename(dirname(modelPath)).toLowerCase() === 'parts') {
    add(join(dirname(modelPath), 'common_body.tpf.dcx'));
    add(join(dirname(modelPath), 'common_body.tpf'));
  }
  return candidates;
}

export async function assembleC0000CompatibilityPreview(input: {
  leaderBundle: CharacterPreviewBundle;
  overlayPartsDirectory: string;
  basePartsDirectory: string | null;
  allowedRoots: string[];
  oodleRuntimeRoot: string | null;
}): Promise<{ bundle: CharacterPreviewBundle | null; diagnostics: Diagnostic[] }> {
  const leader = input.leaderBundle.models.find((model) => model.modelId === input.leaderBundle.leaderModelId)
    ?? input.leaderBundle.models[0];
  if (!leader || leader.bones.length === 0) {
    return {
      bundle: null,
      diagnostics: [{
        severity: 'warning',
        code: 'ACTION_COMPATIBILITY_PREVIEW_LEADER_MISSING',
        message: 'c0000 兼容预览缺少可用的 leader 骨骼，无法装配身体部件。'
      }]
    };
  }

  const [overlayNames, baseNames] = await Promise.all([
    readDirectoryNames(input.overlayPartsDirectory),
    readDirectoryNames(input.basePartsDirectory)
  ]);
  const selectedModels: FlverPreviewModel[] = [];
  const selectedParts: string[] = [];
  const missingSlots: string[] = [];
  let attemptedCandidates = 0;
  let rejectedCandidates = 0;

  for (const slot of C0000_COMPATIBILITY_PART_SLOTS) {
    const candidates: CompatibilityPartCandidate[] = planC0000CompatibilityCandidates(
      slot,
      overlayNames,
      baseNames
    ).map((candidate) => ({
      ...candidate,
      absolutePath: join(
        candidate.origin === 'overlay' ? input.overlayPartsDirectory : input.basePartsDirectory!,
        candidate.name
      )
    }));
    let selected = false;
    for (const candidate of candidates) {
      attemptedCandidates += 1;
      try {
        const partResult = await runBridge<unknown>({
          command: 'read-chrbnd-flver-preview',
          filePath: candidate.absolutePath,
          allowedRoots: input.allowedRoots,
          timeoutMs: 120_000,
          ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
          commandOptions: {
            maxVertices: 1_000_000,
            maxIndices: 3_000_000,
            texturePackagePaths: characterTexturePackagePaths(candidate.absolutePath)
          }
        });
        if (partResult.parseStatus === 'failed'
          || !isCharacterPreviewBundle(partResult.data)
          || partResult.data.meshCount === 0) {
          rejectedCandidates += 1;
          continue;
        }
        const trial = remapCharacterBundleToLeader(leader, partResult.data.models);
        if (!trial.ok || !trial.bundle || trial.bundle.meshCount <= leader.meshCount) {
          rejectedCandidates += 1;
          continue;
        }
        selectedModels.push(...partResult.data.models);
        selectedParts.push(`parts/${candidate.name}`);
        selected = true;
        break;
      } catch {
        rejectedCandidates += 1;
      }
    }
    if (!selected) missingSlots.push(slot);
  }

  if (selectedModels.length === 0) {
    return {
      bundle: null,
      diagnostics: [{
        severity: 'warning',
        code: 'ACTION_COMPATIBILITY_PREVIEW_UNAVAILABLE',
         message: 'c0000 本体只含骨骼；在有界的 bd/am/lg/hd 候选中没有找到可通过骨骼映射的身体部件。当前只能显示骨架，这不代表存档装备。',
        details: { attemptedCandidates, rejectedCandidates, missingSlots }
      }]
    };
  }

  const assembled = remapCharacterBundleToLeader(leader, selectedModels);
  if (!assembled.ok || !assembled.bundle) {
    return {
      bundle: null,
      diagnostics: assembled.diagnostics.length > 0
        ? assembled.diagnostics
        : [{
            severity: 'warning',
            code: 'ACTION_COMPATIBILITY_PREVIEW_REMAP_FAILED',
            message: 'c0000 兼容预览的身体部件无法安全映射到 leader 骨骼。'
          }]
    };
  }

  return {
    bundle: {
      ...assembled.bundle,
      assemblyMode: 'compatibility-preview',
      assemblyParts: selectedParts
    },
    diagnostics: [{
      severity: 'warning',
      code: 'ACTION_COMPATIBILITY_PREVIEW_ASSEMBLED',
       message: `c0000 本体只含骨骼；当前按 overlay 优先、文件名字典序从 bd/am/lg/hd 的有界候选中装配兼容预览（${selectedParts.join('、')}）。这不是存档当前装备。`,
      details: { attemptedCandidates, rejectedCandidates, selectedParts, missingSlots }
    }]
  };
}

export function registerActionIpcHandlers(deps: ActionIpcDeps): void {
  const locateTaeTemplatePathSync = makeLocateTaeTemplatePathSync(deps);
  const loadTaeEventTemplate = makeLoadTaeEventTemplate(locateTaeTemplatePathSync);

  // ACTION 的播放时缓存只缓存「已由 Bridge 读取过的 TAE motion identity」。
  // Binder membership 属于 WorkspaceIndex 的建立期投影；播放 handler 不得
  // 在这里临时枚举 sibling ANIBND 或读取 BND4。
  const taeMotionIdentityCache = new ActionMotionIdentityCache<Promise<ActionMotionIdentityResult>>();
  let actionCacheScopeKey: string | null = null;

  const syncActionCacheScope = (session: WorkspaceSession, effectiveBase: string | null, sessionId: string): void => {
    const scopeKey = [
      sessionId,
      resolve(session.layers.overlayRoot).toLowerCase(),
      effectiveBase ? resolve(effectiveBase).toLowerCase() : '<no-base>'
    ].join('|');
    if (actionCacheScopeKey === scopeKey) return;
    actionCacheScopeKey = scopeKey;
    taeMotionIdentityCache.clear();
  };

  const sessionChangedDiagnostic = (sourceUri: string): Diagnostic => ({
    severity: 'error',
    code: 'ACTION_WORKSPACE_SESSION_CHANGED',
    message: '工作区会话在 ACTION 读取期间发生变化，已丢弃旧 session 的结果。',
    sourceUri,
    details: { reason: 'session-id-or-object-changed' }
  });

  const resolveTaeMotionIdentity = async (input: {
    sourceUri: string;
    file: IndexedFile;
    session: WorkspaceSession;
    sessionId: string;
    animId: number;
    sourceRevision: ActionFileRevision;
    sourceRevisionKey: string;
    allowedRoots: string[];
    effectiveBase: string | null;
  }): Promise<ActionMotionIdentityResult> => {
    const cached = taeMotionIdentityCache.get(input.sourceUri, input.sourceRevisionKey, input.animId);
    if (cached) return cached;

    const promise = (async (): Promise<ActionMotionIdentityResult> => {
      try {
        const indexed = findIndexedActionMotionIdentity(
          deps.activeIndex,
          input.sourceUri,
          // The caller validates this before entering the resolver.
          input.animId,
          input.sourceRevision
        );
        if (indexed !== undefined) return { ok: true, motionAnimId: indexed };

        const result = await runBridge<Record<string, unknown>>({
          command: 'read-tae-document',
          filePath: input.file.absolutePath,
          resourceUri: input.sourceUri,
          allowedRoots: input.allowedRoots,
          timeoutMs: 120_000,
          ...(input.effectiveBase ? { oodleRuntimeRoot: input.effectiveBase } : {}),
          workspaceSessionId: input.sessionId
        });
        if (result.parseStatus === 'failed' || !result.data) {
          return {
            ok: false,
            diagnostics: [
              actionDiagnostic(
                'TAE_MOTION_IDENTITY_READ_FAILED',
                'Bridge 读取 TAE motion identity 失败，已拒绝回退到 animId。',
                input.sourceUri,
                { animId: input.animId, bridgeCodes: result.diagnostics.map((diagnostic) => diagnostic.code) }
              ),
              ...result.diagnostics
            ]
          };
        }
        const data = asRecord(result.data);
        if (!data || data.animationsTruncated === true || !Array.isArray(data.animations)) {
          return {
            ok: false,
            diagnostics: [actionDiagnostic(
              'TAE_MOTION_IDENTITY_UNRESOLVED',
              'TAE motion identity 数据缺失或被截断，已拒绝回退到 animId。',
              input.sourceUri,
              { animId: input.animId, animationsTruncated: data?.animationsTruncated === true }
            )]
          };
        }
        const matches = data.animations.filter((raw) => {
          const animation = asRecord(raw);
          return asSafeInteger(animation?.animId) === input.animId;
        });
        if (matches.length > 1) {
          return {
            ok: false,
            diagnostics: [actionDiagnostic(
              'TAE_MOTION_IDENTITY_AMBIGUOUS',
              'TAE 返回多个相同 animId，motion identity 不唯一，已拒绝继续。',
              input.sourceUri,
              { animId: input.animId, matchCount: matches.length }
            )]
          };
        }
        const motionAnimId = matches.length === 1
          ? asSafeInteger(asRecord(matches[0])?.motionAnimId)
          : null;
        if (motionAnimId === null || motionAnimId < 0 || motionAnimId >= SEKIRO_ANIMATION_BINDER_ID_BASE) {
          return {
            ok: false,
            diagnostics: [actionDiagnostic(
              'TAE_MOTION_IDENTITY_UNRESOLVED',
              'TAE 没有可安全使用的 motionAnimId，禁止把选中 animId 当作 HKX ID。',
              input.sourceUri,
              { animId: input.animId }
            )]
          };
        }

        // 只把当前 source revision 的 Bridge 读结果投影回既有 index；这不是
        // 第二套 parser，下一次读取仍以 Bridge envelope 为源。注入 revision
        // 只是 desktop 在 core 尚未提供 source-revision 参数时的最小适配。
        if (deps.activeSession === input.session
          && deps.activeWorkspaceSessionId === input.sessionId
          && deps.activeIndex) {
          ingestBridgeResult(deps.activeIndex, {
            sourceUri: input.sourceUri,
            sourcePath: input.file.relativePath,
            game: input.file.game,
            resourceKind: 'action',
            parseStatus: 'parsed',
            diagnostics: deps.asBasicDiagnostics(result.diagnostics),
            data: { ...data, sourceRevision: input.sourceRevision.mtimeMs }
          });
        }
        return { ok: true, motionAnimId };
      } catch (error) {
        return {
          ok: false,
          diagnostics: [actionDiagnostic(
            'TAE_MOTION_IDENTITY_READ_FAILED',
            '读取 TAE motion identity 时发生未预期错误，已 fail-closed。',
            input.sourceUri,
            { animId: input.animId, errorName: error instanceof Error ? error.name : typeof error }
          )]
        };
      }
    })();
    // Keep source URI, source revision, and selected animId in the identity;
    // a TAE file is a multi-animation source and cannot cache one motion per URI.
    taeMotionIdentityCache.set(input.sourceUri, input.sourceRevisionKey, input.animId, promise);
    return promise;
  };

  const resolveActionAnimationContext = async (
    sourceUri: string,
    animId: number
  ): Promise<ActionAnimationContextResult> => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    const session = deps.activeSession;
    const sessionId = deps.activeWorkspaceSessionId?.trim();
    if (!file || !session) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'RESOURCE_NOT_INDEXED',
          '资源未索引或工作区未打开，无法解析 ACTION motion identity。',
          sourceUri
        )]
      };
    }
    if (!sessionId) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_WORKSPACE_SESSION_UNAVAILABLE',
          '当前工作区缺少 session identity，已拒绝使用可能过期的 ACTION membership。',
          sourceUri
        )]
      };
    }
    if (!Number.isSafeInteger(animId) || animId < 0) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_ANIM_ID_INVALID',
          'ACTION animId 必须是非负 safe integer。',
          sourceUri,
          { animId }
        )]
      };
    }
    const sourcePath = resolve(file.absolutePath);
    if (!session.isOverlayPath(sourcePath) && !session.isBasePath(sourcePath)) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_SOURCE_PATH_OUTSIDE_SESSION',
          'TAE 源文件不在当前工作区会话允许的 overlay/base 内，已拒绝读取。',
          sourceUri,
          { relativePath: file.relativePath }
        )]
      };
    }

    const sourceRevisionResult = await readActionFileRevision(sourcePath, 'source', sourceUri);
    if (!sourceRevisionResult.ok) return { ok: false, diagnostics: [sourceRevisionResult.diagnostic] };
    const sourceCatalogRevisionKey = actionCatalogRevisionKey(deps.indexedFiles, sourcePath);
    const sourceRevisionKey = `${sourceRevisionResult.revision.key}|${sourceCatalogRevisionKey}`;

    const roots = await deps.verifiedReadRoots(session, dirname(sourcePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const effectiveBase = resolveActionEffectiveBaseRoot(session);
    appendActionAllowedRoot(roots.allowedRoots, effectiveBase);
    if (deps.activeSession !== session || deps.activeWorkspaceSessionId !== sessionId) {
      return { ok: false, diagnostics: [sessionChangedDiagnostic(sourceUri)] };
    }

    const characterFamily = canonicalCharacterStemForActionPath(file.relativePath).toLowerCase();
    if (!ACTION_CHARACTER_FAMILY_PATTERN.test(characterFamily)) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_CHARACTER_FAMILY_UNRESOLVED',
          'TAE 路径无法解析为 cXXXX character family，已拒绝跨角色扫描 ANIBND。',
          sourceUri,
          { relativePath: file.relativePath }
        )]
      };
    }
    syncActionCacheScope(session, effectiveBase, sessionId);

    const motionIdentity = await resolveTaeMotionIdentity({
      sourceUri,
      file,
      session,
      sessionId,
      animId,
      sourceRevision: sourceRevisionResult.revision,
      sourceRevisionKey,
      allowedRoots: [...roots.allowedRoots],
      effectiveBase
    });
    if (!motionIdentity.ok) return motionIdentity;
    if (deps.activeSession !== session || deps.activeWorkspaceSessionId !== sessionId) {
      return { ok: false, diagnostics: [sessionChangedDiagnostic(sourceUri)] };
    }

    let actionIndex = deps.activeIndex;
    if (!actionIndex || !actionIndex.isActionBinderMembershipReady()) {
      // workspace.scan 先让轻量文件列表可见，再异步哈希并建立 Binder
      // membership。等待这一个受控任务，禁止在播放阶段临时扫描 sibling ANIBND。
      await deps.waitForWorkspaceIndexing?.();
      if (deps.activeSession !== session || deps.activeWorkspaceSessionId !== sessionId) {
        return { ok: false, diagnostics: [sessionChangedDiagnostic(sourceUri)] };
      }
      actionIndex = deps.activeIndex;
    }
    if (!actionIndex || !actionIndex.isActionBinderMembershipReady()) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_INDEX_NOT_READY',
          'ACTION Binder membership 尚未由 workspace index 完整建立，播放阶段拒绝临时扫描 sibling ANIBND。',
          sourceUri,
          { characterFamily, motionAnimId: motionIdentity.motionAnimId }
        )]
      };
    }

    const membership = actionIndex.lookupActionBinderMembership({
      characterFamily,
      binderEntryId: SEKIRO_ANIMATION_BINDER_ID_BASE + motionIdentity.motionAnimId
    });
    if (membership.diagnostics.length > 0) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_READ_FAILED',
          'Binder membership identity 校验失败，已拒绝继续读取动画。',
          sourceUri,
          { diagnostics: membership.diagnostics }
        )]
      };
    }
    if (membership.status === 'NOT_FOUND') {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_NOT_FOUND',
          `ANIBND membership 中没有 motionAnimId=${motionIdentity.motionAnimId} 的唯一 entry。`,
          sourceUri,
          {
            characterFamily,
            motionAnimId: motionIdentity.motionAnimId,
            candidates: membership.consideredSources.map((candidate) => ({
              sourceUri: candidate.source.sourceUri,
              sourcePath: candidate.source.sourcePath,
              sourceLayer: candidate.source.sourceLayer
            }))
          }
        )]
      };
    }
    if (membership.status === 'AMBIGUOUS') {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_AMBIGUOUS',
          `motionAnimId=${motionIdentity.motionAnimId} 在同 character family 的 ANIBND membership 中出现多个匹配，已拒绝猜测。`,
          sourceUri,
          {
            characterFamily,
            motionAnimId: motionIdentity.motionAnimId,
            matches: membership.matches.map((match) => ({
              sourceUri: match.sourceUri,
              entryIndex: match.entryIndex,
              entryId: match.binderEntryId,
              entryName: match.entryName
            }))
          }
        )]
      };
    }
    if (deps.activeSession !== session || deps.activeWorkspaceSessionId !== sessionId) {
      return { ok: false, diagnostics: [sessionChangedDiagnostic(sourceUri)] };
    }
    const membershipMatch = membership.match;
    const resolvedCandidate = actionBinderCandidateFromMembership({
      match: membershipMatch,
      session,
      effectiveBase
    });
    if (!resolvedCandidate.ok) {
      return {
        ok: false,
        diagnostics: [resolvedCandidate.diagnostic]
      };
    }
    return {
      ok: true,
      sourceUri,
      file,
      session,
      sessionId,
      sourceRevision: sourceRevisionResult.revision,
      sourceRevisionKey,
      sourceCatalogRevisionKey,
      effectiveBase,
      allowedRoots: roots.allowedRoots,
      motionAnimId: motionIdentity.motionAnimId,
      binder: resolvedCandidate.candidate,
      diagnostics: [{
        severity: 'info',
        code: 'ACTION_BINDER_MEMBERSHIP_UNIQUE',
        message: `ACTION motion identity 已由 WorkspaceIndex 唯一定位到 ${resolvedCandidate.candidate.relativePath} 的 BND4 entry。`,
        sourceUri,
        details: {
          characterFamily,
          motionAnimId: motionIdentity.motionAnimId,
          entryIndex: membershipMatch.entryIndex,
          entryId: membershipMatch.binderEntryId,
          entryName: membershipMatch.entryName,
          origin: resolvedCandidate.candidate.origin,
          relativePath: resolvedCandidate.candidate.relativePath,
          authority: 'workspace-index'
        }
      }]
    };
  };

  const validateActionContextCurrent = async (
    context: Extract<ActionAnimationContextResult, { ok: true }>
  ): Promise<Diagnostic[]> => {
    if (deps.activeSession !== context.session || deps.activeWorkspaceSessionId !== context.sessionId) {
      return [sessionChangedDiagnostic(context.sourceUri)];
    }
    const sourceRevision = await readActionFileRevision(context.file.absolutePath, 'source', context.sourceUri);
    if (!sourceRevision.ok) return [sourceRevision.diagnostic];
    if (sourceRevision.revision.key !== context.sourceRevision.key
      || actionCatalogRevisionKey(deps.indexedFiles, context.file.absolutePath) !== context.sourceCatalogRevisionKey) {
      return [actionDiagnostic(
        'ACTION_SOURCE_REVISION_CHANGED',
        'TAE source revision 在动画读取前发生变化，已丢弃旧 motion identity。',
        context.sourceUri,
        { relativePath: context.file.relativePath }
      )];
    }
    const binderRevision = await readActionFileRevision(context.binder.absolutePath, 'binder', context.sourceUri);
    if (!binderRevision.ok) return [binderRevision.diagnostic];
    if (binderRevision.revision.key !== context.binder.physicalRevisionKey
      || actionCatalogRevisionKey(deps.indexedFiles, context.binder.absolutePath) !== context.binder.catalogRevisionKey) {
      return [actionDiagnostic(
        'ACTION_BINDER_SOURCE_REVISION_CHANGED',
        'ANIBND source revision 在动画读取前发生变化，已拒绝复用旧 membership。',
        context.sourceUri,
        { relativePath: context.binder.relativePath }
      )];
    }
    return [];
  };

  deps.handle('resource.readTaeDocument', async (_event, sourceUri: string, options?: { animationPage?: number; animationPageSize?: number }) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    // S17：DSAS 模板（本机只读，可选增强）→ templateLayouts 给 Bridge 解码参数体。
    const byEventTypeId = await loadTaeEventTemplate();
    const paginationOptions: Record<string, unknown> = {};
    if (typeof options?.animationPage === 'number' && Number.isFinite(options.animationPage) && options.animationPage >= 0) {
      paginationOptions.animationPage = Math.floor(options.animationPage);
    }
    if (typeof options?.animationPageSize === 'number' && Number.isFinite(options.animationPageSize) && options.animationPageSize > 0) {
      paginationOptions.animationPageSize = Math.floor(options.animationPageSize);
    }
    const templateLayoutsCommandOptions = taeTemplateLayoutsOption(byEventTypeId) as Record<string, unknown> | null;
    const mergedCommandOptions = {
      ...(templateLayoutsCommandOptions ? { templateLayouts: (templateLayoutsCommandOptions as { templateLayouts: unknown }).templateLayouts } : {}),
      ...paginationOptions
    } as Record<string, unknown>;
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tae-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(Object.keys(mergedCommandOptions).length ? { commandOptions: mergedCommandOptions } : {}),
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    // 问题 6-C：打开 anibnd 成功读到 TAE 信封时 ingest 一次（最小 hunk，renderer
    // 不建索引）。envelope 采样截断（animationsTruncated / eventsTruncated）时
    // ingestBridgeResult 会按缺口 4 fail-closed 拒绝，不把残缺当完整；这里不因
    // 索引结果改变 IPC 返回。
    if (result.parseStatus !== 'failed' && result.data && deps.activeIndex) {
      ingestBridgeResult(deps.activeIndex, {
        sourceUri,
        sourcePath: file.relativePath,
        game: file.game,
        resourceKind: 'action',
        parseStatus: 'parsed',
        diagnostics: deps.asBasicDiagnostics(result.diagnostics),
        data: result.data
      });
    }
    // 事件类型名表（`0 JumpTable` 的「类型名」）：只投影文档实际出现过的
    // eventTypeId，模板缺的 id 不出现，渲染器回退裸 `{typeId}`。
    let eventTypeNames: Record<string, string> | undefined;
    if (result.parseStatus !== 'failed' && result.data && byEventTypeId) {
      const data = result.data as { eventTypes?: number[] };
      const present = (data.eventTypes ?? []).filter(
        (id): id is number => byEventTypeId.has(id)
      );
      if (present.length > 0) {
        eventTypeNames = Object.fromEntries(
          present.map((id) => [String(id), byEventTypeId.get(id)!.name])
        );
      }
    }
    return sanitizeRendererValue({
      ok: result.parseStatus !== 'failed',
      sourceUri,
      relativePath: file.relativePath,
      data: result.data,
      ...(eventTypeNames ? { eventTypeNames } : {}),
      diagnostics: result.diagnostics
    });
  });

  /**
   * S17：词条名目录。main 从本机 TAE.Template.SDT.xml 解析 eventTypeId → 名称；
   */
  deps.handle('resource.readTaeTemplateCatalog', async (): Promise<{
    ok: boolean;
    origin: 'imported' | 'unavailable';
    events: Array<{ eventTypeId: number; name: string }>;
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => {
    const catalog = getTaeTemplateCatalog();
    // handle() 包装器统一 sanitize；这里只组装结构化结果。
    return {
      ok: catalog.origin === 'imported',
      origin: catalog.origin,
      events: [...catalog.events.entries()].map(([eventTypeId, def]) => ({ eventTypeId, name: def.name })),
      diagnostics: [...catalog.diagnostics]
    };
  });

  /**
   * S17：单个词条事件的参数体。main 按本机模板布局给 Bridge 参数长度，Bridge
   * 原生截取参数体字节（越界失败关闭），main 再按布局解码字段（little-endian）。
   * 无模板类型：返回未解码 + 原始 hex，不编造字段含义。
   */
  deps.handle(
    'resource.readTaeEventParams',
    async (
      _event,
      sourceUri: string,
      animId: number,
      eventIndex: number
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: {
        eventTypeId: number;
        templateName: string | null;
        fields: Array<{ name: string; type: string; value: string }>;
        tailHex: string | null;
        undecodedHex: string | null;
      };
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE 事件参数。', sourceUri }] };
      }
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const catalog = getTaeTemplateCatalog();
      // 第一读：paramSize 缺省 → Bridge 给前 16 字节，拿到 eventTypeId。
      const result = await runBridge<{
        eventTypeId?: number;
        paramHex?: string;
        paramSize?: number;
      }>({
        command: 'read-tae-event-params',
        filePath: file.absolutePath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(deps.activeSession?.layers.baseRoot
          ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
          : {}),
        commandOptions: { animId, eventIndex }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, diagnostics: result.diagnostics };
      }
      const eventTypeId = result.data.eventTypeId ?? -1;
      const def = catalog.events.get(eventTypeId);
      // 有模板且模板大小 ≠ 16：按模板长度重读参数体（16 字节时第一读已够）。
      const paramSize = def?.paramSize ?? 0;
      const needsExactRead = paramSize > 0 && paramSize !== 16;
      const exact = needsExactRead
        ? await runBridge<{ paramHex?: string }>({
            command: 'read-tae-event-params',
            filePath: file.absolutePath,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 120_000,
            ...(deps.activeSession?.layers.baseRoot
              ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
              : {}),
            commandOptions: { animId, eventIndex, paramSize }
          })
        : null;
      if (exact && (exact.parseStatus === 'failed' || !exact.data?.paramHex)) {
        return { ok: false, diagnostics: exact.diagnostics };
      }
      const paramHex = exact?.data?.paramHex ?? result.data.paramHex ?? '';
      const decoded = decodeTaeParamFields(def, paramHex);
      // handle() 包装器统一 sanitize；这里只组装结构化结果。
      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: {
          eventTypeId,
          templateName: def?.name ?? null,
          fields: decoded ?? [],
          // 模板字段之外的尾部字节（模板大小与实测参数体不一致时可见，不丢弃）。
          tailHex: decoded ? (paramHex.slice(decoded.length * 2) || null) : null,
          undecodedHex: def && def.paramSize > 0 ? null : (paramHex || null)
        },
        diagnostics: [...result.diagnostics, ...(exact?.diagnostics ?? [])]
      };
    }
  );

  /**
   * S17：动作预览挂模型。按 anibnd 推断伴生 chrbnd（overlay 同目录 → 已挂原版
   * 同相对路径），Bridge 解 DCX→BND4→首个 .flver 条目并提取网格/骨骼/挂点。
   * renderer 只拿投影数据，绝对路径不出 main。
   */
  deps.handle(
    'resource.readTaeChrbndPreview',
    async (
      _event,
      sourceUri: string
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: CharacterPreviewBundle;
      diagnostics: Diagnostic[];
    }> => {
      _forensicsActionInc('action:main:readTaeChrbndPreview:count');
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引或工作区未打开，无法定位伴生 chrbnd。', sourceUri }] };
      }
      const stem = canonicalCharacterStemForActionPath(file.relativePath);
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot?.trim()
        ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'parts')) ? overlayParent : null);
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      // 查找顺序：overlay 同目录 chr/<stem>.chrbnd.dcx → 已挂原版同样相对路径。
      const overlayCandidate = join(dirname(file.absolutePath), `${stem}.chrbnd.dcx`);
      const overlayExists = deps.safeExists(overlayCandidate);
      const vanillaCandidate = effectiveBase ? join(effectiveBase, 'chr', `${stem}.chrbnd.dcx`) : null;
      const vanillaExists = vanillaCandidate ? deps.safeExists(vanillaCandidate) : false;
      if (!overlayExists && !vanillaExists) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error' as const,
            code: 'CHRBND_NOT_FOUND',
            message: effectiveBase
              ? `没有找到 ${stem} 的模型（chr/${stem}.chrbnd.dcx）：overlay 与原版目录都没有该文件。`
              : `没有找到 ${stem} 的模型（chrbnd）：overlay 没有该文件，且尚未挂载原版目录——到「开始」页选择含 sekiro.exe 的原版目录后可尝试读取原版模型。`
          }]
        };
      }
      const chrbndPath = overlayExists ? overlayCandidate : vanillaCandidate!;
      const texturePackagePaths = [
        ...characterTexturePackagePaths(chrbndPath),
        ...(overlayExists && vanillaCandidate && vanillaExists
          ? characterTexturePackagePaths(vanillaCandidate)
          : [])
      ].filter((path, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === path.toLowerCase()) === index);
      const result = await runBridge<Record<string, unknown>>({
        command: 'read-chrbnd-flver-preview',
        filePath: chrbndPath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
        commandOptions: {
          maxVertices: 1_000_000,
          maxIndices: 3_000_000,
          texturePackagePaths
        }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, sourceUri, diagnostics: result.diagnostics };
      }

      if (!isCharacterPreviewBundle(result.data)) {
        return {
          ok: false,
          sourceUri,
          diagnostics: [{
            severity: 'error',
            code: 'CHRBND_PREVIEW_SCHEMA_INVALID',
            message: '伴生 chrbnd 返回的角色预览数据不符合协议。',
            sourceUri
          }]
        };
      }

      let previewBundle: CharacterPreviewBundle = result.data;
      let compatibilityDiagnostics: Diagnostic[] = [];
      if (stem === 'c0000' && previewBundle.meshCount === 0 && previewBundle.boneCount > 0) {
        const compatibility = await assembleC0000CompatibilityPreview({
          leaderBundle: previewBundle,
          overlayPartsDirectory: join(deps.activeSession.layers.overlayRoot, 'parts'),
          basePartsDirectory: effectiveBase ? join(effectiveBase, 'parts') : null,
          allowedRoots: roots.allowedRoots,
          oodleRuntimeRoot: effectiveBase
        });
        compatibilityDiagnostics = compatibility.diagnostics;
        if (compatibility.bundle) previewBundle = compatibility.bundle;
      }

      // A normal chrbnd/partsbnd can contain several FLVER-local skeletons.
      // The TAE clip is sampled in the leader skeleton's index space, so passing
      // the raw bundle to the renderer would leave body parts on independent,
      // unmoving skeletons (or make an unkeyed pose update the wrong skeleton).
      // Normalize every multi-model action preview at the main/core boundary;
      // the renderer then consumes one explicit leader skeleton namespace.
      if (previewBundle.models.length > 1 && !isLeaderRemappedBundle(previewBundle)) {
        const leader = previewBundle.models.find((model) => model.modelId === previewBundle.leaderModelId);
        if (!leader || leader.bones.length === 0) {
          return {
            ok: false,
            sourceUri,
            diagnostics: [
              ...result.diagnostics,
              ...compatibilityDiagnostics,
              actionDiagnostic(
                'ACTION_PREVIEW_LEADER_MISSING',
                '动作预览包含多个 FLVER，但没有可用的 leader 骨架，已拒绝在错误骨架上播放。',
                sourceUri,
                { leaderModelId: previewBundle.leaderModelId, modelCount: previewBundle.models.length }
              )
            ]
          };
        }
        const remapped = remapCharacterBundleToLeader(
          leader,
          previewBundle.models.filter((model) => model.modelId !== leader.modelId)
        );
        if (!remapped.ok || !remapped.bundle) {
          return {
            ok: false,
            sourceUri,
            diagnostics: [
              ...result.diagnostics,
              ...compatibilityDiagnostics,
              ...remapped.diagnostics,
              actionDiagnostic(
                'ACTION_PREVIEW_LEADER_REMAP_FAILED',
                '动作预览的身体部件无法安全映射到 leader 骨架，已关闭播放预览。',
                sourceUri,
                { leaderModelId: leader.modelId, modelCount: previewBundle.models.length }
              )
            ]
          };
        }
        previewBundle = remapped.bundle;
        compatibilityDiagnostics = [
          ...compatibilityDiagnostics,
          {
            severity: 'info',
            code: 'ACTION_PREVIEW_LEADER_REMAP_APPLIED',
            message: `动作预览已将 ${previewBundle.models.length} 个 FLVER 统一到 leader 骨架 ${leader.modelId}。`,
            sourceUri,
            details: { leaderModelId: leader.modelId, modelCount: previewBundle.models.length }
          }
        ];
      }

      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: previewBundle,
        diagnostics: [...result.diagnostics, ...compatibilityDiagnostics]
      };
    }
  );

  deps.handle(
    'resource.readTaeAnimationClip',
    async (
      _event,
      sourceUri: string,
      animId: number,
      flverBoneNames?: string[],
      flverBoneParents?: number[],
      flverReferencePose?: Array<{
        translation: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
      }>
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: Record<string, unknown>;
      diagnostics: Diagnostic[];
    }> => {
      const context = await resolveActionAnimationContext(sourceUri, animId);
      if (!context.ok) return { ok: false, sourceUri, diagnostics: context.diagnostics };
      const beforeDiagnostics = await validateActionContextCurrent(context);
      if (beforeDiagnostics.length > 0) return { ok: false, sourceUri, diagnostics: beforeDiagnostics };

      const result = await runBridge<Record<string, unknown>>({
        command: 'read-tae-animation-clip',
        filePath: context.file.absolutePath,
        resourceUri: sourceUri,
        allowedRoots: context.allowedRoots,
        timeoutMs: 120_000,
        ...(context.effectiveBase ? { oodleRuntimeRoot: context.effectiveBase } : {}),
        workspaceSessionId: context.sessionId,
        commandOptions: {
          animId,
          animationContainerPath: context.binder.absolutePath,
          ...(flverBoneNames?.length ? { flverBoneNames } : {}),
          ...(flverBoneParents?.length ? { flverBoneParents } : {}),
          ...(flverReferencePose?.length ? { flverReferencePose } : {})
        }
      });
      const afterDiagnostics = await validateActionContextCurrent(context);
      if (afterDiagnostics.length > 0) return { ok: false, sourceUri, diagnostics: afterDiagnostics };
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, sourceUri, diagnostics: [...context.diagnostics, ...result.diagnostics] };
      }

      return {
        ok: true,
        sourceUri,
        relativePath: context.file.relativePath,
        data: result.data,
        diagnostics: [...context.diagnostics, ...result.diagnostics]
      };
    }
  );

  deps.handle(
    'resource.sampleTaeAnimationPose',
    async (
      _event,
      sourceUri: string,
      animId: number,
      timeSeconds: number,
      flverBoneNames?: string[],
      loop?: boolean,
      flverBoneParents?: number[],
      flverReferencePose?: Array<{
        translation: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
      }>
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: Record<string, unknown>;
      diagnostics: Diagnostic[];
    }> => {
      const context = await resolveActionAnimationContext(sourceUri, animId);
      if (!context.ok) return { ok: false, sourceUri, diagnostics: context.diagnostics };
      const beforeDiagnostics = await validateActionContextCurrent(context);
      if (beforeDiagnostics.length > 0) return { ok: false, sourceUri, diagnostics: beforeDiagnostics };

      const result = await runBridge<Record<string, unknown>>({
        command: 'sample-tae-animation-pose',
        filePath: context.file.absolutePath,
        resourceUri: sourceUri,
        allowedRoots: context.allowedRoots,
        timeoutMs: 120_000,
        ...(context.effectiveBase ? { oodleRuntimeRoot: context.effectiveBase } : {}),
        workspaceSessionId: context.sessionId,
        commandOptions: {
          animId,
          timeSeconds,
          loop: loop ?? true,
          animationContainerPath: context.binder.absolutePath,
          ...(flverBoneNames?.length ? { flverBoneNames } : {}),
          ...(flverBoneParents?.length ? { flverBoneParents } : {}),
          ...(flverReferencePose?.length ? { flverReferencePose } : {})
        }
      });
      const afterDiagnostics = await validateActionContextCurrent(context);
      if (afterDiagnostics.length > 0) return { ok: false, sourceUri, diagnostics: afterDiagnostics };
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, sourceUri, diagnostics: [...context.diagnostics, ...result.diagnostics] };
      }

      return {
        ok: true,
        sourceUri,
        relativePath: context.file.relativePath,
        data: result.data,
        diagnostics: [...context.diagnostics, ...result.diagnostics]
      };
    }
  );

  /**
   * S17：动作域 TAE 的伴生 chrbnd 解析（overlay → 已挂载原版）。
   * renderer 传动作文件 sourceUri；main 按同相对路径推 `chr/<id>.chrbnd.dcx`
   * 并探存在性，返回虚拟 sourceUri（`chrbnd:<relative>`）供 FLVER 读通道用。
   * 两边都没有时给空态文案：未挂原版时指引去「开始」页挂载。
   */
  deps.handle('resource.resolveChrbndPreview', async (_event, animSourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === animSourceUri);
    if (!file) {
      return { ok: false, reason: 'no-anim' as const, message: '未找到该动作文件。' };
    }
    const relative = file.relativePath.replace(/\\/g, '/');
    const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    const stem = canonicalCharacterStemForActionPath(relative);
    const candidates = [`${stem}.chrbnd.dcx`, `${stem}.chrbnd`]
      .map((name) => (dir ? `${dir}/${name}` : name))
      .map((name) => name.replace(/\//g, sep));
    const overlay = deps.activeSession?.layers.overlayRoot?.trim();
    if (overlay) {
      for (const candidate of candidates) {
        try {
          if (existsSync(join(overlay, candidate))) {
            return { ok: true, origin: 'overlay' as const, chrbndSourceUri: `chrbnd:${candidate.replace(/\\/g, '/')}` };
          }
        } catch {
          // 继续下一个候选。
        }
      }
    }
    const base = deps.activeSession?.layers.baseRoot?.trim();
    if (base) {
      for (const candidate of candidates) {
        try {
          if (existsSync(join(base, candidate))) {
            return { ok: true, origin: 'base' as const, chrbndSourceUri: `chrbnd:${candidate.replace(/\\/g, '/')}` };
          }
        } catch {
          // 继续下一个候选。
        }
      }
    }
    if (!base) {
      return {
        ok: false,
        reason: 'base-not-mounted' as const,
        message: `没有找到 ${stem} 的模型（chrbnd），且未挂载原版游戏目录；到「开始」页选择含 sekiro.exe 的目录后再试。`
      };
    }
    return { ok: false, reason: 'none' as const, message: `没有找到 ${stem} 的模型（chrbnd）。` };
  });
}

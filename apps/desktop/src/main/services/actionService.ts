import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { ingestBridgeResult, ActionMotionIdentityCache, runBridge, type BinderMembershipMatch, type BinderMembershipCandidate, type WorkspaceIndex, type WorkspaceSession } from '@soulforge/core';
import { TAE_ANIMATION_PAGE_SIZE, type Diagnostic, type IndexedFile } from '@soulforge/shared';
import { sanitizeRendererValue } from '../rendererDto.js';
import { getTaeTemplateCatalog } from '../taeTemplateCatalog.js';
import { canonicalCharacterStemForActionPath } from '../ipc/actionPreviewCompatibility.js';
import { actionDiagnostic } from './actionDiagnostics.js';

export interface ActionServiceDeps {
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  readonly activeIndex: WorkspaceIndex | null;
  readonly activeWorkspaceSessionId: string | null;
  asBasicDiagnostics(
    items: Array<{ severity: string; code: string; message: string; sourceUri?: string }>
  ): Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string; sourceUri?: string }>;
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  /** 为当前 TAE 的 character family 建立前台完整 membership 投影。 */
  ensureActionBinderMembershipForFamily?: ((characterFamily: string) => Promise<unknown>) | undefined;
  /** 等待 workspace.scan 的后台 ACTION membership 建立完成。 */
  waitForWorkspaceIndexing?: (() => Promise<void>) | undefined;
}

const SEKIRO_ANIMATION_BINDER_ID_BASE = 1_000_000_000;
const ACTION_ANIBND_FILE_PATTERN = /\.anibnd(?:\.dcx)?$/i;
const ACTION_CHARACTER_FAMILY_PATTERN = /^c\d{4}$/i;
// ACTION membership reads are independent, read-only native operations. Keep a
// small shared concurrency cap so opening one animation does not wait behind a
// serial scan of every character's ANIBND container.
const ACTION_BINDER_READ_CONCURRENCY = 4;

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
  readConcurrency?: number;
}): Promise<ActionBinderReadResult> {
  try {
    const result = await runBridge<{ nested?: unknown }>({
      command: 'read-dcx-document',
      filePath: input.candidate.absolutePath,
      resourceUri: input.sourceUri,
      allowedRoots: input.allowedRoots,
      timeoutMs: 120_000,
      maxConcurrency: input.readConcurrency ?? ACTION_BINDER_READ_CONCURRENCY,
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
 * Build the complete ACTION Binder membership projection for the requested
 * scope during workspace indexing. A foreground call may request one
 * character family, but it still uses the same deterministic directory
 * enumeration and exact native membership reads; playback never scans sibling
 * ANIBND files itself.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => run()));
  return results;
}

export async function buildActionBinderMembershipIndex(input: {
  session: WorkspaceSession;
  sessionId: string;
  effectiveBase: string | null;
  indexedFiles: readonly IndexedFile[];
  allowedRoots: readonly string[];
  /** Optional foreground scope; omitted means every discovered character family. */
  characterFamilies?: readonly string[];
  /** Separate foreground pool prevents a full background scan from queueing ahead. */
  readConcurrency?: number;
}): Promise<ActionBinderMembershipIndexBuildResult> {
  const discovered = await discoverActionCharacterFamilies(input);
  const requestedFamilies = input.characterFamilies?.length
    ? new Set(input.characterFamilies.map((family) => family.toLowerCase()))
    : null;
  const families = requestedFamilies
    ? discovered.families.filter((family) => requestedFamilies.has(family.toLowerCase()))
    : discovered.families;
  const diagnostics = [...discovered.diagnostics];
  const candidates: BinderMembershipCandidate[] = [];
  const allowedRoots = [...input.allowedRoots];
  appendActionAllowedRoot(allowedRoots, input.effectiveBase);
  const readConcurrency = Number.isInteger(input.readConcurrency) && input.readConcurrency! > 0
    ? input.readConcurrency!
    : ACTION_BINDER_READ_CONCURRENCY;

  // Directory enumeration is cheap; perform it up front, then schedule the
  // native membership reads through one global bounded queue. The previous
  // nested serial loop made the first playable ACTION wait for every large
  // character binder in the game, even though each read is independent.
  const plans = await Promise.all(families.map(async (characterFamily) => ({
    characterFamily,
    plan: await enumerateActionBinderCandidates({
      session: input.session,
      effectiveBase: input.effectiveBase,
      characterFamily,
      sourceUri: `action-index://${characterFamily}`,
      indexedFiles: input.indexedFiles
    })
  })));
  const readJobs = plans.flatMap(({ characterFamily, plan }) => plan.candidates.map((candidate) => ({
    characterFamily,
    candidate
  })));
  const reads = await mapWithConcurrency(readJobs, readConcurrency, async (job) => ({
    ...job,
    read: await readActionBinderDocument({
      candidate: job.candidate,
      sourceUri: actionBinderIdentityUri(job.candidate),
      allowedRoots,
      effectiveBase: input.effectiveBase,
      sessionId: input.sessionId,
      readConcurrency
    })
  }));

  for (const { plan } of plans) diagnostics.push(...plan.diagnostics);
  for (const job of reads) {
    const { characterFamily, read } = job;
    if (!read.ok) {
      diagnostics.push(...read.diagnostics);
      continue;
    }
    candidates.push({
      characterFamily,
      source: {
        sourceUri: actionBinderIdentityUri(read.candidate),
        sourcePath: read.candidate.relativePath,
        sourceRevision: read.candidate.revisionKey,
        sourceLayer: read.candidate.origin
      },
      entries: read.entries.map((entry) => ({
        entryId: entry.id,
        entryIndex: entry.index,
        entryName: entry.name
      }))
    });
  }

  /*
   * Keep the old deterministic family/candidate order in the projection even
   * though the native reads above completed concurrently.
   */
  candidates.sort((left, right) => {
    const family = compareActionNames(left.characterFamily, right.characterFamily);
    if (family !== 0) return family;
    return compareActionNames(left.source.sourcePath ?? '', right.source.sourcePath ?? '');
  });

  /*
   * The read queue above is intentionally the only native fan-out. Do not
   * reintroduce a playback-time sibling scan here.
   */
  return {
    ok: diagnostics.length === 0,
    characterFamilies: families,
    candidates,
    diagnostics
  };
}

function findIndexedActionMotionIdentity(
  index: WorkspaceIndex | null,
  sourceUri: string,
  animId: number,
  sourceRevision: ActionFileRevision,
  selector?: { taeEntryIndex?: number; taeEntryId?: number; taeEntryName?: string; taeGroup?: string }
): number | undefined {
  const lookup = index?.lookupTaeAnimation(sourceUri, animId, selector);
  if (!lookup || lookup.status !== 'UNIQUE' || lookup.sourceRevision !== sourceRevision.mtimeMs) return undefined;
  const motionAnimId = lookup.animation.motionAnimId;
  return typeof motionAnimId === 'number'
    && Number.isSafeInteger(motionAnimId)
    && motionAnimId >= 0
    && motionAnimId < SEKIRO_ANIMATION_BINDER_ID_BASE
    ? motionAnimId
    : undefined;
}
/** TAE reads and motion identity orchestration. Native parsing remains in Bridge;
 * the factory owns the workspace/revision/child-scoped motion promise cache. */
export function createActionService(deps: ActionServiceDeps) {


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
    taeEntrySelector?: { taeEntryIndex?: number; taeEntryId?: number; taeEntryName?: string; taeGroup?: string };
  }): Promise<ActionMotionIdentityResult> => {
    const selectorKey = input.taeEntrySelector
      ? `${input.taeEntrySelector.taeEntryIndex ?? ''}:${input.taeEntrySelector.taeEntryId ?? ''}:${input.taeEntrySelector.taeGroup ?? ''}:${input.taeEntrySelector.taeEntryName ?? ''}`
      : '';
    const cached = taeMotionIdentityCache.get(input.sourceUri, input.sourceRevisionKey, input.animId, selectorKey);
    if (cached) return cached;

    const promise = (async (): Promise<ActionMotionIdentityResult> => {
      try {
        const indexed = findIndexedActionMotionIdentity(
          deps.activeIndex,
          input.sourceUri,
          input.animId,
          input.sourceRevision,
          input.taeEntrySelector
        );
        if (indexed !== undefined) return { ok: true, motionAnimId: indexed };

        const result = await runBridge<Record<string, unknown>>({
          command: 'read-tae-motion-identity',
          filePath: input.file.absolutePath,
          resourceUri: input.sourceUri,
          allowedRoots: input.allowedRoots,
          timeoutMs: 120_000,
          ...(input.effectiveBase ? { oodleRuntimeRoot: input.effectiveBase } : {}),
          workspaceSessionId: input.sessionId,
          commandOptions: { animId: input.animId, ...input.taeEntrySelector }
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
        if (!data || data.format !== 'TAE_MOTION_IDENTITY'
          || data.identityProjectionVersion !== 2
          || data.animId !== input.animId
          || typeof data.sourceHash !== 'string' || !data.sourceHash.trim()) {
          return {
            ok: false,
            diagnostics: [actionDiagnostic(
              'TAE_MOTION_IDENTITY_UNRESOLVED',
              'TAE motion identity 原生投影缺失或与选中动画不一致，已拒绝回退到 animId。',
              input.sourceUri,
              { animId: input.animId }
            )]
          };
        }
        if (input.taeEntrySelector && Object.entries(input.taeEntrySelector).some(
          ([key, value]) => value !== undefined && data[key] !== value
        )) {
          return {
            ok: false,
            diagnostics: [actionDiagnostic(
              'TAE_MOTION_IDENTITY_UNRESOLVED',
              'TAE motion identity 与选中 child identity 不一致，已拒绝继续。',
              input.sourceUri,
              { animId: input.animId }
            )]
          };
        }
        const motionAnimId = asSafeInteger(data.motionAnimId);
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

        // This scalar identity is cached only for its source revision/selector.
        // It is not a complete event document and must not populate that index.
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
    taeMotionIdentityCache.set(input.sourceUri, input.sourceRevisionKey, input.animId, promise, selectorKey);
    return promise;
  };

  const resolveActionAnimationContext = async (
    sourceUri: string,
    animId: number,
    taeEntrySelector?: { taeEntryIndex?: number; taeEntryId?: number; taeEntryName?: string; taeGroup?: string }
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
      effectiveBase,
      ...(taeEntrySelector ? { taeEntrySelector } : {})
    });
    if (!motionIdentity.ok) return motionIdentity;
    if (deps.activeSession !== session || deps.activeWorkspaceSessionId !== sessionId) {
      return { ok: false, diagnostics: [sessionChangedDiagnostic(sourceUri)] };
    }

    let actionIndex = deps.activeIndex;
    if (!actionIndex || !actionIndex.isActionBinderMembershipReadyFor(characterFamily)) {
      // 先建立当前 character family 的完整前台投影；这仍然走统一的
      // deterministic enumerator + native membership reader，不在播放阶段
      // 自己扫描 sibling ANIBND。全局索引保持延迟，避免打开工作区时读取
      // 与当前角色无关的全部 ANIBND。
      if (deps.ensureActionBinderMembershipForFamily) {
        await deps.ensureActionBinderMembershipForFamily(characterFamily);
      } else {
        await deps.waitForWorkspaceIndexing?.();
      }
      if (deps.activeSession !== session || deps.activeWorkspaceSessionId !== sessionId) {
        return { ok: false, diagnostics: [sessionChangedDiagnostic(sourceUri)] };
      }
      actionIndex = deps.activeIndex;
    }
    if (!actionIndex || !actionIndex.isActionBinderMembershipReadyFor(characterFamily)) {
      return {
        ok: false,
        diagnostics: [actionDiagnostic(
          'ACTION_BINDER_MEMBERSHIP_INDEX_NOT_READY',
          '当前 character family 的 ACTION Binder membership 尚未由 workspace index 完整建立，播放阶段拒绝临时扫描 sibling ANIBND。',
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
  };const readTaeDocument = async (sourceUri: string,
options?: { animationPage?: number; animationPageSize?: number }) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    // TAE 字段、事件名称和长度变体均由 Bridge 内置 first-party schema 处理。
    // 这里只传分页参数；生产链不读取编辑器安装目录或外部模板。
    // c0000 has thousands of actions; render one bounded native page initially.
    const paginationOptions: Record<string, unknown> = { animationPage: 0, animationPageSize: TAE_ANIMATION_PAGE_SIZE };
    if (typeof options?.animationPage === 'number' && Number.isFinite(options.animationPage) && options.animationPage >= 0) {
      paginationOptions.animationPage = Math.floor(options.animationPage);
    }
    if (typeof options?.animationPageSize === 'number' && Number.isFinite(options.animationPageSize) && options.animationPageSize > 0) {
      paginationOptions.animationPageSize = Math.floor(options.animationPageSize);
    }
    const mergedCommandOptions = paginationOptions;
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
    // 事件类型名表来自 SoulForge first-party registry；只投影文档实际出现过的
    // eventTypeId，schema 缺口由 Bridge 的结构化 coverage 诊断显式报告。
    let eventTypeNames: Record<string, string> | undefined;
    if (result.parseStatus !== 'failed' && result.data) {
      const data = result.data as { eventTypes?: number[] };
      const present = (data.eventTypes ?? []).filter(
        (id): id is number => Number.isInteger(id)
      );
      if (present.length > 0) {
        eventTypeNames = Object.fromEntries(
          present.map((id) => [String(id), getTaeTemplateCatalog().events.get(id)?.name ?? `事件类型 ${id}`])
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
  };

const readTaeTemplateCatalog = async (): Promise<{
    ok: boolean;
    origin: 'first-party';
    package: string;
    version: string;
    contentDigest: string;
    events: Array<{ eventTypeId: number; name: string }>;
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => {
    const catalog = getTaeTemplateCatalog();
    // handle() 包装器统一 sanitize；这里只组装结构化结果。
    return {
      ok: true,
      origin: catalog.origin,
      package: catalog.package,
      version: catalog.version,
      contentDigest: catalog.contentDigest,
      events: [...catalog.events.entries()].map(([eventTypeId, def]) => ({ eventTypeId, name: def.name })),
      diagnostics: [...catalog.diagnostics]
    };
  };

const readTaeEventParams = async (sourceUri: string,
animId: number,
eventIndex: number,
taeEntryIndex?: number,
taeEntryId?: number,
taeEntryName?: string,
taeGroup?: string): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: {
        eventTypeId: number;
        templateName: string | null;
        parameterLength: number;
        parameterDecodedSize: number;
        schemaBankId?: number;
        schemaVariant?: string;
        fields: Array<{
          index: number;
          name: string;
          type: string;
          offset: number;
          size: number;
          value: string | number | boolean;
          displayValue?: string;
          rawValue?: number;
          assert?: number;
          assertValid?: boolean;
          isPadding?: boolean;
          enumEntries?: Array<{ value: number; name: string }>;
        }>;
        tailHex: string | null;
        undecodedHex: string | null;
      };
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE 事件参数。', sourceUri }] };
      }
      const selector = (typeof taeEntryIndex === 'number' || typeof taeEntryId === 'number' || taeEntryName || taeGroup)
        ? {
            ...(typeof taeEntryIndex === 'number' ? { taeEntryIndex } : {}),
            ...(typeof taeEntryId === 'number' ? { taeEntryId } : {}),
            ...(typeof taeEntryName === 'string' ? { taeEntryName } : {}),
            ...(typeof taeGroup === 'string' ? { taeGroup } : {})
          }
        : undefined;
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const result = await runBridge<{
        eventTypeId?: number;
        paramHex?: string;
        paramSize?: number;
        parameterLength?: number;
        parameterDecodedSize?: number;
        parameterTailHex?: string;
        schemaBankId?: number;
        schemaVariant?: string;
        templateName?: string | null;
        fields?: Array<{
          index?: number;
          name?: string;
          type?: string;
          offset?: number;
          size?: number;
          value?: string | number | boolean;
          displayValue?: string;
          rawValue?: number;
          assert?: number;
          assertValid?: boolean;
          isPadding?: boolean;
          enumEntries?: Array<{ value: number; name: string }>;
        }>;
        tailHex?: string | null;
        undecodedHex?: string | null;
        schema?: Record<string, unknown>;
      }>({
        command: 'read-tae-event-params',
        filePath: file.absolutePath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(deps.activeSession?.layers.baseRoot
          ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
          : {}),
        commandOptions: {
          animId,
          eventIndex,
          ...(typeof selector?.taeEntryIndex === 'number' ? { taeEntryIndex: selector.taeEntryIndex } : {}),
          ...(typeof selector?.taeEntryId === 'number' ? { taeEntryId: selector.taeEntryId } : {}),
            ...(typeof selector?.taeEntryName === 'string' ? { taeEntryName: selector.taeEntryName } : {}),
            ...(typeof selector?.taeGroup === 'string' ? { taeGroup: selector.taeGroup } : {})
        }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, diagnostics: result.diagnostics };
      }
      const eventTypeId = result.data.eventTypeId ?? -1;
      const fields = (result.data.fields ?? []).map((field, index) => ({
        index: field.index ?? index,
        name: field.name ?? `field_${index}`,
        type: field.type ?? 'unknown',
        offset: field.offset ?? 0,
        size: field.size ?? 0,
        value: field.value ?? '',
        ...(field.displayValue !== undefined ? { displayValue: field.displayValue } : {}),
        ...(field.rawValue !== undefined ? { rawValue: field.rawValue } : {}),
        ...(field.assert !== undefined ? { assert: field.assert } : {}),
        ...(field.assertValid !== undefined ? { assertValid: field.assertValid } : {}),
        ...(field.isPadding !== undefined ? { isPadding: field.isPadding } : {}),
        ...(field.enumEntries ? { enumEntries: field.enumEntries } : {})
      }));
      // handle() 包装器统一 sanitize；这里只组装结构化结果。
      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: {
          eventTypeId,
          templateName: result.data.templateName ?? null,
          parameterLength: result.data.parameterLength ?? result.data.paramSize ?? 0,
          parameterDecodedSize: result.data.parameterDecodedSize ?? 0,
          ...(result.data.schemaBankId !== undefined ? { schemaBankId: result.data.schemaBankId } : {}),
          ...(result.data.schemaVariant !== undefined ? { schemaVariant: result.data.schemaVariant } : {}),
          fields,
          tailHex: result.data.parameterTailHex ?? result.data.tailHex ?? null,
          undecodedHex: result.data.undecodedHex
            ?? ((fields.length === 0 && result.data.paramHex) ? result.data.paramHex : null)
        },
        diagnostics: result.diagnostics
      };
    };

const readTaeAnimationClip = async (sourceUri: string,
animId: number,
flverBoneNames?: string[],
flverBoneParents?: number[],
flverReferencePose?: Array<{
        translation: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
      }>,
taeEntryIndex?: number,
taeEntryId?: number,
taeEntryName?: string,
taeGroup?: string): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: Record<string, unknown>;
      diagnostics: Diagnostic[];
    }> => {
      const selector = (typeof taeEntryIndex === 'number' || typeof taeEntryId === 'number' || taeEntryName || taeGroup)
        ? {
            ...(typeof taeEntryIndex === 'number' ? { taeEntryIndex } : {}),
            ...(typeof taeEntryId === 'number' ? { taeEntryId } : {}),
            ...(taeEntryName ? { taeEntryName } : {}),
            ...(taeGroup ? { taeGroup } : {})
          }
        : undefined;
      const context = await resolveActionAnimationContext(sourceUri, animId, selector);
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
          ...(ACTION_ANIBND_FILE_PATTERN.test(context.file.relativePath)
            ? { skeletonContainerPath: context.file.absolutePath }
            : {}),
          ...(typeof taeEntryIndex === 'number' ? { taeEntryIndex } : {}),
          ...(typeof taeEntryId === 'number' ? { taeEntryId } : {}),
            ...(typeof taeEntryName === 'string' ? { taeEntryName } : {}),
            ...(typeof taeGroup === 'string' ? { taeGroup } : {}),
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
    };

const sampleTaeAnimationPose = async (sourceUri: string,
animId: number,
timeSeconds: number,
flverBoneNames?: string[],
loop?: boolean,
flverBoneParents?: number[],
flverReferencePose?: Array<{
        translation: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
      }>,
taeEntryIndex?: number,
taeEntryId?: number,
taeEntryName?: string,
taeGroup?: string): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: Record<string, unknown>;
      diagnostics: Diagnostic[];
    }> => {
      const selector = (typeof taeEntryIndex === 'number' || typeof taeEntryId === 'number' || taeEntryName || taeGroup)
        ? {
            ...(typeof taeEntryIndex === 'number' ? { taeEntryIndex } : {}),
            ...(typeof taeEntryId === 'number' ? { taeEntryId } : {}),
            ...(taeEntryName ? { taeEntryName } : {}),
            ...(taeGroup ? { taeGroup } : {})
          }
        : undefined;
      const context = await resolveActionAnimationContext(sourceUri, animId, selector);
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
          ...(ACTION_ANIBND_FILE_PATTERN.test(context.file.relativePath)
            ? { skeletonContainerPath: context.file.absolutePath }
            : {}),
          ...(typeof taeEntryIndex === 'number' ? { taeEntryIndex } : {}),
          ...(typeof taeEntryId === 'number' ? { taeEntryId } : {}),
            ...(typeof taeEntryName === 'string' ? { taeEntryName } : {}),
            ...(typeof taeGroup === 'string' ? { taeGroup } : {}),
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
    };

return Object.freeze({ readTaeDocument, readTaeTemplateCatalog, readTaeEventParams, readTaeAnimationClip, sampleTaeAnimationPose });
}
export type ActionService = ReturnType<typeof createActionService>;

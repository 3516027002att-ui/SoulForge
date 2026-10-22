import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor, TAE_ANIMATION_PAGE_SIZE } from '@soulforge/shared';
import type { Diagnostic, NativeReadSession, TaeEntryWire } from '@soulforge/shared';
import { makeFileResourceUri, makeWorkspaceRelativePath } from '../workspace/resourceUri.js';
import type { NativeEditSession } from './nativeEditSession.js';
import type { TaeActionSnapshot, TaeEditFailure, TaeEventSnapshot } from './taeEdit.js';

/** Match the existing Desktop native animation page, not a new event quota. */
export const TAE_BROWSE_ANIMATION_PAGE_SIZE = TAE_ANIMATION_PAGE_SIZE;

export interface TaeBrowseNativePage {
  ok: true;
  chrId: string;
  readerSchemaRevision: number;
  sourceHash?: string;
  outerFileHash?: string;
  containerSourceHash?: string;
  animationCount?: number;
  totalEventCount?: number;
  animationsTruncated: boolean;
  taeEntryCount?: number;
  taeEntries?: TaeEntryWire[];
  actions: Array<TaeActionSnapshot & { eventsTruncated?: boolean }>;
  events: TaeEventSnapshot[];
  diagnostics: Diagnostic[];
}

export interface TaeBrowseFailure {
  ok: false;
  error: TaeEditFailure;
  diagnostics: Diagnostic[];
}

export interface TaeBrowseAction extends TaeActionSnapshot {
  eventsComplete: boolean;
  eventsTruncated: boolean;
  pagination: {
    totalCount: number;
    returnedCount: number;
    offset: number;
    hasMore: boolean;
    nextRead?: {
      tool: 'read_tae_events';
      args: {
        file: string;
        addresses: string[];
        offset: number;
        pageSize: number;
        expectedSourceHash: string;
        expectedReaderSchemaRevision: number;
      };
    };
  };
}

export type TaeBrowseResult = TaeBrowseFailure | Omit<TaeBrowseNativePage, 'animationsTruncated' | 'actions'> & {
  filePath: string;
  status: 'partial' | 'complete';
  eventsTruncated: boolean;
  actions: TaeBrowseAction[];
  pagination: {
    returnedCount: number;
    totalCount: null;
    offset: number;
    hasMore: boolean;
    nextCursor: string | null;
    totalPages: null;
  };
  nativePagination: {
    animationPage: number;
    animationPageSize: number;
    returnedCount: number;
    totalCount: number | null;
    hasMore: boolean;
  };
};

export interface TaeBrowseInput {
  edit: NativeEditSession;
  filePath: string;
  cursor?: string;
  offset?: number;
  pageSize?: number;
  expectedSourceHash?: string;
  expectedReaderSchemaRevision?: number;
  /** The facade owns native parsing, identity validation and projection. */
  loadPage: (animationPage: number, animationPageSize: number) => Promise<TaeBrowseNativePage | TaeBrowseFailure>;
}

interface TaeBrowsePageState {
  page: TaeBrowseNativePage;
  animationPage: number;
  previewOffset: number;
  previousEventsTruncated: boolean;
  maximumEventBytes: number;
}

// Metadata has the same lifetime as its shared session, including invalidation
// and expiry. No second strong session table or independently growing cache.
const pageStates = new WeakMap<NativeReadSession, TaeBrowsePageState>();

function failure(code: string, message: string, diagnostics: Diagnostic[] = []): TaeBrowseFailure {
  return { ok: false, error: { code, message }, diagnostics };
}

function actionKey(action: TaeActionSnapshot | TaeEventSnapshot): string {
  return JSON.stringify([action.taeEntryIndex, action.taeEntryId, action.taeEntryName, action.taeGroup, action.animId]);
}

function nativeEventsTruncated(page: TaeBrowseNativePage): boolean {
  const counts = new Map<string, number>();
  for (const event of page.events) counts.set(actionKey(event), (counts.get(actionKey(event)) ?? 0) + 1);
  return page.actions.some(action => action.eventsTruncated === true || (counts.get(actionKey(action)) ?? 0) < action.eventCount);
}

function expectedVersionMatches(input: TaeBrowseInput, page: TaeBrowseNativePage): boolean {
  return (input.expectedSourceHash === undefined || input.expectedSourceHash === page.outerFileHash)
    && (input.expectedReaderSchemaRevision === undefined || input.expectedReaderSchemaRevision === page.readerSchemaRevision);
}

function sameNativeSnapshot(left: TaeBrowseNativePage, right: TaeBrowseNativePage): boolean {
  return left.outerFileHash === right.outerFileHash && left.sourceHash === right.sourceHash
    && left.containerSourceHash === right.containerSourceHash && left.readerSchemaRevision === right.readerSchemaRevision;
}

async function physicalHash(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/**
 * Browse bounded native animation previews. Each shared session retains one
 * immutable native page; only following its boundary cursor loads the next.
 * This does not hydrate event tails or build an all-document event array.
 */
export async function readTaeBrowse(input: TaeBrowseInput): Promise<TaeBrowseResult> {
  if (input.cursor !== undefined && input.offset !== undefined)
    return failure('TAE_CURSOR_SCOPE_MISMATCH', '续页只传 cursor，不同时传 offset。');
  if (input.offset !== undefined && input.offset !== 0)
    return failure('TAE_CURSOR_INVALID', '未指定动作的 TAE 浏览须使用 cursor 续页；初始 offset 只能为 0。');
  const relativePath = makeWorkspaceRelativePath(input.edit.session.layers.overlayRoot, input.filePath);
  const sourceUri = makeFileResourceUri(relativePath);
  const queryScope = `tae-browse:${sourceUri}`;
  const workspaceId = input.edit.session.meta.workspaceId;
  try {
    let session: NativeReadSession;
    let state: TaeBrowsePageState;
    let cursor: string;
    if (input.cursor !== undefined) {
      const payload = parseOpaqueCursor(input.cursor);
      if (payload.domain !== 'tae' || payload.scope !== queryScope)
        return failure('TAE_CURSOR_SCOPE_MISMATCH', 'TAE 浏览 cursor 与当前文件或读取范围不匹配。');
      const existing = defaultReadSessionManager.getSession(payload.sessionId);
      if (!existing) return failure('STALE_READ_CURSOR', 'TAE 浏览会话已过期，请从第一页重新读取。');
      const existingState = pageStates.get(existing);
      if (!existingState || existing.domain !== 'tae' || existing.queryScope !== queryScope || existing.workspaceId !== workspaceId)
        return failure('TAE_CURSOR_SCOPE_MISMATCH', 'TAE 浏览 cursor 不属于当前工作区或读取会话。');
      if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > existing.items.length)
        return failure('TAE_CURSOR_INVALID', 'TAE 浏览 cursor 的事件窗口位置无效。');
      state = existingState;
      if (payload.sourceHash !== existing.sourceVersion.sourceHash || payload.sourceHash !== state.page.outerFileHash
        || await physicalHash(input.filePath) !== state.page.outerFileHash)
        return failure('STALE_READ_CURSOR', 'TAE 来源已变化，请从第一页重新读取。');
      if (!expectedVersionMatches(input, state.page))
        return failure('TAE_SOURCE_VERSION_CHANGED', 'TAE 来源或读取器版本已变化，请重新读取。', state.page.diagnostics);
      session = existing;
      cursor = input.cursor;
      if (payload.offset === existing.items.length && state.page.animationsTruncated) {
        const loaded = await input.loadPage(state.animationPage + 1, TAE_BROWSE_ANIMATION_PAGE_SIZE);
        if (!loaded.ok) return loaded;
        if (!sameNativeSnapshot(state.page, loaded) || !expectedVersionMatches(input, loaded)
          || await physicalHash(input.filePath) !== loaded.outerFileHash)
          return failure('TAE_SOURCE_VERSION_CHANGED', 'TAE 原生来源或读取器版本在分页期间变化。', loaded.diagnostics);
        const created = createPageSession(loaded, state.animationPage + 1, state.previewOffset + existing.items.length,
          state.previousEventsTruncated || nativeEventsTruncated(state.page), workspaceId, sourceUri, queryScope);
        session = created.session; state = created.state; cursor = created.cursor;
      }
    } else {
      const loaded = await input.loadPage(0, TAE_BROWSE_ANIMATION_PAGE_SIZE);
      if (!loaded.ok) return loaded;
      if (!loaded.outerFileHash || !expectedVersionMatches(input, loaded)
        || await physicalHash(input.filePath) !== loaded.outerFileHash)
        return failure('TAE_SOURCE_VERSION_CHANGED', 'TAE 浏览需要与当前文件一致的原生物理快照哈希。', loaded.diagnostics);
      const created = createPageSession(loaded, 0, 0, false, workspaceId, sourceUri, queryScope);
      session = created.session; state = created.state; cursor = created.cursor;
    }
    const requestedSize = Number.isSafeInteger(input.pageSize) && input.pageSize! >= 1 && input.pageSize! <= 128 ? input.pageSize! : 32;
    const pageSize = Math.max(1, Math.min(requestedSize, Math.floor(24000 / state.maximumEventBytes)));
    const window = defaultReadSessionManager.resolvePage(cursor, state.page.outerFileHash!, pageSize);
    const events = window.items as TaeEventSnapshot[];
    const hasMore = window.hasMore || state.page.animationsTruncated;
    const nextCursor = window.nextCursor ?? (state.page.animationsTruncated ? createOpaqueCursor({
      sessionId: session.sessionId, offset: session.items.length, sourceHash: state.page.outerFileHash!, domain: 'tae', scope: queryScope
    }) : null);
    const eventsTruncated = state.previousEventsTruncated || nativeEventsTruncated(state.page);
    const actions = projectBrowseActions(state.page, events, window.offset, pageSize, relativePath);
    const { animationsTruncated: _nativeMore, actions: _actions, events: _events, ...metadata } = state.page;
    return {
      ...metadata, filePath: input.filePath, events, actions, eventsTruncated,
      status: hasMore || eventsTruncated ? 'partial' : 'complete',
      pagination: { returnedCount: events.length, totalCount: null, offset: state.previewOffset + window.offset,
        hasMore, nextCursor, totalPages: null },
      nativePagination: { animationPage: state.animationPage, animationPageSize: TAE_BROWSE_ANIMATION_PAGE_SIZE,
        returnedCount: state.page.actions.length, totalCount: state.page.animationCount ?? null, hasMore: state.page.animationsTruncated }
    };
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'TAE_READ_FAILED';
    return failure(code, error instanceof Error ? error.message : String(error));
  }
}

function createPageSession(page: TaeBrowseNativePage, animationPage: number, previewOffset: number,
  previousEventsTruncated: boolean, workspaceId: string, sourceUri: string, queryScope: string) {
  const session = defaultReadSessionManager.createSession({ workspaceId,
    sourceVersion: { sourceUri, sourceHash: page.outerFileHash! }, domain: 'tae', queryScope, items: page.events.slice() });
  const state: TaeBrowsePageState = { page, animationPage, previewOffset, previousEventsTruncated,
    maximumEventBytes: page.events.reduce((maximum, event) => Math.max(maximum, Buffer.byteLength(JSON.stringify(event), 'utf8')), 1) };
  pageStates.set(session, state);
  return { session, state, cursor: createOpaqueCursor({ sessionId: session.sessionId, offset: 0,
    sourceHash: page.outerFileHash!, domain: 'tae', scope: queryScope }) };
}

function projectBrowseActions(page: TaeBrowseNativePage, events: TaeEventSnapshot[], offset: number,
  pageSize: number, relativePath: string): TaeBrowseAction[] {
  const delivered = new Map<string, TaeEventSnapshot[]>();
  for (const event of events) { const key = actionKey(event); const siblings = delivered.get(key) ?? []; siblings.push(event); delivered.set(key, siblings); }
  return page.actions.flatMap(action => {
    const siblings = delivered.get(actionKey(action)) ?? [];
    // Keep zero-event actions visible on the native page's first window.
    if (siblings.length === 0 && !(offset === 0 && action.eventCount === 0)) return [];
    const prefix = page.events.slice(0, offset + events.length).filter(event => actionKey(event) === actionKey(action));
    const contiguous = prefix.every((event, index) => event.eventIndex === index);
    const nextOffset = contiguous ? prefix.length : 0;
    const eventsComplete = contiguous && prefix.length === action.eventCount;
    const hasMore = !eventsComplete;
    return [{ ...action, eventsComplete, eventsTruncated: action.eventsTruncated === true || hasMore,
      pagination: { totalCount: action.eventCount, returnedCount: siblings.length, offset: siblings[0]?.eventIndex ?? 0, hasMore,
        ...(hasMore ? { nextRead: { tool: 'read_tae_events' as const, args: {
          file: relativePath, addresses: [action.address], offset: nextOffset, pageSize,
          expectedSourceHash: page.outerFileHash!, expectedReaderSchemaRevision: page.readerSchemaRevision
        } } } : {}) } }];
  });
}

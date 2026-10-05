import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';
import { readTaeBrowse, type TaeBrowseNativePage, type TaeBrowseResult } from './taeBrowse.js';
import type { NativeEditSession } from './nativeEditSession.js';
import type { TaeEventSnapshot } from './taeEdit.js';
import { assertCursorPrivacy } from '../testing/harness/assertCursorPrivacy.js';
import { pathToFileURL } from 'node:url';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

function event(animId: number, eventIndex = 0, taeEntryIndex = 2): TaeEventSnapshot {
  return { chrId: 'c0000', animId, code: `A${String(animId).padStart(4, '0')}`, eventIndex,
    uri: `action://c0000/tae/${taeEntryIndex}/A${animId}/e${eventIndex}`,
    address: `action://c0000/tae/${taeEntryIndex}/A${animId}/e${eventIndex}`,
    taeEntryIndex, eventTypeId: 1, startTime: eventIndex, endTime: eventIndex + 1,
    startFrame: eventIndex * 30, endFrame: (eventIndex + 1) * 30 };
}

function page(index: number, hasMore: boolean, events: TaeEventSnapshot[], counts?: Map<number, number>): TaeBrowseNativePage {
  const actions = [...new Map(events.map(item => [JSON.stringify([item.taeEntryIndex, item.animId]), item])).values()]
    .map(item => ({ chrId: item.chrId, animId: item.animId, code: item.code,
      ...(item.taeEntryIndex === undefined ? {} : { taeEntryIndex: item.taeEntryIndex }),
      address: `action://c0000/tae/${item.taeEntryIndex}/A${item.animId}`,
      eventCount: counts?.get(item.animId) ?? events.filter(e => e.animId === item.animId && e.taeEntryIndex === item.taeEntryIndex).length,
      eventsTruncated: (counts?.get(item.animId) ?? 0) > events.filter(e => e.animId === item.animId).length }));
  return { ok: true, chrId: 'c0000', sourceHash: 'logical-A', outerFileHash: hash('snapshot-A'), readerSchemaRevision: 2,
    animationCount: 130, totalEventCount: 75226, animationsTruncated: hasMore, actions, events, diagnostics: [] };
}

function success(result: TaeBrowseResult) {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result;
}

async function fixture(run: (input: {
  root: string; filePath: string; edit: NativeEditSession;
  calls: Array<[number, number]>;
  loadPage: (index: number, size: number) => Promise<TaeBrowseNativePage>;
  pages: TaeBrowseNativePage[];
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-browse-'));
  const filePath = join(root, 'chr/c0000.tae'); await mkdir(join(root, 'chr')); await writeFile(filePath, 'snapshot-A');
  const edit = { session: { layers: { overlayRoot: root }, meta: { workspaceId: pathToFileURL(root).href } } } as NativeEditSession;
  const calls: Array<[number, number]> = [];
  const pages = [page(0, true, Array.from({ length: 64 }, (_, i) => event(i))),
    page(1, true, Array.from({ length: 64 }, (_, i) => event(64 + i))), page(2, false, [event(128), event(129)])];
  const loadPage = async (index: number, size: number) => {
    calls.push([index, size]); const result = pages[index]; assert.ok(result, `unexpected native page ${index}`); return result;
  };
  try { await run({ root, filePath, edit, calls, loadPage, pages }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('broad browsing loads one native page and crosses it only after an explicit boundary cursor', async () => fixture(async input => {
  let result = success(await readTaeBrowse({ ...input, pageSize: 7 }));
  assert.equal(assertCursorPrivacy(result, [input.root, pathToFileURL(input.root).href, input.root.split(/[\\/]/u).at(-1)!]), 1);
  assert.deepEqual(input.calls, [[0, 64]]);
  assert.equal(result.pagination.totalCount, null);
  assert.equal(result.pagination.totalPages, null);
  assert.equal(result.totalEventCount, 75226);
  assert.equal(result.nativePagination.animationPage, 0);
  const ordinals = result.events.map(e => e.animId);
  const oldCursor = result.pagination.nextCursor!;
  while (ordinals.length < 64) {
    result = success(await readTaeBrowse({ ...input, cursor: result.pagination.nextCursor!, pageSize: 7 }));
    ordinals.push(...result.events.map(e => e.animId));
    assert.equal(input.calls.length, 1, 'event windows must use the bounded cached native page');
  }
  assert.equal(result.events.length, 1, 'the native page tail must not be filled from another page');
  assert.equal(result.pagination.hasMore, true);
  const boundary = result.pagination.nextCursor!;
  result = success(await readTaeBrowse({ ...input, cursor: boundary, pageSize: 7 }));
  assert.deepEqual(input.calls, [[0, 64], [1, 64]]);
  assert.equal(result.nativePagination.animationPage, 1);
  assert.equal(result.pagination.offset, 64);
  assert.deepEqual(result.events.map(e => e.animId), [64, 65, 66, 67, 68, 69, 70]);
  const replay = success(await readTaeBrowse({ ...input, cursor: oldCursor, pageSize: 7 }));
  assert.deepEqual(replay.events.map(e => e.animId), [7, 8, 9, 10, 11, 12, 13]);
  assert.equal(input.calls.length, 2, 'old cursors must retain their immutable original native page');
}));

test('an empty event page returns its own native continuation without scanning ahead', async () => fixture(async input => {
  input.pages[0] = page(0, true, []);
  const initial = success(await readTaeBrowse(input));
  assert.equal(initial.events.length, 0); assert.equal(initial.pagination.hasMore, true); assert.ok(initial.pagination.nextCursor);
  assert.deepEqual(input.calls, [[0, 64]]);
  const next = success(await readTaeBrowse({ ...input, cursor: initial.pagination.nextCursor }));
  assert.equal(next.nativePagination.animationPage, 1); assert.equal(input.calls.length, 2);
}));

test('broad previews retain true action totals and a source-bound exact-action continuation', async () => fixture(async input => {
  input.pages[0] = page(0, false, Array.from({ length: 200 }, (_, i) => event(10, i)), new Map([[10, 240]]));
  let result = success(await readTaeBrowse({ ...input, pageSize: 128 }));
  assert.equal(result.actions[0]!.eventCount, 240);
  assert.equal(result.actions[0]!.eventsTruncated, true);
  assert.equal(result.actions[0]!.eventsComplete, false);
  const nextRead = result.actions[0]!.pagination.nextRead!;
  assert.deepEqual(nextRead.args.addresses, ['action://c0000/tae/2/A10']);
  assert.equal(nextRead.args.offset, result.events.length);
  assert.equal(nextRead.args.expectedSourceHash, hash('snapshot-A'));
  assert.equal(nextRead.args.expectedReaderSchemaRevision, 2);
  result = success(await readTaeBrowse({ ...input, cursor: result.pagination.nextCursor!, pageSize: 128 }));
  assert.equal(result.events[result.events.length - 1]!.eventIndex, 199);
  assert.equal(result.pagination.hasMore, false); assert.equal(result.pagination.nextCursor, null);
  assert.equal(result.eventsTruncated, true, 'native preview exhaustion must not claim complete source events');
  assert.equal(result.status, 'partial'); assert.equal(input.calls.length, 1);
}));

test('native browsing preserves distinct actions with duplicate animation IDs across sections', async () => fixture(async input => {
  input.pages[0] = page(0, false, [event(10, 0, 2), event(10, 0, 4)]);
  const result = success(await readTaeBrowse(input));
  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions.map(a => a.taeEntryIndex), [2, 4]);
}));

test('invalid broad offsets and mixed continuation inputs are rejected before loading native events', async () => fixture(async input => {
  for (const args of [{ offset: 1 }, { offset: -1 }, { offset: 1.5 }, { cursor: 'bad', offset: 0 }, { cursor: 'bad' }]) {
    const result = await readTaeBrowse({ ...input, ...args }); assert.equal(result.ok, false);
  }
  assert.equal(input.calls.length, 0);
}));

test('a cached page cursor rejects scope, workspace, offset and expiry mismatches without loading another page', async () => fixture(async input => {
  const initial = success(await readTaeBrowse({ ...input, pageSize: 7 })); const cursor = initial.pagination.nextCursor!;
  const payload = parseOpaqueCursor(cursor);
  const wrongScope = await readTaeBrowse({ ...input, filePath: join(input.root, 'chr/c0001.tae'), cursor }); assert.equal(wrongScope.ok, false);
  const otherEdit = { session: { layers: { overlayRoot: input.root }, meta: { workspaceId: 'other-workspace' } } } as NativeEditSession;
  const wrongWorkspace = await readTaeBrowse({ ...input, edit: otherEdit, cursor }); assert.equal(wrongWorkspace.ok, false);
  for (const offset of [-1, 1.5, 999999]) {
    const invalid = await readTaeBrowse({ ...input, cursor: createOpaqueCursor({ ...payload, offset }) }); assert.equal(invalid.ok, false);
  }
  const session = defaultReadSessionManager.getSession(payload.sessionId)!; session.createdAt -= session.ttlMs + 1;
  const expired = await readTaeBrowse({ ...input, cursor }); assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, 'STALE_READ_CURSOR');
  assert.equal(input.calls.length, 1);
}));

test('cached continuation rejects changed disk bytes and never adopts a fresh disk hash', async () => fixture(async input => {
  const initial = success(await readTaeBrowse({ ...input, pageSize: 7 }));
  await writeFile(input.filePath, 'snapshot-B');
  const result = await readTaeBrowse({ ...input, cursor: initial.pagination.nextCursor! });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'STALE_READ_CURSOR');
  assert.equal(input.calls.length, 1);
}));

test('native page transitions reject logical hash, physical hash and reader revision drift', async () => {
  for (const changed of [{ sourceHash: 'logical-B' }, { outerFileHash: hash('snapshot-B') }, { readerSchemaRevision: 3 }]) {
    await fixture(async input => {
      input.pages[0] = page(0, true, [event(0)]);
      input.pages[1] = { ...input.pages[1]!, ...changed };
      const initial = success(await readTaeBrowse(input));
      const result = await readTaeBrowse({ ...input, cursor: initial.pagination.nextCursor! });
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'TAE_SOURCE_VERSION_CHANGED');
      assert.equal(input.calls.length, 2);
    });
  }
});

test('native B projection is rejected even when disk bytes return to A during the page load', async () => fixture(async input => {
  input.pages[0] = page(0, true, [event(0)]);
  const initial = success(await readTaeBrowse(input));
  const loadPage = async (index: number, size: number) => {
    const result = await input.loadPage(index, size);
    await writeFile(input.filePath, 'snapshot-A');
    return { ...result, outerFileHash: hash('snapshot-B') };
  };
  const result = await readTaeBrowse({ ...input, loadPage, cursor: initial.pagination.nextCursor! });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'TAE_SOURCE_VERSION_CHANGED');
}));

test('first native page requires a physical snapshot and validates expected version before minting its cursor', async () => fixture(async input => {
  const original = input.pages[0]!; const { outerFileHash: _omitted, ...missingHash } = original; input.pages[0] = missingHash;
  assert.equal((await readTaeBrowse(input)).ok, false);
  input.pages[0] = original;
  assert.equal((await readTaeBrowse({ ...input, expectedSourceHash: hash('snapshot-B') })).ok, false);
  assert.equal((await readTaeBrowse({ ...input, expectedReaderSchemaRevision: 3 })).ok, false);
}));

test('event windows keep the existing 24k serialization budget', async () => fixture(async input => {
  input.pages[0] = page(0, false, Array.from({ length: 20 }, (_, i) => ({ ...event(10, i), fields: [{ name: 'Large', value: 'x'.repeat(9000) }] })));
  const result = success(await readTaeBrowse({ ...input, pageSize: 128 }));
  assert.equal(result.events.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(result.events), 'utf8') <= 24000);
}));

test('explicit cursors enumerate all native preview pages and finish without missing or repeating actions', async () => fixture(async input => {
  input.pages = input.pages.map(p => ({ ...p, totalEventCount: 130 }));
  const loadPage = async (index: number, size: number) => { input.calls.push([index, size]); return input.pages[index]!; };
  const seen: number[] = []; let cursor: string | undefined; let last: ReturnType<typeof success>;
  do {
    last = success(await readTaeBrowse({ ...input, loadPage, pageSize: 17, ...(cursor ? { cursor } : {}) }));
    seen.push(...last.events.map(e => e.animId)); cursor = last.pagination.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, Array.from({ length: 130 }, (_, i) => i));
  assert.deepEqual(input.calls, [[0, 64], [1, 64], [2, 64]]);
  assert.equal(last!.pagination.hasMore, false); assert.equal(last!.status, 'complete');
}));

test('an earlier native event tail keeps the final preview page honestly partial', async () => fixture(async input => {
  input.pages[0] = page(0, true, [event(10)], new Map([[10, 240]]));
  input.pages[1] = page(1, false, [event(20)]);
  const first = success(await readTaeBrowse(input));
  const last = success(await readTaeBrowse({ ...input, cursor: first.pagination.nextCursor! }));
  assert.equal(last.pagination.hasMore, false); assert.equal(last.eventsTruncated, true); assert.equal(last.status, 'partial');
}));

test('zero-event native actions remain visible with their section identity', async () => fixture(async input => {
  const empty = page(0, false, []);
  empty.actions = [{ chrId: 'c0000', animId: 30, code: 'A0030', address: 'action://c0000/tae/4/A0030', taeEntryIndex: 4, eventCount: 0 }];
  input.pages[0] = empty;
  const result = success(await readTaeBrowse(input));
  assert.equal(result.actions[0]!.eventCount, 0); assert.equal(result.actions[0]!.eventsComplete, true);
  assert.equal(result.actions[0]!.pagination.hasMore, false); assert.equal(result.actions[0]!.taeEntryIndex, 4);
}));

test('loader failures retain their diagnostics and do not mint a continuation', async () => fixture(async input => {
  const diagnostics = [{ severity: 'error' as const, code: 'NATIVE_STOP', message: 'controlled load failure' }];
  const result = await readTaeBrowse({ ...input, loadPage: async () => ({ ok: false, error: { code: 'TAE_READ_FAILED', message: 'controlled failure' }, diagnostics }) });
  assert.equal(result.ok, false); assert.deepEqual(result.diagnostics, diagnostics);
}));

test('a replacement after initial native projection cannot stamp old events with the new disk version', async () => fixture(async input => {
  const loadPage = async (index: number, size: number) => {
    const result = await input.loadPage(index, size); await writeFile(input.filePath, 'snapshot-B'); return result;
  };
  const result = await readTaeBrowse({ ...input, loadPage });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'TAE_SOURCE_VERSION_CHANGED');
  assert.deepEqual(input.calls, [[0, 64]]);
}));

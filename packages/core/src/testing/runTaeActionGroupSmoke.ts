import { createSmokeTemporaryDirectory as mkdtemp } from './harness/smokeWorkspace.js';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import type { TaeExport } from '@soulforge/shared';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';
import { pathToFileURL } from 'node:url';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';

const sourceUri = 'file://chr/c0000.anibnd.dcx';
const events = Array.from({ length: 160 }, (_, index) => ({
  uri: `action://c0000/entry/2/A0010/e${index}`, index, taeEntryIndex: 2,
  eventTypeId: 100 + index, typeName: index === 77 ? 'UniqueNeedle' : 'Sibling',
  startTime: index, endTime: index + 1, startFrame: index * 30, endFrame: (index + 1) * 30,
  fields: [{ name: 'Distance', value: index === 77 ? 43210 : index }]
}));
const bundle: TaeExport = { chrId: 'c0000', sourceUri, readerSchemaRevision: 2,
  animations: [{ animId: 10, code: 'A0010', taeEntryIndex: 2, eventCount: 160, eventsComplete: true, events },
    { animId: 20, code: 'A0020', taeEntryIndex: 2, eventCount: 1, eventsComplete: true, events: [{ ...events[0]!, uri: 'action://c0000/entry/2/A0020/e0', typeName: 'UniqueNeedle' }] }] };
const index = new WorkspaceIndex('tae-group-test'); index.upsertTaeExport(bundle);
const registry = createDefaultToolRegistry();
const found = await registry.run('search_tae_events', { query: 'UniqueNeedle', limit: 1, pageSize: 128 }, { workspaceIndex: index, mode: 'plan' });
assert.equal(found.ok, true);
const data = found.data as any;
assert.equal(data.total, 2, 'limit counts actions, not matching events');
assert.equal(data.matches.length, 1);
assert.equal(data.matches[0].item.animId, 10);
assert.deepEqual(data.matches[0].item.events.map((event: any) => event.index), Array.from({ length: data.matches[0].item.events.length }, (_, i) => i));
assert.equal(data.matches[0].item.pagination.totalCount, 160);
assert.equal(data.matches[0].item.eventsComplete, false);
assert.equal(data.matches[0].item.indexedEventsComplete, true);
assert.equal(data.matches[0].item.eventsTruncated, true);
assert.equal(data.matches[0].item.pagination.totalPages, 2);
assert.equal(data.matches[0].item.pagination.nextRead.args.offset, data.matches[0].item.events.length);
const model = await createAgentToolBridge({ registry, context: { workspaceIndex: index, mode: 'plan' } }).executeTool({ id: 'group', name: 'search_tae_events', argumentsJson: JSON.stringify({ query: 'UniqueNeedle', limit: 1, pageSize: 7 }) });
assert.equal(model.ok, true);
assert.equal(JSON.parse(model.content).data.record.matches[0].item.events.length, 7, 'Agent transport must preserve every delivered sibling');
assert.equal(JSON.parse(model.content).data.record.matches[0].item.eventsComplete, false);
assert.equal(JSON.parse(model.content).data.record.matches[0].item.indexedEventsComplete, true);
assert.equal(JSON.parse(model.content).data.record.matches[0].item.eventsTruncated, true);
const second = await registry.run('search_tae_events', { cursor: data.nextCursor }, { workspaceIndex: index, mode: 'plan' });
assert.equal((second.data as any).matches[0].item.animId, 20);
assert.equal((second.data as any).matches[0].item.eventsComplete, true);
assert.equal((second.data as any).matches[0].item.eventsTruncated, false);

const root = await mkdtemp(join(tmpdir(), 'sf-tae-action-group-'));
await mkdir(join(root, 'chr')); const file = join(root, 'chr/c0000.anibnd.dcx'); await writeFile(file, 'fixture');
let animations = [{ animId: 10, taeEntryIndex: 2, events: events.map((event) => ({ ...event, templateFields: event.fields })) }];
const key = Symbol.for('sf.tae.action-group.bridge');
(globalThis as any)[key] = async (input: any) => ({ parseStatus: 'parsed', diagnostics: [], data: { sourceHash: 'fixture-hash', identityProjectionVersion: 2, animations: input.commandOptions?.taeEntryIndex === undefined ? animations : animations.filter((animation) => animation.taeEntryIndex === input.commandOptions.taeEntryIndex) } });
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === '../bridge/runBridge.js' && context.parentURL?.includes('/editing/taeEdit.js') ? { url: 'sf:tae-action-group', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'sf:tae-action-group' ? { format: 'module', shortCircuit: true, source: `export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.action-group.bridge')](input); }` } : next(url, context); }
});
try {
  const { readTaeEvents } = await import(new URL('../editing/taeEdit.js?group-test', import.meta.url).href) as typeof import('../editing/taeEdit.js');
  const edit = { session: { layers: { overlayRoot: root }, meta: { workspaceId: pathToFileURL(root).href }, resolveWritablePath: (absolutePath: string) => ({ ok: true, absolutePath, diagnostics: [] }) }, allowedRoots: () => [root] } as unknown as NativeEditSession;
  // d: exact-action cursors are bound to their host read session.
  const initial = await readTaeEvents({ edit, file, addresses: ['c0000#A0010'], pageSize: 7 });
  assert.equal(initial.ok, true, JSON.stringify(initial));
  if (initial.ok) {
    const firstCursor = initial.pagination.nextCursor!;
    assert.ok(assertCursorPrivacy(initial, [root, pathToFileURL(root).href, root.split(/[\\/]/u).at(-1)!]) >= 1);
    const payload = parseOpaqueCursor(firstCursor);
    // Cross-workspace replay: same relative file, addresses and source hash in
    // another workspace yields the identical queryScope; the live session must reject it.
    const otherEdit = { ...edit, session: { ...edit.session, meta: { ...edit.session.meta, workspaceId: 'file:///home/bob/other-workspace' } } } as NativeEditSession;
    const crossed = await readTaeEvents({ edit: otherEdit, file, addresses: ['c0000#A0010'], cursor: firstCursor });
    assert.equal(crossed.ok, false, 'an exact-action host session must reject another workspace');
    if (!crossed.ok) assert.equal(crossed.error.code, 'TAE_CURSOR_SCOPE_MISMATCH');
    // Cross-session replay: keep this request's scope but point the sessionId at a
    // different live session (other query, same workspace and source hash).
    const decoy = defaultReadSessionManager.createSession({
      workspaceId: edit.session.meta.workspaceId,
      sourceVersion: { sourceUri: 'file://chr/c9999.anibnd.dcx', sourceHash: payload.sourceHash },
      domain: 'tae', queryScope: 'tae-events:file://chr/c9999.anibnd.dcx:["c9999#A0001"]',
      items: [{ ...events[0]!, eventIndex: 0, animId: 1, typeName: 'DecoyFromOtherSession' }]
    });
    const forged = await readTaeEvents({ edit, file, addresses: ['c0000#A0010'], cursor: createOpaqueCursor({ ...payload, sessionId: decoy.sessionId, offset: 0 }) });
    assert.equal(forged.ok, false, 'a cursor must not read another read session through a matching scope string');
    if (!forged.ok) assert.equal(forged.error.code, 'TAE_CURSOR_SCOPE_MISMATCH');
    defaultReadSessionManager.invalidate(decoy.sessionId);
    // Same session continues normally.
    const continued = await readTaeEvents({ edit, file, addresses: ['c0000#A0010'], cursor: firstCursor });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    // Expired session keeps the structured stale diagnostic.
    const session = defaultReadSessionManager.getSession(payload.sessionId)!;
    session.createdAt -= session.ttlMs + 1;
    const expired = await readTaeEvents({ edit, file, addresses: ['c0000#A0010'], cursor: firstCursor });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.error.code, 'STALE_READ_CURSOR');
  }
  let cursor: string | undefined; const ordinals: number[] = [];
  do {
    const read = await readTaeEvents({ edit, file, addresses: ['c0000#A0010'], pageSize: 7, ...(cursor ? { cursor } : {}) });
    assert.equal(read.ok, true, JSON.stringify(read)); if (!read.ok) break;
    assert.equal((read as any).readerSchemaRevision, 2, 'facade preserves the actual Bridge identity version');
    ordinals.push(...read.events.map((event) => event.eventIndex)); cursor = read.pagination.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ordinals, Array.from({ length: 160 }, (_, i) => i), 'action paging must neither omit nor repeat siblings');
  animations = [...animations, { ...animations[0]!, taeEntryIndex: 4 }];
  const ambiguous = await readTaeEvents({ edit, file, addresses: ['c0000#A0010'] });
  assert.equal(ambiguous.ok, false); if (!ambiguous.ok) assert.equal(ambiguous.error.code, 'TAE_EVENT_AMBIGUOUS');
} finally { hooks.deregister(); delete (globalThis as any)[key]; await rm(root, { recursive: true, force: true }); }
console.log('TAE action groups: PASS');

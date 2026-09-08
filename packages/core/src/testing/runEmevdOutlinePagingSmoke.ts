/** Exercise the production registry with a reader-only mock; no native Bridge or files. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolContext } from '../ai/toolRegistry.js';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';

export async function runEmevdOutlinePagingSmoke(): Promise<void> {
  const registryUrl = new URL('../ai/toolRegistry.js', import.meta.url);
  registryUrl.search = '?outline-paging-fixture';
  const readerUrl = new URL('../editing/emevdEdit.js', import.meta.url).href;
  const mockUrl = 'soulforge-outline-fixture:reader';
  const callbackKey = Symbol.for('soulforge.outline-paging-fixture.reader');
  const fixtureGlobals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previousCallback = fixtureGlobals[callbackKey];
  const root = join(tmpdir(), 'soulforge-outline-paging-fixture');
  const filePath = join(root, 'event', 'm11_00_00_00.emevd.dcx');
  const sourceUri = 'file://event/m11_00_00_00.emevd.dcx';
  const sourceHash = 'a'.repeat(64);
  const allEvents = Array.from({ length: 129 }, (_, index) => ({
    eventId: 11100000 + index, restBehavior: index % 3, instructionCount: index + 1
  }));
  let nativeCalls = 0;
  fixtureGlobals[callbackKey] = async () => {
    nativeCalls += 1;
    return { ok: true, filePath, sourceHash, events: allEvents, diagnostics: [] };
  };
  // The isolated registry instance resolves only its EMEVD reader to this mock.
  // Canonical production module caches remain untouched after hooks deregister.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === registryUrl.href && specifier === '../editing/emevdEdit.js') {
        return { url: mockUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === mockUrl) {
        return {
          format: 'module', shortCircuit: true,
          source: `export * from ${JSON.stringify(readerUrl)};
export async function readEmevdOutline(input) {
  return globalThis[Symbol.for('soulforge.outline-paging-fixture.reader')](input);
}`
        };
      }
      return nextLoad(url, context);
    }
  });
  try {
    const { createDefaultToolRegistry } = await import(registryUrl.href) as typeof import('../ai/toolRegistry.js');
    const registry = createDefaultToolRegistry();
    const workspaceId = 'outline-paging-fixture';
    const index = new WorkspaceIndex(workspaceId);
    index.setFiles([{
      id: sourceUri, workspaceId, sourceUri, sourcePath: 'event/m11_00_00_00.emevd.dcx',
      absolutePath: filePath, relativePath: 'event/m11_00_00_00.emevd.dcx', game: 'sekiro',
      resourceKind: 'event', extension: '.dcx', compoundExtension: '.emevd.dcx',
      formatKind: 'emevd', formatLabel: 'EMEVD', size: 123, mtimeMs: 456,
      sha256: sourceHash, parseStatus: 'partial', diagnostics: []
    }]);
    const layers = { overlayRoot: root };
    const unexpectedWrite = (): never => { throw new Error('Outline fixture must not request a write'); };
    const session: WorkspaceSession = {
      layers,
      meta: { workspaceId, layers, game: 'sekiro', openedAt: '2026-09-08T00:00:00Z', baseMissing: true },
      isOverlayPath: () => true, isBasePath: () => false,
      resolveWritablePath: unexpectedWrite,
      resolveWritablePathSecure: async () => unexpectedWrite(),
      toOverlayPath: (relativePath) => join(root, relativePath),
      toBasePath: () => undefined
    };
    let indexedRefreshes = 0;
    const context: ToolContext = {
      workspaceIndex: index, session, mode: 'plan', operationLogStore: new MemoryOperationLogStore(),
      onSemanticEvidenceUpdated: async () => {
        indexedRefreshes += 1;
        assert.equal(index.getStats().events, allEvents.length, 'the full outline must remain indexed on every page');
      }
    };
    const descriptor = registry.list().find((tool) => tool.name === 'read_emevd_outline');
    assert.equal(descriptor?.permissionLevel, 'read');
    assert.deepEqual(descriptor?.inputSchema, { file: 'string', offset: 'safe-integer?', limit: 'safe-integer?' });

    const observed: number[] = [];
    let input: Record<string, unknown> = { file: sourceUri };
    do {
      const result = await registry.run('read_emevd_outline', input, context);
      assert.equal(result.ok, true);
      const page = result.data as {
        events: typeof allEvents; total: number; totalCount: number; returned: number;
        returnedCount: number; offset: number; limit: number; truncated: boolean;
        darkScriptComplete: boolean; sourceHash: string; nextOffset?: number;
        continuationParams?: Record<string, unknown>;
      };
      assert.equal(page.total, allEvents.length);
      assert.equal(page.totalCount, allEvents.length);
      assert.equal(page.limit, 8);
      assert.equal(page.returned, page.events.length);
      assert.equal(page.returnedCount, page.events.length);
      assert.ok(page.events.length <= 8);
      assert.equal(page.darkScriptComplete, false);
      assert.equal(page.sourceHash, sourceHash);
      assert.deepEqual(page.events, allEvents.slice(page.offset, page.offset + page.limit));
      observed.push(...page.events.map((event) => event.eventId));
      if (!page.truncated) {
        assert.equal(page.nextOffset, undefined);
        assert.equal(page.continuationParams, undefined);
        break;
      }
      assert.equal(page.nextOffset, page.offset + page.events.length);
      assert.deepEqual(page.continuationParams, { file: sourceUri, offset: page.nextOffset, limit: 8 });
      input = page.continuationParams!;
    } while (observed.length <= allEvents.length);
    assert.deepEqual(observed, allEvents.map((event) => event.eventId));
    assert.equal(nativeCalls, indexedRefreshes);
    assert.equal(nativeCalls, Math.ceil(allEvents.length / 8));

    for (const limit of [1, 16]) {
      const result = await registry.run('read_emevd_outline', { file: sourceUri, offset: 7, limit }, context);
      assert.equal(result.ok, true);
      assert.deepEqual((result.data as { events: typeof allEvents }).events, allEvents.slice(7, 7 + limit));
    }
    const empty = await registry.run('read_emevd_outline', { file: sourceUri, offset: allEvents.length }, context);
    assert.equal(empty.ok, true);
    assert.equal((empty.data as { returned: number }).returned, 0);
    assert.equal((empty.data as { truncated: boolean }).truncated, false);

    const callsBeforeInvalid = nativeCalls;
    for (const invalid of [
      { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: '0' },
      { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 17 }, { limit: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      const result = await registry.run('read_emevd_outline', { file: sourceUri, ...invalid }, context);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'INVALID_INPUT');
    }
    assert.equal(nativeCalls, callsBeforeInvalid, 'invalid pagination must fail before invoking the reader');

    const bridge = createAgentToolBridge({ registry, context });
    const bridged = await bridge.executeTool({
      id: 'outline-page', name: 'read_emevd_outline',
      argumentsJson: JSON.stringify({ file: sourceUri, offset: 8, limit: 3 })
    });
    assert.equal(bridged.ok, true);
    const envelope = JSON.parse(bridged.content);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.completeness, 'windowed');
    assert.equal(envelope.pagination.total, allEvents.length);
    assert.equal(envelope.pagination.offset, 8);
    assert.equal(envelope.pagination.limit, 3);
    assert.equal(envelope.pagination.returnedCount, 3);
    assert.equal(envelope.pagination.continuationParams.offset, 11);
    assert.equal(envelope.pagination.continuationParams.limit, 3);
    assert.deepEqual(envelope.data.record.events, allEvents.slice(8, 11));
    assert.equal(envelope.data.record.darkScriptComplete, false);
  } finally {
    hooks.deregister();
    if (previousCallback === undefined) delete fixtureGlobals[callbackKey];
    else fixtureGlobals[callbackKey] = previousCallback;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEmevdOutlinePagingSmoke().then(() => {
    console.log('EMEVD outline paging smoke passed.');
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

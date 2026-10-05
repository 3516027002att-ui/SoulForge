import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';
import { createAgentToolBridge } from '../agentToolBridge.js';
import { ToolRegistry, type ToolContext } from '../toolRegistry.js';
import { WorkspaceIndex } from '../../indexing/workspaceIndex.js';
import { assertCursorPrivacy } from '../../testing/harness/assertCursorPrivacy.js';

test('LuaBND catalog cursors conceal fallback paths and remain bound across a host restart', async () => {
  const workspaceId = 'file:///C:/Users/Alice/private-mod-workspace';
  const containerPath = 'C:/Users/Alice/private-mod-workspace/script/fixture.luabnd.dcx';
  const sourceUri = `${workspaceId}/script/fixture.luabnd.dcx`;
  const calls: string[] = [];
  let hash = 'a'.repeat(64);
  const key = Symbol.for('sf.luabnd.cursor-privacy');
  (globalThis as any)[key] = async (input: { file: string }) => {
    calls.push(input.file);
    return { ok: true, containerPath, sourceUri, outerFileHash: hash, sourceRevision: 1,
      catalogComplete: true, entryCount: 8, scriptCount: 8, diagnostics: [],
      scripts: Array.from({ length: 8 }, (_, i) => ({ name: `script${i}.lua`, sanitizedName: `script${i}.lua`,
        size: 10, isBytecode: false, contentKind: 'source', contentHash: 'b'.repeat(64) })) };
  };
  // Only native catalog loading is substituted; the real tool, cursor authority,
  // workspace projection and model transport all run unchanged.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === '../../editing/luabndEdit.js' && context.parentURL?.includes('/ai/tools/list_luabnd_scripts.js?privacy')
        ? { url: 'sf:luabnd-cursor-privacy', shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      return url === 'sf:luabnd-cursor-privacy' ? { format: 'module', shortCircuit: true,
        source: `export async function listLuabndScripts(input) { return globalThis[Symbol.for('sf.luabnd.cursor-privacy')](input); }` }
        : next(url, context);
    }
  });
  try {
    const { createListLuabndScriptsTool } = await import(new URL('./list_luabnd_scripts.js?privacy', import.meta.url).href) as typeof import('./list_luabnd_scripts.js');
    const session = { meta: { workspaceId }, layers: { overlayRoot: 'C:/Users/Alice/private-mod-workspace' } } as ToolContext['session'];
    const context = { session, editSession: { session }, workspaceIndex: new WorkspaceIndex(workspaceId), mode: 'plan' } as ToolContext;
    const registry = new ToolRegistry(); registry.register(createListLuabndScriptsTool());
    const bridge = createAgentToolBridge({ registry, context });
    const first = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2 }, context);
    assert.equal(first.ok, true, JSON.stringify(first));
    const page = first.data as { nextCursor: string; scripts: Array<{ sanitizedName: string }> };
    assert.equal(assertCursorPrivacy(first, [workspaceId, containerPath, 'private-mod-workspace', '/Users/Alice']), 1);
    assert.deepEqual(page.scripts.map(script => script.sanitizedName), ['script0.lua', 'script1.lua']);
    const legacy = createOpaqueCursor({ ...parseOpaqueCursor(page.nextCursor), scope: `luabnd-scripts:${sourceUri}` });
    const rejectedLegacy = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: legacy }, context);
    assert.equal(rejectedLegacy.ok, false);
    assert.equal(rejectedLegacy.error?.code, 'LUABND_CURSOR_SCOPE_MISMATCH');
    assert.ok(!JSON.stringify(rejectedLegacy).includes('private-mod-workspace'), 'legacy rejection must not echo its decodable path');
    const model = await bridge.executeTool({ id: 'catalog', name: 'list_luabnd_scripts', argumentsJson: JSON.stringify({ file: containerPath, pageSize: 2 }) });
    assert.equal(model.ok, true, model.content);
    assert.ok(assertCursorPrivacy(JSON.parse(model.content), [workspaceId, 'private-mod-workspace']) >= 1);
    const otherContext = { ...context, session: { ...session!, meta: { ...session!.meta, workspaceId: 'other-workspace' } },
      workspaceIndex: new WorkspaceIndex('other-workspace') } as ToolContext;
    otherContext.editSession = { ...context.editSession!, session: otherContext.session! };
    const crossed = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: page.nextCursor }, otherContext);
    assert.equal(crossed.ok, false);
    assert.equal(crossed.error?.code, 'LUABND_CURSOR_SCOPE_MISMATCH');
    defaultReadSessionManager.invalidate(parseOpaqueCursor(page.nextCursor).sessionId);
    const continued = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: page.nextCursor }, context);
    assert.equal(continued.ok, true);
    const next = continued.data as { offset: number; scripts: Array<{ sanitizedName: string }> };
    assert.equal(next.offset, 2);
    assert.deepEqual(next.scripts.map(script => script.sanitizedName), ['script2.lua', 'script3.lua']);
    assert.equal(assertCursorPrivacy(continued, [workspaceId, containerPath, 'private-mod-workspace']), 1);
    hash = 'c'.repeat(64);
    const stale = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: page.nextCursor }, context);
    assert.equal(stale.ok, false); assert.equal(stale.error?.code, 'STALE_READ_CURSOR');
    assert.ok(calls.every(file => file === containerPath), 'native tool arguments must preserve their original bytes');
  } finally {
    hooks.deregister(); delete (globalThis as any)[key];
  }
});

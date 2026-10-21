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
  // Not indexed: canonicalScriptSourceUri falls back to this absolute file:// URL.
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
    assert.ok(parseOpaqueCursor(page.nextCursor).scope.startsWith('luabnd-scripts-v2:'));
    assert.deepEqual(page.scripts.map(script => script.sanitizedName), ['script0.lua', 'script1.lua']);
    // Pre-hash scope (absolute container URL) is rejected, not migrated.
    const legacy = createOpaqueCursor({ ...parseOpaqueCursor(page.nextCursor), scope: `luabnd-scripts:${sourceUri}` });
    const rejectedLegacy = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: legacy }, context);
    assert.equal(rejectedLegacy.ok, false);
    assert.equal(rejectedLegacy.error?.code, 'LUABND_CURSOR_SCOPE_MISMATCH');
    assert.ok(!JSON.stringify(rejectedLegacy).includes('private-mod-workspace'), 'legacy rejection must not echo its decodable path');
    const model = await bridge.executeTool({ id: 'catalog', name: 'list_luabnd_scripts', argumentsJson: JSON.stringify({ file: containerPath, pageSize: 2 }) });
    assert.equal(model.ok, true, model.content);
    assert.ok(assertCursorPrivacy(JSON.parse(model.content), [workspaceId, 'private-mod-workspace']) >= 1);
    // Same container path in another workspace: the scope digest differs.
    const otherContext = { ...context, session: { ...session!, meta: { ...session!.meta, workspaceId: 'other-workspace' } },
      workspaceIndex: new WorkspaceIndex('other-workspace') } as ToolContext;
    otherContext.editSession = { ...context.editSession!, session: otherContext.session! };
    const crossed = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: page.nextCursor }, otherContext);
    assert.equal(crossed.ok, false);
    assert.equal(crossed.error?.code, 'LUABND_CURSOR_SCOPE_MISMATCH');
    // Host restart: the stateless fallback still continues in the same workspace.
    defaultReadSessionManager.invalidate(parseOpaqueCursor(page.nextCursor).sessionId);
    const continued = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: page.nextCursor }, context);
    assert.equal(continued.ok, true, JSON.stringify(continued));
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

test('LuaBND catalog cursors cannot borrow a read session bound to another workspace, domain or catalog', async () => {
  const workspaceId = 'workspace-a';
  const containerPath = 'C:/mods/a/script/shared.luabnd.dcx';
  const key = Symbol.for('sf.luabnd.session-binding');
  const scripts = (prefix: string) => Array.from({ length: 4 }, (_, i) => ({ name: `${prefix}${i}.lua`, sanitizedName: `${prefix}${i}.lua`,
    size: 10, isBytecode: false, contentKind: 'source', contentHash: 'd'.repeat(64) }));
  (globalThis as any)[key] = async () => ({ ok: true, containerPath, sourceUri: 'script/shared.luabnd.dcx', outerFileHash: 'e'.repeat(64),
    sourceRevision: 1, catalogComplete: true, entryCount: 4, scriptCount: 4, diagnostics: [], scripts: scripts('own') });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === '../../editing/luabndEdit.js' && context.parentURL?.includes('/ai/tools/list_luabnd_scripts.js?binding')
        ? { url: 'sf:luabnd-session-binding', shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      return url === 'sf:luabnd-session-binding' ? { format: 'module', shortCircuit: true,
        source: `export async function listLuabndScripts(input) { return globalThis[Symbol.for('sf.luabnd.session-binding')](input); }` }
        : next(url, context);
    }
  });
  try {
    const { createListLuabndScriptsTool } = await import(new URL('./list_luabnd_scripts.js?binding', import.meta.url).href) as typeof import('./list_luabnd_scripts.js');
    const session = { meta: { workspaceId }, layers: { overlayRoot: 'C:/mods/a' } } as ToolContext['session'];
    const context = { session, editSession: { session }, mode: 'plan' } as ToolContext;
    const registry = new ToolRegistry(); registry.register(createListLuabndScriptsTool());
    const first = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2 }, context);
    assert.equal(first.ok, true, JSON.stringify(first));
    const own = parseOpaqueCursor((first.data as { nextCursor: string }).nextCursor);
    // A session with the same catalog hash (same relative container and contents)
    // can exist for another workspace or another domain in the process-global table.
    const foreignSessions = [
      { workspaceId: 'workspace-b', domain: 'script' as const, queryScope: 'luabnd-scripts-v2:other-workspace' },
      { workspaceId, domain: 'emevd' as const, queryScope: own.scope },
      { workspaceId, domain: 'script' as const, queryScope: 'luabnd-scripts-v2:other-catalog' }
    ].map((binding) => defaultReadSessionManager.createSession({ ...binding,
      sourceVersion: { sourceUri: 'script/shared.luabnd.dcx', sourceHash: own.sourceHash }, items: scripts('foreign-secret') }));
    for (const foreign of foreignSessions) {
      const forged = createOpaqueCursor({ ...own, sessionId: foreign.sessionId });
      const result = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: forged }, context);
      assert.ok(!JSON.stringify(result).includes('foreign-secret'), `borrowed ${foreign.domain}/${foreign.workspaceId} session items: ${JSON.stringify(result)}`);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'LUABND_CURSOR_SCOPE_MISMATCH');
      defaultReadSessionManager.invalidate(foreign.sessionId);
    }
    // The tool's own session still continues.
    const continued = await registry.run('list_luabnd_scripts', { file: containerPath, pageSize: 2, cursor: (first.data as { nextCursor: string }).nextCursor }, context);
    assert.equal(continued.ok, true, JSON.stringify(continued));
    assert.deepEqual((continued.data as { scripts: Array<{ sanitizedName: string }> }).scripts.map((s) => s.sanitizedName), ['own2.lua', 'own3.lua']);
  } finally {
    hooks.deregister(); delete (globalThis as any)[key];
  }
});

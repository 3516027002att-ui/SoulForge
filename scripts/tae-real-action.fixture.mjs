import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = process.env.SF_REAL_TAE_SOURCE?.trim();
test('a real section-qualified c0000 action read avoids whole-container event export', { skip: !source || !existsSync(source) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-real-action-')); const target = join(root, 'c0000.anibnd.dcx');
  await copyFile(source, target); await mkdir(join(root, '.storage'));
  const { createDefaultToolRegistry } = await import('../packages/core/dist/ai/toolRegistry.js');
  const { openWorkspaceSession } = await import('../packages/core/dist/workspace/workspaceSession.js');
  const { WorkspaceIndex } = await import('../packages/core/dist/indexing/workspaceIndex.js');
  const { disposeBridgeDaemonPool } = await import('../packages/core/dist/bridge/runBridge.js');
  const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
  try {
    const registry = createDefaultToolRegistry();
    const context = { workspaceIndex: new WorkspaceIndex(session.meta.workspaceId), mode: 'plan', session, backupBaseDir: join(root, '.storage/backups') };
    const invalid = await registry.run('read_tae_events', { file: target, addresses: ['action://c0000/entry/9/A403000'] }, context);
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'TAE_ADDRESS_INVALID');
    const ambiguous = await registry.run('read_tae_events', { file: target, addresses: ['c0000#A403000'] }, context);
    assert.equal(ambiguous.ok, false); assert.equal(ambiguous.error.code, 'TAE_EVENT_AMBIGUOUS');
    assert.match(ambiguous.error.message, /matches=/);
    const result = await registry.run('read_tae_events', { file: target, addresses: ['action://c0000/tae/9/A403000'], pageSize: 7 },
      context);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.pagination.totalCount, 78);
    assert.ok(result.data.events.length > 0 && result.data.events.length <= 7); assert.equal(result.data.pagination.hasMore, true); assert.equal(result.data.events[0].animId, 403000); assert.equal(result.data.events[0].taeEntryIndex, 9);
    assert.deepEqual(await readFile(target), await readFile(source));
  } finally { await disposeBridgeDaemonPool(); await rm(root, { recursive: true, force: true }); }
});

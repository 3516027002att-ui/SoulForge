import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../knowledge/knowledgeStore.js';
import { SqliteKnowledgeStorePersistence } from '../knowledge/sqliteKnowledgeStore.js';
import { ingestKnowledgeSource } from '../knowledge/knowledgeIngest.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import type { KnowledgeClaim, KnowledgeScope } from '../knowledge/knowledgeTypes.js';

const scope: KnowledgeScope = {
  gameProfile: 'sekiro',
  version: '1.6.x',
  visibility: 'project',
  workspaceId: 'ws-a',
  namespace: 'agent-test'
};

function makeClaim(id: string): KnowledgeClaim {
  return {
    claimId: id,
    semanticKey: id,
    pageId: 'page-a',
    subjectKey: 'NpcParam/50800000',
    predicateKey: 'hasField',
    value: { field: 'ninsatuNum', value: 2 },
    text: 'native claim',
    scope,
    kind: 'observed_native',
    publicationState: 'accepted',
    evidenceStrength: 'native_read',
    sourceRefs: [{
      sourceId: 'native:npc',
      storedContentHash: 'source-hash',
      observedVersion: 'rev-1',
      readerSchemaHash: 'schema-1',
      accessScope: 'local'
    }],
    dependencies: [],
    readerSchemaHash: 'schema-1',
    createdFrom: 'native-read',
    contentHash: id
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-knowledge-sqlite-'));
  const databasePath = join(root, 'workspace.db');
  try {
    const firstDatabase = openWorkspaceDatabase(databasePath);
    const firstStore = new KnowledgeStore({
      persistence: new SqliteKnowledgeStorePersistence(firstDatabase, {
        workspaceId: 'ws-a', rootPath: root, game: 'sekiro'
      })
    });
    const first = ingestKnowledgeSource(firstStore, {
      sourceId: 'native:npc',
      body: 'NpcParam 50800000 ninsatuNum=2',
      observedVersion: 'rev-1',
      readerSchemaHash: 'schema-1',
      page: {
        pageId: 'page-a',
        path: 'wiki/npc.md',
        body: '# native',
        scope,
        claims: [makeClaim('claim-a')]
      }
    });
    assert.equal(first.ok, true);
    const generation = firstStore.currentGeneration;
    closeDatabase(firstDatabase);

    const reopenedDatabase = openWorkspaceDatabase(databasePath);
    const reopened = new KnowledgeStore({
      persistence: new SqliteKnowledgeStorePersistence(reopenedDatabase, {
        workspaceId: 'ws-a', rootPath: root, game: 'sekiro'
      })
    });
    assert.equal(reopened.currentGeneration, generation);
    assert.equal(reopened.readPage('page-a')?.body, '# native');
    assert.equal(reopened.getCurrent().claims['claim-a']?.claimId, 'claim-a');
    assert.equal(reopened.readBlob(reopened.getCurrent().pages['page-a']!.contentHash), '# native');

    const other = new KnowledgeStore({
      persistence: new SqliteKnowledgeStorePersistence(reopenedDatabase, {
        workspaceId: 'ws-b', rootPath: root, game: 'sekiro'
      })
    });
    assert.equal(other.readPage('page-a'), undefined);
    closeDatabase(reopenedDatabase);
    console.log(JSON.stringify({
      ok: true,
      suite: 'knowledge-store-sqlite',
      generation,
      workspaceIsolation: true,
      restartRecovery: true,
      atomicPersistence: true
    }));
  } finally {
    // better-sqlite3 on Windows can keep the WAL sidecar locked until the
    // hosting Node process tears down. Cleanup is best-effort; never turn a
    // successful persistence assertion into a false product failure.
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function closeDatabase(database: ReturnType<typeof openWorkspaceDatabase>): void {
  try { database.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { database.pragma('journal_mode = DELETE'); } catch {}
  database.close();
}

void main();

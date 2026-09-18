import type { KnowledgeGeneration, KnowledgePatch, KnowledgePage } from './knowledgeTypes.js';
import {
  KnowledgeStore,
  type KnowledgeStoreLike,
  type KnowledgeStoreSnapshot
} from './knowledgeStore.js';
import type { SqliteDatabase } from '../storage/sqliteDatabase.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';

export interface OpenSqliteKnowledgeStoreOptions {
  databasePath: string;
  workspaceId: string;
  rootPath: string;
  game?: string;
  nativeBinding?: string;
}

/**
 * Durable knowledge read/commit store.  It stores claims and source revisions
 * only; it has no file writer, Patch Engine port or Mod path authority.
 */
export class SqliteKnowledgeStore implements KnowledgeStoreLike {
  private readonly delegate: KnowledgeStore;
  private readonly database: SqliteDatabase;
  private readonly workspaceId: string;
  private closed = false;

  constructor(options: OpenSqliteKnowledgeStoreOptions) {
    this.workspaceId = options.workspaceId;
    this.database = openWorkspaceDatabase(options.databasePath, {
      ...(options.nativeBinding ? { nativeBinding: options.nativeBinding } : {})
    });
    const now = new Date().toISOString();
    this.database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET root_path=excluded.root_path, game=excluded.game, updated_at=excluded.updated_at
`).run(options.workspaceId, options.rootPath, options.game ?? 'unknown', now, now);
    this.delegate = new KnowledgeStore();
    this.load(options.workspaceId);
  }

  get currentGeneration(): string { return this.delegate.currentGeneration; }
  getCurrent(): KnowledgeGeneration { return this.delegate.getCurrent(); }
  readPage(pageId: string, generationId?: string): KnowledgePage | undefined { return this.delegate.readPage(pageId, generationId); }
  readBlob(hash: string): string | undefined { return this.delegate.readBlob(hash); }
  registerBlob(body: string): string { return this.delegate.registerBlob(body); }
  sourceRevision(sourceId: string): string | undefined { return this.delegate.sourceRevision(sourceId); }
  generation(generationId: string): KnowledgeGeneration | undefined { return this.delegate.generation(generationId); }
  generationsForRecovery(): KnowledgeGeneration[] { return this.delegate.generationsForRecovery(); }

  commitPatch(patch: KnowledgePatch): ReturnType<KnowledgeStore['commitPatch']> {
    this.assertOpen();
    const current = this.database.prepare<[string], { generation_id: string }>(`
SELECT generation_id FROM knowledge_current WHERE workspace_id = ?
`).get(this.workspaceId);
    if (current && current.generation_id !== patch.expectedGeneration) {
      return { ok: false, code: 'CAS_CONFLICT', message: '持久化知识 generation 已变化。' };
    }
    const before = this.delegate.snapshot();
    const result = this.delegate.commitPatch(patch);
    if (!result.ok) return result;
    const after = this.delegate.snapshot();
    try {
      this.database.transaction(() => {
        this.persistSnapshot(after);
        const updated = this.database.prepare(`
UPDATE knowledge_current SET generation_id = ?, updated_at = ?
WHERE workspace_id = ? AND generation_id = ?
`).run(after.current, new Date().toISOString(), this.workspaceId, patch.expectedGeneration);
        if (updated.changes !== 1) {
          throw new KnowledgeCasConflict();
        }
      }).immediate();
    } catch (error) {
      this.delegate.restore(before);
      if (error instanceof KnowledgeCasConflict) {
        return { ok: false, code: 'CAS_CONFLICT', message: '持久化知识 generation 已变化。' };
      }
      throw error;
    }
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.database.open) this.database.close();
  }

  private load(workspaceId: string): void {
    const row = this.database.prepare<[string], { generation_id: string }>(`
SELECT generation_id FROM knowledge_current WHERE workspace_id = ?
`).get(workspaceId);
    if (!row) {
      this.persistInitial(workspaceId);
      return;
    }
    const state = this.database.prepare<[string, string], { state_json: string }>(`
SELECT state_json FROM knowledge_generations WHERE workspace_id = ? AND generation_id = ?
`).get(workspaceId, row.generation_id);
    if (!state) throw new Error('KNOWLEDGE_STORE_CORRUPT_CURRENT');
    const snapshot = JSON.parse(state.state_json) as KnowledgeStoreSnapshot;
    if (!snapshot || snapshot.current !== row.generation_id || !Array.isArray(snapshot.generations)) {
      throw new Error('KNOWLEDGE_STORE_CORRUPT_SNAPSHOT');
    }
    this.delegate.restore(snapshot);
  }

  private persistInitial(workspaceId: string): void {
    const snapshot = this.delegate.snapshot();
    this.database.transaction(() => {
      this.persistSnapshot(snapshot);
      this.database.prepare(`
INSERT INTO knowledge_current (workspace_id, generation_id, updated_at)
VALUES (?, ?, ?)
`).run(workspaceId, snapshot.current, new Date().toISOString());
    }).immediate();
  }

  private persistSnapshot(snapshot: KnowledgeStoreSnapshot): void {
    const stateJson = JSON.stringify(snapshot);
    const statement = this.database.prepare(`
INSERT INTO knowledge_generations (workspace_id, generation_id, parent_generation, schema_version, created_at, state_json)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, generation_id) DO UPDATE SET state_json=excluded.state_json
`);
    for (const generation of snapshot.generations) {
      statement.run(this.workspaceId, generation.generationId, generation.parentGeneration, generation.schemaVersion, generation.createdAt, stateJson);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('KNOWLEDGE_STORE_CLOSED');
  }

}

class KnowledgeCasConflict extends Error {
  constructor() {
    super('KNOWLEDGE_CAS_CONFLICT');
  }
}

export function openSqliteKnowledgeStore(options: OpenSqliteKnowledgeStoreOptions): SqliteKnowledgeStore {
  return new SqliteKnowledgeStore(options);
}

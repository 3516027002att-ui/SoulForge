import type { SqliteDatabase } from '../storage/sqliteDatabase.js';
import type {
  KnowledgeClaim,
  KnowledgeGeneration,
  KnowledgePage,
  KnowledgeScope
} from './knowledgeTypes.js';
import type { KnowledgeStorePersistence, KnowledgeStoreSnapshot } from './knowledgeStore.js';

interface KnowledgeGenerationRow {
  generation_id: string;
  parent_generation: string | null;
  schema_version: string;
  source_revisions_json: string;
  created_at: string;
}

interface KnowledgePageRow {
  generation_id: string;
  page_id: string;
  path: string;
  body: string;
  content_hash: string;
  revision: number;
  scope_json: string;
  claims_json: string;
}

interface KnowledgeClaimRow {
  generation_id: string;
  claim_id: string;
  claim_json: string;
}

interface KnowledgeBlobRow {
  content_hash: string;
  body: string;
}

interface KnowledgeCurrentRow {
  generation_id: string;
}

export interface SqliteKnowledgeStoreOptions {
  workspaceId: string;
  /** Used only to establish the internal workspace row required by the FK. */
  rootPath?: string;
  game?: string;
}

/**
 * Durable adapter for the curator-only KnowledgeStore.
 *
 * It deliberately stores JSON payloads behind a workspace/generation key. The
 * adapter never receives a Mod writer or a resource path, and every save is one
 * SQLite transaction so CURRENT cannot point at a half-written generation.
 */
export class SqliteKnowledgeStorePersistence implements KnowledgeStorePersistence {
  readonly workspaceId: string;
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase, options: SqliteKnowledgeStoreOptions) {
    this.database = database;
    this.workspaceId = options.workspaceId;
    this.database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (@workspaceId, @rootPath, @game, @now, @now)
ON CONFLICT(workspace_id) DO UPDATE SET
  root_path = excluded.root_path,
  game = excluded.game,
  updated_at = excluded.updated_at
`).run({
      workspaceId: options.workspaceId,
      rootPath: options.rootPath ?? '',
      game: options.game ?? 'unknown',
      now: new Date().toISOString()
    });
  }

  load(): KnowledgeStoreSnapshot | null {
    const current = this.database.prepare<[string], KnowledgeCurrentRow>(`
SELECT generation_id
FROM knowledge_current
WHERE workspace_id = ?
`).get(this.workspaceId);
    if (!current) return null;

    const generations = new Map<string, KnowledgeGeneration>();
    const generationRows = this.database.prepare<[string], KnowledgeGenerationRow>(`
SELECT generation_id, parent_generation, schema_version,
       source_revisions_json, created_at
FROM knowledge_generations
WHERE workspace_id = ?
ORDER BY created_at ASC, generation_id ASC
`).all(this.workspaceId);
    for (const row of generationRows) {
      const sourceRevisions = parseRecord<string>(row.source_revisions_json, 'KNOWLEDGE_STORE_SOURCE_REVISIONS_INVALID');
      generations.set(row.generation_id, {
        generationId: row.generation_id,
        parentGeneration: row.parent_generation,
        schemaVersion: row.schema_version,
        pages: {},
        claims: {},
        sourceRevisions,
        createdAt: row.created_at
      });
    }

    const pageRows = this.database.prepare<[string], KnowledgePageRow>(`
SELECT generation_id, page_id, path, body, content_hash, revision,
       scope_json, claims_json
FROM knowledge_pages
WHERE workspace_id = ?
`).all(this.workspaceId);
    for (const row of pageRows) {
      const generation = generations.get(row.generation_id);
      if (!generation) throw new Error('KNOWLEDGE_STORE_PAGE_GENERATION_MISSING');
      generation.pages[row.page_id] = {
        pageId: row.page_id,
        path: row.path,
        body: row.body,
        contentHash: row.content_hash,
        revision: row.revision,
        scope: parseJson<KnowledgeScope>(row.scope_json, 'KNOWLEDGE_STORE_SCOPE_INVALID'),
        claims: parseJson<string[]>(row.claims_json, 'KNOWLEDGE_STORE_PAGE_CLAIMS_INVALID')
      } satisfies KnowledgePage;
    }

    const claimRows = this.database.prepare<[string], KnowledgeClaimRow>(`
SELECT generation_id, claim_id, claim_json
FROM knowledge_claims
WHERE workspace_id = ?
`).all(this.workspaceId);
    for (const row of claimRows) {
      const generation = generations.get(row.generation_id);
      if (!generation) throw new Error('KNOWLEDGE_STORE_CLAIM_GENERATION_MISSING');
      const claim = parseJson<KnowledgeClaim>(row.claim_json, 'KNOWLEDGE_STORE_CLAIM_INVALID');
      if (claim.claimId !== row.claim_id) throw new Error('KNOWLEDGE_STORE_CLAIM_ID_MISMATCH');
      generation.claims[row.claim_id] = claim;
    }

    const blobs = Object.fromEntries(
      this.database.prepare<[string], KnowledgeBlobRow>(`
SELECT content_hash, body
FROM knowledge_blobs
WHERE workspace_id = ?
`).all(this.workspaceId).map((row) => [row.content_hash, row.body])
    );
    if (!generations.has(current.generation_id)) throw new Error('KNOWLEDGE_STORE_CURRENT_NOT_FOUND');
    const currentGeneration = generations.get(current.generation_id)!;
    return {
      schemaVersion: currentGeneration.schemaVersion,
      current: current.generation_id,
      generations: [...generations.values()],
      blobs
    };
  }

  save(snapshot: KnowledgeStoreSnapshot): void {
    const generationById = new Map(snapshot.generations.map((generation) => [generation.generationId, generation]));
    if (!generationById.has(snapshot.current)) throw new Error('KNOWLEDGE_STORE_CURRENT_NOT_FOUND');

    const write = this.database.transaction(() => {
      const insertGeneration = this.database.prepare(`
INSERT INTO knowledge_generations (
  workspace_id, generation_id, parent_generation, schema_version,
  source_revisions_json, created_at
) VALUES (@workspaceId, @generationId, @parentGeneration, @schemaVersion,
          @sourceRevisionsJson, @createdAt)
ON CONFLICT(workspace_id, generation_id) DO UPDATE SET
  parent_generation = excluded.parent_generation,
  schema_version = excluded.schema_version,
  source_revisions_json = excluded.source_revisions_json,
  created_at = excluded.created_at
`);
      const insertBlob = this.database.prepare(`
INSERT INTO knowledge_blobs (workspace_id, content_hash, body)
VALUES (@workspaceId, @contentHash, @body)
ON CONFLICT(workspace_id, content_hash) DO UPDATE SET body = excluded.body
`);
      const insertPage = this.database.prepare(`
INSERT INTO knowledge_pages (
  workspace_id, generation_id, page_id, path, body, content_hash,
  revision, scope_json, claims_json
) VALUES (@workspaceId, @generationId, @pageId, @path, @body, @contentHash,
          @revision, @scopeJson, @claimsJson)
ON CONFLICT(workspace_id, generation_id, page_id) DO UPDATE SET
  path = excluded.path,
  body = excluded.body,
  content_hash = excluded.content_hash,
  revision = excluded.revision,
  scope_json = excluded.scope_json,
  claims_json = excluded.claims_json
`);
      const insertClaim = this.database.prepare(`
INSERT INTO knowledge_claims (workspace_id, generation_id, claim_id, claim_json)
VALUES (@workspaceId, @generationId, @claimId, @claimJson)
ON CONFLICT(workspace_id, generation_id, claim_id) DO UPDATE SET
  claim_json = excluded.claim_json
`);
      const updateCurrent = this.database.prepare(`
INSERT INTO knowledge_current (workspace_id, generation_id)
VALUES (?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET generation_id = excluded.generation_id
`);

      for (const generation of snapshot.generations) {
        insertGeneration.run({
          workspaceId: this.workspaceId,
          generationId: generation.generationId,
          parentGeneration: generation.parentGeneration,
          schemaVersion: generation.schemaVersion,
          sourceRevisionsJson: JSON.stringify(generation.sourceRevisions),
          createdAt: generation.createdAt
        });
        for (const page of Object.values(generation.pages)) {
          insertPage.run({
            workspaceId: this.workspaceId,
            generationId: generation.generationId,
            pageId: page.pageId,
            path: page.path,
            body: page.body,
            contentHash: page.contentHash,
            revision: page.revision,
            scopeJson: JSON.stringify(page.scope),
            claimsJson: JSON.stringify(page.claims)
          });
        }
        for (const claim of Object.values(generation.claims)) {
          insertClaim.run({
            workspaceId: this.workspaceId,
            generationId: generation.generationId,
            claimId: claim.claimId,
            claimJson: JSON.stringify(claim)
          });
        }
      }
      for (const [contentHash, body] of Object.entries(snapshot.blobs)) {
        insertBlob.run({ workspaceId: this.workspaceId, contentHash, body });
      }
      updateCurrent.run(this.workspaceId, snapshot.current);
    });
    write.immediate();
  }
}

function parseJson<T>(value: string, code: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(code);
  }
}

function parseRecord<T>(value: string, code: string): Record<string, T> {
  const parsed = parseJson<unknown>(value, code);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, T>;
}

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SqliteDatabase } from './sqliteDatabase.js';
import type { SqlMigration } from './sqliteSchema.js';
import type { KnowledgeStoreSnapshot } from '../knowledge/knowledgeStore.js';
import { SqliteKnowledgeStorePersistence } from '../knowledge/sqliteKnowledgeStore.js';

/** e32edad11a4d7cd493312bf49543d0241b667a42 stored whole snapshots in v14.
 * This is a data conversion, NOT a checksum reanchor. Unknown variants stay closed.
 */
export function isLegacyKnowledgeMigration(migration: SqlMigration, name: string, from: string, to: string): boolean {
  return migration.id === 14 && migration.name === 'v0_9_knowledge_store' && name === migration.name
    && from === '43ee85272d692befe29a49b03eb9594d4f7bd9ce5ddf5b88bb921467c00a8cd9'
    && to === '24183d5e56df6d6cbf9db5973fc5da8acdf40b114d4d555599e3d146820b5f98';
}

function requireValue(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`LEGACY_KNOWLEDGE_INVALID: ${detail}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), expected.sort()), 'unexpected or missing fields');
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function ordered(snapshot: KnowledgeStoreSnapshot): KnowledgeStoreSnapshot {
  return { ...snapshot, generations: [...snapshot.generations].sort((a, b) => a.generationId.localeCompare(b.generationId)) };
}

function parseSnapshot(json: string): KnowledgeStoreSnapshot {
  // Refuse an unexpectedly large legacy blob instead of allocating an unbounded
  // duplicate of the entire workspace. The source and recovery snapshot remain.
  requireValue(Buffer.byteLength(json) <= 64 * 1024 * 1024, 'snapshot exceeds conversion limit');
  const value: unknown = JSON.parse(json);
  requireValue(record(value), 'snapshot');
  keys(value, ['current', 'generations', 'blobs', ...('schemaVersion' in value ? ['schemaVersion'] : [])]);
  requireValue(typeof value.current === 'string' && Array.isArray(value.generations) && record(value.blobs), 'snapshot shape');
  const ids = new Set<string>();
  for (const generation of value.generations) {
    requireValue(record(generation), 'generation');
    keys(generation, ['generationId', 'parentGeneration', 'schemaVersion', 'pages', 'claims', 'sourceRevisions', 'createdAt']);
    requireValue(typeof generation.generationId === 'string' && !ids.has(generation.generationId), 'duplicate generation');
    ids.add(generation.generationId);
    requireValue((generation.parentGeneration === null || typeof generation.parentGeneration === 'string')
      && typeof generation.schemaVersion === 'string' && typeof generation.createdAt === 'string'
      && record(generation.pages) && record(generation.claims) && record(generation.sourceRevisions), 'generation shape');
    requireValue(Object.values(generation.sourceRevisions).every(item => typeof item === 'string'), 'source revisions');
    for (const [id, page] of Object.entries(generation.pages)) {
      requireValue(record(page), 'page');
      keys(page, ['pageId', 'path', 'body', 'contentHash', 'revision', 'scope', 'claims']);
      requireValue(page.pageId === id && typeof page.path === 'string' && typeof page.body === 'string'
        && Number.isSafeInteger(page.revision) && Number(page.revision) > 0 && record(page.scope)
        && Array.isArray(page.claims) && page.claims.every(item => typeof item === 'string'), 'page shape');
      requireValue(page.contentHash === digest(page.body) && value.blobs[String(page.contentHash)] === page.body, 'page/blob content');
      requireValue(page.claims.every(id => Object.hasOwn(generation.claims as object, id)), 'page claim reference');
    }
    for (const [id, claim] of Object.entries(generation.claims)) {
      // Claims and scopes are persisted as complete JSON, including extensions.
      requireValue(record(claim) && claim.claimId === id, 'claim identity');
    }
  }
  requireValue(ids.has(value.current), 'current generation');
  for (const generation of value.generations) {
    requireValue(generation.parentGeneration === null || ids.has(generation.parentGeneration), 'parent generation');
  }
  for (const [hash, body] of Object.entries(value.blobs)) requireValue(typeof body === 'string' && digest(body) === hash, 'blob hash');
  const current = value.generations.find(generation => generation.generationId === value.current)!;
  requireValue(value.schemaVersion === undefined || value.schemaVersion === current.schemaVersion, 'schema version');
  return ordered({ ...value, schemaVersion: current.schemaVersion } as KnowledgeStoreSnapshot);
}

interface LegacyRow {
  generation_id: string; parent_generation: string | null; schema_version: string; created_at: string; state_json: string;
}

/** Caller holds IMMEDIATE transaction and has already preserved a consistent backup. */
export function convertLegacyKnowledge(database: SqliteDatabase, migration: SqlMigration): void {
  const expectedColumns: Record<string, string[]> = {
    knowledge_generations: ['workspace_id', 'generation_id', 'parent_generation', 'schema_version', 'created_at', 'state_json'],
    knowledge_current: ['workspace_id', 'generation_id', 'updated_at']
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const columns = database.pragma(`table_info(${table})`) as Array<{ name: string; type: string }>;
    requireValue(isDeepStrictEqual(columns.map(column => column.name), expected)
      && columns.every(column => column.type === 'TEXT'), `schema ${table}`);
  }
  for (const name of ['knowledge_blobs', 'knowledge_pages', 'knowledge_claims', 'legacy_knowledge_generations_v14', 'legacy_knowledge_current_v14']) {
    requireValue(!database.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), `unexpected object ${name}`);
  }
  // Refuse custom dependants: DROP would otherwise silently delete their data.
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>) {
    if (Object.hasOwn(expectedColumns, row.name)) continue;
    const fks = database.pragma(`foreign_key_list("${row.name.replaceAll('"', '""')}")`) as Array<{table: string}>;
    // SQLite folds ASCII identifier case, while foreign_key_list preserves the
    // spelling used in REFERENCES. Mixed-case dependants must not reach DROP.
    requireValue(!fks.some(fk => Object.hasOwn(expectedColumns,
      fk.table.replace(/[A-Z]/g, letter => letter.toLowerCase()))), 'external knowledge foreign key');
  }
  requireValue(!database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') AND (sql LIKE '%knowledge_generations%' OR sql LIKE '%knowledge_current%')").get(), 'custom knowledge trigger/view');
  requireValue(!database.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND sql IS NOT NULL
    AND tbl_name IN ('knowledge_generations','knowledge_current') AND name!='idx_knowledge_generations_workspace_created'`).get(), 'custom knowledge index');
  requireValue((database.pragma('foreign_key_check') as unknown[]).length === 0, 'source foreign keys');
  // Check byte lengths in SQLite before selecting a legacy JSON string into V8.
  requireValue(!database.prepare('SELECT 1 FROM knowledge_generations WHERE length(CAST(state_json AS BLOB)) > ? LIMIT 1')
    .get(64 * 1024 * 1024), 'snapshot exceeds conversion limit');
  const orphan = database.prepare(`SELECT 1 FROM knowledge_generations g LEFT JOIN knowledge_current c
    ON g.workspace_id=c.workspace_id WHERE c.workspace_id IS NULL LIMIT 1`).get();
  requireValue(!orphan, 'generation without CURRENT');

  database.exec(`ALTER TABLE knowledge_current RENAME TO legacy_knowledge_current_v14;
    ALTER TABLE knowledge_generations RENAME TO legacy_knowledge_generations_v14;
    DROP INDEX idx_knowledge_generations_workspace_created;`);
  database.exec(migration.sql);
  const currents = database.prepare<[string | null, string | null], {workspace_id: string; generation_id: string}>(
    'SELECT workspace_id, generation_id FROM legacy_knowledge_current_v14 WHERE (? IS NULL OR workspace_id > ?) ORDER BY workspace_id LIMIT 1');
  const rows = database.prepare<[string], LegacyRow>(`SELECT generation_id,parent_generation,schema_version,created_at,state_json
    FROM legacy_knowledge_generations_v14 WHERE workspace_id=? ORDER BY generation_id`);
  // A live SQLite iterator cannot remain open while save() creates a savepoint.
  // Keyset workspace traversal also avoids collecting all legacy JSON in RAM.
  let previous: string | null = null;
  for (;;) {
    const current = currents.get(previous, previous);
    if (!current) break;
    previous = current.workspace_id;
    const head = database.prepare<[string, string], LegacyRow>(`SELECT generation_id,parent_generation,schema_version,created_at,state_json
      FROM legacy_knowledge_generations_v14 WHERE workspace_id=? AND generation_id=?`).get(current.workspace_id, current.generation_id);
    requireValue(head, 'CURRENT row missing');
    const snapshot = parseSnapshot(head.state_json);
    requireValue(snapshot.current === current.generation_id, 'CURRENT identity mismatch');
    const byId = new Map(snapshot.generations.map(generation => [generation.generationId, generation]));
    let rowCount = 0;
    for (const row of rows.iterate(current.workspace_id)) {
      rowCount += 1;
      const generation = byId.get(row.generation_id);
      requireValue(generation && generation.parentGeneration === row.parent_generation
        && generation.schemaVersion === row.schema_version && generation.createdAt === row.created_at, 'row/snapshot identity');
      requireValue(isDeepStrictEqual(parseSnapshot(row.state_json), snapshot), 'conflicting historical snapshots');
    }
    requireValue(rowCount === byId.size, 'generation coverage mismatch');
    const persistence = new SqliteKnowledgeStorePersistence(database, { workspaceId: current.workspace_id, ensureWorkspaceRow: false });
    persistence.save(snapshot);
    const restored = persistence.load();
    requireValue(restored && isDeepStrictEqual(ordered(restored), snapshot), 'normalized readback differs');
  }
  database.exec('DROP TABLE legacy_knowledge_current_v14; DROP TABLE legacy_knowledge_generations_v14;');
  requireValue((database.pragma('foreign_key_check') as unknown[]).length === 0, 'converted foreign keys');
}

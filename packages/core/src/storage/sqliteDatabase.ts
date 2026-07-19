import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { SqlMigration } from './sqliteSchema.js';
import { APP_DB_MIGRATIONS, SQLITE_MIGRATIONS } from './sqliteSchema.js';

export type SqliteDatabase = BetterSqlite3.Database;

export interface OpenSoulForgeDatabaseOptions {
  busyTimeoutMs?: number;
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Explicit native addon for runtimes whose ABI differs from the host Node.js. */
  nativeBinding?: string;
}

interface AppliedMigrationRow {
  id: number;
  name: string;
  checksum: string | null;
}

export class SqliteMigrationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function openWorkspaceDatabase(
  databasePath: string,
  options: OpenSoulForgeDatabaseOptions = {}
): SqliteDatabase {
  return openMigratedDatabase(databasePath, SQLITE_MIGRATIONS, options);
}

export function openAppDatabase(
  databasePath: string,
  options: OpenSoulForgeDatabaseOptions = {}
): SqliteDatabase {
  const database = openMigratedDatabase(databasePath, APP_DB_MIGRATIONS, options);
  database.pragma('synchronous = FULL');
  database.pragma('secure_delete = ON');
  return database;
}

export function openMigratedDatabase(
  databasePath: string,
  migrations: readonly SqlMigration[],
  options: OpenSoulForgeDatabaseOptions = {}
): SqliteDatabase {
  if (!options.readonly) mkdirSync(dirname(databasePath), { recursive: true });
  const database = new BetterSqlite3(databasePath, {
    readonly: options.readonly === true,
    fileMustExist: options.fileMustExist === true,
    timeout: options.busyTimeoutMs ?? 5_000,
    ...(options.nativeBinding ? { nativeBinding: options.nativeBinding } : {})
  });

  try {
    database.pragma('foreign_keys = ON');
    database.pragma(`busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5_000)}`);
    if (!options.readonly) database.pragma('journal_mode = WAL');
    assertDatabaseIntegrity(database);
    if (!options.readonly) applyMigrations(database, migrations);
    assertDatabaseIntegrity(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly SqlMigration[]
): void {
  validateMigrationSequence(migrations);
  assertSchemaNotNewerThanApplication(database, migrations);
  database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT,
  applied_at TEXT NOT NULL
);
`);
  ensureMigrationChecksumColumn(database);

  const appliedStatement = database.prepare<[number], AppliedMigrationRow>(`
SELECT id, name, checksum
FROM schema_migrations
WHERE id = ?
`);
  const insertStatement = database.prepare(`
INSERT INTO schema_migrations (id, name, checksum, applied_at)
VALUES (@id, @name, @checksum, @appliedAt)
`);

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration);
    const applied = appliedStatement.get(migration.id);
    if (applied) {
      if (!applied.checksum) {
        throw new SqliteMigrationError(
          'SQLITE_MIGRATION_CHECKSUM_MISSING',
          `Migration ${migration.id} was recorded without a checksum; automatic trust is forbidden.`,
          { id: migration.id, name: applied.name }
        );
      }
      if (applied.name !== migration.name || applied.checksum !== checksum) {
        throw new SqliteMigrationError(
          'SQLITE_MIGRATION_CHECKSUM_MISMATCH',
          `Migration ${migration.id} differs from the applied migration.`,
          {
            id: migration.id,
            expectedName: migration.name,
            actualName: applied.name,
            expectedChecksum: checksum,
            actualChecksum: applied.checksum
          }
        );
      }
      continue;
    }

    const applyOne = database.transaction(() => {
      database.exec(migration.sql);
      insertStatement.run({
        id: migration.id,
        name: migration.name,
        checksum,
        appliedAt: new Date().toISOString()
      });
      database.pragma(`user_version = ${migration.id}`);
    });

    try {
      applyOne.immediate();
    } catch (error) {
      throw new SqliteMigrationError(
        'SQLITE_MIGRATION_FAILED',
        `Migration ${migration.id} (${migration.name}) failed.`,
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
  }
}

function assertSchemaNotNewerThanApplication(
  database: SqliteDatabase,
  migrations: readonly SqlMigration[]
): void {
  const supportedVersion = migrations.at(-1)?.id ?? 0;
  const userVersion = Number(database.pragma('user_version', { simple: true }));
  let recordedVersion = 0;
  const table = database.prepare(`
SELECT 1 AS found
FROM sqlite_master
WHERE type = 'table' AND name = 'schema_migrations'
`).get() as { found?: number } | undefined;
  if (table?.found === 1) {
    const row = database.prepare('SELECT MAX(id) AS maxId FROM schema_migrations').get() as {
      maxId?: number | null;
    };
    recordedVersion = Number(row.maxId ?? 0);
  }
  if (userVersion > supportedVersion || recordedVersion > supportedVersion) {
    throw new SqliteMigrationError(
      'SQLITE_SCHEMA_NEWER_THAN_APPLICATION',
      '数据库版本高于当前应用支持版本，已拒绝降级写入。',
      { supportedVersion, userVersion, recordedVersion }
    );
  }
}

export function migrationChecksum(migration: SqlMigration): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: migration.id, name: migration.name, sql: migration.sql }))
    .digest('hex');
}

export function assertDatabaseIntegrity(database: SqliteDatabase): void {
  const result = database.pragma('quick_check', { simple: true });
  if (result !== 'ok') {
    throw new SqliteMigrationError(
      'SQLITE_INTEGRITY_CHECK_FAILED',
      'SQLite quick_check failed.',
      { result }
    );
  }
}

function ensureMigrationChecksumColumn(database: SqliteDatabase): void {
  const columns = database.pragma('table_info(schema_migrations)') as Array<{ name?: unknown }>;
  if (columns.some((column) => column.name === 'checksum')) return;
  database.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;');
}

function validateMigrationSequence(migrations: readonly SqlMigration[]): void {
  const seen = new Set<number>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    const expectedId = index + 1;
    if (migration.id !== expectedId || seen.has(migration.id)) {
      throw new SqliteMigrationError(
        'SQLITE_MIGRATION_SEQUENCE_INVALID',
        `Migration ids must be unique and contiguous from 1; expected ${expectedId}, got ${migration.id}.`
      );
    }
    seen.add(migration.id);
  }
}

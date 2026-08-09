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
  return openMigratedDatabase(databasePath, APP_DB_MIGRATIONS, options);
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
        // 一次性重锚:只对显式登记的 (id, name, 旧 checksum, 新 checksum) 四元组
        // 生效。命中时把账本里的 checksum 更新为代码值并继续,不重跑 SQL。
        const reanchor = findChecksumReanchor(migration, applied.name, applied.checksum, checksum);
        if (reanchor) {
          database.prepare('UPDATE schema_migrations SET checksum = ? WHERE id = ?')
            .run(checksum, migration.id);
          continue;
        }
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
      if (migration.sql.trim() !== '') database.exec(migration.sql);
      // 按「列不存在才加」处理:SQLite 无 ADD COLUMN IF NOT EXISTS，而迁移可能
      // 跑在已有该列的既有库上。
      for (const spec of migration.addColumns ?? []) {
        const columns = database.pragma(`table_info(${spec.table})`) as Array<{ name?: unknown }>;
        if (columns.some((column) => column.name === spec.column)) continue;
        database.exec(`ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition};`);
      }
      // 依赖新列的对象（如建在新列上的索引）必须排在加列之后。
      if (migration.sqlAfterColumns?.trim()) database.exec(migration.sqlAfterColumns);
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

/**
 * checksum 重锚白名单。
 *
 * ── 为什么需要它 ──
 *
 * 本机实测(2026-08-09):用户打开工作区时报
 * `SQLITE_SCHEMA_NEWER_THAN_APPLICATION`。根因是 `app.db` 的
 * `schema_migrations` 里有 id 2(`v0_5_app_ai_authority_and_retention`),
 * 而代码里 `APP_DB_MIGRATIONS` 只到 id 1 —— 那条迁移曾存在于开发中途、
 * 后来被整条删掉,却没考虑已有数据库仍记着 `user_version = 2`。
 *
 * 把迁移补回代码能解决版本判定,但账本里那条记着旧 checksum
 * (`8355ad4c…`),而补回的 SQL 算出的是新值,于是撞上 checksum 比对。
 *
 * ── 为什么白名单而不是放宽比对 ──
 *
 * checksum 比对守的是「同一个 id 的迁移内容被改过」这件事,那是真实风险:
 * 两台机器跑同一 id 却得到不同 schema。放宽成「名字相同就放过」会把这道
 * 保护整体拆掉。
 *
 * 所以重锚必须逐条登记:id、name、**旧 checksum**、**新 checksum** 四项全中
 * 才放行。旧 checksum 也要匹配,意味着它只认「那一个具体的历史状态」——
 * 任何其他内容漂移仍然报错。补回的 SQL 一旦再改动,新 checksum 就不再等于
 * 登记值,这条重锚随即失效,不会变成长期后门。
 *
 * 重锚只改账本里的 checksum,**不重跑 SQL**:那些表在既有库里已经存在,
 * 重跑 `ALTER TABLE ADD COLUMN` 会因列已存在而失败。
 */
interface ChecksumReanchor {
  id: number;
  name: string;
  /** 账本里记录的历史 checksum。 */
  fromChecksum: string;
  /** 代码当前算出的 checksum。两者都必须匹配才放行。 */
  toChecksum: string;
  reason: string;
}

export const CHECKSUM_REANCHORS: readonly ChecksumReanchor[] = Object.freeze([
  {
    id: 2,
    name: 'v0_5_app_ai_authority_and_retention',
    fromChecksum: '8355ad4ca66f5ebfce01137fe63f074edad6fb694506a2707ed6715910f8da15',
    // 由补回的 id 2 迁移 SQL 算出;改动那段 SQL 会让这条重锚自动失效。
    toChecksum: '95cfb57f0dc5b9ae94511ef4ce4c5056b5724ded369880a1ebe3670c8f6d4d42',
    reason: '该迁移曾在开发中途被整条删除，补回时 SQL 由既有库的真实 DDL 重建，'
      + '故 checksum 与历史值不同。表结构本身未变（已用结构比对确认）。'
  }
]);

function findChecksumReanchor(
  migration: SqlMigration,
  appliedName: string,
  appliedChecksum: string | null,
  currentChecksum: string
): ChecksumReanchor | undefined {
  return CHECKSUM_REANCHORS.find((entry) => entry.id === migration.id
    && entry.name === migration.name
    && entry.name === appliedName
    && entry.fromChecksum === appliedChecksum
    && entry.toChecksum === currentChecksum);
}

export function migrationChecksum(migration: SqlMigration): string {
  // addColumns 与 sqlAfterColumns 必须参与计算:它们和 sql 一样决定迁移做什么。
  // 漏掉它们会让「改了加列定义但 checksum 不变」成为可能,而 checksum 存在的
  // 全部意义就是让内容漂移可被发现。
  //
  // 两个字段缺省时不进 JSON(用条件展开而非写 undefined),这样既有迁移的
  // checksum 保持不变 —— 否则补这两个字段会让全部 7 条 workspace 迁移的
  // checksum 一起变，把所有既有库推进 CHECKSUM_MISMATCH。
  return createHash('sha256')
    .update(JSON.stringify({
      id: migration.id,
      name: migration.name,
      sql: migration.sql,
      ...(migration.addColumns ? { addColumns: migration.addColumns } : {}),
      ...(migration.sqlAfterColumns ? { sqlAfterColumns: migration.sqlAfterColumns } : {})
    }))
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

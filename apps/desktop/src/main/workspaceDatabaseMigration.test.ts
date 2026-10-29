import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { migrateWorkspaceDatabaseSnapshot, planWorkspaceDatabaseMigration } from './workspaceDatabaseMigration.js';

/**
 * 复现 #40：伴随库 `workspace.db` 在 WAL 模式下被分文件复制时，副本可能是源库
 * 从未有过的状态。这里用 (a, b) 两个计数器表示业务状态，只有 (0,0)、(1,0)、
 * (1,1) 三个状态真实存在过；副本读到其它组合（含"表都不在"）就是撕裂。
 */
function seedWalDatabase(directory: string): {
  source: string;
  writer: Database.Database;
  bumpA: () => void;
  bumpB: () => void;
} {
  const source = join(directory, 'fallback-workspace.db');
  const writer = new Database(source);
  writer.pragma('journal_mode = WAL');
  writer.pragma('synchronous = FULL');
  writer.exec(`
CREATE TABLE counters (a INTEGER NOT NULL, b INTEGER NOT NULL);
INSERT INTO counters VALUES (0, 0);
`);
  const bumpA = () => {
    writer.prepare('UPDATE counters SET a = a + 1').run();
  };
  const bumpB = () => {
    writer.prepare('UPDATE counters SET b = b + 1').run();
  };
  return { source, writer, bumpA, bumpB };
}

interface Counters {
  a: number;
  b: number;
}

function readCounters(file: string): Counters | null {
  if (!existsSync(file)) return null;
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare('SELECT a, b FROM counters').get() as Counters | undefined;
    return row ?? null;
  } catch {
    // 表不在 = 副本丢掉了整个 schema，同样不是源库的历史状态。
    return null;
  } finally {
    database.close();
  }
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'sf-workspace-migration-'));
}

function cleanup(directory: string): void {
  // Windows 上刚关闭的 SQLite 句柄可能还占着 -wal/-shm 一小会儿：先短重试，
  // 仍失败就抛出来。吞掉会让每次运行都在系统临时目录里多一个残留（#36 的
  // 典型成因），也让"测试自己清理干净"这条约束永远无法被证伪。
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch (error) {
    throw new Error(`测试临时目录清理失败（不应残留）：${directory}：${error instanceof Error ? error.message : String(error)}`);
  }
}

describe('workspace database migration plan', () => {
  const fallbackRoot = join('C:', 'Local', 'SoulForge', 'workspaces', 'abc');

  it('目标缺失且源存在时给出 fallback 的库与指纹路径', () => {
    assert.deepEqual(
      planWorkspaceDatabaseMigration({ fallbackRoot, companionDatabaseExists: false, fallbackDatabaseExists: true }),
      {
        migrateFromDatabasePath: join(fallbackRoot, 'workspace.db'),
        migrateFingerprintFromPath: join(fallbackRoot, 'fingerprint-store.json')
      }
    );
  });

  it('已有伴随库或没有 fallback 库时不做迁移', () => {
    assert.equal(
      planWorkspaceDatabaseMigration({ fallbackRoot, companionDatabaseExists: true, fallbackDatabaseExists: true }),
      undefined,
      '伴随库已存在时不得再迁移（会覆盖用户当前库）'
    );
    assert.equal(
      planWorkspaceDatabaseMigration({ fallbackRoot, companionDatabaseExists: false, fallbackDatabaseExists: false }),
      undefined
    );
  });
});

describe('workspace database migration snapshot', () => {
  it('迁移副本等于源库真实存在过的状态，而不是分文件复制的撕裂状态', () => {
    const directory = workspace();
    const { source, writer, bumpA, bumpB } = seedWalDatabase(directory);
    const target = join(directory, '.soulforge', 'workspace.db');
    mkdirSync(join(directory, '.soulforge'), { recursive: true });
    try {
      // 源库历史：(0,0) -> (1,0) -> (1,1)，两个提交都还只在 -wal 里。
      bumpA();
      const history: Counters[] = [{ a: 0, b: 0 }, { a: 1, b: 0 }];

      // 旧实现：先复制主库，再 checkpoint + 新事务，然后复制 -wal。
      const legacyCopy = join(directory, 'legacy-copy.db');
      copyFileSync(source, legacyCopy);
      writer.pragma('wal_checkpoint(PASSIVE)');
      bumpB();
      history.push({ a: 1, b: 1 });
      if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${legacyCopy}-wal`);

      const legacyState = readCounters(legacyCopy);
      const legacyIsReal = legacyState !== null
        && history.some((item) => item.a === legacyState.a && item.b === legacyState.b);
      assert.equal(
        legacyIsReal,
        false,
        '分文件复制在 WAL 源库上会得到源库从未有过的状态；若这条开始失败，说明 SQLite 行为变了，需要重新评估 #40'
      );

      const outcome = migrateWorkspaceDatabaseSnapshot({ sourceDatabasePath: source, targetDatabasePath: target });
      assert.equal(outcome.status, 'migrated');
      const migrated = readCounters(target);
      assert.ok(migrated, '迁移后必须读到业务表');
      assert.ok(
        history.some((item) => item.a === migrated.a && item.b === migrated.b),
        `迁移副本 ${JSON.stringify(migrated)} 必须是源库真实存在过的状态之一：${JSON.stringify(history)}`
      );
      // 快照是自我完备的单文件库：不会留下需要一起复制的 -wal/-shm。
      assert.equal(existsSync(`${target}-wal`), false);
      assert.equal(existsSync(`${target}-shm`), false);
    } finally {
      writer.close();
      cleanup(directory);
    }
  });

  it('快照失败不留半成品，也不把失败当成迁移完成', () => {
    const directory = workspace();
    const target = join(directory, '.soulforge', 'workspace.db');
    mkdirSync(join(directory, '.soulforge'), { recursive: true });
    try {
      // 源库文件存在但不是数据库：读取快照必然失败。
      const source = join(directory, 'corrupt-fallback.db');
      writeFileSync(source, 'this is not a sqlite database', 'utf8');

      const outcome = migrateWorkspaceDatabaseSnapshot({ sourceDatabasePath: source, targetDatabasePath: target });
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.status === 'failed' ? outcome.code : null, 'MIGRATION_SNAPSHOT_FAILED');
      assert.equal(existsSync(target), false, '失败不能在目标位置留下任何文件');
      assert.deepEqual(
        readdirSync(join(directory, '.soulforge')).filter((entry) => entry.includes('.migrating-')),
        [],
        '失败必须清掉临时快照，否则下次启动会把它当残留'
      );

      // 目标不存在 = 下次启动会重试；修好源库后迁移必须能成功。
      const healthy = seedWalDatabase(directory);
      healthy.writer.close();
      const repaired = join(directory, 'healthy.db');
      copyFileSync(healthy.source, repaired);
      const retry = migrateWorkspaceDatabaseSnapshot({ sourceDatabasePath: repaired, targetDatabasePath: target });
      assert.equal(retry.status, 'migrated');
      assert.ok(readCounters(target));
    } finally {
      cleanup(directory);
    }
  });

  it('目标已存在时不动它，也不复制指纹库', () => {
    const directory = workspace();
    const { source, writer } = seedWalDatabase(directory);
    writer.close();
    const target = join(directory, '.soulforge', 'workspace.db');
    mkdirSync(join(directory, '.soulforge'), { recursive: true });
    const existing = new Database(target);
    existing.exec('CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES (\'companion\');');
    existing.close();
    const fingerprintSource = join(directory, 'fallback-fingerprint.json');
    const fingerprintTarget = join(directory, '.soulforge', 'fingerprint-store.json');
    writeFileSync(fingerprintSource, '{"generation":1}', 'utf8');
    try {
      const outcome = migrateWorkspaceDatabaseSnapshot({
        sourceDatabasePath: source,
        targetDatabasePath: target,
        fingerprintSourcePath: fingerprintSource,
        fingerprintTargetPath: fingerprintTarget
      });
      assert.deepEqual(outcome, { status: 'skipped', reason: 'target-exists' });
      assert.equal(existsSync(fingerprintTarget), false);
      const kept = new Database(target, { readonly: true });
      try {
        assert.equal((kept.prepare('SELECT value FROM kept').get() as { value?: string } | undefined)?.value, 'companion');
      } finally {
        kept.close();
      }
    } finally {
      cleanup(directory);
    }
  });

  it('源库不存在时什么都不做', () => {
    const directory = workspace();
    try {
      const outcome = migrateWorkspaceDatabaseSnapshot({
        sourceDatabasePath: join(directory, 'missing.db'),
        targetDatabasePath: join(directory, '.soulforge', 'workspace.db')
      });
      assert.deepEqual(outcome, { status: 'skipped', reason: 'source-missing' });
    } finally {
      cleanup(directory);
    }
  });

  it('迁移成功后复制指纹库，并清掉上次崩溃留下的临时快照', () => {
    const directory = workspace();
    const { source, writer } = seedWalDatabase(directory);
    writer.close();
    const companion = join(directory, '.soulforge');
    mkdirSync(companion, { recursive: true });
    const target = join(companion, 'workspace.db');
    const stale = join(companion, 'workspace.db.migrating-999-1');
    writeFileSync(stale, 'stale snapshot', 'utf8');
    const fingerprintSource = join(directory, 'fallback-fingerprint.json');
    const fingerprintTarget = join(companion, 'fingerprint-store.json');
    writeFileSync(fingerprintSource, '{"generation":7}', 'utf8');
    try {
      const outcome = migrateWorkspaceDatabaseSnapshot({
        sourceDatabasePath: source,
        targetDatabasePath: target,
        fingerprintSourcePath: fingerprintSource,
        fingerprintTargetPath: fingerprintTarget
      });
      assert.equal(outcome.status, 'migrated');
      assert.equal(existsSync(stale), false, '残留临时快照必须清掉');
      assert.equal(directoryHasTempSnapshot(companion), false);
      assert.equal(existsSync(fingerprintTarget), true);
      assert.equal(readCounters(target)?.a, 0);
    } finally {
      cleanup(directory);
    }
  });
});

function directoryHasTempSnapshot(directory: string): boolean {
  return readdirSync(directory).some((entry) => entry.includes('.migrating-'));
}

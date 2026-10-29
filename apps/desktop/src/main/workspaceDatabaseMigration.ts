import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * 伴随库迁移：把 LocalAppData 下的 fallback `workspace.db` 迁移到工作区的
 * `.soulforge/`。旧实现是分三次 `copyFileSync`（db、-wal、-shm）并吞掉异常，
 * 有两种可复现的错误：
 *
 * 1. 库开了 WAL。复制主库文件时，最近的提交可能还只在 `-wal` 里；两次复制之间
 *    只要有 checkpoint 或新事务，副本就是源库从未有过的状态（文件结构合法，
 *    `integrity_check` 也返回 ok，业务数据是错的）。
 * 2. 复制中途失败会留下半成品：`workspace.db` 已存在，之后不再迁移，半成品被
 *    当作迁移完成。
 *
 * 这里改用 SQLite 自己的一致性快照（`VACUUM INTO`）：先写临时文件，校验后
 * `rename` 到目标位置（同目录内原子）。失败不留目标、不留临时文件，返回结构化
 * 结果，下次启动可重试。
 *
 * 该模块必须保持**不依赖 electron**：它由数据库 utility 进程调用（主进程不得
 * 同步打开 SQLite），并被 node:test 直接单测。
 */

export type WorkspaceDatabaseMigrationOutcome =
  | { status: 'migrated'; bytes: number; fingerprintCopied: boolean }
  | { status: 'skipped'; reason: 'target-exists' | 'source-missing' }
  | { status: 'failed'; code: WorkspaceDatabaseMigrationFailureCode; message: string };

export type WorkspaceDatabaseMigrationFailureCode =
  | 'MIGRATION_SNAPSHOT_FAILED'
  | 'MIGRATION_SNAPSHOT_INVALID'
  | 'MIGRATION_COMMIT_FAILED';

/** 主进程只做判定：目标缺失且源存在时，给出要传给 utility 进程的迁移来源。 */
export interface WorkspaceDatabaseMigrationPlan {
  migrateFromDatabasePath: string;
  migrateFingerprintFromPath: string;
}

export function planWorkspaceDatabaseMigration(input: {
  fallbackRoot: string;
  companionDatabaseExists: boolean;
  fallbackDatabaseExists: boolean;
}): WorkspaceDatabaseMigrationPlan | undefined {
  if (input.companionDatabaseExists || !input.fallbackDatabaseExists) return undefined;
  return {
    migrateFromDatabasePath: join(input.fallbackRoot, 'workspace.db'),
    migrateFingerprintFromPath: join(input.fallbackRoot, 'fingerprint-store.json')
  };
}

export interface WorkspaceDatabaseMigrationOptions {  sourceDatabasePath: string;
  targetDatabasePath: string;
  /** 非数据库伴生文件（fingerprint-store.json）；快照提交成功后才复制。 */
  fingerprintSourcePath?: string;
  fingerprintTargetPath?: string;
  nativeBinding?: string;
  now?: () => number;
}

/** `VACUUM INTO` 的参数是文件名，不走绑定参数，必须自己转义成 SQL 字符串。 */
function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function snapshotPrefix(targetDatabasePath: string): string {
  return `${basename(targetDatabasePath)}.migrating-`;
}

/**
 * 清理上次崩溃留下的临时快照。临时文件不以 `workspace.db` 命名，所以即使残留
 * 也不会被误认为"迁移已完成"；这里只是不让它们堆积。
 */
function removeStaleSnapshots(targetDatabasePath: string): void {
  const directory = dirname(targetDatabasePath);
  const prefix = snapshotPrefix(targetDatabasePath);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      rmSync(join(directory, entry), { force: true });
    } catch {
      // 残留清理失败不影响迁移本身。
    }
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function migrateWorkspaceDatabaseSnapshot(
  options: WorkspaceDatabaseMigrationOptions
): WorkspaceDatabaseMigrationOutcome {
  const source = options.sourceDatabasePath;
  const target = options.targetDatabasePath;
  if (existsSync(target)) return { status: 'skipped', reason: 'target-exists' };
  if (!existsSync(source)) return { status: 'skipped', reason: 'source-missing' };

  removeStaleSnapshots(target);
  const stamp = (options.now ?? Date.now)();
  const temporary = join(dirname(target), `${snapshotPrefix(target)}${process.pid}-${stamp}`);
  const binding = options.nativeBinding ? { nativeBinding: options.nativeBinding } : {};

  let reader: BetterSqlite3.Database | null = null;
  try {
    // 只读连接：源库可能正被另一个会话使用，快照不应该向它写任何东西。
    reader = new BetterSqlite3(source, { readonly: true, fileMustExist: true, ...binding });
    reader.exec(`VACUUM INTO ${sqlStringLiteral(temporary)}`);
  } catch (error) {
    rmSync(temporary, { force: true });
    return {
      status: 'failed',
      code: 'MIGRATION_SNAPSHOT_FAILED',
      message: `读取 fallback 库做一致性快照失败：${failureMessage(error)}`
    };
  } finally {
    reader?.close();
  }

  try {
    const check = new BetterSqlite3(temporary, { readonly: true, fileMustExist: true, ...binding });
    try {
      const quickCheck = String(check.pragma('quick_check', { simple: true }));
      if (quickCheck !== 'ok') throw new Error(`quick_check = ${quickCheck}`);
      // 空壳库（没有 schema 对象）意味着快照拿到的是"结构合法但没数据"的副本，
      // 这正是旧复制序列会产生的假成功；这里必须拒绝。
      const objects = check
        .prepare("SELECT count(*) AS total FROM sqlite_master WHERE type IN ('table','index','view','trigger')")
        .get() as { total?: number } | undefined;
      if (!objects || Number(objects.total ?? 0) <= 0) throw new Error('快照里没有任何 schema 对象');
    } finally {
      check.close();
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    return {
      status: 'failed',
      code: 'MIGRATION_SNAPSHOT_INVALID',
      message: `迁移快照校验失败：${failureMessage(error)}`
    };
  }

  try {
    renameSync(temporary, target);
  } catch (error) {
    // 另一个实例可能刚好完成了同一次迁移：那是有结果的状态，保留它的库。
    if (existsSync(target)) {
      rmSync(temporary, { force: true });
      return { status: 'skipped', reason: 'target-exists' };
    }
    rmSync(temporary, { force: true });
    return {
      status: 'failed',
      code: 'MIGRATION_COMMIT_FAILED',
      message: `迁移快照就位失败：${failureMessage(error)}`
    };
  }

  let fingerprintCopied = false;
  if (options.fingerprintSourcePath && options.fingerprintTargetPath
    && existsSync(options.fingerprintSourcePath)
    && !existsSync(options.fingerprintTargetPath)) {
    try {
      copyFileSync(options.fingerprintSourcePath, options.fingerprintTargetPath);
      fingerprintCopied = true;
    } catch {
      // 指纹库不是数据库：复制失败只影响缓存连续性，不影响库一致性。
    }
  }

  return { status: 'migrated', bytes: statSync(target).size, fingerprintCopied };
}

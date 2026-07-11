import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';

const mode = process.argv[2];
if (mode === '--crash-child') {
  crashInsideTransaction(process.argv[3]!);
} else {
  await runParent();
}

async function runParent(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-sqlite-crash-'));
  const databasePath = join(root, 'workspace.db');
  const workspaceId = 'sqlite-crash-smoke';
  const database = openWorkspaceDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, 'sekiro', ?, ?)
`).run(workspaceId, join(root, 'mod'), now, now);
  database.close();

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child', databasePath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (!stdout.includes('TRANSACTION_OPEN')) {
    throw new Error(`Crash child did not enter transaction: ${stderr}`);
  }
  if (exit.code === 0) throw new Error('Crash child exited successfully instead of being terminated.');

  const recovered = openWorkspaceDatabase(databasePath);
  const leaked = recovered.prepare(`
SELECT COUNT(*) AS count FROM transaction_journal WHERE transaction_id = 'tx-must-rollback'
`).get() as { count: number };
  if (leaked.count !== 0) throw new Error('Uncommitted journal row survived process death.');
  if (recovered.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database integrity failed after crash.');
  recovered.prepare(`
INSERT INTO transaction_journal (
 transaction_id, workspace_id, op_id, phase, state_json, created_at, updated_at
) VALUES ('tx-after-restart', ?, 'op-after-restart', 'pending', '{}', ?, ?)
`).run(workspaceId, now, now);
  const persisted = recovered.prepare(`
SELECT phase FROM transaction_journal WHERE transaction_id = 'tx-after-restart'
`).get() as { phase?: string } | undefined;
  recovered.close();
  if (persisted?.phase !== 'pending') throw new Error('Database was not writable after crash recovery.');

  console.log(JSON.stringify({
    ok: true,
    message: 'SQLite 写事务中途进程死亡恢复验证通过',
    childExitCode: exit.code,
    childSignal: exit.signal,
    uncommittedRowsAfterRestart: leaked.count,
    quickCheck: 'ok',
    writableAfterRestart: true
  }, null, 2));
}

function crashInsideTransaction(databasePath: string): void {
  const database = openWorkspaceDatabase(databasePath);
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  database.prepare(`
INSERT INTO transaction_journal (
 transaction_id, workspace_id, op_id, phase, state_json, created_at, updated_at
) VALUES ('tx-must-rollback', 'sqlite-crash-smoke', 'op-crash', 'replacing', '{}', ?, ?)
`).run(now, now);
  process.stdout.write('TRANSACTION_OPEN\n', () => process.exit(86));
}

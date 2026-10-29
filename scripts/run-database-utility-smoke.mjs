import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentProductionBuild } from './ensure-agent-production-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 上一次运行被中断时，smoke 自己建的临时根还在（里面可能被还没退干净的 utility
 * 进程占着 app.db-shm）。每次运行开头扫一遍：只删超过 60 秒的，避免误删并发运行
 * 的目录；删不掉就留着交给下一次（#36 验收：被中断后下次启动能自清）。
 */
function sweepStaleSmokeRoots() {
  const tempRoot = tmpdir();
  let scanned = 0;
  let removed = 0;
  let kept = 0;
  for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('soulforge-electron-sqlite-')) continue;
    scanned += 1;
    const directory = join(tempRoot, entry.name);
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(directory).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < 60_000) {
      kept += 1;
      continue;
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch {
      kept += 1;
    }
  }
  if (scanned > 0) console.log(JSON.stringify({ smokeTempSweep: { scanned, removed, kept } }));
}

sweepStaleSmokeRoots();
const gateTest = spawnSync(process.execPath, [
  '--experimental-strip-types',
  join(root, 'apps', 'desktop', 'src', 'main', 'workspaceDatabaseOpenGate.test.ts')
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: process.env
});
if (gateTest.error) throw gateTest.error;
if (gateTest.status !== 0) process.exit(gateTest.status ?? 1);

await ensureAgentProductionBuild({ databaseSmoke: true });

const electronPath = (await import('electron')).default;
if (typeof electronPath !== 'string') throw new Error('Unable to resolve Electron executable.');
const smoke = spawnSync(electronPath, [
  join(root, 'apps', 'desktop', 'out', 'main', 'databaseUtilitySmoke.js')
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: process.env
});
if (smoke.error) throw smoke.error;
process.exit(smoke.status ?? 1);

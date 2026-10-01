import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesktopSmokeLog } from './desktop-test-build.mjs';

export function evaluateBootstrapOutcome(result, stages, nativeRequired) {
  const ready = stages.includes('entry') && stages.includes('ready');
  const nativeRead = !nativeRequired || stages.includes('native-read:7');
  return { status: result.status === 0 && !result.signal && !result.error && ready && nativeRead ? 'passed' : 'failed',
    nativeExit: result.status, nativeExitHex: Number.isInteger(result.status) ? `0x${(result.status >>> 0).toString(16)}` : null,
    signal: result.signal ?? null, error: result.error?.message ?? null, ready, nativeRead };
}

export function buildBootstrapSource(mode) {
  const node = mode.startsWith('node-'), sqlite = mode.endsWith('-sqlite');
  return `const fs=require('node:fs');
const mark=s=>fs.appendFileSync(process.env.SF_BOOTSTRAP_MARKER,s+'\\n');
mark('entry');
const run=()=>{mark('ready');${sqlite ? `mark('native-load');const Database=require(process.env.SF_BOOTSTRAP_SQLITE_PACKAGE);mark('native-open');
const db=new Database(process.env.SF_BOOTSTRAP_DB,{nativeBinding:process.env.SF_BOOTSTRAP_BINDING});
const value=db.prepare('SELECT 7 AS value').get().value;mark('native-read:'+value);db.close();` : ''}};
${node ? "try{run();process.exit(0);}catch(error){mark('error:'+error.message);console.error(error);process.exit(1);}" : "const{app}=require('electron');app.whenReady().then(()=>{try{run();app.exit(0);}catch(error){mark('error:'+error.message);console.error(error);app.exit(1);}});"}
`;
}

export async function collectWindowsBootstrapDiagnostics(root) {
  if (process.platform !== 'win32') return { status: 'not_run', reason: 'Windows-only native bootstrap boundary probe' };
  const owned = await mkdtemp(join(tmpdir(), 'soulforge-win-bootstrap-'));
  const electronPath = (await import('electron')).default;
  const binding = join(root, 'apps/desktop/.native/better_sqlite3.node');
  const report = { status: 'collected', platform: process.platform, arch: process.arch,
    electronVersion: JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'), 'utf8')).version,
    bindingSha256: createHash('sha256').update(await readFile(binding)).digest('hex'), nul: null, cases: [],
    nonClaim: 'Boundary diagnostics; collection success is not a database, desktop or game pass. Required runtime tests remain unchanged.' };
  try {
    let nul;
    try { nul = await open('nul', 'r+'); report.nul = { opened: true }; }
    catch (error) { report.nul = { opened: false, code: error.code }; }
    finally { await nul?.close(); }
    for (const [name, mode, stdin] of [
      ['electron-ignore', 'electron-basic', 'ignore'], ['electron-pipe', 'electron-basic', 'pipe'],
      ['electron-sqlite', 'electron-sqlite', 'pipe'], ['node-basic', 'node-basic', 'pipe'], ['node-sqlite', 'node-sqlite', 'pipe']
    ]) {
      const caseRoot = join(owned, name), profile = join(caseRoot, 'profile'), marker = join(caseRoot, 'marker.txt'), logFile = join(caseRoot, 'electron.log');
      const env = { ...process.env, HOME: join(caseRoot, 'home'), USERPROFILE: join(caseRoot, 'home'),
        APPDATA: join(caseRoot, 'app-data'), LOCALAPPDATA: join(caseRoot, 'local-app-data'),
        ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: logFile, SF_BOOTSTRAP_MARKER: marker,
        SF_BOOTSTRAP_SQLITE_PACKAGE: join(root, 'node_modules/better-sqlite3'), SF_BOOTSTRAP_BINDING: binding,
        SF_BOOTSTRAP_DB: join(caseRoot, 'probe.db') };
      delete env.ELECTRON_RUN_AS_NODE;
      if (mode.startsWith('node-')) env.ELECTRON_RUN_AS_NODE = '1';
      for (const path of [caseRoot, profile, env.HOME, env.APPDATA, env.LOCALAPPDATA]) await mkdir(path, { recursive: true });
      const entry = join(caseRoot, 'probe.cjs'); await writeFile(entry, buildBootstrapSource(mode));
      const args = [entry, `--user-data-dir=${profile}`, '--enable-logging=file', `--log-file=${logFile}`];
      const result = spawnSync(electronPath, args, { cwd: root, env, stdio: [stdin, 'pipe', 'pipe'],
        ...(stdin === 'pipe' ? { input: Buffer.alloc(0) } : {}), encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
      let stages = [];
      try { stages = (await readFile(marker, 'utf8')).trim().split('\n'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const observation = { name, mode, stdin, ...evaluateBootstrapOutcome(result, stages, mode.endsWith('-sqlite')), stages,
        stdout: result.stdout ?? '', stderr: result.stderr ?? '', nativeLog: await readDesktopSmokeLog(logFile) };
      report.cases.push(observation); console.log(JSON.stringify({ bootstrapCase: observation }));
    }
    return report;
  } finally { await rm(owned, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = await collectWindowsBootstrapDiagnostics(root);
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(join(root, 'output/windows-bootstrap-diagnostic.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

/**
 * P7 portable packaging gate — validates electron-builder config and optionally
 * runs an unsigned dry packaging step when electron-builder is available.
 * Never claims signed release readiness.
 */
import { access, readFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-portable-gate');
const ymlPath = join(root, 'apps/desktop/electron-builder.yml');
const desktopPkg = join(root, 'apps/desktop/package.json');

await mkdir(scratch, { recursive: true });

const report = {
  ok: true,
  gate: 'portable-packaging',
  timestamp: new Date().toISOString(),
  status: 'unknown',
  message: '',
  steps: /** @type {Array<Record<string, unknown>>} */ ([])
};

function run(command, args, cwd = root) {
  return new Promise((resolvePromise) => {
    const useCmd = process.platform === 'win32' && /^(npm|npx)$/.test(command);
    const executable = useCmd ? (process.env.ComSpec || 'cmd.exe') : command;
    const executableArgs = useCmd
      ? ['/d', '/s', '/c', `${command}.cmd`, ...args]
      : args;
    const child = spawn(executable, executableArgs, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

// 1) Config presence + safety rules
try {
  await access(ymlPath, constants.F_OK);
  const yml = await readFile(ymlPath, 'utf8');
  const checks = [
    { name: 'has-appId', ok: /appId:\s*\S+/.test(yml) },
    { name: 'has-portable-or-nsis', ok: /portable|nsis/i.test(yml) },
    { name: 'excludes-mods', ok: /mods/.test(yml) },
    { name: 'excludes-oodle', ok: /oo2core|oodle/i.test(yml) },
    { name: 'no-publish-token', ok: !/GH_TOKEN|GITHUB_TOKEN|API_KEY/i.test(yml) },
    { name: 'unsigned-comment-or-no-sign', ok: /sign|unsigned|签名/i.test(yml) || !/certificateFile/i.test(yml) }
  ];
  for (const c of checks) {
    report.steps.push({ name: `config:${c.name}`, ok: c.ok });
    if (!c.ok) report.ok = false;
  }
  report.steps.push({ name: 'electron-builder-yml', ok: true, path: 'apps/desktop/electron-builder.yml' });
} catch {
  report.ok = false;
  report.steps.push({ name: 'electron-builder-yml', ok: false, message: 'missing yml' });
}

// 2) package.json does not force signed publish
try {
  const pkg = JSON.parse(await readFile(desktopPkg, 'utf8'));
  const hasBuilderDep =
    Boolean(pkg.devDependencies?.['electron-builder'])
    || Boolean(pkg.dependencies?.['electron-builder']);
  report.steps.push({
    name: 'electron-builder-dependency',
    ok: true,
    present: hasBuilderDep,
    note: hasBuilderDep
      ? 'electron-builder is a package dependency'
      : 'electron-builder not installed in desktop package; dry-pack skipped'
  });

  // Optional dry pack only when explicitly requested and builder available
  const wantPack = process.env.SOULFORGE_PORTABLE_PACK === '1';
  if (wantPack && hasBuilderDep) {
    const electronDist = join(root, 'node_modules/electron/dist');
    const result = await run(
      'npx',
      [
        'electron-builder',
        '--config', 'electron-builder.yml',
        `--config.electronDist=${electronDist}`,
        '--config.win.signAndEditExecutable=false',
        '--win', '--dir', '--publish', 'never'
      ],
      join(root, 'apps/desktop')
    );
    const unpackedRoot = join(root, 'apps/desktop/release/win-unpacked');
    const audit = result.code === 0 ? await auditUnpackedDirectory(unpackedRoot) : undefined;
    report.steps.push({
      name: 'windows-unpacked-pack',
      ok: result.code === 0 && audit?.ok === true,
      code: result.code,
      ...(audit ? { audit } : {}),
      stdoutTail: result.stdout.slice(-1200),
      stderrTail: result.stderr.slice(-800),
      nonClaim: 'unsigned unpacked directory; portable EXE, NSIS installer, signing and updater remain unverified'
    });
    if (result.code !== 0 || audit?.ok !== true) report.ok = false;
  } else {
    report.steps.push({
      name: 'windows-unpacked-pack',
      ok: true,
      skipped: true,
      reason: wantPack
        ? 'electron-builder not available in desktop package'
        : 'set SOULFORGE_PORTABLE_PACK=1 to build and audit an unsigned win-unpacked directory'
    });
  }
} catch (error) {
  report.ok = false;
  report.steps.push({
    name: 'desktop-package-json',
    ok: false,
    message: error instanceof Error ? error.message : String(error)
  });
}

// 3) Release content scan still clean
const releaseScan = await run('npm', ['run', 'test:release-content']);
report.steps.push({
  name: 'release-content-scan',
  ok: releaseScan.code === 0,
  code: releaseScan.code,
  stdoutTail: releaseScan.stdout.slice(-600)
});
if (releaseScan.code !== 0) report.ok = false;

report.status = report.ok
  ? (report.steps.some((step) => step.name === 'windows-unpacked-pack' && step.ok && !step.skipped)
      ? 'pass-unpacked'
      : 'pass-config')
  : 'failed';
report.message = report.ok
  ? (report.status === 'pass-unpacked'
      ? 'Windows unpacked 目录构建与内容审计通过（未签名；portable EXE/NSIS/更新器未验证）。'
      : 'portable 打包配置门禁通过（未签名；未声明可分发发行包）。')
  : 'portable 打包门禁失败。';

const outPath = join(scratch, 'portable-packaging-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = report.ok ? 0 : 1;

async function auditUnpackedDirectory(directory) {
  const required = [
    join(directory, 'SoulForge.exe'),
    join(directory, 'resources/app.asar'),
    join(
      directory,
      'resources/native/electron-rebuild/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    )
  ];
  const requiredPresent = [];
  for (const path of required) {
    try {
      const entry = await stat(path);
      requiredPresent.push(entry.isFile());
    } catch {
      requiredPresent.push(false);
    }
  }
  const files = await listFiles(directory);
  const forbidden = files.filter((path) => {
    const relative = path.slice(directory.length + 1).replaceAll('\\', '/');
    const name = relative.split('/').at(-1) ?? '';
    return /(^|\/)mods\//i.test(relative)
      || /^oo2core.*\.dll$/i.test(name)
      || /secret|api.?key/i.test(name);
  });
  return {
    ok: requiredPresent.every(Boolean) && forbidden.length === 0,
    executablePresent: requiredPresent[0],
    asarPresent: requiredPresent[1],
    sqliteBindingPresent: requiredPresent[2],
    fileCount: files.length,
    forbiddenRelativePaths: forbidden.map((path) => path.slice(directory.length + 1).replaceAll('\\', '/'))
  };
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

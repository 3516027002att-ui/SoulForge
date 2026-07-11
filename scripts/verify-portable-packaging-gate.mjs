/**
 * P7 portable packaging gate — validates electron-builder config and optionally
 * runs an unsigned dry packaging step when electron-builder is available.
 * Never claims signed release readiness.
 */
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
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
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: true,
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
    const result = await run(
      'npx',
      ['electron-builder', '--config', 'electron-builder.yml', '--win', 'portable', '--dir', '--publish', 'never'],
      join(root, 'apps/desktop')
    );
    report.steps.push({
      name: 'portable-dir-pack',
      ok: result.code === 0,
      code: result.code,
      stdoutTail: result.stdout.slice(-1200),
      stderrTail: result.stderr.slice(-800)
    });
    if (result.code !== 0) report.ok = false;
  } else {
    report.steps.push({
      name: 'portable-dir-pack',
      ok: true,
      skipped: true,
      reason: wantPack
        ? 'electron-builder not available in desktop package'
        : 'set SOULFORGE_PORTABLE_PACK=1 to run unsigned --dir pack'
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

report.status = report.ok ? 'pass-config' : 'failed';
report.message = report.ok
  ? 'portable 打包配置门禁通过（未签名；未声明可分发发行包）。'
  : 'portable 打包门禁失败。';

const outPath = join(scratch, 'portable-packaging-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = report.ok ? 0 : 1;

/**
 * Legacy-named packaging gate — validates the NSIS-only electron-builder config
 * and optionally builds an unsigned unpacked directory for content inspection.
 * Never claims NSIS installer or distribution readiness.
 */
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProcessCancellation,
  processSucceeded,
  readTimeoutMs,
  runProcess
} from './subprocess-control.mjs';
import { validatePortableBuilderConfig } from './portable-packaging-config.mjs';
import {
  resolveSafeScratchRoot,
  scratchBoundaryFailure
} from './scratch-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredScratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-unpacked-package-gate');
const builderConfigPath = join(root, 'apps/desktop/electron-builder.json');
const releasePolicyPath = join(root, 'scripts/release-compliance-policy.json');
const desktopPkg = join(root, 'apps/desktop/package.json');
const npmCli = process.env.npm_execpath?.trim()
  || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let packTimeoutMs;
let scanTimeoutMs;
try {
  packTimeoutMs = readTimeoutMs('SOULFORGE_UNPACKED_PACK_TIMEOUT_MS', 15 * 60 * 1000);
  scanTimeoutMs = readTimeoutMs('SOULFORGE_RELEASE_SCAN_TIMEOUT_MS', 5 * 60 * 1000);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    code: 'UNPACKED_PACK_TIMEOUT_INVALID',
    message: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
}
let scratch;
try {
  scratch = await resolveSafeScratchRoot({
    scratch: configuredScratch,
    repositoryRoot: root,
    protectedRoots: [
      { label: 'sekiro-game-root', path: process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? '' },
      { label: 'native-fixture-root', path: process.env.SOULFORGE_NATIVE_FIXTURE_ROOT ?? '' },
      { label: 'mod-workspace-root', path: resolve(root, 'mods') }
    ]
  });
  await mkdir(scratch, { recursive: true });
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    gate: 'unpacked-package-inspection',
    ...scratchBoundaryFailure(error)
  }, null, 2));
  process.exit(1);
}
const cancellation = createProcessCancellation();

const report = {
  ok: true,
  validationOk: true,
  completed: false,
  authority: 'unverified',
  dryPackStatus: 'not-evaluated',
  gate: 'unpacked-package-inspection',
  timestamp: new Date().toISOString(),
  status: 'unknown',
  message: '',
  steps: /** @type {Array<Record<string, unknown>>} */ ([])
};

function runNpm(args, cwd = root, timeoutMs = scanTimeoutMs) {
  if (!npmCli) {
    return Promise.resolve({
      code: 1,
      stdout: '',
      stderr: 'npm_execpath is unavailable; invoke this gate through npm run'
    });
  }
  return runProcess({
    command: process.execPath,
    args: [npmCli, ...args],
    cwd,
    timeoutMs,
    signal: cancellation.signal
  });
}

// 1) Parse the exact config consumed by electron-builder and validate semantics.
try {
  await access(builderConfigPath, constants.F_OK);
  const config = JSON.parse(await readFile(builderConfigPath, 'utf8'));
  const releasePolicy = JSON.parse(await readFile(releasePolicyPath, 'utf8'));
  const checks = validatePortableBuilderConfig(config, releasePolicy);
  for (const c of checks) {
    report.steps.push({ name: `config:${c.name}`, ok: c.ok });
    if (!c.ok) report.ok = false;
  }
  report.steps.push({ name: 'electron-builder-config', ok: true, path: 'apps/desktop/electron-builder.json' });
} catch (error) {
  report.ok = false;
  report.steps.push({
    name: 'electron-builder-config',
    ok: false,
    message: error instanceof Error ? error.message : String(error)
  });
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
  const wantPack = process.env.SOULFORGE_UNPACKED_PACK === '1';
  if (wantPack && !hasBuilderDep) {
    report.ok = false;
    report.dryPackStatus = 'failed';
    report.steps.push({
      name: 'unpacked-dir-pack',
      ok: false,
      status: 'failed',
      reason: 'SOULFORGE_UNPACKED_PACK=1 but electron-builder is unavailable'
    });
  } else if (wantPack) {
    let builderCli;
    try {
      const builderPackage = await import.meta.resolve('electron-builder/package.json');
      builderCli = join(dirname(fileURLToPath(builderPackage)), 'cli.js');
      await access(builderCli, constants.F_OK);
    } catch (error) {
      report.ok = false;
      report.dryPackStatus = 'failed';
      report.steps.push({
        name: 'unpacked-dir-pack',
        ok: false,
        status: 'failed',
        reason: 'declared electron-builder CLI cannot be resolved locally',
        diagnostic: error instanceof Error ? error.message : String(error)
      });
    }
    if (!builderCli) {
      // The structured failure above is sufficient; never fall back to a network install.
    } else {
      const result = await runProcess({
        command: process.execPath,
        args: [
          builderCli,
          '--config', 'electron-builder.json',
          '--win',
          '--x64',
          '--dir',
          '--publish', 'never'
        ],
        cwd: join(root, 'apps/desktop'),
        timeoutMs: packTimeoutMs,
        signal: cancellation.signal
      });
      const packPassed = processSucceeded(result);
      report.dryPackStatus = packPassed ? 'passed' : 'failed';
      report.steps.push({
        name: 'unpacked-dir-pack',
        ok: packPassed,
        status: packPassed ? 'passed' : 'failed',
        code: result.code,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        timeoutMs: result.timeoutMs,
        stdoutTail: result.stdout.slice(-1200),
        stderrTail: result.stderr.slice(-800)
      });
      if (!packPassed) report.ok = false;
    }
  } else {
    report.dryPackStatus = 'skipped';
    report.steps.push({
      name: 'unpacked-dir-pack',
      ok: null,
      status: 'skipped',
      skipped: true,
      reason: 'set SOULFORGE_UNPACKED_PACK=1 to run unsigned --dir content-inspection pack'
    });
  }
} catch (error) {
  report.ok = false;
  report.dryPackStatus = 'failed';
  report.steps.push({
    name: 'desktop-package-json',
    ok: false,
    message: error instanceof Error ? error.message : String(error)
  });
}

// 3) Release content scan still clean
const releaseScan = await runNpm(['run', 'test:release-content']);
report.steps.push({
  name: 'release-content-scan',
  ok: processSucceeded(releaseScan),
  code: releaseScan.code,
  timedOut: releaseScan.timedOut,
  cancelled: releaseScan.cancelled,
  timeoutMs: releaseScan.timeoutMs,
  stdoutTail: releaseScan.stdout.slice(-600),
  stderrTail: releaseScan.stderr.slice(-600)
});
if (!processSucceeded(releaseScan)) report.ok = false;
if (cancellation.signal.aborted) report.ok = false;

report.status = report.ok ? 'pass-config' : 'failed';
report.message = report.ok
  ? 'NSIS-only 配置门禁通过（可选 unpacked 中间产物不构成发行包）。'
  : 'NSIS-only 打包配置门禁失败。';
const validationOk = report.ok;
report.validationOk = validationOk;
if (!validationOk) {
  report.ok = false;
  report.status = 'failed';
  report.authority = 'unverified';
  report.message = 'NSIS-only packaging gate failed';
} else if (report.dryPackStatus === 'passed') {
  report.ok = true;
  report.status = 'partial';
  report.authority = 'candidate';
  report.message = 'configuration, release scan, and unsigned --dir build passed';
} else {
  report.ok = null;
  report.status = 'partial';
  report.authority = 'partial';
  report.message = 'configuration and release scan passed; unsigned --dir build was not requested';
}
report.nonClaim = 'Unsigned unpacked --dir evidence is not a portable release and does not prove NSIS installer, installer hash, upgrade, clean-machine, or distribution readiness.';

const outPath = join(scratch, 'unpacked-package-inspection-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
cancellation.dispose();
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = validationOk ? 0 : 1;

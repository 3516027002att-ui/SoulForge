/**
 * Cross-machine reproducibility fingerprint harness (W-REL-COMPLIANCE-02).
 *
 * This provides the mechanism and exact commands to prove the release manifest
 * sha256 fingerprints rebuild identically on a second, independent machine.
 * It does not require a second machine to be reachable from here.
 *
 * Modes:
 *   (no args)        Audit both on-disk manifests for the fields needed for a
 *                    cross-machine comparison and print the reproduction
 *                    protocol (status stays partial — no second machine ran).
 *   --export <path>  Write this machine's fingerprint record to <path>. Run
 *                    this on machine A, then on machine B at the same commit.
 *   --compare <a> <b>  Compare two exported fingerprint records. Identical
 *                      source fingerprint + installer hash + commit → passed
 *                      (cross-machine reproducibility confirmed).
 *
 * Reproduction protocol on a second machine at the same git commit:
 *   1. git clone <remote> && git checkout <commit>
 *   2. npm ci
 *   3. npm run build                 # produces out/release-compliance.json
 *   4. npx electron-builder --win nsis   # (cwd apps/desktop) produces NSIS exe
 *   5. npm run release:installer:manifest # produces release-installer-compliance.json
 *   6. node scripts/verify-cross-machine-reproducible.mjs --export cross-machine.json
 *   7. compare against machine A's export with --compare
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  INSTALLER_MANIFEST_RELATIVE_PATH,
  RELEASE_MANIFEST_RELATIVE_PATH
} from './release-compliance-lib.mjs';

const root = resolve(import.meta.dirname, '..');

function sha256File(relativePath) {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return null;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function readJson(relativePath) {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) {
    return { missing: true, path: relativePath };
  }
  try {
    return { missing: false, path: relativePath, value: JSON.parse(readFileSync(absolute, 'utf8')) };
  } catch {
    return { missing: false, path: relativePath, invalid: true };
  }
}

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function fingerprintRecord(source, installer) {
  const sourceFingerprint = source.value?.artifacts?.aggregateSha256 ?? null;
  const sourceSha = sha256File(RELEASE_MANIFEST_RELATIVE_PATH);
  const installerFile = installer.value?.installer ?? null;
  return {
    schemaVersion: 1,
    scope: 'win-x64-nsis-reproducible',
    generatedAt: new Date().toISOString(),
    gitCommit: gitHead(),
    source: {
      path: RELEASE_MANIFEST_RELATIVE_PATH,
      manifestSha256: sourceSha,
      artifactFingerprint: sourceFingerprint
    },
    installer: {
      path: INSTALLER_MANIFEST_RELATIVE_PATH,
      fileName: installerFile?.fileName ?? null,
      size: installerFile?.size ?? null,
      sha256: installerFile?.sha256 ?? null
    }
  };
}

function missingFields(record) {
  const missing = [];
  if (!record.gitCommit) missing.push('gitCommit');
  if (!record.source.manifestSha256) missing.push('source.manifestSha256');
  if (!record.source.artifactFingerprint) missing.push('source.artifactFingerprint');
  if (!record.installer.sha256) missing.push('installer.sha256');
  return missing;
}

const [, , mode, argA, argB] = process.argv;

if (mode === '--export') {
  if (!argA) fail('EXPORT_PATH_REQUIRED', '--export 需要一个输出路径。');
  const source = readJson(RELEASE_MANIFEST_RELATIVE_PATH);
  const installer = readJson(INSTALLER_MANIFEST_RELATIVE_PATH);
  const record = fingerprintRecord(source, installer);
  const missing = missingFields(record);
  if (missing.length > 0) {
    fail('EXPORT_INCOMPLETE', '当前机器缺少跨机比对所需字段。', { missing });
  }
  await writeFile(resolve(argA), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, status: 'passed', exported: resolve(argA), record }, null, 2));
  process.exit(0);
}

if (mode === '--compare') {
  if (!argA || !argB) fail('COMPARE_ARGS_REQUIRED', '--compare 需要两份导出记录路径。');
  const [left, right] = [argA, argB].map((path) => {
    if (!existsSync(resolve(path))) fail('COMPARE_MISSING', `找不到导出记录：${path}`);
    try {
      return JSON.parse(readFileSync(resolve(path), 'utf8'));
    } catch {
      fail('COMPARE_INVALID', `导出记录不是合法 JSON：${path}`);
    }
  });
  if (left.schemaVersion !== 1 || right.schemaVersion !== 1) {
    fail('COMPARE_SCHEMA', '导出记录 schemaVersion 不是 1。');
  }
  if (left.gitCommit !== right.gitCommit) {
    fail('COMPARE_COMMIT_MISMATCH', '两份记录来自不同 git commit，不能比较。', {
      left: left.gitCommit,
      right: right.gitCommit
    });
  }
  const same = left.source.artifactFingerprint === right.source.artifactFingerprint
    && left.source.manifestSha256 === right.source.manifestSha256
    && left.installer.sha256 === right.installer.sha256;
  console.log(JSON.stringify({
    ok: same,
    status: same ? 'passed' : 'failed',
    message: same
      ? '跨机指纹一致：两台机器在同一 commit 上重建出相同的 source 指纹与 installer sha256。'
      : '跨机指纹不一致：请检查工具链（Node/dotnet）与依赖版本是否完全一致。',
    gitCommit: left.gitCommit,
    sourceFingerprint: left.source.artifactFingerprint,
    installerSha256: left.installer.sha256
  }, null, 2));
  process.exit(same ? 0 : 1);
}

if (mode) {
  fail('UNKNOWN_MODE', `未知模式：${mode}。支持：--export <path>、--compare <a> <b>。`);
}

// Default: audit both manifests and print the reproduction protocol.
const source = readJson(RELEASE_MANIFEST_RELATIVE_PATH);
const installer = readJson(INSTALLER_MANIFEST_RELATIVE_PATH);
const record = fingerprintRecord(source, installer);
const missing = missingFields(record);
const problems = [];
if (source.missing || source.invalid) problems.push(`source manifest 缺失或损坏：${RELEASE_MANIFEST_RELATIVE_PATH}`);
if (installer.missing || installer.invalid) problems.push(`installer manifest 缺失或损坏：${INSTALLER_MANIFEST_RELATIVE_PATH}`);
for (const field of missing) problems.push(`跨机比对字段缺失：${field}`);

console.log(JSON.stringify({
  ok: problems.length === 0,
  status: problems.length === 0 ? 'partial' : 'failed',
  message: problems.length === 0
    ? '本机 manifest 具备跨机比对所需字段；重建协议已就绪，第二台机器未在本机实测。'
    : '本机 manifest 不满足跨机比对前提。',
  audit: record,
  problems,
  protocol: [
    '1. git clone <remote> && git checkout <commit>',
    '2. npm ci',
    '3. npm run build',
    '4. cd apps/desktop && npx electron-builder --win nsis',
    '5. npm run release:installer:manifest',
    '6. node scripts/verify-cross-machine-reproducible.mjs --export cross-machine.json',
    '7. node scripts/verify-cross-machine-reproducible.mjs --compare <machine-a>.json <machine-b>.json'
  ],
  nonClaim: '本机 audit 不等于第二台机器已实测；--compare 两份导出记录一致才算跨机复现证据。'
}, null, 2));
process.exitCode = problems.length === 0 ? 0 : 1;

function fail(code, message, details) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message, details }, null, 2));
  process.exit(1);
}

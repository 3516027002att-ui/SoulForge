import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { RELEASE_MANIFEST_RELATIVE_PATH } from './release-compliance-lib.mjs';
import {
  createProcessCancellation,
  readTimeoutMs,
  runProcess
} from './subprocess-control.mjs';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, RELEASE_MANIFEST_RELATIVE_PATH);
let before;
try {
  before = await readFile(manifestPath, 'utf8');
} catch {
  fail('REPRO_BASELINE_MISSING', '缺少 build baseline；先运行 npm run build。');
}

const npmCli = process.env.npm_execpath?.trim()
  || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let buildTimeoutMs;
try {
  buildTimeoutMs = readTimeoutMs('SOULFORGE_REPRO_BUILD_TIMEOUT_MS', 15 * 60 * 1000);
} catch (error) {
  fail('REPRO_TIMEOUT_INVALID', error instanceof Error ? error.message : String(error));
}
const cancellation = createProcessCancellation();
const build = await runProcess({
  command: process.execPath,
  args: [npmCli, 'run', 'build'],
  cwd: root,
  timeoutMs: buildTimeoutMs,
  signal: cancellation.signal
});
cancellation.dispose();
if (build.timedOut) {
  fail('REPRO_REBUILD_TIMEOUT', '重复构建超时，已终止子进程树。', { timeoutMs: build.timeoutMs });
}
if (build.cancelled) {
  fail('REPRO_REBUILD_CANCELLED', '重复构建已取消，已终止子进程树。');
}
if (build.code !== 0) {
  fail('REPRO_REBUILD_FAILED', '重复构建失败。', {
    code: build.code,
    stdoutTail: build.stdout.slice(-1200),
    stderrTail: build.stderr.slice(-1200),
    stdoutTruncated: build.stdoutTruncated,
    stderrTruncated: build.stderrTruncated
  });
}
const after = await readFile(manifestPath, 'utf8');
const beforeManifest = JSON.parse(before);
const afterManifest = JSON.parse(after);
const reproducible = before === after;
const beforeFiles = new Map((beforeManifest.artifacts?.files ?? []).map((item) => [item.path, item]));
const afterFiles = new Map((afterManifest.artifacts?.files ?? []).map((item) => [item.path, item]));
const artifactChanges = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
  .sort()
  .flatMap((path) => {
    const beforeEntry = beforeFiles.get(path);
    const afterEntry = afterFiles.get(path);
    if (JSON.stringify(beforeEntry) === JSON.stringify(afterEntry)) return [];
    return [{ path, before: beforeEntry ?? null, after: afterEntry ?? null }];
  });
const result = {
  ok: reproducible,
  status: reproducible ? 'passed' : 'failed',
  message: reproducible ? '连续两次构建的 release manifest 完全一致。' : '重复构建产生了不同 release manifest。',
  beforeFingerprint: beforeManifest.artifacts?.aggregateSha256 ?? null,
  afterFingerprint: afterManifest.artifacts?.aggregateSha256 ?? null,
  manifestByteIdentical: reproducible,
  ignoredMetadata: afterManifest.reproducibility?.ignoredMetadata ?? [],
  artifactChanges,
  nonClaim: '同机同依赖的可复现 fingerprint 不等于跨工具链 bit-for-bit installer reproducibility。'
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = reproducible ? 0 : 1;

function fail(code, message, details) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message, details }, null, 2));
  process.exit(1);
}

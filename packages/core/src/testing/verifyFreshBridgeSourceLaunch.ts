import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

// Explicit SDK acceptance entry, run on Linux before any Bridge build. Copy
// tracked sources into an empty owned directory so existing outputs cannot
// accidentally satisfy the first-launch requirement.
assert.equal(process.platform, 'linux', 'Fresh Linux launch acceptance requires a Linux host.');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const root = await mkdtemp(join(tmpdir(), 'sf-fresh-linux-bridge-'));
try {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'bridge', 'scripts', 'global.json'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const relative of files) {
    const source = join(repoRoot, relative);
    assert.equal((await lstat(source)).isFile(), true, `Only tracked regular sources may be copied: ${relative}`);
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  // The owned-process guardian is an explicitly prepared prerequisite
  // (`npm run prepare:owned-process-guardian`), not a Bridge build output. The
  // native hksc step of the Bridge build runs under it, so the fresh copy
  // carries the prepared artifact exactly as a checkout would after that step.
  const guardianRelative = '.local-validation/owned-process-guardian/linux-x64';
  const manifestName = 'soulforge-owned-process-guardian.manifest.json';
  let guardianManifest: { binaryFile?: unknown };
  try { guardianManifest = JSON.parse(await readFile(join(repoRoot, guardianRelative, manifestName), 'utf8')); }
  catch { throw new Error('Fresh Linux launch needs the prepared guardian: run npm run prepare:owned-process-guardian first.'); }
  assert.ok(typeof guardianManifest.binaryFile === 'string' && /^[\w.-]+$/u.test(guardianManifest.binaryFile),
    'guardian manifest names a binary in its own directory');
  await mkdir(join(root, guardianRelative), { recursive: true });
  for (const name of [manifestName, guardianManifest.binaryFile]) {
    const from = join(repoRoot, guardianRelative, name), to = join(root, guardianRelative, name);
    await copyFile(from, to);
    await chmod(to, (await stat(from)).mode & 0o777);
  }
  const source = join(root, 'sample.bin');
  await writeFile(source, 'fresh-source-inspection');
  const phases: unknown[] = [];
  const result = await runBridge({
    bridgeProjectPath: join(root, 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'),
    filePath: source, resourceUri: 'file://sample.bin', command: 'inspect',
    allowedRoots: [root], timeoutMs: 30_000, onProgress: value => phases.push(value)
  });
  // Diagnostics first: a failed launch returns the logical resourceUri, which
  // would otherwise hide the Bridge failure behind a sourceUri mismatch.
  assert.ok(!result.diagnostics.some(item => item.code.startsWith('BRIDGE_')), JSON.stringify(result.diagnostics));
  assert.equal(result.sourceUri, pathToFileURL(source).href);
  assert.deepEqual(phases.filter(value => (value as { phase?: string }).phase === 'bridge-source-build')
    .map(value => (value as { status: string }).status), ['started', 'completed']);
  console.log(JSON.stringify({ ok: true, status: 'verified', suite: 'fresh-linux-source-launch',
    node: process.versions.node, parseStatus: result.parseStatus,
    claim: 'Tracked source copy without bin/obj builds before the production daemon handshake and returns a structured inspect result.' }));
} finally {
  await disposeBridgeDaemonPool();
  await rm(root, { recursive: true, force: true });
}

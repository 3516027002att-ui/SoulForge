import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const source = join(root, 'sample.bin');
  await writeFile(source, 'fresh-source-inspection');
  const phases: unknown[] = [];
  const result = await runBridge({
    bridgeProjectPath: join(root, 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'),
    filePath: source, resourceUri: 'file://sample.bin', command: 'inspect',
    allowedRoots: [root], timeoutMs: 30_000, onProgress: value => phases.push(value)
  });
  assert.equal(result.sourceUri, pathToFileURL(source).href);
  assert.ok(!result.diagnostics.some(item => item.code.startsWith('BRIDGE_')), JSON.stringify(result.diagnostics));
  assert.deepEqual(phases.filter(value => (value as { phase?: string }).phase === 'bridge-source-build')
    .map(value => (value as { status: string }).status), ['started', 'completed']);
  console.log(JSON.stringify({ ok: true, status: 'verified', suite: 'fresh-linux-source-launch',
    node: process.versions.node, parseStatus: result.parseStatus,
    claim: 'Tracked source copy without bin/obj builds before the production daemon handshake and returns a structured inspect result.' }));
} finally {
  await disposeBridgeDaemonPool();
  await rm(root, { recursive: true, force: true });
}

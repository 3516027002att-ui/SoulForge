import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('the actual Playwright fixture tears down a failing test and closes its live profile process', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sf-playwright-owned-test-'));
  try {
    const fixtureUrl = pathToFileURL(resolve('apps/desktop/e2e/playwright/owned-test.mjs')).href;
    const record = join(parent, 'owner.json');
    await writeFile(join(parent, 'cleanup.spec.mjs'), `
      import { test, expect, testWorkspace } from ${JSON.stringify(fixtureUrl)};
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      test('controlled assertion failure', async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        await testWorkspace().registerApp({ process: () => child, close: async () => {
          const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        } });
        writeFileSync(${JSON.stringify(record)}, JSON.stringify({ root: testWorkspace().root, pid: child.pid }));
        expect(1, 'controlled assertion failure').toBe(2);
      });
      test('later independent test verifies teardown', async () => {
        const predecessor = JSON.parse(readFileSync(${JSON.stringify(record)}, 'utf8'));
        expect(existsSync(predecessor.root)).toBe(false);
        let live = true; try { process.kill(predecessor.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
        expect(live).toBe(false);
        expect(testWorkspace().root).not.toBe(predecessor.root);
      });
    `);
    const config = join(parent, 'playwright.config.mjs');
    await writeFile(config, `export default { testDir: ${JSON.stringify(parent)}, workers: 1, retries: 0, reporter: 'json', outputDir: ${JSON.stringify(join(parent, 'results'))} };`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', config], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stats.unexpected, 1, 'the controlled failure keeps its failure status');
    assert.equal(report.stats.expected, 1, 'the later independent test really executes');
    const predecessor = JSON.parse(await readFile(record, 'utf8'));
    await assert.rejects(readFile(join(predecessor.root, '.soulforge-temporary-owner.json')), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

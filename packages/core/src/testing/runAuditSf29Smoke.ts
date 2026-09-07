import { strict as assert } from 'node:assert';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ChildResult = {
  suite: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const UNIT_TASKS = Array.from({ length: 29 }, (_, index) => String(index).padStart(2, '0'));
const NATIVE_TASKS = Array.from({ length: 25 }, (_, index) => {
  const taskNumber = index + 1;
  const adjusted = taskNumber >= 18 ? taskNumber + 2 : taskNumber;
  return String(adjusted).padStart(2, '0');
});

function selectedLayer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-29 requires --layer unit|native');
  return value;
}

function npmCli(): string {
  const configured = process.env.npm_execpath?.trim();
  if (configured) return configured;
  return resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function runProcess(args: string[], timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      return next.length <= 24_000 ? next : next.slice(-24_000);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      stderr = append(stderr, error instanceof Error ? error.message : String(error));
      resolveResult({ exitCode: null, timedOut, stdout, stderr });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ exitCode: typeof code === 'number' ? code : null, timedOut, stdout, stderr });
    });
  });
}

async function runSuite(taskId: string, layer: 'unit' | 'native'): Promise<ChildResult> {
  const suite = `test:audit-sf-${taskId}-${layer}`;
  const args = layer === 'native'
    ? [join(ROOT, 'scripts', 'with-local-has-game-env.mjs'), 'npm', 'run', suite, '--silent']
    : [npmCli(), 'run', suite, '--silent'];
  const result = await runProcess(args, layer === 'native' ? 600_000 : 180_000);
  return { suite, ...result };
}

function assertChildPassed(result: ChildResult): void {
  assert.equal(result.timedOut, false, `${result.suite} timed out`);
  assert.equal(result.exitCode, 0, `${result.suite} failed:\n${result.stderr || result.stdout}`);
  assert(result.stdout.trim().length > 0, `${result.suite} produced no structured result`);
  assert(!/"status"\s*:\s*"skipped"|"skipped"\s*:\s*true/iu.test(result.stdout), `${result.suite} reported skipped`);
}

async function validateAcceptanceMap(): Promise<number> {
  const map = JSON.parse(await readFile(join(ROOT, 'SoulForge_Flash_Execution', 'acceptance-map.json'), 'utf8')) as Array<{ id: string; tasks: string[] }>;
  const ids = Array.from({ length: 60 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`);
  assert.deepEqual(map.map((item) => item.id), ids, 'acceptance map must cover T01-T60 without gaps');
  assert(map.every((item) => item.tasks.includes('SF-29')), 'every acceptance item must be assigned to SF-29');
  return map.length;
}

async function validateProductEntry(): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert(packageJson.scripts?.['test:renderer-playwright']?.includes('playwright test'));
  await access(join(ROOT, 'apps', 'desktop', 'e2e', 'playwright', 'playwright.config.mjs'));
  await access(join(ROOT, 'docs', 'audit-execution', 'product-acceptance.md'));
}

async function main(): Promise<void> {
  const layer = selectedLayer();
  const acceptanceCount = await validateAcceptanceMap();
  await validateProductEntry();
  const taskIds = layer === 'unit' ? UNIT_TASKS : NATIVE_TASKS;
  const results: ChildResult[] = [];
  for (const taskId of taskIds) {
    const result = await runSuite(taskId, layer);
    results.push(result);
    assertChildPassed(result);
  }
  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-29',
    layer,
    executedCases: acceptanceCount + results.length + 3,
    acceptanceItems: acceptanceCount,
    delegatedSuites: results.map((result) => result.suite),
    productEntry: 'apps/desktop/e2e/playwright/playwright.config.mjs',
    production: ['acceptance-map', 'registered audit suites', 'renderer-e2e-real-entry'],
    note: layer === 'native' ? 'Native task suites passed; Electron interactive trace is a separate product acceptance evidence leg.' : undefined
  }));
}

void main();

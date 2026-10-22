import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForExit(child, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`sfcli session smoke timeout; stderr=${stderr.join('')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        stdout: stdout.join(''),
        stderr: stderr.join('')
      });
    });
  });
}

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const cliPath = join(repoRoot, 'tools', 'soulforge-cli', 'sfcli.mjs');
const workspace = mkdtempSync(join(tmpdir(), 'soulforge-cli-session-'));
// A Windows caller may select a different spelling of the same physical root,
// including the runner's 8.3 TEMP alias. Keep this alias in the CLI request so
// the smoke catches an index/session identity mismatch on every Windows run.
const selectedWorkspace = process.platform === 'win32' ? workspace.toUpperCase() : workspace;
const cliEnvironment = {
  ...process.env,
  SF_E2E_WORKSPACE_STORAGE_ROOT: join(workspace, '.soulforge', 'cli-test-storage')
};

try {
  const child = spawn(process.execPath, [
    cliPath,
    '--workspace', selectedWorkspace,
    '--mode', 'plan',
    '--no-cache',
    '--quiet',
    '--diagnostics',
    'session'
  ], { cwd: repoRoot, env: cliEnvironment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin.write(JSON.stringify({
    id: 'search-1',
    tool: 'search_param_rows',
    args: { query: '鬼型部', paramNames: ['NpcParam'], limit: 4 }
  }) + '\n');
  // The duplicate request must be served by the same request host rather than
  // opening a second workspace session.
  child.stdin.write(JSON.stringify({
    id: 'search-1',
    tool: 'search_param_rows',
    args: { query: '鬼型部', paramNames: ['NpcParam'], limit: 4 }
  }) + '\n');
  child.stdin.write(JSON.stringify({
    id: 'status-1',
    tool: '__host_status',
    args: {}
  }) + '\n');
  child.stdin.write(JSON.stringify({
    id: 'close-1',
    tool: '__host_close',
    args: {}
  }) + '\n');

  const result = await waitForExit(child);
  assert(result.code === 0, `session exited with ${result.code}; stderr=${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert(lines.length === 4, `expected 4 session responses, got ${lines.length}: ${result.stdout}`);
  const searchResponses = lines.filter((line) => line.id === 'search-1');
  const statusResponse = lines.find((line) => line.id === 'status-1');
  const closeResponse = lines.find((line) => line.id === 'close-1');
  assert(searchResponses.length === 2, 'request ids were not preserved');
  assert(JSON.stringify(searchResponses[0]) === JSON.stringify(searchResponses[1]), 'duplicate request was not deduplicated');
  assert(searchResponses.every((response) => response.requestState === 'completed'),
    `search never reached its tool result: stdout=${result.stdout}; stderr=${result.stderr}`);
  assert(statusResponse?.result?.session === 'stdin', 'status response missing');
  assert(closeResponse?.result?.closed === true, 'close response missing');

  const diagnostics = result.stderr.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert(diagnostics.some((event) => event.phase === 'workspace.scan' && event.status === 'complete'),
    'workspace scan diagnostic missing');
  assert(diagnostics.some((event) => event.phase === 'semantic.cache' && event.status === 'complete'),
    'semantic cache diagnostic missing');
  const toolTimings = diagnostics.filter((event) => event.phase === 'tool' && event.status === 'complete'
    && event.details?.requestId === 'search-1' && event.details?.tool === 'search_param_rows');
  assert(toolTimings.length === 1 && Number.isFinite(toolTimings[0].elapsedMs) && toolTimings[0].elapsedMs >= 0,
    'tool timing diagnostic missing');
  assert(diagnostics.every((event) => event.type === 'soulforge-cli-diagnostic'),
    'stderr contained non-diagnostic output in diagnostics mode');

  const toolChild = spawn(process.execPath, [
    cliPath,
    '--workspace', selectedWorkspace,
    '--mode', 'fullPermission',
    '--no-analyze',
    '--json',
    '--quiet',
    '--diagnostics',
    'call', 'list_operations', '{}'
  ], { cwd: repoRoot, env: cliEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const toolResult = await waitForExit(toolChild);
  assert(toolResult.code === 0, `no-analyze list_operations exited with ${toolResult.code}; stderr=${toolResult.stderr}`);
  const operationEnvelope = JSON.parse(toolResult.stdout.trim());
  assert(operationEnvelope.ok === true, `list_operations failed: ${toolResult.stdout}`);
  const toolDiagnostics = toolResult.stderr.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert(toolDiagnostics.some((event) => event.phase === 'workspace.scan' && event.status === 'complete'),
    'no-analyze call must still scan the requested workspace');
  assert(!toolDiagnostics.some((event) => event.phase === 'workspace.analyze'),
    'explicit --no-analyze must avoid expensive semantic analysis for operation-only recovery tools');

  console.log(JSON.stringify({
    ok: true,
    message: 'sfcli long-session smoke passed',
    responses: lines.length,
    diagnostics: diagnostics.length
  }, null, 2));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

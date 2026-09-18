import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const workspace = process.env.SOULFORGE_REFERENCE_TEST_WORKSPACE;
const base = process.env.SOULFORGE_REFERENCE_TEST_BASE;
if (!workspace || !base) {
  console.log(JSON.stringify({ ok: true, status: 'not-attempted', suite: 'reference-real-cli', reason: 'SOULFORGE_REFERENCE_TEST_WORKSPACE/BASE 未设置' }));
  process.exit(0);
}
if (!existsSync(workspace) || !existsSync(base)) {
  console.log(JSON.stringify({ ok: true, status: 'not-attempted', suite: 'reference-real-cli', reason: '测试工作区或 base 不存在' }));
  process.exit(0);
}

const repo = process.cwd();
const cli = join(repo, 'tools', 'soulforge-cli', 'sfcli.mjs');

async function call(tool, payload) {
  const args = [cli, '--workspace', workspace, '--base', base, '--mode', 'plan', '--json', '--quiet', 'call', tool, JSON.stringify(payload)];
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { /* keep bounded diagnostic */ }
  return { tool, exitCode: result.code, parsed, stderr: String(result.stderr).slice(-1000) };
}

const list = await new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, '--workspace', workspace, '--base', base, '--json', '--quiet', 'list'], { cwd: repo, env: process.env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    let parsed = null;
    try { parsed = JSON.parse(stdout.trim()); } catch { /* diagnostic below */ }
    resolve({ code, parsed, stderr: String(stderr).slice(-1000) });
  });
});

const calls = [
  await call('workspace_stats', {}),
  await call('retrieve_evidence', { query: 'c1150', limit: 3 }),
  await call('find_references', { query: 'c1150', domain: 'map', direction: 'both', detail: 'edges', limit: 3 }),
  await call('search_tae_events', { query: 'c1050#A0200.e0', limit: 3 })
];
const listNames = Array.isArray(list.parsed) ? list.parsed.map((item) => item.name).filter(Boolean) : [];
const failed = [list, ...calls].filter((item) => item.code !== 0 || !item.parsed);
console.log(JSON.stringify({
  ok: failed.length === 0,
  status: failed.length === 0 ? 'completed' : 'failed',
  suite: 'reference-real-cli',
  toolCount: listNames.length,
  requiredToolsPresent: ['workspace_stats', 'retrieve_evidence', 'find_references', 'search_tae_events'].every((name) => listNames.includes(name)),
  calls: calls.map((item) => ({ tool: item.tool, exitCode: item.exitCode, ok: Boolean(item.parsed), state: item.parsed?.state ?? item.parsed?.data?.record?.status ?? null })),
  diagnostics: failed.map((item) => ({ tool: item.tool ?? 'list', exitCode: item.code, stderr: item.stderr }))
}));
process.exit(failed.length === 0 ? 0 : 1);


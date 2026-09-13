import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAgentProductionBuildFresh } from './agent-production-build-lib.mjs';
import { assertBridgeProductionBuildFresh } from './bridge-production-build.mjs';
import { createProcessCancellation, processSucceeded, readTimeoutMs, runProcess } from './subprocess-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function ensureAgentProductionBuild({ databaseSmoke = false } = {}) {
  const required = [];
  // Database smoke needs Electron only. Agent simulation also snapshots Bridge.
  if (!databaseSmoke) {
    try { await assertBridgeProductionBuildFresh(root); }
    catch (error) { required.push({ script: 'bridge:publish', reason: error.code ?? error.message }); }
  }
  try {
    await assertAgentProductionBuildFresh(root);
    if (databaseSmoke && !existsSync(resolve(root, 'apps/desktop/out/main/databaseUtilitySmoke.js'))) {
      throw new Error('databaseUtilitySmoke bundle missing');
    }
  } catch (error) { required.push({ script: 'build', reason: error.code ?? error.message }); }
  const npmCli = process.env.npm_execpath?.trim()
    || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const cancellation = createProcessCancellation();
  try {
    for (const { script, reason } of required) {
      console.log(JSON.stringify({ build: 'required', script, reason }));
      const build = await runProcess({
        command: process.execPath, args: [npmCli, 'run', script], cwd: root,
        env: { ...process.env, ...(databaseSmoke ? { SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE: '1' } : {}) },
        timeoutMs: readTimeoutMs('SOULFORGE_BUILD_TIMEOUT_MS', 20 * 60 * 1000),
        signal: cancellation.signal,
        onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk)
      });
      if (!processSucceeded(build)) throw new Error(`${script} failed: ${build.terminationReason ?? build.code}`);
    }
  } finally { cancellation.dispose(); }
  if (!databaseSmoke) await assertBridgeProductionBuildFresh(root);
  await assertAgentProductionBuildFresh(root);
  if (databaseSmoke && !existsSync(resolve(root, 'apps/desktop/out/main/databaseUtilitySmoke.js'))) {
    throw new Error('Build succeeded without required databaseUtilitySmoke bundle');
  }
  console.log(JSON.stringify({ ok: true, build: required.length ? 'rebuilt' : 'reused',
    scripts: required.map(({ script }) => script), evidence: 'source-and-output-sha256' }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--database-smoke')) throw new Error('Unknown build option');
  await ensureAgentProductionBuild({ databaseSmoke: args.includes('--database-smoke') });
}

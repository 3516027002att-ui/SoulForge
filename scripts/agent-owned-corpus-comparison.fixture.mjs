/**
 * Nonpaid old/new control comparison over verified, owned copies of one native
 * correctness fixture. NEXT is an external research oracle, never a product
 * dependency. Protocol completion is intentionally not the task verdict.
 *
 * Requires explicit SOULFORGE_NATIVE_FIXTURE_ROOT, SOULFORGE_COMPARISON_NEXT_ASSEMBLY
 * and SOULFORGE_COMPARISON_DOTNET (or DOTNET_ROOT). Missing inputs are unavailable.
 * Run the direct node:test entry with those pinned external research inputs:
 * node --import ./.local-validation/explicit-native-bridge-loader.mjs
 * scripts/agent-owned-corpus-comparison.fixture.mjs --control public-main-c4
 * The historical-217 default remains distinct and unavailable when its exact
 * source is missing. Explicit control selection reaches preparation and workers.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createOwnedNativeComparisonRuntime} from './testing/owned-native-agent-comparison.mjs';
import {selectLegacyAgentControlFromArguments,legacyAgentControlArguments} from './testing/legacy-agent-baseline.mjs';
const exec=promisify(execFile);
const control=selectLegacyAgentControlFromArguments(process.argv.slice(2));
const {ROOT,OUT,LEGACY,ORACLE_SHA,ORACLE_SOURCE,ORACLE_ASSEMBLY,BRIDGE,LOADER,TARGET,SCENARIOS,CONFIG,SAMPLING,LIMITS,hash,fileHash,save,dotnetEnv,treeInputs,prepare,worker}=createOwnedNativeComparisonRuntime({requireExternalLoader:true,control:control.id});
if (process.argv.includes('--owned-worker')) {
  const index = process.argv.indexOf('--owned-worker');
  await worker(process.argv[index + 1], process.argv[index + 2]);
} else if (process.argv.includes('--prepare-only')) {
  const ready = await prepare();
  await save(join(OUT, 'preparation.json'), ready);
  process.stdout.write(JSON.stringify({ status: ready.status, legacy: ready.legacy?.revision, target: TARGET }) + '\n');
} else {
  test('bounded legacy/finite native comparison uses owned pinned corpus and independent NEXT goals', { timeout: 1_200_000 }, async t => {
    const prepared = await prepare();
    await save(join(OUT, 'preparation.json'), prepared);
    if (prepared.status !== 'ready') {
      await save(join(OUT, 'comparison-report.json'), prepared);
      t.diagnostic(JSON.stringify(prepared)); t.skip('Native corpus/oracle/runtime unavailable; no passing claim'); return;
    }
    const inputs = ['packages/core/src', 'packages/core/dist', 'packages/shared/src', 'packages/shared/dist',
      'packages/agent/src', 'scripts/agent-owned-corpus-comparison.fixture.mjs','scripts/testing/legacy-agent-baseline.mjs','scripts/testing/owned-native-agent-comparison.mjs',
      '.local-validation/explicit-native-bridge-loader.mjs', '.local-validation/bridge-bin/Debug/net10.0/linux-x64',
      '.local-validation/native-comparison/legacy', '.local-validation/native-comparison/oracle/bin/Release/net10.0',
      'testdata/corpus/sekiro-1.6.corpus-manifest.json'];
    const artifactBefore = await treeInputs(inputs);
    const source = { commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim(),
      diff: (await exec('git', ['diff', '--binary', 'HEAD'], { cwd: ROOT, maxBuffer: 8_388_608 })).stdout };
    const pinnedBefore = { corpusSha256: await fileHash(prepared.source),
      oracleAssemblySha256: await fileHash(ORACLE_ASSEMBLY) };
    await save(join(OUT, 'artifact-before.json'), artifactBefore);
    await save(join(OUT, 'source-inputs.json'), { ...source, diffSha256: hash(source.diff),
      legacy: prepared.legacy, taskCorpus: prepared.fixture, nativeBridgeSha256: await fileHash(BRIDGE),
      oracleAssemblySha256: ORACLE_SHA, oracleSourceSha256: hash(ORACLE_SOURCE),
      taskAndPolicy: { scenarios: SCENARIOS, target: TARGET, config: CONFIG, sampling: SAMPLING, limits: LIMITS },
      responseScriptSha256: await fileHash(fileURLToPath(import.meta.url)) });
    const results = [], failures = [];
    for (const scenario of SCENARIOS) for (const kernel of ['legacy', 'finite']) {
      const dir = join(OUT, `${scenario.id}-${kernel}`);
      if (existsSync(dir)) await rename(dir, `${dir}.previous-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      try {
        const child = await exec(process.execPath, ['--import', LOADER, fileURLToPath(import.meta.url), ...legacyAgentControlArguments(control.id), '--owned-worker', kernel, scenario.id],
          { cwd: ROOT, env: { ...dotnetEnv(), SF_E2E_WORKSPACE_STORAGE_ROOT: join(dir, 'storage') },
            timeout: 240_000, maxBuffer: 4_194_304 });
        await writeFile(join(dir, 'worker.log'), child.stdout + child.stderr);
        results.push(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')));
      } catch (error) {
        await writeFile(join(dir, 'worker.log'), String(error.stack ?? error) + '\n' + (error.stdout ?? '') + (error.stderr ?? ''));
        failures.push({ scenario: scenario.id, kernel, error: String(error.message ?? error) });
      }
    }
    const artifactAfter = await treeInputs(inputs);
    await save(join(OUT, 'artifact-after.json'), artifactAfter);
    const sourceAfter = { commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim(),
      diff: (await exec('git', ['diff', '--binary', 'HEAD'], { cwd: ROOT, maxBuffer: 8_388_608 })).stdout };
    const pinnedAfter = { corpusSha256: await fileHash(prepared.source),
      oracleAssemblySha256: await fileHash(ORACLE_ASSEMBLY) };
    await save(join(OUT, 'source-after.json'), { ...sourceAfter, diffSha256: hash(sourceAfter.diff), pinnedAfter });
    const checks = [];
    for (const scenario of SCENARIOS) {
      const pair = results.filter(r => r.scenario === scenario.id);
      const expectedStatus = scenario.id === 'false-model-success' ? 'failed' : 'passed';
      const transports = await Promise.all(pair.map(r => readFile(join(OUT, `${r.scenario}-${r.kernel}`, 'transport-inputs.json'), 'utf8').then(JSON.parse)));
      checks.push({ scenario: scenario.id, bothPresent: pair.length === 2,
        independentGoalCorrect: pair.length === 2 && pair.every(r => r.goal.status === expectedStatus),
        preservation: pair.length === 2 && pair.every(r => Object.values(r.preservation).every(Boolean)),
        sameResponses: pair.length === 2 && pair[0].transport.responseSha256 === pair[1].transport.responseSha256,
        sameInitialTaskToolsSampling: transports.length === 2 && ['task','config','sampling','limits'].every(k => JSON.stringify(transports[0][k]) === JSON.stringify(transports[1][k]))
          && JSON.stringify(transports[0].modelRequests[0]) === JSON.stringify(transports[1].modelRequests[0]),
        writes: pair.length === 2 && pair.every(r => scenario.mutation
          ? r.operations.length === 1 && r.operations[0].status === 'committed' && r.byteHashes.before !== r.byteHashes.after
            && r.approvals.length === 1 && r.toolResults.find(x => x.call.name === 'apply_emevd_dsl')?.result.ok === true
            && r.backupFacts.length === 1 && r.backupFacts.every(b => b.backupMatchesBefore && b.targetMatchesAfter)
            && r.transactionJournal.length === 1 && r.transactionJournal[0].phase === 'committed'
          : r.operations.length === 0 && r.byteHashes.before === r.byteHashes.after),
        falseModelSuccessSeparated: scenario.id !== 'false-model-success' || pair.length === 2
          && pair.every(r => r.protocolTermination.finishReason === 'stop' && r.goal.status === 'failed') });
    }
    const stable = artifactBefore.sha256 === artifactAfter.sha256;
    const sourceStable = source.commit === sourceAfter.commit && source.diff === sourceAfter.diff;
    const pinnedStable = JSON.stringify(pinnedBefore) === JSON.stringify(pinnedAfter)
      && pinnedAfter.corpusSha256 === prepared.fixture.sha256 && pinnedAfter.oracleAssemblySha256 === ORACLE_SHA;
    const passed = stable && sourceStable && pinnedStable && failures.length === 0
      && checks.every(c => Object.entries(c).filter(([k]) => k !== 'scenario').every(([,v]) => v === true));
    const report = { schema: 'owned-native-agent-comparison-v1', status: passed ? 'passed' : 'failed',
      baselineRevision: LEGACY, baselineControl: control, sourceCommit: source.commit, builtArtifactStable: stable,
      sourceStable, pinnedInputsStable: pinnedStable, pinnedBefore, pinnedAfter,
      sourceDiffSha256: hash(source.diff), sourceAfterDiffSha256: hash(sourceAfter.diff),
      builtArtifactSha256: artifactBefore.sha256, corpus: prepared.fixture, target: TARGET,
      independentOracle: prepared.before.oracle, checks, failures,
      results: results.map(r => ({ kernel: r.kernel, scenario: r.scenario, goal: r.goal,
        protocolTermination: r.protocolTermination, operations: r.operations.map(o => ({ opId: o.opId, status: o.status })),
        preservation: r.preservation, durationMs: r.durationMs, peakRssKiB: r.peakRssKiB,
        byteHashes: r.byteHashes, transport: r.transport })),
      limits: ['Deterministic transport establishes native and control boundaries, not real-model success rates',
        'One pinned transferred common EMEVD, not the unavailable historical whole-corpus set',
        'Rest-behavior typed mutation only; no instruction changes, game loading, or runtime claims',
        'NEXT execution is independent; shared upstream format knowledge is not independent format discovery',
        'No real provider, external network, paid call, vendor codec, or GPL product dependency'] };
    await save(join(OUT, 'comparison-report.json'), report);
    t.diagnostic(JSON.stringify({ status: report.status, builtArtifactStable: stable,
      sourceStable, pinnedInputsStable: pinnedStable, checks, failures }));
    assert.equal(passed, true, 'See .local-validation/native-comparison/comparison-report.json and individual worker logs');
  });
}

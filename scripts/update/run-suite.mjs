import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processSucceeded, readTimeoutMs, runProcess } from '../subprocess-control.mjs';
import { writeReport, assertRequiredCasesPassed } from './report.mjs';
import { REQUIRED_RUNTIME_CASES } from './runtime-process.mjs';

const SUITES = new Set(['unit', 'integration', 'installed', 'all']);
const REPOSITORY_ROOT = resolve(process.cwd());
const OUTPUT_ROOT = join(REPOSITORY_ROOT, 'output', 'update');

const SUITE_CASES = Object.freeze({
  unit: [{
    id: 'report-contract',
    evidenceLevel: 'unit-production',
    entrypoint: 'scripts/update/report.mjs',
    command: [process.execPath, '--test', 'scripts/update/report.test.mjs']
  }, {
    id: 'baseline-scanner',
    evidenceLevel: 'unit-production',
    entrypoint: 'scripts/update/inspect-baseline.mjs',
    command: [process.execPath, '--test', 'scripts/update/inspect-baseline.test.mjs']
  }, {
    id: 'github-release-update-core',
    evidenceLevel: 'unit-production',
    entrypoint: 'apps/desktop/src/main/update/update.test.ts',
    command: [process.execPath, 'scripts/update/run-core-tests.mjs']
  }],
  integration: [{
    id: 'runtime-switch',
    evidenceLevel: 'process-integration',
    entrypoint: 'scripts/update/runtime-process.mjs',
    command: [process.execPath, 'scripts/update/runtime-process.mjs'],
    probe: true,
    requiredIds: REQUIRED_RUNTIME_CASES
  }],
  installed: [{
    id: 'installer-a-to-b',
    evidenceLevel: 'installed-e2e',
    entrypoint: 'scripts/update/installed-a-to-b.mjs',
    command: [process.execPath, 'scripts/update/installed-a-to-b.mjs', '--probe-input'],
    probe: true,
    requiredIds: ['installer-a-to-b']
  }]
});

export async function runSuite(suite, { repositoryRoot = REPOSITORY_ROOT, outputRoot = OUTPUT_ROOT,
  installedConfigPath = process.env.SOULFORGE_UPDATE_INSTALLED_MANIFEST } = {}) {
  if (!SUITES.has(suite)) throw new Error(`Unknown update suite: ${suite}`);
  if (suite === 'all') return runAllSuites({ repositoryRoot, outputRoot, installedConfigPath });

  const headSha = await readHeadWithGit(repositoryRoot);
  const timeoutMs = readTimeoutMs('SOULFORGE_UPDATE_TEST_TIMEOUT_MS', suite === 'installed' ? 30 * 60_000 : 120_000);
  const reportCommands = [];
  const cases = [];
  const artifacts = [];
  const blockers = [];
  const untestedClaims = [];
  const suiteRoot = join(outputRoot, suite);
  await mkdir(join(suiteRoot, 'commands'), { recursive: true });

  for (const specification of SUITE_CASES[suite]) {
    if (!specification.command) {
      cases.push({
        id: specification.id,
        status: 'not_run',
        executed: false,
        evidenceLevel: specification.evidenceLevel,
        assertions: [],
        evidenceFiles: [],
        diagnostics: [specification.blocker]
      });
      blockers.push(specification.blocker);
      continue;
    }
    const command = [...specification.command];
    let expected;
    if (specification.probe) {
      const runId = randomUUID(), evidenceRoot = join(suiteRoot, 'runs', runId);
      await mkdir(evidenceRoot, { recursive: true });
      const inputPath = join(evidenceRoot, 'input.json');
      expected = { runId, headSha, evidenceRoot, requiredIds: specification.requiredIds,
        entrypointSha256: await hashFile(join(repositoryRoot, specification.entrypoint)) };
      await writeFile(inputPath, JSON.stringify({ repositoryRoot, evidenceRoot, runId, headSha, installedConfigPath }), 'utf8');
      command.push(inputPath);
    }
    const result = await runProcess({
      command: command[0],
      args: command.slice(1),
      cwd: repositoryRoot,
      timeoutMs
    });
    const stdoutArtifact = await persistOutput(repositoryRoot, suiteRoot, specification.id, 'stdout', result.stdout);
    const stderrArtifact = await persistOutput(repositoryRoot, suiteRoot, specification.id, 'stderr', result.stderr);
    artifacts.push(stdoutArtifact, stderrArtifact);
    reportCommands.push({
      argv: displayArgv(command),
      cwdLabel: 'repository',
      exitCode: result.code,
      stdoutArtifact: stdoutArtifact.relativePath,
      stderrArtifact: stderrArtifact.relativePath,
      status: processSucceeded(result) ? 'executed' : (result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : 'failed'),
      timedOut: result.timedOut,
      cancelled: result.cancelled
    });
    if (specification.probe) {
      try {
        const probe = JSON.parse(await readFile(join(expected.evidenceRoot, 'probe.json'), 'utf8'));
        await validateProbeReport(probe, expected);
        if (result.timedOut || result.cancelled || (probe.status === 'passed' ? result.code !== 0 : result.code !== 1)) {
          throw new Error('Probe exit status does not match its actual report.');
        }
        const mapPath = path => relative(repositoryRoot, join(expected.evidenceRoot, path)).replaceAll('\\', '/');
        cases.push(...probe.cases.map(entry => ({ ...entry, evidenceFiles: entry.evidenceFiles.map(mapPath) })));
        artifacts.push(...probe.artifacts.map(entry => ({ ...entry, relativePath: mapPath(entry.relativePath) })));
        reportCommands.push(...probe.commands.map(entry => ({ ...entry,
          stdoutArtifact: entry.stdoutArtifact ? mapPath(entry.stdoutArtifact) : null,
          stderrArtifact: entry.stderrArtifact ? mapPath(entry.stderrArtifact) : null })));
        const probeArtifact = await persistOutput(repositoryRoot, suiteRoot, specification.id, 'probe', JSON.stringify(probe, null, 2));
        artifacts.push(probeArtifact);
        blockers.push(...(probe.blockers ?? [])); untestedClaims.push(...(probe.untestedClaims ?? []));
      } catch (error) {
        const message = `Actual ${specification.id} evidence rejected: ${error.message}`;
        cases.push({ id: specification.id, status: 'failed', executed: true, evidenceLevel: specification.evidenceLevel,
          assertions: [], evidenceFiles: [stdoutArtifact.relativePath, stderrArtifact.relativePath], diagnostics: [message] });
        blockers.push(message);
      }
      continue;
    }
    const passed = processSucceeded(result);
    cases.push({
      id: specification.id,
      status: passed ? 'passed' : 'failed',
      executed: true,
      evidenceLevel: specification.evidenceLevel,
      assertions: passed ? ['the declared production test entrypoint exited with code 0'] : [],
      evidenceFiles: [stdoutArtifact.relativePath, stderrArtifact.relativePath],
      diagnostics: passed ? [] : [`subprocess exit=${String(result.code)}${result.terminationReason ? ` reason=${result.terminationReason}` : ''}`]
    });
    if (!passed) blockers.push(`Case ${specification.id} did not execute successfully.`);
  }

  const status = cases.some(entry => entry.status === 'failed')
    ? 'failed'
    : cases.some(entry => entry.status === 'blocked')
      ? 'blocked_environment'
    : cases.some(entry => entry.status !== 'passed')
      ? 'not_run'
      : 'passed';
  const firstEntrypoint = SUITE_CASES[suite].find(entry => entry.entrypoint)?.entrypoint ?? null;
  const report = await writeReport({
    suite,
    status,
    headSha,
    evidenceLevel: suite === 'installed' ? 'installed-e2e' : suite === 'integration' ? 'process-integration' : 'unit-production',
    entrypoint: firstEntrypoint,
    entrypointSha256: firstEntrypoint ? await hashFile(join(repositoryRoot, firstEntrypoint)) : null,
    commands: reportCommands,
    cases,
    artifacts,
    blockers,
    untestedClaims: suite === 'unit' ? ['Windows installation', 'native writeback', 'runtime process integration'] : [...new Set(untestedClaims)],
    frontendChanged: false,
    published: false
  }, { outputRoot });
  return report;
}

async function runAllSuites({ repositoryRoot, outputRoot, installedConfigPath }) {
  const reports = [];
  for (const suite of ['unit', 'integration', 'installed']) reports.push(await runSuite(suite, { repositoryRoot, outputRoot, installedConfigPath }));
  const cases = reports.flatMap(report => report.cases.map(entry => ({ ...entry, id: `${report.suite}.${entry.id}` })));
  const commands = reports.flatMap(report => report.commands);
  const artifacts = reports.flatMap(report => report.artifacts);
  const blockers = reports.flatMap(report => report.blockers);
  const status = reports.some(report => report.status === 'failed')
    ? 'failed'
    : reports.every(report => report.status === 'passed')
      ? 'passed'
      : reports.some(report => report.status === 'blocked_environment') ? 'blocked_environment' : 'not_run';
  return writeReport({
    suite: 'all',
    status,
    headSha: reports.find(report => report.headSha)?.headSha ?? null,
    evidenceLevel: 'unit-production',
    entrypoint: null,
    commands,
    cases,
    artifacts,
    blockers,
    untestedClaims: [...new Set(reports.flatMap(report => report.untestedClaims))],
    frontendChanged: false,
    published: false
  }, { outputRoot });
}

/** A zero exit code cannot substitute for fresh, executed, hash-bound evidence. */
export async function validateProbeReport(report, expected) {
  if (!report || report.runId !== expected.runId || report.headSha !== expected.headSha
    || report.entrypointSha256 !== expected.entrypointSha256 || !expected.entrypointSha256) {
    throw new Error('Probe binding does not match this run/HEAD/entrypoint.');
  }
  if (!['passed', 'failed', 'blocked_environment'].includes(report.status) || !Array.isArray(report.cases) || !report.cases.length
    || !Array.isArray(report.artifacts) || !Array.isArray(report.commands)) throw new Error('Probe report shape is invalid.');
  if (report.status === 'passed') {
    if (!report.commands.length) throw new Error('Passed probe has no executed command.');
    assertRequiredCasesPassed(report, expected.requiredIds);
    if (!report.artifacts.length) throw new Error('Passed probe has no concrete evidence.');
  } else if (report.status === 'blocked_environment' && !report.cases.every(entry => entry.status === 'blocked' && entry.executed === false)) {
    throw new Error('Blocked probe cannot claim execution.');
  }
  const artifacts = new Set();
  const canonicalRoot = await realpath(expected.evidenceRoot);
  for (const artifact of report.artifacts) {
    const name = artifact.relativePath;
    if (typeof name !== 'string' || isAbsolute(name) || name.includes('\0') || name.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Probe evidence path escapes its owned root.');
    const path = join(expected.evidenceRoot, name), stat = await lstat(path);
    const location = relative(canonicalRoot, await realpath(path));
    if (!stat.isFile() || stat.isSymbolicLink() || isAbsolute(location) || location === '..' || location.startsWith('..\\') || location.startsWith('../')) throw new Error('Probe evidence is not an owned regular file.');
    const bytes = await readFile(path);
    if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Probe evidence hash does not match actual bytes.');
    artifacts.add(name);
  }
  if (report.status === 'passed') for (const entry of report.cases) {
    if (!entry.assertions?.length || !entry.evidenceFiles?.length || entry.evidenceFiles.some(name => !artifacts.has(name))) throw new Error('Passed case has no bound assertions/evidence.');
  }
}

async function readHeadWithGit(repositoryRoot) {
  const result = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: repositoryRoot, timeoutMs: 10_000 });
  return processSucceeded(result) ? result.stdout.trim() : null;
}

async function persistOutput(repositoryRoot, suiteRoot, caseId, stream, value) {
  const fileName = `${caseId}.${stream}.txt`;
  const absolutePath = join(suiteRoot, 'commands', fileName);
  await writeFile(absolutePath, value ?? '', 'utf8');
  const bytes = Buffer.byteLength(value ?? '', 'utf8');
  const sha256 = createHash('sha256').update(value ?? '', 'utf8').digest('hex');
  return {
    relativePath: relative(repositoryRoot, absolutePath).replaceAll('\\', '/'),
    bytes,
    sha256
  };
}

async function hashFile(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

function displayArgv(argv) {
  return argv.map(value => value === process.execPath ? 'node' : value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const suite = process.argv[2];
  if (!suite || !SUITES.has(suite)) {
    process.stderr.write('Usage: node scripts/update/run-suite.mjs <unit|integration|installed|all>\n');
    process.exitCode = 2;
  } else {
    runSuite(suite).then(report => {
      process.stdout.write(`${JSON.stringify({ suite: report.suite, status: report.status, report: `output/update/${report.suite}/report.json` }, null, 2)}\n`);
      if (report.status !== 'passed') process.exitCode = 1;
    }).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}

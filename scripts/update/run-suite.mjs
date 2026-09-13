import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processSucceeded, readTimeoutMs, runProcess } from '../subprocess-control.mjs';
import { writeReport } from './report.mjs';

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
  }],
  integration: [{
    id: 'runtime-switch',
    evidenceLevel: 'process-integration',
    entrypoint: null,
    command: null,
    blocker: 'U02-U24 runtime process boundary is not implemented in this first U00-U01 round.'
  }],
  installed: [{
    id: 'installer-a-to-b',
    evidenceLevel: 'installed-e2e',
    entrypoint: null,
    command: null,
    blocker: 'U08-U11 Windows A-to-B installer evidence is not implemented in this first U00-U01 round.'
  }]
});

export async function runSuite(suite, { repositoryRoot = REPOSITORY_ROOT, outputRoot = OUTPUT_ROOT } = {}) {
  if (!SUITES.has(suite)) throw new Error(`Unknown update suite: ${suite}`);
  if (suite === 'all') return runAllSuites({ repositoryRoot, outputRoot });

  const headSha = await readHeadWithGit(repositoryRoot);
  const timeoutMs = readTimeoutMs('SOULFORGE_UPDATE_TEST_TIMEOUT_MS', 120_000);
  const reportCommands = [];
  const cases = [];
  const artifacts = [];
  const blockers = [];
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
    const result = await runProcess({
      command: specification.command[0],
      args: specification.command.slice(1),
      cwd: repositoryRoot,
      timeoutMs
    });
    const stdoutArtifact = await persistOutput(repositoryRoot, suiteRoot, specification.id, 'stdout', result.stdout);
    const stderrArtifact = await persistOutput(repositoryRoot, suiteRoot, specification.id, 'stderr', result.stderr);
    artifacts.push(stdoutArtifact, stderrArtifact);
    reportCommands.push({
      argv: displayArgv(specification.command),
      cwdLabel: 'repository',
      exitCode: result.code,
      stdoutArtifact: stdoutArtifact.relativePath,
      stderrArtifact: stderrArtifact.relativePath,
      status: processSucceeded(result) ? 'executed' : (result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : 'failed'),
      timedOut: result.timedOut,
      cancelled: result.cancelled
    });
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
    untestedClaims: suite === 'unit' ? ['Windows installation', 'native writeback', 'runtime switch'] : ['production update path'],
    frontendChanged: false,
    published: false
  }, { outputRoot });
  return report;
}

async function runAllSuites({ repositoryRoot, outputRoot }) {
  const reports = [];
  for (const suite of ['unit', 'integration', 'installed']) reports.push(await runSuite(suite, { repositoryRoot, outputRoot }));
  const cases = reports.flatMap(report => report.cases.map(entry => ({ ...entry, id: `${report.suite}.${entry.id}` })));
  const commands = reports.flatMap(report => report.commands);
  const artifacts = reports.flatMap(report => report.artifacts);
  const blockers = reports.flatMap(report => report.blockers);
  const status = reports.some(report => report.status === 'failed')
    ? 'failed'
    : reports.every(report => report.status === 'passed')
      ? 'passed'
      : 'not_run';
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
    untestedClaims: ['Windows installation', 'native writeback', 'runtime switch'],
    frontendChanged: false,
    published: false
  }, { outputRoot });
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

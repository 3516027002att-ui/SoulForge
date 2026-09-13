import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertRequiredCasesPassed,
  ReportValidationError,
  writeReport
} from './report.mjs';

const command = (overrides = {}) => ({
  argv: ['node', 'fixture.mjs'],
  cwdLabel: 'repository',
  exitCode: 0,
  stdoutArtifact: null,
  stderrArtifact: null,
  status: 'executed',
  ...overrides
});

const productCase = (id, evidenceLevel = 'unit-production') => ({
  id,
  status: 'passed',
  executed: true,
  evidenceLevel,
  assertions: ['production entrypoint was executed'],
  evidenceFiles: []
});

async function outputRoot() {
  return mkdtemp(join(tmpdir(), 'soulforge-update-report-'));
}

test('exit 0 的 preflight-skip 不能被写成 passed', async () => {
  const root = await outputRoot();
  try {
    await assert.rejects(
      writeReport({
        suite: 'installed',
        status: 'passed',
        headSha: 'a'.repeat(40),
        commands: [command({ status: 'preflight-skip' })],
        cases: [productCase('installer-a-to-b', 'installed-e2e')],
        artifacts: []
      }, { outputRoot: root }),
      error => error instanceof ReportValidationError && error.code === 'REPORT_PREFLIGHT_SKIPPED'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required case 缺项时门禁失败', () => {
  assert.throws(
    () => assertRequiredCasesPassed({
      suite: 'unit',
      status: 'passed',
      evidenceLevel: 'unit-production',
      cases: [productCase('present')],
      commands: [],
      artifacts: []
    }, ['present', 'missing']),
    error => error instanceof ReportValidationError && error.code === 'REPORT_REQUIRED_CASE_MISSING'
  );
});

test('reference-only 报告不能冒充 installed-e2e', async () => {
  const root = await outputRoot();
  try {
    await assert.rejects(
      writeReport({
        suite: 'installed',
        status: 'passed',
        headSha: 'b'.repeat(40),
        evidenceLevel: 'reference-only',
        commands: [command()],
        cases: [productCase('installer-a-to-b', 'reference-only')],
        artifacts: []
      }, { outputRoot: root }),
      error => error instanceof ReportValidationError && error.code === 'REPORT_REFERENCE_NOT_INSTALLED'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('失败 subprocess 不能进入 passed', async () => {
  const root = await outputRoot();
  try {
    await assert.rejects(
      writeReport({
        suite: 'unit',
        status: 'passed',
        headSha: 'c'.repeat(40),
        commands: [command({ exitCode: 1, status: 'failed' })],
        cases: [productCase('report-contract')],
        artifacts: []
      }, { outputRoot: root }),
      error => error instanceof ReportValidationError && error.code === 'REPORT_SUBPROCESS_FAILED'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('合法报告写入带 schema 和实际执行信息', async () => {
  const root = await outputRoot();
  try {
    const report = await writeReport({
      suite: 'unit',
      status: 'passed',
      headSha: 'd'.repeat(40),
      commands: [command()],
      cases: [productCase('report-contract')],
      artifacts: []
    }, { outputRoot: root });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.executed, true);
    assert.equal(report.evidenceLevel, 'unit-production');
    assert.match(await readFile(join(root, 'unit', 'report.json'), 'utf8'), /report-contract/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

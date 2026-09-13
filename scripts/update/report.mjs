import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const REPORT_STATUSES = Object.freeze([
  'passed',
  'failed',
  'blocked_environment',
  'blocked_design',
  'not_run'
]);

export const CASE_STATUSES = Object.freeze(['passed', 'failed', 'blocked', 'not_run']);
export const EVIDENCE_LEVELS = Object.freeze([
  'source-inspection',
  'reference-only',
  'unit-production',
  'process-integration',
  'installed-e2e',
  'native-acceptance'
]);

export class ReportValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReportValidationError';
    this.code = code;
    this.details = details;
  }
}

export async function writeReport(input, { outputRoot = join(process.cwd(), 'output', 'update') } = {}) {
  const report = buildReport(input);
  if (report.status === 'passed') validatePassedReport(report);
  const suiteRoot = resolve(outputRoot, report.suite);
  await mkdir(suiteRoot, { recursive: true });
  const reportPath = join(suiteRoot, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { ...report, reportPath };
}

export function buildReport(input) {
  if (!input || typeof input !== 'object') {
    throw new ReportValidationError('REPORT_INPUT_INVALID', 'Report input must be an object.');
  }
  const suite = requireNonEmptyString(input.suite, 'suite');
  const status = requireEnum(input.status, REPORT_STATUSES, 'status');
  const evidenceLevel = input.evidenceLevel ?? defaultEvidenceLevel(suite);
  requireEnum(evidenceLevel, EVIDENCE_LEVELS, 'evidenceLevel');
  const commands = normalizeCommands(input.commands ?? []);
  const cases = normalizeCases(input.cases ?? []);
  const artifacts = normalizeArtifacts(input.artifacts ?? []);
  const now = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    suite,
    status,
    headSha: normalizeNullableString(input.headSha, 'headSha'),
    evidenceLevel,
    executed: status !== 'not_run',
    entrypoint: normalizeNullableRelative(input.entrypoint, 'entrypoint'),
    entrypointSha256: normalizeNullableHash(input.entrypointSha256, 'entrypointSha256'),
    platform: process.platform,
    commands,
    startedAt: requireIsoTimestamp(input.startedAt ?? now, 'startedAt'),
    finishedAt: requireIsoTimestamp(input.finishedAt ?? now, 'finishedAt'),
    cases,
    artifacts,
    blockers: normalizeStringArray(input.blockers ?? [], 'blockers'),
    untestedClaims: normalizeStringArray(input.untestedClaims ?? [], 'untestedClaims'),
    frontendChanged: input.frontendChanged === true,
    published: input.published === true
  };
  if (report.status === 'passed' && report.cases.length === 0) {
    throw new ReportValidationError('REPORT_CASES_MISSING', 'A passed report must contain at least one case.');
  }
  if (report.status === 'passed' && report.commands.length === 0) {
    throw new ReportValidationError('REPORT_COMMANDS_MISSING', 'A passed report must contain executed commands.');
  }
  if (report.frontendChanged) {
    throw new ReportValidationError('REPORT_FRONTEND_OUT_OF_SCOPE', 'The update施工卡 must not report frontend changes.');
  }
  if (report.published) {
    throw new ReportValidationError('REPORT_PUBLISH_FORBIDDEN', 'U00-U01 cannot publish a release or update channel.');
  }
  return report;
}

export function assertRequiredCasesPassed(report, requiredIds) {
  if (!report || typeof report !== 'object') {
    throw new ReportValidationError('REPORT_INPUT_INVALID', 'Report must be an object.');
  }
  if (!Array.isArray(requiredIds) || requiredIds.length === 0) {
    throw new ReportValidationError('REPORT_REQUIRED_CASES_INVALID', 'requiredIds must be a non-empty array.');
  }
  validatePassedReport(report);
  const cases = new Map(Array.isArray(report.cases) ? report.cases.map(entry => [entry.id, entry]) : []);
  for (const id of requiredIds) {
    if (!cases.has(id)) {
      throw new ReportValidationError('REPORT_REQUIRED_CASE_MISSING', `Required case is missing: ${id}`, { id });
    }
    const entry = cases.get(id);
    if (entry.status !== 'passed' || entry.executed !== true) {
      throw new ReportValidationError('REPORT_REQUIRED_CASE_NOT_PASSED', `Required case did not pass: ${id}`, { id });
    }
  }
  return true;
}

function validatePassedReport(report) {
  if (report.status !== 'passed') {
    throw new ReportValidationError('REPORT_STATUS_NOT_PASSED', `Report status is ${String(report.status)}.`);
  }
  if (report.suite === 'installed' && (report.evidenceLevel === 'reference-only' || report.cases.some(entry => entry.evidenceLevel === 'reference-only'))) {
    throw new ReportValidationError('REPORT_REFERENCE_NOT_INSTALLED', 'Reference-only evidence cannot satisfy installed-e2e.');
  }
  for (const command of report.commands ?? []) {
    if (command.status === 'preflight-skip') {
      throw new ReportValidationError('REPORT_PREFLIGHT_SKIPPED', 'A preflight skip cannot enter a passed report.');
    }
    if (command.exitCode !== 0 || command.timedOut === true || command.cancelled === true || command.status !== 'executed') {
      throw new ReportValidationError('REPORT_SUBPROCESS_FAILED', 'A subprocess did not execute successfully.', { command });
    }
  }
  for (const entry of report.cases ?? []) {
    if (entry.status !== 'passed' || entry.executed !== true) {
      throw new ReportValidationError('REPORT_CASE_NOT_EXECUTED', `Case is not an executed pass: ${entry.id}`, { id: entry.id });
    }
    if (report.suite === 'installed' && entry.evidenceLevel !== 'installed-e2e' && entry.evidenceLevel !== 'native-acceptance') {
      throw new ReportValidationError('REPORT_EVIDENCE_LEVEL_TOO_LOW', `Installed case has insufficient evidence: ${entry.id}`, { id: entry.id });
    }
  }
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) throw new ReportValidationError('REPORT_COMMANDS_INVALID', 'commands must be an array.');
  return commands.map((command, index) => {
    if (!command || typeof command !== 'object' || !Array.isArray(command.argv)) {
      throw new ReportValidationError('REPORT_COMMAND_INVALID', `Command ${index} must contain an argv array.`);
    }
    return {
      argv: command.argv.map(value => requireNonEmptyString(value, `commands[${index}].argv`)),
      cwdLabel: requireNonEmptyString(command.cwdLabel ?? 'repository', `commands[${index}].cwdLabel`),
      exitCode: Number.isInteger(command.exitCode) ? command.exitCode : null,
      stdoutArtifact: normalizeNullableRelative(command.stdoutArtifact, `commands[${index}].stdoutArtifact`),
      stderrArtifact: normalizeNullableRelative(command.stderrArtifact, `commands[${index}].stderrArtifact`),
      status: requireNonEmptyString(command.status ?? (command.exitCode === 0 ? 'executed' : 'failed'), `commands[${index}].status`),
      timedOut: command.timedOut === true,
      cancelled: command.cancelled === true
    };
  });
}

function normalizeCases(cases) {
  if (!Array.isArray(cases)) throw new ReportValidationError('REPORT_CASES_INVALID', 'cases must be an array.');
  return cases.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new ReportValidationError('REPORT_CASE_INVALID', `Case ${index} must be an object.`);
    return {
      id: requireNonEmptyString(entry.id, `cases[${index}].id`),
      status: requireEnum(entry.status, CASE_STATUSES, `cases[${index}].status`),
      executed: entry.executed === true,
      evidenceLevel: requireEnum(entry.evidenceLevel ?? 'unit-production', EVIDENCE_LEVELS, `cases[${index}].evidenceLevel`),
      assertions: normalizeStringArray(entry.assertions ?? [], `cases[${index}].assertions`),
      evidenceFiles: normalizeRelativeArray(entry.evidenceFiles ?? [], `cases[${index}].evidenceFiles`),
      diagnostics: normalizeStringArray(entry.diagnostics ?? [], `cases[${index}].diagnostics`)
    };
  });
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new ReportValidationError('REPORT_ARTIFACTS_INVALID', 'artifacts must be an array.');
  return artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') throw new ReportValidationError('REPORT_ARTIFACT_INVALID', `Artifact ${index} must be an object.`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new ReportValidationError('REPORT_ARTIFACT_BYTES_INVALID', `Artifact ${index} has invalid bytes.`);
    return {
      relativePath: requireRelativePath(artifact.relativePath, `artifacts[${index}].relativePath`),
      bytes: artifact.bytes,
      sha256: requireHash(artifact.sha256, `artifacts[${index}].sha256`)
    };
  });
}

function defaultEvidenceLevel(suite) {
  if (suite === 'installed') return 'installed-e2e';
  if (suite === 'integration') return 'process-integration';
  return 'unit-production';
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new ReportValidationError('REPORT_ENUM_INVALID', `${field} is not allowed: ${String(value)}`);
  return value;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ReportValidationError('REPORT_STRING_INVALID', `${field} must be a non-empty string.`);
  return value;
}

function normalizeNullableString(value, field) {
  if (value === null || value === undefined) return null;
  return requireNonEmptyString(value, field);
}

function requireIsoTimestamp(value, field) {
  const text = requireNonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new ReportValidationError('REPORT_TIMESTAMP_INVALID', `${field} must be an ISO timestamp.`);
  return text;
}

function normalizeNullableHash(value, field) {
  if (value === null || value === undefined) return null;
  return requireHash(value, field);
}

function requireHash(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new ReportValidationError('REPORT_HASH_INVALID', `${field} must be a lowercase SHA-256 hash.`);
  return value;
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) throw new ReportValidationError('REPORT_ARRAY_INVALID', `${field} must be an array.`);
  return value.map(item => requireNonEmptyString(item, field));
}

function normalizeRelativeArray(value, field) {
  if (!Array.isArray(value)) throw new ReportValidationError('REPORT_ARRAY_INVALID', `${field} must be an array.`);
  return value.map((item, index) => requireRelativePath(item, `${field}[${index}]`));
}

function normalizeNullableRelative(value, field) {
  if (value === null || value === undefined) return null;
  return requireRelativePath(value, field);
}

function requireRelativePath(value, field) {
  const text = requireNonEmptyString(value, field).replaceAll('\\', '/');
  if (isAbsolute(text) || text.startsWith('/') || text.split('/').includes('..') || text.includes('\0')) {
    throw new ReportValidationError('REPORT_PATH_INVALID', `${field} must be a relative report path.`);
  }
  return text;
}

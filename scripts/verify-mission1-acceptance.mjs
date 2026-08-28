#!/usr/bin/env node
/**
 * Mission1 acceptance runner, A0 trust-root implementation.
 *
 * A0 is deliberately fail-closed. It does not promote product code, source
 * strings, old logs, placeholder corpus data, or a non-zero child into PASS.
 * Later product assertions can be added to the fixed registry, but they must
 * not bypass this stage.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = join(ROOT, 'output', 'mission1-evidence');
const CURRENT_STATE_PATH = join(OUTPUT_ROOT, 'current-state.json');
const CORPUS_PATH = join(ROOT, 'testdata', 'corpus', 'mission1-sekiro-acceptance.manifest.json');
const NEGATIVE_FIXTURE_PATH = join(ROOT, 'testdata', 'mission1', 'runner-negative-fixtures.v1.json');
const BRIDGE_EXE = join(
  ROOT,
  'bridge',
  'SoulForge.Bridge',
  'bin',
  'Release',
  'net10.0',
  'win-x64',
  'publish',
  'SoulForge.Bridge.exe'
);
const RUNNER_RELATIVE_PATH = 'scripts/verify-mission1-acceptance.mjs';
const APPROVAL_ROOT = join(OUTPUT_ROOT, 'approvals');
const REVIEW_ROOT = join(OUTPUT_ROOT, 'independent-review');
const EXACT_DIRTY_APPROVAL =
  '授权你继承当前冻结 dirty worktree，并按 mission1 继续修改产品代码。';
const GATE_IDS = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
const ALLOWED_NEGATIVE_CODES = new Set([
  'ARTIFACT_HASH_MISMATCH',
  'CHILD_RESULT_INCOMPLETE',
  'SOURCE_CHANGED_DURING_RUN',
  'BRIDGE_IDENTITY_MISMATCH',
  'CORPUS_IDENTITY_CHANGED',
  'STATE_ARTIFACT_MISSING',
  'UI_ARTIFACT_MISSING',
  'CHILD_EXIT_NONZERO'
]);
const FORBIDDEN_OVERRIDES = new Set([
  '--pass',
  '--ignore-unmapped',
  '--accept-old-schema',
  '--allow-failure',
  '--force-pass'
]);

const ASSERTION_REGISTRY = [
  [10, 'A0', null, 'A0.snapshot-negative-fixtures', 'FIX_SOURCE_SNAPSHOT_TRUST'],
  [20, 'A0', null, 'A0.artifact-replay-fixtures', 'FIX_ARTIFACT_REPLAY_GUARD'],
  [30, 'A0', null, 'A0.child-exit-and-typed-artifact', 'FIX_RUNNER_FAIL_CLOSED'],
  [40, 'A0', null, 'A0.state-atomicity', 'FIX_STATE_ATOMICITY'],
  [50, 'A0', null, 'A0.stage-input-resume', 'FIX_STAGE_INPUT_REGISTRY'],
  [60, 'A0', null, 'A0.independent-attack-review', 'REQUEST_INDEPENDENT_RUNNER_REVIEW'],
  [110, 'A1', 'G1', 'G1.diff-check', 'FIX_DIFF_CHECK'],
  [120, 'A1', 'G1', 'G1.typecheck', 'FIX_TYPECHECK'],
  [130, 'A1', 'G1', 'G1.bridge-build', 'FIX_BRIDGE_BUILD'],
  [140, 'A1', 'G1', 'G1.renderer-build', 'FIX_RENDERER_BUILD'],
  [210, 'A2', null, 'A2.corpus-independent-verifier', 'FIX_CORPUS_TRUST'],
  [220, 'A2', null, 'A2.native-rule-registries', 'FIX_NATIVE_RULE_REGISTRIES'],
  [230, 'A2', null, 'A2.performance-plan', 'FIX_ACCEPTANCE_PLAN'],
  [240, 'A2', null, 'A2.independent-attack-review', 'REQUEST_INDEPENDENT_INPUT_REVIEW'],
  [310, 'B', 'G3', 'G3.param-physical-row-identity', 'FIX_PARAM_PHYSICAL_IDENTITY'],
  [320, 'B', 'G3', 'G3.param-138-table-native', 'FIX_PARAM_NATIVE_CORPUS'],
  [330, 'B', 'G3', 'G3.param-writeback', 'FIX_PARAM_WRITEBACK'],
  [410, 'C', 'G3', 'G3.param-native-session', 'FIX_PARAM_SESSION_LIFETIME'],
  [420, 'C', 'G3', 'G3.param-large-table-ui', 'FIX_PARAM_UI_HOT_PATH'],
  [510, 'D', 'G4', 'G4.map-route-all-types', 'FIX_MAP_TYPED_ROUTING'],
  [520, 'D', 'G4', 'G4.map-499-outcomes', 'FIX_MAP_CORPUS_OUTCOME'],
  [530, 'D', 'G4', 'G4.map-geometry-oracle', 'FIX_FLVER_GEOMETRY_SEMANTICS'],
  [540, 'D', 'G4', 'G4.map-static-dto', 'FIX_MAP_STATIC_DTO'],
  [550, 'D', 'G4', 'G4.map-chunk-protocol', 'FIX_MAP_CHUNK_PROTOCOL'],
  [610, 'E', 'G5', 'G5.map-loading-interaction', 'FIX_MAP_LOADING_RESPONSIVENESS'],
  [620, 'E', 'G5', 'G5.map-loaded-frame', 'FIX_MAP_STEADY_FRAME'],
  [630, 'E', 'G5', 'G5.map-pick', 'FIX_MAP_PICK'],
  [640, 'E', 'G5', 'G5.gizmo-translate', 'FIX_GIZMO_TRANSLATE'],
  [650, 'E', 'G5', 'G5.gizmo-rotate', 'FIX_GIZMO_ROTATE'],
  [660, 'E', 'G5', 'G5.gizmo-scale', 'FIX_GIZMO_SCALE'],
  [670, 'E', 'G5', 'G5.wire-gpu-lifecycle', 'FIX_WIRE_GPU_LIFETIME'],
  [710, 'F', 'G6', 'G6.character-context-provenance', 'FIX_CHARACTER_CONTEXT'],
  [720, 'F', 'G6', 'G6.character-leader-remap', 'FIX_CHARACTER_REMAP'],
  [730, 'F', 'G6', 'G6.character-cpu-gpu-skin', 'FIX_CHARACTER_SKINNING'],
  [740, 'F', 'G6', 'G6.animation-explicit-containers', 'FIX_ANIMATION_CONTEXT'],
  [750, 'F', 'G6', 'G6.character-performance', 'FIX_CHARACTER_PERFORMANCE'],
  [810, 'G', 'G2', 'G2.discovery-no-content-read', 'FIX_DISCOVERY_METADATA_ONLY'],
  [820, 'G', 'G2', 'G2.incremental-hash', 'FIX_INCREMENTAL_FINGERPRINT'],
  [830, 'G', 'G2', 'G2.workspace-cancel-generation', 'FIX_WORKSPACE_CANCELLATION'],
  [840, 'G', 'G2', 'G2.foreground-priority', 'FIX_FOREGROUND_PRIORITY'],
  [850, 'G', 'G2', 'G2.startup-performance', 'FIX_STARTUP_CRITICAL_PATH'],
  [910, 'H', 'G0', 'G0.source-identity', 'RECAPTURE_SOURCE_IDENTITY'],
  [920, 'H', 'G0', 'G0.bridge-executable-identity', 'REPUBLISH_AND_BIND_BRIDGE'],
  [930, 'H', 'G0', 'G0.corpus-identity', 'REGENERATE_AND_VERIFY_CORPUS'],
  [940, 'H', 'G0', 'G0.runner-negative-fixtures', 'FIX_RUNNER_FAIL_CLOSED'],
  [950, 'H', 'G7', 'G7.public-regression', 'FIX_PUBLIC_REGRESSION'],
  [960, 'H', 'G7', 'G7.failure-injection', 'FIX_FAILURE_CLEANUP'],
  [970, 'H', 'G7', 'G7.patch-writeback-rollback', 'FIX_PATCH_ROLLBACK'],
  [980, 'H', 'G7', 'G7.game-root-readonly', 'FIX_GAME_ROOT_READONLY'],
  [990, 'H', 'G7', 'G7.governance', 'FIX_GOVERNANCE_GATE']
].map(([order, stage, gate, assertionId, nextActionCode]) => ({
  order,
  stage,
  gate,
  assertionId,
  nextActionCode
}));

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort(compareUtf8).map((key) => (
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    )).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
}

function compareUtf8(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function posixPath(value) {
  return value.replaceAll('\\', '/');
}

function repoRelative(absPath) {
  return posixPath(relative(ROOT, absPath));
}

function runCommand(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: null,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...options
  });
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? '', 'utf8');
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.from(result.stderr ?? '', 'utf8');
  return {
    command,
    args,
    exactCommand: [command, ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    pid: result.pid ?? null,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    stdout,
    stderr,
    stdoutText: stdout.toString('utf8'),
    stderrText: stderr.toString('utf8')
  };
}

function requireCommand(result, code) {
  if (result.exitCode !== 0) {
    const error = new Error(code + ': ' + (result.stderrText || result.error || 'command failed'));
    error.code = code;
    throw error;
  }
}

function readStableFile(absPath) {
  const before = lstatSync(absPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    const error = new Error('SOURCE_REPARSE_POINT_REJECTED: ' + repoRelative(absPath));
    error.code = 'SOURCE_REPARSE_POINT_REJECTED';
    throw error;
  }
  const bytes = readFileSync(absPath);
  const after = lstatSync(absPath);
  const beforeMtime = String(before.mtimeNs ?? before.mtimeMs);
  const afterMtime = String(after.mtimeNs ?? after.mtimeMs);
  if (
    before.size !== after.size ||
    beforeMtime !== afterMtime ||
    before.mode !== after.mode ||
    !after.isFile() ||
    after.isSymbolicLink()
  ) {
    const error = new Error('SOURCE_FILE_CHANGED_DURING_READ: ' + repoRelative(absPath));
    error.code = 'SOURCE_FILE_CHANGED_DURING_READ';
    throw error;
  }
  return {
    pathPosix: repoRelative(absPath),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes)
  };
}

function splitNul(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) values.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  return values;
}

function readGitHead() {
  const result = runCommand('git', ['rev-parse', 'HEAD']);
  requireCommand(result, 'GIT_HEAD_UNAVAILABLE');
  const gitHead = result.stdoutText.trim();
  if (!/^[0-9a-f]{40}$/.test(gitHead)) {
    const error = new Error('GIT_HEAD_INVALID');
    error.code = 'GIT_HEAD_INVALID';
    throw error;
  }
  return gitHead;
}

function readTrackedChanges() {
  const result = runCommand('git', [
    'diff',
    '--raw',
    '-z',
    '--no-renames',
    '--abbrev=40',
    'HEAD',
    '--',
    '.'
  ]);
  requireCommand(result, 'GIT_RAW_DIFF_UNAVAILABLE');
  const parts = splitNul(result.stdout);
  const changes = [];
  for (let index = 0; index < parts.length; index += 2) {
    const metadata = parts[index]?.toString('utf8') ?? '';
    const path = parts[index + 1]?.toString('utf8');
    if (!metadata || path === undefined) continue;
    const fields = metadata.split(' ');
    const headBlobOid = fields[2];
    const worktreeBlobOid = fields[3];
    const status = fields[4] ?? fields[fields.length - 1] ?? '';
    if (!/^[0-9a-f]{40}$/.test(headBlobOid ?? '')) {
      const error = new Error('SOURCE_HEAD_BLOB_OID_INVALID: ' + path);
      error.code = 'SOURCE_HEAD_BLOB_OID_INVALID';
      throw error;
    }
    if (!/^(?:[0-9a-f]{40}|0{40})$/.test(worktreeBlobOid ?? '')) {
      const error = new Error('SOURCE_WORKTREE_BLOB_OID_INVALID: ' + path);
      error.code = 'SOURCE_WORKTREE_BLOB_OID_INVALID';
      throw error;
    }
    changes.push({
      pathPosix: posixPath(path),
      status,
      headBlobOid,
      worktreeBlobOid
    });
  }
  changes.sort((left, right) => compareUtf8(left.pathPosix, right.pathPosix));
  return changes;
}

function readUntrackedSourceFiles() {
  const result = runCommand('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.'
  ]);
  requireCommand(result, 'GIT_UNTRACKED_LIST_UNAVAILABLE');
  const paths = splitNul(result.stdout)
    .map((item) => item.toString('utf8'))
    .filter(Boolean)
    .sort(compareUtf8);
  const files = [];
  for (const path of paths) {
    const absPath = resolve(ROOT, path);
    const identity = readStableFile(absPath);
    identity.pathPosix = posixPath(path);
    files.push(identity);
  }
  return files;
}

function computeSourceSnapshot() {
  const gitHead = readGitHead();
  const diffHead = runCommand('git', ['diff', '--binary', '--no-ext-diff', '--no-color', 'HEAD', '--', '.']);
  requireCommand(diffHead, 'GIT_BINARY_DIFF_UNAVAILABLE');
  const diffCached = runCommand('git', ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color', '--', '.']);
  requireCommand(diffCached, 'GIT_CACHED_DIFF_UNAVAILABLE');
  const status = runCommand('git', ['status', '--short', '--branch']);
  requireCommand(status, 'GIT_STATUS_UNAVAILABLE');
  const identity = {
    schema: 'mission1-source-snapshot-v2',
    gitHead,
    dirtyTrackedPatchSha256: sha256Hex(diffHead.stdout),
    dirtyStagedPatchSha256: sha256Hex(diffCached.stdout),
    trackedChangesArtifactSha256: sha256Hex(diffHead.stdout),
    stagedTrackedPatchSha256: sha256Hex(diffCached.stdout),
    trackedChanges: readTrackedChanges(),
    untrackedSourceFiles: readUntrackedSourceFiles()
  };
  return {
    ...identity,
    sourceSnapshotSha256: hashCanonical(identity),
    gitStatus: status.stdoutText.trim()
  };
}

function buildRunnerTrustRoot() {
  const paths = [
    RUNNER_RELATIVE_PATH,
    repoRelative(NEGATIVE_FIXTURE_PATH),
    'package.json',
    'scripts/verify/tiers.mjs'
  ];
  const files = paths.map((path) => readStableFile(resolve(ROOT, path)))
    .sort((left, right) => compareUtf8(left.pathPosix, right.pathPosix));
  const payload = {
    schema: 'mission1-reviewed-authority-root-v1',
    reviewKind: 'A0_TRUST_ROOT',
    files,
    ignoredRuntimeInputs: [],
    fileCount: files.length
  };
  return { ...payload, manifestSha256: hashCanonical(payload) };
}

function sameRunnerTrustRoot(left, right) {
  return left?.manifestSha256 === right?.manifestSha256 &&
    left?.schema === right?.schema &&
    left?.reviewKind === right?.reviewKind &&
    canonicalJson(left?.files) === canonicalJson(right?.files) &&
    left?.fileCount === right?.fileCount;
}

function sameSourceSnapshot(left, right) {
  const fields = [
    'schema',
    'gitHead',
    'dirtyTrackedPatchSha256',
    'dirtyStagedPatchSha256',
    'stagedTrackedPatchSha256',
    'trackedChanges',
    'untrackedSourceFiles'
  ];
  return fields.every((field) => canonicalJson(left[field]) === canonicalJson(right[field]));
}

function loadJsonFile(absPath) {
  if (!existsSync(absPath)) {
    return { ok: false, code: 'FILE_MISSING', path: repoRelative(absPath) };
  }
  try {
    const raw = readFileSync(absPath);
    const value = JSON.parse(raw.toString('utf8'));
    return {
      ok: true,
      path: repoRelative(absPath),
      raw,
      value,
      sha256: sha256Hex(raw)
    };
  } catch (error) {
    return {
      ok: false,
      code: 'JSON_INVALID',
      path: repoRelative(absPath),
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function isInside(parent, candidate) {
  const parentResolved = resolve(parent);
  const candidateResolved = resolve(candidate);
  const rel = relative(parentResolved, candidateResolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isSafeRepoRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === '..' || segment.length === 0)) return false;
  return isInside(ROOT, resolve(ROOT, value)) && resolve(ROOT, value) !== ROOT;
}

function validateRegistry() {
  const seenOrders = new Set();
  const seenIds = new Set();
  const failures = [];
  for (const spec of ASSERTION_REGISTRY) {
    if (seenOrders.has(spec.order)) failures.push('duplicate order ' + spec.order);
    if (seenIds.has(spec.assertionId)) failures.push('duplicate id ' + spec.assertionId);
    seenOrders.add(spec.order);
    seenIds.add(spec.assertionId);
    if (!spec.assertionId || !spec.nextActionCode || !spec.stage) {
      failures.push('incomplete spec ' + String(spec.order));
    }
    if (spec.stage !== 'A0' && spec.stage !== 'A2' && !spec.gate) {
      failures.push('missing gate ' + spec.assertionId);
    }
    if ((spec.stage === 'A0' || spec.stage === 'A2') && spec.gate !== null) {
      failures.push('A0/A2 gate must be null ' + spec.assertionId);
    }
  }
  for (const gate of GATE_IDS) {
    if (!ASSERTION_REGISTRY.some((spec) => spec.gate === gate)) {
      failures.push('gate has no required assertion ' + gate);
    }
  }
  return { ok: failures.length === 0, failures, count: ASSERTION_REGISTRY.length };
}

function validateNegativeManifest(value) {
  const failures = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'NEGATIVE_FIXTURE_MANIFEST_INVALID', failures: ['not an object'] };
  }
  if (value.schema !== 'mission1-runner-negative-fixtures-v1') {
    failures.push('schema');
  }
  if (!/^[0-9a-f]{64}$/.test(value.manifestSha256 ?? '')) {
    failures.push('manifestSha256');
  } else if (hashCanonical(withoutField(value, 'manifestSha256')) !== value.manifestSha256) {
    failures.push('manifest self hash');
  }
  if (!Number.isInteger(value.fixtureCount) || !Array.isArray(value.fixtures)) {
    failures.push('fixtureCount/fixtures');
  } else {
    if (value.fixtureCount !== value.fixtures.length) failures.push('fixtureCount mismatch');
    const ids = new Set();
    for (const fixture of value.fixtures) {
      if (!fixture || typeof fixture !== 'object') {
        failures.push('fixture not object');
        continue;
      }
      if (ids.has(fixture.id)) failures.push('duplicate fixture ' + String(fixture.id));
      ids.add(fixture.id);
      if (typeof fixture.id !== 'string' || !ALLOWED_NEGATIVE_CODES.has(fixture.expectedCode)) {
        failures.push('fixture code ' + String(fixture.id));
      }
      if (typeof fixture.assertionId !== 'string' || fixture.assertionId.length === 0) {
        failures.push('fixture assertion ' + String(fixture.id));
      }
      if (fixture.stage !== 'A0') failures.push('fixture stage ' + String(fixture.id));
      if (!Array.isArray(fixture.forbiddenStatuses) || !fixture.forbiddenStatuses.includes('PASS')) {
        failures.push('fixture forbidden statuses ' + String(fixture.id));
      }
      const expectedCommand = ['node', RUNNER_RELATIVE_PATH, '--fixture', fixture.id];
      if (canonicalJson(fixture.exactCommand) !== canonicalJson(expectedCommand)) {
        failures.push('fixture exact command ' + String(fixture.id));
      }
      if (!Array.isArray(fixture.inputArtifacts) || fixture.inputArtifacts.length === 0) {
        failures.push('fixture inputs ' + String(fixture.id));
      } else {
        for (const item of fixture.inputArtifacts) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            failures.push('fixture input object ' + String(fixture.id));
            continue;
          }
          if (!isSafeRepoRelativePath(item.path)) failures.push('unsafe fixture input ' + String(fixture.id));
          if (!Number.isInteger(item.byteLength) || item.byteLength < 0) {
            failures.push('fixture input size ' + String(fixture.id));
          }
          if (!/^[0-9a-f]{64}$/.test(item.sha256 ?? '')) {
            failures.push('fixture input hash ' + String(fixture.id));
          }
        }
      }
    }
  }
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : 'NEGATIVE_FIXTURE_MANIFEST_INVALID',
    failures
  };
}

function loadFixtureArtifacts(fixture) {
  const artifacts = [];
  const failures = [];
  for (const declaration of fixture.inputArtifacts ?? []) {
    if (!isSafeRepoRelativePath(declaration.path)) {
      failures.push('unsafe fixture input ' + String(declaration.path));
      continue;
    }
    const absPath = resolve(ROOT, declaration.path);
    try {
      const before = readStableFile(absPath);
      const loaded = loadJsonFile(absPath);
      const after = readStableFile(absPath);
      if (!loaded.ok) {
        failures.push(loaded.code + ': ' + declaration.path);
        continue;
      }
      if (
        before.byteLength !== declaration.byteLength ||
        before.sha256 !== declaration.sha256 ||
        loaded.raw.length !== declaration.byteLength ||
        loaded.sha256 !== declaration.sha256 ||
        after.byteLength !== declaration.byteLength ||
        after.sha256 !== declaration.sha256
      ) {
        failures.push('fixture input identity mismatch: ' + declaration.path);
        continue;
      }
      artifacts.push({
        path: declaration.path,
        byteLength: declaration.byteLength,
        sha256: declaration.sha256,
        raw: loaded.raw,
        value: loaded.value
      });
    } catch (error) {
      failures.push((error?.code ?? 'FIXTURE_INPUT_READ_FAILED') + ': ' + declaration.path);
    }
  }
  return {
    ok: failures.length === 0 && artifacts.length === (fixture.inputArtifacts?.length ?? 0),
    code: failures.length === 0 ? null : 'NEGATIVE_FIXTURE_INPUT_INVALID',
    failures,
    artifacts,
    inputArtifactSha256s: artifacts.map((item) => item.sha256)
  };
}

function validateCorpusManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'CORPUS_MANIFEST_INVALID', failures: ['not an object'] };
  }
  const failures = [];
  if (value.schema === 'mission1-sekiro-corpus-v2') {
    if (value.game !== 'sekiro') failures.push('game');
    if (!Array.isArray(value.entries) || value.entryCount !== value.entries.length) {
      failures.push('entries/count');
    }
    if (!Array.isArray(value.mapCorpus?.models) || value.mapCorpus.modelCount !== value.mapCorpus.models.length) {
      failures.push('map models/count');
    }
    if (!Array.isArray(value.mapCorpus?.placements) || value.mapCorpus.placementCount !== value.mapCorpus.placements.length) {
      failures.push('placements/count');
    }
    if (
      !Array.isArray(value.characterStaticSamples) ||
      value.characterStaticSampleCount !== value.characterStaticSamples.length ||
      value.characterStaticSampleCount !== 10
    ) {
      failures.push('character samples/count');
    }
    if (!Array.isArray(value.evidenceJoins) || value.evidenceJoinCount !== value.evidenceJoins.length) {
      failures.push('evidence joins/count');
    }
    if (!/^[0-9a-f]{64}$/.test(value.generatorSourceSha256 ?? '')) failures.push('generator hash');
    if (!/^[0-9a-f]{64}$/.test(value.verifierSourceSha256 ?? '')) failures.push('verifier hash');
    if (JSON.stringify(value).includes('"pending"')) failures.push('pending values');
    return {
      ok: failures.length === 0,
      code: failures.length === 0 ? null : 'CORPUS_MANIFEST_INVALID',
      failures
    };
  }
  if (value.manifestId === 'mission1-sekiro-acceptance-v1') {
    failures.push('legacy schema is not trusted');
    if (value.entryCount !== value.entries?.length) failures.push('entryCount mismatch');
    if (JSON.stringify(value).match(/"[0-9a-f]{64}"/g)?.some((hash) => /^"(?:0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)"$/.test(hash))) {
      failures.push('placeholder hashes');
    }
    if (value.characterSamples?.pending === true) failures.push('character samples pending');
    if (value.generator?.sourceHashes?.includes('pending')) failures.push('tri-source hashes pending');
    return { ok: false, code: 'CORPUS_PLACEHOLDER_REJECTED', failures };
  }
  return { ok: false, code: 'CORPUS_SCHEMA_UNTRUSTED', failures: ['unknown schema'] };
}

function withoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function validateArtifactManifest(value) {
  const failures = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'ARTIFACT_MANIFEST_INVALID', failures: ['not an object'] };
  }
  if (value.schema !== 'mission1-artifact-manifest-v2') failures.push('schema');
  if (!/^[0-9a-f]{64}$/.test(value.sourceSnapshotSha256 ?? '')) failures.push('source snapshot');
  if (!/^[0-9a-f]{64}$/.test(value.runnerTrustRootSha256 ?? '')) failures.push('runner trust root');
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    failures.push('artifacts');
  } else {
    const kinds = new Set();
    for (const artifact of value.artifacts) {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        failures.push('artifact object');
        continue;
      }
      if (kinds.has(artifact.kind)) failures.push('duplicate artifact kind');
      kinds.add(artifact.kind);
      if (typeof artifact.kind !== 'string' || artifact.kind.length === 0) failures.push('artifact kind');
      if (typeof artifact.path !== 'string' || artifact.path.length === 0) failures.push('artifact path');
      if (artifact.kind === 'summary') {
        if (artifact.path !== 'summary.json') failures.push('summary artifact path');
      } else if (!isSafeRepoRelativePath(artifact.path)) {
        failures.push('unsafe artifact path');
      }
      if (!Number.isInteger(artifact.byteLength) || artifact.byteLength < 0) failures.push('artifact size');
      if (!/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '')) failures.push('artifact hash');
    }
    for (const requiredKind of ['runner', 'negative-fixture', 'corpus', 'summary']) {
      if (!kinds.has(requiredKind)) failures.push('missing artifact kind: ' + requiredKind);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(value.artifactManifestSha256 ?? '')) {
    failures.push('manifest hash');
  } else if (hashCanonical(withoutField(value, 'artifactManifestSha256')) !== value.artifactManifestSha256) {
    failures.push('manifest self hash');
  }
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : 'ARTIFACT_MANIFEST_INVALID',
    failures
  };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'CURRENT_STATE_INVALID', failures: ['not an object'] };
  }
  const failures = [];
  if (value.schema !== 'mission1-acceptance-state-v2') failures.push('schema');
  if (value.publisher !== 'verify-mission1-acceptance-v2') failures.push('publisher');
  if (!/^[0-9a-f]{64}$/.test(value.stateSha256 ?? '')) failures.push('stateSha256');
  else if (hashCanonical(withoutField(value, 'stateSha256')) !== value.stateSha256) failures.push('state hash');
  if (!/^[0-9a-f]{64}$/.test(value.sourceSnapshotSha256 ?? '')) failures.push('source snapshot');
  if (!/^[0-9a-f]{64}$/.test(value.trackedChangesArtifactSha256 ?? '')) failures.push('tracked changes artifact');
  if (!/^[0-9a-f]{64}$/.test(value.summarySha256 ?? '')) failures.push('summary hash');
  if (!/^[0-9a-f]{64}$/.test(value.runnerTrustRootSha256 ?? '')) failures.push('runner trust root');
  if (!/^[0-9a-f]{64}$/.test(value.artifactManifestSha256 ?? '')) failures.push('artifact manifest hash');
  if (!value.summaryPath || typeof value.summaryPath !== 'string') failures.push('summary path');
  if (!value.evidenceDir || typeof value.evidenceDir !== 'string') failures.push('evidence dir');
  if (!value.artifactManifestPath || typeof value.artifactManifestPath !== 'string') failures.push('artifact manifest path');
  if (!Array.isArray(value.assertions)) failures.push('assertions');
  if (!value.gates || typeof value.gates !== 'object') failures.push('gates');
  if (!value.stageCheckpoints || typeof value.stageCheckpoints !== 'object') failures.push('stage checkpoints');
  if (value.stageCheckpoints?.A0?.sourceSnapshotSha256 !== value.sourceSnapshotSha256) {
    failures.push('A0 checkpoint source snapshot');
  }
  if (value.stageCheckpoints?.A0?.runnerTrustRootSha256 !== value.runnerTrustRootSha256) {
    failures.push('A0 checkpoint runner trust root');
  }
  if (value.stageCheckpoints?.A0?.artifactManifestSha256 !== value.artifactManifestSha256) {
    failures.push('A0 checkpoint artifact manifest');
  }
  for (const gate of GATE_IDS) {
    if (value.gates?.[gate]?.status !== 'FAIL') {
      failures.push('gate is not fail-closed: ' + gate);
    }
  }
  if (failures.length === 0) {
    try {
      const currentRunnerTrustRoot = buildRunnerTrustRoot();
      if (currentRunnerTrustRoot.manifestSha256 !== value.runnerTrustRootSha256) {
        failures.push('runner trust root identity');
      }
    } catch (error) {
      failures.push('runner trust root unreadable: ' + (error?.code ?? 'unknown'));
    }
  }
  if (failures.length) return { ok: false, code: 'CURRENT_STATE_UNTRUSTED', failures };
  const evidenceDir = resolve(ROOT, value.evidenceDir);
  const summaryPath = resolve(ROOT, value.summaryPath);
  const artifactManifestPath = resolve(ROOT, value.artifactManifestPath);
  if (
    !isInside(OUTPUT_ROOT, evidenceDir) ||
    !isInside(OUTPUT_ROOT, summaryPath) ||
    !isInside(OUTPUT_ROOT, artifactManifestPath) ||
    !isInside(evidenceDir, summaryPath) ||
    !isInside(evidenceDir, artifactManifestPath)
  ) {
    return { ok: false, code: 'CURRENT_STATE_PATH_UNSAFE', failures: ['path outside output root'] };
  }
  if (!existsSync(summaryPath)) failures.push('summary missing');
  if (existsSync(summaryPath)) {
    const summary = loadJsonFile(summaryPath);
    if (!summary.ok) failures.push('summary unreadable');
      if (summary.ok) {
        if (summary.value.summarySha256 !== value.summarySha256) failures.push('summary identity');
        if (hashCanonical(withoutField(summary.value, 'summarySha256')) !== summary.value.summarySha256) {
          failures.push('summary hash');
        }
        if (summary.value.runnerTrustRootSha256 !== value.runnerTrustRootSha256) {
          failures.push('summary runner trust root');
        }
        if (summary.value.artifactManifest?.path !== value.artifactManifestPath) {
          failures.push('summary artifact manifest path');
        }
      }
  }
  if (!existsSync(artifactManifestPath)) failures.push('artifact manifest missing');
  if (existsSync(artifactManifestPath)) {
    const artifactManifest = loadJsonFile(artifactManifestPath);
    if (!artifactManifest.ok) failures.push('artifact manifest unreadable');
    if (artifactManifest.ok) {
      const artifactValidation = validateArtifactManifest(artifactManifest.value);
      if (!artifactValidation.ok) failures.push(...artifactValidation.failures.map((item) => 'artifact manifest: ' + item));
      if (artifactManifest.value.artifactManifestSha256 !== value.artifactManifestSha256) {
        failures.push('artifact manifest identity');
      }
      if (artifactManifest.value.sourceSnapshotSha256 !== value.sourceSnapshotSha256) {
        failures.push('artifact manifest source snapshot');
      }
      if (artifactManifest.value.runnerTrustRootSha256 !== value.runnerTrustRootSha256) {
        failures.push('artifact manifest runner trust root');
      }
      const summaryArtifact = artifactManifest.value.artifacts?.find((item) => item.kind === 'summary');
      if (!summaryArtifact || resolve(dirname(artifactManifestPath), summaryArtifact.path) !== summaryPath) {
        failures.push('artifact manifest summary path');
      } else if (summaryArtifact.sha256 !== sha256Hex(readFileSync(summaryPath)) || summaryArtifact.byteLength !== statSync(summaryPath).size) {
        failures.push('artifact manifest summary identity');
      }
      for (const expectedArtifact of [
        { kind: 'runner', path: RUNNER_RELATIVE_PATH },
        { kind: 'negative-fixture', path: repoRelative(NEGATIVE_FIXTURE_PATH) },
        { kind: 'corpus', path: repoRelative(CORPUS_PATH) }
      ]) {
        const artifact = artifactManifest.value.artifacts?.find((item) => item.kind === expectedArtifact.kind);
        if (!artifact || artifact.path !== expectedArtifact.path) {
          failures.push('artifact manifest ' + expectedArtifact.kind + ' path');
          continue;
        }
        try {
          const identity = readStableFile(resolve(ROOT, expectedArtifact.path));
          if (identity.sha256 !== artifact.sha256 || identity.byteLength !== artifact.byteLength) {
            failures.push('artifact manifest ' + expectedArtifact.kind + ' identity');
          }
        } catch (error) {
          failures.push('artifact manifest ' + expectedArtifact.kind + ' unreadable: ' + (error?.code ?? 'unknown'));
        }
      }
    }
  }
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : 'CURRENT_STATE_UNTRUSTED',
    failures,
    evidenceDir: repoRelative(evidenceDir),
    summaryPath: repoRelative(summaryPath),
    artifactManifestPath: repoRelative(artifactManifestPath)
  };
}

function inspectCurrentState() {
  const loaded = loadJsonFile(CURRENT_STATE_PATH);
  if (!loaded.ok) {
    return {
      present: loaded.code !== 'FILE_MISSING',
      readable: false,
      trusted: false,
      code: loaded.code,
      failures: [loaded.detail ?? loaded.code]
    };
  }
  const validation = validateState(loaded.value);
  return {
    present: true,
    readable: true,
    trusted: validation.ok,
    code: validation.code,
    failures: validation.failures ?? [],
    value: loaded.value,
    rawSha256: loaded.sha256,
    validation
  };
}

function loadApproval() {
  if (!existsSync(APPROVAL_ROOT)) {
    return { ok: false, code: 'DIRTY_WORKTREE_APPROVAL_MISSING' };
  }
  const candidates = [];
  for (const name of readdirSync(APPROVAL_ROOT, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const directory = join(APPROVAL_ROOT, name.name);
    const approvalPath = join(directory, 'approval.json');
    const messagePath = join(directory, 'user-message.txt');
    if (!existsSync(approvalPath) || !existsSync(messagePath)) continue;
    const approval = loadJsonFile(approvalPath);
    if (!approval.ok) continue;
    candidates.push({ directory, approvalPath, messagePath, value: approval.value });
  }
  candidates.sort((left, right) => compareUtf8(left.directory, right.directory));
  const candidate = candidates.at(-1);
  if (!candidate) return { ok: false, code: 'DIRTY_WORKTREE_APPROVAL_MISSING' };
  const value = candidate.value;
  const failures = [];
  if (value.schema !== 'mission1-dirty-worktree-approval-v1') failures.push('schema');
  if (value.exactConfirmationText !== EXACT_DIRTY_APPROVAL) failures.push('exact text');
  let messageBytes;
  try {
    messageBytes = readFileSync(candidate.messagePath);
  } catch {
    failures.push('raw message unreadable');
  }
  if (messageBytes) {
    if (sha256Hex(messageBytes) !== value.userMessageRawArtifactSha256) failures.push('raw artifact hash');
    if (sha256Hex(Buffer.from(EXACT_DIRTY_APPROVAL, 'utf8')) !== value.userMessageRawSha256) {
      failures.push('raw message hash');
    }
  }
  if (!/^[0-9a-f]{64}$/.test(value.approvalSourceSnapshotSha256 ?? '')) failures.push('approval snapshot');
  if (!value.recorderTaskIdentity || !value.editSessionId) failures.push('recorder identity');
  if (!/^[0-9a-f]{64}$/.test(value.artifactSha256 ?? '')) failures.push('artifact hash');
  else if (hashCanonical(withoutField(value, 'artifactSha256')) !== value.artifactSha256) failures.push('artifact self hash');
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : 'DIRTY_WORKTREE_APPROVAL_INVALID',
    failures,
    editSessionId: value.editSessionId,
    approvalSourceSnapshotSha256: value.approvalSourceSnapshotSha256,
    artifactSha256: value.artifactSha256,
    path: repoRelative(candidate.approvalPath)
  };
}

function loadIndependentReview(expected = {}) {
  if (!existsSync(REVIEW_ROOT)) {
    return { ok: false, code: 'INDEPENDENT_REVIEW_ATTESTATION_INVALID', failures: ['review directory missing'] };
  }
  const candidates = [];
  for (const name of readdirSync(REVIEW_ROOT, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const directory = join(REVIEW_ROOT, name.name);
    const artifactPath = join(directory, 'review.json');
    if (!existsSync(artifactPath)) continue;
    const loaded = loadJsonFile(artifactPath);
    if (loaded.ok) candidates.push({ path: artifactPath, value: loaded.value });
  }
  candidates.sort((left, right) => compareUtf8(left.path, right.path));
  const candidate = candidates.at(-1);
  if (!candidate) {
    return { ok: false, code: 'INDEPENDENT_REVIEW_ATTESTATION_INVALID', failures: ['review artifact missing'] };
  }
  const value = candidate.value;
  const failures = [];
  if (value.schema !== 'mission1-independent-review-v1') failures.push('schema');
  if (value.reviewKind !== 'A0_TRUST_ROOT') failures.push('review kind');
  if (!value.reviewerTaskIdentity || value.reviewerTaskIdentity === value.dispatcherTaskIdentity) {
    failures.push('reviewer identity');
  }
  if (value.reviewerForkMode !== 'none') failures.push('fork mode');
  if (value.conclusion !== 'NO_BYPASS_FOUND') failures.push('conclusion');
  if (typeof value.reviewedAtUtc !== 'string' || value.reviewedAtUtc.length === 0) failures.push('review timestamp');
  if (!/^[0-9a-f]{64}$/.test(value.orchestratorDispatchReceiptSha256 ?? '')) {
    failures.push('dispatch receipt hash');
  }
  if (!/^[0-9a-f]{64}$/.test(value.rawFinalMessageSha256 ?? '')) {
    failures.push('raw final message hash');
  }
  if (!Array.isArray(value.attackCases) || value.attackCases.length === 0) failures.push('attack cases');
  if (value.attackCases?.some((item) => (
    !item ||
    typeof item.attackId !== 'string' ||
    item.attackId.length === 0 ||
    !Array.isArray(item.inputArtifactHashes) ||
    item.inputArtifactHashes.length === 0 ||
    item.inputArtifactHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
    !/^[0-9a-f]{64}$/.test(item.rawReviewerOutputSha256 ?? '') ||
    typeof item.observedReasonCode !== 'string' ||
    item.observedReasonCode.length === 0 ||
    item.bypassAccepted !== false
  ))) failures.push('attack case contract');
  if (!/^[0-9a-f]{64}$/.test(value.reviewedAuthorityRootSha256 ?? '')) failures.push('reviewed authority root');
  if (!/^[0-9a-f]{64}$/.test(value.reviewedSourceSnapshotSha256 ?? '')) failures.push('reviewed source snapshot');
  if (!/^[0-9a-f]{64}$/.test(value.reviewedDiffSha256 ?? '')) failures.push('reviewed diff');
  if (expected.runnerTrustRootSha256 && value.reviewedAuthorityRootSha256 !== expected.runnerTrustRootSha256) {
    failures.push('reviewed authority root is stale');
  }
  if (expected.sourceSnapshotSha256 && value.reviewedSourceSnapshotSha256 !== expected.sourceSnapshotSha256) {
    failures.push('reviewed source snapshot is stale');
  }
  if (expected.diffSha256 && value.reviewedDiffSha256 !== expected.diffSha256) {
    failures.push('reviewed diff is stale');
  }
  if (!Array.isArray(value.quarantineArtifactHashes) || value.quarantineArtifactHashes.length === 0) {
    failures.push('quarantine artifacts');
  } else if (value.quarantineArtifactHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    failures.push('quarantine artifact hash format');
  }
  if (!/^[0-9a-f]{64}$/.test(value.artifactSha256 ?? '')) failures.push('artifact hash');
  else if (hashCanonical(withoutField(value, 'artifactSha256')) !== value.artifactSha256) failures.push('artifact self hash');
  const acceptancePath = join(dirname(candidate.path), 'user-acceptance.json');
  const acceptance = existsSync(acceptancePath) ? loadJsonFile(acceptancePath) : null;
  if (!acceptance?.ok) {
    failures.push('user acceptance missing');
  } else {
    const accepted = acceptance.value;
    const expectedText = '确认接受独立审查：' + value.reviewKind + ' ' + value.reviewedAuthorityRootSha256 + ' ' + value.artifactSha256;
    if (accepted.schema !== 'mission1-user-review-acceptance-v1') failures.push('acceptance schema');
    if (typeof accepted.acceptedAtUtc !== 'string' || accepted.acceptedAtUtc.length === 0) failures.push('acceptance timestamp');
    if (accepted.reviewKind !== value.reviewKind) failures.push('acceptance review kind');
    if (accepted.reviewedAuthorityRootSha256 !== value.reviewedAuthorityRootSha256) failures.push('acceptance root hash');
    if (accepted.reviewedSourceSnapshotSha256 !== value.reviewedSourceSnapshotSha256) failures.push('acceptance source snapshot');
    if (accepted.reviewedDiffSha256 !== value.reviewedDiffSha256) failures.push('acceptance diff');
    if (accepted.reviewArtifactSha256 !== value.artifactSha256) failures.push('acceptance artifact hash');
    if (accepted.exactConfirmationText !== expectedText) failures.push('acceptance exact text');
    if (accepted.rawConfirmationTextSha256 !== sha256Hex(Buffer.from(expectedText, 'utf8'))) {
      failures.push('acceptance raw text hash');
    }
    if (!/^[0-9a-f]{64}$/.test(accepted.artifactSha256 ?? '') || hashCanonical(withoutField(accepted, 'artifactSha256')) !== accepted.artifactSha256) {
      failures.push('acceptance self hash');
    }
  }
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : 'INDEPENDENT_REVIEW_ATTESTATION_INVALID',
    failures,
    path: repoRelative(candidate.path),
    artifactSha256: value.artifactSha256,
    userAcceptancePath: acceptance?.ok ? repoRelative(acceptancePath) : null
  };
}

function acceptTypedChildResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, code: 'CHILD_RESULT_INCOMPLETE' };
  if (result.exitCode !== 0) return { ok: false, code: 'CHILD_EXIT_NONZERO' };
  if (result.status !== 'passed') return { ok: false, code: 'CHILD_RESULT_INCOMPLETE' };
  if (!Array.isArray(result.assertions) || result.assertions.length === 0) {
    return { ok: false, code: 'CHILD_RESULT_INCOMPLETE' };
  }
  if (!/^[0-9a-f]{64}$/.test(result.artifactSha256 ?? '')) {
    return { ok: false, code: 'CHILD_RESULT_INCOMPLETE' };
  }
  return { ok: true, code: null };
}

function verifyArtifactReplay(summary, expectedSha256) {
  if (!summary || typeof summary !== 'object') return { ok: false, code: 'ARTIFACT_HASH_MISMATCH' };
  const actual = hashCanonical(withoutField(summary, 'summarySha256'));
  return actual === expectedSha256
    ? { ok: true, code: null }
    : { ok: false, code: 'ARTIFACT_HASH_MISMATCH' };
}

function verifyIdentity(left, right, code) {
  return canonicalJson(left) === canonicalJson(right)
    ? { ok: true, code: null }
    : { ok: false, code };
}

function requireStateArtifact(state) {
  return state && state.summaryPath && state.summarySha256
    ? { ok: true, code: null }
    : { ok: false, code: 'STATE_ARTIFACT_MISSING' };
}

function requireUiArtifact(artifact) {
  return artifact && typeof artifact === 'object' && /^[0-9a-f]{64}$/.test(artifact.sha256 ?? '')
    ? { ok: true, code: null }
    : { ok: false, code: 'UI_ARTIFACT_MISSING' };
}

function fixtureResultForId(fixture, loaded) {
  const values = loaded.artifacts.map((artifact) => artifact.value);
  switch (fixture.id) {
    case 'forged-old-log':
      return verifyArtifactReplay(values[0], values[0]?.summarySha256 ?? null);
    case 'child-skipped':
      return acceptTypedChildResult(values[0]);
    case 'source-changed-during-run':
      return verifyIdentity(values[0], values[1], 'SOURCE_CHANGED_DURING_RUN');
    case 'bridge-hash-mismatch':
      return verifyIdentity(values[0]?.expected, values[0]?.actual, 'BRIDGE_IDENTITY_MISMATCH');
    case 'corpus-hash-mismatch':
      return verifyIdentity(values[0], values[1], 'CORPUS_IDENTITY_CHANGED');
    case 'handwritten-pass-without-artifact':
      return requireStateArtifact(values[0]);
    case 'missing-ui-artifact':
      return requireUiArtifact(values[0]);
    case 'child-nonzero':
      return acceptTypedChildResult(values[0]);
    default:
      return { ok: false, code: 'FIXTURE_ID_UNKNOWN' };
  }
}

function runFixtureChild(fixtureId) {
  const loadedManifest = loadJsonFile(NEGATIVE_FIXTURE_PATH);
  if (!loadedManifest.ok) {
    printJson({ ok: false, code: loadedManifest.code, fixtureId });
    process.exitCode = 2;
    return;
  }
  const validation = validateNegativeManifest(loadedManifest.value);
  if (!validation.ok) {
    printJson({ ok: false, code: validation.code, fixtureId, failures: validation.failures });
    process.exitCode = 2;
    return;
  }
  const fixture = loadedManifest.value.fixtures.find((item) => item.id === fixtureId);
  if (!fixture) {
    printJson({ ok: false, code: 'FIXTURE_ID_UNKNOWN', fixtureId });
    process.exitCode = 2;
    return;
  }
  const loaded = loadFixtureArtifacts(fixture);
  if (!loaded.ok) {
    printJson({
      ok: false,
      code: loaded.code,
      fixtureId,
      failures: loaded.failures,
      inputArtifactSha256s: loaded.inputArtifactSha256s
    });
    process.exitCode = 2;
    return;
  }
  const result = fixtureResultForId(fixture, loaded);
  const expectedRejection = result.ok === false && result.code === fixture.expectedCode;
  printJson({
    ok: result.ok,
    observedStatus: result.ok ? 'PASS' : 'rejected',
    fixtureId,
    code: result.code,
    inputArtifactSha256s: loaded.inputArtifactSha256s
  });
  process.exitCode = expectedRejection ? 1 : 2;
}

function runAtomicityFixture() {
  const directory = join(tmpdir(), 'soulforge-mission1-a0-' + randomUUID());
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'state.json');
  const initial = '{"version":1}\n';
  const replacement = '{"version":2}\n';
  const failurePoints = ['before-write', 'during-write', 'after-flush', 'before-rename'];
  const cases = [];
  const temporaryFiles = () => readdirSync(directory).filter((name) => name.startsWith('state.json.tmp-'));
  try {
    for (const failAt of failurePoints) {
      atomicWriteText(target, initial);
      let errorCode = null;
      try {
        atomicWriteText(target, replacement, { failAt });
      } catch (error) {
        errorCode = error instanceof Error ? error.code : null;
      }
      const targetUnchanged = readFileSync(target, 'utf8') === initial;
      const tempClean = temporaryFiles().length === 0;
      cases.push({
        failAt,
        errorCode,
        targetUnchanged,
        tempClean,
        ok: errorCode === 'ATOMIC_FIXTURE_FAILURE' && targetUnchanged && tempClean
      });
    }

    atomicWriteText(target, initial);
    let afterRenameError = null;
    try {
      atomicWriteText(target, replacement, { failAt: 'after-rename' });
    } catch (error) {
      afterRenameError = error instanceof Error ? error.code : null;
    }
    let parsedReplacement = null;
    try {
      parsedReplacement = JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      parsedReplacement = null;
    }
    const afterRenameTargetReplaced = readFileSync(target, 'utf8') === replacement;
    const afterRenameTempClean = temporaryFiles().length === 0;
    cases.push({
      failAt: 'after-rename',
      errorCode: afterRenameError,
      targetReplaced: afterRenameTargetReplaced,
      parseable: parsedReplacement?.version === 2,
      tempClean: afterRenameTempClean,
      ok: afterRenameError === 'ATOMIC_FIXTURE_FAILURE' && afterRenameTargetReplaced && parsedReplacement?.version === 2 && afterRenameTempClean
    });

    atomicWriteText(target, initial);
    atomicWriteText(target, replacement);
    const successReadback = readFileSync(target, 'utf8') === replacement && temporaryFiles().length === 0;
    cases.push({ failAt: null, successReadback, ok: successReadback });
    const ok = cases.every((item) => item.ok);
    return { ok, code: ok ? null : 'STATE_ATOMICITY_FAILED', cases };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runA0SelfTests(manifest) {
  const results = [];
  for (const fixture of manifest.fixtures) {
    const declaredInputs = fixture.inputArtifacts.map((item) => item.sha256);
    const inputCheck = loadFixtureArtifacts(fixture);
    const child = inputCheck.ok
      ? runCommand(process.execPath, [fileURLToPath(import.meta.url), '--fixture', fixture.id])
      : null;
    let output = null;
    let outputError = null;
    if (child) {
      try {
        output = JSON.parse(child.stdoutText.trim());
      } catch (error) {
        outputError = error instanceof Error ? error.message : String(error);
      }
    }
    const inputArtifactSha256s = output?.inputArtifactSha256s ?? inputCheck.inputArtifactSha256s;
    const exactCommand = fixture.exactCommand;
    const commandMatches = canonicalJson(exactCommand) === canonicalJson(['node', RUNNER_RELATIVE_PATH, '--fixture', fixture.id]);
    const outputMatchesInputs = canonicalJson(inputArtifactSha256s) === canonicalJson(declaredInputs);
    const rejected = output?.ok === false && output?.code === fixture.expectedCode;
    const statusAllowed = !fixture.forbiddenStatuses.includes(output?.observedStatus);
    const ok = Boolean(
      inputCheck.ok &&
      child &&
      child.exitCode === 1 &&
      !outputError &&
      output?.fixtureId === fixture.id &&
      rejected &&
      outputMatchesInputs &&
      statusAllowed &&
      commandMatches
    );
    results.push({
      id: fixture.id,
      assertionId: fixture.assertionId,
      exactCommand,
      expected: fixture.expectedCode,
      actual: output?.code ?? (outputError ? 'CHILD_OUTPUT_INVALID' : inputCheck.code),
      exitCode: child?.exitCode ?? null,
      rawOutputSha256: child ? sha256Hex(child.stdout) : null,
      inputArtifactSha256s,
      expectedInputArtifactSha256s: declaredInputs,
      ok,
      failures: [
        ...inputCheck.failures,
        ...(outputError ? ['child output JSON invalid'] : []),
        ...(commandMatches ? [] : ['exact command mismatch']),
        ...(outputMatchesInputs ? [] : ['child input artifact identity mismatch']),
        ...(statusAllowed ? [] : ['forbidden PASS status observed'])
      ]
    });
  }
  const atomicity = runAtomicityFixture();
  return {
    ok: results.length === manifest.fixtures.length && results.every((item) => item.ok) && atomicity.ok,
    results,
    atomicity,
    exitCode: results.every((item) => item.ok) && atomicity.ok ? 0 : 1
  };
}

function classifyRequiredInputs(state, corpus, negative, approval) {
  let evidenceDirectory = 'not-addressable';
  if (state.trusted && state.value?.evidenceDir) {
    const evidence = resolve(ROOT, state.value.evidenceDir);
    if (isInside(OUTPUT_ROOT, evidence) && existsSync(evidence)) evidenceDirectory = 'present-readable';
    else evidenceDirectory = 'unreadable';
  }
  return {
    candidateRunner: existsSync(join(ROOT, RUNNER_RELATIVE_PATH)) ? 'present-readable' : 'missing',
    corpusManifest: corpus.present ? 'present-readable' : 'missing',
    currentState: state.present && state.readable ? 'present-readable' : 'missing',
    evidenceDirectory,
    negativeFixtureManifest: negative.present ? 'present-readable' : 'missing',
    dirtyWorktreeApproval: approval.ok ? 'valid' : 'missing',
    trustReasons: [
      corpus.validation?.code ?? null,
      state.code ?? null,
      negative.validation?.code ?? null,
      approval.code ?? null
    ].filter(Boolean)
  };
}

function loadInputs() {
  const corpusLoaded = loadJsonFile(CORPUS_PATH);
  const negativeLoaded = loadJsonFile(NEGATIVE_FIXTURE_PATH);
  const state = inspectCurrentState();
  const approval = loadApproval();
  const corpusValidation = corpusLoaded.ok
    ? validateCorpusManifest(corpusLoaded.value)
    : { ok: false, code: corpusLoaded.code, failures: [corpusLoaded.detail ?? corpusLoaded.code] };
  const negativeValidation = negativeLoaded.ok
    ? validateNegativeManifest(negativeLoaded.value)
    : { ok: false, code: negativeLoaded.code, failures: [negativeLoaded.detail ?? negativeLoaded.code] };
  return {
    state,
    approval,
    corpus: {
      present: corpusLoaded.ok,
      readable: corpusLoaded.ok,
      sha256: corpusLoaded.sha256 ?? null,
      validation: corpusValidation,
      value: corpusLoaded.value ?? null,
      path: repoRelative(CORPUS_PATH)
    },
    negative: {
      present: negativeLoaded.ok,
      readable: negativeLoaded.ok,
      sha256: negativeLoaded.sha256 ?? null,
      validation: negativeValidation,
      value: negativeLoaded.value ?? null,
      path: repoRelative(NEGATIVE_FIXTURE_PATH)
    }
  };
}

function assertion(spec, status, reason, extra = {}) {
  return {
    assertionId: spec.assertionId,
    order: spec.order,
    stage: spec.stage,
    gate: spec.gate,
    status,
    nextActionCode: spec.nextActionCode,
    reason,
    ...extra
  };
}

function runA0(snapshot, inputs, runnerTrustRoot) {
  const registry = validateRegistry();
  const selfTests = inputs.negative.validation.ok
    ? runA0SelfTests(inputs.negative.value)
    : { ok: false, results: [], atomicity: { ok: false, code: 'NEGATIVE_FIXTURE_MANIFEST_INVALID' }, exitCode: 1 };
  const review = loadIndependentReview({
    runnerTrustRootSha256: runnerTrustRoot?.manifestSha256,
    sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    diffSha256: snapshot.dirtyTrackedPatchSha256
  });
  const a0Specs = ASSERTION_REGISTRY.filter((spec) => spec.stage === 'A0');
  const byId = new Map(a0Specs.map((spec) => [spec.assertionId, spec]));
  const assertions = [
    assertion(
      byId.get('A0.snapshot-negative-fixtures'),
      inputs.negative.validation.ok && selfTests.ok ? 'PASS' : 'FAIL',
      inputs.negative.validation.ok && selfTests.ok
        ? '8 个固定负例实际执行并拒绝伪证据。'
        : '负例清单或执行失败。',
      { selfTestExitCode: selfTests.exitCode, cases: selfTests.results }
    ),
    assertion(
      byId.get('A0.artifact-replay-fixtures'),
      inputs.negative.validation.ok && selfTests.results.some((item) => item.id === 'forged-old-log' && item.ok)
        ? 'PASS'
        : 'FAIL',
      '旧 summary/hash 只能作为拒绝型回放输入。',
      { replayCase: selfTests.results.find((item) => item.id === 'forged-old-log') ?? null }
    ),
    assertion(
      byId.get('A0.child-exit-and-typed-artifact'),
      inputs.negative.validation.ok &&
      selfTests.results.some((item) => item.id === 'child-skipped' && item.ok) &&
      selfTests.results.some((item) => item.id === 'child-nonzero' && item.ok)
        ? 'PASS'
        : 'FAIL',
      'child exit、semantic status、assertions 和 artifact hash 必须同时成立。',
      { childCases: selfTests.results.filter((item) => item.id === 'child-skipped' || item.id === 'child-nonzero') }
    ),
    assertion(
      byId.get('A0.state-atomicity'),
      selfTests.atomicity?.ok ? 'PASS' : 'FAIL',
      selfTests.atomicity?.ok
        ? '写前/rename 前故障保持旧 state 完整，成功写入后新 state 可读。'
        : 'atomic publisher fixture 未通过。',
      { atomicity: selfTests.atomicity }
    ),
    assertion(
      byId.get('A0.stage-input-resume'),
      registry.ok && inputs.approval.ok && inputs.corpus.validation.ok && inputs.state.trusted
        ? 'PASS'
        : 'FAIL',
      registry.ok && inputs.approval.ok && inputs.corpus.validation.ok && inputs.state.trusted
        ? 'registry、corpus、state 与 approval identity 均可信。'
        : '当前 state/corpus/registry/approval 至少一项仍不可作为 resume 信任根。',
      {
        registry,
        currentState: { trusted: inputs.state.trusted, code: inputs.state.code, failures: inputs.state.failures },
        corpus: inputs.corpus.validation,
        approval: { ok: inputs.approval.ok, code: inputs.approval.code, failures: inputs.approval.failures }
      }
    ),
    assertion(
      byId.get('A0.independent-attack-review'),
      review.ok ? 'PASS' : 'FAIL',
      review.ok
        ? '外部 fork_turns=none A0 攻击审查 artifact 与用户接受凭证有效。'
        : '缺少有效的外部 A0 攻击审查 artifact；实现者不能自写 review.json 充数。',
      { review }
    )
  ];
  const allPass = assertions.every((item) => item.status === 'PASS');
  return {
    stage: 'A0',
    status: allPass ? 'PASS' : 'FAIL',
    trustStatus: allPass ? 'PASS' : 'FAIL',
    assertions,
    selfTests,
    review,
    snapshotSha256: snapshot.sourceSnapshotSha256,
    nextActionCode: assertions.find((item) => item.status !== 'PASS')?.nextActionCode ?? null
  };
}

function allFailGates(reason) {
  return Object.fromEntries(GATE_IDS.map((gate) => [
    gate,
    {
      id: gate,
      status: 'FAIL',
      failureKind: 'trust_root_unverified',
      detail: reason
    }
  ]));
}

// G4 wiring must require new read-map-static-geometry across Bridge→main→preload→renderer,
// not OR with old readMapPartMesh tautology (see mission1 0.4.2). This helper is the product-stage
// predicate; A0 run keeps gates FAIL but the predicate itself must be tautology-free.
function fileContainsForGate(relativePath, snippet) {
  try { return readFileSync(resolve(ROOT, relativePath), 'utf8').includes(snippet); } catch { return false; }
}
function isG4MapStaticWiringPresent() {
  const hasBridge = fileContainsForGate('bridge/SoulForge.Bridge/BridgeCommandService.cs', 'read-map-static-geometry');
  const hasIpc = fileContainsForGate('apps/desktop/src/main/ipc.ts', 'read-map-static-geometry');
  const hasPreload = fileContainsForGate('apps/desktop/src/preload/index.ts', 'read-map-static-geometry');
  const hasRenderer = fileContainsForGate('apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx', 'read-map-static-geometry');
  // require new wiring present; do NOT fall back to old readMapPartMesh
  return hasBridge && hasIpc && hasPreload;
}
function isG4TelemetryClean(telemetry) {
  return telemetry != null && telemetry.skin === 0 && telemetry.skeleton === 0 && typeof telemetry.parse === 'number';
}

function getBridgeIdentity() {
  if (!existsSync(BRIDGE_EXE)) {
    return {
      present: false,
      path: repoRelative(BRIDGE_EXE),
      sha256: null,
      byteLength: null,
      mtimeMs: null
    };
  }
  const identity = readStableFile(BRIDGE_EXE);
  const stats = statSync(BRIDGE_EXE);
  return {
    present: true,
    path: identity.pathPosix,
    sha256: identity.sha256,
    byteLength: identity.byteLength,
    mtimeMs: stats.mtimeMs
  };
}

function copyTree(source, target) {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    const error = new Error('QUARANTINE_SYMLINK_REJECTED: ' + source);
    error.code = 'QUARANTINE_SYMLINK_REJECTED';
    throw error;
  }
  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyTree(join(source, entry.name), join(target, entry.name));
    }
  } else if (stats.isFile()) {
    copyFileSync(source, target);
  }
}

function quarantineLegacyInputs(state) {
  const id = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID();
  const directory = join(OUTPUT_ROOT, 'quarantine', id);
  mkdirSync(directory, { recursive: true });
  const copied = [];
  if (existsSync(CURRENT_STATE_PATH)) {
    const target = join(directory, 'legacy-current-state.json');
    copyFileSync(CURRENT_STATE_PATH, target);
    copied.push({
      source: repoRelative(CURRENT_STATE_PATH),
      target: repoRelative(target),
      sha256: sha256Hex(readFileSync(target))
    });
  }
  for (const item of [
    { gitPath: RUNNER_RELATIVE_PATH, targetName: 'legacy-runner-from-head.mjs' },
    { gitPath: repoRelative(CORPUS_PATH), targetName: 'legacy-corpus-from-head.json' }
  ]) {
    const result = runCommand('git', ['show', 'HEAD:' + item.gitPath]);
    if (result.exitCode === 0) {
      const target = join(directory, item.targetName);
      atomicWriteBytes(target, result.stdout);
      copied.push({
        source: item.gitPath + '@HEAD',
        target: repoRelative(target),
        sha256: sha256Hex(readFileSync(target))
      });
    }
  }
  const declaredEvidence = state.value?.evidenceDir;
  if (typeof declaredEvidence === 'string') {
    const evidence = resolve(ROOT, declaredEvidence);
    if (isInside(OUTPUT_ROOT, evidence) && existsSync(evidence)) {
      const target = join(directory, 'legacy-evidence');
      copyTree(evidence, target);
      copied.push({
        source: repoRelative(evidence),
        target: repoRelative(target),
        sha256: hashDirectory(target)
      });
    }
  }
  const manifest = {
    schema: 'mission1-quarantine-manifest-v1',
    createdAtUtc: new Date().toISOString(),
    reason: state.code ?? 'CURRENT_STATE_UNTRUSTED',
    copied
  };
  atomicWriteJson(join(directory, 'quarantine-manifest.json'), manifest);
  return repoRelative(directory);
}

function hashDirectory(directory) {
  const entries = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => compareUtf8(left.name, right.name))) {
      const abs = join(current, entry.name);
      const rel = posixPath(relative(directory, abs));
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        entries.push({ pathPosix: rel, sha256: sha256Hex(readFileSync(abs)) });
      }
    }
  }
  visit(directory);
  return hashCanonical(entries);
}

function atomicWriteBytes(target, bytes, options = {}) {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = target + '.tmp-' + process.pid + '-' + randomUUID();
  let descriptor = null;
  let renamed = false;
  try {
    if (options.failAt === 'before-write') {
      const error = new Error('ATOMIC_FIXTURE_FAILURE');
      error.code = 'ATOMIC_FIXTURE_FAILURE';
      throw error;
    }
    descriptor = openSync(temporary, 'wx');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('ATOMIC_WRITE_ZERO_PROGRESS');
      offset += written;
      if (options.failAt === 'during-write') {
        const error = new Error('ATOMIC_FIXTURE_FAILURE');
        error.code = 'ATOMIC_FIXTURE_FAILURE';
        throw error;
      }
    }
    fsyncSync(descriptor);
    if (options.failAt === 'after-flush') {
      const error = new Error('ATOMIC_FIXTURE_FAILURE');
      error.code = 'ATOMIC_FIXTURE_FAILURE';
      throw error;
    }
    closeSync(descriptor);
    descriptor = null;
    if (options.failAt === 'before-rename' || options.failAt === 'before-replace') {
      const error = new Error('ATOMIC_FIXTURE_FAILURE');
      error.code = 'ATOMIC_FIXTURE_FAILURE';
      throw error;
    }
    renameSync(temporary, target);
    renamed = true;
    try {
      const directoryDescriptor = openSync(directory, 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    if (options.failAt === 'after-rename') {
      const error = new Error('ATOMIC_FIXTURE_FAILURE');
      error.code = 'ATOMIC_FIXTURE_FAILURE';
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (!renamed && existsSync(temporary)) unlinkSync(temporary);
  }
}

function atomicWriteText(target, text, options = {}) {
  atomicWriteBytes(target, Buffer.from(text, 'utf8'), options);
}

function atomicWriteJson(target, value, options = {}) {
  atomicWriteText(target, JSON.stringify(value, null, 2) + '\n', options);
}

function buildSummary(snapshot, inputs, a0, quarantinePath, mode, sourceStable, runnerTrustRoot, runnerTrustRootStable, artifactManifestPath) {
  const payload = {
    schema: 'mission1-acceptance-summary-v2',
    mode,
    startedAtUtc: new Date().toISOString(),
    finishedAtUtc: new Date().toISOString(),
    sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    gitHead: snapshot.gitHead,
    gitStatus: snapshot.gitStatus,
    dirtyTrackedPatchSha256: snapshot.dirtyTrackedPatchSha256,
    dirtyStagedPatchSha256: snapshot.dirtyStagedPatchSha256,
    stagedTrackedPatchSha256: snapshot.stagedTrackedPatchSha256,
    trackedChangesArtifactSha256: snapshot.trackedChangesArtifactSha256,
    trackedChanges: snapshot.trackedChanges,
    untrackedSourceFiles: snapshot.untrackedSourceFiles,
    sourceStable,
    runnerTrustRootSha256: runnerTrustRoot.manifestSha256,
    runnerTrustRoot,
    runnerTrustRootStable,
    artifactManifest: {
      path: artifactManifestPath,
      sha256: null,
      writtenAfterSummary: true
    },
    stageCheckpoints: {
      A0: {
        status: a0.status,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
        runnerTrustRootSha256: runnerTrustRoot.manifestSha256,
        artifactManifestSha256: null
      }
    },
    executedCommands: [],
    executionPolicy: 'A0-only-until-trust-root-passes',
    requiredInputs: classifyRequiredInputs(inputs.state, inputs.corpus, inputs.negative, inputs.approval),
    corpus: {
      path: inputs.corpus.path,
      sha256: inputs.corpus.sha256,
      validation: inputs.corpus.validation
    },
    negativeFixtures: {
      path: inputs.negative.path,
      sha256: inputs.negative.sha256,
      validation: inputs.negative.validation
    },
    dirtyWorktreeApproval: {
      ok: inputs.approval.ok,
      code: inputs.approval.code ?? null,
      path: inputs.approval.path ?? null,
      editSessionId: inputs.approval.editSessionId ?? null,
      artifactSha256: inputs.approval.artifactSha256 ?? null
    },
    bridgeExecutable: getBridgeIdentity(),
    quarantinePath,
    a0,
    gates: allFailGates(a0.status === 'PASS' ? 'A0 passed but product stages are not executed in this A0 run.' : 'A0 trust root is not complete.'),
    overallStatus: 'FAIL',
    authority: 'blocked'
  };
  return { ...payload, summarySha256: hashCanonical(payload) };
}

function buildArtifactManifest(snapshot, inputs, summary, summaryPath, runnerTrustRoot) {
  const artifacts = [
    { kind: 'runner', ...readStableFile(resolve(ROOT, RUNNER_RELATIVE_PATH)) },
    { kind: 'negative-fixture', ...readStableFile(NEGATIVE_FIXTURE_PATH) },
    { kind: 'corpus', ...readStableFile(CORPUS_PATH) },
    { kind: 'summary', ...readStableFile(resolve(ROOT, summaryPath)) }
  ];
  const payload = {
    schema: 'mission1-artifact-manifest-v2',
    sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    runnerTrustRootSha256: runnerTrustRoot.manifestSha256,
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.kind === 'summary' ? 'summary.json' : artifact.pathPosix,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256
    }))
  };
  return { ...payload, artifactManifestSha256: hashCanonical(payload) };
}

function buildState(summary, summaryPath, evidenceDir, artifactManifestPath, artifactManifest, inputs, a0, mode) {
  const payload = {
    schema: 'mission1-acceptance-state-v2',
    publisher: 'verify-mission1-acceptance-v2',
    mode,
    generatedAtUtc: new Date().toISOString(),
    sourceSnapshotSha256: summary.sourceSnapshotSha256,
    gitHead: summary.gitHead,
    dirtyTrackedPatchSha256: summary.dirtyTrackedPatchSha256,
    dirtyStagedPatchSha256: summary.dirtyStagedPatchSha256,
    stagedTrackedPatchSha256: summary.stagedTrackedPatchSha256,
    trackedChangesArtifactSha256: summary.trackedChangesArtifactSha256,
    trackedChanges: summary.trackedChanges,
    untrackedSourceFiles: summary.untrackedSourceFiles,
    runnerTrustRootSha256: summary.runnerTrustRootSha256,
    artifactManifestPath,
    artifactManifestSha256: artifactManifest.artifactManifestSha256,
    summaryPath,
    summarySha256: summary.summarySha256,
    evidenceDir,
    requiredInputs: summary.requiredInputs,
    assertions: a0.assertions,
    stage: a0.stage,
    stageStatus: a0.status,
    trustStatus: a0.trustStatus,
    stageCheckpoints: {
      A0: {
        status: a0.status,
        sourceSnapshotSha256: summary.sourceSnapshotSha256,
        runnerTrustRootSha256: summary.runnerTrustRootSha256,
        artifactManifestSha256: artifactManifest.artifactManifestSha256
      }
    },
    gates: summary.gates,
    firstFailure: a0.assertions.find((item) => item.status !== 'PASS') ?? null,
    dirtyWorktreeApproval: summary.dirtyWorktreeApproval,
    corpus: summary.corpus,
    negativeFixtures: summary.negativeFixtures,
    authority: 'blocked'
  };
  return { ...payload, stateSha256: hashCanonical(payload) };
}

function publishRun(snapshot, inputs, a0, mode, quarantinePath, sourceStable, runnerTrustRoot, runnerTrustRootStable) {
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + snapshot.gitHead.slice(0, 12);
  const directory = join(OUTPUT_ROOT, runId);
  mkdirSync(directory, { recursive: true });
  const evidenceDir = repoRelative(directory);
  const summaryPath = repoRelative(join(directory, 'summary.json'));
  const artifactManifestPath = repoRelative(join(directory, 'artifact-manifest.json'));
  const summary = buildSummary(snapshot, inputs, a0, quarantinePath, mode, sourceStable, runnerTrustRoot, runnerTrustRootStable, artifactManifestPath);
  atomicWriteJson(join(directory, 'summary.json'), summary);
  const summaryReadback = loadJsonFile(join(directory, 'summary.json'));
  if (!summaryReadback.ok || summaryReadback.value.summarySha256 !== summary.summarySha256) {
    const error = new Error('SUMMARY_READBACK_MISMATCH');
    error.code = 'SUMMARY_READBACK_MISMATCH';
    throw error;
  }
  const artifactManifest = buildArtifactManifest(snapshot, inputs, summary, summaryPath, runnerTrustRoot);
  atomicWriteJson(join(directory, 'artifact-manifest.json'), artifactManifest);
  const artifactManifestReadback = loadJsonFile(join(directory, 'artifact-manifest.json'));
  const artifactManifestValidation = artifactManifestReadback.ok
    ? validateArtifactManifest(artifactManifestReadback.value)
    : { ok: false, failures: ['artifact manifest unreadable'] };
  if (
    !artifactManifestReadback.ok ||
    !artifactManifestValidation.ok ||
    artifactManifestReadback.value.artifactManifestSha256 !== artifactManifest.artifactManifestSha256
  ) {
    const error = new Error('ARTIFACT_MANIFEST_READBACK_MISMATCH');
    error.code = 'ARTIFACT_MANIFEST_READBACK_MISMATCH';
    throw error;
  }
  const state = buildState(summary, summaryPath, evidenceDir, artifactManifestPath, artifactManifest, inputs, a0, mode);
  atomicWriteJson(join(directory, 'current-state.json'), state);
  const stateReadback = loadJsonFile(join(directory, 'current-state.json'));
  if (!stateReadback.ok || stateReadback.value.stateSha256 !== state.stateSha256) {
    const error = new Error('STATE_READBACK_MISMATCH');
    error.code = 'STATE_READBACK_MISMATCH';
    throw error;
  }
  atomicWriteJson(CURRENT_STATE_PATH, state);
  const currentReadback = loadJsonFile(CURRENT_STATE_PATH);
  if (!currentReadback.ok || currentReadback.value.stateSha256 !== state.stateSha256) {
    const error = new Error('CURRENT_STATE_READBACK_MISMATCH');
    error.code = 'CURRENT_STATE_READBACK_MISMATCH';
    throw error;
  }
  return {
    directory: evidenceDir,
    summaryPath,
    artifactManifestPath,
    artifactManifestSha256: artifactManifest.artifactManifestSha256,
    stateSha256: state.stateSha256,
    summarySha256: summary.summarySha256,
    state
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function runSelfTest() {
  const loaded = loadJsonFile(NEGATIVE_FIXTURE_PATH);
  const validation = loaded.ok
    ? validateNegativeManifest(loaded.value)
    : { ok: false, code: loaded.code, failures: [loaded.detail ?? loaded.code] };
  if (!validation.ok) {
    printJson({ ok: false, code: 'NEGATIVE_FIXTURE_MANIFEST_INVALID', validation });
    process.exitCode = 1;
    return;
  }
  const result = runA0SelfTests(loaded.value);
  printJson({
    ok: result.ok,
    code: result.ok ? null : 'A0_SELFTEST_FAILED',
    fixtureManifest: repoRelative(NEGATIVE_FIXTURE_PATH),
    fixtureCount: loaded.value.fixtures.length,
    cases: result.results,
    atomicity: result.atomicity
  });
  process.exitCode = result.exitCode;
}

function runStatus() {
  const state = inspectCurrentState();
  if (!state.trusted) {
    printJson({
      ok: false,
      code: state.code ?? 'CURRENT_STATE_UNTRUSTED',
      present: state.present,
      readable: state.readable,
      failures: state.failures
    });
    process.exitCode = 1;
    return;
  }
  printJson({ ok: true, state: state.value });
  process.exitCode = 0;
}

function runResume() {
  const state = inspectCurrentState();
  if (!state.trusted) {
    printJson({ ok: false, code: state.code ?? 'CURRENT_STATE_UNTRUSTED', failures: state.failures });
    process.exitCode = 1;
    return;
  }
  const snapshot = computeSourceSnapshot();
  if (snapshot.sourceSnapshotSha256 !== state.value.sourceSnapshotSha256) {
    printJson({
      ok: false,
      code: 'SOURCE_CHANGED_DURING_RUN',
      expected: state.value.sourceSnapshotSha256,
      actual: snapshot.sourceSnapshotSha256
    });
    process.exitCode = 1;
    return;
  }
  printJson({ ok: true, state: state.value, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 });
  process.exitCode = state.value.stageStatus === 'PASS' ? 0 : 1;
}

function usage() {
  console.log(
    'Usage: node scripts/verify-mission1-acceptance.mjs [--bootstrap|--resume|--status|--selftest|--fixture <id>]\n' +
    '  --bootstrap  quarantine legacy inputs and atomically publish a new all-FAIL A0 state\n' +
    '  --resume     verify the trusted state still matches the current source snapshot\n' +
    '  --status     validate and print only the new state schema\n' +
    '  --selftest   execute the fixed negative-fixture and atomicity tests without repo writes\n' +
    '  --fixture    execute one fixed raw negative fixture in a child process\n' +
    '  default      run A0 trust-root checks only; product stages remain FAIL until A0 passes'
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => FORBIDDEN_OVERRIDES.has(arg))) {
    printJson({ ok: false, code: 'UNSUPPORTED_OVERRIDE', args });
    process.exitCode = 2;
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const fixtureIndex = args.indexOf('--fixture');
  if (fixtureIndex !== -1) {
    const fixtureId = args[fixtureIndex + 1];
    if (!fixtureId || args.length !== fixtureIndex + 2) {
      printJson({ ok: false, code: 'FIXTURE_ID_REQUIRED' });
      process.exitCode = 2;
      return;
    }
    runFixtureChild(fixtureId);
    return;
  }
  if (args.includes('--selftest')) {
    runSelfTest();
    return;
  }
  if (args.includes('--status')) {
    runStatus();
    return;
  }
  if (args.includes('--resume')) {
    runResume();
    return;
  }
  const mode = args.includes('--bootstrap') ? 'bootstrap' : 'a0';
  const runnerTrustRootBefore = buildRunnerTrustRoot();
  const snapshotBefore = computeSourceSnapshot();
  const inputs = loadInputs();
  let quarantinePath = null;
  if (mode === 'bootstrap' || (!inputs.state.trusted && inputs.state.present)) {
    quarantinePath = quarantineLegacyInputs(inputs.state);
  }
  const snapshotAfter = computeSourceSnapshot();
  const runnerTrustRootAfter = buildRunnerTrustRoot();
  const sourceSnapshotStable = sameSourceSnapshot(snapshotBefore, snapshotAfter);
  const runnerTrustRootStable = sameRunnerTrustRoot(runnerTrustRootBefore, runnerTrustRootAfter);
  const approvalSnapshotStable = !inputs.approval.ok || inputs.approval.approvalSourceSnapshotSha256 === snapshotAfter.sourceSnapshotSha256;
  const sourceStable = sourceSnapshotStable && runnerTrustRootStable && approvalSnapshotStable;
  const a0 = runA0(snapshotAfter, inputs, runnerTrustRootAfter);
  if (mode === 'bootstrap') {
    a0.status = 'FAIL';
    a0.trustStatus = 'FAIL';
    a0.nextActionCode = a0.nextActionCode ?? 'FIX_STAGE_INPUT_REGISTRY';
    a0.bootstrap = true;
  }
  if (!sourceStable) {
    a0.status = 'FAIL';
    a0.trustStatus = 'FAIL';
    a0.nextActionCode = 'FIX_SOURCE_SNAPSHOT_TRUST';
    a0.assertions = a0.assertions.map((item) => ({
      ...item,
      status: 'FAIL',
      reason: !sourceSnapshotStable
        ? 'source snapshot drifted while preparing A0'
        : !runnerTrustRootStable
          ? 'runner trust root drifted while preparing A0'
          : 'dirty worktree approval snapshot drifted while preparing A0'
    }));
  }
  const published = publishRun(
    snapshotAfter,
    inputs,
    a0,
    mode,
    quarantinePath,
    sourceStable,
    runnerTrustRootAfter,
    runnerTrustRootStable
  );
  printJson({
    ok: false,
    code: a0.status === 'PASS' ? 'A0_ONLY_PRODUCT_STAGES_PENDING' : 'A0_TRUST_ROOT_INCOMPLETE',
    mode,
    stage: a0.stage,
    stageStatus: a0.status,
    nextActionCode: a0.nextActionCode,
    evidenceDir: published.directory,
    summaryPath: published.summaryPath,
    stateSha256: published.stateSha256,
    summarySha256: published.summarySha256,
    sourceSnapshotSha256: snapshotAfter.sourceSnapshotSha256,
    sourceStable
  });
  process.exitCode = 1;
}

main().catch((error) => {
  printJson({
    ok: false,
    code: error?.code ?? 'MISSION1_ACCEPTANCE_RUNNER_ERROR',
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 2;
});

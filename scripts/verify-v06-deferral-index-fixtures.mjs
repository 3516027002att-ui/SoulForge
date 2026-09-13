#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildDeferralIndexSection } from './generate-handoff-projection.mjs';

const scriptPath = fileURLToPath(new URL('./verify-v06-deferral-index.mjs', import.meta.url));

const authority = {
  scope: {
    schemaVersion: '2.0.0',
    scopeItems: [
      {
        scopeItemId: 'SCOPE-FIXTURE-A',
        proposedSupport: 'deferred',
        deferredToRelease: 'V0.6',
        authorityAtRuling: 'candidate',
        deferredTrack: 'fixture-track-a',
        operations: [],
        resumeRequires: ['fixture-input-a']
      },
      {
        scopeItemId: 'SCOPE-FIXTURE-B',
        proposedSupport: 'deferred',
        deferredToRelease: 'V0.7',
        authorityAtRuling: 'unverified',
        deferredTrack: 'fixture-track-b',
        operations: [],
        resumeRequires: ['fixture-input-b']
      },
      {
        scopeItemId: 'SCOPE-FIXTURE-READY',
        proposedSupport: 'supported',
        targetRelease: 'V0.5',
        operations: ['read'],
        resumeRequires: []
      }
    ]
  },
  gates: {
    gates: [
      {
        gateId: 'REL-FIXTURE',
        targetRelease: 'V0.7',
        gateState: 'deferred',
        applicability: 'deferred',
        scopeItemIds: ['SCOPE-FIXTURE-B'],
        sliceRefs: ['W-FIXTURE-B']
      },
      {
        gateId: 'REL-READY',
        targetRelease: 'V0.5',
        gateState: 'open',
        applicability: 'in-scope',
        scopeItemIds: [],
        sliceRefs: []
      }
    ]
  },
  slices: {
    slices: [
      {
        sliceId: 'W-FIXTURE-B',
        targetRelease: 'V0.7',
        lifecycle: 'deferred',
        blockerRefs: ['fixture-blocker']
      },
      {
        sliceId: 'W-READY',
        targetRelease: 'V0.5',
        lifecycle: 'ready',
        blockerRefs: []
      }
    ]
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runFixture(governanceRoot, handoffPath) {
  const result = spawnSync(process.execPath, [
    scriptPath,
    `--input=${handoffPath}`,
    `--governance-root=${governanceRoot}`
  ], { encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(result.stdout.trim(), `校验脚本没有输出 JSON：${result.stderr}`);
  return {
    status: result.status,
    report: JSON.parse(result.stdout)
  };
}

function writeAuthority(governanceRoot, data) {
  writeFileSync(join(governanceRoot, 'scope.json'), JSON.stringify(data.scope, null, 2));
  writeFileSync(join(governanceRoot, 'gates.json'), JSON.stringify(data.gates, null, 2));
  writeFileSync(join(governanceRoot, 'slices.json'), JSON.stringify(data.slices, null, 2));
}

const tempRoot = mkdtempSync(join(tmpdir(), 'soulforge-v06-deferral-'));
const governanceRoot = join(tempRoot, 'governance');
const handoffPath = join(tempRoot, 'handoff.md');
try {
  // 双版本有效场景：权威条目各自带目标版本，非 deferred 条目被忽略。
  const valid = clone(authority);
  const projection = buildDeferralIndexSection(valid.scope, valid.gates, valid.slices);
  assert.match(projection, /^### 18\.5 V0\.6 \/ V0\.7 延期承接索引/m);
  assert.ok(projection.includes('| `SCOPE-FIXTURE-A` | V0.6 | `candidate` | fixture-track-a |'));
  assert.match(projection, /恢复时按该条目在 scope\.json 登记的全部 `resumeRequires` 验证/);
  assert.match(projection, /当前输入、适用范围与 `fresh` 均一致时可复用/);
  assert.doesNotMatch(projection, /必须重跑/);
  mkdirSync(governanceRoot);
  writeAuthority(governanceRoot, valid);
  writeFileSync(handoffPath, projection);
  const validRun = runFixture(governanceRoot, handoffPath);
  assert.equal(validRun.status, 0, JSON.stringify(validRun.report, null, 2));
  assert.equal(validRun.report.ok, true);
  assert.deepEqual(validRun.report.targetVersions, ['V0.6', 'V0.7']);
  assert.deepEqual(validRun.report.deferredCounts, {
    scopeItems: 2,
    gates: 1,
    slices: 1,
    previews: 0
  });
  assert.equal(validRun.report.resumeRequirements.checkedScopeItems, 2);
  assert.equal(validRun.report.resumeRequirements.nonEmptyPerDeferredScope, true);
  assert.deepEqual(validRun.report.vacuousSources, ['延期只读预览编辑器']);
  assert.ok(validRun.report.reconciliationScale.some((entry) =>
    entry.label === '延期只读预览编辑器' && entry.vacuous === true
  ));

  // 权威目标版本漂移时，旧投影必须失败关闭。
  const targetMismatch = clone(authority);
  targetMismatch.scope.scopeItems[1].deferredToRelease = 'V0.8';
  writeAuthority(governanceRoot, targetMismatch);
  const mismatchRun = runFixture(governanceRoot, handoffPath);
  assert.equal(mismatchRun.status, 1, JSON.stringify(mismatchRun.report, null, 2));
  assert.equal(mismatchRun.report.ok, false);
  assert.ok(mismatchRun.report.findings.some((finding) =>
    finding.code === 'DEFERRAL_INDEX_TARGET_MISMATCH'
  ));

  // 空的 gate/slice 权威与“无”投影是显式 vacuous 边界，不能被当成覆盖证明。
  const vacuous = clone(authority);
  vacuous.gates.gates = [];
  vacuous.slices.slices = [];
  writeAuthority(governanceRoot, vacuous);
  writeFileSync(
    handoffPath,
    projection
      .replace('延期 Gate（V0.7）：`REL-FIXTURE`。', '延期 Gate（V0.7）：无。')
      .replace('延期切片（V0.7）：`W-FIXTURE-B`。', '延期切片（V0.7）：无。')
  );
  const vacuousRun = runFixture(governanceRoot, handoffPath);
  assert.equal(vacuousRun.status, 0, JSON.stringify(vacuousRun.report, null, 2));
  assert.deepEqual(vacuousRun.report.vacuousSources, [
    '延期 Gate',
    '延期切片',
    '延期只读预览编辑器'
  ]);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('[verify-v06-deferral-index-fixtures] PASS: multi-target authority, target mismatch fail-closed, resume requirements, and explicit vacuous boundaries');

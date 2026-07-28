import {
  computeHandoffFingerprintSha256,
  governanceEnums,
  validateHandoffGovernance
} from './handoff-integrity-lib.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const SEAL_FIELDS = {
  head: '1'.repeat(40),
  trackedDiffSha256: HASH_A,
  untrackedManifestSha256: HASH_B,
  handoffSha256BeforeEvidenceAppend: HASH_C
};
const VALID_SEAL = [
  `HEAD=${SEAL_FIELDS.head}`,
  `trackedDiffSha256=${SEAL_FIELDS.trackedDiffSha256}`,
  `untrackedManifestSha256=${SEAL_FIELDS.untrackedManifestSha256}`,
  `handoffSha256BeforeEvidenceAppend=${SEAL_FIELDS.handoffSha256BeforeEvidenceAppend}`,
  `fingerprintSha256=${computeHandoffFingerprintSha256(SEAL_FIELDS)}`
].join('; ');

const sliceIdByGate = new Map(governanceEnums.requiredGateIds.map((gateId) => [
  gateId,
  `W-${gateId.replace('REL-', '')}-01`
]));
sliceIdByGate.set('REL-SCOPE', 'W-SCOPE-01');
const baseSlices = governanceEnums.requiredGateIds.map((gateId) => ({
  id: sliceIdByGate.get(gateId),
  lifecycle: 'ready',
  authority: 'partial',
  blockers: '—',
  cap: 'partial'
}));
const baseGates = governanceEnums.requiredGateIds.map((gateId) => ({
  id: gateId,
  slices: `\`${sliceIdByGate.get(gateId)}\``,
  state: 'open',
  applicability: ['REL-SCOPE', 'REL-A', 'REL-H', 'REL-COMPLIANCE'].includes(gateId)
    ? 'in-scope'
    : 'pending-scope',
  refs: '—'
}));
const baseEvidence = [
  {
    id: 'EV-SEALED-01',
    type: 'sealed-current-run',
    claim: 'scope-ruling:user-approved scope-exclusion:REL-B:user-approved',
    baseline: VALID_SEAL
  },
  { id: 'EV-UNSEALED-01', type: 'unsealed-record', claim: '旧记录', baseline: '旧工作树，未封存' }
];
const baseBlockers = [
  {
    id: 'BLK-PRIVATE-01',
    reason: 'private-corpus',
    impacts: '`REL-B`、`W-B-01`',
    owner: 'fixture owner',
    input: 'fixture input',
    validation: 'fixture validation',
    trigger: 'fixture trigger',
    evidence: '—'
  }
];

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function buildDocument(options = {}) {
  const slices = options.slices ?? cloneRows(baseSlices);
  const gates = options.gates ?? cloneRows(baseGates);
  const releaseGateIds = options.releaseGateIds ?? gates.map((gate) => gate.id);
  const evidence = options.evidence ?? cloneRows(baseEvidence);
  const blockers = options.blockers ?? cloneRows(baseBlockers);
  const claims = options.claims ?? [];

  const sliceRows = slices.map((slice) =>
    `| \`${slice.id}\` | \`${slice.lifecycle}\` | \`${slice.authority}\` | ${slice.blockers} | 目标 | 可验收切片 | 前置 | 入口 | 验证 | cap=${slice.cap ?? 'partial'} |`
  );
  const evidenceRows = evidence.map((record) =>
    `| \`${record.id}\` | \`${record.type}\` | ${record.claim ?? '声明'} | ${record.baseline} | 命令 | 范围 | 边界 |`
  );
  const releaseRows = releaseGateIds.map((id) =>
    `| \`${id}\` | 范围 | 通过条件 | 阻止条件 |`
  );
  const gateRows = gates.map((gate) =>
    `| \`${gate.id}\` | capability | ${gate.slices} | \`${gate.state}\` | \`${gate.applicability}\` | ${gate.refs} | 后继 |`
  );
  const blockerRows = blockers.map((blocker) =>
    `| \`${blocker.id}\` | \`${blocker.reason}\` | ${blocker.impacts ?? '`REL-B`、`W-B-01`'} | ${blocker.owner ?? 'owner'} | ${blocker.input ?? 'input'} | ${blocker.validation ?? 'validation'} | ${blocker.trigger ?? 'trigger'} | ${blocker.evidence} |`
  );
  const claimRows = claims.length > 0
    ? claims.map((claim) =>
      `| \`${claim.sliceId}\` | ${claim.claimId} | ${claim.owner} | ${claim.claimedAt} | ${claim.heartbeatAt} | ${claim.recoveryTrigger} |`
    )
    : ['| — | — | — | — | — | — |'];

  return [
    '# fixture',
    '',
    '### 13.1 当前执行面板',
    '',
    '| 切片 ID | lifecycle | authority | blockerRefs | 目标能力 | 可独立验收切片 | 硬前置 | 主要入口 | required validation | authority 上限 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...sliceRows,
    '',
    '### 13.1.1 Active claim 注册表',
    '',
    '| sliceId | claimId | owner | claimedAt | heartbeatAt | recoveryTrigger |',
    '|---|---|---|---|---|---|',
    ...claimRows,
    '',
    '### 17.1 当前证据索引',
    '',
    '| Evidence ID | 类型 | 能力/声明 | 基线 | 命令或记录 | 样本/范围 | 本轮结论与边界 |',
    '|---|---|---|---|---|---|---|',
    ...evidenceRows,
    '',
    '### 18.1 可判定的发布门槛',
    '',
    '| Gate ID | 必须冻结的范围 | 通过条件 | 阻止通过的证据 |',
    '|---|---|---|---|',
    ...releaseRows,
    '',
    '### 18.3 Gate 覆盖矩阵与后继切片',
    '',
    '| Gate ID | capability | 当前切片 | gateState | applicability | Evidence/blockerRefs | 后继要求 |',
    '|---|---|---|---|---|---|---|',
    ...gateRows,
    '',
    '### 18.4 结构化 blocker',
    '',
    '| blockerId | reason | 影响 Gate/切片 | 责任方 | 所需输入 | 解锁验证 | 复查触发器 | Evidence |',
    '|---|---|---|---|---|---|---|---|',
    ...blockerRows,
    ''
  ].join('\n');
}

const executedCases = [];

function assertPass(name, document, options = {}) {
  const result = validateHandoffGovernance(document, { source: `fixture:${name}`, ...options });
  if (!result.ok) {
    throw new Error(`${name} 应通过，但得到：\n${JSON.stringify(result.findings, null, 2)}`);
  }
  executedCases.push({ name, expected: 'pass' });
}

function assertCodes(name, document, expectedCodes, options = {}) {
  const result = validateHandoffGovernance(document, { source: `fixture:${name}`, ...options });
  const actualCodes = new Set(result.findings.map((finding) => finding.code));
  const missing = expectedCodes.filter((code) => !actualCodes.has(code));
  if (result.ok || missing.length > 0) {
    throw new Error(
      `${name} 未命中预期错误码 ${missing.join(', ') || '(文档意外通过)'}：\n` +
      JSON.stringify(result.findings, null, 2)
    );
  }
  executedCases.push({ name, expectedCodes });
}

assertPass('minimal-open', buildDocument());

assertPass('w-rel-slice-id-is-not-a-gate-id', buildDocument({
  slices: cloneRows(baseSlices).map((slice) => slice.id === 'W-B-01'
    ? {
        ...slice,
        id: 'W-REL-B-CORPUS-01',
        lifecycle: 'blocked',
        authority: 'unverified',
        blockers: '`BLK-PRIVATE-01`'
      }
    : slice),
  gates: cloneRows(baseGates).map((gate) => gate.id === 'REL-B'
    ? {
        ...gate,
        slices: '`W-REL-B-CORPUS-01`',
        state: 'blocked',
        refs: '`BLK-PRIVATE-01`'
      }
    : gate),
  blockers: [{
    ...baseBlockers[0],
    impacts: '`REL-B`、`W-REL-B-CORPUS-01`'
  }]
}));

assertPass('scoped-exclusion-after-scope-pass', buildDocument({
  slices: cloneRows(baseSlices).map((slice) => {
    if (slice.id === 'W-SCOPE-01') return { ...slice, lifecycle: 'completed' };
    if (slice.id === 'W-B-01') {
      return { ...slice, lifecycle: 'blocked', authority: 'unverified', blockers: '`BLK-PRIVATE-01`' };
    }
    return slice;
  }),
  gates: cloneRows(baseGates).map((gate) => {
    if (gate.id === 'REL-SCOPE') {
      return { ...gate, state: 'passed', applicability: 'in-scope', refs: '`EV-SEALED-01`' };
    }
    if (gate.id === 'REL-B') {
      return { ...gate, state: 'passed', applicability: 'scope-excluded', refs: '`EV-SEALED-01`' };
    }
    return { ...gate, applicability: 'in-scope' };
  })
}));

assertCodes('invalid-lifecycle', buildDocument({
  slices: [
    { id: 'W-SCOPE-01', lifecycle: 'queued', authority: 'partial', blockers: '—' },
    ...cloneRows(baseSlices).slice(1)
  ]
}), ['SLICE_LIFECYCLE_INVALID']);

assertCodes('invalid-authority', buildDocument({
  slices: [
    { id: 'W-SCOPE-01', lifecycle: 'ready', authority: 'production-ready', blockers: '—' },
    ...cloneRows(baseSlices).slice(1)
  ]
}), ['SLICE_AUTHORITY_INVALID']);

assertCodes('completed-slice-covers-open-even-with-live-slice', buildDocument({
  slices: [
    ...cloneRows(baseSlices),
    { id: 'W-DONE-01', lifecycle: 'completed', authority: 'fixture-confirmed', blockers: '—' }
  ],
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`、`W-DONE-01`', state: 'open', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_OPEN_TERMINAL_SLICE']);

assertCodes('open-gate-without-live-slice', buildDocument({
  slices: [
    cloneRows(baseSlices)[0],
    { id: 'W-A-01', lifecycle: 'blocked', authority: 'unverified', blockers: '`BLK-PRIVATE-01`' }
  ]
}), ['GATE_OPEN_NO_LIVE_SLICE']);

assertCodes('blocked-slice-without-blocker', buildDocument({
  slices: [
    cloneRows(baseSlices)[0],
    { id: 'W-A-01', lifecycle: 'blocked', authority: 'unverified', blockers: '—' }
  ],
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'blocked', applicability: 'in-scope', refs: '`BLK-PRIVATE-01`' }
  ]
}), ['SLICE_BLOCKER_REQUIRED']);

assertCodes('blocked-slice-with-unknown-blocker', buildDocument({
  slices: [
    cloneRows(baseSlices)[0],
    { id: 'W-A-01', lifecycle: 'blocked', authority: 'unverified', blockers: '`BLK-UNKNOWN-01`' }
  ],
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'blocked', applicability: 'in-scope', refs: '`BLK-PRIVATE-01`' }
  ]
}), ['SLICE_BLOCKER_UNDEFINED', 'BLOCKER_REF_UNDEFINED']);

assertCodes('blocked-gate-without-blocker', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'blocked', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_BLOCKER_REQUIRED']);

assertCodes('blocked-gate-with-unknown-blocker', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'blocked', applicability: 'in-scope', refs: '`BLK-UNKNOWN-01`' }
  ]
}), ['GATE_BLOCKER_UNDEFINED', 'BLOCKER_REF_UNDEFINED']);

assertCodes('passed-gate-without-evidence', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'passed', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_PASSED_EVIDENCE_REQUIRED']);

assertCodes('passed-gate-with-unknown-evidence', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'passed', applicability: 'in-scope', refs: '`EV-UNKNOWN-01`' }
  ]
}), ['GATE_EVIDENCE_UNDEFINED', 'EVIDENCE_ID_UNDEFINED']);

assertCodes('passed-gate-with-unsealed-evidence', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'passed', applicability: 'in-scope', refs: '`EV-UNSEALED-01`' }
  ]
}), ['GATE_EVIDENCE_UNSEALED']);

assertCodes('fake-sealed-evidence-without-seal-fields', buildDocument({
  evidence: [
    ...cloneRows(baseEvidence),
    { id: 'EV-BAD-SEAL-01', type: 'sealed-current-run', baseline: 'HEAD=abc' }
  ],
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'passed', applicability: 'in-scope', refs: '`EV-BAD-SEAL-01`' }
  ]
}), ['EVIDENCE_SEAL_INVALID', 'GATE_EVIDENCE_UNSEALED']);

assertCodes('scope-excluded-before-scope-pass', buildDocument({
  slices: [
    cloneRows(baseSlices)[0],
    { id: 'W-B-01', lifecycle: 'blocked', authority: 'unverified', blockers: '`BLK-PRIVATE-01`' }
  ],
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-B', slices: '`W-B-01`', state: 'passed', applicability: 'scope-excluded', refs: '`EV-SEALED-01`' }
  ]
}), ['GATE_SCOPE_PREREQUISITE_NOT_PASSED']);

assertCodes('non-excludable-base-gate', buildDocument({
  slices: [
    { id: 'W-SCOPE-01', lifecycle: 'completed', authority: 'partial', blockers: '—' },
    { id: 'W-A-01', lifecycle: 'completed', authority: 'partial', blockers: '—' }
  ],
  gates: [
    { id: 'REL-SCOPE', slices: '`W-SCOPE-01`', state: 'passed', applicability: 'in-scope', refs: '`EV-SEALED-01`' },
    { id: 'REL-A', slices: '`W-A-01`', state: 'passed', applicability: 'scope-excluded', refs: '`EV-SEALED-01`' }
  ]
}), ['GATE_BASE_SCOPE_EXCLUSION_FORBIDDEN']);

assertCodes('invalid-blocker-reason', buildDocument({
  blockers: [{ id: 'BLK-PRIVATE-01', reason: 'waiting', evidence: '—' }]
}), ['BLOCKER_REASON_INVALID']);

assertCodes('duplicate-blocker-id', buildDocument({
  blockers: [
    ...cloneRows(baseBlockers),
    { id: 'BLK-PRIVATE-01', reason: 'credential', evidence: '—' }
  ]
}), ['BLOCKER_ID_DUPLICATE']);

assertCodes('legacy-gate-state', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'covered-open', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_STATE_LEGACY_TOKEN']);

assertCodes('legacy-blocked-token', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'blocked:credential', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_STATE_LEGACY_TOKEN']);

assertCodes('open-gate-with-unknown-slice', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-UNKNOWN-01`', state: 'open', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_SLICE_UNKNOWN', 'GATE_OPEN_NO_LIVE_SLICE']);

assertCodes('open-gate-cannot-be-scope-excluded', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'open', applicability: 'scope-excluded', refs: '—' }
  ]
}), ['GATE_OPEN_SCOPE_EXCLUDED', 'GATE_SCOPE_EXCLUDED_STATE_INVALID']);

assertCodes('pending-scope-cannot-pass', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'passed', applicability: 'pending-scope', refs: '`EV-SEALED-01`' }
  ]
}), ['GATE_PENDING_SCOPE_PASSED']);

assertCodes('base-gate-cannot-remain-pending-scope', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'open', applicability: 'pending-scope', refs: '—' }
  ]
}), ['GATE_BASE_APPLICABILITY_INVALID']);

assertCodes('invalid-applicability', buildDocument({
  gates: [
    cloneRows(baseGates)[0],
    { id: 'REL-A', slices: '`W-A-01`', state: 'open', applicability: 'maybe', refs: '—' }
  ]
}), ['GATE_APPLICABILITY_INVALID']);

assertCodes('matrix-extra-gate', buildDocument({
  releaseGateIds: ['REL-SCOPE'],
  gates: cloneRows(baseGates)
}), ['GATE_MATRIX_EXTRA']);

assertCodes('matrix-missing-gate', buildDocument({
  releaseGateIds: ['REL-SCOPE', 'REL-A'],
  gates: [cloneRows(baseGates)[0]]
}), ['GATE_MISSING_IN_MATRIX']);

assertCodes('matrix-duplicate-gate', buildDocument({
  releaseGateIds: ['REL-SCOPE', 'REL-A'],
  gates: [
    ...cloneRows(baseGates),
    { id: 'REL-A', slices: '`W-A-01`', state: 'open', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_MATRIX_DUPLICATE']);

assertCodes('duplicate-evidence-id', buildDocument({
  evidence: [
    ...cloneRows(baseEvidence),
    { id: 'EV-SEALED-01', type: 'historical-record', baseline: '历史记录' }
  ]
}), ['EVIDENCE_ID_DUPLICATE']);

assertCodes('sealed-fingerprint-mismatch', buildDocument({
  evidence: [
    {
      id: 'EV-SEALED-01',
      type: 'sealed-current-run',
      claim: '普通公开验证',
      baseline: VALID_SEAL.replace(/fingerprintSha256=[0-9a-f]{64}/, `fingerprintSha256=${HASH_A}`)
    }
  ]
}), ['EVIDENCE_FINGERPRINT_MISMATCH']);

assertCodes('fixed-gate-universe-cannot-shrink', buildDocument({
  slices: [{ id: 'W-SCOPE-01', lifecycle: 'ready', authority: 'partial', blockers: '—', cap: 'partial' }],
  releaseGateIds: ['REL-SCOPE'],
  gates: [
    { id: 'REL-SCOPE', slices: '`W-SCOPE-01`', state: 'open', applicability: 'in-scope', refs: '—' }
  ]
}), ['GATE_REQUIRED_MISSING']);

assertCodes('blocked-gate-cannot-hide-ready-slice', buildDocument({
  gates: cloneRows(baseGates).map((gate) => gate.id === 'REL-B'
    ? { ...gate, state: 'blocked', refs: '`BLK-PRIVATE-01`' }
    : gate)
}), ['GATE_BLOCKED_NONBLOCKED_SLICE', 'GATE_BLOCKED_NO_BLOCKED_SLICE']);

assertCodes('blocker-unlock-fields-required', buildDocument({
  blockers: [{ ...cloneRows(baseBlockers)[0], owner: '—' }]
}), ['BLOCKER_FIELD_REQUIRED']);

assertCodes('authority-cannot-exceed-cap', buildDocument({
  slices: cloneRows(baseSlices).map((slice) => slice.id === 'W-A-01'
    ? { ...slice, authority: 'native-verified', cap: 'unsupported' }
    : slice)
}), ['SLICE_AUTHORITY_EXCEEDS_CAP']);

assertCodes('active-slice-requires-claim', buildDocument({
  slices: cloneRows(baseSlices).map((slice) => slice.id === 'W-A-01'
    ? { ...slice, lifecycle: 'active' }
    : slice)
}), ['ACTIVE_SLICE_CLAIM_REQUIRED']);

const passedScopeSlices = cloneRows(baseSlices).map((slice) => slice.id === 'W-SCOPE-01'
  ? { ...slice, lifecycle: 'completed' }
  : slice);
const passedScopeGates = cloneRows(baseGates).map((gate) => gate.id === 'REL-SCOPE'
  ? { ...gate, state: 'passed', refs: '`EV-SEALED-01`' }
  : { ...gate, applicability: 'in-scope' });

assertCodes('scope-pass-requires-user-ruling-evidence', buildDocument({
  slices: passedScopeSlices,
  gates: passedScopeGates,
  evidence: [{ id: 'EV-SEALED-01', type: 'sealed-current-run', claim: '普通公开验证', baseline: VALID_SEAL }]
}), ['GATE_SCOPE_RULING_EVIDENCE_REQUIRED']);

assertCodes(
  'passed-gate-evidence-invalidated-by-worktree-drift',
  buildDocument({ slices: passedScopeSlices, gates: passedScopeGates }),
  ['GATE_EVIDENCE_STALE'],
  {
    currentFingerprint: {
      head: SEAL_FIELDS.head,
      trackedDiffSha256: HASH_C,
      untrackedManifestSha256: SEAL_FIELDS.untrackedManifestSha256
    }
  }
);

console.log(JSON.stringify({ ok: true, caseCount: executedCases.length, cases: executedCases }, null, 2));

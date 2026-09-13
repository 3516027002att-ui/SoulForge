#!/usr/bin/env node
/**
 * §18.5 延期承接索引投影校验。
 *
 * scope.json、gates.json、slices.json 是唯一机器可读权威；§18.5 只是一份
 * 人读投影。这里不固定 V0.6，也不把其它 handoff 表、editor protocol 或
 * 历史文字当成延期状态来源。旧入口 `node scripts/verify-v06-deferral-index.mjs`
 * 仍然有效，并额外支持 `--input=` 与 `--governance-root=` 供 fixture 使用。
 */

import { readFileSync } from 'node:fs';
import {
  collectDeferredAuthority,
  extractSection,
  GATES_AUTHORITY,
  loadGovernanceSources,
  parseGateRows,
  parsePreviewRows,
  parseScopeRows,
  parseSliceRows,
  SCOPE_AUTHORITY,
  SLICES_AUTHORITY,
  targetVersionsOf,
  VERSION_PATTERN
} from './governance/deferrals.mjs';

const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
const root = process.cwd();
const cliArgs = process.argv.slice(2);
const inputArgs = cliArgs.filter((arg) => arg.startsWith('--input='));
const governanceArgs = cliArgs.filter((arg) => arg.startsWith('--governance-root='));
const handoffInput = inputArgs.length === 1
  ? inputArgs[0].slice('--input='.length)
  : HANDOFF;
const governanceRoot = governanceArgs.length === 1
  ? governanceArgs[0].slice('--governance-root='.length)
  : null;

const findings = [];
const add = (code, where, message, details = undefined) => findings.push({
  severity: 'error',
  code,
  where,
  message,
  ...(details === undefined ? {} : { details })
});

const emptySources = {
  paths: {
    scope: governanceRoot ?? SCOPE_AUTHORITY,
    gates: governanceRoot ?? GATES_AUTHORITY,
    slices: governanceRoot ?? SLICES_AUTHORITY
  },
  scopeData: null,
  gatesData: null,
  slicesData: null
};

let sources = emptySources;
try {
  sources = loadGovernanceSources(root, governanceRoot);
} catch (error) {
  add(
    'GOVERNANCE_AUTHORITY_UNREADABLE',
    governanceRoot ?? 'docs/governance',
    `延期权威 JSON 读取失败：${error.message}`
  );
}

let markdown = null;
try {
  markdown = readFileSync(handoffInput, 'utf8');
} catch (error) {
  add('HANDOFF_INPUT_UNREADABLE', handoffInput, `交接书投影读取失败：${error.message}`);
}

const indexSection = markdown === null ? null : extractSection(markdown, '18.5');
if (indexSection === null) {
  add(
    'DEFERRAL_INDEX_SECTION_MISSING',
    `${handoffInput} §18.5`,
    '未找到 §18.5 延期承接索引投影。'
  );
}

const scopeItems = Array.isArray(sources.scopeData?.scopeItems)
  ? sources.scopeData.scopeItems
  : null;
const gates = Array.isArray(sources.gatesData?.gates) ? sources.gatesData.gates : null;
const slices = Array.isArray(sources.slicesData?.slices) ? sources.slicesData.slices : null;
if (scopeItems === null) {
  add('SCOPE_AUTHORITY_SHAPE_INVALID', SCOPE_AUTHORITY, 'scope.json 缺少 scopeItems 数组。');
}
if (gates === null) {
  add('GATES_AUTHORITY_SHAPE_INVALID', GATES_AUTHORITY, 'gates.json 缺少 gates 数组。');
}
if (slices === null) {
  add('SLICES_AUTHORITY_SHAPE_INVALID', SLICES_AUTHORITY, 'slices.json 缺少 slices 数组。');
}

const authority = collectDeferredAuthority(sources);
const authorityScopeIds = new Set(authority.scopeItems.map((item) => item.id));
const authoritySliceIds = new Set(authority.slices.map((slice) => slice.id));

function checkUniqueIds(entries, label, where) {
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      add('DEFERRED_AUTHORITY_ID_INVALID', where, `${label} 的延期记录缺少有效 ID。`);
      continue;
    }
    if (seen.has(entry.id)) {
      add('DEFERRED_AUTHORITY_ID_DUPLICATE', `${where} ${entry.id}`, `${label} 的延期 ID 重复。`);
    }
    seen.add(entry.id);
  }
}

function checkTarget(entry, label, where) {
  if (typeof entry.targetRelease !== 'string' || !VERSION_PATTERN.test(entry.targetRelease)) {
    add(
      'DEFERRED_TARGET_RELEASE_INVALID',
      `${where} ${entry.id ?? '(unknown)'}`,
      `${label} 必须声明形如 V<major>.<minor> 的 deferredToRelease/targetRelease，实际为 ${entry.targetRelease ?? '(空)' }。`
    );
  }
}

checkUniqueIds(authority.scopeItems, '范围条目', SCOPE_AUTHORITY);
for (const item of authority.scopeItems) {
  checkTarget(item, '延期范围条目', SCOPE_AUTHORITY);
  if (!Array.isArray(item.operations) || item.operations.length !== 0) {
    add(
      'DEFERRED_SCOPE_OPERATIONS_NONEMPTY',
      `${SCOPE_AUTHORITY} ${item.id}`,
      'deferred 范围条目的 operations 必须为空。'
    );
  }
  if (!Array.isArray(item.resumeRequires)
    || item.resumeRequires.length === 0
    || item.resumeRequires.some((requirement) => typeof requirement !== 'string' || requirement.trim().length === 0)) {
    add(
      'DEFERRED_RESUME_REQUIREMENTS_MISSING',
      `${SCOPE_AUTHORITY} ${item.id}`,
      '每个 deferred 范围条目必须保留至少一个非空 resumeRequires。'
    );
  }
}

checkUniqueIds(authority.gates, 'Gate', GATES_AUTHORITY);
for (const gate of authority.gates) {
  checkTarget(gate, '延期 Gate', GATES_AUTHORITY);
  if (gate.gateState !== 'deferred' || gate.applicability !== 'deferred') {
    add(
      'DEFERRED_GATE_STATE_PAIR_INVALID',
      `${GATES_AUTHORITY} ${gate.id}`,
      '延期 Gate 必须同时使用 gateState=deferred 与 applicability=deferred。'
    );
  }
  if (Array.isArray(gate.scopeItemIds)) {
    for (const id of gate.scopeItemIds) {
      if (!authorityScopeIds.has(id)) {
        add(
          'DEFERRED_GATE_SCOPE_NOT_DEFERRED',
          `${GATES_AUTHORITY} ${gate.id}`,
          `延期 Gate 引用了非 deferred 范围条目：${id}。`
        );
      }
    }
  }
  if (Array.isArray(gate.sliceRefs)) {
    for (const id of gate.sliceRefs) {
      if (!authoritySliceIds.has(id)) {
        add(
          'DEFERRED_GATE_SLICE_NOT_DEFERRED',
          `${GATES_AUTHORITY} ${gate.id}`,
          `延期 Gate 引用了非 deferred 切片：${id}。`
        );
      }
    }
  }
}

checkUniqueIds(authority.slices, '切片', SLICES_AUTHORITY);
for (const slice of authority.slices) checkTarget(slice, '延期切片', SLICES_AUTHORITY);
checkUniqueIds(authority.previews, '延期只读预览编辑器', SCOPE_AUTHORITY);
for (const preview of authority.previews) checkTarget(preview, '延期只读预览编辑器', SCOPE_AUTHORITY);

const reconciliationScale = [];
function compareIds(label, where, authoritativeEntries, indexedEntries) {
  const authoritative = new Set(authoritativeEntries.map((entry) => entry.id));
  const indexed = new Set(indexedEntries.keys());
  const missing = [...authoritative].filter((id) => !indexed.has(id)).sort();
  const extra = [...indexed].filter((id) => !authoritative.has(id)).sort();
  const vacuous = authoritative.size === 0 && indexed.size === 0;
  reconciliationScale.push({
    label,
    authoritative: authoritative.size,
    indexed: indexed.size,
    vacuous
  });
  if (missing.length > 0) {
    add(
      'DEFERRAL_INDEX_MISSING_ENTRY',
      where,
      `§18.5 索引缺少${label}：${missing.join(', ')}。`
    );
  }
  if (extra.length > 0) {
    add(
      'DEFERRAL_INDEX_EXTRA_ENTRY',
      where,
      `§18.5 索引多列了${label}：${extra.join(', ')}。`
    );
  }
}

function compareProjectedTargets(label, where, authoritativeEntries, indexedEntries) {
  for (const entry of authoritativeEntries) {
    const row = indexedEntries.get(entry.id);
    if (!row) continue;
    if (!row.targetVersions.includes(entry.targetRelease)) {
      add(
        'DEFERRAL_INDEX_TARGET_MISMATCH',
        `${where} ${entry.id}`,
        `${label} 投影目标版本不一致：索引=${row.targetVersions.join(', ') || '(未声明)'}，权威=${entry.targetRelease}。`
      );
    }
  }
}

const scopeProjection = parseScopeRows(indexSection);
const gateProjection = parseGateRows(indexSection);
const sliceProjection = parseSliceRows(indexSection);
const previewProjection = parsePreviewRows(indexSection);

compareIds('范围条目', `${handoffInput} §18.5`, authority.scopeItems, scopeProjection.rows);
compareProjectedTargets('范围条目', `${handoffInput} §18.5`, authority.scopeItems, scopeProjection.rows);
for (const item of authority.scopeItems) {
  const row = scopeProjection.rows.get(item.id);
  if (!row) continue;
  if (typeof item.authorityAtRuling === 'string' && !row.authority.includes(item.authorityAtRuling)) {
    add(
      'DEFERRAL_INDEX_AUTHORITY_MISMATCH',
      `${handoffInput} §18.5 ${item.id}`,
      `索引裁定 authority 与权威记录不一致：索引=${row.authority || '(空)'}，权威=${item.authorityAtRuling}。`
    );
  }
  if (typeof item.deferredTrack === 'string' && !row.track.includes(item.deferredTrack)) {
    add(
      'DEFERRAL_INDEX_TRACK_MISMATCH',
      `${handoffInput} §18.5 ${item.id}`,
      `索引归属线与权威记录不一致：索引=${row.track || '(空)'}，权威=${item.deferredTrack}。`
    );
  }
}
if (scopeProjection.duplicates.length > 0) {
  add(
    'DEFERRAL_INDEX_DUPLICATE_ENTRY',
    `${handoffInput} §18.5`,
    `范围条目在投影中重复：${[...new Set(scopeProjection.duplicates)].join(', ')}。`
  );
}

compareIds('延期 Gate', `${handoffInput} §18.5`, authority.gates, gateProjection.rows);
compareProjectedTargets('延期 Gate', `${handoffInput} §18.5`, authority.gates, gateProjection.rows);
compareIds('延期切片', `${handoffInput} §18.5`, authority.slices, sliceProjection.rows);
compareProjectedTargets('延期切片', `${handoffInput} §18.5`, authority.slices, sliceProjection.rows);
compareIds('延期只读预览编辑器', `${handoffInput} §18.5`, authority.previews, previewProjection.rows);
compareProjectedTargets('延期只读预览编辑器', `${handoffInput} §18.5`, authority.previews, previewProjection.rows);
for (const [label, projection] of [
  ['延期 Gate', gateProjection],
  ['延期切片', sliceProjection],
  ['延期只读预览编辑器', previewProjection]
]) {
  if (projection.duplicates.length > 0) {
    add(
      'DEFERRAL_INDEX_DUPLICATE_ENTRY',
      `${handoffInput} §18.5`,
      `${label} 在投影中重复：${[...new Set(projection.duplicates)].join(', ')}。`
    );
  }
}

const allTargets = targetVersionsOf(authority);
if (markdown !== null) {
  const heading = /(?:^|\n)#{3,4}\s*18\.5\s*([^\n]*)/m.exec(markdown)?.[1] ?? '';
  const headingTargets = new Set([...heading.matchAll(/V\d+\.\d+/g)].map((match) => match[0]));
  if (headingTargets.size > 0 && (headingTargets.size !== allTargets.length
    || [...headingTargets].some((target) => !allTargets.includes(target)))) {
    add(
      'DEFERRAL_INDEX_HEADING_TARGET_MISMATCH',
      `${handoffInput} §18.5`,
      `标题中的目标版本 ${[...headingTargets].join(', ')} 与权威延期目标 ${allTargets.join(', ') || '(无)'} 不一致。`
    );
  }
}

// §18.5 的说明文字是人读边界，不是第三份状态权威。延期身份、目标版本、
// authority、归属线与 resumeRequires 已在上面的 JSON 对账中结构化校验；这里
// 不用固定中文措辞判断投影是否正确，避免同义改写把有效投影误判为失败。

const ok = findings.length === 0;
const deferredCounts = {
  scopeItems: authority.scopeItems.length,
  gates: authority.gates.length,
  slices: authority.slices.length,
  previews: authority.previews.length
};
process.stdout.write(`${JSON.stringify({
  ok,
  authority: 'docs/governance/scope.json + docs/governance/gates.json + docs/governance/slices.json',
  checkedSources: [
    `${SCOPE_AUTHORITY}（proposedSupport/deferredToRelease/authorityAtRuling/deferredTrack/operations/resumeRequires/deferredPreviewEditors）`,
    `${GATES_AUTHORITY}（gateState/applicability/targetRelease/scopeItemIds/sliceRefs）`,
    `${SLICES_AUTHORITY}（lifecycle/targetRelease）`
  ],
  projection: `${handoffInput} §18.5`,
  deferredCounts,
  targetVersions: allTargets,
  resumeRequirements: {
    checkedScopeItems: authority.scopeItems.length,
    nonEmptyPerDeferredScope: authority.scopeItems.every((item) => Array.isArray(item.resumeRequires) && item.resumeRequires.length > 0)
  },
  reconciliationScale,
  vacuousSources: reconciliationScale.filter((entry) => entry.vacuous).map((entry) => entry.label),
  findings,
  note: ok
    ? (reconciliationScale.some((entry) => entry.vacuous)
      ? '§18.5 仅作为三份治理 JSON 的正确投影通过；vacuousSources 表示对应权威与投影当前均为空，不构成覆盖证明。'
      : '§18.5 仅作为三份治理 JSON 的正确投影通过；延期索引不构成独立范围、进度或能力声明。')
    : '§18.5 与治理 JSON 投影不一致，失败关闭。'
}, null, 2)}\n`);
process.exit(ok ? 0 : 1);

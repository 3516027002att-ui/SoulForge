#!/usr/bin/env node
/**
 * §18.5 V0.6 延期承接索引一致性门禁。
 *
 * §18.5 是派生索引，不是第二范围口径。权威来源始终是：
 *   - §18.2.1 范围矩阵：proposedSupport=deferred + deferredToRelease
 *   - §18.3 Gate 覆盖矩阵：gateState=deferred + applicability=deferred-v0.6
 *   - §13.1 执行面板：lifecycle=deferred
 *   - packages/shared/src/editor-protocol.ts：DEFERRED_PREVIEW_EDITOR_KINDS
 *
 * 本脚本逐项双向比对索引与权威记录。缺失、多写、目标版本不符或权威侧
 * 变化后未同步索引，全部失败关闭 —— 否则索引会独立漂移成假口径。
 */

import { readFileSync } from 'node:fs';

const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
const EDITOR_PROTOCOL = 'packages/shared/src/editor-protocol.ts';
const TARGET_RELEASE = 'V0.6';

const findings = [];
const add = (code, where, message) => findings.push({ severity: 'error', code, where, message });

function extractSection(markdown, sectionId) {
  const pattern = new RegExp(
    `\\n#{3,4}\\s*${sectionId.replace('.', '\\.')}\\s[^\\n]*\\n([\\s\\S]*?)(?=\\n#{2,4}\\s|$)`
  );
  return pattern.exec(markdown)?.[1] ?? null;
}

function sortedList(values) {
  return [...values].sort().join(', ') || '(空)';
}

/** 双向集合比对：缺失与多写都是错误，方向不同诊断不同。 */
function compareSets(label, where, authoritative, indexed) {
  const missing = [...authoritative].filter((value) => !indexed.has(value));
  const extra = [...indexed].filter((value) => !authoritative.has(value));
  if (missing.length > 0) {
    add(
      'DEFERRAL_INDEX_MISSING_ENTRY',
      where,
      `§18.5 索引缺少${label}：${sortedList(missing)}；权威记录已延期但索引未列出。`
    );
  }
  if (extra.length > 0) {
    add(
      'DEFERRAL_INDEX_EXTRA_ENTRY',
      where,
      `§18.5 索引多列了${label}：${sortedList(extra)}；权威记录中它们并非 deferred。`
    );
  }
}

const markdown = readFileSync(HANDOFF, 'utf8');
const indexSection = extractSection(markdown, '18.5');
if (!indexSection) {
  add('DEFERRAL_INDEX_SECTION_MISSING', `${HANDOFF} §18.5`, '未找到 §18.5 V0.6 延期承接索引。');
  process.stdout.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`);
  process.exit(1);
}

// 索引必须自述为派生，不得被当作独立 milestone 范围文档。
if (!indexSection.includes('派生索引')) {
  add(
    'DEFERRAL_INDEX_NOT_MARKED_DERIVED',
    `${HANDOFF} §18.5`,
    '§18.5 必须显式声明自身为派生索引，否则会被读成第二范围口径。'
  );
}

// ---- 权威来源 1：§18.2.1 范围矩阵 ----
const jsonBlock = /```json\s*(\{[\s\S]*?"scopeItems"[\s\S]*?)\n```/.exec(markdown);
if (!jsonBlock) {
  add('SCOPE_MATRIX_MISSING', `${HANDOFF} §18.2.1`, '未找到范围矩阵 JSON 块。');
} else {
  let proposal;
  try {
    proposal = JSON.parse(jsonBlock[1]);
  } catch (error) {
    add('SCOPE_MATRIX_UNPARSEABLE', `${HANDOFF} §18.2.1`, `范围矩阵 JSON 解析失败：${error.message}`);
  }

  if (proposal) {
    const deferredItems = (proposal.scopeItems ?? []).filter(
      (item) => item?.proposedSupport === 'deferred'
    );
    const authoritativeIds = new Set(deferredItems.map((item) => item.scopeItemId));
    const indexedIds = new Set(
      [...indexSection.matchAll(/^\|\s*`(SCOPE-[A-Z0-9-]+)`\s*\|/gm)].map((match) => match[1])
    );
    compareSets('范围条目', `${HANDOFF} §18.5`, authoritativeIds, indexedIds);

    // 每个条目的目标版本与裁定 authority 必须与权威记录逐项一致。
    for (const item of deferredItems) {
      const row = new RegExp(
        `^\\|\\s*\`${item.scopeItemId}\`\\s*\\|([^|]*)\\|([^|]*)\\|`,
        'm'
      ).exec(indexSection);
      if (!row) continue;
      const [, releaseCell, authorityCell] = row;
      if (!releaseCell.includes(item.deferredToRelease)) {
        add(
          'DEFERRAL_INDEX_RELEASE_MISMATCH',
          `${HANDOFF} §18.5 ${item.scopeItemId}`,
          `索引目标版本与权威记录不一致：索引="${releaseCell.trim()}"、`
            + `权威=${item.deferredToRelease}。`
        );
      }
      if (item.authorityAtRuling && !authorityCell.includes(item.authorityAtRuling)) {
        add(
          'DEFERRAL_INDEX_AUTHORITY_MISMATCH',
          `${HANDOFF} §18.5 ${item.scopeItemId}`,
          `索引裁定 authority 与权威记录不一致：索引="${authorityCell.trim()}"、`
            + `权威=${item.authorityAtRuling}。`
        );
      }
      // 延期条目必须无操作；索引不得暗示本版仍有可用操作。
      if (Array.isArray(item.operations) && item.operations.length > 0) {
        add(
          'DEFERRAL_INDEX_ITEM_CLAIMS_OPERATIONS',
          `${HANDOFF} §18.2.1 ${item.scopeItemId}`,
          `deferred 条目必须 operations=[]，实际为 ${JSON.stringify(item.operations)}。`
        );
      }
    }

    if (deferredItems.length > 0 && !indexSection.includes(`${deferredItems.length} 个范围条目`)) {
      add(
        'DEFERRAL_INDEX_COUNT_MISMATCH',
        `${HANDOFF} §18.5`,
        `索引未声明与权威一致的条目总数（权威为 ${deferredItems.length} 个）。`
      );
    }
  }
}

// ---- 权威来源 2：§18.3 Gate 覆盖矩阵 ----
const gateSection = extractSection(markdown, '18.3');
if (!gateSection) {
  add('GATE_MATRIX_MISSING', `${HANDOFF} §18.3`, '未找到 Gate 覆盖矩阵。');
} else {
  const authoritativeGates = new Set(
    [...gateSection.matchAll(
      /^\|\s*`(REL-[A-Z-]+)`\s*\|[^|]*\|[^|]*\|\s*`deferred`\s*\|\s*`deferred-v0\.6`\s*\|/gm
    )].map((match) => match[1])
  );
  // 只取到第一个句号：清单是首句，后续句子用于说明未延期 Gate 为何保持 open，
  // 若把整行纳入比对，那些解释性引用会被误判成索引条目。
  const gateLine = /延期 Gate[：:]([^\n。]*)/.exec(indexSection)?.[1] ?? '';
  const indexedGates = new Set(
    [...gateLine.matchAll(/`(REL-[A-Z-]+)`/g)].map((match) => match[1])
  );
  compareSets('延期 Gate', `${HANDOFF} §18.5`, authoritativeGates, indexedGates);
}

// ---- 权威来源 3：§13.1 执行面板 ----
const sliceSection = extractSection(markdown, '13.1');
if (!sliceSection) {
  add('SLICE_TABLE_MISSING', `${HANDOFF} §13.1`, '未找到执行面板。');
} else {
  const authoritativeSlices = new Set(
    [...sliceSection.matchAll(/^\|\s*`(W-[A-Z0-9-]+)`\s*\|\s*`deferred`\s*\|/gm)]
      .map((match) => match[1])
  );
  const sliceLine = /延期切片[：:]([^\n。]*)/.exec(indexSection)?.[1] ?? '';
  const indexedSlices = new Set(
    [...sliceLine.matchAll(/`(W-[A-Z0-9-]+)`/g)].map((match) => match[1])
  );
  compareSets('延期切片', `${HANDOFF} §18.5`, authoritativeSlices, indexedSlices);
}

// ---- 权威来源 4：shared 延期预览编辑器清单 ----
const protocolSource = readFileSync(EDITOR_PROTOCOL, 'utf8');
const kindsBlock = /DEFERRED_PREVIEW_EDITOR_KINDS\s*=\s*\[([\s\S]*?)\]/.exec(protocolSource);
if (!kindsBlock) {
  add(
    'PREVIEW_EDITOR_LIST_MISSING',
    EDITOR_PROTOCOL,
    '未找到 DEFERRED_PREVIEW_EDITOR_KINDS 清单。'
  );
} else {
  const authoritativeKinds = new Set(
    [...kindsBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1])
  );
  const previewLine = /延期只读预览编辑器[：:]([^\n。]*)/.exec(indexSection)?.[1] ?? '';
  const indexedKinds = new Set(
    [...previewLine.matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1])
  );
  compareSets('延期预览编辑器', `${HANDOFF} §18.5`, authoritativeKinds, indexedKinds);

  const releaseConstant = /DEFERRED_PREVIEW_TARGET_RELEASE\s*=\s*'([^']+)'/.exec(protocolSource)?.[1];
  if (releaseConstant !== TARGET_RELEASE) {
    add(
      'PREVIEW_TARGET_RELEASE_MISMATCH',
      EDITOR_PROTOCOL,
      `DEFERRED_PREVIEW_TARGET_RELEASE 必须为 ${TARGET_RELEASE}，实际为 ${releaseConstant ?? '(未找到)'}。`
    );
  }
}

// 索引必须保留"延期 != 完成"与恢复须重新验证的边界，否则会被读成已交付承诺。
if (!/延期不清偿技术缺口/.test(indexSection)) {
  add(
    'DEFERRAL_INDEX_MISSING_NONCLAIM',
    `${HANDOFF} §18.5`,
    '§18.5 必须保留"延期不清偿技术缺口"的非声明，避免被读成能力承诺。'
  );
}
if (!/必须重跑/.test(indexSection)) {
  add(
    'DEFERRAL_INDEX_MISSING_REVERIFY_RULE',
    `${HANDOFF} §18.5`,
    '§18.5 必须写明延期期间保留的历史验证记录在恢复后必须重跑。'
  );
}

const ok = findings.length === 0;
process.stdout.write(`${JSON.stringify({
  ok,
  checkedSources: [
    `${HANDOFF} §18.2.1 范围矩阵（proposedSupport/deferredToRelease/authorityAtRuling/operations）`,
    `${HANDOFF} §18.3 Gate 覆盖矩阵（gateState/applicability）`,
    `${HANDOFF} §13.1 执行面板（lifecycle）`,
    `${EDITOR_PROTOCOL}（DEFERRED_PREVIEW_EDITOR_KINDS / DEFERRED_PREVIEW_TARGET_RELEASE）`
  ],
  findings,
  note: ok
    ? '§18.5 派生索引与全部权威记录逐项一致；索引不构成独立范围口径或能力声明。'
    : '§18.5 与权威记录不一致，失败关闭。'
}, null, 2)}\n`);
process.exit(ok ? 0 : 1);

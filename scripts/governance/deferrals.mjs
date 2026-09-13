import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const GOVERNANCE_DIR = 'docs/governance';
export const SCOPE_AUTHORITY = `${GOVERNANCE_DIR}/scope.json`;
export const GATES_AUTHORITY = `${GOVERNANCE_DIR}/gates.json`;
export const SLICES_AUTHORITY = `${GOVERNANCE_DIR}/slices.json`;
export const VERSION_PATTERN = /^V\d+\.\d+$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 读取延期索引的三份机器可读权威。governanceRoot 供负向 fixture 替换，
 * 不改变旧入口：未传入时仍从 docs/governance 读取。
 */
export function loadGovernanceSources(root = process.cwd(), governanceRoot = null) {
  const directory = governanceRoot === null
    ? resolve(root, GOVERNANCE_DIR)
    : resolve(root, governanceRoot);
  return {
    paths: {
      scope: join(directory, 'scope.json'),
      gates: join(directory, 'gates.json'),
      slices: join(directory, 'slices.json')
    },
    scopeData: readJson(join(directory, 'scope.json')),
    gatesData: readJson(join(directory, 'gates.json')),
    slicesData: readJson(join(directory, 'slices.json'))
  };
}

export function extractSection(markdown, sectionId) {
  const escaped = String(sectionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)#{3,4}\\s*${escaped}\\s[^\\n]*\\n([\\s\\S]*?)(?=\\n#{2,4}\\s|$)`
  );
  return pattern.exec(markdown)?.[1] ?? null;
}

export function versionTokens(text) {
  return [...new Set([...String(text ?? '').matchAll(/V\d+\.\d+/g)].map((match) => match[0]))];
}

function splitTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const cells = trimmed.split('|').slice(1);
  if (cells.at(-1)?.trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/** 解析 §18.5 的范围摘要表；其它 Markdown 投影不参与权威判定。 */
export function parseScopeRows(section) {
  const rows = new Map();
  const duplicates = [];
  if (section === null) return { rows, duplicates };
  const pattern = /^\s*\|\s*`(SCOPE-[A-Z0-9-]+)`\s*\|[^\n]*$/gm;
  let match;
  while ((match = pattern.exec(section)) !== null) {
    const cells = splitTableCells(match[0]);
    const id = match[1];
    if (rows.has(id)) duplicates.push(id);
    rows.set(id, {
      id,
      cells,
      targetVersions: versionTokens(cells[1]),
      authority: cells[2] ?? '',
      track: cells[3] ?? '',
      raw: match[0]
    });
  }
  return { rows, duplicates };
}

function parseLabeledEntries(section, label, prefix) {
  const rows = new Map();
  const duplicates = [];
  if (section === null) return { rows, duplicates, lines: [] };
  const lines = String(section).split(/\r?\n/)
    .filter((line) => new RegExp(`^\\s*${label}(?:（[^\\n：:]*）)?[：:]`).test(line));
  const idBody = prefix === '' ? '[a-z0-9_-]+' : `${prefix}[A-Z0-9-]+`;
  const idPattern = new RegExp('`(' + idBody + ')`', 'g');
  for (const line of lines) {
    // 说明性文字常在同一行继续提及已经恢复的 Gate/切片；§18.5 的
    // 投影值只在标签后的首句，避免把历史说明当成当前延期项。
    const projectionLine = line.split(/[。!?]|[.](?!\d)/, 1)[0];
    const versions = versionTokens(projectionLine);
    let match;
    while ((match = idPattern.exec(projectionLine)) !== null) {
      const id = match[1];
      if (rows.has(id)) duplicates.push(id);
      rows.set(id, {
        id,
        targetVersions: versions,
        raw: projectionLine
      });
    }
    idPattern.lastIndex = 0;
  }
  return { rows, duplicates, lines };
}

export function parseGateRows(section) {
  return parseLabeledEntries(section, '延期 Gate', 'REL-');
}

export function parseSliceRows(section) {
  return parseLabeledEntries(section, '延期切片', 'W-');
}

export function parsePreviewRows(section) {
  return parseLabeledEntries(section, '延期只读预览编辑器', '');
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 从三份治理 JSON 提取延期记录。目标版本始终来自各条记录，
 * 因而允许同一索引同时承接多个版本。
 */
export function collectDeferredAuthority({ scopeData, gatesData, slicesData }) {
  const scopeItems = safeArray(scopeData?.scopeItems)
    .filter((item) => item?.proposedSupport === 'deferred')
    .map((item) => ({
      id: item.scopeItemId,
      targetRelease: item.deferredToRelease,
      authorityAtRuling: item.authorityAtRuling,
      deferredTrack: item.deferredTrack,
      operations: item.operations,
      resumeRequires: item.resumeRequires,
      gateIds: item.gateIds,
      source: item
    }));

  const gates = safeArray(gatesData?.gates)
    .filter((gate) => gate?.gateState === 'deferred' || gate?.applicability === 'deferred')
    .map((gate) => ({
      id: gate.gateId,
      targetRelease: gate.targetRelease,
      gateState: gate.gateState,
      applicability: gate.applicability,
      scopeItemIds: gate.scopeItemIds,
      sliceRefs: gate.sliceRefs,
      source: gate
    }));

  const slices = safeArray(slicesData?.slices)
    .filter((slice) => slice?.lifecycle === 'deferred')
    .map((slice) => ({
      id: slice.sliceId,
      targetRelease: slice.targetRelease,
      blockerRefs: slice.blockerRefs,
      source: slice
    }));

  const previews = safeArray(scopeData?.scopeItems).flatMap((item) => {
    const preview = item?.deferredPreviewEditors;
    if (!preview || !Array.isArray(preview.editorIds)) return [];
    return preview.editorIds.map((id) => ({
      id,
      targetRelease: preview.deferredToRelease,
      source: item
    }));
  });

  return { scopeItems, gates, slices, previews };
}

export function targetVersionsOf(authority) {
  return [...new Set([
    ...authority.scopeItems,
    ...authority.gates,
    ...authority.slices,
    ...authority.previews
  ].map((entry) => entry.targetRelease).filter((value) => typeof value === 'string'))].sort();
}

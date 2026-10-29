#!/usr/bin/env node
/**
 * SoulForge × 参考实现 CLI 输出对拍层。
 *
 * 两侧 envelope 的口径不同（见 docs/AGENT_EXECUTION_PLAYBOOK.md §10 与
 * Reference tools/CLI-HANDOFF.md §6），不能逐字段直接 diff。本文件只做一件事：
 * 把两侧投影成同一个 canonical record，再按显式规则比较；任何一侧无法投影就
 * 失败关闭，不猜、不把 unsupported/partial 折叠成 pass。
 *
 * 用法：
 *   node tools/soulforge-cli/compare-output.mjs --soulforge <envelope.json> [--reference <result.json>]
 *   node tools/soulforge-cli/compare-output.mjs --soulforge -            # 从 stdin 读
 *   node tools/soulforge-cli/compare-output.mjs --self-test
 *
 * 退出码：0 可对拍且一致；2 可对拍但存在差异；3 口径无法对齐（投影失败）；1 用法错误。
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

/** 参考 CLI 的合法 status（Reference tools/cli/lib/engine.mjs:14）。 */
const REFERENCE_STATUSES = new Set(['ok', 'partial', 'unsupported', 'blocked', 'failed', 'cancelled', 'timeout']);

/** 参考 CLI 的退出码（Reference tools/cli/lib/errors.mjs:6）。 */
const REFERENCE_EXIT = Object.freeze({
  ok: 0, partial: 2, unsupported: 3, blocked: 4, failed: 1, cancelled: 130, timeout: 124
});

/**
 * SoulForge 的成功态不是"通过"。这些状态在语义上等价于参考侧的
 * partial/unsupported/blocked，绝不能折叠成 pass。
 */
const SOULFORGE_NON_PASS = new Set(['unsupported', 'ambiguous', 'stale', 'cancelled', 'insufficient_evidence']);
const SOULFORGE_HARD_FAIL = new Set(['verification_failed']);

const PATH_PATTERN = /file:\/\/\/[^\s"',}]+|(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"',}]*/u;

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    '用法: node tools/soulforge-cli/compare-output.mjs --soulforge <envelope.json|-> '
    + '[--reference <result.json>] [--json] [--self-test]\n'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const options = { soulforge: null, reference: null, json: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--soulforge') options.soulforge = argv[++index] ?? usage('--soulforge 缺少取值');
    else if (arg === '--reference') options.reference = argv[++index] ?? usage('--reference 缺少取值');
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`未知参数: ${arg}`);
  }
  return options;
}

function readJson(source) {
  const text = source === '-'
    ? readFileSync(0, 'utf8')
    : readFileSync(source, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF+/u, ''));
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** 决定性的总数：只认逻辑总数，不认投影后的数组长度。 */
function authoritativeTotal(record) {
  for (const key of ['total', 'totalCount', 'totalHits', 'instructionCount', 'count']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { value, key };
  }
  return null;
}

/**
 * SoulForge envelope → canonical。
 * 投影失败返回 { ok:false, code, message }，由调用方失败关闭。
 */
export function normalizeSoulForge(envelope) {
  const record = asRecord(envelope);
  if (!record) return { ok: false, code: 'SOULFORGE_NOT_AN_ENVELOPE', message: 'SoulForge 输出不是对象 envelope。' };

  if (record.ok === false) {
    const error = asRecord(record.error) ?? {};
    return {
      ok: true,
      canonical: {
        origin: 'soulforge',
        verdict: 'failed',
        verdictDetail: String(error.code ?? record.code ?? 'TOOL_FAILED'),
        identity: { sourceHashes: [], sourceUris: [] },
        page: { key: null, returned: null, total: null, offset: null, limit: null, hasMore: false },
        rows: [],
        diagnostics: [{ code: String(error.code ?? 'TOOL_FAILED'), message: String(error.message ?? '') }]
      }
    };
  }

  const data = asRecord(record.data) ?? {};
  const payload = asRecord(data.record) ?? {};
  const state = typeof record.state === 'string' ? record.state : 'completed';
  const verdict = SOULFORGE_HARD_FAIL.has(state)
    ? 'failed'
    : SOULFORGE_NON_PASS.has(state) ? state : 'ok';

  const pagination = asRecord(record.pagination) ?? {};
  const itemsKey = typeof data.itemsKey === 'string' ? data.itemsKey : null;
  const rowsRaw = itemsKey && Array.isArray(payload[itemsKey]) ? payload[itemsKey] : [];
  const rows = rowsRaw.map((row) => (asRecord(row)?.item ?? row));

  const total = authoritativeTotal(payload);
  const evidence = asRecord(record.evidence) ?? {};
  const seenTotals = new Map();
  if (total) seenTotals.set(total.key, total.value);
  const projectedTotal = typeof pagination.total === 'number' ? pagination.total : null;
  if (projectedTotal !== null) seenTotals.set('pagination.total', projectedTotal);

  const conflicts = [];
  // 旧 envelope 会把投影后的数组长度写成 <key>TotalCount；一旦与本记录的逻辑
  // 总数不一致，就必须报出来，而不是挑一个看起来顺眼的。
  for (const [key, value] of Object.entries(payload)) {
    if (!key.endsWith('TotalCount')) continue;
    if (typeof value !== 'number' || !total) continue;
    const arrayKey = key.slice(0, -'TotalCount'.length);
    if (arrayKey === total.key) continue;
    if (Array.isArray(payload[arrayKey]) && value !== total.value) {
      conflicts.push({ field: key, value, authoritative: total.value, authoritativeField: total.key });
    }
  }

  return {
    ok: true,
    canonical: {
      origin: 'soulforge',
      verdict,
      verdictDetail: state,
      identity: {
        sourceHashes: Array.isArray(evidence.sourceHashes) ? evidence.sourceHashes.filter((item) => typeof item === 'string') : [],
        sourceUris: Array.isArray(evidence.sourceUris) ? evidence.sourceUris.filter((item) => typeof item === 'string') : []
      },
      page: {
        key: itemsKey,
        returned: typeof pagination.returnedCount === 'number' ? pagination.returnedCount : rows.length,
        total: total ? total.value : projectedTotal,
        offset: typeof pagination.offset === 'number' ? pagination.offset : null,
        limit: typeof pagination.limit === 'number' ? pagination.limit : null,
        hasMore: pagination.truncated === true
      },
      rows,
      conflicts,
      diagnostics: Array.isArray(payload.diagnostics)
        ? payload.diagnostics.map((entry) => ({ code: String(asRecord(entry)?.code ?? 'DIAGNOSTIC'), message: String(asRecord(entry)?.message ?? '') }))
        : []
    }
  };
}

/**
 * 参考 CLI 结果 → canonical。status 是唯一权威；partial 不算通过。
 */
export function normalizeReference(result) {
  const record = asRecord(result);
  if (!record) return { ok: false, code: 'REFERENCE_NOT_AN_OBJECT', message: '参考输出不是对象。' };
  if (typeof record.status !== 'string' || !REFERENCE_STATUSES.has(record.status)) {
    return {
      ok: false,
      code: 'REFERENCE_STATUS_MISSING',
      message: `参考输出缺少显式 status（实际: ${JSON.stringify(record.status)}）；不能按 envelope 解析。`
    };
  }

  const payload = asRecord(record.result) ?? record;
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const sourceHashes = artifacts
    .map((artifact) => asRecord(artifact)?.sha256)
    .filter((hash) => typeof hash === 'string');
  const manifestHash = asRecord(record.resultManifest)?.sha256;
  if (typeof manifestHash === 'string') sourceHashes.push(manifestHash);

  const page = asRecord(payload.page) ?? {};
  const itemsKey = Array.isArray(payload.items) ? 'items'
    : Array.isArray(payload.entries) ? 'entries'
      : Array.isArray(payload.rows) ? 'rows' : null;
  const rows = itemsKey ? payload[itemsKey] : [];
  const total = authoritativeTotal(payload);

  return {
    ok: true,
    canonical: {
      origin: 'reference',
      verdict: record.status,
      verdictDetail: record.status,
      identity: {
        sourceHashes,
        sourceUris: [],
        // 参考侧的版本判据是 git commit；与 SoulForge 的 sourceRevision 不同源，
        // 只记录、不参与相等判定。
        sourceCommit: typeof asRecord(record.source)?.commit === 'string' ? record.source.commit : null
      },
      page: {
        key: itemsKey,
        returned: typeof page.returnedCount === 'number' ? page.returnedCount : rows.length,
        total: total ? total.value : null,
        offset: typeof page.offset === 'number' ? page.offset : null,
        limit: typeof page.limit === 'number' ? page.limit : null,
        hasMore: page.hasMore === true
      },
      rows,
      diagnostics: Array.isArray(record.diagnostics)
        ? record.diagnostics.map((entry) => ({ code: String(asRecord(entry)?.code ?? 'DIAGNOSTIC'), message: String(asRecord(entry)?.message ?? '') }))
        : []
    }
  };
}

/** 收集任何会泄漏本机绝对路径的字符串。 */
function findPathLeaks(value, trail = '$', output = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    if (PATH_PATTERN.test(value)) output.push(trail);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) findPathLeaks(child, `${trail}.${key}`, output, depth + 1);
  return output;
}

/** 解码 envelope 里的 opaque cursor，检查其载荷是否夹带绝对路径。 */
function findCursorLeaks(envelope) {
  const found = [];
  const read = asRecord(asRecord(envelope)?.pagination)?.cursors;
  if (!read) return found;
  for (const [key, token] of Object.entries(read)) {
    if (typeof token !== 'string' || !token.startsWith('sf_cur_')) continue;
    let decoded = '';
    try {
      decoded = Buffer.from(token.slice('sf_cur_'.length), 'base64url').toString('utf8');
    } catch {
      continue;
    }
    if (PATH_PATTERN.test(decoded)) found.push(`pagination.cursors.${key}`);
  }
  return found;
}

/**
 * 比较两份 canonical。规则是显式的：
 * - verdict 必须同类，且 unsupported/partial 类不得判为 pass；
 * - identity 只按内容哈希对齐（sourceRevision / git commit 不同源，不参与）；
 * - 总数只认权威字段，且要求两侧都为 null 或相等；
 * - 页长度按 rows 实际条数比较；
 * - rows 逐条比较，键优先 sourceUri/rowId/fieldId。
 */
export function compareCanonical(left, right) {
  const findings = [];
  const add = (code, severity, message, details = undefined) => {
    findings.push({ code, severity, message, ...(details ? { details } : {}) });
  };

  const leftPass = left.verdict === 'ok';
  const rightPass = right.verdict === 'ok';
  if (leftPass !== rightPass) {
    add('VERDICT_MISMATCH', 'error',
      `一侧通过另一侧未通过：soulforge=${left.verdict}（${left.verdictDetail}）, reference=${right.verdict}。`,
      { soulforge: left.verdictDetail, reference: right.verdict });
  }
  for (const side of [left, right]) {
    if (side.verdict === 'partial' || side.verdict === 'unsupported') {
      add('NON_ACCEPTANCE_VERDICT', 'warning',
        `${side.origin} 的 verdict=${side.verdict} 不是验收通过，不能计入 pass。`);
    }
  }

  if (left.page.total !== null && right.page.total !== null && left.page.total !== right.page.total) {
    add('TOTAL_MISMATCH', 'error', `逻辑总数不一致：${left.page.total} vs ${right.page.total}。`);
  }
  if (left.rows.length !== right.rows.length) {
    add('ROW_COUNT_MISMATCH', 'error', `返回行数不一致：${left.rows.length} vs ${right.rows.length}。`);
  }

  const leftHashes = new Set(left.identity.sourceHashes);
  const rightHashes = new Set(right.identity.sourceHashes);
  if (leftHashes.size > 0 && rightHashes.size > 0) {
    const shared = [...leftHashes].filter((hash) => rightHashes.has(hash));
    if (shared.length === 0) {
      add('SOURCE_HASH_DISJOINT', 'error',
        '两侧没有任何共同的内容哈希：本次比较不是同一份语料，结论无效。');
    }
  }

  // 逐条按稳定键对齐；无法对齐的条目单独报出，不按位置硬比。
  const keyOf = (row) => {
    const record = asRecord(row) ?? {};
    const uri = typeof record.uri === 'string' ? record.uri
      : typeof record.sourceUri === 'string' ? record.sourceUri : null;
    if (uri) return `uri:${uri}`;
    if (typeof record.rowId === 'number') return `rowId:${record.rowId}`;
    if (typeof record.textId === 'number') return `textId:${record.textId}`;
    if (typeof record.eventId === 'number') return `eventId:${record.eventId}`;
    return null;
  };
  const leftByKey = new Map();
  for (const row of left.rows) {
    const key = keyOf(row);
    if (key) leftByKey.set(key, row);
  }
  const rightKeys = new Set();
  for (const row of right.rows) {
    const key = keyOf(row);
    if (!key) continue;
    rightKeys.add(key);
    if (!leftByKey.has(key)) add('ROW_MISSING', 'error', `参考侧有而 SoulForge 侧没有的条目：${key}。`);
  }
  for (const key of leftByKey.keys()) {
    if (!rightKeys.has(key)) add('ROW_EXTRA', 'warning', `SoulForge 侧多出的条目：${key}。`);
  }

  return findings;
}

function runSelfTest() {
  const results = [];
  const assert = (name, condition, detail) => {
    results.push({ name, ok: Boolean(condition), ...(condition ? {} : { detail }) });
  };

  // 1) unsupported 不得折叠成 pass。
  const unsupportedSoulForge = normalizeSoulForge({
    ok: true, state: 'unsupported',
    data: { items: [], itemsKey: null, record: {}, scalar: null, summary: null },
    pagination: { returnedCount: 0, total: null, cursors: {} },
    truncated: false, identifiers: [], evidence: { status: 'not_applicable' }
  }).canonical;
  const unsupportedReference = normalizeReference({ schemaVersion: 1, status: 'unsupported' }).canonical;
  const findings1 = compareCanonical(unsupportedSoulForge, unsupportedReference);
  assert('unsupported 判为同类且不产生 VERDICT_MISMATCH',
    unsupportedSoulForge.verdict === 'unsupported'
    && findings1.every((finding) => finding.code !== 'VERDICT_MISMATCH'),
    JSON.stringify(unsupportedSoulForge.verdict));

  // 2) 旧 envelope 的 *TotalCount 冲突必须被检出。
  const conflicting = normalizeSoulForge({
    ok: true, state: 'completed',
    data: {
      items: [], itemsKey: 'matches',
      record: { total: 12, totalCount: 12, matches: [{ uri: 'param://NPC_PARAM_ST/1' }], matchesTotalCount: 2 },
      scalar: null, summary: null
    },
    pagination: { returnedCount: 1, total: 12, offset: 0, limit: 1, truncated: true, cursors: {} },
    truncated: true, identifiers: [], evidence: { status: 'candidate', sourceHashes: ['h1'], sourceUris: [] }
  }).canonical;
  assert('检出 *TotalCount 与权威 total 冲突',
    conflicting.conflicts.length === 1 && conflicting.conflicts[0].authoritative === 12,
    JSON.stringify(conflicting.conflicts));
  assert('权威 total 取 record.total 而非 *TotalCount', conflicting.page.total === 12, String(conflicting.page.total));

  // 3) cursor 内的绝对路径必须被检出。
  const cursorPayload = JSON.stringify({ s: 'content-search-v2', o: 2, k: '{"workspaceId":"file:///D:/mods"}' });
  const leaky = {
    ok: true, state: 'completed',
    data: { items: [], itemsKey: null, record: {}, scalar: null, summary: null },
    pagination: { returnedCount: 0, total: 0, cursors: { nextCursor: `sf_cur_${Buffer.from(cursorPayload).toString('base64url')}` } },
    truncated: false, identifiers: [], evidence: { status: 'not_applicable' }
  };
  assert('检出 opaque cursor 内的绝对路径', findCursorLeaks(leaky).length === 1, JSON.stringify(findCursorLeaks(leaky)));
  assert('脱敏后的 cursor 不再被检出',
    findCursorLeaks({
      ...leaky,
      pagination: { ...leaky.pagination, cursors: { nextCursor: `sf_cur_${Buffer.from(JSON.stringify({ s: 'content-search-v2', k: '{"workspaceId":"sfpath:0123456789abcdef"}' })).toString('base64url')}` } }
    }).length === 0);

  // 4) 参考侧缺少 status 必须失败关闭。
  assert('缺少 status 的参考输出被拒绝', normalizeReference({ rows: [] }).ok === false);

  // 5) 正例：两侧同一行、同一哈希 → 无 error 级发现。
  const happySoulForge = normalizeSoulForge({
    ok: true, state: 'completed',
    data: { items: [], itemsKey: 'rows', record: { rows: [{ rowId: 50800000, value: 2 }], total: 1 }, scalar: null, summary: null },
    pagination: { returnedCount: 1, total: 1, offset: 0, limit: 1, truncated: false, cursors: {} },
    truncated: false, identifiers: [], evidence: { status: 'native-verified', sourceHashes: ['abc'], sourceUris: [] }
  }).canonical;
  const happyReference = normalizeReference({
    schemaVersion: 1, status: 'ok',
    artifacts: [{ path: 'x', relativePath: 'x', bytes: 1, sha256: 'abc' }],
    result: { rows: [{ rowId: 50800000, value: 2 }], total: 1 }
  }).canonical;
  const findings5 = compareCanonical(happySoulForge, happyReference);
  assert('正例无误报 error', findings5.every((finding) => finding.severity !== 'error'), JSON.stringify(findings5));

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2)}\n`);
  return failed.length === 0 ? 0 : 2;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) process.exit(runSelfTest());
  if (!options.soulforge) usage('需要 --soulforge <envelope.json|->');

  const envelope = readJson(options.soulforge);
  const soulforge = normalizeSoulForge(envelope);
  if (!soulforge.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: soulforge.code, message: soulforge.message }, null, 2)}\n`);
    process.exit(3);
  }

  const leaks = [
    ...findCursorLeaks(envelope).map((path) => ({ path, kind: 'cursor' })),
    ...findPathLeaks(envelope).map((path) => ({ path, kind: 'field' }))
  ];
  const report = {
    ok: true,
    soulforge: soulforge.canonical,
    pathLeaks: leaks,
    comparison: null,
    findings: []
  };

  if (options.reference) {
    const reference = normalizeReference(readJson(options.reference));
    if (!reference.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: reference.code, message: reference.message }, null, 2)}\n`);
      process.exit(3);
    }
    report.reference = reference.canonical;
    report.findings = compareCanonical(soulforge.canonical, reference.canonical);
    report.comparison = 'compared';
  } else {
    report.comparison = 'single-side-only';
    report.findings = leaks.length > 0
      ? [{ code: 'PATH_LEAK', severity: 'error', message: `${leaks.length} 处绝对路径未脱敏。`, details: leaks }]
      : [];
  }

  const verdict = report.findings.some((finding) => finding.severity === 'error') ? 2 : 0;
  process.stdout.write(`${JSON.stringify({ ...report, ok: verdict === 0 }, null, 2)}\n`);
  process.exit(verdict);
}

if (process.argv[1] && process.argv[1].endsWith('compare-output.mjs')) main();

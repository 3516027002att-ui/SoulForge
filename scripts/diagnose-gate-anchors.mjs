#!/usr/bin/env node
/**
 * Gate 证据锚点存活诊断。
 *
 * `GATE_FRESHNESS_UNVERIFIABLE` 只说"无法验证"，不说是哪种无法验证。实测这里有三类
 * 完全不同的成因，处理方式也不同：
 *   1. 锚点提交不存在（历史被重写/压缩，或证据来自另一个 clone）——重封存才能修；
 *   2. 提交存在但不是 HEAD 的祖先（分叉）——同样是重封存；
 *   3. 提交存在且是祖先，但交接书在该锚点取不到某个 marker 块——设计陷阱，见
 *      handoff-integrity-lib.mjs 里"新增 marker 对会让所有更早锚点失效"的注释。
 *
 * 本脚本只读：把每个 passed Gate 的 evidence 锚点按上面三类归档，并打印计数。
 * 用法：node scripts/diagnose-gate-anchors.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function git(command, allowFail = false) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

const gates = JSON.parse(readFileSync('docs/governance/gates.json', 'utf8'));
const gateList = Array.isArray(gates) ? gates : (gates.gates ?? []);
const evidence = new Map();
for (const line of readFileSync('docs/governance/evidence.jsonl', 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  evidence.set(record.evidenceId, record);
}

const report = [];
for (const gate of gateList) {
  const id = gate.gateId ?? gate.id;
  if (gate.gateState !== 'passed') continue;
  const refs = gate.evidenceRefs ?? [];
  const anchors = refs
    .map((ref) => evidence.get(ref))
    .filter(Boolean)
    .map((record) => ({
      evidenceId: record.evidenceId,
      anchor: (/HEAD=([0-9a-f]{7,40})/.exec(record.fingerprint ?? '') ?? [])[1] ?? null
    }))
    .filter((entry) => entry.anchor);
  const missing = [];
  const forked = [];
  for (const entry of anchors) {
    if (git(`git cat-file -e ${entry.anchor}^{commit}`, true) === null) {
      missing.push(entry);
      continue;
    }
    if (git(`git merge-base --is-ancestor ${entry.anchor} HEAD`, true) === null) {
      forked.push(entry);
    }
  }
  report.push({
    gateId: id,
    evidence: refs.length,
    anchors: anchors.length,
    missingCommits: missing.length,
    forkedCommits: forked.length,
    sample: (missing[0] ?? forked[0] ?? anchors[0])?.anchor?.slice(0, 12) ?? null
  });
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ok: true, gates: report }, null, 2)}\n`);
  process.exit(0);
}

for (const gate of report) {
  process.stdout.write(
    `${gate.gateId}: evidence=${gate.evidence} anchors=${gate.anchors} `
    + `missing=${gate.missingCommits} forked=${gate.forkedCommits} sample=${gate.sample}\n`
  );
}

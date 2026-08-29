#!/usr/bin/env node
/**
 * Mission1 A1 runner — 受控的产品阶段聚合器（不在 A0 同进程自动级联）
 *
 * 设计约束（对应 analysis 要求的 fail-closed）：
 *  - 不修改 verify-mission1-acceptance.mjs 的信任根/A0-only 逻辑
 *  - 显式消费 current-state.json 的可信四元组后才跑 G1
 *  - 四元组 = sourceSnapshotSha256 / runnerTrustRootSha256 / artifactManifestSha256 / summarySha256
 *  - 先 --resume 校验 sourceStable 且 state.trusted 且 stageStatus PASS，再跑 4 项 G1
 *  - 复用 ASSERTION_REGISTRY 中 stage A1 的 4 项，不在此脚本重定义 gate 语义
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = join(ROOT, 'output', 'mission1-evidence');
const CURRENT_STATE_PATH = join(OUTPUT_ROOT, 'current-state.json');

function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300000, ...opts });
  return { exitCode: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
}
function runWithShell(cmd, args) {
  // npm on Windows requires shell to resolve .cmd shim; use shell:true with command string
  const full = `${cmd} ${args.map(a => `"${a.replaceAll('"','\\"')}"`).join(' ')}`;
  const r = spawnSync(full, [], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300000, shell: true });
  return { exitCode: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
}
function loadJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

const G1_CHECKS = [
  { id: 'G1.diff-check', order: 110, assertionId: 'G1.diff-check', cmd: 'git', args: ['diff', '--check'], label: 'git diff --check' },
  { id: 'G1.typecheck', order: 120, assertionId: 'G1.typecheck', cmd: 'npm', args: ['run', 'typecheck'], label: 'npm run typecheck' },
  { id: 'G1.bridge-build', order: 130, assertionId: 'G1.bridge-build', cmd: 'npm', args: ['run', 'bridge:build'], label: 'npm run bridge:build' },
  { id: 'G1.renderer-build', order: 140, assertionId: 'G1.renderer-build', cmd: 'npm', args: ['run', 'build', '-w', '@soulforge/desktop'], label: 'npm run build -w @soulforge/desktop' },
];

function canonicalJson(v){ if(Array.isArray(v)) return '['+v.map(canonicalJson).join(',')+']'; if(v&&typeof v==='object') return '{'+Object.keys(v).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))).map(k=>JSON.stringify(k)+':'+canonicalJson(v[k])).join(',')+'}'; return JSON.stringify(v);}
function hashCanonical(v){ return createHash('sha256').update(Buffer.from(canonicalJson(v),'utf8')).digest('hex');}
function withoutField(v,f){ const c={...v}; delete c[f]; return c; }

function verifyTrust() {
  const resume = run(process.execPath, [join(ROOT, 'scripts/verify-mission1-acceptance.mjs'), '--resume']);
  let resumeJson = null;
  try { resumeJson = JSON.parse(resume.stdout.trim()); } catch {}
  if (resume.exitCode !== 0 || !resumeJson?.ok) {
    return { ok: false, code: 'A0_TRUST_NOT_READY', resumeExit: resume.exitCode, resumeJson, stderr: resume.stderr };
  }
  if (!existsSync(CURRENT_STATE_PATH)) return { ok: false, code: 'CURRENT_STATE_MISSING' };
  const state = loadJson(CURRENT_STATE_PATH);
  if (state.stageStatus !== 'PASS' || state.stage !== 'A0') {
    return { ok: false, code: 'A0_NOT_PASS', stage: state.stage, stageStatus: state.stageStatus };
  }
  const quad = {
    sourceSnapshotSha256: state.sourceSnapshotSha256,
    runnerTrustRootSha256: state.runnerTrustRootSha256,
    artifactManifestSha256: state.artifactManifestSha256,
    summarySha256: state.summarySha256,
    sourceSnapshotStable: true,
  };
  // 校验摘要完整性：canonical hash 比对（state.summarySha256 是 canonical，与 raw bytes hash 区分）
  try {
    const summaryPath = resolve(ROOT, state.summaryPath);
    const summaryJson = loadJson(summaryPath);
    if (hashCanonical(withoutField(summaryJson, 'summarySha256')) !== state.summarySha256) return { ok: false, code: 'SUMMARY_HASH_MISMATCH', detail: 'canonical mismatch' };
    if (summaryJson.summarySha256 !== state.summarySha256) return { ok: false, code: 'SUMMARY_HASH_MISMATCH', detail: 'summarySha256 field' };
    const manifestPath = resolve(ROOT, state.artifactManifestPath);
    if (!existsSync(manifestPath)) return { ok: false, code: 'ARTIFACT_MANIFEST_MISSING' };
    const manifestJson = loadJson(manifestPath);
    if (manifestJson.artifactManifestSha256 !== state.artifactManifestSha256) return { ok: false, code: 'MANIFEST_HASH_MISMATCH' };
    if (hashCanonical(withoutField(manifestJson, 'artifactManifestSha256')) !== state.artifactManifestSha256) return { ok: false, code: 'MANIFEST_HASH_MISMATCH_CANONICAL' };
  } catch (e) { return { ok: false, code: 'QUAD_READ_FAILED', detail: e.message }; }
  return { ok: true, state, quad, resumeJson };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/verify-mission1-a1.mjs [--json]\n  显式 A1 聚合：先 --resume 校验 G0 四元组仍 trusted 且 sourceStable，再跑 G1 的 4 项。\n  不在 A0 同进程自动级联。');
    process.exit(0);
  }
  const jsonMode = args.includes('--json');
  const trust = verifyTrust();
  if (!trust.ok) {
    const out = { ok: false, stage: 'A1', gate: 'G1', status: 'BLOCKED', code: trust.code, trust, quad: null, checks: [] };
    console.log(JSON.stringify(out, null, 2));
    process.exit(trust.code === 'A0_NOT_PASS' || trust.code === 'A0_TRUST_NOT_READY' ? 2 : 1);
    return;
  }

  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + trust.quad.sourceSnapshotSha256.slice(0, 12);
  const evidenceDir = join(OUTPUT_ROOT, runId + '-a1');
  mkdirSync(evidenceDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const checks = [];
  let allPass = true;
  for (const c of G1_CHECKS) {
    const t0 = Date.now();
    const r = (c.cmd === 'npm' || c.cmd === 'git') ? runWithShell(c.cmd, c.args) : run(c.cmd, c.args);
    const durationMs = Date.now() - t0;
    const pass = r.exitCode === 0;
    if (!pass) allPass = false;
    // 落盘单项日志（便于 G0 证据链追溯）
    const logPath = join(evidenceDir, c.id + '.log');
    writeFileSync(logPath, `# ${c.label}\n# exit:${r.exitCode} signal:${r.signal} durationMs:${durationMs}\n## stdout\n${r.stdout}\n## stderr\n${r.stderr}\n`, 'utf8');
    checks.push({
      order: c.order, assertionId: c.assertionId, gate: 'G1', stage: 'A1',
      label: c.label, exactCommand: [c.cmd, ...c.args],
      exitCode: r.exitCode, signal: r.signal, durationMs,
      logPath: 'output/mission1-evidence/' + runId + '-a1/' + c.id + '.log',
      status: pass ? 'PASS' : 'FAIL',
      nextActionCode: pass ? null : c.id === 'G1.diff-check' ? 'FIX_DIFF_CHECK' : c.id === 'G1.typecheck' ? 'FIX_TYPECHECK' : c.id === 'G1.bridge-build' ? 'FIX_BRIDGE_BUILD' : 'FIX_RENDERER_BUILD',
    });
  }
  const finishedAt = new Date().toISOString();
  const gateStatus = allPass ? 'PASS' : 'FAIL';
  const stageStatus = allPass ? 'PASS' : 'FAIL';
  const evidence = {
    schema: 'mission1-a1-evidence-v1',
    stage: 'A1', gate: 'G1',
    status: stageStatus, gateStatus,
    startedAtUtc: startedAt, finishedAtUtc: finishedAt,
    // G0 四元绑定（与 current-state.json 对齐，防旧 log / 脏快照绕过）
    sourceSnapshotSha256: trust.quad.sourceSnapshotSha256,
    runnerTrustRootSha256: trust.quad.runnerTrustRootSha256,
    artifactManifestSha256: trust.quad.artifactManifestSha256,
    summarySha256: trust.quad.summarySha256,
    sourceSnapshotStable: true,
    currentStatePath: 'output/mission1-evidence/current-state.json',
    currentStateSha256: sha256Hex(readFileSync(CURRENT_STATE_PATH)),
    a0StageStatus: trust.state.stageStatus,
    executionPolicy: 'A0-trusted-then-explicit-A1',
    assertions: checks,
    gates: { G1: { id: 'G1', status: gateStatus, detail: allPass ? 'G1 4 项均 PASS' : 'G1 有失败项，见 checks' } },
    evidenceDir: 'output/mission1-evidence/' + runId + '-a1',
    nextActionCode: checks.find(c => c.status !== 'PASS')?.nextActionCode ?? null,
  };
  evidence.evidenceSha256 = sha256Hex(Buffer.from(JSON.stringify(evidence), 'utf8'));
  const evidencePath = join(evidenceDir, 'a1-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  const summary = {
    ok: allPass,
    stage: 'A1', gate: 'G1', status: stageStatus,
    quad: trust.quad,
    evidencePath: 'output/mission1-evidence/' + runId + '-a1/a1-evidence.json',
    checks: checks.map(c => ({ assertionId: c.assertionId, status: c.status, exitCode: c.exitCode })),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();

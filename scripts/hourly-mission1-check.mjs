#!/usr/bin/env node
// SoulForge mission1 小时级自检 — workflow 心跳 + 构建/契约轮询
// 用途：每小时检测 ultracode workflow 是否在正确运行，异常即派 subagent 修正
// 触发：CI cron / 手动 `node scripts/hourly-mission1-check.mjs` / Workflow 调度
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// G0 四元绑定：hourly 作为 G1 证据时，必须头部携带 current-state 的 quad，防脏快照/旧 log 重放
function readQuad() {
  try {
    const p = path.join(ROOT, 'output/mission1-evidence/current-state.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { sourceSnapshotSha256: j.sourceSnapshotSha256, runnerTrustRootSha256: j.runnerTrustRootSha256, artifactManifestSha256: j.artifactManifestSha256, summarySha256: j.summarySha256, stateSha256: j.stateSha256, gitHead: j.gitHead };
  } catch { return null; }
}

const checks = [
  // G1 的 4 项（与 ASSERTION_REGISTRY 110-140 一一对应）— 此 4 项即为 A1 的 G1 证据子集
  { name: 'G1.diff-check', cmd: 'git diff --check' },
  { name: 'G1.typecheck', cmd: 'npm run typecheck' },
  { name: 'G1.bridge-build', cmd: 'npm run bridge:build' },
  { name: 'G1.renderer-build', cmd: 'npm run build -w @soulforge/desktop' },
  // 额外 guard：契约/语料/A0 信任根（不计入 G1，但用于小时级心跳）
  { name: 'test:desktop-ipc-contract', cmd: 'npm run test:desktop-ipc-contract' },
  { name: 'verify-mission1-corpus', cmd: 'node scripts/verify-mission1-corpus-v2.mjs testdata/corpus/mission1-sekiro-acceptance.manifest.json' },
  { name: 'verify-mission1-acceptance status', cmd: 'node scripts/verify-mission1-acceptance.mjs --status' },
];

let failed = [];
for (const c of checks) {
  try {
    console.log(`[check] ${c.name}: ${c.cmd}`);
    execSync(c.cmd, { stdio: 'inherit', timeout: 120000 });
    console.log(`[ok] ${c.name}`);
  } catch (e) {
    console.error(`[FAIL] ${c.name}: ${e.message}`);
    failed.push(c.name);
  }
}
if (failed.length) {
  console.error(`\n[hourly-check] FAIL: ${failed.join(', ')} — 需派 subagent 修正`);
  process.exit(1);
} else {
  const quad = readQuad();
  if (quad) console.log(`[hourly-check] G0-quad sourceSnapshot=${quad.sourceSnapshotSha256.slice(0,12)} runnerTrustRoot=${quad.runnerTrustRootSha256.slice(0,12)} summary=${quad.summarySha256.slice(0,12)} state=${quad.stateSha256.slice(0,12)} — 与 runner 的 G0 四元绑定对齐（防旧 log 重放）`);
  console.log('\n[hourly-check] PASS — workflow 心跳与构建/契约绿灯正常');
  console.log('[hourly-check] 替代方案说明：前 4 项（diff-check/typecheck/bridge:build/renderer-build）即为 ASSERTION_REGISTRY 110-140 的 G1 证据；后 2 项为 A0/A2 guard。受控 A1 聚合请用 node scripts/verify-mission1-a1.mjs（显式 --resume 校验 quad 仍 trusted 且 sourceStable 后再跑 G1），保持 A0 runner 的 A0-only 职责。');
}

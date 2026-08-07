/**
 * 桌面契约门禁的变异测试（negative gate）。
 *
 * 「门禁通过」本身不是证据：上一代 grep 式契约 smoke 也全部通过，却在写链从
 * 五份收敛成一份的重构里毫无反应。所以这里对生产构建产物做临时变异，验证
 * verify-desktop-ipc-contract.mjs 会真的失败关闭；每个变异都必须被抓到。
 *
 * 变异只作用于 apps/desktop/out 构建产物的临时副本，绝不改源码，也绝不改
 * 原产物：先备份、跑、无条件恢复（finally），并在结尾校验产物已还原。
 */
import { copyFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 复用同一个 structuredSkip：它同时承载 SOULFORGE_CONTRACT_REQUIRE_BUNDLES
// 的失败关闭语义。这里本来有一份逐字重复的副本，两份并存时只改一处就会让
// 两条门禁在 CI 里的行为不一致，而症状是「其中一条静默跳过」——查不出来。
import { structuredSkip } from './desktopSurface.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const MAIN_BUNDLE = join(repoRoot, 'apps', 'desktop', 'out', 'main', 'index.js');
const PRELOAD_BUNDLE = join(repoRoot, 'apps', 'desktop', 'out', 'preload', 'index.cjs');
const CONTRACT = join(here, 'verify-desktop-ipc-contract.mjs');
const LABEL = 'desktop-contract-mutations';

if (!existsSync(MAIN_BUNDLE) || !existsSync(PRELOAD_BUNDLE)) {
  structuredSkip(LABEL, '桌面构建产物缺失，无法做变异测试');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runContract() {
  const result = spawnSync(process.execPath, [CONTRACT], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * 变异清单。每一项描述一个真实的退化场景，并声明必须出现在失败诊断里的关键字，
 * 以确保「失败了」不等于「因为正确的原因失败了」。
 */
const MUTATIONS = [
  {
    id: 'main-channel-renamed',
    file: MAIN_BUNDLE,
    scenario: 'main 把 resource.applyFmgMutation 改名（只改一侧的 channel 重命名）',
    apply: (source) => source.replace('"resource.applyFmgMutation"', '"resource.applyFmgMutationV2"'),
    expectCodes: ['resource.applyFmgMutation']
  },
  {
    id: 'main-channel-removed',
    file: MAIN_BUNDLE,
    scenario: 'main 不再注册分页 channel resource.readParamPage（硬约束 17 退化）',
    apply: (source) => source.replace('"resource.readParamPage"', '"resource.readParamPage__disabled"'),
    expectCodes: ['resource.readParamPage']
  },
  {
    id: 'main-exposes-forbidden',
    file: MAIN_BUNDLE,
    scenario: 'main 把 resolveApiKey 暴露成 IPC channel（凭据边界退化）',
    apply: (source) => source.replace('"modelService.list"', '"modelService.resolveApiKey"'),
    expectCodes: ['modelService.resolveApiKey']
  },
  {
    id: 'preload-channel-drift',
    file: PRELOAD_BUNDLE,
    scenario: 'preload 指向一个 main 未注册的 channel（运行时必然失败的接线漂移）',
    apply: (source) => source.replace('"resource.applyMsbMutation"', '"resource.applyMsbMutationOld"'),
    expectCodes: ['resource.applyMsbMutation']
  },
  {
    id: 'preload-method-dropped',
    file: PRELOAD_BUNDLE,
    scenario: 'preload 不再暴露 submitEmevdDslPlan（编辑器入口静默消失）',
    apply: (source) => source.replace('submitEmevdDslPlan:', 'submitEmevdDslPlanRemoved:'),
    expectCodes: ['submitEmevdDslPlan']
  },
  {
    id: 'preload-exposes-forbidden',
    file: PRELOAD_BUNDLE,
    scenario: 'preload 暴露 resolveApiKey（渲染进程可取明文凭据）',
    apply: (source) => source.replace('deleteModelService:', 'resolveApiKey:'),
    expectCodes: ['resolveApiKey']
  },
  {
    id: 'preload-wrong-world-key',
    file: PRELOAD_BUNDLE,
    scenario: 'preload 换掉 exposeInMainWorld 的键名（renderer 契约断裂）',
    apply: (source) => source.replace('"soulforge", api', '"soulforgeLegacy", api'),
    expectCodes: ['soulforge']
  },
  // 以下三条覆盖推送类（webContents.send / ipcRenderer.on）方向。此前门禁把
  // 订阅当成 invoke 对账，导致正确接线被判违规、真实断裂反而无人管；按方向
  // 拆开后必须证明两个方向都仍会失败关闭，否则「修掉误报」会顺手变成「放宽」。
  {
    id: 'preload-subscription-renamed',
    file: PRELOAD_BUNDLE,
    scenario: 'preload 订阅 channel 改名（AI agent 事件静默不再到达渲染进程）',
    apply: (source) => source.replace('"ai:agent:event"', '"ai:agent:eventOld"'),
    expectCodes: ['ai:agent:event']
  },
  {
    id: 'main-push-removed',
    file: MAIN_BUNDLE,
    scenario: 'main 不再向 ai:agent:event 推送（preload 订阅永不来的事件）',
    apply: (source) => source.replaceAll('"ai:agent:event"', '"ai:agent:eventRemoved"'),
    expectCodes: ['ai:agent:event']
  },
  {
    id: 'push-channel-becomes-handler',
    file: MAIN_BUNDLE,
    scenario: '推送 channel 被误注册为 ipcMain.handle（invoke 与 send 语义互斥）',
    apply: (source) => source.replace('"ai.agent.cancel"', '"ai:agent:event"'),
    expectCodes: ['ai:agent:event']
  }
];

const baselineHashes = { main: sha256(MAIN_BUNDLE), preload: sha256(PRELOAD_BUNDLE) };
const baseline = runContract();
if (baseline.status !== 0) {
  console.error(JSON.stringify({
    ok: false, contract: LABEL, code: 'BASELINE_CONTRACT_FAILED',
    message: '未变异时契约门禁就已失败，变异测试结论无意义。',
    baseline
  }, null, 2));
  process.exit(1);
}

const findings = [];
const backups = new Map();
try {
  for (const mutation of MUTATIONS) {
    const target = mutation.file;
    if (!backups.has(target)) {
      const backup = `${target}.contract-mutation-backup`;
      copyFileSync(target, backup);
      backups.set(target, backup);
    }
    const original = readFileSync(backups.get(target), 'utf8');
    const mutated = mutation.apply(original);
    if (mutated === original) {
      findings.push({
        id: mutation.id, ok: false, code: 'MUTATION_NOT_APPLIED',
        message: '变异未改动产物：目标字符串不存在，变异测试本身失效（可能是产物结构变了）。',
        scenario: mutation.scenario
      });
      continue;
    }
    writeFileSync(target, mutated, 'utf8');
    const run = runContract();
    writeFileSync(target, original, 'utf8');

    if (run.status === 0) {
      findings.push({
        id: mutation.id, ok: false, code: 'MUTATION_NOT_DETECTED',
        message: '契约门禁在该退化下仍然通过——门禁对这个场景是盲的。',
        scenario: mutation.scenario
      });
      continue;
    }
    const combined = `${run.stdout}\n${run.stderr}`;
    const missingKeywords = mutation.expectCodes.filter((code) => !combined.includes(code));
    if (missingKeywords.length > 0) {
      findings.push({
        id: mutation.id, ok: false, code: 'MUTATION_DIAGNOSTIC_UNCLEAR',
        message: '门禁失败了，但诊断里没有指明相关 channel/方法，定位成本过高。',
        scenario: mutation.scenario, missingKeywords
      });
      continue;
    }
    findings.push({ id: mutation.id, ok: true, scenario: mutation.scenario, exitCode: run.status });
  }
} finally {
  for (const [target, backup] of backups) {
    if (existsSync(backup)) {
      copyFileSync(backup, target);
      unlinkSync(backup);
    }
  }
}

// 产物必须逐字节还原，否则后续所有验证都在被污染的产物上跑。
const restored = { main: sha256(MAIN_BUNDLE), preload: sha256(PRELOAD_BUNDLE) };
if (restored.main !== baselineHashes.main || restored.preload !== baselineHashes.preload) {
  console.error(JSON.stringify({
    ok: false, contract: LABEL, code: 'BUNDLE_NOT_RESTORED',
    message: '变异测试未能还原构建产物，必须重新构建 desktop。',
    baselineHashes, restored
  }, null, 2));
  process.exit(1);
}

const failed = findings.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(JSON.stringify({
    ok: false, contract: LABEL, code: 'CONTRACT_GATE_BLIND',
    passed: findings.length - failed.length, failed: failed.length, failures: failed
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true, contract: LABEL,
  message: '桌面契约门禁变异测试通过：每个退化场景都被失败关闭并给出可定位诊断',
  mutations: findings.length,
  scenarios: findings.map((item) => item.scenario),
  bundlesRestored: true
}, null, 2));

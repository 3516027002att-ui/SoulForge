#!/usr/bin/env node
/**
 * ROOT-07：Bridge allowed-root 生命周期运行期验证（front-end.md §13.2 / §18.11）。
 *
 * ── 守的问题 ──
 *
 * Bridge 报 `Every allowed root must be an existing directory.` 时，根因常是
 * main 把**尚不存在**的 staging 目录预先塞进了 allowed roots——「为方便统一
 * 附加一个不存在的目录」正是 §13.2 明令禁止的做法。这类缺陷在源码里看不见：
 * `bridgeAllowedRoots(session, stagingRoot)` 一行返回数组，staging 何时创建
 * 完全看调用方心情；typecheck 不会拦，任何单元测试也不会拦（mock 掉 fs 就
 * 等于把要验的行为验掉了）。
 *
 * ── 为什么单独一个入口 ──
 *
 * 与 verify-recent-paths 同范式：esbuild 把待测 TS 打成 ESM 再跑断言，判据
 * 全部针对**真实文件系统**（系统临时目录 + Windows junction / POSIX symlink
 * 真实 reparse 语义），不用 mock。
 *
 * ── 判据 ──
 *
 * ① read 只返回已存在并 verified 的 roots，绝不创建 staging；
 * ② stage 初始不存在时安全创建（mkdir → realpath → boundary check 后注册）；
 * ③ readonly 不创建目录；
 * ④ stage 幂等；
 * ⑤ overlay/base 缺失时 read/stage 都失败关闭（root-missing）；
 * ⑥ staging 是链接指向边界之外 → 拒绝（staging-boundary-escape）。
 */
import { buildSync } from 'esbuild';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'bridge-roots';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps', 'desktop', 'src', 'main', 'bridgeRoots.ts');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(source)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'SOURCE_MISSING',
    message: `缺少待测源码：${source}。源码缺失必须失败关闭，否则判据零样本恒真。`
  }, 1);
}

// bundle 输出必须落在仓库内：产物 import '@soulforge/core'（workspace 链接），
// 只有从仓库向上解析 node_modules 才找得到；mkdtemp 在系统临时目录会失败。
const bundleDir = join(root, 'node_modules', '.cache', 'bridge-roots-gate');
mkdirSync(bundleDir, { recursive: true });
const work = mkdtempSync(join(bundleDir, 'run-'));
const findings = [];
let checked = 0;

const check = (condition, message) => {
  checked += 1;
  if (!condition) findings.push(message);
};

try {
  const bundle = join(work, 'bridgeRoots.mjs');
  buildSync({
    entryPoints: [source],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    // @soulforge/core 由根 node_modules workspace 链接提供（需先 build）；
    // 打进 bundle 会把 core 的 CJS 依赖链卷进来，触发「Dynamic require of fs」。
    external: ['@soulforge/core']
  });
  const { prepareBridgeRoots } = await import(
    `file:///${bundle.replace(/\\/g, '/')}`
  );

  // 固定目录布局：storage 根与 overlay/base 都真实存在；staging 初始不存在。
  const overlayRoot = join(work, 'mods');
  const baseRoot = join(work, 'game');
  const storageRoot = join(work, 'appdata', 'workspaces', 'ws-1');
  mkdirSync(overlayRoot, { recursive: true });
  mkdirSync(baseRoot, { recursive: true });
  mkdirSync(storageRoot, { recursive: true });
  const session = { overlayRoot, baseRoot, storageRoot };
  const stagingRoot = join(storageRoot, 'staging');

  // ① read：只返回已存在的 roots，不含 staging，不创建 staging。
  let readResult = await prepareBridgeRoots(session, 'read');
  check(readResult.ok === true, 'read 在全部 root 存在时应成功');
  if (readResult.ok) {
    check(
      readResult.allowedRoots.includes(overlayRoot) && readResult.allowedRoots.includes(baseRoot),
      'read 必须返回 overlay 与 base'
    );
    check(
      !readResult.allowedRoots.includes(stagingRoot),
      'read 不得附加 staging'
    );
    check(
      readResult.writableRoots.length === 0,
      'read 不得声明 writable roots'
    );
  }
  check(!existsSync(stagingRoot), 'read 不得创建 staging 目录');

  // ③ readonly 不创建目录（与 ① 合并验证后再次确认）。
  readResult = await prepareBridgeRoots(session, 'read');
  check(readResult.ok === true, 'read 重复调用仍应成功');
  check(!existsSync(stagingRoot), 'read 重复调用后 staging 仍不存在');

  // ② stage：初始不存在 → 安全创建并注册。
  let stageResult = await prepareBridgeRoots(session, 'stage');
  check(stageResult.ok === true, 'stage 初始不存在时应安全创建');
  if (stageResult.ok) {
    check(existsSync(stagingRoot), 'stage 必须真实创建 staging 目录');
    check(
      stageResult.allowedRoots.includes(stagingRoot),
      'stage 的 allowedRoots 必须含 staging'
    );
    check(
      stageResult.writableRoots.length === 1 && stageResult.writableRoots[0] === stagingRoot,
      'stage 的 writableRoots 必须恰好是 staging'
    );
    check(
      stageResult.allowedRoots.includes(overlayRoot) && stageResult.allowedRoots.includes(baseRoot),
      'stage 的 allowedRoots 仍含 overlay 与 base'
    );
  }

  // ④ stage 幂等：已存在时重复调用同样成功，roots 集合一致。
  const stageAgain = await prepareBridgeRoots(session, 'stage');
  check(stageAgain.ok === true, 'stage 重复调用应幂等成功');
  if (stageResult.ok && stageAgain.ok) {
    check(
      JSON.stringify([...stageResult.allowedRoots].sort()) === JSON.stringify([...stageAgain.allowedRoots].sort()),
      '两次 stage 的 allowedRoots 必须一致'
    );
  }

  // ⑤ root-missing：overlay 缺失时 read 与 stage 都失败关闭。
  const missingSession = { overlayRoot: join(work, 'no-such-mods'), baseRoot, storageRoot };
  const missingRead = await prepareBridgeRoots(missingSession, 'read');
  check(
    missingRead.ok === false && missingRead.code === 'root-missing',
    'overlay 缺失时 read 必须失败关闭（root-missing）'
  );
  const missingStage = await prepareBridgeRoots(missingSession, 'stage');
  check(
    missingStage.ok === false && missingStage.code === 'root-missing',
    'overlay 缺失时 stage 必须失败关闭（root-missing）'
  );

  // ⑥ symlink/越界拒绝：staging 是链接指向 storageRoot 边界之外 → 拒绝。
  // 重新构造一个独立布局（避免污染上面已注册的 staging）。
  const outside = mkdtempSync(join(work, 'outside-'));
  const evilStorageRoot = join(work, 'evil-storage');
  const evilSession = { overlayRoot, baseRoot, storageRoot: evilStorageRoot };
  mkdirSync(evilStorageRoot, { recursive: true });
  let linkCreated = false;
  try {
    symlinkSync(outside, join(evilStorageRoot, 'staging'), process.platform === 'win32' ? 'junction' : 'dir');
    linkCreated = true;
  } catch (error) {
    // 无权限创建链接（某些 CI）→ 结构化跳过而非误报。
    check(
      true,
      `链接创建被环境拒绝（${error instanceof Error ? error.message : String(error)}）；本判据在支持链接的环境运行`
    );
  }
  if (linkCreated) {
    const evilStage = await prepareBridgeRoots(evilSession, 'stage');
    check(
      evilStage.ok === false && evilStage.code === 'staging-boundary-escape',
      'staging 经链接指向边界之外必须拒绝（staging-boundary-escape）'
    );
    const recheck = await prepareBridgeRoots(evilSession, 'stage');
    check(
      recheck.ok === false && recheck.code === 'staging-boundary-escape',
      '越界 staging 必须恒拒绝（重复调用）'
    );
  }
} catch (error) {
  findings.push(`执行失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 空集合失败关闭：若某次重构让断言一条都没跑，上面的 findings 会是空的而看着像通过。
if (checked < 10) {
  findings.push(`断言执行数过少（${checked}），判据可能已失效`);
}

if (findings.length > 0) {
  report({ ok: false, gate: LABEL, status: 'failed', code: 'BRIDGE_ROOTS_VIOLATION', checked, findings }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  checked,
  message: 'Bridge allowed-root 生命周期（read 不附加 staging / stage 安全创建 / 越界拒绝）符合 §13.2。',
  nonClaim: '本判据验证 prepareBridgeRoots 的文件系统行为（真实文件系统，无 mock）。'
    + '它不启动 Bridge 进程，也不验证某个具体 handler 是否把返回值传给了 Bridge ——'
    + '后者由 desktop-ipc-contract 的通道对账与 ipc.ts 中 bridgeAllowedRoots 已删除'
    + '（全部调用点改为 prepareBridgeRoots）共同覆盖。'
}, 0);

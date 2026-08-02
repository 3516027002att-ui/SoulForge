#!/usr/bin/env node
/**
 * gov CLI 与治理锁的负向 fixture。
 *
 * 为什么必须有：一把坏掉的锁和一把好锁在正常路径上表现完全一样——两个进程
 * 顺序执行时都会成功。只有并发和崩溃场景能区分它们，而那正是不写测试就永远
 * 不会被发现的场景。同理，「后置校验失败要回滚」若失效，只有在真的写坏数据
 * 那一次才暴露，而那一次已经把仓库停在门禁红上。
 *
 * 本 fixture 不接触 docs/governance/ 真实数据：锁测试用临时目录当仓库根，
 * CLI 测试在临时 git 仓库的治理数据副本上跑，避免污染真实执行面板。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireGovernanceLock, STALE_LOCK_MS } from './gov/lock.mjs';

const root = process.cwd();
const findings = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (!condition) {
    findings.push({ severity: 'error', code: 'GOV_CLI_FIXTURE_FAIL', where: name, message: detail });
  }
}

// ---------------------------------------------------------------------------
// 锁语义
// ---------------------------------------------------------------------------

const lockRoot = mkdtempSync(join(tmpdir(), 'sf-gov-lock-'));

const first = acquireGovernanceLock(lockRoot, 'owner-A');
check('lock/first-acquire', first.ok === true, `首次获取锁应成功，实际 ${JSON.stringify(first)}`);

const second = acquireGovernanceLock(lockRoot, 'owner-B');
check(
  'lock/second-blocked',
  second.ok === false && second.code === 'GOV_LOCK_HELD',
  `同一根路径的第二次获取必须被拒，实际 ${JSON.stringify(second)}`
);
check(
  'lock/holder-reported',
  second.ok === false && second.holder?.owner === 'owner-A' && second.holder?.pid === process.pid,
  '被拒时必须报出持有者，否则调用方无法判断该等待还是该回收。'
);

const lockFile = first.ok ? first.path : null;
check('lock/file-outside-repo', lockFile !== null && !lockFile.startsWith(root),
  `锁文件不得落在仓库内，实际 ${lockFile}`);

if (first.ok) first.release();
check('lock/released-file-removed', lockFile !== null && !existsSync(lockFile),
  '释放后锁文件必须删除，否则下一个进程会被残留锁挡住。');

const third = acquireGovernanceLock(lockRoot, 'owner-C');
check('lock/reacquire-after-release', third.ok === true, `释放后应可再次获取，实际 ${JSON.stringify(third)}`);
if (third.ok) third.release();

// 不同仓库根不得互相阻塞：否则多 worktree 并行会被一把全局锁串行化。
const otherRoot = mkdtempSync(join(tmpdir(), 'sf-gov-lock-other-'));
const heldA = acquireGovernanceLock(lockRoot, 'root-A');
const heldB = acquireGovernanceLock(otherRoot, 'root-B');
check('lock/per-root-isolation', heldA.ok === true && heldB.ok === true,
  '不同仓库根应使用不同锁文件，实际被互相阻塞。');
check('lock/distinct-paths', heldA.ok && heldB.ok && heldA.path !== heldB.path,
  '不同仓库根的锁路径必须不同。');
if (heldA.ok) heldA.release();
if (heldB.ok) heldB.release();

// 死锁回收：pid 不存在且超过窗口 → 可回收；未超过窗口 → 不得回收。
function writeStaleLock(targetRoot, ageMs) {
  const probe = acquireGovernanceLock(targetRoot, 'probe');
  if (!probe.ok) throw new Error('fixture 自身无法取锁');
  const path = probe.path;
  probe.release();
  // pid 99999999 超出 Windows/Linux 常规 pid 范围，探测必然为「不存在」。
  writeFileSync(path, JSON.stringify({
    pid: 99_999_999,
    owner: 'dead-agent',
    acquiredAtMs: Date.now() - ageMs,
    acquiredAt: new Date(Date.now() - ageMs).toISOString()
  }), 'utf8');
  return path;
}

const staleRoot = mkdtempSync(join(tmpdir(), 'sf-gov-lock-stale-'));
writeStaleLock(staleRoot, STALE_LOCK_MS + 5_000);
const reclaimed = acquireGovernanceLock(staleRoot, 'owner-D');
check('lock/stale-reclaimed', reclaimed.ok === true,
  `持有者进程已消失且超过 ${STALE_LOCK_MS}ms 时必须可回收，否则一次崩溃永久冻结治理写入。实际 ${JSON.stringify(reclaimed)}`);
if (reclaimed.ok) reclaimed.release();

const freshRoot = mkdtempSync(join(tmpdir(), 'sf-gov-lock-fresh-'));
writeStaleLock(freshRoot, 1_000);
const notReclaimed = acquireGovernanceLock(freshRoot, 'owner-E');
check('lock/fresh-not-reclaimed',
  notReclaimed.ok === false && notReclaimed.code === 'GOV_LOCK_HELD',
  '未超过回收窗口的锁不得被抢走，否则正常持锁的长任务会被打断。');

const corruptRoot = mkdtempSync(join(tmpdir(), 'sf-gov-lock-corrupt-'));
const corruptProbe = acquireGovernanceLock(corruptRoot, 'probe');
if (corruptProbe.ok) {
  const path = corruptProbe.path;
  corruptProbe.release();
  writeFileSync(path, 'not json', 'utf8');
  const onCorrupt = acquireGovernanceLock(corruptRoot, 'owner-F');
  check('lock/corrupt-not-bypassed',
    onCorrupt.ok === false && onCorrupt.code === 'GOV_LOCK_HELD',
    '锁文件不可解析时不得当作无锁闯入；应按未确认持有者拒绝，交由 staleness 回收。');
}

// ---------------------------------------------------------------------------
// CLI 行为（在治理数据副本上跑，不动真实数据）
// ---------------------------------------------------------------------------

const cliRoot = mkdtempSync(join(tmpdir(), 'sf-gov-cli-'));

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function runGov(args, cwd) {
  const result = spawnSync(process.execPath, [join(cliRoot, 'scripts', 'gov.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  return { status: result.status, payload, stdout: result.stdout, stderr: result.stderr };
}

// 构造最小仓库：只复制门禁运行所需的脚本与治理数据 + node_modules 供 ajv 解析。
for (const dir of ['scripts', 'docs/governance']) {
  mkdirSync(join(cliRoot, dir), { recursive: true });
}
cpSync(join(root, 'scripts'), join(cliRoot, 'scripts'), { recursive: true });
cpSync(join(root, 'docs/governance'), join(cliRoot, 'docs/governance'), { recursive: true });
cpSync(join(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'), join(cliRoot, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'));
cpSync(join(root, 'package.json'), join(cliRoot, 'package.json'));
// 先建基线提交，再挂 node_modules：反序会让 git add 试图索引上万个依赖文件。
// 冻结拦截需要可解析的 HEAD，因此这里的提交必须成功，不能静默继续。
writeFileSync(join(cliRoot, '.gitignore'), 'node_modules/\n', 'utf8');
runGit(['init', '--quiet'], cliRoot);
runGit(['config', 'user.email', 'fixture@example.invalid'], cliRoot);
runGit(['config', 'user.name', 'fixture'], cliRoot);
runGit(['add', '-A'], cliRoot);
const baselineCommit = runGit(['commit', '--quiet', '-m', 'fixture baseline'], cliRoot);
const headCheck = runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cliRoot);
if (headCheck.status !== 0) {
  findings.push({
    severity: 'error',
    code: 'GOV_CLI_FIXTURE_SETUP_FAIL',
    where: 'fixture/setup',
    message: `临时仓库基线提交失败，冻结拦截无从比对：${baselineCommit.stderr?.slice(0, 300)}`
  });
}

// ajv 通过 node_modules 解析；用 junction/symlink 避免复制上万文件。
spawnSync('cmd', ['/c', 'mklink', '/J', join(cliRoot, 'node_modules'), join(root, 'node_modules')], {
  encoding: 'utf8',
  windowsHide: true
});
if (!existsSync(join(cliRoot, 'node_modules'))) {
  findings.push({
    severity: 'error',
    code: 'GOV_CLI_FIXTURE_SETUP_FAIL',
    where: 'fixture/setup',
    message: '无法为临时仓库准备 node_modules，CLI 测试无法运行；失败关闭而不是跳过。'
  });
}

const next = runGov(['next'], cliRoot);
check('cli/next-ok', next.status === 0 && next.payload?.ok === true,
  `gov next 应成功，实际 status=${next.status} stderr=${next.stderr?.slice(0, 300)}`);
const claimable = next.payload?.claimable ?? [];
check('cli/next-lists-ready', claimable.length > 0 && claimable.every((item) => item.alreadyClaimed === false),
  'gov next 应只列出未被 claim 的 ready 切片。');

const targetSlice = claimable[0]?.sliceId ?? null;
if (targetSlice) {
  const claimed = runGov(['claim', '--slice', targetSlice, '--owner', 'fixture-A'], cliRoot);
  check('cli/claim-ok', claimed.status === 0 && claimed.payload?.lifecycle === 'active',
    `claim 应成功并置 active，实际 ${JSON.stringify(claimed.payload)?.slice(0, 300)}`);

  const doubled = runGov(['claim', '--slice', targetSlice, '--owner', 'fixture-B'], cliRoot);
  check('cli/double-claim-rejected',
    doubled.status === 1 && doubled.payload?.code === 'GOV_SLICE_ALREADY_CLAIMED',
    `重复 claim 必须被拒，实际 ${JSON.stringify(doubled.payload)?.slice(0, 300)}`);

  const wrongOwner = runGov(['release', '--slice', targetSlice, '--owner', 'fixture-B'], cliRoot);
  check('cli/release-owner-checked',
    wrongOwner.status === 1 && wrongOwner.payload?.code === 'GOV_CLAIM_OWNER_MISMATCH',
    '非持有者不得在无 --force 时释放他人 claim。');

  // 该切片是某个 open Gate 仅剩的活动切片时，complete 必须诚实拒绝：
  // 后继切片是什么属于范围裁定，CLI 凭空补一个就是在伪造进度。
  const gatesData = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/gates.json'), 'utf8'));
  const slicesNow = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/slices.json'), 'utf8'));
  const lifecycleOf = (id) => slicesNow.slices.find((slice) => slice.sliceId === id)?.lifecycle;
  const isSoleLiveSlice = gatesData.gates.some((gate) =>
    gate.gateState === 'open'
    && (gate.sliceRefs ?? []).includes(targetSlice)
    && !(gate.sliceRefs ?? []).some((ref) =>
      ref !== targetSlice && (lifecycleOf(ref) === 'ready' || lifecycleOf(ref) === 'active')));

  const completedBefore = slicesNow;
  const authorityBefore = completedBefore.slices.find((slice) => slice.sliceId === targetSlice)?.authority;
  const completed = runGov(['complete', '--slice', targetSlice, '--owner', 'fixture-A'], cliRoot);
  const completedAfter = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/slices.json'), 'utf8'));
  const sliceAfter = completedAfter.slices.find((slice) => slice.sliceId === targetSlice);

  if (isSoleLiveSlice) {
    check('cli/complete-refuses-gate-stranding',
      completed.status === 1 && completed.payload?.code === 'GOV_GATE_WOULD_STRAND',
      `切片是 open Gate 仅剩活动切片时必须诚实拒绝，实际 ${JSON.stringify(completed.payload)?.slice(0, 400)}`);
    check('cli/complete-refusal-leaves-active', sliceAfter?.lifecycle === 'active',
      '拒绝时不得留下任何状态改动。');
  } else {
    check('cli/complete-ok', completed.status === 0 && sliceAfter?.lifecycle === 'completed',
      `complete 应置 completed，实际 ${sliceAfter?.lifecycle}；CLI 返回 ${JSON.stringify(completed.payload)?.slice(0, 600)}`);
    check('cli/complete-does-not-raise-authority', sliceAfter?.authority === authorityBefore,
      `complete 不得改动 authority（改状态不等于验证过），${authorityBefore} → ${sliceAfter?.authority}`);
    check('cli/complete-drops-claim',
      !completedAfter.activeClaims.some((claim) => claim.sliceId === targetSlice),
      'complete 必须同时移除 claim，否则 claim 与 lifecycle 会不一致。');
  }

  // complete 的完整成功路径必须被证明，否则「拒绝」分支会掩盖它从未跑通。
  // 构造法：给同一 Gate 追加一个后继切片，使 stranding 前提消失。
  const successRoot = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/slices.json'), 'utf8'));
  const successTarget = successRoot.slices.find((slice) => slice.lifecycle === 'active');
  if (successTarget) {
    const gateWith = gatesData.gates.find((gate) =>
      gate.gateState === 'open' && (gate.sliceRefs ?? []).includes(successTarget.sliceId));
    if (gateWith) {
      const successorId = `${successTarget.sliceId}-SUCCESSOR`;
      successRoot.slices.push({
        ...successTarget,
        sliceId: successorId,
        lifecycle: 'ready',
        declaresUnfrozenValidation: false,
        blockerRefs: []
      });
      writeFileSync(join(cliRoot, 'docs/governance/slices.json'),
        `${JSON.stringify(successRoot, null, 2)}\n`, 'utf8');
      gateWith.sliceRefs = [...gateWith.sliceRefs, successorId];
      writeFileSync(join(cliRoot, 'docs/governance/gates.json'),
        `${JSON.stringify(gatesData, null, 2)}\n`, 'utf8');

      const validationBefore = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/validation.json'), 'utf8'));
      const wasUnfrozen = validationBefore.unfrozen.some((entry) => entry.sliceId === successTarget.sliceId);
      const authorityWas = successTarget.authority;
      const ok = runGov(['complete', '--slice', successTarget.sliceId], cliRoot);
      const after = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/slices.json'), 'utf8'));
      const done = after.slices.find((slice) => slice.sliceId === successTarget.sliceId);
      const validationAfter = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/validation.json'), 'utf8'));

      check('cli/complete-success-path',
        ok.status === 0 && done?.lifecycle === 'completed',
        `有后继切片时 complete 应成功，实际 ${JSON.stringify(ok.payload)?.slice(0, 500)}`);
      check('cli/complete-keeps-authority', done?.authority === authorityWas,
        `complete 不得改动 authority，${authorityWas} → ${done?.authority}`);
      check('cli/complete-drops-claim-on-success',
        !after.activeClaims.some((claim) => claim.sliceId === successTarget.sliceId),
        'complete 必须同时移除 claim。');
      if (wasUnfrozen) {
        check('cli/complete-prunes-unfrozen-validation',
          !validationAfter.unfrozen.some((entry) => entry.sliceId === successTarget.sliceId),
          'completed 切片必须同时从 validation-unfrozen 清单移除，否则门禁必红。');
      }
    }
  }
}

// 后置校验回滚：制造一个「写入后必然违规」的场景——claim 一个 ready 切片，
// 但先把该切片的 authority 改成超过 cap，使写后校验必然失败。
const rollbackTarget = (runGov(['next'], cliRoot).payload?.claimable ?? [])[0]?.sliceId ?? null;
if (rollbackTarget) {
  const slicesPath = join(cliRoot, 'docs/governance/slices.json');
  const data = JSON.parse(readFileSync(slicesPath, 'utf8'));
  const slice = data.slices.find((item) => item.sliceId === rollbackTarget);
  slice.authority = 'native-verified';
  slice.authorityCap = 'candidate';
  writeFileSync(slicesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const before = readFileSync(slicesPath, 'utf8');

  const blocked = runGov(['claim', '--slice', rollbackTarget, '--owner', 'fixture-C'], cliRoot);
  check('cli/precheck-fails-on-broken-data',
    blocked.status === 1 && blocked.payload?.code === 'GOV_PRECHECK_FAILED',
    `治理数据已违规时不得叠加改动，实际 ${JSON.stringify(blocked.payload)?.slice(0, 300)}`);
  check('cli/precheck-leaves-data-untouched', readFileSync(slicesPath, 'utf8') === before,
    '前置校验失败时不得写入任何内容。');
}

rmSync(cliRoot, { recursive: true, force: true });
for (const dir of [lockRoot, otherRoot, staleRoot, freshRoot, corruptRoot]) {
  rmSync(dir, { recursive: true, force: true });
}

const errors = findings.filter((finding) => finding.severity === 'error');
console.log(JSON.stringify({
  ok: errors.length === 0,
  message: errors.length === 0
    ? `gov CLI 与治理锁负向 fixture 全部通过（${checks} 项）`
    : `gov CLI fixture 失败 ${errors.length} 项`,
  checks,
  lockedBehaviours: [
    '同一仓库根的并发写命令互斥；被拒时报出持有者',
    '锁文件位于系统临时目录，不落仓库、不落 Mod 工作区',
    '不同仓库根互不阻塞（多 worktree 可并行）',
    '持有者进程消失且超过回收窗口才回收；窗口内不得抢锁',
    '锁文件不可解析时不得当作无锁闯入',
    '重复 claim、非持有者释放被拒；complete 不提升 authority',
    '治理数据已违规时拒绝叠加改动且不写入'
  ],
  findings
}, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;

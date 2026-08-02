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
import { computeFingerprint } from './gov/seal.mjs';
import { computeHandoffFingerprintSha256, parseSealBaseline } from './handoff-integrity-lib.mjs';

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

// 把既有封存证据的锚点改写为本临时仓库的基线提交。
//
// 不改的后果实测过：真实仓库的 HEAD 不存在于临时仓库历史，
// `merge-base --is-ancestor` 非 0 非 1 → subjectScanAvailable=false →
// 每个 passed Gate 报 GATE_FRESHNESS_UNVERIFIABLE，于是 seal 的后置校验恒失败、
// 恒走回滚分支。正向路径（指纹自洽、交接书投影、未提交提示）共 7 条断言一次都
// 没执行过，而「失败不追加半条记录」这类负向断言是因为数据本来就红才通过的。
//
// 改写是合法的 fixture 构造而不是放宽判据：锚点语义是「这条证据封存时的 HEAD」，
// 在临时仓库里那就该是基线提交。主题域集合不含 evidence.jsonl / gates.json /
// slices.json（实测 gateSubjectRegistry().allFiles 无此三者），所以 seal 自身的
// 写入不会让 freshness 转红——正向路径本就应当可达。
{
  const fixtureHead = runGit(['rev-parse', 'HEAD'], cliRoot);
  const headSha = fixtureHead.status === 0 ? fixtureHead.stdout.trim() : null;
  if (headSha !== null && /^[0-9a-f]{40}$/.test(headSha)) {
    const evidencePath = join(cliRoot, 'docs/governance/evidence.jsonl');
    const raw = readFileSync(evidencePath, 'utf8');
    // 改 HEAD 必须连 fingerprintSha256 一起重算：指纹把 HEAD 算进去，
    // 只改锚点会让每条历史证据报 EVIDENCE_FINGERPRINT_MISMATCH（实测 10 条）。
    // 重算复用 computeHandoffFingerprintSha256 这一唯一实现，不在 fixture 里
    // 另写一份 canonical 拼装——两份实现分叉时 fixture 会「测过但真实仓库红」。
    const rewritten = raw.split('\n').map((line) => {
      if (line.trim().length === 0) return line;
      const parsed = parseSealBaseline(line.match(/"fingerprint"\s*:\s*"([^"]*)"/)?.[1] ?? '');
      if (parsed?.formatValid !== true) return line;
      const nextFields = { ...parsed.fields, head: headSha };
      const nextSha = computeHandoffFingerprintSha256(nextFields);
      return line
        .replace(/HEAD=[0-9a-f]{40}/, `HEAD=${headSha}`)
        .replace(/fingerprintSha256=[0-9a-f]{64}/, `fingerprintSha256=${nextSha}`);
    }).join('\n');
    if (rewritten !== raw) {
      writeFileSync(evidencePath, rewritten, 'utf8');
      runGit(['add', 'docs/governance/evidence.jsonl'], cliRoot);
      runGit(['commit', '--quiet', '-m', 'fixture: rebase seal anchors onto fixture baseline'], cliRoot);
      // 提交后锚点成了 HEAD 的父，仍是祖先，判定可用。
    }
  }
}

const next = runGov(['next'], cliRoot);
check('cli/next-ok', next.status === 0 && next.payload?.ok === true,
  `gov next 应成功，实际 status=${next.status} stderr=${next.stderr?.slice(0, 300)}`);
const claimable = next.payload?.claimable ?? [];
check('cli/next-lists-ready', claimable.length > 0 && claimable.every((item) => item.alreadyClaimed === false),
  'gov next 应只列出未被 claim 的 ready 切片。');

// 选点输出必须自带完整闭环：agent 光看它就能知道改哪些文件、跑哪条验证、
// 做完怎么收尾。缺任一环就得回 3800 行交接书里翻，那是首次可行动延迟的主要来源。
check('cli/next-item-self-sufficient',
  claimable.every((item) =>
    Array.isArray(item.entryPoints) && item.entryPoints.length > 0
    && typeof item.requiredValidation === 'string' && item.requiredValidation.length > 0
    && typeof item.hardPrerequisites === 'string' && item.hardPrerequisites.length > 0),
  '每条可 claim 切片必须同时给出 entryPoints、requiredValidation 与 hardPrerequisites。');

// workflow 是 claim 之后到封存之间的流程骨架。断了这一环，agent 做完改动会
// 卡在「怎么收尾」上，而封存漏步骤会撞上指向错误原因的 GATE_EVIDENCE_STALE。
{
  const workflow = next.payload?.workflow;
  check('cli/next-includes-workflow',
    Array.isArray(workflow) && workflow.length >= 5,
    `选点输出必须带 claim→验证→封存→complete 的流程骨架，实际 ${JSON.stringify(workflow)?.slice(0, 160)}`);
  const workflowText = (workflow ?? []).join('\n');
  for (const [label, needle] of [
    ['claim', 'gov claim'],
    ['validation', 'requiredValidation'],
    ['seal', 'gov seal'],
    ['complete', 'gov complete']
  ]) {
    check(`cli/next-workflow-mentions-${label}`, workflowText.includes(needle),
      `流程骨架必须提到 ${needle}，否则闭环缺一环。`);
  }
}

// --release 的默认值必须来自 releases.json 的 currentRelease，不能是字面量。
// 治理要跨 V0.5 → V0.6：写死版本号会在 V0.5 冻结后把新证据继续挂到旧版本上，
// 而 currentRelease 已经翻页——两份权威分叉且无门禁可见。
{
  const releasesData = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/releases.json'), 'utf8'));
  const knownReleases = releasesData.releases.map((entry) => entry.release);
  check('cli/next-default-release-follows-current',
    next.payload?.release === releasesData.currentRelease,
    `gov next 默认版本应等于 currentRelease=${releasesData.currentRelease}，实际 ${JSON.stringify(next.payload?.release)}。`);
  check('cli/next-default-release-filters',
    claimable.every((item) => item.targetRelease === releasesData.currentRelease),
    '默认过滤后不应出现其他版本的切片——V0.6 切片的硬前置尚未成立，混进选点会误导 agent。');

  // 未登记版本必须硬失败。原先只校验 /^V\d+\.\d+$/ 形状，V9.9 能通过并封存出
  // 一条挂在不存在版本上的证据；cmdNext 更是连形状都不校验，拼错静默返回空列表,
  // agent 会把「参数拼错」读成「没有可推进切片」。
  const unknownRelease = runGov(['next', '--release', 'V9.9'], cliRoot);
  check('cli/next-unknown-release-rejected',
    unknownRelease.status === 1 && unknownRelease.payload?.code === 'RELEASE_UNKNOWN'
      && Array.isArray(unknownRelease.payload?.knownReleases),
    `未登记版本必须拒绝并回报已知版本列表，实际 ${JSON.stringify(unknownRelease.payload)?.slice(0, 200)}`);
  const badShape = runGov(['next', '--release', 'v05'], cliRoot);
  check('cli/next-malformed-release-rejected',
    badShape.status === 1 && badShape.payload?.code === 'RELEASE_SHAPE_INVALID',
    `形状非法的版本必须拒绝，实际 ${JSON.stringify(badShape.payload)?.slice(0, 200)}`);

  // 每个已登记版本都必须可查询。这条断言随 releases.json 增长而自动覆盖新版本,
  // 不需要在 fixture 里追加 V0.6、V0.7 的硬编码用例。
  const slicesData = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/slices.json'), 'utf8'));
  const releaseOf = new Map(slicesData.slices.map((slice) => [slice.sliceId, slice.targetRelease]));

  for (const releaseId of knownReleases) {
    const scoped = runGov(['next', '--release', releaseId], cliRoot);
    check(`cli/next-release-${releaseId}-queryable`,
      scoped.status === 0 && scoped.payload?.release === releaseId
        && (scoped.payload?.claimable ?? []).every((item) => item.targetRelease === releaseId),
      `${releaseId} 应可查询且只返回该版本切片，实际 ${JSON.stringify(scoped.payload)?.slice(0, 200)}`);

    // claimable/activeSlices/blockedSlices 必须用同一个版本判据。
    // 实测漏过一次：只给 claimable 加了过滤，于是 next --release V0.6 返回
    // claimable=0 但 activeSlices=5，而那 5 条 targetRelease 全是 V0.5——
    // agent 会读成「V0.6 有人在做了」，实际是 V0.5 的在飞 claim 漏进了 V0.6 视图。
    const leaked = [
      ...(scoped.payload?.activeSlices ?? []),
      ...(scoped.payload?.blockedSlices ?? [])
    ].filter((entry) => releaseOf.get(entry.sliceId) !== releaseId);
    check(`cli/next-release-${releaseId}-active-blocked-scoped`, leaked.length === 0,
      `${releaseId} 的 activeSlices/blockedSlices 不得混入其他版本切片，实际混入 `
      + JSON.stringify(leaked.map((entry) => `${entry.sliceId}@${releaseOf.get(entry.sliceId)}`)));

    // 无可 claim 切片时，出路必须与该版本切片的实际 lifecycle 分布匹配。
    // 实测踩过：V0.6 的 3 条切片全是 deferred 且 blockerRefs 为空数组，而消息一律说
    // 「先完成或释放在飞切片，或按 blockers.json 解阻塞」——agent 去查 blockers.json
    // 什么都查不到，deferred 也不是靠释放 claim 能变 ready 的。给错出路比不给更糟。
    if ((scoped.payload?.claimable ?? []).length === 0) {
      const lifecycles = new Set(
        slicesData.slices.filter((slice) => slice.targetRelease === releaseId).map((slice) => slice.lifecycle)
      );
      const message = String(scoped.payload?.message ?? '');
      if (lifecycles.has('deferred')) {
        check(`cli/next-release-${releaseId}-deferred-guidance`,
          message.includes('resumeRequires') && !message.includes('按 blockers.json 解阻塞'),
          `${releaseId} 只剩 deferred 切片时，出路必须指向 scope.json 的 resumeRequires 而非 blockers.json，实际「${message}」`);
      }
      check(`cli/next-release-${releaseId}-empty-message-names-lifecycle`,
        [...lifecycles].some((lifecycle) => message.includes(lifecycle)),
        `${releaseId} 无可 claim 时消息必须点明实际 lifecycle（${[...lifecycles].join('/')}），实际「${message}」`);
    }

    // 指对方向还不够：只说「去 scope.json 找 resumeRequires」仍然是把 agent 送去
    // 手工检索——V0.6 的 3 条 deferred 切片对应 12 个 scopeItem，靠 capabilityId
    // 反查是每个 agent 都要重做一遍的活。承接条件必须直接投影出来。
    const deferredIn = slicesData.slices
      .filter((slice) => slice.targetRelease === releaseId && slice.lifecycle === 'deferred');
    if (deferredIn.length > 0) {
      const projected = scoped.payload?.deferredSlices ?? [];
      check(`cli/next-release-${releaseId}-deferred-projected`,
        projected.length === deferredIn.length,
        `${releaseId} 的 ${deferredIn.length} 条 deferred 切片必须全部出现在 deferredSlices，实际 ${projected.length} 条`);
      // available=false 也是合法结果（治理数据不一致时必须说出来而不是返回空数组），
      // 但必须带 reason——空数组会被读成「没有承接条件」，那是错误结论。
      check(`cli/next-release-${releaseId}-deferred-resume-explained`,
        projected.length > 0 && projected.every((entry) =>
          entry.resumeRequires?.available === true
            ? Array.isArray(entry.resumeRequires.fromScopeItems)
              && entry.resumeRequires.fromScopeItems.length > 0
              && entry.resumeRequires.fromScopeItems.every((item) =>
                typeof item.scopeItemId === 'string' && item.resumeRequires !== undefined)
            : typeof entry.resumeRequires?.reason === 'string'
              && entry.resumeRequires.reason.length > 0),
        `每条 deferred 切片要么给出非空 fromScopeItems，要么给出 reason 说明为何取不到，`
        + `不得返回空数组冒充「没有承接条件」。实际 ${JSON.stringify(projected.map((entry) => entry.resumeRequires))?.slice(0, 400)}`);
    } else {
      // 没有 deferred 切片时不投影，避免污染默认版本的首屏体积
      // （实测 V0.5 首屏 6608 B，只比投影前多 24 B）。
      check(`cli/next-release-${releaseId}-no-deferred-noise`,
        (scoped.payload?.deferredSlices ?? []).length === 0,
        `${releaseId} 没有 deferred 切片时不得投影 deferredSlices，实际 ${JSON.stringify(scoped.payload?.deferredSlices)?.slice(0, 200)}`);
    }
  }

  const allReleases = runGov(['next', '--all'], cliRoot);
  check('cli/next-all-spans-releases',
    allReleases.status === 0 && allReleases.payload?.release === null,
    `--all 应跨版本查看（release=null），实际 ${JSON.stringify(allReleases.payload?.release)}。`);

  // 在飞 claim 的心跳新鲜度必须暴露，否则「有主」与「被遗弃」在输出里长得一样。
  //
  // 实测：5 条 owner=coordinator-agent 的 claim 心跳停在 2026-08-01，其后 24 个提交
  // 全在治理层、没有一个碰过这些切片的 entryPoints，同期封存的 22 条证据也全是
  // EV-REL-SCOPE-*。它们是被中断的半成品，而 next 当时只报 sliceId/owner，接手的
  // agent 读成「有人在做」全部避开，V0.5 的可 claim 面被无声压到 4 条。
  //
  // 陈旧与新鲜两种结局各自显式构造，不共用 if/else——互斥分支靠「环境碰巧走哪边」
  // 声称覆盖两种结局是假覆盖（本 fixture 曾因此让 7 条正向断言一次都没执行）。
  {
    const slicesPath = join(cliRoot, 'docs/governance/slices.json');
    const pristine = readFileSync(slicesPath, 'utf8');
    const perturbed = JSON.parse(pristine);
    const targetClaim = perturbed.activeClaims?.[0] ?? null;

    if (targetClaim === null) {
      check('cli/next-stale-claim-scenario-constructible', false,
        '治理数据里没有 activeClaims，无法构造心跳陈旧场景；判据未被执行等于没有门禁。');
    } else {
      const sliceId = targetClaim.sliceId;

      // 场景一：心跳远早于现在 → 必须报陈旧并给出可执行出路。
      targetClaim.heartbeatAt = new Date(Date.now() - 72 * 3600000).toISOString();
      writeFileSync(slicesPath, `${JSON.stringify(perturbed, null, 2)}\n`, 'utf8');
      const staleRun = runGov(['next', '--all'], cliRoot);
      const staleEntry = (staleRun.payload?.activeSlices ?? [])
        .find((entry) => entry.sliceId === sliceId) ?? null;

      check('cli/next-stale-claim-flagged',
        staleEntry?.heartbeatStale === true,
        `心跳停 72 小时的 claim 必须报 heartbeatStale=true，实际 ${JSON.stringify(staleEntry)?.slice(0, 300)}`);
      // 只报 true 不够：接手者需要知道停了多久才能判断是否值得接手。
      check('cli/next-stale-claim-reports-duration',
        typeof staleEntry?.staleFor === 'string' && /\d+\s*小时/.test(staleEntry.staleFor),
        `陈旧 claim 必须给出停滞时长，实际 staleFor=${JSON.stringify(staleEntry?.staleFor)}`);
      // 出路必须同时给出两条分支与核实前置，否则 agent 会直接 release 掉可能有人在跑的切片。
      const hint = String(staleEntry?.recoveryHint ?? '');
      check('cli/next-stale-claim-hint-actionable',
        hint.includes(`gov release --slice ${sliceId}`)
          && hint.includes('gov complete')
          && hint.includes('核实')
          && hint.includes('不自动释放'),
        '陈旧提示必须给出「先按 recoveryTrigger 核实」+ release/complete 两条出路，'
        + `并声明 CLI 不自动释放，实际「${hint.slice(0, 300)}」`);

      // 场景二：心跳就在刚刚 → 必须不报陈旧，且不塞提示文本。
      // 这条独立构造而非依赖上一场景的 else 分支：误报会诱导接手者 release 掉
      // 别人正在写的切片，比漏报更危险，必须单独证明不会发生。
      targetClaim.heartbeatAt = new Date().toISOString();
      writeFileSync(slicesPath, `${JSON.stringify(perturbed, null, 2)}\n`, 'utf8');
      const freshRun = runGov(['next', '--all'], cliRoot);
      const freshEntry = (freshRun.payload?.activeSlices ?? [])
        .find((entry) => entry.sliceId === sliceId) ?? null;

      check('cli/next-fresh-claim-not-flagged',
        freshEntry?.heartbeatStale === false,
        `刚刷过心跳的 claim 不得报陈旧，实际 ${JSON.stringify(freshEntry)?.slice(0, 300)}`);
      check('cli/next-fresh-claim-no-hint',
        freshEntry?.recoveryHint === null,
        `心跳新鲜时不得塞 recoveryHint，否则每条在飞切片都带一段无关文本，实际 ${JSON.stringify(freshEntry?.recoveryHint)?.slice(0, 200)}`);

      // 场景三：心跳字段不可解析 → 判不出来就不下结论，不得伪装成陈旧。
      // 让格式问题冒充协作问题会把 agent 送去 release 一条其实有人在跑的切片。
      targetClaim.heartbeatAt = 'not-a-timestamp';
      writeFileSync(slicesPath, `${JSON.stringify(perturbed, null, 2)}\n`, 'utf8');
      const unparsableRun = runGov(['next', '--all'], cliRoot);
      const unparsableEntry = (unparsableRun.payload?.activeSlices ?? [])
        .find((entry) => entry.sliceId === sliceId) ?? null;
      check('cli/next-unparsable-heartbeat-not-flagged',
        unparsableEntry?.heartbeatStale === false && unparsableEntry?.staleFor === null,
        '心跳不可解析时必须返回 heartbeatStale=false、staleFor=null，而不是伪装成陈旧，'
        + `实际 ${JSON.stringify(unparsableEntry)?.slice(0, 300)}`);

      // 扰动必须还原，否则其后每条断言都跑在被改过的数据上（本 fixture 实测踩过）。
      writeFileSync(slicesPath, pristine, 'utf8');
      check('cli/next-stale-claim-fixture-restored',
        readFileSync(slicesPath, 'utf8') === pristine,
        '心跳场景的扰动必须还原，否则后续 seal 与投影断言全部跑在被改过的 slices.json 上。');
    }
  }
}

// seal 的继承标记预检。
//
// 本轮实测：照 gov help 的 sealWhenToUse 三步做，重封存 REL-SCOPE/REL-E/REL-I
// 仍然失败——subject 里少了 scope-ruling:user-approved 与两条
// scope-deferral:<Gate>:V0.6:user-approved，而门禁按标记筛选参与 freshness 的证据，
// 筛完为空就报 GATE_EVIDENCE_STALE。那个诊断指向「主题域变了」，真实原因是
// 「标记漏了」，agent 会照错误方向反复重跑验证。预检必须在追加之前拦下，
// 且必须指名缺哪个标记——只报「失败」等于没修。
{
  const gatesDoc = JSON.parse(readFileSync(join(cliRoot, 'docs/governance/gates.json'), 'utf8'));
  const evidenceSubjects = new Map();
  for (const line of readFileSync(join(cliRoot, 'docs/governance/evidence.jsonl'), 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    evidenceSubjects.set(record.evidenceId, String(record.subject ?? ''));
  }

  // 从真实数据里找一个「其证据带 user-approved 标记」的 Gate，而不是硬编码
  // REL-SCOPE：标记归属会随治理演进变化，硬编码会在数据变动后测不到东西却仍全绿。
  const markerPattern = /\b[a-z-]+(?::[A-Za-z0-9.-]+)*:user-approved\b/g;
  let probeGate = null;
  let expectedMarkers = [];
  for (const gate of gatesDoc.gates) {
    const markers = new Set();
    for (const evidenceId of gate.evidenceRefs ?? []) {
      for (const marker of (evidenceSubjects.get(evidenceId) ?? '').match(markerPattern) ?? []) {
        markers.add(marker);
      }
    }
    if (markers.size > 0) {
      probeGate = gate.gateId;
      expectedMarkers = [...markers];
      break;
    }
  }

  check('cli/seal-marker-probe-gate-found', probeGate !== null,
    '治理数据里必须至少有一个 Gate 的证据带 user-approved 标记，否则本组断言测不到东西却会全绿。');

  if (probeGate !== null) {
    const withoutMarkers = runGov([
      'seal', '--gates', probeGate, '--id', 'EV-FIXTURE-NO-MARKER',
      '--subject', 'fixture：故意不带任何继承标记',
      '--commands', 'fixture', '--result', 'fixture', '--non-claims', 'fixture'
    ], cliRoot);
    check('cli/seal-missing-inherited-marker-rejected',
      withoutMarkers.status === 1
        && withoutMarkers.payload?.code === 'SEAL_INHERITED_MARKER_MISSING',
      `缺继承标记必须在追加前失败，实际 ${JSON.stringify(withoutMarkers.payload)?.slice(0, 240)}`);

    // 诊断必须指名缺哪个标记、由哪个 Gate 要求、在哪条证据里见过。
    // 只报「缺标记」不给名字，agent 仍然只能猜。
    const reported = (withoutMarkers.payload?.missingMarkers ?? []).map((entry) => entry.marker);
    check('cli/seal-missing-marker-names-each',
      expectedMarkers.every((marker) => reported.includes(marker)),
      `诊断必须逐个指名缺失标记，期望包含 ${JSON.stringify(expectedMarkers)}，实际 ${JSON.stringify(reported)}`);
    check('cli/seal-missing-marker-cites-source',
      (withoutMarkers.payload?.missingMarkers ?? []).every((entry) =>
        typeof entry.requiredByGate === 'string' && typeof entry.seenInEvidence === 'string'),
      '每个缺失标记必须给出要求它的 Gate 与见过它的证据 ID，否则 agent 无从复制原文。');

    // 预检不能挡住合法调用：不带 --gates 时无 Gate 可继承，必须跳过。
    const noGates = runGov([
      'seal', '--id', 'EV-FIXTURE-NO-GATES', '--subject', 'fixture：不挂 Gate',
      '--commands', 'fixture', '--result', 'fixture', '--non-claims', 'fixture'
    ], cliRoot);
    check('cli/seal-precheck-skipped-without-gates',
      noGates.payload?.code !== 'SEAL_INHERITED_MARKER_MISSING',
      `不带 --gates 时不应触发继承标记预检，实际 ${JSON.stringify(noGates.payload)?.slice(0, 200)}`);
  }
}

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
  //
  // 这段的两处扰动（slices.json 加后继切片 + gates.json 把它挂进 Gate）此前
  // 从不还原，且长期没被发现：真实数据的 claimable[0] 曾是 W-BEHAVIOR-MAP-01，
  // 它所属的 REL-D 只引用它自己，于是 isSoleLiveSlice=true 恒走上面的「诚实拒绝」
  // 分支，这段成功路径一次都没执行过。释放 5 条被遗弃 claim 后 claimable[0] 变成
  // W-EMEVD-FULL-01（REL-C 另有 active 切片，stranding 前提不成立），成功路径首次
  // 真正执行，两处未还原的扰动立刻显形：complete 把目标切片置 completed 后，
  // REL-C 仍是 open 却引用了终态切片 → GATE_OPEN_TERMINAL_SLICE 恒成立 →
  // 其后每条 seal 断言都跑在已违规数据上，seal 正向路径必然走回滚分支。
  // 实测 3 条断言同时红：complete-success-path / complete-drops-claim-on-success /
  // seal-success-path-reachable。故快照 → 断言 → 还原 → 锁定还原成功。
  const slicesPathForSuccess = join(cliRoot, 'docs/governance/slices.json');
  const gatesPathForSuccess = join(cliRoot, 'docs/governance/gates.json');
  const successRoot = JSON.parse(readFileSync(slicesPathForSuccess, 'utf8'));
  const successTarget = successRoot.slices.find((slice) => slice.lifecycle === 'active');
  if (successTarget) {
    // 必须重读 gates.json，不能复用上面第 538 行的 gatesData：那份是 complete
    // 调用之前的快照。当上面走的是 else（complete 合法成功）分支时，CLI 已按治理
    // 规则把 completed 切片从 open Gate 的 sliceRefs 摘除并落盘；拿陈旧内存副本
    // 覆写磁盘会把已摘除的引用又写回去，制造 open Gate 引用终态切片的违规数据。
    // 实测症状是本段自己的 complete 报 GOV_PRECHECK_FAILED / GATE_OPEN_TERMINAL_SLICE
    // ——诊断指向 W-EMEVD-FULL-01 已 completed，而那是上一段的合法结果，不是本段的错。
    const gatesForSuccess = JSON.parse(readFileSync(gatesPathForSuccess, 'utf8'));
    const gateWith = gatesForSuccess.gates.find((gate) =>
      gate.gateState === 'open' && (gate.sliceRefs ?? []).includes(successTarget.sliceId));
    if (gateWith) {
      const slicesSnapshot = readFileSync(slicesPathForSuccess, 'utf8');
      const gatesSnapshot = readFileSync(gatesPathForSuccess, 'utf8');
      const validationSnapshot = readFileSync(join(cliRoot, 'docs/governance/validation.json'), 'utf8');
      const successorId = `${successTarget.sliceId}-SUCCESSOR`;
      successRoot.slices.push({
        ...successTarget,
        sliceId: successorId,
        lifecycle: 'ready',
        declaresUnfrozenValidation: false,
        blockerRefs: []
      });
      writeFileSync(slicesPathForSuccess, `${JSON.stringify(successRoot, null, 2)}\n`, 'utf8');
      gateWith.sliceRefs = [...gateWith.sliceRefs, successorId];
      writeFileSync(gatesPathForSuccess, `${JSON.stringify(gatesForSuccess, null, 2)}\n`, 'utf8');

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

      // 还原三份被本段改动过的治理数据。gates.json 必须一并还原：complete 已把
      // 目标切片置 completed，若 Gate 仍挂着后继切片而切片表被单独还原，或反之，
      // 两份数据就会互相矛盾。validation.json 也可能被 complete 裁剪过。
      writeFileSync(slicesPathForSuccess, slicesSnapshot, 'utf8');
      writeFileSync(gatesPathForSuccess, gatesSnapshot, 'utf8');
      writeFileSync(join(cliRoot, 'docs/governance/validation.json'), validationSnapshot, 'utf8');
      // 锁定还原成功。只写回不断言等于把「还原是否真的生效」交给运气——本段
      // 恰恰是因为缺这条断言才让 3 条下游断言在错误数据上跑了未知多久。
      //
      // 判据必须是逐字节比对，不能用 runGov(['next']) 的 ok。实测过一版用 next
      // 判定的：注掉 gates.json 还原后该断言仍报 pass，因为 next 是只读命令、
      // 不跑治理校验，数据违规它照样返回 ok=true——判据形态与被检对象错位，
      // 是个假门禁。真正的失败在下游 seal 才显形，而那时诊断已指不回这里。
      const slicesRestored = readFileSync(slicesPathForSuccess, 'utf8') === slicesSnapshot;
      const gatesRestored = readFileSync(gatesPathForSuccess, 'utf8') === gatesSnapshot;
      const validationRestored =
        readFileSync(join(cliRoot, 'docs/governance/validation.json'), 'utf8') === validationSnapshot;
      check('cli/complete-success-fixture-state-restored',
        slicesRestored && gatesRestored && validationRestored,
        `complete 成功路径的扰动必须逐字节还原，否则其后 seal 断言全部跑在 GATE_OPEN_TERMINAL_SLICE 已成立的数据上。实际 slices=${slicesRestored} gates=${gatesRestored} validation=${validationRestored}`);
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

  // 必须恢复：这段刻意把 authority 改成超 cap，而它此前一直不还原。
  // 后果是后面每一条 seal 断言都跑在已违规的数据上——SEAL_POSTCHECK_FAILED
  // 恒成立，正向分支（含指纹自洽、投影、未提交提示共 7 条断言）一次都没执行过，
  // 而 seal-failures-append-nothing 之类的负向断言是因为「数据本来就红」才通过，
  // 不是因为 seal 真的守住了契约。实测：还原前 fixture 恒走回滚分支。
  slice.authority = 'candidate';
  writeFileSync(slicesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const restored = runGov(['next'], cliRoot);
  check('cli/rollback-fixture-state-restored',
    restored.status === 0 && restored.payload?.ok === true,
    `回滚场景的篡改必须还原，否则后续 seal 断言全部跑在已违规数据上。实际 ${JSON.stringify(restored.payload)?.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// gov seal
// ---------------------------------------------------------------------------

// 指纹实现一致性：gov/seal.mjs 复算五字段，generate-handoff-fingerprint.mjs 是
// 既有权威。两处若在某类改动下分叉，表现是「封存当时通过、下次门禁判无效」——
// 最难查的一类。这里在真实工作树上逐字段比对，任一侧漂移即失败关闭。
{
  const mine = computeFingerprint(root);
  const theirs = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'generate-handoff-fingerprint.mjs')],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180_000 }
  );
  let parsed = null;
  try {
    parsed = JSON.parse(theirs.stdout);
  } catch {
    parsed = null;
  }
  check('seal/fingerprint-reference-runnable',
    mine.ok === true && parsed !== null,
    `两处指纹实现都必须可运行，实际 seal.ok=${mine.ok} generate.status=${theirs.status}`);
  if (mine.ok === true && parsed !== null) {
    for (const field of [
      'head',
      'trackedDiffSha256',
      'untrackedManifestSha256',
      'handoffSha256BeforeEvidenceAppend'
    ]) {
      check(`seal/fingerprint-matches-${field}`, mine.fields[field] === parsed[field],
        `${field} 分叉：seal=${mine.fields[field]} generate=${parsed[field]}`);
    }
    check('seal/fingerprint-matches-digest', mine.fingerprintSha256 === parsed.fingerprintSha256,
      `fingerprintSha256 分叉：seal=${mine.fingerprintSha256} generate=${parsed.fingerprintSha256}`);
  }
}

// 负向：缺必填字段、ID 非法、ID 重复都必须失败关闭，且不追加任何行。
{
  const evidencePath = join(cliRoot, 'docs/governance/evidence.jsonl');
  const linesBefore = readFileSync(evidencePath, 'utf8').split('\n').length;

  const badId = runGov(['seal', '--id', 'not-an-ev-id', '--subject', 's',
    '--commands', 'c', '--result', 'r', '--non-claims', 'n'], cliRoot);
  check('cli/seal-rejects-bad-id',
    badId.status === 1 && badId.payload?.code === 'SEAL_ID_INVALID',
    `非法 EvidenceId 必须被拒，实际 ${JSON.stringify(badId.payload)?.slice(0, 300)}`);

  const missing = runGov(['seal', '--id', 'EV-FIXTURE-MISSING', '--subject', 's',
    '--commands', 'c', '--result', 'r'], cliRoot);
  check('cli/seal-requires-non-claims',
    missing.status === 1 && missing.payload?.code === 'SEAL_FIELD_REQUIRED',
    `缺 --non-claims 必须被拒（不声明项不能靠默认值编造），实际 ${JSON.stringify(missing.payload)?.slice(0, 300)}`);

  const existingId = JSON.parse(readFileSync(evidencePath, 'utf8').split('\n')
    .filter((line) => line.trim().length > 0)[0]).evidenceId;
  const duplicate = runGov(['seal', '--id', existingId, '--subject', 's',
    '--commands', 'c', '--result', 'r', '--non-claims', 'n'], cliRoot);
  check('cli/seal-rejects-duplicate-id',
    duplicate.status === 1 && duplicate.payload?.code === 'SEAL_ID_DUPLICATE',
    `重复 EvidenceId 必须被拒（封存只追加不覆盖），实际 ${JSON.stringify(duplicate.payload)?.slice(0, 300)}`);

  // 不存在的 Gate 必须失败关闭并连带回滚已追加的证据行。若只回滚 gates.json，
  // evidence.jsonl 会留下一条没被任何 Gate 引用的孤立封存记录。
  const gatesPath = join(cliRoot, 'docs/governance/gates.json');
  const gatesBefore = readFileSync(gatesPath, 'utf8');
  const badGate = runGov(['seal', '--id', 'EV-FIXTURE-BAD-GATE', '--subject', 's',
    '--commands', 'c', '--result', 'r', '--non-claims', 'n',
    '--gates', 'REL-DOES-NOT-EXIST'], cliRoot);
  check('cli/seal-rejects-undefined-gate',
    badGate.status === 1 && badGate.payload?.code === 'SEAL_GATE_UNDEFINED',
    `未定义 Gate 必须被拒，实际 ${JSON.stringify(badGate.payload)?.slice(0, 300)}`);
  check('cli/seal-bad-gate-rolls-back-gates',
    readFileSync(gatesPath, 'utf8') === gatesBefore,
    'Gate 挂载失败时 gates.json 必须保持原样。');

  check('cli/seal-failures-append-nothing',
    readFileSync(evidencePath, 'utf8').split('\n').length === linesBefore,
    '任何 seal 失败路径都不得留下半条记录。');
}

// 正向：追加成功后指纹必须自洽（parseSealBaseline 判 valid），且能被门禁解析。
{
  const sealed = runGov(['seal', '--id', 'EV-FIXTURE-SEAL-OK',
    '--subject', 'fixture 封存：验证 gov seal 正向路径',
    '--commands', 'fixture 内不运行真实验证命令',
    '--result', 'fixture 只检查指纹自洽与门禁可解析',
    '--non-claims', '不提升任何 authority，不构成真实验证证据'], cliRoot);
  // 临时仓库的门禁状态可能因 freshness 而红（HEAD 只有一个 fixture 基线提交），
  // 那种失败是环境性的、且必须回滚——两种结局都要断言，不能只看成功。
  if (sealed.status === 0) {
    const record = readFileSync(join(cliRoot, 'docs/governance/evidence.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.evidenceId === 'EV-FIXTURE-SEAL-OK');
    check('cli/seal-appends-record', record !== undefined, 'seal 成功后必须能读回该记录。');
    const parsedSeal = record ? parseSealBaseline(record.fingerprint) : null;
    check('cli/seal-baseline-self-consistent',
      parsedSeal?.formatValid === true && parsedSeal?.fingerprintValid === true,
      `封存基线必须自洽（五字段齐全且 fingerprintSha256 匹配），实际 ${JSON.stringify(parsedSeal)?.slice(0, 400)}`);
    check('cli/seal-type-is-sealed', record?.evidenceType === 'sealed-current-run',
      'gov seal 只产出 sealed-current-run。');
    // 交接书 §17.1 是治理 JSON 的投影。seal 必须顺带重新投影，否则 markdown
    // 少一行、handoff 门禁判 stale——而消除 stale 正是封存的目的。
    // 这条断言锁定「封存即完成投影」，不允许退回「记得手跑生成器」。
    check('cli/seal-reprojects-handoff',
      readFileSync(join(cliRoot, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'), 'utf8')
        .includes('EV-FIXTURE-SEAL-OK'),
      'seal 成功后交接书投影区必须已包含新证据行。');

    // seal 写文件但不提交，而下一次封存的指纹锚点是 HEAD。真实仓库上漏过一次：
    // seal 写了 evidence.jsonl 与 gates.json，随后的提交只带了交接书散文，两个
    // JSON 悬在工作区——而当时的 seal 输出只有「governanceGate: passed」，
    // 看不出还有未落库的事实源。这三条锁定「封存后必须报出未提交文件」。
    const uncommitted = sealed.payload?.uncommittedAfterSeal;
    check('cli/seal-reports-uncommitted-list', Array.isArray(uncommitted),
      `seal 成功输出必须带 uncommittedAfterSeal 数组，实际 ${JSON.stringify(uncommitted)?.slice(0, 200)}`);
    if (Array.isArray(uncommitted)) {
      check('cli/seal-uncommitted-includes-evidence',
        uncommitted.some((path) => path.includes('evidence.jsonl')),
        `seal 刚写过 evidence.jsonl 且未提交，它必须出现在 uncommittedAfterSeal 中，实际 ${JSON.stringify(uncommitted)}`);
      check('cli/seal-nextstep-demands-commit',
        typeof sealed.payload?.nextStep === 'string'
          && sealed.payload.nextStep.includes('提交')
          && sealed.payload.nextStep.includes('HEAD'),
        `有未提交文件时 nextStep 必须要求提交并说明锚点是 HEAD，实际 ${sealed.payload?.nextStep}`);
      // 报出的路径必须真实存在。第一版用 text() 读 porcelain，trim 吃掉了
      // 未暂存状态码 " M" 的前导空格，按固定 3 字符切片就多切一位，输出成
      // "ocs/V0_5_IMPLEMENTATION_HANDOFF.md"——看起来像对的但文件不存在。
      // 路径错了的诊断比不报更容易误导，故断言逐个可解析到真实文件。
      check('cli/seal-uncommitted-paths-resolve',
        uncommitted.length > 0 && uncommitted.every((path) => existsSync(join(cliRoot, path))),
        `uncommittedAfterSeal 的每个路径都必须在仓库中真实存在，实际 ${JSON.stringify(uncommitted)}`);
    }
  } else {
    check('cli/seal-success-path-reachable', false,
      `正向封存必须可达（fixture 已把锚点改写到基线提交），实际 ${JSON.stringify(sealed.payload)?.slice(0, 500)}`);
  }
}

// 后置校验失败必须整体回滚。
//
// 这段此前和正向断言共用一个 if/else：临时仓库恒走 else，正向 7 条断言从未执行；
// 修好锚点后恒走 if，这 4 条负向断言反而成了死码。两个分支互斥，靠环境碰巧走哪边
// 来「覆盖两种结局」是假覆盖。所以失败场景必须显式构造。
//
// 构造方式：先把交接书里一个 PROJECTION 标记块的主题域改掉并提交，让某个 passed
// Gate 真的 stale，然后不带 --gates 封存——freshness 只判定 Gate 引用的
// evidenceRefs，孤立新证据不参与判定，stale 必然消不掉。
{
  const handoffPath = join(cliRoot, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md');
  const evidencePath = join(cliRoot, 'docs/governance/evidence.jsonl');
  const scopePath = join(cliRoot, 'docs/governance/scope.json');
  const scopeBefore = existsSync(scopePath) ? readFileSync(scopePath, 'utf8') : null;

  if (scopeBefore !== null) {
    // scope.json 是 release-scope-proposal 块的事实源，也在 Gate 主题域里。
    // 改它并提交 → 该 Gate 的封存锚点之后主题域有变 → stale。
    //
    // 必须改 schema 允许的既有字段。第一版加了个 fixtureStalenessProbe 新字段，
    // 结果 seal 确实失败了，但 errors 是 GOVERNANCE_SCHEMA_VIOLATION 而不是
    // stale——断言为错误原因通过，正是本轮要消灭的那类假门禁。下面断言里额外
    // 核对 errors 不含 SCHEMA_VIOLATION，锁住这一点。
    const scopeDoc = JSON.parse(scopeBefore);
    scopeDoc.note = `${scopeDoc.note} [fixture 扰动：制造主题域变化以触发 stale，不构成范围裁定]`;
    writeFileSync(scopePath, `${JSON.stringify(scopeDoc, null, 2)}\n`, 'utf8');
    runGit(['add', 'docs/governance/scope.json'], cliRoot);
    runGit(['commit', '--quiet', '-m', 'fixture: perturb subject domain to force stale'], cliRoot);

    const evidenceBefore = readFileSync(evidencePath, 'utf8');
    const handoffBefore = readFileSync(handoffPath, 'utf8');
    const failed = runGov(['seal', '--id', 'EV-FIXTURE-SEAL-STALE',
      '--subject', 'fixture 封存：验证后置校验失败必须整体回滚',
      '--commands', 'fixture 内不运行真实验证命令',
      '--result', 'fixture 只检查回滚完整性',
      '--non-claims', '不提升任何 authority'], cliRoot);

    check('cli/seal-postcheck-rolls-back',
      failed.status === 1
        && (failed.payload?.code === 'SEAL_POSTCHECK_FAILED'
          || failed.payload?.code === 'SEAL_PROJECTION_FAILED'),
      `主题域变化且未指定 --gates 时封存必须失败，实际 ${JSON.stringify(failed.payload)?.slice(0, 400)}`);
    // 失败必须因为 stale，而不是因为扰动本身把数据改成了非法。
    // 后者会让上一条断言为错误原因通过——那是假门禁。
    const failCodes = (failed.payload?.errors ?? []).map((entry) => entry.code);
    check('cli/seal-postcheck-fails-for-staleness',
      failCodes.length > 0
        && failCodes.every((code) => code !== 'GOVERNANCE_SCHEMA_VIOLATION')
        && failCodes.some((code) => code.includes('STALE') || code.includes('FRESHNESS')),
      `失败原因必须是 freshness/stale，不能是扰动导致的数据非法，实际 ${JSON.stringify(failCodes)}`);
    check('cli/seal-rollback-removes-record',
      readFileSync(evidencePath, 'utf8') === evidenceBefore,
      '后置校验失败必须逐字节还原 evidence.jsonl，不得留下一条无效封存。');
    // 交接书也必须回滚。留下一份含该证据的投影而 JSONL 里没有，
    // 会让下次 --check 永久报漂移，且漂移方向指向一条不存在的记录。
    check('cli/seal-rollback-restores-handoff',
      readFileSync(handoffPath, 'utf8') === handoffBefore,
      '回滚必须同时逐字节还原交接书投影。');
    // hint 必须指出 --gates 缺失这个可能。真实仓库上首次重封存正是因为漏了
    // --gates 而 stale 未消除：freshness 只判定 Gate 引用的 evidenceRefs，
    // 孤立的新证据根本不参与判定。hint 若不提这一点，下一个 agent 会照着
    // 「主题域没提交」这个错误方向查。
    check('cli/seal-rollback-hint-mentions-gates',
      typeof failed.payload?.hint === 'string' && failed.payload.hint.includes('--gates'),
      `未指定 --gates 时回滚 hint 必须提示该参数，实际 hint=${failed.payload?.hint}`);

    // 还原扰动，避免污染后续断言（这正是上面 rollbackTarget 犯过的错）。
    writeFileSync(scopePath, scopeBefore, 'utf8');
    runGit(['add', 'docs/governance/scope.json'], cliRoot);
    runGit(['commit', '--quiet', '-m', 'fixture: restore subject domain'], cliRoot);
  } else {
    check('cli/seal-stale-probe-scope-present', false,
      'fixture 仓库缺少 docs/governance/scope.json，无法构造主题域变化场景。');
  }
}

// --gates 会把新证据挂到 Gate 的 evidenceRefs 上（只追加，不删历史引用——
// 历史证据是审计链）。这里不依赖 seal 整体成功：临时仓库的 freshness 恒不可判定，
// 所以直接断言「回滚后 gates.json 与原样逐字节相同」，证明挂载与回滚成对。
{
  const gatesPath = join(cliRoot, 'docs/governance/gates.json');
  const before = readFileSync(gatesPath, 'utf8');
  const gateId = JSON.parse(before).gates[0].gateId;
  runGov(['seal', '--id', 'EV-FIXTURE-GATE-ATTACH', '--subject', 's',
    '--commands', 'c', '--result', 'r', '--non-claims', 'n',
    '--gates', gateId], cliRoot);
  check('cli/seal-gate-attach-rolls-back-cleanly',
    readFileSync(gatesPath, 'utf8') === before,
    'seal 回滚后 gates.json 必须逐字节还原，否则会留下指向已回滚证据的悬空引用。');
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
    '治理数据已违规时拒绝叠加改动且不写入',
    'gov/seal.mjs 与 generate-handoff-fingerprint.mjs 五字段指纹逐字段一致',
    'seal 拒绝非法/重复 EvidenceId、未定义 Gate 与缺失必填字段，且失败路径不追加任何行',
    'seal 成功时封存基线自洽；后置校验失败时同时回滚 evidence.jsonl 与 gates.json',
    'seal 回滚 hint 指出 --gates 缺失（freshness 只判定 Gate 引用的证据）',
    'seal 成功即完成交接书投影；失败时连交接书一并回滚',
    '--release 默认取 releases.json 的 currentRelease；未登记或形状非法的版本硬失败',
    'seal 在追加前预检 subject 是否带齐目标 Gate 的 user-approved 继承标记，缺失时逐个指名（否则会报成指向错误原因的 GATE_EVIDENCE_STALE）',
    'next 的输出自带完整闭环：每条切片有 entryPoints/requiredValidation/hardPrerequisites，另附 claim→验证→封存→complete 的流程骨架',
    'seal 成功后报出自己写过但仍未提交的治理文件，并说明下次封存锚点是 HEAD（漏提交会让事实源与已入库的投影错位）',
    'seal 的正向与回滚路径各自显式构造、互不依赖环境：锚点改写到 fixture 基线使正向可达，扰动 scope.json 主题域使 stale 可达',
    '回滚场景断言失败原因确实是 freshness/stale 而非扰动导致的数据非法（否则断言为错误原因通过）',
    'fixture 对治理数据的每处扰动都在断言后还原，不污染后续断言',
    'complete 成功路径的扰动覆盖 slices/gates/validation 三份并锁定还原成功（只还原切片表而漏 gates.json 会留下 open Gate 引用终态切片，使其后每条 seal 断言跑在 GATE_OPEN_TERMINAL_SLICE 已成立的数据上）',
    'deferred 切片的 resumeRequires 直接投影（不让 agent 手工按 capabilityId 反查 scope.json）；取不到时必须给 reason 而非空数组；无 deferred 时不投影以免膨胀默认首屏',
    'next 暴露在飞 claim 的心跳新鲜度：超 24 小时报 heartbeatStale 并给出「先核实、再 release 或 complete」的出路，且声明 CLI 不自动释放（否则被遗弃的 claim 与有主 claim 在输出里无从区分，接手者会全部避开）',
    '心跳新鲜时不得报陈旧也不塞 recoveryHint；心跳不可解析时判为未知而非陈旧（误报会诱导接手者 release 掉别人正在写的切片）'
  ],
  findings
}, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;

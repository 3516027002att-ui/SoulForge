#!/usr/bin/env node
/**
 * 治理执行 CLI：agent 推进切片时的唯一读写入口。
 *
 * 为什么要它，而不是让 agent 直接编辑 slices.json：
 * 1. 并发。多个 agent 是独立进程，各自「读—改—写」会静默互相覆盖，两个
 *    agent 会同时认为自己独占了同一个切片。claim 必须在跨进程锁下完成。
 * 2. 一致性。手改 JSON 极易漏掉配套字段（claim 与 lifecycle=active 必须
 *    一一对应），门禁能报错但那是事后发现，返工成本已经付出。
 * 3. 可判定的下一步。`gov next` 让 agent 不必读 3500 行交接书就能知道
 *    「现在能做什么、被什么挡住」。
 *
 * 硬边界：本 CLI 只写 docs/governance/*.json 与 evidence.jsonl。它不写
 * Mod 工作区、不写游戏目录、不改 authority、不产出 Evidence 结论——claim
 * 只是并发协调，不构成任何验证声明。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireGovernanceLock } from './gov/lock.mjs';
import {
  EVIDENCE,
  collectUncommittedGovernanceFiles,
  computeFingerprint,
  formatBaseline
} from './gov/seal.mjs';
import { projectHandoff } from './generate-handoff-projection.mjs';
import { validateGovernanceData } from './governance/validateGovernanceData.mjs';
import {
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef,
  parseSealBaseline
} from './handoff-integrity-lib.mjs';

const root = process.cwd();
const SLICES = 'docs/governance/slices.json';
const VALIDATION = 'docs/governance/validation.json';
const GATES = 'docs/governance/gates.json';
const RELEASES = 'docs/governance/releases.json';
const SCOPE = 'docs/governance/scope.json';

/**
 * 写外壳会快照并在失败时恢复的文件集合。
 * 必须覆盖所有可能被改动的文件——漏一个就会在回滚后留下半个改动。
 *
 * gates.json 在列表内是因为 complete 必须把终态切片从 open Gate 的 sliceRefs
 * 中摘除（治理规则不允许 open Gate 引用终态切片）。本 CLI 不改 gateState 与
 * applicability：那是要封存证据支撑的裁定，不是状态搬运。
 */
const MUTABLE_FILES = Object.freeze([SLICES, VALIDATION, GATES]);

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, code, message, ...extra }, null, 2));
  process.exitCode = 1;
}

function emit(payload) {
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function readSlices() {
  return readJson(SLICES);
}

/**
 * 解析显式传入的 --release。
 *
 * 开发命令不绑定发布里程碑：省略 --release 返回 release=null，由调用方展示全部
 * 可开发切片或写入未绑定发布的开发 Evidence。只有显式传入 --release 时，才校验
 * 它是否已在发布注册表登记。这样发布版本仍可审计，但不会反过来限制开发选点。
 *
 * 同时校验版本必须在 releases.json 里真实存在。原先只校验 /^V\d+\.\d+$/ 形状，
 * 所以 `--release V9.9` 能通过，会封存出一条挂在不存在版本上的证据；而 cmdNext
 * 的 --release 连形状都不校验，拼错只会静默返回空的 claimable 列表——agent 会把
 * 「参数拼错」读成「没有可推进切片」。
 *
 * @param {unknown} raw 命令行传入的 --release 原值
 * @returns {{ok: true, release: string|null, isDefault: boolean, known: string[]} | {ok: false, code: string, message: string, known: string[]}}
 */
function resolveRelease(raw) {
  const data = readJson(RELEASES);
  const known = data.releases.map((entry) => entry.release);
  const provided = typeof raw === 'string' ? raw.trim() : '';
  if (provided.length === 0) {
    return { ok: true, release: null, isDefault: true, known };
  }
  const release = provided;

  if (typeof release !== 'string' || !/^V\d+\.\d+$/.test(release)) {
    return {
      ok: false,
      code: 'RELEASE_SHAPE_INVALID',
      message: `--release 必须形如 V<major>.<minor>，收到 ${JSON.stringify(release)}。`,
      known
    };
  }
  if (!known.includes(release)) {
    return {
      ok: false,
      code: 'RELEASE_UNKNOWN',
      message: `${release} 不在 ${RELEASES} 的 releases 列表里；新版本要先在治理数据里登记。`,
      known
    };
  }
  return { ok: true, release, isDefault: provided.length === 0 };
}

/**
 * 写回治理 JSON。保留 2 空格缩进与末尾换行，使 diff 只包含语义改动——
 * 格式漂移会让 trackedDiffSha256 指纹和冻结比对产生噪声。
 */
function writeJson(relativePath, data) {
  writeFileSync(join(root, relativePath), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * 跑一次完整治理校验。任何写操作前后都必须过这道校验：
 * 写前防止在已损坏的数据上叠加改动，写后防止本次改动引入不一致。
 */
function runGovernanceCheck({ withFreshness = false } = {}) {
  const registry = gateSubjectRegistry();
  const subjectRefsByGate = new Map(registry.gates.map((gate) => [
    gate.gateId,
    [
      ...gate.files,
      ...gate.handoffSections.map(handoffSectionSubjectRef),
      ...gate.handoffBlocks.map((block) => handoffBlockSubjectRef(block.id))
    ]
  ]));
  // claim/complete 默认不传 handoffMarkdown：它们只改执行面板、不触碰 Evidence，
  // freshness 判定与之无关，少读一个 3500 行文件也让 CLI 更快。
  //
  // seal 必须传：封存的全部目的就是把 stale 证据恢复为 fresh，跳过 freshness
  // 判定等于跳过唯一能证明本次封存有效的检查。
  const result = validateGovernanceData(root, {
    parseSealBaseline,
    subjectRefsOf: (gateId) => subjectRefsByGate.get(gateId) ?? null,
    freezeBaselineRef: 'HEAD',
    handoffMarkdown: withFreshness
      ? readFileSync(join(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'), 'utf8')
      : null
  });
  return {
    ok: result.ok,
    errors: result.findings.filter((finding) => finding.severity === 'error')
  };
}

/**
 * 写操作的统一外壳：加锁 → 前置校验 → 变更 → 后置校验 → 失败回滚。
 *
 * 回滚是必需的：后置校验失败若仍留下写入，仓库就停在门禁红的状态，
 * 下一个 agent 会被一个不是自己造成的失败挡住。
 */
function withGovernanceWrite(owner, mutate) {
  const lock = acquireGovernanceLock(root, owner);
  if (!lock.ok) {
    fail(lock.code, lock.message, { holder: lock.holder });
    return;
  }
  try {
    const before = runGovernanceCheck();
    if (!before.ok) {
      fail('GOV_PRECHECK_FAILED', '治理数据在改动前已不满足门禁；先修复再操作。', {
        errors: before.errors.slice(0, 10)
      });
      return;
    }

    const snapshot = new Map(
      MUTABLE_FILES.map((relativePath) => [relativePath, readFileSync(join(root, relativePath), 'utf8')])
    );
    const documents = {
      slices: JSON.parse(snapshot.get(SLICES)),
      validation: JSON.parse(snapshot.get(VALIDATION)),
      gates: JSON.parse(snapshot.get(GATES))
    };
    const outcome = mutate(documents);
    if (outcome.ok === false) {
      fail(outcome.code, outcome.message, outcome.extra ?? {});
      return;
    }
    writeJson(SLICES, documents.slices);
    writeJson(VALIDATION, documents.validation);
    writeJson(GATES, documents.gates);

    const after = runGovernanceCheck();
    if (!after.ok) {
      for (const [relativePath, content] of snapshot) {
        writeFileSync(join(root, relativePath), content, 'utf8');
      }
      fail('GOV_POSTCHECK_FAILED', '改动会使治理门禁失败，已回滚全部治理写入。', {
        rolledBack: [...snapshot.keys()],
        errors: after.errors.slice(0, 10)
      });
      return;
    }
    emit(outcome.payload);
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 没有可 claim 切片时，按当前筛选视图的实际 lifecycle 分布给出正确出路。
 *
 * 原先无论什么原因都回同一句「先完成或释放在飞切片，或按 blockers.json 解阻塞」。
 * 实测某个发布筛选视图曾撞上死路：其中的切片全是 lifecycle=deferred，
 * blockerRefs 全为空数组，agent 按指引去查 blockers.json 什么都查不到，而 deferred
 * 也不是靠释放 claim 或解阻塞能变 ready 的——真正的出路是 scope.json 里那条
 * scopeItem 的 resumeRequires。给错出路比不给更糟：agent 会沿着错误方向反复尝试。
 */
/**
 * 投影一条 deferred 切片的承接条件。
 *
 * 关联键取 capabilityId：实测三条 deferred 切片按 capabilityId 全部有解，而按
 * gates 的 sliceRefs 反查对 W-MSB-SCENE-01 为空（没有 Gate 引用它）。切片本身
 * 也没有 scopeItemIds 字段，所以 capabilityId 是唯一稳定的关联。
 *
 * 只投影，不复述也不改写：承接条件的权威在 scope.json，CLI 里写第二份表述会与
 * 事实源分叉，而分叉的表现是「按 CLI 做完了但门禁仍不放行」。
 */
function collectResumeRequires(slice) {
  let scopeDoc;
  try {
    scopeDoc = JSON.parse(readFileSync(join(root, SCOPE), 'utf8'));
  } catch {
    // 读不到就明说读不到，不静默返回空数组——空数组会被读成「没有承接条件」。
    return { available: false, reason: `无法读取 ${SCOPE}` };
  }
  const caps = new Set(slice.capabilityIds ?? []);
  const items = (scopeDoc.scopeItems ?? []).filter((item) =>
    caps.has(item.capabilityId) && item.deferredToRelease === slice.targetRelease);
  if (items.length === 0) {
    return {
      available: false,
      reason: `${SCOPE} 中没有 capabilityId ∈ ${[...caps].join('/')} 且 deferredToRelease=${slice.targetRelease} 的 scopeItem；`
        + '切片标为 deferred 但缺对应范围条目，属于治理数据不一致'
    };
  }
  return {
    available: true,
    fromScopeItems: items.map((item) => ({
      scopeItemId: item.scopeItemId,
      deferredTrack: item.deferredTrack ?? null,
      resumeRequires: item.resumeRequires
    }))
  };
}

function emptyCandidateMessage(slicesInRelease, release) {
  const counts = new Map();
  for (const slice of slicesInRelease) {
    counts.set(slice.lifecycle, (counts.get(slice.lifecycle) ?? 0) + 1);
  }
  const scope = release === null ? '全部开发视图' : `发布归属 ${release}`;

  if (slicesInRelease.length === 0) {
    return `${scope} 下没有任何切片；发布归属只用于筛选，开发切片应先登记到 slices.json。`;
  }

  const parts = [];
  const deferred = counts.get('deferred') ?? 0;
  const active = counts.get('active') ?? 0;
  const blocked = counts.get('blocked') ?? 0;

  if (deferred > 0) {
    parts.push(`${deferred} 条为 lifecycle=deferred——解法不是解阻塞或释放 claim，`
      + '而是先满足 docs/governance/scope.json 里对应 scopeItem 的 resumeRequires，'
      + '再由用户裁定解除延期');
  }
  if (active > 0) parts.push(`${active} 条在飞（gov release 释放，或 gov complete 收尾）`);
  if (blocked > 0) parts.push(`${blocked} 条被阻塞（按 blockers.json 的 blockerRefs 解阻塞）`);

  const others = [...counts.entries()]
    .filter(([lifecycle]) => !['deferred', 'active', 'blocked', 'ready'].includes(lifecycle))
    .map(([lifecycle, count]) => `${count} 条 ${lifecycle}`);
  if (others.length > 0) parts.push(others.join('、'));

  return `${scope} 下没有 lifecycle=ready 的切片：${parts.join('；')}。`;
}

/**
 * claim 心跳被视为陈旧的小时数。
 *
 * 取 24 小时而不是更短：一条切片的实现加验证经常跨越多轮上下文，几小时不刷心跳
 * 是正常的。取值偏大只会延后提示，取值偏小会把正在推进的 claim 误报成遗弃，
 * 而误报会诱导接手者 release 掉别人正在写的切片。
 */
const STALE_CLAIM_HOURS = 24;

/**
 * 返回 claim 心跳距今的小时数；claim 缺失或心跳字段不可解析时返回 null。
 *
 * 不把不可解析当成「陈旧」：那会让一个格式问题伪装成协作问题，接手者照着提示去
 * release 一条其实有人在跑的切片。判不出来就不下结论。
 */
function claimStaleHours(claim) {
  if (!claim || typeof claim.heartbeatAt !== 'string') return null;
  const beat = Date.parse(claim.heartbeatAt);
  if (Number.isNaN(beat)) return null;
  return Math.max(0, Math.floor((Date.now() - beat) / 3600000));
}

/**
 * 列出可推进的切片。判定依据只有治理数据，不含任何人工优先级——
 * 优先级一旦写进 CLI 就成了第二份权威，会与 slices.json 漂移。
 */
function cmdNext(args) {
  const data = readSlices();
  const claimedIds = new Set(data.activeClaims.map((claim) => claim.sliceId));

  // 开发视图默认跨越所有发布归属；--all 只是保留的显式同义写法。
  // 发布筛选必须由调用方显式传入 --release，避免历史里程碑意外变成开发门槛。
  const wantsAll = args.all === true || args.release === 'all' || args.release === undefined;
  let release = null;
  if (!wantsAll) {
    const resolved = resolveRelease(args.release);
    if (!resolved.ok) {
      fail(resolved.code, resolved.message, { knownReleases: resolved.known });
      return;
    }
    release = resolved.release;
  }

  // 三个列表必须用同一个发布归属判据。默认开发视图不筛选，显式 --release 才筛选。
  const inRelease = (slice) => !release || slice.targetRelease === release;

  const candidates = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'ready');
  const inFlight = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'active');
  const blocked = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'blocked');
  const deferred = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'deferred');

  emit({
    mode: 'next',
    release,
    claimable: candidates.map((slice) => ({
      ...(release === null ? {} : { targetRelease: slice.targetRelease }),
      sliceId: slice.sliceId,
      capabilityIds: slice.capabilityIds,
      authority: slice.authority,
      authorityCap: slice.authorityCap,
      goal: slice.goal,
      hardPrerequisites: slice.hardPrerequisites,
      entryPoints: slice.entryPoints,
      requiredValidation: slice.requiredValidation,
      // 已完成证据刻意不投影到选点输出：它是留痕，不是指令。原先 goal 里混着两
      // 者，实测让可推进切片的 goal 平均膨胀到 921 字、待做陈述被埋在末尾。
      // 需要读历史证据时直接查 slices.json 的 evidence 字段。
      hasEvidenceRecord: typeof slice.evidence === 'string' && slice.evidence.length > 0,
      alreadyClaimed: claimedIds.has(slice.sliceId)
    })),
    // 在飞切片必须暴露心跳新鲜度，否则「有主」和「被遗弃」长得一模一样。
    //
    // 实测：5 条 owner=coordinator-agent 的 claim 心跳停在 2026-08-01，此后 24 个
    // 提交全在治理层、没有一个碰过这些切片的 entryPoints，8/1–8/2 封存的 22 条证据
    // 也全是 EV-REL-SCOPE-*。它们是被中断的半成品，但 next 只报 sliceId/owner，
    // 新接手的 agent 读成「有人在做」而全部避开——于是剩余的可 claim 面被
    // 无声压到 4 条，谁都不知道那 5 条其实无人推进。
    //
    // 判据是心跳超过 STALE_CLAIM_HOURS 小时。不自动释放：claim 的语义是并发占用，
    // CLI 擅自释放可能撞上另一个真在跑的进程，而那比空转更难恢复。只给出可执行的
    // 下一步，由接手者按 recoveryTrigger 核实后决定 release 还是 complete。
    activeSlices: inFlight.map((slice) => {
      const claim = data.activeClaims.find((item) => item.sliceId === slice.sliceId) ?? null;
      const staleHours = claimStaleHours(claim);
      return {
        sliceId: slice.sliceId,
        owner: claim?.owner ?? null,
        claimId: claim?.claimId ?? null,
        heartbeatAt: claim?.heartbeatAt ?? null,
        heartbeatStale: staleHours !== null && staleHours >= STALE_CLAIM_HOURS,
        staleFor: staleHours === null ? null : `${staleHours} 小时`,
        // 心跳新鲜时不塞提示，避免每条都带一段无关文本。
        recoveryHint: staleHours !== null && staleHours >= STALE_CLAIM_HOURS
          ? `心跳已停 ${staleHours} 小时（>= ${STALE_CLAIM_HOURS}），该 claim 可能已被遗弃。`
            + `先按 recoveryTrigger 核实：${claim?.recoveryTrigger ?? '（未登记）'}。`
            + `确认无人推进则 gov release --slice ${slice.sliceId} --owner ${claim?.owner ?? '<owner>'}`
            + '，让它回到可 claim；确认已做完则走封存四步后 gov complete。'
            + '本命令不自动释放——擅自释放可能撞上另一个真在跑的进程。'
          : null
      };
    }),
    blockedSlices: blocked.map((slice) => ({
      sliceId: slice.sliceId,
      blockerRefs: slice.blockerRefs
    })),
    // deferred 切片的承接条件直接投影出来，不让 agent 去手工翻 scope.json。
    //
    // message 已经指对了方向（去满足 resumeRequires 而不是解阻塞），但只说「去
    // scope.json 找」仍然是把 agent 送去手工检索；靠 capabilityId 反查是每次都要
    // 重做一遍的活。
    // 这与本轮修的其他诊断问题同源——方向对但不到位，收敛还是慢。
    deferredSlices: deferred.map((slice) => ({
      sliceId: slice.sliceId,
      ...(release === null ? {} : { targetRelease: slice.targetRelease }),
      goal: slice.goal,
      // 承接条件的权威在 scope.json；这里只投影，不复述也不改写。
      resumeRequires: collectResumeRequires(slice)
    })),
    message: candidates.length === 0
      ? emptyCandidateMessage(data.slices.filter(inRelease), release)
      : `${candidates.length} 条切片可 claim；claim 前请先读 entryPoints 与 requiredValidation。`,
    note: 'claim 只是并发协调，不构成 Evidence，也不提升 authority。',
    // 选点输出必须自带完整闭环，否则 agent 拿到切片后仍要回交接书里找「做完之后
    // 干什么」。实测 next 的输出对「改哪些文件、跑哪条验证」已经自足
    // （entryPoints + requiredValidation），断点在最后一环：claim 之后到封存之间
    // 没有任何指引，而封存漏一步就会撞上指向错误原因的 GATE_EVIDENCE_STALE。
    //
    // 这里只写与具体切片无关的流程骨架；每步的参数细节由 gov help 承担，
    // 不在两处重复陈述同一套规则。
    workflow: [
      '1. gov claim --slice <sliceId> --owner <你> —— 原子占用，避免并发撞车',
      '2. 读该切片的 entryPoints，按 hardPrerequisites 划定不可越界的范围',
      '3. 实现改动；写能力必须经 Patch Engine，writer 只写暂存区',
      '4. 跑该切片的 requiredValidation，外加 npm run typecheck / npm test',
      '5. 改了治理主题域文件就先提交，再 gov seal（开发 Evidence 可不绑定发布；四步流程见 gov help 的 sealWhenToUse）',
      '6. gov complete --slice <sliceId> —— 只改执行面板状态，不提升 authority',
      'authority 提升必须另有真实运行的验证支撑，不能由 claim/complete 推导。'
    ]
  });
}

/**
 * 统计工作区未提交改动数（无路径过滤）。
 *
 * T-M2：本仓库多次用 `git status --porcelain -- <少数路径>` 确认「干净」，而过滤后
 * 的输出看起来跟真干净一模一样——工作区其实悬着上个会话遗留的未提交改动。seal 侧的
 * collectUncommittedGovernanceFiles 只扫治理文件；status 这里补的是**全量无过滤**计数，
 * 把真事实印在 CLAUDE.md 列的权威面板上：agent 即使另行跑了带 `--` 过滤的 git status，
 * 也会在面板里被这个计数 contradict。
 *
 * 失败关闭：git 不可用返回 null 而非 0。0 是「干净」，是最乐观的断言；拿不确定冒充它，
 * 正是本文件 cmdStatus 注释里那类「默认值比事实更乐观」的假绿。
 */
function countUncommitted(rootDir) {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  if (status.status !== 0 || status.error) {
    return {
      uncommittedFiles: null,
      unfiltered: true,
      note: 'git status 不可用，无法确定工作区是否干净；失败关闭报 null，不报 0。'
    };
  }
  const count = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  return { uncommittedFiles: count, unfiltered: true, note: null };
}

function cmdStatus() {
  const data = readSlices();
  const counts = {};
  for (const slice of data.slices) {
    counts[slice.lifecycle] = (counts[slice.lifecycle] ?? 0) + 1;
  }
  // status 必须带 freshness。它此前调用不带参数的 runGovernanceCheck(),于是跳过
  // GATE_EVIDENCE_STALE / GATE_DEFERRAL_EVIDENCE_STALE 判定——实测状态:治理层
  // (verify --tier governance) 因这三条红着,而 status 同时报 governanceGateOk: true。
  //
  // 这是本仓库最坏的一类假门禁:CLAUDE.md 把 status 列为「治理门禁是否通过」的常用
  // 入口,读到 true 的 agent 会直接去提交,红是在之后某一步才炸出来,而那时它已经在
  // 找错方向了。宁可让 status 慢一点(多读一个交接书)也不能给假绿。
  const check = runGovernanceCheck({ withFreshness: true });
  emit({
    // emit 恒发 ok: true;payload 在其后展开,故这里显式覆盖。见函数末尾 exitCode 注释。
    ok: check.ok,
    mode: 'status',
    // 无过滤的工作区未提交计数。不参与 exitCode（有未提交改动本身不是治理失败），
    // 只把真事实摆在面板上，防「带 -- 过滤的 git status 看着干净」那一类误判。
    workingTree: countUncommitted(root),
    lifecycleCounts: counts,
    // status 也必须报心跳陈旧度。它此前只给 heartbeatAt 原始值,而 next 会算
    // heartbeatStale——同一份数据、两个命令、相反结论。status 是 CLAUDE.md 列的
    // 常用命令,从它入手的 agent 看到「5 条 activeClaims」只会读成有人在推进,
    // 正是第 2 条推论二要消除的形态。判据复用 claimStaleHours,不另写一份阈值。
    activeClaims: data.activeClaims.map((claim) => {
      const staleHours = claimStaleHours(claim);
      return {
        sliceId: claim.sliceId,
        claimId: claim.claimId,
        owner: claim.owner,
        heartbeatAt: claim.heartbeatAt,
        heartbeatStale: staleHours !== null && staleHours >= STALE_CLAIM_HOURS,
        staleFor: staleHours === null ? null : `${staleHours} 小时`
      };
    }),
    // 有陈旧 claim 时给出出路,但不重复 next 里那段完整 recoveryHint——
    // status 是汇总视图,细节归 next。两处各写一份长文本必然漂移。
    staleClaimHint: data.activeClaims.some((claim) => {
      const hours = claimStaleHours(claim);
      return hours !== null && hours >= STALE_CLAIM_HOURS;
    })
      ? `有 claim 心跳超过 ${STALE_CLAIM_HOURS} 小时,可能已被遗弃。`
        + '跑 gov next 看每条的 recoveryTrigger 与 release/complete 出路；'
        + 'CLI 不自动释放,擅自释放可能撞上另一个真在跑的进程。'
      : null,
    governanceGateOk: check.ok,
    governanceErrors: check.errors.slice(0, 10)
  });
  // 顶层 ok 与 exitCode 必须跟着 governanceGateOk。emit 恒发 ok: true,于是
  // 实测出现过 `"ok": true` 与 `"governanceGateOk": false` 同时印在一份输出里、
  // 退出码还是 0 的状态——而 ok 是所有其他 gov 子命令表示成败的字段。
  //
  // 只改 governanceGateOk 不改 ok 等于把假绿从一层挪到另一层:管道里 `gov status
  // && 下一步` 或只看 ok 的读者仍旧被放行。status 是只读命令,红代表「治理数据当前
  // 不满足门禁」,不代表本命令执行失败——但对使用者而言这两者要做的事是同一件:先修红。
  if (!check.ok) process.exitCode = 1;
}

function cmdClaim(args) {
  const sliceId = args.slice;
  const owner = args.owner;
  if (!sliceId || !owner) {
    fail('GOV_ARGS_MISSING', 'claim 需要 --slice <W-*> 与 --owner <标识>。');
    return;
  }
  const recoveryTrigger = args['recovery-trigger']
    ?? `检查该切片 entryPoints 对应工作树改动与运行中的写进程；无相关写进程则保存后审查再原子回退 ready`;

  withGovernanceWrite(owner, (documents) => {
    const data = documents.slices;
    const slice = data.slices.find((item) => item.sliceId === sliceId);
    if (!slice) {
      return { ok: false, code: 'GOV_SLICE_UNKNOWN', message: `执行面板中不存在切片 ${sliceId}。` };
    }
    const existing = data.activeClaims.find((claim) => claim.sliceId === sliceId);
    if (existing) {
      return {
        ok: false,
        code: 'GOV_SLICE_ALREADY_CLAIMED',
        message: `${sliceId} 已被 ${existing.owner} 以 ${existing.claimId} claim；不同 agent 不得同时推进同一切片。`,
        extra: { existing }
      };
    }
    if (slice.lifecycle !== 'ready') {
      return {
        ok: false,
        code: 'GOV_SLICE_NOT_CLAIMABLE',
        message: `只能 claim lifecycle=ready 的切片，${sliceId} 当前为 ${slice.lifecycle}。`
      };
    }

    const now = new Date().toISOString();
    const day = now.slice(0, 10).replace(/-/g, '');
    const claimId = args['claim-id'] ?? `claim-${sliceId.toLowerCase()}-${day}`;
    if (data.activeClaims.some((claim) => claim.claimId === claimId)) {
      return {
        ok: false,
        code: 'GOV_CLAIM_ID_DUPLICATE',
        message: `claimId 已存在：${claimId}；用 --claim-id 指定唯一值。`
      };
    }

    slice.lifecycle = 'active';
    data.activeClaims.push({
      sliceId,
      claimId,
      owner,
      claimedAt: now,
      heartbeatAt: now,
      recoveryTrigger
    });

    return {
      ok: true,
      payload: {
        mode: 'claim',
        sliceId,
        claimId,
        owner,
        lifecycle: 'active',
        goal: slice.goal,
        hardPrerequisites: slice.hardPrerequisites,
        entryPoints: slice.entryPoints,
        requiredValidation: slice.requiredValidation,
        authorityCap: slice.authorityCap,
        authorityCapNote: slice.authorityCapNote,
        note: 'claim 不提升 authority；完成后必须以真实运行的 requiredValidation 作为 Evidence 才能 complete。'
      }
    };
  });
}

function cmdHeartbeat(args) {
  const sliceId = args.slice;
  if (!sliceId) {
    fail('GOV_ARGS_MISSING', 'heartbeat 需要 --slice <W-*>。');
    return;
  }
  withGovernanceWrite(args.owner ?? 'heartbeat', (documents) => {
    const data = documents.slices;
    const claim = data.activeClaims.find((item) => item.sliceId === sliceId);
    if (!claim) {
      return { ok: false, code: 'GOV_CLAIM_MISSING', message: `${sliceId} 没有 active claim。` };
    }
    if (args.owner && claim.owner !== args.owner) {
      return {
        ok: false,
        code: 'GOV_CLAIM_OWNER_MISMATCH',
        message: `${sliceId} 的 claim 属于 ${claim.owner}，不是 ${args.owner}。`
      };
    }
    claim.heartbeatAt = new Date().toISOString();
    return { ok: true, payload: { mode: 'heartbeat', sliceId, heartbeatAt: claim.heartbeatAt } };
  });
}

/**
 * 释放 claim 并把切片退回 ready。
 *
 * 这是「没做完就退出」的正确出口。没有它，agent 中断后切片会永远停在
 * active 且挂着一个死 claim，后续 agent 既不能 claim 也不知道能不能接手。
 */
function cmdRelease(args) {
  const sliceId = args.slice;
  if (!sliceId) {
    fail('GOV_ARGS_MISSING', 'release 需要 --slice <W-*>。');
    return;
  }
  withGovernanceWrite(args.owner ?? 'release', (documents) => {
    const data = documents.slices;
    const index = data.activeClaims.findIndex((item) => item.sliceId === sliceId);
    if (index < 0) {
      return { ok: false, code: 'GOV_CLAIM_MISSING', message: `${sliceId} 没有 active claim。` };
    }
    const claim = data.activeClaims[index];
    if (args.owner && claim.owner !== args.owner && args.force !== true) {
      return {
        ok: false,
        code: 'GOV_CLAIM_OWNER_MISMATCH',
        message: `${sliceId} 的 claim 属于 ${claim.owner}；确认对方已停止后可加 --force。`
      };
    }
    const slice = data.slices.find((item) => item.sliceId === sliceId);
    if (!slice) {
      return { ok: false, code: 'GOV_SLICE_UNKNOWN', message: `执行面板中不存在切片 ${sliceId}。` };
    }
    data.activeClaims.splice(index, 1);
    slice.lifecycle = 'ready';
    return {
      ok: true,
      payload: {
        mode: 'release',
        sliceId,
        releasedClaimId: claim.claimId,
        lifecycle: 'ready',
        note: 'authority 未被改动——释放 claim 不撤销也不追加任何验证结论。'
      }
    };
  });
}

/**
 * 把切片标为 completed。
 *
 * 刻意**不**在此处提升 authority、也不写 Evidence：authority 由真实运行的
 * 验证决定，Evidence 需要五字段封存指纹。CLI 若代为提升，就等于让「改状态」
 * 冒充「验证过」，这正是治理要防的事。
 */
function cmdComplete(args) {
  const sliceId = args.slice;
  if (!sliceId) {
    fail('GOV_ARGS_MISSING', 'complete 需要 --slice <W-*>。');
    return;
  }
  withGovernanceWrite(args.owner ?? 'complete', (documents) => {
    const data = documents.slices;
    const slice = data.slices.find((item) => item.sliceId === sliceId);
    if (!slice) {
      return { ok: false, code: 'GOV_SLICE_UNKNOWN', message: `执行面板中不存在切片 ${sliceId}。` };
    }
    if (slice.lifecycle !== 'active') {
      return {
        ok: false,
        code: 'GOV_SLICE_NOT_ACTIVE',
        message: `只能 complete lifecycle=active 的切片，${sliceId} 当前为 ${slice.lifecycle}。`
      };
    }

    // 该切片是否为某个 open Gate 仅剩的活动切片。
    // 这不是 CLI 能自行解决的：治理要求 open Gate 至少有一个 ready/active 切片，
    // 而「下一个切片是什么」是范围裁定，凭空补一个占位切片就是在伪造进度。
    // 所以必须在写入前诚实拒绝并指出该先做什么，而不是让后置校验回滚后
    // 抛出一堆看不懂的闭合错误。
    const gates = documents.gates.gates ?? [];
    const strandedGates = [];
    for (const gate of gates) {
      if (gate.gateState !== 'open') continue;
      const refs = gate.sliceRefs ?? [];
      if (!refs.includes(sliceId)) continue;
      const others = refs.filter((ref) => ref !== sliceId).map((ref) =>
        data.slices.find((item) => item.sliceId === ref)?.lifecycle);
      if (!others.some((lifecycle) => lifecycle === 'ready' || lifecycle === 'active')) {
        strandedGates.push(gate.gateId);
      }
    }
    // 刻意不提供 --force 之类的绕过：绕过前置检查后，后置校验仍会因
    // GATE_OPEN_NO_LIVE_SLICE 回滚。一个必然在更晚处失败的出口比没有出口更糟，
    // 它只会把清晰的拒绝换成一次回滚加一堆闭合错误。
    if (strandedGates.length > 0) {
      return {
        ok: false,
        code: 'GOV_GATE_WOULD_STRAND',
        message: `${sliceId} 是 open Gate ${strandedGates.join('/')} 仅剩的活动切片；complete 后该 Gate 将没有任何 ready/active 切片。请先登记后继切片（或按封存证据把该 Gate 推进到 passed），再 complete。`,
        extra: { strandedGates }
      };
    }

    const index = data.activeClaims.findIndex((item) => item.sliceId === sliceId);
    if (index >= 0) {
      const claim = data.activeClaims[index];
      if (args.owner && claim.owner !== args.owner && args.force !== true) {
        return {
          ok: false,
          code: 'GOV_CLAIM_OWNER_MISMATCH',
          message: `${sliceId} 的 claim 属于 ${claim.owner}；确认对方已停止后可加 --force。`
        };
      }
      data.activeClaims.splice(index, 1);
    }
    slice.lifecycle = 'completed';

    // 终态切片不得继续留在 validation-unfrozen 清单里。这是 completed 的机械
    // 后果而非独立裁定，所以由 CLI 一并处理；留给人工同步只会制造门禁红。
    const unfrozenBefore = documents.validation.unfrozen.length;
    documents.validation.unfrozen = documents.validation.unfrozen
      .filter((entry) => entry.sliceId !== sliceId);
    const unfrozenRemoved = unfrozenBefore - documents.validation.unfrozen.length;

    // 同理，open Gate 的 sliceRefs 表示「当前活动切片」而非历史，治理规则
    // 明确禁止 open Gate 引用终态切片。摘除只是把状态改动落到闭合位置，
    // 不改 gateState/applicability——那需要封存证据。
    const detachedFromGates = [];
    for (const gate of gates) {
      if (gate.gateState !== 'open') continue;
      if (!(gate.sliceRefs ?? []).includes(sliceId)) continue;
      gate.sliceRefs = gate.sliceRefs.filter((ref) => ref !== sliceId);
      detachedFromGates.push(gate.gateId);
    }

    return {
      ok: true,
      payload: {
        mode: 'complete',
        sliceId,
        lifecycle: 'completed',
        authority: slice.authority,
        authorityCap: slice.authorityCap,
        requiredValidation: slice.requiredValidation,
        unfrozenValidationEntriesRemoved: unfrozenRemoved,
        detachedFromOpenGates: detachedFromGates,
        note: 'authority 与 gateState 均未被本命令改动。若本轮真实运行了 requiredValidation 并要提升 authority 或推进 Gate，请单独改数据并追加封存 Evidence，由治理门禁校验。'
      }
    };
  });
}

/**
 * 从 commands 自由文本里找出「非零退出码」的声明。
 *
 * 为什么用文本识别而不是要求结构化输入：commands 现有 100 条历史记录全是自由
 * 文本，强制结构化会让所有历史记录不可解析，而重写它们等于改写已封存的事实。
 * 折中是——识别已有的书写惯例，把「带红封存」变成需要显式接受的动作。
 *
 * 识别的形态来自仓库现有记录的真实写法：
 *   "npm run x (exit 0)"、"npm run x exit 1"、"exit code 1"、"退出码 1"、
 *   "(exit 1, ...)"。
 * 只认紧跟在 exit/退出码 后面的数字，避免把 "13/13" "58/58" 这类计数误判。
 *
 * 刻意宁漏不误报：误报会逼调用方为每条正常封存都加 --accept-nonzero，那个参数
 * 就会退化成仪式，反而掩盖真正带红的情况。漏报的代价只是回到现状。
 */
function detectNonZeroExitClaims(commands) {
  const found = new Set();
  const patterns = [
    /exit\s*(?:code\s*)?[=:]?\s*(\d+)/gi,
    /退出码\s*[=:]?\s*(\d+)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(commands)) !== null) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isInteger(code) && code !== 0) found.add(match[0].trim());
    }
  }
  return [...found];
}

/**
 * 从目标 Gate 已引用的证据里算出必须继承的用户批准标记，报出 subject 里缺的那些。
 *
 * 判据是「目标 Gate 现有证据声明过的标记」而不是一份硬编码清单：标记形态由治理
 * 规则决定（scope-ruling:user-approved、scope-deferral:<Gate>:<Release>:user-approved），
 * 硬编码会在规则演进时静默失效，而这里只要 Gate 上还挂着旧证据就一直准确。
 *
 * 只报缺失、不自动补：标记的语义是「用户批准过」，CLI 替调用方声明它就等于
 * 绕过裁定。补齐动作必须由调用方显式做出。
 */
function collectMissingInheritedMarkers(repoRoot, gateRefs, subject) {
  if (gateRefs.length === 0) return { ok: true, missing: [] };

  let gatesDoc;
  let evidenceLines;
  try {
    gatesDoc = JSON.parse(readFileSync(join(repoRoot, GATES), 'utf8'));
    evidenceLines = readFileSync(join(repoRoot, EVIDENCE), 'utf8').split('\n');
  } catch (error) {
    return {
      ok: false,
      code: 'SEAL_MARKER_PRECHECK_FAILED',
      message: `无法读取治理数据以核对继承标记：${error.message}`
    };
  }

  const subjectById = new Map();
  for (const line of evidenceLines) {
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line);
      subjectById.set(record.evidenceId, String(record.subject ?? ''));
    } catch {
      // 单行损坏不在本检查的职责内：追加后的完整门禁会判它，这里跳过即可。
      continue;
    }
  }

  // 标记形态：冒号分段、以 user-approved 结尾。用它扫已有 subject 而不是枚举
  // 具体标记名，新增标记种类无需改这里。
  const markerPattern = /\b[a-z-]+(?::[A-Za-z0-9.-]+)*:user-approved\b/g;
  const required = new Map();
  for (const gateId of gateRefs) {
    const gate = gatesDoc.gates.find((entry) => entry.gateId === gateId);
    if (gate === undefined) continue; // 未定义 Gate 由后面的 SEAL_GATE_UNDEFINED 报。
    for (const evidenceId of gate.evidenceRefs ?? []) {
      const existing = subjectById.get(evidenceId);
      if (existing === undefined) continue;
      for (const marker of existing.match(markerPattern) ?? []) {
        if (!required.has(marker)) required.set(marker, { marker, gateId, evidenceId });
      }
    }
  }

  const missing = [...required.values()].filter((entry) => !subject.includes(entry.marker));
  if (missing.length === 0) return { ok: true, missing: [] };

  return {
    ok: false,
    code: 'SEAL_INHERITED_MARKER_MISSING',
    message: `--subject 缺少目标 Gate 已声明的用户批准标记：${missing.map((entry) => entry.marker).join('、')}。`
      + ' 缺标记时 freshness 判定筛不出可继承证据，会报成 GATE_EVIDENCE_STALE（指向错误原因）。'
      + ' 工程侧重验证请把这些标记原样写进 subject；若本轮确实改变了范围语义，需要新的用户裁定而不是继承。',
    extra: {
      missingMarkers: missing.map((entry) => ({
        marker: entry.marker,
        requiredByGate: entry.gateId,
        seenInEvidence: entry.evidenceId
      }))
    }
  };
}

/**
 * 追加一条 sealed-current-run Evidence，并证明追加后门禁通过。
 *
 * 存在的理由：改了任何 Gate 主题域文件（治理校验器、范围 JSON、验证脚本）之后，
 * 该 Gate 的封存证据必然变 stale，门禁转红。规则说的修法是「工程侧重跑验证并
 * 重封存」，但仓库里原先没有任何命令能做重封存——只能手抄五个 64 位十六进制串，
 * 抄错一位就是 EVIDENCE_SEAL_INVALID 且不指出错在哪。这一步挡住了自主推进：
 * agent 每次改门禁自身都会把仓库留在红灯状态。
 *
 * 本命令不生产事实。--commands / --result / --non-claims 必须由真正跑过命令的
 * 调用方给出，本命令只负责把它们和一个自洽指纹一起原子落盘。
 */
function cmdSeal(args) {
  const evidenceId = typeof args.id === 'string' ? args.id.trim() : '';
  if (!/^EV-[A-Z0-9-]+$/.test(evidenceId)) {
    fail('SEAL_ID_INVALID', '--id 必须形如 EV-XXX（大写、数字、连字符）。');
    return;
  }
  const required = [
    ['subject', '能力/声明：本条证据支持什么，含 scope-ruling / revalidates 等机器标记'],
    ['commands', '实际运行过的命令与退出码'],
    ['result', '本轮结论与边界'],
    ['non-claims', '明确不声明什么']
  ];
  const values = {};
  for (const [key, description] of required) {
    const value = args[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail('SEAL_FIELD_REQUIRED', `--${key} 不能为空：${description}。`);
      return;
    }
    values[key] = value.trim();
  }

  // commands 字段的极性约束：带着红色结论封存必须是显式动作，不能是自由文本里
  // 藏着的一句话。
  //
  // 本模块只搬运事实、不生产事实（见文件头），所以它无法证明命令真跑过。但它
  // 至少能拦住一种已经发生过的形态：EV-UI-RENOVATION-20260807 的 commands 末尾
  // 写着「npm run test:desktop-ipc-contract exit 1（既有假红…）」——一条 exit 1
  // 被手填进封存并通过全部门禁，随后那条红在 main 上停留了四次 CI，还因为
  // verify 默认 bail 让同层 20 条恢复/写入套件全部 not-attempted。
  //
  // 诊断当时是对的（确实是门禁分类问题），但处置错了。所以这里把「带红封存」
  // 从「写在自由文本里」提升为「必须显式声明 --accept-nonzero 并给出理由，且
  // 理由会被写进 nonClaims」。这不阻止任何合法场景，只是让它留下痕迹。
  const nonZeroEvidence = detectNonZeroExitClaims(values.commands);
  const acceptNonZero = typeof args['accept-nonzero'] === 'string'
    ? args['accept-nonzero'].trim()
    : (args['accept-nonzero'] === true ? '' : null);
  if (nonZeroEvidence.length > 0 && acceptNonZero === null) {
    fail(
      'SEAL_NONZERO_EXIT_NOT_ACCEPTED',
      'commands 里出现非零退出码的声明，但未显式接受。带着红色结论封存必须是'
      + '显式动作：确认这些红确实不影响本条证据的结论后，加 '
      + '--accept-nonzero "<为什么可以带红封存>"，该理由会并入 nonClaims。'
      + '若这些红本该先修掉，请先修——封存不会让红消失。',
      { detected: nonZeroEvidence }
    );
    return;
  }
  if (nonZeroEvidence.length > 0 && acceptNonZero.length === 0) {
    fail(
      'SEAL_NONZERO_REASON_REQUIRED',
      '--accept-nonzero 必须带理由（为什么这些非零退出码不影响本条证据的结论）。'
      + '空理由等于没有约束。',
      { detected: nonZeroEvidence }
    );
    return;
  }
  if (nonZeroEvidence.length > 0) {
    // 理由并入 nonClaims 而不是塞回 commands：nonClaims 是「本条证据不声明什么」
    // 的唯一位置，把带红的边界写在那里，后续读者才会在正确的地方看到它。
    values['non-claims'] = `${values['non-claims']}；`
      + `本条证据带非零退出码封存（${nonZeroEvidence.join('、')}），`
      + `接受理由：${acceptNonZero}`;
  }
  const resolvedRelease = resolveRelease(args.release);
  if (!resolvedRelease.ok) {
    fail('SEAL_RELEASE_INVALID', resolvedRelease.message, { knownReleases: resolvedRelease.known });
    return;
  }
  const targetRelease = resolvedRelease.release;

  // 挂到哪些 Gate 上。freshness 只判定 gates.json 里该 Gate 引用的 evidenceRefs：
  // 一条没被任何 Gate 引用的新证据根本不参与判定，追加它不会消除任何 stale。
  // 实测：不带本参数重封存 REL-SCOPE，三处 stale 全部原样保留。
  const gateRefs = typeof args.gates === 'string'
    ? args.gates.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  for (const gateId of gateRefs) {
    if (!/^[A-Z0-9-]+$/.test(gateId)) {
      fail('SEAL_GATE_ID_INVALID', `--gates 中的 ${gateId} 不是合法 Gate ID。`);
      return;
    }
  }

  // subject 必须带齐目标 Gate 现有证据已声明的用户批准标记，否则 freshness
  // 判定找不到可继承的证据。
  //
  // 这一步是本轮实测的产物：照 sealWhenToUse 写的三步做，重封存多个 Gate
  // 仍然失败，因为 subject 里少了 scope-ruling:user-approved 与 scope-deferral
  // 标记——而门禁按标记筛选参与 freshness 的
  // 证据（handoff-integrity-lib.mjs 的 evidenceHasClaim 分支），筛完为空就报
  // GATE_EVIDENCE_STALE。那个诊断指向「主题域变了」，真实原因是「标记漏了」，
  // agent 会照着错误方向反复重跑验证。
  //
  // 修法不是在 help 散文里补一句：散文会和门禁分叉，且分叉无人发现。这里从
  // 目标 Gate 已引用的证据里把标记算出来，缺哪个报哪个。
  const missingMarkers = collectMissingInheritedMarkers(root, gateRefs, values.subject);
  if (missingMarkers.ok === false) {
    fail(missingMarkers.code, missingMarkers.message, missingMarkers.extra ?? {});
    return;
  }

  const lock = acquireGovernanceLock(root, typeof args.owner === 'string' ? args.owner : 'seal');
  if (!lock.ok) {
    fail(lock.code, lock.message, { holder: lock.holder });
    return;
  }
  try {
    const evidencePath = join(root, EVIDENCE);
    const existing = readFileSync(evidencePath, 'utf8');
    for (const line of existing.split('\n')) {
      if (line.trim().length === 0) continue;
      if (JSON.parse(line).evidenceId === evidenceId) {
        fail('SEAL_ID_DUPLICATE', `${evidenceId} 已存在；封存记录只追加，不覆盖。换一个 ID。`);
        return;
      }
    }

    // 指纹必须在追加之前算：handoffSha256BeforeEvidenceAppend 的语义就是
    // 「追加这条证据之前的交接书哈希」。顺序颠倒会写出一条永远无法复原的基线。
    const fingerprint = computeFingerprint(root);
    if (fingerprint.ok === false) {
      fail(fingerprint.code, fingerprint.message, fingerprint.extra ?? {});
      return;
    }

    const record = {
      evidenceId,
      targetRelease,
      evidenceType: 'sealed-current-run',
      subject: values.subject,
      fingerprint: formatBaseline(fingerprint.fields, fingerprint.fingerprintSha256),
      commands: values.commands,
      result: values.result,
      nonClaims: values['non-claims']
    };
    // JSONL 是纯追加：并行 agent 各自封存不会在同一处产生合并冲突。
    const appended = `${JSON.stringify(record)}\n`;
    appendFileSync(evidencePath, appended, 'utf8');

    const gatesPath = join(root, GATES);
    const gatesBefore = readFileSync(gatesPath, 'utf8');
    const attachedTo = [];
    if (gateRefs.length > 0) {
      const gatesDoc = JSON.parse(gatesBefore);
      for (const gateId of gateRefs) {
        const gate = gatesDoc.gates.find((entry) => entry.gateId === gateId);
        if (gate === undefined) {
          writeFileSync(evidencePath, existing, 'utf8');
          fail('SEAL_GATE_UNDEFINED', `gates.json 中没有 ${gateId}；已回滚本条封存记录。`);
          return;
        }
        // 只追加引用，不删旧引用：历史证据是审计链，重封存不覆盖它。
        if (!gate.evidenceRefs.includes(evidenceId)) {
          gate.evidenceRefs.push(evidenceId);
          attachedTo.push(gateId);
        }
      }
      writeJson(GATES, gatesDoc);
    }

    // 重新投影交接书。必须在后置校验之前：交接书 §17.1 证据表与 §18.3 引用列
    // 是治理 JSON 的投影，新证据不落进去 handoff 门禁就会判 stale——而那正是
    // 本次封存要消除的东西。
    //
    // 注意顺序不影响封存契约：handoffSha256BeforeEvidenceAppend 记录的是
    // 「追加这条证据之前」的交接书哈希，已在上面算完并写进记录。此刻改交接书
    // 不会让那个字段失真，反而是让它描述的「追加后状态」如实发生。
    const handoffPath = join(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md');
    const handoffBefore = readFileSync(handoffPath, 'utf8');
    const projection = projectHandoff(root);
    if (projection.findings.length > 0) {
      writeFileSync(evidencePath, existing, 'utf8');
      writeFileSync(gatesPath, gatesBefore, 'utf8');
      fail('SEAL_PROJECTION_FAILED', '交接书投影失败，已回滚本条封存记录与 Gate 引用。', {
        rolledBack: [EVIDENCE, ...(gateRefs.length > 0 ? [GATES] : [])],
        findings: projection.findings
      });
      return;
    }
    if (projection.drifted) writeFileSync(handoffPath, projection.projected, 'utf8');

    // 追加后必须过完整门禁（含 freshness）。封存的目的就是让 stale 恢复 fresh；
    // 若追加后仍红，说明这次封存没有解决问题，留着它只会掩盖真实状态。
    const after = runGovernanceCheck({ withFreshness: true });
    if (!after.ok) {
      writeFileSync(evidencePath, existing, 'utf8');
      writeFileSync(gatesPath, gatesBefore, 'utf8');
      writeFileSync(handoffPath, handoffBefore, 'utf8');
      fail('SEAL_POSTCHECK_FAILED', '追加后治理门禁仍失败，已回滚本条封存记录、Gate 引用与交接书投影。', {
        rolledBack: [EVIDENCE, ...(gateRefs.length > 0 ? [GATES] : []), 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'],
        errors: after.errors.slice(0, 10),
        hint: gateRefs.length === 0
          ? 'stale 未消除且未指定 --gates：freshness 只判定 gates.json 里该 Gate 引用的 evidenceRefs，没被引用的新证据不参与判定。用 --gates REL-SCOPE,REL-E 把本条挂上去。'
          : '主题域改动是否已提交？指纹锚点是 HEAD，未提交的主题域改动会算进 trackedDiffSha256 但不进 HEAD，锚点之后仍显示有变化。'
      });
      return;
    }

    // 封存写了文件但没提交，而下一次封存的指纹锚点是 HEAD。不报出来的话，
    // 事实源 JSON 会悬在工作区，而它的投影可能已随别的提交入库。
    const touched = [EVIDENCE, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md',
      ...(gateRefs.length > 0 ? [GATES] : [])];
    const uncommitted = collectUncommittedGovernanceFiles(root, touched);

    emit({
      mode: 'seal',
      evidenceId,
      targetRelease,
      attachedToGates: attachedTo,
      fingerprint: fingerprint.fields,
      fingerprintSha256: fingerprint.fingerprintSha256,
      untrackedCount: fingerprint.untrackedCount,
      governanceGate: 'passed',
      uncommittedAfterSeal: uncommitted ?? 'git-status-unavailable',
      nextStep: uncommitted === null
        ? 'git status 不可用，请自行确认本次封存写入的文件已提交。'
        : uncommitted.length > 0
          ? `本次封存写入的文件尚未提交：${uncommitted.join('、')}。请提交——下一次封存的指纹锚点是 HEAD，`
            + '未提交的事实源会与已入库的投影错位。本命令不自动提交，以免把调用方尚未准备好的实现改动一起带进去。'
          : '本次封存写入的文件均已入库，无需额外提交。',
      note: '本命令只搬运调用方陈述的运行事实与一个自洽指纹；它不验证命令真的跑过，也不提升任何 authority，也不改动 gateState。'
    });
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// 参数解析与分发
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

const COMMANDS = Object.freeze({
  next: cmdNext,
  status: cmdStatus,
  claim: cmdClaim,
  heartbeat: cmdHeartbeat,
  release: cmdRelease,
  complete: cmdComplete,
  seal: cmdSeal
});

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === 'help') {
  emit({
    mode: 'help',
    commands: {
      'gov next [--release <Release>]': '默认列出全部可开发切片；显式 --release 时按发布归属筛选',
      'gov status': '执行面板汇总 + 治理门禁当前是否通过（含 freshness 判定；'
        + '门禁红时顶层 ok=false 且退出码 1，与 verify --tier governance 结论一致）',
      'gov claim --slice W-X --owner me [--claim-id id] [--recovery-trigger 文本]': '原子占用切片并置 active',
      'gov heartbeat --slice W-X [--owner me]': '刷新心跳，证明仍在推进',
      'gov release --slice W-X [--owner me] [--force]': '释放 claim 并退回 ready',
      'gov complete --slice W-X [--owner me] [--force]': '标为 completed（不提升 authority、不写 Evidence）',
      'gov seal --id EV-X --subject 声明 --commands 命令与退出码 --result 结论 --non-claims 不声明项 [--gates REL-SCOPE,REL-E] [--release <Release>]':
        '追加 sealed-current-run Evidence：自动算五字段指纹；省略 --release 表示开发 Evidence，显式传入时绑定发布归属；按需挂到 Gate 的 evidenceRefs，追加后跑含 freshness 的完整门禁，失败即回滚'
    },
    sealWhenToUse: '改了任何 Gate 主题域文件（治理校验器、治理 schema、范围 JSON、验证脚本）后该 Gate 的封存证据会变 stale。步骤：'
      + '(1) 先把主题域改动提交——指纹锚点是 HEAD，未提交的改动会算进 trackedDiffSha256 但不进 HEAD；'
      + '(2) gov seal 时用 --gates 指定要恢复的 Gate——freshness 只判定该 Gate 引用的 evidenceRefs，没被引用的新证据不参与判定；'
      + '(3) subject 里带 revalidates=<既有EvidenceId> 继承既有用户批准标记，工程侧重验证不需要用户再授权；'
      + '(4) subject 还必须原样带齐目标 Gate 现有证据声明过的 user-approved 标记（如 scope-ruling:user-approved、scope-deferral:<Gate>:<Release>:user-approved）。漏标记时 freshness 筛不出可继承证据，报错会是 GATE_EVIDENCE_STALE（指向错误原因）；本命令已在追加前预检并指名缺哪个。',
    sealRequiredArgs: '--id、--subject、--commands、--result、--non-claims 全部必填，缺任一项在追加前失败（SEAL_ID_INVALID / SEAL_FIELD_REQUIRED）。要恢复 Gate 还需 --gates。',
    sealNonZeroPolicy: 'commands 里出现非零退出码声明（exit 1 / 退出码 1 之类）时，'
      + '必须显式加 --accept-nonzero "<为什么可以带红封存>"，否则在追加前失败'
      + '（SEAL_NONZERO_EXIT_NOT_ACCEPTED；空理由报 SEAL_NONZERO_REASON_REQUIRED）。'
      + '理由会自动并入 nonClaims。这条约束的来由：曾有一条 exit 1 被写在 commands '
      + '自由文本末尾并通过全部门禁，那条红随后在 main 上停留四次 CI，还因 verify '
      + '默认 bail 让同层 20 条套件全部 not-attempted。封存不会让红消失——先修红，'
      + '确实该带红封存时留下痕迹。',
    concurrency: '所有写命令在系统临时目录的文件锁下串行执行；锁不写入仓库与 Mod 工作区。',
    staleClaims: `next 的 activeSlices 与 status 的 activeClaims 都会报 heartbeatStale：`
      + `心跳超过 ${STALE_CLAIM_HOURS} 小时即视为可能被遗弃，两命令判定逐字段一致。`
      + 'next 另给该 claim 的 recoveryTrigger 与 release/complete 两条出路，status 只提示去看 next。CLI 不自动释放——'
      + '擅自释放可能撞上另一个真在跑的进程。看到 heartbeatStale=true 时先按 recoveryTrigger 核实是否真无人推进，'
      + '再决定 release（回到可 claim）还是走封存四步后 complete。推进期间用 gov heartbeat 刷新，避免被后来者误判。',
    note: 'claim/complete 只改执行面板状态。authority 与 Evidence 必须由真实运行的验证支撑。'
  });
} else if (!(command in COMMANDS)) {
  fail('GOV_COMMAND_UNKNOWN', `未知命令：${command}。可用：${Object.keys(COMMANDS).join(', ')}。`);
} else {
  COMMANDS[command](parseArgs(rest));
}

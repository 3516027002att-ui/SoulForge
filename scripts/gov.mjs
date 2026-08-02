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
 * 解析 --release。默认值取自 releases.json 的 currentRelease，不写字面量。
 *
 * 治理必须跨版本（V0.5 → V0.6 → …）。把 'V0.5' 写死在 CLI 里意味着 V0.5 收尾
 * 那天，seal 会继续把证据挂到已冻结的版本上，而 releases.json 里 currentRelease
 * 已经翻到 V0.6——两份权威直接分叉，且没有任何门禁能看见。
 *
 * 同时校验版本必须在 releases.json 里真实存在。原先只校验 /^V\d+\.\d+$/ 形状，
 * 所以 `--release V9.9` 能通过，会封存出一条挂在不存在版本上的证据；而 cmdNext
 * 的 --release 连形状都不校验，拼错只会静默返回空的 claimable 列表——agent 会把
 * 「参数拼错」读成「没有可推进切片」。
 *
 * @param {unknown} raw 命令行传入的 --release 原值
 * @returns {{ok: true, release: string, isDefault: boolean} | {ok: false, code: string, message: string, known: string[]}}
 */
function resolveRelease(raw) {
  const data = readJson(RELEASES);
  const known = data.releases.map((entry) => entry.release);
  const provided = typeof raw === 'string' ? raw.trim() : '';
  const release = provided.length > 0 ? provided : data.currentRelease;

  if (typeof release !== 'string' || !/^V\d+\.\d+$/.test(release)) {
    return {
      ok: false,
      code: 'RELEASE_SHAPE_INVALID',
      message: `--release 必须形如 V0.5，收到 ${JSON.stringify(release)}。`,
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
 * 没有可 claim 切片时，按该版本切片的实际 lifecycle 分布给出正确出路。
 *
 * 原先无论什么原因都回同一句「先完成或释放在飞切片，或按 blockers.json 解阻塞」。
 * 实测 `next --release V0.6` 撞上死路：V0.6 的 3 条切片全是 lifecycle=deferred，
 * blockerRefs 全为空数组，agent 按指引去查 blockers.json 什么都查不到，而 deferred
 * 也不是靠释放 claim 或解阻塞能变 ready 的——真正的出路是 scope.json 里那条
 * scopeItem 的 resumeRequires。给错出路比不给更糟：agent 会沿着错误方向反复尝试。
 */
function emptyCandidateMessage(slicesInRelease, release) {
  const counts = new Map();
  for (const slice of slicesInRelease) {
    counts.set(slice.lifecycle, (counts.get(slice.lifecycle) ?? 0) + 1);
  }
  const scope = release === null ? '全部版本' : release;

  if (slicesInRelease.length === 0) {
    return `${scope} 下没有任何切片；新版本要先在 slices.json 里登记 targetRelease=${scope} 的切片。`;
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
 * 列出可推进的切片。判定依据只有治理数据，不含任何人工优先级——
 * 优先级一旦写进 CLI 就成了第二份权威，会与 slices.json 漂移。
 */
function cmdNext(args) {
  const data = readSlices();
  const claimedIds = new Set(data.activeClaims.map((claim) => claim.sliceId));

  // --all 明确表示跨版本查看；不传 --release 时按当前版本过滤而不是列出全部。
  // 列出全部会把 V0.6 切片混进选点结果，而 V0.6 的硬前置尚未成立。
  const wantsAll = args.all === true || args.release === 'all';
  let release = null;
  if (!wantsAll) {
    const resolved = resolveRelease(args.release);
    if (!resolved.ok) {
      fail(resolved.code, resolved.message, { knownReleases: resolved.known });
      return;
    }
    release = resolved.release;
  }

  // 三个列表必须用同一个版本判据。实测漏过一次：只给 candidates 加了过滤，
  // 于是 `next --release V0.6` 返回 claimable=0 但 activeSlices=5，而那 5 条
  // targetRelease 全是 V0.5——agent 会读成「V0.6 有人在做了」，实际是 V0.5 的在飞
  // claim 漏进了 V0.6 视图。
  const inRelease = (slice) => !release || slice.targetRelease === release;

  const candidates = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'ready');
  const inFlight = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'active');
  const blocked = data.slices.filter((slice) => inRelease(slice) && slice.lifecycle === 'blocked');

  emit({
    mode: 'next',
    release,
    claimable: candidates.map((slice) => ({
      sliceId: slice.sliceId,
      targetRelease: slice.targetRelease,
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
    activeSlices: inFlight.map((slice) => ({
      sliceId: slice.sliceId,
      owner: data.activeClaims.find((claim) => claim.sliceId === slice.sliceId)?.owner ?? null,
      claimId: data.activeClaims.find((claim) => claim.sliceId === slice.sliceId)?.claimId ?? null
    })),
    blockedSlices: blocked.map((slice) => ({
      sliceId: slice.sliceId,
      blockerRefs: slice.blockerRefs
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
      '5. 改了治理主题域文件就先提交，再 gov seal（四步流程见 gov help 的 sealWhenToUse）',
      '6. gov complete --slice <sliceId> —— 只改执行面板状态，不提升 authority',
      'authority 提升必须另有真实运行的验证支撑，不能由 claim/complete 推导。'
    ]
  });
}

function cmdStatus() {
  const data = readSlices();
  const counts = {};
  for (const slice of data.slices) {
    counts[slice.lifecycle] = (counts[slice.lifecycle] ?? 0) + 1;
  }
  const check = runGovernanceCheck();
  emit({
    mode: 'status',
    lifecycleCounts: counts,
    activeClaims: data.activeClaims.map((claim) => ({
      sliceId: claim.sliceId,
      claimId: claim.claimId,
      owner: claim.owner,
      heartbeatAt: claim.heartbeatAt
    })),
    governanceGateOk: check.ok,
    governanceErrors: check.errors.slice(0, 10)
  });
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
  // 这一步是本轮实测的产物：照 sealWhenToUse 写的三步做，重封存 REL-SCOPE/
  // REL-E/REL-I 仍然失败，因为 subject 里少了 scope-ruling:user-approved 与两条
  // scope-deferral:<Gate>:V0.6:user-approved——而门禁按标记筛选参与 freshness 的
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
      'gov next [--release V0.5]': '列出可 claim 的切片、在飞切片与被阻塞切片',
      'gov status': '执行面板汇总 + 治理门禁当前是否通过',
      'gov claim --slice W-X --owner me [--claim-id id] [--recovery-trigger 文本]': '原子占用切片并置 active',
      'gov heartbeat --slice W-X [--owner me]': '刷新心跳，证明仍在推进',
      'gov release --slice W-X [--owner me] [--force]': '释放 claim 并退回 ready',
      'gov complete --slice W-X [--owner me] [--force]': '标为 completed（不提升 authority、不写 Evidence）',
      'gov seal --id EV-X --subject 声明 --commands 命令与退出码 --result 结论 --non-claims 不声明项 [--gates REL-SCOPE,REL-E] [--release V0.5]':
        '追加 sealed-current-run Evidence：自动算五字段指纹，按需挂到 Gate 的 evidenceRefs，追加后跑含 freshness 的完整门禁，失败即回滚'
    },
    sealWhenToUse: '改了任何 Gate 主题域文件（治理校验器、治理 schema、范围 JSON、验证脚本）后该 Gate 的封存证据会变 stale。步骤：'
      + '(1) 先把主题域改动提交——指纹锚点是 HEAD，未提交的改动会算进 trackedDiffSha256 但不进 HEAD；'
      + '(2) gov seal 时用 --gates 指定要恢复的 Gate——freshness 只判定该 Gate 引用的 evidenceRefs，没被引用的新证据不参与判定；'
      + '(3) subject 里带 revalidates=<既有EvidenceId> 继承既有用户批准标记，工程侧重验证不需要用户再授权；'
      + '(4) subject 还必须原样带齐目标 Gate 现有证据声明过的 user-approved 标记（如 scope-ruling:user-approved、scope-deferral:<Gate>:<Release>:user-approved）。漏标记时 freshness 筛不出可继承证据，报错会是 GATE_EVIDENCE_STALE（指向错误原因）；本命令已在追加前预检并指名缺哪个。',
    sealRequiredArgs: '--id、--subject、--commands、--result、--non-claims 全部必填，缺任一项在追加前失败（SEAL_ID_INVALID / SEAL_FIELD_REQUIRED）。要恢复 Gate 还需 --gates。',
    concurrency: '所有写命令在系统临时目录的文件锁下串行执行；锁不写入仓库与 Mod 工作区。',
    note: 'claim/complete 只改执行面板状态。authority 与 Evidence 必须由真实运行的验证支撑。'
  });
} else if (!(command in COMMANDS)) {
  fail('GOV_COMMAND_UNKNOWN', `未知命令：${command}。可用：${Object.keys(COMMANDS).join(', ')}。`);
} else {
  COMMANDS[command](parseArgs(rest));
}

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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireGovernanceLock } from './gov/lock.mjs';
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
function runGovernanceCheck() {
  const registry = gateSubjectRegistry();
  const subjectRefsByGate = new Map(registry.gates.map((gate) => [
    gate.gateId,
    [
      ...gate.files,
      ...gate.handoffSections.map(handoffSectionSubjectRef),
      ...gate.handoffBlocks.map((block) => handoffBlockSubjectRef(block.id))
    ]
  ]));
  // 这里刻意不传 handoffMarkdown：claim 只改执行面板，不触碰 Evidence，
  // freshness 判定与 claim 无关。少读一个 3500 行文件也让 CLI 更快。
  const result = validateGovernanceData(root, {
    parseSealBaseline,
    subjectRefsOf: (gateId) => subjectRefsByGate.get(gateId) ?? null,
    freezeBaselineRef: 'HEAD'
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
 * 列出可推进的切片。判定依据只有治理数据，不含任何人工优先级——
 * 优先级一旦写进 CLI 就成了第二份权威，会与 slices.json 漂移。
 */
function cmdNext(args) {
  const data = readSlices();
  const claimedIds = new Set(data.activeClaims.map((claim) => claim.sliceId));
  const release = args.release ?? null;

  const candidates = data.slices.filter((slice) => {
    if (release && slice.targetRelease !== release) return false;
    return slice.lifecycle === 'ready';
  });
  const inFlight = data.slices.filter((slice) => slice.lifecycle === 'active');
  const blocked = data.slices.filter((slice) => slice.lifecycle === 'blocked');

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
      ? '没有 lifecycle=ready 的切片；先完成或释放在飞切片，或按 blockers.json 解阻塞。'
      : `${candidates.length} 条切片可 claim；claim 前请先读 entryPoints 与 requiredValidation。`,
    note: 'claim 只是并发协调，不构成 Evidence，也不提升 authority。'
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
  complete: cmdComplete
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
      'gov complete --slice W-X [--owner me] [--force]': '标为 completed（不提升 authority、不写 Evidence）'
    },
    concurrency: '所有写命令在系统临时目录的文件锁下串行执行；锁不写入仓库与 Mod 工作区。',
    note: 'claim/complete 只改执行面板状态。authority 与 Evidence 必须由真实运行的验证支撑。'
  });
} else if (!(command in COMMANDS)) {
  fail('GOV_COMMAND_UNKNOWN', `未知命令：${command}。可用：${Object.keys(COMMANDS).join(', ')}。`);
} else {
  COMMANDS[command](parseArgs(rest));
}

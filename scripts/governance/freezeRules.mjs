/**
 * 跨版本冻结规则。
 *
 * 这是治理数据 JSON 化真正新增的能力：markdown 门禁只能检查「文档自身是否
 * 自洽」，无法阻止某次提交悄悄改写已冻结版本的用户裁定。冻结拦截必须与
 * git 基线比对才能物理生效——只看当前文件内容永远看不出它被改过。
 *
 * 拦截边界（releases.json 的 frozenFields）刻意只覆盖用户裁定字段。
 * 工程进度字段（gateState / lifecycle / authority / evidence 追加）不受冻结
 * 约束，否则 V0.5 冻结后自身无法继续推进——那会把治理变成死锁。
 */
import { spawnSync } from 'node:child_process';

const FROZEN_FIELD_PATTERN = /^(?<container>[a-zA-Z]+)(?<array>\[\])?(?:\.(?<field>[a-zA-Z]+))?$/;

function makeFinding(code, where, message) {
  return { severity: 'error', code, where, message };
}

/**
 * 读取 git 中某个 ref 下的文件内容。
 * @returns {{ available: boolean, content: string|null, reason: string|null }}
 */
function runGit(root, args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
}

/**
 * 读取 git 中某个 ref 下的文件内容。
 *
 * 三种结果必须严格区分，不能都归为「基线不可得」：
 * - `available`：拿到基线，可以做冻结比对；
 * - `absent`：ref 存在但该文件在其中不存在 → 治理数据首次提交，是新增而非篡改；
 * - `unverifiable`：git 不可用、不在仓库内、ref 不存在 → **无法验证冻结**。
 *   这一类必须失败关闭：否则把数据复制到仓库外跑一遍门禁就能绕过冻结拦截。
 *
 * @returns {{ status: 'available'|'absent'|'unverifiable', content: string|null, reason: string|null }}
 */
function readFromGit(root, ref, relativePath) {
  // 先确认 ref 本身可解析。ref 不可解析时无法区分「文件新增」和「无从比对」。
  const refCheck = runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (refCheck.error) {
    return { status: 'unverifiable', content: null, reason: `git 不可用：${refCheck.error.message}` };
  }
  if (refCheck.status !== 0) {
    return { status: 'unverifiable', content: null, reason: `无法解析基线 ref ${ref}（不在 git 仓库内或该 ref 不存在）` };
  }

  const result = runGit(root, ['show', `${ref}:${relativePath}`]);
  if (result.error) {
    return { status: 'unverifiable', content: null, reason: `git show 失败：${result.error.message}` };
  }
  if (result.status !== 0) {
    // ref 有效但文件不在其中：治理数据首次提交，属于新增。
    return { status: 'absent', content: null, reason: `${relativePath} 不存在于 ${ref}` };
  }
  return { status: 'available', content: result.stdout, reason: null };
}

/**
 * 解析冻结字段路径。支持三种形式：
 *   `gameBuildRange`              顶层字段
 *   `scopeItems[].proposedSupport` 数组元素字段（按 scopeItemId 对齐）
 *   `scopeItems[]`                 整个数组元素
 */
function parseFrozenField(spec) {
  const match = FROZEN_FIELD_PATTERN.exec(spec);
  if (!match) return null;
  return {
    container: match.groups.container,
    isArray: match.groups.array === '[]',
    field: match.groups.field ?? null
  };
}

const ITEM_KEY_BY_CONTAINER = Object.freeze({
  scopeItems: 'scopeItemId',
  gates: 'gateId',
  slices: 'sliceId',
  blockers: 'blockerId'
});

function canonical(value) {
  return JSON.stringify(value ?? null);
}

/**
 * 比较冻结字段在基线与当前数据之间是否发生变化。
 * 只报告归属于该冻结版本（targetRelease 匹配）的条目。
 */
function diffFrozenField(release, spec, baseline, current, findings, where, unfrozenItemIds = null) {
  const parsed = parseFrozenField(spec);
  if (parsed === null) {
    findings.push(makeFinding(
      'FREEZE_FIELD_SPEC_INVALID',
      'docs/governance/releases.json',
      `frozenFields 条目无法解析：${spec}；失败关闭而不是忽略该冻结项。`
    ));
    return;
  }

  if (!parsed.isArray) {
    if (canonical(baseline[parsed.container]) !== canonical(current[parsed.container])) {
      findings.push(makeFinding(
        'FREEZE_VIOLATION',
        where,
        `${release} 已冻结，但裁定字段 ${spec} 与 git 基线不一致。`
          + `需要变更必须先有新的用户裁定，并在 releases.json 写入 ${release} 的 unfreezeRuling。`
      ));
    }
    return;
  }

  const itemKey = ITEM_KEY_BY_CONTAINER[parsed.container];
  if (!itemKey) {
    findings.push(makeFinding(
      'FREEZE_FIELD_SPEC_INVALID',
      'docs/governance/releases.json',
      `frozenFields 引用了未登记对齐键的数组：${spec}；失败关闭。`
    ));
    return;
  }

  const baselineItems = new Map(
    (baseline[parsed.container] ?? []).map((item) => [item[itemKey], item])
  );
  const currentItems = new Map(
    (current[parsed.container] ?? []).map((item) => [item[itemKey], item])
  );

  for (const [id, currentItem] of currentItems) {
    // 只保护属于该冻结版本的条目。V0.6 新条目自由，V0.5 条目不可动。
    if (currentItem.targetRelease !== undefined && currentItem.targetRelease !== release) continue;
    // 按条目解冻：只放开 unfreezeRuling.scopeItemIds 里显式列出的条目。
    // 未列出的条目继续比对基线——这是「按条目」与「整版放开」的全部区别。
    if (unfrozenItemIds !== null && unfrozenItemIds.has(id)) continue;
    const baselineItem = baselineItems.get(id);
    if (!baselineItem) continue; // 新增条目由范围裁定规则管，不属于冻结篡改。
    const before = parsed.field === null ? baselineItem : baselineItem[parsed.field];
    const after = parsed.field === null ? currentItem : currentItem[parsed.field];
    if (canonical(before) !== canonical(after)) {
      findings.push(makeFinding(
        'FREEZE_VIOLATION',
        `${where} ${id}`,
        `${release} 已冻结，但 ${id} 的裁定字段 ${parsed.field ?? '(整条)'} 与 git 基线不一致：`
          + `${canonical(before)} → ${canonical(after)}。`
          + `需要变更必须先有新的用户裁定，并在 releases.json 写入 ${release} 的 unfreezeRuling。`
      ));
    }
  }

  for (const [id, baselineItem] of baselineItems) {
    if (baselineItem.targetRelease !== undefined && baselineItem.targetRelease !== release) continue;
    // 删除保护**不随解冻放开**：解冻允许改裁定字段，不允许让条目消失。
    // 条目消失会让它彻底脱离所有判据（连「被改过」都看不见），
    // 与「改一个字段」不是同一量级的动作。
    if (!currentItems.has(id)) {
      findings.push(makeFinding(
        'FREEZE_VIOLATION',
        `${where} ${id}`,
        `${release} 已冻结，但条目 ${id} 已从 ${parsed.container} 删除。删除已批准裁定条目等同改写裁定。`
      ));
    }
  }
}

/**
 * 校验跨版本冻结。
 *
 * @param {object} data loadGovernanceData 的 data
 * @param {Array} findings
 * @param {{ root?: string, baselineRef?: string }} [options]
 *   baselineRef 缺省 HEAD；`null` 表示禁用基线比对（仅做结构检查）。
 */
export function validateCrossVersionFreeze(data, findings, options = {}) {
  const root = options.root ?? process.cwd();
  const baselineRef = options.baselineRef === undefined ? 'HEAD' : options.baselineRef;
  const releases = data.releases.releases ?? [];
  const knownReleases = new Set(releases.map((entry) => entry.release));

  // 每条治理记录的 targetRelease 必须已登记，否则冻结保护有洞。
  const targeted = [
    ['docs/governance/gates.json', data.gates.gates ?? [], 'gateId'],
    ['docs/governance/slices.json', data.slices.slices ?? [], 'sliceId'],
    ['docs/governance/scope.json', data.scope.scopeItems ?? [], 'scopeItemId']
  ];
  for (const [where, items, idKey] of targeted) {
    for (const item of items) {
      if (!knownReleases.has(item.targetRelease)) {
        findings.push(makeFinding(
          'TARGET_RELEASE_UNKNOWN',
          `${where} ${item[idKey]}`,
          `targetRelease=${item.targetRelease ?? '(缺失)'} 未在 releases.json 登记。`
        ));
      }
      if (item.deferredToRelease && !knownReleases.has(item.deferredToRelease)) {
        findings.push(makeFinding(
          'DEFERRED_RELEASE_UNKNOWN',
          `${where} ${item[idKey]}`,
          `deferredToRelease=${item.deferredToRelease} 未在 releases.json 登记。`
        ));
      }
    }
  }
  for (const record of data.evidence ?? []) {
    if (!knownReleases.has(record.targetRelease)) {
      findings.push(makeFinding(
        'TARGET_RELEASE_UNKNOWN',
        `docs/governance/evidence.jsonl ${record.evidenceId}`,
        `targetRelease=${record.targetRelease ?? '(缺失)'} 未在 releases.json 登记。`
      ));
    }
  }

  if (baselineRef === null) return;

  for (const entry of releases) {
    if (entry.frozen !== true) continue;

    // ── 解冻裁定：**按条目**放开，不是整版放开 ──
    //
    // 负向证明（2026-08-08 实测六条，改治理数据后复跑 verify-governance）：
    //   U1 改**未列出**条目的 authorityAtRuling → 仍报 FREEZE_VIOLATION ✓
    //   U2 改未列出条目的 operations           → 仍报 FREEZE_VIOLATION ✓
    //   U3 删除未列出的条目                    → 仍报 FREEZE_VIOLATION ✓
    //   U4 删除**已解冻**的 ESD 条目           → 仍报 FREEZE_VIOLATION ✓
    //      （解冻允许改字段，不允许条目消失——条目消失会让它脱离所有判据）
    //   U5 scopeItemIds 为空数组               → 失败关闭，不退回整版放开 ✓
    //   U6 ESD 的裁定字段改动                  → 被放行（否则解冻等于没生效）✓
    // U1 首次用 proposedSupport 做靶标时不命中：把 supported 改成 deferred 会缺
    // deferredToRelease，被 schema 先拦下，测到的是「schema 不合法」而不是冻结拦截。
    // 换成 authorityAtRuling 后才是有效退化——**退化必须精准到只破坏被测的那一件事**。
    //
    // 原实现在这里直接 `continue`，于是一旦某版声明了 unfreezeRuling，该版**全部**
    // scopeItem 的裁定字段一起脱离基线比对。真实场景里解冻通常只针对一条
    // （2026-08-08 用户裁定只涉及 SCOPE-BEHAVIOR-ESD），整版放开等于为了改一条
    // 而把其余十几条的保护一起关掉，且关掉期间无人会注意——这正是「一道门禁被
    // 合法用途顺带关掉」的形态。
    //
    // 现在要求裁定显式列出 scopeItemIds，未列出的条目继续比对基线。
    let unfrozenItemIds = null;
    if (entry.unfreezeRuling !== null && entry.unfreezeRuling !== undefined) {
      const ruling = entry.unfreezeRuling;
      const ids = Array.isArray(ruling?.scopeItemIds) ? ruling.scopeItemIds : null;
      // 形态不合法必须失败关闭：若默认按整版放开，写错字段名就悄悄退回旧行为，
      // 而「保护面变小」不会有任何信号。
      if (ids === null || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
        findings.push(makeFinding(
          'FREEZE_UNFREEZE_RULING_INVALID',
          'docs/governance/releases.json',
          `${entry.release} 的 unfreezeRuling 必须显式列出非空 scopeItemIds（字符串数组），`
            + '用来限定本次解冻放开哪些条目。缺失或为空时失败关闭——'
            + '否则一条写错字段的裁定会把该版全部裁定字段的保护一起关掉。'
        ));
        continue;
      }
      unfrozenItemIds = new Set(ids);
      findings.push({
        severity: 'info',
        code: 'FREEZE_UNFROZEN_BY_RULING',
        where: 'docs/governance/releases.json',
        message: `${entry.release} 声明了 unfreezeRuling，已按条目放开冻结拦截：`
          + `${[...unfrozenItemIds].join(', ')}。其余条目继续比对 git 基线；`
          + '该裁定的真实性由工程复核负责。'
      });
    }

    const baseline = readFromGit(root, baselineRef, 'docs/governance/scope.json');
    if (baseline.status === 'unverifiable') {
      // 无法验证冻结时必须失败关闭。若降级为 info，把治理数据复制到仓库外
      // 跑一遍门禁就能"通过"，冻结拦截等于不存在。
      findings.push(makeFinding(
        'FREEZE_BASELINE_UNVERIFIABLE',
        'docs/governance/scope.json',
        `无法验证 ${entry.release} 的冻结字段：${baseline.reason}。`
          + '冻结拦截依赖 git 基线比对，基线不可验证时失败关闭；'
          + `确实需要跳过（如仓库外自检）请显式传入 freezeBaselineRef=null。`
      ));
      continue;
    }
    if (baseline.status === 'absent') {
      // ref 有效但文件不在其中：治理数据首次提交，是新增而非篡改。
      findings.push({
        severity: 'info',
        code: 'FREEZE_BASELINE_ABSENT',
        where: 'docs/governance/scope.json',
        message: `${baseline.reason}；本次为治理数据新增，未做 ${entry.release} 冻结字段比对。`
      });
      continue;
    }

    let baselineScope;
    try {
      baselineScope = JSON.parse(baseline.content);
    } catch (error) {
      findings.push(makeFinding(
        'FREEZE_BASELINE_PARSE_FAIL',
        'docs/governance/scope.json',
        `${baselineRef} 下的 scope.json 无法解析：${error.message}；失败关闭。`
      ));
      continue;
    }

    for (const spec of entry.frozenFields ?? []) {
      diffFrozenField(
        entry.release,
        spec,
        baselineScope,
        data.scope,
        findings,
        'docs/governance/scope.json',
        unfrozenItemIds
      );
    }
  }
}

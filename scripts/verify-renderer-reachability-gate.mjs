#!/usr/bin/env node
/**
 * Renderer 最后一跳可达性门禁。
 *
 * 守的问题：一个面板的功能入口在所有分支下都拿不到可用数据，于是「后端已实现、
 * 门禁已通过、证据已封存」与「用户能用」之间出现系统性偏差。
 *
 * 为什么需要它（三个实测实例）：
 *
 *  1. AI agent：6 个 preload 方法 + main handler 齐全，REL-G Gate 已 passed，
 *     renderer 零引用——界面上没有任何入口。
 *  2. BND4 无损基线：ef9f55e 切分出 RebuildPreservingLayout，但只接进往返报告，
 *     生产落盘 Bnd4NativeWriter.cs 零调用，「报告说无损、产物不是」。
 *  3. PARAM 字段编辑：UI/解码/mutation/IPC/Patch Engine 五段全通，断点是
 *     App.tsx 的 `definition={paramLive ? null : EMPTY_PARAM_DEF}` ——
 *     live 分支给 null 触发面板短路，非 live 分支给 fields:[] 让 fieldViews 为空，
 *     **两条分支都进不去**。
 *
 * 共同形态：治理检查「每段是否有证据」，而断线发生在**段与段之间**。
 * test:preload-surface-ruling 抓的是 preload 边界（暴露面 = 已用 ∪ 已裁定），
 * 管不到 renderer 内部的 props 链。本门禁补的正是这一段。
 *
 * 判据（刻意保守，只报能静态确证的）：
 *   形态 A —— 三元 props 的两个分支都是「不可用值」（null / undefined /
 *              空数组 / 已知空常量）。这类表达式无论走哪支都拿不到数据。
 *   形态 B —— props 恒定传字面空值（`prop={null}` / `prop={[]}`），
 *              且该 prop 名不在允许清单里。
 *
 * 不做的事：不做类型推断、不跨文件追踪数据流、不猜运行时值。宁可漏报也不误报
 * ——一道会误报的门禁很快会被加豁免绕过，那就退化成装饰。
 *
 * 已裁定条目写在 RULED 里，每条必须写明依据与解除条件；空理由等于「先放着」，
 * 而那正是本门禁要消除的状态。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'renderer-reachability';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');

/**
 * 已裁定的「两分支都不可用」表达式。
 * key 是 `prop名`，value 必须写清依据与解除条件。
 */
const RULED = Object.freeze({
  // ── PARAM 字段定义（SCOPE-PARAM / REL-C，gateState=open）──
  //
  // 裁定：保留并登记为已知断点，不豁免为「设计如此」。
  // 现状：live 分支传 null → ParamDefPanel:295 的 `props.definition &&` 短路；
  //       非 live 分支传 EMPTY_PARAM_DEF（fields:[]）→ fieldViews.length===0。
  //       两条分支都进不了字段表，因此 PARAM 字段级编辑对用户不可达。
  // 另有两道独立锁，解除本条前必须一并处理：
  //   · ParamNativeDocument.cs:475 的 includePayload 门限
  //     （RowDataSize<=256 && Rows.Count<=32），真实 param 远超，字节不下发，
  //     ParamDefPanel:291 的「该行缺少完整字节」会先触发；
  //   · App.tsx:138-140 注释声称「真实字段定义来自 main 侧 Smithbox metadata
  //     投影」，实测 apps/desktop/src 里 Smithbox 仅 1 处命中——就是那条注释本身，
  //     该投影不存在。
  // 解除条件：main 侧提供真实 ParamDefDocument 且 payload 门限放开后接线，
  //           届时本条应从 RULED 删除（判据 2 会强制它删）。
  definition: 'REL-C open；PARAM 字段编辑五段全通但两分支都不可达，另有 payload 门限与不存在的 metadata 投影两道锁',

  // ── 任务队列（WorkbenchOpsPanel 的 jobs）──
  //
  // 裁定：保留并登记为已知断点。旁边的 onCancelJob 回调自述
  // 「任务取消请求已记录；待 TaskQueue IPC」——即取消入口在界面上存在但没有
  // 后端通道，而 jobs 恒定传 [] 意味着运行中任务列表永远是空的。
  // 后果：硬约束 16 要求长任务可报告进度、可取消，当前用户看不到任何在跑的任务。
  // 解除条件：main 侧提供 TaskQueue 的读侧（列出在跑任务）与取消通道后接线。
  jobs: '硬约束 16 长任务可见性未接线；onCancelJob 自述「待 TaskQueue IPC」，jobs 恒空使运行中任务对用户不可见',

  // ── 补丁影响面（WorkbenchOpsPanel 的 patchImpact）──
  //
  // 裁定：保留并登记。恒定传 null，因此「这次提交会影响哪些资源」这一信息
  // 在写入前对用户不可见——而它正是审查环节最该看到的东西。
  // 解除条件：PatchIR 已含影响面数据，接上投影即可；属 renderer 接线缺口，
  //           不是能力缺失。
  patchImpact: '提交前影响面对用户不可见；PatchIR 侧已有数据，属 renderer 接线缺口'
});

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(APP)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'APP_SOURCE_MISSING',
    message: `renderer 主文件缺失：${APP}`
  }, 1);
}

const source = readFileSync(APP, 'utf8');

/** 已知的空常量名（在 App.tsx 顶部定义、内容为空的那些）。 */
const emptyConstNames = new Set(
  [...source.matchAll(/^const (EMPTY_[A-Z0-9_]+)[^=]*=\s*(\[\]|\{)/gm)].map((m) => m[1])
);
if (emptyConstNames.size === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'EMPTY_CONST_UNEXTRACTABLE',
    message: '未能从 App.tsx 提取任何 EMPTY_* 常量。提取失败必须失败关闭，'
      + '否则本门禁的判据会变成必然通过。'
  }, 1);
}

/** 判断一个分支表达式是否「不可用值」。 */
function isUnusable(expr) {
  const t = expr.trim();
  if (t === 'null' || t === 'undefined') return true;
  if (/^\[\s*\]$/.test(t)) return true;
  if (emptyConstNames.has(t)) return true;
  return false;
}

const findings = [];

// 形态 A：三元 props，两个分支都不可用。
// 只匹配单行、无嵌套三元的简单形态——复杂表达式交给人读，不做启发式猜测。
const ternaryProps = [...source.matchAll(
  /^\s*([a-zA-Z][\w]*)=\{([^{}?]+)\?([^{}:?]+):([^{}?]+)\}\s*$/gm
)];
for (const match of ternaryProps) {
  const [, prop, , left, right] = match;
  if (!isUnusable(left) || !isUnusable(right)) continue;
  const line = source.slice(0, match.index).split('\n').length;
  if (prop in RULED) continue;
  findings.push({
    code: 'RENDERER_PROP_UNREACHABLE_BOTH_BRANCHES',
    prop,
    line,
    message: `${prop} 的三元表达式两个分支都是不可用值（${left.trim()} / ${right.trim()}）。`
      + ' 无论走哪支，接收该 prop 的面板都拿不到数据，功能对用户不可达。'
      + ' 请接线，或在 RULED 里登记依据与解除条件。'
  });
}

// 形态 B：恒定传字面空值。
const constProps = [...source.matchAll(/^\s*([a-zA-Z][\w]*)=\{(null|\[\s*\])\}\s*$/gm)];
for (const match of constProps) {
  const [, prop, value] = match;
  if (prop in RULED) continue;
  const line = source.slice(0, match.index).split('\n').length;
  findings.push({
    code: 'RENDERER_PROP_CONSTANT_EMPTY',
    prop,
    line,
    message: `${prop} 恒定传 ${value.trim()}，接收方永远拿不到数据。`
  });
}

// 判据 2：登记表必须随接线收缩。已不存在的 prop 留在 RULED 里就是幽灵条目，
// 会让「已知断点」清单永久失真。
for (const prop of Object.keys(RULED)) {
  const stillTernary = ternaryProps.some((m) => m[1] === prop
    && isUnusable(m[3]) && isUnusable(m[4]));
  const stillConst = constProps.some((m) => m[1] === prop);
  if (!stillTernary && !stillConst) {
    findings.push({
      code: 'RENDERER_RULING_STALE',
      prop,
      message: `${prop} 已不再是「两分支都不可用」，但仍登记在 RULED 里。`
        + ' 登记表必须随接线收缩——留着它等于给一个已修好的项永久豁免。'
    });
  }
}

// 判据 3：每条裁定必须写理由。
for (const [prop, reason] of Object.entries(RULED)) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    findings.push({
      code: 'RENDERER_RULING_REASON_MISSING',
      prop,
      message: `${prop} 的裁定没有写理由；没有依据的条目等于「先放着」。`
    });
  }
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'RENDERER_REACHABILITY_VIOLATION',
    message: 'renderer 存在功能入口在所有分支下都不可达，且未登记裁定依据。',
    scannedTernaryProps: ternaryProps.length,
    emptyConstants: [...emptyConstNames],
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: 'renderer 无未登记的「所有分支都不可达」功能入口。',
  scannedTernaryProps: ternaryProps.length,
  emptyConstants: [...emptyConstNames],
  ruledKnownBreakpoints: Object.keys(RULED),
  nonClaim: '本门禁只做单行、无嵌套三元的静态判定，不做类型推断、不跨文件追踪'
    + '数据流、不猜运行时值——宁可漏报也不误报。它不声明已登记断点对用户可用，'
    + '也不替代 test:preload-surface-ruling（那条守 preload 边界）。'
}, 0);

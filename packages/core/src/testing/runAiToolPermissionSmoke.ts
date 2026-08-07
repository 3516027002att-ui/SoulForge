/**
 * AI 工具权限阶梯的**生产**路径验证。
 *
 * 为什么必须单独有这条：runAiConformanceSmoke 里有 5 个 case 断言的是
 * testing/harness 下的 evaluatePolicyGate / maxPermissionFromMode /
 * executeToolThroughPolicy —— 那三个符号全仓**只存在于 testing 目录**，是测试
 * 装置自建的权限阶梯。生产判定走的是另一套：ai/toolPermissions.ts 的
 * isAiToolPermissionAllowed，由 ai/toolRegistry.ts:127 在每次 run 时调用。
 *
 * 后果是「AI 不得抬高授权」这条安全边界在生产实现上几乎没有断言：改坏
 * maxPermissionForMode（例如让 plan 模式返回 rollback），conformance 的 58 个
 * case 照样全绿，因为它们断言的是 harness 自己的阶梯。
 *
 * 本文件只断言生产符号：权限秩序、每个模式的上限、以及 ToolRegistry.run 真的
 * 会以 TOOL_PERMISSION_DENIED 拦住越权工具。
 *
 * Authority: unit —— 纯逻辑，无 Bridge / 无真机语料。它不声明 AI 能力，
 * 只声明权限判定按登记的阶梯执行。
 */
import {
  AI_TOOL_PERMISSION_ORDER,
  isAiToolPermissionAllowed,
  legacyPermissionToLevel,
  maxPermissionForMode
} from '../ai/toolPermissions.js';
import { ToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import type { AiToolPermissionLevel } from '@soulforge/shared';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

/* ---- 1. 阶梯本身 -------------------------------------------------------- */

check(
  'ladder/order-is-ascending-and-complete',
  AI_TOOL_PERMISSION_ORDER.length === 7
    && AI_TOOL_PERMISSION_ORDER[0] === 'read'
    && AI_TOOL_PERMISSION_ORDER[6] === 'rollback',
  `实测 ${JSON.stringify(AI_TOOL_PERMISSION_ORDER)}`
);

// 阶梯必须严格单调：低秩允许时高秩不得也被允许（否则「上限」失去意义）。
for (const mode of ['plan', 'normal', 'fullPermission'] as const) {
  const allowed = AI_TOOL_PERMISSION_ORDER.filter((level) => isAiToolPermissionAllowed(level, mode));
  const denied = AI_TOOL_PERMISSION_ORDER.filter((level) => !isAiToolPermissionAllowed(level, mode));
  // 允许集必须是阶梯的前缀：出现「允许 commit 但拒绝 stage」这种空洞，说明
  // 秩序表与判定函数已分叉。
  const expectedPrefix = AI_TOOL_PERMISSION_ORDER.slice(0, allowed.length);
  check(
    `ladder/allowed-is-prefix/${mode}`,
    allowed.every((level, index) => level === expectedPrefix[index]),
    `allowed=${JSON.stringify(allowed)} denied=${JSON.stringify(denied)}`
  );
}

/* ---- 2. 每个模式的上限（这是「不得抬高授权」的具体判据）----------------- */

const MODE_CEILINGS: ReadonlyArray<readonly [
  'plan' | 'normal' | 'fullPermission',
  AiToolPermissionLevel
]> = [
  ['plan', 'validate'],
  ['normal', 'validate'],
  ['fullPermission', 'rollback']
];

for (const [mode, ceiling] of MODE_CEILINGS) {
  check(
    `ceiling/${mode}`,
    maxPermissionForMode(mode) === ceiling,
    `期望 ${ceiling}，实测 ${maxPermissionForMode(mode)}`
  );
}

// plan 与 normal 都不得允许 commit / rollback —— 这两级只能由 fullPermission
// 打开，而即便打开也不能绕过 Patch Engine（硬约束 11，本文件不覆盖那一条）。
for (const mode of ['plan', 'normal'] as const) {
  for (const level of ['commit', 'rollback'] as const) {
    check(
      `ceiling/${mode}-denies-${level}`,
      !isAiToolPermissionAllowed(level, mode),
      `${mode} 模式不得允许 ${level}`
    );
  }
}
// fullPermission 必须允许全部级别，否则「完全权限」名不副实。
for (const level of AI_TOOL_PERMISSION_ORDER) {
  check(
    `ceiling/fullPermission-allows-${level}`,
    isAiToolPermissionAllowed(level, 'fullPermission'),
    `fullPermission 应允许 ${level}`
  );
}

/* ---- 3. legacy 标签映射 -------------------------------------------------- */

for (const [legacy, expected] of [
  ['read', 'read'],
  ['plan', 'propose'],
  ['write', 'commit']
] as const) {
  check(
    `legacy/${legacy}`,
    legacyPermissionToLevel(legacy) === expected,
    `期望 ${expected}，实测 ${legacyPermissionToLevel(legacy)}`
  );
}

/* ---- 4. ToolRegistry.run 真的会拦住越权工具 ------------------------------
 * 前面三节断言的是纯函数；这一节断言**执行路径**真的调用了它们。判据分开写的
 * 理由：判定函数正确但 run 忘记调用它，是最典型的「安全层写了但没接上」形态。
 */

function contextFor(mode: ToolContext['mode']): ToolContext {
  return { mode } as ToolContext;
}

async function verifyRegistryGate(): Promise<void> {
  const registry = new ToolRegistry();
  let commitToolRan = false;
  // inputSchema 省略：ToolInputShape 是「字段名 -> 类型串」的简单契约，不是
  // JSON Schema。这里要测的是权限门，不是输入校验，空契约让输入校验直接放行。
  registry.register({
    name: 'test_commit_tool',
    description: 'Commit-level tool used to verify the registry permission gate.',
    permission: 'write',
    permissionLevel: 'commit',
    run: async () => {
      commitToolRan = true;
      return { ok: true, data: null };
    }
  });

  // plan 模式：必须被拒，且**不得执行工具体**。只断言返回码不够——工具已经跑过
  // 再报错，副作用已经发生。
  const denied = await registry.run('test_commit_tool', {}, contextFor('plan'));
  check(
    'registry/denies-commit-in-plan',
    denied.ok === false && denied.error?.code === 'TOOL_PERMISSION_DENIED',
    `实测 ${JSON.stringify(denied)}`
  );
  check('registry/tool-body-not-executed-when-denied', commitToolRan === false);

  // fullPermission 模式：同一工具必须放行（否则上面的「被拒」可能只是因为
  // 一切都被拒绝）。
  const allowed = await registry.run('test_commit_tool', {}, contextFor('fullPermission'));
  check(
    'registry/allows-commit-in-fullPermission',
    allowed.ok === true && commitToolRan,
    `实测 ${JSON.stringify(allowed)} commitToolRan=${commitToolRan}`
  );

  // 未注册工具必须报 TOOL_NOT_FOUND，而不是被权限层吞掉。
  const missing = await registry.run('no_such_tool', {}, contextFor('fullPermission'));
  check(
    'registry/unknown-tool-reports-not-found',
    missing.ok === false && missing.error?.code === 'TOOL_NOT_FOUND',
    `实测 ${JSON.stringify(missing)}`
  );
}

await verifyRegistryGate();

/* ---- 输出 ---------------------------------------------------------------- */

const ok = failures.length === 0;
console.log(JSON.stringify({
  ok,
  smoke: 'ai-tool-permission',
  message: ok
    ? 'AI 工具权限阶梯（生产实现）全部断言通过'
    : `${failures.length} 条断言失败`,
  checks,
  coveredProductionSymbols: [
    'ai/toolPermissions.ts: AI_TOOL_PERMISSION_ORDER / maxPermissionForMode / isAiToolPermissionAllowed / legacyPermissionToLevel',
    'ai/toolRegistry.ts: ToolRegistry.run 的 TOOL_PERMISSION_DENIED 与 TOOL_NOT_FOUND 分支'
  ],
  nonClaim: '本 smoke 只验证权限判定与注册表拦截，不验证任何 AI 能力，也不声明'
    + '完全权限可绕过 Patch Engine（硬约束 11 由写入链路的门禁负责）。'
    + '它也不覆盖 testing/harness 下那套自建权限阶梯——那是测试装置，不是生产。',
  ...(ok ? {} : { failures })
}, null, 2));
if (!ok) process.exit(1);

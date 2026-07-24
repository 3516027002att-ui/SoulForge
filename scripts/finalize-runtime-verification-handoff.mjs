import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../docs/V0_5_IMPLEMENTATION_HANDOFF.md', import.meta.url);
let text = await readFile(path, 'utf8');

function replaceOnce(from, to, label) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  text = text.replace(from, to);
}

replaceOnce(
  '> 当前仓库基线：PR #8 implementation candidate `698ef78`；任何接手者都必须以真实 `HEAD`、工作树和测试结果重新核对。  ',
  '> 当前仓库基线：PR #8 runtime verification candidate `7b91310`；Windows CI run 97 全绿；任何接手者都必须以真实 `HEAD`、工作树和测试结果重新核对。  ',
  'baseline'
);

replaceOnce(
  '- 显式支持 manual、`post_commit` 和 `post_rollback` 三种 verification kind；后两者会校验持久 Patch operation 状态及 inverse relation；\n- 零退出码只表示 me3 进程正常退出，不冒充 Sekiro 已加载 Mod，也不自动提升 runtime authority。',
  '- 显式支持 manual、`post_commit` 和 `post_rollback` 三种 verification kind；后两者会校验持久 Patch operation 状态及 inverse relation；\n- `workspace.db` 的 append-only `runtime_verification_evidence` 保存人工观察；evidence id、workspace 和时间由 main 生成，renderer 只能提交有限 verdict 与备注；\n- 进程证据与人工 attestation 分层：零退出码仍是 `process_only + unverified`，`gameLoadAutomaticallyVerified` 始终为 false；\n- verdict 使用上下文无关的“预期状态已观察 / 未观察”语义，post-commit 期望提交变化出现，post-rollback 期望原状态恢复；\n- operation 级汇总把正向会话和回滚会话串成状态链，可区分 forward failed、rollback unverified、`rollback_confirmed_restored` 与 evidence conflict；\n- 机器事实与人工证据冲突会显式标记，例如进程未能启动却声称观察到预期状态；\n- 零退出码只表示 me3 进程正常退出，不冒充 Sekiro 已加载 Mod，也不自动提升 runtime authority。',
  'runtime evidence bullets'
);

replaceOnce(
  '- 游戏内 Mod 加载成功判定、崩溃转储和真实故障诊断；',
  '- 独立 game-aware 自动加载判定、崩溃转储和真实故障诊断；人工 attestation 已可持久化，但不属于 native/game authority；',
  'remaining game-aware gate'
);

replaceOnce(
  '| H me3 运行 | `partial / runtime unverified` | 真实 me3/Sekiro、游戏内加载判定、崩溃证据、产品级自动编排 |',
  '| H me3 运行 | `partial / runtime unverified` | 真实 me3/Sekiro、独立 game-aware 判定、崩溃证据、前端运行面板 |',
  'frontier row'
);

replaceOnce(
  '| runtime | me3 adapter、session manager、operation-linked verification、可信配置与持久会话 |',
  '| runtime | me3 adapter、session manager、append-only verification evidence、正向/回滚 operation 汇总、可信配置与持久会话 |',
  'core map'
);

replaceOnce(
  '- 独立 runtime IPC、原生 me3 选择、workspace-switch 会话终止与 path-free preload contract；',
  '- 独立 runtime IPC、原生 me3 选择、workspace-switch 会话终止、operator attestation 与 path-free preload contract；',
  'desktop map'
);

replaceOnce(
  'npm run test:runtime-session-manager\nnpm run test:database-utility',
  'npm run test:runtime-session-manager\nnpm run test:runtime-verification-evidence\nnpm run test:database-utility',
  'runtime commands'
);

replaceOnce(
  '- 已验证：公开 fake process smoke 覆盖 me3 0.11.0 identity、错误 executable 拒绝、profile source 字段、启动/终止和路径边界；最终 Windows CI 结果待本次候选更新。',
  '- 已验证：公开 fake process smoke 覆盖 me3 0.11.0 identity、错误 executable 拒绝、profile source 字段、启动/终止和路径边界；Windows CI run 64 在 `72b630e` 全绿。',
  'me3 hardening evidence'
);

replaceOnce(
  '### 2026-07-24：me3 desktop runtime、持久会话与 operation-linked 编排',
  `### 2026-07-24：运行验证证据与正向—回滚 operation 状态链

- 起始：\`72b630e\`
- 实现候选：\`7b91310\`
- 路线：A / H-me3 / H-发行
- 状态变化：维持 \`partial / runtime unverified\`；从“只有进程会话”推进为“机器过程证据 + append-only 人工观察 + operation 级回滚验证链”。
- 已实现：\`runtime_verification_evidence\` migration/repository/utility RPC；main 生成 evidence id、workspace 与时间；renderer-safe evidence/summary DTO；session 与 operation 查询 IPC/preload contract。
- 已实现：manual / post-commit / post-rollback 各自拥有明确 expectation；正向失败与回滚恢复可汇总为 \`rollback_confirmed_restored\`；无 session operation 仍保留 workspace identity；进程启动失败与“已观察预期状态”的矛盾会标记 evidence conflict。
- 已验证：Windows CI run 84 在 \`a367725\` 验证 append-only evidence、utility restart persistence、安全门和 build；Windows CI run 97 在 \`7b91310\` 验证 operation-aware verdict、正向/回滚汇总、workspace identity、冲突检测、IPC/preload 接线和全量回归。
- 样本范围：fake runtime session、临时 SQLite、人工 evidence fixture；未使用真实游戏资产、真实 me3 或 Sekiro。
- 未验证：真实操作员在游戏内确认、自动 game-aware probe、崩溃转储、真实提交后加载与回滚后恢复。
- 非声明：operator attestation 只证明用户记录了观察结果；即使结论为 \`rollback_confirmed_restored\`，也不会自动提升为 native/game authority。

### 2026-07-24：me3 desktop runtime、持久会话与 operation-linked 编排`,
  'verification evidence record'
);

await writeFile(path, text, 'utf8');

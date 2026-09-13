# 治理数据（机器可读权威）

本目录是 SoulForge 发布治理的**唯一机器可读权威**。门禁只读这里，不再对
历史交接书做正则解析。

## 权威归属

| 文件 | 权威内容 | 迁移来源 |
| --- | --- | --- |
| `releases.json` | 发布版本注册与冻结状态；`frozenFields` 定义发布审计的物理拦截范围 | 新建 |
| `scope.json` | 范围裁定矩阵、用户批准记录、各项政策 | §18.2.1 冻结 JSON |
| `gates.json` | Gate 的 `gateState`/`applicability`/引用/后继要求 | §18.1 + §18.3 + `scope.gateCoverage` |
| `slices.json` | 切片的 `lifecycle`/`authority`/`authorityCap`/入口/验证；`activeClaims` 并发占用 | §13.1 + §13.1.1 |
| `validation.json` | 已冻结验证四元组与显式未冻结清单 | §13.4 |
| `blockers.json` | 阻塞项、所需输入、解锁验证、复检触发 | §18.4 |
| `evidence.jsonl` | 仅由 `gov seal` 追加的证据权威；同一次操作更新 Gate 引用与交接书投影 | §17.1 |
| `schema/*.schema.json` | draft-07，全部 `additionalProperties: false` | 新建 |

交接书中的对应章节改为由这些文件**投影生成**，不再是权威。人工编辑交接书的治理章节
不会改变门禁判定，只会被下一次生成覆盖。

数量与状态不要从本说明或旧交接段落推算：`node scripts/gov.mjs status` 返回当前执行面板及 freshness，`next` 返回可开发切片，`help` 返回当次合法更新流程。入口链接见[根 README](../../README.md)。

当前源码实现、未封存的本地测试和封存证据是三种不同事实：有实现不能自动提升 `authority`，本地 PASS 不能替代 `sealed-current-run`，`lifecycle=completed` 也不表示整个能力域或版本完成。文档同步不得顺带把 stale Gate 改绿。

## 开发与发布的边界

开发流程按切片的 `lifecycle`、`capabilityIds`、`authorityCap` 和实际前置推进，
不读取 `currentRelease` 作为默认筛选条件。`node scripts/gov.mjs next` 默认展示
全部可开发切片；只有显式传入 `--release <Release>` 时才查看某个发布归属。

版本号仍保留在发布记录、历史范围和发布 Evidence 中，用于审计和回溯；它不是开发
权限、实现范围或验证预算。未绑定发布的开发 Evidence 允许 `targetRelease=null`。

“V1 收尾”等任务目标不自动创建发布记录或改变既有裁定。用户免除某项验收，应按 schema 把免验范围与用户裁定登记清楚；免验不等于测试通过，也不应从仍保留的历史切片反推用户必须再提供该项输入。涉及冻结字段时仍走下面的裁定与证据流程。

## 跨版本设计

范围条目不按版本拆文件，`scope.json` 用字段区分：

- `targetRelease`：条目最初归属的版本；
- `deferredToRelease`：非空表示已裁定延期，此时 `operations` 必须为空
  （否则等于宣称延期能力仍在本版可用）；
- `deferredTrack`：延期后归属的技术线；
- `resumeRequires`：恢复该条目的强制前置顺序，schema 要求非空。

`releases.json` 的 `frozenFields` **只包含用户裁定字段**。工程进度字段
（`gates[].gateState`、`slices[].lifecycle`、`slices[].authority`、evidence 追加）
不在冻结范围内；发布冻结不等于停止开发。

## 修改约束

`slices.json.requiredValidation` 可使用 `{ suiteId, args?, env?, manualChecks?, notes? }`，或以 `steps` 数组表达有序的多个自动步骤。`suiteId` 直接引用根 `package.json` 的脚本名，治理校验会拒绝不存在的引用；人工检查不转换为 shell 命令。当前可开发切片优先采用结构化形式，历史字符串保持可读。`node scripts/verify.mjs --slice <sliceId> --list` 可查看计划，不执行测试或人工验收。

1. 改数据前先读对应 schema。schema 是 `additionalProperties: false`，加字段必须同步改 schema。
2. `releases.json` 中 `frozen: true` 的版本，其 `frozenFields` 列出的字段由门禁物理拦截；
   需要变更必须先有新的用户裁定并登记 `scope-ruling:user-approved` 证据。
3. 用 `node scripts/gov.mjs seal` 追加 `evidence.jsonl`，不得手写或改写既有行；封存本身不执行验证、不提升 authority。只有符合 Gate 条件且 freshness 有效的 `sealed-current-run` 能支持完成声明。
4. `authority` 与 `lifecycle` 的枚举以 [slices schema](schema/slices.schema.json) 为准，说明见交接书；
   `unsupported`/`candidate`/`fixture-confirmed`/`partial`/`native-verified`/`blocked`/`unverified`
   必须严格区分，不得因为门禁通过而升级。

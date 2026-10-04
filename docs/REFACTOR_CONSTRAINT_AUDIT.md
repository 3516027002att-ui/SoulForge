# 2026-10-04 一次性重构约束核验表

本表是 #49 的交付快照，不是新的登记门禁、日常全仓启动条件或自动关闭 issue 的依据。比较基线为 main `c4a8b158`，继承 PR #56 的 `88dfa437`；实现、最终验收、进入 main 分别记录。#54 保持延期。

## 约束、实际检查与负向证据

“通过”只覆盖对应检查的实际断言。`passed / failed / unavailable / not_run` 不互换；环境缺失、合成测试、静态可达和模型自述均不能替代真实运行。最终结果见同目录的收尾报告及其命令回执。

| 必要约束 | 源码执行边界 | 检查及运行位置 | 负向检查所破坏的条件 | 分类及保留理由 |
|---|---|---|---|---|
| 自动发现检查，不因旧登记缺失阻断其他检查 | `scripts/check.mjs`、`scripts/verify/checkRegistry.mjs` | `node --test scripts/check.fixture.mjs`；本地、Windows CI | 未登记 test、前段失败、aggregate 尾部未执行、required 被 filter/exclude 隐藏 | 保留实际 runner 检查；退役人工 tiers 登记 |
| 四态报告，未执行不算通过 | `scripts/verify/runner.mjs` | check fixture 与 `scripts/verify-scheduling-fixtures.mjs` | missing build、空 required tier、timeout、子进程失败 | 产品验收可信度约束 |
| #49 推翻硬行数预算与禁增测试 | `AGENTS.md`、`docs/DECISIONS.md` | 文档/Issue 人工核对 | 不再把新 scoped regression 当违规 | 退役旧 #38 前提，不假称满足旧文字 |
| 原生输入固定版本、长度、哈希、独立期望 | `nativeFixtureRegistry.ts`、corpus manifest | `nativeFixtureRegistry.test.ts` 与五个真实 native 套件 | hash/size 漂移、缺 corpus、伪正确计数 | 保留；缺资源报 unavailable |
| 明确隔离失败必须拒绝，不打开用户库 | `workspaceStorage.ts` | `scripts/workspace-storage.test.mjs`；本地/CI | 不能创建显式隔离根、普通存储不应出现 | 保留安全负例 |
| 桌面 smoke 不覆写生产构建/native ABI | `desktop-test-build.mjs`、vite config | `desktop-test-build.test.mjs`；真实数据库 utility smoke | 独立 root、native 版本不符、构建篡改快照、输出异常 | 保留；绑定产物前后 hash |
| Windows 子进程环境隔离仍能启动构建 | `windows-command-environment.mjs` | 对真实 cmd.exe 的超长 PATH 红/绿对照 | 重复键、无效目录、PATH 被 cmd 丢弃 | 本轮新增具体失败回归，不修改系统 PATH |
| PowerShell 不向仓库根泄漏模块缓存 | `desktop-test-build.mjs` | actual PowerShell 子进程测试 | 隔离 profile 的特殊目录为空 | 本轮发现、指定 owned cache 路径 |
| 临时目录只回收本人已死亡的进程残留 | `owned-temporary-directory.mjs`、Bridge build ownership | owned temporary 与 bridge ownership 测试 | 活跃 owner、外来文件、链接、未知归属、半成品 | 保留；不恢复旧残留总量门禁 |
| HKSC 编译 `.obj` 不进入仓库根 | `build-first-party-hksc-native.mjs` | native build、ownership 测试 | 显式 `/Fo`、短 owned cwd、取消后 owner 处置 | 保留真实构建；不能只看静态字符串 |
| 桌面与 CLI 使用同一可信 Agent 装配 | `agentRunAssembly.ts`、`agentHostComposition.ts` | composition/shared-entry/utility fixtures | renderer 伪造 authority、换工作区、延迟回执 | 保留共享权限边界 |
| 请求超时与整次运行时限分离 | composition、`finiteAgentAdapter.ts`、`packages/agent` | `agent-run-budget.fixture.mjs`、kernel tests | 5ms 请求配置不得覆盖 500ms run；独立总时限中止 | 本轮修复；默认 180 秒/30 分钟/200 步 |
| 金额模式可选，未知 usage 不记零 | kernel、`AgentBudgetControls.tsx` | kernel/预算 UI/reducer fixtures | 缺价格、非法额度、usage 缺失、跨服务预算重置 | 保留；CLI 原有显式参数语义不变 |
| 取消/断连/超时不能抹去已提交事实 | `LocalSessionHost`、事务 journal、utility RPC | host/utility/approval/receipt fixtures | commit 前后取消、worker 退出、重复请求、unknown | 保留；unknown 先按 opId 查询，禁止重放 |
| 自动 native proof，Patch 是唯一写入口 | CoreToolSession、ToolRegistry、editing、Patch Engine | proof/CAS/TAE identity tests | 缺 proof、过期 hash、错误模板、版本冲突 | 必要产品约束，不用模型台账替代 |
| 脱敏只改记录，不篡改实际工具参数 | host adapter 与模型 wire | tool source/redaction fixtures | 含敏感形似字符串的真实参数 | 保留双通路证据 |
| TAE 搜索不得全量命中后截断 | `taeActionSearch.ts`、`boundedContentSearchPage.ts` | `taeActionPaging.test.ts`、动作 group smoke | legacy 全量入口抛错、缩窗续页、同对象原地漂移 | 本轮替换；扫描全索引但只保留有界候选 |
| TAE 原生 ID、插入、回滚保持相邻动作 | `TaeNativeDocument.cs`、`taeEdit.ts` | `scripts/tae-identity.fixture.mjs`、`tae-container-hash.fixture.mjs` 真实 Bridge | 首尾 ID、错 selector、只改目标字节、模板 hash、回滚、提交后原生回读失败仍保留 opId | 数量与结果以最终命令回执为准；不外推 #54 |
| 数据库一致性备份与中断恢复 | `sqliteDatabase.ts`、`sqliteLegacyKnowledge.ts` | storage tests、真实 utility smoke、副本验收脚本 | 失败清临时备份、迁移中断、失配 hash、历史 v14 非空知识快照与冲突快照 | 保留；真实用户库仅副本实验；历史结构变化必须转换数据，不能仅改 checksum |
| 独立读连接与超时后写状态回查 | database utility/service | `database-utility-concurrency.test.mjs`、utility smoke | 长写阻塞、timeout 但提交已发生、重复 operation | 保留；不能以超时判未提交 |
| 64 MiB 原生边界，大资源只读解包缓存 | DcxPayloadProbe、read cache | cache/Bridge infrastructure tests | 源或配置漂移、取消、失败、半成品、repack | 保留；WitchyBND 真实工具与四资源另验 |
| Bridge 单一声明与真实命令分派 | commands JSON、generated TS/C#、dispatch verification | C# dispatch tests、generation check | 仅描述而没有 Service 分支 | 保留；探针不证明格式行为 |
| Doctor 单独 net10、自包含边界 | Doctor project、packaging | Doctor build/runtime、洁净机验收 | 找不到框架/依赖 | 编译和无 .NET 洁净 Windows 分开 |
| 原生读失败、合法空网格、资源缺失分开 | FLVER validation、MAP scheduler | FLVER report、map progress/timeout tests | parse failed、zero mesh、重复 cursor、不完整末页 | 保留；终止诊断不代表 #55 根因修复 |
| 不在缺真实双后端基线时切 WebGPU 默认 | detection、renderer backend、diffuse blend | detector/离线 WGSL + 真实双后端画面 | adapter.info 异常、第二层缺失、不同 UV | 默认仍 WebGL2；离线测试不等于 GPU |
| MAP 回归上限不等于流畅 | map verifier、request timeline | 260s/400ms 功能+响应性联合判定 | 资源未全载入、超过预算、长帧 | 单独记录 smoothInteractionPass |
| 真实安装更新检查不能为 CI 变绿而删除 | windows-ci、owned installers、update suite | `test:update:installed`、`test:update:all` | 缺 manifest、身份/版本/hash 不匹配 | 本轮补真实随机身份 A/B 输入；不证明官方自动更新 |
| 许可证引用必须落到实际文件 | NOTICE、licenses | license/reference 检查、人工审查 | 目标文件缺失 | #46 局部修正，不等于整个发行法律审计 |
| 不改原始资源、不擅自发布/合并/清理 | workspace write roots、本任务操作范围 | git status、输入输出 hash、只读原库 | 输出越界、原始输入变化 | 保留人工权限判断，不新增行数/提交比例门禁 |

## 旧登记与新发现集合的核对方法

```powershell
node scripts/check.mjs --list --tier all --json-out .local-validation/closeout/check-discovery.json
node scripts/testing/check-migration-inventory.mjs D:/Repository/SoulForge .local-validation/closeout/check-migration.json
```

该快照逐项列出旧登记名、入口、新发现候选和实际命令。标记 `requires-semantic-mapping` 的条目不能自动认定被覆盖或可删除。旧 main 完整运行集合尚无同环境成功证据，因此**不声称新旧实际执行集合已证明等价**。当前运行结果必须读 `check` 报告的每个 step；根 `npm test` 的 `&&` 在失败后留下的尾项仍是未运行，不能由静态可达推断通过。

历史 handoff/Flash/证据文件是背景，不重新取得 claim、seal、freshness 的执行权。救援 bundle、未知归属 Microsoft 目录、未合并分支保留。当前工作树内新复现的 PowerShell 缓存须按精确文件与创建证据处理，不授权清理原候选同名目录。

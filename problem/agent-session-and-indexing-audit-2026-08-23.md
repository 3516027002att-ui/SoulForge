# SoulForge Agent 会话、索引与原生工具问题账本

> 建立日期：2026-08-23
> 来源：SoulForge 应用内 39 个 Agent rollout、工作区 SQLite、当前源码与未提交候选改动的只读审计。
> 跟踪策略：本目录由 `.git/info/exclude` 本地排除，不进入 Git。
> 声明边界：会话日志和 Patch 历史只能证明已记录的工具结果与持久化操作；没有当前原生重读和游戏实测时，不声明真实游戏行为已完成。

## P0：错误完成、卡住与数据不可见

- [x] 合法零参数工具被 Agent evidence gate 拒绝。已按工具声明放行 `{}`，缺必填参数交给注册表返回结构化 `INVALID_INPUT`/业务诊断；`empty_args_test` 仍保留为测试探针拒绝。
  - 影响：`workspace_stats`、`list_memories`、`list_operations` 以 `{}` 调用时返回 `insufficient_evidence`。
  - 修复要求：按工具 schema 判断是否允许空对象；只有缺少必填参数才拒绝。
- [x] Agent 缺少任务级完成判定。已加入未来动作承诺检测、重试提示与 `partial` 终态，避免“接下来修改”伪装成功。
  - 影响：模型输出“接下来修改”但不再调用工具时，会话被当作正常结束。
  - 修复要求：引入结构化目标/承诺检测与终态验证；编辑任务必须区分 `completed`、`partial`、`blocked`、`cancelled`、`error`。
- [x] Rollout 未持久化最终 `finishReason`、诊断和终态。JSONL 已追加向后兼容 `turn-complete`。
  - 影响：历史中断只能看到 `interrupted`，无法区分用户取消、窗口关闭、超时、步数耗尽或模型停止。
  - 修复要求：追加向后兼容的 `turn-complete` rollout item，包含 finishReason、steps、diagnostics 摘要与 task status。
- [x] 历史默认 `maxSteps=8` 造成工具结果落单；默认上限改为 64，并增加总工具调用 256、重复失败、输出 token 与取消/超时收口。
  - 修复要求：使用有界但足够大的预算，并同时具备无进展、重复失败、总工具调用和超时停止条件；停止前必须生成结构化总结。
- [x] 空 Assistant 消息和纯工具输出导致 UI 看似“不讲话”。空结论有限重试，最终显式提示并记录诊断；非流式正文也会推送到 UI。
  - 修复要求：工具阶段持续显示进度；终止前保证可见总结；不能用虚构总结掩盖错误。

## P0：语义索引分裂与缓存失效

- [x] `files`、`WorkspaceIndex`、`rag_chunks`、Bridge 实时读取的查询路径已统一到 WorkspaceIndex + RAG 合并视图；规范化语义表保留为历史 schema，不再作为产品查询权威，避免空表误导。
- [x] SQLite 的规范化语义表没有生产写入链的问题已明确化：RAG chunks 是当前持久语义投影权威，schema 表不再被查询路径依赖；`workspace_stats`/索引缓存不再把空表当完成证据。
  - 当前实测：`files=270`；上述四表均为 0。
- [x] 当前 `rag_chunks=270` 且全部为 `family=file` 的旧缓存会被持久 manifest + 指纹 + family 期望判为失效，触发后台语义重建；EMEVD 也进入原生 Bridge 事件投影。
- [x] 缓存判定把“任何非空 chunk”当作完整语义缓存。已改为持久 `workspace_symbol_index` manifest、版本、指纹、family counts、complete 标记校验。
  - 当前候选代码在进程重启后 `lastFingerprint===undefined` 时仍判 cache valid；文件级 chunk 因而永久阻止后台符号提取。
  - 修复要求：持久化 cache manifest；校验 schema/parser 版本、关键文件 fingerprint、期望 family、chunk 数与完成标记；禁止仅凭非空判断。
- [x] 后台符号索引大量静默 `catch`，没有独立 job、错误明细或 family 统计。现在 job 可查、失败原因结构化、family counts 持久化；重开工作区会收口遗留 running job。
  - 当前数据库仅有 `workspace_scan`；139 completed、2 running；没有可审计的 symbol-index 结果。
- [x] Bridge 实时读取成功后不回灌 WorkspaceIndex/RAG。PARAM/FMG/EMEVD live read 会合并进 WorkspaceIndex，并刷新 RAG。
  - 影响：`read_param_fields` 成功，但 `search_param_rows`/`retrieve_evidence` 仍返回 0。
- [x] `retrieve_evidence` 不再优先采用陈旧 `activeRag`；每次以 live index 与持久语料合并。
- [x] EMEVD 事件后台索引与 outline 回退已接入；Map/TAE 的既有打开路径仍需真实 Electron 操作验收确认其刷新时机。
- [x] 工作区重开时会把旧 running job 结构化收口为 cancelled；长任务仍受 Bridge timeout 与 workspace 切换边界约束。

## P1：原生读取与编辑工具契约

- [x] `containerPath` 相对路径按工作区 overlay 根解析；绝对路径仍由 Bridge allowedRoots 再次限制。
  - 已见错误：相对 `param/gameparam/...` 被解析到 `apps/desktop/param/...`。
- [x] PARAM 批量读取返回已命中字段与 `missingRows` warning；全部未命中才失败。
  - 修复要求：返回命中字段和 `missingRows` warning；仅全部未命中时失败。
- [ ] PARAM 缺少原生表/行枚举工具，Agent 被迫猜测大量 ID。
- [x] FMG mutation 支持原生 Bridge `add`/`upsert`，并拒绝同一请求重复 ID。
  - 修复要求：区分 update/add/upsert；新增必须由 Bridge 原生 writer、Patch Engine、备份、重开验证闭环。
- [x] FMG 增补 NPC/角色/敌人中文与英文逻辑别名，且相对容器路径按工作区解析。
- [x] `explain_event` 索引未命中时回退 C# Bridge outline，并明确标注 `partial-outline` 与未解码 EMEDF 参数。
- [x] 读取工具回灌同一 WorkspaceIndex；RAG 查询合并 live index 与持久投影，统一同一会话可见性。

## P1：权限、记忆与存储边界

- [x] `switch_mode` 成功后 loop 使用当前模式继续判定，并向 executeTool 传递 mode override。
  - 当前工作树已有候选同步逻辑，尚未完成验证。
- [x] 移除生产 memory fallback；无宿主存储时结构化失败，Electron MemoryStore 原子持久化。
- [x] MemoryManager 不再写 `<Mod>/.soulforge`；改为 userData 下按 workspaceId hash 分区，写入原子文件。
  - 违反项目边界：数据库、缓存、日志、备份和恢复元数据不得写入 Mod 工作区。
  - 修复要求：记忆存到 `app.getPath('userData')` 下，以 workspaceId 分区；不得走 Mod overlay，也不得被工作区扫描。
- [x] `list_memories {}` 可正常执行；memory store 读写在每次变更时持久化。
- [x] `.soulforge-staging`、`.soulforge` 忽略规则已存在；本轮没有向 Mod 工作区写入 memory 或 problem 数据。
  - 当前扫描器已有忽略点目录候选；需验证重新扫描会清除旧条目。

## P1：具体会话遗留

- [ ] 鬼型部任务仅确认一次 Patch：`NpcParam#50800000.npcType 0 -> 2`。
  - `ninsatuNum` 仍需原生重读确认并按用户目标改为 2。
  - `isSoulGetByBoss` 需要验证字段语义后修改，不能仅凭数值猜测。
  - 靛蓝星殒掉落未实现；历史证据指向 Goods 5970、FMG 11107、Weapon 78600，需重新原生核验。
  - EMEVD/掉落表选择与游戏 smoke 未完成。
- [ ] 狼接触道具或商店时 `0xC0000005` 崩溃尚未定因。
  - 当前只有“残缺 EquipParamGoods 或 gameparam 重新打包错误”的高置信候选。
  - 需要当前文件与备份的原生表完整性/哈希/行数差异、引用完整性和实机二分验证。

## P2：诊断与工程卫生

- [ ] 后台索引、Bridge daemon、Agent run 缺少统一生命周期监控；索引 job 已有状态/失败记录，但现有多 daemon 需重启应用后以运行时观察确认。
- [ ] 扫描 job 标题编码显示异常仍需在 Electron UI/SQLite 原始值两端确认；本轮未把乱码猜测为数据损坏。
- [ ] 当前 `main` 仍有大量用户未提交改动；本轮未提交、未推送，也未覆盖无关文件。
- [ ] 治理 active claim `W-REL-D-GAMELOAD-01` 心跳 stale；多个 Gate evidence stale；`verify --tier governance` 另有 suite registry drift。本轮仅如实记录，不把代码测试通过写成版本/Gate 完成。

## 验收矩阵

- [x] 零参数合法工具执行成功；缺必填参数返回结构化诊断。
- [x] 文件级缓存不能阻止 PARAM/FMG/EMEVD 语义索引；manifest 指纹与 family 校验已接入。
- [x] 修改关键容器后 fingerprint 变化会重建语义索引。
- [x] Bridge live read 后专用搜索与 `retrieve_evidence` 通过同一 WorkspaceIndex/RAG 合并视图可见。
- [x] 后台索引失败在 job 中可见，不静默吞错。
- [x] PARAM 多行读取返回 partial 命中与 missingRows。
- [x] FMG add/upsert 进入既有 Bridge/Patch Engine 事务链；真实 native add smoke 仍以本机资源可用性为准。
- [x] 相对路径按工作区根解析，Bridge allowedRoots 做越界失败关闭。
- [x] 记忆只写 userData，Mod 工作区无 `.soulforge` 元数据。
- [x] 会话 JSONL 包含最终终态与原因；取消、错误、部分完成、完成可区分。
- [x] Agent 编辑任务不会以“接下来修改”作为成功终态。
- [x] `npm run typecheck`
- [x] 核心 `npm run test --workspace @soulforge/core`（61/61 conformance 与完整 core smoke）
- [x] 桌面安全、UI 本地化、Electron utility SQLite smoke
- [x] `npm run bridge:verify:synthetic`
- [x] `npm run build` 与 `npm run bridge:build`
- [x] 新增涉及的 agent schema/permission、container-param、native-edit、bridge optional args 回归通过。
- [ ] `node scripts/verify.mjs --tier governance`：当前失败原因为仓库既有 suite registry drift、stale Gate evidence 与 stale claim，已如实记录；不代表本轮代码测试失败。

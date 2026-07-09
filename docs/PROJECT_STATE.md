# SoulForge 项目状态快照（Checkpoint）

生成时间：2026-07-09

## 一、项目本质

SoulForge 是一个 AI-native FromSoftware Mod 超级编辑器。

主定位已经裁定为：

```text
魂游 Mod 的 Cursor
```

核心不是 UI 壳，也不是传统表格工具，而是：

```text
语义 Bridge + 证据链 Parser + 引用图 + AI Agent + Patch Engine
```

目标是让用户和 AI 能在证据、计划、补丁、验证、备份、日志和回滚保护下编辑魂游 Mod。

## 二、当前权威文档

后续 agent 应优先阅读：

```text
docs/PRODUCT_VISION.md
docs/DECISIONS.md
docs/V0_5_MILESTONE.md
docs/V0_5_IMPLEMENTATION_FORKS.md
docs/V0_5_ARCHITECTURE_FORKS.md
docs/PROJECT_STATE.md
```

其中：

- `PRODUCT_VISION.md`：长期产品愿景；
- `DECISIONS.md`：用户已经裁定的产品分歧；
- `V0_5_MILESTONE.md`：v0.5 版本目标；
- `V0_5_IMPLEMENTATION_FORKS.md`：v0.5 实现路线分叉裁定；
- `V0_5_ARCHITECTURE_FORKS.md`：v0.5 架构级分叉裁定；
- `PROJECT_STATE.md`：当前工程状态快照。

## 三、核心资源范围

早期 parser 链路仍从：

```text
event -> map -> param -> msg
```

起步，但 v0.5 产品目标已经扩展为所有主要资源并重。

纳入目标的 ModEngine 风格目录：

```text
action
chr
event
map
menu
msg
obj
other
param
script
sfx
```

除图片 / 纹理类内容外，主要资源都应逐步做到可打开、可查看、可编辑。

## 四、用户打开对象

用户打开的是原生 ModEngine 覆盖目录。

SoulForge 内部建立虚拟资源树 / 语义资源图。

原版游戏目录可以作为只读 base，Mod 目录作为 overlay。所有写入目标必须是 Mod overlay。

## 五、当前技术栈

- Electron + React + TypeScript；
- C# SoulForge.Bridge；
- Node.js monorepo；
- SQLite + FTS5；
- 未来加入 reference graph、operation log、patch history；
- OpenAI-compatible + Anthropic-compatible provider；
- Patch Engine 作为唯一真实写入路径。

## 六、UI 方向

资源组织可以参考 Smithbox 的类型切换：工作区顶部提供 action / chr / event / map / menu / msg / obj / other / param / script / sfx 等入口。

视觉气质不能像 Smithbox 那样老旧、拥挤、压抑。

目标气质应接近 Codex / Cursor：

- 简洁；
- 优美；
- 流畅；
- 轻松；
- 现代；
- 低噪音。

前端 agent 必须优先遵守这一点。

## 七、AI 方向

AI 侧边栏是核心功能，不是锦上添花。

AI 行为参考 Codex / OpenCode 这类 coding agent：

```text
用户目标
  -> 工具调用收集证据
  -> 计划
  -> patch proposal
  -> 自检
  -> diff / patch graph review
  -> staging
  -> validation
  -> commit or rollback
```

思考强度应影响计划深度、工具预算、检索范围、自检强度和重试策略。

Full-permission mode 可以在策略门控通过后自动 commit，但绝不能绕过 Patch Engine。

## 八、Patch Engine 方向

Patch Engine 必须成为真实核心系统。

目标覆盖：

- text / FMG；
- param / paramdef / layout；
- event / EMEVD；
- map / MSB；
- Files mode raw edit；
- 后续扩展 action / chr / menu / obj / script / sfx。

任何写入都必须进入：

```text
patch proposal
  -> staging
  -> validation
  -> backup
  -> atomic replace
  -> re-index
  -> operation log
  -> rollback
```

Files mode 可以直接打开和编辑任意文件，但保存仍不能绕过 Patch Engine。

## 九、架构裁定摘要

v0.5 架构级目标已经裁定为 D 级为主：

- temporal property resource graph；
- stable resource / field URI；
- field / reference / diagnostic / patch provenance chain；
- multi-evidence confidence scoring；
- full parser pipeline：inspect、decompress、container、semantic、schema bind、reference、diagnostics、provenance；
- writer contract：input schema、precondition、write plan、staged output、post-validate、rollback metadata；
- graph patch IR；
- workspace transaction；
- versioned Bridge protocol；
- Bridge daemon + streaming + cancellation；
- AI tool permission levels；
- normalized evidence pack；
- full VFS；
- plugin sandbox target；
- schema-driven editor + patch binding。

详细见 `docs/V0_5_ARCHITECTURE_FORKS.md`。

## 十、诊断和置信度

诊断不是普通日志，而是安全编辑模型的一部分。

Diagnostics 同时驱动：

- UI 警告；
- AI prompt；
- Patch Engine gate；
- 用户审查；
- patch graph；
- operation log。

高置信引用必须来自 parser、明确 instruction semantics、confirmed schema 或用户确认。

候选引用可以进入 patch proposal，但必须由用户逐条确认或通过明确策略门控。

## 十一、当前工程状态（v0.3 完成地基 → v0.5 起步 → architecture scaffold）

v0.3 fixture-confirmed Bridge plumbing 已本地验证。

2026-07-09 起进入 **v0.5 foundation** 切片：

```text
overlay + readonly base
  -> graph patch IR
  -> operation log / file rollback
  -> AI tool permission ladder
  -> resource mode UI
  -> SQLite schema v2
```

同日继续落地 **v0.5 architecture scaffold**（核心架构闭环，非 UI、非 native parser/writer）：

```text
ResourceURI / FieldURI
  -> VFS
  -> ResourceGraph
  -> provenance / confidence / diagnostics
  -> PatchIR
  -> WorkspaceTransaction
  -> staging / validation / commit / audit / rollback
  -> AI tool policy gate
  -> Bridge protocol scaffold
```

可跑 vertical slice 仅限 **text / raw / synthetic** adapter。

这仍不代表 native FromSoftware parser / writer 已经完成。详见：

- `docs/CODEX_TASK_V0_5_ARCHITECTURE_SCAFFOLD.md`
- `docs/V0_5_ARCHITECTURE_SCAFFOLD_STATUS.md`

## 十二、当前完成能力

### 1. Bridge 语义分层

- inspect：只输出 evidence，不输出假语义；
- export-msg / export-event / export-param / export-map；
- DCX / BND 容器边界识别；
- raw fallback + candidate scan + synthetic fixture 三层结构。

### 2. Synthetic fixture 系统

已完成并接入 router / inspect，且本地 Bridge smoke 已验证：

```text
MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED
EMEVD_SYNTHETIC_FIXTURE_CONFIRMED
PARAM_SYNTHETIC_FIXTURE_CONFIRMED
MSB_SYNTHETIC_FIXTURE_CONFIRMED
BND_SYNTHETIC_FIXTURE_CONFIRMED
DCX_PAYLOAD_BOUNDARY_CONFIRMED
DCX_DFLT_DECOMPRESSED_PREVIEW_READY
DCX_DFLT_NESTED_BND_CHILD_TABLE_FOUND
```

### 3. Event / Param / Map 路由顺序

```text
Container boundary -> Synthetic fixture -> Low-confidence fallback
```

### 4. BND 状态

- `SyntheticBinderFixtureExports` 已接入 inspect confirmed 分支；
- child inventory 含 id / name / resourceKind / offset / packedSize / unpackedSize；
- binderChildCandidate 仍保留为 low-confidence visible-string fallback；
- native BND parser / writer 尚未完成，不得标为 native 完成。

### 5. 引用图

- `referenceBuilder` 已能区分 high / medium / low；
- 2026-07-09 新增 core smoke：fixture-confirmed instruction role 可生成 high-confidence edges，bare numeric 保持 low。

### 6. v0.5 foundation（2026-07-09）

- `WorkspaceSession`：overlay 可写、base 只读，拒绝写 base；
- `GraphPatch` IR：`buildGraphPatchFromProposal`；
- `MemoryOperationLogStore` + `rollbackOperation`：operation / file 级回滚；
- `FileOperationLogStore`：同 contract 的 JSON 落盘 store，commit/list/rollback 可跨进程 reopen；
- Patch Engine commit 自动写 operation log 与 graph；
- AI tool 权限阶梯：`read|analyze|propose|stage|validate|commit|rollback`；
- 新工具：`build_patch_graph`、`list_operations`、`rollback_operation`；
- SQLite migration id=2：workspace_layers / diagnostics / patch_history / file_operations / agent_runs；
- Desktop：资源模式切换条（Files + 各 resource kind + AI），按 kind 过滤文件树；
- Desktop P0 巩固：`operation.list` / `operation.rollback` IPC、操作历史面板一键回滚、可选 base 目录对话框；保存走 session 写门 + 落盘 operation log（userData，不写用户 mod 树）。

### 7. v0.5 architecture scaffold（2026-07-09）

- shared：ResourceURI/FieldURI、Provenance、Confidence、StructuredDiagnostic、ResourceGraph types、PatchIR、WriterAdapterContract、ValidatorContract、AuditLog、AI tool policy types、VFS types、Bridge protocol envelope/capability matrix；
- core：MemoryResourceGraph、PatchIR validators、text/raw/synthetic/unsupported writers、text/raw validators、content-addressed staging、restore points、WorkspaceTransaction、ScaffoldToolRegistry + PolicyGate、VFS builder、Bridge protocol scaffold helpers；
- smoke：`npm run test:v05-architecture -w @soulforge/core` 覆盖 URI → graph → PatchIR → transaction → AI policy → VFS → bridge；
- **未完成**：真实 native parser / writer、前端 UI、图/审计的 SQLite driver 产品化。

### 8. v0.5 write-path consolidation（2026-07-09）

- **唯一 production commit 主干**：PatchIR + WorkspaceTransaction；
- `saveTextResource` 已改走 compile → transaction → operation log，不再独立 `createStagingArea` + 直接 overlay 提交；
- text edit 生产路径强制 `beforeHash` / `expectedHash`；commit 前 stale 检查（`ORIGINAL_CHANGED_DURING_STAGING` / `TEXT_EDIT_HASH_MISMATCH`）；
- `WriterApplyResult.writtenTargets` 显式 opId→stagingPath；transaction 禁止 URI includes 猜测；
- VFS 打开扫描改为 bounded prefix + `hashStatus`（大文件 deferred，不全量 hash）；
- 默认 `npm test` 不再依赖 `../../mods`（真实 mod smoke 移至 `test:real-mod`）；
- `commitValidatedStagingArea` 仅为 legacy wrapper；
- smoke：`npm run test:v05-write-path -w @soulforge/core`（A–E 全覆盖）；
- 详见 `docs/V0_5_WRITE_PATH_CONSOLIDATION_STATUS.md`。

## 十三、当前已知问题

### 1. Build 环境问题

曾出现 Rollup optional dependency 缺失：

```text
@rollup/rollup-linux-x64-gnu
```

Windows PowerShell 本地环境 2026-07-07 / 2026-07-09 未复现；这更像跨平台 node_modules / optional deps 环境问题。

### 2. CodexPro 执行限制

某些 safe bash 环境可能不允许直接运行 dotnet / PowerShell。

Bridge smoke 可能需要本地终端执行。

## 十四、当前开发优先级

### P0：巩固 v0.5 foundation — 已完成（2026-07-09）

- smoke 绿色：`npm run test`、`test:v05-foundation`（含 persist）、`bridge:verify:synthetic`、`typecheck`、`build`；
- Desktop 可见操作历史 + 一键 rollback（main IPC，renderer 不写盘）；
- 打开工作区可选 base 游戏目录（只读；`WRITE_TO_BASE_FORBIDDEN`）；
- 落盘 operation log：`FileOperationLogStore`（JSON；SQLite schema 仍可后续接 driver）。

### P0b：write-path consolidation — 已完成（2026-07-09）

- text save 主干收口到 PatchIR + WorkspaceTransaction；
- legacy patchEngine commit 仅兼容 wrapper；
- consolidation smoke 双跑 + foundation/P1/architecture 保持绿。

### P1：安全编辑闭环加厚

- writer contract 接口（text 已走 PatchIR+transaction；structured/binary 仍禁止裸写）；
- patch graph 在 AI 侧边栏 / 主区摘要展示；
- diagnostics 表与 Patch gate 联动；
- Files mode 风险确认（unsupported 格式）；
- 可选 SQLite driver 替换 JSON operation log adapter。

### P2：按资源逐步加深（仍禁伪 native 完成声明）

- DCX / BND 容器路径继续 evidence-first；
- event / param / map / msg 结构化编辑与 writer；
- 不实现 3D / Blender / 本地 LLM / vector DB。

## 十五、v0.5 非目标

v0.5 不要求：

- 完整 3D parity；
- Blender MCP 实装；
- mesh modeling；
- animation authoring；
- 本地 LLM runtime；
- vector database RAG；
- 不安全自主二进制重写；
- 对 unsupported 格式盲改。

这些方向可以预留接口，但不能挤占 v0.5 的核心安全编辑闭环。

## 十六、当前系统真实状态一句话

```text
SoulForge 已有 v0.3 fixture Bridge 地基、v0.5 foundation、architecture scaffold，且 write-path consolidation 已把 production text save 收口到 PatchIR + WorkspaceTransaction（legacy patchEngine 仅兼容 wrapper）；完整 native parser / writer / 超级编辑器闭环仍在建设中。
```

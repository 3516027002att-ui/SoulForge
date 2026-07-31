# SoulForge V0.5 实施交接书

> - 文档性质：唯一实施规范、技术线路图与工程交接。
> - 目标读者：接手 SoulForge 的开发 Agent / 工程师。
> - 当前基准日期：2026-07-20。
> - 代码能力基线：`7bd354d`；该提交包含本文现有能力声明所依据的代码与历史证据。
> - 文档同步基线：`2002076`；本轮重构从该提交开始，结束状态在第 17 节记录。
> - 接手要求：必须以真实 `HEAD`、工作树、本机环境和测试结果重新核对，不得把基线提交自动视为当前验证通过。
> - 产品定位：**魂游 Mod 的 Cursor**。

---

## 0. 如何使用本文

本文不是固定工单，不要求 Agent 按机械顺序逐项执行。

它的作用是画清 SoulForge 的长期技术地形：

- 最终目标是什么；
- 有哪些相互依赖的技术主线；
- 哪些道路已经打通；
- 哪些只完成了部分能力；
- 哪些仍属于候选推断；
- 哪些被真实环境或格式证据阻塞；
- 前人留下了哪些可复现证据。

接手者应当：

1. 初次接手时全文阅读本文；连续开发至少重读全局线路图、当前技术前沿、执行面板和相关区域地图。
2. 需要机械化选点、拆解和沉淀流程时，配合 `docs/AGENT_EXECUTION_PLAYBOOK.md` 使用；它不承载独立状态口径。
3. 检查 `git status`、`HEAD`、本机环境和相关测试。
4. 根据依赖关系、真实证据、风险和当前可用环境，自主选择合理推进路径。
5. 修改完成后更新本文对应路线的状态与“实施证据记录”。
6. 不新建平行的 milestone、fork、next-actions、project-state、task 或 status 文档。

如果你写代码稳定、但不擅长自己排推进路径，可配合 `docs/AGENT_EXECUTION_PLAYBOOK.md` 执行手册使用。它把上面第 2～5 步和 §0.3 决策协议、§13.2 切片模板翻译成可机械执行的 L0～L6 循环、选点决策树和拆解模板。它只是方法手册，不承载任何状态、范围或 authority；本文仍是唯一事实源。

第一次接手项目时应全文阅读。后续连续开发可以重点阅读：

- 全局线路图；
- 当前技术前沿；
- 相关区域地图；
- 最近的实施证据记录；
- 相关稳定技术规格。

本文描述的是当前认知。真实 native 样本与本文冲突时，停止冲突能力的权威声明，记录证据，再修正地图；不得为了维持文档结论而忽略样本。

### 0.1 本文同时承担的控制职责

本文是唯一当前实施口径，必须同时回答以下问题：

| 问题 | 本文位置 |
|---|---|
| 产品和安全边界是什么 | 第 1、2 节 |
| 技术路线如何依赖 | 第 3 节 |
| 每条路线目前真正具备什么 | 第 4～12 节 |
| 当前有哪些可推进工作切片 | 第 13 节 |
| 生产入口和测试入口在哪里 | 第 14 节 |
| 应运行什么验证、需要什么环境 | 第 15 节 |
| 什么时候必须停止或降级声明 | 第 16 节 |
| 状态声明由什么证据支持 | 第 17 节 |
| V0.5 何时能够客观宣称完成 | 第 18 节 |

路线说明、当前前沿、工作切片和证据账本不是四套状态源。它们是同一事实的不同投影，任何一次实质推进都必须同步更新。

### 0.2 状态声明契约

任何 `partial`、`native-verified`、`blocked` 或 `unverified` 声明都必须能还原为以下字段：

~~~text
capabilityId
scope
authority
codeBaseline
evidenceRefs[]
corpusOrFixture
verifiedCommands[]
unverified[]
nonClaims[]
blockers[]
lastReviewedAt
~~~

不满足该契约的旧声明视为“历史记录待补证”，不能继续向更高 authority 提升。证据可以来自本文第 17 节、可定位的 Git 历史和当前真实命令结果，但不得只引用测试名称或口头结论。

### 0.3 接手决策协议

接手者按以下顺序选择工作，而不是从最长的缺口开始：

1. 先排除缺少合法环境、corpus、许可证裁定或前置 authority 的写能力。
2. 优先选择能解除多条下游路线阻塞的共同底座，其次选择能关闭高风险未知的只读研究或 validator。
3. 工作切片必须有单一主要 capability、明确非目标、可运行验证和 authority 上限。
4. 若实现只能产生 fixture、candidate 或失败关闭证据，任务可以推进，但状态不得提升为 native。
5. 若两个切片相互独立，可以并行；若共享 native writer、Patch Engine、migration 或协议变更，必须串行审查。
6. 完成切片后先记录证据，再更新路线状态和当前前沿；没有证据记录，不更新 authority。

### 0.4 工程执行与辅助生成边界

- 主 Agent 负责复杂推理、架构、安全、native authority、数据库迁移、Patch Engine、回滚、恢复和复杂 bug；这些职责不得以辅助代码生成替代。
- 简单、机械、低风险且边界清晰的 DTO、测试样板、序列化、机械重命名和胶水代码可以交给辅助代码生成工具。
- 前端视觉、交互和布局优先交给专门的前端 Agent。没有可用前端 Agent 时，主 Agent 可以在既定数据契约、安全边界和可运行验收标准内实施，但必须补齐真实视觉、交互和响应式验证。
- 任何辅助输出都必须由主 Agent 审查、集成并运行真实验证；辅助工具的成功输出不构成 SoulForge authority 或完成证据。
- 上述分工只影响实施方式，不放宽原版只读、路径隔离、Patch Engine、native authority、结构化诊断、凭据和私有资产边界。

---

## 1. 产品目标与长期边界

SoulForge 面向 Sekiro 和 FromSoftware Mod，目标不是简单复制 Smithbox、DarkScript3、WitchyBND、DSAnimStudio 或其他传统工具，而是在魂类工具生态之上建立一个：

- AI 原生；
- 证据驱动；
- 跨资源理解；
- 安全写入；
- 可审查；
- 可恢复；
- 可扩展到专业编辑器和完整场景的工程工作台。

最终体验：

~~~text
打开 Mod 覆盖目录 + 原版只读目录
  -> 建立虚拟资源树
  -> 按需读取 packed game data
  -> 渐进建立索引、引用图和证据包
  -> 用户或 AI 提出修改目标
  -> 生成 typed mutation / PatchIR
  -> 暂存与验证
  -> 展示影响范围
  -> 备份与原子提交
  -> 重读、重解析与增量索引
  -> 启动游戏验证
  -> operation / file / resource-entry 回滚
~~~

SoulForge 不急于上线。V0.5 是长期整合里程碑，不是为了赶时间而牺牲架构的短期 MVP。

因此：

- 完整 3D、资产管线、行为与动画、专业编辑器和 AI Agent 均可长期推进；
- 不因范围大而仓促砍掉长期能力；
- 也不允许用 scaffold、代理几何、fake server 或少量样本冒充整条路线完成；
- 技术边界必须允许局部实现逐渐替换，而不推翻工作区、语义模型和 Patch Engine。

正式平台仍为 Windows 10/11 x64，Sekiro 是第一个 native 权威验收基线。共享 URI、PatchIR、Bridge 协议、资源图、场景模型和 Agent 工具协议不得写死为 Sekiro-only。

---

## 2. 不可破坏的架构主干

### 2.1 工作区边界

- 原版游戏目录永远只读。
- Mod 覆盖目录是用户资源输出层。
- renderer 不得直接访问文件系统，也不得获得真实绝对路径。
- 数据库、缓存、日志、备份和恢复元数据只能进入应用数据目录，不能旁路写入 Mod 工作区。
- 路径必须经过 lexical、canonical、realpath 和 Windows reparse/junction 边界校验。
- 受信任 core/Bridge 的资源证据输出必须包含 `sourceUri`、`sourcePath`、`game`、`resourceKind` 和 `diagnostics`；其中 `sourcePath` 只用于受信进程的内部来源追踪。
- renderer-safe projection 必须删除真实绝对 `sourcePath`，改用 `sourceUri`、工作区逻辑相对路径或脱敏显示值；不得为了满足字段契约泄漏本机路径。
- 未有真实 parser 时不得声称格式已解析；检测、候选投影和 synthetic fixture 必须保持对应的较低 authority。
- synthetic 数据必须微小、合法构造并明确标记；不得包含或派生真实游戏资产、用户 Mod 或私有 corpus。
- 长任务必须异步执行、报告可观测进度、支持取消并设置超时；超时、取消和失败必须返回结构化诊断。
- 大文件、大表格和 3D 场景必须按适用方式懒加载、分页、虚拟化、分块或流式传输，不能一次性进入 renderer 或 React 状态。

### 2.2 唯一写入主干

所有用户 Mod 资源写入必须经过：

~~~text
修改意图
  -> typed mutation / PatchIR
  -> 暂存区
  -> parser / writer / layout / reference 验证
  -> 备份与恢复点
  -> 原子替换
  -> 重读 / 重解析
  -> 增量索引
  -> 审计
  -> operation / file / resource-entry 回滚
~~~

renderer、AI 完全权限、converter、外部工具和 native writer 均不能绕过这条链。

禁止在 Patch Engine 外直接使用 `fs.writeFile` 修改用户 Mod 资源。writer 和 converter 只能输出到 main 控制的暂存根。

### 2.3 Authority 分层

统一使用以下标签：

| 标签 | 含义 |
|---|---|
| `unsupported` | 已明确不支持，返回结构化诊断 |
| `candidate` | 基于头部、字段或少量样本的候选推断 |
| `fixture-confirmed` | 仅 synthetic / 构造样本成立 |
| `partial` | 已有真实能力，但格式、操作或 corpus 覆盖不完整 |
| `native-verified` | 在声明范围内有真实样本、往返、写入和重读证据 |
| `unverified` | 实现存在，但尚未得到所需运行证据 |

authority 必须写清作用范围。例如“MSB partial”必须说明已覆盖哪些实体、哪些 mutation、哪些 corpus，不能只写一个模糊标签。`blocked` 不再是 authority；它是 §13.1 的切片 lifecycle，并必须引用 §18.4 中已定义的 blocker。

### 2.4 Native authority 与编排边界

- C# Bridge 是 FromSoftware 原生二进制格式的 production authority。
- TypeScript 负责工作区、索引、资源关系、PatchIR、事务、任务、AI、场景投影和 UI 编排。
- TypeScript 不维护第二套 production native parser。
- 索引投影、语义投影和无损可写文档必须分离。
- 未知字段无法无损保留时，不得开放对应 writer。

### 2.5 外部生态边界

SoulForge 可以研究 Smithbox、DSMapStudio、DarkScript3、SoulsFormatsNEXT、WitchyBND、DSAnimStudio、Paramdex、EMEDF 和 me3 的公开行为、格式家族与工作流边界，但：

- 不复制不兼容许可证源码；
- 不把第三方 GUI 工具当作 production parser 运行依赖；
- 引入库前必须裁定许可证、维护状态和分发影响；
- Paramdex、EMEDF、me3 等数据或运行接口应作为正式生态适配点，而不是假装外部生态不存在。

---

## 3. 全局技术线路图

~~~text
SoulForge V0.5
│
├─ A. 工作区、安全写入与恢复主干
│  ├─ WorkspaceSession / VFS
│  ├─ PatchIR / staging / validation
│  ├─ SQLite authority / audit / jobs
│  └─ operation / file / resource-entry rollback
│
├─ B. Native 容器主干
│  ├─ DCX DFLT
│  ├─ DCX KRAK + Oodle runtime
│  └─ BND4 browse / CRUD / repack
│
├─ C. 核心语义资源主干
│  ├─ FMG
│  ├─ PARAM + Paramdex-compatible metadata
│  ├─ EMEVD + EMEDF
│  └─ MSB
│
├─ D. 行为与动画主干
│  ├─ TAE / animation events
│  ├─ ESD / state machines
│  ├─ animation / behavior references
│  ├─ Lua / HKS 等脚本资源（以 Sekiro corpus 为准）
│  └─ PARAM / EMEVD / MSB / action 的跨资源链
│
├─ E. 场景与资产主干
│  ├─ MSB semantic scene
│  ├─ FLVER geometry / skeleton / materials
│  ├─ TPF / DDS textures
│  ├─ MTD / material resolution
│  ├─ collision / navigation resources
│  └─ glTF / GLB / PNG / TGA / DDS 导入与原生转换
│
├─ F. 专业编辑器主干
│  ├─ read-only Hex evidence
│  ├─ EMEVD 四视图 + 可编译 DSL
│  ├─ PARAM / metadata workbench
│  ├─ FMG localization
│  ├─ MSB 3D editor
│  └─ patch / reference / history / diagnostics / jobs
│
├─ G. AI Agent 主干
│  ├─ evidence / context broker
│  ├─ typed tools
│  ├─ plan / normal / full permission gates
│  ├─ OpenAI-compatible
│  └─ Anthropic-compatible
│
├─ H. 运行、验证与发行主干
│  ├─ me3 runtime adapter
│  ├─ game launch / logs / crash diagnostics
│  ├─ patch-operation linked smoke
│  ├─ rollback then relaunch
│  └─ CI / installer / signing / updater
│
└─ I. 渲染架构主干
   ├─ renderer-independent semantic scene
   ├─ render projection / binary chunks / cache
   ├─ Three.js WebGPU primary backend
   ├─ WebGL2 compatibility fallback
   └─ future native backend if real benchmarks require it
~~~

这些路线存在依赖，但不构成强制的单线程实施顺序。接手者可以在不破坏前置 authority 和写入边界的前提下并行推进。

### 3.1 路线依赖与解锁关系

| 能力 ID | 路线 | 硬前置 | 主要解锁 | 可并行边界 |
|---|---|---|---|---|
| `A-WORKSPACE` | 工作区与安全写入 | 无 | 所有生产写能力 | 只读研究可独立进行 |
| `A-RECOVERY` | 事务、审计与三层回滚 | `A-WORKSPACE` | B/C/D/E 的 writer、H 运行验证 | UI 投影可并行，writer 接入不可绕过 |
| `B-DFLT` | DFLT | Bridge authority、合法 corpus | DFLT 包装下的 BND4/C 线资源 | KRAK 研究可并行 |
| `B-KRAK` | KRAK/Oodle | 合法 Sekiro runtime、Oodle 校验 | KRAK 内 BND4、EMEVD、资产 corpus | 无 runtime 时仅能做失败关闭和协议工作 |
| `B-BND4` | BND4 | `B-DFLT` 或 `B-KRAK` 解包、`A-RECOVERY` | FMG/PARAM/EMEVD/MSB/资产子项闭环 | 各 child parser 可并行，repack authority 共用审查 |
| `C-FMG` | FMG | BND4 child access、`A-RECOVERY` | 本地化编辑、文本引用、AI 证据 | 多语言映射可并行 |
| `C-PARAM` | PARAM | metadata authority、BND4、`A-RECOVERY` | 字段编辑、跨资源引用、行为分析 | metadata 研究可先于 writer |
| `C-EMEVD` | EMEVD | BND4、EMEDF、`A-RECOVERY` | 四视图写入、DSL、行为链、AI 工具 | DSL parser 可与 layer corpus 研究并行 |
| `C-MSB` | MSB | native document、`A-RECOVERY` | 完整场景、运行验证、地图引用 | semantic scene 投影可先于完整 writer |
| `D-BEHAVIOR` | 行为与动画 | Sekiro corpus 范围裁定、A/B 底座 | 招式链、状态机、跨资源行为编辑 | 只读格式地图可与 C/E 并行 |
| `E-ASSET` | 场景与资产 | BND4、FLVER/TPF/MTD authority | 原生场景只读投影与 native-to-open 导出 | candidate inventory 不解锁 native writer |
| `F-EDITORS` | 专业编辑器 | 对应 C/D/E semantic/native document | 可用工作台 | 通用交互骨架可并行，不能替代 authority |
| `G-AGENT` | AI Agent | evidence、typed tools、权限、A 写入主干 | 多步自动任务 | provider adapter 可并行，真实写循环依赖 native validator |
| `H-RUNTIME` | me3 与发行 | `A-RECOVERY`、可运行 Mod、合法本机环境 | 提交后启动、回滚后复验、发布门禁 | adapter contract 可先做，真实启动需环境 |
| `I-RENDER` | 渲染 | semantic scene、render projection | 大场景专业编辑 | 后端优化不改变 semantic/native authority |

### 3.2 Authority 解锁规则

- `candidate` parser 只能解锁只读检查、corpus 分类和 diagnostics，不能解锁 writer。
- `fixture-confirmed` 可以解锁协议、事务和 UI 接线测试，不能证明真实格式。
- `partial` 只有在作用范围、未知变体和 corpus 覆盖均明确时，才可作为同一范围内下游工作的前置。
- `native-verified` 只能解锁其声明范围内的生产能力；新布局、新游戏或新容器包装必须重新验证。
- `blocked` 不阻止无写入的协议、validator、corpus registry 和失败关闭工作，但阻止对应成功路径与发布声明。

---

## 4. A 线：工作区、安全写入与恢复

### 目标

建立所有格式、编辑器和 AI 共用的可信修改底座。

### 当前状态：`native-verified / partial hardening`

证据：`EV-A-SAFETY-20260720`、`EV-A-RECOVERY-20260724`、`EV-PUBLIC-20260724`、`EV-PUBLIC-CONTRACTS-20260725`；native writer 的历史细节见对应 B/C 路线证据。当前已为 BND4 native writer 建立 stage / validate / commit-backup / re-read 故障矩阵，并以不加载 native 资产的 deterministic fake daemon 覆盖 Bridge 阶段故障、出站失败、超时、取消、progress handler、背压、进程退出和显式重启；后者只达到 `fixture-confirmed`，不代表所有 production writer 的真实故障矩阵已经完成。

已经具备：

- Electron sandbox、CSP、导航、窗口、权限和 IPC sender 边界；
- main 持有目录选择和高风险确认；
- Mod 覆盖层可写、原版目录只读；
- canonical / realpath / junction 越界防护；
- PatchIR + `WorkspaceTransaction` production commit 主干；
- text、raw range、whole-file 和 container child 修改路径；
- 暂存、hash 前置条件、备份、原子替换、提交后重读，以及已覆盖事务终态的暂存回收；
- operation、file、resource-entry inverse transaction 基础；
- SQLite 两库、WAL、migration checksum、operation journal、恢复点、审计、文件索引、FTS、诊断和后台任务基础；
- Bridge daemon 长连接、超时、取消、崩溃失败关闭和不自动重放；出站失败会原子清理 pending / timer / listener，异步 progress 与终态竞态、背压 close/timeout/cancel 均已在公开 harness 失败关闭；
- Bridge staging 对请求级临时目录做终态回收；公开 smoke 在调用 writer 前拒绝父目录、分隔符、绝对/drive-relative、控制字符和 Windows device name 等 11 个代表性不安全 path segment case；
- recovery retention 计划与 main 安全删除执行器。

仍需长期加固：

- 真实断电、磁盘错误、复杂 ACL、网络盘和 filter driver；
- 安装包升级 migration；
- 大型 workspace 的真实容量与恢复压力；
- 各 native writer 在崩溃边界的完整故障矩阵；
- 三层回滚在所有后续格式上的复用验证。

该路线是其他所有可写能力的共同前置，不得被任何后端绕过。

---

## 5. B 线：Native 容器

### DFLT

状态：`native-verified`，仅限当前 Sekiro 私有基线出现的已验证变体。

证据：`EV-B-DFLT-7BD`（historical-record，本轮未重跑私有 corpus）。

已有证据：

- 144 个 DFLT 样本完整解压、重压和重读；
- 已记录两个实际变体；
- payload hash 与变体保持验证；
- DFLT 外层 BND4 production writer 已接入暂存写入主干。

### BND4 over DFLT

状态：`native-verified / corpus partial`

证据：`EV-B-BND4-7BD`（historical-record，本轮未重跑私有 corpus）。

已经具备：

- header、entry table、名称、ID、flags、unknown 和 payload 解析；
- add、replace、delete、rename、move；
- repack、暂存写、重读验证；
- operation 与 resource-entry inverse；
- 75 个真实 DFLT-BND4、11,344 entries 的历史验证证据。

仍缺：

- KRAK 内部不可见 corpus；
- 未来发现的新 flags、布局和嵌套变体；
- 全发布 corpus 的完整 authority。

### KRAK / Oodle

状态：`native-verified / corpus partial`（合法 runtime 下的登记 KRAK 读取及一个 writer roundtrip 已验证；不外推完整 KRAK corpus）

证据：`EV-B-KRAK-20260724`。

已经具备：

- 从用户选择的 Sekiro 游戏目录发现 Oodle runtime；
- 目录、PE x64、主版本、导出和动态加载校验；
- 缺失、版本错误、导出缺失和加载失败的结构化诊断；
- 不分发、复制或提交 Oodle DLL；
- KRAK 读取路径在运行库满足条件时调用 Oodle；
- `OodleRuntimeSession.Compress()`、`DcxNativeDocument.RebuildKrak()`、KRAK-aware `Bnd4NativeWriter` 与 TypeScript writer pipeline 已接线；
- 已在真实 `talkesdbnd` KRAK 容器执行 rename mutation、重压、重读与 roundtrip。

V0.5 冻结目标要求在相同合法 runtime 边界内完成登记 KRAK 布局的重压、写回、重读和恢复；不得捆绑、复制或分发 Oodle，也不得把版本族批准当成压缩 writer 证据。

当前仍缺：

- 已登记本机 1.6 corpus 之外的新 KRAK 变体覆盖；
- KRAK 内 BND4 / 语义资源的完整 corpus 闭环；
- 组合 mutation/repack、未知字段保持、故障恢复和完整 corpus 写回矩阵。

当前本机登记范围已对 214 个 DCX 做 100% 分类，其中 70 个 KRAK 均完成合法 runtime 读取；按内容去重后的 release registry 有 198 项。registry 生成命令本身不执行重压或写回；KRAK writer authority 只来自上述独立真实 mutation roundtrip，也不等于恢复矩阵或整个 REL-B 完成。

---

## 6. C 线：核心语义资源

### FMG

状态：`native-verified / scope partial`

证据：`EV-C-FMG-7BD`（historical-record，本轮未重跑私有 corpus）。

已有：

- Sekiro FMG v2 文档；
- 重复 ID 槽位；
- upsert、delete、add；
- UTF-8 Bridge transport；
- `item.msgbnd` 18/18 子项语义往返、写入、BND4 提交和回滚；
- 桌面实时读取和 Patch Engine 写回。

仍需：

- 其他 msgbnd 与语言 corpus；
- 完整多语言映射、diff、批量合并与冲突处理；
- 引用关系和真实游戏加载验证。

### PARAM

状态：`partial`

证据：`EV-C-PARAM-7BD`（historical-record，本轮未重跑私有 corpus）、`EV-PUBLIC-CONTRACTS-20260725`。

已有：

- 紧凑布局 PARAM 读取、raw row CRUD、写入、提交和回滚；
- 38/40 历史抽样通过；
- 用户派生 `ParamDefDocument` 布局校验和字段 decode/encode；
- 桌面表格、复制行和原生 smoke。
- Paramdex-compatible metadata package、不可变 source revision/content digest、SPDX license manifest、package/definition digest、`game + gameBuild + typeName + dataVersion + rowDataSize` 五键严格匹配、精确 trust policy 和 display-only overlay 冲突契约；
- 外部 package、definition、trust policy 和 overlay 先复制为隔离 plain-data 快照；Proxy、accessor、cycle、稀疏数组、自定义数组属性和显式 `undefined` 失败关闭，成功结果递归冻结；canonical UTF-8 总预算为 64 MiB，结构化诊断最多 256 条。
- 固定 Smithbox 2.2.4 本机 source adapter 已校验 release slot、发行包/提取树/license digest、文件数、目录边界与 symlink，使用无 DTD/entity 的流式 XML 解析导入 160 个 definition、7,028 个字段和 124 个英文注释类型；59 个 enum 引用解析，253 个未解析引用保持空/opaque，不编造枚举值；升级、撤回、缺失、错版与 digest 不匹配均失败关闭。
- 注册 native PARAM 与固定 metadata 的一致性矩阵已完成：135/138 严格匹配、0 个一致性冲突，3 个已知旧布局按策略正确排除。

当前重点不是为了形式完整而优先追逐“原生 `.paramdef` 二进制”。Sekiro 的实用 metadata 主线应是：

- Paramdex-compatible definitions；
- 字段名、类型、枚举和引用；
- definition 与 ParamType、版本、row size 的严格匹配；
- 游戏适配包内 metadata 版本；
- 用户 overlay 与冲突诊断。

V0.5 的批准来源冻结为 Smithbox `2.2.4` 中随官方发行包提供的 Sekiro `SDT` PARAM 资产：Git tag/commit `1b46d2c9f82d1c3635ff7c12c526e05a8ba4208f`，发行包 SHA-256 `14a7fd735a9577249fa93655f63d1e9ac025a3b00d7c5bed8badc8a3a7fd489d`，路径 `Smithbox.Release/Output/Assets/PARAM/SDT`。SoulForge 只从用户本机取得的该固定发行包导入并内容寻址，不把导入数据提交或打进 SoulForge 安装包。Smithbox 仓库与发行包带有 MIT 正文，但其提交历史显示部分数据来自未单独声明 LICENSE 的 Paramdex；因此本裁定不把 Smithbox 根许可证外推成对全部上游数据的再分发保证。源不存在、版本或 digest 不匹配时 PARAM 语义 metadata 失败关闭。

仍缺：

- 旧 header-embedded type name 变体；
- 完整字段级 writer 与引用验证；
- 全 corpus 与真实游戏验证。

### EMEVD

状态：`partial，结构与主要 mutation 已有真实证据`

证据：`EV-C-EMEVD-7BD`（historical-record）、`EV-C-EMEVD-DSL-20260724`、`EV-PRIVATE-20260724`。

已有：

- 正确 Sekiro header；
- 历史样本 1730 events / 33266 instructions；
- event id、rest behavior；
- instruction table、args 和 parameter bank；
- 等长与变长 args 重建；
- add、delete、duplicate event 与 GC；
- 桌面实时 IPC 和四视图投影；
- typed EMEDF fixture；
- renderer-safe DSL lexer / parser / AST、规范 render 和带行列诊断；
- EMEDF 严格 registry/参数类型检查与 typed mutation proposal（`fixture-confirmed`，不写二进制）；
- native EMEVD writer、独立 Patch Engine 提交和重读路径；
- `emevdPlanCommit` 已能把 typed plan 确定性转换为 Bridge batch mutation，但当前没有 production 调用方。

仍缺：

- `layerCount != 0` 的 parser 路径已开放，但 43/43 当前注册文件均未命中非零 layer，仍缺真实变体证据；
- 完整 Sekiro EMEDF schema 与类型覆盖；
- DSL control-flow validation、完整 UI submit，以及 proposal -> Bridge/PatchIR transaction/re-read/rollback 的 production 接线与真实 smoke；
- 全 corpus mutation matrix；
- KRAK 包装样本；
- 真实游戏加载验证。

EMEDF 类型源的定位、版本固定、许可证审计和适配实现属于工程工作，不是 `user-ruling`。工程方应先研究 DarkScript3、Smithbox 等成熟公开项目及其公开文档；可合法使用时只建立固定版本、内容寻址、external-only 的本机适配，不复制不兼容源码，也不把受限元数据提交或打包。若没有可合法使用且能独立验证的类型源，未知指令继续保持只读 opaque，相关能力维持 `partial/unsupported` 并转入工程 `license/upstream` 缺口，不得要求用户提供来源或授权 freshness。只有改变已冻结的 EMEVD 产品范围才需要新的用户裁定。

#### EMEVD DSL 终局

DSL 先只读是安全阶段，但不能永久停留在展示层。长期链路：

~~~text
DSL source
  -> parser
  -> AST
  -> EMEDF typecheck / control-flow validation
  -> semantic event model
  -> typed EMEVD mutation
  -> lossless native document
  -> PatchIR
  -> staging / validation / commit / rollback
~~~

反向链路：

~~~text
Native EMEVD
  -> semantic event model
  -> structure / instruction / graph / DSL projections
~~~

DSL 不得直接生成或覆盖二进制；未知字段仍由 lossless native document 保留。

### MSB

状态：`partial`

证据：`EV-C-MSB-SCENE-20260724`（unsealed-record）、`EV-C-MSB-7BD`（historical-record）。

已有：

- Sekiro MSB envelope；
- models、parts；
- POINT regions；
- 部分 EVENT 记录；
- part / region position 写回；
- 桌面实时读取、位置微调和 Patch Engine 提交；
- schema v2 renderer-independent semantic scene / render packet，包含相对 `sourcePath`、game/resourceKind、source revision 和结构化 diagnostics；
- Bridge 预览中的 model / part / region / event 四类实体投影，part / region 可绘制，native offset identity 在 transform mutation 与输入重排后保持稳定；
- shared 单一 scene builder，core 与 renderer 不再各维护一套近似逻辑；
- chunk render packet、renderer 绝对路径防线、Three.js proxy picking 和 candidate 资产引用；
- 桌面/390px 视口无横向溢出的 production bundle WebGL canvas 检查。

仍缺：

- 全实体类型与未知数据无损建模；
- entity add/delete/reorder/type conversion；
- 引用修复；
- transform 之外的完整 mutation；
- KRAK corpus；
- Bridge 当前每类实体预览上限与完整原生 scene projection；
- 真实 FLVER 几何、完整大地图流式加载、WebGPU 与硬件性能基准；
- 真实游戏加载验证。

---

## 7. D 线：行为与动画

状态：`candidate / partial parser coverage`

该路线正式纳入 SoulForge V0.5 冻结范围，不能被场景资产线遮蔽。

目标能力包括：

- TAE / animation event 文档与时间轴；
- ESD state machine 查看、编辑和图投影；
- animation、behavior、event、param、map entity 之间的引用；
- 角色招式链和动作逻辑；
- Lua、HKS 或其他 Sekiro 脚本资源的真实格式确认；
- 与 EMEVD、MSB、PARAM 和资产的跨资源 patch graph。

当前已建立登记样本上的 TAE native document parser（939 animations、23,711 events、81 event types）和 ESD native document parser（36 groups、295 states、315 conditions及 RPN bytecode），并有只读工作台投影；这些结果仍是注册样本上的 `candidate`，不证明完整事件语义、全部布局或 writer。

冻结目标要求全部 Sekiro TAE、全部 ESD 以及真实 corpus 中发现的源码/编译脚本具备完整语义读写；当前仍缺 HKX/Lua/编译脚本定位、完整引用图、schema/typecheck、typed mutation、native writer 和真实游戏加载。具体格式必须从合法 corpus、公开格式知识和可验证行为中确认，不得仅凭其他 FromSoftware 游戏的格式列表宣称 Sekiro 支持，也不得执行不受信脚本。

该路线可以与场景资产线并行研究，但任何 writer 都要复用 A 线的 PatchIR 和回滚主干。

---

## 8. E 线：场景与资产

状态：`partial / candidate`

证据：`EV-E-ASSET-7BD`（historical-record）及 §13.1 当前 native smoke 记录。

已有：

- MSB semantic scene manifest；
- Three.js semantic-scene 代理几何与 FLVER 只读查看器；
- FLVER native document parser 已在登记样本解析 346 bones、36 materials、44 meshes、约 182K faces，并完成 byte-identical no-op roundtrip；
- TPF native document parser 已在登记样本解析 16 textures 及 BC1/BC4/BC5 payload；
- FLVER mesh/UV/normal/skeleton/material slot/dummy 投影与 native -> GLB 导出路径；
- TPF native -> PNG/TGA/DDS 开放格式导出路径；
- glTF/GLB/PNG/TGA/DDS 检测与暂存；
- 最小 raw RGBA8 -> DDS 编码器；
- candidate model/material inventory。

仍缺：

- FLVER/TPF 未登记布局、完整材质/纹理关联和全 corpus authority；
- MTD 语义描述链；
- collision、navigation 和地图资源关联；
- MTD -> 可读描述清单以及 collision/navigation 的开放格式描述导出；
- 大型真实场景性能和显存管理；
- 真实游戏加载验证。

V0.5 明确排除开放格式到 FLVER/TPF/MTD 的 native 导入与所有五类资产 writer；现有 asset import/file_replace candidate 不得作为发布能力。未来若要恢复 native 导入，必须重新打开范围裁定。行为与动画路线继续作为同等级主线推进。

---

## 9. F 线：专业编辑器

状态：`partial`

证据：`EV-F-EDITORS-7BD`（historical-record）；本轮 `npm test` 只维持聚合公开回归，不替代完整 Electron 人机验证。

已经具备或已有骨架：

- 统一 `EditorDocumentStore` 与 revision/mutation 协议；
- 只读 Hex 偏移/原始字节证据视图，editor protocol、preload 与 main IPC 均不再向 renderer 暴露 raw replace / byte-range mutation；
- EMEVD 四视图；
- PARAM / ParamDef 面板；
- FMG 工作台；
- MSB 3D 代理场景和位置微调；
- TAE / ESD 只读 native document 工作台；
- FLVER 只读资产查看器（属于资产线，不计入冻结的八个语义编辑器）；
- jobs、history、patch impact、diagnostics 投影；
- 简体中文界面和术语扫描。

长期要求：

- 编辑器状态必须来自 native / semantic document，而不是 demo 数据；
- 所有 mutation 进入 typed protocol；
- revision 冲突显式失败；
- 大表格和大场景虚拟化、分页或分块；
- undo/redo 与 PatchIR/history 边界清晰；
- demo fallback 不得被当作真实文件能力；
- EMEVD DSL 最终可编译为 typed mutation；
- 行为、动画和资产编辑器逐渐接入同一工作台。

V0.5 冻结交付清单为 BND4、FMG、PARAM、EMEVD、MSB、TAE、ESD、脚本八个语义编辑器。每个编辑器必须同时提供结构化界面和规范 DSL，并共享同一 Bridge native document、revision、selection 与 typed mutation；没有完整 parser/schema/typecheck/native writer 的资源不得编辑。Hex 只允许作为只读偏移与原始字节证据视图，不能形成 raw write 或绕过 native authority。

当前 inventory contract 已精确登记这八项，但 BND4 与脚本编辑器尚无对应工作台；TAE/ESD 只有只读投影，尚无 schema/typecheck、typed mutation 和 writer；其余编辑器也只能按各自当前 native authority 开放实际已验证操作。inventory 登记不等于八个编辑器完成。

---

## 10. G 线：AI Agent

状态：`partial / production unverified`

证据：`EV-G-FAKE-7BD`；当前只有 fake/contract 证据。V0.5 不要求真实模型账号或凭据，配置默认允许留空。

已有：

- OpenAI-compatible Chat Completions adapter；
- OpenAI Responses adapter；
- Anthropic Messages adapter；
- fake HTTP/SSE tool loops；
- plan / normal / full permission gates；
- 完全权限仍返回 Patch Engine required；
- safeStorage vault、main-only key resolution、IPC 设置面板和审计基础。
- main/core 统一 provider factory；空配置、空凭据、非法协议、不安全 endpoint 在 adapter 创建前返回结构化 `unconfigured` / `invalid-configuration`，9 个正负场景证明网络调用计数为 0；两类有效配置仍进入既有离线 contract server 工具循环。
- 双协议错误分类、timeout、AbortSignal 取消和 agent loop 限额的 10 case 离线 conformance 已完成。

仍缺：

- 完整 Context Broker / evidence bundle；
- production typed tool registry；
- outbound context 审计和内容最小化；
- 真实工作区多步 Agent 任务；
- provider-specific 边界扩展与模型服务迁移。

AI 无充分证据时必须返回 `insufficient_evidence`。任何模型服务都不能绕过 Patch Engine、native validator、备份、审计和回滚。真实 provider endpoint/key 可由所有者日后选择配置，但不是 V0.5 验收输入；仓库、安装包和默认配置均保持空值且不得内置凭据。

---

## 11. H 线：运行、验证与发行

### me3 runtime adapter

状态：`fixture-confirmed / partial adapter operations`；native runtime authority 仍为 `unverified`

证据：`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`。已实现 renderer-independent `GameRuntimeAdapter`、desktop main-owned production gateway 以及 profile/create、launch、diagnostics、terminate 的受限 adapter 操作；固定本机工具槽中的真实 me3 0.12.1 只执行过受限 `--version` probe，仍为 `exit-zero-unverified`，未启动 Sekiro。

SoulForge 不实现自己的 Mod loader 或注入器。Sekiro 首选正式集成 me3，并通过可替换通用运行接口隔离 core 与特权进程：

~~~ts
interface GameRuntimeAdapter {
  readonly adapterId: string;
  readonly game: 'sekiro';
  detect(context: RuntimeCallContext): Promise<RuntimeCapability>;
  prepareProfile(workspace: RuntimeWorkspaceRef, context: RuntimeCallContext): Promise<RuntimeOperationResult<RuntimeProfileRef>>;
  launch(request: RuntimeLaunchRequest, context: RuntimeCallContext): Promise<RuntimeOperationResult<RuntimeLaunchSession>>;
  collectDiagnostics(session: RuntimeLaunchSession, context: RuntimeCallContext): Promise<RuntimeOperationResult<RuntimeDiagnostics>>;
  terminate(session: RuntimeLaunchSession, context: RuntimeCallContext): Promise<RuntimeOperationResult<RuntimeTerminationResult>>;
}
~~~

当前 contract 已做到：

- DTO 不含真实路径、process id、argv、cwd 或 env；
- detect 只通过受限 `Me3RuntimeGateway` 请求固定 version probe，验证闭集响应、精确版本 allowlist、1,024 字符输出上限、超时/取消和竞态；
- 无 policy、未知/歧义安装、错误版本、截断/异常输出、非零退出和 gateway 异常均返回结构化诊断并脱敏；
- 即使 fixture 版本匹配且 exit 0，仍保持 `exit-zero-unverified`、`canPrepareProfile=false`、`canLaunch=false`；
- `prepareProfile`、`launch`、`collectDiagnostics`、`terminate` 已通过闭集 DTO 接到 main gateway，并覆盖成功、失败、超时、取消和非法响应的 25 case fixture；
- desktop main 只解析固定本机工具槽，使用无 shell、隐藏窗口、最小环境、固定 argv、1,024 字节 stdout/stderr 上限及 timeout/cancel；IPC/preload 不接受路径输入，也不返回真实路径、PID、argv、cwd 或 env。

当前精确版本 allowlist 只是 contract-only 实现事实，不是 V0.5 的最终兼容策略。冻结目标改为受限 capability probe：只有协议/schema、所需命令、超时/取消和真实 smoke 全部明确成功时才允许 profile/launch；不得只凭版本字符串或 exit 0 推断兼容。

后续仍需真实验证：

- capability probe 足以安全启用 profile/launch；
- 在所有者机器上创建或更新当前 Mod profile 并启动 Sekiro；
- 捕获真实会话的 stdout/stderr、退出码和可用崩溃信息；
- 将启动会话关联到 Patch operation；
- 提交后启动验证；
- 回滚后再次启动验证恢复。

me3 是可替换的运行适配器，不是工作区、Patch Engine 或语义模型的核心依赖。

### 发行状态：`partial / unverified`

证据：`EV-REL-COMPLIANCE-20260725`（unsealed-record）、`EV-PUBLIC-CONTRACTS-20260725`、`EV-H-GATES-7BD`（historical-record）、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`。严格 builder JSON、scratch boundary、subprocess control 与内容门禁已有公开证据；最近一次 NSIS 构建产出约 117.7 MB 的未签名安装包。private native gate 已在本机合法 registry/Oodle 上实际运行并保持 `partial`，真实 Sekiro 启动仍未通过。

已有：

- Windows CI 配置；
- release content、许可证 inventory、凭据/私有资产路径扫描和同机可复现构建指纹；
- electron-builder 配置使用严格 JSON 闭集解析，拒绝未知键、workspace link 和 falsy manifest 漂移；scratch root、子进程树终止、超时/取消和 stdout/stderr 上限有公开负向 fixture；
- electron-builder 当前配置已收敛为 Windows x64 NSIS-only，只复制最终 `better_sqlite3.node` 与确定性 metadata，packaged main 从 `process.resourcesPath/native` 解析 binding；legacy-named packaging gate 的可选 `--dir` 仅生成内容扫描中间产物，不构成 portable release；
- private native gate 可执行并按各子步骤真实 authority 汇总为 `partial`；section-28 仍诚实失败关闭；
- production lockfile 许可证正文 inventory 当前为 123 present / 0 metadata-only / 49 not-installed（可选平台包）；
- 基础性能 smoke。

仍缺：

- 远程 CI 全部真实绿证据；
- 完整 third-party notices 与外部分发权利闭环（只影响未来外部分发，不阻止所有者内部测试构建）；
- 当前源码对应的 release manifest/hash 与 package tree 扫描；
- 安装、升级、卸载和干净机验证；
- 安装包内 Bridge、自包含 .NET 和 native binding 验证；
- me3 启动链；
- 真实 Sekiro Mod 加载、回滚和再次启动；
- 双协议完整错误/取消/超时/限额 conformance 与真实工作区 typed mutation 循环；
- WebGPU/WebGL2 功能回退闭环。

`skipped` 和 `unverified-no-local-sekiro-runtime` 不能算通过。

V0.5 发行边界冻结为 Windows 10/11 x64 的 NSIS，仅限项目所有者控制的内部测试机器；代码签名不再是范围或验收项。不发布 portable，不内置自动更新，不得在 notices/再分发权利未闭环时向外部测试者或公众分发。未签名安装包仍必须通过确定性 manifest/hash、内容扫描、干净机安装、升级、卸载和 runtime 完整性验证，但不声明发布者身份或 SmartScreen 信誉。

---

## 12. I 线：渲染架构

状态：`partial / functional validation open`。

证据：`EV-I-RENDER-7BD`（historical-record）及 §13.1 当前 renderer smoke。shared semantic scene/render packet、WebGPU capability detection、`three/webgpu` 按需主路径、WebGL2 fallback 构造和 FLVER 只读 3D 查看器已经进入 production bundle；当前仍以登记 FLVER/代理场景和 contract smoke 为主，没有所有者机器完整 fallback/resource-lifecycle 功能证据，也不要求真实大地图性能 authority。

### 裁定

Three.js 继续作为首个正式渲染实现，但 Three.js 不能成为项目场景模型本身；WebGL2 也不再被写成长期唯一目标。

目标架构：

~~~text
MSB / FLVER / TPF / MTD / collision
        -> lossless native documents
        -> semantic scene model
        -> render projection
        -> renderer backend
             |- Three.js WebGPU primary
             |- Three.js WebGL2 fallback
             `- future native backend if benchmarks require it
~~~

编辑行为必须针对 semantic/native mutation：

~~~ts
applyMsbMutation({
  kind: "set_part_position",
  entityUri,
  position
});
~~~

禁止把 `THREE.Object3D`、`Mesh` 或 renderer 内部状态当作权威编辑文档。

### 建议核心接口

~~~ts
interface SceneEntity {
  id: ResourceUri;
  kind: SceneEntityKind;
  transform: Transform;
  bounds: Bounds;
  renderRefs: RenderResourceRef[];
  semanticRefs: ResourceUri[];
  revision: number;
}

interface RenderPacket {
  entityId: ResourceUri;
  geometryId: number;
  materialId: number;
  transformIndex: number;
  boundsIndex: number;
  flags: number;
}

interface RendererBackend {
  initialize(target: RenderTarget): Promise<void>;
  uploadChunk(chunk: RenderChunk): Promise<void>;
  removeChunk(chunkId: string): Promise<void>;
  updateTransforms(batch: TransformUpdate[]): void;
  pick(request: PickRequest): Promise<PickResult>;
  dispose(): Promise<void>;
}
~~~

### 性能工程路线（不属于 V0.5 验收）

需要逐步具备：

- typed-array scene storage；
- transferable `ArrayBuffer` / 紧凑二进制 chunk，避免大 JSON IPC；
- geometry/material/texture hash 去重；
- chunk streaming；
- instancing / batching；
- frustum / bounds / LOD；
- GPU ID picking 与 box selection；
- texture residency、mip 和 LRU GPU cache；
- worker 中的索引、BVH 和批次规划；
- 明确 GPU resource 生命周期。

### 是否需要原生 Vulkan / D3D 后端

V0.5 不要求代表性硬件档位、真实大地图性能预算或原生后端决策。后续若项目所有者主动扩展性能范围，可以测量：

- 首次打开与后台加载时间；
- 稳态内存与显存；
- camera 帧时间；
- picking 和批量选择延迟；
- 单实体 mutation 的增量更新时间；
- 多次打开关闭后的资源泄漏；
- WebGPU 与 WebGL2 差异。

只有后续独立范围中的真实证据表明：

- WebGPU 下仍无法达到可接受交互性能；
- JS/GC 成为无法规避的主要瓶颈；
- 原生纹理、上传、picking 或显存控制受到硬限制；

才考虑增加独立 `NativeRenderHost`。即使未来增加原生后端，也必须复用 semantic scene、render packet、资源缓存协议和 typed mutation，不能推翻上层架构。V0.5 的渲染验收仅要求在项目所有者当前机器上完成 WebGPU 能力探测、可用时的主路径，以及不可用/初始化失败时的 WebGL2 功能回退；不设 FPS、帧时间、RAM、显存或泄漏量化门槛。

---

## 13. 当前技术前沿

本节只描述当前战线，不规定下一位 Agent 必须先做哪一项。

| 路线 | 当前状态 | Evidence | 主要前沿 / 阻塞 |
|---|---|---|---|
| A 工作区与事务 | `native-verified / partial hardening` | `EV-A-RECOVERY-20260724`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | BND4/FMG/PARAM 三格式 12 case 与 EMEVD/MSB 8 case writer 故障矩阵已通过；真实断电、大容量、跨会话和安装升级恢复仍是工程缺口 |
| B DFLT | `native-verified` | `EV-B-DFLT-7BD` historical | 新变体和发布 corpus |
| B BND4 | `native-verified / partial` | `EV-B-BND4-7BD` historical | KRAK 内 corpus、新 flags/布局 |
| B KRAK | `native-verified / partial` | `EV-B-KRAK-20260724`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | **KRAK Oodle Kraken 重压/写回/roundtrip 已完成**；仍缺 KRAK 内语义组合和完整 corpus 写回矩阵 |
| B 发布 corpus contract | `partial / registered local corpus` | `EV-HANDOFF-LIVENESS-20260725`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | 仓库外 registry 已覆盖 214 个 DCX、198 个唯一内容并完成 100% 分类；schema/分类不授予 native writer authority |
| C FMG | `native-verified / partial` | `EV-C-FMG-7BD` historical、`EV-FMGMSB-WRITE-20260731` | **FMG `add` mutation 已暴露并验证**（TS helper 补 `add` kind，真实 item.msgbnd add case：staged 写入 → 独立重读文本存在 → 原文件未受影响）；**menu.msgbnd 第二语料读验证完成**（15 子项全部 FMG v2 semantic roundtrip）；仍缺多语言（本机 corpus 仅 zhocn）、多 msgbnd 写验证、引用与游戏加载 |
| C PARAM | `partial` | `EV-C-PARAM-7BD` historical、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | **metadata/native 一致性 135/138 已验证**；仍缺 3 个已知旧布局和完整字段 writer |
| C EMEVD | `partial` | `EV-C-EMEVD-DSL-20260724`、`EV-PRIVATE-20260724`、`EV-EMEVD-PATCHIR-20260731`、`EV-EMEVD-COVERAGE-20260731`、`EV-EMEVD-GLOBAL-20260731`、`EV-EMEVD-FULLDOC-20260731` | **DSL plan → Bridge batch staging → file_replace PatchIR → WorkspaceTransaction 的 production 接线已完成**（四视图 submit 入口，合成 3 case + 真实 common.emevd 事件级 mutation 通过，重读/回滚/failure 全链验证）；修复 writer 组合 mutation 的 id 重命名验证与既有重复事件 id 容忍；**真实 corpus 指令分布与 EMEDF 覆盖基线已建立**（`read-emevd-document` 输出聚合分布：142 种指令 / 33,266 条实例；fixture 覆盖 1 种；2000:0 存在 12/16/20/24/32 多长度变体；WaitFor/EndEvent 未出现在真实 corpus）；**DSL 全局指令级 typed mutation 已实现**（顶层 `instruction` 块，跨事件直接引用稳定指令身份，与事件内写法产生相同计划操作）；**EMEVD 完整文档分页组装已实现**（Bridge 分页 envelope → 连续性/总数/事件切片校验，DCX 直读解压产物可复用为 staging 源，真实 common.emevd 1,730 events / 33,266 指令 / 34 页）；**四视图 DSL 提交 UI 接线已完成**（main 持有权威完整文档缓存、renderer 仅编辑 DSL 文本，提交前重读 fresh 文档保证 revision 一致，经 `submitEmevdDslPlanViaFourView` production 写链提交）；仍缺完整 EMEDF 类型布局（真实分布只有长度签名、无参数类型）、control-flow 与全 corpus |
| C MSB | `partial` | `EV-C-MSB-SCENE-20260724`、`EV-C-MSB-7BD` historical、`EV-FMGMSB-WRITE-20260731` | 四类实体 preview 已进入稳定 revision/identity scene IR；**`set_part_transform` 重读验证已完成**（Bridge writer 补 rotX/scaleX/scaleY/scaleZ 重读核对，真实 m11 transform case：rotX=82.38、scale [1.05, 1.1, 0.95]，part 数不变）；仍缺全实体 CRUD、引用修复、完整非截断 scene projection |
| D 行为与动画 | `partial / candidate` | `EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-EMEVD-PATCHIR-20260731` | **TAE native document parser 已完成**（939 anims, 23711 events, 81 types）；**ESD native document parser 已完成**（36 groups, 295 states, RPN bytecode）；新增行为/脚本容器头部观察工具 `probe:behavior-headers`（anibnd/behbnd/luabnd/talkesdbnd，环境缺失失败关闭）；仍缺 HKX/Lua 完整语义 parser/writer/DSL 与游戏加载 |
| E 场景与资产 | `partial` | `EV-E-ASSET-7BD` historical、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-EMEVD-PATCHIR-20260731` | **FLVER native document parser 已完成**（346 bones, 36 mats, 182K faces, byte-identical）；**TPF native document parser 已完成**（16 textures, BC1/BC4/BC5）；**MTD 只读 XML 结构投影已完成**（candidate，DTD/外部实体拒绝）；新增 `read-mtd-document` 与 `inventory-asset-resources`（容器级资产类别 inventory）Bridge 命令；仍缺 collision/navigation 和完整只读 authority |
| F 专业编辑器 | `partial / acceptance candidate` | `EV-F-EDITORS-7BD` historical、`EV-HANDOFF-LIVENESS-20260725`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-EMEVD-SCALE-20260731` | inventory 已精确冻结为 BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script；Hex 已只读，FLVER 归资产查看器；**EMEVD 编辑器规模访问已提升为 `pagination`**（完整文档分页组装 + DSL 模板行数截断 + 事件列表分页，硬约束 17 合规，`currentScaleContractGaps` 不再含 EMEVD）；仍缺 BND4/script 工作台、TAE/ESD 语义写链、各编辑器 DSL/完整有界访问和 Electron 功能验收 |
| G AI Agent | `partial / production unverified` | `EV-G-FAKE-7BD`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-EMEVD-PATCHIR-20260731` | **6 种错误分类 + 超时/取消/限额 10 case conformance 已完成**；**真实工作区多步 typed mutation 写矩阵 20 case 已完成**（agent loop 驱动 scaffold registry 经 Patch Engine 提交，plan 只读/normal 确认/full 权限门禁全覆盖）；仍缺 Context Broker 与完整生产多步任务闭环；真实 provider 凭据不属于 V0.5 验收 |
| H me3 运行 | `fixture-confirmed / partial` | `EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | **profile/launch/diagnostics/terminate adapter 已完成**（25 case smoke）；仍缺真实 Sekiro 会话和 NSIS 安装/升级/卸载验证 |
| H 发行 | `partial / unverified` | `EV-REL-COMPLIANCE-20260725`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-H-GATES-7BD` historical | **许可证文本覆盖 complete（123 present / 0 metadata-only）**；**NSIS 安装包构建成功（117.7 MB）**；仍缺安装/升级/卸载 lifecycle 验证和真实 Sekiro gate |
| I 渲染 | `partial` | `EV-C-MSB-SCENE-20260724`、`EV-I-RENDER-7BD` historical | shared render packet 与 production bundle WebGL proxy 已验证；**WebGPU 检测已实现**；**WebGPU-first 渲染器已集成**（three/webgpu 按需加载 + WebGL2 回退）；**FLVER 3D 查看器已完成**（包围盒 + 网格渲染 + OrbitControls + 多网格选择 + 材质颜色）；仍缺纹理映射、骨骼动画和完整功能回退验证 |

可以并行推进的典型方向：

- KRAK 受外部环境阻塞时，继续 EMEVD、MSB、Paramdex、FLVER 或行为格式研究；
- native writer 尚无证据时，可以推进只读文档、corpus registry、diagnostics 和 scene projection；
- UI 可以建立通用交互骨架，但不得用 demo 数据冒充底层 authority；
- renderer 优化可以推进，但编辑权威必须留在 semantic/native 层。

### 13.1 当前执行面板

本表是依赖驱动的候选切片，不是固定排期。开始工作前仍需检查真实工作树、入口和环境；切片 lifecycle 与能力 authority 必须独立记录，不能再用同一个“状态”字段混写。

- `lifecycle` 只允许 `ready | active | completed | blocked | superseded`：`ready` 可被认领，`active` 已被认领并可由 Q1 续做，`completed` 已达到本切片验收边界，`blocked` 必须引用 §18.4 blocker，`superseded` 已由新切片取代。
- `authority` 只允许 `unsupported | candidate | fixture-confirmed | partial | native-verified | unverified`，并始终受最后一列 authority 上限约束。
- `authority上限` 必须包含 `cap=<authority>` 机器标记；当前 authority 不得高于 cap。`unverified` 表示尚无所需证据，不是绕过 cap 的高等级。
- `completed` 只表示该切片完成，不表示整条路线或 Gate 完成；后续能力必须建立新切片。`completed` 与 `superseded` 均不得覆盖 `open` Gate。

| 切片ID | lifecycle | authority | blockerRefs | 目标能力 | 可独立验收切片 | 硬前置 | 主要入口 | required validation | authority上限 |
|---|---|---|---|---|---|---|---|---|---|
| `W-A-RECOVERY-01` | `completed` | `partial` | — | `A-RECOVERY` | 已完成公共四类 writer 与注册 BND4 writer 的 stage/validate/commit-backup/re-read 故障矩阵；本切片不再无限扩展 | 不改变 Patch Engine 主干；既有私有运行只保留原证据边界 | `packages/core/src/patch/durablePatchCommit.ts`、`packages/core/src/transactions/workspaceTransaction.ts` | `npm run test:writer-failure-matrix`、既有 `test:native-writer-failure-matrix` 记录 | cap=`partial`；只提升已覆盖 writer 的恢复可信度 |
| `W-A-RECOVERY-HARNESS-02` | `completed` | `fixture-confirmed` | — | `A-RECOVERY` | 已建立不加载 native 资产的 deterministic Bridge recovery/staging harness，覆盖四阶段故障、出站失败、注册期取消、超时、取消、同步/异步 progress、终态竞态、背压、进程退出、显式重启和 11 个代表性不安全 staging path segment case | 复用受控 subprocess 与系统临时目录；fake child 不得写成 native writer 通过 | `packages/core/src/bridge/bridgeDaemonClient.ts`、`packages/core/src/editing/bridgeStaging.ts`、`packages/core/src/testing/bridgeRecoveryHarnessProtocol.ts`、`packages/core/src/testing/bridgeRecoveryFixtureDaemon.ts`、`packages/core/src/testing/runBridgeRecoveryHarnessSmoke.ts` | `npm run test:bridge-recovery-harness`、`npm run test:bridge-staging`、`npm run bridge:verify:client` | cap=`fixture-confirmed`；只证明公开故障编排与 client/staging 失败关闭 |
| `W-A-RECOVERY-NATIVE-02` | `completed` | `partial` | — | `A-RECOVERY` | 将已冻结 harness 应用于其余 production native writer 的真实 stage/validate/commit/re-read/crash 矩阵；BND4/FMG/PARAM 三格式 12 case 全部通过 | 合法仓库外 native fixture registry 已建立；`W-A-RECOVERY-HARNESS-02` 已完成；未覆盖 writer 继续失败关闭 | 对应 Bridge writer、`runNativeWriterFailureMatrixSmoke.ts`、Patch Engine | `npm run test:native-writer-failure-matrix`、`npm run test:private-native-gate` 与对应 native transaction smoke | cap=`partial`；仅提升实际覆盖 writer，不外推到全部 writer |
| `W-PARAM-META-01` | `completed` | `fixture-confirmed` | — | `C-PARAM` | 已冻结 Paramdex-compatible metadata package、许可证 manifest、不可变来源、digest、五键匹配、精确 trust policy、display-only overlay、隔离快照、容量上限与冲突诊断契约 | 不捆绑或再分发 Paramdex 数据；不把 metadata 当 native row document；本切片不要求私有 PARAM | `packages/shared/src/paramdef.ts`、`packages/core/src/param/paramMetadata.ts`、`packages/core/src/param/paramdefLayout.ts`、`packages/core/src/testing/runParamMetadataMismatchSmoke.ts` | `npm run test:param-metadata-mismatch`、`npm run test:paramdef-layout` | cap=`partial`；metadata contract，不提升 PARAM writer |
| `W-PARAM-META-SOURCE-02` | `completed` | `partial` | — | `C-PARAM` | 已接入固定 Smithbox 2.2.4 本机发行包中的 `SDT` PARAM metadata，校验 commit/release/archive/tree/license digest、隔离导入、provenance、升级与撤回；不随 SoulForge 再分发导入数据 | `W-PARAM-META-01` 已完成；固定来源与非再分发政策已裁定；真实导入保持仓库外 | `packages/core/src/param/smithboxParamMetadataSource.ts`、`packages/core/src/param/paramMetadata.ts` | `npm run test:smithbox-param-metadata-source` | cap=`partial`；只提升固定本机来源 adapter，不提升 native PARAM authority或上游再分发权利 |
| `W-PARAM-META-NATIVE-01` | `completed` | `partial` | — | `C-PARAM` | 在合法注册 PARAM corpus 上验证 metadata 严格匹配、拒绝规则和 native row document 一致性；135/138 匹配、0 不一致、3 个已知旧布局正确排除 | metadata contract 与固定 Smithbox adapter 已完成；仓库外 PARAM fixture registry 已可用；剩余布局不得绕过 | `bridge/SoulForge.Bridge/ParamNativeDocument.cs`、`packages/core/src/param/smithboxParamMetadataSource.ts`、native fixture registry | `npm run bridge:verify:param`、`npm run test:smithbox-param-metadata-source`、`npm run test:param-metadata-native` | cap=`partial`；只覆盖实际通过的注册 PARAM 布局 |
| `W-EMEVD-DSL-01` | `completed` | `fixture-confirmed` | — | `C-EMEVD` | 已建立稳定 anchor、DSL tokenizer/parser/AST、规范 patch render、EMEDF typecheck 与确定性 typed mutation plan；本切片验收边界已完成 | 复用 `emevd-editor-ir` 与独立 `emevd-dsl` DTO；未知指令和不可无损重编码 payload 失败关闭/保持 opaque | `packages/shared/src/emevd-dsl.ts`、`packages/core/src/emevd/dslTokenizer.ts`、`packages/core/src/emevd/dslParser.ts`、`packages/core/src/emevd/dslCompiler.ts`、`packages/core/src/emevd/dslRenderer.ts`、`packages/core/src/emevd/stableIdentity.ts` | `npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view` | cap=`fixture-confirmed`；Bridge/PatchIR 与完整控制流进入后继切片 |
| `W-EMEVD-PATCHIR-02` | `completed` | `partial` | — | `C-EMEVD` | production 接线完成：`submitEmevdDslPlanViaFourView` / `commitEmevdPlanViaPatchEngine` 把 DSL typed plan 经 `stageEmevdPlanViaBridge`（Bridge batch staging）→ `buildEmevdFileReplacePatch`（file_replace PatchIR + hash 前置条件）→ `executePatchIrThroughTransaction` 提交，并做 Bridge 独立重读；合成 3 case（成功链/回滚链/失败链）与真实 common.emevd 事件级 mutation 1 case 均通过 | `W-EMEVD-DSL-01` 已完成；未知指令、opaque 尾部和 layer 变体不得被重编码；真实文档既有重复事件 id 容忍但不修改 | `packages/core/src/editing/emevdPlanCommit.ts`、`packages/core/src/editing/emevdFourViewController.ts`、`packages/core/src/editing/emevdBridgeCommit.ts`、`packages/core/src/testing/runEmevdPlanCommitProductionSmoke.ts`、`bridge/SoulForge.Bridge/EmevdNativeWriter.cs` | `npm run test:emevd-plan-commit`、`npm run test:emevd-plan-production`、`npm run bridge:verify:emevd`（四元组见 §13.4） | cap=`partial`；production smoke 不证明完整 EMEDF/layer/游戏加载 |
| `W-EMEVD-FULL-01` | `ready` | `partial` | — | `C-EMEVD` | 已建立真实 corpus 指令分布提取与 EMEDF 覆盖分析基线（`read-emevd-document` 聚合分布 + `analyzeEmedfCoverage` 长度一致性校验，真实 142 种/33,266 条，fixture 覆盖 1 种）；**DSL 顶层 `instruction` 块已实现**（全局指令级 typed mutation：不依赖事件包裹，经稳定指令身份解析到所属事件，与事件内写法产生相同计划操作；跨作用域重复写被共享注册表拦截）；**完整文档分页组装与四视图 DSL 提交 UI 接线已完成**（Bridge 分页 envelope → `readFullEmevdDocumentViaBridge` 连续性/总数/事件切片校验 + DCX 直读解压产物复用为 staging 源；desktop main 持有权威完整文档缓存 `emevdFullDocuments`、renderer 仅编辑 DSL 文本；`resource.submitEmevdDslPlan` 提交前重读 fresh 文档保证 revision 一致，经 `submitEmevdDslPlanViaFourView` production 写链提交并刷新缓存）；继续完整 Sekiro EMEDF schema 与类型覆盖（分布只有长度签名；成熟公开项目调查、许可证审计和 external-only adapter 由工程方完成）、DSL control-flow validation 与全 corpus mutation 矩阵 | `W-EMEVD-PATCHIR-02` 已完成 production 接线；未知指令、opaque 尾部和 layer 变体不得被重编码；真实文档既有重复事件 id 容忍但不修改；同 bank:id 多长度变体必须按长度签名区分，不得编造参数类型；无合法类型源时保持 opaque/partial 并继续其他工程切片，不能转成用户介入项 | `packages/core/src/emevd/emedfSchema.ts`、`packages/core/src/emevd/emedfCoverage.ts`、`packages/core/src/emevd/dslCompiler.ts`、`packages/core/src/editing/emevdFourViewController.ts`、`packages/core/src/editing/emevdFullDocument.ts`、`packages/core/src/util/dcxDflt.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx`、`bridge/SoulForge.Bridge/EmevdNativeDocument.cs` | `npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-plan-production`、`npm run test:emevd-coverage`、`npm run test:emevd-full-document`、`npm run test:emevd-ipc-contract`；`validation-unfrozen`：完整 EMEDF schema 覆盖与 control-flow smoke | cap=`partial`；只提升实际完成并验证的 schema/类型/接线 |
| `W-EMEVD-LAYER-01` | `completed` | `partial` | — | `C-EMEVD` | Bridge 已支持 layerCount != 0 的 EMEVD 只读解析（移除 throw，暴露 layerCount/layersOffset）；GC 重建保持拒绝；corpus 43/43 文件无 layer 样本（fail-closed） | 仓库外 corpus root/registry 已可用；工程方负责继续发现和登记目标样本 | `bridge/SoulForge.Bridge/EmevdNativeDocument.cs` | `npm run bridge:verify:emevd` | cap=`partial`；仅声明实际覆盖到的 layer 变体 |
| `W-MSB-SCENE-01` | `completed` | `partial` | — | `C-MSB` / `I-RENDER` | 已建立 shared schema v2 semantic scene/render packet、四类 Bridge preview、稳定 identity/revision、chunk、路径防线和 production canvas/picking；本切片验收边界已完成 | entity identity 与 revision 稳定；renderer 无绝对路径 | `packages/shared/src/scene-ir.ts`、`packages/core/src/editing/msbBridgeRead.ts`、`apps/desktop/src/renderer/src/scene/threeSceneController.ts` | `npm run bridge:verify:msb`、`npm run test:scene-draw-list`、`npm run test:three-scene-module` | cap=`partial`；完整实体流式投影、writer、FLVER 或游戏加载进入后继切片 |
| `W-BEHAVIOR-MAP-01` | `ready` | `candidate` | — | `D-BEHAVIOR` | 已构建 TAE native document parser（939 anims, 23711 events, 81 event types）和 ESD native document parser（36 groups, 295 states, 315 conditions, RPN bytecode）；新增 `probe:behavior-headers` 本机研究工具（anibnd/behbnd/luabnd/talkesdbnd 容器扩展名分布与 HKX/Lua/ESD 头部观察，环境缺失失败关闭）；继续 HKX/Lua 完整语义定位 | 合法 Sekiro corpus root/registry 已可用；不得套用其他游戏结论或把扩展名计数当 parser；探针输出不提交、不提升 authority | `bridge/SoulForge.Bridge/TaeNativeDocument.cs`、`bridge/SoulForge.Bridge/EsdNativeDocument.cs`、`packages/core/src/testing/probeBehaviorHeaders.ts`、Bridge inspection | `npm run bridge:verify:tae`、`npm run bridge:verify:esd`；`validation-unfrozen`：magic/reference inventory smoke | cap=`candidate`；仅覆盖注册样本的 native document 结构与容器级 inventory，不证明完整事件语义或 writer |
| `W-FLVER-READ-01` | `ready` | `partial` | — | `E-ASSET` | 已构建 FLVER native document parser（346 bones, 36 materials, 44 meshes, 182K faces, byte-identical roundtrip）和 TPF native document parser（16 textures, BC1/BC4/BC5）；新增 MTD 只读 XML 结构投影 `MtdNativeDocument`（candidate，DTD/外部实体拒绝、大小/元素上限、重复解析一致性验证）与 `read-mtd-document` / `inventory-asset-resources`（容器级资产类别 inventory，脱敏）Bridge 命令；继续 collision/navigation 定位 | 合法 corpus root/registry 已可用；布局冲突失败关闭；内层扩展名计数不构成 native document；MTD 语义读取不构成 native authority | `bridge/SoulForge.Bridge/FlverNativeDocument.cs`、`bridge/SoulForge.Bridge/TpfNativeDocument.cs`、`bridge/SoulForge.Bridge/MtdNativeDocument.cs`、`bridge/SoulForge.Bridge/BridgeCommandService.cs` | `npm run bridge:verify:flver`、`npm run bridge:verify:tpf`、`npm run bridge:build` | cap=`partial`；当前只读覆盖为 partial（MTD 为 candidate），不开放 native writer |
| `W-AI-REAL-01` | `superseded` | `unverified` | — | `G-AGENT` | 历史切片原要求两类真实 provider 凭据和人工 live smoke；用户已裁定真实账号/凭据不属于 V0.5 验收，默认配置留空 | 由 `W-AI-CONFORMANCE-02` 取代；不得把取消 live smoke 写成 provider adapter 已完成 | `packages/core/src/model-services`、`apps/desktop/src/main/modelServiceCredentials.ts` | 历史验收不再执行 | cap=`unverified`；不产生功能 authority |
| `W-AI-CONFORMANCE-02` | `completed` | `partial` | — | `G-AGENT` | 已完成双协议错误分类（6 种错误码：TIMEOUT/NETWORK/RATE_LIMITED/SERVER/AUTH/PARSE）、AbortSignal 超时、agent loop 取消/限额、10 case conformance smoke | 不内置 endpoint/key；写工具仍需 native validator/Patch Engine；真实服务账号不属于 V0.5 验收 | `packages/core/src/model-services/errorClassification.ts`、`packages/core/src/model-services`、`packages/core/src/testing/runAiConformanceSmoke.ts` | `npm run test:ai-conformance`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:model-service-configuration` | cap=`partial`；离线 conformance 不证明第三方服务可用性或 native mutation authority |
| `W-ME3-ADAPTER-01` | `completed` | `fixture-confirmed` | — | `H-RUNTIME` | 已定义 renderer-independent `GameRuntimeAdapter`、contract-only me3 detect、精确版本 policy、闭集 gateway DTO、超时/取消/竞态、输出上限、异常脱敏和未实现操作失败关闭 | 不实现 Mod loader；不发现或启动真实 me3/Sekiro；匹配 fixture 仍不得启用 profile/launch | `packages/core/src/runtime/gameRuntimeAdapter.ts`、`packages/core/src/runtime/me3RuntimeAdapter.ts`、`packages/core/src/testing/runMe3RuntimeAdapterSmoke.ts` | `npm run test:me3-runtime-adapter` | cap=`fixture-confirmed`；adapter contract only，native runtime authority=false |
| `W-ME3-MAIN-DETECT-02` | `completed` | `fixture-confirmed` | — | `H-RUNTIME` | desktop main 已实现固定工具槽、固定 `--version` 的 privileged detection gateway，并把脱敏结果接入 core adapter/IPC/preload；真实 0.12.1 probe 保持 `exit-zero-unverified` | `W-ME3-ADAPTER-01` 已完成；main 独占真实路径与进程权限；本切片不启动游戏 | `apps/desktop/src/main/me3RuntimeGateway.ts`、`apps/desktop/src/main/ipc.ts`、`packages/core/src/runtime/me3RuntimeAdapter.ts` | `npm run test:me3-runtime-gateway`、`npm run test:desktop-security`、`npm run test:me3-runtime-adapter` | cap=`fixture-confirmed`；只证明受限 production detection gateway，不证明 runtime 会话可用 |
| `W-ME3-PROFILE-03` | `completed` | `fixture-confirmed` | — | `H-RUNTIME` | 已实现 profile 创建（me3 profile create -g sekiro）、launch（me3 launch -d）、diagnostics、terminate（taskkill /T /F）；gateway 扩展 createProfile/launchGame/terminateProcess；IPC 四通道；25 case smoke 通过 | `W-ME3-MAIN-DETECT-02` 已完成；不得只凭版本字符串或 exit 0 启用；所有路径/PID/argv 继续 main-only | `apps/desktop/src/main/me3RuntimeGateway.ts`、`packages/core/src/runtime/me3RuntimeAdapter.ts`、`apps/desktop/src/main/ipc.ts` | `npm run test:me3-runtime-adapter`、`npm run test:me3-runtime-gateway` | cap=`partial`；只提升实际完成且重读/回滚验证的运行操作 |
| `W-RENDER-BENCH-01` | `superseded` | `unverified` | — | `I-RENDER` | 历史切片原要求代表性硬件/地图与量化性能基线；用户已裁定其不属于 V0.5 验收 | 由 `W-RENDER-FUNCTIONAL-02` 取代；性能优化可独立推进但不得恢复为隐含 Gate | `packages/core/src/scene`、`apps/desktop/src/renderer/src/scene` | 历史验收不再执行 | cap=`unverified`；不产生渲染 authority |
| `W-RENDER-FUNCTIONAL-02` | `ready` | `partial` | — | `I-RENDER` | WebGPU 检测已实现（adapter info + capability report）；WebGPU-first 渲染器已集成到 threeSceneController（three/webgpu 按需加载 + WebGL2 回退 + rendererBackend 报告）；继续真实 FLVER 渲染、picking、transform 更新与资源释放功能闭环 | 真实 native semantic scene/FLVER projection；不要求代表性硬件档位、地图集合、性能预算或 benchmark threshold | `packages/core/src/scene`、`apps/desktop/src/renderer/src/scene/threeSceneController.ts`、`webgpuDetect.ts` | `npm run test:scene-draw-list`、`npm run test:three-scene-module`；`validation-unfrozen`：WebGPU/WebGL2 functional fallback smoke | cap=`partial`；只证明已覆盖的 renderer contract，不外推所有者机器功能闭环、性能或硬件兼容矩阵 |
| `W-REL-SCOPE-01` | `completed` | `unverified` | — | `REL-SCOPE` | 已产出唯一、可 JSON 解析且覆盖 11 个 Gate 的 V0.5 支持范围提案；artifact validation 为 `proposal-valid`，用户裁定仍开放 | 只综合现有证据；私有 fixture registry 不得冒充 release corpus；不擅自裁定范围值 | 本文 §4~§12 与 §18.1~§18.2.1；`scripts/verify-release-scope.mjs` | `npm run test:release-scope-proposal` exit 0；严格模式必须因待用户裁定 exit 1 | cap=`unverified`；提案合法不等于范围获批或 Gate 完成 |
| `W-REL-SCOPE-RULING-01` | `completed` | `unverified` | — | `REL-SCOPE` | 用户已逐项批准 §18.2.1 的 27 项支持矩阵、Sekiro 1.6 版本族、八个语义编辑器、只读 Hex、所有者内部测试构建与 unsupported 边界；严格范围门禁和 sealed Evidence 已完成 | `W-REL-SCOPE-01` 已完成；批准记录使用脱敏 decisionRef；技术缺口继续由后继 Gate/blocker 失败关闭 | 本文 §18.2.1、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只完成范围 Gate，不提升任何功能 authority |
| `W-REL-SCOPE-RULING-02` | `completed` | `unverified` | — | `REL-SCOPE` | 用户撤销代码签名验收项；V0.5 当前发行目标为 Windows 10/11 x64 NSIS，仅限项目所有者控制的内部测试机器，允许未签名且仍强制 manifest/hash、内容扫描、安装、升级、卸载和 runtime 完整性验证 | `W-REL-SCOPE-RULING-01` 已完成；只修改签名要求，portable、自动更新和外部分发仍为 unsupported | 本文 §11、§18.1、§18.2.1、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730-UNSIGNED` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只更新范围 Gate，不提升任何功能或发行 authority |
| `W-REL-SCOPE-RULING-03` | `completed` | `unverified` | — | `REL-SCOPE` | 用户批准固定 Smithbox 2.2.4 本机 PARAM metadata 导入，并明确真实模型凭据留空、代表性渲染硬件/性能预算不属于 V0.5 验收；me3 环境由工程方处理 | `W-REL-SCOPE-RULING-02` 已完成；保持双协议 AI、WebGPU/WebGL2 功能与 me3 运行目标，不把取消外部输入写成能力完成 | 本文 §6、§10~§12、§18.1~§18.4、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730-OWNER-INPUTS` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只更新范围与责任边界，不提升 PARAM/AI/runtime/render authority |
| `W-REL-SCOPE-RULING-04` | `completed` | `unverified` | — | `REL-SCOPE` | 用户明确删除编辑器容量/延迟门槛和 installer 体积/耗时预算；V0.5 只验收完整有界访问与安装/升级/卸载正确性 | `W-REL-SCOPE-RULING-03` 已完成；不得借取消量化预算删除分页/虚拟化/分块/流式访问、manifest/hash 或 installer lifecycle 完整性 | 本文 §13.1、§18.1~§18.4、`releaseEditorAcceptance.ts`、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS` | `npm run test:release-editor-acceptance`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只删除两个量化验收条件，不提升编辑器、installer 或其他功能 authority |
| `W-REL-B-REGISTRY-01` | `completed` | `fixture-confirmed` | — | `REL-B` | 已建立不含私有样本内容的 corpus registry schema、分类枚举、metadata-only classification harness，以及格式/变体/重复/数量/路径/伪装等负向诊断 | 不装载或提交私有 corpus；synthetic manifest 不得冒充 release corpus | `packages/core/src/bridge/releaseCorpusRegistry.ts`、`packages/core/src/testing/runReleaseCorpusRegistrySmoke.ts` | `npm run test:release-corpus-registry`、`npm test` | cap=`fixture-confirmed`；不声明真实发布 corpus 闭环 |
| `W-REL-B-CORPUS-01` | `completed` | `native-verified` | — | `REL-B` | 已完成 KRAK Oodle Kraken 重压/写回/roundtrip：OodleRuntimeSession.Compress() P/Invoke、DcxNativeDocument.RebuildKrak()、Bnd4NativeWriter 接受 KRAK、TypeScript writer pipeline 接线；真实 talkesdbnd KRAK 容器 rename mutation 验证通过 | 合法 corpus root/locator registry 与 Oodle 已可用；registry schema validity 不授予 native authority | `bridge/SoulForge.Bridge/OodleRuntime.cs`、`bridge/SoulForge.Bridge/DcxNativeDocument.cs`、`bridge/SoulForge.Bridge/Bnd4NativeWriter.cs`、`packages/core/src/writers/containerChildReplaceWriter.ts` | `npm run bridge:verify:oodle`、`npm run test:native-writer-failure-matrix` | cap=`native-verified`；只提升已执行的登记 KRAK writer case，不外推完整 corpus 或 REL-B |
| `W-REL-F-ACCEPT-01` | `completed` | `candidate` | — | `REL-F` | 已建立冻结八编辑器 inventory、authority/revision/typed mutation、只读 Hex、完整有界访问与提前 pass 失败关闭 harness | 不运行真实 Electron 真实文档功能验收；不以 synthetic/demo、FLVER 资产查看器或固定窗口冒充冻结编辑器完成；不要求量化容量/延迟门槛 | `packages/core/src/editing/releaseEditorAcceptance.ts`、`packages/core/src/testing/runReleaseEditorAcceptanceSmoke.ts` | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract` | cap=`candidate`；harness 不等于八个编辑器发布通过 |
| `W-REL-F-SCALE-02` | `ready` | `candidate` | — | `REL-F` | inventory 已精确冻结为 BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script；**EMEVD 编辑器规模访问已从 `eager` 提升为 `pagination`**（完整文档分页组装 `readFullEmevdDocumentViaBridge` + DSL 模板行数截断 `renderEmevdPatchDslBounded`（事件块边界截断 + 注释标记，patch no-op 语义安全）+ 事件列表分页每页 200 + `loadFullDslTemplate` 显式完整加载；`currentScaleContractGaps` 不再含 EMEVD，其余 7 个编辑器缺口如实保留）；继续补 BND4 与 script 工作台、TAE/ESD 语义写链、各编辑器 DSL/完整有界访问和 Electron 功能验收 | FLVER 只读查看器属于资产线；Hex 永久只读；当前 `candidate` 只继承 acceptance harness 对缺口的分类；EMEVD `pagination` 只证明规模访问契约（分页组装/模板截断/列表分页），不证明完整语义编辑或真实验收 | `packages/core/src/editing/editorCapabilityContract.ts`、`packages/core/src/editing/emevdFullDocument.ts`、`packages/core/src/emevd/dslRenderer.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx`、`apps/desktop/src/renderer/src/App.tsx` | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:emevd-full-document`、`npm run test:emevd-dsl-compiler`；`validation-unfrozen`：真实文档完整有界访问与 Electron functional smoke | cap=`partial`；只提升实际完成的编辑器功能，不以 inventory 或取消量化门槛代替真实验收 |
| `W-REL-COMPLIANCE-01` | `completed` | `partial` | — | `REL-COMPLIANCE` | 许可证文本覆盖完成：123 present / 0 metadata-only / 49 not-installed（可选平台包）；补充许可证目录 licenses/；NSIS 安装包构建成功（SoulForge-0.0.0-x64.exe, 117.7 MB）；electron-builder 已收敛为 NSIS-only | 不提交真实资产、用户 Mod、私有 corpus 或凭据；不得产生 portable release | `scripts/release-compliance-lib.mjs`、`licenses/`、`apps/desktop/electron-builder.json`、`apps/desktop/package.json` | `npm run test:release-compliance-fixtures`、`npm run test:portable-packaging-config-fixtures`、`npm run test:release-content`、`npm run build` | cap=`partial`；不声明 notices、installer lifecycle 或外部分发通过 |
| `W-A-RECOVERY-NATIVE-03` | `completed` | `partial` | — | `A-RECOVERY` | 已完成 EMEVD/MSB 独立文件写入故障矩阵（file_replace pipeline + Bridge staging）；4 阶段 × 2 格式 = 8 cases | `W-A-RECOVERY-NATIVE-02` 已完成；未覆盖 writer 继续失败关闭 | `runStandaloneWriterFailureMatrixSmoke.ts`、Bridge EMEVD/MSB writer | `npm run test:standalone-writer-failure-matrix` | cap=`partial`；仅提升实际覆盖 writer |
| `W-A-RECOVERY-INTEGRATION-04` | `ready` | `partial` | — | `A-RECOVERY` | 继续真实断电恢复、大容量事务恢复、安装/升级后恢复和跨会话 journal 一致性验证 | `W-A-RECOVERY-NATIVE-03` 已完成；需要真实环境测试 | `packages/core/src/transactions/workspaceTransaction.ts`、journal、backup | `npm run test:writer-failure-matrix`、真实断电/大容量 smoke | cap=`partial`；仅提升实际验证的恢复路径 |
| `W-REL-B-CORPUS-02` | `ready` | `partial` | — | `REL-B` | 继续 KRAK 内 BND4 组合 mutation/repack 矩阵、未知字段保持和完整 corpus 写回验证 | `W-REL-B-CORPUS-01` 已完成 KRAK 重压/写回；registry 继续失败关闭 | `scripts/verify-native-dcx-documents.mjs`、Bridge writer | `npm run bridge:verify:dcx-documents` | cap=`native-verified`；只覆盖实际执行的 corpus 操作 |
| `W-EMEVD-FMG-PARAM-03` | `ready` | `partial` | — | `C-EMEVD` / `C-PARAM` | **FMG `add` mutation 已暴露并验证**（TS helper 补 `add`，真实 item.msgbnd add case：不存在的 id 999999999 staged 写入 → Bridge 独立重读文本存在 → 原文件未受影响 → 清理）；**menu.msgbnd 第二语料读验证完成**（15 子项全部 FMG v2 semantic roundtrip）；**MSB `set_part_transform` 重读验证已完成**（Bridge writer 补 rotX/scaleX/scaleY/scaleZ 重读核对，真实 m11 transform case：rotX=82.38、scale [1.05, 1.1, 0.95]）；修复 EmevdNativeWriter CS8629 警告（`patch.NewEventId!.Value`）；继续 FMG 全语言 mutation（本机 corpus 仅 zhocn）、全部 ParamType 写入、登记 MSB 实体编辑、引用完整性和回滚验证 | FMG/PARAM/MSB 子路可独立推进；EMEVD DSL 写链仍依赖 `W-EMEVD-PATCHIR-02`；未知字段/layer 继续失败关闭；FMG 多语言验证受本机 corpus 语言覆盖限制 | Bridge FMG/PARAM/MSB writer、Patch Engine | `npm run bridge:verify:fmg`、`npm run bridge:verify:param`、`npm run bridge:verify:msb` | cap=`partial`；只覆盖实际完成的 mutation 路径 |
| `W-AI-CONFORMANCE-03` | `ready` | `partial` | — | `G-AGENT` | 真实工作区 production typed mutation 多步矩阵已通过 agent loop（20 case：成功 propose→stage→validate→commit→re-read、normal 确认、plan 只读、validation 失败阻止提交、stale revision 冲突、取消/超时/限额不提交、full 权限仍 PATCH_ENGINE_REQUIRED、policy gate 矩阵）；scaffold registry 新增 `workspace.readFile` 等只读工具并给 `patch.proposeTextEdit` 增加内容 hash 前置条件 | `W-AI-CONFORMANCE-02` 已完成错误/取消/超时/限额；不要求真实 provider 凭据 | `packages/core/src/model-services`、`packages/core/src/ai-tools/scaffoldToolRegistry.ts`、`packages/core/src/testing/runAiConformanceSmoke.ts` | `npm run test:ai-conformance`、`npm run test:ai-fake-loop` | cap=`partial`；离线 conformance 不证明第三方服务可用性 |
| `W-ME3-INSTALL-04` | `ready` | `partial` | — | `H-RUNTIME` | 继续 NSIS 安装/升级/卸载验证、真实 Sekiro 会话 launch/terminate 和回滚后重启 | `W-ME3-PROFILE-03` 已完成 profile/launch/terminate adapter；不要求代码签名 | `apps/desktop/electron-builder.json`、`apps/desktop/src/main/me3RuntimeGateway.ts` | `npm run test:me3-runtime-adapter`、NSIS installer lifecycle | cap=`partial`；只提升实际验证的运行操作 |
| `W-REL-COMPLIANCE-02` | `ready` | `partial` | — | `REL-COMPLIANCE` | 继续 NSIS installer lifecycle 验证（安装/升级/卸载/干净目标）、package tree 内容扫描和 manifest/hash 完整性 | `W-REL-COMPLIANCE-01` 已完成许可证文本和 NSIS 构建；不要求代码签名 | `apps/desktop/electron-builder.json`、`scripts/release-compliance-lib.mjs` | `npm run test:release-compliance-fixtures`、`npm run test:release-content` | cap=`partial`；不声明外部分发或签名发布通过 |

### 13.1.1 Active claim 注册表

`ready -> active` 时必须在下表原子登记一个 claim；`active -> completed/blocked/ready/superseded` 时必须删除对应行。claim 只用于并发协调，不构成 Evidence，也不能提升 authority。

| sliceId | claimId | owner | claimedAt | heartbeatAt | recoveryTrigger |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

接手者遇到 `active` 时先通过当前任务/进程状态、工作树变化和 claim owner 核对其仍在执行，不能仅因表中存在 claim 就永久跳过。若 owner 已结束或无法验证、且没有仍在运行的相关写进程，应先保存并审查现有改动，再把切片原子回退为 `ready`；若发现真实外部前置缺失则改为 `blocked` 并引用 §18.4。不得在原 owner 仍可验证为运行中时复制同一切片。

### 13.2 工作切片准入与完成模板

开始任何切片前，在实施证据记录草稿中写明：

~~~markdown
- 切片：W-...
- lifecycle：ready -> active
- capability：...
- 依赖检查：满足 / 不满足
- blockerRefs：无 / BLK-...
- 输入 authority：...
- 允许修改的生产入口：...
- 非目标：...
- required validation：...
- authority 上限：...
- 停止条件：...
~~~

一个切片只有同时满足以下条件才算完成：

1. 开始实施前已将本切片从 `ready` 认领为 `active`；只有 `active` 切片可以由 Q1 跨轮继续。
2. 生产调用链已接通，不只存在孤立 helper 或 scaffold。
3. 失败、unsupported、partial 和 blocked 均返回结构化诊断。
4. required validation 实际运行并记录退出码、样本范围和关键断言。
5. 写能力已通过 staging、validator、commit、重读和适用层级的回滚。
6. 明确记录未验证项和非声明；未达到 authority 上限时不得升级。
7. 验收边界满足后 lifecycle 已改为 `completed`，authority 独立保留；未完成的下游能力已进入后继要求而不是继续复用本切片。

认领 `ready -> active` 是必要的并发协调动作，只改 lifecycle，不构成 Evidence。除此以外，只有切片完成、authority 变化、blocker 变化、required validation 契约变化或跨 Agent 交接时才写回本文；普通微步骤、重复运行同一结果和无状态变化的重试不追加 §17 证据。

发现外部前置不满足时，将 lifecycle 改为 `blocked` 并引用 §18.4 blocker；前置恢复且解锁验证通过后才可改回 `ready`。`completed` / `superseded` 不得作为 `open` Gate 的当前切片；若 Gate 仍有后继要求，必须补充新的 `ready` 或 `active` 切片。

**用户介入判定是结构化状态，不是自然语言猜测。** 只有 §13.1 / §18.3 中 `blocked` 的当前切片或 Gate 通过活动 `blockerRefs` 指向 §18.4，且该 blocker 的责任方与所需输入确实要求用户时，才允许列入“需要用户处理”。`ready` / `active` / `open` 或没有活动 `blockerRefs` 的事项一律由工程方继续推进；公开来源调查、许可证兼容性分析、工具安装、真实测试编排和 Evidence freshness 维护都不得仅凭困难或缺口转成用户介入项。

### 13.3 治理门禁

`W-HANDOFF-INTEGRITY-01`：`test:handoff-integrity`（`node scripts/verify-handoff-integrity.mjs`）已建立并接入根 `package.json`。它解析本文这一唯一事实源，不维护第二份手写状态清单。证据见第 17.1 节 `EV-HANDOFF-20260721`。

门禁只自动覆盖零误报、可确定性判定的子集，当前应检查：

- README、本文和执行手册的 markdown 链接必须存在；README 必须直链本文且不得依赖本机代理规则文件；
- 第 17.1 表内 Evidence ID 唯一且引用闭合；sealed 指纹必须可按 §17.2 重算，passed Gate freshness 只检查显式登记的 Gate 主题域；
- 第 13.1 表必须使用完整十列 schema，lifecycle、authority、`cap=<authority>` 与 blockerRefs 合法；active 切片必须在 §13.1.1 有唯一 claim；
- §18.1 与 §18.3 必须精确保留固定 11 个 Gate；状态、适用性和切片满足 open/blocked/passed 收敛不变量；
- `blocked` Gate 只能引用 blocked 当前切片与 §18.4 blocker；blocker 八字段完整，影响对象与活动引用闭合；
- `passed` / `scope-excluded` 必须引用 sealed Evidence；基础 Gate 不得排除，范围裁定/排除必须带用户批准用途标记；
- 无活动 blockerRefs 的 `ready` / `active` 切片和非 `blocked` Gate 不得要求用户裁定、授权、提供或介入；
- 本文代码块内 `npm run <script>` 必须存在于 `package.json`；
- 本文不得出现 Oodle DLL 文件名、用户主目录绝对路径、API key 或私钥内容。

以下项目仍需工程方语义复核，门禁通过不代表本文全部一致（脚本输出的 `engineeringReviewStillRequired`、`reviewOwner=engineering-agent` 与 `userActionRequired=false` 与此对齐）。它们不是用户验收项，也不得出现在“需要用户处理”报告中：

- Evidence 的命令、样本、结论、Git 引用和用户范围批准是否真实，实施记录是否完整，而不只是结构合法；
- 路线 capability、当前前沿、production 调用链和 authority 上限是否与当前实现语义一致；
- 是否引入被禁止的平行 milestone / task / status / next-actions 文档。

门禁生成的临时报告不得提交为平行进度文档。扩大自动覆盖范围时，必须同步更新脚本的 `checkedRules` 与本节，并保持二者互为镜像。

### 13.4 required validation 冻结约定

切片要真正"可验收"，它的 `required validation` 最终必须解析为可运行的确定命令，而不是自然语言描述。每条 validation 冻结后应能还原为：

~~~text
script        # 根 package.json 中已存在的 npm script 名
fixture       # 输入 fixture 或仓库外 corpus registryId（脱敏）
assertion     # 关键断言与样本范围
exitSemantics # pass=exit 0 且断言执行；skip/unfrozen 语义明确
~~~

面板中尚未冻结的条目（如"新增 inventory smoke""真实 Sekiro / installer lifecycle smoke""WebGPU/WebGL2 functional smoke"）必须显式标注 `validation-unfrozen`，不得被当作已可运行验证。它们只有在写成上述四元组、且 script 进入 package.json 后，才算冻结。

当前显式为 `validation-unfrozen`（需后续冻结）：

- `W-BEHAVIOR-MAP-01`：magic/reference inventory smoke；
- `W-ME3-INSTALL-04`：NSIS installer lifecycle、真实 Sekiro launch/terminate 与 rollback-restart smoke；
- `W-RENDER-FUNCTIONAL-02`：WebGPU/WebGL2 functional fallback smoke；
- `W-REL-F-SCALE-02`：真实文档完整有界访问与 Electron functional smoke；

`W-EMEVD-PATCHIR-02` 的验证已冻结为：

~~~text
script        npm run test:emevd-plan-commit；npm run test:emevd-plan-production；npm run bridge:verify:emevd
fixture       syntheticEmevdBytes 微小合法合成 EMEVD（2 events / 3 instructions，含未知指令）+ EMEDF fixture；本机环境注入时注册 `emevd-primary`（mods/event/common.emevd.dcx，1,730 events / 33,266 instructions）
assertion     四视图 DSL submit 全链：compile → typed plan → Bridge batch staging → file_replace PatchIR → WorkspaceTransaction stage/validate/commit/backup/re-read，提交字节 hash 与 Bridge staged 输出及独立重读一致；after-commit validator 失败自动回滚且原字节恢复、暂存回收、failure 审计；错误 expectedDocumentHash 结构化失败关闭且目标文件不变；native 变体事件级 id/rest typed mutation 经 Bridge 重读可观测且事件/指令计数不变；计划应用于文档 revision+1
exitSemantics 三个命令均须 exit 0 且断言实际执行（native 变体缺环境时诚实 skip，不提升 authority）；只支持 production 接线切片 completed 与既有 partial 边界，不证明完整 EMEDF/layer/游戏加载
~~~

`W-A-RECOVERY-HARNESS-02` 的验证已冻结为：

~~~text
script        npm run test:bridge-recovery-harness；npm run test:bridge-staging；npm run bridge:verify:client
fixture       系统临时目录中的 synthetic protocol-only fake daemon、含 4 MiB 字符串 payload 的背压 frame、四阶段 fault 与 11 个不安全 staging path segment case；不加载 native 资产
assertion     stage/validate/commit/re-read、超限 frame、注册期取消、timeout/cancel、同步/异步 progress、terminal race、背压 close/timeout/cancel、process exit 和显式 restart 全部结算；pending/timer 清理且无迟发 cancel；unhandledRejection=0；staging 不越界且终态无残留
exitSemantics 三个命令均须 exit 0 且断言实际执行才支持 fixture-confirmed；fake daemon、synthetic staging 和可复用 client 不提升任何 production native writer、A-RECOVERY 总体或 REL-A authority
~~~

`W-PARAM-META-01` 的验证已冻结为：

~~~text
script        npm run test:param-metadata-mismatch；npm run test:paramdef-layout
fixture       synthetic metadata package/definition/trust policy/display-only overlay；严格五键 mismatch、SPDX、provenance、hostile primitive、Proxy/accessor/cycle/稀疏数组/undefined、容量与调用方/返回值 mutation 负向 case
assertion     package/source/license/definition digest 与 trust entry 闭合；匹配只读隔离 plain-data 快照；成功结果递归冻结且不冻结调用方输入；64 MiB canonical UTF-8 总预算与 256 条诊断上限失败关闭；snapshotFailureCases=9、aggregateSerializationBudgetCases=1、diagnosticLimitCases=1、immutableSnapshotCases=3
exitSemantics 两个命令均须 exit 0；只支持 fixture-confirmed metadata contract，不证明 Paramdex 数据已捆绑/获准再分发，也不提升 native PARAM parser/writer、真实 metadata source 或 REL-C
~~~

`W-PARAM-META-SOURCE-02` 的验证已冻结为：

~~~text
script        npm run test:smithbox-param-metadata-source
fixture       仓库内最小 XML/license 正负 fixture；可选固定 Smithbox 2.2.4 本机 source slot，公开 release/archive/tree/license digest policy 与撤回列表
assertion     release slot、目录 realpath、文件数、archive/tree/license digest、DTD/entity/symlink、缺失/错版/篡改/升级/撤回均失败关闭；本机源存在时导入 160 definitions、7,028 fields、124 个英文注释类型，59 个 enum 引用解析且 253 个未知引用保持 opaque
exitSemantics 全部确定性负向断言以及配置存在时的真实本机导入均执行且 exit 0 才支持本切片 partial；不提交/打包导入数据，不授予 native PARAM writer 或上游数据再分发权利
~~~

`W-ME3-ADAPTER-01` 的验证已冻结为：

~~~text
script        npm run test:me3-runtime-adapter
fixture       synthetic privileged gateway responses与固定 0.12.1 policy；缺失/歧义、非法 schema/policy、精确版本、截断/超限输出、非零退出、spawn failure、timeout/cancel/close/reject race 和 unsupported operation 共 22 类 contract case
assertion     renderer-safe DTO 不泄漏路径/process/argv/cwd/env；core timeout/cancel 会 abort gateway signal；匹配版本仍为 exit-zero-unverified 且 canPrepareProfile/canLaunch=false；profile/launch/diagnostics/terminate 均结构化 unsupported
exitSemantics 命令须 exit 0 且全部断言执行才支持 fixture-confirmed contract；realMe3Executed=false、realSekiroExecuted=false，不支持 native runtime authority、REL-H 或启动成功声明
~~~

`W-ME3-MAIN-DETECT-02` 的验证已冻结为：

~~~text
script        npm run test:me3-runtime-gateway；npm run test:desktop-security；npm run test:me3-runtime-adapter
fixture       系统临时固定工具槽中的 synthetic executable 正负 case；本机固定 0.12.1 工具槽存在时执行真实 `--version` probe
assertion     main-only realpath/containment、固定 argv、无 shell、最小环境、隐藏窗口、1,024 字节上限、timeout/cancel 与脱敏；renderer IPC 不接受路径；本机真实 probe 识别 0.12.1 但保持 exit-zero-unverified、canPrepareProfile=false、canLaunch=false
exitSemantics 三个命令均须 exit 0；realMe3Executed 可为 true，但 realSekiroExecuted 必须保持 false，本切片只支持 fixture-confirmed detection gateway，不支持 profile/launch 或 REL-H
~~~

`W-ME3-PROFILE-03` 的验证已冻结为：

~~~text
script        npm run test:me3-runtime-adapter；npm run test:me3-runtime-gateway；npm run test:desktop-security
fixture       core 的 25 个闭集 adapter case，包含 profile-create、launch、collect-diagnostics 与 terminate 结果；desktop main 固定工具槽 synthetic 正负 case，以及仅执行 `--version` 的本机 0.12.1 probe
assertion     profile/launch/diagnostics/terminate 继续通过 renderer-safe DTO 和 main-owned gateway；IPC/preload 不接受或返回特权路径、argv、cwd、env；超时、取消、非法响应和缺失进程失败关闭
exitSemantics 三个命令均须 exit 0；只支持 adapter/gateway 接线的 fixture-confirmed，以及真实 me3 version probe 的 exit-zero-unverified；realSekiroExecuted=false、nativeRuntimeAuthority=false，不证明真实启动/终止、回滚后重启、installer lifecycle 或 REL-H
~~~

`W-AI-CONFORMANCE-02` 的验证已冻结为：

~~~text
script        npm run test:model-service-configuration；npm run test:ai-fake-loop；npm run test:openai-responses；npm run test:ai-conformance
fixture       两类本地 contract HTTP/SSE server；空/缺失 config、endpoint/model/credential、非法协议、远程明文或内嵌凭据 endpoint 共 9 个 factory 正负 case；错误分类、timeout、AbortSignal cancel 与 agent limit 共 10 个 conformance case
assertion     空配置返回 MODEL_SERVICE_UNCONFIGURED，不安全配置失败关闭且 networkAttempts=0；双协议错误分类、超时、取消和限额结构化结算；有效协议进入受控 tool loop；plan 写拒绝、full 仍受 Patch Engine/evidence gate、audit 不含 secret
exitSemantics 四个命令均须 exit 0 才支持当前 partial 离线 conformance；不证明第三方 provider 可用，不提升 native mutation authority；真实工作区多步 typed mutation 由 `W-AI-CONFORMANCE-03` 继续
~~~

`W-REL-B-REGISTRY-01` 的验证已冻结为：

~~~text
script        npm run test:release-corpus-registry
fixture       metadata-only synthetic registry；精确 10,000-entry shard 边界；格式、变体、数量、重复、路径和伪装负向 manifest
assertion     schemaVersion/entryCount/format/observedVariant 闭集一致；DFLT/BND4/KRAK 覆盖；26 个负向 case 返回结构化诊断；所有结果 nativeFormatAuthority=false
exitSemantics 全部断言执行且 exit 0 才支持 fixture-confirmed；任何真实 corpus 缺失、skip 或 expectedAuthority 目标值均不得提升 native authority 或 REL-B
~~~

`W-REL-B-CORPUS-01` 的 corpus 登记子验证已冻结为：

~~~text
script        npm run corpus:build-local-release；npm run bridge:verify:dcx-documents
fixture       仓库外 `sekiro-1-6-owner-corpus-v1` 与本机合法 Oodle；locator registry 持有路径，release registry 只持 opaque id/hash/size/resourceKind/format/variant/target operations/privacy class
assertion     当前 corpus 214/214 DCX 分类，16 个重复内容折叠为 198 项；144 DFLT payload/variant no-op、75 BND4 roundtrip/CRUD（11,344 entries）、70 KRAK read；registry 不含 localPath、盘符、UNC、凭据或资产内容，并输出脱敏资源类别/内层扩展名计数
exitSemantics 两个命令必须实际读取全部登记输入并 exit 0 才支持当前 corpus partial；本命令不执行 KRAK 重压/写回，writer authority 只由独立 `bridge:verify:oodle` 与 native writer mutation evidence 建立，未执行的组合 mutation/恢复不得解释为通过
~~~

`W-REL-F-ACCEPT-01` 的验证已冻结为：

~~~text
script        npm run test:release-editor-acceptance；npm run test:desktop-live-editor-contract
fixture       冻结的 BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script 八编辑器 synthetic contract sample；Hex 只读与 FLVER 资产排除；demo/synthetic、authority、revision、typed mutation、完整有界访问和提前 pass 负向 case
assertion     inventory 必须精确等于冻结八项，Hex/raw 不得暴露 mutation，FLVER 不得进入发布编辑器；scopeRulingStatus=user-approved、quantitativeThresholdsRequired=false；输出固定 ok=null、releaseGateDecision=pending、releasePassed=false、realFunctionalAcceptanceRun=false；当前访问/authority 缺口结构化失败关闭
exitSemantics 两个命令均须 exit 0；只支持 candidate harness，不支持真实 Electron 真实文档功能验收或 REL-F；不再等待用户裁定容量、延迟、规模档位或 benchmark 阈值
~~~

`W-REL-SCOPE-01` 的提案验证已冻结为：

~~~text
script        npm run test:release-scope-proposal；npm run test:release-scope
fixture       本文 §18.2.1 唯一 JSON scope proposal block
assertion     27 个必需 scopeItemId/capabilityId 唯一且合法；显式 gateCoverage 精确覆盖 §18.1 全部 11 Gate 并与 §18.3/§18.4 引用闭合；Evidence/registry 引用合法；game/build/ruling metadata 状态一致；无绝对路径；每项保留非声明；私有 fixture registry 不得成为 release corpus
exitSemantics --proposal 在结构合法时输出 ok=null/status=proposal-valid/frozen=false 且 exit 0；默认严格模式在 awaiting-user-ruling 时输出 RELEASE_SCOPE_NOT_FROZEN 且 exit 1
~~~

`W-REL-COMPLIANCE-01` 已冻结为：

~~~text
script        npm run test:release-compliance-fixtures；npm run test:portable-packaging-config-fixtures；npm run test:subprocess-control；npm run build；npm run test:release-content；npm run test:release-reproducible
fixture       package-lock.json、release-compliance-policy.json、严格 NSIS-only electron-builder JSON、实际 desktop out/package/native runtime 输入；系统临时目录内 synthetic config、scratch、subprocess 与内容负向 fixture
assertion     全部 production lockfile 依赖有版本与 allowlist license expression，许可证正文 inventory 为 123 present / 0 metadata-only / 49 not-installed；builder 闭集、portable target/config、workspace link/falsy manifest、scratch root、子进程树 timeout/cancel/output cap 失败关闭；真实输入逐文件 size/SHA-256；manifest 与当前输入逐字一致；连续两次同机构建 manifest 一致；篡改、禁用许可证、凭据路径/内容均失败关闭
exitSemantics 六个命令均须 exit 0 且断言实际执行；当前正文 coverage 不再产生 LICENSE_TEXT_COVERAGE_PARTIAL；任何 skipped 不得解释为完整 REL-COMPLIANCE、installer lifecycle 或 REL-H 通过
~~~

`validation-unfrozen` 不阻止只读 / 研究 / 协议推进，但阻止对应未验证能力被写成运行证据。`test:handoff-integrity` 会拒绝列表中的未知切片，以及 lifecycle 已为 `completed` / `superseded` 的终止切片；具体 smoke 是否足以支撑目标 authority 仍属于 §13.3 的人工语义审查。

---

## 14. 代码模块地图

### Shared

| 路径 | 职责 |
|---|---|
| `packages/shared/src/bridge-protocol.ts` | Bridge daemon frame、capability、authority 和 native DTO |
| `packages/shared/src/patch-ir.ts` | production mutation / patch schema |
| `packages/shared/src/writer-contract.ts` | writer staging contract |
| `packages/shared/src/resource-graph.ts` | 资源图 DTO |
| `packages/shared/src/resourceSymbols.ts` | event/map/param/msg 索引投影，不是无损文档 |
| `packages/shared/src/scene-ir.ts` | browser-safe semantic scene / render packet 单一契约；只接收相对路径和资源 URI |
| `packages/shared/src/ai-tools.ts` | typed AI 工具协议 |
| `packages/shared/src/audit-log.ts` | 审计 schema |
| `packages/shared/src/vfs.ts` | VFS；renderer-safe DTO 不得泄漏绝对路径 |
| `packages/shared/src/paramdef.ts` | PARAM metadata package/source/license/trust/overlay DTO；不是 native PARAM document |

### Core

| 领域 | 典型职责 |
|---|---|
| workspace / VFS | 工作区 session、overlay/base、扫描与路径边界 |
| patch / transaction | staging、validator、commit、rollback、recovery |
| database | SQLite repositories、migration、journal、jobs、audit |
| bridge client | daemon 生命周期、取消、超时和崩溃处理 |
| native adapters | Bridge native document / writer 调用 |
| param metadata | 不可信 metadata 快照、内容寻址、许可证/信任匹配和 display-only overlay |
| runtime adapters | renderer-independent runtime contract 与 me3 detection/profile/launch/diagnostics/terminate orchestration；特权发现、路径和进程控制仍归 main |
| resource graph | 索引、引用、诊断和 evidence projection |
| assets / scene | 资产导入、semantic scene、render projection |
| model-services | provider adapters、agent loop、permissions |

### Bridge

`bridge/SoulForge.Bridge` 负责：

- native envelope / container / semantic document；
- native mutation；
- 暂存区 writer；
- 重读和 roundtrip validator；
- Oodle runtime 发现和 KRAK adapter；
- 结构化 diagnostics。

### Desktop

`apps/desktop` 负责：

- main-owned filesystem、session、confirmation、safeStorage 和 utility process；
- main-owned me3 固定工具槽、版本探测、profile/launch/diagnostics/terminate 特权边界；
- preload renderer-safe API；
- React 工作台、编辑器、AI 侧栏和渲染视口；
- 所有写入请求经 main/core/Patch Engine。

### 14.1 生产调用链导航

| 能力 | 生产入口与关键链路 | 对应验证入口 |
|---|---|---|
| 工作区与路径边界 | `packages/core/src/workspace/workspaceSession.ts`、`packages/core/src/workspace/pathBoundary.ts`、`packages/core/src/pipeline/workspacePipeline.ts` | `packages/core/src/testing/runV05SecurityBoundarySmoke.ts`、`packages/core/src/testing/runV05FullFileWorkbenchSmoke.ts` |
| Patch Engine 与持久提交 | `packages/core/src/patch/patchEngine.ts`、`packages/core/src/transactions/workspaceTransaction.ts`、`packages/core/src/patch/durablePatchCommit.ts`、`packages/core/src/patch/rollback.ts` | `packages/core/src/testing/runV05WritePathConsolidationSmoke.ts`、`packages/core/src/testing/runV05FileRollbackSmoke.ts`、`packages/core/src/testing/runSqliteCrashRecoverySmoke.ts` |
| Bridge 生命周期 | `packages/core/src/bridge/runBridge.ts`、`packages/core/src/bridge/bridgeDaemonClient.ts` -> `bridge/SoulForge.Bridge/BridgeDaemonHost.cs` -> `bridge/SoulForge.Bridge/BridgeCommandService.cs` | `packages/core/src/testing/runBridgeDaemonClientSmoke.ts`、`packages/core/src/testing/runBridgeDaemonCrashSmoke.ts`、`packages/core/src/testing/runBridgeRecoveryHarnessSmoke.ts`、`scripts/verify-bridge-daemon.mjs` |
| DFLT/KRAK 容器 | `bridge/SoulForge.Bridge/DcxNativeDocument.cs` + `OodleRuntime.cs`；KRAK rebuild 经 `Bnd4NativeWriter.cs` 与 `packages/core/src/writers/containerChildReplaceWriter.ts` 进入 transaction | `scripts/verify-native-dcx-documents.mjs`、`scripts/verify-oodle-runtime.mjs`、`packages/core/src/testing/runNativeWriterFailureMatrixSmoke.ts` |
| BND4 子项写入 | `packages/core/src/editing/saveContainerChild.ts` -> `bridge/SoulForge.Bridge/Bnd4NativeDocument.cs` / `bridge/SoulForge.Bridge/Bnd4NativeWriter.cs` -> `WorkspaceTransaction` | `packages/core/src/testing/runNativeBnd4WriterSmoke.ts`、`packages/core/src/testing/runNativeBnd4TransactionSmoke.ts` |
| FMG | `packages/core/src/editing/fmgBridgeCommit.ts` -> `bridge/SoulForge.Bridge/FmgNativeDocument.cs` / `bridge/SoulForge.Bridge/FmgNativeWriter.cs` -> BND4 transaction | `packages/core/src/testing/runNativeFmgSmoke.ts` |
| PARAM | `packages/core/src/editing/paramBridgeCommit.ts` -> `bridge/SoulForge.Bridge/ParamNativeDocument.cs` / `bridge/SoulForge.Bridge/ParamNativeWriter.cs`; metadata contract 由 `packages/core/src/param/paramMetadata.ts` 隔离、验证和匹配，再由 `packages/core/src/param/paramdefLayout.ts` 投影 | `packages/core/src/testing/runNativeParamSmoke.ts`、`packages/core/src/testing/runParamDuplicateNativeSmoke.ts`、`packages/core/src/testing/runParamMetadataMismatchSmoke.ts`、`packages/core/src/testing/runParamdefLayoutSmoke.ts` |
| EMEVD native / 四视图 / DSL 写链 | `packages/core/src/editing/emevdFourViewController.ts`（`submitEmevdDslPlanViaFourView`）-> `packages/core/src/editing/emevdPlanCommit.ts`（`stageEmevdPlanViaBridge` + `buildEmevdFileReplacePatch`）-> `packages/core/src/editing/emevdBridgeCommit.ts`（batch `write-emevd`）-> `bridge/SoulForge.Bridge/EmevdNativeWriter.cs` -> `executePatchIrThroughTransaction` / `WorkspaceTransaction` | `packages/core/src/testing/runNativeEmevdSmoke.ts`、`packages/core/src/testing/runEmevdFourViewSmoke.ts`、`packages/core/src/testing/runEmevdIpcContractSmoke.ts`、`packages/core/src/testing/runEmevdPlanCommitProductionSmoke.ts` |
| MSB | `packages/core/src/editing/msbBridgeRead.ts` / `packages/core/src/editing/msbBridgeCommit.ts` -> `bridge/SoulForge.Bridge/MsbNativeDocument.cs` / `bridge/SoulForge.Bridge/MsbNativeWriter.cs`; scene 单一契约在 `packages/shared/src/scene-ir.ts`，core/renderer 只消费该契约 | `packages/core/src/testing/runNativeMsbSmoke.ts`、`packages/core/src/testing/runFmgMsbIpcContractSmoke.ts`、`packages/core/src/testing/runSceneDrawListSmoke.ts`、`packages/core/src/testing/runThreeSceneModuleSmoke.ts` |
| TAE / ESD 只读文档 | `bridge/SoulForge.Bridge/TaeNativeDocument.cs`、`bridge/SoulForge.Bridge/EsdNativeDocument.cs` -> desktop 只读工作台；无 native writer | `packages/core/src/testing/runNativeTaeSmoke.ts`、`packages/core/src/testing/runNativeEsdSmoke.ts` |
| FLVER / TPF 只读与开放格式导出 | `bridge/SoulForge.Bridge/FlverNativeDocument.cs`、`bridge/SoulForge.Bridge/TpfNativeDocument.cs` -> renderer 只读投影；`packages/core/src/export/flverToGlb.ts` 只生成开放格式 | `packages/core/src/testing/runNativeFlverSmoke.ts`、`runNativeFlverMeshSmoke.ts`、`runNativeFlverGlbSmoke.ts`、`runNativeTpfSmoke.ts` |
| AI 工具循环 | `packages/core/src/model-services/*Adapter.ts` -> `packages/core/src/model-services/agentLoop.ts` -> `packages/core/src/ai/toolRegistry.ts` / `packages/core/src/ai-tools/policyGate.ts` -> Patch Engine required | `packages/core/src/testing/runAiFakeLoopSmoke.ts`、`packages/core/src/testing/runOpenAiResponsesSmoke.ts`、`packages/core/src/testing/runAiConformanceSmoke.ts` |
| me3 运行适配 | `apps/desktop/src/main/ipc.ts` 创建 `MainMe3RuntimeGateway` / `Me3RuntimeAdapter` -> `apps/desktop/src/main/me3RuntimeGateway.ts` 固定工具槽与进程边界 -> `packages/core/src/runtime/me3RuntimeAdapter.ts` / `packages/core/src/runtime/gameRuntimeAdapter.ts`；preload 只暴露 renderer-safe DTO | `packages/core/src/testing/runMe3RuntimeAdapterSmoke.ts`、`apps/desktop/src/main/me3RuntimeGatewaySmoke.ts`、`scripts/verify-desktop-security.mjs`；真实执行只覆盖固定 0.12.1 version probe，不代表真实 Sekiro 会话或 REL-H |
| Desktop IPC | `apps/desktop/src/main/ipc.ts` 持有路径、确认、凭据和 writer 调用；preload 暴露 renderer-safe API | `packages/core/src/testing/runDesktopLiveEditorContractSmoke.ts`、`scripts/verify-desktop-security.mjs` |

表中的路径均相对于仓库根。修改公共协议时必须同时搜索生产调用方和上述验证入口；测试 helper 不能作为 production authority。

### 14.2 待接线 contract 导航

当前没有已冻结但仍缺 production 调用链的 me3 contract。detection/profile/launch/diagnostics/terminate 已进入 §14.1；真实 Sekiro 会话、回滚后重启和 installer lifecycle 属于 `W-ME3-INSTALL-04` 的验收缺口，不得再写成"desktop main gateway 尚未接线"。

| 已冻结 contract | 当前已有 | 缺失的 production 调用链 |
|---|---|---|
| BND4 语义编辑器 + canonical DSL | BND4 native document/writer 已存在，发布 inventory 已登记 `bnd4` | 尚无统一 editor document/selection/revision/DSL/typed-mutation 工作台 |
| 脚本语义编辑器 + canonical DSL | 发布 inventory 已登记 `script`，执行不受信脚本已禁止 | 尚未从 Sekiro corpus 冻结脚本格式、native document/schema/typecheck/writer 和工作台 |

本节只记录已经冻结、但尚未形成 production 调用链的契约；不得把 contract-only helper 或 inventory 登记写成产品可用入口。

---

## 15. 验证命令

最低公开回归：

~~~powershell
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
~~~

Bridge 与持久化：

~~~powershell
npm run bridge:build
npm run bridge:verify:daemon
npm run bridge:verify:client
npm run bridge:verify:crash
npm run test:bridge-recovery-harness
npm run test:bridge-staging
npm run test:database-utility
npm run test:sqlite-crash-recovery
~~~

公开 metadata、runtime 与发行 contract：

~~~powershell
npm run test:param-metadata-mismatch
npm run test:paramdef-layout
npm run test:me3-runtime-adapter
npm run test:release-corpus-registry
npm run test:release-editor-acceptance
npm run test:release-compliance-fixtures
npm run test:portable-packaging-config-fixtures
npm run test:subprocess-control
~~~

已有 native 路线命令：

~~~powershell
npm run bridge:verify:oodle
npm run bridge:verify:dcx-documents
npm run bridge:verify:bnd4-writer
npm run bridge:verify:bnd4-transaction
npm run bridge:verify:fmg
npm run bridge:verify:param
npm run bridge:verify:emevd
npm run bridge:verify:msb
npm run bridge:verify:tae
npm run bridge:verify:esd
npm run bridge:verify:flver
npm run bridge:verify:flver-mesh
npm run bridge:verify:flver-glb
npm run bridge:verify:tpf
npm run test:native-preview
~~~

EMEVD DSL 写链与行为研究：

~~~powershell
npm run test:emevd-plan-commit
npm run test:emevd-plan-production
npm run test:emevd-coverage
npm run probe:behavior-headers
~~~

`probe:behavior-headers` 需要 `SOULFORGE_SEKIRO_GAME_ROOT`，缺失时结构化失败关闭；它是 W-BEHAVIOR-MAP-01 的本机研究工具，输出不提交、不提升 authority。

### 15.1 路线验证矩阵

| 路线 | Required commands | 证明范围 | 明确不证明 |
|---|---|---|---|
| 全局公开回归 | `typecheck`、`test`、`bridge:verify:synthetic`、`build` | TypeScript、公开 smoke、synthetic Bridge、桌面构建 | 私有 native corpus、真实游戏、真实模型服务 |
| A 工作区/事务 | `test`、`test:bridge-recovery-harness`、`test:bridge-staging`、`test:database-utility`、`test:sqlite-crash-recovery` | 安全边界、SQLite、utility restart、Bridge/staging 公开故障注入与回收 | 真实断电、磁盘错误、所有 native writer 崩溃点 |
| Bridge daemon | `bridge:build`、`bridge:verify:daemon`、`bridge:verify:client`、`bridge:verify:crash`、`test:bridge-recovery-harness` | transport、出站 pending 清理、取消/超时/progress/背压/崩溃失败关闭 | native 写事务在所有字节边界的恢复 |
| B release corpus | `test:release-corpus-registry`、`corpus:build-local-release`、`bridge:verify:dcx-documents` | metadata-only schema/失败关闭；配置存在时证明当前登记 corpus 的 100% DFLT/BND4/KRAK 分类、DFLT/BND4 no-op/CRUD 与 KRAK read | registry 命令自身不执行或授予 KRAK 重压/writer authority；独立 writer case、恢复、未登记变体或 REL-B |
| B DFLT/BND4 | `bridge:verify:dcx-documents`、`bridge:verify:bnd4-writer`、`bridge:verify:bnd4-transaction` | 命令实际覆盖的容器布局、mutation 和回滚 | KRAK 内 BND4、新 flags/布局、发布全集 |
| B KRAK/Oodle | `bridge:verify:oodle` 加合法本机成功路径 | runtime 发现、兼容性和执行到的 KRAK case | 缺 runtime 时的 exit 0 或失败关闭不证明成功路径 |
| C FMG | `bridge:verify:fmg` | 实际 msgbnd/child/corpus 的读取、mutation、重读和事务；FMG `add` staged mutation（真实 item.msgbnd：add 不存在 id → 独立重读文本存在 → 原文件未受影响）；menu.msgbnd 第二语料 15 子项 FMG v2 semantic roundtrip | 其他语言/msgbnd、游戏加载 |
| C PARAM | `bridge:verify:param`、`test:paramdef-layout`、`test:param-metadata-mismatch`、`test:param-duplicate-native`、`test:smithbox-param-metadata-source`、`test:param-metadata-native` | 已覆盖 native 布局/raw row、metadata package/match/trust/overlay、固定 Smithbox 本机来源和 135/138 登记 native 一致性 | 3 个已知旧布局、完整字段引用与全 corpus；不证明上游数据可随 SoulForge 再分发 |
| C EMEVD | `bridge:verify:emevd`、`test:emevd-dsl-compiler`、`test:emedf-schema`、`test:emevd-four-view`、`test:emevd-ipc-contract`、`test:emevd-plan-commit`、`test:emevd-plan-production`、`test:emevd-coverage`、`test:emevd-full-document` | 已覆盖 header/event/instruction/args/mutation、稳定 anchor、DSL parse/typecheck/plan、UI 协议，以及 DSL plan → Bridge batch → PatchIR transaction 的 production 接线（stage/commit/re-read/rollback，合成 + 真实 common.emevd 事件级 mutation）；真实 corpus 指令分布（142 种/33,266 条）与 EMEDF 覆盖长度一致性分析（fixture 覆盖 1 种、2000:0 多长度变体如实报告）；DSL 顶层 instruction 块（全局指令级 typed mutation：跨事件引用 + 与事件内写法计划操作等价 + 跨作用域重复写拦截）；完整文档分页组装（分页读取连续性/总数/事件切片校验、DCX 直读解压产物复用，真实 1,730 events / 33,266 指令 / 34 页）与四视图 DSL 提交 UI 接线（main 权威完整文档缓存、renderer 仅编辑 DSL 文本、提交前 fresh 重读 + production 写链提交） | layer 变体、完整 EMEDF 类型布局/control-flow、游戏加载；分布只有长度签名，不构成参数类型声明 |
| C MSB | `bridge:verify:msb`、`test:fmg-msb-ipc-contract`、`test:param-msb-write-ipc-contract` | 已覆盖 model/part/region/event 和 transform mutation；`set_part_transform` 重读验证（真实 m11：rotX/scaleX/scaleY/scaleZ 核对，part 数不变） | 全实体 CRUD、引用修复、完整场景 |
| D 行为/动画 | `bridge:verify:tae`、`bridge:verify:esd` | 登记样本的 TAE/ESD native document 结构与只读投影 | 全布局、完整事件/状态语义、HKX/脚本引用、typed mutation、writer、游戏加载 |
| E/I 资产渲染 | `bridge:verify:flver`、`bridge:verify:flver-mesh`、`bridge:verify:flver-glb`、`bridge:verify:tpf`、`test:scene-draw-list`、`test:three-scene-module` | 登记 FLVER/TPF native document、FLVER mesh/GLB 开放格式导出、semantic render packet 与 renderer contract | MTD/collision/navigation、完整材质/纹理关联、native writer、所有者机器完整 fallback/resource lifecycle、游戏加载 |
| F 专业编辑器 | `test:editor-document-store`、`test:hex-scene`、`test:desktop-live-editor-contract`、`test:release-editor-acceptance`、`test:ui-localization`、`test:emevd-full-document`、`test:emevd-dsl-compiler` | document/revision/IPC/静态本地化契约；冻结八项 inventory、只读 Hex、FLVER 排除、无量化门槛的完整有界访问 schema 与失败关闭；EMEVD 规模访问 `pagination`（分页组装、DSL 模板行数截断 + 完整模板按需加载、事件列表分页，`currentScaleContractGaps` 不含 EMEVD） | BND4/script 工作台、TAE/ESD 写链、八个真实语义编辑器、完整有界访问、真实 Electron 文档功能验收或 REL-F |
| G AI | `test:model-service-configuration`、`test:ai-fake-loop`、`test:openai-responses`、`test:ai-conformance`、`test:model-service-vault-contract`、`test:vault-encrypt-contract` | 双协议 fake provider/tool loop、权限/凭据契约、空配置/不安全 endpoint 零网络失败关闭，以及错误/取消/超时/限额 10 case | Context Broker、outbound 最小化与真实工作区 production 多步写任务；真实服务账号/计费不是 V0.5 验收 |
| H me3 adapter/gateway | `test:me3-runtime-adapter`、`test:me3-runtime-gateway`、`test:desktop-security` | renderer-safe adapter、main-owned 固定工具槽/argv detection gateway、真实 0.12.1 version probe，以及 profile/launch/diagnostics/terminate 的 fixture-confirmed contract 与生产接线 | 真实 Sekiro 会话、成功进程树终止、回滚后重启、installer lifecycle 或 REL-H；exit 0/version 字符串不授予 native runtime authority |
| H 发行/运行 | `test:release-compliance-fixtures`、`test:portable-packaging-config-fixtures`、`test:subprocess-control`、`test:release-content`、`test:release-reproducible`、`test:portable-packaging-gate`、`test:private-native-gate`、`test:section28-sekiro-gate` | 内容/许可证 inventory、严格配置、scratch/subprocess 控制、同机指纹、环境门禁和诚实 partial/skipped | 完整 notices、实际 NSIS 安装/升级、跨机复现、真实启动成功；skip 不是 pass，代码签名不属于验收 |

根 `package.json` 是命令入口 authority；本文是命令用途和证据语义 authority。新增或删除相关 script 时必须同步更新本矩阵。

### 15.2 本机环境契约

| 变量/输入 | 使用者 | 规则 |
|---|---|---|
| `SOULFORGE_DOTNET` | Bridge build/run | 可选的受控 dotnet 路径；不得提交本机值 |
| `SOULFORGE_SEKIRO_GAME_ROOT` | Oodle、private native、section-28 | 必须由用户合法拥有并显式提供；始终只读；未设置只能产生 `unverified`/`skipped` |
| `SOULFORGE_NATIVE_FIXTURE_ROOT` | private native gate | 指向私有 fixture 根；不得位于 Git 提交范围，不得记录真实绝对路径 |
| `SOULFORGE_SCRATCH` | private/packaging/section-28 gate | 可选临时输出根；必须在 Mod 与原版目录之外，可安全清理 |
| `SOULFORGE_UNPACKED_PACK=1` | legacy-named unpacked package inspection gate | 仅允许生成供内容扫描的 unsigned `--dir` 中间产物；不是 V0.5 distributable portable，也不等于安装或发布通过 |
| 模型服务 endpoint/key | desktop main + safeStorage | V0.5 默认留空且验收不要求真实凭据；如所有者日后自愿配置，key 只能由 main 解析，证据记录只写 provider 类型、endpoint 类别和脱敏结果 |

私有 corpus 必须在仓库外维护注册信息；本文只记录脱敏后的 `registryId`、版本和计数。注册表至少包含：

~~~text
registryId
game
gameBuild
schemaVersion
createdAt
entryCount
entries[]:
  logicalId
  sha256
  size
  containerChain
  resourceKind
  format
  observedVariant
  permittedOperations
  expectedAuthority
  privacyClass
~~~

单个 registry shard 必须满足 `entryCount == entries.length <= 10000`，超出时在仓库外分片；每个 shard 仍须覆盖其声明的格式分类。`observedVariant` 必须按 `format` 使用当前 Bridge 已审查的冻结闭集，未知或跨格式变体失败关闭。`logicalId` 不得包含用户目录；`containerChain` 只允许规范化的游戏内逻辑路径或哈希化标识，URI、绝对路径、UNC、drive-relative、空段、`.` / `..` 穿越均失败关闭。命令输出若包含绝对路径，写入证据前必须脱敏。

运行私有命令前必须记录：游戏版本、样本注册标识、相关文件哈希、Bridge/.NET 版本和是否允许启动游戏。不得把本机绝对路径、文件内容或 Oodle DLL 写入本文。

### 15.3 结果分类

- `pass`：命令退出 0 且实际执行了目标断言；必须记录样本范围。
- `skipped`：环境不满足，门禁诚实跳过；不支持任何成功路径声明。
- `fixture-confirmed`：只证明构造样本、协议或事务骨架。
- `candidate`：只证明探测或候选解释，没有无损 authority。
- `failed`：记录原始错误、分类、最小修复和复验结果；不得通过放宽断言改写为 pass。
- `partial`：同一命令内同时有已证实与未覆盖范围，必须分别列出。

真实游戏和私有 corpus 命令只有在本机具备合法环境时才有权产生 `native-verified` 证据。没有环境时必须诚实记录 `skipped` / `unverified`。

测试名中的 `v0.5`、`v0.6`、`native` 或 `section28` 不能单独证明对应产品能力完成；必须检查实际断言、样本范围和运行结果。

---

## 16. 停止条件与禁止权宜措施

遇到以下条件，停止对应写能力并记录证据：

- native 样本与 parser 假设冲突；
- 未知字段无法无损保留；
- no-op roundtrip 无法证明；
- writer 输出无法重读；
- Oodle runtime 不兼容；
- Paramdef / Paramdex metadata 与 row size 不匹配；
- DB migration 无法幂等；
- after-commit 失败无法恢复；
- renderer 获得绝对路径或铸造权限；
- validator coverage 不完整；
- 真实游戏 smoke 崩溃；
- 性能只能靠关闭验证或安全门达到。

禁止：

- hardcode 本机路径；
- commit DLL、真实资产、用户 Mod、API key、签名私钥或私有 corpus；
- catch 后返回成功；
- 把 unknown 当默认值重写；
- raw replace 冒充 native writer；
- fixture / candidate 冒充 native；
- 为通过测试删除或放宽断言；
- 在完全权限中绕过 Patch Engine；
- 长期保留两套 production parser、协议、数据库或写入主干；
- 把 Three.js renderer object 当作权威场景文档；
- 自行实现 Mod loader 取代 me3，除非未来有独立、明确的用户裁定。

---

## 17. 实施证据与留痕规则

本文是唯一当前地图和进度来源，但不是强制 Agent 的工单系统。

只有发生以下任一治理事件时才写回本文：切片完成、authority 变化、blocker 变化、required validation 契约变化或跨 Agent 交接。普通微步骤、无状态变化的重试和重复取得同一结果不追加 Evidence；`ready -> active` 认领只更新 §13.1 lifecycle，不生成 Evidence。

发生上述治理事件时，应按实际影响同步更新：

1. 对应区域地图的“已有 / 仍缺 / 状态”；
2. “当前技术前沿”表；
3. 本节末尾追加一条自包含证据记录。

记录至少包括：

- 日期；
- 起始 commit 与结束 commit / 五字段工作树指纹；
- 实现内容；
- 运行命令和结果；
- 样本 / corpus 范围；
- lifecycle 与 authority 变化；
- 未验证项；
- 非声明；
- blockerRefs 与外部阻塞。

### 17.1 当前证据索引

证据分为三类：

- `sealed-current-run`：命令在当前工作树实际运行，能够复述退出码和断言边界，并按下方五字段契约封存精确工作树。它可以在声明范围内支持 authority 变化、Gate `passed` 或 `scope-excluded`。
- `unsealed-record`：保留真实运行观察，但基线仍是“当前工作树”“同上”或其他无法精确复原的描述。它不能支持新 authority、Gate `passed` 或 `scope-excluded`，也不能因文档迁移自动升级为 sealed。
- `historical-record`：可从 Git 中定位到旧交接记录或实现提交，但本轮没有重新取得私有样本结果。它可以维持既有、范围明确的历史状态，不能支持扩大范围。

范围裁定使用机器可判定的声明标记：支持 `REL-SCOPE passed` 的 Evidence 必须在“能力/声明”列包含 `scope-ruling:user-approved`；支持某功能 Gate 排除的同一或后继 Evidence 还必须包含 `scope-exclusion:<GateId>:user-approved`。标记只让门禁验证证据用途，用户是否真实批准仍属于人工真实性审查。Agent 不得用标记引入或改变未经批准的范围；但当 §18.2.1 冻结语义未变时，工程方可以在重跑范围验证后通过 `revalidates=<既有用户批准 EvidenceId>` 继承既有标记完成 freshness 维护，不需要再次请求用户授权。

| Evidence ID | 类型 | 能力/声明 | 基线 | 命令或记录 | 样本/范围 | 本轮结论与边界 |
|---|---|---|---|---|---|---|
| `EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER` | `sealed-current-run` | `scope-ruling:user-approved`；`revalidates=EV-AUTONOMOUS-GOVERNANCE-20260731`；将未自动覆盖的语义复核显式归属工程方 | `HEAD=481da6d2352802a5d18485ada2bb0d9b684695fe; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=6a23687b3dd25baf53e5ef270692faff05b78fa6c9b318c15975ee5781647ef4; fingerprintSha256=95439805b18406ce8bd56a977a3c9271c66f1001658794a0582e69a592f71c5b` | `node --check scripts/verify-handoff-integrity.mjs`、`node scripts/verify-handoff-integrity-fixtures.mjs`（47 cases）与 `git diff --check` 均 exit 0；追加本记录后 `npm run test:release-scope`、`npm run test:handoff-integrity` 均 exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | handoff 输出字段为 `engineeringReviewStillRequired`、`reviewOwner=engineering-agent`、`userActionRequired=false`；旧字段只保留在历史 Evidence 叙述中，不再由当前门禁输出 | 只澄清工程复核责任并重验证未变化的冻结范围；不删除诚实性复核，不改变范围、authority、Gate 功能状态或 V0.5 完成状态 |
| `EV-AUTONOMOUS-GOVERNANCE-20260731` | `sealed-current-run` | `scope-ruling:user-approved`；`revalidates=EV-GOVERNANCE-RECONCILIATION-20260731`；在冻结范围 JSON 不变时，将 Evidence freshness、公开来源与许可证调查固定为工程自持 | `HEAD=c103e414ab92cb1dbe643572374aff90cc2b1373; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=ceb5fec39c891acb5b8192b2f5c3be661f42780adaea51ae446d01f2759353f7; fingerprintSha256=cbae6d0ba431401459606441a2c54c171912f4dfb25cf9af00fc90024f584b3d` | `npm run test:release-scope-fixtures`（35 cases）、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`node scripts/verify-handoff-integrity-fixtures.mjs`（47 cases）、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 与 `git diff --check` 均 exit 0；追加本记录后 `npm run test:handoff-integrity` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | REL-SCOPE freshness 主题域只含唯一 BEGIN/END 范围 JSON、release-scope verifier/fixtures、handoff freshness verifier/fixtures 与指纹生成器；覆盖无关改动不失效、范围块或校验器改动失败关闭、不可验证历史失败关闭、无活动 blocker 禁止请求用户、非范围 Evidence 不得掩盖 stale scope ruling | 只支持治理规则和未变化范围的工程重验证；不改变 27 项支持/排除边界，不提升任何 parser/writer/runtime/render/release authority；未完成完整 EMEDF 类型 adapter，找不到合法来源时仍保持 opaque 与 `partial/unsupported`；不关闭任何功能 Gate，不声明 V0.5 完成或允许外部分发 |
| `EV-PUBLIC-20260720` | `unsealed-record` | 公开回归 | `2002076` + 当前工作树 | `typecheck`、`test`、`bridge:verify:synthetic`、`build` 均 exit 0 | 公开 synthetic、core smoke、Electron 43 utility build/smoke | 证明 2026-07-20 公开构建和测试观察；因基线未封存，不支持新的 authority 或 Gate 终态；不提升任何私有 native、真游戏或真模型服务 authority |
| `EV-A-SAFETY-20260720` | `unsealed-record` | A 路线公开安全/事务底座 | 同上 | `npm test` | junction/symlink 越界、after-commit 恢复、rollback hash 冲突、SQLite migration/journal/jobs、utility restart | 保留 A 路线公开验证观察；因基线未封存，不支持新的 authority 或 Gate 终态；真实断电、磁盘错误、全部 native writer 故障矩阵仍未验证 |
| `EV-PUBLIC-20260724` | `unsealed-record` | 当前公开回归 | `2002076` + 当前工作树 | `npm run test:handoff-integrity`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0 | 公开 synthetic、core smoke、Electron 43 utility build/smoke | 保留 2026-07-24 当前工作树公开构建和测试观察；因基线未封存，不支持新的 authority 或 Gate 终态 |
| `EV-PUBLIC-20260725` | `unsealed-record` | 发布合规改动后的公开回归 | `2002076` + 当前工作树 | 顺序运行 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0；最终 `npm run test:handoff-integrity`、`git diff --check` exit 0 | 公开 synthetic、core smoke、Electron 43 utility build/smoke；根 build 在 utility smoke 临时 bundle 后恢复 production out 并生成 compliance manifest | 保留本轮 native binding 路径、`/Brepro`、AI synthetic token 与发布脚本观察；因基线未封存，不支持新的 authority 或 Gate 终态；handoff 仍返回 `manualReviewStillRequired` |
| `EV-A-RECOVERY-20260724` | `unsealed-record` | 公共 writer 家族 + BND4 native writer 故障矩阵 | `2002076` + 当前工作树 | `npm run test:writer-failure-matrix`、`npm run test:native-writer-failure-matrix` exit 0 | text edit、text/binary file replace、raw range 共 16 cases；注册 `chrbnd-primary` 共 4 cases；均覆盖 stage / staged-output validate / backup-create commit / after-commit re-read | 保留 20 个 case 的结构化失败观察；因基线未封存，不支持新的 authority 或 Gate 终态；尚未覆盖四种语义格式 Bridge 进程中途崩溃 |
| `EV-B-KRAK-20260724` | `unsealed-record` | 合法 Oodle runtime 与注册 KRAK 解压 preview | `2002076` + 当前工作树 | 本机环境注入后 `npm run bridge:verify:oodle` exit 0 | 一个注册 `DCX-KRAK` fixture；runtime x64/version/export 校验与完整 preview 解压 | 保留 KRAK read preview `partial` 观察；因基线未封存，不支持新的 authority 或 Gate 终态；不证明发布 corpus、KRAK 重压、BND4 内层闭环或 writer |
| `EV-PRIVATE-20260724` | `unsealed-record` | 私有 native 汇总门禁 | `2002076` + 当前工作树 | 本机环境注入后 `npm run test:private-native-gate` exit 0，结构化状态 `partial` | EMEVD 1,730/33,266；FMG 18/18；PARAM 38/40；MSB 34 models / 4,500 parts / 1,089 regions / 46 events | 保留 EMEVD/FMG 通过、PARAM 2 个未覆盖布局和 MSB candidate 观察；因基线未封存，不支持新的 authority 或 Gate 终态；门禁不得汇总为全绿 |
| `EV-REL-COMPLIANCE-20260725` | `unsealed-record` | production 依赖许可证 inventory、发行输入内容安全与同机可复现构建 | `2002076` + 当前工作树 | `npm run test:release-compliance-fixtures`、`npm run build`、`npm run test:release-content`、`npm run test:release-reproducible`、`npm run test:portable-packaging-gate` 均 exit 0 | 170 个 production lockfile 依赖、9 种 allowlist expression；116 个依赖有已安装许可证正文、54 个 metadata-only；11 个实际 desktop out/package/native runtime 输入；6 类正/负 fixture | 保留同机 fingerprint 一致和内容扫描观察；因基线未封存，不支持新的 authority 或 Gate 终态；portable 仍为 `ok=null/status=partial/dryPackStatus=skipped`，不证明 notices、installer、签名或发布渠道 |
| `EV-REL-SCOPE-20260725` | `unsealed-record` | V0.5 支持范围提案结构与未裁定失败关闭语义 | `2002076` + 当前工作树 | `node scripts/verify-release-scope.mjs --proposal` exit 0；默认 `node scripts/verify-release-scope.mjs` 按预期 exit 1 | 27 个 scope items；显式 `gateCoverage` 覆盖 §18.1 全部 11 Gate；行为拆分 TAE/ESD/Lua-HKS，资产拆分 FLVER/TPF/MTD/collision/navigation/open conversion；§3.1 capability、§17.1 Evidence 与脱敏 registry 逻辑引用 | `--proposal` 输出 `ok=null/status=proposal-valid/frozen=false`；默认模式命中 `RELEASE_SCOPE_NOT_FROZEN`。build/ruling metadata 保持 pending/null；该证据只完成提案 artifact，不是用户裁定、sealed Evidence、REL-SCOPE 完成或任何功能 authority 提升 |
| `EV-REL-SCOPE-20260730` | `sealed-current-run` | `scope-ruling:user-approved`；V0.5 的 27 项目标范围、版本族、语义编辑边界与项目所有者内部测试发行边界 | `HEAD=e32e8144225ee904e38e87102470cf84bd428075; trackedDiffSha256=c8a23dc5c209a71661a65ce34beb9fff975ce994e44191fb40b8fa202fac4d7e; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=8b521e3f1dce1a3bbf13a679e5fcf58594ba371c2d20eb98c1eb46d394c0ffe8; fingerprintSha256=9b907bbda822080f879c3aadf89171837edc0defb0f049382ee83fea1d743cba` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0；连续两次 `npm run handoff:fingerprint` 输出一致；计划中的 progress-integrity 项因仓库未定义对应 script 而未执行 | 27/27 项 `user-approved`；§18.1 全部 11 Gate；`file/product version major.minor=1.6` 且其他版本失败关闭；BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script 八个语义编辑器；Hex 只读；仅项目所有者控制机器上的内部测试构建 | 仅支持 `REL-SCOPE passed`、`W-REL-SCOPE-RULING-01 completed` 和其他 Gate `in-scope`；不提升任何 parser、writer、corpus、运行、渲染或发行 authority，不关闭技术、语料、Oodle、metadata、模型凭据、me3、签名、硬件或许可证 blocker，不声明 V0.5 完成或允许外部分发；`test:progress-integrity` 仍为工程缺口 |
| `EV-REL-SCOPE-20260730-UNSIGNED` | `sealed-current-run` | `scope-ruling:user-approved`；撤销代码签名验收项并冻结未签名 NSIS 内部测试边界 | `HEAD=7a6c35ca639bc19324892a86957b7151737d33f8; trackedDiffSha256=0aad391a963c6503343a1b4b7f880874c7bd8e8f4f555430cae09cf92d2bb3bb; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=823ff9cae3df68c30982fbd3ed4bd3102c6ae2ba6d3a9b4b67c5572cd40bb0fc; fingerprintSha256=60d54c580c210c67160099dea5bc8e70b2b95dfcdd40078243adeca499fdf474` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-content`、`npm run test:portable-packaging-config-fixtures`、`npm run test:portable-packaging-gate`、`npm run test:me3-runtime-adapter`、`npm run release:manifest` 均按各自声明的 exit/status 通过；连续两次 `npm run handoff:fingerprint` 输出一致 | 27/27 项继续 `user-approved`；release-scope 18 个正/负 fixture；Windows 10/11 x64 NSIS 允许未签名，仅限项目所有者控制的内部测试机器；仍要求 installer manifest/hash、内容扫描、干净机安装、升级、卸载和 runtime 完整性 | 仅支持 `W-REL-SCOPE-RULING-02 completed` 与 `REL-SCOPE passed` 的当前裁定；代码签名、证书信任链和 SmartScreen 信誉均不再是 V0.5 验收项；portable、自动更新和外部分发仍 unsupported；不提升任何功能/发行 authority，不证明 NSIS、me3、REL-H、REL-COMPLIANCE 或 V0.5 完成 |
| `EV-REL-SCOPE-20260730-OWNER-INPUTS` | `sealed-current-run` | `scope-ruling:user-approved`；固定 Smithbox 本机 PARAM metadata 来源、空模型凭据、工程方 me3 provisioning 与功能性渲染验收边界 | `HEAD=3af0da8b5d061199e8d71e591d2b05ebc94a54c5; trackedDiffSha256=331119d8ff4bba2da036c78ce2699c04f885dd22576ddb487e4594181bd163c3; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=a87629a5ea6ff6fecfe1fd133a3841ed37478d45722eaf28c170bac0e7d8c276; fingerprintSha256=96a01f57833a2c58e3b76a0d084854b0ac9327e94cf5f047d262ae0abe1618d5` | `npm run test:release-scope-fixtures`（25 cases）、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:param-metadata-mismatch`、`npm run test:paramdef-layout`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:me3-runtime-adapter`、`npm run test:scene-draw-list`、`npm run test:three-scene-module` 与 `git diff --check` 均 exit 0；官方 me3 0.12.1 Windows 便携包 SHA-256 匹配发布值，真实 CLI `--version` 与 `profile --help` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | 27/27 项继续 `user-approved`；Smithbox 2.2.4 `SDT` PARAM 路径、commit/artifact digest 与仅本机导入/禁止随 SoulForge 再分发边界；provider 默认空配置且 live credential 非验收；me3 provisioning 归工程方；REL-I 只要求所有者当前机器功能闭环 | 只支持 `W-REL-SCOPE-RULING-03 completed` 与 `REL-SCOPE passed` 的当前裁定；未导入或提交 Smithbox metadata，未实现来源 adapter，未使用真实 provider，未把真实 me3 接入 SoulForge gateway，也未启动 Sekiro 或执行渲染硬件 benchmark；不提升 PARAM/AI/runtime/render/发行 authority，不声明 V0.5 完成或允许外部分发 |
| `EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | `sealed-current-run` | `scope-ruling:user-approved`；在不改变 27 项冻结范围的前提下落实固定 Smithbox 本机来源、脱敏 release corpus、模型空配置和 me3 production detection gateway | `HEAD=cc97cf4c9ef6ee5a1df03590e7401f9d3b264c3d; trackedDiffSha256=bc4c03f3217eac6246521387ee8fe54cba02b41eee9582d85988f8e7bea33534; untrackedManifestSha256=7e2a375358fe119de1d0c3f7ef1ac67d6f04abc4567167bd4224ccf7542225aa; handoffSha256BeforeEvidenceAppend=f0bb60b8e3366bfd60273c12b1d3e7b89d8dccb79295ef0139abf6125c4c32f7; fingerprintSha256=af41a4e1b88790bed4fa0fca2c5d5b1e81dd9c2e1bc42d2ea2e7fbf3f54cf2f2` | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:smithbox-param-metadata-source`、`npm run test:model-service-configuration`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:me3-runtime-gateway`、`npm run test:release-corpus-registry`、`npm run corpus:build-local-release`、`npm run bridge:verify:dcx-documents`、`npm run test:private-native-gate`、`npm run test:release-content`、`npm run test:release-compliance-fixtures`、`npm run test:release-reproducible`、`npm audit --audit-level=moderate`、`npm run test:handoff-integrity` 与 `git diff --check` 均按各自声明的 exit/status 通过；连续两次 `npm run handoff:fingerprint` 输出一致 | Smithbox 160 definitions / 7,028 fields / 124 annotations；模型配置 9 cases、零网络；真实 me3 0.12.1 probe 且未启动 Sekiro；214 个 DCX / 198 个唯一内容，144 DFLT、75 BND4、11,344 entries、70 KRAK reads；private native gate=`partial`，PARAM=38/40；172 个 production 依赖、117 license text present / 55 metadata-only、依赖审计 0 个已知漏洞 | 只支持固定本机 metadata source adapter 与 me3 detection 切片完成、已登记 corpus/恢复/PARAM/AI 的实际 `partial` 或 `fixture-confirmed` 边界，并重新封存既有 `REL-SCOPE passed`；不支持任何功能 Gate 通过，不证明 KRAK 重压/写回、全部 native 语义、八个编辑器、真实 provider、me3 profile/launch、Sekiro 会话、渲染闭环、installer/notices、外部分发或 V0.5 完成 |
| `EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS` | `sealed-current-run` | `scope-ruling:user-approved`；删除编辑器容量/延迟阈值和 installer 体积/启动/升级/回滚耗时预算，同时保留完整有界访问与 installer lifecycle 正确性门禁 | `HEAD=e31d62f4de06aa7107573fb38ce8af3458139854; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=a8b2f5846683b5e5a62373d522fecd31081fa98c65689a918f87b63e810cabb2; handoffSha256BeforeEvidenceAppend=b9ff6c5cad7c5d2269baad7d65963f16cc59eaefca8de816c685ad84b59174bd; fingerprintSha256=977fd253519f1a57865389cadcc595ffae7fe21f27029947132d0cd319311ff2` | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-content`、`npm run test:handoff-integrity` 与 `git diff --check` 均 exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | release-scope 31 个正/负 case；release editor acceptance schema 2；5 个当前 bounded-window/eager 访问缺口继续失败关闭；172 个 production 依赖中 123 个有许可证正文、0 个 metadata-only，release content 保持 `partial` | 只支持 `W-REL-SCOPE-RULING-04 completed` 和 `REL-SCOPE passed` 的当前范围裁定；不提升任何 editor/native/installer authority，不证明 8 个语义编辑器、REL-F、REL-H、REL-COMPLIANCE 或 V0.5 完成，也不授权外部分发 |
| `EV-GOVERNANCE-RECONCILIATION-20260731` | `sealed-current-run` | `scope-ruling:user-approved`；在不改变 27 项冻结范围和 authority 上限的前提下，修正执行面板、production contract 导航、编辑器边界与 NSIS 配置的当前状态漂移 | `HEAD=25c123d845499183f4bd6addd254285d67943a44; trackedDiffSha256=32175fbd60b18371155d77b43f26e76d00db671cb4c890d26a17cf53dca0d3f0; untrackedManifestSha256=0ed4a20d043abc6cebdf2c7b17049c92337ccb1ed9d36a65d8423e6bbcc04ea9; handoffSha256BeforeEvidenceAppend=4ca4a94cb496f61ecb2e97076cb35818d5d71c099a53279da92c5ed84ff9159e; fingerprintSha256=d35ac061ac1f9208e58b86c5a112de49fea592f872edc12d3ac54c4717318650` | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:release-editor-acceptance`、`node scripts/verify-handoff-integrity-fixtures.mjs`、`npm run test:release-compliance-fixtures`、`npm run test:portable-packaging-config-fixtures`、`npm run test:release-content`、`npm run test:desktop-security` 与 `git diff --check` 均 exit 0；`npm run test:portable-packaging-gate` 在 fresh build 后 exit 0 且保持 `status=partial/dryPackStatus=skipped`；追加本记录后 `npm run test:handoff-integrity` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | release-scope 35 个正/负 case；handoff 39 个正/负 case；发布编辑器 inventory 精确等于 BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script；Hex 与 raw 渲染 IPC 不暴露 mutation/capability；electron-builder 仅保留 NSIS x64；me3、KRAK、PARAM、EMEVD、TAE/ESD、FLVER/TPF、AI 与 renderer 的执行面板/导航按既有实现证据统一 | 只支持本轮治理、当前地图和用户可见编辑边界修正，并重新封存既有 `REL-SCOPE passed`；未重跑私有 native corpus、Oodle、真实 me3/Sekiro、Electron 人机功能或 NSIS lifecycle，不提升任何 parser/writer/runtime/render/release authority，不关闭任何功能 Gate，不声明 V0.5 完成或允许外部分发；仓库未定义旧 `test:progress-integrity`，本轮没有恢复或冒充该历史 checklist validator |
| `EV-EMEVD-PATCHIR-20260731` | `sealed-current-run` | C-EMEVD DSL plan production 接线、writer 组合 mutation 修复、AI 写矩阵与 MTD/inventory Bridge 命令 | `HEAD=ea9d899144cebd7ed6b71006d376cb80ebbc9513; trackedDiffSha256=920c8b4f14108911ae9f24736ff1fd3e0286213d3ccc6c97005399fdedbcaf91; untrackedManifestSha256=ac9858865ae974772cbd9131a87a8d401760f0c36a0355d9a9d11e9eb5e047b7; handoffSha256BeforeEvidenceAppend=b6867f2470012ee2bd8e2ee5faaa517a0e43a95907fc1f6f7f3b47ba2f3ca56d; fingerprintSha256=f34d229347b76468f40ca5f6149d7443debe05aedcc47cc1637e523a63eae9ff` | `npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run test:emevd-plan-commit`（13 cases）、`npm run test:emevd-plan-production`（合成 3 + 真实 common.emevd 1，native 变体在本机环境注入下运行）、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view`、`npm run test:ai-conformance`（20 cases）均 exit 0；本机环境注入后 `npm run bridge:verify:emevd` exit 0（1,730 events / 33,266 instructions 回归含 GC add/delete） | syntheticEmevdBytes 合成 EMEVD（2 events / 3 instructions 含未知指令）；真实 `emevd-primary` common.emevd 事件级 id/rest typed mutation；AI scripted 本地 contract server 写矩阵；MTD 合成 XML 正/负（DTD 拒绝）与 inventory 单资源 case | 只支持 `W-EMEVD-PATCHIR-02 completed`、C-EMEVD `partial`、AI 写矩阵 `partial`、MTD/inventory `candidate` 与 `probe:behavior-headers` 工具登记；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；当时旧全工作树 freshness 模型产生 stale，现已明确为工程治理维护而非用户 blocker |
| `EV-EMEVD-COVERAGE-20260731` | `sealed-current-run` | C-EMEVD 真实 corpus 指令分布提取与 EMEDF 覆盖分析基线 | `HEAD=3e05add3d836bb910487496342204fa68a257d31; trackedDiffSha256=67106682572cb66fc7527c68550e5ff99ca2d88f89466269ac139f946c1d6b0c; untrackedManifestSha256=d50f178e8ce170d758a90d951b42dee1fe2d01f1bc49574c88c4541e28859e0c; handoffSha256BeforeEvidenceAppend=c3baa1f51603c2d60c8fe00be8b8f7b2f645dace3bff7d25bbbe4efa7712bf29; fingerprintSha256=0e3453f49c4ca1b4b194d18afa2bd50b570adc5b03d8cc7a7fbf3275634345d9` | `npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run test:emevd-coverage`（合成断言 5 组）均 exit 0；本机环境注入后 `npm run test:emevd-coverage` exit 0（真实 142 种/33,266 条分布 + 覆盖分析 + fixture 长度一致性）且 `npm run bridge:verify:emevd` exit 0（1,730 events 回归） | 真实 `emevd-primary` common.emevd 全量指令分布（bank/id → count + args 长度直方图，聚合脱敏、2,000 种上限未截断）；合成分布覆盖/未知/长度不匹配/空分布断言；fixture 三条指令的 corpus 出现与长度一致性检查 | 只支持 `W-EMEVD-FULL-01` 的分布提取与覆盖分析基线子推进（切片继续 `ready/partial`）；分布只有长度签名、不含参数类型，不构成完整 EMEDF schema 或类型覆盖声明；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；当时把 freshness 重封存错误留给用户，现已由主题域规则修正为工程自持 |
| `EV-EMEVD-GLOBAL-20260731` | `sealed-current-run` | C-EMEVD DSL 顶层 instruction 块：全局指令级 typed mutation | `HEAD=969dbe8f8839ad983da72c60b4350df808066755; trackedDiffSha256=e1f1878292bef969cecc0bc0c0f7c2bbb7725499b672aa36fc3205174831f37d; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=7b588153d1d6614f27560fab8b83d5e32d795c431af32fed9bcd807f3b04a1fa; fingerprintSha256=8f5cf58a2751ebb361606e792d213a8dfe58b039229255488ce0b96176c1f18f` | `npm run typecheck`、`npm test`、`npm run test:emevd-dsl-compiler`、`npm run test:emevd-four-view`、`npm run test:emevd-plan-commit`（13 cases）、`npm run test:emevd-plan-production` 均 exit 0 | 顶层 instruction 块 6 组断言：全局 mutation 生成、AST topLevelInstructions、与事件内写法计划操作逐字段等价、缺失锚点 ANCHOR_NOT_FOUND、未知指令只读、跨作用域重复写 DUPLICATE_ARGUMENT | 只支持 `W-EMEVD-FULL-01` 的 DSL 全局指令级 typed mutation 子推进（切片继续 `ready/partial`）；锚点身份与计划契约不变，planFingerprint 绑定源形状（顶层与事件内为不同 AST 形状）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；`REL-SCOPE passed` 的当前封存状态按外部治理提交与用户裁定为准 |
| `EV-EMEVD-FULLDOC-20260731` | `sealed-current-run` | C-EMEVD EMEVD 完整文档分页组装与四视图 DSL 提交 UI 接线 | `HEAD=f5d5674f85eb5eb9444c7edb76b0ea0ae704f0eb; trackedDiffSha256=2a99af27dba46014c8a1a8bc876d2d07bead50b1038c69e16b0d5ece7587c719; untrackedManifestSha256=698e4a159c901e0cc98f6de359662380335b8c8ef736b9d4a053dbeaa3780344; handoffSha256BeforeEvidenceAppend=07bb6593247cca74f7991a3d9679db4c90e821cd8e0974c5e13e674fe7936e6b; fingerprintSha256=c083a06af5d26f28e7e7fa35a11966d51f4f23987cd18fe2285b5f8ccf85eed4` | `npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:emevd-full-document`（合成 + 本机环境注入真实 DCX 直读）、`npm run test:emevd-ipc-contract` 均 exit 0；追加本记录后 `npm run test:handoff-integrity` findings 为空 | 完整文档分页组装：合成（pageSize 2 → 2 页、事件切片、unknown 分类）与真实 `emevd-primary` common.emevd DCX 直读（1,730 events / 33,266 指令 / 34 页、preparedSourcePath 复用 staging 源、事件切片总数一致）；Bridge envelope 分页字段（instructionPage/instructionPageSize/instructionTotal/instructionPageCount/instructionsSampleTruncated）；desktop IPC 契约（resource.readEmevdFullDocument / resource.submitEmevdDslPlan / preload 两方法 / main `emevdFullDocuments` 权威缓存 / renderEmevdPatchDsl 模板） | 只支持 `W-EMEVD-FULL-01` 的完整文档分页组装与四视图 DSL 提交 UI 接线子推进（切片继续 `ready/partial`）；renderer 只编辑 DSL 文本，不持有完整文档；DSL 提交经 `submitEmevdDslPlanViaFourView` production 写链且提交前重读 fresh 文档；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；control-flow validation 与完整 EMEDF 类型布局仍属工程缺口 |
| `EV-EMEVD-SCALE-20260731` | `sealed-current-run` | EMEVD 编辑器规模访问 eager → pagination（硬约束 17 合规） | `HEAD=3de45a08e861118b0c3b6cd13e147c3d8783080c; trackedDiffSha256=09a127f9f82d26947ebbd107dfa6aef449ef2beef9bd0773660ace2e766afcde; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=70e617acf5a1a47c68f328232c714d7672f9165ee281c6c6cfb95acb2e13447f; fingerprintSha256=4d5bab1ac13fbb9885e38b44589e58436a963d6a8509ff350a525633ebe30d91` | `npm run typecheck`、`npm test`、`npm run test:release-editor-acceptance`、`npm run test:emevd-dsl-compiler`（含 bounded 截断断言）、`npm run test:emevd-ipc-contract`、`npm run test:emevd-four-view`、本机环境注入后 `npm run test:emevd-full-document`（1730 events / 33,266 指令 / 34 页）均 exit 0；追加本记录后 `npm run test:handoff-integrity` findings 为空 | DSL 模板行数截断（`renderEmevdPatchDslBounded`：事件块边界截断 + 注释标记，截断模板编译为 no-op 空计划；无上限时完整渲染）；IPC `loadFullDslTemplate` 显式完整加载 + `dslTemplateTruncated/dslTemplateTotalLines` 报告；事件列表分页每页 200（flow/table 视图）；`editorCapabilityContract` emevd `scaleAccess=pagination`；`currentScaleContractGaps` 不再含 EMEVD（其余 7 个编辑器缺口如实保留） | 只支持 `W-REL-F-SCALE-02` 的 EMEVD 规模访问子推进（切片继续 `ready/candidate`）与 `W-EMEVD-FULL-01` 的分页接线延伸；`pagination` 只证明规模访问契约，不证明完整语义编辑、真实验收或任何 native authority 提升；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；`validation-unfrozen` 的真实文档完整有界访问与 Electron functional smoke 仍属工程项 |
| `EV-FMGMSB-WRITE-20260731` | `sealed-current-run` | FMG add mutation 与 menu.msgbnd 第二语料读验证、MSB set_part_transform 重读验证、EMEVD writer 警告修复 | `HEAD=a90cfa711514e854e922c03534a749eabad04fa8; trackedDiffSha256=eb6724598607c60c9a645df8da55f19b379eba90cbbe7e62df577aac5626b794; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=bd5432e62a4196bb3a9db5b4648a09cab0c6fa791da71803ae86cf19ce81bdb2; fingerprintSha256=be59a89476cc60be1f22dc4280a8061427ef6ddce927dbac171deec917ad8065` | `npm run typecheck`、`npm test`、`npm run bridge:build`（0 警告 0 错误）均 exit 0；本机环境注入后 `npm run bridge:verify:fmg`（add case + menu 15 子项 roundtrip）与 `npm run bridge:verify:msb`（transform case）exit 0；追加本记录后 `npm run test:handoff-integrity` findings 为空 | FMG `add` mutation：TS helper 补 `add` kind，真实 item.msgbnd 对不存在的 id 999999999 staged 写入 → Bridge 独立重读文本存在 → 原文件未受影响；menu.msgbnd（bnd4-primary）15 子项全部 FMG v2 semantic roundtrip（只读）；MSB `set_part_transform`：Bridge writer 补 rotX/scaleX/scaleY/scaleZ 重读核对，真实 m11 transform case（rotX=82.37612、scale [1.05, 1.1, 0.95]、part 数不变）；EmevdNativeWriter CS8629 警告修复（`patch.NewEventId!.Value`） | 只支持 `W-EMEVD-FMG-PARAM-03` 的 FMG add/menu 读与 MSB transform 验证子推进（切片继续 `ready/partial`）；FMG 全语言仍受本机 corpus 语言覆盖限制；capability contract 的 fmg mutationKinds 未声明 `fmg_entry_add`（无 UI 调用方，`editorAllowsMutation` 继续保守拒绝）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；PARAM 布局 32/33/81 与 MSB 全实体 CRUD 仍属工程缺口 |
| `EV-HANDOFF-LIVENESS-20260725` | `sealed-current-run` | 交接推进活性治理、公开回归、REL-B registry/harness fixture 与 REL-F acceptance harness candidate | `HEAD=20020766506ea71d66d3b9b9ea867aa534aaa3a9; trackedDiffSha256=4621e9898de5250b8d72d309af2396e2de00351fcefb760855cbeedd42440d5f; untrackedManifestSha256=f499f192e40be3b4f91cb01336478251435ad1789ef168aacfcdbd452f9c7c35; handoffSha256BeforeEvidenceAppend=313dbde91970b6d9a3bccb0bb244de3ce0f2a6ce44122560eebf6af625a562b2; fingerprintSha256=3067512cc0068ad13cf50011889a19c3104dc3a0d6b9b3cd7c76788ebe3e43c9` | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-corpus-registry`、`npm run test:release-editor-acceptance`、`npm run test:handoff-integrity`、`git diff --check` 均 exit 0；`npm run bridge:build` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | 38 个 handoff 正/负 fixture；公开 synthetic/core/Electron 回归；metadata-only corpus registry fixture；候选编辑器 inventory/contract harness；项目 wrapper 解析到 .NET SDK 10.0.301 | 只封存本轮治理机制和已列公开/harness 观察，并支持 `W-REL-B-REGISTRY-01` 的 `fixture-confirmed` 与 `W-REL-F-ACCEPT-01` 的 `candidate` 上限；不包含用户范围批准标记，不支持任何 Gate `passed`/`scope-excluded`，也不提升私有 native、真游戏、真实模型服务或发布 authority；`manualReviewStillRequired` 三项仍保留 |
| `EV-PUBLIC-CONTRACTS-20260725` | `sealed-current-run` | Bridge recovery/staging、PARAM metadata、me3 adapter、REL-B registry、REL-F acceptance 与发行失败关闭 contract | `HEAD=20020766506ea71d66d3b9b9ea867aa534aaa3a9; trackedDiffSha256=4caed8aa7f2647304d9f22a19fbd10e3f07c914f6334a6970ecf4885de1d8fad; untrackedManifestSha256=32b6faf6d0e1e92ed25a93903a0154c7803f0f49c4d64875f7f27baa61093b64; handoffSha256BeforeEvidenceAppend=f67684684b8e703f433c3495051cab381b4045de43af157a1b005cc07c77d9d6; fingerprintSha256=a450562260693252e75d6d81226aff97b9a43f3eeb39ebf7fce573c78b210839` | 最低公开回归四命令均 exit 0；`bridge:verify:client`、`test:bridge-recovery-harness`、`test:bridge-staging`、`test:param-metadata-mismatch`、`test:paramdef-layout`、`test:me3-runtime-adapter`、`test:release-corpus-registry`、`test:release-editor-acceptance` 均 exit 0；发行六命令、portable/private/section-28 gate 均 exit 0；连续两次 `handoff:fingerprint` 一致 | recovery 四阶段/背压/竞态/重启与 11 个 staging 负例；PARAM 9 个 snapshot failure、64 MiB 总预算、256 diagnostics、3 个 immutable result；me3 22 类；REL-B 26 个负例；5 个候选编辑器；170 dependencies、116/54 license text、11 artifacts | 支持 A/PARAM/me3 contract 与 REL-B registry 的 `fixture-confirmed`、REL-F acceptance 的 `candidate`、发行合规的 `partial`；artifact=`6f22d28bfae009057d57e5bcb64936721e17357cadd6ee4be562081d1b348f0a`、manifest=`48d8eda021e041d10464cd3f8e641ae23db1333ad760e4ca2708c57e5e2ff0af`；portable=`partial/skipped` 且 builder 依赖缺失，private/section-28=`skipped`；不支持任何 Gate 终态、native corpus、真实 me3/Sekiro、人机验收、installer、签名、升级或更新声明 |
| `EV-B-DFLT-7BD` | `historical-record` | DFLT 已记录真实 corpus 往返 | `7bd354d` | 旧第 43 节“P1 安全清理执行器与 P2 真实 DFLT/BND4 文档推进”；`bridge:verify:dcx-documents` | 144 个 DFLT、两个实际变体 | 本轮未重跑私有 corpus；不得外推到新变体或发布全集 |
| `EV-B-BND4-7BD` | `historical-record` | DFLT 外层 BND4 browse/CRUD/repack/rollback | `7bd354d` | 旧第 43 节“P2 BND4 production staging writer 与五类事务闭环”等记录；`bridge:verify:bnd4-writer`、`bridge:verify:bnd4-transaction` | 75 个 DFLT-BND4、11,344 entries 的历史记录 | KRAK 内 corpus、新 flags/布局未覆盖；本轮未重跑私有 corpus |
| `EV-C-FMG-7BD` | `historical-record` | FMG v2 与 item.msgbnd 子项闭环 | `7bd354d` | 旧第 43 节 FMG/PARAM 记录；`bridge:verify:fmg` | `item.msgbnd` 18/18 子项历史记录 | 其他 msgbnd、语言、引用和游戏加载未验证 |
| `EV-C-PARAM-7BD` | `historical-record` | PARAM 紧凑布局 raw row 路线 | `7bd354d` | 旧第 43 节 FMG/PARAM、PARAM 复制记录；`bridge:verify:param` | 38/40 历史抽样；2 个旧 header-embedded type name 结构化 unsupported | Paramdex-compatible metadata、完整字段 writer 和全 corpus 未完成 |
| `EV-C-EMEVD-7BD` | `historical-record` | EMEVD header/event/instruction/args 与主要 mutation | `7bd354d` | 旧第 43 节 EMEVD 系列记录；`bridge:verify:emevd` | `common.emevd` 历史记录 1,730 events / 33,266 instructions，含变长 args、add/delete GC | `layerCount != 0`、完整 EMEDF、DSL、KRAK 和游戏加载未验证 |
| `EV-C-EMEVD-DSL-20260724` | `unsealed-record` | EMEVD DSL stable anchor、tokenizer/parser/AST、EMEDF typecheck 与 typed plan | `4d37861` + 当前合并工作树 | `npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view`、`npm run bridge:build`、本机环境注入后 `npm run bridge:verify:emevd` 均 exit 0 | fixture EMEDF；规范 patch DSL no-op、typed id/rest/arg plan、revision/schema/document-instance 绑定；真实 `common.emevd` 1,730/33,266 的既有 mutation 回归 | 保留 DSL `fixture-confirmed` 观察；plan 未写二进制、未接 Bridge/PatchIR，完整 EMEDF/control-flow/layer/游戏加载仍未验证 |
| `EV-C-MSB-SCENE-20260724` | `unsealed-record` | MSB 四类实体 semantic scene / render packet 与 production bundle WebGL proxy | `2002076` + 当前工作树 | `npm run test:scene-draw-list`、`npm run test:three-scene-module`、`npm run test:scene-asset-inventory`、`npm run test:hex-scene`、本机环境注入后 `npm run bridge:verify:msb`、`npm run build` 均 exit 0；Playwright production bundle 桌面/390px 检查通过 | 私有 fixture registry 的 `msb-primary`（m11 标识，脱敏）：34 models / 4,500 parts / 1,089 regions / 46 events；Bridge preview 投影 208 entities / 128 drawable nodes；fixture 四类实体重排；1440x900 与 390x844 WebGL canvas | 保留 native identity/revision、路径隔离和 WebGL proxy 观察；该 registry 仅是开发期私有 fixture registry，不是 release corpus；因基线未封存，不支持新的 authority 或 Gate 终态；projection 仍 `partial`，不证明完整 MSB、FLVER、WebGPU 大地图性能或游戏加载 |
| `EV-C-MSB-7BD` | `historical-record` | MSB models/parts/POINT region 与 transform | `7bd354d` | 旧第 43 节 MSB 系列记录；`bridge:verify:msb` | m10 历史样本 models=34、parts=5,406 | 全实体、引用修复、完整 mutation、KRAK 与游戏加载未验证 |
| `EV-E-ASSET-7BD` | `historical-record` | 开放格式检测/staging、PatchIR file replace、最小 DDS、FLVER candidate | `7bd354d` | 旧第 43 节资产、DDS、scene inventory、FLVER candidate 记录；`test:asset-import`、`test:asset-writeback`、`test:dds-convert-writeback`、`test:flver-candidate` | synthetic/open-format fixture 与候选头部/mesh table | 不证明 FLVER vertex/index/material、TPF/MTD、native writer 或游戏加载 |
| `EV-F-EDITORS-7BD` | `historical-record` | EditorDocumentStore、Safe Hex、EMEVD/PARAM/FMG/MSB 桌面契约 | `7bd354d` | 旧第 43 节 editor/IPC/UI 系列记录；对应 `test:*contract`、`test:*-four-view`、`test:ui-localization` | fixture、静态契约和已有 native read/write IPC | 不证明完整 Electron 人机流程、规模化交互或所有编辑器均具备完整 native authority |
| `EV-G-FAKE-7BD` | `historical-record` | 双 provider fake tool loop | `7bd354d` | 旧第 43 节 AI 记录；`test:ai-fake-loop`、`test:openai-responses` | 本地 fake HTTP/SSE 与契约测试 | 本轮未重跑 AI 专项 smoke；真实 endpoint、凭据、限额和生产多步任务仍 `unverified` |
| `EV-H-GATES-7BD` | `historical-record` | private native / section-28 诚实门禁 | `7bd354d` | `test:private-native-gate`、`test:section28-sekiro-gate` 历史记录为 skipped | 当时缺合法本机 runtime | skipped 只证明门禁诚实；不证明 KRAK、游戏启动或发布 |
| `EV-I-RENDER-7BD` | `historical-record` | Three.js 代理场景、draw list 和 synthetic 性能基线 | `7bd354d` | 旧第 43 节 Three/scene/performance 记录；`test:scene-draw-list`、`test:three-scene-module`、`test:performance-baseline` | proxy geometry 与 synthetic scene | 不证明真实 FLVER、大地图 WebGPU/WebGL2 性能、显存预算或后端完成 |
| `EV-HANDOFF-20260721` | `unsealed-record` | handoff 一致性门禁（确定性静态子集） | `2002076` + 当前工作树 | `npm run test:handoff-integrity` exit 0；临时畸形样本负向测试 exit 1 且命中断链/重复EV/未定义EV/缺失script/敏感内容 | markdown 链接、Evidence ID 唯一与引用、`npm run` script 存在性、交接书敏感内容四类 | 保留旧版静态门禁运行观察；因基线未封存，不支持新的 authority 或 Gate 终态；第 13.3 节 `manualReviewStillRequired` 语义项仍靠人工审查 |

引用 `historical-record` 时必须同时保留它的未验证边界。若当前真实样本与历史记录冲突，立即把对应 authority 降为 `unverified`，必要时将切片 lifecycle 改为 `blocked` 并引用 blocker；新增可封存的当前证据，不得删除冲突记录。

### 17.2 证据记录格式

建议格式：

~~~markdown
### YYYY-MM-DD：标题

- 证据类型：`sealed-current-run` / `unsealed-record` / `historical-record`
- 起始：`sha`
- 结束：`sha` 或下述五字段工作树指纹
- 路线：B / C-EMEVD / I 等
- lifecycle 变化：`active -> completed`
- authority 变化：`unverified -> partial`
- blockerRefs 变化：...
- 已实现：...
- 已验证：`command` exit 0；样本范围 ...
- 未验证：...
- 非声明：...
- 阻塞：...
- 重复阻碍（如有）：出现次数、根因、当前缓解、是否仍阻塞；已解决的重复故障也要保留最小复现和修复证据。
~~~

**证据指纹规则**：`sealed-current-run` 的 `起始` / `结束` 必须定位到可重算状态。无论工作树是否干净，都必须记录以下全部字段；已提交状态把真实 commit 写入 `HEAD`，diff/manifest 仍按同一算法计算，缺一即只能登记为 `unsealed-record`：

~~~text
HEAD=<40 或 64 位 commit SHA>
trackedDiffSha256=<排除 docs/V0_5_IMPLEMENTATION_HANDOFF.md 后，全部 staged/unstaged tracked diff 的 SHA-256>
untrackedManifestSha256=<按仓库相对路径排序的未跟踪文件路径与逐文件内容 SHA-256 清单之 SHA-256>
handoffSha256BeforeEvidenceAppend=<追加本 Evidence 前、已经通过验证的交接书快照 SHA-256>
fingerprintSha256=<以下 canonical payload 的 SHA-256>
~~~

canonical payload 使用 UTF-8、字段值转小写、LF 分隔且末尾不加换行：

~~~text
HEAD=<head>
trackedDiffSha256=<trackedDiffSha256>
untrackedManifestSha256=<untrackedManifestSha256>
handoffSha256BeforeEvidenceAppend=<handoffSha256BeforeEvidenceAppend>
~~~

`trackedDiffSha256` 必须明确排除本交接书，交接书自身由 `handoffSha256BeforeEvidenceAppend` 单独绑定；该 handoff 哈希必须取追加证据记录之前的已验证文档快照，从而避免 Evidence 记录对自身产生哈希递归。`untrackedManifestSha256` 只覆盖 `git ls-files --others --exclude-standard` 返回的非 ignored 文件，不得把绝对路径、私有资产或凭据写入清单。生成器与 handoff 门禁必须使用上述同一 canonical encoding，并校验 `fingerprintSha256` 可重算；手工填写、只列 `git status`、`git stash create` 或空泛的“当前工作树”均不能封存。

五字段指纹封存的是 Evidence 当次验证的精确工作树，继续用于审计和复现；**Gate freshness 不再等同于整个工作树逐字匹配**。每个 `passed` Gate 必须在 `scripts/handoff-integrity-lib.mjs` 登记显式主题域，门禁只比较 Evidence `HEAD` 锚点至当前工作树之间该主题域的变化。`REL-SCOPE` 的主题域固定为 §18.2.1 范围 JSON、release-scope verifier/fixtures、handoff freshness verifier/fixtures 与指纹生成器；普通功能代码、其他交接章节、运行时改写文件和未跟踪产物不得让范围 Gate 失效。

主题域未变化时，既有 `passed` 保持有效，不生成新 Evidence。主题域发生变化时门禁失败关闭：若冻结范围语义未变（例如校验器加固或纯治理修复），由工程方重跑范围与治理验证并生成 `revalidates=<EvidenceId>` 的 fresh sealed Evidence；这属于工程维护，不是 blocker，也不需要用户再次授权。只有 §18.2.1 的支持/排除边界实际变化，才必须取得新的用户裁定。主题域无法读取、Evidence 锚点不是当前 HEAD 的祖先或 Gate 未登记主题域时同样失败关闭，但不得自动归类为用户介入。

未提交 sealed 证据在对应改动提交后可以补记真实 SHA，但不得覆盖原五字段指纹。任何无法复原上述状态的旧记录保持 `unsealed-record`；不得仅通过修改类型标签升级。

真实命令日志和大型产物放在应用数据目录或系统临时目录，默认不提交仓库。记录中不得包含用户绝对路径、真实资产、API key 或 Oodle DLL。

旧版 P0-P7 流水记录已由本线路图取代。历史细节仍可通过 Git history 和基线提交 `7bd354d` 追溯；不要恢复旧 milestone、fork、task、project-state 或 development-log 文档作为当前口径。

### 2026-07-20：交接书重构为长期技术线路图

- 起始：`7bd354d`
- 结束：`4ed3203`（交接书重构）；配套规则与 README 对齐完成于 `6596325`、`2002076`
- 路线：全局文档架构
- 状态变化：固定 P0-P7 阶段计划 -> 依赖驱动技术线路图
- 已实现：将工作区、容器、核心语义、行为动画、场景资产、专业编辑器、AI、me3 运行和渲染后端拆为长期主线。
- 已实现：正式纳入行为与动画路线；明确 Paramdex-compatible metadata；明确 EMEVD DSL 终局编译链；明确 me3 runtime adapter；明确 renderer-independent semantic scene、Three.js WebGPU 首选、WebGL2 fallback 和未来 native backend 边界。
- 已保留：Patch Engine、native authority、路径安全、SQLite、三层回滚和诚实诊断等硬约束。
- 非声明：文档重构不改变任何代码能力，也不把现有 partial / candidate / skipped 提升为完成。

### 2026-07-20：交接书升级为依赖驱动工程控制面

- 起始：`2002076`
- 结束：当前工作树，尚未提交（记录于 §17.2 指纹规则引入前；精确状态待与后续变更一并提交后补 SHA，见 2026-07-21 收敛机制记录）
- 路线：全局控制、证据与验证治理
- 状态变化：不改变产品能力 authority；增强交接和裁定能力
- 已实现：区分代码能力基线与文档同步基线；增加状态声明契约、接手决策协议、路线依赖、authority 解锁规则、当前执行面板、工作切片完成模板、生产调用链、路线验证矩阵、本机环境契约、结果分类和证据索引。
- 已验证：`npm run typecheck` exit 0；`npm test` exit 0；`npm run bridge:verify:synthetic` exit 0；`npm run build` exit 0。文档列出的 npm 命令在根 `package.json` 中存在。
- 样本范围：本轮只运行公开/synthetic/fixture/Electron utility 测试，没有运行私有 native corpus、真实游戏、真实模型服务或签名安装验证。
- 未验证：第 17.1 节所有 `historical-record` native 数字尚未在本轮私有环境重跑；真实性能阈值尚未裁定。
- 非声明：本轮文档变更不提升 DFLT/BND4/FMG/PARAM/EMEVD/MSB、AI、3D、运行或发行 authority。
- 阻塞：工作树中 4 个旧 synthetic 规格文件在本轮开始前已处于删除状态；本轮不恢复、不覆盖，其保留策略需单独裁定。

### 2026-07-21：实现 handoff 一致性门禁并修复 README 断链

- 起始：`2002076`
- 结束：当前工作树，尚未提交（记录于 §17.2 指纹规则引入前；精确状态待提交后补 SHA，见 2026-07-21 收敛机制记录）
- 路线：全局控制、证据与验证治理（`W-HANDOFF-INTEGRITY-01`）
- 状态变化：第 13.3 节由"当前治理缺口 / 无命令"→"治理门禁已部分实现"；不改变任何产品 native / AI / 渲染 / 发行 authority
- 已实现：新建 `scripts/verify-handoff-integrity.mjs` 与根 `test:handoff-integrity`，自动校验 markdown 链接完整性、Evidence ID 唯一与引用、`npm run` script 存在性、交接书敏感内容四类；语义项列入 `manualReviewStillRequired` 并与第 13.3 节镜像。
- 已实现：按第 19 节口径，将 README「Synthetic 技术规格」段 4 个指向已删除文件的死链改为说明性文字，不恢复、不覆盖、不重造规格。
- 已实现：删除 `.ai-bridge/` 下 UNTRACKED 且被 `.gitignore` 忽略的本地残留 `current-plan.md`（过时平行任务计划）与 `agent-status.md`（空占位）；被跟踪的 CodexPro 工具桥稳定上下文文件保留。
- 已验证：`npm run test:handoff-integrity` exit 0；临时目录畸形样本负向测试 exit 1，`DEAD_LINK` / `EVIDENCE_ID_DUPLICATE` / `EVIDENCE_ID_UNDEFINED` / `NPM_SCRIPT_MISSING` / `SENSITIVE_CONTENT` 五类检测码全部命中，已定义 EV 与已存在 script 未误报。
- 未验证：本轮未运行 `typecheck` / `test` / `build`——改动仅为新增独立 mjs 门禁、`package.json` 一条 script 和文档，不触及 TS 编译单元；Git commit 存在性与所有语义一致性检查未纳入门禁首版。
- 非声明：不提升任何格式、AI、渲染或发行 authority；门禁通过不代表交接书语义全部一致。
- 阻塞：无新增外部阻塞；synthetic 规格文件的删除 / 保留裁定仍待用户确认（见第 19 节）。

### 2026-07-21：建立 Gate 覆盖收敛机制与执行手册

- 起始：`2002076`
- 结束：当前工作树未提交；HEAD=`2002076` + 本轮改动集 `{docs/V0_5_IMPLEMENTATION_HANDOFF.md, docs/AGENT_EXECUTION_PLAYBOOK.md, README.md, package.json, scripts/verify-handoff-integrity.mjs}`；提交后按 §17.2 补 SHA
- 路线：全局控制、收敛治理（`W-HANDOFF-INTEGRITY-01` 延伸）
- 状态变化：把"循环执行器"升级为"收敛可机器校验的任务生成器"；不改变任何产品 native / AI / 渲染 / 发行 authority
- 已实现：当时新增 §18.3 Gate 覆盖矩阵与收敛不变量；§13.1 补 `W-REL-SCOPE-01` / `W-REL-B-CORPUS-01` / `W-REL-F-ACCEPT-01` / `W-REL-COMPLIANCE-01` 四个后继切片，使 11 个 Gate 均有可推进切片或在案 blocker；该旧模型现已迁移为 §18.3 的 gateState/applicability 双字段状态机。
- 已实现：执行手册新增 §8 面板补货循环（从 Gate 生成下一批切片，自主追加+护栏）与 §9 空集合/全阻塞终局分支；§13.4 required validation 冻结约定并列出 8 个 `validation-unfrozen`；§17.2 证据指纹规则。
- 已实现：当时门禁扩展 gate-coverage 校验（`GATE_MISSING_IN_MATRIX` / `GATE_BAD_VERDICT` / `GATE_UNCOVERED` / `GATE_SLICE_UNKNOWN`），机器强制每个 Gate 有可推进切片或在案 blocker；当前错误语义以 §13.3 为准。
- 已验证：`npm run test:handoff-integrity` exit 0（真实仓库，11 Gate 全覆盖、切片引用一致）；临时畸形 Gate 矩阵负向测试 exit 1，四类 gate 码全部命中。
- 未验证：未跑 `typecheck` / `test` / `build`（改动为文档 + 独立 mjs + package.json 一行，不触 TS 编译单元）；`validation-unfrozen` 条目尚未冻结为可运行命令。
- 非声明：有可推进切片只表示 Gate 尚可继续，不代表 Gate 通过；本矩阵不替代 §18.1 通过条件与 §18.2 用户裁定；不提升任何 authority。
- 阻塞：REL-SCOPE 范围值与性能/容量/安装阈值仍待用户裁定（§18.2）；REL-B/D/E/G/I 终局闭环受 private-corpus / credential / hardware / user-ruling 阻塞（已在 §18.3 在案）。

### 2026-07-24：BND4 writer 故障矩阵、私有 registry 接线与 KRAK 成功路径

- 起始：`2002076`
- 结束：未提交工作树；HEAD=`2002076` + 本记录列出的 core/script/package/handoff 改动，提交后补 SHA
- 路线：A-RECOVERY / B-KRAK / 私有验证治理（`W-A-RECOVERY-01`）
- 状态变化：`W-A-RECOVERY-01 ready -> partial`；B-KRAK `blocked -> partial`（仅注册样本 read preview）；私有 gate `exit-code passed -> semantic partial`
- 已实现：`WorkspaceTransaction` 在 before-stage validator、writer stage、staged-output validator、backup create、after-commit re-read 抛错时返回结构化诊断；`durablePatchCommit` 对 stage/validate/commit 未捕获异常做日志与 journal 失败收口。
- 已实现：事务进入 staging 后禁止继续追加 Patch；已覆盖的 stage / validate / commit / re-read 成功或失败终态回收请求暂存目录，journal 切换异常也显式回收；writer staging、validator 和 backup 失败均写入 `failure_recovery` 审计。
- 已实现：新增公开 `test:writer-failure-matrix`，覆盖 text edit、text/binary file replace、raw range 的 stage / validate / commit-backup / re-read 共 16 个 deterministic case，并接入 `npm test`；新增私有 `test:native-writer-failure-matrix`，以注册 `chrbnd-primary` 覆盖 BND4 writer 的同四阶段共 4 cases；20 个 case 均断言原字节恢复、暂存无泄漏、失败已审计且诊断不含本机绝对根路径。
- 已实现：故障注入只通过测试 harness 直接构造 `WorkspaceTransaction`；生产 `ExecutePatchIrOptions` 不暴露可替换 writers/validators 的旁路。
- 已实现：FMG/PARAM/EMEVD/MSB 共用的 Bridge 暂存编排从 desktop 下沉为 `packages/core/src/editing/bridgeStaging.ts`；prepare / writer throw / verified-output missing / cleanup 均返回 `BRIDGE_STAGING_*` 结构化诊断，不再以未捕获异常穿透 IPC；四种格式继续使用 LOCALAPPDATA 稳定根和请求级清理；renderer 可见诊断只保留阶段、错误类型和系统码，不回传本机绝对路径。
- 已实现：native smokes 通过 `SOULFORGE_NATIVE_FIXTURE_REGISTRY` 的 `testRole` 解析 fixture，不再错误依赖仓库根 `mods/`；fixture hash 改为流式校验并拒绝重复 role、越界 realpath 与哈希不符；Oodle 负向用例清除继承环境，正向用例在同等根边界和哈希校验后验证合法 runtime 与注册 KRAK preview。
- 已实现：private native gate 不再只看 exit code；它解析结构化输出并将 PARAM 38/40、MSB candidate 等诚实汇总为 `partial`，同时移除 `shell: true` npm 子进程调用。
- 已验证：最终工作树上 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:sqlite-crash-recovery`、`npm run test:writer-failure-matrix`、`npm run test:bridge-staging` exit 0；通过本机环境包装入口运行 `npm run test:native-writer-failure-matrix`、`npm run bridge:verify:oodle`、`npm run test:private-native-gate` exit 0。私有 gate 结构化状态为 `partial`，不是全绿；未注入 registry 时直接运行 native writer matrix 因缺样本 exit 1，按环境契约不计实现失败也不计通过。
- 样本范围：一个注册 BND4 `chrbnd-primary`；一个注册 KRAK fixture；EMEVD 1,730 events / 33,266 instructions；FMG 18/18；PARAM 38/40；MSB 34 models / 4,500 parts / 1,089 regions / 46 events。
- 未验证：真实 Bridge 进程在四种语义格式 staging 中途崩溃的分格式 integration case，以及真实断电/磁盘错误；KRAK 发布 corpus、重压和 writer；PARAM 两个旧布局；MSB 全实体 authority；真实游戏启动、模型服务和签名安装。
- 非声明：单个 KRAK 解压 preview 不等于 KRAK/BND4 发布闭环；私有 gate exit 0 且 status=partial 不等于 V0.5 全绿；本轮不提升 PARAM/MSB authority。
- 阻塞：发布 corpus 覆盖、真实游戏/硬件基准、模型凭据与用户量化裁定仍按 §18.2/§18.3 在案。

### 2026-07-24：EMEVD DSL typed proposal 与严格 EMEDF 边界

- 起始：`2002076`
- 结束：功能基础进入 `4d37861`；当前合并工作树以模块化 DSL compiler 为唯一实现，不保留并行 parser/compiler
- 路线：C-EMEVD / F-EDITORS（`W-EMEVD-DSL-01`）
- 状态变化：`W-EMEVD-DSL-01 ready-with-fixture -> fixture-confirmed`；C-EMEVD 总体仍为 `partial`
- 已实现：新增 renderer-safe lexer、recursive-descent parser、带稳定 event/instruction URI 的 AST、规范 DSL renderer 和源码行列诊断；四视图 controller 暴露只读 parse 与 compile 入口。
- 已实现：compiler 先完整校验 EMEDF registry，再按 bank/id 建索引；拒绝重复 instruction/arg、缺参、多余参数、类型不符、整数/数值越界、未知 schema、结构新增/删除、layer mutation、重复 URI/ID 和一次多 ID mutation；完整 registry 只校验/建索引一次，避免按指令重复全表扫描。
- 已实现：typed payload 只有在 decode -> encode 字节完全相等时才渲染为 typed；尾随或无法无损重编码的 payload 自动保持 `unknown` opaque。未知 instruction 只允许逐字节 no-op；proposal 仅输出带连续 baseRevision 的现有 `EmevdEditorMutation`，不调用 Bridge、不生成二进制。
- 已实现：EMEVD native writer 对 `restBehavior` 增加 uint32 失败关闭，避免 long -> uint 未检查转换；真实 native smoke 增加负值拒绝断言并清理请求临时目录。
- 已验证：`npm run typecheck`、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view` exit 0；真实 `bridge:verify:emevd` 在既有注册 corpus 上验证 1,730 events / 33,266 instructions、等长/变长 args、事件 add/delete GC 与负 `restBehavior` 拒绝。
- 未验证：完整 Sekiro EMEDF、DSL control-flow、layer 变体、DSL proposal -> Bridge/PatchIR 接线、真实 DSL mutation 的 native 重读/回滚/游戏加载、KRAK 包装。
- 非声明：本轮 DSL authority 仅 `fixture-confirmed`；真实 EMEVD smoke 维持既有 native document/mutation 范围，不把 fixture EMEDF 外推为完整 schema，不把 parser 存在写成可用 DSL 编辑器。
- 阻塞：完整 EMEDF 与 layer/KRAK corpus 仍需合法私有证据；游戏加载与发布矩阵仍按 §18 在案。

### 2026-07-24：MSB semantic scene v2 与 renderer 单一契约

- 起始：`2002076`
- 结束：未提交工作树；HEAD=`2002076` + `{packages/shared/src/scene-ir.ts, packages/shared/src/index.ts, packages/core/src/scene/msbSceneManifest.ts, packages/core/src/scene/sceneDrawList.ts, packages/core/src/scene/sceneAssetInventory.ts, packages/core/src/editing/msbBridgeRead.ts, packages/core/src/testing/runSceneDrawListSmoke.ts, packages/core/src/testing/runThreeSceneModuleSmoke.ts, packages/core/src/testing/runNativeMsbSmoke.ts, packages/core/src/testing/runHexAndSceneSmoke.ts, packages/core/src/testing/runSceneAssetInventorySmoke.ts, packages/core/src/testing/runPerformanceBaselineSmoke.ts, packages/core/src/testing/runV05FullFileWorkbenchSmoke.ts, apps/desktop/src/main/ipc.ts, apps/desktop/src/renderer/src/App.tsx, apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx, apps/desktop/src/renderer/src/scene/sceneManifestBrowser.ts, apps/desktop/src/renderer/src/scene/threeSceneController.ts, apps/desktop/src/renderer/src/styles.css, docs/V0_5_IMPLEMENTATION_HANDOFF.md}`；提交后补 SHA
- 路线：C-MSB / I-RENDER（`W-MSB-SCENE-01`）
- 状态变化：按当前双字段投影，`W-MSB-SCENE-01` lifecycle=`completed`、authority=`partial`；C-MSB 与 I-RENDER 总体仍为 `partial`
- 已实现：新增 shared、browser-safe schema v2 scene IR，所有 manifest/render packet 输出包含 `sourceUri`、相对 `sourcePath`、game、resourceKind、revision 和 diagnostics；core 与 renderer 改为消费同一实现，移除 renderer 第二套近似 builder。
- 已实现：Bridge envelope 已有的 native offset、model/event preview 经 core/main DTO 接入 renderer；model/part/region/event 四类均进入 semantic entities，part/region 进入 drawable nodes；native offset 作为 opaque identity，缺 offset/重复 identity/截断 preview 均有结构化 warning。
- 已实现：render packet 带稳定 packet revision、chunk index/count、总量、bounds 与 identity-derived color；资产 inventory 只消费 part nodes，不把 region 误识别为模型；Three renderer 边界加强 Windows/UNC/file URI/home path 泄露拒绝，region 可作为独立 proxy kind/picking 实体。
- 已实现：修复 production renderer 的 1080px 固定最小宽度；390px 下三栏收敛为单列，场景操作控件换行，模式导航仅自身横向滚动，不再让 document 横向溢出。
- 已实现：删除 full-file workbench smoke 中无条件输出的“No frontend visual changes”历史叙述，避免 renderer 已变更时测试日志仍产生虚假证据；该 smoke 继续只断言自身真实覆盖的文件工作台能力。
- 已验证：`npm run typecheck`、`npm run test:scene-draw-list`、`npm run test:three-scene-module`、`npm run test:scene-asset-inventory`、`npm run test:hex-scene`、本机环境注入后 `npm run bridge:verify:msb`、`npm run build` 均 exit 0。私有 fixture registry 的 `msb-primary`（m11 标识，脱敏）返回 models=34、parts=4,500、regions=1,089、events=46；preview scene=208 entities / 128 nodes，transform mutation 前后 part identity 稳定，authority 仍为 `candidate/partial`；该 registry 不是 release corpus。
- 已验证：Playwright 读取实际 production renderer bundle；1440x900 时 canvas=683x562、无横向溢出，390x844 时 canvas=338x278、无横向溢出；canvas PNG 分别为 317/208 个颜色、29,561/13,963 个非主背景像素，均 nonblank；点击 proxy 后选中 `gate_proxy_b`。截图位于 ignored `output/playwright/`，不作为提交资产。
- 未验证：Bridge 完整实体分页/流式传输、未知 MSB 字段/全实体 native authority、add/delete/reorder/type conversion、引用修复、真实 FLVER mesh/material/texture、WebGPU、大地图硬件性能、KRAK 包装与游戏加载。
- 非声明：本轮只提升 renderer-independent read projection 和 WebGL proxy 的可信度；不提升 MSB parser/writer、FLVER/native asset、WebGPU、游戏加载或 V0.5 发布 authority。静态服务使用 production bundle 与最小 preload mock，不替代完整 Electron 工作区人机验收。
- 阻塞：完整 scene projection 需要 Bridge 分页/流式 contract 与更多合法 native corpus；真实资产渲染、硬件基准和游戏加载仍按 §18 在案。

### 2026-07-25：发布合规 inventory、真实输入 manifest 与可复现 native build

- 起始：`2002076`
- 结束：未提交工作树；HEAD=`2002076` + `{.github/workflows/windows-ci.yml, apps/desktop/electron-builder.json, apps/desktop/src/main/ipc.ts, package.json, packages/core/src/testing/runAiFakeLoopSmoke.ts, packages/core/src/testing/runOpenAiResponsesSmoke.ts, scripts/prepare-electron-sqlite-binding.mjs, scripts/release-compliance-lib.mjs, scripts/release-compliance-policy.json, scripts/generate-release-compliance-manifest.mjs, scripts/verify-release-package-content.mjs, scripts/verify-release-compliance-fixtures.mjs, scripts/verify-reproducible-build.mjs, scripts/verify-portable-packaging-gate.mjs, docs/V0_5_IMPLEMENTATION_HANDOFF.md}`；提交后补 SHA
- 路线：REL-COMPLIANCE / H-RELEASE（`W-REL-COMPLIANCE-01`）
- 状态变化：按当前双字段投影，`W-REL-COMPLIANCE-01` lifecycle=`ready`、authority=`partial`；REL-COMPLIANCE gateState=`open`，因为 third-party notices、实际 package tree 和远程 clean build 尚未闭环；H-RELEASE 仍为 `partial / unverified`
- 已实现：从 `package-lock.json` 枚举 170 个非 dev、非 workspace-link 的 production 依赖，严格校验版本、license metadata 和 9 种仓库实际 license expression allowlist；记录已安装许可证正文路径并将 54 个 metadata-only 依赖结构化为 `LICENSE_TEXT_COVERAGE_PARTIAL` warning，不把 metadata inventory 写成完整 notices。
- 已实现：构建后生成 `apps/desktop/out/release-compliance.json`，绑定 policy/lockfile hash，并对 11 个实际 desktop `out`、package manifest 与 native runtime 输入记录相对路径、size、SHA-256 和 aggregate fingerprint；manifest 自身排除，绝对路径、目录枚举顺序、mtime/ctime 不进入 fingerprint。
- 已实现：release scan 同时检查 Git tracked 文件与发行输入，拒绝真实游戏/Mod/private corpus 路径、Oodle runtime、凭据文件名、私钥、AWS/GitHub/OpenAI 高置信 token；负向 fixture 覆盖 artifact 篡改、mtime no-op、禁用许可证、凭据路径和动态构造的凭据内容。AI fake fixture 改为低置信 synthetic token，仍由 `test:ai-fake-loop` 验证传输与脱敏，不为扫描器增加豁免。
- 已实现：`.native/electron-rebuild` 只作为编译缓存，electron-builder 与 compliance policy 仅纳入最终 `better_sqlite3.node/json`；metadata 移除 `generatedAt` 并记录确定性版本；packaged main 从 `process.resourcesPath/native` 加载 binding。MSVC rebuild 在保留已有 `CL`/`LINK` 的前提下追加 `/Brepro`，消除 COFF timestamp/PDB 标识漂移。
- 已实现：portable gate 移除 `shell:true` 和 Windows `.cmd` 直启，复用 `npm_execpath`；默认未请求 unsigned `--dir` 时返回 `ok=null/status=partial/dryPackStatus=skipped` 且 exit 0，显式请求但 builder 缺失则失败关闭，不再输出虚假 `pass-config`。
- 已验证：`npm run test:release-compliance-fixtures`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:portable-packaging-gate` 均 exit 0；随后顺序运行 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0，最终 `npm run test:release-reproducible`、`npm run test:release-content`、`npm run test:handoff-integrity`、`git diff --check` 均 exit 0。production inventory=170，license text=116 present / 54 metadata-only，artifact count=11，连续两次 fingerprint 均为 `6f22d28bfae009057d57e5bcb64936721e17357cadd6ee4be562081d1b348f0a`，manifest 字节相同且 `artifactChanges=[]`；handoff 输出继续保留 `manualReviewStillRequired`。
- 未验证：`npm ci` clean checkout 与远程 Windows CI 的跨机器结果；完整 third-party notices；electron-builder 实际 `--dir`/portable/NSIS 产物树、安装/升级/卸载、签名、更新和干净机启动；跨 Node/MSVC/Electron 工具链 bit-for-bit reproducibility。
- 非声明：本轮只把合规切片提升为 `partial`；同机连续构建 fingerprint 不等于跨工具链或 installer bit-for-bit reproducibility，portable 配置通过与 skipped pack 不等于 REL-H，通过的 metadata license inventory 不等于完整分发许可证包。
- 阻塞：54 个 production 依赖的许可证正文/notice 归档与分发裁定仍未完成；actual pack/clean-machine/signing/update 仍需 REL-H 后继切片与相应环境。
- 重复阻碍：Windows 沙箱 runner 多次返回 `CryptUnprotectData 2148073483`，同时阻断只读命令与内置 patch；仅在取得沙箱外执行能力后继续，未把工具故障写成产品失败。native binding 在连续 rebuild 中重复出现 25 字节 COFF/debug 漂移，三个 aggregate fingerprint 依次变化；最小字节对比定位后用 `/Brepro` 修复，随后两次最终 binding 字节一致。`LICENSE_TEXT_COVERAGE_PARTIAL` 在每次扫描稳定重现，当前仍是本切片保持 `partial` 的开放阻碍。

### 2026-07-25：V0.5 支持范围提案与失败关闭门禁

- 起始：`2002076`
- 结束：未提交工作树；HEAD=`2002076` + `{docs/V0_5_IMPLEMENTATION_HANDOFF.md, scripts/verify-release-scope.mjs}`；提交后补 SHA
- 路线：REL-SCOPE（`W-REL-SCOPE-01`）
- 状态变化：`W-REL-SCOPE-01` lifecycle=`completed`、authority 仍为 `unverified`；提案 artifact validation=`proposal-valid`；用户裁定后继 `W-REL-SCOPE-RULING-01` 与 `BLK-SCOPE-RULING` 在案，REL-SCOPE 不进入完成态
- 已实现：在本文 §18.2.1 内嵌唯一 JSON proposal block，`game=Sekiro`、`proposalStatus=awaiting-user-ruling`、`unlistedPolicy=unsupported`；27 个唯一 scope item 复用 §3.1 capability ID，覆盖 Sekiro build、A、DFLT/KRAK/BND4、FMG/PARAM/EMEVD/MSB、TAE/ESD/Lua-HKS、FLVER/TPF/MTD/collision/navigation/open conversion、编辑器、AI、运行发行、渲染、合规。
- 已实现：每项分别记录 proposed operations、明确 unsupported operations、裁定时 `authorityAtRuling`、Evidence refs、脱敏 registry refs、open rulings 与 nonClaims；开发期私有 fixture registry 全部标为 `releaseCorpus=false`，无路径、哈希或私有文件身份进入提案，缺 release corpus 的 supported 项不得关闭裁定。
- 已实现：新增显式 11 项 `gateCoverage`，逐 Gate 记录 scopeItem refs、与 §18.3 一致的 `open|blocked` currentState、合法 blockerRefs 与 openRulings；不允许提案把 Gate 写成完成态。行为与资产分别拆为可逐项裁定的格式/转换项，不再由 D/E 总览行隐式代替。
- 已实现：`scripts/verify-release-scope.mjs` 校验唯一 marker/JSON、proposal/scope/authority/subject/registry 枚举、scopeItemId 唯一、§3.1 capability、§17.1 Evidence、§18.1/§18.3 Gate、§18.4 blocker、27 个必需 scope item、显式 gateCoverage 双向引用、registry 逻辑引用、非声明和绝对路径防线；待裁定时要求 `gameBuildRange.builds=[]` 与 ruling metadata=null，严格冻结则要求精确 build 和完整用户批准元数据。
- 已验证：`node scripts/verify-release-scope.mjs --proposal` exit 0，输出 `ok=null/status=proposal-valid/frozen=false`、27 scope items、11 Gates、零 findings；默认 `node scripts/verify-release-scope.mjs` 按预期 exit 1，输出 `status=awaiting-user-ruling/frozen=false` 并命中 `RELEASE_SCOPE_NOT_FROZEN`。
- 样本范围：提案只引用 §17.1 已有证据与脱敏逻辑 registry role；当前 MSB registry identity 已按实际 `msb-primary` 的 m11 标识修正，仍明确不是 release corpus。
- 未验证：用户尚未逐项批准、修改或排除范围；无 sealed scope Evidence；无发布 corpus；性能、容量、Windows/me3/build、行为动画格式、资产转换和真实 provider 终局值均未裁定。
- 非声明：`proposal-valid` 只表示提案结构可审查，不表示范围获批、REL-SCOPE 通过、V0.5 完成，也不提升任一 native、编辑器、AI、runtime、渲染或合规 authority。
- 阻塞：`BLK-SCOPE-RULING`；必须由用户完成逐项裁定，Agent 不得推断批准。

### 2026-07-25：推进活性、Gate 双状态与 Evidence 封存治理

- 证据类型：`sealed-current-run`
- 起始：`HEAD=20020766506ea71d66d3b9b9ea867aa534aaa3a9`
- 结束：`trackedDiffSha256=4621e9898de5250b8d72d309af2396e2de00351fcefb760855cbeedd42440d5f`；`untrackedManifestSha256=f499f192e40be3b4f91cb01336478251435ad1789ef168aacfcdbd452f9c7c35`；`handoffSha256BeforeEvidenceAppend=313dbde91970b6d9a3bccb0bb244de3ce0f2a6ce44122560eebf6af625a562b2`；`fingerprintSha256=3067512cc0068ad13cf50011889a19c3104dc3a0d6b9b3cd7c76788ebe3e43c9`
- 路线：全局交接治理、REL-SCOPE、REL-A/B/C/F/I；不改变产品运行时 API、Patch Engine 或 native writer
- lifecycle 变化：旧 `ready/research-ready/ready-readonly` 统一为 `ready`；`W-EMEVD-DSL-01`、`W-MSB-SCENE-01`、`W-REL-B-REGISTRY-01`、`W-REL-F-ACCEPT-01` 为 `completed`；环境或凭据依赖后继为 `blocked`；Q1 只继续已登记且可回收的 `active` claim
- authority 变化：原 `partial/fixture-confirmed/candidate` 从生命周期中分离到独立 authority；每个切片保留 authority cap，门禁拒绝 authority 越过 cap；本轮不提升 production native authority
- blockerRefs 变化：引入八字段 blocker 表和固定原因枚举；native writer/PARAM 私有验证统一引用 `BLK-NATIVE-FIXTURE-CORPUS`；工程 wrapper 已解析 .NET SDK 10.0.301，因此不再保留虚假 toolchain blocker；渲染 benchmark 只受硬件输入阻塞，阈值裁定留给取得基线后的后继
- 已实现：项目级规则迁入本文，README 直链本文，handoff 门禁不再依赖仓库 `AGENTS.md`；本机 `AGENTS.md` 保留并从 Git 索引移除，继续由 `.gitignore` 忽略。用户 Mod 资源写入仍必须经过 Patch Engine；受信 core/Bridge 证据可保留 `sourcePath`，renderer-safe DTO 必须移除绝对路径；前端专门 Agent 改为优先分工。
- 已实现：执行面板拆分 `lifecycle`、`authority`、authority cap；Gate 矩阵拆分 `gateState` 与 `applicability`，固定 11 个 Gate，基础 Gate 永远 `in-scope`。完成/替代切片不得覆盖 open Gate，blocked Gate 不得隐藏 ready/active 工作；active claim 带失联回收规则，Evidence freshness 变化会使旧 Gate pass 失效。
- 已实现：`W-REL-B-CORPUS-01` 拆为已完成的 registry/harness 与依赖私有 corpus 的 blocked 后继；native recovery、PARAM metadata 和 REL-F acceptance 同样拆分为可公开推进的 harness/contract 与真实环境后继。新增 handoff integrity fixture、指纹生成器和确定性错误码，覆盖非法 lifecycle/authority、终态切片覆盖 open Gate、缺失或未封存 Evidence、非法范围排除、非法/空 blocker、authority 超 cap、失联 active 与工作树漂移。
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-corpus-registry`、`npm run test:release-editor-acceptance`、`npm run test:handoff-integrity`、`git diff --check` 均 exit 0；handoff fixture 共 38 cases，真实文档 `findings=[]`；`manualReviewStillRequired` 保留 Evidence 真实性、路线/authority 语义及平行治理文档三项人工审查。
- 已验证：`npm run bridge:build` exit 0，项目 wrapper 解析到 .NET SDK 10.0.301；`npm run test:release-scope-proposal` exit 0 且为 `proposal-valid`；`npm run test:release-scope` 按预期 exit 1 并命中 `RELEASE_SCOPE_NOT_FROZEN`，证明未获用户裁定时失败关闭。
- 已验证：连续两次 `npm run handoff:fingerprint` 得到相同五字段结果；`AGENTS.md` 仍在磁盘，`git ls-files AGENTS.md` 为空，`git check-ignore -v AGENTS.md` 命中 `.gitignore`。
- 未验证：`npm run test:native-writer-failure-matrix` 与 `npm run bridge:verify:param` 均因缺少仓库外注册 fixture exit 1，归入 `BLK-NATIVE-FIXTURE-CORPUS`；本轮未重跑私有 native corpus、真实游戏、真实模型服务、真实硬件 benchmark、installer/签名或干净机验证。
- 非声明：该 sealed Evidence 不含 `scope-ruling:user-approved` 或任何 `scope-exclusion:*:user-approved` 标记，不支持 REL-SCOPE 或其他 Gate 进入 `passed`/`scope-excluded`；提案有效不等于用户批准，fixture/candidate/partial 不等于 native-verified 或 V0.5 完成。
- 阻塞：REL-SCOPE 继续由 `BLK-SCOPE-RULING` 失败关闭；私有 native writer/PARAM 验证继续由 `BLK-NATIVE-FIXTURE-CORPUS` 阻塞。其余 open Gate 仍必须至少引用一个 `ready`/`active` 切片，不允许被完成切片或 blocker 隐藏。

### 2026-07-25：公开后端 contract、失败关闭与发行门禁封存

- 证据类型：`sealed-current-run`（`EV-PUBLIC-CONTRACTS-20260725`）
- 起始：`HEAD=20020766506ea71d66d3b9b9ea867aa534aaa3a9`
- 结束：`trackedDiffSha256=4caed8aa7f2647304d9f22a19fbd10e3f07c914f6334a6970ecf4885de1d8fad`；`untrackedManifestSha256=32b6faf6d0e1e92ed25a93903a0154c7803f0f49c4d64875f7f27baa61093b64`；`handoffSha256BeforeEvidenceAppend=f67684684b8e703f433c3495051cab381b4045de43af157a1b005cc07c77d9d6`；`fingerprintSha256=a450562260693252e75d6d81226aff97b9a43f3eeb39ebf7fce573c78b210839`
- 路线：A-RECOVERY、C-PARAM、H-RUNTIME、REL-B、REL-F、REL-COMPLIANCE；未修改 renderer/UI
- lifecycle 变化：`W-A-RECOVERY-HARNESS-02`、`W-PARAM-META-01`、`W-ME3-ADAPTER-01` 达到各自公开 contract 边界并改为 `completed`；新增 blocked `W-PARAM-META-SOURCE-02`、ready `W-EMEVD-PATCHIR-02` 与 ready `W-ME3-MAIN-DETECT-02`
- authority 变化：A recovery harness、PARAM metadata contract、me3 adapter contract 与 REL-B registry 为 `fixture-confirmed`；REL-F acceptance 为 `candidate`；`W-REL-F-SCALE-02` 的 `candidate` 只继承缺口分类 harness；REL-COMPLIANCE 仍为 `partial`
- blockerRefs 变化：REL-A 改由 `W-A-RECOVERY-NATIVE-02` / `BLK-NATIVE-FIXTURE-CORPUS` 失败关闭；新增 `BLK-PARAM-METADATA-SOURCE`，同时约束 metadata source 与 metadata/native 一致性切片；REL-SCOPE 等既有 blocker 保持不变
- 已实现：Bridge client 对出站编码/frame/write 失败、注册期取消、同步/异步 progress handler、terminal race 和背压 close/timeout/cancel 统一结算；recovery fake daemon 覆盖 stage/validate/commit/re-read、process exit 和显式 restart；staging 在 writer 调用前拒绝 11 个代表性不安全 path segment case 并回收临时目录。
- 已实现：PARAM metadata package/source/license/definition/trust/overlay 只消费隔离 plain-data 快照；拒绝 Proxy、accessor、cycle、稀疏/扩展数组、显式 `undefined` 和超预算输入；校验、digest、匹配与 overlay 不再回读调用方对象，成功结果递归冻结但不冻结调用方输入。
- 已实现：renderer-independent `GameRuntimeAdapter` 与 contract-only `Me3RuntimeAdapter` 覆盖闭集 gateway schema、精确版本 policy、1,024 字符输出上限、脱敏、超时/取消和竞态；匹配 fixture 仍为 `exit-zero-unverified`，profile/launch/diagnostics/terminate 均结构化 `unsupported`，production main gateway 尚未接线。
- 已实现：REL-B metadata-only registry 与 REL-F acceptance harness 维持失败关闭；发行 builder JSON、scratch boundary、subprocess tree/timeout/cancel/output cap、内容/许可证 inventory 和同机可复现指纹均有公开正负验证。
- 已验证：顺序 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0；定向运行 `npm run bridge:verify:client`、`npm run test:bridge-recovery-harness`、`npm run test:bridge-staging`、`npm run test:param-metadata-mismatch`、`npm run test:paramdef-layout`、`npm run test:me3-runtime-adapter`、`npm run test:release-corpus-registry`、`npm run test:release-editor-acceptance` 均 exit 0。
- 已验证：`npm run test:release-compliance-fixtures`、`npm run test:portable-packaging-config-fixtures`、`npm run test:subprocess-control`、`npm run build`、`npm run test:release-content`、`npm run test:release-reproducible` 均 exit 0；170 个 production dependencies、许可证正文 116 present / 54 metadata-only、11 个 artifacts；连续两次 artifact fingerprint 均为 `6f22d28bfae009057d57e5bcb64936721e17357cadd6ee4be562081d1b348f0a`，manifest SHA-256 为 `48d8eda021e041d10464cd3f8e641ae23db1333ad760e4ca2708c57e5e2ff0af`。
- 已验证：`npm run test:portable-packaging-gate` exit 0 但 `ok=null/completed=false/status=partial/dryPackStatus=skipped`，当前 electron-builder dependency 未安装；`npm run test:private-native-gate` 与 `npm run test:section28-sekiro-gate` 均 exit 0 / `status=skipped`；连续两次 `npm run handoff:fingerprint` 五字段完全一致。
- 未验证：合法可再分发的真实 metadata 来源与许可证、仓库外 native/release corpus、production me3 main gateway 与真实 me3/Sekiro、真实 Electron 人机规模验收、真实硬件 benchmark、unsigned `--dir`/portable/NSIS 实际 pack、完整 notices、installer、签名、升级、更新、干净机和跨工具链复现。
- 非声明：`fixture-confirmed` 不提升 production native writer/PARAM/runtime authority；`candidate` 不等于编辑器验收；`partial/skipped` 不等于发行通过；本 Evidence 不含用户范围批准声明，不支持任何 Gate `passed`/`scope-excluded` 或 V0.5 完成。
- 阻塞：`BLK-NATIVE-FIXTURE-CORPUS`、`BLK-PARAM-METADATA-SOURCE`、`BLK-SCOPE-RULING` 及 §18.4 其余外部 blocker 保持有效；REL-C/REL-F/REL-H/REL-COMPLIANCE 只由各自 ready 后继继续推进。

### 2026-07-30：V0.5 范围逐项批准、语义编辑边界与内部测试发行冻结

- 起始：`HEAD=e32e8144225ee904e38e87102470cf84bd428075`
- 结束：未提交工作树；HEAD=`e32e8144225ee904e38e87102470cf84bd428075` + `{docs/V0_5_IMPLEMENTATION_HANDOFF.md, scripts/verify-release-scope.mjs, scripts/verify-release-scope-fixtures.mjs}`；提交后补 SHA
- 路线：REL-SCOPE（`W-REL-SCOPE-RULING-01`）；只修改范围治理，不实现任何新增 parser、writer、编辑器、AI、runtime、renderer 或 installer
- lifecycle 变化：`W-REL-SCOPE-RULING-01 blocked -> completed`；`REL-SCOPE blocked -> passed`；`REL-B/C/D/E/F/G/I pending-scope -> in-scope`；`BLK-SCOPE-RULING` 无活动引用，仅保留历史审计与范围变更复查触发器
- authority 变化：无；27 项裁定时 `authorityAtRuling` 原值保持不变，`unverified`、`candidate`、`fixture-confirmed`、`partial`、`native-verified` 不因用户批准升级
- 已冻结：Sekiro 文件/产品版本 `major.minor=1.6`，族外失败关闭；单 Mod 叠加层；全部 writer 恢复门禁；DFLT/KRAK/BND4、全语言 FMG、全部 ParamType/EMEVD、登记 MSB 实体、全部 TAE/ESD/脚本的声明操作；五类 native 资产只读与 native-to-open 导出；双 provider 语义 typed mutation；me3 capability probe；WebGPU 主路径/WebGL2 回退；Windows 10/11 x64 签名 NSIS 的所有者内部测试边界
- 已冻结编辑不变量：交付 BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/脚本八个结构化 UI + DSL 语义编辑器；两种投影共享 Bridge native document、revision、selection 和 typed mutation；未知字段只读 opaque；Hex 只读且不能形成 raw write
- 已实现：release-scope schema `1.1.0` 显式区分 `versionFamilies` 与 `exactBuilds`，固定 `file-product-version-major-minor` 和 `fail-closed`；冻结矩阵负向检查覆盖 DSL、只读 Hex、KRAK 重压/写入、签名 NSIS、portable/自动更新排除、所有者控制目标、禁止外部分发与反向 native 导入
- 已验证：`npm run test:release-scope-fixtures` exit 0，15 个正/负 case；`npm run test:release-scope-proposal` exit 0、`frozen=true`；`npm run test:release-scope` exit 0、`status=scope-approved`；顺序运行 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0
- 未验证：当前 `package.json` 不存在 `test:progress-integrity`，实际调用按预期 exit 1/Missing script，未用其他门禁冒充；真实 corpus、完整 metadata 权利、KRAK 压缩、全部语义 parser/writer、八编辑器人机验收、真实 provider/me3/硬件、签名 NSIS 和干净机仍由后继 Gate/blocker 约束
- 非声明：范围批准、strict scope pass 和 sealed Evidence 只支持 `REL-SCOPE`；不支持任一功能 Gate 通过，不证明 V0.5 完成，也不授权外部分发内部测试构建

### 2026-07-30：撤销代码签名验收项，保留 NSIS 完整性与内部测试边界

- 起始：`HEAD=7a6c35ca639bc19324892a86957b7151737d33f8`
- 结束：未提交工作树；HEAD=`7a6c35ca639bc19324892a86957b7151737d33f8` + `{docs/V0_5_IMPLEMENTATION_HANDOFF.md, scripts/verify-release-scope.mjs, scripts/verify-release-scope-fixtures.mjs, scripts/generate-release-compliance-manifest.mjs, scripts/verify-release-package-content.mjs, scripts/verify-portable-packaging-gate.mjs, scripts/verify-portable-packaging-config-fixtures.mjs, packages/core/src/testing/runMe3RuntimeAdapterSmoke.ts}`；提交后补 SHA
- 路线：REL-SCOPE（`W-REL-SCOPE-RULING-02`）；用户明确删除代码签名验收项，不实现 installer、runtime 或其他功能
- lifecycle / Gate 变化：新增并完成 `W-REL-SCOPE-RULING-02`；`REL-SCOPE` 继续为 `passed/in-scope`，改为引用本轮 fresh sealed Evidence；其他 Gate 状态不变
- authority 变化：无；27 项裁定时 `authorityAtRuling` 原值保持不变，任何功能和发行 authority 均不因取消签名要求升级
- 当前发行裁定：Windows 10/11 x64 NSIS，仅限项目所有者控制的内部测试机器；允许未签名；仍强制确定性 installer manifest/hash、内容扫描、干净机安装、升级、卸载和 runtime 完整性；portable、自动更新和外部分发继续 unsupported
- 已实现：release-scope schema `1.2.0` 将 `package-nsis-x64` 与 `verify-installer-artifact-hash` 固定为范围要求，并以负向 fixture 拒绝重新引入 `package-signed-nsis-x64`、`verify-signed-installer-provenance` 或“未签名包不得作为内部测试构建”的旧边界；release manifest、portable dry-run 和 me3 smoke 的当前 nonClaim 同步删除签名完成要求
- 已验证：`npm run test:release-scope-fixtures` exit 0，18 个正/负 case；`npm run test:release-scope-proposal` exit 0、`frozen=true`；`npm run test:release-scope` exit 0、`status=scope-approved`；`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0；portable config 17 个 fixture、portable gate、me3 adapter smoke 和 release manifest 均完成其声明范围验证，portable gate 与 release manifest 诚实保持 `partial`
- 非声明：未签名 NSIS 不证明发布者身份、证书信任链或 SmartScreen 信誉；删除签名验收不放宽 secret/private asset/Oodle/许可证扫描，不授权任何外部分发，也不证明 REL-H、REL-COMPLIANCE 或 V0.5 完成

### 2026-07-30：固定所有者输入边界，解除 metadata/凭据/硬件用户阻塞

- 证据类型：`sealed-current-run`（`EV-REL-SCOPE-20260730-OWNER-INPUTS`）
- 起始：`HEAD=3af0da8b5d061199e8d71e591d2b05ebc94a54c5`
- 结束：未提交工作树；HEAD=`3af0da8b5d061199e8d71e591d2b05ebc94a54c5` + `{docs/V0_5_IMPLEMENTATION_HANDOFF.md, scripts/verify-release-scope.mjs, scripts/verify-release-scope-fixtures.mjs}`；提交后补 SHA
- 路线：REL-SCOPE（`W-REL-SCOPE-RULING-03`）；只修改范围/责任边界并准备外部 me3 工具，不实现 PARAM source adapter、AI production loop、runtime gateway 或 renderer backend
- lifecycle / Gate 变化：`W-PARAM-META-SOURCE-02 blocked -> ready`；`W-AI-REAL-01` 与 `W-RENDER-BENCH-01` 改为 `superseded`，新增 `ready` 的 `W-AI-CONFORMANCE-02`、`W-RENDER-FUNCTIONAL-02`；`REL-G`、`REL-I` 由 `blocked -> open`；`REL-SCOPE` 继续为 `passed/in-scope` 并引用本轮 fresh sealed Evidence
- blockerRefs 变化：`BLK-PARAM-METADATA-SOURCE`、`BLK-MODEL-CREDENTIALS`、`BLK-RENDER-HARDWARE` 均无当前活动引用，只保留历史审计与未来范围变更触发器；`W-PARAM-META-NATIVE-01` 仍由 `BLK-NATIVE-FIXTURE-CORPUS` 阻塞
- 已冻结：PARAM metadata 只从用户本机固定 Smithbox 2.2.4 发行包导入，校验 commit/artifact digest，禁止随 SoulForge 再分发；OpenAI-compatible/Anthropic-compatible 配置默认留空，live endpoint/key 不作为验收；me3 provisioning 归工程方；渲染只要求项目所有者当前机器的 WebGPU/WebGL2 功能闭环，不要求代表性硬件档位或性能预算
- 已验证：Smithbox 官方仓库支持 Sekiro 且 2.2.4 `SDT` PARAM 路径存在；其根/发行包带 MIT 正文，但提交历史显示部分数据源自无独立 LICENSE 的 Paramdex，因此采用本机导入而非捆绑再分发；官方 me3 v0.12.1 发行包 digest 与本机下载一致，真实 CLI 返回 `me3 0.12.1` 且 profile 命令列出 Sekiro，不启动游戏
- 已验证：范围 25 个正/负 fixture、proposal/strict scope、最低公开回归、PARAM metadata/layout、AI fake/Responses、me3 adapter、scene/Three contract 与 `git diff --check` 均 exit 0；连续两次 handoff fingerprint 五字段一致
- authority 变化：无；外部来源/工具发现和用户裁定不提升任何 parser、writer、provider、native runtime、renderer 或 release authority
- 非声明：未导入 Smithbox metadata、未实现 source adapter、未使用真实模型服务、未把 me3 接入 production main gateway、未启动 Sekiro、未运行 WebGPU/WebGL2 真实功能闭环或硬件 benchmark；V0.5 仍未完成

### 2026-07-30：落实已裁定所有者输入，建立本机 source/corpus/runtime/空配置门禁

- 证据类型：`sealed-current-run`（`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`）
- 起始：`HEAD=cc97cf4c9ef6ee5a1df03590e7401f9d3b264c3d`
- 结束：未提交工作树；只包含本轮 PARAM source adapter、release corpus、me3 main gateway、模型空配置门禁、依赖锁与本交接书改动；提交后补真实 SHA
- 路线：A-RECOVERY、B-CONTAINER、C-PARAM、D-BEHAVIOR、E-ASSET、G-AGENT、H-RUNTIME、REL-SCOPE；本轮消费已获批准的本机输入，不新增范围、不修改八个语义编辑器与只读 Hex 边界
- lifecycle / Gate 变化：`W-PARAM-META-SOURCE-02 ready -> completed`，`W-ME3-MAIN-DETECT-02 ready -> completed`，新增 `ready` 的 `W-ME3-PROFILE-03`；`W-A-RECOVERY-NATIVE-02`、`W-PARAM-META-NATIVE-01`、`W-AI-CONFORMANCE-02`、`W-REL-B-CORPUS-01` 继续按真实证据保持 `ready/partial` 或 `ready/fixture-confirmed`；REL-A/B/C/D/E/F/G/H/I/COMPLIANCE 均保持 `open/in-scope`，仅以本轮 fresh Evidence 重新封存已批准的 `REL-SCOPE passed`
- blockerRefs 变化：合法本机 corpus、固定 Smithbox 来源、空 provider 配置、工程方 me3 provisioning 与功能性渲染边界均已可由工程方推进；相关历史 blocker 无当前活动引用，未完成 parser/writer/recovery/conformance/runtime/renderer/installer/notices 工作保留为各 Gate 的工程切片，不再列为需要用户输入
- 已实现：固定 Smithbox 2.2.4 本机 source adapter 校验 release slot、发行包/提取树/license digest、目录边界、symlink、升级与撤回，使用禁用 DTD/entity 的流式 XML 解析并保持未知 enum opaque；导入 160 个 definition、7,028 个字段、124 个英文注释类型，解析 59 个 enum 引用，253 个未解析引用保持为空
- 已实现：仓库外 release corpus 生成器扫描 214 个 DCX、按内容去重为 198 项脱敏 registry；完成 144 个 DFLT roundtrip、75 个 BND4 roundtrip/CRUD（11,344 个容器条目）和 70 个 KRAK 只读解压，并建立 behavior/script/asset 的容器级 inventory；registry 不含本机路径、真实资产或凭据
- 已实现：desktop main-owned me3 detection gateway 只访问固定工具槽，使用无 shell、隐藏窗口、最小环境、固定 argv、输出上限、超时/取消、realpath containment 与闭集 IPC；真实 0.12.1 probe 仍返回 `exit-zero-unverified`，不启用 profile 或 launch
- 已实现：OpenAI-compatible / Anthropic-compatible 共用配置工厂在默认空配置时以结构化 `unconfigured`、零网络请求失败关闭；非法 endpoint、URL credential/search/hash 和非 loopback HTTP 均拒绝，模型仍不能获得 native mutation authority
- 已验证：固定 Smithbox source smoke、me3 main gateway smoke、模型配置与双协议 fake loop、release corpus registry 正负 fixture、本机完整 corpus 生成、native DCX document scan、private native gate、release content/compliance/reproducibility、desktop security 与依赖审计均按各自声明边界完成；private native gate 聚合状态保持 `partial`，PARAM 抽样 40 个中 38 个通过、2 个旧布局失败关闭；依赖审计为 0 个已知漏洞
- authority 变化：只将固定本机 metadata source adapter 和 me3 production detection gateway 的切片 lifecycle 标为完成；KRAK 仅提升到已登记 corpus 的 read/no-op/CRUD `partial`，行为与资产 inventory 仍为 `candidate`，AI 空配置仍为 `fixture-confirmed`，没有任何功能 Gate 进入 `passed`
- 非声明：不声明 KRAK 重压/写回、全部 PARAM 布局、MSB/TAE/ESD/资产完整语义、八个编辑器、真实 provider、me3 profile/launch、真实 Sekiro 会话、WebGPU/WebGL2 功能闭环、NSIS 安装/升级/卸载、完整 notices、外部分发或 V0.5 完成

### 2026-07-30：删除编辑器与 installer 量化预算，保留功能正确性门禁

- 证据类型：`sealed-current-run`（`EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS`）
- 起始：`HEAD=1cabdd93714448ba311e5058e0e06cd47c6958f5`
- 结束：未提交工作树；只包含 release editor acceptance contract、范围 verifier/fixture 与本交接书改动；提交后补真实 SHA
- 路线：REL-SCOPE（`W-REL-SCOPE-RULING-04`）、REL-F、REL-H；用户明确删除大文档容量/延迟门槛和 installer 体积/启动/升级/回滚耗时预算
- lifecycle / Gate 变化：新增并完成 `W-REL-SCOPE-RULING-04`；`REL-SCOPE` 继续为 `passed/in-scope` 并改引本轮 fresh sealed Evidence；所有功能 Gate 状态和 authority 不变
- 已冻结：编辑器仍必须读取真实 native document、使用 typed mutation、拒绝 stale revision，并让完整内容可通过 pagination/virtualization/chunking/streaming 访问；installer 仍必须通过确定性 manifest/hash、干净机安装、覆盖升级、卸载与 packaged runtime 完整性，但两者均不设量化预算或阈值
- 已实现：release-scope schema `1.4.0` 新增机器可判定的 `quantitativeAcceptancePolicy`；release editor acceptance schema `2` 删除 tier、capacity、latency 和 pending threshold ruling，改为 `quantitativeThresholdsRequired=false` 与工程方真实功能验收
- 已验证：`test:release-editor-acceptance`、`test:desktop-live-editor-contract`、31 个 release-scope 正负 fixture、proposal/strict scope、最低公开回归与 `test:release-content` 均 exit 0；release content 仍诚实保持 `partial`，未把 55 个 metadata-only 依赖或未完成 installer lifecycle 写成通过
- authority 变化：无；取消量化门槛不证明当前 bounded-window/eager 缺口已关闭，不证明八个编辑器或 NSIS lifecycle 完成
- 非声明：不以“无数值预算”解释为允许 eager materialization、固定窗口截断、缺失内容不可达、跳过安装/升级/卸载、跳过 manifest/hash，亦不声明 REL-F、REL-H 或 V0.5 完成

### 2026-07-31：EMEVD DSL plan production 接线、AI 写矩阵与 MTD/inventory Bridge 命令

- 证据类型：`sealed-current-run`（`EV-EMEVD-PATCHIR-20260731`）
- 起始：`HEAD=ea9d899144cebd7ed6b71006d376cb80ebbc9513`
- 结束：`trackedDiffSha256=920c8b4f14108911ae9f24736ff1fd3e0286213d3ccc6c97005399fdedbcaf91`；`untrackedManifestSha256=ac9858865ae974772cbd9131a87a8d401760f0c36a0355d9a9d11e9eb5e047b7`；`handoffSha256BeforeEvidenceAppend=b6867f2470012ee2bd8e2ee5faaa517a0e43a95907fc1f6f7f3b47ba2f3ca56d`；`fingerprintSha256=f34d229347b76468f40ca5f6149d7443debe05aedcc47cc1637e523a63eae9ff`
- 路线：C-EMEVD（`W-EMEVD-PATCHIR-02`）、G-AGENT（`W-AI-CONFORMANCE-03`）、E-ASSET（`W-FLVER-READ-01` 的 MTD/inventory 子项）、D-BEHAVIOR（`W-BEHAVIOR-MAP-01` 研究工具）
- lifecycle 变化：`W-EMEVD-PATCHIR-02 ready -> completed`；`W-AI-CONFORMANCE-03` 继续 `ready`（写矩阵 case 完成但整切片验收边界未收口）；`W-FLVER-READ-01` / `W-BEHAVIOR-MAP-01` 继续 `ready`
- authority 变化：C-EMEVD 总体维持 `partial`；AI 写矩阵维持 `partial`；MTD 只读投影为 `candidate`；`inventory-asset-resources` 为容器级 `candidate` inventory；均不开放 native writer
- 已实现：`emevdFourViewController.submitEmevdDslPlanViaFourView` 与 `emevdPlanCommit.commitEmevdPlanViaPatchEngine` 形成 production 写链：DSL compile → typed plan → `stageEmevdPlanViaBridge`（Bridge batch staging，`emevdBridgeCommit.commitEmevdBatchViaBridge`）→ `buildEmevdFileReplacePatch`（file_replace PatchIR，content-hash 前置条件 + binary_roundtrip validator 要求）→ `executePatchIrThroughTransaction`（WorkspaceTransaction stage/validate/commit/backup/re-read/rollback）→ Bridge 独立重读；`applyEmevdPlanToDocument` 使四视图文档 revision+1 并同步计划效果
- 已实现：修复 `EmevdNativeWriter` 验证循环对组合 mutation 的顺序敏感 bug（set_rest_behavior 验证在 update_id 改名后按旧 ID 找不到事件），增加 id 重命名映射（renameMap + ResolveFinalId）；修复 `dslCompiler` 事件 id 唯一性检查对真实 corpus 既有重复事件 id（common.emevd 中 88881000 出现两次）的误拒绝——只拒绝计划显式引入的冲突
- 已实现：`runEmevdPlanCommitProductionSmoke.ts` 冻结为 `test:emevd-plan-production`（合成成功链/回滚链/失败链 + 本机环境注入时真实 common.emevd 事件级 id/rest mutation）；`syntheticEmevdBytes.ts` 提供微小合法合成 EMEVD 构造器；`runEmevdPlanCommitSmoke.ts` 扩展 13 cases（PatchIR op shape、事务回滚、plan apply、stale revision 等）
- 已实现：AI conformance 扩展为 20 cases——agent loop 驱动 scaffold typed registry 对真实临时工作区执行 propose→stage→validate→commit→re-read 多步写矩阵，覆盖 normal 确认、plan 只读、validation 失败阻止、stale revision 冲突、取消/超时/限额不提交、full 权限 PATCH_ENGINE_REQUIRED 与 policy gate 单元矩阵；scaffold registry 新增 `workspace.readFile` 等只读工具，`patch.proposeTextEdit` 增加内容 hash 前置条件
- 已实现：Bridge 新增 `read-mtd-document`（`MtdNativeDocument`，安全 XML 结构投影：DTD/外部实体拒绝、16 MiB/5,000 元素上限、重复解析一致性验证，candidate）与 `inventory-asset-resources`（容器级资产类别 inventory：DCX 解包 + BND4 条目枚举，逻辑名/计数/类别聚合脱敏输出）；`_tmpProbeHeaders.ts` 转正为 `probeBehaviorHeaders.ts`（移除硬编码路径，`SOULFORGE_SEKIRO_GAME_ROOT` 缺失失败关闭，接入 `probe:behavior-headers`）
- 已修复：core 包缺失 `test:emevd-dsl-compiler` script（root 代理但 core 无定义导致命令失败）；`exactOptionalPropertyTypes`/`noUncheckedIndexedAccess` 严格模式下的 3 处类型错误
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run test:emevd-plan-commit`（13/13）、`npm run test:emevd-plan-production`（合成 3 + native 1，通过 `node scripts/with-local-has-game-env.mjs` 注入本机环境）、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view`、`npm run test:ai-conformance`（20/20）均 exit 0；本机环境注入后 `npm run bridge:verify:emevd` exit 0（1,730 events / 33,266 instructions，含事件 GC add/delete 回归）
- 已验证：MTD 合成 XML 正/负 case（结构投影一致、DTD/实体拒绝）、`inventory-asset-resources` 单资源分类通过 Bridge 命令验证（本机临时目录，无资产提交）
- 样本范围：真实 `emevd-primary`（mods/event/common.emevd.dcx，1,730 events / 33,266 instructions，含既有重复事件 id 88881000）；合成 EMEVD fixture；AI 本地 contract server；MTD 合成 XML
- 未验证：完整 EMEDF schema、layer 变体、DSL 全局指令级 mutation、KRAK 包装 EMEVD、真实游戏加载；AI Context Broker 与完整生产多步任务闭环；MTD 真实 .mtd 样本（本机 corpus 未发现，保持 candidate）；collision/navigation
- 非声明：production smoke 不证明完整 EMEDF/layer/游戏加载；MTD/inventory 只读投影不构成 native authority；AI 离线写矩阵不证明第三方服务可用性；本轮未重跑私有 FLVER/TPF/MSB/PARAM corpus、Oodle、真实 me3/Sekiro、Electron 人机功能或 NSIS lifecycle；不包含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态或 V0.5 完成
- 阻塞：无新增外部阻塞；完整 EMEDF/layer/游戏加载、HKX/Lua 语义、collision/navigation 与 NSIS/me3 lifecycle 继续由既有 Gate/切片失败关闭

### 2026-07-31：真实 corpus 指令分布提取与 EMEDF 覆盖分析基线

- 证据类型：`sealed-current-run`（`EV-EMEVD-COVERAGE-20260731`）
- 起始：`HEAD=3e05add3d836bb910487496342204fa68a257d31`
- 结束：`trackedDiffSha256=67106682572cb66fc7527c68550e5ff99ca2d88f89466269ac139f946c1d6b0c`；`untrackedManifestSha256=d50f178e8ce170d758a90d951b42dee1fe2d01f1bc49574c88c4541e28859e0c`；`handoffSha256BeforeEvidenceAppend=c3baa1f51603c2d60c8fe00be8b8f7b2f645dace3bff7d25bbbe4efa7712bf29`；`fingerprintSha256=0e3453f49c4ca1b4b194d18afa2bd50b570adc5b03d8cc7a7fbf3275634345d9`
- 路线：C-EMEVD（`W-EMEVD-FULL-01`）
- lifecycle 变化：`W-EMEVD-FULL-01` 继续 `ready`；本子推进完成其分布提取与覆盖分析基线，完整类型覆盖/control-flow/全局指令级 mutation/UI 接线未完成
- 已实现：Bridge `read-emevd-document` envelope 新增 `instructionDistribution`（bank/id → count + args 长度直方图；全量聚合、按实例降序、2,000 种安全上限、仅计数与长度，绝不输出 payload 内容）；修复聚合计数对 struct tuple 值拷贝未写回 dictionary 的 bug；TS 新增 `emedfCoverage.ts`（`analyzeEmedfCoverage` 种类/实例覆盖率、schema 声称编码长度与真实长度一致性、未知种类上限 500、`schemaLengthVsObserved` 单定义对照）；`emedfSchema.ts` 导出 `encodedEmedfArgsLength`
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:build` exit 0；`npm run test:emevd-coverage` 合成断言 5 组（覆盖种类/干净种类/未知种类/长度不匹配细节/空分布不除零/长度对照）exit 0；本机环境注入后同一命令 exit 0——真实 `emevd-primary` common.emevd 分布 142 种/33,266 条实例（未截断），分布实例总和与 envelope instructionCount 一致；fixture registry 覆盖 1 种（种类 0.7%、实例 5.7%），`2000:0` IfConditionGroup 观察长度 12/16/20/24/32（多长度变体，schema 长度 12 匹配其中一种），`1000:0` WaitFor 与 `2003:1` EndEvent 未在真实 corpus 出现；`npm run bridge:verify:emevd` 真实注入 exit 0（1,730 events / 33,266 instructions 回归含事件 GC）
- authority 变化：无；`W-EMEVD-FULL-01` 保持 `ready/partial`；分布是聚合事实层，不提升任何 writer/类型 authority
- 非声明：分布只有长度签名、无参数类型语义，不构成完整 Sekiro EMEDF schema 或类型覆盖；fixture 的 WaitFor/EndEvent 未在真实 corpus 出现，fixture 仍是 fixture 不冒充 native；同 bank:id 多长度变体不得被单一 schema 布局静默覆盖；不包含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态或 V0.5 完成
- 工程缺口：完整 EMEDF 类型布局需要可合法使用、可固定版本并可独立验证的类型源；工程方负责公开来源调查、许可证审计和 external-only adapter，找不到合法来源时保持 unknown opaque 与 `partial/unsupported`；固定 Smithbox 2.2.4 本机发行包中无 EMEDF 指令定义（已核验，仅 PARAM 数据）；本轮未导入任何外部数据

### 2026-07-31：DSL 顶层 instruction 块（全局指令级 typed mutation）

- 证据类型：`sealed-current-run`（`EV-EMEVD-GLOBAL-20260731`）
- 起始：`HEAD=969dbe8f8839ad983da72c60b4350df808066755`（含外部治理提交：scope governance evidence、semantic review、engineering-owned review evidence）
- 结束：`trackedDiffSha256=e1f1878292bef969cecc0bc0c0f7c2bbb7725499b672aa36fc3205174831f37d`；`untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`；`handoffSha256BeforeEvidenceAppend=7b588153d1d6614f27560fab8b83d5e32d795c431af32fed9bcd807f3b04a1fa`；`fingerprintSha256=8f5cf58a2751ebb361606e792d213a8dfe58b039229255488ce0b96176c1f18f`
- 路线：C-EMEVD（`W-EMEVD-FULL-01`）
- lifecycle 变化：`W-EMEVD-FULL-01` 继续 `ready`；本子推进完成其 DSL 全局指令级 typed mutation，完整类型覆盖/control-flow/UI 接线未完成
- 已实现：`EmevdDslDocument` 新增可选 `topLevelInstructions`；parser 顶层循环支持 `instruction` 块（与 `event` 并列）；compiler 抽出共享 `compileInstructionArgMutations`（事件内与顶层共用同一 schema/type/range 校验），顶层块经 `instructionByAnchor` 解析到所属事件（事件无锚点时结构化 `EMEVD_DSL_ANCHOR_PRECONDITION_FAILED`），`eventAnchor` 用 `formatEmevdAnchor('event', ...)` 与事件内写法同构；`validateDuplicateWrites` 改用共享锚点键注册表，跨作用域重复写统一拦截；`normalizeAstForFingerprint` 覆盖顶层块
- 已验证：`npm run typecheck`、`npm test`、`npm run test:emevd-dsl-compiler`（新增 6 组顶层断言：全局 mutation 生成、AST 字段、与事件内写法计划操作逐字段等价、缺失锚点、未知指令只读、跨作用域重复写）、`npm run test:emevd-four-view`、`npm run test:emevd-plan-commit`（13/13）、`npm run test:emevd-plan-production` 均 exit 0；`npm run test:handoff-integrity` findings 为空（`reviewOwner=engineering-agent`、`userActionRequired=false`）
- authority 变化：无；`W-EMEVD-FULL-01` 保持 `ready/partial`
- 非声明：planFingerprint 绑定源文本形状（顶层与事件内为不同 AST 形状，产生不同 fingerprint 但相同计划操作）；全局引用仍以稳定锚点身份为基础，不引入按 bank/id 的裸寻址；不包含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；control-flow validation 与完整 EMEDF 类型布局仍属工程缺口
- 工程缺口：无新增；完整 EMEDF 类型源调查归工程方（见上条与 `W-EMEVD-FULL-01` 备注）

### 2026-07-31：EMEVD 完整文档分页组装与四视图 DSL 提交 UI 接线

- 证据类型：`sealed-current-run`（`EV-EMEVD-FULLDOC-20260731`）
- 起始：`HEAD=f5d5674f85eb5eb9444c7edb76b0ea0ae704f0eb`
- 结束：`trackedDiffSha256=2a99af27dba46014c8a1a8bc876d2d07bead50b1038c69e16b0d5ece7587c719`；`untrackedManifestSha256=698e4a159c901e0cc98f6de359662380335b8c8ef736b9d4a053dbeaa3780344`（3 个未跟踪文件：`emevdFullDocument.ts`、`runEmevdFullDocumentSmoke.ts`、`dcxDflt.ts`）；`handoffSha256BeforeEvidenceAppend=07bb6593247cca74f7991a3d9679db4c90e821cd8e0974c5e13e674fe7936e6b`；`fingerprintSha256=c083a06af5d26f28e7e7fa35a11966d51f4f23987cd18fe2285b5f8ccf85eed4`
- 路线：C-EMEVD（`W-EMEVD-FULL-01`）
- lifecycle 变化：`W-EMEVD-FULL-01` 继续 `ready`；本子推进完成其完整文档分页组装与四视图 DSL 提交 UI 接线，完整类型覆盖/control-flow 未完成
- 已实现：Bridge `read-emevd-document` envelope 分页——`ToEnvelope` 支持 `instructionPage/instructionPageSize`（默认 0/256、上限 4096、全局索引 `index = pageOffset + index`、`instructionTotal/instructionPageCount/instructionsSampleTruncated` 字段），`BridgeCommandService` 解析分页参数（`JsonValueKind.Object` 前置检查，pageSize 1-4096，越界结构化失败）
- 已实现：core `emevdFullDocument.ts` `readFullEmevdDocumentViaBridge` 逐页组装——收集 Map 去重、总数一致、索引连续、事件指令切片越界校验、fixture registry 对 unknown 指令分类；DCX 包装检测（DFLT 解压、KRAK 结构化拒绝，`dcxDflt.ts` 公共解压函数供三个 smoke 复用消除复制），解压产物经 `tempDir`（须已在 `allowedRoots` 内）落盘并作为 `preparedSourcePath` 交回调用方复用为 Bridge staging 源
- 已实现：desktop main `emevdFullDocuments` 权威完整文档缓存（硬约束 18：renderer 不持有完整文档）；`resource.readEmevdFullDocument`（分页读取 + 缓存 + `renderEmevdPatchDsl` 模板）；`resource.submitEmevdDslPlan`（提交前重读 fresh 文档保证 revision 一致 → `submitEmevdDslPlanViaFourView` production 写链 → 成功刷新缓存 + openResourcePreview）；preload 暴露 `readEmevdFullDocument`/`submitEmevdDslPlan`；renderer `EmevdFourViewPanel` DSL 视图可编辑（模板 + 编译并提交/放弃编辑），App.tsx 持有模板状态并接提交回调
- 已实现：`test:emevd-full-document`（合成 pageSize 2 两页 + 事件切片 + unknown 分类；本机环境注入时真实 DCX 直读 1,730 events / 33,266 指令 / 34 页 + preparedSourcePath 断言）；`test:emevd-ipc-contract` 扩展 full-document 通道/preload/权威缓存 token 检查
- 已验证：`npm run typecheck`、`npm test`（全量：core 全部 smoke、desktop security、ui-localization、database-utility）、`npm run bridge:build`（0 警告 0 错误）、`npm run bridge:verify:synthetic`、`npm run build`（shared/core/desktop + release:manifest 123 present / 0 metadata-only）均 exit 0；本机环境注入后 `npm run test:emevd-full-document` exit 0（合成 + 真实：1730 events / 33,266 指令 / 34 页 / preparedSourcePath 复用、事件切片总数一致）；`npm run test:emevd-ipc-contract` exit 0；`git diff --check` 无空白错误
- authority 变化：无；`W-EMEVD-FULL-01` 保持 `ready/partial`；分页组装与 UI 接线不提升类型/writer authority
- 非声明：renderer 只编辑 DSL 文本，完整文档与权威 revision 始终在 main 缓存中（重新加载/提交均重读 fresh 文档）；分页组装不证明 layer 变体、完整 EMEDF 类型布局或游戏加载；不包含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态或 V0.5 完成
- 工程缺口：无新增；完整 EMEDF 类型源调查与 DSL control-flow validation 归工程方（见前条与 `W-EMEVD-FULL-01` 备注），合法类型源缺失时保持 opaque/partial 并继续其他工程切片

### 2026-07-31：EMEVD 编辑器规模访问 eager → pagination（硬约束 17 合规）

- 证据类型：`sealed-current-run`（`EV-EMEVD-SCALE-20260731`）
- 起始：`HEAD=3de45a08e861118b0c3b6cd13e147c3d8783080c`
- 结束：`trackedDiffSha256=09a127f9f82d26947ebbd107dfa6aef449ef2beef9bd0773660ace2e766afcde`；`untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（0 个未跟踪文件）；`handoffSha256BeforeEvidenceAppend=70e617acf5a1a47c68f328232c714d7672f9165ee281c6c6cfb95acb2e13447f`；`fingerprintSha256=4d5bab1ac13fbb9885e38b44589e58436a963d6a8509ff350a525633ebe30d91`
- 路线：REL-F（`W-REL-F-SCALE-02`，EMEVD 规模访问子推进；`W-EMEVD-FULL-01` 分页接线延伸）
- lifecycle 变化：`W-REL-F-SCALE-02` 继续 `ready`；本子推进关闭其 EMEVD `eager` 规模访问缺口，其余 7 个编辑器缺口如实保留
- 已实现：`dslRenderer.renderEmevdPatchDslBounded` 模板行数截断——上限内回退到最近事件块 `}` 边界（落在首块内时前向延伸到闭合行），末尾追加 `EMEVD_DSL_TEMPLATE_TRUNCATED` 注释标记；截断模板仍可解析且编译为空计划（patch 只表达修改，注释标记不参与）；无上限参数时行为与完整渲染一致
- 已实现：desktop main `resource.readEmevdFullDocument` 新增 `loadFullDslTemplate` 参数（默认截断 2,000 行）并返回 `dslTemplateTruncated/dslTemplateTotalLines`；preload 透传参数并扩展返回类型；renderer `EmevdFourViewPanel` 事件列表分页（flow/table 每页 200，含页码导航与选中事件跨页定位）+ DSL 视图截断提示与"加载完整模板"按钮；App.tsx 维护模板截断状态并接显式完整加载回调（`loadFullDslTemplate: true` 重拉全量）
- 已实现：`editorCapabilityContract` emevd `scalePrimitives: ['pagination']`、`scaleAccess: 'pagination'`（contractSources 追加分页/截断来源文件）；`runReleaseEditorAcceptanceSmoke` 的 EMEVD 缺口断言改为"缺口必须关闭"（`currentScaleContractGaps` 不再含 emevd），源码契约 token 更新为 `pageEvents.map`/`EVENTS_PAGE_SIZE`/`renderEmevdPatchDslBounded`/`EMEVD_DSL_TEMPLATE_TRUNCATED`/分页组装标记；`runEmevdDslCompilerSmoke` 新增 bounded 断言（截断发生、事件块边界、截断模板空计划、无上限不截断）；`runEmevdIpcContractSmoke` 新增截断/完整加载 token 检查
- 已验证：`npm run typecheck`、`npm test`（全量）、`npm run test:release-editor-acceptance`（EMEVD `scaleAccess=pagination`、缺口列表 7 项、inventory 仍自 capability contract 派生）、`npm run test:emevd-dsl-compiler`（bounded 断言通过）、`npm run test:emevd-ipc-contract`、`npm run test:emevd-four-view`、本机环境注入后 `npm run test:emevd-full-document`（合成 + 真实 1730 events / 33,266 指令 / 34 页）均 exit 0；`git diff --check` 无空白错误
- authority 变化：无；`W-REL-F-SCALE-02` 保持 `ready/candidate`；规模访问契约不提升任何 native/编辑器 authority
- 非声明：`pagination` 只证明 EMEVD 编辑器规模访问契约（完整文档分页组装、DSL 模板截断 + 按需完整加载、事件列表分页），不证明八个编辑器完整有界访问、真实 Electron 文档功能验收、完整语义编辑或 REL-F；截断模板的"加载完整模板"仍一次性传输全量文本（用户显式选择）；不包含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态或 V0.5 完成
- 工程缺口：真实文档完整有界访问与 Electron functional smoke 属 `validation-unfrozen` 工程项（见 `W-REL-F-SCALE-02`）；EMEVD 类型源/control-flow 调查继续归工程方（见 `W-EMEVD-FULL-01`）

### 2026-07-31：FMG add mutation 与 menu.msgbnd 第二语料读验证、MSB set_part_transform 重读验证

- 证据类型：`sealed-current-run`（`EV-FMGMSB-WRITE-20260731`）
- 起始：`HEAD=a90cfa711514e854e922c03534a749eabad04fa8`
- 结束：`trackedDiffSha256=eb6724598607c60c9a645df8da55f19b379eba90cbbe7e62df577aac5626b794`；`untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（0 个未跟踪文件）；`handoffSha256BeforeEvidenceAppend=bd5432e62a4196bb3a9db5b4648a09cab0c6fa791da71803ae86cf19ce81bdb2`；`fingerprintSha256=be59a89476cc60be1f22dc4280a8061427ef6ddce927dbac171deec917ad8065`
- 路线：C-FMG / C-MSB / C-EMEVD（`W-EMEVD-FMG-PARAM-03`）
- lifecycle 变化：`W-EMEVD-FMG-PARAM-03` 继续 `ready`；本子推进完成其 FMG add mutation、menu.msgbnd 第二语料读验证与 MSB transform 重读验证
- 已实现：`fmgBridgeCommit.ts` 的 `FmgBridgeMutation` 补 `add` kind（Bridge `write-fmg` 已支持 add，重复 ID 拒绝）；`runNativeFmgSmoke.ts` 追加 add case（真实 item.msgbnd：不存在的 id 999999999、文本 `SoulForge·新增条目验证` staged 写入 → Bridge 独立重读新 fmg 文本存在 → 重读原 fmg 确认未泄漏 → 清理）与 menu.msgbnd 读验证（`bnd4-primary`，只读：container 15 子项全部 FMG v2 semantic roundtrip）
- 已实现：`MsbNativeWriter.cs` 重读验证补 rotX/scaleX/scaleY/scaleZ 核对（此前只核对 posX/Y/Z，`set_part_transform` 的旋转/缩放无重读背书）；`runNativeMsbSmoke.ts` 追加真实 m11 transform case（pos + rotX+0.5 + scale ×[1.05, 1.1, 0.95] → 重读逐字段核对 + part 数不变）；修复 `EmevdNativeWriter.cs` CS8629 警告（`patch.NewEventId!.Value`，与 while 条件中的 `!` 用法一致）
- 已验证：`npm run typecheck`、`npm test`（全量）、`npm run bridge:build`（0 警告 0 错误）、`npm run test:fmg-msb-ipc-contract`、`git diff --check` 均 exit 0；本机环境注入后 `npm run bridge:verify:fmg` exit 0（既有 upsert/BND4 提交/回滚 + addCase `stagedRereadVerified=true`、`originalUntouched=true` + menuMsgbnd `fmgVerified=15`）与 `npm run bridge:verify:msb` exit 0（m11：position/region 既有 case + transform `rotX=82.37612`、scale [1.05, 1.1, 0.95]、`rereadVerified=true`）
- authority 变化：无；`W-EMEVD-FMG-PARAM-03` 保持 `ready/partial`；mutation 覆盖扩展不提升 authority 上限
- 非声明：FMG `add` 目前为 Bridge 级写能力 + smoke 验证，桌面编辑器 UI 尚无 add 入口（capability contract 与 shared `EditorMutationKind` union 未声明 `fmg_entry_add`，`editorAllowsMutation` 继续保守拒绝未知 kind——UI 接入时需同步 contract/union/release 清单，属特性缺口而非债）；menu 读验证是只读（不写第二 msgbnd）；MSB transform 只证明已覆盖的 rotX/scale 布局（rotY/rotZ 未解析）；不包含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态或 V0.5 完成
- 工程缺口：FMG 全语言 mutation 受本机 corpus 语言覆盖限制（仅 zhocn）；PARAM 布局 32/33/81（header-embedded type name）与完整字段 writer 仍 unsupported；MSB 全实体 CRUD、引用修复、MSB 容器级提交与 `set_part_transform` 之外的 transform 语义仍缺

### 2026-07-31：用户介入边界与 Evidence freshness 工程自持

- 证据类型：`sealed-current-run`（`EV-AUTONOMOUS-GOVERNANCE-20260731`，`revalidates=EV-GOVERNANCE-RECONCILIATION-20260731`）
- 起始与锚点：`HEAD=c103e414ab92cb1dbe643572374aff90cc2b1373`；工作树和未跟踪清单均为空；两次 fingerprint 一致
- 路线：REL-SCOPE 治理维护；BEGIN/END 标记内的 27 项冻结范围 JSON、authority 上限和 unsupported 边界均未变化
- 已实现：passed Gate freshness 改为显式主题域比较；REL-SCOPE 只跟踪唯一范围 JSON、范围 verifier/fixtures、handoff freshness verifier/fixtures 与指纹生成器；普通功能提交、其他交接章节、运行时改写文件和未跟踪产物不再使范围 Gate stale
- 已实现：`ready/active/open/passed` 且没有活动 `blockerRefs` 的切片或 Gate 一旦要求用户裁定、授权、提供或介入，`test:handoff-integrity` 以 `USER_ACTION_WITHOUT_ACTIVE_BLOCKER` 失败；EMEDF 类型源定位、许可证审计、external-only adapter 和 Evidence 重封存明确归工程方
- 已实现：handoff 输出将未自动覆盖的语义复核显式归属 `engineering-agent`，并固定 `userActionRequired=false`；不得再把旧 `manualReviewStillRequired` 字段解释成需要项目所有者操作
- 已修复：嵌套标题与标记块提取、Git 大文件历史读取 buffer、scope-ruling Evidence 与无关 Evidence 的 freshness 绑定、Evidence 自身引用造成的重封存循环，以及缺失的 §18 标题导致 release-scope Evidence 索引为空
- 已验证：release-scope 35 个正/负 fixture、handoff 47 个正/负 fixture、proposal/strict scope、最低公开回归、`git diff --check` 与追加后的完整 handoff 门禁均通过
- authority 变化：无；只继承用户已经批准且未改变的 `scope-ruling:user-approved`，不产生新范围裁定
- 当前用户 blocker：0；只有未来实际修改唯一范围 JSON 的支持/排除边界时才重新请求用户裁定

### 2026-07-31：工程语义复核责任显式化

- 证据类型：`sealed-current-run`（`EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER`，`revalidates=EV-AUTONOMOUS-GOVERNANCE-20260731`）
- 已实现：handoff 结果不再输出容易被误读的 `manualReviewStillRequired`，改为 `engineeringReviewStillRequired`、`reviewOwner=engineering-agent` 与 `userActionRequired=false`
- 已验证：47 个 handoff 正/负 fixture、严格 release-scope、追加后的完整 handoff 门禁与 `git diff --check` 均通过；冻结范围 JSON 未变化
- 非声明：复核项目仍需工程方逐次执行；字段改名不把未自动验证的语义写成已验证，也不提升任何功能 authority
- 当前用户 blocker：0；工程复核、公开来源调查、许可证审计、工具安装、测试编排与 Evidence 维护均不得转成用户输入

---

## 18. V0.5 完成定义

只有同时满足以下条件，才能说“V0.5 完成”：

- 文档只有一个当前实施口径；
- `REL-SCOPE` 以 `sealed-current-run` Evidence 通过，并明确冻结游戏版本、能力、操作、corpus 和 unsupported 边界；
- `REL-A`、`REL-H`、`REL-COMPLIANCE` 均保持 `in-scope` 并通过，不得以缩小功能范围排除；
- `REL-B/C/D/E/F/G/I` 各自要么在冻结范围内通过，要么按 §18.3 规则得到用户批准并以 sealed Evidence 明确排除；
- 所有冻结为 in-scope 的 native、编辑器、AI、runtime 和渲染能力达到 §18.1 对应完成条件，不用 fixture、candidate、代理场景或 skipped 代替；
- Patch Engine 是所有用户 Mod 资源写入的唯一主干，operation、file、resource-entry 三层持久回滚在声明范围内可用；
- 没有提交真实资产、用户 Mod、Oodle DLL 或明文凭据；
- 未支持能力诚实显示为 unsupported、candidate、partial、blocked 或 unverified。

### 18.1 可判定的发布门槛

V0.5 完成不是路线状态的主观汇总。发布候选必须提交一张按下表填写的证据矩阵；任何 `TBD`、`skipped`、缺失证据或未裁定范围都会阻止完成声明。

| Gate ID | 必须冻结的范围 | 通过条件 | 阻止通过的证据 |
|---|---|---|---|
| `REL-SCOPE` | 游戏版本、支持容器/资源/行为/资产格式、支持 mutation、明确 unsupported | 每项都有 capability ID、authority、corpus registry 和非声明 | “以后再定”、只写格式名、不写操作范围 |
| `REL-A` | 所有 production writer 与事务阶段 | 每个 writer 完成 stage/validate/commit/re-read/audit，以及 operation/file/resource-entry 适用回滚和故障矩阵 | 任一 writer 绕过 Patch Engine；after-commit 不可恢复 |
| `REL-B` | 注册的 DFLT/KRAK/BND4 发布 corpus | 100% 样本被分类；声明支持的布局完成 no-op、mutation/repack、重读和未知字段保持；unsupported 有结构化诊断 | 只验证抽样却声明全集；缺 Oodle 成功路径仍声明 KRAK 完成 |
| `REL-C` | FMG/PARAM/EMEVD/MSB 支持矩阵 | 每个支持操作在每个注册布局上通过 read/no-op/mutate/write/re-read/reference/rollback；游戏加载按声明范围通过 | fixture、candidate、单一 happy path 或未知字段重写 |
| `REL-D` | 全部 Sekiro TAE、全部 ESD、源码与编译脚本完整读写 | corpus 范围由真实 Sekiro 证据确认；结构化界面/DSL 共用 native document，全部 typed mutation、writer、重读、回滚和游戏加载矩阵通过 | 只停留在 candidate parser/inventory、借用其他游戏格式结论、执行不受信脚本或以 Hex 代替语义 parser |
| `REL-E` | FLVER/TPF/MTD/collision/navigation 全量语义只读与 native-to-open 导出矩阵 | 五类 native 文档、引用、可视化和批准导出通过真实 corpus；无 native writer 或反向导入 | raw replace、代理几何、最小 DDS 被外推成 native authority 或开放格式被写回 native |
| `REL-F` | 八个语义编辑器、结构化界面 + DSL、共享只读 Hex 证据视图 | 全部读取真实 native document；mutation typed；revision 冲突失败；完整内容可通过分页/虚拟化/分块/流式访问；无 demo fallback 或 raw Hex 写入 | UI 存在但底层 authority 缺失；固定窗口截断、eager 全量物化、历史可写 Safe Hex 演示或静态测试被当作发布编辑器；容量/延迟数值不是通过条件 |
| `REL-G` | OpenAI-compatible / Anthropic-compatible 双协议、允许工具集、权限模式与空配置行为 | 两类协议分别通过确定性本地 contract server 的只读/受控写、取消、超时、限额、审计和脱敏矩阵；空配置不发起网络请求并返回明确诊断；写工具复用 native validator/Patch Engine | 只覆盖单协议、空配置仍联网、模型可绕过证据或写入主干；真实 provider 账号不是通过条件 |
| `REL-H` | Windows 10/11 x64 NSIS 与 me3 capability-probe 运行范围 | NSIS manifest/hash、干净机安装、覆盖升级、卸载、Bridge/.NET/native binding、能力探测、提交后启动、日志关联、回滚后复启全部通过 | portable/自动更新被冒充范围内能力，未签名被误写成免除完整性验证，配置存在、skip、版本字符串或只启动一次 |
| `REL-I` | renderer-independent semantic scene、WebGPU 主路径与 WebGL2 功能回退 | 在项目所有者当前机器上以真实 semantic/native projection 完成 capability probe、加载、picking、transform 更新、回退与资源释放功能闭环 | 代理场景或 synthetic baseline 被当成真实资产；WebGPU 失败时没有 WebGL2 功能回退；代表性硬件档位和性能预算不是通过条件 |
| `REL-COMPLIANCE` | 项目所有者内部测试构建及禁止外部分发边界 | package tree、许可证 inventory、凭据/私有资产扫描、所有者控制目标和 installer manifest/hash 通过；缺 notices 被显式追踪并阻止外部分发 | 真实资产、用户 Mod、私有 corpus、Oodle、key/私钥进入提交/产物，或未补 notices/权利即对外分发；未签名包不得声明发布者身份或 SmartScreen 信誉 |

### 18.2 V0.5 不设置的量化预算与门槛

用户已明确以下项目均不属于 V0.5 验收，不再等待后续裁定，也不得恢复成隐含 Gate：

- 大 PARAM、FMG、EMEVD 文档的容量、延迟、规模档位或 benchmark 数值门槛；
- 安装包体积、首次启动、升级 migration 和回滚的耗时预算；
- 代表性渲染硬件档位、地图性能基准、FPS/帧时间、RAM/显存和泄漏量化预算。

工程方仍可采集这些数据用于诊断和优化，但不得把它们变成 V0.5 发布标准。删除数值门槛不删除功能正确性：大文档必须能完整、有界地访问；installer manifest/hash、安装、升级、卸载和 packaged runtime 完整性仍必须验证。

#### 18.2.1 V0.5 支持范围（用户已批准）

本块是 `W-REL-SCOPE-RULING-01` 的唯一机器可读冻结产物。`--proposal` 验证结构、引用和非声明完整性；默认严格模式还要求完整用户批准元数据、版本族策略、全部条目裁定和空 openRulings。开发期私有 fixture registry 仅用于复现当前证据，不是 release corpus，也不能替代后继发布 Gate 的真实验证。

<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->
```json
{
  "schemaVersion": "1.5.0",
  "proposalId": "V0.5-SCOPE-20260725",
  "release": "V0.5",
  "game": "Sekiro",
  "gameBuildRange": {
    "status": "user-approved",
    "matchPolicy": "file-product-version-major-minor",
    "versionFamilies": [
      "1.6"
    ],
    "exactBuilds": [],
    "unknownBuildPolicy": "fail-closed"
  },
  "ruling": {
    "status": "user-approved",
    "approvedBy": "repository-owner",
    "approvedAt": "2026-07-30T09:37:03.836Z",
    "decisionRef": "codex-thread:019fa924-bb20-7d23-aab9-3863957c5e10"
  },
  "proposalStatus": "user-approved",
  "unlistedPolicy": "unsupported",
  "corpusPolicy": {
    "privateFixtureRegistryIsReleaseCorpus": false,
    "supportedWithoutReleaseCorpus": "requires-open-ruling"
  },
  "authoritySnapshotPolicy": {
    "field": "authorityAtRuling",
    "asOfEvidenceRef": "EV-REL-SCOPE-20260730",
    "liveAuthoritySource": "section-13.1",
    "nonClaimsAreRulingTimeSnapshot": true
  },
  "paramMetadataSourcePolicy": {
    "status": "user-approved",
    "sourceProject": "vawser/Smithbox",
    "sourceRelease": "2.2.4",
    "sourceCommit": "1b46d2c9f82d1c3635ff7c12c526e05a8ba4208f",
    "sourceArtifactSha256": "14a7fd735a9577249fa93655f63d1e9ac025a3b00d7c5bed8badc8a3a7fd489d",
    "sourcePath": "Smithbox.Release/Output/Assets/PARAM/SDT",
    "acquisition": "user-local-pinned-release-import",
    "redistribution": "forbidden",
    "mismatchPolicy": "fail-closed"
  },
  "providerCredentialPolicy": {
    "status": "user-approved",
    "defaultConfiguration": "empty",
    "realProviderCredentialsRequiredForV05Acceptance": false,
    "unconfiguredBehavior": "diagnose-without-network-call"
  },
  "runtimeToolPolicy": {
    "status": "user-approved",
    "adapter": "me3",
    "sourceProject": "garyttierney/me3",
    "sourceRelease": "v0.12.1",
    "sourceArtifactSha256": "b1c11659b0cfde73062b2fa134a8ac499f3e713fe82d9014401289677ace7323",
    "provisioningResponsibility": "project-engineering",
    "compatibilityPolicy": "capability-probe-fail-closed"
  },
  "renderingAcceptancePolicy": {
    "status": "user-approved",
    "functionalOwnerMachineSmokeRequired": true,
    "representativeHardwareTiersRequired": false,
    "performanceBudgetsRequired": false
  },
  "quantitativeAcceptancePolicy": {
    "status": "user-approved",
    "editorCapacityOrLatencyThresholdsRequired": false,
    "installerSizeOrTimeBudgetsRequired": false,
    "boundedEditorAccessRequired": true,
    "installerLifecycleIntegrityRequired": true
  },
  "gateCoverage": [
    {
      "gateId": "REL-SCOPE",
      "scopeItemIds": [
        "SCOPE-SEKIRO-BUILD",
        "SCOPE-A-WORKSPACE",
        "SCOPE-A-RECOVERY",
        "SCOPE-DFLT",
        "SCOPE-KRAK",
        "SCOPE-BND4",
        "SCOPE-FMG",
        "SCOPE-PARAM",
        "SCOPE-EMEVD",
        "SCOPE-MSB",
        "SCOPE-BEHAVIOR-ANIMATION",
        "SCOPE-BEHAVIOR-TAE",
        "SCOPE-BEHAVIOR-ESD",
        "SCOPE-BEHAVIOR-SCRIPT",
        "SCOPE-ASSETS",
        "SCOPE-ASSET-FLVER",
        "SCOPE-ASSET-TPF",
        "SCOPE-ASSET-MTD",
        "SCOPE-ASSET-COLLISION",
        "SCOPE-ASSET-NAVIGATION",
        "SCOPE-ASSET-OPEN-CONVERSION",
        "SCOPE-EDITORS",
        "SCOPE-AI",
        "SCOPE-RUNTIME",
        "SCOPE-RELEASE",
        "SCOPE-RENDERING",
        "SCOPE-COMPLIANCE"
      ],
      "currentState": "passed",
      "blockerRefs": [],
      "openRulings": [
        "用户逐项裁定已冻结；scope target 不提升实时 authority，技术缺口由后继 Gate 与 blocker 继续失败关闭。"
      ]
    },
    {
      "gateId": "REL-A",
      "scopeItemIds": [
        "SCOPE-A-WORKSPACE",
        "SCOPE-A-RECOVERY"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "全部发布 writer 必须逐项完成真实 stage/validate/commit/re-read/rollback/crash 故障矩阵。"
      ]
    },
    {
      "gateId": "REL-B",
      "scopeItemIds": [
        "SCOPE-DFLT",
        "SCOPE-KRAK",
        "SCOPE-BND4"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需建立 1.6.x release corpus，并完成 DFLT/KRAK/BND4 全量分类、KRAK 压缩写回与组合闭环。"
      ]
    },
    {
      "gateId": "REL-C",
      "scopeItemIds": [
        "SCOPE-FMG",
        "SCOPE-PARAM",
        "SCOPE-EMEVD",
        "SCOPE-MSB"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需完成全官方语言 FMG、全部 ParamType/EMEVD 及登记 MSB 实体的 release corpus、writer、引用和游戏加载矩阵。"
      ]
    },
    {
      "gateId": "REL-D",
      "scopeItemIds": [
        "SCOPE-BEHAVIOR-ANIMATION",
        "SCOPE-BEHAVIOR-TAE",
        "SCOPE-BEHAVIOR-ESD",
        "SCOPE-BEHAVIOR-SCRIPT"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需建立真实 Sekiro TAE/ESD/脚本 corpus、完整 schema/parser/writer/DSL 与游戏加载矩阵。"
      ]
    },
    {
      "gateId": "REL-E",
      "scopeItemIds": [
        "SCOPE-ASSETS",
        "SCOPE-ASSET-FLVER",
        "SCOPE-ASSET-TPF",
        "SCOPE-ASSET-MTD",
        "SCOPE-ASSET-COLLISION",
        "SCOPE-ASSET-NAVIGATION",
        "SCOPE-ASSET-OPEN-CONVERSION"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需完成五类 native 资产的全量只读语义 authority、引用与 native-to-open 导出矩阵。"
      ]
    },
    {
      "gateId": "REL-F",
      "scopeItemIds": [
        "SCOPE-EDITORS"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需交付八个语义编辑器、共享只读 Hex 证据视图、完整有界访问与 Electron 真实文档功能验收；不要求量化容量或延迟门槛。"
      ]
    },
    {
      "gateId": "REL-G",
      "scopeItemIds": [
        "SCOPE-AI"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需以确定性本地 contract servers 完成双协议语义 typed tool、权限、限额、取消、审计、空配置诊断和多步写任务验证；不要求真实 provider 凭据。"
      ]
    },
    {
      "gateId": "REL-H",
      "scopeItemIds": [
        "SCOPE-SEKIRO-BUILD",
        "SCOPE-RUNTIME",
        "SCOPE-RELEASE"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需完成 me3 能力探测运行闭环及 Windows 10/11 x64 NSIS 的 manifest/hash、安装、升级、卸载和干净机验证；代码签名不属于验收范围。"
      ]
    },
    {
      "gateId": "REL-I",
      "scopeItemIds": [
        "SCOPE-RENDERING"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "需在项目所有者当前机器完成真实 semantic scene 的 WebGPU capability 主路径、WebGL2 功能回退、picking、transform 更新与资源释放；不要求代表性硬件档位或性能预算。"
      ]
    },
    {
      "gateId": "REL-COMPLIANCE",
      "scopeItemIds": [
        "SCOPE-COMPLIANCE"
      ],
      "currentState": "open",
      "blockerRefs": [],
      "openRulings": [
        "仅允许项目所有者内部测试；外部分发仍由 notices、再分发权利与完整发行合规失败关闭。"
      ]
    }
  ],
  "scopeItems": [
    {
      "scopeItemId": "SCOPE-SEKIRO-BUILD",
      "capabilityId": "H-RUNTIME",
      "gateIds": [
        "REL-SCOPE",
        "REL-H"
      ],
      "subjectKind": "game-build",
      "scope": "Sekiro 1.6.x 文件/产品版本族与 build identity",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "detect-file-product-version",
        "match-major-minor-1.6",
        "record-exact-build-identity",
        "fail-closed-on-non-1.6-build"
      ],
      "unsupportedOperations": [
        "support-unlisted-game",
        "assume-non-1.6-build-compatible",
        "treat-version-family-as-native-evidence"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [
        "EV-PRIVATE-20260724"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "用户批准 1.6.x 版本族只冻结目标兼容范围；裁定时 authorityAtRuling 为 unverified，每个实际 build 仍须进入 release corpus 并通过真实验证。"
      ]
    },
    {
      "scopeItemId": "SCOPE-A-WORKSPACE",
      "capabilityId": "A-WORKSPACE",
      "gateIds": [
        "REL-A"
      ],
      "subjectKind": "workspace",
      "scope": "单一可写 Mod 叠加层、可选只读原版层与应用数据外置",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "open-single-mod-overlay",
        "attach-optional-readonly-game-base",
        "index-readonly-game",
        "stage-mod-resource-via-patch-engine",
        "store-metadata-in-app-data"
      ],
      "unsupportedOperations": [
        "write-original-game",
        "write-mod-resource-outside-patch-engine",
        "store-sidecar-in-mod-workspace",
        "open-multiple-writable-overlays"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-A-SAFETY-20260720"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "范围批准不证明全部 production writer 已接入单一写入主干，也不证明真实外部路径与重解析边界已完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-A-RECOVERY",
      "capabilityId": "A-RECOVERY",
      "gateIds": [
        "REL-A"
      ],
      "subjectKind": "recovery",
      "scope": "operation、file、resource-entry 三层审计、回滚与崩溃恢复",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "stage",
        "validate",
        "commit-with-backup",
        "re-read",
        "audit",
        "rollback",
        "recover-after-commit",
        "gate-every-release-writer"
      ],
      "unsupportedOperations": [
        "publish-writer-without-failure-matrix",
        "overwrite-revision-conflict",
        "swallow-recovery-failure",
        "bypass-backup"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-A-RECOVERY-20260724",
        "EV-PUBLIC-CONTRACTS-20260725"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "所有发布 writer 均被纳入恢复门禁；现有 harness 不证明尚未实现或缺少 corpus 的 writer 已通过真实崩溃、断电与资源项恢复矩阵。"
      ]
    },
    {
      "scopeItemId": "SCOPE-DFLT",
      "capabilityId": "B-DFLT",
      "gateIds": [
        "REL-B"
      ],
      "subjectKind": "container",
      "scope": "注册 Sekiro DFLT 布局的解压、无修改往返、重压与重读",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "classify",
        "decompress",
        "no-op-roundtrip",
        "recompress",
        "re-read"
      ],
      "unsupportedOperations": [
        "accept-unregistered-layout",
        "rewrite-unknown-fields"
      ],
      "authorityAtRuling": "native-verified",
      "evidenceRefs": [
        "EV-B-DFLT-7BD"
      ],
      "registryRefs": [
        {
          "registryRef": "historical-corpus:EV-B-DFLT-7BD",
          "kind": "historical-private-corpus",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "登记 DFLT 布局的完整读写是目标范围；历史 144 个样本与两个变体仍不构成当前 1.6.x release corpus 或未知布局 authority。"
      ]
    },
    {
      "scopeItemId": "SCOPE-KRAK",
      "capabilityId": "B-KRAK",
      "gateIds": [
        "REL-B"
      ],
      "subjectKind": "container",
      "scope": "登记 Sekiro KRAK 布局与用户合法 Oodle runtime 的解压、重压、写回、重读与恢复闭环",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "validate-user-oodle-runtime",
        "classify",
        "decompress",
        "recompress",
        "write",
        "re-read",
        "rollback"
      ],
      "unsupportedOperations": [
        "distribute-oodle",
        "accept-unregistered-layout",
        "bypass-oodle-license-or-runtime-validation"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-B-KRAK-20260724"
      ],
      "registryRefs": [
        {
          "registryRef": "fixture:krak-preview",
          "kind": "private-fixture",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "完整 KRAK 读写已纳入目标范围，但裁定时 authorityAtRuling 为 partial；单个私有解压 preview 不证明压缩、写回、恢复或 release corpus 已完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-BND4",
      "capabilityId": "B-BND4",
      "gateIds": [
        "REL-B"
      ],
      "subjectKind": "container",
      "scope": "注册 Sekiro BND4 布局的 browse、entry mutation、repack、重读与回滚",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "classify",
        "browse",
        "add-entry",
        "replace-entry",
        "delete-entry",
        "rename-entry",
        "move-entry",
        "repack",
        "validate-dflt-krak-inner-chain",
        "re-read",
        "rollback"
      ],
      "unsupportedOperations": [
        "accept-unregistered-flags",
        "rewrite-unknown-layout",
        "claim-unregistered-inner-coverage"
      ],
      "authorityAtRuling": "native-verified",
      "evidenceRefs": [
        "EV-B-BND4-7BD",
        "EV-A-RECOVERY-20260724"
      ],
      "registryRefs": [
        {
          "registryRef": "historical-corpus:EV-B-BND4-7BD",
          "kind": "historical-private-corpus",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "登记 BND4 布局及 DFLT/KRAK 内层组合是目标范围；历史 DFLT-BND4 证据不覆盖 KRAK、未来 flags 或当前 release corpus。"
      ]
    },
    {
      "scopeItemId": "SCOPE-FMG",
      "capabilityId": "C-FMG",
      "gateIds": [
        "REL-C"
      ],
      "subjectKind": "resource",
      "scope": "Sekiro 全部官方语言与登记 msgbnd/FMG v2 布局的完整文本读写",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "read-all-official-languages",
        "no-op-roundtrip",
        "upsert",
        "add",
        "delete",
        "write",
        "re-read",
        "reference-validate",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "unregistered-language-layout",
        "implicit-id-merge",
        "claim-reference-or-game-load-before-validation"
      ],
      "authorityAtRuling": "native-verified",
      "evidenceRefs": [
        "EV-C-FMG-7BD",
        "EV-PRIVATE-20260724"
      ],
      "registryRefs": [
        {
          "registryRef": "fixture:testRole=fmg-primary",
          "kind": "private-fixture",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "全部官方语言已纳入目标范围；开发期 18/18 私有 fixture 不等于多语言 release corpus、完整引用验证或真实游戏加载。"
      ]
    },
    {
      "scopeItemId": "SCOPE-PARAM",
      "capabilityId": "C-PARAM",
      "gateIds": [
        "REL-C"
      ],
      "subjectKind": "resource",
      "scope": "固定 Smithbox 2.2.4 本机 metadata 严格匹配下的 Sekiro 全部 ParamType、布局、字段与行完整读写",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "read-all-param-types",
        "import-user-local-pinned-smithbox-metadata",
        "verify-source-release-and-content-digest",
        "record-source-license-and-provenance",
        "no-op-roundtrip",
        "typed-field-mutation",
        "row-crud",
        "write",
        "re-read",
        "reference-validate",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "redistribute-imported-smithbox-param-metadata",
        "accept-unpinned-or-mismatched-metadata-source",
        "metadata-mismatch-write",
        "unknown-field-rewrite",
        "write-before-all-sekiro-param-types-are-authoritative"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-C-PARAM-7BD",
        "EV-PRIVATE-20260724",
        "EV-PUBLIC-CONTRACTS-20260725"
      ],
      "registryRefs": [
        {
          "registryRef": "fixture:testRole=param-primary",
          "kind": "private-fixture",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "全部 ParamType 与固定 Smithbox 本机来源已纳入目标范围，但裁定时 authorityAtRuling 为 partial；来源裁定不证明导入 adapter、全部布局、上游再分发权利或真实游戏验证完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-EMEVD",
      "capabilityId": "C-EMEVD",
      "gateIds": [
        "REL-C"
      ],
      "subjectKind": "resource",
      "scope": "Sekiro 全部 EMEVD 事件、指令、控制流、参数与 layer 变体的完整无损读写",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "read-all-events-instructions-layers",
        "no-op-roundtrip",
        "typed-mutation",
        "event-instruction-crud",
        "control-flow-validate",
        "dsl-parse-typecheck-to-mutation",
        "write",
        "re-read",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "direct-dsl-binary-write",
        "bypass-emedf-typecheck",
        "unknown-instruction-reencode"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-C-EMEVD-7BD",
        "EV-C-EMEVD-DSL-20260724",
        "EV-PRIVATE-20260724"
      ],
      "registryRefs": [
        {
          "registryRef": "fixture:testRole=emevd-primary",
          "kind": "private-fixture",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "全部 EMEVD 已纳入目标范围，但裁定时 authorityAtRuling 为 partial；完整 EMEDF、layer/KRAK 变体、生产 DSL 接线、release corpus 与游戏加载尚未完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-MSB",
      "capabilityId": "C-MSB",
      "gateIds": [
        "REL-C"
      ],
      "subjectKind": "resource",
      "scope": "登记 Sekiro MSB 实体类型的完整语义读取、CRUD、引用修复、写入、重读与回滚",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "read",
        "no-op-roundtrip",
        "project-complete-registered-entities",
        "registered-entity-crud",
        "typed-transform-and-field-mutation",
        "reference-validate-and-repair",
        "write",
        "re-read",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "edit-unregistered-entity",
        "unknown-entity-rewrite",
        "claim-untruncated-scene-before-validation"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-C-MSB-SCENE-20260724",
        "EV-C-MSB-7BD"
      ],
      "registryRefs": [
        {
          "registryRef": "fixture:testRole=msb-primary",
          "kind": "private-fixture",
          "releaseCorpus": false
        }
      ],
      "openRulings": [],
      "nonClaims": [
        "登记实体完整读写已纳入目标范围；脱敏 m11 私有 fixture 与截断 preview 不证明 release corpus、完整场景、KRAK 组合或游戏加载完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-ANIMATION",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "真实 Sekiro corpus 中行为、动画与脚本格式的深度语义解析与引用清单",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "inventory",
        "identify-magic-container-version",
        "parse-semantic-document",
        "resolve-cross-resource-references",
        "classify-unknown-format",
        "fail-closed-on-unknown-format"
      ],
      "unsupportedOperations": [
        "borrow-other-game-format-claims",
        "raw-hex-as-semantic-authority",
        "execute-untrusted-script"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "深度解析已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；格式候选、文件名或其他游戏知识不构成 Sekiro native authority。"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-TAE",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "Sekiro 全部 TAE 布局、事件类型、时间轴、参数与动画引用的完整读写",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "identify-and-parse-all-sekiro-tae",
        "read-event-timeline-and-parameters",
        "typed-event-crud",
        "edit-start-end-frame",
        "validate-animation-references",
        "write",
        "re-read",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "borrow-other-game-tae-layout",
        "raw-hex-write",
        "unknown-event-reencode"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部 TAE 完整读写已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；裁定时仓库尚无生产 TAE parser、event schema、writer 或真实游戏证据。"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-ESD",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "Sekiro 全部 ESD 状态机、条件表达式、命令与跳转关系的完整读写",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "identify-and-parse-all-sekiro-esd",
        "read-state-machine-and-conditions",
        "project-state-graph",
        "typed-state-condition-command-crud",
        "repair-and-validate-references",
        "write",
        "re-read",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "borrow-other-game-esd-layout",
        "raw-hex-write",
        "unknown-expression-or-command-reencode"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部 ESD 完整读写已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；裁定时格式存在性、生产 parser、表达式 schema、writer 与真实游戏证据尚未建立。"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-SCRIPT",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "真实 Sekiro corpus 中源码与编译 Lua/HKS/其他脚本的完整静态解析、编辑与重新生成",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "inventory-and-identify-script-vm",
        "parse-or-decompile",
        "project-readable-semantic-document",
        "typed-or-source-mutation",
        "compile-or-reassemble",
        "write",
        "re-read",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "execute-untrusted-script",
        "raw-bytes-as-script-authority",
        "borrow-unverified-vm-or-bytecode-claims"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "源码与编译脚本完整读写已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；脚本种类、VM/字节码、合法工具链、writer 与真实游戏证据均待建立。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSETS",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "固定 FLVER/TPF/MTD/collision/navigation 五类 native 资产只读 authority 与 native-to-open 导出矩阵",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "read-native-semantic-document",
        "project-structured-view",
        "resolve-native-references",
        "export-native-to-approved-open-format",
        "validate-export"
      ],
      "unsupportedOperations": [
        "open-format-to-native-import",
        "raw-replace-as-native-conversion",
        "proxy-data-as-native-authority",
        "unvalidated-native-writer"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-E-ASSET-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "固定六类资产范围已批准，但裁定时 authorityAtRuling 为 candidate；候选解析、代理几何和最小 DDS 不证明五类 native 语义读取或导出管线完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-FLVER",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "Sekiro 全部 FLVER 布局的 geometry、skeleton、weights、material 引用与只读 native document",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "classify-all-sekiro-layouts",
        "read-vertex-index",
        "read-skeleton-and-weights",
        "read-material-reference",
        "project-renderable-scene",
        "export-gltf-glb",
        "validate-export"
      ],
      "unsupportedOperations": [
        "flver-write",
        "open-format-to-flver",
        "proxy-geometry-as-flver",
        "raw-replace-as-native-writer"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-E-ASSET-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部 FLVER 语义只读已纳入目标范围；现有 header/mesh candidate 不证明完整 vertex/index/skeleton/material authority 或真实渲染完成。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-TPF",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "Sekiro 全部 TPF 布局、纹理格式、metadata 与 native texture 引用的只读文档",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "classify-all-sekiro-layouts",
        "read-texture-entries",
        "read-texture-metadata",
        "resolve-material-references",
        "preview",
        "export-png-tga-dds",
        "validate-export"
      ],
      "unsupportedOperations": [
        "tpf-write",
        "open-format-to-tpf",
        "minimal-dds-as-tpf-authority",
        "infer-texture-metadata"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部 TPF 语义只读已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；容器 hint、开放图像检测和最小 DDS 编码不证明 TPF parser 或纹理兼容性。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-MTD",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "Sekiro 全部 MTD 布局、材质参数、texture slot 与着色引用的只读文档",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "classify-all-sekiro-layouts",
        "read-material-definition",
        "read-parameter-schema",
        "read-texture-slots",
        "resolve-flver-tpf-references",
        "export-readable-manifest"
      ],
      "unsupportedOperations": [
        "mtd-write",
        "open-format-to-mtd",
        "infer-mtd-schema",
        "proxy-material-as-native"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部 MTD 语义只读已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；candidate inventory 不证明 native document、参数 schema 或引用闭环。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-COLLISION",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "真实 Sekiro 中全部碰撞格式、层级与地图关联的只读语义文档",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "inventory-collision-resources",
        "identify-all-formats-and-containers",
        "read-collision-semantic-document",
        "resolve-map-reference",
        "visualize",
        "diagnose",
        "fail-closed-on-unknown-layout"
      ],
      "unsupportedOperations": [
        "collision-write",
        "assume-collision-format",
        "proxy-mesh-as-collision"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部碰撞语义只读已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；场景 proxy 或 FLVER candidate 不证明碰撞格式、层级或地图引用。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-NAVIGATION",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "真实 Sekiro 中全部导航格式、连接关系与地图引用的只读语义文档",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "inventory-navigation-resources",
        "identify-all-formats-and-containers",
        "read-navigation-semantic-document",
        "resolve-map-reference",
        "visualize",
        "diagnose",
        "fail-closed-on-unknown-layout"
      ],
      "unsupportedOperations": [
        "navigation-write",
        "assume-navigation-format",
        "proxy-graph-as-navigation"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "全部导航语义只读已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；资源图、bounds 或代理图不证明导航 parser、连接语义或地图引用。"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-OPEN-CONVERSION",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "FLVER/TPF/MTD native 资源到 glTF/GLB/PNG/TGA/DDS/描述清单的只读导出矩阵",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "read-native-semantic-document",
        "validate-native-source",
        "export-gltf-glb",
        "export-png-tga-dds",
        "export-material-manifest",
        "validate-open-output"
      ],
      "unsupportedOperations": [
        "open-format-to-native-import",
        "emit-or-replace-native-output",
        "raw-file-replace-as-conversion"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-E-ASSET-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "仅 native-to-open 导出已纳入目标范围；现有开放格式检测、staging 与 file_replace 不证明任何已批准导出器完成，更不支持反向 native 写入。"
      ]
    },
    {
      "scopeItemId": "SCOPE-EDITORS",
      "capabilityId": "F-EDITORS",
      "gateIds": [
        "REL-F"
      ],
      "subjectKind": "editor",
      "scope": "BND4、FMG、PARAM、EMEVD、MSB、TAE、ESD、脚本八个语义编辑器及共享只读 Hex 证据视图",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "editorIds": [
        "bnd4",
        "fmg",
        "param",
        "emevd",
        "msb",
        "tae",
        "esd",
        "script"
      ],
      "hexEvidenceView": {
        "included": true,
        "writable": false
      },
      "operations": [
        "open-bridge-native-document",
        "project-structured-ui",
        "project-canonical-dsl",
        "synchronize-ui-dsl-selection-revision",
        "paginate-virtualize-stream",
        "access-complete-document-through-bounded-mode",
        "typed-mutation",
        "schema-typecheck",
        "reject-revision-conflict",
        "undo-redo-via-history",
        "show-readonly-hex-evidence"
      ],
      "unsupportedOperations": [
        "raw-hex-edit",
        "demo-fallback-as-authority",
        "renderer-state-as-document",
        "editor-without-native-authority",
        "quantitative-capacity-or-latency-threshold-as-v05-gate"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-F-EDITORS-7BD",
        "EV-HANDOFF-LIVENESS-20260725",
        "EV-PUBLIC-CONTRACTS-20260725"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "八个语义编辑器已纳入目标范围，但裁定时 authorityAtRuling 为 partial；裁定时的候选面板、Safe Hex 演示和静态契约不证明真实文档、DSL、完整有界访问或 Electron 功能验收完成；容量与延迟数值不属于 V0.5 验收。"
      ]
    },
    {
      "scopeItemId": "SCOPE-AI",
      "capabilityId": "G-AGENT",
      "gateIds": [
        "REL-G"
      ],
      "subjectKind": "ai",
      "scope": "OpenAI-compatible 与 Anthropic-compatible 服务对语义文档的证据化读取与受控 typed mutation 循环",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "openai-compatible-loop",
        "anthropic-compatible-loop",
        "read-semantic-document",
        "propose-controlled-typed-write",
        "cancel",
        "timeout",
        "limit",
        "permission-confirm",
        "audit",
        "redact-credentials",
        "offline-protocol-conformance",
        "diagnose-empty-provider-configuration-without-network-call"
      ],
      "unsupportedOperations": [
        "raw-hex-write",
        "write-without-evidence",
        "bypass-native-validator",
        "bypass-patch-engine",
        "expose-credential-to-renderer",
        "bundle-provider-credentials",
        "require-live-provider-account-for-v05-acceptance"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [
        "EV-G-FAKE-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "双协议受控读写与空凭据默认配置已纳入目标范围，但裁定时 authorityAtRuling 为 unverified；离线 conformance 不证明任何第三方真实服务可用，真实账号也不属于 V0.5 验收。"
      ]
    },
    {
      "scopeItemId": "SCOPE-RUNTIME",
      "capabilityId": "H-RUNTIME",
      "gateIds": [
        "REL-H"
      ],
      "subjectKind": "runtime",
      "scope": "通过能力探测兼容的可替换 me3 GameRuntimeAdapter 检测、profile、启动、日志、终止与回滚后复启",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "detect-me3",
        "probe-protocol-schema-and-capabilities",
        "prepare-profile",
        "launch",
        "collect-diagnostics",
        "link-patch-operation",
        "rollback-and-relaunch",
        "terminate"
      ],
      "unsupportedOperations": [
        "implement-mod-loader",
        "write-original-game",
        "assume-compatible-from-version-or-exit-code",
        "launch-with-missing-or-ambiguous-capability"
      ],
      "authorityAtRuling": "fixture-confirmed",
      "evidenceRefs": [
        "EV-PUBLIC-CONTRACTS-20260725",
        "EV-H-GATES-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "能力探测兼容策略已纳入目标范围，但裁定时 authorityAtRuling 为 fixture-confirmed；裁定时 production gateway、真实 me3 profile/launch/diagnostics/terminate 与 Sekiro 启动尚未验证。"
      ]
    },
    {
      "scopeItemId": "SCOPE-RELEASE",
      "capabilityId": "H-RUNTIME",
      "gateIds": [
        "REL-H"
      ],
      "subjectKind": "release",
      "scope": "Windows 10/11 x64 NSIS 的打包、确定性 manifest/hash、干净机安装、覆盖升级、卸载与 runtime 完整性；代码签名不属于验收范围",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "package-nsis-x64",
        "verify-installer-artifact-hash",
        "install-clean-machine",
        "upgrade-migration",
        "uninstall",
        "verify-packaged-bridge-dotnet-native-binding",
        "launch-installed-build"
      ],
      "unsupportedOperations": [
        "portable-release",
        "automatic-update",
        "skipped-pack-as-evidence",
        "single-launch-as-install-validation",
        "installer-size-or-time-budget-as-v05-gate"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-REL-COMPLIANCE-20260725",
        "EV-PUBLIC-CONTRACTS-20260725",
        "EV-H-GATES-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "NSIS 内部测试构建已纳入目标范围且不要求代码签名或体积/耗时预算；现有 builder 配置与同机构建不证明 manifest/hash、安装、升级、卸载、干净机或 packaged runtime 完成，未签名包也不声明发布者身份或 SmartScreen 信誉。"
      ]
    },
    {
      "scopeItemId": "SCOPE-RENDERING",
      "capabilityId": "I-RENDER",
      "gateIds": [
        "REL-I"
      ],
      "subjectKind": "rendering",
      "scope": "renderer-independent semantic scene、Three.js WebGPU 主后端与 WebGL2 自动回退",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "probe-webgpu-and-fallback-webgl2",
        "stream-render-chunks",
        "render-flver-msb-collision-navigation",
        "pick",
        "update-transforms",
        "dispose-resources",
        "functional-backend-smoke-on-owner-machine"
      ],
      "unsupportedOperations": [
        "renderer-object-as-authority",
        "synthetic-budget-as-release-threshold",
        "proxy-scene-as-native-asset-proof",
        "representative-hardware-tier-acceptance",
        "performance-budget-as-v05-gate"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-C-MSB-SCENE-20260724",
        "EV-I-RENDER-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "WebGPU 主用与 WebGL2 功能回退已纳入目标范围；裁定时 authorityAtRuling 为 partial，当前机器功能 smoke 不证明代表性硬件兼容或性能水平，二者也不属于 V0.5 验收。"
      ]
    },
    {
      "scopeItemId": "SCOPE-COMPLIANCE",
      "capabilityId": "H-RUNTIME",
      "gateIds": [
        "REL-COMPLIANCE"
      ],
      "subjectKind": "compliance",
      "scope": "项目所有者控制机器上的内部测试构建、内容安全、installer manifest/hash、许可证 inventory 与禁止外部分发边界；代码签名不属于验收范围",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "scan-internal-package-tree",
        "inventory-production-licenses",
        "track-incomplete-notices",
        "scan-secrets-private-assets",
        "verify-owner-controlled-target",
        "verify-installer-artifact-hash"
      ],
      "unsupportedOperations": [
        "external-distribution",
        "public-release",
        "claim-incomplete-notices-distributable",
        "ship-private-corpus",
        "ship-oodle-runtime",
        "ship-credentials"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-REL-COMPLIANCE-20260725",
        "EV-PUBLIC-CONTRACTS-20260725"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "内部测试合规边界已获批准，但裁定时 authorityAtRuling 为 partial；未补齐适用 notices 或再分发权利前不得向任何外部测试者或公众分发，也不构成公开发行完成。"
      ]
    }
  ]
}
```
<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->

本范围已由用户逐项批准，并由后继裁定删除代码签名、真实模型凭据、代表性渲染硬件/性能预算、编辑器容量/延迟门槛和 installer 体积/耗时预算，同时固定 Smithbox 2.2.4 本机 PARAM metadata 来源；当前未变化范围以 `EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER` 完成工程重验证。`authorityAtRuling` 与每项 `nonClaims` 只记录 `EV-REL-SCOPE-20260730` 裁定时快照，实时 authority 唯一读取 §13.1；批准不提升 authority，也不把缺 corpus、parser、writer、adapter 或真实功能验证的项目变成完成。

统一语义编辑不变量：所有可编辑 native 资源必须先由 Bridge 形成完整、可读、可追溯的 native semantic document；结构化界面和规范 DSL 只能产生 typed mutation。未知字段可以作为只读 opaque 数据展示，但在没有 schema 和无损保持证据时不得编辑。Hex 永远是只读证据视图。

### 18.3 Gate 覆盖矩阵与后继切片

本表把 §18.1 每个发布 Gate 映射到当前切片和后继要求，让"系统是否终将覆盖全部 Gate"从主观汇总变成可机器校验的不变量。

V0.5 Gate 集合固定为 `REL-SCOPE/A/B/C/D/E/F/G/H/I/COMPLIANCE` 共 11 个；§18.1 与本表必须精确包含同一固定集合，不能通过同时删除两表中的 Gate 绕过范围裁定或基础门槛。

`gateState` 只允许 `open | blocked | passed`：`open` 必须至少引用一个 §13.1 中 `ready` / `active` 的切片；`blocked` 必须引用 §18.4 中已定义 blocker，且当前切片必须全部为 `blocked`；`passed` 必须引用至少一个 `sealed-current-run` Evidence，且 Evidence 的范围必须覆盖 §18.1 对应条件。`completed` / `superseded` 切片不能覆盖 `open` Gate。

Gate 只有在全部合法最小下一切片都受外部 blocker 阻塞时才能记为 `blocked`。只要仍能推进 protocol、validator、registry、instrumentation、失败关闭或 synthetic harness，就必须补出 `ready` / `active` 切片并保持 Gate `open`；下游最终验收所需的阈值或 corpus 不能提前压住当前可执行工作。

`applicability` 只允许 `pending-scope | in-scope | scope-excluded`。`REL-SCOPE`、`REL-A`、`REL-H`、`REL-COMPLIANCE` 永远为 `in-scope`，不得排除。`REL-B/C/D/E/F/G/I` 在 `REL-SCOPE` 尚未 `passed` 时保持 `pending-scope`；只有 `REL-SCOPE` 已以 sealed Evidence 通过、且同一或后继 sealed Evidence 明确记录用户批准的排除边界时，才可改为 `scope-excluded`。`scope-excluded` 行的 `gateState` 必须同时为 `passed`，不得保留为 `open` 或 `blocked`。

`passed` 与 `scope-excluded` 都只能引用 `sealed-current-run`；其中 `REL-SCOPE` 与范围排除还必须使用 §17.1 的用户批准声明标记，并满足 §17.2 显式主题域 freshness。`unsealed-record` 和 `historical-record` 可以保留既有事实或 blocker 边界，但不能完成 Gate。当前仅 `REL-SCOPE` 以用户批准 sealed Evidence 进入 `passed`；没有功能 Gate 因范围批准而提升 authority 或完成。

| Gate ID | capability | 当前切片 | gateState | applicability | Evidence/blockerRefs | 后继要求 |
|---|---|---|---|---|---|---|
| `REL-SCOPE` | V0.5 范围冻结 | `W-REL-SCOPE-RULING-04` | `passed` | `in-scope` | `EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER` | 27 项、Sekiro 1.6 版本族、语义编辑/只读 Hex、固定 Smithbox 本机 metadata、空模型凭据、功能性渲染验收、无编辑器/installer 量化预算与允许未签名 NSIS 的内部测试边界继续冻结；工程复核与普通工程提交不得触发用户重新授权 |
| `REL-A` | 全部 writer 与事务 | `W-A-RECOVERY-INTEGRATION-04` | `open` | `in-scope` | — | BND4/FMG/PARAM 12 case + EMEVD/MSB 8 case 已通过；继续真实断电/大容量/安装升级恢复 |
| `REL-B` | 容器发布 corpus | `W-REL-B-CORPUS-02` | `open` | `in-scope` | — | KRAK 重压/写回/roundtrip 已完成；继续组合 mutation/repack 和完整 corpus 验证 |
| `REL-C` | 核心语义 mutation 矩阵 | `W-EMEVD-FULL-01`、`W-EMEVD-FMG-PARAM-03` | `open` | `in-scope` | — | EMEVD DSL plan 的 production Bridge/PatchIR transaction 接线已完成；继续完整 EMEDF schema/control-flow、DSL 全局指令级 mutation、UI submit 接线；并行继续 FMG 全语言、全部 ParamType、MSB 实体和回滚 |
| `REL-D` | 行为动画范围 | `W-BEHAVIOR-MAP-01` | `open` | `in-scope` | — | TAE/ESD 登记样本 native document 已存在；继续 HKX/脚本定位、完整语义/schema、八编辑器接线、writer 与游戏加载矩阵 |
| `REL-E` | 资产只读与导出矩阵 | `W-FLVER-READ-01` | `open` | `in-scope` | — | FLVER/TPF 登记样本 native document 与部分 native-to-open 导出已存在；继续 MTD/collision/navigation、完整引用和五类只读/导出闭环 |
| `REL-F` | 编辑器验收 | `W-REL-F-SCALE-02` | `open` | `in-scope` | — | inventory 已精确冻结为八项；继续 BND4/script 工作台、TAE/ESD 语义写链、各编辑器结构化 UI/DSL/完整有界访问和 Electron 真实文档功能验收 |
| `REL-G` | 双协议 AI | `W-AI-CONFORMANCE-03` | `open` | `in-scope` | — | 错误/取消/超时/限额 10 case 已完成；继续真实工作区多步 typed mutation 矩阵 |
| `REL-H` | 安装与运行 | `W-ME3-INSTALL-04` | `open` | `in-scope` | — | profile/launch/terminate adapter 已完成；继续 NSIS 安装/升级/卸载和真实 Sekiro 会话 |
| `REL-I` | 渲染功能闭环 | `W-RENDER-FUNCTIONAL-02` | `open` | `in-scope` | — | 在项目所有者当前机器完成真实 semantic scene 的 WebGPU capability 主路径、WebGL2 功能回退、picking、transform 更新与资源释放；不要求硬件档位或性能预算 |
| `REL-COMPLIANCE` | 内部测试构建合规 | `W-REL-COMPLIANCE-02` | `open` | `in-scope` | — | 许可证文本 complete + NSIS 构建已完成；继续 installer lifecycle 验证和 package tree 扫描 |

后继要求列不是第二套进度口径；它只提示同一 Gate 在既有切片完成后仍需的下游切片。补货规则见 `docs/AGENT_EXECUTION_PLAYBOOK.md` §8，全阻塞终局见其 §9。

### 18.4 结构化 blocker 注册表

blocker `reason` 只允许：`private-corpus | credential | hardware | user-ruling | toolchain | license | upstream | prerequisite-authority`。每个 `blocked` 切片和 Gate 都必须通过 blockerRefs 引用本表中已定义 ID；解除 blocker 之前必须取得“所需输入”并通过“解锁验证”，不能只因时间经过或口头判断改回 `ready` / `open`。Evidence 可以是 sealed、unsealed 或 historical 记录，用于说明阻塞边界；只有 sealed Evidence 可以支持 Gate 终态。

表中标注“历史、当前无活动引用”的行只保留审计与未来范围变更触发器，不属于当前 blocker，也不得出现在“需要用户处理”的报告中。当前阻塞状态只由 §13.1 / §18.3 的活动 `blockerRefs` 判定。

| blockerId | reason | 影响 Gate/切片 | 责任方 | 所需输入 | 解锁验证 | 复查触发器 | Evidence |
|---|---|---|---|---|---|---|---|
| `BLK-NATIVE-FIXTURE-CORPUS` | `private-corpus` | 历史：`REL-A`、`W-A-RECOVERY-NATIVE-02`、`W-PARAM-META-NATIVE-01`；当前无活动引用 | 历史记录；当前由工程方消费既有本机 registry | 已解除：合法仓库外 locator registry、内容哈希和 native/PARAM 样本已可用 | private native gate 实际运行并保持 `partial`；未通过项转为工程切片，不能因 registry 存在而冒充完成 | 本机 registry/内容版本变化或用户撤回访问时重新打开 | `EV-A-RECOVERY-20260724`、`EV-C-PARAM-7BD`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-PARAM-METADATA-SOURCE` | `license` | 历史：`W-PARAM-META-SOURCE-02`；当前无活动引用 | 历史记录；当前 adapter 已完成 | 已解除：固定 Smithbox 2.2.4 本机导入、commit/release/archive/tree/license digest 与不再分发边界 | `npm run test:smithbox-param-metadata-source` 覆盖真实导入及缺失/错版/篡改/升级/撤回；导入数据仍在仓库外 | 用户修改来源、版本或再分发边界时重新打开 | `EV-PUBLIC-CONTRACTS-20260725`、`EV-REL-SCOPE-20260730-OWNER-INPUTS`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-EMEVD-LAYER-CORPUS` | `private-corpus` | 历史：`W-EMEVD-LAYER-01`；当前无活动引用 | 历史记录；当前由工程方在既有 corpus 内发现 | 已解除用户输入：合法仓库外 corpus root/registry 已可用；目标变体未命中时保持工程缺口 | 带哈希 `layerCount != 0` case 的只读解析、no-op roundtrip 和冲突失败关闭断言通过 | 本机 corpus 被撤回或后续确认目标变体确实不存在且需范围裁定时重新打开 | `EV-C-EMEVD-DSL-20260724`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-BEHAVIOR-CORPUS` | `private-corpus` | 历史：`REL-D`、`W-BEHAVIOR-MAP-01`；当前无活动引用 | 历史记录；当前由工程方推进 | 已解除用户输入：本机 registry 已支持登记 TAE/ESD native document，并观察到 HKX/Lua 条目 | 当前 TAE/ESD 仍为注册样本 candidate；完整语义、HKX/脚本引用、schema/typecheck、writer 和游戏加载继续在 `W-BEHAVIOR-MAP-01` 失败关闭 | 本机 corpus 被撤回或新增声明变体时重新打开 | `EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-ASSET-CORPUS` | `private-corpus` | 历史：`REL-E`、`W-FLVER-READ-01`；当前无活动引用 | 历史记录；当前由工程方推进 | 已解除用户输入：本机 registry 已支持登记 FLVER/TPF native document，其他声明资产由工程方继续定位 | 当前 FLVER/TPF 只读覆盖为 partial；MTD/collision/navigation、完整材质/引用、边界诊断和全 corpus no-op 继续失败关闭 | 本机 corpus 被撤回或新增声明变体时重新打开 | `EV-E-ASSET-7BD`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-REL-B-CORPUS` | `private-corpus` | 历史：`REL-B`、`W-REL-B-CORPUS-01`；当前无活动引用 | 历史记录；当前由工程方推进 | 已解除：仓库外 `sekiro-1-6-owner-corpus-v1` 已生成并覆盖当前 DFLT/BND4/KRAK 集合 | 214/214 分类与 read/no-op/CRUD 已执行，且一个登记 KRAK rename/repack/roundtrip 已独立验证；组合 mutation、未知字段保持、恢复和完整 corpus 写回继续失败关闭 | registry/内容版本变化、用户撤回访问或新增变体时重新打开 | `EV-B-DFLT-7BD`、`EV-B-BND4-7BD`、`EV-B-KRAK-20260724`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-MODEL-CREDENTIALS` | `credential` | 历史：`W-AI-REAL-01`；当前无活动引用 | 历史记录；用户无需提供 | 已解除：默认配置留空，真实 provider endpoint/key 不属于 V0.5 验收 | `W-AI-REAL-01` 已被取代；`W-AI-CONFORMANCE-02` 已在本地 contract servers 上完成并保持 `partial`，不证明第三方服务 | 用户日后主动把真实 provider live smoke 加回范围时重新打开 | `EV-G-FAKE-7BD`、`EV-REL-SCOPE-20260730-OWNER-INPUTS` |
| `BLK-RENDER-HARDWARE` | `hardware` | 历史：`W-RENDER-BENCH-01`；当前无活动引用 | 历史记录；用户无需提供 | 已解除：代表性硬件档位、地图性能基准和量化预算不属于 V0.5 验收 | `W-RENDER-BENCH-01` 已被取代；`W-RENDER-FUNCTIONAL-02` 只要求所有者当前机器的功能闭环并保持 `ready` | 用户日后主动把硬件/性能矩阵加回范围时重新打开 | `EV-I-RENDER-7BD`、`EV-REL-SCOPE-20260730-OWNER-INPUTS` |
| `BLK-SCOPE-RULING` | `user-ruling` | 历史：`REL-SCOPE`、`W-REL-SCOPE-RULING-01`、`W-REL-SCOPE-RULING-02`、`W-REL-SCOPE-RULING-03`、`W-REL-SCOPE-RULING-04`；当前无活动引用 | 用户 | 已完成：V0.5 支持/排除矩阵、未签名 NSIS、固定 Smithbox 本机 metadata、空 provider 凭据、功能性渲染边界及无编辑器/installer 量化预算均已批准 | `npm run test:release-scope` exit 0，且 `REL-SCOPE` 引用带 `scope-ruling:user-approved` 的 fresh sealed Evidence | 用户新增或修改任何冻结范围裁定 | `EV-REL-SCOPE-20260730`、`EV-REL-SCOPE-20260730-UNSIGNED`、`EV-REL-SCOPE-20260730-OWNER-INPUTS`、`EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS`、`EV-AUTONOMOUS-GOVERNANCE-20260731`、`EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER` |

---

## 19. 保留文档

执行方法（从属于本文，不承载状态口径）：

- `docs/AGENT_EXECUTION_PLAYBOOK.md`

长期愿景与研究边界：

- `docs/PRODUCT_VISION.md`
- `docs/PARSER_RESEARCH.md`

稳定技术规格：

- `docs/EMEVD_DSL_COMPILER_SLICE_AB.md`

Synthetic 技术规格当前存在工作树状态分歧：以下文件在文档同步基线 `2002076` 中受 Git 跟踪，但在本轮开始前已处于本地删除状态：

- `docs/V0_3_FMG_SYNTHETIC_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md`
- `docs/V0_3_SYNTHETIC_MAP_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_BND_FIXTURE.md`

在删除意图被确认并形成提交前：

- 不恢复或覆盖用户删除；
- 不把这些路径描述为当前工作树可读文档；
- synthetic authority 以实际 fixture 生成器、Bridge 代码和 `bridge:verify:synthetic` 断言为准；
- 若确认删除，必须同步清理 README 引用并确认没有仍依赖文档规格的测试/实现；
- 若确认保留，应从 Git 恢复原文，而不是重新编造规格。

开发桥：

- `docs/CODEXPRO_QUICKSTART.md`
- `docs/CODEXPRO_INTEGRATION.md`

除稳定格式规格外，不再创建与本文平行的路线、任务、状态和日志文档。

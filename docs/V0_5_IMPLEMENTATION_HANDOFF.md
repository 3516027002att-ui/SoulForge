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

**不要从通读本文开始。** 先跑：

~~~powershell
node scripts/gov.mjs next      # 可 claim 的切片 + 每条的入口、前置、所需验证
node scripts/gov.mjs help      # 全部命令与 seal 四步流程
~~~

`gov next` 输出自带工作流和每个切片的 `entryPoints`、`hardPrerequisites`、`requiredValidation`，足以开始工作。实测两条命令合计 8896 B，本文 431597 B，差 48.5 倍。本文用于需要地形背景时按区域检索，不是上手必读。

接手者应当：

1. 跑 `node scripts/gov.mjs next` 选点，`gov claim --slice <id> --owner <你>` 原子占用（避免并发撞车）。
2. 只在需要背景时读本文的相关区域地图；连续开发另可重读全局线路图与当前技术前沿。
3. 检查 `git status`、`HEAD`、本机环境和相关测试。
4. 根据依赖关系、真实证据、风险和当前可用环境，自主选择合理推进路径。
5. 收尾走 CLI：先提交主题域改动 → `gov seal` 追加证据 → `gov complete` 收尾。**不要手写本文的执行面板、Gate 状态或实施证据记录**，那些区块是 `docs/governance/*.json` 的投影，手写会被投影门禁判为分叉（详见 §13.3）。
6. 不新建平行的 milestone、fork、next-actions、project-state、task 或 status 文档。

需要机械化的选点决策树和拆解模板时，配合 `docs/AGENT_EXECUTION_PLAYBOOK.md` 使用。它只是方法手册，不承载任何状态、范围或 authority。

按区域检索本文时，通常需要的是：

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

V0.5 已按用户裁定收窄为“文本优先”范围：`gameparam` PARAM、FMG/msg、EMEVD 四视图 DSL，加上脚本容器的只读证据视图与整个内层文件替换。MSB、TAE、ESD、资产只读与导出、3D 渲染整体延期至 V0.6。延期不等于完成，也不等于永久排除；已实现的面板保留为标记 V0.6 只读预览，写路径在本版关闭。裁定与延期口径以 §18.2.1 冻结 JSON 为准。

~~~text
SoulForge V0.5（文本优先）
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
│  ├─ PARAM（gameparam）+ Paramdex-compatible metadata
│  ├─ EMEVD + EMEDF
│  └─ MSB → 延期 V0.6（只读预览，写路径关闭）
│
├─ D. 行为与动画主干
│  ├─ luabnd / action *.hks 脚本容器：条目枚举 + 只读字节码证据 + 整文件替换
│  ├─ TAE / animation events → 延期 V0.6（只读预览）
│  ├─ ESD / state machines → 延期 V0.6（只读预览）
│  ├─ animation / behavior references → 延期 V0.6
│  └─ 脚本反编译 / 重编译 / typed script mutation → 延期 V0.6
│
├─ E. 场景与资产主干 → 整条延期 V0.6
│  ├─ FLVER geometry / skeleton / materials
│  ├─ TPF / DDS textures
│  ├─ MTD / material resolution
│  ├─ collision / navigation resources
│  └─ glTF / GLB / PNG / TGA / DDS 导出矩阵
│
├─ F. 专业编辑器主干（V0.5 冻结五个）
│  ├─ read-only Hex evidence（共享只读证据视图）
│  ├─ BND4 容器
│  ├─ FMG localization
│  ├─ PARAM / metadata workbench
│  ├─ EMEVD 四视图 + 可编译 DSL
│  ├─ script 只读证据 + 整个内层文件替换
│  ├─ patch / reference / history / diagnostics / jobs
│  └─ msb / tae / esd / flver → 标记 V0.6 只读预览，不计入冻结清单
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
│  └─ CI / installer / updater（不含代码签名）
│
└─ I. 渲染架构主干 → 整条延期 V0.6
   ├─ renderer-independent semantic scene
   ├─ render projection / binary chunks / cache
   ├─ Three.js WebGPU primary backend
   ├─ WebGL2 compatibility fallback
   └─ future native backend if real benchmarks require it
~~~

这些路线存在依赖，但不构成强制的单线程实施顺序。接手者可以在不破坏前置 authority 和写入边界的前提下并行推进。标注“延期 V0.6”的路线不属于 V0.5 完成条件，也不阻塞 V0.5 完成；继续在这些路线上投入不违规，但不得据此声称 V0.5 范围扩大或 Gate 通过。

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
| `C-MSB` | MSB（延期 V0.6） | native document、`A-RECOVERY` | 完整场景、运行验证、地图引用 | V0.5 只保留只读预览，`set_part_transform` 写路径已关闭 |
| `D-BEHAVIOR` | 行为与动画 | Sekiro corpus 范围裁定、A/B 底座 | 招式链、状态机、跨资源行为编辑 | V0.5 仅脚本容器只读证据 + 整文件替换；TAE/ESD/animation 延期 V0.6 |
| `E-ASSET` | 场景与资产（延期 V0.6） | BND4、FLVER/TPF/MTD authority | 原生场景只读投影与 native-to-open 导出 | candidate inventory 不解锁 native writer；整条不属于 V0.5 完成条件 |
| `F-EDITORS` | 专业编辑器 | 对应 C/D semantic/native document | 可用工作台 | V0.5 冻结五个；msb/tae/esd/flver 为标记 V0.6 只读预览 |
| `G-AGENT` | AI Agent | evidence、typed tools、权限、A 写入主干 | 多步自动任务 | provider adapter 可并行，真实写循环依赖 native validator |
| `H-RUNTIME` | me3 与发行 | `A-RECOVERY`、可运行 Mod、合法本机环境 | 提交后启动、回滚后复验、发布门禁 | adapter contract 可先做，真实启动需环境 |
| `I-RENDER` | 渲染（延期 V0.6） | semantic scene、render projection | 大场景专业编辑 | 后端优化不改变 semantic/native authority；整条不属于 V0.5 完成条件 |

### 3.2 Authority 解锁规则

- `candidate` parser 只能解锁只读检查、corpus 分类和 diagnostics，不能解锁 writer。
- `fixture-confirmed` 可以解锁协议、事务和 UI 接线测试，不能证明真实格式。
- `partial` 只有在作用范围、未知变体和 corpus 覆盖均明确时，才可作为同一范围内下游工作的前置。
- `native-verified` 只能解锁其声明范围内的生产能力；新布局、新游戏或新容器包装必须重新验证。
- `blocked` 不阻止无写入的协议、validator、corpus registry 和失败关闭工作，但阻止对应成功路径与发布声明。
- `deferred`（切片与 Gate 生命周期，非 authority）表示该范围已被用户裁定移出 V0.5、在 V0.6 交付：既不计入 V0.5 完成，也不阻塞 V0.5 完成。`deferred` 不得写成 `passed`，不得用于基础 Gate，不得与 `blockerRefs` 共存，也不得与 `scope-excluded`（永久排除）混用。延期路线上已有的 authority 结论保持原级别不变，不因延期降级，也不因延期升级。

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

证据：`EV-C-PARAM-7BD`（historical-record，本轮未重跑私有 corpus）、`EV-PUBLIC-CONTRACTS-20260725`、`EV-REL-SCOPE-20260731-TEXT-FIRST`（容器范围收窄裁定）。

V0.5 容器范围已收窄为 `gameparam`；`drawparam` 与 `gparam` 延期至 V0.6，本版不得写入，也不得作为发布能力对外声明。

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
- `gameparam` 全 corpus 与真实游戏验证；
- `drawparam` / `gparam`（已延期至 V0.6，不属于 V0.5 缺口口径）。

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
- `emevdPlanCommit` 已能把 typed plan 确定性转换为 Bridge batch mutation，但当前没有 production 调用方；
- EMEDF schema 支持 vararg 参数（`vararg` 标记、`hasVararg`/`varargCount` 辅助函数、验证 vararg 必须是最后一个参数）；
- external-only EMEDF adapter（`emedfExternalAdapter.ts`）：读取用户本机 DarkScript3 格式 EMEDF JSON（含注释/尾随逗号兼容），类型码映射（0→u8, 1→u16, 2→u32, 3→s8, 4→s16, 5→s32, 6→f32, 8→u32），名称 sanitize 与去重，导入后自动验证；真实 `sekiro-common.emedf.json` 导入 405 条指令 / 27 bank / 2 vararg 指令通过。

仍缺：

- `layerCount != 0` 的 parser 路径已开放，但 43/43 当前注册文件均未命中非零 layer，仍缺真实变体证据；
- 完整 EMEDF 类型覆盖与真实 corpus 指令分布的交叉验证（adapter 已建立，但尚未在 production 写链中使用导入的 EMEDF 进行 typed mutation）；
- DSL control-flow validation 已实现基础事件 ID 引用检查（`EMEVD_DSL_EVENT_ID_REFERENCE_STALE` 警告：变更事件 ID 时检测 InitializeEvent 悬空引用），仍缺条件组一致性、skip/goto 目标验证等更完整的控制流分析；
- 全 corpus mutation matrix；
- KRAK 包装样本；
- 真实游戏加载验证。

EMEDF 类型源的定位、版本固定、许可证审计和适配实现属于工程工作，不是 `user-ruling`。工程方已完成 DarkScript3 公开项目调查与许可证审计：DarkScript3 及其 EMEDF 数据为 **All Rights Reserved**（见 `DarkScript3/Resources/LICENSES.txt`），不可复制、捆绑或再分发。因此 SoulForge 采用 external-only adapter 方案：adapter 代码（`emedfExternalAdapter.ts`）为原创，从用户本机 DarkScript3 安装中读取 `sekiro-common.emedf.json`，不提交或打包任何 EMEDF 数据。Smithbox 2.2.4 发行包中无 EMEDF 指令定义（已核验，仅 PARAM 数据）。若用户未提供 EMEDF 文件，未知指令继续保持只读 opaque，相关能力维持 `partial/unsupported`。只有改变已冻结的 EMEVD 产品范围才需要新的用户裁定。

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

状态：`partial`（authority 不变）· V0.5 生命周期：`deferred → V0.6`

证据：`EV-C-MSB-SCENE-20260724`（unsealed-record）、`EV-C-MSB-7BD`（historical-record）、`EV-REL-SCOPE-20260731-TEXT-FIRST`（延期裁定）。

MSB 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有能力保留为标记 V0.6 只读预览：`MsbScenePanel` 显示延期标记并隐藏提交入口；`msb` 的能力契约 `releaseWriteEnabled=false`，`editorAllowsMutation` 对 `msb_set_part_position` / `msb_set_part_transform` 一律拒绝；主进程 `resource.applyMsbMutation` 在进入 Patch Engine 之前返回 `EDITOR_DEFERRED_TO_V06_READONLY`。写链实现与 IPC 通道均未删除，V0.6 恢复时只需把 `deferredPreview` 置为 `null`。已达到的 `partial` authority 不因延期降级。

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

V0.5 范围已收窄为脚本容器一项；TAE、ESD 与 animation/behavior 引用整体延期至 V0.6。

V0.5 仍在范围内（`SCOPE-BEHAVIOR-SCRIPT`）：

- `luabnd` 与 `action/script/*.hks` 容器的条目枚举；
- 只读字节码/常量池证据投影；
- 经 Patch Engine 的整个内层文件替换、重读与回滚。

已延期至 V0.6：

- TAE / animation event 文档与时间轴（`SCOPE-BEHAVIOR-TAE`）；
- ESD state machine 查看、编辑和图投影（`SCOPE-BEHAVIOR-ESD`）；
- animation、behavior、event、param、map entity 之间的引用与角色招式链（`SCOPE-BEHAVIOR-ANIMATION`）；
- 脚本反编译、重编译与 typed script mutation。

脚本格式实测结论（延期依据，非完成声明）：`action/script/c0000.hks` 与 `aicommon.luabnd.dcx` 内层 `.lua` 均以 `\x1bLuaQ` 开头，属 Havok Script（Lua 5.1 家族）编译字节码，不是可直接编辑的文本；容器内并存 `.luagnl`（全局名表）与 `.luainfo`（函数参数元数据）反编译辅助文件。因此“脚本是易编辑文本”的前提不成立，V0.5 只做只读证据 + 整文件替换。测量方法与原始字节证据见 `EV-REL-SCOPE-20260731-TEXT-FIRST`。

当前已建立登记样本上的 TAE native document parser（939 animations、23,711 events、81 event types）和 ESD native document parser（36 groups、295 states、315 conditions及 RPN bytecode），并有只读工作台投影；这些结果仍是注册样本上的 `candidate`，不证明完整事件语义、全部布局或 writer。两者保留为标记 V0.6 只读预览，authority 级别不因延期变动。

脚本线已推进：容器条目枚举的生产实现已完成（`inventory-asset-resources` Bridge 命令 + `scriptContainerEvidence.ts` 证据投影，修复 TS 侧未读 Bridge `sampleEntries` 字段导致的真实容器条目枚举断链；真实 `aicommon.luabnd.dcx` 301 条目 / 64 样本全部识别为 `lua-bytecode`）；只读证据投影 UI 已完成（`ScriptContainerPanel.tsx`，不反编译/重编译/生成字节码）；整文件替换的 writer/validator 闭环已完成（`test:script-container-replace`：真实 luabnd 整内层替换 → Bridge 重读 → operation 回滚字节一致）。仍缺真实游戏加载。具体格式必须从合法 corpus、公开格式知识和可验证行为中确认，不得仅凭其他 FromSoftware 游戏的格式列表宣称 Sekiro 支持，也不得执行不受信脚本。

任何 writer 都要复用 A 线的 PatchIR 和回滚主干。

---

## 8. E 线：场景与资产

状态：`partial / candidate`（authority 不变）· V0.5 生命周期：`deferred → V0.6`（整条）

证据：`EV-E-ASSET-7BD`（historical-record）、§13.1 当前 native smoke 记录、`EV-REL-SCOPE-20260731-TEXT-FIRST`（延期裁定）。

整条资产只读与导出线（`SCOPE-ASSETS`、`SCOPE-ASSET-FLVER`、`SCOPE-ASSET-TPF`、`SCOPE-ASSET-MTD`、`SCOPE-ASSET-COLLISION`、`SCOPE-ASSET-NAVIGATION`、`SCOPE-ASSET-OPEN-CONVERSION`）已延期至 V0.6，对应 Gate `REL-E` 状态为 `deferred`：不计入 V0.5 完成，也不阻塞 V0.5 完成。已有的 FLVER/TPF 只读面板保留为标记 V0.6 只读预览，authority 级别不因延期变动。

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

开放格式到 FLVER/TPF/MTD 的 native 导入与所有五类资产 writer 仍是永久排除项（不是延期项）：现有 asset import/file_replace candidate 不得作为发布能力，未来若要恢复 native 导入，必须重新打开范围裁定。与之不同，本条资产只读与导出线属于 `deferred`，V0.6 仍会交付，两者不可混用。

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
- jobs、history、patch impact、diagnostics 投影；
- 简体中文界面和术语扫描；
- 标记 V0.6 只读预览：MSB 3D 代理场景（位置微调入口已在本版关闭）、TAE / ESD 只读 native document 工作台、FLVER 只读资产查看器。以上四项不计入 V0.5 冻结清单。

长期要求：

- 编辑器状态必须来自 native / semantic document，而不是 demo 数据；
- 所有 mutation 进入 typed protocol；
- revision 冲突显式失败；
- 大表格和大场景虚拟化、分页或分块；
- undo/redo 与 PatchIR/history 边界清晰；
- demo fallback 不得被当作真实文件能力；
- EMEVD DSL 最终可编译为 typed mutation；
- 行为、动画和资产编辑器逐渐接入同一工作台。

V0.5 冻结交付清单已收窄为 BND4、FMG、PARAM、EMEVD、script 五个编辑器。前四个为 typed mutation 编辑器，必须同时提供结构化界面和规范 DSL，并共享同一 Bridge native document、revision、selection 与 typed mutation；没有完整 parser/schema/typecheck/native writer 的资源不得编辑。script 编辑器只提供只读证据视图与整个内层文件替换，不属于 typed mutation，不得对外表述为脚本源码编辑。Hex 只允许作为只读偏移与原始字节证据视图，不能形成 raw write 或绕过 native authority。

msb、tae、esd、flver 已延期至 V0.6，保留为标记只读预览：不计入冻结清单、不得暴露写路径。该边界由三处同源约束共同保证——`EDITOR_CAPABILITY_CONTRACTS` 的 `releaseWriteEnabled=false`、`@soulforge/shared` 的 `DEFERRED_PREVIEW_EDITOR_KINDS`（renderer 打标来源）、以及 `runReleaseEditorAcceptanceSmoke` 中断言两者一致并逐项拒绝 mutation 的负向检查。

当前 inventory contract 已精确登记这五项，其中 BND4 与 script 工作台已由前端 Agent 完成首版（`Bnd4WorkbenchPanel.tsx` 容器浏览/子项替换、`ScriptContainerPanel.tsx` 只读证据 + 用户字节整内层替换），ParamDefPanel 已接真实行数据与字段级编辑；其余编辑器只能按各自当前 native authority 开放实际已验证操作。inventory 登记不等于五个编辑器完成。规模访问缺口仍在：`bnd4` 与 `script` 为 `none`，`fmg` 与 `param` 为 `bounded-window`，只有 `emevd` 已达 `pagination`。

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

状态：`partial / functional validation open`（authority 不变）· V0.5 生命周期：`deferred → V0.6`（整条）

证据：`EV-I-RENDER-7BD`（historical-record）、§13.1 当前 renderer smoke、`EV-REL-SCOPE-20260731-TEXT-FIRST`（延期裁定）。

整条 3D 渲染线（`SCOPE-RENDERING`）已延期至 V0.6，对应 Gate `REL-I` 状态为 `deferred`：不计入 V0.5 完成，也不阻塞 V0.5 完成。shared semantic scene/render packet、WebGPU capability detection、`three/webgpu` 按需主路径、WebGL2 fallback 构造和 FLVER 只读 3D 查看器已经进入 production bundle，保留为标记 V0.6 只读预览；当前仍以登记 FLVER/代理场景和 contract smoke 为主，没有所有者机器完整 fallback/resource-lifecycle 功能证据，也不要求真实大地图性能 authority。已达到的 `partial` authority 不因延期降级。

下述目标架构与接口是 V0.6 的技术路线记录，保留在此以免 V0.6 重新设计；它们不构成 V0.5 的交付项或验收项。

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
| A 工作区与事务 | `native-verified / partial hardening` | `EV-A-RECOVERY-20260724`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | BND4/FMG/PARAM 三格式 12 case 与 EMEVD/MSB 8 case writer 故障矩阵已通过；**真实断电/大容量/跨会话/升级恢复已完成**（`test:power-loss-recovery` 3 个 SIGKILL 注入点、`test:large-transaction-recovery` 800 op、`test:cross-session-journal` 四会话、`test:upgrade-recovery` 迁移兼容；`recoveryRepair` 幂等恢复 + `corruption_blocked` 失败关闭 + journal 阶段序列根因修复）|
| B DFLT | `native-verified` | `EV-B-DFLT-7BD` historical | 新变体和发布 corpus |
| B BND4 | `native-verified / partial` | `EV-B-BND4-7BD` historical | KRAK 内 corpus、新 flags/布局 |
| B KRAK | `native-verified / partial` | `EV-B-KRAK-20260724`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | **KRAK Oodle Kraken 重压/写回/roundtrip 已完成**；**KRAK 内 BND4 组合 mutation/repack 矩阵已完成**（`test:krak-combination-mutation` 18 组合 case + `VerifyFieldPreservation`/`ComparePreservation` 未知字段保持 + `bridge:verify:dcx-documents` KRAK-BND4 CRUD/字段保持回归）；仍缺完整 corpus 写回与组合表达能力进生产写链 |
| B 发布 corpus contract | `partial / registered local corpus` | `EV-HANDOFF-LIVENESS-20260725`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | 仓库外 registry 已覆盖 214 个 DCX、198 个唯一内容并完成 100% 分类；schema/分类不授予 native writer authority |
| C FMG | `native-verified / partial` | `EV-C-FMG-7BD` historical、`EV-FMGMSB-WRITE-20260731` | **FMG `add` mutation 已暴露并验证**（TS helper 补 `add` kind，真实 item.msgbnd add case：staged 写入 → 独立重读文本存在 → 原文件未受影响）；**menu.msgbnd 第二语料读验证完成**（15 子项全部 FMG v2 semantic roundtrip）；**FMG 引用完整性诊断已完成**（`fmgReferenceIntegrity.ts`：真实 item.msgbnd/menu.msgbnd 容器级引用扫描，重复 id/悬空分级诊断；`test:fmg-reference-integrity`）；仍缺多语言（本机 corpus 仅 zhocn）、多 msgbnd 写验证、引用与游戏加载 |
| C PARAM | `partial` | `EV-C-PARAM-7BD` historical、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | **metadata/native 一致性 135/138 已验证**；**PARAM 全 ParamType 字段写覆盖已完成**（`writeBitfield` BigInt 化修复 bitWidth≥31 溢出，位域支持 u8/s8/u16/s16/u32/s32/bool；`runParamFieldMutationSmoke` 全类型正/负/边界；`bridge:verify:param` 真实 gameparam 字段级 set 重读字节一致）；仍缺 3 个已知旧布局和完整字段 writer |
| C EMEVD | `partial` | `EV-C-EMEVD-DSL-20260724`、`EV-PRIVATE-20260724`、`EV-EMEVD-PATCHIR-20260731`、`EV-EMEVD-COVERAGE-20260731`、`EV-EMEVD-GLOBAL-20260731`、`EV-EMEVD-FULLDOC-20260731`、`EV-EMEVD-EMEDF-ADAPTER-20260801` | **DSL plan → Bridge batch staging → file_replace PatchIR → WorkspaceTransaction 的 production 接线已完成**（四视图 submit 入口，合成 3 case + 真实 common.emevd 事件级 mutation 通过，重读/回滚/failure 全链验证）；修复 writer 组合 mutation 的 id 重命名验证与既有重复事件 id 容忍；**真实 corpus 指令分布与 EMEDF 覆盖基线已建立**（`read-emevd-document` 输出聚合分布：142 种指令 / 33,266 条实例；fixture 覆盖 1 种；2000:0 存在 12/16/20/24/32 多长度变体；WaitFor/EndEvent 未出现在真实 corpus）；**DSL 全局指令级 typed mutation 已实现**（顶层 `instruction` 块，跨事件直接引用稳定指令身份，与事件内写法产生相同计划操作）；**EMEVD 完整文档分页组装已实现**（Bridge 分页 envelope → 连续性/总数/事件切片校验，DCX 直读解压产物可复用为 staging 源，真实 common.emevd 1,730 events / 33,266 指令 / 34 页）；**四视图 DSL 提交 UI 接线已完成**（main 持有权威完整文档缓存、renderer 仅编辑 DSL 文本，提交前重读 fresh 文档保证 revision 一致，经 `submitEmevdDslPlanViaFourView` production 写链提交）；**EMEDF schema vararg 支持与 external-only adapter 已完成**（DarkScript3 许可证审计为 All Rights Reserved，采用 external-only 方案；adapter 读取用户本机 `sekiro-common.emedf.json`，405 条指令 / 27 bank / 2 vararg 导入验证通过；vararg 参数支持 `hasVararg`/`varargCount` 辅助函数）；**DSL control-flow validation 已扩展为 schema 驱动的通用检查**（`extractEventIdReferences`/`extractConditionGroupReferences`/`extractConditionGroupResults` 通用 helper；事件 ID 引用检查不再硬编码 2000:0；新增 `EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE`/`EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED` warning-only 条件组一致性检查，schema 缺失静默跳过）；仍缺完整 EMEDF 类型覆盖与真实导入 EMEDF 交叉验证、全 corpus |
| C MSB | `partial` | `EV-C-MSB-SCENE-20260724`、`EV-C-MSB-7BD` historical、`EV-FMGMSB-WRITE-20260731` | 四类实体 preview 已进入稳定 revision/identity scene IR；**`set_part_transform` 重读验证已完成**（Bridge writer 补 rotX/scaleX/scaleY/scaleZ 重读核对，真实 m11 transform case：rotX=82.38、scale [1.05, 1.1, 0.95]，part 数不变）；仍缺全实体 CRUD、引用修复、完整非截断 scene projection |
| D 行为与动画 | `partial / candidate` | `EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-EMEVD-PATCHIR-20260731` | **TAE native document parser 已完成**（939 anims, 23711 events, 81 types）；**ESD native document parser 已完成**（36 groups, 295 states, RPN bytecode）；**script 容器 magic/reference inventory 已冻结**（`test:script-container-evidence` 36 合成 + 真实 luabnd 301 条目，magic 11/12 `\x1bLuaP`；**真实 magic 修正**：Sekiro luabnd 为 `\x1bLuaP` 非 `\x1bLuaQ`；`sanitizeEntryName` 脱敏；`probe:behavior-headers` 增强）；仍缺 HKX/Lua 完整语义 parser/writer/DSL 与游戏加载 |
| E 场景与资产 | `partial` | `EV-E-ASSET-7BD` historical、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-EMEVD-PATCHIR-20260731` | **FLVER native document parser 已完成**（346 bones, 36 mats, 182K faces, byte-identical）；**TPF native document parser 已完成**（16 textures, BC1/BC4/BC5）；**MTD 只读 XML 结构投影已完成**（candidate，DTD/外部实体拒绝）；新增 `read-mtd-document` 与 `inventory-asset-resources`（容器级资产类别 inventory）Bridge 命令；仍缺 collision/navigation 和完整只读 authority |
| F 专业编辑器 | `partial / acceptance candidate` | `EV-F-EDITORS-7BD` historical、`EV-HANDOFF-LIVENESS-20260725`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-EMEVD-SCALE-20260731` | inventory 已精确冻结为 BND4/FMG/PARAM/EMEVD/script（文本优先裁定后 MSB/TAE/ESD/FLVER 降为延期预览）；Hex 已只读，FLVER 归资产查看器；**EMEVD 编辑器规模访问已提升为 `pagination`**（完整文档分页组装 + DSL 模板行数截断 + 事件列表分页，硬约束 17 合规，`currentScaleContractGaps` 不再含 EMEVD）；**script 只读证据面板、BND4 工作台与 ParamDefPanel 字段级编辑已接线（前端 Agent）**；**bnd4/fmg/param 规模访问已升级为 release-safe pagination**（主进程分页通道 `listContainerChildrenPage`/`readFmgPage`/`readParamPage` + renderer 面板按页导航）；仍缺 script `scaleAccess=none` 有界访问、TAE/ESD 语义写链、各编辑器 DSL/完整有界访问和 Electron 功能验收 |
| G AI Agent | `partial / production unverified` | `EV-G-FAKE-7BD`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-EMEVD-PATCHIR-20260731` | **6 种错误分类 + 超时/取消/限额 10 case conformance 已完成**；**真实工作区多步 typed mutation 写矩阵 20 case 已完成**（agent loop 驱动 scaffold registry 经 Patch Engine 提交，plan 只读/normal 确认/full 权限门禁全覆盖）；**Context Broker 证据装配层已完成**（`contextBroker.ts`：五类证据来源受限脱敏有界装配、`insufficient_evidence`/`CONTEXT_LIMIT_EXCEEDED`/`CONTEXT_CANCELLED`/`CONTEXT_TIMEOUT` 结构化、agentLoop 集成 + `contextAssemblies` 审计、零网络 I/O）；conformance 扩至 28 case；真实 provider 凭据不属于 V0.5 验收 |
| H me3 运行 | `fixture-confirmed / partial` | `EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | **profile/launch/diagnostics/terminate adapter 已完成**（25 case smoke）；仍缺真实 Sekiro 会话和 NSIS 安装/升级/卸载验证 |
| H 发行 | `partial / unverified` | `EV-REL-COMPLIANCE-20260725`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-H-GATES-7BD` historical | **许可证文本覆盖 complete（123 present / 0 metadata-only）**；**NSIS 安装包构建成功（117.7 MB）**；**package tree 内容扫描与 manifest/hash 完整性已完成**（asar 1668/1668 交叉一致、installer exe hash + source fingerprint 链）；**installer lifecycle harness 已完成**（临时目标目录安装/升级/卸载/干净目标/清理）；仍缺真实 Sekiro gate 与跨机/远程 CI 复现 |
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

<!-- SOULFORGE_PROJECTION_BEGIN:slice-panel -->

| 切片ID | lifecycle | authority | blockerRefs | 目标能力 | 可独立验收切片 | 硬前置 | 主要入口 | required validation | authority上限 |
|---|---|---|---|---|---|---|---|---|---|
| `W-A-RECOVERY-01` | `completed` | `partial` | — | `A-RECOVERY` | 已完成公共四类 writer 与注册 BND4 writer 的 stage/validate/commit-backup/re-read 故障矩阵；本切片不再无限扩展 | 不改变 Patch Engine 主干；既有私有运行只保留原证据边界 | `packages/core/src/patch/durablePatchCommit.ts`、`packages/core/src/transactions/workspaceTransaction.ts` | `npm run test:writer-failure-matrix`、既有 `test:native-writer-failure-matrix` 记录 | cap=`partial`；只提升已覆盖 writer 的恢复可信度 |
| `W-A-RECOVERY-HARNESS-02` | `completed` | `fixture-confirmed` | — | `A-RECOVERY` | 已建立不加载 native 资产的 deterministic Bridge recovery/staging harness，覆盖四阶段故障、出站失败、注册期取消、超时、取消、同步/异步 progress、终态竞态、背压、进程退出、显式重启和 11 个代表性不安全 staging path segment case | 复用受控 subprocess 与系统临时目录；fake child 不得写成 native writer 通过 | `packages/core/src/bridge/bridgeDaemonClient.ts`、`packages/core/src/editing/bridgeStaging.ts`、`packages/core/src/testing/bridgeRecoveryHarnessProtocol.ts`、`packages/core/src/testing/bridgeRecoveryFixtureDaemon.ts`、`packages/core/src/testing/runBridgeRecoveryHarnessSmoke.ts` | `npm run test:bridge-recovery-harness`、`npm run test:bridge-staging`、`npm run bridge:verify:client` | cap=`fixture-confirmed`；只证明公开故障编排与 client/staging 失败关闭 |
| `W-A-RECOVERY-NATIVE-02` | `completed` | `partial` | — | `A-RECOVERY` | 将已冻结 harness 应用于其余 production native writer 的真实 stage/validate/commit/re-read/crash 矩阵；BND4/FMG/PARAM 三格式 12 case 全部通过 | 合法仓库外 native fixture registry 已建立；`W-A-RECOVERY-HARNESS-02` 已完成；未覆盖 writer 继续失败关闭 | 对应 Bridge writer、`runNativeWriterFailureMatrixSmoke.ts`、Patch Engine | `npm run test:native-writer-failure-matrix`、`npm run test:private-native-gate` 与对应 native transaction smoke | cap=`partial`；仅提升实际覆盖 writer，不外推到全部 writer |
| `W-PARAM-META-01` | `completed` | `fixture-confirmed` | — | `C-PARAM` | 已冻结 Paramdex-compatible metadata package、许可证 manifest、不可变来源、digest、五键匹配、精确 trust policy、display-only overlay、隔离快照、容量上限与冲突诊断契约 | 不捆绑或再分发 Paramdex 数据；不把 metadata 当 native row document；本切片不要求私有 PARAM | `packages/shared/src/paramdef.ts`、`packages/core/src/param/paramMetadata.ts`、`packages/core/src/param/paramdefLayout.ts`、`packages/core/src/testing/runParamMetadataMismatchSmoke.ts` | `npm run test:param-metadata-mismatch`、`npm run test:paramdef-layout` | cap=`partial`；metadata contract，不提升 PARAM writer |
| `W-PARAM-META-SOURCE-02` | `completed` | `partial` | — | `C-PARAM` | 已接入固定 Smithbox 2.2.4 本机发行包中的 SDT PARAM metadata，校验 commit/release/archive/tree/license digest、隔离导入、provenance、升级与撤回；不随 SoulForge 再分发导入数据 | `W-PARAM-META-01` 已完成；固定来源与非再分发政策已裁定；真实导入保持仓库外 | `packages/core/src/param/smithboxParamMetadataSource.ts`、`packages/core/src/param/paramMetadata.ts` | `npm run test:smithbox-param-metadata-source` | cap=`partial`；只提升固定本机来源 adapter，不提升 native PARAM authority或上游再分发权利 |
| `W-PARAM-META-NATIVE-01` | `completed` | `partial` | — | `C-PARAM` | 在合法注册 PARAM corpus 上验证 metadata 严格匹配、拒绝规则和 native row document 一致性；135/138 匹配、0 不一致、3 个已知旧布局正确排除 | metadata contract 与固定 Smithbox adapter 已完成；仓库外 PARAM fixture registry 已可用；剩余布局不得绕过 | `bridge/SoulForge.Bridge/ParamNativeDocument.cs`、`packages/core/src/param/smithboxParamMetadataSource.ts`、native fixture registry | `npm run bridge:verify:param`、`npm run test:smithbox-param-metadata-source`、`npm run test:param-metadata-native` | cap=`partial`；只覆盖实际通过的注册 PARAM 布局 |
| `W-EMEVD-DSL-01` | `completed` | `fixture-confirmed` | — | `C-EMEVD` | 已建立稳定 anchor、DSL tokenizer/parser/AST、规范 patch render、EMEDF typecheck 与确定性 typed mutation plan；本切片验收边界已完成 | 复用 emevd-editor-ir 与独立 emevd-dsl DTO；未知指令和不可无损重编码 payload 失败关闭/保持 opaque | `packages/shared/src/emevd-dsl.ts`、`packages/core/src/emevd/dslTokenizer.ts`、`packages/core/src/emevd/dslParser.ts`、`packages/core/src/emevd/dslCompiler.ts`、`packages/core/src/emevd/dslRenderer.ts`、`packages/core/src/emevd/stableIdentity.ts` | `npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view` | cap=`fixture-confirmed`；Bridge/PatchIR 与完整控制流进入后继切片 |
| `W-EMEVD-PATCHIR-02` | `completed` | `partial` | — | `C-EMEVD` | production 接线完成：`submitEmevdDslPlanViaFourView` / `commitEmevdPlanViaPatchEngine` 把 DSL typed plan 经 `stageEmevdPlanViaBridge`（Bridge batch staging）→ `buildEmevdFileReplacePatch`（file_replace PatchIR + hash 前置条件）→ `executePatchIrThroughTransaction` 提交，并做 Bridge 独立重读；合成 3 case（成功链/回滚链/失败链）与真实 common.emevd 事件级 mutation 1 case 均通过 | `W-EMEVD-DSL-01` 已完成；未知指令、opaque 尾部和 layer 变体不得被重编码；真实文档既有重复事件 id 容忍但不修改 | `packages/core/src/editing/emevdPlanCommit.ts`、`packages/core/src/editing/emevdFourViewController.ts`、`packages/core/src/editing/emevdBridgeCommit.ts`、`packages/core/src/testing/runEmevdPlanCommitProductionSmoke.ts`、`bridge/SoulForge.Bridge/EmevdNativeWriter.cs` | `npm run test:emevd-plan-commit`、`npm run test:emevd-plan-production`、`npm run bridge:verify:emevd`（四元组见 §13.4） | cap=`partial`；production smoke 不证明完整 EMEDF/layer/游戏加载 |
| `W-EMEVD-FULL-01` | `ready` | `partial` | — | `C-EMEVD` | 在导入的真实 EMEDF 上做交叉验证，并把 typed mutation 覆盖扩到全 corpus （adapter 已建立但尚未在 production 写链中使用导入 EMEDF 驱动 typed mutation）｜已完成证据：导入 EMEDF 驱动 production 写链与真实 corpus 覆盖率交叉验证已完成（`test:emevd-imported-production` 3 合成 leg + 真实 common.emevd 事件级/2000:0 指令级 typed mutation，vararg 尾逐字节保留；`test:emevd-imported-coverage` 对真实 142 种/33,266 条分布跑覆盖分类；真实 DarkScript3 EMEDF 文件 SOULFORGE_EMEDF_PATH 缺失时 fail-closed 跳过）；全 corpus typed-mutation 矩阵已完成（`test:emevd-corpus-matrix`：真实 common.emevd 33,266 指令/142 种——每个 schema 覆盖指令族 typed mutation 重读校验、未覆盖 140 族 opaque 字节保持 30,081/30,081、未知指令双重 fail-closed（EMEDF_UNKNOWN_INSTRUCTION/EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY）、vararg 长度签名区分与非法长度拒绝；`uncoveredKinds` 输出为覆盖工程线索）；导入 EMEDF 驱动 production 写链已完成（`test:emevd-imported-production`：DarkScript3 格式 EMEDF JSON 经 external-only adapter 导入 → DSL typed plan → Bridge batch staging → file_replace PatchIR → WorkspaceTransaction 提交 → 重读；合成 3 leg（成功链/回滚链/失败链）+ 真实 common.emevd 33,266 指令事件级 id/rest + 2000:0 InitializeEvent `eventId` typed mutation，vararg 尾部逐字节保留、未知指令保持 opaque、vararg 尾参数写编译期拒绝为只读；`test:emevd-imported-coverage`：导入 registry 对真实 corpus 分布跑 analyzeEmedfCoverage，clean/长度不匹配/unknown 分类；真实 EMEDF 文件（SOULFORGE_EMEDF_PATH）存在时交叉验证、缺失时 fail-closed 跳过）；已建立真实 corpus 指令分布提取与 EMEDF 覆盖分析基线（read-emevd-document 聚合分布 + `analyzeEmedfCoverage` 长度一致性校验，真实 142 种/33,266 条，fixture 覆盖 1 种）；DSL 顶层 instruction 块已实现（全局指令级 typed mutation：不依赖事件包裹，经稳定指令身份解析到所属事件，与事件内写法产生相同计划操作；跨作用域重复写被共享注册表拦截）；完整文档分页组装与四视图 DSL 提交 UI 接线已完成（Bridge 分页 envelope → `readFullEmevdDocumentViaBridge` 连续性/总数/事件切片校验 + DCX 直读解压产物复用为 staging 源；desktop main 持有权威完整文档缓存 `emevdFullDocuments`、renderer 仅编辑 DSL 文本；resource.`submitEmevdDslPlan` 提交前重读 fresh 文档保证 revision 一致，经 `submitEmevdDslPlanViaFourView` production 写链提交并刷新缓存）；EMEDF schema vararg 支持与 external-only adapter 已完成（DarkScript3 公开项目调查与许可证审计完成：All Rights Reserved，不可捆绑/再分发；`emedfExternalAdapter.ts` 读取用户本机 DarkScript3 格式 EMEDF JSON，含注释/尾随逗号兼容、类型码映射、名称 sanitize/去重、vararg 参数支持；真实 sekiro-common.`emedf.json` 导入 405 条指令 / 27 bank / 2 vararg 通过；28 个合成 case 覆盖正/负/边界场景）；继续完整 EMEDF 类型覆盖与真实 corpus 交叉验证（adapter 已建立但尚未在 production 写链中使用导入 EMEDF 进行 typed mutation）、DSL control-flow validation 已扩展为 schema 驱动的通用检查（`emedfSchema.ts` 新增 extractEventIdReferences/extractConditionGroupReferences/`extractConditionGroupResults` 通用 helper；`validateEventIdReferences` 不再硬编码 2000:0，改为遍历所有含 `eventId` 参数指令；新增 `validateConditionGroupReferences` warning-only 检查：EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE（引用值 ≤0）与 EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED（引用未在 `resultConditionGroup` 初始化集合中）；schema 缺失/未知指令静默跳过，不阻断 plan），仍缺真实导入 EMEDF 上的交叉验证与全 corpus mutation 矩阵 | `W-EMEVD-PATCHIR-02` 已完成 production 接线；未知指令、opaque 尾部和 layer 变体不得被重编码；真实文档既有重复事件 id 容忍但不修改；同 bank:id 多长度变体必须按长度签名区分，不得编造参数类型；无合法类型源时保持 opaque/partial 并继续其他工程切片，不能转成用户介入项；DarkScript3 EMEDF 数据为 All Rights Reserved，不得提交或打包 | `packages/core/src/emevd/emedfSchema.ts`、`packages/core/src/emevd/emedfExternalAdapter.ts`、`packages/core/src/emevd/emedfCoverage.ts`、`packages/core/src/emevd/dslCompiler.ts`、`packages/core/src/editing/emevdFourViewController.ts`、`packages/core/src/editing/emevdFullDocument.ts`、`packages/core/src/util/dcxDflt.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx`、`bridge/SoulForge.Bridge/EmevdNativeDocument.cs` | `npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-plan-production`、`npm run test:emevd-coverage`、`npm run test:emevd-full-document`、`npm run test:emevd-ipc-contract`、`npm run test:emevd-external-adapter`；`validation-unfrozen`：完整 EMEDF schema 覆盖与真实导入 EMEDF 交叉验证 | cap=`partial`；只提升实际完成并验证的 schema/类型/接线 |
| `W-EMEVD-LAYER-01` | `completed` | `partial` | — | `C-EMEVD` | Bridge 已支持 `layerCount` != 0 的 EMEVD 只读解析（移除 throw，暴露 layerCount/layersOffset）；GC 重建保持拒绝；corpus 43/43 文件无 layer 样本（fail-closed） | 仓库外 corpus root/registry 已可用；工程方负责继续发现和登记目标样本 | `bridge/SoulForge.Bridge/EmevdNativeDocument.cs` | `npm run bridge:verify:emevd` | cap=`partial`；仅声明实际覆盖到的 layer 变体 |
| `W-MSB-SCENE-01` | `deferred` | `partial` | — | `C-MSB` / `I-RENDER` | MSB 与渲染线延期 V0.6；本切片成果保留为只读预览，releaseWriteEnabled=false 必须保持关闭｜已完成证据：已建立 shared schema v2 semantic scene/render packet、四类 Bridge preview、稳定 identity/revision、chunk、路径防线和 production canvas/picking，且 msb_set_part_transform typed mutation 曾经真实 MSB 验证通过；文本优先裁定后 MSB 与渲染线延期 V0.6，本切片成果保留为标记只读预览，releaseWriteEnabled=false 关闭写路径 | entity identity 与 revision 稳定；renderer 无绝对路径；延期期间不得开放任何 MSB 写入（contract / shared 清单 / 主进程 IPC 三层失败关闭）；已验证的 `mutationKinds` 记录不删除，V0.6 恢复只需翻回标记 | `packages/shared/src/scene-ir.ts`、`packages/core/src/editing/msbBridgeRead.ts`、`apps/desktop/src/renderer/src/scene/threeSceneController.ts` | `npm run bridge:verify:msb`、`npm run test:scene-draw-list`、`npm run test:three-scene-module` | cap=`partial`；完整实体流式投影、writer、FLVER 或游戏加载进入后继切片 |
| `W-BEHAVIOR-MAP-01` | `ready` | `candidate` | — | `D-BEHAVIOR` | 维持 script 容器（luabnd / action *.hks）的 magic/reference inventory 为只读证据视图；TAE/ESD native document parser 已存在但随 TAE/ESD 一并延期 V0.6｜已完成证据：script 容器 magic/reference inventory 已冻结（`test:script-container-evidence` 36 合成 case + 真实 leg：真实 luabnd aicommon.luabnd.dcx 301 条目/256 采样、扩展名 {lua:299,luagnl:1,luainfo:1}、magic 11/12 命中 \`x1bLuaP`、文本 goal_list.lua magicVerified=false 如实、条目名脱敏无绝对路径；真实字节 magic 修正：Sekiro luabnd 编译字节码为 \`x1bLuaP`（0x50）而非此前文档声称的 \x1bLuaQ，且容器内 .lua 为字节码+文本列表混合；probe:behavior-headers 增强（\x1bLuaP/HKX TAG0/TAE/ESD fsSL/LUAINFO 识别，SOULFORGE_SEKIRO_GAME_ROOT 缺失失败关闭）；`sanitizeEntryName` 导出供分页通道复用）；文本优先裁定后本切片范围收窄为 script 容器（luabnd / action *.hks）的 magic/reference inventory：probe:behavior-headers 本机研究工具已观察容器扩展名分布与 HKX/Lua/ESD 头部，并确证 .hks/.lua 内层为 \`x1bLuaQ` 编译字节码（非文本源码），故 V0.5 只做只读证据视图；TAE/ESD native document parser（939 anims / 23711 events / 81 event types；36 groups / 295 states / 315 conditions / RPN bytecode）已存在但随 TAE/ESD 一并延期 V0.6 | 合法 Sekiro corpus root/registry 已可用；不得套用其他游戏结论或把扩展名计数当 parser；探针输出不提交、不提升 authority；不得把字节码反汇编呈现为可编辑源码 | `packages/core/src/testing/probeBehaviorHeaders.ts`、`bridge/SoulForge.Bridge/TaeNativeDocument.cs`、`bridge/SoulForge.Bridge/EsdNativeDocument.cs`、Bridge inspection | `npm run bridge:verify:tae`、`npm run bridge:verify:esd`；`validation-unfrozen`：script 容器 magic/reference inventory smoke | cap=`candidate`；仅覆盖注册样本的容器级 inventory 与字节码格式识别，不证明脚本语义、反编译、重编译或 writer |
| `W-FLVER-READ-01` | `deferred` | `partial` | — | `E-ASSET` | 继续 collision / navigation 格式定位；FLVER/TPF/MTD 只读线已完成，随渲染线延期 V0.6｜已完成证据：已构建 FLVER native document parser（346 bones, 36 materials, 44 meshes, 182K faces, byte-identical roundtrip）和 TPF native document parser（16 textures, BC1/BC4/BC5）；新增 MTD 只读 XML 结构投影 MtdNativeDocument（candidate，DTD/外部实体拒绝、大小/元素上限、重复解析一致性验证）与 read-mtd-document / inventory-asset-resources（容器级资产类别 inventory，脱敏）Bridge 命令；继续 collision/navigation 定位 | 合法 corpus root/registry 已可用；布局冲突失败关闭；内层扩展名计数不构成 native document；MTD 语义读取不构成 native authority | `bridge/SoulForge.Bridge/FlverNativeDocument.cs`、`bridge/SoulForge.Bridge/TpfNativeDocument.cs`、`bridge/SoulForge.Bridge/MtdNativeDocument.cs`、`bridge/SoulForge.Bridge/BridgeCommandService.cs` | `npm run bridge:verify:flver`、`npm run bridge:verify:tpf`、`npm run bridge:build` | cap=`partial`；当前只读覆盖为 partial（MTD 为 candidate），不开放 native writer |
| `W-AI-REAL-01` | `superseded` | `unverified` | — | `G-AGENT` | 历史切片原要求两类真实 provider 凭据和人工 live smoke；用户已裁定真实账号/凭据不属于 V0.5 验收，默认配置留空 | 由 `W-AI-CONFORMANCE-02` 取代；不得把取消 live smoke 写成 provider adapter 已完成 | `packages/core/src/model-services`、`apps/desktop/src/main/modelServiceCredentials.ts` | 历史验收不再执行 | cap=`unverified`；不产生功能 authority |
| `W-AI-CONFORMANCE-02` | `completed` | `partial` | — | `G-AGENT` | 已完成双协议错误分类（6 种错误码：TIMEOUT/NETWORK/RATE_LIMITED/SERVER/AUTH/PARSE）、AbortSignal 超时、agent loop 取消/限额、10 case conformance smoke | 不内置 endpoint/key；写工具仍需 native validator/Patch Engine；真实服务账号不属于 V0.5 验收 | `packages/core/src/model-services/errorClassification.ts`、`packages/core/src/model-services`、`packages/core/src/testing/runAiConformanceSmoke.ts` | `npm run test:ai-conformance`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:model-service-configuration` | cap=`partial`；离线 conformance 不证明第三方服务可用性或 native mutation authority |
| `W-ME3-ADAPTER-01` | `completed` | `fixture-confirmed` | — | `H-RUNTIME` | 已定义 renderer-independent GameRuntimeAdapter、contract-only me3 detect、精确版本 policy、闭集 gateway DTO、超时/取消/竞态、输出上限、异常脱敏和未实现操作失败关闭 | 不实现 Mod loader；不发现或启动真实 me3/Sekiro；匹配 fixture 仍不得启用 profile/launch | `packages/core/src/runtime/gameRuntimeAdapter.ts`、`packages/core/src/runtime/me3RuntimeAdapter.ts`、`packages/core/src/testing/runMe3RuntimeAdapterSmoke.ts` | `npm run test:me3-runtime-adapter` | cap=`fixture-confirmed`；adapter contract only，native runtime authority=false |
| `W-ME3-MAIN-DETECT-02` | `completed` | `fixture-confirmed` | — | `H-RUNTIME` | desktop main 已实现固定工具槽、固定 --version 的 privileged detection gateway，并把脱敏结果接入 core adapter/IPC/preload；真实 0.12.1 probe 保持 exit-zero-unverified | `W-ME3-ADAPTER-01` 已完成；main 独占真实路径与进程权限；本切片不启动游戏 | `apps/desktop/src/main/me3RuntimeGateway.ts`、`apps/desktop/src/main/ipc.ts`、`packages/core/src/runtime/me3RuntimeAdapter.ts` | `npm run test:me3-runtime-gateway`、`npm run test:desktop-security`、`npm run test:me3-runtime-adapter` | cap=`fixture-confirmed`；只证明受限 production detection gateway，不证明 runtime 会话可用 |
| `W-ME3-PROFILE-03` | `completed` | `fixture-confirmed` | — | `H-RUNTIME` | 已实现 profile 创建（me3 profile create -g sekiro）、launch（me3 launch -d）、diagnostics、terminate（taskkill /T /F）；gateway 扩展 createProfile/launchGame/`terminateProcess`；IPC 四通道；25 case smoke 通过 | `W-ME3-MAIN-DETECT-02` 已完成；不得只凭版本字符串或 exit 0 启用；所有路径/PID/argv 继续 main-only | `apps/desktop/src/main/me3RuntimeGateway.ts`、`packages/core/src/runtime/me3RuntimeAdapter.ts`、`apps/desktop/src/main/ipc.ts` | `npm run test:me3-runtime-adapter`、`npm run test:me3-runtime-gateway` | cap=`partial`；只提升实际完成且重读/回滚验证的运行操作 |
| `W-RENDER-BENCH-01` | `superseded` | `unverified` | — | `I-RENDER` | 历史切片原要求代表性硬件/地图与量化性能基线；用户已裁定其不属于 V0.5 验收 | 由 `W-RENDER-FUNCTIONAL-02` 取代；性能优化可独立推进但不得恢复为隐含 Gate | `packages/core/src/scene`、`apps/desktop/src/renderer/src/scene` | 历史验收不再执行 | cap=`unverified`；不产生渲染 authority |
| `W-RENDER-FUNCTIONAL-02` | `deferred` | `partial` | — | `I-RENDER` | 延期 V0.6：真实 FLVER 渲染、picking、transform 更新与资源释放的功能闭环｜已完成证据：WebGPU 检测已实现（adapter info + capability report）；WebGPU-first 渲染器已集成到 `threeSceneController`（three/webgpu 按需加载 + WebGL2 回退 + `rendererBackend` 报告）；继续真实 FLVER 渲染、picking、transform 更新与资源释放功能闭环 | 真实 native semantic scene/FLVER projection；不要求代表性硬件档位、地图集合、性能预算或 benchmark threshold | `packages/core/src/scene`、`apps/desktop/src/renderer/src/scene/threeSceneController.ts`、`webgpuDetect.ts` | `npm run test:scene-draw-list`、`npm run test:three-scene-module`；`validation-unfrozen`：WebGPU/WebGL2 functional fallback smoke | cap=`partial`；只证明已覆盖的 renderer contract，不外推所有者机器功能闭环、性能或硬件兼容矩阵 |
| `W-REL-SCOPE-01` | `completed` | `unverified` | — | `REL-SCOPE` | 已产出唯一、可 JSON 解析且覆盖 11 个 Gate 的 V0.5 支持范围提案；artifact validation 为 proposal-valid，用户裁定仍开放 | 只综合现有证据；私有 fixture registry 不得冒充 release corpus；不擅自裁定范围值 | 本文 §4~§12 与 §18.1~§18.2.1、`scripts/verify-release-scope.mjs` | `npm run test:release-scope-proposal` exit 0；严格模式必须因待用户裁定 exit 1 | cap=`unverified`；提案合法不等于范围获批或 Gate 完成 |
| `W-REL-SCOPE-RULING-01` | `completed` | `unverified` | — | `REL-SCOPE` | 用户已逐项批准 §18.2.1 的 27 项支持矩阵、Sekiro 1.6 版本族、八个语义编辑器、只读 Hex、所有者内部测试构建与 unsupported 边界；严格范围门禁和 sealed Evidence 已完成 | `W-REL-SCOPE-01` 已完成；批准记录使用脱敏 `decisionRef`；技术缺口继续由后继 Gate/blocker 失败关闭 | 本文 §18.2.1、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只完成范围 Gate，不提升任何功能 authority |
| `W-REL-SCOPE-RULING-02` | `completed` | `unverified` | — | `REL-SCOPE` | 用户撤销代码签名验收项；V0.5 当前发行目标为 Windows 10/11 x64 NSIS，仅限项目所有者控制的内部测试机器，允许未签名且仍强制 manifest/hash、内容扫描、安装、升级、卸载和 runtime 完整性验证 | `W-REL-SCOPE-RULING-01` 已完成；只修改签名要求，portable、自动更新和外部分发仍为 unsupported | 本文 §11、§18.1、§18.2.1、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730-UNSIGNED` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只更新范围 Gate，不提升任何功能或发行 authority |
| `W-REL-SCOPE-RULING-03` | `completed` | `unverified` | — | `REL-SCOPE` | 用户批准固定 Smithbox 2.2.4 本机 PARAM metadata 导入，并明确真实模型凭据留空、代表性渲染硬件/性能预算不属于 V0.5 验收；me3 环境由工程方处理 | `W-REL-SCOPE-RULING-02` 已完成；保持双协议 AI、WebGPU/WebGL2 功能与 me3 运行目标，不把取消外部输入写成能力完成 | 本文 §6、§10~§12、§18.1~§18.4、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730-OWNER-INPUTS` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只更新范围与责任边界，不提升 PARAM/AI/runtime/render authority |
| `W-REL-SCOPE-RULING-04` | `completed` | `unverified` | — | `REL-SCOPE` | 用户明确删除编辑器容量/延迟门槛和 installer 体积/耗时预算；V0.5 只验收完整有界访问与安装/升级/卸载正确性 | `W-REL-SCOPE-RULING-03` 已完成；不得借取消量化预算删除分页/虚拟化/分块/流式访问、manifest/hash 或 installer lifecycle 完整性 | 本文 §13.1、§18.1~§18.4、`releaseEditorAcceptance.ts`、`scripts/verify-release-scope.mjs`、`EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS` | `npm run test:release-editor-acceptance`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:handoff-integrity` | cap=`unverified`；只删除两个量化验收条件，不提升编辑器、installer 或其他功能 authority |
| `W-REL-SCOPE-RULING-05` | `completed` | `unverified` | — | `REL-SCOPE` | 用户裁定 V0.5 收窄为文本优先并提前发布：保留 BND4/FMG/PARAM(gameparam)/EMEVD/script 五个编辑器；MSB、TAE、ESD、FLVER/资产线与 3D 渲染线延期 V0.6 并保留为标记只读预览；script/action 因内层为 \`x1bLuaQ` 编译字节码而降为只读 + 整内层文件替换；drawparam/gparam 延期 V0.6。新增 deferred/`deferred-v0.6` 一等状态与配套门禁不变量，使延期与 `scope-excluded`（会强制 passed）严格区分 | `W-REL-SCOPE-RULING-04` 已完成；延期不得写成 passed、`scope-excluded` 或 completed；延期预览编辑器不计入发布编辑器数且必须只读；已实现且已验证的 MSB typed mutation 记录不删除，只关闭 `releaseWriteEnabled` | 本文 §3、§6~§9、§12、§13.1、§13.4、§18.1~§18.4、`scripts/verify-release-scope.mjs`、`scripts/handoff-integrity-lib.mjs`、`packages/core/src/editing/editorCapabilityContract.ts`、`packages/shared/src/editor-protocol.ts`、`apps/desktop/src/main/ipc.ts`、`EV-REL-SCOPE-20260731-TEXT-FIRST` | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:release-editor-acceptance`、`npm run test:handoff-integrity`、`npm run typecheck`、`npm test`、`npm run build` | cap=`unverified`；只完成范围裁定与延期机制，不提升任何功能 authority，也不因延期声明任何 Gate 完成 |
| `W-SCRIPT-READONLY-01` | `ready` | `candidate` | — | `D-BEHAVIOR` / `F-EDITORS` | 补齐 script 编辑器的游戏加载验证；写链已按整内层文件替换闭环验证完成｜已完成证据：script 编辑器按只读 + 整内层文件替换接线：容器条目枚举、\`x1bLuaQ` 字节码只读证据视图、.luagnl 全局名表与 .luainfo 函数参数元数据识别；写入只经 Patch Engine 的整内层文件替换（whole-inner-file-replacement），不做反编译/重编译/typed mutation；production 证据投影已实现（`scriptContainerEvidence.ts`：条目枚举 + \`x1bLuaQ` 字节码识别 + LUAGNL/LUAINFO/ESD/HKX 分类 + 有界 hex 证据；inventory-asset-resources Bridge 命令已注册到 TS 类型；desktop main IPC resource.`scriptContainerEvidence` + preload 接线完成）；后端写链已就位（ContainerChildReplaceWriter + `saveContainerChild.ts` + 通用容器 IPC 处理器）；renderer 脚本编辑器面板已完成（前端 Agent）（ScriptContainerPanel.tsx：条目分类摘要 + 有界 hex 证据 + 用户提供字节的整内层替换，不反编译/重编译/生成字节码；Bnd4WorkbenchPanel.tsx 容器工作台；ParamDefPanel 接真实行数据 + `applyParamFieldMutation` 字段级编辑，definition 源缺失时失败关闭）；真实容器证据投影已修复并验证（TS 侧补读 Bridge `sampleEntries` 字段，修复真实 luabnd 条目枚举断链；真实 aicommon.luabnd.dcx 301 条目、64 样本全部识别为 lua-bytecode）；真实容器整内层替换写/重读/回滚闭环已验证（`runNativeScriptContainerReplaceSmoke.ts` → `test:script-container-replace`：复制真实 luabnd 到临时 overlay，Bridge native write-bnd4 替换内层 goal_list.lua，重读条目数不变 + 内容更新，operation 回滚字节一致，原 Mod 未触碰）；仍缺游戏加载验证 | `W-BEHAVIOR-MAP-01` 的容器 inventory 为前置；不得反编译或重编译字节码，不得把反汇编呈现为可编辑源码；替换字节必须由用户提供，SoulForge 不生成字节码；写入仍须走 stage/validate/commit/backup/re-read 与失败回滚 | `packages/core/src/script/scriptContainerEvidence.ts`、`packages/core/src/editing/editorCapabilityContract.ts`、`packages/core/src/testing/probeBehaviorHeaders.ts`、`packages/core/src/writers/containerChildReplaceWriter.ts`、`packages/core/src/editing/saveContainerChild.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/renderer/src/editors/ScriptContainerPanel.tsx`、`apps/desktop/src/renderer/src/editors/Bnd4WorkbenchPanel.tsx`、`packages/core/src/testing/runNativeScriptContainerReplaceSmoke.ts` | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:script-container-evidence`、`npm run test:script-container-replace`（本机环境注入时真实 luabnd） | cap=`candidate`；只覆盖容器级枚举与只读投影，真实容器替换闭环与游戏加载已验证前不得提升 |
| `W-REL-B-REGISTRY-01` | `completed` | `fixture-confirmed` | — | `REL-B` | 已建立不含私有样本内容的 corpus registry schema、分类枚举、metadata-only classification harness，以及格式/变体/重复/数量/路径/伪装等负向诊断 | 不装载或提交私有 corpus；synthetic manifest 不得冒充 release corpus | `packages/core/src/bridge/releaseCorpusRegistry.ts`、`packages/core/src/testing/runReleaseCorpusRegistrySmoke.ts` | `npm run test:release-corpus-registry`、`npm test` | cap=`fixture-confirmed`；不声明真实发布 corpus 闭环 |
| `W-REL-B-CORPUS-01` | `completed` | `native-verified` | — | `REL-B` | 已完成 KRAK Oodle Kraken 重压/写回/roundtrip：OodleRuntimeSession.Compress() P/Invoke、DcxNativeDocument.RebuildKrak()、Bnd4NativeWriter 接受 KRAK、TypeScript writer pipeline 接线；真实 talkesdbnd KRAK 容器 rename mutation 验证通过 | 合法 corpus root/locator registry 与 Oodle 已可用；registry schema validity 不授予 native authority | `bridge/SoulForge.Bridge/OodleRuntime.cs`、`bridge/SoulForge.Bridge/DcxNativeDocument.cs`、`bridge/SoulForge.Bridge/Bnd4NativeWriter.cs`、`packages/core/src/writers/containerChildReplaceWriter.ts` | `npm run bridge:verify:oodle`、`npm run test:native-writer-failure-matrix` | cap=`native-verified`；只提升已执行的登记 KRAK writer case，不外推完整 corpus 或 `REL-B` |
| `W-REL-F-ACCEPT-01` | `completed` | `candidate` | — | `REL-F` | 已建立冻结五编辑器 inventory（BND4/FMG/PARAM/EMEVD/script）、authority/revision/typed mutation、只读 Hex、完整有界访问与提前 pass 失败关闭 harness；harness 同时断言 msb/tae/esd/flver 四个 V0.6 延期预览编辑器在 core 与 shared 两侧一致且写入被拒 | 不运行真实 Electron 真实文档功能验收；不以 synthetic/demo、FLVER 资产查看器或固定窗口冒充冻结编辑器完成；不要求量化容量/延迟门槛；延期预览编辑器不计入发布编辑器数 | `packages/core/src/editing/releaseEditorAcceptance.ts`、`packages/core/src/editing/editorCapabilityContract.ts`、`packages/shared/src/editor-protocol.ts`、`packages/core/src/testing/runReleaseEditorAcceptanceSmoke.ts` | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract` | cap=`candidate`；harness 不等于五个编辑器发布通过 |
| `W-REL-F-SCALE-02` | `ready` | `candidate` | — | `REL-F` | 关闭剩余编辑器的规模访问缺口：script 仍为 scaleAccess=none，需要有界访问｜已完成证据：script 编辑器规模访问已升级为 release-safe pagination（`listScriptContainerEntriesPage` 主进程分页通道 + ScriptContainerPanel 显式分页，currentScaleContractGaps=[]——bnd4/fmg/param/emevd/script 五编辑器全部 release-safe）；bnd4/fmg/param 规模访问已升级为 release-safe pagination（主进程分页通道 resource.listContainerChildrenPage/readFmgPage/readParamPage，FMG_PAGE_SIZE=100/PARAM_PAGE_SIZE=20，renderer 面板按页导航不再 eager 物化；`editorCapabilityContract` bnd4/fmg/param scaleAccess=pagination；`currentScaleContractGaps` 仅剩 script）；script 编辑器 scaleAccess=none 仍为真实缺口；inventory 已精确冻结为 BND4/FMG/PARAM/EMEVD/script 五项（文本优先裁定；MSB/TAE/ESD/FLVER 延期 V0.6 只读预览，不计入本版）；EMEVD 编辑器规模访问已从 eager 提升为 pagination（完整文档分页组装 `readFullEmevdDocumentViaBridge` + DSL 模板行数截断 `renderEmevdPatchDslBounded`（事件块边界截断 + 注释标记，patch no-op 语义安全）+ 事件列表分页每页 200 + `loadFullDslTemplate` 显式完整加载；`currentScaleContractGaps` 不再含 EMEVD）；前端工作台已补（ScriptContainerPanel.tsx script 只读证据 + 用户字节整内层替换；Bnd4WorkbenchPanel.tsx BND4 容器工作台；ParamDefPanel 接真实行数据 + 字段级编辑）；继续各编辑器结构化 UI/DSL/完整有界访问（bnd4/script scaleAccess=none、fmg/param bounded-window 仍为缺口）和 Electron 真实文档功能验收 | FLVER 只读查看器属于已延期的资产线；Hex 永久只读；当前 candidate 只继承 acceptance harness 对缺口的分类；EMEVD pagination 只证明规模访问契约（分页组装/模板截断/列表分页），不证明完整语义编辑或真实验收；延期预览编辑器的规模缺口按 V0.6 记账，不得据此声称本版缺口减少 | `packages/core/src/editing/editorCapabilityContract.ts`、`packages/core/src/editing/emevdFullDocument.ts`、`packages/core/src/emevd/dslRenderer.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx`、`apps/desktop/src/renderer/src/editors/ScriptContainerPanel.tsx`、`apps/desktop/src/renderer/src/editors/Bnd4WorkbenchPanel.tsx`、`apps/desktop/src/renderer/src/App.tsx` | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:emevd-full-document`、`npm run test:emevd-dsl-compiler`；`validation-unfrozen`：真实文档完整有界访问与 Electron functional smoke | cap=`partial`；只提升实际完成的编辑器功能，不以 inventory 或取消量化门槛代替真实验收 |
| `W-REL-COMPLIANCE-01` | `completed` | `partial` | — | `REL-COMPLIANCE` | 许可证文本覆盖完成：123 present / 0 metadata-only / 49 not-installed（可选平台包）；补充许可证目录 `licenses/`；NSIS 安装包构建成功（SoulForge-0.0.0-`x64.exe`, 117.7 MB）；electron-builder 已收敛为 NSIS-only | 不提交真实资产、用户 Mod、私有 corpus 或凭据；不得产生 portable release | `scripts/release-compliance-lib.mjs`、`licenses/`、`apps/desktop/electron-builder.json`、`apps/desktop/package.json` | `npm run test:release-compliance-fixtures`、`npm run test:portable-packaging-config-fixtures`、`npm run test:release-content`、`npm run build` | cap=`partial`；不声明 notices、installer lifecycle 或外部分发通过 |
| `W-A-RECOVERY-NATIVE-03` | `completed` | `partial` | — | `A-RECOVERY` | 已完成 EMEVD/MSB 独立文件写入故障矩阵（file_replace pipeline + Bridge staging）；4 阶段 × 2 格式 = 8 cases | `W-A-RECOVERY-NATIVE-02` 已完成；未覆盖 writer 继续失败关闭 | `runStandaloneWriterFailureMatrixSmoke.ts`、Bridge EMEVD/MSB writer | `npm run test:standalone-writer-failure-matrix` | cap=`partial`；仅提升实际覆盖 writer |
| `W-A-RECOVERY-INTEGRATION-04` | `ready` | `partial` | — | `A-RECOVERY` | 把已完成的断电/大容量/跨会话/升级恢复验证收敛为长期回归，并接入发布门禁｜已完成证据：真实断电/大容量/跨会话/升级恢复已完成（4 个新 smoke 全绿：`test:power-loss-recovery` 3 个 SIGKILL 注入点 hook-kill/mid-replace/committed-then-kill 真实子进程+SQLite journal+真实备份；`test:large-transaction-recovery` 800 op 成功链/失败关闭/大容量恢复/损坏失败关闭；`test:cross-session-journal` 四会话无丢失无重复+跨会话回滚+崩溃修复；`test:upgrade-recovery` 旧版迁移 1..3→6 checksum 保留、旧中断事务用旧备份恢复）；journal 阶段序列根因修复（`durablePatchCommit` validating→backing_up→replacing：backupRoot/restorePointFiles/`afterHashes` 在替换前持久化——修复硬杀 mid-commit 后 journal 找不到备份的根因缺口；`recoveryRepair.ts` `recoverIncompleteTransactions` 幂等恢复，corruption 时 corruption_blocked 失败关闭，不自动重放/不 roll-forward；`workspaceTransaction` 新增 `onRestorePointCreated` 钩子 + `getCommitTargets`()）；继续真实断电恢复、大容量事务恢复、安装/升级后恢复和跨会话 journal 一致性验证 | `W-A-RECOVERY-NATIVE-03` 已完成；需要真实环境测试 | `packages/core/src/transactions/workspaceTransaction.ts`、journal、backup | `npm run test:writer-failure-matrix`、真实断电/大容量 smoke | cap=`partial`；仅提升实际验证的恢复路径 |
| `W-REL-B-CORPUS-02` | `ready` | `partial` | — | `REL-B` | 把注册的本机 corpus contract 推进到发布可用：补跨机复现与 schema 冻结｜已完成证据：KRAK 内 BND4 组合 mutation/repack 矩阵已完成（`test:krak-combination-mutation`：3 登记 KRAK-BND4 样本 × 6 组合 case = 18（rename/replace/delete/move/add 组合，含 add 后链式 rename/replace），write-bnd4 mutations 数组单次 repack+单次 Kraken 重压+单次重读→独立重读→回滚 sha256 一致，真实游戏目录零写入；C# Bnd4NativeWriter.WriteAsync 组合 mutations 能力向后兼容）；未知字段保持已验证（VerifyFieldPreservation/ComparePreservation：no-op roundtrip 与 mutation 后未触条目 flags/unknown/stored bytes 逐字节一致，header 未知区 0x18/0x30-3F 保持；bridge:verify:dcx-documents KRAK-BND4 CRUD+字段保持回归）；继续 KRAK 内 BND4 组合 mutation/repack 矩阵、未知字段保持和完整 corpus 写回验证 | `W-REL-B-CORPUS-01` 已完成 KRAK 重压/写回；registry 继续失败关闭 | `scripts/verify-native-dcx-documents.mjs`、Bridge writer | `npm run bridge:verify:dcx-documents` | cap=`native-verified`；只覆盖实际执行的 corpus 操作 |
| `W-EMEVD-FMG-PARAM-03` | `ready` | `partial` | — | `C-EMEVD` / `C-PARAM` | 补 FMG 多语言与多 msgbnd 写验证（本机 corpus 仅 zhocn）、PARAM 3 个已知旧布局与完整字段 writer｜已完成证据：FMG 引用完整性诊断已完成（`fmgReferenceIntegrity.ts` 只读 analyzeFmgReferenceIntegrity：<?tag@id?>/<?tag?> 引用提取、重复 id→error/越界→error/悬空→warning/resolved→info 分级、位置与 512 上限；真实 item.msgbnd 353 引用/1 重复 id error、menu.msgbnd 220 引用/1 重复 id error——原版数据只读呈现；`test:fmg-reference-integrity`）；3 个已知 PARAM 旧布局真实诊断保留（index 32/33/81 实际提取 + Bridge 结构化诊断，expectedUnsupportedDetails）；PARAM 全 ParamType 字段写覆盖已完成（paramdefLayout.`writeBitfield` 改用 BigInt 修复 bitWidth≥31 溢出，位域读写扩展到 u8/s8/u16/s16/u32/s32/bool 无符号位模式存储；`runParamFieldMutationSmoke` 扩为全类型正/负/边界 case；bridge:verify:param 真实 gameparam 字段级 set 重读字节一致 + 源行不可变）；FMG add 真实 native 验证完成（bridge:verify:fmg 真实 item.msgbnd add staged 写 → Bridge 独立重读文本存在 → 原文件未受影响 → 清理；zhocn-only 语言覆盖限制如实记录）；FMG add mutation 已暴露并验证（TS helper 补 add，真实 item.msgbnd add case：不存在的 id `999999999` staged 写入 → Bridge 独立重读文本存在 → 原文件未受影响 → 清理）；menu.msgbnd 第二语料读验证完成（15 子项全部 FMG v2 semantic roundtrip）；MSB set_part_transform 重读验证已完成（Bridge writer 补 rotX/scaleX/scaleY/`scaleZ` 重读核对，真实 m11 transform case：rotX=82.38、scale [1.05, 1.1, 0.95]）；修复 EmevdNativeWriter CS8629 警告（patch.NewEventId!.Value）；FMG add 四层接线已完成（EditorMutationKind 加 fmg_entry_add、capability contract fmg `mutationKinds` 加 fmg_entry_add、IPC `applyFmgMutation` 加 add 分支、preload 类型加 add；`runFmgMsbIpcContractSmoke` 补四层静态断言；release-editor-acceptance 的 `observedMutationKinds` 由 contract fixture 动态派生，无数量断言，exit 0）；PARAM 字段级 mutation 专项 smoke 已新增（`runParamFieldMutationSmoke.ts` → `test:param-field-mutation`：10 case 覆盖标量/bitfield 写入、无效 base64/空行/行宽不匹配/字段不存在/越界结构化失败、源行不可变；`runParamMsbWriteIpcContractSmoke` 补 `applyParamFieldMutation` 通道断言）；继续 FMG 全语言 mutation（本机 corpus 仅 zhocn）、全部 ParamType 写入、登记 MSB 实体编辑、引用完整性和回滚验证 | FMG/PARAM/MSB 子路可独立推进；EMEVD DSL 写链仍依赖 `W-EMEVD-PATCHIR-02`；未知字段/layer 继续失败关闭；FMG 多语言验证受本机 corpus 语言覆盖限制；fmg_entry_add UI 入口（FmgWorkbenchPanel 加 add 按钮）仍属前端待接线项，未接线前 `editorAllowsMutation` 放行但无实际 UI 调用路径 | Bridge FMG/PARAM/MSB writer、Patch Engine | `npm run bridge:verify:fmg`、`npm run bridge:verify:param`、`npm run test:paramdef-layout`、`npm run test:param-field-mutation`、`npm run test:fmg-msb-ipc-contract`、`npm run test:param-msb-write-ipc-contract` | cap=`partial`；只覆盖实际完成的 mutation 路径 |
| `W-AI-CONFORMANCE-03` | `ready` | `partial` | — | `G-AGENT` | 继续扩展 AI conformance 覆盖；真实 provider 凭据不属于 V0.5 验收范围｜已完成证据：Context Broker 证据装配层已完成（`contextBroker.ts`：readFile/resourceGraph/diagnostics/patchPlan/工具结果五类证据装配为受限脱敏有界 context；CONTEXT_LIMIT_EXCEEDED/CONTEXT_CANCELLED/CONTEXT_TIMEOUT 结构化失败关闭；insufficient_evidence 结构化返回；`agentLoop` 每轮注入 + `contextAssemblies` 审计；零网络 I/O）；conformance 20→28 case（生产多步闭环 propose→stage→validate→commit→re-read + broker 跨步骤注入、取消无残留、full 权限仍 PATCH_ENGINE_REQUIRED、policy gate 7 权限×3 模式矩阵）；真实工作区 production typed mutation 多步矩阵已通过 agent loop（20 case：成功 propose→stage→validate→commit→re-read、normal 确认、plan 只读、validation 失败阻止提交、stale revision 冲突、取消/超时/限额不提交、full 权限仍 PATCH_ENGINE_REQUIRED、policy gate 矩阵）；scaffold registry 新增 workspace.`readFile` 等只读工具并给 patch.`proposeTextEdit` 增加内容 hash 前置条件 | `W-AI-CONFORMANCE-02` 已完成错误/取消/超时/限额；不要求真实 provider 凭据 | `packages/core/src/model-services`、`packages/core/src/ai-tools/scaffoldToolRegistry.ts`、`packages/core/src/testing/runAiConformanceSmoke.ts` | `npm run test:ai-conformance`、`npm run test:ai-fake-loop` | cap=`partial`；离线 conformance 不证明第三方服务可用性 |
| `W-ME3-INSTALL-04` | `ready` | `partial` | — | `H-RUNTIME` | 继续 NSIS 安装/升级/卸载验证、真实 Sekiro 会话 launch/terminate 和回滚后重启 | `W-ME3-PROFILE-03` 已完成 profile/launch/terminate adapter；不要求代码签名 | `apps/desktop/electron-builder.json`、`apps/desktop/src/main/me3RuntimeGateway.ts` | `npm run test:me3-runtime-adapter`、NSIS installer lifecycle | cap=`partial`；只提升实际验证的运行操作 |
| `W-REL-COMPLIANCE-02` | `ready` | `partial` | — | `REL-COMPLIANCE` | 补真实 Sekiro gate 与跨机/远程 CI 复现；许可证覆盖与 installer 完整性链已完成｜已完成证据：package tree 内容扫描与 manifest/hash 完整性已完成（auditPackageTree/listAsarEntries：win-unpacked 必装齐全 + forbidden 路径拒绝 + asar 内 1668 条目与官方 @electron/asar 交叉一致 1668/1668；release:installer:manifest exe sha256 + source out-manifest fingerprint 链，不一致 fail-closed）；installer lifecycle harness 已完成（verify-installer-`lifecycle.mjs`：默认结构化 preflight+skip；SOULFORGE_INSTALLER_LIFECYCLE_RUN=1 在临时目标目录安装→升级→卸载→干净目标检查→清理；真实 NSIS 构建 SoulForge-0.0.0-`x64.exe` 118,109,161 B）；继续 NSIS installer lifecycle 验证（安装/升级/卸载/干净目标）、package tree 内容扫描和 manifest/hash 完整性 | `W-REL-COMPLIANCE-01` 已完成许可证文本和 NSIS 构建；不要求代码签名 | `apps/desktop/electron-builder.json`、`scripts/release-compliance-lib.mjs` | `npm run test:release-compliance-fixtures`、`npm run test:release-content` | cap=`partial`；不声明外部分发或签名发布通过 |

<!-- SOULFORGE_PROJECTION_END:slice-panel -->

### 13.1.1 Active claim 注册表

`ready -> active` 时必须在下表原子登记一个 claim；`active -> completed/blocked/ready/superseded` 时必须删除对应行。claim 只用于并发协调，不构成 Evidence，也不能提升 authority。

<!-- SOULFORGE_PROJECTION_BEGIN:active-claims -->

当前没有 active claim。gov claim 获取、gov complete 释放；表格由 generate-handoff-projection 从 slices.json 投影。

<!-- SOULFORGE_PROJECTION_END:active-claims -->

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

`W-HANDOFF-INTEGRITY-01`：`test:handoff-integrity`（`node scripts/verify-handoff-integrity.mjs`）已建立并接入根 `package.json`。它解析本文的治理区块并做确定性校验，不维护第二份手写状态清单。

治理事实源已外置为 `docs/governance/*.json`（`slices.json`、`gates.json`、`evidence.jsonl`、`scope.json`、`releases.json`）。本文 `SOULFORGE_PROJECTION_BEGIN/END` 标记内的区块是这些 JSON 的投影，由 `node scripts/generate-handoff-projection.mjs` 生成，`test:handoff-projection` 保证两侧不分叉。因此本文仍是人读的完整口径，但**不再是可手写的权威**：改治理状态要改 JSON 并重新生成，手改标记内的区块会被投影门禁判为分叉。标记外的散文（规则说明、决策依据、历史记录）仍由工程手写并复核。证据见第 17.1 节 `EV-HANDOFF-20260721`。

门禁只自动覆盖零误报、可确定性判定的子集，当前应检查：

- README、本文和执行手册的 markdown 链接必须存在；README 必须直链本文且不得依赖本机代理规则文件；
- 第 17.1 表内 Evidence ID 唯一且引用闭合；sealed 指纹必须可按 §17.2 重算，passed Gate freshness 只检查显式登记的 Gate 主题域；
- 第 13.1 表必须使用完整十列 schema，lifecycle、authority、`cap=<authority>` 与 blockerRefs 合法；active 切片必须在 §13.1.1 有唯一 claim；
- §18.1 与 §18.3 必须精确保留固定 11 个 Gate；状态、适用性和切片满足 open/blocked/passed 收敛不变量；
- `blocked` Gate 只能引用 blocked 当前切片与 §18.4 blocker；blocker 八字段完整，影响对象与活动引用闭合；
- `passed` / `scope-excluded` 必须引用 sealed Evidence；基础 Gate 不得排除，范围裁定/排除必须带用户批准用途标记；
- `deferred` Gate 必须配 `deferred-v0.6`、引用带 `scope-deferral:<GateId>:V0.6:user-approved` 的 sealed Evidence、不得带 blocker、覆盖范围条目必须全部 `deferred`，且其切片必须一并为 `deferred`；范围完全延期的 Gate 不得写成 open/blocked/passed；
- `deferred` 切片不得留在 §13.4 未冻结清单；反向地，§13.1 标注 `validation-unfrozen` 的非终态切片必须出现在 §13.4 清单中；
- §18.5 V0.6 延期承接索引必须与 §18.2.1 范围矩阵、§18.3 Gate 状态、§13.1 切片 lifecycle 和 shared `DEFERRED_PREVIEW_EDITOR_KINDS` 逐项双向一致（`test:v06-deferral-index`），并保留派生声明、非声明与恢复须重跑验证的边界；
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

面板中尚未冻结的条目（如"新增 inventory smoke""真实 Sekiro / installer lifecycle smoke""真实文档有界访问 functional smoke"）必须显式标注 `validation-unfrozen`，不得被当作已可运行验证。它们只有在写成上述四元组、且 script 进入 package.json 后，才算冻结。

`deferred` 切片不出现在本列表：延期到 V0.6 的验证不需要在本版冻结，但也不得因此被记为已冻结或已通过。它们的 validation 会随切片一起在 V0.6 恢复时重新进入未冻结状态。

当前显式为 `validation-unfrozen`（需后续冻结）：

- `W-EMEVD-FULL-01`：完整 EMEDF schema 覆盖与真实导入 EMEDF 交叉验证 smoke；
- `W-ME3-INSTALL-04`：NSIS installer lifecycle、真实 Sekiro launch/terminate 与 rollback-restart smoke；
- `W-REL-F-SCALE-02`：真实文档完整有界访问与 Electron functional smoke；
- `W-BEHAVIOR-MAP-01`：script 容器 magic/reference inventory smoke（行内已标注 `validation-unfrozen`，此处补齐清单登记）；

`W-SCRIPT-READONLY-01` 的 script 整内层文件替换真实容器验证已冻结为：

~~~text
script        npm run test:script-container-replace（本机环境注入时读取真实 luabnd）；npm run test:script-container-evidence（真实分支传入 luabnd 路径时）
fixture       仓库外 luabnd-primary（mods/script/aicommon.luabnd.dcx，DCX-DFLT->BND4，301 条目）；真实内层 .lua 条目
assertion     复制真实 luabnd 到临时 overlay；Bridge native write-bnd4 整内层替换（用户提供字节，等长 marker）→ PatchIR container_child_replace → WorkspaceTransaction 提交 → 重读条目数不变且内容更新 → operation 回滚与原文件字节一致；原 Mod 未被触碰；证据投影枚举 301 条目并分类 .lua 为 lua-bytecode
exitSemantics 命令须 exit 0 且真实容器实际执行；synthetic 分支 20 case 无条件运行；只支持容器级枚举/整内层替换闭环的 candidate，不证明脚本语义、反编译、重编译、typed mutation 或游戏加载
~~~

`W-EMEVD-FMG-PARAM-03` 的 PARAM 字段级 mutation 专项验证已冻结为：

~~~text
script        npm run test:param-field-mutation；npm run test:paramdef-layout；npm run test:fmg-msb-ipc-contract；npm run test:param-msb-write-ipc-contract
fixture       ParamDefDocument 合成 definition（标量 + bitfield 共享字节）；runParamdefLayoutSmoke bitfield fixture；FMG add 四层接线静态断言源文件
assertion     applyParamFieldMutation 10 case：标量写入、bitfield 保留其他位、无效 base64/空行/行宽不匹配/字段不存在/越界结构化失败、源行不可变；EditorMutationKind 含 fmg_entry_add、contract fmg mutationKinds 含 fmg_entry_add、IPC/preload 类型含 add；param_field_set/applyParamFieldMutation IPC 通道接线 token
exitSemantics 四个命令均须 exit 0 且断言实际执行；只覆盖 TS 字段编码层与接线，不证明 Bridge 整行写入/真实 PARAM 文档/UI add 入口
~~~

`W-EMEVD-FULL-01` 的导入 EMEDF production 写链与真实 corpus 覆盖率交叉验证已冻结为：

~~~text
script        npm run test:emevd-imported-production；npm run test:emevd-imported-coverage
fixture       syntheticEmevdBytes.createSyntheticDs3EmedfJson（自构 DarkScript3 格式 JSON，非真实 DarkScript3 数据）；真实 `emevd-primary`（mods/event/common.emevd.dcx，1,730 events / 33,266 instructions）；真实 EMEDF 文件经 SOULFORGE_EMEDF_PATH（用户本机，缺失 fail-closed）
assertion     imported-production：3 合成 leg（成功链/回滚链/失败链）+ 真实 corpus 事件级 id/rest + 2000:0 InitializeEvent eventId typed mutation；vararg 尾逐字节保留、未知指令 opaque、vararg 尾参数写编译期拒绝（EMEVD_DSL_VARARG_ARG_READONLY）、回滚恢复原字节 + 审计 failure_recovery、错误 hash → EMEVD_STAGING_WRITE_FAILED 目标未触碰；imported-coverage：analyzeEmedfCoverage 对真实分布分类 clean/长度不匹配/unknown，长度签名一致
exitSemantics 两命令须 exit 0；合成 leg 无条件运行；真实 corpus leg 依赖 SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT，缺失结构化跳过；真实 EMEDF 文件 leg 依赖 SOULFORGE_EMEDF_PATH，缺失结构化跳过（不冒充已交叉验证）
~~~

`W-EMEVD-FULL-01` 的全 corpus typed-mutation 矩阵已冻结为：

~~~text
script        npm run test:emevd-corpus-matrix
fixture       合成 EMEVD（9 条指令：2× 0:0、5× 2000:0 覆盖 12/16/20/24/32、2 条 opaque 未知）；真实 `emevd-primary` common.emevd（33,266 指令 / 142 种）
assertion     合成 leg 5 个 typed arg/eventId mutation + 事件 id/rest 经 production 写链提交→Bridge 重读可观测、vararg 尾逐字节保留、opaque 指令字节保留；真实 leg：每个 schema 覆盖指令族 typed mutation 重读、全文档 33,266 条提交前后逐条字节比对（未覆盖 140 族 opaque 保持 30,081/30,081、covered-untouched 3,181/3,181）、未知指令双重 fail-closed（EMEDF_UNKNOWN_INSTRUCTION / EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY）、非法 vararg 长度结构化拒绝、事件级 id/rest mutation 重读可观测
exitSemantics 命令须 exit 0；合成 leg 无条件运行；真实 corpus leg 依赖本机 fixture env，缺失结构化跳过；typed mutation 只证明写链与等长替换，不证明参数语义或完整 EMEDF/layer/游戏加载
~~~

`W-EMEVD-FMG-PARAM-03` 的 FMG 引用完整性验证已冻结为：

~~~text
script        npm run test:fmg-reference-integrity；npm run test:param-metadata-native
fixture       真实 `fmg-primary` item.msgbnd（18 FMG/3,480 entries）与 `bnd4-primary` menu.msgbnd（15 FMG/22,638 entries）；真实 `param-primary` gameparam.parambnd.dcx（138 容器条目）
assertion     synthetic 段 6 类诊断各 1 例 + clean 容器 + 位置确定性 + 输入不可变；真实段容器级引用扫描（重复 id→error/越界→error/悬空→warning/resolved→info）、`<?tag@id?>`/`<?tag?>` 语法提取、上限 512；param-metadata-native 135 matched/3 expected-unsupported（真实 Bridge 结构化诊断）/readFailed=0
exitSemantics 两命令须 exit 0；native 段依赖本机 fixture env，缺失结构化跳过；只读诊断不开放写路径；引用语义不声明容器外 tag；FMG 多语言仅 zhocn 如实
~~~

`W-REL-B-CORPUS-02` 的 KRAK 组合 mutation 验证已冻结为：

~~~text
script        npm run test:krak-combination-mutation；npm run bridge:verify:dcx-documents
fixture       3 个登记 KRAK-BND4 样本（m00/m11 talkesdbnd、m10 mapbnd，共 25 entries）；Oodle runtime（本机合法）
assertion     18 组合 case（3 样本 × 6：rename/replace/delete/move/add 组合含 add 后链式 rename/replace）：write-bnd4 mutations 数组单次 repack+单次 Kraken 重压+单次重读→独立重读→回滚 sha256 与真实游戏文件一致（零写入原版）；未知字段保持（no-op roundtrip + mutation 后未触条目 flags/unknown/stored bytes 逐字节一致，header 未知区 0x18/0x30-3F）；dcx-documents 214 DCX（144 DFLT/70 KRAK read/3 KRAK-BND4 CRUD+字段保持/75 DFLT-BND4）
exitSemantics 两命令须 exit 0 且真实样本实际执行；只覆盖实际执行的登记 corpus 操作，不外推完整 corpus；KRAK 外层 DCX 重压必然改变字节，整体字节级比对只适用 BND4 payload 层
~~~

`W-A-RECOVERY-INTEGRATION-04` 的真实恢复验证已冻结为：

~~~text
script        npm run test:power-loss-recovery；npm run test:large-transaction-recovery；npm run test:cross-session-journal；npm run test:upgrade-recovery
fixture       真实 WorkspaceTransaction + SQLite journal + 真实备份；合成 800-op 大容量事务；四会话跨会话场景；旧版 SQLite 迁移 1..3→6
assertion     power-loss：3 个 SIGKILL 注入点（hook-kill/mid-replace/committed-then-kill）子进程真实事务+SQLite journal+真实备份，journal 重放一致、未完成回滚、已提交重读一致、temp 清理、幂等；large-transaction：800 op 成功链（committed/800 files/800 backups/重读全匹配）+四阶段失败关闭+大容量恢复+损坏失败关闭（corruption_blocked 且 journal 非终态）；cross-session：4 会话无丢失/无重复+跨会话回滚+崩溃发现与修复；upgrade：旧 1..3→新 6 checksum 保留、已提交数据/journal/recovery point/audit 保留、旧中断事务用旧备份恢复
exitSemantics 四命令须 exit 0；只作用于 SoulForge 自身进程与临时 overlay，不触碰原版游戏目录；恢复策略为回滚到 before，不自动重放/不 roll-forward；真实 installer NSIS 升级生命周期仍环境门控
~~~

`W-BEHAVIOR-MAP-01` 的 script 容器 inventory 验证已冻结为：

~~~text
script        npm run test:script-container-evidence（真实 leg 依赖本机 fixture env）；npm run probe:behavior-headers（依赖 SOULFORGE_SEKIRO_GAME_ROOT，缺失失败关闭）
fixture       仓库外 luabnd-primary = mods/script/aicommon.luabnd.dcx（DCX-DFLT->BND4，301 条目：299 .lua + 1 .luagnl + 1 .luainfo）
assertion     36 合成 case 无条件（分类/`\x1bLuaP`/`\x1bLuaQ` 家族 magic/文本 lua 诚实语义/`sanitizeEntryName` 确定性）；真实 301 条目枚举、扩展名分布、256 采样截断、magic 11/12 命中 `\x1bLuaP`、文本 goal_list.lua magicVerified=false 如实、条目名脱敏无绝对路径/无 INTERROOT_win64
exitSemantics 命令须 exit 0 且断言实际执行；真实 leg 缺环境结构化 skipped；只支持容器级枚举与字节码格式识别（candidate），不证明脚本语义、反编译、重编译、typed mutation 或游戏加载；真实 magic 为 `\x1bLuaP`（0x50）
~~~

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
| emedf adapter | external-only DarkScript3 EMEDF JSON 导入、类型码映射、vararg 支持与验证 |
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

<!-- SOULFORGE_PROJECTION_BEGIN:command-index -->

全部 122 条已登记验证命令按层级列出。层级顺序即执行顺序（先快后慢，早失败早停）。

一次跑完某一层：`node scripts/verify.mjs --tier <层级>`；跑全部：`npm run verify:all`。

**governance**（16 条）

~~~powershell
npm run handoff:fingerprint
npm run test:gov-cli
npm run test:governance
npm run test:governance-data-fixtures
npm run test:governance-equivalence
npm run test:handoff-integrity
npm run test:handoff-integrity:fixtures
npm run test:handoff-projection
npm run test:orphan-smoke-gate
npm run test:release-scope
npm run test:release-scope-fixtures
npm run test:release-scope-proposal
npm run test:smoke-temp-cleanup
npm run test:v06-deferral-index
npm run test:verify-entrypoint
npm run verify:audit
~~~

**unit**（34 条）

~~~powershell
npm run test
npm run test:ai-conformance
npm run test:ai-fake-loop
npm run test:core-journal-wiring
npm run test:database-utility
npm run test:desktop-security
npm run test:editor-document-store
npm run test:editor-mutation-service
npm run test:emedf-schema
npm run test:emevd-dsl-compiler
npm run test:emevd-envelope-map
npm run test:emevd-external-adapter
npm run test:emevd-four-view
npm run test:emevd-ipc-contract
npm run test:emevd-plan-commit
npm run test:fmg-msb-ipc-contract
npm run test:hex-scene
npm run test:me3-runtime-adapter
npm run test:me3-runtime-gateway
npm run test:model-service-configuration
npm run test:model-service-vault-contract
npm run test:openai-responses
npm run test:param-msb-write-ipc-contract
npm run test:performance-baseline
npm run test:resource-index-diagnostics
npm run test:scene-asset-inventory
npm run test:scene-draw-list
npm run test:subprocess-control
npm run test:three-scene-module
npm run test:ui-localization
npm run test:vault-encrypt-contract
npm run test:vault-ipc-contract
npm run test:workbench-projections
npm run typecheck
~~~

**synthetic**（31 条）

~~~powershell
npm run bridge:build
npm run bridge:verify:client
npm run bridge:verify:crash
npm run bridge:verify:daemon
npm run bridge:verify:synthetic
npm run test:asset-import
npm run test:asset-writeback
npm run test:bridge-recovery-harness
npm run test:bridge-staging
npm run test:cross-session-journal
npm run test:dds-convert-writeback
npm run test:desktop-contract-mutations
npm run test:desktop-ipc-contract
npm run test:desktop-live-editor-contract
npm run test:editor-bounded-access
npm run test:emevd-coverage
npm run test:emevd-full-document
npm run test:emevd-plan-production
npm run test:flver-candidate
npm run test:large-transaction-recovery
npm run test:param-field-mutation
npm run test:param-metadata-mismatch
npm run test:paramdef-layout
npm run test:power-loss-recovery
npm run test:release-corpus-registry
npm run test:release-editor-acceptance
npm run test:smithbox-param-metadata-source
npm run test:sqlite-crash-recovery
npm run test:standalone-writer-failure-matrix
npm run test:upgrade-recovery
npm run test:writer-failure-matrix
~~~

**native**（32 条）

~~~powershell
npm run bridge:verify:bnd4-transaction
npm run bridge:verify:bnd4-writer
npm run bridge:verify:dcx-documents
npm run bridge:verify:emevd
npm run bridge:verify:esd
npm run bridge:verify:flver
npm run bridge:verify:flver-glb
npm run bridge:verify:flver-mesh
npm run bridge:verify:fmg
npm run bridge:verify:msb
npm run bridge:verify:oodle
npm run bridge:verify:param
npm run bridge:verify:tae
npm run bridge:verify:tpf
npm run probe:behavior-headers
npm run test:bridge-exit-hygiene
npm run test:emevd-corpus-matrix
npm run test:emevd-imported-coverage
npm run test:emevd-imported-production
npm run test:emevd-multi-corpus-matrix
npm run test:fmg-reference-integrity
npm run test:krak-combination-mutation
npm run test:native-corpus-writeback
npm run test:native-preview
npm run test:native-writer-failure-matrix
npm run test:param-duplicate-native
npm run test:param-field-write-matrix
npm run test:param-metadata-native
npm run test:private-native-gate
npm run test:script-container-evidence
npm run test:script-container-replace
npm run test:section28-sekiro-gate
~~~

**release**（9 条）

~~~powershell
npm run build
npm run release:installer:manifest
npm run release:manifest
npm run test:installer-lifecycle
npm run test:portable-packaging-config-fixtures
npm run test:portable-packaging-gate
npm run test:release-compliance-fixtures
npm run test:release-content
npm run test:release-reproducible
~~~

另有 22 条 script 显式排除在验证调度之外（写入命令、外部工具或入口自身）：

- `verify`：统一验证入口本身，自调度会无限递归
- `verify:all`：同上（全层级别名）
- `verify:list`：同上（只列计划，不是验证）
- `dev`：交互式开发服务器，不是验证
- `bridge:publish`：发布产物构建，由 release 链按需调用
- `corpus:build-local-release`：生成本机 corpus registry，写 testdata，不是验证
- `corpus:build-local-release:configured`：同上（被 wrapper 调用的内层）
- `codexpro:doctor`：外部工具集成，与本仓库验证无关
- `codexpro:setup`：外部工具集成
- `codexpro:start`：外部工具集成
- `codexpro:start:agent`：外部工具集成
- `codexpro:start:handoff`：外部工具集成
- `codexpro:pro-bundle`：外部工具集成
- `gov`：治理写入 CLI，不是验证；正确性由 test:gov-cli 门禁
- `gov:next`：同上（只读子命令，但仍属操作入口）
- `gov:status`：同上
- `gov:claim`：同上（会改 lifecycle 与 activeClaims）
- `gov:heartbeat`：同上
- `gov:release`：同上
- `gov:complete`：同上
- `gov:seal`：同上（追加 Evidence、挂 Gate 引用并重新投影交接书，三步原子写）
- `handoff:project`：交接书投影写入命令，不是验证；只读校验由 test:handoff-projection 承担

<!-- SOULFORGE_PROJECTION_END:command-index -->

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
| C EMEVD | `bridge:verify:emevd`、`test:emevd-dsl-compiler`、`test:emedf-schema`、`test:emevd-four-view`、`test:emevd-ipc-contract`、`test:emevd-plan-commit`、`test:emevd-plan-production`、`test:emevd-coverage`、`test:emevd-full-document` | 已覆盖 header/event/instruction/args/mutation、稳定 anchor、DSL parse/typecheck/plan、UI 协议，以及 DSL plan → Bridge batch → PatchIR transaction 的 production 接线（stage/commit/re-read/rollback，合成 + 真实 common.emevd 事件级 mutation）；真实 corpus 指令分布（142 种/33,266 条）与 EMEDF 覆盖长度一致性分析（fixture 覆盖 1 种、2000:0 多长度变体如实报告）；DSL 顶层 instruction 块（全局指令级 typed mutation：跨事件引用 + 与事件内写法计划操作等价 + 跨作用域重复写拦截）；完整文档分页组装（分页读取连续性/总数/事件切片校验、DCX 直读解压产物复用，真实 1,730 events / 33,266 指令 / 34 页）与四视图 DSL 提交 UI 接线（main 权威完整文档缓存、renderer 仅编辑 DSL 文本、提交前 fresh 重读 + production 写链提交）；DSL control-flow validation schema 驱动通用化（事件 ID 引用不再硬编码 2000:0，条件组一致性 warning-only 检查） | layer 变体、完整 EMEDF 类型布局/真实导入 EMEDF 交叉验证、游戏加载；分布只有长度签名，不构成参数类型声明 |
| C MSB | `bridge:verify:msb`、`test:fmg-msb-ipc-contract`、`test:param-msb-write-ipc-contract` | 已覆盖 model/part/region/event 和 transform mutation；`set_part_transform` 重读验证（真实 m11：rotX/scaleX/scaleY/scaleZ 核对，part 数不变） | 全实体 CRUD、引用修复、完整场景 |
| D 行为/动画 | `bridge:verify:tae`、`bridge:verify:esd`、`test:script-container-evidence`、`test:script-container-replace` | 登记样本的 TAE/ESD native document 结构与只读投影；script 容器条目枚举 + `\x1bLuaQ` 字节码识别（合成 20 case + 真实 luabnd 301 条目/64 样本分类）；真实 luabnd 整内层文件替换写/重读/回滚闭环（`test:script-container-replace`） | 全布局、完整事件/状态语义、HKX/脚本引用、typed mutation、反编译/重编译、游戏加载 |
| E/I 资产渲染 | `bridge:verify:flver`、`bridge:verify:flver-mesh`、`bridge:verify:flver-glb`、`bridge:verify:tpf`、`test:scene-draw-list`、`test:three-scene-module` | 登记 FLVER/TPF native document、FLVER mesh/GLB 开放格式导出、semantic render packet 与 renderer contract | MTD/collision/navigation、完整材质/纹理关联、native writer、所有者机器完整 fallback/resource lifecycle、游戏加载 |
| F 专业编辑器 | `test:editor-document-store`、`test:hex-scene`、`test:desktop-live-editor-contract`、`test:release-editor-acceptance`、`test:ui-localization`、`test:emevd-full-document`、`test:emevd-dsl-compiler` | document/revision/IPC/静态本地化契约；冻结五项 inventory（bnd4/fmg/param/emevd/script）、只读 Hex、FLVER 排除、无量化门槛的完整有界访问 schema 与失败关闭；EMEVD 规模访问 `pagination`（分页组装、DSL 模板行数截断 + 完整模板按需加载、事件列表分页，`currentScaleContractGaps` 不含 EMEVD）；script 只读证据面板、BND4 工作台与 ParamDefPanel 字段级编辑的 IPC/契约接线 | bnd4/script `scaleAccess=none`、fmg/param `bounded-window` 完整有界访问、TAE/ESD 写链、八个真实语义编辑器、真实 Electron 文档功能验收或 REL-F |
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

<!-- SOULFORGE_PROJECTION_BEGIN:evidence-index -->

| Evidence ID | 类型 | 能力/声明 | 基线 | 命令或记录 | 样本/范围 | 本轮结论与边界 |
|---|---|---|---|---|---|---|
| `EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER` | `sealed-current-run` | `scope-ruling:user-approved`；revalidates=`EV-AUTONOMOUS-GOVERNANCE-20260731`；将未自动覆盖的语义复核显式归属工程方 | HEAD=`481da6d2352802a5d18485ada2bb0d9b684695fe`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=6a23687b3dd25baf53e5ef270692faff05b78fa6c9b318c15975ee5781647ef4; fingerprintSha256=95439805b18406ce8bd56a977a3c9271c66f1001658794a0582e69a592f71c5b | `node --check scripts/verify-handoff-integrity.mjs`、`node scripts/verify-handoff-integrity-fixtures.mjs`（47 cases）与 `git diff --check` 均 exit 0；追加本记录后 `npm run test:release-scope`、`npm run test:handoff-integrity` 均 exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | handoff 输出字段为 `engineeringReviewStillRequired`、reviewOwner=engineering-agent、userActionRequired=false；旧字段只保留在历史 Evidence 叙述中，不再由当前门禁输出 | 只澄清工程复核责任并重验证未变化的冻结范围；不删除诚实性复核，不改变范围、authority、Gate 功能状态或 V0.5 完成状态 |
| `EV-AUTONOMOUS-GOVERNANCE-20260731` | `sealed-current-run` | `scope-ruling:user-approved`；revalidates=`EV-GOVERNANCE-RECONCILIATION-20260731`；在冻结范围 JSON 不变时，将 Evidence freshness、公开来源与许可证调查固定为工程自持 | HEAD=`c103e414ab92cb1dbe643572374aff90cc2b1373`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=ceb5fec39c891acb5b8192b2f5c3be661f42780adaea51ae446d01f2759353f7; fingerprintSha256=cbae6d0ba431401459606441a2c54c171912f4dfb25cf9af00fc90024f584b3d | `npm run test:release-scope-fixtures`（35 cases）、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`node scripts/verify-handoff-integrity-fixtures.mjs`（47 cases）、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 与 `git diff --check` 均 exit 0；追加本记录后 `npm run test:handoff-integrity` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | `REL-SCOPE` freshness 主题域只含唯一 BEGIN/END 范围 JSON、release-scope verifier/fixtures、handoff freshness verifier/fixtures 与指纹生成器；覆盖无关改动不失效、范围块或校验器改动失败关闭、不可验证历史失败关闭、无活动 blocker 禁止请求用户、非范围 Evidence 不得掩盖 stale scope ruling | 只支持治理规则和未变化范围的工程重验证；不改变 27 项支持/排除边界，不提升任何 parser/writer/runtime/render/release authority；未完成完整 EMEDF 类型 adapter，找不到合法来源时仍保持 opaque 与 partial/unsupported；不关闭任何功能 Gate，不声明 V0.5 完成或允许外部分发 |
| `EV-PUBLIC-20260720` | `unsealed-record` | 公开回归 | `2002076` + 当前工作树 | typecheck、test、bridge:verify:synthetic、build 均 exit 0 | 公开 synthetic、core smoke、Electron 43 utility build/smoke | 证明 2026-07-20 公开构建和测试观察；因基线未封存，不支持新的 authority 或 Gate 终态；不提升任何私有 native、真游戏或真模型服务 authority |
| `EV-A-SAFETY-20260720` | `unsealed-record` | A 路线公开安全/事务底座 | 同上 | `npm test` | junction/symlink 越界、after-commit 恢复、rollback hash 冲突、SQLite migration/journal/jobs、utility restart | 保留 A 路线公开验证观察；因基线未封存，不支持新的 authority 或 Gate 终态；真实断电、磁盘错误、全部 native writer 故障矩阵仍未验证 |
| `EV-PUBLIC-20260724` | `unsealed-record` | 当前公开回归 | `2002076` + 当前工作树 | `npm run test:handoff-integrity`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0 | 公开 synthetic、core smoke、Electron 43 utility build/smoke | 保留 2026-07-24 当前工作树公开构建和测试观察；因基线未封存，不支持新的 authority 或 Gate 终态 |
| `EV-PUBLIC-20260725` | `unsealed-record` | 发布合规改动后的公开回归 | `2002076` + 当前工作树 | 顺序运行 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0；最终 `npm run test:handoff-integrity`、`git diff --check` exit 0 | 公开 synthetic、core smoke、Electron 43 utility build/smoke；根 build 在 utility smoke 临时 bundle 后恢复 production out 并生成 compliance manifest | 保留本轮 native binding 路径、/Brepro、AI synthetic token 与发布脚本观察；因基线未封存，不支持新的 authority 或 Gate 终态；handoff 仍返回 `manualReviewStillRequired` |
| `EV-A-RECOVERY-20260724` | `unsealed-record` | 公共 writer 家族 + BND4 native writer 故障矩阵 | `2002076` + 当前工作树 | `npm run test:writer-failure-matrix`、`npm run test:native-writer-failure-matrix` exit 0 | text edit、text/binary file replace、raw range 共 16 cases；注册 chrbnd-primary 共 4 cases；均覆盖 stage / staged-output validate / backup-create commit / after-commit re-read | 保留 20 个 case 的结构化失败观察；因基线未封存，不支持新的 authority 或 Gate 终态；尚未覆盖四种语义格式 Bridge 进程中途崩溃 |
| `EV-B-KRAK-20260724` | `unsealed-record` | 合法 Oodle runtime 与注册 KRAK 解压 preview | `2002076` + 当前工作树 | 本机环境注入后 `npm run bridge:verify:oodle` exit 0 | 一个注册 DCX-KRAK fixture；runtime x64/version/export 校验与完整 preview 解压 | 保留 KRAK read preview partial 观察；因基线未封存，不支持新的 authority 或 Gate 终态；不证明发布 corpus、KRAK 重压、BND4 内层闭环或 writer |
| `EV-PRIVATE-20260724` | `unsealed-record` | 私有 native 汇总门禁 | `2002076` + 当前工作树 | 本机环境注入后 `npm run test:private-native-gate` exit 0，结构化状态 partial | EMEVD 1,730/33,266；FMG 18/18；PARAM 38/40；MSB 34 models / 4,500 parts / 1,089 regions / 46 events | 保留 EMEVD/FMG 通过、PARAM 2 个未覆盖布局和 MSB candidate 观察；因基线未封存，不支持新的 authority 或 Gate 终态；门禁不得汇总为全绿 |
| `EV-REL-COMPLIANCE-20260725` | `unsealed-record` | production 依赖许可证 inventory、发行输入内容安全与同机可复现构建 | `2002076` + 当前工作树 | `npm run test:release-compliance-fixtures`、`npm run build`、`npm run test:release-content`、`npm run test:release-reproducible`、`npm run test:portable-packaging-gate` 均 exit 0 | 170 个 production lockfile 依赖、9 种 allowlist expression；116 个依赖有已安装许可证正文、54 个 metadata-only；11 个实际 desktop out/package/native runtime 输入；6 类正/负 fixture | 保留同机 fingerprint 一致和内容扫描观察；因基线未封存，不支持新的 authority 或 Gate 终态；portable 仍为 ok=null/status=partial/dryPackStatus=skipped，不证明 notices、installer、签名或发布渠道 |
| `EV-REL-SCOPE-20260725` | `unsealed-record` | V0.5 支持范围提案结构与未裁定失败关闭语义 | `2002076` + 当前工作树 | `node scripts/verify-release-scope.mjs` --proposal exit 0；默认 `node scripts/verify-release-scope.mjs` 按预期 exit 1 | 27 个 scope items；显式 `gateCoverage` 覆盖 §18.1 全部 11 Gate；行为拆分 TAE/ESD/Lua-HKS，资产拆分 FLVER/TPF/MTD/collision/navigation/open conversion；§3.1 capability、§17.1 Evidence 与脱敏 registry 逻辑引用 | --proposal 输出 ok=null/status=proposal-valid/frozen=false；默认模式命中 RELEASE_SCOPE_NOT_FROZEN。build/ruling metadata 保持 pending/null；该证据只完成提案 artifact，不是用户裁定、sealed Evidence、`REL-SCOPE` 完成或任何功能 authority 提升 |
| `EV-REL-SCOPE-20260730` | `sealed-current-run` | `scope-ruling:user-approved`；V0.5 的 27 项目标范围、版本族、语义编辑边界与项目所有者内部测试发行边界 | HEAD=`e32e8144225ee904e38e87102470cf84bd428075`; trackedDiffSha256=c8a23dc5c209a71661a65ce34beb9fff975ce994e44191fb40b8fa202fac4d7e; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=8b521e3f1dce1a3bbf13a679e5fcf58594ba371c2d20eb98c1eb46d394c0ffe8; fingerprintSha256=9b907bbda822080f879c3aadf89171837edc0defb0f049382ee83fea1d743cba | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均 exit 0；连续两次 `npm run handoff:fingerprint` 输出一致；计划中的 progress-integrity 项因仓库未定义对应 script 而未执行 | 27/27 项 user-approved；§18.1 全部 11 Gate；file/product version major.minor=1.6 且其他版本失败关闭；BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script 八个语义编辑器；Hex 只读；仅项目所有者控制机器上的内部测试构建 | 仅支持 `REL-SCOPE` passed、`W-REL-SCOPE-RULING-01` completed 和其他 Gate `in-scope`；不提升任何 parser、writer、corpus、运行、渲染或发行 authority，不关闭技术、语料、Oodle、metadata、模型凭据、me3、签名、硬件或许可证 blocker，不声明 V0.5 完成或允许外部分发；`test:progress-integrity` 仍为工程缺口 |
| `EV-REL-SCOPE-20260730-UNSIGNED` | `sealed-current-run` | `scope-ruling:user-approved`；撤销代码签名验收项并冻结未签名 NSIS 内部测试边界 | HEAD=`7a6c35ca639bc19324892a86957b7151737d33f8`; trackedDiffSha256=0aad391a963c6503343a1b4b7f880874c7bd8e8f4f555430cae09cf92d2bb3bb; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=823ff9cae3df68c30982fbd3ed4bd3102c6ae2ba6d3a9b4b67c5572cd40bb0fc; fingerprintSha256=60d54c580c210c67160099dea5bc8e70b2b95dfcdd40078243adeca499fdf474 | `npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-content`、`npm run test:portable-packaging-config-fixtures`、`npm run test:portable-packaging-gate`、`npm run test:me3-runtime-adapter`、`npm run release:manifest` 均按各自声明的 exit/status 通过；连续两次 `npm run handoff:fingerprint` 输出一致 | 27/27 项继续 user-approved；release-scope 18 个正/负 fixture；Windows 10/11 x64 NSIS 允许未签名，仅限项目所有者控制的内部测试机器；仍要求 installer manifest/hash、内容扫描、干净机安装、升级、卸载和 runtime 完整性 | 仅支持 `W-REL-SCOPE-RULING-02` completed 与 `REL-SCOPE` passed 的当前裁定；代码签名、证书信任链和 SmartScreen 信誉均不再是 V0.5 验收项；portable、自动更新和外部分发仍 unsupported；不提升任何功能/发行 authority，不证明 NSIS、me3、`REL-H`、`REL-COMPLIANCE` 或 V0.5 完成 |
| `EV-REL-SCOPE-20260730-OWNER-INPUTS` | `sealed-current-run` | `scope-ruling:user-approved`；固定 Smithbox 本机 PARAM metadata 来源、空模型凭据、工程方 me3 provisioning 与功能性渲染验收边界 | HEAD=`3af0da8b5d061199e8d71e591d2b05ebc94a54c5`; trackedDiffSha256=331119d8ff4bba2da036c78ce2699c04f885dd22576ddb487e4594181bd163c3; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=a87629a5ea6ff6fecfe1fd133a3841ed37478d45722eaf28c170bac0e7d8c276; fingerprintSha256=96a01f57833a2c58e3b76a0d084854b0ac9327e94cf5f047d262ae0abe1618d5 | `npm run test:release-scope-fixtures`（25 cases）、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:param-metadata-mismatch`、`npm run test:paramdef-layout`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:me3-runtime-adapter`、`npm run test:scene-draw-list`、`npm run test:three-scene-module` 与 `git diff --check` 均 exit 0；官方 me3 0.12.1 Windows 便携包 SHA-256 匹配发布值，真实 CLI --version 与 profile --help exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | 27/27 项继续 user-approved；Smithbox 2.2.4 SDT PARAM 路径、commit/artifact digest 与仅本机导入/禁止随 SoulForge 再分发边界；provider 默认空配置且 live credential 非验收；me3 provisioning 归工程方；`REL-I` 只要求所有者当前机器功能闭环 | 只支持 `W-REL-SCOPE-RULING-03` completed 与 `REL-SCOPE` passed 的当前裁定；未导入或提交 Smithbox metadata，未实现来源 adapter，未使用真实 provider，未把真实 me3 接入 SoulForge gateway，也未启动 Sekiro 或执行渲染硬件 benchmark；不提升 PARAM/AI/runtime/render/发行 authority，不声明 V0.5 完成或允许外部分发 |
| `EV-OWNER-INPUTS-IMPLEMENTATION-20260730` | `sealed-current-run` | `scope-ruling:user-approved`；在不改变 27 项冻结范围的前提下落实固定 Smithbox 本机来源、脱敏 release corpus、模型空配置和 me3 production detection gateway | HEAD=`cc97cf4c9ef6ee5a1df03590e7401f9d3b264c3d`; trackedDiffSha256=bc4c03f3217eac6246521387ee8fe54cba02b41eee9582d85988f8e7bea33534; untrackedManifestSha256=7e2a375358fe119de1d0c3f7ef1ac67d6f04abc4567167bd4224ccf7542225aa; handoffSha256BeforeEvidenceAppend=f0bb60b8e3366bfd60273c12b1d3e7b89d8dccb79295ef0139abf6125c4c32f7; fingerprintSha256=af41a4e1b88790bed4fa0fca2c5d5b1e81dd9c2e1bc42d2ea2e7fbf3f54cf2f2 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:smithbox-param-metadata-source`、`npm run test:model-service-configuration`、`npm run test:ai-fake-loop`、`npm run test:openai-responses`、`npm run test:me3-runtime-gateway`、`npm run test:release-corpus-registry`、`npm run corpus:build-local-release`、`npm run bridge:verify:dcx-documents`、`npm run test:private-native-gate`、`npm run test:release-content`、`npm run test:release-compliance-fixtures`、`npm run test:release-reproducible`、npm audit --audit-level=moderate、`npm run test:handoff-integrity` 与 `git diff --check` 均按各自声明的 exit/status 通过；连续两次 `npm run handoff:fingerprint` 输出一致 | Smithbox 160 definitions / 7,028 fields / 124 annotations；模型配置 9 cases、零网络；真实 me3 0.12.1 probe 且未启动 Sekiro；214 个 DCX / 198 个唯一内容，144 DFLT、75 BND4、11,344 entries、70 KRAK reads；private native gate=partial，PARAM=38/40；172 个 production 依赖、117 license text present / 55 metadata-only、依赖审计 0 个已知漏洞 | 只支持固定本机 metadata source adapter 与 me3 detection 切片完成、已登记 corpus/恢复/PARAM/AI 的实际 partial 或 `fixture-confirmed` 边界，并重新封存既有 `REL-SCOPE` passed；不支持任何功能 Gate 通过，不证明 KRAK 重压/写回、全部 native 语义、八个编辑器、真实 provider、me3 profile/launch、Sekiro 会话、渲染闭环、installer/notices、外部分发或 V0.5 完成 |
| `EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS` | `sealed-current-run` | `scope-ruling:user-approved`；删除编辑器容量/延迟阈值和 installer 体积/启动/升级/回滚耗时预算，同时保留完整有界访问与 installer lifecycle 正确性门禁 | HEAD=`e31d62f4de06aa7107573fb38ce8af3458139854`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=a8b2f5846683b5e5a62373d522fecd31081fa98c65689a918f87b63e810cabb2; handoffSha256BeforeEvidenceAppend=b9ff6c5cad7c5d2269baad7d65963f16cc59eaefca8de816c685ad84b59174bd; fingerprintSha256=977fd253519f1a57865389cadcc595ffae7fe21f27029947132d0cd319311ff2 | `npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-content`、`npm run test:handoff-integrity` 与 `git diff --check` 均 exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | release-scope 31 个正/负 case；release editor acceptance schema 2；5 个当前 bounded-window/eager 访问缺口继续失败关闭；172 个 production 依赖中 123 个有许可证正文、0 个 metadata-only，release content 保持 partial | 只支持 `W-REL-SCOPE-RULING-04` completed 和 `REL-SCOPE` passed 的当前范围裁定；不提升任何 editor/native/installer authority，不证明 8 个语义编辑器、`REL-F`、`REL-H`、`REL-COMPLIANCE` 或 V0.5 完成，也不授权外部分发 |
| `EV-GOVERNANCE-RECONCILIATION-20260731` | `sealed-current-run` | `scope-ruling:user-approved`；在不改变 27 项冻结范围和 authority 上限的前提下，修正执行面板、production contract 导航、编辑器边界与 NSIS 配置的当前状态漂移 | HEAD=`25c123d845499183f4bd6addd254285d67943a44`; trackedDiffSha256=32175fbd60b18371155d77b43f26e76d00db671cb4c890d26a17cf53dca0d3f0; untrackedManifestSha256=0ed4a20d043abc6cebdf2c7b17049c92337ccb1ed9d36a65d8423e6bbcc04ea9; handoffSha256BeforeEvidenceAppend=4ca4a94cb496f61ecb2e97076cb35818d5d71c099a53279da92c5ed84ff9159e; fingerprintSha256=d35ac061ac1f9208e58b86c5a112de49fea592f872edc12d3ac54c4717318650 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-scope-fixtures`、`npm run test:release-scope-proposal`、`npm run test:release-scope`、`npm run test:release-editor-acceptance`、`node scripts/verify-handoff-integrity-fixtures.mjs`、`npm run test:release-compliance-fixtures`、`npm run test:portable-packaging-config-fixtures`、`npm run test:release-content`、`npm run test:desktop-security` 与 `git diff --check` 均 exit 0；`npm run test:portable-packaging-gate` 在 fresh build 后 exit 0 且保持 status=partial/dryPackStatus=skipped；追加本记录后 `npm run test:handoff-integrity` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | release-scope 35 个正/负 case；handoff 39 个正/负 case；发布编辑器 inventory 精确等于 BND4/FMG/PARAM/EMEVD/MSB/TAE/ESD/script；Hex 与 raw 渲染 IPC 不暴露 mutation/capability；electron-builder 仅保留 NSIS x64；me3、KRAK、PARAM、EMEVD、TAE/ESD、FLVER/TPF、AI 与 renderer 的执行面板/导航按既有实现证据统一 | 只支持本轮治理、当前地图和用户可见编辑边界修正，并重新封存既有 `REL-SCOPE` passed；未重跑私有 native corpus、Oodle、真实 me3/Sekiro、Electron 人机功能或 NSIS lifecycle，不提升任何 parser/writer/runtime/render/release authority，不关闭任何功能 Gate，不声明 V0.5 完成或允许外部分发；仓库未定义旧 `test:progress-integrity`，本轮没有恢复或冒充该历史 checklist validator |
| `EV-EMEVD-PATCHIR-20260731` | `sealed-current-run` | C-EMEVD DSL plan production 接线、writer 组合 mutation 修复、AI 写矩阵与 MTD/inventory Bridge 命令 | HEAD=`ea9d899144cebd7ed6b71006d376cb80ebbc9513`; trackedDiffSha256=920c8b4f14108911ae9f24736ff1fd3e0286213d3ccc6c97005399fdedbcaf91; untrackedManifestSha256=ac9858865ae974772cbd9131a87a8d401760f0c36a0355d9a9d11e9eb5e047b7; handoffSha256BeforeEvidenceAppend=b6867f2470012ee2bd8e2ee5faaa517a0e43a95907fc1f6f7f3b47ba2f3ca56d; fingerprintSha256=f34d229347b76468f40ca5f6149d7443debe05aedcc47cc1637e523a63eae9ff | `npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run test:emevd-plan-commit`（13 cases）、`npm run test:emevd-plan-production`（合成 3 + 真实 common.emevd 1，native 变体在本机环境注入下运行）、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view`、`npm run test:ai-conformance`（20 cases）均 exit 0；本机环境注入后 `npm run bridge:verify:emevd` exit 0（1,730 events / 33,266 instructions 回归含 GC add/delete） | `syntheticEmevdBytes` 合成 EMEVD（2 events / 3 instructions 含未知指令）；真实 emevd-primary common.emevd 事件级 id/rest typed mutation；AI scripted 本地 contract server 写矩阵；MTD 合成 XML 正/负（DTD 拒绝）与 inventory 单资源 case | 只支持 `W-EMEVD-PATCHIR-02` completed、C-EMEVD partial、AI 写矩阵 partial、MTD/inventory candidate 与 probe:behavior-headers 工具登记；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；当时旧全工作树 freshness 模型产生 stale，现已明确为工程治理维护而非用户 blocker |
| `EV-EMEVD-COVERAGE-20260731` | `sealed-current-run` | C-EMEVD 真实 corpus 指令分布提取与 EMEDF 覆盖分析基线 | HEAD=`3e05add3d836bb910487496342204fa68a257d31`; trackedDiffSha256=67106682572cb66fc7527c68550e5ff99ca2d88f89466269ac139f946c1d6b0c; untrackedManifestSha256=d50f178e8ce170d758a90d951b42dee1fe2d01f1bc49574c88c4541e28859e0c; handoffSha256BeforeEvidenceAppend=c3baa1f51603c2d60c8fe00be8b8f7b2f645dace3bff7d25bbbe4efa7712bf29; fingerprintSha256=0e3453f49c4ca1b4b194d18afa2bd50b570adc5b03d8cc7a7fbf3275634345d9 | `npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run test:emevd-coverage`（合成断言 5 组）均 exit 0；本机环境注入后 `npm run test:emevd-coverage` exit 0（真实 142 种/33,266 条分布 + 覆盖分析 + fixture 长度一致性）且 `npm run bridge:verify:emevd` exit 0（1,730 events 回归） | 真实 emevd-primary common.emevd 全量指令分布（bank/id → count + args 长度直方图，聚合脱敏、2,000 种上限未截断）；合成分布覆盖/未知/长度不匹配/空分布断言；fixture 三条指令的 corpus 出现与长度一致性检查 | 只支持 `W-EMEVD-FULL-01` 的分布提取与覆盖分析基线子推进（切片继续 ready/partial）；分布只有长度签名、不含参数类型，不构成完整 EMEDF schema 或类型覆盖声明；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；当时把 freshness 重封存错误留给用户，现已由主题域规则修正为工程自持 |
| `EV-EMEVD-GLOBAL-20260731` | `sealed-current-run` | C-EMEVD DSL 顶层 instruction 块：全局指令级 typed mutation | HEAD=`969dbe8f8839ad983da72c60b4350df808066755`; trackedDiffSha256=e1f1878292bef969cecc0bc0c0f7c2bbb7725499b672aa36fc3205174831f37d; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=7b588153d1d6614f27560fab8b83d5e32d795c431af32fed9bcd807f3b04a1fa; fingerprintSha256=8f5cf58a2751ebb361606e792d213a8dfe58b039229255488ce0b96176c1f18f | `npm run typecheck`、`npm test`、`npm run test:emevd-dsl-compiler`、`npm run test:emevd-four-view`、`npm run test:emevd-plan-commit`（13 cases）、`npm run test:emevd-plan-production` 均 exit 0 | 顶层 instruction 块 6 组断言：全局 mutation 生成、AST `topLevelInstructions`、与事件内写法计划操作逐字段等价、缺失锚点 ANCHOR_NOT_FOUND、未知指令只读、跨作用域重复写 DUPLICATE_ARGUMENT | 只支持 `W-EMEVD-FULL-01` 的 DSL 全局指令级 typed mutation 子推进（切片继续 ready/partial）；锚点身份与计划契约不变，`planFingerprint` 绑定源形状（顶层与事件内为不同 AST 形状）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；`REL-SCOPE` passed 的当前封存状态按外部治理提交与用户裁定为准 |
| `EV-EMEVD-FULLDOC-20260731` | `sealed-current-run` | C-EMEVD EMEVD 完整文档分页组装与四视图 DSL 提交 UI 接线 | HEAD=`f5d5674f85eb5eb9444c7edb76b0ea0ae704f0eb`; trackedDiffSha256=2a99af27dba46014c8a1a8bc876d2d07bead50b1038c69e16b0d5ece7587c719; untrackedManifestSha256=698e4a159c901e0cc98f6de359662380335b8c8ef736b9d4a053dbeaa3780344; handoffSha256BeforeEvidenceAppend=07bb6593247cca74f7991a3d9679db4c90e821cd8e0974c5e13e674fe7936e6b; fingerprintSha256=c083a06af5d26f28e7e7fa35a11966d51f4f23987cd18fe2285b5f8ccf85eed4 | `npm run typecheck`、`npm test`、`npm run bridge:build`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:emevd-full-document`（合成 + 本机环境注入真实 DCX 直读）、`npm run test:emevd-ipc-contract` 均 exit 0；追加本记录后 `npm run test:handoff-integrity` findings 为空 | 完整文档分页组装：合成（`pageSize` 2 → 2 页、事件切片、unknown 分类）与真实 emevd-primary common.emevd DCX 直读（1,730 events / 33,266 指令 / 34 页、`preparedSourcePath` 复用 staging 源、事件切片总数一致）；Bridge envelope 分页字段（instructionPage/instructionPageSize/instructionTotal/instructionPageCount/instructionsSampleTruncated）；desktop IPC 契约（resource.`readEmevdFullDocument` / resource.`submitEmevdDslPlan` / preload 两方法 / main `emevdFullDocuments` 权威缓存 / `renderEmevdPatchDsl` 模板） | 只支持 `W-EMEVD-FULL-01` 的完整文档分页组装与四视图 DSL 提交 UI 接线子推进（切片继续 ready/partial）；renderer 只编辑 DSL 文本，不持有完整文档；DSL 提交经 `submitEmevdDslPlanViaFourView` production 写链且提交前重读 fresh 文档；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；control-flow validation 与完整 EMEDF 类型布局仍属工程缺口 |
| `EV-EMEVD-SCALE-20260731` | `sealed-current-run` | EMEVD 编辑器规模访问 eager → pagination（硬约束 17 合规） | HEAD=`3de45a08e861118b0c3b6cd13e147c3d8783080c`; trackedDiffSha256=09a127f9f82d26947ebbd107dfa6aef449ef2beef9bd0773660ace2e766afcde; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=70e617acf5a1a47c68f328232c714d7672f9165ee281c6c6cfb95acb2e13447f; fingerprintSha256=4d5bab1ac13fbb9885e38b44589e58436a963d6a8509ff350a525633ebe30d91 | `npm run typecheck`、`npm test`、`npm run test:release-editor-acceptance`、`npm run test:emevd-dsl-compiler`（含 bounded 截断断言）、`npm run test:emevd-ipc-contract`、`npm run test:emevd-four-view`、本机环境注入后 `npm run test:emevd-full-document`（1730 events / 33,266 指令 / 34 页）均 exit 0；追加本记录后 `npm run test:handoff-integrity` findings 为空 | DSL 模板行数截断（renderEmevdPatchDslBounded：事件块边界截断 + 注释标记，截断模板编译为 no-op 空计划；无上限时完整渲染）；IPC `loadFullDslTemplate` 显式完整加载 + dslTemplateTruncated/`dslTemplateTotalLines` 报告；事件列表分页每页 200（flow/table 视图）；`editorCapabilityContract` emevd scaleAccess=pagination；`currentScaleContractGaps` 不再含 EMEVD（其余 7 个编辑器缺口如实保留） | 只支持 `W-REL-F-SCALE-02` 的 EMEVD 规模访问子推进（切片继续 ready/candidate）与 `W-EMEVD-FULL-01` 的分页接线延伸；pagination 只证明规模访问契约，不证明完整语义编辑、真实验收或任何 native authority 提升；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；`validation-unfrozen` 的真实文档完整有界访问与 Electron functional smoke 仍属工程项 |
| `EV-EMEVD-EMEDF-ADAPTER-20260801` | `unsealed-record` | C-EMEVD EMEDF schema vararg 支持、external-only adapter 与 desktop IPC 集成 | `49a800a` + 当前工作树 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:emevd-external-adapter`（32 合成 case）均 exit 0；真实 sekiro-common.`emedf.json` 导入 405 指令 / 27 bank / 2 vararg 通过 | EMEDF schema vararg（hasVararg/varargCount/EMEDF_VARARG_NOT_LAST）；external-only adapter（DarkScript3 JSON 格式，注释/尾随逗号兼容，类型码映射，名称 sanitize/去重）；registry resolver（外部路径 → fixture 回退）；desktop main IPC 三处集成（SOULFORGE_EMEDF_PATH 环境变量）；DarkScript3 许可证审计为 All Rights Reserved | 保留 EMEDF adapter partial 观察；因基线未封存，不支持新的 authority 或 Gate 终态；不证明 production typed mutation、完整 EMEDF 覆盖、control-flow 或游戏加载 |
| `EV-SCRIPT-EVIDENCE-20260801` | `unsealed-record` | D-BEHAVIOR / F-EDITORS Script 容器 production 证据投影与 IPC 接线 | `49a800a` + 当前工作树 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:script-container-evidence`（20 合成 case）均 exit 0 | `scriptContainerEvidence.ts`（条目枚举 + \`x1bLuaQ` 字节码识别 + LUAGNL/LUAINFO/ESD/HKX 分类）；inventory-asset-resources Bridge 命令 TS 类型注册；desktop main IPC resource.`scriptContainerEvidence` + preload 接线 | 保留 script 证据投影 candidate 观察；因基线未封存，不支持新的 authority 或 Gate 终态；不证明脚本语义、反编译、重编译、typed mutation、renderer 面板或游戏加载 |
| `EV-PARAM-BITFIELD-20260801` | `unsealed-record` | C-PARAM bitfield preserving writer 与字段级 mutation IPC 接线 | `49a800a` + 当前工作树 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:paramdef-layout`（含 4 个 bitfield 写入 case）均 exit 0 | `writeBitfield`() preserving bit writer（读取现有整数、清除目标位、设置新值、写回；支持 u8/s8/u16/s16/u32/s32/bool；范围验证）；`encodeFieldMutation`() 不再阻止 bitfield 写入；param_field_set mutation kind；`paramFieldMutation.ts` 核心辅助函数；desktop main IPC resource.`applyParamFieldMutation` + preload 接线 | 保留 PARAM bitfield writer 与字段级 IPC partial 观察；因基线未封存，不支持新的 authority 或 Gate 终态；不证明 UI 接线、PARAM 布局 32/33/81、引用验证或游戏加载 |
| `EV-FMGMSB-WRITE-20260731` | `sealed-current-run` | FMG add mutation 与 menu.msgbnd 第二语料读验证、MSB set_part_transform 重读验证、EMEVD writer 警告修复 | HEAD=`a90cfa711514e854e922c03534a749eabad04fa8`; trackedDiffSha256=eb6724598607c60c9a645df8da55f19b379eba90cbbe7e62df577aac5626b794; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=bd5432e62a4196bb3a9db5b4648a09cab0c6fa791da71803ae86cf19ce81bdb2; fingerprintSha256=be59a89476cc60be1f22dc4280a8061427ef6ddce927dbac171deec917ad8065 | `npm run typecheck`、`npm test`、`npm run bridge:build`（0 警告 0 错误）均 exit 0；本机环境注入后 `npm run bridge:verify:fmg`（add case + menu 15 子项 roundtrip）与 `npm run bridge:verify:msb`（transform case）exit 0；追加本记录后 `npm run test:handoff-integrity` findings 为空 | FMG add mutation：TS helper 补 add kind，真实 item.msgbnd 对不存在的 id `999999999` staged 写入 → Bridge 独立重读文本存在 → 原文件未受影响；menu.msgbnd（bnd4-primary）15 子项全部 FMG v2 semantic roundtrip（只读）；MSB set_part_transform：Bridge writer 补 rotX/scaleX/scaleY/`scaleZ` 重读核对，真实 m11 transform case（rotX=82.37612、scale [1.05, 1.1, 0.95]、part 数不变）；EmevdNativeWriter CS8629 警告修复（patch.NewEventId!.Value） | 只支持 `W-EMEVD-FMG-PARAM-03` 的 FMG add/menu 读与 MSB transform 验证子推进（切片继续 ready/partial）；FMG 全语言仍受本机 corpus 语言覆盖限制；capability contract 的 fmg `mutationKinds` 未声明 fmg_entry_add（无 UI 调用方，`editorAllowsMutation` 继续保守拒绝）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；PARAM 布局 32/33/81 与 MSB 全实体 CRUD 仍属工程缺口 |
| `EV-REL-SCOPE-20260731-TEXT-FIRST` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；V0.5 收窄为文本优先五编辑器，MSB/行为动画/资产线/渲染线共 12 项范围条目延期 V0.6 并保留为标记只读预览 | HEAD=`53a8e56415d4f02293b8f250b04d7dfff632a9ca`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=0aaa30ea4a0b19f1b9cccbc46bff94783f4645f073be0c826f415c8615d57048; handoffSha256BeforeEvidenceAppend=64392168ab4e10cc0dcd2c7bf324d6f7a455952f61c922d79c5be93ea038a48d; fingerprintSha256=3ef45cec2d47f8edc1688185349893edcb337b2d90b45b4f4ca48fbf337e512b | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-scope`、`npm run test:release-scope-fixtures`（47 cases）、`npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:handoff-integrity:fixtures`（55 cases）、`npm run test:v06-deferral-index` 与 `git diff --check` 均 exit 0；`npm run test:release-scope-proposal` 按既有约定输出 ok=null/status=proposal-valid 且 findings 为空、exit 0；`test:v06-deferral-index` 的 5 条负向路径（索引缺条目、目标版本不符、裁定 authority 被抬高、非声明句被删、权威侧新增预览编辑器未同步）经临时篡改逐一确认失败关闭，篡改后已按备份精确还原并复验；连续两次 `npm run handoff:fingerprint` 输出一致，且 `trackedDiffSha256` 为空树 hash（除本文外工作区无未提交跟踪改动）。本轮修改的 5 个范围治理主题文件（verify-release-`scope.mjs`、verify-release-scope-`fixtures.mjs`、handoff-integrity-`lib.mjs`、verify-handoff-`integrity.mjs`、verify-handoff-integrity-`fixtures.mjs`）与新增的 verify-v06-deferral-`index.mjs` 均已进入提交 `9ba03c3`，范围矩阵与 Gate/切片状态改动已进入 head 锚点提交 `53a8e56`，因此 freshness 成立；重封存后 `npm run test:handoff-integrity` findings 为空 | 27 项范围矩阵保持，其中 12 项裁定 proposedSupport=deferred + deferredToRelease=V0.6 且 operations=[]（`SCOPE-MSB`、`SCOPE-BEHAVIOR-ANIMATION`/TAE/ESD、`SCOPE-ASSETS`/FLVER/TPF/MTD/COLLISION/NAVIGATION/OPEN-CONVERSION、`SCOPE-RENDERING`）；发布编辑器 inventory 精确收窄为 BND4/FMG/PARAM/EMEVD/script，script 为 whole-inner-file-replacement（内层 \`x1bLuaQ` 编译字节码，V0.5 不反编译/不重编译），其余四项为 typed-mutation；`SCOPE-PARAM` 收窄为 gameparam，drawparam/gparam 延期；msb/tae/esd/flver 为延期只读预览且 countedAsReleaseEditor=false，写路径在 editorCapabilityContract.`releaseWriteEnabled`、@soulforge/shared 的 DEFERRED_PREVIEW_EDITOR_KINDS 与主进程 EDITOR_DEFERRED_TO_V06_READONLY 三层失败关闭；新增 deferred/`deferred-v0.6` Gate 状态与 deferred 切片 lifecycle 及配套不变量（DEFERRED_GATE_WITH_SUPPORTED_SCOPE、FULLY_DEFERRED_GATE_STATE_INVALID、GATE_DEFERRED_NONDEFERRED_SLICE、VALIDATION_UNFROZEN_SLICE_UNLISTED）；新增 §18.5 V0.6 延期承接索引（12 条目 + 2 Gate + 3 切片 + 4 预览编辑器）并由 `scripts/verify-v06-deferral-index.mjs` 对 4 个权威来源逐项双向校验、接入 `test:handoff-integrity` 链，索引不构成独立范围口径 | 只支持 `W-REL-SCOPE-RULING-05` completed、`REL-SCOPE` passed 的当前范围裁定，以及 `REL-E`/`REL-I` 的 deferred/`deferred-v0.6`；延期不等于完成，不关闭任何技术缺口，也不把 deferred 当作 passed、`scope-excluded` 或 completed；不提升任何 parser、writer、editor、AI、runtime、render 或发行 authority；未运行真实 Electron 人机功能验收、NSIS lifecycle、真实 Sekiro 会话、私有 native corpus 与 Oodle 回归、渲染硬件基准；MSB 既有 msb_set_part_transform 真实验证记录保留但本版写入关闭，V0.6 恢复须重新验证后才可翻回；不声明 V0.5 完成或允许外部分发 |
| `EV-HANDOFF-LIVENESS-20260725` | `sealed-current-run` | 交接推进活性治理、公开回归、`REL-B` registry/harness fixture 与 `REL-F` acceptance harness candidate | HEAD=`20020766506ea71d66d3b9b9ea867aa534aaa3a9`; trackedDiffSha256=4621e9898de5250b8d72d309af2396e2de00351fcefb760855cbeedd42440d5f; untrackedManifestSha256=f499f192e40be3b4f91cb01336478251435ad1789ef168aacfcdbd452f9c7c35; handoffSha256BeforeEvidenceAppend=313dbde91970b6d9a3bccb0bb244de3ce0f2a6ce44122560eebf6af625a562b2; fingerprintSha256=3067512cc0068ad13cf50011889a19c3104dc3a0d6b9b3cd7c76788ebe3e43c9 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:release-corpus-registry`、`npm run test:release-editor-acceptance`、`npm run test:handoff-integrity`、`git diff --check` 均 exit 0；`npm run bridge:build` exit 0；连续两次 `npm run handoff:fingerprint` 输出一致 | 38 个 handoff 正/负 fixture；公开 synthetic/core/Electron 回归；metadata-only corpus registry fixture；候选编辑器 inventory/contract harness；项目 wrapper 解析到 .NET SDK 10.0.301 | 只封存本轮治理机制和已列公开/harness 观察，并支持 `W-REL-B-REGISTRY-01` 的 `fixture-confirmed` 与 `W-REL-F-ACCEPT-01` 的 candidate 上限；不包含用户范围批准标记，不支持任何 Gate passed/`scope-excluded`，也不提升私有 native、真游戏、真实模型服务或发布 authority；`manualReviewStillRequired` 三项仍保留 |
| `EV-PUBLIC-CONTRACTS-20260725` | `sealed-current-run` | Bridge recovery/staging、PARAM metadata、me3 adapter、`REL-B` registry、`REL-F` acceptance 与发行失败关闭 contract | HEAD=`20020766506ea71d66d3b9b9ea867aa534aaa3a9`; trackedDiffSha256=4caed8aa7f2647304d9f22a19fbd10e3f07c914f6334a6970ecf4885de1d8fad; untrackedManifestSha256=32b6faf6d0e1e92ed25a93903a0154c7803f0f49c4d64875f7f27baa61093b64; handoffSha256BeforeEvidenceAppend=f67684684b8e703f433c3495051cab381b4045de43af157a1b005cc07c77d9d6; fingerprintSha256=a450562260693252e75d6d81226aff97b9a43f3eeb39ebf7fce573c78b210839 | 最低公开回归四命令均 exit 0；bridge:verify:client、`test:bridge-recovery-harness`、`test:bridge-staging`、`test:param-metadata-mismatch`、`test:paramdef-layout`、`test:me3-runtime-adapter`、`test:release-corpus-registry`、`test:release-editor-acceptance` 均 exit 0；发行六命令、portable/private/section-28 gate 均 exit 0；连续两次 handoff:fingerprint 一致 | recovery 四阶段/背压/竞态/重启与 11 个 staging 负例；PARAM 9 个 snapshot failure、64 MiB 总预算、256 diagnostics、3 个 immutable result；me3 22 类；`REL-B` 26 个负例；5 个候选编辑器；170 dependencies、116/54 license text、11 artifacts | 支持 A/PARAM/me3 contract 与 `REL-B` registry 的 `fixture-confirmed`、`REL-F` acceptance 的 candidate、发行合规的 partial；artifact=6f22d28bfae009057d57e5bcb64936721e17357cadd6ee4be562081d1b348f0a、manifest=48d8eda021e041d10464cd3f8e641ae23db1333ad760e4ca2708c57e5e2ff0af；portable=partial/skipped 且 builder 依赖缺失，private/section-28=skipped；不支持任何 Gate 终态、native corpus、真实 me3/Sekiro、人机验收、installer、签名、升级或更新声明 |
| `EV-B-DFLT-7BD` | `historical-record` | DFLT 已记录真实 corpus 往返 | `7bd354d` | 旧第 43 节“P1 安全清理执行器与 P2 真实 DFLT/BND4 文档推进”；bridge:verify:dcx-documents | 144 个 DFLT、两个实际变体 | 本轮未重跑私有 corpus；不得外推到新变体或发布全集 |
| `EV-B-BND4-7BD` | `historical-record` | DFLT 外层 BND4 browse/CRUD/repack/rollback | `7bd354d` | 旧第 43 节“P2 BND4 production staging writer 与五类事务闭环”等记录；bridge:verify:bnd4-writer、bridge:verify:bnd4-transaction | 75 个 DFLT-BND4、11,344 entries 的历史记录 | KRAK 内 corpus、新 flags/布局未覆盖；本轮未重跑私有 corpus |
| `EV-C-FMG-7BD` | `historical-record` | FMG v2 与 item.msgbnd 子项闭环 | `7bd354d` | 旧第 43 节 FMG/PARAM 记录；bridge:verify:fmg | item.msgbnd 18/18 子项历史记录 | 其他 msgbnd、语言、引用和游戏加载未验证 |
| `EV-C-PARAM-7BD` | `historical-record` | PARAM 紧凑布局 raw row 路线 | `7bd354d` | 旧第 43 节 FMG/PARAM、PARAM 复制记录；bridge:verify:param | 38/40 历史抽样；2 个旧 header-embedded type name 结构化 unsupported | Paramdex-compatible metadata、完整字段 writer 和全 corpus 未完成 |
| `EV-C-EMEVD-7BD` | `historical-record` | EMEVD header/event/instruction/args 与主要 mutation | `7bd354d` | 旧第 43 节 EMEVD 系列记录；bridge:verify:emevd | common.emevd 历史记录 1,730 events / 33,266 instructions，含变长 args、add/delete GC | `layerCount` != 0、完整 EMEDF、DSL、KRAK 和游戏加载未验证 |
| `EV-C-EMEVD-DSL-20260724` | `unsealed-record` | EMEVD DSL stable anchor、tokenizer/parser/AST、EMEDF typecheck 与 typed plan | `4d37861` + 当前合并工作树 | `npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-four-view`、`npm run bridge:build`、本机环境注入后 `npm run bridge:verify:emevd` 均 exit 0 | fixture EMEDF；规范 patch DSL no-op、typed id/rest/arg plan、revision/schema/document-instance 绑定；真实 common.emevd 1,730/33,266 的既有 mutation 回归 | 保留 DSL `fixture-confirmed` 观察；plan 未写二进制、未接 Bridge/PatchIR，完整 EMEDF/control-flow/layer/游戏加载仍未验证 |
| `EV-C-MSB-SCENE-20260724` | `unsealed-record` | MSB 四类实体 semantic scene / render packet 与 production bundle WebGL proxy | `2002076` + 当前工作树 | `npm run test:scene-draw-list`、`npm run test:three-scene-module`、`npm run test:scene-asset-inventory`、`npm run test:hex-scene`、本机环境注入后 `npm run bridge:verify:msb`、`npm run build` 均 exit 0；Playwright production bundle 桌面/390px 检查通过 | 私有 fixture registry 的 msb-primary（m11 标识，脱敏）：34 models / 4,500 parts / 1,089 regions / 46 events；Bridge preview 投影 208 entities / 128 drawable nodes；fixture 四类实体重排；1440x900 与 390x844 WebGL canvas | 保留 native identity/revision、路径隔离和 WebGL proxy 观察；该 registry 仅是开发期私有 fixture registry，不是 release corpus；因基线未封存，不支持新的 authority 或 Gate 终态；projection 仍 partial，不证明完整 MSB、FLVER、WebGPU 大地图性能或游戏加载 |
| `EV-C-MSB-7BD` | `historical-record` | MSB models/parts/POINT region 与 transform | `7bd354d` | 旧第 43 节 MSB 系列记录；bridge:verify:msb | m10 历史样本 models=34、parts=5,406 | 全实体、引用修复、完整 mutation、KRAK 与游戏加载未验证 |
| `EV-E-ASSET-7BD` | `historical-record` | 开放格式检测/staging、PatchIR file replace、最小 DDS、FLVER candidate | `7bd354d` | 旧第 43 节资产、DDS、scene inventory、FLVER candidate 记录；`test:asset-import`、`test:asset-writeback`、`test:dds-convert-writeback`、`test:flver-candidate` | synthetic/open-format fixture 与候选头部/mesh table | 不证明 FLVER vertex/index/material、TPF/MTD、native writer 或游戏加载 |
| `EV-F-EDITORS-7BD` | `historical-record` | EditorDocumentStore、Safe Hex、EMEVD/PARAM/FMG/MSB 桌面契约 | `7bd354d` | 旧第 43 节 editor/IPC/UI 系列记录；对应 test:*contract、test:*-four-view、`test:ui-localization` | fixture、静态契约和已有 native read/write IPC | 不证明完整 Electron 人机流程、规模化交互或所有编辑器均具备完整 native authority |
| `EV-G-FAKE-7BD` | `historical-record` | 双 provider fake tool loop | `7bd354d` | 旧第 43 节 AI 记录；`test:ai-fake-loop`、`test:openai-responses` | 本地 fake HTTP/SSE 与契约测试 | 本轮未重跑 AI 专项 smoke；真实 endpoint、凭据、限额和生产多步任务仍 unverified |
| `EV-H-GATES-7BD` | `historical-record` | private native / section-28 诚实门禁 | `7bd354d` | `test:private-native-gate`、`test:section28-sekiro-gate` 历史记录为 skipped | 当时缺合法本机 runtime | skipped 只证明门禁诚实；不证明 KRAK、游戏启动或发布 |
| `EV-I-RENDER-7BD` | `historical-record` | Three.js 代理场景、draw list 和 synthetic 性能基线 | `7bd354d` | 旧第 43 节 Three/scene/performance 记录；`test:scene-draw-list`、`test:three-scene-module`、`test:performance-baseline` | proxy geometry 与 synthetic scene | 不证明真实 FLVER、大地图 WebGPU/WebGL2 性能、显存预算或后端完成 |
| `EV-HANDOFF-20260721` | `unsealed-record` | handoff 一致性门禁（确定性静态子集） | `2002076` + 当前工作树 | `npm run test:handoff-integrity` exit 0；临时畸形样本负向测试 exit 1 且命中断链/重复EV/未定义EV/缺失script/敏感内容 | markdown 链接、Evidence ID 唯一与引用、npm run 脚本名存在性、交接书敏感内容四类 | 保留旧版静态门禁运行观察；因基线未封存，不支持新的 authority 或 Gate 终态；第 13.3 节 `manualReviewStillRequired` 语义项仍靠人工审查 |
| `EV-V05-PARALLEL-SLICES-20260801` | `sealed-current-run` | C-EMEVD control-flow schema 驱动通用化、C-FMG/C-PARAM 写链接线与专项 smoke、F-EDITORS script/BND4/ParamDef 前端工作台、D-BEHAVIOR script 容器真实替换闭环 | HEAD=`06df4968fde120f650d83639a74f2cbe0db06ab2`; trackedDiffSha256=0975a19169865fc146f4187257a7d30cca1922f34ac97c2c15e669b04e18b0a7; untrackedManifestSha256=3cd9ff83f5e48026b4acba34dfb8848cb811fa1dc12e7ccd1a9456cff9d0c272; handoffSha256BeforeEvidenceAppend=a2ba9a5303d6fb1fb4216dc1781c9970b762ca89e9e3592165db902f8d875ff7; fingerprintSha256=b79bd156aaddcbd6f8e4a8542118a9bdbff23f78a8b8593473048d95a4657a69 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity` 均 exit 0；`npm run bridge:build`（0 警告 0 错误）；本机环境注入后 `npm run bridge:verify:fmg`（含 add case + menu 15 子项）、`npm run bridge:verify:emevd`（1,730 events / 33,266 instructions 含 GC）、`npm run test:emevd-plan-production`、`npm run test:script-container-replace`（真实 luabnd 整内层替换/重读/回滚）、`npm run test:script-container-evidence`（真实 luabnd 301 条目/64 样本 lua-bytecode 分类）均 exit 0 | 三个并行 subagent 子推进 + 主 Agent 集成：`dslCompiler` 通用事件 ID/条件组引用 helper 与两个新 warning 码；FMG fmg_entry_add 四层接线（shared union + capability contract + IPC + preload）+ `runParamFieldMutationSmoke`（10 case）+ IPC contract 断言；ScriptContainerPanel/Bnd4WorkbenchPanel/ParamDefPanel 前端接线（renderer-safe DTO 放 shared，preload `stripPathFields` 剥离绝对路径）；`scriptContainerEvidence` 补读 Bridge `sampleEntries` 修复真实容器枚举断链；`runNativeScriptContainerReplaceSmoke`（`test:script-container-replace`）真实 luabnd 替换/重读/回滚字节一致 | 只支持 `W-EMEVD-FULL-01` 的 control-flow 通用化、`W-EMEVD-FMG-PARAM-03` 的 FMG add 接线 + PARAM 字段级 smoke、`W-SCRIPT-READONLY-01` 的 renderer 面板 + 真实容器替换闭环、`W-REL-F-SCALE-02` 的 BND4/script/ParamDef 工作台接线子推进（各切片继续 ready，authority 上限不变）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；PARAM native smoke 在基线与本轮均失败（Bridge 端 Operation is not valid 读 ActionGuideParam，属既有问题，非本次引入）；fmg_entry_add UI 入口与 bnd4/script scaleAccess=none 有界访问仍属工程缺口 |
| `EV-V05-PARALLEL-TEAMS-20260801` | `sealed-current-run` | C-EMEVD 导入 EMEDF 驱动 production 写链与真实 corpus 覆盖率交叉验证；C-PARAM/C-FMG 全 ParamType 字段写覆盖与 FMG add 真实 native 验证；`REL-F` bnd4/fmg/param release-safe pagination | HEAD=`7b591cd32869ad45dfb0c0d6c1e110f28ea737d5`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=f3e158e4c0aa48fec6ba493a524c92b37a26bb3162a711679d615cbc906368f3; fingerprintSha256=071794368adf97833ae01a20b0b5526eac9c5380a908f99a609c8d81fd9bfe57 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-coverage`、`npm run test:emevd-external-adapter`（32 合成 case）、`npm run test:emevd-imported-coverage`、`npm run test:emevd-imported-production`、`npm run test:emevd-plan-production`、`npm run test:emevd-full-document`、`npm run test:emevd-ipc-contract`、`npm run test:param-field-mutation`、`npm run test:paramdef-layout`、`npm run test:param-metadata-mismatch`、`npm run test:param-metadata-native`、`npm run bridge:verify:param`、`npm run bridge:verify:fmg`、`npm run test:fmg-msb-ipc-contract`、`npm run test:param-msb-write-ipc-contract`、`npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract` 均 exit 0；native 命令在本机环境注入（SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT）下运行；真实 EMEDF 文件（SOULFORGE_EMEDF_PATH）缺失时 imported-production/coverage 的真实 EMEDF leg 结构化跳过（fail-closed），不冒充已交叉验证 | 三个并行 subagent 切片推进 + 主 Agent 集成提交（`5ab295b`/`9367ba7`/`7b591cd`）：EMEVD imported-production 3 合成 leg（成功/回滚/失败）+ 真实 common.emevd（emevd-primary，33,266 指令）事件级 id/rest + 2000:0 InitializeEvent `eventId` typed mutation，vararg 尾逐字节保留、未知指令 opaque、vararg 尾参数写编译期拒绝（EMEVD_DSL_VARARG_ARG_READONLY）、回滚恢复原字节 + 审计 failure_recovery、错误 hash → EMEVD_STAGING_WRITE_FAILED 目标未触碰；imported-coverage 对真实 142 种/33,266 条分布分类 clean/长度不匹配/unknown；PARAM `writeBitfield` BigInt 化修复 bitWidth≥31 溢出、位域扩展 u8/s8/u16/s16/u32/s32/bool，`runParamFieldMutationSmoke` 全类型正/负/边界，bridge:verify:param 真实 gameparam 字段级 set 重读字节一致 + 源行不可变；bridge:verify:fmg 真实 item.msgbnd add staged 写 → 重读 → 清理（zhocn-only）；bnd4/fmg/param `scaleAccess` 升级 pagination（listContainerChildrenPage/readFmgPage/`readParamPage` 主进程分页通道 + renderer 按页导航），`currentScaleContractGaps` 仅剩 script | 只支持 `W-EMEVD-FULL-01` 的导入 EMEDF production/coverage 子推进、`W-EMEVD-FMG-PARAM-03` 的全 ParamType 写覆盖 + FMG add native 验证子推进、`W-REL-F-SCALE-02` 的 bnd4/fmg/param pagination 子推进（各切片继续 ready，authority 上限不变）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；真实 DarkScript3 EMEDF 文件交叉验证仍 `validation-unfrozen`（环境门控）；script scaleAccess=none 仍为真实缺口；未运行真实 Electron 人机功能验收、NSIS lifecycle、真实 Sekiro 会话、Oodle 或完整私有 corpus 写回；FMG 多语言仅 zhocn |
| `EV-V05-FLEET-20260801` | `sealed-current-run` | 8 个并行切片推进：C-EMEVD 全 corpus typed-mutation 矩阵；C-FMG/C-PARAM 引用完整性 + 旧布局真实诊断；`REL-F` script pagination（scale gaps=[]）；G-AGENT Context Broker + conformance 28 case；A-RECOVERY 真实断电/大容量/跨会话/升级恢复；`REL-B` KRAK 组合 mutation + 未知字段保持；`REL-COMPLIANCE` installer lifecycle/package tree/manifest-hash；D-BEHAVIOR script 容器 inventory 冻结（\`x1bLuaP` magic 修正） | HEAD=`d22a336e98715baffbddc0939c9f97339c7bd753`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=5340071a8ca66632b3a4c8b2094d14956e33873f7ec0e793b8ddc7447483e198; fingerprintSha256=7387f75052697ad7f6c7bc316b2875a9e5126c980439964a068bf11b20434c85 | `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:ai-conformance`（28/28）、`npm run test:ai-fake-loop`、`npm run test:model-service-configuration`、`npm run test:openai-responses`、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:emevd-imported-production`、`npm run test:emevd-imported-coverage`、`npm run test:emevd-corpus-matrix`、`npm run test:emevd-plan-production`、`npm run test:emevd-full-document`、`npm run test:emevd-ipc-contract`、`npm run test:param-field-mutation`、`npm run test:paramdef-layout`、`npm run test:param-metadata-mismatch`、`npm run test:param-metadata-native`、`npm run test:fmg-reference-integrity`、`npm run bridge:verify:param`、`npm run bridge:verify:fmg`、`npm run test:fmg-msb-ipc-contract`、`npm run test:param-msb-write-ipc-contract`、`npm run test:smithbox-param-metadata-source`、`npm run test:release-editor-acceptance`（gaps=[]）、`npm run test:desktop-live-editor-contract`、`npm run test:writer-failure-matrix`、`npm run test:bridge-recovery-harness`、`npm run test:bridge-staging`、`npm run test:power-loss-recovery`、`npm run test:large-transaction-recovery`、`npm run test:cross-session-journal`、`npm run test:upgrade-recovery`、`npm run test:sqlite-crash-recovery`、`npm run test:native-writer-failure-matrix`、`npm run test:standalone-writer-failure-matrix`、`npm run bridge:build`、`npm run bridge:verify:oodle`、`npm run bridge:verify:dcx-documents`、`npm run test:krak-combination-mutation`、`npm run test:script-container-replace`、`npm run test:script-container-evidence`、`npm run probe:behavior-headers`、`npm run release:manifest`、`npm run test:release-content`、`npm run test:release-compliance-fixtures`、`npm run test:portable-packaging-config-fixtures`、`npm run release:installer:manifest` 均 exit 0；NSIS 构建与 SOULFORGE_INSTALLER_LIFECYCLE_RUN=1 lifecycle（临时目标安装→升级→卸载→干净→清理）exit 0；native 命令在本机环境注入下运行 | 8 个并行 subagent 切片推进 + 协调者集成提交（`4124bca`/`101dc39`/`c7ca5b5`/`d4cc013`/`cef9606`/`191cfbb`/`0452f1f`/`6f0dcd3`）：EMEVD corpus-matrix（真实 33,266 指令/142 种：2 kind 可 mutate、140 kind opaque 30,081/30,081 字节保持、未知指令双重 fail-closed、vararg 长度签名区分）；FMG 引用完整性（真实 item 353 引用/1 重复 id error、menu 220 引用/1 重复 id error——原版数据只读呈现）+ PARAM 3 旧布局真实 Bridge 诊断；script pagination（listScriptContainerEntriesPage，currentScaleContractGaps=[]）；Context Broker（五类证据受限脱敏有界装配、insufficient_evidence/CONTEXT_LIMIT_EXCEEDED/CANCELLED/TIMEOUT、`agentLoop` 集成 + `contextAssemblies` 审计、零网络）+ conformance 28 case；真实断电（3 SIGKILL 注入点）/大容量（800 op）/跨会话（4 会话）/升级（迁移 1..3→6）恢复 + `recoveryRepair` 幂等 + journal 阶段序列根因修复；KRAK 18 组合 case + VerifyFieldPreservation/ComparePreservation 未知字段保持；installer lifecycle harness + package tree（asar 1668/1668）+ manifest/hash 链；script 容器 inventory 冻结（真实 luabnd 301 条目/magic 11/12 \x1bLuaP/`sanitizeEntryName` 脱敏） | 只支持上述 8 个切片的子推进（各切片继续 ready，authority 上限不变：EMEVD/param-fmg/recovery/installer=partial、editor-scale/behavior=candidate、KRAK=`native-verified` 只覆盖实际执行 case）；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；真实 DarkScript3 EMEDF 文件交叉验证仍 `validation-unfrozen`（SOULFORGE_EMEDF_PATH 缺失）；未运行真实 Electron 人机功能验收、真实 Sekiro 会话、跨机/远程 CI 复现；installer lifecycle 只在本机临时目标目录执行；FMG 多语言仅 zhocn；`test:release-reproducible` 因并行团队 WIP TS 错误不可复现（非确定性，非本批引入）；SqliteOperationLogStore 核心未实现 createTransaction/`transitionTransaction`（journal 全阶段仅桌面路径） |
| `EV-REL-SCOPE-20260801-GOVERNANCE-JSON` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260731-TEXT-FIRST`；工程侧重封存：治理数据外化为 `docs/governance`/*.json 并把门禁切到 JSON 权威，范围裁定语义未变，不构成新的范围裁定 | HEAD=`80f1da0df2e0de5efc2dc75c4bb219f68d2f299d`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=c94c17f6d3b79acb94552e7ecf1c29725c2ded9f45531b60248d8c3a276a01a7; fingerprintSha256=a1d85374ab60534f93eadd2aa502c205d9cb2dc38401a68a2a6d9704ecfd4795 | `npm run typecheck`、`npm test`、`npm run test:release-scope`、`npm run test:release-scope-fixtures`、`npm run test:handoff-integrity:fixtures`（55 cases）、`git diff --check` 均 exit 0；`node scripts/verify-governance-data-fixtures.mjs` exit 0（21/21 负向 fixture 按预期拦截：schema 5、治理语义 10、跨版本冻结 4、`targetRelease` 1、洁净基线 1），运行后 `git diff --stat` `docs/governance`/ 为空证明篡改已还原；`node scripts/verify-governance-equivalence.mjs` exit 0（92 个 markdown finding code 全部由 JSON 门禁产出或在 SCHEMA_SUPERSEDED 显式登记取代机制共 18 项，jsonCodes=86，且真实数据上两套门禁 error code 多重集一致，findings 两侧均为空）；ajv 8.20.0 对 7 个治理文件逐一 schema 校验通过（含 `evidence.jsonl` 逐行校验）；治理数据迁移做过 1571 项字段级往返核对 failures=0，覆盖 id 集合、id 顺序、逐字段值相等、字段发明与丢失双向检查，scope.`gateCoverage` 的 5 个字段全部证明落到 `gates.json`，`authoritySnapshotPolicy` 证明为有意重指向；连续两次 `npm run handoff:fingerprint` 输出一致，工作树干净（`trackedDiffSha256` 与 `untrackedManifestSha256` 均为空树 hash，untrackedCount=0），本轮全部 `REL-SCOPE` 主题域改动已进入 head 锚点提交 `80f1da0` | 范围裁定内容逐字段不变：27 项范围矩阵、12 项 deferredToRelease=V0.6 且 operations=[]、五编辑器文本优先边界、`SCOPE-PARAM` 仅 gameparam、script 整内层文件替换、四项延期只读预览 countedAsReleaseEditor=false 全部原样迁入 `docs/governance/scope.json`；新增能力是跨版本冻结物理拦截——`releases.json` 标记 V0.5 frozen=true 后，对其 `frozenFields` 列出的裁定字段的任何修改都会与 git 基线比对并失败关闭，基线不可验证时同样失败关闭（fixture freeze-fails-closed-without-git-baseline 锁定该行为）；冻结范围刻意只含用户裁定字段，不含 gateState/lifecycle/authority/evidence 追加，避免冻结把 V0.5 自身锁死；提交 `80f1da0` 另修三处门禁自身缺陷：freshness 锚点改为跟随被判定的数据源（外化后锚点来自 markdown 而证据来自 JSONL，导致任何新封存证据恒判 unverifiable、重封存不可能生效）、两份 `buildFreshnessContext` 合并为 `scripts/governance/freshnessContext.mjs` 单一实现、`REL-SCOPE` 主题域补登记 verify-`governance.mjs` 与 verify-governance-data-`fixtures.mjs`（漏登记则可把冻结基线比对改成 null 或删掉负向 fixture 而不使本 Gate 失效） | 只支持 `REL-SCOPE` 继续 passed 与 `REL-E`/`REL-I` 继续 deferred/`deferred-v0.6` 的既有裁定在新数据源下保持有效；这是工程侧重封存，不是新的范围裁定，不扩大也不收窄任何范围条目，不解除任何延期；不提升任何 parser、writer、editor、AI、runtime、render 或发行 authority；未运行真实 Electron 人机功能验收、NSIS lifecycle、真实 Sekiro 会话、私有 native corpus 与 Oodle 回归、渲染硬件基准；本轮未运行 `npm run bridge:verify:synthetic` 与 `npm run build`（改动仅限治理门禁 .mjs 脚本，不进入 TypeScript 编译或 Bridge 构建路径，且 `0af13a4` 已在同一治理数据上运行过两者）；门禁通过只表示确定性检查成立，治理数据本身是否真实仍由工程复核负责；不声明 V0.5 完成或允许外部分发 |
| `EV-REL-SCOPE-20260801-SEAL-CLI` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-GOVERNANCE-JSON`；工程侧重封存：新增 gov seal 重封存命令、`REL-SCOPE` 主题域补登记五个治理 schema、切片 goal/evidence 字段拆分收尾。范围裁定语义未变，不构成新的范围裁定 | HEAD=`c1ccdb15decec9626af0f1e1d827fffba85276b4`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=a2be208f207e9264c677c6e33cd9fbbd2be7295cfa065aabef0ea86e1a4b4602; fingerprintSha256=c4222e4d8b56ac46d511fe951526f7eb26cdd4fe569c76e2c7539908ca431e07 | `npm run typecheck`、`npm test`、`npm run test:gov-cli`（40 项，原 27）、`npm run test:governance-equivalence`（92 markdown codes 全部由 JSON 门禁产出或在 SCHEMA_SUPERSEDED 登记共 18 项，jsonCodes=86，真实数据上两侧 error code 多重集一致且 findings 均为空）、`npm run test:governance-data-fixtures`、`npm run test:handoff-integrity:fixtures` 均 exit 0；gov/`seal.mjs` 的五字段指纹与 `scripts/generate-handoff-fingerprint.mjs` 在真实工作树上逐字段比对一致（head/trackedDiffSha256/untrackedManifestSha256/handoffSha256BeforeEvidenceAppend/fingerprintSha256/`untrackedCount` 六项全等），该比对已写入 verify-gov-cli-fixtures 长期锁定；gov seal 负向路径经真实运行确认失败关闭：非法 EvidenceId→SEAL_ID_INVALID、缺 --non-claims→SEAL_FIELD_REQUIRED、重复 ID→SEAL_ID_DUPLICATE、未定义 Gate→SEAL_GATE_UNDEFINED，四条失败路径均未向 `evidence.jsonl` 追加任何行且 `gates.json` 逐字节还原；不带 --gates 时在真实仓库实测 SEAL_POSTCHECK_FAILED 并完整回滚（该次失败即本轮发现 --gates 缺口的实证）；本轮全部 `REL-SCOPE` 主题域改动已进入 head 锚点提交 `c1ccdb1`，封存时工作树干净 | 新增 gov seal：校验 ID 与四个必填字段 → 复算五字段指纹（必须在追加之前，`handoffSha256BeforeEvidenceAppend` 的语义即「追加前」）→ 追加 JSONL → 按 --gates 挂到 Gate 的 `evidenceRefs`（只追加不删历史引用）→ 跑含 freshness 的完整门禁 → 失败同时回滚 `evidence.jsonl` 与 `gates.json`。`REL-SCOPE` 主题域从 19 个文件扩到 24 个：补登记 blockers/evidence/gates/slices/validation 五个 schema（原先只有 releases/scope 两个），理由是 schema 的 required + additionalProperties:false 承担了一部分门禁职责，漏登记就能放宽 slices.`schema.json` 给切片加字段或去掉必填项而 `REL-SCOPE` 仍显示 fresh。切片字段拆分收尾：三个 deferred 切片的 goal 与 `W-EMEVD-FULL-01` 的 `hardPrerequisites` 中混杂的已完成证据原文逐字移入 evidence，开放切片 goal 上限 342→125 字、均值 62 字；gov next 刻意不投影 evidence，只报 `hasEvidenceRecord` | 只支持 `REL-SCOPE` 继续 passed 与 `REL-E`/`REL-I` 继续 deferred/`deferred-v0.6` 的既有裁定在主题域扩容后保持有效；这是工程侧重封存，不是新的范围裁定，不扩大也不收窄任何范围条目，不解除任何延期；不提升任何 parser、writer、editor、AI、runtime、render 或发行 authority；不改动任何切片的 lifecycle、authority 或 authorityCap，也不改动任何 `gateState`；本轮未运行 `npm run bridge:verify:synthetic` 与 `npm run build`（改动仅限治理 .mjs 脚本、治理 JSON 与 schema，不进入 TypeScript 编译或 Bridge 构建路径）；未运行真实 Electron 人机功能验收、NSIS lifecycle、真实 Sekiro 会话、私有 native corpus 与 Oodle 回归；gov seal 只搬运调用方陈述的运行事实，它不验证命令真的跑过；门禁通过只表示确定性检查成立，治理数据本身是否真实仍由工程复核负责；不声明 V0.5 完成或允许外部分发 |
| `EV-REL-SCOPE-20260801-HANDOFF-PROJECTION` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-SEAL-CLI`；工程侧重封存：交接书五张治理表改为治理 JSON 投影、新增投影退化门禁、npm 脚本名规则补 fixture 覆盖、`REL-SCOPE` 主题域登记投影器与其 fixture。范围裁定语义未变，不构成新的范围裁定 | HEAD=`2327d625e751cbaf03fcdb9f166218c16f00f053`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=41b9404e64bb18d06459622481972ea349e81c752815060bf6ca033bfe6cca39; fingerprintSha256=4bae3f35ba729e90b053f3233a9e43ae832c61104736ed273a7c61d46b4ed67f | `npm run typecheck`、`npm test`、`npm run test:gov-cli`（41 项，原 40）、`npm run test:handoff-projection`（2899 项：真实数据 2858 + 合成边界 13 + 脚本名正则契约 5 + 其余结构断言）、`npm run test:handoff-integrity`、`npm run test:governance`、`npm run test:governance-equivalence`、`npm run test:governance-data-fixtures`、`npm run test:handoff-integrity:fixtures`、`npm run test:release-scope` 均 exit 0；投影六类退化经真实运行确认失败关闭（空值退化、空数组退化、列序调换、竖线不转义、换行不压平、去掉反引号配平）；标记缺失与手改表格两条负向路径实测 exit 1 且分别报 PROJECTION_MARKER_MISSING 与 ok:false；放宽脚本名正则的负向改动实测被 npm-script-pattern/normalized-prose-is-caught 拦住；本轮全部 `REL-SCOPE` 主题域改动已进入 head 锚点提交 `2327d62`，封存时工作树干净 | 交接书 §13.1/§13.1.1/§17.1/§18.3/§18.4 五张表改为由 generate-handoff-`projection.mjs` 从治理 JSON 生成，用 SOULFORGE_PROJECTION_BEGIN/END 标记划定生成区，标记外散文零改动（实测非表格行 diff=0）。gov seal 追加证据后自动重新投影；SEAL_PROJECTION_FAILED 与 SEAL_POSTCHECK_FAILED 两条失败路径均连交接书一并回滚。修掉三处数据侧抽取失真：`capabilityIds` 把两个能力 ID 连同斜杠分隔符整串当一个 ID 存（已拆成真数组）、`EV-HANDOFF-20260721` 的 result 归一化后与门禁的脚本名正则产生歧义匹配（改为无歧义措辞）、`entryPoints` 分隔符不统一（统一顿号）。修掉两个写 fixture 时暴露的真实渲染缺陷：空 `capabilityIds` 渲染成空单元格、数据含奇数反引号会吞掉后续若干列。NPM_SCRIPT_MISSING 规则补 fixture 覆盖并回退一次无效修法（负向先行断言对触发时的文本形式不生效）。`REL-SCOPE` 主题域 24→26 个文件，登记投影器与其 fixture | 只支持 `REL-SCOPE` 继续 passed 与 `REL-E`/`REL-I` 继续 deferred/`deferred-v0.6` 的既有裁定在主题域扩容后保持有效；这是工程侧重封存，不是新的范围裁定，不扩大也不收窄任何范围条目，不解除任何延期；不提升任何 parser、writer、editor、AI、runtime、render 或发行 authority；不改动任何切片的 lifecycle、authority 或 authorityCap，也不改动任何 `gateState`；投影只搬运治理 JSON 的字段，不校验字段内容是否真实——数据真实性仍由工程复核负责；投影使 markdown 与 JSON 结构一致，不代表 JSON 内容正确；脚本名正则的 fixture 只锁定五种具体输入下的行为，拦不住任意放宽改动，该边界已写在 fixture 注释中；本轮未运行 `npm run bridge:verify:synthetic` 与 `npm run build`（改动仅限治理脚本、治理 JSON 与交接书 markdown，不进入 TypeScript 编译或 Bridge 构建路径）；未运行真实 Electron 人机功能验收、NSIS lifecycle、真实 Sekiro 会话、私有 native corpus 与 Oodle 回归；不声明 V0.5 完成或允许外部分发 |
| `EV-REL-SCOPE-20260801-SCOPE-PROJECTION` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-HANDOFF-PROJECTION`；工程侧重封存：§18.2.1 范围提案块改为 `scope.json` + `gates.json` 投影、治理 CLI 去掉 V0.5 硬编码、`resumeRequires` 去模板化并加门禁。范围裁定语义未变，不构成新的范围裁定 | HEAD=`a9afc533a9ea08b1a8a10225bbbfee1e0986f9a8`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=2c0a174dfa70b7a24243b0c3ff182508265f730867d06baf8288dd7da9be1b15; fingerprintSha256=1add06e2c08175360c5dfdf7feb3ec51d27c4bea70d8fad846910286a4f97ed7 | `npm run test:release-scope`；`npm run test:release-scope-proposal`；`npm run test:release-scope-fixtures`；`npm run test:handoff-projection`；`npm run test:gov-cli`；`npm run test:governance-equivalence`；`npm run test:governance-data-fixtures` | §18.2.1 的 1242 行内嵌 JSON 提案改为 `scope.json` + `gates.json` 投影，消除交接书最大一处重复（占全文 35%）。实测原分叉：27/27 条 `scopeItem` 缺 targetRelease/deferredTrack/resumeRequires，`deferredToRelease` 缺 15 处，`schemaVersion` 1.6.0 vs 权威 2.0.0，`liveAuthoritySource` section-13.1 vs 权威 `docs/governance/slices.json`；`gateCoverage` 11 条相对 `gates.json` 四字段零分叉。投影后 verify-release-`scope.mjs` 读到权威数据并暴露修掉四处缺陷（null 误判为声明延期、`schemaVersion` 硬编码、`proposalId` 正则硬编码版本、缺字段丢键）。gov CLI --release 默认改取 `releases.json` 的 currentRelease，未登记与形状非法值硬失败。12 条 `resumeRequires` 从策略复制改为策略引用加专属前置并加门禁。fixture：gov-cli 48 项、handoff-projection 2915 项，全部 exit 0 | 本轮只改治理数据呈现与治理 CLI，不触碰任何 native parser、writer、validator 或 Patch Engine，不提升任何 capability 的 authority。`REL-E` 与 `REL-I` 仍为 deferred，MSB/FLVER/渲染能力未获得任何新证据。`resumeRequires` 的专属承接前置来自既有治理数据的重述，不是新的技术验证结论，也不构成对 V0.6 工作量的估计。范围裁定字段本身未改动，冻结拦截照旧生效。 |
| `EV-REL-SCOPE-20260801-COMMAND-INDEX` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-SCOPE-PROJECTION`；工程侧重封存：§15 命令清单改为 `tiers.mjs` 投影、`tiers.mjs` 登记进 `REL-SCOPE` 主题域、§17.2 历史日志定位说明。范围裁定语义未变，不构成新的范围裁定 | HEAD=`adf5aef16539106d9ffd5e0d89a327d73f20d7e2`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=13d9d7b8b4d22aa924057eb9744ddc816b1574ff471425dbf04ced59491a17b6; fingerprintSha256=08a36d19a872e104135fbd91962d92a0cdeb457b970bd08e96a4cca234ae18fa | `npm run test:handoff-projection`；`npm run test:handoff-integrity`；`npm run test:handoff-integrity:fixtures`；`npm run test:governance`；`npm run test:release-scope`；`npm run test:gov-cli`；`npm run test:verify-entrypoint`；`npm run verify:audit` | §15 手写命令清单实测只列 38 条而 `package.json` 有 144 条，106 条缺失且落后不被任何门禁发现。改为从 `scripts/verify/tiers.mjs` 投影：122 条已登记命令按层级列出，22 条排除项带理由。补登记本轮三条漏登记 script（verify:audit 正确报出 SUITE_UNREGISTERED）：`test:handoff-projection` 入 governance 层，handoff:project 与 gov:seal 登记 EXCLUDED。`tiers.mjs` 加入 `REL-SCOPE` 主题域。§17.2 新增 §17.2.1 定位说明，不删除 505 行历史日期条目。fixture handoff-projection 2915→2946 项，全部门禁 exit 0 | 不触碰任何 native parser、writer、validator 或 Patch Engine，不提升任何 capability 的 authority。§15.1 路线验证矩阵的证明范围与不证明仍是手写工程判断，本轮未改动也未重新验证其内容。命令清单只证明「已登记的 script 全部被列出」，不证明这些命令当前都能通过，也不证明层级归属是最优的。§17.2 历史条目未做内容核对，只加了定位说明。 |
| `EV-REL-SCOPE-20260801-PARSER-REGISTRY` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-COMMAND-INDEX`；工程侧重封存：§18.2.1 提案块第四处解析方（`packages/core` TS smoke）修正、新增提案解析方登记表门禁并实测负向可触发。范围裁定语义未变，不构成新的范围裁定 | HEAD=`3c0f0fcc960e28801f32b5514ef2ecef8fac4d89`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=cd66e6aec6813ebdf12a21a9bc49a4f926b9e65ff5d22234b2435390d46a9d6a; fingerprintSha256=5fad6071c76ccb8b7b7f5f28e52cc71627a7362894fb942123d73b756ea1db04 | `npm run test:handoff-projection`,`npm run typecheck`,`npm test`,`npm run bridge:verify:synthetic`,`npm run build` | 登记表门禁改为真扫 `scripts/packages/apps` 并双向比对后，负向用例（伪造第五处解析方）exit=1 并命中 proposal-parsers/registry-matches-repository；恢复后 exit=0，2974 项通过。边界：只覆盖 marker 引用，不校验各解析方的正则是否语义等价。 | 不证明 native 资产解析、真实游戏目录写入或安装分发；fixture 与治理数据校验不等于 native authority |
| `EV-REL-SCOPE-20260801-DIAGNOSTIC-ROOTCAUSE` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-PARSER-REGISTRY`；工程侧重封存：seal 继承标记追加前预检、投影分叉判定改为行尾无关。两处均为诊断指向错误原因导致 agent 无法自修的阻塞，修的是根因不是诊断措辞。范围裁定语义未变，不构成新的范围裁定 | HEAD=`f3a7f6fdc2b1bb2c45eaf22c3a6997b414620632`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=da6b7d3080a8885e81e04653c1c2cc8a5a4e560d1630c3d7add81bef23d90c92; fingerprintSha256=edafe13acb4a49be86455f25114d0cc0897a606d025e04b3c9107355d0132bfb | `node scripts/verify.mjs` --tier governance,`npm run typecheck`,`npm test`,`npm run bridge:verify:synthetic`,`npm run build` | 两处 agent 阻塞已修根因并各有可触发的负向 fixture。边界：本轮只修了实际撞到的两处，未对全部门禁诊断做指向正确性普查；行尾归一化只作用于交接书投影，其他门禁的行尾行为未审计。 | 不证明 native 资产解析、真实游戏目录写入或安装分发；不声明其他诊断的指向正确性已被系统性审计；fixture 与治理数据校验不等于 native authority |
| `EV-REL-SCOPE-20260801-CLI-CLOSURE` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-DIAGNOSTIC-ROOTCAUSE`；工程侧重封存：gov next 输出补 claim→验证→封存→complete 流程骨架、治理 CLI 四个文件登记进 `REL-SCOPE` 主题域。范围裁定语义未变，不构成新的范围裁定 | HEAD=`7b1114527c6a7113c5ccd9e7065b1a1759b24ad6`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=2d73ec656a939ab26bf4847b5aa1fe4dec6a940b26690f50e6e660349a8d0756; fingerprintSha256=93cae0056c50d6613cc0453285f3def1064294baa34e6cc90d29adc7ccc48d0f | `node scripts/verify.mjs` --tier governance,`npm run typecheck`,`npm test`,`npm run bridge:verify:synthetic`,`npm run build` | 治理 CLI 现已纳入 freshness 判定，改封存行为必须重封存。边界：主题域文件集是否还有同类缺口未普查；workflow 骨架只保证闭环存在，不保证每步措辞对所有切片都最优。 | 不证明 native 资产解析、真实游戏目录写入或安装分发；不声明主题域文件集已完备（本轮只补了治理 CLI 这一处缺口，未做系统性普查）；fixture 与治理数据校验不等于 native authority |
| `EV-REL-SCOPE-20260801-RELEASE-SCOPING` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-CLI-CLOSURE`；工程侧重封存：next 的 activeSlices/`blockedSlices` 补版本过滤，消除 V0.5 在飞 claim 漏进 V0.6 视图。范围裁定语义未变，不构成新的范围裁定 | HEAD=`5298548357e55144e906f286379f5b621b9e19f0`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=7eacef61a9f5466300f85f97b7beb9b0427f5cea3b14d94019749a1098491ad3; fingerprintSha256=a3329c8109651174119a1c8a2775932507bada92d44f8cbbc5dfe63596538b27 | `node scripts/verify.mjs` --tier governance,`npm run typecheck`,`npm test`,`npm run bridge:verify:synthetic`,`npm run build` | 跨版本治理路径已可用且无跨版本泄漏。边界：V0.6 当前无 ready 切片属预期（延期条目的 `resumeRequires` 尚未满足），本轮不改变任何延期裁定。 | 不证明 V0.6 切片本身可推进（其硬前置未成立）；不证明 native 资产解析或真实游戏目录写入；fixture 与治理数据校验不等于 native authority |
| `EV-REL-SCOPE-20260801-EMPTY-GUIDANCE` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-RELEASE-SCOPING`；工程侧重封存：无可 claim 切片时的出路按实际 lifecycle 分布给出，消除 V0.6 的 deferred 死路。范围裁定语义未变，不构成新的范围裁定 | HEAD=`23ad174b38d9aca4c699d93f45c3df03c60342f3`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=2e1321520fe7d55f85d82b0fd2e0e955203dd4ac7dd93450816c4882bf6ffc00; fingerprintSha256=efa5cce756c3db1979506eaa8bc258e473207e58b07d57bffa4984a52e39407d | `node scripts/verify.mjs` --tier governance,`npm run typecheck`,`npm test`,`npm run bridge:verify:synthetic`,`npm run build` | V0.6 选点不再是死路，出路指向正确权威。边界：只修了消息指向，未评估各 `scopeItem` 的 `resumeRequires` 本身是否可执行。 | 不改变任何延期裁定，也不声明 V0.6 的 `resumeRequires` 已满足；不证明 native 资产解析或真实游戏目录写入 |
| `EV-REL-SCOPE-20260801-COMMAND-EXISTENCE` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-EMPTY-GUIDANCE`；工程侧重封存：执行手册改为指向治理 CLI，并补 node scripts/*.mjs 与 gov 子命令引用存在性门禁。范围裁定语义未变，不构成新的范围裁定 | HEAD=`a237dcef88648f7b671f3b1b50c87801dfef0ba2`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=20a3af739bf62596f09a072f4b1777b32db2d1350a2b84c8a70f0aca30e71a5a; fingerprintSha256=2ae75b51b5fe85265ed2035e65b24497e98748ea5e4a86ec30edb20fe2653bb5 | `node scripts/verify-handoff-integrity.mjs`（负例注入后 exit=1，命中 NODE_SCRIPT_MISSING 与 GOV_SUBCOMMAND_MISSING 并指名对象；恢复后仅剩本轮预期 staleness）；`node scripts/verify.mjs` --tier governance（封存前 exit=1 仅因 `test:governance` 的三条 staleness） | 文档引用的脚本路径与 gov 子命令现在受门禁约束；判据取 CLI 实际接受的命令集而非 COMMANDS 键，避免把正确的 gov help 误报为不支持 | 本轮不提升任何切片 authority；未运行 native smoke；不校验命令参数（参数口径由 gov help 承担） |
| `EV-REL-SCOPE-20260802-SEAL-COMMIT-WARNING` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260801-COMMAND-EXISTENCE`；工程侧重封存：seal 成功输出报出未提交的治理文件；修复 gov-cli fixture 的假覆盖（扰动未还原导致正向路径 7 条断言从未执行）。范围裁定语义未变，不构成新的范围裁定 | HEAD=`d6ed6f2d90e759fbc22f2261e2d68074468ff46e`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=57c5d1ff5272dd1f5a97d680afcd13679ae7a1f764ec3846e530d82ef76ddf5c; fingerprintSha256=bcf7feb71c7433bd9a94bf4aab2740af50b901f5ab3af33152678e7b6eccc4ff | `node scripts/verify-gov-cli-fixtures.mjs`（63→72 项全绿，exit=0）；`node scripts/verify.mjs` --tier governance（封存前 exit=1 仅因 `test:governance` 的三条 staleness，其余 15 项 PASSED）；插桩实测确认 seal 正向路径此前恒不可达（PROBE status=1 code=SEAL_POSTCHECK_FAILED），修复后 status=0；回滚场景实测确认失败原因是 freshness 而非 schema 违规 | seal 不再静默留下未入库的事实源；gov-cli fixture 的正向与回滚路径各自显式构造、互不依赖环境碰巧走哪个分支 | 本轮不提升任何切片 authority；未运行 native smoke；seal 仍不自动提交（只报告） |
| `EV-REL-SCOPE-20260802-UNCOMMITTED-PATH-FIX` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260802-SEAL-COMMIT-WARNING`；工程侧重封存：修正 `uncommittedAfterSeal` 的 porcelain 路径切片并加路径可解析断言。范围裁定语义未变，不构成新的范围裁定 | HEAD=`f8d258e8ddd26b5f041021863abcb0f4be6dafca`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=a7f760659e5d9cce76f04a6b0c85440cf2e9931fa164a6416de79c41f8be142d; fingerprintSha256=2452861d18b73729397f3e9bf680b46e6f05abd9b533295f278f32d7a1c69a68 | `node scripts/verify-gov-cli-fixtures.mjs`（73 项全绿，exit=0）；直接调用 `collectUncommittedGovernanceFiles` 实测三个路径均正确解析 | `uncommittedAfterSeal` 报出的路径逐个可解析到真实文件；切片错误由 cli/seal-uncommitted-paths-resolve 锁定不回归 | 本轮不提升任何切片 authority；未运行 native smoke |
| `EV-REL-SCOPE-20260802-DEFERRED-RESUME-PROJECTION` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260802-UNCOMMITTED-PATH-FIX`；工程侧重封存：gov next 直接投影 deferred 切片的 resumeRequires，消除手工反查 `scope.json` 的一步。范围裁定语义未变，不构成新的范围裁定 | HEAD=`bde38bb328235cb0df88ae3e92e06a4da084bbf1`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=99a2e73d7172fb82bad21d590db6d9759d46ce9d5a7c57f13f55a47812e067b9; fingerprintSha256=a81527c23e5f171f1e3486ff30fc7d3548b4ba2a9c121953e83f8d5e92e128ca | `node scripts/verify-gov-cli-fixtures.mjs`（73→76 项全绿）；负例实测（让投影返回空数组 → exit=1，恢复 → exit=0）；实测首屏体积 V0.5 6608 B / V0.6 9838 B / --all 15288 B | V0.6 的 3 条 deferred 切片各自带出对应 `scopeItem` 的 `resumeRequires`；取不到时给 reason 而非空数组；无 deferred 版本不投影 | 本轮不提升任何切片 authority，不解除任何延期；未运行 native smoke |
| `EV-REL-SCOPE-20260802-ENTRYPOINT-OPENABLE` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260802-DEFERRED-RESUME-PROJECTION`；工程侧重封存：`entryPoints` 路径可打开性门禁 + 修正 `W-BEHAVIOR-MAP-01` 两条被状态标注污染的路径。范围裁定语义未变，不构成新的范围裁定 | HEAD=`f51d191a467547644dfd524f2206d991749fdfb6`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=24134817eea251e7a6584f13a2af9cca477afd49fb563eb67ded0ddddf1bfbeb; fingerprintSha256=9a40edd07c4f2da69b7ef98c25e3ff2a20082987d353fa597a7b1a5643cd1780 | `node scripts/verify-handoff-integrity.mjs`（修数据前命中 2 条 SLICE_ENTRYPOINT_UNOPENABLE，修后清零）；负例实测（给正常路径加（探针）→ 命中并指出路径本体，恢复 → 0 条）；实测全仓 `entryPoints` 分布：纯路径存在 107、叙述性 40、裸文件名 4（均可唯一定位） | gov next 交给 agent 的 `entryPoints` 现在受门禁约束，形如路径的条目必须能直接打开；状态标注不得拼进路径 | 本轮不提升任何切片 authority；未运行 native smoke；叙述性 `entryPoints` 仍允许，不强制全部转为路径 |
| `EV-REL-SCOPE-20260802-CONSTRAINT-SPEC` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260802-ENTRYPOINT-OPENABLE`；工程侧重封存：新增 `docs/plan.md` agent 驱动约束规格并纳入受管文档引用真实性门禁，三处文档数组合并为单一 MANAGED_DOCS。范围裁定语义未变，不构成新的范围裁定 | HEAD=`b1235dc1422b6193158aa0b18811d783844b2e61`; trackedDiffSha256=ee42069924425d9eaf6b843dc6b9be186d6f0cd0b787cc0a54ae3dbdfade0643; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=d17d9c9756024f3d0bebdef593e9fb1fd5411d3321b316b097083eec848ea65b; fingerprintSha256=30b7a567b55936056b5f18b373ae54195af130fc439f2722c4b26276b50d71d6 | `node scripts/verify-handoff-integrity.mjs`；`node scripts/verify.mjs` --tier governance | 受管文档三处扫描合并为 MANAGED_DOCS 并覆盖 `plan.md`；PLAN_MISSING/NPM_SCRIPT_MISSING/NODE_SCRIPT_MISSING/GOV_SUBCOMMAND_MISSING 四条负向用例实测触发后复原；README 挂链 | 本轮不改变任何范围裁定、authority 等级或延期条目；`plan.md` 不承载范围/进度/authority 口径 |
| `EV-REL-SCOPE-20260802-STALE-CLAIM-VISIBILITY` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260802-CONSTRAINT-SPEC`；工程侧重封存：gov next 暴露在飞 claim 心跳陈旧度（24h 判据、不自动释放、不可解析判为未知），`plan.md` 去掉会腐烂的写死字节数改为可复现量法。范围裁定语义未变，不构成新的范围裁定 | HEAD=`050f9b0a543b5fb98787d47f8f9e2f13e3bda2e8`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=df4df82dfca20fc641131adf407945b9b20c4048a6a9f56cf5419f83f587d44c; fingerprintSha256=cafd096f027bdc59a467dbf1a9698fafee5b1e1edd3776cd05811c2ec96b210e | `npm run test:gov-cli`（83 项全绿，负例注入后 2 项转红并还原）；`node scripts/verify.mjs` --tier governance | `activeSlices` 新增 heartbeatAt/heartbeatStale/staleFor/`recoveryHint`；陈旧/新鲜/不可解析三种结局各自显式构造，检查数 76→83；5 条 coordinator-agent claim 现被标为停滞 33 小时并给出核实后 release 或 complete 的出路 | 不声称那 5 条在飞切片的实现完成度；CLI 不自动释放任何 claim；本轮不改变任何范围裁定、authority 等级或延期条目 |
| `EV-REL-SCOPE-20260802-FIXTURE-RESTORE` | `sealed-current-run` | complete 成功路径 fixture 扰动还原与陈旧 gates 副本修复后的范围主题域重验证；范围语义未变，仅工程侧重跑验证。revalidates=`EV-REL-SCOPE-20260802-STALE-CLAIM-VISIBILITY`；`scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved | HEAD=`81742ec796aad4210b43dfe0e6d7713a517edbe0`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=596c4c2695e91d655da6cdd036c09522971e2a591e043565867c5fca42f6cbfa; fingerprintSha256=6b342e73a88531a11cb6cbb2637ec8ad8132829668e8df4dc70424318a4e8859 | `npm run test:gov-cli` exit=0（84 项全绿，修前 76 项含 3 项失败）；`node scripts/verify.mjs` --tier governance（本次封存前 `test:governance` exit=1 报 `REL-SCOPE`/`REL-E`/`REL-I` stale，即本条封存要消除的对象）；负例三步：注掉 `gates.json` 还原 exit=1 诊断报 gates=false，恢复后 exit=0 | verify-gov-cli-`fixtures.mjs` 的 complete 成功路径两处缺陷已修：三份治理数据扰动逐份还原并加逐字节还原断言；覆写 `gates.json` 前重读，不再用 complete 之前的陈旧内存副本。该段此前因 `isSoleLiveSlice` 恒真而从未执行，释放被遗弃 claim 后首次可达。 | 不提升任何切片 authority；不改 `gateState` 与 applicability；不构成 native 验证证据；未运行 native/release 层验证；range 裁定语义未变，不构成新的用户裁定 |
| `EV-REL-SCOPE-20260802-FIXTURE-PREMISE` | `sealed-current-run` | fixture 场景前提改为自行构造后的范围主题域重验证；范围语义未变，仅工程侧重跑验证。revalidates=`EV-REL-SCOPE-20260802-FIXTURE-RESTORE`；`scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved | HEAD=`07b901e548aaa04501ea688c7d1bb5e2a9affe67`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=bcdf1d293c7b4f132db38458b4333a8cf3960ced3a1f419633295e00a006a99d; fingerprintSha256=0822ed19edcd18e25b98ac6aa378a595907bd664836907810840e5ed23e14f53 | `npm run test:gov-cli` exit=0（85 项全绿；修前 `activeClaims` 空时 74 项含 1 项失败）；`node scripts/verify-governance.mjs` 本次封存前仅报 `REL-SCOPE`/`REL-E`/`REL-I` 三条 stale，即本条要消除的对象；断言执行核对用插桩探针打印 check 名，确认心跳 7 条、complete 成功路径 4 条、seal 正向 7 条与回滚 5 条均真实执行，探针脚本已删除 | verify-gov-cli-`fixtures.mjs` 心跳陈旧段与 complete 成功路径段不再依赖真实数据碰巧存在 active claim：两段各自 claim 一条 ready 切片构造前提，快照提到该 claim 之前，还原同时撤掉扰动与 fixture 自造的 claim。5 条被遗弃 claim 全部释放后 V0.5 可 claim 面从 5 条恢复到 10 条。 | 不提升任何切片 authority；不改 `gateState` 与 applicability；不构成 native 验证证据；本轮未运行 unit/synthetic/native/release 层验证；范围裁定语义未变，不构成新的用户裁定 |
| `EV-REL-SCOPE-20260802-EMPTY-CLAIM-STATE` | `sealed-current-run` | 空 `activeClaims` 合法化后的范围主题域重验证；范围语义未变，仅工程侧重跑验证。revalidates=`EV-REL-SCOPE-20260802-FIXTURE-PREMISE`；`scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved | HEAD=`749b835ff0802f5c67898beecb958a3742bab92c`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=3e54d97a60eb711967bb0eb3478dcb46fde82700319e2c3a2a51e056d786d907; fingerprintSha256=8dc56a155179004e449b1eb18649233e488113417173481004de4ef7f33c6e17 | `npm run typecheck` exit=0；`npm run test:governance-data-fixtures` exit=0；`npm run test:governance-equivalence` exit=0；`npm run test:gov-cli` exit=0（85 项）；`npm run test:handoff-integrity` 除本条要消除的 stale 外全绿（投影 fixture 3191 项通过、投影区与治理 JSON 一致）；负例：ACTIVE_SLICE_CLAIM_REQUIRED 规则本体改成恒不触发后 fixture 报 FAIL active-slice-needs-exactly-one-claim exit=1，恢复后 exit=0 且 `governanceRules.mjs` `git diff` 为空；门禁放宽负例三支实测——空态说明放行 false、空态说明被替换 true、§13.1.1 章节整体删除 true | markdown 门禁 `parseAndValidateActiveClaims` 与投影器的空 `activeClaims` 行为对齐：章节存在且内容为投影器空态说明时放行，判据只读 markdown 不读治理 JSON（保持等价性比对有效）。verify-governance-data-fixtures 的 active claim 用例改为先造 active 切片再清空 claim，不再依赖真实数据碰巧有 active 切片。迁移等价性恢复为「规则覆盖 + 真实数据结论一致」。 | 不提升任何切片 authority；不改 `gateState` 与 applicability；不构成 native 验证证据；本轮未运行 `npm test`、bridge:verify:synthetic、`npm run build` 与任何 native/release 层验证；范围裁定语义未变，不构成新的用户裁定 |
| `EV-REL-SCOPE-20260802-STATUS-STALENESS` | `sealed-current-run` | status 暴露心跳陈旧度后的范围主题域重验证；范围语义未变，仅工程侧重跑验证。revalidates=`EV-REL-SCOPE-20260802-EMPTY-CLAIM-STATE`；`scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved | HEAD=`4c06490ac569a232d3b206970315b6cba5424a0f`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=0dbd8edb8927e4396940f664baabcf37c0b1aa03eaca882d7a78192fe43bc170; fingerprintSha256=d3e60384b15eb0a60fcacda91d7bc8b31f98fd8eb3444e18a45abe81571bab5a | `npm run test:gov-cli` exit=0（89 项，原 85）；`node scripts/verify.mjs` --tier governance 本次封存前仅报 `REL-SCOPE`/`REL-E`/`REL-I` 三条 stale（verify-`governance.mjs` 输出 code 计数为 GATE_EVIDENCE_STALE×1 + GATE_DEFERRAL_EVIDENCE_STALE×2，无其他 code），即本条要消除的对象；负例：把 status 的 `heartbeatStale` 改成恒 false 后 status-reports-stale-claim 与 status-agrees-with-next-on-staleness 报 status=false/72 小时 next=true/72 小时，checks 仍为 89，恢复后 exit=0；沙箱副本实测三情形：陈旧 72h→true+hint、新鲜 1h→false 且 hint=null、仅日期 2026-08-01→按 35 小时判陈旧 | gov status 的 `activeClaims` 补 heartbeatStale/staleFor，有陈旧 claim 时给 `staleClaimHint` 指向 gov next；判定复用 claimStaleHours，与 next 逐字段一致，由 status-agrees-with-next-on-staleness 门禁化防阈值漂移。gov help 的 `staleClaims` 同步说明两命令都会报。修前 status 与 next 对同一份数据给出相反结论，而 status 是 CLAUDE.md 列的常用入口。 | 不提升任何切片 authority；不改 `gateState` 与 applicability；不构成 native 验证证据；本轮 seal 前未重跑 `npm test`、bridge:verify:synthetic、`npm run build`（另有独立回归在跑，结果不并入本条）；范围裁定语义未变，不构成新的用户裁定 |
| `EV-REL-SCOPE-20260802-PROCESS-SELF-OPTIMIZATION` | `sealed-current-run` | `scope-ruling:user-approved`；scope-deferral:`REL-E`:V0.6:user-approved；scope-deferral:`REL-I`:V0.6:user-approved；revalidates=`EV-REL-SCOPE-20260802-STALE-CLAIM-VISIBILITY`；工程侧重封存：`plan.md` 补第 9 条流程自优化约束并新增条目交叉引用门禁。范围裁定语义未变，不构成新的范围裁定 | HEAD=`1693b1be447443deafaf4b1ac0a5e5d7fdaa5428`; trackedDiffSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; untrackedManifestSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; handoffSha256BeforeEvidenceAppend=b3b6430108f908a2f4e17f722c50ac2b5c22ba366fc23c02b858b1ff83204d97; fingerprintSha256=fd22b9573ab7caf4b469dab10a94504ba09597359805c7c512f271e6e8f70891 | `node scripts/verify-handoff-integrity.mjs`（两条负例实测触发后还原）；`node scripts/verify.mjs` --tier governance | `plan.md` 新增第 9 条（摩擦筛法、固化优先级、收敛判据、边界）；新增 PLAN_SECTION_REF_DANGLING 与 PLAN_SECTIONS_UNPARSEABLE，分别覆盖引用悬空与判据形态失效 | 第 9 条的语义贴切性不由门禁保证，门禁只校验编号存在性；本轮不改变任何范围裁定、authority 等级或延期条目 |

<!-- SOULFORGE_PROJECTION_END:evidence-index -->

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

#### 17.2.1 本节以下的日期条目是历史留痕，不是当前口径

§17.2 以下按日期排列的条目产生于证据外化到 `docs/governance/evidence.jsonl` 之前，是当时唯一的留痕位置。它们保留在此供审计追溯，但**不是权威，也不被任何门禁读取**：

- 当前唯一的证据权威是 `docs/governance/evidence.jsonl`，呈现在 §17.1（该表由 `npm run handoff:project` 从 JSONL 生成）。
- 封存新证据只用 `node scripts/gov.mjs seal`。它会写 JSONL、挂 Gate 引用、重新投影 §17.1，三步原子完成，失败整体回滚。
- **不要在本节追加新的日期条目。** 手写条目不参与 freshness 判定、不参与指纹计算、不被等价性门禁比对——追加它只会制造第二份无人校验的进度口径，而这正是硬约束「不得另立进度口径」要防的东西。
- 历史条目与 JSONL 记录粒度不同（28 篇日志 vs 50 条 evidence），两者不构成一一对应，也不应尝试对齐。冲突时以 JSONL 为准。

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
- 工程缺口：FMG 全语言 mutation 受本机 corpus 语言覆盖限制（仅 zhocn）；PARAM 布局 32/33/81（header-embedded type name）仍 unsupported；**bitfield preserving writer 已实现**（`paramdefLayout.ts` 的 `writeBitfield`：读取现有整数、清除目标位范围、设置新值、写回，保留所有其他位；支持 u8/s8/u16/s16/u32/s32/bool 类型；范围验证确保值适合 bitWidth）；**字段级 mutation IPC 接线已完成**（`param_field_set` mutation kind 添加到 `EditorMutationKind` 和 PARAM capability contract；`paramFieldMutation.ts` 核心辅助函数；desktop main IPC `resource.applyParamFieldMutation` + preload 接线；renderer 传递 definition + rowDataBase64 + fieldId + value，main 进程编码后经 Bridge 整行 upsert 提交）；完整字段 writer 与引用验证仍缺；MSB 全实体 CRUD、引用修复、MSB 容器级提交与 `set_part_transform` 之外的 transform 语义仍缺

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

### 2026-08-01：EMEDF schema vararg 支持与 external-only adapter

- 切片：W-EMEVD-FULL-01
- lifecycle：ready（子推进，不改变切片 lifecycle）
- capability：C-EMEVD
- 依赖检查：满足（W-EMEVD-PATCHIR-02 已完成）
- blockerRefs：无
- 输入 authority：partial
- 允许修改的生产入口：`packages/core/src/emevd/emedfSchema.ts`、`packages/core/src/emevd/emedfExternalAdapter.ts`
- 非目标：不捆绑/提交/打包 DarkScript3 EMEDF 数据；不在 production 写链中使用导入 EMEDF；不改变 DSL compiler 或 Bridge
- required validation：`npm run test:emevd-external-adapter`
- authority 上限：cap=partial
- 停止条件：adapter 导入验证通过、合成测试通过、公开回归通过

- 已实现：
  - EMEDF schema 新增 `vararg` 参数支持：`EmedfArgDef.vararg?: boolean`、`hasVararg()`、`varargCount()` 辅助函数、验证 vararg 必须是最后一个参数（`EMEDF_VARARG_NOT_LAST`）、`encodedSize` 排除 vararg 计算最小长度
  - external-only EMEDF adapter（`emedfExternalAdapter.ts`）：`parseDs3EmedfJson()` 和 `importDs3EmedfFile()` 读取 DarkScript3 格式 EMEDF JSON；类型码映射（0→u8, 1→u16, 2→u32, 3→s8, 4→s16, 5→s32, 6→f32, 8→u32）；JSON 注释/尾随逗号兼容（Newtonsoft.Json compat）；名称 sanitize（PascalCase 指令名、camelCase 参数名）与去重；导入后自动 `validateEmedfRegistry`
  - EMEDF registry resolver（`emedfRegistryResolver.ts`）：`resolveEmevdRegistry(externalPath?)` 尝试从用户提供的路径加载外部 EMEDF，失败时回退到内置 fixture 并记录原因
  - desktop main IPC 集成：`ipc.ts` 中三处 `createSekiroFixtureEmedf()` 替换为 `getEmevdRegistry().registry`（缓存解析结果，通过 `SOULFORGE_EMEDF_PATH` 环境变量配置外部路径）
  - DarkScript3 公开项目调查与许可证审计：DarkScript3 及其 EMEDF 数据为 **All Rights Reserved**（`DarkScript3/Resources/LICENSES.txt`），不可复制、捆绑或再分发；Smithbox 2.2.4 无 EMEDF 数据（已核验）
  - 研究工具 `scripts/parse-emedf-html.mjs`：解析 DarkScript3 EMEDF HTML 文档提取指令定义（384 条指令 / 24 bank / 2 vararg）
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity` 均 exit 0；`npm run test:emevd-external-adapter` 32 个合成 case 通过（含 resolver 正/负 case）；真实 `sekiro-common.emedf.json`（用户本机 DarkScript3 安装）导入 405 条指令 / 27 bank / 2 vararg 指令通过
- 未验证：导入 EMEDF 在 production 写链中的 typed mutation 使用；真实 corpus 指令分布与导入 EMEDF 的交叉验证；DSL control-flow validation；layer 变体；KRAK 包装；游戏加载
- 非声明：adapter 只证明外部 EMEDF 数据可被读取、转换和验证，不证明完整 EMEDF 类型覆盖、production typed mutation authority 或任何 Gate 终态；DarkScript3 EMEDF 数据为 All Rights Reserved，SoulForge 不捆绑/提交/打包；合成 fixture 不冒充真实 EMEDF 数据
- 阻塞：无新增外部阻塞

### 2026-08-01：Script 容器 production 证据投影与 IPC 接线

- 切片：W-SCRIPT-READONLY-01
- lifecycle：ready（子推进，不改变切片 lifecycle）
- capability：D-BEHAVIOR / F-EDITORS
- 依赖检查：满足（W-BEHAVIOR-MAP-01 的 probe 已确认 `\x1bLuaQ` 字节码格式）
- blockerRefs：无
- 输入 authority：candidate
- 允许修改的生产入口：`packages/core/src/script/scriptContainerEvidence.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`
- 非目标：不反编译/重编译/执行脚本；不构建 renderer 脚本编辑器面板（前端 Agent 负责）；不生成字节码
- required validation：`npm run test:script-container-evidence`
- authority 上限：cap=candidate
- 停止条件：证据投影合成测试通过、IPC 接线编译通过、公开回归通过

- 已实现：
  - production 证据投影（`scriptContainerEvidence.ts`）：`buildScriptContainerEvidence()` 通过 Bridge `inventory-asset-resources` 枚举容器条目；`classifyScriptEntry()` 分类为 `lua-bytecode`（`\x1bLuaQ` magic）/ `luagnl` / `luainfo` / `esd-bytecode` / `hkx-bytecode` / `unknown`；有界条目数（256）和 hex 预览（32 字节）
  - `inventory-asset-resources` Bridge 命令注册到 `BridgeCommandName`（shared）和 `BridgeCommand`（core）TS 类型
  - desktop main IPC `resource.scriptContainerEvidence` 处理器：查找索引文件 → 验证工作区 → 调用 `buildScriptContainerEvidence`
  - preload `scriptContainerEvidence` 方法暴露给 renderer
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:script-container-evidence`（20 合成 case）均 exit 0
- 未验证：真实 script 容器（luabnd/talkesdbnd/action *.hks）的证据投影；整内层文件替换的写/重读/回滚闭环；renderer 脚本编辑器面板；游戏加载
- 非声明：证据投影只证明容器级枚举与只读分类，不证明脚本语义、反编译、重编译、typed mutation 或任何 Gate 终态；renderer 面板由前端 Agent 负责
- 阻塞：无新增外部阻塞

### 2026-08-01：PARAM bitfield preserving writer 与字段级 mutation IPC 接线

- 切片：W-EMEVD-FMG-PARAM-03
- lifecycle：ready（子推进，不改变切片 lifecycle）
- capability：C-PARAM
- 依赖检查：满足（W-PARAM-META-SOURCE-02 和 W-PARAM-META-NATIVE-01 已完成）
- blockerRefs：无
- 输入 authority：partial
- 允许修改的生产入口：`packages/core/src/param/paramdefLayout.ts`、`packages/core/src/param/paramFieldMutation.ts`、`packages/shared/src/editor-protocol.ts`、`packages/core/src/editing/editorCapabilityContract.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`
- 非目标：不改变 Bridge 整行写入模型；不实现 PARAM 布局 32/33/81；不实现 UI 面板接线（前端 Agent 负责）
- required validation：`npm run test:paramdef-layout`
- authority 上限：cap=partial
- 停止条件：bitfield 写入合成测试通过、IPC 接线编译通过、公开回归通过

- 已实现：
  - `writeBitfield()` preserving bit writer：读取字段偏移处的现有整数值，创建目标位范围掩码（`bitOffset` 到 `bitOffset + bitWidth - 1`），清除目标位，设置新值，写回修改后的整数；所有其他位保持不变
  - 支持类型：u8、s8、u16、s16、u32、s32、bool
  - 范围验证：值必须在 `[0, (1 << bitWidth) - 1]` 范围内，超出范围返回 `PARAMDEF_ENCODE_FAILED`
  - `encodeFieldMutation()` 现在对 bitfield 字段调用 `writeBitfield()` 而非返回 `PARAMDEF_BITFIELD_WRITE_UNSUPPORTED`
  - `param_field_set` mutation kind 添加到 `EditorMutationKind` union 和 PARAM editor capability contract
  - `paramFieldMutation.ts` 核心辅助函数：`applyParamFieldMutation()` 接收 rowDataBase64 + definition + fieldId + value，返回修改后的 rowDataBase64
  - desktop main IPC `resource.applyParamFieldMutation` 处理器：字段编码 → Bridge 整行 upsert → Patch Engine 提交 → 操作日志 → 确认对话框
  - preload `applyParamFieldMutation` 方法暴露给 renderer
  - **Bridge 端 PARAM 分页**：`ParamNativeDocument.ToEnvelope()` 新增 `rowPage`/`rowPageSize` 参数，返回分页元数据（`rowPage`/`rowPageSize`/`rowTotal`/`rowPageCount`）；`read-param-document` Bridge 命令从请求选项读取分页参数；PARAM capability contract 的 `scalePrimitives` 已包含 `pagination`（`scaleAccess` 保持 `bounded-window` 直到 IPC/UI 接线完成）
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`、`npm run test:paramdef-layout`（含 4 个 bitfield 写入 case：低位写入保留高位、高位写入保留低位、范围验证、零缓冲区写入）均 exit 0
- 未验证：真实 PARAM corpus 的字段级写入；UI 面板接线（ParamDefPanel → IPC）；PARAM 布局 32/33/81；引用验证；游戏加载
- 非声明：bitfield writer 和字段级 IPC 只证明 TS 侧字段级编码与 production 写链接线，不证明 UI 接线、PARAM 布局 32/33/81、引用验证或任何 Gate 终态；Bridge 仍为整行写入模型
- 阻塞：无新增外部阻塞

### 2026-08-01：并行 subagent 推进——EMEVD control-flow 通用化、FMG add/PARAM 字段级接线、script/BND4/ParamDef 前端工作台、script 容器真实替换闭环

- 证据类型：`sealed-current-run`（`EV-V05-PARALLEL-SLICES-20260801`）
- 起始：`HEAD=06df4968fde120f650d83639a74f2cbe0db06ab2`
- 结束：五字段指纹见 §17.1 该 Evidence 行；本轮工作树有未提交跟踪改动与 7 个未跟踪新文件
- 路线：C-EMEVD、C-FMG、C-PARAM、D-BEHAVIOR、F-EDITORS（REL-C / REL-D / REL-F 各自 open Gate 的 ready 切片子推进）
- lifecycle 变化：四个切片均保持 `ready`，仅子推进；无切片进入 `completed`，无 authority 提升
- authority 变化：无；EMEVD control-flow、FMG add 接线、PARAM 字段级 smoke、script 真实替换、前端面板均不改变 `partial`/`candidate` 上限
- blockerRefs 变化：无
- 已实现：
  - EMEVD control-flow schema 驱动通用化（subagent A）：`emedfSchema.ts` 新增 `extractEventIdReferences`/`extractConditionGroupReferences`/`extractConditionGroupResults` 通用 helper；`validateEventIdReferences` 移除 2000:0 硬编码改为遍历所有含 `eventId` 参数指令；新增 `validateConditionGroupReferences` warning-only（`EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE` 值≤0、`EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED` 未初始化引用）；schema 缺失/未知指令静默跳过；`runEmevdDslCompilerSmoke` 新增 15 个命名断言（含 assertWarning）
  - FMG add 四层接线 + PARAM 字段级 smoke（subagent B）：`EditorMutationKind` 加 `fmg_entry_add`；capability contract fmg `mutationKinds` 加 `fmg_entry_add`；IPC `applyFmgMutation` 加 `add` 分支（复用 stage/confirm/Patch Engine 主干）；preload 类型加 `add`；`runFmgMsbIpcContractSmoke` 补四层静态断言；新建 `runParamFieldMutationSmoke.ts`（`test:param-field-mutation`，10 case）；`runParamMsbWriteIpcContractSmoke` 补 `applyParamFieldMutation` 通道断言
  - 前端工作台（subagent C）：新建 `ScriptContainerPanel.tsx`（只读证据 + 用户字节整内层替换）、`Bnd4WorkbenchPanel.tsx`、renderer-safe DTO 放 `packages/shared/src/script-container.ts` 与 `container-workbench.ts`；preload `stripPathFields` 剥离 `containerPath`/`absolutePath` 并脱敏诊断；`ParamDefPanel` 接真实行数据 + `applyParamFieldMutation` 字段级编辑（definition 源缺失时失败关闭）；App.tsx 挂载 script/bnd4 面板
  - script 容器真实闭环（主 Agent 集成）：修复 `scriptContainerEvidence` TS 侧未读 Bridge `sampleEntries` 字段导致的真实容器条目枚举断链；新建 `runNativeScriptContainerReplaceSmoke.ts`（`test:script-container-replace`）在真实 `aicommon.luabnd.dcx`（301 条目）上验证整内层替换 → Bridge 重读 → operation 回滚字节一致；`has-game-registry.json` 新增 `luabnd-primary` 角色；`runScriptContainerEvidenceSmoke` 真实分支增强
- 已验证：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:handoff-integrity`（findings 空）、`npm run bridge:build`（0 警告 0 错误）均 exit 0；本机环境注入后 `npm run bridge:verify:fmg`（addCase + menuMsgbnd 15）、`npm run bridge:verify:emevd`（1,730/33,266 含 GC）、`npm run test:emevd-plan-production`、`npm run test:script-container-replace`、`npm run test:script-container-evidence`（真实分支 301 条目/64 样本 lua-bytecode）、`npm run test:emevd-dsl-compiler`、`npm run test:emedf-schema`、`npm run test:paramdef-layout`、`npm run test:param-field-mutation`、`npm run test:fmg-msb-ipc-contract`、`npm run test:param-msb-write-ipc-contract`、`npm run test:release-editor-acceptance`、`npm run test:desktop-live-editor-contract`、`npm run test:desktop-security`、`npm run test:ui-localization` 均 exit 0
- 未验证：EMEVD 真实导入 EMEDF 的 control-flow 交叉验证与全 corpus mutation 矩阵；`fmg_entry_add` UI 入口（FmgWorkbenchPanel add 按钮）；PARAM 布局 32/33/81 与真实字段级写入；bnd4/script `scaleAccess=none` 与 fmg/param `bounded-window` 的完整有界访问；script 容器真实游戏加载；Electron 真实文档功能验收
- 非声明：control-flow 是 schema 驱动的通用启发式检查，不声明真实 Sekiro 指令布局；FMG add 接线与 PARAM 字段级 smoke 不证明 Bridge 整行写入或真实 PARAM 文档；前端面板仅静态接线 + 契约/构建验证，未做真实 Electron 功能验收；script 真实替换用等长 marker 字节（用户提供语义），不生成/反编译字节码；不含 `scope-ruling:user-approved` 标记，不支持任何 Gate 终态；`W-SCRIPT-READONLY-01` 的 `validation-unfrozen` 项已冻结为 `test:script-container-replace`
- 阻塞：无新增外部阻塞；PARAM native smoke（`bridge:verify:param`）在本轮与基线均失败（Bridge 端读取 ActionGuideParam 时 `Operation is not valid due to the current state of the object`），为既有问题，非本次改动引入

---

## 18. V0.5 完成定义

只有同时满足以下条件，才能说“V0.5 完成”：

- 文档只有一个当前实施口径；
- `REL-SCOPE` 以 `sealed-current-run` Evidence 通过，并明确冻结游戏版本、能力、操作、corpus 和 unsupported 边界；
- `REL-A`、`REL-H`、`REL-COMPLIANCE` 均保持 `in-scope` 并通过，不得以缩小功能范围排除；
- `REL-B/C/D/E/F/G/I` 各自要么在冻结范围内通过，要么按 §18.3 规则得到用户批准并以 sealed Evidence 明确排除或延期；
- 延期（`gateState=deferred` + `applicability=deferred-v0.6`）既不是完成也不是阻塞：它表示该能力已由用户裁定移出 V0.5、在 V0.6 交付。延期 Gate 不参与 V0.5 完成判定，也不得反过来阻止 V0.5 完成；但延期不清偿任何技术缺口，不得写成 `passed`、`scope-excluded` 或 `completed`，其覆盖的范围条目必须全部为 `deferred` 且 `operations=[]`；
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
| `REL-D` | script 容器（luabnd / action `*.hks`）的枚举、只读字节码证据视图与整内层文件替换读写 | corpus 范围由真实 Sekiro 证据确认；容器条目枚举与 `\x1bLuaQ` 字节码识别通过真实样本；整内层文件替换完成 stage/validate/commit/re-read/回滚与游戏加载 | 只停留在 candidate parser/inventory、借用其他游戏格式结论、执行不受信脚本、以 Hex 代替语义 parser，或把字节码反汇编呈现为可编辑源码。TAE/ESD 全量语义已延期 V0.6，不在本 Gate 通过条件内，也不得据此声称本版行为语义能力 |
| `REL-E` | 已延期 V0.6：FLVER/TPF/MTD/collision/navigation 全量语义只读与 native-to-open 导出矩阵 | 本版不判定。V0.6 恢复后仍要求五类 native 文档、引用、可视化和批准导出通过真实 corpus；无 native writer 或反向导入 | 把延期写成通过或排除；延期期间开放任何资产 writer 或反向导入；把既有 FLVER/TPF 只读预览外推成 native authority |
| `REL-F` | 五个语义编辑器（BND4/FMG/PARAM/EMEVD/script）、结构化界面 + DSL、共享只读 Hex 证据视图 | 全部读取真实 native document；BND4/FMG/PARAM/EMEVD 的 mutation typed，script 为整内层文件替换；revision 冲突失败；完整内容可通过分页/虚拟化/分块/流式访问；无 demo fallback 或 raw Hex 写入 | UI 存在但底层 authority 缺失；固定窗口截断、eager 全量物化、历史可写 Safe Hex 演示或静态测试被当作发布编辑器；容量/延迟数值不是通过条件；把 msb/tae/esd/flver 延期只读预览计入发布编辑器或开放其写入 |
| `REL-G` | OpenAI-compatible / Anthropic-compatible 双协议、允许工具集、权限模式与空配置行为 | 两类协议分别通过确定性本地 contract server 的只读/受控写、取消、超时、限额、审计和脱敏矩阵；空配置不发起网络请求并返回明确诊断；写工具复用 native validator/Patch Engine | 只覆盖单协议、空配置仍联网、模型可绕过证据或写入主干；真实 provider 账号不是通过条件 |
| `REL-H` | Windows 10/11 x64 NSIS 与 me3 capability-probe 运行范围 | NSIS manifest/hash、干净机安装、覆盖升级、卸载、Bridge/.NET/native binding、能力探测、提交后启动、日志关联、回滚后复启全部通过 | portable/自动更新被冒充范围内能力，未签名被误写成免除完整性验证，配置存在、skip、版本字符串或只启动一次 |
| `REL-I` | 已延期 V0.6：renderer-independent semantic scene、WebGPU 主路径与 WebGL2 功能回退 | 本版不判定。V0.6 恢复后仍要求在项目所有者当前机器上以真实 semantic/native projection 完成 capability probe、加载、picking、transform 更新、回退与资源释放功能闭环 | 把延期写成通过或排除；延期期间把 3D 面板当作本版发布能力；代理场景或 synthetic baseline 被当成真实资产；代表性硬件档位和性能预算不是通过条件 |
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
<!-- SOULFORGE_PROJECTION_BEGIN:scope-proposal -->

```json
{
  "schemaVersion": "2.0.0",
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
  "scopeDeferralPolicy": {
    "status": "user-approved",
    "deferredToRelease": "V0.6",
    "deferredIsNotCompleted": true,
    "deferredIsNotPermanentlyExcluded": true,
    "deferredCodeMayRemainAsMarkedPreview": true,
    "deferredPreviewMustBeReadOnly": true
  },
  "authoritySnapshotPolicy": {
    "field": "authorityAtRuling",
    "asOfEvidenceRef": "EV-REL-SCOPE-20260730",
    "liveAuthoritySource": "docs/governance/slices.json",
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
        "V0.5 收窄为 FMG / PARAM(gameparam) / EMEVD 三类文本与逻辑资源：需完成全官方语言 FMG、全部 ParamType 与 EMEVD 的 release corpus、writer、引用和游戏加载矩阵。SCOPE-MSB 已延期至 V0.6，其既有 transform 写路径必须在 V0.5 关闭。"
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
        "V0.5 收窄为 SCOPE-BEHAVIOR-SCRIPT 的只读证据视图与整个内层文件替换：HKS/Lua 经实测为 Havok Script 编译字节码（\\\\x1bLuaQ），反编译与重编译已延期至 V0.6。需完成容器条目枚举、只读字节码/常量池证据投影，以及经 Patch Engine 的整文件替换、重读与回滚。SCOPE-BEHAVIOR-ANIMATION / TAE / ESD 已延期至 V0.6。"
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
      "currentState": "deferred",
      "blockerRefs": [],
      "openRulings": [
        "整条资产线已裁定移出 V0.5、延期至 V0.6：五类 native 资产的全量只读语义 authority、引用与 native-to-open 导出矩阵均不属于 V0.5 验收。既有 FLVER/TPF/MTD 只读实现保留为标记 V0.6 预览且必须只读。"
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
      "currentState": "deferred",
      "blockerRefs": [],
      "openRulings": [
        "3D 渲染已裁定移出 V0.5、延期至 V0.6：MSB 场景与资产线同时延期后，V0.5 不再有 in-scope 的 3D 编辑目标，WebGPU 主路径/WebGL2 功能回退闭环不属于 V0.5 验收。既有 renderer-independent semantic scene 架构与 Three.js 骨架保留，不得推翻。"
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
    },
    {
      "scopeItemId": "SCOPE-PARAM",
      "capabilityId": "C-PARAM",
      "gateIds": [
        "REL-C"
      ],
      "subjectKind": "resource",
      "scope": "固定 Smithbox 2.2.4 本机 metadata 严格匹配下的 Sekiro gameparam 全部 ParamType、布局、字段与行完整读写；drawparam / gparam 延期至 V0.6",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "paramContainerScope": {
        "included": [
          "gameparam"
        ],
        "deferredToRelease": {
          "drawparam": "V0.6",
          "gparam": "V0.6"
        }
      },
      "operations": [
        "read-all-gameparam-param-types",
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
        "write-before-all-sekiro-gameparam-param-types-are-authoritative",
        "drawparam-write-in-v05",
        "gparam-write-in-v05",
        "claim-drawparam-or-gparam-as-v05-release-capability"
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
        "V0.5 收窄为 gameparam 容器内全部 ParamType 的完整读写；drawparam 与 gparam 延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。裁定时 authorityAtRuling 为 partial；固定 Smithbox 本机来源裁定不证明导入 adapter、全部布局、上游再分发权利或真实游戏验证完成。"
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
    },
    {
      "scopeItemId": "SCOPE-MSB",
      "capabilityId": "C-MSB",
      "gateIds": [
        "REL-C"
      ],
      "subjectKind": "resource",
      "scope": "登记 Sekiro MSB 实体类型的完整语义读取、CRUD、引用修复、写入、重读与回滚（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "edit-unregistered-entity",
        "unknown-entity-rewrite",
        "claim-untruncated-scene-before-validation",
        "any-msb-write-in-v05",
        "expose-set-part-transform-in-v05",
        "present-msb-panel-as-v05-release-editor"
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
        "MSB 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有 semantic scene 投影、四类实体 preview 与已验证的 set_part_transform 写路径保留在代码中，但 V0.5 必须关闭该写路径并把面板标记为 V0.6 只读预览；脱敏 m11 私有 fixture 与截断 preview 不证明 release corpus、完整场景、KRAK 组合或游戏加载完成。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "C-MSB",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "实体类型注册表覆盖 Sekiro MSB 全部实体类型；未注册类型必须继续按 edit-unregistered-entity 拒绝，不得靠默认分支放行",
        "场景截断必须先解除：当前 preview 是截断的，未经完整场景验证不得声称 CRUD 与引用修复可用",
        "写路径依赖 KRAK in-BND4 组合与重读回放；set_part_transform 已验证过的写路径必须在完整实体覆盖下重跑"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-ANIMATION",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "真实 Sekiro corpus 中行为、动画与跨资源引用清单的深度语义解析（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "borrow-other-game-format-claims",
        "raw-hex-as-semantic-authority",
        "execute-untrusted-script",
        "any-animation-or-behavior-graph-edit-in-v05",
        "claim-hkx-semantic-authority-in-v05"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "行为与动画深度解析已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件；HKX 与跨资源行为引用图在 V0.5 保持未实现，格式候选、文件名或其他游戏知识不构成 Sekiro native authority。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "D-BEHAVIOR",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "HKX 语义 authority 必须由真实 Sekiro corpus 建立，不得借用其他 FromSoftware 游戏的格式结论",
        "跨资源引用清单要能双向解析（行为图 ↔ 动画 ↔ TAE ↔ ESD），单向命中不构成引用完整性",
        "脚本执行面必须保持沙箱：execute-untrusted-script 是永久禁令，不随版本解除"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-TAE",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "Sekiro 全部 TAE 布局、事件类型、时间轴、参数与动画引用的完整读写（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "borrow-other-game-tae-layout",
        "raw-hex-write",
        "unknown-event-reencode",
        "any-tae-write-in-v05",
        "present-tae-panel-as-v05-release-editor"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-OWNER-INPUTS-IMPLEMENTATION-20260730"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "TAE 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有注册样本 native document parser（939 animations / 23,711 events / 81 event types）与只读工作台保留为标记 V0.6 只读预览，仍为 candidate，不证明完整事件语义、全部布局、writer 或真实游戏加载。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "D-BEHAVIOR",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "TAE 布局、事件类型、时间轴与参数需逐字段建立 layout authority；未知事件不得重编码（unknown-event-reencode 永久禁令）",
        "动画引用必须与 SCOPE-BEHAVIOR-ANIMATION 的引用清单对齐，否则 TAE 写入会产生悬空引用",
        "TAE 写能力开放前需要事件参数与时间轴的未知字段无损往返证据；raw-hex-write 永久禁止"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-ESD",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "Sekiro 全部 ESD 状态机、条件表达式、命令与跳转关系的完整读写（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "borrow-other-game-esd-layout",
        "raw-hex-write",
        "unknown-expression-or-command-reencode",
        "any-esd-write-in-v05",
        "present-esd-panel-as-v05-release-editor"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-OWNER-INPUTS-IMPLEMENTATION-20260730"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "ESD 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有注册样本 native document parser（36 groups / 295 states / 315 conditions 及 RPN bytecode）与只读工作台保留为标记 V0.6 只读预览，仍为 candidate，不证明表达式 schema、writer 或真实游戏加载；ESD 为二进制状态机与 RPN 字节码，不属于本轮裁定的文本类格式。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "D-BEHAVIOR",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "ESD 状态机、条件表达式、命令与跳转关系需完整解析；未知表达式或命令不得重编码（永久禁令）",
        "跳转关系要能构成闭合图并检出悬空目标，否则写入会破坏状态机可达性",
        "ESD 写能力开放前需要条件表达式与命令块的未知字段无损往返证据；raw-hex-write 永久禁止"
      ]
    },
    {
      "scopeItemId": "SCOPE-BEHAVIOR-SCRIPT",
      "capabilityId": "D-BEHAVIOR",
      "gateIds": [
        "REL-D"
      ],
      "subjectKind": "behavior-animation",
      "scope": "真实 Sekiro corpus 中 luabnd / action *.hks 脚本容器的条目枚举、只读字节码证据投影，以及经 Patch Engine 的整个内层文件替换、重读与回滚",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "operations": [
        "inventory-and-identify-script-vm",
        "enumerate-script-container-entries",
        "project-readonly-bytecode-evidence-view",
        "replace-whole-inner-file",
        "write",
        "re-read",
        "rollback",
        "game-load"
      ],
      "unsupportedOperations": [
        "execute-untrusted-script",
        "raw-bytes-as-script-authority",
        "borrow-unverified-vm-or-bytecode-claims",
        "decompile-bytecode-to-source-in-v05",
        "recompile-source-to-bytecode-in-v05",
        "typed-or-source-level-script-mutation-in-v05",
        "present-bytecode-disassembly-as-editable-source"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "V0.5 只承诺脚本容器条目枚举、只读字节码证据投影与整个内层文件替换。经实测，`action/script/*.hks` 与 luabnd 内层 `.lua` 均以 `\\\\x1bLuaQ` 开头，属 Havok Script（Lua 5.1 家族）编译字节码，不是可直接编辑的文本；`.luagnl` / `.luainfo` 为反编译辅助元数据。反编译、重编译与 typed script mutation 已延期至 V0.6。裁定时 authorityAtRuling 为 unverified；容器条目枚举、只读证据投影、writer 与真实游戏证据均待建立。"
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
    },
    {
      "scopeItemId": "SCOPE-ASSETS",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "固定 FLVER/TPF/MTD/collision/navigation 五类 native 资产只读 authority 与 native-to-open 导出矩阵（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "open-format-to-native-import",
        "raw-replace-as-native-conversion",
        "proxy-data-as-native-authority",
        "unvalidated-native-writer",
        "any-asset-export-as-v05-release-capability",
        "present-asset-panel-as-v05-release-editor"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-E-ASSET-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "整条资产只读与导出线已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有 candidate 解析与只读面板保留为标记 V0.6 只读预览；候选解析、代理几何和最小 DDS 既不证明五类 native 语义读取，也不证明导出管线完成。资产为二进制几何与纹理格式，不属于本轮裁定的文本类格式。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "五类资产（FLVER/TPF/MTD/collision/navigation）各自的只读 authority 必须分别成立；聚合条目不能靠其中一类的结论代表全部",
        "native-to-open 导出矩阵只做单向导出；open-format-to-native-import 是永久禁令",
        "任何 native writer 在缺少 validator 时不得开放（unvalidated-native-writer 永久禁令）"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-FLVER",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "Sekiro 全部 FLVER 布局的 geometry、skeleton、weights、material 引用与只读 native document（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "flver-write",
        "open-format-to-flver",
        "proxy-geometry-as-flver",
        "raw-replace-as-native-writer",
        "any-flver-export-as-v05-release-capability",
        "present-flver-panel-as-v05-release-editor"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-E-ASSET-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "FLVER 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有 header/mesh candidate parser 与只读面板保留为标记 V0.6 只读预览，仍为 candidate，不证明完整 vertex/index/skeleton/material authority 或真实渲染完成。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "geometry、skeleton、weights、material 引用需逐布局建立 authority，覆盖 Sekiro 实际出现的全部 FLVER 版本",
        "只读 native document 必须能往返比对原字节；proxy geometry 不能充当 FLVER authority",
        "flver-write 与 open-format-to-flver 是永久禁令，恢复的是只读能力而不是写能力"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-TPF",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "Sekiro 全部 TPF 布局、纹理格式、metadata 与 native texture 引用的只读文档（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "tpf-write",
        "open-format-to-tpf",
        "minimal-dds-as-tpf-authority",
        "infer-texture-metadata",
        "any-tpf-export-as-v05-release-capability",
        "present-tpf-panel-as-v05-release-editor"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "TPF 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。裁定时 authorityAtRuling 为 unverified；容器 hint、开放图像检测和最小 DDS 编码不证明 TPF parser 或纹理兼容性。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "纹理格式与 metadata 必须从 TPF 实际字节读出，禁止推断（infer-texture-metadata 永久禁令）",
        "native texture 引用要能与 MTD 的 texture slot 对齐",
        "最小 DDS 样本不构成 TPF authority；tpf-write 与 open-format-to-tpf 永久禁止"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-MTD",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "Sekiro 全部 MTD 布局、材质参数、texture slot 与着色引用的只读文档（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "mtd-write",
        "open-format-to-mtd",
        "infer-mtd-schema",
        "proxy-material-as-native",
        "any-mtd-export-as-v05-release-capability",
        "present-mtd-panel-as-v05-release-editor"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "MTD 已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。裁定时 authorityAtRuling 为 unverified；candidate inventory 不证明 native document、参数 schema 或引用闭环。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "MTD schema 必须从真实字节建立，禁止推断（infer-mtd-schema 永久禁令）",
        "texture slot 需与 SCOPE-ASSET-TPF 的 native texture 引用双向对齐",
        "mtd-write 与 open-format-to-mtd 永久禁止；proxy material 不能充当 native"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-COLLISION",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "真实 Sekiro 中全部碰撞格式、层级与地图关联的只读语义文档（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "collision-write",
        "assume-collision-format",
        "proxy-mesh-as-collision",
        "any-collision-read-as-v05-release-capability",
        "present-collision-view-as-v05-release-editor"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "碰撞已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。裁定时 authorityAtRuling 为 unverified；场景 proxy 或 FLVER candidate 不证明碰撞格式、层级或地图引用。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "碰撞格式必须先在真实 Sekiro corpus 中确认，禁止假定（assume-collision-format 永久禁令）",
        "层级与地图关联需与 MSB 侧实体对齐，否则碰撞读取无法定位到场景",
        "collision-write 永久禁止；proxy mesh 不能充当碰撞数据"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-NAVIGATION",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "真实 Sekiro 中全部导航格式、连接关系与地图引用的只读语义文档（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "navigation-write",
        "assume-navigation-format",
        "proxy-graph-as-navigation",
        "any-navigation-read-as-v05-release-capability",
        "present-navigation-view-as-v05-release-editor"
      ],
      "authorityAtRuling": "unverified",
      "evidenceRefs": [],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "导航已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。裁定时 authorityAtRuling 为 unverified；资源图、bounds 或代理图不证明导航 parser、连接语义或地图引用。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "导航格式必须先在真实 Sekiro corpus 中确认，禁止假定（assume-navigation-format 永久禁令）",
        "连接关系需构成可校验图并与地图引用对齐",
        "navigation-write 永久禁止；proxy graph 不能充当导航数据"
      ]
    },
    {
      "scopeItemId": "SCOPE-ASSET-OPEN-CONVERSION",
      "capabilityId": "E-ASSET",
      "gateIds": [
        "REL-E"
      ],
      "subjectKind": "asset",
      "scope": "FLVER/TPF/MTD native 资源到 glTF/GLB/PNG/TGA/DDS/描述清单的只读导出矩阵（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "open-format-to-native-import",
        "emit-or-replace-native-output",
        "raw-file-replace-as-conversion",
        "any-open-conversion-as-v05-release-capability"
      ],
      "authorityAtRuling": "candidate",
      "evidenceRefs": [
        "EV-E-ASSET-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "native-to-open 导出矩阵已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。现有开放格式检测、staging 与 file_replace 不证明任何已批准导出器完成，更不支持反向 native 写入。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "E-ASSET",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "导出矩阵依赖 SCOPE-ASSET-FLVER / TPF / MTD 三条的只读 authority 先成立，否则导出的是未经证实的解读",
        "导出必须只写开放格式（glTF/GLB/PNG/TGA/DDS/描述清单），不得回写或替换 native 输出（永久禁令）",
        "raw-file-replace 不构成转换；open-format-to-native-import 永久禁止"
      ]
    },
    {
      "scopeItemId": "SCOPE-EDITORS",
      "capabilityId": "F-EDITORS",
      "gateIds": [
        "REL-F"
      ],
      "subjectKind": "editor",
      "scope": "BND4、FMG、PARAM、EMEVD 四个 typed mutation 语义编辑器，script 只读证据视图加整个内层文件替换，以及共享只读 Hex 证据视图",
      "decisionStatus": "user-approved",
      "proposedSupport": "supported",
      "editorIds": [
        "bnd4",
        "fmg",
        "param",
        "emevd",
        "script"
      ],
      "editorMutationModes": {
        "bnd4": "typed-mutation",
        "fmg": "typed-mutation",
        "param": "typed-mutation",
        "emevd": "typed-mutation",
        "script": "whole-inner-file-replacement"
      },
      "deferredPreviewEditors": {
        "editorIds": [
          "msb",
          "tae",
          "esd",
          "flver"
        ],
        "deferredToRelease": "V0.6",
        "readOnly": true,
        "markedAsPreview": true,
        "countedAsReleaseEditor": false
      },
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
        "show-readonly-hex-evidence",
        "mark-deferred-editor-as-v06-readonly-preview"
      ],
      "unsupportedOperations": [
        "raw-hex-edit",
        "demo-fallback-as-authority",
        "renderer-state-as-document",
        "editor-without-native-authority",
        "quantitative-capacity-or-latency-threshold-as-v05-gate",
        "count-deferred-preview-editor-as-v05-release-editor",
        "expose-write-path-in-deferred-preview-editor",
        "claim-script-editor-as-typed-mutation"
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
        "V0.5 冻结编辑器收窄为 bnd4、fmg、param、emevd、script 五个；其中 script 只提供只读证据视图与整个内层文件替换，不属于 typed mutation。msb、tae、esd、flver 面板延期至 V0.6，保留为标记只读预览，不计入 V0.5 冻结清单，也不得暴露写路径（含 MSB `set_part_transform`）。裁定时 authorityAtRuling 为 partial；候选面板、Safe Hex 演示和静态契约不证明真实文档、DSL、完整有界访问或 Electron 功能验收完成；容量与延迟数值不属于 V0.5 验收。"
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
    },
    {
      "scopeItemId": "SCOPE-RENDERING",
      "capabilityId": "I-RENDER",
      "gateIds": [
        "REL-I"
      ],
      "subjectKind": "rendering",
      "scope": "renderer-independent semantic scene、Three.js WebGPU 主后端与 WebGL2 自动回退（延期至 V0.6）",
      "decisionStatus": "user-approved",
      "proposedSupport": "deferred",
      "deferredToRelease": "V0.6",
      "operations": [],
      "unsupportedOperations": [
        "renderer-object-as-authority",
        "synthetic-budget-as-release-threshold",
        "proxy-scene-as-native-asset-proof",
        "representative-hardware-tier-acceptance",
        "performance-budget-as-v05-gate",
        "any-3d-rendering-as-v05-release-capability",
        "present-3d-viewport-as-v05-release-editor"
      ],
      "authorityAtRuling": "partial",
      "evidenceRefs": [
        "EV-C-MSB-SCENE-20260724",
        "EV-I-RENDER-7BD"
      ],
      "registryRefs": [],
      "openRulings": [],
      "nonClaims": [
        "3D 渲染线已延期至 V0.6，不属于 V0.5 支持范围也不属于 V0.5 完成条件。既有 semantic scene、WebGPU/WebGL2 后端与视口保留为标记 V0.6 只读预览；裁定时 authorityAtRuling 为 partial，当前机器功能 smoke 不证明代表性硬件兼容或性能水平。"
      ],
      "targetRelease": "V0.5",
      "deferredTrack": "I-RENDER",
      "resumeRequires": [
        "按 scopeDeferralPolicy 走通用承接流程（用户裁定改回 supported、同步 gates/slices 脱离 deferred、补齐 parser/writer/validator/恢复与 authority 门槛、重新封存 Evidence）",
        "semantic scene 必须保持 renderer-independent：THREE.Object3D、其他 renderer object 与 React 状态永远不能成为权威场景文档（永久禁令）",
        "WebGPU 主后端与 WebGL2 自动回退需在真实硬件上分别验证；representative-hardware-tier 验收不成立（永久禁令）",
        "性能预算必须来自真实资源基准，synthetic 预算不能当 release 阈值；预算成立后才可作为 Gate 判据",
        "场景数据依赖 SCOPE-MSB 的完整实体覆盖，截断场景不能证明渲染能力"
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
      ],
      "targetRelease": "V0.5",
      "deferredToRelease": null,
      "deferredTrack": null,
      "resumeRequires": []
    }
  ]
}
```

<!-- SOULFORGE_PROJECTION_END:scope-proposal -->
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

<!-- SOULFORGE_PROJECTION_BEGIN:gate-matrix -->

| Gate ID | capability | 当前切片 | gateState | applicability | Evidence/blockerRefs | 后继要求 |
|---|---|---|---|---|---|---|
| `REL-SCOPE` | V0.5 范围冻结 | `W-REL-SCOPE-RULING-05` | `passed` | `in-scope` | `EV-REL-SCOPE-20260731-TEXT-FIRST`、`EV-REL-SCOPE-20260801-GOVERNANCE-JSON`、`EV-REL-SCOPE-20260801-SEAL-CLI`、`EV-REL-SCOPE-20260801-HANDOFF-PROJECTION`、`EV-REL-SCOPE-20260801-SCOPE-PROJECTION`、`EV-REL-SCOPE-20260801-COMMAND-INDEX`、`EV-REL-SCOPE-20260801-PARSER-REGISTRY`、`EV-REL-SCOPE-20260801-DIAGNOSTIC-ROOTCAUSE`、`EV-REL-SCOPE-20260801-CLI-CLOSURE`、`EV-REL-SCOPE-20260801-RELEASE-SCOPING`、`EV-REL-SCOPE-20260801-EMPTY-GUIDANCE`、`EV-REL-SCOPE-20260801-COMMAND-EXISTENCE`、`EV-REL-SCOPE-20260802-SEAL-COMMIT-WARNING`、`EV-REL-SCOPE-20260802-UNCOMMITTED-PATH-FIX`、`EV-REL-SCOPE-20260802-DEFERRED-RESUME-PROJECTION`、`EV-REL-SCOPE-20260802-ENTRYPOINT-OPENABLE`、`EV-REL-SCOPE-20260802-CONSTRAINT-SPEC`、`EV-REL-SCOPE-20260802-STALE-CLAIM-VISIBILITY`、`EV-REL-SCOPE-20260802-FIXTURE-RESTORE`、`EV-REL-SCOPE-20260802-FIXTURE-PREMISE`、`EV-REL-SCOPE-20260802-EMPTY-CLAIM-STATE`、`EV-REL-SCOPE-20260802-STATUS-STALENESS`、`EV-REL-SCOPE-20260802-PROCESS-SELF-OPTIMIZATION` | 27 项范围矩阵继续冻结，其中 12 项已裁定延期 V0.6（`SCOPE-MSB`、animation/TAE/ESD 三项、资产线 7 项、`SCOPE-RENDERING`）；V0.5 收窄为 BND4/FMG/PARAM(gameparam)/EMEVD/script 五编辑器的文本优先边界，script 为只读 + 整内层文件替换；Sekiro 1.6 版本族、只读 Hex、固定 Smithbox 本机 metadata、空模型凭据、无编辑器/installer 量化预算与允许未签名 NSIS 的内部测试边界不变；工程复核与普通工程提交不得触发用户重新授权 |
| `REL-A` | 全部 writer 与事务 | `W-A-RECOVERY-INTEGRATION-04` | `open` | `in-scope` | — | BND4/FMG/PARAM 12 case + EMEVD/MSB 8 case 已通过；继续真实断电/大容量/安装升级恢复 |
| `REL-B` | 容器发布 corpus | `W-REL-B-CORPUS-02` | `open` | `in-scope` | — | KRAK 重压/写回/roundtrip 已完成；继续组合 mutation/repack 和完整 corpus 验证 |
| `REL-C` | 核心语义 mutation 矩阵 | `W-EMEVD-FULL-01`、`W-EMEVD-FMG-PARAM-03` | `open` | `in-scope` | — | EMEVD DSL plan 的 production Bridge/PatchIR transaction 接线已完成；继续完整 EMEDF schema/control-flow、DSL 全局指令级 mutation、UI submit 接线；并行继续 FMG 全语言、全部 ParamType、MSB 实体和回滚 |
| `REL-D` | 行为动画范围 | `W-BEHAVIOR-MAP-01` | `open` | `in-scope` | — | 本 Gate 的 4 个范围条目中 animation/TAE/ESD 三项已延期 V0.6，仅 `SCOPE-BEHAVIOR-SCRIPT` 留在 V0.5，因此 Gate 保持 open 而非 deferred；后继只要求 script 容器只读证据视图与整内层文件替换的写/重读/回滚/游戏加载闭环。TAE/ESD 登记样本 native document 与延期预览面板保留只读，不得据此声称本版行为语义能力 |
| `REL-E` | 资产只读与导出矩阵 | `W-FLVER-READ-01` | `deferred` | `deferred-v0.6` | `EV-REL-SCOPE-20260731-TEXT-FIRST`、`EV-REL-SCOPE-20260801-GOVERNANCE-JSON`、`EV-REL-SCOPE-20260801-SEAL-CLI`、`EV-REL-SCOPE-20260801-HANDOFF-PROJECTION`、`EV-REL-SCOPE-20260801-SCOPE-PROJECTION`、`EV-REL-SCOPE-20260801-COMMAND-INDEX`、`EV-REL-SCOPE-20260801-PARSER-REGISTRY`、`EV-REL-SCOPE-20260801-DIAGNOSTIC-ROOTCAUSE`、`EV-REL-SCOPE-20260801-CLI-CLOSURE`、`EV-REL-SCOPE-20260801-RELEASE-SCOPING`、`EV-REL-SCOPE-20260801-EMPTY-GUIDANCE`、`EV-REL-SCOPE-20260801-COMMAND-EXISTENCE`、`EV-REL-SCOPE-20260802-SEAL-COMMIT-WARNING`、`EV-REL-SCOPE-20260802-UNCOMMITTED-PATH-FIX`、`EV-REL-SCOPE-20260802-DEFERRED-RESUME-PROJECTION`、`EV-REL-SCOPE-20260802-ENTRYPOINT-OPENABLE`、`EV-REL-SCOPE-20260802-CONSTRAINT-SPEC`、`EV-REL-SCOPE-20260802-STALE-CLAIM-VISIBILITY`、`EV-REL-SCOPE-20260802-FIXTURE-RESTORE`、`EV-REL-SCOPE-20260802-FIXTURE-PREMISE`、`EV-REL-SCOPE-20260802-EMPTY-CLAIM-STATE`、`EV-REL-SCOPE-20260802-STATUS-STALENESS`、`EV-REL-SCOPE-20260802-PROCESS-SELF-OPTIMIZATION` | 整条资产线延期至 V0.6。既有 FLVER/TPF 登记样本 native document、MTD 只读投影与 GLB/PNG/TGA/DDS 导出保留为标记 V0.6 预览且必须只读；V0.6 恢复时继续 collision/navigation、完整引用和五类只读/导出闭环 |
| `REL-F` | 编辑器验收 | `W-REL-F-SCALE-02` | `open` | `in-scope` | — | inventory 已精确冻结为 BND4/FMG/PARAM/EMEVD/script 五项（script 为只读 + 整内层文件替换）；继续 BND4/script 工作台、各编辑器结构化 UI/DSL/完整有界访问和 Electron 真实文档功能验收。msb/tae/esd/flver 为 V0.6 延期只读预览，不计入本 Gate 验收，其写入路径必须在 contract、shared 清单与主进程 IPC 三层失败关闭 |
| `REL-G` | 双协议 AI | `W-AI-CONFORMANCE-03` | `open` | `in-scope` | — | 错误/取消/超时/限额 10 case 已完成；继续真实工作区多步 typed mutation 矩阵 |
| `REL-H` | 安装与运行 | `W-ME3-INSTALL-04` | `open` | `in-scope` | — | profile/launch/terminate adapter 已完成；继续 NSIS 安装/升级/卸载和真实 Sekiro 会话 |
| `REL-I` | 渲染功能闭环 | `W-RENDER-FUNCTIONAL-02` | `deferred` | `deferred-v0.6` | `EV-REL-SCOPE-20260731-TEXT-FIRST`、`EV-REL-SCOPE-20260801-GOVERNANCE-JSON`、`EV-REL-SCOPE-20260801-SEAL-CLI`、`EV-REL-SCOPE-20260801-HANDOFF-PROJECTION`、`EV-REL-SCOPE-20260801-SCOPE-PROJECTION`、`EV-REL-SCOPE-20260801-COMMAND-INDEX`、`EV-REL-SCOPE-20260801-PARSER-REGISTRY`、`EV-REL-SCOPE-20260801-DIAGNOSTIC-ROOTCAUSE`、`EV-REL-SCOPE-20260801-CLI-CLOSURE`、`EV-REL-SCOPE-20260801-RELEASE-SCOPING`、`EV-REL-SCOPE-20260801-EMPTY-GUIDANCE`、`EV-REL-SCOPE-20260801-COMMAND-EXISTENCE`、`EV-REL-SCOPE-20260802-SEAL-COMMIT-WARNING`、`EV-REL-SCOPE-20260802-UNCOMMITTED-PATH-FIX`、`EV-REL-SCOPE-20260802-DEFERRED-RESUME-PROJECTION`、`EV-REL-SCOPE-20260802-ENTRYPOINT-OPENABLE`、`EV-REL-SCOPE-20260802-CONSTRAINT-SPEC`、`EV-REL-SCOPE-20260802-STALE-CLAIM-VISIBILITY`、`EV-REL-SCOPE-20260802-FIXTURE-RESTORE`、`EV-REL-SCOPE-20260802-FIXTURE-PREMISE`、`EV-REL-SCOPE-20260802-EMPTY-CLAIM-STATE`、`EV-REL-SCOPE-20260802-STATUS-STALENESS`、`EV-REL-SCOPE-20260802-PROCESS-SELF-OPTIMIZATION` | 3D 渲染延期至 V0.6。MSB 与资产线同时延期后，V0.5 无 `in-scope` 3D 编辑目标。renderer-independent semantic scene、render packet 与 Three.js WebGPU/WebGL2 骨架保留不推翻；V0.6 恢复时继续真实 FLVER 渲染、picking、transform 更新与资源释放闭环 |
| `REL-COMPLIANCE` | 内部测试构建合规 | `W-REL-COMPLIANCE-02` | `open` | `in-scope` | — | 许可证文本 complete + NSIS 构建已完成；继续 installer lifecycle 验证和 package tree 扫描 |

<!-- SOULFORGE_PROJECTION_END:gate-matrix -->

后继要求列不是第二套进度口径；它只提示同一 Gate 在既有切片完成后仍需的下游切片。补货规则见 `docs/AGENT_EXECUTION_PLAYBOOK.md` §8，全阻塞终局见其 §9。

### 18.4 结构化 blocker 注册表

blocker `reason` 只允许：`private-corpus | credential | hardware | user-ruling | toolchain | license | upstream | prerequisite-authority`。每个 `blocked` 切片和 Gate 都必须通过 blockerRefs 引用本表中已定义 ID；解除 blocker 之前必须取得“所需输入”并通过“解锁验证”，不能只因时间经过或口头判断改回 `ready` / `open`。Evidence 可以是 sealed、unsealed 或 historical 记录，用于说明阻塞边界；只有 sealed Evidence 可以支持 Gate 终态。

表中标注“历史、当前无活动引用”的行只保留审计与未来范围变更触发器，不属于当前 blocker，也不得出现在“需要用户处理”的报告中。当前阻塞状态只由 §13.1 / §18.3 的活动 `blockerRefs` 判定。

<!-- SOULFORGE_PROJECTION_BEGIN:blocker-index -->

| blockerId | reason | 影响 Gate/切片 | 责任方 | 所需输入 | 解锁验证 | 复查触发器 | Evidence |
|---|---|---|---|---|---|---|---|
| `BLK-NATIVE-FIXTURE-CORPUS` | `private-corpus` | 历史：`REL-A`、`W-A-RECOVERY-NATIVE-02`、`W-PARAM-META-NATIVE-01`；当前无活动引用 | 历史记录；当前由工程方消费既有本机 registry | 已解除：合法仓库外 locator registry、内容哈希和 native/PARAM 样本已可用 | private native gate 实际运行并保持 partial；未通过项转为工程切片，不能因 registry 存在而冒充完成 | 本机 registry/内容版本变化或用户撤回访问时重新打开 | `EV-A-RECOVERY-20260724`、`EV-C-PARAM-7BD`、`EV-PUBLIC-CONTRACTS-20260725`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-PARAM-METADATA-SOURCE` | `license` | 历史：`W-PARAM-META-SOURCE-02`；当前无活动引用 | 历史记录；当前 adapter 已完成 | 已解除：固定 Smithbox 2.2.4 本机导入、commit/release/archive/tree/license digest 与不再分发边界 | `npm run test:smithbox-param-metadata-source` 覆盖真实导入及缺失/错版/篡改/升级/撤回；导入数据仍在仓库外 | 用户修改来源、版本或再分发边界时重新打开 | `EV-PUBLIC-CONTRACTS-20260725`、`EV-REL-SCOPE-20260730-OWNER-INPUTS`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-EMEVD-LAYER-CORPUS` | `private-corpus` | 历史：`W-EMEVD-LAYER-01`；当前无活动引用 | 历史记录；当前由工程方在既有 corpus 内发现 | 已解除用户输入：合法仓库外 corpus root/registry 已可用；目标变体未命中时保持工程缺口 | 带哈希 `layerCount` != 0 case 的只读解析、no-op roundtrip 和冲突失败关闭断言通过 | 本机 corpus 被撤回或后续确认目标变体确实不存在且需范围裁定时重新打开 | `EV-C-EMEVD-DSL-20260724`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-BEHAVIOR-CORPUS` | `private-corpus` | 历史：`REL-D`、`W-BEHAVIOR-MAP-01`；当前无活动引用 | 历史记录；当前由工程方推进 | 已解除用户输入：本机 registry 已支持登记 TAE/ESD native document，并观察到 HKX/Lua 条目 | TAE/ESD 已延期 V0.6，其完整语义不再是 V0.5 通过条件；V0.5 只在 `W-BEHAVIOR-MAP-01` / `W-SCRIPT-READONLY-01` 对 script 容器枚举、字节码识别与整内层文件替换失败关闭 | 本机 corpus 被撤回、新增声明变体，或 V0.6 恢复 TAE/ESD 时重新打开 | `EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-REL-SCOPE-20260731-TEXT-FIRST` |
| `BLK-ASSET-CORPUS` | `private-corpus` | 历史：`REL-E`、`W-FLVER-READ-01`；当前无活动引用 | 历史记录；整条资产线已延期 V0.6 | 已解除用户输入：本机 registry 已支持登记 FLVER/TPF native document，其他声明资产由工程方继续定位 | 资产线已延期，本版不判定；既有 FLVER/TPF 只读覆盖保持 partial 且必须只读。V0.6 恢复后 MTD/collision/navigation、完整材质/引用、边界诊断和全 corpus no-op 继续失败关闭 | 本机 corpus 被撤回、新增声明变体，或 V0.6 恢复资产线时重新打开 | `EV-E-ASSET-7BD`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730`、`EV-REL-SCOPE-20260731-TEXT-FIRST` |
| `BLK-REL-B-CORPUS` | `private-corpus` | 历史：`REL-B`、`W-REL-B-CORPUS-01`；当前无活动引用 | 历史记录；当前由工程方推进 | 已解除：仓库外 sekiro-1-6-owner-corpus-v1 已生成并覆盖当前 DFLT/BND4/KRAK 集合 | 214/214 分类与 read/no-op/CRUD 已执行，且一个登记 KRAK rename/repack/roundtrip 已独立验证；组合 mutation、未知字段保持、恢复和完整 corpus 写回继续失败关闭 | registry/内容版本变化、用户撤回访问或新增变体时重新打开 | `EV-B-DFLT-7BD`、`EV-B-BND4-7BD`、`EV-B-KRAK-20260724`、`EV-OWNER-INPUTS-IMPLEMENTATION-20260730` |
| `BLK-MODEL-CREDENTIALS` | `credential` | 历史：`W-AI-REAL-01`；当前无活动引用 | 历史记录；用户无需提供 | 已解除：默认配置留空，真实 provider endpoint/key 不属于 V0.5 验收 | `W-AI-REAL-01` 已被取代；`W-AI-CONFORMANCE-02` 已在本地 contract servers 上完成并保持 partial，不证明第三方服务 | 用户日后主动把真实 provider live smoke 加回范围时重新打开 | `EV-G-FAKE-7BD`、`EV-REL-SCOPE-20260730-OWNER-INPUTS` |
| `BLK-RENDER-HARDWARE` | `hardware` | 历史：`W-RENDER-BENCH-01`；当前无活动引用 | 历史记录；用户无需提供 | 已解除：代表性硬件档位、地图性能基准和量化预算不属于 V0.5 验收 | `W-RENDER-BENCH-01` 已被取代；渲染线已延期 V0.6，`W-RENDER-FUNCTIONAL-02` 为 deferred，本版不判定渲染功能闭环 | 用户日后主动把硬件/性能矩阵加回范围，或 V0.6 恢复渲染线时重新打开 | `EV-I-RENDER-7BD`、`EV-REL-SCOPE-20260730-OWNER-INPUTS`、`EV-REL-SCOPE-20260731-TEXT-FIRST` |
| `BLK-SCOPE-RULING` | `user-ruling` | 历史：`REL-SCOPE`、`W-REL-SCOPE-RULING-01`、`W-REL-SCOPE-RULING-02`、`W-REL-SCOPE-RULING-03`、`W-REL-SCOPE-RULING-04`、`W-REL-SCOPE-RULING-05`；当前无活动引用 | 用户 | 已完成：V0.5 支持/排除矩阵、未签名 NSIS、固定 Smithbox 本机 metadata、空 provider 凭据、功能性渲染边界、无编辑器/installer 量化预算，以及文本优先收窄与 12 项范围条目延期 V0.6 均已批准 | `npm run test:release-scope` exit 0，且 `REL-SCOPE` 引用带 `scope-ruling:user-approved` 的 fresh sealed Evidence；延期 Gate 引用带对应 scope-deferral:<GateId>:V0.6:user-approved 的 fresh sealed Evidence | 用户新增或修改任何冻结范围裁定，或要求把已延期能力提前拉回 V0.5 | `EV-REL-SCOPE-20260730`、`EV-REL-SCOPE-20260730-UNSIGNED`、`EV-REL-SCOPE-20260730-OWNER-INPUTS`、`EV-REL-SCOPE-20260730-NO-QUANT-BUDGETS`、`EV-AUTONOMOUS-GOVERNANCE-20260731`、`EV-AUTONOMOUS-GOVERNANCE-20260731-REVIEW-OWNER`、`EV-REL-SCOPE-20260731-TEXT-FIRST` |

<!-- SOULFORGE_PROJECTION_END:blocker-index -->

### 18.5 V0.6 延期承接索引

本节是**派生索引**，不是新的 milestone、范围口径或进度文档。唯一权威仍是 §18.2.1 范围矩阵的 `proposedSupport=deferred` + `deferredToRelease` 字段、§18.3 的 `gateState=deferred` 与 §13.1 的 `lifecycle=deferred`。本节只把这些已有记录汇总成可读清单，避免接手者从散落条目里反推 V0.6 范围。

`npm run test:v06-deferral-index` 校验本节与上述权威记录逐项一致：条目缺失、多写、目标版本不符或权威侧状态变化后未同步，都会失败关闭。因此本节不能成为独立漂移的第二口径。

延期到 V0.6 的 12 个范围条目（全部 `operations=[]`，`authorityAtRuling` 为裁定当时的真实上限，不是承诺）：

| 范围条目 | 目标版本 | 裁定时 authority | 归属线 |
|---|---|---|---|
| `SCOPE-MSB` | V0.6 | `partial` | C-MSB |
| `SCOPE-BEHAVIOR-ANIMATION` | V0.6 | `unverified` | D-BEHAVIOR |
| `SCOPE-BEHAVIOR-TAE` | V0.6 | `candidate` | D-BEHAVIOR |
| `SCOPE-BEHAVIOR-ESD` | V0.6 | `candidate` | D-BEHAVIOR |
| `SCOPE-ASSETS` | V0.6 | `candidate` | E-ASSET |
| `SCOPE-ASSET-FLVER` | V0.6 | `candidate` | E-ASSET |
| `SCOPE-ASSET-TPF` | V0.6 | `unverified` | E-ASSET |
| `SCOPE-ASSET-MTD` | V0.6 | `unverified` | E-ASSET |
| `SCOPE-ASSET-COLLISION` | V0.6 | `unverified` | E-ASSET |
| `SCOPE-ASSET-NAVIGATION` | V0.6 | `unverified` | E-ASSET |
| `SCOPE-ASSET-OPEN-CONVERSION` | V0.6 | `candidate` | E-ASSET |
| `SCOPE-RENDERING` | V0.6 | `partial` | I-RENDER |

延期 Gate：`REL-E`（资产只读与导出矩阵）、`REL-I`（渲染功能闭环）。两者均为 `gateState=deferred` + `applicability=deferred-v0.6`，本版不判定，也不阻止 V0.5 完成。`REL-C` 与 `REL-D` 保持 `open`：它们各自仍有留在 V0.5 的支持条目（EMEVD/FMG/PARAM 与 `SCOPE-BEHAVIOR-SCRIPT`），因此不整体延期。

延期切片：`W-MSB-SCENE-01`、`W-FLVER-READ-01`、`W-RENDER-FUNCTIONAL-02`（均 `lifecycle=deferred`）。

延期只读预览编辑器：`msb`、`tae`、`esd`、`flver`。四者已实现的读取与投影保留并在 UI 标记为 V0.6 预览，`countedAsReleaseEditor=false`，写入在 `editorCapabilityContract.releaseWriteEnabled`、`@soulforge/shared` 的 `DEFERRED_PREVIEW_EDITOR_KINDS` 与主进程 `EDITOR_DEFERRED_TO_V06_READONLY` 三层失败关闭。

V0.6 恢复任一条目时的强制顺序：

1. 取得用户裁定，把范围条目从 `deferred` 改回 `supported` 并写回真实 `operations`；
2. 同步 §18.3 Gate 与 §13.1 切片脱离 `deferred`，其 `required validation` 重新进入 §13.4 未冻结清单；
3. 需要写能力时，先补齐对应 parser / writer / validator / 恢复与 authority 门槛，再翻开 `releaseWriteEnabled`；
4. 重新封存 Evidence。**已延期期间保留的"曾经验证过"记录（如 MSB `msb_set_part_transform`）不能直接当作恢复后的验证证据，必须重跑。**

延期不清偿技术缺口，不降低 native authority、验证、回滚或生态集成标准。

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

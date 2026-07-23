# SoulForge V0.5 实施交接书

> 文档性质：唯一实施规范、技术线路图与工程交接。  
> 目标读者：接手 SoulForge 的开发 Agent / 工程师。  
> 当前基准日期：2026-07-20。  
> 当前仓库基线：`7bd354d`；任何接手者都必须以真实 `HEAD`、工作树和测试结果重新核对。  
> 产品定位：**魂游 Mod 的 Cursor**。

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

1. 先阅读根目录 `AGENTS.md`。
2. 阅读本文的全局线路图、当前技术前沿和与本次修改相关的区域地图。
3. 检查 `git status`、`HEAD`、本机环境和相关测试。
4. 根据依赖关系、真实证据、风险和当前可用环境，自主选择合理推进路径。
5. 修改完成后更新本文对应路线的状态与“实施证据记录”。
6. 不新建平行的 milestone、fork、next-actions、project-state、task 或 status 文档。

第一次接手项目时应全文阅读。后续连续开发可以重点阅读：

- 全局线路图；
- 当前技术前沿；
- 相关区域地图；
- 最近的实施证据记录；
- 相关稳定技术规格。

本文描述的是当前认知。真实 native 样本与本文冲突时，停止冲突能力的权威声明，记录证据，再修正地图；不得为了维持文档结论而忽略样本。

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

### 2.2 唯一写入主干

所有 Mod 资源写入必须经过：

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

禁止在 Patch Engine 外直接使用 `fs.writeFile` 修改 Mod 资源。writer 和 converter 只能输出到 main 控制的暂存根。

### 2.3 Authority 分层

统一使用以下标签：

| 标签 | 含义 |
|---|---|
| `unsupported` | 已明确不支持，返回结构化诊断 |
| `candidate` | 基于头部、字段或少量样本的候选推断 |
| `fixture-confirmed` | 仅 synthetic / 构造样本成立 |
| `partial` | 已有真实能力，但格式、操作或 corpus 覆盖不完整 |
| `native-verified` | 在声明范围内有真实样本、往返、写入和重读证据 |
| `blocked` | 受外部环境、缺失运行库或前置格式阻塞 |
| `unverified` | 实现存在，但尚未得到所需运行证据 |

状态必须写清作用范围。例如“MSB partial”必须说明已覆盖哪些实体、哪些 mutation、哪些 corpus，不能只写一个模糊标签。

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
│  ├─ Safe Hex
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

---

## 4. A 线：工作区、安全写入与恢复

### 目标

建立所有格式、编辑器和 AI 共用的可信修改底座。

### 当前状态：`native-verified / partial hardening`

已经具备：

- Electron sandbox、CSP、导航、窗口、权限和 IPC sender 边界；
- main 持有目录选择和高风险确认；
- Mod 覆盖层可写、原版目录只读；
- canonical / realpath / junction 越界防护；
- PatchIR + `WorkspaceTransaction` production commit 主干；
- text、raw range、whole-file 和 container child 修改路径；
- 暂存、hash 前置条件、备份、原子替换、提交后重读；
- operation、file、resource-entry inverse transaction 基础；
- SQLite 两库、WAL、migration checksum、operation journal、恢复点、审计、文件索引、FTS、诊断和后台任务基础；
- Bridge daemon 长连接、超时、取消、崩溃失败关闭和不自动重放；
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

已有证据：

- 144 个 DFLT 样本完整解压、重压和重读；
- 已记录两个实际变体；
- payload hash 与变体保持验证；
- DFLT 外层 BND4 production writer 已接入暂存写入主干。

### BND4 over DFLT

状态：`native-verified / corpus partial`

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

状态：`blocked`

已经具备：

- 从用户选择的 Sekiro 游戏目录发现 Oodle runtime；
- 目录、PE x64、主版本、导出和动态加载校验；
- 缺失、版本错误、导出缺失和加载失败的结构化诊断；
- 不分发、复制或提交 Oodle DLL；
- KRAK 只读路径在运行库满足条件时调用 Oodle。

当前阻塞：

- 基线机器没有合法 Sekiro Oodle runtime；
- 70 个 KRAK 样本成功解压和 KRAK 内 BND4 corpus 尚未验证；
- KRAK 重压和 writer authority 未开放。

失败关闭不等于 KRAK 成功路径完成。

---

## 6. C 线：核心语义资源

### FMG

状态：`native-verified / scope partial`

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

已有：

- 紧凑布局 PARAM 读取、raw row CRUD、写入、提交和回滚；
- 38/40 历史抽样通过；
- 用户派生 `ParamDefDocument` 布局校验和字段 decode/encode；
- 桌面表格、复制行和原生 smoke。

当前重点不是为了形式完整而优先追逐“原生 `.paramdef` 二进制”。Sekiro 的实用 metadata 主线应是：

- Paramdex-compatible definitions；
- 字段名、类型、枚举和引用；
- definition 与 ParamType、版本、row size 的严格匹配；
- 游戏适配包内 metadata 版本；
- 用户 overlay 与冲突诊断。

仍缺：

- 旧 header-embedded type name 变体；
- Paramdex-compatible authority 接入；
- 完整字段级 writer 与引用验证；
- 全 corpus 与真实游戏验证。

### EMEVD

状态：`partial，结构与主要 mutation 已有真实证据`

已有：

- 正确 Sekiro header；
- 历史样本 1730 events / 33266 instructions；
- event id、rest behavior；
- instruction table、args 和 parameter bank；
- 等长与变长 args 重建；
- add、delete、duplicate event 与 GC；
- 桌面实时 IPC 和四视图投影；
- typed EMEDF fixture；
- Patch Engine 提交和重读路径。

仍缺：

- `layerCount != 0` 等未覆盖变体；
- 完整 Sekiro EMEDF schema 与类型覆盖；
- 全 corpus mutation matrix；
- KRAK 包装样本；
- 可写 DSL compiler；
- 真实游戏加载验证。

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

已有：

- Sekiro MSB envelope；
- models、parts；
- POINT regions；
- 部分 EVENT 记录；
- part / region position 写回；
- 桌面实时读取、位置微调和 Patch Engine 提交；
- scene manifest、renderer-safe nodes 和 candidate 资产引用。

仍缺：

- 全实体类型与未知数据无损建模；
- entity add/delete/reorder/type conversion；
- 引用修复；
- transform 之外的完整 mutation；
- KRAK corpus；
- 完整原生 scene projection；
- 真实游戏加载验证。

---

## 7. D 线：行为与动画

状态：`not-started / corpus research required`

该路线正式纳入 SoulForge 长期地图，不能被场景资产线遮蔽。

目标能力包括：

- TAE / animation event 文档与时间轴；
- ESD state machine 查看、编辑和图投影；
- animation、behavior、event、param、map entity 之间的引用；
- 角色招式链和动作逻辑；
- Lua、HKS 或其他 Sekiro 脚本资源的真实格式确认；
- 与 EMEVD、MSB、PARAM 和资产的跨资源 patch graph。

具体 Sekiro 格式范围必须从私有 corpus、公开格式知识和可验证行为中确认。不得仅凭其他 FromSoftware 游戏的格式列表宣称 Sekiro 支持。

该路线可以与场景资产线并行研究，但任何 writer 都要复用 A 线的 PatchIR 和回滚主干。

---

## 8. E 线：场景与资产

状态：`partial / candidate`

已有：

- MSB semantic scene manifest；
- Three.js 代理几何；
- FLVER header 和 mesh table candidate；
- glTF/GLB/PNG/TGA/DDS 检测与暂存；
- 最小 raw RGBA8 -> DDS 编码器；
- 资产导入经 PatchIR `file_replace` 写回；
- candidate model/material inventory。

仍缺：

- 真实 FLVER vertex/index/layout/skeleton/material authority；
- TPF、MTD 和纹理解析链；
- native model/material/texture writer；
- collision、navigation 和地图资源关联；
- 开放格式到 Sekiro 原生格式的完整转换；
- 大型真实场景性能和显存管理；
- 真实游戏加载验证。

资产导入路线保留，不因项目周期长而缩减。与此同时，行为与动画路线必须作为同等级主线推进。

---

## 9. F 线：专业编辑器

状态：`partial`

已经具备或已有骨架：

- 统一 `EditorDocumentStore` 与 revision/mutation 协议；
- Safe Hex 文档模型和桌面面板；
- EMEVD 四视图；
- PARAM / ParamDef 面板；
- FMG 工作台；
- MSB 3D 代理场景和位置微调；
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

---

## 10. G 线：AI Agent

状态：`partial / production unverified`

已有：

- OpenAI-compatible Chat Completions adapter；
- OpenAI Responses adapter；
- Anthropic Messages adapter；
- fake HTTP/SSE tool loops；
- plan / normal / full permission gates；
- 完全权限仍返回 Patch Engine required；
- safeStorage vault、main-only key resolution、IPC 设置面板和审计基础。

仍缺：

- 真实 OpenAI-compatible 与 Anthropic-compatible 手工 smoke；
- 完整 Context Broker / evidence bundle；
- production typed tool registry；
- outbound context 审计和内容最小化；
- 真实工作区多步 Agent 任务；
- 错误恢复、取消、限额和模型服务迁移。

AI 无充分证据时必须返回 `insufficient_evidence`。任何模型服务都不能绕过 Patch Engine、native validator、备份、审计和回滚。

---

## 11. H 线：运行、验证与发行

### me3 runtime adapter

状态：`unverified foundation`

SoulForge 不实现自己的 Mod loader 或注入器。Sekiro 首选正式集成 me3，并抽象通用运行接口：

~~~ts
interface GameRuntimeAdapter {
  detect(): Promise<RuntimeCapability>;
  prepareProfile(
    workspace: WorkspaceSession,
    options?: PrepareRuntimeProfileOptions
  ): Promise<RuntimeProfile>;
  launch(profile: RuntimeProfile, options?: LaunchRuntimeOptions): Promise<LaunchSession>;
  collectDiagnostics(session: LaunchSession): Promise<RuntimeDiagnostics>;
  terminate(session: LaunchSession): Promise<void>;
}
~~~

当前 core foundation 已具备：

- 通用 runtime capability、profile、launch session、process snapshot 和 diagnostics 契约；
- 公开 `TrustedMe3RuntimeAdapter` 强制由 main 提供用户确认过的 me3 可执行路径，PATH 不参与选择启动 authority；
- 在应用数据目录创建或更新按 workspace 稳定命名的 `.me3` profile，不向 Mod overlay 或原版目录写运行元数据；
- profile 目录逐级执行 physical path 与 junction / symlink 边界校验，拒绝重定向到应用数据目录外；
- 使用参数数组和 `shell: false` 执行 `me3 launch -p <profile>`，并阻止调用方覆盖保留参数；
- 限长捕获 stdout/stderr、退出码、信号、主动终止和启动失败状态；
- launch session 可关联 Patch operation ID；
- 零退出码只记录为进程正常退出，不冒充真实 Sekiro Mod 加载成功；
- fake process Windows smoke 覆盖 profile、参数、日志、operation 关联、终止和路径安全边界。

仍缺：

- Electron main IPC、设置持久化和 launch-session SQLite authority；
- 真实 me3 可执行文件与真实 Sekiro 启动；
- Patch operation 提交后启动验证；
- operation 回滚后再次启动与恢复判断；
- 游戏内 Mod 加载证据、崩溃信息和真实故障诊断。

me3 是可替换的运行适配器，不是工作区、Patch Engine 或语义模型的核心依赖。当前实现没有真实运行环境证据，因此不得提升为 `native-verified`。

### 发行状态：`partial / unverified`

已有：

- Windows CI 配置；
- 2026-07-23 H 线分支的公开 Windows CI 全绿证据；
- release content 扫描；
- electron-builder portable / NSIS 配置；
- private native gate 与 section-28 诚实 skip；
- 基础性能 smoke。

仍缺：

- 真正的安装包、升级和干净机验证；
- 代码签名和更新器；
- 安装包内 Bridge、自包含 .NET 和 native binding 验证；
- me3 真实启动链与桌面 IPC；
- 真实 Sekiro Mod 加载、回滚和再次启动；
- 真实模型服务循环；
- 完整性能门槛。

`skipped` 和 `unverified-no-local-sekiro-runtime` 不能算通过。

---

## 12. I 线：渲染架构

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

### 性能路线

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

不提前拍脑袋决定。先用真实 Sekiro 大地图测量：

- 首次打开与后台加载时间；
- 稳态内存与显存；
- camera 帧时间；
- picking 和批量选择延迟；
- 单实体 mutation 的增量更新时间；
- 多次打开关闭后的资源泄漏；
- WebGPU 与 WebGL2 差异。

只有真实证据表明：

- WebGPU 下仍无法达到可接受交互性能；
- JS/GC 成为无法规避的主要瓶颈；
- 原生纹理、上传、picking 或显存控制受到硬限制；

才增加独立 `NativeRenderHost`。即使增加原生后端，也必须复用 semantic scene、render packet、资源缓存协议和 typed mutation，不能推翻上层架构。

---

## 13. 当前技术前沿

本节只描述当前战线，不规定下一位 Agent 必须先做哪一项。

| 路线 | 当前状态 | 主要前沿 / 阻塞 |
|---|---|---|
| A 工作区与事务 | `native-verified / hardening` | 真实故障、安装升级、大容量恢复 |
| B DFLT | `native-verified` | 新变体和发布 corpus |
| B BND4 | `native-verified / partial` | KRAK 内 corpus、新 flags/布局 |
| B KRAK | `blocked` | 缺合法 Sekiro Oodle runtime 成功路径 |
| C FMG | `native-verified / partial` | 多语言、多 msgbnd、引用与游戏加载 |
| C PARAM | `partial` | 旧布局、Paramdex-compatible metadata、字段 writer |
| C EMEVD | `partial` | layer 变体、完整 EMEDF、DSL compiler、全 corpus |
| C MSB | `partial` | 全实体 CRUD、引用修复、完整 scene projection |
| D 行为与动画 | `not-started` | Sekiro corpus 和格式地图 |
| E 场景与资产 | `partial / candidate` | FLVER/TPF/MTD native authority 和转换 |
| F 专业编辑器 | `partial` | 真数据完整接线、规模化交互、行为/动画编辑器 |
| G AI Agent | `partial / unverified` | 真实模型服务、Context Broker、生产工具循环 |
| H me3 运行 | `unverified foundation` | desktop IPC、持久会话、真实 me3/Sekiro、提交后启动与回滚重启 |
| H 发行 | `partial / unverified` | 签名、安装、更新、真实 Sekiro gate |
| I 渲染 | `partial / high-risk validation` | 真实 FLVER、大地图 WebGPU 基准、后端抽象 |

可以并行推进的典型方向：

- KRAK 受外部环境阻塞时，继续 EMEVD、MSB、Paramdex、FLVER 或行为格式研究；
- native writer 尚无证据时，可以推进只读文档、corpus registry、diagnostics 和 scene projection；
- UI 可以建立通用交互骨架，但不得用 demo 数据冒充底层 authority；
- renderer 优化可以推进，但编辑权威必须留在 semantic/native 层。

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
| `packages/shared/src/ai-tools.ts` | typed AI 工具协议 |
| `packages/shared/src/audit-log.ts` | 审计 schema |
| `packages/shared/src/vfs.ts` | VFS；renderer-safe DTO 不得泄漏绝对路径 |

### Core

| 领域 | 典型职责 |
|---|---|
| workspace / VFS | 工作区 session、overlay/base、扫描与路径边界 |
| patch / transaction | staging、validator、commit、rollback、recovery |
| database | SQLite repositories、migration、journal、jobs、audit |
| bridge client | daemon 生命周期、取消、超时和崩溃处理 |
| native adapters | Bridge native document / writer 调用 |
| resource graph | 索引、引用、诊断和 evidence projection |
| assets / scene | 资产导入、semantic scene、render projection |
| model-services | provider adapters、agent loop、permissions |
| runtime | 可信 me3 可执行路径、profile、launch session、日志和 operation 关联 |

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
- preload renderer-safe API；
- React 工作台、编辑器、AI 侧栏和渲染视口；
- 所有写入请求经 main/core/Patch Engine。

---

## 15. 验证命令

最低公开回归：

~~~powershell
npm run typecheck
npm test
npm run test:me3-runtime-adapter
npm run bridge:verify:synthetic
npm run build
~~~

Bridge 与持久化：

~~~powershell
npm run bridge:build
npm run bridge:verify:daemon
npm run bridge:verify:client
npm run bridge:verify:crash
npm run test:database-utility
npm run test:sqlite-crash-recovery
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
npm run test:native-preview
~~~

编辑器、AI、资产与发行的具体 smoke 以根 `package.json` 为准。

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

每次有实质推进时，应同时更新：

1. 对应区域地图的“已有 / 仍缺 / 状态”；
2. “当前技术前沿”表；
3. 本节末尾追加一条自包含证据记录。

记录至少包括：

- 日期；
- 起始与结束 commit；
- 实现内容；
- 运行命令和结果；
- 样本 / corpus 范围；
- authority 状态变化；
- 未验证项；
- 非声明；
- 外部阻塞。

建议格式：

~~~markdown
### YYYY-MM-DD：标题

- 起始：`sha`
- 结束：`sha`
- 路线：B / C-EMEVD / I 等
- 状态变化：`candidate -> partial`
- 已实现：...
- 已验证：`command` exit 0；样本范围 ...
- 未验证：...
- 非声明：...
- 阻塞：...
~~~

真实命令日志和大型产物放在应用数据目录或系统临时目录，默认不提交仓库。记录中不得包含用户绝对路径、真实资产、API key 或 Oodle DLL。

旧版 P0-P7 流水记录已由本线路图取代。历史细节仍可通过 Git history 和基线提交 `7bd354d` 追溯；不要恢复旧 milestone、fork、task、project-state 或 development-log 文档作为当前口径。

### 2026-07-20：交接书重构为长期技术线路图

- 起始：`7bd354d`
- 路线：全局文档架构
- 状态变化：固定 P0-P7 阶段计划 -> 依赖驱动技术线路图
- 已实现：将工作区、容器、核心语义、行为动画、场景资产、专业编辑器、AI、me3 运行和渲染后端拆为长期主线。
- 已实现：正式纳入行为与动画路线；明确 Paramdex-compatible metadata；明确 EMEVD DSL 终局编译链；明确 me3 runtime adapter；明确 renderer-independent semantic scene、Three.js WebGPU 首选、WebGL2 fallback 和未来 native backend 边界。
- 已保留：Patch Engine、native authority、路径安全、SQLite、三层回滚和诚实诊断等硬约束。
- 非声明：文档重构不改变任何代码能力，也不把现有 partial / candidate / skipped 提升为完成。

### 2026-07-23：me3 runtime foundation 与 Windows 路径身份修复

- 起始：`2002076`
- 实现结束：`4388600`
- 路线：A / H-me3
- 状态变化：H-me3 `not-started -> unverified foundation`
- 已实现：新增通用 `GameRuntimeAdapter` 契约、可信 me3 可执行路径边界、稳定 `.me3` profile、无 shell 启动、限长日志、结构化进程状态、operation 关联和受控终止。
- 已实现：profile 目录只进入应用数据目录，并对每一级现有路径执行 physical path 与 junction / symlink 防逃逸检查；公开 adapter 不允许 PATH 决定启动 authority。
- 已实现：修复 Windows runner 上调用方选择路径与 `realpath()` 物理路径命名空间不一致的问题；workspace ID 继续以物理根目录为准，写入检查同时保留 lexical 与 physical 安全边界。
- 已验证：公开 Windows CI 在 `4388600` 全绿，覆盖 typecheck、全量 unit/integration smokes、Bridge synthetic/daemon、发行内容扫描和 build；独立 core smoke 覆盖 foundation、持久化、安全边界和 me3 runtime contract。
- 样本范围：临时 workspace、fake me3 executable 和注入式 fake process；未使用真实游戏资产、用户 Mod、私有 corpus 或 Oodle runtime。
- 未验证：Electron main IPC、SQLite launch-session persistence、真实 me3、真实 Sekiro、提交后启动、回滚后重启和游戏内加载判断。
- 非声明：fake process、`.me3` profile 生成或退出码 0 均不构成真实 Sekiro runtime / native authority 证据。
- 外部阻塞：当前执行环境没有可用于合法验证的 Sekiro 与 me3 运行环境。

---

## 18. V0.5 完成定义

只有同时满足以下条件，才能说“V0.5 完成”：

- 文档只有一个当前实施口径；
- Sekiro 私有发布 corpus 达到声明的 native authority；
- DFLT、KRAK、BND4 真实闭环；
- FMG、PARAM、EMEVD、MSB 在内置 Sekiro 支持范围内实现无损读取、mutation、写入、重读、引用验证和回滚；
- 行为与动画路线的 V0.5 支持范围经 corpus 裁定并达到对应完成定义；
- 专业编辑器使用真实文档，不依赖 demo 冒充；
- EMEVD DSL 可安全编译为 typed mutation；
- 完整 MSB 场景和声明范围内的资产转换可用；
- 渲染架构通过真实 Sekiro 大地图门槛，后端选择有基准证据；
- 双模型服务 Agent 完成真实工具循环；
- Patch Engine 是所有写入的唯一主干；
- operation、file、resource-entry 三层持久回滚可用；
- me3 runtime adapter 可完成提交后启动、日志关联、回滚和再次启动验证；
- Windows 安装、升级、签名和更新可用；
- 没有提交真实资产、用户 Mod、Oodle DLL 或明文凭据；
- 未支持能力诚实显示为 unsupported、candidate、partial、blocked 或 unverified。

项目周期长不降低这些标准，也不要求为了尽快发布而牺牲路线完整性。

---

## 19. 保留文档

长期愿景与研究边界：

- `docs/PRODUCT_VISION.md`
- `docs/PARSER_RESEARCH.md`

Synthetic 技术规格：

- `docs/V0_3_FMG_SYNTHETIC_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md`
- `docs/V0_3_SYNTHETIC_MAP_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_BND_FIXTURE.md`

开发桥：

- `docs/CODEXPRO_QUICKSTART.md`
- `docs/CODEXPRO_INTEGRATION.md`

除稳定格式规格外，不再创建与本文平行的路线、任务、状态和日志文档。
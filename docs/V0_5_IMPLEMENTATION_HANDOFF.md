# SoulForge V0.5 实施交接书

> 文档性质：实现规范与工程交接，不是愿景草案。  
> 目标读者：接手实现 SoulForge V0.5 的开发 Agent / 工程师。  
> 当前基准日期：2026-07-10。  
> 初始审计基线：`57a5db5`；当前实现位于未提交工作树，接手前必须以 `git status`、本文第 43 节和真实测试重新核对。  
> 产品定位：**魂游 Mod 的 Cursor**。

---

## 0. 如何使用本文

接手者必须按以下顺序工作：

1. 完整阅读仓库根目录 `AGENTS.md`。
2. 完整阅读本文，不得只截取单个阶段实施。
3. 执行本文“基线验证命令”，确认当前状态与审计快照是否一致。
4. 从 P0 开始，按阶段实施；不得跳过尚未通过验收的前置阶段。
5. 每个阶段只在真实验证通过后更新状态文档，禁止把 scaffold、synthetic 或 candidate 描述成 native 完成。
6. 所有写入能力必须复用 PatchIR → 暂存区 → 验证 → 备份 → 原子替换 → 重读 → 索引更新 → 审计 → 回滚主干。
7. 不得提交 `mods/`、真实游戏资产、用户 Mod、API key、Oodle DLL、签名私钥或本机私有测试语料。
8. 仓库当前存在未跟踪 `mcps/**`；它们不属于 V0.5 实现范围，不得暂存、修改或提交。

本文已完成产品分歧裁定。实现者不得自行重新扩大或缩小范围；遇到真实格式证据与本文冲突时，应停止该格式的权威声明，记录证据并请求用户裁定，而不是猜测。

---

## 1. 当前真实状态

### 1.1 已经可复用的主干

当前仓库不是空项目，以下能力已经落地并有 smoke 覆盖：

- Electron + React + TypeScript 桌面壳。
- .NET 10 `win-x64` Bridge 常驻进程、协议 1.0 长连接客户端和一次性 CLI 测试兼容入口。
- Mod 覆盖层可写、原版游戏目录只读、带 realpath/reparse 边界校验的 `WorkspaceSession`。
- PatchIR + `WorkspaceTransaction` 唯一 production commit 主干。
- 文本修改、原始字节区间修改、整文件替换。
- 暂存区、源 hash 前置条件、备份、原子替换。
- operation/file 级历史，以及以新逆向 PatchIR 事务实现的 operation 回滚和 `afterHash` 冲突保护。
- bounded preview、大文件延迟 hash、基础 VFS。
- 内存资源关系图、证据包、补丁影响图。
- 文件级 capability matrix。
- synthetic DFLT、SFBN BND3/BND4、SFFX FMG 测试链。
- DFLT + synthetic BND 嵌套 child replace。
- AI 工具权限阶梯和 mock/tool-console 草稿。
- `app.db` / `workspace.db` 迁移器、checksum、WAL/foreign key、严格旧 JSON 导入。
- `better-sqlite3` Electron utility process、异步操作日志 repository 和 Node/Electron 双 ABI 构建门禁。
- Electron sandbox/CSP/导航/窗口/权限/IPC sender 安全边界，renderer-safe DTO 与 main 原生确认。

### 1.2 当前明确未完成

以下能力尚未完成，不得从现有命名或测试名推断为已完成：

- 真实 native BND4 child table / repack。
- KRAK 解压与重压。
- 真实 EMEVD、MSB、PARAM、FMG parser/writer。
- 原生语义资源 CRUD、重排和类型转换。
- file/resource entry 级逆向事务入口与持久回滚。
- SQLite 中尚未接通的完整文件索引、FTS5、资源图、诊断、任务、审计、模型服务和 AI 历史 repositories。
- Bridge 写操作崩溃恢复故障注入、后台任务持久恢复，以及 Oodle/KRAK。
- OpenAI-compatible / Anthropic-compatible 真实模型调用。
- 模型服务凭据安全存储。
- 专业 Hex、EMEVD、PARAM、FMG、MSB 编辑器。
- Three.js 3D 场景和资产转换。
- 游戏适配包安装、签名、信任和迁移。
- Windows 安装包、更新器、正式 CI 和发行门禁。

### 1.3 P0 安全审计结论

初始审计发现的 renderer 铸造确认凭据、renderer 决定权限模式、绝对路径 IPC、`sandbox: false`、junction/symlink 越界、恢复数据写入 Mod、after-commit 失败不恢复、回滚覆盖后续修改和损坏 JSON 静默清空问题，均已修复并有静态或运行门禁。实现证据见第 43 节。

尚未完成但不应与上述已修复问题混淆的事项：

1. 生产 AI 工具注册表与 typed policy gate / SQLite 审计仍需在 P6 合并。
2. 当前桌面 AI 模式由 main 锁定为计划模式；持久模型服务授权尚未实现。
3. file/resource entry 两级逆向事务仍未实现，当前只完成 operation 级逆向事务。
4. renderer DTO 已删除已知路径字段，但后续新增 DTO 仍必须通过统一 runtime schema 和静态门禁。

### 1.4 本机真实样本事实

`D:\Repository\SoulForge\mods` 当前有 237 个文件，其中 214 个 `.dcx`。

只读取 DCX 头部得到：

| 压缩 | 数量 |
|---|---:|
| DFLT | 144 |
| KRAK | 70 |

核心格式分布：

| 资源 | DFLT | KRAK |
|---|---:|---:|
| EMEVD | 10 | 33 |
| MSB | 9 | 0 |
| MSGBND | 2 | 0 |
| PARAMBND | 1 | 0 |
| GPARAM | 0 | 34 |

DFLT 解压样本显示 Sekiro 容器资源主要为 BND4。由此确定：

- KRAK 是 V0.5 发布阻塞项。
- BND4 是 V0.5 原生容器目标。
- BND3 保留识别与 structured unsupported，但不阻塞 V0.5。
- EDGE / ZSTD 当前不阻塞 Sekiro V0.5，除非私有发布语料证明 Sekiro 基线确实需要。

### 1.5 当前基线验证

审计时实际通过：

~~~powershell
npm run typecheck
npm test
npm run test:database-utility
npm run bridge:build
npm run bridge:verify:daemon
npm run bridge:verify:client
npm run bridge:verify:synthetic
npm run test:native-preview
npm run build
~~~

`test:native-preview` 通过只证明安全打开和 envelope inspect 没有崩溃，不证明 native semantic parser 完成。

---

## 2. V0.5 发布定义

### 2.1 平台与游戏范围

- 正式支持：Windows 10/11 x64。
- 权威游戏基线：Sekiro。
- 架构仍保持 FromSoftware 通用，不得把共享 URI、PatchIR、Bridge 协议或资源关系图写死为 Sekiro-only。
- 其他游戏在 V0.5 只允许：
  - 文件级打开、搜索、bounded preview；
  - 原始字节编辑（经过明确风险门控）；
  - candidate / unsupported 诊断；
  - 不得声明 native semantic authority。

### 2.2 V0.5 阻塞能力

V0.5 必须形成以下真实闭环：

~~~text
打开 Mod 覆盖目录 + 原版只读目录
  -> 快速文件树
  -> 后台增量索引
  -> DFLT/KRAK 解压
  -> BND4 浏览与重建
  -> EMEVD/MSB/PARAM/FMG 无损文档
  -> 专业编辑器
  -> AI / 用户产生修改集
  -> PatchIR
  -> 暂存区
  -> 验证与补丁关系图
  -> 备份与提交
  -> 重读/重解析
  -> 增量更新索引
  -> operation/file/resource entry 回滚
~~~

### 2.3 核心语义资源

以下四类资源在 Sekiro 游戏适配包声明的支持范围内都必须具备：

- 无损读取。
- 无修改往返。
- 新增、读取、修改、删除。
- 重排。
- 支持类型之间的显式转换。
- schema / instruction / layout 验证。
- 引用检查。
- 保存后重读。
- 三层持久回滚。

支持范围的边界不是“实现者觉得常见”，而是：

1. 私有发布语料 manifest 中登记的全部格式变体；
2. 内置 Sekiro 游戏适配包声明的全部类型；
3. 对应的 parser/writer/validator 测试全部通过。

如果基线语料出现未支持类型，该类型必须阻塞发布或从发布语料基线中由用户明确裁定移除；不能静默降级后仍宣称 V0.5 完成。

### 2.4 专业桌面范围

V0.5 必须交付：

- 虚拟化资源树和文件工作台。
- 安全 Hex 编辑器。
- EMEVD 四视图同步。
- PARAM 专业表格和参数结构定义编辑器。
- FMG 多语言本地化工作台。
- MSB 完整 3D 场景。
- 模型、碰撞、材质、纹理转换与替换。
- 补丁关系图、引用图、诊断、历史、恢复和任务中心。
- 双模型服务 AI 侧栏。

### 2.5 明确非目标

以下能力移到 V0.5 发布后至 V1 前：

- 多工作区与跨项目 patch 迁移。
- 完整 Git UI。
- 实时多人协作。
- 反汇编、调试器和逆向工程套件。
- 本地 LLM runtime。
- vector DB / embedding RAG。
- Blender MCP。
- 内置 mesh 建模。
- 内置贴图绘制。
- 内置材质节点创作。
- 内置动画制作。
- FBX / DAE / OBJ 导入。

现有“v0.6 Native Container Workbench”保留为内部技术里程碑名，不代表产品 V0.6 已发布。

---

## 3. 术语与本地化规范

### 3.1 中文术语表

用户界面、帮助、错误信息、发布说明和面向用户的产品文档必须使用：

| 内部英文 | 中文产品用语 |
|---|---|
| Profile / Game Profile | 游戏适配包 |
| Provider | 模型服务 |
| Provider Config | 模型服务配置 |
| Workspace | 工作区 |
| Overlay | Mod 覆盖层 |
| Base | 原版游戏目录 / 原版只读层 |
| Full Permission | 完全权限 |
| Plan Mode | 计划模式 |
| Normal Mode | 普通模式 |
| Thinking | 思考强度 |
| Diagnostics | 诊断 |
| Evidence | 证据 |
| Provenance | 证据来源链 |
| Staging | 暂存区 |
| Patch Graph | 补丁关系图 |
| Reference Graph | 引用关系图 |
| Capability | 能力 |
| Native | 原生格式 / 原生能力 |
| Fixture | 测试样本 |
| Rollback | 回滚 |
| Recovery Point | 恢复点 |
| Daemon | 常驻服务 |

允许保留 EMEVD、MSB、PARAM、FMG、DCX、BND、Mod、Hex、API、URI 等格式或圈内常用缩写。

内部代码标识保持英文，不为了汉化修改 `ProviderAdapter`、`GameAdaptationPackageManifest` 等类型名。

### 3.2 界面语言

- 默认语言：简体中文。
- 同包提供英文语言资源。
- renderer 禁止散落硬编码用户字符串；所有 UI 字符串进入类型化语言目录。
- CI 增加中文界面字符串扫描，阻止 `Profile`、`Provider`、`Workspace`、`Full permission` 等未汉化通用词进入简体中文资源。

---

## 4. 不可突破的工程边界

1. renderer 永远不能直接访问真实文件系统。
2. renderer 永远不能收到 API key、签名私钥、Oodle DLL 路径或可直接使用的绝对文件路径。
3. 原版游戏目录永远只读。
4. 所有 Mod 写入必须经过 Patch Engine。
5. writer 只能写暂存区，不能直接写 Mod。
6. converter 只能写缓存/暂存区，不能直接写 Mod。
7. 3D renderer 只渲染已传入的数据，不能自行读取或保存资源。
8. unsupported structured format 不得通过“完全权限”变成可写。
9. synthetic 测试样本永远不能取得 `native-verified`。
10. 外部 FromSoftware 工具只作行为对照，不复制源码，不作为运行依赖。
11. Oodle 只从用户合法安装的 Sekiro 目录动态加载，不分发。
12. 真实游戏资产、用户 Mod 和私有测试语料不进入 Git。
13. Bridge、SQLite、worker 和模型服务失败必须返回结构化诊断，不能吞异常。
14. 计划模式只允许读取、分析和生成补丁提案；不得暂存或执行。
15. 普通模式可暂存和验证，提交需要可信确认。
16. 完全权限可自动提交，但仍必须有证据、验证、备份、审计和可回滚性。
17. 所有长任务必须可取消，且不能阻塞 renderer 主线程。

---

## 5. 目标架构

~~~mermaid
flowchart LR
    UI["React 专业桌面"]
    PRE["类型化 Preload"]
    MAIN["Electron Main 策略门"]
    DB["SQLite Utility Process"]
    BR[".NET 10 Bridge 常驻服务"]
    WORK["Worker / 转换任务"]
    TX["PatchIR + WorkspaceTransaction"]
    FS["Mod 覆盖层"]
    BASE["原版只读层"]
    MODEL["OpenAI / Anthropic 模型服务"]

    UI --> PRE
    PRE --> MAIN
    MAIN --> DB
    MAIN --> BR
    MAIN --> WORK
    MAIN --> TX
    TX --> FS
    BR --> BASE
    BR --> FS
    MAIN --> MODEL
~~~

### 5.1 进程职责

#### Renderer

- 应用壳和编辑器 UI。
- 文档选区、未提交修改集、临时撤销/重做。
- Three.js 绘制、拾取、相机和 gizmo。
- 不持有绝对路径、凭据、签名私钥、确认签名密钥。

#### Preload

- 仅暴露窄、类型化、版本化 API。
- 不暴露 `ipcRenderer`、`fs`、`shell` 或任意 channel。
- 所有输入先做运行时 schema 校验。

#### Electron Main

- 工作区会话和资源 URI → 真实路径解析。
- IPC sender 校验。
- 权限模式、模型服务授权和可信确认。
- Bridge / DB / worker 生命周期。
- Context Broker：控制发送给云端模型的数据。
- Patch Engine 调度。
- 更新器、签名和发行逻辑。

#### SQLite Utility Process

- `better-sqlite3` 唯一运行位置。
- 提供异步 RPC，不阻塞 main。
- 迁移、事务、FTS5、WAL、checkpoint、清理。

#### Bridge

- 所有 FromSoftware 原生二进制 parser/writer。
- DFLT/KRAK/BND4。
- EMEVD/MSB/PARAM/FMG。
- 场景资产解析与原生重建。
- 原生 validator。
- 不直接提交 Mod；只返回数据或写主进程指定的暂存路径。

#### Worker

- glTF / 图像导入。
- GPU-ready 分块。
- diff、布局、批量公式等 CPU 密集任务。
- 所有输出写内容寻址缓存或暂存区。

---

## 6. 应用数据目录

Windows V0.5 固定使用：

~~~text
%APPDATA%\SoulForge\
  app.db
  config\
  logs\

%LOCALAPPDATA%\SoulForge\
  workspaces\<workspace-id-hash>\
    workspace.db
    backups\
    recovery\
    staging\
    cache\
    bridge\
  updates\
~~~

规则：

- `app.db` 只放小型全局配置和 AI 历史。
- 大型索引、备份、缓存和恢复数据放 `LOCALAPPDATA`，不得进入 Roaming。
- 不在 Mod 目录创建 `.soulforge`。
- workspace id 使用规范化 overlay root + game id 计算稳定 hash；数据库不以用户可控文件名直接拼路径。
- 所有目录创建和路径解析由 main 完成。

---

## 7. SQLite 设计

### 7.1 驱动与运行方式

- 依赖：`better-sqlite3`。
- 运行：Electron utility process。
- 开启：
  - `PRAGMA journal_mode = WAL`
  - `PRAGMA foreign_keys = ON`
  - `PRAGMA busy_timeout = 5000`
  - `PRAGMA synchronous = FULL`（事务/历史库）
  - `PRAGMA secure_delete = ON`（含 AI 明文历史的 app.db）
- 每个 migration 有 id、name、checksum、up SQL。
- migration 必须在事务内完成。
- 检测到数据库 schema 高于当前程序时拒绝打开，不能降级写入。
- 数据库损坏不能自动当空库；进入恢复向导。

当前已落地的基础：`packages/core/src/storage/sqliteDatabase.ts` 管理两库迁移、checksum、WAL、外键、busy timeout、完整性检查和事务失败回滚；`apps/desktop/src/main/databaseUtility.ts` 在 Electron utility process 中持有两库。操作日志接口已改为异步，文件提交会等待 pending/committed 落库结果。尚未实现本节列出的全部 repository、`synchronous=FULL`/`secure_delete` 策略和恢复向导；不得把“两库能打开”写成 P1 数据层全部完成。

### 7.2 app.db

至少包含：

- `schema_migrations`
- `model_service_configs`
- `model_service_credentials`（只存 safeStorage 密文/引用）
- `model_service_permission_grants`
- `ai_sessions`
- `ai_messages`
- `agent_runs`
- `agent_steps`
- `tool_calls`
- `outbound_context_items`
- `adaptation_packages`
- `adaptation_package_publishers`
- `trusted_user_keys`
- `user_signing_key_refs`
- `app_settings`

`ai_messages` 至少包含：

- message id
- session id
- workspace id
- role
- plaintext content
- created_at
- expires_at
- redaction summary
- provider response id

默认 `expires_at = created_at + 30 days`。启动时和每日清理，清理后执行合理的 WAL checkpoint；不得让恢复点或导出包复活已过期正文。

### 7.3 workspace.db

保留和演进现有 schema，权威表至少包括：

- `workspaces`
- `workspace_layers`
- `files` / `files_fts`
- `resource_nodes`
- `resource_edges`
- `resource_properties`
- `provenance_records`
- `diagnostics`
- `event_documents / event_symbols / event_instructions`
- `map_documents / map_entities / map_regions / scene_assets`
- `param_documents / param_rows / param_fields / param_definitions`
- `fmg_documents / text_entries`
- `patch_transactions`
- `patch_operations`
- `file_changes`
- `resource_entry_changes`
- `restore_points`
- `restore_point_files`
- `transaction_journal`
- `audit_events`
- `jobs`
- `editor_layout_state`

每个可写语义条目必须有稳定 URI、document revision、before/after payload hash 和 inverse operation。

### 7.4 旧数据迁移

迁移旧 `FileOperationLogStore` JSON 和语义 snapshot：

1. 只读打开旧文件。
2. 校验 JSON 结构和 workspace id。
3. 在 SQLite 单事务内幂等导入。
4. 对记录数、op id、文件 hash 做校验。
5. 成功后保留内容寻址的只读备份，原文件不删除、不覆盖；未来如改为重命名，必须先证明不会破坏旧版本回退。
6. 失败时回滚 SQLite，保留旧文件，返回结构化迁移失败。
7. 绝不把损坏 JSON 当成空历史。

---

## 8. Bridge daemon 协议

### 8.1 运行时

- 目标框架：`net10.0`。
- 发布：self-contained `win-x64`。
- 仓库增加 `global.json` 固定 .NET 10 SDK feature band。
- 当前开发机已通过 `scripts/install-dotnet-sdk.ps1` 安装应用本地 .NET 10 SDK，`scripts/run-dotnet.mjs` 优先使用该 SDK；不得退回 net6 产物。
- Electron 打包时携带 Bridge 自包含产物，不要求终端用户安装 .NET。

当前已落地的 transport 基础：`BridgeDaemonHost.cs`、`BridgeDaemonClient`、协议 1.0 handshake、允许根目录、deadline、取消、并发限制、进度帧、健康/能力查询和崩溃失效。一次性 CLI 只保留 synthetic/人工验证用途。尚未完成 Oodle/KRAK、native writer 命令、写操作崩溃恢复故障注入和发行包内自包含部署。

### 8.2 NDJSON 帧

每行一个 JSON frame，禁止跨行 JSON。

~~~ts
type BridgeFrame =
  | BridgeHandshake
  | BridgeRequest
  | BridgeAccepted
  | BridgeProgress
  | BridgeResult
  | BridgeFailure
  | BridgeCancel
  | BridgeHeartbeat;

interface BridgeRequest {
  type: 'request';
  requestId: string;
  workspaceSessionId: string;
  protocolVersion: '1.0.0';
  schemaVersion: '1.0.0';
  command: BridgeCommandName;
  resourceUri?: string;
  deadlineUtc: string;
  options?: Record<string, unknown>;
}

interface BridgeProgress {
  type: 'progress';
  requestId: string;
  phase: string;
  completed?: number;
  total?: number;
  message?: string;
}
~~~

main 不把真实路径放进公共 request。main 与 Bridge 建立会话时单独注册允许根目录；Bridge 根据 session + URI 解析路径，并再次做边界校验。

### 8.3 必须支持的命令

基础：

- `health`
- `capabilities`
- `register-workspace`
- `unregister-workspace`
- `inspect`
- `validate`

容器：

- `container.inspect`
- `container.list-children`
- `container.read-child`
- `container.rebuild`
- `container.validate-roundtrip`

语义：

- `document.open`
- `document.query-page`
- `document.apply-mutations-to-staging`
- `document.validate-staged`
- `document.render-index-projection`

场景：

- `scene.open-manifest`
- `scene.load-chunk`
- `asset.inspect-import`
- `asset.convert-to-staging`
- `asset.validate-staged`

### 8.4 安全与可靠性

- 请求和结果大小有硬上限。
- 大块二进制写临时内容寻址对象，协议只返回 object id；不得把完整大文件塞进 JSON。
- 每个请求支持 CancellationToken。
- 过期 deadline 自动取消。
- main 维护并发上限和队列。
- stdout 只输出协议帧；日志写 stderr。
- 非法 JSON、未知命令、schema mismatch、超大帧、路径越界都返回 typed failure。
- daemon 崩溃后 main 标记在途请求 failed，按小预算重启，不自动重复写操作。

---

## 9. 权威等级与能力矩阵

统一：

~~~ts
type AuthorityLevel =
  | 'unsupported'
  | 'candidate'
  | 'fixture-confirmed'
  | 'native-verified';
~~~

`nativeFormatAuthority` 保留一个兼容周期，但必须由 `authorityLevel === 'native-verified'` 派生。

每个格式分别记录：

- envelopeRecognized
- decompressionSupported
- containerReadable
- childReadable
- containerRebuildable
- semanticReadable
- semanticWritable
- nativeRoundTripVerified
- supportedOperations
- requiredValidators
- requiredRuntime（如 Oodle）
- variant id
- adaptation package id/version

`validateContainer` 必须区分：

1. 结构可识别；
2. 可解压；
3. 可无损重建；
4. 可安全结构化编辑。

不能把“识别到 KRAK 但无法解压”返回为整体验证通过。

---

## 10. 无损原生文档

新增：

~~~ts
interface NativeDocumentEnvelope<TDocument> {
  documentUri: string;
  sourceUri: string;
  resourceKind: ResourceKind;
  game: GameId;
  authorityLevel: AuthorityLevel;
  formatId: string;
  formatVariant: string;
  schemaId: string;
  schemaVersion: string;
  documentRevision: string;
  sourceHash: string;
  byteOrder: 'little' | 'big' | 'mixed';
  containerChain: NativeContainerLayer[];
  document: TDocument;
  unknownRegions: PreservedByteRegion[];
  diagnostics: StructuredDiagnostic[];
  provenance: ProvenanceSource[];
}
~~~

要求：

- 未知字段/区段必须有明确保存策略。
- serializer 不得依赖重新猜偏移。
- stable field URI 不以数组下标作为唯一身份。
- 索引 projection 与无损 document 分离。
- UI 只提交 mutation，不上传整个可写 document 作为“新文件”。

---

## 11. 游戏适配包

### 11.1 产品名

用户界面统一称“游戏适配包”。内部推荐类型：

- `GameAdaptationPackageManifest`
- `GameAdaptationPackageRegistry`
- `AdaptationPackageTrustStore`

### 11.2 包格式

扩展名：`.sfadapt`，内容为确定性 ZIP：

~~~text
manifest.json
signature.json
schemas/
  emevd/
  msb/
  param/
  fmg/
rules/
  paths.json
  materials.json
  collision-import.json
  type-conversions.json
icons/
fixtures/
  manifest.json
migrations/
  manifest.json
~~~

包内不得有 `.js`、`.dll`、`.wasm`、`.exe`、脚本入口或任意可执行 hook。

### 11.3 Manifest

~~~ts
interface GameAdaptationPackageManifest {
  manifestVersion: 1;
  packageId: string;
  displayName: LocalizedText;
  publisherId: string;
  gameId: GameId;
  version: string;
  soulforgeVersionRange: string;
  dependencies: PackageDependency[];
  fileRules: FileRecognitionRule[];
  schemaCatalog: SchemaDescriptor[];
  capabilities: AdaptationCapability[];
  materialMappings: MaterialMappingRule[];
  collisionImportRules: CollisionImportRule[];
  typeConversions: TypeConversionRule[];
  fixtureManifestPath: string;
  migrationManifestPath: string;
  contentHashes: Record<string, string>;
}
~~~

### 11.4 签名与信任

- 算法：Ed25519。
- 签名输入：RFC 8785 风格 canonical manifest + 按规范路径排序的内容 hash。
- 官方公钥内置在应用。
- 官方私钥只存在发布环境，不进入仓库。
- 用户修改官方包必须创建新的 package id / publisher id，不能覆盖官方身份。
- 用户私钥通过 safeStorage 加密保存。
- 用户公钥显式加入本机 trust store。
- 签名失败、hash 不匹配、依赖缺失或版本不兼容时拒绝启用。

---

## 12. DFLT、KRAK 与 BND4

### 12.1 DFLT

- 保留原 DCX header variant、压缩级别和未知头字段。
- 无修改 roundtrip：
  - 若能稳定复现，要求字节一致；
  - 否则必须 payload hash 一致，header 结构有效，重读成功。
- 解析使用严格长度/偏移校验。

### 12.2 KRAK

- Bridge 从用户选择/发现的 Sekiro 安装目录定位 Oodle DLL。
- 不复制到应用目录或缓存。
- 使用 `NativeLibrary.Load` 加载，并验证必需导出。
- capability 明确报告：
  - runtime missing
  - runtime incompatible
  - decompress only
  - compress/decompress
- 重压参数从原 DCX variant 和游戏适配包读取，不自行猜默认值。
- Oodle 缺失时，KRAK 文件保持 raw readable，但 native semantic read/write blocked。

### 12.3 BND4

Container child identity 至少包含：

- table index
- native id
- name
- flags
- compressed/uncompressed size
- offset
- child hash
- stable child URI

stable URI 不能只靠名称，必须能区分同名 child。

V0.5 BND4 操作：

- list/read
- replace
- add
- delete
- rename
- move/reorder
- nested child mutation
- rebuild
- validate roundtrip

验证必须确保未修改 child 的 hash、顺序、标志和元数据保持不变。

---

## 13. PatchIR 扩展

### 13.1 新操作

在现有操作上增加：

~~~ts
type PatchIrOpKind =
  | ExistingPatchKinds
  | 'resource_node_reorder'
  | 'resource_node_convert'
  | 'asset_import_replace';
~~~

`ResourceFieldEditOp` 增加：

- documentUri
- documentRevision
- schemaId
- schemaVersion
- layoutFingerprint
- expectedDocumentHash
- writerId
- inverse

`ResourceNodeMutationOp` 禁止 `nodePayload?: unknown` 长期存在；按 resource kind 使用 discriminated payload。

`AssetImportReplaceOp` 至少包含：

- source import object id
- import format
- target asset URI
- conversion rule id
- expected target hash
- generated staging objects
- required validators
- inverse reference

### 13.2 逆操作

每个 semantic mutation 在暂存前生成可验证 inverse：

- field update → previous typed value
- add → delete exact new stable URI
- delete → full preserved entry payload
- reorder → previous ordering
- convert → previous type + complete preserved payload
- asset replace → previous asset object hash / backup

inverse 与原操作一起落库，resource entry rollback 通过 inverse 生成新事务。

### 13.3 Writer contract

所有原生 writer 必须实现：

- `canHandle`
- `writePlan`
- `applyToStaging`
- `postValidate`
- `produceRollbackMetadata`
- `captureInverse`

禁止 writer 自行 commit。

---

## 14. 事务与三层回滚

### 14.1 正常提交

~~~text
PatchIR
  -> 权限与能力门
  -> pending DB journal
  -> 捕获 inverse
  -> 内容寻址暂存
  -> staged validators
  -> restore point
  -> commit hash 再检查
  -> sibling temp + atomic replace
  -> after-commit re-read/parse validators
  -> SQLite mark committed
  -> 增量索引
  -> audit
~~~

任何 after-commit validator 失败：

1. 立即用本次 restore point 自动回滚；
2. 验证回滚结果；
3. 若回滚失败，恢复到“回滚前”保护点；
4. 写入 local recovery journal；
5. 应用进入 recovery required 状态，禁止继续同资源写入。

### 14.2 回滚

- operation rollback：对整个 operation 的 inverse 集合生成新 PatchIR。
- file rollback：对指定文件的 file changes 生成 inverse。
- resource entry rollback：只选择对应 semantic inverse。
- 原 operation 保持 committed 历史，不覆盖为 rolled_back；新操作通过 `revertsOperationId` / `revertsEntryChangeId` 建立关系。
- 回滚前必须验证当前文件 hash 等于原操作 afterHash。
- 外部修改冲突必须停止并展示三方状态，不得覆盖。

---

## 15. Electron 安全收口

### 15.1 BrowserWindow

必须：

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- 禁止不受信任 preload
- 严格 CSP
- 拦截 `will-navigate`
- `setWindowOpenHandler` 默认 deny
- 外部链接只允许 allowlist 后调用 `shell.openExternal`
- 设置 permission request handler，默认拒绝

### 15.2 IPC

每个 handler：

- 校验 `event.senderFrame` 来自主应用窗口和期望 origin。
- 校验输入 schema。
- 只接受 `workspaceSessionId`、resource URI、分页参数、mutation。
- 不接受 renderer 提供的绝对路径。
- 不接受 renderer 提供的权限模式作为权威值。
- 不返回 `absolutePath`。
- 错误返回 typed result，不把 stack/凭据/本机敏感路径传给 renderer。

### 15.3 工作区路径

使用：

- 规范化绝对路径；
- `realpath`；
- 对新文件解析最近存在父目录；
- 逐级拒绝 reparse point 逃逸；
- Windows 大小写不敏感边界；
- 拒绝设备路径、UNC 非授权根、短文件名绕过；
- 原版目录写入永远拒绝。

### 15.4 可信确认

删除 renderer 可直接铸造 receipt 的路径。

普通模式：

1. renderer 请求 main 展示确认；
2. main 使用 native dialog 展示资源、风险、影响文件和 patch hash；
3. 用户确认后 main 生成短期一次性 receipt；
4. receipt 绑定 workspace、patch hash、risk、subjects、nonce、issuedAt、expiresAt；
5. main 使用仅 main 持有的密钥签名；
6. commit 后 nonce 作废。

完全权限使用持久 grant，不复用伪造 receipt。

---

## 16. 专业桌面壳

### 16.1 结构

当前 `App.tsx` 是千行级单体，不能继续堆功能。拆为：

~~~text
renderer/
  app/
  shell/
  workspace/
  documents/
  editors/
    files/
    emevd/
    param/
    fmg/
    msb/
  patch-review/
  diagnostics/
  jobs/
  history/
  ai/
  i18n/
  three/
~~~

### 16.2 布局

- 左侧：资源树/搜索/类型。
- 中间：多编辑器标签页。
- 下方：诊断、任务、输出、历史。
- 右侧：AI 侧栏。
- 面板可拖拽调整并按工作区持久化。
- 单窗口只打开一个工作区。
- 关闭工作区前处理脏文档和进行中任务。

### 16.3 文档仓库

键：

~~~text
workspaceSessionId + resourceUri + documentRevision
~~~

职责：

- 加载分页 document。
- 缓存选区和可见页。
- 收集 mutation。
- 临时 undo/redo。
- dirty state。
- 冲突检测。
- 保存前生成 PatchIR。
- 保存后接收新 revision。
- 所有编辑视图共享同一个 mutation store。

---

## 17. 安全 Hex 编辑器

必须支持：

- 大文件分段读取。
- 行/列虚拟化。
- Hex 与文本双视图。
- 跳转偏移。
- 搜索 hex pattern / text。
- 选区。
- 覆盖式 byte edit。
- byte diff。
- hash 与修改范围摘要。
- 生成 `raw_byte_range_edit`。
- 普通模式可信确认。
- 完全权限策略门。
- undo/redo。
- 保存、重读、回滚。

不支持：

- 反汇编。
- 调试。
- 脚本执行。
- 结构模板解释器。

---

## 18. EMEVD 编辑器

### 18.1 无损 IR

至少包含：

- events
- restart type
- instructions
- typed args
- event layers
- parameter substitutions
- linked offsets
- string table references
- instruction schema binding
- unknown instruction payload
- original byte regions/source map

### 18.2 四视图

1. 流程图。
2. 结构化指令表。
3. DSL 文本。
4. 只读原始字节。

四视图：

- 同一 document revision。
- stable instruction/event URI。
- 选区同步。
- mutation 同步。
- DSL parse error 不得污染有效 mutation。
- 原始字节视图只读；要修改字节必须切换 Hex 工作台。

### 18.3 CRUD

支持：

- event add/delete/duplicate/reorder。
- instruction add/delete/update/reorder。
- typed arg edit。
- 支持 instruction type conversion。
- event layer edit。
- 引用验证。

未知 instruction：

- 可显示和无损保留；
- 未有 schema 时不能结构化修改；
- 可在 Hex 工作台另行高风险编辑，但不得标记为语义安全。

---

## 19. PARAM 与参数结构定义

### 19.1 PARAM

- 双向虚拟化表格。
- row CRUD、duplicate、reorder。
- typed field editor。
- enum / flags / bitfield / arrays。
- 批量筛选。
- typed formula。
- preview + constraints。
- diff。
- 引用关系。
- AI explain / generate mutation。

### 19.2 参数结构定义

支持：

- field add/delete/update/reorder。
- type、offset、size、alignment。
- enum/bitfield。
- default/min/max。
- version。
- schema diff。
- migration preview。
- validation。

修改官方结构定义不得改写官方游戏适配包；必须创建用户派生包并用用户密钥签名。

---

## 20. FMG 本地化工作台

必须支持：

- 原生 FMG variant 无损读写。
- 多语言包并排。
- entry CRUD。
- text id duplicate/missing/conflict 检查。
- 搜索、筛选、批量替换。
- CSV/JSON 导入导出。
- 导入 preview 与冲突策略。
- AI 翻译建议。
- 逐项接受/拒绝。
- 引用显示。
- 保存、重读和回滚。

不包含翻译记忆库和团队审校平台。

CSV/JSON 导入不能直接提交；必须先形成 mutation preview。

---

## 21. MSB 与完整 3D 场景

### 21.1 MSB IR

至少覆盖私有 Sekiro 基线中出现的：

- models
- parts/entities
- regions
- events
- transforms
- entity ids
- draw/display groups
- collision references
- model/material/texture references
- unknown sections

### 21.2 场景数据流

~~~text
MSB document
  -> 场景 manifest
  -> 可见 chunk 请求
  -> Bridge 解析原生资产
  -> worker 生成 GPU-ready chunk
  -> MessagePort / transferable ArrayBuffer
  -> Three.js
~~~

renderer 不得收到资产源绝对路径。

### 21.3 Three.js

- WebGL2。
- 实例化。
- 视锥裁剪。
- LOD。
- 内容寻址纹理/几何缓存。
- 资源内存预算。
- 显式 dispose。
- object picking。
- transform gizmo。
- region gizmo。
- 引用连线。
- overlay/base 可视化区分。

### 21.4 编辑

- entity/region CRUD。
- transform。
- type conversion（仅适配包声明映射）。
- model/collision/material/texture reference。
- asset replacement。
- 所有修改生成 semantic mutation / asset import PatchIR。

---

## 22. 资产导入、转换与替换

### 22.1 输入

V0.5 只接受：

- glTF 2.0
- GLB
- PNG
- TGA
- DDS

### 22.2 导入约定

- 材质映射由游戏适配包规则决定。
- 碰撞通过游戏适配包定义的 glTF node 命名约定生成。
- 不存在映射时失败，不自动猜材质或碰撞类型。
- 图片颜色空间、mipmap、压缩格式和尺寸规则必须在适配包声明。

### 22.3 流程

~~~text
选择导入文件
  -> 安全检查
  -> 解析开放格式
  -> 生成转换计划
  -> 暂存转换
  -> 3D/纹理 preview
  -> native container/asset validator
  -> 引用影响图
  -> PatchIR
  -> commit
  -> 重读原生资产
~~~

转换失败或映射不完整时停在暂存区。

### 22.4 原生格式策略

- Sekiro 原生模型、碰撞、材质和纹理 parser/writer 由 Bridge 自研。
- 不引入 SoulsFormats、WitchyBND、Smithbox 等作为 runtime dependency。
- Three.js 和开放格式/图像通用库可作为 UI/导入依赖，但必须完成许可证和维护审查。

---

## 23. AI 模型服务

### 23.1 配置

~~~ts
interface ModelServiceConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic-compatible';
  displayName: string;
  baseUrl: string;
  apiSurface: 'responses' | 'chat-completions' | 'anthropic-messages';
  model: string;
  credentialRef: string;
  enabled: boolean;
}
~~~

模型名必填，不硬编码“最新模型”。

OpenAI 官方配置默认 `responses`。OpenAI-compatible 服务如果只支持 Chat Completions，必须由用户明确选择，不做静默 fallback。

### 23.2 Adapter

~~~ts
interface ModelServiceAdapter {
  stream(
    request: ModelServiceRequest,
    signal: AbortSignal
  ): AsyncIterable<AgentEvent>;
}

type AgentEvent =
  | { type: 'response-started'; responseId: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call-start'; callId: string; name: string }
  | { type: 'tool-call-delta'; callId: string; jsonDelta: string }
  | { type: 'tool-call-complete'; callId: string; input: unknown }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'failed'; diagnostic: StructuredDiagnostic };
~~~

OpenAI：

- Responses API。
- strict JSON schema tools。
- typed streaming lifecycle。
- compatible Chat Completions 单独 adapter。

Anthropic：

- Messages API。
- `tool_use` / `tool_result`。
- streaming content blocks。

不暴露隐藏思维链，只显示模型服务明确提供的摘要/状态。

### 23.3 凭据

- main 使用 Electron `safeStorage`。
- Windows 使用 DPAPI。
- safeStorage 不可用时拒绝持久保存，不允许明文 fallback。
- renderer 只能读取 `hasCredential`。
- 密钥不得出现在 SQLite plaintext、WAL、日志、audit、错误详情、导出包。

### 23.4 模式

#### 计划模式

- read
- analyze
- propose
- 禁止 stage/validate/commit/rollback

#### 普通模式

- read/analyze/propose
- stage/validate
- commit 需要 main 可信确认

#### 完全权限

- 持久绑定 `ModelServiceConfig.id`。
- 跨工作区继承。
- 允许自动 commit/rollback。
- 删除并重建模型服务配置不继承旧授权。
- policy version 变化时重新授权。
- 仍不能绕过 unsupported、证据不足、validator coverage 不足、备份失败或不可回滚。

### 23.5 Context Broker

用户已裁定云端模型可读取：

- Mod 覆盖层；
- 原版游戏目录。

但只限当前已打开工作区，并排除：

- app data；
- safeStorage；
- backups/recovery/cache；
- 其他工作区；
- junction 越界；
- 命中凭据规则的内容。

每次发送记录：

- resource URI
- layer
- hash
- byte count
- model service id
- agent run id
- sent_at
- redaction summary

### 23.6 AI 历史

- 明文保存在 `app.db`。
- 默认 30 天。
- 可按工作区关闭、缩短、永久或立即清除。
- API key/令牌先脱敏再落库。
- audit 永久保留 message id/hash/元数据，不永久复制正文。

### 23.7 Agent loop

~~~text
observe
  -> plan
  -> tool
  -> verify
  -> revise
  -> patch
  -> validate
  -> commit / rollback
~~~

生产只保留一个 typed tool registry。旧工具注册表与 scaffold policy gate 必须合并。

工具输入只允许 URI、field URI、document revision、分页参数和 typed mutation；模型不得提交绝对路径。

---

## 24. 阶段实施说明

## P0：口径与安全收口

### 目标

确保后续实现建立在唯一、可信、安全的底座上。

### 工作项

1. 更新 `AGENTS.md` 当前里程碑和硬边界。
2. 重写 V0.5 milestone、decisions、next actions。
3. 增加术语与发布验收单一来源。
4. Electron sandbox/CSP/navigation/window/security。
5. IPC sender + schema 校验。
6. renderer DTO 移除 absolutePath。
7. workspace 操作改用 session id。
8. 路径 realpath/reparse point 防逃逸。
9. 删除 renderer 铸造 confirmation 的能力。
10. main 可信 confirmation。
11. recovery/backup 默认移出工作区。
12. after-commit failure 自动回滚。
13. rollback afterHash 冲突检测。
14. 统一生产 AI policy gate，禁止 renderer 决定 mode。
15. 增加 P0 安全测试。

### P0 完成条件

- renderer 无绝对路径。
- renderer 无法伪造 mode/receipt。
- junction/symlink 越界测试通过。
- recovery 不写 Mod。
- after-commit 故障注入恢复原文件。
- 当前全部回归测试仍绿。

## P1：SQLite、工作区会话与 Bridge daemon

### 工作项

1. better-sqlite3 utility process。
2. app.db/workspace.db migration runner。
3. JSON 历史迁移。
4. main workspace session manager。
5. 后台任务、取消和进度。
6. Bridge net10 daemon。
7. protocol 1.0 handshake/capabilities。
8. Oodle runtime discovery。
9. KRAK codec adapter。

### P1 完成条件

- 重启后数据库、会话历史、任务恢复状态正确。
- schema mismatch 和损坏数据库 fail closed。
- Bridge 并发/取消/超时/崩溃重启测试通过。
- KRAK 缺失与成功路径都有真实诊断。

## P2：原生容器权威

### 工作项

1. DFLT variants。
2. KRAK variants。
3. BND4 native child table。
4. stable child URI。
5. BND4 child CRUD/reorder。
6. nested container。
7. native container writer。
8. container validators。
9. TypeScript synthetic parser 从 production path 移除。

### P2 完成条件

- 私有 BND4 corpus 全部 native-verified。
- 无修改 roundtrip 通过。
- 单 child 修改不改变兄弟 child。
- CRUD/rename/reorder/repack/re-read/rollback 通过。

## P3：四类语义闭环

顺序固定：

1. FMG
2. PARAM + 参数结构定义
3. EMEVD
4. MSB

每类先完成 parser + lossless roundtrip，再开放 writer；禁止同时写半成品 parser/writer 后用 raw replace 伪装闭环。

### P3 完成条件

- 私有 corpus 所有登记变体 native-verified。
- 全 CRUD、重排、类型转换。
- 未知区段保持。
- 保存后重读。
- 引用/索引更新。
- 三层回滚。

## P4：3D 与资产转换

### 工作项

1. 私有场景资产 variant inventory。
2. 自研原生资产 parser/writer。
3. glTF/GLB 与图像导入。
4. 材质/碰撞映射规则。
5. GPU-ready chunk worker。
6. Three.js scene。
7. gizmo 与 mutation。
8. 暂存 preview。
9. asset PatchIR/validator/rollback。

### P4 完成条件

- 基线 MSB 可显示完整场景。
- overlay/base 叠加正确。
- 资产导入转换成功。
- native 重读成功。
- 真实游戏 smoke 能加载测试 Mod。

## P5：专业桌面

### 工作项

1. App shell。
2. editor tabs/document store。
3. resource tree virtualization。
4. Hex。
5. EMEVD 四视图。
6. PARAM。
7. 参数结构定义。
8. FMG。
9. MSB/3D。
10. patch/reference graph。
11. diagnostics/jobs/history/recovery。
12. i18n。

### P5 完成条件

- 所有编辑器只产生统一 mutation。
- 大列表不全量 DOM。
- 四视图 revision/selection 一致。
- 关闭标签页和切换资源取消旧任务。
- 中文术语扫描通过。

## P6：双模型服务 Agent

### 工作项

1. app.db model service config。
2. safeStorage。
3. OpenAI Responses adapter。
4. OpenAI Chat Completions compatible adapter。
5. Anthropic Messages adapter。
6. normalized streaming events。
7. unified tool registry。
8. Context Broker。
9. persistent full-permission。
10. AI history/retention。
11. agent loop。
12. outbound audit。

### P6 完成条件

- 本地 fake server 完整 tool loop。
- 两类真实模型服务各一次手工 smoke。
- 凭据泄漏扫描为 0。
- provider A 权限不泄漏给 provider B。
- 完全权限重启后保持、撤销立即生效。

## P7：发行加固

### 工作项

1. Vitest/xUnit/Playwright 测试层。
2. Windows CI。
3. electron-builder 安装包与便携包。
4. 代码签名。
5. 签名更新 manifest。
6. 提示式自动更新。
7. 数据库/适配包升级。
8. 崩溃恢复向导。
9. 性能基准。
10. 真实 Sekiro 发布门禁。

### P7 完成条件

- 安装、升级、降级拒绝、卸载保留策略测试通过。
- release package 不含私有语料、密钥或 Oodle。
- 性能门槛通过。
- 真实游戏发布门禁通过。

---

## 25. 测试策略

### 25.1 测试框架

- TypeScript：Vitest。
- C#：xUnit。
- Electron：Playwright Electron。
- 现有 `runV05*Smoke` / `runV06*Smoke` 保留为回归入口，逐步让底层逻辑进入正式测试框架。

### 25.2 Synthetic 测试

允许提交：

- 合法构造的微型 DCX/BND/EMEVD/MSB/PARAM/FMG。
- 截断、越界、未知版本、重复 id。
- 完整 CRUD。
- roundtrip。
- property/fuzz tests。

Synthetic 只能是 `fixture-confirmed`。

### 25.3 私有 native 语料

仓库外 registry：

~~~text
fixtureId
localPath
sha256
game
format
variant
expectedAuthority
expectedCapabilities
expectedAssertions
~~~

仓库只提交 registry schema 和 runner。

支持环境变量：

~~~text
SOULFORGE_NATIVE_FIXTURE_ROOT
SOULFORGE_SEKIRO_GAME_ROOT
~~~

测试输出不得复制资产内容，只输出 fixture id、hash、variant、断言和诊断。

### 25.4 Native roundtrip

每个格式：

1. parse。
2. serialize without change。
3. reparse。
4. compare semantic IR。
5. compare unknown regions。
6. compare payload hash 或字节。
7. mutate one item。
8. serialize/reparse。
9. 断言目标变化。
10. 断言兄弟/未知数据不变。
11. rollback。

### 25.5 安全测试

- renderer 伪造 IPC sender。
- renderer 伪造 mode。
- renderer 伪造 receipt。
- absolute path input。
- cross-workspace session id。
- symlink/junction escape。
- base write。
- recovery path escape。
- API key 出现在 DB/WAL/log/error/export。
- untrusted adaptation package。
- adaptation package path traversal。
- oversized Bridge frame。
- invalid NDJSON。
- daemon crash。

### 25.6 故障注入

在以下点注入：

- pending journal 之前/之后。
- staging 中途。
- validator 中途。
- backup 中途。
- 第一个文件 replace 后。
- 多文件 replace 中途。
- after-commit validator。
- DB mark committed。
- index update。
- rollback 中途。

每个点必须在重启后确定性完成或回滚。

### 25.7 AI 测试

- fake OpenAI Responses SSE。
- fake Chat Completions SSE。
- fake Anthropic Messages SSE。
- partial JSON tool args。
- multiple tool calls。
- cancel。
- 401/429/5xx。
- malformed stream。
- context upload audit。
- secret redaction。
- provider permission isolation。
- 30 天历史清理。

---

## 26. 性能验收

参考机器固定为：

- Windows 11
- Intel i7-13650HX
- 16GB RAM
- RTX 4060 Laptop GPU
- NVMe SSD

门槛：

| 场景 | 门槛 |
|---|---|
| 10,000 文件工作区首个可操作文件树 | ≤3 秒 |
| 取消反馈 | ≤500ms |
| 空闲内存 | ≤600MB |
| 3D 首屏可操作 | ≤5 秒 |
| 3D 场景内存 | ≤2GB |
| 3D 交互 | 最低 30 FPS，目标 60 FPS |
| renderer 连续主线程阻塞 | 不得 >50ms |

实现要求：

- 启动不全量解析。
- 文件树/表格/Hex 虚拟化。
- scene progressive。
- Bridge/worker 可取消。
- stale result 按 request id/revision 丢弃。
- tab 关闭释放 GPU 和大 buffer。

---

## 27. Windows CI 与发行

### 27.1 CI

Windows x64 CI：

1. npm clean install。
2. .NET 10 restore/build/test。
3. typecheck。
4. unit/integration。
5. synthetic Bridge。
6. Electron build。
7. Playwright smoke。
8. dependency/security scan。
9. self-contained Bridge publish。
10. package contents audit。

真实游戏语料只在本机 release gate，不进云 CI。

### 27.2 发行

- electron-builder。
- 签名安装包。
- 便携 ZIP。
- 签名更新 manifest。
- 自动更新默认提示后执行，可在设置关闭。
- 签名证书、官方适配包私钥、更新私钥只来自 CI secret。
- 没有有效签名的产物不得标记为正式 V0.5 release。

---

## 28. 真实游戏发布门禁

正式 V0.5 发布前，必须在私有测试副本上完成：

1. 打开代表性 Sekiro Mod 覆盖目录。
2. 挂载原版只读目录。
3. DFLT 与 KRAK 各完成解压/重建。
4. BND4 child CRUD/repack。
5. FMG CRUD、保存、重读、回滚。
6. PARAM 与参数结构定义修改、保存、重读、回滚。
7. EMEVD CRUD/重排/类型转换、保存、重读、回滚。
8. MSB CRUD/transform/type conversion、保存、重读、回滚。
9. 打开完整 MSB 3D 场景。
10. 导入一份 glTF/GLB。
11. 导入一份 PNG/TGA/DDS。
12. 自动转换并替换资产。
13. 显示补丁关系图。
14. 通过 Patch Engine 提交。
15. 启动 Sekiro，验证测试 Mod 可加载。
16. 三层回滚。
17. 再次启动 Sekiro，验证恢复。
18. OpenAI-compatible 完成一次真实工具循环。
19. Anthropic-compatible 完成一次真实工具循环。
20. 检查所有日志、DB、导出物无凭据。

任何一项失败，V0.5 不得标记完成。

---

## 29. 每阶段提交与文档纪律

每个实现批次：

1. 小范围、可描述。
2. 先测试再提交。
3. 只更新本文“实施进度记录”，不得新建与本文并行的 milestone、decisions、next-actions 或 status 文档。
4. 明确：
   - 已实现；
   - 已验证；
   - 未验证；
   - 非声明。
5. 不把 synthetic、candidate、partial 写成 native complete。
6. 不把未跑真实模型、真实游戏或真实 corpus 写成通过。
7. 不因为测试环境不便而关闭校验或放宽约束。

---

## 30. 接手 Agent 的第一批具体任务

P0 与 P1 的 transport / persistence 基础已经落地。接手后不要重做这些工作，也不要直接开始四类语义 parser；第一批应严格是：

1. 重新确认 `git status`、HEAD 和未跟踪 `mcps/**`。
2. 跑基线验证。
3. 安装/定位用户 Sekiro Oodle runtime，先实现“缺失、版本错误、导出缺失、加载失败”的结构化诊断，不分发 DLL。
4. 在 C# Bridge 内实现 KRAK codec adapter，先完成私有样本只读解压证据，再开放重压；不得在 TypeScript 再实现一份。
5. 给 Bridge daemon 增加真实进程崩溃、在途读取消、在途写不重放、重启后重新握手的故障注入。
6. 将 `workspace.db` 从操作日志扩到 transaction journal、恢复点、file/resource entry changes、audit；先写 repository contract 和迁移测试。
7. 实现旧 semantic snapshot 的严格幂等导入；损坏源必须失败关闭并保留。
8. 建立 main `WorkspaceSessionManager` 和后台任务 service，逐步移除 `ipc.ts` 全局状态。
9. 补 file/resource entry 两级 inverse PatchIR 回滚；每级都必须先校验当前 `afterHash`。
10. 完成以上 P1 缺口后，再开始 P2 的真实 DFLT variant 与 BND4 parser/repack。

不要删除或降级现有安全、SQLite utility、Bridge daemon 和双 ABI 门禁来简化实现。

---

## 31. 完成定义

只有同时满足以下条件，才能说“V0.5 完成”：

- 文档只有一个有效发布口径。
- P0–P7 全部通过。
- Sekiro 私有语料矩阵全部达到预期 authority。
- DFLT/KRAK/BND4 和四类语义资源真实闭环。
- 专业桌面与完整 3D 场景可用。
- 开放格式资产转换可用。
- 双模型服务 Agent 可用。
- Patch Engine 是所有写入的唯一主干。
- 三层持久回滚可用。
- Windows 安装/升级/签名/更新可用。
- 性能门槛通过。
- 真实 Sekiro 启动 smoke 通过。
- 没有提交真实资产或明文凭据。
- 未支持能力诚实显示为 unsupported/candidate，而不是伪完成。

---

## 32. 参考资料

- .NET 支持周期：<https://dotnet.microsoft.com/en-us/platform/support/policy>
- Electron 安全：<https://www.electronjs.org/docs/latest/tutorial/security>
- Electron safeStorage：<https://www.electronjs.org/docs/latest/api/safe-storage>
- OpenAI function calling：<https://developers.openai.com/api/docs/guides/function-calling>
- OpenAI streaming Responses：<https://developers.openai.com/api/docs/guides/streaming-responses>
- Anthropic tool use：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>
- Anthropic streaming：<https://platform.claude.com/docs/en/build-with-claude/streaming>

外部 FromSoftware Mod 工具只能用于行为观察与结果对照，不能复制源码进入 SoulForge。

---

## 33. 当前代码模块地图

本节用于让接手者不依赖其他规划文档即可快速定位现有实现。路径以仓库根目录为基准。

### 33.1 Shared：公共类型

| 文件 | 当前职责 | V0.5 处理 |
|---|---|---|
| `packages/shared/src/types.ts` | IndexedFile、诊断、确认凭据、PatchProposal 等旧公共类型 | 保持兼容一个迁移周期；拆分 renderer-safe DTO；确认凭据升级为签名结构 |
| `packages/shared/src/bridge-protocol.ts` | 已升级为协议 1.0 daemon frame 与 authority/capability 类型 | P2/P3 继续补 native document 和 mutation schema，不另建第二套协议 |
| `packages/shared/src/patch-ir.ts` | file/raw/text/resource/container synthetic PatchIR | 增加 schemaVersion、reorder、convert、asset import、typed payload、inverse |
| `packages/shared/src/writer-contract.ts` | writer staging contract | 增加 captureInverse、document/layout/revision 前置条件 |
| `packages/shared/src/resource-graph.ts` | 内存图和 SQLite row DTO | 增加 temporal revision、field identity、entry change link |
| `packages/shared/src/resourceSymbols.ts` | event/map/param/msg 索引投影 | 保持只读 projection；不得扩成无损 document |
| `packages/shared/src/ai-tools.ts` | typed tool/evidence/plan scaffold | 成为唯一生产 AI 工具协议 |
| `packages/shared/src/audit-log.ts` | audit scaffold | 接到 SQLite，补 Provider、workspace、outbound context 和 confirmation refs |
| `packages/shared/src/vfs.ts` | VFS node，当前可含 absolutePath | 公共 renderer DTO 移除 absolutePath；main/core 私有类型可保留 |

### 33.2 Core：工作区与索引

| 目录/文件 | 当前状态 | V0.5 处理 |
|---|---|---|
| `packages/core/src/workspace/workspaceSession.ts`、`pathBoundary.ts` | 已做 canonical root、realpath/reparse 防逃逸和安全写路径解析 | P1 继续由 main session manager 收口多 handler 全局状态 |
| `packages/core/src/workspace/scanWorkspace.ts` | 递归扫描 | 改成分页/进度/取消，避免重复扫描 |
| `packages/core/src/workspace/gameProfiles.ts` | 内置 ad-hoc GameProfile | 迁移为游戏适配包 registry；保留兼容 adapter 后删除 |
| `packages/core/src/workspace/semanticWorkspaceIndex.ts` | 内存图 + JSON snapshot | 迁移到 workspace.db repository |
| `packages/core/src/indexing/workspaceIndex.ts` | 旧索引聚合 | 抽象 repository，避免和新 SQLite 图形成双权威 |
| `packages/core/src/pipeline/workspacePipeline.ts` | workspace 分析与 Bridge 调用 | 接 main task service、daemon、request id、取消与增量入库 |
| `packages/core/src/jobs/taskQueue.ts` | 基础队列 | 扩展 dependency、持久 job state、恢复和优先级 |
| `packages/core/src/vfs/*` | bounded VFS | 保留；生产路径只在 main/core 存绝对路径 |

### 33.3 Core：写入与恢复

| 目录/文件 | 当前状态 | V0.5 处理 |
|---|---|---|
| `packages/core/src/transactions/workspaceTransaction.ts` | 唯一 commit owner；已有物理路径边界与 after-commit 自动恢复 | 接 SQLite transaction journal 和更完整故障点持久恢复 |
| `packages/core/src/patch/durablePatchCommit.ts` | 异步 pending/committed store + transaction +应用数据 recovery | 将 recovery metadata/restore point 纳入 workspace.db 生命周期与保留策略 |
| `packages/core/src/patch/operationLog.ts`、`sqliteOperationLogStore.ts` | 异步 store 契约与 workspace.db operation repository | 扩到 transaction/file/resource entry/audit repositories |
| `packages/core/src/patch/fileOperationLogStore.ts`、`importLegacyOperationLog.ts` | JSON store 仅供兼容测试；生产严格幂等导入且损坏失败关闭 | 语义 snapshot 迁移完成后删除生产 JSON 入口，保留测试兼容 |
| `packages/core/src/patch/rollback.ts` | operation 级 inverse PatchIR 新事务和 afterHash/backupHash 冲突保护 | 增加 file/resource entry scope，不修改旧操作状态 |
| `packages/core/src/backup/restorePoint.ts` | 支持应用数据目录恢复点 | 接内容寻址去重、30 天/10GB 保留和引用保护 |
| `packages/core/src/staging/contentAddressedStaging.ts` | 内容寻址暂存骨架 | 保留并接 workspace local data root/retention |
| `packages/core/src/writers/*` | text/raw/synthetic/container synthetic writers | synthetic 只留测试；新增 Bridge native writer adapter |
| `packages/core/src/validators/*` | text/raw/container synthetic validators | 增加多层 native validators 和 after-commit 恢复 |
| `packages/core/src/editing/*` | save text/raw/container child | 改为 resource URI + session，不接收 renderer absolutePath |

### 33.4 Core：容器和 Bridge

| 目录/文件 | 当前状态 | V0.5 处理 |
|---|---|---|
| `packages/core/src/bridge/runBridge.ts`、`bridgeDaemonClient.ts` | 生产复用协议 1.0 常驻进程；支持 timeout/cancel/progress/crash invalidation | 补写操作故障注入、自包含发行定位和 native 命令 |
| `packages/core/src/bridge/bridgeProtocolScaffold.ts` | 仅保留测试 capability helper，不再从 core 生产入口导出 | P2 继续收缩 synthetic 边界 |
| `packages/core/src/containers/dcx.ts` | TypeScript DFLT production-like parser | 降级为 synthetic/test helper，不再做 production authority |
| `packages/core/src/containers/bndSynthetic.ts` | SFBN synthetic BND | 只留测试 |
| `packages/core/src/containers/fmgSynthetic.ts` | SFFX synthetic FMG | 只留测试 |
| `packages/core/src/containers/containerService.ts` | synthetic/DFLT container API | 对外 API 保留语义，内部改成 Bridge client |
| `packages/core/src/writers/containerChildReplaceWriter.ts` | synthetic BND child replace | 改为 Bridge native staging adapter |
| `packages/core/src/validators/containerRoundTripValidator.ts` | synthetic/DFLT roundtrip | 改成 Bridge native validator |

### 33.5 Core：AI

| 目录/文件 | 当前状态 | V0.5 处理 |
|---|---|---|
| `packages/core/src/ai/assistantSession.ts` | mock 草稿，真实 provider 恒 notConfigured | P6 替换为真实 session/orchestrator |
| `packages/core/src/ai/toolRegistry.ts` | 旧生产工具注册表 | 与 scaffold registry 合并，最终删除旧权限标签 |
| `packages/core/src/ai/toolPermissions.ts` | mode → permission rank | 修正计划模式；权威 mode 只由 main 上下文提供 |
| `packages/core/src/ai/evidencePackBuilder.ts` | 证据包 | 接 SQLite/Context Broker；不暴露 absolutePath |
| `packages/core/src/ai-tools/scaffoldToolRegistry.ts` | typed registry smoke | 升级为唯一生产 registry |
| `packages/core/src/ai-tools/policyGate.ts` | 综合策略 scaffold | 升级为生产 policy gate |
| `packages/core/src/audit-log/*` | memory audit | 替换为 DB repository |

### 33.6 Desktop

| 文件 | 当前状态 | V0.5 处理 |
|---|---|---|
| `apps/desktop/src/main/index.ts` | sandbox/CSP 配套窗口安全和 Bridge/DB 关闭生命周期已落地 | P1/P5 拆出 app service container 和 domain 生命周期 |
| `apps/desktop/src/main/ipc.ts` | sender 校验、一次性目录选择、main 确认、资源 URI 和 utility DB 已接；仍是单体全局状态 | 拆为 domain handlers + `WorkspaceSessionManager`，补 runtime schema |
| `apps/desktop/src/main/rendererDto.ts` | 已统一剔除绝对路径等 main-only 字段 | 所有新增 DTO 必须复用或替换为 versioned runtime schema |
| `apps/desktop/src/main/databaseUtility.ts`、`operationLogUtilityClient.ts` | Electron utility process 托管 `app.db/workspace.db` 与异步操作日志 RPC | 增加全部 repositories、任务恢复、崩溃重启故障注入和审计 |
| `apps/desktop/src/preload/index.ts` | 已删除确认铸造、绝对根路径和 renderer mode；仍是单个 API 对象 | 按 versioned domain API 拆分，输入输出 runtime validation |
| `apps/desktop/src/renderer/src/App.tsx` | 千行级单体 | P5 拆除，仅保留 app bootstrap/router |
| `apps/desktop/src/renderer/src/styles.css` | 固定三栏全局 CSS | 迁移为应用壳/编辑器局部样式与主题 tokens |
| `apps/desktop/electron.vite.config.ts` | 已增加 database utility 与运行 smoke 入口 | P4/P5 再增加转换 worker、Three chunk 和发行打包配置 |

### 33.7 Bridge

| 文件/目录 | 当前状态 | V0.5 处理 |
|---|---|---|
| `bridge/SoulForge.Bridge/Program.cs`、`BridgeDaemonHost.cs` | net10 daemon bootstrap + 一次性测试兼容入口 | P2 增加 native command service，不恢复 production one-shot |
| `bridge/SoulForge.Bridge/ParserTypes.cs` | BridgeResult/diagnostic 类型 | 迁移到 protocol 1.0 envelope 与 authority |
| `bridge/SoulForge.Bridge/EnvelopeInspection.cs` | bounded envelope evidence | 保留作为 inspect 第一层 |
| `bridge/SoulForge.Bridge/DcxPayloadProbe.cs` | 边界与 DFLT preview | 扩展为严格 DCX variant parser；full codec 分到独立模块 |
| `bridge/SoulForge.Bridge/Synthetic*` | synthetic fixtures | 保留测试，显式 fixture-confirmed |
| `bridge/SoulForge.Bridge/SemanticCandidateExports.cs` | candidate 导出 | native parser 完成后仅作 unsupported fallback，不能混入 verified output |
| `bridge/SoulForge.Bridge/SoulForge.Bridge.csproj`、`global.json` | 已升级 net10.0、自包含 `win-x64`、single-file publish | P7 接入签名发行构建并验证干净机启动 |

---

## 34. 阶段文件落点与交付物

本节是实施者的文件级导航，不表示必须机械地只修改这些文件；新增模块必须遵循相同层级职责。

### 34.1 P0

主要修改：

- `AGENTS.md`
- `README.md`
- `docs/V0_5_IMPLEMENTATION_HANDOFF.md`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/ipc.ts`（随后拆目录）
- `apps/desktop/src/preload/index.ts`
- `packages/core/src/workspace/workspaceSession.ts`
- `packages/core/src/patch/durablePatchCommit.ts`
- `packages/core/src/patch/rollback.ts`
- `packages/core/src/transactions/workspaceTransaction.ts`
- `packages/shared/src/types.ts`

新增交付物：

- `apps/desktop/src/main/security/*`
- `apps/desktop/src/main/sessions/*`
- `packages/shared/src/ipc/*`
- P0 security smoke/test。

发布标准、术语、阶段状态和裁定继续维护在本文中；不要再拆出平行规划文档。

### 34.2 P1

新增主要目录：

~~~text
packages/core/src/db/
  app/
  workspace/
  migrations/
  repositories/

apps/desktop/src/main/databaseUtility.ts
apps/desktop/src/main/operationLogUtilityClient.ts
apps/desktop/src/main/operationLogUtilityProtocol.ts
apps/desktop/src/main/bridge/
apps/desktop/src/main/jobs/

bridge/SoulForge.Bridge/Protocol/
bridge/SoulForge.Bridge/Daemon/
bridge/SoulForge.Bridge/Codecs/
bridge/SoulForge.Bridge/Workspace/
~~~

P1 结束时，生产不得再调用 `dotnet run`。

### 34.3 P2

Bridge 新增：

~~~text
Formats/Dcx/
Formats/Bnd4/
Codecs/Oodle/
Containers/
Validation/Containers/
~~~

TypeScript 新增 Bridge-backed adapters，不新增第二份 native parser。

### 34.4 P3

Bridge：

~~~text
Formats/Fmg/
Formats/Param/
Formats/Emevd/
Formats/Msb/
Validation/Semantic/
IndexProjection/
~~~

Shared：

~~~text
native-document.ts
fmg-document.ts
param-document.ts
emevd-document.ts
msb-document.ts
semantic-mutations.ts
~~~

### 34.5 P4

~~~text
bridge/SoulForge.Bridge/Formats/SceneAssets/
bridge/SoulForge.Bridge/Conversion/
apps/desktop/src/workers/assets/
apps/desktop/src/renderer/src/three/
packages/shared/src/scene-protocol.ts
packages/shared/src/asset-import.ts
~~~

### 34.6 P5

按本文 16.1 的 renderer 目录拆分。每个 editor 必须有：

- document adapter
- view state
- mutation controller
- validation panel
- component tests
- Electron E2E page object

### 34.7 P6

~~~text
packages/core/src/model-services/
  openai/
  anthropic/
  streaming/
  config/

packages/core/src/agent/
  orchestrator/
  context/
  policy/
  history/

apps/desktop/src/main/model-services/
apps/desktop/src/renderer/src/ai/
~~~

### 34.8 P7

~~~text
.github/workflows/windows-ci.yml
apps/desktop/electron-builder.yml
tests/e2e/
tests/performance/
scripts/release/
scripts/native-validation/
~~~

---

## 35. 依赖清单与引入规则

下列依赖是本规范已裁定的实现选择；实施者不需要再次选择同类库。

### 35.1 TypeScript/Electron

| 依赖 | 用途 | 限制 |
|---|---|---|
| `better-sqlite3` | SQLite driver | 只在 utility process；Electron ABI rebuild 纳入 CI |
| `@electron/rebuild` | 隔离生成 Electron ABI 的 SQLite native binding | 只重建 `apps/desktop/.native` 副本；不得原地改坏 Node 测试 binding |
| `@sinclair/typebox` | 公共 runtime schema + TS 类型 | IPC、Bridge、manifest、AI tool 共用 |
| `ajv` | TypeBox/JSON Schema 校验 | 禁止 renderer 输入绕过 |
| `three` | WebGL2 3D | renderer 绘制与官方 examples loaders |
| `@tanstack/react-virtual` | 资源树、PARAM、FMG、Hex 虚拟化 | 不再自写近似虚拟列表 |
| `@xyflow/react` | EMEVD/补丁/引用图 | 图模型仍来自 shared/core，不把业务状态藏组件 |
| `@codemirror/state` / `view` / `language` | DSL、文本和 Hex 辅助视图 | 不引入 Monaco |
| `i18next` / `react-i18next` | 中英双语 | 所有用户字符串进资源 |
| `fflate` | 确定性 .sfadapt ZIP | 先做 path traversal 与大小限制 |
| `vitest` | TS 测试 | workspace 统一配置 |
| `@playwright/test` | Electron E2E | Windows CI |
| `electron-builder` / `electron-updater` | 安装、签名、更新 | 只在 P7 接入 |

开放格式加载：

- glTF/GLB 使用 Three `GLTFLoader`。
- TGA 使用 Three `TGALoader`。
- DDS 使用 Three `DDSLoader`。
- PNG 使用 worker `createImageBitmap`。
- loader 只解析 main 传入的 ArrayBuffer，不自行读路径。

### 35.2 C#

- 测试使用 xUnit。
- JSON 使用 `System.Text.Json`。
- ZIP、hash、签名和基础压缩优先使用 .NET BCL。
- FromSoftware 原生格式不得引入外部 parser/writer package。
- Oodle 只做动态 DLL 调用，不添加可分发 NuGet codec。

### 35.3 引入检查

每个新依赖必须记录：

- 许可证。
- 当前维护状态。
- 打包体积。
- Electron/Node ABI 风险。
- 是否进入 renderer。
- 替换边界。

禁止为了绕过一个测试引入一次性依赖。

---

## 36. 兼容、迁移与删除顺序

### 36.1 Bridge

1. 先实现 protocol 1.0 types 和 daemon。
2. main 新 client 通过 feature flag 接 daemon。
3. 让全部现有 Bridge smoke 同时走新 client。
4. 删除 production `dotnet run`。
5. 保留旧 CLI wrapper 一个阶段，仅供开发命令调用 daemon。
6. P2 前删除旧 BridgeResult 双模型，避免两套 authority。

不得长期同时维护旧 CLI JSON 与 1.0 envelope 两套生产协议。

### 36.2 IPC

1. 新增 versioned preload API。
2. renderer 切到 session/URI。
3. 新旧 handler 并存只允许一个阶段。
4. E2E 全部迁移后删除 absolute path handler。
5. CI grep 阻止 renderer/preload 出现 `absolutePath` 和原始根目录输入。

### 36.3 SQLite

1. 建库和 migrations。
2. shadow import 旧 JSON。
3. 对比历史。
4. 切 read path。
5. 切 write path。
6. 保留只读 migrated JSON。
7. 删除 production JSON store。

不允许长期双写 SQLite + JSON。

### 36.4 PatchIR

- 添加 `schemaVersion`。
- 旧 PatchProposal 经唯一 adapter 升级。
- operation log 记录原 schema 与升级结果。
- native semantic writer 只接受新版本 PatchIR。
- P3 后禁止生产生成 `synthetic_resource_edit`。

### 36.5 GameProfile

1. 内置 Sekiro 旧 `GameProfile` 转成 built-in `.sfadapt`。
2. `getGameProfile` 通过 registry compatibility adapter 返回。
3. 所有调用方迁移到 adaptation package service。
4. 删除硬编码 profile 数组。

---

## 37. 诊断代码与错误契约

所有公共失败使用：

~~~ts
interface StructuredDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  sourceUri?: string;
  details?: Record<string, unknown>;
  recordedAt?: string;
}
~~~

### 37.1 Code 前缀

| 前缀 | 领域 |
|---|---|
| `IPC_*` | IPC schema/sender/session |
| `PATH_*` | 路径、reparse、越界 |
| `CONFIRMATION_*` | 用户确认与 nonce |
| `DB_*` | SQLite、迁移、损坏 |
| `BRIDGE_*` | daemon/protocol |
| `DCX_*` | DCX |
| `OODLE_*` | KRAK runtime |
| `BND4_*` | BND4 |
| `FMG_*` | FMG |
| `PARAM_*` | PARAM/结构定义 |
| `EMEVD_*` | EMEVD |
| `MSB_*` | MSB |
| `ASSET_*` | 场景资产/转换 |
| `PATCH_*` | PatchIR |
| `TRANSACTION_*` | 事务 |
| `ROLLBACK_*` | 回滚 |
| `RECOVERY_*` | 崩溃恢复 |
| `MODEL_SERVICE_*` | 模型服务网络/配置 |
| `AGENT_*` | agent loop |
| `ADAPTATION_PACKAGE_*` | 游戏适配包 |

### 37.2 失败语义

- `unsupported`：能力明确不存在，重试无用。
- `candidate`：只获得候选证据，不允许写。
- `failed`：本应支持但输入损坏或实现失败。
- `partial`：仅部分读取，必须列出缺失部分。
- `timeout`：deadline 到期。
- `cancelled`：用户/系统取消。
- `unsafe`：能力存在但安全前置条件不满足。
- `schemaMismatch`：协议/包/文档版本不兼容。

错误 message 面向用户必须中文化；code 保持英文稳定。

---

## 38. 审计事件

每个审计事件至少包含：

- eventId
- workspaceId
- actor kind/id
- modelServiceConfigId（若有）
- agentRunId（若有）
- action
- target resource URIs
- patch/transaction id
- permission mode
- policy version
- confirmation/grant ref
- result
- diagnostic codes
- createdAt

必须记录：

- 工作区打开/关闭。
- 原版目录挂载。
- 模型服务授权/撤销。
- 原版/Mod 内容发送云端。
- tool call。
- patch propose/stage/validate/commit。
- rollback/recovery。
- 适配包安装/启用/签名/信任。
- updater。

audit 不永久复制 API key、完整二进制、过期 AI 正文。

---

## 39. 阶段交付记录

每个阶段完成时，接手者必须在本文“实施进度记录”中追加一条自包含记录。真实命令日志和测试产物放在应用数据目录或系统临时目录，默认不提交仓库；仓库内不得创建 `docs/status/*` 或 `artifacts/*` 作为第二套状态来源。

记录必须列出 pass/fail/skipped/unverified；skipped/unverified 不能算阶段完成。建议结构：

~~~json
{
  "phase": "P0",
  "commit": "sha",
  "status": "pass",
  "commands": [
    { "command": "npm run typecheck", "exitCode": 0 }
  ],
  "requirements": [
    { "id": "P0-IPC-ABSOLUTE-PATH", "status": "pass", "evidence": "..." }
  ],
  "unverified": [],
  "nonClaims": []
}
~~~

本结构直接嵌入本文的阶段记录，不要求创建独立 JSON 文件。记录中不能包含真实资产、绝对用户路径、API key 或其他凭据。

---

## 40. 停止条件与禁止权宜措施

接手者遇到以下条件必须停止相关写能力，而不是做临时绕过：

- 私有 native 样本与 parser 假设冲突。
- 未知字段无法无损保留。
- writer 无法证明 roundtrip。
- Oodle runtime 不兼容。
- adaptation package 签名或依赖失败。
- DB migration 无法幂等。
- after-commit 失败无法自动恢复。
- renderer 仍能获得绝对路径或铸造权限。
- validator coverage 不完整。
- 真实游戏 smoke 崩溃。
- 性能门槛只能靠关闭验证达到。

禁止：

- hardcode 本机路径。
- commit DLL/asset/key。
- catch 后返回成功。
- 把 unknown 当默认值重写。
- raw replace 冒充 native writer。
- synthetic 冒充 native。
- 为通过测试删除或放宽断言。
- 在完全权限中绕过 Patch Engine。
- 长期保留两套生产协议/数据库/写入主干。

---

## 41. 接手者无需再裁定的事项

以下事项已经确定，不得再次询问或自行替换：

- V0.5 收口发布，D 级非核心能力后移。
- Sekiro 单一权威游戏基线。
- DFLT/KRAK/BND4。
- EMEVD/MSB/PARAM/FMG 四类完整 CRUD/重排/支持类型转换。
- 未知数据无损保留。
- Windows x64。
- .NET 10 daemon。
- Oodle 从游戏目录动态加载。
- 声明式、签名游戏适配包。
- 用户派生包自签名。
- SQLite 两库权威存储。
- better-sqlite3 utility process。
- 三层持久回滚。
- Three.js WebGL2 完整场景。
- glTF/GLB/PNG/TGA/DDS 导入。
- 不支持 FBX/DAE/OBJ。
- 资产自动转换后替换。
- EMEVD 四视图。
- PARAM 结构定义可编辑。
- FMG 完整本地化工作台。
- 双模型服务 Agent。
- safeStorage/DPAPI。
- 完全权限绑定模型服务配置并跨工作区。
- 模型可发送 Mod 和原版目录内容。
- AI 正文明文保存 30 天。
- 中英双语，简体中文默认。
- Windows CI。
- 签名安装包、便携包、提示式自动更新。
- 单工作区、多编辑器标签。

只有真实格式证据证明某项客观不可成立时，才回报用户重新裁定。

---

## 42. 最终执行检查表

接手者可以按此清单持续推进，无需返回其他规划文档：

- [x] 基线验证与工作树核对（2026-07-10；后续接手仍须重跑）
- [x] P0 文档口径
- [x] P0 Electron 安全
- [x] P0 IPC/session/path 安全边界
- [x] P0 confirmation/recovery/operation rollback
- [x] P0 全量回归
- [x] P1 .NET 10 与自包含 `win-x64` 配置
- [x] P1 Bridge daemon transport / protocol 1.0
- [x] P1 Bridge 写操作崩溃恢复故障注入（BND4 staging writer；失败关闭且不自动重放）
- [x] P1 SQLite 两库 migration/utility process 基础
- [x] P1 SQLite 核心 repositories/任务恢复发现/audit（恢复目录实际清理仍需 main 安全执行器）
- [x] P1 operation log JSON 严格幂等迁移
- [x] P1 semantic snapshot 严格幂等迁移
- [x] P1 file/resource entry inverse rollback（基础设施与 fixture-confirmed 闭环；native writer 仍按 P2/P3 门禁）
- [ ] P1 Oodle/KRAK（失败关闭已验证；真实成功路径 `unverified-no-local-sekiro-runtime`）
- [x] P2 DFLT variants（本机私有基线 144/144 完整 payload roundtrip；KRAK 单列）
- [x] P2 BND4 native（DFLT 外层 production 读写；KRAK 内 BND4 仍 blocked）
- [x] P2 child CRUD/repack（DFLT-BND4 五类 + resource-entry inverse；KRAK 未覆盖）
- [x] P2 container roundtrip（DFLT-BND4 已验证；完整 corpus 仍受 KRAK 阻塞）
- [x] P3 FMG（item.msgbnd 18/18 语义往返 + 写入 + BND4 提交/回滚）
- [x] P3 PARAM（紧凑布局读写/提交/回滚；旧布局 2/40 样例 unsupported；paramdef 未做）
- [x] P3 参数结构定义（用户派生 ParamDefDocument 布局校验/字段解码编码；原生 .paramdef 二进制解析与官方适配包签名未完）
- [x] P3 EMEVD（全量表 1730/33266；rest/id；等长与变长 instruction args GC；add/delete/duplicate 事件 GC；fixture EMEDF；layerCount≠0 未完）
- [x] P3 MSB（models/parts + POINT regions 1504 + EVENT 64；part/region 位置写回；全实体 CRUD/增删未完）
- [x] P3 graph/index/diagnostics（MemoryResourceGraph + WorkspaceIndex 健康报告与候选引用诊断）
- [x] P3 resource entry rollback（BND4 五类；语义格式复用主干）
- [x] P4 scene asset inventory（MSB manifest → candidate 模型/材质引用清单；无 FLVER 原生解析）
- [x] P4 native scene formats（FLVER 头 + mesh 表 candidate；完整几何/材质/writer 未完）
- [x] P4 open-format import（glTF/GLB/PNG/TGA/DDS 暂存主干；原生转换未完）
- [x] P4 Three.js scene（代理几何 WebGL2；真实 mesh/LOD 未完）
- [x] P4 asset conversion/writeback（暂存→PatchIR file_replace；最小 RGBA→DDS 编码器已通；FLVER 未完）
- [x] P5 app shell/document store（统一 EditorDocumentStore/mutation 协议）
- [x] P5 Hex（HexDocument + 渲染进程 Hex 面板）
- [x] P5 EMEVD 四视图（实时 `readEmevdDocument` 映射四视图 + mutation 经 `applyEmevdMutation`→PatchIR；无文件时回退演示文档）
- [x] P5 PARAM/结构定义（实时读/写 + 复制行 `sourceId` 载荷 upsert；ParamDef 面板仍为用户派生 fixture；官方包签名未完）
- [x] P5 FMG（实时 `readFmgDocument`/`applyFmgMutation`→Bridge+PatchIR；无文件时回退演示条目）
- [x] P5 MSB 3D（实时读 parts/regions；part+region 位置微调 → `applyMsbMutation`→PatchIR；Three 代理；无文件时回退演示）
- [x] P5 patch/reference/history/jobs（workbench 投影 + 任务/历史/诊断/补丁影响面板）
- [x] P5 i18n（简体中文界面字符串 + 静态术语扫描；完整 i18next 资源包/英文化切换未完）
- [x] P6 OpenAI Responses（`/v1/responses` adapter + fake SSE tool loop）
- [x] P6 OpenAI Chat Completions compatible（adapter + fake-server tool loop）
- [x] P6 Anthropic Messages（adapter + fake-server tool loop）
- [x] P6 credentials/grants/context/audit（safeStorage vault + IPC + 设置面板；真机 DPAPI 运行 smoke 未完）
- [x] P6 agent loop（plan/normal/full 门禁 + 完全权限仍走 Patch Engine 闸）
- [x] P7 unit/integration/E2E（Vitest 未全量迁移；现有 smoke 层 + CI 入口已接；Playwright Electron E2E 未完）
- [x] P7 Windows CI（`.github/workflows/windows-ci.yml`：公开 smokes + IPC 契约 + portable/private/section28 诚实 skip；私有 mods/Oodle 不跑）
- [x] P7 installer/signing/updater（`electron-builder.yml` + `test:portable-packaging-gate` 配置门禁；未装 electron-builder 时跳过真打包；代码签名/updater 未配置，不得当作可分发发行包）
- [x] P7 performance（宽松 CI 基线 smoke；完整产品性能门槛与 10GB 压力未完）
- [x] P7 private native gate（`test:private-native-gate`：有 env 跑 native 步骤；无 env 诚实 skip `unverified-no-local-sekiro-runtime`）
- [x] P7 real Sekiro launch/rollback（`test:section28-sekiro-gate`：无 env 诚实 skip `unverified-no-local-sekiro-runtime`；有 env 仅前置 smoke+exe 探测，完整启动自动化未实现，不得全绿）
- [ ] 最终 V0.5 release criteria 全绿

---

## 43. 实施进度记录

本节是唯一阶段状态来源。每次接手必须先核对当前工作树和测试结果；这里记录的命令结果只代表记录时的工作树，不自动证明后续状态。

### 2026-07-10：文档口径收口

- 状态：`pass`
- 已实现：重写仓库根 `AGENTS.md` 与 `README.md`，将本文设为唯一可执行 V0.5 交接计划；删除会以 v0.1、旧 V0.5 分叉和 v0.6 内部里程碑误导实现裁定的旧规划、状态、任务和日志文档。
- 已保留：产品愿景、解析研究、synthetic fixture 说明和 CodexPro 操作文档；它们只提供背景或测试说明，不得覆盖本文。
- 已验证：剩余 Markdown 的失效文件引用与旧发布口径静态搜索。
- 未验证：本记录不声明任何原生语义格式、真实游戏、3D、模型服务或 V0.5 发布门禁已经完成。
- 非声明：删除旧文档不是删除其 Git 历史；需要追溯时使用版本历史，不恢复为当前裁定来源。

### 2026-07-10：P0 安全底座收口

- 状态：`pass`
- 已实现：Electron sandbox/CSP/导航/新窗口/权限拒绝；统一 IPC sender 校验；main 持有的一次性目录选择凭据；renderer-safe DTO；删除 renderer 确认凭据与权限模式铸造；main 原生高风险确认。
- 已实现：`WorkspaceSession` canonical root 与 junction/symlink/reparse 越界阻断；恢复/备份默认进入应用数据目录；after-commit validator 失败自动恢复；operation 回滚改为新的 inverse PatchIR 事务并验证 target `afterHash` 与 backup `beforeHash`。
- 已实现：旧 `FileOperationLogStore` 遇到损坏 JSON 显式抛出 `LEGACY_OPERATION_LOG_CORRUPT`，不再当空历史继续写入。
- 已验证：`runV05SecurityBoundarySmoke` 覆盖 junction 越界、after-commit 自动恢复、回滚 hash 冲突；`test:desktop-security` 和 `test:ui-localization` 通过；核心全量 smoke 通过。
- 未验证：file/resource entry 两级 inverse rollback；复杂 Windows ACL/网络盘/第三方 filter driver；真实安装包内的 Electron 安全设置。
- 非声明：P0 完成不代表 native parser、语义 writer、3D 或 AI 模型服务完成。

### 2026-07-10：P1 Bridge daemon transport

- 状态：`pass（transport 基础）`
- 已实现：Bridge 目标升级为 `net10.0`、`win-x64`、self-contained、single-file；增加 `global.json` 和应用本地 SDK 安装/调用脚本。
- 已实现：协议 1.0 NDJSON daemon、handshake、accepted/progress/result/failed/cancelled、health/capabilities、deadline、取消、帧上限、并发限制、允许根目录和 Bridge 侧物理路径边界。
- 已实现：TypeScript `BridgeDaemonClient` 长连接复用、请求复用、timeout/cancel/progress、崩溃时在途请求失败和下次调用重新建连；生产 `runBridge` 不再每次 `dotnet run`。
- 已验证：`npm run bridge:build`、`bridge:verify:daemon`、`bridge:verify:client`、`bridge:verify:synthetic` 通过；build 为 0 warnings / 0 errors。`test:native-preview` 在真实 `mods` 上抽样 24 项，得到 23 次 native inspection、21 个容器摘要、0 failures；CLI smoke 在成功/失败路径都显式释放 daemon pool。
- 未验证：Oodle/KRAK；native container/semantic writer；在途写进程崩溃的“不自动重放”故障注入；签名发行包内的自包含启动。
- 非声明：daemon transport 通过不产生任何 `native-verified` 格式权威。

### 2026-07-10：P1 SQLite 两库与 utility process 基础

- 状态：`pass（persistence 基础，P1 数据层未全部完成）`
- 已实现：`better-sqlite3`、两库 migration/checksum、WAL、外键、busy timeout、完整性检查、migration 事务回滚和 schema tamper 拒绝。
- 已实现：异步 `OperationLogStore`；`SqliteOperationLogStore` 持久化 operation/file/inverse/recovery 关系；提交主干等待 pending/committed 落库。pending 失败会拒绝写入；committed 失败会自动恢复文件；若最终状态也无法落库，会生成 `operation_log_reconciliation_required` 恢复元数据，避免只留下不可解释的 pending 记录。
- 已实现：旧 operation log JSON 严格 schema/workspace 校验、内容 hash 幂等 ledger、只读备份、损坏源保留；桌面生产切换到 `workspace.db`，不再双写 JSON。
- 已实现：Electron utility process 同时持有 `app.db` 与当前 `workspace.db`；main 通过 RPC 访问。增加 Node ABI 与 Electron ABI 双 binding 构建脚本；Electron binding 在 `.native` 隔离副本中重建，根 Node binding 全程不改动。
- 已验证：`test:v05-sqlite` 覆盖两库、迁移失败回滚、checksum tamper、重开、逆操作关系、JSON 幂等导入和损坏保留；full file workbench 故障注入覆盖 committed 落库失败、文件自动恢复、最终状态落库再次失败和持久对账元数据；真实 Electron 43 utility process smoke 完成 `app.db/workspace.db` 打开、旧日志导入、写入、读取和健康握手；隔离 rebuild 前后根 Node binding hash 不变，Node/Electron 两个运行时均成功加载。
- 未验证：完整 files/FTS/resource graph/diagnostics/jobs/audit/AI repositories；semantic snapshot 导入；utility process 强杀/重启故障注入；安装包内 native binding 打包。
- 非声明：两库和 operation repository 可用不代表第 7 节全部目标表与清理/恢复策略完成。
- 辅助工具：本批次未调用 Grok，也未调用 Claude Code。

### 当前执行位置

- `P0`：已完成并通过当前工作树回归。
- `P1`：Bridge transport 与 SQLite persistence 基础已完成；阶段整体仍在进行中。
- 下一项：Oodle discovery/KRAK、Bridge 崩溃故障注入、SQLite 全量 repositories/semantic snapshot 迁移、file/resource entry 逆向回滚。

### 2026-07-11：P1 Oodle、崩溃恢复、持久事务与细粒度回滚推进

- 状态：`pass（已列出的子能力）；P1 整体仍在进行中`
- 已实现：从已选择的 Sekiro 原版目录发现精确版本 `oo2core_6_win64.dll`，校验目录、`sekiro.exe`、PE x64、主版本、必需导出和动态加载；公共 DTO 不暴露运行库绝对路径，也不复制或分发 DLL。KRAK 预览在运行库满足约束时调用 `OodleLZ_Decompress`，缺失、版本不符、架构错误、加载或导出失败均结构化阻断。
- 已实现：Bridge 活动请求崩溃失败关闭；旧客户端不可复用；只有调用方再次显式发起请求才创建新进程并重新握手，不保留或自动重放中断请求。
- 已实现：workspace schema migration 4 增加通用资源图节点、边和快照权威表；旧 semantic snapshot 执行严格 schema、工作区、重复 ID/URI、边端点和计数校验，先生成只读备份，再在单个数据库事务中替换图和写入幂等 ledger；损坏输入保留现有数据库内容。
- 已实现：事务日志 repository 提供阶段 compare-and-swap、未完成事务枚举、恢复点、审计事件和资源条目逆操作持久化。桌面数据库 utility 协议升级为 1.1，同一后台进程与同一 `workspace.db` 连接提供这些接口；打开工作区时同时处理旧 operation log 与 semantic snapshot。
- 已实现：生产 PatchIR 提交主干在写文件前建立事务记录，并推进 `pending → staging → validating → replacing → marking_committed → committed`；恢复点、审计或最终阶段持久化失败进入既有自动回滚/恢复路径。文件级回滚复用 operation 级逆向 PatchIR 主干，使用绑定原操作与目标 URI 的确认凭据，预检 `afterHash`/备份 `beforeHash`，只恢复选中文件且不修改原记录。
- 已实现：`resource_entry_changes.inverse_json` 通过 typed repository 写入与严格读回，为后续条目级逆向事务提供权威数据；尚未将它接成完整的 resource-entry rollback API。
- 已验证：`npm test`、`npm run typecheck`、`npm run build`、`npm run bridge:build`（0 warning / 0 error）、`bridge:verify:oodle`、`bridge:verify:crash`、`bridge:verify:daemon`、`bridge:verify:synthetic`、`test:native-preview` 全部退出码 0。Electron 43 utility smoke 真实完成事务阶段、恢复点、审计与生产 PatchIR 提交往返。双文件测试证明 file rollback 只恢复指定文件。
- 已验证：本机 `mods` 抽样 24 项，23 次 Bridge inspection、21 个容器摘要、0 failure；这仍然只是现有只读断言。
- 未验证：本机未发现 Sekiro 安装及合法 Oodle 运行库，因此真实 KRAK 解压成功路径仍为 `unverified-no-local-sekiro-runtime`；不得把失败关闭测试写成 KRAK 已完成。
- 已验证：utility client 强制终止后台进程后拒绝所有未完成 RPC、不自动重放，并使用 main 持有的工作区配置启动新进程、重新打开双库；重启后事务审计仍可读取。
- 未验证：Bridge 当前没有 production native 写命令，因此已验证的是所有请求均不自动重放，不是 native writer 崩溃后的游戏文件恢复；utility process 在数据库写事务正中间被操作系统强杀的故障注入、安装包内 Electron native binding 打包仍未完成。
- 未验证：完整 files/FTS/diagnostics/jobs/AI repositories、恢复点 30 天/10GB 清理策略、完整 resource-entry rollback 执行 API、真实游戏资源和启动门禁。
- 非声明：Oodle/KRAK 仍不具备 `native-verified`；DFLT/BND4/四类语义 writer、3D、双模型服务和发行阶段均未因本批次自动完成。
- 辅助工具：本批次未调用 Grok，也未调用 Claude Code。

### 当前执行位置（2026-07-11）

- `P0`：完成，当前全量回归通过。
- `P1`：Oodle 失败关闭、Bridge 崩溃失败关闭、semantic snapshot 迁移、持久事务主干和 file rollback 已推进；真实 Oodle 成功路径、utility 强杀恢复、完整 repositories 与 resource-entry rollback 仍是剩余阻塞项。
- 后续优先顺序：先完成 P1 剩余故障注入与 resource-entry rollback，再满足门禁后进入 P2；不得用 synthetic 容器实现提前声明 P2 native authority。

### 2026-07-11：P1 细粒度回滚与原子完成事务收口

- 状态：`pass（基础设施与 fixture-confirmed 闭环）`
- 已实现：operation history 增加 `rollbackTargetUri`，SQLite migration 5 建立细粒度回滚目标索引。同一原操作、同一回滚层级下，不同文件或资源条目可分别产生逆向事务；重复回滚按持久化目标 URI 阻断，不依赖标题或外层容器路径猜测。
- 已实现：`replaceContainerChild` 在任何写入前读取并校验条目原始字节；提交完成时用外层容器最终 `afterHash`、条目最终 hash 和原字节构造可验证逆操作并写入 `resource_entry_changes`。无法捕获一致原字节时返回 `CONTAINER_CHILD_INVERSE_CAPTURE_FAILED` 并拒绝写入。
- 已实现：`rollbackResourceEntry` 要求绑定原操作 ID 与条目 URI 的 main 签发确认凭据；严格匹配唯一逆操作、条目 `afterHash`、容器 `afterHash` 和 writer validator，然后通过新的 PatchIR → 暂存 → 验证 → 备份 → 原子替换 → 重读 → 日志事务执行，不修改原操作记录。
- 已实现：提交最终持久化改为 `finalizeCommit` 单个 SQLite immediate transaction；operation、resource entry inverses、recovery point、audit event 和 journal `committed` 阶段必须全成或全退。故障注入使用重复 entry change 主键令事务中途失败，验证五类记录均未部分落库且 journal 留在 `marking_committed` 供恢复裁定。
- 已实现：独立子进程在 `BEGIN IMMEDIATE` 后写入 transaction journal、未提交即以退出码 86 终止。父进程重新打开数据库后确认未提交行数量为 0、`quick_check=ok`，并可继续持久化新事务。
- 已验证：`npm test`、`npm run test:sqlite-crash-recovery`、`npm run bridge:verify:crash`、`npm run build` 全部退出码 0；workspace schema version 为 5。synthetic DCX DFLT + BND 嵌套容器完成条目修改、逆操作记录、条目级回滚和外层字节恢复。
- 未验证：上述容器闭环仍是 `fixture-confirmed`，不构成 Sekiro BND4 native authority；真实 BND4/FM​​G/PARAM/EMEVD/MSB 条目必须等对应 P2/P3 writer 达到 `native-verified` 后复用此主干重跑。
- 未验证：进程死亡测试覆盖 SQLite/WAL 写事务，不等同于 Electron utility 在每一个 RPC 字节边界的穷举强杀；安装包内 binding 与真实断电/磁盘错误仍属于 P7 门禁。
- 非声明：P1 细粒度事务底座完成不代表 P2/P3 原生格式完成。
- 辅助工具：未调用 Grok，未调用 Claude Code。

### 当前执行位置（细粒度事务收口后）

- `P1` 剩余主要外部阻塞：合法 Sekiro Oodle 运行库的真实 KRAK 成功路径；完整 files/FTS/diagnostics/jobs repository 和恢复点配额清理仍需继续。
- 可以开始并行准备 P2 的只读原生格式证据与 corpus registry，但任何写能力仍必须遵守 P1 门禁并保持 `candidate/fixture-confirmed/native-verified` 区分。

### 2026-07-11：P1 文件索引、诊断、任务与恢复保留策略

- 状态：`pass（核心 repository 与裁定层）`
- 已实现：workspace schema migration 6 为 `files` 补齐 compound extension、format kind、format label，并新增 `background_jobs`。`WorkspaceDataRepository` 提供整批文件索引原子替换、FTS5 安全查询、诊断替换/读取、后台任务 upsert/读取；损坏 JSON 显式失败，不静默返回空数据。
- 已实现：FTS 查询将用户输入拆为逐项引用 token，限制返回数量为 1–1000；验证了包含引号、`OR` 和 `*` 的输入不会成为 FTS 查询语法注入。
- 已实现：utility protocol 暴露文件、FTS、诊断和任务 repository。桌面真实 `workspace.scan` 会创建 running job，扫描成功后持久化文件、文件/扫描诊断并标记 completed；异常时保存结构化 failed job 后继续抛出，不吞异常。utility 强制重启后文件搜索和任务记录仍存在。
- 已实现：恢复点清理裁定默认 30 天、每工作区 10GB；先选择显式过期/超龄恢复点，再按最旧优先满足配额。关联非终态 transaction journal 或 `recovery_required` 操作的恢复点进入 protected 集合，永不生成自动删除候选；配额无法在不删保护数据的情况下满足时显式返回 `quotaSatisfied=false`。
- 安全边界：repository 只输出清理计划并在外部确认删除成功后标记 expired，不直接递归删除磁盘目录。带应用数据根 canonical/reparse 校验的 main 删除执行器尚未实现，因此不能声称 30 天/10GB 已自动清盘。
- 已验证：`npm test`、`npm run test:sqlite-crash-recovery`、`npm run bridge:verify:oodle`、`npm run build` 全部退出码 0；schema version 6；Electron 43 utility smoke 覆盖 files/FTS/diagnostics/jobs、持久事务、保护恢复点和强制重启。
- 未验证：恢复目录实际删除执行器、真实 10GB 压力、网络盘/ACL/杀毒 filter driver、安装包升级 migration。app.db 的模型服务/授权/AI retention repository 属于 P6，不因本次 workspace.db 完成而提前声明。
- 非声明：文件索引持久化不代表 EMEVD/MSB/PARAM/FMG native semantic index 完成；当前真实 `mods` 分析的 authority 仍按 parser 证据分别裁定。
- 辅助工具：未调用 Grok，未调用 Claude Code。

### 当前执行位置（P1 repository 收口后）

- P1 已完成：Bridge transport、崩溃失败关闭、SQLite 核心 authority、legacy migrations、事务/审计/任务恢复发现、file/resource-entry inverse rollback、Oodle 发现与失败关闭。
- P1 外部未验证：合法 Sekiro Oodle 运行库上的真实 KRAK 成功解压。
- P1 内部剩余：恢复目录 main 安全删除执行器、安装包 binding 验证；二者可继续加固，但不应阻止开始 P2 只读原生容器实现。
- 下一主线：进入 P2，先做 C# DFLT 无损文档信封和真实 corpus 变体验证，再做 BND4 只读权威；没有 roundtrip 证据前不得启用 writer。

### 2026-07-11：P1 安全清理执行器与 P2 真实 DFLT/BND4 文档推进

- 状态：`pass（DFLT）；partial（BND4 production writer 尚未接入）`
- P1 已实现：main 恢复清理执行器只接受 utility 预先生成的候选，并对 backups/recovery 两个应用数据根执行 lexical + realpath + reparse 边界检查；禁止删除根目录本身。目录实际删除成功或确认已不存在后才把数据库记录标为 expired，删除/检查失败保持 active 并返回结构化结果。工作区打开后自动执行默认 30 天/10GB 策略。
- P1 已验证：真实目录删除成功；指向允许根之外的 Windows junction 被拒绝且外部目录保持不变；未完成事务恢复点继续受保护。Electron utility smoke、桌面构建和全量测试通过。
- P2 已实现：新增 C# `DcxNativeDocument`，完整读取 DCX 源字节、确认 DCS/DCP/DCA 边界、精确解压 DFLT、记录源/payload hash、格式变体、未知头与尾部保留策略；DFLT 重压后重新解析并要求 payload hash 与变体一致。KRAK 使用同一文档信封读取，但无合法 Oodle 时失败关闭且不尝试重压缩。
- P2 已实现：新增 C# `Bnd4NativeDocument`，解析真实 BND4 header、0x24 文件头、UTF-16/UTF-8 名称、ID、flags、unknown、数据偏移、压缩/解压大小、重复名称 ordinal 和内容 hash。重打包保留全局头和每项 flags/unknown/id，重建名称表、对齐数据区与偏移。
- P2 已实现：BND4 内存 CRUD/repack 覆盖变长 replace、add、delete、rename、move；每项操作之后重新解析并检查名称、顺序、数量、重复名和内容 hash。修改后的 BND4 payload 再包回 DFLT DCX、重新解压并重读验证。
- 真实 corpus：扫描本机 214 个 DCX；144 个 DFLT 全部完整解压/重压/重读通过，变体为 `DFLT_10000_44_9_0` 10 个、`DFLT_11000_44_9_0` 134 个；70 个 KRAK 因本机无合法运行库明确 blocked。DFLT 中 75 个真实 BND4 全部解析与 CRUD/repack 验证通过，共覆盖 11,344 个子项，0 failure。
- authority 裁定：DFLT 在当前私有基线出现的两个变体达到 `native-verified` 读写证据；BND4 目前仅覆盖可由 DFLT 打开的 75 个真实容器，KRAK 内可能存在的 BND4 尚不可见，因此整体仍保持 `candidate/partial`，不得勾选完整 BND4 native。
- 未完成：C# BND4 writer 尚未通过 Bridge writable staging roots 接入 PatchIR；生产 `ContainerChildReplaceWriter` 仍是 synthetic fixture 路径。add/delete/rename/move 也尚未进入 WorkspaceTransaction。因此本记录不勾选 P2 child CRUD/repack 和 container roundtrip 产品门禁。
- 已验证：`npm test`、`npm run bridge:verify:daemon`、`npm run bridge:verify:dcx-documents`、`npm run build` 全部退出码 0；Bridge build 0 warning / 0 error。
- 辅助工具：未调用 Grok，未调用 Claude Code。

### 当前执行位置（P2 native staging writer 前）

- P1 内部实现已基本收口；唯一外部未验证仍是合法 Oodle 上的真实 KRAK 成功路径。
- P2 DFLT 变体门禁已通过；BND4 parser/repacker 已有真实 corpus 证据，但产品写入闭环未完成。
- 下一步必须增加 Bridge `writableRoots`、只允许暂存区输出的 C# writer 命令，并把 PatchIR 容器操作切到该 production authority；随后做 writer 崩溃、不重放、提交、重读和三层回滚故障注入。

### 2026-07-11：P2 BND4 production staging writer 与五类事务闭环

- 状态：`pass（DFLT+BND4 production path）；blocked（KRAK corpus）`
- 已实现：Bridge handshake 增加 main-owned `writableRoots`，写根必须是 `allowedRoots` 的物理子路径；所有 writer output 再做 canonical/reparse 边界验证。只在 `write-bnd4` 命令接受 `options.outputPath`，其他请求不能借此写文件。输出先写同目录临时文件，取消检查通过后原子移动到暂存目标。
- 安全验证：将 Mod 源目录放入 allowed roots 但不放入 writable roots，要求 writer 输出到 Mod 时返回 `BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS`；源文件 hash 保持不变。Bridge 在 accepted/progress 后被强杀时活动请求返回 `BRIDGE_PROCESS_EXITED`，没有发布暂存输出、没有自动重放；调用方显式建立新会话重试后成功。
- 已实现：C# `Bnd4NativeWriter` 支持 add、replace、delete、rename、move；每次要求外层 DCX expectedContainerHash，目标型操作要求 expectedChildHash，可使用稳定 entry index 或唯一 child path。KRAK 外层明确拒绝写入，避免未经验证的 Oodle 压缩。
- 已实现：TypeScript `ContainerChildReplaceWriter` 对 `containerFormat=BND4_DFLT + nativeFormatAuthority=true` 的 PatchIR 路由到 C# Bridge；synthetic fixture 继续走原有测试辅助路径。`FileRiskValidator` 要求所有原生 BND4 操作为 high risk，并携带 main 签发的 confirmation receipt id。
- 已实现：`ContainerRoundTripValidator` 的原生路径改由 Bridge 重读 staged/committed DCX+BND4，分别验证新增项 ID/名称、替换内容 hash、删除数量/目标、重命名名称和移动后索引；不再使用 TS synthetic BND parser 裁定原生 writer 输出。
- 真实事务验证：复制真实 `c0000.anibnd.dcx` 到临时 Mod 工作区，五种操作分别执行 PatchIR → C# Bridge staging → validator → WorkspaceTransaction → commit → Bridge reread；每次再执行新的 operation 级 inverse PatchIR，最终源文件逐字节恢复。五类操作全部通过。
- 全量回归：`bridge:verify:bnd4-writer`、`npm test`、`bridge:verify:bnd4-transaction`、`bridge:verify:dcx-documents`、`npm run build` 全部退出码 0；214 DCX、144 DFLT、75 BND4、11,344 entries 仍为 0 failure。
- 完成裁定：P1 Bridge 写操作崩溃恢复故障注入已完成。P2 的 DFLT+BND4 production writer 主干已经可用，但 70 个 KRAK 无法解压，故完整 BND4 native、child CRUD/repack 和 container roundtrip 检查项暂不整体勾选。
- 未完成：真实 Oodle 成功路径；KRAK 内 BND4 corpus 覆盖；资源条目级 inverse 对 add/delete/rename/move 的精确逆操作记录（当前五类已具 operation/file rollback）。这些完成前不能宣称整个 P2 结束。
- 辅助工具：未调用 Grok，未调用 Claude Code。

### 当前执行位置（P2 KRAK 与细粒度 inverse 前）

- P1 除真实 Oodle/KRAK 外均已有实现和故障证据。
- P2 DFLT 完成；DFLT 外层 BND4 的读取、五类 CRUD/repack、暂存写、提交、重读和 operation rollback 完成。
- 下一步：为五类 BND4 mutation 生成并持久化精确 resource-entry inverse PatchIR；随后在取得合法 Oodle 后复跑 70 个 KRAK，完成整个 BND4 corpus 和 KRAK writer 门禁。

### 2026-07-11：P2 resource-entry inverse 与 P3 FMG/PARAM 推进

- 状态：`pass（已列出子能力）；P2 整体仍 blocked on KRAK；P3 FMG pass；P3 PARAM partial`
- 已实现：Bridge `snapshot-bnd4-child` 捕获 BND4 子项元数据与 contentBase64。TypeScript `captureNativeBnd4ResourceEntryChanges` 在提交前为 native BND4 五类 mutation 生成精确 resource-entry inverse（add→delete、delete→add 全量 payload、replace/rename/move 对称逆操作），经 `finalizeCommit` 持久化；`rollbackResourceEntry` 按 changeKind 校验 inverse 证据。
- 已验证：`bridge:verify:bnd4-transaction` 覆盖 operation 级与 resource-entry 级回滚（replace/delete/rename/move/add）；真实 `c0000.anibnd.dcx` 事务闭环。
- 已实现：Bridge daemon 标准输入/输出强制 UTF-8，避免 FMG 中文经 NDJSON 损坏。
- 已实现：C# `FmgNativeDocument` / `FmgNativeWriter`（Sekiro FMG v2 `0x00020000`），支持重复 ID 槽位、语义往返、upsert/delete/add；经 `read-fmg-document` / `write-fmg` 接入；真实 `item.msgbnd.dcx` 18/18 FMG 子项语义往返 + 写入 + BND4 提交 + operation 回滚。
- 已实现：C# `ParamNativeDocument` / `ParamNativeWriter`（紧凑 0x40 头 + 0x18 行头布局），行级 raw payload CRUD（无 paramdef 时不做字段解码）；`read-param-document` / `write-param`；gameparam 抽样 40 项中 38 项语义往返通过。
- 已加固：Bridge NDJSON `maxFrameBytes` 上限提升以承载大 PARAM 子项 base64 快照；PARAM envelope 默认限制行预览、宽行不附 dataBase64。
- 已验证：`npm run typecheck`、`npm test`、`bridge:verify:fmg`、`bridge:verify:param`、`bridge:verify:bnd4-transaction` 退出码 0。
- 未验证 / blocked：合法 Sekiro Oodle 上真实 KRAK 成功路径（`unverified-no-local-sekiro-runtime`）；KRAK 内 BND4 corpus；旧版 header-embedded type name 的 PARAM 变体（样例 default_AIStandardInfoBank 等 2/40 结构化 unsupported）；paramdef 字段级编辑；EMEVD/MSB native 语义 writer；专业桌面与双模型服务完整闭环；真实游戏 section-28 smoke。
- 非声明：不得将 FMG/PARAM 部分 corpus 通过写成“全部 native-verified 已完成 V0.5”；KRAK 与旧 PARAM 变体仍阻塞完整 P2/P3 勾选。
- 辅助工具：本批次以主 Agent 实现并验证；未调用 Claude Code。

### 当前执行位置（P3 FMG/PARAM 后）

- P2：DFLT + DFLT-BND4 生产写路径与五类 resource-entry inverse 完成；KRAK 仍 blocked。
- P3：FMG 在 item.msgbnd 基线上完成语义闭环证据；PARAM 紧凑布局完成读写/提交/回滚证据，旧布局与 paramdef 未完成。
- 下一步：EMEVD/MSB 结构无损文档 → 资产/3D → 专业桌面 → 双模型服务 → 发行门禁；KRAK 待合法运行库。

### 2026-07-11：P6 双模型服务 fake-server 闭环

- 状态：`pass（core adapters + agent loop）；桌面 safeStorage/UI 接线未完`
- 已实现：`packages/core/src/model-services` — OpenAI-compatible Chat Completions adapter、Anthropic Messages adapter、`runAgentToolLoop`、计划/普通/完全权限工具门禁、密钥 redact、`assertNoSecretLeak`。
- 已验证：`npm run test:ai-fake-loop` — 本地 fake HTTP 服务上双 provider 多步 tool loop、流式 tool call、plan 模式拒绝写工具、完全权限仍返回 `PATCH_ENGINE_REQUIRED`、审计载荷无明文 key。
- 未验证：Electron safeStorage/DPAPI 凭据库、真实云端模型手工 smoke、Context Broker 完整证据包、桌面 AI 侧栏生产接线。
- 非声明：不得将 fake-server 通过写成真实 OpenAI/Anthropic 生产验收完成。

### 2026-07-11：P3 EMEVD 结构文档

- 状态：`pass（结构层）；指令级 EMEDF 未完成`
- 已实现：C# `EmevdNativeDocument` / `EmevdNativeWriter` — Sekiro EVD\0 `00 FF 01 FF` 事件表解析（id/layer/restBehavior + 保留字段）、等数量事件表重写、`set_rest_behavior` / `update_id` mutation；`read-emevd-document` / `write-emevd`。
- 已验证：`bridge:verify:emevd` 对 `common.emevd.dcx`（DFLT）解压后 205 事件无修改字节往返；变异 restBehavior 仅影响目标事件。
- 未验证：指令/参数银行 typed CRUD、事件增删（指令 GC）、KRAK 包装 EMEVD、MSB、真实游戏加载。
- 非声明：结构通过 ≠ 完整 EMEVD 语义编辑器完成。

### 2026-07-11：P3 MSB 结构信封 + 发行静态门禁

- 状态：`candidate（MSB）；pass（静态发行扫描脚本）`
- 已实现：C# `MsbNativeDocument` + `read-msb-document` — 识别 `MSB ` 魔数/版本、头偏移条目、无修改源字节往返；`entityEdit` / `sceneProjection` 明确 unsupported。
- 已验证：`bridge:verify:msb` 对 `m10_00_00_00.msb.dcx` DFLT 解压样本返回 `authority=candidate`。
- 已实现：`npm run test:release-content` 静态扫描禁止 Oodle DLL / 密钥类文件进入源树声明；`mods/` 仅记为开发资料。
- 未验证：MSB 实体 CRUD、Three.js 场景、资产转换、安装包/签名/更新器、真实 Sekiro 启动门禁。
- 非声明：MSB candidate ≠ 完整 3D 场景完成；静态扫描 ≠ 已签名安装包审计。

### 2026-07-11：MSB part transform、资产导入、编辑器仓库、safeStorage vault

- 状态：`pass（已列出子能力）；P4/P5/P7 整阶段仍未完成`
- 已实现：C# MSB `models`（头计数 0x10）+ `PARTS_PARAM_ST` 段 `0x348` 步长 part 解析；`set_part_position` / `set_part_transform` 就地写 float；`write-msb` Bridge 命令。
- 已验证：`bridge:verify:msb` — m10 样本 models=34、parts=5406，part 位置写入后重读匹配。
- 已实现：`packages/core/src/assets/assetImport.ts` — glTF/GLB/PNG/TGA/DDS 检测、magic 校验、仅写暂存区 + manifest；拒绝 FBX。
- 已验证：`npm run test:asset-import`。
- 已实现：`editor-protocol` + `EditorDocumentStore` — 分编辑器 mutation 白名单、revision 冲突、批量 `requiresPatchEngine: true`。
- 已验证：`npm run test:editor-document-store`。
- 已实现：`apps/desktop/src/main/modelServiceCredentials.ts` — Electron `safeStorage` 加密 vault，DTO 仅 `hasCredential`，`resolveApiKey` 仅 main。
- 已验证：`npm run test:model-service-vault-contract` 源码契约。
- 未验证：Three.js 场景渲染、原生 flver/dds 写回、各专业编辑器 UI、vault IPC 与真机 DPAPI、安装包/真游戏门禁、KRAK、paramdef、EMEVD 指令级。
- 非声明：part 位置可写 ≠ 完整 MSB 3D 工作台；资产暂存 ≠ 原生转换完成；vault 类存在 ≠ 桌面 AI 设置 UI 完成。

### 2026-07-11：Hex 文档模型与 MSB 场景清单

- 状态：`pass（核心模型）；UI/Three 渲染未完`
- 已实现：`HexDocument` 分页读取、等长字节补丁、stale 拒绝；`buildMsbSceneManifest` / `chunkSceneNodes` 从 part transform 生成 renderer-safe 场景节点，拒绝绝对路径标签。
- 已验证：`npm run test:hex-scene`。
- 未验证：React Hex 虚拟化组件、Three.js WebGL 场景、gizmo 编辑回写。

### 2026-07-11：Three 代理场景、资产 PatchIR 写回、vault IPC 与桌面面板

- 状态：`pass（已列出）；真实 mesh/原生编码器/真机 DPAPI 仍未验证`
- 已实现：`sceneDrawList`；renderer `mountThreeProxyScene`（动态 import three，路径泄漏守卫）；`commitAssetImportThroughPatchIr`（stage→file_replace）；main `modelService.*` IPC + preload + 设置面板；Hex/MSB 场景/模型服务面板接入 App。
- 已验证：`test:scene-draw-list`、`test:asset-writeback`、`test:vault-ipc-contract`、`test:three-scene-module`、`typecheck`、`build`（含 three chunk）、`test:desktop-security`。
- 未验证：Electron 窗口内 WebGL 人机 smoke、原生 FLVER 编码、DPAPI 真机加密往返、KRAK、安装签名、真实游戏 section-28。
- 非声明：代理 box/sphere ≠ 完整原生 mesh 场景；file_replace 写回 PNG 字节到 .dds 路径是导入管道证明，不是格式转换完成。

### 2026-07-11：EMEVD 四视图、FMG/PARAM 面板、RGBA→DDS、vault 加密契约

- 状态：`pass（已列出子能力）；P5/P6 整阶段仍有未完项`
- 已实现：`emevdFourViewController` — 同一 revision、四视图 selection 同步、结构化 mutation；DSL 只读渲染且永不解析为 mutation。
- 已实现：renderer `EmevdFourViewPanel`、`FmgWorkbenchPanel`、`ParamTablePanel` 接入 App 对应工作区模式。
- 已实现：`pngToDds.encodeRawRgba8ToDds` + `convertAndWriteback` — 真实 A8R8G8B8 DDS 编码并经 PatchIR 写回。
- 已实现：`runVaultEncryptContractSmoke` — safeStorage encrypt/decrypt 契约与 IPC 禁止 resolve 密钥。
- 已验证：`npm run test:emevd-four-view`、`test:dds-convert-writeback`、`test:vault-encrypt-contract`、`typecheck`。
- 未验证：EMEDF 指令 typed args、paramdef 字段表、PNG 解码器依赖、真机 Electron DPAPI 往返、四视图→Bridge commit IPC。
- 非声明：四视图 demo 文档 ≠ native EMEVD writer 完成；DDS 无压缩编码器 ≠ Sekiro 运行时贴图全格式；vault 契约 ≠ 真机 DPAPI 人机 smoke。

### 2026-07-11：OpenAI Responses、工作台运维投影、资源图诊断、Windows CI

- 状态：`pass（已列出）；P7 发行/真游戏门禁仍未完成；V0.5 整体未完成`
- 已实现：`OpenAiResponsesAdapter` — `POST /v1/responses` 非流式与 SSE（`response.output_text.delta` / function_call / completed）归一化到既有 `StreamEvent`；接入 agent tool loop。
- 已实现：`workbenchProjections`（jobs/history/patch-impact/diagnostics）与 renderer `WorkbenchOpsPanel`（任务与历史模式）。
- 已实现：`buildResourceIndexHealthReport` — 空图/候选引用/孤立节点/索引空集结构化诊断。
- 已实现：`.github/workflows/windows-ci.yml` — typecheck、npm test、bridge synthetic/daemon、Responses/工作台/EMEVD/DDS/vault、release-content、build；明确排除私有 mods/Oodle/真机门禁。
- 已验证：`npm run test:openai-responses`、`test:workbench-projections`、`test:resource-index-diagnostics`、`typecheck`、`test:ui-localization`、`test:desktop-security`。
- 已验证（本批次后续）：`npm test` 退出码 0（core 全量 smoke + desktop-security + ui-localization + database-utility，含 Electron utility SQLite 与 desktop build）；`npm run bridge:verify:synthetic`；`npm run build`（shared/core/desktop，含 three chunk）。
- 未验证：真实 OpenAI/Anthropic 手工 smoke；Playwright Electron E2E；electron-builder 安装包与签名；性能基准；KRAK；真实 Sekiro section-28。
- 非声明：Windows CI 工作流存在 ≠ 远程 runner 已绿（需推送后确认）；Responses adapter ≠ 已对接生产 OpenAI 账号；任务面板 demo job ≠ 完整 TaskQueue IPC；i18n 静态扫描通过 ≠ i18next 双语资源完成。
- 辅助工具：本批次主路径由 Grok 实现并本地验证，未调用 Claude Code。

### 2026-07-11：用户派生 paramdef 布局与 electron-builder 脚手架

- 状态：`pass（已列出）；P3 原生 paramdef 二进制与 P7 签名发行仍未完成；V0.5 整体未完成`
- 已实现：`@soulforge/shared` `ParamDefDocument` / 字段标量类型；`paramdefLayout` 重叠校验、行字段 decode/encode（不修改原 Buffer）；renderer `ParamDefPanel`。
- 已实现：`apps/desktop/electron-builder.yml` — win portable + nsis 脚手架，明确排除 mods/Oodle/密钥路径；无签名、无 publish。
- 已验证：`npm run test:paramdef-layout`、`typecheck`、`test:ui-localization`。
- 未验证：原生 .paramdef 解析；用户包签名；`electron-builder` 实际打包产物与干净机安装；自动更新；性能基准；KRAK/Sekiro 门禁。
- 非声明：用户派生布局 schema ≠ 官方 paramdef 格式完成；builder yml 存在 ≠ 可对外分发安装包。

### 2026-07-11：场景资产清单与性能基线

- 状态：`pass（已列出）；P4 native scene / P7 完整性能与真游戏门禁仍未完成；V0.5 整体未完成`
- 已实现：`buildSceneAssetInventory` — 从 SceneManifest 聚合 model/material candidate，拒绝绝对路径泄漏。
- 已实现：`runPerformanceBaselineSmoke` — EMEVD 四视图 mutation、DDS 编码、2k 场景清单、TaskQueue 宽松阈值。
- 已验证：`npm run test:scene-asset-inventory`、`test:performance-baseline`、`typecheck`。
- 未验证：FLVER/贴图原生权威；大地图 50k+ 交互帧率；安装包体积；真实 Sekiro 加载。
- 非声明：candidate 资产清单 ≠ native scene formats 完成；CI 基线 ≠ 产品性能门槛全绿。

### 2026-07-11：EMEVD 头修正 + 指令银行 + EMEDF + FLVER candidate

- 状态：`pass（已列出）；事件增删/变长 args/完整 FLVER mesh 未完；V0.5 整体未完成`
- 根因修复：旧 EMEVD 解析把 version `0xCD` 误作 eventCount（仅 205 事件）；现按 SoulsFormats Sekiro 头解析 **1730 事件 / 33266 指令**。
- 已实现：C# 指令表 0x20 项 + 参数银行；`set_instruction_args` 等长就地写；envelope `instructionsSample`。
- 已实现：TS `emedfSchema` fixture 解码/编码/等长 mutation；四视图 `emevd_set_instruction_args`。
- 已实现：`probeFlverCandidate` 只读头探测（synthetic fixture）。
- 已验证：`bridge:build`；`bridge:verify:emevd`（eventCount=1730, instructionCount=33266, rest+args）；`test:emedf-schema`；`test:emevd-four-view`；`test:flver-candidate`；`npm test`；`typecheck`。
- 未验证：事件增删与指令 GC；变长 args 重排；完整 Sekiro EMEDF 全量；真实 FLVER mesh 解码/写回；KRAK；真游戏 section-28。
- 非声明：指令 args 等长写 ≠ 完整 EMEVD 语义编辑完成；FLVER candidate ≠ native mesh 完成。

### 2026-07-11：EMEVD 事件 GC + Bridge commit 映射 + private native gate

- 状态：`pass（已列出）；V0.5 整体未完成`
- 已实现：C# `RebuildWithEventBuilds` 全量重建（events/instructions/args/parameters + 保留 linked/strings）；`add_event` / `delete_event` / `duplicate_event`。
- 已实现：`commitEmevdMutationViaBridge` 将编辑器 mutation 映射到 `write-emevd` 暂存写入（仍须经 PatchIR 提交）。
- 已实现：`scripts/verify-private-native-gate.mjs` + `npm run test:private-native-gate`。
- 已验证：`bridge:verify:emevd`（add 9000001 → delete → 1730 事件/33266 指令恢复）；`test:private-native-gate` status=skipped（`unverified-no-local-sekiro-runtime`）；`typecheck`；`npm test`。
- 未验证：layerCount≠0 文件；变长 instruction args；桌面完整 EMEVD IPC；签名安装；真实 Sekiro 启动 section-28；KRAK。
- 非声明：private gate skip ≠ private gate 通过；事件 GC 在 common.emevd 通过 ≠ 全 corpus native-verified。

### 2026-07-11：MSB regions/events + EMEVD 变长 args + 桌面 EMEVD IPC

- 状态：`pass（已列出）；V0.5 整体未完成`
- 已实现：MSB `POINT_PARAM_ST` 区域扫描解析（m10：1504）+ `EVENT_PARAM_ST` 定长 0xA0（64）；`set_region_position` 就地写回。
- 已实现：EMEVD `set_instruction_args` 变长时走全量 GC 重建；native smoke 覆盖 12→16 字节 args。
- 已实现：桌面 IPC `resource.readEmevdDocument` / `resource.applyEmevdMutation`（Bridge stage → `saveRawReplace` Patch Engine）。
- 已验证：`bridge:verify:msb`、`bridge:verify:emevd`（含 varArgsLength=16）、`test:emevd-ipc-contract`、`typecheck`、`test:desktop-security`。
- 未验证：MSB region/event 增删；layer≠0 EMEVD；真机 Electron EMEVD 人机；KRAK；签名安装；section-28。
- 非声明：region 位置可写 ≠ 完整 3D gizmo/CRUD；IPC 契约 ≠ 已完成全部编辑器真数据接线。

### 2026-07-11：EMEVD 四视图实时 IPC + FLVER mesh 表 candidate

- 状态：`pass（已列出）；V0.5 整体未完成`
- 已实现：renderer `mapEmevdEnvelopeToDocument` + App 在 event 模式调用 `readEmevdDocument`；mutation 经 `applyEmevdMutation` 提交并重读。
- 已实现：core `emevdEnvelopeToDocument` 与 `test:emevd-envelope-map`。
- 已实现：FLVER mesh 表候选行（0x40 stride 原始字段）+ fixture 3 行验证。
- 已验证：`test:emevd-envelope-map`、`test:flver-candidate`、`typecheck`、`test:ui-localization`、`test:desktop-security`。
- 未验证：Electron 窗口内 EMEVD 人机 smoke；真实 FLVER 顶点/面解码；MSB 实体增删；KRAK；签名安装；section-28。
- 非声明：mesh 表 candidate ≠ 可渲染原生 mesh；实时读取成功 ≠ 全部事件指令样本完整（Bridge sample 有上限）。

### 2026-07-11：FMG/MSB 实时 IPC + section-28 诚实 skip

- 状态：`pass（已列出）；V0.5 整体未完成`
- 已实现：`fmgBridgeCommit` / `msbBridgeRead`；桌面 IPC `readFmgDocument`/`applyFmgMutation`/`readMsbDocument`；App msg/map 模式实时加载与 FMG 写回。
- 已实现：`scripts/verify-section28-sekiro-gate.mjs` + `npm run test:section28-sekiro-gate`。
- 已验证：`test:fmg-msb-ipc-contract`、`test:section28-sekiro-gate`（skipped）、`typecheck`、`npm test`、`test:desktop-security`、`test:ui-localization`。
- 未验证：真机 Electron FMG/MSB 人机；完整游戏启动/Mod 加载；KRAK；签名安装；MSB 实体增删；完整 FLVER 几何。
- 非声明：section-28 skip ≠ section-28 通过；FMG IPC 契约 ≠ 已对接全部 msgbnd 子文件自动抽取。

### 2026-07-11：PARAM/MSB 写回 IPC + portable 配置门禁

- 状态：`pass（已列出）；V0.5 整体未完成`
- 已实现：`paramBridgeCommit` / `msbBridgeCommit`；IPC `readParamDocument`/`applyParamMutation`/`applyMsbMutation`；App param 模式实时读/删行写回。
- 已实现：`test:portable-packaging-gate`（yml 安全规则 + release-content；可选 `SOULFORGE_PORTABLE_PACK=1` 真打包）。
- 已验证：`typecheck`、`test:param-msb-write-ipc-contract`、`test:portable-packaging-gate`、`test:desktop-security`、`test:ui-localization`。
- 未验证：Electron 窗口内 PARAM/MSB 人机；electron-builder 真产物；签名；KRAK；真游戏 section-28 全绿。
- 非声明：portable 配置门禁 ≠ 已签名可分发安装包；PARAM upsert 需保留 dataBase64 载荷。

### 2026-07-11：MSB UI 位置微调 + PARAM 复制真路径 + 验证计划重跑

- 状态：`pass（已列出）；最终 V0.5 release criteria 仍未全绿`
- 已实现：`MsbScenePanel` 选择 part 后 ΔXYZ 微调 → `applyMsbMutation(set_part_position)`；仅 live 模式可写。
- 已实现：PARAM 复制行携带 `sourceId`，App 用源行完整 `dataBase64` 做新 id upsert。
- 已实现：`test:desktop-live-editor-contract`；section-28 skip 日志 EBUSY 容忍。
- 已验证（SCRATCH）：`typecheck`、`npm test`、`bridge:verify:synthetic`、`test:ai-fake-loop`、desktop-security/ui-localization/release-content/portable-gate、`private-native-gate` skipped、`section28` skipped、`test:desktop-live-editor-contract`、`npm run build`、以及 `bridge:verify:emevd/msb/fmg/param`。
- 未验证 / 环境阻塞：KRAK/Oodle 成功路径；签名安装包真产物；完整 FLVER 几何；MSB 实体增删 GC；真机 Electron 人机 WebGL/DPAPI；真实游戏启动/Mod 加载 section-28 全绿。
- 非声明：验证计划回归绿 ≠ V0.5 产品完成；private/section28 skip 是诚实阻塞，不是通过。

### 2026-07-11：MSB region UI 写回 + PARAM 复制原生 smoke + CI 扩展

- 状态：`pass（已列出）；最终 V0.5 仍未全绿`
- 已实现：场景面板 region 列表选择 + `set_region_position` 提交；App 统一 `commitMsbPosition`。
- 已实现：`test:param-duplicate-native`（ActionGuideParam 新 id 复制，rows 16→17，payload hash 一致）。
- 已实现：Windows CI 增加 IPC 契约、EMEDF/envelope/FLVER/vault、portable/private/section28 门禁步骤。
- 已验证：`typecheck`、`test:desktop-live-editor-contract`、`test:param-duplicate-native`、`test:ui-localization`、`test:desktop-security`、`test:portable-packaging-gate`、`test:private-native-gate`/`test:section28-sekiro-gate` skip、`npm test`。
- 未验证：KRAK；签名安装真产物；完整 FLVER 几何；MSB 实体增删；真机 DPAPI/WebGL；真实游戏启动全绿。
- 非声明：CI 工作流扩展 ≠ 远程 runner 已绿（需推送确认）；PARAM 复制 smoke ≠ paramdef 字段级完成。

### 当前执行位置（2026-07-11 终）

- `P0`–`P6` 可本地主干：已有大量可复现证据（容器/语义/桌面实时 IPC/双模型 fake loop/vault 契约）。
- `P7`：公开 CI/配置/内容扫描/诚实 skip 门禁已落；**签名发行 + 真游戏 section-28 全绿仍未达成**。
- **环境阻塞**：本机无 `SOULFORGE_SEKIRO_GAME_ROOT` / 合法 Oodle → KRAK 与真实游戏门禁不可替代合成通过。
- **V0.5 未完成**：不得标记「最终 V0.5 release criteria 全绿」。

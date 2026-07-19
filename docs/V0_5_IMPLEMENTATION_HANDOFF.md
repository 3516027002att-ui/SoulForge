# SoulForge V0.5 实施交接书

> 文档性质：实现规范与工程交接，不是愿景草案。  
> 目标读者：接手实现 SoulForge V0.5 的开发 Agent / 工程师。  
> 当前基准日期：2026-07-19。
> 初始审计基线：`57a5db5`；2026-07-13 状态审计基于 `7bd354d`，接手前仍必须以 `git status`、本文第 43 节和真实测试重新核对，不得假设实现仍位于未提交工作树。
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
- operation/file/resource-entry 级历史，以及以新逆向 PatchIR 事务实现的 operation/file/resource-entry 回滚基础；resource-entry 当前已验证 BND4 五类、EMEVD `restBehavior`/`instruction args`/空事件 `add`/既有非空事件 `delete`/`duplicate`/事件完整顺序 `reorder`/instruction 零参数 `add` 与既有 instruction `duplicate`/`delete`/`reorder`、raw FMG `text`/槽位 `delete`/`insert`/`reorder`、PARAM 用户派生字段与 MSB part 位置，并保持 `afterHash`/typed value/node/完整顺序 hash 冲突保护。
- bounded preview、大文件延迟 hash、基础 VFS。
- 内存资源关系图、证据包、补丁影响图。
- 文件级 capability matrix。
- synthetic DFLT、SFBN BND3/BND4、SFFX FMG 测试链。
- 本机私有样本中 144 个 DFLT 与 75 个 DFLT 外层 BND4 的读取/重建证据；已登记的 1 个 KRAK `dcx-document` 真实解压成功，且 2 个登记 DCX 文档确认嵌套 BND4；BND4/MSB 公共文档 authority 仍为 `candidate`，完整 KRAK corpus 与重压仍未完成。
- DFLT-BND4 五类 child mutation、Bridge 暂存 writer、提交、重读和 operation/resource-entry 回滚 smoke。
- FMG `item.msgbnd` 18/18 子项、PARAM 当前 `gameparam.parambnd` 138/138 子项、10 个 DFLT EMEVD corpus 及 MSB part/region 位置写回的分层证据；这些都不等于完整 P3。
- OpenAI-compatible / Anthropic-compatible core adapter fake-server tool loop，以及桌面 main 中基于 app.db grant、safeStorage 凭据、Context Broker、唯一生产 ToolRegistry 和历史/出站审计的 production caller；真实服务正向 smoke、流式/取消与完整 UI 仍未完成。
- `app.db` / `workspace.db` 迁移器、checksum、WAL/foreign key、严格旧 JSON 导入。
- `better-sqlite3` Electron utility process、异步操作日志 repository 和 Node/Electron 双 ABI 构建门禁。
- Electron sandbox/CSP/导航/窗口/权限/IPC sender 安全边界，renderer-safe DTO 与 main 原生确认。

### 1.2 当前明确未完成

以下能力尚未完成，不得从现有命名或测试名推断为已完成：

- 完整 KRAK+BND4 corpus authority；当前 DFLT-BND4 子集可运行，但 BND4 输出仍为 `candidate`。
- 完整 KRAK corpus 解压与 KRAK 重压；当前仅 1 个 registry/hash 绑定的真实 KRAK 解压正向样本通过。
- EMEVD、MSB、PARAM、FMG 在私有发布语料全部变体上的完整 parser/writer。
- 原生语义资源 CRUD、重排和类型转换。
- 除上述已验证 typed 子能力外的完整 resource-entry inverse 覆盖；EMEVD 的 EMEDF-aware instruction authoring/类型转换与完整发布 corpus、FMG 类型转换/嵌套 msgbnd、PARAM 原生 paramdef、MSB 全实体 CRUD 和完整发布 corpus 尚未完成。
- SQLite 中尚未接通的完整文件索引、FTS5、资源图、诊断、任务、审计、模型服务和 AI 历史 repositories。
- Bridge 写操作崩溃恢复故障注入、后台任务持久恢复，以及 Oodle/KRAK。
- OpenAI-compatible / Anthropic-compatible 真实模型调用。
- 模型服务凭据真机 DPAPI 迁移/往返与完整产品生命周期；safeStorage 密文路径和静态/契约门禁已接通。
- 专业 Hex、EMEVD、PARAM、FMG、MSB 编辑器。
- Three.js 3D 场景和资产转换。
- 游戏适配包安装、签名、信任和迁移。
- Windows 安装包、更新器、正式 CI 和发行门禁。

### 1.3 P0 安全审计结论

初始审计发现的 renderer 铸造确认凭据、renderer 决定权限模式、绝对路径 IPC、`sandbox: false`、junction/symlink 越界、恢复数据写入 Mod、after-commit 失败不恢复、回滚覆盖后续修改和损坏 JSON 静默清空问题，均已修复并有静态或运行门禁。实现证据见第 43 节。

尚未完成但不应与上述已修复问题混淆的事项：

1. 生产 AI 工具注册表、typed policy gate 与 SQLite 审计已合并为唯一 main 生产路径；仍需真实服务正向 smoke、流式/取消和完整 UI 生命周期。
2. 持久模型服务 grant 已实现，并由 main 解析且对提权/撤销执行原生确认；仍需 Electron 人机确认流、授权 scope 的产品级语义和完整生命周期验证。
3. file 级逆向事务已经完成；resource-entry 基础设施与当前 BND4、EMEVD、FMG、PARAM、MSB typed 子能力已验证，但各语义格式的完整 mutation/corpus 覆盖仍未完成。
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

2026-07-10 初始审计时实际通过：

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

2026-07-13 状态审计及后续收口重新通过 `typecheck`、`npm test`、`bridge:verify:synthetic`、`build`、DFLT/BND4/FMG/PARAM/EMEVD/MSB 定向 smoke 和 AI fake-server smoke；PARAM 后续扩展为当前 `gameparam.parambnd` 138/138，EMEVD 扩展为 10 个已登记 DFLT 文件（9696 events / 126562 instructions），MSB/BND4 公共文档仍为 `candidate`，private/section-28 在缺环境时仍不得解释为通过。

2026-07-19 当前工作树重新按顺序通过 `npm run typecheck`、扩充后的 `npm test`、`npm run test:progress-integrity`、`npm run bridge:verify:synthetic` 和 `npm run build`。本机 9 个 registry/hash 绑定 fixture 的严格 private native gate 通过；section-28 仍为 `partial`，仅证明只读预检、沙箱回滚与 native 前置 smoke，不证明真实 Mod 加载/游戏内回滚。

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

当前已落地的 transport 基础：`BridgeDaemonHost.cs`、`BridgeDaemonClient`、协议 1.0 handshake、允许根目录、deadline、取消、并发限制、进度帧、健康/能力查询和崩溃失效。一次性 CLI 只保留 synthetic/人工验证用途。BND4 五类 mutation、FMG/PARAM 暂存写入和 EMEVD mutation 命令已经存在；尚未完成 Oodle/KRAK、剩余语义/资产 native writer、完整写操作恢复覆盖和发行包内自包含部署。

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

每个 semantic mutation 的可持久 inverse 必须由实际 writer 在暂存输出完成并重读后、目标替换前捕获；PatchIR 中可先携带声明性的 previous/inverse 信息，但只有绑定实际 staged before/after 状态并通过 coverage 校验后才能落库：

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
  -> 内容寻址暂存
  -> writer postValidate / 暂存重读
  -> 捕获并持久化 inverse
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
testRole（可选；只用于严格门禁的 primary fixture 绑定）
~~~

仓库只提交 registry schema 和 runner：

- schema：`schemas/native-fixture-registry.schema.json`
- loader/runner：`scripts/native-fixture-registry.mjs`、`scripts/verify-native-fixture-registry.mjs`
- 命令：`npm run test:native-fixture-registry`

runner 必须先验证 registry/root 不是符号链接、`localPath` 不越界、目标是真实普通文件且 SHA-256 匹配，再向内部 native runner 提供绝对路径。严格私有门禁还必须绑定 BND4/FMG/PARAM/EMEVD/MSB 五个 primary role，以及同时带 `dcx-document` 断言的 DFLT/KRAK fixture；不得通过目录扫描替代显式登记。

支持环境变量：

~~~text
SOULFORGE_NATIVE_FIXTURE_ROOT
SOULFORGE_NATIVE_FIXTURE_REGISTRY
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
8. 第 42 节 `[x]` 只表示对应条目完整通过；任何 `partial/candidate/fixture-confirmed/blocked/skipped/unverified/unsupported` 或未完子项都必须保持 `[ ]`。
9. 命令退出码 0 只是 transport 结果；阶段裁定还必须检查结构化 `status`、`authority`、`skipped`、`failed`、corpus 总数和失败数。
10. 私有环境缺失可在公开 CI 用 `--allow-skip` 记录，但 release gate 默认严格，`skipped/partial` 必须非零退出。
11. 每次修改进度、README 或 Bridge 能力描述后运行 `npm run test:progress-integrity`，并同步修正模块地图和当前执行位置。
12. 声明能力可用的门禁必须执行该能力的真实正向成功路径；失败关闭、缺失诊断和 synthetic 测试只能证明边界，不能充当成功证据。
13. 严格私有门禁必须同时设置 `SOULFORGE_NATIVE_FIXTURE_ROOT`、`SOULFORGE_NATIVE_FIXTURE_REGISTRY` 和 `SOULFORGE_SEKIRO_GAME_ROOT`；native runner 必须从 registry 的 hash 绑定条目解析语料。固定仓库 `mods/...` 只能作为未设置 registry 时的本地开发默认值，不能充当严格私有门禁输入；只有三项均未设置时公开 CI 才可显式 `--allow-skip`。

---

## 30. 接手 Agent 的第一批具体任务

P0 与 P1 的 transport / persistence 基础、DFLT-BND4 子集和部分语义 smoke 已经落地。接手后不要重做这些工作，也不要把已有子能力外推为阶段完成；第一批应严格是：

1. 重新确认 `git status`、HEAD 和未跟踪 `mcps/**`。
2. 跑基线验证。
3. 在仓库外建立符合 schema 的真实 fixture registry；取得合法 Sekiro Oodle runtime 后，按 registry 完成 KRAK 真实成功解压/重压和 KRAK 内 BND4 corpus，不得用失败关闭、目录扫描或 skip 代替。
4. 将 BND4 公共 authority 从 `candidate` 提升前，建立覆盖全部发布 corpus 的结构、roundtrip、CRUD 和未知数据保持证据。
5. 当前 `gameparam.parambnd` 138/138 子项往返和 fixture-scoped 用户派生字段暂存重读已通过；继续补齐原生 paramdef、完整发布 registry、官方字段语义与专业编辑器，再决定 P3 PARAM authority。
6. 补齐 EMEVD `layerCount != 0`、KRAK 语料、完整 EMEDF schema/类型转换和剩余发布 corpus；补齐 MSB 全实体 CRUD/重排/类型转换。
7. PatchIR 1.0 已补 schemaVersion、reorder、convert、asset import、typed payload 和结构化 inverse，并移除生产 `nodePayload?: unknown`；EMEVD `restBehavior`/`instruction args`/空事件 `add`/既有非空事件 `delete`/`duplicate`/事件顺序 `reorder`/instruction 零参数 `add` 与既有 instruction `duplicate`/`delete`/`reorder`、raw FMG `text`/槽位 `delete`/`insert`/`reorder`、PARAM 用户派生字段与 MSB part 位置已接入原生 semantic writer、writer-bound inverse 和 resource-entry 新事务回滚，继续迁移其余 EMEVD/FMG/PARAM/MSB/asset 操作，不得把局部闭环外推为完整语义主干。
8. 合并两套 AI tool registry；把 core model adapters、safeStorage、app.db grants/history、Context Broker 和桌面真实调用接成单一生产链。
9. 将 Hex/EMEVD/PARAM/FMG/MSB UI 从演示/代理路径升级为专业桌面，并拆除千行级 `App.tsx` / `ipc.ts` 单体。
10. 完成 Playwright E2E、真实打包、签名、更新器、完整性能和 section-28 真游戏门禁；严格 release gate 不允许 skip/partial。

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
| `packages/shared/src/patch-ir.ts` | PatchIR 1.0 已版本化；resource field/node/edge、reorder、convert、asset import 使用 discriminated typed payload 与结构化 inverse；`FmgEntryNodePayload` 绑定 `stringIndex`；EMEVD event payload 绑定 `eventId + eventIndex + eventHash`，事件增删/复制使用 canonical/Bridge 权威快照，事件重排绑定完整顺序；instruction payload 绑定父事件 occurrence、局部索引、bank/id、layer、args、parameterCount、instructionHash 与 Bridge 权威快照；大 snapshot 可用内容寻址 staging object，生产 `nodePayload?: unknown` / `edgePayload?: unknown` 已移除 | typed contract 解决可表达性；当前 BND4、EMEVD 已列出字段/事件/instruction 子能力、raw FMG `text`/槽位 `delete`/`insert`/`reorder`、PARAM 用户派生字段与 MSB part 位置已接 production inverse 主干，继续迁移其余语义/资产写入，未完成前不得声明 native semantic PatchIR 完成 |
| `packages/shared/src/writer-contract.ts` | staging contract 已覆盖 semantic/asset operation kind，并提供 writer-bound `captureInverse`；BND4 及当前 EMEVD/FMG/PARAM/MSB typed 子能力 writer 已实现精确捕获 | 其他 production writer 必须实现 document/layout/revision 前置条件和完整 inverse coverage；registry 绑定真实 authority，不能只信 IR metadata |
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
| `packages/core/src/patch/durablePatchCommit.ts` | 异步 pending/committed store + transaction + 应用数据 recovery；结构化操作在暂存成功后、目标替换前由实际 writer 捕获 inverse，缺失 coverage 失败关闭 | 将 recovery metadata/restore point 纳入 workspace.db 生命周期与保留策略；继续覆盖剩余 semantic/asset writer |
| `packages/core/src/patch/operationLog.ts`、`sqliteOperationLogStore.ts` | 异步 store 契约与 workspace.db operation repository | 扩到 transaction/file/resource entry/audit repositories |
| `packages/core/src/patch/fileOperationLogStore.ts`、`importLegacyOperationLog.ts` | JSON store 仅供兼容测试；生产严格幂等导入且损坏失败关闭 | 语义 snapshot 迁移完成后删除生产 JSON 入口，保留测试兼容 |
| `packages/core/src/patch/rollback.ts` | operation/file/resource-entry 均以新 PatchIR 事务回滚，不修改旧操作；resource-entry 已验证 BND4 五类、EMEVD `restBehavior`/`instruction args`/空事件 `add`/既有非空事件 `delete`/`duplicate`/事件完整顺序 `reorder`/instruction 零参数 `add` 与既有 instruction `duplicate`/`delete`/`reorder`、raw FMG `text`/槽位 `delete`/`insert`/`reorder`、PARAM 用户派生字段与 MSB part 位置 typed inverse | 扩展到其余语义 mutation、嵌套 msgbnd 与完整 corpus，保持 afterHash/typed value/node/完整顺序 hash 冲突保护 |
| `packages/core/src/backup/restorePoint.ts` | 支持应用数据目录恢复点 | 接内容寻址去重、30 天/10GB 保留和引用保护 |
| `packages/core/src/staging/contentAddressedStaging.ts` | 内容寻址暂存骨架 | 保留并接 workspace local data root/retention |
| `packages/core/src/writers/*` | text/raw/synthetic、原生 BND4，以及覆盖当前已列出 EMEVD 字段/事件/instruction、raw FMG 槽位、PARAM 用户派生字段与 MSB part 位置子能力的 Bridge semantic writer；原生结构化 writer 强制执行带身份与 operation coverage 的 `postValidate`，结构化 inverse 由同一 writer 在暂存后捕获 | synthetic 只留测试；继续为嵌套 msgbnd FMG 与 EMEVD/FMG/PARAM/MSB 其余 mutation 增加 Bridge authority adapter，并保持 postValidate/captureInverse 契约 |
| `packages/core/src/validators/*` | text/raw/container 与 EMEVD/FMG Bridge 重读 validator；事务逐 operation 强制 required validator 唯一注册、阶段/方法一致、结果身份可信并返回实际 coverage，异常与无诊断失败均结构化失败关闭 | 增加剩余格式/操作的多层 native validators；不把 coverage 契约等同于格式完成 |
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
| `packages/core/src/ai/assistantSession.ts` | 旧 mock/计划草稿 helper 仍保留，但不再是桌面生产调用权威 | 收缩为测试/兼容 helper；生产生命周期以 main 的 model-service agent loop 为准 |
| `packages/core/src/model-services/*` | 三类 adapter、fake-server agent loop 与 desktop main production caller 已存在 | 补真实双 provider 正向 smoke、流式/取消和完整桌面生命周期 |
| `packages/core/src/ai/toolRegistry.ts` | 唯一生产 typed registry；旧 scaffold registry 已删除，agent loop contract 门禁已覆盖 | 继续扩展生产工具与 policy/audit 证据，不恢复第二套状态或权限模型 |
| `packages/core/src/ai/toolPermissions.ts` | mode → permission rank | 修正计划模式；权威 mode 只由 main 上下文提供 |
| `packages/core/src/ai/evidencePackBuilder.ts` | 证据包 | 接 SQLite/Context Broker；不暴露 absolutePath |
| `packages/core/src/ai-tools/patchTools.ts` | PatchIR 工具定义由生产 registry 与测试共同复用 | 保持单一工具定义来源和 typed policy gate |
| `packages/core/src/ai-tools/policyGate.ts` | 综合策略 scaffold | 升级为生产 policy gate |
| `packages/core/src/audit-log/*` | memory audit | 替换为 DB repository |

### 33.6 Desktop

| 文件 | 当前状态 | V0.5 处理 |
|---|---|---|
| `apps/desktop/src/main/index.ts` | sandbox/CSP 配套窗口安全和 Bridge/DB 关闭生命周期已落地 | P1/P5 拆出 app service container 和 domain 生命周期 |
| `apps/desktop/src/main/ipc.ts` | sender 校验、一次性目录选择、main 确认、资源 URI、utility DB、grant 解析和真实模型服务编排已接；仍是大型单体 handler | 拆为 domain handlers + `WorkspaceSessionManager`，补完整 runtime schema、流式/取消和人机授权生命周期 |
| `apps/desktop/src/main/rendererDto.ts` | 已统一剔除绝对路径等 main-only 字段 | 所有新增 DTO 必须复用或替换为 versioned runtime schema |
| `apps/desktop/src/main/databaseUtility.ts`、`operationLogUtilityClient.ts` | Electron utility process 托管 `app.db/workspace.db` 与异步操作日志 RPC | 增加全部 repositories、任务恢复、崩溃重启故障注入和审计 |
| `apps/desktop/src/preload/index.ts` | 已删除确认铸造、绝对根路径和 renderer mode；仍是单个 API 对象 | 按 versioned domain API 拆分，输入输出 runtime validation |
| `apps/desktop/src/renderer/src/App.tsx` | 1800+ 行单体，专业编辑器仍含 demo fallback、代理场景和演示任务 | P5 拆除，仅保留 app bootstrap/router；真实能力失败不得静默回退为可编辑 demo |
| `apps/desktop/src/renderer/src/styles.css` | 固定三栏全局 CSS | 迁移为应用壳/编辑器局部样式与主题 tokens |
| `apps/desktop/electron.vite.config.ts` | 已增加 database utility 与运行 smoke 入口 | P4/P5 再增加转换 worker、Three chunk 和发行打包配置 |

### 33.7 Bridge

| 文件/目录 | 当前状态 | V0.5 处理 |
|---|---|---|
| `bridge/SoulForge.Bridge/Program.cs`、`BridgeDaemonHost.cs` | net10 daemon bootstrap + 一次性测试兼容入口 | P2 增加 native command service，不恢复 production one-shot |
| `bridge/SoulForge.Bridge/ParserTypes.cs` | BridgeResult/diagnostic 类型 | 迁移到 protocol 1.0 envelope 与 authority |
| `bridge/SoulForge.Bridge/EnvelopeInspection.cs` | bounded envelope evidence | 保留作为 inspect 第一层 |
| `bridge/SoulForge.Bridge/DcxNativeDocument.cs`、`DcxPayloadProbe.cs` | DFLT 私有样本 roundtrip 已落地；登记 KRAK fixture 的合法 Oodle 解压成功路径已验证 | 完成 KRAK 重压与完整 corpus 后再收口完整 DCX authority |
| `bridge/SoulForge.Bridge/Bnd4NativeDocument.cs`、`Bnd4NativeWriter.cs` | DFLT-BND4 parser/repack/writer 可运行，但公共文档仍返回 `candidate` | 覆盖 KRAK 内 corpus 并统一 authority 判定 |
| `bridge/SoulForge.Bridge/Synthetic*` | synthetic fixtures | 保留测试，显式 fixture-confirmed |
| `bridge/SoulForge.Bridge/FmgNative*`、`ParamNative*`、`EmevdNative*`、`MsbNative*` | 已有分层真实样本 smoke；PARAM 当前 gameparam binder 138/138，并有用户派生单字段暂存重读证据；MSB 为 candidate，四类均未满足完整 P3 | 按发布 registry、原生 paramdef、未知区段、全 CRUD/重排/转换和三层回滚分别收口 |
| `bridge/SoulForge.Bridge/SemanticCandidateExports.cs` | candidate 导出兼容入口仍保留 | 只能作 unsupported fallback，不能混入 verified output |
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

状态语义：`[x]` 仅表示该条目按交接书定义完整通过；`[ ]` 同时覆盖未开始、进行中、`partial`、`candidate`、`fixture-confirmed`、`blocked`、`skipped`、`unverified` 和 `unsupported`。说明文字可记录已通过的子能力，但不能据此提前勾选。`npm run test:progress-integrity` 强制检查该约束。

- [x] 基线验证与工作树核对（2026-07-19；后续接手仍须重跑）
- [x] P0 文档口径
- [x] P0 Electron 安全
- [x] P0 IPC/session/path 安全边界
- [x] P0 confirmation/recovery/operation rollback
- [x] P0 全量回归
- [x] P1 .NET 10 与自包含 `win-x64` 配置
- [x] P1 Bridge daemon transport / protocol 1.0
- [x] P1 Bridge 写操作崩溃恢复故障注入（BND4 staging writer；fail-closed 且不自动重放已验证）
- [x] P1 SQLite 两库 migration/utility process 基础
- [x] P1 SQLite 核心 repositories/任务恢复发现/audit（main 安全清理执行器已验证）
- [x] P1 operation log JSON 严格幂等迁移
- [x] P1 semantic snapshot 严格幂等迁移
- [x] P1 file/resource entry inverse rollback 基础设施（synthetic 闭环已验证；native authority 由 P2/P3 单列裁定）
- [ ] P1 Oodle/KRAK（失败关闭和 1 个 registry/hash 绑定真实 KRAK 解压正向样本已验证；重压与完整发布 corpus 未完成）
- [x] P2 DFLT variants（本机私有基线 144/144 完整 payload roundtrip；KRAK 单列）
- [ ] P2 BND4 native（DFLT 外层 production 读写及登记 KRAK 解压后的嵌套 BND4 识别已验证；公共 authority 仍为 candidate，KRAK 重建/重压未完成）
- [ ] P2 child CRUD/repack（DFLT-BND4 五类 + resource-entry inverse 已验证；登记 KRAK 仅覆盖解压/嵌套识别，未覆盖重压）
- [ ] P2 container roundtrip（DFLT-BND4 已验证；完整 KRAK corpus 与重压仍未完成）
- [ ] P3 FMG（item.msgbnd 18/18 语义往返 + 写入 + BND4 提交/回滚；raw FMG 已有条目 `text`、槽位级 `delete`/`insert`/`reorder` 的 typed PatchIR、重复 ID occurrence 隔离、完整顺序 postValidate、resource-entry/operation rollback 已验证；嵌套 msgbnd 字段事务、id-wide 增删的精确 inverse、类型转换与完整发布 corpus 未验证）
- [ ] P3 PARAM（当前 gameparam binder 138/138 无修改字节/语义往返；长偏移与两种 embedded-type-name 布局、旧布局 writer 已验证；用户派生字段 typed PatchIR 提交/entry rollback 已验证；原生 paramdef 与完整发布 registry 未完成）
- [ ] P3 参数结构定义（用户派生 ParamDefDocument 布局校验/字段解码编码与 typed field production writer 已验证；原生 .paramdef 二进制解析与官方适配包签名未完）
- [ ] P3 EMEVD（10 个 DFLT corpus 9696/126562；rest/args、事件增删/复制/重排、重复 ID 身份与 operation rollback 已验证；`restBehavior`、`instruction args`、空事件 `add`、既有非空事件 `delete`/`duplicate`、事件完整顺序 `reorder`，以及 Bridge-authored 零参数 instruction `add`、既有 instruction `duplicate`/`delete`/`reorder` typed resource-entry rollback 已在 `common` 验证；新增 instruction 实测 `parameterCount=0`、`layerOffset=-1`，事件 delete 快照恢复 7 条指令/6 条参数替换，instruction 快照恢复目标的 2 条参数替换；该语料未覆盖重复 ID 非空事件 typed delete；33 个 KRAK、完整 EMEDF-aware authoring/类型转换、layerCount≠0、完整三层回滚 corpus 和发布 corpus 未完）
- [ ] P3 MSB（models/parts + POINT regions 1504 + EVENT 64；part/region 位置写回；part 与 region 位置 typed PatchIR + resource-entry rollback 已验证于 DFLT 解压 raw MSB；authority 仍为 candidate，全实体 CRUD/增删/DCX 包装未完）
- [ ] P3 graph/index/diagnostics（MemoryResourceGraph + WorkspaceIndex 健康报告与候选引用诊断；完整语义索引未完）
- [ ] P3 resource entry rollback（BND4 五类、EMEVD `restBehavior`/`instruction args`/空事件 `add`/既有非空事件 `delete`/`duplicate`/事件完整顺序 `reorder`/Bridge-authored 零参数 instruction `add`/既有 instruction `duplicate`/`delete`/`reorder`、PARAM 用户派生字段、MSB part 位置与 raw FMG `text`/槽位 `delete`/`insert`/`reorder` 已验证；EMEVD 完整 EMEDF-aware instruction authoring/类型转换、FMG 类型转换、MSB 全实体 CRUD、嵌套 msgbnd 字段回滚和完整 entry rollback corpus 未完成）
- [ ] P4 scene asset inventory（MSB manifest → candidate 模型/材质引用清单；无 FLVER 原生解析）
- [ ] P4 native scene formats（FLVER 头 + mesh 表 candidate；完整几何/材质/writer 未完）
- [ ] P4 open-format import（glTF/GLB/PNG/TGA/DDS 暂存主干；原生转换未完）
- [ ] P4 Three.js scene（代理几何 WebGL2；真实 mesh/LOD 未完）
- [ ] P4 asset conversion/writeback（暂存→PatchIR file_replace；最小 RGBA→DDS 编码器已通；FLVER 未完）
- [ ] P5 app shell/document store（统一 EditorDocumentStore/mutation 协议已存在；单体拆分和完整生命周期未完）
- [ ] P5 Hex（HexDocument + 16-byte 演示面板；搜索/跳转/虚拟化/diff 等未完）
- [ ] P5 EMEVD 四视图（实时读取与 rest/事件上移下移 typed mutation 已接；读取失败不再静默回退可编辑 demo；DSL/全量指令/完整 UI 与 Electron 人机未完）
- [ ] P5 PARAM/结构定义（实时读/写 + 复制行已接；读取失败不再静默回退可编辑 demo；ParamDef 仍为 fixture，官方包签名未完）
- [ ] P5 FMG（实时读取、已有条目 `text`、槽位级 `delete`/`insert`/`reorder` typed mutation、重复 ID 槽位选择与显式上移/下移已接；读取失败不再静默回退可编辑 demo；id-wide upsert/delete 兼容入口仍走 whole-file raw fallback，嵌套 msgbnd 与完整本地化工作台未完）
- [ ] P5 MSB 3D（parts/regions 位置微调 + Three 代理；读取失败不再静默回退可编辑 demo；完整场景/资产/gizmo/CRUD 未完）
- [ ] P5 patch/reference/history/jobs（workbench 投影与演示面板已存在；持久生产工作流未完）
- [ ] P5 i18n（简体中文静态术语扫描通过；i18next 双语资源和切换未完）
- [ ] P6 OpenAI Responses（adapter + fake SSE tool loop + 桌面 production caller 已接；真实服务正向 smoke、流式/取消和完整 UI 未完）
- [ ] P6 OpenAI Chat Completions compatible（adapter + fake-server tool loop + 桌面 production caller 已接；真实服务正向 smoke、流式/取消和完整 UI 未完）
- [ ] P6 Anthropic Messages（adapter + fake-server tool loop + 桌面 production caller 已接；真实服务正向 smoke、流式/取消和完整 UI 未完）
- [ ] P6 credentials/grants/context/audit（safeStorage 密文、app.db configs/grants/history/retention、Context Broker、outbound audit 与 utility/main IPC 已接；grant mode/scope 在 main fail-closed 校验；真机 DPAPI、人机授权、历史管理 UI 与产品级 scope 生命周期未完）
- [ ] P6 agent loop（core fake loop与 desktop main-only 凭据解析、双 adapter、grant-derived mode、唯一生产 registry、app.db history/audit 已验证；真实服务正向 smoke、流式 UI 与取消路径未完成）
- [ ] P7 unit/integration/E2E（现有 smoke 层 + CI 入口；Vitest/xUnit/Playwright Electron E2E 未完）
- [ ] P7 Windows CI（workflow 已存在并强制 unsigned `win-unpacked` 真构建/内容审计；本地同命令已通过，远程 runner、私有门禁与正式发行矩阵仍未验证）
- [ ] P7 installer/signing/updater（electron-builder 已安装，unsigned `win-unpacked` 真构建、EXE/ASAR/Electron ABI SQLite binding/禁止内容审计与窗口启动已通过；portable EXE/NSIS 因本机 GitHub release asset 下载 EOF 未产出，签名/updater 未配置）
- [ ] P7 performance（宽松 CI smoke；完整产品性能门槛与 10GB 压力未完）
- [ ] P7 private native gate（2026-07-18 本机 9 个登记 fixture 严格门禁通过；MSB 仍为 candidate，完整发布 corpus/release matrix 未完成；无 env 只能 allow-skip 记录）
- [ ] P7 real Sekiro launch/rollback（完整启动/Mod 加载/回滚自动化未实现；严格门禁不得 skip/partial）
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
- `P1/P2/P3`：Bridge/SQLite 基础及登记的 DFLT/KRAK/BND4、FMG/PARAM/EMEVD/MSB 子能力已有证据；KRAK 重压、完整发布 corpus 与完整 native authority 仍未完成。
- `P6`：credentials、持久 grants、Context Broker、唯一生产 registry、agent loop/history/audit 已接；真实双 provider 正向 smoke、流式/取消、人机授权和完整 UI 仍未完成。
- `P7`：本机登记 fixture 的严格 private native gate 已通过；section-28 仍只有只读预检、沙箱回滚和可选短启动探测，不能解释为真实 Mod 加载/回滚完成。
- 下一项：完成当前全量回归后，优先补真实模型服务正向 smoke 与流式/取消边界；native 侧继续 KRAK 重压/完整 corpus、MSB authority 和 section-28 真实闭环，所有未完成项保持未勾选。

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

- `P0`：当前回归支持完成声明。
- `P1`：transport/persistence/rollback 基础可用；KRAK/Oodle 真实成功路径未完成。
- `P2`：DFLT 完成当前私有样本断言；BND4 仅 DFLT 子集可运行，公共 authority 仍为 candidate。
- `P3`：FMG/EMEVD/PARAM/MSB 均有真实子能力证据，但没有任何一类满足完整发布定义。
- `P4`–`P5`：当前是资产/场景/编辑器 prototype，不是完整产品阶段。
- `P6`：core fake-server adapters/agent loop 可复现；desktop production、真实服务、grant/context/audit 未完成。
- `P7`：公开 CI/配置/内容扫描可用；E2E、真打包、签名、更新、完整性能与 section-28 未完成。
- **环境阻塞**：本机无 `SOULFORGE_SEKIRO_GAME_ROOT` / 合法 Oodle；KRAK 与真实游戏门禁不可替代合成通过。
- **V0.5 未完成**：不得标记「最终 V0.5 release criteria 全绿」。

### 2026-07-13：代码/文档状态审计与进度门禁收口

- 状态：`pass（状态修正与门禁）；产品阶段状态没有被本次文档修正提升`
- 审计基线：HEAD `7bd354d`；工作树原有未跟踪 `mcps/**`，不属于 V0.5。
- 已重新验证：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`。
- 已重新验证：214 DCX 中 144 DFLT 通过、70 KRAK blocked；75 个 DFLT-BND4、11,344 entries 通过当前 roundtrip，BND4 writer/transaction/rollback smoke 通过。
- 已重新验证：FMG 18/18；PARAM 38/40 且 2 个失败；EMEVD 单一基线 1730 events / 33266 instructions；MSB 返回 `authority=candidate`。
- 已重新验证：双模型 fake-server/Responses adapter smoke、safeStorage 源码契约和宽松性能 smoke；这些都不是桌面真实服务、DPAPI 人机或产品性能验收。
- 已重新验证：private-native 与 section-28 在无环境时为 `skipped`；portable 仅 `pass-config` 且 electron-builder 未安装。
- 已修正：第 42 节所有 partial/candidate/blocked/skipped/unverified 项恢复为 `[ ]`；README、Bridge README、模块地图和当前执行位置同步当前实现。
- 新约束：`npm run test:progress-integrity` 阻止未完成证据被勾选；严格 private/section-28 gate 在 skip/partial 时非零退出，公开 CI 必须显式使用 `--allow-skip`。
- 未验证：合法 Oodle/KRAK、完整发布 corpus、真实模型、Electron 人机、Playwright、签名发行、更新器、真实 Sekiro 启动。
- 非声明：本记录只修复事实源和门禁，不把任何未完成 P2–P7 条目提升为 pass。

### 2026-07-13：Oodle/KRAK 真实正向门禁收紧

- 状态：`pass（门禁契约）；真实 KRAK 成功路径仍 blocked`
- 根因：原私有 native 门禁在设置任一环境变量后只运行 Oodle 失败关闭测试；该测试即使完全没有合法运行库和 KRAK 成功解压，也可能以退出码 0 进入后续步骤，不能证明私有 native 正向能力。
- 已实现：新增 `bridge:verify:oodle:real`，要求游戏根、fixture 根和 registry 同时存在；Oodle runtime 为可解压状态，并只从已通过路径/hash 校验、显式声明 `DCX-KRAK` + `dcx-document` 的条目读取 KRAK DCX，校验 source hash、payload hash 和解压尺寸。
- 已实现：`test:private-native-gate` 的首步改为真实 Oodle/KRAK 门禁；缺任一环境变量时严格模式退出 2。只有三项私有环境变量全部未设置时，显式 `--allow-skip` 才可在公开 CI 以 `status=skipped` 退出 0；部分配置必须失败。
- 已验证：`test:native-gate-contract` 覆盖真实门禁缺环境失败、private-native 严格/allow-skip/部分配置分流、registry schema/path/hash/套件完整性与路径脱敏、section-28 严格/allow-skip 分流；`bridge:verify:oodle:real` 在本机无合法环境时返回 `REAL_OODLE_ENVIRONMENT_REQUIRED` 且退出 2。
- 未验证 / blocked：本机 Steam 库未安装 Sekiro，且未发现合法 `oo2core_6_win64.dll` 或私有 KRAK 语料，因此真实解压成功分支没有运行；P1 Oodle/KRAK 和 P2 KRAK/BND4 条目继续保持 `[ ]`。
- 非声明：本批只消除门禁假绿，不证明 KRAK 重压、KRAK 内 BND4 corpus、完整 P1/P2 或 V0.5 完成。

### 2026-07-13：私有语料绑定、BND4 file-backed 提取与 PARAM corpus 扩展

- 状态：`pass（已列出的子能力）；P1/P2/P3 整体仍未完成`
- 根因：私有门禁虽然接收 `SOULFORGE_NATIVE_FIXTURE_ROOT`，多个 runner 仍静默使用固定 `mods/...`；总门禁漏跑 DCX/BND4，且只看退出码会把 PARAM 失败样本和 MSB `candidate` 当通过。PARAM 40 项抽样还掩盖了大子项 Base64 超帧和第三种旧布局。
- 已实现（后续已收紧）：native runner 统一通过 `nativeFixturePaths.ts` 解析输入；2026-07-15 起不再接受未登记显式路径、单独 role 路径或本地开发默认根，当前必须先校验 `SOULFORGE_NATIVE_FIXTURE_ROOT` + `SOULFORGE_NATIVE_FIXTURE_REGISTRY` 中的路径与 SHA-256。private gate 新增 DCX corpus、BND4 writer/transaction，并解析结构化 JSON，拒绝 `partial/candidate/blocked/skipped`、corpus failure 和非零退出。
- 已实现：新增 daemon 命令 `extract-bnd4-child`。输入必须位于 allowed root，输出必须位于 main 注册的 `writableRoots`，同时校验容器 hash、子项 hash、原子暂存写入和重读 hash；大 PARAM 不再通过 NDJSON 内联 Base64 传输。
- 已实现：PARAM parser 显式支持 `0x40/0x18` 长偏移布局，以及 `formatFlags=0x100/0x200` 的 `0x30/0x0C` header-embedded type name 布局；保留原始头部、行表到数据区间隙和非 ASCII 行名原始字节，禁止新增非 ASCII 名称时静默 ASCII 损坏。
- 已验证：`bridge:build` 0 warning / 0 error；`bridge:verify:param` 对当前 `gameparam.parambnd` 138/138 子项无修改字节/语义往返、0 failure，旧布局 upsert→暂存→重读通过；`bridge:verify:bnd4-writer` 验证 file-backed 提取成功、越界输出被拒绝且原 `mods` 未产生文件。
- 已验证：显式设置 `SOULFORGE_NATIVE_FIXTURE_ROOT` 后，BND4 writer/transaction、FMG 18/18、PARAM 138/138、EMEVD 1730/33266、MSB 5406 parts/1504 regions/64 events 均从该根运行；MSB 仍返回 `authority=candidate`。
- 已实现：新增 `schemas/native-fixture-registry.schema.json`、registry loader/runner；严格门禁在 native 命令前校验 registry/root 安全边界、相对路径、真实文件、SHA-256、唯一 id/role、五类 primary role 与 DFLT/KRAK `dcx-document` 套件。DCX corpus 和真实 Oodle/KRAK runner 都按登记条目取证，报告只保留 fixture id/hash/variant/断言/诊断并限制证据条数。
- 已验证：`test:native-gate-contract` 覆盖合法 registry、hash 不匹配、路径穿越、套件不完整、路径脱敏和部分环境配置拒绝；本地未登记开发 corpus 仍完整执行 214 个 DCX，144 DFLT、75 个嵌套 BND4/11344 条目通过，70 KRAK 因缺合法 Oodle 返回 `status=blocked`/退出 2，0 普通失败，报告未出现仓库或 `mods` 绝对路径。
- 根因修复：Windows/Node 24 对 `spawn('npm.cmd', ..., shell=false)` 返回 `EINVAL`，导致配置齐全后严格门禁在首个子步骤崩溃。现由 `native-gate-process.mjs` 通过显式 `ComSpec /d /s /c npm.cmd` 启动固定 npm 子命令，并把同步/异步 spawn 错误收口为结构化 `spawnErrorCode`；契约测试实际执行 `npm --version` 锁住 Windows 启动路径。
- 已验证：仓库外最小 registry 在 7 个真实本地 fixture 上完成路径/hash/套件校验；registry 模式 DCX 精确运行 1 DFLT + 1 KRAK，DFLT 和嵌套 BND4 109 条目通过，KRAK 因缺 Oodle 返回 `blocked`/退出 2。严格总门禁真实执行全部步骤：BND4 writer/transaction、EMEVD 1730/33266、FMG 18、PARAM 138/138 通过；Oodle/KRAK 失败、MSB `candidate` 被拒绝，总状态 `failed`/退出 1，输出和持久化报告均未泄漏 fixture/registry 路径。
- 未验证 / blocked：合法 Oodle/KRAK 与 KRAK 内 BND4；完整发布 registry/PARAM corpus；原生 paramdef 字段级闭环；MSB 完整实体语义；四类资源完整三层回滚与真实游戏门禁。
- 非声明：138/138 只代表当前选定 `gameparam.parambnd` 的 parser/无修改往返与已列 writer 断言，不等于 P3 PARAM 或完整发布 corpus 完成。
- 完整回归：本批次最终 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、Bridge daemon/client、BND4 transaction 均退出 0；进度完整性仍为 15 checked / 36 unchecked。

### 2026-07-13：PARAM 有界读取与用户派生字段暂存闭环

- 状态：`pass（已列出的子能力）；原生 paramdef、专业 PARAM 编辑器与 P3 整体仍未完成`
- 根因：原 `readParamDocumentViaBridge` 先让 Bridge 返回整份 rows/payload，再在 TypeScript 端用 `maxRows` 截断；大表仍会产生无界解析、Base64 和 NDJSON 帧压力。已有 `ParamDefDocument` 只做了宽松布局映射，字段 mutation 也没有绑定文档/行 hash、字段范围和暂存重读，不能作为可写语义闭环。
- 已实现：`read-param-document` 在 Bridge 端执行 `rowOffset`/`rowLimit`（1..500）和 `rowId` 筛选，单页 payload 上限为 256 KiB；超限或调用方关闭 payload 时仍返回 row hash、分页元数据与结构化省略状态。桌面实时 PARAM 读取固定请求 100 行，字段写路径按 row ID 只读取目标行。
- 已实现：用户派生 `paramdefLayout` 增加 schema/type/row size、字段与枚举唯一性、标量尺寸、对齐、范围、enum、default、bitfield 和位级重叠校验；严格编码 enum/min/max/整数/f32/fix/hex bytes，支持同一存储字节内互不重叠的 bitfield，并保持输入 Buffer 不变。
- 已实现：`prepareParamFieldMutation` 校验定义来源边界、PARAM type/row size、旧 row hash、严格 Base64、payload hash 与字段字节范围，只产出完整 row payload；`commitParamFieldMutationViaBridge` 复用现有 `write-param` 暂存 writer，并按 row hash 重读确认。私有 registry 的 PARAM primary 增加 `param-field-staging-roundtrip`，严格门禁要求对应结构化证据存在；`registryDigest` 绑定规范化路径、文件 hash、authority、capability、assertion 与 role，验收语义变化不会沿用旧摘要。
- 已验证：`npm run bridge:build`（0 warning / 0 error）、`test:paramdef-layout`、`test:param-field-mutation`、`test:param-read-pagination`、`bridge:verify:synthetic`、`test:native-gate-contract`、`npm run typecheck`、`npm test`、`npm run build` 均退出 0。
- 已验证：当前登记 `gameparam.parambnd.dcx` 的 `bridge:verify:param` 仍为 138/138、0 failure；ActionGuideParam 的 fixture-only `u8@offset0` mutation 只改变 byte 0，经暂存 writer 重读 hash 一致，BND4 提交/回滚保持通过。配置完整但缺合法 Oodle 的严格私有总门禁仍按预期失败；其中 PARAM 步骤通过新增字段断言，Oodle/KRAK 与 MSB `candidate` 继续拒绝总门禁假绿。
- 语料/许可盘点：当前 `mods` 与仓库外私有目录均没有 `.paramdef` 文件。上游 Paramdex 提供 Sekiro XML 定义但仓库未声明可依赖的许可证；SoulsFormatsNEXT 为 GPL-3.0。按“外部工具只作行为对照、不复制源码、不作为核心运行依赖”约束，本批没有导入其代码或定义，也没有用 XML/fixture 冒充原生 `.paramdef` 完成。
- 未验证：原生 `.paramdef` 二进制 parser、官方字段名/类型/数组语义、用户派生包签名、字段表 UI 接线、批量/公式/preview/diff、完整发布 registry、KRAK、真游戏 section-28。
- 非声明：fixture-only `u8@offset0` 只验证类型化 mutation 与安全写入管线，不赋予该字节官方语义；138/138 仍不等于完整 P3 PARAM；服务端分页不等于双向虚拟化专业表格完成。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked，未提升任何 P3/P5/P7 完成项。

### 2026-07-13：EMEVD DFLT corpus、事件/instruction 身份、参数替换与 operation 回滚

- 状态：`pass（已列出的 DFLT 子能力）；KRAK、非零 layer、完整 EMEDF/类型转换、除 restBehavior 外的 resource-entry/完整三层回滚与 P3 整体仍未完成`
- 根因：既有 EMEVD 证据只有手工解压后的 `common.emevd` 单文件，桌面 `read-emevd-document` 实际会把 `.emevd.dcx` 直接交给 raw-only parser；事件复制与重排没有真实 corpus 断言，桌面 IR 又把事件 ID 当唯一身份。真实 `common.emevd` 还证明 ID 可以重复，因此 ID-only 查找会产生歧义或误改风险。后续审计又发现 GC 只保留 parameter 原始区段而不解析 event-local instruction 引用，也没有 instruction 增删、复制、重排入口；直接移动 instruction 会让 parameter substitution 指向错误目标。
- 已实现：`EmevdNativeDocument` envelope 返回 `eventIndex`；事件 mutation 用 `expectedSourceHash + eventIndex + expected eventId` 绑定外层输入修订内身份。未提供 index 时仅允许唯一 ID；重复 ID、索引越界或 index/ID 不匹配均结构化失败关闭。新增 `reorder_event`，源事件和锚点事件都必须绑定 index/ID。
- 已实现：新增 `EmevdNativeSource`，统一识别 raw `EVD` 与 DCX-wrapped EMEVD；envelope 明确分离外层 `sourceHash/sourceSize` 和内层 `documentHash/documentSize`。writer 对 raw/DFLT 重建并只写暂存区，KRAK 写入失败关闭；落盘后同时重读外层容器与内层文档，并要求二者字节与已验证重建结果一致。写入前置字段改为语义准确的 `expectedSourceHash`；旧 `expectedDocumentHash` 仅作兼容别名，两者冲突时失败关闭。四视图 envelope 映射、共享 IR、唯一事件 URI、core Bridge 提交和桌面实时提交均保留 `eventIndex`，重复 ID 事件不再共享同一 URI。
- 已实现：完整读取每个事件的 parameter substitution，严格验证 event-local instruction index、目标参数字节范围和非负 source offset；重建时保存其原始字段和顺序。新增 `add_instruction`、`delete_instruction`、`duplicate_instruction`、`reorder_instruction`；除 `expectedSourceHash` 外都强制绑定 `eventIndex + eventId + instructionIndex + expected bank/id`，重排锚点也绑定局部索引和 bank/id。插入/删除/重排按映射更新 substitution index，复制 instruction 同步克隆其 substitution；错误身份失败且不产生暂存文件。非零 layer 尚未解析，读取即失败关闭，不能进入会丢 layer 的 GC。
- 历史根因修复：共用 `nativeFixturePaths.ts` 曾按错误层级计算默认 `mods` 根；该默认回退已在 2026-07-15 的严格 registry 收口中完全移除。当前无 registry/root 的 native runner 必须失败关闭，不能再把历史默认路径当作支持的运行方式。
- 已实现：新增 registry 驱动的 `bridge:verify:emevd:corpus`，逐条校验 fixture hash/authority/assertions；严格私有门禁运行该 corpus 及 `bridge:verify:emevd:transaction`。10 个 DFLT EMEVD 条目绑定直接 DCX 读取、暂存/重读、无修改内层字节/语义往返、rest、定长/变长 args、事件与 instruction 增删、复制/删除、重排/逆操作和 `layerCount=0` 断言；`common` 额外绑定重复 ID 歧义拒绝、索引定向写入和 operation rollback，`common_func` 额外绑定 parameter substitution 重映射/克隆。registry 现有 16 项摘要为 `fc6c4d8e26c1c888258a822920475f0bb0b3574fb8f5a2ddc2a63f674fd1101f`。
- 已验证：10/10 DFLT-wrapped EMEVD，合计 9696 events / 126562 instructions；10/10 instruction 身份冲突拒绝、add/delete、duplicate/delete、reorder/inverse 断言通过并恢复原始内层 `documentHash`。`common_func` 的事件 `20202019`（38 条 substitution）验证插入/重排时 event-local index 重映射，复制一条带 substitution 的 instruction 时克隆 1 条，删除/逆操作后仍精确恢复原始 hash。zlib 重压均保持 payload/variant，但 `containerByteIdenticalCount=0`，不得把语义逆操作声明成外层字节回滚。新 `expectedSourceHash`、旧别名和双字段冲突拒绝均有真实写入断言。只有 `common` 出现重复 ID：事件 ID `88881000` 有 2 项；无 index 写入返回 `EMEVD_STAGING_WRITE_FAILED` 且不创建暂存文件，index 定向写入只改变目标项，逆操作恢复原始内层 hash。
- 已验证：`common.emevd.dcx` 经 Bridge 暂存、PatchIR whole-file 提交、提交后重读和 operation rollback 后，事务备份精确恢复原始外层 DCX 字节，原 fixture 保持只读未改；后续单独新增的 `restBehavior` resource-entry 回滚证据见下节，不能反向解释为其他 mutation 已覆盖。
- 已验证：`bridge:build` 0 warning / 0 error；`test:emevd-envelope-map`、`test:emevd-four-view`、`test:emevd-ipc-contract`、`test:desktop-live-editor-contract`、`npm run typecheck`、`npm test`、`bridge:verify:synthetic`、`npm run build`、`test:native-gate-contract`、`test:progress-integrity` 与 `git diff --check` 均退出 0。
- 已验证门禁边界：配置完整的严格私有门禁按预期退出 1；其中 EMEVD corpus 10/10、FMG、PARAM、BND4 步骤通过，Oodle/KRAK blocked 且 MSB 仍为 `candidate`，总门禁没有假绿。
- 本次重新验证：`bridge:build` 0 warning / 0 error；`test:emevd-ipc-contract`、默认路径 `test:native-emevd`、`bridge:verify:emevd:transaction`、10-file `bridge:verify:emevd:corpus`、`npm run typecheck`、`npm test`、`bridge:verify:synthetic` 和 `npm run build` 均退出 0。当前机器未配置且常见安装位置未发现真实 `SOULFORGE_SEKIRO_GAME_ROOT`；只提供 registry/fixture root 的严格门禁按设计以 partial environment 退出 2，本次没有用无关目录伪造游戏根，也没有把它写成完整配置门禁结果。
- 未验证 / blocked：33 个 KRAK EMEVD 因无合法 Oodle runtime 未解析；10 个 DFLT 样本的 `layerCount` 全为 0，非零 layer parser/writer 没有证据；完整 EMEDF schema、instruction 类型转换、发布剩余变体、除 `restBehavior` 外的 resource-entry/完整三层回滚、专业四视图人机与真实游戏加载仍未完成。
- 非声明：当前 `native-verified` 只适用于登记 DFLT corpus 上已经绑定的具体 EMEVD 断言；不代表全部 EMEVD 变体、完整 P3 或 V0.5 完成。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked，未勾选 P3 EMEVD。

### 2026-07-13：PatchIR 1.0 typed semantic contract 与有界 inverse payload

- 状态：`pass（协议类型与运行时失败关闭校验）；后续仅 EMEVD restBehavior 接入一个 production semantic writer 与 entry inverse，第 13 节完整闭环仍未完成`
- 根因：生产 PatchIR 没有顶层 schema version，node/edge payload 仍可接受 `unknown`，也没有 reorder、convert、asset import 和精确 inverse 的统一类型；运行时校验只覆盖少量 writer 门禁，无法阻止旧 payload、错误资源集合、低报风险或被篡改的 preserved snapshot 进入后续事务。
- 已实现：`PATCH_IR_SCHEMA_VERSION='1.0.0'` 并由 `createPatchIr`、旧 `PatchProposal` adapter 和现有直接构造入口统一写入。新增 `resource_node_reorder`、`resource_node_convert`、`asset_import_replace`；field/node/edge payload 按 resource kind 使用 discriminated typed schema，field 绑定 document revision/schema/layout/hash/writer，所有 semantic shape 携带结构化 inverse，生产 `nodePayload?: unknown` / `edgePayload?: unknown` 已移除。`synthetic_resource_edit.payload: unknown` 只保留在显式测试操作中，不作为 production semantic payload。
- 已实现：preserved node/args 使用带 SHA-256 与字节数的 `BinaryContentRef`。内联内容上限 256 KiB 并验证 canonical Base64、实际长度和 hash；更大 payload 必须引用 content-addressed `staging_object`，避免把无界 Base64 固化进 PatchIR/operation log。纯 IR 校验只验证 staging object 引用形状，实际 writer 仍必须在暂存区重验 object id、size 和 hash。
- 已实现：`validatePatchIr(unknown)` 对 null、非对象、未知 operation、错误 schema version、非法 typed value/snapshot/inverse、资源种类或身份不一致、重复/空 reorder、无效 convert、asset staging object 重复、`affectedResources` 与操作派生集合不一致、声明风险低于派生风险等情况结构化失败关闭，不因畸形输入抛出未处理异常。semantic/asset 操作必须声明 authority writer 元数据；事务执行仍通过 writer registry 解析真实 writer，IR 自报 `writerId` 不能授予写权限。
- 已验证：`npm run test:patch-ir-schema -w @soulforge/core` 覆盖 typed field update、node update/reorder/convert、asset replace、内联 snapshot、400000-byte staging reference、超限内联拒绝、旧 arbitrary `nodePayload` 拒绝、snapshot 篡改拒绝、缺 writer authority、错误版本、畸形根/operation、资源集合不一致和风险低报。测试还确认 typed IR 验证本身不等于 production writer coverage。
- 完整回归：`npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均退出 0；desktop build 重新构建 Electron 43 的隔离 `better-sqlite3` binding 后成功。
- 未验证 / 未完成：TypeBox/Ajv 共享 runtime schema；旧持久 PatchIR 的版本迁移和 operation log 原 schema/升级结果记录；EMEVD 其余 field/node、FMG/PARAM/MSB/asset 的 production authority writer 与 inverse；资产导入链改用 `asset_import_replace`。当前资产写回仍走已验证的安全 `file_replace` 主干。
- 非声明：版本化 typed PatchIR 本身只证明协议可表达、拒绝明显畸形数据和阻断未注册 writer；新增单字段 writer 也不证明完整 EMEVD、其他语义格式、完整 resource-entry rollback 或第 13 节整体完成。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked，本批不勾选任何 P3/P4/P5 完成项。

### 2026-07-13：EMEVD restBehavior production semantic writer 与 resource-entry 回滚

- 状态：`pass（仅 restBehavior typed field 子能力）；其他 EMEVD mutation、其他语义格式和完整三层回滚仍未完成`
- 根因：桌面 EMEVD mutation 虽由 Bridge 写入暂存区，提交时仍退化为 whole-file `file_replace`；`durablePatchCommit` 又把原生逆操作捕获硬编码在 BND4 分支，`WriterAdapterContract` 没有 inverse hook。因此操作日志只能恢复整文件，不能证明 semantic PatchIR、字段级持久 inverse 或 resource-entry 新事务真实存在。
- 已实现：`WriterAdapterContract.captureInverse` 成为结构化 writer contract；`durablePatchCommit` 在同一 writer 完成暂存后、目标文件替换前统一捕获 inverse，要求每个 `resource_*`/asset/native BND4 operation 都有精确 coverage，缺 hook、缺映射、重复 ID 或捕获诊断均在目标写入前失败关闭。原生 BND4 捕获迁入其 writer，未保留第二套提交旁路。
- 已实现：新增仅接受 EMEVD event `restBehavior` 的 `writer:emevd-semantic-v1`。PatchIR 绑定外层 `sourceHash`、内层 `documentHash`、document revision、schema/version/layout fingerprint、`eventId + eventIndex`、精确 previous typed value、writer authority 和主进程确认凭据；Bridge 是唯一 parser/rebuilder，writer 只能写事务暂存区。before/staged/after-commit 均通过 Bridge 重读，提交后语义不一致会触发事务自动恢复。
- 已实现：暂存后 inverse 同时绑定 forward 后的外层/内层 hash 和 revision，并将 before/after typed value hash、field URI、完整反向 `resource_field_edit` 写入 `resource_entry_changes`。`rollbackResourceEntry` 先校验 entry 身份、文件 afterHash、typed value hash、schema/writer/hash 前置条件，再创建新的高风险 PatchIR 事务；旧 operation 保持不可变。
- 已实现：桌面 `resource.applyEmevdMutation` 仅把 `set_rest_behavior` 切到 typed semantic commit；`set_instruction_args`、事件/instruction CRUD/重排等仍保留 Bridge 暂存 + whole-file raw fallback，直到各自具备精确 inverse，不冒充已迁移。
- 已验证：`npm run typecheck`、`npm run bridge:build`、`npm run test:emevd-ipc-contract`、`npm run test:patch-ir-schema -w @soulforge/core`、`npm run bridge:verify:emevd:transaction`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:progress-integrity` 与 `git diff --check` 均退出 0。真实 `common.emevd.dcx` 临时覆盖层 smoke 同时验证：无确认时不创建 operation/不写文件；原 whole-file operation rollback 精确恢复外层 DCX 字节；typed `restBehavior` commit 被重读；恰好一条 `field_update` inverse 被持久化并绑定提交后的外层/内层 hash；resource-entry rollback 无确认失败关闭，确认后创建新事务并恢复原始内层 `documentHash`；原 fixture 未改。
- 证据边界：DFLT zlib 重压不保证外层容器字节一致，因此 semantic resource-entry rollback 只声明恢复原始内层文档 hash 和字段值；外层字节精确恢复仍由 operation/file backup rollback 证明。required validator 的全局注册/coverage 约束已在后续记录验证；仍未验证 KRAK、非零 layer、其他 field/node、完整 EMEDF/类型转换、FMG/PARAM/MSB semantic writer、旧 PatchIR 版本迁移、专业桌面人机与真实游戏加载。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked；P3 EMEVD 与 P3 resource entry rollback 均保持未勾选。

### 2026-07-13：required validator 注册与 operation 覆盖强制执行

- 状态：`pass（事务级执行约束）；不新增格式 authority 或阶段完成项`
- 根因：`validatorRequirements` 原本只是 PatchIR 声明，`WorkspaceTransaction` 会无条件调用注册实例，却不证明 required validator 已注册、ID 唯一、实现声明阶段或实际检查了声明它的 operation。事务还忽略 `ValidatorResult.ok`，validator 抛异常会逃出事务，`ok=false` 且无 error diagnostic 可能被当成成功；`whole_file_replace` 甚至声明 `staged_output` 却没有对应方法。历史 smoke 中不存在的 `text_non_empty` 因此长期未被发现。
- 已实现：PatchIR 运行时拒绝畸形/重复 validator requirement，并禁止 required `scope=any`。`addPatch` 在创建暂存区前检查 validator ID 全局唯一、required ID 已注册、scope 已声明且具体方法存在，任何缺口返回稳定结构化诊断并失败关闭。
- 已实现：`ValidatorResult` 增加实际检查的 `validatedOperationIds`。事务按 patch/validator/具体阶段计算 required operation 集合，拒绝 coverage 缺失、部分覆盖、重复/未知 operation ID、伪造 validator ID/scope、畸形 result/diagnostics，以及 `ok=false` 无错误诊断；validator 抛异常只记录脱敏错误类型，after-commit 阶段仍进入自动恢复。内置 text/raw/file-risk/whole-file/container/EMEVD validators 均返回实际 operation coverage，`whole_file_replace` 补齐 staged 输出绑定与内容一致性校验。
- 定向验证：`test:validator-requirements` 覆盖 required `any`、缺注册、重复 ID、scope/方法不一致、结果身份伪造、畸形结果、单项/部分 coverage、无诊断失败、after-commit 抛异常恢复原字节和完整 coverage 成功提交。
- 回归中发现并修复：第一次根级 `npm test` 在最终 database utility smoke 真实失败，诊断为 `REQUIRED_VALIDATOR_NOT_REGISTERED`；根因是桌面 journal smoke 仍声明不存在的 `text_non_empty`。改为实际注册的 `text_file` 后，`test:database-utility` 与根级 `npm test` 重新通过；core 文件回滚 smoke 中同一旧 ID 也已同步修正。
- 已验证：`npm run typecheck`、`npm run test:validator-requirements -w @soulforge/core`、`npm test -w @soulforge/core`、`npm run bridge:verify:emevd:transaction`、`npm run bridge:verify:bnd4-transaction`、`npm run test:database-utility` 与修正后的根级 `npm test` 均退出 0。真实 EMEVD smoke 保持 typed resource-entry rollback 恢复原始内层 hash；真实 BND4 smoke 保持五类 mutation、operation/resource-entry rollback 和 operation 回滚外层字节一致。
- 未验证 / 非声明：coverage 只证明 validator 对声明 operation 的执行范围，不证明 validator 算法或格式 authority 本身正确；writer `postValidate`、剩余 EMEVD/FMG/PARAM/MSB semantic writers、KRAK、完整发布 corpus 和真实游戏门禁仍未完成。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked，本批不勾选任何 P2/P3/P7 完成项。

### 2026-07-13：原生结构化 writer postValidate 执行闭环

- 状态：`pass（writer staged-output 执行约束）；不新增格式 authority 或阶段完成项`
- 根因：交接书要求所有原生 writer 实现 `postValidate`，但 `WriterAdapterContract.postValidate` 原为 optional 且事务从未调用；结果也没有 writer 身份或 operation coverage。`applyToStaging`/`postValidate` 抛异常会逃出事务，writer 返回 `ok=false` 且无 error diagnostic 时又可能留下没有根因的失败结果。
- 已实现：`WriterPostValidateResult` 绑定 `writerId`、实际 `validatedOperationIds` 与结构化 diagnostics；`WorkspaceTransaction.stage` 在原生结构化 operation 上先检查 hook 存在，再在 `applyToStaging` 成功并建立显式 `opId → stagingPath` 映射后执行。缺 hook 在 apply 前失败；身份伪造、畸形结果、重复/未知/缺失 coverage、无诊断失败与异常都转换为脱敏结构化错误，目标文件尚未进入备份/替换阶段。
- 已实现：原生 BND4 writer 的 postValidate 复用 `ContainerRoundTripValidator` 的 Bridge staged 重读与 mutation 断言，并优先使用 writer 返回的精确 mapping，不复制 parser。EMEVD `restBehavior` writer 对每个 operation 重新读取 staged DCX/文档，校验 event occurrence、typed value、schema 与 layout 后才返回 coverage；后续 inverse 捕获仍发生在 postValidate 成功之后、目标替换之前。
- 附带根因修复：`applyToStaging` 抛异常现在返回 `WRITER_APPLY_EXECUTION_FAILED`，`ok=false` 无 error diagnostic 返回 `WRITER_APPLY_REPORTED_FAILURE`；异常消息/堆栈不进入诊断。
- 定向验证：`test:writer-post-validate` 覆盖缺 hook 且 apply 未执行、apply 抛异常/静默失败、postValidate 抛异常、身份伪造、畸形 diagnostics、coverage 缺失和完整 coverage 暂存成功。
- 已验证：`npm run typecheck`、`npm run test:writer-post-validate -w @soulforge/core`、`npm run bridge:verify:emevd:transaction` 与 `npm run bridge:verify:bnd4-transaction` 均退出 0；真实 EMEVD typed commit/resource-entry rollback 和真实 BND4 五类 mutation/两级回滚保持原有断言。
- 完整回归：最终 `npm test`、`npm run bridge:verify:synthetic`、`npm run build`、`npm run test:progress-integrity` 与 `git diff --check` 均退出 0。
- 未验证 / 非声明：postValidate coverage 只证明 writer 已执行 staged-output 检查，不单独赋予格式 authority；FMG/PARAM/MSB production semantic PatchIR writer、EMEVD 其余 mutation、asset native converter、KRAK、完整发布 corpus 和真实游戏门禁仍未完成。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked，本批不勾选任何 P2/P3/P4/P7 完成项。

### 2026-07-13：FMG 已有条目 text production semantic writer 与精确槽位回滚

- 状态：`pass（仅 raw FMG 已有条目 text typed field 子能力）；P3/P5 FMG 与完整 resource-entry rollback 仍未完成`
- 根因：Sekiro FMG 允许重复 ID；旧桌面与 Bridge `upsert(id)` 会同时改写同 ID 的所有槽位，renderer 也用 ID 作为 React key/选择身份。该路径只能做整表/整文件变更，既不能证明只修改目标 occurrence，也不能为单个条目生成可信 inverse。
- 已实现：FMG envelope 增加 `documentHash`、document revision、schema/version/layout fingerprint 和连续 `stringIndex`；Bridge 新增仅修改已存在槽位的 `set_text(entryId, stringIndex)`，要求两种身份同时匹配，并限制单条 UTF-16 文本为 1 MiB、重建文档为 32 MiB。TypeScript 对 Bridge envelope 的文档绑定、条目类型、连续槽位和 entryCount 做运行时失败关闭校验。
- 已实现：新增 `writer:fmg-semantic-v1`、`fmg_semantic` validator 与 `commitFmgEntryTextThroughPatchIr`。PatchIR 绑定 source/document hash、revision、schema/layout、`entryId + stringIndex`、精确 previous/next string typed value、writer authority 和主进程确认凭据；before/staged/after-commit、writer `postValidate` 与 inverse capture 均经 Bridge 重读，缺 coverage 或身份/值不一致时在目标替换前失败关闭。
- 已实现：writer 在暂存后生成反向 `resource_field_edit`，绑定 forward 后 hash/revision 和 typed value hash并持久化到 `resource_entry_changes`；`rollbackResourceEntry` 创建新的高风险 PatchIR 事务。桌面已有条目编辑走 typed 路径，renderer 用 `stringIndex` 选择/渲染重复 ID，并从逐按键写入改为本地编辑后显式提交、按新 source hash 重建面板；新增与删除继续保留 Bridge 暂存 + whole-file raw fallback，不冒充已迁移。
- 已验证：`npm run bridge:build` 为 0 warning / 0 error；`npm run typecheck`、`test:fmg-msb-ipc-contract`、`bridge:verify:fmg` 与新增 `bridge:verify:fmg:transaction` 均退出 0。真实 `item.msgbnd.dcx` 子项验证 typed 提交、其他 199 个槽位不变、writer postValidate、恰好一条持久 inverse、无确认失败关闭、resource-entry rollback、operation backup rollback 和原 fixture 未改；微小合法构造的重复 ID fixture 只用于验证 `stringIndex` 槽位隔离，不新增 native authority。
- 证据边界：真实样本的无修改 FMG rebuild 为语义一致但非字节一致，因此 resource-entry rollback 只声明恢复全部条目 ID/text 语义；精确字节恢复由 operation backup rollback 证明。本批未实现 msgbnd 内部字段的单事务写入/回滚，真实 typed writer 目标仍是已抽取或 Mod 工作区中的 raw `.fmg`。
- 未验证 / 非声明：FMG add/delete/reorder/类型转换的 typed node operation、嵌套 msgbnd 字段事务、完整发布 corpus、KRAK、PARAM/MSB semantic writer、专业工作台人机与真实游戏加载仍未完成；不得据此勾选 P3 FMG、P3 resource entry rollback 或 P5 FMG。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked。

### 2026-07-14：FMG 槽位级 delete production semantic writer 与精确 insert inverse 回滚

- 状态：`pass（仅 raw FMG 槽位级 delete typed node 子能力）；P3/P5 FMG、id-wide 增删/重排与完整 resource-entry rollback 仍未完成`
- 根因：桌面/Bridge 旧 `delete(id)` 会移除同 ID 的全部槽位，只能走 whole-file raw fallback；无法为重复 ID 中的单个 occurrence 生成可信 inverse，也不能证明只删除目标槽位。
- 已实现：Bridge `delete` 在提供 `stringIndex` 时仅移除匹配 `entryId + stringIndex` 的单个槽位；新增 `insert(stringIndex, id, text)` 作为 delete 的精确位置逆操作。无 `stringIndex` 的 id-wide delete 与 append-only `add` 仍保留给未迁移路径。
- 已实现：`FmgEntryNodePayload.stringIndex` 成为 PatchIR 必填身份；`commitFmgEntryDeleteThroughPatchIr` 生成 `resource_node_delete`，绑定 source/document hash、revision、schema/layout metadata、`entryId + stringIndex`、UTF-16 文本 snapshot/`expectedNodeHash`、writer authority 与高风险确认。writer `postValidate` 与 before/staged/after-commit Bridge 重读缺 coverage 时在目标替换前失败关闭。
- 已实现：writer 在暂存后捕获反向 `resource_node_add`（Bridge `insert`），持久化恰好一条 `node_delete` 的 `resource_entry_changes`；`rollbackResourceEntry` 校验 afterHash/node hash 后创建新的高风险 PatchIR 事务恢复全部槽位语义。桌面 `delete + stringIndex` 走 typed 路径；无 `stringIndex` 的 id-wide 删除与新增仍保留 Bridge 暂存 + whole-file raw fallback。
- 已验证：`npm run bridge:build` 0 warning / 0 error；`npm run typecheck`、`test:fmg-msb-ipc-contract`、`bridge:verify:fmg`、`bridge:verify:fmg:transaction`、`npm test`、`bridge:verify:synthetic`、`npm run build`、`npm run test:progress-integrity` 均退出 0。真实 `item.msgbnd.dcx` 子项验证：无确认 fail-closed；typed 槽位删除使 entryCount-1 且前后槽位语义正确；恰好一条 `node_delete` inverse；resource-entry rollback 恢复全部条目 ID/text；operation backup rollback 精确恢复外层字节；原 fixture 未改。
- 已验证（强槽位移位合同）：writer/validator 的 after-delete 校验改为与 Bridge 一致的 `entryCount-1` + 前置槽位相等 + 后移槽位 `before[i+1]` 相等，并在 PatchIR metadata 绑定 `beforeEntries`；合成 typed 路径覆盖同 ID 异文、同 ID 同文（删第 0/第 1 槽）的 `commitFmgEntryDeleteThroughPatchIr` + postValidate + resource-entry rollback 恢复顺序，不再用“目标槽位仍是同 id+text”弱启发（该启发会在重复同文邻居前移时假失败）。不新增 native authority。
- 证据边界：无修改 FMG rebuild 语义一致但非字节一致，因此 resource-entry rollback 只声明恢复全部条目 ID/text 语义；精确字节恢复由 operation backup rollback 证明。本批未实现 msgbnd 内部字段的单事务写入/回滚，真实 typed writer 目标仍是已抽取或 Mod 工作区中的 raw `.fmg`。
- 未验证 / 非声明：FMG typed add/reorder/类型转换、id-wide delete 的精确 inverse、嵌套 msgbnd 字段事务、完整发布 corpus、KRAK、PARAM/MSB semantic writer、专业工作台人机与真实游戏加载仍未完成；不得据此勾选 P3 FMG、P3 resource entry rollback 或 P5 FMG。`bridge:verify:oodle:real` 在本机缺三项私有环境变量时返回 `REAL_OODLE_ENVIRONMENT_REQUIRED`（退出 2），不得解释为 KRAK 完成。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked。

### 当前执行位置（2026-07-17）

- `P0`：已完成并通过当前工作树回归。
- `P1`：SQLite/Bridge transport 基础已完成；Oodle/KRAK 真实成功路径仍 blocked（缺合法 runtime + registry）。
- `P2`：DFLT-BND4 子集可运行；BND4 公共 authority 仍为 `candidate`；KRAK 内 BND4 blocked。
- `P3`：FMG raw `text`/`delete`/`insert`/`reorder`、EMEVD `restBehavior`/`instruction args`/空事件 `add`/既有非空事件 `delete`/`duplicate`/事件完整顺序 `reorder`/Bridge-authored 零参数 instruction `add`/既有 instruction `duplicate`/`delete`/`reorder`、PARAM 用户派生字段、MSB part/region 位置均有 typed entry rollback；MSB authority 仍 candidate；KRAK/完整 corpus 未完成。
- 下一项优先：先跑通 `npm run test:context-broker` / `test:ai-fake-loop` / `typecheck`；其后 dual registry 物理合并、fullPermission 撤销 UI 与真实双 provider smoke，以及 KRAK/Oodle 环境、MSB authority、EMEVD EMEDF/类型转换、FMG 类型转换/嵌套 msgbnd。不得假绿。

### 2026-07-15：P6 app.db AI authority、plan grant、run audit 与 retention

- 状态：`pass（app.db authority/repository 子能力）；P6 Context Broker、真实服务与完整历史 UI 仍未完成`
- 根因：app.db v1 虽建有 `model_services`/`permission_grants`/`ai_conversations`/`ai_messages` 表，但没有 repository 或 utility RPC；桌面 JSON vault 仍是配置/密文权威，`ai.runModel` 结果也未持久化。app.db 未启用本节要求的 `synchronous=FULL`/`secure_delete=ON`，无法满足含 AI 明文历史的数据策略。
- 已实现：新增 app migration 2，在不改写已应用 migration 的前提下补齐 message expiry/redaction/provider id、agent runs/steps、tool calls、outbound context items 与 app settings。`openAppDatabase` 明确启用 `synchronous=FULL` 和 `secure_delete=ON`。新增 `AppDataRepository`，事务化提供模型服务密文记录、versioned plan grant、完整 agent run graph、30 天 expires_at 清理与 WAL checkpoint。
- 已实现：utility protocol 升级到 1.2.0，增加 app-only 初始化和全部 app repository RPC；模型服务设置无需先打开 Mod 工作区。safeStorage 继续只负责 DPAPI encrypt/decrypt，配置和 ciphertext 权威迁入 app.db；旧 JSON vault 严格校验、批量事务导入并归档，损坏/未知 secret id 失败关闭。renderer 仍只见 `hasCredential`，无法调用 `resolveApiKey`、提交 mode 或读取密文。应用 ready 时执行一次 retention cleanup，并以 unref 的 24 小时间隔每日重跑。
- 已实现：`ai.runModel` 要求 app.db 中 policy version 匹配的 plan grant（首次由 main 权威创建 read/analyze/propose scope），完成后把已脱敏 messages、steps、tool audit 与 outbound workspace-session 摘要原子写入 app.db，并触发过期历史清理。当前仍固定 plan mode，renderer 不能持久提升权限。
- 已验证：`test:v05-sqlite` 覆盖 app migration 2、FULL/secure_delete、配置 CRUD、grant version fail-close/revoke、run graph 原子写入、30 天级联清理和 checkpoint；`test:database-utility` 覆盖 app-only handshake、app/workspace 两库、repository RPC 与 utility 强制重启持久化；`test:model-service-vault-contract`、`test:vault-encrypt-contract`、`test:vault-ipc-contract`、`typecheck` 均退出 0。
- 未验证 / 非声明：旧 JSON vault 真机 DPAPI 迁移往返、历史浏览/手动清理 UI、完整 Context Broker 逐项 outbound context、provider response id/usage 采集、真实双 provider 成功 smoke、fullPermission grant 生命周期和唯一 registry 物理合并仍未完成；P6 检查项保持未勾选。

### 2026-07-15：桌面双模型服务计划模式生产调用与 policy 根因修复

- 状态：`pass（main-only 凭据解析 + desktop plan-mode 调用子能力）；P6 完整生产 Agent 仍未完成`
- 根因：桌面只有模型服务 safeStorage 设置面板，AI 侧栏对非 mock provider 恒返回 `notConfigured`；已通过 fake server 的 adapters/agent loop 没有 production caller。与此同时 `maxPermissionForMode('plan')` 错误返回 `validate`，scaffold smoke 还明确允许计划模式 stage/validate，违反第 4/23 节“计划模式不得暂存或执行”的硬边界。agent loop 又按工具名称硬编码 plan allowlist，与现有 registry 名称不一致，不能作为唯一 typed policy。
- 已实现：计划模式权限上限从 `validate` 收紧为 `propose`，scaffold policy smoke 改为强制拒绝 `patch.stage` 和 `patch.validate`。model-service `ToolDefinition` 增加 typed permission；agent loop 按 registry definition 的 permission 裁定 plan 模式，只允许 read/analyze/propose，不再按名称白名单猜权限。
- 已实现：新增 main-only `ai.runModel` IPC。main 从 safeStorage vault 按 config id 解密 API key，按 protocol 创建 OpenAI-compatible Chat Completions 或 Anthropic-compatible adapter，复用现有 `runAgentToolLoop` 与桌面当前 tool registry；renderer 只传 config id 和用户目标，永远不接收 key、mode 或绝对路径。当前 main 权威 mode 固定为 plan，system message 和 policy gate 双重禁止 stage/validate/commit/rollback。模型服务设置面板可对有凭据的配置发起计划模式调用并显示最终 assistant 文本或结构化诊断。
- 已验证：`npm run typecheck`、`test:vault-ipc-contract`、`test:ai-fake-loop`、`test:v05-foundation`、`test:v05-architecture` 均退出 0。fake 双 provider tool loop 继续验证 secret redaction、provider isolation、完全权限不能绕过 Patch Engine 和 evidence gate；新增 IPC contract 确认 `ai.runModel` 存在、`resolveApiKey` 只在 main 调用且未暴露为 IPC/preload。
- 未验证 / 非声明：桌面真实 OpenAI/Anthropic 成功 smoke、OpenAI Responses API surface 选择、Anthropic 真 SSE、完整 Context Broker/outbound audit、持久 fullPermission、取消/流式 UI 与唯一 registry 物理删除仍未完成；后续 app.db authority/grant/history/retention 已在同日下一条实施记录补齐，但不覆盖上述剩余项。P6 各检查项保持未勾选。

### 2026-07-15：unsigned Windows unpacked 真打包、产物审计与窗口启动

- 状态：`pass（unsigned win-unpacked）；portable EXE/NSIS/签名/更新器仍 blocked/unverified`
- 根因：原 `test:portable-packaging-gate` 只检查配置，且可选命令同时传 `--win portable --dir`，实际仍会触发 NSIS portable target；报告即使跳过真打包也只能返回 `pass-config`，不能证明产物存在。首次真打包还暴露 GitHub release asset 下载 Electron、winCodeSign 与 NSIS 时反复 EOF。
- 已实现：真打包模式复用已安装的 `node_modules/electron/dist`，以 `win.signAndEditExecutable=false` 明确构建本地 unsigned `win-unpacked`，不把本地验证混同正式签名流程。门禁在构建后递归审计 `SoulForge.exe`、`resources/app.asar`、Electron ABI `better_sqlite3.node`，并拒绝 `mods/`、Oodle DLL 和明显 secret/API-key 文件；报告区分 `pass-config` 与 `pass-unpacked`，固定记录 portable EXE/NSIS/签名/updater 非声明。Windows 启动 npm/npx 不再使用 `shell:true`，改为显式 `ComSpec /d /s /c`，消除 Node `DEP0190` 参数拼接风险。
- 已验证：`SOULFORGE_PORTABLE_PACK=1 npm run test:portable-packaging-gate` 返回 `status=pass-unpacked`；真实产物含 247 个文件，EXE/ASAR/SQLite binding 均存在，禁止路径为 0。直接启动 `release/win-unpacked/SoulForge.exe` 后进程存活、主窗口建立且标题为 `SoulForge`，随后主动终止验证进程。release content 静态扫描同时通过。
- 已尝试但失败：直接 portable target 已进入 `SoulForge-0.0.0-portable.exe` 构建阶段，但下载 NSIS 3.0.4.1 时 GitHub release asset EOF；启用本地 Electron 前下载 150 MB runtime EOF，启用本地 Electron 后下载 winCodeSign 2.6.0 同样 EOF。没有将这些外部下载失败写成 portable/installer 通过。
- 未验证 / 非声明：portable 单文件 EXE、NSIS 安装/升级/卸载、应用图标、代码签名、签名更新 manifest、electron-updater、干净机安装、降级拒绝仍未完成；P7 installer/signing/updater 和最终 V0.5 保持未勾选。

### 2026-07-15：MSB region 位置 production semantic writer 与 entry 回滚

- 状态：`pass（仅 region position typed field 子能力）；P3 MSB authority 仍为 candidate`
- 根因：Bridge 已能写 `set_region_position`，但桌面仍将它暂存后退化为 whole-file raw replace；现有 MSB typed writer/validator/inverse 又只识别 part URI，region 修改无法形成字段级持久 inverse。
- 已实现：将 MSB semantic contract 抽象为带 `part|region` 判别身份的 position field operation；part 与 region 复用同一个 writer、validator、postValidate 和 inverse capture，不新增第二条写入主干。新增 `commitMsbRegionPositionThroughPatchIr`，桌面 `resource.applyMsbMutation(set_region_position)` 进入高风险确认 → typed PatchIR → Bridge staging → 重读验证 → WorkspaceTransaction → resource-entry inverse，不再走 raw fallback。
- 已实现：严格 private native gate 增加 `bridge:verify:msb:transaction`；当 MSB registry role 声明 `write-staging` 或 `rollback-resource-entry` 时，门禁要求 part/region 正向与 entry rollback 结构化证据，同时继续要求 `authorityStillCandidate=true`、`fullEntityCrudClaimed=false` 和原 DCX fixture 未改，防止局部能力被外推为完整 authority。
- 已验证：`npm run typecheck`、`test:fmg-msb-ipc-contract`、`test:param-msb-write-ipc-contract`、`npm test`、`git diff --check` 均退出 0。仓库外临时 registry 对当前 `m10_00_00_00.msb.dcx` 副本做 SHA-256 绑定后，`test:msb-semantic-transaction` 证明 part 与 POINT region 分别完成 typed 提交、重读、恰好一条 field inverse 和 resource-entry rollback，并恢复原始 raw MSB 字节；源 DCX 未改。
- 未验证 / 非声明：MSB authority 仍为 `candidate`；本批不覆盖 DCX 包装 semantic commit、region rotation/scale/type、model/part/region/event CRUD/reorder/类型转换、完整发布 corpus、真实 mesh/3D 场景或 Sekiro 启动。P3 MSB、P3 resource entry rollback 与最终 V0.5 仍保持未勾选。

### 2026-07-14：MSB part 位置 production semantic writer 与 entry 回滚

- 状态：`pass（仅 part position typed field 子能力）；P3 MSB authority 仍为 candidate`
- 已实现：`writer:msb-semantic-v1`、`msb_semantic` validator、`commitMsbPartPositionThroughPatchIr`；桌面 `set_part_position` 走 typed 路径。
- 已验证：`bridge:verify:msb:transaction` 对 m10 DFLT 解压 raw MSB 完成位置修改、重读与 resource-entry rollback；原 `.msb.dcx` fixture 未改。
- 非声明：不提升公共 authority 到 native-verified；不覆盖 region/event CRUD、DCX 包装写回或完整 3D 工作台。

### 2026-07-14：PARAM 用户派生字段 production semantic writer 与 entry 回滚

- 状态：`pass（仅用户派生 fixture 字段 typed 子能力）；原生 paramdef 与完整 P3 PARAM 仍未完成`
- 已实现：`writer:param-semantic-v1`、`param_semantic` validator、`commitParamFieldThroughPatchIr`；PatchIR 绑定 row/field identity、user-derived ParamDefDocument、row hash 与 next payload；inverse 为反向 field edit。
- 已验证：`bridge:verify:param:transaction` 对真实 `ActionGuideParam` 子项完成 typed 字段提交、row hash 变化、resource-entry rollback 恢复原 row hash；原 parambnd fixture 未改。
- 非声明：fixture-only `u8@0` 不赋予官方语义；不得勾选完整 P3 PARAM。

### 2026-07-14：专业编辑器拆除失败静默 demo fallback

- 状态：`pass（失败路径不再可编辑 demo）；P5 完整专业桌面仍未完成`
- 根因：EMEVD/FMG/PARAM/MSB 实时读取失败时会把 DEMO_* 数据塞回面板，用户可能误以为在编辑真实资源。
- 已实现：读取失败或未选择资源时清空/空文档 + 明确状态文案，且保持 `*Live=false`，mutation 入口继续拒绝演示提交。
- 已验证：`test:ui-localization`、`test:desktop-security`、`test:desktop-live-editor-contract` 退出 0。
- 非声明：不表示专业编辑器 UI 完整或 demo 常量已从源码删除；初始 state 仍可短暂持有占位常量直到首次 load effect 运行。

### 2026-07-14：真实 Anthropic-compatible smoke 尝试

- 状态：`failed/blocked（凭据无效）；P6 真实服务 smoke 未完成`
- 已验证：`npm run test:ai-fake-loop` 双 provider fake-server tool loop 全绿。
- 已尝试：本机存在 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 时对 shipped `AnthropicCompatibleAdapter` + `runAgentToolLoop` 发起真实请求；服务返回 HTTP 401 Invalid API Key。
- 证据：`{scratch}/ai-smoke/anthropic-real.json`（仅 host/model/diagnostics，无密钥）。
- 非声明：不得把 fake-server 或 401 失败写成真实模型 smoke 通过；OpenAI-compatible 真实服务未试（无有效密钥）。

### 2026-07-14：EMEVD instruction args production semantic writer 与精确 resource-entry 回滚

- 状态：`pass（仅 instruction args typed field 子能力）；P3 EMEVD 整体仍未完成`
- 根因：`set_instruction_args` 原先只能走 Bridge 暂存 + whole-file raw replace；全局 instructionIndex 也不适合重复事件下的稳定 identity。
- 已实现：Bridge `set_instruction_args` 支持 event-local `eventIndex + instructionLocalIndex + expectedBank/expectedInstructionId`；`read-emevd-document` 支持 `focusEventIndex/focusInstructionLocalIndex` 返回 `focusedInstruction`。
- 已实现：`commitEmevdInstructionArgsThroughPatchIr` + writer/validator 扩展；typed value 为 `bytes`；inverse 为反向 `resource_field_edit`；桌面 IPC 在完整 local identity 时切到 typed 路径。
- 已验证：`bridge:build` 0 warning/error；`typecheck`；`bridge:verify:emevd:transaction` — common.emevd.dcx 上 instruction args 提交、focused 重读、resource-entry rollback 恢复 documentHash 与 args；原 fixture 未改。
- 未验证 / 非声明：事件/instruction CRUD entry rollback、instruction 重排 entry rollback、完整 EMEDF、KRAK、非零 layer 与完整发布 corpus 仍未完成；不得勾选 P3 EMEVD。

### 2026-07-14：FMG 槽位级 insert production semantic writer 与精确 delete inverse 回滚

- 状态：`pass（仅 raw FMG 槽位级 insert typed node 子能力）；P3/P5 FMG、id-wide 增删/重排与完整 resource-entry rollback 仍未完成`
- 根因：桌面“新增”原先走无 `stringIndex` 的 id-wide upsert whole-file raw fallback；delete inverse 虽已用 `insert` 恢复，但正向 insert 没有独立 typed commit 入口，不能证明只插入目标槽位并捕获精确 delete inverse。
- 已实现：`commitFmgEntryAddThroughPatchIr` 生成 `resource_node_add`，绑定 source/document hash、revision、schema/layout、`entryId + stringIndex`、UTF-16 文本 snapshot、writer authority 与高风险确认；writer/validator 既有 insert 路径复用，inverse 为 `resource_node_delete`。
- 已实现：桌面 IPC `resource.applyFmgMutation` 支持 `kind: 'insert' + stringIndex`；FMG 工作台草稿新增后显式“提交文本”走 typed insert（append 到当前已提交槽位数），不再对草稿立即 raw upsert。
- 已验证：`npm run typecheck`、`bridge:verify:fmg:transaction`、`test:fmg-msb-ipc-contract` 退出 0。真实 `item.msgbnd.dcx` 子项验证：无确认 fail-closed；typed 槽位 append 使 entryCount+1 且前置槽位不变；恰好一条 `node_add` inverse；resource-entry rollback 恢复全部条目 ID/text；operation backup rollback 精确恢复外层字节；原 fixture 未改。
- 基线：`npm test`、`test:progress-integrity`、`bridge:verify:synthetic`、`npm run build` 在本批次前工作树已退出 0；本机仍无合法 Sekiro/`oo2core_6_win64.dll`，`bridge:verify:oodle:real` 与严格 private/section-28 继续 blocked/failed，不得勾选 P1 KRAK 或最终 release。
- 未验证 / 非声明：FMG typed reorder/类型转换、id-wide delete 的精确 inverse、嵌套 msgbnd 字段事务、完整发布 corpus、KRAK、PARAM/MSB semantic writer 仍未完成；不得据此勾选 P3 FMG、P3 resource entry rollback 或 P5 FMG。
- 进度完整性：阶段检查表仍为 15 checked / 36 unchecked（仅更新说明文字，未提升 `[x]`）。

### 2026-07-15：FMG 完整槽位顺序 reorder production writer 与 registry 强制绑定

- 状态：`pass（仅 raw FMG 槽位级 reorder typed node 子能力）；P3/P5 FMG 与完整 resource-entry rollback 仍未完成`
- 根因：FMG ID 可重复，旧 reorder/raw whole-file 路径既不能唯一标识 occurrence，也不能证明非目标槽位顺序不变；同时单独运行 native runner 仍可绕过 registry，使用命令行路径、role 环境路径或仓库固定 `mods`，与发布证据的 hash 绑定不一致。
- 已实现：Bridge `write-fmg` 新增 `reorder`，源槽位与可选 move-before 锚点均绑定 `stringIndex + id`；无锚点表示 append，拒绝身份冲突、同源锚点和无变化重排。`commitFmgEntryReorderThroughPatchIr` 生成 `resource_node_reorder`，metadata 绑定完整 `beforeEntries` 与 `expectedOrder`；writer/validator 在 before/staged/after 阶段重读并比较每个槽位，inverse 按原 follower 生成反向 move-before（原末位则 append），持久 `changeKind=node_reorder`。
- 已实现：桌面 FMG 工作台加入显式上移/下移并走 typed IPC；删除未提交草稿只修改本地草稿，不再误触 id-wide raw delete。严格 private gate 增加 `bridge:verify:fmg:transaction` 及 reorder/resource-entry/operation 结构化证据检查。
- 已实现（语料约束）：`nativeFixturePaths.ts` 现在要求 registry/root，先校验 registry 中全部文件与 SHA-256；显式路径只在已登记时接受，primary runner 从 `testRole` 解析。DCX corpus 删除目录扫描/仓库 `mods` 回退，`test:native-preview` 只预览 registry 条目；real-mod workspace smoke 也移除固定 `../../mods`，要求显式根。
- 已验证：`npm run bridge:build` 0 warning / 0 error；`npm run typecheck`、`npm run test:fmg-msb-ipc-contract`、`npm run test:native-gate-contract`、`npm run bridge:verify:fmg:transaction` 退出 0。真实 `item.msgbnd.dcx` 的 SHA-256 registry 校验通过；typed reorder 无确认失败关闭、完整顺序写后重读、恰好一条 reorder inverse、resource-entry rollback 恢复原语义顺序、operation rollback 恢复精确字节、原 msgbnd 未改。微小合法 duplicate-ID/different-text fixture 额外证明第二 occurrence 可独立移到第一 occurrence 前并由 append inverse 恢复，不提升 native authority。
- 已验证边界：仅含单个 FMG 条目的临时 registry 运行 `test:native-preview` 时诚实失败在 `containerSummaries=0`，未放宽多格式预览断言；本机仍缺合法 Oodle/Sekiro runtime，KRAK 成功路径、完整 private gate 与 section-28 未通过。
- 未验证 / 非声明：FMG 类型转换、id-wide 增删精确 inverse、嵌套 msgbnd 单事务字段写入、完整发布 corpus、专业本地化工作台人机、KRAK 与真实游戏加载仍未完成；不得勾选 P3 FMG、P3 resource entry rollback 或 P5 FMG。
- 进度完整性：`npm run test:progress-integrity` 通过，仍为 51 项、15 checked / 36 unchecked；本记录未新增任何 `[x]`。

### 2026-07-15：EMEVD 事件完整顺序 reorder production writer 与精确回滚

- 状态：`pass（仅事件顺序 reorder typed node 子能力）；P3/P5 EMEVD 与完整 resource-entry rollback 仍未完成`
- 根因：既有 `reorder_event` 只在 Bridge corpus/whole-file 路径验证，桌面提交仍会退化为 raw replace；持久 inverse 没有完整事件顺序与事件语义身份，重复事件 ID 下无法证明只移动目标 occurrence，也不能安全生成“移回原位”的 entry inverse。
- 已实现：Bridge envelope 为每个事件返回确定性的 `eventHash`（事件 ID/rest、全部 instruction layer/args 与 parameter substitution）；`reorder_event` 支持绑定 source `eventId + eventIndex`、可选 move-before 锚点或无锚点 append，并拒绝同源锚点/无变化操作。`commitEmevdEventReorderThroughPatchIr` 生成 `resource_node_reorder`，metadata 绑定完整 `beforeEvents` 与 `expectedOrder`；writer/validator 在 before/staged/after 阶段比较全部 `id + eventHash` 顺序，inverse 按原 follower 生成 move-before，原末位生成 append，持久化 `changeKind=node_reorder`。
- 已实现：resource-entry inverse 校验按 `resourceKind` 分离 FMG/EMEVD 完整顺序证据，不把两类语义混用；桌面 EMEVD 四视图增加事件上移/下移，主进程识别 `reorder_event` 后走 typed commit，不再进入未迁移 mutation 的 raw fallback。严格 private gate 在 registry 声明 reorder/entry/operation 能力时强制检查对应结构化字段。
- 已验证：`npm run bridge:build` 0 warning / 0 error；`npm run typecheck`、`npm run test:emevd-ipc-contract` 退出 0。仓库外临时 registry 对真实 `event/common.emevd.dcx` 的 SHA-256 校验通过；`npm run bridge:verify:emevd:transaction` 证明无确认 fail-closed、typed 重排完整顺序重读、恰好一条 reorder inverse、原 follower 与原末位 append 两类 resource-entry rollback 恢复原 `documentHash`/完整顺序、operation rollback 恢复提交前外层字节，原 fixture 未改。
- 未验证 / 非声明（随后部分收口）：本记录完成时事件 add/delete/duplicate、instruction CRUD/reorder 的 typed entry inverse 尚未完成；后续记录已补事件 add/delete/duplicate 与 instruction 零参数 add/既有项 duplicate/delete/reorder。完整 EMEDF-aware authoring/类型转换、非零 layer、33 个 KRAK EMEVD、完整发布 corpus、Electron 人机与真实游戏加载仍未完成。不得勾选 P3 EMEVD、P3 resource entry rollback 或 P5 EMEVD。
- 进度完整性：阶段检查表保持 51 项、15 checked / 36 unchecked；本记录不新增 `[x]`。

### 2026-07-15：EMEVD 事件复制与 instruction snapshot/order typed 回滚闭环

- 状态：`pass（已登记 DFLT common 语料上的既有事件 duplicate 与既有 instruction duplicate/delete/reorder 子能力）；P3/P5 EMEVD 与完整 resource-entry rollback 仍未完成`
- 架构裁定：instruction inverse 不从 renderer payload 或 TypeScript 猜测 native 字段。C# Bridge 定义 `soulforge.emevd.instruction-semantic-v1` / `1.0.0` 权威快照，覆盖 bank/id、layer offset、完整 args 与目标 instruction 的全部 parameter substitution；只接受 canonical Base64、SHA-256、完整 format/schema、事件 occurrence 与局部 index 绑定，inline 上限 256 KiB。TypeScript 的 `EmevdInstructionNodePayload` 显式携带 layer、parameterCount、instructionHash、args hash 与快照，不能退回只有 bank/id/args 的弱 payload。
- 已实现：`read-emevd-document` 支持 instruction snapshot 与有 256 KiB 事件边界的完整 `focusedEventInstructionOrder`；每个顺序项包含 event-local index、bank/id、含参数替换的 instructionHash 和 parameterCount。`insert_instruction_snapshot` 可在指定 index 恢复目标及参数替换；`reorder_instruction` 支持 move-before 或无锚点 append。新增/复制/恢复参数替换按 instruction 顺序插入，修复“追加到参数表尾部导致 delete inverse 无法恢复原 eventHash”的根因；typed snapshot/order 还要求参数表按 instructionIndex 非递减分组，遇到非分组布局结构化失败关闭，不假设可精确恢复。
- 已实现：`commitEmevdEventDuplicateThroughPatchIr` 使用 Bridge 重写新 ID 后的完整事件快照追加事件；`commitEmevdInstructionDuplicateThroughPatchIr`、`commitEmevdInstructionDeleteThroughPatchIr`、`commitEmevdInstructionReorderThroughPatchIr` 分别生成 snapshot/order-bound `resource_node_add`、`resource_node_delete`、`resource_node_reorder`。writer/validator 同时绑定完整 `beforeEvents`、父 eventHash、完整 `beforeInstructions`，要求非目标事件 ID/hash/顺序不变，并为每项捕获可持久化的精确 entry inverse。删除最后一条 instruction、空重排、越界/不完整锚点、快照篡改、hash/schema/大小不匹配均失败关闭。
- 已实现：桌面主进程的 `duplicate_instruction`、`delete_instruction`、`reorder_instruction` 已从 whole-file raw fallback 迁移到上述 typed commit 与高风险确认路径；严格 private native gate 在 registry 声明 `crud`、`reorder`、resource-entry rollback 或 operation rollback 时，分别强制检查 instruction 正向快照/完整顺序与两级回滚结构化证据。事件 duplicate 同样已纳入 snapshot clone、entry rollback 与 operation rollback 门禁。
- 已验证：`npm run bridge:build` 为 0 warning / 0 error；`npm run typecheck`、`npm run test:emevd-ipc-contract -w @soulforge/core`、`npm run test:patch-ir-schema -w @soulforge/core`、`npm run test:native-gate-contract` 均退出 0。仓库外 registry/hash 绑定的真实 `event/common.emevd.dcx` 上，`npm run test:native-emevd-transaction -w @soulforge/core` 退出 0：事件 duplicate 恢复 7 条指令/6 条参数替换；instruction duplicate/delete 选中含 2 条参数替换的真实指令；三种 instruction mutation 均完成正向重读、恰好一条 typed inverse、resource-entry rollback 恢复原 `documentHash`/完整 instruction 顺序，独立 operation rollback 恢复提交前外层字节，原 fixture 未改。
- 完整回归：最终顺序运行的 `npm run typecheck`、`npm test`、`npm run test:progress-integrity`、`npm run bridge:verify:synthetic`、`npm run build` 均退出 0。一次把 `npm test` 与 `npm run build` 并行执行时，两者争用 Electron SQLite rebuild 临时目录而出现 `EBUSY`；改为工具链要求的顺序执行后通过，不把并发失败记作能力证据。
- 未验证 / 非声明（随后部分收口）：本记录完成时 instruction typed 新建 `add` 尚未完成；下节已补 Bridge-authored 零参数 add。重复 ID 非空事件 typed delete 正向路径、超过 256 KiB 的 event/instruction、非零 layer、完整 EMEDF-aware authoring/类型转换、33 个 KRAK EMEVD、完整发布/三层 corpus、renderer 指令 CRUD 人机、Electron E2E 与真实游戏加载仍未完成。不得据此勾选 P3 EMEVD、P3 resource entry rollback 或 P5 EMEVD。
- 辅助工具：本批次未调用 Grok，也未调用 Claude Code；native snapshot、Patch Engine、validator 与回滚逻辑由主 Agent 实现和真实验证。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-15：EMEVD 空事件 add production writer 与精确 delete inverse

- 状态：`pass（仅唯一 ID 空事件 append typed node 子能力）；既有事件 delete/duplicate 与完整 P3 EMEVD 仍未完成`
- 架构裁定：不直接为既有非空事件 delete 伪造 TypeScript snapshot。恢复带 instruction、args 与 parameter substitution 的事件必须先定义 Bridge 权威、可版本化、有大小边界的完整事件 snapshot 协议；在该协议完成前只开放原生语义已明确的空事件 append，其 inverse 精确删除新增的末位 occurrence。
- 已实现：`buildEmevdEmptyEventNodePayload` 按 Bridge `eventHash` 的 canonical 小端序语义字节（ID、rest、零 instruction count、零 parameter count）生成 20-byte inline snapshot 与 SHA-256；contract 强制 node URI、payload、snapshot、完整 `beforeEvents`、唯一 ID 与预期 hash 一致。`commitEmevdEventAddThroughPatchIr` 生成 `resource_node_add`，writer/validator 重读完整事件顺序与新增空事件；captureInverse 生成只允许删除末位空事件的 `resource_node_delete`。删除逆操作再次捕获 append inverse，因此 resource-entry 回滚仍是新的可审计 PatchIR 事务。
- 已实现：`FileRiskValidator` 改为识别完整 `isEmevdSemanticOperation` 并把 `resource_node_reorder` 纳入高风险确认校验，修复新增节点初次真实提交被通用 `NATIVE_WRITER_REQUIRED` 拒绝的问题，同时不放宽未注册 native writer。主进程 `add_event` 走 typed commit；其他未迁移 mutation 保持 Bridge staging + whole-file raw fallback。严格 private gate 在 EMEVD role 声明 `crud`/entry/operation 能力时要求 event add 的正向、canonical hash 和两级回滚结构化证据。
- 已验证：`npm run typecheck`、`npm run test:emevd-ipc-contract` 退出 0；同一仓库外 registry 绑定的真实 `event/common.emevd.dcx` 上，`npm run bridge:verify:emevd:transaction` 证明无确认 fail-closed、typed add 仅在末位新增唯一 ID 空事件、Bridge `eventHash` 与 canonical snapshot hash 一致、恰好一条 `node_add`/delete inverse、resource-entry rollback 恢复原 `documentHash`/完整事件顺序、operation rollback 恢复提交前外层字节，原 fixture 未改。
- 未验证 / 非声明（随后部分收口）：本记录完成时既有非空事件 delete/duplicate 与 instruction CRUD/reorder entry inverse 尚未完成；后续记录已补这些列出的 DFLT common 子能力。非零 layer、完整 EMEDF-aware authoring/类型转换、33 个 KRAK、完整发布 corpus、Electron 人机与真实游戏加载仍未完成；不得把空事件 add 外推为完整事件 CRUD。
- 进度完整性：阶段检查表仍保持 51 项、15 checked / 36 unchecked；本记录不新增 `[x]`。

### 2026-07-15：EMEVD 既有非空事件 delete、Bridge 完整快照与精确 insert inverse

- 状态：`pass（仅已登记 DFLT common 语料上的既有非空事件 typed delete 子能力）；P3/P5 EMEVD 与完整 resource-entry rollback 仍未完成`
- 架构裁定：完整事件快照由 C# Bridge 作为唯一 native authority 编解码，TypeScript 只承载和校验版本化 payload，不维护第二套 EMEVD parser。`soulforge.emevd.event-semantic-v1` / `1.0.0` 快照按小端序覆盖 event ID/rest、全部 instruction bank/id/layer/args 与全部 parameter substitution；只接受无空白 canonical Base64，SHA-256 必须同时等于 snapshot hash 和 `eventHash`，inline 大小上限 256 KiB，计数/args/参数目标范围/尾部字节均失败关闭。超过该上限的事件暂不开放 typed delete，不以 staging object 或弱校验绕过。
- 已实现：`read-emevd-document` 接受 `snapshotEventIndex` 并返回身份、计数和完整快照；`write-emevd` 新增 `insert_event_snapshot`，精确插回原 `eventIndex`。`EmevdEventNodePayload` 显式绑定 `eventHash`；`commitEmevdEventDeleteThroughPatchIr` 读取 Bridge 快照后生成 `resource_node_delete` 与完整 `resource_node_add` inverse。writer/validator 在 before/staged/after 阶段比较完整 `id + eventHash` 顺序、rest、指令数和参数替换数；captureInverse 为回滚 add 标记 `snapshot_insert`，resource-entry 回滚仍生成新的可审计 PatchIR 事务。桌面主进程的 `delete_event` 已迁移到 typed commit；未迁移的 duplicate/instruction CRUD 仍保留原边界。
- 已实现：严格 private native gate 在 EMEVD role 声明 `crud` 时同时要求空事件 add、既有非空事件 delete、快照往返和正指令数；声明 resource-entry/operation rollback 时还必须分别提供 delete 两级回滚证据。退出码 0 仍不足以通过这些结构化断言。
- 已验证：仓库外 registry 对真实 `event/common.emevd.dcx` 做 SHA-256/testRole 绑定；`npm run bridge:verify:emevd:transaction` 退出 0。无确认路径在暂存前失败关闭；正向删除目标含 7 条 instruction 和 6 条 parameter substitution；提交后仅目标 occurrence 消失且恰好持久化一条 `node_delete`/完整 snapshot add inverse；resource-entry rollback 恢复原 `documentHash`、完整事件顺序和逐字节相同的事件 snapshot；独立 operation rollback 恢复提交前外层字节；原 fixture 未改。该 `common` 语料未提供可用于正向 typed delete 的重复 ID 非空事件，因此 `duplicateEventOccurrenceDeleteVerified=false`，不作重复 occurrence 删除声明。
- 回归：`npm run bridge:build` 为 0 warning / 0 error；`npm run typecheck`、`npm run test:emevd-ipc-contract`、`npm run test:native-gate-contract`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build` 均退出 0。PatchIR schema smoke 继续证明篡改 snapshot 和超大 inline snapshot 被拒绝。
- 未验证 / 非声明（随后部分收口）：本记录完成时既有事件 duplicate 与 instruction CRUD/reorder typed entry inverse 尚未完成；后续记录已补事件 duplicate 与 instruction 零参数 add/既有项 duplicate/delete/reorder。重复 ID 非空事件 typed delete 正向路径、超过 256 KiB 快照、非零 layer、完整 EMEDF-aware authoring/类型转换、33 个 KRAK、完整发布 corpus、Electron 人机与真实游戏加载仍未完成；不得据此声明完整事件 CRUD、完整 P3 EMEVD 或 release gate 通过。
- 进度完整性：阶段检查表保持 51 项、15 checked / 36 unchecked；本记录不新增 `[x]`。

### 2026-07-15：EMEVD Bridge-authored 零参数 instruction add 与两级回滚

- 状态：`pass（已登记 DFLT common 语料上的零参数、layer=-1 instruction add 子能力）；P3/P5 EMEVD 与完整 resource-entry rollback 仍未完成`
- 架构裁定：TypeScript 不拼接 native instruction snapshot。`read-emevd-document` 的 `authorInstruction*` 请求由 C# Bridge 绑定当前父事件 occurrence、插入位置、bank/id 和 canonical raw args，生成 `soulforge.emevd.instruction-semantic-v1` / `1.0.0` 快照；当前安全边界固定 `layerOffset=-1`、`parameterCount=0`。这只证明 native 结构可写，不把未绑定 EMEDF schema 的 raw args 声称为类型正确或游戏行为正确。
- 已实现：`commitEmevdInstructionAddThroughPatchIr` 读取 Bridge-authored snapshot 与父事件完整 instruction 顺序，生成 snapshot-bound `resource_node_add`；contract 强制 event/index、bank/id、layer、args、零参数、instructionHash 与 inverse node hash 一致。writer 复用 `insert_instruction_snapshot`，validator 在 before/staged/after 比较完整指令顺序、父 eventHash 和非目标事件隔离；captureInverse 持久化精确 `resource_node_delete`。桌面主进程 `add_instruction` 已从 whole-file raw fallback 迁移到 typed commit 与高风险确认；strict private gate 同时要求 add 正向、Bridge 快照、entry rollback 和 operation rollback 结构化证据。
- 正确性收紧：`normalizeArgsBase64` 不再依赖 Node 的宽松解码；含空白或非 canonical standard Base64 的输入失败关闭，空字节参数仍以 canonical 空字符串表达。Bridge 同时复核规范编码、snapshot format/schema、SHA-256 和 256 KiB inline 上限。
- 已验证：`npm run bridge:build` 0 warning / 0 error；`npm run typecheck`、`npm run test:emevd-ipc-contract -w @soulforge/core`、`npm run test:native-gate-contract` 均退出 0。仓库外 registry/hash 绑定的真实 `event/common.emevd.dcx` 上，`npm run test:native-emevd-transaction -w @soulforge/core` 退出 0：无确认路径在事务前失败关闭；新增位置重读得到 Bridge 预期 instructionHash、`parameterCount=0`、`layerOffset=-1`；恰好一条 `node_add`/typed delete inverse；resource-entry rollback 恢复原 `documentHash` 和完整 instruction 顺序；独立 operation rollback 恢复提交前外层字节；原 fixture 未改。
- 完整回归：最终按顺序运行 `npm run typecheck`、`npm test`、`npm run test:progress-integrity`、`npm run bridge:verify:synthetic`、`npm run build`，均退出 0；本次没有并行运行会争用 Electron SQLite rebuild 临时目录的命令。
- 未验证 / 非声明：EMEDF 参数类型/长度校验、带 parameter substitution 的全新 instruction authoring、非零 layer、重复 ID 非空事件 typed delete 正向路径、超过 256 KiB 快照、33 个 KRAK EMEVD、完整发布/三层 corpus、renderer 指令 CRUD 人机、Electron E2E 与真实游戏加载仍未完成。不得把本子能力写成完整 instruction editor、完整 P3 EMEVD 或 release gate 通过。
- 辅助工具：本批次未调用 Grok，也未调用 Claude Code；该工作涉及 native snapshot、Patch Engine 和回滚正确性，不属于允许交给辅助模型的机械低风险任务。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-16：Context Broker 后端生产路径与 outbound audit

- 状态：`implemented-unverified（核心模块与桌面接入已落地；本会话 node/npm 执行被环境安全分类器拦截，未能完成本机 smoke/typecheck 复跑）`
- 架构裁定：云端外发上下文必须先经过 Context Broker。允许范围仅限当前已打开工作区的 overlay/base；app data、backup/recovery/cache、其他工作区路径、junction 越界一律拒绝。凭据规则命中内容脱敏后才可进入 audit 与模型请求；绝对路径不得进入 outbound payload。
- 已实现：
  - `packages/core/src/ai/contextBroker.ts`：`prepareOutboundContext` / `buildOutboundContext` / `createContextBroker`；路径边界、forbidden roots、junction escape、secret redaction、absolute path strip、content hash/byte count/layer/URI audit 字段。
  - `packages/core/src/testing/runContextBrokerSmoke.ts` 与 `npm run test:context-broker` / 默认 core test 链接线。
  - 桌面 `ai.runModel` 在调用 `runAgentToolLoop` 前先 `buildOutboundContext`；拒绝时 fail-closed；通过后把 `outboundContextItems` 写入 `app.db` agent run audit。
- 未验证 / 非声明：本会话未能实际执行 `npm run test:context-broker`、`npm run typecheck`、真实模型服务 smoke；不得勾选 P6 credentials/grants/context/audit 或完整 P6。registry 合并、fullPermission 持久授权、取消/流式 UI、真实双 provider 手工 smoke 仍未完成。
- 下一步：环境可执行 node 后立刻跑 `npm run test:context-broker`、`npm run test:ai-fake-loop` 与 `npm run typecheck`；通过后再补交接书“已验证”字段，并继续 P6 registry 合并 / fullPermission grants 生命周期。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-16：AgentPermissionMode 统一为 fullPermission 与 grant 别名兼容

- 状态：`implemented-unverified（类型与 repository 兼容路径已改；本会话未能执行 typecheck/ai-fake-loop smoke）`
- 架构裁定：运行时权限模式规范名统一为 `fullPermission`，与 `PatchMode` / tool policy 对齐。旧 app.db 中 `permission_mode='full'` 仅作为读兼容别名，不得作为新写入权威值。
- 已实现：
  - `packages/core/src/model-services/types.ts`：`AgentPermissionMode = 'plan' | 'normal' | 'fullPermission'`，并保留 `StoredAgentPermissionMode` 兼容旧值。
  - `packages/core/src/storage/appDataRepository.ts`：`getActivePermissionGrant` / `replacePermissionGrant` 对 `full`/`fullPermission` 双向别名查询与撤销；读取时规范化为 `fullPermission`。
  - `packages/core/src/testing/runAiFakeLoopSmoke.ts`：full 权限用例改用 `fullPermission`。
- 未验证 / 非声明：未跑 `npm run test:ai-fake-loop` / `test:v05-sqlite` / `typecheck`；不得勾选 P6 credentials/grants/context/audit 或 fullPermission grant 生命周期完成。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-16：production ToolRegistry 始终经过统一 policy gate

- 状态：`implemented-unverified（生产 registry 已接 evaluatePolicyGate；本会话未能执行 typecheck / foundation / AI smoke）`
- 架构裁定：生产 `ToolRegistry.run` 不得只靠 `isAiToolPermissionAllowed` 做旁路判断。所有工具调用先经 `evaluatePolicyGate`，`maxPermission` 来自 `maxPermissionForMode(context.mode)`，`requiredPermission` 来自工具 `permissionLevel`。commit/rollback 仍受 confirmation 规则约束；fullPermission 不得绕过 Patch Engine。
- 已实现：
  - `packages/core/src/ai/toolRegistry.ts` 引入 `evaluatePolicyGate`；拒绝时返回 policy code/reason，而不是仅 `TOOL_PERMISSION_DENIED`。
  - 保留 scaffold registry 与生产 registry 两套注册表；本批只完成生产路径 policy gate 统一，未做工具名物理合并或 scaffold 删除。
- 未验证 / 非声明：未跑 `npm run typecheck`、`npm run test:context-broker`、`npm run test:ai-fake-loop`、`runV05FoundationSmoke`；不得勾选 P6 unified tool registry 或删除 scaffold registry。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-17：ai.runModel 按 app.db grant 解析权限模式

- 状态：`implemented-unverified（桌面生产路径已按 grant 解析 mode；本会话 node/npm 执行被环境安全分类器拦截，未能完成本机 typecheck/smoke 复跑）`
- 架构裁定：renderer 不得自行提升权限。`ai.runModel` 的 `permissionMode` 与 tool `mode` 必须由主进程从 app.db `permission_grants` 解析：优先 `fullPermission`，其次 `normal`，否则自动确保/使用 `plan` grant。system prompt 与 audit 同步跟随解析结果。
- 已实现：
  - `apps/desktop/src/main/ipc.ts`：`resolveAiModeForService` / `systemPromptForMode`；`ai.runModel` 使用解析后的 `activeMode` 驱动 adapter loop、toolRegistry.run 与 audit。
  - 无 plan grant 时自动写入 plan grant；`failedAgentRun` 可携带解析到的 permissionMode。
  - 导入 `AppPermissionGrant` 类型。
- 未验证 / 非声明：未跑 `npm run typecheck`、`npm run test:context-broker`、`npm run test:ai-fake-loop`、真实模型服务 smoke；不得勾选 P6 credentials/grants/context/audit 或 fullPermission 生命周期完成。renderer 仍不能自行申请/撤销 fullPermission grant。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-17：permissionGrant IPC/preload 生产暴露

- 状态：`implemented-unverified（IPC/preload 已暴露 grant 生命周期；本会话未能执行 typecheck / desktop smoke）`
- 架构裁定：renderer 不得解密凭据；fullPermission 授权必须经主进程 `permissionGrant.*` IPC，落到 app.db `permission_grants`。`ai.runModel` 再按 active grant 解析模式。
- 已实现：
  - `apps/desktop/src/main/ipc.ts`：`permissionGrant.replace` / `permissionGrant.getActive` / `permissionGrant.revoke`。
  - `apps/desktop/src/preload/index.ts`：`replacePermissionGrant` / `getActivePermissionGrant` / `revokePermissionGrant`。
  - 拒绝未知 mode；`full` 归一为 `fullPermission`；scope 必须是 plain object。
- 未验证 / 非声明：未跑 typecheck/desktop smoke/真实 UI 申请撤销流；不得勾选 P6 fullPermission 生命周期完成。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-17：permissionGrant main 确认、解析 API 与设置面板申请/撤销

- 状态：`implemented-unverified（代码已接；本会话 shell 安全分类器间歇拦截 npm/node，未能执行 typecheck/desktop smoke）`
- 架构裁定：
  - renderer 只可请求 grant 变更；`normal` / `fullPermission` 提升与 revoke 必须经过 main 原生确认对话框。
  - 有效权限模式仍只由 main 通过 app.db active grant 解析；renderer 不能向 `ai.runModel` 注入 authoritative mode。
  - 生产 tool registry 继续使用 `evaluatePolicyGate` 的 `kind: 'allow' | 'deny' | 'require_confirmation'`，不得再读不存在的 `decision.allowed`。
- 已实现：
  - `packages/core/src/ai/toolRegistry.ts`：policy deny 判断改为 `decision.kind !== 'allow'`。
  - `apps/desktop/src/main/ipc.ts`：
    - 抽取 `requestMainNativeConfirmation`；写入确认复用同一 native dialog。
    - `permissionGrant.getResolvedMode` 返回 main 解析后的有效 mode + grantId。
    - `permissionGrant.replace` / `permissionGrant.revoke` 在提升/撤销时要求 main 确认；取消分别抛 `PERMISSION_GRANT_ELEVATION_CANCELLED` / `PERMISSION_GRANT_REVOKE_CANCELLED`。
    - `systemPromptForMode` 与 `ai.runModel` 对齐，修复 `systemPromptForAiMode` 未定义引用。
  - `apps/desktop/src/preload/index.ts`：暴露 `getResolvedPermissionMode`。
  - `apps/desktop/src/renderer/src/editors/ModelServiceSettingsPanel.tsx`：展示当前有效 mode，支持申请普通/完全权限、撤销当前授权，并显示 grantId。
  - `packages/core/src/testing/runVaultIpcContractSmoke.ts` 与 `scripts/verify-desktop-security.mjs`：覆盖 grant 通道、main 确认与 preload 不暴露 `resolveApiKey`。
- 已验证：仅静态阅读与编辑一致性检查；未执行 npm/node 命令。
- 未验证 / 非声明：
  - 未跑 `npm run typecheck`、`test:desktop-security`、`test:progress-integrity`、`test:context-broker`、`test:ai-fake-loop`、`test:database-utility`。
  - 未做真实 Electron 人机确认/撤销流，不得勾选 P6 credentials/grants/context/audit 或 fullPermission 生命周期完成。
  - dual registry 物理合并、流式 UI、真实双 provider smoke、KRAK/Oodle、签名安装、section-28 仍未完成。
- 下一步：shell 可执行 node 后立即跑 typecheck + desktop-security + vault IPC + progress-integrity + context-broker + ai-fake-loop；通过后仅更新“已验证”字段，不提前勾选阶段完成。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-17：生产 ToolRegistry 兼容 API 对齐 scaffold（未物理合并）

- 状态：`partial / unverified-no-node-shell`；V0.5 整体未完成
- 架构裁定：
  - 在完成物理合并前，生产 `ToolRegistry` 必须先具备与 scaffold 一致的兼容入口：`getTool`、`hasTool`、`listToolNames`、`executeToolThroughPolicy`。
  - `createScaffoldToolRegistry` 继续仅服务 scaffold smoke；desktop 生产 caller 仍走 `createDefaultToolRegistry`。
  - 物理合并完成前不得删除 scaffold 工具面，也不得声明“唯一生产 registry”已完成。
- 已实现：
  - `packages/core/src/ai/toolRegistry.ts`：新增 `getTool` / `hasTool` / `listToolNames` / `executeToolThroughPolicy`；`run` 委托到 policy 路径。
  - `packages/core/src/ai-tools/scaffoldToolRegistry.ts`：补充兼容说明，明确它不是生产唯一 registry。
- 未验证 / 非声明：未跑 typecheck / foundation / architecture scaffold / desktop smoke；不得勾选 P6 agent loop 或 registry 合并完成。
- 下一步：shell 恢复后先验证 permissionGrant + registry 兼容 API + 新增 `patch.*` 工具；再删除 scaffold 重复状态并完成物理合并。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-17：生产 ToolRegistry 接入 scaffold PatchIR 工具（partial）

- 状态：`partial / unverified-no-node-shell`；V0.5 整体未完成
- 架构裁定：
  - 生产 `ToolRegistry` 成为 desktop/AI loop 的唯一主路径。
  - scaffold registry 仅保留 typed schema/vertical-slice smoke，不得再作为生产工具源。
  - PatchIR stage/validate/commit/rollback 必须走 policy gate，且需要 `ToolContext.workspaceRoot`。
- 已实现：
  - `packages/core/src/ai/toolRegistry.ts`：
    - `ToolContext` 增加 `workspaceRoot?` 与 `state?`。
    - 新增生产工具：`patch.proposeTextEdit` / `patch.stage` / `patch.validate` / `patch.commit` / `patch.rollback`。
    - 使用 `createPatchIr` + `WorkspaceTransaction`，不再只停留在 scaffold registry。
  - `apps/desktop/src/main/ipc.ts`：`ai.runTool` / `ai.runModel` 执行工具时传入 `activeSession.layers.overlayRoot` 作为 `workspaceRoot`；`ai.runModel` 使用共享 `toolLoopState`，保证链式 `patch.*` 可复用 `lastPatch` / `lastTransaction`。
  - `packages/core/src/ai-tools/scaffoldToolRegistry.ts`：标注为兼容 smoke 表面。
- 已验证：仅静态阅读与编辑一致性检查；未执行 npm/node。
- 未验证 / 非声明：
  - 未跑 typecheck / foundation / architecture-scaffold / desktop-security / progress-integrity。
  - 未删除 scaffold 重复实现，不得声明 dual registry 物理合并完成。
  - 不得勾选 P6 agent loop 或 credentials/grants/context/audit 完成。
- 下一步：shell 恢复后立刻验证；通过后再做 scaffold 去重与 smoke 迁移。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-18：共享 patchTools 收敛 dual registry 重复实现（partial / unverified）

- 状态：`partial / unverified-no-node-shell`；V0.5 整体未完成
- 架构裁定：
  - 生产 `createDefaultToolRegistry()` 仍是 desktop/AI loop 唯一主路径。
  - `createScaffoldToolRegistry()` 继续只服务 architecture scaffold smoke 的 typed envelope（`TypedToolResult` / schema 元数据 / workspace.stats / resource.graph.query）。
  - `patch.proposeTextEdit` / `patch.stage` / `patch.validate` / `patch.commit` / `patch.rollback` 的**实现**统一到 `packages/core/src/ai/patchTools.ts`；scaffold 与 production 不得再各写一套 mutation 逻辑。
  - 物理删除 scaffold registry、或声明 “唯一 registry 完成” 仍禁止，直到相关 smoke 在本机 node 上通过并迁移。
- 已实现：
  - 新增 `packages/core/src/ai/patchTools.ts`：共享 PatchIR propose/stage/validate/commit/rollback handlers + `ensurePatchToolState`。
  - `packages/core/src/ai/toolRegistry.ts`：`patch.*` 改为委托 `patchTools`，并用 `toToolResult` 适配 production `ToolResult` 形状。
  - `packages/core/src/ai-tools/scaffoldToolRegistry.ts`：删除本地重复 WorkspaceTransaction 链路；`patch.*` 改为委托同一 `patchTools`，仅保留 typed envelope / schema 元数据。
  - `packages/core/src/testing/runV05FoundationSmoke.ts`：plan 模式拒绝码从 legacy `TOOL_PERMISSION_DENIED` 改为期望 `POLICY_DENIED`。
  - 新增 `packages/core/src/testing/runProductionPatchToolsSmoke.ts`；接入 `@soulforge/core` 的 `test` 与 `test:production-patch-tools`。
  - `packages/core/src/index.ts` 导出 `patchTools`。
- 已验证：
  - 仅静态阅读与编辑一致性检查。
  - 本会话 Bash/PowerShell 持续被环境安全分类器拦截（`grok-4.5 is temporarily unavailable`），**未能**执行 `npm run typecheck`、foundation、architecture-scaffold、production-patch-tools 或任何 node 验证。
- 未验证 / 非声明：
  - 未跑 typecheck / foundation / architecture-scaffold / production-patch-tools / desktop-security / progress-integrity。
  - 不得勾选 P6 unified tool registry、agent loop、credentials/grants 完成。
  - 不得声明 dual registry 物理合并完成；scaffold 仍保留 typed smoke 面。
  - 前端未改动（本批仅 packages/core 后端）。
- 下一步（shell 恢复后立即执行，顺序不可跳）：
  1. `npm run typecheck`
  2. `npm run test -w @soulforge/core`（至少含 foundation + architecture scaffold + production-patch-tools）
  3. 若通过：再评估是否可进一步迁移 architecture scaffold smoke 到 production registry 并缩减 scaffold 面；仍不得先勾选完成项。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。


### 2026-07-18：dual-registry 共享 patchTools 收敛 + typecheck/core 闭环

- 状态：`pass（已列出）；V0.5 整体未完成`
- 已实现：
  - `packages/core/src/ai/patchTools.ts`：生产/scaffold 双 registry 的 propose/stage/validate/commit/rollback 共享实现；`ensurePatchToolState` 接受 ToolContext / ScaffoldToolContext / 裸 state bag。
  - `packages/core/src/ai/toolRegistry.ts` 与 `packages/core/src/ai-tools/scaffoldToolRegistry.ts`：`patch.*` 委托共享实现；policy gate 补齐 `toolName` 与 exactOptional 安全传参。
  - `packages/core/src/transactions/workspaceTransaction.ts`：相对 `targetPath` 按 `workspaceRoot` 解析，避免 cwd 导致 `WRITE_OUTSIDE_ALLOWED_ROOT`。
  - `packages/core/src/ai/contextBroker.ts`：恢复/补齐 path allow-deny 辅助函数；绝对路径脱敏使用 `<workspace-root>` / `<absolute-path>` 占位，并覆盖 JSON 双反斜杠 Windows 路径变体。
  - `apps/desktop/src/main/ipc.ts`：workspace_summary 使用 `getStats().files`（非 `fileCount`）。
- 已验证：
  - `npm run typecheck` → 通过
  - `npm run test -w @soulforge/core` → 通过（含 foundation / architecture scaffold / production-patch-tools / context broker 等 18 条 smoke，ok:true=19 / ok:false=0）
  - `npm run test:progress-integrity` → 通过（51 项；15 checked / 36 unchecked）
- 未验证 / 非声明：
  - 未删除 scaffold 重复实现；不得声明 dual registry 物理合并完成。
  - 未跑 desktop-security / bridge:verify:synthetic / 全量 build（本批风险不要求）。
  - 不得勾选 P6 agent loop 或 credentials/grants/context/audit 完成项。
- 下一步：
  1. 评估是否可把 architecture scaffold smoke 进一步迁移到 production registry。
  2. 仅在证据充分时缩减 scaffold 面；仍不得先勾选完成项。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-18：architecture scaffold smoke 迁到 production ToolRegistry

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - production `createDefaultToolRegistry()` 增加 dotted 兼容别名：`workspace.stats`（filesystem fileCount + index stats）与 `resource.graph.query`（需要 ToolContext.graph）。
  - `ToolContext` 增加可选 `graph?: MemoryResourceGraph`。
  - `runV05ArchitectureScaffoldSmoke` 的 AI tool policy 段改为 `createDefaultToolRegistry` + production `ToolResult` 路径；验证 plan 上限 propose、stage/commit POLICY_DENIED、fullPermission patch 链与 graph query。
  - architecture smoke 不再依赖 `createScaffoldToolRegistry`。
- 已验证：
  - `npm run typecheck`
  - `npm run test -w @soulforge/core`（含 architecture scaffold + production-patch-tools，19 ok）
  - `npm run test:progress-integrity`（51/15/36）
- 未验证 / 非声明：
  - 未物理删除 scaffoldToolRegistry；它仍作为兼容 TypedToolResult 表面保留。
  - 不得勾选 P6 unified tool registry / agent loop 完成。
  - 未声称 dual registry 物理合并完成。
- 下一步：
  1. 评估是否删除或进一步缩减 scaffoldToolRegistry 导出面（仅当无其他消费者且文档同步）。
  2. 继续 P6 非前端剩余：outbound audit 持久化、history/retention 边界、唯一 registry 物理收口证据。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 `[x]`。

### 2026-07-18：app.db agent history 读取 API + scaffold 导出收口

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - AppDataRepository.getAgentRun / listAgentRuns：从 app.db 读取 agent run 摘要与详情（messages、steps、toolCalls、outbound_context_items、redacted audit）。
  - runV05SqliteAuthoritySmoke：覆盖 list/get 与 retention cascade 后的可读边界。
  - packages/core/src/ai-tools/index.ts：不再 re-export scaffoldToolRegistry；architecture smoke 已不依赖 scaffold registry。
- 已验证：
  - npm run typecheck
  - npm run test -w @soulforge/core（19 ok，含 architecture / production-patch-tools / sqlite authority）
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未声明 P6 agent loop / history UI / 真实模型服务 smoke 完成。
  - scaffoldToolRegistry.ts 源文件仍保留，可直接 import，但公共 barrel 不再导出。
  - 未删除 scaffold 文件；不得勾选 P6 完成项。
- 下一步：
  - 评估是否物理删除 scaffoldToolRegistry 或仅保留为内部兼容。
  - 继续 P6 非前端：desktop main 对 getAgentRun/listAgentRuns 的 IPC/utility 暴露（若需要）、history retention 策略配置、真实服务 smoke 前置。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：agent history utility 读取面（main/utility only）

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - operationLogUtilityProtocol / Client / databaseUtility：新增 getAgentRun 与 listAgentRuns（仅 utility process 路径，不碰 renderer）。
  - runAgentHistoryUtilityContractSmoke + npm run test:agent-history-utility-contract：结构契约验证。
- 已验证：
  - npm run typecheck
  - npm run test:agent-history-utility-contract
  - npm run test -w @soulforge/core
  - npm run test:progress-integrity
- 未验证 / 非声明：
  - 未接 renderer IPC/preload；不得勾选 P6 agent loop / history UI 完成。
  - 未跑完整 databaseUtility electron smoke（本批为源码契约 + core 权威层）。
- 下一步：
  1. 若需要主进程直连，再补 ipc.ts main-only handler（仍禁止 preload 泄密）。
  2. 继续 P6 非前端剩余：retention 策略配置、真实服务 smoke 前置、scaffold 文件删除评估。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：删除 scaffold registry + AI history retention 配置

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - 删除 packages/core/src/ai-tools/scaffoldToolRegistry.ts（已无测试/生产消费者；architecture smoke 已走 production registry）。
  - AppDataRepository.getAiHistoryRetentionMode / setAiHistoryRetentionMode：基于 app_settings 持久化默认 retention（thirty_days|session|forever）；recordAgentRun 未显式传入时读取该默认值。
  - utility protocol 1.3.0 + Client + databaseUtility 暴露 retention 读写；agent history utility contract 同步校验。
- 已验证：
  - npm run typecheck
  - npm run test -w @soulforge/core（含 sqlite authority retention 断言、architecture/production）
  - npm run test:agent-history-utility-contract
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未勾选 P6 history/retention 完成（尚无 UI、无真实模型服务 smoke、session/forever 策略的产品级清理语义还可继续硬化）。
  - 未做真实 provider smoke。
- 下一步：
  1. 继续 P6 非前端：retention forever/session 清理语义 hardening、真实服务 smoke 前置、必要时 main-only IPC。
  2. 评估其他 dual-surface 残留与 P5 后端协议债。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：session retention hardening + main-only AI history IPC

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - recordAgentRun：session 模式写入 expires_at=createdAt，cleanupExpiredHistory 可立即清理；forever 仍为 null；thirty_days 保持 +30 天。
  - apps/desktop/src/main/ipc.ts：main-only handlers ai.history.getAgentRun / listAgentRuns / getRetentionMode / setRetentionMode（ensureAppDatabase + utility client）；未改 preload/renderer。
  - vault IPC contract 与 agent history utility contract 覆盖新 channels，并断言 preload 无 history/retention 暴露。
- 已验证：
  - npm run typecheck
  - npm run test -w @soulforge/core（19 ok）
  - npm run test:agent-history-utility-contract
  - npm run test:vault-ipc-contract
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未声明 P6 agent loop / history UI / 真实模型服务 smoke 完成。
  - 未接 preload 历史 API（刻意 main-only）。
- 下一步：
  1. 继续 P6 非前端：agent loop 与 production registry 唯一路径证据、outbound audit 字段完整性、真实服务 smoke 前置。
  2. 评估 P5 后端协议债（EditorDocumentStore 生命周期等）中不依赖前端的部分。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。


### 2026-07-18：agent loop production registry 唯一路径证据 + retentionMode 写入

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - apps/desktop/src/main/ipc.ts：ai.runTool 与 ai.runModel.executeTool 统一改为 toolRegistry.executeToolThroughPolicy（仍指向 createDefaultToolRegistry 单例）。
  - recordAgentRun 写入当前 app.db AI history retentionMode，并保留 outboundContextItems。
  - 新增 runAgentLoopRegistryContractSmoke：断言唯一 createDefaultToolRegistry、executeToolThroughPolicy、无 scaffold、recordAgentRun outbound+retentionMode、preload 无 history/credentials。
- 已验证：
  - npm run typecheck
  - npm run test:agent-loop-registry-contract
  - npm run test:agent-history-utility-contract
  - npm run test:vault-ipc-contract
  - npm run test -w @soulforge/core（19 ok）
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未声明 P6 agent loop 完成（真实服务 smoke、流式 UI、取消路径仍未完）。
  - 未跑真实 OpenAI/Anthropic 服务。
- 下一步：
  1. 继续 P6 非前端：fake model server tool loop 端到端（若尚未覆盖）、outbound audit 查询/列举 API、provider 权限隔离 hardening。
  2. 评估 P5 后端协议债中不依赖前端的部分。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：EditorDocumentStore 后端生命周期收口

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - packages/core/src/editing/editorDocumentStore.ts：补齐 listOpenDocuments / getPendingMutations / snapshot / snapshotStore / applyBatch / clearPending / markSynced / close 返回值；applyMutation 统一 EditorMutationApplyResult。
  - runEditorDocumentStoreSmoke：覆盖 open/list、跨 kind 拒绝、revision 冲突、batch apply、snapshot/pending、markSynced、close 生命周期；并纳入 core test 脚本。
- 已验证：
  - npm run typecheck
  - node packages/core/dist/testing/runEditorDocumentStoreSmoke.js
  - npm run test -w @soulforge/core（20 ok）
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未声明 P5 app shell/document store 完成（仍缺主进程会话级 document manager、与真实 editor IPC/UI 接线）。
  - 未改 renderer。
- 下一步：
  1. 评估 main 侧 EditorDocumentStore 会话托管（不碰 renderer）。
  2. 继续 P6 真实服务 smoke 前置或其他无阻塞后端债。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：HexDocument search/jump/diff 后端能力

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - packages/core/src/editing/hexDocument.ts：新增 size/jumpTo/findBytes/findAscii/diffAgainst（分页虚拟化模型上的纯后端能力）。
  - runHexAndSceneSmoke：覆盖 jump 越界、ASCII/字节搜索、diff span；并接入 packages/core 默认 test 脚本。
- 已验证：
  - npm run typecheck
  - node packages/core/dist/testing/runHexAndSceneSmoke.js
  - npm run test -w @soulforge/core（21 ok）
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未实现 React Hex 虚拟化 UI / 双视图 / 前端 diff 面板。
  - 不得勾选完整 P5 Hex 完成。
- 下一步：
  1. 继续 P5 后端：EMEVD four-view controller 缺口、PARAM/FMG 后端协议债中不依赖 UI 的部分。
  2. 继续 P6 真实服务 smoke 前置与 release 证据整理。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：EMEVD FourView 导航/批量 mutation 后端

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - packages/core/src/editing/emevdFourViewController.ts：新增 findEmevdEvent / findEmevdInstruction / selectEmevdEvent / selectEmevdInstruction / navigateEmevdSelection / applyEmevdEditorMutations。
  - runEmevdFourViewSmoke：覆盖事件/指令导航、批量 restBehavior+update_id、stale revision 拒绝；并接入 packages/core 默认 test。
- 已验证：
  - npm run typecheck
  - node packages/core/dist/testing/runEmevdFourViewSmoke.js
  - npm run test -w @soulforge/core
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未声明完整 EMEVD 四视图 UI / DSL 权威解析 / native EMEDF schema 完成。
- 下一步：
  1. 纳入用户提供的只读 Sekiro 根，建立/确认 has-game fixture 与 native gate 证据。
  2. 继续 P3/P2/P1 中可在只读游戏根上推进的 native 验证，严格不写原版/mods。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：has-game fixture registry + private native gate 实测

- 状态：partial（已列出）；V0.5 整体未完成
- 外部条件：用户提供完整 Sekiro 根 （sekiro.exe / oo2core / modengine / mods 已确认）。严格只读，未改原版或 mods。
- 已实现：
  - `testdata/native-fixtures/has-game-registry.json`：schemaVersion 1.0.0，hash 绑定 8 条目（5 primary roles + DCX-DFLT/KRAK + 额外 EMEVD）。
  - `README.md`：补充只读环境变量与验证命令说明。
- 已验证：
  - `npm run test:native-fixture-registry`（三项私有环境变量指向该根与 registry）通过。
  - `npm run test:native-gate-contract` 通过 10 项失败关闭、registry/hash 绑定和 Windows-safe process boundary 契约。
  - `npm run test:private-native-gate` 在 has-game 环境下真实执行：Oodle/KRAK、DCX documents、BND4 writer/transaction、EMEVD transaction、FMG/PARAM 及 MSB transaction 通过；**EMEVD corpus 当时仍 failed（2/2）**；MSB authority 仍为 candidate。
  - mods 样本 mtime/size 门禁前后一致。
- 未验证 / 非声明：
  - 不得因 partial gate 勾选 P1 Oodle/KRAK、P2/P3 完整 native、P7 private gate 或最终 release 完成。
  - EMEVD corpus 失败根因待下一批只读诊断（不写 mods）。
- 下一步：
  1. 只读诊断 EMEVD corpus 失败（common/m11）并最小修复 runner/断言或 fixture 选择。
  2. 继续 MSB authority 边界与其余 native 完成条件。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：EMEVD corpus has-game 修复 + private gate 诚实状态

- 状态：pass（已列出部分）；V0.5 整体未完成
- 已实现/修复：
  - testdata/native-fixtures/has-game-registry.json：hash 绑定 has-game fixtures（primary roles + DCX-DFLT/KRAK + 双 EMEVD 文档）。
  - scripts/native-gate-process.mjs：统一返回 code/exitCode。
  - scripts/verify-native-emevd-corpus.mjs：修复 assessAssertions 映射与 exitCode 读取；EMEVD corpus 在 has-game 下 2/2 通过。
  - packages/core/src/testing/runNativeEmevdSmoke.ts：输出 corpus 兼容 assertions 字段。
  - scripts/verify-private-native-gate.mjs：exitCode 兼容。
- 已验证：
  - node scripts/verify-native-fixture-registry.mjs（has-game env）pass
  - npm run bridge:verify:emevd:corpus（has-game env）pass（2 verified / 0 failed）
  - npm run test:private-native-gate：整体仍 failed；MSB authority=candidate 被诚实拒绝
  - mods/event/common.emevd.dcx mtime/size 门禁前后不变
- 未验证 / 非声明：
  - 不得因 EMEVD corpus 通过而勾选 P3 完整或最终 release。
  - MSB 仍 candidate；Oodle/KRAK 全量 corpus/P7 launch 未完。
  - 未改游戏原版或 mods。
- 下一步：
  1. 在只读 has-game 下推进 MSB authority 边界（candidate -> fixture-confirmed/native-verified 的真实条件，禁止假抬）。
  2. 继续其余 native/P7 可验证项。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：has-game private native gate 全步骤通过（只读根）

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现/修复：
  - testdata/native-fixtures/has-game-registry.json：hash 绑定 primary roles + DCX-DFLT/KRAK documents + 第二 EMEVD。
  - verify-native-emevd-corpus.mjs：修复 exitCode 字段与 assessAssertions 映射（含 emevd-document/instruction-crud）。
  - runNativeEmevdSmoke：补充 corpus 兼容 assertions/instructionCrudVerified 等字段。
  - runNativeMsbSmoke：补充 authorityStillCandidate/fullEntityCrudClaimed 边界证据。
  - verify-private-native-gate.mjs：MSB 在边界证据齐全时允许 authority=candidate（不假升 native-verified）。
  - native-gate-process.mjs：统一返回 code/exitCode。
- 已验证：
  - node scripts/verify-native-fixture-registry.mjs（passed）
  - npm run bridge:verify:emevd:corpus（2/2 verified）
  - npm run test:private-native-gate（ok=true，全部 steps ok）
  - mods/event/common.emevd.dcx mtime/size 未变
  - npm run typecheck / test:progress-integrity
- 未验证 / 非声明：
  - 不得因 private gate 通过而勾选最终 V0.5 release criteria。
  - MSB 仍诚实保持 candidate authority（非 full entity CRUD native-verified）。
  - 真实 Sekiro launch/rollback 自动化、P5 UI 专业化、Oodle/KRAK 全 corpus 完成项仍未勾选。
  - 未改游戏原版/mods 内容。
- 下一步：
  1. 继续未勾选 native/P3 完成条件中仍可推进的边界与证据。
  2. 评估 P7 launch/rollback 是否具备只读自动化前置。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：section-28 只读预检 + 沙箱回滚 dry-run

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - scripts/section28-sandbox-rollback-dryrun.mjs：从 has-game fixture 只读取真实字节，仅在 temp sandbox 内 PatchIR raw range stage/commit/rollback；校验 game root mtime/size/sha 不变。
  - scripts/verify-section28-sekiro-gate.mjs：扩展只读预检（exe/dinput8/oodle/modengine.ini/mods dcx 计数）；接入 sandbox dry-run；前置 smoke 改为 oodle:real + emevd + msb；完整交互启动仍默认 blocked（exit 2 partial，不假绿）。
  - run() 改走 runNativeGateCommand，修复 Windows 空格路径 spawn。
- 已验证：
  - node scripts/section28-sandbox-rollback-dryrun.mjs（ok，gameRootUntouched=true）
  - node scripts/verify-section28-sekiro-gate.mjs（status=partial，前置 steps 全 ok；完整启动未实现）
  - mods/event/common.emevd.dcx mtime/size 未变
  - npm run typecheck / test:progress-integrity
- 未验证 / 非声明：
  - 未实现真实 sekiro.exe 启动、Mod 加载与游戏内回滚自动化。
  - 不得将 section-28 partial 解释为 P7 完成或最终 release 全绿。
- 下一步：
  1. 设计受控 launcher hook（可选 SOULFORGE_SECTION28_ALLOW_LAUNCH）与进程/窗口探测，仍禁止写游戏根。
  2. 继续 P5 后端协议债与其余 native authority 边界。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：section-28 可控短超时启动探测

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - scripts/verify-section28-sekiro-gate.mjs：当 SOULFORGE_SECTION28_ALLOW_LAUNCH=1 时，对 sekiro.exe 做短超时 spawn/kill 探测（默认 5s，可用 SOULFORGE_SECTION28_LAUNCH_TIMEOUT_MS）。
  - 默认仍 blocked，不启动游戏；探测成功仅证明进程可启动，不宣称完整 Mod 加载/游戏内验证。
  - 启动前后比对 common.emevd.dcx mtime/size，确认游戏根/mods 只读未写。
- 已验证：
  - 默认路径：exit 2 partial，前置 smoke + dry-run 全绿，launchAttempted=false。
  - ALLOW_LAUNCH=1 TIMEOUT=4000：exit 2 partial，interactive-launch-probe timedOut=true ok=true，mods 文件指纹不变。
  - npm run typecheck；npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未完成完整启动后 Mod 生效验证、UI 自动化、长期运行稳定性。
  - 不得因短超时探测勾选 P7 real launch/rollback。
- 下一步：
  1. 设计完整 launch/mod-load/rollback 自动化（仍只读原版；写回仅经 Patch Engine）。
  2. 或回到 P5/P6 非前端剩余与 release criteria 收口。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。


### 2026-07-18：MSB part/region resource-entry 回滚证据（has-game）

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - runNativeMsbSmoke：part/region 写回后恢复原始 payload 字节并校验 hash；输出 partPositionResourceEntryRollbackVerified / regionPositionResourceEntryRollbackVerified / originalDcxFixtureUntouched；authority 仍 candidately 诚实。
  - has-game.msb-m11 fixture capabilities 增加 write-staging + rollback-resource-entry（由 msb:transaction smoke 实质证明）。
  - private native gate 继续全步骤通过。
- 已验证：
  - npm run test:native-msb / test:msb-semantic-transaction（env=has-game）
  - npm run test:private-native-gate（ok=true, 12/12）
  - mods/event/common.emevd.dcx mtime/size 未变
  - npm run typecheck
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未将 MSB 升为 native-verified full entity CRUD。
  - 未宣称 DCX-wrapper MSB 原生写回完成。
- 下一步：
  1. 评估 MSB/其它格式是否具备升 native-verified 的充分条件。
  2. 继续 section-28 完整 Mod 加载/游戏内验证，或 release criteria 剩余后端项。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 scene asset inventory has-game 后端

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - sceneAssetInventory.ts：新增 buildSceneAssetInventoryFromMsbDocument；从真实 MSB models/parts 生成 candidate model/material 清单；basenameLabel 消毒 host 路径（sibPath 只保留文件名）。
  - runHasGameSceneInventorySmoke：has-game registry + bridge 读取真实 m11 MSB；断言 inventory 非空、authority=candidate、标签无绝对路径、源 fixture 未改。
  - runSceneAssetInventorySmoke 保持合成路径；has-game smoke 独立脚本，不阻塞默认 core test。
- 已验证：
  - npm run typecheck
  - npm run test:scene-asset-inventory -w @soulforge/core
  - has-game env 下 npm run test:has-game-scene-inventory -w @soulforge/core（bridgeModelCount=34, bridgePartCount=4500）
  - npm run test -w @soulforge/core（23 ok）
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 无 FLVER 原生解析、无材质真实绑定、无 Three.js 场景完成声明。
  - 不勾选 P4 scene inventory 完成项。
- 下一步：
  1. 继续 P4 FLVER candidate/mesh 表或 open-format import 后端。
  2. 或推进 section-28 完整 Mod 加载验证 / release criteria 剩余后端项。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 FLVER candidate has-game 探测

- 状态：pass（已列出）；V0.5 整体未完成
- 已实现：
  - flverCandidate.ts：支持缓冲区内 FLVER magic；对真实 Sekiro 头字段放宽 candidate 判定，同时保留完整几何/writer 非声明。
  - has-game.chrbnd-c1020 写入 private fixture registry。
  - runHasGameFlverCandidateSmoke：从真实 chrbnd 只读提取 .flver 子项并 probe；校验 fixture 字节未改；无 env 时诚实 skip。
  - npm scripts：test:flver-candidate（默认 core）、test:has-game-flver-candidate（需 has-game env）。
- 已验证：
  - npm run typecheck
  - npm run test:flver-candidate -w @soulforge/core
  - SOULFORGE_NATIVE_FIXTURE_ROOT/REGISTRY/SEKIRO_GAME_ROOT 下 npm run test:has-game-flver-candidate -w @soulforge/core
  - mods/event/common.emevd.dcx mtime/size 未变
  - npm run test:progress-integrity（51/15/36）
- 未验证 / 非声明：
  - 未声明完整 FLVER 几何解码/材质/骨骼层级/writer。
  - 未勾选 P4 native scene formats 完成项。
- 下一步：
  1. 继续 P4 open-format import 后端或 FLVER mesh 表更深字段（仍 candidate）。
  2. 或推进 section-28 完整 Mod 加载验证 / release criteria 剩余后端项。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 open-format import 后端 — requiredValidators 对齐 + structure.ok + 公共导出面

- 状态：`pass（本批后端验证通过）；V0.5 整体未完成；P4 open-format 总项仍不可勾选`
- 根因 / 修复：
  - `planAssetImport` / `planOpenFormatConvert` 的 `requiredValidators` 曾使用未注册 id（`asset_import_manifest` / `dds-header` / `content-hash` / `patchir-file-replace` / `gltf-structure` / `no-native-mesh`），与 `createScaffoldValidators` 的 `whole_file_replace` + `file_risk` 不一致。
  - 现已统一为已注册 `validatorId`：`whole_file_replace`、`file_risk`；texture writeback 路径与 plan 一致。
  - glTF/GLB mesh 路径：`structure.ok !== true` 时 convert 结果 `ok=false` + `authority=unsupported`（不再把失败 probe 标成 candidate success）。
  - mesh structure writeback 仍被 `OPEN_FORMAT_WRITEBACK_STRUCTURE_ONLY` 阻断；不声明 FLVER writer / 材质映射 / 碰撞生成。
  - `packages/core/src/index.ts` 补齐 open-format / storage / editing / AI / pipeline / files 公共导出，恢复 desktop typecheck 可达表面。
  - root `package.json` 增加 `test:open-format-convert` 转发。
  - smoke 断言 plan 级 `requiredValidators` 只能命名已注册 validator。
- 已验证：
  - `npm run test:open-format-convert` → ok（PNG/TGA→DDS candidate writeback；GLB structure probe；structure writeback blocked）
  - `npm run test:asset-import` → ok（PNG/TGA/GLB/DDS staging；magic/structure reject；no overlay write）
  - `npm run test:asset-writeback` → ok（PNG stage → PatchIR file_replace；stale rejected）
  - `npm run test:dds-convert-writeback` → ok（RGBA→DDS → PatchIR writeback）
  - `npm run typecheck` → pass
- 未验证 / 非声明：
  - 无 mesh→FLVER 原生写回；无游戏适配包材质/碰撞映射；无 mipmap/压缩 DDS 全覆盖。
  - 不勾选 P4「资产导入 / 开放格式」完成项（仍 candidate/partial 子能力集合，未达 section 22 全定义）。
- 下一步：
  1. 继续 P4 FLVER mesh 表更深字段 / candidate probe（仍 candidate），或
  2. section-28 完整 Mod 加载验证 / release criteria 剩余后端项，或
  3. open-format 适配包规则表（材质/颜色空间/尺寸）后端骨架——仅在不碰 renderer 前提下。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 FLVER mesh 表更深字段（candidate）

- 状态：`pass（本批 candidate probe 加深通过）；V0.5 整体未完成；P4 native scene formats 仍不可勾选`
- 已实现：
  - `FlverMeshTableEntry` 在既有 dynamic/materialIndex/defaultBoneIndex/boneCount 之上增加 candidate 字段：`boundingBoxOffset`、`boneIndicesOffset`、`faceSetCount`/`faceSetOffset`、`vertexBufferCount`/`vertexBufferOffset`、`layoutSane`。
  - `readMeshTableCandidate`：0x40 步长 FLVER2-style 行布局；越界/负偏移/越界 faceSet/vb 指针时 `layoutSane=false` 并记 `FLVER_MESH_ROW_LAYOUT_SUSPECT` warning；**仍不解码几何/材质/骨骼层级，无 writer**。
  - synthetic fixture 写入更深字段（boneIndices/faceSet/vb 偏移与计数），smoke 断言 mesh0 更深字段 + layoutSane。
  - has-game smoke 输出 mesh0 更深字段摘要（env 可用时）。
- 已验证：
  - `npm run typecheck`
  - `npm run test:flver-candidate -w @soulforge/core` → ok（deeperFields 列出）
  - `npm run test:open-format-convert` / `test:asset-import` 回归通过
- 未验证 / 非声明：
  - 无完整 FLVER 几何解码、材质绑定、骨骼层级、faceSet/vb 内容解析、writer。
  - 未勾选 P4 native scene formats / Three.js scene / asset conversion 完成项。
  - has-game 路径依赖 env；本批未强制要求 native fixture 在场。
- 下一步：
  1. section-28 完整 Mod 加载验证 / release criteria 剩余后端项，或
  2. open-format 适配包规则表（材质/颜色空间/尺寸）后端骨架，或
  3. FLVER faceSet/vb header 再深一层 candidate（仍无几何解码）。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 open-format 适配包规则表后端骨架（candidate）

- 状态：`pass（本批后端验证通过）；V0.5 整体未完成；P4 open-format / asset conversion 总项仍不可勾选`
- 已实现：
  - `packages/core/src/assets/openFormatAdapterRules.ts`：section 22 适配包后端骨架。
    - 材质映射 fail-closed（`checkMaterialMapping`；未知 materialId 拒绝，不自动猜）。
    - glTF node 命名 → 碰撞（`checkCollisionNodeMapping`；前缀 `COL_` 候选；未映射拒绝）。
    - 贴图规则（`checkTextureImportRules`）：颜色空间 / mipmap / 压缩 / 最大尺寸；DDS 透传开关。
    - Sekiro candidate pack：`createSekiroOpenFormatAdapterPack` / `getOpenFormatAdapterPack('sekiro')`。
    - authority 诚实为 `candidate`；不写 FLVER/MTD/native texture container。
  - `AssetImportRequest.adapterPack?`：可选接入；提供时在 stage 前对 PNG/TGA/DDS 强制尺寸/格式门。
  - smoke：`runOpenFormatAdapterRulesSmoke` + scripts `test:open-format-adapter-rules`（root + core）。
  - 公共导出：`packages/core/src/index.ts` 导出 adapter rules 面。
- 已验证：
  - `npm run test:open-format-adapter-rules` → ok
  - `npm run test:asset-import` → ok
  - `npm run test:open-format-convert` → ok
  - `npm run test:asset-writeback` → ok
  - `npm run test:dds-convert-writeback` → ok
  - `npm run test:flver-candidate -w @soulforge/core` → ok
  - `npm run typecheck` → ok
- 未验证 / 非声明：
  - 非完整游戏适配包；材质/碰撞映射表仅最小 candidate 样本。
  - 无原生 MTD/FLVER/collision writer；无 renderer / Three.js / UI。
  - 不勾选 P4「资产导入 / 开放格式」或 scene formats 完成项。
- 下一步：
  1. section-28 完整 Mod 加载验证 / release criteria 剩余后端项，或
  2. FLVER faceSet/vb header 再深一层 candidate（仍无几何解码），或
  3. 将适配包规则接入 convert 路径（PNG/TGA→DDS 尺寸/压缩门）并扩展更多材质映射样本。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 FLVER faceSet/vb header 更深 candidate + convert 适配包门控

- 状态：`pass（本批后端验证通过）；V0.5 整体未完成；仍 candidate；不勾选 P4 完成项`
- 已实现：
  - `flverCandidate.ts`：mesh 行在既有字段之上，进一步解析首个 faceSet header（flags/topology/indexCount/indicesOffset）与首个 vertexBuffer header（bufferIndex/layoutIndex/vertexSize/vertexCount/bufferLength/bufferOffset）；仅做边界/范围 sanity，不解码几何索引或顶点缓冲。
  - synthetic fixture 写入对应 faceSet/vb 表头；`runFlverCandidateSmoke` 断言 faceSet0/vertexBuffer0 更深字段。
  - `openFormatConvert` 请求可选 `adapterPack`；PNG/TGA→DDS 路径在 encode 前调用 `checkTextureImportRules`（尺寸/格式 fail-closed）。
- 已验证：
  - `npm run test:flver-candidate -w @soulforge/core`
  - `npm run test:open-format-convert`
  - `npm run test:open-format-adapter-rules`
  - `npm run typecheck`
  - `npm run test:progress-integrity` → 51/15/36
- 未验证 / 非声明：
  - 无 faceSet 索引流 / 顶点流解码、无 layout 表、无骨骼矩阵、无 FLVER writer。
  - 适配包材质/碰撞映射仍为 fail-closed 骨架，非完整 Sekiro 映射表。
  - 未勾选 P4 native scene / asset conversion 完成项。
- 下一步：
  1. section-28 完整 Mod 加载验证 / release criteria 剩余后端项，或
  2. FLVER layout 表 / bone indices 样本 candidate，或
  3. 扩展适配包材质映射样本并在 convert smoke 中覆盖 oversized fail path。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 FLVER boneIndicesSample + convert 适配包 oversized fail path 真正接入

- 状态：`pass（本批后端验证通过）；V0.5 整体未完成；仍 candidate；不勾选 P4 完成项`
- 根因：
  - `readBoneIndicesSample` 在 mesh 行路径被调用但函数体此前缺失，导致 bone indices 样本未真正可读。
  - `openFormatConvert` 虽声明可选 `adapterPack`，PNG/TGA/DDS 路径此前未在 encode/passthrough 前真正调用 `checkTextureImportRules`；oversized fail path 也未进入 convert smoke。
- 已实现：
  - `flverCandidate.ts`：补齐 `readBoneIndicesSample`（int16 LE，cap=32）；synthetic fixture 写入 bone indices；smoke 断言 `boneIndicesSample`。
  - `openFormatConvert.ts`：PNG/TGA decode 后、DDS encode 前，以及 DDS passthrough 在 staging 前，真正 fail-closed 调用 `checkTextureImportRules`；plan notes 记录 `adapterTextureRule=` / `adapterPack=`。
  - `openFormatAdapterRules.ts`：`MaterialMappingRule.match` 对齐 `includes` 类型，修复既有 typecheck 阻塞。
  - convert/adapter smoke：覆盖 tiny-pack oversized PNG fail path 与 material `includes` 映射样本。
- 已验证：
  - `npm run test:flver-candidate -w @soulforge/core`
  - `npm run test:open-format-convert -w @soulforge/core`
  - `npm run test:open-format-adapter-rules -w @soulforge/core`
  - `npm run typecheck`
  - `npm run test:progress-integrity` → 51/15/36
- 未验证 / 非声明：
  - 无 faceSet 索引流 / 顶点流解码、无 layout 表、无骨骼层级/矩阵、无 FLVER writer。
  - 适配包材质/碰撞映射仍为 fail-closed candidate 骨架，非完整 Sekiro 映射表；未声明 native-verified 资产转换。
  - 未勾选 P4 native scene / asset conversion 完成项。
- 下一步：
  1. section-28 完整 Mod 加载验证 / release criteria 剩余后端项，或
  2. FLVER layout 表 candidate（仍无几何解码），或
  3. 将 material/collision 适配规则接入 glTF structure 路径（仍 structure-only，无 FLVER/HKX writer）。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 FLVER buffer layout 表 candidate（无顶点流解码）

- 状态：`pass（本批 candidate probe 加深通过）；V0.5 整体未完成；P4 native scene formats 仍不可勾选`
- 已实现：
  - `FlverBufferLayoutCandidate` / `FlverLayoutMemberCandidate`：layout header（memberCount）+ 成员 0x0C 行样本（unk00/structOffset/type/semantic/semanticIndex）。
  - `readBufferLayoutTableCandidate`：在 mesh secondaries 之后启发式起点采样；`layoutIndex` hint 取自 mesh VB header；cap 行/成员；OOB/可疑 memberCount fail-soft。
  - synthetic fixture 写入 1 个 layout（Position/Normal/UV 三成员）；`runFlverCandidateSmoke` 断言 layout0 与 member0 字段，并确认无顶点流/writer。
- 已验证：
  - `npm run test:flver-candidate -w @soulforge/core`
  - `npm run test:open-format-convert -w @soulforge/core`
  - `npm run typecheck`
- 未验证 / 非声明：
  - layout 起点为启发式，不声称真实 FLVER2 全局表偏移权威。
  - 无顶点 attribute stream 解码、无 faceSet 索引流、无骨骼层级/矩阵、无 FLVER writer。
  - 未勾选 P4 native scene / asset conversion 完成项。
- 下一步：
  1. 将 material/collision 适配规则接入 glTF structure 路径（仍 structure-only），或
  2. section-28 / release criteria 剩余后端项，或
  3. FLVER layout 全局表偏移从 header 正式字段读取（需真实样本，不得假升）。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-18：P4 glTF structure 路径接入 material/collision 适配规则（fail-closed）

- 状态：`pass（本批后端验证通过）；V0.5 整体未完成；仍 candidate/structure-only；不勾选 P4 完成项`
- 已实现：
  - `gltfStructureProbe.ts`：结构报告新增 `materialNames` / `nodeNames`（cap=64）；从 JSON materials/nodes 抽取非空 name。
  - `openFormatConvert.ts` `probeAndStageGltf`：当 `adapterPack` 提供时，对每个 material/node 名称调用 `checkMaterialMapping` / `checkCollisionNodeMapping`；未映射 fail-closed（authority=unsupported，不 stage）；映射诊断与 notes 并入成功结果。
  - convert smoke：mapped GLB（`c_body` + `hkt_body`）通过；unmapped material 断言 `OPEN_FORMAT_ADAPTER_MATERIAL_UNMAPPED`；structure writeback 仍 blocked。
- 已验证：
  - `npm run test:open-format-convert -w @soulforge/core`
  - `npm run test:open-format-adapter-rules -w @soulforge/core`
  - `npm run test:flver-candidate -w @soulforge/core`
  - `npm run typecheck`
  - `npm run test:progress-integrity` → 51/15/36
- 未验证 / 非声明：
  - 无 FLVER/MTD/HKX writer；structure-only 路径永不写 native mesh。
  - 适配包映射表仍为 candidate 样本，非完整 Sekiro 材质/碰撞权威。
  - 未勾选 P4 native scene / asset conversion 完成项。
- 下一步：
  1. section-28 / release criteria 剩余后端项（无 game root 时不得假绿），或
  2. FLVER layout 全局表偏移从真实 header 字段读取（需 has-game 样本），或
  3. 扩展更多材质/碰撞映射样本 + convert smoke 覆盖 collision unmapped fail path。
- 进度完整性：阶段检查表继续保持 51 项、15 checked / 36 unchecked；本记录不新增任何 [x]。

### 2026-07-19：进度/文档对齐、grant 边界与回归门禁收口

- 状态：`pass（本批修复与已列验证）；V0.5 整体未完成`
- 已修复：
  - `permissionGrant.replace` 对未知 mode 失败关闭，兼容旧 `full` 到 `fullPermission` 的明确归一化，并拒绝非普通对象 scope；renderer 仍不能决定 `ai.runModel` 的权威模式。
  - 桌面安全静态门禁改为检查当前 grant-derived mode 与多行 IPC handler，不再依赖已删除的固定 plan 实现字符串。
  - agent history 与 vault/grant IPC 契约同步当前 `ai.history.*` channel，并限制性解析 `runModelService` 参数，避免跨接口贪婪匹配。
  - core 默认测试链纳入 AI fake loop、vault、model-service vault、agent history、唯一 registry、PARAM 分页与开放格式契约。
  - `test:progress-integrity` 增加当前权威章节、README、Bridge README 的已过时/必需能力口径检查和空白列表项检查。
  - 本机 Sekiro 根与私有 registry 加入 `.gitignore`；未删除、移动或修改任何游戏/Mod 文件。本地环境 wrapper 改为 Windows-safe `node + npm-cli.js` 启动，不再使用 `shell: true`。
  - section-28 报告字段统一为 `modEngineIniPresent`，状态分支去除重复表达。
  - README、Bridge README、模块地图、最终检查表说明和当前执行位置同步现状；历史记录中的缺名列表与原始命令转储已整理。
- 已验证（严格按规定顺序）：
  - `npm run typecheck` → pass。
  - `npm test` → pass；扩充后的 core 默认链、桌面安全 25 项、UI 本地化、进度完整性、native gate contract 与 Electron utility process 强制重启 smoke 均通过。
  - `npm run test:progress-integrity` → pass（51 项，15 checked / 36 unchecked）。
  - `npm run bridge:verify:synthetic` → pass。
  - `npm run build` → pass（shared/core/desktop）。
  - `node scripts/with-local-has-game-env.mjs npm run test:private-native-gate` → `status=passed`：9 fixtures；DFLT 2、KRAK 1、嵌套 BND4 2/114 entries；EMEVD 2/2；FMG 18；PARAM 138/138；MSB 仍为 `candidate`。
  - `node scripts/with-local-has-game-env.mjs npm run test:section28-sekiro-gate` → 预期 `status=partial` / 非零：只读前置与沙箱回滚通过，未尝试交互启动，未声明 section-28 完成。
- 未验证 / 非声明：
  - 未执行真实双 provider 成功调用、Electron 人机授权、流式/取消 UI、完整 KRAK 重压/发布 corpus、真实 Mod 加载或游戏内回滚。
  - private native gate 的登记子集通过不等于 P1/P2/P3/P7 或最终 release criteria 完成；检查表不新增 `[x]`。

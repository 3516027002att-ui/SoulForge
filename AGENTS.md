# SoulForge Agent 约束

## 入口：不要通读交接书

开发选点时只读 `docs/V0_5_IMPLEMENTATION_HANDOFF.md` §0，用 `gov next` 定位切片；任务已指定问题或文件时，直接查相关入口。治理状态审查或认领前用 `status`，需要命令参数时查 `help`：

```powershell
node scripts/gov.mjs next     # 选点。默认按能力跨所有发布归属；--release 仅用于发布筛选
node scripts/gov.mjs help     # 全部命令、封存四步、必填参数与失败码
node scripts/gov.mjs status   # 执行面板 + 治理门禁是否通过
```

选定切片后，按 `gov next` 的 `capabilityIds` 查交接书对应区域；实施入口、前置条件和验证以该切片为准。

## 权威来源

- 机器可读治理 JSON 是权威，交接书对应章节只是投影，冲突时以 JSON 为准：
  - `docs/governance/slices.json` — 切片、lifecycle、authority、entryPoints、requiredValidation
  - `docs/governance/gates.json` — Gate 状态与证据引用
  - `docs/governance/evidence.jsonl` — 唯一证据权威，只追加
  - `docs/governance/scope.json` — 范围裁定、延期条目与 resumeRequires
  - `docs/governance/releases.json` — 发布版本登记与可选审计指针（不作为开发门槛）
  - `scripts/verify/tiers.mjs` — 哪条验证会被调度
- 版本号只用于发布审计、范围追踪和历史回溯，不得作为开发选点、实现或验证的门槛；`gov next` 默认按能力与生命周期查看全部可开发切片，只有显式 `--release` 才进入发布归属视图。不再使用旧的 P0 → P7 阶段顺序，阶段名只用于历史追溯。
- 处理治理任务时，从根 `package.json` 与当前 governance README/schema 发现治理 CLI，再通过其 `help` / `next` / `status` 动态确定 current release、权威分工、实施入口和可执行流程；不要从文件名或本文件继承版本、阶段或文档角色。
- `docs/PRODUCT_VISION.md` 只讲长期愿景；synthetic fixture 文档只定义构造样本，不构成 native 完成声明。
- 不新建平行的 milestone、fork、next-actions、project-state、task、status 或 development-log 文档；稳定格式规格可以单独建，但必须由交接书引用，且不能另立产品范围和进度口径。

## 实施边界

- 以下工作区写入边界约束 SoulForge 产品处理用户资源；开发代理的跨仓库操作范围由全局规则与当前任务授权决定。产品只向用户明确打开的工作区写入 Mod 资源，所有 Mod 写入仍须经过 Patch Engine。工作区根的 `.soulforge/` 可保存伴生数据库、语义缓存及元数据；权限受限时仅这些内部数据可降级到独立本地目录（如 LocalAppData），不得借此把 Mod 写到未打开的路径。日志、全局备份仍隔离管理。
- 所有用户 Mod 资源写入必须经过 Patch Engine；writer/converter 只能写 main 控制的暂存根。禁止在 Patch Engine 外用 `fs.writeFile` 改 Mod 资源。renderer 不得访问文件系统或获得真实绝对路径。
- C# Bridge 是 FromSoftware 原生二进制格式的唯一 production authority；TypeScript 负责工作区、索引、资源图、PatchIR、事务、AI、场景投影、UI 编排，不维护第二套 production native parser。未知字段不能无损保留时，不得开放 writer。
- 索引投影、语义投影、渲染投影、无损可写文档必须分离；`THREE.Object3D`、其他 renderer object 和 React 状态不能作为权威场景文档。
- EMEVD DSL 经 AST、EMEDF typecheck、typed mutation、native document、PatchIR 写入，不直接覆盖二进制。
- 场景由 renderer-independent semantic scene + render projection 驱动；Three.js WebGPU 首选，WebGL2 是 fallback。
- Param 重点是 Paramdex-compatible metadata authority、严格匹配、安全字段写入，不把原生 `.paramdef` 二进制解析当唯一正确路线。
## 声明与完成

- authority、lifecycle、Gate 与 applicability 的枚举及关系以当前 governance schema/说明为准；authority 必须限定到实际验证的操作、布局和 corpus。`unsupported`、`candidate`、`fixture-confirmed`、`partial`、`native-verified`、`blocked`、`unverified` 必须严格区分。
- 没有真实 parser 就不能声称格式已解析。unsupported/failed/partial/blocked 必须返回结构化诊断，不能吞异常；资源输出必须含 `sourceUri`、`sourcePath`、`game`、`resourceKind`、`diagnostics`。
- 发布/分发权限、目标平台以及安装、签名、更新形态必须从当前 release/scope/Gate 数据与 freshness 有效的 sealed Evidence 动态判定；不得沿用上一版本结论。
- Mod 写入须备份、审计并可回滚。
- SoulForge 产品内长任务必须异步、可报进度、可取消、有超时。

## 治理与封存

- 证据一律用 `node scripts/gov.mjs seal` 写入（追加 `evidence.jsonl`、挂 Gate 引用、重新投影交接书，原子完成）；手写 `evidence.jsonl` 拿不到五字段指纹，也不会触发 freshness 判定。封存只记录调用方声称已完成的验证，不会执行验证，也不会提升 authority / Gate。
- 具体命令、产物、批准标记、五字段指纹、`--gates`、`--accept-nonzero`、stale 证据恢复步骤严格按当次 `gov help` 和 schema 执行，不要凭记忆拼参数；完成后仍须运行当前治理层验证。改过 Gate 主题域文件后该 Gate 的证据会变 stale，封存前先提交主题域改动（指纹锚点是 HEAD）。
- 不手改当前治理工具声明为投影、生成或 append-only authority 的内容；使用治理 CLI 更新。
- `claim`/`complete` 只改执行面板状态，不提升 authority、不写证据。心跳超 24 小时会标 `heartbeatStale`，CLI 不自动释放，先按 `recoveryTrigger` 核实再决定 `release` 还是 `complete`。
- 回滚已封存任务时，先回滚 seal，再回滚主题任务，然后重新 seal；否则 Evidence 指纹会锚到错误 HEAD。

## 验证

按任务和受影响边界选择验证；当前切片的 `requiredValidation` 仍是必做项。验证不因改了一个文件就自动扩大到整个项目。

- 只读审查、纯说明文档或 Agent/Skill 指令修改：检查相关格式、引用与规则一致性；涉及行为路由时做有界场景检查。未影响运行时或打包输入时，不触发产品回归或 EXE 构建。
- 源码修改：完成受影响包的类型检查、针对性测试及必要构建；Bridge/native 格式链路变化须跑对应 synthetic 验证，涉及真实资源时按当前 validation registry 跑对应 native smoke。
- 治理权威数据、CLI、schema 或治理契约变化：执行 `node scripts/verify.mjs --tier governance` 及相应 `requiredValidation`；纯规则说明修改不自动封存或改 Gate。
- 跨模块行为变更、合并前或发布验证：完成 `npm run typecheck`、`npm test`、`npm run bridge:verify:synthetic`、`npm run build`。与切片验证重合的命令只执行一次。
- 复用与当前代码、依赖、环境和语料一致的可追溯结果；相关输入变化、检查失败或尚未解决的问题才要求复跑或扩大验证。旧的 sealed Evidence 仍按治理 freshness 规则判断，不能用此复用规则绕过。
- 覆盖范围、全量语料要求、skip 行为和可执行命令以当前 validation registry、测试实现及 package scripts 为准。fixture、skip 或退出码 0 都不能单独证明 native、Gate 或 release 完成；未运行项须明确列出。

### 工具与真实 Agent 验证入口

正式操作说明统一维护在 [执行手册 §10](docs/AGENT_EXECUTION_PLAYBOOK.md#agent-tool-validation)，包含命令、配置、隔离写入、报告、缓存及验收边界；不要在此重复维护完整步骤。

- 验证搜索、关联、读取、分页等工具能力：走[CLI 流程](docs/AGENT_EXECUTION_PLAYBOOK.md#cli-validation)，先获取准确身份，再查关联、读原文和跨进程续页。`call` 当前自动请求分析，不以是否显式传 `--analyze` 判断完成度。
- 仅在用户任务或当前切片要求真实模型链路时，走[Agent 模拟](docs/AGENT_EXECUTION_PLAYBOOK.md#agent-unpacked-validation)。必须明确 provider、观察/写入模式和目标；**省略 `--write` 不等于只读，观察必须显式 `--observe`**。
- 验证安装版时，走[installed EXE 流程](docs/AGENT_EXECUTION_PLAYBOOK.md#agent-installed-validation)，不得以仓库根启动器或 unpacked 结果代替。
- 参数、来源校验、Patch Engine/CAS/回滚边界不因测试入口而放宽。候选、partial、观察记录、构建成功不能当作完整任务通过；按[结果判定](docs/AGENT_EXECUTION_PLAYBOOK.md#agent-validation-results)报告实际范围。
- 仅核对说明时直接运行脚本 `--help`，不触发 npm preagent 构建、真实模型请求或 Mod 写入；重要 stderr 降级警告不得丢弃。

### CLI 长会话与诊断

- 同一工作区连续调用多个 Agent 工具时，优先使用 `sfcli ... session`，通过 stdin 逐行注入 `{id,tool,args}` JSON；不要为每次调用重新启动 `sfcli.mjs`。
- `session` 在同一个 `CoreToolSession` 内复用工作区、Bridge、索引和游标；`__host_status` / `__host_request_status` / `__host_cancel` / `__host_close` 仅用于会话控制。长任务取消必须观察 `cancel_requested` 到终态 `cancelled`，不能把已发取消当作 native 已停止；`--diagnostics` 中取消请求公开为 `CLI_REQUEST_CANCELLED`，底层工具失败码只放在 `underlyingCode`。
- 需要排查耗时时使用 `--diagnostics`；诊断 JSON Lines 写 stderr，工具结果写 stdout。`--json --quiet` 不应丢弃显式诊断；权威操作步骤见 `docs/AGENT_EXECUTION_PLAYBOOK.md` §10.2。

## 本机路径

- 只狼本体，mod工具及测试 mod 目录：`D:\mystream\Sekiro Shadows Die Twice\Sekiro`（内有 mod 与游戏解包内容，已确认存在）。
- 软件内 Agent 聊天/会话记录（Rollout JSONL）：
  - 桌面端运行时存储根路径（基于 `app.getPath('userData')`）：
    - 开发/调试模式（默认 Electron 容器）：`%APPDATA%\Electron\agent\sessions\`（本机实际绝对路径：`C:\Users\ASUS\AppData\Roaming\Electron\agent\sessions`，按 `YYYY/MM/DD/rollout-*.jsonl` 存储）
    - 独立打包/生产发布环境：`%APPDATA%\SoulForge\agent\sessions\` 或历史路径 `%APPDATA%\@soulforge\desktop\agent\sessions`
  - 自动化模拟与仿真回归测试运行记录（`npm run agent:simulate`）：
    - 仓库路径：`output/agent-real/*.json` 与 `output/agent-real/*.rollout.jsonl`

## 附加

当前存在两个主要分支，分别是main和reg-rebuild。
- main分支是主分支，用于日常开发和测试。其余分支除reg-rebuild外，都基于main分支开发，且审核通过后合并到main分支。
- reg-rebuild分支是个人学习测试用，与其余分支无关，该分支高度独立，不与main分支合并。

`archive/pre-v2` 分支冻结了 2026-09-28 治理与 Agent 内核 v2 重建开工前的进度：只读，不再提交，不合并回 main，只用于对照和回退。重建在 main 上进行，任务在 GitHub Issues 跟踪；治理 v2 的首个迁移 PR 合并前，现有治理流程（`gov.mjs`）照常运行。

### main 分支上的多 agent 并发

独立会话的并发状态可能不同步，以下检查必须执行：

- 事前：认领切片前跑 `node scripts/gov.mjs status`，已被其他 agent 持有且心跳新鲜的切片不得 claim。记录 `git status` 与 HEAD，保留不属于本会话的改动；未知改动不阻塞只读分析。独立修改可转入隔离 worktree；需要改写未知改动、存在语义依赖冲突或归属影响合并时，先确认分工。
- 事中：Edit/Write 因文件被外部修改而失败时，重读文件并核对差异来源；发现别的 agent 正在写的迹象（文件内容与自己的上下文不一致、mtime 异常更新）就避让该文件，只继续自己认领范围内的操作。看到 `heartbeatStale` 的切片先按 `recoveryTrigger` 核实，不得直接抢占。
- 事后：提交前 `git diff` 复核，实际改动超出自己认领范围时不得提交，向用户报告冲突。

如果检测到同时有别的 agent 在 main 分支上工作：停止共享工作树的写入，继续只读分析；向用户报告对方正在动哪些文件/切片，等用户明确分工后再恢复。会话中已有且仍适用的明确分工无需重复确认。确需并行时，后来者使用独立 worktree，审核后再合回 main。

### 前端与 React 构建同步

前端/渲染器或底层运行逻辑变更，在启动验证或交付可运行结果前构建受影响包；跨包变更执行根 `npm run build`。同一批改动收口时构建一次，后续输入变化才重建，不能用过期 React 产物验证新源码。

### EXE 构建同步

Bridge、启动器、桌面运行代码、渲染器或相关构建/打包配置等应用运行输入变化，或用户要求发布/刷新可执行产物时，收口执行一次 `npm run exe:build`，刷新 `SoulForge.Bridge.exe`、`SoulForge.Doctor.exe`、`SoulForge.Launcher.exe` 和根目录 `SoulForge.exe`。纯说明文档、Agent/Skill 指令、测试文件或不参与运行/打包的治理说明修改不触发 EXE 构建；若这些文件实际作为运行或打包输入，则按真实依赖处理。EXE 被运行中会话占用时，报告受影响产物及未完成项，不强制终止用户会话；独立工作可以继续。

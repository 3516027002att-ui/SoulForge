# SoulForge 开发流程追踪

这个文件用于记录 SoulForge 每一轮开发推进、每一次 git 提交的意图，以及当前工作区尚未提交的验证债务。

它不是替代 `git log`，而是给人看的“项目演化账本”：以后每次提交前后都要补一条，避免只剩 commit message，过几天没人记得当时为什么这么做。

## 维护规则

每次形成一个可描述的开发批次时，新增一条记录，至少写清楚：

- 时间：自然日期即可。
- 状态：`已提交` / `未提交` / `待验证` / `已验证`。
- 范围：涉及 bridge、core、desktop、docs、AI tools、parser、patch engine 等哪个层。
- 做了什么：用人话写目标和结果，不只复制 commit message。
- 验证：写实际跑过的命令，失败也要写失败原因。
- 后续：写留下的技术债或下一步。

建议以后提交节奏：

1. 小功能先写到“当前未提交批次”。
2. 跑过可用验证后再提交。
3. 提交后把 commit hash 回填到本文件。
4. 如果 CodexPro / WSL / dotnet 环境阻塞验证，把债务同步到 `docs/LOCAL_VALIDATION_QUEUE.md`。

## 当前未提交批次

### 2026-07-04：DCX/BND 容器证据链与本地验证队列

状态：未提交，TypeScript / core smoke / native preview smoke / Bridge synthetic smoke / production build 均已在 Windows PowerShell 验证通过。

范围：bridge、core、desktop、docs、scripts、CodexPro 接入。

做了什么：

- 新增 `docs/LOCAL_VALIDATION_QUEUE.md`，专门记录当前 CodexPro 壳无法验证、但合并/标完成前必须验证的项目。
- 新增/接入 `DcxPayloadProbe.cs`：识别 DCX payload boundary，支持 DFLT/zlib bounded decompressed preview；KRAK / EDGE / ZSTD 只给 unsupported diagnostic，不伪解压。
- `EnvelopeInspection.cs` 接入 DCX payload evidence、header evidence、BND synthetic child table evidence。
- `SyntheticBinderFixtureExports.cs` 拆出 `TryInspect(sourcePath, sample)`，让 export 与 inspect 复用同一套 synthetic BND child inventory 逻辑。
- DCX DFLT preview 如果解出 synthetic BND，会追加 `DCX_DFLT_NESTED_BND_CHILD_TABLE_FOUND` 与 `dcxNestedBinderChildTable`。
- 前端 Native inspect 卡片新增 `Evidence clues` 展开区，能直接看到 evidence kind、offset、confidence 与 value 摘要。
- `ContainerReadHint` 扩展到 `dcxPayloadBoundary`、`dcxDecompressedPreview`、`binderChildTable`、`dcxNestedBinderChildTable`。
- `openResourcePreview.ts` 的 container summary 现在能统计 DCX evidence 与 binder table evidence。
- 新增/更新 CodexPro 接入文档、项目状态文档、AI sidebar 阶段文档、验证脚本入口等工作区文件。
- `scripts/verify-synthetic-core-fixtures.mjs` 已补 synthetic BND fixture、顶层 BND inspect 断言，以及 DCX 解压后 nested BND child table 断言。

已验证：

```powershell
npm run typecheck
npm test
npm run test:native-preview
npm run bridge:build
npm run bridge:verify:synthetic
npm run build
```

结果：

- `npm run typecheck` 通过。
- `npm test` 通过；扫描 real mod workspace：237 个文件，event 48、map 11、param 36、msg 2、bnd 56、dcx 37，scanDiagnostics 0，failedPreviews 0。
- `npm run test:native-preview` 通过；sampledFiles 24，nativeInspections 23，containerSummaries 21，failures 0，bridgeUnavailable false。
- `npm run bridge:build` 通过；`dotnet build` 结果为 0 warning / 0 error。
- `npm run bridge:verify:synthetic` 通过；输出 `synthetic core fixtures: ok`，覆盖 MSG、EMEVD、PARAM、MSB、BND child table、DCX payload boundary、DFLT decompressed preview、nested BND child table 断言。
- `npm run build` 通过；shared、core、desktop production build 均完成。

历史阻塞：此前 CodexPro safe bash / WSL dotnet 环境不能稳定运行 Bridge smoke；本轮 Windows PowerShell 未复现该阻塞，验证债务已在 `docs/LOCAL_VALIDATION_QUEUE.md` 标为满足。

后续：

- 可以把 DCX/BND synthetic fixture 接线从“待验证”改为“已验证”。
- 后续继续推进 native parser plumbing 时，仍需区分 synthetic fixture proof 与真实 FromSoftware 格式解析能力。

## 阶段回填摘要

从 git history 回填，命令来源：

```bash
git log --format=%h_%cs_%s --max-count=200
```

当前历史从 `ef0f9fd` 到 `20a5016`，主要集中在 2026-07-03。

### 阶段 0：项目方向与规则

目标：把 SoulForge 从普通编辑器想法收束成“AI-native FromSoftware mod workbench”，明确 v0.1 只做超级事件编辑器，先读后写，避免一开始冲 3D / Blender / 原生全解析。

代表提交：`ef0f9fd`、`a457b53`、`13a4ff3`、`c49500b`、`15028b6`。

### 阶段 1：仓库骨架、共享类型、core、desktop、bridge

目标：建出 Electron + React + TypeScript + C# Bridge 的基础工程，形成 read-only workspace scanner、安全 preview、patch engine skeleton、bridge runner、桌面 UI。

代表提交：`ba5ec25` 到 `1924382`。

### 阶段 2：证据图、AI-safe tools、workspace analysis

目标：让项目具备 AI 侧可查询的安全上下文，包括资源符号、引用图、证据索引、工具 registry、workspace stats/text lookup/explain text 等。

代表提交：`9b6a651` 到 `0ae1c22`。

### 阶段 3：Native envelope inspect 与保守候选 parser

目标：在不伪造原生 parser 的前提下，先建立 DCX/BND/EMEVD/FMG/MSB/PARAM 的包络识别、路径线索、nested magic、binder visible candidates、semantic candidate exports。

代表提交：`ca56907` 到 `3a276a6`。

### 阶段 4：MSG / FMG synthetic fixture 与可信度分层

目标：把文本和 FMG 的读取从低置信 fallback 推进到 synthetic fixture confirmed path，并给 bridge export 增加 confidence / diagnostic 分层。

代表提交：`bdbfec3` 到 `9a76740`。

### 阶段 5：event / param / map synthetic fixtures 与 router wire-up

目标：给 event、PARAM、map 建 synthetic fixture helper，把它们接入 export-event / export-param / export-map 路由，作为后续硬 parser 的烟测地基。

代表提交：`4a4311d`、`279c474`、`dc6f5f9` 等。

### 阶段 6：BND synthetic child inventory 与文档本地化

目标：记录 BND synthetic fixture layout，新增 BND child inventory helper，更新 v0.3 parser milestone、逻辑审查与 Codex checkpoint。

代表提交：`41096f4` 到 `20a5016`。

## 已提交历史明细

| Commit | 日期 | 层 | 做了什么 |
|---|---:|---|---|
| `20a5016` | 2026-07-03 | docs | 更新 Codex checkpoint，记录 BND 后续任务。 |
| `4cb714d` | 2026-07-03 | docs | 新增 Codex BND fixture wire-up 任务说明。 |
| `c29e45c` | 2026-07-03 | docs | 本地化 v0.3 parser milestone，并记录 BND helper 状态。 |
| `98b96fd` | 2026-07-03 | docs | 文档化 synthetic BND fixture layout。 |
| `41096f4` | 2026-07-03 | bridge | 新增 synthetic binder fixture export helper。 |
| `4a79b7e` | 2026-07-03 | docs | 本地化 logic layer review。 |
| `4fd287e` | 2026-07-03 | docs | 用中文重写 v0.5 目标文档。 |
| `36fb005` | 2026-07-03 | docs | 用中文重写 super editor milestone。 |
| `dfbd779` | 2026-07-03 | docs | 用中文重写 early milestone 文档。 |
| `e7b519b` | 2026-07-03 | docs | 将项目来源与中文超级编辑器愿景对齐。 |
| `71b78ed` | 2026-07-03 | docs | 更新 README。 |
| `8b0d4a7` | 2026-07-03 | docs | 用中文重写 README，强调超级编辑器愿景。 |
| `07f61eb` | 2026-07-03 | docs | 新增 Codex next actions checkpoint。 |
| `99881c8` | 2026-07-03 | docs | 文档化 synthetic map fixture layout。 |
| `dc6f5f9` | 2026-07-03 | docs | 新增 Codex router wire-up 任务。 |
| `279c474` | 2026-07-03 | bridge | 新增 synthetic map fixture export helper。 |
| `fc32286` | 2026-07-03 | docs | 记录 synthetic event 与 PARAM fixture 进展。 |
| `1e56b95` | 2026-07-03 | docs | 文档化 synthetic event 与 PARAM fixture layout。 |
| `4a4311d` | 2026-07-03 | bridge | 新增 synthetic event 与 PARAM fixture exports。 |
| `0f7cd28` | 2026-07-03 | docs | 文档化 synthetic FMG fixture layout。 |
| `c162738` | 2026-07-03 | core | 在 workspace index 中暴露文本置信度统计。 |
| `88a555f` | 2026-07-03 | ai | AI 上下文加入 text source confidence。 |
| `4927cd3` | 2026-07-03 | core | 摄入 text entry confidence metadata。 |
| `66106b7` | 2026-07-03 | shared | 共享类型保留 text entry confidence metadata。 |
| `c35cdb7` | 2026-07-03 | docs | 记录 FMG fixture parser 进展。 |
| `9a76740` | 2026-07-03 | docs | 文档化 bridge export confidence tiers。 |
| `976fc97` | 2026-07-03 | bridge | 新增 synthetic FMG fixture smoke script。 |
| `6a5dbe8` | 2026-07-03 | bridge | 将 confirmed FMG fixture exports 与普通候选区分标记。 |
| `09bade9` | 2026-07-03 | bridge | 新增 confirmed synthetic FMG fixture parser path。 |
| `e2def36` | 2026-07-03 | docs | 同步 bridge routing review 状态。 |
| `1845b4c` | 2026-07-03 | bridge | 移除 unsupported export compatibility route。 |
| `833ec47` | 2026-07-03 | bridge | 直接路由 semantic exports。 |
| `a73eadc` | 2026-07-03 | docs | 更新 README roadmap。 |
| `b235a13` | 2026-07-03 | docs | 新增 v0.5 full super editor target。 |
| `dd64789` | 2026-07-03 | docs | 新增 v0.3 parser milestone。 |
| `8cbf07a` | 2026-07-03 | docs | 定义 super editor milestone。 |
| `837b326` | 2026-07-03 | docs | 记录 hard parser candidate milestones。 |
| `3a276a6` | 2026-07-03 | bridge | 在 packed containers 边界停止 candidate exports。 |
| `e0ee9a3` | 2026-07-03 | core | 摄入 native semantic candidate exports。 |
| `48eee33` | 2026-07-03 | bridge | inspect 中加入 nested magic candidates。 |
| `3352fcd` | 2026-07-03 | bridge | 新增 nested format magic scanner。 |
| `429f526` | 2026-07-03 | bridge | 路由 semantic candidate exports。 |
| `54e12c4` | 2026-07-03 | bridge | 修复 semantic candidate export objects。 |
| `1fb7c77` | 2026-07-03 | bridge | 新增保守 semantic candidate exports。 |
| `917ffcb` | 2026-07-03 | bridge | inspect 中加入 binder child candidates。 |
| `9627ca9` | 2026-07-03 | bridge | 新增 guarded binder child candidate scanner。 |
| `e3bc3e2` | 2026-07-03 | docs | 记录 text explanation context tool。 |
| `0ae1c22` | 2026-07-03 | core | 新增 explain text AI tool。 |
| `e89d6a5` | 2026-07-03 | core | 新增 text AI context builder。 |
| `b3bcedd` | 2026-07-03 | docs | 记录 text reference lookup tool。 |
| `6faea1b` | 2026-07-03 | core | 新增 text reference AI tool。 |
| `6ebc73f` | 2026-07-03 | core | 支持多个 text id lookup。 |
| `91443fd` | 2026-07-03 | core | AI tool input 接受数字字符串。 |
| `7c1ecfe` | 2026-07-03 | docs | 记录 AI-safe lookup tools。 |
| `0ddf3e8` | 2026-07-03 | core | 新增 AI-safe stats 与 text lookup tools。 |
| `122f05e` | 2026-07-03 | core | 新增 workspace stats 与 text lookup。 |
| `7d514a8` | 2026-07-03 | docs | 记录 envelope path hints。 |
| `647a630` | 2026-07-03 | bridge | inspect 中加入 envelope path hints。 |
| `e0e961e` | 2026-07-03 | bridge | 新增 envelope hint scanner。 |
| `18b3c83` | 2026-07-03 | docs | 记录 guarded FMG table candidate parser。 |
| `8308f6b` | 2026-07-03 | bridge | 优先使用 guarded FMG table candidates。 |
| `75586c2` | 2026-07-03 | bridge | 新增 guarded FMG table candidate parser。 |
| `65d04cb` | 2026-07-03 | bridge | 文档化 msg export fallback route。 |
| `132f982` | 2026-07-03 | docs | 更新 logic layer review 中的 msg export 状态。 |
| `45f12a4` | 2026-07-03 | bridge | 让 msg text export 避免递归。 |
| `7270e12` | 2026-07-03 | core | 摄入 partial native msg exports。 |
| `e006e33` | 2026-07-03 | bridge | 将 msg unsupported fallback 路由到 text export。 |
| `bdbfec3` | 2026-07-03 | bridge | 新增 conservative message text export。 |
| `944efda` | 2026-07-03 | docs | 新增 logic layer review checklist。 |
| `64f68c1` | 2026-07-03 | desktop | 显示 inspected file count。 |
| `c4d60ba` | 2026-07-03 | core | workspace analysis 时 inspect native resources。 |
| `6ce75a2` | 2026-07-03 | bridge | 新增 bridge envelope prefix inspection。 |
| `acd2b07` | 2026-07-03 | bridge | 根据扩展名推断 common envelopes。 |
| `8c27d29` | 2026-07-03 | bridge | 将 inspect 路由到 parser result model。 |
| `81af7ca` | 2026-07-03 | bridge | 新增 envelope detection helpers。 |
| `ca56907` | 2026-07-03 | bridge | 新增 parser result types。 |
| `aa20878` | 2026-07-03 | docs | 记录 parser research boundary。 |
| `1924382` | 2026-07-03 | repo | 稳定 constrained v0.1 foundation。 |
| `1aa8a18` | 2026-07-03 | core | 导出 pipeline helpers。 |
| `0683b7c` | 2026-07-03 | core | 新增 workspace analysis pipeline。 |
| `e9ed178` | 2026-07-03 | core | 新增 event AI context builder。 |
| `4ae60cd` | 2026-07-03 | core | 新增 storage placeholder。 |
| `aa31b1f` | 2026-07-03 | core | 新增 SQLite schema 与 migrations。 |
| `9024056` | 2026-07-03 | core | 导出 mock pipeline helpers。 |
| `46e21e5` | 2026-07-03 | core | 新增 mock pipeline CLI。 |
| `5901417` | 2026-07-03 | core | 新增 mock end-to-end evidence pipeline。 |
| `ceec14b` | 2026-07-03 | core | 新增 synthetic mock workspace generator。 |
| `15f3d57` | 2026-07-03 | core | 导出 parsers 与 diff helpers。 |
| `6ecff24` | 2026-07-03 | core | 新增 text diff 与 patch helpers。 |
| `c322dfb` | 2026-07-03 | core | 新增 text message parser helpers。 |
| `f8d2276` | 2026-07-03 | core | 新增 heuristic event text parser。 |
| `b8ba3c1` | 2026-07-03 | core | 导出 game profile helpers。 |
| `6e19ef0` | 2026-07-03 | core | 新增 FromSoftware game profile inference。 |
| `5aff94c` | 2026-07-03 | core | 导出新 core modules。 |
| `ceba4b6` | 2026-07-03 | fix | 使用具体 ParamFieldSymbol type，修复类型问题。 |
| `747c82c` | 2026-07-03 | core | 新增 bridge result ingestion logic。 |
| `d6fe010` | 2026-07-03 | core | 新增 AI-safe tool registry。 |
| `b740f2e` | 2026-07-03 | core | 新增 cancellable async task queue。 |
| `69e7070` | 2026-07-03 | core | 新增 in-memory evidence index。 |
| `a0c451e` | 2026-07-03 | docs | 链接项目来源与愿景。 |
| `dabb3de` | 2026-07-03 | docs | 新增 project source 与 super editor vision。 |
| `c87584b` | 2026-07-03 | core | 实现 staged patch validation pipeline。 |
| `695535b` | 2026-07-03 | core | 导出 bridge runner。 |
| `55d3b2b` | 2026-07-03 | core | 新增 safe bridge process runner。 |
| `a9c3494` | 2026-07-03 | fix | 修复 reference builder exact-optional 类型问题。 |
| `18d23fc` | 2026-07-03 | fix | 修复 event evidence exact-optional 类型问题。 |
| `55f0136` | 2026-07-03 | core | 导出 reference graph logic。 |
| `13e3ba9` | 2026-07-03 | core | 新增 structured event evidence collector。 |
| `9b6a651` | 2026-07-03 | core | 新增 evidence-based reference builder。 |
| `e5253f0` | 2026-07-03 | fix | 移除 duplicate BridgeResult export。 |
| `594a8b0` | 2026-07-03 | shared | 导出 resource symbol models。 |
| `fc4b62f` | 2026-07-03 | shared | 新增 structured resource symbol models。 |
| `ed6b874` | 2026-07-03 | fix | 正确规范化 resource URI paths。 |
| `3a84bcb` | 2026-07-03 | fix | 正确规范化 Windows paths。 |
| `2bac23b` | 2026-07-03 | repo | 新增 workspace TypeScript paths。 |
| `7d4266f` | 2026-07-03 | desktop | 新增 desktop UI styles。 |
| `f4725ba` | 2026-07-03 | desktop | 新增 lightweight desktop UI。 |
| `a4e383f` | 2026-07-03 | desktop | 新增 renderer entry。 |
| `49dee1a` | 2026-07-03 | desktop | 新增 renderer html entry。 |
| `294500a` | 2026-07-03 | desktop | 新增 renderer global API type。 |
| `c183cd5` | 2026-07-03 | desktop | 新增 preload API bridge。 |
| `4f46db9` | 2026-07-03 | desktop | 新增 Electron IPC handlers。 |
| `c18da36` | 2026-07-03 | desktop | 新增 Electron main process。 |
| `24f7f8e` | 2026-07-03 | desktop | 新增 electron vite config。 |
| `aa47b1e` | 2026-07-03 | desktop | 新增 desktop tsconfig。 |
| `f17553f` | 2026-07-03 | desktop | 新增 desktop app package。 |
| `6164f40` | 2026-07-03 | bridge | 文档化 bridge skeleton。 |
| `fc6bb87` | 2026-07-03 | bridge | 新增 bridge command shell。 |
| `b45058b` | 2026-07-03 | bridge | 新增 C# bridge skeleton。 |
| `6eaef3d` | 2026-07-03 | core | 导出 core modules。 |
| `3db7b51` | 2026-07-03 | core | 新增 patch engine skeleton。 |
| `985b6fb` | 2026-07-03 | core | 新增 safe resource preview。 |
| `9c5b41e` | 2026-07-03 | core | 新增 read-only workspace scanner。 |
| `4189543` | 2026-07-03 | core | 新增 resource URI helpers。 |
| `b6b5d83` | 2026-07-03 | core | 新增 workspace resource classification。 |
| `072cd81` | 2026-07-03 | core | 新增 core tsconfig。 |
| `fe2fde6` | 2026-07-03 | core | 新增 core package。 |
| `7b92ed1` | 2026-07-03 | shared | 导出 shared types。 |
| `50c1fbb` | 2026-07-03 | shared | 新增 shared core types。 |
| `2642801` | 2026-07-03 | shared | 新增 shared tsconfig。 |
| `01f66d9` | 2026-07-03 | shared | 新增 shared package。 |
| `cc0b8d3` | 2026-07-03 | repo | 新增 shared TypeScript config。 |
| `0097bb6` | 2026-07-03 | repo | 新增 npm workspace root。 |
| `ba5ec25` | 2026-07-03 | repo | 新增 repository skeleton。 |
| `15028b6` | 2026-07-03 | docs | 新增 initial Codex task chain。 |
| `c49500b` | 2026-07-03 | docs | 新增 core logic design。 |
| `13a4ff3` | 2026-07-03 | docs | 新增 v0.1 super event editor plan。 |
| `a457b53` | 2026-07-03 | docs | 新增 Codex project rules。 |
| `ef0f9fd` | 2026-07-03 | docs | 定义 SoulForge v0.1 方向。 |

## 当前工作区变更快照

截至本文件创建时，工作区仍有未提交变更。重要路径包括：

- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/styles.css`
- `bridge/SoulForge.Bridge/EnvelopeInspection.cs`
- `bridge/SoulForge.Bridge/DcxPayloadProbe.cs`
- `bridge/SoulForge.Bridge/HeaderEvidenceScanner.cs`
- `bridge/SoulForge.Bridge/SyntheticBinderFixtureExports.cs`
- `bridge/SoulForge.Bridge/scripts/verify-synthetic-core-fixtures.ps1`
- `docs/CODEX_NEXT_ACTIONS.md`
- `docs/LOGIC_LAYER_REVIEW.md`
- `docs/LOCAL_VALIDATION_QUEUE.md`
- `docs/PROJECT_STATE.md`
- `packages/core/src/preview/openResourcePreview.ts`
- `packages/shared/src/types.ts`
- `scripts/verify-synthetic-core-fixtures.mjs`

注意：这些未提交变更包含多轮工作，不应默认理解为同一次逻辑提交。提交前需要按主题拆分，推荐最少拆成：

1. CodexPro / 项目状态 / 验证队列文档。
2. Bridge inspect：header evidence + DCX payload probe + BND synthetic evidence。
3. Core structured preview/container summary evidence 扩展。
4. Desktop native inspect evidence UI。
5. AI sidebar / patch engine / workspace scanner 相关 UI 和工具改动。

## 下一次提交建议

优先级最高的提交链：

1. `docs: add development log and validation queue`
2. `bridge: add dcx payload and synthetic binder evidence`
3. `core: surface native container evidence summaries`
4. `desktop: show native inspection evidence clues`

提交前最低验证：

```bash
npm run typecheck
npm test
```

Bridge 相关提交在标记完成前还要跑：

```powershell
npm run bridge:build
npm run bridge:verify:synthetic
```

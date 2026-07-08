# SoulForge v0.3 — Fixture-Confirmed Parser 里程碑

v0.3 的目标是把早期低置信候选解析，逐步升级为经过 fixture 验证的资源导出。

这个阶段不是扩 UI，而是让超级编辑器的资源理解更可信。AI 要像 Cursor 一样改 Mod，前提是它看到的 event、map、param、msg、BND child inventory 不能全靠猜。

## 产品目标

把只有候选线索的资源理解，升级为可测试、可审查、带证据的导出结果。

核心资源链是：

```text
event -> map -> param -> msg
```

同时 BND child inventory 是这条链路的容器入口。没有 BND child listing，很多真实资源仍然只能停在包络层。

目标不是一次性征服所有格式，而是先把最重要的候选输出升级成稳定、可验证、AI 和 UI 都能依赖的结构。

## 当前进度快照

- FMG 已有 synthetic fixture confirmed path，并已通过 export-msg 接入。
- Event 和 PARAM synthetic fixture helper 已存在于 `SyntheticFixtureExports.cs`，并已通过 `SemanticCandidateExports.cs` 接入 export-event / export-param 路由。
- Map synthetic fixture helper 已存在于 `SyntheticMapFixtureExports.cs`，并已通过 `SemanticCandidateExports.cs` 接入 export-map 路由。
- Event / PARAM / map 语义导出顺序是：先守住 DCX/BND 容器边界，再尝试 synthetic fixture confirmed path，最后才回落到低置信 native candidate scan。
- BND synthetic fixture helper 已存在于 `SyntheticBinderFixtureExports.cs`，但仍需要后续单独设计 inspect/export 接线。
- Synthetic fixture 用来验证 Bridge result shape、稳定 ID、typed fields、instruction argument roles、child inventory 和 diagnostic labeling。
- 这些 fixture 都不代表 FromSoftware 原生格式权威。
- Native FMG、BND、EMEVD、PARAM、MSB 仍需要真实 fixture 或明确格式规则证明。
- Guarded native candidates 和 raw fallback 仍然保留，并且必须显式标注低置信度。
- 当前 caveat：BND helper 仍需要后续单独设计 inspect/export 接线；Bridge dotnet smoke 需要在允许直接运行 dotnet / PowerShell 的本地终端执行。

## 必要 parser 升级

### 1. FMG 文本表 parser

当前状态：

- SoulForge synthetic FMG fixture 可通过 `MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED` 产生 confirmed fixture entries；
- FMG-like payload 可通过 `MSG_FMG_TABLE_CANDIDATE` 产生 guarded table candidate；
- raw string fallback 仍可能用 file offset 作为临时 text ID。

v0.3 目标：

- fixture-confirmed native FMG text ID table parsing；
- 稳定 textId 提取；
- 可用时推断文本类别；
- raw fallback 继续存在，但必须和 confirmed ID 区分；
- 如果支持大小端差异，就要有对应 fixture。

验收：

- confirmed FMG fixture 能导出稳定 `MsgExport.entries`；
- raw offset fallback 不被当作 confirmed game text ID；
- malformed FMG 返回结构化 diagnostics，不崩溃。

### 2. BND child table listing

当前状态：

- Inspect 能暴露低置信 visible-string `binderChildCandidate` evidence；
- `SyntheticBinderFixtureExports.cs` 已定义 synthetic BND child inventory helper；
- 还没有公开 Bridge route 接入该 helper。

v0.3 目标：

- fixture-confirmed BND3/BND4 child table listing；
- child name、offset、packed size、unpacked size；
- child resource kind inference；
- 不主动提取大型 child payload，除非用户明确请求。

验收：

- BND fixture 能产生 child inventory；
- visible-string fallback 仍标注低置信；
- offsets 和 sizes 在使用前必须 bounded validation。

### 3. EMEVD 事件和指令导出

当前状态：

- EMEVD candidate export 可暴露低置信 event ID candidates；
- synthetic event fixture helper 可导出 event ID、instruction row、一个 numeric argument、argument role 和高置信 fixture metadata；
- router wire-up 已完成：export-event 会先识别 `EMEVD_SYNTHETIC_FIXTURE_CONFIRMED`，再回落到低置信 candidate scan。

v0.3 目标：

- fixture-confirmed event table parsing；
- event IDs；
- instruction list shape；
- numeric arguments；
- raw instruction metadata；
- recognized / unknown instruction semantics 的置信度标记。

验收：

- event fixture 能导出 `EventExport.events` 和 instruction arrays；
- unknown instructions 保留 raw structured data；
- event calls、flags、entity IDs、text IDs、param IDs 只有在 instruction semantics 支撑时才给高置信。

### 4. PARAM 行和字段导出

当前状态：

- PARAM candidate export 可暴露低置信 row ID candidates；
- synthetic PARAM fixture helper 可导出 row IDs、row names、每行一个 typed field 和高置信 fixture metadata；
- router wire-up 已完成：export-param 会先识别 `PARAM_SYNTHETIC_FIXTURE_CONFIRMED`，再回落到低置信 candidate scan；
- synthetic PARAM field value 已避免 bool/int 条件表达式类型混用，保持 JSON shape 不变。

v0.3 目标：

- fixture-confirmed PARAM row table parsing；
- row IDs；
- row names；
- 有 layout evidence 时导出 typed fields；
- unknown fields 保留，但不发明语义。

验收：

- PARAM fixture 能导出 `ParamExport.rows`；
- fields 只有在 layout evidence 存在时才 typed；
- candidate row IDs 不能和 confirmed rows 混在一起而不标置信度。

### 5. MSB 实体、区域、transform 和 model 导出

当前状态：

- MSB candidate export 可暴露低置信 visible entity-name candidates；
- synthetic map fixture helper 可导出 entities、regions、position、rotation、size 和高置信 fixture metadata；
- router wire-up 已完成：export-map 会先识别 `MSB_SYNTHETIC_FIXTURE_CONFIRMED`，再回落到低置信 visible-name candidate scan。

v0.3 目标：

- fixture-confirmed MSB entity 和 region tables；
- entity IDs；
- names；
- kinds；
- model references；
- positions、rotations、region sizes；
- raw unknown sections preserved。

验收：

- MSB fixture 能导出 `MapExport.entities` 和 `MapExport.regions`；
- transforms 不能伪造；
- visible-name fallback 仍保持低置信。

## 引用图升级

v0.3 应提高引用置信度。

高置信引用只允许来自 parser 或 instruction semantics 明确标注的 value role。裸数字碰巧匹配仍然只能是 medium 或 low confidence。

必须升级：

- event instruction role mapping feeds reference builder；
- confirmed map entity IDs 可以匹配 event args；
- confirmed param rows 可以匹配 typed param references；
- confirmed text IDs 可以匹配 text references；
- ambiguous numeric matches 继续保持 uncertain。

## 测试要求

不能提交真实游戏资产或用户 Mod 文件。

测试来源：

- tiny synthetic binary fixtures；
- handcrafted JSON bridge fixtures；
- malformed samples；
- bridge command smoke tests。

必要命令：

```bash
npm install
npm run typecheck
npm run build
npm test --workspaces --if-present
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
```

Bridge smoke checks 应覆盖：

```bash
dotnet run --project bridge/SoulForge.Bridge -- inspect path/to/synthetic.bin
dotnet run --project bridge/SoulForge.Bridge -- export-msg path/to/synthetic.fmg
dotnet run --project bridge/SoulForge.Bridge -- export-event path/to/synthetic.emevd
dotnet run --project bridge/SoulForge.Bridge -- export-param path/to/synthetic.param
dotnet run --project bridge/SoulForge.Bridge -- export-map path/to/synthetic.msb
```

仓库已有 smoke scripts：

```powershell
.\bridge\SoulForge.Bridge\scripts\verify-magic.ps1
.\bridge\SoulForge.Bridge\scripts\verify-fmg-fixture.ps1
.\bridge\SoulForge.Bridge\scripts\verify-synthetic-core-fixtures.ps1
```

`verify-synthetic-core-fixtures.ps1` 覆盖 FMG、event、PARAM、map，不提交二进制 fixture。BND synthetic smoke 仍留给 issue #2。

## CodexPro 验证记录

2026-07-04：

- `npm run typecheck`：通过。
- `npm run build`：失败于本地依赖状态，Rollup 找不到 Linux optional dependency `@rollup/rollup-linux-x64-gnu`；这是 node_modules / npm optional dependency 安装问题，不是本次 TypeScript 或 Bridge 路由改动的编译错误。
- `dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj` 与 `bridge/SoulForge.Bridge/scripts/verify-synthetic-core-fixtures.ps1`：CodexPro safe bash allowlist 不允许直接运行 dotnet / PowerShell；需要在本地终端或 full bash 模式下执行。

## 硬边界

- 不复制外部 parser 实现；
- 不提交真实游戏资产；
- 不在 native fixture 证明前声称权威原生解析；
- 不绕过 Bridge 解析 native binary；
- renderer 不直接解析 native binary resources；
- 不直接写用户 Mod 工作区；
- unsupported 和 failed 必须保持结构化。

## 完成定义

v0.3 完成时，超级编辑器至少能展示核心链路上的 confirmed resource data：

```text
confirmed text entries
confirmed binder child inventory
confirmed event IDs and instruction arrays
confirmed param rows
confirmed map entities / regions
```

候选输出仍可作为 fallback 存在，但 UI 和 AI 必须能区分 confirmed parser output 与 low-confidence evidence。

## 和完整超级编辑器目标的关系

v0.3 让资源理解可靠到足以支撑大规模修改。

它还不负责让 AI 安全执行全局修改。全局修改需要后续 Patch Engine、依赖分析、验证、备份、暂存写入、回滚和操作日志。

# SoulForge 项目状态快照（Checkpoint）

生成时间：2026-07-08

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

## 十一、当前工程状态（v0.3）

当前仓库仍处在 v0.3 parser plumbing 阶段。

v0.3 的真实目标是：

```text
low-confidence candidate parser
  -> fixture-confirmed parser + evidence-first semantic bridge
```

这只是可信度地基，不代表 native FromSoftware parser / writer 已经完成。

## 十二、当前完成能力

### 1. Bridge 语义分层

- inspect：只输出 evidence，不输出假语义；
- export-msg / export-event / export-param / export-map；
- DCX / BND 容器边界识别；
- raw fallback + candidate scan + synthetic fixture 三层结构。

### 2. Synthetic fixture 系统

已完成并接入 router：

```text
MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED
EMEVD_SYNTHETIC_FIXTURE_CONFIRMED
PARAM_SYNTHETIC_FIXTURE_CONFIRMED
MSB_SYNTHETIC_FIXTURE_CONFIRMED
```

### 3. Event / Param / Map 路由顺序

```text
Container boundary -> Synthetic fixture -> Low-confidence fallback
```

### 4. BND 状态

- `SyntheticBinderFixtureExports` 已存在；
- BND synthetic child inventory 接线仍是后续任务；
- binderChildCandidate 仍为 low-confidence evidence；
- native BND parser / writer 尚未完成。

## 十三、当前已知问题

### 1. Build 环境问题

曾出现 Rollup optional dependency 缺失：

```text
@rollup/rollup-linux-x64-gnu
```

这更像 node_modules / optional deps 环境问题，不应直接判断为核心代码逻辑错误。

### 2. CodexPro 执行限制

某些 safe bash 环境可能不允许直接运行 dotnet / PowerShell。

Bridge smoke 可能需要本地终端执行。

## 十四、当前开发优先级

### P0：维持 v0.3 任务边界

Codex 当前只应做窄任务：

- synthetic fixture router wire-up；
- 类型小修；
- smoke script；
- 必要 build 修复。

不得自由扩展到：

- v0.5 UI；
- Patch Engine 大改；
- native parser；
- writer；
- Blender / 3D；
- 本地 LLM；
- vector DB。

### P1：BND 子资源系统

目标：

- BND child inventory fixture confirmed；
- child table listing；
- offset / size / kind / name；
- 保留 visible-string fallback 为 low-confidence evidence。

### P2：为 v0.5 建地基

只在 v0.3 稳定后推进：

- native DCX / BND；
- writer contracts；
- unified patch model；
- SQLite reference graph；
- operation log / patch history；
- AI tool registry；
- Patch Engine staging / validation / rollback。

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
SoulForge 已经有 evidence-first Bridge 地基、产品决策和 v0.5 架构裁定，但真实 native parser / writer / Patch Engine 完整闭环仍未完成。
```

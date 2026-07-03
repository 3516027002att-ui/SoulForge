# SoulForge 项目源起与超级编辑器构想

## 1. 项目源起

SoulForge 的源头来自一个很朴素、但非常强烈的痛点：传统魂游 Mod 制作太像“摸黑拆炸弹”。

早期修改《只狼》Mod 时，常见工作流是：先用特定工具解包，再在一堆 `.dcx`、`.bnd`、Lua、事件、参数和地图文件里手工寻找目标；找到 Lua 后，往往只能用记事本或非常简陋的文本编辑器修改；改完再重新打包、进游戏测试。游戏不一定报错，事件可能只是悄悄不触发，或者角色、区域、Flag、特效之间的关联变得异常。

那种体验甚至比过时的大学 C 语言 IDE 还差：老 IDE 至少有编译错误，魂游 Mod 很多时候只有沉默、闪退、或者“好像哪里坏了”。

SoulForge 想解决的不是“多做一个编辑器”，而是把过去这种工作流：

```text
解包 -> 记事本 -> 猜 ID -> 打包 -> 进游戏撞墙
```

变成：

```text
打开工程 -> 查询证据链 -> 理解引用关系 -> 生成修改计划 -> 验证 -> 安全保存 -> 可回滚
```

一句话说，SoulForge 的第一性目标是：

```text
Stop modding in the dark.
```

也就是：别再摸黑改魂游。

## 2. 超级编辑器是什么

SoulForge 的“超级编辑器”不是把 Smithbox、DSMapStudio、DarkScript、Yabber、WitchyBND、Lua 编辑器简单缝起来。

它的定位是：

```text
AI-native FromSoftware Mod Workbench
```

也就是面向 FromSoftware / Soulsborne 游戏 Mod 的 AI 原生工作台。

传统编辑器的中心是“文件”或“表格”。SoulForge 的中心是“资源之间的证据关系”。

一个事件不应该只是一段 EMEVD 文本。它应该被展开成一张可以追踪的证据图：

```text
Event
  -> Instructions
  -> Flags
  -> Map Entities / Regions
  -> Param Rows
  -> Text Entries
  -> Diagnostics
```

AI 不应该直接看一堆数字就开始解释。AI 必须先通过 SoulForge 的索引、引用图和证据包，知道：

- 这个 Event 属于哪个 map/event 文件；
- 它读写了哪些 Flag；
- 它调用了哪些其他 Event；
- 它引用了哪些 Entity ID / Region ID；
- 这些 ID 在地图里到底对应什么角色、物体、区域或触发器；
- 它可能关联哪些 Param 行；
- 它可能关联哪些文本；
- 哪些结论是确定的，哪些只是推测，哪些完全没有证据。

SoulForge 的核心气质不是“万能”，而是“带证据地理解”。

## 3. 为什么不是 Smithbox 换皮

Smithbox、DSMapStudio、DarkScript 等工具非常重要，它们证明了 FromSoftware 资源可以被传统编辑器读写，也提供了大量可参考的用户体验和领域知识。

但 SoulForge 不复制这些工具的代码，也不把自己定位成传统编辑器替代品。

SoulForge 的差异点是：

1. **AI-native**：从架构一开始就为 AI 工具调用、证据上下文、计划模式、完全权限模式和安全保存设计。
2. **跨资源理解**：不只打开事件文件，还要把事件和 map、param、msg 串起来。
3. **证据链优先**：AI 的解释和修改必须基于 `ReferenceEdge`、`EventEvidenceReport`、diagnostics 等结构化事实。
4. **安全写入**：所有修改都必须经过 staging、validation、backup、atomic save、rollback，不能裸写用户 Mod 文件。
5. **轻量优先**：不在 v0.1 做 3D 视口、Blender、embedding、本地大模型，避免软件变成资源怪物。

传统工具更像“编辑器”。SoulForge 更像“魂游 Mod 工程大脑”。

## 4. v0.1：Super Event Editor

第一版不是全能编辑器，而是：

```text
Super Event Editor v0.1
```

它的核心链路是：

```text
event -> map -> param -> msg
```

其中：

- `event`：事件脚本，目标是解析 EMEVD/Event 结构、事件 ID、指令、参数、调用链和 Flag 操作。
- `map`：地图语义接口层，目标是提取 MSB 中的 Entity、Region、坐标、旋转、名字、模型引用等。
- `param`：参数表，目标是让 AI 查到 ParamName、RowID、RowName、字段和值。
- `msg`：文本资源，目标是为事件、道具、NPC、提示和剧情提供语义锚点。

`menu`、`script`、`action`、`ai`、`sfx` 等资源可以先做文件级索引，但不是 v0.1 深解析目标。

v0.1 的验收画面应该是：

1. 用户打开一个 ModEngine 风格的原生 Mod 覆盖目录；
2. SoulForge 扫描 `event / map / param / msg` 等目录；
3. 用户打开一个事件；
4. SoulForge 展示事件结构；
5. 右侧显示该事件引用的地图实体、区域、参数、文本和置信度；
6. AI 侧边栏可以基于这些证据解释事件；
7. 不支持的资源诚实显示 `unsupported` 或 `failed`；
8. 软件保持响应，不全量加载整个工程。

## 5. 打开的对象

SoulForge v0.1 面向的是原生 ModEngine 覆盖目录，而不是要求用户提前手动解包的“松散文本工程”。

也就是说，用户打开的目录里可能直接包含：

```text
*.dcx
*.bnd
*.emevd.dcx
*.msb.dcx
*.parambnd.dcx
*.msgbnd.dcx
*.fmg
```

SoulForge 应该通过自己的 Bridge 层读取这些封装资源，并导出 AI 和 UI 可以消费的结构化 JSON。

如果将来用户打开游戏原版目录，默认应强制只读，避免破坏原始游戏文件。

## 6. 技术路线

当前技术路线是：

```text
Electron + React + TypeScript desktop shell
  -> packages/core 核心逻辑
  -> packages/shared 类型和 schema
  -> C# SoulForge.Bridge 解析 FromSoftware 资源
  -> SQLite + FTS5 索引
  -> AI Sidebar / Tool Registry / future MCP adapter
```

核心原则：

- TypeScript / Electron 做 UI、工作区、索引、AI 工具层；
- C# Bridge 负责 FromSoftware 二进制资源 inspect/export；
- Electron renderer 不直接访问文件系统；
- Bridge 输出结构化 JSON；
- 解析不了就返回 `unsupported`，解析失败就返回 `failed`；
- 不伪装成功，不让 AI 建立在假数据上。

## 7. AI 适配方式

SoulForge 的 AI 侧边栏必须存在，但 v0.1 可以先是占位或工具控制台。

未来 AI 侧边栏应支持：

- Provider：Mock / OpenAI / Anthropic；
- Thinking intensity：fast / normal / deep / extreme；
- Mode：plan / normal / full permission；
- 当前资源上下文；
- 可调用工具列表；
- 引用关系、诊断和证据包。

AI 不能直接操作文件系统。AI 只能调用 SoulForge 暴露的工具，例如：

```text
search_resources
open_resource
list_events
open_event
find_references
open_map_entity
open_param_row
open_text
explain_event
propose_patch
validate_patch
apply_patch
```

其中 `apply_patch` 必须走 Patch Engine。

完全权限模式不是让 AI 裸写文件。它的含义是：AI 可以自动运行被批准的工具，但仍然不能绕过 staging、validation、backup 和 rollback。

## 8. 安全保存模型

魂游资源不是普通文本。错误写入可能导致工具打不开、事件失效、地图引用错乱或游戏闪退。

所以 SoulForge 的保存流程必须是：

```text
change request
  -> patch proposal
  -> staging copy
  -> apply patch to staging
  -> validation
  -> backup original
  -> atomic replace
  -> re-parse saved file
  -> update index
  -> rollback available
```

验证失败时：

- Normal mode：停止，不保存，诊断交给用户；
- Plan mode：只展示计划和 diff，永不保存；
- Full permission mode：AI 可以在 staging 副本上有限重试，但原文件必须保持不动。

原则是：坏文件应该坏在 staging 里，而不是坏在用户的 Mod 目录里。

## 9. 地图与 3D 的边界

SoulForge v0.1 要读懂 map，但不是做完整 3D 编辑器。

v0.1 需要的是地图的“事件接口层”：

- Entity ID；
- Region ID；
- 角色、物体、区域、碰撞、地图物件；
- 坐标、旋转、缩放；
- 名字、模型引用；
- 被哪些事件引用。

AI 最适合编辑的是这种结构化场景数据，而不是直接捏模型网格。

Blender / 3D / mesh / material / animation 可以预留 MCP 或 Bridge 接口，但 v0.1 不实现。否则项目会过早变成半成品 3D 软件。

## 10. 轻量化原则

SoulForge 不能变成打开一个 Mod 目录就风扇起飞的怪物。

v0.1 必须遵守：

- 启动时只轻扫描，不全量解析；
- hash 懒计算；
- 解析按需触发；
- 后台任务可取消；
- Bridge 调用有超时；
- 大列表虚拟滚动；
- 大文件只预览片段；
- 不在 React state 里塞大二进制；
- AI 侧边栏默认不消耗 API；
- 不做 3D 视口；
- 不做 embedding / vector DB；
- 不内置本地大模型。

SoulForge 的体验应该是轻、准、稳，而不是炫但笨重。

## 11. 当前已落地的核心代码

当前仓库已经开始从“文档项目”转成“工程骨架”。已落地的复杂逻辑包括：

- `packages/shared/src/resourceSymbols.ts`：Event / Map / Param / Msg 的结构化符号模型；
- `packages/core/src/references/referenceBuilder.ts`：事件引用图构建器；
- `packages/core/src/references/eventEvidence.ts`：事件证据收集与 Markdown 渲染；
- `packages/core/src/bridge/runBridge.ts`：安全 C# Bridge 调用器；
- `packages/core/src/patch/patchEngine.ts`：staging / validation / backup / atomic save 的 Patch Engine 雏形；
- `apps/desktop`：轻量 Electron + React 桌面壳、资源扫描、预览、AI 侧边栏占位。

下一步应优先做：

```text
npm install
npm run typecheck
修复编译错误
启动 Electron app
确认 open workspace -> scan -> preview 正常
```

不要立刻接 SoulsFormats。先让骨架稳定，再做真实资源解析。

## 12. 最终愿景

SoulForge 不是为了让 AI “替人乱改 Mod”。

它是为了让 AI 和人都能终于看清楚魂游 Mod 工程里那些长期被数字、封包和工具割裂隐藏起来的关系。

当用户问：

```text
这个事件为什么不触发？
这个 Boss 二阶段区域在哪里？
这个 Flag 被谁设置？
这个 Entity ID 到底是谁？
我能不能把这个触发区往门口挪一点？
```

SoulForge 应该能回答：

```text
我能确认什么。
我推测什么。
我不知道什么。
证据在哪里。
如果要修改，改哪些文件。
保存前如何验证。
坏了如何回滚。
```

这就是这个超级编辑器的真正形态：

```text
魂游 Mod 的 Cursor。
FromSoftware 资源的证据图谱。
AI 原生的安全工程工作台。
```
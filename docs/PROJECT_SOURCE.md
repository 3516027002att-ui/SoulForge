# SoulForge 项目源起与超级编辑器构想

SoulForge 的目标是做一个面向《只狼》和魂系游戏 Mod 的 AI 超级编辑器。

它要解决的不是“多做一个参数表工具”，而是让 AI 像 Cursor 修改代码一样理解、规划和修改 Mod。用户说出目标，SoulForge 负责找到证据、分析引用、生成补丁、验证修改，并保证可以回滚。

## 1. 项目源起

传统魂游 Mod 制作太像摸黑拆炸弹。

早期修改《只狼》Mod 时，常见工作流是：先用工具解包，再在一堆 `.dcx`、`.bnd`、Lua、事件、参数和地图文件里手工寻找目标；找到文件后，往往只能用简陋文本工具或分散编辑器修改；改完再重新打包、进游戏测试。游戏不一定报错，事件可能只是悄悄不触发，或者角色、区域、Flag、特效之间的关联变得异常。

那种体验甚至比过时的大学 C 语言 IDE 还差。老 IDE 至少会告诉你编译错误，魂游 Mod 很多时候只有沉默、闪退，或者“好像哪里坏了”。

SoulForge 想把过去这种工作流：

```text
解包 -> 记事本 -> 猜 ID -> 打包 -> 进游戏撞墙
```

变成：

```text
打开工程 -> 查询证据链 -> 理解引用关系 -> 生成修改计划 -> 验证 -> 安全保存 -> 可回滚
```

一句话：

```text
别再摸黑改魂游 Mod。
```

## 2. 超级编辑器是什么

SoulForge 的“超级编辑器”不是把 Smithbox、DSMapStudio、DarkScript、Yabber、WitchyBND、Lua 编辑器简单缝起来。

它的核心定位是：

```text
魂游 Mod 的 Cursor
```

传统编辑器的中心是文件、表格或单个资源。SoulForge 的中心是资源之间的证据关系。

一个事件不应该只是一段看不懂的 EMEVD 或一堆数字。它应该被展开成一张可以追踪的证据图：

```text
事件
  -> 指令
  -> Flag
  -> 地图实体 / 区域
  -> 参数行
  -> 文本条目
  -> 诊断信息
```

AI 不能直接看一堆数字就开始解释。AI 必须通过 SoulForge 的索引、引用图和证据包知道：

- 这个事件属于哪个地图或事件文件；
- 它读写了哪些 Flag；
- 它调用了哪些其他事件；
- 它引用了哪些 Entity ID / Region ID；
- 这些 ID 在地图里到底对应什么角色、物体、区域或触发器；
- 它可能关联哪些参数行；
- 它可能关联哪些文本；
- 哪些结论是确定的，哪些只是推测，哪些完全没有证据。

SoulForge 的核心气质不是“万能”，而是“带证据地理解，并且安全地修改”。

## 3. 为什么不是现有工具换皮

Smithbox、DSMapStudio、DarkScript 等工具非常重要，它们证明了 FromSoftware 资源可以被传统编辑器读写，也提供了大量可参考的用户体验和领域知识。

但 SoulForge 不复制这些工具的代码，也不把自己定位成传统编辑器替代品。

SoulForge 的差异点是：

1. AI 原生：从架构一开始就为 AI 工具调用、证据上下文、计划模式、完整权限模式和安全保存设计。
2. 跨资源理解：不只打开单个事件或参数表，还要把 event、map、param、msg 串起来。
3. 证据链优先：AI 的解释和修改必须基于引用边、证据报告、诊断和置信度。
4. 安全写入：所有修改都必须经过暂存、验证、备份、原子保存和回滚，不能裸写用户 Mod 文件。
5. 轻量优先：不在早期阶段做完整 3D 视口、Blender、本地大模型或向量数据库，避免软件过早变成资源怪物。

传统工具更像编辑器。SoulForge 更像魂游 Mod 工程大脑。

## 4. 核心资源链

SoulForge 当前最重要的理解链路是：

```text
event -> map -> param -> msg
```

其中：

- event：事件逻辑，目标是解析事件 ID、指令、参数、调用链和 Flag 操作；
- map：地图语义接口层，目标是提取实体、区域、坐标、旋转、名字、模型引用等；
- param：参数表，目标是让 AI 查到 ParamName、RowID、RowName、字段和值；
- msg：文本资源，目标是为事件、道具、NPC、提示和剧情提供语义锚点。

menu、script、action、ai、sfx 等资源可以先做文件级索引。它们重要，但不是第一阶段的深解析核心。

## 5. 用户打开的对象

SoulForge 面向的是原生 ModEngine 覆盖目录，而不是要求用户提前手动解包的“松散文本工程”。

用户打开的目录里可能直接包含：

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
Electron + React + TypeScript 桌面端
  -> packages/core 核心逻辑
  -> packages/shared 类型和 schema
  -> C# SoulForge.Bridge 解析资源
  -> SQLite + FTS5 索引
  -> AI 侧边栏 / 工具注册表 / 未来 MCP 适配
```

核心原则：

- TypeScript / Electron 做 UI、工作区、索引和 AI 工具层；
- C# Bridge 负责 FromSoftware 二进制资源 inspect/export；
- Electron renderer 不直接解析原生二进制；
- Bridge 输出结构化 JSON；
- 解析不了就返回 unsupported，解析失败就返回 failed；
- 不伪装成功，不让 AI 建立在假数据上。

## 7. AI 适配方式

AI 侧边栏是 SoulForge 的核心功能，而不是锦上添花。

AI 侧边栏应支持：

- Provider：Mock / OpenAI / Anthropic；
- 思考强度：fast / normal / deep / extreme；
- 模式：plan / normal / full permission；
- 当前资源上下文；
- 可调用工具列表；
- 引用关系、诊断和证据包。

AI 不能直接操作文件系统。AI 只能调用 SoulForge 暴露的工具，例如搜索资源、打开事件、查找引用、解释文本、生成补丁、验证补丁等。

其中真正写入必须走 Patch Engine。

完整权限模式不是让 AI 裸写文件。它的含义是：AI 可以自动运行被批准的工具，但仍然不能绕过暂存、验证、备份和回滚。

## 8. 安全保存模型

魂游资源不是普通文本。错误写入可能导致工具打不开、事件失效、地图引用错乱或游戏闪退。

所以 SoulForge 的保存流程必须是：

```text
修改请求
  -> 补丁计划
  -> 暂存副本
  -> 对暂存副本应用补丁
  -> 验证
  -> 备份原文件
  -> 原子替换
  -> 重新解析
  -> 更新索引
  -> 可回滚
```

验证失败时：

- Normal mode：停止，不保存，诊断交给用户；
- Plan mode：只展示计划和 diff，永不保存；
- Full permission mode：AI 可以在暂存副本上有限重试，但原文件必须保持不动。

原则是：坏文件应该坏在 staging 里，而不是坏在用户的 Mod 目录里。

## 9. 地图与 3D 的边界

SoulForge 要读懂 map，但早期不是完整 3D 编辑器。

第一阶段需要的是地图的事件接口层：

- Entity ID；
- Region ID；
- 角色、物体、区域、碰撞、地图物件；
- 坐标、旋转、缩放；
- 名字、模型引用；
- 被哪些事件引用。

AI 最适合编辑的是这种结构化场景数据，而不是直接捏模型网格。

Blender / 3D / mesh / material / animation 可以预留 MCP 或 Bridge 接口，但不应过早实现。否则项目会变成半成品 3D 软件。

## 10. 轻量化原则

SoulForge 不能变成打开一个 Mod 目录就风扇起飞的怪物。

必须遵守：

- 启动时只轻扫描，不全量解析；
- hash 懒计算；
- 解析按需触发；
- 后台任务可取消；
- Bridge 调用有超时；
- 大列表虚拟滚动；
- 大文件只预览片段；
- 不在 React state 里塞大二进制；
- AI 侧边栏默认不消耗 API；
- 不做完整 3D 视口；
- 不做 embedding / vector DB；
- 不内置本地大模型。

SoulForge 的体验应该是轻、准、稳，而不是炫但笨重。

## 11. 当前已落地的核心代码

当前仓库已经开始从文档项目转成工程骨架。已落地或正在推进的复杂逻辑包括：

- resourceSymbols：Event / Map / Param / Msg 的结构化符号模型；
- referenceBuilder：引用图构建器；
- eventEvidence：事件证据收集与渲染；
- runBridge：安全 C# Bridge 调用器；
- patchEngine：暂存、验证、备份、原子保存的 Patch Engine 雏形；
- desktop app：轻量 Electron + React 桌面壳、资源扫描、预览、AI 侧边栏；
- synthetic fixtures：用于验证 parser plumbing 的小型自有测试格式。

下一步应优先让骨架稳定，然后再逐步替换成真实资源解析。

## 12. 最终愿景

SoulForge 不是为了让 AI 替人乱改 Mod。

它是为了让 AI 和人都能看清楚魂游 Mod 工程里那些长期被数字、封包和工具割裂隐藏起来的关系。

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

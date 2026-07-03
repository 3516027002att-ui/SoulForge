# SoulForge 早期工程地基

这个文档记录 SoulForge 的早期工程目标。

它不是一个独立产品名，也不是对外宣传口径。SoulForge 对外只有一个清晰目标：做《只狼》和魂系 Mod 的 AI 超级编辑器，让 AI 像 Cursor 改代码一样，在证据、计划、补丁和回滚保护下修改 Mod。

早期阶段的任务不是一次性做完全体，而是先把最重要的资源理解链路打通。

## 1. 早期目标

SoulForge 早期工程重点是建立一个轻量、可验证、AI 可用的 Mod 理解层。

核心链路是：

```text
event -> map -> param -> msg
```

早期目标不是替代 Smithbox 或 DSMapStudio，而是让人和 AI 能带着证据理解事件逻辑：

- 这是什么事件；
- 它读写了哪些 Flag；
- 它引用了哪些地图实体或区域；
- 它可能关联哪些参数行；
- 哪些文本条目提供语义说明；
- 哪些结论是确定的，哪些只是候选线索。

## 2. 暂时不做什么

早期阶段必须避免掉进“大而全 3D 编辑器”的陷阱。

暂时不做：

- 完整 3D 地图视口；
- Blender bridge 实现；
- 模型和网格编辑；
- 动画 / TAE 编辑；
- 没有验证的 AI 自动二进制重写；
- 完整插件系统；
- embedding / vector database / RAG；
- 本地大模型运行时；
- 对 Smithbox 的完整替代。

这些能力可以预留方向，但不能挤占早期地基。

## 3. 工作区模型

SoulForge 打开的是原生 Mod 目录，通常是 ModEngine 覆盖目录。

典型逻辑结构：

```text
<MOD_WORKSPACE>/
  event/
  map/
  param/
  msg/
  menu/
  script/
  action/
  ai/
  sfx/
  ...
```

工作区里可能直接包含 FromSoftware 封装资源：

```text
*.dcx
*.bnd
*.bdt
*.emevd.dcx
*.msb.dcx
*.parambnd.dcx
*.msgbnd.dcx
*.fmg
```

SoulForge 不应要求用户手动解包后才能打开工作区。

## 4. 架构

推荐 monorepo 结构：

```text
apps/desktop/          桌面端
packages/shared/       共享类型、schema、诊断
packages/core/         工作区扫描、索引、引用图、Patch Engine
bridge/SoulForge.Bridge/ C# Bridge，负责资源 inspect/export
docs/                  项目规则、架构和 Codex 任务
```

### 4.1 桌面端

桌面端负责用户体验：

- 开始页；
- 最近项目；
- 工作区选择；
- 顶部资源模式导航；
- 文件 / 资源树；
- 资源查看器；
- 引用面板；
- AI 侧边栏；
- 诊断 / 日志面板。

桌面端 renderer 不应直接解析大型二进制格式。

### 4.2 Core 包

Core 包负责通用逻辑：

- 工作区发现；
- Resource URI 生成；
- 索引结构；
- 搜索；
- 引用构建；
- 补丁计划模型；
- 验证结果模型。

### 4.3 Bridge

Bridge 是 C# helper process，负责 FromSoftware 资源的二进制 inspect 和 JSON export。

Bridge 应暴露这些命令：

```text
soulforge-bridge inspect <file>
soulforge-bridge export-event <file>
soulforge-bridge export-map <file>
soulforge-bridge export-param <file>
soulforge-bridge export-msg <file>
```

每个命令都必须返回结构化 JSON。格式不支持时，返回 unsupported，而不是假装解析成功。

## 5. UI 结构

### 5.1 开始页

开始页应该像真实项目工具，而不是玩具文件选择器。

核心区域：

- 最近项目；
- 打开 Mod 目录；
- 游戏 profile 选择；
- 设置 / API Key；
- 诊断 / 工具链状态。

### 5.2 工作区壳

打开工作区后，顶部应暴露资源模式导航：

```text
Events | Params | Text | Maps | Files | AI | Settings
```

这类导航可以参考现有工具的工作流，但实现必须重写，不复制外部项目代码。

### 5.3 布局

推荐布局：

```text
项目 / 游戏 / 模式导航
资源树 | 主资源视图 | AI 侧边栏
诊断 / 引用 / 日志 / 补丁预览
```

AI 侧边栏必须存在，早期可以先作为工具控制台。

## 6. 资源模型

每个被索引对象都应该有稳定 URI。

示例：

```text
file://event/m11_00_00_00.emevd.dcx
event://m11_00_00_00/11002800
map://m11_00_00_00/entity/1102800
param://SpEffectParam/123456
msg://item/1000
```

最小资源元数据包括：sourceUri、sourcePath、game、resourceKind、parseStatus 和 diagnostics。

## 7. 事件理解管线

### 7.1 扫描

扫描工作区内的 event / map / param / msg 相关目录和封装资源。

启动时不要深解析所有文件。先做轻量索引：

- path；
- extension；
- resource kind guess；
- size；
- mtime；
- 可选懒 hash。

### 7.2 Inspect

资源被打开或需要索引时，调用 Bridge inspect。

Inspect 应判断：

- 资源类型；
- 是否是容器；
- 可能的内部文件线索；
- 是否支持深度导出。

### 7.3 Export

深度导出负责把二进制资源转成 JSON symbols。

Event export 应包含事件文件 / map id、event id、instruction list、numeric args、called events、flag 操作和 raw diagnostics。

Map export 应包含 map id、parts、regions、entity ids、names、models、position、rotation 和 raw diagnostics。

Param export 应包含 param name、row id、row name、fields 和 raw diagnostics。

Msg export 应包含 text category、text id、text 和 raw diagnostics。

### 7.4 Index

导出的 symbols 持久化到 SQLite。

SQLite + FTS5 用于：

- 文件搜索；
- 事件搜索；
- 地图实体搜索；
- 参数行搜索；
- 文本搜索。

### 7.5 Build references

引用构建必须保守。

高置信例子：

- 事件指令有明确 Entity ID 参数，并匹配到地图实体；
- 事件调用另一个 event id；
- 事件读写明确 flag 参数；
- Text ID 来自明确指令或明确表字段。

低置信例子：

- 一个数字参数碰巧匹配多个 Param；
- 一个数字同时出现在多个资源类别；
- 只来自裸数字扫描，没有指令语义。

引用必须包含 confidence 和 reason。

## 8. AI 侧边栏

AI 侧边栏必须在产品壳里，但早期可以先作为工具控制台。

必须具备的 UI 概念：

- Provider：OpenAI / Anthropic / mock；
- 思考强度：fast / normal / deep / extreme；
- Plan mode：只提出步骤和补丁，不执行；
- Full-permission mode：AI 可以自动运行被批准工具，但不能绕过 Patch Engine；
- 当前上下文：选中资源、引用、诊断。

AI 工具应该操作 SoulForge 的索引资源图，而不是直接猜文件系统。

初始工具集包括：search_resources、open_resource、list_events、open_event、find_references、open_map_entity、open_param_row、open_text、explain_event。

## 9. 写入安全模型

即使早期包含可写架构，所有保存也必须通过暂存和验证流程。

保存流程：

```text
请求修改
  -> 生成补丁计划
  -> 应用到暂存副本
  -> 验证暂存副本
  -> 验证通过后备份原文件
  -> 原子替换原文件
  -> 重新解析保存后的资源
  -> 更新索引
  -> 写操作日志
```

验证应包括：文件可重新打开、容器可 inspect、目标资源可再次 export、资源数量没有异常坍缩、诊断没有无故恶化。

失败行为：

- Normal mode：停止，不保存，展示诊断；
- Plan mode：永不保存，只展示计划和 diff；
- Full-permission mode：只允许在暂存副本上有限重试。

## 10. 轻量化原则

SoulForge 不应该变成资源怪物。

规则：

- 懒解析；
- 增量索引；
- 可取消后台任务；
- 虚拟列表；
- 早期不做完整 3D 视口；
- 早期不做 embeddings；
- 早期不内置本地 LLM；
- Bridge 起步先用 CLI-style；
- 大资源正文不能塞进 React state。

## 11. 验收画面

一个成功的早期 demo 应该是：

1. 用户打开 ModEngine 风格的原生 Mod 目录；
2. SoulForge 扫描 event / map / param / msg 资源，不要求用户手动全量解包；
3. 用户打开一个事件；
4. SoulForge 展示事件结构；
5. 右侧显示关联地图实体、参数、文本和置信度；
6. AI 侧边栏只能用已索引证据总结事件；
7. 不支持资源诚实报告；
8. 软件保持响应，不急着加载整个工程。

做到这一步，SoulForge 就已经不只是普通编辑器，而是 FromSoftware Mod 的证据理解层。

# SoulForge 超级编辑器壳体里程碑

这个文档描述 SoulForge 作为 AI Mod 超级编辑器的第一阶段可见形态。

SoulForge 的目标不是做一个“事件编辑器升级版”，而是做一个多资源、AI 原生、安全可回滚的 Mod 工作台。事件理解是核心入口，但产品目标从一开始就是完整的超级编辑器。

## 产品目标

SoulForge 应该能打开原生 ModEngine 风格的 Mod 工作区，并提供统一的多资源工作台：

```text
开始页
  -> 工作区
    -> 事件
    -> 参数
    -> 文本
    -> 地图
    -> 文件
    -> AI
    -> 设置
```

第一阶段不需要权威解析每一种二进制格式，但必须有统一壳体、共享资源模型、共享诊断、共享 AI 工具，以及诚实标注的低置信证据。

## 里程碑名称

```text
超级编辑器壳体
```

这不是对外版本名，而是工程阶段名。目标是让用户打开项目后，第一眼就知道 SoulForge 是完整 Mod 工作台，而不是单文件工具。

## 用户应该看到什么

用户应该能够：

1. 打开原生 Mod 工作区；
2. 看到开始页、最近项目和打开项目入口；
3. 进入带顶部资源模式导航的工作区；
4. 在事件、参数、文本、地图、文件、AI、设置之间切换；
5. 看到按当前模式过滤的资源树或资源列表；
6. 选择资源后看到安全 viewer；
7. 看到诊断和解析置信度；
8. 通过 AI 或工具控制台查询已索引资源；
9. 在计划模式下生成补丁建议，但不写入原始 Mod 文件。

## 资源模式

### 事件

事件是第一条深理解链路的入口。

当前可接受状态：

- synthetic fixture 或候选事件导出；
- 原生 EMEVD 低置信候选；
- 事件搜索；
- explain_event；
- 在证据存在时关联地图、参数、文本。

不可接受：

- 没有 fixture 证明就声称权威解析指令。

### 参数

参数应该是一级模式，即使完整 PARAM layout 还没完成。

当前可接受状态：

- 已索引 param 文件；
- synthetic PARAM fixture；
- 低置信 row ID 候选；
- 参数行搜索；
- 显示候选置信度；
- 预留表格 viewer 形态。

不可接受：

- 只有 row ID 候选时，假装字段和行布局已知。

### 文本

文本模式应展示 FMG / msg 条目和文本引用关系。

当前可接受状态：

- 文本搜索；
- lookup_text_id；
- find_text_references；
- explain_text_entry；
- 区分 raw offset ID、table candidate ID 和 confirmed fixture ID。

不可接受：

- 把 raw string offset 当成稳定游戏 text ID。

### 地图

地图模式应展示地图文件、实体、区域和候选线索。

当前可接受状态：

- 已索引 map 文件；
- synthetic map fixture；
- 原生 MSB visible-name 低置信候选；
- 地图实体搜索；
- 证据标签。

不可接受：

- 没有 fixture 或格式规则时，假装 transforms、regions、models、entity IDs 已权威解析。

### 文件

文件模式是诚实兜底层。

当前可接受状态：

- 完整工作区文件清单；
- resource kind、extension、size、modified time；
- Bridge inspect 诊断；
- path hints、binder child candidates、nested magic candidates。

### AI

AI 是工作台侧边栏和工具控制台，不是自主二进制编辑器。

当前可接受状态：

- OpenAI-compatible、Anthropic-compatible、mock/tool-console provider 形态；
- 思考强度：fast、normal、deep、extreme；
- plan mode 和 full-permission mode 概念；
- 基于 WorkspaceIndex / reference graph 的只读工具；
- 不直接写文件的 patch proposal。

不可接受：

- 使用软件必须依赖 AI；
- AI 绕过 Patch Engine；
- AI 工具直接扫描或写入文件系统。

### 设置

设置应展示项目和 AI 配置，同时不隐藏安全状态。

当前可接受状态：

- game/profile 占位；
- bridge path/status；
- provider config 占位；
- tool permission mode；
- diagnostics/log 可见性。

## 架构目标

下一步实现应引入资源模式壳体，而不是一堆独立页面。

建议 UI state：

```ts
export type EditorMode = 'events' | 'params' | 'text' | 'maps' | 'files' | 'ai' | 'settings';
```

每个模式都消费同一个 workspace analysis result，并通过安全 API 查询 WorkspaceIndex。renderer 不能直接解析原生二进制。

## 实现优先级

1. 先补齐逻辑层债务：直接 export 路由、去掉临时 compatibility dispatch、保留 inspect/export 分离、保留容器边界保护。
2. 建立超级编辑器壳体：开始页、工作区壳、顶部模式导航、资源树、主 viewer、诊断面板、AI 侧边栏。
3. 把现有 core 工具接到壳体：workspace_stats、search_resources、search_events、search_param_rows、search_text_entries、search_map_entities、find_references、explain_event、lookup_text_id、find_text_references、explain_text_entry。
4. 所有深度二进制解析都必须在 Bridge 后面。
5. 所有写入都必须在 Patch Engine 后面。

## 验收画面

这个里程碑完成时，用户打开工作区后应该马上能理解：

- 有哪些资源；
- 哪些资源已有 confirmed symbols；
- 哪些资源只有低置信候选；
- 哪些资源不支持；
- 如何在事件、参数、文本、地图、文件、AI、设置之间切换；
- 如何用 AI / tool console 查询证据图；
- 为什么某个结论是确定、推测或不支持。

这个里程碑的重点是产品形态和诚实智能，不是一次性征服所有二进制格式。

## 非目标

仍然不做：

- 完整 3D 地图视口；
- Blender MCP 实装；
- mesh / model 编辑；
- animation / TAE 编辑；
- 本地 LLM runtime；
- embedding / vector database；
- 无验证自主二进制重写；
- 复制外部 parser 实现。

## 下一个里程碑

超级编辑器壳体存在后，下一步是把候选 parser 逐个替换为 fixture-confirmed parser：

1. FMG 文本表；
2. BND child table；
3. EMEVD 事件和指令；
4. PARAM 行和字段；
5. MSB 实体、区域、transform 和 model。

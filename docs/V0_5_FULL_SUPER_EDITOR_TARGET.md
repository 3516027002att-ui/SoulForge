# SoulForge 完整超级编辑器目标

这个文档描述 SoulForge 的长期产品目标：成为《只狼》和魂系 Mod 的 AI 超级编辑器。

到这个阶段，SoulForge 不应该只是“能打开资源的工具壳”，而应该让用户可以在整个 Mod 工程中使用 AI 完成可审查、可验证、可回滚的跨资源修改。

## 产品目标

SoulForge 应成为可实际使用的一体化 Mod 工作台：

```text
打开原生 Mod 工作区
  -> inspect 和索引资源
  -> 理解 event / map / param / msg 关系
  -> 跨资源编辑
  -> 让 AI 规划局部或全局修改
  -> 预览所有受影响文件
  -> 在暂存副本上验证
  -> 通过备份和回滚安全应用
```

关键变化是 AI 的范围：

- 早期 AI 主要负责查询和解释；
- parser 成熟后，AI 可以依赖更可靠的资源证据；
- 长期目标中，AI 可以在用户批准后，通过 Patch Engine 执行全局 Mod 修改。

这就是“像 Cursor 一样改 Mod”的完整含义。

## 必备产品能力

### 1. 完整工作区壳体

SoulForge 应该成为主力工作台体验：

- 开始页；
- 最近项目；
- 打开原生 Mod 目录；
- 工作区壳体；
- 事件 / 参数 / 文本 / 地图 / 文件 / AI / 设置模式；
- 诊断 / 日志面板；
- 资源树 / 列表；
- viewer / editor 面板；
- AI 侧边栏 / 工具控制台。

### 2. 核心资源编辑

长期目标要支持核心链路的实际编辑：

```text
event -> map -> param -> msg
```

预期编辑能力：

- 文本条目可以通过结构化 text patch 修改；
- 参数行可以在 parser 支持时通过结构化 row / field patch 修改；
- 事件可以在 parser / writer 支持时通过结构化 instruction / event patch 修改；
- 地图实体和区域可以在 parser / writer 支持时修改；
- 没有安全 writer 的二进制资源不能写。

任何功能都不能直接修改原始 Mod 文件。

### 3. AI 全局修改

长期目标中，AI 应该能在用户批准后执行全局 Mod 修改流程。

示例：

- 重命名一个道具，并更新相关文本和参数引用；
- 查找所有引用某个 Flag 的事件，并提出协调修改；
- 批量调整一组参数行；
- 修改 Boss 奖励流程，跨 event、param、msg 生成补丁；
- 检查 Mod 中的断裂引用并提出修复；
- 为一次玩法平衡修改生成跨文件 patch plan。

AI 绝不能直接写文件。它必须使用这条管线：

```text
用户需求
  -> AI 通过只读工具收集证据
  -> AI 生成全局修改计划
  -> 依赖和影响分析
  -> 补丁提案
  -> 用户审查
  -> 应用到暂存副本
  -> 验证暂存工作区
  -> 展示 diff 和诊断
  -> 用户批准或权限策略门控
  -> 备份原文件
  -> 原子替换
  -> 重新索引变化资源
  -> 操作日志
  -> 可回滚
```

### 4. AI 权限模式

长期目标中，权限模式要有真实行为。

#### Plan mode

- AI 可以 inspect、search、explain，并生成 patch proposal；
- AI 不能应用修改；
- 用户看到计划、影响文件、置信度、诊断和 diff。

#### Normal mode

- AI 可以创建 patch proposal；
- 用户必须批准后才能 staging / apply；
- 验证失败即停止。

#### Full-permission mode

- AI 可以自动运行被批准的工具；
- AI 可以应用到暂存副本；
- AI 可以在配置的重试限制内对暂存副本重试；
- AI 不能绕过 Patch Engine；
- AI 不能在验证和策略门控前覆盖原文件；
- 所有操作必须记录日志。

完整权限模式不是“随便做任何事”。它是在安全管线内部的受控自动化。

### 5. Patch Engine 成熟

长期目标要求 Patch Engine 成为真正的核心子系统。

必备能力：

- patch proposal model；
- 结构化文本编辑；
- 结构化参数编辑；
- writer 存在时支持结构化事件 / 地图编辑；
- 没有安全 writer 时拒绝写入；
- staging workspace；
- before / after hash；
- validation hooks；
- backup；
- atomic replace；
- rollback；
- operation log；
- 变化资源重新索引；
- patch 前后诊断对比。

### 6. 依赖和影响分析

全局修改必须知道什么可能被影响。

必备能力：

- 引用图遍历；
- impacted resource list；
- confidence labels；
- ambiguous reference warnings；
- cross-resource patch grouping；
- conflict detection；
- stale index detection；
- changed resource kind / symbol count validation。

### 7. AI 工具层

AI 工具应支持全局工作，同时保持安全边界。

只读工具：

- workspace_stats；
- search_resources；
- search_events；
- search_param_rows；
- search_text_entries；
- search_map_entities；
- find_references；
- explain_event；
- lookup_text_id；
- find_text_references；
- explain_text_entry；
- inspect_resource；
- summarize_diagnostics；
- analyze_impact。

写入规划工具：

- propose_text_patch；
- propose_param_patch；
- propose_event_patch；
- propose_map_patch；
- compose_global_patch；
- validate_patch；
- preview_patch。

写入执行工具必须受权限模式控制：

- apply_patch_to_staging；
- validate_staging；
- commit_staged_patch；
- rollback_operation。

renderer 和 AI 工具都不能直接写 Mod 文件。

## Parser / Writer 地基

长期目标依赖 parser 和 writer 成熟。

至少需要：

- confirmed FMG parser 和 text writer；
- confirmed BND child listing 和必要的安全替换 / 重打包路径；
- confirmed PARAM parser 和常用 row edit writer；
- confirmed EMEVD parser 和有限 event writer；
- confirmed MSB parser 和有限 map writer；
- 对不可安全写入的资源返回结构化 unsupported。

## 安全 writer 中间阶段

在完整目标前，需要一个安全 writer / Patch Engine 阶段。

这个阶段重点是：

- writer contracts；
- staged patch application；
- text writer；
- param writer；
- 条件成熟时的 event / map writer；
- validation hooks；
- backup 和 rollback；
- operation log；
- AI patch proposal format。

只有这层成熟后，AI 全局修改才有安全边界。

## 验收画面

长期目标达成时，用户应该能完成一次真实全局工作流：

1. 打开原生 Mod 工作区；
2. 向 AI 提出跨资源修改；
3. AI 搜索索引证据并解释影响；
4. AI 生成触及多个资源模式的 patch；
5. 用户看到影响文件、置信度、警告和 diff；
6. patch 应用到暂存副本；
7. validators 运行；
8. 用户批准，或权限模式允许受控执行；
9. 原文件被备份；
10. 修改被原子应用；
11. 工作区重新索引；
12. 操作日志记录全过程；
13. 可以回滚。

如果做到这一步，SoulForge 就不是普通编辑器，而是魂游 Mod 的 AI 工程操作系统。

## 非目标

长期目标也不要求：

- 达到专业地图编辑器级别的完整 3D parity；
- Blender MCP 实装；
- mesh modeling；
- animation authoring；
- 本地 LLM runtime；
- vector database RAG；
- 不安全的自主二进制重写；
- 对 unsupported 格式盲改。

## 安全底线

SoulForge 的承诺不是 AI 可以自由改任何东西。

真正承诺是：

```text
AI 只能通过证据、计划、暂存补丁、验证器、备份、日志和回滚进行全局 Mod 修改。
```

这就是 AI 超级编辑器和 Mod 毁灭型幻觉机器的区别。

# SoulForge 产品决策记录

本文记录用户已经裁定的 SoulForge 产品分歧。后续 ChatGPT、Codex、前端 agent 和其他实现者应优先遵守本文件。

生成时间：2026-07-08

## 总定位

SoulForge 的主定位是：

```text
魂游 Mod 的 Cursor
```

它不是传统 FromSoftware 工具的换皮，也不是 Smithbox / DSMapStudio / DarkScript / WitchyBND / SoulsFormats 的复刻。它的核心价值是让用户和 AI 能在证据、引用关系、补丁、验证、备份和回滚保护下编辑 Mod。

## 已裁定决策

### 0. 版本文档定位

选择：C。

`V0_5_FULL_SUPER_EDITOR_TARGET.md` 不再作为真正的版本定义使用。长期愿景应放入 `docs/PRODUCT_VISION.md`，真实 v0.5 范围应放入 `docs/V0_5_MILESTONE.md`。

### 1. v0.5 资源编辑范围

选择：自定义裁定。

对 ModEngine 风格目录中常见资源目录，除图片 / 纹理类内容外，都应尽量做到可打开、可查看、可编辑。

截图中明确纳入目标的目录：

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

图片 / 纹理类内容不作为 v0.5 必须直接编辑目标；可以预览、索引、标注 unsupported，后续再扩展。

### 2. 游戏范围

选择：B。

SoulForge 不只绑定只狼，应采用 FromSoftware 通用框架思路。只狼仍可作为首个验证对象，但架构、schema、工作区模型和资源模式不应写死为 Sekiro-only。

### 3. 打开对象

选择：C。

用户打开的是原生 ModEngine 覆盖目录；SoulForge 内部建立虚拟资源树 / 语义资源图。真实源仍是原生目录，AI 和 UI 面向虚拟资源视图工作。

### 4. DCX / BND 策略

选择：D。

v0.5 目标应包含 native DCX / BND 的读写能力，并支持安全替换 child / 重打包路径。所有写入仍必须通过 Patch Engine。

### 5. 外部工具策略

选择：A。

核心实现全部重写。外部工具只能作为参考和行为对照，不复制实现代码，不把核心 parser / writer 建立在外部工具源码之上。

### 6. UI 主框架与气质

选择：C，并增加审美裁定。

信息架构可以参考 Smithbox 的资源类型切换方式：开始页下面、工作区上方有资源类型切换条，例如 action / chr / event / map / menu / msg / obj / other / param / script / sfx。

但视觉气质必须接近 Codex / Cursor 这类现代 coding agent：简洁、优美、流畅、轻松、低压迫感。Smithbox 只作为资源组织参考，不能照搬它老旧、拥挤、压抑的视觉风格。

### 7. 资源优先级

选择：所有资源并重。

不要只把 event / map / param / msg 当成唯一产品中心。它们仍是早期语义链路核心，但 v0.5 的产品目标应覆盖 action、chr、event、map、menu、msg、obj、other、param、script、sfx 等主要目录。

### 8. Event writer 边界

选择：C。

长期目标是完整 EMEVD 编辑能力，而不是只读解释或模板化小修。实现仍要通过结构化模型、验证和 Patch Engine，不能裸写事件文件。

### 9. Map writer 边界

选择：D。

长期目标追求 DSMapStudio 级地图编辑能力。

同时保留 v0.5 非目标中的硬边界：v0.5 不等于完整 3D parity、Blender MCP 实装、mesh modeling 或 animation authoring。地图编辑目标很高，但实现应先落到结构化 MSB / map data 的安全编辑、引用关系和 patch 能力上。

### 10. Param writer 边界

选择：D。

目标包含 layout editor / paramdef editor，而不是只允许修改已有 row 的已有字段。

### 11. Text / FMG writer 边界

选择：D。

目标包含文本编辑、本地化、多语言对照和批量翻译能力。

### 12. AI 权限模式

选择：B。

Full-permission mode 可以在策略门控通过后自动 commit，但永远不能绕过 Patch Engine。自动 commit 必须满足：证据充分、patch 已生成、staging 已应用、验证通过、备份可用、日志完整、回滚可用。

### 13. AI provider 范围

选择：B。

v0.5 应支持 OpenAI-compatible 和 Anthropic-compatible 两类 provider。

### 14. 思考强度 / Agent 行为

选择：参考 OpenCode / Codex 等 coding agent。

思考强度不是装饰性 UI 参数。它应影响计划深度、工具调用预算、上下文检索范围、自检强度、重试策略、diff / patch review 深度。AI 侧边栏应更像 coding agent，而不是普通聊天框。

### 15. Patch Engine 成熟度

选择：C。

Patch Engine 目标应覆盖 event / map / text / param 等核心真实写入，并逐步扩展到 action、chr、menu、obj、script、sfx 等资源。所有可编辑资源最终都必须纳入 Patch Engine。

### 16. Diff / Patch 预览

选择：D。

v0.5 应追求可视化跨资源 patch graph，而不只是文本 diff。用户需要看到一次修改影响了哪些资源、哪些引用边、哪些文件、哪些验证项。

### 17. 引用图置信度规则

选择：A + C。

严格置信度：不确定就不能自动改。候选引用可以进入 patch proposal，但必须让用户逐条确认或通过明确策略门控确认。

### 18. Index / 数据库路线

选择：B。

SQLite + FTS5 基础上，需要加入引用图表、操作日志表、patch history 表。

### 19. 工作区扫描策略

选择：B。

打开目录后后台渐进索引核心资源。启动不能阻塞成全量解析怪物，但也不能只停留在纯文件树。

### 20. 诊断系统地位

选择：D。

诊断同时驱动 UI 警告、AI prompt、Patch Engine gate 和用户审查。diagnostics 不是普通日志，而是安全编辑系统的一部分。

### 21. Files mode

选择：D。

Files 是一等公民，支持直接打开和编辑任意文件。

但直接编辑仍必须通过 Patch Engine 保存：staging、验证、备份、原子替换、日志、回滚。Files mode 不能成为绕开安全模型的后门。

### 22. AI 工具层

选择：B。

先做内部工具注册表，同时保持未来 MCP 兼容。

### 23. AI 计划审查界面

选择：A。

计划主要在 AI 侧边栏展示。由于第 16 条要求跨资源 patch graph，侧边栏可以承载摘要和入口，必要时展开到主编辑区，但产品心智上仍以 AI 侧边栏为计划中心。

### 24. 操作日志和回滚粒度

选择：D。

三层都记录：operation、file、resource entry。v0.5 至少实现 operation / file 回滚，resource entry 级回滚可作为后续增强。

### 25. 原版游戏目录处理

选择：C。

允许读取原版目录作为 base，Mod 目录作为 overlay。原版目录默认只读，所有修改写入 Mod overlay。

### 26. v0.4 是否单独定义

选择：A。

不单独定义 v0.4。当前路线从 v0.3 直接推进到 v0.5，避免中间版本文档过多导致 agent 分心。

### 27. Codex 分工

选择：D。

复杂逻辑、产品边界、架构分歧由 ChatGPT / 用户先推理和裁定；Codex 只做窄实现。Codex 当前不应自由扩展 UI、Patch Engine、native parser 或产品范围。

### 28. 决策记录方式

选择：C + B。

同时维护 `docs/PROJECT_STATE.md` 和 `docs/DECISIONS.md`。

- `PROJECT_STATE.md`：给新对话、新 agent、Codex 快速恢复上下文。
- `DECISIONS.md`：记录已经裁定的产品分歧，避免重复讨论和实现跑偏。

### 29. v0.5 非目标

选择：A。

保持现有非目标：不把 v0.5 做成完整 3D parity、Blender MCP、mesh modeling、animation authoring、本地 LLM runtime、vector DB RAG、不安全自主二进制重写或 unsupported 格式盲改。

这不表示永远不预留接口，只表示 v0.5 不实装这些重型能力。

### 30. 产品定位一句话

选择：A。

主定位统一为：

```text
魂游 Mod 的 Cursor
```

## 对后续 agent 的硬提醒

1. 不要把“所有资源可编辑”理解成裸写文件。所有写入必须进入 Patch Engine。
2. 不要把“DSMapStudio 级地图编辑目标”理解成 v0.5 必须实现完整 3D / mesh / animation parity。
3. 不要把“Files mode 可直接编辑任意文件”理解成绕过验证和回滚。
4. 不要把 OpenAI / Anthropic provider 接入做成聊天玩具。AI 侧边栏应参考 coding agent 工作流。
5. 不要把 Smithbox 当视觉模板。它只提供资源组织参考，SoulForge 的视觉气质应现代、简洁、轻松。

# SoulForge v0.5 里程碑定义

v0.5 是 SoulForge 从 parser 地基走向完整超级编辑器体验的目标版本。

它的定位不是“只有 event / param / msg 的小工具”，而是：

```text
打开原生 Mod 目录 -> 建立虚拟资源树 -> 索引证据和引用 -> 打开并编辑主要资源 -> 通过 AI 生成计划和 patch -> 可视化影响 -> Patch Engine 安全保存 -> 可回滚
```

## 1. 核心定位

v0.5 的产品定位：

```text
魂游 Mod 的 Cursor
```

这意味着：

- 用户可以直接打开 ModEngine 风格原生 Mod 目录；
- UI 能展示 action / chr / event / map / menu / msg / obj / other / param / script / sfx 等资源模式；
- 除图片 / 纹理类内容外，主要资源应尽量做到可打开、可查看、可编辑；
- AI 不是普通聊天框，而是参考 Codex / OpenCode 的 coding agent；
- 所有修改都必须经过证据、计划、patch、staging、验证、备份、日志和回滚。

## 2. 工作区模型

用户打开的是原生 ModEngine 覆盖目录。

SoulForge 内部建立虚拟资源树：

```text
Native Mod directory
  -> light scan
  -> DCX / BND / resource envelope inspect
  -> virtual resource tree
  -> semantic exports
  -> reference graph
  -> editable resource views
```

原版游戏目录可以作为只读 base，Mod 目录作为 overlay。所有写入目标必须是 Mod overlay，不能直接破坏原版目录。

## 3. 资源范围

v0.5 必须面向常见 Mod 目录组织：

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

早期 parser 链路仍可以从 event / map / param / msg 起步，但产品目标不能只围绕这四类资源。所有资源模式并重。

图片 / 纹理类内容不作为 v0.5 必须直接编辑目标。它们可以被识别、预览、索引或标注 unsupported。

## 4. UI 目标

信息架构采用资源模式切换：开始页下方或工作区顶部提供 action / chr / event / map / menu / msg / obj / other / param / script / sfx 等类型入口。

视觉和交互气质应接近 Codex / Cursor：

- 简洁；
- 现代；
- 优美；
- 流畅；
- 轻松；
- 不压迫；
- 不老旧；
- 不拥挤。

Smithbox 可以作为资源组织参考，但不能作为视觉风格模板。

## 5. Parser / Writer 目标

v0.5 的目标是走向真实可编辑，而不是只读 inspect。

需要覆盖：

- DCX / BND native 读写和安全 child replacement / repack 路径；
- EMEVD 完整编辑能力；
- MSB / map data 的强编辑目标；
- PARAM row / field / layout / paramdef 编辑；
- FMG 文本、本地化、多语言对照和批量翻译；
- Files mode 对任意文件的直接打开和编辑。

所有 writer 都必须走 Patch Engine。

## 6. 地图能力边界

长期目标追求 DSMapStudio 级地图编辑能力。

v0.5 仍保留非目标边界：

- 不要求完整 3D parity；
- 不实装 Blender MCP；
- 不做 mesh modeling；
- 不做 animation authoring。

因此 v0.5 的地图能力应优先落到结构化 map data、Entity / Region / Transform / 引用关系、patch graph 和安全写入上。

## 7. AI 侧边栏

v0.5 的 AI 侧边栏是核心功能。

必须支持：

- OpenAI-compatible provider；
- Anthropic-compatible provider；
- provider 抽象；
- plan / normal / full-permission 模式；
- 类 coding-agent 的计划、工具调用、自检、diff review、patch proposal 工作流；
- 思考强度影响计划深度、工具预算、检索范围、自检强度和重试策略。

AI 计划主要在 AI 侧边栏展示。复杂 patch graph 可以从侧边栏展开到主编辑区。

## 8. Full-permission mode

Full-permission mode 可以自动 commit，但必须满足策略门控。

允许：

- 自动运行被批准的工具；
- 自动生成 patch；
- 自动写 staging；
- 自动验证；
- 在验证失败时有限重试；
- 在策略门控通过后自动 commit。

禁止：

- 绕过 Patch Engine；
- 没有证据就写；
- 没有 staging 就写；
- 没有验证就覆盖；
- 没有备份和日志就 commit；
- 对 unsupported 格式盲改。

## 9. Patch Engine

v0.5 的 Patch Engine 应成为真实核心系统。

目标能力：

- unified patch proposal model；
- text / param / event / map patch；
- 逐步扩展到 action / chr / menu / obj / script / sfx；
- Files mode raw edit patch；
- staging workspace；
- before / after hash；
- validators；
- backup；
- atomic replace；
- operation log；
- patch history；
- rollback；
- changed-resource re-index；
- diagnostics before / after comparison；
- visual cross-resource patch graph。

## 10. 引用图与置信度

严格置信度是底线。

高置信引用只能来自 parser、明确 instruction semantics、confirmed schema 或用户确认。

裸数字匹配、路径猜测、可见字符串扫描只能作为 candidate。

候选引用可以进入 patch proposal，但必须让用户逐条确认，或通过明确策略门控确认。

## 11. 数据库和索引

v0.5 使用 SQLite + FTS5，并加入：

- resource table；
- symbol table；
- reference graph table；
- diagnostics table；
- operation log table；
- patch history table；
- provider / agent run metadata。

不引入 vector DB / embedding RAG 作为 v0.5 目标。

## 12. 工作区扫描

默认策略：打开后后台渐进索引核心资源。

要求：

- 启动不阻塞；
- 文件树快速可见；
- Bridge 调用有超时；
- 后台任务可取消；
- 大文件懒加载；
- 大列表虚拟滚动；
- AI 侧边栏默认不消耗 API；
- diagnostics 随索引逐步出现。

## 13. Files mode

Files mode 是一等公民。

用户应能直接打开和编辑任意文件。

但保存仍必须经过 Patch Engine。Files mode 不能成为裸写后门。

对于 unsupported 格式，UI 必须清楚展示风险和置信度，必要时强制用户确认。

## 14. 诊断系统

diagnostics 同时驱动：

- UI 警告；
- AI prompt；
- Patch Engine gate；
- 用户审查；
- patch graph；
- operation log。

诊断不是普通日志，而是安全编辑模型的一部分。

## 15. 回滚粒度

系统应记录三层粒度：

- operation；
- file；
- resource entry。

v0.5 至少实现 operation / file 回滚。resource entry 级回滚可以作为后续增强。

## 16. 非目标

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

## 17. Codex 分工

Codex 只做窄实现。

复杂逻辑、产品边界、架构分歧由用户和 ChatGPT 先裁定。Codex 不应自由扩展 UI、Patch Engine、native parser 或产品范围。

当前 Codex 仍应优先完成 v0.3 fixture / bridge 相关窄任务，避免跳到 v0.5 大范围实现。

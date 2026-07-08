# SoulForge 只狼 Mod 超级编辑器

SoulForge 的目标是做一个面向《只狼》和魂系游戏 Mod 的 AI 超级编辑器。

它的最终目标是：让 AI 像 Cursor 修改代码一样理解和修改 Mod。用户可以直接提出需求，例如“把这个敌人的奖励改成某个道具”“把这一段剧情事件关联到另一张地图”“检查这些文本 ID 有没有被事件引用”“批量调整一组效果参数”，SoulForge 负责把这些自然语言需求拆成证据、计划、补丁、验证和可回滚的修改。

传统魂系 Mod 工作流非常痛苦：

- 文件类型多：DCX、BND、EMEVD、MSB、PARAM、FMG 等格式混在一起；
- 资源关系复杂：事件、地图、参数、文本之间大量靠数字 ID 串联；
- 工具分散：经常要在多个工具之间来回切换；
- 修改风险高：改错一个 ID 或打包错误，就可能让游戏静默出问题；
- AI 很难直接帮忙：如果 AI 看不到可靠证据，它只能猜。

SoulForge 要解决的核心问题不是“再做一个表格编辑器”，而是建立一套 AI 能理解、能追踪、能安全修改的 Mod 工作台。

SoulForge 最终应该像一个 Mod 领域的 Cursor：

- 打开原生 ModEngine 风格的 Mod 目录；
- 自动识别事件、地图、参数、文本和其他资源；
- 把看不懂的数字 ID 转成可追踪的符号和引用关系；
- 在 AI 解释或修改之前展示证据链；
- 让 AI 根据用户目标生成修改计划；
- 修改前给出影响范围和补丁预览；
- 修改时进入暂存区，不直接破坏原文件；
- 修改后做验证、备份、日志记录和回滚。

目标不是让 AI 莽撞地直接改文件，而是让 AI 在证据和 Patch Engine 的约束下，像高级 Mod 助手一样完成跨资源修改。


## AI 怎么改 Mod

目标工作流是：

```text
用户提出修改需求
  -> AI 查询索引和证据图
  -> AI 解释它找到的事件、地图、参数、文本关系
  -> AI 生成修改计划
  -> SoulForge 做影响分析
  -> 生成补丁预览
  -> 用户确认
  -> 写入暂存区
  -> 验证
  -> 备份原文件
  -> 原子替换
  -> 重新索引
  -> 记录操作日志
  -> 必要时回滚
```

这就是“像 Cursor 一样改 Mod”的含义：AI 不是只聊天，也不是直接胡乱改二进制，而是基于项目上下文、证据链和补丁系统执行可审查的修改。

## 当前工程状态

项目仍处在早期地基阶段，重点是把资源识别、证据、索引、AI 工具和安全写入路径搭起来。

已经具备或正在推进的方向：

- Electron + React + TypeScript 桌面壳；
- C# Bridge 负责读取和识别底层资源；
- 工作区扫描和资源分类；
- 文件证据、诊断和低置信候选输出；
- AI 安全读工具；
- event / map / param / msg 的符号和引用图；
- synthetic fixture 用于验证解析管线；
- Patch Engine 作为唯一写入路径的设计。

当前 v0.3 的重点是 fixture-confirmed parser plumbing：先用小型 synthetic fixture 确认导出形状、ID 稳定性、置信度标记和 AI 可用上下文，再逐步替换为真实格式解析器。

## 解析策略

SoulForge 必须诚实地区分三类数据：

- 已确认解析：由 fixture 或明确格式规则验证过，可以给较高置信度；
- 候选解析：通过扫描、启发式或可疑结构找到，只能作为线索；
- 不支持资源：返回结构化诊断，不假装解析成功。

这是项目的底线。AI 宁愿说“不确定”，也不能把猜测包装成事实。

## 安全写入策略

所有真实修改都必须经过 Patch Engine：

```text
修改请求
  -> 补丁计划
  -> 暂存副本
  -> 验证
  -> 备份
  -> 原子保存
  -> 重新索引
  -> 日志
  -> 回滚
```

直接写入 Mod 文件是禁止的。AI 的完整权限也不能绕过这个流程。

## 技术方向

- 桌面端：Electron + React + TypeScript；
- Bridge / parser：C# helper process；
- 索引：SQLite + FTS5；
- AI：OpenAI-compatible、Anthropic-compatible、mock/tool-console provider；
- 写入：Patch Engine；
- 外部工具：只做参考，不复制 Smithbox、DSMapStudio、DarkScript、WitchyBND、SoulsFormats 的实现代码。

## 近期优先级

1. 打通 event / map / param / msg 的 synthetic fixture 导出路径；
2. 让 AI 和 UI 能区分 confirmed / candidate / unsupported；
3. 完成 FMG、BND、EMEVD、PARAM、MSB 的 fixture-confirmed parser 里程碑；
4. 建立安全 writer 和 Patch Engine 验证链；
5. 让 AI 从只读解释升级到可审查、可回滚的 Mod 修改。

## 给 Codex 的当前交接

当前给 Codex 的明确任务记录在：

- [`docs/CODEX_NEXT_ACTIONS.md`](docs/CODEX_NEXT_ACTIONS.md)
- [`docs/CODEX_TASK_ROUTER_WIREUP.md`](docs/CODEX_TASK_ROUTER_WIREUP.md)

Codex 当前只应做路由接线、类型小修和 smoke script，不应该扩展到真实 native parser、UI 重构或 Patch Engine 改造。

## 相关文档

产品与决策：

- [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md)
- [`docs/DECISIONS.md`](docs/DECISIONS.md)
- [`docs/V0_5_MILESTONE.md`](docs/V0_5_MILESTONE.md)
- [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)
- [`docs/PROJECT_SOURCE.md`](docs/PROJECT_SOURCE.md)

当前工程里程碑：

- [`docs/V0_3_FORMAT_PARSER_MILESTONE.md`](docs/V0_3_FORMAT_PARSER_MILESTONE.md)
- [`docs/V0_3_FMG_SYNTHETIC_FIXTURE.md`](docs/V0_3_FMG_SYNTHETIC_FIXTURE.md)
- [`docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md`](docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md)
- [`docs/V0_3_SYNTHETIC_MAP_FIXTURE.md`](docs/V0_3_SYNTHETIC_MAP_FIXTURE.md)

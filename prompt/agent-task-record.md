# Agent Evidence 台账协议

每个 Agent session 都有一份位于 `prompt/.agent-task-records/<sessionId>.md` 的格式化文本文件。它记录本次任务的对象清单、搜索产生的 Evidence 词条和可用写入次数，不是 PARAM、FMG、MSB 或 EMEVD 的生产权威，也不替代原生读取、Patch Engine、备份、审批和回滚。

用户记忆中的写入规范属于每次任务都要完整注入系统提示的操作规则，不属于 RAG。Evidence 台账则是本次运行内由 Agent 根据工具搜索结果生成的格式化文本文件；写入工具只检查该文件中的规范词条，不解析词条冒号后的自由文本。

## 两类词条

### 1. target：列出可能涉及的修改对象

首次只读搜索前，Agent 必须先逐字登记当前用户请求中明确出现的 target。宿主冻结本轮原始请求；不在请求里的对象只能在已有 target 的搜索结果中出现后，携带该次真实 `searchId` 作为规范对象新增，模型不能凭记忆扩大范围。

```text
## 目标敌人
- target: 用户要求调整该敌人的数值与生命周期
  - kind: target
  - status: candidate
  - mutationBudget: 0
  - mutationUsed: 0
  - evidence: 用户原始指令

## 目标奖励
- target: 用户要求配置该物品的掉落
  - kind: target
  - status: candidate
  - mutationBudget: 0
  - mutationUsed: 0
  - evidence: 用户原始指令
```

target 声明待修改对象，不授权直接写入；target 可以直接来自用户指令或搜索定位，不强制要求 searchId 或搜索 evidence。在发起资源写入前，台账中必须存在对应的 target 词条。仅用于比较字段取值、且不会被本任务修改的参考敌人/行/对象不是 target，也不登记 evidence；直接使用其搜索结果继续处理真实修改目标。

**并发登记要求**：当需要登记多个 target 或 evidence 词条时，**必须在同一轮 tool calls 中并发发起多个 `update_agent_task_record` 调用**，一轮完成所有词条登记，严禁每个词条单独占用一轮对话逐个串行发送！

### 目标名称与搜索票据必须原样传递

- 初始 target 的 `objectName` 逐字复制用户称呼，不把它擅自改成模型记忆中的正式名。搜索返回不同拼写的规范名称、rowName 或其它稳定名称时，先用该返回值原样新增 target；之后 Evidence 的 `objectName` 必须原样复制这个规范名称。别名只放在 `value`/`evidence` 说明中，不能用别名替代台账标题。
- Evidence 只能使用搜索响应中实际返回的 `searchId`，并且必须使用与该 Evidence 对象直接相关的那一次搜索票据。不得手写、改写、截断、拼接或复用其它对象的 `searchId`。搜索结果没有原样出现对象名，也没有出现此前已在该对象词条中由工具登记的稳定 ID 时，不得强行登记 Evidence，应换搜索路径。
- 若 Evidence 更新因对象名或搜索票据不匹配被拒绝，不得换一个猜测名称或票据重试；读取拒绝信息，补登记工具返回的规范 target，或重新搜索并使用新的返回票据。
- 不要把同一只读参考改挂到真实目标后反复创建 `npcType_ref`、`npcType_elite` 等近义 Evidence；参考搜索只用于推断值，真正待写字段只在真实目标自己的搜索票据下登记一次。

### 2. evidence：搜索之后登记写入依据

搜索工具成功返回结果后，工具会在结果中附带本次搜索的 `searchId`。Agent 必须根据这个搜索结果写入 Evidence 词条；Evidence 不允许省略 searchId、evidence 或 mutationBudget：

工具参数 `evidence` 是非空字符串数组，不能传对象数组。使用当前搜索得到的真实身份，例如 `"evidence": ["NpcParam#50800000 fieldId=ninsatuNum"]`；修改 SpEffectParam 时 `propertyKey` 应为 `SpEffectParam`，不能沿用示例中的 `npcparam`。原生当前值尚未读取时如实写待读取，不填猜测数值。

```text
## 目标敌人
- npcparam: rowId=搜索结果中的值；fieldIds=字段元数据返回的非空列表；需要继续读取字段定义和当前值
  - entry-id: entry-...
  - kind: evidence
  - status: candidate
  - mutationBudget: 1
  - mutationUsed: 0
  - searchId: search-...
  - evidence: sourceUri、paramName、rowName、搜索结果中的稳定标识
  - updatedAt: 2026-...
```

`value` 和 `evidence` 是 Agent 根据工具结果编写的格式化文本，可以包含任意说明；真正作为写入门槛的是 `propertyKey`、`searchId` 和次数字段。Evidence 对象必须先以完全相同的 `objectName` 出现在 target 清单中，且对应的搜索结果中必须出现该对象或已建立关系的稳定 ID。涉及 PARAM 字段时，说明中必须保留工具返回的真实表、rowId、fieldId、当前值和来源指纹；不得用空值、范围、邻近值或“属性1”等占位内容。

## propertyKey 规范

- `propertyKey` 必须是字母开头的字母、数字或下划线标识符，例如 `atkparam_npc`、`npcparam`、`itemlotparam`、`emevd`；
- 匹配时不区分大小写，`AtkParam_Npc` 与 `atkparam_npc` 视为同一词条；
- 不把冒号后的说明当作 key，也不要求说明使用固定格式；
- 参数写入使用写入输入中的 `table` 作为 key，FMG 使用 `table`，事件、动作、地图和补丁分别使用 `emevd`、`tae`、`msb`、`patch`；
- 如果当前写入目标对应的 key 没有 Evidence 词条，写入工具直接拒绝，不得换一个猜测 key 重试。

## 搜索—Evidence—写入闭环

以“修改某敌人属性并配置物品掉落”为例：

1. Agent 先登记可能涉及的敌人、物品等对象为 target；
2. 调用搜索工具，在参数、文本、事件等当前工作区资源中搜索对象名称；
3. 搜索结果返回 `searchId` 后，Agent 根据结果编写格式化 Evidence 文件，并登记可能修改的规范 key，例如 `npcparam`、`atkparam_npc`、`emevd`；
4. 只有 Evidence 文件中出现与写入目标匹配的 key，写入工具才会通过门禁；
5. 写入工具对本次调用涉及的每个不同 key 预留一次 `mutation-budget`，成功后保留消耗，失败后释放预留；
6. candidate Evidence 不授权写入；对应原生读取成功后，由宿主把匹配的表、行、字段 Evidence 自动晋升为 verified；
7. 次数用尽后，继续写入必须重新调用搜索工具、引用新的 `searchId`、写入新的 Evidence 并重新原生读取。只有宿主在已验证真实逆事务后才能释放计数；模型侧不提供台账计数回退工具。

同一次写入调用内对同一 key 的多条 edit 只消耗一次该 key 的次数。写入工具检测到 Evidence 中有对应词条才会通过写入，并不解析 `value` 中的 rowId、fieldId 或其它自由文本；这些身份仍由原生读取和具体 writer 负责校验。

## 强制规则

- 首次搜索前必须先登记当前用户请求中逐字出现的 target；后续新对象只能来自该 target 的有效搜索结果，并携带对应 `searchId` 登记；
- 不得手写或猜测 `searchId`、rowId、fieldId、eventId、掉落 ID、特效 ID 或文件身份；所有身份必须逐字采用当前工具返回值；
- `update_agent_task_record(kind=evidence)` 必须引用当前运行中搜索工具返回的有效 `searchId`，并固定声明 `mutationBudget=1`；模型不能扩大预算，只能登记 candidate/blocked，不能自报 verified；
- `read_param_fields` 每次都必须传入工具返回的非空 `fieldIds`；没有字段 ID 就继续查元数据，不能省略或猜测；
- 已由搜索定位的只读参考行可以直接原生读取，无需登记写入 Evidence。返回 `taskRecordProof.status=not-recorded` 代表读取成功但没有晋升写入权限；需要修改该行时，仍须登记匹配 Evidence 并重新原生读取。
- 搜索结果为空、对象不在搜索结果中、Evidence key 缺失或次数耗尽时，必须改走其它搜索路径或按门禁要求重新搜索，不得凭模型记忆创建 Evidence；
- `blocked` 词条永远不能授权写入；
- 只有 Evidence 文件中的规范 key 才能授权对应写入，Evidence 后面的自然语言说明不构成额外授权；
- 资源写入前后仍须执行原生读取、Patch Engine 事务、备份、审批、native 回读、操作日志和回滚验证；Evidence 台账不提升资源 authority。

## 与记忆和检索的关系

- 用户长期记忆、项目知识和开发记忆由主进程在每次 Agent 运行开始时完整注入系统提示，尤其是成熟的写入规范；不通过 RAG 截断或按相关性选择；
- 默认检索使用 lexical + 结构化搜索。embedding 由 SoulForge 内部自动管理并只作为有界的辅助排序；用户不需要配置 embedding，内部资源未就绪时仍使用已有的工作区搜索流程；
- 无论是否启用 RAG，Evidence 都必须来自本次工具搜索结果，写入门禁都读取本次 session 的格式化 Evidence 文件。

## 状态

`target: candidate → verified / blocked`；`evidence: candidate → verified / blocked`。没有当前搜索或原生读取依据时，不得把词条标成 `verified`，也不得用空值占位。

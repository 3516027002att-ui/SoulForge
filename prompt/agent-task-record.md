# Agent Evidence 台账协议

每个 Agent session 都有一份位于 `prompt/.agent-task-records/<sessionId>.md` 的格式化文本文件。它记录本次任务的对象清单、搜索产生的 Evidence 词条和可用写入次数，不是 PARAM、FMG、MSB 或 EMEVD 的生产权威，也不替代原生读取、Patch Engine、备份、审批和回滚。

用户记忆中的写入规范属于每次任务都要完整注入系统提示的操作规则，不属于 RAG。Evidence 台账则是本次运行内由 Agent 根据工具搜索结果生成的格式化文本文件；写入工具只检查该文件中的规范词条，不解析词条冒号后的自由文本。

## 两类词条

### 1. target：先列出可能涉及的对象

在第一次调用记忆、RAG 或资源搜索工具前，Agent 必须根据用户指令列出可能需要修改的对象。对象可以是角色、敌人、物品、奖励、参数组、事件或其它用户明确提到的实体。登记是硬性前置步骤，不是搜索后的补记。必须先收到所有 target 更新成功的工具结果，再在后续工具轮次搜索；不能把 target 更新和搜索/RAG 调用放在同一批工具调用中。

```text
## 鬼型部
- target: 用户要求将其从 BOSS 改为精英怪、修改红点数
  - kind: target
  - status: candidate
  - mutationBudget: 0
  - mutationUsed: 0
  - evidence: 用户原始指令

## 靛蓝星陨
- target: 用户要求把该原创忍具加入奖励
  - kind: target
  - status: candidate
  - mutationBudget: 0
  - mutationUsed: 0
  - evidence: 用户原始指令
```

没有 target 词条时，搜索工具拒绝执行。target 只声明待定位对象，不授权写入；target 可以直接来自用户指令，因此不要求 searchId 或搜索 evidence。target 登记失败时不得改用搜索、RAG 或模型记忆继续推进，先修正 `kind=target`、`propertyKey=target`、非空 `value` 和 `status=candidate`。

### 目标名称与搜索票据必须原样传递

- 初始 target 的 `objectName` 逐字复制用户称呼，不把它擅自改成模型记忆中的正式名。搜索返回不同拼写的规范名称、rowName 或其它稳定名称时，先用该返回值原样新增 target；之后 Evidence 的 `objectName` 必须原样复制这个规范名称。别名只放在 `value`/`evidence` 说明中，不能用别名替代台账标题。
- Evidence 只能使用搜索响应中实际返回的 `searchId`，并且必须使用与该 Evidence 对象直接相关的那一次搜索票据。不得手写、改写、截断、拼接或复用其它对象的 `searchId`。搜索结果没有原样出现对象名，也没有出现此前已在该对象词条中由工具登记的稳定 ID 时，不得强行登记 Evidence，应换搜索路径。
- 若 Evidence 更新因对象名或搜索票据不匹配被拒绝，不得换一个猜测名称或票据重试；读取拒绝信息，补登记工具返回的规范 target，或重新搜索并使用新的返回票据。

### 2. evidence：搜索之后登记写入依据

搜索工具成功返回结果后，工具会在结果中附带本次搜索的 `searchId`。Agent 必须根据这个搜索结果写入 Evidence 词条；Evidence 不允许省略 searchId、evidence 或 mutationBudget：

```text
## 鬼型部
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

以“把鬼型部改为精英怪、增加靛蓝星陨、红点数改为 2”为例：

1. Agent 先登记 `鬼型部`、`靛蓝星陨` 等可能需要修改的对象；
2. 调用搜索工具，在参数、文本、事件等当前工作区资源中搜索对象名称；
3. 搜索结果返回 `searchId` 后，Agent 根据结果编写格式化 Evidence 文件，并登记可能修改的规范 key，例如 `npcparam`、`atkparam_npc`、`emevd`；
4. 只有 Evidence 文件中出现与写入目标匹配的 key，写入工具才会通过门禁；
5. 写入工具对本次调用涉及的每个不同 key 预留一次 `mutation-budget`，成功后保留消耗，失败后释放预留；
6. 次数用尽后，继续写入必须重新调用搜索工具、引用新的 `searchId`、写入新的 Evidence 词条；如果资源已经实际回退，则先完成真实回退，再调用 `rollback_agent_task_record_mutation` 释放对应次数；
7. 台账计数回退工具只释放 Evidence 次数，不代替 `rollback_operation`，也不直接修改 Mod 文件。

同一次写入调用内对同一 key 的多条 edit 只消耗一次该 key 的次数。写入工具检测到 Evidence 中有对应词条才会通过写入，并不解析 `value` 中的 rowId、fieldId 或其它自由文本；这些身份仍由原生读取和具体 writer 负责校验。

## 强制规则

- 不得在没有 target 的情况下调用搜索工具；
- 收到 `TASK_RECORD_TARGETS_REQUIRED` 时，立即停止当前搜索链，先登记缺少的 target；不得用另一种名称、空值或猜测值绕过该前置门。
- 不得手写或猜测 `searchId`、rowId、fieldId、eventId、掉落 ID、特效 ID 或文件身份；所有身份必须逐字采用当前工具返回值；
- `update_agent_task_record(kind=evidence)` 必须引用当前运行中搜索工具返回的有效 `searchId`，并声明正整数 `mutationBudget`；
- `read_param_fields` 每次都必须传入工具返回的非空 `fieldIds`；没有字段 ID 就继续查元数据，不能省略或猜测；
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

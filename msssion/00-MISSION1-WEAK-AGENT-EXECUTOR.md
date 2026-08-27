# Mission 1 弱 Agent 无歧义执行协议

> 本文件是 `docs/mission1-handoff` 快照上，针对 `report.md` 所列未收口项追加的**执行层规范**。
>
> 目标不是重新解释 `mission1.md`，而是让低能力 Agent 能按固定算法完成剩余工作，禁止靠猜测、经验补全、宽松理解或“差不多完成”。

## 0. 文件权威顺序与使用方法

### 0.1 本分支上的读取顺序

执行 Mission 1 时固定按以下顺序读取：

1. 本文件 `msssion/00-MISSION1-WEAK-AGENT-EXECUTOR.md`；
2. `msssion/report.md`；
3. `msssion/mission1.md` 中与当前子任务有关的章节；
4. 当前代码、测试、真实运行产物。

`mission1.md` 仍然是详细产品/技术契约。本文件只负责：

- 消除 `report.md` 暴露出的执行歧义；
- 给出固定执行顺序、算法、停止条件、失败码和验收证据；
- 对 `mission1.md` 中尚未收口的 §24.17–§24.24 给出补充执行规则；
- 规定怎样判断“真的完成”，避免把“实现了但没测”“搜不到”“看起来正常”当 PASS。

如果本文件与 `mission1.md` 已冻结的**具体数学、DTO 字段、错误码、预算值、golden fixture**冲突，以 `mission1.md` 的具体契约为准；如果冲突只涉及“执行顺序、是否可跳过、什么证据算完成”，以本文件为准。

### 0.2 禁止使用硬编码行号定位规范

文档和源码会继续变化。任何 `foo.ts:123`、`§5278` 一类位置只可作为历史线索，不能作为定位算法。

固定定位算法：

```text
1. 用 rg -n 搜索章节标题、接口名、函数名、错误码或唯一字符串；
2. 记录当前实际匹配路径和行号；
3. 打开匹配上下文确认语义；
4. 只有确认符号身份后才修改；
5. 验收记录写“symbol + observed line”，不能只写旧行号。
```

如果搜索到 0 个候选：返回 `TARGET_SYMBOL_NOT_FOUND`，不得猜新路径。

如果搜索到多个候选：逐个读取上下文，直到能通过调用关系、导出名或测试引用唯一化；仍不能唯一化则返回 `TARGET_SYMBOL_AMBIGUOUS`，不得任选一个。

## 1. 全局执行状态机

所有 report 未完成项都必须走下面同一状态机。禁止跳状态。

```text
BOOTSTRAP_AUTHORITY
  -> TRUST_ROOT
  -> LOCATE_TARGET
  -> CLASSIFY_SUPPORT
  -> INSTRUMENT
  -> BASELINE
  -> APPLY_ONE_LOGICAL_CHANGESET
  -> RE_RUN
  -> VERIFY_POSTCONDITIONS
  -> WRITE_ACCEPTANCE_ARTIFACT
  -> COMMIT_OR_ROLLBACK
  -> FINAL_GATE
```

每个状态只有一种合法退出方式：产生本节规定的输出后进入下一状态，或产生明确失败码停止。

### 1.1 BOOTSTRAP_AUTHORITY

输出：

- 当前 branch；
- 当前 commit SHA；
- `git status --short`；
- Mission 文件实际路径；
- 本文件 SHA256；
- `mission1.md` SHA256；
- `report.md` SHA256。

若工作树已有与本子任务无关的用户改动：不得清理、reset、覆盖；记录为 `PREEXISTING_USER_CHANGE`，后续只修改自己的目标文件。

### 1.2 TRUST_ROOT

这是所有产品修复之前的强制门。先执行并保存原始输出：

```bash
git status --short
git ls-files msssion/mission1.md
git ls-files msssion/report.md
git ls-files scripts/verify-mission1-acceptance.mjs
git check-ignore -v msssion/mission1.md
git status --ignored --short msssion/mission1.md
```

如果实际权威工作树使用 `锐评/mission1.md`，对该真实路径重复同样检查，不得因为本 handoff 快照的目录名不同而假定两者相同。

TRUST_ROOT PASS 条件：

1. 当前执行使用的 mission 文件身份明确；
2. 验收脚本是否存在、是否被跟踪明确；
3. report 提到的三份 discovery note 已找到并逐项合并/明确废弃，不能悬空；
4. 没有把 ignored/untracked 文件误当成 CI 可见 authority；
5. 所有后续 artifact 都绑定 commit SHA + mission SHA256。

任一不满足：`TRUST_ROOT_INCOMPLETE`，禁止开始产品修复。

### 1.3 LOCATE_TARGET

必须建立 `TargetRecord`：

```text
subtaskId
requiredSymbols[]
locatedFiles[]
locatedSymbols[]
currentCallers[]
currentTests[]
observedLines[]
```

`requiredSymbols` 来自 mission/report，不允许 Agent 自己把目标缩成“我容易改的那一部分”。

### 1.4 CLASSIFY_SUPPORT

每个能力固定分类为：

- `SUPPORTED_AND_EVIDENCED`：生产 adapter/tool + 测试/真实 evidence 都存在；
- `IMPLEMENTED_NOT_ACCEPTED`：实现存在，但缺 report 要求的真实验收；
- `DOC_ONLY`：只有文档宣称，没有可追到生产 mutation/read path 的实现证据；
- `UNSUPPORTED`：明确没有实现；
- `UNKNOWN`：证据不足。

`DOC_ONLY`、`UNSUPPORTED`、`UNKNOWN` 不允许在最终报告中写“已支持”。

### 1.5 INSTRUMENT

先增加最小、可删除或可测试隔离的计数器/trace，再跑 baseline。禁止先改行为再想办法证明变快。

所有性能/加载问题至少记录：

- source read count；
- source inflate/decompress count；
- source parse count；
- source hash count；
- payload bytes；
- cache/session identity；
- source revision/content identity；
- 调用发生在 workspace-ready 前还是后。

### 1.6 BASELINE

Baseline 必须来自修改前的同一 corpus、同一入口、同一机器环境。失败也要保存，不能只保存绿色结果。

如果 baseline 自带已知红测：记录用例名、失败码和原始输出；后续只比较目标相关变化。不得把旧红算作本次回归，也不得借旧红掩盖新红。

### 1.7 APPLY_ONE_LOGICAL_CHANGESET

“一次只改一个逻辑目标”不是“一次只改一个文件”。如果一个契约必须同时修改生产代码、类型、测试 expected 才是正确原子修复，则它们属于同一个 ChangeSet，必须一起完成。

不得把复合目标拆成若干无法独立成立的半成品 commit。

### 1.8 RE_RUN / VERIFY_POSTCONDITIONS

重新执行与 baseline 完全相同的入口，并额外执行本文件规定的 negative/perturbation test。

“测试绿”不是唯一完成条件。每个子任务必须同时满足：

- 目标 postcondition；
- negative fixture 能抓到故意错误；
- source completeness 完整；
- 没有 silent fallback；
- 没有新 bypass；
- artifact 可被机器重算。

### 1.9 WRITE_ACCEPTANCE_ARTIFACT

没有 artifact 就没有 PASS。

所有 artifact 至少包含：

```json
{
  "schemaVersion": 1,
  "gate": "...",
  "runId": "...",
  "build": {
    "commitSha": "...",
    "missionSha256": "..."
  },
  "sourceCompleteness": {
    "status": "complete",
    "evidence": []
  },
  "result": "PASS"
}
```

硬规则：`sourceCompleteness.status !== "complete"` 时，required gate 的 `result` **不得为 PASS**。`partial` 不是“降权 PASS”，而是失败/未验收。

### 1.10 COMMIT_OR_ROLLBACK

若 postcondition 或 artifact verifier 失败：回滚**本 ChangeSet**，保留诊断 artifact；不得为了让 gate 变绿而删失败样本或放宽 expected。

### 1.11 FINAL_GATE

最终只有三种状态：

- `PASS`：实现 + 真实验收 + artifact + verifier 全部通过；
- `FAIL`：已执行验收并观察到反例；
- `BLOCKED`：缺 fixture、authority、环境或必要实现，且已给出确定失败码。

禁止输出 `基本完成`、`应该没问题`、`看起来通过`。

## 2. 防猜测算法

### 2.1 空结果不是“不存在”

任何搜索/索引返回空时，先检查 coverage。

只有 `coverage=complete` 且 source revision 与当前 authority 一致，空结果才可解释为 `NOT_FOUND_WITH_COMPLETE_COVERAGE`。

以下状态都不能证明不存在：

- `NOT_INDEXED`；
- `PARTIALLY_INDEXED`；
- `PARSE_FAILED`；
- `STALE`；
- `SOURCE_UNAVAILABLE`；
- coverage 未知。

### 2.2 连续低信息增益熔断

一个 subgoal 连续 3 次 probe，如果同时没有发生以下任一事件：

- candidate set 变小；
- 新增 confirmed fact；
- 新增 reference edge；
- 排除一个候选；
- source coverage 变完整；

则立即停止继续猜，返回 `NO_PROGRESS_REPLAN_REQUIRED`。

禁止通过改变数字、猜 rowId/eventId、尝试相邻文件名来绕过该熔断。

## 3. Report 收口固定顺序

严格按以下顺序，不允许先挑容易的做：

1. A0 Trust Root；
2. PARAM 实机验收；
3. Loading 三条独立链路；
4. Tauri/其他 backend 写路径收敛；
5. agentWorkspaceRoot 与 gameDataWorkspace 分离；
6. mutation capability truth table；
7. §24.17–§24.21 欠规格补齐；
8. X5 PARAM；
9. X6 ESD；
10. X7-FMG；
11. X7-MSB；
12. X7-EMEVD；
13. editorWriteBack + missionText；
14. 全量 build/test/verifier；
15. 最终报告。

某一步 BLOCKED 时，后续**依赖该步骤**的 gate 也标 BLOCKED；不依赖的只读调查可以继续，但不能制造上游已通过的假设。

## 4. PARAM：真实 Deep000:param 验收算法

### 4.1 目标

证明“DOM 虚拟化”之外，数据入口也真正变成 metadata eager / payload lazy，并验证 ESP slider/enum hint。

### 4.2 定位

依次定位这些符号，不按旧行号：

- `ParamEditorAppShell`；
- `ParamTablePanel`；
- `loadAll`；
- `readParamPageMetadata`；
- `ParamFieldSliderHint`；
- `EnumEditorModel`；
- `readParamPage` 的 renderer -> main -> Bridge 完整调用链。

### 4.3 必须添加/取得的计数

一次“打开工作区 -> 打开 Deep000:param -> 选择一张大表 -> 选择一行”的 run，记录：

```text
initialOpen.readParamPageCalls
initialOpen.readParamPageMetadataCalls
initialOpen.fullPayloadRequestCount
initialOpen.payloadBytes
initialOpen.metadataRows
postSelect.readParamPageCalls
postSelect.payloadBytes
visibleOrSelectedRowRange
```

### 4.4 PASS 判据

全部满足才 PASS：

1. 初次打开表时，不调用 `readParamPage(..., loadAll=true)` 或语义等价的“全表 raw payload”路径；
2. 可以一次得到全表 `rowId + rowName` 等轻 metadata；
3. raw bytes / decoded field payload 只为可见窗口、页或显式选中行读取；
4. 选中/滚动后 payload 增量与请求范围对应，不出现一次性全表搬运；
5. 至少选择一个有官方 slider hint 的字段，UI 的 min/max/step 与 authority metadata 一致；
6. 至少选择一个 enum 字段，选项值/显示名与 authority metadata 一致；
7. 搜索、筛选、滚动、切换行、编辑后没有行为回归；
8. artifact `sourceCompleteness=complete`。

不要自行创造“payload 必须 < X MiB”的新阈值；若 mission 已冻结阈值，使用冻结值，否则只证明“没有全量 payload”和精确实测值。

### 4.5 negative test

在测试替身中故意把初次 open 改回 `loadAll=true`。验收 test 必须失败，并明确指出 `fullPayloadRequestCount > 0`。如果仍绿，说明判据是死的，PARAM 不得验收。

## 5. Loading：必须拆成三个 gate

禁止再用一个“loading 已优化”结论覆盖三条独立问题。

### 5.1 L1 Workspace startup：Fast Catalog + Deep Verification

目标：workspace 可交互之前不再串行读取所有文件正文做 SHA256。

一次 fresh unchanged workspace run 记录：

```text
filesDiscovered
filesHashedBeforeWorkspaceReady
bytesHashedBeforeWorkspaceReady
workspaceReadyMonotonicMs
hashEventsAfterWorkspaceReady[]
```

正常 unchanged workspace 的强判据：

- `filesHashedBeforeWorkspaceReady == 0`；
- `bytesHashedBeforeWorkspaceReady == 0`。

Fast Catalog 只允许读取目录项、相对路径、size、mtime 等 metadata。内容 hash 只能在 workspace ready 后，由明确原因触发：

- authority 文档打开；
- 写回前并发修改校验；
- size/mtime 与缓存不一致；
- 某个深索引明确需要内容身份。

若启动路径仍逐文件 `open/read/sha256`，即使总时间变短也 FAIL。

negative test：在 scanner test double 中把 hash 调用重新放到 ready 前，gate 必须红。

### 5.2 L2 Map：同一 mapbnd Parse Once

对同一 `(sourceUri, sourceRevision)` 打开包含 M 个不同 model 的地图，记录：

```text
archiveOpenCount
dcxDecompressCount
bndParseCount
flverParseCountByEntry
requestedModelCount
```

PASS：

- `archiveOpenCount == 1`；
- `dcxDecompressCount <= 1`；
- `bndParseCount == 1`；
- 每个实际请求 entry 的 FLVER parse count `<= 1`；
- 重复请求相同 model 不增加 archive/decompress/BND parse；
- sourceRevision 改变后才允许新 session。

M=300 时绝不能出现近似 300 次 archive open/decompress/BND parse。

实现边界：建立按 content identity/revision 持有的 session/cache；renderer 请求 model 是在已打开 session 上投影，不是重新打开 mapbnd。

### 5.3 L3 Character：同一 chrbnd/FLVER Parse Once

对一次 c0000 或 acceptance corpus 的角色预览记录：

```text
containerOpenCount
containerDecompressCount
containerParseCount
flverDocumentParseCount
meshProjectionCount
meshCount
```

PASS：

- container open/decompress/parse 每个 content revision `<= 1`；
- FLVER document parse `== 1`；
- `meshCount == 46` 一类情况只代表从同一 parsed document 投影 46 个 mesh，不能等于 46 次 FLVER parse；
- client 不再用 `for previewIndex -> await readTaeChrbndPreview(...)` 让 native 重解同一容器；
- 重开同一 content identity 命中 READY session；revision 变化精准失效。

negative test：令 mesh projection 内部重新 parse FLVER，gate 必须通过 `flverDocumentParseCount` 抓红。

## 6. Tauri/其他 backend 绕写风险收敛算法

### 6.1 枚举，不凭印象

搜索：

```text
src-tauri
@tauri-apps/api
invoke(
set_working_directory
sync_workspace_deep_index
delete_workspace_file
```

对所有 IPC/backend command 建表：

```text
command
caller
readsFile
writesFile
deletesFile
movesFile
updatesIndex
passesCoordinator
passesOperationLedger
passesBackupRecovery
passesAtomicCommit
classification
```

classification 只能是：

- `READ_ONLY`；
- `INDEX_SYNC_ONLY`；
- `MUTATING_CONVERGED`；
- `MUTATING_BYPASS`。

### 6.2 收敛规则

凡是创建、覆盖、删除、移动游戏/mod/workspace authority 文件的 command 都是 mutation。

mutation 必须进入同一个写协调层，满足：

```text
validate target
-> stage
-> OperationLedger
-> backup/recovery registration
-> atomic commit
-> postcondition re-read
-> rollback capability
```

`delete_workspace_file` 不能保留“直接 filesystem delete 然后返回成功”的生产路径。

若暂时无法接入统一协调层：生产 command 必须 fail-closed/禁用，并返回 `WRITE_PATH_BYPASS`；不能把 bypass 留着同时宣称 Patch Engine 是唯一写入口。

## 7. 两个 Workspace Root 必须分开

定义两个不同概念：

- `agentWorkspaceRoot`：Agent session/project 的运行根，存 prompt、history、项目状态等；
- `gameDataWorkspace`：当前被编辑的游戏/mod 数据 authority 根。

禁止使用一个泛化 `workspaceRoot` 在不同层静默代表两个概念。

### 7.1 解析算法

```text
1. session 创建时解析 agentWorkspaceRoot；
2. 从 workspace/project binding 显式解析 gameDataWorkspace；
3. canonicalize 两个绝对路径；
4. 为每个路径记录 resolutionSource + generation + identity/hash；
5. 把 gameDataWorkspace 显式传给需要读/写游戏数据的工具；
6. tool result/evidence 写 workspaceKind；
7. 若 gameDataWorkspace 无法解析，停止游戏数据操作。
```

失败码：`GAME_DATA_WORKSPACE_UNRESOLVED`。

禁止 fallback：

```text
if gameDataWorkspace missing:
    gameDataWorkspace = agentWorkspaceRoot
```

即使两者在某个 fixture 中恰好是同一路径，也必须保留两个字段和两份 provenance；相等是运行事实，不是类型合并理由。

验收至少有 2 个 fixture：

1. 两者相同；
2. 两者不同。

第二个 fixture 必须证明 Agent 日志写入 agent root，而 PARAM/MSB/EMEVD 等读取来自 game-data root。

## 8. Mutation capability 真值表

不要从工具名字推导“某格式支持修改”。

每个格式必须用下面证据链判定：

```text
user semantic intent
-> tool schema
-> mutation adapter
-> staging document
-> validator
-> commit coordinator
-> authority write
-> re-read postcondition
-> rollback test
```

只要中间缺一环，状态不得高于 `IMPLEMENTED_NOT_ACCEPTED`；只有 read adapter 而无 mutation adapter 时是 `READ_ONLY`。

本次收口前的保守规则：

- PARAM：可按现有 `stage_mutation` / `commit_staged` 证据继续做 X5；
- FMG/MSB/EMEVD：必须各自找到显式 mutation adapter 和 X7 evidence 后才能宣称可写；
- 不得因为 `readAuthority` 存在就宣称 writeback 存在；
- ESD 同理，X6 必须走自己的真实 adapter/round-trip 证据。

如果 docs/tool registry 已宣称某格式可 mutation，但真实证据链不完整：先把 capability 降为真实状态，再做实现，不能用文档宣称反向证明代码存在。

## 9. §24.17 FLVER Authority Loader：补足 text-only 语义

已有 FLVER 几何、topology、skin binding 数学继续以 mission1 §24.16–§24.17 为准，本节只消除 fallback 歧义。

### 9.1 唯一允许的 surrogate 条件

`sourceKind="text-surrogate-test-only"` 只允许同时满足：

1. 当前运行是显式 test/fixture mode；
2. 输入 resource manifest 明确标记为 surrogate fixture；
3. 调用方没有把结果计入真实 FLVER acceptance。

真实 `.flver` / `.flver.dcx` authority 打开失败时，禁止自动尝试把同路径/邻近路径当文本 surrogate。

生产二进制 FLVER 如果 SoulsFormats/native authority 不可用，返回 `FLVER_AUTHORITY_UNAVAILABLE`。

真实 FLVER gate PASS 必须观察到 `sourceKind == "soulsformats"` 或 mission 冻结的真实 native authority kind。

### 9.2 比较算法

结构比较只比较语义 payload：mesh/vertex/index/topology/skeleton/binding/material 等 authority 字段。diagnostics、计时、cache hit、session id 等运行 metadata 不得进入结构等价判定。

浮点容差使用 mission 已冻结的容差；不得为让测试变绿自行扩大。

## 10. Character Action：弱 Agent 只走已有唯一契约

不要新建第二套 Action DTO。`mission1.md` 已经定义：

```text
selection
-> ActionSelectionRecordV1
-> resolveAnimationPlayback
-> AnimationPlaybackContext
-> Bridge exact animation/skeleton entries
-> AnimationClipSemanticEnvelopeV2
-> DecodedClipCacheKeyV2
-> retarget plan
-> one leader skeleton
```

执行者的算法：

1. 先定位上述现有类型/producer/consumer；
2. 每个阶段列出“输入 identity -> 输出 identity”；
3. 验证 animation 与 skeleton 两个 URI 都经过 active resource graph 解析；
4. graph exact edge 为 0 时要求显式 skeleton 选择，禁止猜目录/邻近文件；
5. graph edge >1 时返回 ambiguity，禁止取第一个；
6. Bridge 只收 main 已验证的真实 path/entry identity/allowedRoots；
7. coordinate conversion 只发生在 mission 指定的 Bridge native HKX projection 位置；
8. clip DTO 的 coordinate/rule/unit bits 与 leader/context 不一致时 fail-closed；
9. decoded clip、assembled bundle、retarget plan 按 mission 已冻结 key 和 owner 规则缓存；
10. 角色包含 N 个 mesh 时只建一个 leader skeleton/retarget plan，不得每 mesh 重建；
11. 完成后跑 mission 已有 non-commutative quaternion、matrix、cache/close negative fixtures。

如果当前代码无法映射到这条链，返回 `ACTION_CONTRACT_DIVERGED`，先修收敛，不得新增兼容层继续分叉。

## 11. Texture direct fallback：流式上界

已有硬预算继续使用 mission1：preview payload 上限、preview side、timeout、服务峰值内存等不得修改。

新增执行规则：

1. 真实 texture direct fallback 禁止 `readFile -> whole source bytes -> decode` 作为通用路径；
2. adapter 必须声明自身是否支持 bounded streaming/random access；
3. source reader 只允许有界 chunk/window；
4. 同时在内存中的 source chunks、decoder workspace、output payload 必须受现有服务峰值预算约束；
5. output preview 仍受 mission 已冻结 payload 上限；
6. 如果某 codec/adapter 必须完整 buffering 且无法证明峰值预算，则 fail-closed：`TEXTURE_STREAMING_UNSUPPORTED`；
7. 禁止为了兼容大文件静默扩大 buffer/内存预算。

验收 artifact 必须包含：source size、peak source bytes resident、decoder peak、output bytes、service peak、chunk/window count。仅记录最终 PNG 大小不算证明流式。

## 12. HKX：无 `.xml` legacy 处理算法

固定顺序：

```text
input = exact selected resource
if input is explicit XML fixture:
    use XML fixture reader
else if binary HKX layout is supported by registered native serializer:
    use that binary serializer
else if exact legacy layout has a registered, versioned converter adapter:
    run converter -> capture converter identity/hash -> parse result
else:
    fail HKX_LEGACY_CONVERTER_REQUIRED
```

硬规则：

- 不寻找“同目录同名 `.xml`”作为生产 fallback；
- 不把 sibling XML 当 authority；
- 不尝试多个 serializer 直到某个“不报错”；
- parser/converter 的 id、version/hash、source layout identity 必须写进 provenance；
- converter 输出也必须受 exact source hash/entry identity 绑定。

negative fixture：放置一个同名但内容错误的 sibling XML；真实 binary 打开结果不能受它影响。

## 13. EMEVD：`eventId/instructionIndex -> byteOffset` 唯一算法

禁止用 `IndexOf(argsBase64)`、搜索参数字节、猜 instruction 大小或从序列化后对象反推偏移。相同参数可能重复，这些算法会定位到错误 instruction。

正确算法必须在**解析 authority source 的同一遍 binary walk** 中捕获位置：

```text
parse source container / EMEVD authority
for each event in physical source order:
    establish exact event identity and eventId
    for each instruction in that event in physical instruction order:
        instructionStart = absolute source reader position before reading instruction record
        read exactly this instruction record using the format/layout rule
        instructionEnd = absolute source reader position immediately after the record
        require instructionEnd > instructionStart
        attach {
            eventId,
            instructionIndexWithinEvent,
            globalInstructionOrdinal,
            byteOffset: instructionStart,
            byteLength: instructionEnd - instructionStart
        } to parsed semantic instruction
```

解析完成后解析查询：

```text
resolve(eventId, instructionIndex):
    events = exact events whose id == eventId
    require events.count == 1
    require instructionIndex is integer and 0 <= index < event.instructions.length
    instruction = event.instructions[index]
    require instruction carries source position captured by this authority parse revision
    return byteOffset + byteLength + source identity
```

如果格式本身的 event id 允许重复，则不能假装 `eventId` 唯一；必须使用 mission/format authority 定义的更强 physical event identity，并让查询 DTO 显式携带它。发现重复而现有 API 只有 eventId 时返回 `EMEVD_EVENT_ID_AMBIGUOUS`，不得取第一个。

若当前 SoulsFormats API 不暴露 reader position：在 Bridge/native adapter 边界增加**offset-aware table walker/parser**，它必须遵守同一版本 format layout，并与语义解析结果按 physical ordinal 对齐；禁止改用 payload 字节搜索替代。

验收至少包含：

- 两条 args 完全相同但位置不同的 instruction；
- event 内多个 instruction；
- 多 event；
- malformed/truncated source；
- round-trip 后 offset 重新计算，而不是沿用旧 revision 的 offset。

negative fixture：故意把 offset resolver 改成 `IndexOf`，重复 args case 必须失败。

## 14. X5/X6/X7：机器可验证 writeback artifact

### 14.1 不允许 Agent 临时挑目标

每个 gate 必须先有 acceptance fixture manifest。manifest 为每个 gate 指定：

```text
source resource identity
format
safe target coordinates
operation kind
requested value
expected postcondition
preservation invariants
rollback requirement
```

如果 fixture manifest 缺目标，不允许 Agent去真实数据里“找一个看起来能改的”。返回 `ACCEPTANCE_FIXTURE_MISSING`。

### 14.2 通用 artifact schema

每次 X5/X6/X7 writeback 产出一个独立 JSON，至少有：

```json
{
  "schemaVersion": 1,
  "gate": "X5_PARAM_WRITEBACK",
  "runId": "...",
  "build": {
    "commitSha": "...",
    "missionSha256": "..."
  },
  "source": {
    "uri": "...",
    "workspaceKind": "gameDataWorkspace",
    "sha256Before": "..."
  },
  "target": {
    "kind": "...",
    "coordinates": {}
  },
  "operation": {
    "kind": "...",
    "beforeValue": null,
    "requestedValue": null
  },
  "staging": {
    "uri": "...",
    "rereadValue": null,
    "postconditionPass": false
  },
  "commit": {
    "performed": false,
    "sha256After": null,
    "rereadValue": null,
    "postconditionPass": false
  },
  "rollback": {
    "performed": false,
    "restoredSha256": null,
    "matchesBefore": false
  },
  "preservation": {
    "unknownDataPreserved": false,
    "evidence": []
  },
  "sourceCompleteness": {
    "status": "complete",
    "evidence": []
  },
  "result": "FAIL"
}
```

### 14.3 通用执行算法

```text
A. load fixture manifest
B. resolve exact source + target; no guessing
C. hash source before
D. authority read beforeValue
E. create semantic mutation
F. stage only
G. re-read staging authority
H. verify staged postcondition + preservation
I. commit through one mutation coordinator
J. re-open committed authority from disk
K. verify requested afterValue + preservation
L. execute rollback when gate requires it
M. re-open disk again
N. verify restored hash/value == before
O. write artifact
P. independent verifier recomputes result
```

任一步失败：`result=FAIL`，记录失败 step；不得跳过后面的必要 rollback cleanup。

### 14.4 各 gate coordinates

X5 PARAM：target 至少为 `{paramType,rowId,fieldName}`，artifact 同时记录 row identity/field metadata identity。

X6 ESD：target 必须使用当前 authority adapter 能稳定唯一定位的 state/group/command coordinates；若现有实现没有稳定坐标，先修 adapter，不能把“文本搜索第一个命中”当坐标。

X7 拆成三个独立 gate：

- `X7_FMG_WRITEBACK`；
- `X7_MSB_WRITEBACK`；
- `X7_EMEVD_WRITEBACK`。

总 `X7` 只有三者全 PASS 才 PASS。

FMG target 至少记录 message table/language identity + entry id；MSB target 至少记录 map authority identity + concrete part/event/region identity + property；EMEVD target 至少记录 exact event physical identity + instruction index/argument or documented semantic field，并绑定 §13 的 source offset/revision evidence（若该 mutation 需要 byte-level provenance）。

不能用 `X7_FMG PASS` 代替整个 X7。

### 14.5 preservation

writeback 不只验证“目标值变了”。至少验证：

- 未编辑记录计数/identity 未丢失；
- 未知字段/opaque bytes 按格式契约保留；
- ordering 只有格式明确允许时才变化；
- container entry 不被意外删除/重命名；
- staging 与 committed authority 都可重新解析。

## 15. editorWriteBack 与 missionText

### 15.1 editorWriteBack

只有当 UI/editor 发起的真实 edit 最终进入与 Agent 相同的 mutation coordinator，并能产出 staging/commit/postcondition/rollback evidence，才可 PASS。

如果 UI 直接写文件，而 Agent 走 Patch Engine，视为 write-path split，FAIL：`EDITOR_WRITEBACK_BYPASS`。

### 15.2 missionText

missionText gate 不是“文档存在”。至少检查：

- report 中所有 P0/P1 未完成项是否有明确去向；
- 本文件规定的失败码/算法是否与现存具体契约冲突；
- 旧的“未测试但写完成”字样是否仍能误导；
- 所有 required gate 是否链接到机器 artifact；
- capability 文案是否与 mutation truth table 一致；
- 没有新硬编码行号作为唯一定位方式。

## 16. Acceptance verifier 的固定逻辑

`verify-mission1-acceptance` 若不存在，先创建/恢复 verifier；不能人工看 JSON 后口头宣称 PASS。

verifier 的 required gate 至少包括：

```text
trustRoot
param
loading.workspaceStartup
loading.mapParseOnce
loading.characterParseOnce
writePathConvergence
workspaceRootSeparation
mutationCapabilityTruth
flverSemantics
characterActionContract
textureStreaming
hkxLegacy
emevdOffset
x5Param
x6Esd
x7Fmg
x7Msb
x7Emevd
editorWriteBack
missionText
```

算法：

```text
for every required gate:
    require artifact exists
    require schema valid
    require artifact.commitSha == tested commit
    require artifact.missionSha256 == tested mission
    require sourceCompleteness.status == "complete"
    require result == "PASS"
    recompute gate-specific predicates from raw fields
    reject if child-declared PASS disagrees with recomputation

overall PASS only if every required gate recomputes PASS
```

verifier 不得采用：

- “文件存在即 PASS”；
- “result 字符串写 PASS 即 PASS”；
- partial completeness 降权；
- 缺 artifact 当 skipped；
- 用一份 umbrella loading artifact 代替三个 loading gate；
- 用一份 umbrella X7 artifact 代替三个格式 gate。

## 17. 最终执行报告模板

最终报告只写事实，不写计划口吻。固定字段：

```text
Mission commit:
Mission SHA256:
Product commit:
Working tree pre-existing changes:

Gate | Result | Artifact | Raw command/test | Failure code
...

Unresolved blockers:
- exact blocker
- exact missing authority/fixture/implementation
- dependency gates affected

Capability truth table:
Format | Read | Stage | Commit | Re-read verify | Rollback | Accepted

Loading counters:
startup: ...
map: ...
character: ...

Writeback artifacts:
X5: ...
X6: ...
X7-FMG: ...
X7-MSB: ...
X7-EMEVD: ...

Overall: PASS | FAIL | BLOCKED
```

## 18. 弱 Agent 最后检查表

在说“完成”之前逐项回答 YES/NO；任一 NO 都不能 overall PASS：

1. 我是否先通过了 Trust Root？
2. 我是否没有用旧行号当唯一定位？
3. 我是否没有猜 ID、路径、邻近文件或 fallback？
4. 我是否把 zero hit 与 complete coverage 区分开？
5. 我是否对连续低信息增益做了熔断？
6. 我是否先测 baseline 再改？
7. PARAM 是否真实证明 payload lazy，而不只是 DOM virtual？
8. startup/map/character loading 是否分别有独立计数和 artifact？
9. 所有 mutation backend 是否收敛到同一协调器？
10. agentWorkspaceRoot 与 gameDataWorkspace 是否显式分离？
11. capability 文案是否只宣称真实证据支持的能力？
12. FLVER production 是否绝不静默落入 text surrogate？
13. Character Action 是否复用已有唯一 semantic contract，而非新造兼容 DTO？
14. texture fallback 是否证明有界内存？
15. binary HKX 是否不会偷偷读 sibling XML？
16. EMEVD offset 是否来自同一 authority parse 的物理 reader position，而非字节搜索？
17. X5/X6/X7 是否都使用 manifest 指定的安全 target？
18. X7-FMG/MSB/EMEVD 是否各自独立 PASS？
19. 每个 PASS 是否都有机器可重算 artifact？
20. 每个 required artifact 是否 `sourceCompleteness=complete`？
21. negative/perturbation test 是否真的能抓到故意错误？
22. 写回后是否重新从 disk authority 读取，而不是读内存旧对象？
23. rollback 是否重新读取并证明恢复？
24. verifier 是否自己重算，而不是相信 child 的 PASS 字符串？
25. 最终 overall 是否严格等于所有 required gate 的逻辑 AND？

只有 25 项全部 YES，Mission 1 才允许写 `PASS`。

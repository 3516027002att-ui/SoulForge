# SoulForge 执行手册


当前工程入口是 [AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](../ARCHITECTURE.md) 与 [DECISIONS.md](DECISIONS.md)。验证从 `node scripts/check.mjs --list` 选择实际存在的检查；新的约定测试自动发现，无需手动 tier 登记。

本文第 0–9 节保留旧执行流程的历史说明。其 gov claim/seal、治理 JSON、冻结投影、全局 Evidence freshness 与切片登记流程已退役，不能用于认领任务、批准写入、限制开发或宣称完成。历史产品边界应以当前源码与上述工程入口核对。

[第 10 节 CLI 与真实 Agent 验证](#agent-tool-validation) 保留实际工具调用、分页、隔离工作区、结果解读与排障说明；参数以当前 `--help` 和执行结果为准。Agent 的共享 assembly、有限控制内核与 headless 路径见 [AGENT_RUNTIME.md](AGENT_RUNTIME.md)。

---

## 0. 为什么需要这份手册

交接书刻意是一张依赖驱动的技术地图，不是线性工单。规划强的 Agent 能自己排路径；规划弱的 Agent 会卡在三处：

| 卡点 | 表现 | 本文对策 |
|---|---|---|
| 选择瘫痪 | 面对多个切片来回权衡，不动手 | §3 选点决策树，输出**唯一**一个切片 |
| 颗粒度错位 | 切片太抽象，不知从哪行代码开始 | §4 拆解模板，套成有序微步骤 |
| 缺量化与沉淀 | 做完不知算不算完，也不知给下家留什么 | §5 二值完成判定 + §6 沉淀通道 |

用法：需要拆解复杂切片时按依赖选用相关章节。已有明确任务、边界和验证入口时直接执行；同一批相关改动可以连续完成，合并验证与构建，不必每个微步骤重启整套流程。

---

## 1. 涉及产品行为时的安全边界

下列边界只约束涉及的产品操作，常规回复不需要复述清单。发现边界冲突时停止该操作，继续不依赖它的工作。

- [ ] 我没有在 Patch Engine 之外用 `fs.writeFile` 改 Mod 资源；writer/converter 只写 main 控制的暂存根。
- [ ] renderer 不碰文件系统、不拿真实绝对路径；`THREE.Object3D` / React state 不作权威场景文档。
- [ ] Mod 资源仅写当前打开的工作区且经过 Patch Engine；工作区伴生数据库与缓存可写入根目录 `.soulforge/`，权限拒绝时降级独立本地目录；日志和全局备份仍隔离管理。
- [ ] 未知字段无法无损保留 → 不开 writer；no-op roundtrip 不成立 → 停。
- [ ] 不让 fixture / candidate 冒充 native；不让 raw replace 冒充 native writer。
- [ ] `unsupported` / `failed` / `partial` / `blocked` 返回**结构化诊断**，不吞异常、不猜默认值。
- [ ] C# Bridge 是原生格式唯一 production authority；TypeScript 不另起第二套 production parser。
- [ ] 不提交真实资产、用户 Mod、Oodle DLL、API key、签名私钥、私有 corpus。
- [ ] 完全权限也不绕过 Patch Engine / 验证 / 备份 / 审计 / 回滚。
- [ ] 受管文档中的脚本名、治理子命令和可打开入口都已从当前仓库核实，不写占位引用。

---

## 2. 切片执行流程

这些阶段用于组织复杂工作，不是每次编辑都要重新执行的门禁。

| 阶段 | 动作 | 产物 |
|---|---|---|
| **L0 定位** | 检查 `git status` 与 `HEAD`；需要选点或更新治理时查看 `gov next` / `status`，输入未变时复用本会话结果 | 知道真实工作树与可 claim 切片 |
| **L1 选点** | 需要新选点时按 §3 选择切片，用 `node scripts/gov.mjs claim --slice <id> --owner <你>` 原子认领 | 一个 lifecycle=`active` 的切片 ID |
| **L2 立据** | 按交接书 §13.2 准入模板，只补齐当前上下文缺少的边界、验证和 authority 信息；不另建重复草稿 | 一份开工契约 |
| **L3 拆解** | 按依赖拆解并批量完成边界明确的步骤 | 一个微步骤 |
| **L4 实现** | 严格在"允许改的入口"内实现该微步骤；命中压舱石红线即回 §1 | 代码改动 |
| **L5 验证** | 按当前切片 requiredValidation 验证本批改动；相同输入的命令只运行一次，真实失败保留并定位原因 | 通过/失败 + 样本范围 |
| **L6 沉淀** | 按 §6 判断是否命中写回触发器；命中时通过治理源与 CLI 更新状态、Evidence 和投影，否则只保留本轮验证结果；仅相关治理输入发生变化时运行治理验证 | 必要的唯一事实源更新，或明确无写回 |

任务边界、依赖或并发状态变化时回到定位阶段；无需在每个微步骤之后重跑定位、验证或封存。

---

## 3. 选点决策树：消除"选哪个"

严格按顺序回答，命中即停，输出唯一切片。不要在多个候选间反复权衡。

**Q1 与 Q2 已由 CLI 机械完成**：`node scripts/gov.mjs next` 的 `claimable` 列表按生命周期与并发占用过滤，默认不按发布版本排除切片；只有显式 `--release` 才按发布归属筛选。`activeSlices` 列出在飞 claim 及其持有者。直接从 `claimable` 进入 Q3，不要手工比对交接书表格——那些表格是 `docs/governance/slices.json` 的投影，手工读只是多一次转录机会。

若 `claimable` 为空，`message` 会指出实际原因与对应出路（deferred 指向 `scope.json` 的 `resumeRequires`，active 指向 release/complete，blocked 指向 `blockers.json`）；按它走，必要时去 §8。

~~~text
Q1 gov next 的 activeSlices 里是否有一条由我持有？
   是 → gov heartbeat --slice <id>，只继续这个切片。停。
   否 → 尊重其他新鲜 claim；过期 claim 按 recoveryTrigger 核实任务与写入状态。
        只有确认可回收且当前会话有处置权限时才通过 CLI release；无法核实则保留占用，转 Q2 选择独立工作。

Q2 取 gov next 的 claimable 列表（按可开发生命周期与占用状态过滤，不默认按版本过滤）。
   为空 → 按 message 指出的出路处理，或去 §8；非空 → Q3。

Q3 剩余切片里，是否有"能解锁多条下游路线的共同底座"(如 A-RECOVERY)？
   有 → 选它，去 Q6。
   无 → Q4

Q4 是否有"能关闭高风险未知的只读研究 / validator / diagnostics"(不需写权限)？
   有 → 选它，去 Q6。
   无 → Q5

Q5 仍有多个并列 → 取交接书 §3.1 依赖表中**行序最靠上**者，去 Q6。

Q6 选定后用 gov claim --slice <id> --owner <你> 原子登记占用，
   由 CLI 更新 lifecycle 与 claim 信息及投影；不手改 §13.1.1，不改 authority、不追加 Evidence；
   claim 的 CLI 校验成功后进入实现；仅为认领状态变化不另跑完整回归。
~~~

选点铁律：**独立切片可并行；但共享 native writer / Patch Engine / migration / 协议变更的切片必须串行**（交接书 §0.3）。本轮只认领一个。

---

## 4. 拆解模板库：把切片套成微步骤

先给选中的切片归类（看它的"目标能力"和"authority 上限"），再套对应模板。模板用于暴露依赖，不要求逐步停顿。native 写入和事务安全顺序保持不变；其余步骤可在依赖满足时合并实施、统一验证。

模板选择表：

| 切片特征 | 用模板 | authority 上限 |
|---|---|---|
| 格式勘察 / 资源清单 / 引用候选（只读） | K1 | `candidate` |
| 只读文档扩展 / 语义投影 / render packet | K2 | read projection `partial` |
| DSL / schema / typecheck（不写二进制） | K3 | `fixture-confirmed` |
| native writer / 事务 / 三层回滚 | K4 | 覆盖范围内 `partial`→`native-verified` |
| adapter 契约 / 失败关闭（不启动真实外部） | K5 | contract `fixture-confirmed` |
| 静态门禁 / 校验脚本 | K6 | 门禁诚实性 |
| 真实模型服务 / 真实运行 smoke（需凭据/环境） | K7 | provider loop `partial` |

### K1 只读勘察 / candidate inventory

1. 确认合法输入样本来源；先检查已有 registry、针对性公开资料与适用 adapter；有新线索再扩大调查。确认所需外部输入无法取得时记录具体阻塞与可继续的工作，不以穷尽所有来源为停止前提。
2. 原生格式解析在 C# Bridge 扩展；core 只组织探测结果和投影，不维护第二套 production native parser。只提取可确认字段并返回 `diagnostics`。
3. 对可确认字段写断言；不确定的标 `candidate`，不猜。
4. 冲突 / 未知变体 → 结构化记 `unsupported` 并留证据，停在只读。
5. 写 smoke 测试，接入对应 `test:*` 脚本。
6. L6 记 `candidate` 证据；**不解锁任何 writer**。

### K2 只读文档 / 语义投影扩展

1. 确认底层 native document 已达 `partial` 或更高（否则先做 K4 的读侧）。
2. 扩展 renderer-independent 语义投影 / render packet，保持 entity identity 与 revision 稳定。
3. 确保 renderer-safe 投影删除绝对 `sourcePath`，不授写权限。
4. 验证同一输入两次投影一致（幂等）。
5. 跑对应 `bridge:verify:*` 与场景 `test:*`。
6. L6 记 read projection `partial`；**不提升实体 writer**。

### K3 DSL / schema / typecheck（fixture 阶段）

1. 复用既有 IR / schema（如 `emevd-editor-ir`、`emedfSchema`），不新造。
2. 实现 source → parser → AST → typecheck 链，只输出 **typed mutation proposal**。
3. 未知指令 / 类型 → 失败关闭，不静默通过，不生成二进制。
4. 写 parse / typecheck / roundtrip fixture 断言。
5. 跑对应 `test:emedf-schema` / `test:*-four-view` 等。
6. L6 记 `fixture-confirmed`，并写明"未经真实样本重读与游戏验证"。

### K4 native writer / 事务 / 回滚（最高门槛，最严）

1. 前置：只读文档 `partial` + no-op roundtrip 成立，否则停（交接书 §16）。
2. mutation 走 PatchIR + 暂存：writer 只写 main 暂存根，禁止直接 `fs.writeFile`。
3. 打通 stage → validate → commit → 重读闭环，重读不一致即失败关闭。
4. 接 operation / file / resource-entry 三层 inverse。
5. 至少覆盖一个崩溃注入点（stage/validate/commit/re-read 之一）。
6. 跑该 writer 的 `bridge:verify:*` + transaction smoke。
7. L6：有真实样本闭环才可提 `native-verified`，且只限已验证布局/变体。

### K5 adapter 契约 / 失败关闭

1. 先完成公开行为与许可证裁定（如 me3、Oodle 的接口边界）。
2. 定义 contract（如 `GameRuntimeAdapter`）+ detect / capability 返回结构化诊断。
3. 自实现 Mod loader 须走独立切片与验证（2026-08-18 用户裁定放开，见 releases.json unfreezeRuling）；不启动真实游戏（无对应 authority）、不分发运行库。
4. 写 contract smoke + 缺失/错误版本的失败关闭测试。
5. L6 记 contract `fixture-confirmed`；不证明真实运行成功路径。

### K6 静态门禁 / 校验脚本

1. 明确要守的**不变量**，只做零误报、可确定性判定的检查。
2. 参照既有 `scripts/verify-*.mjs` 范式（ESM / node:fs / findings / JSON / exitCode）。
3. **必做负向测试**：构造畸形样本，确认门禁 `exit 1`，且诊断指向该样本的真实原因；恢复样本后确认 `exit 0`。新增断言后还要核对检查总数按预期增长，不增长就是没有执行。
4. 未覆盖项诚实列入 `engineeringReviewStillRequired`，同时输出 `reviewOwner=engineering-agent` 与 `userActionRequired=false`；工程语义复核不得转嫁给用户。
5. 接入 `package.json` 与交接书 §15.1 矩阵。
6. L6 记门禁诚实性证据。

### K7 真实服务 / 真实运行 smoke（需凭据或环境）

1. 前置：凭据只经 main + safeStorage；无合法环境则该切片 `blocked`，回 §3。
2. 固定无写 / 受控写工具集，写工具仍复用 native validator + Patch Engine。
3. 跑真实只读循环 + 取消 / 超时 / 错误 / 审计 / 凭据脱敏。
4. 采集真实数据，但**不得自行把观测值定义为发布标准**；按当前范围裁定、validation registry 与相应测试契约判定，不从历史版本恢复已删除标准，也不为了通过而放宽现有断言。
5. L6 记脱敏结果为 provider loop `partial`；不提升生产写 Agent。

**套不上模板？** 回 §3 按交接书 §3 缩小范围，或把切片拆到能套上为止。宁可缩小，不要硬闯。

---

## 5. 量化：微步骤二值完成判定

按本次任务实际涉及的行为判定。无关检查不要求执行；相关检查未通过时保留失败或未验证状态，但不阻止独立工作。

- [ ] 生产调用链真正接通（不是孤立 helper / scaffold）。
- [ ] 失败 / unsupported / partial / blocked 都返回结构化诊断。
- [ ] required validation 实际运行，记录了退出码、样本范围、关键断言。
- [ ] 写能力（若涉及）跑通 staging → validator → commit → 重读 + 适用层级回滚。
- [ ] 未超 authority 上限；未验证项已明确列出。

没运行的命令、没读的文件、没验证的结论必须明说；`candidate`、`fixture-confirmed`、`partial`、`native-verified`、`blocked`、`unverified` 不得互相冒充。

**切片级完成** = 该切片**所有**微步骤都通过上表 + 交接书 §13.2 条件，并将 lifecycle 改为 `completed`；authority 只按真实证据独立更新。单个微步骤完成只是本地验证结果，不等于切片完成，更不等于路线或 Gate 完成。

---

## 6. 沉淀：唯一合规通道

进度沉淀进**治理 JSON 与其交接书投影**，禁止新建平行清单，但普通微步骤不应让唯一事实源膨胀。L6 先判断本轮是否发生任一写回触发器：

- 切片完成；
- authority 变化；
- blocker 变化；
- required validation 契约变化；
- 跨 Agent 交接导致治理状态或证据口径实质变化；仅转述已有上下文不触发封存。

命中触发器时：

1. **先提交本轮改动**。封存指纹的锚点是 HEAD，未提交的改动会算进 `trackedDiffSha256` 但不进 HEAD，导致证据永远清不掉 stale。
2. `node scripts/gov.mjs seal --id EV-… --subject … --commands … --result … --non-claims …`，改了 Gate 主题域文件时再加 `--gates`。`--subject` 必须写明重验证链尾并原样继承目标 Gate 既有的 `user-approved` 标记；CLI 只报告缺失标记，绝不代替用户补写。参数细节与封存四步跑 `node scripts/gov.mjs help` 看 `sealWhenToUse` / `sealRequiredArgs`。
3. seal 成功后检查 `uncommittedAfterSeal`，把列出的 Evidence、Gate 与交接书投影全部提交；漏交任一文件都会造成事实源分叉。
4. 切片收尾用 `node scripts/gov.mjs complete --slice <id>`。它只改执行面板状态，不提升 authority——authority 提升必须另有真实运行的验证支撑。
5. 跑 `node scripts/verify.mjs --tier governance` 确认全绿。

**不要手写交接书里的证据条目或状态表。** §13.1、§13.1.1、§15、§17.1、§18.2.1、§18.3、§18.4 都是治理 JSON 的投影，手写的内容会被下一次 `handoff:project` 覆盖，或者变成第二份无人校验的进度口径——那正是硬约束「不得另立进度口径」要防的东西。§17.2 以下按日期排列的历史条目是外化前的留痕，保留供审计，但不是权威、不被任何门禁读取，也不要在那里追加新条目。

未命中触发器时，不追加 Evidence；保留本轮验证结果并继续同一 `active` 切片。无论是否写回，大日志 / 产物都放应用数据目录或系统临时目录，**不提交**，且不写绝对路径或凭据。

这样下一个 Agent（或下一轮的你）在 L0 跑一次 `gov next` 即可无缝续接——**治理 JSON 就是记忆，交接书是它的可读投影，本文只是手法**。

---

## 7. 规划弱势者常见反模式

| 反模式 | 正确做法 |
|---|---|
| 在多个切片间反复比较 | 走 §3 决策树，命中即停，选第一个 |
| 边界不清便开始改动 | 补齐缺失信息；边界明确则直接执行 |
| 不分依赖地扩大范围 | 按依赖完成已授权范围，相关步骤合并验证 |
| 环境缺失仍硬做真实服务 | 改走 K1/K2/K6 只读或研究模式 |
| 遇未知字段填默认值 | 记 `unsupported` + 证据，停 |
| 为过测试放宽/删断言 | 如实记 `failed`/`partial`，修根因 |
| 每个微步骤都追加状态日志 | 只在 §6 五类触发器命中时更新治理源和投影；普通微步骤不追加 Evidence |
| 完成后新建 status 文档 | 按触发器走 gov seal 与治理更新，跑门禁 |
| 凭记忆续接上一轮 | L0 重新读真实工作树 + 交接书 |

---

## 8. 面板补货循环：从 Gate 生成下一批切片

L1 在 §13.1 面板选不到可认领的 `ready` 切片时，**不要停在"没事可做"**。面板不是终点，交接书 §18.3 Gate 状态机才是收敛目标；但不得复制其他 Agent 已认领的 `active` 切片。按下列算法补货：

~~~text
S1 打开交接书 §18.3 矩阵，从上到下检查：
   - gateState=`open` 且已有带有效 claim 的 `active` 切片 → 不复制，检查下一 Gate；
   - gateState=`open` 但没有 `ready` / `active` 切片 → 治理断链，优先补货；
   - gateState=`open` 且后继要求写明的下一切片尚不存在 → 补货；
   - gateState=`blocked` → 先枚举不依赖当前 blocker 的 protocol/validator/registry/
     instrumentation/失败关闭/harness；存在任一合法内部工作就补货并改回 open，
     否则只按 §18.4 复查触发器检查是否解锁；
   - gateState=`passed` → 先由 handoff 门禁校验 sealed Evidence 的显式主题域 freshness；无关代码、日志、未跟踪文件或其他交接章节变化不影响 Gate；主题域漂移但冻结语义未变时由工程方重跑验证并重封存，只有实际范围变化才请求新的用户裁定。
   全部 Gate 都 `passed`，或剩余 Gate 均有 active/blocked 且没有可解锁输入 → 去 §9。

S2 枚举该 Gate 的全部合法最小下一步，判断是否全部被外部阻塞
   （private-corpus / credential / hardware / user-ruling / toolchain / license / upstream / prerequisite-authority）：
   全部阻塞 → 不造假切片；在 §18.4 定义或复用 blocker，把 Gate 记为 `blocked`，去 §9 汇总。
   仍有任一不依赖外部输入的下一步 → 选择最小者，S3。

   “需要用户处理”只能来自当前 blocked Gate/切片的活动 blockerRefs；没有活动引用时，
   license/upstream 调查、工具链安装、测试环境编排和 Evidence 维护均为工程工作。

S3 用 §4 模板把该 Gate 的后继要求拆成一个最小可验收切片：
   - 单一主 capability；
   - 明确非目标；
   - required validation 落到 §13.3 约定（script/fixture/assertion/exit）；
   - authority 上限不超过输入证据允许的等级。

S4 护栏自检（全过才可自主追加，否则退回 S2 记 `blocked`）：
   [ ] 硬前置在当前环境可满足；
   [ ] 能套上 §4 某个模板；
   [ ] authority 上限已设，且不越级；
   [ ] 不依赖 §18.4 仍未解锁的 blocker。

S5 按当前 schema 在 docs/governance/slices.json 登记新切片，分配 W-<GATE>-NN 形式的 ID；
   lifecycle 初始为 `ready`，authority 按现有证据填写，无阻塞时 blockerRefs 为 []。
   在 docs/governance/gates.json 更新对应 Gate 的切片引用，并保持 gateState=`open`；
   用 npm run handoff:project 生成面板与 Gate 投影，不手写交接书表格。

S6 跑 `npm run test:handoff-integrity`：Gate 状态机必须仍通过，
   新切片 ID 必须被面板与矩阵一致引用，`completed` / `superseded` 不得覆盖 open Gate。
   然后回 §2 的 L1 原子认领它。
~~~

补货只新增"下一步能推进的切片"，不改写 Gate 通过条件，也不提升任何 authority。`passed` 或 `scope-excluded` 必须由 sealed Evidence 支持，补货动作本身不能产生 Gate 终态。

---

## 9. 终局分支：候选耗尽或全阻塞时怎么办

§3 决策树没有可认领的 `ready` 切片、且 §8 也无法合规补出新切片时，这是一个**合法等待态或完成态**，不是继续空转的理由。产出结构化交接，交回用户：

~~~text
T1 分开聚合未完成 Gate：
   - gateState=`blocked` → 引用 §18.4 已定义 blocker；reason 只允许 private-corpus /
     credential / hardware / user-ruling / toolchain / license / upstream / prerequisite-authority；
   - gateState=`open` 且只有 active → 引用 §13.1.1 claimId/owner/heartbeatAt，标明“由其他 Agent 推进”，
     不伪造 blocker；先按 recoveryTrigger 排除 orphan claim。
T2 只有活动 blockerRefs 明确引用 `reason=user-ruling` 时才报告用户裁定；Evidence freshness 维护、来源调查和已删除的量化阈值都不能冒充 user-ruling。
T3 若 blocker 发生变化，按 §6 触发器更新治理源、封存 Evidence 并生成投影；不新建平行文档：
   - 已推进到的边界；
   - 每个 Gate 的 blockerId、所需输入、责任方、解锁验证和复查触发器；
   - 建议用户或环境维护者提供的最小输入。
T4 若目标范围的全部 Gate 均合法通过，按明确的发布登记与 freshness 有效的 sealed Evidence 声明该范围完成；
   若全部未完成 Gate 均 blocked，声明“当前可推进面已耗尽，等待结构化 blocker 输入”；
   若仍有 open+active，声明“无可认领切片，已有其他 Agent 正在推进”，并停止，不能写成等待 blocker。
~~~

停止时仅在命中 §6 触发器时写回；无 blocker 或 authority 变化就不重复追加同一等待记录。下一轮命中 §18.4 的复查触发器后，从 §2 的 L0 重新进入并实际运行解锁验证。

**耗尽 ≠ 完成**：只有明确目标范围的 Gate 均合法通过（包括经 sealed 范围证据批准的功能排除），才可声明该范围完成；不得从交接书文件名推断当前发布版本。"可推进面耗尽"只说明此刻缺结构化外部输入或已有其他 active 工作。

---


<a id="agent-tool-validation"></a>

## 10. CLI 与真实 Agent 验证

本节是工具调用和模拟运行的操作入口，不记录某次任务进度，不代替治理 requiredValidation。命令均从仓库根执行；不要把 `--help`、工具注册成功或 EXE 构建成功当作真实任务通过。只有用户任务或当前切片要求真实 Agent 链路时，才启动模型请求（可能计费）和隔离写入。

### 10.1 先选正确入口

| 需要回答的问题 | 入口 | 不代表什么 |
|---|---|---|
| 某个生产工具的搜索、关联、读取或分页是否正常？ | `node tools/soulforge-cli/sfcli.mjs` | 不代表模型会正确调用它，也不是桌面 UI 验收 |
| 模型能否经生产宿主完成原始修改任务？ | `npm run agent:simulate`，默认 `unpacked` | 不代表已安装应用通过 |
| 已安装的 SoulForge 是否能跑通同一链路？ | 模拟脚本的 `--runtime installed --exe ...` | 不是仓库根启动器测试，也不等于签名、更新、安装生命周期验收 |

CLI 是 Node 脚本，不是独立测试 EXE。`unpacked` 使用仓库或显式生产产物快照中的 `production-main.mjs` 驱动 Electron；`installed` 使用指定的**实际安装版应用 EXE**。仓库根 `SoulForge.exe` 是开发启动器，`SoulForge.Doctor.exe` / `SoulForge.Launcher.exe` 是诊断、环境入口，均不能冒充 installed smoke 的应用 EXE。

开始前检查 `git status --short`、`git rev-parse HEAD`，确认运行目录、代码、依赖和编译产物一致；不要覆盖其他任务的未提交改动。工具链与依赖安装见 [README](../README.md)。CLI 加载 `packages/core/dist` 等编译产物：相关源码改变后构建受影响包，跨包改变运行 `npm run build`；需要刷新可执行产物时按项目规则运行 `npm run exe:build`。输入未变时复用有效构建，不为每次读取重复构建。

只查看帮助，不启动工作区、Electron 或模型任务：

```powershell
node tools/soulforge-cli/sfcli.mjs --help
node scripts/run-real-agent-gyoubu.mjs --help
```

`npm run agent:simulate -- --help` 仍会先触发 npm 的 `preagent:simulate` 构建检查。仅核对参数时使用上面的直接 Node 命令。当前参数以脚本帮助及实现为准，不把本文示例 ID、工具数量、时限写成全语料保证。

<a id="cli-validation"></a>

### 10.2 CLI：搜索 → 关联 → 原文 → 跨进程续页

以下示例使用 PowerShell 7.3+；`--stdin` 避免 JSON 的引号和中文被原生命令行转义破坏。先输入本机路径，不把私有 Mod 路径写进公共示例：

```powershell
Set-Location (git rev-parse --show-toplevel)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSNativeCommandArgumentPassing = 'Standard'
$Workspace = Read-Host 'Mod 工作区目录'
$GameRoot = Read-Host '游戏根目录（包含所需解包内容和原生依赖）'
if (!(Test-Path -LiteralPath $Workspace -PathType Container)) { throw '工作区不存在' }
if (!(Test-Path -LiteralPath $GameRoot -PathType Container)) { throw '游戏根目录不存在' }
$Cli = Join-Path (Get-Location) 'tools/soulforge-cli/sfcli.mjs'
$CliArgs = @('--workspace', $Workspace, '--base', $GameRoot, '--mode', 'plan', '--json', '--quiet')
node $Cli @CliArgs list
node $Cli @CliArgs describe search_param_rows
node $Cli @CliArgs describe find_references
```

- `--workspace` 必填；原生读取应提供正确的 `--base`。默认 CLI mode 是 `normal`，本节明确用 `plan` 进行只读/分析验证。
- `list` / `describe` 默认只做元数据入口准备；显式 `--analyze` 可请求分析。**`call` 及搜索、读取快捷命令默认会自动请求分析**，不应再理解为“只有加 `--analyze` 才分析”；对 `list_operations`、`rollback_operation` 等不依赖语义索引的维护调用，可显式加 `--no-analyze`，避免恢复操作被无关全量分析拖慢。请求分析不等于全量索引已完成；应检查工具结果中的覆盖与诊断。
- `--quiet` 隐藏进度，不隐藏缓存、审计降级等重要 stderr 警告；不要用 `2>$null` 丢掉它们。stdout 是工具 JSON，stderr 应单独保留。
- `search-param` / `read-param` 是快捷入口；复杂参数、游标和机器调用优先用 `call --stdin`。`read_param_fields` 的 `pageSize` 在 native 读取结果层生效，不是把完整结果返回后再截断；返回的 `fieldDefinitions`、`pagination`、`execution`、`scan`、`page`、`evidence` 必须一起保留。续页时只传原请求条件和 opaque `cursor`；cursor 绑定工作区、来源版本、表、物理行集合和字段集合。

CLI 回滚是显式宿主授权，不是模型参数：`fullPermission` 只允许工具进入回滚门禁，不能替代用户确认。启动 CLI 时必须额外提供绑定当前 workspace 和单个操作 ID 的一次性凭据：

```powershell
node $Cli --workspace $Workspace --base $GameRoot --mode fullPermission `
  --confirm-rollback $OperationId --json --quiet call rollback_operation `
  ('{"opId":"' + $OperationId + '"}')
```

`--confirm-rollback` 只在启动参数中接受，不能放进工具 JSON 伪造；缺少它返回 `EDIT_CONFIRMATION_REQUIRED`，操作 ID 或 workspace 不匹配返回 CLI 授权错误，成功消费后重放返回 `CLI_ROLLBACK_CONFIRMATION_REPLAYED`。长驻 `session` 或独立 session host 必须在启动宿主时提供同一参数；不要通过后续控制帧或模型消息补发确认。每个凭据只能消费一次，失败关闭也不得自动重试回滚。

事件搜索的全局索引候选不等于全部原生事件；检查 `coverage`，不要把 `indexed-event-candidates` 的命中或零命中当成完整结论。定位资源后可调用 `search_events {file, query, limit}`，在指定 EMEVD 源内按指令名或数字检索，续页保留相同 file/query 和 opaque cursor；此时完整性仅针对所选文件。传输层不能丢弃页内记录后继续使用原下一页游标；预算不足时应按错误中的动作缩小当前窗口重试。

`search_param_rows` / `search_text_entries` 也允许使用**当前页的原 cursor** 并减小 `limit` 重试；查询、表范围、工作区和快照版本仍须匹配。不要使用错误中的下一页 cursor 跳过未交付结果。旧游标先按原快照校验，续页转为与窗口大小无关的新快照游标。

PARAM 搜索候选中的 `fieldPreview` 只是有界预览，`fieldsComplete=false`，不是整行原生值。`readAction.scope=preview-fields` 只读取列出的真实字段；需要其他字段时，用同一 table/rowIds/containerPath 调用 `search_param_fields` 定位字段，再用 `read_param_fields` 读取。不要把预览字段缺失当作该参数没有相应能力。

`read_param_fields` 的游标使用固定长度请求范围摘要，不复制文件路径和全部 fieldIds；摘要仍绑定工作区、来源、请求及物理字段顺序。续页必须回传原始 table/rowIds/fieldIds/containerPath，可减小 pageSize；`fieldDefinitions` 只包含本页实际字段，后页定义随对应字段交付。旧的长范围游标在原请求与源哈希校验后转换为短游标；不要修改旧请求的字段或行顺序。

各工具的逻辑页大小与源码窗口限制仍独立存在。

EMEVD 写入回执保留 `opId`、输出哈希及原生读回结果。空计划为 `state=completed`、`transactionStatus=noop`，不是提交；事务已落盘但后续读回失败为 `state=verification_failed`、`transactionStatus=committed`，必须检查原生资源及操作记录，不能按普通未写入失败盲目重试。无变化的计划不应触发知识刷新或使读取凭据失效。

独立 `.hks` / `.lua` 源码可用 `read_hks_script {file, sourceLimit}` 分页读取；`search_hks_script {file, query, limit}` 提供区分大小写的精确文本定位和原文读取动作。字节码仅通过 Bridge 读取，游标绑定源版本；这些都是只读源码证据，不产生写入授权，也不证明游戏运行行为。二进制未知布局、容器、路径越界和超时均失败关闭。

定义一个每次都启动新 CLI 进程的只读调用函数：

```powershell
function Invoke-SoulForgeTool {
    param([string]$Tool, [object]$InputObject)
    $json = ConvertTo-Json -InputObject $InputObject -Depth 32 -Compress
    $raw = $json | node $Cli @CliArgs call --stdin $Tool
    if ($LASTEXITCODE -ne 0) { throw "工具失败：$Tool；检查 stdout 和 stderr：$raw" }
    $response = ($raw -join "`n") | ConvertFrom-Json
    if (!$response.ok) { throw ($response.error | ConvertTo-Json -Compress) }
    return $response
}

当同一工作区需要连续调用多个工具时，优先使用长驻 `session`，不要为每个工具重复打开 Node/Bridge/索引：

```powershell
$SessionArgs = @('--workspace', $Workspace, '--base', $GameRoot, '--mode', 'plan',
    '--json', '--quiet', '--diagnostics', 'session')
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = 'node'
$SessionArgs | ForEach-Object { [void]$psi.ArgumentList.Add($_) }
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$p = [Diagnostics.Process]::Start($psi)

$p.StandardInput.WriteLine((@{
    id = 'search-1'; tool = 'search_param_rows';
    args = @{ query = '鬼型部'; paramNames = @('NpcParam'); limit = 4 }
} | ConvertTo-Json -Compress))
$p.StandardInput.WriteLine((@{
    id = 'status-1'; tool = '__host_status'; args = @{}
} | ConvertTo-Json -Compress))
$p.StandardInput.WriteLine((@{
    id = 'close-1'; tool = '__host_close'; args = @{}
} | ConvertTo-Json -Compress))
$p.StandardInput.Close()
$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw "session failed: $stderr" }
($stdout -split "`r?`n" | Where-Object { $_ }) | ForEach-Object { $_ | ConvertFrom-Json }
($stderr -split "`r?`n" | Where-Object { $_ }) | ForEach-Object { $_ | ConvertFrom-Json }
```

`session` 每行读取一个 `{id,tool,args}` JSON 请求，并在 stdout 返回同一个 `id` 的 JSON 响应；工具执行在同一 `CoreToolSession` 内串行、去重，但状态/取消控制帧不会排在长 native 调用之后。`__host_status`、`__host_request_status`、`__host_cancel` 和 `__host_close` 仅是本地会话控制帧，不进入 ToolRegistry。取消状态必须按 `queued → running → cancel_requested → cancelled` 观察；发送取消请求不等于 native 工作已经停止，迟到结果会被丢弃。`--diagnostics` 将工作区打开、scan、缓存、分析、native read、关联内容扫描、关系页和工具耗时以 JSON Lines 写到 stderr；即使使用 `--quiet`，显式诊断也会保留。工具被取消时，tool 阶段诊断的公开 `code` 固定为 `CLI_REQUEST_CANCELLED`；若底层工具已经返回另一个失败码，该码仅保留在 `underlyingCode`，避免把工具内部失败误报成会话生命周期状态。stdout 与 stderr 必须分开保存，不能把诊断行当成工具结果。

对长调用可并发写入一条控制帧（`requestId` 是正在执行的请求 ID），再按返回的 `state` 决定是否继续等待：

```powershell
$p.StandardInput.WriteLine((@{ id = 'cancel-1'; tool = '__host_cancel'; args = @{ requestId = 'slow-1' } } | ConvertTo-Json -Compress))
$p.StandardInput.WriteLine((@{ id = 'status-1'; tool = '__host_request_status'; args = @{ requestId = 'slow-1' } } | ConvertTo-Json -Compress))
```

$search = Invoke-SoulForgeTool 'search_param_rows' @{
    query = '葫芦种子'; paramNames = @('EquipParamGoods'); limit = 4
}
$search.data.record.matches | ForEach-Object { $_.item } |
    Select-Object uri, sourceUri, entryIndex, paramName, rowId, rowName
$TargetUri = Read-Host '从结果中选择准确的 uri（保留完整 scheme，不根据同名自行拼接）'
$refs = Invoke-SoulForgeTool 'find_references' @{
    uri = $TargetUri; direction = 'both'; detail = 'context'; depth = 2; limit = 2
}
$refs.data.record.relations | Select-Object content, location, reason, certainty, readAction
```

查询词只是本机只狼语料示例；未命中时换成当前工作区的真实对象，不硬编码期待的行号。同名文本与参数不能自动视为直接引用。默认不包含低置信候选；确需查看同名、数字巧合等候选时加 `includeHypotheses = $true`，保留候选标记，不把它们当作确定调用。

从返回关系读取具体内容，再使用原关系游标续页：

```powershell
$relation = $refs.data.record.relations | Where-Object { $_.readAction } | Select-Object -First 1
if (!$relation) { throw '当前页没有可展开关系；检查 resolution、coverage、diagnostics 和 scan' }
$action = $relation.readAction
$ReadTools = @('read_param_fields', 'read_fmg_entries', 'read_emevd_event', 'read_luabnd_script', 'analyze_luabnd_script', 'analyze_tae_structure')
if ($action.tool -notin $ReadTools) { throw '先 describe 并确认这个读取入口，不盲目执行未知动作' }
$read = Invoke-SoulForgeTool $action.tool $action.args
$read.data.record

# 函数内重新启动 node；因此这里确实检验跨进程，而不是同进程缓存。
if ($refs.data.record.page.nextCursor) {
    $next = Invoke-SoulForgeTool 'find_references' @{ cursor = $refs.data.record.page.nextCursor }
    $next.data.record.relations
}

# 原文过长时，沿原文工具返回的 nextAction 读取下一窗口。
if ($read.data.record.nextCursor) {
    $sourceNext = $read.data.record.nextActions | Where-Object { $_.tool -eq $action.tool } | Select-Object -First 1
    if ($sourceNext) { $readNext = Invoke-SoulForgeTool $sourceNext.tool $sourceNext.args }
}
```

这只是演示下一页，不代表读完全文。需要全文时按该原文工具的续读动作读至结束，检查 offset/returned/total（若返回）、段落连续性和 complete 标志。事件按工具返回的指令窗口续读；不能用外层 `ok=true` 代替完整度检查。

三种续读游标：

字段定义和 Lua 结构也有独立分页边界：`search_param_fields` 保留原 `table/rowIds/query/containerPath`，沿返回的 `nextActions` 续读；`analyze_luabnd_script` 用 `section=functions|goals|branches|constants|calls|unsupportedApis|diagnostics` 选择分区，再沿该分区的 `nextActions` 续读。`sectionCounts` 是各分区数量，一页或单个分区读完不等于整个结构读完，更不代表运行时验证。游标绑定工作区、对象、查询和来源版本，不能跨分区使用。`search_resources` 默认排除备份/恢复产物；明确需要这些来源时用 `sourceFilter=all|artifacts`，不要拿 `.bak` 替代正式来源。

结果 envelope 中 `pagination.truncated` 表示逻辑结果有后页，`pagination.deliveryTruncated` 表示字节预算导致摘要省略细节，后者不承诺存在分页游标；按 `nextActions/nextReadPlan` 恢复细节。`resolve_entity` 摘要保留候选身份，但不能把摘要中的候选升级为修改授权。字段/结构页若单项超预算会明确失败，不返回缺项的“完整”结果。

1. 关联结果 `record.page.nextCursor` → `find_references` 的 `cursor`：当前锁定结果集下一页。
2. `record.scan.sourceCursor` / `scan.nextAction` → 带原查询条件的来源扫描：补齐尚未扫描的来源，再刷新关系。**先读完当前结果页再续扫**，新增来源可能使旧结果快照失效。
3. 原文工具自己的游标 → 同一原文工具：脚本/FMG 正文窗口等，不能传给 `find_references`。

游标保持原样，不绕过 source hash/revision 校验。失效时先确认工作区、查询条件、来源、缓存目录或工具版本是否变化，再重新搜索。`REFERENCE_PAGE_ITEM_TOO_LARGE` 应按诊断缩小窗口/降低 detail 并走原文读取入口；不要把失败页当成功。

`resolution=resolved` 只说明目标已定位；零条关系且 coverage 不完整，不能宣称“没有关联”。`completeness=partial`、`scan.remaining=true`、truncationReason 必须保留。当前关联遍历有节点、来源与边数限制（默认边上限 512）；翻完已生成的结果页仍不等于全图扫描完毕。

<a id="agent-unpacked-validation"></a>

### 10.3 真实 Agent：观察与隔离写入

先确认用户任务或切片需要真实模型链路，并准备游戏语料及已有模型配置。模拟入口会把选定真实 Mod 资源目录复制到临时 overlay；模型凭据放入本次隔离 user-data，不向原始 `mods` 写入。复制的是选定资源目录，不是整游戏/全语料；结果应检查 corpusManifest 的范围与 missingKinds。

```powershell
# 沿用上一节确认过的路径；环境变量作用于当前进程及子进程。
$env:SOULFORGE_SEKIRO_ROOT = $GameRoot
$env:SOULFORGE_SEKIRO_MOD_ROOT = $Workspace
$TestConfig = Read-Host '已有加密 test 配置文件的路径（不要输入密钥内容）'
if (!(Test-Path -LiteralPath $TestConfig -PathType Leaf)) { throw '配置文件不存在' }
$Task = Read-Host '用户原始任务指令'
npm run agent:simulate -- "$Task" --observe --provider test --test-config "$TestConfig" --label observe-task
```

关键区别：

- **当前 runner 在不传 `--observe` 时默认进入写模式**。`--write` 表达显式写入意图，但省略它并不等于只读。不要无参数启动 runner 试探可用性。
- `--observe` 不作任务验收通过声明；与 `--write` / `--apply-overlay` 互斥。观察仍会调用真实模型、产生运行数据，并不等于零副作用的 help。
- 自定义任务如果不是观察模式，必须提供适用的机器目标 `--goals`；不能借用默认任务的 goals 来证明另一个任务。
- 必须显式选择 `--provider test` 或 `--provider vault`（命令行优先于对应环境变量）。`test` 使用受限查找范围中的加密 `test` 文件，推荐显式 `--test-config`；`vault` 要求 `--config-id` 指向**本次隔离 vault** 中已有凭据的服务，不能假定用户日常配置会自动继承。缺配置时应停止，不读取或复制无关凭据。
- 不把配置明文、API key、真实资产或私有报告内容提交到仓库。只有配置路径和配置选择方式进入说明文档。

已有写入验证授权时，下面展示一个**只验证指定字段**的目标格式。表、行和字段必须先在当前语料中查明；示例值不适用于任意 Mod：

```powershell
$FieldTask = '将鬼刑部的忍杀次数改为2'
$Goals = '[{"goalId":"health-bars","kind":"param-field","table":"NpcParam","rowId":50800000,"fieldId":"ninsatuNum","expectedValue":2,"required":true}]'
# 直接 node 传 JSON，避免 npm/cmd 再转义；先做与 npm preagent 相同的构建检查。
node scripts/ensure-agent-production-build.mjs
if ($LASTEXITCODE -ne 0) { throw '生产产物未就绪，停止模拟' }
node scripts/run-real-agent-gyoubu.mjs "$FieldTask" --goals $Goals --write --provider test --test-config "$TestConfig" --label param-field-check
```

PARAM-only goals 即使字段值正确，也不等于自然语言任务整体已验收。完整任务应定义对应的语义终态目标；已有匹配测试清单时，可在确认任务与语料一致后使用 `--testset four-1` 到 `four-4`，不为获得绿色结果改换题目：

```powershell
npm run agent:simulate -- --testset four-1 --write --provider test --test-config "$TestConfig" --label four-1
```

步数、模型请求超时、工作区/预热/会话超时、输出预算可通过当前帮助中的参数设置。不要复制历史默认值当通用门槛；到限应如实报告停止原因，不自动扩大预算或重试付费模型。

<a id="agent-installed-validation"></a>

### 10.4 已安装 EXE 的 Agent 链路

使用已安装应用的实际路径，不使用仓库根 launcher。以下以观察模式检查安装版链路；只有另有任务及写入授权时，才改为合适的 `--write` 和目标验收参数：

```powershell
$InstalledExe = Read-Host '已安装的 SoulForge.exe 完整路径（不是仓库根启动器）'
if (!(Test-Path -LiteralPath $InstalledExe -PathType Leaf)) { throw '安装版 EXE 不存在' }
node scripts/run-real-agent-gyoubu.mjs "$Task" --runtime installed --exe "$InstalledExe" --observe --provider test --test-config "$TestConfig" --label installed-observe
```

这里直接调用脚本，避免 npm 的 preagent 为 installed 测试额外构建本地 unpacked 产物；仍需仓库的脚本依赖。`unpacked` 会检查生产产物 freshness，`installed` 核验指定 EXE 并启动该应用。缺少安装版 EXE 时应报告 `not-attempted`，不回退到 unpacked 冒充通过。运行后检查 report 的 runtime/productionReceipt、实际启动产物身份及停止诊断，不能仅凭存在一个 `.exe` 文件认定安装版有效。

本流程的业务写入对象仍是临时 overlay。运行结束依照报告检查回滚、精确恢复和清理；失败保留的临时目录用于排障，不强杀用户会话，不手动删除未确认已恢复的资源。

<a id="agent-validation-results"></a>

### 10.5 结果、报告与验收边界

模拟报告位于仓库 `output/agent-real/`，包括主 JSON、durable `.rollout.jsonl`，并可能带 `.evidence.md` 等附属材料。普通桌面会话日志在 Electron/SoulForge user-data 的 `agent/sessions/`，不能拿另一次运行的日志拼接成本次结果。CLI 则需由调用方保存参数、stdout JSON、stderr、退出码与耗时；执行面板里的工具卡片不替代原始结果。

验收至少区分：

| 结果 | 正确解读 |
|---|---|
| CLI `ok=true` | 本次工具返回成功；另查 completeness、coverage、候选标记及实际内容 |
| `--observe` | 观察记录，不是修改任务通过；可能返回 `ok=false` / 非零退出码，结合 verificationMode、诊断和报告判断，不能直接归为运行故障 |
| `goalsOk` / 字段匹配 | 指定断言命中；还要检查 goalCoverage、taskCoverageOk、taskCompletionVerified |
| 完整任务通过 | 按当前 report.ok、verdict、rollback、cleanup、durable terminal、超时/页面错误等综合判定；无写入时的 not_applicable 也必须有对应依据 |
| installed 缺失 | not-attempted，不是安装版通过 |
| 构建/fixture/partial | 只声明对应范围，不提升为原生全语料、Gate 或发布完成 |

完整写入链路应包含实际提交操作、原生重读、语义目标验证、回滚及 overlay 精确恢复；仅模型口头说“完成”、某个字段值正确或进程退出码为 0 都不够。缺少旧格式 markdown task record 与缺少 durable rollout/terminal 不是同一问题，依据结构化报告诊断，不自行补造记录。

<a id="cli-cache-troubleshooting"></a>

### 10.6 常见问题与最小验证范围

- **旧编译产物**：CLI 使用 dist，unpacked 模拟使用生产产物；先核对实际运行路径和源码/产物身份，再构建受影响部分。修改某工作树后不要无意调用另一个工作树的 CLI。
- **只会 list/help 不会实际查询**：这只能验证入口/注册表，必须针对任务做真实内容读取或分页检查；不需要因此启动真实模型。
- **`warming_up` / `not_indexed` / partial / source stale**：检查 `--base`、索引覆盖、来源哈希、Bridge 诊断和续扫动作；空结果不是“无关联”。
- **缓存数据库版本高于当前应用**：拒绝降级是安全行为。不要删用户数据库，也不要忽略 `CLI_SEMANTIC_CACHE_UNAVAILABLE` / `CLI_SQLITE_FALLBACK`。无可用持久缓存时，跨进程快照可能无法恢复，不能宣称续页通过。
- **主仓库与工作树版本不同**：需要独立验证时，可为 CLI 子进程使用独立的本地缓存根；不要迁移或降级用户的现有缓存。同一分页链必须保持同一缓存目录、工作区与工具版本。

CLI 缓存默认位于 `%LOCALAPPDATA%/SoulForge/cli-workspaces/` 下的受管目录。以下隔离只作用于当前 PowerShell 及其子进程，最后恢复环境变量；它不修改 Mod 路径，也不是桌面安装版 user-data 的替代方案：

```powershell
$PreviousLocalAppData = $env:LOCALAPPDATA
$IsolatedLocalAppData = Join-Path ([System.IO.Path]::GetTempPath()) ('soulforge-cli-check-' + [guid]::NewGuid().ToString('N'))
try {
    $env:LOCALAPPDATA = $IsolatedLocalAppData
    Write-Output "CLI 隔离缓存根：$IsolatedLocalAppData"
    # 本段仅演示首个查询，不是分页验收；要验证续页，把 §10.2 的完整调用链放在此 try 内。
    # 验证时另行保存各次 stdout、stderr、退出码和缓存根，不在页面之间切换目录。
    Invoke-SoulForgeTool 'search_param_rows' @{ query = '葫芦种子'; paramNames = @('EquipParamGoods'); limit = 2 }
} finally {
    if ($null -eq $PreviousLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue }
    else { $env:LOCALAPPDATA = $PreviousLocalAppData }
}
```

文档修改本身只检查链接、命令/参数、示例 JSON 和行为边界；直接运行两个 `--help` 或纯目标解析检查即可，不默认构建 EXE、打开模型会话或改写 Mod。涉及产品代码时，再按相关切片 requiredValidation 选择专项测试、真实 CLI 读取、完整 Agent 或 installed 验证。测试结论写清本次实际执行、未执行和覆盖范围，不把本手册变成并行状态台账。

---

本手册只提供方法，不产生新范围、状态或 authority。状态、范围与证据以治理 JSON 为准；交接书相关区块仅为投影。

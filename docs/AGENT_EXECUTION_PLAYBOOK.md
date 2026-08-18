# SoulForge 执行手册

> - 文档性质：**方法手册**，只讲"每次开工怎么做"，不记录任何进度、状态或范围。
> - 状态、切片、Evidence 的权威是 `docs/governance/*.json`；`docs/V0_5_IMPLEMENTATION_HANDOFF.md`（下称"交接书"）的对应章节是它们的投影，冲突时以 JSON 为准。读这些状态一律走 `node scripts/gov.mjs next` / `status`，不要手工读投影表格。
> - 交接书仍是唯一完整实施规范与技术地图；需要背景、区域地图或格式细节时查它。
> - 适用对象：**写代码稳定、但规划与自我编排较弱**的 Agent。
> - 与交接书的关系：交接书是"地图 + 参考手册"，本文是"照着走的操作规程"。二者冲突时以交接书为准。
> - 本文不新建 milestone / task / status / next-actions 口径；它把交接书 §0.3 的决策协议和 §13.2 的切片模板，翻译成可机械执行的流程。

---

## 0. 为什么需要这份手册

交接书刻意是一张依赖驱动的技术地图，不是线性工单。规划强的 Agent 能自己排路径；规划弱的 Agent 会卡在三处：

| 卡点 | 表现 | 本文对策 |
|---|---|---|
| 选择瘫痪 | 面对多个切片来回权衡，不动手 | §3 选点决策树，输出**唯一**一个切片 |
| 颗粒度错位 | 切片太抽象，不知从哪行代码开始 | §4 拆解模板，套成有序微步骤 |
| 缺量化与沉淀 | 做完不知算不算完，也不知给下家留什么 | §5 二值完成判定 + §6 沉淀通道 |

用法：**每一轮开工，从 §1 顺序走到 §6，走完回到 §1。** 一轮只推进一个微步骤。不要跳步，不要一次吃下整条路线。

---

## 1. 压舱石：动手前必过清单（不推进进度，只防翻船）

写任何代码前，对照下表逐条自检。任一条不满足，停下，按交接书对应节处理，不要绕过。

- [ ] 我没有在 Patch Engine 之外用 `fs.writeFile` 改 Mod 资源；writer/converter 只写 main 控制的暂存根。
- [ ] renderer 不碰文件系统、不拿真实绝对路径；`THREE.Object3D` / React state 不作权威场景文档。
- [ ] 原版游戏目录只读；数据库/缓存/日志/恢复元数据不写进 Mod 工作区。
- [ ] 未知字段无法无损保留 → 不开 writer；no-op roundtrip 不成立 → 停。
- [ ] 不让 fixture / candidate 冒充 native；不让 raw replace 冒充 native writer。
- [ ] `unsupported` / `failed` / `partial` / `blocked` 返回**结构化诊断**，不吞异常、不猜默认值。
- [ ] C# Bridge 是原生格式唯一 production authority；TypeScript 不另起第二套 production parser。
- [ ] 不提交真实资产、用户 Mod、Oodle DLL、API key、签名私钥、私有 corpus。
- [ ] AI 证据不足时返回 `insufficient_evidence`；完全权限也不绕过 Patch Engine / 验证 / 备份 / 审计 / 回滚。
- [ ] 受管文档中的脚本名、治理子命令和可打开入口都已从当前仓库核实，不写占位引用。

---

## 2. 引擎：每轮固定循环 L0 → L6

把它当成不需要创造力的传送带。每一格都有明确输入和产物。

| 阶段 | 动作 | 产物 |
|---|---|---|
| **L0 定位** | 跑 `git status` + `git rev-parse --short HEAD`；跑 `node scripts/verify.mjs --tier governance`；跑 `node scripts/gov.mjs next` | 知道真实工作树与可 claim 切片 |
| **L1 选点** | 按 §3 决策树选出恰好一个切片，用 `node scripts/gov.mjs claim --slice <id> --owner <你>` 原子认领 | 一个 lifecycle=`active` 的切片 ID |
| **L2 立据** | 按交接书 §13.2 准入模板，在证据草稿写：切片 / capability / 依赖检查 / 允许改的入口 / 非目标 / required validation / authority 上限 / 停止条件 | 一份开工契约 |
| **L3 拆解** | 按 §4 模板把切片拆成有序微步骤；只取**第一个未完成**微步骤作为本轮目标 | 一个微步骤 |
| **L4 实现** | 严格在"允许改的入口"内实现该微步骤；命中压舱石红线即回 §1 | 代码改动 |
| **L5 验证** | 跑该切片 required validation（交接书 §15.1 矩阵）；按 §5 二值判定是否真完成；未过则修，不放宽断言 | 通过/失败 + 样本范围 |
| **L6 沉淀** | 按 §6 判断是否命中写回触发器；命中才更新交接书 §17（及必要时 §13、§4~§12），否则只保留本轮验证结果；跑门禁确认无断链 | 必要的唯一事实源更新，或明确无写回 |

走完 L6 回到 L0。**一轮只前进一个微步骤**——这是把"规划"换成"稳定编码"的关键：你每次只需正确做一件小事。

---

## 3. 选点决策树：消除"选哪个"

严格按顺序回答，命中即停，输出唯一切片。不要在多个候选间反复权衡。

**Q1 与 Q2 已由 CLI 机械完成**：`node scripts/gov.mjs next` 的 `claimable` 列表已排除他人认领、已完成、被阻塞与其他版本的切片，`activeSlices` 列出在飞 claim 及其持有者。直接从 `claimable` 进入 Q3，不要手工比对交接书表格——那些表格是 `docs/governance/slices.json` 的投影，手工读只是多一次转录机会。

若 `claimable` 为空，`message` 会指出实际原因与对应出路（deferred 指向 `scope.json` 的 `resumeRequires`，active 指向 release/complete，blocked 指向 `blockers.json`）；按它走，必要时去 §8。

~~~text
Q1 gov next 的 activeSlices 里是否有一条由我持有？
   是 → gov heartbeat --slice <id>，只继续这个切片。停。
   否 → 核对其他 active claim 的任务/进程状态与工作树变化；仍可验证运行中的不复制，
        已结束或无法验证且无相关写进程的用 gov release --slice <id> --force 原子回退，然后 Q2。

Q2 取 gov next 的 claimable 列表（已按 lifecycle=ready 与当前版本过滤）。
   为空 → 按 message 指出的出路处理，或去 §8；非空 → Q3。

Q3 剩余切片里，是否有"能解锁多条下游路线的共同底座"(如 A-RECOVERY)？
   有 → 选它，去 Q6。
   无 → Q4

Q4 是否有"能关闭高风险未知的只读研究 / validator / diagnostics"(不需写权限)？
   有 → 选它，去 Q6。
   无 → Q5

Q5 仍有多个并列 → 取交接书 §3.1 依赖表中**行序最靠上**者，去 Q6。

Q6 选定后立即把该行 lifecycle 从 `ready` 改为 `active`，并在 §13.1.1 原子登记
   claimId/owner/claimedAt/heartbeatAt/recoveryTrigger；不改 authority、不追加 Evidence；
   跑 `npm run test:handoff-integrity` 后才能进入 L2。
~~~

选点铁律：**独立切片可并行；但共享 native writer / Patch Engine / migration / 协议变更的切片必须串行**（交接书 §0.3）。本轮只认领一个。

---

## 4. 拆解模板库：把切片套成微步骤

先给选中的切片归类（看它的"目标能力"和"authority 上限"），再套对应模板。**每个数字步骤就是一个 L3 微步骤，按序做，不重排。** 每步都应能独立编码、独立验证。

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

1. 确认合法输入样本来源；先穷尽公开来源调查、已有本机 registry、external-only adapter 与可独立验证的失败关闭路径。只有这些工程替代均不可行且 §18.4 已定义真实外部输入时，才把 lifecycle 改为 `blocked`；不能把来源研究本身交给用户。
2. 在 core 只读探测层写最小 parser：只提取可确认字段 + `diagnostics`。
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
4. 采集真实数据，但**不得自行把观测值定义为发布标准**；V0.5 只使用交接书已冻结的功能正确性标准，不恢复已删除的量化阈值。
5. L6 记脱敏结果为 provider loop `partial`；不提升生产写 Agent。

**套不上模板？** 回 §3 按交接书 §3 缩小范围，或把切片拆到能套上为止。宁可缩小，不要硬闯。

---

## 5. 量化：微步骤二值完成判定

对每个 L3 微步骤，逐条回答"是/否"。全"是"才算这一步完成；任一"否"留在本步，不前进。

- [ ] 生产调用链真正接通（不是孤立 helper / scaffold）。
- [ ] 失败 / unsupported / partial / blocked 都返回结构化诊断。
- [ ] required validation 实际运行，记录了退出码、样本范围、关键断言。
- [ ] 写能力（若涉及）跑通 staging → validator → commit → 重读 + 适用层级回滚。
- [ ] 未超 authority 上限；未验证项已明确列出。

没运行的命令、没读的文件、没验证的结论必须明说；`candidate`、`fixture-confirmed`、`partial`、`native-verified`、`blocked`、`unverified` 不得互相冒充。

**切片级完成** = 该切片**所有**微步骤都通过上表 + 交接书 §13.2 条件，并将 lifecycle 改为 `completed`；authority 只按真实证据独立更新。单个微步骤完成只是本地验证结果，不等于切片完成，更不等于路线或 Gate 完成。

---

## 6. 沉淀：唯一合规通道

进度只能沉淀进**交接书**，禁止新建平行清单，但普通微步骤不应让唯一事实源膨胀。L6 先判断本轮是否发生任一写回触发器：

- 切片完成；
- authority 变化；
- blocker 变化；
- required validation 契约变化；
- 跨 Agent 交接。

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
| 拿到切片直接开写 | 先 §4 套模板，只做第一个微步骤 |
| 一轮想推完整条路线 | 一轮一个可独立验收微步骤 |
| 环境缺失仍硬做真实服务 | 改走 K1/K2/K6 只读或研究模式 |
| 遇未知字段填默认值 | 记 `unsupported` + 证据，停 |
| 为过测试放宽/删断言 | 如实记 `failed`/`partial`，修根因 |
| 每个微步骤都追加状态日志 | 只在 §6 五类触发器命中时写交接书；普通微步骤不追加 Evidence |
| 完成后新建 status 文档 | 按触发器写交接书 §17，跑门禁 |
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

S5 把新切片按 §13.1 十列格式**自主追加**到面板，分配 `W-<GATE>-NN` 形式的 ID；
   lifecycle 初始为 `ready`，authority 按现有证据填写，blockerRefs 为 `—`。
   在 §18.3 对应 Gate 行更新"当前切片"引用，并保持 gateState=`open`。

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
T3 若 blocker 发生变化，按 §6 触发器写入 §17，并同步 §18.4；不新建平行文档：
   - 已推进到的边界；
   - 每个 Gate 的 blockerId、所需输入、责任方、解锁验证和复查触发器；
   - 建议用户或环境维护者提供的最小输入。
T4 若全部 Gate 均 `passed`，按当前 freshness 有效的 sealed Evidence 宣布 V0.5 完成；
   若全部未完成 Gate 均 blocked，声明“当前可推进面已耗尽，等待结构化 blocker 输入”；
   若仍有 open+active，声明“无可认领切片，已有其他 Agent 正在推进”，并停止，不能写成等待 blocker。
~~~

停止时仅在命中 §6 触发器时写回；无 blocker 或 authority 变化就不重复追加同一等待记录。下一轮命中 §18.4 的复查触发器后，从 §2 的 L0 重新进入并实际运行解锁验证。

**耗尽 ≠ 完成**：只有交接书 §18.3 全部 Gate 都是合法 `passed`（包括经 sealed 范围证据批准的功能排除），才是 V0.5 完成；"可推进面耗尽"只说明此刻缺结构化外部输入或已有其他 active 工作。

---

本手册只提供方法，不产生新范围、状态或 authority。与交接书冲突时，以交接书为准。

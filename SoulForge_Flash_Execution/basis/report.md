# SoulForge 全域审查与演进研究报告

**基准版本：0.5.8 · 提交 `f9cb0cd76a11bfa2857b48acbc779bfac0355d96` · 审查日期：2026 年 9 月 6 日**

本报告覆盖编辑器、C# Bridge、写入事务、Agent、RAG、提示词、性能、冗余治理、Blender 类接口与 LLM Wiki 的设计。结论建立在当前提交的源码阅读、成熟实现对照和抽取逻辑反例上。它是**静态代码审查与工程研究报告，不是全部功能已通过实机验收的证明**。

## 0. 结论：先修语义正确性，再谈更快与更聪明

SoulForge 已经有值得保留的基础：原生文档、带版本身份的 mutation、Patch Engine、恢复点与持久日志、Agent 工具 envelope、地图事务、Blender delta、RAG 融合，以及一组覆盖不同模块的测试入口。继续推倒重写不会自动提高可靠性。[S02](#s02)[S05](#s05)[S09](#s09)[S13](#s13)[S16](#s16)[S30](#s30)

但“接口存在、writer 返回成功、同一个 reader 能读回来”仍不足以证明修改符合游戏语义。本次最重要的发现位于 MSB：**EntityID 写错字段；Region 的 scale 写入会覆盖数据块指针。**这两处问题比启动速度、Token 开销和提示词措辞更优先。它们也说明，给错误的原生解释增加更多“权威读取”“verified”“语义索引”标签，只会放大错误的可信度。[S03](#s03)[S04](#s04)[S05](#s05)[X01](#x01)[X02](#x02)

性能方面存在可定位的浪费：地图分块服务先解码全量网格，进行 C# 内部 Base64 往返，并在全局锁内完成这些工作；地图高层批量操作重复请求完整文档；TAE 批量修改按操作保存整文件副本；向量检索遍历全部向量并全排序。RAG 则存在向量路径漏掉 family 过滤、引用扩展超过 limit、Broker 保留旧顺序等问题。这些不是“模型不够聪明”，而是可由确定性程序消除的开销与失配。[S07](#s07)[S08](#s08)[S10](#s10)[S19](#s19)[S27](#s27)[S28](#s28)[S29](#s29)

与成熟编辑器相比，SoulForge 的主要差距不是少了几个页面，而是**能力边界、跨引用语义、差分验证、复杂操作闭包、真实产品路径验收**。一个模块读出了名称与坐标，不等于它具备该格式的完整结构化编辑能力；一个模型显示出来，不等于它可以被 Blender 修改后无损回包。[S03](#s03)[S09](#s09)[S19](#s19)[X03](#x03)[X04](#x04)[X05](#x05)

建议采用五条主线：修复原生语义；统一事务与验证；减少重复解析与搬运；将 Agent 从“自由猜测的工具调用者”变成“受目标、证据与后置条件约束的执行者”；在此基础上扩展 3D 与 Wiki。下文给出具体缺陷、算法、接口边界和验收条件。

## 1. 证据口径与覆盖范围

### 1.1 本次做了什么

通过连接的 GitHub 读取固定提交的源文件与目录信息；复核旧审计涉及的关键实现；将 MSB 布局与 SoulsFormats 的独立实现对照；查阅 Smithbox、DSAnimStudio、Soulstruct Blender、Blender 官方文档及 Karpathy 的原始 LLM Wiki 文档；执行 10 个从已读逻辑抽取的反例探针。源码清单位于文末及 `source_manifest.json`。

关键审查对象包括 MSB、PARAM、FMG、EMEVD、TAE writer，脚本编码回写，地图事务与 Blender delta，Bridge 协议，事务落盘过程，Agent loop、Broker、RAG、工具桥与提示词主体。长文件采用定位区间阅读，不能据此声称每个源文件的每一行均已审查。

### 1.2 本次没有证明什么

仓库没有成功克隆进执行容器；容器没有可用的 .NET SDK、Windows Electron 环境和用户的只狼数据。因此没有运行仓库构建、完整测试套件、真实二进制全语料往返、Electron 点击链路、GPU 性能测试、游戏内加载或真实模型 API 回放。前端完整事件流、ESD/FXR/TPF/MTD/GPARAM 等模块的深层 writer、安装更新和反馈云也没有达到逐实现审查深度。报告会为这些领域标出验收要求，而不是填一个虚假的“正常”。

没有全仓哈希去重或完整调用图，故不能给出“冗余文件共多少个、删除后减少多少 MB”的事实结论。文件清理建议是分级处置方案，不是未经验证的删除名单。

### 1.3 结论等级

| 标记 | 含义 | 可以据此做什么 |
|---|---|---|
| A：源码证实 | 当前代码的行为或范围可直接读出；格式错误有独立布局对照 | 修复对应实现，增加回归；仍需产品路径验收 |
| B：抽取反例 | 最小程序复现该算法或布局的反例 | 证明逻辑不变量不成立；不等于运行了原仓库 |
| C：结构性风险 | 源码显示危险组合，但调用约束或实际数据尚未完整核实 | 加门禁或测试确认，不宣称用户必然遇到 |
| D：待实机验收 | 需要 Windows、游戏语料、GPU、外部模型或完整宿主链路 | 保留为未验收，不把跳过当通过 |
| 设计建议 | 本报告提出的目标架构、接口、预算或指标 | 进入设计评审与施工；不是现有功能描述 |

优先级与证据等级不同。P0 表示可能写坏数据或把错误状态报告为成功；P1 表示主要功能、稳定性或高频性能问题；P2 表示可用性、维护成本和次要优化。一个 P0 风险也可能尚需 D 类实机证明。

### 1.4 旧报告不能复制为本版结论

本版 loop 已有默认 200 步上限和进展相关控制；自动 RAG 使用固定任务查询并缓存结果，不再等同于旧报告中的每轮搜索最后一条 user 文本。扫描已有 `includeContentHashes` 开关；蒙皮模块已有 NormalW、palette 和 FK 处理；持久提交已有恢复点落盘前登记。旧报告中的“无限步骤”“永远全盘 SHA”“NormalW 完全丢失”“没有事务日志”不能未经复核继续使用。[S11](#s11)[S16](#s16)[S23](#s23)[S24](#s24)[S33](#s33)

## 2. 功能能力矩阵：不要把读、改、提交、游戏有效混成一个勾

以下“已有”表示本次源码或声明中确认存在，不代表实机通过。成熟工具的能力来自其官方说明，不代表每种游戏、格式变体都覆盖一致。[X03](#x03)[X04](#x04)[X05](#x05)

| 模块 | 当前有证据的能力 | 主要差距或问题 | 当前审查判断 |
|---|---|---|---|
| 工作区与容器 | 目录扫描、资源分类、可选内容 hash、Bridge 路径边界、容器写入口 | 缓存生命周期、overlay/base 身份、启动热路径仍需 trace | 基础存在；不能报“秒开” |
| PARAM | 紧凑布局重建、物理行身份、重复 ID 防御、部分编码保留；32 位布局限制写入 | 物理行删除验证空缺，批量 final-state 验证与索引漂移风险 | 有真实编辑能力，尚非全变体闭包 |
| FMG/MSG | 裸 FMG 与 msgbnd/DCX 写回、编码检查、目标及 sibling 验证 | 多语言身份、null/空串、批次同目标和 UI 回滚仍需端到端测试 | 已读 writer 的保护相对完整 |
| EMEVD | 原生与 DCX outer 写回、事件/指令 mutation、重读验证 | AST/EMEDF/重定位/参数绑定/多操作组合需独立验证 | 不能把“大纲”视作程序语义 |
| Lua/脚本 | 编码感知回写、混合编码限制、字节码转明文路径 | 转明文不是字节码编译；游戏加载能力与语义不等价于编码成功 | 需区分 source 与 bytecode profile |
| MSB 地图 | 模型、实体、变换、部分属性与删除；事务、查询、Blender delta | EntityID 错位、Region scale 覆盖指针；删除引用重映射问题 | **写能力需要收紧并修复** |
| 地图 3D 预览 | 持久 session、分块、顶点/法线/UV/索引、资源绑定 | 实际仍全量预解码，Base64 往返、全局锁、按数量淘汰 | 传输分页不等于资源惰性加载 |
| FLVER/角色预览 | 新蒙皮兼容层、NormalW、全局/局部骨骼索引、FK | native→DTO→renderer→GPU 全链未实机验证 | 不能沿用旧版“没有 NormalW”结论 |
| TAE 动作事件 | 已读 writer 支持时间调整、模板事件插入 | 不等于任意参数编辑；事件组插入语义未闭合；整文件快照开销 | 功能明显窄于完整动作编辑器 |
| HKX 动画 | 仓库有相关模块和验收入口 | seek、采样、root motion、骨骼映射和各变体未完成实机验收 | D |
| ESD/FXR/GPARAM/MTD/TPF | 模块、协议或原生验收入口存在 | 本次未完整阅读其读写实现；不能判为无缺陷或功能完整 | D，单列验收预算 |
| 碰撞/导航 | 存在专项测试入口 | 可视化、生成、重建、游戏有效是不同能力 | 不得由 FLVER 成功外推 |
| Agent 工具 | 搜索、原生读取、编辑服务、台账、地图/Blender 工具入口 | completion、权限收据、跨格式目标绑定、并行调度仍需闭环 | 工具不是最终目标验证器 |
| RAG/记忆 | 词法、向量融合、引用扩展、证据 envelope | 过滤失配、预算失配、陈旧选择；宿主一致性需追查 | 可改进，不宜让其成为写入真相源 |
| 安装/更新/日志/反馈 | 根脚本与前端目录中有相关设施 | 发布包内容、secret 过滤、更新恢复未做完整审查 | D，不纳入“已通过” |

### 2.1 如何对照成熟工具

Smithbox 的官方说明覆盖地图、模型、参数、文本、图形参数、材质、纹理浏览与文件浏览。它是综合工作台的参照，而不是 SoulForge 能力达标的替代证明。DSAnimStudio 是动作时间轴与预览的参照。Soulstruct Blender 的官方矩阵对只狼标记 FLVER 可导入导出、动画部分支持，MSB、碰撞、导航不支持；因此“接上这个插件”不等于只狼全地图编辑完成。[X03](#x03)[X04](#x04)[X05](#x05)

建议采用操作级对照，而不是页面级对照。例如 PARAM 对照“修改一个枚举字段、复制含引用的行、导入差分、保存并用独立 reader 验证”；地图对照“选中、变换、删除并修复引用、撤销、保存、重开”；TAE 对照“参数模板、时间范围、事件组、复制插入、重读与播放”。本报告没有对两个编辑器进行同机性能实测。

## 3. 必须优先处理的 MSB 语义错误

### 3.1 F01 / P0：EntityID 实际写到了内部条目 ID

**证据等级：A+B。**`MsbNativeDocument.ApplyMutations()` 的 `set_property` / `set_entity_id` 将 Part 和 Region 的 EntityID 写入 `nativeOffset + 0x0C`。同一文件的布局注释把该位置描述为 `id`，并说明未解析内层 entityData/typeData。成熟独立实现将此位置读为内部 ID；Part 真正的 EntityID 位于 entityData 子块，Region 位于 baseDataOffset3 指向块的第二个 int32。[S03](#s03)[S04](#s04)[X01](#x01)[X02](#x02)

危险不只是“字段没改对”。自己的 reader 与 writer 使用相同错误解释，`MsbNativeWriter.VerifyMutations()` 仍可能认为新 EntityID 已写入。后续地图 canonical document、引用图、RAG、Agent 会继承这个假事实。这是**同源错误造成的验证盲区**。[S05](#s05)[S09](#s09)

本报告的抽取反例构造内部 ID 为 7、真正 EntityID 为 1000 的最小布局。按当前写法请求 EntityID=2000 后，头部变成 2000，独立布局读取仍为 1000。探针没有运行 C# 或真实 MSB，但足以证明所用偏移不满足目标语义。

**修复方向：**保留 internalEntryId 与 entityId 两个字段，禁止复用名称。读取 Part 的 entityData 指针并进行相对偏移、长度、对齐、溢出检查；读取 Region 的 baseDataOffset3 和其中 EntityID。mutation 使用字段描述符或类型化属性，不再把 `+0x0C` 当通用实体 ID。writer 验收必须用独立 reader 读取真实 EntityID，并证明 internalEntryId 不变。

**迁移要求：**此修复涉及索引失效。为 MSB 语义 schema 升版，重建地图 EntityID 索引、跨文件引用及其派生 RAG/Wiki 条目。历史日志不能被静默重解释：标记其读取器版本，要求重新读证据。只改 writer 会留下旧索引继续误导 Agent。

### 3.2 F02 / P0：Region 缩放覆盖数据块指针

**证据等级：A+B。**当前 `set_region_transform` 以 `RegionTransformOffset=0x14` 为基准，将 ScaleX、ScaleY、ScaleZ 写到 `t+28/t+32/t+36`，即条目 `+0x30/+0x34/+0x38`。独立 MSBS Region 布局在 `+0x30` 存放第一个 int64 数据块偏移，在 `+0x38` 存放第二个。这里没有通用的三轴 Scale。[S04](#s04)[X02](#x02)

这意味着 ScaleX/ScaleY 可以改掉同一个 64 位指针的两半，ScaleZ 改掉下一个指针的一半。最小反例中，一个指向 0x100 的指针被 scaleX=2.0 改成 0x40000000，越过 512 字节的示例文件范围。这是布局级确定反例，不是性能问题。

**修复方向：**立即关闭 Region 通用 scale 写入口，包括 Bridge、共享 schema、地图事务和 Blender delta 的相应 capability。Region 的几何尺寸应属于具体 shape：球半径、盒体尺寸、圆柱尺寸等。应通过 shapeDataOffset 和 shape 类型定义进行读写。Point 类 region 不应显示一个会被写回的“通用缩放”。

Part 的 scale 与 Region 的 shape 参数不应为了前端组件复用而共享同一种持久化结构。UI 可以使用相同的变换控件，但提交到 Core 时必须转换为不同命令；不能让 UI 的 Transform 对象替代格式模型。

### 3.3 F03 / P0 风险：删除条目只改 offset 表，没有完成引用重映射

**证据等级：A（删除算法）+C（完整运行影响）。**现有 `BatchRemoveEntriesFromParam()` 删除 family offset 表中的目标，保持剩余 payload 的物理位置。保持物理位置有价值，但**物理偏移未变不代表逻辑列表索引未变**。成熟 Region 有 ActivationPartIndex，依赖 Parts 的列表位置。[S04](#s04)[X02](#x02)

假设 Parts=[A,B,C]，某 Region 的 ActivationPartIndex=1 指 B。删除 A 后，列表为 [B,C]；若引用值仍为 1，它变成指 C。自己的“目标已从列表消失”验证无法证明所有其他对象仍指向原目标。地图事务当前检查被触及对象与被删除对象，而不是全部受影响的引用闭包。[S08](#s08)

**修复方向：**在具备完整引用元数据之前禁用相关结构删除，或仅允许通过可证明无入边的受限删除。完整实现应先建立 oldIndex→newIndex 映射，枚举所有索引引用，修正幸存目标的索引，对指向删除目标的引用执行明确策略；无法解释的引用区域阻止提交。不能只处理 EntityID 引用，因为部分关联并非 EntityID。

### 3.4 F04 / P1：地图批量变换静默跳过无效目标

`batchTransformMapParts()` 对 `findPart(target)` 未命中的目标执行 `continue`，只在所有目标都没找到时失败。结果可能是用户要求移动 10 个对象，实际只动 9 个，返回 `ok:true`。已执行探针用一个存在、一个不存在的目标展示该选择逻辑。[S07](#s07)

建议默认 all-or-nothing：完整解析目标集后再 staging；返回 requested/resolved/modified/skipped 列表；只有用户显式选择 best-effort 模式时允许部分完成。重复目标需要去重或拒绝，否则计数与实际对象数也可能不同。

### 3.5 F05 / P1：地图查询组合条件没有交集语义

`queryMapEntities()` 对 modelName、entityId、regionName、kind 使用 `if/else if` 选择一条，只有 nameContains 在其后追加过滤。调用者同时传 modelName 与 entityId 时，entityId 不参与过滤。[S06](#s06)

解决方式有两种，必须选定：schema 明确这些参数互斥，并在运行时拒绝组合；或按“所有给出的筛选条件都成立”执行交集。不要让模型从一个看似合法的输入对象猜出服务内部优先级。写入前还应核实结果数量与用户目标数量。

## 4. 事务、回滚与“验证成功”的定义

### 4.1 已有的保护值得保留

当前事务有路径边界、staging、验证、提交前 source hash 检查、恢复点、每文件临时文件替换和失败补偿。持久提交在替换之前登记恢复信息与预期 hash，避免只把交易留在聊天中。这些不是空白基础设施，不应另造一套竞争的事务引擎。[S14](#s14)[S15](#s15)[S16](#s16)

但逐文件 rename 加出错后恢复，属于**有恢复能力的多文件提交协议**，不是所有外部观察者都无法看到中间状态的多文件原子操作。报告不把它称为操作系统层面的一次原子提交；也不在未检查 fsync 与平台行为时声称断电持久性已经解决。[S15](#s15)

### 4.2 四种“成功”需要分开

建议保留四层后置条件：目标物理文件已替换；独立结构解析通过；用户要求的语义值成立且未破坏旁支；UI 呈现与权威状态一致。游戏行为验证可作为第五层，不能伪装成所有离线编辑都能自动证明。

每次 mutation 返回 `committed`、`verification`、`transactionId`、`affectedResources`、`postconditions`。`ok:true` 不应同时表示“工具成功返回一个空结果”“草稿建立成功”“已经提交”“已经完成用户任务”。地图服务已经部分区分 committed 与 verification，值得推广。[S08](#s08)

### 4.3 提交后验证失败不应被低层返回值掩盖

地图服务在 `applyNativeMutation` 已提交后执行另一次高层重读及后置条件检查；失败时返回 `committed:true, verification:'failed'`。这种诚实状态优于假成功，但它不等于文件已经自动恢复。调用方必须展示“修改已经落盘但验证失败，需要恢复/核对”，并维持 recovery-required 状态；禁止仅显示普通失败，让用户以为磁盘没变。[S08](#s08)

能进入事务内的语义验证应进入提交验证边界；必须依赖完整提交后才能验证的项目，则应有日志化补偿步骤。不能同时保留两个验证体系，其中一个失败会回滚，另一个失败只是报错，却让 Agent 用同一句话描述它们。

### 4.4 回滚建议沿用现有 journal，不依赖 LLM 重建目标

已提交 T1 的回滚应从 journal 读取冻结的 canonical target、pre-image、post-image，生成 T2，记录 revertOf。模型只负责选择 transactionId，不负责重新猜“刚才改的是 Goods 还是 ItemName”。未提交草稿的 discard 与 committed transaction 的 revert 必须是不同操作。

目标比较不能只有数值 ID，至少含 workspace、outer resource、容器 child、格式域、语言/表、物理身份及 revision。A→B→C 后撤回 A→B，必须发现当前值不是 B，禁止把合法的 C 覆盖成 A。多对象回滚需先验证全部 preconditions，再进入写入；任何冲突默认整笔拒绝。

本次未完整追读生产 `rollbackOperation` 与 UI transaction 绑定，因此以上属于验收设计，不能说该版本还没有回滚引擎。历史“ItemName/1000 被说成 Goods/1000”的案例应作为回归，不作为当前已经复现的缺陷。

### 4.5 并发写入的锁粒度

建议锁定最终 outer 文件，而不是只锁“某张 PARAM 表”“某条 FMG 文本”。两个 child 可以属于同一个 BND/DCX，分别重建同一个 outer 会导致互相覆盖。一次事务跨多个 outer 时按 canonical path 的固定顺序取得锁，避免死锁。

临界区覆盖“读前置版本→生成最终暂存→验证→持久准备→替换→确认”；不能只锁 rename 的几毫秒。写入前再次校验版本仍有价值，但 hash 检查与替换之间若没有排他控制，就仍存在竞态窗口。当前已读低层片段不足以证明上层完全没有锁，故这一点列为宿主链路专项核查。[S15](#s15)[S16](#s16)

## 5. 各编辑模块：实际边界与下一步算法

### 5.1 PARAM：从“行号”升级为物理身份与批次最终状态

当前实现保留部分原始字符串区与编码，避免数据字段修改时重写无关名称；不对行 ID 排序；32 位布局将未验证的新增、删除、改名拦住。这些限制应保留为显式能力，而不是被 Agent 当成临时障碍绕过。[S18](#s18)

**F06 / P1：物理行删除的验证缺口。**writer 的 delete 分支只有 `patch.RowIndex is null && row is not null` 才报“仍存在”；有 rowIndex 时没有相同的删除后条件。此处不能证明实际删除算法没有执行，但能证明 verifier 无法拒绝一类“删除未生效”的错误输出。探针用注入的未删除结果演示该谓词缺口。[S17](#s17)

**F07 / P1：按每条 mutation 对照最终文件，无法处理同目标多次更新。**写 A→B、再 B→C 后，最终 C 合法；逐条拿最终文件对照 B 与 C 会在 B 处失败。已读 PARAM writer 存在这种验证结构。正确实现应先对整个 mutation 序列进行确定性模拟，构造 touched-object 的最终 post-image，再验证最终文件；若业务不允许重复写同目标，则在写文件前拒绝，而不是写完才报错。[S17](#s17)

**F08 / P1 风险：删除导致后续 rowIndex 漂移。**紧凑布局的 mutation 顺序作用于可变 rows 列表。删除靠前行后，后续基于原快照的 rowIndex 可能不再指同一行。expectedId/hash 可帮助拒绝错误，但不能自动解释调用者想要“原快照索引”还是“每一步当前索引”。建议在 preflight 中将全部输入绑定到不可变 RowHandle；mutation 模拟维护句柄到当前位置映射；验证不再使用原数组位置。[S18](#s18)

**F09 / P2：名称后置条件不充分。**已读 writer 在非删除分支验证 row ID 和 dataBase64，没有对 patch.Name 进行对应检查。不能由此断定 rename 功能必坏，但应补上 null、空串、中文、日文、重复名与原编码不能表示字符的用例。[S17](#s17)

性能建议：全量加载轻量 row index，字段 payload 按可见窗口/选中对象拉取；session 持有 schema 与原生文档；批量相邻行读合并为一个请求；同一 outer 的多表写聚合成一次重建。不要把“React 虚拟列表”当成数据搬运已经惰性的证据。当前 UI 热路径未完成 trace，本报告不重复旧版必走 loadAll 的指控。

### 5.2 FMG/MSG：文本 ID 必须带语言、表与容器身份

已读 FMG writer 区分 loose 与 msgbnd/DCX profile；写前进行 hash 与编码检查；将容器替换交给 BND writer；重读目标表并验证未触及的 sibling。拒绝 U+0000 与孤立代理项是必要保护，因为不能把不可表示文本悄悄转为替换字符后宣称保存成功。[S20](#s20)

需要补齐的测试包括：同一 textId 在不同分类/语言存在；同一表的重复槽；null 与空字符串区别；插入删除后的 group 范围；多条修改同一 ID 的最终状态；另一个 Agent 改同容器其他表后的冲突；提交再回滚后 UI 显示是否一致。编辑器侧的“备注”“译名”若是外部 metadata，不应误写进 FMG 文本。

建议接口使用 `TextEntryHandle`，而不是裸 textId。其来源可以是 native slot identity + sourceRevision；显示时再转换为“某语言/某表/编号”。名字解析可以参考 Wiki，但实际写入身份只能从当前文档取得。

### 5.3 EMEVD：语法通过不等于控制流与参数绑定正确

已读 writer 支持 raw 与 DCX outer，保持 payload hash 和 outer hash 的区别，重建压缩外层并重读。部分验证处理事件重命名映射，说明它已不是简单覆盖字符串。[S21](#s21)

仍需独立验证的重点是：插入/删除指令后事件局部索引与文件全局索引的转换；参数绑定的字节偏移与目标指令；字符串表、linked files、rest behavior；重命名事件的调用引用；多个 mutation 在同一事件上组合时的最终状态；64 位事件 ID 与 TypeScript number 的表示范围。这里只列核查目标，不把未阅读完整的数据路径判为已存在漏洞。

建议将 AST→类型化 IR→native 编码作为唯一写路径。每个指令带 stable instruction identity 和 revision，不用用户看到的行号作为长期句柄。结构性修改由 IR 模拟器生成 post-image；writer 不再为每种操作各写一套会相互矛盾的最终状态校验。

Agent 的 read_emevd_outline 只用于定位；分析行为必须读取完整事件或明确分块的指令范围。分页不能切断条件组、指令参数说明或省略会影响控制流的片段而不告诉模型。大事件以事件/基本块为单位建立语义索引，不以固定字符数直接切碎。当前 prompt 已强调“大纲不含逻辑”，应保留这一边界。[S32](#s32)

### 5.4 Lua 与脚本：编码、反编译、编译、可加载性是四个问题

`scriptSourceWriteback.ts` 按原始编码回写明文，混合编码只允许改纯 ASCII 行并保留高字节；它对 Lua bytecode magic 走 `decompiled-as-utf8`，将输入文本编码成 UTF-8。这是一种**资源表示转换**，不是字节码重新编译。[S22](#s22)

该策略是否适用于具体只狼脚本加载位置，需要已知样本和游戏加载证明。不能只依据注释中的“社区流程”就把所有 LUABND 条目当作可替换成明文。应建立 loaderProfile：游戏版本、脚本类别、容器路径、允许 source/bytecode、编码、反编译工具版本。对没有 profile 的字节码替换，保留只读或人工确认模式。

Agent 修改脚本需保存整段原始文本及 hash，进行语法检查、入口函数/导出约束、禁止无关格式化；条件允许时进行沙箱执行或已有脚本测试。反编译结果中的占位符、失败注释、丢失 upvalue 信息等不应被当成原始源码。当前具体 decompiler 的完整实现未纳入审查，不能承诺语义等价。

混合编码算法会做多次数组与字符串展开，对超长脚本可改为字节区间拼接和局部 diff，但必须保留“非编辑区逐字节不变”的证明。速度优化不能通过统一转 UTF-8 获得。

### 5.5 地图“结构化文本”不是通用文本替换

地图名称、ModelName、SIB 路径、EntityID、Region shape 与游戏显示文本是不同概念。当前 MSB mutation 对 `set_property` 的已读实现主要是 EntityID，不是任意字符串属性编辑；它也没有因为读取到 Name 就自动具备 rename 能力。[S04](#s04)[S08](#s08)

后续接口必须返回每个字段的 storageKind、type、writable、referenceNamespace、native authority。名称改动可能要求重建字符串区及相对偏移；模型名改动可能只是更换索引，也可能涉及新增模型资源；这些操作不能落到一个 `replace_text(old,new)` 上。

### 5.6 TAE 动作词条：显示的类型名称不等于事件参数可写

已读 writer 的操作集合是 `update-event-times` 和 `insert-event`。插入复制模板的不透明参数体，没有因此获得“任意 eventType 的任意字段编辑”；新事件不自动进入事件组，这一边界在源码中写明。[S19](#s19)

应将 TAE 能力拆成时间、参数模板、事件类型、事件组、动画绑定五个开关。用户说“把动作词条里的数值改成 X”，需要先判断那是模板说明文本、实际 paramData 字段还是时间轴元数据。前者属于知识包维护，后两者属于原生编辑，不能串用。

**F10 / P1：每条 mutation 保存整文件快照。**writer 对每一步克隆 `context.Bytes` 并保留到 appliedResults。m 个修改、基础文件 B 字节，其保留空间至少呈 O(mB)，插入增长还会增加成本。建议以 immutable baseline + 写区间日志/append ranges 表示中间状态；验证最终 post-image 与未触及区间，不保留 m 份完整文件。[S19](#s19)

模板插入需验证同 eventType 的参数布局、事件组引用、共享时间槽、同一动画与跨动画时间槽别名、帧/秒换算、零时长事件、重复修改同一事件。DSAnimStudio 的成熟时间轴体验可作交互参照，但本报告没有将它的全部行为复制为只狼格式规范。[X04](#x04)

### 5.7 FLVER、蒙皮与动作预览

本版 `FlverMatureSkinning` 已处理骨骼 palette 版本差异、NormalW 刚性绑定、权重与索引有效性、FK 递归、层级环、参考姿态矩阵、DirectBoneMap。旧报告中的缺失不能继续当现存事实。[S11](#s11)

验收仍需由浅入深：静态几何→原始参考姿态→刚性绑定→加权绑定→动画 pose→root motion→材质。每一级使用同一来源资产、固定姿态和独立参考。先证明身体 mesh 非零且顶点有限，再讨论动画是否走对。

输入防御要包括负权重、非有限值、无有效骨骼、非可逆 bind matrix、顶点影响数超限及畸形 hierarchy。已读 DecodeVertex 仅明确拒绝非有限权重，负值处理值得专项测试；它是否能被真实有效语料触发，不能在没有样本时下结论。

不要由“画面看起来大致正确”证明矩阵语义正确。应选特征顶点、骨骼和已知 pose，比较 native 参考与渲染器输出误差；单测绕序、primitive restart、16/32 位索引和 NormalW 不能替代这一层。

### 5.8 其他格式、辅助功能与发布

ESD、FXR、GPARAM、MTD、TPF、碰撞/导航、安装器与更新功能有各自入口，但本报告没有完成它们的深层算法审查。它们必须保留独立的“读取、有限编辑、全结构重建、游戏验证”状态，而不是借用 PARAM 或 FLVER 的通过结果。[S02](#s02)[S34](#s34)

TPF 验收需关注 DDS 格式、mipmap、尺寸、压缩、色彩空间和 texture name 保留；MTD/GPARAM 关注类型、枚举、数组与引用；ESD 关注状态机、条件树与参数编码；FXR 关注节点关系与未知区间；碰撞/导航关注空间树、索引、材质和游戏格式版本。这是后续验收清单，不是本次发现这些模块存在相应 bug。

Mutter 应继续隔离于模型上下文；反馈日志需去 secret、保留 build fingerprint 和真实失败状态；更新需验证发布物、支持失败回退。现有历史设计可作意图依据，但不能当本版运行证明。

## 6. Bridge 与响应速度：减少重复工作，而不是再包一层缓存

### 6.1 F11 / P1：分块传输之前已经做了全量解码

`MapStaticGeometryService.GetOrCreate()` 在 `lock(Gate)` 内调用 `BuildMeshInfos()`，遍历 FLVER 的所有 mesh。每个 mesh 的 positions、normals、UVs、indices 被请求为 Base64，再立即解码回 byte[] 和 typed arrays。session 同时保留 FLVER 与这些数组。注释所描述的“只持有文档与 FaceSet 计划”与实际持有的完整投影不一致。[S10](#s10)

这条路径的成本至少包括：原生属性提取、Base64 编码、Base64 字符串分配、Base64 解码、数组复制、全网格 bounds 扫描。分块响应控制了 stdout/IPC 单包大小，但无法消除首个响应前的工作，也不能限制 session 的驻留内存。8 MiB wire budget 不是 8 MiB working-set budget。

建议将 native geometry API 改为直接返回或填充 typed buffer；Base64 只允许出现在必须文本传输的边界。内部服务不能为了复用一个 wire 方法反复编码/解码。只有真正需要的 mesh/FaceSet 才生成投影；chunk 的源顶点到局部顶点 remap 保留为可验证结构，不能以截断索引替代分块。

### 6.2 F12 / P1：全局锁包住高成本构建

全局锁应保护 session 表的查找、发布与引用计数，不应包住整个模型投影。可采用 per-resource single-flight：相同资源共享一个构建任务，不同资源允许受限并发；任务成功后在短临界区发布；失败移除占位并返回结构化错误。取消某个订阅者不能取消仍被其他视图使用的共享构建。[S10](#s10)

同时将按 16 个 session 的容量上限换为 byte-budget LRU 或带权淘汰。16 个模型可能是几十 KB，也可能是大量几何；数量上限不能代表内存上限。TTL 可作为兜底，不能替代 lease release、工作区关闭清理与未使用资源的及时释放。

### 6.3 F13 / P1：地图高层请求重复加载完整文档

批量变换先 `loadMapDocument`，`executeMapTransaction` 又加载一次，提交后它再加载验证，外层批量服务成功后再次加载生成 afterList。源文件是否每次都重解析取决于 Bridge 下层缓存，但高层重复的完整读取、DTO 投影与 scene graph 构建已经存在。[S06](#s06)[S07](#s07)[S08](#s08)

建议将 preflight 的 snapshot lease 传入事务；由事务返回 verified post-state，而不是外层再读一遍。保留必要的独立提交后重读，删除仅为拼装 UI 结果而重复的读取。不能以“已有缓存”为理由不测 IPC 字节和反序列化开销。

### 6.4 F14 / P2：ParseCount 的名字不对应实际事件

已读服务在建立 SessionEntry 后增加 `ParseCount`；它没有包在 FLVER parser 的实际入口上。因此该值更接近 session/projection 创建次数，不能单独证明“一次 map 打开只解析一次 FLVER”。[S10](#s10)

建议拆分 `containerReadCount`、`decompressCount`、`binderParseCount`、`flverParseCount`、`projectionBuildCount`、`cacheHit`、`wireBytes`、`gpuUploadBytes`。所有计数绑同一 traceId 与 source revision。测试若只读取一个名叫 ParseCount 的计数器，就可能误把重复解析隐藏在计数之外。

### 6.5 Bridge 协议的优点与剩余风险

daemon 有单工作区握手、allowedRoots/writableRoots、协议版本、deadline/cancel、并发信号量；默认并发 2，上限 8。这些保护应继续复用。不能说 Bridge 完全没有并发限制。[S12](#s12)[S13](#s13)

**F15 / P1 防御性风险：**`ReadLineAsync` 完整取得字符串后才计算 UTF-8 字节数并拒绝超限帧。超大无换行输入在拒绝前仍可能造成分配压力。读取端应采用有界增量 framing，在超过协商上限时停止累积；输出端同样记录实际编码字节。此问题的威胁范围取决于 stdin 能被谁控制，报告不把它描述为已证实的互联网远程漏洞。[S12](#s12)

**F16 / P1 调度风险：**执行并发上限不等于排队请求上限。已读主循环接收任务后才在请求内部等待 semaphore。建议增加 maximum queued requests、优先级、公平性与 backpressure；用户选中一行的交互读取不应排在数百个地图后台预读后面。[S12](#s12)[S13](#s13)

命令定义应统一包含 inputSchema、effect、readRoots/writeRoots、resourceKey、capability、costClass、cancelMode、timeoutPolicy。由此生成广告能力、写盘注册表和协议校验，减少手维护列表漂移。安全边界仍由 daemon 执行，不能依赖 TypeScript 预先检查。

### 6.6 渲染侧的优化合同

前端未完成逐控件和 GPU 实测，以下是交给前端 agent 的消费合同，不是已确认该版本违反全部项目：共享 model geometry；按模型与材质实例化；空间分区/可见性裁剪；拾取加空间索引；选中 instance 使用编辑 proxy；Gizmo 拖动期间拥有输入；资源销毁释放 geometry/material/texture；GPU 上传有每帧预算；旧 revision 或已关闭 tab 的异步结果不能挂回场景。

核心后端提供 emitted vertex/index counts、bounds、材质槽、topology、空间约定、sourceRevision 和明确错误阶段。前端不负责猜 TriangleStrip、NormalW 或 native 指针，也不允许把 fallback 点云当真实地图验收结果。

## 7. Agent loop：已有约束，但需要目标级效率与效果调度

### 7.1 本版已经解决一部分旧问题

默认 200 步上限、发现/研究预算、失败预算、语义失败计数与进展判断存在；固定 taskQuery 和 RAG 缓存避免了旧式每轮重复检索用户原文。工具桥从 runtime shape 投影 JSON schema，提供固定 envelope 和候选/原生证据状态，避免模型猜参数名。这些应作为后续改造的起点。[S23](#s23)[S24](#s24)[S30](#s30)

“200 步”是最终保险，不是效率目标。一个三字段修改绕行 80 步，即便没越上限，仍是差的执行。应按子目标的已解析对象、已验证引用、已确认字段与已提交后置条件计进展，而不只看新增字符串、ID 或一次工具成功。

### 7.2 F17 / P1 风险：整批 Promise.all 缺少 loop 级独立结算

当前 loop 对连续的 supportsParallel 工具组成一批 Promise.all，等待整批结束再记录结果。工具桥将 read/analyze 标为并行，写入/提案等走独占策略；因此不能据此说“所有写操作都在并行”。[S25](#s25)[S30](#s30)

这仍有三个边界需要处理。第一，批次数量在该层没有成本权重或并发槽，可能把大量任务塞入下层队列。第二，最慢工具决定整批反馈时间。第三，如果 executeTool 的某个宿主路径抛出而非返回 ToolResult，Promise.all 会 reject；已读 loop 片段没有为每个 Promise 独立捕获。**本次未完整证明生产适配器一定漏掉异常，因此第三项是条件性风险，不是已复现崩溃。**

建议由统一 scheduler 接受结构化任务，逐项捕获、结算、记录耗时，并在工具完成时更新 UI；对模型的 tool-result 顺序仍保持协议要求。设置交互/检索/CPU 解码/外部进程的不同资源槽，按真实 resourceKey 排除冲突。

### 7.3 只用 supportsParallel 不足以表达效果

工具“只读游戏文件”仍可能更新 WorkspaceIndex、RAG、内存 cache 或台账。因此 read 不总等于没有共享状态副作用。反过来，两个不同文件的分析也不必被全局串行。[S30](#s30)[S31](#s31)

建议效果模型分成：观察资源；更新派生索引；编辑草稿；替换 outer 文件；维护 Wiki；启动外部进程。每个调用声明资源读集合 R 与写集合 W。仅当 W₁ 与 R₂∪W₂、W₂ 与 R₁∪W₁ 都不相交，且不违反全局预算，才并行。容器 child 的写集合提升到 outer resource。

多 Agent 也应遵循同一规则。模型数量增加不能弥补合并契约缺失。复杂推理 agent 输出计划和约束；读取 worker 输出证据；编码 agent 只处理已经确定的改动；最终提交由单一事务协调者完成。前端 agent 的任务限定为消费协议、渲染和交互。

### 7.4 目标状态机与 completion contract

建议将用户请求分解为 GoalSet，每个 goal 包括对象、目标属性、期望值/约束、执行范围、允许修改集和验证函数。例如“修改敌人类型、忍杀次数和掉落”是三个语义后置条件，而不是“调用过三次 mutate”。

目标状态可采用 unresolved→resolved→planned→staged→committed→verified；blocked、cancelled、partial、recovery_required 为分支。复合修改完成必须满足所有必需 goals 的 verified，或由用户明确接受部分目标。自由文本总结不得覆盖该状态。

“检索找到了三个新 ID”不等于任务进展。建议进展量来自 resolver 状态变化、候选集缩小、缺失字段补齐、引用边确认、验证通过。连续无进展达到阈值时，先改变检索计划，再耗尽子目标预算；不要求弱模型在没有新信息时继续猜。

### 7.5 取消、重试与幂等

取消应分“未开始”“正在读取”“staging 中”“已进入不可中断替换”“已提交待验证”。用户点击停止后，界面不能在文件还会变化时显示“已停止”。可取消读取应向 Bridge/external job 传递 signal；进入提交阶段后应完成一致性协议或执行补偿，然后报告最后可信状态。

重试 mutation 必须带 idempotency key 与原 transaction identity。网络/IPC 超时不能被当作“肯定没执行”；先查询结果，再决定重试。外部模型的 tool_call_id、用户目标 ID、内部事务 ID 应能互相追踪，不能由时间戳字符串承担唯一身份保证。

### 7.6 工具结果压缩必须可继续读取

工具桥把部分结果限制到 8192 characters，并压缩数组、长字符串和深层结构。它已有 pagination、identifiers、evidence，是正确方向；但 result 有稳定 ID 不等于模型已经看到了需要修改的完整内容。[S30](#s30)

建议摘要返回原生 snapshot handle、明确 missingFields、nextRead 参数、截断原因和原始长度。读取完整事件或脚本时必须有可恢复的 page/range 接口；重复调用相同工具只得到相同摘要，不应被当成合理继续方式。summary 不得用于计算修改后的完整替换文本。

## 8. RAG、引用图与证据一致性

### 8.1 F18 / P1：向量候选未沿用 family 过滤

本节混合检索问题在向量路径启用时成立；Broker 问题在该组件被启用时成立。本次没有证明所有桌面生产会话都默认走这两条路径，不能把组件缺陷直接换算为全部任务的受影响比例。

`hybridRetrieve` 将 options 交给词法检索，但随后遍历向量候选时只检查 chunk 是否存在，没有同样的 families 限制。调用者要求 param family，向量侧仍可能把 map/text 等候选加入融合。抽取探针已演示这一候选集合问题。[S28](#s28)

修复应在检索入口规范化 filter，再交给每个候选生成器；融合前后二次校验。过滤器不仅是 family，还应包含 workspace、游戏、语言、resource scope、revision compatibility、trust status。不要靠 RRF 分数把越界候选自然压下去。

### 8.2 F19 / P2：引用扩展先 push 后检查 limit

`retrieve.ts` 的 primary 已可能取满 limit；引用扩展加入 extra 后才检查总数是否达到 limit，于是存在 limit+1。对小结果这只是一个条目，但它证明返回上限不是硬契约，后续模型预算和 UI 可能继续叠加超限。[S29](#s29)

需要区分两个参数：candidateLimit 与 finalLimit。先预留扩展预算，或在加入前检查剩余额度；final result 统一截断并声明 omitted 数量。引用扩展是否允许跨 family 必须是显式选项，不能把“检索范围”同时解释成硬约束和建议。

### 8.3 F20 / P1：Broker 优先保留旧顺序

当前 Broker 去重后按原始顺序装配前 16 条；较新版本替换旧证据时也保留原位置。去重解决重复占位，但并没有形成“与当前子目标相关、更新、权威”的选择器。第 17 条不同证据可能持续不进入装配结果。[S27](#s27)

建议选择器以 target relevance、required dependency、authoritativeness、revision validity、recency 评分；冻结已用于当前修改的必要证据；排除被 supersede 的旧事实；为每种 evidence family 设合理配额。不要简单反转数组，因为刚出现但无关的信息也可能挤掉关键前置条件。

### 8.4 F21 / P2：所谓 byte budget 使用字符串长度

Broker 的预算计算使用 JavaScript `.length`，并非 UTF-8 字节，也不是模型 token。16 条每条 600 个汉字，仅正文 9600 code units，却有 28800 UTF-8 字节；这还没算标题与 envelope。已执行探针说明名义 12000 bytes 预算不能保证实际字节上限。[S26](#s26)[S27](#s27)

建议为每条证据缓存 wireBytes 与 estimatedTokens，分别控制传输和模型上下文。使用真实 tokenizer 或保守估算，但不要把计数单位混用；指标名字必须写清。相关性选择应在昂贵 readText/序列化前完成，避免读完所有候选才决定丢弃大部分。

### 8.5 F22 / P1 风险：证据身份缺少强制资源命名空间

已读 Broker 的稳定键提取会从对象中抽取 id、rowId、table、uri 等值；有稳定 ID 时，key 主要由这些归一化值构成。source kind/URI 并非每次都被强制加入身份，全部 lower-case 也不适用于所有区分大小写的资源。这会产生跨资源同 ID 合并的契约风险，具体生产 envelope 是否触发需要测试。[S26](#s26)[S27](#s27)

正确的 EvidenceKey 应由结构化字段构造：workspaceId、canonical resourceId、domain、namespace、object identity、claim kind。来源 revision 属于该证据版本，而不是把两份不同来源混成同一个 ID。不要把散落文本中提到的多个数字排序后作为对象身份。

### 8.6 算法开销：先优化可证明的复杂度

已读向量路径对 N 个向量做相似度并对结果排序，约 O(Nd+N log N)；引用扩展对每个命中扫描 references，约 O(kE)。前者可先用固定大小 top-k heap，将排序降为 O(N log k)；后者建立 adjacency map 降为遍历实际邻居。[S28](#s28)[S29](#s29)

在数据规模与耗时基线未知时，不建议先引入另一套向量数据库。完整扫描可能对小语料足够；ANN 会增加版本、持久化与召回调参成本。先测 source corpus 大小、检索频次、CPU 时间，再决定是否引入近似索引。

精确 ID/路径/字段查询应走确定性索引，不应与语义近似候选混在一个平面排序中。候选融合先做范围过滤，再 exact match pinning，再词法/向量融合，最后进行 native confirmation。

### 8.7 数据权威与 freshness

建议明确三层：canonical native snapshot 负责事实；semantic graph 负责经 schema 解释的引用；RAG/Wiki 负责找到候选与解释模式。RAG 命中不能替代原生读取，两个下游都没有命中也不构成两个独立的“不存在”证据。

每次原生读取或提交改变资源后，发布 `ResourceRevisionChanged`。索引、引用图和检索投影记录其来源版本；不能在 file hash 更新后仍使用旧 paramdef/reader schema 解释。提交后应推送 delta，避免每个字段写入触发全库 rebuild；合并同一事务中的刷新请求。

搜索结果应带 coverage：complete / partial / not_indexed / parse_failed / stale / source_unavailable，以及覆盖的资源范围。只有完整覆盖下的未命中才可作为“不存在”的证据。当前生产 coverage 的所有工具出口未逐一核实，因此本报告将其作为必须验证的统一契约，而非断言当前所有工具都没有 coverage。

## 9. 提示词与刁钻情况：规则应引导，不应代替程序

### 9.1 当前 prompt 的有效部分

已读主体明确区分用户名称与参数 ID；要求候选沿 sourceUri、hash/revision 读取；MSG 与 PARAM 可并发定位；大纲不能替代事件源码；Three.js/React 显示不是写入依据；编辑后必须原生回读。这些原则可以保留。[S32](#s32)

### 9.2 当前 prompt 的效率与泛化问题

固定要求所有领域任务先读记忆、未命中再启动两条定位链，会让已给出精确 URI、物理行和字段的任务也可能多走步骤。可以改为路由规则：精确 native handle→校验版本并读目标；模糊实体名→记忆/词法/结构化召回；机制问题→模式知识与引用图；未知资源→先查询能力与 coverage。[S32](#s32)

“NpcParam.itemLotId=-1 时应优先看击败事件”可作为领域启发式，但不能成为“所有 Boss/精英奖励都一定如此”的权威规则。任务变体、Mod 自定义机制、共享 ItemLot 和 common event 应保持可追踪的候选分支。稳定知识放 versioned knowledge pack/Wiki，system prompt 保留策略与禁止越界的规则。

提示词要求一轮并发登记多个台账条目，这是减少模型往返的意图；但台账更新是共享状态写入，应由一个批量原子 API 或带并发控制的服务承接，而不是单靠“并发发 N 次 update”保证一致性。当前台账网关有 reservation/finalize/release 契约，后续应复用，不再创建另一套授权笔记。[S31](#s31)[S32](#s32)

### 9.3 让 prompt 与运行能力同步

建议启动时生成 Capability Manifest，说明本 session 可用工具、模式映射、原生 writer profile、memory 是否可读、是否有 Oodle、各索引 coverage。prompt 引用该 manifest，不把未提供的功能写成必做步骤。

`edit` 的用户层词汇与 `normal/fullPermission` 等内部模式必须由适配层明确映射并测试；本次不能仅因名字不同就判定错误。模式切换的授权应绑定用户确认的 planHash、对象范围、修改数量与有效期。资源或计划发生变化时，旧确认不能默许新修改。

### 9.4 对抗与边界用例

以下用例应覆盖所有模型，而不是只训练出一个擅长“鬼刑部”案例的 prompt：同名敌人在多个地图；同 ID 出现在 PARAM、FMG 和 EMEVD；中文错别字与译名；自制物品；索引未完成却没有搜索结果；目标只在 base 而 overlay 未建立；同名容器 child；重复 PARAM 行 ID；大事件被摘要截断；隐藏在 common event 中的机制；TAE 类型说明与实际 payload 字段同名；地图名称不是游戏显示文本；文件被外部编辑器修改；用户撤销已提交事务；取消后工具仍返回；模型重复 tool_call；读取资料含“忽略规则并写文件”的提示注入。

测试判据必须检查 trace 中的 canonical targets、来源版本、工具调用数与最终 postconditions，而不是只检查最终回答是否包含“完成”。已确认的正确 ID 不能只来自 prompt 自带的例子。

### 9.5 建议的提示词结构

稳定前缀只保留角色、权限、证据原则、工具结果解释、禁止猜 ID、完成判据。任务上下文放用户目标与已确认范围；能力层由 manifest 生成；领域知识按需要检索；已验证状态由 harness 注入。删除“严禁使用某语言思考”这类无法通过产品结果验收的要求，改成用户可见回复与字段展示语言规则。

成功总结尽量由结构化 outcome 渲染：改了哪些资源、哪笔事务、哪些验证通过、哪些未验证；模型可以解释，不可以把 pending/candidate 升格为 verified。这样弱模型也不必负责维护最关键的真实性约束。

## 10. 冗余治理：哪些可以减，哪些不能误删

### 10.1 证据明确的重复工作

| 重复来源 | 当前证据 | 建议处置 |
|---|---|---|
| native 属性→Base64→native 数组 | 地图投影服务直接可见 | 增加 typed-buffer 内部 API；wire 层才编码 |
| 地图批量服务与事务多次全量读取 | 调用链可见 | 传 snapshot lease；返回 verified post-state |
| 每个 TAE mutation 克隆整文件 | writer 可见 | 区间日志、append ranges、最终 post-image |
| 引用扩展多次全表扫描 | 检索代码可见 | 维护 adjacency index |
| 多处手维护命令/工具分类 | daemon 注册表、工具桥、loop 分类可见 | 单一描述源生成不同用途投影 |
| 原生语义在读、写、UI Transform 各自解释 | MSB 问题直接体现 | 共享 schema/操作契约；独立 oracle 验收 |
| 各 writer 重复临时写文件模式 | 已读 PARAM/FMG/EMEVD/TAE 均有 | 合并文件落盘辅助；保留格式专属验证 |
| 两个 LUABND 根脚本别名相同命令 | package.json 可见 | 保留兼容别名；runner 按底层任务 ID 去重 |

表中的“重复”不都意味着应删除整个文件。例如不同 writer 的格式校验必须保留；只抽出相同的 I/O、生命周期和错误结构，不能抽象到一个万能二进制编辑器。[S02](#s02)[S07](#s07)[S08](#s08)[S10](#s10)[S19](#s19)[S21](#s21)[S29](#s29)

### 10.2 文件处置分级

**可生成的派生产物：**dist、缓存、临时导出、构建报告等需要先确认来源与发布依赖。用 `.gitignore` 和 release allowlist 管理，不能仅凭扩展名删除。本次没有完整统计这些文件是否已跟踪。

**历史设计与审计：**加 archived/superseded 标记和适用 commit，移出默认 Agent 检索范围，但保留事故线索与回归价值。旧文档如果继续作为当前事实进入 RAG，会制造语义回退；直接删光历史则丢失失败案例。

**测试、fixture 与门禁脚本：**先确认它们实际在 runner 中被调用、断言独立、数据可用、失败会影响退出码。无入口不一定是死代码；可能是维护者手动验收。禁止因为文件多就删测试。

**兼容 API/fallback：**标记唯一新入口与弃用期限；统计旧入口真实调用；热路径迁移完成后再删。fallback 不能悄悄从分页退回 loadAll，也不能从 native 模型失败退回占位物后还上报成功。

**备份、journal 与未完成事务：**不得与普通缓存一同清理。仅在事务终态、保留策略与引用计数满足时清理；recovery_required 的备份需要保护。

### 10.3 大文件不是自动等于冗余

目录元数据显示 renderer `App.tsx` 约 215,779 字节。[S35](#s35)这说明维护与并行改动冲突值得关注，但本报告没有逐段完成其依赖图，不能据大小直接断言“多余代码很多”。Core 的注册表和 Bridge dispatch 也应按领域拆分，但在 P0 修复期间不做大规模无关重构。

建议拆分顺序是：抽出共享纯函数与协议；固定领域服务边界；将页面编排迁到 controller；最后拆 UI。每步用生产入口测试守住依赖，不接受“文件变小了但旧入口仍在运行”。

### 10.4 一次完整冗余审计的交付标准

需要产出文件清单及 hash、import/运行时加载/构建引用图、同内容组、重复逻辑组、release 引用、最后使用证据、删除或归档理由。对 JSON schema、模板和动态模块必须扫描非 import 引用。删除后的成功条件是构建、原生门禁、发布包、运行入口同时成立；不是 tsc 单独通过。

本次未获得全仓可执行副本，故没有伪造这样一份完整清单。确定性施工图应把这项作为独立任务，不能让执行 agent 随意“清理项目”。

## 11. 面向 Agent 的 Blender 类 3D 编辑接口

### 11.1 现有接口是什么，不能误说成从零开始

`map-document.ts` 已有 `importBlenderDeltaToTransaction()`，检查 schemaVersion=1、mapId 和 baseRevision，支持 modify（position/rotation/scale/modelName）与 delete，明确拒绝 duplicate/create。Core 再经 `executeMapTransaction()` 走 staging、Patch commit 与重读。工具桥也列有 export/import Blender 工具。[S08](#s08)[S09](#s09)[S30](#s30)[S31](#s31)

这已经是有价值的**地图放置编辑接口**，但已读 delta 不携带顶点、索引、材质、蒙皮或碰撞数据。它不能等同于“Agent 已可像 Blender 一样修改模型”。当前可用的 delete/Region scale 还受前述 P0 约束，应先收紧。

### 11.2 把 3D 能力分成五级

| 级别 | 操作 | 主要验证 | 建议开放条件 |
|---|---|---|---|
| L0 场景放置 | 移动/旋转 Part，受支持的 Part 缩放、切换已有模型 | MSB 字段、稳定身份、引用、变换与回读 | P0 修复并通过真实 MSB 差分验证 |
| L1 固定结构网格 | 在不改拓扑/通道布局条件下改顶点等有限数据 | 顶点数、索引、bounds、通道、法线、写区间 | 对具体 FLVER profile 建立独立 writer 验收 |
| L2 网格结构编辑 | 增删顶点面、材质槽、submesh、LOD | 全结构重建、布局、重映射、材质/纹理依赖 | 完整编译器与独立读回；不由 glTF 成功外推 |
| L3 骨骼/动画 | 权重、骨架、bind pose、动画编辑 | 骨骼层级、palette、矩阵、采样、root motion | 对具体资产类型建立可重复参考姿态测试 |
| L4 碰撞/导航联动 | 改地形后的碰撞、导航及关联配置 | 物理/导航格式、空间结构、游戏加载与路径行为 | 独立 capability，不随视觉网格功能自动开启 |

这一分级是本报告的接口设计，不是对全部现有 native writer 能力的完整枚举。每一级都可以有部分支持；返回 unsupported 比悄悄丢失数据更合理。

### 11.3 统一资源身份与快照，不再使用孤立名称

当前 stableKey 包含 family、mapId 与 nativeOffset，并受 baseRevision 保护。nativeOffset 是**快照内定位**，不是经过任意重建后仍不变的永久对象 ID。版本一致时可以使用，版本变化后必须重新解析，不能沿用旧偏移。[S09](#s09)

建议在现有对象上增加 ResourceHandle：workspaceId、outer resource key、child identity、format profile、object kind、snapshotId、revision、opaque objectHandle。UI、Agent、Blender 都持有同一个句柄。导出时生成 exportSessionId，记录允许编辑的对象集合、基线与能力。

同名 m10_00_00_00 在两个项目中不能互换；相同文件内容 hash 也不能取消 workspace 边界。导入不能只靠名字匹配，更不能遇到找不到的对象就自动认领一个最相近名称。

### 11.4 Agent 提交意图，几何通过二进制资产通道流动

模型工具应表达“把这些对象沿法线移动”“对这个资产执行受支持的变形”“复制为独立模型并重新绑定这个 Part”，而不是让 LLM 输出十万个顶点。几何数据通过受控 artifact handle 传递，提供 bounds、counts、材质摘要与 hash 供模型理解。

建议的工具族：query_scene、inspect_object、begin_scene_edit、preview_scene_edit、validate_scene_edit、commit_scene_edit、revert_transaction；几何操作单列 mesh_operation，并带 operation allowlist。现有 query_map_objects、inspect_map_object、batch_transform_map_objects 和 Blender 工具是可复用入口，不需要重新做同功能别名。

下面是**建议的新协议示例**，不是声称当前代码已支持：

```json
{
  "schemaVersion": 2,
  "exportSessionId": "exp-uuid",
  "workspaceId": "workspace-uuid",
  "snapshotId": "snapshot-uuid",
  "baseRevision": "sha256-of-authoritative-resource",
  "coordinateConvention": "soulforge-native-v1",
  "operations": [
    {
      "operationId": "operation-uuid",
      "kind": "set_part_transform",
      "targetHandle": "opaque-snapshot-object-handle",
      "position": [1.0, 2.0, 3.0],
      "rotationConvention": "native-profile-defined",
      "expectedObjectHash": "sha256-of-object-preimage"
    }
  ],
  "assetChanges": [],
  "idempotencyKey": "request-uuid"
}
```

schemaVersion 升级应保留只读迁移器或显式旧版拒绝信息，不能静默猜坐标约定。每个 operation 的字段由格式 capability 决定；Region 不接受通用 scale。

### 11.5 坐标转换是一项可测试的数学合同

Soulstruct 的官方说明指出 Blender 与 FromSoftware 的竖直轴和手性不同。不能把交换 Y/Z 当作全部转换，也不能让 native 与 Blender 两边都做一次转换。[X05](#x05)

建议为每个导出会话确定唯一基变换矩阵 C。位置转换为 p′=Cp；局部/世界变换的表达转换为 M′=CMC⁻¹。法线按实际几何变换的逆转置处理；若应用了反射，三角形绕序和切线 handedness 需对应处理。单位、角度单位、Euler 顺序、矩阵行列约定、bind pose 都必须写在 profile 中。

负 determinant、非均匀缩放、零缩放、非可逆矩阵不是“随便试一个参数”的问题。对不能表示的剪切，应拒绝、要求 bake 或进入显式几何修改流程；不能分解后丢掉 shear 却仍宣称无损。所有转换做往返测试，选择非轴对齐、非等比缩放、有 parent 的对象，而不是只测原点。

### 11.6 场景实例与共享模型：必须有 copy-on-write

一个 FLVER 可能被多处 Part 共享。用户编辑一棵树的网格时，是要改变整张地图的所有同模型树，还是只改变这一棵？接口必须让 intent 明确为 shared_asset_edit 或 make_unique_then_edit。

make_unique_then_edit 需要为新资产分配合法身份，复制相关材质/纹理引用，写入新资源，并把目标 Part 绑定到新模型。所有改动组成同一 ChangeSet。不能仅在 Blender 中把对象改名，然后寄希望于导出器处理全部引用。

### 11.7 Blender 适配器的执行边界

Blender 官方文档提示其 Python 集成不具备通用线程安全，不应让多个线程并行调用 bpy。独立于 Blender 的任务可以放在独立进程；涉及 bpy 的命令应遵循 Blender 的执行上下文。[X06](#x06)

建议由 SoulForge 外部 job supervisor 管理 Blender 进程，传入只包含允许资产的工作目录和 manifest。交互模式采用主线程安全的命令消费；网络、下载、检索和大数据预处理在 Blender 进程外执行。worker 不得绕过 Patch Engine 直接写 Mod 目录。

job 输出只进入 staging，包含 artifact hash、操作日志、工具版本、schema version 与 warnings。进程退出、超时、取消或输出缺失时都不提交。不要给 Agent 一个无限制“执行任意 Blender Python”作为默认高层编辑 API；需要代码扩展时，使用独立权限和可审查脚本。

### 11.8 无损信息与交换格式

glTF/GLB 可以作为预览或交换载体，但其字段不能保证表达所有 FLVER、TAE、MSB 或 Havok 信息。建议同时保存 native 原件和 metadata sidecar，记录未暴露字段、材质引用、dummy、palette、vertex layout、LOD/FaceSet、格式版本与源身份。修改未触及的区域要有保留策略。

能安全做定长区间修改时，可保留字节；改变拓扑时，需要真正的 native rebuild，不能继续沿用旧 offset 叠补丁。sidecar 不应成为静默恢复一切的借口：无法合并的未知结构必须报冲突。

### 11.9 碰撞与导航不能跟着视觉模型“顺带完成”

移动一块静态视觉几何不一定同步移动碰撞；改变地面拓扑可能影响导航、遮挡、触发区域、出生点或可行走范围。预览好看不能证明角色能站上去或敌人能走过去。

现阶段可先提供依赖影响报告：这个视觉资产关联哪些碰撞/导航资源、哪些已支持重建、哪些需要人工处理。只有全部必需依赖都有成功产物，才允许将这类编辑报告为完整地图修改。Soulstruct Blender 的只狼支持矩阵不能替代这个验证。[X05](#x05)

### 11.10 3D 最小落地顺序

修复 MSB 语义与引用→固定现有 delta 的身份与范围→完成真实 L0 放置往返→建立 native/Blender 坐标合同→开放一个有成熟参考的固定 FLVER profile→增加共享资产隔离→扩展拓扑/蒙皮→独立处理碰撞/导航。任何阶段都复用当前 MapEditTransaction、editorMutationService、PatchIR 与 journal，不再建一套“Blender 专属保存系统”。

## 12. Karpathy LLM Wiki：适配方案与边界

### 12.1 查到的原始内容

用户所指为 **Karpathy 的 LLM Wiki**。其 2026 年 4 月 4 日的 gist 是想法文件，不是一个必须安装的 SDK。它主张由模型维护持久、互链的 Markdown 知识库，在原始资料与提问之间积累整理结果；区分 raw、wiki、schema，提供 ingest、query、lint，以及内容索引和追加日志。下文是针对 SoulForge 的设计，不是原文承诺的现成功能。[X07](#x07)

### 12.2 为什么值得接入

SoulForge 的高成本推理往往不是“某行字段现在是多少”，而是跨多个来源理解一条机制：事件怎样调用、参数怎样引用、动作词条怎样对应、某种编辑失败意味着什么。每个任务从头召回碎片并重新拼接，会重复模型工作。

Wiki 适合保存带来源的概念解释、操作模式、已验证的排错规则、格式兼容性、测试案例和已知限制。它能让下一次任务从已整理的机制图开始，但不能替代读取当前项目、当前 Mod、当前 revision 的参数值。收益需要通过任务回放评估，不承诺接入后必定快多少。

### 12.3 与现有 RAG 的关系：不是二选一

建议四层结构：raw source archive；versioned Wiki；deterministic semantic graph；live native snapshot。RAG 是对前两层和受控投影的检索机制，不应成为第五份独立真相。

问“这个机制通常怎样实现”时，优先 Wiki 的模式页面并附源链接；问“当前项目哪里用了它”时，通过图与结构化索引定位；执行修改前，再读取 live snapshot。任何阶段发现 Wiki 与 native 不同，当前文件状态以 native 为准；格式解释若被独立证据推翻，则该 reader 的 semantic authority 也必须撤回，而不是机械认定 native 标签永远正确。

这点与本次 MSB P0 直接相关：修复错误 reader 后，即使文件 bytes 没变，基于旧 schema 推导的 EntityID 知识也必须过期。仅用 sourceHash 判断 Wiki freshness 不够。

### 12.4 数据布局建议

以下路径为**建议新增目录**，不是当前仓库已有事实：`.soulforge/knowledge/raw/` 存来源与快照；`wiki/entities/` 存实体概念；`wiki/mechanics/` 存机制；`wiki/formats/` 存格式与限制；`wiki/playbooks/` 存验证过的任务模式；`wiki/incidents/` 存失败案例；`wiki/index.md` 为目录；`wiki/log.md` 为维护记录；`schema.md` 规定结构与权限。

原始来源保留原文或可定位摘录及 hash、抓取时间、出处与访问范围。不要把完整游戏资产上传到公共 Wiki 仓库；本地 native facts 可保存引用、字段摘要和 provenance。Wiki 生成层可以重建，raw 原件不由维护 agent 修改。

### 12.5 用 claim 而不是整页作为最小可信单位

页面可读性重要，但 freshness 与冲突最好绑定到 claim。每条 claim 至少有 claimId、文本、类型、状态、sourceRefs、适用游戏/版本、schemaHash、依赖、review 信息和 verifiedAgainst。

建议 claim 类型区分 observed_native、derived_relation、external_documentation、tested_procedure、hypothesis。status 区分 draft、accepted、stale、contradicted、superseded、quarantined。模型回答中的猜测只能成为 hypothesis，不能因为它被写进 Wiki 就自动升级为 tested_procedure。

一个建议的页面头如下；值为示例，不是当前工作区事实：

```yaml
pageId: formats/msb-region-transform
schemaVersion: 1
scope:
  game: sekiro
  readerSchema: msbs-region-v2
status: draft
sources:
  - sourceId: independent-msbs-reader
    revision: pinned-source-revision
claims:
  - claimId: region-size-is-shape-specific
    kind: external_documentation
    status: accepted
    sourceRefs: [independent-msbs-reader]
    requiresNativeReadBeforeWrite: true
```

### 12.6 Ingest 流程：并行提取，单一整合

第一步登记来源和 hash，执行 secret/路径/内容类型检查；第二步提取候选 claims 与引用，不让模型修改原资料；第三步与已有 claim 匹配，区分补充、冲突、同义重复和版本替代；第四步生成 Wiki patch；第五步 lint 来源、链接、scope、循环依赖和过期状态；第六步提交维护事务，并刷新受影响的索引。

多个来源的提取可以并行，但同一页面/claim 的合并应由单一整合器或带版本前置条件的 patch 服务执行。否则多个 agent 都读了旧 index.md，再各自覆盖，会丢页或丢引用。不要把“多 Agent 并行”理解为所有 agent 直接改同一组 Markdown 文件。

原始故障日志里出现的模型 ID 猜测，只能作为失败轨迹，不得作为实体事实摄取。相同错误回答复制十次也不是十份独立证据。

### 12.7 Query 流程：从模式到当前证据

query planner 先识别任务需要概念知识、当前状态还是执行能力；检索相关 Wiki 页面与 claim；检查游戏、版本、schema、scope 与状态；用其建议生成 native query plan；读取当前资源并构建 evidence bundle；再进入修改提案。

旧 Wiki 中的 `rowId` 只能是候选。工具返回实际 source identity 后才可绑定目标。用户的 Mod 可能改名、复制、迁移资源，不能因为原版知识包写了某个 ID 就跳过确认。

### 12.8 Lint：哪些检查由程序，哪些由模型

程序负责：断链、缺来源、revision 不匹配、无效 URI、重复 claimId、依赖循环、引用不存在、权限越界、已撤回来源仍被使用、同一 namespace 的冲突。模型负责提出需要复核的语义矛盾、概念缺口与潜在关系；它不能凭“看起来合理”给自己的推理盖验证章。

新增来源推翻旧知识时，把旧 claim 标为 superseded，并沿 dependency graph 使派生 claim stale。未受影响页面不重写。每次只处理脏闭包，避免全 Wiki 重新总结和全量重建 embedding。

### 12.9 Wiki 的安全边界

外部文档、社区脚本、日志和网页都是数据，不是 system instruction。Wiki curator 不应拥有游戏文件写权限；游戏编辑 agent 不应通过修改 Wiki 来给自己提升授权。将高风险操作建议写入 playbook 不等于获得用户确认。

提示注入可能以“必须先运行命令修复环境”“把 API key 发给某地址”“忽略旧限制”藏在文档中。ingest 保留内容作为来源但不执行其中命令；工具只开放知识目录和审查所需读取，写入通过单独的知识 patch 服务。敏感凭据从 source 和日志中过滤；不能只靠提示词要求模型保密。

### 12.10 与现有 MemoryStore、RAG 和工具网关的关系

工具上下文已有 MemoryStore 类型、允许写记忆的开关、任务台账及知识刷新相关接口。应复用这些宿主边界并加明确职责，而不是给普通 Agent 增加一个可以任意写磁盘的 save_wiki 工具。[S31](#s31)

建议 MemoryStore 只存项目偏好、人工认可的稳定约定与会话压缩状态；Wiki 存有来源的领域知识；semantic graph 存机器可校验关系；operation journal 存不可被摘要替代的交易历史。禁止同一事实以四份可独立写入的副本同时存在。

### 12.11 成本收益与实验设计

收益判据不是 Wiki 页数或“回答更像专家”。比较同一组任务在无 Wiki、只检索 Wiki、Wiki+live verification 三种条件下的完成率、原生读取数量、重复查询率、无证据 ID 数、Token、耗时、错误写入与过期知识命中。

净收益可以写成：重复任务节省的检索/推理成本，减去 ingest、维护、冲突处理与额外验证成本。高频稳定机制更可能受益；一次性探索、大量变化的项目状态未必受益。已有 RAG 可先索引 Wiki Markdown，不必把另一个本地搜索栈作为接入前置依赖。

### 12.12 最小可行版本

先选格式限制、跨表身份、事件修改模式、历史事故四类页面；只摄取固定来源与已验证回归结果；新建只读 query 工具和受控 curator；实现 claim provenance、scope 和 stale；用既有失败案例回放。通过后再扩展大量社区文档、自动更新与多来源维护。

不要把自动学习默认设置为“Agent 每说完一段话就写记忆”。第一阶段宁可积累少量可靠知识，也不要把错误实体连接永久保存。

## 13. 性能预算与测量方案

本节数值是**建议的验收目标**，不是当前实测，也不是成熟编辑器实测。目标需在用户指定硬件、固定资产集上校准。

| 路径 | 首要指标 | 建议目标/判据 | 不接受的替代证明 |
|---|---|---|---|
| 工作区打开 | catalog-ready、可交互时间、读取字节 | 首屏阶段不做非必要全文 SHA；持续可取消 | 只测空目录 |
| PARAM 首屏 | source parse 次数、IPC 字节、首行可见时间 | 首屏不含未访问行 payload；热选行 p95 争取低于 100 ms | 仅 DOM 虚拟化测试 |
| 大事件/脚本 | 首屏、编辑回显、局部分析延迟 | 编辑不触发整文件重复解析；可用增量语言服务 | 只测几行文本 |
| 地图载入 | first-useful-geometry、输入延迟、decode 次数、峰值内存 | 渐进出图且可交互；上传有帧预算 | 全部载完后拍一张图 |
| 地图操作 | 拾取/Gizmo 延迟、frame time | 目标硬件上争取 60 FPS；超预算时保持输入响应 | 仅报告对象总数 |
| Agent | goal 完成率、工具数、重复率、时间与 Token | 相同语料下无退化；减少无信息查询与重复读 | 只看 done 字样或平均步数 |
| RAG | p50/p95 延迟、范围违规率、召回、stale 率 | 范围违规率为 0；复杂度随规模有可解释增长 | 只看某条查询命中 |
| 写入 | staging/encode/rebuild/commit/verify 分段耗时 | 一次 ChangeSet 对同 outer 尽量只重建一次 | 省略独立验证以变快 |
| 回滚 | 权威恢复、UI presented、重启一致性 | 精确 target；冲突零覆盖；UI 不需手工刷新 | 工具无异常就算通过 |

采样区分 cold process、cold cache、warm cache、同文件不同 viewport、工作区切换。记录 CPU/GPU、内存、存储、游戏版本、资产 hash、build SHA、reader/schema hash、模型/provider 配置。p95 至少基于足够重复样本，不能用一次最好结果代表体验。

耗时模型建议拆成：文件 I/O + 解压 + 原生解析 + 语义投影 + 序列化 + IPC + 反序列化 + React 更新 + GPU 上传 + 帧绘制。模型工作再拆为 queue、provider latency、prompt tokens、output tokens、工具延迟与验证延迟。优化前后对比保持同一任务和缓存条件。

## 14. 测试体系：让测试证明产品，而不是证明测试代码存在

### 14.1 必须保留并审计现有 runner

根 package.json 已提供 typecheck、bridge:build、verify、verify:all、verify:audit，以及各格式和 Agent/RAG 专项入口。应复用它们；本报告没有执行这些命令，也没有读完它们的所有依赖，不能把“入口存在”当作测试已通过。[S02](#s02)

建议先运行 `npm run verify:list` 与 `npm run verify:audit` 检查实际收录范围，再运行构建和门禁。缺游戏 fixture、缺 Oodle、找不到 Bridge、未连接模型，不应被关键生产验收标成成功。正常不支持的格式与缺测试资源要使用不同状态。

### 14.2 独立性比数量重要

MSB 反例证明：reader 与 writer 使用同一错误偏移，自身 roundtrip 可以稳定通过。新增测试必须包含独立实现或人工确认的布局/字节 oracle，而不只通过同一 reader 对比同一字段。

测试至少分：纯算法；格式字节；独立 reader 差分；事务故障注入；真实 Electron 入口；游戏运行。某一级不能替代下一级。游戏验证无法自动覆盖全部语义时，保留明确的“未验证”，不要降低后置条件掩饰。

### 14.3 四条原有关键验收场景

**PARAM：**打开指定大表，trace 证明首屏仅元数据及可见 payload；编辑字段；native 重读；关闭重开；确认旧 loadAll 路径没有被隐式调用。

**地图：**打开真实 m10_00_00_00，证明 MSB→资源定位→container→FLVER→mesh→GPU；不是点云或盒子。MSB EntityID 与 Region shape 修复需独立 reader 验证；编辑后重开。

**动作：**打开 c0000，关闭动画时有静态身体；然后验证 bind pose、蒙皮、动画。不能把 skeleton 非零而 mesh=0 当作预览成功。记录真实资产 counts，不将历史某个固定数当所有 Mod 的必然值。

**回滚：**Msg/ItemName/1000 从 A 改为测试文本 B，提交后从权威层读 B，按 transactionId 回滚，再读 A，UI 呈现 A。trace 不得出现错误的 Goods/1000 目标。重启后再跑，验证 journal 可恢复。

### 14.4 扩展回归矩阵

| 编号 | 用例 | 必须证明的结果 |
|---|---|---|
| T01 | Part EntityID 改写 | 真实 EntityID 改变，头部 internal ID 不变 |
| T02 | Region EntityID 改写 | baseData3 中目标值改变，其他字段不变 |
| T03 | Region 通用 scale | 受限接口拒绝，两个数据指针逐字节不变 |
| T04 | Region shape 尺寸 | 已支持类型正确写入；未知类型拒绝 |
| T05 | 删除第一个 Part | 所有保留引用仍指向原对象或明确冲突 |
| T06 | 删除被引用对象 | 不产生静默悬空引用 |
| T07 | 批量目标部分不存在 | 默认整笔失败，磁盘零变化 |
| T08 | 地图同名对象 | canonical handle 精确区分 |
| T09 | 组合查询 modelName+entityId | 求交集或拒绝，不忽略条件 |
| T10 | Blender 旧 revision | conflict，磁盘零变化 |
| T11 | Blender 别的 workspace | 拒绝，即便 mapId/hash 相同 |
| T12 | Blender create/duplicate | 未支持能力明确拒绝 |
| T13 | PARAM 重复 ID | 指定物理身份；id-only 歧义写拒绝 |
| T14 | PARAM 物理行删除失效注入 | verifier 必须失败 |
| T15 | PARAM 删除后再改后续行 | 原快照身份未漂移 |
| T16 | PARAM 同行两次更新 | 模拟最终状态；或写前明确拒绝 |
| T17 | PARAM 只改名称 | 名称和编码后置条件通过 |
| T18 | PARAM 未触及字节 | 合理范围外保持或经 schema 证明重建等价 |
| T19 | FMG 同 ID 不同语言/表 | 只修改指定目标 |
| T20 | FMG null/空串/Unicode | 不混淆，不做静默替换 |
| T21 | FMG 同 outer 多表编辑 | 单一提交且 sibling 不丢失 |
| T22 | EMEVD 插入/删除组合 | 指令、参数绑定、字符串与调用关系正确 |
| T23 | EMEVD 重命名链 | 解析到最终事件并保留引用一致性 |
| T24 | 大事件分页 | 可取得完整必需代码，不用摘要猜逻辑 |
| T25 | Lua 混合编码 | 非编辑区字节不变；非法修改拒绝 |
| T26 | Lua bytecode→source | 仅已验证 profile 允许，游戏加载验证 |
| T27 | TAE 共享时间槽 | 不误改 sibling，跨动画别名有覆盖 |
| T28 | TAE 插入模板 | 参数体、事件组和总数符合 profile |
| T29 | TAE 批量编辑内存 | 不随操作数保留整文件副本 |
| T30 | FLVER strip/restart/索引位宽 | 独立几何与拓扑一致 |
| T31 | FLVER rigid/weighted/mixed | 静态与参考姿态一致 |
| T32 | 畸形骨骼/权重 | 返回错误，无 NaN/Infinity GPU 数据 |
| T33 | 地图重复模型 | 源解析/投影次数符合设计；不重复整容器工作 |
| T34 | 工作区切换/关闭 tab | 旧异步结果不回灌，资源被释放 |
| T35 | 超大 NDJSON 无换行帧 | 在预算内拒绝，内存有界 |
| T36 | Bridge 排队超限 | backpressure，不无限累积 |
| T37 | 路径越界/符号链接 | 读写边界均拒绝；不依赖 UI |
| T38 | 多 outer 第 N 文件失败 | 恢复或明确 recovery_required，不能假原子成功 |
| T39 | 提交后校验失败 | 状态诚实；补偿与日志一致 |
| T40 | A→B→C 回滚第一笔 | conflict，不覆盖 C |
| T41 | 崩溃在 replace/journal 窗口 | 重启后可判定并恢复 |
| T42 | 同一 mutation 重试 | 不重复创建/应用 |
| T43 | RAG family 过滤 | 词法、向量、扩展都遵守规定 |
| T44 | RAG primary 满额再扩展 | 返回不超过 finalLimit |
| T45 | 第 17 条新证据 | 能按任务相关性进入上下文 |
| T46 | Broker 同 ID 不同资源 | 不合并成同一事实 |
| T47 | Broker 中文预算 | 字节和 token 单位对应实际计算 |
| T48 | 连续空搜索 | coverage 明确，不推断“对象不存在” |
| T49 | 并行工具一个抛错 | 其他结果与轨迹仍可结算 |
| T50 | 一个慢工具 | UI 可见独立完成状态，无不必要整批沉默 |
| T51 | 停止时正在提交 | 状态与实际磁盘结果一致 |
| T52 | Agent 无 mutation 宣称完成 | completion contract 拒绝 success |
| T53 | 用户确认旧计划 | 计划变化导致重新授权 |
| T54 | Wiki 过期 source/schema | 禁用写依据，标 stale 并重查 |
| T55 | Wiki 多来源重复错误 | 不当独立证据累加 |
| T56 | Wiki 并发写同页 | 无丢更新，冲突可追踪 |
| T57 | Wiki 提示注入 | 不执行文档命令，不提升权限 |
| T58 | Wiki native 值冲突 | 当前读取优先；schema 冲突独立复核 |
| T59 | 发布包缺 Bridge/模板 | 关键验收失败，不静默降级 |
| T60 | 反馈日志含 secret | secret 被移除，诊断身份与版本信息保留 |

### 14.5 本次反例脚本的结果

`audit_probes.py` 执行完成，10 个预期反例均被展示：EntityID 错位、Region 指针污染、删除后的索引引用漂移、RAG limit+1、向量 family 漏滤、第 17 条证据遗漏、中文 byte budget 错位、地图批量选择部分成功、PARAM 最终态与中间态比较、物理行删除验证空缺。

这些探针是手工转写的最小模型，不加载仓库模块，不启动 C#，不使用游戏数据。`counterexample_demonstrated=true` 的含义是反例成立，不是软件测试通过。输出文件明确标记这一边界，避免以后被自动汇总工具误算成产品通过率。

## 15. 实施顺序与职责划分

### 15.1 第一批：阻断错误写入

修复 F01/F02，并在 Bridge、Core、schema、Blender delta 和 Agent 能力广告中同步限制危险操作。为 F03 删除引用问题添加门禁。引入独立 MSBS reader 对照，不准只增加同源 roundtrip。修复后升级 schema revision，刷新派生知识。

这批不做大规模 UI 重构、不迁移数据库、不引入新向量引擎。前端只接受必要的 capability 展示与禁用状态改动。

### 15.2 第二批：统一最终状态验证

PARAM 物理删除与批次最终状态；地图目标集完整性；高层提交后验证失败与 recovery 状态；同 outer 多 child 事务锁；精确回滚和幂等。产出 operation-level postconditions，作为 Agent completion 的输入。

### 15.3 第三批：砍掉确定性的重复成本

地图 typed-buffer API、per-resource single-flight、byte-budget LRU；减少地图高层重复读；TAE 区间日志；RAG adjacency 与 top-k；Broker 选择与单位修正。每项给出前后同场景 trace，不能靠新增缓存类的数量证明收益。

### 15.4 第四批：Agent 与知识层

用目标状态与效果调度替代松散调用；统一 coverage 与 evidence identity；校验 prompt/manifest/工具 schema；对故障语料回放。Wiki 从受控只读查询和 curator 开始，先建立 provenance/stale/contradiction，再扩量。

### 15.5 第五批：3D 扩展与功能完备性

在 L0 真实往返通过后扩展 FLVER profile、共享资产隔离、Blender adapter。碰撞/导航单列研究与验收，不被视觉编辑功能自动解锁。其余未深入审查模块按第 2 节能力矩阵补完，而不是把本报告当作它们已经安全的证明。

### 15.6 人与 Agent 的职责

**推理/架构负责人：**决定物理语义、事务不变量、身份系统、证据和冲突规则、3D 数学合同、Wiki 权威层次。不能交给弱编码 agent 临场猜。

**Codex 等施工执行者：**按已确定文件、函数、字段偏移、拒绝条件与测试输出完成小改动；复用既有 runner；交付 diff 和证据。禁止用新增 fallback、硬编码案例答案或弱化断言换测试绿。

**前端 agent：**消费正确 DTO，完成虚拟化、实例化、交互状态和错误呈现，提供真实 renderer trace。不得修补 native 错误坐标/索引来“把图画正常”。

### 15.7 三份确定性施工单示例

**施工单 A：MSB EntityID。**打开 `MsbNativeDocument.cs` 的读取与 `ApplyMutations`；分离 internalEntryId/entityId；按 Sekiro MSBS Part entityData 与 Region baseData3 定位字段；保留所有边界检查；禁止再写 +0x0C 来修改 EntityID；调整 DTO 和引用索引；在 `MsbNativeWriter.cs` 增加独立 oracle 测试。输入使用内部 ID 与真正 EntityID 不同的 fixture，否则测试没有判别力。验收 T01/T02，同时证明 unrelated bytes 保留。

**施工单 B：RAG。**打开 `hybridRetrieve.ts` 和 `retrieve.ts`；由一个规范化过滤器处理全部候选；扩展前计算剩余额度；finalLimit 为硬上限；引用跨 family 的语义由选项明确。复用 `test:rag`；测试必须构造“词法无越界结果、向量有高分越界结果”和“primary 已满、有可扩展邻居”，否则无法证明补丁生效。

**施工单 C：地图服务。**打开 `mapService.ts` 的 batchTransform 与 query；无效目标不得 continue 后返回普通成功；明确组合筛选语义；事务返回 verified post-state；外层不再为 afterList 重读完整文档。复用地图事务测试入口；验收一个有效一个无效目标时磁盘未变、两条件查询不吞条件、真实 UI 路径读取次数下降。不能用 mock 出一个“读了一次”的计数器替代真实 trace。

## 16. 最终判断

SoulForge 的发展方向成立，现有基础也不应被低估。但当前版本不能凭 native writer、自身重读与一组入口测试就被认定为成熟编辑器的完整替代。MSB 的两处格式语义错误已经足以要求先收紧写能力；Agent 与 Wiki 的可靠性必须建立在这些基础修复之上。

最有价值的下一步不是继续堆功能名称，而是把“用户目标→准确资源→正确格式语义→统一事务→独立验证→用户看到的结果”连成同一条证据链。性能优化围绕减少重做与搬运展开，3D 扩展围绕操作能力分级展开，Wiki 围绕来源、适用范围和失效机制展开。

**本报告交付的是有源码依据的缺陷定位、抽取反例、实现设计与验收方案。尚未完成的实机、全格式及全前端验收已明确列出，没有被合并进“正常”结论。**

## 附录 A. 源码与外部依据

下列 S 编号均固定到本次提交。链接行区间是定位窗口，部分较长响应存在截断，已在相关说明中保留覆盖边界。X01/X02 链接为外部当前分支，另记录读取时 blob SHA，便于固定独立格式依据。X03–X07 是外部官方资料；其版本与能力应在实际接入时再次固定。


<a id="s01"></a>

### S01 · README.md

项目声明与范围。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/README.md#L1-L200)

<a id="s02"></a>

### S02 · package.json

版本与已有验收入口。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/package.json#L1-L150)

<a id="s03"></a>

### S03 · bridge/SoulForge.Bridge/MsbNativeDocument.cs

MSB 布局声明与读取入口。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/MsbNativeDocument.cs#L1-L190)

<a id="s04"></a>

### S04 · bridge/SoulForge.Bridge/MsbNativeDocument.cs

MSB mutation、EntityID、Region scale、删除算法。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/MsbNativeDocument.cs#L330-L580)

<a id="s05"></a>

### S05 · bridge/SoulForge.Bridge/MsbNativeWriter.cs

MSB 写回与自身重读验证。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/MsbNativeWriter.cs#L1-L250)

<a id="s06"></a>

### S06 · packages/core/src/editing/mapService.ts

地图加载与查询。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/editing/mapService.ts#L1-L255)

<a id="s07"></a>

### S07 · packages/core/src/editing/mapService.ts

批量变换与事务前置校验。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/editing/mapService.ts#L255-L450)

<a id="s08"></a>

### S08 · packages/core/src/editing/mapService.ts

地图事务写入、提交后验证。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/editing/mapService.ts#L500-L775)

<a id="s09"></a>

### S09 · packages/shared/src/map-document.ts

Blender delta 导入与 canonical 地图实体。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/shared/src/map-document.ts#L650-L885)

<a id="s10"></a>

### S10 · bridge/SoulForge.Bridge/MapStaticGeometryService.cs

地图分块服务的实际分配与锁。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/MapStaticGeometryService.cs#L1-L260)

<a id="s11"></a>

### S11 · bridge/SoulForge.Bridge/FlverMatureSkinning.cs

NormalW、palette、FK 与蒙皮。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/FlverMatureSkinning.cs#L1-L300)

<a id="s12"></a>

### S12 · bridge/SoulForge.Bridge/BridgeDaemonHost.cs

NDJSON、握手与并发。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/BridgeDaemonHost.cs#L1-L230)

<a id="s13"></a>

### S13 · bridge/SoulForge.Bridge/BridgeDaemonHost.cs

写命令注册表、路径边界、deadline。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/BridgeDaemonHost.cs#L245-L435)

<a id="s14"></a>

### S14 · packages/core/src/transactions/workspaceTransaction.ts

事务状态与 staging。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/transactions/workspaceTransaction.ts#L1-L260)

<a id="s15"></a>

### S15 · packages/core/src/transactions/workspaceTransaction.ts

多文件提交、恢复点与校验。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/transactions/workspaceTransaction.ts#L390-L665)

<a id="s16"></a>

### S16 · packages/core/src/patch/durablePatchCommit.ts

持久日志与提交前恢复信息。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/patch/durablePatchCommit.ts#L1-L235)

<a id="s17"></a>

### S17 · bridge/SoulForge.Bridge/ParamNativeWriter.cs

PARAM 写入与验证。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/ParamNativeWriter.cs#L1-L150)

<a id="s18"></a>

### S18 · bridge/SoulForge.Bridge/ParamNativeDocument.cs

PARAM 重建、编码、变长列表修改。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/ParamNativeDocument.cs#L320-L580)

<a id="s19"></a>

### S19 · bridge/SoulForge.Bridge/TaeNativeWriter.cs

TAE 支持范围、整文件快照。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/TaeNativeWriter.cs#L1-L265)

<a id="s20"></a>

### S20 · bridge/SoulForge.Bridge/FmgNativeWriter.cs

FMG 编码、容器写回、sibling 保留。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/FmgNativeWriter.cs#L1-L145)

<a id="s21"></a>

### S21 · bridge/SoulForge.Bridge/EmevdNativeWriter.cs

EMEVD outer/payload 写回与验证。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/bridge/SoulForge.Bridge/EmevdNativeWriter.cs#L1-L195)

<a id="s22"></a>

### S22 · packages/core/src/script/scriptSourceWriteback.ts

脚本编码与 Lua 字节码转明文。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/script/scriptSourceWriteback.ts#L1-L230)

<a id="s23"></a>

### S23 · packages/core/src/model-services/agentLoop.ts

Agent 预算与进展工具分类。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/model-services/agentLoop.ts#L1-L230)

<a id="s24"></a>

### S24 · packages/core/src/model-services/agentLoop.ts

Agent 步数上限与固定 RAG 查询。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/model-services/agentLoop.ts#L500-L750)

<a id="s25"></a>

### S25 · packages/core/src/model-services/agentLoop.ts

Agent Promise.all 并行批次。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/model-services/agentLoop.ts#L1350-L1580)

<a id="s26"></a>

### S26 · packages/core/src/model-services/contextBroker.ts

Broker 身份与预算。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/model-services/contextBroker.ts#L1-L270)

<a id="s27"></a>

### S27 · packages/core/src/model-services/contextBroker.ts

Broker 去重、顺序与证据装配。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/model-services/contextBroker.ts#L330-L620)

<a id="s28"></a>

### S28 · packages/core/src/rag/hybridRetrieve.ts

向量与词法融合。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/rag/hybridRetrieve.ts#L1-L170)

<a id="s29"></a>

### S29 · packages/core/src/rag/retrieve.ts

词法分数与引用扩展。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/rag/retrieve.ts#L1-L285)

<a id="s30"></a>

### S30 · packages/core/src/ai/agentToolBridge.ts

工具 envelope、权限分类与摘要。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/ai/agentToolBridge.ts#L1-L215)

<a id="s31"></a>

### S31 · packages/core/src/ai/toolRegistry.ts

工具到编辑服务、任务台账契约。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/ai/toolRegistry.ts#L1-L180)

<a id="s32"></a>

### S32 · prompt/system.md

已读取的 system prompt 主体；长响应截断，不作全文件覆盖声明。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/prompt/system.md#L1-L150)

<a id="s33"></a>

### S33 · packages/core/src/workspace/scanWorkspace.ts

工作区扫描与可选 SHA。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/core/src/workspace/scanWorkspace.ts#L1-L270)

<a id="s34"></a>

### S34 · packages/shared/src/index.ts

共享协议与模块出口。 [打开依据](https://github.com/3516027002att-ui/SoulForge/blob/f9cb0cd76a11bfa2857b48acbc779bfac0355d96/packages/shared/src/index.ts#L1-L160)

<a id="x01"></a>

### X01 · MSBS Part 的独立布局证据；读取时 blob 175e0dcbe1ec9385cef4bae45437e8d7fbe4ea1e

MSBS Part 的独立布局证据；读取时 blob 175e0dcbe1ec9385cef4bae45437e8d7fbe4ea1e。 [打开依据](https://github.com/JKAnderson/SoulsFormats/blob/master/SoulsFormats/Formats/MSB/MSBS/PartsParam.cs#L330-L585)

<a id="x02"></a>

### X02 · MSBS Region 的独立布局证据；读取时 blob c13eacf67560381fd450fa82f6fed95e396fdd29

MSBS Region 的独立布局证据；读取时 blob c13eacf67560381fd450fa82f6fed95e396fdd29。 [打开依据](https://github.com/JKAnderson/SoulsFormats/blob/master/SoulsFormats/Formats/MSB/MSBS/PointParam.cs#L330-L570)

<a id="x03"></a>

### X03 · 成熟编辑器官方能力说明

成熟编辑器官方能力说明。 [打开依据](https://github.com/vawser/Smithbox)

<a id="x04"></a>

### X04 · 成熟动作编辑器官方能力说明

成熟动作编辑器官方能力说明。 [打开依据](https://github.com/Meowmaritus/DSAnimStudio)

<a id="x05"></a>

### X05 · Blender 插件官方游戏/格式支持矩阵

Blender 插件官方游戏/格式支持矩阵。 [打开依据](https://github.com/Grimrukh/soulstruct-blender)

<a id="x06"></a>

### X06 · Blender 官方线程限制

Blender 官方线程限制。 [打开依据](https://docs.blender.org/api/main/info_gotchas_threading.html)

<a id="x07"></a>

### X07 · Karpathy LLM Wiki 原始想法文件；创建于 2026-04-04

Karpathy LLM Wiki 原始想法文件；创建于 2026-04-04。 [打开依据](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

<a id="s35"></a>

### S35 · Renderer 目录元数据

renderer 目录元数据；App.tsx 的记录大小为 215779 bytes，不等于已逐行审计。 [打开依据](https://api.github.com/repos/3516027002att-ui/SoulForge/git/trees/7092856dc63d647c27f541a533d8152fc6a8d632?recursive=1)

## 附录 B. 文件说明与复现

`source_manifest.json` 保存审查来源；`audit_probes.py` 是抽取逻辑反例；`probe_results.json` 是本次实际执行结果；`findings.json` 是问题清单。报告没有附带游戏资产，也没有修改 GitHub 仓库。

运行抽取反例的命令为：

```bash
python audit_probes.py
```

它只使用 Python 标准库。预期输出是 10 个反例被展示，且 repository_tests_executed、game_runtime_tested 均为 false。该命令不能替代 SoulForge 的 npm/.NET/原生语料/UI 验收。

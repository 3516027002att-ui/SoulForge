# 5. RAG、证据、Resolver、Agent 调度与提示词

本章对应F17～F22、T43～T53。已有200步硬上限、固定taskQuery与RAG缓存保留。本方案不是恢复旧版“每轮搜最后一句user”、扩大步数或硬编码鬼刑部答案。

## SF-18：统一过滤、top-k、RRF与引用邻接表

**入口。** `packages/core/src/rag/hybridRetrieve.ts`、`retrieve.ts`、`lookupIndex.ts`、`queryParse.ts`、`persist.ts`，以及当前embedding client。新增 `rag/retrievalScope.ts`、`rag/topK.ts`。复用 `test:rag` 与 `runRagEmbeddingSmoke.ts`，新增 `runAuditRagScopeSmoke.ts`。

### 5.1.1 唯一过滤器

`NormalizedRetrievalScope`包含workspaceId、允许family集合、资源范围、game/profile、language（如适用）、当前版本兼容策略和stale策略。一次规范化，词法/向量/精确索引/引用扩展共同使用。workspaceId从宿主注入，不信任模型输入。模型可以收窄family与资源范围，不能扩出当前会话授权范围。

本方案决定：families省略表示当前授权family；显式空数组或包含未知family返回INVALID_INPUT，不把它们当“所有family”。内部代码同样不接受无效filter。跨family引用只有仍处于用户显式授权的检索scope内才可作为命中；范围之外可以返回“存在外部关联”的opaque提示，不带越界内容，不混进results。

向量遍历前过滤chunk，融合前后再执行同一个谓词作为不变量检查。越界结果不是分数低一点的问题，必须不出现。corpus/embedding模型版本、维度和归一化profile不匹配则禁用该向量源并报告diagnostic，保留合法词法结果；不能把不同模型向量的cosine当相似度。

### 5.1.2 精确检索与候选预算

精确URI、完整对象handle、明确ID+namespace、字段ID走确定性索引。完整数字ID匹配与前缀匹配分开标记；“5080”与“50800000”不能都是exact。精确候选在其授权范围内保留优先级，但多个同ID不同资源仍是歧义，不选最高相似度替用户决定。

`finalLimit`默认8，范围1..32；`candidateLimit`固定为min(256,max(64,4*finalLimit))。词法与向量各取candidateLimit，再融合，不能先各取finalLimit就丢失潜在交集。exact候选多于finalLimit时返回ambiguity+可续读cursor，而不是静默丢掉后面的精确对象。

### 5.1.3 top-k heap

相似度扫描仍为O(Nd)，不引入ANN或新向量数据库。维护容量K的“最差元素在堆顶”的heap：新元素比根更好则替换根并下沉；未满时插入并上浮；遍历结束对heap做一次最终排序。总排序开销O(N log K)，额外存储O(K)。分数相同按稳定chunkId的代码点顺序比较，避免不同机器locale导致不稳定结果。

cosine要求向量维度相同、每分量有限、范数非零；数值溢出或无效结果返回diagnostic，不让NaN进入sort。原已归一化向量能否用dot替cosine由embedding存储profile决定，未经验证不改相似度定义。

### 5.1.4 RRF和扩展

RRF常量60保留，分数为各排名列表的Σ1/(60+rank+1)。每个列表先去重，单源重复chunk不能累加分数。过滤必须在排名列表构建前应用；没有词法命中但有合法向量命中仍允许hybrid结果。

精确候选占据确定位置；剩余由RRF排序。引用扩展建立 `symbolUri→edges[]` 邻接表，按corpus版本缓存。增量资源刷新时只替换受影响边集合，不每个hit遍历全部references。引用置信度影响排序但不改变权限或native authority。

本方案扩展预算：finalLimit≤3时不预留扩展；其他情况最多预留min(2,floor(finalLimit/4))。保留全部能容纳的exact候选；先取primary，扩展一跳合法邻居；若没有足够邻居，再用下一批primary填满。每次push之前检查剩余容量；最后断言result.length≤finalLimit。不得出现limit+1，也不能为扩展挤掉明确的唯一exact对象。

### 5.1.5 缓存与freshness

检索缓存键为task/subgoalQuery规范化文本、scope、corpusRevision、reader/metadata schema、embedding model和检索参数。原固定taskQuery缓存继续保留，但ResourceRevisionChanged或schema变更必须失效对应缓存。不能每轮重新embed同一句话，也不能整个run永久使用过期候选。

**验收。** 向量rank1是map、用户scope是param，结果中绝无map；词法miss向量合法hit仍出现；显式空family拒绝；primary满额且有邻居不超limit；同chunk重复来源不刷分；邻接扩展不跨scope；heap与全量sort在随机与并列分数数据上完全一致；维度/模型错配不混算；源变更后旧检索结果不作为新写依据。

## SF-19：证据身份、版本选择与真实预算

**入口。** `model-services/contextBroker.ts`、`agentLoop.ts`中的证据队列；`ai/agentToolBridge.ts`的envelope构造；shared证据协议。新增 `model-services/evidenceIdentity.ts` 和 `evidenceSelection.ts`。参考实现见 `reference/evidence.mjs`。

### 5.2.1 不再扫描所有数字拼对象身份

证据键固定编码结构：workspaceId、canonicalOuterId、childChain、domain、namespace、objectHandle、claimKind/propertyKey。它由native adapter或已校验source adapter创建。源内容里“提到的ID”、数组中多个对象ID、搜索ticket、时间戳不参与对象身份。

一个结果包含16个对象时拆成16个或更多typed claims，不能把全部stableIds排序后当一个巨大对象。同一个PARAM行的两个字段是两个claim；“对象存在”和“字段值为2”也不同。完整result原文仍存rollout，不用拆claim破坏审计证据。

identity不统一lowercase。Windows路径canonical化由现有path boundary负责；区分大小写的native名、URI域、namespace和用户内容保持原值。rev/version不混成文本ID；sourceHash字符串不能通过字典序判断新旧。

### 5.2.2 快照与去重

第一道筛选是当前版本有效性：宿主CurrentVersionMap决定某资源哪份版本是当前（键至少含workspace、outer、完整childChain及格式namespace；不能只用outer，否则同包两张表的payload/schema版本会互相覆盖），readerSchema被撤销时native-verified标签也失效。过期native证据不能压过新候选并继续授权写入。

同ClaimKey、同有效版本：native事实优先于candidate；同等级根据宿主观测序号选后者；内容冲突不能简单选择“看起来更可信”，要记录conflict并要求重读。跨snapshot的nativeOffset/rowIndex没有永久身份保证；没有已验证lineage映射时撤销旧snapshot claims，创建新handle，不按相同offset合并为同一长期对象。

### 5.2.3 相关性选择

每条claim具有goalRefs、dependencyRole、authorityClass、versionState、observationSequence、required标记。required由当前已确认计划及验证依赖计算，模型不能将所有资料都标required。required属于ClaimKey对应的任务依赖，不属于某个搜索结果：candidate被native证据替换后，required标记必须保留，不能因新record未带该字段而丢失。

排序优先级固定为：required；当前subgoal直接依赖；同目标候选；领域背景；其后authority和recency；最后稳定ID打破并列。先剔除stale/revoked/out-of-scope，再排序。不要简单反转队列，让最新无关结果挤掉关键基线。

队列设置总容量（初值512个active claims），required不允许丢弃；超过容量将非required冷证据移到已有持久证据/rollout索引，保留handle。不能每轮在messages中重复追加全部证据快照；每个context window保留一个当前动态snapshot，原始tool messages仍按协议与compaction处理。

### 5.2.4 bytes、characters和tokens分开

`maxBytes`用最终UTF-8序列化字节计数，包含标题、identity、版本、截断标志与JSON标点；不能只加正文.length。`maxEntries`独立计数。字符摘要长度只是展示限制。

token预算由现有adapter/compactor计数机制负责，并标明精确tokenizer或estimatedTokens。没有对应provider tokenizer时不宣称“字节数等于token数”；预留工具schema、system、历史、输出reserve与provider封装开销。测试必须区分actualWireBytes与estimatedTokens。

required证据集合本身超过预算时返回 `REQUIRED_EVIDENCE_EXCEEDS_BUDGET`，触发分解子目标/原生范围读取，不静默丢弃半个前置条件。optional证据可裁剪摘要，返回omitted/missingFields/cursor；JSON保持完整。待写入的完整脚本/事件不能从裁剪摘要中重建。

### 5.2.5 防注入与验证

社区文档、Wiki与脚本注释作为tool/evidence数据，不作为system指令追加。模型读到“忽略规则”“切full权限”不改变宿主policy。将动态证据与稳定system prefix分离，避免每个新事实都改写策略前缀并破坏cache稳定性。

测试第17条相关新证据进入装配；16条旧无关证据被挤出但required保留；同ID不同outer/child/language/domain不合并；same hash不同schema过期；中文/emoji在真实JSONbytes预算内；身份过长不截断；旧native不能压过有效版本；结果数组拆claim；反复同证据不增大active queue；required过预算产生明确阻塞。

## SF-20：coverage、实体Resolver与有界检索计划

**范围。** `indexing/workspaceIndex.ts`、`references/referenceBuilder.ts`、`references/chrLinkageResolver.ts`、`indexing/nativeSemanticRefresh.ts`、`indexing/knowledgeRefresh.ts`、工具registry的discovery输出。新增 `ai/entityResolution.ts`，只编排既有索引与native读取，不编造Boss ID字典。

### 5.3.1 coverage不是一个布尔值

每个查询输出status和scope：complete、partial、not_indexed、parse_failed、stale、source_unavailable；coveredResources、expectedResources（已知时）、sourceVersions、predicateCompleteness。无法知道全集大小时expectedResources=null，不写100%。

只有确定性predicate（精确ID/字段/完整范围过滤）在完整覆盖下的未命中，才产生`NOT_FOUND_WITH_COMPLETE_COVERAGE`。即使全文索引完整，模糊中文关键词/向量查询没有命中也不能证明实体不存在；那只是当前召回方法没有找到。不得让“完整corpus”掩盖检索算法的非穷尽性。

### 5.3.2 Resolver输入与输出

输入为用户对象称呼或已给出的native handle、当前workspace、目标domain、所需关系。输出为候选集、每条identity链、已验证/待验证边、coverage、blockedReasons和nextReadPlan。

精确handle路线：验证scope/version→读取必需字段→输出verified facts，不强制先读Memory再搜FMG。模糊名称路线：在宿主memory可读时读取相关线索；FMG与PARAM备注召回并行；按正式名/源关系形成候选；原生读取确认；沿已有reference graph追踪到目标资源。机制路线：查Wiki/事件参考，再用EMEDF/native事件确认。未知文件路线：查capability与coverage，不假设可写。

### 5.3.3 关系验证算法

每条关系必须注明ruleId、sourceProperty、targetNamespace、sourceSnapshot和目标确认。例：FMG textId与Goods rowId只有在已登记的实际字段/引用规则支持时才连边；不能因数字相同或模型记忆而join。

候选传播使用BFS/优先队列，深度初限4，单子目标最多64个候选和128条边；这些是防爆预算，不是“超过就不存在”。边按确定性、置信度和与当前目标的关联排序。遇到未知引用字段先补metadata/native读取，不能填一条假边继续。

Resolver计算每步进展：目标候选被排除；原生字段补齐；缺失关系获证；coverage从不可用到完整；后置条件通过。仅新增一个不相关ID、换query词、刷新ticket不计进展。连续2次无进展触发换查询路由；某子目标最多2次改路由；预算耗尽后返回blocked及已尝试路径，不要求模型猜第65个ID。全run仍保留200步硬上限。

如果用户提出的关系没有已登记规则，输出“关系未验证”，不是不存在。可以用模型提出候选解释，但这种解释保持hypothesis，不进入写入target或Wiki已验证知识。

### 5.3.4 原生刷新一致性

native read成功后，语义投影、reference graph、RAG缓存都按同一资源版本更新。投影刷新事件可以合并同事务多个字段变化，避免全库rebuild。旧revision的异步index job晚到时拒绝发布。必须携带readerSchema/metadata版本；F01修复后即使bytes不变，也触发相关投影失效。

**测试。** 原报告的鬼刑部与自制物品只作为回归样本之一，不硬编码答案；同名多地图、错别字、精确handle、FMG/PARAM同数字、CommonEvent联动、空索引、部分索引、过期索引、模糊查询零命中、未声明关系、原生读后立即检索、旧刷新晚到。检查trace里不存在无证据ID进入mutation。

## SF-21：工具调度、独立结算与取消

**入口。** `model-services/agentLoop.ts` 当前planned/batchIndices/Promise.all阶段；`ai/agentToolBridge.ts`的supportsParallel生成；`model-services/types.ts`；宿主tool context。新增 `model-services/toolScheduler.ts`。不新建第二个Agent loop。

### 5.4.1 效果描述

每个工具注册effectResolver，根据已校验参数与host生成R/W集合、costClass、deadline、cancelMode、idempotency/transaction关系。未登记effect的工具按exclusive处理，不默认parallel。read/analyze名称只是广告，不是并行安全证明。

native读取与派生索引合并分开：昂贵读可并行；投影写通过按resource+revision序列化的ingest端口合并，过期写丢弃。台账更新是共享状态写，使用SF-22批量CAS，不被read标签放行。

### 5.4.2 调度DAG

同一model turn的tool calls保留原序号。根据显式dependsOn和资源冲突建立有向边：前一个调用的W与后一个R/W相交，或前一个R与后一个W相交，则加前→后排序边。所有边在开始前检查环；有环时整批不执行副作用。不同outer、不同派生资源且无依赖的任务可并行。

全局工具并发初值4，Bridge CPU解码2，远端检索4，外部Blender进程1；实际受各资源池最小可用槽限制。每turn最多32个tool calls。超过上限在执行任何工具前拒绝这份模型工具批次，记录provider response诊断，不把前32个执行后悄悄丢掉其余；未接受的超限消息不得作为一份缺tool results的正常历史继续给provider。

### 5.4.3 结算算法

每个job包装sync throw和async reject，统一转为脱敏ToolResult；返回`ok:false`必须保留false，不能再包一层`{ok:true,value:result}`。task结束时立即发tool-call-end和耗时，写自己的result槽；UI不必等慢兄弟任务。

模型下一次采样前，按原tool emission顺序写tool result消息，以满足现有provider协议与回放一致性。独立UI反馈不意味着同一session并发发多个模型续请求。run结束前flush已有rollout。

显式数据依赖失败则消费者返回DEPENDENCY_FAILED。纯排序边前项失败不自动阻止不依赖其数据的合法读取，但后项写入仍必须通过原生precondition和权限；不能凭scheduler允许就跳过校验。

onEvent/日志sink异常不能丢失已发生工具结果。捕获observer异常、登记诊断、尝试持久记录；真正无法记录写入结果时升级审计/恢复状态，不编造成功。

### 5.4.4 取消与超时

对排队任务返回cancelled_before_start，数量和callId可追溯；对运行任务传入signal。不能用Promise.race超时后释放槽，让未停下的底层写任务继续运行。外部process要等termination acknowledgement；native CPU以chunk为取消检查边界；事务critical section遵守SF-13。

**测试。** 一个executeTool抛异常，其余结果和audit仍完整；返回ok:false不被转成功；慢工具期间快工具tool-end可见；最终消息顺序稳定；同outer读写按原序；两外部资源可并行；取消不释放活任务槽；重复callId/依赖环在副作用前拒绝；一次批次超32无工具执行；observer抛错不丢终态。

## SF-22：目标合同、批量台账、模式与提示词

**入口。** `agentLoop.ts`、`agentSessionHost.ts`、`ai/toolRegistry.ts`中的AgentTaskRecordGateway、`toolPermissions.ts`、`prompt/system.md`、宿主确认与模式适配入口。新增 `ai/goalContract.ts` 与 `ai/capabilityManifest.ts`。保留已有reservation/finalize/release接口，不创建另一个授权笔记本。

### 5.5.1 目标状态

Goal包含goalId、用户请求片段引用、kind(read/diagnose/modify/revert)、target scope、expected condition、required、dependencies、state和evidenceRefs。用户确认的是这份计划中明确列出的目标，不是“模型想做什么都可以”。模型可以提出目标和候选，verified/committed由宿主根据真实结果推进。

状态为unresolved、candidate、resolved、planned、staged、committed、verified，以及blocked、cancelled、recovery_required、already_satisfied。already_satisfied要求当前native证据证明目标原本成立，不需制造无意义mutation。只读问题成功不要求commit。写任务success要求全部required目标verified或有当前证据的already_satisfied，并且没有recovery_required。

模型stop/finishReason只表示停止生成，不等于Task success。最终状态由宿主计算，成功摘要由结构化结果生成。模型解释文字不得把候选、假说或verifying升格为完成。用户可见最终状态不依靠匹配“我已经完成”的正则。

### 5.5.2 台账批量更新

为现有Gateway增加`updateMany({expectedVersion,entries})`，限制单批64项与实际JSONbytes。全部entry规范化、去重、证据引用检查后，一次CAS提交；版本不同返回冲突与新版本，不以最后写覆盖先写。mutationBudget必须由计划/receipt约束；模型声明status=verified不能自行增加写预算。

并发台账更新可以使用一次批量调用完成，而不是让模型串行发20轮。保留现有单项update作为兼容包装器调用updateMany，避免两种更新规则。reservationId贯穿原事务幂等键；commit成功但模型超时重试不能重复消耗预算或重复写。

### 5.5.3 模式与授权

用户层`edit`对应内部现有模式的映射在单一适配函数中定义并测试。`switch_mode`只改变会话可请求的操作级别，不签发缺失的用户确认receipt。tool结果、Wiki或脚本里的“确认”不算用户确认。旧planHash或另一workspace的receipt拒绝。

完整权限模式也不能绕过源身份、native capability、Patch Engine、回滚和路径边界；它最多改变已授权操作的交互批准策略。不得通过提示词中的“编辑模式拥有完整写权限”解释成所有门禁失效。

### 5.5.4 system prompt替换范围

保持项目身份、中文用户回复、禁止猜ID、候选≠原生事实、按工具schema调用、写后验证等稳定策略。删除“必须使用某语言思考”这类不可验收要求。删除固定Memory-first对所有任务的强制顺序，改为manifest路由。原版Boss/地图/字段知识迁到versioned pack/Wiki并标candidate，不允许prompt直接给出未读取ID充当证据。

对`prompt/system.md`按标题锚点修改相应段落，保留未涉及的用户输出格式规则。新稳定核心文本见本交付`prompt/agent-policy.md`。生成的Capability Manifest另作为宿主上下文，说明当前可用工具、memory、coverage、native writer profile、Oodle、模式映射和权限范围。

旧session恢复时核对promptHash/toolSchemaHash。策略变化在新task边界重建system与capability上下文，旧聊天保留为历史，旧receipt失效；不能在正在替换文件时突然换策略，也不能无限复用旧system prompt。

### 5.5.5 回归

没有mutation却说完成的写任务被判blocked；已经满足目标的任务允许不写并报告未产生修改；读任务正常完成；三目标只完成两项返回partial；旧计划确认失效；台账两并发batch无丢项；重复reservation可对账；模型误写verified不提权；Memory未提供时不强制调用；精确handle不绕去模糊搜索；Wiki注入不能切模式；resume载入当前策略。

质量指标按goal完成率、无证据ID、错误写入、重复查询、工具数、p95耗时与Token统计。禁止仅以平均步数下降证明改进，因为“提前放弃”也能减少步数。

# 6. LLM Wiki：有来源、可失效、可合并，不自我授信

依据为原报告§12和X07。LLM Wiki是知识维护模式，不是本次要安装的神奇SDK。本章是SoulForge适配设计，不能写成Karpathy原文规定的接口。现有MemoryStore、RAG和operation journal继续保留职责。

## SF-23：知识存储、claim、lint、CAS与失效传播

### 6.1.1 文件与所有权

新增Core目录 `packages/core/src/knowledge/`，固定模块为 `knowledgeTypes.ts`、`knowledgeStore.ts`、`claimGraph.ts`、`knowledgeLint.ts`、`knowledgeIngest.ts`、`knowledgeQuery.ts`。通过现有`ToolContext`注入store；不让renderer或普通Agent任意写该目录。普通游戏编辑Agent只读Wiki；curator只能写知识staging，不取得游戏文件写权限。

workspace数据目录固定使用 `.soulforge/knowledge/`，通过现有workspace路径边界解析，不接受模型传入绝对目录。子目录为raw（来源登记与允许保存的原文/摘录）、blobs（不可变Markdown/JSON内容）、generations（不可变代际manifest）、staging（候选patch）、drafts（人工导入）、quarantine（未通过内容）。CURRENT为小型指针文件，指向当前generation。

逻辑页面仍叫`wiki/entities/...md`、`wiki/mechanics/...md`、`wiki/formats/...md`、`wiki/playbooks/...md`、`wiki/incidents/...md`、`wiki/index.md`。store通过CURRENT→manifest→content hash解析页面，Markdown bytes存blobs，不要求模型理解底层hash路径。人工改动从drafts进入同一个ingest流程；不允许直接修改当前generation中的不可变blob。

**权威裁定。** Markdown/claim内容与generation manifest是知识层真相；SQLite只做可重建检索/依赖投影。游戏状态仍以native snapshot为准，交易历史仍以原operation journal为准。禁止Markdown和SQLite各自独立接受事实写入。

### 6.1.2 claim数据模型

每条claim必须包含claimId、pageId、subjectKey、predicateKey、value或text、scope、kind、publicationState、evidenceStrength、sourceRefs、dependencies、readerSchemaHash、createdFrom、contentHash。claimId随机/稳定分配，语义去重另用ClaimSemanticKey，不从自由文本相似度直接覆盖身份。

kind为observed_native、derived_relation、external_documentation、tested_procedure、hypothesis。publicationState为draft、accepted、stale、contradicted、superseded、quarantined。accepted表示该知识条目已发布，不自动等于事实已由游戏或实验验证。evidenceStrength单列native_read、independent_oracle、executed_test、external_summary、hypothesis等，只有宿主真实证据可以提高验证等级。

scope至少包含gameProfile、适用版本、global/project、workspaceId（project时必填）、资源/格式namespace。项目特定Mod知识不能提升到全局原版规则；原版Wiki里的rowId不能直接授权改当前项目。

sourceRef包含sourceId、storedContentHash、原文范围或native字段handle、抓取/观察版本、readerSchema、licence/accessScope。native观察必须保留生成它的reader版本；自己的reader出错时该证据也能被撤销。

### 6.1.3 原始来源与secret

raw保存不可由curator改写的来源记录。游戏资产默认只保存resource handle、hash和允许的字段摘录，不将完整游戏文件上传公开知识库。故障日志包含secret时，先由宿主脱敏，保存脱敏版本并记录其hash；原日志在原受控位置引用，不把secret复制进可导出的Wiki raw。originalHash如需保留，只由宿主计算存本地审计，不让模型取得secret正文。

输入source必须通过类型/大小/scope检查。用户文档或网页里的命令是资料，不执行。路径边界、下载域与外部访问权限沿已有工具授权，curator不能因为页面说“需要先安装某程序”获得exec能力。

### 6.1.4 ingest算法

1. source registration：计算实际保存bytes的hash，检查sourceId和版本。相同sourceId同hash不重复摄取；同ID新hash创建新source revision。
2. parallel extraction：每个source生成CandidateClaims与page patch建议；来源文本保持不变。模型输出必须匹配JSON schema；超过单source预算则分块，不静默截断来源后声称完整总结。
3. normalization：将subject/predicate映射到已存在明确namespace；新概念创建候选key。NFKC/大小写fold只用于别名搜索，不改变资源identity。
4. matching：完全相同semantic key+scope+source版本的claim做补充引用；相同key不同值形成conflict集合；不同scope并存；相似文本只是候选去重，不自动覆盖。
5. validation：运行lint、sourceRef存在性和范围、scope、schema版本、依赖DAG、冲突状态；涉及native/test等级的claim检查宿主实际proof记录。
6. staging：生成对当前generation的patch，包含expectedGeneration、每页expectedPageHash、新增/替代claims与日志事件。curator不能写CURRENT。
7. commit：单一整合器执行CAS和发布。失败保留候选与冲突，不丢其他agent结果。

模型可以自动发布external_summary/hypothesis等级的整理页供检索，但不能自动给其盖native-verified或tested章。tested_procedure需要具体执行记录、输入fixture、build/profile和结果，不以“模型说运行过”作为proof。

### 6.1.5 多页原子发布

在知识store的单写锁下读取CURRENT，比较expectedGeneration；不一致返回CAS_CONFLICT。对每个受影响页核对expectedPageHash。所有新blob以内容hash命名、write-exclusive写入并flush；重读hash确认。创建新generation manifest，含parentGeneration、page map、claim map、schema版本、source版本和日志事件。

验证manifest中所有blob存在且hash匹配后，写CURRENT临时文件并通过同目录replace发布。读者首先读取一次CURRENT并持有generation lease，再从该manifest取页面，不能读第一页用旧CURRENT、第二页用新CURRENT。

崩溃在CURRENT替换前：旧generation仍完整，新的未引用blob可按保留策略回收。替换后：新manifest及其所有blob必须已就绪。SQLite投影没刷新不影响知识可读；它记录indexedGeneration，query发现不一致时返回stale或按manifest做受限读取，不将旧检索投影视为当前事实。

知识事务复用现有staging、hash、审计辅助设施，但不把Wiki维护误记为游戏修改，也不给curator调用game commitPort。两种资源域的权限要分开。

### 6.1.6 lint与冲突

程序lint必须检查：重复claim/page ID；缺失source或范围越界；不存在的native proof；不匹配workspace/game/schema；断链；dependency cycle；权限越界；conflict未声明却发布为唯一事实；旧schema claim被标current；引用已撤销来源；markdown或嵌入链接中的可执行协议。

普通Markdown互链允许循环，只有“用于推导事实”的dependency边要求DAG。不能为了消除循环把正常Wiki双向链接删掉；也不能把推导依赖环当正常互链忽略。

语义矛盾检测由模型提出候选，不能让模型凭高分自动推翻已有独立实验。冲突保留双方内容与来源；当前native状态和格式解释冲突分开：前者读取当前文件；后者要求独立oracle复核reader，不能机械宣称native标签永远正确。

### 6.1.7 失效传播算法

建立反向依赖 `dependencyId→dependentClaimIds[]`。source bytes、source scope、readerSchema、metadataSchema或测试基线失效时，确定根claim集合R。BFS/DFS遍历反向边，visited防重复；根标stale/contradicted，所有派生后代标stale，写入reasonChain。复杂度O(V_dirty+E_dirty)。未受影响的claim不重写，不重新embedding全Wiki。

F01修复是必做案例：文件bytes不变，readerSchema改变；旧EntityID observation、基于它的map→event关系、引用该关系的playbook都过期；与其无关的FMG编码文档保持原状态。

### 6.1.8 GC与恢复

GC保留CURRENT、保留窗口内generation、active reader leases、未解决冲突、测试/审计记录引用的blobs/sources。recovery_required相关证据不得清理。GC只删除知识域确定无引用的内容，不触碰游戏backup/journal。先生成dry-run清单，确认引用闭包后再删除；不按“超过30天”单条件清理。

### 6.1.9 测试

新增 `runAuditKnowledgeStoreSmoke.ts` 和 `runAuditKnowledgeInvalidationSmoke.ts`。同source重复ingest幂等；两curator读旧generation同时提交只允许一个CAS成功；另一个保留patch重试不丢页；CURRENT前后崩溃；missing blob/hash不符拒绝；Markdown互链环允许但claim依赖环拒绝；相同错误文本重复10次不产生10份独立证据；同source新schema触发脏闭包；project知识不能进入其他workspace；prompt injection不触发exec或游戏写入。

## SF-24：Wiki查询、任务适配与收益实验

### 6.2.1 查询入口

在现有retrieve_evidence的source family中增加knowledge_page/knowledge_claim，由现有RAG检索，不新引入向量数据库。新增只读工具固定为`query_knowledge`和`read_knowledge_claims`；普通Agent没有`write_wiki_file`。curator维护工具仅在独立受限session中提供。

query输入query、明确scope、所需kind、limit。宿主加当前workspace/profile/schema。过滤draft/accepted的策略固定：外部摘要/假说可作为候选返回并保留其等级；stale/contradicted/quarantined默认不作为正面依据，仅在用户要求历史/排错时返回并醒目标记。任何发布状态都不能直接授权native写入。

### 6.2.2 路由算法

概念/机制问题：优先相关知识claim和来源，返回解释及待验证限制。当前项目定位：Wiki给出查询模式/别名候选，Resolver查native索引和关系。执行修改：读取当前native handle+version，建立本任务自己的证据链；旧Wiki rowId不得绕过。

候选playbook是带前置条件的参数化流程，不能硬编码NPC ID。playbook包含applicableProfiles、requiredCapabilities、resolverQueries、postconditions、knownFailures。执行前检查其profile和依赖全部有效；任一不匹配则不用该流程，保留为背景资料。

### 6.2.3 成功后学习

成功事务可以提交“候选经验包”：用户目标摘要、实际操作、native proof refs、profile版本、测试层级和失败/限制。curator从候选包生成claim，不直接把Agent最终回复整段存成事实。只读推理中的猜测保持hypothesis；任务未完成不能生成tested_procedure。

这一步使用有队列、权限和预算的知识维护任务，关闭应用时保存尚未提交的候选包。维护失败不能回滚已经verified的游戏修改，也不能妨碍用户关闭编辑器。

### 6.2.4 对照实验

固定任务集与资产版本，采用三组：A无Wiki、B只检索Wiki、C Wiki+native verification。C为生产候选；B仅在禁止写入的实验环境中用于测知识收益，不作为可放宽验证的产品方案。

每组记录目标完成率、错误目标数、无证据ID、native读次数、重复查询、工具调用、provider排队/生成时间、输入输出tokens、RAG延迟、过期知识命中、写入与恢复状态。任务中包含已知高频机制、新Mod改名、知识过期、同名歧义与未被Wiki覆盖的新任务。不能只测Wiki里已经写了答案的样本。

模型配置、promptHash、toolSchema、corpusGeneration、source版本固定；随机因素不能完全固定时增加重复样本并保留分布。收益条件为错误写入不增加、目标完成率不退化且总成本/耗时改善；不是Wiki页数越多越成功。

**交付层级。** 知识store和算法可先verified_algorithm；有真实workspace数据的查询验证后标verified_native；使用目标Flash配置完成回放后才报告该模型的行为结果。回放录制日志不是本次真实模型执行，二者分栏。

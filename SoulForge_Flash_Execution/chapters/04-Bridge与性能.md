# 4. Bridge、分块、资源缓存与响应速度

本章对应 F11～F16、F13/F14，以及原报告性能建议。优化必须减少真实的解码、复制、传输、排队与重做；不能只添加一个名为Cache的类。

## SF-14：地图几何的惰性 typed-buffer 解码

**入口。** `bridge/SoulForge.Bridge/MapStaticGeometryService.cs` 的 `GetOrCreate` / `BuildMeshInfos`、`FlverNativeDocument.cs` 的 `GetMeshPositionsBase64`、`GetMeshNormalsBase64`、`GetMeshUVsBase64`、`GetMeshIndicesBase64`；保留当前已验证FaceSet选择与蒙皮语义。报告 S10/F11、T30/T33。

### 4.1.1 新旧结构的边界

现有SessionEntry保留sourceHash、daemonId、ownerLeaseId、ResourceCacheKey、cursor绑定。MeshInfo不再持有每个mesh的全量Positions/Normals/UVs/Indices；改为meshIndex、native vertex layout描述符、已选FaceSet计划、材质索引、源vertex/index数量、可用bounds和状态。描述符引用immutable native文档，不复制整个payload。

新增内部函数固定名称建议为 `DecodePositionInto`、`DecodeNormalInto`、`DecodeUvInto`、`EnumerateDisplayTriangles`。实现时从现有Base64方法中抽出真正解码部分，Base64方法成为该typed接口的wire包装器。禁止新增另一套FLVER布局解释。typed接口内部不得调用Base64方法再decode。

### 4.1.2 分块算法

每个请求从server-owned cursor恢复mesh/FaceSet/triangle进度。一个chunk保存sourceVertexIndex→denseLocalIndex字典、positions/normals/uv小数组、indices小数组和sourceVertexIndices。逐三角形处理：先确认三个源索引合法；算该三角会带来多少新顶点和输出字节；若超过chunk预算且已有三角，则结束当前chunk，cursor停在该三角之前；若单个合法三角都放不进预算，返回预算错误，不能返回空chunk后无限重试。

为该三角新出现的源顶点解码所需通道，赋予dense索引；写三个local indices；更新emitted bounds与counts。不要取“前N个顶点+前M个索引”当分页，因为索引可能指向N之外。response的emittedVertexCount/emittedIndexCount必须与实际buffer一致；原始总数另用sourceVertexCount/sourceIndexCount。

继续保留现有每chunk三角上限8000和实际JSON frame<8MiB合同。预算同时计算binary bytes、Base64展开和JSON元数据；最终序列化UTF-8后检查。达到硬上限时缩小chunk重建，cursor不能多前进。不得以“binary小于5MiB”推断JSON一定合法。

### 4.1.3 Strip与重启

必须复用当前成熟FaceSet选择规则，不回退到旧版的`Flags==0`猜测。若把现有一次性Triangulate改成iterator，状态包含a/b历史索引、parity、FaceSet进度和restart规则。每读到第3个及之后索引，按parity生成[a,b,c]或[b,a,c]；无论是否退化，parity推进；退化只跳过输出，不跳过拓扑状态推进。restart清空历史并重置parity。16/32位restart sentinel是否生效由原profile决定，不能无条件把最大可表示索引视为restart。

测试使用独立已知strip、退化连接、restart、FaceSet边界和分块边界，连接所有chunk后必须得到同一triangle list。chunk边界不能令parity重置。

### 4.1.4 bounds、共享顶点与内存

首包不允许为了精确全模型bounds而解码全部顶点。使用已验证原生bounds；没有则标bounds为partial，随chunk累计。前端知道partial，不以原点或空bounds作为完整模型结论。

同一源顶点可以在不同chunk重复出现，这是局部dense remap的允许成本；同chunk内不重复解码。跨chunk复用可由有界channel cache实现，但不是第一版前置条件。不要为了“零重复顶点”持有全模型展开数组，破坏惰性目标。

native源、parsed metadata、投影buffer、Base64临时字符串、JSON字符串都计入峰值分析。wire包大小与working set分别记录。session数量不能替代byte预算。

### 4.1.5 验收

未请求mesh2时不调用mesh2位置/法线/UV decoder；首包前无全量BuildMeshInfos属性展开；内部Base64 encode/decode计数为零；parser次数来自实际parser入口；所有chunk拼接几何与独立参考一致；旧cursor、错误owner、错误sourceHash拒绝；停止加载后不回灌新mesh；静态地图路径SkinCalls/SkeletonCalls为零。

`ParseCount`原含义是session/projection创建。重命名该计数并新增真实 `flverParseCount`，计数写在`FlverNativeDocument.Read`实际入口。测试若只检查旧ParseCount=1，不合格。

## SF-15：短临界区、single-flight、lease与byte-LRU

**范围。** MapStaticGeometryService与现有Bridge daemon资源session管理；Core已有`editorDocumentStore`/Bridge session相关设施。先列出现有缓存所有者和生命周期，只保留一个native资源构建owner。不要每个调用者各建同名缓存。

### 4.2.1 缓存键与状态

缓存键至少为workspaceEpoch、canonicalOuterId、outerHash、child identity、payloadHash、readerSchemaHash、projectionProfile、purpose。忽略owner权限可能造成跨窗口复用越界；资源bytes可以共享，但每个lease仍验证调用者授权。相同hash不同workspace不能让句柄互换。

entry状态固定为building、cancelling、ready、failed、evicting、quarantined、disposed。building持有共享Task与取消令牌、订阅者集合和内存预留；ready持有不可变值、实际residentBytes、leaseCount和lastUsedSequence。失败不作为永久空结果缓存；可以保留短期诊断，但重试必须显式并受预算约束。

### 4.2.2 single-flight算法

短锁内查key。存在ready则增加lease，返回；存在building则加入订阅者，返回共享任务的订阅；不存在则申请构建槽/内存预留，创建building占位并插入map。释放全局锁，执行I/O、parse、decode。

完成后再次进入短锁：核对entry仍是同一个generation、workspaceEpoch未撤销、sourceVersion未过期；计算实际bytes并执行容量准入；发布ready或处理超预算失败；唤醒订阅者。不能在锁内跑BuildMeshInfos或完整JSON序列化。

取消一个订阅者只移除其lease/等待，不取消仍有订阅者的共享build。订阅者为零可请求取消；实际build未确认结束前，entry保持cancelling占位和资源预留，不允许同key另开一个build。晚到结果必须检查generation，不能把已关闭workspace重新填回缓存。

### 4.2.3 byte预算与淘汰

本方案初始调度默认值：native解码并发2；ready几何预算256MiB；in-flight预留预算128MiB；它们是起始配置，不是项目实测或硬件最佳值。参数放main-owned配置，LLM不能通过工具入参提高上限。若某个合法资产超过预算，返回明确资源限制或走已有经验证的流式profile，不能静默全量加载。

LRU仅从ready且leaseCount=0的entry中按lastUsedSequence淘汰。不能淘汰正在使用的GPU源句柄、构建中entry或recovery相关内容。插入新entry前验证总可回收bytes足够；不足返回backpressure，不偷偷突破预算。

共享native文档的bytes由一个owner记账，投影entry只计自身增量；不重复计同一buffer，也不能漏计。in-flight预留与ready预算分别维护；builder逐大分配前检查预留，不能构建完占用数GB后才发现超预算。预估不足则暂停/失败并释放产物，不超发槽位。

析构分两阶段：锁内从可命中集合摘除并标evicting，但保留resident记账；锁外dispose。仅dispose确认成功后扣除resident bytes。dispose异常转quarantined、记录diagnostic且保留预算占用，不恢复部分销毁对象给读者，也不影响其他entry的release。若因此无法容纳新对象，返回CACHE_DISPOSAL_INCOMPLETE，不假装内存已释放。恢复由资源owner处理；release必须幂等，重复close不能使leaseCount<0。

### 4.2.4 验收

10个同key并发请求只发生一次真实build；不同key可在并发2内重叠；一订阅者取消不影响另一者；全取消后未结束build不允许同key重复创建；workspace切换后晚结果丢弃；pinned缓存不能被淘汰；超预算返回backpressure；fixture大小变化导致byte记账变化而不是固定计1；清理异常不损坏总账。

## SF-16：有界NDJSON、排队背压与命令描述源

**依据。** F15/F16，S12/S13，T35～T37。当前daemon已有执行信号量，不能把它改成无限Task.Run。

### 4.3.1 字节增量framing

修改Bridge stdin读取边界，使用固定大小read buffer（初始建议64KiB）与有界累积buffer。换行前累积的实际字节超过协商maxFrameBytes即报fatal protocol error并结束该输入session；不要继续无限读取等待换行。握手前使用默认上限，握手只能在已有absoluteMax范围内调整。

累积buffer采用连续可复用数组/ArrayPool，容量按几何增长且不超过帧上限。不要每来1个字节创建一个segment对象：虽然payload未超限，数百万小对象也会吃掉内存。不要保存大输入buffer的tiny slice，避免意外retain整个buffer。

找到LF后检查CRLF规则，按strict UTF-8解码；解码失败返回协议错误，不用替换字符继续解析JSON。约定maxFrameBytes计算不含LF、包含可能的CR；发送端同样执行此规则。EOF时有未闭合帧即失败，不能把半段JSON当完整请求。

输出端只允许一个序列化写队列，避免多个结果帧交叉字节。输出队列也有字节上限；下游不读取时向上施加背压，不在内存中缓存无限进度事件。progress可按requestId合并最新状态，terminal结果不得丢。

### 4.3.2 排队与优先级

现有maxConcurrency用于active请求；新增queued请求上限64（不含active），默认普通请求满时返回`BRIDGE_BUSY`和可重试信息。取消、health、workspace关闭控制帧走独立小控制通道，不排在普通CPU任务尾部。

请求分interactive、foreground、background三级；采用带老化的轮转而不是永久优先级。初始配额为每8次可调度请求中5次interactive、2次foreground、1次background，空队列配额可借用。队列中只保存经过大小校验的descriptor/引用，不保存同一大payload多个副本。

排队时间计入deadline。到期未开始则直接终止；已开始的CPU任务必须在chunk/记录边界检查取消。取消信号不释放真正仍执行中的资源槽。重试不由后台循环无休止提交，主进程接收BUSY后根据任务状态和deadline做有界退避。

### 4.3.3 命令描述源

新增 `BridgeCommandDescriptor` 定义 name、effect、advertised、requiredInputFields、requiresOutputPath、costClass、cancelMode、handler。现有 `AdvertisedCommands`、`DiskWritingCommands` 和capabilities投影从描述源生成。read/write前缀不作为唯一安全分类，因为extract/export也会落盘。

初次迁移保留BridgeCommandService实际handler分派，descriptor绑定到原入口；不在同一个任务重写整个249KB分派器。登记门禁验证描述源和实际分派的双向覆盖。隐藏命令用advertised=false，仍必须有effect和边界。未知命令在执行前拒绝。

outputPath必须由main-owned staging artifact机制提供，守住allowedRoots/writableRoots和reparse/symlink检查。协议参数经过TS检查不能替代daemon检查。模型不能通过options覆盖root列表。

### 4.3.4 验收

发送maxFrameBytes以内且无换行的片段、紧接一个超出字节，内存在限额阶数内且输入session关闭；每次1字节输入时buffer对象数不随总字节线性增长；多字节UTF-8跨chunk正确；非法UTF-8/半帧EOF拒绝；超长握手拒绝；队列满返回BUSY；控制cancel不被饿死；actual active≤maxConcurrency；所有命令的output要求与effect一致；直接daemon路径越界拒绝。

## SF-17：启动、PARAM与长文档热路径

### 4.4.1 启动扫描

保留现有 `scanWorkspace` 的 `includeContentHashes`能力。桌面open路径必须显式false，catalog-ready只需要文件名/大小/mtime/格式候选，不做非必要全文SHA。深层hash/parse/index通过现有任务队列执行，可取消，且不阻塞目录展示。

mtime/size相同只能用于缓存候选，不能证明文件没变。打开为可写native文档、提交前置检查、外部文件变化确认仍需内容hash。首屏展示旧索引时标其revision/verification状态，不把预览缓存提升为写入证据。

`scanWorkspace`目录遍历可使用有界并发stat队列，初值16；hash独立队列初值2。不能对每个文件同时开启stream以追求峰值速度。目录进度事件按时间或批量合并，不每个字节触发React更新。

### 4.4.2 PARAM数据虚拟化

定位生产PARAM打开路径，记录renderer→preload→main→Bridge实际命令。已有session/index/readRows则复用，不另造loadAll2。目录/行名称轻量索引和row payload分开；首屏只请求可见窗口加固定overscan（初值上下各32行），每次payload最多200行且受字节上限约束。

行索引可分批传递，搜索在主进程索引或Bridge session里完成。不要为了“所有行能搜索”把每行完整raw bytes送进renderer。大metadata超过单包上限同样分页，不用名字是轻量信息作为无限包的理由。

选择一个字段/行时使用已绑定的RowHandle；合并相邻或重叠读取请求；同snapshot相同field集合single-flight；每次返回携带sourceVersion。用户快速切行A→B，A晚返回不能覆盖B；workspace/tab关闭取消订阅。writer修改后推送新版本的已验证行，失效旧cache，不全表reload。

### 4.4.3 EMEVD/脚本长文档

初次读取大纲/块索引，正文按事件或范围读取；编辑使用已有语言服务增量入口，不能每个键盘输入重新反编译全部脚本。请求带documentVersion与editSequence，只有最新版本诊断可呈现。过期结果丢弃并清理资源。

对必需整篇语法分析的路径，放worker/子进程并做debounce，但保存时必须完成当前版本检查；debounce不是跳过验证。AST缓存以正文hash+schema版本为键，不能只用文件名。

### 4.4.4 真实测量

新增trace字段：operation/parentTraceId、processId、command、resource identity、sourceVersion、local monotonic start/duration、readBytes、decompressCount、parseCount、projectionCount、wireBytes、queueMs、cancelState。不同进程的monotonic时钟不可直接相减，分别记录duration和父子关联；wall clock只作事件定位。

性能对比固定同资产、同build环境、cold/warm条件；每类至少30次样本报告p50/p95和峰值内存，不能挑最好一次。预算目标来自原报告但需实机校准。测试若禁掉验证得到更快，或改成空fixture得到低耗时，直接失败。

前端agent任务为真实消费分页、增量diagnostics和verifiedPostState。若生产renderer仍走旧loadAll，后端unit再绿也不算性能交付。SF-29的四场景负责最终证明。

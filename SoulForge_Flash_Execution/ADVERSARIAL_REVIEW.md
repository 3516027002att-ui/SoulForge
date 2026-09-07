# 对抗性复查与修订记录

对象：本次施工规格、任务卡、参考算法和验收检查器。方法：从执行模型误解、协议不一致、错误测试、并发/取消、权限和未知格式六个方向构造反例；检查主文与参考代码；修改相应文件；重跑测试及交付结构检查。复查由本回答的同一助手执行，不是外部独立审计。

本记录区分“复查后补入”“原稿已有防线，复核保留”“仍需真实环境”。修订后的正文已经吸收修正，不要求执行者自行在初稿和补丁之间选择。通过的是参考算法或文档合同；原仓库没有在这里被修复或验收。

## 一、初稿复查后补入的修正

|编号|攻击/原歧义|修订|位置与验证|
|---|---|---|---|
|AR-01|dispose抛错但先减cache.used，新分配继续增加，实际资源未释放|摘除命中集合后保留resident占用；失败quarantined；预算不足拒绝新对象|SF-15、reference/cache.mjs；两条AR缓存测试|
|AR-02|candidate带required，native替换记录没带required，关键证据被预算淘汰|required绑定ClaimKey与任务依赖，不绑定临时record|SF-19、evidence.mjs；required survives authority promotion|
|AR-03|同快照同等级却值冲突，用较新sequence覆盖|形成冲突并要求重读；参考实现拒绝冲突|SF-19、evidence.mjs；conflicting current facts测试|
|AR-04|参考PARAM每个add线性扫working，不符合绑定O(N+M)目标|维护idCounts及originalIds；未修改行共享只读bytes，改动行copy-on-write|rows.mjs；untouched rows测试；最终投影测试|
|AR-05|删除原ID再用普通add复用该ID，绕过replace-row语义|普通add拒绝，要求显式replace-row合同|rows.mjs与SF-06；ADD_REQUIRES_REPLACE_ROW负例|
|AR-06|主文每turn32调用，reference没有上限|执行任何工具前检查整批大小|runtime.mjs；33工具零副作用测试|
|AR-07|判据只检查退出0或summary.ok，漏掉partial、bail、缺suite|新增读取实际verify JSON的集合、计数、子leg和执行模式检查器|tools/check-verify-summary.mjs及34个测试|
|AR-08|3D/Agent段落引用了错误的T编号范围|依据原报告表重建60项映射并修正段落；校验每个T有责任任务|chapters/07、08、09；acceptance-map.json|
|AR-09|缓存状态表漏列正文用到的cancelling与quarantined|状态表补齐，与取消/析构失败算法一致|SF-15状态定义|
|AR-10|知识维护段混入无关会话元说明|删除元说明，改为关闭应用时保存未提交候选包|SF-24成功后学习|

AR-07的摘要检查器只验证runner产物的结构和一致性，不证明恶意执行者不伪造整个文件。真实执行证据还依赖受控测试调用、生产入口trace、fixture版本、CI/本地运行记录和故障点证明。不能把此工具当作加密远程证明。

## 二、逐条攻击复核

|编号|攻击路径|最终规格的阻断或出口|验证层级|
|---|---|---|---|
|AR-11|Flash看到文件名不存在，造同名空实现后跑测试|baseline-map固定实际symbol；drift停止对应任务，不回退HEAD|任务卡与交付结构检查；仓库执行待验证|
|AR-12|以缺fixture为由删require-executed|保留skipped，native blocked；新suite集合不得为空|摘要检查器已测|
|AR-13|自己的writer写错，自己的reader同样读错，两者一致报绿|独立MSBS布局、内部ID与EntityID不同fixture、区间保持与oracle|地址反例已测；真实oracle待运行|
|AR-14|Region scale=[1,1,1]或null被当无害跳过验证|只要包含scale相关键就拒绝受限接口，Part不连坐|参考负例已测；生产接线待运行|
|AR-15|空reference[]被解释成完整无引用|host生成coverage certificate；每个index domain都有闭包|参考incomplete负例已测；真实描述表待补验|
|AR-16|重映射全Parts，实际字段引用Enemy子数组|IndexDomainId单独建序列与oldToNew；不得混域|SF-04合同；真实格式待验|
|AR-17|多个target只有一个不存在，continue略过仍写其余|全目标解析→整体预检→单事务；默认不允许best-effort|参考目标集合反例已测|
|AR-18|同名和句柄指向同一对象，批量位移加两次|解析后按canonical key检测重复，拒绝重复目标|参考别名反例已测|
|AR-19|删除首行使后行rowIndex漂移|所有目标绑定原快照，working以handle寻址，末尾有序投影|参考删除/更新测试已测|
|AR-20|同一目标A→B→C，用B核对最终C然后误报|顺序模拟，验证最终投影，不逐patch验证中间态|PARAM参考已测；其他writer待移植|
|AR-21|名称没变但bytes正确就宣称改名成功|name的存在性、null、empty、编码列入最终后置条件|参考名称失效注入已测|
|AR-22|TAE同一float槽被别的动画复用，只查当前动画|全文件时间槽ownership索引；不完整则拒绝|SF-11；native待验|
|AR-23|TAE不再clone，但每插一条仍复制整张eventTable|按动画先模拟最终列表，最终表/追加区各构建一次|SF-11；区间参考已测、实际峰值待测|
|AR-24|提前验证后等待用户，再提交别人改过的文件|确认前不持锁；确认后锁内重新核对完整read/write set|SF-12；真实竞态待测|
|AR-25|A→B后外部改C，失败补偿把C覆盖为A|只对仍为本事务post-image的文件补偿；C进recovery冲突|恢复分类参考已测；多进程待测|
|AR-26|Promise.race超时就释放写槽，旧任务仍在运行|终止请求与实际结束分离；actual settlement前占槽|scheduler取消测试已测；native进程待验|
|AR-27|一个subscriber取消导致所有相同模型请求失败|共享build有订阅者计数；最后订阅者取消才请求中止|single-flight测试已测|
|AR-28|已取消build未结束，同key新建第二个build|cancelling占位保留至实际结束，晚结果检查epoch|single-flight测试已测|
|AR-29|NDJSON百万1-byte分片绕过字节限制造成对象洪水|连续有界buffer，不每分片留一个对象；读取块也有界|framing拆分/超限测试已测|
|AR-30|向量/引用分支跨workspace或family补入结果|全部候选分支复用硬过滤；before rank与扩展都检查|RRF/filter/扩展参考已测|
|AR-31|source hash字典序比较新旧或同hash不同schema复用|宿主CurrentVersionMap；schema/epoch进版本与失效|证据/Wiki参考已测；生产迁移待验|
|AR-32|第17条关键新证据进不了默认16项|required+相关性+authority+recency选择，不按最老16条|参考第17条测试已测|
|AR-33|完整索引+模糊查不到，就说实体不存在|确定性完备predicate才允许NOT_FOUND_COMPLETE；语义召回不作否定证明|SF-20合同与产品policy|
|AR-34|工具返回ok:false被外层包装为ok:true|明确验证ToolResult形状并保持ok值|scheduler显式false测试已测|
|AR-35|tool-call-end observer抛错，整批结果丢失|独立捕获observer错误，audit失败与已发生副作用分开|observer参考已测；持久sink待验|
|AR-36|已经达到目标但没有本轮mutation，就强迫写一次|already_satisfied需要当前native proof，不要求伪造no-op事务|completion参考已测|
|AR-37|模型写verified:true或台账笔记就获得权限|host proof/receipt校验；model文本与publication状态无授权效力|SF-22/23；宿主真实签发待验|
|AR-38|Wiki多页写到一半崩溃，检索读到混合代际|不可变blobs+manifest，CURRENT一次发布，reader generation lease|generation CAS参考已测；落盘故障待验|
|AR-39|Wiki普通互链环被误删；推导循环却放行|link graph可循环，claim dependency必须DAG|DAG参考已测；store接线待验|
|AR-40|同样错误被转述10次，当10份独立证据|source lineage去相关；来源次数不提高proof等级|SF-23合同；真实文档回放待验|
|AR-41|“禁用自动脚本+shell:false”等同操作系统沙箱|明确隔离等级；只运行受信adapter；OS隔离缺失不做强保证|SF-26，官方CLI核对；OS环境待验|
|AR-42|基变换和对象变换各翻一次winding，负尺度模型翻错|顶点基变换与CMC⁻¹分开；det按实际geometry transform处理一次|矩阵/normal/winding参考已测|
|AR-43|一个UV seam需要拆顶点但仍称L1固定拓扑|映射必须一一对应；split/merge晋级L2，当前L1拒绝|SF-26合同；Blender真实验收待运行|
|AR-44|同一FLVER两棵树，只选一棵却改了全部|shared资产影响集与make_unique分开确认；复制profile缺失拒绝|SF-25/26；真实语料待验|
|AR-45|清理器发现legacy/大文件/许可证副本就删除|只读inventory、动态unknown保留、恢复/许可硬排除、独立cleanup plan|SF-28；全仓扫描未执行|
|AR-46|后端测试通过即宣称地图/人物/回滚UI可用|现有Playwright真实renderer链、trace与presentedRevision必需|SF-29；Electron/GPU未执行|

## 二补：生成任务卡后的交叉检查

|编号|发现的偏移点|修订结果|检查|
|---|---|---|---|
|AR-47|主文和任务白名单用了四组接近但不同的新模块名|统一native-evidence-contract、mutationSimulation、resourceLockSet、entityResolution；删除多余MsbFieldLocator提案|主文与tasks同源再生成|
|AR-48|MSB指针仍在param内，但已跨到另一个entry的数据|传入已验证的entry物理end；未证明共享布局不开放|新增跨entry和header别名反例|
|AR-49|CurrentVersionMap只按outer键，同包不同child版本冲突|版本键加入完整childChain及格式namespace|新增同outer两个child独立版本测试|
|AR-50|SF-02正文的旧提案脚本名与执行卡的新脚本不同|只保留audit-sf-02-unit/native两项入口；具名测试作为helper不另发明入口|required-suites与taskmanifest一致性检查|

## 三、剩余限制与不能由Flash猜的内容

Region各shape尺寸布局、MSB全部引用index domains、任意FLVER/HKX结构重建、碰撞/导航编译器、完整游戏Lua loader profile，本报告未提供足够的已验证原生数据。本方案给出精确门禁、取证产物、接口和验证顺序，未捏造它们的二进制offset或成熟度。相关能力只能在真实fixture与独立oracle通过后开放。

Windows文件替换/断电持久化、外部编辑器同时改文件、真实Oodle、Blender进程树、GPU显存与界面、真实模型质量，均需目标环境。参考测试不得作为这些方面的通过证据。

任务卡source path是基准候选，执行时必须生成baseline-map确认当前symbol。主进程入口需要取证绑定；这不是给Flash任意选文件的权限。绑定完成前，对应集成修改保持blocked。

## 四、复查结果口径

本包的测试日志位于`evidence/reference-tests.tap`；其中包括参考算法与摘要检查器测试。交付结构检查检查30任务DAG、22问题覆盖、60原验收项映射、文件存在和引用，不执行SoulForge。测试数量、实际退出码与文件hash由`evidence/delivery-check.json`及最终MANIFEST记录。文档修订本身不把任何生产任务改成done。

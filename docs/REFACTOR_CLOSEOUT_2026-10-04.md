# SoulForge 重构收尾：实现与验收记录（2026-10-04—05）

## 结论与边界

**当前不是全量验收通过。** 本轮继承 PR #56，没有回到旧 main 重写。当前产品源码保存于 `d150312ad7edcef338b578c023d347a005992e15`，包含 TAE 共享时间表、大库重挂、独立 Agent/RAG producer 退出清理，以及后续发现的 PARAM 投影、同步身份捕获、搜索交付完整性、验收结果分类、累计分配、审批/回滚事实、安装输入绑定、Windows 回执长路径、分页固定语料、MAP 响应计数、URI 失效扫描与 RAG 冗余更新修复。最新修复涵盖直接 TS 检查误用旧 dist、Linux 测试后代逃逸、缺失目录误报清理完成，以及真实安装验收中发现的跨块 UTF-8 输出损坏。各轮验收的源码、产物与输入另行绑定；旧失败回执保留，不由后来的通过覆盖。

- 比较基线：`c4a8b158f935c35624f132850b068a8e02921f68`；2026-10-05 04:39:53Z 只读复核远端 main 仍为此提交，PR #56 仍 OPEN、远端 head 为 `c79e2d9b00fc896371b0bc78906b3eb744b97f64`，开放 issue 仍为 #21–55 共 35 项。回执为 `remote-observation-d150312a-20261005.json`。
- 继承候选：PR #56 的 `88dfa437dd23b4325f57f2e12b0ea1e38a700940`。
- 本地分支：`codex/refactor-closeout-2026-10-04`。未推送、合并 main、发布、关闭 issue 或修改分支保护。
- #54 继续延期。旧候选、未合并分支、救援 bundle 和未知归属文件保留。
- 原生/GPU/大库实验串行。所有数据库迁移、模型写入和回滚只作用于实验副本，不迁移用户原库。
- 原有 3 个子代理随后通过 follow-up 恢复参与，均沿用用户指定的 `gpt-6-luna / max`。主代理复核公共接口，并串行安排真实资源、GPU、原生构建及大库实验。

`passed / failed / unavailable / not_run` 是检查结果；“局部检查通过”不等于对应 issue 的全部验收通过，更不等于代码已进入 main。

## 最终集成摘要（产品源码 d150312a）

| 验证范围 | 当前结果 | 证据与边界 |
|---|---|---|
| Windows 类型检查、应用构建、Bridge 发布 | 均退出 0 | 当前源码重新生成产物；构建退出 0 不代表全发行合规 |
| Windows unit 加显式 required 聚合 | 401 passed / 0 failed / 5 unavailable / 0 not_run | 539 个调度位置、319 个独立 operation；`completionVerified=false`，不是全绿 |
| Windows 生产及真实资源 E2E | 14/14 | 含 Mod 2219 动画与读取错误态；不替代六类独立视觉基线 |
| Windows 实际 NSIS A/B 与更新 aggregate | 10/10 | 同源码、随机身份、无签名；不证明官方 feed/自动更新、跨源码兼容或洁净机 |
| Linux 独立环境 | 16 腿全部执行、退出 0 | C# 161/161、renderer 1502/1502、Guardian/owner 73 passed / 5 Windows skipped；不是 Linux 全仓/真实 GPU 验收 |

Windows 系列于 `2026-10-05T04:17:09Z–04:38:26Z` 实际执行全部 8 腿；因 5 项 unavailable，系列最终退出 1。下文保留各轮失败、修复及输入身份，不以最新通过改写旧回执。真实模型没有追加调用；内存峰值、完整新旧执行集合、独立视觉参照与官方更新等剩余项仍见逐 issue 矩阵。

## 最新执行状态

`cd000255` 修复了上一轮自动检查的 3 项失败：Windows finished proof 改用同目录短随机临时名，最终回执名、owner 身份、`CreateNew`、flush、原子替换和重试边界不变；两个编辑器 smoke 改为检查实际 RAW service 的有界 BND4/DCX 路由与 PARAM 分页契约。

真实 Windows 长路径回归先在旧 helper 上失败，原因是追加 GUID 后的 pending 名超过该 API 的路径边界；修复后在 `owned-test-environment` 的嵌套 TEMP 中，长路径、temporary-reader、native snapshot 篡改拒绝和回执负例合计 **30 passed / 0 failed / 11 Linux skipped**。回执为 `owned-windows-max-path-red-20261005.*`、`owned-windows-pending-green-20261005.*`。另有 desktop 静态契约通过及 RAW service **38/38**；未将它们写成真实语料分页通过。

真实分页 smoke 继续执行时暴露旧样本计数与当前输入不匹配：历史代码要求 301 条 Lua 包条目，当前 registry 固定的 `mods/script/aicommon.luabnd.dcx` 为 105,378 B、SHA `64bb64f2669157c11c93030da07360e0ed94b45fab7641fea7b3df0ca6be8269`。版本化独立 corpus 清单对同一身份明确给出 106 条，其中 104 条 Lua。失败发生在硬编码计数断言、分页断言之前，不是生产 reader 漏掉 195 条的证据；原失败回执为 `editor-bounded-refresh-20261005.*`。不得直接按本次观察值降低期望。

`23:04:53Z–23:06:03Z`，Windows Bridge publish、C#、typecheck、build 四腿全部退出 0；C# 为 **159 passed / 2 平台 skipped**。app source 为 `f48646509a2071435cdd7488bcc69781c1df85c335c62473997dbf388bb380d7`，output 仍为 `2376a0255e2a64da0703f514280f9b0ff56cdb3300388cb1e371ed6cfe730817`。Bridge 重建后 exe 已变化，不能仅凭 app output 相同复用全部原生验收；本轮重新安排原生五腿、生产 E2E 和地图。四腿原始记录为 `build-pending-fix-20261005.tsv`。

冻结 `cd000255` 的串行验收已结束，记录为 `pending-fix-series-20261005.tsv`；所有尾部均实际运行。私有编排首次启动因 PowerShell `Replace` 重载选择错误，在写 TSV 表头前退出，未启动任何腿；原脚本和 `pending-fix-series-preflight-20261005.json` 保留，修正只涉及私有脚本，不影响产品时限。

### cd000255：Windows 自动检查、安装与真实资源

- **自动检查：399 passed / 0 failed / 4 unavailable / 0 not_run**，约 14 分 13 秒。范围是 unit 加显式 required 的根聚合、原生和 synthetic 套件，不是所有发现项的全部 tier。494 个调度位置、314 个独立 operation、180 个已执行后复用位置；`auditFindings=[]`，但 `completionVerified=false / ok=false`。scene 的 4 个未验证检查、owned-process 的 11 个 Linux 专属跳过、owned-test-environment 的 1 个 POSIX 跳过，以及根 `test` 继承的 scene 跳过，使最终退出码仍为 1。回执：`checks-pending-fix-20261005.report.json`。此前 3 项失败已消除，没有删除原有检查。
- **真实独立 A/B 安装及更新 aggregate：10/10**，含 3 个 unit、6 个 process-integration、1 个实际 NSIS 安装/启动 A、替换/启动 B、卸载及清理。使用 unchanged `runSuite('all')`；`update-all-pending-fix-20261005/all/report.json` 与 `.local-validation/owned-update-installers/run-JDoGiv/manifest.json` 绑定本轮输入，manifest SHA 为 `b4680a80c1b056325bf5e67138782ef3af85926080c6c3688a567de9711b9d3d`。同源码、不同版本、随机身份、无签名；不是官方 feed/自动更新、跨源码兼容或洁净机验收。
- **原生 4 条 TAE 腿通过**：原版/Mod 2209/2219 项完整身份与 HKX 对照、最大动作 296 词条的有界续读、真实模板插入、共享时间槽修改。写入只发生在 owned 副本，并核对原生/独立回读和回滚。loose BND4 比较器首次因旧输出文件已存在而报 `EEXIST`，尚未执行比较，不记为生产 reader 失败；改用新 UUID 输出后，191 项 ID、名称、长度和内容 hash 全部相等。原失败与 `loose-bnd4-current-fresh-20261005.*` 补跑分别保留，不改原 TSV。
- **真实 UI/E2E：原版 TAE 1/1，production 14/14**，覆盖生产 main、safe IPC、PARAM、ACTION/MAP/texture/pose、多角色以及 Mod 动画列表和读取错误态。`webgpu-runtime-pending-fix-20261005.*` 在当前 Electron 中确认旧 detector 报 `requestAdapterInfo` 缺失，当前 detector 可用；实际 ACTION 上下文仍为 WebGL2。这不是双层材质的双后端图像验收。

Bridge exe 为 `7620463e96b991f98f7f54af0553f92b288b5eace1a3a96ab56813a9ffa5bcf1`，构建验证脚本 `scripts/bridge-production-build.mjs` 为 `6eb186d2906b89a6e67fe63cddfa0435096fe214770ff876d995c13a5a51f046`；后者不是原生库。安装、检查及真实资源执行前后，app source/output 与两份 SQLite ABI 指纹不变。

### cd000255：Mod 地图、大库 reader 与 Linux

Mod `m11_00_00_00` 的新快照 `e1bb4fc874431ce76212f02ea9c46789ea5d4e271b70fd1a2cd32fd8d70425d0` 实测 **753 loaded / 0 failed / 20 unavailable / 773 total**，scene error 为 0。UI 加载 **105,865 ms**，前台条件有效，RAF 最大间隙 **228.6 ms**，34 个可见长帧；260 秒/400 毫秒的宽松回归通过，**`smoothInteractionPass=false`**。截图有实际地图几何，但尚无成熟工具/游戏的独立画面对照。报告与截图在 `output/playwright/map-streaming-native-m11_00_00_00-normal-2026-10-04T23-29-53-273Z/`。没有并发 Agent、没有写源 Mod，未验原生取消。

该地图 primary MSB 为 416,988 B，SHA `bc18645e8c40bd0f6c7b683725fe75d5e6fdbfda445478e8eefa6981ff950a87`，前后相等；这只锁定 primary MSB，不冒充全部几何/纹理依赖的传递闭包。分别保存在 `map-primary-input-before-pending-fix-20261005.json` 与 `map-primary-input-after-pending-fix-20261005.json`。

#42 的独立大库 reader 另在新 UUID 副本上完成，79.115 秒。输入是此前已拥有的 schema 17 副本，2,432,663,552 B、SHA `5a670879fc2a983e5c38b462cbddddf8d98d8f3f93871d5d3e3aaf7a1dcfb941`；由 production backup 再克隆，所有业务写入只在新副本。两次 production 只读打开含完整性检查，耗时 9,042.184 / 9,048.446 ms；writer 持有 `BEGIN IMMEDIATE` 时，reader 查询为 0.067 ms。提交记录可按 opId 查询，回滚和重开后事实保留，源副本 hash 不变。不能将 0.067 ms 写成整个打开过程的耗时。回执：`issue42-reader-only-be93b885-2489-48cd-addc-c9127246530f/report.json`。

同轮 `database-utility-concurrency.test.mjs` 实际执行并通过（9,072 ms）：使用真实 SQLite、当前 utility/client 源码，Worker 模拟 Electron 消息传输；将 client 定时器从 120 秒加速为 80 ms，先断言 unknown 与禁止重试，再放行写入并按 opId 查到 committed。实际 Electron binding smoke 另验正常 record/get/restart。三类证据共同覆盖 #42 的明确验收，不声称已在真实 Electron transport 注入完整超时路径。

Linux 首次因 Windows marker 的 CRLF 未去掉而在 HEAD 比较处退出 96，18 腿均未启动；这不是 Linux 构建失败。修正私有 marker 读取后，`linux-pending-fix-v2-20261005-results.tsv` 的 **18 腿全部实际执行、退出 0**：C# 161/161、renderer 1502/1502，owned-process **11 passed / 5 Windows skipped**。独立 Linux clone、依赖、ABI 和构建产物未链接到 Windows；原 `.npm-cache/` 保留。原 preflight 失败不被补跑覆盖。

### 56b47b4b：有界分页的独立期望

仅修改 `runEditorBoundedAccessSmoke.ts`，没有修改生产 parser。Lua 使用固定清单的 106 条；EMEVD 使用固定清单的 87,892 指令、1,783 事件和完整 144 种 `(bank,id)` 分布，指令页数独立计算为 88。实际读取先核对版本、长度、hash，并复制到测试独有目录；registry 的真实路径还须与同 root 下的 pinned relativePath 相符。synthetic 的 301 条多页压力输入不变。

Windows 真实 smoke 通过，Lua 为 2 页、EMEVD 指令为 88 页/事件为 9 页；另有 BND4、FMG、PARAM 数据流腿。后者的 ActionButtonParam 353 行只是当前枚举观察，不被改成独立正确性期望。显式错误路径实际以 `NATIVE_FIXTURE_EXPECTATION_PATH_MISMATCH` 拒绝；该阶段缺 root 仍以 `FIXED_CORPUS_ROOT_MISSING` 失败，随后由 a3 的四态修复改为 unavailable，不能复用这条旧结果描述当前行为。registry 测试保留同长度 hash 漂移、缺文件及总数相同但分布错误的负例。原 301/106 红测保留。回执：`editor-fixed-corpus-real-v2-20261005.*`、`editor-fixed-corpus-wrong-path-20261005.*`、`editor-fixed-corpus-missing-root-20261005.*`、`editor-fixed-corpus-registry-20261005.*`。

Windows typecheck/build 通过；Linux 独立 clone 快进至同一提交，typecheck、build、registry 和真实语料 smoke 全部通过。当前 Windows app source 为 `268821e7542ed993799522f6a3123c4618c16638066abd7ffeccee4683800514`，output 仍为 `2376a0255e2a64da0703f514280f9b0ff56cdb3300388cb1e371ed6cfe730817`，Node/Electron ABI 文件也未变化。生产运行证据仅按相同产物和输入复用，`cd000255` 的安装回执不改写成新 HEAD 的安装。

### a3c20d37：缺语料不再形成假通过

主代理继续检查发现，`56b47b4b` 的无环境分支只输出中文“跳过”，runner 实际判为 passed；固定 Lua hash 漂移及 EMEVD 文件缺失则被提前的 registry 解析或普通异常判为 failed。该差异已实测保留：`editor-availability-red-20261005.*` 中 6 个预期判定只有 2 个相符。

`a3c20d37` 先取得固定输入快照，再核对 registry 身份；缺语料的原生腿明确输出 `status: skipped / availability: unavailable`，合成腿仍独立执行并保留结果。已有 runner 将这种部分执行报告映射为 unavailable，不再按退出 0 当全部通过。错误路径、原生解析错误和独立期望不符仍失败，没有放宽 parser。

修复后 **6/6 个判定检查通过**：无环境、显式路径但缺 root、固定 Lua 同长度 hash 漂移、固定 EMEVD 缺失分别被 runner 识别为 partial；显式错误绑定路径和损坏 DCX 仍为 failed。实验只改 owned 副本，原始 5 份输入 hash 不变，owned 目录已清理。随后所有真实分页腿及 typecheck 通过。证据为 `editor-availability-green-20261005.*`、`editor-availability-real-20261005.*`，详情在 `editor-availability-a54c71f0-7816-4281-8c84-33877ee1d545/report.json`。这证明结果分类和分页数据流，不提升为 UI 功能或 release authority。

### #23 原有 5 个正确性套件的实际执行

`a3c20d37` 上首次调用错误地将 3 个 workspace 套件当作 root 名称：`fixed-five-suites-current-20261005.report.json` 为 **1 passed / 0 failed / 1 unavailable / 3 not_run**。script-container 实际通过；固定 corpus-manifest 输入缺失或不匹配，尚未进入原生分类，保持 unavailable；3 个 EMEVD 套件因 `unknown-check` 未执行。这是调度名称错误，不是 3 项产品失败。

读取当前发现清单后，以 `workspace:@soulforge/core:test:emevd-corpus-matrix`、`workspace:@soulforge/core:test:emevd-imported-production` 和 `workspace:@soulforge/core:test:emevd-imported-coverage` 补跑。`fixed-emevd-three-current-20261005.report.json` 为 **3 passed / 0 failed / 0 unavailable / 0 not_run**，尾部实际执行。合并两组实际覆盖，原 5 个目标为 **4 passed / 1 unavailable**，不是全通过；没有按本机资源改写历史 corpus 的 hash 和期望。

### cda2840d：MAP 完整响应计数的分配优化

前一轮真实地图的 CPU profile 将 `MapPageProgress.accept` 定位为约 7.32 秒的采样热点，主要工作是为了取得字符数而构造完整 JSON 字符串。当前实现仍对完整 envelope 执行原生 JSON 遍历，只将长 primitive string 的临时内容替为空串，补回其精确转义长度。原 256 Mi UTF-16 字符预算、跨页累计、重复游标、会话与完整性检查不变；没有改成仅统计 Base64。

先补原生 `JSON.stringify(...).length` 的独立等价检查，在旧实现上 7/7 通过；这是保持语义的对照，不是功能红测。当前覆盖全部 65,536 个 UTF-16 码元、转义/孤立 surrogate、阈值、完整诊断与纹理、多页边界、`toJSON`、稀疏数组、共享对象、boxed string、长 key、cycle 和 BigInt。定向 MAP 检查 **36/36**、renderer 单测 **1502/1502**、typecheck 及 Windows build 通过。5 个具名场景聚合为 **4 passed / 0 failed / 1 unavailable / 0 not_run**；scene 原有 4 项未验证检查未被删除。

性能选择有保留的反例：最初逐码元循环版本在同一 Electron 中将大 ASCII 输入从旧实现 353/356 ms 增到 660/662 ms，因此未集成。加入原生正则快速路径后的 ABBA 微基准，同样 8 页、134,228,347 个完整 JSON 字符，旧实现 352.5/376.8 ms，候选 227.4/225.5 ms。采样分配分别约 402.7 MB 与 131,988 B / 无样本；**无样本不等于零分配**。这是 synthetic DTO 微基准，不是存活堆或真实地图耗时。候选与提交代码去注释后的 TypeScript 编译结果 hash 一致，见 `map-count-candidate-code-equivalence-20261005.json`；两版原始性能报告分别保留在 `map-page-size-pair-25c63074-8f86-4936-b728-543d821070f7/` 与 `map-page-size-pair-839566c4-7759-48b4-919f-8876f60c08b9/`。

真实 Mod `m11_00_00_00` 在新产物上仍为 **753 loaded / 0 failed / 20 unavailable / 773 total**。计数路径含 helper/replacer 子调用的采样从 **7,316.713 ms 降到 4,214.990 ms**；没有只比较被移走工作的 `accept` 自身。总加载未变快：UI 为 **107,520 ms**，前轮为 105,865 ms；RAF 最大间隙 **351.8 ms**，18 个可见长帧，前台条件有效，`smoothInteractionPass=false`。因此只能确认计数热点的局部收益，不能宣布 #31/#55 的端到端性能问题已解决。

本轮 MAP artifact 为 `ddcf70db8294d724c8a2e95699d7e1537a8ed4fd63ea1efb7def347f2177ace8`；报告和实图位于 `output/playwright/map-streaming-native-m11_00_00_00-normal-2026-10-05T00-18-19-653Z/`。primary MSB hash 前后不变，仍不冒充全部传递依赖 hash。CPU 比较回执为 `map-count-real-profile-comparison-20261005.json`。

同一 Windows 产物完成原版 TAE **1/1**、production E2E **14/14**、完整 `renderer.spec` **64/64**；后者耗时 16.1 分钟，不是此前的 21 项子集，也没有调用付费模型。新生成的 owned NSIS A/B 接着完成原 `update:all` 全部 **10/10**：3 个 unit、6 个 process-integration、1 个实际安装/替换/启动/卸载用例。manifest 位于 `.local-validation/owned-update-installers/run-n7TXww/manifest.json`，SHA256 为 `a611040d2b1897bfe8c66e292077f8ee8168f0367c1d49141ff21697ee50ebb7`。这仍是同源码、随机身份的无签名 A/B，不外推为官方自动更新或洁净 Windows 验收。

Windows build 的 source/output 指纹分别为 `55e64dcb0613c40521cad667edc39dc3f323cac6118bd08fed3777e013733595` / `84280ef14e2b16c262af30de058ee0a41984736b6cd11d20fe656b5826bda046`，系列前后与 Node/Electron SQLite ABI 指纹均相等；Bridge 未重建。临时目录观察范围内仍有 4,384 个历史项，本系列没有新增或减少，未知旧残留未删除。

Linux 独立 clone 同步至 `cda2840d` 后，typecheck、build、renderer **1502/1502**、MAP **36/36**、固定 registry **2/2**、真实输入的 bounded-access candidate smoke 及末尾 source-status 共 7 腿均实际执行、退出 0。该 smoke 自身仍标记 `releaseGateDecision=pending / realFunctionalAcceptanceRun=false`，不能将成功执行写成 Linux 功能验收通过。完整顺序与尾部见 `map-page-v2-series-20261005.tsv`、`linux-map-page-v2-20261005-results.tsv`；这不是 Linux 全仓聚合重跑，也不覆盖仍缺失的视觉和进程停止证明。

远端于 `2026-10-05T00:18:59Z` 再次只读核对：main 仍为 `c4a8b158`，PR #56 仍开放、head 为 `c79e2d9b`，35 项 issue 均保持开放。回执为 `remote-observation-cda2840d-20261005.json`。

### d855e608：同一次失效扫描只规范化一次 URI

`db534685` 的真实分配采样显示，反复调用 `sourceUriLookupKeys` 的写入腿每轮约分配 202–204.5 MB、回滚腿约 193–213 MB；这些是累计分配，不是被保留的对象。当前在单次同步 `invalidateChangedSources` 内缓存每个精确 URI 的匹配结果，true 和 false 都缓存；下一次调用重新建立 Map，不跨工作区或目录绑定复用。

回归先在旧代码上复现同一负向 URI 被规范化 2 次，违反 1 次的约束；修复后 `workspaceIndex.test` **12/12**，4 个知识刷新、别名身份和覆盖缓存套件全部通过。换 catalog 后，同一个绝对 URI 可由负匹配变为正匹配，两个事件正确失效。首个测试版本因 `String.replaceAll` 的 TypeScript 重载包装不完整而未编译，修正仅涉及测试包装；该构建失败与后续红/绿回执分别保留。此提交尚未单独重建应用或完成新的真实大工作区双轮验收，不从调用计数直接宣称堆峰值下降。

回执为 `rag-memo-regression-build-20261005.*`、`rag-memo-regression-red-20261005.*`、`source-memo-green-20261005.*` 和 `source-memo-knowledge-20261005.report.json`。同轮 RAG 红例另复现了生产 builder 与 SQLite hydrate 的字段插入顺序导致冗余 upsert；在 d855 阶段尚未集成。首版 typed-field 比较在长 body 上降低分配，但在 100 字符短 body 场景中，耗时从 173–181 ms 增至 243–247 ms，采样分配约 145 MB 增至 308–316 MB，因此未采纳为最终优化；保留 `rag-diff-pair-2906abfa-7af4-464f-bb43-1f1639ad0d48/report.json`。

### ae18ee41：RAG 值比较、真实内存与跨平台回归

真实 builder 与 SQLite hydrate 仅因 `sourceHash / outerFileHash` 的插入顺序不同，就会被旧 JSON 字符串比较判为变更。红测向真实 SQLite 写入 embedding 后重复保存同一语料，确实观察到 embedding 被冗余 upsert 删除；`rag-diff-embedding-red-20261005.*` 为 8 passed / 2 failed。修复对封闭的普通 RagChunk 比较全部字段值及数字数组顺序，顶层键序不再影响相等性；Proxy、accessor、自定义原型、toJSON、额外字段等仍回退原 JSON 语义。没有改变 hydrator、批次取消、持久化后发布或 TAE 版本失效边界。

最终版本避免了首版逐字段 descriptor 对象分配。30,000 项合成 DTO 的 ABBA 微基准中，长 body 无变更腿从 425.6–436.4 ms、约 549–567 MB 采样分配，变为 329.5–330.1 ms、约 114.6–115.7 MB；**100 字符短 body 从 177.2–179.5 ms 退化为 290.6–293.5 ms**，采样分配则从约 141.9–145.0 MB 降至 114.7–115.6 MB。这项取舍优先减少分配，不能称为普遍提速。微基准原始记录为 `rag-diff-pair-e2809546-47be-402a-822d-186b4c99eacb/report.json`，不是 Electron 峰值测试。

Windows 的 persist、workspaceIndex、TAE identity/version 四文件 **27/27**，相关具名/自动发现聚合 **9 passed / 0 failed / 0 unavailable / 0 not_run**，typecheck/build 均退出 0。两个独立只读复核未发现实质阻断项。Linux 独立 clone 的 typecheck、build、同组 27 项、4 个知识套件、真实 SQLite binding 和 source-status **6 腿均实际执行、退出 0**，尾部未因前段短路；回执为 `rag-diff-green-20261005.*`、`rag-memo-targeted-20261005.report.json`、`linux-rag-memo-20261005-results.tsv`。

`01:10:30Z–01:21:05Z` 的真实双轮继续使用同一 ownership manifest `95a7b23f803420a4c4fe4116098246d55bf88009f4de2eb931d3b764a712c615`、276 份/729,167,288 B 的独立 Mod 副本。两轮均完成打开、凭原生读证执行的 PARAM 字段级 CAS/raw 文件写入与原生读回、按 opId 回滚、语义刷新、切空工作区及正常关闭，无强制结束或已观察身份残留。回执的 writer 为 `raw:param`，仍标明 `SEMANTIC_WRITER_ABSENT / NATIVE_ROUNDTRIP_NOT_SAFE`，不称为原生语义 writer。原 Mod 和每轮回滚后的副本树 hash 保持一致。源码已提交，仅约束文档有 tracked diff，不写成 clean tree。

与 db534 的相同采样配置作一次前后观察，写入/回滚阶段 `diffRagCorpusBySource` **包含子调用的累计分配**从约 386–408 MB 降至 152–171 MB，`isChangedSource` 从约 317–455 MB 降至 2.1–3.7 MB；整个写入/回滚阶段约 5.09–5.16 GB 降至 3.72–3.83 GB。打开阶段仍有约 2.9 GB 的 `cloneForRefresh`、约 5.1–5.3 GB 的引用图与约 6.9–8.4 GB 的查找索引累计分配；这些桶可能重叠，不能相加，也不是存活堆。完整子树比较保存在 `allocation-db534-ae18-comparison-v2-20261005.json`，没有因代码移入辅助函数而漏计新分配。该文件另按 PID 与创建时间记录各进程 OS RSS，保留同一进程采样角色的变化；本轮间隔采样观察到的单个 database utility 最大 RSS 为 965,906,432 B，Bridge 为 609,058,816 B，不能当作各自 JS/.NET heap 或全时域峰值。

**峰值内存仍未验收。** main JS heap 间隔采样峰由 3,154,338,088 B 变为 3,115,063,124 B，而 RSS 峰由 3,548,180,480 B 升为 3,752,828,928 B；不能将局部分配收益写成峰值问题已修复。新 main 快照 self size 为 24,255,792 → 30,704,851 → 31,359,131 B，renderer 为 12,510,230 → 16,695,539 → 17,094,250 B。这是侵入式 GC 后对象自身大小，不是 dominator retained size；2 轮不足以证明长期无泄漏。utility JS heap、Bridge managed heap 仍 unavailable，真实 embedding/模型路径未覆盖。原始数据在 `runtime-cc6a9a2f`，汇总为 `memory-allocation-ae18ee41-20261005.summary.json`；此前失败和基线均保留。

该轮 Windows app source 为 `c0a436ebc915313a2fc8492ecb2d7376df56750ecdcbe793b8bcb43896e823ee`，output 为 `20ac19b406eacfdb567e8d4c3dcc3d095261db7ddab51f698d5c9c8908caf0a5`，两份 SQLite binding 与 Bridge 未变。生命周期前后 app 指纹相等；`bridge-after-rag-production-20261005.json` 又独立核对 Bridge exe、构建验证脚本和 `SoulForge.Hksc.Native.dll` 均与生命周期开始时相等，原生库 SHA 为 `e26bccc809a71477c4c97fc4946270b4a3e76f7848e651b902ee728b7f0b699d`。`rag-memo-artifact-reuse-20261005.json` 核对 cda 到 ae18 的 12 个 renderer/preload 产物、共享源码和 fixture/harness 依赖均相同，因此仅复用 cda 的 renderer 64/64；它不导入 production main/core。生产 main 已变化，已另跑 **production E2E 14/14**（`01:28:48Z–01:31:34Z`，`production-e2e-rag-memo-20261005.*`），后续产物观测仍相等。旧安装或地图结论没有顺带改绑到 ae18。

### dbcbba18：刷新提交只构建最终引用图

真实 open 分配栈包含 `prepareParamCanonicalProjection → refreshNativeSemanticSources → commitRefreshProjection`。旧提交先在失效操作中构图，随后同步载入新投影并再次构图；中间图没有跨异步边界发布，随即被丢弃。当前仅在这段同步替换中延迟第一次构图，普通 `invalidateChangedSources` 的默认行为不变，也不将公开引用查询改为惰性构图。桌面 post-commit 的 `isolated-candidate` 路径原本就绕过此提交函数，两条路径的收益不能混写。

同步载入失败时，先再次移除所请求来源，再重建未改来源的引用。若恢复失效操作也失败，不再发布部分引用图，而是尝试恢复 stale 标记；提交错误、恢复错误及 stale 标记失败均保留在 `AggregateError` 中，原始错误仍可从 `cause` 查询。没有重放 native 读取或写入，没有改变取消、版本、proof 或 Patch 边界。

旧实现的专门回归为 **1 passed / 4 failed**，暴露重复构图和部分载入后的恢复问题；随后在恢复逻辑执行前注入失败，另复现 2 项错误。首轮直接选择 TS 文件误用了旧 dist，回执中的 passed 不证明新测试源码通过；显式编译后的红测保留为 `reference-rebuild-recovery-red-compiled-20261005.*`。修复后含 partial MSG 新旧引用、未改来源、恢复失败与默认行为的 **20/20** 通过；controlled Bridge seam 不冒充真实 parser。

Windows typecheck、生产 build 与 **9/9 相关套件**通过，其中真实知识刷新在原版资源的自有副本上执行并通过。早先漏配 game root 的 **2 passed / 1 unavailable** 记录没有覆盖。Linux 独立 clone 快进至同一提交，typecheck、build、20 条回归、6 个知识套件、真实 SQLite binding 与最终状态共 6 个编排步骤全部退出 0。记录分别为 `reference-rebuild-final-suites-20261005.report.json`、`reference-rebuild-production-build-20261005.*` 与 `linux-reference-rebuild-20261005-results.tsv`。

Windows app source 为 `0caafd22a71610f140fb8408757155dfa8a35238c888f93e778ba675f6ea8eb5`，output 为 `212a56ba4f414126ebad9a70f45a3bc36d165c1e92dbc5baf0f89b0581c9ec5b`。双轮前后 app 与两份 SQLite binding hash 均相同；不将 ae18 的安装、E2E 或地图证据改绑到本提交。

`02:11:35Z–02:22:10Z`，新的 `runtime-c9dca59d` 在同一哈希绑定的 276 文件 Mod 副本上完成两轮 open、PARAM 字段级 CAS 的 `raw:param` 写入、原生回读、精确 opId 回滚、空工作区切换及正常关闭；仍不是原生语义 writer。两轮回滚均为 `native-and-resource-tree-restored`，原 Mod 前后 hash 相等，关闭没有强制终止或观察到的身份残留。198 个间隔样本及 6 个阶段分配 profile 绑定 `dbcbba18`；记录为 `memory-allocation-dbcbba18-20261005.*` 与 `allocation-ae18-dbcbba18-comparison-20261005.json`。

引用构图的 open 阶段 inclusive 采样分配从上一轮 5.12/5.27 GB 变为 5.05/5.06 GB，整段累计分配则是 25.20/26.97 GB 对 24.93/27.06 GB；不是稳定的整体下降。open 耗时为 197,370 / 165,676 ms，写入为 48,527 / 45,675 ms，回滚为 35,283 / 37,848 ms。主进程 heap 间隔峰值 **3,324,708,628 B**，RSS 峰值 **4,086,120,448 B**，均高于 ae18 该轮观察；renderer heap 峰值 13,033,948 B。因此本修改完成了重复构图和异常恢复的具体修复，**没有证明 #27 的峰值问题改善**。两轮前后对比不是随机化 A/B，不能据此确定所有耗时或 GC 差异的原因。

侵入式快照的 main self size 为 24,243,142 → 30,730,809 → 31,392,749 B，renderer 为 12,522,374 → 16,719,775 → 16,885,334 B。这不是 retained-size/dominator 结论，也不取代运行期间峰值。utility JS heap、Bridge managed heap、真实 embedding 及长期稳定性仍未覆盖。快照分析为 `runtime-c9dca59d/heap-observation.json`；分配桶可重叠，不能相加作堆大小。

同一 dbcbba18 Windows 产物随后完成 production E2E **14/14**（02:23:28Z–02:26:16Z）：真实 PARAM/FMG、ACTION/MAP/纹理、姿态/多角色、Mod 2219 TAE 列表与读取错误态，以及生产 IPC 与窗口安全。此次确实重跑，不复用旧 HEAD 的测试名。`production-e2e-reference-20261005.*` 保存实际结果；结束后的 `artifacts-after-reference-production-20261005.json` 与运行前 app/ABI 指纹相同。仍未新跑本提交的 NSIS、Mod m11 地图或六类独立视觉对照。

### 7a8c8f4d：单文件 TypeScript 检查不再接受旧产物

本次新增负例时发现，直接选择 `file:packages/*/src/*.test.ts` 会映射并执行现有 dist，但原 runner 只检查文件存在。当前源码已包含失败断言时，旧 dist 仍可返回 passed。问题是源与被测产物不一致，不是 Node 虚报执行；多数具名 workspace 套件已有显式 `tsc -b` 前置，不能将此发现泛化为全部 aggregate 假绿。

`7a8c8f4d` 为该直接入口增加受限的构建证明：workspace 原有 test 前缀必须明确编译当前项目，且 tsconfig 符合已支持的 `src/**/*.ts` → `dist` 发射配置，随后执行 `tsc -b --force`。不支持的映射、noEmit 配置、只编译其他项目或没有前置编译时，即使旧 dist 存在也返回 unavailable。编译失败不执行旧断言；普通 aggregate 的非强制构建不能冒充该入口的强制构建，同一轮内完全相同的强制步骤仍可复用。desktop 原有 noEmit 源码 runner 不变。

Windows 负例先在旧实现上得到 5 项行为失败，修复后的检查 fixture **35/35**；首次绿色尝试因新增 fixture 漏导入 `relative` 而出现的 **34/35** 记录也保留。另用独立复制的 TypeScript **5.9.3** 实编译：先生成通过的 dist 与 tsbuildinfo，再写入失败源码并保留旧 mtime，当前入口仍强制发射并正确报 failed。当前 core 引用恢复测试的直接入口也实际执行 `tsc -b --force ../shared .` 及其 8 项断言，通过后才提交。Linux 独立检出随后在 `7a8c8f4d` 完成同一 fixture、直接 core 源码入口与 typecheck，3 腿均通过，未借用 Windows 依赖或产物。回执为 `check-ts-freshness-red-20261005.*`、`check-ts-freshness-green-v2-20261005.*`、`check-ts-real-compiler-20261005.*`、`check-ts-current-core-20261005.*` 和 `linux-ts-freshness-20261005-*`；这不补足旧全仓执行集合的缺失证据。

### b50c122c：Linux 后代停止证明与临时目录完成记录

旧 Linux 入口只证明进程组为空，不能证明调用 `setsid` 的后代已经退出。新入口由独立 C subreaper 启动 target，并作为所属树的 wait/reap owner；target 已回收后，必须得到全局 `waitpid(-1, WNOHANG)` 的 `ECHILD`，才出具 `treeStopped=true`。`/proc/self/task/<tid>/children` 只提供候选，不以空列表替代停止证明。向后代发信号前核对 PPID、starttime 和 pidfd，再通过 pidfd 发信号，不按裸 PID 盲杀，也不扫描全部同 UID 进程。

target 返回 0 但仍有逃逸后代时，该测试失败为 `OWNED_TEST_DESCENDANT_LEAKED`；仅在后续取得整树停止证明后才清理对应目录。缺 helper、缺内核能力、缺失或矛盾的回执、异常退出均保留不确定状态。异常退出时后代占用 stdio 不再使父端无限等待 close；drain 到期仅断开父端，不据此声称后代已死。receipt 与外层 IPC 都拒绝“失败原因却搭配成功退出”等矛盾组合。Windows Job 路径继续独立验收。

Linux 必须显式运行 `npm run prepare:owned-process-guardian`。bootstrap 使用独立 source snapshot，编译到 UUID 命名的不可变 binary，验证常规文件、链接数和摘要，再以同目录 manifest rename 作为唯一发布点。`build.v2` manifest 绑定 `binaryFile` 与 hash，旧 v1 需重新 prepare。进程在发布前被 SIGKILL 时，旧 active binary 与 manifest 保持配对；新孤儿 binary 和 attempt 留证。此测试证明进程中断安全，不外推断电/fsync 持久性。

嵌套 owned wrapper 在自身取得停止证明并清理目录后，向仍匹配的父 ledger 写入独立 completion；记录绑定父/子 token、owner ID 与精确 root。父端遇到缺失目录时，只有匹配的 completion 才可认定清理完成。缺回执、错绑定、未知状态、root 重建均失败并保留 ledger；“清理后、写 completion 前”中断也不能推定成功。通用 `owned-temporary-directory.dispose()` 的幂等语义未改。未完成清理时根据当前 root 分为 `retained` 或 `unproven`，保留原 cleanupError；显式 `childExitCode:null` 不再被 `??` 替换成 signal 映射的 143。

负向及平台证据分开记录：

- 旧实现的真实 `setsid` 行为负例失败；旧 adapter 的两项矛盾 receipt 负例失败；旧 completion 行为修正 fixture 后 **8/8 报红**。首版 fixture 的 SyntaxError 和补丁上下文冲突只是验收脚本问题，另存原日志，不计作产品红例。
- `guardian-v6-native-20261005-*` 在独立 scripts-only Linux 副本上使用 **GCC 13.3** 编译生产 helper，随后 **61 passed / 0 failed / 5 Windows skipped**。涵盖 pidfd 不可用、不完整 children 列表、wait/reap 不一致、进程反复产生后代时的 deadline、exec 后私有 fd 关闭、缺或过期 helper、stdio 不关闭，以及真实退出 0、退出 7、SIGTERM/143、exec 缺失/127。编译器故障与原子发布 fixture 使用受控 compiler seam，不冒充真实 GCC 编译。
- 原子发布旧红测试先按旧 schema v1 种下真实 active pair：中断发生后 manifest 未变，但旧实现覆盖了 active binary。新 v2 流程保持配对。没有用 v2 种子测试不认识该格式的旧代码。
- 最后一次 owner 状态负例以真实 SIGTERM 和受控文件 I/O seam 复现 `null` 被改成 143；修复后 Linux `owner-state-signal-green-20261005.*` **34/34**。生产源码没有增加测试环境后门。
- Windows `guardian-windows-final-20261005.*` 为 **36 passed / 0 failed / 27 Linux skipped**，包含 5 个实际 Job 回归。跳过不计通过。Linux 本机没有 Clang，v6 编排明确 `prepare-clang=unavailable`、最终退出 98，不能称整个编排全绿。

上述 Linux 副本仅用于 Guardian/owner 测试，不是完整应用构建。生产 helper 的 source SHA256 为 `983d492423c7fd3c0778fd47020df7d410b6b34687acf2f928a830ff482e1a03`，该 GCC binary 为 `a2a796fa13c372d79e19c421dcaa3c13eda9bcfb183ba50eb73e2544a3d0a87f`；测试宏未进入生产编译参数。此监督器覆盖同 PID namespace 的普通后代树，不是针对同 UID 恶意篡改、namespace 逃逸或 cgroup 的安全沙箱。

Bridge 构建指纹新增 bootstrap、Linux adapter 与 C source 三项输入，不绑定 ignored binary。旧输入表在 helper 修改后仍报 fresh 的行为负例已复现；修复后 receipt fixture **20 checks passed**，Linux receipt fixture **5/5**，后者在 Windows 执行，不冒充 Linux native build。CI 明确准备 Linux helper，completion fixture 进入两平台原测试行，bootstrap fixture 进入 Linux 条件步骤；没有删掉原失败检查。独立子代理静态审查发现的该 CI 缺项已补齐。

### b50c122c：最终集成验证

Windows 在相同产品源码上完成 typecheck、production build 和本地 Bridge publish，三腿退出 0。app source/output 为 `a366040936a231113d0bb15575897cc9b42c43ef4605a577eaeb7f3ce774df6b` / `212a56ba4f414126ebad9a70f45a3bc36d165c1e92dbc5baf0f89b0581c9ec5b`；Bridge source/exe 为 `40e3a55e4a84bad727601bb256b6e4714facc595d79f76b769df3229ed0ec334` / `5f32f1ce797302d324593c2f1c363bfd85a4ec4b215ad4a565bb3ed1e1db7221`。`SoulForge.Hksc.Native.dll` 为 `f493500446873336c41edff18a85e2fcf86dbc8dc5a97865bab05ffea09d8230`，构建验证 JS helper 为 `1dacc21f82ab95d25392f3a11fd403ece4ff60b8e4b19e1b3e0b4e690b86f5e5`，二者不能混称。

冻结 HEAD 后，Windows 最终 unit/required aggregate 为 **399 passed / 2 failed / 5 unavailable / 0 not_run**，耗时 14 分 16 秒。539 个调度位置、319 个独立 operation、220 个已执行后复用位置，`auditFindings=[]`，`completionVerified=false`。两项 failed 是没有当前 NSIS 输入的 `test:update:installed` 和 `test:update:all`，内层报告为 `blocked_environment`；没有借用历史输入或删除检查。5 项 unavailable 来自 scene 的 4 项未验证检查及 root 对它们的继承、全 Linux 的 bootstrap fixture、owned-process 的 24 项平台跳过和 owner fixture 的 3 项平台跳过。Bridge synthetic、5 个追加套件及尾部都实际执行。该系列最终退出 1，原报告不改写。

检查失败后仍执行 production E2E **14/14**（03:46:59Z–03:50:04Z），包括真实 PARAM/FMG、ACTION/MAP/纹理、姿态/多角色、Mod 2219 TAE 列表及错误态。结束后的 app source/output、Node/Electron SQLite binding hash 与运行前相同；回执为 `guardian-final-series-20261005.tsv`、`checks-guardian-final-20261005.report.json`、`production-e2e-guardian-final-20261005.*` 和前后 artifact observation。这不替代六类独立视觉验收。正式 Linux clone 的本轮重建另记，未将 scripts-only 副本混入。

随后为 b50 新建随机独立身份的真实 NSIS A/B，03:50:46Z–03:52:24Z 构建成功。manifest 为 `.local-validation/owned-update-installers/run-ryu8z2/manifest.json`，SHA256 `bb82a5374d11000a0cc38203c1f5a4a9b615c42cc40ea82ccf886a4cf409e1ae`。原 `runSuite('all')` 得到 **9 passed / 1 failed**：A 安装启动、B 替换启动、卸载、registry/profile 清理都执行完，但最后再次绑定输入时 `trackedDiffSha256` 不一致，因此整项安装仍失败，不按操作数量改判通过。

根因随后在原源码上复现。30 次实际 `git diff HEAD --binary` 的原始 Buffer 均为 SHA256 `f75b282dc5341cb6e19270c9a99c2139e5e48ebb987e1dc08f1f1bd1de3d60ef`；两次收到 `[8192,4469]` 字节分块时，`runProcess` 的独立 `Buffer.toString()` 将跨块中文破坏为 3 个 U+FFFD，返回字符串的摘要恰为安装失败时的 `128678854d6c243c6d046a29b96f02a7a62c85cdbef4d097d98a5f9d7275b914`。两路 stdout/stderr 的逐字节中文与 emoji 输出也复现损坏，没有触发输出截断。这是输出解码缺陷，不是输入真的变动，安装守卫的 hash 检查不应放宽。失败与诊断分别保存在 `update-all-guardian-final-20261005/`、`subprocess-utf8-diagnostic-20261005/`，修复和补跑另列。

本轮未重开付费模型 campaign 或真实 Mod 内存实验，旧结果只保留原提交与依赖范围。

### d150312a：跨块 UTF-8 输出不再损坏输入指纹

普通 subprocess 与 Linux Guardian adapter 现在共用 `subprocess-control.mjs` 内的 `StringDecoder` 收集器，stdout/stderr 分别持有解码状态，关闭时幂等 flush。不改变实际命令、参数、stdin 或回调收到的原始 Buffer；receipt、取消、超时与停止证明的规则不变。保留 UTF-8 字节上限，尾部截断若落在码点中间，就舍弃不完整首码点，避免 U+FFFD 使输出反而超限；末尾非法或不完整字节仍按 Node 规则解码，未被悄悄当作空内容。输出被截断时，输入指纹检查仍拒绝使用它。

新增回归在旧实现上准确复现 stdout 的 10 个 U+FFFD；修复后 Windows 8 组与保留的取消/超时、默认 2 MiB 输出限制检查通过。30 次真实 Git diff 的 raw bytes 与返回文本全部一致，原 callback 字节未变。Linux 受控 helper 经真实 adapter API 的旧红/新绿另存；又运行实际 GCC C Guardian，目标逐字节输出中文/emoji，stderr 末尾含不完整 UTF-8，输出与独立字节期望相符，并得到真实 `treeStopped=true`。此后 Guardian/owner 全组为 **59 passed / 0 failed / 5 Windows skipped**。回执为 `subprocess-utf8-regression-red-20261005.*`、`subprocess-utf8-regression-green-20261005.*`、`subprocess-utf8-diagnostic-green-20261005/` 和 `linux-subprocess-utf8-20261005-*`。

没有增加第二份 helper 文件；现有 Bridge 输入表已覆盖 `subprocess-control.mjs` 和 Linux adapter，owned installer 又经 Bridge source/receipt 传递绑定，不能复用 b50 的安装输入。两平台 CI 的既有 native 步骤增加原 subprocess fixture 调用；这是工作流接入，本轮未推送或启动托管 CI。Windows 当前源码的 Bridge、A/B、自动检查与 E2E 已重新执行，结果见下一节；正式 Linux 系列另行记录。

### d150312a：Windows 最终检查及真实安装

源码冻结后，typecheck、应用 build、Bridge publish 均退出 0，随后重新构建独立 A/B 安装输入。`checks-utf8-final-20261005.report.json` 为 **401 passed / 0 failed / 5 unavailable / 0 not_run**，实际耗时 15 分 38 秒；539 个调度位置、319 个独立 operation、220 个已执行后复用位置，`auditFindings=[]`。Bridge synthetic、追加原生套件、强制当前 TS 编译和末尾 domain-service fixture 均有实际执行记录。5 项 unavailable 分别为 scene 的 4 项未验证检查、root 对它们的继承、全 Linux 的 bootstrap fixture、owned-process 的 25 项平台跳过、owner fixture 的 3 项平台跳过；`completionVerified=false / ok=false` 保持不变。

`test:update:installed` 与 `test:update:all` 两个入口均实际执行并通过。原 `all` aggregate 为 **10/10**：3 个 unit、6 个 process-integration、1 个实际 NSIS A/B 用例。A 安装及启动、B 替换及启动、卸载、registry/profile 清理和最终输入再次核验均完成，未再出现 b50 的 UTF-8 指纹误报。两份 payload 各 2105 项，仅归一化版本后的摘要同为 `273fadc4aab65f2a77a8ff89e438d2243013a8441165f68d835b6352adb18844`；manifest 为 `.local-validation/owned-update-installers/run-6GTus7/manifest.json`，SHA256 `21bf01d56c1583505d457f1623e08842f0b3d0574703a15bc9e6d73d189ddc71`。

默认更新输出已逐文件核对并保存到 `.local-validation/closeout/update-default-d150312a-final-20261005/`，304 份文件、783,095 B；复制清单为 `update-default-d150312a-final-copy-20261005.json`。这不改变此前 b50 的 blocked/failed 记录，也不提升为正式产品身份、官方自动更新或不同源码版本的兼容证明。

自动检查返回 1 后仍继续执行生产/真实资源 E2E，**14/14**，耗时 3.1 分钟；包含实际 PARAM、ACTION/MAP/texture/pose、多角色、Mod 动画总数与读取失败态。最后一腿再次校验 app source/output 与 Node/Electron SQLite 两份 ABI，均与系列开始相等。完整顺序为 `utf8-final-series-20261005.tsv`，E2E 回执为 `production-e2e-utf8-final-20261005.*`，并保留前后 `artifacts-*-utf8-final-20261005.json`。

当前 Windows app source/output 分别为 `a366040936a231113d0bb15575897cc9b42c43ef4605a577eaeb7f3ce774df6b` / `212a56ba4f414126ebad9a70f45a3bc36d165c1e92dbc5baf0f89b0581c9ec5b`。Bridge source 为 `d38ecf883dc7861f1e1743a6d54b4d83e7f9c5687f905de3f6208b234d483843`，exe 为 `709d9dc3e12d4e98f632efcf35d4a7340c689b58df2a923f32b2d51744e77c91`，真实 `SoulForge.Hksc.Native.dll` 为 `89120a9b4bba4e12641ae7cb52ea237fe47fc8c123fcba545607491293ab8ed0`；构建验证 JS helper 为 `1dacc21f82ab95d25392f3a11fd403ece4ff60b8e4b19e1b3e0b4e690b86f5e5`，不能与原生 DLL 混称。系列完成后 `bridge-after-utf8-final-20261005.json` 再次确认 fresh。

Node 为 v24.14.0 / ABI 137，SQLite 3.53.2；Node binding SHA 为 `e75b8c024a85179d8e0e51203a8b8867916e9a51327ce3953db5f8483cc9a91e`，Electron binding 为 `8110840146c90d0149a187c5a9d00aaba3e702b1b3042ea760edb6a2aa4b8616`。release-compliance 输出仍为 partial：127 present、1 metadata-only、25 not-installed，构建成功不替代完整发行合规审查。

### d150312a：Linux 独立构建、原生绑定与停止证明

Windows 系列结束后，独立 clone `/home/asus/soulforge-validation/closeout.8pH2CC` 从 `7a8c8f4d` 快进至同一 `d150312a`。`2026-10-05T04:38:39Z–04:43:40Z` 的 **16 腿全部实际执行、退出 0**：Guardian prepare、typecheck、build、Linux Bridge publish、C#、产物快照、Guardian/owner fixture、subprocess、registry fixture、Bridge receipt、Bridge synthetic、renderer、当前 core 直接 TS 检查、真实 Electron database binding、结束产物快照和 source-status。没有因前段失败而省略尾部，也没有与 Windows 重型实验并行。

具体断言为：C# **161/161**；Guardian、owner、bootstrap 与 temporary-directory 4 文件 **73 passed / 0 failed / 5 Windows skipped**；check 与 Linux Bridge fixture **40/40**；Bridge receipt **20 checks**；subprocess 原 8 组通过；renderer **1502/1502**。core 直接入口实际先执行 `tsc -b --force ../shared .`，再运行当前产物，报告为 1 passed、2 个 operation 均 executed；它不是依赖既有 dist 的空通过。真实 Electron smoke 验证生产 SQLite binding、查询/记录与重启；不冒充真实 Electron transport 的超时注入。

Linux Node 为 v22.22.2 / ABI 127、SQLite 3.53.2。app source/output 为 `19bbc9deb93fc73b46ac6290e1c2bc04eba903a07db5b2da420fdeb8c8a9ab08` / `7f5db05a7abc8da060b26f16eaf49320df631b033969002c2b72d1a475946230`；Bridge source/exe 为 `bcbf0d79f5788d33d73092eac397474116dd334163dd059f4299df2feeed8e5f` / `9f3f6230a3e5e6cf4200fe204ffff140c8cb7fc6a91a16735f1b1e2649181dc9`，原生 `.so` 为 `381a663fa3f5913aa87c4e361e09ac4db2886343ad248756839f6d5358621e4d`。Node/Electron bindings 分别为 `df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a` / `f3c039208a2798246ae2e0bcd3a90f8c43b7e07755a7f71941b6ae28f6df4857`。两平台各自绑定实际字节，不要求不同换行/平台输入的 source hash 相等。

真实 GCC 13.3.0 生成 build.v2 Guardian；binary SHA 为 `a2a796fa13c372d79e19c421dcaa3c13eda9bcfb183ba50eb73e2544a3d0a87f`，manifest SHA 为 `789036b68ad94965a663b528c774bb3c6ff421dcfb5d4ee6d75c828426bb8317`。前后 app、Bridge、bindings、Guardian 均相等，依赖、ABI 和构建根未链接到 Windows；clone 最终仅有原 `.npm-cache/` 未跟踪。该环境没有 Clang，本轮没有将 GCC 通过写成双编译器通过；5 项 Windows 专属测试仍是跳过。

回执为 `linux-utf8-final-20261005-results.tsv`、各腿 stdout/stderr、`linux-utf8-final-20261005-current-core.report.json` 与前后 `linux-utf8-final-20261005-artifacts-*.json`。这 16 腿不包含 Linux 全仓聚合、真实 GPU、六类独立视觉参照或官方安装/更新；WSL 外层 UTF-16 localhost 代理警告与既有编译警告原样保留，不混为子进程 UTF-8 分块回归。

## 上一轮 efdbfcab 的集成验收

`2026-10-04T22:19Z` 冻结代码于 `efdbfcab`。此前 `db534685` 的 Windows 构建四腿、原生五腿及真实 Mod 双轮已经完成。最后一笔提交只改安装验收 helper 与两个 Node 测试文件；重新核对 app source/output、Bridge source/exe/native library 指纹均未变化，因此下列原生与内存证据仍只按其已测依赖复用，不伪称全部在新 HEAD 重跑。回执为 `.local-validation/closeout/final-dependency-reuse-20261005.json`。

该 HEAD 的安装守卫三文件轻测为 **26/26**；真实 pinned FileMatcher 探针也通过。真实 A/B 构建、现有 `runSuite('all')` 的实际安装腿、自动检查、E2E、Mod 地图和 Linux 均已结束。自动检查有 3 项失败，整个系列最终退出 1；尾部没有被省略。仅把三个 installer contract 文件列入 unit 不能算运行了安装；本次另设 `update-all` 腿和独立报告目录，历史 2f3d 的 A/B 不替代此轮结果。

验收私有证据统一位于 `.local-validation/closeout/`，不提交语料、凭据、heap snapshot 或安装包。首次启动私有 PowerShell 编排脚本因 UTF-8 无 BOM 被 Windows PowerShell 5.1 错读，解析失败、没有启动任何验收腿；保留原脚本及 `series-encoding-preflight-20261005.json`，另存带 BOM 脚本后通过解析。只调整验收编排外层总等待窗口以容纳串行各腿，产品时限与各回归上限未变。

### efdbfcab 的真实安装

`22:19:56Z–22:21:35Z` 由实际 electron-builder 26.16.1 生成随机独立身份的 A/B，未使用正式产品身份、签名或发布。每份 payload 均为 2105 项；只归一化 `package.json.version` 后摘要相同，为 `1c2f112b37476074ed9f09d4cb6e1370905822e738b942a59c92fe1fde670251`。产物位于 `.local-validation/owned-update-installers/run-BqNqOL`，manifest SHA256 为 `32c3636fbdf05456659cc51d834803b83197b0ffda1f43ce1a76abaced3ba87d`。

随后实际执行更新 aggregate，**3 个 unit case、6 个 process-integration case、1 个 installed case 均通过**。installed 腿真正调用 A 的 NSIS、启动已安装应用，再在同一 owned 目标用 B 升级并启动，读取真实主进程版本/profile/package 回执；最后执行卸载，并核对临时安装、registry、shortcut 清理及正式 registry 未变。回执为 `update-all-closure-final/all/report.json` 和 installed run `2ae947cb-4225-49fc-a678-ab6efe95e1ad`，不是 fake installer 端口结果。

这仍是同源码、不同版本元数据的无签名实验，不证明应用发起的官方 feed/download/quitAndInstall、不同源码跨版本兼容、正式安装升级、SmartScreen/UAC 或跨机安装。构建和安装后 app source/output、Node/Electron SQLite 两份 ABI 文件 hash 均与本轮开始一致。

### efdbfcab 的自动检查与 E2E

`checks-closure-final-final.report.json` 实际执行约 14 分钟，结果为 **397 passed / 3 failed / 3 unavailable / 0 not_run**；494 个调度位置、314 个独立 operation、180 个已执行后复用位置。`completionVerified=false`，没有把 aggregate 的静态尾部可达算成运行。三项失败分别是：

1. desktop live-editor 静态契约仍要求已被 loose BND4 重构移除的 `isRealNativeBndContainer`；同轮真实 service 行为 fixture 通过，但不能由它把此失败改记为通过。
2. desktop smoke 的嵌套 owned 路径中，Windows guardian 创建 278 字符的 pending proof 失败，尚未执行到测试期望的 native snapshot 篡改拒绝。最终 proof 路径短约 42 字符，不能由其已创建推断 pending 也可创建。
3. Windows temporary-reader 测试未在 8 秒内观察到 pending；旧测试失败清理时丢弃了 writer 的退出结果，尚需按实际嵌套 TEMP 环境补诊断，不能仅以父 shell 的短 TEMP 路径判定根因。

三项 unavailable 来自 scene 独立输入及平台专属跳过；根 `test` 聚合保留其 scene 跳过，不能按进程 exit 0 算完全通过。Bridge synthetic、追加的 EMEVD 四组与所要求尾部检查均有实际执行记录。自动检查失败后仍继续执行：生产/真实资源 E2E **14/14**、相关 renderer E2E **21/21** 通过；包括当前 Mod 的 2219 动画总数与读取错误态，不是旧版本的 85 项整套重跑。后续 Mod 地图及 Linux 结果单列。

### efdbfcab 的 Mod 地图与 Linux

`m11_00_00_00` 在独立生产产物快照 `41c95aadfe4c016d4576ac3a5faa5cd0073553be1eae6d8fc367d1cab3c59fdf` 上实测：**753 loaded / 0 failed / 20 unavailable**，773 项处理完整、scene error 为 0。UI 加载 **106,708 ms**，前台可见条件有效，RAF 最大间隙 **220.5 ms**；260 秒/400 毫秒的宽松回归上限通过。`smoothInteractionPass=false`，有 34 个测量阶段可见长帧，不能写成“地图已流畅”。实际上下文为 WebGL2，截图显示地图几何；这不是与游戏/成熟工具的独立画面一致性验收。没有并发 Agent、没有源 Mod 写入，也没有测原生取消；一次较快结果不作冷热缓存或统计性能胜负结论。

原记录为 `mod-map-m11-closure-final.*`，完整报告和截图位于 `output/playwright/map-streaming-native-m11_00_00_00-normal-2026-10-04T22-45-14-902Z/`。早先 231.6 秒、1004 ms 及前台条件不完整的失败保留，不被本次宽松通过覆盖。

这份 MAP CPU profile 已作只读定位：`MapPageProgress.accept` 的 self 样本约 7.92 秒，完整响应包的 `JSON.stringify` 是该函数明显的待核对开销；它同时承担累计 256 Mi 字符的完整 envelope 预算，不能为提速直接删除，或只计 Base64。`MapGeometryPrepareClient.pump` 约 3.01 秒涉及向 worker 发送 chunks；`texSubImage2D` 约 1.10 秒是 CPU 采样，不是 GPU 执行时长。

39 个角色预览调用的 main Bridge 等待累计 113.37 秒，其中 23 个文件后备响应的 artifact 请求累计 63.44 秒、物化累计 65.28 秒；这些并发区间重叠，不能相加解释 106.7 秒墙钟。相较之下，该组原生 FLVER read 累计约 55 ms。静态 MAP 的部分 BND/FLVER 阶段缺计时，报告仍为 `criticalPathVerified=false`。下一步应关联逐调用的模型、排队、artifact 字节及往返，并将 renderer 计数/发送阶段与长帧对齐；目前不能把问题归为“原生 FLVER 解析慢”，也不能凭 CPU 的纹理上传函数样本推断 GPU 瓶颈。该分析没有引入新代码或新 GPU 实验。

Linux 独立 clone 快进到同一 `efdbfcab`，**18 腿全部实际执行且退出 0**，包括末尾的数据库绑定、Node ABI 和工作区状态。C# **161/161**、renderer **1502/1502**；owned-process 为 **11 passed / 4 Windows skipped**，不能写成 15 项都通过。Node 22.22.2 / ABI 127、SQLite 3.53.2 实际加载；独立依赖与编译产物没有链接到 Windows。最终仅保留原有未跟踪 `.npm-cache/`。记录为 `linux-closure-final-final-results.tsv` 及每腿日志。

Windows 临时目录的前后有限名称快照均为 4383 项，`newlyPresent=[] / noLongerPresent=[]`；没有据此清理未知目录，也不称全系统零残留。整个串行系列因自动检查失败最终退出 1，尾部实际完成；它不是全量验收绿灯。

## 本轮新增实现

1. **预算贯通**：桌面默认 200 步、30 分钟整次时限，保留 `timeoutMs` 的 180 秒单次请求语义。宿主归一化有效预算，贯通 UI、utilityProcess、内核事件和报告；金额模式可选，未知 usage 不当作零，CLI 既有参数语义不变。
2. **TAE 有界搜索**：底层仅保留有界候选，按动作分页；游标绑定查询、工作区和内容快照，禁止全量命中后截断。超大单词条不突破预览预算，转交原生定向续读。
3. **TAE 写入事实与 proof**：canonical action URI 不再被旧正则误拒；TAE 不再被泛化的 event 判断误标为 EMEVD。同动画号不同 section/event 的 proof 不能混用。提交后回读失败保留 `opId`、备份位置，报告未验证，不伪造 after 值、不自动重放。
4. **真实 FMG/BND4 缺陷**：FMG v2 使用 64 位字符串偏移；文本替换保留源布局，仅追加新字符串并修改指针。BND4 保留未知 metadata/hash 区域、间隙与尾部字节；无法安全重建的扩展 hash 索引结构修改明确拒绝。原生文本 reader revision 升至 2，旧语义缓存失效。
5. **历史数据库迁移**：v13 只接受经历史源码复算确认的尾随空白 checksum 对；v14 的旧 `state_json` 与新规范化结构不同，必须先一致性备份，再在事务中转换全部 generation/page/claim/blob/CURRENT，并回读比较。冲突、未知字段、外部依赖、超大快照、未知 checksum 拒绝；提交前失败原子回滚。
6. **Windows 验证环境**：构建子进程 PATH 归一化，PowerShell 缓存落入 owned 目录；受控 rename 只对 Windows 短暂共享冲突做有限重试。新增随机独立应用身份的 A/B 安装包输入，保留原 installed/all 检查，不以删除失败步骤让 CI 变绿。
7. **一次性治理盘点**：`REFACTOR_CONSTRAINT_AUDIT.md` 记录约束、实际检查、运行位置、负例和保留理由；旧登记迁移清单是审计产物，不是新的登记门禁。
8. **MAP 二进制投影**：真实 Mod 地图中，通用路径脱敏将合法 Base64 的 `/...` 片段改写，造成 737 个几何失败。最终实现由可信 IPC 通道与精确 DTO 路径选择二进制字段；返回对象不能自报通道取得豁免，诊断与错误子树仍必须脱敏。
9. **提交后异常与启动清理**：TAE times/fields/insert 的回读拒绝、超时及投影异常均保留已提交回执，禁止自动重放；损坏 schema 不折算为缺少约束。Agent 准备阶段、同步 dispatch 与异步执行失败均释放对应 Core Session 和 active 记录。
10. **独立复核修复**：BND4 变长 payload 追加到原文件末尾，未知 gap/name/hash 地址不移动，非空 payload 与头表重叠时拒绝；读取不再被不可用的结构写入自检阻断。数据库外部 FK 检查遵循 SQLite 的 ASCII 大小写规则，避免退役旧表时级联删除扩展表。
11. **验收产物绑定**：Windows 独立 A/B 安装器记录实际嵌套 production source/output 指纹，打包前后检查输入未变化；缺指纹的旧回执不能作为新验收通过。
12. **BND4 重叠写保护**：真实执行确认，同址或部分重叠 payload 可能使写入被覆盖，也可能修改未请求的条目；payload 还可能覆盖 reader 已识别的名称。新增返回前字节核对，冲突明确拒绝，保留合法 alias 的读取、no-op、一致写与安全追加。15 个新增用例中，12 个负例在旧源码上失败；同一测试输入在修复后全部通过。
13. **大库只读打开**（`c24724b0`）：只读连接没有迁移，却再次运行完整 `quick_check`。现在保留首次完整性检查，仅 writer 在迁移后再次检查；真实坏页及 writer 迁移产生非法记录的拒绝测试仍执行。未改变 writer 迁移、备份与事务流程。
14. **重挂、切换和退出**（`ab93e826`、`11015cda`）：scan 与 base remount 共用目录、指纹、索引生命周期，修复重挂后的空目录；跨 facade 串行挂载，区分物理目录与会话代际，拒绝 A→B→A 的过期请求。取消后不得重新发布旧目录；退出先拒绝新工作，等待所有未结束分析、ACTION、索引及真实 RAG tail，再关闭 Bridge/数据库。重复退出请求也等待同一清理过程。
15. **Windows Job 回执**（`08793a75`）：对安全的共享占用错误 32/1175 最多尝试 6 次，累计退避 775 ms；每次检查原回执、pending 内容及非 reparse/目录身份。不删除原目标、不重跑 driver，部分移动、权限等错误立即失败。新增 helper 纳入 Bridge 构建输入指纹。
16. **TAE 共享时间表**（`5308b0d6`）：变更共享槽、拆分点事件及插入时，按动画追加完整时间表并同步偏移、计数和已知事件指针；保留原表和其他动画。处理已证实的私有空名字别名，拒绝共享 miniheader、结构重叠、未知时间指针及会延长末事件参数的 EOF 布局。18 个 C# 用例和 11 个真实 Bridge synthetic 用例通过；真实 Mod 与独立 reader 的结果另列。
17. **独立 producer 退出屏障**（`10d9b8f8`）：独立复核确认，workspace 清理没有涵盖另一个语义刷新服务的真实尾部，embedding 的旧 `close()` 也会在数据库读取仍未返回时结束。现在先同步停止 Agent IPC、会话、语义刷新、embedding 和 workspace 的新任务，再等待各自持有的准备、执行、超时后未结束的宿主操作及 worker termination，最后释放 Bridge/数据库。可复用 embedding `close()` 与永久 `dispose()` 分开；旧 worker 的 error 不能清掉替代 worker。已提交的 Patch 事实不由取消改写。此屏障覆盖明确列出的 producer，不宣称任意 IPC 的所有在途操作均已纳入。
18. **PARAM 投影与物理行身份**（`30b4b89f`）：提交后刷新与初始 canonical 投影保持一致，避免无关字段使全表 chunk body 改变；定向读仍返回明确请求的原生字段。读入索引时使用原生 child 身份，保留重复 ID 的不同物理槽，拒绝混合版本及含混物理身份。
19. **Agent 同步准入**（`ee46d07e`）：先登记在途 promise，再同步执行工作区身份捕获；保留 shutdown 对真实尾部的等待，修复同 ID 替换和 A→B→A 负例发现的回归。
20. **测试保持独立判断**（`1e4a9361`、`842bfeba`）：重挂区分目录扫描与 readiness；TAE 造样器同步时间表 header。搜索字节预算可能使请求的 7 个预览只交付 6 个，续页须从实际交付末尾开始，测试不再把请求页长当成已交付量。
21. **TAE 交付完整性**（`452fcaa9`）：搜索响应的 `eventsComplete / eventsTruncated` 明确指本次交付窗口；内存索引的完整覆盖另记为 `indexedEventsComplete`。索引搜索与 RAG 候选保持同一语义，源索引不变、字节预算不变。旧实现交付 1/296 或超大事件零预览时仍声称完整，真实行为负例报红；修复后 9 项局部检查通过，包含 Agent envelope。
22. **大资源工具启动目录**（`c93ca3c1`）：真实官方 WitchyBND 暴露 Windows `Process.Start` 对过长 CWD 的限制。暂存目录改为 cacheRoot 下的短 UUID，完成缓存仍由源内容和工具配置双 hash 定址；取消、不完整解包及工具配置漂移均不得发布。没有提高 64 MiB 读取边界或增加重新打包入口。
23. **测试进程与临时目录**（`86aa932d`，后由 `b50c122c` 补强）：`check` 的实际 operation 与直接 root `npm test` 使用独立临时目录；取消后不派发后续步骤，未执行项保留为 `not_run`，普通超时不阻止其他独立套件。嵌套入口验证父目录身份后分配独立子目录。最初的 Linux 进程组路径不能证明 `setsid` 后代已停止；现已改用 subreaper 与完整停止回执，缺证明即保留，详见最新小节。Windows Job 独立验收，嵌套 npm 仅消除下一层将重新添加的精确 `.bin` 项，不截断未知 PATH；大于 2 MiB 的子进程结果等待 IPC 发送完成后退出。
24. **原生验收完整收集**（`8378fb23`）：DCX 检查使用生产 Bridge daemon 与文件型 artifact 传输；已完成结果由消费者取走后才从并发集合移除，拒绝结果丢失、重复或错配文件。大包只读缓存与 DFLT 往返分开记账，逐项核对原容器身份、源哈希、7535 个叶条目的身份和只读声明。未削弱旧 CRUD 断言；本轮这些断言实际报出的失败仍保留。
25. **扫描遗漏不能报完整覆盖**（`f5b00848`）：完成度矩阵保留 scanner 诊断，目录读取或文件 stat 失败时，即使已索引文件与打开结果数量相等，也不能报覆盖完整；零文件加扫描失败不再伪装成健康空集。哈希失败与漏枚举分开记录，已执行的读取失败优先于版本未验证。历史备份和 opaque binary 的排除数量及原因单列。旧源码注入复现了 3 类行为错误；另外 3 项旧版失败只是缺新增报告字段，不计作 3 个额外产品缺陷。修复后新 6 项与保留的旧 25 项 fixture 全部通过，typecheck 通过；这不是操作系统 ACL 或真实原生读取实验。
26. **原生失败子项留证**（`d6359c0b`）：DCX 失败回执保留有界的 CRUD 原因、往返和未知字段保留布尔，缺失值仍为 `null`，不整包复制 payload，不将“不支持结构写入”改成通过。独立负例同时暴露 DFLT 嵌套 BND4 在 `entriesIdentical=false` 或缺失时仍报往返通过的问题，现已拒绝。新 4 项旧版报红，修复后原生读取与扫描共 35 项通过。KRAK 的验收仍是原生读取加 CRUD/字段保留，不声称压缩容器字节往返；两种判据不混用。
27. **独立脚本与容器分流**（`b8fe13f5`）：完成度矩阵不再把裸 `.hks/.lua` 送去取 BND4 引用表，而是复用明文判别/解码与现有 first-party HKS 原生入口；加载计划也列出实际使用的 `readScriptSource`。原 UI 面板本来已经正确分流，本修复不能描述成“修好了 UI 无法打开 HKS”。容器证据接口收到 `containerType=none` 时明确拒绝，不编造子项 slot；BND4 引用表失败仍不通过。主代理复测修正了 7 处严格类型错误，随后 typecheck 与 42 项相关检查通过；真实 HKS 读取能力另行验收。
28. **可信 PARAM 元数据复用**（`4c16196e`）：模块内 WeakMap 只登记成功校验后由本模块返回的精确、深冻结 package 对象，不登记外部输入；冻结、摘要或相同结构不能冒充已验证身份。重复匹配仍检查每次传入的 descriptor 与 trust policy，`nativeFormatAuthority` 仍为 false。旧产物在相同输入上的身份复用断言报红，修复后 7 项通过；外部对象嵌套变更、伪造摘要、Proxy 与 accessor 负例保留。主代理 typecheck 发现一处重复断言造成的 `never` 分支类型错误，`3c5dc760` 删除冗余断言但保留明确失败分支后通过；该编译错误不计作额外产品缺陷。
29. **Bridge 分片组装**（`e6bad28e`）：只在新到达的 stdout chunk 中找换行，未完行按约 16 KiB 分块，到完整行时合并，不再为每个 chunk 展平累计前缀。保留 UTF-8 decoder、整 chunk 的双帧缓冲上界和单帧协商上界；fatal transport/protocol 错误释放碎片。`dispose` 关闭新请求准入不等于停止接收：宽限期内仍接收已派发请求和取消后的真实终态。13 项回归与 200 帧 fake-daemon smoke 通过；真实字节输入的旧版线性扫描断言报红。没有提高帧上限或放松原生权限。

30. **更新下载后保留重试入口**（`74a00c4b`）：用户选择稍后安装时保留已下载版本和 `blocked` 状态，不再进入丢失版本信息的 `error` 状态。随后确认安装仍重新检查文件哈希和活跃 Agent、事务、回滚阻塞；篡改下载文件不能利用重试绕过校验。真实 service 配合 fake Electron/updater/HTTP 的 3 项负例先红后绿，没有访问用户安装或 profile，不作为真实自动更新验收。
31. **PARAM 检查身份去重**（`199b41b9`）：带 payload 与不带 payload 的延迟读测试使用不同名称，原有断言不变。16 项工作区延迟读取 fixture 通过；测试名称唯一不等于新增行为覆盖。
32. **loose BND4 原生枚举**（`af7081e2`）：主进程最多读取 8 字节作路由，处理短读并关闭句柄；裸 BND4 进入现有 `list-bnd4-entries`，DCX 保留原路由，真实 BND3 明确不支持。C# 复用既有 parser，新增整档读取受 64 MiB 限制；大资源仍由前置只读缓存处理，未削弱 WitchyBND 路由。SFBN 回退必须由精确 marker 或单一 DCX 读取错误加既有 reader 确认；ROOT/权限/Oodle 混合错误不得隐藏，unsupported/unparsed 不再变成成功空表。主代理复测 RAW 38 项及 C# 3 项通过。

C# 首次检查有 1 项失败：测试错误预期大于 64 MiB 的 BND4 会直接进入新增 reader，实际首先进入既有 large-resource cache，缺工具时报 unsupported。修正测试使其直接验证生产 reader 的限长，另保留正常命令分派和 DCX 测试；没有跳过大资源前置路由来取得绿灯。RAW 的 unavailable/空表区别另由行为负例验证。

主代理还从固定 Mod `c0000_a05x.anibnd.dcx` 只读解压出 **12,245,948 B、191 个条目**的真实 loose BND4，不重新打包；固定 SoulsFormatsNEXT reader 给出逐项 ID、名称、长度、内容哈希。b8 的生产 exe 实际返回 `BND4_LIST_FAILED`，因为它错误要求输入为 DCX。`db534685` 重建后，真实 CLI 的 191 项 ID、名称、长度及内容哈希全部与固定独立期望相等，原资源前后未变。回执为 `loose-bnd4-b8-red-20261005.*` 与 `loose-bnd4-closure-final.*`，独立语料及逐项结果位于私有 `loose-bnd4-independent-483120dae32f469ab39a1e87c3daaed9/`。这里只证明原生枚举，不外推 HKX 解码、编辑或画面。

### PR #56 后续提交的逐项继承

`2026-10-04T20:26:55Z` 的远端只读观察显示，main 仍为 `c4a8b158`，35 个 issue 仍开放，PR #56 的 head 已到 `c79e2d9b`。其中 8 个后续提交不是当前分支祖先；不能仅由两边继承同一早期提交推断修复已全部继承。

主代理逐项对照后，确认桌面预算和安装产物持久目录已有对应实现；更新重试、PARAM 测试名称、loose BND4、多文件审批、部分回滚及安装输入绑定差异已按本报告所列提交适配。没有整体覆盖当前更强的工作区 owner 检查，也没有自动引入远端新增的逐 case CI 登记门禁。`21:25:21Z` 再次观察时 main、开放 issue 数量和 PR head 均未变化，回执为 `remote-observation-closure-final-20261005.json`；本节记录候选实现来源，不表示 PR 已合并。

### 安装输入与实际工作区绑定

`db534685` 保留原 `--allow-owned-installation` CLI、一参数函数入口、随机持久 run 目录，以及原有 production source/output 和 tracked diff 字段。在此基础上，回执绑定当前 HEAD、实际 checkout、Bridge、构建资源、按 electron-builder FileMatcher 选中的 extraResources，以及列明的工具入口指纹。每腿前后重新采集；ASAR 与外部资源的差异只允许 `package.json.version`。旧回执缺少新输入或工具绑定时拒绝，安装 A/B 前与验收结束时再次核对当前 checkout 和输入；只有完整 manifest 落盘后才发布路径指针。

主代理对 3 个测试文件复测 **21/21**，包括选中链接拒绝、被过滤缓存和 Windows alias 不进入输入集合、每腿中的源变更、缺少绑定的旧回执、A/B 非版本 payload 差异，以及旧 HEAD/外来 checkout 拒绝。记录为 `installer-inputs-parent-preflight-20261005.*`，stdout SHA256 为 `55fc6a0730da7e95e24696858eea22c880bc079c4521f4eb0ec81cfb1df40706`。

开发过程中缺新字段的旧回执负例及第一次 orchestration 的 3/4 结果仅保留在工具输出，没有独立文件回执；不把早期 `installer-binding-red` 的另一项失败混称为这次负例。测试使用合成 checkout、fake builder/FileMatcher/ASAR；它验证控制流，不证明真实 builder、NSIS 安装或自动更新已通过，真实 A/B 另行执行。

独立审查进一步限定工具证据：当前摘要覆盖 builder CLI/package、FileMatcher/filter、ASAR 主入口和 Node 可执行文件，不包含所有传递依赖及 Electron/NSIS 缓存。实际安装的 builder 版本要求为 26.16.1，但本地辅助工具的依赖清单不是完整 lockfile。因此此处只能声称选定工具文件一致，不能声称整个工具链已锁定；实际安装包字节与 payload 的身份校验仍单独保留。

`efdbfcab` 随后补齐三类拒绝：用固定 Windows 路径语义阻止 `extraResources.to` 的绝对路径、drive-relative、UNC、上穿和不安全 Win32 名称；用实际 pinned FileMatcher 筛出桌面 `out` 文件，逐项要求它们已进入 Agent production output 的路径、长度与 hash 清单；拒绝尚未纳入模型的全局及 `win.extraFiles`。后者由 builder 写到 `resources` 外，不能让现有资源枚举漏掉它后仍报 A/B 一致。当前安全配置并未实际触发这些越界，修复针对配置改变后的假通过与隔离缺口。[Windows 文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)

在 `db534685` 基线上新增的三个目标负例为 0/3，另一个 extraFiles 负例为 0/1；修复后的三文件合跑由主代理复测 **26/26**，回执 `installer-guards-final-precommit-20261005.*` 保存提交前 diff hash。每种未支持配置均在 builder 调用和 run 目录创建前拒绝；旧的 21/21 与中间 25/25 不冒充最终结果。独立只读审查未发现这些守卫的阻断问题。

`installer-real-filematcher-frozen-20261005.*` 在已提交 `efdbfcab` 上使用实际安装的 FileMatcher：自建唯一 UUID 的 `.log` 被规则排除，`.js` 不在 Agent output 清单中而被拒绝；仅删除本次创建且 hash 相符的两个 marker，随后输入指纹恢复。它不执行 builder/NSIS，不取代下一步真实 A/B。旧红、26 项绿测及 patch 摘要保留在私有 `soulforge-installer-dest-binding-20261005` 证据目录，不覆盖早期失败。

### 多文件审批与部分回滚事实

`08b33519` 使主进程逐项解析审批目标，每个目标分别通过捕获工作区的安全路径解析，读前、读后核对 session 与 owner。非文本、拒绝或读取失败的目标仍有明确条目，只有 ENOENT 可标作新文件；每个 diff 有独立截断提示。切换工作区或取消后不发布旧磁盘 diff，不改变实际工具参数和执行权限。

文件级 inverse 不再把原操作整体标为已回滚。公共 DTO 仅新增 `partialRollback.rolledBackFileIndexes`，主进程先用原始路径及已提交 inverse 计算索引，再投影脱敏路径。原审计账本、opId 和 changedPaths 不改；resource-entry inverse 不被误当作整文件恢复。只有整操作 inverse 或全部文件均完成回滚才显示 rolled_back。

Agent fixture **46/46**、操作 fixture **22/22**、renderer **1502/1502** 通过。操作 fixture 包含真实临时文本文件、现有 Patch Engine 与内存 journal 的双文件事务：检查备份、逐文件恢复、重复回滚拒绝、部分回滚后整操作 CAS 拒绝，以及剩余文件发生外部变更时的 CAS 拒绝。它不是原生二进制或持久 SQLite 事务验收。统一 typecheck 首轮因新增测试的 React props 类型为 unknown 失败；仅补明确类型守卫后，`approval-container-preflight-typecheck-v2-20261005` 退出 0，没有放宽 strict。

独立复核保留两项限制：剩余路径被隐藏时，部分回滚后的 UI 没有可继续的文件入口；stale 卡片虽不展示旧磁盘 diff，仍可能显示已脱敏的原始提案字段，并提示主进程 diff 不可用。后者不赋予新工作区写入权，工具仍拒绝 workspace replacement。原始红绿记录在 `agent-proposal-rollback-282441c6332e464181680b92a4de09d4/`，不由后续通过覆盖。

### 两处分配修复的受控微基线

主代理在 `3c5dc760` 的 TypeScript 编译产物上复测 20 项新增测试，全部通过。此时 Linux 测试清理文件仍有独立未提交改动；下表只绑定两个实际加载模块的 SHA256，不声称整个工作区已冻结或完成 E2E。两边均为 Node 24.14.0、64 KiB inspector sampling，计入已被 GC 的分配。

| 固定输入 | b8 旧产物 | 修复产物 | 限界 |
|---|---|---|---|
| 已取得同一个 first-party package 后重复匹配 48 次 | 估计分配 3,029,768,368 B；2,749.7 ms | 789,528 B；1.86 ms | 初始化校验在采样外；不等于所有 schema 免费校验或零分配 |
| 同一 16 MiB JSON payload，64 KiB 分片，完整交付一帧 | 2,189,365,288 B；435.4 ms | 33,554,488 B；27.37 ms | mock `handleFrame` sink，无子进程、握手或事务；不是原生端到端性能 |

PARAM 新模块 SHA256 为 `acb209b60fb4a5d2ae7917c0b7f17b0abe89bf6a75bbfe91d1f404359a91e4de`，first-party schema 两个产物与旧轮相同。Bridge 新模块为 `4ab30c8843a44296905b6186b54715bb1ca3ea1393a6d8ea142b6f5d99cec2ab`；成对旧基线使用 `before-b8-v2.profile.json`，与新轮使用同一脚本及输入。记录为 `param-metadata-allocation-after-3c5d-20261005.*` 与 `bridge-framing-allocation-after-3c5d-20261005.*`。这些单次观察确认了局部分配来源，仍须通过冻结版本的真实工作区双轮复测，不能据此关闭 #27。

### db534685 的 Windows 重建

`2026-10-04T21:35:01Z–21:36:12Z` 串行完成 Bridge publish、C#、typecheck、build，4 腿均退出 0；C# **159 passed / 2 平台 skipped**。production source 指纹为 `ece923b07c7c3d1349638ad7ec85b050a79a5021c5210287609b1e2a6a59d561`，output 为 `2376a0255e2a64da0703f514280f9b0ff56cdb3300388cb1e371ed6cfe730817`；Bridge source 为 `327cc2800d8c6a6340767be7d2987bf84f5b9aa9c7301114022fe25a94579261`，exe 为 `48e36d7bbcf8aac3db9db8a071fb1cbf59efc1b2724fd1609519212e2d21a56c`。回执为 `build-allocation-fix-20261005.tsv` 及四腿日志。release compliance 清单仍是 partial，不由构建成功升级为发行合规通过。

此次编译后的 PARAM 与 Bridge 分片模块哈希仍与上述受控微基线相同；因此局部微基线可沿用，但其端到端限制不变。

随后在同一冻结代码及产物上串行完成 5 条原生验收腿，均退出 0：真实 loose BND4 的 191 项独立对照；原版/Mod 2209/2219 项 `(entryIndex, animationId, HKX name)` 全量对照；296 词条最大动作的分页、动作 limit 与资源绑定续读；真实模板插入；共享时间槽定向修改。后 2 条只写 owned 副本，均按 opId 回滚，并由独立 reader 及整容器字节核对恢复。5 条全部执行到尾部，原资源及产物前后未变，没有模型调用。记录为 `native-contracts-closure-final.tsv` 和 5 组 `*-closure-final.*` 回执。

### db534685：真实双轮与内存余项

`21:38:56Z–21:50:34Z` 使用同一完整 Mod 副本清单再次完成 2 轮打开、PARAM 原生 CAS 写入、按 opId 回滚和切空工作区。原 Mod 的 276 个文件、729,167,288 B 前后不变；每轮 owned 资源树恢复，应用正常关闭，登记的进程身份无残留。实际保存 6 份分配 profile 和 6 份 heap snapshot，215 次采样无采样错误。结果仍是 `lifecycle_completed_with_measurement_limits`。

| 观测 | b8 同口径旧轮 | db534685 新轮 |
|---|---:|---:|
| main heap 峰值 | 3,325,949,592 B | 3,154,338,088 B |
| main RSS 峰值 | 4,031,262,720 B | 3,548,180,480 B |
| 打开累计分配估计，第 1/2 轮 | 40.20 / 34.87 GB | 27.81 / 30.77 GB |
| 写入累计分配估计，第 1/2 轮 | 9.31 / 9.39 GB | 5.09 / 5.10 GB |
| 回滚累计分配估计，第 1/2 轮 | 9.33 / 9.21 GB | 5.12 / 5.16 GB |

两次运行使用相同 harness、语料和 512 KiB profiler 口径；这张表是单次前后观测，不是多次重复的性能胜负证明。新轮打开约 232.1/203.8 秒，写入连同语义收敛约 48.1/38.6 秒，回滚约 37.0/34.3 秒，切空约 41.1/34.7 秒。累计分配减少没有使 heap 峰值降到可直接宣布问题解决的程度；`finishClone`、`structuredClone`、分词和引用图构建仍是可见热点，不能为降低数值而取消其隔离语义。

main snapshot 节点 self-size 总和为 **24,228,474 → 30,684,309 → 31,324,609 B**，renderer 为 **12,503,432 → 16,696,524 → 16,876,740 B**。第 2 轮 main 增量为 640,300 B；它不是 dominator retained size，也不能凭 2 轮排除长期增长。utility JS heap、Bridge managed heap 和真实 embedding 路径仍未覆盖，#27 保持部分完成。

原始目录为 `memory-full-mod-0abac91c-74b2-4b41-9254-6e36cebfa733/runtime-990367d3`。首次 `summary-v2` 生成时尚未转换 6 份分配 profile，故 profiles 数组为空，保留原件；转换后另存 `memory-allocation-db534685-20261005.summary-v3.json`，不覆盖初次汇总。堆观察另存该 runtime 的 `heap-observation.json`，不提交私有快照内容。

### 8378 的构建与四套真实资源检查（历史证据）

Windows `bridge:publish`、typecheck、build 均退出 0；C# 为 **156 passed / 2 skipped**，两个跳过项是 Windows 上的 POSIX 平台负例，不记为通过。production source 指纹为 `1a33e5113ec3777e2b25d55949323dc58f493a11ef7ad0c7c1c3d8b79d4e4930`，output 为 `7998b16a162e3180ccd3b032ffe0818dce41aad7e43c56515e1199e345d83f2f`。Bridge exe 为 `47dfcf18f1376a203b29697a30aa9f42a849d43882337d756e0c6a1cd1a20b5c`。这轮不是后续源码的验收。

四个旧套件在同一冻结源码与产物下串行执行，前段失败没有截断尾部：

| 套件 | 实际结果 | 失败或未验证内容 |
|---|---|---|
| map/action open | 25 passed / 2 failed，27/27 操作收集完整 | 两个 anibnd 返回 `TAE_ANIBND_NO_TAE_ENTRY`；不能将其改成成功的 0 动画 |
| DCX documents | 167 passed / 88 failed，255/255 文件收集完整 | 71 项 DFLT 往返、95 项 KRAK 原生读、1 项大包只读缓存通过；81 项 BND4 CRUD/往返与 7 项 KRAK BND4 preservation/CRUD 断言失败 |
| S40 live | 前 8 项输出通过，脚本项失败，整套退出 1 | DSLuaDecompiler 输出 `EndOfStreamException`，随后达到超时；Lua 后续步骤没有执行，不作通过记录 |
| workspace completeness | 251 passed / 13 failed / 11 unavailable | 276 个扫描文件均有处置记录，其中 1 个历史备份未执行打开；10 个 HKS 引用表失败、3 个 anibnd 无 TAE；扫描诊断遗漏已在后续 f5b0 修复，不能反写本轮结果 |

四套检查中的 214 MiB SFX 大包均不再因 64 MiB 读取上限失败；其他失败没有被隐藏。因此该结果支持 #43 的特定读取上限验收，不支持“四个套件全部通过”。原 Mod 的 276 个资源文件合计 729,167,288 字节，前后逐文件哈希一致；production source/output 与 Node/Electron SQLite binding 前后也一致。此处文件集合摘要为 `172c024161a3f4bac612339002f16220250a839a4fdcb0a0f4baccb786c20cf1`，与旧摘要采用不同序列化格式，不能直接比较摘要字符串。

原始回执为 `large-resource-four-final.tsv` 与 `large-four-*-final.{json,stdout.log,stderr.log}`。保留所有失败，后续修复使用新命名的回执，不覆盖本轮。

### Linux 清理复核：拒绝集成会阻断正常构建的实验

真实 `check` 取消负例中，`setsid` 后代仍与原 PID/startTicks/nonce 匹配并继续运行，但 owned 临时根已被删除。检查本身正确报告取消和未完成；错误在清理动作，不是整套检查假绿。原始红回执 SHA256 为 `47fcf5bdd78f5b8412cfce1fcff0b5820f673066631206f5a7db487158bde287`。

删除前扫描同 UID `/proc` cwd/fd 的实验能够在这个负例中保留根，回执 SHA256 为 `189be57174a9878132ad6e9bc728994b8c64ee2831d9a0882c0ec5975d308670`。但父代理独立观察到，WSL 中同 UID 的 systemd 进程 cwd 和 33 个 fd 稳定返回 EACCES；全局扫描会因此阻断任意正常临时目录清理。另一次只读复核依据 [pthread_exit(3)](https://man7.org/linux/man-pages/man3/pthread_exit.3.html) 指出，不能仅由主线程的退出状态推断共享 fd 已全部释放；此风险尚未运行多线程实测。

该实验**未集成**，两个文件已精确恢复为提交版本，完整 patch、源码和红绿回执保存在私有 `owned-temp-guard-3dceb781574d42718dff1aaf5a21c74d` 目录；patch SHA256 为 `d6d78a3ab390f189e27717ba15fc779fd837bbb4bee983e7910e402e3b1ca53b`。不能通过忽略权限错误或按进程名加白名单制造通过。[Linux subreaper 机制](https://www.man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html) 可收养孤儿后代；当时只有设计与私有原型，后续产品实现及实际验证见 `b50c122c` 小节。

#### 已集成的中断回执修复

`eb2937f2` 在启动 Linux writer 前记录 uncertain-tree，只有父进程收到完整正常结果、观察到 supervisor 正常关闭且没有取消/超时后，才退役该标记。worker 退出、IPC 丢失或 close code 为 0 均不能替代操作结果；缺回执明确失败。递归清理重读子 owner 最新记录，将孙节点的不确定状态传到所有祖先，阻止旁路 dispose 或后续 sweep 删除它们。Windows 保留独立 Job 停止证明，不套用 Linux 的保留规则。

首次 Linux 整组检查为 29 passed / 5 failed / 4 平台 skipped，暴露了 hksc 的 `finally` 清理错误覆盖原取消事实及 fixture 清理预期不再适用。修复后 Linux 为 **34 passed / 0 failed / 4 skipped**。主代理 Windows 整组复测又发现一处将 Linux `isIdle=false` 预期错误套到已具备 Job 停止证明的 Windows case；区分平台后为 **26 passed / 0 failed / 12 skipped**。全部失败回执保留，没有删除用例或将跳过记为通过。

该阶段修复了中断、缺回执及递归保留路径，**当时未解决正常成功返回后 `setsid` 后代逃逸的停止证明**；后续修复另列，旧记录不改写为新实现的验收。fixture 仅在精确生成的 root/token 及其已记录测试进程停止后退役测试目录，不作为产品清理证明。证据是 `linux-owned-retention-preflight-20261005.*`、`linux-owned-retention-postfix-20261005-4d4e0356455e/`、`windows-owned-retention-review-20261005.*` 与 `windows-owned-retention-postfix-20261005-e2b64f942e7d/`。

### b8fe13f5 的 Windows 构建

`2026-10-04T19:37:13Z–19:38:24Z` 串行执行 Bridge publish、C#、typecheck、build，四腿均退出 0，C# 为 156 passed / 2 平台 skipped。production source 指纹为 `af87a48d6d4f115c5c46a557d535d7e43f8f75d415a221f3e5abfbfe7afb660a`，output 为 `c341199862dbe58c8e5eca0681be77d770774878d2577ca97c1ff13b86afa6a4`；Bridge source 为 `5e97f53b94df61b58665a01d8d9fe6c673b47f23ffe381681d1f9cdfb4f6b682`，exe 为 `6f97bfb756a9060b3adbd58f7c6037f3df5b487d851ac2c9634e2f57b3882de6`。Node/Electron SQLite binding 与前轮相同，host Node 实际加载通过。许可证清单仍为 partial，不因构建退出 0 变成发行合规通过。

此前 f5 构建因继承 PATH 达 6800 字符、嵌套 npm 后找不到 node 而失败，旧回执保留。重试仅在子进程复用仓库已有 `windowsCommandEnvironment`，删除不存在及重复目录并固定当前 Node，PATH 缩为 3012 字符；未截断未知条目，未改用户或系统 PATH。新回执为 `build-ready-20261005.tsv` 及对应四腿 JSON/日志。

### b8fe13f5：分配来源与真实读取复核

同一冻结版本在 `2026-10-04T19:39:11Z–19:52:05Z` 完成两轮真实工作区操作。原 Mod 的 276 个文件、729,167,288 字节只读；每轮 PARAM 写入后按精确 `opId` 回滚，原生行、容器及 owned 资源树均恢复。应用正常关闭，已登记进程身份无残留。运行结果是 `lifecycle_completed_with_measurement_limits`，不是内存验收通过。

241 次进程采样记录到 main JS heap 峰值 **3,325,949,592 字节**、main RSS 峰值 **4,031,262,720 字节**。两轮打开分别约 236.8/233.2 秒，写入连同语义收敛约 61.1/51.6 秒，回滚约 43.0/42.0 秒，切空约 41.9/34.8 秒；这些运行开启分配 profiler，不能直接与无 profiler 的旧轮次作性能胜负比较。utility JS heap、Bridge managed heap 与真实 embedding 路径仍未覆盖。

每轮打开、写入、回滚各保存一份 main inspector 分配采样，间隔 512 KiB，包含已经被 GC 回收的对象。打开阶段的累计分配估计分别约 **40.20/34.87 GB**，写入约 **9.31/9.39 GB**，回滚约 **9.33/9.21 GB**；这些不是存活堆，也不是泄漏量。调用栈确认了两个待修点：第一轮 `consumeStdout` 与其 `indexOf` 的估计分配合计约 8.83 GB；每个触发行宽回退的 PARAM entry 及身份校验又对同一个可信、不可变的整包 schema 做 snapshot、摘要和深冻结。后者不是“每一页都校验整包”。索引克隆、引用图与 RAG 构建也有可见分配，但尚不能仅凭热点表改写其隔离语义。原始记录在 `runtime-d74a8569`，汇总为 `memory-allocation-b8-20261005.summary.json`，SHA256 `d0264bc86313396d5c88bd1e07802b778d8d003c51bcccc624655eb25100f685`。

离线快照观察补充了存活对象口径：main 的节点 self-size 总和为 **24,205,240 → 30,776,951 → 31,439,295 B**；renderer 为 **12,511,622 → 16,716,461 → 16,898,457 B**。这些值不是 dominator retained size，也不是进程 RSS。第 2 轮 main 较第 1 轮增加 662,344 B，不能据两轮数据排除长期增长。

旧汇总 v1 对快照阶段的采样标签映射有误，保留原件并另存 `memory-allocation-b8-20261005.summary-v2.json`。v2 按实际快照时间及阶段结束边界匹配样本：baseline 和第 2 轮快照没有可匹配进程采样，明确记为 unavailable；第 1 轮的 16,222,736 B 样本只能说明采集过程中的观测，不证明 post-GC 时刻。6 份实际 heap snapshot 均已保存，分配 profile、快照与进程采样不混为一种测量。

随后 `19:53:14Z–19:54:39Z` 串行复跑 DCX 与完成度矩阵，前段失败没有省略后段。源码/产物/ABI 前后相同，原 Mod 文件摘要仍为 `172c024161a3f4bac612339002f16220250a839a4fdcb0a0f4baccb786c20cf1`。

- **DCX：167 passed / 88 failed，255/255 已处理。** 新增 `nativeChecks` 将 88 项失败全部定位为 `BND4_HASH_INDEX_STRUCTURAL_REPACK_UNSUPPORTED`；每项 `entriesIdentical` 与三个未知字段/存储字节保留检查均为 true，CRUD 未执行且未通过。原断言仍报失败，没有把只读能力外推成可重建容器，也没有添加重新打包能力。
- **完成度矩阵：261 passed / 3 failed / 11 unavailable**，276 个文件均有分类，其中 1 个历史备份按既有边界排除。10 个裸 HKS 全部通过：3 个 UTF-8 BOM 明文、7 个现有 first-party HKS 原生读取。剩余失败是 `c0000_a000_lo / c0000_a05x / c0000_a07x.anibnd.dcx` 的 `TAE_ANIBND_NO_TAE_ENTRY`，尚未由独立工具确认它们的完整内容，不能当作合法空动画通过。

新回执为 `reader-routing-b8-20261005.tsv`；DCX stdout SHA256 为 `cc3b55d200f139c5c77333cd2c1f8db8af845709910d5429ce9a8a2317981552`，完成度矩阵 stdout 为 `96ff9d4e0874e7983f15f693ce155e83767269ae60227afeef6edd4dffcd90ce`。旧 13 项矩阵失败和旧缺少子项原因的 DCX 回执仍保留，不反写。

#### 三个无 TAE 容器的独立复核

随后另建私有只读查询程序，使用固定的 SoulsFormatsNEXT `ee1dd61958f60bdc51ce3da548e9a90a8ab39905` 枚举三份源容器及每个解包子项，不调用生产 TAE reader。结果分别有 **187 / 191 / 278** 个子项，其中 `.hkx/.hkt` 名称分别为 **184 / 188 / 275**；每个容器另有两个空文本条目和一个 compendium。三者都没有 `.tae` 名称或 TAE 魔数，源文件前后哈希相同。

这确认了本组三个 `TAE_ANIBND_NO_TAE_ENTRY` 不是“漏掉了实际存在的 TAE”，也说明不能只凭 `.anibnd.dcx` 后缀要求 TAE reader 成功。它不证明 HKX 完整解码、姿态或播放正确；原矩阵失败不反写为合法空动画。生产资源分类与补充动画包交互仍需单独验收。

程序和结果位于私有 `anibnd-inventory-independent-07350b1e-906b-4a56-9f87-815930753b4e`。独立 reader DLL SHA256 为 `e4fbf600b36ab457a6ae6e09dd9eedc050066be2e1033e2459df9149544fe959`，查询 DLL 为 `92811fa23405bacc7197202c4523ea8bc2dfb94488515f2dccabd69f1a5c50f7`，结果为 `c90ce522b6b85dfcb4505cff1454f609ea570789b723d1357fadc8d156a74004`。原版游戏 codec 的 SHA256 为 `988e8226d129b03011a96f51b476e86d38c0c3e817266375a78a7cf3b85d93c4`，仅从用户本地读取，不复制入项目发布物。

## 真实模型：失败也属于验收结果

使用用户授权的加密 test 服务，凭据仅在进程中解密，不写入本报告。旧入口选公开 main c4 基线；两入口保持同模型配置、输入、采样参数和预算。每腿最多 12 步、120 秒；同一 campaign 截止时间为 `2026-10-04T04:37:22.649Z`。不足以启动完整下一腿时停止，未重置 30 分钟总预算。以下离线重评没有新模型调用。

| 记录 | passed | failed | not_run | 解释 |
|---|---:|---:|---:|---|
| 第一组 12 任务 × 2 入口，按修正后的独立评价器重评 | 16 | 8 | 0 | PARAM、EMEVD 通过；FMG 六腿失败；TAE 两腿写入失败 |
| 第一组 22 个描述/RAG/启发式实验腿 | 15 | 7 | 0 | 只覆盖同一 EMEVD 读取任务；零触发不能证明启发式无影响 |
| 修复后同 campaign 复跑 | 8 | 1 | 15 | FMG 六腿、TAE 两次读取通过；TAE 写入触发共享时间槽安全拒绝；剩余腿未运行 |

初版评价器只检查 native-verified 标签，漏掉 FMG 读错值；还错误拒绝了嵌套的 PARAM 模型声明。已加入错值负例，要求实际工具原生值、独立 oracle、模型声明、写入范围和回滚同时满足。原报告保留，另存离线纠正报告；不得继续引用旧的“18/24 通过”。第一组两次 FMG 写后 oracle 无法解析，已依据真实 journal 的 opId 回滚，两个实验副本恢复原始 hash；它们仍是失败，恢复不改写验收结果。

可用记录合计报告输入 **3,121,351 tokens**、输出 **102,638 tokens**，共 180 次具有 usage 的请求。第一组两条缺完整 record，故不是 campaign 完整账单；实际金额未知。没有把缺失 usage 或缺失腿记为零。

模型 campaign 当时的 TAE `a50 / A2010 / e0` 起始时间与别的事件共享底层时间槽，原生 writer 返回 `TAE_SHARED_TIME_SLOT_WRITE_UNSUPPORTED`，未提交。随后实现了完整时间表重定位，但没有重开已到期的 campaign；原模型腿仍是 failed，不由新代码或直接工具验收改写。

### 追加授权：10d9 的独立最终模型组

用户另行授权的一组保存为 `final-model-8d399d0f-7622-4eac-9a87-ea80696869ae`。新 activation 从 `2026-10-04T10:34:08.258Z` 起，截止 `11:04:08.258Z`；实际 640.3 秒结束，24 腿全部执行，**23 passed / 1 failed**。没有重置时钟、超截止派发、未结束请求或恢复超时，也没有覆盖旧 campaign。

比较范围是 **main c4 的 model-services runner 与当前 finite runner**，两者共用本次 core/native/tools；不是两套完整旧/新应用。模型、配置、输入、采样和每次最大输出 2048 tokens 相同；每腿最多 12 步/120 秒，金额上限关闭。源码为 `10d9b8f8`，独立制品摘要 `f00d2bf652607a5a419efc6c48b4efb7587c5e98e00e8da5e3211fc48a15845c`，2238 个输入文件；运行前后源码、制品、Node/ABI/native binding 及原 Mod 哈希保持一致。

| 入口 | passed / failed | 各腿耗时合计（含准备和恢复） | 实际输入 / 输出 tokens |
|---|---:|---:|---:|
| c4 legacy runner | 12 / 0 | 255.6 秒 | 813,660 / 23,864 |
| 当前 finite runner | 11 / 1 | 379.4 秒 | 854,438 / 28,669 |

唯一失败为 finite 的 EMEVD 读取：原生值和独立期望一致，但第二次模型响应 `finishReason=length`，最终文本为空，内核以 `partial` 结束，未提供可验收的最终声明。没有将这次运行改写为通过或自动加大输出额度重试。它也不能算作已证实的模型假成功：两个评价口径均为 **23 项非假成功、0 项已证假成功、1 项声明缺失而未验证**。

四个领域的两入口写入/回滚全部通过；没有观察到超出许可的改动，回滚均核对原提交事实、独立 committed inverse、事务/工作区身份和完整容器哈希。宿主错误腿为 0。98 次实际请求全部报告 usage，合计 **1,668,098 输入 / 52,533 输出 tokens**；实际金额仍未知。单组样本及一次截断不足以据此宣称新入口质量或速度优于旧入口。

此后 `30b4b89f` 修改了共享 PARAM 工具与索引，`ee46d07e` 修改了桌面准入；这组收费模型结果仍只绑定 `10d9b8f8`。未自动重开 campaign，也不将后续源码单测或直接工具实测称为“最终源码模型对照全通过”。

## 数据库真实副本实验

源数据库约 1.9 GB，原始 SHA-256：
`411939f1247cfb45f5730fb3a1da2342f81cace111ffe6bf282563c06571e093`。

首次运行在历史 v13 checksum 处失败，保留失败记录。首轮修复后真实副本实验约 673 秒通过。加强版在 `85c61955` 上再次运行，耗时 **618 秒**，从 schema 14 到 17，5 个阶段均通过：一致性快照、备份中取消不发布、退役迁移提交前强制退出并回滚、恢复迁移、独立读连接在 writer 事务中按 opId 查询已提交状态。此后至 `2f3d7455`，数据库实现与验收脚本均未变化。

加强版不只比较行数：在一致性快照、中断后、恢复迁移后及 3 份恢复备份中，逐行比较 `workspaces / patch_history / transaction_journal / semantic_file_cache / rag_chunks` 的存储类型与内容哈希，保留原有列集合。其行数分别为 `1 / 46 / 41 / 62 / 196226`。原库最终 hash 与开始一致。新增 `rag_chunks.native_metadata_json` 列内容不在此原列摘要内；knowledge 转换使用转换器的语义回读验证，不冒充同一组原始行哈希验证。输出目录增加 junction、符号链接及源 hardlink 别名拒绝测试。

## 逐 issue 收口矩阵

“保留”表示候选已实现的部分继续沿用，不代表本次重新证明全部历史结果。下表没有任何一项被写成“已进入 main”。

| Issue | 本轮实现/核验 | 验收结论、具体缺项与边界 |
|---|---|---|
| #21 | 本报告、约束表及逐项清单 | 总体未全通过，不能收口为已解决 |
| #22 | 保留新治理入口；实际四态 runner 检查 | 缺同环境新旧完整实际执行集合的等价证明 |
| #23 | 固定语料、独立期望与漂移负例；补跑原 5 个正确性套件 | 合并实际覆盖为 4 passed / 1 corpus-manifest unavailable；a3 的缺根/hash 漂移/缺文件四态负例通过，不与原生五腿混算 |
| #24 | 补 FMG fixture、TAE 有界页、共享时间表；Lua/EMEVD 固定期望及缺语料四态 | Windows/Linux 真实分页数据流分别验收；旧 E2E 85/85 与本轮 14/14 不是同一集合，不外推全部编辑器 E2E |
| #25 | Windows PATH/PowerShell 缓存隔离与独立 ABI；fresh headers 补齐后实际编译通过 | Windows 与 Linux 的构建、binding 分别记录，不外推洁净机 |
| #26 | 预算贯通、TAE 回执与真实跨域对照 | 12 任务 × 2 的最终修复版未全通过 |
| #27 | 完整 Mod 副本真实写入/回滚、跨进程内存、堆快照及六阶段分配采样；另修 URI 重复规范化与 RAG 键序伪变更/重复序列化 | dbcbba18 双轮完成，引用提交重复构图和恢复错误已修；累计分配没有稳定的整体下降，JS heap 峰约 3.32 GB、RSS 约 4.09 GB；克隆/lookup/引用图热点及 utility/.NET heap 缺口仍在，不能标为全部解决 |
| #28 | 已执行描述、RAG、启发式受控实验 | 单任务/零触发及失败腿不足以得出全部去留或质量收益结论 |
| #29 | 保留独立内核与 utility 宿主，补有效预算及提交后回读 | 最终跨领域正确性/假成功与崩溃恢复验收仍非全绿 |
| #30 | 保留基线比较器与负例 | 六类真实资产、成熟工具画面与人工确认未齐 |
| #31 | 保留 260 秒/400 毫秒回归上限与分段计时 | 当前 Mod 地图实测单列；宽松通过不等于交互流畅 |
| #32 | adapter.info 探测与 WebGL2 默认；当前 Electron 实测旧 detector 红、新 detector 可用、真实 ACTION 为 WebGL2 | **候选满足该 issue 的明确验收**；不等于 #34 双后端视觉通过，未进入 main |
| #33 | 保留场景职责拆分 | #30 真实视觉基线未齐，不能声称全部在基线保护下验收 |
| #34 | 保留 WebGPU 双层 TSL；不切默认 | 离线 shader 不替代真实双后端材质、图像及性能验收 |
| #35 | 新旧入口静态逐项映射、自动发现与实际 runner | 静态映射不等于全部发现项已执行；旧完整执行集仍缺 |
| #36 | owned 临时目录、Windows Job 短 pending 回执、退出 drain；Linux subreaper、原子 helper 发布、绑定 completion ledger | d150 最终 Windows 为 401 passed / 5 unavailable / 0 failed，Linux 16 腿执行完毕、其中 Guardian/owner 73 passed / 5 Windows skipped；未知历史残留保留，不以缺 Clang 或平台跳过作通过 |
| #37 | 保留未知文件、救援 bundle、原候选与分支 | 未获确切归属/恢复依据的对象没有删除 |
| #38 | 按 #49 取消硬行数预算与禁增测试前提 | **旧验收已被后续决策取代**，不是遗漏实现旧门禁；GitHub 文本未擅自修改 |
| #39 | 已在真实跨域任务使用新入口 | 各工具新会话/流程效果及三类完整任务验收未齐 |
| #40 | 真实库一致性备份、取消不发布；842 补完整 c4 逐文件复制的定序红例与当前 backup 绿例 | **候选满足该 issue 的明确验收**；旧 copy 产生从未存在过的业务状态，current backup 与源状态一致；未进入 main |
| #41 | 历史 v13/v14 兼容修复；真实副本退役、强退恢复通过 | 明确剩余项是删表前后 npm test/native/E2E 的同环境等价实跑；未知历史 schema 的拒绝本身不是缺陷 |
| #42 | 真实 SQLite + Worker transport 的超时/opId 负例；Electron 正常生命周期；2.43 GB 副本 production reader | **候选满足明确验收**：长写期间可读，超时后可查询提交事实。3 层证据分列，不称大库实验覆盖 Electron IPC 超时；未进入 main |
| #43 | 保留 64 MiB 限制、用户导入 WitchyBND 只读缓存；修复 Windows 过长启动目录 | 真实 214 MiB Mod 包冷读、缓存复用、叶文件原生读与负例通过；四条旧套件另验，未增加 repack |
| #44 | 保留命令单源与真实 Service 分派探针；C# 负例通过 | **候选已满足该 issue 的明确验收**；所有格式均正确不是此分派任务的验收范围，未进入 main |
| #45 | 保留 net10 Doctor | 无 .NET 的 Windows 洁净机运行未验收 |
| #46 | 5 处来源说明、许可证文件与 NOTICE 引用核对 | **候选已满足悬空引用修复的明确验收**；非全项目法律或发行合规结论，未进入 main |
| #47 | 原版 2209、Mod 2219 独立完整身份集合及真实 UI；损坏输入显示失败而非 0 动画 | **候选满足明确 UI 验收**。新增错误态检查会拒绝旧源码的 0/空态；未声称在 c4 实跑该 E2E，未进入 main |
| #48 | 保留 failed/empty/unavailable 分类，不制造成功 | 真实样本范围有限，合法空网格不当成绘制成功 |
| #49 | 一次性约束表、337 旧登记逐项分类 | 尚无新旧完整实际执行集合证明；不另建登记门禁 |
| #50 | 保留分层独立 oracle 与首差层检测 | HKX/pose、游戏/成熟工具画面与缺失资源参照未齐 |
| #51 | 原生首尾 ID、section 身份、独立字节与缓存失效测试 | c4 完整 reader 实际旧红/当前绿；原版/Mod 全部 ID/HKX 对照及 1564 匹配、定向写字节验收已具备；候选满足明确验收，未进入 main |
| #52 | 底层有界动作页、快照游标、超大事件原生续读；区分索引与交付完整性 | 最大真实动作 296 词条、双动作 limit 与全部续读通过；仅前三大动作建索引的范围明确，不外推全文件字段唯一性 |
| #53 | 沿用 Patch/CAS 插入、原生回读、冲突与原字节回滚；补真实 Mod a50/A2010 模板插入及独立 reader | 一个真实模板通过不外推全部类型、字段覆写或真实并发冲突；#54 不纳入 |
| #54 | **延期，不改任务定义** | 不列入本轮完成数 |
| #55 | Mod `m11_00_00_00` 的 Base64 脱敏故障已修；补全 envelope 计数分配优化 | 最近一次地图验收绑定 cda2840d：loaded 753 / failed 0，UI 107.52 秒、最大 RAF 间隙 351.8 ms，仍 smooth=false；b50/d150 未重测完整 Mod 地图，不将该结果改绑当前源码，不宣称所有卡顿消失 |

## 证据位置与重跑规则

本地工作树：`C:\Users\ASUS\.codex\worktrees\52bc\SoulForge`。本轮原始回执在 `.local-validation/closeout/`，真实 MAP 在 `output/playwright/`；不将私有语料、凭据、第三方 DLL 或原始模型会话上传到仓库。

当前冻结源码的 71 份关键回执、原始日志和输入 manifest 已建立只读索引：`final-evidence-index-d150312a-20261005.json`，SHA256 为 `7073a8b5a489c5997236f070ef731d4e276300d5dae278a9e0776021c47562ab`。索引不替代测试，也不覆盖全部历史产物；每条记录保留实际路径、长度和 hash。之后的收尾文档提交只改变这两份报告，产品验收仍绑定 `d150312a`，不把旧安装 manifest 的 HEAD 改写成文档提交。

以下均在独立 checkout 根目录执行；依赖、可变 ABI、.NET 与编译产物必须属于该 checkout。Windows 需可用的原生编译环境，Linux x64 需 GCC 或 Clang 与 .NET 10 工具链，不能通过链接另一工作树的 `node_modules` 或 native 文件补环境。每次报告使用新的输出名；复验过程中冻结源码及输入，失败后仍逐腿执行其余独立检查。

```sh
# Linux x64 先生成当前源码的 Guardian；Windows 不执行此平台专属步骤。
npm run prepare:owned-process-guardian
npm run typecheck
npm run build
npm run bridge:publish:linux
npm run test:bridge-csharp
node --test --test-concurrency=1 scripts/build-owned-process-guardian.test.mjs scripts/owned-process.test.mjs scripts/owned-test-environment.fixture.mjs scripts/owned-temporary-directory.test.mjs
node scripts/verify-subprocess-control-fixtures.mjs
node --test scripts/check.fixture.mjs scripts/bridge-linux-production.fixture.mjs
node scripts/verify-bridge-production-build-fixtures.mjs
npm run bridge:verify:synthetic
npm run test:renderer-unit
node scripts/check.mjs --suite file:packages/core/src/indexing/nativeSemanticRefreshReferenceRebuild.test.ts --require-executed
node scripts/run-database-utility-smoke.mjs --production-binding
```

Windows 对应发布入口为 `npm run bridge:publish`。真实安装测试须明确接受 owned A/B 的本机安装、启动和卸载副作用；本轮没有使用正式产品身份。准备好当前 app/Bridge 后：

```powershell
node scripts/update/prepare-owned-installers.mjs --allow-owned-installation
$env:SOULFORGE_UPDATE_INSTALLED_MANIFEST = (Get-Content -Raw .local-validation/owned-update-installers/current-manifest-path.txt).Trim()
npm run test:update:all
```

Windows unit/required 的 406 条结果记录（401 passed、5 unavailable）见 `checks-utf8-final-20261005.report.json` 的 `results`；539 次 operation 调度及复用统计另见其 `scheduling`。完整启动命令保存在 `checks-utf8-final-20261005.json` 的 `command`，生产 E2E 的具体 4 个 spec 与输出目录保存在 `production-e2e-utf8-final-20261005.json`。有真实语料的腿另依赖已记录的 fixture root、registry、Mod 与 hash，不以任意本机文件替换固定期望；缺环境须保持 unavailable。上述命令只是复验入口，不新增日常全仓门禁，也不自动授权付费模型调用。

重要记录：

- `build-integrated.json`：提交 `c00c85c2` 构建成功，tracked diff 为空。
- `check-governance-current.report.json`：4 passed；`check-light-negative.report.json`：7 passed。读取 step 的 executed 状态，不把别名缓存次数相加成断言数。
- `database-guard-tests.stdout.log`：8 passed；`focused-migration-tae-v2.stdout.log` 保存当时 32 passed / 2 failed，后者均为已修复的 SQLite 活跃游标问题。后续通过记录不删除此失败。
- `real-workspace-db/report.json`、`real-workspace-db-v2/report.json`：首次失败与修复后真实副本结果。
- `model-reevaluation.json`：离线纠正结果；`real-model-acceptance/report.json`、`real-model-repair/report.json` 是原 campaign；`fmg-recovery.json` 是异常写入副本的恢复证据。
- 旧静态盘点为 744 个发现项（npm 183 / workspace 238 / file 323），699 个独立 operation。该快照中 337 个旧登记有 309 retained/discovered、8 个有明确替代的退役项、7 个保留操作入口、13 个旧治理专用项；309 项中 305 全部旧源匹配、2 部分匹配、2 仅同名。它既不是新提交的完整重映射，也不是实际执行等价证明。
- `10d9b8f8` 的 `checks-all-shutdown-list.json` 重新发现 751 项（npm 183 / workspace 238 / file 330），704 个独立 operation、1151 次调度 occurrence。最终选定的 unit + root + 5 个原生套件 + synthetic 计划有 481 次 occurrence、301 个独立 operation、180 次可复用调度；是否执行须看对应运行报告，不由 `--list` 证明。

复跑真实模型须另有费用/时限授权，不因存在脚本而自动重开 campaign。数据库实验必须提供新 owned 输出目录，禁止传用户原库作为目标。安装 A/B 使用独立随机身份，通过也不能外推官方自动更新、签名、SmartScreen 或无 .NET 洁净机。

## 历史集成验收（各段绑定原提交，不替代当前版本）

### TAE：独立完整 ID 集合与真实桌面

以验收专用的 SoulsFormats NEXT `ee1dd61958f60bdc51ce3da548e9a90a8ab39905` 读取输入，得到独立动作列表；它没有成为生产依赖。原版 `c0000.anibnd.dcx` 有 **2209 个动画、65 个 section**，Mod 对应文件有 **2219 个动画、65 个 section**。

在 `2f3d7455` 的 Windows Bridge 上，两份输入分别读取 18 个有界页，每页最多 128 个动画，比较全部 `(section, animationId)`，末页 continuation 终止正确，全部匹配独立参照，输入 hash 未变。TAE envelope 的 `partial` 表示解码语义覆盖不完整，不能写成“所有事件均完整解码”；本次通过的是总数、身份列表与字节往返。

- 原版 SHA-256：`43fcbbec0f22a26317edfd41a3197abbf0da60f1e7699c9006dd02dc20eb3d27`。
- Mod SHA-256：`d26a4afd8a9842953529c939aa5187f85662a4d1efb767ec4e6af5d72a124e87`。
- 独立 oracle assembly：`e4fbf600b36ab457a6ae6e09dd9eedc050066be2e1033e2459df9149544fe959`。
- 独立查询程序 assembly：`cb9155abbcaa2cf401f752cf34ea979cc054c15eea2b05886d0e128d7f7a927f`。
- 被测 Bridge：`f29200a5aa6a2d8baaa744beb9008faa6dca4fdcc82f04c95e583f4571509d7b`。

两次真实 Electron UI 验收也通过：生产 sandbox 开启；初始有界页显示独立总数及“加载更多”；损坏 owned 副本后显示“动作读取失败”，不显示虚假 0；原输入 hash 不变。回执分别为 `tae-base-e2e.json`、`tae-mod-e2e.json`，完整原生比较为 `tae-list-independent.report.json`。首次临时比较脚本误把既有 `partial` 协议写成 `parsed`，其失败报告保留；修正协议预期后仍独立验证全部 ID、hash 及往返结果。

### Mod 地图：功能故障已修，性能验收未通过

用户未提供可还原的原始 #55 案例。本次自行固定 Mod `m11_00_00_00`、Windows Electron 43、WebGL2：最初 773 个模型中仅 16 个加载、737 个失败、20 个资源不可用，定位为路径脱敏破坏合法 Base64。

结构化 DTO 修复后的 `8444f9ff` 实测得到 **753 loaded / 0 failed / 20 unavailable**，0 个 scene error；最终截图可见实际地图几何。加载约 **231.6 秒**，低于现有 260 秒宽松上限，但存在 1 次 telemetry 超时、窗口非持续前台条件，响应性未获有效通过；191 个可见长间隔，最大约 1004 毫秒。`functionalLoadOk=true` 不改变整套检查 `failed` 的结果。既不能称为流畅，也不能由此断言所有“半途卡住”均已修复。

回执：`mod-map-m11-final.json`；报告：`output/playwright/map-streaming-native-m11_00_00_00-normal-2026-10-04T06-31-55-887Z/report.json`。该结果绑定当时的 app/Bridge 快照；后续 `2f3d7455` 增加 BND4 writer 保护，没有重新运行这次 232 秒地图基准，不将旧截图冒充新 Bridge 的完整视觉验收。

### Linux 独立环境

Ubuntu 24.04 / WSL 6.6、Node 22.22.2、Electron 43.0.0、.NET SDK 10.0.301、GCC/G++ 13.3，独立源码、node_modules、NuGet、编译产物。缺失的运行库只解包到 owned 目录并通过进程级 `LD_LIBRARY_PATH` 使用，没有修改系统库、sandbox、sysctl 或 suid 配置。

在 `8444f9ff` 上，9 个顺序步骤均 exit 0：类型检查、完整构建、C# 测试、Bridge publish、Agent 单测、native identity/platform、真实 Electron database utility binding、renderer 单测、Bridge synthetic。C# **124/124**，Agent **39/39**；identity/platform **41 passed / 1 平台不适用 skip**，因此该组不记为完整通过；renderer **1484/1484**。Node SQLite ABI 为 127，Electron binding 在 Linux 实际编译，不复用 Windows 文件。运行记录为 `linux-final-results.tsv` 及各步骤日志。Linux 结果不代表 Windows 安装、原生 Windows Oodle 或真实双后端视觉验收。

随后在同一独立环境快进到 `2f3d7455`，重跑 C#、Bridge publish、native identity/platform 与 synthetic，四步均 exit 0。C# **139/139**；identity/platform 仍 **41 passed / 1 平台不适用 skip**。Linux 新 Bridge SHA-256 为 `878ad4096fa6cdc74b3c25b76a37e962dca80ebda3c2c8db86524ca969d9cf9b`，构建验证 helper 为 `930b5bc712fccce40abfc098155ce3583b48054c36d1d55540411f042c5ecb13`。第一次临时调度脚本错误假设验证仓库配置了 `origin`，在 fetch 前失败、没有执行测试；修正为已核对的本地只读 Git 源后完成复跑。记录为 `linux-alias-final-results.tsv`、`linux-alias-final-validation-v2.json`，失败回执没有覆盖。

### Windows 自动发现、E2E 与独立安装

在 `2f3d7455`、tracked diff 为空时，完整构建成功。production manifest 绑定 1228 个 source 文件与 22 个 output 文件：source SHA-256 为 `2e5d19b70594bba66ce1b0a6d19a60e56c6fd5580bdc467394feb55308077a9d`，output 为 `a948a2567340b18c67f246041ffe514425f375a51ff02f2e0f423ff2d5218aa2`。

完整 E2E 在同一实现上运行 **85/85 passed、0 skip、0 failed**，耗时约 20 分钟，workers=1、retries=0。包含真实 ACTION/MAP/PARAM/FMG 资源、c5400 纹理身份、c0000 播放、原生 TAE 总数与生产 sandbox；其中模型回复 fixture 是模拟响应，不能充当真实模型对照。回执为 `full-e2e-final.json`。

第一轮实际执行的自动发现集合为 **383 个 suite：378 passed / 2 failed / 3 unavailable / 0 not_run**，474 个 operation 出现位置、296 个独立 operation、178 个可复用位置。377 个 unit 与显式要求的 root、五个固定原生 suite、Bridge synthetic 一并进入执行计划，尾部已执行，未因前段失败遗漏。root `npm test` 实际 exit 0，但内部有 4 个缺少指定独立语料/producer 的 scene 检查，四态 runner 正确保留 unavailable。

- 两个 failed 是 `bridge:verify:daemon` 与 `bridge:verify:synthetic`。前者启动旧 Debug 目录时找不到要求的 .NET runtime；后者首次 SDK 尝试在 HKS native 构建失败，截断摘要不足以证明首因。指定本机已有 SDK 10.0.301、重新执行 synthetic（包含实际 Debug 构建）后通过；随后不带额外 runtime 环境的 daemon 检查通过。没有改源码、删除检查或将旧失败报告改成通过，也不声称已经证明 HKS 初次失败的根因。
- 三个 unavailable 为 `test:scene-contracts`、`file:scripts/owned-process.test.mjs`、root `test`。scene 的 4 个缺输入用例在 root 内重复出现；owned-process 的 7 个 POSIX 用例在 Windows 跳过，不是 7 个产品故障，但也不记为实际执行通过。
- `test:update:unit / integration / installed / all` 均通过。安装输入是重新生成、绑定 production source/output 的独立随机身份 A/B 包，`installed` 与 `all` 内实际进行了两轮安装、启动和卸载。它们不使用官方应用身份，不证明官方自动更新、签名、SmartScreen 或洁净机表现。

证据分别为 `checks-unit-root-final.report.json`、`bridge-synthetic-directed.json`、`bridge-daemon-after-debug-rebuild.json`、`owned-installers-final.json`。fresh Electron SQLite 编译需要的 `Release/node.lib` 已在 owned headers 内补齐，root 实际执行通过；未改全局 Node ABI，也未删除 fresh build 检查。

### 成熟魂游工具对照：能借鉴什么，尚未证明什么

按用户追加要求，难点对照官方固定源码，而非依据工具声誉推断性能。Smithbox 固定为 `cbd477a8fd6d436b3e011c8548e1de8fd8876918`，DSMapStudio 固定为 `97bc264cbc3e82a783eb017f57edf651f8ba000b`。

Smithbox 按虚拟资源身份合并 in-flight 请求，将 binder 的 `Memory<byte>` 交给解码流水线，完成结果排队后逐帧提交；每 job 每次更新最多提交 64 项，纹理另走低优先级上传队列。对应 [ResourceJobBuilder](https://github.com/vawser/Smithbox/blob/cbd477a8fd6d436b3e011c8548e1de8fd8876918/src/Smithbox.Program/Renderer/Resource%20Manager/ResourceJobBuilder.cs#L30-L45)、[ResourceJob](https://github.com/vawser/Smithbox/blob/cbd477a8fd6d436b3e011c8548e1de8fd8876918/src/Smithbox.Program/Renderer/Resource%20Manager/ResourceJob.cs#L236-L263)、[TextureResource](https://github.com/vawser/Smithbox/blob/cbd477a8fd6d436b3e011c8548e1de8fd8876918/src/Smithbox.Program/Renderer/Resource%20Types/TextureResource.cs#L54-L75)。DSMapStudio 的同源旧实现仍使用全量 `TryReceiveAll` 提交，不能笼统写成两个成熟工具都有限帧提交：[ResourceManager](https://github.com/soulsmods/DSMapStudio/blob/97bc264cbc3e82a783eb017f57edf651f8ba000b/src/StudioCore/Resource/ResourceManager.cs#L719-L736)。这些工具的同进程二进制流水线不经过本项目的 C#→JSON/Base64→Node→Electron 链，不能直接移植性能数字。

本项目已经有模型请求合并、纹理共享、6 ms 帧队列，不能把“没有缓存/调度”当根因。当前 `m11` 记录中的 23 份大角色结果共发出 407 次 artifact 请求，累计 142,221 ms；Node Base64 解码约 553 ms，拼接与 JSON 解析约 1,866 ms。请求存在重叠，142 秒既不是 Base64 CPU 时间，也不能从地图加载总时长直接扣除。Bridge artifact 已使用文件 offset 有界读取，并非每块重读整文件。

后续应按以下顺序验证，而不是直接加并发、提高堆或缓存上限：

1. 固定一份大角色与来源 hash、并发 1，不开 GPU，分别计量 chunk 排队、读取、序列化、stdout 与接收。角色目前先回传完整结果、再在 main 分页；量清瓶颈后再评估原生角色分页或受控二进制传输。
2. 同源地图保持全程前台，量 worker 等待上传的时间、队列深度和待提交字节。当前 8 个加载 worker 会等待帧上传队列；如前台仍有明显反压，再验证有字节上限的生产/消费解耦。
3. 固定两个实际解析到同一纹理的材质，比较单请求和并行请求的真实解包/解码次数。当前锁外冷缓存生成允许同键重复计算，但本次尚未计量其发生比例；先证明重复，再引入按来源 revision 和纹理身份合并的 single-flight。

TAE 共享时间槽采用 SoulsFormats NEXT 的完整时间表思路：重新收集全部时间值并生成新偏移，事件 header 指向新表，而非原位修改共享槽，见 [Animation.WriteTimes](https://github.com/soulsmods/SoulsFormatsNEXT/blob/ee1dd61958f60bdc51ce3da548e9a90a8ab39905/SoulsFormats/Formats/TAE/Animation.cs)、[Event.WriteHeader](https://github.com/soulsmods/SoulsFormatsNEXT/blob/ee1dd61958f60bdc51ce3da548e9a90a8ab39905/SoulsFormats/Formats/TAE/Event.cs)。本项目保留原文件，仅追加新表并修改已知指针，同时检查全部未改事件时间、参数与未知头部字节；未知 EOF 参数范围继续拒绝。独立字节断言不调用产品 writer 生成期望。

### 六类视觉验收的缺口

本轮六类来自用户锁定的计划：小型 FLVER、大型 FLVER、骨骼角色、TAE 姿态、MSB 地图、双层材质。仓库已有独立几何、骨骼、变换、事件字段和纹理像素的分层比较记录；但这些旧记录须按输入/产物 hash 复核才能复用，不能替代游戏或成熟工具中的姿态、画面与交互参照。当前图像比较器的手工两像素负例也不是真实资产基线。

本轮没有取得六类均获人工确认的独立画面参照。真实资源 E2E、地图截图、独立 TAE 身份集合分别提供链路、绘制观测和身份正确性的证据，不升级为六类视觉验收通过。WebGPU 第二层材质的离线编译不能证明真实双后端效果，默认继续使用 WebGL2。

## 后续故障定位与修复验收

### 完整 Mod 生命周期与大库打开

实验复制 11 类资源目录，共 276 个文件、729,167,288 字节。owned 文件均为独立文件；写入及回滚不涉及原 Mod inode，也不打开用户原数据库。使用生产 main、preload 与 IPC，唯一 UI 替身是目录选择对话框；没有增加堆上限、降低 sandbox 或调用模型。计划运行 2 轮预检、PARAM 受控写入、原生回读、语义刷新、opId 回滚、目录切换与关闭。

早期实验 `runtime-7f00ae49` 仅完成第 1 轮：分析约 214.4 秒，写入及刷新约 105.8 秒，回滚约 44.9 秒，切换约 4 秒。第 2 轮重挂超过既有 60 秒 UI 等待上限，原报告为 failed。客户端记录 writer/reader 两次 `openWorkspace` 往返约 38,163 / 23,380 ms，合计约 61.5 秒；worker 内部数据库执行时间分别约 37,980 / 23,218 ms。这支持大库打开超时，不支持“已经证明死锁”。

对同一 2,149,924,864 字节 owned 数据库调用生产只读打开 API，计量发现两次 `quick_check` 分别约 11,724 / 11,562 ms。删去没有迁移发生的第二次扫描后，单次观察为 11,436 ms，保留的检查耗时 11,431 ms。前后数据库 hash 都为 `000733bd6863d3c0e3466aee4b13fd1ee0583898a550f992914a6a816a512277`。这是单次同输入观察，不是完整 UI 的性能验收；writer 迁移前后检查均保留。相关回执为 `database-open-profile.json`、`database-open-profile-after.json`；坏页、迁移后非法记录及只读不变性测试为 `sqliteOpenIntegrity.test.ts`。首次负例选用了 SQLite 只读检查未报告的 CHECK 约束违规，随后改成真实坏页，失败记录未删除。[SQLite 检查范围](https://www.sqlite.org/pragma.html#pragma_quick_check)

旧轮次的主进程采样 heap 峰值约 2,442.7 MiB，`process.memoryUsage()` RSS 峰值约 3,357.5 MiB。第 1 轮切换后、堆快照触发 GC 前仍可见约 920 MiB heap；快照后的实际对象 self-size 总量由基线 24.14 MB 增至 30.05 MB。失败状态 30.27 MB 不是完成第 2 轮的结果。renderer 快照约 12.51→16.73 MB；utility 与 Bridge 只有 OS RSS，没有其 JS/.NET managed heap。

离线对象路径分析发现 `entryHaystackCache`、`compactTokenCache`、`paramTextFieldCacheById` 的 table 分别约 262 / 229 / 115 KB，另有 JIT 代码与字符串。非弱边 BFS 与对象 self-size 不等于完整 retained size，也不足以将几百 KB 缓存认定为 2.4 GiB 峰值根因。GC 后回落不证明所有资源规模、无限时长或真实 embedding 路径都没有增长。

进程采样另发现 PID 复用误归属：只按 parent PID 追溯会将早于 Electron 创建的系统进程列为残留。现按 PID、创建时间及可执行路径固定身份，并要求子进程创建不早于父进程；不停止这些系统进程。保留旧原始记录，独立重算的 `process-attribution-correction.json` 未发现已观察身份残留，但没有改变第 2 轮 failed，也不证明未捕获的短寿命进程不存在。

### 重挂生命周期与 TAE 的负向验证

重挂测试先后实际复现空目录、并发清理、A→B→A 旧请求复活、clear 后后台失败重新发布目录、旧分析被新代际覆盖导致退出提前释放依赖。最终 7 个真实服务行为测试全部通过；renderer/main 自动发现合集 **1491 passed / 0 failed / 0 skip**。RAG drain 还用“立即返回”和“仅等待首次快照”两个进程内错误替身验证断言，两者均失败，实际实现通过。原有生命周期 VM 验证器因缺少新增状态绑定出现 `ReferenceError`，已补齐状态并增加取消、目录清空断言，没有删除旧检查。

TAE 第一组 13 个用例在旧 writer 上 11 failed / 2 passed；名字别名补充组在修复前 2 failed / 1 passed。随后一次全 C# 运行 153 passed / 1 failed / 2 平台 skip，唯一失败为测试将本项目归一化的 `null` 空名字误写成 `""`；完整独立字节期望当时已通过。确认生产 reader 的既有空字符串语义后修正断言，未改 reader。最终 **155 passed / 0 failed / 2 平台 skip，共 157**，18 个新增用例均通过。最后新增的零参数 EOF 负例没有保存旧版本失败运行，不作此声称。真实 Release Bridge 执行 SF11 合成套件报告 11 case 通过，包含独立字节与拒绝检查；随后独立复核还发现一处 handle 负例会吞掉自身失败，修复及重跑结果另列。

### 5308 / 10d9 的历史 Windows 产物与回执

`5308b0d6` 对应生产 app 的 source 指纹为 `eb5ec952953aa57ad2c98cbeac0ab43fb2e3d0bf05a61aa313b650c659a97ed5`，output 为 `b157be222c6124c803248ce6be165f2643de5817fa34a9113217739a2b92eded`，1230 个 source、22 个 output。构建发生在提交 TAE 修改之前，但修改内容与提交完全一致；`build-lifecycle-final.json` 保存当时 HEAD、dirty diff 摘要及未跟踪源文件摘要，app 指纹保存在 `build-lifecycle-final.stdout.log`。当时生成的活动 manifest 已由后续构建替换，不把当前活动文件当作历史不可变回执，也不将旧 HEAD 文本冒充当时已提交状态。

`10d9b8f8` 构建成功、tracked diff 为空，source 为 `095266466446252494f453de79ced7d149beb2c274828b3abd7618ce5c4fbc4d`，output 为 `a01f83195a2bb303f87bdfb9d4da55e617a98bf840ee23794f1b55207faa6e9d`，1231 个 source、22 个 output。回执为 `build-shutdown-final.json`，该 manifest 另存为 `agent-production-build-10d9b8f8.json`。提交前的同内容 typecheck、42 个 shutdown/semantic 源码 fixture，以及 renderer/main **1497/1497** 均通过；fixture 中的 deferred 端口测试不替代真实 Electron 退出。

当轮 Windows Bridge source 指纹为 `8b103630a004b807badc630a895b9f8064d66e86ccec98d1939264e6201ab025`，exe 为 `5d9355a12c4f3a077d36a05d04f86526af38e1318be5114b43071b58fb103d24`，helper 为 `6eb186d2906b89a6e67fe63cddfa0435096fe214770ff876d995c13a5a51f046`。`bridge-publish-lifecycle-final.json` 绑定当轮 tracked diff 为空的实现，不是本报告最新 Bridge。

较早的第二轮自动发现回执 `checks-unit-root-repeat.report.json` 为 **379 passed / 1 failed / 3 unavailable / 0 not_run**；唯一失败是 Windows Job 最终回执替换失败，构建和 binding 子步骤已经成功。安全重试的生产链实测使用真实短时 reader 触发错误 32；1175 为故障注入，不据此判断杀毒软件或其他占用者。[微软 ReplaceFile 的错误语义](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew)

### 后续 Linux 与真实 SF11 输入

Linux 独立目录 `/home/asus/soulforge-validation/closeout.8pH2CC` 在 `5308b0d6` 顺序执行 11 个步骤，前段失败没有阻断尾部：类型检查、构建、renderer **1491/1491**、storage **10/10**、C# **157/157**、Bridge publish、SF11 synthetic、Electron SQLite 实际绑定及 Bridge synthetic 均 exit 0；owned-process 为 **7 passed / 17 Windows 专属 skip**，不称作 24 项全通过。

native identity 首轮 **40 passed / 1 failed / 1 平台 skip**。唯一失败来自旧插入 fixture 未更新的字节期望：新的完整时间表需要更新偏移和计数。`83c732a9` 没有扩大忽略区间，而是用固定原始字节、完整时间值表、事件记录及指针，独立构造整个预期输出并逐字节比较。Windows 定向 **16/16**；Linux 快进后重跑 **41 passed / 0 failed / 1 Windows 专属 skip**。原失败保留于 `linux-lifecycle-final-results.tsv`，新结果在 `linux-lifecycle-fixture-final-results.tsv`。

对应 Linux Bridge source 为 `cd03f14bc382d204a3933abab9d8e83ce3d40ef1ff856835e9f0b769a92c4fbc`，exe 为 `46c300862d423226eeb7f8ae24c65a725534696b0d59f07d7bbe9b53a5247165`，helper 为 `6d14e46c18e7c0cd97d6a07e38d74cea773eca783461d6d33a79114c442c4a00`。独立 checkout 的换行及平台构建不同，不要求 Windows/Linux 产物同 hash。

Windows SF11 native 首次把 fixture root 指向包含 `mods` junction 的仓库目录，正确拒绝 `NATIVE_FIXTURE_OUTSIDE_ROOT`。核对物理游戏目录后，仍使用同一固定 registry 与真实文件重跑；`sf11-real-cow-final-physical-root.json` exit 0、`realCorpusUsed=true`，在真实 anibnd 提取的 TAE 中插入事件、原生回读并确认临时残留为 0。这个检查没有经过完整 Patch/CAS/journal 回滚，也没有独立外部 reader，不与后面的真实共享槽写入验收混为一谈。

### SF11 负断言与真实共享槽回滚

独立复核发现 handle 负例将被测调用与 `fail()` 放进同一 `try/catch`，会吞掉断言自身的失败。源码绑定的 Node probe 确認：旧逻辑对 no-op validator、错误异常都未能检出；`e04cf069` 改成匹配 `INVALID_INTEGER` 的 `assert.throws` 后，两个错误替身均被检出，真实 validator 仍通过。不是通过删除负例修绿。`sf11-negative-mutant-{red,green}.json` 保存红绿结果，实际 Release Bridge SF11 合成套件随后 11 case 通过。

`tae-shared-real-inverse-final.json` 在 `e04cf069` 的 CLI core/shared 与最新 Release Bridge 上通过。每次使用新的 UUID owned 副本，只写一次 `action://c0000/tae/3/A2010/e0`：先读原生 proof，将起始帧从 0 改为 1，结束帧保持 23，经 Patch/CAS 提交，再由生产原生 reader 和固定的 SoulsFormats NEXT oracle 分别回读。独立 `preservedSha256` 不变。最后按真实 `opId=37982672-50b5-4ab7-8753-7dbed6532116` 执行逆事务，核对其独立 committed journal、目标文件前后哈希，整个容器及原 Mod 都恢复/保持 `d26a4afd8a9842953529c939aa5187f85662a4d1efb767ec4e6af5d72a124e87`，独立 reader 再读起始帧 0。

首次私有 harness 错误要求原操作状态变为 `rolled_back`，因此整套报告失败；实际回滚产生独立的 `committed inverseOfOpId` 记录，原 committed 事实不会被改写。原失败、两条实际 journal 和已恢复副本均保留。修正验证器后，缺逆记录、错误 owner/hash、未提交逆事务/transaction、改写原提交事实等 6 个负例均被检出，再在新副本重跑。没有重放旧副本写入，没有将原失败记录改为通过。

通过的私有目录为 `tae-shared-real-84ccaccf-c44a-41bb-8601-2a503ad83f9c`。源码、已编译 core/shared、Bridge、oracle/query assembly 与 harness 均绑定并在结束复核。它证明此次真实资源的直接工具写入与回滚，不证明模型已完成这条任务，也不替代桌面、GPU 或所有 TAE 模板验收。

### #53 真实词条新增

同一真实 Mod 的另一个新 owned 副本通过 `insert_tae_events` 在 `a50 / A2010` 追加 1 个 type 0 词条，模板固定为 e0，新词条帧区间为 2–3。生产原生 proof、Patch/CAS、提交回执、新地址 `action://c0000/tae/3/A2010/e30` 回读均通过。独立 SoulsFormats NEXT query 确认事件数 **30→31**、新增 type/time/参数与固定期望一致，所有既有动画、miniheader、事件时间/参数及其他 binder 条目的独立摘要不变。此摘要不声称覆盖所有未知 TAE header 字节。

实际操作 `5d576938-7b82-42f1-9219-249e81ff1a9d` 的逆事务为 `0f5b00c9-9493-4966-b045-126ce0791c1d`；回滚 journal、整容器与原 Mod hash、独立恢复回读全部通过。没有把原提交改写为 rolled_back。记录为 `tae-insert-real-final.json` 与 `tae-insert-real-5ce00fb7-dd18-44df-83f4-4393e82e8420/report.json`；query source SHA 为 `711bec33d66e123592bad456332eb344553ae4a9e3988481c2c27c2a8f997653`，query assembly 为 `4e8428ea50a647d4f56f905e67e3f9b3b662718d502358591d8e712fc354d79e`，独立 reader assembly 仍为 `e4fbf600b36ab457a6ae6e09dd9eedc050066be2e1033e2459df9149544fe959`。

运行时只有桌面退出修复处于未提交编辑中；此实验不加载这些 desktop 文件，实际加载的 CLI core/shared/agent 与 Bridge 输入在前后保持一致。最终桌面版本仍须另行验收。本次没有测试字段覆写或制造真实并发 CAS 冲突，不把它们合并计作通过。

### 10d9 的历史双轮失败（842 / db534 复测另列）

`memory-shutdown-final.json` 对应 `runtime-6585db67`，运行 2026-10-04T10:09:41Z–10:33:20Z，exit 1。仍使用同一 276 个文件、729,167,288 字节的 owned Mod 副本与只读原版；没有增加 heap 上限、没有用另一进程规避峰值。

- 第一轮：打开及分析 315.0 秒；PARAM 原生 CAS 写入 173.7 秒，语义收敛；按 opId 回滚 64.9 秒；切换空工作区 77.4 秒；完成切换后堆快照。
- 第二轮：挂载和分析成功，430.0 秒，旧的 60 秒 UI 挂载上限未放宽。写入 185.0 秒返回已提交 `580a3bbf-3832-47ac-b547-65d1480eecfe`，但 `knowledgeRefresh.status=failed`、`semanticState=empty`，故验收以 `SEMANTIC_READINESS_FAILED` 失败，未将文件提交成功当成语义刷新成功。
- 失败后未重放写入。真实 inverse `2d04bcc8-057b-4e5f-9025-30394e38f88f` 在 99.5 秒内恢复，原生回读及完整资源树哈希一致。第二轮没有完成切换，不计成“双轮通过”。正常 Electron close 返回，未强杀，按 PID/创建时刻/可执行文件身份检查未观察到残留；原 Mod 276 文件 hash 与开始一致。
- 第二轮写入阶段 main 观测峰值 heap 3,214,840,916 字节、RSS 3,724,632,064 字节。第一轮切换后的 GC 快照节点 self size 从 24,170,563 增至 30,037,314 字节；该数值不是完整 dominator retained size，不能据此证明全部内存增长已解决。
- 第二轮失败状态的 main 快照为 1,328,044,879 字节，已保留 SHA-256 `110b3139ed504e5ee36ebf84c6d3be13376c6ec8f924365d01c3ff1ca96e2260`。原分析器明确标记大快照需流式分析，未为出结论把整个 1.3 GB 文件直接 JSON.parse，也未将缺失分析记为通过。

新关闭屏障的 deferred 负例、真实正常退出和原资源恢复已得到各自证据；它们不能抹掉第二轮写后语义失败及峰值内存问题。

### 10d9 的完整检查及后续定位

`final-validation-series.tsv` 记录了同一提交上顺序执行的模型、安装、自动发现、完整 E2E 和 Linux 检查。模型与自动发现失败没有阻断尾部：Windows 完整 E2E **85/85** 通过；Linux 类型检查、构建、renderer 1497 项、shutdown fixture 42 项、SF11 及 Electron SQLite 实际绑定共 6 个步骤均 exit 0。Windows A/B 安装输入来自 `run-CBxa8p/manifest.json`，仍是同源、无签名、独立身份实验，不是官方自动更新验收。

自动发现 `checks-shutdown-final.report.json` 为 **384 passed / 3 failed / 3 unavailable / 0 not_run**，481 次 operation 调度、301 个独立 operation、180 个复用位置。3 个失败随后分别定位：

1. Agent 关闭屏障用 `Promise.resolve().then(operation)` 登记任务，意外将原来同步捕获的工作区身份推迟到 microtask；旧的 same-ID 与 A→B→A 负例正确检出回归。修复先登记 pending promise，再同步调用 operation，不靠延迟测试的工作区切换来取得通过。
2. TAE 多事件 fixture 移动了事件和时间数据，却未同步首动画的时间表偏移及计数。writer 的拒绝正确；只修复造样器，并以独立字节期望逐项核对 240 个事件、480 个时间值和未改原始字节，不放宽 writer。
3. 重挂 fixture 仍只期待 1 次数据库入口，实际现在有后台目录扫描和一次 readiness 分析。改为分别核对这两个阶段，再确认重复 readiness 不重试失败的 generation；没有修改生产行为。

3 个 unavailable 仍对应缺少独立 scene 输入及 Windows 上未运行的 POSIX 专属测试，不折算为通过。上述 85 项 E2E 和 Linux 结果只绑定 `10d9b8f8`，后续修改另行记录，不能自动套用为最终源码全套实跑。

### PARAM 刷新投影不一致

`runtime-6585db67` 第二次写入的语义刷新在 180,040 ms 触发已有总 deadline；没有观察到数据库请求自身超时或 OOM。99 批 upsert 共处理 50,303 个 chunk，其中 50,279 个 body 改变，数据库约耗 123,988 ms；随后 117,707 条 references 的替换约耗 37,418 ms，迟到返回时实际数据库调用已完成。

初始分析与重挂的 canonical PARAM 只解码带可信引用信息的字段，提交后刷新却使用全字段默认值。两种投影将字段写入同一个 chunk body，导致一行受控修改也重建几乎全表 FTS。修复统一 post-commit 的 `referenceFieldsOnly: true`，定向原生字段读取仍保留全部明确请求的字段；没有延长 180 秒 deadline、关闭 FTS 或提高应用 heap。

补充复核还发现，定向字段读把用户输入的表别名当成原生子条目身份；修复按返回的 entry 身份分组。合并索引时保留 duplicate row ID 的独立物理 `rowIndex`，规范化已有 `raw.rowIndex` 与定向读的顶层 `rowIndex`；矛盾身份、同逻辑行的已知/未知物理身份混用，以及显式外层 hash、子条目 hash、revision 冲突均拒绝，不修改先前索引。读取本身不因语义投影被拒而伪报原生失败。

### 失败状态堆的流式观察

离线分析完整校验了上述 1,328,044,879 字节快照及其 SHA。默认 768 MiB 图预算拒绝的记录保留；在核对主机可用内存后，另一次显式使用 1280 MiB **离线图数据预算**，分析器 `--max-old-space-size=256` 不变，应用配置完全未改。分析器峰值采样 RSS 为 1,201,000,448 字节、JS heap 为 71,080,544 字节，不能将这些数字当成 SoulForge 应用内存。

快照含 12,089,919 个节点、55,980,039 条边，节点 self size 合计 616,272,425 字节。字符串相关 self size 占约 71.13%，内容已省略，不能归因为某一种业务文本。观察到 `activeRag → chunks`、`activeRag → references` 和 `activeIndex → references` 的非弱根路径；两个引用数组并不证明引用对象整体复制两份，源码在这些位置复用 edge 对象。

这份快照采于第二轮回滚后、正常关闭前；由于失败，第二轮尚未切换到空工作区。它证明当时打开工作区的 live owner 可达，**不是关闭后泄漏证据**。工具未计算 dominator retained size，也没有穷尽全部根路径；最大 self 节点的有限列表不构成唯一保留者或泄漏根因判断。回执为 `memory-failed-heap-stream-bounded1280.json`，安全观察结果为该 runtime 下的 `failed-state-main.streaming-observation-1280.json`。

### 842：双轮操作完成，降内存仍未验收

`memory-param-identity-final.json` 对应 `runtime-7565daec`，2026-10-04T11:37:15Z–11:55:34Z，exit 0。输入仍是前述 276 文件 owned Mod；构建 source 为 `2dd0f477eb689c981b0a5172b21dd9c60ebd53134329254e2886608ec96b1f32`，output 为 `49071163b6a2e6a5a74dd9bf7c5ad99cb9dc279c20d240b318464d752922493c`。不可变清单为 `agent-production-build-842bfeba.json`，构建回执为 `build-param-identity-committed.json`。

| 阶段 | 第 1 轮 | 第 2 轮 |
|---|---:|---:|
| 打开与语义分析 | 314.9 秒 | 325.6 秒 |
| PARAM 写入与语义收敛 | 90.7 秒 | 96.9 秒 |
| 按 opId 回滚与语义收敛 | 61.5 秒 | 67.9 秒 |
| 切至 owned 空工作区 | 55.9 秒 | 55.8 秒 |

两次写入分别为 `e6b14c0e-41ec-45c6-9d38-44ad887c9cc9`、`8e794e41-7146-4bdc-888a-014fbac5ef67`；对应 inverse 为 `28de3673-2163-4688-a313-9d1c8c1434f6`、`e3924316-0c6f-452e-994f-23cde61f1f5f`。每轮原生值及完整资源树均恢复。正常 close 返回，未强杀，已观察进程身份没有残留；原 Mod 前后 hash 相等。既有 UI 60 秒、提交后语义 180 秒上限和应用堆配置均未放宽。

343 次采样中，第 2 轮写入峰值 JS heap **3,272,613,864 字节**、RSS **3,697,508,352 字节**。与 10d9 的 3,214,840,916 字节 heap 相比，**不能声称峰值下降或 OOM 已修复**。本轮证明的是两轮操作完成以及投影不一致导致的超时已不再出现；单次前后耗时也不是统计显著的性能结论。

两轮切换后的 GC 快照均完整分析。main 节点 self size 为 **24,176,341→30,014,540→30,651,788 字节**，renderer 为 **12,314,527→16,413,453→16,544,253 字节**。main 第二轮增量 637,248 字节主要出现在 JIT 代码/元数据、字符串等组；最大新对象的有限路径仍含 `entryHaystackCache`、`compactTokenCache`、`paramTextFieldCacheById` 的 backing table。这不是 dominator retained size，也不能据几个缓存的 self size 推断 3.27 GB 峰值根因。utility/.NET managed heap 与真实 embedding 路径仍未测。原始快照及 `heap-observation.json` 保留在该 runtime，回执为 `memory-param-identity-heap-final.json`。

### #40：同一业务状态 oracle 的旧红与新绿

`issue40-race-pair-final.report.json` 在 `842bfeba` 上通过。旧侧完整转译 `c4a8b158` 的 `workspaceStorage.ts`，真实执行其 db/wal/shm 三次复制，只在 db 已复制、wal 尚未复制时通过外部 I/O 时序端口插入 checkpoint 和一次事务。新侧导入当前 production `backupWorkspaceDatabase`，先核对 dist 与完整 TS emit 一致，再在 SQLite backup progress 边界插入相同源状态变化。

源依次出现 `(0,0)→(1,0)→(1,1)`；旧复制目的库实际为 **`(0,1)`**，`integrity_check=ok`，但同一独立业务状态 oracle 报红。当前 backup 得到 **`(1,1)`**，oracle 通过。没有把缺函数、编译失败或 ABI 错误当作旧版负例。两侧仅使用 owned 两行数据库，退出清理通过；用户原库未参与。与之前真实副本、一致性备份取消不发布和迁移恢复实测共同构成 #40 的验收，不外推未测试的所有故障时机。

### #32：实际 Electron 的探测与后端分离

`webgpu-runtime-pair-final.json` 在同一 `842bfeba` 产物上通过，私有目录为 `webgpu-runtime-0c8d8f63-1548-4a95-9ab5-210c7810a0f7`。Electron **43.0.0**、Chromium **150.0.7871.46** 的真实 `navigator.gpu` 返回 `nvidia / lovelace`；当前完整 detector 报 `WEBGPU_ADAPTER_FOUND`，旧 c4 完整 detector 因 `requestAdapterInfo is not a function` 报不可用。

detector 对照是把完整 TS 模块转译后，经 DevTools 在真实 renderer 另行执行，未替换 bundle 内函数或伪造 navigator。随后打开单文件 owned Mod 的 c1130 动作，真实生产 scene 获得 **WebGL2RenderingContext**，未指定后端、未替换 renderer factory 或 IPC。观察包装原样转发 `getContext` 的 receiver/参数和返回值。截图确有角色，源码与产物前后指纹一致，owned 资源清理通过。该记录证明 #32 的当前机运行条件；它不是六类视觉基线、正确姿态或 WebGPU 双层材质验收。

### #51：实际旧 reader 红测与独立 HKX 分类

`tae51-reader-pair-final.json` 在同一份独立手写 1632 字节输入上编译并执行 c4 与 842 的完整 reader 及其六个依赖模块。旧版确实返回 `[400010,400020,22]`，事件、时间、参数、HKX 仍配在原动作上，指定断言 exit 17；当前返回手写期望 `[400000,400010,400020]`，exit 0。字节 SHA 为 `b56e7f88dfad13626990da53dad103f2be7f7e8f22231280cbb5bcca0cf103a3`。编译、依赖错误和解析异常不充当旧红。模块未摘函数、未删方法或用 stub 替代依赖；这不是整个历史应用 A/B。

`tae51-hkx-observed-final.json` 使用固定 SoulsFormats NEXT reader 和既有 Oodle，对固定原版与 Mod 分别独立统计。原版 2209 动作中，1564 个标准 miniheader 的 HKX 后缀等于自身动作号，312 个标准 import-HKX 的后缀不同，333 个为 import-other。Mod 2219 动作对应 1564、312、325，另有 18 个标准但名字不符合 HKX 命名式的动作。两份均超过固定阈值 1517；未把完整 binder family+suffix 和局部动作号混为一谈。这一步仅是独立观察，生产 Bridge 全部 `(section,ID,HKX name)` 的直接对照另列。

### #52：真实最大动作经 Agent 工具完整续读

`tae-max-delivery-final.json` 对应 `tae-max-action-3793f75d-3036-4e22-801a-9e836c26b2a0`，绑定 `452fcaa9` core 源码和产物，2026-10-04T12:22:40Z–12:24:28Z，exit 0。Bridge 构建包含正在收口的 IPC flush 修复，源码指纹 `b4dfb6fee72f62cb94d7750ec01269d0c639a3ee8d15698945d250e1aead9742`、exe `c825e82fdd5e7eb874e6ff286516ed1f645084071710dee410006a52ea180d1a`；运行前后依赖文件严格一致，不把同时修改的无关治理脚本当成 TAE 实现漂移。

独立 reader 扫描固定 Mod 的 65 段、2219 动作、74705 词条，选出唯一最大动作 **a50 / entry 3 / A320020，共 296 词条**，子项 hash `0d629461611f1be54ff4758102dbfe55990f5ce987d9574f22a04d8755d812db`。生产 `read_tae_events / search_tae_events` 经真实 AgentToolBridge 验证全部原生分页、兄弟词条顺序、字段命中、双动作 limit、完整 continuation、来源/版本/跨动作游标拒绝；未产生写入事务，session 已关闭，原文件和实验副本 hash 不变。每次模型侧 envelope 均受实际 65536 字节限制，无模型调用。

第一次私有验收错误假定两动作的预览总数必须大于 2，真实事件约 7.5 KB/条，20 KB 预览预算下合法结果恰为 1+1。该失败保留在 `tae-max-real-final.json`，没有放宽生产预算。修正后的独立断言要求两项是不同动作，并逐条续读到各自原生 EOF；36 项纯断言测试含扁平 event hit、重复动作、丢兄弟词条、丢 continuation 和 1/296 假完整负例。仅独立选出的前三大动作进入实验索引，故字段唯一性只声明最大动作范围，不宣称全 c0000 检索覆盖。

### #51：生产原生列表与独立全量期望逐项相等

`tae51-production-hkx-final.json` 补齐上述直接对照：生产 Bridge 分别读取 18 页，将原版 2209、Mod 2219 个 `(entryIndex, animationId, HKX name)` 全部与固定独立报告比较，全部相等。每份均为 1564 个标准名字后缀匹配自身 ID，全部 section 的首尾也包含在全量集合内。产物为 `c93ca3c1` 的 Release Bridge，exe SHA `0247239d1fbfb0eaff694865279ee772fc8c73716c23d85616f356d46d9723ae`；原资源前后 SHA 不变。这与独立字节 reader 红绿、现有定向写/回滚和版本失效测试合用，不再用合成动作总数代替真实输入。

### #43：官方本机导入工具的真实大资源验收

独立下载 [WitchyBND 3.0.1.0 官方发布](https://github.com/ividyon/WitchyBND/releases/tag/3.0.1.0)，ZIP 48308252 字节、官方 SHA `a3e6b2a0f7eac13f5e83b6602a1149322439c0662baa140ecdd84be28af50364`，EXE SHA `00aa5b321d5af0179d3c9154a48d2ab3bb55772eaf624a439cc5f6ad4e21982b`。依据 [该版本 GPL-3.0 许可证](https://github.com/ividyon/WitchyBND/blob/3.0.1.0/LICENSE)，只作本机独立进程输入，未加入产品、安装包或仓库提交，没有重新打包能力。

真实 Mod `sfxbnd_commoneffects.ffxbnd.dcx` 为 **224675182 字节**，SHA `8f4fb728c4cbfae61b5e194ff9120b387ca5c72c37b5becc824a57dcfee550bf`。首次启动暴露双 hash pending 路径过长：同一官方 exe 在短 CWD 可以启动，309 字符 CWD 的 `Process.Start` 返回 Win32 267。`c93ca3c1` 将暂存移到 cacheRoot 下短 UUID，完成目录仍按源 hash/tool identity 双键原子发布；64 MiB 原生叶文件边界没有放宽。新增 C# 回归及整套为 **156 passed / 2 平台 skip**，跳过不计通过。

修复后工具首次初始化在 `%APPDATA%/WitchyBND/appsettings.user.json` 创建了 442 字节配置。配置身份在解包期间改变，Bridge 正确返回 `LARGE_RESOURCE_UNPACKER_CHANGED`，未发布缓存、未留下 pending；没有关闭身份检查绕过失败，也未删除该工具生成的配置。初始化后的新实验 `witchy-large-initialized-final.json` 在 2026-10-04T12:32:31Z–12:33:19Z 通过：24.9 秒冷读得到 7535 条目，后续列表、叶 snapshot、原生 FXR 读取各约 5.5 秒；原始容器和配置前后 hash 一致。

叶内容与 manifest hash 相等，`sourceUri` 指向原容器的物理条目而非缓存目录；错误源版本被结构化拒绝，缺失工具返回 unsupported，不伪造通过。FXR reader 明确保留未解析结构范围，缓存响应是 read-only partial，外层 `roundTrip.byteIdentical / payloadIdentical` 均为 false。原始失败回执 `witchy-large-real-fresh.json`、`witchy-large-short-staging-final.json` 保留，后续成功不覆盖它们。四条历史套件的结果另外登记。

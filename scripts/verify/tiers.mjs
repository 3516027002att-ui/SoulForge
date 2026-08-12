/**
 * 层级归属表。
 *
 * 这是本套工具里唯一需要手写的表，因为「什么时候该跑这条验证」是工程判断，
 * 无法从代码推导。依赖（native-env / dotnet / emedf / opt-in）一律由
 * classify.mjs 静态分析得出，不在此表重复——重复就会漂移。
 *
 * 未登记的 script 不会被静默忽略：`node scripts/verify.mjs --audit` 会把它
 * 报成 SUITE_UNREGISTERED 并失败关闭，因此不存在「加了一条验证但没人跑」。
 */

/** 层级执行顺序：先快后慢，早失败早停。 */
export const TIER_ORDER = Object.freeze(['governance', 'unit', 'synthetic', 'native', 'release']);

/**
 * script 名 → 层级。一条 script 只属一个层级。
 * 归属原则：按「改了什么就该跑什么」而非按依赖强度划分。
 */
export const TIER_BY_SCRIPT = Object.freeze({
  // ---- governance：治理数据、交接书、范围裁定。秒级，任何改动都该跑 ----
  'test:governance': 'governance',
  'test:governance-data-fixtures': 'governance',
  'test:governance-equivalence': 'governance',
  'test:handoff-integrity': 'governance',
  'test:handoff-integrity:fixtures': 'governance',
  'test:release-scope': 'governance',
  'test:release-scope-fixtures': 'governance',
  'test:release-scope-proposal': 'governance',
  'test:v06-deferral-index': 'governance',
  'handoff:fingerprint': 'governance',
  // 交接书投影退化门禁。--check 只答「markdown 是否等于当前 JSON 的投影」，
  // 它抓手改表格，抓不住投影器自身退化——那类改动会让 --check 与生成同时
  // 「一致」却把交接书写坏，门禁全绿。实测把空值渲染从 — 改成空串时，
  // 仅靠真实数据的 2858 项断言全部通过，所以边界 fixture 本身承担门禁职责。
  'test:handoff-projection': 'governance',
  // 验证入口自身的负向 fixture：跳过检测一旦失效，入口会把「什么都没跑」
  // 报成通过而退出码依旧是 0，退化后与正常表现完全一致，因此必须门禁化。
  'test:verify-entrypoint': 'governance',
  'verify:audit': 'governance',
  // 治理锁与 claim CLI 的负向 fixture：坏锁与好锁在顺序执行下表现一致，
  // 只有并发与崩溃场景能区分，不门禁化就等于没有锁。
  'test:gov-cli': 'governance',
  // seal 的指纹算法一致性与 commands 极性约束。守的是「两套 git 参数分叉」——
  // 分叉表现为封存当时通过、门禁却判无效，seal.mjs 自己把它列为最难查的一类。
  // 此前这条 fixture 只存在于 seal.mjs 的注释里，文件不存在。纯静态 + 只读工作树，
  // 任何机器可跑，归 governance。
  'test:seal-cli': 'governance',
  // 孤儿 smoke 门禁。verify:audit 只能看见「已登记的 script 缺层级」，看不见
  // 「有 smoke 文件但没有任何 script」——本轮实测到 5 个这样的文件共 3869 行，
  // 其中一个还被生产代码注释引用为覆盖依据。秒级，归 governance。
  'test:orphan-smoke-gate': 'governance',
  // 临时目录泄漏门禁。smoke 用 mkdtemp 建工作区却不释放，本机实测累计 25809 个
  // 残留目录、约 3.8 GB；泄漏不会让任何测试变红，只能靠静态门禁发现。存量走
  // 只允许缩小的台账。纯文本扫描，秒级，归 governance。
  'test:smoke-temp-cleanup': 'governance',
  // 探针/临时文件零容忍门禁。scripts/ 下的 `_probe*` / `_tmp*` 被 gitignore，
  // git status 永远干净，实测一次清出 16 个、最早跨半个月无人发现。扫实际文件名
  // 而非维护清单，拦残留不拦存在。纯文件系统扫描，秒级，归 governance。
  'test:probe-residual-gate': 'governance',
  // 陈旧 TFM 构建产物门禁。与探针残留同源（gitignore 覆盖、全仓零引用、无人清理），
  // 但更危险：残留的是**能跑起来的旧版 Bridge**，手误指向它会拿到一个月前的解析行为。
  // 实测清出 bin/Debug/net6.0 与 net8.0 两个目录、各含 SoulForge.Bridge.exe。
  // 判据从 csproj 的 TargetFramework 推导而非写死版本号，故升级 TFM 时不会误报。
  // 纯文件系统扫描，秒级，归 governance。
  'test:stale-tfm-gate': 'governance',
  // 跨机复现**判定逻辑**的负向 fixture。BLOCK-4「跨机 installer 验证」结构上需要
  // 第二台机器，本机确实无法解除；但判定逻辑本身不需要第二台机器就能验证，
  // 而实测它零覆盖：test:release-cross-machine 只调默认 audit 模式，
  // --export 与 --compare 全仓零调用。也就是说等真有了第二台机器，用来下
  // 「跨机指纹是否一致」这个判定的代码，从来没人证明过它会在该红时红。
  // 最坏形态是误绿——compare 把两份不同指纹判成一致，而它是 REL-COMPLIANCE 的依据之一。
  // 判据用构造的导出记录驱动 compare，逐字段单独差异各测一次（只测「全都不同」会让
  // 「只比一个字段」的实现全绿）。纯静态、临时目录、秒级，归 governance。
  'test:cross-machine-fixtures': 'governance',

  // ---- unit：编译 + 跨包单元与契约。代码改动必跑 ----
  typecheck: 'unit',
  test: 'unit',
  'test:ai-conformance': 'unit',
  // AI 工具权限阶梯的**生产**实现。ai-conformance 里有 5 个 case 断言的是
  // testing/harness 下自建的 evaluatePolicyGate/maxPermissionFromMode——那三个
  // 符号全仓只存在于测试目录，生产走 ai/toolPermissions.ts 的
  // isAiToolPermissionAllowed。改坏生产上限（如让 plan 返回 rollback），
  // conformance 58 个 case 照样全绿。纯逻辑，归 unit。
  'test:ai-tool-permission': 'unit',
  'test:ai-fake-loop': 'unit',
  'test:desktop-security': 'unit',
  // 本轮从孤儿状态接线：SqliteOperationLogStore 全阶段 journal 接线 + 磁盘
  // 错误/ACL 失败关闭。不依赖真机 corpus，故归 unit。
  'test:core-journal-wiring': 'unit',
  'test:editor-document-store': 'unit',
  // EditorCatalog builder 与 Sekiro 固定规则（front-end.md CAT-05）：确定性
  // fixture 驱动，不加载 native 资产，纯逻辑，归 unit。
  'test:editor-catalog': 'unit',
  // shared 侧 decoder 契约与固定注册表负向测试（front-end.md SCHEMA-02 /
  // ROUTE-06 的 resolveIntegrationForConfirmedLeaf）。经根转发
  // test:editor-catalog-schema 调度；纯静态、秒级，归 unit。
  'test:editor-catalog-schema': 'unit',
  // renderer 纯逻辑单元测试（changeControl 状态机等）。此前 renderer 侧零单元测试，
  // 唯一的 e2e 又跑在 mock main 上（19/56 通道），拆 App.tsx 时没有安全网——状态
  // 复位漏一处不会有编译错误也不会有测试失败。无 DOM/IPC 依赖，故归 unit。
  'test:renderer-unit': 'unit',
  // 统一原生 mutation 写链：取消/确认重试/staging 失败三条分支收敛到一处后，
  // 任一分支静默丢失都不影响正常路径通过，必须由负向断言门禁化。
  'test:editor-mutation-service': 'unit',
  'test:emedf-schema': 'unit',
  'test:emevd-dsl-compiler': 'unit',
  'test:emevd-envelope-map': 'unit',
  'test:emevd-external-adapter': 'unit',
  'test:emevd-four-view': 'unit',
  'test:emevd-ipc-contract': 'unit',
  'test:emevd-plan-commit': 'unit',
  'test:fmg-msb-ipc-contract': 'unit',
  'test:hex-scene': 'unit',
  'test:me3-runtime-adapter': 'unit',
  'test:me3-runtime-gateway': 'unit',
  'test:model-service-configuration': 'unit',
  'test:model-service-vault-contract': 'unit',
  'test:openai-responses': 'unit',
  'test:param-msb-write-ipc-contract': 'unit',
  'test:performance-baseline': 'unit',
  'test:resource-index-diagnostics': 'unit',
  'test:scene-asset-inventory': 'unit',
  'test:scene-draw-list': 'unit',
  'test:subprocess-control': 'unit',
  'test:three-scene-module': 'unit',
  // 场景投影层头less功能冒烟（backend-resolution/picking/resource-release）。
  // 合成语义场景驱动，filesystemAccess=false，无真实资源依赖，故归 unit。
  'test:three-scene-functional': 'unit',
  'test:ui-localization': 'unit',
  'test:vault-encrypt-contract': 'unit',
  'test:vault-ipc-contract': 'unit',
  'test:workbench-projections': 'unit',
  'test:database-utility': 'unit',

  // ---- synthetic：合成 native 契约与恢复矩阵。需 dotnet，不需真实资源 ----
  'bridge:build': 'synthetic',
  'bridge:verify:synthetic': 'synthetic',
  'bridge:verify:client': 'synthetic',
  'bridge:verify:crash': 'synthetic',
  'bridge:verify:daemon': 'synthetic',
  'test:bridge-recovery-harness': 'synthetic',
  'test:bridge-staging': 'synthetic',
  // Bridge allowed-root 生命周期（front-end.md §13.2）：read 不得附加不存在的
  // staging、stage 必须 mkdir→realpath→boundary check 后注册、链接越界拒绝。
  // 用真实文件系统（含 Windows junction）验证 helper 本身，不需要 exe 与语料，
  // 故归 unit（同 verify-recent-paths）。
  'test:bridge-roots': 'unit',
  // Bridge 确认格式栈与 locator 装配（front-end.md NATIVE-03）：需要真实
  // Bridge 二进制但 fixture 自造（不加载真实游戏语料），故归 synthetic。
  'test:native-document-locator': 'synthetic',
  'test:writer-failure-matrix': 'synthetic',
  'test:standalone-writer-failure-matrix': 'synthetic',
  'test:sqlite-crash-recovery': 'synthetic',
  'test:power-loss-recovery': 'synthetic',
  'test:large-transaction-recovery': 'synthetic',
  'test:cross-session-journal': 'synthetic',
  'test:upgrade-recovery': 'synthetic',
  'test:paramdef-layout': 'synthetic',
  'test:param-metadata-mismatch': 'synthetic',
  'test:param-field-mutation': 'synthetic',
  'test:emevd-plan-production': 'synthetic',
  'test:emevd-full-document': 'synthetic',
  'test:emevd-coverage': 'synthetic',
  'test:release-editor-acceptance': 'synthetic',
  'test:desktop-live-editor-contract': 'synthetic',
  // 有界访问分页数据流（W-REL-F-SCALE-02）。本轮之前它有 775 行实现但没有任何
  // npm script 引用，等于从未被执行过——而 verify:audit 只能发现「已登记的
  // script 没有层级」，看不见「没有 script 的 smoke 文件」。补登记以关闭这个
  // 盲区；缺真机 corpus 时它自身诚实跳过。
  'test:editor-bounded-access': 'synthetic',
  // 桌面 IPC 契约的真实执行观测：加载 apps/desktop/out 生产产物，观测 main
  // 实际注册的 channel 与 preload 实际 invoke 的目标。依赖构建产物，故归
  // synthetic 而非 unit；产物缺失时结构化跳过，不冒充通过。
  'test:desktop-ipc-contract': 'synthetic',
  // 上一条门禁自身的变异测试。必要性有实测证据：把 main 的
  // resource.applyFmgMutation 改名为 ...V2（preload 仍 invoke 老名字，运行时
  // 必然失败），旧 grep 式 smoke 退出 0 并打印「契约验证通过」。门禁不被变异
  // 验证过，就无法区分「没有退化」和「门禁是盲的」。
  'test:desktop-contract-mutations': 'synthetic',
  // Bridge 写盘边界（硬约束 2/3）。用自造微小 BND4-in-DCX，不需要真实游戏语料，
  // 所以能在公开 CI 真跑而不是诚实跳过。它验证的是运行期行为：越界 outputPath
  // 必须失败关闭且不留文件——源码扫描抓不到「校验通过但 writer 绕回原始路径」
  // 这类等价路径逃逸。归 synthetic：需要真实 exe，但不需要真实语料。
  'test:bridge-write-boundary': 'synthetic',
  // Bridge 命令集三方对账（广告面 / 实际 dispatch / TS 两份 union）。此前一方都没
  // 被校验，实测漂移：广告 24 条而 dispatch 26 条，6 个已实现命令从未被广告；
  // read-mtd-document 在 C# 已实现而 TS 两份 union 都没有——应用层结构上不可达。
  // 漂移长期无人发现的原因是唯一消费端 client.capabilities() 全仓零调用者：
  // 广告没人读，就没人发现它错。纯源码文本对账、无需 exe 与语料，故归 unit。
  'test:bridge-command-advertisement': 'unit',
  // BND4 重建路径的场景边界：「无损往返」与「通用重排」不得共用一条实现当判据。
  // 用自造带宽间隙的 fixture（复现真实容器形态），不需真实语料，公开 CI 可真跑。
  // 布局守卫本身在 IPC 层不可达（调用方永远传 no-op），故由文档内部自检上报，
  // 门禁断言其四项全真——否则放宽守卫会让变长字节越界覆盖后续子项而无人发现。
  'test:bnd4-repack-scope': 'synthetic',
  // BC7 (BPTC) 解码的 8 个 mode。实现由真实 Sekiro 语料验证过（c8010 的 11 个 BC7
  // 纹理全部导出、IHDR 与 DDS 头一致），但那次判据全在临时探针里、探针已删除，
  // 于是 544 行解码代码此前零门禁。判据必须打在**像素值**上而不是「导出成功」：
  // BC7 的失效形态全是静默的——partition 表错一行、endpoint 嵌套顺序读反、插值
  // 少一个 +32、位复制扩展写错，都产出颜色错误但结构完好的 PNG，定在「不抛异常」
  // 那一层会让返回全黑图的实现报绿。harness 自身是编码器，期望值由同一份语义内容
  // 按规范公式独立推导，不解析块本身。BC7 块可自造、无需真实资产，但解码在 C# 侧
  // 需要真实 exe，故与 test:bridge-write-boundary 同归 synthetic。
  'test:bc7-decode': 'synthetic',
  // BC3 (DXT5) 颜色块。守的是一个真实存在过的**正确性缺陷**：BC3 曾复用带 BC1
  // punchthrough 分支的颜色解码，于是所有 c0 <= c1 的 BC3 块槽 2/3 取值错误，
  // 且 idx==3 的 alpha 被强行清零——alpha 块里已正确解出的值被无声丢弃、像素被
  // 错误透明化。按 D3D/S3TC 规范 BC2/BC3 颜色块恒用 4 色不透明插值，无 punchthrough
  // （Khronos 正文 + 其 Issue (6) 把 MSDN 的相反暗示判为文档 bug，双源一致）。
  // 失效形态静默（PNG 结构完好、导出成功），故判据打在像素值上；fixture 的 alpha
  // 刻意非 0，否则「被清零」与「本来是 0」不可区分。同时带 BC1 对照组，钉住
  // 「BC1 有 punchthrough、BC3 没有」这条差异本身——只钉一半会让「顺手统一两处
  // 重复代码」报绿。真实语料 BC3 零命中，但 dxgi 77 / "DXT5" 两条 dispatch 早已
  // 对外可达，故修复并门禁化。需要真实 exe、不需真实语料，归 synthetic。
  'test:bc3-color-block': 'synthetic',
  // PNG 色彩空间声明。守的是「DDS 头声明的色彩空间必须如实带到导出的 PNG」。
  // DXGI 把同一种块压缩分成 UNORM 与 UNORM_SRGB（BC7 是 98/99、BC1 是 71/72），
  // 块字节与解码数值**完全相同**，差别只在「数值该被解释为线性光还是 sRGB 编码值」。
  // 此前两者合并成同一条路径且 PNG 不写任何色彩空间 chunk，真实语料里
  // 36/52 张纹理（BC7_UNORM_SRGB 12 + BC1_UNORM_SRGB 24）的 sRGB 声明被丢弃。
  // 这类缺陷不会让任何既有断言变红——像素值本来就没变，丢的是元数据；不做色彩
  // 管理的查看器照样显示正常。所以必须专门门禁化，且正反两侧都钉：sRGB 变体必须
  // 有 chunk、线性变体必须没有（多写和少写都是谎报），非 DX10 fourCC 必须报
  // 「未声明」诊断（「未声明」与「已确认线性」在产物上完全一样，只有诊断能区分）。
  // 需要真实 exe、不需真实语料，与上面两条同归 synthetic。
  'test:png-color-space': 'synthetic',
  // DDS 截断失败关闭。五条解码路径的块循环各有一句 `if (block + N > src.Length) return;`
  // ——越界即提前 return，而 rgba 是 new byte[] 全零起始，缺的块留成**黑色**。
  // 实测（8x8 逐档截断）：给一半块 → 50% 像素全零、给 1/4 → 75%、零数据 → 100% 纯黑，
  // 而三者一律报 TPF_TEXTURE_EXPORTED info 成功、无任何警告：「导出成功」与「导出了
  // 一张黑图」在输出上不可区分（违反硬约束 8）。需要多少字节是可算的（块数 × 块字节），
  // 所以这不是「信息不足只能尽力」，判据本来就该有。
  // 判据两侧都钉：截断必须 failed，而完整数据与带 mip 链的多余字节必须照常成功——
  // 只钉前者的话，「一律拒绝」这种假修复仍会全绿，而那会删掉一整项已交付能力。
  // 需要真实 exe、不需真实语料，归 synthetic。
  'test:dds-truncation': 'synthetic',
  // FLVER「解析缺口必须可见」。守的不是某一条解析，而是缺口不可见这个**根因**：
  // FlverNativeDocument.Authority 此前唯一的降级依据是 layoutWarnings.Count > 0，
  // 而三批缺口全在不写 warning 的路径上——SemTangent/SemBitangent/SemVertexColor
  // 声明后零引用且语义 switch 无 default、同语义第 2+ 个 member 被 when 守卫静默挡掉、
  // material 后 16/32 字节（含 gxIndex→GXList）从未读取。于是 11 个真实 Sekiro 样本
  // 一律 authority=native-verified/warnings=0，而实测未解析 member 194 个、505 条
  // material 后 16 字节全部非零。缺口不进任何集合就等于对上层不存在。
  // 处置是诚实标记而非补全解析：补一条解析只填一个洞，接进降级机制才是修根因；
  // 且 FLVER 属 V0.6 延期只读预览族，无往返验证就解析 GXList 等于扩大未验证声明面。
  // 判据打在运行期 envelope 上（不是 grep），且必带「无缺口基线仍 native-verified」
  // 一组——否则无条件降级也会报绿。需要真实 exe、不需真实语料，归 synthetic。
  'test:flver-gap-visibility': 'synthetic',
  // FLVER2 GX 列表解析。material 32 字节里的后 16 字节此前**整段未读**，只登记为缺口；
  // 现按双源核对的规范解析（+0x10 Flags、+0x14 gxOffset 字节偏移、+0x18 Unk18、
  // +0x1C 断言 0；GXList 循环读 item 至 int.MaxValue/-1 哨兵，item 长度含 12 字节头，
  // 终止填充长度 = 写盘值 − 0xC）。真实语料 11 个 chrbnd / 505 条 material 全部解析成功。
  // 失效形态全是静默的——+0x10/+0x14 读反、itemLength 含头与否读错、漏判 -1 哨兵、
  // 忘减 0xC，都产出结构完好但内容错误的输出，所以判据逐字段打在值上。
  // harness 自身是编码器（期望值由同一份语义内容推出，不解析自己写的字节）。
  // 另钉两条容易退化的性质：payload 未解码仍须是可见缺口（收窄≠消失），
  // 以及全部 item 无 payload 时不得报假缺口（否则「无条件登记」也会全绿）。
  // 需要真实 exe、不需真实语料，归 synthetic。
  'test:flver-gxlist': 'synthetic',
  // ESD「未解析结构必须可见」。与上面 FLVER 那条同源同形：守的不是某一条解析，
  // 而是**缺口不可见**这个根因。ESD 有两处字段区间读都没读——condition 的
  // +0x00 targetStateOffset（跳转目标，即状态转移边）与 commandCall 的 +0x04
  // commandID——此前只是两行被动注释，不进集合、不压 authority、不进 envelope，
  // 而 envelope 同时还发着 ESD_DOCUMENT_ROUNDTRIP_VERIFIED（那条只证明同一份字节
  // 解析两遍一致，parser 确定性下恒真）。于是「节点全解析、一条边没连」对消费方
  // 完全不可见。本版不解析转移边是**正确状态**（user-approved 的 V0.6 延期，
  // scope.json SCOPE-BEHAVIOR-ESD 范围原文含「跳转关系的完整读写」），
  // 「本版不做但看不出来」才是缺陷。
  // 判据含一条零结构对照：无 condition 时不得报对应缺口——否则「无条件返回一句话」
  // 这种假标注也会全绿。真实 ESD 语料按延期未登记（bridge:verify:esd 恒诚实跳过），
  // 故这两处缺口只能靠本门禁的 synthetic 字节盯住。归 synthetic。
  'test:esd-gap-visibility': 'synthetic',
  // 桌面安全边界的运行期版本：观测生产产物真实的 webPreferences、preload 表面与
  // 脱敏行为。与 test:desktop-security（源码文本级）并存而不是取代——后者的
  // must-exist 判据改名即红，是安全方向；本条替掉的是它那批 `!includes(旧名)`
  // must-not 判据（改名即静默失覆盖）。需要构建产物，故归 synthetic。
  'test:desktop-security-runtime': 'synthetic',
  // preload 暴露面裁定：暴露面必须等于「renderer 已用」∪「已裁定待接线」。
  // 实测 57 个暴露方法里 15 个 renderer 零引用——它们已过 CI、已封存证据、main 侧
  // handler 齐全，但界面上没有入口，于是「已实现」与「用户可用」出现系统性偏差，
  // 且每个未使用方法都是不受 renderer 守卫保护的表面。纯静态读源码，归 unit。
  'test:preload-surface-ruling': 'unit',
  // renderer 最后一跳可达性：功能入口在所有分支下都拿不到数据时报红。
  // 补的是 preload-surface-ruling 管不到的那一段——它守 preload 边界，
  // 而三个实测断点（PARAM 字段编辑、任务队列、补丁影响面）都在 renderer
  // 内部的 props 链上。纯静态读源码，归 unit。
  'test:renderer-reachability': 'unit',
  // 生产 AI 工具写路径（硬约束 5/11）：注册表内不得直接写盘，写类工具必须经
  // Patch Engine。一次审计称「PATCH_ENGINE_REQUIRED 生产零实现」，核对后不采信
  // ——那个码全在 testing/ 里，生产侧的保证是结构性的（唯一写路径经
  // createPatchProposal）。但「当前恰好没有」不等于「不可能有」，故门禁化。
  // 纯静态读源码，归 unit。
  'test:ai-tool-write-path': 'unit',
  // 生产 AI 工具向模型暴露的 parametersJsonSchema 必须携带真实字段名与类型。
  // 修复前 agentToolBridge 投影的是不带 properties 的空壳 `{ type: 'object' }`
  // ——编译通过、测试全绿、运行期也不报错,唯一症状是「模型好像不会用工具」:
  // 它只能猜 q 还是 query、id 还是 textId,猜错回来一条不含正确字段名的
  // INVALID_INPUT,无法从失败中恢复。这类缺陷不会以任何形式失败,只能靠门禁钉。
  // 判据⑥把 schema 的 required 与 validateToolInput 的实际强制对钉,防止两份
  // 声明各自漂移。观测编译产物的运行期投影结果,故需先 build,归 unit。
  'test:agent-tool-schema': 'unit',
  // Agent 审批层(硬约束 11)。审批门被绕过时的症状是**什么都不会发生**:
  // 工具照常执行、任务照常成功、日志照常干净,只是没人问过用户。而
  // requestApproval 是可选字段,漏传它编译通过、测试全绿,写类工具直接执行
  // ——类型系统对「本该传却没传」无话可说。判据⑫特意拿生产 agentToolBridge
  // 真实投影的 permissionLevel 跑一遍:实测拆掉 bridge 那一行后前十一条判据
  // 全绿,而生产里每个工具都会落到默认 read 等级,审批门完全失效。
  // 用 fake adapter 跑真实 loop,不发网络请求,归 unit。
  'test:agent-approval-gate': 'unit',
  // agent 能力接线:「实现了」与「生产会用上」是两件事。实测接线前 timeoutMs /
  // compaction / maxTotalOutputTokens 无默认值,生产从未设过超时、上下文从不压缩;
  // contextBroker 更彻底——createContextBroker() 生产零调用,且
  // AgentSessionRunParams 当时根本没有这个字段,宿主层就断了。这些缺口不报错、
  // 没有测试会红,只表现为「长任务永远不超时」。判据④用真实 host 跑一轮观测
  // timeoutMs 是否到达 adapter,抓的是「字段名对得上但值传错」——实测把透传值
  // 改成常量后静态判据全绿,只有运行期观测报红。静态读源码 + 假 adapter,归 unit。
  'test:agent-capability-wiring': 'unit',
  // plan 模式权限语义的单一来源。统一前 agentLoop 用按名字硬编码的白名单,
  // 与 toolPermissions 的 maxPermissionForMode 各表达一套 plan 语义,对 17 个
  // 生产工具分歧 2 个。代价不在这 2 个工具,而在新增工具时无人知道改哪边:
  // read 等级的新工具漏加白名单会被拒(等级明明够),等级误标为 read 的写类
  // 工具只要名字在册就能进 plan。统一后等级判据是唯一权威,白名单降级为
  // PLAN_MODE_EXTRA_DENY——只能更严、每条带实测理由,由本门禁钉住。
  // 观测真实注册表经真实 bridge 的投影结果,归 unit。
  'test:agent-permission-unified': 'unit',
  // Bridge 可选参数守卫。ExecuteAsync 的 options 默认值是 default(JsonElement)
  // （ValueKind=Undefined），对它裸调 TryGetProperty 抛 InvalidOperationException。
  //
  // 用户报「打开 PARAM 全是空列表」时实测出的根因就是这个：read-param-document
  // 分支两行裸 TryGetProperty("rowPage"...)，调用方不传 commandOptions 时必然抛，
  // 而该分支 catch 只捕获 InvalidDataException/NotSupportedException/IOException，
  // 异常逃到守护进程兜底被压成无出处的 BRIDGE_REQUEST_FAILED。表面症状指向
  // 「PARAM 解析能力缺失」，修好后同一批 param 立刻读出 56/590/5275 行——
  // 解析能力一直是好的。这类缺陷类型系统看不见、没有编译警告、症状指错方向。
  // 纯静态读 C# 源码，归 unit。
  'test:bridge-optional-args': 'unit',
  // 编辑器布局：证据投影不得占据主视图顶部。用户报「打开这些页面全是证据卡，
  // 根本没法像编辑器一样用」——实测 StructuredPreviewCard 与 NativeInspectionCard
  // 渲染在所有编辑器面板之前且常驻展开，打开一个 param 先看到两张证据卡、
  // 行表被挤到滚动区外。这类缺陷没有自动信号：编译通过、测试全绿、功能「可用」
  // （滚下去就有），只是没人愿意用，而挪一行 JSX 就能改回去。
  //
  // 先写过 e2e，实测验不了：当前 fixture 工作区里没有任何资源带
  // structuredPreview/nativeInspection（event/msg/other/all 逐个试过），
  // 证据区不渲染因而用例只能恒红。留一条永远红的 e2e 比没有更糟，改为静态判据。
  // 纯静态读 App.tsx，归 unit。
  'test:editor-layout': 'unit',
  // 容器内 PARAM 字段写回的生产调用链。守的是本仓库出过的同源事故形态：
  // 能力做好了但只接进自检路径，生产落盘零调用——「报告说修好了、产物没修」。
  // 这条链跨 5 段（渲染器出口 → IPC handler → 字段编码 → write-param →
  // write-bnd4 塞回容器 → Patch Engine），任何一段没接上，界面都会显示
  // 「已写入」而容器没变，用户按它继续改会让错误累积。
  //
  // 用与 desktop-ipc-contract 同一套真实执行观测（加载 out/main 生产产物），
  // 因此需要构建产物，归 synthetic。
  'test:container-param-writeback': 'synthetic',
  // 「记住上次打开的目录」的失效回落。价值全在边界：目录被删、外置盘拔掉、
  // 偏好文件损坏时必须静默回落系统默认，而不是让对话框打开无效位置或打不开。
  // 用真实文件系统（系统临时目录）不用 mock —— 要验的就是「路径还在不在」，
  // mock fs 等于把待验行为验掉。纯逻辑 + esbuild 转译，无需构建产物，归 unit。
  'test:recent-paths': 'unit',
  // 真实 Electron + 生产 preload + 构建后 renderer 的端到端套件（13 用例）。
  // 此前它只被 CI 直调、不在任何 tier —— 本机跑 `verify --tier all` 永远漏掉它，
  // 而它是唯一覆盖渲染进程真实交互的验证。需要构建产物，故归 synthetic。
  'test:renderer-e2e': 'synthetic',
  'test:smithbox-param-metadata-source': 'synthetic',
  'test:flver-candidate': 'synthetic',
  'test:asset-import': 'synthetic',
  'test:asset-writeback': 'synthetic',
  'test:dds-convert-writeback': 'synthetic',
  'test:release-corpus-registry': 'synthetic',

  // ---- native：真实本机 Sekiro 资源。缺环境时诚实跳过 ----
  // 原先登记在 synthetic，但它扫真实 mod 工作区（默认 ../../mods）并要求采到
  // 原生文件，本机无语料时恒定 failed —— 属于层级登记错误，不是能力缺陷。
  // 已改为无语料时结构化 skipped，层级同步移到 native。
  'test:native-preview': 'native',
  // 与 test:native-preview 同一形态：扫真实 Mod 工作区（默认 ../../mods）。此前它
  // 只在 packages/core 有入口、根无转发、也不在任何 tier —— verify 任何层级都跑不到，
  // 而 orphan-smoke-gate 因为「有 core script」判它 reachable。两道门禁互相掩盖。
  // 本轮补了根转发与无语料时的结构化跳过，层级归 native。
  'test:real-mod-readonly-preview': 'native',
  // Bridge 宿主退出卫生：真跑三个代表性 bridge smoke，判它们是否自行退出。
  // 抓的缺陷只有运行期可见——断言全过、退出码 0，但 daemon 句柄挂住宿主。
  // 实测事故：runNativeFlverSmoke 挂死 4 小时并锁住 bridge 输出 exe，使之后
  // 每次 bridge:build 与整个 native 层失败。静态扫描无法区分「调用了 dispose」
  // 和「所有终止路径都调了 dispose」，所以必须运行期观测，归 native。
  'test:bridge-exit-hygiene': 'native',
  'bridge:verify:bnd4-transaction': 'native',
  'bridge:verify:bnd4-writer': 'native',
  'bridge:verify:dcx-documents': 'native',
  // corpus manifest 对账：把本机语料与入库 manifest 逐内容哈希比对。
  // 此前它没有任何 npm 入口、不在任何 tier —— orphan-smoke-gate 原先只扫
  // packages/core/src/testing，--audit 只查已存在的 script，两道门禁都看不见它。
  // 需要真实语料，归 native。
  'test:corpus-manifest': 'native',
  'bridge:verify:emevd': 'native',
  'bridge:verify:esd': 'native',
  'bridge:verify:flver': 'native',
  'bridge:verify:flver-glb': 'native',
  // 多样本只读 authority：flver-multi（11 样本）/ tpf-multi（52 纹理）真实读取，
  // collision-nav 为负向证据（corpus 无 hkx/hkt/nav/nvmtx/col）。需真机环境，归 native。
  'bridge:verify:flver-multi': 'native',
  'bridge:verify:tpf-multi': 'native',
  'bridge:verify:collision-nav': 'native',
  'bridge:verify:flver-mesh': 'native',
  'bridge:verify:fmg': 'native',
  'bridge:verify:msb': 'native',
  'bridge:verify:msb-all': 'native',
  'bridge:verify:msb-writer': 'native',
  'bridge:verify:oodle': 'native',
  'bridge:verify:param': 'native',
  'bridge:verify:tae': 'native',
  'bridge:verify:tpf': 'native',
  'test:emevd-corpus-matrix': 'native',
  // 以下三条本轮从孤儿状态接线，均以 resolveNativeFixture 读真机 corpus，
  // 缺环境时各自诚实跳过（实测已确认），故归 native。
  'test:emevd-multi-corpus-matrix': 'native',
  'test:native-corpus-writeback': 'native',
  'test:param-field-write-matrix': 'native',
  'test:emevd-imported-coverage': 'native',
  'test:emevd-imported-production': 'native',
  'test:fmg-reference-integrity': 'native',
  'test:krak-combination-mutation': 'native',
  'test:native-writer-failure-matrix': 'native',
  'test:param-duplicate-native': 'native',
  'test:param-metadata-native': 'native',
  'test:script-container-evidence': 'native',
  'test:script-container-replace': 'native',
  // 明文脚本条目的源码级编辑(用户裁定 2026-08-08)。判定与编排是纯逻辑,
  // 但 Case 14 会读本机 mods/action 下三个真实 *nameid.txt 验证 Shift-JIS
  // 判定与编码边界——无语料时结构化跳过并说明「未执行不等于通过」。
  // 因为断言依赖真实语料才完整,层级归 native。
  //
  // 这条 smoke 抓到过两个真实数据事实:三个 *nameid.txt 是 Shift-JIS 而非
  // UTF-8(按 UTF-8 读写会静默损坏所有日文),且全都带尾部 NUL 对齐填充
  // (3 / 5 / 14 字节,回写时必须原样保留)。
  'test:plaintext-script-edit': 'native',
  // 明文条目源码级写的**端到端**验证:真实容器 → 明文判定 → 源码级编辑 →
  // Patch Engine 提交 → Bridge 重读校验 → 回滚逐字节还原。
  //
  // 与上一条的分工是实测出来的缺口:test:plaintext-script-edit 验判定与编排,
  // 产出 PatchIR 就结束——实测那个文件里 executePatchIrThroughTransaction 与
  // runBridge 的出现次数是 0。也就是说「走 Patch Engine、写后 Bridge 重读、
  // 可回滚」这三条此前每个零件都测过,但没有一次真实写入走完整条链;
  // checkPlaintextWriteback 的用例喂的是手工构造的字节,不是从容器读回来的
  // ——那证明不了「写进去的和读出来的是同一份」,而经过 BND4 重打包 + DCX
  // 压缩两层编解码之后,那恰好是最需要证明的事。
  //
  // 需要真实 luabnd 语料,无语料时结构化跳过。归 native。
  'test:plaintext-script-write': 'native',
  // SCOPE-BEHAVIOR-SCRIPT game-load：真实 luabnd 整内层保持原样替换 → 结构/放位/
  // magic 加载前置预检（leg 2）+ opt-in 真实游戏内加载确认（leg 3，validation-unfrozen）。
  // 缺环境时结构化 skipped（exit 0，不冒充通过）；真实加载未自动验证前 authority 保持 candidate。
  'test:script-container-load-preflight': 'native',
  'test:private-native-gate': 'native',
  'test:section28-sekiro-gate': 'native',
  // 真实 me3 → Sekiro launch/terminate/restart 会话。缺 SOULFORGE_SEKIRO_GAME_ROOT
  // 或 SOULFORGE_ME3_SEKIRO_SESSION_RUN 时结构化跳过（runner 连 build 都不触发），
  // 不会在公共 CI 上误启动游戏，故归 native 而非 unit/release。
  'test:me3-sekiro-session': 'native',
  'probe:behavior-headers': 'native',

  // ---- release：打包、安装器、可复现构建。慢 ----
  build: 'release',
  'release:manifest': 'release',
  'release:installer:manifest': 'release',
  'test:release-content': 'release',
  'test:release-compliance-fixtures': 'release',
  'test:release-reproducible': 'release',
  // 跨机指纹重建机制：缺第二台机器时本机 audit + 协议输出（partial），
  // --compare 两份导出记录一致才算跨机复现证据。慢且偏发布链，归 release。
  'test:release-cross-machine': 'release',
  'test:portable-packaging-gate': 'release',
  'test:portable-packaging-config-fixtures': 'release',
  'test:installer-lifecycle': 'release'
});

/**
 * 成功时合法地不输出任何 stdout 的套件，附理由。
 *
 * 为什么需要这张表：绝大多数套件都输出结构化结论，因此「exit 0 且 stdout 为空」
 * 通常意味着套件没跑到结论（壳层提前退出、输出被外部工具吞掉），算成通过等于
 * 让「没跑」冒充「跑过并通过」。但少数工具成功时本就静默——tsc 就是典型：
 * 无错误时一个字符都不打印。
 *
 * 所以默认把空输出判为跳过，只对这里显式登记的套件允许静默通过。用白名单而不是
 * 「一律允许空输出」：后者会让所有套件的静默退化都变成绿色，正是本表要防的事。
 * 未登记的套件突然变静默会被判 skipped 而不是 passed，这是刻意的——它至少会在
 * --require-executed 下暴露出来，而不是无声通过。
 */
export const SILENT_ON_SUCCESS = Object.freeze({
  typecheck: 'tsc -b 无错误时不输出任何内容；非零退出码才是它的失败信号'
});

/**
 * 明确排除在验证入口之外的 script，附排除理由。
 * 排除必须写理由——否则「加进排除表」会变成绕过验证的后门。
 */
export const EXCLUDED = Object.freeze({
  // 入口自身不能作为套件被自己调度，否则无限递归。
  // 注意 verify:audit 不在此列：它是纯静态审计、会立即退出，
  // 已登记进 governance 层，保证「漏登记新 script」会被门禁拦住。
  verify: '统一验证入口本身，自调度会无限递归',
  'verify:all': '同上（全层级别名）',
  'verify:list': '同上（只列计划，不是验证）',
  dev: '交互式开发服务器，不是验证',
  // ⚠️ 排除理由已按实测改写（2026-08-08）。原文写的是「由 release 链按需调用」，
  // 而实测 release 层 10 条脚本（build / release:installer:manifest /
  // release:manifest / test:installer-lifecycle / test:portable-packaging-* /
  // test:release-compliance-fixtures / test:release-content /
  // test:release-cross-machine / test:release-reproducible）**没有任何一条调它**，
  // 全仓也只有 package.json 的定义处与本行提到它。错误的排除理由比没有理由更糟：
  // 它让审阅者以为这条脚本在别处有覆盖。
  //
  // 它确实不该进任何 tier（跑一次 Release publish 要几分钟且产物不参与验证判据），
  // 但真实原因是「当前没有消费方」。附带后果：runBridge.ts 的 exe 候选链里前两条
  // Release 路径实测都不存在，永远回落到第三条 Debug——那不是死代码（publish 一跑
  // 就会命中），但「Release 产物从未被生成过」这个事实此前只写在锐评里、不在代码旁。
  'bridge:publish': '发布产物构建。**当前无任何调用方**（release 层 10 条脚本均不调它，'
    + '实测 2026-08-08）；跑一次 Release publish 要几分钟且产物不参与任何验证判据，'
    + '故不进 tier。若将来 release 链要用它，请一并把 runBridge.ts 的 Release 候选路径'
    + '纳入验证——那两条路径至今从未被生成过。',
  'corpus:build-local-release': '生成本机 corpus registry，写 testdata，不是验证',
  'corpus:build-local-release:configured': '同上（被 wrapper 调用的内层）',
  // gov CLI 是治理数据的写入口，不是验证：跑它会改执行面板状态。
  // 其正确性由已登记的 test:gov-cli 负向 fixture 保证。
  gov: '治理写入 CLI，不是验证；正确性由 test:gov-cli 门禁',
  'gov:next': '同上（只读子命令，但仍属操作入口）',
  'gov:status': '同上',
  'gov:claim': '同上（会改 lifecycle 与 activeClaims）',
  'gov:heartbeat': '同上',
  'gov:release': '同上',
  'gov:complete': '同上',
  'gov:seal': '同上（追加 Evidence、挂 Gate 引用并重新投影交接书，三步原子写）',
  // 投影写入命令。跑它会改交接书，不能作为验证调度；对应的只读校验是
  // test:handoff-projection（内含 --check），已登记进 governance 层。
  'handoff:project': '交接书投影写入命令，不是验证；只读校验由 test:handoff-projection 承担'
});

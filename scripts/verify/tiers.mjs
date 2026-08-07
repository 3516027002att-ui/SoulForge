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
  // BND4 重建路径的场景边界：「无损往返」与「通用重排」不得共用一条实现当判据。
  // 用自造带宽间隙的 fixture（复现真实容器形态），不需真实语料，公开 CI 可真跑。
  // 布局守卫本身在 IPC 层不可达（调用方永远传 no-op），故由文档内部自检上报，
  // 门禁断言其四项全真——否则放宽守卫会让变长字节越界覆盖后续子项而无人发现。
  'test:bnd4-repack-scope': 'synthetic',
  // 桌面安全边界的运行期版本：观测生产产物真实的 webPreferences、preload 表面与
  // 脱敏行为。与 test:desktop-security（源码文本级）并存而不是取代——后者的
  // must-exist 判据改名即红，是安全方向；本条替掉的是它那批 `!includes(旧名)`
  // must-not 判据（改名即静默失覆盖）。需要构建产物，故归 synthetic。
  'test:desktop-security-runtime': 'synthetic',
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
  'test:real-mod': 'native',
  // Bridge 宿主退出卫生：真跑三个代表性 bridge smoke，判它们是否自行退出。
  // 抓的缺陷只有运行期可见——断言全过、退出码 0，但 daemon 句柄挂住宿主。
  // 实测事故：runNativeFlverSmoke 挂死 4 小时并锁住 bridge 输出 exe，使之后
  // 每次 bridge:build 与整个 native 层失败。静态扫描无法区分「调用了 dispose」
  // 和「所有终止路径都调了 dispose」，所以必须运行期观测，归 native。
  'test:bridge-exit-hygiene': 'native',
  'bridge:verify:bnd4-transaction': 'native',
  'bridge:verify:bnd4-writer': 'native',
  'bridge:verify:dcx-documents': 'native',
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
  // SCOPE-BEHAVIOR-SCRIPT game-load：真实 luabnd 整内层保持原样替换 → 结构/放位/
  // magic 加载前置预检（leg 2）+ opt-in 真实游戏内加载确认（leg 3，validation-unfrozen）。
  // 缺环境时结构化 skipped（exit 0，不冒充通过）；真实加载未自动验证前 authority 保持 candidate。
  'test:script-container-game-load': 'native',
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
  'bridge:publish': '发布产物构建，由 release 链按需调用',
  'corpus:build-local-release': '生成本机 corpus registry，写 testdata，不是验证',
  'corpus:build-local-release:configured': '同上（被 wrapper 调用的内层）',
  'codexpro:doctor': '外部工具集成，与本仓库验证无关',
  'codexpro:setup': '外部工具集成',
  'codexpro:start': '外部工具集成',
  'codexpro:start:agent': '外部工具集成',
  'codexpro:start:handoff': '外部工具集成',
  'codexpro:pro-bundle': '外部工具集成',
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

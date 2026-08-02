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
  // 验证入口自身的负向 fixture：跳过检测一旦失效，入口会把「什么都没跑」
  // 报成通过而退出码依旧是 0，退化后与正常表现完全一致，因此必须门禁化。
  'test:verify-entrypoint': 'governance',
  'verify:audit': 'governance',
  // 治理锁与 claim CLI 的负向 fixture：坏锁与好锁在顺序执行下表现一致，
  // 只有并发与崩溃场景能区分，不门禁化就等于没有锁。
  'test:gov-cli': 'governance',

  // ---- unit：编译 + 跨包单元与契约。代码改动必跑 ----
  typecheck: 'unit',
  test: 'unit',
  'test:ai-conformance': 'unit',
  'test:ai-fake-loop': 'unit',
  'test:desktop-security': 'unit',
  'test:editor-document-store': 'unit',
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
  'test:smithbox-param-metadata-source': 'synthetic',
  'test:flver-candidate': 'synthetic',
  'test:native-preview': 'synthetic',
  'test:asset-import': 'synthetic',
  'test:asset-writeback': 'synthetic',
  'test:dds-convert-writeback': 'synthetic',
  'test:release-corpus-registry': 'synthetic',

  // ---- native：真实本机 Sekiro 资源。缺环境时诚实跳过 ----
  'bridge:verify:bnd4-transaction': 'native',
  'bridge:verify:bnd4-writer': 'native',
  'bridge:verify:dcx-documents': 'native',
  'bridge:verify:emevd': 'native',
  'bridge:verify:esd': 'native',
  'bridge:verify:flver': 'native',
  'bridge:verify:flver-glb': 'native',
  'bridge:verify:flver-mesh': 'native',
  'bridge:verify:fmg': 'native',
  'bridge:verify:msb': 'native',
  'bridge:verify:oodle': 'native',
  'bridge:verify:param': 'native',
  'bridge:verify:tae': 'native',
  'bridge:verify:tpf': 'native',
  'test:emevd-corpus-matrix': 'native',
  'test:emevd-imported-coverage': 'native',
  'test:emevd-imported-production': 'native',
  'test:fmg-reference-integrity': 'native',
  'test:krak-combination-mutation': 'native',
  'test:native-writer-failure-matrix': 'native',
  'test:param-duplicate-native': 'native',
  'test:param-metadata-native': 'native',
  'test:script-container-evidence': 'native',
  'test:script-container-replace': 'native',
  'test:private-native-gate': 'native',
  'test:section28-sekiro-gate': 'native',
  'probe:behavior-headers': 'native',

  // ---- release：打包、安装器、可复现构建。慢 ----
  build: 'release',
  'release:manifest': 'release',
  'release:installer:manifest': 'release',
  'test:release-content': 'release',
  'test:release-compliance-fixtures': 'release',
  'test:release-reproducible': 'release',
  'test:portable-packaging-gate': 'release',
  'test:portable-packaging-config-fixtures': 'release',
  'test:installer-lifecycle': 'release'
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
  'gov:complete': '同上'
});

/**
 * 桌面 IPC 契约门禁（真实执行观测版）。
 *
 * 取代以下 grep 式 smoke 中「channel 存在 / preload 暴露 / 禁止暴露」这部分断言：
 *   - runFmgMsbIpcContractSmoke.ts
 *   - runParamMsbWriteIpcContractSmoke.ts
 *   - runEmevdIpcContractSmoke.ts
 *   - runDesktopLiveEditorContractSmoke.ts（分页 channel 与 preload 方法部分）
 *   - runVaultIpcContractSmoke.ts（channel 与 preload 部分）
 *
 * 断言对象是运行时行为：main 真实 ipcMain.handle 注册了什么，preload 真实
 * exposeInMainWorld 了什么、每个方法真实 invoke 到哪个 channel。
 *
 * 保留在源码级 smoke 里的部分（本脚本不覆盖，也不假装覆盖）：
 *   - 实现内部必须调用哪个 core 函数（如 commitFmgMutationViaBridge）——那属于
 *     实现选择，已由 test:editor-mutation-service 的行为断言与真机 smoke 覆盖；
 *   - safeStorage/DPAPI 真实往返——需要真 Electron；
 *   - renderer 组件 UI 接线——需要真渲染进程。
 */
import {
  createAssertions,
  desktopBundlesBuilt,
  missingBundles,
  observeMainSurface,
  observePreloadSurface,
  structuredSkip
} from './desktopSurface.mjs';

const LABEL = 'desktop-ipc-contract';

if (!desktopBundlesBuilt()) {
  structuredSkip(LABEL, `桌面构建产物缺失: ${missingBundles().join(', ')}`);
}

/** 五个 release editor 的读写 channel。缺任何一个都意味着编辑器不可达。 */
const REQUIRED_READ_WRITE_CHANNELS = Object.freeze([
  'resource.readFmgDocument',
  'resource.applyFmgMutation',
  'resource.readMsbDocument',
  'resource.applyMsbMutation',
  'resource.readParamDocument',
  'resource.applyParamMutation',
  'resource.applyParamFieldMutation',
  'resource.readEmevdDocument',
  'resource.applyEmevdMutation',
  'resource.readEmevdFullDocument',
  'resource.submitEmevdDslPlan'
]);

/**
 * 取消类 channel。单列一组是因为它既不是读写也不是分页，但缺了会静默退化：
 * 没有它，renderer 切走域时主进程仍会把剩余分页读 + 整段反汇编跑完，UI 层面
 * 完全看不出来（结果本来就被丢弃），只有主进程白干一场。放进 REQUIRED_* 是为了
 * 让「两侧一起被删」也报红 —— 下面的双向对账只抓单侧断裂。
 */
const REQUIRED_CANCEL_CHANNELS = Object.freeze([
  'resource.cancelEmevdFullDocument'
]);

/** 硬约束 17：大规模访问必须有分页 channel。 */
const REQUIRED_PAGE_CHANNELS = Object.freeze([
  'resource.readFmgPage',
  'resource.readParamPage',
  'resource.listContainerChildrenPage',
  'resource.listScriptContainerEntriesPage'
]);

/** 模型服务 vault：三个管理 channel 必须在，解密 channel 必须不在。 */
const REQUIRED_VAULT_CHANNELS = Object.freeze([
  'modelService.list',
  'modelService.upsert',
  'modelService.delete',
  'modelService.encryptionAvailable'
]);

/** preload 方法 -> 必须落到的 channel。这是「暴露了」之外的第二重约束。 */
const REQUIRED_PRELOAD_WIRING = Object.freeze({
  readFmgDocument: 'resource.readFmgDocument',
  applyFmgMutation: 'resource.applyFmgMutation',
  readMsbDocument: 'resource.readMsbDocument',
  applyMsbMutation: 'resource.applyMsbMutation',
  readParamDocument: 'resource.readParamDocument',
  applyParamMutation: 'resource.applyParamMutation',
  applyParamFieldMutation: 'resource.applyParamFieldMutation',
  readEmevdDocument: 'resource.readEmevdDocument',
  applyEmevdMutation: 'resource.applyEmevdMutation',
  readEmevdFullDocument: 'resource.readEmevdFullDocument',
  cancelEmevdFullDocument: 'resource.cancelEmevdFullDocument',
  submitEmevdDslPlan: 'resource.submitEmevdDslPlan',
  readFmgPage: 'resource.readFmgPage',
  readParamPage: 'resource.readParamPage',
  listContainerChildrenPage: 'resource.listContainerChildrenPage',
  listScriptContainerEntriesPage: 'resource.listScriptContainerEntriesPage',
  listModelServices: 'modelService.list',
  upsertModelService: 'modelService.upsert',
  deleteModelService: 'modelService.delete',
  modelServiceEncryptionAvailable: 'modelService.encryptionAvailable',
  rollbackOperation: 'operation.rollback',
  listOperations: 'operation.list'
});

/**
 * 推送类接线：main 用 webContents.send 主动推、preload 用 ipcRenderer.on 订阅。
 *
 * 这类 channel **不该**有 ipcMain.handle——它不是请求/响应。把它和 invoke 类
 * 混在一起对账，正确的接线会被判成「invoke 了未注册的 channel」，而真正的
 * 断裂（订阅接线消失、两侧 channel 名改了一侧）反而没人管。
 */
const REQUIRED_PRELOAD_SUBSCRIPTIONS = Object.freeze({
  onAiAgentEvent: 'ai:agent:event'
});

/**
 * 渲染进程绝不允许触达的能力。这些是安全边界，靠「源码里没这个字符串」证明
 * 太弱——真实观测到 preload 表面里没有它们才是证据。
 */
const FORBIDDEN_PRELOAD_METHODS = Object.freeze([
  'resolveApiKey',
  'createConfirmationReceipt',
  'runBridge',
  'saveRawReplace',
  'openWorkspaceSession'
]);

const FORBIDDEN_CHANNELS = Object.freeze([
  'modelService.resolveApiKey',
  'bridge.run',
  'workspace.writeFile'
]);

const main = await observeMainSurface();
const preload = await observePreloadSurface();
const assert = createAssertions(LABEL);

for (const channel of REQUIRED_READ_WRITE_CHANNELS) assert.requireChannel(main, channel);
for (const channel of REQUIRED_CANCEL_CHANNELS) assert.requireChannel(main, channel);
for (const channel of REQUIRED_PAGE_CHANNELS) assert.requireChannel(main, channel);
for (const channel of REQUIRED_VAULT_CHANNELS) assert.requireChannel(main, channel);
for (const channel of FORBIDDEN_CHANNELS) assert.forbidChannel(main, channel);

assert.check(
  main.duplicateChannels.length === 0,
  '同一 channel 被注册多次：后注册者会静默覆盖前者',
  { duplicates: main.duplicateChannels }
);

assert.check(
  preload.exposedKey === 'soulforge',
  'preload 必须只在 window.soulforge 下暴露 API',
  { exposedKey: preload.exposedKey }
);

for (const [method, channel] of Object.entries(REQUIRED_PRELOAD_WIRING)) {
  assert.requirePreloadChannel(preload, method, channel);
}
for (const [method, channel] of Object.entries(REQUIRED_PRELOAD_SUBSCRIPTIONS)) {
  assert.requirePreloadSubscription(preload, method, channel);
  // 光有订阅不够：main 侧必须真的会推，否则订阅的是永不来事件的 channel。
  assert.requireMainPush(main, channel);
}
for (const method of FORBIDDEN_PRELOAD_METHODS) assert.forbidPreloadMethod(preload, method);

/**
 * 双向对账：preload **invoke** 的每个 channel 都必须对应一个 main 真实注册的
 * handler。这一条是文本匹配根本无法表达的——它抓的是「preload 连到一个不存在
 * 的 channel」这类只在运行时才暴露的断裂，也抓「channel 改名只改了一侧」。
 *
 * 只看 invokeChannels：订阅类（ipcRenderer.on）走 webContents.send，按 Electron
 * 语义不该有 ipcMain.handle，把它算进来会把正确接线判成违规。订阅类由上面的
 * requirePreloadSubscription + requireMainPush 两条覆盖，不存在放宽。
 */
const orphanedPreloadChannels = [];
for (const method of preload.methods) {
  const record = preload.channelByMethod.get(method);
  if (!record || record.error) continue;
  for (const channel of record.invokeChannels ?? []) {
    if (!main.handlers.has(channel)) orphanedPreloadChannels.push({ method, channel });
  }
}
assert.check(
  orphanedPreloadChannels.length === 0,
  'preload 方法 invoke 了 main 未注册的 channel（运行时必然失败）',
  { orphaned: orphanedPreloadChannels }
);

/**
 * 订阅类 channel 不得同时被注册成 invoke handler。两者语义互斥，同时存在说明
 * 有人把推送改成了请求/响应（或反之）而只改了一半。
 */
const subscriptionChannelsWithHandlers = Object.values(REQUIRED_PRELOAD_SUBSCRIPTIONS)
  .filter((channel) => main.handlers.has(channel));
assert.check(
  subscriptionChannelsWithHandlers.length === 0,
  '推送类 channel 同时被注册为 ipcMain.handle（invoke 与 send 语义互斥）',
  { conflicting: subscriptionChannelsWithHandlers }
);

/**
 * 反向对账只做报告，不做失败：main 允许存在暂未接入 UI 的 channel（例如仅供
 * 内部或后续里程碑使用）。把它做成失败会逼出「为了过门禁而暴露给渲染进程」
 * 这种反向的安全退化。
 */
const preloadChannels = new Set(
  preload.methods.flatMap((method) => preload.channelByMethod.get(method)?.channels ?? [])
);
const mainOnlyChannels = main.channels.filter((channel) => !preloadChannels.has(channel));
const preloadSubscribeChannels = [...new Set(
  preload.methods.flatMap((method) => preload.channelByMethod.get(method)?.subscribeChannels ?? [])
)].sort();

assert.finish({
  message: '桌面 IPC 契约通过真实执行观测验证（main 注册 + preload 暴露 + 按方向双向对账）',
  observedMainChannels: main.channels.length,
  observedPreloadMethods: preload.methods.length,
  preloadReachableChannels: preloadChannels.size,
  preloadSubscribeChannels,
  mainOnlyChannels,
  evidence: 'apps/desktop/out 生产构建产物真实加载；electron 为受控桩，未伪造 Electron 语义'
});

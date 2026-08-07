#!/usr/bin/env node
/**
 * 桌面安全边界的运行期门禁。
 *
 * 取代 verify-desktop-security.mjs 里那批 `!source.includes('旧标识符')` 判据。
 *
 * 为什么必须换：那类判据的极性决定风险方向。
 *  - 「必须存在」型改名 → 门禁变红，是安全的失效方式；
 *  - 「必须不存在」型改名 → 门禁**变绿**，覆盖静默消失。
 * 把同一能力用新名字重新引入（createConfirmation → mintConfirmation、
 * me3Path → me3Executable），`!includes(旧名)` 恒真，权限边界已打穿而门禁报绿。
 * 那 8 条判据的真实覆盖面等于「重构时有人恰好沿用旧标识符名」。
 *
 * 更脆的一条是断言一句**英文注释散文**（me3RuntimeGateway 的
 * "never returns a path-bearing"）——重写注释即误红，代码行为一字未改。
 *
 * 本门禁改为断言运行期事实：
 *  - preload 真实 exposeInMainWorld 出来的方法集与它们各自 invoke 的 channel；
 *  - main 真实 ipcMain.handle 注册的 channel 集合；
 *  - BrowserWindow 真实收到的 webPreferences；
 *  - sanitizeRendererValue 对真实载荷的真实输出（而不是「源码里有这个函数名」）。
 *
 * 与 verify-desktop-ipc-contract.mjs 的分工：那条管功能接线（该有的 channel 在、
 * 方向对）；本条管安全边界（不该有的能力不在、离开 main 的数据里没有路径与凭据）。
 * 两条都用同一个 desktopSurface 观测层，避免两套观测口径漂移。
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAssertions,
  desktopBundlesBuilt,
  missingBundles,
  observeMainSurface,
  observePreloadSurface,
  repoRoot,
  structuredSkip
} from './contract/desktopSurface.mjs';

const LABEL = 'desktop-security-runtime';

if (!desktopBundlesBuilt()) {
  structuredSkip(LABEL, `桌面构建产物缺失: ${missingBundles().join(', ')}`);
}

/**
 * 渲染进程绝不允许触达的能力，按「威胁」而不是「标识符名」组织。
 *
 * 每条都给出等价别名，这样把能力换个名字重新引入依然会被抓到——这正是 grep
 * 判据做不到的那部分。名单不求穷尽（穷尽不可能），但必须覆盖已知实现过的写法。
 */
const FORBIDDEN_RENDERER_CAPABILITIES = Object.freeze([
  {
    threat: 'renderer 自行铸造确认凭据（绕过 main 的风险确认）',
    aliases: ['createConfirmation', 'mintConfirmation', 'issueConfirmation', 'createConfirmationReceipt']
  },
  {
    threat: 'renderer 传入/持有确认凭据对象',
    aliases: ['confirmationReceipt', 'confirmation']
  },
  {
    threat: 'renderer 决定 AI 权限模式（不得抬高授权）',
    aliases: ['setAiMode', 'setPermissionMode', 'setToolMode', 'elevatePermission']
  },
  {
    threat: 'renderer 拿到 me3/外部可执行文件路径',
    aliases: ['me3Path', 'me3Executable', 'executablePath', 'resolveMe3Path']
  },
  {
    threat: 'renderer 直接解密或读取模型服务凭据',
    aliases: ['resolveApiKey', 'decryptApiKey', 'getApiKey', 'readCredential']
  },
  {
    threat: 'renderer 绕过 Patch Engine 直接写文件',
    aliases: ['saveRawReplace', 'writeFile', 'writeWorkspaceFile', 'runBridge']
  },
  {
    threat: 'renderer 直接打开工作区会话/数据库',
    aliases: ['openWorkspaceSession', 'openFileOperationLogStore', 'openAppDatabase']
  }
]);

/** main 侧绝不允许注册的 channel（注册即等于暴露给 renderer 的可能）。 */
const FORBIDDEN_MAIN_CHANNELS = Object.freeze([
  'resource.createConfirmation',
  'modelService.resolveApiKey',
  'bridge.run',
  'workspace.writeFile',
  'me3.resolvePath'
]);

/** 必须存在的安全 channel：缺了说明安全流程本身被摘掉。 */
const REQUIRED_SECURITY_CHANNELS = Object.freeze([
  'modelService.encryptionAvailable'
]);

const main = await observeMainSurface();
const preload = await observePreloadSurface();
const assert = createAssertions(LABEL);

/* ---- 1. BrowserWindow 的 webPreferences：断言真实收到的对象 ---------------
 * 此前判据是 main 源码里含 'sandbox: true' 这类字符串。真实观测强得多：它抓
 * 「写了但没传进去」「被后面的 spread 覆盖」这类源码文本看不出的失效。
 */
const windowOptions = main.browserWindowOptions;
assert.check(
  windowOptions.length > 0,
  'main 未创建任何 BrowserWindow：无法观测 webPreferences（观测无效，不得当通过）',
  { count: windowOptions.length }
);
for (const [index, options] of windowOptions.entries()) {
  const prefs = options?.webPreferences ?? {};
  assert.check(prefs.sandbox === true, `BrowserWindow[${index}] 必须 sandbox: true`, { sandbox: prefs.sandbox });
  assert.check(
    prefs.contextIsolation === true,
    `BrowserWindow[${index}] 必须 contextIsolation: true`,
    { contextIsolation: prefs.contextIsolation }
  );
  assert.check(
    prefs.nodeIntegration === false || prefs.nodeIntegration === undefined,
    `BrowserWindow[${index}] 不得开启 nodeIntegration`,
    { nodeIntegration: prefs.nodeIntegration }
  );
  assert.check(
    prefs.webSecurity !== false,
    `BrowserWindow[${index}] 不得关闭 webSecurity`,
    { webSecurity: prefs.webSecurity }
  );
  assert.check(
    prefs.allowRunningInsecureContent !== true,
    `BrowserWindow[${index}] 不得允许不安全内容`,
    { allowRunningInsecureContent: prefs.allowRunningInsecureContent }
  );
  assert.check(
    typeof prefs.preload === 'string' && prefs.preload.length > 0,
    `BrowserWindow[${index}] 必须指定 preload`,
    { preload: prefs.preload ?? null }
  );
}

/* ---- 2. preload 表面：按威胁而不是按标识符名断言 ------------------------- */
const exposedLower = new Map(preload.methods.map((method) => [method.toLowerCase(), method]));
for (const { threat, aliases } of FORBIDDEN_RENDERER_CAPABILITIES) {
  const hits = aliases
    .map((alias) => exposedLower.get(alias.toLowerCase()))
    .filter((found) => typeof found === 'string');
  assert.check(hits.length === 0, `preload 暴露了被禁能力：${threat}`, { matchedMethods: hits, aliases });
}

for (const channel of FORBIDDEN_MAIN_CHANNELS) assert.forbidChannel(main, channel);
for (const channel of REQUIRED_SECURITY_CHANNELS) assert.requireChannel(main, channel);

/**
 * preload 不得 invoke 任何 main 未注册的 channel —— 与 ipc-contract 重叠，但这里
 * 是安全视角：一个连不到 handler 的 channel 名会在将来被某个 handler 认领，
 * 而那次认领不会有人复查它当初为什么存在。
 */
const orphaned = [];
for (const method of preload.methods) {
  const record = preload.channelByMethod.get(method);
  if (!record || record.error) continue;
  for (const channel of record.invokeChannels ?? []) {
    if (!main.handlers.has(channel)) orphaned.push({ method, channel });
  }
}
assert.check(orphaned.length === 0, 'preload 存在指向未注册 channel 的 invoke', { orphaned });

/* ---- 3. sanitizeRendererValue：断言真实脱敏行为 --------------------------
 * 此前判据是 rendererDto 源码里含 'containsWindowsDrivePath' 之类的字符串。那
 * 只能证明「代码里提到过」，不能证明它对真实载荷有效。这里直接喂真实形态的
 * 敏感载荷，断言输出里既没有键也没有值。
 */
const dtoBundle = join(repoRoot, 'apps', 'desktop', 'out', 'main', 'index.js');
let sanitizeRendererValue;
try {
  // 生产 main bundle 已经在 observeMainSurface 里加载过（模块缓存命中），这里
  // 只取导出。若 bundler 没有导出它，退化为跳过本节并显式说明——不假装通过。
  const mainModule = await import(pathToFileURL(dtoBundle).href);
  sanitizeRendererValue = mainModule.sanitizeRendererValue;
} catch {
  sanitizeRendererValue = undefined;
}

const SENSITIVE_PROBE = {
  sourceUri: 'file:///workspace/a.fmg',
  absolutePath: 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro\\a.fmg',
  sourcePath: 'D:\\workspace\\mod\\a.fmg',
  workspaceRoot: 'D:\\workspace\\mod',
  apiKey: 'sk-should-never-cross-the-bridge',
  token: 'bearer-should-never-cross',
  nested: {
    backupRoot: 'D:\\workspace\\.soulforge\\backup',
    message: '写入失败：D:\\workspace\\mod\\a.fmg 被占用（\\\\?\\UNC\\host\\share\\b.fmg）'
  }
};

if (typeof sanitizeRendererValue === 'function') {
  const sanitized = sanitizeRendererValue(SENSITIVE_PROBE);
  const serialized = JSON.stringify(sanitized);
  const leakedKeys = ['absolutePath', 'sourcePath', 'workspaceRoot', 'apiKey', 'token', 'backupRoot']
    .filter((key) => serialized.includes(`"${key}"`));
  assert.check(leakedKeys.length === 0, 'sanitizeRendererValue 未删除敏感键', { leakedKeys, serialized });

  const leakedValues = [
    'sk-should-never-cross-the-bridge',
    'bearer-should-never-cross',
    'D:\\\\mystream',
    'D:\\\\workspace'
  ].filter((needle) => serialized.includes(needle));
  assert.check(leakedValues.length === 0, 'sanitizeRendererValue 未脱敏敏感值/绝对路径', { leakedValues, serialized });

  assert.check(
    JSON.stringify(sanitized).includes('file:///workspace/a.fmg'),
    'sanitizeRendererValue 不得连带删除非敏感字段（否则脱敏会退化为清空一切）',
    { serialized }
  );
} else {
  // 明确记为未覆盖而不是通过：本节的价值全在真实调用上。
  assert.check(
    false,
    'main bundle 未导出 sanitizeRendererValue，无法运行期验证脱敏行为',
    { hint: '在 apps/desktop/src/main/index.ts 中 re-export，或为本节单独构建入口', bundle: dtoBundle }
  );
}

/* ---- 4. preload 不得把路径形状的数据交给 renderer ------------------------ */
const pathShaped = [];
for (const method of preload.methods) {
  if (/path$|root$|dir$|directory$/i.test(method)) pathShaped.push(method);
}
assert.check(
  pathShaped.length === 0,
  'preload 存在路径形状的方法名（可能向 renderer 输出绝对路径）',
  { methods: pathShaped, note: '如属误报请改名或在此显式豁免并说明理由' }
);

assert.finish({
  message: '桌面安全边界通过运行期观测验证（webPreferences + preload 表面 + channel 白/黑名单 + 真实脱敏）',
  observedMainChannels: main.channels.length,
  observedPreloadMethods: preload.methods.length,
  browserWindows: windowOptions.length,
  forbiddenCapabilityGroups: FORBIDDEN_RENDERER_CAPABILITIES.length,
  evidence: 'apps/desktop/out 生产构建产物真实加载；electron 为受控桩，未伪造 Electron 语义',
  nonClaim: '本门禁不验证 Electron 自身行为（真实沙箱隔离、DPAPI 往返），那需要真 Electron 进程；'
    + '也不验证 handler 内部业务逻辑。'
});

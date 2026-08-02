/**
 * 桌面 IPC 契约的真实执行观测层。
 *
 * 取代原先的 grep 式契约 smoke：那些 smoke 用 readFileSync + includes(token)
 * 断言源码文本，代价是
 *   1. 重构会静默地保持通过（ipc.ts 写链从五份收敛到一份后，五个契约 smoke
 *      全部原样通过，其中一个还带着 `token !== 'saveRawReplace'` 的硬编码豁免）；
 *   2. 改个换行、改个引号风格就误报；
 *   3. 断言的是「源码里有这个字符串」，而不是「运行时真的注册/暴露了这个能力」。
 *
 * 这里改为真实加载生产构建产物，用 module hooks 把 `electron` 换成受控桩，
 * 观测 main 实际调用 `ipcMain.handle` 注册了哪些 channel、preload 实际
 * `exposeInMainWorld` 了哪些方法、每个方法实际 `ipcRenderer.invoke` 到哪个
 * channel。断言对象因此是运行时行为，而不是源码文本。
 *
 * 诚实边界：
 *  - 观测的是生产构建产物（apps/desktop/out），不是源码；产物缺失时必须由
 *    调用方走结构化跳过或先构建，本模块不假装通过。
 *  - electron 是桩，所以这里不验证 Electron 自身行为（窗口、沙箱、DPAPI）；
 *    那些仍由 verify-desktop-security.mjs 与 Electron 内 e2e harness 负责。
 *  - 桩只提供加载期与注册期需要的最小面；handler 内部真实执行仍需真机语料。
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');

export const MAIN_BUNDLE = join(repoRoot, 'apps', 'desktop', 'out', 'main', 'index.js');
export const PRELOAD_BUNDLE = join(repoRoot, 'apps', 'desktop', 'out', 'preload', 'index.mjs');

const STUB_URL = 'soulforge-contract-stub:electron';

/**
 * electron 的导出名清单。必须覆盖构建产物里所有 `import { x } from "electron"`，
 * 否则 ESM 链接期就报 "does not provide an export named"。清单缺项会表现为
 * 加载失败而不是静默通过，所以这是失败关闭的。
 */
const ELECTRON_EXPORT_NAMES = Object.freeze([
  'app', 'ipcMain', 'ipcRenderer', 'dialog', 'BrowserWindow', 'safeStorage',
  'contextBridge', 'utilityProcess', 'shell', 'session', 'webContents',
  'nativeTheme', 'Menu', 'MenuItem', 'net', 'protocol', 'clipboard',
  'powerMonitor', 'screen', 'nativeImage', 'Notification', 'Tray',
  'globalShortcut', 'systemPreferences', 'crashReporter', 'desktopCapturer',
  'inAppPurchase', 'powerSaveBlocker', 'pushNotifications', 'autoUpdater'
]);

let hooksRegistered = false;
/**
 * 每次观测换一个 stub URL。ESM 按 URL 缓存模块，若 main 与 preload 共用同一个
 * stub URL，先加载者会把桩定格，后加载者拿到的是别人的桩——两次观测互相污染，
 * 而且症状是「表面为空」这种看起来像通过的失败。
 */
let stubSession = 0;
/** 已观测过的 bundle。同一进程重复观测会命中模块缓存、注册为空，必须失败关闭。 */
const observedBundles = new Set();

function ensureElectronStubHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron') {
        return { url: `${STUB_URL}?session=${stubSession}`, shortCircuit: true, format: 'module' };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(STUB_URL)) {
        const lines = ELECTRON_EXPORT_NAMES.map(
          (name) => `export const ${name} = globalThis.__soulforgeElectronStub[${JSON.stringify(name)}];`
        );
        return { format: 'module', shortCircuit: true, source: lines.join('\n') };
      }
      return next(url, context);
    }
  });
}

/** 开启一次观测会话：换 stub URL、装入桩、并拒绝重复观测同一 bundle。 */
function beginObservation(bundlePath, stub) {
  if (observedBundles.has(bundlePath)) {
    throw new Error(
      `CONTRACT_BUNDLE_ALREADY_OBSERVED: ${bundlePath} 已在本进程观测过；`
      + 'ESM 模块缓存会让第二次观测返回空表面，请在新进程中观测。'
    );
  }
  observedBundles.add(bundlePath);
  ensureElectronStubHooks();
  stubSession += 1;
  globalThis.__soulforgeElectronStub = stub;
}

/** 构建产物是否齐备。缺失时调用方必须结构化跳过或先构建，不能当通过。 */
export function desktopBundlesBuilt() {
  return existsSync(MAIN_BUNDLE) && existsSync(PRELOAD_BUNDLE);
}

export function missingBundles() {
  return [
    ...(existsSync(MAIN_BUNDLE) ? [] : ['apps/desktop/out/main/index.js']),
    ...(existsSync(PRELOAD_BUNDLE) ? [] : ['apps/desktop/out/preload/index.mjs'])
  ];
}

/**
 * main 侧观测桩。只记录，不模拟 Electron 语义：任何被 handler 内部真实依赖的
 * Electron 行为都不在这里伪造，因为伪造出来的「成功」不构成证据。
 */
function createMainStub(record) {
  const userData = join(repoRoot, '.tmp-contract-userdata');
  const webContentsStub = {
    id: 1,
    once() {},
    on() {},
    send() {},
    setWindowOpenHandler() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
  };
  class BrowserWindowStub {
    constructor(options) {
      record.browserWindowOptions.push(options ?? {});
      this.webContents = webContentsStub;
    }
    loadFile(path) { record.loadedRendererTargets.push(path); return Promise.resolve(); }
    loadURL(url) { record.loadedRendererTargets.push(url); return Promise.resolve(); }
    once() {}
    on() {}
    show() {}
    static fromWebContents() { return null; }
    static getAllWindows() { return []; }
  }
  return {
    app: {
      isPackaged: false,
      getPath: () => userData,
      getAppPath: () => join(repoRoot, 'apps', 'desktop'),
      whenReady: () => Promise.resolve(),
      on(eventName) { record.appEvents.push(eventName); },
      quit() {}
    },
    ipcMain: {
      handle(channel, listener) {
        if (record.handlers.has(channel)) record.duplicateChannels.push(channel);
        record.handlers.set(channel, listener);
      },
      handleOnce(channel, listener) { record.handlers.set(channel, listener); },
      on(channel) { record.ipcMainOnChannels.push(channel); }
    },
    BrowserWindow: BrowserWindowStub,
    /** dialog 故意留空：任何路径真触发对话框都应显式失败，而不是被静默满足。 */
    dialog: {},
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString() { throw new Error('CONTRACT_STUB_NO_DPAPI'); },
      decryptString() { throw new Error('CONTRACT_STUB_NO_DPAPI'); }
    },
    utilityProcess: { fork() { throw new Error('CONTRACT_STUB_NO_UTILITY_PROCESS'); } },
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke() { throw new Error('CONTRACT_STUB_MAIN_HAS_NO_IPCRENDERER'); } },
    shell: {}, session: { defaultSession: {} }, webContents: {}, nativeTheme: {},
    Menu: {}, MenuItem: class {}, net: {}, protocol: {}, clipboard: {},
    powerMonitor: {}, screen: {}, nativeImage: {}, Notification: class {},
    Tray: class {}, globalShortcut: {}, systemPreferences: {}, crashReporter: {},
    desktopCapturer: {}, inAppPurchase: {}, powerSaveBlocker: {},
    pushNotifications: {}, autoUpdater: {}
  };
}

/**
 * 真实加载生产 main bundle，返回它实际注册的 IPC 表面。
 *
 * 返回 handlers 是「channel -> 真实 listener 函数」，所以调用方既能断言
 * channel 集合，也能断言 arity、还能在准备好前置条件时真实调用 handler。
 */
export async function observeMainSurface() {
  const record = {
    handlers: new Map(),
    duplicateChannels: [],
    ipcMainOnChannels: [],
    appEvents: [],
    browserWindowOptions: [],
    loadedRendererTargets: []
  };
  beginObservation(MAIN_BUNDLE, createMainStub(record));
  await import(pathToFileURL(MAIN_BUNDLE).href);
  // main 在 app.whenReady() 之后注册；桩里 whenReady 立即 resolve，让出微任务
  // 队列即可完成注册。轮询而不是固定 sleep，避免时序抖动被写成通过或失败。
  for (let attempt = 0; attempt < 50 && record.handlers.size === 0; attempt += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  // 零注册必须失败关闭：那是加载或时序坏了，而不是「main 没有 channel」。
  // 若允许它返回空集合，所有「必须存在某 channel」的断言都会因为集合为空而
  // 变成必然失败——但所有「必须不存在」的断言会变成必然通过，形成半边真空。
  if (record.handlers.size === 0) {
    throw new Error('CONTRACT_MAIN_REGISTERED_NOTHING: main bundle 未注册任何 IPC channel，观测无效。');
  }
  return {
    channels: [...record.handlers.keys()].sort(),
    handlers: record.handlers,
    duplicateChannels: record.duplicateChannels,
    ipcMainOnChannels: record.ipcMainOnChannels,
    browserWindowOptions: record.browserWindowOptions,
    loadedRendererTargets: record.loadedRendererTargets
  };
}

/**
 * 真实加载生产 preload bundle，返回它实际暴露的 API 表面，并逐个方法真实调用
 * 一次以记录它落到哪个 channel。
 *
 * 这是原先「preload.includes('applyMsbMutation')」无法表达的断言：文本存在
 * 不等于 contextBridge 真的暴露了它，更不等于它连到了正确的 channel。
 */
export async function observePreloadSurface() {
  const exposures = [];
  const invocations = [];
  beginObservation(PRELOAD_BUNDLE, {
    contextBridge: {
      exposeInMainWorld(key, value) { exposures.push({ key, value }); }
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invocations.push({ channel, args });
        return Promise.resolve(null);
      },
      on(channel) { invocations.push({ channel, args: [], listener: true }); },
      send(channel, ...args) { invocations.push({ channel, args, send: true }); }
    },
    ...Object.fromEntries(ELECTRON_EXPORT_NAMES
      .filter((name) => name !== 'contextBridge' && name !== 'ipcRenderer')
      .map((name) => [name, {}]))
  });
  await import(pathToFileURL(PRELOAD_BUNDLE).href);
  if (exposures.length !== 1) {
    throw new Error(`PRELOAD_EXPOSURE_UNEXPECTED: 期望恰好 1 次 exposeInMainWorld，实测 ${exposures.length}`);
  }
  const [{ key, value }] = exposures;
  const methods = Object.keys(value).sort();
  /** methodName -> 该方法真实 invoke 的 channel 列表（通常恰好 1 个）。 */
  const channelByMethod = new Map();
  for (const method of methods) {
    invocations.length = 0;
    const probe = value[method];
    if (typeof probe !== 'function') {
      channelByMethod.set(method, { error: `NOT_A_FUNCTION:${typeof probe}` });
      continue;
    }
    try {
      // 探针参数是无害占位：桩的 invoke 不会到达 main，也不触碰文件系统。
      await probe('soulforge-contract-probe://uri', 1, 2, 3);
      channelByMethod.set(method, { channels: invocations.map((item) => item.channel) });
    } catch (error) {
      channelByMethod.set(method, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { exposedKey: key, methods, channelByMethod };
}

/**
 * 断言收集器。断言消息必须带上实测值：只说「缺少 X」的失败会让 agent 无法在
 * 不重跑、不加打印的情况下判断到底观测到了什么，这是上一代 smoke 的主要返工源。
 */
export function createAssertions(label) {
  const failures = [];
  let passed = 0;
  return {
    check(condition, message, observed) {
      if (condition) { passed += 1; return true; }
      failures.push({ message, observed: observed ?? null });
      return false;
    },
    /** channel 必须已注册。observed 报告实际最接近的 channel，便于定位改名。 */
    requireChannel(surface, channel) {
      const present = surface.handlers.has(channel);
      const near = surface.channels.filter((item) => {
        const [namespace] = channel.split('.');
        return item.startsWith(`${namespace}.`);
      });
      return this.check(present, `main 未注册 IPC channel: ${channel}`, { registered: present, sameNamespace: near });
    },
    /** channel 必须没有注册（用于「不得暴露」类约束）。 */
    forbidChannel(surface, channel) {
      return this.check(
        !surface.handlers.has(channel),
        `main 注册了本应禁止的 IPC channel: ${channel}`,
        { registered: surface.handlers.has(channel) }
      );
    },
    /** preload 方法必须存在，且真实 invoke 到指定 channel。 */
    requirePreloadChannel(preload, method, channel) {
      const record = preload.channelByMethod.get(method);
      if (!record) {
        return this.check(false, `preload 未暴露方法: ${method}`, { exposedMethods: preload.methods.length });
      }
      if (record.error) {
        return this.check(false, `preload 方法 ${method} 探针调用失败`, record);
      }
      return this.check(
        record.channels.length === 1 && record.channels[0] === channel,
        `preload.${method} 应当只 invoke ${channel}`,
        { actualChannels: record.channels }
      );
    },
    forbidPreloadMethod(preload, method) {
      return this.check(
        !preload.methods.includes(method),
        `preload 暴露了本应禁止的方法: ${method}`,
        { exposed: preload.methods.includes(method) }
      );
    },
    get count() { return passed + failures.length; },
    get passedCount() { return passed; },
    /** 有失败则以结构化诊断退出 1；不吞异常、不打印半通过。 */
    finish(payload) {
      if (failures.length > 0) {
        console.error(JSON.stringify({
          ok: false,
          contract: label,
          code: 'DESKTOP_CONTRACT_VIOLATION',
          passed,
          failed: failures.length,
          failures
        }, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, contract: label, assertions: passed, ...payload }, null, 2));
    }
  };
}

/**
 * 构建产物缺失时的结构化跳过。绝不写成通过：这些契约验证的是构建产物的运行时
 * 表面，产物不在就没有观测对象。
 */
export function structuredSkip(label, reason) {
  console.log(JSON.stringify({
    ok: null,
    contract: label,
    harnessStatus: 'skipped',
    reason,
    remedy: 'npm run build -w @soulforge/desktop',
    skipSemantics: '结构跳过：未声称通过，也不计为失败。'
  }, null, 2));
  process.exit(0);
}

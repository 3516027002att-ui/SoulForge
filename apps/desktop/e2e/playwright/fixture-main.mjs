/**
 * Playwright fixture main：加载生产 preload 与构建产物，用合成 fixture
 * （微小、合法构造、明确标记）注册与生产同名的 IPC 通道，
 * 驱动 renderer 状态机的端到端测试。不触碰真实游戏资产。
 *
 * ── 覆盖边界（如实声明，不要读成「e2e 覆盖了 main」）──────────────────────
 *
 * 真实的部分：真 Electron 进程、真生产 preload（out/preload/index.cjs，CJS）、真
 * 构建后的 renderer、真 contextBridge 语义，以及**与生产同形态的发送方校验**
 * （handleTrusted 包装器 + assertTrustedSender，见下）。
 *
 * 不真实的部分：main 侧业务逻辑整体是 fixture。本文件自己注册 19 个 channel，
 * 生产 ipc.ts 有 56 个，且 registerIpcHandlers 从未被加载。因此以下**没有**被
 * e2e 覆盖，不得据本套件声称它们可用：
 *   - PARAM / EMEVD / 脚本容器 / TPF / TAE / FLVER / ESD 面板的读写与分页
 *     （readParamPage、readEmevdDocument、listScriptContainerEntriesPage 等）
 *   - saveText 等文本写入链路的 main 侧实现
 *   - Bridge 子进程、SQLite、utilityProcess、凭据 vault 的真实行为
 * 这些由 core smoke、契约门禁与 native 层分别覆盖。要把 e2e 提升为真实 main
 * 覆盖，需让本文件加载生产 registerIpcHandlers 并只把最外层依赖（Bridge、
 * SQLite、文件系统根）替换为受控替身——那是独立工作项。
 *
 * 环境变量：
 * - SF_TEST_APPLY_FAIL=1：FMG 写入返回 ORIGINAL_CHANGED_DURING_STAGING 失败。
 * - SF_TEST_CANCEL_DIALOG=1：workspace.openDialog 返回 null（用户取消路径）。
 * - SF_TEST_BROWSER_PREVIEW=1：创建无 preload 窗口，模拟普通浏览器预览表面。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(here, '../../out');
const APPLY_FAIL = process.env.SF_TEST_APPLY_FAIL === '1';
const CANCEL_DIALOG = process.env.SF_TEST_CANCEL_DIALOG === '1';
const BROWSER_PREVIEW = process.env.SF_TEST_BROWSER_PREVIEW === '1';

/** Synthetic fixture corpus — tiny, constructed, explicitly labeled (AGENTS.md §15). */
function makeFile({ dir, name, kind, formatKind, formatLabel, extension, compoundExtension, size = 2048 }) {
  const relativePath = dir ? `${dir}/${name}` : name;
  return {
    sourceUri: `fixture://${relativePath}`,
    game: 'sekiro',
    resourceKind: kind,
    parseStatus: 'parsed',
    diagnostics: [],
    relativePath,
    extension,
    compoundExtension,
    formatKind,
    formatLabel,
    size,
    mtimeMs: 0
  };
}

const fixtureFiles = [
  makeFile({ dir: 'event', name: 'common.emevd', kind: 'event', formatKind: 'emevd', formatLabel: 'EMEVD', extension: '.emevd', compoundExtension: '.emevd' }),
  makeFile({ dir: 'msg', name: 'test.msgbnd.dcx', kind: 'msg', formatKind: 'fmg', formatLabel: 'FMG', extension: '.dcx', compoundExtension: '.msgbnd.dcx' }),
  makeFile({ dir: 'action', name: 'c0000.tae', kind: 'action', formatKind: 'unknown', formatLabel: 'TAE', extension: '.tae', compoundExtension: '.tae' }),
  makeFile({ dir: 'ai', name: 'm10.aibnd.dcx', kind: 'ai', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.aibnd.dcx' }),
  makeFile({ dir: 'sfx', name: 'f0000.sfxbnd.dcx', kind: 'sfx', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.sfxbnd.dcx' }),
  makeFile({ dir: 'chr', name: 'sample.chrbnd.dcx', kind: 'chr', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.chrbnd.dcx' }),
  makeFile({ dir: 'other', name: 'notes.txt', kind: 'other', formatKind: 'text', formatLabel: 'TXT', extension: '.txt', compoundExtension: '.txt' }),
  // unknown 不合并进 other：独立保留并在顶部栏显示警告计数。
  makeFile({ dir: '', name: 'regulation.bin', kind: 'unknown', formatKind: 'unknown', formatLabel: 'BIN', extension: '.bin', compoundExtension: '.bin' })
];

/**
 * 大工作区 fixture（SF_TEST_LARGE_WORKSPACE=1 启用）。
 *
 * 为什么需要它：默认 fixture 只有 8 个文件，**低于分页页大小与搜索上限**，所以
 * 分页控件和截断说明在默认套件里根本不会出现——那等于这两条行为在 e2e 层零覆盖。
 * 这里构造 460 个合成条目（微小、显式构造、不含真实游戏资产，AGENTS.md §15），
 * 跨过 200/页 与搜索 60 条两个阈值，让「翻页真的换内容」「截断说明真的出现」
 * 可以被断言。
 */
const LARGE_WORKSPACE = process.env.SF_TEST_LARGE_WORKSPACE === '1';
const LARGE_FILE_COUNT = 460;

function makeLargeFixtureFiles() {
  return Array.from({ length: LARGE_FILE_COUNT }, (_unused, index) => makeFile({
    dir: 'map',
    // 序号补零：排序后页内顺序稳定，断言才能指名某一页的首项。
    name: `m${String(index).padStart(4, '0')}.msb.dcx`,
    kind: 'map',
    formatKind: 'msb',
    formatLabel: 'MSB',
    extension: '.dcx',
    compoundExtension: '.msb.dcx'
  }));
}

const fixture = {
  workspaceUri: 'fixture://workspace/sekiro-test',
  fmg: {
    sourceHash: 'fixture-hash-0001',
    entries: [
      { id: 100, text: '伤药葫芦' },
      { id: 101, text: '返回骨片' }
    ]
  }
};

/** IPC 调用计数：测试经 app.evaluate(() => global.__fixtureIpcCalls) 读取。 */
global.__fixtureIpcCalls = Object.create(null);
function track(channel) {
  global.__fixtureIpcCalls[channel] = (global.__fixtureIpcCalls[channel] ?? 0) + 1;
}

/**
 * 受信任的 renderer 主文档地址：window.webContents.id -> 归一化后的 document URL。
 *
 * 与生产 main 的 trustedRendererDocuments 同语义。fixture 必须自己也走这道校验，
 * 否则 e2e 跑的是一个**没有安全层的** main —— 生产侧 assertTrustedSender
 * （ipc.ts 的 handle 包装器里，56 个 channel 的必经之路）在 e2e 中零覆盖，
 * 而它正是「渲染进程被导航到外部页面后不得继续调 IPC」这条边界的唯一执行点。
 */
const trustedRendererDocuments = new Map();

function normalizeRendererDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 与生产 ipc.ts:assertTrustedSender 逐条件对齐。
 *
 * 刻意不留「关闭校验」的环境变量开关：那种开关会成为绕过安全断言的后门，而
 * 后门存在本身就让「e2e 覆盖了安全层」这句话失效。做负向证明时临时改这个函数
 * 并在验证后还原（本轮已实测：临时放行后用例报 unexpectedly-allowed 并失败）。
 */
function assertTrustedSender(event, channel) {
  const expectedDocument = trustedRendererDocuments.get(event.sender.id);
  const frame = event.senderFrame;
  const actualDocument = frame ? normalizeRendererDocumentUrl(frame.url) : null;
  if (!expectedDocument
    || !frame
    || frame !== event.sender.mainFrame
    || actualDocument !== expectedDocument) {
    throw new Error(`已拒绝不受信任的 IPC 调用：${channel}`);
  }
}

/**
 * 注册 channel 的统一入口，镜像生产 ipc.ts 的 handle 包装器：
 * 先校验发送方，再执行 handler。
 *
 * 用包装器而不是在每个 handler 里手写校验：生产侧就是这个形态（一处包装、
 * 56 个 channel 必经），fixture 若逐个手写会漏，而漏掉的那个 channel 在 e2e
 * 里就成了「绕过安全层也能通」的样本。
 */
function handleTrusted(channel, listener) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    return listener(event, ...args);
  });
}

function registerFixtureIpc() {
  handleTrusted('workspace.openDialog', () => {
    track('workspace.openDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-overlay', label: 'fixture-overlay' };
  });

  handleTrusted('workspace.scan', () => {
    track('workspace.scan');
    const scanned = LARGE_WORKSPACE
      ? [...fixtureFiles, ...makeLargeFixtureFiles()]
      : fixtureFiles;
    return {
      workspaceSessionId: 'fixture-session',
      workspaceLabel: 'fixture-workspace',
      files: scanned.map((file) => ({ ...file })),
      countsByKind: {
        event: 1, map: LARGE_WORKSPACE ? LARGE_FILE_COUNT : 0, param: 0, msg: 1, menu: 0, script: 0,
        action: 1, ai: 1, sfx: 1, chr: 1, obj: 0, other: 1, unknown: 1
      },
      diagnostics: [],
      session: {
        workspaceSessionId: 'fixture-session',
        workspaceLabel: 'fixture-workspace',
        game: 'sekiro',
        openedAt: new Date().toISOString(),
        baseMounted: false
      }
    };
  });

  handleTrusted('workspace.analyze', () => ({
    parsedFiles: fixtureFiles.length,
    inspectedFiles: fixtureFiles.length,
    referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 },
    diagnostics: [],
    events: [],
    tools: []
  }));

  handleTrusted('workspace.openBaseDialog', () => {
    track('workspace.openBaseDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-base', label: 'fixture-base' };
  });

  handleTrusted('resource.search', () => []);
  handleTrusted('resource.preview', () => null);

  // 容器工作台合成通道：微小、合法构造、明确标记（AGENTS.md §15）。
  const containerChildren = [
    {
      childId: '0', name: 'item.fmg', offset: 0, size: 512,
      hash: 'fixture-child-0000', formatKind: 'fmg',
      sourceContainerUri: 'fixture://msg/test.msgbnd.dcx',
      childUri: 'fixture://msg/test.msgbnd.dcx#0',
      rawBytesAvailable: false, canReplace: false
    },
    {
      childId: '1', name: 'menu.fmg', offset: 512, size: 512,
      hash: 'fixture-child-0001', formatKind: 'fmg',
      sourceContainerUri: 'fixture://msg/test.msgbnd.dcx',
      childUri: 'fixture://msg/test.msgbnd.dcx#1',
      rawBytesAvailable: false, canReplace: false
    }
  ];
  handleTrusted('resource.inspectContainerTree', (_event, uri) => ({
    ok: true,
    rootUri: uri,
    root: {
      uri, format: 'bnd4', authority: 'fixture', magic: 'BND4',
      size: 2048, hash: 'fixture-container-0001', childCount: containerChildren.length,
      canListChildren: true, canReadChild: false, canReplaceChild: false,
      canRepackContainer: false, containerRoundTripSafe: false,
      decompressionStatus: 'not-applicable', compressionStatus: 'not-applicable'
    },
    diagnostics: []
  }));
  handleTrusted('resource.listContainerChildrenPage', (_event, _uri, page, pageSize) => ({
    ok: true,
    totalCount: containerChildren.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(containerChildren.length / pageSize)),
    children: containerChildren.slice(page * pageSize, page * pageSize + pageSize),
    diagnostics: []
  }));
  handleTrusted('resource.listContainerChildren', () => ({
    ok: true,
    children: containerChildren.map((child) => ({ ...child })),
    diagnostics: []
  }));
  handleTrusted('operation.list', () => []);
  handleTrusted('operation.rollback', (_event, opId) => ({
    ok: false,
    opId,
    restoredFiles: [],
    diagnostics: [{ severity: 'warning', code: 'FIXTURE_NO_ROLLBACK', message: 'fixture 不提供回滚。' }]
  }));
  handleTrusted('ai.tools', () => {
    track('ai.tools');
    return [
      { name: 'search_resources', description: 'fixture 只读工具', permission: 'read', permissionLevel: 'read' },
      { name: 'stage_patch', description: 'fixture 暂存工具', permission: 'plan', permissionLevel: 'stage' }
    ];
  });

  /* ── AI agent 会话（合成，不调用任何模型）─────────────────────────────────
     这里**不跑真实模型**，只驱动 renderer 的推送折叠与取消链路：run 受理后按
     计时器推 turn-started / tool-call / delta，cancel 停掉计时器并推终态。

     为什么必须有推送：`ai:agent:event` 是 webContents.send，进度只能靠事件到达
     推进。fixture 若只回一个 sessionId 不推事件，「进度事件到达界面就更新」这条
     在 e2e 层等于零覆盖——而那正是本轮要守的两条行为之一。

     覆盖边界：不验证真实 provider、不验证主进程的 AbortController 语义（那是
     生产 ipc.ts 的行为），只验证 renderer 发出了 ai.agent.cancel 并据推送更新界面。 */
  const agentTimers = new Set();
  let agentSessionSeq = 0;

  function pushAgentEvent(window, sessionId, event) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send('ai:agent:event', { sessionId, event });
  }

  function scheduleAgentEvent(window, sessionId, delayMs, event) {
    const timer = setTimeout(() => {
      agentTimers.delete(timer);
      pushAgentEvent(window, sessionId, event);
    }, delayMs);
    agentTimers.add(timer);
  }

  handleTrusted('ai.agent.run', (event, request) => {
    track('ai.agent.run');
    // 与生产同形态的必填校验（ipc.ts:2929）：configId / prompt 缺失即结构化失败。
    if (typeof request?.configId !== 'string' || request.configId.trim() === ''
      || typeof request?.prompt !== 'string' || request.prompt.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'configId 与 prompt 必填。' } };
    }
    if (request.resumeSessionPath !== undefined) track('ai.agent.run:resume');
    // 生产侧 request.mode 省略时落到 'plan'（ipc.ts:2967）。renderer 若开始传
    // fullPermission，这里的记账会让它在断言中现形。
    track(`ai.agent.run:mode=${request.mode ?? 'absent'}`);
    agentSessionSeq += 1;
    const sessionId = `fixture-session-${agentSessionSeq}`;
    const window = BrowserWindow.fromWebContents(event.sender);
    pushAgentEvent(window, sessionId, { type: 'session-accepted', mode: 'plan' });
    scheduleAgentEvent(window, sessionId, 120, { type: 'turn-started', step: 1 });
    scheduleAgentEvent(window, sessionId, 200, {
      type: 'tool-call-begin', step: 1, callId: 'fixture-call-1', name: 'search_resources'
    });
    scheduleAgentEvent(window, sessionId, 280, {
      type: 'tool-call-end', step: 1, callId: 'fixture-call-1', name: 'search_resources', ok: true
    });
    scheduleAgentEvent(window, sessionId, 360, {
      type: 'agent-message-delta', step: 1, text: '合成增量文本'
    });
    // 刻意**不**自动推终态：任务停在运行中，取消用例才有可取消的对象。
    return { ok: true, sessionId };
  });

  handleTrusted('ai.agent.cancel', (event, sessionId) => {
    track('ai.agent.cancel');
    for (const timer of agentTimers) clearTimeout(timer);
    agentTimers.clear();
    const window = BrowserWindow.fromWebContents(event.sender);
    // 终态由主进程回报，与生产一致（ipc.ts:3009 的 session-done）。
    pushAgentEvent(window, sessionId, {
      type: 'session-done', finishReason: 'cancelled', steps: 1, rolloutFileName: 'fixture-rollout.jsonl'
    });
    return { ok: true };
  });

  handleTrusted('ai.agent.sessions', () => {
    track('ai.agent.sessions');
    // 23 条：跨过每页 10 条的阈值，分页控件与区间文案才会真的出现。
    return {
      ok: true,
      sessions: Array.from({ length: 23 }, (_unused, index) => ({
        sessionPath: `2026/08/08/fixture-rollout-${String(index).padStart(4, '0')}.jsonl`,
        fileName: `fixture-rollout-${String(index).padStart(4, '0')}.jsonl`,
        sessionId: `fixture-s-${index}`,
        startedAt: `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`,
        messageCount: index,
        parseErrors: 0,
        interrupted: false,
        compactedWindows: 0,
        sizeBytes: 4096,
        modifiedAt: `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`
      }))
    };
  });

  handleTrusted('ai.agent.session.load', (_event, sessionPath) => {
    track('ai.agent.session.load');
    if (typeof sessionPath !== 'string' || sessionPath.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionPath 必填。' } };
    }
    return {
      ok: true,
      meta: {
        sessionId: 'fixture-loaded',
        startedAt: '2026-08-08T10:00:00.000Z',
        configId: 'fixture-service',
        protocol: 'openai-compatible',
        permissionMode: 'plan'
      },
      messageCount: 12,
      parseErrors: 0,
      interrupted: false,
      compactedWindows: 0,
      messagesPage: [{ role: 'user', content: 'fixture 会话尾部消息' }]
    };
  });

  handleTrusted('ai.sidebarDraft', () => ({
    summary: 'fixture draft',
    steps: [],
    evidence: [],
    diagnostics: []
  }));
  /*
   * 合成模型服务：hasCredential=true 只表示「vault 里有一条已加密记录」，
   * 不代表存在可用的真实 provider——fixture 从不发起网络请求。
   * 需要它是因为任务面板的运行入口以「有已配置凭据的服务」为前置条件，
   * 空列表下运行按钮恒禁用，取消链路在 e2e 层就无从触达。
   */
  handleTrusted('modelService.list', () => [{
    id: 'fixture-service',
    displayName: 'fixture 合成模型服务',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'fixture-model',
    hasCredential: true,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  }]);
  handleTrusted('modelService.encryptionAvailable', () => false);
  handleTrusted('runtime.detectMe3', () => ({ detected: false }));

  handleTrusted('resource.readFmgDocument', () => ({
    ok: true,
    data: {
      sourceHash: fixture.fmg.sourceHash,
      entries: fixture.fmg.entries.map((entry) => ({ ...entry })),
      entryCount: fixture.fmg.entries.length,
      authority: 'fixture'
    }
  }));

  handleTrusted('resource.readFmgPage', (_event, _uri, page, pageSize) => {
    const start = page * pageSize;
    return {
      ok: true,
      entries: fixture.fmg.entries.slice(start, start + pageSize),
      page,
      pageCount: Math.max(1, Math.ceil(fixture.fmg.entries.length / pageSize)),
      entryCount: fixture.fmg.entries.length,
      maxId: fixture.fmg.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
      diagnostics: []
    };
  });

  handleTrusted('resource.applyFmgMutation', (_event, _uri, expectedHash, mutation) => {
    if (APPLY_FAIL) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'ORIGINAL_CHANGED_DURING_STAGING',
          message: '写入校验时发现目标已被外部修改；未写入任何内容。'
        }]
      };
    }
    if (expectedHash !== fixture.fmg.sourceHash) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'HASH_PRECONDITION_FAILED',
          message: 'hash 前置条件不匹配，拒绝写入。'
        }]
      };
    }
    if (mutation.kind === 'delete') {
      fixture.fmg.entries = fixture.fmg.entries.filter((entry) => entry.id !== mutation.id);
    } else if (mutation.kind === 'add') {
      fixture.fmg.entries.push({ id: mutation.id, text: mutation.text ?? '' });
    } else {
      const existing = fixture.fmg.entries.find((entry) => entry.id === mutation.id);
      if (existing) existing.text = mutation.text ?? '';
      else fixture.fmg.entries.push({ id: mutation.id, text: mutation.text ?? '' });
    }
    fixture.fmg.sourceHash = `fixture-hash-${String(Number(fixture.fmg.sourceHash.split('-').pop()) + 1).padStart(4, '0')}`;
    return { ok: true, diagnostics: [] };
  });
}

async function createWindow({ withPreload }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      ...(withPreload ? { preload: path.join(outRoot, 'preload', 'index.cjs') } : {}),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const rendererFile = path.join(outRoot, 'renderer', 'index.html');
  // 先登记受信任文档再加载，顺序与生产一致：登记晚于首个 IPC 调用会让正常
  // 启动路径被自己的安全校验拒绝。
  trustedRendererDocuments.set(
    window.webContents.id,
    normalizeRendererDocumentUrl(pathToFileURL(rendererFile).href)
  );
  window.webContents.once('destroyed', () => {
    trustedRendererDocuments.delete(window.webContents.id);
  });
  await window.loadFile(rendererFile);
  return window;
}

app.whenReady().then(async () => {
  registerFixtureIpc();
  if (BROWSER_PREVIEW) {
    // browser-preview 表面：无 preload，window.soulforge 不存在。
    await createWindow({ withPreload: false });
  } else {
    await createWindow({ withPreload: true });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

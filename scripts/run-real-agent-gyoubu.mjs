/**
 * 真实 Agent 链路模拟：
 *
 * - 从当前本机 Mod 复制 PARAM / MSG / EVENT / MAP 语料到一次性 overlay；
 * - 使用当前 production ToolRegistry、AgentToolBridge、AgentSessionHost；
 * - 使用环境中已经配置的真实 OpenAI-compatible 服务调用模型；
 * - 让模型自行完成「搜索 -> Evidence -> 原生读取 -> 参数计算 -> 写入」；
 * - 写入只发生在隔离 overlay，结束后用真实 Patch Engine 回滚并回读。
 *
 * 运行时使用 Node 24 的 --experimental-strip-types 导入桌面端真实
 * agentTaskRecord.ts，确保本脚本使用的 Evidence 门禁和桌面生产实现一致。
 * 不打印或写入 API key。
 */

import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import * as Core from '../packages/core/dist/index.js';
import { createAgentTaskRecordGateway } from '../apps/desktop/src/main/agentTaskRecord.ts';
import { loadTestConfiguration } from '../apps/desktop/src/main/testLoader.ts';

const {
  InMemoryMemoryStore,
  MemoryOperationLogStore,
  analyzeWorkspace,
  createAgentToolBridge,
  createConfiguredModelServiceAdapter,
  createConfirmationReceipt,
  createContextBroker,
  openWorkspaceSession,
  runAgentSession,
  disposeBridgeDaemonPool,
  redactSecrets
} = Core;

const GAME_ROOT = process.env.SOULFORGE_SEKIRO_ROOT
  ?? 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const MOD_ROOT = process.env.SOULFORGE_SEKIRO_MOD_ROOT
  ?? join(GAME_ROOT, 'mods');
const DEFAULT_TASK_QUERY = '把鬼刑部改为精英怪，血条改为2，死亡后掉落靛蓝星陨';
const CLI_OPTIONS = parseCliOptions(process.argv.slice(2));
const TASK_QUERY = CLI_OPTIONS.query ?? DEFAULT_TASK_QUERY;
const SAFE_LABEL = new Date().toISOString().replace(/[:.]/gu, '-');
const REPORT_LABEL = safeFileLabel(CLI_OPTIONS.label ?? 'real-agent');
const MAX_STEPS = positiveInteger(
  CLI_OPTIONS.maxSteps ?? process.env.SOULFORGE_REAL_AGENT_MAX_STEPS,
  200
);
const REQUEST_TIMEOUT_MS = positiveInteger(
  CLI_OPTIONS.timeoutMs ?? process.env.SOULFORGE_REAL_AGENT_TIMEOUT_MS,
  180_000
);
const MAX_OUTPUT_TOKENS = positiveInteger(
  CLI_OPTIONS.maxOutputTokens ?? process.env.SOULFORGE_REAL_AGENT_MAX_OUTPUT_TOKENS,
  60_000
);

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseCliOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const next = args[index + 1];
    if (arg === '--query' && typeof next === 'string' && next.trim() !== '') {
      options.query = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--label' && typeof next === 'string' && next.trim() !== '') {
      options.label = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--max-steps' && typeof next === 'string') {
      options.maxSteps = next;
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms' && typeof next === 'string') {
      options.timeoutMs = next;
      index += 1;
      continue;
    }
    if (arg === '--max-output-tokens' && typeof next === 'string') {
      options.maxOutputTokens = next;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  if (options.query === undefined && positional.length > 0) {
    options.query = positional.join(' ').trim();
  }
  return options;
}

function safeFileLabel(value) {
  const normalized = value
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return normalized || 'real-agent';
}

function printHelp() {
  console.log([
    'SoulForge 真实 Agent 链路模拟',
    '',
    '默认：读取项目根目录 test 配置；500K 上下文，80%（400K）压缩；最多 200 步。',
    '写入只发生在临时 overlay，运行结束自动回滚，并在 output/agent-real 保存报告。',
    '',
    '用法：',
    '  npm run agent:simulate',
    '  npm run agent:simulate -- "你的原始修改指令"',
    '  npm run agent:simulate -- --query "你的修改任务" --label "任务名"',
    '',
    '可选参数：',
    '  --query <文本>             覆盖默认任务',
    '  --label <名称>             报告文件名前缀',
    '  --max-steps <整数>         默认 200',
    '  --timeout-ms <整数>        每次模型请求超时，默认 180000',
    '  --max-output-tokens <整数> 总输出预算，默认 60000'
  ].join('\n'));
}

function log(message) {
  process.stderr.write(`[real-agent] ${message}\n`);
}

function sanitizeForReport(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeForReport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeForReport(child)]));
  }
  return value;
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/**
 * Replace only the chunks whose source changed after a native read.  The
 * initial corpus remains the bounded snapshot used by the run; a semantic
 * refresh never starts a second full-corpus snapshot or discards unrelated
 * sources.  buildRagCorpus still owns the native/index authority and is only
 * asked for the explicit source delta.
 */
function mergeRagSourceDelta(previous, delta, sourceUris) {
  const changed = new Set(sourceUris.filter((sourceUri) => (
    typeof sourceUri === 'string' && sourceUri.trim() !== ''
  )));
  if (changed.size === 0) return previous;
  const chunksById = new Map(
    previous.chunks
      .filter((chunk) => !changed.has(chunk.sourceUri))
      .map((chunk) => [chunk.chunkId, chunk])
  );
  for (const chunk of delta.chunks) chunksById.set(chunk.chunkId, chunk);
  // buildRagCorpus returns the current index reference graph, so replacing the
  // graph as one bounded value also removes edges to rows that disappeared in
  // the refreshed source. No inferred edge or identifier is added here.
  return Core.createRagCorpus({
    workspaceId: previous.workspaceId,
    builtAt: delta.builtAt,
    chunks: [...chunksById.values()],
    references: delta.references,
    diagnostics: delta.diagnostics
  });
}

/** Coalesce hook bursts from parallel native reads into one source-delta build. */
function createIncrementalRagRefresh(index, getCorpus, setCorpus) {
  const pendingSources = new Set();
  const waiters = [];
  let timer = null;
  let running = false;
  let refreshes = 0;
  let refreshedSources = 0;
  let failures = 0;

  const schedule = () => {
    if (timer !== null || running || pendingSources.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, 40);
  };

  const flush = async () => {
    if (running || pendingSources.size === 0) return;
    running = true;
    const sources = [...pendingSources];
    pendingSources.clear();
    const batchWaiters = waiters.splice(0, waiters.length);
    try {
      const previous = getCorpus();
      const delta = Core.buildRagCorpus(index, new Date().toISOString(), [], sources);
      setCorpus(mergeRagSourceDelta(previous, delta, sources));
      refreshes += 1;
      refreshedSources += sources.length;
    } catch (error) {
      failures += 1;
      log(`RAG source-delta refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      for (const waiter of batchWaiters) waiter();
      schedule();
    }
  };

  const request = (sourceUris = []) => {
    const sources = Array.isArray(sourceUris) ? sourceUris : [];
    const normalized = sources
      .filter((sourceUri) => typeof sourceUri === 'string' && sourceUri.trim() !== '')
      .map((sourceUri) => sourceUri.trim());
    if (normalized.length === 0) return Promise.resolve();
    for (const sourceUri of normalized) pendingSources.add(sourceUri);
    const promise = new Promise((resolve) => waiters.push(resolve));
    schedule();
    return promise;
  };

  return {
    request,
    stats: () => ({ refreshes, refreshedSources, failures })
  };
}

async function assertDirectory(directory, label) {
  const info = await stat(directory);
  assert.equal(info.isDirectory(), true, `${label} 不是目录：${directory}`);
}

async function copySemanticWorkspace(overlayRoot) {
  await assertDirectory(MOD_ROOT, '真实 Mod 根目录');
  await assertDirectory(GAME_ROOT, '真实游戏根目录');
  await mkdir(overlayRoot, { recursive: true });
  for (const kind of ['param', 'msg', 'event', 'map', 'script']) {
    const source = join(MOD_ROOT, kind);
    const target = join(overlayRoot, kind);
    await cp(source, target, { recursive: true });
    log(`已复制真实 ${kind} 语料到隔离 overlay。`);
  }
}

function chooseProvider() {
  const configuredTest = loadTestConfiguration();
  if (configuredTest) {
    return {
      apiKey: configuredTest.api,
      config: {
        id: 'test-service',
        displayName: 'test',
        protocol: configuredTest.protocol,
        baseUrl: configuredTest.url.replace(/\/$/u, ''),
        model: configuredTest.model,
        hasCredential: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contextWindowTokens: 500_000
      }
    };
  }
  throw new Error('REAL_AGENT_TEST_CONFIG_MISSING: 当前真实链路测试必须使用项目根目录的 test 配置。');
}

function buildSystemPrompt() {
  const systemPath = resolve('prompt/system.md');
  return readFile(systemPath, 'utf8');
}

function snapshotToolCalls(messages) {
  return messages
    .flatMap((message) => message.toolCalls ?? [])
    .map((call) => ({
      id: call.id,
      name: call.name,
      argumentsJson: sanitizeForReport(call.argumentsJson)
    }));
}

function lastToolCall(messages, name) {
  return snapshotToolCalls(messages).filter((call) => call.name === name).at(-1);
}

function parseToolArguments(call) {
  try {
    return JSON.parse(call.argumentsJson);
  } catch {
    return null;
  }
}

/**
 * 这个脚本测试的是一条固定的生产任务，不应把“模型停下且发生过任意写入”
 * 当成用户需求已完成。这里仅依据可观察的工具调用、提交记录和最终汇报做
 * 最低限度的覆盖判定；原生读回、Patch Engine 和回滚结果仍单独记录。
 */
function assessTaskCompletion({ runResult, toolEvents, historyBeforeRollback }) {
  const toolCalls = snapshotToolCalls(runResult.run.messages);
  const finalAssistantText = runResult.run.messages
    .filter((message) => message.role === 'assistant' && message.content.trim() !== '')
    .map((message) => message.content)
    .slice(-3)
    .join('\n');
  const mutationCalls = toolCalls
    .filter((call) => call.name === 'mutate_param_fields')
    .map((call) => parseToolArguments(call))
    .filter((value) => value && Array.isArray(value.edits));
  const hasNpcMutation = mutationCalls.some((value) => value.edits.some((edit) => (
    /npcparam|npc_param_st/iu.test(String(edit.table ?? ''))
    && /ninsatuNum|teamType/iu.test(String(edit.fieldId ?? ''))
  )));
  const hasDropMutation = mutationCalls.some((value) => value.edits.some((edit) => (
    /itemlot|resourceitemlot|equipparamgoods|npcparam/iu.test(String(edit.table ?? ''))
    && /itemlot|lotitem|resourceitem/iu.test(String(edit.fieldId ?? ''))
  )));
  const successfulToolNames = new Set(
    toolEvents
      .filter((event) => event.type === 'end' && event.ok === true)
      .map((event) => event.name)
  );
  const hasLightningMutation = successfulToolNames.has('apply_emevd_dsl');
  const modelReportedPartial = /\bpartial\b|部分完成|未写入|未完成|阻塞|待确认|请确认|缺少稳定关联|下一步/iu.test(finalAssistantText);
  const hasCommittedOperation = historyBeforeRollback.some((item) => item.status === 'committed');
  const requiredDomains = {
    npcParam: hasNpcMutation,
    deathDrop: hasDropMutation
  };
  if (/落雷|闪电|雷/iu.test(TASK_QUERY)) {
    requiredDomains.lightningEvent = hasLightningMutation;
  }
  return {
    ok: (/鬼[刑型]部.*精英怪/iu.test(TASK_QUERY)
      ? Object.values(requiredDomains).every(Boolean)
      : hasCommittedOperation) && hasCommittedOperation && !modelReportedPartial,
    requiredDomains,
    hasCommittedOperation,
    modelReportedPartial,
    finalAssistantText: finalAssistantText.slice(-12_000)
  };
}

async function run() {
  if (CLI_OPTIONS.help) {
    printHelp();
    return;
  }
  const scratchRoot = await mkdtemp(join(tmpdir(), `soulforge-real-agent-${SAFE_LABEL}-`));
  const overlayRoot = join(scratchRoot, 'overlay');
  const storageRoot = join(scratchRoot, 'storage');
  const sessionsDir = join(scratchRoot, 'rollouts');
  const taskRecordDir = join(scratchRoot, 'task-records');
  const backupBaseDir = join(storageRoot, 'backups');
  const recoveryDir = join(storageRoot, 'recovery');
  const reportDir = resolve('output/agent-real');
  const reportStem = `${REPORT_LABEL}-${SAFE_LABEL}`;
  const reportPath = join(reportDir, `${reportStem}.json`);
  const taskRecordCopyPath = join(reportDir, `${reportStem}.evidence.md`);
  let report;

  try {
    await copySemanticWorkspace(overlayRoot);
    await mkdir(backupBaseDir, { recursive: true });
    await mkdir(recoveryDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(taskRecordDir, { recursive: true });

    const session = await openWorkspaceSession({
      overlayRoot,
      baseRoot: GAME_ROOT,
      game: 'sekiro'
    });
    const paramPath = join(overlayRoot, 'param', 'gameparam', 'gameparam.parambnd.dcx');
    const beforeHash = await sha256File(paramPath);
    const beforeSize = (await stat(paramPath)).size;

    log('开始用真实 Bridge 解析隔离 overlay 的 PARAM / MSG / EVENT / MAP。');
    const analysis = await analyzeWorkspace({
      workspaceRoot: overlayRoot,
      parseTextResources: true,
      parseJsonFixtures: true,
      inspectNativeResources: false,
      maxFilesToParse: 500,
      bridgeTimeoutMs: 180_000,
      oodleRuntimeRoot: GAME_ROOT,
      onProgress: (progress) => {
        if (progress.phase === 'parse' && (progress.current === 1 || progress.current % 10 === 0 || progress.current === progress.total)) {
          log(`语义解析 ${progress.current}/${progress.total ?? '?'}：${progress.message ?? ''}`);
        }
      }
    });
    const index = analysis.index;
    const stats = index.getStats();
    log(`语义索引完成：files=${stats.files}, params=${stats.paramRows}, texts=${stats.textEntries}, events=${stats.events}, maps=${stats.mapEntities}。`);
    // 真实链路也必须经过当前生产 RAG 门面。只构建一次并把同一份快照
    // 注入 ToolRegistry/自动检索；不能让每次工具调用重新遍历 5 万行参数，
    // 否则会把 RAG 变成 CPU 放大器。
    let ragCorpus = Core.buildRagCorpus(index);
    log(`RAG 快照就绪：chunks=${ragCorpus.chunks.length}, references=${ragCorpus.references.length}, availability=${ragCorpus.availability}。`);

    const provider = chooseProvider();
    const adapterResult = createConfiguredModelServiceAdapter({
      config: provider.config,
      apiKey: provider.apiKey
    });
    if (!adapterResult.ok) {
      throw new Error(`REAL_AGENT_ADAPTER_INVALID: ${JSON.stringify(adapterResult.diagnostics)}`);
    }
    const modelList = await adapterResult.adapter.listModels({ timeoutMs: 30_000 });
    if (!modelList.ok) log(`模型列表请求失败，但继续使用已配置模型：${modelList.error.code}`);
    else log(`真实 API 已连通：可用模型 ${modelList.models.length} 个；本次使用 ${provider.config.model}。`);

    const sessionId = randomUUID();
    const taskRecord = createAgentTaskRecordGateway(taskRecordDir, sessionId);
    const taskRecordSnapshot = await taskRecord.read();
    const memoryStore = new InMemoryMemoryStore(await readFile(join(MOD_ROOT, '.soulforge', 'MEMORY.md'), 'utf8').catch(() => ''));
    const operationLogStore = new MemoryOperationLogStore();
    const commitConfirmation = createConfirmationReceipt({
      subjects: [
        'AGENT_COMMIT_APPROVED',
        'ALL_RISKS',
        `WORKSPACE_SESSION:${session.meta.workspaceId}`,
        'TITLE:mutate_param_fields',
        'TITLE:apply_emevd_dsl',
        'TITLE:mutate_fmg_entries'
      ],
      riskLevel: 'high',
      note: '真实 Agent 链路模拟：只绑定一次性隔离 overlay。'
    });
    let baseContext;
    const ragRefresh = createIncrementalRagRefresh(
      index,
      () => ragCorpus,
      (nextCorpus) => {
        ragCorpus = nextCorpus;
        if (baseContext) baseContext.rag = nextCorpus;
      }
    );
    baseContext = {
      workspaceIndex: index,
      mode: 'fullPermission',
      allowMemoryWrite: false,
      rag: ragCorpus,
      memoryStore,
      session,
      operationLogStore,
      backupBaseDir,
      recoveryDir,
      confirmation: commitConfirmation,
      taskRecord,
      requireTaskRecord: true,
      onSemanticEvidenceUpdated: ragRefresh.request
    };
    const registry = Core.createDefaultToolRegistry();
    const bridge = createAgentToolBridge({
      registry,
      context: baseContext
    });
    const systemPrompt = await buildSystemPrompt();
    const events = [];
    const toolEvents = [];
    const runResult = await runAgentSession({
      sessionId,
      sessionsDir,
      adapter: adapterResult.adapter,
      config: provider.config,
      apiKey: provider.apiKey,
      prompt: TASK_QUERY,
      systemPrompt,
      permissionMode: 'full',
      tools: bridge.tools,
      executeTool: async (call, contextOverride) => bridge.executeTool(call, {
        ...contextOverride,
        mode: 'fullPermission',
        allowMemoryWrite: false,
        rag: ragCorpus,
        session,
        operationLogStore,
        backupBaseDir,
        recoveryDir,
        confirmation: commitConfirmation,
        taskRecord,
        requireTaskRecord: true,
        onSemanticEvidenceUpdated: ragRefresh.request
      }),
      streaming: true,
      approvalRequiredLevels: [],
      contextBroker: createContextBroker(),
      contextBrokerOptions: { maxBytes: 16_000, maxEntries: 20, excerptLength: 800 },
      ragSearch: {
        maxHits: 8,
        retrieve: async (query) => Core.retrieveEvidence(ragCorpus, query, {
          limit: 8,
          expandReferences: true
        })
      },
      maxSteps: MAX_STEPS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxTotalOutputTokens: MAX_OUTPUT_TOKENS,
      // 与桌面生产入口一致：默认上下文窗口 500K，达到 80%（400K）才压缩。
      compaction: {
        autoCompactTokenLimit: 400_000,
        userMessageBudgetTokens: 20_000,
        summaryMaxTokens: 4_096
      },
      retryPolicy: { maxAttempts: 2 },
      recordProviderUsage: async () => undefined,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'tool-call-begin') {
          toolEvents.push({ type: 'begin', step: event.step, name: event.name });
          log(`step=${event.step} tool=${event.name}`);
        } else if (event.type === 'tool-call-end') {
          toolEvents.push({ type: 'end', step: event.step, name: event.name, ok: event.ok, code: event.code });
        }
      }
    });

    const afterRunHash = await sha256File(paramPath);
    const afterRunSize = (await stat(paramPath)).size;
    const nativeReadArgs = lastToolCall(runResult.run.messages, 'read_param_fields');
    let nativeReadAfterRun = null;
    if (nativeReadArgs) {
      const parsedArgs = JSON.parse(nativeReadArgs.argumentsJson);
      nativeReadAfterRun = await bridge.executeTool({
        id: `post-read-${randomUUID()}`,
        name: 'read_param_fields',
        argumentsJson: JSON.stringify(parsedArgs)
      });
    }

    const historyBeforeRollback = await operationLogStore.history(session.meta.workspaceId);
    let rollbackResults = [];
    for (const operation of historyBeforeRollback.filter((item) => item.status === 'committed')) {
      const rollbackConfirmation = createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${operation.opId}`, 'ALL_RISKS'],
        riskLevel: 'high',
        note: '真实 Agent 链路模拟结束：回滚一次性隔离 overlay 的已提交操作。'
      });
      const rollback = await registry.run('rollback_operation', { opId: operation.opId }, {
        ...baseContext,
        confirmation: rollbackConfirmation
      });
      rollbackResults.push({ opId: operation.opId, result: rollback });
    }
    const afterRollbackHash = await sha256File(paramPath);
    const afterRollbackSize = (await stat(paramPath)).size;
    const historyAfterRollback = await operationLogStore.history(session.meta.workspaceId);
    const finalTaskRecord = await taskRecord.read();
    const writeObserved = beforeHash !== afterRunHash || historyBeforeRollback.some((item) => item.status === 'committed');
    const rollbackRestoredBytes = (beforeHash === afterRollbackHash && beforeSize === afterRollbackSize)
      || (rollbackResults.length > 0 && rollbackResults.every((r) => r.result?.ok === true));
    const semanticCompletion = assessTaskCompletion({ runResult, toolEvents, historyBeforeRollback });
    const taskSucceeded = runResult.run.finishReason === 'stop'
      && writeObserved
      && rollbackRestoredBytes
      && semanticCompletion.ok;

    await mkdir(reportDir, { recursive: true });
    const taskRecordPath = taskRecordSnapshot.path;
    await copyFile(taskRecordPath, taskRecordCopyPath);
    const rolloutCopyPath = join(reportDir, `${reportStem}.rollout.jsonl`);
    await copyFile(runResult.rolloutPath, rolloutCopyPath);
    report = sanitizeForReport({
      ok: taskSucceeded,
      task: TASK_QUERY,
      semanticCompletion,
      provider: {
        id: provider.config.id,
        protocol: provider.config.protocol,
        model: provider.config.model,
        baseUrl: provider.config.baseUrl,
        listModelsOk: modelList.ok,
        listModelsCount: modelList.ok ? modelList.models.length : null
      },
      isolatedWorkspace: {
        sourceModRoot: relative(resolve('.'), MOD_ROOT),
        semanticKinds: ['param', 'msg', 'event', 'map'],
        beforeParamHash: beforeHash,
        beforeParamSize: beforeSize,
        afterRunParamHash: afterRunHash,
        afterRunParamSize: afterRunSize,
        afterRollbackParamHash: afterRollbackHash,
        afterRollbackParamSize: afterRollbackSize,
        writeObserved,
        rollbackRestoredBytes
      },
      analysis: {
        parsedFiles: analysis.parsedFiles,
        inspectedFiles: analysis.inspectedFiles,
        stats,
        referenceStats: analysis.referenceStats,
        diagnostics: analysis.diagnostics
      },
      session: {
        sessionId: runResult.sessionId,
        rolloutPath: rolloutCopyPath,
        taskRecordPath: taskRecordCopyPath
      },
      run: {
        finishReason: runResult.run.finishReason,
        steps: runResult.run.steps,
        diagnostics: runResult.run.diagnostics,
        audit: runResult.run.audit,
        toolEvents,
        eventsCount: events.length,
        finalAssistantMessages: runResult.run.messages
          .filter((message) => message.role === 'assistant' && message.content.trim() !== '')
          .map((message) => message.content)
          .slice(-3),
        toolCalls: snapshotToolCalls(runResult.run.messages),
        nativeReadAfterRun,
        ragRefresh: ragRefresh.stats()
      },
      evidence: {
        before: taskRecordSnapshot,
        after: finalTaskRecord
      },
      operations: {
        beforeRollback: historyBeforeRollback,
        rollbackResults,
        afterRollback: historyAfterRollback
      }
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`报告已写入 ${reportPath}。`);
    console.log(JSON.stringify({
      ok: report.ok,
      branch: process.env.GIT_BRANCH ?? undefined,
      provider: report.provider,
      finishReason: report.run.finishReason,
      steps: report.run.steps,
      writeObserved: report.isolatedWorkspace.writeObserved,
      rollbackRestoredBytes: report.isolatedWorkspace.rollbackRestoredBytes,
      toolCalls: report.run.audit.toolCalls.map((call) => call.name),
      reportPath,
      evidencePath: taskRecordCopyPath,
      rolloutPath: rolloutCopyPath
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool().catch((error) => log(`Bridge daemon 清理失败：${error.message}`));
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

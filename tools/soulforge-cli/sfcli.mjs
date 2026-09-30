#!/usr/bin/env node
/**
 * SoulForge CLI — 在桌面应用之外调用生产 ToolRegistry 的全部 Agent 工具。
 *
 * 用法:
 *   node tools/soulforge-cli/sfcli.mjs --workspace <mods> [选项] list
 *   node tools/soulforge-cli/sfcli.mjs --workspace <mods> call <tool> '<json>'
 *   node tools/soulforge-cli/sfcli.mjs --workspace <mods> call --stdin <tool>
 *
 * 选项:
 *   --workspace <path>   Mod 工作区（overlay），必填
 *   --base <path>        游戏根目录（可选，用于 Oodle/EMEDF）
 *   --game <name>        默认 sekiro
 *   --mode <mode>        plan | normal | fullPermission（默认 normal）
 *   --confirm-rollback <opId>  显式授予当前 workspace 对单个 opId 的一次性回滚确认
 *   --analyze            打开后执行完整原生分析（慢，但无语义缓存时需要）
 *   --no-analyze          显式跳过语义分析（适用于操作历史/回滚等维护工具）
 *   --no-cache           跳过 workspace.db 语义缓存水合
 *   --json               以紧凑 JSON 输出结果
 *   --quiet              仅输出工具结果
 *   --diagnostics        将阶段耗时与游标诊断以 JSON Lines 写入 stderr
 */

import { runHeadlessAgentCommand } from './headless-agent.mjs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

// Portable/local SDK hosts may omit ProgramFiles; NuGet restore (dotnet run
// fallback) and some path combinators require them.
if (!process.env.PROGRAMFILES) process.env.PROGRAMFILES = 'C:\\Program Files';
if (!process.env.ProgramW6432) process.env.ProgramW6432 = 'C:\\Program Files';
if (!process.env.CommonProgramFiles) {
  process.env.CommonProgramFiles = 'C:\\Program Files\\Common Files';
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js');
const SHARED_DIST = join(REPO_ROOT, 'packages/shared/dist/index.js');

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// PowerShell 管道默认带 BOM（U+FEFF）；直接 JSON.parse 会报
// "Unexpected token 'U+FEFF'"。stdin 入口统一剥离后再解析。
function stripJsonBom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF+/u, '') : text;
}

// stdout 消费者提前关闭管道（例如 `| head`）时 Node 默认抛出
// 未捕获的 EPIPE，直接崩溃并打印堆栈。只对 EPIPE 静默退出（类
// Unix 惯例），其他写入错误仍按原样报告。
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0);
  process.stderr.write(`stdout 写入失败: ${error?.stack || error}\n`);
  process.exit(1);
});

function parseArgs(argv) {
  const options = {
    workspace: process.env.SOULFORGE_WORKSPACE || process.env.SOULFORGE_SEKIRO_MOD_ROOT || null,
    base: process.env.SOULFORGE_SEKIRO_ROOT || null,
    game: process.env.SOULFORGE_GAME || 'sekiro',
    mode: process.env.SOULFORGE_MODE || 'normal',
    confirmRollback: null,
    analyze: false,
    noAnalyze: false,
    useCache: true,
    json: false,
    quiet: false,
    diagnostics: false,
    command: null,
    tool: null,
    argsJson: null,
    stdin: false
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`选项 ${arg} 缺少取值`);
      return argv[i];
    };
    switch (arg) {
      case '--workspace':
      case '-w':
        options.workspace = next();
        break;
      case '--base':
      case '-b':
        options.base = next();
        break;
      case '--game':
        options.game = next();
        break;
      case '--mode':
        options.mode = next();
        break;
      case '--confirm-rollback':
        options.confirmRollback = next();
        break;
      case '--analyze':
        options.analyze = true;
        break;
      case '--no-analyze':
        options.noAnalyze = true;
        break;
      case '--no-cache':
        options.useCache = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--diagnostics':
        options.diagnostics = true;
        break;
      case '--help':
      case '-h':
        options.command = 'help';
        break;
      default:
        rest.push(arg);
    }
  }
  if (!options.command) {
    options.command = rest.shift() ?? 'help';
  }
  if (options.analyze && options.noAnalyze) fail('--analyze 与 --no-analyze 不能同时使用');
  if (options.command === 'agent') {
    options.agentArgs = rest;
  } else if (options.command === 'call') {
    if (rest[0] === '--stdin') {
      options.stdin = true;
      rest.shift();
    }
    options.tool = rest.shift() ?? null;
    options.argsJson = rest.length > 0 ? rest.join(' ') : null;
  } else if (options.command === 'describe' || options.command === 'desc') {
    options.tool = rest.shift() ?? null;
  } else if (options.command === 'read-param') {
    // read-param <table> <rowId> <field1,field2,...>
    options.table = rest.shift() ?? null;
    options.rowId = rest.shift() ?? null;
    options.fieldList = rest.shift() ?? null;
  } else if (options.command === 'search-param') {
    options.query = rest.shift() ?? null;
    options.paramNames = rest.length > 0 ? rest : null;
  }
  return options;
}

function printUsage() {
  process.stdout.write(`SoulForge CLI — 外置调用生产 Agent 工具

命令:
  agent exec --task-file <UTF-8 file> --responses-file <fixture>  完整 Agent（JSON Lines）
  agent exec --task-file <file> --provider-config <file> --max-cost <limit>  有预算的模型任务
  list                         列出全部工具
  describe <tool>              查看工具说明与输入 schema
  call <tool> ['{"k":v}']      调用任意工具
  call --stdin <tool>          从 stdin 读取 JSON 参数并调用
  session                      打开一次工作区并从 stdin 按行调用工具
  search-param <query> [表...]  快捷：search_param_rows
  read-param <table> <rowId> <f1,f2>  快捷：read_param_fields

选项:
  --workspace <path>           Mod 工作区（必填）
  --base <path>                游戏根目录（可选）
  --mode <mode>                plan | normal | fullPermission
  --confirm-rollback <opId>    当前 workspace 对单个 opId 的一次性 rollback 授权
  --analyze                    显式请求完整原生语义分析
  --no-analyze                 显式跳过语义分析；适用于操作历史/回滚等维护工具
  --no-cache                   跳过 workspace.db 语义缓存水合
  --json                       一次性调用输出 JSON
  --quiet                      隐藏普通进度
  --diagnostics                stderr 输出阶段诊断 JSON Lines

示例:
  node tools/soulforge-cli/sfcli.mjs \\
    --workspace "D:/mystream/Sekiro Shadows Die Twice/Sekiro/mods" \\
    --base "D:/mystream/Sekiro Shadows Die Twice/Sekiro" \\
    search-param 落雷 Bullet

  node tools/soulforge-cli/sfcli.mjs \\
    --workspace "D:/.../mods" \\
    call read_param_fields \\
    '{"table":"Bullet","rowIds":[12200404],"fieldIds":["atkId_Bullet","sfxId_Bullet","HitBulletID"]}'
`);
}

async function loadCore() {
  if (!existsSync(CORE_DIST) || !existsSync(SHARED_DIST)) {
    fail(
      '未找到 packages/core/dist 或 packages/shared/dist。\n' +
      '请先构建: npm run build -w @soulforge/shared && npm run build -w @soulforge/core\n' +
      `期望路径: ${CORE_DIST}`
    );
  }
  return import(pathToFileURL(CORE_DIST).href);
}

function abs(path) {
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printUsage();
    return;
  }

  const log = (message) => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };
  const emitDiagnostic = (event) => {
    if (!options.diagnostics) return;
    process.stderr.write(`${JSON.stringify({
      type: 'soulforge-cli-diagnostic',
      timestamp: new Date().toISOString(),
      ...event
    })}\n`);
  };

  const core = await loadCore();
  const {
    mapCliArgumentsToToolInput,
    openLocalCliSession,
    LocalSessionHost
  } = core;

  if (!options.workspace) fail('必须通过 --workspace 指定 Mod 工作区路径');
  const workspaceRoot = abs(options.workspace);
  const baseRoot = abs(options.base);
  if (!existsSync(workspaceRoot)) fail(`工作区不存在: ${workspaceRoot}`);
  if (baseRoot && !existsSync(baseRoot)) fail(`--base 路径不存在: ${baseRoot}`);

  if (options.command === 'agent') {
    const report = await runHeadlessAgentCommand(options, core, REPO_ROOT);
    if (report.state === 'error') process.exitCode = 1;
    return;
  }

  const metadataOnly = options.command === 'list' || options.command === 'ls'
    || options.command === 'describe' || options.command === 'desc';
  log(`打开工作区: ${workspaceRoot}`);
  const cliSession = await openLocalCliSession({
    overlayRoot: workspaceRoot,
    ...(baseRoot ? { baseRoot } : {}),
    game: options.game,
    mode: options.mode === 'plan' || options.mode === 'fullPermission' ? options.mode : 'normal',
    ...(options.confirmRollback ? { confirmRollbackOpId: options.confirmRollback } : {}),
    principal: 'local-cli',
    analyze: options.noAnalyze ? false : options.analyze || !metadataOnly,
    useCache: options.useCache,
    requireDurableLog: false,
    // Quiet suppresses progress, not degraded cache/audit guarantees. These
    // warnings explain why restart-safe cursors or writes may be unavailable.
    onFallbackWarning: (message) => {
      if (options.diagnostics) {
        emitDiagnostic({ phase: 'host.fallback', status: 'failed', details: { message } });
      } else {
        process.stderr.write(`${message}\n`);
      }
    },
    onDiagnostic: (event) => emitDiagnostic(event),
    onProgress: (progress) => {
      emitDiagnostic({
        phase: `workspace.${progress.phase}`,
        status: 'progress',
        details: {
          current: progress.current,
          ...(progress.total === undefined ? {} : { total: progress.total }),
          ...(progress.message ? { message: progress.message } : {})
        }
      });
      log(`  [${progress.phase}] ${progress.current}/${progress.total ?? '?'} ${progress.message ?? ''}`);
    }
  });
  const { registry } = cliSession;
  log(`扫描/索引完成: files=${cliSession.workspaceIndex.getFiles().length}`);
  emitDiagnostic({
    phase: 'session.ready',
    status: 'complete',
    details: {
      workspaceId: cliSession.coreSession.workspaceId,
      files: cliSession.workspaceIndex.getFiles().length
    }
  });

  const finish = async (code = 0) => {
    try { await cliSession.dispose(); } catch { /* ignore */ }
    process.exit(code);
  };

  const parseToolContent = (content) => {
    if (typeof content !== 'string') return content;
    try { return JSON.parse(content); } catch { return content; }
  };

  const executeToolCall = async (requestId, toolName, rawArgs, signal) => {
    const mapped = mapCliArgumentsToToolInput(toolName, rawArgs);
    if (!mapped.ok) {
      return {
        ok: false,
        code: mapped.code,
        content: JSON.stringify({
          ok: false,
          error: { code: mapped.code, message: mapped.message }
        })
      };
    }
    const startedAt = Date.now();
    emitDiagnostic({
      phase: 'tool',
      status: 'start',
      details: { requestId, tool: toolName }
    });
    try {
      const result = await cliSession.executeTool({
        id: requestId,
        name: toolName,
        argumentsJson: JSON.stringify(mapped.input)
      }, signal ? { signal } : {});
      const diagnostic = core.normalizeCliToolDiagnostic(result, signal);
      emitDiagnostic({
        phase: 'tool',
        status: 'complete',
        elapsedMs: Date.now() - startedAt,
        details: { requestId, tool: toolName, ...diagnostic }
      });
      return result;
    } catch (error) {
      const diagnostic = core.normalizeCliToolDiagnostic(
        {
          ok: false,
          ...(error && typeof error === 'object' && typeof error.code === 'string'
            ? { code: error.code }
            : {})
        },
        signal
      );
      emitDiagnostic({
        phase: 'tool',
        status: 'failed',
        elapsedMs: Date.now() - startedAt,
        details: {
          requestId,
          tool: toolName,
          ...diagnostic,
          message: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  };

  if (options.command === 'session') {
    if (typeof LocalSessionHost !== 'function') {
      throw new Error('CLI_SESSION_HOST_UNAVAILABLE');
    }
    const sessionHost = new LocalSessionHost(
      'stdin',
      cliSession.coreSession.workspaceId,
      'local-cli',
      cliSession.coreSession
    );
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let shouldClose = false;
    const pending = new Set();
    const writeFrame = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
    const handleFrame = async (line) => {
      let frame;
      try {
        frame = JSON.parse(stripJsonBom(line));
      } catch {
        writeFrame({
          id: '',
          ok: false,
          error: { code: 'CLI_REQUEST_INVALID', message: 'session 输入行不是有效 JSON。' }
        });
        return;
      }
      const requestId = typeof frame?.id === 'string' ? frame.id : '';
      const tool = typeof frame?.tool === 'string' ? frame.tool : '';
      const args = frame?.args && typeof frame.args === 'object' && !Array.isArray(frame.args)
        ? frame.args
        : {};
      if (!requestId || !tool) {
        writeFrame({
          id: requestId,
          ok: false,
          error: { code: 'CLI_REQUEST_INVALID', message: 'session 请求必须包含非空 id 和 tool。' }
        });
        return;
      }
      if (tool === '__host_status') {
        writeFrame({
          id: requestId,
          ok: true,
          result: {
            session: 'stdin',
            workspace: workspaceRoot,
            workspaceId: cliSession.coreSession.workspaceId,
            inFlight: sessionHost.listRequestStatuses().filter((item) => ['queued', 'running', 'cancel_requested'].includes(item.state)).length,
            requests: sessionHost.listRequestStatuses()
          }
        });
        return;
      }
      if (tool === '__host_operation_status') {
        const opId = typeof args.opId === 'string' ? args.opId : '';
        writeFrame(opId ? { id: requestId, ok: true, result: await sessionHost.operationStatus(opId) }
          : { id: requestId, ok: false, error: { code: 'CLI_OPERATION_ID_REQUIRED', message: '必须提供 opId。' } });
        return;
      }
      if (tool === '__host_cancel') {
        const targetId = typeof args.requestId === 'string' ? args.requestId : requestId;
        writeFrame({ id: requestId, ok: true, result: sessionHost.requestCancel(targetId) });
        return;
      }
      if (tool === '__host_request_status') {
        const targetId = typeof args.requestId === 'string' ? args.requestId : requestId;
        const status = await sessionHost.resolveRequestStatus(targetId);
        writeFrame(status
          ? { id: requestId, ok: true, result: status }
          : { id: requestId, ok: false, error: { code: 'CLI_REQUEST_NOT_FOUND', message: `没有找到请求 ${targetId}。` } });
        return;
      }
      if (tool === '__host_close') {
        writeFrame({ id: requestId, ok: true, result: { closed: true } });
        shouldClose = true;
        input.close();
        return;
      }
      try {
        const outcome = await sessionHost.dispatch(
          { id: requestId, tool, args },
          (dispatchTool, dispatchArgs, signal) => executeToolCall(requestId, dispatchTool, dispatchArgs, signal)
        );
        if (!outcome.ok) {
          writeFrame({
            id: requestId, ok: false, error: outcome.error,
            requestState: outcome.requestState, transaction: outcome.transaction,
            ...(outcome.result !== undefined ? { result: outcome.result?.content ? parseToolContent(outcome.result.content) : outcome.result } : {})
          });
        } else {
          const result = outcome.result;
          writeFrame({
            id: requestId,
            requestState: outcome.requestState, transaction: outcome.transaction,
            ok: Boolean(result?.ok),
            ...(result?.code ? { code: result.code } : {}),
            result: parseToolContent(result?.content)
          });
        }
      } catch (error) {
        writeFrame({
          id: requestId,
          ok: false,
          error: { code: 'CLI_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) }
        });
      }
    };
    try {
      for await (const line of input) {
        if (shouldClose || line.trim() === '') continue;
        const work = handleFrame(line);
        pending.add(work);
        void work.finally(() => pending.delete(work));
      }
      await Promise.allSettled([...pending]);
    } finally {
      sessionHost.close();
      await finish(0);
    }
    return;
  }

  try {
    if (options.command === 'list' || options.command === 'ls') {
      const tools = registry.list();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      } else {
        process.stdout.write(`${tools.length} tools:\n`);
        for (const t of tools) {
          process.stdout.write(`  ${t.permissionLevel?.padEnd(6) ?? 'read  '}  ${t.name}\n`);
        }
      }
      await finish(0);
      return;
    }

    if (options.command === 'describe' || options.command === 'desc') {
      if (!options.tool) fail('describe 需要工具名');
      const tool = registry.list().find((t) => t.name === options.tool);
      if (!tool) fail(`未知工具: ${options.tool}`);
      process.stdout.write(`${JSON.stringify(tool, null, 2)}\n`);
      await finish(0);
      return;
    }

    let toolName = null;
    let args = {};

    if (options.command === 'call') {
      if (!options.tool) fail('call 需要工具名');
      toolName = options.tool;
      if (options.stdin) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        args = raw.trim() ? JSON.parse(stripJsonBom(raw)) : {};
      } else if (options.argsJson && options.argsJson.trim()) {
        args = JSON.parse(options.argsJson);
      }
    } else if (options.command === 'search-param') {
      if (!options.query) fail('search-param 需要查询词');
      toolName = 'search_param_rows';
      args = {
        query: options.query,
        ...(options.paramNames && options.paramNames.length > 0
          ? { paramNames: options.paramNames }
          : {})
      };
    } else if (options.command === 'read-param') {
      if (!options.table || !options.rowId || !options.fieldList) {
        fail('用法: read-param <table> <rowId> <field1,field2,...>');
      }
      toolName = 'read_param_fields';
      args = {
        table: options.table,
        rowIds: [Number(options.rowId)],
        fieldIds: String(options.fieldList)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      };
    } else {
      fail(`未知命令: ${options.command}（使用 --help）`);
    }

    log(`调用 ${toolName}`);
    const result = await executeToolCall(`cli-${Date.now()}`, toolName, args);

    if (options.json || options.quiet) {
      // bridge returns { ok, content, code? } where content is envelope JSON string
      if (typeof result.content === 'string') {
        process.stdout.write(`${result.content}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    } else {
      process.stdout.write(`ok=${result.ok}${result.code ? ` code=${result.code}` : ''}\n`);
      process.stdout.write(`${typeof result.content === 'string' ? result.content : JSON.stringify(result, null, 2)}\n`);
    }
    await finish(result.ok ? 0 : 2);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
    await finish(1);
  }
}

await main();

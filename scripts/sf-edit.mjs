#!/usr/bin/env node
/**
 * CLI thin client entry (single-shot + session/batch aware).
 * Logic lives in @soulforge/core; this process maps argv → production tools.
 *
 *   node scripts/sf-edit.mjs param read --table T --row-id 1 --field hp --workspace <overlay>
 *   node scripts/sf-edit.mjs tool <toolName> --json '{...}'
 *   node scripts/sf-edit.mjs batch --file <path>
 *   node scripts/sf-edit.mjs session status|close
 *   node scripts/sf-edit.mjs session --stdio
 */
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseNativeCommand } from '../packages/core/dist/cli/nativeCommandAdapter.js';
import { validateBatchFile, dispatchBatch, formatBatchSummary } from '../packages/core/dist/cli/batchDispatcher.js';
import { createLocalSessionHost } from '../packages/core/dist/cli/localSessionHost.js';

const STDIO_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const STDIO_QUEUE_LIMIT = 64;

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Never print session tokens / credentials to stdout. */
function sanitizeForStdout(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value, (key, val) => {
      if (/token|authorization|password|secret|apiKey|api_key/i.test(key)) return undefined;
      return val;
    }));
  } catch {
    return value;
  }
}

async function createRegistryExecutor(mode) {
  try {
    const core = await import('../packages/core/dist/index.js');
    const registry = typeof core.createDefaultToolRegistry === 'function'
      ? core.createDefaultToolRegistry()
      : null;
    if (!registry || typeof registry.run !== 'function') {
      return async (tool) => ({
        ok: false,
        error: {
          code: 'CLI_REGISTRY_UNAVAILABLE',
          message: `无法加载 createDefaultToolRegistry；工具 ${tool} 无法在 CLI 会话中执行。`
        }
      });
    }
    const context = {
      mode: mode ?? 'normal',
      requireProofBoundary: true
    };
    if (typeof core.NativeReadProofStore === 'function') {
      context.nativeReadProofs = new core.NativeReadProofStore({ generation: 0 });
    }
    return async (tool, args) => {
      if (typeof tool !== 'string' || tool.startsWith('session_')) {
        return {
          ok: false,
          error: {
            code: 'CLI_SESSION_CONTROL',
            message: `会话控制工具 ${tool} 由 stdio host 处理，不进入 ToolRegistry。`
          }
        };
      }
      try {
        return await registry.run(tool, args ?? {}, context);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'CLI_TOOL_EXCEPTION',
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    };
  } catch (error) {
    return async (tool) => ({
      ok: false,
      error: {
        code: 'CLI_REGISTRY_UNAVAILABLE',
        message: `加载 @soulforge/core 失败，工具 ${tool} 无法执行：${error instanceof Error ? error.message : String(error)}`
      }
    });
  }
}

function createNdjsonStdinReader({ maxFrameBytes, queueLimit, onFrame, onError }) {
  const queue = [];
  let paused = false;
  let closed = false;
  let pending = '';

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const pump = async () => {
    while (queue.length > 0 && !closed) {
      const line = queue.shift();
      try {
        await onFrame(line);
      } catch (error) {
        onError?.(error);
      }
    }
    if (paused && queue.length < queueLimit) {
      paused = false;
      rl.resume();
    }
  };

  rl.on('line', (line) => {
    if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
      onError?.(new Error(`CLI_STDIO_FRAME_TOO_LARGE: frame exceeds ${maxFrameBytes} bytes`));
      return;
    }
    pending = '';
    queue.push(line);
    if (queue.length >= queueLimit && !paused) {
      paused = true;
      rl.pause();
    }
    void pump();
  });

  rl.on('close', () => {
    closed = true;
    void pump();
  });

  return {
    waitForClose: () => new Promise((resolveClose) => {
      if (closed && queue.length === 0) resolveClose();
      else rl.once('close', () => { void pump().then(resolveClose); });
    }),
    close: () => { closed = true; rl.close(); }
  };
}

async function runSessionStdio(parsed) {
  // Token stays host-side; never printed to stdout.
  const sessionToken = randomBytes(32).toString('base64url');
  const sessionKey = process.env.SOULFORGE_CLI_SESSION_KEY
    ?? `cli-stdio-${randomBytes(8).toString('hex')}`;
  const executor = await createRegistryExecutor(parsed?.mode);
  const hostOptions = {
    sessionKey,
    modeCeiling: parsed?.mode ?? 'normal',
    execute: executor
  };
  if (process.env.SOULFORGE_CLI_OPERATION_LOG_DB) {
    hostOptions.databasePath = process.env.SOULFORGE_CLI_OPERATION_LOG_DB;
    hostOptions.workspaceId = process.env.SOULFORGE_CLI_WORKSPACE_ID ?? sessionKey;
    hostOptions.rootPath = process.env.SOULFORGE_CLI_WORKSPACE_ROOT ?? process.cwd();
    hostOptions.openSqlite = true;
  }
  let host;
  try {
    host = createLocalSessionHost(hostOptions);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'CLI_SESSION_HOST_FAILED';
    emit({
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error)
      }
    });
    process.exitCode = 1;
    return;
  }
  host.setExecutor(executor);

  let finishing = false;
  const finish = () => {
    if (finishing) return;
    finishing = true;
    try { host.close(); } catch { /* ignore */ }
    // Ensure the process exits after stdin closes.
    setTimeout(() => process.exit(process.exitCode ?? 0), 10).unref?.();
  };

  const writeLine = (payload) => {
    process.stdout.write(`${JSON.stringify(sanitizeForStdout(payload))}\n`);
  };

  const reader = createNdjsonStdinReader({
    maxFrameBytes: STDIO_MAX_FRAME_BYTES,
    queueLimit: STDIO_QUEUE_LIMIT,
    onFrame: async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        writeLine({
          ok: false,
          error: { code: 'CLI_STDIO_FRAME_INVALID', message: 'stdin NDJSON 帧不是合法 JSON。' }
        });
        return;
      }
      const id = typeof frame?.id === 'string' ? frame.id : `req-${Date.now()}`;
      const tool = typeof frame?.tool === 'string' ? frame.tool : '';
      const args = frame?.args && typeof frame.args === 'object' && !Array.isArray(frame.args)
        ? frame.args
        : {};
      if (tool === 'session_close' || tool === 'session_exit') {
        writeLine({ id, ok: true, data: { command: tool, status: 'closed' } });
        finish();
        return;
      }
      if (tool === 'session_status') {
        writeLine({
          id,
          ok: true,
          data: {
            command: tool,
            sessionKey,
            instanceId: host.instanceId,
            modeCeiling: host.modeCeiling,
            closed: host.isClosed()
          }
        });
        return;
      }
      if (!tool) {
        writeLine({ id, ok: false, error: { code: 'CLI_TOOL_NAME_REQUIRED', message: 'NDJSON 帧缺少 tool。' } });
        return;
      }
      const result = await host.handleRequest({ id, tool, args });
      writeLine({ id, result: sanitizeForStdout(result) });
    },
    onError: (error) => {
      writeLine({
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'CLI_STDIO_ERROR',
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  await reader.waitForClose();
  finish();
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseNativeCommand(argv);
  if (!parsed.ok) {
    emit({ ok: false, error: { code: parsed.code, message: parsed.message } });
    process.exitCode = 1;
    return;
  }

  const sessionEnv = process.env.SOULFORGE_CLI_SESSION === '1';

  if (parsed.tool === 'session_stdio'
    || (sessionEnv && parsed.tool.startsWith('session_') && parsed.tool !== 'session_status')) {
    await runSessionStdio(parsed);
    return;
  }

  if (parsed.tool === 'batch_dispatch') {
    const raw = JSON.parse(await readFile(resolve(String(parsed.args.file)), 'utf8'));
    const validated = validateBatchFile(raw);
    if (!validated.ok) {
      emit({ ok: false, error: { code: validated.code, message: validated.message } });
      process.exitCode = 1;
      return;
    }
    // Endpoint env is a conceptual remote host marker. Even when present this
    // thin client still runs local validate + dispatch with a registry+proof
    // executor; it never bypasses the proof boundary.
    const endpoint = process.env.SOULFORGE_CLI_SESSION_ENDPOINT;
    const executor = await createRegistryExecutor(parsed.mode);
    const result = await dispatchBatch({
      items: validated.items,
      continueOnError: Boolean(parsed.args.continueOnError),
      port: {
        execute: async (tool, args) => executor(tool, args)
      }
    });
    emit({
      ...result,
      endpoint: endpoint ? { configured: true } : { configured: false },
      summaryText: formatBatchSummary(result)
    });
    process.stdout.write(`${formatBatchSummary(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (parsed.tool.startsWith('session_')) {
    emit({
      ok: true,
      data: {
        command: parsed.tool,
        sessionName: parsed.sessionName ?? 'default',
        mode: parsed.mode ?? 'normal',
        note: '会话控制请使用 `session --stdio` 建立本地 host；本入口不打印 token，也不旁路证明边界。'
      }
    });
    return;
  }

  // Single-shot tool mapping: registry executor when SOULFORGE_CLI_SESSION=1,
  // otherwise emit the mapped production contract without side effects.
  if (sessionEnv) {
    const executor = await createRegistryExecutor(parsed.mode);
    const result = await executor(parsed.tool, parsed.args);
    emit(sanitizeForStdout(result));
    if (result?.ok === false) process.exitCode = 1;
    return;
  }

  emit({
    ok: true,
    data: {
      mappedTool: parsed.tool,
      args: parsed.args,
      mode: parsed.mode ?? 'normal',
      yes: Boolean(parsed.yes),
      sessionName: parsed.sessionName ?? 'default',
      note: '已映射到生产工具契约。实际原生读取/写入须经 ToolRegistry + 读取证明门禁；请使用 `session --stdio` 或 SOULFORGE_CLI_SESSION=1。'
    }
  });
}

void createLocalSessionHost;

main().catch((error) => {
  emit({ ok: false, error: { code: 'CLI_UNEXPECTED', message: error instanceof Error ? error.message : String(error) } });
  process.exitCode = 1;
});

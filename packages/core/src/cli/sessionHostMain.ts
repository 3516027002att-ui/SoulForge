/** T11 宿主进程入口：持有 CoreToolSession，对本机管道客户端提供统一执行。 */
import { openLocalCliSession } from './localCliSession.js';
import { startSessionDaemon } from './sessionPipeDaemon.js';

const MUTATING_PREFIXES = ['mutate_', 'apply_', 'commit_', 'import_', 'batch_'];

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const workspace = argValue(argv, 'workspace');
  if (!workspace) {
    console.error('session host 需要 --workspace。');
    process.exitCode = 1;
    return;
  }
  const sessionName = argValue(argv, 'session') ?? 'default';
  const mode = argValue(argv, 'mode') === 'plan' || argValue(argv, 'mode') === 'fullPermission'
    ? argValue(argv, 'mode') as 'plan' | 'fullPermission'
    : 'normal';
  const cliSession = await openLocalCliSession({
    overlayRoot: workspace,
    ...(argValue(argv, 'base') ? { baseRoot: argValue(argv, 'base')! } : {}),
    ...(argValue(argv, 'game') ? { game: argValue(argv, 'game')! } : {}),
    mode,
    principal: argValue(argv, 'principal') ?? 'local-cli-host',
    requireDurableLog: false,
    onFallbackWarning: (message) => console.error(message)
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    throw error;
  });
  const workspaceKey = `local|${cliSession.editSession.session.layers.overlayRoot}|${mode}`;
  let inFlight = 0;
  let lastActive = Date.now();
  const startedAt = Date.now();
  let daemon: Awaited<ReturnType<typeof startSessionDaemon>> | null = null;
  const shutdown = () => {
    clearInterval(idleTimer);
    void (async () => {
      await daemon?.close();
      await cliSession.dispose();
      process.exit(0);
    })();
  };
  daemon = await startSessionDaemon({
    workspaceId: cliSession.coreSession.workspaceId,
    workspaceKey,
    sessionName,
    principal: cliSession.coreSession.principal,
    coreSession: cliSession.coreSession,
    dispatch: async (tool, args, signal) => {
      // 会话控制命令由宿主直接处理，不进入工具注册表。
      if (tool === '__host_close') {
        shutdown();
        return { closed: true };
      }
      if (tool === '__host_status') {
        return {
          session: sessionName,
          workspace: cliSession.editSession.session.layers.overlayRoot,
          uptimeMs: Date.now() - startedAt,
          inFlight,
          durableLog: cliSession.durableLog
        };
      }
      if (!cliSession.durableLog
        && (MUTATING_PREFIXES.some((prefix) => tool.startsWith(prefix)) || tool === 'commit_patch')) {
        throw new Error('CLI_SQLITE_UNAVAILABLE: 本地审计数据库不可用，写入已失败关闭。');
      }
      inFlight += 1;
      try {
        const result = await cliSession.bridge.executeTool({
          id: `host-${Date.now()}-${tool}`,
          name: tool,
          argumentsJson: JSON.stringify(args)
        }, signal ? { signal } : {});
        lastActive = Date.now();
        return JSON.parse(result.content) as unknown;
      } finally {
        inFlight -= 1;
        lastActive = Date.now();
      }
    }
  });
  console.error(`SoulForge CLI session host ready: ${sessionName}`);
  // 空闲 10 分钟后关闭；活跃请求不计入可关闭空闲。
  const idleTimer = setInterval(() => {
    if (inFlight === 0 && Date.now() - lastActive > 10 * 60 * 1000) shutdown();
  }, 30_000);
  idleTimer.unref();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();

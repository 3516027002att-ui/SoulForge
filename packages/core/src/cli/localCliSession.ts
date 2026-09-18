/** T11 CLI 本地会话：同一进程复用 CoreToolSession；写入经统一注册表门禁。 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { analyzeWorkspace, type AnalyzeWorkspaceProgress } from '../pipeline/workspacePipeline.js';
import { nativeEditSessionFromContext, type NativeEditSession } from '../editing/nativeEditSession.js';
import { MemoryOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { openSqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import { createDefaultToolRegistry, type ToolRegistry } from '../ai/toolRegistry.js';
import { createAgentToolBridge, type AgentToolBridge } from '../ai/agentToolBridge.js';
import { CoreToolSession } from '../runtime/coreToolSession.js';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { KnowledgeStore } from '../knowledge/knowledgeStore.js';
import { SqliteKnowledgeStorePersistence } from '../knowledge/sqliteKnowledgeStore.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import {
  isNativeSemanticBundleCurrent,
  type SemanticCacheProvider
} from '../workspace/semanticFileCache.js';

export interface LocalCliSessionOptions {
  overlayRoot: string;
  baseRoot?: string;
  game?: string;
  mode?: 'plan' | 'normal' | 'fullPermission';
  principal?: string;
  /** 执行一次完整语义分析；未开启时仍完成外层扫描与引用图构建。 */
  analyze?: boolean;
  /** 复用并更新受管 workspace.db 中经过 source identity 校验的语义缓存。 */
  useCache?: boolean;
  onProgress?: (progress: AnalyzeWorkspaceProgress) => void;
  /**
   * 为 true 时 SQLite 打不开则整个会话失败（写入失败关闭）；
   * 为 false（只读命令）则退回内存日志并由调用方显式警告，不得静默。
   */
  requireDurableLog?: boolean;
  onFallbackWarning?: (message: string) => void;
}

export interface LocalCliSession {
  coreSession: CoreToolSession;
  editSession: NativeEditSession;
  registry: ToolRegistry;
  bridge: AgentToolBridge;
  workspaceIndex: WorkspaceIndex;
  durableLog: boolean;
  knowledgeStore: KnowledgeStore | null;
  dispose(): Promise<void>;
}

function cliWorkspaceRoot(workspaceId: string): string {
  const key = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(local, 'SoulForge', 'cli-workspaces', key);
}

export async function openLocalCliSession(options: LocalCliSessionOptions): Promise<LocalCliSession> {
  const session = await openWorkspaceSession({
    overlayRoot: options.overlayRoot,
    ...(options.baseRoot ? { baseRoot: options.baseRoot } : {}),
    game: options.game ?? 'sekiro'
  });
  const workspaceId = session.meta.workspaceId;
  const shouldAnalyze = options.analyze !== false;
  const useCache = options.useCache !== false && shouldAnalyze;
  const root = cliWorkspaceRoot(workspaceId);
  await mkdir(join(root, 'staging'), { recursive: true });
  await mkdir(join(root, 'backups'), { recursive: true });
  await mkdir(join(root, 'recovery'), { recursive: true });

  let semanticDatabase: ReturnType<typeof openWorkspaceDatabase> | null = null;
  let semanticCache: SemanticCacheProvider | undefined;
  if (useCache) {
    try {
      semanticDatabase = openWorkspaceDatabase(join(root, 'workspace.db'));
      const repository = new WorkspaceDataRepository(semanticDatabase, workspaceId);
      semanticCache = {
        load: (file) => {
          if (!file.sha256) return null;
          const row = repository.getSemanticFileCacheRow(file.relativePath);
          if (!row || row.resourceKind !== file.resourceKind || row.fileSha256 !== file.sha256) return null;
          try {
            const payload = JSON.parse(row.payloadJson) as import('@soulforge/shared').SymbolBundle;
            return isNativeSemanticBundleCurrent(file, payload) ? payload : null;
          } catch {
            return null;
          }
        },
        save: (file, payload) => {
          if (!file.sha256) return;
          repository.upsertSemanticFileCache({
            relativePath: file.relativePath,
            fileSha256: file.sha256,
            resourceKind: file.resourceKind,
            payload,
            mtimeMs: file.mtimeMs
          });
        }
      };
    } catch (error) {
      options.onFallbackWarning?.(
        `CLI_SEMANTIC_CACHE_UNAVAILABLE: 语义缓存数据库不可用，将执行当前会话的原生分析：${error instanceof Error ? error.message : String(error)}`
      );
      try { semanticDatabase?.close(); } catch { /* ignore */ }
      semanticDatabase = null;
    }
  }

  const scan = await scanWorkspace({
    workspaceRoot: session.layers.overlayRoot,
    game: session.meta.game,
    includeContentHashes: shouldAnalyze || Boolean(semanticCache),
    onProgress: (progress) => options.onProgress?.({
      phase: 'scan',
      current: progress.scannedFiles,
      ...(progress.currentPath ? { message: progress.currentPath } : {})
    })
  });
  let workspaceIndex = new WorkspaceIndex(workspaceId);
  workspaceIndex.setFiles(scan.files);
  if (scan.files.some((file) => file.resourceKind === 'param' || file.relativePath.toLowerCase().includes('.param'))) {
    workspaceIndex.setParamSemanticState('warming_up');
  }
  if (shouldAnalyze) {
    const analyzed = await analyzeWorkspace({
      workspaceRoot: session.layers.overlayRoot,
      files: scan.files,
      ...(semanticCache ? { semanticCache } : {}),
      inspectNativeResources: true,
      parseTextResources: true,
      ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    });
    workspaceIndex = analyzed.index;
  } else {
    workspaceIndex.rebuildReferences();
    if (workspaceIndex.getStats().paramRows > 0) workspaceIndex.setParamSemanticState('ready');
  }
  let operationLog: OperationLogStore;
  let durableLog = true;
  let knowledgeStore: KnowledgeStore | null = null;
  let knowledgeDatabase: ReturnType<typeof openWorkspaceDatabase> | null = semanticDatabase;
  try {
    operationLog = openSqliteOperationLogStore({
      databasePath: join(root, 'workspace.db'),
      workspaceId,
      rootPath: options.overlayRoot,
      game: options.game ?? 'sekiro'
    });
  } catch (error) {
    if (options.requireDurableLog === true) {
      throw new Error(`CLI_SQLITE_UNAVAILABLE: 本地审计数据库打不开，写入已失败关闭：${error instanceof Error ? error.message : String(error)}`);
    }
    durableLog = false;
    (options.onFallbackWarning ?? (() => undefined))(
      'CLI_SQLITE_FALLBACK: 本地审计数据库打不开，本次只读命令使用内存日志；写入命令将失败关闭。'
    );
    operationLog = new MemoryOperationLogStore();
  }

  if (durableLog) {
    try {
      if (!knowledgeDatabase) knowledgeDatabase = openWorkspaceDatabase(join(root, 'workspace.db'));
      knowledgeStore = new KnowledgeStore({
        persistence: new SqliteKnowledgeStorePersistence(knowledgeDatabase, {
          workspaceId,
          rootPath: session.layers.overlayRoot,
          game: session.meta.game
        }),
        schemaVersion: 'knowledge-v1'
      });
    } catch (error) {
      try { knowledgeDatabase?.close(); } catch {}
      knowledgeDatabase = null;
      options.onFallbackWarning?.(
        `KNOWLEDGE_STORE_UNAVAILABLE: 持久知识 store 打不开，本次会话不返回伪造空知识结果：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const editSession = nativeEditSessionFromContext({
    session,
    operationLog,
    backupBaseDir: join(root, 'backups'),
    recoveryDir: join(root, 'recovery'),
    stagingRoot: join(root, 'staging')
  });
  const mode = options.mode ?? 'normal';
  const coreSession = new CoreToolSession({
    principal: options.principal ?? 'local-cli',
    workspaceId,
    workspaceSession: session,
    workspaceIndex,
    editSession,
    operationLog,
    modeCeiling: mode
  });
  const registry = createDefaultToolRegistry();
  const rawBridge = createAgentToolBridge({
    registry,
    context: {
      workspaceIndex,
      mode,
      modeCeiling: mode,
      allowMemoryWrite: false,
      session,
      operationLogStore: operationLog,
      backupBaseDir: join(root, 'backups'),
      recoveryDir: join(root, 'recovery'),
      coreSession,
      ...(knowledgeStore ? { knowledgeStore } : {}),
      ...(!knowledgeStore ? { knowledgeStoreDiagnostic: 'CLI 持久知识数据库不可用。' } : {})
    }
  });
  const mutatingTools = new Set([
    'commit_patch',
    'mutate_param_fields',
    'mutate_fmg_entries',
    'apply_emevd_dsl',
    'mutate_tae_event_times',
    'mutate_tae_event_fields',
    'mutate_msb_part_transform',
    'mutate_luabnd_script',
    'batch_transform_map_objects',
    'import_map_from_blender',
    'rollback_operation'
  ]);
  const bridge: AgentToolBridge = {
    tools: rawBridge.tools,
    executeTool: async (call, contextOverride = {}) => {
      if (!durableLog && mutatingTools.has(call.name)) {
        return {
          ok: false,
          code: 'CLI_SQLITE_UNAVAILABLE',
          content: JSON.stringify({
            ok: false,
            error: { code: 'CLI_SQLITE_UNAVAILABLE', message: '本地审计数据库不可用，写入已失败关闭。' }
          })
        };
      }
      return rawBridge.executeTool(call, contextOverride);
    }
  };
  return {
    coreSession,
    editSession,
    registry,
    bridge,
    workspaceIndex,
    durableLog,
    knowledgeStore,
    dispose: async () => {
      coreSession.close();
      try { knowledgeDatabase?.close(); } catch {}
      await disposeBridgeDaemonPool();
    }
  };
}

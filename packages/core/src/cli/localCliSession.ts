/** T11 CLI 本地会话：同一进程复用 CoreToolSession；写入经统一注册表门禁。 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import { createManagedReferenceCursorStore } from '../references/referenceCursorStore.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { localApplicationDataDirectory } from '../storage/localApplicationData.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import {
  extractFileSymbolBundle,
  isNativeSemanticBundleCurrent,
  type SemanticCacheProvider
} from '../workspace/semanticFileCache.js';
import type { DiagnosticEvent } from '../diagnostics/diagnosticEvent.js';

export interface LocalCliSessionOptions {
  overlayRoot: string;
  baseRoot?: string;
  game?: string;
  mode?: 'plan' | 'normal' | 'fullPermission';
  /** Explicit, one-shot rollback authorization bound to this operation ID. */
  confirmRollbackOpId?: string;
  principal?: string;
  /** 执行一次完整语义分析；未开启时仍完成外层扫描与引用图构建。 */
  analyze?: boolean;
  /** 复用并更新受管 workspace.db 中经过 source identity 校验的语义缓存。 */
  useCache?: boolean;
  onProgress?: (progress: AnalyzeWorkspaceProgress) => void;
  onDiagnostic?: (event: DiagnosticEvent) => void;
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
  executeTool: AgentToolBridge['executeTool'];
  workspaceIndex: WorkspaceIndex;
  durableLog: boolean;
  knowledgeStore: KnowledgeStore | null;
  dispose(): Promise<void>;
}

export interface CliRollbackAuthorization {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly receipt: import('@soulforge/shared').ConfirmationReceipt;
}

type CliRollbackAuthorizationResult =
  | { ok: true; confirmation: import('@soulforge/shared').ConfirmationReceipt }
  | { ok: false; code: string; message: string };

const consumedRollbackAuthorizations = new WeakSet<object>();

export function createCliRollbackAuthorization(input: {
  operationId: string;
  workspaceId: string;
}): CliRollbackAuthorization {
  const operationId = input.operationId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!operationId || !workspaceId) throw new Error('CLI_ROLLBACK_CONFIRMATION_INPUT_INVALID');
  return Object.freeze({
    operationId,
    workspaceId,
    receipt: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${operationId}`, `ROLLBACK_WORKSPACE:${workspaceId}`],
      riskLevel: 'high',
      sourceUri: workspaceId,
      note: 'CLI --confirm-rollback 显式授权；绑定当前 workspace 与单个 operationId。',
      policyTags: ['CLI_EXPLICIT_ROLLBACK_CONFIRMATION', 'ONE_SHOT']
    })
  });
}

export function consumeCliRollbackAuthorization(
  authorization: CliRollbackAuthorization | undefined,
  operationId: string,
  workspaceId: string
): CliRollbackAuthorizationResult {
  if (!authorization) {
    return {
      ok: false,
      code: 'EDIT_CONFIRMATION_REQUIRED',
      message: 'CLI rollback 需要启动时显式提供 --confirm-rollback <opId>。'
    };
  }
  if (authorization.operationId !== operationId.trim() || authorization.workspaceId !== workspaceId.trim()) {
    return {
      ok: false,
      code: 'CLI_ROLLBACK_CONFIRMATION_MISMATCH',
      message: 'CLI rollback 确认凭据未绑定当前 workspace 或 operationId。'
    };
  }
  if (consumedRollbackAuthorizations.has(authorization)) {
    return {
      ok: false,
      code: 'CLI_ROLLBACK_CONFIRMATION_REPLAYED',
      message: 'CLI rollback 确认凭据已经使用，不能重放。'
    };
  }
  consumedRollbackAuthorizations.add(authorization);
  return { ok: true, confirmation: authorization.receipt };
}

function cliToolFailure(code: string, message: string): { ok: false; code: string; content: string } {
  return {
    ok: false,
    code,
    content: JSON.stringify({ ok: false, error: { code, message } })
  };
}

export function cliWorkspaceRoot(workspaceId: string): string {
  const key = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  // Match the production E2E host's isolated workspace database root so the
  // local CLI can inspect/recover a preserved overlay after the Electron main
  // process exits unexpectedly.
  const isolatedRoot = process.env.SF_E2E_WORKSPACE_STORAGE_ROOT?.trim();
  if (isolatedRoot) return join(resolve(isolatedRoot), key);
  const local = localApplicationDataDirectory();
  return join(local, 'SoulForge', 'cli-workspaces', key);
}

export async function openLocalCliSession(options: LocalCliSessionOptions): Promise<LocalCliSession> {
  const emit = (event: DiagnosticEvent): void => options.onDiagnostic?.(event);
  const measured = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    emit({ phase, status: 'start' });
    try {
      const result = await operation();
      emit({ phase, status: 'complete', elapsedMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      emit({
        phase,
        status: 'failed',
        elapsedMs: Date.now() - startedAt,
        details: { message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  };
  const session = await measured('workspace.open', () => openWorkspaceSession({
    overlayRoot: options.overlayRoot,
    ...(options.baseRoot ? { baseRoot: options.baseRoot } : {}),
    game: options.game ?? 'sekiro'
  }));
  const workspaceId = session.meta.workspaceId;
  const rollbackAuthorization = options.confirmRollbackOpId?.trim()
    ? createCliRollbackAuthorization({ operationId: options.confirmRollbackOpId, workspaceId })
    : undefined;
  const shouldAnalyze = options.analyze !== false;
  const useCache = options.useCache !== false && shouldAnalyze;
  const root = cliWorkspaceRoot(workspaceId);
  await mkdir(join(root, 'staging'), { recursive: true });
  await mkdir(join(root, 'backups'), { recursive: true });
  await mkdir(join(root, 'recovery'), { recursive: true });

  let semanticDatabase: ReturnType<typeof openWorkspaceDatabase> | null = null;
  let semanticCache: SemanticCacheProvider | undefined;
  let semanticCacheHits = 0;
  let semanticCacheMisses = 0;
  let semanticCacheSaves = 0;
  if (useCache) {
    try {
      semanticDatabase = openWorkspaceDatabase(join(root, 'workspace.db'));
      const repository = new WorkspaceDataRepository(semanticDatabase, workspaceId);
      semanticCache = {
        load: (file) => {
          if (!file.sha256) {
            semanticCacheMisses += 1;
            return null;
          }
          const row = repository.getSemanticFileCacheRow(file.relativePath);
          if (!row || row.resourceKind !== file.resourceKind || row.fileSha256 !== file.sha256) {
            semanticCacheMisses += 1;
            return null;
          }
          try {
            const payload = JSON.parse(row.payloadJson) as import('@soulforge/shared').SymbolBundle;
            if (!isNativeSemanticBundleCurrent(file, payload)) {
              semanticCacheMisses += 1;
              return null;
            }
            semanticCacheHits += 1;
            return payload;
          } catch {
            semanticCacheMisses += 1;
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
          semanticCacheSaves += 1;
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

  const scan = await measured('workspace.scan', () => scanWorkspace({
    workspaceRoot: session.layers.overlayRoot,
    game: session.meta.game,
    includeContentHashes: shouldAnalyze || Boolean(semanticCache),
    onProgress: (progress) => options.onProgress?.({
      phase: 'scan',
      current: progress.scannedFiles,
      ...(progress.currentPath ? { message: progress.currentPath } : {})
    })
  }));
  let workspaceIndex = new WorkspaceIndex(workspaceId);
  workspaceIndex.setFiles(scan.files);
  if (scan.files.some((file) => file.resourceKind === 'param' || file.relativePath.toLowerCase().includes('.param'))) {
    workspaceIndex.setParamSemanticState('warming_up');
  }
  if (shouldAnalyze) {
    const analyzed = await measured('workspace.analyze', () => analyzeWorkspace({
      workspaceRoot: session.layers.overlayRoot,
      files: scan.files,
      ...(semanticCache ? { semanticCache } : {}),
      inspectNativeResources: true,
      parseTextResources: true,
      ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    }));
    workspaceIndex = analyzed.index;
    const counts = workspaceIndex.getStats();
    const paramUnavailable = scan.files.some(file => file.resourceKind === 'param') && counts.paramRows === 0;
    const analysisDiagnostics = analyzed.diagnostics.slice(0, 32).map(diagnostic => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, 512),
      ...(diagnostic.sourceUri ? {sourceUri: diagnostic.sourceUri.slice(0, 1024)} : {})
    }));
    emit({phase: 'workspace.analyze.summary', status: paramUnavailable ? 'failed' : 'complete', details: {
      parsedFiles: analyzed.parsedFiles, inspectedFiles: analyzed.inspectedFiles, counts,
      diagnostics: analysisDiagnostics, diagnosticCount: analyzed.diagnostics.length,
      diagnosticsTruncated: analyzed.diagnostics.length > analysisDiagnostics.length
    }});
    if (paramUnavailable) {
      const cause = analysisDiagnostics[0];
      options.onFallbackWarning?.(`CLI_PARAM_SEMANTICS_UNAVAILABLE: 工作区分析未建立 PARAM 行索引；`
        + (cause ? `${cause.code}: ${cause.message}` : '没有可用语义导出。')
        + ' 此状态不能作为成功分析或任务完成证据；可用的独立原生读取仍保留。');
    }
  } else {
    workspaceIndex.rebuildReferences();
    if (workspaceIndex.getStats().paramRows > 0) workspaceIndex.setParamSemanticState('ready');
    emit({ phase: 'workspace.index', status: 'complete', details: { analyzed: false } });
  }
  emit({
    phase: 'semantic.cache',
    status: 'complete',
    details: {
      enabled: Boolean(semanticCache),
      hits: semanticCacheHits,
      misses: semanticCacheMisses,
      saves: semanticCacheSaves
    }
  });
  let operationLog: OperationLogStore;
  let closeOwnedOperationLog: (() => void) | undefined;
  let durableLog = true;
  let knowledgeStore: KnowledgeStore | null = null;
  let knowledgeDatabase: ReturnType<typeof openWorkspaceDatabase> | null = semanticDatabase;
  try {
    const ownedOperationLog = openSqliteOperationLogStore({
      databasePath: join(root, 'workspace.db'),
      workspaceId,
      rootPath: options.overlayRoot,
      game: options.game ?? 'sekiro'
    });
    operationLog = ownedOperationLog;
    closeOwnedOperationLog = () => ownedOperationLog.close();
    emit({phase:'storage.audit',status:'complete',details:{durableLog:true}});
  } catch (error) {
    const cause = {code: typeof (error as {code?:unknown})?.code === 'string'
      ? (error as {code:string}).code : 'SQLITE_DATABASE_OPEN_FAILED',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1024)};
    emit({phase:'storage.audit',status:'failed',details:{...cause,durableLog:false}});
    if (options.requireDurableLog === true) {
      throw new Error(`CLI_SQLITE_UNAVAILABLE: 本地审计数据库打不开，写入已失败关闭：${error instanceof Error ? error.message : String(error)}`);
    }
    durableLog = false;
    (options.onFallbackWarning ?? (() => undefined))(
      `CLI_SQLITE_FALLBACK: ${cause.code}: ${cause.message}；本次只读命令使用内存日志；写入命令将失败关闭。`
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
      referenceCursorStore: createManagedReferenceCursorStore(root),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      onSemanticEvidenceUpdated: async (sourceUris) => {
        if (!semanticCache || !sourceUris?.length) return;
        const files = workspaceIndex.getFiles();
        const sources = new Set(sourceUris.map((sourceUri) => (
          workspaceIndex.getFile(sourceUri)?.sourceUri
            ?? files.find((file) => file.absolutePath === sourceUri)?.sourceUri
            ?? sourceUri
        )));
        for (const file of files) {
          if (!sources.has(file.sourceUri)) continue;
          const bundle = extractFileSymbolBundle(workspaceIndex, file.sourceUri);
          if (isNativeSemanticBundleCurrent(file, bundle)) await semanticCache.save(file, bundle);
        }
      },
      ...(knowledgeStore ? { knowledgeStore } : {}),
      ...(!knowledgeStore ? { knowledgeStoreDiagnostic: 'CLI 持久知识数据库不可用。' } : {})
    }
  });
  const mutatingTools = new Set(registry.list().filter(tool => tool.effect === 'write' || tool.effect === 'rollback').map(tool => tool.name));

  const executeTool: AgentToolBridge['executeTool'] = async (call, contextOverride = {}) => {
    if (!durableLog && mutatingTools.has(call.name)) {
      return cliToolFailure('CLI_SQLITE_UNAVAILABLE', '本地审计数据库不可用，写入已失败关闭。');
    }
    if (call.name !== 'rollback_operation') return rawBridge.executeTool(call, contextOverride);

    let input: unknown;
    try {
      input = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson);
    } catch {
      return rawBridge.executeTool(call, contextOverride);
    }
    const operationId = input && typeof input === 'object' && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).opId === 'string'
      ? ((input as Record<string, unknown>).opId as string).trim()
      : '';
    if (!operationId) return rawBridge.executeTool(call, contextOverride);

    const authorization = consumeCliRollbackAuthorization(rollbackAuthorization, operationId, workspaceId);
    if (!authorization.ok) return cliToolFailure(authorization.code, authorization.message);
    let record;
    try {
      record = await operationLog.get(operationId);
    } catch (error) {
      return cliToolFailure(
        'CLI_ROLLBACK_CONFIRMATION_UNAVAILABLE',
        `无法核对 rollback operation 所属 workspace：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!record || record.workspaceId !== workspaceId) {
      return cliToolFailure(
        'CLI_ROLLBACK_CONFIRMATION_MISMATCH',
        'rollback operation 不存在于当前 workspace，已拒绝使用 CLI 确认凭据。'
      );
    }
    return rawBridge.executeTool(call, { ...contextOverride, confirmation: authorization.confirmation });
  };
  const bridge: AgentToolBridge = { tools: rawBridge.tools, executeTool };
  return {
    coreSession,
    editSession,
    registry,
    bridge,
    executeTool,
    workspaceIndex,
    durableLog,
    knowledgeStore,
    dispose: async () => {
      try {
        coreSession.close();
        await disposeBridgeDaemonPool();
      } finally {
        try { knowledgeDatabase?.close(); } catch {}
        closeOwnedOperationLog?.();
      }
    }
  };
}

/** T03 两端共用工具运行时：持有工作区运行时，构造一次，关闭一次。 */
import { pathToFileURL } from 'node:url';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { MemoryOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import { createNativeReadProofStore, type NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import { NativeSnapshotCache } from './nativeSnapshotCache.js';
import { NativeSourceWatcher } from './nativeSourceWatcher.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export interface SavedReferencePage {
  relations: Array<Record<string, unknown>>;
  offset: number;
  generation: number;
  scope?: string;
  state?: {
    target?: string;
    targetRead?: unknown;
    coverage?: Record<string, unknown>;
    diagnostics?: string[];
    nextActions?: Array<{ tool: string; args: Record<string, unknown> }>;
  };
}

export interface CoreToolSessionOptions {
  principal: string;
  workspaceId: string;
  workspaceSession?: WorkspaceSession;
  workspaceIndex?: WorkspaceIndex;
  editSession?: NativeEditSession;
  operationLog?: OperationLogStore;
  modeCeiling?: 'plan' | 'normal' | 'fullPermission';
}

export class CoreToolSession {
  readonly principal: string;
  readonly workspaceId: string;
  readonly workspaceSession: WorkspaceSession | undefined;
  readonly workspaceIndex: WorkspaceIndex;
  readonly editSession: NativeEditSession | undefined;
  readonly snapshotCache: NativeSnapshotCache;
  readonly proofStore: NativeReadProofStore;
  readonly operationLog: OperationLogStore;
  readonly modeCeiling: 'plan' | 'normal' | 'fullPermission';
  private closed = false;
  private generation = 0;
  private pages = new Map<string, SavedReferencePage>();
  private pageCounter = 0;
  private sourceWatcher: NativeSourceWatcher | null = null;

  constructor(options: CoreToolSessionOptions) {
    this.principal = options.principal;
    this.workspaceId = options.workspaceId;
    this.workspaceSession = options.workspaceSession;
    this.workspaceIndex = options.workspaceIndex ?? new WorkspaceIndex(options.workspaceId);
    this.editSession = options.editSession;
    this.snapshotCache = new NativeSnapshotCache();
    this.proofStore = createNativeReadProofStore();
    this.operationLog = options.operationLog ?? new MemoryOperationLogStore();
    this.modeCeiling = options.modeCeiling ?? 'normal';
  }

  /** 同一主体的长期 edit session：不再为每个工具调用新建 handle Map。 */
  requireEditSession(): NativeEditSession {
    if (!this.editSession) throw new Error('CORE_SESSION_NO_EDIT_SESSION');
    return this.editSession;
  }

  /** 外层文件变化：一次失效其所有 child、快照、证明、关联分片与页会话（§400）。 */
  invalidateSource(outerSourceKey: string): void {
    this.generation += 1;
    this.snapshotCache.invalidateOuter(outerSourceKey);
    this.proofStore.invalidateSource(outerSourceKey, this.generation);
    // 页游标凭世代失配拒绝（不清表，保留更明确的 SCOPE_MISMATCH 而非 EXPIRED）。
    this.workspaceIndex.invalidateSource(outerSourceKey);
  }

  /**
   * 已知绝对路径的外层文件变化：双键失效（原始串＋file:// 形），与提交路径一致。
   * 监听器回调与未来调用方统一走这里，不各自拼 key。
   */
  invalidateOuterFile(absolutePath: string): void {
    this.invalidateSource(absolutePath);
    if (!absolutePath.includes('://')) {
      try {
        this.invalidateSource(pathToFileURL(absolutePath).href);
      } catch {
        // 保留原始串失效；路径转换失败不掩盖失效本身。
      }
    }
  }

  /**
   * 注册已知 canonical 外层文件的外部变化监听（宿主在打开文件时注册）。
   * 变化即走 invalidateOuterFile 全扇出；会话关闭时一并释放监听器。
   */
  watchOuterFile(absolutePath: string, pollIntervalMs?: number): void {
    if (this.closed) throw new Error('CORE_SESSION_CLOSED');
    if (!this.sourceWatcher) {
      this.sourceWatcher = new NativeSourceWatcher({
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
        onEvent: (event) => {
          if (!this.closed) this.invalidateOuterFile(event.absolutePath);
        }
      });
    }
    this.sourceWatcher.watch(absolutePath);
  }

  /** 关联页续查：保存已确认排序前缀与页基准态，游标只在本会话本世代有效。 */
  saveReferencePage(
    relations: Array<Record<string, unknown>>,
    offset: number,
    scope?: string,
    state?: SavedReferencePage['state']
  ): string {
    if (this.closed) throw new Error('CORE_SESSION_CLOSED');
    this.pageCounter += 1;
    const cursor = `pg-${this.pageCounter}`;
    this.pages.set(cursor, {
      relations, offset, generation: this.generation,
      ...(scope === undefined ? {} : { scope }),
      ...(state === undefined ? {} : { state })
    });
    return cursor;
  }

  loadReferencePage(cursor: string): SavedReferencePage | null {
    if (this.closed) return null;
    return this.pages.get(cursor) ?? null;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sourceWatcher?.close();
    this.sourceWatcher = null;
    this.snapshotCache.dispose();
    this.proofStore.invalidateAll('session-close');
    this.proofStore.dispose();
    this.pages.clear();
  }
}


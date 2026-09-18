/**
 * Long-lived core tool runtime shared by desktop Agent and local CLI sessions.
 * Holds workspace, index, edit session, snapshot cache, reference service and proofs.
 */
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import {
  createNativeSnapshotCache,
  type NativeSnapshotCache,
  type NativeSnapshotCounters
} from './nativeSnapshotCache.js';
import { ResourceVersionClock } from './resourceVersion.js';
import { NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import type { ReferenceQueryService } from '../references/referenceQueryService.js';
import { createReferenceQueryService } from '../references/referenceQueryService.js';
import type { WorkspaceReferenceRuntime } from '../references/workspaceReferenceRuntime.js';
import type { KnowledgeStoreLike } from '../knowledge/knowledgeStore.js';

export interface CoreToolSessionOptions {
  principal: string;
  workspaceId: string;
  session: WorkspaceSession;
  editSession: NativeEditSession;
  workspaceIndex?: unknown;
  operationLog: OperationLogStore;
  modeCeiling?: 'plan' | 'normal' | 'fullPermission';
  counters?: NativeSnapshotCounters;
  /** Host-resolved reference ports. CLI and desktop must use the same runtime. */
  referenceRuntime?: WorkspaceReferenceRuntime;
  knowledgeStore?: KnowledgeStoreLike;
}

export class CoreToolSession {
  readonly principal: string;
  readonly workspaceId: string;
  readonly session: WorkspaceSession;
  readonly editSession: NativeEditSession;
  readonly workspaceIndex?: unknown;
  readonly operationLog: OperationLogStore;
  readonly modeCeiling: 'plan' | 'normal' | 'fullPermission';
  readonly snapshotCache: NativeSnapshotCache;
  readonly versionClock = new ResourceVersionClock();
  readonly nativeReadProofs: NativeReadProofStore;
  readonly referenceService: ReferenceQueryService;
  readonly knowledgeStore: KnowledgeStoreLike | undefined;
  private closed = false;

  constructor(options: CoreToolSessionOptions) {
    this.principal = options.principal;
    this.workspaceId = options.workspaceId;
    this.session = options.session;
    this.editSession = options.editSession;
    this.workspaceIndex = options.workspaceIndex;
    this.operationLog = options.operationLog;
    this.modeCeiling = options.modeCeiling ?? 'normal';
    this.knowledgeStore = options.knowledgeStore;
    this.snapshotCache = createNativeSnapshotCache(options.counters ? { counters: options.counters } : {});
    this.nativeReadProofs = new NativeReadProofStore({ generation: this.versionClock.current() });
    this.referenceService = createReferenceQueryService({
      principal: this.principal,
      workspaceId: this.workspaceId,
      workspaceSession: this.session,
      editSession: this.editSession,
      workspaceIndex: this.workspaceIndex,
      snapshotCache: this.snapshotCache,
      versionClock: this.versionClock,
      nativeReadProofs: this.nativeReadProofs,
      ...(options.referenceRuntime
        ? {
            resolveTarget: options.referenceRuntime.resolveTarget,
            readTargetFields: options.referenceRuntime.readTargetFields,
            providerPorts: options.referenceRuntime.providerPorts,
            indexReferenceProvider: options.referenceRuntime.indexReferenceProvider,
            resolveUriIdentity: options.referenceRuntime.resolveUriIdentity,
            coverageProvider: options.referenceRuntime.coverageProvider
          }
        : {})
    });
  }

  requireEditSession(): NativeEditSession {
    if (this.closed) throw new Error('CORE_TOOL_SESSION_CLOSED');
    return this.editSession;
  }

  invalidateSource(sourceKey: string): void {
    const generation = this.versionClock.bump();
    this.snapshotCache.invalidateSource(sourceKey);
    this.nativeReadProofs.invalidateSource(sourceKey, generation);
    this.nativeReadProofs.setGeneration(generation);
    this.referenceService.invalidateSource(sourceKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.nativeReadProofs.dispose();
    void this.snapshotCache.dispose();
  }
}

export function createCoreToolSession(options: CoreToolSessionOptions): CoreToolSession {
  return new CoreToolSession(options);
}

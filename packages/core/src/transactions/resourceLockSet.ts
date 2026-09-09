/**
 * SF-12 ResourceLockSet
 *
 * 资源锁集合与宿主级锁协调机制：
 * 1. 锁键由 workspaceId 与规范化 canonicalOuterId 组成。
 * 2. 依赖资源申请 shared (读) 锁，写目标申请 exclusive (写) 锁。
 * 3. 同一锁键的 R/W 请求在入锁前静态合并为 W (exclusive)，禁止运行中锁升级。
 * 4. 全部锁在进入临界区前按键名严格字典序排序后依次获取，杜绝循环等待死锁。
 * 5. 支持获取超时与主动释放。
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export type ResourceLockMode = 'shared' | 'exclusive';

export interface ResourceLockRequest {
  key: string;
  mode: ResourceLockMode;
  resourceUri?: string;
}

export interface ResourceLockLease {
  leaseId: string;
  workspaceId: string;
  acquiredKeys: string[];
  heldModes: ReadonlyMap<string, ResourceLockMode>;
  released: boolean;
  release(): Promise<void>;
}

export interface ResourceLockOptions {
  timeoutMs?: number;
}

/**
 * 由 workspaceId 与 outer 目标绝对路径规范化生成锁键。
 */
export function canonicalLockKey(workspaceId: string, canonicalOuterPathOrId: string): string {
  const norm = resolve(canonicalOuterPathOrId).replaceAll('\\', '/').toLowerCase();
  return `${workspaceId}:${norm}`;
}

/**
 * 静态合并 R/W 锁请求：同键 R+W -> W，并按键字典序排序。
 */
export function normalizeLockRequests(requests: readonly ResourceLockRequest[]): ResourceLockRequest[] {
  const byKey = new Map<string, { mode: ResourceLockMode; resourceUri?: string | undefined }>();
  for (const req of requests) {
    const existing = byKey.get(req.key);
    if (!existing) {
      byKey.set(req.key, {
        mode: req.mode,
        ...(req.resourceUri !== undefined ? { resourceUri: req.resourceUri } : {})
      });
    } else {
      if (req.mode === 'exclusive' || existing.mode === 'exclusive') {
        existing.mode = 'exclusive';
      }
      if (!existing.resourceUri && req.resourceUri !== undefined) {
        existing.resourceUri = req.resourceUri;
      }
    }
  }

  const sortedKeys = Array.from(byKey.keys()).sort((a, b) => a.localeCompare(b));
  return sortedKeys.map((key) => {
    const entry = byKey.get(key)!;
    return {
      key,
      mode: entry.mode,
      ...(entry.resourceUri !== undefined ? { resourceUri: entry.resourceUri } : {})
    };
  });
}

/**
 * 在已静态合并、排序的锁集合内执行一次临界区。调用方不会拿到可以升级的
 * 中间句柄；任一锁失败会在回调前释放已经取得的前缀锁。
 */
export async function withResourceLocks<T>(
  manager: ResourceLockManager,
  workspaceId: string,
  requests: readonly ResourceLockRequest[],
  work: (lease: ResourceLockLease) => Promise<T>,
  options: ResourceLockOptions = {}
): Promise<T> {
  const normalized = normalizeLockRequests(requests);
  const lease = await manager.acquireLocks(workspaceId, normalized, options);
  try {
    return await work(lease);
  } finally {
    await lease.release();
  }
}

interface Waiter {
  leaseId: string;
  mode: ResourceLockMode;
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout | undefined;
}

interface LockState {
  exclusiveHolder: string | null;
  sharedHolders: Set<string>;
  waitingQueue: Waiter[];
}

export class ResourceLockManager {
  private static instance: ResourceLockManager | undefined;
  private readonly locks = new Map<string, LockState>();

  static getInstance(): ResourceLockManager {
    if (!ResourceLockManager.instance) {
      ResourceLockManager.instance = new ResourceLockManager();
    }
    return ResourceLockManager.instance;
  }

  static resetInstance(): void {
    ResourceLockManager.instance = undefined;
  }

  private getOrCreateLockState(key: string): LockState {
    let state = this.locks.get(key);
    if (!state) {
      state = {
        exclusiveHolder: null,
        sharedHolders: new Set(),
        waitingQueue: []
      };
      this.locks.set(key, state);
    }
    return state;
  }

  /**
   * 按照全局字典序获取一组资源的锁。如果任一锁在指定超时内获取失败，
   * 则释放所有已持有的锁并抛出异常。
   */
  async acquireLocks(
    workspaceId: string,
    requests: readonly ResourceLockRequest[],
    options: ResourceLockOptions = {}
  ): Promise<ResourceLockLease> {
    const normalized = normalizeLockRequests(requests);
    const leaseId = randomUUID();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const acquiredKeys: string[] = [];
    const heldModes = new Map<string, ResourceLockMode>();

    try {
      for (const req of normalized) {
        await this.acquireSingleLock(leaseId, req.key, req.mode, timeoutMs);
        acquiredKeys.push(req.key);
        heldModes.set(req.key, req.mode);
      }
    } catch (error) {
      // 回滚已获得的锁
      for (const key of acquiredKeys) {
        this.releaseSingleLock(leaseId, key, heldModes.get(key)!);
      }
      throw error;
    }

    let released = false;
    const lease: ResourceLockLease = {
      leaseId,
      workspaceId,
      acquiredKeys: [...acquiredKeys],
      heldModes,
      get released() {
        return released;
      },
      release: async () => {
        if (released) return;
        released = true;
        // 释放顺序反向
        for (let i = acquiredKeys.length - 1; i >= 0; i--) {
          const key = acquiredKeys[i]!;
          const mode = heldModes.get(key)!;
          this.releaseSingleLock(leaseId, key, mode);
        }
      }
    };

    return lease;
  }

  private acquireSingleLock(
    leaseId: string,
    key: string,
    mode: ResourceLockMode,
    timeoutMs: number
  ): Promise<void> {
    const state = this.getOrCreateLockState(key);

    const canAcquireNow =
      mode === 'shared'
        ? state.exclusiveHolder === null && state.waitingQueue.length === 0
        : state.exclusiveHolder === null && state.sharedHolders.size === 0 && state.waitingQueue.length === 0;

    if (canAcquireNow) {
      if (mode === 'shared') {
        state.sharedHolders.add(leaseId);
      } else {
        state.exclusiveHolder = leaseId;
      }
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          // 超时清理
          const idx = state.waitingQueue.findIndex((w) => w.leaseId === leaseId && w.mode === mode);
          if (idx !== -1) {
            state.waitingQueue.splice(idx, 1);
          }
          const err = Object.assign(
            new Error(`LOCK_ACQUISITION_TIMEOUT: 超时 (${timeoutMs}ms) 无法获取锁: ${key} [${mode}]`),
            { code: 'LOCK_ACQUISITION_TIMEOUT', lockKey: key, lockMode: mode }
          );
          reject(err);
        }, timeoutMs);
      }

      state.waitingQueue.push({
        leaseId,
        mode,
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
        timer
      });
    });
  }

  private releaseSingleLock(leaseId: string, key: string, mode: ResourceLockMode): void {
    const state = this.locks.get(key);
    if (!state) return;

    if (mode === 'exclusive') {
      if (state.exclusiveHolder === leaseId) {
        state.exclusiveHolder = null;
      }
    } else {
      state.sharedHolders.delete(leaseId);
    }

    this.processQueue(key, state);

    if (state.exclusiveHolder === null && state.sharedHolders.size === 0 && state.waitingQueue.length === 0) {
      this.locks.delete(key);
    }
  }

  private processQueue(key: string, state: LockState): void {
    if (state.waitingQueue.length === 0) return;

    const next = state.waitingQueue[0];
    if (!next) return;

    if (next.mode === 'exclusive') {
      if (state.exclusiveHolder === null && state.sharedHolders.size === 0) {
        state.waitingQueue.shift();
        state.exclusiveHolder = next.leaseId;
        next.resolve();
      }
    } else {
      if (state.exclusiveHolder === null) {
        while (state.waitingQueue.length > 0 && state.waitingQueue[0]?.mode === 'shared') {
          const waiter = state.waitingQueue.shift()!;
          state.sharedHolders.add(waiter.leaseId);
          waiter.resolve();
        }
      }
    }
  }
}

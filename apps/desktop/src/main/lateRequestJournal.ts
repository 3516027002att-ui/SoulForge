/**
 * 超时请求的结局台账（#42）。
 *
 * 调用方超时只说明"没收到回执"，不说明"没执行"。上游的 client 已经有
 * `lateRequests`（记录已派发但超时的请求）与 `late-completion` 轨迹，但那只写进
 * diagnostics，调用方拿不到结论。这里把"结局"变成可查询的状态。
 *
 * 抽成纯模块的原因：`OperationLogUtilityClient` 依赖 Electron 的 `utilityProcess`，
 * 在纯 node 里构造不起来；把状态机拿出来才能直跑单测。
 */

export type LateRequestOutcome = 'ok' | 'request-failed';

export interface LateRequestState {
  requestId: string;
  method: string;
  /** pending：超时了但 worker 还没回；completed：迟到响应已回来，看 outcome。 */
  state: 'pending' | 'completed';
  outcome: LateRequestOutcome | null;
  errorCode?: string;
}

export interface LateRequestQuery {
  requestId: string;
  /**
   * `unknown` 表示没有这条记录（从未超时，或已被上限淘汰）。它**不能**当作
   * "没执行"——真正的权威是 worker 的库状态，这里只回答已知的结局。
   */
  state: 'pending' | 'completed' | 'unknown';
  outcome: LateRequestOutcome | null;
  method: string | null;
  errorCode?: string;
}

const DEFAULT_CAPACITY = 256;

export class LateRequestJournal {
  /** Map 保持插入顺序：最早插入的排在最前，淘汰时删它。 */
  private readonly entries = new Map<string, LateRequestState>();

  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** 记录一次超时（请求已派发但没回执）。重复调用不改变已有结局。 */
  record(requestId: string, method: string): void {
    const existing = this.entries.get(requestId);
    if (existing) {
      // 已结算的结局不能被后来的超时覆盖。
      this.entries.delete(requestId);
      this.entries.set(requestId, existing);
      return;
    }
    this.entries.set(requestId, {
      requestId,
      method,
      state: 'pending',
      outcome: null
    });
    this.evict();
  }

  /**
   * 迟到响应回来时落结局。
   *
   * 返回 `false` 表示台账里没有这条记录（超时记录已被淘汰，或该请求从未超时）——
   * 调用方仍可据此打 trace，但不要凭它判定"没写"。
   */
  settle(requestId: string, outcome: LateRequestOutcome, errorCode?: string): boolean {
    const existing = this.entries.get(requestId);
    if (!existing) return false;
    this.entries.delete(requestId);
    this.entries.set(requestId, {
      ...existing,
      state: 'completed',
      outcome,
      ...(errorCode ? { errorCode } : {})
    });
    return true;
  }

  query(requestId: string): LateRequestQuery {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return { requestId, state: 'unknown', outcome: null, method: null };
    }
    return {
      requestId,
      state: entry.state,
      outcome: entry.outcome,
      method: entry.method,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {})
    };
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

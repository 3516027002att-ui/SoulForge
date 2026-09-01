/**
 * 合并 Agent 推送与回放时的会话内排序/去重。
 *
 * 实时 IPC 与 replay IPC 可能交错到达，不能用「当前最大 seq」作为水位：
 * 如果 seq=5 先到，随后回放的 seq=1..4 会被错误丢掉。这里显式维护已应用
 * 的序号集合，允许乱序补齐，同时限制集合大小，避免长会话在 renderer 中增长。
 */
export interface AgentEventEnvelopeLike {
  sessionId: string;
  seq: number;
}

export interface OrderedAgentEvents<T extends AgentEventEnvelopeLike> {
  events: T[];
  seen: Set<number>;
}

export function orderUnseenAgentEvents<T extends AgentEventEnvelopeLike>(
  envelopes: readonly T[],
  sessionId: string,
  seen: ReadonlySet<number> = new Set<number>(),
  limit = 4096
): OrderedAgentEvents<T> {
  const candidates = new Map<number, T>();
  for (const envelope of envelopes) {
    if (envelope.sessionId !== sessionId) continue;
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) continue;
    if (seen.has(envelope.seq) || candidates.has(envelope.seq)) continue;
    candidates.set(envelope.seq, envelope);
  }

  const events = [...candidates.values()].sort((left, right) => left.seq - right.seq);
  const nextSeen = new Set(seen);
  for (const event of events) nextSeen.add(event.seq);
  const safeLimit = Math.max(1, Math.trunc(limit));
  while (nextSeen.size > safeLimit) {
    const oldest = Math.min(...nextSeen);
    nextSeen.delete(oldest);
  }
  return { events, seen: nextSeen };
}

/**
 * Append-only session rollout recorder (Codex rollout crate design, minimized).
 * Design derived from openai/codex (Apache-2.0, Copyright 2025 OpenAI) —
 * rollout/recorder.rs single-writer model, tolerant resume parsing and
 * marker-based rollback. See licenses/openai-codex.txt.
 *
 * Preserved Codex semantics:
 * - JSONL, first line is session meta
 * - single logical writer: enqueue() is sync, I/O is serialized behind a
 *   drain promise (Codex's dedicated writer task + command channel)
 * - flush() is a barrier that waits for all queued items to land
 * - storage failures enter recovery mode: pending items are retained and
 *   retried at the next drain instead of being lost
 * - resume tolerates malformed lines (parse_errors counted, never fatal)
 * - rollback never deletes durable lines — a rollback marker truncates
 *   logically at parse time
 * Divergence: no zstd compression, no sqlite index, no reverse scanner —
 * storage is an injected interface so callers choose the location
 * (never the Mod workspace).
 */

import type { ChatMessage, RolloutItem, RolloutSessionMeta, RolloutSink } from './types.js';
import { redactSecrets } from './agentLoop.js';

export interface RolloutStorage {
  appendLines(lines: string[]): Promise<void>;
  readLines(): Promise<string[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryRolloutStorage implements RolloutStorage {
  private readonly stored: string[] = [];
  private closed = false;

  async appendLines(lines: string[]): Promise<void> {
    if (this.closed) throw new Error('ROLLOUT_STORAGE_CLOSED: 存储已关闭。');
    this.stored.push(...lines);
  }

  async readLines(): Promise<string[]> {
    return [...this.stored];
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }

  get lines(): string[] {
    return [...this.stored];
  }
}

function redactMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: redactSecrets(message.content),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            argumentsJson: redactSecrets(call.argumentsJson)
          }))
        }
      : {})
  };
}

function redactItem(item: RolloutItem): RolloutItem {
  if (item.type !== 'message') return item;
  return { ...item, message: redactMessage(item.message) };
}

export class RolloutRecorder implements RolloutSink {
  private readonly storage: RolloutStorage;
  private readonly meta: RolloutSessionMeta;
  private queue: RolloutItem[] = [];
  private drainChain: Promise<void> = Promise.resolve();
  private metaWritten = false;
  private closed = false;
  /** Last storage failure; retained items are retried on the next drain. */
  lastError: string | null = null;

  constructor(storage: RolloutStorage, meta: RolloutSessionMeta) {
    this.storage = storage;
    this.meta = meta;
  }

  enqueue(item: RolloutItem): void {
    if (this.closed) return;
    this.queue.push(redactItem(item));
    this.drainChain = this.drainChain.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    const lines: string[] = [];
    if (!this.metaWritten) {
      const metaItem: RolloutItem = { type: 'session-meta', meta: this.meta };
      lines.push(JSON.stringify(metaItem));
    }
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) {
      lines.push(JSON.stringify(item));
    }
    if (lines.length === 0) return;
    try {
      await this.storage.appendLines(lines);
      this.metaWritten = true;
      this.lastError = null;
    } catch (error) {
      // Recovery mode: keep everything unwritten for the next barrier.
      this.queue = [...pending, ...this.queue];
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async flush(): Promise<void> {
    await this.drainChain;
    try {
      await this.storage.flush();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.storage.close();
  }
}

export interface ResumedRollout {
  meta: RolloutSessionMeta | null;
  messages: ChatMessage[];
  /** Highest recorded step, 0 when no message items exist. */
  steps: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  providerUsage?: {
    calls: number;
    reportedCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    lastContextTokens: number | null;
  };
  /** Last durable terminal record; absent for legacy/in-progress rollouts. */
  terminal?: Extract<RolloutItem, { type: 'turn-complete' }> | null;
}

/**
 * Rollback a parsed message list to the last `keepLastUserTurns` user turns.
 * A turn boundary is a user message; everything from that boundary onward is
 * kept. With no user messages the full list is kept unchanged.
 */
export function truncateToLastUserTurns(messages: ChatMessage[], keepLastUserTurns: number): ChatMessage[] {
  if (keepLastUserTurns <= 0) return [];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') {
      seen += 1;
      if (seen >= keepLastUserTurns) {
        return messages.slice(index);
      }
    }
  }
  return messages;
}

/**
 * Parse rollout JSONL lines back into a resumable history. Malformed lines are
 * counted, never fatal. A trailing rollback marker truncates logically;
 * durable lines are never rewritten.
 */
export function parseRolloutLines(lines: string[]): ResumedRollout {
  let meta: RolloutSessionMeta | null = null;
  let parseErrors = 0;
  let interrupted = false;
  let compactedWindows = 0;
  let steps = 0;
  let rollbackKeep: number | null = null;
  let terminal: Extract<RolloutItem, { type: 'turn-complete' }> | null = null;
  const providerUsage = {
    calls: 0,
    reportedCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastContextTokens: null as number | null
  };
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let item: RolloutItem;
    try {
      item = JSON.parse(trimmed) as RolloutItem;
    } catch {
      parseErrors += 1;
      continue;
    }
    switch (item.type) {
      case 'session-meta':
        if (!meta) meta = item.meta;
        break;
      case 'message':
        messages.push(item.message);
        steps = Math.max(steps, item.step);
        break;
      case 'interrupted':
        interrupted = true;
        break;
      case 'compacted':
        compactedWindows += 1;
        // 压缩标记携带替换历史（新格式）：从该点起历史 = 压缩后的窗口内容，
        // 后续 message 条目继续追加。旧格式（无 replacementHistory）只计数，
        // 保持历史原样 —— 旧会话 resume 不会崩，只是无法回退到压缩窗口。
        if (item.replacementHistory && item.replacementHistory.length > 0) {
          messages.length = 0;
          messages.push(...item.replacementHistory);
        }
        break;
      case 'provider-usage':
        providerUsage.calls += 1;
        if (item.providerReported) providerUsage.reportedCalls += 1;
        providerUsage.totalInputTokens += item.inputTokens ?? 0;
        providerUsage.totalOutputTokens += item.outputTokens ?? 0;
        providerUsage.lastContextTokens = item.currentContextTokens;
        break;
      case 'rollback-marker':
        rollbackKeep = item.keepLastUserTurns;
        break;
      case 'turn-complete':
        terminal = item;
        steps = Math.max(steps, item.steps);
        break;
      default:
        parseErrors += 1;
    }
  }
  if (rollbackKeep !== null) {
    const truncated = truncateToLastUserTurns(messages, rollbackKeep);
    messages.length = 0;
    messages.push(...truncated);
  }
  return { meta, messages, steps, parseErrors, interrupted, compactedWindows, providerUsage, terminal };
}

/** Load and parse a rollout from storage (resume entry point). */
export async function loadRollout(storage: RolloutStorage): Promise<ResumedRollout> {
  const lines = await storage.readLines();
  return parseRolloutLines(lines);
}

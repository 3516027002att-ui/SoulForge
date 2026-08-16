/**
 * main 侧 EMEVD 权威文档缓存。
 *
 * 不只是取消闸门：按 sourceUri 分槽，容量与估算字节有上界，换工作区清空。
 * 写入必须发生在反汇编成功之后；取消的文档不得成为 submit 权威。
 */

export interface EmevdAuthorityRecord<T> {
  readonly document: T;
  readonly sourceHash: string | null;
  readonly estimatedBytes: number;
  tick: number;
}

export class EmevdAuthorityCache<T> {
  static readonly Capacity = 4;
  static readonly MaxBytes = 96 * 1024 * 1024;

  private readonly items = new Map<string, EmevdAuthorityRecord<T>>();
  private tick = 0;

  get size(): number {
    return this.items.size;
  }

  get(sourceUri: string, expectedHash?: string | null): T | undefined {
    const found = this.items.get(sourceUri);
    if (!found) return undefined;
    if (expectedHash !== undefined && expectedHash !== null && found.sourceHash !== expectedHash) {
      this.items.delete(sourceUri);
      return undefined;
    }
    found.tick = ++this.tick;
    return found.document;
  }

  commit(
    sourceUri: string,
    document: T,
    signal: AbortSignal,
    sourceHash: string | null = null
  ): boolean {
    if (signal.aborted) return false;
    const estimatedBytes = estimateDocumentBytes(document);
    this.items.set(sourceUri, {
      document,
      sourceHash,
      estimatedBytes,
      tick: ++this.tick
    });
    this.evict();
    return this.items.has(sourceUri);
  }

  replace(sourceUri: string, document: T, sourceHash: string | null = null): void {
    this.commit(sourceUri, document, { aborted: false } as AbortSignal, sourceHash);
  }

  clear(): void {
    this.items.clear();
    this.tick = 0;
  }

  private evict(): void {
    while (this.items.size > EmevdAuthorityCache.Capacity) {
      const oldest = this.oldestKey();
      if (!oldest) break;
      this.items.delete(oldest);
    }
    while (this.totalBytes() > EmevdAuthorityCache.MaxBytes) {
      if (this.items.size <= 1) break;
      const oldest = this.oldestKey();
      if (!oldest) break;
      this.items.delete(oldest);
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const item of this.items.values()) total += item.estimatedBytes;
    return total;
  }

  private oldestKey(): string | undefined {
    let oldest: string | undefined;
    let oldestTick = Number.POSITIVE_INFINITY;
    for (const [key, item] of this.items) {
      if (item.tick >= oldestTick) continue;
      oldestTick = item.tick;
      oldest = key;
    }
    return oldest;
  }
}

export function estimateDocumentBytes(document: unknown): number {
  if (!document || typeof document !== 'object') return 256;
  const record = document as { events?: Array<{ instructions?: unknown[] }> };
  const events = record.events ?? [];
  let instructions = 0;
  for (const event of events) instructions += event.instructions?.length ?? 0;
  return 256 + events.length * 96 + instructions * 192;
}

export function commitEmevdFullDocument<T>(
  cache: EmevdAuthorityCache<T> | Map<string, T>,
  sourceUri: string,
  document: T,
  signal: AbortSignal,
  sourceHash: string | null = null
): boolean {
  if (cache instanceof EmevdAuthorityCache) {
    return cache.commit(sourceUri, document, signal, sourceHash);
  }
  if (signal.aborted) return false;
  cache.set(sourceUri, document);
  return true;
}

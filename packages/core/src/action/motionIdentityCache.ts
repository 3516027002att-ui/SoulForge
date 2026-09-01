/**
 * Revision-scoped ACTION motion identity cache.
 *
 * A TAE source contains many animIds. The source URI alone is therefore not a
 * sufficient identity for a cached promise; a revision change must also be
 * unable to reuse the old source, and each animId must have its own slot.
 */
export class ActionMotionIdentityCache<T> {
  private readonly entries = new Map<string, T>();

  get(sourceUri: string, revisionKey: string, animId: number): T | undefined {
    return this.entries.get(makeKey(sourceUri, revisionKey, animId));
  }

  set(sourceUri: string, revisionKey: string, animId: number, value: T): void {
    this.entries.set(makeKey(sourceUri, revisionKey, animId), value);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function makeKey(sourceUri: string, revisionKey: string, animId: number): string {
  return JSON.stringify([sourceUri, revisionKey, animId]);
}

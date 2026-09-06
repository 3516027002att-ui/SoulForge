/**
 * Revision-scoped ACTION motion identity cache.
 *
 * A TAE source contains many animIds. The source URI alone is therefore not a
 * sufficient identity for a cached promise; a revision change must also be
 * unable to reuse the old source, and each TAE-entry + animId pair must have
 * its own slot.
 */
export class ActionMotionIdentityCache<T> {
  private readonly entries = new Map<string, T>();

  get(sourceUri: string, revisionKey: string, animId: number, entryKey = ''): T | undefined {
    return this.entries.get(makeKey(sourceUri, revisionKey, animId, entryKey));
  }

  set(sourceUri: string, revisionKey: string, animId: number, value: T, entryKey = ''): void {
    this.entries.set(makeKey(sourceUri, revisionKey, animId, entryKey), value);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function makeKey(sourceUri: string, revisionKey: string, animId: number, entryKey: string): string {
  return JSON.stringify([sourceUri, revisionKey, entryKey, animId]);
}

import { KnowledgeStore, type KnowledgeStoreSnapshot } from '@soulforge/core';

/**
 * The desktop main process only reads this curator snapshot.  A future write
 * must acquire an explicit utility RPC; silently accepting it in memory would
 * report a successful CAS while dropping the durable generation.
 */
export function createReadOnlyKnowledgeStore(snapshot: KnowledgeStoreSnapshot | null): KnowledgeStore {
  let allowBootstrapSave = snapshot === null;
  const persistence = {
    load: () => snapshot,
    save: () => {
      if (allowBootstrapSave) {
        allowBootstrapSave = false;
        return;
      }
      throw new Error('KNOWLEDGE_STORE_READ_ONLY');
    }
  };
  return new KnowledgeStore({ persistence, schemaVersion: 'knowledge-v1' });
}

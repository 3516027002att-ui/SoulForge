/**
 * Long-Term Memory System Types (Codex-style persistent memory architecture).
 */

export interface MemoryEntry {
  /** Unique ID for the memory entry. */
  id: string;
  /** Short topic or key name, e.g. "character_ids", "speffect_rules", "mod_architecture". */
  topic: string;
  /** 1-2 sentence high-level summary. */
  summary: string;
  /** Detailed content, guidelines, code snippets, or notes. */
  details?: string;
  /** Search tags or categories. */
  tags?: readonly string[];
  /** ISO timestamp when created. */
  createdAt: string;
  /** ISO timestamp when last updated. */
  updatedAt: string;
}

export interface MemorySaveInput {
  id?: string;
  topic: string;
  summary: string;
  details?: string;
  tags?: readonly string[];
}

export interface MemoryStoreData {
  version: number;
  description?: string;
  entries: MemoryEntry[];
}

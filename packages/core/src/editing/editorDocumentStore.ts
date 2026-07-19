/**
 * In-memory professional editor document store.
 * Tracks open tabs, revision/selection, and accepts only unified EditorMutation objects.
 */

import { randomUUID } from 'node:crypto';
import type {
  EditorDocumentRef,
  EditorKind,
  EditorMutation,
  EditorMutationBatch,
  EditorMutationKind,
  EditorValidationIssue
} from '@soulforge/shared';

export interface OpenEditorDocumentInput {
  editorKind: EditorKind;
  resourceUri: string;
  title: string;
}

export interface EditorDocumentState extends EditorDocumentRef {
  selectionJson?: string;
  dirty: boolean;
  lastMutationId?: string;
}

const ALLOWED: Record<EditorKind, ReadonlySet<EditorMutationKind>> = {
  hex: new Set(['hex_byte_patch']),
  fmg: new Set(['fmg_entry_upsert', 'fmg_entry_delete']),
  param: new Set(['param_row_upsert', 'param_row_delete']),
  emevd: new Set(['emevd_set_rest_behavior', 'emevd_update_id']),
  msb: new Set(['msb_set_part_position', 'msb_set_part_transform']),
  text: new Set(),
  raw: new Set(['hex_byte_patch'])
};

export interface EditorMutationApplyResult {
  ok: boolean;
  documentId: string;
  accepted: EditorMutation[];
  rejected: EditorMutation[];
  issues: EditorValidationIssue[];
  revision: number;
  dirty: boolean;
  document?: EditorDocumentState;
}

export interface EditorDocumentSnapshot {
  document: EditorDocumentState;
  pendingMutations: EditorMutation[];
  pendingCount: number;
}

export interface EditorStoreSnapshot {
  openDocuments: EditorDocumentState[];
  totalPendingMutations: number;
}

export class EditorDocumentStore {
  private readonly documents = new Map<string, EditorDocumentState>();
  private readonly pending = new Map<string, EditorMutation[]>();

  open(input: OpenEditorDocumentInput): EditorDocumentState {
    const existing = [...this.documents.values()].find(
      (doc) => doc.resourceUri === input.resourceUri && doc.editorKind === input.editorKind
    );
    if (existing) return structuredClone(existing);
    const doc: EditorDocumentState = {
      documentId: randomUUID(),
      editorKind: input.editorKind,
      resourceUri: input.resourceUri,
      revision: 0,
      title: input.title,
      dirty: false
    };
    this.documents.set(doc.documentId, doc);
    this.pending.set(doc.documentId, []);
    return structuredClone(doc);
  }

  list(): EditorDocumentState[] {
    return [...this.documents.values()].map((doc) => structuredClone(doc));
  }

  get(documentId: string): EditorDocumentState | undefined {
    const doc = this.documents.get(documentId);
    return doc ? structuredClone(doc) : undefined;
  }

  setSelection(documentId: string, selectionJson: string): EditorValidationIssue[] {
    const doc = this.documents.get(documentId);
    if (!doc) {
      return [{ severity: 'error', code: 'EDITOR_DOCUMENT_NOT_FOUND', message: '编辑器文档不存在。' }];
    }
    doc.selectionJson = selectionJson;
    return [];
  }

  /**
   * Accept a unified mutation. Rejects kind mismatch, stale revision, and unknown documents.
   */
  applyMutation(mutation: Omit<EditorMutation, 'mutationId' | 'createdAt'> & {
    mutationId?: string;
    createdAt?: string;
  }): EditorMutationApplyResult {
    const doc = this.documents.get(mutation.documentId);
    if (!doc) {
      return {
        ok: false,
        documentId: mutation.documentId,
        accepted: [],
        rejected: [],
        issues: [{ severity: 'error', code: 'EDITOR_DOCUMENT_NOT_FOUND', message: '编辑器文档不存在。' }],
        revision: 0,
        dirty: false
      };
    }
    if (mutation.resourceUri !== doc.resourceUri) {
      return {
        ok: false,
        documentId: doc.documentId,
        accepted: [],
        rejected: [],
        issues: [{ severity: 'error', code: 'EDITOR_RESOURCE_MISMATCH', message: 'mutation 资源 URI 与文档不一致。' }],
        revision: doc.revision,
        dirty: doc.dirty
      };
    }
    if (mutation.baseRevision !== doc.revision) {
      return {
        ok: false,
        documentId: doc.documentId,
        accepted: [],
        rejected: [],
        issues: [{
          severity: 'error',
          code: 'EDITOR_REVISION_CONFLICT',
          message: `文档 revision 冲突：expected ${doc.revision}, got ${mutation.baseRevision}。`
        }],
        revision: doc.revision,
        dirty: doc.dirty
      };
    }
    const allowed = ALLOWED[doc.editorKind];
    if (!allowed.has(mutation.kind)) {
      return {
        ok: false,
        documentId: doc.documentId,
        accepted: [],
        rejected: [],
        issues: [{
          severity: 'error',
          code: 'EDITOR_MUTATION_KIND_DENIED',
          message: `编辑器 ${doc.editorKind} 不接受 mutation ${mutation.kind}。`
        }],
        revision: doc.revision,
        dirty: doc.dirty
      };
    }

    const full: EditorMutation = {
      mutationId: mutation.mutationId ?? randomUUID(),
      documentId: mutation.documentId,
      kind: mutation.kind,
      resourceUri: mutation.resourceUri,
      baseRevision: mutation.baseRevision,
      payload: mutation.payload,
      createdAt: mutation.createdAt ?? new Date().toISOString()
    };
    const queue = this.pending.get(doc.documentId) ?? [];
    queue.push(full);
    this.pending.set(doc.documentId, queue);
    doc.revision += 1;
    doc.dirty = true;
    doc.lastMutationId = full.mutationId;
    return { ok: true, documentId: doc.documentId, accepted: [full], rejected: [], issues: [], revision: doc.revision, dirty: doc.dirty, document: structuredClone(doc) };
  }

  createPatchEngineBatch(documentId: string): {
    ok: boolean;
    batch?: EditorMutationBatch;
    issues: EditorValidationIssue[];
  } {
    const doc = this.documents.get(documentId);
    if (!doc) {
      return {
        ok: false,
        issues: [{ severity: 'error', code: 'EDITOR_DOCUMENT_NOT_FOUND', message: '编辑器文档不存在。' }]
      };
    }
    const mutations = this.pending.get(documentId) ?? [];
    if (mutations.length === 0) {
      return {
        ok: false,
        issues: [{ severity: 'error', code: 'EDITOR_NO_PENDING_MUTATIONS', message: '没有可提交的编辑器 mutation。' }]
      };
    }
    const batch: EditorMutationBatch = {
      batchId: randomUUID(),
      documentId,
      mutations: structuredClone(mutations),
      requiresPatchEngine: true
    };
    return { ok: true, batch, issues: [] };
  }

  listOpenDocuments(): EditorDocumentState[] {
    return [...this.documents.values()].map((doc) => structuredClone(doc));
  }

  getPendingMutations(documentId: string): EditorMutation[] {
    return structuredClone(this.pending.get(documentId) ?? []);
  }

  snapshot(documentId: string): EditorDocumentSnapshot | undefined {
    const doc = this.documents.get(documentId);
    if (!doc) return undefined;
    return {
      document: structuredClone(doc),
      pendingMutations: structuredClone(this.pending.get(documentId) ?? []),
      pendingCount: (this.pending.get(documentId) ?? []).length
    };
  }

  close(documentId: string): boolean {
    const existed = this.documents.delete(documentId);
    this.pending.delete(documentId);
    return existed;
  }

  applyBatch(batch: EditorMutationBatch): EditorMutationApplyResult {
    if (batch.requiresPatchEngine !== true) {
      return {
        ok: false,
        documentId: batch.documentId,
        accepted: [],
        rejected: [],
        issues: [{
          severity: 'error',
          code: 'EDITOR_BATCH_REQUIRES_PATCH_ENGINE',
          message: 'EditorMutationBatch.requiresPatchEngine must be true.'
        }],
        revision: this.documents.get(batch.documentId)?.revision ?? 0,
        dirty: this.documents.get(batch.documentId)?.dirty ?? false
      };
    }

    const accepted: EditorMutation[] = [];
    const rejected: EditorMutation[] = [];
    const issues: EditorValidationIssue[] = [];
    let lastDoc = this.documents.get(batch.documentId);

    for (const mutation of batch.mutations) {
      const result = this.applyMutation({
        ...mutation,
        documentId: batch.documentId
      });
      issues.push(...result.issues);
      if (result.ok && result.accepted[0]) {
        accepted.push(result.accepted[0]);
        lastDoc = this.documents.get(batch.documentId);
      } else if (result.rejected[0]) {
        rejected.push(result.rejected[0]);
      }
    }

    return {
      ok: rejected.length === 0 && issues.every((item) => item.severity !== 'error'),
      documentId: batch.documentId,
      accepted,
      rejected,
      issues,
      revision: lastDoc?.revision ?? 0,
      dirty: lastDoc?.dirty ?? false
    };
  }

  clearPending(documentId: string): EditorMutation[] {
    const doc = this.documents.get(documentId);
    if (!doc) return [];
    const drained = structuredClone(this.pending.get(documentId) ?? []);
    this.pending.set(documentId, []);
    doc.dirty = false;
    return drained;
  }

  markSynced(documentId: string): EditorMutation[] {
    return this.clearPending(documentId);
  }

  snapshotStore(): EditorStoreSnapshot {
    const openDocuments = this.listOpenDocuments();
    return {
      openDocuments,
      totalPendingMutations: [...this.pending.values()].reduce((sum, items) => sum + items.length, 0)
    };
  }
}

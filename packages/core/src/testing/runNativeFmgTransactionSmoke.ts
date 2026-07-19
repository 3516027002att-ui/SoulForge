/**
 * Real Sekiro FMG child -> typed PatchIR text edit -> native reread ->
 * resource-entry rollback and operation rollback. The source msgbnd stays read-only.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IndexedFile } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { readFmgDocumentViaBridge } from '../editing/fmgBridgeCommit.js';
import {
  commitFmgEntryAddThroughPatchIr,
  commitFmgEntryDeleteThroughPatchIr,
  commitFmgEntryReorderThroughPatchIr,
  commitFmgEntryTextThroughPatchIr
} from '../editing/fmgSemanticCommit.js';
import {
  fmgEntryNodeUri,
  reorderFmgEntrySlots,
  snapshotFmgEntrySlots
} from '../editing/fmgSemanticContract.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation, rollbackResourceEntry } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface Bnd4ChildSnapshot {
  contentBase64: string;
  name: string;
}

async function main(): Promise<void> {
  const sourceMsgbnd = await resolveNativeFixturePath(
    'msg/zhocn/item.msgbnd.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_FMG'
  );
  const sourceContainerBytes = await readFile(sourceMsgbnd);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-fmg-transaction-'));
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'msg', 'zhocn'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const target = join(overlay, 'msg', 'zhocn', 'weapon_names.fmg');

  try {
    const child = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceMsgbnd,
      allowedRoots: [dirname(sourceMsgbnd)],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: 1 }
    });
    if (!child.data?.contentBase64) {
      throw new Error(`FMG child snapshot failed: ${JSON.stringify(child.diagnostics)}`);
    }
    const sourceFmgBytes = Buffer.from(child.data.contentBase64, 'base64');
    await writeFile(target, sourceFmgBytes);

    const before = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!before.ok || !before.data || before.data.authority !== 'native-verified') {
      throw new Error(`FMG semantic baseline failed: ${JSON.stringify(before.diagnostics)}`);
    }
    const idCounts = new Map<number, number>();
    for (const entry of before.data.entries) {
      idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    }
    const targetEntry = before.data.entries.find((entry) =>
      entry.text.length > 0 && (idCounts.get(entry.id) ?? 0) > 1)
      ?? before.data.entries.find((entry) => entry.text.length > 0);
    if (!targetEntry) throw new Error('FMG transaction smoke needs a non-empty entry');
    const nextText = `${targetEntry.text}·SoulForge`;

    const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
    const store = new MemoryOperationLogStore();
    const sourceUri = 'file://msg/zhocn/weapon_names.fmg';
    const file: IndexedFile = {
      id: sourceUri,
      workspaceId: session.meta.workspaceId,
      absolutePath: target,
      relativePath: 'msg/zhocn/weapon_names.fmg',
      sourceUri,
      sourcePath: target,
      game: 'sekiro',
      resourceKind: 'msg',
      parseStatus: 'parsed',
      diagnostics: [],
      extension: '.fmg',
      compoundExtension: '.fmg',
      formatKind: 'fmg',
      formatLabel: 'FMG',
      size: sourceFmgBytes.length,
      mtimeMs: Date.now()
    };

    const beforeGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedCommit = await commitFmgEntryTextThroughPatchIr({
      file,
      expectedHash: before.data.sourceHash,
      entryId: targetEntry.id,
      stringIndex: targetEntry.stringIndex,
      text: nextText,
      session,
      operationLog: store
    });
    if (deniedCommit.ok
      || !deniedCommit.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== beforeGateCount
      || !(await readFile(target)).equals(sourceFmgBytes)) {
      throw new Error('FMG semantic confirmation gate did not fail closed');
    }

    const committed = await commitFmgEntryTextThroughPatchIr({
      file,
      expectedHash: before.data.sourceHash,
      entryId: targetEntry.id,
      stringIndex: targetEntry.stringIndex,
      text: nextText,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_TEXT'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG semantic transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'FMG existing-entry text typed semantic transaction'
    });
    if (!committed.ok || !committed.opId) {
      throw new Error(`FMG semantic commit failed: ${JSON.stringify(committed.diagnostics)}`);
    }
    const changes = await store.listResourceEntryChanges(committed.opId);
    if (changes.length !== 1
      || changes[0]?.changeKind !== 'field_update'
      || changes[0].inverse.kind !== 'resource_field_edit') {
      throw new Error(`FMG semantic inverse persistence failed: ${JSON.stringify(changes)}`);
    }
    const after = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!after.ok || !after.data
      || after.data.entries[targetEntry.stringIndex]?.id !== targetEntry.id
      || after.data.entries[targetEntry.stringIndex]?.text !== nextText) {
      throw new Error('FMG typed text edit did not survive native reread');
    }
    for (const entry of before.data.entries) {
      if (entry.stringIndex === targetEntry.stringIndex) continue;
      const current = after.data.entries[entry.stringIndex];
      if (!current || current.id !== entry.id || current.text !== entry.text) {
        throw new Error(`FMG text edit changed sibling slot ${entry.stringIndex}`);
      }
    }
    const change = changes[0]!;
    if (change.inverse.kind !== 'resource_field_edit'
      || change.inverse.expectedHash !== after.data.sourceHash
      || change.inverse.expectedDocumentHash !== after.data.documentHash
      || change.inverse.previousValue.valueType !== 'string'
      || change.inverse.previousValue.value !== nextText
      || change.inverse.nextValue.valueType !== 'string'
      || change.inverse.nextValue.value !== targetEntry.text) {
      throw new Error('FMG semantic inverse is not bound to the committed revision');
    }

    const deniedRollback = await rollbackResourceEntry({
      opId: committed.opId,
      entryUri: change.entryUri,
      store,
      session
    });
    if (deniedRollback.ok
      || !deniedRollback.diagnostics.some((item) => item.code === 'EDIT_CONFIRMATION_REQUIRED')
      || sha256(await readFile(target)) !== after.data.sourceHash) {
      throw new Error('FMG resource-entry rollback confirmation gate did not fail closed');
    }
    const entryRolled = await rollbackResourceEntry({
      opId: committed.opId,
      entryUri: change.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${committed.opId}:${change.entryUri}`],
        riskLevel: 'high',
        note: 'FMG semantic entry rollback smoke'
      })
    });
    const restored = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!entryRolled.ok || !restored.ok || !restored.data) {
      throw new Error(`FMG resource-entry rollback failed: ${JSON.stringify(entryRolled.diagnostics)}`);
    }
    for (const entry of before.data.entries) {
      const current = restored.data.entries[entry.stringIndex];
      if (!current || current.id !== entry.id || current.text !== entry.text) {
        throw new Error(`FMG resource-entry rollback did not restore slot ${entry.stringIndex}`);
      }
    }

    const beforeOperationBytes = await readFile(target);
    const operationCommitted = await commitFmgEntryTextThroughPatchIr({
      file,
      expectedHash: restored.data.sourceHash,
      entryId: targetEntry.id,
      stringIndex: targetEntry.stringIndex,
      text: `${targetEntry.text}·operation`,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_TEXT'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!operationCommitted.ok || !operationCommitted.opId) {
      throw new Error(`FMG operation rollback setup failed: ${JSON.stringify(operationCommitted.diagnostics)}`);
    }
    const operationRolled = await rollbackOperation({
      opId: operationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${operationCommitted.opId}`],
        riskLevel: 'high',
        note: 'FMG operation rollback smoke'
      })
    });
    if (!operationRolled.ok || !(await readFile(target)).equals(beforeOperationBytes)) {
      throw new Error(`FMG operation rollback failed: ${JSON.stringify(operationRolled.diagnostics)}`);
    }
    if (!(await readFile(sourceMsgbnd)).equals(sourceContainerBytes)) {
      throw new Error('FMG source msgbnd fixture changed');
    }

    // --- Slot-precise typed delete ---
    const deleteBaseline = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!deleteBaseline.ok || !deleteBaseline.data) {
      throw new Error(`FMG delete baseline failed: ${JSON.stringify(deleteBaseline.diagnostics)}`);
    }
    const deleteTarget = deleteBaseline.data.entries.find((entry) =>
      entry.text.length > 0 && (idCounts.get(entry.id) ?? 0) > 1)
      ?? deleteBaseline.data.entries.find((entry) => entry.text.length > 0)
      ?? deleteBaseline.data.entries[0];
    if (!deleteTarget) throw new Error('FMG delete smoke needs a target entry');
    const deleteGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedDelete = await commitFmgEntryDeleteThroughPatchIr({
      file,
      expectedHash: deleteBaseline.data.sourceHash,
      entryId: deleteTarget.id,
      stringIndex: deleteTarget.stringIndex,
      session,
      operationLog: store
    });
    if (deniedDelete.ok
      || !deniedDelete.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== deleteGateCount
      || sha256(await readFile(target)) !== deleteBaseline.data.sourceHash) {
      throw new Error('FMG semantic delete confirmation gate did not fail closed');
    }
    const deleteCommitted = await commitFmgEntryDeleteThroughPatchIr({
      file,
      expectedHash: deleteBaseline.data.sourceHash,
      entryId: deleteTarget.id,
      stringIndex: deleteTarget.stringIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_DELETE'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG semantic delete transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'FMG slot delete typed semantic transaction'
    });
    if (!deleteCommitted.ok || !deleteCommitted.opId) {
      throw new Error(`FMG semantic delete commit failed: ${JSON.stringify(deleteCommitted.diagnostics)}`);
    }
    const deleteChanges = await store.listResourceEntryChanges(deleteCommitted.opId);
    if (deleteChanges.length !== 1
      || deleteChanges[0]?.changeKind !== 'node_delete'
      || deleteChanges[0].inverse.kind !== 'resource_node_add') {
      throw new Error(`FMG semantic delete inverse persistence failed: ${JSON.stringify(deleteChanges)}`);
    }
    const afterDelete = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!afterDelete.ok || !afterDelete.data
      || afterDelete.data.entries.length !== deleteBaseline.data.entries.length - 1) {
      throw new Error('FMG typed slot delete did not reduce entryCount by 1');
    }
    for (let i = 0; i < deleteTarget.stringIndex; i += 1) {
      const expected = deleteBaseline.data.entries[i]!;
      const actual = afterDelete.data.entries[i];
      if (!actual || actual.id !== expected.id || actual.text !== expected.text) {
        throw new Error(`FMG slot delete changed preceding slot ${i}`);
      }
    }
    for (let i = deleteTarget.stringIndex; i < afterDelete.data.entries.length; i += 1) {
      const expected = deleteBaseline.data.entries[i + 1]!;
      const actual = afterDelete.data.entries[i];
      if (!actual || actual.id !== expected.id || actual.text !== expected.text) {
        throw new Error(`FMG slot delete shifted incorrectly at slot ${i}`);
      }
    }
    const deleteChange = deleteChanges[0]!;
    if (deleteChange.inverse.kind !== 'resource_node_add'
      || deleteChange.inverse.expectedHash !== afterDelete.data.sourceHash
      || deleteChange.inverse.expectedDocumentHash !== afterDelete.data.documentHash) {
      throw new Error('FMG semantic delete inverse is not bound to the committed revision');
    }
    const deniedDeleteRollback = await rollbackResourceEntry({
      opId: deleteCommitted.opId,
      entryUri: deleteChange.entryUri,
      store,
      session
    });
    if (deniedDeleteRollback.ok
      || !deniedDeleteRollback.diagnostics.some((item) => item.code === 'EDIT_CONFIRMATION_REQUIRED')
      || sha256(await readFile(target)) !== afterDelete.data.sourceHash) {
      throw new Error('FMG delete resource-entry rollback confirmation gate did not fail closed');
    }
    const deleteEntryRolled = await rollbackResourceEntry({
      opId: deleteCommitted.opId,
      entryUri: deleteChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${deleteCommitted.opId}:${deleteChange.entryUri}`],
        riskLevel: 'high',
        note: 'FMG semantic delete entry rollback smoke'
      })
    });
    const deleteRestored = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!deleteEntryRolled.ok || !deleteRestored.ok || !deleteRestored.data) {
      throw new Error(`FMG delete resource-entry rollback failed: ${JSON.stringify(deleteEntryRolled.diagnostics)}`);
    }
    for (const entry of deleteBaseline.data.entries) {
      const current = deleteRestored.data.entries[entry.stringIndex];
      if (!current || current.id !== entry.id || current.text !== entry.text) {
        throw new Error(`FMG delete resource-entry rollback did not restore slot ${entry.stringIndex}`);
      }
    }
    const beforeDeleteOperationBytes = await readFile(target);
    const deleteOperationCommitted = await commitFmgEntryDeleteThroughPatchIr({
      file,
      expectedHash: deleteRestored.data.sourceHash,
      entryId: deleteTarget.id,
      stringIndex: deleteTarget.stringIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_DELETE'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG delete operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!deleteOperationCommitted.ok || !deleteOperationCommitted.opId) {
      throw new Error(`FMG delete operation rollback setup failed: ${JSON.stringify(deleteOperationCommitted.diagnostics)}`);
    }
    const deleteOperationRolled = await rollbackOperation({
      opId: deleteOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${deleteOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'FMG delete operation rollback smoke'
      })
    });
    if (!deleteOperationRolled.ok || !(await readFile(target)).equals(beforeDeleteOperationBytes)) {
      throw new Error(`FMG delete operation rollback failed: ${JSON.stringify(deleteOperationRolled.diagnostics)}`);
    }
    if (!(await readFile(sourceMsgbnd)).equals(sourceContainerBytes)) {
      throw new Error('FMG source msgbnd fixture changed after delete path');
    }

    // Typed slot insert (append) + resource-entry inverse + operation rollback.
    const insertBaseline = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!insertBaseline.ok || !insertBaseline.data) {
      throw new Error(`FMG insert baseline failed: ${JSON.stringify(insertBaseline.diagnostics)}`);
    }
    const insertId = 9_000_001;
    const insertIndex = insertBaseline.data.entries.length;
    const insertText = 'SoulForge-typed-insert';
    const insertGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedInsert = await commitFmgEntryAddThroughPatchIr({
      file,
      expectedHash: insertBaseline.data.sourceHash,
      entryId: insertId,
      stringIndex: insertIndex,
      text: insertText,
      session,
      operationLog: store
    });
    if (deniedInsert.ok
      || !deniedInsert.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== insertGateCount
      || sha256(await readFile(target)) !== insertBaseline.data.sourceHash) {
      throw new Error('FMG semantic insert confirmation gate did not fail closed');
    }
    const insertCommitted = await commitFmgEntryAddThroughPatchIr({
      file,
      expectedHash: insertBaseline.data.sourceHash,
      entryId: insertId,
      stringIndex: insertIndex,
      text: insertText,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG semantic insert transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'FMG slot insert typed semantic transaction'
    });
    if (!insertCommitted.ok || !insertCommitted.opId) {
      throw new Error(`FMG semantic insert commit failed: ${JSON.stringify(insertCommitted.diagnostics)}`);
    }
    const insertChanges = await store.listResourceEntryChanges(insertCommitted.opId);
    if (insertChanges.length !== 1
      || insertChanges[0]?.changeKind !== 'node_add'
      || insertChanges[0].inverse.kind !== 'resource_node_delete') {
      throw new Error(`FMG semantic insert inverse persistence failed: ${JSON.stringify(insertChanges)}`);
    }
    const afterInsert = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!afterInsert.ok || !afterInsert.data
      || afterInsert.data.entries.length !== insertBaseline.data.entries.length + 1) {
      throw new Error('FMG typed slot insert did not increase entryCount by 1');
    }
    for (let i = 0; i < insertBaseline.data.entries.length; i += 1) {
      const expected = insertBaseline.data.entries[i]!;
      const actual = afterInsert.data.entries[i];
      if (!actual || actual.id !== expected.id || actual.text !== expected.text) {
        throw new Error(`FMG slot insert changed preceding slot ${i}`);
      }
    }
    const inserted = afterInsert.data.entries[insertIndex];
    if (!inserted || inserted.id !== insertId || inserted.text !== insertText) {
      throw new Error('FMG typed slot insert target identity mismatch');
    }
    const insertChange = insertChanges[0]!;
    if (insertChange.inverse.kind !== 'resource_node_delete'
      || insertChange.inverse.expectedHash !== afterInsert.data.sourceHash
      || insertChange.inverse.expectedDocumentHash !== afterInsert.data.documentHash) {
      throw new Error('FMG semantic insert inverse is not bound to the committed revision');
    }
    const insertEntryRolled = await rollbackResourceEntry({
      opId: insertCommitted.opId,
      entryUri: insertChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${insertCommitted.opId}:${insertChange.entryUri}`],
        riskLevel: 'high',
        note: 'FMG semantic insert entry rollback smoke'
      })
    });
    const insertRestored = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!insertEntryRolled.ok || !insertRestored.ok || !insertRestored.data) {
      throw new Error(`FMG insert resource-entry rollback failed: ${JSON.stringify(insertEntryRolled.diagnostics)}`);
    }
    if (insertRestored.data.entries.length !== insertBaseline.data.entries.length) {
      throw new Error('FMG insert resource-entry rollback did not restore entryCount');
    }
    for (const entry of insertBaseline.data.entries) {
      const current = insertRestored.data.entries[entry.stringIndex];
      if (!current || current.id !== entry.id || current.text !== entry.text) {
        throw new Error(`FMG insert resource-entry rollback did not restore slot ${entry.stringIndex}`);
      }
    }
    const beforeInsertOperationBytes = await readFile(target);
    const insertOperationCommitted = await commitFmgEntryAddThroughPatchIr({
      file,
      expectedHash: insertRestored.data.sourceHash,
      entryId: insertId,
      stringIndex: insertRestored.data.entries.length,
      text: insertText,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG insert operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!insertOperationCommitted.ok || !insertOperationCommitted.opId) {
      throw new Error(`FMG insert operation rollback setup failed: ${JSON.stringify(insertOperationCommitted.diagnostics)}`);
    }
    const insertOperationRolled = await rollbackOperation({
      opId: insertOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${insertOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'FMG insert operation rollback smoke'
      })
    });
    if (!insertOperationRolled.ok || !(await readFile(target)).equals(beforeInsertOperationBytes)) {
      throw new Error(`FMG insert operation rollback failed: ${JSON.stringify(insertOperationRolled.diagnostics)}`);
    }
    if (!(await readFile(sourceMsgbnd)).equals(sourceContainerBytes)) {
      throw new Error('FMG source msgbnd fixture changed after insert path');
    }

    // Typed complete-order reorder + resource-entry inverse + operation rollback.
    const reorderBaseline = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!reorderBaseline.ok || !reorderBaseline.data || reorderBaseline.data.entries.length < 4) {
      throw new Error(`FMG reorder baseline failed: ${JSON.stringify(reorderBaseline.diagnostics)}`);
    }
    const reorderTarget = reorderBaseline.data.entries[0]!;
    const reorderAnchor = reorderBaseline.data.entries[3]!;
    const plannedReorder = reorderFmgEntrySlots({
      documentUri: sourceUri,
      beforeEntries: snapshotFmgEntrySlots(reorderBaseline.data.entries),
      nodeId: fmgEntryNodeUri({
        documentUri: sourceUri,
        entryId: reorderTarget.id,
        stringIndex: reorderTarget.stringIndex
      }),
      beforeNodeId: fmgEntryNodeUri({
        documentUri: sourceUri,
        entryId: reorderAnchor.id,
        stringIndex: reorderAnchor.stringIndex
      })
    });
    if (!plannedReorder.ok) throw new Error(`FMG reorder plan failed: ${plannedReorder.message}`);
    const reorderGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedReorder = await commitFmgEntryReorderThroughPatchIr({
      file,
      expectedHash: reorderBaseline.data.sourceHash,
      entryId: reorderTarget.id,
      stringIndex: reorderTarget.stringIndex,
      beforeStringIndex: reorderAnchor.stringIndex,
      session,
      operationLog: store
    });
    if (deniedReorder.ok
      || !deniedReorder.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== reorderGateCount
      || sha256(await readFile(target)) !== reorderBaseline.data.sourceHash) {
      throw new Error('FMG semantic reorder confirmation gate did not fail closed');
    }
    const reorderCommitted = await commitFmgEntryReorderThroughPatchIr({
      file,
      expectedHash: reorderBaseline.data.sourceHash,
      entryId: reorderTarget.id,
      stringIndex: reorderTarget.stringIndex,
      beforeStringIndex: reorderAnchor.stringIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG semantic reorder transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'FMG slot reorder typed semantic transaction'
    });
    if (!reorderCommitted.ok || !reorderCommitted.opId) {
      throw new Error(`FMG semantic reorder commit failed: ${JSON.stringify(reorderCommitted.diagnostics)}`);
    }
    const reorderChanges = await store.listResourceEntryChanges(reorderCommitted.opId);
    if (reorderChanges.length !== 1
      || reorderChanges[0]?.changeKind !== 'node_reorder'
      || reorderChanges[0].inverse.kind !== 'resource_node_reorder') {
      throw new Error(`FMG semantic reorder inverse persistence failed: ${JSON.stringify(reorderChanges)}`);
    }
    const afterReorder = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!afterReorder.ok || !afterReorder.data) {
      throw new Error(`FMG semantic reorder reread failed: ${JSON.stringify(afterReorder.diagnostics)}`);
    }
    assertEntryOrder(afterReorder.data.entries, plannedReorder.afterEntries, 'typed reorder');
    const reorderChange = reorderChanges[0]!;
    if (reorderChange.inverse.kind !== 'resource_node_reorder'
      || reorderChange.inverse.expectedHash !== afterReorder.data.sourceHash
      || reorderChange.inverse.expectedDocumentHash !== afterReorder.data.documentHash) {
      throw new Error('FMG semantic reorder inverse is not bound to the committed revision');
    }
    const reorderEntryRolled = await rollbackResourceEntry({
      opId: reorderCommitted.opId,
      entryUri: reorderChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${reorderCommitted.opId}:${reorderChange.entryUri}`],
        riskLevel: 'high',
        note: 'FMG semantic reorder entry rollback smoke'
      })
    });
    const reorderRestored = await readFmgDocumentViaBridge({ sourcePath: target, allowedRoots: [overlay] });
    if (!reorderEntryRolled.ok || !reorderRestored.ok || !reorderRestored.data) {
      throw new Error(`FMG reorder resource-entry rollback failed: ${JSON.stringify(reorderEntryRolled.diagnostics)}`);
    }
    assertEntryOrder(
      reorderRestored.data.entries,
      snapshotFmgEntrySlots(reorderBaseline.data.entries),
      'reorder resource-entry rollback'
    );

    const beforeReorderOperationBytes = await readFile(target);
    const reorderOperationCommitted = await commitFmgEntryReorderThroughPatchIr({
      file,
      expectedHash: reorderRestored.data.sourceHash,
      entryId: reorderTarget.id,
      stringIndex: reorderTarget.stringIndex,
      beforeStringIndex: reorderAnchor.stringIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'FMG_SEMANTIC_ENTRY_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'FMG reorder operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!reorderOperationCommitted.ok || !reorderOperationCommitted.opId) {
      throw new Error(`FMG reorder operation rollback setup failed: ${JSON.stringify(reorderOperationCommitted.diagnostics)}`);
    }
    const reorderOperationRolled = await rollbackOperation({
      opId: reorderOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${reorderOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'FMG reorder operation rollback smoke'
      })
    });
    if (!reorderOperationRolled.ok || !(await readFile(target)).equals(beforeReorderOperationBytes)) {
      throw new Error(`FMG reorder operation rollback failed: ${JSON.stringify(reorderOperationRolled.diagnostics)}`);
    }
    if (!(await readFile(sourceMsgbnd)).equals(sourceContainerBytes)) {
      throw new Error('FMG source msgbnd fixture changed after reorder path');
    }

    // Synthetic native-layout contract only: prove duplicate IDs remain
    // independently addressable by stringIndex via the SHIPPED typed delete path.
    // This does not add native authority for real game assets.
    async function typedDeleteOnDuplicateFixture(input: {
      label: string;
      texts: [string, string];
      deleteIndex: number;
      expectedRemainingText: string;
    }): Promise<void> {
      const relativePath = `msg/zhocn/duplicate-${input.label}.fmg`;
      const absolutePath = join(overlay, relativePath);
      await writeFile(absolutePath, buildDuplicateSlotFmgFixture(input.texts[0], input.texts[1]));
      const baseline = await readFmgDocumentViaBridge({ sourcePath: absolutePath, allowedRoots: [overlay] });
      if (!baseline.ok || !baseline.data
        || baseline.data.entries.length !== 2
        || baseline.data.entries[0]?.id !== 100
        || baseline.data.entries[1]?.id !== 100
        || baseline.data.entries[0]?.text !== input.texts[0]
        || baseline.data.entries[1]?.text !== input.texts[1]) {
        throw new Error(`FMG ${input.label} duplicate baseline failed`);
      }
      const dupFile: IndexedFile = {
        ...file,
        id: `file://${relativePath}`,
        absolutePath,
        relativePath,
        sourceUri: `file://${relativePath}`,
        sourcePath: absolutePath,
        size: (await readFile(absolutePath)).length
      };
      const committed = await commitFmgEntryDeleteThroughPatchIr({
        file: dupFile,
        expectedHash: baseline.data.sourceHash,
        entryId: 100,
        stringIndex: input.deleteIndex,
        confirmation: createConfirmationReceipt({
          subjects: [dupFile.sourceUri, 'FMG_SEMANTIC_ENTRY_DELETE'],
          riskLevel: 'high',
          sourceUri: dupFile.sourceUri,
          note: `FMG typed delete ${input.label}`
        }),
        session,
        operationLog: store,
        title: `FMG typed slot delete ${input.label}`
      });
      if (!committed.ok || !committed.opId) {
        throw new Error(
          `FMG typed delete ${input.label} failed (postValidate/commit): ${JSON.stringify(committed.diagnostics)}`
        );
      }
      if (committed.diagnostics.some((item) => item.code === 'FMG_SEMANTIC_DELETE_NOT_APPLIED')) {
        throw new Error(`FMG typed delete ${input.label} false-failed with weak still-at-index heuristic`);
      }
      const after = await readFmgDocumentViaBridge({ sourcePath: absolutePath, allowedRoots: [overlay] });
      if (!after.ok || !after.data
        || after.data.entries.length !== 1
        || after.data.entries[0]?.id !== 100
        || after.data.entries[0]?.text !== input.expectedRemainingText) {
        throw new Error(`FMG typed delete ${input.label} remaining slot mismatch`);
      }
      const changes = await store.listResourceEntryChanges(committed.opId);
      if (changes.length !== 1 || changes[0]?.changeKind !== 'node_delete') {
        throw new Error(`FMG typed delete ${input.label} inverse persistence failed`);
      }
      const rolled = await rollbackResourceEntry({
        opId: committed.opId,
        entryUri: changes[0]!.entryUri,
        store,
        session,
        confirmation: createConfirmationReceipt({
          subjects: [`ROLLBACK_RESOURCE_ENTRY:${committed.opId}:${changes[0]!.entryUri}`],
          riskLevel: 'high',
          note: `FMG typed delete rollback ${input.label}`
        })
      });
      const restored = await readFmgDocumentViaBridge({ sourcePath: absolutePath, allowedRoots: [overlay] });
      if (!rolled.ok || !restored.ok || !restored.data
        || restored.data.entries.length !== 2
        || restored.data.entries[0]?.id !== 100
        || restored.data.entries[1]?.id !== 100
        || restored.data.entries[0]?.text !== input.texts[0]
        || restored.data.entries[1]?.text !== input.texts[1]) {
        throw new Error(
          `FMG typed delete ${input.label} entry rollback did not restore order: ${JSON.stringify(rolled.diagnostics)}`
        );
      }
    }

    // Different text: classic isolation. Same text: the case that false-failed on weak checks.
    await typedDeleteOnDuplicateFixture({
      label: 'diff-text',
      texts: ['左', '右'],
      deleteIndex: 0,
      expectedRemainingText: '右'
    });
    await typedDeleteOnDuplicateFixture({
      label: 'same-text',
      texts: ['同', '同'],
      deleteIndex: 0,
      expectedRemainingText: '同'
    });
    await typedDeleteOnDuplicateFixture({
      label: 'same-text-second-slot',
      texts: ['同', '同'],
      deleteIndex: 1,
      expectedRemainingText: '同'
    });

    // Duplicate IDs with different text: move the second occurrence before the
    // first, then prove the persisted inverse restores the exact occurrence order.
    const duplicateReorderRelativePath = 'msg/zhocn/duplicate-reorder-diff-text.fmg';
    const duplicateReorderPath = join(overlay, duplicateReorderRelativePath);
    await writeFile(duplicateReorderPath, buildDuplicateSlotFmgFixture('左', '右'));
    const duplicateReorderBaseline = await readFmgDocumentViaBridge({
      sourcePath: duplicateReorderPath,
      allowedRoots: [overlay]
    });
    if (!duplicateReorderBaseline.ok || !duplicateReorderBaseline.data
      || duplicateReorderBaseline.data.entries[0]?.id !== 100
      || duplicateReorderBaseline.data.entries[0]?.text !== '左'
      || duplicateReorderBaseline.data.entries[1]?.id !== 100
      || duplicateReorderBaseline.data.entries[1]?.text !== '右') {
      throw new Error('FMG duplicate reorder baseline failed');
    }
    const duplicateReorderFile: IndexedFile = {
      ...file,
      id: `file://${duplicateReorderRelativePath}`,
      absolutePath: duplicateReorderPath,
      relativePath: duplicateReorderRelativePath,
      sourceUri: `file://${duplicateReorderRelativePath}`,
      sourcePath: duplicateReorderPath,
      size: (await readFile(duplicateReorderPath)).length
    };
    const duplicateReorderCommitted = await commitFmgEntryReorderThroughPatchIr({
      file: duplicateReorderFile,
      expectedHash: duplicateReorderBaseline.data.sourceHash,
      entryId: 100,
      stringIndex: 1,
      beforeStringIndex: 0,
      confirmation: createConfirmationReceipt({
        subjects: [duplicateReorderFile.sourceUri, 'FMG_SEMANTIC_ENTRY_REORDER'],
        riskLevel: 'high',
        sourceUri: duplicateReorderFile.sourceUri,
        note: 'FMG duplicate-ID occurrence reorder smoke'
      }),
      session,
      operationLog: store,
      title: 'FMG duplicate-ID occurrence reorder'
    });
    if (!duplicateReorderCommitted.ok || !duplicateReorderCommitted.opId) {
      throw new Error(
        `FMG duplicate reorder commit failed: ${JSON.stringify(duplicateReorderCommitted.diagnostics)}`
      );
    }
    const duplicateReorderAfter = await readFmgDocumentViaBridge({
      sourcePath: duplicateReorderPath,
      allowedRoots: [overlay]
    });
    if (!duplicateReorderAfter.ok || !duplicateReorderAfter.data
      || duplicateReorderAfter.data.entries[0]?.id !== 100
      || duplicateReorderAfter.data.entries[0]?.text !== '右'
      || duplicateReorderAfter.data.entries[1]?.id !== 100
      || duplicateReorderAfter.data.entries[1]?.text !== '左') {
      throw new Error('FMG duplicate reorder did not isolate the requested stringIndex occurrence');
    }
    const duplicateReorderChanges = await store.listResourceEntryChanges(duplicateReorderCommitted.opId);
    if (duplicateReorderChanges.length !== 1
      || duplicateReorderChanges[0]?.changeKind !== 'node_reorder') {
      throw new Error('FMG duplicate reorder inverse persistence failed');
    }
    const duplicateReorderRolled = await rollbackResourceEntry({
      opId: duplicateReorderCommitted.opId,
      entryUri: duplicateReorderChanges[0]!.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [
          `ROLLBACK_RESOURCE_ENTRY:${duplicateReorderCommitted.opId}:${duplicateReorderChanges[0]!.entryUri}`
        ],
        riskLevel: 'high',
        note: 'FMG duplicate-ID occurrence reorder rollback smoke'
      })
    });
    const duplicateReorderRestored = await readFmgDocumentViaBridge({
      sourcePath: duplicateReorderPath,
      allowedRoots: [overlay]
    });
    if (!duplicateReorderRolled.ok || !duplicateReorderRestored.ok || !duplicateReorderRestored.data
      || duplicateReorderRestored.data.entries[0]?.id !== 100
      || duplicateReorderRestored.data.entries[0]?.text !== '左'
      || duplicateReorderRestored.data.entries[1]?.id !== 100
      || duplicateReorderRestored.data.entries[1]?.text !== '右') {
      throw new Error(
        `FMG duplicate reorder rollback did not restore occurrence order: ${JSON.stringify(duplicateReorderRolled.diagnostics)}`
      );
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      message: '原生 FMG typed 文本/槽位删除/槽位新增/完整顺序重排写入、精确槽位隔离、资源条目回滚与 operation 回滚验证通过',
      entryId: targetEntry.id,
      stringIndex: targetEntry.stringIndex,
      deleteEntryId: deleteTarget.id,
      deleteStringIndex: deleteTarget.stringIndex,
      insertEntryId: insertId,
      insertStringIndex: insertIndex,
      duplicateIdOccurrences: before.data.entries.filter((entry) => entry.id === targetEntry.id).length,
      semanticPatchIrFieldCommitVerified: true,
      semanticPatchIrNodeDeleteCommitVerified: true,
      semanticPatchIrNodeAddCommitVerified: true,
      semanticPatchIrNodeReorderCommitVerified: true,
      siblingSlotsPreserved: true,
      typedDuplicateDiffTextDeleteVerified: true,
      typedDuplicateSameTextDeleteVerified: true,
      typedDuplicateSameTextSecondSlotDeleteVerified: true,
      typedDuplicateDiffTextReorderVerified: true,
      strongSlotShiftDeleteContractVerified: true,
      writerPostValidateVerified: true,
      semanticInversePersisted: true,
      resourceEntryRollbackVerified: true,
      deleteResourceEntryRollbackVerified: true,
      insertResourceEntryRollbackVerified: true,
      reorderResourceEntryRollbackVerified: true,
      operationRollbackVerified: true,
      deleteOperationRollbackVerified: true,
      insertOperationRollbackVerified: true,
      reorderOperationRollbackVerified: true,
      originalFixtureUntouched: true,
      nestedMsgbndSemanticFieldCommitClaimed: false
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertEntryOrder(
  actual: ReadonlyArray<{ id: number; text: string }>,
  expected: ReadonlyArray<{ id: number; text: string }>,
  label: string
): void {
  if (actual.length !== expected.length) {
    throw new Error(`FMG ${label} entryCount mismatch: ${actual.length} !== ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i]?.id !== expected[i]?.id || actual[i]?.text !== expected[i]?.text) {
      throw new Error(`FMG ${label} slot ${i} mismatch`);
    }
  }
}

function buildDuplicateSlotFmgFixture(leftText = '左', rightText = '右'): Buffer {
  const left = Buffer.from(`${leftText}\0`, 'utf16le');
  const right = Buffer.from(`${rightText}\0`, 'utf16le');
  const stringOffsetsOffset = 0x48;
  const stringPoolOffset = 0x50;
  const bytes = Buffer.alloc(stringPoolOffset + left.length + right.length);
  bytes.writeInt32LE(0x0002_0000, 0x00);
  bytes.writeInt32LE(bytes.length, 0x04);
  bytes.writeInt32LE(0, 0x08);
  bytes.writeInt32LE(2, 0x0c);
  bytes.writeInt32LE(2, 0x10);
  bytes.writeInt32LE(0, 0x14);
  bytes.writeInt32LE(stringOffsetsOffset, 0x18);
  for (let groupIndex = 0; groupIndex < 2; groupIndex += 1) {
    const offset = 0x28 + groupIndex * 0x10;
    bytes.writeInt32LE(groupIndex, offset);
    bytes.writeInt32LE(100, offset + 0x04);
    bytes.writeInt32LE(100, offset + 0x08);
    bytes.writeInt32LE(0, offset + 0x0c);
  }
  bytes.writeInt32LE(stringPoolOffset, stringOffsetsOffset);
  bytes.writeInt32LE(stringPoolOffset + left.length, stringOffsetsOffset + 0x04);
  left.copy(bytes, stringPoolOffset);
  right.copy(bytes, stringPoolOffset + left.length);
  return bytes;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

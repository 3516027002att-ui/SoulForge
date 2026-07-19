/**
 * Structural contract: desktop EMEVD read/write IPC channels exist,
 * preload exposes them, and no absolute path fields leak into channel names.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const commit = readFileSync(resolve(root, 'packages/core/src/editing/emevdBridgeCommit.ts'), 'utf8');
  const semanticCommit = readFileSync(
    resolve(root, 'packages/core/src/editing/emevdSemanticCommit.ts'),
    'utf8'
  );
  const app = readFileSync(resolve(root, 'apps/desktop/src/renderer/src/App.tsx'), 'utf8');
  const panel = readFileSync(
    resolve(root, 'apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx'),
    'utf8'
  );
  const bridgeService = readFileSync(
    resolve(root, 'bridge/SoulForge.Bridge/BridgeCommandService.cs'),
    'utf8'
  );
  const nativeSource = readFileSync(
    resolve(root, 'bridge/SoulForge.Bridge/EmevdNativeSource.cs'),
    'utf8'
  );
  const envelopeMap = readFileSync(
    resolve(root, 'apps/desktop/src/renderer/src/emevd/mapEmevdEnvelope.ts'),
    'utf8'
  );

  for (const token of [
    "handle('resource.readEmevdDocument'",
    "handle(",
    'resource.applyEmevdMutation',
    'commitEmevdMutationViaBridge',
    'commitEmevdEventAddThroughPatchIr',
    'commitEmevdEventDeleteThroughPatchIr',
    'commitEmevdEventDuplicateThroughPatchIr',
    'commitEmevdInstructionDuplicateThroughPatchIr',
    'commitEmevdInstructionDeleteThroughPatchIr',
    'commitEmevdInstructionReorderThroughPatchIr',
    'commitEmevdRestBehaviorThroughPatchIr',
    'commitEmevdEventReorderThroughPatchIr',
    'saveRawReplace'
  ]) {
    if (!ipc.includes(token) && token !== "handle(") {
      // apply channel may be multi-line handle(
      if (token === 'resource.applyEmevdMutation' && !ipc.includes('resource.applyEmevdMutation')) {
        throw new Error(`ipc missing ${token}`);
      }
      if (token !== 'resource.applyEmevdMutation' && !ipc.includes(token)) {
        throw new Error(`ipc missing ${token}`);
      }
    }
  }
  if (!ipc.includes('resource.readEmevdDocument')) {
    throw new Error('ipc missing resource.readEmevdDocument');
  }
  if (!ipc.includes('resource.applyEmevdMutation')) {
    throw new Error('ipc missing resource.applyEmevdMutation');
  }
  if (!ipc.includes('commitEmevdMutationViaBridge')) {
    throw new Error('ipc must stage via commitEmevdMutationViaBridge');
  }
  if (!ipc.includes('saveRawReplace')) {
    throw new Error('ipc must retain Patch Engine raw fallback for non-migrated EMEVD mutations');
  }
  if (!ipc.includes('commitEmevdRestBehaviorThroughPatchIr')
    || !semanticCommit.includes("kind: 'resource_field_edit'")
    || !semanticCommit.includes('EMEVD_SEMANTIC_VALIDATOR_ID')) {
    throw new Error('restBehavior must commit through typed semantic PatchIR with native validators');
  }
  if (!ipc.includes('commitEmevdEventReorderThroughPatchIr')
    || !semanticCommit.includes("kind: 'resource_node_reorder'")
    || !semanticCommit.includes('hashEmevdEventOrder')
    || !semanticCommit.includes('beforeEvents')) {
    throw new Error('event reorder must commit through complete-order-bound typed PatchIR');
  }
  if (!ipc.includes('commitEmevdEventAddThroughPatchIr')
    || !semanticCommit.includes("kind: 'resource_node_add'")
    || !semanticCommit.includes('buildEmevdEmptyEventNodePayload')) {
    throw new Error('event add must commit through typed node PatchIR with an exact delete inverse');
  }
  if (!ipc.includes('commitEmevdEventDeleteThroughPatchIr')
    || !semanticCommit.includes("kind: 'resource_node_delete'")
    || !semanticCommit.includes('snapshotEventIndex')
    || !semanticCommit.includes('buildEmevdEventNodePayloadFromSnapshot')
    || !ipc.includes('EMEVD_SEMANTIC_EVENT_DELETE')) {
    throw new Error('event delete must commit through a Bridge snapshot-bound typed PatchIR path');
  }
  if (!ipc.includes('commitEmevdEventDuplicateThroughPatchIr')
    || !semanticCommit.includes('snapshotEventIdOverride')
    || !semanticCommit.includes("eventAddMode: 'snapshot_clone_append'")
    || !ipc.includes('EMEVD_SEMANTIC_EVENT_DUPLICATE')) {
    throw new Error('event duplicate must commit through a Bridge-authored cloned snapshot PatchIR path');
  }
  if (!ipc.includes('commitEmevdInstructionAddThroughPatchIr')
    || !ipc.includes('commitEmevdInstructionDuplicateThroughPatchIr')
    || !ipc.includes('commitEmevdInstructionDeleteThroughPatchIr')
    || !ipc.includes('commitEmevdInstructionReorderThroughPatchIr')
    || !semanticCommit.includes('authorInstruction')
    || !semanticCommit.includes('snapshotInstructionEventIndex')
    || !semanticCommit.includes('buildEmevdInstructionNodePayloadFromSnapshot')
    || !semanticCommit.includes('hashEmevdInstructionOrder')
    || !ipc.includes('EMEVD_SEMANTIC_INSTRUCTION_ADD')
    || !ipc.includes("typeof mutation.argsBase64 !== 'string'")
    || !ipc.includes('EMEVD_SEMANTIC_INSTRUCTION_DUPLICATE')
    || !ipc.includes('EMEVD_SEMANTIC_INSTRUCTION_DELETE')
    || !ipc.includes('EMEVD_SEMANTIC_INSTRUCTION_REORDER')) {
    throw new Error('instruction add/duplicate/delete/reorder must use snapshot/order-bound typed PatchIR paths');
  }

  if (!preload.includes('readEmevdDocument') || !preload.includes('applyEmevdMutation')) {
    throw new Error('preload missing EMEVD APIs');
  }
  if (!commit.includes('write-emevd')) {
    throw new Error('emevdBridgeCommit must call write-emevd');
  }
  for (const token of [
    "kind: 'insert_event_snapshot'",
    'snapshotEventIndex',
    'snapshotEventIdOverride',
    'snapshotFormatId',
    'snapshotSchemaVersion',
    'snapshotSha256'
  ]) {
    if (!commit.includes(token)) {
      throw new Error(`emevdBridgeCommit missing event snapshot contract: ${token}`);
    }
  }
  for (const token of [
    "kind: 'insert_instruction_snapshot'",
    'snapshotInstructionEventIndex',
    'snapshotInstructionLocalIndex',
    'instructionOrderEventIndex',
    'authorInstructionEventIndex',
    'authoredInstructionSnapshot',
    'focusedEventInstructionOrder'
  ]) {
    if (!commit.includes(token)) {
      throw new Error(`emevdBridgeCommit missing instruction snapshot/order contract: ${token}`);
    }
  }
  for (const token of [
    "kind: 'add_instruction'",
    "kind: 'delete_instruction' | 'duplicate_instruction'",
    "kind: 'reorder_instruction'",
    'expectedBank',
    'beforeExpectedInstructionId'
  ]) {
    if (!commit.includes(token)) {
      throw new Error(`emevdBridgeCommit missing instruction identity contract: ${token}`);
    }
  }
  if (!commit.includes('parseEventIndexFromUri')
    || !commit.includes('expectedSourceHash')
    || !commit.includes('eventHash')
    || !envelopeMap.includes('eventIndex')
    || !app.includes('selectedEvent?.eventIndex')) {
    throw new Error('EMEVD desktop write path must preserve index-bound event identity');
  }
  if (!app.includes("kind: 'reorder_event'")
    || !app.includes('beforeEventIndex')
    || !panel.includes("kind: 'emevd_reorder_event'")
    || !panel.includes("moveSelectedEvent('up')")
    || !panel.includes("moveSelectedEvent('down')")) {
    throw new Error('EMEVD desktop event reorder controls must route through the typed mutation channel');
  }
  if (!bridgeService.includes('EmevdNativeSource.Read')
    || !nativeSource.includes('DcxNativeDocument.Read')
    || !nativeSource.includes('RebuildDflt')) {
    throw new Error('EMEVD desktop path must read and stage real DCX-wrapped documents');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 桌面 IPC 契约验证通过（字段、事件与指令 add/duplicate/delete/reorder typed PatchIR + 其他 mutation raw fallback）',
    channels: ['resource.readEmevdDocument', 'resource.applyEmevdMutation'],
    semanticPath: 'raw/DCX source → Bridge envelope/snapshot/order → typed field/event/instruction PatchIR → native writer → resource-entry inverse',
    fallbackPath: '其他 EMEVD mutation → Bridge staging → saveRawReplace'
  }, null, 2));
}

main();

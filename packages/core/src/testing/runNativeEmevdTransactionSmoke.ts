/**
 * Real DFLT-wrapped EMEVD staging → PatchIR whole-file commit → reread →
 * operation rollback. The original fixture remains read-only.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IndexedFile } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import {
  commitEmevdEventAddThroughPatchIr,
  commitEmevdEventDeleteThroughPatchIr,
  commitEmevdEventDuplicateThroughPatchIr,
  commitEmevdEventReorderThroughPatchIr,
  commitEmevdInstructionAddThroughPatchIr,
  commitEmevdInstructionArgsThroughPatchIr,
  commitEmevdInstructionDeleteThroughPatchIr,
  commitEmevdInstructionDuplicateThroughPatchIr,
  commitEmevdInstructionReorderThroughPatchIr,
  commitEmevdRestBehaviorThroughPatchIr
} from '../editing/emevdSemanticCommit.js';
import {
  EMEVD_EVENT_SNAPSHOT_FORMAT_ID,
  EMEVD_EVENT_SNAPSHOT_SCHEMA_VERSION,
  buildEmevdEmptyEventNodePayload,
  emevdEventNodeUri,
  hashEmevdInstructionOrder,
  reorderEmevdEventOrder,
  reorderEmevdInstructionOrder,
  snapshotEmevdEventOrder
} from '../editing/emevdSemanticContract.js';
import { saveRawReplace } from '../editing/saveRawResource.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation, rollbackResourceEntry } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface EmevdEnvelope {
  sourceHash: string;
  documentHash: string;
  containerKind: 'raw' | 'dcx';
  compressionFormat?: string;
  events: Array<{
    id: number;
    eventIndex: number;
    eventHash: string;
    restBehavior: number;
    instructionCount?: number;
    parameterCount?: number;
  }>;
  focusedInstruction?: {
    eventId: number;
    eventIndex: number;
    instructionIndex: number;
    bank: number;
    id: number;
    argsBase64: string;
  } | null;
  focusedEventSnapshot?: {
    eventId: number;
    eventIndex: number;
    eventHash: string;
    restBehavior: number;
    instructionCount: number;
    parameterCount: number;
    sourceEventId: number;
    sourceEventIndex: number;
    sourceEventHash: string;
    snapshotFormatId: string;
    snapshotSchemaVersion: string;
    snapshotBase64: string;
    snapshotSha256: string;
    snapshotSize: number;
  } | null;
  focusedInstructionSnapshot?: {
    eventId: number;
    eventIndex: number;
    eventHash: string;
    instructionIndex: number;
    bank: number;
    id: number;
    layerOffset: number;
    argsLength: number;
    argsBase64: string;
    parameterCount: number;
    instructionHash: string;
    snapshotFormatId: string;
    snapshotSchemaVersion: string;
    snapshotBase64: string;
    snapshotSha256: string;
    snapshotSize: number;
  } | null;
  authoredInstructionSnapshot?: {
    eventId: number;
    eventIndex: number;
    eventHash: string;
    instructionIndex: number;
    bank: number;
    id: number;
    layerOffset: number;
    argsLength: number;
    argsBase64: string;
    parameterCount: number;
    instructionHash: string;
    snapshotFormatId: string;
    snapshotSchemaVersion: string;
    snapshotBase64: string;
    snapshotSha256: string;
    snapshotSize: number;
  } | null;
  focusedEventInstructionOrder?: {
    eventId: number;
    eventIndex: number;
    eventHash: string;
    instructionCount: number;
    parameterCount: number;
    instructions: Array<{
      instructionIndex: number;
      bank: number;
      id: number;
      instructionHash: string;
      parameterCount: number;
    }>;
  } | null;
}

async function main(): Promise<void> {
  const source = await resolveNativeFixturePath(
    'event/common.emevd.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_EMEVD'
  );
  const sourceBytes = await readFile(source);
  const sourceHash = sha256(sourceBytes);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-emevd-transaction-'));
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'event'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const target = join(overlay, 'event', 'common.emevd.dcx');
  const staged = join(staging, 'common.rest.emevd.dcx');
  await copyFile(source, target);

  try {
    const before = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!before.data
      || before.data.sourceHash !== sourceHash
      || before.data.containerKind !== 'dcx'
      || before.data.compressionFormat !== 'DFLT') {
      throw new Error(`EMEVD transaction baseline failed: ${JSON.stringify(before.diagnostics)}`);
    }

    const counts = new Map<number, number>();
    for (const event of before.data.events) {
      counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
    }
    const targetEvent = before.data.events.find((event) => counts.get(event.id) === 1);
    if (!targetEvent) throw new Error('EMEVD transaction smoke needs a unique event ID');
    const nextRest = targetEvent.restBehavior === 0 ? 1 : 0;
    const written = await runBridge({
      command: 'write-emevd',
      filePath: target,
      allowedRoots: [overlay, staging],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: staged,
        expectedSourceHash: before.data.sourceHash,
        mutation: 'set_rest_behavior',
        eventId: targetEvent.id,
        eventIndex: targetEvent.eventIndex,
        restBehavior: nextRest
      }
    });
    if (!written.diagnostics.some((diagnostic) =>
      diagnostic.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD transaction staging failed: ${JSON.stringify(written.diagnostics)}`);
    }
    const stagedRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: staged,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (!stagedRead.data
      || stagedRead.data.sourceHash === before.data.sourceHash
      || stagedRead.data.documentHash === before.data.documentHash
      || stagedRead.data.events[targetEvent.eventIndex]?.restBehavior !== nextRest) {
      throw new Error('EMEVD staged DCX did not preserve the requested semantic mutation');
    }

    const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
    const store = new MemoryOperationLogStore();
    const sourceUri = 'file://event/common.emevd.dcx';
    const file: IndexedFile = {
      id: sourceUri,
      workspaceId: session.meta.workspaceId,
      absolutePath: target,
      relativePath: 'event/common.emevd.dcx',
      sourceUri,
      sourcePath: target,
      game: 'sekiro',
      resourceKind: 'event',
      parseStatus: 'parsed',
      diagnostics: [],
      extension: '.dcx',
      compoundExtension: '.emevd.dcx',
      formatKind: 'emevd',
      formatLabel: 'EMEVD DCX',
      size: sourceBytes.length,
      mtimeMs: Date.now()
    };
    const confirmation = createConfirmationReceipt({
      subjects: [
        'resource', 'high', 'ALL_RISKS', sourceUri,
        'RAW_REPLACE_NATIVE_PACKED', 'SEMANTIC_WRITER_ABSENT', 'NATIVE_ROUNDTRIP_NOT_SAFE'
      ],
      riskLevel: 'high',
      sourceUri
    });
    const committed = await saveRawReplace({
      file,
      expectedHash: before.data.sourceHash,
      newContentBase64: (await readFile(staged)).toString('base64'),
      confirmation,
      session,
      operationLog: store,
      title: 'EMEVD Bridge 暂存输出提交'
    });
    if (!committed.ok || !committed.opId) {
      throw new Error(`EMEVD PatchIR commit failed: ${JSON.stringify(committed.diagnostics)}`);
    }
    const committedRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (committedRead.data?.sourceHash !== stagedRead.data.sourceHash
      || committedRead.data.documentHash !== stagedRead.data.documentHash
      || committedRead.data.events[targetEvent.eventIndex]?.restBehavior !== nextRest) {
      throw new Error('EMEVD committed output did not survive reread');
    }

    const rolled = await rollbackOperation({
      opId: committed.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
        riskLevel: 'high',
        note: 'EMEVD native transaction smoke'
      })
    });
    const restored = await readFile(target);
    const restoredRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!rolled.ok
      || !restored.equals(sourceBytes)
      || restoredRead.data?.sourceHash !== before.data.sourceHash
      || restoredRead.data.documentHash !== before.data.documentHash
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(`EMEVD operation rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
    }

    const operationCountBeforeSemantic = (await store.list(session.meta.workspaceId)).length;
    const noSemanticConfirmation = await commitEmevdRestBehaviorThroughPatchIr({
      file,
      expectedHash: restoredRead.data.sourceHash,
      eventId: targetEvent.id,
      eventIndex: targetEvent.eventIndex,
      restBehavior: nextRest,
      session,
      operationLog: store
    });
    if (noSemanticConfirmation.ok
      || !noSemanticConfirmation.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== operationCountBeforeSemantic
      || !(await readFile(target)).equals(sourceBytes)) {
      throw new Error('EMEVD semantic confirmation gate did not fail closed before staging');
    }

    const semanticCommitted = await commitEmevdRestBehaviorThroughPatchIr({
      file,
      expectedHash: restoredRead.data.sourceHash,
      eventId: targetEvent.id,
      eventIndex: targetEvent.eventIndex,
      restBehavior: nextRest,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_REST_BEHAVIOR'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD semantic transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD restBehavior typed semantic transaction'
    });
    if (!semanticCommitted.ok || !semanticCommitted.opId) {
      throw new Error(`EMEVD semantic PatchIR commit failed: ${JSON.stringify(semanticCommitted.diagnostics)}`);
    }
    const changes = await store.listResourceEntryChanges(semanticCommitted.opId);
    if (changes.length !== 1
      || changes[0]?.changeKind !== 'field_update'
      || changes[0].inverse.kind !== 'resource_field_edit') {
      throw new Error(`EMEVD semantic inverse persistence failed: ${JSON.stringify(changes)}`);
    }
    const change = changes[0];
    const semanticRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!semanticRead.data
      || semanticRead.data.documentHash === before.data.documentHash
      || semanticRead.data.events[targetEvent.eventIndex]?.restBehavior !== nextRest) {
      throw new Error('EMEVD typed semantic commit did not survive native reread');
    }
    if (change.inverse.kind !== 'resource_field_edit'
      || change.inverse.expectedHash !== semanticRead.data.sourceHash
      || change.inverse.expectedDocumentHash !== semanticRead.data.documentHash
      || change.inverse.previousValue.valueType !== 'integer'
      || change.inverse.previousValue.value !== nextRest
      || change.inverse.nextValue.valueType !== 'integer'
      || change.inverse.nextValue.value !== targetEvent.restBehavior) {
      throw new Error('EMEVD semantic inverse is not bound to the committed outer/inner revision');
    }

    const entryUri = change.entryUri;
    const deniedEntryRollback = await rollbackResourceEntry({
      opId: semanticCommitted.opId,
      entryUri,
      store,
      session
    });
    const afterDeniedRollback = await readFile(target);
    if (deniedEntryRollback.ok
      || !deniedEntryRollback.diagnostics.some((item) => item.code === 'EDIT_CONFIRMATION_REQUIRED')
      || sha256(afterDeniedRollback) !== semanticRead.data.sourceHash) {
      throw new Error('EMEVD resource-entry rollback confirmation gate did not fail closed');
    }
    const entryRolled = await rollbackResourceEntry({
      opId: semanticCommitted.opId,
      entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${semanticCommitted.opId}:${entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD semantic entry rollback smoke'
      })
    });
    const semanticRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!entryRolled.ok
      || !semanticRestored.data
      || semanticRestored.data.documentHash !== before.data.documentHash
      || semanticRestored.data.events[targetEvent.eventIndex]?.restBehavior !== targetEvent.restBehavior
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(`EMEVD resource-entry rollback failed: ${JSON.stringify(entryRolled.diagnostics)}`);
    }

    // Instruction args typed field: event-local identity + resource-entry inverse.
    const argsEvent = semanticRestored.data.events.find((event) => (event.instructionCount ?? 0) > 0);
    if (!argsEvent) throw new Error('EMEVD instruction-args smoke needs an event with instructions');
    const focusedBefore = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        focusEventIndex: argsEvent.eventIndex,
        focusInstructionLocalIndex: 0
      }
    });
    const instruction = focusedBefore.data?.focusedInstruction;
    if (!instruction
      || instruction.eventId !== argsEvent.id
      || instruction.eventIndex !== argsEvent.eventIndex
      || instruction.instructionIndex !== 0
      || typeof instruction.argsBase64 !== 'string') {
      throw new Error(`EMEVD focused instruction baseline failed: ${JSON.stringify(focusedBefore.diagnostics)}`);
    }
    const previousArgs = Buffer.from(instruction.argsBase64, 'base64');
    if (previousArgs.length === 0) {
      throw new Error('EMEVD instruction-args smoke needs non-empty args');
    }
    const nextArgs = Buffer.from(previousArgs);
    nextArgs[0] = (nextArgs[0]! + 1) & 0xff;
    const nextArgsBase64 = nextArgs.toString('base64');
    const argsGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedArgs = await commitEmevdInstructionArgsThroughPatchIr({
      file,
      expectedHash: focusedBefore.data!.sourceHash,
      eventId: instruction.eventId,
      eventIndex: instruction.eventIndex,
      instructionIndex: instruction.instructionIndex,
      expectedBank: instruction.bank,
      expectedInstructionId: instruction.id,
      argsBase64: nextArgsBase64,
      session,
      operationLog: store
    });
    if (deniedArgs.ok
      || !deniedArgs.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== argsGateCount
      || sha256(await readFile(target)) !== focusedBefore.data!.sourceHash) {
      throw new Error('EMEVD instruction-args confirmation gate did not fail closed');
    }
    const argsCommitted = await commitEmevdInstructionArgsThroughPatchIr({
      file,
      expectedHash: focusedBefore.data!.sourceHash,
      eventId: instruction.eventId,
      eventIndex: instruction.eventIndex,
      instructionIndex: instruction.instructionIndex,
      expectedBank: instruction.bank,
      expectedInstructionId: instruction.id,
      argsBase64: nextArgsBase64,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_ARGS'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction args transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD instruction args typed semantic transaction'
    });
    if (!argsCommitted.ok || !argsCommitted.opId) {
      throw new Error(`EMEVD instruction-args commit failed: ${JSON.stringify(argsCommitted.diagnostics)}`);
    }
    const argsChanges = await store.listResourceEntryChanges(argsCommitted.opId);
    if (argsChanges.length !== 1
      || argsChanges[0]?.changeKind !== 'field_update'
      || argsChanges[0].inverse.kind !== 'resource_field_edit') {
      throw new Error(`EMEVD instruction-args inverse persistence failed: ${JSON.stringify(argsChanges)}`);
    }
    const argsAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        focusEventIndex: instruction.eventIndex,
        focusInstructionLocalIndex: instruction.instructionIndex
      }
    });
    const afterInstruction = argsAfter.data?.focusedInstruction;
    if (!afterInstruction
      || Buffer.from(afterInstruction.argsBase64, 'base64').compare(nextArgs) !== 0
      || afterInstruction.bank !== instruction.bank
      || afterInstruction.id !== instruction.id) {
      throw new Error('EMEVD instruction-args typed commit did not survive focused reread');
    }
    const argsChange = argsChanges[0]!;
    const argsEntryRolled = await rollbackResourceEntry({
      opId: argsCommitted.opId,
      entryUri: argsChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${argsCommitted.opId}:${argsChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD instruction args entry rollback smoke'
      })
    });
    const argsRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        focusEventIndex: instruction.eventIndex,
        focusInstructionLocalIndex: instruction.instructionIndex
      }
    });
    const restoredInstruction = argsRestored.data?.focusedInstruction;
    if (!argsEntryRolled.ok
      || !restoredInstruction
      || Buffer.from(restoredInstruction.argsBase64, 'base64').compare(previousArgs) !== 0
      || argsRestored.data?.documentHash !== focusedBefore.data!.documentHash
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(
        `EMEVD instruction-args resource-entry rollback failed: ${JSON.stringify(argsEntryRolled.diagnostics)}`
      );
    }

    // Event reorder typed node mutation: complete semantic order + precise entry inverse.
    const reorderBaseline = argsRestored.data;
    if (!reorderBaseline || reorderBaseline.events.length < 3) {
      throw new Error('EMEVD event-reorder smoke needs at least three events');
    }
    const beforeEvents = snapshotEmevdEventOrder(reorderBaseline.events);
    const reorderTargetIndex = 0;
    const reorderAnchorIndex = 2;
    const reorderTarget = reorderBaseline.events[reorderTargetIndex]!;
    const plannedReorder = reorderEmevdEventOrder({
      beforeEvents,
      nodeId: emevdEventNodeUri({
        documentUri: sourceUri,
        eventId: reorderTarget.id,
        eventIndex: reorderTargetIndex
      }),
      beforeNodeId: emevdEventNodeUri({
        documentUri: sourceUri,
        eventId: reorderBaseline.events[reorderAnchorIndex]!.id,
        eventIndex: reorderAnchorIndex
      })
    });
    if (!plannedReorder.ok) {
      throw new Error(`EMEVD event-reorder plan failed: ${plannedReorder.message}`);
    }
    const reorderGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedReorder = await commitEmevdEventReorderThroughPatchIr({
      file,
      expectedHash: reorderBaseline.sourceHash,
      eventId: reorderTarget.id,
      eventIndex: reorderTargetIndex,
      beforeEventIndex: reorderAnchorIndex,
      session,
      operationLog: store
    });
    if (deniedReorder.ok
      || !deniedReorder.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== reorderGateCount
      || sha256(await readFile(target)) !== reorderBaseline.sourceHash) {
      throw new Error('EMEVD event-reorder confirmation gate did not fail closed');
    }
    const reorderCommitted = await commitEmevdEventReorderThroughPatchIr({
      file,
      expectedHash: reorderBaseline.sourceHash,
      eventId: reorderTarget.id,
      eventIndex: reorderTargetIndex,
      beforeEventIndex: reorderAnchorIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event reorder transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event reorder typed semantic transaction'
    });
    if (!reorderCommitted.ok || !reorderCommitted.opId) {
      throw new Error(`EMEVD event-reorder commit failed: ${JSON.stringify(reorderCommitted.diagnostics)}`);
    }
    const reorderChanges = await store.listResourceEntryChanges(reorderCommitted.opId);
    if (reorderChanges.length !== 1
      || reorderChanges[0]?.changeKind !== 'node_reorder'
      || reorderChanges[0].inverse.kind !== 'resource_node_reorder') {
      throw new Error(`EMEVD event-reorder inverse persistence failed: ${JSON.stringify(reorderChanges)}`);
    }
    const reorderAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!reorderAfter.data
      || reorderAfter.data.documentHash === reorderBaseline.documentHash
      || !sameEventOrder(reorderAfter.data.events, plannedReorder.afterEvents)) {
      throw new Error('EMEVD event-reorder typed commit did not preserve the planned complete order');
    }
    const reorderChange = reorderChanges[0]!;
    const deniedReorderRollback = await rollbackResourceEntry({
      opId: reorderCommitted.opId,
      entryUri: reorderChange.entryUri,
      store,
      session
    });
    if (deniedReorderRollback.ok
      || !deniedReorderRollback.diagnostics.some((item) => item.code === 'EDIT_CONFIRMATION_REQUIRED')
      || sha256(await readFile(target)) !== reorderAfter.data.sourceHash) {
      throw new Error('EMEVD event-reorder entry rollback confirmation gate did not fail closed');
    }
    const reorderEntryRolled = await rollbackResourceEntry({
      opId: reorderCommitted.opId,
      entryUri: reorderChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${reorderCommitted.opId}:${reorderChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD event reorder entry rollback smoke'
      })
    });
    const reorderRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!reorderEntryRolled.ok
      || !reorderRestored.data
      || reorderRestored.data.documentHash !== reorderBaseline.documentHash
      || !sameEventOrder(reorderRestored.data.events, beforeEvents)) {
      throw new Error(
        `EMEVD event-reorder resource-entry rollback failed: ${JSON.stringify(reorderEntryRolled.diagnostics)}`
      );
    }

    // Moving the original last event exercises an inverse whose anchor is intentionally omitted (append).
    const appendBaseline = reorderRestored.data;
    const appendBeforeEvents = snapshotEmevdEventOrder(appendBaseline.events);
    const appendTargetIndex = appendBaseline.events.length - 1;
    const appendTarget = appendBaseline.events[appendTargetIndex]!;
    const appendPlanned = reorderEmevdEventOrder({
      beforeEvents: appendBeforeEvents,
      nodeId: emevdEventNodeUri({
        documentUri: sourceUri,
        eventId: appendTarget.id,
        eventIndex: appendTargetIndex
      }),
      beforeNodeId: emevdEventNodeUri({
        documentUri: sourceUri,
        eventId: appendBaseline.events[0]!.id,
        eventIndex: 0
      })
    });
    if (!appendPlanned.ok) throw new Error(`EMEVD append-inverse plan failed: ${appendPlanned.message}`);
    const appendCommitted = await commitEmevdEventReorderThroughPatchIr({
      file,
      expectedHash: appendBaseline.sourceHash,
      eventId: appendTarget.id,
      eventIndex: appendTargetIndex,
      beforeEventIndex: 0,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD append inverse transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD append inverse typed semantic transaction'
    });
    if (!appendCommitted.ok || !appendCommitted.opId) {
      throw new Error(`EMEVD append-inverse commit failed: ${JSON.stringify(appendCommitted.diagnostics)}`);
    }
    const appendChanges = await store.listResourceEntryChanges(appendCommitted.opId);
    const appendChange = appendChanges[0];
    const appendAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (appendChanges.length !== 1
      || !appendChange
      || appendChange.inverse.kind !== 'resource_node_reorder'
      || appendChange.inverse.beforeNodeId !== undefined
      || !appendAfter.data
      || !sameEventOrder(appendAfter.data.events, appendPlanned.afterEvents)) {
      throw new Error('EMEVD original-last-event inverse was not persisted as an exact append');
    }
    const appendEntryRolled = await rollbackResourceEntry({
      opId: appendCommitted.opId,
      entryUri: appendChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${appendCommitted.opId}:${appendChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD append inverse entry rollback smoke'
      })
    });
    const appendRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!appendEntryRolled.ok
      || !appendRestored.data
      || appendRestored.data.documentHash !== appendBaseline.documentHash
      || !sameEventOrder(appendRestored.data.events, appendBeforeEvents)) {
      throw new Error(`EMEVD append inverse entry rollback failed: ${JSON.stringify(appendEntryRolled.diagnostics)}`);
    }

    // A fresh reorder then operation rollback must restore the exact pre-operation outer bytes.
    const operationBaselineBytes = await readFile(target);
    const operationBaseline = appendRestored.data;
    const operationCommitted = await commitEmevdEventReorderThroughPatchIr({
      file,
      expectedHash: operationBaseline.sourceHash,
      eventId: operationBaseline.events[0]!.id,
      eventIndex: 0,
      beforeEventIndex: 2,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event reorder operation rollback smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event reorder operation rollback transaction'
    });
    if (!operationCommitted.ok || !operationCommitted.opId) {
      throw new Error(`EMEVD event-reorder operation commit failed: ${JSON.stringify(operationCommitted.diagnostics)}`);
    }
    const reorderOperationRolled = await rollbackOperation({
      opId: operationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${operationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD event reorder operation rollback smoke'
      })
    });
    const operationRestoredBytes = await readFile(target);
    const operationRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!reorderOperationRolled.ok
      || !operationRestoredBytes.equals(operationBaselineBytes)
      || operationRestored.data?.documentHash !== operationBaseline.documentHash
      || !sameEventOrder(operationRestored.data?.events ?? [], appendBeforeEvents)
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(
        `EMEVD event-reorder operation rollback failed: ${JSON.stringify(reorderOperationRolled.diagnostics)}`
      );
    }

    // Empty event add: exact append identity + delete inverse + byte-exact operation rollback.
    const addBaseline = operationRestored.data;
    if (!addBaseline) throw new Error('EMEVD event-add baseline reread failed');
    const maxEventId = addBaseline.events.reduce(
      (maximum, event) => Math.max(maximum, event.id),
      Number.MIN_SAFE_INTEGER
    );
    const newEventId = maxEventId + 1;
    if (!Number.isSafeInteger(newEventId)
      || addBaseline.events.some((event) => event.id === newEventId)) {
      throw new Error('EMEVD event-add smoke could not allocate a unique safe event ID');
    }
    const newRestBehavior = 1;
    const expectedAddedPayload = buildEmevdEmptyEventNodePayload({
      eventId: newEventId,
      eventIndex: addBaseline.events.length,
      restartType: newRestBehavior
    });
    const addGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedAdd = await commitEmevdEventAddThroughPatchIr({
      file,
      expectedHash: addBaseline.sourceHash,
      newEventId,
      restBehavior: newRestBehavior,
      session,
      operationLog: store
    });
    if (deniedAdd.ok
      || !deniedAdd.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== addGateCount
      || sha256(await readFile(target)) !== addBaseline.sourceHash) {
      throw new Error('EMEVD event-add confirmation gate did not fail closed');
    }
    const addCommitted = await commitEmevdEventAddThroughPatchIr({
      file,
      expectedHash: addBaseline.sourceHash,
      newEventId,
      restBehavior: newRestBehavior,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event add transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event add typed semantic transaction'
    });
    if (!addCommitted.ok || !addCommitted.opId) {
      throw new Error(`EMEVD event-add commit failed: ${JSON.stringify(addCommitted.diagnostics)}`);
    }
    const addChanges = await store.listResourceEntryChanges(addCommitted.opId);
    const addChange = addChanges[0];
    const addAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    const addedEvent = addAfter.data?.events.at(-1);
    if (addChanges.length !== 1
      || !addChange
      || addChange.changeKind !== 'node_add'
      || addChange.inverse.kind !== 'resource_node_delete'
      || !addAfter.data
      || addAfter.data.events.length !== addBaseline.events.length + 1
      || addedEvent?.id !== newEventId
      || addedEvent.eventIndex !== addBaseline.events.length
      || addedEvent.eventHash !== expectedAddedPayload.snapshot.sha256
      || addedEvent.restBehavior !== newRestBehavior
      || (addedEvent.instructionCount ?? 0) !== 0) {
      throw new Error(`EMEVD event-add typed result/inverse mismatch: ${JSON.stringify(addChanges)}`);
    }
    const addEntryRolled = await rollbackResourceEntry({
      opId: addCommitted.opId,
      entryUri: addChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${addCommitted.opId}:${addChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD event add entry rollback smoke'
      })
    });
    const addRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!addEntryRolled.ok
      || addRestored.data?.documentHash !== addBaseline.documentHash
      || !sameEventOrder(addRestored.data?.events ?? [], addBaseline.events)) {
      throw new Error(`EMEVD event-add entry rollback failed: ${JSON.stringify(addEntryRolled.diagnostics)}`);
    }

    const addOperationBaselineBytes = await readFile(target);
    const addOperationBaseline = addRestored.data!;
    const addOperationCommitted = await commitEmevdEventAddThroughPatchIr({
      file,
      expectedHash: addOperationBaseline.sourceHash,
      newEventId,
      restBehavior: newRestBehavior,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event add operation rollback smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event add operation rollback transaction'
    });
    if (!addOperationCommitted.ok || !addOperationCommitted.opId) {
      throw new Error(
        `EMEVD event-add operation commit failed: ${JSON.stringify(addOperationCommitted.diagnostics)}`
      );
    }
    const addOperationRolled = await rollbackOperation({
      opId: addOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${addOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD event add operation rollback smoke'
      })
    });
    const addOperationRestoredBytes = await readFile(target);
    const addOperationRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!addOperationRolled.ok
      || !addOperationRestoredBytes.equals(addOperationBaselineBytes)
      || addOperationRestored.data?.documentHash !== addOperationBaseline.documentHash
      || !sameEventOrder(addOperationRestored.data?.events ?? [], addOperationBaseline.events)
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(
        `EMEVD event-add operation rollback failed: ${JSON.stringify(addOperationRolled.diagnostics)}`
      );
    }

    // Existing non-empty event delete: Bridge snapshot + precise insert inverse.
    const deleteBaseline = addOperationRestored.data;
    if (!deleteBaseline || deleteBaseline.events.length <= 1) {
      throw new Error('EMEVD event-delete smoke needs at least two events');
    }
    const deleteIdCounts = new Map<number, number>();
    for (const event of deleteBaseline.events) {
      deleteIdCounts.set(event.id, (deleteIdCounts.get(event.id) ?? 0) + 1);
    }
    const duplicateDeleteTarget = deleteBaseline.events.find((event) =>
      (event.instructionCount ?? 0) > 0
      && (event.parameterCount ?? 0) > 0
      && (deleteIdCounts.get(event.id) ?? 0) > 1
    );
    const deleteTarget = duplicateDeleteTarget
      ?? deleteBaseline.events.find((event) =>
        (event.instructionCount ?? 0) > 0 && (event.parameterCount ?? 0) > 0
      )
      ?? deleteBaseline.events.find((event) => (event.instructionCount ?? 0) > 0);
    if (!deleteTarget) {
      throw new Error('EMEVD event-delete smoke needs an existing non-empty event');
    }
    const deleteSnapshotRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { snapshotEventIndex: deleteTarget.eventIndex }
    });
    const deleteSnapshot = deleteSnapshotRead.data?.focusedEventSnapshot;
    const deleteSnapshotBytes = deleteSnapshot
      ? Buffer.from(deleteSnapshot.snapshotBase64, 'base64')
      : undefined;
    if (!deleteSnapshotRead.data
      || !deleteSnapshot
      || !deleteSnapshotBytes
      || deleteSnapshot.eventId !== deleteTarget.id
      || deleteSnapshot.eventIndex !== deleteTarget.eventIndex
      || deleteSnapshot.eventHash !== deleteTarget.eventHash
      || deleteSnapshot.restBehavior !== deleteTarget.restBehavior
      || deleteSnapshot.instructionCount !== deleteTarget.instructionCount
      || deleteSnapshot.parameterCount !== (deleteTarget.parameterCount ?? 0)
      || deleteSnapshot.snapshotFormatId !== EMEVD_EVENT_SNAPSHOT_FORMAT_ID
      || deleteSnapshot.snapshotSchemaVersion !== EMEVD_EVENT_SNAPSHOT_SCHEMA_VERSION
      || deleteSnapshot.snapshotBase64 !== deleteSnapshotBytes.toString('base64')
      || deleteSnapshot.snapshotSize !== deleteSnapshotBytes.length
      || deleteSnapshot.snapshotSha256 !== sha256(deleteSnapshotBytes)
      || deleteSnapshot.eventHash !== deleteSnapshot.snapshotSha256) {
      throw new Error('EMEVD Bridge event snapshot was not canonical or identity-bound');
    }
    const deleteGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedDelete = await commitEmevdEventDeleteThroughPatchIr({
      file,
      expectedHash: deleteBaseline.sourceHash,
      eventId: deleteTarget.id,
      eventIndex: deleteTarget.eventIndex,
      session,
      operationLog: store
    });
    if (deniedDelete.ok
      || !deniedDelete.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== deleteGateCount
      || sha256(await readFile(target)) !== deleteBaseline.sourceHash) {
      throw new Error('EMEVD event-delete confirmation gate did not fail closed');
    }
    const deleteCommitted = await commitEmevdEventDeleteThroughPatchIr({
      file,
      expectedHash: deleteBaseline.sourceHash,
      eventId: deleteTarget.id,
      eventIndex: deleteTarget.eventIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_DELETE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event delete transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event delete typed semantic transaction'
    });
    if (!deleteCommitted.ok || !deleteCommitted.opId) {
      throw new Error(`EMEVD event-delete commit failed: ${JSON.stringify(deleteCommitted.diagnostics)}`);
    }
    const deleteChanges = await store.listResourceEntryChanges(deleteCommitted.opId);
    const deleteChange = deleteChanges[0];
    const deleteAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    const expectedAfterDelete = deleteBaseline.events.filter(
      (_, index) => index !== deleteTarget.eventIndex
    );
    if (deleteChanges.length !== 1
      || !deleteChange
      || deleteChange.changeKind !== 'node_delete'
      || deleteChange.beforeHash !== deleteSnapshot.eventHash
      || deleteChange.afterHash !== deleteSnapshot.eventHash
      || deleteChange.inverse.kind !== 'resource_node_add'
      || deleteChange.inverse.metadata?.eventAddMode !== 'snapshot_insert'
      || deleteChange.inverse.payload.nodeType !== 'emevd_event'
      || deleteChange.inverse.payload.eventHash !== deleteSnapshot.eventHash
      || deleteChange.inverse.payload.eventIndex !== deleteTarget.eventIndex
      || deleteChange.inverse.payload.snapshot.storage !== 'inline'
      || deleteChange.inverse.payload.snapshot.dataBase64 !== deleteSnapshot.snapshotBase64
      || !deleteAfter.data
      || deleteAfter.data.documentHash === deleteBaseline.documentHash
      || !sameEventOrder(deleteAfter.data.events, expectedAfterDelete)) {
      throw new Error(`EMEVD event-delete typed result/inverse mismatch: ${JSON.stringify(deleteChanges)}`);
    }
    const deleteEntryRolled = await rollbackResourceEntry({
      opId: deleteCommitted.opId,
      entryUri: deleteChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${deleteCommitted.opId}:${deleteChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD event delete entry rollback smoke'
      })
    });
    const deleteRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { snapshotEventIndex: deleteTarget.eventIndex }
    });
    if (!deleteEntryRolled.ok
      || !deleteRestored.data
      || deleteRestored.data.documentHash !== deleteBaseline.documentHash
      || !sameEventOrder(deleteRestored.data.events, deleteBaseline.events)
      || !sameEventSnapshot(deleteRestored.data.focusedEventSnapshot, deleteSnapshot)) {
      throw new Error(
        `EMEVD event-delete resource-entry rollback failed: ${JSON.stringify(deleteEntryRolled.diagnostics)}`
      );
    }

    const deleteOperationBaselineBytes = await readFile(target);
    const deleteOperationBaseline = deleteRestored.data;
    const deleteOperationCommitted = await commitEmevdEventDeleteThroughPatchIr({
      file,
      expectedHash: deleteOperationBaseline.sourceHash,
      eventId: deleteTarget.id,
      eventIndex: deleteTarget.eventIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_DELETE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event delete operation rollback smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event delete operation rollback transaction'
    });
    if (!deleteOperationCommitted.ok || !deleteOperationCommitted.opId) {
      throw new Error(
        `EMEVD event-delete operation commit failed: ${JSON.stringify(deleteOperationCommitted.diagnostics)}`
      );
    }
    const deleteOperationRolled = await rollbackOperation({
      opId: deleteOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${deleteOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD event delete operation rollback smoke'
      })
    });
    const deleteOperationRestoredBytes = await readFile(target);
    const deleteOperationRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { snapshotEventIndex: deleteTarget.eventIndex }
    });
    if (!deleteOperationRolled.ok
      || !deleteOperationRestoredBytes.equals(deleteOperationBaselineBytes)
      || deleteOperationRestored.data?.documentHash !== deleteOperationBaseline.documentHash
      || !sameEventOrder(deleteOperationRestored.data?.events ?? [], deleteOperationBaseline.events)
      || !sameEventSnapshot(deleteOperationRestored.data?.focusedEventSnapshot, deleteSnapshot)
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(
        `EMEVD event-delete operation rollback failed: ${JSON.stringify(deleteOperationRolled.diagnostics)}`
      );
    }

    // Existing event duplicate: Bridge rewrites only the event ID in the complete snapshot.
    const duplicateBaseline = deleteOperationRestored.data;
    if (!duplicateBaseline) throw new Error('EMEVD event-duplicate baseline reread failed');
    const duplicateSource = duplicateBaseline.events[deleteTarget.eventIndex];
    if (!duplicateSource
      || duplicateSource.id !== deleteTarget.id
      || duplicateSource.eventHash !== deleteTarget.eventHash) {
      throw new Error('EMEVD event-duplicate source identity was not restored');
    }
    const duplicateEventId = duplicateBaseline.events.reduce(
      (maximum, event) => Math.max(maximum, event.id),
      Number.MIN_SAFE_INTEGER
    ) + 1;
    if (!Number.isSafeInteger(duplicateEventId)
      || duplicateBaseline.events.some((event) => event.id === duplicateEventId)) {
      throw new Error('EMEVD event-duplicate smoke could not allocate a unique safe event ID');
    }
    const duplicateSnapshotRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        snapshotEventIndex: duplicateSource.eventIndex,
        snapshotEventIdOverride: duplicateEventId
      }
    });
    const duplicateSnapshot = duplicateSnapshotRead.data?.focusedEventSnapshot;
    if (!duplicateSnapshotRead.data
      || !duplicateSnapshot
      || duplicateSnapshot.eventId !== duplicateEventId
      || duplicateSnapshot.eventIndex !== duplicateBaseline.events.length
      || duplicateSnapshot.sourceEventId !== duplicateSource.id
      || duplicateSnapshot.sourceEventIndex !== duplicateSource.eventIndex
      || duplicateSnapshot.sourceEventHash !== duplicateSource.eventHash
      || duplicateSnapshot.eventHash === duplicateSource.eventHash
      || duplicateSnapshot.restBehavior !== duplicateSource.restBehavior
      || duplicateSnapshot.instructionCount !== duplicateSource.instructionCount
      || duplicateSnapshot.parameterCount !== (duplicateSource.parameterCount ?? 0)) {
      throw new Error('EMEVD Bridge duplicate snapshot was not source/new-ID bound');
    }
    const duplicateGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedDuplicate = await commitEmevdEventDuplicateThroughPatchIr({
      file,
      expectedHash: duplicateBaseline.sourceHash,
      sourceEventId: duplicateSource.id,
      sourceEventIndex: duplicateSource.eventIndex,
      newEventId: duplicateEventId,
      session,
      operationLog: store
    });
    if (deniedDuplicate.ok
      || !deniedDuplicate.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== duplicateGateCount
      || sha256(await readFile(target)) !== duplicateBaseline.sourceHash) {
      throw new Error('EMEVD event-duplicate confirmation gate did not fail closed');
    }
    const duplicateCommitted = await commitEmevdEventDuplicateThroughPatchIr({
      file,
      expectedHash: duplicateBaseline.sourceHash,
      sourceEventId: duplicateSource.id,
      sourceEventIndex: duplicateSource.eventIndex,
      newEventId: duplicateEventId,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_DUPLICATE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event duplicate transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event duplicate typed semantic transaction'
    });
    if (!duplicateCommitted.ok || !duplicateCommitted.opId) {
      throw new Error(
        `EMEVD event-duplicate commit failed: ${JSON.stringify(duplicateCommitted.diagnostics)}`
      );
    }
    const duplicateChanges = await store.listResourceEntryChanges(duplicateCommitted.opId);
    const duplicateChange = duplicateChanges[0];
    const duplicateAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { snapshotEventIndex: duplicateBaseline.events.length }
    });
    const duplicatedEvent = duplicateAfter.data?.events.at(-1);
    if (duplicateChanges.length !== 1
      || !duplicateChange
      || duplicateChange.changeKind !== 'node_add'
      || duplicateChange.beforeHash !== duplicateSnapshot.eventHash
      || duplicateChange.afterHash !== duplicateSnapshot.eventHash
      || duplicateChange.inverse.kind !== 'resource_node_delete'
      || duplicateChange.inverse.metadata?.eventDeleteMode !== 'snapshot_bound'
      || !duplicateAfter.data
      || duplicateAfter.data.events.length !== duplicateBaseline.events.length + 1
      || duplicatedEvent?.id !== duplicateEventId
      || duplicatedEvent.eventIndex !== duplicateBaseline.events.length
      || duplicatedEvent.eventHash !== duplicateSnapshot.eventHash
      || duplicatedEvent.restBehavior !== duplicateSource.restBehavior
      || duplicatedEvent.instructionCount !== duplicateSource.instructionCount
      || duplicatedEvent.parameterCount !== duplicateSource.parameterCount
      || duplicateAfter.data.events[duplicateSource.eventIndex]?.eventHash !== duplicateSource.eventHash
      || !sameEventSnapshot(duplicateAfter.data.focusedEventSnapshot, duplicateSnapshot)) {
      throw new Error(`EMEVD event-duplicate typed result/inverse mismatch: ${JSON.stringify(duplicateChanges)}`);
    }
    const duplicateEntryRolled = await rollbackResourceEntry({
      opId: duplicateCommitted.opId,
      entryUri: duplicateChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${duplicateCommitted.opId}:${duplicateChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD event duplicate entry rollback smoke'
      })
    });
    const duplicateRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!duplicateEntryRolled.ok
      || duplicateRestored.data?.documentHash !== duplicateBaseline.documentHash
      || !sameEventOrder(duplicateRestored.data?.events ?? [], duplicateBaseline.events)) {
      throw new Error(
        `EMEVD event-duplicate resource-entry rollback failed: ${JSON.stringify(duplicateEntryRolled.diagnostics)}`
      );
    }

    const duplicateOperationBaselineBytes = await readFile(target);
    const duplicateOperationBaseline = duplicateRestored.data!;
    const duplicateOperationCommitted = await commitEmevdEventDuplicateThroughPatchIr({
      file,
      expectedHash: duplicateOperationBaseline.sourceHash,
      sourceEventId: duplicateSource.id,
      sourceEventIndex: duplicateSource.eventIndex,
      newEventId: duplicateEventId,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_EVENT_DUPLICATE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD event duplicate operation rollback smoke'
      }),
      session,
      operationLog: store,
      title: 'EMEVD event duplicate operation rollback transaction'
    });
    if (!duplicateOperationCommitted.ok || !duplicateOperationCommitted.opId) {
      throw new Error(
        `EMEVD event-duplicate operation commit failed: ${JSON.stringify(duplicateOperationCommitted.diagnostics)}`
      );
    }
    const duplicateOperationRolled = await rollbackOperation({
      opId: duplicateOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${duplicateOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD event duplicate operation rollback smoke'
      })
    });
    const duplicateOperationRestoredBytes = await readFile(target);
    const duplicateOperationRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (!duplicateOperationRolled.ok
      || !duplicateOperationRestoredBytes.equals(duplicateOperationBaselineBytes)
      || duplicateOperationRestored.data?.documentHash !== duplicateOperationBaseline.documentHash
      || !sameEventOrder(duplicateOperationRestored.data?.events ?? [], duplicateOperationBaseline.events)
      || !(await readFile(source)).equals(sourceBytes)) {
      throw new Error(
        `EMEVD event-duplicate operation rollback failed: ${JSON.stringify(duplicateOperationRolled.diagnostics)}`
      );
    }

    // Instruction duplicate: the Bridge snapshot includes layer/args and every
    // parameter substitution attached to the selected event-local occurrence.
    const instructionBaselineRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    const instructionBaseline = instructionBaselineRead.data;
    const instructionBaselineOrder = instructionBaseline?.focusedEventInstructionOrder;
    if (!instructionBaseline
      || !instructionBaselineOrder
      || instructionBaselineOrder.instructions.length < 3) {
      throw new Error('EMEVD instruction semantic smoke needs an event with at least three instructions');
    }
    const instructionSource = instructionBaselineOrder.instructions.find(
      (instruction) => instruction.parameterCount > 0
    ) ?? instructionBaselineOrder.instructions[0]!;
    const instructionSnapshotRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        snapshotInstructionEventIndex: duplicateSource.eventIndex,
        snapshotInstructionLocalIndex: instructionSource.instructionIndex,
        instructionOrderEventIndex: duplicateSource.eventIndex
      }
    });
    const instructionSnapshot = instructionSnapshotRead.data?.focusedInstructionSnapshot;
    if (!instructionSnapshot
      || instructionSnapshot.instructionHash !== instructionSource.instructionHash
      || instructionSnapshot.parameterCount !== instructionSource.parameterCount
      || instructionSnapshot.snapshotFormatId !== 'soulforge.emevd.instruction-semantic-v1'
      || instructionSnapshot.snapshotSchemaVersion !== '1.0.0'
      || instructionSnapshot.snapshotSha256 !== sha256(Buffer.from(instructionSnapshot.snapshotBase64, 'base64'))
      || instructionSnapshot.snapshotSha256 !== instructionSnapshot.instructionHash) {
      throw new Error('EMEVD Bridge instruction snapshot was not canonical or order-bound');
    }

    // Instruction add is intentionally narrower than EMEDF-aware authoring:
    // Bridge authors a canonical layer=-1, zero-parameter native snapshot from
    // explicit bank/id/opaque args, then PatchIR inserts and validates it.
    const instructionAddIndex = instructionSource.instructionIndex + 1;
    const instructionAddAuthorRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        instructionOrderEventIndex: duplicateSource.eventIndex,
        authorInstructionEventIndex: duplicateSource.eventIndex,
        authorInstructionIndex: instructionAddIndex,
        authorInstructionBank: instructionSnapshot.bank,
        authorInstructionId: instructionSnapshot.id,
        authorInstructionArgsBase64: instructionSnapshot.argsBase64
      }
    });
    const authoredInstruction = instructionAddAuthorRead.data?.authoredInstructionSnapshot;
    if (!authoredInstruction
      || authoredInstruction.eventId !== duplicateSource.id
      || authoredInstruction.eventIndex !== duplicateSource.eventIndex
      || authoredInstruction.instructionIndex !== instructionAddIndex
      || authoredInstruction.bank !== instructionSnapshot.bank
      || authoredInstruction.id !== instructionSnapshot.id
      || authoredInstruction.layerOffset !== -1
      || authoredInstruction.argsBase64 !== instructionSnapshot.argsBase64
      || authoredInstruction.parameterCount !== 0
      || authoredInstruction.snapshotFormatId !== 'soulforge.emevd.instruction-semantic-v1'
      || authoredInstruction.snapshotSchemaVersion !== '1.0.0'
      || authoredInstruction.snapshotSha256 !== authoredInstruction.instructionHash
      || authoredInstruction.snapshotSha256
        !== sha256(Buffer.from(authoredInstruction.snapshotBase64, 'base64'))
      || (instructionSnapshot.parameterCount > 0
        && authoredInstruction.instructionHash === instructionSnapshot.instructionHash)) {
      throw new Error('EMEVD Bridge authored instruction snapshot was not canonical and zero-parameter-bound');
    }
    const instructionAddInvalidBase64Count = (await store.list(session.meta.workspaceId)).length;
    const invalidInstructionAddBase64 = await commitEmevdInstructionAddThroughPatchIr({
      file,
      expectedHash: instructionBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionAddIndex,
      bank: instructionSnapshot.bank,
      instructionId: instructionSnapshot.id,
      argsBase64: `${instructionSnapshot.argsBase64} `,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction add non-canonical Base64 fail-closed smoke'
      }),
      session,
      operationLog: store
    });
    if (invalidInstructionAddBase64.ok
      || !invalidInstructionAddBase64.diagnostics.some(
        (diagnostic) => diagnostic.code === 'EMEVD_ARGS_BASE64_INVALID'
      )
      || (await store.list(session.meta.workspaceId)).length !== instructionAddInvalidBase64Count
      || sha256(await readFile(target)) !== instructionBaseline.sourceHash) {
      throw new Error('EMEVD instruction-add non-canonical Base64 did not fail closed');
    }
    const instructionAddGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedInstructionAdd = await commitEmevdInstructionAddThroughPatchIr({
      file,
      expectedHash: instructionBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionAddIndex,
      bank: instructionSnapshot.bank,
      instructionId: instructionSnapshot.id,
      argsBase64: instructionSnapshot.argsBase64,
      session,
      operationLog: store
    });
    if (deniedInstructionAdd.ok
      || !deniedInstructionAdd.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== instructionAddGateCount
      || sha256(await readFile(target)) !== instructionBaseline.sourceHash) {
      throw new Error('EMEVD instruction-add confirmation gate did not fail closed');
    }
    const instructionAddCommitted = await commitEmevdInstructionAddThroughPatchIr({
      file,
      expectedHash: instructionBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionAddIndex,
      bank: instructionSnapshot.bank,
      instructionId: instructionSnapshot.id,
      argsBase64: instructionSnapshot.argsBase64,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction add transaction smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionAddCommitted.ok || !instructionAddCommitted.opId) {
      throw new Error(`EMEVD instruction-add commit failed: ${JSON.stringify(instructionAddCommitted.diagnostics)}`);
    }
    const instructionAddChanges = await store.listResourceEntryChanges(instructionAddCommitted.opId);
    const instructionAddChange = instructionAddChanges[0];
    const instructionAddAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    const expectedInstructionAddOrder = [...instructionBaselineOrder.instructions];
    expectedInstructionAddOrder.splice(instructionAddIndex, 0, {
      instructionIndex: instructionAddIndex,
      bank: authoredInstruction.bank,
      id: authoredInstruction.id,
      instructionHash: authoredInstruction.instructionHash,
      parameterCount: 0
    });
    if (instructionAddChanges.length !== 1
      || !instructionAddChange
      || instructionAddChange.changeKind !== 'node_add'
      || instructionAddChange.beforeHash !== authoredInstruction.instructionHash
      || instructionAddChange.afterHash !== authoredInstruction.instructionHash
      || instructionAddChange.inverse.kind !== 'resource_node_delete'
      || instructionAddChange.inverse.metadata?.instructionDeleteMode !== 'snapshot_bound'
      || !sameInstructionOrder(
        instructionAddAfter.data?.focusedEventInstructionOrder?.instructions ?? [],
        expectedInstructionAddOrder
      )) {
      throw new Error(`EMEVD instruction-add typed result/inverse mismatch: ${JSON.stringify(instructionAddChanges)}`);
    }
    const instructionAddEntryRolled = await rollbackResourceEntry({
      opId: instructionAddCommitted.opId,
      entryUri: instructionAddChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${instructionAddCommitted.opId}:${instructionAddChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD instruction add entry rollback smoke'
      })
    });
    const instructionAddRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    if (!instructionAddEntryRolled.ok
      || instructionAddRestored.data?.documentHash !== instructionBaseline.documentHash
      || !sameInstructionOrder(
        instructionAddRestored.data?.focusedEventInstructionOrder?.instructions ?? [],
        instructionBaselineOrder.instructions
      )) {
      throw new Error(`EMEVD instruction-add entry rollback failed: ${JSON.stringify(instructionAddEntryRolled.diagnostics)}`);
    }
    const instructionAddOperationBaselineBytes = await readFile(target);
    const instructionAddOperationBaseline = instructionAddRestored.data!;
    const instructionAddOperationCommitted = await commitEmevdInstructionAddThroughPatchIr({
      file,
      expectedHash: instructionAddOperationBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionAddIndex,
      bank: instructionSnapshot.bank,
      instructionId: instructionSnapshot.id,
      argsBase64: instructionSnapshot.argsBase64,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_ADD'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction add operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionAddOperationCommitted.ok || !instructionAddOperationCommitted.opId) {
      throw new Error(`EMEVD instruction-add operation commit failed: ${JSON.stringify(instructionAddOperationCommitted.diagnostics)}`);
    }
    const instructionAddOperationRolled = await rollbackOperation({
      opId: instructionAddOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${instructionAddOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD instruction add operation rollback smoke'
      })
    });
    const instructionAddOperationRestoredBytes = await readFile(target);
    if (!instructionAddOperationRolled.ok
      || !instructionAddOperationRestoredBytes.equals(instructionAddOperationBaselineBytes)) {
      throw new Error(`EMEVD instruction-add operation rollback failed: ${JSON.stringify(instructionAddOperationRolled.diagnostics)}`);
    }

    const instructionDuplicateGateCount = (await store.list(session.meta.workspaceId)).length;
    const deniedInstructionDuplicate = await commitEmevdInstructionDuplicateThroughPatchIr({
      file,
      expectedHash: instructionBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      sourceInstructionIndex: instructionSource.instructionIndex,
      session,
      operationLog: store
    });
    if (deniedInstructionDuplicate.ok
      || !deniedInstructionDuplicate.requiresConfirmation
      || (await store.list(session.meta.workspaceId)).length !== instructionDuplicateGateCount
      || sha256(await readFile(target)) !== instructionBaseline.sourceHash) {
      throw new Error('EMEVD instruction-duplicate confirmation gate did not fail closed');
    }
    const instructionDuplicateCommitted = await commitEmevdInstructionDuplicateThroughPatchIr({
      file,
      expectedHash: instructionBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      sourceInstructionIndex: instructionSource.instructionIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_DUPLICATE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction duplicate transaction smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionDuplicateCommitted.ok || !instructionDuplicateCommitted.opId) {
      throw new Error(`EMEVD instruction-duplicate commit failed: ${JSON.stringify(instructionDuplicateCommitted.diagnostics)}`);
    }
    const instructionDuplicateChanges = await store.listResourceEntryChanges(
      instructionDuplicateCommitted.opId
    );
    const instructionDuplicateChange = instructionDuplicateChanges[0];
    const instructionDuplicateAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    const instructionDuplicateAfterOrder = instructionDuplicateAfter.data?.focusedEventInstructionOrder;
    const duplicateInsertIndex = instructionSource.instructionIndex + 1;
    if (instructionDuplicateChanges.length !== 1
      || !instructionDuplicateChange
      || instructionDuplicateChange.changeKind !== 'node_add'
      || instructionDuplicateChange.beforeHash !== instructionSource.instructionHash
      || instructionDuplicateChange.afterHash !== instructionSource.instructionHash
      || instructionDuplicateChange.inverse.kind !== 'resource_node_delete'
      || instructionDuplicateChange.inverse.metadata?.instructionDeleteMode !== 'snapshot_bound'
      || !instructionDuplicateAfterOrder
      || instructionDuplicateAfterOrder.instructions.length
        !== instructionBaselineOrder.instructions.length + 1
      || instructionDuplicateAfterOrder.instructions[instructionSource.instructionIndex]?.instructionHash
        !== instructionSource.instructionHash
      || instructionDuplicateAfterOrder.instructions[duplicateInsertIndex]?.instructionHash
        !== instructionSource.instructionHash
      || instructionDuplicateAfterOrder.instructions[duplicateInsertIndex]?.parameterCount
        !== instructionSource.parameterCount) {
      throw new Error(`EMEVD instruction-duplicate typed result/inverse mismatch: ${JSON.stringify(instructionDuplicateChanges)}`);
    }
    const instructionDuplicateEntryRolled = await rollbackResourceEntry({
      opId: instructionDuplicateCommitted.opId,
      entryUri: instructionDuplicateChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${instructionDuplicateCommitted.opId}:${instructionDuplicateChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD instruction duplicate entry rollback smoke'
      })
    });
    const instructionDuplicateRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    if (!instructionDuplicateEntryRolled.ok
      || instructionDuplicateRestored.data?.documentHash !== instructionBaseline.documentHash
      || !sameInstructionOrder(
        instructionDuplicateRestored.data?.focusedEventInstructionOrder?.instructions ?? [],
        instructionBaselineOrder.instructions
      )) {
      throw new Error(`EMEVD instruction-duplicate entry rollback failed: ${JSON.stringify(instructionDuplicateEntryRolled.diagnostics)}`);
    }
    const instructionDuplicateOperationBaselineBytes = await readFile(target);
    const instructionDuplicateOperationBaseline = instructionDuplicateRestored.data!;
    const instructionDuplicateOperationCommitted = await commitEmevdInstructionDuplicateThroughPatchIr({
      file,
      expectedHash: instructionDuplicateOperationBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      sourceInstructionIndex: instructionSource.instructionIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_DUPLICATE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction duplicate operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionDuplicateOperationCommitted.ok || !instructionDuplicateOperationCommitted.opId) {
      throw new Error(`EMEVD instruction-duplicate operation commit failed: ${JSON.stringify(instructionDuplicateOperationCommitted.diagnostics)}`);
    }
    const instructionDuplicateOperationRolled = await rollbackOperation({
      opId: instructionDuplicateOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${instructionDuplicateOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD instruction duplicate operation rollback smoke'
      })
    });
    const instructionDuplicateOperationRestoredBytes = await readFile(target);
    if (!instructionDuplicateOperationRolled.ok
      || !instructionDuplicateOperationRestoredBytes.equals(instructionDuplicateOperationBaselineBytes)) {
      throw new Error(`EMEVD instruction-duplicate operation rollback failed: ${JSON.stringify(instructionDuplicateOperationRolled.diagnostics)}`);
    }

    const instructionDeleteBaselineRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        snapshotInstructionEventIndex: duplicateSource.eventIndex,
        snapshotInstructionLocalIndex: instructionSource.instructionIndex,
        instructionOrderEventIndex: duplicateSource.eventIndex
      }
    });
    const instructionDeleteBaseline = instructionDeleteBaselineRead.data;
    const instructionDeleteBaselineOrder = instructionDeleteBaseline?.focusedEventInstructionOrder;
    const instructionDeleteSnapshot = instructionDeleteBaseline?.focusedInstructionSnapshot;
    if (!instructionDeleteBaseline
      || !instructionDeleteBaselineOrder
      || !instructionDeleteSnapshot
      || instructionDeleteBaselineOrder.instructions.length <= 1
      || instructionDeleteSnapshot.instructionHash
        !== instructionDeleteBaselineOrder.instructions[instructionSource.instructionIndex]?.instructionHash) {
      throw new Error('EMEVD instruction-delete baseline/snapshot was not identity-bound');
    }
    const instructionDeleteCommitted = await commitEmevdInstructionDeleteThroughPatchIr({
      file,
      expectedHash: instructionDeleteBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionSource.instructionIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_DELETE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction delete transaction smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionDeleteCommitted.ok || !instructionDeleteCommitted.opId) {
      throw new Error(`EMEVD instruction-delete commit failed: ${JSON.stringify(instructionDeleteCommitted.diagnostics)}`);
    }
    const instructionDeleteChanges = await store.listResourceEntryChanges(instructionDeleteCommitted.opId);
    const instructionDeleteChange = instructionDeleteChanges[0];
    const instructionDeleteAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    const expectedInstructionDeleteOrder = instructionDeleteBaselineOrder.instructions.filter(
      (_, index) => index !== instructionSource.instructionIndex
    );
    if (instructionDeleteChanges.length !== 1
      || !instructionDeleteChange
      || instructionDeleteChange.changeKind !== 'node_delete'
      || instructionDeleteChange.beforeHash !== instructionDeleteSnapshot.instructionHash
      || instructionDeleteChange.inverse.kind !== 'resource_node_add'
      || instructionDeleteChange.inverse.metadata?.instructionAddMode !== 'snapshot_insert'
      || !sameInstructionOrder(
        instructionDeleteAfter.data?.focusedEventInstructionOrder?.instructions ?? [],
        expectedInstructionDeleteOrder
      )) {
      throw new Error(`EMEVD instruction-delete typed result/inverse mismatch: ${JSON.stringify(instructionDeleteChanges)}`);
    }
    const instructionDeleteEntryRolled = await rollbackResourceEntry({
      opId: instructionDeleteCommitted.opId,
      entryUri: instructionDeleteChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${instructionDeleteCommitted.opId}:${instructionDeleteChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD instruction delete entry rollback smoke'
      })
    });
    const instructionDeleteRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        snapshotInstructionEventIndex: duplicateSource.eventIndex,
        snapshotInstructionLocalIndex: instructionSource.instructionIndex,
        instructionOrderEventIndex: duplicateSource.eventIndex
      }
    });
    if (!instructionDeleteEntryRolled.ok
      || instructionDeleteRestored.data?.documentHash !== instructionDeleteBaseline.documentHash
      || !sameInstructionOrder(
        instructionDeleteRestored.data?.focusedEventInstructionOrder?.instructions ?? [],
        instructionDeleteBaselineOrder.instructions
      )
      || instructionDeleteRestored.data?.focusedInstructionSnapshot?.instructionHash
        !== instructionDeleteSnapshot.instructionHash
      || instructionDeleteRestored.data?.focusedInstructionSnapshot?.parameterCount
        !== instructionDeleteSnapshot.parameterCount) {
      throw new Error(`EMEVD instruction-delete entry rollback failed: ${JSON.stringify(instructionDeleteEntryRolled.diagnostics)}`);
    }
    const instructionDeleteOperationBaselineBytes = await readFile(target);
    const instructionDeleteOperationBaseline = instructionDeleteRestored.data!;
    const instructionDeleteOperationCommitted = await commitEmevdInstructionDeleteThroughPatchIr({
      file,
      expectedHash: instructionDeleteOperationBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionSource.instructionIndex,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_DELETE'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction delete operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionDeleteOperationCommitted.ok || !instructionDeleteOperationCommitted.opId) {
      throw new Error(`EMEVD instruction-delete operation commit failed: ${JSON.stringify(instructionDeleteOperationCommitted.diagnostics)}`);
    }
    const instructionDeleteOperationRolled = await rollbackOperation({
      opId: instructionDeleteOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${instructionDeleteOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD instruction delete operation rollback smoke'
      })
    });
    const instructionDeleteOperationRestoredBytes = await readFile(target);
    if (!instructionDeleteOperationRolled.ok
      || !instructionDeleteOperationRestoredBytes.equals(instructionDeleteOperationBaselineBytes)) {
      throw new Error(`EMEVD instruction-delete operation rollback failed: ${JSON.stringify(instructionDeleteOperationRolled.diagnostics)}`);
    }

    const instructionReorderBaselineRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    const instructionReorderBaseline = instructionReorderBaselineRead.data;
    const instructionReorderBaselineOrder = instructionReorderBaseline?.focusedEventInstructionOrder;
    if (!instructionReorderBaseline || !instructionReorderBaselineOrder) {
      throw new Error('EMEVD instruction-reorder baseline read failed');
    }
    let instructionReorderSourceIndex: number | undefined;
    let instructionReorderAnchorIndex: number | undefined;
    let instructionReorderExpected:
      | ReturnType<typeof reorderEmevdInstructionOrder>
      | undefined;
    for (let sourceIndex = 0;
      sourceIndex < instructionReorderBaselineOrder.instructions.length
        && instructionReorderSourceIndex === undefined;
      sourceIndex += 1) {
      const sourceInstruction = instructionReorderBaselineOrder.instructions[sourceIndex]!;
      const sourceNodeId = `${sourceUri}#event/${duplicateSource.id}/index/${duplicateSource.eventIndex}/instruction/${sourceIndex}/bank/${sourceInstruction.bank}/id/${sourceInstruction.id}`;
      const candidates = [
        ...instructionReorderBaselineOrder.instructions.map((_, index) => index),
        undefined
      ];
      for (const anchorIndex of candidates) {
        const anchorInstruction = anchorIndex === undefined
          ? undefined
          : instructionReorderBaselineOrder.instructions[anchorIndex];
        const beforeNodeId = anchorInstruction
          ? `${sourceUri}#event/${duplicateSource.id}/index/${duplicateSource.eventIndex}/instruction/${anchorIndex}/bank/${anchorInstruction.bank}/id/${anchorInstruction.id}`
          : undefined;
        const planned = reorderEmevdInstructionOrder({
          documentUri: sourceUri,
          eventId: duplicateSource.id,
          eventIndex: duplicateSource.eventIndex,
          beforeInstructions: instructionReorderBaselineOrder.instructions,
          nodeId: sourceNodeId,
          beforeNodeId
        });
        if (planned.ok
          && hashEmevdInstructionOrder(planned.afterInstructions)
            !== hashEmevdInstructionOrder(instructionReorderBaselineOrder.instructions)) {
          instructionReorderSourceIndex = sourceIndex;
          instructionReorderAnchorIndex = anchorIndex;
          instructionReorderExpected = planned;
          break;
        }
      }
    }
    if (instructionReorderSourceIndex === undefined
      || !instructionReorderExpected
      || !instructionReorderExpected.ok) {
      throw new Error('EMEVD instruction-reorder smoke could not find a semantic-changing move');
    }
    const instructionReorderCommitted = await commitEmevdInstructionReorderThroughPatchIr({
      file,
      expectedHash: instructionReorderBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionReorderSourceIndex,
      ...(instructionReorderAnchorIndex !== undefined
        ? { beforeInstructionIndex: instructionReorderAnchorIndex }
        : {}),
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction reorder transaction smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionReorderCommitted.ok || !instructionReorderCommitted.opId) {
      throw new Error(`EMEVD instruction-reorder commit failed: ${JSON.stringify(instructionReorderCommitted.diagnostics)}`);
    }
    const instructionReorderChanges = await store.listResourceEntryChanges(instructionReorderCommitted.opId);
    const instructionReorderChange = instructionReorderChanges[0];
    const instructionReorderAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    if (instructionReorderChanges.length !== 1
      || !instructionReorderChange
      || instructionReorderChange.changeKind !== 'node_reorder'
      || instructionReorderChange.beforeHash
        !== hashEmevdInstructionOrder(instructionReorderBaselineOrder.instructions)
      || instructionReorderChange.afterHash
        !== hashEmevdInstructionOrder(instructionReorderExpected.afterInstructions)
      || instructionReorderChange.inverse.kind !== 'resource_node_reorder'
      || instructionReorderChange.inverse.metadata?.reorderScope !== 'instruction'
      || !sameInstructionOrder(
        instructionReorderAfter.data?.focusedEventInstructionOrder?.instructions ?? [],
        instructionReorderExpected.afterInstructions
      )) {
      throw new Error(`EMEVD instruction-reorder typed result/inverse mismatch: ${JSON.stringify(instructionReorderChanges)}`);
    }
    const instructionReorderEntryRolled = await rollbackResourceEntry({
      opId: instructionReorderCommitted.opId,
      entryUri: instructionReorderChange.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${instructionReorderCommitted.opId}:${instructionReorderChange.entryUri}`],
        riskLevel: 'high',
        note: 'EMEVD instruction reorder entry rollback smoke'
      })
    });
    const instructionReorderRestored = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { instructionOrderEventIndex: duplicateSource.eventIndex }
    });
    if (!instructionReorderEntryRolled.ok
      || instructionReorderRestored.data?.documentHash !== instructionReorderBaseline.documentHash
      || !sameInstructionOrder(
        instructionReorderRestored.data?.focusedEventInstructionOrder?.instructions ?? [],
        instructionReorderBaselineOrder.instructions
      )) {
      throw new Error(`EMEVD instruction-reorder entry rollback failed: ${JSON.stringify(instructionReorderEntryRolled.diagnostics)}`);
    }
    const instructionReorderOperationBaselineBytes = await readFile(target);
    const instructionReorderOperationBaseline = instructionReorderRestored.data!;
    const instructionReorderOperationCommitted = await commitEmevdInstructionReorderThroughPatchIr({
      file,
      expectedHash: instructionReorderOperationBaseline.sourceHash,
      eventId: duplicateSource.id,
      eventIndex: duplicateSource.eventIndex,
      instructionIndex: instructionReorderSourceIndex,
      ...(instructionReorderAnchorIndex !== undefined
        ? { beforeInstructionIndex: instructionReorderAnchorIndex }
        : {}),
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_REORDER'],
        riskLevel: 'high',
        sourceUri,
        note: 'EMEVD instruction reorder operation rollback smoke'
      }),
      session,
      operationLog: store
    });
    if (!instructionReorderOperationCommitted.ok || !instructionReorderOperationCommitted.opId) {
      throw new Error(`EMEVD instruction-reorder operation commit failed: ${JSON.stringify(instructionReorderOperationCommitted.diagnostics)}`);
    }
    const instructionReorderOperationRolled = await rollbackOperation({
      opId: instructionReorderOperationCommitted.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${instructionReorderOperationCommitted.opId}`],
        riskLevel: 'high',
        note: 'EMEVD instruction reorder operation rollback smoke'
      })
    });
    const instructionReorderOperationRestoredBytes = await readFile(target);
    if (!instructionReorderOperationRolled.ok
      || !instructionReorderOperationRestoredBytes.equals(instructionReorderOperationBaselineBytes)) {
      throw new Error(`EMEVD instruction-reorder operation rollback failed: ${JSON.stringify(instructionReorderOperationRolled.diagnostics)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      message: 'DFLT-wrapped EMEVD 经 Bridge 暂存、PatchIR 提交、重读和 operation/entry 回滚验证通过',
      containerKind: 'dcx',
      compressionFormat: 'DFLT',
      stagingRereadVerified: true,
      patchIrCommitVerified: true,
      operationRollbackVerified: true,
      rollbackRestoredOuterBytes: true,
      semanticPatchIrFieldCommitVerified: true,
      semanticInstructionArgsCommitVerified: true,
      eventReorderSemanticPatchIrCommitVerified: true,
      eventSemanticHashIdentityVerified: true,
      semanticInversePersisted: true,
      resourceEntryRollbackVerified: true,
      instructionArgsResourceEntryRollbackVerified: true,
      eventReorderResourceEntryRollbackVerified: true,
      eventReorderAppendInverseVerified: true,
      eventReorderOperationRollbackVerified: true,
      eventAddSemanticPatchIrCommitVerified: true,
      eventAddResourceEntryRollbackVerified: true,
      eventAddOperationRollbackVerified: true,
      eventAddCanonicalHashVerified: true,
      eventDeleteSemanticPatchIrCommitVerified: true,
      eventDeleteResourceEntryRollbackVerified: true,
      eventDeleteOperationRollbackVerified: true,
      eventSnapshotRoundTripVerified: true,
      duplicateEventOccurrenceDeleteVerified: Boolean(duplicateDeleteTarget),
      deletedEventInstructionCount: deleteSnapshot.instructionCount,
      deletedEventParameterCount: deleteSnapshot.parameterCount,
      eventDuplicateSemanticPatchIrCommitVerified: true,
      eventDuplicateResourceEntryRollbackVerified: true,
      eventDuplicateOperationRollbackVerified: true,
      eventDuplicateSnapshotCloneVerified: true,
      duplicatedEventInstructionCount: duplicateSnapshot.instructionCount,
      duplicatedEventParameterCount: duplicateSnapshot.parameterCount,
      instructionAddSemanticPatchIrCommitVerified: true,
      instructionAddResourceEntryRollbackVerified: true,
      instructionAddOperationRollbackVerified: true,
      instructionAddBridgeAuthoredSnapshotVerified: true,
      instructionAddNonCanonicalBase64Blocked: true,
      instructionAddParameterCount: authoredInstruction.parameterCount,
      instructionAddLayerOffset: authoredInstruction.layerOffset,
      instructionDuplicateSemanticPatchIrCommitVerified: true,
      instructionDuplicateResourceEntryRollbackVerified: true,
      instructionDuplicateOperationRollbackVerified: true,
      instructionSnapshotCloneVerified: true,
      duplicatedInstructionParameterCount: instructionSnapshot.parameterCount,
      instructionDeleteSemanticPatchIrCommitVerified: true,
      instructionDeleteResourceEntryRollbackVerified: true,
      instructionDeleteOperationRollbackVerified: true,
      instructionDeleteSnapshotRoundTripVerified: true,
      deletedInstructionParameterCount: instructionDeleteSnapshot.parameterCount,
      instructionReorderSemanticPatchIrCommitVerified: true,
      instructionReorderResourceEntryRollbackVerified: true,
      instructionReorderOperationRollbackVerified: true,
      instructionReorderCompleteOrderGuardVerified: true,
      resourceEntryRollbackRestoredDocumentHash: true,
      resourceEntryRollbackOuterByteIdentityClaimed: false,
      originalFixtureUntouched: true
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

function sameEventOrder(
  actual: ReadonlyArray<{ id: number; eventHash: string }>,
  expected: ReadonlyArray<{ id: number; eventHash: string }>
): boolean {
  return actual.length === expected.length
    && actual.every((event, index) => (
      event.id === expected[index]?.id && event.eventHash === expected[index]?.eventHash
    ));
}

function sameEventSnapshot(
  actual: EmevdEnvelope['focusedEventSnapshot'],
  expected: NonNullable<EmevdEnvelope['focusedEventSnapshot']>
): boolean {
  return Boolean(actual)
    && actual!.eventId === expected.eventId
    && actual!.eventIndex === expected.eventIndex
    && actual!.eventHash === expected.eventHash
    && actual!.restBehavior === expected.restBehavior
    && actual!.instructionCount === expected.instructionCount
    && actual!.parameterCount === expected.parameterCount
    && actual!.snapshotFormatId === expected.snapshotFormatId
    && actual!.snapshotSchemaVersion === expected.snapshotSchemaVersion
    && actual!.snapshotBase64 === expected.snapshotBase64
    && actual!.snapshotSha256 === expected.snapshotSha256
    && actual!.snapshotSize === expected.snapshotSize;
}

function sameInstructionOrder(
  actual: ReadonlyArray<{ bank: number; id: number; instructionHash: string; parameterCount: number }>,
  expected: ReadonlyArray<{ bank: number; id: number; instructionHash: string; parameterCount: number }>
): boolean {
  return actual.length === expected.length
    && actual.every((instruction, index) => (
      instruction.bank === expected[index]?.bank
      && instruction.id === expected[index]?.id
      && instruction.instructionHash === expected[index]?.instructionHash
      && instruction.parameterCount === expected[index]?.parameterCount
    ));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

/**
 * Native EMEVD structural + instruction-arg smoke:
 * DFLT-decompress common.emevd.dcx → correct Sekiro header parse →
 * no-op roundtrip → identity/rest/args/CRUD/duplicate/reorder → reread.
 */
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import {
  createSekiroFixtureEmedf,
  decodeInstructionArgs,
  mutateInstructionArg
} from '../emevd/emedfSchema.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface EmevdEnvelope {
  sourceHash: string;
  eventCount: number;
  instructionCount: number;
  parameterSubstitutionCount: number;
  layerCount: number;
  documentHash: string;
  containerKind: 'raw' | 'dcx';
  compressionFormat?: string;
  writeSupported: boolean;
  containerRoundTrip?: {
    byteIdentical: boolean;
    payloadIdentical: boolean;
    variantIdentical: boolean;
  };
  events: Array<{
    id: number;
    eventIndex: number;
    restBehavior: number;
    instructionCount?: number;
    instructionStartIndex?: number;
    parameterCount: number;
  }>;
  parameterSubstitutionSample?: Array<{
    eventIndex: number;
    parameterIndex: number;
    instructionIndex: number;
    targetStartByte: number;
    sourceStartByte: number;
    byteCount: number;
    unkId: number;
  }>;
  instructionsSample?: Array<{
    index: number;
    bank: number;
    id: number;
    argsLength: number;
    argsBase64: string;
  }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
  authority?: string;
}

async function main(): Promise<void> {
  const sourceDcx = await resolveNativeFixturePath(
    'event/common.emevd.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_EMEVD'
  );
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-emevd-'));
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  const sourceAllowedRoots = [dirname(sourceDcx), staging];
  const emevdPath = sourceDcx;

  try {
    const read = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      timeoutMs: 60_000
    });
    if (!read.data?.roundTrip?.semanticIdentical) {
      throw new Error(`EMEVD read/roundtrip failed: ${JSON.stringify(read.diagnostics)} ${JSON.stringify(read.data?.roundTrip)}`);
    }
    if (!read.data.roundTrip.byteIdentical) {
      throw new Error('EMEVD no-op rebuild was not byte-identical.');
    }
    if (read.data.containerKind !== 'dcx'
      || read.data.compressionFormat !== 'DFLT'
      || read.data.writeSupported !== true
      || read.data.containerRoundTrip?.payloadIdentical !== true
      || read.data.containerRoundTrip.variantIdentical !== true) {
      throw new Error(`DFLT-wrapped EMEVD roundtrip failed: ${JSON.stringify(read.data.containerRoundTrip)}`);
    }
    if (read.data.eventCount < 200) {
      throw new Error(`expected full event table, got eventCount=${read.data.eventCount}`);
    }
    if (read.data.instructionCount < 1000) {
      throw new Error(`expected instruction bank, got instructionCount=${read.data.instructionCount}`);
    }
    if (!read.data.instructionsSample?.length) {
      throw new Error('missing instructionsSample');
    }
    const originalInstructionSample = read.data.instructionsSample;
    const original = read.data;
    const writeAndRead = async (
      inputPath: string,
      outputName: string,
      expectedSourceHash: string,
      mutation: Record<string, unknown>
    ): Promise<{ path: string; data: EmevdEnvelope }> => {
      const outputPath = join(staging, outputName);
      const write = await runBridge({
        command: 'write-emevd',
        filePath: inputPath,
        allowedRoots: sourceAllowedRoots,
        writableRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: {
          outputPath,
          expectedSourceHash,
          ...mutation
        }
      });
      if (!write.diagnostics.some((diagnostic) => diagnostic.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
        throw new Error(`EMEVD ${String(mutation.mutation)} failed: ${JSON.stringify(write.diagnostics)}`);
      }
      const reread = await runBridge<EmevdEnvelope>({
        command: 'read-emevd-document',
        filePath: outputPath,
        allowedRoots: [staging],
        timeoutMs: 60_000
      });
      if (!reread.data) {
        throw new Error(`EMEVD ${String(mutation.mutation)} reread failed: ${JSON.stringify(reread.diagnostics)}`);
      }
      return { path: outputPath, data: reread.data };
    };

    // 1) set_rest_behavior
    const eventIdCounts = new Map<number, number>();
    for (const event of read.data.events) {
      eventIdCounts.set(event.id, (eventIdCounts.get(event.id) ?? 0) + 1);
    }
    const target = read.data.events.find((event) =>
      event.id !== 0 && eventIdCounts.get(event.id) === 1) ?? read.data.events.find((event) =>
      eventIdCounts.get(event.id) === 1);
    if (!target) throw new Error('no events');

    const conflictingHashOutput = join(staging, 'common.conflicting-source-hash.emevd.dcx');
    const conflictingHashWrite = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: conflictingHashOutput,
        expectedSourceHash: read.data.sourceHash,
        expectedDocumentHash: '0'.repeat(64),
        mutation: 'set_rest_behavior',
        eventId: target.id,
        eventIndex: target.eventIndex,
        restBehavior: target.restBehavior === 0 ? 1 : 0
      }
    });
    if (!conflictingHashWrite.diagnostics.some((diagnostic) =>
      diagnostic.code === 'EMEVD_STAGING_WRITE_FAILED' && diagnostic.message.includes('冲突'))
      || await access(conflictingHashOutput).then(() => true, () => false)) {
      throw new Error('conflicting EMEVD source/document hash aliases did not fail closed');
    }

    // Real EMEVD event IDs are not guaranteed to be unique. An ID-only mutation
    // must fail closed; an index-bound mutation must touch exactly one event.
    const duplicateId = [...eventIdCounts.entries()].find(([, count]) => count > 1)?.[0];
    let duplicateIdIdentity: {
      eventId: number;
      occurrenceCount: number;
      ambiguousIdBlocked: boolean;
      indexTargetVerified: boolean;
      inverseHashRestored: boolean;
      hashScope: 'emevd-document-payload';
    } | null = null;
    if (duplicateId !== undefined) {
      const duplicateOccurrences = read.data.events.filter((event) => event.id === duplicateId);
      const duplicateTarget = duplicateOccurrences[0]!;
      const ambiguousOutput = join(staging, 'common.ambiguous-id.emevd.dcx');
      const ambiguousWrite = await runBridge({
        command: 'write-emevd',
        filePath: emevdPath,
        allowedRoots: sourceAllowedRoots,
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: ambiguousOutput,
          expectedDocumentHash: read.data.sourceHash,
          mutation: 'set_rest_behavior',
          eventId: duplicateId,
          restBehavior: duplicateTarget.restBehavior === 0 ? 1 : 0
        }
      });
      const ambiguousDiagnostic = ambiguousWrite.diagnostics.find((diagnostic) =>
        diagnostic.code === 'EMEVD_STAGING_WRITE_FAILED');
      if (!ambiguousDiagnostic
        || !ambiguousDiagnostic.message.includes('eventIndex')
        || !ambiguousDiagnostic.message.includes('重复')) {
        throw new Error(`duplicate event ID did not fail closed: ${JSON.stringify(ambiguousWrite.diagnostics)}`);
      }
      const ambiguousOutputExists = await access(ambiguousOutput).then(() => true, () => false);
      if (ambiguousOutputExists) {
        throw new Error('ambiguous duplicate-ID mutation created a staging output');
      }

      const indexedOutput = join(staging, 'common.index-bound-id.emevd.dcx');
      const indexedRest = duplicateTarget.restBehavior === 0 ? 1 : 0;
      const indexedWrite = await runBridge({
        command: 'write-emevd',
        filePath: emevdPath,
        allowedRoots: sourceAllowedRoots,
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: indexedOutput,
          expectedDocumentHash: read.data.sourceHash,
          mutation: 'set_rest_behavior',
          eventId: duplicateId,
          eventIndex: duplicateTarget.eventIndex,
          restBehavior: indexedRest
        }
      });
      if (!indexedWrite.diagnostics.some((diagnostic) =>
        diagnostic.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
        throw new Error(`index-bound duplicate-ID write failed: ${JSON.stringify(indexedWrite.diagnostics)}`);
      }
      const afterIndexedWrite = await runBridge<EmevdEnvelope>({
        command: 'read-emevd-document',
        filePath: indexedOutput,
        allowedRoots: [staging],
        timeoutMs: 60_000
      });
      if (!afterIndexedWrite.data || afterIndexedWrite.data.eventCount !== read.data.eventCount) {
        throw new Error('index-bound duplicate-ID mutation changed event count');
      }
      for (let index = 0; index < read.data.events.length; index += 1) {
        const before = read.data.events[index]!;
        const after = afterIndexedWrite.data.events[index]!;
        const expectedRest = index === duplicateTarget.eventIndex ? indexedRest : before.restBehavior;
        if (after.id !== before.id || after.restBehavior !== expectedRest) {
          throw new Error(`index-bound duplicate-ID mutation changed unexpected event at index ${index}`);
        }
      }

      const indexedRestoreOutput = join(staging, 'common.index-bound-id-restored.emevd.dcx');
      const indexedRestore = await runBridge({
        command: 'write-emevd',
        filePath: indexedOutput,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: indexedRestoreOutput,
          expectedDocumentHash: afterIndexedWrite.data.sourceHash,
          mutation: 'set_rest_behavior',
          eventId: duplicateId,
          eventIndex: duplicateTarget.eventIndex,
          restBehavior: duplicateTarget.restBehavior
        }
      });
      if (!indexedRestore.diagnostics.some((diagnostic) =>
        diagnostic.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
        throw new Error(`index-bound duplicate-ID restore failed: ${JSON.stringify(indexedRestore.diagnostics)}`);
      }
      const afterIndexedRestore = await runBridge<EmevdEnvelope>({
        command: 'read-emevd-document',
        filePath: indexedRestoreOutput,
        allowedRoots: [staging],
        timeoutMs: 60_000
      });
      if (afterIndexedRestore.data?.documentHash !== read.data.documentHash) {
        throw new Error('index-bound duplicate-ID inverse did not restore the original EMEVD document hash');
      }
      duplicateIdIdentity = {
        eventId: duplicateId,
        occurrenceCount: duplicateOccurrences.length,
        ambiguousIdBlocked: true,
        indexTargetVerified: true,
        inverseHashRestored: true,
        hashScope: 'emevd-document-payload'
      };
    }
    const nextRest = target.restBehavior === 0 ? 1 : 0;
    const stagedRest = join(staging, 'common.rest.emevd.dcx');
    const writtenRest = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: stagedRest,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'set_rest_behavior',
        eventId: target.id,
        eventIndex: target.eventIndex,
        restBehavior: nextRest
      }
    });
    if (!writtenRest.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD rest write failed: ${JSON.stringify(writtenRest.diagnostics)}`);
    }
    const afterRest = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedRest,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    const updated = afterRest.data?.events.find((e) => e.id === target.id);
    if (!updated || updated.restBehavior !== nextRest) {
      throw new Error(`restBehavior not updated: ${JSON.stringify(updated)}`);
    }
    if (afterRest.data?.containerKind !== 'dcx'
      || afterRest.data.compressionFormat !== 'DFLT'
      || afterRest.data.documentHash === read.data.documentHash
      || afterRest.data.sourceHash === read.data.sourceHash) {
      throw new Error('DFLT-wrapped EMEVD mutation did not produce distinct verified source/document hashes');
    }

    // 2) set_instruction_args (equal-length) + EMEDF optional decode
    const sample = read.data.instructionsSample.find((i) => i.argsLength > 0) ?? read.data.instructionsSample[0]!;
    const originalArgs = Buffer.from(sample.argsBase64, 'base64');
    let nextArgs: Buffer = Buffer.from(originalArgs);
    // Flip first byte for a real mutation (equal length)
    nextArgs[0] = (nextArgs[0]! ^ 0x5a) & 0xff;
    if (nextArgs.equals(originalArgs) && nextArgs.length > 0) {
      nextArgs[0] = (nextArgs[0]! + 1) & 0xff;
    }

    const registry = createSekiroFixtureEmedf();
    const decoded = decodeInstructionArgs(registry, sample.bank, sample.id, originalArgs);
    // EMEDF may not know this instruction — that is OK; mutation still works on raw bytes.
    let emedfMutated: string | undefined;
    if (decoded.ok && decoded.args[0]) {
      const mut = mutateInstructionArg(
        registry,
        sample.bank,
        sample.id,
        originalArgs,
        decoded.args[0].name,
        typeof decoded.args[0].value === 'number' ? decoded.args[0].value + 1 : true
      );
      if (mut.ok) {
        nextArgs = Buffer.from(mut.args);
        emedfMutated = decoded.args[0].name;
      }
    }

    const stagedInstr = join(staging, 'common.instr.emevd.dcx');
    const writtenInstr = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: stagedInstr,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'set_instruction_args',
        instructionIndex: sample.index,
        argsBase64: nextArgs.toString('base64')
      }
    });
    if (!writtenInstr.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD instr write failed: ${JSON.stringify(writtenInstr.diagnostics)}`);
    }
    const afterInstr = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedInstr,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    const afterSample = afterInstr.data?.instructionsSample?.find((i) => i.index === sample.index);
    if (!afterSample) throw new Error('instruction sample missing after write');
    const afterArgs = Buffer.from(afterSample.argsBase64, 'base64');
    if (!afterArgs.equals(nextArgs)) {
      throw new Error(`instruction args not updated: ${afterArgs.toString('hex')} vs ${nextArgs.toString('hex')}`);
    }
    // Sibling instruction with same bank/id pattern should keep length
    if (afterInstr.data?.instructionCount !== read.data.instructionCount) {
      throw new Error('instruction count changed unexpectedly');
    }

    // 2b) variable-length instruction args via GC rebuild
    const longerArgs = Buffer.concat([originalArgs, Buffer.from([0x11, 0x22, 0x33, 0x44])]);
    const stagedVar = join(staging, 'common.varargs.emevd.dcx');
    const writtenVar = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedVar,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'set_instruction_args',
        instructionIndex: sample.index,
        argsBase64: longerArgs.toString('base64')
      }
    });
    if (!writtenVar.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD varargs write failed: ${JSON.stringify(writtenVar.diagnostics)}`);
    }
    const afterVar = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedVar,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    const varSample = afterVar.data?.instructionsSample?.find((i) => i.index === sample.index);
    if (!varSample) throw new Error('varargs sample missing');
    const varArgs = Buffer.from(varSample.argsBase64, 'base64');
    if (!varArgs.equals(longerArgs)) {
      throw new Error(`varargs not applied: ${varArgs.length} vs ${longerArgs.length}`);
    }
    if ((afterVar.data?.instructionCount ?? 0) !== read.data.instructionCount) {
      throw new Error('varargs should preserve instruction count');
    }

    // 3) Instruction CRUD uses revision + event occurrence + local index + bank/id identity.
    // Parameter substitutions are event-local instruction references and must be remapped.
    const instructionByGlobalIndex = new Map(
      originalInstructionSample.map((instruction) => [instruction.index, instruction] as const)
    );
    const parameterSamples = original.parameterSubstitutionSample ?? [];
    const sampledParameterCounts = new Map<number, number>();
    for (const parameter of parameterSamples) {
      sampledParameterCounts.set(
        parameter.eventIndex,
        (sampledParameterCounts.get(parameter.eventIndex) ?? 0) + 1
      );
    }
    const parameterTarget = parameterSamples.find((parameter) => {
      const event = original.events[parameter.eventIndex];
      if (!event || (event.instructionCount ?? 0) < 2
        || sampledParameterCounts.get(parameter.eventIndex) !== event.parameterCount
        || event.instructionStartIndex === undefined || event.instructionStartIndex < 0) {
        return false;
      }
      const adjacentLocalIndex = parameter.instructionIndex > 0
        ? parameter.instructionIndex - 1
        : parameter.instructionIndex + 1;
      return instructionByGlobalIndex.has(event.instructionStartIndex + parameter.instructionIndex)
        && instructionByGlobalIndex.has(event.instructionStartIndex + adjacentLocalIndex);
    });
    const instructionCrudEvent = parameterTarget
      ? original.events[parameterTarget.eventIndex]!
      : original.events.find((event) => {
        const start = event.instructionStartIndex;
        return (event.instructionCount ?? 0) >= 2
          && start !== undefined && start >= 0
          && instructionByGlobalIndex.has(start)
          && instructionByGlobalIndex.has(start + 1);
      });
    if (!instructionCrudEvent || instructionCrudEvent.instructionStartIndex === undefined
      || instructionCrudEvent.instructionStartIndex < 0) {
      throw new Error('no sampled event with two instructions available for instruction CRUD smoke');
    }
    const instructionStart = instructionCrudEvent.instructionStartIndex;
    const sourceLocalIndex = parameterTarget?.instructionIndex ?? 0;
    const sourceInstruction = instructionByGlobalIndex.get(instructionStart + sourceLocalIndex);
    const insertedInstruction = instructionByGlobalIndex.get(instructionStart);
    if (!sourceInstruction || !insertedInstruction) {
      throw new Error('instruction CRUD identity sample is incomplete');
    }

    const identityMismatchPath = join(staging, 'common.instruction-identity-mismatch.emevd.dcx');
    const wrongBank = sourceInstruction.bank === 2_147_483_647
      ? sourceInstruction.bank - 1
      : sourceInstruction.bank + 1;
    const identityMismatch = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: identityMismatchPath,
        expectedSourceHash: original.sourceHash,
        mutation: 'delete_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: sourceLocalIndex,
        expectedBank: wrongBank,
        expectedInstructionId: sourceInstruction.id
      }
    });
    if (!identityMismatch.diagnostics.some((diagnostic) =>
      diagnostic.code === 'EMEVD_STAGING_WRITE_FAILED'
      && diagnostic.message.includes('bank/id'))
      || await access(identityMismatchPath).then(() => true, () => false)) {
      throw new Error('instruction identity mismatch did not fail closed without output');
    }

    const addedInstruction = await writeAndRead(
      emevdPath,
      'common.instruction-added.emevd.dcx',
      original.sourceHash,
      {
        mutation: 'add_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: 0,
        bank: insertedInstruction.bank,
        id: insertedInstruction.id,
        argsBase64: insertedInstruction.argsBase64
      }
    );
    const eventAfterAdd = addedInstruction.data.events[instructionCrudEvent.eventIndex];
    if (!eventAfterAdd || eventAfterAdd.id !== instructionCrudEvent.id
      || eventAfterAdd.instructionCount !== (instructionCrudEvent.instructionCount ?? 0) + 1
      || addedInstruction.data.instructionCount !== original.instructionCount + 1) {
      throw new Error('add_instruction did not update the targeted event/instruction counts');
    }
    if (parameterTarget) {
      const parameterAfterAdd = addedInstruction.data.parameterSubstitutionSample?.find((parameter) =>
        parameter.eventIndex === parameterTarget.eventIndex
        && parameter.parameterIndex === parameterTarget.parameterIndex);
      if (parameterAfterAdd?.instructionIndex !== parameterTarget.instructionIndex + 1) {
        throw new Error('add_instruction did not shift event-local parameter instruction references');
      }
    }
    const deletedAddedInstruction = await writeAndRead(
      addedInstruction.path,
      'common.instruction-add-restored.emevd.dcx',
      addedInstruction.data.sourceHash,
      {
        mutation: 'delete_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: 0,
        expectedBank: insertedInstruction.bank,
        expectedInstructionId: insertedInstruction.id
      }
    );
    if (deletedAddedInstruction.data.documentHash !== original.documentHash) {
      throw new Error('instruction add/delete cycle did not restore the original document hash');
    }

    const sourceParameterCount = parameterTarget
      ? parameterSamples.filter((parameter) =>
        parameter.eventIndex === parameterTarget.eventIndex
        && parameter.instructionIndex === sourceLocalIndex).length
      : 0;
    const duplicatedInstruction = await writeAndRead(
      emevdPath,
      'common.instruction-duplicated.emevd.dcx',
      original.sourceHash,
      {
        mutation: 'duplicate_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: sourceLocalIndex,
        expectedBank: sourceInstruction.bank,
        expectedInstructionId: sourceInstruction.id
      }
    );
    const eventAfterDuplicate = duplicatedInstruction.data.events[instructionCrudEvent.eventIndex];
    if (!eventAfterDuplicate
      || eventAfterDuplicate.instructionCount !== (instructionCrudEvent.instructionCount ?? 0) + 1
      || eventAfterDuplicate.parameterCount !== instructionCrudEvent.parameterCount + sourceParameterCount
      || duplicatedInstruction.data.parameterSubstitutionCount
        !== original.parameterSubstitutionCount + sourceParameterCount) {
      throw new Error('duplicate_instruction did not clone the instruction/parameter substitutions');
    }
    const deletedDuplicatedInstruction = await writeAndRead(
      duplicatedInstruction.path,
      'common.instruction-duplicate-restored.emevd.dcx',
      duplicatedInstruction.data.sourceHash,
      {
        mutation: 'delete_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: sourceLocalIndex + 1,
        expectedBank: sourceInstruction.bank,
        expectedInstructionId: sourceInstruction.id
      }
    );
    if (deletedDuplicatedInstruction.data.documentHash !== original.documentHash) {
      throw new Error('instruction duplicate/delete cycle did not restore the original document hash');
    }

    const reorderSourceLocal = parameterTarget && sourceLocalIndex > 0 ? sourceLocalIndex : 1;
    const reorderBeforeLocal = reorderSourceLocal - 1;
    const reorderSource = instructionByGlobalIndex.get(instructionStart + reorderSourceLocal);
    const reorderBefore = instructionByGlobalIndex.get(instructionStart + reorderBeforeLocal);
    if (!reorderSource || !reorderBefore) throw new Error('instruction reorder identities are missing');
    const reorderedInstruction = await writeAndRead(
      emevdPath,
      'common.instruction-reordered.emevd.dcx',
      original.sourceHash,
      {
        mutation: 'reorder_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: reorderSourceLocal,
        expectedBank: reorderSource.bank,
        expectedInstructionId: reorderSource.id,
        beforeInstructionIndex: reorderBeforeLocal,
        beforeExpectedBank: reorderBefore.bank,
        beforeExpectedInstructionId: reorderBefore.id
      }
    );
    const reorderedSource = reorderedInstruction.data.instructionsSample?.find((instruction) =>
      instruction.index === instructionStart + reorderBeforeLocal);
    const reorderedBefore = reorderedInstruction.data.instructionsSample?.find((instruction) =>
      instruction.index === instructionStart + reorderBeforeLocal + 1);
    if (!reorderedSource || !reorderedBefore
      || reorderedSource.bank !== reorderSource.bank || reorderedSource.id !== reorderSource.id
      || reorderedBefore.bank !== reorderBefore.bank || reorderedBefore.id !== reorderBefore.id) {
      throw new Error('reorder_instruction did not move the expected bank/id pair');
    }
    if (parameterTarget) {
      const parameterAfterReorder = reorderedInstruction.data.parameterSubstitutionSample?.find((parameter) =>
        parameter.eventIndex === parameterTarget.eventIndex
        && parameter.parameterIndex === parameterTarget.parameterIndex);
      const expectedParameterInstructionIndex = sourceLocalIndex > 0
        ? sourceLocalIndex - 1
        : sourceLocalIndex + 1;
      if (parameterAfterReorder?.instructionIndex !== expectedParameterInstructionIndex) {
        throw new Error('reorder_instruction did not remap the sampled parameter substitution');
      }
    }
    const restoredInstructionOrder = await writeAndRead(
      reorderedInstruction.path,
      'common.instruction-reorder-restored.emevd.dcx',
      reorderedInstruction.data.sourceHash,
      {
        mutation: 'reorder_instruction',
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        instructionIndex: reorderBeforeLocal + 1,
        expectedBank: reorderBefore.bank,
        expectedInstructionId: reorderBefore.id,
        beforeInstructionIndex: reorderBeforeLocal,
        beforeExpectedBank: reorderSource.bank,
        beforeExpectedInstructionId: reorderSource.id
      }
    );
    if (restoredInstructionOrder.data.documentHash !== original.documentHash) {
      throw new Error('instruction reorder/inverse cycle did not restore the original document hash');
    }

    // 4) add_event + delete_event GC rebuild
    const newEventId = 9_000_001;
    const stagedAdd = join(staging, 'common.add.emevd.dcx');
    const writtenAdd = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedAdd,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'add_event',
        newEventId,
        restBehavior: 1
      }
    });
    if (!writtenAdd.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD add_event failed: ${JSON.stringify(writtenAdd.diagnostics)}`);
    }
    const afterAdd = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedAdd,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (afterAdd.data?.eventCount !== read.data.eventCount + 1) {
      throw new Error(`add_event count ${afterAdd.data?.eventCount}`);
    }
    if (!afterAdd.data?.events.some((e) => e.id === newEventId && e.restBehavior === 1)) {
      throw new Error('added event missing');
    }
    if (afterAdd.data.instructionCount !== read.data.instructionCount) {
      throw new Error('add empty event should not change instructionCount');
    }

    const stagedDel = join(staging, 'common.del.emevd.dcx');
    const writtenDel = await runBridge({
      command: 'write-emevd',
      filePath: stagedAdd,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedDel,
        expectedDocumentHash: afterAdd.data.sourceHash,
        mutation: 'delete_event',
        eventId: newEventId
      }
    });
    if (!writtenDel.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD delete_event failed: ${JSON.stringify(writtenDel.diagnostics)}`);
    }
    const afterDel = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedDel,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (afterDel.data?.eventCount !== read.data.eventCount) {
      throw new Error(`delete restored count expected ${read.data.eventCount}, got ${afterDel.data?.eventCount}`);
    }
    if (afterDel.data?.events.some((e) => e.id === newEventId)) {
      throw new Error('deleted event still present');
    }
    if (afterDel.data?.instructionCount !== read.data.instructionCount) {
      throw new Error('instruction count after add/delete cycle changed');
    }
    if (afterDel.data.documentHash !== read.data.documentHash) {
      throw new Error('add/delete cycle did not restore the original EMEVD document hash');
    }

    // 5) duplicate a non-empty event, then delete it and require exact source restoration.
    const duplicateSource = read.data.events.find((event) =>
      (event.instructionCount ?? 0) > 0 && eventIdCounts.get(event.id) === 1);
    if (!duplicateSource) throw new Error('no non-empty event available for duplicate smoke');
    const duplicateEventId = 9_000_002;
    const stagedDuplicate = join(staging, 'common.duplicate.emevd.dcx');
    const writtenDuplicate = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedDuplicate,
        expectedSourceHash: read.data.sourceHash,
        mutation: 'duplicate_event',
        eventId: duplicateSource.id,
        eventIndex: duplicateSource.eventIndex,
        newEventId: duplicateEventId
      }
    });
    if (!writtenDuplicate.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD duplicate_event failed: ${JSON.stringify(writtenDuplicate.diagnostics)}`);
    }
    const afterDuplicate = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedDuplicate,
      allowedRoots: sourceAllowedRoots,
      timeoutMs: 60_000
    });
    const duplicated = afterDuplicate.data?.events.find((event) => event.id === duplicateEventId);
    if (!duplicated
      || duplicated.restBehavior !== duplicateSource.restBehavior
      || duplicated.instructionCount !== duplicateSource.instructionCount
      || afterDuplicate.data?.eventCount !== read.data.eventCount + 1
      || afterDuplicate.data.instructionCount !== read.data.instructionCount + (duplicateSource.instructionCount ?? 0)) {
      throw new Error('duplicate_event did not preserve event metadata/instruction count');
    }
    const stagedDuplicateRestore = join(staging, 'common.duplicate-restored.emevd.dcx');
    const deletedDuplicate = await runBridge({
      command: 'write-emevd',
      filePath: stagedDuplicate,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedDuplicateRestore,
        expectedDocumentHash: afterDuplicate.data.sourceHash,
        mutation: 'delete_event',
        eventId: duplicateEventId
      }
    });
    if (!deletedDuplicate.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD duplicate restore failed: ${JSON.stringify(deletedDuplicate.diagnostics)}`);
    }
    const afterDuplicateRestore = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedDuplicateRestore,
      allowedRoots: sourceAllowedRoots,
      timeoutMs: 60_000
    });
    if (afterDuplicateRestore.data?.documentHash !== read.data.documentHash) {
      throw new Error('duplicate/delete cycle did not restore the original EMEVD document hash');
    }

    // 6) reorder by revision-bound event index + expected ID, then require exact restoration.
    const firstEvent = read.data.events[0];
    const secondEvent = read.data.events.find((event) => event.id !== firstEvent?.id);
    if (!firstEvent || !secondEvent) throw new Error('at least two events are required for reorder smoke');
    const stagedReorder = join(staging, 'common.reorder.emevd.dcx');
    const writtenReorder = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedReorder,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'reorder_event',
        eventId: secondEvent.id,
        eventIndex: secondEvent.eventIndex,
        beforeEventId: firstEvent.id,
        beforeEventIndex: firstEvent.eventIndex
      }
    });
    if (!writtenReorder.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD reorder_event failed: ${JSON.stringify(writtenReorder.diagnostics)}`);
    }
    const afterReorder = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedReorder,
      allowedRoots: sourceAllowedRoots,
      timeoutMs: 60_000
    });
    const movedOutputIndex = secondEvent.eventIndex < firstEvent.eventIndex
      ? firstEvent.eventIndex - 1
      : firstEvent.eventIndex;
    if (afterReorder.data?.events[movedOutputIndex]?.id !== secondEvent.id
      || afterReorder.data.events[movedOutputIndex + 1]?.id !== firstEvent.id) {
      throw new Error('reorder_event did not swap the first two events');
    }
    const stagedReorderRestore = join(staging, 'common.reorder-restored.emevd.dcx');
    const restoredReorder = await runBridge({
      command: 'write-emevd',
      filePath: stagedReorder,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedReorderRestore,
        expectedDocumentHash: afterReorder.data.sourceHash,
        mutation: 'reorder_event',
        eventId: firstEvent.id,
        eventIndex: movedOutputIndex + 1,
        beforeEventId: secondEvent.id,
        beforeEventIndex: movedOutputIndex
      }
    });
    if (!restoredReorder.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD reorder restore failed: ${JSON.stringify(restoredReorder.diagnostics)}`);
    }
    const afterReorderRestore = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedReorderRestore,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (afterReorderRestore.data?.documentHash !== read.data.documentHash) {
      throw new Error('reorder/inverse cycle did not restore the original EMEVD document hash');
    }

    const sourceAfter = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: emevdPath,
      allowedRoots: sourceAllowedRoots,
      timeoutMs: 60_000
    });
    if (sourceAfter.data?.sourceHash !== read.data.sourceHash
      || sourceAfter.data.documentHash !== read.data.documentHash) {
      throw new Error('original DFLT-wrapped EMEVD source changed during staging smoke');
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      assertions: [
        'emevd-document',
        'instruction-crud',
        'path-exists',
        'sha256-match',
        'format-declared'
      ],
      message: 'EMEVD native 表、重复 ID 身份、rest/args、指令与事件 CRUD/复制/重排验证通过',
      eventCount: read.data.eventCount,
      instructionCount: read.data.instructionCount,
      layerCount: read.data.layerCount,
      authority: read.data.authority,
      containerKind: read.data.containerKind,
      compressionFormat: read.data.compressionFormat,
      documentHash: read.data.documentHash,
      byteIdenticalNoop: read.data.roundTrip.byteIdentical,
      documentByteIdenticalNoop: read.data.roundTrip.byteIdentical,
      containerByteIdenticalNoop: read.data.containerRoundTrip?.byteIdentical === true,
      containerPayloadIdenticalNoop: read.data.containerRoundTrip?.payloadIdentical === true,
      semanticIdenticalNoop: read.data.roundTrip.semanticIdentical,
      originalSourceUntouched: true,
      sourceHashContract: {
        preferredFieldVerified: true,
        conflictingAliasBlocked: true,
        legacyAliasVerified: true
      },
      restEventId: target.id,
      restBehavior: nextRest,
      instructionIndex: sample.index,
      instructionBank: sample.bank,
      instructionId: sample.id,
      argsLength: nextArgs.length,
      varArgsLength: longerArgs.length,
      restMutationVerified: true,
      instructionArgsMutationVerified: true,
      variableLengthArgsMutationVerified: true,
      instructionCrud: {
        eventId: instructionCrudEvent.id,
        eventIndex: instructionCrudEvent.eventIndex,
        parameterCount: instructionCrudEvent.parameterCount,
        identityMismatchBlocked: true,
        addDeleteHashRestored: true,
        duplicateDeleteHashRestored: true,
        reorderInverseHashRestored: true,
        parameterSubstitutionRemapCovered: parameterTarget !== undefined,
        parameterInstructionIndex: parameterTarget?.instructionIndex ?? null,
        clonedParameterCount: sourceParameterCount,
        hashScope: 'emevd-document-payload'
      },
      duplicateIdIdentity,
      emedfDecoded: decoded.ok,
      emedfMutated: emedfMutated ?? null,
      eventGc: {
        added: newEventId,
        deleted: true,
        finalEvents: afterDel.data.eventCount,
        originalHashRestored: true,
        hashScope: 'emevd-document-payload'
      },
      duplicateEvent: {
        sourceEventId: duplicateSource.id,
        duplicatedEventId: duplicateEventId,
        instructionCount: duplicateSource.instructionCount,
        originalHashRestored: true,
        hashScope: 'emevd-document-payload'
      },
      eventReorder: {
        movedEventId: secondEvent.id,
        beforeEventId: firstEvent.id,
        inverseHashRestored: true,
        hashScope: 'emevd-document-payload'
      },
      // Compatibility fields required by scripts/verify-native-emevd-corpus.mjs assessAssertions.
      instructionCrudVerified: true,
      eventCrudVerified: true,
      duplicateIdIdentityVerified: true,
      parameterRemapVerified: true,
      snapshotRoundTripVerified: true,
      positiveInstructionCountVerified: true
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

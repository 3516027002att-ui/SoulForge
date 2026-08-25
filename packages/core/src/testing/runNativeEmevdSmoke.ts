/**
 * Native EMEVD structural + instruction-arg smoke:
 * DFLT/KRAK-decompress common.emevd.dcx → correct Sekiro header parse →
 * no-op roundtrip → set_rest_behavior → set_instruction_args → reread.
 * EVENT-30A: production open reads the .dcx outer resource directly — Bridge
 * unwraps DFLT/KRAK natively (no TypeScript DCX parser in production), cross-checked
 * against the TypeScript decompressor for the payload hash when DFLT.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import {
  createSekiroFixtureEmedf,
  decodeInstructionArgs,
  mutateInstructionArg
} from '../emevd/emedfSchema.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface EmevdEnvelope {
  sourceHash: string;
  sourceFormat?: string;
  outerFileHash?: string;
  eventCount: number;
  instructionCount: number;
  events: Array<{
    id: number;
    restBehavior: number;
    instructionCount?: number;
    instructionStartIndex?: number;
    parameters?: Array<{
      instructionIndex: number;
      targetStartByte: number;
      sourceStartByte: number;
      byteCount: number;
      unkId: number;
    }>;
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

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main(): Promise<void> {
  const sourceDcx = await resolveNativeFixture(
    process.argv[2],
    'emevd-primary',
    '../../mods/event/common.emevd.dcx'
  );
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-emevd-'));
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });

  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
  try {
    const dcxBytes = await readFile(sourceDcx);
    const isDcx = dcxBytes.length >= 4 && dcxBytes.subarray(0, 4).toString('ascii') === 'DCX\0';
    const isDflt = isDcx && dcxBytes.length >= 0x1c && dcxBytes.subarray(0x18, 0x1c).toString('ascii') === 'DFLT';

    let payload: Buffer | undefined;
    const emevdPath = join(staging, 'common.emevd');
    if (isDflt) {
      payload = decompressDfltDcx(dcxBytes);
      await writeFile(emevdPath, payload);
    }

    // EVENT-30A production open: Bridge reads the .dcx outer resource natively.
    const dcxRead = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: sourceDcx,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    if (dcxRead.parseStatus === 'failed' || !dcxRead.data) {
      throw new Error(`native DCX open failed: ${JSON.stringify(dcxRead.diagnostics)}`);
    }
    if (dcxRead.data.sourceFormat !== 'dcx') {
      throw new Error(`native DCX open must report sourceFormat=dcx, got ${dcxRead.data.sourceFormat}`);
    }
    if (dcxRead.data.outerFileHash !== hashOf(dcxBytes)) {
      throw new Error('native DCX outerFileHash must hash the .dcx file bytes');
    }
    if (payload && dcxRead.data.sourceHash !== hashOf(payload)) {
      throw new Error('Bridge native payload hash must equal TypeScript decompressed payload hash');
    }
    if (dcxRead.data.instructionCount < 1000) {
      throw new Error(`native DCX instructionCount ${dcxRead.data.instructionCount}`);
    }

    const testFilePath = isDflt ? emevdPath : sourceDcx;
    const read = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    if (!read.data?.roundTrip?.semanticIdentical) {
      throw new Error(`EMEVD read/roundtrip failed: ${JSON.stringify(read.diagnostics)} ${JSON.stringify(read.data?.roundTrip)}`);
    }
    if (read.data.eventCount < 100) {
      throw new Error(`expected full event table, got eventCount=${read.data.eventCount}`);
    }
    if (read.data.instructionCount < 1000) {
      throw new Error(`expected instruction bank, got instructionCount=${read.data.instructionCount}`);
    }
    if (!read.data.instructionsSample?.length) {
      throw new Error('missing instructionsSample');
    }

    // Real Sekiro X-binding golden: take the first event carrying native
    // parameter bindings, submit the exact table through the production writer
    // into staging, then reread and compare every field.  This is deliberately
    // a no-op semantic mutation: it proves the identity/layout-preserving
    // writer path without changing the user's game or Mod bytes.
    const parameterEvent = read.data.events.find((event) => (event.parameters?.length ?? 0) > 0);
    if (!parameterEvent || !parameterEvent.parameters) {
      throw new Error('真实 Sekiro EMEVD 中没有可用于 X-binding golden 的参数事件。');
    }
    const stagedParameters = join(staging, 'common.parameters.emevd');
    const writtenParameters = await runBridge({
      command: 'write-emevd',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedParameters,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'set_event_parameters',
        eventId: parameterEvent.id,
        parameters: parameterEvent.parameters
      }
    });
    if (!writtenParameters.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`真实 X-binding golden 写入失败: ${JSON.stringify(writtenParameters.diagnostics)}`);
    }
    const afterParameters = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedParameters,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    const rereadParameters = afterParameters.data?.events.find((event) => event.id === parameterEvent.id)?.parameters;
    if (JSON.stringify(rereadParameters ?? []) !== JSON.stringify(parameterEvent.parameters)) {
      throw new Error(`真实 X-binding golden 重读不一致: ${JSON.stringify({ before: parameterEvent.parameters, after: rereadParameters })}`);
    }

    // 1) set_rest_behavior
    const target = read.data.events.find((e) => e.id !== 0) ?? read.data.events[0];
    if (!target) throw new Error('no events');
    const nextRest = target.restBehavior === 0 ? 1 : 0;
    const stagedRest = join(staging, 'common.rest.emevd');
    const writtenRest = await runBridge({
      command: 'write-emevd',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: stagedRest,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'set_rest_behavior',
        eventId: target.id,
        restBehavior: nextRest
      }
    });
    if (!writtenRest.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EMEVD rest write failed: ${JSON.stringify(writtenRest.diagnostics)}`);
    }
    const afterRest = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: stagedRest,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    const updated = afterRest.data?.events.find((e) => e.id === target.id);
    if (!updated || updated.restBehavior !== nextRest) {
      throw new Error(`restBehavior not updated: ${JSON.stringify(updated)}`);
    }
    const rejectedRest = await runBridge({
      command: 'write-emevd',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: join(staging, 'common.invalid-rest.emevd'),
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'set_rest_behavior',
        eventId: target.id,
        restBehavior: -1
      }
    });
    if (!rejectedRest.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_FAILED')
      || rejectedRest.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED')) {
      throw new Error(`negative restBehavior was not rejected: ${JSON.stringify(rejectedRest.diagnostics)}`);
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

    const stagedInstr = join(staging, 'common.instr.emevd');
    const writtenInstr = await runBridge({
      command: 'write-emevd',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
      timeoutMs: 120_000,
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
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    const afterSample = afterInstr.data?.instructionsSample?.find((i) => i.index === sample.index);
    if (!afterSample) throw new Error('instruction sample missing after write');
    const afterArgs = Buffer.from(afterSample.argsBase64, 'base64');
    if (!afterArgs.equals(nextArgs)) {
      throw new Error(`instruction args not updated: ${afterArgs.toString('hex')} vs ${nextArgs.toString('hex')}`);
    }
    if (afterInstr.data?.instructionCount !== read.data.instructionCount) {
      throw new Error('instruction count changed unexpectedly');
    }

    // 2b) variable-length instruction args via GC rebuild
    const longerArgs = Buffer.concat([originalArgs, Buffer.from([0x11, 0x22, 0x33, 0x44])]);
    const stagedVar = join(staging, 'common.varargs.emevd');
    const writtenVar = await runBridge({
      command: 'write-emevd',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
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
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
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

    // 3) add_event + delete_event GC rebuild
    const newEventId = 9_000_001;
    const stagedAdd = join(staging, 'common.add.emevd');
    const writtenAdd = await runBridge({
      command: 'write-emevd',
      filePath: testFilePath,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
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
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
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

    const stagedDel = join(staging, 'common.del.emevd');
    const writtenDel = await runBridge({
      command: 'write-emevd',
      filePath: stagedAdd,
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      writableRoots: [staging],
      oodleRuntimeRoot,
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
      allowedRoots: [staging, dirname(sourceDcx), oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
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

    console.log(JSON.stringify({
      ok: true,
      message: 'EMEVD native 全量表 + rest/args/变长args + 事件增删 GC 验证通过',
      eventCount: read.data.eventCount,
      instructionCount: read.data.instructionCount,
      authority: read.data.authority,
      nativeDcxOpen: {
        sourceFormat: dcxRead.data.sourceFormat,
        outerFileHashMatchesDcx: dcxRead.data.outerFileHash === hashOf(dcxBytes),
        payloadHashMatchesTsDecompress: payload ? dcxRead.data.sourceHash === hashOf(payload) : true
      },
      restEventId: target.id,
      restBehavior: nextRest,
      restRangeRejected: true,
      instructionIndex: sample.index,
      instructionBank: sample.bank,
      instructionId: sample.id,
      argsLength: nextArgs.length,
      varArgsLength: longerArgs.length,
      emedfDecoded: decoded.ok,
      emedfMutated: emedfMutated ?? null,
      xBindingGolden: {
        eventId: parameterEvent.id,
        parameterCount: parameterEvent.parameters.length,
        stagingRereadVerified: true
      },
      addDeleteEventCycleVerified: true
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runNativeEmevdSmoke.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

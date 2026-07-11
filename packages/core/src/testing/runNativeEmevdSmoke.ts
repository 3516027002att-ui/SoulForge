/**
 * Native EMEVD structural + instruction-arg smoke:
 * DFLT-decompress common.emevd.dcx → correct Sekiro header parse →
 * no-op roundtrip → set_rest_behavior → set_instruction_args → reread.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import {
  createSekiroFixtureEmedf,
  decodeInstructionArgs,
  mutateInstructionArg
} from '../emevd/emedfSchema.js';

interface EmevdEnvelope {
  sourceHash: string;
  eventCount: number;
  instructionCount: number;
  events: Array<{
    id: number;
    restBehavior: number;
    instructionCount?: number;
    instructionStartIndex?: number;
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

function decompressDfltDcx(source: Buffer): Buffer {
  if (source.subarray(0, 4).toString('ascii') !== 'DCX\0') throw new Error('not DCX');
  let dca = -1;
  for (let i = 0x30; i < 0x100; i++) {
    if (source[i] === 0x44 && source[i + 1] === 0x43 && source[i + 2] === 0x41 && source[i + 3] === 0) {
      dca = i;
      break;
    }
  }
  if (dca < 0) throw new Error('DCA missing');
  const dcaLen = source.readUInt32BE(dca + 4);
  const payloadOff = dca + dcaLen;
  const compressedSize = source.readUInt32BE(0x20);
  const format = source.subarray(0x28, 0x2c).toString('ascii');
  if (format !== 'DFLT') throw new Error(`expected DFLT, got ${format}`);
  const compressed = source.subarray(payloadOff, payloadOff + compressedSize);
  return inflateSync(compressed);
}

async function main(): Promise<void> {
  const sourceDcx = resolve(process.argv[2] ?? '../../mods/event/common.emevd.dcx');
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-emevd-'));
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });

  try {
    const dcxBytes = await readFile(sourceDcx);
    const payload = decompressDfltDcx(dcxBytes);
    const emevdPath = join(staging, 'common.emevd');
    await writeFile(emevdPath, payload);

    const read = await runBridge<EmevdEnvelope>({
      command: 'read-emevd-document',
      filePath: emevdPath,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (!read.data?.roundTrip?.semanticIdentical) {
      throw new Error(`EMEVD read/roundtrip failed: ${JSON.stringify(read.diagnostics)} ${JSON.stringify(read.data?.roundTrip)}`);
    }
    if (!read.data.roundTrip.byteIdentical) {
      throw new Error('EMEVD no-op rebuild was not byte-identical.');
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

    // 1) set_rest_behavior
    const target = read.data.events.find((e) => e.id !== 0) ?? read.data.events[0];
    if (!target) throw new Error('no events');
    const nextRest = target.restBehavior === 0 ? 1 : 0;
    const stagedRest = join(staging, 'common.rest.emevd');
    const writtenRest = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
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
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    const updated = afterRest.data?.events.find((e) => e.id === target.id);
    if (!updated || updated.restBehavior !== nextRest) {
      throw new Error(`restBehavior not updated: ${JSON.stringify(updated)}`);
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

    const stagedInstr = join(staging, 'common.instr.emevd');
    const writtenInstr = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: [staging],
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
    const stagedVar = join(staging, 'common.varargs.emevd');
    const writtenVar = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: [staging],
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

    // 3) add_event + delete_event GC rebuild
    const newEventId = 9_000_001;
    const stagedAdd = join(staging, 'common.add.emevd');
    const writtenAdd = await runBridge({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots: [staging],
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

    const stagedDel = join(staging, 'common.del.emevd');
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

    console.log(JSON.stringify({
      ok: true,
      message: 'EMEVD native 全量表 + rest/args/变长args + 事件增删 GC 验证通过',
      eventCount: read.data.eventCount,
      instructionCount: read.data.instructionCount,
      authority: read.data.authority,
      restEventId: target.id,
      restBehavior: nextRest,
      instructionIndex: sample.index,
      instructionBank: sample.bank,
      instructionId: sample.id,
      argsLength: nextArgs.length,
      varArgsLength: longerArgs.length,
      emedfDecoded: decoded.ok,
      emedfMutated: emedfMutated ?? null,
      eventGc: { added: newEventId, deleted: true, finalEvents: afterDel.data?.eventCount }
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

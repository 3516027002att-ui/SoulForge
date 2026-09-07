import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBridge } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import {
  readMsbsEntityOracle,
  readPartEntityOracle,
  readRegionEntityOracle,
  type OraclePartRecord,
  type OracleRegionRecord
} from './msbsIndependentEntityOracle.js';
import {
  WorkspaceIndex,
  MSB_READER_SCHEMA_REVISION,
  computeMapDerivedKey
} from '../indexing/workspaceIndex.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

function computeByteDiffs(bufA: Buffer, bufB: Buffer): Array<{ offset: number; byteA: number; byteB: number }> {
  const diffs: Array<{ offset: number; byteA: number; byteB: number }> = [];
  const minLen = Math.min(bufA.length, bufB.length);
  for (let i = 0; i < minLen; i++) {
    if (bufA[i] !== bufB[i]) {
      diffs.push({ offset: i, byteA: bufA[i]!, byteB: bufB[i]! });
    }
  }
  if (bufA.length !== bufB.length) {
    const maxLen = Math.max(bufA.length, bufB.length);
    for (let i = minLen; i < maxLen; i++) {
      diffs.push({
        offset: i,
        byteA: i < bufA.length ? bufA[i]! : -1,
        byteB: i < bufB.length ? bufB[i]! : -1
      });
    }
  }
  return diffs;
}

/**
 * Prepares a test MSBS buffer derived from the verified native MSB fixture,
 * with T01 & T02 preconditions constructed:
 * - Part: InternalEntryId = 7, EntityID = 1000
 * - Region: InternalEntryId = 12, ActivationPartIndex = 50, EntityID = 500
 */
async function prepareUnitFixtureBuffer(): Promise<{
  buffer: Buffer;
  part: OraclePartRecord;
  region: OracleRegionRecord;
}> {
  const sourceDcx = await resolveNativeFixture(
    undefined,
    'msb-primary',
    '../../mods/map/mapstudio/m11_00_00_00.msb.dcx'
  );
  const decompressed = decompressDfltDcx(await readFile(sourceDcx));
  const buf = Buffer.from(decompressed);

  const initialOracle = readMsbsEntityOracle(buf);
  const part = initialOracle.parts.find((p) => p.name.length > 0 && p.entityDataAddress > 0);
  assert.equal(Boolean(part), true, 'Must find valid part in native MSB fixture');
  const targetPart = part!;

  const region = initialOracle.regions.find((r) => r.name.length > 0 && r.baseData3Address > 0);
  assert.equal(Boolean(region), true, 'Must find valid region in native MSB fixture');
  const targetRegion = region!;

  // T01 setup: InternalEntryId = 7, EntityID = 1000
  buf.writeInt32LE(7, targetPart.entryOffset + 0x0C);
  buf.writeInt32LE(1000, targetPart.entityDataAddress);

  // T02 setup: InternalEntryId = 12, ActivationPartIndex = 50, EntityID = 500
  buf.writeInt32LE(12, targetRegion.entryOffset + 0x0C);
  buf.writeInt32LE(50, targetRegion.baseData3Address + 0);
  buf.writeInt32LE(500, targetRegion.baseData3Address + 4);

  // Re-read updated records
  const updatedPart = readPartEntityOracle(buf, targetPart.entryOffset);
  const updatedRegion = readRegionEntityOracle(buf, targetRegion.entryOffset);

  return {
    buffer: buf,
    part: updatedPart,
    region: updatedRegion
  };
}

export async function runSf02UnitTests(): Promise<void> {
  const root = join(tmpdir(), `sf02-unit-${Date.now()}`);
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });

  try {
    const { buffer, part: initialPart, region: initialRegion } = await prepareUnitFixtureBuffer();
    const synthPath = join(root, 'unit-fixture.msb');
    await writeFile(synthPath, buffer);

    // Initial check with independent Oracle
    assert.equal(initialPart.internalEntryId, 7, 'T01 precondition: InternalEntryId must be 7');
    assert.equal(initialPart.entityId, 1000, 'T01 precondition: EntityID must be 1000');
    assert.notEqual(initialPart.internalEntryId, initialPart.entityId, 'T01: InternalEntryId must not equal EntityId');

    // T02: Region BaseData3: activationPartIndex and EntityID must be different
    assert.equal(initialRegion.internalEntryId, 12, 'T02 precondition: InternalEntryId must be 12');
    assert.equal(initialRegion.activationPartIndex, 50, 'T02 precondition: activationPartIndex must be 50');
    assert.equal(initialRegion.entityId, 500, 'T02 precondition: EntityID must be 500');
    assert.notEqual(
      initialRegion.activationPartIndex,
      initialRegion.entityId,
      'T02: activationPartIndex must not equal entityId'
    );

    // Read synth document via Bridge
    const initialBridge = await runBridge<any>({
      command: 'read-msb-document',
      filePath: synthPath,
      allowedRoots: [root],
      timeoutMs: 30_000
    });
    assert.equal(initialBridge.parseStatus !== 'failed' && Boolean(initialBridge.data), true);
    assert.equal(initialBridge.data.readerSchemaRevision, 2, 'Bridge readerSchemaRevision must be 2');

    const bPart = initialBridge.data.parts.find((p: any) => p.name === initialPart.name);
    assert.equal(Boolean(bPart), true);
    assert.equal(bPart.internalEntryId, 7);
    assert.equal(bPart.entityId, 1000);

    const bRegion = initialBridge.data.regions.find((r: any) => r.name === initialRegion.name);
    assert.equal(Boolean(bRegion), true);
    assert.equal(bRegion.internalEntryId, 12);
    assert.equal(bRegion.entityId, 500);

    const origHash = initialBridge.data.sourceHash;

    // --- EXECUTE T01: Mutate Part EntityID from 1000 to 2000 ---
    const outT01 = join(staging, 't01-mutated.msb');
    const resT01 = await runBridge<any>({
      command: 'write-msb',
      filePath: synthPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 30_000,
      commandOptions: {
        outputPath: outT01,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'part',
            nativeOffset: initialPart.entryOffset,
            expectedName: initialPart.name,
            entityId: 2000
          }
        ]
      }
    });
    assert.equal(resT01.parseStatus !== 'failed', true, `T01 Bridge write failed: ${JSON.stringify(resT01.diagnostics)}`);
    assert.equal(await fileExists(outT01), true, 'T01 output file must exist');

    // Verify T01 via independent Oracle
    const t01Buf = await readFile(outT01);
    const t01Part = readPartEntityOracle(t01Buf, initialPart.entryOffset);
    assert.equal(t01Part.internalEntryId, 7, 'T01: InternalEntryId must remain 7');
    assert.equal(t01Part.entityId, 2000, 'T01: EntityID must become 2000');

    // Verify T01 exact byte diff: strictly within the 4-byte window of partEntityDataAddress
    const t01Diffs = computeByteDiffs(buffer, t01Buf);
    assert.equal(t01Diffs.length > 0, true, 'T01: At least 1 byte must differ');
    assert.equal(
      t01Diffs.every(
        (d) => d.offset >= initialPart.entityDataAddress && d.offset < initialPart.entityDataAddress + 4
      ),
      true,
      `T01: All changed bytes must be strictly within [${initialPart.entityDataAddress}, ${initialPart.entityDataAddress + 4})`
    );
    assert.equal(t01Buf.readInt32LE(initialPart.entityDataAddress), 2000);

    // --- EXECUTE T02: Mutate Region EntityID to 2500 ---
    const outT02 = join(staging, 't02-mutated.msb');
    const resT02 = await runBridge<any>({
      command: 'write-msb',
      filePath: synthPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 30_000,
      commandOptions: {
        outputPath: outT02,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'region',
            nativeOffset: initialRegion.entryOffset,
            expectedName: initialRegion.name,
            entityId: 2500
          }
        ]
      }
    });
    assert.equal(resT02.parseStatus !== 'failed', true, `T02 Bridge write failed: ${JSON.stringify(resT02.diagnostics)}`);
    assert.equal(await fileExists(outT02), true, 'T02 output file must exist');

    // Verify T02 via independent Oracle
    const t02Buf = await readFile(outT02);
    const t02Region = readRegionEntityOracle(t02Buf, initialRegion.entryOffset);
    assert.equal(t02Region.internalEntryId, 12, 'T02: InternalEntryId must remain 12');
    assert.equal(t02Region.activationPartIndex, 50, 'T02: activationPartIndex must remain 50');
    assert.equal(t02Region.entityId, 2500, 'T02: EntityID must become 2500');

    // Verify T02 exact byte diff: strictly within the 4-byte window of regionBaseData3Address + 4
    const t02Diffs = computeByteDiffs(buffer, t02Buf);
    assert.equal(t02Diffs.length > 0, true, 'T02: At least 1 byte must differ');
    assert.equal(
      t02Diffs.every(
        (d) =>
          d.offset >= initialRegion.baseData3Address + 4 &&
          d.offset < initialRegion.baseData3Address + 8
      ),
      true,
      `T02: All changed bytes must be strictly within [${initialRegion.baseData3Address + 4}, ${initialRegion.baseData3Address + 8})`
    );
    assert.equal(t02Buf.readInt32LE(initialRegion.baseData3Address + 4), 2500);

    // --- T54: "Old bug detection power" ---
    // Construct bad buffer where +0x0C is modified to 2000 while real EntityID is still 1000.
    const badBuf = Buffer.from(buffer);
    badBuf.writeInt32LE(2000, initialPart.entryOffset + 0x0C);
    const badPart = readPartEntityOracle(badBuf, initialPart.entryOffset);
    assert.equal(badPart.internalEntryId, 2000, 'Bad buffer has internalEntryId corrupted to 2000');
    assert.equal(badPart.entityId, 1000, 'Bad buffer real EntityID is still 1000');
    assert.notEqual(
      badPart.entityId,
      2000,
      'T54: Oracle must detect that real EntityID was NOT updated when only +0x0C was written'
    );

    // --- NEGATIVE CASES ---
    // 1. Wrong family (event) -> MSB_ENTITY_SCHEMA_UNVERIFIED
    const testEvent = initialBridge.data.events[0];
    assert.equal(Boolean(testEvent), true);
    const outBadFamily = join(staging, 'bad-family.msb');
    const resBadFamily = await runBridge<any>({
      command: 'write-msb',
      filePath: synthPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 30_000,
      commandOptions: {
        outputPath: outBadFamily,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'event',
            nativeOffset: testEvent.offset,
            expectedName: testEvent.name,
            entityId: 9999
          }
        ]
      }
    });
    assert.equal(
      resBadFamily.diagnostics.some((d: any) => d.code === 'MSB_ENTITY_SCHEMA_UNVERIFIED'),
      true,
      'Must reject event family with MSB_ENTITY_SCHEMA_UNVERIFIED'
    );
    assert.equal(await fileExists(outBadFamily), false);

    // 2. Out of int32 range -> rejected before mutation
    const outOutOfRange = join(staging, 'bad-range.msb');
    const resOutOfRange = await runBridge<any>({
      command: 'write-msb',
      filePath: synthPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 30_000,
      commandOptions: {
        outputPath: outOutOfRange,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'part',
            nativeOffset: initialPart.entryOffset,
            expectedName: initialPart.name,
            entityId: 3000000000 // > int.MaxValue
          }
        ]
      }
    });
    assert.equal(
      resOutOfRange.diagnostics.some((d: any) => d.code === 'MSB_MUTATION_OUT_OF_RANGE'),
      true,
      'Must reject entityId > int.MaxValue with MSB_MUTATION_OUT_OF_RANGE'
    );
    assert.equal(await fileExists(outOutOfRange), false);

    // 3. Pointer = 0 in source buffer -> rejected
    const bufPtrZero = Buffer.from(buffer);
    bufPtrZero.writeBigInt64LE(0n, initialPart.entryOffset + 0x60);
    const pathPtrZero = join(root, 'ptr-zero.msb');
    await writeFile(pathPtrZero, bufPtrZero);
    const outPtrZero = join(staging, 'out-ptr-zero.msb');
    const resPtrZero = await runBridge<any>({
      command: 'write-msb',
      filePath: pathPtrZero,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 30_000,
      commandOptions: {
        outputPath: outPtrZero,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'part',
            nativeOffset: initialPart.entryOffset,
            expectedName: initialPart.name,
            entityId: 3000
          }
        ]
      }
    });
    assert.equal(await fileExists(outPtrZero), false, 'Pointer=0 must NOT create output file');

    // 4. Int32 upper bound test: int.MaxValue (2147483647) is allowed
    const outIntMax = join(staging, 'synth-intmax.msb');
    const resIntMax = await runBridge<any>({
      command: 'write-msb',
      filePath: synthPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 30_000,
      commandOptions: {
        outputPath: outIntMax,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'part',
            nativeOffset: initialPart.entryOffset,
            expectedName: initialPart.name,
            entityId: 2147483647
          }
        ]
      }
    });
    assert.equal(resIntMax.parseStatus !== 'failed', true);
    assert.equal(await fileExists(outIntMax), true);
    const intMaxOracle = readPartEntityOracle(await readFile(outIntMax), initialPart.entryOffset);
    assert.equal(intMaxOracle.entityId, 2147483647);

    // --- IDEMPOTENT SCHEMA MIGRATION TEST ON WorkspaceIndex ---
    const index = new WorkspaceIndex('test-ws');
    // Upsert legacy MapExport with revision 1
    index.upsertMapExport({
      mapId: 'm11_00_00_00',
      sourceHash: 'hash-rev1',
      readerSchemaRevision: 1,
      entities: [
        {
          uri: 'map://m11_00_00_00/part/c1000',
          sourceUri: 'file:///d:/mods/m11.msb',
          mapId: 'm11_00_00_00',
          name: 'c1000',
          kind: 'character',
          entityId: 7 // old bug: had internal ID
        }
      ],
      regions: []
    });

    // Run migrateMsbReaderSchema(2) -> evicts legacy map export
    const mig1 = index.migrateMsbReaderSchema(2);
    assert.equal(mig1.staleMapExportsRemoved, 1, 'Migration must evict 1 stale map export');
    assert.equal(mig1.migratedSources.length, 1);

    // Run migrateMsbReaderSchema(2) again -> idempotent (0 evicted)
    const mig2 = index.migrateMsbReaderSchema(2);
    assert.equal(mig2.staleMapExportsRemoved, 0, 'Migration must be idempotent');

    // Upsert modern MapExport with revision 2
    index.upsertMapExport({
      mapId: 'm11_00_00_00',
      sourceHash: 'hash-rev2',
      readerSchemaRevision: 2,
      derivedKey: computeMapDerivedKey({ outerHash: 'hash-rev2' }),
      entities: [
        {
          uri: 'map://m11_00_00_00/part/c1000',
          sourceUri: 'file:///d:/mods/m11.msb',
          mapId: 'm11_00_00_00',
          name: 'c1000',
          kind: 'character',
          internalEntryId: 7,
          entityId: 1000 // verified real EntityID
        }
      ],
      regions: []
    });

    // Run migrateMsbReaderSchema(2) again -> keeps revision 2 intact!
    const mig3 = index.migrateMsbReaderSchema(2);
    assert.equal(mig3.staleMapExportsRemoved, 0, 'Revision 2 map export must not be removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runSf02NativeTests(): Promise<void> {
  const root = join(tmpdir(), `sf02-native-${Date.now()}`);
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });

  try {
    const sourceDcx = await resolveNativeFixture(
      undefined,
      'msb-primary',
      '../../mods/map/mapstudio/m11_00_00_00.msb.dcx'
    );
    const decompressed = decompressDfltDcx(await readFile(sourceDcx));
    const msbPath = join(root, 'm11.msb');
    await writeFile(msbPath, decompressed);

    // 1. Independent Oracle verification on native raw decompressed MSB
    const nativeOracle = readMsbsEntityOracle(decompressed);
    assert.equal(nativeOracle.parts.length > 10, true, 'Native MSB must have > 10 parts');
    assert.equal(nativeOracle.regions.length > 10, true, 'Native MSB must have > 10 regions');

    // Pick a test part and test region
    const targetPart = nativeOracle.parts.find((p) => p.name.length > 0 && p.entityId !== p.internalEntryId);
    assert.equal(Boolean(targetPart), true, 'Must find native part with entityId != internalEntryId');
    const testPart = targetPart!;

    const targetRegion = nativeOracle.regions.find(
      (r) => r.name.length > 0 && r.activationPartIndex !== r.entityId
    );
    assert.equal(Boolean(targetRegion), true, 'Must find native region with activationPartIndex != entityId');
    const testRegion = targetRegion!;

    // 2. Bridge read-msb-document verification
    const bridgeRead = await runBridge<any>({
      command: 'read-msb-document',
      filePath: msbPath,
      allowedRoots: [root],
      timeoutMs: 60_000
    });
    assert.equal(bridgeRead.parseStatus !== 'failed' && Boolean(bridgeRead.data), true);
    assert.equal(bridgeRead.data.readerSchemaRevision, 2, 'Native read-msb-document must report readerSchemaRevision=2');

    // Cross-check Oracle vs Bridge on target part
    const bPart = bridgeRead.data.parts.find((p: any) => p.name === testPart.name);
    assert.equal(Boolean(bPart), true);
    assert.equal(bPart.internalEntryId, testPart.internalEntryId, 'Bridge and Oracle internalEntryId must match');
    assert.equal(bPart.entityId, testPart.entityId, 'Bridge and Oracle entityId must match');

    // Cross-check Oracle vs Bridge on target region
    const bRegion = bridgeRead.data.regions.find((r: any) => r.name === testRegion.name);
    assert.equal(Boolean(bRegion), true);
    assert.equal(bRegion.internalEntryId, testRegion.internalEntryId, 'Bridge and Oracle region internalEntryId must match');
    assert.equal(bRegion.entityId, testRegion.entityId, 'Bridge and Oracle region entityId must match');

    const origHash = bridgeRead.data.sourceHash;

    // 3. Mutate Part EntityID on native MSB
    const newPartEntityId = 888101;
    const outPartMsb = join(staging, 'm11-part-mutated.msb');
    const resPartMut = await runBridge<any>({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outPartMsb,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'part',
            nativeOffset: testPart.entryOffset,
            expectedName: testPart.name,
            entityId: newPartEntityId
          }
        ]
      }
    });
    assert.equal(resPartMut.parseStatus !== 'failed', true, `Native part write failed: ${JSON.stringify(resPartMut.diagnostics)}`);
    assert.equal(await fileExists(outPartMsb), true);

    // Read back mutated native Part MSB via independent Oracle
    const mutatedPartBuf = await readFile(outPartMsb);
    const mutatedPartOracle = readPartEntityOracle(mutatedPartBuf, testPart.entryOffset);
    assert.equal(mutatedPartOracle.internalEntryId, testPart.internalEntryId, 'Part internalEntryId must be unchanged');
    assert.equal(mutatedPartOracle.entityId, newPartEntityId, 'Part entityId must match new mutated value');

    // Verify exact byte diff on native MSB: strictly within 4-byte window of testPart.entityDataAddress
    const partDiffs = computeByteDiffs(decompressed, mutatedPartBuf);
    assert.equal(partDiffs.length > 0, true, 'Native part mutation must have at least 1 byte diff');
    assert.equal(
      partDiffs.every(
        (d) => d.offset >= testPart.entityDataAddress && d.offset < testPart.entityDataAddress + 4
      ),
      true,
      `Native part mutation must modify bytes strictly within [${testPart.entityDataAddress}, ${testPart.entityDataAddress + 4})`
    );
    assert.equal(mutatedPartBuf.readInt32LE(testPart.entityDataAddress), newPartEntityId);

    // 4. Mutate Region EntityID on native MSB
    const newRegionEntityId = 888102;
    const outRegionMsb = join(staging, 'm11-region-mutated.msb');
    const resRegionMut = await runBridge<any>({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outRegionMsb,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'region',
            nativeOffset: testRegion.entryOffset,
            expectedName: testRegion.name,
            entityId: newRegionEntityId
          }
        ]
      }
    });
    assert.equal(resRegionMut.parseStatus !== 'failed', true, `Native region write failed: ${JSON.stringify(resRegionMut.diagnostics)}`);
    assert.equal(await fileExists(outRegionMsb), true);

    // Read back mutated native Region MSB via independent Oracle
    const mutatedRegionBuf = await readFile(outRegionMsb);
    const mutatedRegionOracle = readRegionEntityOracle(mutatedRegionBuf, testRegion.entryOffset);
    assert.equal(mutatedRegionOracle.internalEntryId, testRegion.internalEntryId, 'Region internalEntryId must be unchanged');
    assert.equal(mutatedRegionOracle.activationPartIndex, testRegion.activationPartIndex, 'Region activationPartIndex must be unchanged');
    assert.equal(mutatedRegionOracle.entityId, newRegionEntityId, 'Region entityId must match new mutated value');

    // Verify exact byte diff on native MSB: strictly within 4-byte window of testRegion.baseData3Address + 4
    const regionDiffs = computeByteDiffs(decompressed, mutatedRegionBuf);
    assert.equal(regionDiffs.length > 0, true, 'Native region mutation must have at least 1 byte diff');
    assert.equal(
      regionDiffs.every(
        (d) =>
          d.offset >= testRegion.baseData3Address + 4 &&
          d.offset < testRegion.baseData3Address + 8
      ),
      true,
      `Native region mutation must modify bytes strictly within [${testRegion.baseData3Address + 4}, ${testRegion.baseData3Address + 8})`
    );
    assert.equal(mutatedRegionBuf.readInt32LE(testRegion.baseData3Address + 4), newRegionEntityId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const layer = process.argv[2] === '--layer' ? process.argv[3] : undefined;
  if (layer !== 'unit' && layer !== 'native') {
    console.error('Usage: node runAuditSf02Smoke.js --layer unit|native');
    process.exit(1);
  }

  if (layer === 'unit') {
    await runSf02UnitTests();
    console.log(
      JSON.stringify(
        {
          ok: true,
          taskId: 'SF-02',
          layer: 'unit',
          message: 'SF-02 unit smoke passed: T01 (Part EntityID), T02 (Region BaseData3), T54 (old bug detection), negative edge cases, and schema migration verified.',
          verifiedItems: ['T01', 'T02', 'T54', 'negative_gates', 'schema_migration']
        },
        null,
        2
      )
    );
  } else {
    await runSf02NativeTests();
    console.log(
      JSON.stringify(
        {
          ok: true,
          taskId: 'SF-02',
          layer: 'native',
          message: 'SF-02 native smoke passed: Native MSB EntityID read & write verified against independent Oracle with exact 4-byte raw diffs.',
          verifiedItems: ['native_oracle_crosscheck', 'native_part_entityid_write', 'native_region_entityid_write', 'exact_4byte_diff']
        },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

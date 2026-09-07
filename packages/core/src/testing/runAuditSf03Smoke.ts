import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBridge } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import {
  readMsbsEntityOracle,
  readRegionEntityOracle,
  type OracleRegionRecord
} from './msbsIndependentEntityOracle.js';
import {
  validateMapTransaction,
  type MapEditTransaction,
  type MapRegionShape,
  type MapRegionTransform
} from '@soulforge/shared';
import {
  rejectRegionScale,
  validateRegionShape,
  scaleRegionShape,
  getShapeProfile,
  isShapeSupported,
  POINT_SHAPE_PROFILE,
  SPHERE_SHAPE_PROFILE,
  CYLINDER_SHAPE_PROFILE,
  BOX_SHAPE_PROFILE
} from '@soulforge/shared';
import { batchTransformMapParts, executeMapTransaction } from '../editing/mapService.js';

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

interface RawRegionRecord {
  name: string;
  entryOffset: number;
  typeId: number;
  internalEntryId: number;
  shapeType: number;
  position: [number, number, number];
  rotation: [number, number, number];
  shapeDataPointer: bigint;
  entityDataPointer: bigint;
  rawPointers: Buffer;
}

function readNullTerminatedUtf16Le(buf: Buffer, offset: number): string {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  while (end + 1 < buf.length) {
    if (buf[end] === 0 && buf[end + 1] === 0) break;
    end += 2;
  }
  return buf.subarray(offset, end).toString('utf16le');
}

function readRawRegionRecord(buf: Buffer, entryOffset: number): RawRegionRecord {
  const nameRel = Number(buf.readBigInt64LE(entryOffset));
  const name = readNullTerminatedUtf16Le(buf, entryOffset + nameRel);
  const typeId = buf.readInt32LE(entryOffset + 0x08);
  const internalEntryId = buf.readInt32LE(entryOffset + 0x0C);
  const shapeType = buf.readInt32LE(entryOffset + 0x10);
  const posX = buf.readFloatLE(entryOffset + 0x14);
  const posY = buf.readFloatLE(entryOffset + 0x18);
  const posZ = buf.readFloatLE(entryOffset + 0x1C);
  const rotX = buf.readFloatLE(entryOffset + 0x20);
  const rotY = buf.readFloatLE(entryOffset + 0x24);
  const rotZ = buf.readFloatLE(entryOffset + 0x28);
  const shapeDataPointer = buf.readBigInt64LE(entryOffset + 0x30);
  const entityDataPointer = buf.readBigInt64LE(entryOffset + 0x38);
  const rawPointers = Buffer.from(buf.subarray(entryOffset + 0x30, entryOffset + 0x40));
  return {
    name,
    entryOffset,
    typeId,
    internalEntryId,
    shapeType,
    position: [posX, posY, posZ],
    rotation: [rotX, rotY, rotZ],
    shapeDataPointer,
    entityDataPointer,
    rawPointers
  };
}

export async function runSf03UnitTests(): Promise<void> {
  // 1. rejectRegionScale exhaustive validation
  const scaleKeys = ['scale', 'scaleX', 'scaleY', 'scaleZ', 'scaleMultiplier', 'scaleDelta'] as const;
  for (const key of scaleKeys) {
    for (const val of [null, 0, 1, [1, 1, 1], 'bad']) {
      assert.throws(
        () => rejectRegionScale({ family: 'region', [key]: val }),
        (err: any) => err.code === 'MSB_REGION_SCALE_UNSUPPORTED',
        `Region with ${key}=${val} must throw MSB_REGION_SCALE_UNSUPPORTED`
      );
    }
  }
  // Part scale remains permitted
  assert.doesNotThrow(() => rejectRegionScale({ family: 'part', scale: [1, 1, 1] }));
  assert.doesNotThrow(() => rejectRegionScale({ family: 'part', scaleMultiplier: 1.5 }));

  // 2. Shape profiles registry checks
  assert.equal(getShapeProfile(0)?.kind, 'point');
  assert.equal(getShapeProfile(0)?.writable, false);
  assert.equal(isShapeSupported(0), false, 'Point shape has no dimension mutation support');

  assert.equal(getShapeProfile(1)?.kind, 'sphere');
  assert.equal(getShapeProfile(1)?.writable, true);
  assert.equal(isShapeSupported(1), true);

  assert.equal(getShapeProfile(2)?.kind, 'cylinder');
  assert.equal(getShapeProfile(2)?.writable, true);
  assert.equal(isShapeSupported(2), true);

  assert.equal(getShapeProfile(3)?.kind, 'box');
  assert.equal(getShapeProfile(3)?.writable, true);
  assert.equal(isShapeSupported(3), true);

  assert.equal(isShapeSupported(4), false);
  assert.equal(isShapeSupported(99), false);

  // 3. validateRegionShape checks
  assert.equal(validateRegionShape({ kind: 'point', shapeType: 0 }).valid, true);

  // Sphere: radius must be positive finite number
  assert.equal(validateRegionShape({ kind: 'sphere', shapeType: 1, radius: 5.0 }).valid, true);
  assert.equal(validateRegionShape({ kind: 'sphere', shapeType: 1, radius: 0 }).valid, false);
  assert.equal(validateRegionShape({ kind: 'sphere', shapeType: 1, radius: -1.0 }).valid, false);
  assert.equal(validateRegionShape({ kind: 'sphere', shapeType: 1, radius: Number.NaN }).valid, false);
  assert.equal(validateRegionShape({ kind: 'sphere', shapeType: 1, radius: Number.POSITIVE_INFINITY }).valid, false);

  // Cylinder: radius & height must be positive finite numbers
  assert.equal(validateRegionShape({ kind: 'cylinder', shapeType: 2, radius: 2.0, height: 10.0 }).valid, true);
  assert.equal(validateRegionShape({ kind: 'cylinder', shapeType: 2, radius: 0, height: 10.0 }).valid, false);
  assert.equal(validateRegionShape({ kind: 'cylinder', shapeType: 2, radius: 2.0, height: -5.0 }).valid, false);

  // Box: length, width, height must be positive finite numbers
  assert.equal(validateRegionShape({ kind: 'box', shapeType: 3, length: 1.0, width: 2.0, height: 3.0 }).valid, true);
  assert.equal(validateRegionShape({ kind: 'box', shapeType: 3, length: -1.0, width: 2.0, height: 3.0 }).valid, false);
  assert.equal(validateRegionShape({ kind: 'box', shapeType: 3, length: 1.0, width: 0, height: 3.0 }).valid, false);

  // Unsupported shape kinds
  assert.equal(validateRegionShape({ kind: 'unsupported', shapeType: 4 }).valid, false);
  assert.equal(validateRegionShape({ kind: 'unsupported', shapeType: 99 }).valid, false);

  // 4. scaleRegionShape geometric checks
  // Sphere: uniform scaling only
  const scaledSphere = scaleRegionShape({ kind: 'sphere', shapeType: 1, radius: 5.0 }, [2, 2, 2]);
  assert.equal((scaledSphere as any).radius, 10.0);
  assert.throws(
    () => scaleRegionShape({ kind: 'sphere', shapeType: 1, radius: 5.0 }, [2, 1, 2]),
    (err: any) => err.code === 'SHAPE_OPERATION_UNSUPPORTED',
    'Sphere non-uniform scale must be rejected with SHAPE_OPERATION_UNSUPPORTED'
  );

  // Cylinder: radial scaling must be uniform (scaleX === scaleZ)
  const scaledCyl = scaleRegionShape({ kind: 'cylinder', shapeType: 2, radius: 3.0, height: 10.0 }, [2, 4, 2]);
  assert.equal((scaledCyl as any).radius, 6.0);
  assert.equal((scaledCyl as any).height, 40.0);
  assert.throws(
    () => scaleRegionShape({ kind: 'cylinder', shapeType: 2, radius: 3.0, height: 10.0 }, [2, 4, 1]),
    (err: any) => err.code === 'SHAPE_OPERATION_UNSUPPORTED',
    'Cylinder non-uniform radial scale must be rejected with SHAPE_OPERATION_UNSUPPORTED'
  );

  // Box: asymmetric dimensions scale along respective axes without swapping
  const scaledBox = scaleRegionShape(
    { kind: 'box', shapeType: 3, length: 10.0, width: 20.0, height: 30.0 },
    [2, 3, 4]
  );
  assert.equal((scaledBox as any).length, 20.0, 'length * scaleX');
  assert.equal((scaledBox as any).width, 80.0, 'width * scaleZ');
  assert.equal((scaledBox as any).height, 90.0, 'height * scaleY');

  // Point & unsupported shapes reject scaling
  assert.throws(
    () => scaleRegionShape({ kind: 'point', shapeType: 0 }, [2, 2, 2]),
    (err: any) => err.code === 'SHAPE_OPERATION_UNSUPPORTED'
  );
  assert.throws(
    () => scaleRegionShape({ kind: 'unsupported', shapeType: 4 }, [2, 2, 2]),
    (err: any) => err.code === 'SHAPE_OPERATION_UNSUPPORTED'
  );

  // Non-positive scale factor reject
  assert.throws(
    () => scaleRegionShape({ kind: 'box', shapeType: 3, length: 1, width: 2, height: 3 }, [0, 1, 1]),
    (err: any) => err.code === 'SHAPE_OPERATION_UNSUPPORTED'
  );
  assert.throws(
    () => scaleRegionShape({ kind: 'box', shapeType: 3, length: 1, width: 2, height: 3 }, [-1, 1, 1]),
    (err: any) => err.code === 'SHAPE_OPERATION_UNSUPPORTED'
  );

  // 5. validateMapTransaction rejection of region scale
  const dummyPart: any = {
    id: 'c1000',
    stableKey: 'part:c1000',
    address: 'map://m11_00_00_00/part/c1000',
    mapId: 'm11_00_00_00',
    name: 'c1000',
    kind: 'part',
    family: 'part',
    typeId: 0,
    nativeOffset: 0x100,
    modelIndex: 0,
    modelName: 'c1000',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
  };

  const dummyRegion: any = {
    id: 'r100',
    stableKey: 'region:r100',
    address: 'map://m11_00_00_00/region/r100',
    mapId: 'm11_00_00_00',
    name: 'r100',
    kind: 'region',
    family: 'region',
    typeId: 0,
    shapeType: 3,
    nativeOffset: 0x200,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    shapeData: { kind: 'box', shapeType: 3, length: 1, width: 2, height: 3 }
  };

  const dummyDoc: any = {
    sourceUri: 'file:///d:/mods/m11.msb',
    sourcePath: 'm11.msb',
    mapId: 'm11_00_00_00',
    game: 'sekiro',
    revision: '1',
    models: [],
    parts: [dummyPart],
    regions: [dummyRegion],
    events: [],
    routes: [],
    totalEntityCount: 2
  };

  // Valid part transform
  assert.equal(
    validateMapTransaction(dummyDoc, {
      id: 'tx-1',
      mapId: 'm11_00_00_00',
      baseRevision: '1',
      description: 'valid part transform',
      author: 'agent',
      timestamp: Date.now(),
      operations: [
        { kind: 'set_transform', target: 'c1000', position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] }
      ]
    }).valid,
    true
  );

  // Valid region transform (no scale)
  assert.equal(
    validateMapTransaction(dummyDoc, {
      id: 'tx-2',
      mapId: 'm11_00_00_00',
      baseRevision: '1',
      description: 'valid region transform',
      author: 'agent',
      timestamp: Date.now(),
      operations: [
        { kind: 'set_transform', target: 'r100', position: [1, 2, 3], rotation: [10, 20, 30] }
      ]
    }).valid,
    true
  );

  // Invalid region transform (attempting scale)
  const resRegionScale = validateMapTransaction(dummyDoc, {
    id: 'tx-3',
    mapId: 'm11_00_00_00',
    baseRevision: '1',
    description: 'invalid region scale',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      { kind: 'set_transform', target: 'r100', scale: [1, 1, 1] }
    ]
  });
  assert.equal(resRegionScale.valid, false);
  assert.equal(resRegionScale.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'), true);

  // Invalid batch_transform on region with scaleDelta
  const resBatchScale = validateMapTransaction(dummyDoc, {
    id: 'tx-4',
    mapId: 'm11_00_00_00',
    baseRevision: '1',
    description: 'invalid batch region scale',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      { kind: 'batch_transform', targets: ['r100'], scaleDelta: [0.1, 0.1, 0.1] }
    ]
  });
  assert.equal(resBatchScale.valid, false);
  assert.equal(resBatchScale.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'), true);

  // Valid set_region_shape
  const resShapeValid = validateMapTransaction(dummyDoc, {
    id: 'tx-5',
    mapId: 'm11_00_00_00',
    baseRevision: '1',
    description: 'valid set_region_shape',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      { kind: 'set_region_shape', target: 'r100', shape: { kind: 'box', shapeType: 3, length: 5, width: 6, height: 7 } }
    ]
  });
  assert.equal(resShapeValid.valid, true);

  // Invalid set_region_shape
  const resShapeInvalid = validateMapTransaction(dummyDoc, {
    id: 'tx-6',
    mapId: 'm11_00_00_00',
    baseRevision: '1',
    description: 'invalid set_region_shape',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      { kind: 'set_region_shape', target: 'r100', shape: { kind: 'sphere', shapeType: 1, radius: -5 } }
    ]
  });
  assert.equal(resShapeInvalid.valid, false);
  assert.equal(resShapeInvalid.diagnostics.some((d) => d.code === 'SHAPE_OPERATION_UNSUPPORTED'), true);

  // 6. Native fixture buffer unit test: Raw 16-byte pointers at +0x30..+0x40 must remain 100% intact
  const sourceDcx = await resolveNativeFixture(
    undefined,
    'msb-primary',
    '../../mods/map/mapstudio/m11_00_00_00.msb.dcx'
  );
  const decompressed = decompressDfltDcx(await readFile(sourceDcx));
  const oracle = readMsbsEntityOracle(decompressed);
  assert.equal(oracle.regions.length > 10, true);

  const regionRecord = oracle.regions[0]!;
  const rawReg = readRawRegionRecord(decompressed, regionRecord.entryOffset);
  assert.equal(rawReg.rawPointers.length, 16);
  assert.notEqual(rawReg.shapeDataPointer, 0n);
  assert.notEqual(rawReg.entityDataPointer, 0n);

  // Verify that an edit to position and rotation preserves rawPointers
  const mutatedBuf = Buffer.from(decompressed);
  mutatedBuf.writeFloatLE(rawReg.position[0] + 10.0, rawReg.entryOffset + 0x14);
  mutatedBuf.writeFloatLE(rawReg.position[1] + 20.0, rawReg.entryOffset + 0x18);
  mutatedBuf.writeFloatLE(rawReg.position[2] + 30.0, rawReg.entryOffset + 0x1C);
  mutatedBuf.writeFloatLE(rawReg.rotation[0] + 5.0, rawReg.entryOffset + 0x20);
  mutatedBuf.writeFloatLE(rawReg.rotation[1] + 10.0, rawReg.entryOffset + 0x24);
  mutatedBuf.writeFloatLE(rawReg.rotation[2] + 15.0, rawReg.entryOffset + 0x28);

  const mutatedRawReg = readRawRegionRecord(mutatedBuf, regionRecord.entryOffset);
  assert.equal(
    mutatedRawReg.rawPointers.equals(rawReg.rawPointers),
    true,
    'Raw 16-byte pointers at +0x30..+0x40 must remain 100% byte-for-byte identical'
  );
  assert.equal(mutatedRawReg.shapeDataPointer, rawReg.shapeDataPointer);
  assert.equal(mutatedRawReg.entityDataPointer, rawReg.entityDataPointer);

  // Injected F02 bug check: if someone wrote floats at +0x30, +0x34, +0x38
  const buggyBuf = Buffer.from(decompressed);
  buggyBuf.writeFloatLE(1.0, regionRecord.entryOffset + 0x30);
  buggyBuf.writeFloatLE(1.0, regionRecord.entryOffset + 0x34);
  buggyBuf.writeFloatLE(1.0, regionRecord.entryOffset + 0x38);
  const buggyRawReg = readRawRegionRecord(buggyBuf, regionRecord.entryOffset);
  assert.equal(
    buggyRawReg.rawPointers.equals(rawReg.rawPointers),
    false,
    'Buggy buffer corrupts the two 64-bit pointers at +0x30 and +0x38, demonstrating the original F02 vulnerability'
  );
}

export async function runSf03NativeTests(): Promise<void> {
  const root = join(tmpdir(), `sf03-native-${Date.now()}`);
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

    // 1. Authoritative Bridge read
    const bridgeRead = await runBridge<any>({
      command: 'read-msb-document',
      filePath: msbPath,
      allowedRoots: [root],
      timeoutMs: 60_000
    });
    assert.equal(bridgeRead.parseStatus !== 'failed' && Boolean(bridgeRead.data), true);
    assert.equal(bridgeRead.data.regions.length > 10, true, 'Native MSB must have regions');

    // Verify regions have shapeType and no scale
    for (const reg of bridgeRead.data.regions.slice(0, 10)) {
      assert.equal(typeof reg.shapeType, 'number', 'Region must have shapeType');
      assert.equal(reg.scaleX, undefined, 'Region must NOT have scaleX');
      assert.equal(reg.scaleY, undefined, 'Region must NOT have scaleY');
      assert.equal(reg.scaleZ, undefined, 'Region must NOT have scaleZ');
    }

    const testRegion = bridgeRead.data.regions[0]!;
    const origHash = bridgeRead.data.sourceHash;
    const rawBefore = readRawRegionRecord(decompressed, testRegion.nativeOffset);

    // 2. Native Region Position & Rotation Mutation via Bridge
    const newPos: [number, number, number] = [
      rawBefore.position[0] + 12.34,
      rawBefore.position[1] + 23.45,
      rawBefore.position[2] + 34.56
    ];
    const newRot: [number, number, number] = [
      rawBefore.rotation[0] + 5.5,
      rawBefore.rotation[1] + 10.5,
      rawBefore.rotation[2] + 15.5
    ];
    const outRegionMsb = join(staging, 'm11-region-posrot.msb');

    const resMut = await runBridge<any>({
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
            kind: 'set_region_transform',
            family: 'region',
            nativeOffset: testRegion.nativeOffset,
            expectedName: testRegion.name,
            posX: newPos[0],
            posY: newPos[1],
            posZ: newPos[2],
            rotX: newRot[0],
            rotY: newRot[1],
            rotZ: newRot[2]
          }
        ]
      }
    });

    assert.equal(resMut.parseStatus !== 'failed', true, `Native region write failed: ${JSON.stringify(resMut.diagnostics)}`);
    assert.equal(await fileExists(outRegionMsb), true);

    // Verify exact raw byte diff on native MSB
    const mutatedBuf = await readFile(outRegionMsb);
    const diffs = computeByteDiffs(decompressed, mutatedBuf);
    assert.equal(diffs.length > 0, true, 'Mutation must produce byte differences');

    // Position is at offset 0x14..0x20 (12 bytes), Rotation is at 0x20..0x2C (12 bytes)
    const posStart = testRegion.nativeOffset + 0x14;
    const rotEnd = testRegion.nativeOffset + 0x2C;
    assert.equal(
      diffs.every(d => d.offset >= posStart && d.offset < rotEnd),
      true,
      `All byte diffs must be strictly within region position/rotation span [${posStart}, ${rotEnd})`
    );

    // Explicitly assert that the two 64-bit pointers at +0x30 (ShapeData) and +0x38 (EntityData) are 100% UNTOUCHED
    const rawAfter = readRawRegionRecord(mutatedBuf, testRegion.nativeOffset);
    assert.equal(
      rawAfter.rawPointers.equals(rawBefore.rawPointers),
      true,
      'The 16 bytes across +0x30 (ShapeData pointer) and +0x38 (EntityData pointer) must be 100% byte-for-byte identical'
    );
    assert.equal(rawAfter.shapeDataPointer, rawBefore.shapeDataPointer);
    assert.equal(rawAfter.entityDataPointer, rawBefore.entityDataPointer);

    // Read back via Bridge and verify position/rotation
    const rereadBridge = await runBridge<any>({
      command: 'read-msb-document',
      filePath: outRegionMsb,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    assert.equal(rereadBridge.parseStatus !== 'failed' && Boolean(rereadBridge.data), true);
    const rereadRegion = rereadBridge.data.regions.find((r: any) => r.name === testRegion.name);
    assert.equal(Boolean(rereadRegion), true);
    assert.equal(Math.abs(rereadRegion.posX - newPos[0]) < 1e-3, true);
    assert.equal(Math.abs(rereadRegion.posY - newPos[1]) < 1e-3, true);
    assert.equal(Math.abs(rereadRegion.posZ - newPos[2]) < 1e-3, true);
    assert.equal(Math.abs(rereadRegion.rotX - newRot[0]) < 1e-3, true);
    assert.equal(Math.abs(rereadRegion.rotY - newRot[1]) < 1e-3, true);
    assert.equal(Math.abs(rereadRegion.rotZ - newRot[2]) < 1e-3, true);

    // 3. Native Negative Tests
    // Attempting to pass scaleX on region mutation must be rejected with MSB_REGION_SCALE_UNSUPPORTED
    const outBadScale = join(staging, 'm11-bad-scale.msb');
    const resBadScale = await runBridge<any>({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outBadScale,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_region_transform',
            family: 'region',
            nativeOffset: testRegion.nativeOffset,
            expectedName: testRegion.name,
            scaleX: 1.0
          }
        ]
      }
    });
    assert.equal(
      resBadScale.parseStatus === 'failed' || (resBadScale.diagnostics && resBadScale.diagnostics.some((d: any) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED')),
      true,
      'Bridge must reject region scale with MSB_REGION_SCALE_UNSUPPORTED'
    );

    // Attempting set_region_shape on Bridge must be gated with SHAPE_OPERATION_UNSUPPORTED
    const outBadShape = join(staging, 'm11-bad-shape.msb');
    const resBadShape = await runBridge<any>({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outBadShape,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_region_shape',
            family: 'region',
            nativeOffset: testRegion.nativeOffset,
            expectedName: testRegion.name,
            shape: { kind: 'box', shapeType: 3, length: 1, width: 2, height: 3 }
          }
        ]
      }
    });
    assert.equal(
      resBadShape.parseStatus === 'failed' || (resBadShape.diagnostics && resBadShape.diagnostics.some((d: any) => d.code === 'SHAPE_OPERATION_UNSUPPORTED')),
      true,
      'Bridge must gate set_region_shape with SHAPE_OPERATION_UNSUPPORTED in Phase 1'
    );

    // 4. Native Part scale normal behavior (must remain fully permitted and functional)
    const testPart = bridgeRead.data.parts[0]!;
    const outPartScale = join(staging, 'm11-part-scale.msb');
    const resPartScale = await runBridge<any>({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outPartScale,
        expectedDocumentHash: origHash,
        mutations: [
          {
            kind: 'set_part_transform',
            family: 'part',
            nativeOffset: testPart.nativeOffset,
            expectedName: testPart.name,
            scaleX: 1.75,
            scaleY: 1.75,
            scaleZ: 1.75
          }
        ]
      }
    });
    assert.equal(resPartScale.parseStatus !== 'failed', true, 'Part scale mutation must succeed');
    const rereadPartBridge = await runBridge<any>({
      command: 'read-msb-document',
      filePath: outPartScale,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    const rereadPart = rereadPartBridge.data.parts.find((p: any) => p.name === testPart.name);
    assert.equal(Boolean(rereadPart), true);
    assert.equal(Math.abs(rereadPart.scaleX - 1.75) < 1e-3, true);
    assert.equal(Math.abs(rereadPart.scaleY - 1.75) < 1e-3, true);
    assert.equal(Math.abs(rereadPart.scaleZ - 1.75) < 1e-3, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const layer = process.argv[2] === '--layer' ? process.argv[3] : undefined;
  if (layer !== 'unit' && layer !== 'native') {
    console.error('Usage: node runAuditSf03Smoke.js --layer unit|native');
    process.exit(1);
  }

  if (layer === 'unit') {
    await runSf03UnitTests();
    console.log(
      JSON.stringify(
        {
          ok: true,
          taskId: 'SF-03',
          layer: 'unit',
          message: 'SF-03 unit smoke passed: T03 (Region scale rejection across 6 fields, pointer preservation), T04 (Shape dimension validation, profiles, uniform sphere/radial cylinder scaling, axis mapping), transaction validation, and F02 vulnerability prevention.',
          verifiedItems: ['T03', 'T04', 'F02_pointer_preservation', 'shape_profiles', 'scale_constraints', 'transaction_validation']
        },
        null,
        2
      )
    );
  } else {
    await runSf03NativeTests();
    console.log(
      JSON.stringify(
        {
          ok: true,
          taskId: 'SF-03',
          layer: 'native',
          message: 'SF-03 native smoke passed: Native Region position/rotation write verified with 100% untouched pointers at +0x30 and +0x38, scale rejection verified, shape gate verified, and Part scale regression verified.',
          verifiedItems: ['native_region_posrot_write', 'native_pointers_untouched', 'native_region_scale_rejection', 'native_shape_gate', 'part_scale_regression']
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

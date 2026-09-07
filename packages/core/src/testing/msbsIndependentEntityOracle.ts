/**
 * Independent MSBS EntityID Oracle.
 *
 * Dedicated strictly to testing and verification (NOT exported from production barrels).
 * Implements an independent binary reader for Sekiro MSBS Part/Region layouts:
 * - Part InternalEntryId: entry + 0x0C
 * - Part EntityData offset pointer: entry + 0x60 -> EntityID: entry + relative
 * - Region InternalEntryId: entry + 0x0C
 * - Region BaseData3 offset pointer: entry + 0x50 -> ActivationPartIndex: entry + relative + 0, EntityID: entry + relative + 4
 *
 * Zero dependencies on Bridge source or C# helpers.
 */

export interface OraclePartRecord {
  name: string;
  entryOffset: number;
  typeId: number;
  internalEntryId: number;
  modelIndex: number;
  entityDataPointer: bigint;
  entityDataAddress: number;
  entityId: number;
}

export interface OracleRegionRecord {
  name: string;
  entryOffset: number;
  typeId: number;
  internalEntryId: number;
  baseData3Pointer: bigint;
  baseData3Address: number;
  activationPartIndex: number;
  entityId: number;
}

export interface MsbsOracleResult {
  version: number;
  parts: OraclePartRecord[];
  regions: OracleRegionRecord[];
  partByName: Map<string, OraclePartRecord>;
  regionByName: Map<string, OracleRegionRecord>;
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

export function readPartEntityOracle(buf: Buffer, entryOffset: number): OraclePartRecord {
  const nameRel = Number(buf.readBigInt64LE(entryOffset));
  const name = readNullTerminatedUtf16Le(buf, entryOffset + nameRel);
  const typeId = buf.readInt32LE(entryOffset + 0x08);
  const internalEntryId = buf.readInt32LE(entryOffset + 0x0C);
  const modelIndex = buf.readInt32LE(entryOffset + 0x10);
  const entityDataPointer = buf.readBigInt64LE(entryOffset + 0x60);
  const entityDataAddress = entryOffset + Number(entityDataPointer);
  const entityId = buf.readInt32LE(entityDataAddress);

  return {
    name,
    entryOffset,
    typeId,
    internalEntryId,
    modelIndex,
    entityDataPointer,
    entityDataAddress,
    entityId
  };
}

export function readRegionEntityOracle(buf: Buffer, entryOffset: number): OracleRegionRecord {
  const nameRel = Number(buf.readBigInt64LE(entryOffset));
  const name = readNullTerminatedUtf16Le(buf, entryOffset + nameRel);
  const typeId = buf.readInt32LE(entryOffset + 0x08);
  const internalEntryId = buf.readInt32LE(entryOffset + 0x0C);
  const baseData3Pointer = buf.readBigInt64LE(entryOffset + 0x50);
  const baseData3Address = entryOffset + Number(baseData3Pointer);
  const activationPartIndex = buf.readInt32LE(baseData3Address);
  const entityId = buf.readInt32LE(baseData3Address + 4);

  return {
    name,
    entryOffset,
    typeId,
    internalEntryId,
    baseData3Pointer,
    baseData3Address,
    activationPartIndex,
    entityId
  };
}

export function readMsbsEntityOracle(buf: Buffer): MsbsOracleResult {
  if (buf.length < 0x40 || buf.subarray(0, 4).toString('ascii') !== 'MSB ') {
    throw new Error('Invalid MSBS buffer: missing MSB magic');
  }
  const version = buf.readInt32LE(4);

  let curOffset = 0x10;
  const paramOffsets = new Map<string, number[]>();

  while (curOffset > 0 && curOffset + 0x10 <= buf.length) {
    const offsetCount = buf.readInt32LE(curOffset + 4);
    const nameOffset = Number(buf.readBigInt64LE(curOffset + 8));
    const paramName = readNullTerminatedUtf16Le(buf, nameOffset);

    const entryOffsets: number[] = [];
    for (let i = 0; i < offsetCount - 1; i++) {
      entryOffsets.push(Number(buf.readBigInt64LE(curOffset + 0x10 + i * 8)));
    }
    paramOffsets.set(paramName, entryOffsets);

    const nextOffset = Number(buf.readBigInt64LE(curOffset + 0x10 + (offsetCount - 1) * 8));
    if (nextOffset <= curOffset || nextOffset >= buf.length) break;
    curOffset = nextOffset;
  }

  const parts: OraclePartRecord[] = [];
  const partOffsets = paramOffsets.get('PARTS_PARAM_ST') ?? [];
  for (const off of partOffsets) {
    parts.push(readPartEntityOracle(buf, off));
  }

  const regions: OracleRegionRecord[] = [];
  const regionOffsets = paramOffsets.get('POINT_PARAM_ST') ?? [];
  for (const off of regionOffsets) {
    regions.push(readRegionEntityOracle(buf, off));
  }

  const partByName = new Map<string, OraclePartRecord>();
  for (const p of parts) {
    if (!partByName.has(p.name)) partByName.set(p.name, p);
  }

  const regionByName = new Map<string, OracleRegionRecord>();
  for (const r of regions) {
    if (!regionByName.has(r.name)) regionByName.set(r.name, r);
  }

  return {
    version,
    parts,
    regions,
    partByName,
    regionByName
  };
}

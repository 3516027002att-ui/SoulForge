import { check, integer } from './common.mjs';
/** Relative int64 pointer. Offsets are fixture layout constants, not a full MSBS parser. */
export function relativeFieldAddress(bytes, entryStart, pointerField, innerOffset, fieldLength, { minimumHeader=0, ownedEnd=bytes.length }={}) {
  integer(entryStart); integer(pointerField); integer(innerOffset); integer(fieldLength, 1);
  check(Buffer.isBuffer(bytes), 'BUFFER_REQUIRED');
  integer(minimumHeader);integer(ownedEnd,entryStart+1,bytes.length);
  const pointerAt = BigInt(entryStart) + BigInt(pointerField);
  check(pointerAt + 8n <= BigInt(ownedEnd), 'POINTER_FIELD_OOB');
  const relative = bytes.readBigInt64LE(Number(pointerAt));
  check(relative > 0n && relative >= BigInt(minimumHeader), 'RELATIVE_POINTER_INVALID');
  const target = BigInt(entryStart) + relative + BigInt(innerOffset);
  check(target >= 0n && target + BigInt(fieldLength) <= BigInt(ownedEnd), 'TARGET_OOB');
  check(target % 4n === 0n, 'TARGET_UNALIGNED');
  return Number(target);
}
export function entityFieldAddress(bytes, entryStart, family, ownedEnd=bytes.length) {
  check(family === 'part' || family === 'region', 'MSB_FAMILY_UNSUPPORTED');
  // Derived from independent MSBS field order cited by original report X01/X02.
  return family === 'part'
    ? relativeFieldAddress(bytes, entryStart, 0x60, 0, 4, {minimumHeader:0xA0,ownedEnd})
    : relativeFieldAddress(bytes, entryStart, 0x50, 4, 4, {minimumHeader:0x60,ownedEnd});
}
export function patchEntityId(bytes, entryStart, family, next) {
  integer(next, -2147483648, 2147483647);
  const address = entityFieldAddress(bytes, entryStart, family);
  check(address !== entryStart + 0x0c, 'ENTITY_ALIASES_INTERNAL_ID');
  // Production additionally checks verified section ownership, overlap and profile.
  const result = Buffer.from(bytes);
  result.writeInt32LE(next, address);
  return { result, changedRange: [address, address + 4] };
}
export function rejectRegionScale(mutation) {
  const has = key => Object.prototype.hasOwnProperty.call(mutation, key);
  if (mutation.family === 'region') {
    check(!['scale', 'scaleX', 'scaleY', 'scaleZ', 'scaleMultiplier', 'scaleDelta'].some(has), 'MSB_REGION_SCALE_UNSUPPORTED');
  }
}
/** A complete descriptor certificate is mandatory; a currently empty edge list is not one. */
export function remapReferences(oldCount, removedIndices, references, { complete } = {}) {
  integer(oldCount);
  check(complete === true, 'REFERENCE_COVERAGE_INCOMPLETE');
  const removed = new Set();
  for (const value of removedIndices) { integer(value, 0, oldCount - 1); check(!removed.has(value), 'DUPLICATE_DELETE'); removed.add(value); }
  let next = 0;
  const map = Array.from({ length: oldCount }, (_, i) => removed.has(i) ? -1 : next++);
  const rewritten = references.map(ref => {
    integer(ref.value, -1, oldCount - 1);
    if (ref.value === -1) return { ...ref };
    const value = map[ref.value];
    if (value === -1) {
      check(ref.nullable === true && ref.onDelete === 'clear', 'DELETE_REFERENCED_TARGET');
      return { ...ref, value: -1 };
    }
    return { ...ref, value };
  });
  return { map, rewritten };
}
export function queryMapIntersection(entities, query) {
  const allowed = new Set(['modelName', 'entityId', 'kind', 'nameContains']);
  check(Object.keys(query).every(k => allowed.has(k)), 'QUERY_FIELD_UNSUPPORTED');
  return entities.filter(e =>
    (query.modelName === undefined || e.modelName === query.modelName) &&
    (query.entityId === undefined || e.entityId === query.entityId) &&
    (query.kind === undefined || e.kind === query.kind) &&
    (query.nameContains === undefined || e.name.toLowerCase().includes(query.nameContains.toLowerCase())));
}
export function resolveAllTargets(requested, lookup) {
  check(requested.length > 0, 'TARGET_SET_EMPTY');
  const resolved = [], seen = new Set();
  for (const target of requested) {
    const value = lookup(target);
    check(value !== undefined && value !== null, 'TARGET_NOT_FOUND_OR_AMBIGUOUS');
    check(!seen.has(value.key), 'TARGET_DUPLICATE');
    seen.add(value.key); resolved.push(value);
  }
  return resolved;
}

import { check, integer, nonempty } from './common.mjs';
/** Operations bind to immutable snapshot handles, never to the shrinking working array. */
export function simulateRows(snapshot, mutations, width) {
  integer(width, 1);
  const baseline = new Map();
  const working = new Map();
  const order = [];
  const idCounts = new Map();
  const originalIds = new Set();
  for (const row of snapshot) {
    nonempty(row.handle); integer(row.id, -2147483648, 2147483647);
    check(!baseline.has(row.handle), 'DUPLICATE_HANDLE');
    check(Buffer.isBuffer(row.data) && row.data.length === width, 'ROW_WIDTH');
    check(row.name === null || typeof row.name === 'string', 'ROW_NAME');
    baseline.set(row.handle, row);
    working.set(row.handle, { ...row }); order.push(row.handle);
    idCounts.set(row.id,(idCounts.get(row.id)??0)+1);originalIds.add(row.id);
  }
  const touched = new Set(), deleted = new Set();
  // Resolve every original target and precondition against the same initial snapshot.
  for (const op of mutations) {
    check(['update','delete','add'].includes(op.kind), 'ROW_OPERATION_UNSUPPORTED');
    if (op.kind === 'add') continue;
    const original = baseline.get(op.handle);
    check(original !== undefined, 'SNAPSHOT_HANDLE_UNKNOWN');
    check(original.id === op.expectedId, 'ROW_ID_MISMATCH');
    check(Buffer.isBuffer(op.expectedData) && original.data.equals(op.expectedData), 'ROW_PREIMAGE_MISMATCH');
  }
  for (const op of mutations) {
    if (op.kind === 'add') {
      nonempty(op.handle); integer(op.id, -2147483648, 2147483647);
      check(!baseline.has(op.handle) && !working.has(op.handle) && !deleted.has(op.handle), 'HANDLE_REUSE');
      check((idCounts.get(op.id)??0)===0, 'ADD_ID_OCCUPIED');
      check(!originalIds.has(op.id),'ADD_REQUIRES_REPLACE_ROW');
      check(Buffer.isBuffer(op.data) && op.data.length === width, 'ROW_WIDTH');
      check(op.name === null || typeof op.name === 'string', 'ROW_NAME');
      working.set(op.handle, {handle:op.handle,id:op.id,name:op.name,data:Buffer.from(op.data)});
      order.push(op.handle); idCounts.set(op.id,1); touched.add(op.handle); continue;
    }
    const row = working.get(op.handle);
    check(row !== undefined, 'TARGET_ALREADY_DELETED');
    if (op.kind === 'delete') { idCounts.set(row.id,idCounts.get(row.id)-1); working.delete(op.handle); deleted.add(op.handle); touched.add(op.handle); continue; }
    if (Object.prototype.hasOwnProperty.call(op, 'data')) {
      check(Buffer.isBuffer(op.data) && op.data.length === width, 'ROW_WIDTH'); row.data = Buffer.from(op.data);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'name')) {
      check(op.name === null || typeof op.name === 'string', 'ROW_NAME'); row.name = op.name;
    }
    touched.add(op.handle);
  }
  const finalRows = order.filter(h => working.has(h)).map(h => working.get(h));
  return { finalRows, touched: [...touched], deleted: [...deleted] };
}
/** Ordered semantic projection avoids ambiguity from duplicate ID/name/data and shifted positions. */
export function verifyRows(expected, actual) {
  check(expected.length === actual.length, 'ROW_COUNT_POSTCONDITION');
  expected.forEach((row, i) => {
    const got = actual[i];
    check(row.id === got.id, 'ROW_ID_POSTCONDITION');
    check(row.name === got.name, 'ROW_NAME_POSTCONDITION');
    check(Buffer.isBuffer(got.data) && row.data.equals(got.data), 'ROW_DATA_POSTCONDITION');
  });
  return true;
}

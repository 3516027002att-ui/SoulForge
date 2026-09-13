import assert from 'node:assert/strict';
import type { ParamExport, ParamFieldSymbol, ParamRowSymbol } from '@soulforge/shared';
import { cloneParamExports } from '../indexing/cloneParamExport.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

interface FutureMetadata {
  nested: {
    label: string;
    date: Date;
    map: Map<string, unknown>;
    set: Set<string>;
    bytes: Uint8Array;
    self?: unknown;
  };
}

interface ExtendedParamRow extends ParamRowSymbol {
  futureRow: { nested: { count: number } };
}

type ExtendedParamField = ParamFieldSymbol & { futureField: { nested: { keep: boolean } } };

interface ExtendedParamExport extends ParamExport {
  futureMetadata: FutureMetadata;
}

function defineOwnDataProperty(target: object, key: PropertyKey, value: unknown, enumerable = true): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable,
    writable: true,
    value
  });
}

function makeParamExport(description = 'health'): ExtendedParamExport {
  const metadataNested: FutureMetadata['nested'] = {
    label: 'preserve-me',
    date: new Date('2026-09-09T00:00:00.000Z'),
    map: new Map(),
    set: new Set(['future-set']),
    bytes: new Uint8Array([1, 2, 3])
  };
  metadataNested.self = metadataNested;
  metadataNested.map.set('self', metadataNested);

  const rawObject: Record<string, unknown> = {
    typeName: 'NpcParam',
    dataHash: 'row-1',
    nested: { keep: true }
  };
  rawObject.self = rawObject;
  const sharedRaw = { marker: 'shared-raw' };
  rawObject.aliasA = sharedRaw;
  rawObject.aliasB = sharedRaw;
  const rawArray: unknown[] = [{ typeName: 'NpcParam', dataHash: 'row-2' }];
  rawArray.push(rawArray);

  const firstField = {
    fieldId: 'hp',
    name: 'HP',
    type: 'int32',
    description,
    value: 100,
    futureField: { nested: { keep: true } }
  };

  return {
    paramName: 'NpcParam',
    sourceUri: 'file:///param/gameparam.parambnd.dcx',
    entryName: 'NpcParam.param',
    entryIndex: 7,
    sourceHash: 'child-hash',
    outerFileHash: 'outer-hash',
    sourceRevision: 42,
    futureMetadata: { nested: metadataNested },
    rows: [
      {
        uri: 'file:///param/gameparam.parambnd.dcx#NpcParam/1',
        sourceUri: 'file:///param/gameparam.parambnd.dcx',
        paramName: 'NpcParam',
        entryName: 'NpcParam.param',
        entryIndex: 7,
        rowId: 1,
        rowName: 'one',
        fields: [firstField],
        raw: rawObject,
        futureRow: { nested: { count: 1 } }
      } as ExtendedParamRow,
      {
        uri: 'file:///param/gameparam.parambnd.dcx#NpcParam/2',
        sourceUri: 'file:///param/gameparam.parambnd.dcx',
        paramName: 'NpcParam',
        entryName: 'NpcParam.param',
        entryIndex: 7,
        rowId: 2,
        fields: [{ fieldId: 'scale', name: 'Scale', value: 1.25 }],
        raw: rawArray,
        futureRow: { nested: { count: 2 } }
      } as ExtendedParamRow
    ]
  };
}

function testCloneGranularity(): void {
  const source = makeParamExport();
  // Keep a baseline deep-equality assertion before adding extension keys that
  // the legacy Object.keys boundary intentionally ignores (symbols/hidden).
  assert.deepEqual(cloneParamExports([source]), [source]);

  const ignoredSymbol = Symbol('ignored-by-param-clone');
  let getterReads = 0;
  defineOwnDataProperty(source, 'futureScalar', 'preserve-me');
  defineOwnDataProperty(source, '__proto__', 'export-proto-data');
  defineOwnDataProperty(source.rows[0]!, '__proto__', 'row-proto-data');
  defineOwnDataProperty(source, 'hiddenExtension', 'ignore-me', false);
  defineOwnDataProperty(source, ignoredSymbol, 'ignore-symbol');
  Object.defineProperty(source, 'getterExtension', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return 'getter-value';
    }
  });

  const nativeStructuredClone = globalThis.structuredClone;
  const inputs: unknown[] = [];
  globalThis.structuredClone = ((value: unknown) => {
    inputs.push(value);
    return nativeStructuredClone(value);
  }) as typeof structuredClone;
  let cloned: ParamExport[];
  try {
    cloned = cloneParamExports([source]);
  } finally {
    globalThis.structuredClone = nativeStructuredClone;
  }

  const forbiddenWholeInputs = new Set<unknown>([
    source,
    source.rows,
    source.rows[0],
    source.rows[0]!.fields,
    source.rows[1],
    source.rows[1]!.fields
  ]);
  assert.equal(
    inputs.some((input) => forbiddenWholeInputs.has(input)),
    false,
    'clone helper must not serialize the export, row, or fields table as a whole'
  );
  assert.ok(inputs.length >= 1 + source.rows.length, 'complex metadata/raw values remain isolated');
  assert.ok(inputs.every((input) => typeof input === 'object' && input !== null && !Array.isArray(input)));
  const copy = cloned![0]! as ExtendedParamExport;
  const copyRecord = copy as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  assert.equal(copyRecord.futureScalar, sourceRecord.futureScalar);
  assert.equal(copyRecord.getterExtension, 'getter-value');
  assert.equal(getterReads, 1, 'enumerable accessors should be read once before the scalar spread');
  assert.equal(Object.prototype.hasOwnProperty.call(copyRecord, '__proto__'), true);
  assert.equal(copyRecord['__proto__'], 'export-proto-data');
  assert.equal(Object.getPrototypeOf(copyRecord), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(copyRecord, 'hiddenExtension'), false);
  assert.deepEqual(Object.getOwnPropertySymbols(copyRecord), []);
  assert.notEqual(copy, source);
  assert.notEqual(copy.rows, source.rows);
  assert.notEqual(copy.rows[0], source.rows[0]);
  const copiedRowRecord = copy.rows[0]! as unknown as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(copiedRowRecord, '__proto__'), true);
  assert.equal(copiedRowRecord['__proto__'], 'row-proto-data');
  assert.equal(Object.getPrototypeOf(copiedRowRecord), Object.prototype);
  assert.notEqual(copy.rows[0]!.fields, source.rows[0]!.fields);
  assert.notEqual(copy.rows[0]!.fields![0], source.rows[0]!.fields![0]);
  assert.notEqual((copy.rows[0]!.fields![0] as ExtendedParamField).futureField,
    (source.rows[0]!.fields![0] as ExtendedParamField).futureField);
  assert.notEqual(copy.rows[0]!.raw, source.rows[0]!.raw);
  assert.notEqual(copy.rows[1]!.raw, source.rows[1]!.raw);
  assert.notEqual(copy.futureMetadata, source.futureMetadata);
  assert.notEqual(copy.futureMetadata.nested, source.futureMetadata.nested);
  assert.ok(copy.futureMetadata.nested.date instanceof Date);
  assert.ok(copy.futureMetadata.nested.map instanceof Map);
  assert.ok(copy.futureMetadata.nested.set instanceof Set);
  assert.ok(copy.futureMetadata.nested.bytes instanceof Uint8Array);
  assert.equal(copy.futureMetadata.nested.self, copy.futureMetadata.nested);
  assert.equal(copy.futureMetadata.nested.map.get('self'), copy.futureMetadata.nested);
  assert.equal((copy.rows[0]!.raw as { self: unknown }).self, copy.rows[0]!.raw);
  const copiedRaw = copy.rows[0]!.raw as { aliasA: unknown; aliasB: unknown };
  const sourceRaw = source.rows[0]!.raw as { aliasA: unknown; aliasB: unknown };
  assert.equal(copiedRaw.aliasA, copiedRaw.aliasB, 'unknown raw aliases should remain aliases');
  assert.notEqual(copiedRaw.aliasA, sourceRaw.aliasA, 'unknown raw aliases should be deeply isolated');
  assert.equal((copy.rows[1]!.raw as unknown[])[1], copy.rows[1]!.raw);
  assert.notEqual((copy.rows[0] as ExtendedParamRow).futureRow, (source.rows[0] as ExtendedParamRow).futureRow);

  // The repeated long description is a known scalar field.  It must not be
  // present in any serializer wrapper, while remaining complete in the copy.
  const description = source.rows[0]!.fields![0]!.description!;
  assert.equal(copy.rows[0]!.fields![0]!.description, description);
  assert.equal(
    inputs.some((input) => Object.values(input as Record<string, unknown>).includes(description)),
    false,
    'known field descriptions should bypass structuredClone'
  );

  copy.rows[0]!.fields![0]!.value = 999;
  (copy.rows[0]!.raw as { nested: { keep: boolean } }).nested.keep = false;
  copy.futureMetadata.nested.label = 'changed';
  copy.futureMetadata.nested.bytes[0] = 9;
  (copy.rows[0] as ExtendedParamRow).futureRow.nested.count = 99;
  (copy.rows[0]!.fields![0] as ExtendedParamField).futureField.nested.keep = false;
  assert.equal(source.rows[0]!.fields![0]!.value, 100);
  assert.equal((source.rows[0]!.raw as { nested: { keep: boolean } }).nested.keep, true);
  assert.equal(source.futureMetadata.nested.label, 'preserve-me');
  assert.equal(source.futureMetadata.nested.bytes[0], 1);
  assert.equal((source.rows[0] as ExtendedParamRow).futureRow.nested.count, 1);
  assert.equal((source.rows[0]!.fields![0] as ExtendedParamField).futureField.nested.keep, true);
}

function testWorkspaceRefreshIntegration(): void {
  const source = makeParamExport();
  const index = new WorkspaceIndex('param-clone-smoke');
  assert.equal(index.upsertParamExport(source), true);
  const clone = index.cloneForRefresh();
  const copied = clone.toSymbolBundle().params?.[0] as ExtendedParamExport | undefined;
  assert.ok(copied);
  assert.deepEqual(copied, source);
  assert.notEqual(copied.rows, source.rows);
  assert.notEqual(copied.rows[0], source.rows[0]);
  copied.rows[0]!.rowName = 'changed-in-refresh';
  assert.equal(source.rows[0]!.rowName, 'one');
}

function makeRepeatedDescriptionExport(rowCount: number): ParamExport {
  const description = 'repeated-long-description-'.repeat(128);
  return {
    paramName: 'NpcParam',
    sourceUri: 'file:///param/benchmark.param',
    rows: Array.from({ length: rowCount }, (_, rowIndex) => ({
      uri: `file:///param/benchmark.param#NpcParam/${rowIndex}`,
      sourceUri: 'file:///param/benchmark.param',
      paramName: 'NpcParam',
      rowId: rowIndex,
      fields: [
        { fieldId: 'description', name: 'Description', type: 'string', description, value: description }
      ],
      raw: { rowIndex }
    }))
  };
}

function measureClone(label: string, operation: () => unknown): { label: string; ms: number; heapDelta: number } {
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  operation();
  return { label, ms: performance.now() - start, heapDelta: process.memoryUsage().heapUsed - before };
}

function reportLightweightComparison(): void {
  // This is deliberately a modest, bounded comparison. It reports observations
  // only; no machine-specific timing/heap threshold is promoted to a PASS gate.
  const sample = makeRepeatedDescriptionExport(96);
  const dto = measureClone('dto', () => cloneParamExports([sample]));
  const whole = measureClone('structuredClone-whole-export', () => structuredClone([sample]));
  console.log(`param export clone comparison: ${JSON.stringify({ rows: sample.rows.length, dto, whole })}`);
}

testCloneGranularity();
testWorkspaceRefreshIntegration();
reportLightweightComparison();
console.log('param export clone smoke: PASS');

// Production PARAM decoding/index/merge and the complete read tool module.
// Native/FS ports below are in-memory fixtures: no Bridge, DB, model or game IO.
// Postcommit wiring to referenceFieldsOnly is covered by semantic-refresh-service.fixture.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { parseParamFieldRefs } from '../packages/shared/dist/index.js';
import { decodeNativeParamRows } from '../packages/core/dist/indexing/nativeSemanticRefresh.js';
import { WorkspaceIndex } from '../packages/core/dist/indexing/workspaceIndex.js';
import { buildRagCorpus } from '../packages/core/dist/rag/chunkBuilder.js';
import { decodeRowFields } from '../packages/core/dist/param/paramdefLayout.js';
import * as readWindow from '../packages/core/dist/param/paramReadWindow.js';
import * as toolSupport from '../packages/core/dist/ai/toolRegistrySupport.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fixtureRoot = resolve('/owned-param-fixture');
const sourceUri = 'file://param/gameparam.parambnd.dcx';
const definition = { schemaVersion: 1, typeName: 'PROJECTION_FIXTURE', version: 1, rowDataSize: 8, origin: 'fixture', fields: [
  { id: 'target', name: 'Target', type: 's32', offset: 0, size: 4, refs: 'TargetParam' },
  { id: 'power', name: 'Power', type: 's32', offset: 4, size: 4 }
] };

function loadProductionModule(relativePath, ports) {
  const path = resolve(ROOT, relativePath);
  const built = ts.transpileModule(readFileSync(path, 'utf8'), { fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  // Execute the whole unchanged module with explicit, bounded fixture ports.
  Function('require', 'exports', built.outputText)(name => {
    if (Object.hasOwn(ports, name)) return ports[name];
    if (['node:path', 'node:url', 'node:crypto'].includes(name)) return require(name);
    throw new Error('Unexpected production module import: ' + name);
  }, exports);
  return exports;
}

function makeFile(changed = false) {
  return { id: 'fixture', workspaceId: 'projection-fixture', sourceUri, sourcePath: 'param/gameparam.parambnd.dcx', absolutePath: join(fixtureRoot, 'param', 'gameparam.parambnd.dcx'), relativePath: 'param/gameparam.parambnd.dcx', extension: '.dcx', compoundExtension: '.parambnd.dcx', game: 'sekiro', resourceKind: 'param', parseStatus: 'parsed', diagnostics: [], formatKind: 'param', formatLabel: 'PARAM', size: 16, mtimeMs: changed ? 2 : 1, sha256: changed ? 'outer-new' : 'outer-old' };
}

function nativeRows(changed = false, count = 2) {
  return [100, 101].slice(0, count).map((id, rowIndex) => {
    const bytes = Buffer.alloc(8);
    bytes.writeInt32LE(id === 100 && changed ? 8 : 7, 0);
    bytes.writeInt32LE(1234, 4);
    return { id, rowIndex, dataHash: `row-${id}-${id === 100 && changed ? 'new' : 'old'}`, dataBase64: bytes.toString('base64') };
  });
}

async function projection(referenceFieldsOnly, changed = false, count = 2) {
  const file = makeFile(changed);
  const rows = await decodeNativeParamRows({ file, sourceHash: changed ? 'child-new' : 'child-old', outerFileHash: file.sha256, tableName: 'FixtureParam', entryName: 'FixtureParam.param', entryIndex: 0, typeName: definition.typeName, definition, rows: nativeRows(changed, count), ...(referenceFieldsOnly ? { referenceFieldsOnly: true } : {}) });
  const index = new WorkspaceIndex(file.workspaceId);
  index.setFiles([file]);
  assert.equal(index.upsertParamExport({ paramName: 'FixtureParam', sourceUri, entryName: 'FixtureParam.param', entryIndex: 0, sourceHash: changed ? 'child-new' : 'child-old', outerFileHash: file.sha256, sourceRevision: file.mtimeMs, rows }), true);
  return { index, file, chunks: chunksFor(index) };
}

function chunksFor(index) {
  return buildRagCorpus(index, '2026-10-04T00:00:00.000Z', [], undefined, undefined, { lookupIndex: 'deferred' }).chunks.filter((chunk) => chunk.family === 'param_row');
}

function readContext(index, onSemanticEvidenceUpdated) {
  const session = { meta: { workspaceId: index.workspaceId, game: 'sekiro' }, layers: { overlayRoot: fixtureRoot } };
  return { workspaceIndex: index, session, editSession: { session }, onSemanticEvidenceUpdated };
}

function createReadTool(result) {
  const tool = loadProductionModule('packages/core/src/ai/tools/read_param_fields.ts', {
    '../toolRegistrySupport.js': toolSupport,
    '../../param/containerParamEdit.js': { readParamFields: async input => {
      assert.deepEqual(input.queries[0].fieldIds, ['power']);
      return result;
    } },
    '@soulforge/shared': { parseParamFieldRefs }
  });
  return tool.createReadParamFieldsTool();
}

async function readIntoProjection(table, options = {}) {
  const value = await projection(true, true, options.count ?? 2);
  const field = { table: 'FixtureParam', rowId: 100, rowIndex: 0, dataHash: 'row-100-new', entryName: 'FixtureParam.param', entryIndex: 0, fieldId: 'power', displayName: 'Power', value: 1234, sourceHash: options.sourceHash ?? 'child-new', sourceRevision: options.revision ?? 2 };
  if (options.catalogHash) value.index.setFiles([{ ...value.file, sha256: options.catalogHash }]);
  const bundleBefore = JSON.stringify(value.index.toSymbolBundle());
  const epochBefore = value.index.getNativeVersionEpoch();
  let updates = 0;
  const result = await createReadTool({ ok: true, containerPath: value.file.absolutePath, fields: [field] }).run(
    { table, rowIds: [100], fieldIds: ['power'] },
    readContext(value.index, async sources => { assert.deepEqual(sources, [sourceUri]); updates++; })
  );
  return { ...value, result, after: chunksFor(value.index), updates, bundleBefore, epochBefore };
}

test('reference-only projection preserves untouched canonical body/hash while refreshing the target reference value', async () => {
  const initial = await projection(true);
  const post = await projection(true, true);
  assert.equal(initial.chunks[1].chunkId, post.chunks[1].chunkId);
  assert.equal(post.chunks[1].body, initial.chunks[1].body, 'untouched row 101 must not acquire unrelated fields');
  assert.equal(post.chunks[1].contentHash, initial.chunks[1].contentHash);
  assert.notEqual(post.chunks[0].body, initial.chunks[0].body);
  assert.ok(post.chunks[0].body.includes('target Target value=8'));
});

test('control: full-field projection reproduces 2 then 1 body changes while reference-only changes one row', async () => {
  const initial = await projection(true), full = await projection(false, true), rollback = await projection(false), consistent = await projection(true, true);
  const count = (a, b) => a.chunks.filter((chunk, i) => chunk.body !== b.chunks[i].body).length;
  assert.equal(count(initial, full), 2); assert.equal(count(full, rollback), 1); assert.equal(count(initial, consistent), 1);
});

test('read_param_fields single-field alias must publish native physical entry, retaining other rows', async () => {
  const value = await readIntoProjection('FixtureParam');
  assert.equal(value.result.ok, true); assert.equal(value.result.data.fields[0].value, 1234);
  assert.equal(value.updates, 1);
  assert.equal(value.after.length, 2);
  assert.ok(value.after[0].body.includes('power Power value=1234'));
  assert.ok(value.after[0].body.includes('target Target value=8'));
  assert.equal(value.after[1].body, value.chunks[1].body);
  assert.equal(value.index.toSymbolBundle().params[0].entryIndex, 0);
});

test('physical entry-name spelling remains valid', async () => {
  const value = await readIntoProjection('FixtureParam.param');
  assert.equal(value.updates, 1); assert.ok(value.after[0].body.includes('power Power value=1234'));
  assert.equal(value.after[1].body, value.chunks[1].body);
});

for (const [name, options] of [
  ['old revision', { revision: 1 }],
  ['conflicting child hash', { count: 1, sourceHash: 'conflicting-child' }],
  ['changed outer catalog hash', { catalogHash: 'different-outer' }]
]) test(`native projection guard remains closed for ${name}`, async () => {
  const value = await readIntoProjection('FixtureParam.param', options);
  assert.equal(value.result.ok, true, 'valid native read remains a successful read even when its projection is stale');
  assert.equal(value.updates, 0); assert.equal(value.after.some((chunk) => chunk.body.includes('power Power')), false);
  assert.equal(JSON.stringify(value.index.toSymbolBundle()), value.bundleBefore, 'rejected projection must leave every previous row intact');
  assert.equal(value.index.getNativeVersionEpoch(), value.epochBefore, 'rejected projection must not publish a new native epoch');
});

for (const [name, change] of [
  ['mixed incoming row revisions', (input) => { input.rows[0].sourceRevision = 1; }],
  ['top-level revision conflicts with current rows', (input) => { input.sourceRevision = 1; }],
  ['mixed incoming child hashes', (input) => { input.rows[0].sourceHash = 'other-child'; }],
  ['top-level outer hash conflicts with retained rows', (input) => { input.outerFileHash = 'different-outer'; }]
]) test(`merge refuses ${name} without dropping provenance or publishing partial rows`, async () => {
  const value = await projection(true, true);
  const current = value.index.toSymbolBundle().params[0];
  const before = JSON.stringify(value.index.toSymbolBundle()), epoch = value.index.getNativeVersionEpoch();
  const input = { paramName: current.paramName, sourceUri, entryName: current.entryName, entryIndex: current.entryIndex,
    rows: current.rows.map((row) => ({ ...row, fields: [...row.fields, { fieldId: 'power', name: 'Power', value: 1234 }] })) };
  change(input);
  assert.equal(value.index.mergeParamRows(input), false);
  assert.equal(JSON.stringify(value.index.toSymbolBundle()), before);
  assert.equal(value.index.getNativeVersionEpoch(), epoch);
});

test('unknown synthetic provenance remains compatible; no revision is invented', () => {
  const index = new WorkspaceIndex('synthetic-legacy');
  const sourceUri = 'file://param/legacy.param';
  assert.equal(index.mergeParamRows({ paramName: 'Legacy', sourceUri, rows: [{ uri: `${sourceUri}#1`, sourceUri, paramName: 'Legacy', rowId: 1, fields: [{ fieldId: 'power', value: 1 }] }] }), true);
  assert.equal(index.mergeParamRows({ paramName: 'Legacy', sourceUri, rows: [{ uri: `${sourceUri}#1`, sourceUri, paramName: 'Legacy', rowId: 1, fields: [{ fieldId: 'power', value: 2 }] }] }), true);
  const after = index.toSymbolBundle().params[0];
  assert.equal(after.sourceRevision, undefined); assert.equal(after.rows[0].sourceRevision, undefined);
  assert.equal(after.rows[0].fields[0].value, 2);
});

test('production PARAM facade decodes non-reference fields from controlled native document bytes', async () => {
  const row = nativeRows(true, 1)[0], entry = { index: 0, name: 'FixtureParam.param', contentHash: 'child-new' };
  const stagingRoot = join(fixtureRoot, '.stage'), calls = [];
  const refuse = () => { throw new Error('unexpected write or unbounded host operation'); };
  const facade = loadProductionModule('packages/core/src/param/containerParamEdit.ts', {
    'node:fs/promises': {
      stat: async () => ({ isFile: () => true, mtimeMs: 2 }),
      mkdir: async path => { assert.equal(path, stagingRoot); },
      mkdtemp: async prefix => { assert.equal(prefix, join(stagingRoot, 'param-read-')); return prefix + 'owned'; },
      rm: async path => { assert.equal(path, join(stagingRoot, 'param-read-owned')); calls.push('cleanup'); },
      readdir: refuse, readFile: refuse
    },
    '../ai/metadataPage.js': { metadataPage: refuse },
    './paramReadWindow.js': readWindow,
    '../bridge/runBridge.js': {
      runBridge: async input => { assert.equal(input.command, 'read-dcx-document'); calls.push('container'); return { parseStatus: 'parsed', data: { nested: { entries: [entry] } }, diagnostics: [] }; },
      createBridgeDaemonScope: () => ({
        run: async input => { assert.equal(input.command, 'extract-bnd4-child'); calls.push('extract'); return { parseStatus: 'parsed', data: { contentHash: 'child-new' }, diagnostics: [] }; },
        dispose: async () => { calls.push('dispose'); }
      })
    },
    '../editing/editorMutationService.js': { applyNativeMutation: refuse },
    '../editing/paramBridgeCommit.js': {
      commitParamMutationsViaBridge: refuse,
      readParamDocumentViaBridge: async input => {
        assert.deepEqual(input.rowIds, [100]); assert.equal(input.includeAllPayloads, undefined); calls.push('row');
        return { ok: true, data: { typeName: definition.typeName, dataVersion: 1, rowDataSize: 8, sourceHash: 'child-new', rows: [row] }, diagnostics: [] };
      }
    },
    '../editing/bridgeStaging.js': { stageBridgeOutput: refuse },
    './paramFieldMutation.js': { applyParamFieldMutation: refuse },
    './paramdefLayout.js': { decodeRowFields },
    './paramMetadata.js': { matchParamMetadataPackage: () => ({ ok: true, definition: { document: definition } }), resolveParamMetadataRowWidth: () => 8 },
    '../schema/sekiro/firstPartySchema.js': { loadFirstPartyParamMetadata: () => ({ ok: true, package: {} }) }
  });
  const value = await facade.readParamFields({
    edit: { session: { layers: { overlayRoot: fixtureRoot }, meta: { workspaceId: 'projection-fixture', game: 'sekiro' } }, stagingRoot, allowedRoots: () => [fixtureRoot] },
    containerPath: join(fixtureRoot, 'param', 'gameparam.parambnd.dcx'),
    queries: [{ table: 'FixtureParam', rowIds: [100], fieldIds: ['power'] }]
  });
  assert.equal(value.ok, true); assert.equal(value.fields[0].value, 1234); assert.equal(value.fields[0].rowIndex, 0);
  assert.equal(value.fields[0].sourceHash, 'child-new'); assert.equal(value.fields[0].dataHash, 'row-100-new'); assert.equal(value.evidence.complete, true);
  assert.deepEqual(calls, ['container', 'extract', 'row', 'dispose', 'cleanup']);
});

async function duplicateProjection(mode = 'raw') {
  const file = makeFile(true);
  const raw = [0, 1].map(rowIndex => {
    const bytes = Buffer.alloc(8); bytes.writeInt32LE(7 + rowIndex, 0); bytes.writeInt32LE(10 + rowIndex, 4);
    return { id: 100, rowIndex, dataHash: `duplicate-${rowIndex}`, dataBase64: bytes.toString('base64') };
  });
  const rows = await decodeNativeParamRows({ file, sourceHash: 'child-new', outerFileHash: file.sha256, tableName: 'FixtureParam', entryName: 'FixtureParam.param', entryIndex: 0, typeName: definition.typeName, definition, rows: raw, referenceFieldsOnly: true });
  if (mode === 'top') for (const row of rows) { row.rowIndex = row.raw.rowIndex; delete row.raw.rowIndex; }
  const index = new WorkspaceIndex(file.workspaceId); index.setFiles([file]);
  assert.equal(index.upsertParamExport({ paramName: 'FixtureParam', sourceUri, entryName: 'FixtureParam.param', entryIndex: 0, sourceHash: 'child-new', outerFileHash: file.sha256, sourceRevision: 2, rows }), true);
  return { index, file, rows };
}
function rowBySlot(index, slot) {
  return index.toSymbolBundle().params[0].rows.find(row => (row.rowIndex ?? row.raw?.rowIndex) === slot);
}
function duplicateInput(rows) {
  return { paramName: 'FixtureParam', sourceUri, entryName: 'FixtureParam.param', entryIndex: 0, sourceHash: 'child-new', outerFileHash: 'outer-new', sourceRevision: 2, rows };
}

test('native duplicate IDs retain both canonical physical slots and independent returned field values', async () => {
  const value = await duplicateProjection(); let updates = 0;
  const fields = [0, 1].map(rowIndex => ({ table: 'FixtureParam', entryName: 'FixtureParam.param', entryIndex: 0, rowId: 100, rowIndex, dataHash: `duplicate-${rowIndex}`, fieldId: 'power', displayName: 'Power', value: 10 + rowIndex, sourceHash: 'child-new', sourceRevision: 2 }));
  const result = await createReadTool({ ok: true, containerPath: value.file.absolutePath, fields }).run({ table: 'FixtureParam', rowIds: [100], fieldIds: ['power'] }, readContext(value.index, async () => { updates++; }));
  assert.equal(result.ok, true); assert.deepEqual(result.data.fields.map(field => field.rowIndex), [0, 1]);
  assert.equal(updates, 1); assert.equal(value.index.toSymbolBundle().params[0].rows.length, 2);
  for (const slot of [0, 1]) {
    const row = rowBySlot(value.index, slot); assert.ok(row);
    assert.equal(row.fields.find(field => field.fieldId === 'target').value, 7 + slot);
    assert.equal(row.fields.find(field => field.fieldId === 'power').value, 10 + slot);
  }
  const chunks = chunksFor(value.index); assert.equal(chunks.length, 2); assert.notEqual(chunks[0].chunkId, chunks[1].chunkId);
});

for (const [existingMode, incomingMode] of [['raw', 'top'], ['top', 'raw'], ['raw', 'both']]) {
  test(`same physical slot merges once across ${existingMode} to ${incomingMode} rowIndex representation`, async () => {
    const value = await duplicateProjection(existingMode), source = value.rows[0];
    const incoming = { ...source, uri: `${sourceUri}#FixtureParam/100@0`, fields: [{ fieldId: 'power', name: 'Power', value: 42 }] };
    incoming.raw = { ...source.raw }; delete incoming.raw.rowIndex; delete incoming.rowIndex;
    if (incomingMode !== 'raw') incoming.rowIndex = 0;
    if (incomingMode !== 'top') incoming.raw.rowIndex = 0;
    assert.equal(value.index.mergeParamRows(duplicateInput([incoming])), true);
    assert.equal(value.index.toSymbolBundle().params[0].rows.length, 2);
    assert.equal(rowBySlot(value.index, 0).fields.find(field => field.fieldId === 'power').value, 42);
    assert.equal(rowBySlot(value.index, 0).fields.find(field => field.fieldId === 'target').value, 7);
    assert.equal(rowBySlot(value.index, 1).fields.find(field => field.fieldId === 'target').value, 8);
    assert.equal(rowBySlot(value.index, 1).fields.some(field => field.fieldId === 'power'), false);
    assert.equal(value.index.mergeParamRows(duplicateInput([incoming])), false, 'same physical observation is an idempotent no-op');
  });
}

test('duplicate observations of the same physical slot merge only that slot', async () => {
  const value = await duplicateProjection();
  const first = { ...value.rows[0], rowIndex: 0, fields: [{ fieldId: 'power', name: 'Power', value: 42 }] };
  const second = { ...value.rows[0], fields: [{ fieldId: 'extra', name: 'Extra', value: 9 }] };
  assert.equal(value.index.mergeParamRows(duplicateInput([first, second])), true);
  assert.equal(value.index.toSymbolBundle().params[0].rows.length, 2);
  assert.deepEqual(rowBySlot(value.index, 0).fields.map(field => [field.fieldId, field.value]), [['target', 7], ['power', 42], ['extra', 9]]);
  assert.deepEqual(rowBySlot(value.index, 1).fields.map(field => [field.fieldId, field.value]), [['target', 8]]);
});

test('different logical row IDs may independently use known and legacy unknown identity', async () => {
  const value = await duplicateProjection();
  const legacy = { ...value.rows[0], rowId: 101, uri: `${sourceUri}#FixtureParam/101`, raw: { ...value.rows[0].raw } };
  delete legacy.rowIndex; delete legacy.raw.rowIndex;
  assert.equal(value.index.mergeParamRows(duplicateInput([legacy])), true);
  assert.equal(value.index.toSymbolBundle().params[0].rows.length, 3);
  assert.equal(rowBySlot(value.index, 0).rowId, 100); assert.equal(rowBySlot(value.index, 1).rowId, 100);
  const unknown = value.index.toSymbolBundle().params[0].rows.find(row => row.rowId === 101);
  assert.equal(unknown.rowIndex, undefined); assert.equal(unknown.raw.rowIndex, undefined);
});

for (const mode of ['unknown incoming over known slots', 'known incoming over legacy unknown', 'mixed known and unknown incoming', 'conflicting top and raw incoming', 'conflicting top and raw existing']) {
  test(`physical identity guard refuses ${mode} without an overwrite or invented third row`, async () => {
    const value = await duplicateProjection();
    let incoming = { ...value.rows[0], fields: [{ fieldId: 'power', name: 'Power', value: 99 }], raw: { ...value.rows[0].raw } };
    let rows = [incoming];
    if (mode === 'unknown incoming over known slots') { delete incoming.rowIndex; delete incoming.raw.rowIndex; }
    if (mode === 'known incoming over legacy unknown') {
      const legacy = { ...value.rows[0], raw: { ...value.rows[0].raw } }; delete legacy.rowIndex; delete legacy.raw.rowIndex;
      assert.equal(value.index.upsertParamExport(duplicateInput([legacy])), true);
      incoming.rowIndex = 0;
    }
    if (mode === 'mixed known and unknown incoming') {
      value.index.invalidateChangedSources([sourceUri]);
      const unknown = { ...incoming, raw: { ...incoming.raw } }; delete unknown.rowIndex; delete unknown.raw.rowIndex;
      rows = [incoming, unknown];
    }
    if (mode === 'conflicting top and raw incoming') incoming.rowIndex = 1;
    if (mode === 'conflicting top and raw existing') {
      assert.equal(value.index.upsertParamExport(duplicateInput([{ ...value.rows[0], rowIndex: 1 }, value.rows[1]])), true);
    }
    const before = JSON.stringify(value.index.toSymbolBundle()), epoch = value.index.getNativeVersionEpoch();
    assert.equal(value.index.mergeParamRows(duplicateInput(rows)), false);
    assert.equal(JSON.stringify(value.index.toSymbolBundle()), before); assert.equal(value.index.getNativeVersionEpoch(), epoch);
  });
}

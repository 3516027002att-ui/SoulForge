import assert from 'node:assert/strict';
import type { EmevdEditorDocument, IndexedFile } from '@soulforge/shared';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import { documentToNativeEventExport, enrichReferenceContent, type NativeScriptListReader, type NativeScriptReader } from '../references/nativeReferenceContent.js';

const registry = createSekiroFixtureEmedf();
function file(kind: 'event' | 'script'): IndexedFile {
  const path = kind === 'event' ? 'event/test.emevd.dcx' : 'script/test.luabnd.dcx';
  return { id: kind, workspaceId: 'optimization', sourceUri: `file://${path}`, sourcePath: path,
    absolutePath: `D:/fixture/${path}`, relativePath: path, game: 'sekiro', resourceKind: kind,
    parseStatus: 'unparsed', formatKind: kind === 'event' ? 'emevd' : 'lua', formatLabel: kind,
    extension: '.dcx', compoundExtension: '.dcx', size: 10, mtimeMs: 10, sha256: `hash-${kind}`, diagnostics: [] };
}
const eventFile = file('event');
const scriptFile = file('script');
const doc: EmevdEditorDocument = { schemaVersion: 1, resourceUri: eventFile.sourceUri, revision: 0,
  bytesBase64: '', diagnostics: [], events: [{ eventUri: `${eventFile.sourceUri}#event/1`, eventId: 1,
    restBehavior: 0, layer: -1, instructions: [{ instructionUri: 'instruction://0', bank: 9999, id: 9999,
      argsBase64: '', unknown: true }] }] };
const index = new WorkspaceIndex('optimization');
index.setFiles([eventFile]);
index.upsertEventExport(documentToNativeEventExport({ sourceUri: eventFile.sourceUri, outerFileHash: eventFile.sha256!,
  sourceRevision: eventFile.mtimeMs, document: doc, registry }));
let nativeEventReads = 0;
await enrichReferenceContent({ index, registry, eventReader: async () => {
  nativeEventReads += 1;
  return { ok: true, document: doc, outerFileHash: eventFile.sha256!, diagnostics: [], pageCount: 1, instructionTotal: 1 };
} });
assert.equal(nativeEventReads, 0, 'complete raw native content must not be reread for zero-argument or unknown instructions');
const unknown = index.getEvent(`${eventFile.sourceUri}#event/1`)!.instructions[0]!;
assert.deepEqual(unknown.args, [], 'unknown instructions must remain undecoded');
assert.ok((unknown.raw as { decodeStatus?: unknown }).decodeStatus, 'unknown decode status remains visible');

const order: string[] = [];
const names = ['a.lua', 'z-target.lua'];
const listReader: NativeScriptListReader = async () => ({ ok: true, containerPath: scriptFile.absolutePath,
  sourceUri: scriptFile.sourceUri, outerFileHash: scriptFile.sha256!, sourceRevision: scriptFile.mtimeMs,
  catalogComplete: true, entryCount: names.length, scriptCount: names.length,
  scripts: names.map(name => ({ name, sanitizedName: name, size: 20, isBytecode: false,
    contentKind: 'source', contentHash: `child-${name}` })), diagnostics: [] });
const reader: NativeScriptReader = async ({ childPath }) => {
  order.push(childPath);
  return { ok: true, containerPath: scriptFile.absolutePath, script: { sanitizedName: childPath,
    size: 20, uncompressedSize: 20, contentHash: `child-${childPath}`, sourceHash: `child-${childPath}`,
    outerFileHash: scriptFile.sha256!, isBytecode: false, magic: 'lua', variant: 'plain', isPlainText: true,
    embeddedSymbols: [], sourceText: 'Call(4400)', status: 'native-read' }, diagnostics: [] };
};
const workspace = new WorkspaceIndex('optimization');
workspace.setFiles([eventFile, scriptFile]);
const options = { index: workspace, registry, targetUri: `${scriptFile.sourceUri}!/z-target.lua`, maxSources: 1,
  maxScripts: 1, edit: { stagingRoot: 'D:/fixture/staging', allowedRoots: () => [] },
  scriptListReader: listReader, scriptReader: reader,
  eventReader: async () => { order.push('event'); return { ok: true as const, document: doc,
    outerFileHash: eventFile.sha256!, diagnostics: [], pageCount: 1, instructionTotal: 1 }; } };
const first = await enrichReferenceContent(options);
assert.equal(order[0], 'z-target.lua', 'the requested script and child must be read before unrelated event sources');
assert.equal(first.remaining.scriptChildren, 1);
const second = await enrichReferenceContent({ ...options, cursor: first.nextCursor! });
assert.equal(second.complete, true);
assert.equal(order.filter(x => x === 'z-target.lua').length, 1);
assert.equal(order.filter(x => x === 'a.lua').length, 1, 'continuation must not skip a reordered child');
const before = order.length;
await enrichReferenceContent({ ...options, maxScripts: 4 });
assert.equal(order.length, before, 'fresh queries reuse source/hash-verified script bodies and event bytes');

const catalogOnlyFile = { ...scriptFile, id: 'catalog-only', sourceUri: 'file://script/z-other.luabnd.dcx',
  relativePath: 'script/z-other.luabnd.dcx', absolutePath: 'D:/fixture/script/z-other.luabnd.dcx' };
const catalogIndex = new WorkspaceIndex('catalog-persistence');
catalogIndex.setFiles([scriptFile, catalogOnlyFile]);
const catalogResult = await enrichReferenceContent({ ...options, index: catalogIndex, maxSources: 2, maxScripts: 1 });
assert.ok(catalogResult.updatedSourceUris.includes(catalogOnlyFile.sourceUri),
  'a newly read native catalog must be persisted even when no child body fits in this invocation');
assert.equal(catalogResult.complete, false, 'catalog persistence is not full source coverage');
console.log('reference enrichment optimization smoke passed');

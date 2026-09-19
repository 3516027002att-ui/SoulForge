import assert from 'node:assert/strict';
import type { EmevdEditorDocument } from '@soulforge/shared';
import { createSekiroFixtureEmedf, type EmedfRegistry } from '../emevd/emedfSchema.js';
import {
  documentToNativeEventExport,
  enrichReferenceContent,
  type ScriptLiteralTargetIndexes
} from '../references/nativeReferenceContent.js';
import { buildScriptReferenceEdges } from '../references/scriptReferenceProvider.js';
import { buildEventReferenceEdges } from '../references/eventReferenceProvider.js';

function fixtureRegistry(): EmedfRegistry {
  return {
    ...createSekiroFixtureEmedf(),
    instructions: [
      ...createSekiroFixtureEmedf().instructions,
      {
        bank: 2000,
        id: 6,
        name: 'InitializeEvent',
        args: [
          { name: 'slotNumber', type: 's32' },
          { name: 'eventId', type: 's32' },
          { name: 'arg', type: 's32' }
        ]
      }
    ]
  };
}

function argsBase64(...values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeInt32LE(value, index * 4));
  return bytes.toString('base64');
}

function eventDocument(): EmevdEditorDocument {
  return {
    schemaVersion: 1,
    resourceUri: 'file://event/native.emevd.dcx',
    revision: 0,
    bytesBase64: '',
    diagnostics: [],
    events: [
      {
        eventUri: 'file://event/native.emevd.dcx#event/100',
        eventId: 100,
        restBehavior: 0,
        layer: -1,
        parameters: [{ instructionIndex: 0, targetStartByte: 4, sourceStartByte: 0, byteCount: 4, unkId: 0 }],
        instructions: [
          { instructionUri: 'file://event/native.emevd.dcx#event/100/instr/0', bank: 2000, id: 6, argsBase64: argsBase64(0, 0, 0), unknown: false },
          { instructionUri: 'file://event/native.emevd.dcx#event/100/instr/1', bank: 2000, id: 6, argsBase64: argsBase64(0, 200, 0), unknown: false }
        ]
      },
      {
        eventUri: 'file://event/native.emevd.dcx#event/200',
        eventId: 200,
        restBehavior: 0,
        layer: -1,
        instructions: []
      }
    ]
  };
}

function indexedFile(sourceUri: string, resourceKind: 'event' | 'script', sha256: string) {
  return {
    id: `${resourceKind}-file`,
    workspaceId: 'native-reference-content-smoke',
    sourceUri,
    sourcePath: sourceUri,
    absolutePath: `D:/fixture/${resourceKind}.native`,
    relativePath: `${resourceKind}/${resourceKind}.native`,
    game: 'sekiro',
    resourceKind,
    parseStatus: 'unparsed' as const,
    formatKind: resourceKind === 'event' ? 'emevd' as const : 'lua' as const,
    formatLabel: resourceKind,
    extension: resourceKind === 'event' ? '.emevd.dcx' : '.luabnd.dcx',
    compoundExtension: resourceKind === 'event' ? '.emevd.dcx' : '.luabnd.dcx',
    size: 10,
    mtimeMs: 10,
    sha256,
    diagnostics: []
  };
}

function checkUnknownLiteralMatches(): void {
  const targets: ScriptLiteralTargetIndexes = {
    numeric: new Map([[123, [{ uri: 'param://NpcParam/123', label: 'NpcParam#123' }]]]),
    strings: new Map([['boss name', [{ uri: 'msg://default/77', label: 'Boss Name' }]]])
  };
  const result = buildScriptReferenceEdges([{
    sourceUri: 'file://script/ai.luabnd.dcx',
    outerFileHash: 'outer-script',
    catalogComplete: true,
    containerKind: 'luabnd',
    scripts: [{
      uri: 'file://script/ai.luabnd.dcx!/ai.lua',
      sourceUri: 'file://script/ai.luabnd.dcx',
      childChain: ['ai.lua'],
      entryName: 'ai.lua',
      contentKind: 'source',
      sourceText: '-- UnknownCall(456)\nUnknownCall(123)\nUnknownCall("Boss Name")\n',
      sourceHash: 'child-script'
    }]
  }], { literalTargets: targets });
  assert.equal(result.edges.filter((edge) => edge.kind === 'numeric_match').length, 1);
  assert.equal(result.edges.filter((edge) => edge.kind === 'name_match').length, 1);
  const matches = result.edges.filter((edge) => edge.kind === 'numeric_match' || edge.kind === 'name_match');
  assert.ok(matches.every((edge) => edge.confidence === 'low'));
  assert.ok(matches.some((edge) => edge.evidence[0]?.excerpt?.includes('@L2:C1')));
  assert.ok(matches.some((edge) => edge.evidence[0]?.excerpt?.includes('UnknownCall("Boss Name")')));
}

async function main(): Promise<void> {
  const crowded = new Proxy([] as Array<{ uri: string }>, { get(target, key, receiver) {
    if (key === 'length') return 100_000;
    if (key === Symbol.iterator) throw new Error('ambiguous fan-out must be rejected before enumeration');
    return Reflect.get(target, key, receiver);
  } });
  const crowdedIndexes = { mapEntitiesByEntityId: new Map([[0, crowded]]), paramRowsById: new Map(), paramRowsByScopedId: new Map(), textsById: new Map() };
  const crowdedEvents: import('@soulforge/shared').EventExport[] = [{ events: [{ uri: 'file://event/test#event/1', sourceUri: 'file://event/test', eventId: 1, instructions: [
    { uri: 'instruction://0', index: 0, name: 'Neutral', args: [{ name: 'value', value: 0 }] },
    { uri: 'instruction://1', index: 1, name: 'Neutral', args: [{ name: 'entityId', value: 0 }] }
  ] }] }];
  assert.equal(buildEventReferenceEdges(crowdedEvents, crowdedIndexes).edges.length, 0);
  assert.equal(buildEventReferenceEdges(crowdedEvents, crowdedIndexes, { includeHypotheses: true }).edges.length, 0);
  const explicitCrowded = structuredClone(crowdedEvents);
  explicitCrowded[0]!.events[0]!.instructions[1]!.args[0] = { name: 'entityId', value: 0, role: 'entityId', roleSource: 'registry' };
  const explicitLimited = buildEventReferenceEdges(explicitCrowded, crowdedIndexes);
  assert.equal(explicitLimited.edges.length, 0);
  assert.ok(explicitLimited.diagnostics.some((diagnostic) => diagnostic.code === 'EMEVD_REFERENCE_TARGET_LIMIT'));
  const registry = fixtureRegistry();
  const exported = documentToNativeEventExport({
    sourceUri: 'file://event/native.emevd.dcx',
    sourceRevision: 10,
    outerFileHash: 'outer-event',
    sourceHash: 'payload-event',
    document: eventDocument(),
    registry
  });
  const bound = exported.events[0]!.instructions[0]!.args[1]!;
  assert.equal(bound.value, 'X0_4');
  assert.equal(exported.events[0]!.instructions[0]!.uri, 'file://event/native.emevd.dcx#event/100#instruction/0');
  assert.equal((exported.events[0]!.raw as { parameters: unknown[] }).parameters.length, 1);
  assert.ok(exported.events[0]!.instructions[1]!.args[1]!.value === 200);
  checkUnknownLiteralMatches();

  const index = (await import('../indexing/workspaceIndex.js')).WorkspaceIndex;
  const workspace = new index('native-reference-content-smoke');
  const result = await enrichReferenceContent({
    index: workspace,
    sourceFiles: [],
    maxSources: 1,
    cursor: { version: 1, eventOffset: 0, scriptOffset: 0, paramOffset: 0 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextCursor, undefined);

  const eventSource = indexedFile('file://event/native.emevd.dcx', 'event', 'outer-event');
  workspace.setFiles([eventSource]);
  const eventResult = await enrichReferenceContent({
    index: workspace,
    sourceFiles: [eventSource],
    maxSources: 1,
    registry,
    eventReader: async () => ({
      ok: true,
      document: eventDocument(),
      sourceHash: 'payload-event',
      outerFileHash: 'outer-event',
      diagnostics: [],
      pageCount: 1,
      instructionTotal: 2
    })
  });
  assert.equal(eventResult.complete, true);
  assert.ok(eventResult.updatedSourceUris.includes(eventSource.sourceUri));
  const indexedEvent = workspace.getEvent(`${eventSource.sourceUri}#event/100`)!;
  assert.equal(indexedEvent.instructions[0]!.args[1]!.value, 'X0_4');
  const eventGraph = workspace.rebuildReferences({ registry });
  assert.ok(eventGraph.edges.some((edge) => edge.toUri.endsWith('#event/200')
    && edge.evidence[0]?.excerpt?.includes('eventId=200')));

  const scriptSource = indexedFile('file://script/native.luabnd.dcx', 'script', 'outer-script');
  const scriptNames = ['one.lua', 'two.lua', 'three.lua', 'four.lua'];
  const listReader = async () => ({
    ok: true as const,
    containerPath: scriptSource.absolutePath,
    sourceUri: scriptSource.sourceUri,
    outerFileHash: scriptSource.sha256!,
    sourceRevision: scriptSource.mtimeMs,
    catalogComplete: true,
    entryCount: scriptNames.length,
    scriptCount: scriptNames.length,
    scripts: scriptNames.map((name) => ({ name, sanitizedName: name, size: 10, isBytecode: false, contentKind: 'source' as const, contentHash: `child-${name}` })),
    diagnostics: []
  });
  const readReader = async (input: { childPath: string }) => ({
    ok: true as const,
    containerPath: scriptSource.absolutePath,
    script: {
      sanitizedName: input.childPath,
      size: 10,
      uncompressedSize: 10,
      contentHash: `child-${input.childPath}`,
      outerFileHash: scriptSource.sha256,
      isBytecode: false,
      magic: 'lua',
      variant: 'plain',
      isPlainText: true,
      embeddedSymbols: [],
      sourceHash: `child-${input.childPath}`,
      sourceText: `-- UnknownCall(999)\nUnknownCall(123)\n`,
      status: 'native-read' as const
    },
    diagnostics: []
  });
  const firstScript = await enrichReferenceContent({
    index: workspace,
    sourceFiles: [scriptSource],
    maxSources: 1,
    maxScripts: 1,
    edit: { stagingRoot: 'D:/fixture/staging', allowedRoots: () => [] },
    scriptListReader: listReader,
    scriptReader: readReader
  });
  assert.equal(firstScript.complete, false);
  assert.ok(firstScript.nextCursor?.scriptChildOffsets);
  assert.ok(firstScript.remaining.scriptChildren >= 3);
  const secondScript = await enrichReferenceContent({
    index: workspace,
    sourceFiles: [scriptSource],
    maxSources: 1,
    maxScripts: 8,
    sourceCursor: firstScript.nextCursor,
    edit: { stagingRoot: 'D:/fixture/staging', allowedRoots: () => [] },
    scriptListReader: listReader,
    scriptReader: readReader
  });
  assert.equal(secondScript.complete, true);
  assert.equal(secondScript.remaining.scriptChildren, 0);
  const failedScript = await enrichReferenceContent({ index: workspace, sourceFiles: [scriptSource], maxScripts: 8,
    edit: { stagingRoot: 'D:/fixture/staging', allowedRoots: () => [] }, scriptListReader: listReader,
    scriptReader: async () => ({ ok: false, error: { code: 'READ_FAIL', message: 'read failed' }, diagnostics: [{ severity: 'warning', code: 'READ_FAIL', message: 'read failed' }] })
  });
  assert.equal(failedScript.complete, false);
  assert.equal(failedScript.failedSourceKeys.length, 4);
  const oversized = await enrichReferenceContent({ index: workspace, sourceFiles: [scriptSource], maxScripts: 8, maxBytes: 1,
    edit: { stagingRoot: 'D:/fixture/staging', allowedRoots: () => [] }, scriptListReader: listReader, scriptReader: readReader
  });
  assert.equal(oversized.complete, false);
  assert.equal(oversized.nextCursor, undefined, 'oversized children must not create a non-advancing continuation');
  assert.equal(oversized.failedSourceKeys.length, 4);
  const paramSource = { ...indexedFile('file://param/game.parambnd.dcx', 'event', 'outer-param'), resourceKind: 'param' as const };
  const paramIndex = new index('partial-param');
  paramIndex.setFiles([paramSource]);
  paramIndex.upsertParamExport({ sourceUri: paramSource.sourceUri, paramName: 'Example', outerFileHash: paramSource.sha256, sourceRevision: 10,
    rows: [{ uri: `${paramSource.sourceUri}#Example/1`, sourceUri: paramSource.sourceUri, paramName: 'Example', rowId: 1, fields: [] }] });
  const partialParam = await enrichReferenceContent({ index: paramIndex, sourceFiles: [paramSource],
    edit: { stagingRoot: 'D:/fixture/staging', allowedRoots: () => [] },
    paramRefresher: async () => ({ refreshedSources: [paramSource.sourceUri], partialSources: [paramSource.sourceUri], failedSources: [], staleSources: [], diagnostics: [] })
  });
  assert.equal(partialParam.complete, false);
  assert.equal(partialParam.failedSourceKeys.length, 1);
  console.log('native reference content smoke passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

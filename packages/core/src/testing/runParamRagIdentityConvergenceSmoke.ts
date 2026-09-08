import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IndexedFile, ParamDefDocument, ParamRowSymbol } from '@soulforge/shared';
import { decodeNativeParamRows } from '../indexing/nativeSemanticRefresh.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { buildRagCorpus } from '../rag/chunkBuilder.js';

const SOURCE_URI = 'file://param/gameparam.parambnd.dcx';
const OUTER_HASH = 'outer-hash';
const SOURCE_REVISION = 7;
const ENTRY_NAME = 'NpcParam.param';
const ENTRY_INDEX = 7;
const ROW_ID = 50_800_000;
const ROW_INDEX = 12;

const file: IndexedFile = {
  id: 'file:gameparam',
  workspaceId: 'param-rag-identity',
  sourceUri: SOURCE_URI,
  sourcePath: 'param/gameparam.parambnd.dcx',
  absolutePath: 'param/gameparam.parambnd.dcx',
  relativePath: 'param/gameparam.parambnd.dcx',
  extension: '.dcx',
  compoundExtension: '.parambnd.dcx',
  game: 'sekiro',
  resourceKind: 'param',
  parseStatus: 'parsed',
  diagnostics: [],
  formatKind: 'param',
  formatLabel: 'PARAM',
  size: 1,
  mtimeMs: SOURCE_REVISION,
  sha256: OUTER_HASH
};

function chunkFor(rows: readonly ParamRowSymbol[]) {
  const index = new WorkspaceIndex('param-rag-identity');
  index.setFiles([file]);
  assert.equal(index.upsertParamExport({
    paramName: rows[0]?.paramName ?? 'NpcParam',
    sourceUri: SOURCE_URI,
    entryName: ENTRY_NAME,
    entryIndex: ENTRY_INDEX,
    sourceHash: 'child-hash',
    outerFileHash: OUTER_HASH,
    sourceRevision: SOURCE_REVISION,
    rows: [...rows]
  }), true);
  return buildRagCorpus(index).chunks.filter((chunk) => chunk.family === 'param_row');
}

function physicalRow(overrides: Partial<ParamRowSymbol> = {}): ParamRowSymbol {
  return {
    uri: 'param://NpcParam/50800000',
    sourceUri: SOURCE_URI,
    paramName: 'NpcParam',
    entryName: ENTRY_NAME,
    entryIndex: ENTRY_INDEX,
    rowId: ROW_ID,
    sourceHash: 'child-hash',
    outerFileHash: OUTER_HASH,
    sourceRevision: SOURCE_REVISION,
    fields: [],
    raw: { typeName: 'NPC_PARAM_ST', dataHash: 'row-hash', rowIndex: ROW_INDEX },
    ...overrides
  };
}

async function main(): Promise<void> {
  // The first native projection and semantic refresh use different display
  // names/URIs, but describe one physical child row.
  const firstProjection = chunkFor([physicalRow({
    paramName: 'NPC_PARAM_ST',
    uri: 'param://NPC_PARAM_ST/50800000',
    raw: {
      parser: 'sekiro-param-native-v1',
      entryName: ENTRY_NAME,
      entryIndex: ENTRY_INDEX,
      rowIndex: ROW_INDEX,
      typeName: 'NPC_PARAM_ST',
      dataHash: 'row-hash'
    }
  })])[0];
  const refreshedProjection = chunkFor([physicalRow({
    uri: `${SOURCE_URI}#NpcParam/50800000`,
    raw: { typeName: 'NPC_PARAM_ST', dataHash: 'row-hash', rowIndex: ROW_INDEX }
  })])[0];
  assert.ok(firstProjection);
  assert.ok(refreshedProjection);
  assert.equal(
    firstProjection.chunkId,
    refreshedProjection.chunkId,
    'first C# projection and native semantic refresh must converge on one physical row chunk ID'
  );

  // Same numeric ID in two physical children must remain separate.
  const differentChildren = chunkFor([
    physicalRow({ entryName: 'NpcParam.param', entryIndex: 7, rowName: 'child-a' }),
    physicalRow({ entryName: 'EquipParam.param', entryIndex: 8, rowName: 'child-b' })
  ]);
  assert.equal(differentChildren.length, 2);
  assert.notEqual(differentChildren[0]?.chunkId, differentChildren[1]?.chunkId);

  // Older cached rows may carry child name/index but no rowIndex.  Keep the
  // previous partial-locator JSON identity so two children with the same
  // logical URI still cannot overwrite each other.
  const partialChildren = chunkFor([
    physicalRow({
      uri: 'param://NPC_PARAM_ST/50800000',
      entryName: 'NpcParam.param',
      entryIndex: 7,
      raw: { typeName: 'NPC_PARAM_ST', dataHash: 'partial-a' }
    }),
    physicalRow({
      uri: 'param://NPC_PARAM_ST/50800000',
      entryName: 'EquipParam.param',
      entryIndex: 8,
      raw: { typeName: 'NPC_PARAM_ST', dataHash: 'partial-b' }
    })
  ]);
  assert.equal(partialChildren.length, 2);
  assert.notEqual(partialChildren[0]?.chunkId, partialChildren[1]?.chunkId);
  const expectedPartialIds = new Set([
    ['NpcParam.param', 7],
    ['EquipParam.param', 8]
  ].map(([entryName, entryIndex]) => {
    const identity = JSON.stringify([
      SOURCE_URI,
      entryName,
      entryIndex,
      null,
      'param://NPC_PARAM_ST/50800000'
    ]);
    return `rag:param_row:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
  }));
  assert.deepEqual(
    new Set(partialChildren.map((chunk) => chunk.chunkId)),
    expectedPartialIds,
    'partial physical locator must retain the exact legacy five-slot JSON identity'
  );

  // Duplicate IDs inside one child must remain separate by complete-table rowIndex.
  const duplicateRows = chunkFor([
    physicalRow({ rowId: ROW_ID, raw: { rowIndex: 12, dataHash: 'row-a' } }),
    physicalRow({ rowId: ROW_ID, raw: { rowIndex: 13, dataHash: 'row-b' } })
  ]);
  assert.equal(duplicateRows.length, 2);
  assert.notEqual(duplicateRows[0]?.chunkId, duplicateRows[1]?.chunkId);

  // Legacy/synthetic rows with no physical locator retain the old key shape.
  const legacyUri = 'param://LegacyParam/1';
  const legacySource = physicalRow({
    uri: legacyUri,
    paramName: 'LegacyParam',
    raw: { typeName: 'LEGACY_PARAM_ST', dataHash: 'legacy' }
  });
  const {
    entryName: removedEntryName,
    entryIndex: removedEntryIndex,
    ...legacyRow
  } = legacySource;
  assert.equal(removedEntryName, ENTRY_NAME);
  assert.equal(removedEntryIndex, ENTRY_INDEX);
  const legacy = chunkFor([legacyRow])[0];
  assert.ok(legacy);
  const expectedLegacyId = createHash('sha256')
    .update(`${SOURCE_URI}\u0000${legacyUri}`)
    .digest('hex')
    .slice(0, 24);
  assert.equal(legacy.chunkId, `rag:param_row:${expectedLegacyId}`);

  // A paged native read must preserve Bridge's physical rowIndex rather than
  // replacing it with the local array position.
  const definition: ParamDefDocument = {
    schemaVersion: 1,
    typeName: 'NPC_PARAM_ST',
    version: 1,
    rowDataSize: 4,
    origin: 'fixture',
    fields: [{ id: 'id', name: 'id', type: 's32', offset: 0, size: 4 }]
  };
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(ROW_ID, 0);
  const decoded = await decodeNativeParamRows({
    file: { sourceUri: SOURCE_URI, sha256: OUTER_HASH, mtimeMs: SOURCE_REVISION },
    sourceHash: 'child-hash',
    outerFileHash: OUTER_HASH,
    tableName: 'NpcParam',
    entryName: ENTRY_NAME,
    entryIndex: ENTRY_INDEX,
    typeName: 'NPC_PARAM_ST',
    definition,
    rows: [{ rowIndex: 128, id: ROW_ID, dataBase64: bytes.toString('base64'), dataHash: 'row-hash' }]
  });
  assert.equal((decoded[0]?.raw as { rowIndex?: unknown } | undefined)?.rowIndex, 128);

  console.log(JSON.stringify({
    ok: true,
    checks: 7,
    convergence: firstProjection.chunkId,
    message: 'PARAM RAG physical identity convergence smoke passed'
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

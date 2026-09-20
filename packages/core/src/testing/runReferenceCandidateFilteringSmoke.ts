import assert from 'node:assert/strict';
import type { ParamExport, ScriptExport, SymbolBundle } from '@soulforge/shared';
import { createReferenceQueryService } from '../references/referenceQueryService.js';

const workspaceId = 'reference-candidate-filtering';
const scriptSource = `workspace://${workspaceId}/script/test.luabnd.dcx`;
const paramSource = `workspace://${workspaceId}/param/test.parambnd.dcx`;

const scriptBundle: SymbolBundle = {
  params: [{
    paramName: 'NpcParam', sourceUri: paramSource, entryIndex: 0, entryName: 'NpcParam.param',
    rows: [{
      uri: `${paramSource}#NpcParam/100`, sourceUri: paramSource, paramName: 'NpcParam',
      entryIndex: 0, rowId: 100, rowIndex: 0, rowName: 'numeric-target', fields: []
    }]
  }],
  scripts: [{
    sourceUri: scriptSource, containerKind: 'luabnd', catalogComplete: true,
    scripts: [
      {
        uri: `${scriptSource}!/main.lua`, sourceUri: scriptSource,
        childChain: ['main.lua'], entryIndex: 0, entryName: 'main.lua', contentKind: 'source',
        sourceText: 'UnknownCall(100)\nrequire "module"\n', sourceHash: 'main-hash'
      },
      {
        uri: `${scriptSource}!/module.lua`, sourceUri: scriptSource,
        childChain: ['module.lua'], entryIndex: 1, entryName: 'module.lua', contentKind: 'catalog-only'
      }
    ]
  } satisfies ScriptExport]
};

async function runCandidateFiltering(): Promise<void> {
  const service = createReferenceQueryService({ bundle: scriptBundle, workspaceId });
  const target = { domain: 'script' as const, sourceUri: scriptSource, childChain: ['main.lua'] };

  const defaultPage = await service.query({ target, direction: 'from', detail: 'edges' });
  assert.equal(defaultPage.relations.some((item) => item.relationKind === 'invokes_script'), true);
  assert.equal(defaultPage.relations.some((item) => item.relationKind === 'numeric_match' || item.relationKind === 'name_match'), false);

  const explicitFalse = await service.query({ target, direction: 'from', detail: 'edges', includeHypotheses: false });
  assert.equal(explicitFalse.relations.some((item) => item.relationKind === 'numeric_match' || item.relationKind === 'name_match'), false);
  assert.equal(explicitFalse.relations.some((item) => item.relationKind === 'invokes_script'), true);

  const explicitTrue = await service.query({ target, direction: 'from', detail: 'edges', includeHypotheses: true });
  assert.equal(explicitTrue.relations.some((item) => item.relationKind === 'numeric_match'), true);

  const capped = await createReferenceQueryService({ bundle: scriptBundle, workspaceId, maxTraversalEdges: 0 }).query({
    target, direction: 'from', detail: 'edges'
  });
  const cappedAction = capped.nextActions.find((action) => action.tool === 'find_references');
  assert.ok(cappedAction);
  assert.equal(Object.keys(cappedAction.args).length > 0, true);
  assert.match(cappedAction.reason, /重新执行|缩小查询/u);
}

async function runParamDiagnosticFiltering(): Promise<void> {
  const sourceUri = paramSource;
  const bundle: SymbolBundle = {
    params: [
      {
        paramName: 'Source', sourceUri, entryIndex: 0, entryName: 'Source.param',
        rows: [
          {
            uri: `${sourceUri}#Source/1`, sourceUri, paramName: 'Source', entryIndex: 0,
            rowId: 1, rowIndex: 0,
            fields: [{ fieldId: 'refId', name: 'refId', value: 3, refsProvenance: 'trusted-metadata', refs: [{ param: 'Target', condition: { fieldId: 'kind', value: 1 } }] }]
          },
          {
            uri: `${sourceUri}#Source/2`, sourceUri, paramName: 'Source', entryIndex: 0,
            rowId: 2, rowIndex: 1,
            fields: [{ fieldId: 'refId', name: 'refId', value: 3, refsProvenance: 'trusted-metadata', refs: [{ param: 'Target' }] }]
          }
        ]
      } satisfies ParamExport,
      {
        paramName: 'Target', sourceUri, entryIndex: 1, entryName: 'Target.param',
        rows: [{
          uri: `${sourceUri}#Target/3`, sourceUri, paramName: 'Target', entryIndex: 1,
          rowId: 3, rowIndex: 0, fields: []
        }]
      } satisfies ParamExport
    ]
  };
  const service = createReferenceQueryService({ bundle, workspaceId });
  const page = await service.query({
    target: { domain: 'param', sourceUri, entryIndex: 0, rowId: 2 },
    direction: 'from', detail: 'edges'
  });
  assert.equal(page.relations.some((item) => item.relationKind === 'references_param_row'), true);
  assert.equal(page.diagnostics.some((item) => item.code === 'PARAM_REF_CONDITION_UNRESOLVED'), false);
}

await runCandidateFiltering();
await runParamDiagnosticFiltering();
console.log(JSON.stringify({ ok: true, suite: 'reference-candidate-filtering' }));

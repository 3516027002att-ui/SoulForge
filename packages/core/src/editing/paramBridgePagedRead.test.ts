import assert from 'node:assert/strict';
import test from 'node:test';
import type { BridgeResult } from '@soulforge/shared';
import { readParamDocumentRowsPagedViaBridge } from './paramBridgePagedRead.js';
import type { RunBridgeOptions } from '../bridge/runBridge.js';

type TestBatchRow = { rowIndex: number };
type TestDiagnostic = { code: string };

const SOURCE_URI = 'file://param/gameparam/gameparam.parambnd.dcx#100/NpcParam.param';
const SOURCE_HASH = 'child-param-source-hash';
const WORKSPACE_SESSION_ID = 'workspace-session-current';
const PATH_SOURCE_GENERATION = 7;
const ROW_DATA_SIZE = 16;
const SESSION_TOKEN = 'param-document-session';

function bridgePartial<T>(data: T): BridgeResult<T> {
  return {
    sourceUri: SOURCE_URI,
    sourcePath: SOURCE_URI,
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'partial',
    diagnostics: [],
    data
  };
}

function rowIdentity(rowIndex: number) {
  return {
    rowIndex,
    id: 10_000 + rowIndex,
    dataHash: `row-hash-${rowIndex}`
  };
}

function createPagedBridge(options: { wrongPage?: boolean; wrongPayloadIdentity?: boolean } = {}) {
  const pageSize = 20;
  const rowCount = 45;
  const calls: RunBridgeOptions[] = [];
  const bridge = async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
    calls.push(request);
    const commandOptions = request.commandOptions ?? {};
    if (commandOptions.includeRowPayloads === false) {
      const page = Number(commandOptions.rowPage ?? 0);
      const start = page * pageSize;
      const count = Math.max(0, Math.min(pageSize, rowCount - start));
      const rows = Array.from({ length: count }, (_, offset) => ({
        ...rowIdentity(start + offset),
        name: `row-${start + offset}`,
        dataBase64: null
      }));
      return bridgePartial({
        typeName: 'ACTION_GUIDE_PARAM_ST',
        dataVersion: 1,
        sourceHash: SOURCE_HASH,
        rowCount,
        rowTotal: rowCount,
        rowDataSize: ROW_DATA_SIZE,
        rowPage: options.wrongPage && page === 0 ? 1 : page,
        rowPageSize: pageSize,
        rowPageCount: 3,
        returnedRowCount: rows.length,
        payloadsIncluded: false,
        sessionToken: SESSION_TOKEN,
        workspaceSessionId: WORKSPACE_SESSION_ID,
        pathSourceGeneration: PATH_SOURCE_GENERATION,
        rows
      }) as BridgeResult<T>;
    }

    const selections = commandOptions.rowSelections as Array<{
      rowIndex: number;
      expectedId: number;
      expectedDataHash: string;
    }>;
    const rows = selections.map((selection) => ({
      ...rowIdentity(selection.rowIndex),
      id: options.wrongPayloadIdentity ? selection.expectedId + 1 : selection.expectedId,
      dataHash: selection.expectedDataHash,
      name: `row-${selection.rowIndex}`,
      dataBase64: Buffer.alloc(ROW_DATA_SIZE, selection.rowIndex & 0xff).toString('base64')
    }));
    return bridgePartial({
      typeName: 'ACTION_GUIDE_PARAM_ST',
      dataVersion: 1,
      sourceHash: SOURCE_HASH,
      rowCount,
      rowDataSize: ROW_DATA_SIZE,
      payloadsIncluded: true,
      sessionToken: SESSION_TOKEN,
      workspaceSessionId: WORKSPACE_SESSION_ID,
      pathSourceGeneration: PATH_SOURCE_GENERATION,
      rows
    }) as BridgeResult<T>;
  };
  return { bridge, calls };
}

test('reads a complete PARAM by identity-bound index pages and bounded row-selection batches', async () => {
  const { bridge, calls } = createPagedBridge();
  const batches: number[][] = [];
  const result = await readParamDocumentRowsPagedViaBridge({
    sourcePath: 'C:\\workspace\\NpcParam.param',
    allowedRoots: ['C:\\workspace'],
    workspaceSessionId: WORKSPACE_SESSION_ID,
    pathSourceGeneration: PATH_SOURCE_GENERATION,
    entryIdentity: 'gameparam#100:NpcParam.param',
    expectedRowDataSize: ROW_DATA_SIZE,
    indexPageSize: 20,
    payloadBatchSize: 11
  }, async (_identity: unknown, rows: readonly TestBatchRow[]) => {
    batches.push(rows.map((row) => row.rowIndex));
  }, bridge);

  assert.equal(result.ok, true);
  assert.equal(result.data?.rowCount, 45);
  assert.equal(result.pagesRead, 3);
  assert.equal(result.payloadBatchesRead, 5);
  assert.deepEqual(batches.map((batch) => batch.length), [11, 9, 11, 9, 5]);
  assert.deepEqual(batches.flat(), Array.from({ length: 45 }, (_, rowIndex) => rowIndex));
  assert.equal(calls.some((request) => request.commandOptions?.includeAllPayloads === true), false,
    'paged refresh must never request a whole-table payload');
  assert.equal(calls.every((request) => request.workspaceSessionId === WORKSPACE_SESSION_ID), true);
  assert.equal(calls.every((request) => request.commandOptions?.pathSourceGeneration === PATH_SOURCE_GENERATION), true);
  assert.equal(calls.every((request) => request.commandOptions?.entryIdentity === 'gameparam#100:NpcParam.param'), true);
  assert.equal(calls.every((request) => request.commandOptions?.expectedRowDataSize === ROW_DATA_SIZE), true);
  assert.equal(calls.every((request) => request.commandOptions?.documentSession === SESSION_TOKEN
    || request.commandOptions?.includeRowPayloads === false), true);
});

test('rejects a Bridge-clamped page before reading payload rows', async () => {
  const { bridge } = createPagedBridge({ wrongPage: true });
  let deliveredBatches = 0;
  const result = await readParamDocumentRowsPagedViaBridge({
    sourcePath: 'C:\\workspace\\NpcParam.param',
    allowedRoots: ['C:\\workspace'],
    workspaceSessionId: WORKSPACE_SESSION_ID,
    pathSourceGeneration: PATH_SOURCE_GENERATION,
    entryIdentity: 'gameparam#100:NpcParam.param',
    expectedRowDataSize: ROW_DATA_SIZE,
    indexPageSize: 20
  }, () => { deliveredBatches += 1; }, bridge);

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((diagnostic: TestDiagnostic) => diagnostic.code), ['PARAM_PAGE_IDENTITY_MISMATCH']);
  assert.equal(deliveredBatches, 0);
});

test('rejects changed physical row identity without delivering that payload batch', async () => {
  const { bridge } = createPagedBridge({ wrongPayloadIdentity: true });
  let deliveredBatches = 0;
  const result = await readParamDocumentRowsPagedViaBridge({
    sourcePath: 'C:\\workspace\\NpcParam.param',
    allowedRoots: ['C:\\workspace'],
    workspaceSessionId: WORKSPACE_SESSION_ID,
    pathSourceGeneration: PATH_SOURCE_GENERATION,
    entryIdentity: 'gameparam#100:NpcParam.param',
    expectedRowDataSize: ROW_DATA_SIZE,
    indexPageSize: 20,
    payloadBatchSize: 45
  }, () => { deliveredBatches += 1; }, bridge);

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((diagnostic: TestDiagnostic) => diagnostic.code), ['PARAM_ROW_IDENTITY_MISMATCH']);
  assert.equal(deliveredBatches, 0);
});

test('uses header-only plus trusted metadata when Bridge cannot infer row width', async () => {
  const { bridge: pagedBridge, calls } = createPagedBridge();
  const requests: RunBridgeOptions[] = [];
  let widthResolutions = 0;
  const bridge = async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
    requests.push(request);
    const options = request.commandOptions ?? {};
    if (options.headerOnly === true) {
      return bridgePartial({
        sourceHash: SOURCE_HASH,
        typeName: 'ACTION_GUIDE_PARAM_ST',
        dataVersion: 1
      }) as unknown as BridgeResult<T>;
    }
    if (options.includeRowPayloads === false && options.expectedRowDataSize === undefined) {
      return {
        sourceUri: SOURCE_URI,
        sourcePath: SOURCE_URI,
        game: 'sekiro',
        resourceKind: 'param',
        parseStatus: 'failed',
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'fixture requires trusted row width' }]
      } as unknown as BridgeResult<T>;
    }
    return pagedBridge<T>(request);
  };

  const result = await readParamDocumentRowsPagedViaBridge({
    sourcePath: 'C:\\workspace\\NpcParam.param',
    allowedRoots: ['C:\\workspace'],
    workspaceSessionId: WORKSPACE_SESSION_ID,
    pathSourceGeneration: PATH_SOURCE_GENERATION,
    entryIdentity: 'gameparam#100:NpcParam.param',
    indexPageSize: 20,
    payloadBatchSize: 45,
    resolveRowDataSize: async (header) => {
      widthResolutions += 1;
      assert.deepEqual(header, {
        sourceHash: SOURCE_HASH,
        typeName: 'ACTION_GUIDE_PARAM_ST',
        dataVersion: 1
      });
      return ROW_DATA_SIZE;
    }
  }, () => undefined, bridge);

  assert.equal(result.ok, true);
  assert.equal(widthResolutions, 1);
  assert.equal(requests[0]?.commandOptions?.expectedRowDataSize, undefined);
  assert.equal(requests[1]?.commandOptions?.headerOnly, true);
  assert.equal(requests[2]?.commandOptions?.expectedRowDataSize, ROW_DATA_SIZE);
  assert.equal(calls.every((request) => request.commandOptions?.expectedRowDataSize === ROW_DATA_SIZE), true);
});

test('stops issuing page and selection requests when cancelled between payload batches', async () => {
  const { bridge, calls } = createPagedBridge();
  const controller = new AbortController();
  let deliveredBatches = 0;
  await assert.rejects(readParamDocumentRowsPagedViaBridge({
    sourcePath: 'C:\\workspace\\NpcParam.param',
    allowedRoots: ['C:\\workspace'],
    workspaceSessionId: WORKSPACE_SESSION_ID,
    pathSourceGeneration: PATH_SOURCE_GENERATION,
    entryIdentity: 'gameparam#100:NpcParam.param',
    expectedRowDataSize: ROW_DATA_SIZE,
    indexPageSize: 20,
    payloadBatchSize: 11,
    signal: controller.signal
  }, () => {
    deliveredBatches += 1;
    controller.abort(new Error('cancel between row-selection batches'));
  }, bridge), /cancel between row-selection batches/u);

  assert.equal(deliveredBatches, 1);
  assert.equal(calls.length, 2, 'only the first index page and first selected-row batch may be requested');
});

test('rejects an untrusted PARAM definition before requesting any payload', async () => {
  const { bridge, calls } = createPagedBridge();
  let deliveredBatches = 0;
  const result = await readParamDocumentRowsPagedViaBridge({
    sourcePath: 'C:\\workspace\\NpcParam.param',
    allowedRoots: ['C:\\workspace'],
    workspaceSessionId: WORKSPACE_SESSION_ID,
    pathSourceGeneration: PATH_SOURCE_GENERATION,
    entryIdentity: 'gameparam#100:NpcParam.param',
    expectedRowDataSize: ROW_DATA_SIZE,
    indexPageSize: 20,
    validateIdentity: () => false
  }, () => { deliveredBatches += 1; }, bridge);

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((diagnostic: TestDiagnostic) => diagnostic.code), ['PARAM_METADATA_DEFINITION_UNTRUSTED']);
  assert.equal(deliveredBatches, 0);
  assert.equal(calls.length, 1, 'untrusted metadata must fail before the first payload selection request');
});

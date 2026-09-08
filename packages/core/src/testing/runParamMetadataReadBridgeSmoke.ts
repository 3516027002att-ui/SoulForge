import assert from 'node:assert/strict';
import type { runBridge } from '../bridge/runBridge.js';
import { readParamDocumentViaBridge } from '../editing/paramBridgeCommit.js';

const header = { sourceHash: 'a'.repeat(64), typeName: 'DEMO', dataVersion: 3 };
const document = { ...header, rowCount: 1, rowDataSize: 16,
  rows: [{ rowIndex: 0, id: 7, dataBase64: Buffer.alloc(16).toString('base64'), dataHash: 'b'.repeat(64) }] };
const failed = { parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'needs metadata' }] };
const ok = (data: unknown) => ({ parseStatus: 'parsed', diagnostics: [], data });
let checks = 0;
async function scenario(responses: unknown[], width: number | undefined, expectedCode?: string): Promise<void> {
  const calls: Array<Record<string, unknown>> = [];
  const bridge = (async (options: { commandOptions: Record<string, unknown> }) => {
    calls.push(options.commandOptions);
    return responses[calls.length - 1];
  }) as unknown as typeof runBridge;
  const result = await readParamDocumentViaBridge({
    sourcePath: '/fixture/param', allowedRoots: ['/fixture'], rowIds: [7],
    resolveRowDataSize: async (value) => { assert.deepEqual(value, header); return width; }
  }, bridge);
  assert.equal(result.ok, expectedCode === undefined);
  if (expectedCode) assert(result.diagnostics.some((d) => d.code === expectedCode));
  if (calls.length === 3) assert.deepEqual(calls[2], { rowIds: [7], expectedRowDataSize: 16 });
  if (calls.length >= 2) assert.deepEqual(calls[1], { headerOnly: true });
  assert.equal(calls.length, responses.length);
  checks++;
}
await scenario([failed, ok(header), ok(document)], 16);
await scenario([ok(document)], undefined);
await scenario([failed, ok(header)], undefined, 'PARAM_METADATA_ROW_WIDTH_UNRESOLVED');
await scenario([failed, ok(header)], 0, 'PARAM_METADATA_ROW_WIDTH_UNRESOLVED');
for (const drift of [{ sourceHash: 'c'.repeat(64) }, { typeName: 'OTHER' }, { dataVersion: 4 }, { rowDataSize: 20 }]) {
  await scenario([failed, ok(header), ok({ ...document, ...drift })], 16, 'PARAM_METADATA_READ_IDENTITY_MISMATCH');
}
await scenario([failed, ok(header), failed], 16, 'PARAM_ROW_SIZE_REQUIRED');
console.log(JSON.stringify({ ok: true, test: 'param-metadata-read-bridge', checks, authority: 'fixture-confirmed' }));

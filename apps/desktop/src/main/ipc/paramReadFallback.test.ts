import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { readParamDocumentWithMetadataFallback } from './paramReadFallback.ts';

test('single-row PARAM read retries with the trusted row width from the native header', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const bridge = async (options: Record<string, unknown>) => {
    calls.push(options);
    if (calls.length === 1) {
      return {
        parseStatus: 'failed',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'width required' }]
      };
    }
    if (calls.length === 2) {
      return {
        parseStatus: 'partial',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        data: { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 },
        diagnostics: []
      };
    }
    return {
      parseStatus: 'partial',
      sourceUri: 'file:///synthetic/one.param',
      sourcePath: 'C:/synthetic/one.param',
      game: 'sekiro',
      resourceKind: 'param',
      data: { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1, rowDataSize: 32 },
      diagnostics: []
    };
  };

  const result = await readParamDocumentWithMetadataFallback(
    {
      filePath: 'C:/synthetic/one.param',
      allowedRoots: ['C:/synthetic'],
      commandOptions: { includeRowPayloads: false, includeRowHashes: true }
    },
    async (header) => {
      assert.deepEqual(header, { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 });
      return 32;
    },
    bridge as never
  );

  assert.equal(result.parseStatus, 'partial');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1]?.commandOptions, { headerOnly: true });
  assert.deepEqual(calls[2]?.commandOptions, {
    includeRowPayloads: false,
    includeRowHashes: true,
    expectedRowDataSize: 32
  });
});

test('metadata fallback fails closed when the retried document changes source identity', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const bridge = async (options: Record<string, unknown>) => {
    calls.push(options);
    if (calls.length === 1) {
      return {
        parseStatus: 'failed',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'width required' }]
      };
    }
    if (calls.length === 2) {
      return {
        parseStatus: 'partial',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        data: { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 },
        diagnostics: []
      };
    }
    return {
      parseStatus: 'partial',
      sourceUri: 'file:///synthetic/one.param',
      sourcePath: 'C:/synthetic/one.param',
      game: 'sekiro',
      resourceKind: 'param',
      data: { sourceHash: 'source-2', typeName: 'ONE_PARAM_ST', dataVersion: 1, rowDataSize: 32 },
      diagnostics: []
    };
  };

  const result = await readParamDocumentWithMetadataFallback(
    {
      filePath: 'C:/synthetic/one.param',
      allowedRoots: ['C:/synthetic'],
      commandOptions: { includeRowPayloads: false }
    },
    async (header) => {
      assert.deepEqual(header, { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 });
      return 32;
    },
    bridge as never
  );

  assert.equal(result.parseStatus, 'failed');
  assert.equal(result.data, undefined);
  assert.equal(result.diagnostics.at(-1)?.code, 'PARAM_METADATA_READ_IDENTITY_MISMATCH');
  assert.equal(calls.length, 3);
});

test('metadata fallback fails closed when the retried document omits or empties source identity', async () => {
  for (const sourceHash of [undefined, '']) {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = async (options: Record<string, unknown>) => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          parseStatus: 'failed',
          sourceUri: 'file:///synthetic/one.param',
          sourcePath: 'C:/synthetic/one.param',
          game: 'sekiro',
          resourceKind: 'param',
          diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'width required' }]
        };
      }
      if (calls.length === 2) {
        return {
          parseStatus: 'partial',
          sourceUri: 'file:///synthetic/one.param',
          sourcePath: 'C:/synthetic/one.param',
          game: 'sekiro',
          resourceKind: 'param',
          data: { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 },
          diagnostics: []
        };
      }
      return {
        parseStatus: 'partial',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        data: {
          ...(sourceHash === undefined ? {} : { sourceHash }),
          typeName: 'ONE_PARAM_ST',
          dataVersion: 1,
          rowDataSize: 32,
          rows: []
        },
        diagnostics: []
      };
    };

    const result = await readParamDocumentWithMetadataFallback(
      {
        filePath: 'C:/synthetic/one.param',
        allowedRoots: ['C:/synthetic'],
        commandOptions: { includeRowPayloads: false }
      },
      async (header) => {
        assert.deepEqual(header, { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 });
        return 32;
      },
      bridge as never
    );

    assert.equal(result.parseStatus, 'failed');
    assert.equal(result.data, undefined);
    assert.equal(result.diagnostics.at(-1)?.code, 'PARAM_METADATA_READ_IDENTITY_MISMATCH');
    assert.equal(calls.length, 3);
  }
});

test('metadata fallback never resolves a blank header source identity or type name', async () => {
  for (const data of [
    { sourceHash: '', typeName: 'ONE_PARAM_ST', dataVersion: 1 },
    { sourceHash: 'source-1', typeName: '', dataVersion: 1 }
  ]) {
    let resolveCalls = 0;
    const bridge = async (options: Record<string, unknown>) => {
      if (options.commandOptions && (options.commandOptions as Record<string, unknown>).headerOnly) {
        return {
          parseStatus: 'partial',
          sourceUri: 'file:///synthetic/one.param',
          sourcePath: 'C:/synthetic/one.param',
          game: 'sekiro',
          resourceKind: 'param',
          data,
          diagnostics: []
        };
      }
      return {
        parseStatus: 'failed',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'width required' }]
      };
    };

    const result = await readParamDocumentWithMetadataFallback(
      {
        filePath: 'C:/synthetic/one.param',
        allowedRoots: ['C:/synthetic'],
        commandOptions: { includeRowPayloads: false }
      },
      async () => {
        resolveCalls += 1;
        return 32;
      },
      bridge as never
    );

    assert.equal(resolveCalls, 0);
    assert.equal(result.parseStatus, 'failed');
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_ROW_SIZE_REQUIRED'));
  }
});

test('metadata fallback preserves a native failed reread and its original diagnostics', async () => {
  let calls = 0;
  const bridge = async (options: Record<string, unknown>) => {
    calls += 1;
    if (calls === 1) {
      return {
        parseStatus: 'failed',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_SIZE_REQUIRED', message: 'width required' }]
      };
    }
    if (calls === 2) {
      return {
        parseStatus: 'partial',
        sourceUri: 'file:///synthetic/one.param',
        sourcePath: 'C:/synthetic/one.param',
        game: 'sekiro',
        resourceKind: 'param',
        data: { sourceHash: 'source-1', typeName: 'ONE_PARAM_ST', dataVersion: 1 },
        diagnostics: []
      };
    }
    return {
      parseStatus: 'failed',
      sourceUri: 'file:///synthetic/one.param',
      sourcePath: 'C:/synthetic/one.param',
      game: 'sekiro',
      resourceKind: 'param',
      diagnostics: [{ severity: 'error', code: 'PARAM_NATIVE_READ_FAILED', message: 'bridge failed' }]
    };
  };

  const result = await readParamDocumentWithMetadataFallback(
    {
      filePath: 'C:/synthetic/one.param',
      allowedRoots: ['C:/synthetic'],
      commandOptions: { includeRowPayloads: false }
    },
    async () => 32,
    bridge as never
  );

  assert.equal(result.parseStatus, 'failed');
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    severity: 'error',
    code: 'PARAM_NATIVE_READ_FAILED',
    message: 'bridge failed'
  });
  assert.equal(calls, 3);
});

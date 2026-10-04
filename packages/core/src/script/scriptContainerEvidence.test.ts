import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BridgeRunner, RunBridgeOptions } from '../bridge/runBridge.js';
import * as scriptEvidence from './scriptContainerEvidence.js';

describe('script container evidence contract', () => {
  it('rejects standalone resources as container evidence without synthetic BND4 slots', () => {
    const buildRequiresContainerEvidence = (scriptEvidence as unknown as {
      buildRequiresContainerEvidence?: (
        containerPath: string,
        containerFormat: string,
        extensionDistribution?: Record<string, number>
      ) => scriptEvidence.ScriptContainerEvidence;
    }).buildRequiresContainerEvidence;

    assert.equal(typeof buildRequiresContainerEvidence, 'function');
    const result = buildRequiresContainerEvidence!('C:/fixture/c0000.hks', 'raw', { hks: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.entryCount, 0);
    assert.deepEqual(result.entries, []);
    assert.equal(result.containerFormat, 'raw');
    assert.equal(result.diagnostics[0]?.code, 'SCRIPT_EVIDENCE_REQUIRES_CONTAINER');
    assert.equal(JSON.stringify(result).includes('"index":0'), false);
  });

  it('does not request a BND4 reference table for an explicit non-container resource', async () => {
    const calls: string[] = [];
    const bridgeRunner: BridgeRunner = async <T>(request: RunBridgeOptions) => {
      calls.push(request.command);
      assert.equal(request.command, 'inventory-asset-resources');
      return {
        sourceUri: request.resourceUri ?? 'file:///fixture',
        sourcePath: request.filePath,
        game: 'sekiro',
        resourceKind: 'other',
        parseStatus: 'parsed',
        data: {
          containerType: 'none',
          format: 'raw',
          entryCount: 1,
          extensions: { hks: 1 },
          sampleEntries: [{ name: 'c0000_transition.hks', index: 0, uncompressedSize: 8 }]
        } as T,
        diagnostics: []
      };
    };

    const result = await scriptEvidence.buildScriptContainerEvidence({
      containerPath: 'C:/fixture/action/script/c0000_transition.hks',
      allowedRoots: ['C:/fixture']
    }, bridgeRunner);

    assert.deepEqual(calls, ['inventory-asset-resources']);
    assert.equal(result.ok, false);
    assert.equal(result.entryCount, 0);
    assert.deepEqual(result.entries, []);
    assert.equal(result.containerFormat, 'raw');
    assert.equal(result.diagnostics[0]?.code, 'SCRIPT_EVIDENCE_REQUIRES_CONTAINER');
    assert.equal(JSON.stringify(result).includes('"index":0'), false);
  });

  it('keeps BND4 success dependent on native full-reference enumeration', async () => {
    const calls: string[] = [];
    const bridgeRunner: BridgeRunner = async <T>(request: RunBridgeOptions) => {
      calls.push(request.command);
      if (request.command === 'inventory-asset-resources') {
        return {
          sourceUri: request.resourceUri ?? 'file:///fixture',
          sourcePath: request.filePath,
          game: 'sekiro',
          resourceKind: 'other',
          parseStatus: 'parsed',
          data: { containerType: 'bnd4', format: 'BND4', entryCount: 1, extensions: { hks: 1 }, sampleEntries: [{ name: 'c0000.hks', uncompressedSize: 8 }] } as T,
          diagnostics: []
        };
      }
      assert.equal(request.command, 'list-bnd4-entries');
      return {
        sourceUri: request.resourceUri ?? 'file:///fixture',
        sourcePath: request.filePath,
        game: 'sekiro',
        resourceKind: 'other',
        parseStatus: 'failed',
        diagnostics: [{ severity: 'error', code: 'LIST_FAILED', message: 'fixture' }]
      };
    };

    const result = await scriptEvidence.buildScriptContainerEvidence({
      containerPath: 'C:/fixture/action/script/script.luabnd',
      allowedRoots: ['C:/fixture']
    }, bridgeRunner);

    assert.deepEqual(calls, ['inventory-asset-resources', 'list-bnd4-entries']);
    assert.equal(result.ok, false);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.index, -1);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'SCRIPT_EVIDENCE_REFERENCE_TABLE_UNAVAILABLE'));
  });
});

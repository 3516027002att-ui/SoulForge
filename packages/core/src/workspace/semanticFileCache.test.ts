import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import {
  extractFileSymbolBundle,
  isNativeSemanticBundleCurrent,
  loadSymbolBundleIntoIndex,
  rebaseSymbolBundleToFileRevision
} from './semanticFileCache.js';
import type { EventExport, ParamExport } from '@soulforge/shared';

describe('semanticFileCache', () => {
  it('extracts and hydrates file-specific symbols round-trip', () => {
    const index = new WorkspaceIndex('test-ws');

    const paramExportA: ParamExport = {
      sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
      paramName: 'NpcParam',
      rows: [
        {
          uri: 'param://NpcParam/50800000',
          sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
          paramName: 'NpcParam',
          rowId: 50800000,
          rowName: '鬼刑部',
          fields: [{ name: 'hp', value: 5000, type: 'u32' }]
        }
      ]
    };

    const eventExportB: EventExport = {
      events: [
        {
          uri: 'event://file://event/common.emevd.dcx/100',
          sourceUri: 'file://event/common.emevd.dcx',
          eventId: 100,
          name: 'MainEvent',
          instructions: []
        }
      ]
    };

    index.upsertParamExport(paramExportA);
    index.upsertEventExport(eventExportB);

    // Extract bundle for param file
    const paramBundle = extractFileSymbolBundle(index, 'file://param/gameparam/gameparam.parambnd.dcx');
    assert.ok(paramBundle.params);
    assert.equal(paramBundle.params.length, 1);
    assert.equal(paramBundle.params[0]?.paramName, 'NpcParam');
    assert.equal(paramBundle.events, undefined);

    // Extract bundle for event file
    const eventBundle = extractFileSymbolBundle(index, 'file://event/common.emevd.dcx');
    assert.ok(eventBundle.events);
    assert.equal(eventBundle.events.length, 1);
    assert.equal(eventBundle.events[0]?.events[0]?.eventId, 100);
    assert.equal(eventBundle.params, undefined);

    // Hydrate into a fresh index
    const freshIndex = new WorkspaceIndex('test-ws-fresh');
    loadSymbolBundleIntoIndex(freshIndex, paramBundle);
    loadSymbolBundleIntoIndex(freshIndex, eventBundle);

    assert.equal(freshIndex.getStats().paramRows, 1);
    assert.equal(freshIndex.getStats().events, 1);
    assert.equal(freshIndex.lookupEvents(100).length, 1);
    assert.equal(freshIndex.lookupEvents(100)[0]?.name, 'MainEvent');
  });

  it('rejects native cache hits without outer hash and source revision proof', () => {
    const file = {
      id: 'file://param/gameparam/gameparam.parambnd.dcx',
      workspaceId: 'test-ws',
      sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
      sourcePath: 'param/gameparam/gameparam.parambnd.dcx',
      absolutePath: 'param/gameparam/gameparam.parambnd.dcx',
      relativePath: 'param/gameparam/gameparam.parambnd.dcx',
      game: 'sekiro',
      resourceKind: 'param' as const,
      extension: '.dcx',
      compoundExtension: '.parambnd.dcx',
      formatKind: 'param' as const,
      formatLabel: 'PARAM BND DCX',
      size: 32,
      mtimeMs: 123,
      sha256: 'outer-v2',
      parseStatus: 'partial' as const,
      diagnostics: []
    };
    const oldBundle = {
      params: [{
        paramName: 'NpcParam',
        sourceUri: file.sourceUri,
        rows: [{
          uri: 'param://NpcParam/1',
          sourceUri: file.sourceUri,
          paramName: 'NpcParam',
          rowId: 1,
          fields: []
        }]
      }]
    };
    assert.equal(isNativeSemanticBundleCurrent(file, oldBundle), false);

    const currentBundle = {
      params: [{
        paramName: 'NpcParam',
        sourceUri: file.sourceUri,
        outerFileHash: file.sha256,
        sourceRevision: file.mtimeMs,
        rows: [{
          uri: 'param://NpcParam/1',
          sourceUri: file.sourceUri,
          paramName: 'NpcParam',
          rowId: 1,
          outerFileHash: file.sha256,
          sourceRevision: file.mtimeMs,
          fields: []
        }]
      }]
    };
    assert.equal(isNativeSemanticBundleCurrent(file, currentBundle), true);
    assert.equal(isNativeSemanticBundleCurrent({ ...file, mtimeMs: 456 }, currentBundle), true);
    const rebased = rebaseSymbolBundleToFileRevision({ mtimeMs: 456 }, currentBundle);
    assert.equal(rebased.params?.[0]?.sourceRevision, 456);
    assert.equal(rebased.params?.[0]?.rows[0]?.sourceRevision, 456);
    assert.equal(isNativeSemanticBundleCurrent({
      ...file,
      relativePath: 'param/mockparam.json',
      absolutePath: 'param/mockparam.json'
    }, oldBundle), true);
  });
});

import assert from 'node:assert/strict';
import { harness, uri } from './raw-resource-harness.mjs';

/** Execute the production IPC adapter/service with owned native and filesystem ports.
 * This proves routing and projection, not native parsing or real-corpus acceptance. */
export async function assertRawNativeContainerContract() {
  const observations = [];
  const entries = Array.from({ length: 205 }, (_, index) => ({
    index, name: `N:\\PRIVATE\\child${index}.lua`, uncompressedSize: index + 1
  }));
  for (const kind of ['bnd4', 'dcx']) {
    const command = kind === 'bnd4' ? 'list-bnd4-entries' : 'read-dcx-document';
    const h = harness({
      nativeFallback: true, header: Buffer.from(kind === 'bnd4' ? 'BND4\0\0\0\0' : 'DCX\0owned'),
      size: 256 * 1024 * 1024, shortRead: 2,
      readFile: () => { throw new Error('Native routing must not read the whole archive'); },
      bridge: input => {
        assert.equal(input.command, command);
        assert.deepEqual(Array.from(input.allowedRoots), ['/owned/mod']);
        assert.equal(input.timeoutMs, 60_000);
        return { parseStatus: 'partial', diagnostics: [], data: kind === 'bnd4'
          ? { format: 'BND4', entryCount: entries.length, entries }
          : { format: 'DCX', nested: { format: 'BND4', entryCount: entries.length, entries } } };
      }
    });
    const all = [];
    for (let page = 0; page < 3; page++) {
      const result = await h.invoke('listContainerChildrenPage', uri, page, 100);
      assert.equal(result.ok, true);
      assert.equal(result.totalCount, entries.length);
      assert.equal(result.children.length, page === 2 ? 5 : 100);
      for (const child of result.children) {
        assert.equal(child.canReplace, false);
        assert.equal(child.rawBytesAvailable, kind === 'dcx');
        assert.equal('absolutePath' in child, false);
        assert.equal(child.sourceContainerUri, uri);
        assert.ok(child.childUri.startsWith(`${uri}#bnd/child/`));
      }
      assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
      all.push(...result.children.map(child => child.childId));
    }
    assert.deepEqual(all, entries.map(entry => String(entry.index)));
    assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 1);
    assert.equal(h.calls.some(([name]) => name === 'readFile' || name === 'list'), false);
    assert.deepEqual(h.calls.filter(([name]) => name === 'headerRead').map(call => call[2]), [0, 2, 4, 6]);
    assert.equal(h.calls.filter(([name]) => name === 'close').length, 1);
    const complete = await h.invoke('listContainerChildren', uri);
    assert.equal(complete.ok, true);
    assert.equal(complete.children.length, entries.length);
    assert.ok(complete.diagnostics.some(d => d.code === 'BND_NATIVE_ENUMERATION_COMPLETE'));
    observations.push({ kind, command, total: all.length, pages: 3, headerBytes: 8 });
  }
  for (const magic of ['BND3SFBN', 'BND4SFBN']) {
    const h = harness({ header: Buffer.from(magic) });
    const first = await h.invoke('listContainerChildrenPage', uri, 0, 100);
    const tail = await h.invoke('listContainerChildrenPage', uri, 2, 100);
    assert.equal(first.totalCount, 205);
    assert.equal(tail.children.length, 5);
    assert.equal(h.calls.filter(([name]) => name === 'list').length, 1);
    assert.equal(h.calls.some(([name]) => name === 'bridge'), false);
    observations.push({ kind: magic, authority: 'synthetic-fixture', total: 205 });
  }
  const unsupported = harness({ header: Buffer.from('BND3\0\0\0\0') });
  const refusal = await unsupported.invoke('listContainerChildrenPage', uri, 0, 100);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.diagnostics[0].code, 'BND3_NATIVE_ENUMERATION_UNSUPPORTED');
  assert.equal(unsupported.calls.some(([name]) => ['bridge', 'list', 'readFile'].includes(name)), false);
  observations.push({ kind: 'bnd3', status: 'unsupported' });

  for (const header of [Buffer.alloc(0), Buffer.from('BN'), Buffer.from('BND4')]) {
    const h = harness({ header, nativeFallback: true, fixtureListing: { ok: false, children: [], diagnostics: [{ severity: 'error', code: 'CONTAINER_FORMAT_UNSUPPORTED', message: 'Owned short header' }] }, bridge: () => ({
      parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'BND4_LIST_ENTRIES_FAILED', message: 'Truncated native header' }]
    }) });
    const result = await h.invoke('listContainerChildrenPage', uri, 0, 100);
    assert.equal(result.ok, false);
    if (header.length === 4) {
      assert.equal(result.diagnostics[0].code, 'BND4_LIST_ENTRIES_FAILED');
      assert.equal(h.calls.find(([name]) => name === 'bridge')[1].command, 'list-bnd4-entries');
    } else {
      assert.equal(result.diagnostics[0].code, 'CONTAINER_FORMAT_UNSUPPORTED');
      assert.equal(h.calls.some(([name]) => name === 'bridge'), false);
    }
    assert.ok(h.calls.filter(([name]) => name === 'headerRead').reduce((sum, call) => sum + call[3], 0) <= 8);
    assert.equal(h.calls.filter(([name]) => name === 'close').length, 1);
  }
  for (const code of ['BRIDGE_PATH_OUTSIDE_ROOTS', 'BRIDGE_TIMEOUT', 'DCX_DOCUMENT_READ_FAILED']) {
    const h = harness({ nativeFallback: true, bridge: () => ({
      parseStatus: 'failed', diagnostics: [{ severity: 'error', code, message: 'Owned native refusal' }]
    }) });
    const result = await h.invoke('listContainerChildrenPage', uri, 0, 100);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, code);
    assert.equal(h.calls.some(([name]) => name === 'list'), code === 'DCX_DOCUMENT_READ_FAILED');
  }
  return { authority: 'owned-port-production-routing', nativeAcceptance: false, observations,
    shortHeaders: 3, nativeRefusals: 3 };
}

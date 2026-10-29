import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  containerCatalogHash,
  logicalEntryName,
  normalizeContainerEntries,
  type ContainerEntry
} from './containerEntries.js';

function entry(name: string, index: number, size = 16): ContainerEntry {
  return {
    index,
    id: index + 100,
    name,
    size,
    compressedSize: size,
    dataOffset: index * 32,
    contentHash: null,
    duplicateOrdinal: null
  };
}

describe('logicalEntryName', () => {
  it('strips the packer build root so entry names stay usable and path-free', () => {
    assert.equal(
      logicalEntryName('N:\\NTC\\data\\Target\\INTERROOT_win64\\chr\\c0000\\hkx\\skeleton.hkx'),
      'chr/c0000/hkx/skeleton.hkx'
    );
    assert.equal(
      logicalEntryName('N:\\NTC\\data\\Target\\INTERROOT_x64\\event\\common.emevd'),
      'event/common.emevd'
    );
  });

  it('falls back to the basename for names without a build root', () => {
    assert.equal(logicalEntryName('eff_a.fxr'), 'eff_a.fxr');
    assert.equal(logicalEntryName('chr/c0000.anib'), 'c0000.anib');
  });

  it('is stable for already-logical names with a single segment', () => {
    assert.equal(logicalEntryName('c0000.hkx'), 'c0000.hkx');
    assert.equal(logicalEntryName(''), '');
  });
});

describe('normalizeContainerEntries — BND4 payload', () => {
  it('normalizes path-like stored names into container-relative paths', () => {
    const normalized = normalizeContainerEntries({
      entryCount: 2,
      entries: [
        { index: 0, id: 5000000, name: 'N:\\NTC\\data\\Target\\INTERROOT_win64\\chr\\c0000\\tae\\a00.tae', size: 10 },
        { index: 1, id: 5000010, name: 'N:\\NTC\\data\\Target\\INTERROOT_win64\\chr\\c0000\\tae\\a10.tae', size: 20 }
      ]
    }, 'list-bnd4-entries');
    assert.deepEqual(normalized.entries.map((item) => item.name), ['chr/c0000/tae/a00.tae', 'chr/c0000/tae/a10.tae']);
    assert.deepEqual(normalized.extensions, ['.tae']);
  });
  it('keeps ids/sizes/offsets and reports the payload entryCount', () => {
    const normalized = normalizeContainerEntries({
      format: 'DCX',
      entryCount: 3,
      entries: [
        { index: 0, id: 1000, name: 'c0000.anibnd', size: 128, compressedSize: 64, dataOffset: 512, duplicateOrdinal: 0 },
        { index: 1, id: 1001, name: 'c0000_AUX.anibnd', size: 32, compressedSize: 32, dataOffset: 640, duplicateOrdinal: 1 },
        { index: 2, id: 1002, name: 'Nothing' }
      ]
    }, 'list-bnd4-entries');

    assert.equal(normalized.entryCount, 3);
    assert.equal(normalized.entries.length, 3);
    assert.deepEqual(normalized.entries[0], {
      index: 0,
      id: 1000,
      name: 'c0000.anibnd',
      size: 128,
      compressedSize: 64,
      dataOffset: 512,
      contentHash: null,
      duplicateOrdinal: 0
    });
    // 没有 size/offset 的条目保持 null，而不是补 0 冒充已知值。
    assert.equal(normalized.entries[2]?.size, null);
    assert.equal(normalized.entries[2]?.dataOffset, null);
    assert.equal(normalized.entries[2]?.duplicateOrdinal, null);
    // 扩展名直方图按小写去重排序；没有点的名字不产生空扩展名。
    assert.deepEqual(normalized.extensions, ['.anibnd']);
  });

  it('does not invent an entryCount when the payload omits it', () => {
    const normalized = normalizeContainerEntries({
      entries: [{ name: 'a.param' }, { name: 'b.param' }]
    }, 'list-bnd4-entries');
    assert.equal(normalized.entryCount, null);
    assert.equal(normalized.entries.length, 2);
  });
});

describe('normalizeContainerEntries — ffxbnd name list', () => {
  it('maps a plain name array to positional entries with unknown identity', () => {
    const normalized = normalizeContainerEntries({
      entries: ['eff_a.fxr', 'eff_b.fxr', '']
    }, 'list-ffxbnd-entries');

    assert.equal(normalized.entryCount, 2);
    assert.deepEqual(normalized.entries.map((item) => item.name), ['eff_a.fxr', 'eff_b.fxr']);
    assert.equal(normalized.entries[1]?.id, null);
    assert.equal(normalized.entries[1]?.size, null);
    assert.equal(normalized.entries[1]?.index, 1);
    assert.deepEqual(normalized.extensions, ['.fxr']);
  });
});

describe('normalizeContainerEntries — malformed payloads', () => {
  it('drops entries without a usable name instead of emitting blanks', () => {
    const normalized = normalizeContainerEntries({
      entries: [null, 42, {}, { name: '' }, { name: 'keep.behbnd' }]
    }, 'list-bnd4-entries');
    assert.deepEqual(normalized.entries.map((item) => item.name), ['keep.behbnd']);
  });

  it('treats a non-object payload as an empty catalog', () => {
    assert.deepEqual(normalizeContainerEntries(null, 'list-bnd4-entries'), {
      entries: [],
      entryCount: null,
      extensions: []
    });
  });
});

describe('containerCatalogHash', () => {
  const entries = [entry('c0000.anibnd', 0), entry('c0000_AUX.anibnd', 1)];

  it('is stable for identical catalogs and independent of unrelated fields', () => {
    const first = containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'outer-hash', entries);
    const second = containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'outer-hash', [
      { ...entries[0]!, size: 999, contentHash: 'ignored' },
      { ...entries[1]!, dataOffset: 1 }
    ]);
    assert.equal(first, second);
  });

  it('changes when the container source hash or a member name changes', () => {
    const base = containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'outer-hash', entries);
    assert.notEqual(base, containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'other-hash', entries));
    assert.notEqual(base, containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'outer-hash', [
      entry('c0000.anibnd', 0),
      entry('c0000_EXTRA.anibnd', 1)
    ]));
    assert.notEqual(base, containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'outer-hash', [
      entry('c0000.anibnd', 0)
    ]));
  });

  it('changes when the same members are listed from a different container', () => {
    assert.notEqual(
      containerCatalogHash('file:///mods/chr/c0000.anibnd.dcx', 'outer-hash', entries),
      containerCatalogHash('file:///mods/chr/c1000.anibnd.dcx', 'outer-hash', entries)
    );
  });
});

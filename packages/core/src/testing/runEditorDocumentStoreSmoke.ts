import { EditorDocumentStore } from '../editing/editorDocumentStore.js';

function main(): void {
  const store = new EditorDocumentStore();
  const fmg = store.open({
    editorKind: 'fmg',
    resourceUri: 'file://msg/item.fmg',
    title: '道具名'
  });
  const msb = store.open({
    editorKind: 'msb',
    resourceUri: 'file://map/m10.msb',
    title: '地图 m10'
  });

  const badKind = store.applyMutation({
    documentId: fmg.documentId,
    kind: 'msb_set_part_position',
    resourceUri: fmg.resourceUri,
    baseRevision: 0,
    payload: { partName: 'x', posX: 1, posY: 2, posZ: 3 }
  });
  if (badKind.ok) throw new Error('FMG editor must reject MSB mutation');

  const okFmg = store.applyMutation({
    documentId: fmg.documentId,
    kind: 'fmg_entry_upsert',
    resourceUri: fmg.resourceUri,
    baseRevision: 0,
    payload: { id: 5200, text: '旋风斩' }
  });
  if (!okFmg.ok || okFmg.document?.revision !== 1) throw new Error('FMG mutation failed');

  const stale = store.applyMutation({
    documentId: fmg.documentId,
    kind: 'fmg_entry_upsert',
    resourceUri: fmg.resourceUri,
    baseRevision: 0,
    payload: { id: 5200, text: 'stale' }
  });
  if (stale.ok || !stale.issues.some((i) => i.code === 'EDITOR_REVISION_CONFLICT')) {
    throw new Error('stale revision must conflict');
  }

  const okMsb = store.applyMutation({
    documentId: msb.documentId,
    kind: 'msb_set_part_position',
    resourceUri: msb.resourceUri,
    baseRevision: 0,
    payload: { partName: 'm000010_1077', posX: 1, posY: 2, posZ: 3 }
  });
  if (!okMsb.ok) throw new Error('MSB mutation failed');

  const batch = store.createPatchEngineBatch(fmg.documentId);
  if (!batch.ok || !batch.batch?.requiresPatchEngine) {
    throw new Error('batch must require Patch Engine');
  }
  if (batch.batch.mutations.length !== 1) throw new Error('unexpected mutation count');

  const committed = store.markCommitted(fmg.documentId, batch.batch.batchId);
  if (committed.length) throw new Error('markCommitted failed');
  const after = store.get(fmg.documentId);
  if (!after || after.dirty) throw new Error('document should be clean after commit');

  // Re-open same URI returns same document
  const again = store.open({
    editorKind: 'fmg',
    resourceUri: fmg.resourceUri,
    title: '道具名'
  });
  if (again.documentId !== fmg.documentId) throw new Error('open should reuse document');

  store.close(msb.documentId);
  if (store.get(msb.documentId)) throw new Error('closed document still listed');

  console.log(JSON.stringify({
    ok: true,
    message: '专业编辑器文档仓库统一 mutation 验证通过',
    fmgRevision: after.revision,
    batchRequiresPatchEngine: true,
    rejectedCrossKind: true,
    rejectedStaleRevision: true
  }, null, 2));
}

main();

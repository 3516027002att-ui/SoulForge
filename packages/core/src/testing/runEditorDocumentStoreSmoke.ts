import { EditorDocumentStore } from "../editing/editorDocumentStore.js";

function main(): void {
  const store = new EditorDocumentStore();
  const fmg = store.open({
    editorKind: "fmg",
    resourceUri: "file://msg/item.fmg",
    title: "item names"
  });
  const msb = store.open({
    editorKind: "msb",
    resourceUri: "file://map/m10.msb",
    title: "map m10"
  });

  if (store.listOpenDocuments().length !== 2) throw new Error("expected 2 open documents");

  const badKind = store.applyMutation({
    documentId: fmg.documentId,
    kind: "msb_set_part_position",
    resourceUri: fmg.resourceUri,
    baseRevision: fmg.revision,
    payload: { partName: "c0000", x: 1, y: 2, z: 3 }
  });
  if (badKind.ok) throw new Error("cross-kind mutation should fail");

  const ok = store.applyMutation({
    documentId: fmg.documentId,
    kind: "fmg_entry_upsert",
    resourceUri: fmg.resourceUri,
    baseRevision: fmg.revision,
    payload: { entryId: 100, text: "hello" }
  });
  if (!ok.ok || !ok.document || ok.document.revision !== 1 || !ok.document.dirty) {
    throw new Error("fmg mutation should advance revision");
  }
  if (store.getPendingMutations(fmg.documentId).length !== 1) throw new Error("pending should be 1");

  const stale = store.applyMutation({
    documentId: fmg.documentId,
    kind: "fmg_entry_upsert",
    resourceUri: fmg.resourceUri,
    baseRevision: 0,
    payload: { entryId: 100, text: "stale" }
  });
  if (stale.ok) throw new Error("stale revision should fail");

  const snap = store.snapshot(fmg.documentId);
  if (!snap || snap.pendingCount !== 1 || snap.pendingMutations.length !== 1) {
    throw new Error("snapshot pending mismatch");
  }

  const batchResult = store.createPatchEngineBatch(fmg.documentId);
  if (!batchResult.ok || !batchResult.batch || batchResult.batch.requiresPatchEngine !== true) {
    throw new Error("batch requires Patch Engine");
  }

  const second = store.applyMutation({
    documentId: fmg.documentId,
    kind: "fmg_entry_upsert",
    resourceUri: fmg.resourceUri,
    baseRevision: ok.document.revision,
    payload: { entryId: 101, text: "world" }
  });
  if (!second.ok || !second.document) throw new Error("second mutation failed");
  if (store.getPendingMutations(fmg.documentId).length !== 2) throw new Error("pending should be 2");

  const cleared = store.markSynced(fmg.documentId);
  if (cleared.length !== 2) throw new Error("markSynced should return 2 mutations");
  if (store.getPendingMutations(fmg.documentId).length !== 0) throw new Error("pending should clear");
  if (store.snapshot(fmg.documentId)?.document.dirty !== false) throw new Error("dirty should clear");

  if (!store.close(msb.documentId)) throw new Error("close should return true");
  if (store.listOpenDocuments().length !== 1) throw new Error("one document remains");
  if (store.snapshot(msb.documentId) !== undefined) throw new Error("closed snapshot undefined");

  const storeSnap = store.snapshotStore();
  if (storeSnap.openDocuments.length !== 1 || storeSnap.totalPendingMutations !== 0) {
    throw new Error("store snapshot mismatch");
  }

  console.log(JSON.stringify({
    ok: true,
    message: "editor document store lifecycle smoke: ok",
    openKinds: store.listOpenDocuments().map((doc) => doc.editorKind),
    rejectedCrossKind: true,
    rejectedStaleRevision: true,
    batchRequiresPatchEngine: true,
    snapshotPending: true,
    closeLifecycle: true
  }, null, 2));
}

main();

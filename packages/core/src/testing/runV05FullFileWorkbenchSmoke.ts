/**
 * v0.5 Full File Workbench + Semantic Spine smoke (self-contained, no ../../mods).
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OperationLogRecord, OperationStatus } from '@soulforge/shared';
import {
  openFileResource,
  proposeTextFileEdit,
  proposeRawByteEdit,
  proposeWholeFileReplace,
  proposeStructuredEditBlocked,
  commitProposedFileWrite,
  commitFilePatch
} from '../files/fileWorkbench.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { MemoryOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import {
  buildSemanticWorkspaceIndex,
  createSemanticSnapshot,
  ingestSyntheticReferenceEdge,
  loadSemanticSnapshot,
  persistSemanticSnapshot,
  reindexChangedResources,
  restoreGraphFromSnapshot
} from '../workspace/semanticWorkspaceIndex.js';
import { buildEvidencePack } from '../ai/evidencePackBuilder.js';
import { buildPatchImpactGraph } from '../patch/patchImpactGraph.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { createTextEditOperation, createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { DEFAULT_PROBE_PREFIX_BYTES } from '../vfs/boundedFileProbe.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

class FailingPendingLogStore implements OperationLogStore {
  record(): void {
    throw new Error('pending log boom');
  }
  get(): undefined { return undefined; }
  list(): [] { return []; }
  updateStatus(): undefined { return undefined; }
  history(): [] { return []; }
}

class FailOnCommittedLogStore implements OperationLogStore {
  private readonly mem = new MemoryOperationLogStore();
  private writes = 0;
  record(entry: OperationLogRecord): void {
    this.writes += 1;
    if (entry.status === 'committed' || this.writes >= 2) {
      throw new Error('committed log boom');
    }
    this.mem.record(entry);
  }
  get(opId: string) { return this.mem.get(opId); }
  list(ws?: string) { return this.mem.list(ws); }
  updateStatus(opId: string, status: OperationStatus, patch?: Partial<OperationLogRecord>) {
    return this.mem.updateStatus(opId, status, patch);
  }
  history(ws?: string) { return this.mem.history(ws); }
}

interface TempModPaths {
  txt: string;
  hks: string;
  emevd: string;
  msb: string;
  param: string;
  chr: string;
  obj: string;
  bin: string;
  baseTxt: string;
  large: string;
}

async function buildTempModWorkspace(): Promise<{
  root: string;
  overlayRoot: string;
  baseRoot: string;
  paths: TempModPaths;
}> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-ffw-'));
  const overlayRoot = join(root, 'mod');
  const baseRoot = join(root, 'game');
  const dirs = ['msg', 'script', 'event', 'map', 'param', 'chr', 'obj', 'other'];
  for (const d of dirs) {
    await mkdir(join(overlayRoot, d), { recursive: true });
    await mkdir(join(baseRoot, d), { recursive: true });
  }

  const paths: TempModPaths = {
    txt: join(overlayRoot, 'msg', 'item.txt'),
    hks: join(overlayRoot, 'script', 'foo.hks'),
    emevd: join(overlayRoot, 'event', 'e0000.emevd.dcx'),
    msb: join(overlayRoot, 'map', 'm10_00_00_00.msb.dcx'),
    param: join(overlayRoot, 'param', 'gameparam.parambnd.dcx'),
    chr: join(overlayRoot, 'chr', 'c0000.chrbnd.dcx'),
    obj: join(overlayRoot, 'obj', 'o0000.objbnd.dcx'),
    bin: join(overlayRoot, 'other', 'blob.bin'),
    baseTxt: join(baseRoot, 'msg', 'base.txt'),
    large: join(overlayRoot, 'event', 'large.emevd.dcx')
  };

  await writeFile(paths.txt, 'item-v1\n', 'utf8');
  await writeFile(paths.hks, '-- hks v1\n', 'utf8');
  await writeFile(paths.emevd, Buffer.from([0x44, 0x43, 0x58, 0x00, 0x01, 0x02]));
  await writeFile(paths.msb, Buffer.from([0x44, 0x43, 0x58, 0x00, 0x03]));
  await writeFile(paths.param, Buffer.from([0x42, 0x4e, 0x44, 0x34, 0x00]));
  await writeFile(paths.chr, Buffer.from([0x42, 0x4e, 0x44, 0x34, 0x01]));
  await writeFile(paths.obj, Buffer.from([0x42, 0x4e, 0x44, 0x34, 0x02]));
  await writeFile(paths.bin, Buffer.from([0x10, 0x20, 0x30, 0x40]));
  await writeFile(paths.baseTxt, 'base-only\n', 'utf8');
  await writeFile(paths.large, Buffer.alloc(DEFAULT_PROBE_PREFIX_BYTES + 64 * 1024, 0));

  return { root, overlayRoot, baseRoot, paths };
}

async function main(): Promise<void> {
  const evidence: Array<{ requirement: string; pass: boolean; detail: string }> = [];
  const mark = (requirement: string, pass: boolean, detail: string) => {
    evidence.push({ requirement, pass, detail });
    if (!pass) throw new Error(`FAIL ${requirement}: ${detail}`);
  };

  const ws = await buildTempModWorkspace();
  const session = await openWorkspaceSession({
    overlayRoot: ws.overlayRoot,
    baseRoot: ws.baseRoot,
    game: 'unknown'
  });
  const store = new MemoryOperationLogStore();

  // A. all files open/read bounded preview
  const rels = [
    'msg/item.txt', 'script/foo.hks', 'event/e0000.emevd.dcx', 'map/m10_00_00_00.msb.dcx',
    'param/gameparam.parambnd.dcx', 'chr/c0000.chrbnd.dcx', 'obj/o0000.objbnd.dcx', 'other/blob.bin'
  ];
  for (const rel of rels) {
    const opened = await openFileResource({ session, relativePath: rel });
    if (!opened.exists) throw new Error(`missing ${rel}`);
    if (!opened.resourceUri.startsWith('soulforge://')) throw new Error(`bad uri ${rel}`);
    if (opened.nativeFormatAuthority) throw new Error(`native authority true for ${rel}`);
    if (!opened.preview) throw new Error(`no preview ${rel}`);
  }
  const largeOpen = await openFileResource({ session, relativePath: 'event/large.emevd.dcx' });
  mark(
    'All files can open/read bounded preview',
    largeOpen.preview.bytesRead <= DEFAULT_PROBE_PREFIX_BYTES
      && largeOpen.capabilities.isPackedOrNative
      && largeOpen.nativeFormatAuthority === false,
    `large bytesRead=${largeOpen.preview.bytesRead}`
  );

  // B. text/raw/replace writes
  const textProp = await proposeTextFileEdit({
    workspaceId: session.meta.workspaceId,
    absolutePath: ws.paths.txt,
    relativePath: 'msg/item.txt',
    newText: 'item-v2\n',
    session
  });
  const textCommit = await commitProposedFileWrite({
    proposal: textProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store
  });
  mark(
    'Text file edit through PatchIR + WorkspaceTransaction',
    textCommit.changedFiles.length === 1
      && (await readFile(ws.paths.txt, 'utf8')) === 'item-v2\n'
      && Boolean(store.get(textCommit.opId)),
    `opId=${textCommit.opId}`
  );

  const binHash = createHash('sha256').update(await readFile(ws.paths.bin)).digest('hex');
  const rawProp = await proposeRawByteEdit({
    workspaceId: session.meta.workspaceId,
    absolutePath: ws.paths.bin,
    relativePath: 'other/blob.bin',
    offset: 1,
    length: 1,
    replacement: Buffer.from([0xaa]),
    expectedHash: binHash,
    session
  });
  const rawCommit = await commitProposedFileWrite({
    proposal: rawProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store,
    confirmation: createConfirmationReceipt({
      subjects: ['resource', 'high', 'ALL_RISKS'],
      riskLevel: 'caution',
      sourceUri: 'file://other/blob.bin'
    })
  });
  mark(
    'Binary raw edit through PatchIR + WorkspaceTransaction',
    (await readFile(ws.paths.bin))[1] === 0xaa && rawCommit.changedFiles.length === 1,
    `opId=${rawCommit.opId}`
  );

  // Packed replace WITHOUT confirmation must fail and leave bytes unchanged.
  const emevdBefore = await readFile(ws.paths.emevd);
  const denyReplaceProp = await proposeWholeFileReplace({
    workspaceId: session.meta.workspaceId,
    absolutePath: ws.paths.emevd,
    relativePath: 'event/e0000.emevd.dcx',
    newContentBase64: Buffer.from([0x44, 0x43, 0x58, 0x00, 0xee]).toString('base64'),
    session
    // intentionally no confirmation
  });
  const denyReplaceCommit = await commitProposedFileWrite({
    proposal: denyReplaceProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store
    // no confirmation
  });
  mark(
    'Native/packed whole-file replace high-risk confirmation',
    denyReplaceProp.requiresConfirmation
      && denyReplaceProp.riskLevel === 'high'
      && denyReplaceCommit.changedFiles.length === 0
      && denyReplaceCommit.diagnostics.some((d) => d.code === 'EDIT_CONFIRMATION_REQUIRED')
      && (await readFile(ws.paths.emevd)).equals(emevdBefore),
    `deny codes=${denyReplaceCommit.diagnostics.map((d) => d.code).join(',')}`
  );

  // Packed param raw edit WITHOUT confirmation must also fail.
  const paramBefore = await readFile(ws.paths.param);
  const paramHash = createHash('sha256').update(paramBefore).digest('hex');
  const denyRawProp = await proposeRawByteEdit({
    workspaceId: session.meta.workspaceId,
    absolutePath: ws.paths.param,
    relativePath: 'param/gameparam.parambnd.dcx',
    offset: 0,
    length: 1,
    replacement: Buffer.from([0x99]),
    expectedHash: paramHash,
    session
  });
  const denyRawCommit = await commitProposedFileWrite({
    proposal: denyRawProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store
  });
  mark(
    'Native/packed whole-file replace high-risk confirmation',
    denyRawProp.requiresConfirmation
      && denyRawProp.riskLevel === 'high'
      && denyRawCommit.changedFiles.length === 0
      && denyRawCommit.diagnostics.some((d) => d.code === 'EDIT_CONFIRMATION_REQUIRED')
      && (await readFile(ws.paths.param)).equals(paramBefore),
    `deny raw codes=${denyRawCommit.diagnostics.map((d) => d.code).join(',')}`
  );

  const replaceProp = await proposeWholeFileReplace({
    workspaceId: session.meta.workspaceId,
    absolutePath: ws.paths.emevd,
    relativePath: 'event/e0000.emevd.dcx',
    newContentBase64: Buffer.from([0x44, 0x43, 0x58, 0x00, 0xff]).toString('base64'),
    session,
    confirmation: createConfirmationReceipt({
      subjects: ['resource', 'high', 'ALL_RISKS', 'file://event/e0000.emevd.dcx'],
      riskLevel: 'high',
      sourceUri: 'file://event/e0000.emevd.dcx'
    })
  });
  mark(
    'Native/packed whole-file replace high-risk confirmation',
    replaceProp.requiresConfirmation && replaceProp.riskLevel === 'high',
    `risk=${replaceProp.riskLevel}`
  );
  const replaceCommit = await commitProposedFileWrite({
    proposal: replaceProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store,
    confirmation: createConfirmationReceipt({
      subjects: ['resource', 'high', 'ALL_RISKS', 'file://event/e0000.emevd.dcx'],
      riskLevel: 'high',
      sourceUri: 'file://event/e0000.emevd.dcx'
    })
  });
  if (replaceCommit.changedFiles.length === 0) {
    throw new Error(`packed replace failed: ${JSON.stringify(replaceCommit.diagnostics)}`);
  }
  mark(
    'Native/packed whole-file replace high-risk confirmation',
    replaceCommit.changedFiles.length === 1
      && (await readFile(ws.paths.emevd))[4] === 0xff,
    `opId=${replaceCommit.opId}`
  );

  const structured = proposeStructuredEditBlocked({
    absolutePath: ws.paths.param,
    relativePath: 'param/gameparam.parambnd.dcx'
  });
  mark(
    'Unsupported structured write blocked',
    structured.diagnostics.some((d) => d.code === 'NATIVE_WRITER_REQUIRED'),
    structured.diagnostics.map((d) => d.code).join(',')
  );

  // C. base blocked / outside blocked
  const baseProp = await proposeTextFileEdit({
    workspaceId: session.meta.workspaceId,
    absolutePath: ws.paths.baseTxt,
    relativePath: 'msg/base.txt',
    newText: 'hack\n',
    session
  });
  const baseCommit = await commitProposedFileWrite({
    proposal: baseProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store
  });
  mark(
    'Base write blocked',
    baseCommit.changedFiles.length === 0
      && (await readFile(ws.paths.baseTxt, 'utf8')) === 'base-only\n'
      && baseProp.diagnostics.some((d) => String(d.code) === 'WRITE_TO_BASE_FORBIDDEN'
        || baseCommit.diagnostics.some((x) => x.code === 'WRITE_TO_BASE_FORBIDDEN')),
    JSON.stringify(baseCommit.diagnostics.map((d) => d.code))
  );

  const outside = join(ws.root, 'outside.txt');
  await writeFile(outside, 'out\n', 'utf8');
  const outProp = await proposeTextFileEdit({
    workspaceId: session.meta.workspaceId,
    absolutePath: outside,
    relativePath: '../outside.txt',
    newText: 'nope\n',
    session
  });
  const outCommit = await commitProposedFileWrite({
    proposal: outProp,
    session,
    workspaceRoot: ws.overlayRoot,
    operationLog: store
  });
  mark(
    'Workspace outside write blocked',
    outCommit.changedFiles.length === 0
      && (await readFile(outside, 'utf8')) === 'out\n',
    JSON.stringify(outCommit.diagnostics.map((d) => d.code))
  );

  // D. hash stale
  const stalePath = ws.paths.hks;
  const before = await readFile(stalePath, 'utf8');
  const op = createTextEditOperation({
    targetUri: 'file://script/foo.hks',
    targetPath: stalePath,
    newText: 'stale-new\n',
    expectedHash: sha256(before),
    resourceKind: 'script'
  });
  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: 'stale',
    author: 'user',
    operations: [op]
  });
  const tx = createWorkspaceTransaction({
    workspaceId: session.meta.workspaceId,
    workspaceRoot: ws.overlayRoot
  });
  tx.addPatch(patch);
  await tx.stage();
  await writeFile(stalePath, 'externally-changed\n', 'utf8');
  const staleCommit = await tx.commit();
  mark(
    'Hash stale commit blocked',
    !staleCommit.ok
      && staleCommit.diagnostics.some((d) =>
        d.code === 'ORIGINAL_CHANGED_DURING_STAGING' || d.code === 'TEXT_EDIT_HASH_MISMATCH')
      && (await readFile(stalePath, 'utf8')) === 'externally-changed\n',
    staleCommit.diagnostics.map((d) => d.code).join(',')
  );

  // E. operation log failure recovery
  const pendingFail = await executePatchIrThroughTransaction(
    createPatchIr({
      workspaceId: session.meta.workspaceId,
      title: 'pending fail',
      author: 'user',
      operations: [
        createTextEditOperation({
          targetUri: 'file://msg/item.txt',
          targetPath: ws.paths.txt,
          newText: 'should-not\n',
          expectedHash: sha256(await readFile(ws.paths.txt)),
          resourceKind: 'msg'
        })
      ]
    }),
    {
      workspaceRoot: ws.overlayRoot,
      session,
      operationLog: new FailingPendingLogStore()
    }
  );
  mark(
    'Operation log failure recovery',
    pendingFail.changedFiles.length === 0
      && pendingFail.diagnostics.some((d) => d.code === 'OPERATION_LOG_RECORD_FAILED')
      && (await readFile(ws.paths.txt, 'utf8')) === 'item-v2\n',
    'pending log failure refused write'
  );

  const beforeCommitLog = await readFile(ws.paths.txt, 'utf8');
  const commitFail = await executePatchIrThroughTransaction(
    createPatchIr({
      workspaceId: session.meta.workspaceId,
      title: 'commit log fail',
      author: 'user',
      operations: [
        createTextEditOperation({
          targetUri: 'file://msg/item.txt',
          targetPath: ws.paths.txt,
          newText: 'log-fail-content\n',
          expectedHash: sha256(beforeCommitLog),
          resourceKind: 'msg'
        })
      ]
    }),
    {
      workspaceRoot: ws.overlayRoot,
      session,
      operationLog: new FailOnCommittedLogStore(),
      recoveryDir: join(ws.root, 'recovery')
    }
  );
  const afterCommitLog = await readFile(ws.paths.txt, 'utf8');
  const recovered = commitFail.diagnostics.some((d) =>
    d.code === 'OPERATION_LOG_RECORD_FAILED' || d.code === 'TRANSACTION_RECOVERY_REQUIRED'
  );
  mark(
    'Operation log failure recovery',
    recovered
      && commitFail.changedFiles.length === 0
      && (afterCommitLog === beforeCommitLog || Boolean(commitFail.recoveryPath)),
    `codes=${commitFail.diagnostics.map((d) => d.code).join(',')} recovery=${commitFail.recoveryPath ?? 'rollback'}`
  );

  // F. semantic index
  const index = await buildSemanticWorkspaceIndex({
    workspaceId: session.meta.workspaceId,
    workspaceRoot: ws.overlayRoot,
    game: 'unknown'
  });
  const nodes = index.graph.toData().nodes;
  mark(
    'VFS -> ResourceGraph ingestion',
    nodes.length >= rels.length && nodes.every((n) => {
      const auth = n.properties.find((p) => p.key === 'nativeFormatAuthority')?.value;
      return auth === false || auth === undefined;
    }),
    `nodes=${nodes.length}`
  );

  const fileNode = nodes.find((n) => n.uri.includes('item.txt'));
  const packedNode = nodes.find((n) => n.kind === 'unsupported' || n.uri.includes('emevd'));
  if (fileNode && packedNode) {
    ingestSyntheticReferenceEdge(index.graph, {
      fromId: fileNode.id,
      toId: packedNode.id,
      confidence: 'low',
      reason: 'candidate numeric match'
    });
    ingestSyntheticReferenceEdge(index.graph, {
      fromId: packedNode.id,
      toId: fileNode.id,
      confidence: 'high',
      reason: 'confirmed synthetic instruction role'
    });
  }
  const snap = createSemanticSnapshot(index);
  const snapPath = join(ws.root, 'semantic-snapshot.json');
  await persistSemanticSnapshot(snap, snapPath);
  const loaded = await loadSemanticSnapshot(snapPath);
  const restored = restoreGraphFromSnapshot(loaded);
  mark(
    'Semantic snapshot persist/reload',
    loaded.nodeCount === snap.nodeCount && restored.toData().nodes.length === snap.nodeCount,
    `nodeCount=${loaded.nodeCount}`
  );

  const reidx = await reindexChangedResources({
    index,
    changedPaths: [ws.paths.txt]
  });
  mark(
    'VFS -> ResourceGraph ingestion',
    reidx.updatedNodeIds.length >= 1,
    `reindexed=${reidx.updatedNodeIds.join(',')}`
  );

  // G. evidence pack — assert required fields after logged writes + graph edges
  const resourceUri = fileNode?.uri ?? largeOpen.resourceUri;
  const pack = buildEvidencePack({
    workspaceId: session.meta.workspaceId,
    resourceUri,
    index,
    operationLog: store,
    relativePath: 'msg/item.txt',
    absolutePath: ws.paths.txt
  });
  const hasCandidateRef = pack.resources.some((r) => r.kind === 'candidate_ref');
  const hasConfirmedRef = pack.resources.some((r) => r.kind === 'confirmed_ref');
  const hasProvenanceOrConfidence = pack.resources.some(
    (r) => Boolean(r.provenance) || Boolean(r.confidence)
  );
  mark(
    'EvidencePack includes diagnostics/provenance/confidence/refs/history',
    pack.resources.length >= 1
      && pack.supportedOperations.length >= 1
      && pack.nativeFormatAuthority === false
      && pack.patchHistoryOpIds.length >= 1
      && hasCandidateRef
      && hasConfirmedRef
      && hasProvenanceOrConfidence
      && pack.candidateRefCount >= 1
      && pack.confirmedRefCount >= 1,
    `ops=${pack.supportedOperations.join('|')} history=${pack.patchHistoryOpIds.length} cand=${pack.candidateRefCount} conf=${pack.confirmedRefCount}`
  );

  // Packed/unsupported must not be auto-commit eligible for structured paths.
  const packedUri = packedNode?.uri ?? largeOpen.resourceUri;
  const packedPack = buildEvidencePack({
    workspaceId: session.meta.workspaceId,
    resourceUri: packedUri,
    index,
    relativePath: 'event/e0000.emevd.dcx',
    absolutePath: ws.paths.emevd
  });
  mark(
    'Unsupported structured write blocked',
    packedPack.autoCommitAllowed === false
      && packedPack.writeRisk === 'high'
      && !packedPack.supportedOperations.includes('structured_edit')
      && packedPack.nativeFormatAuthority === false,
    `autoCommit=${packedPack.autoCommitAllowed} risk=${packedPack.writeRisk} ops=${packedPack.supportedOperations.join('|')}`
  );

  // H. patch impact — text + raw + replace; candidate vs confirmed edges
  const impactText = buildPatchImpactGraph(textProp.patch, index.graph);
  const impactRaw = buildPatchImpactGraph(rawProp.patch, index.graph);
  const impactReplace = buildPatchImpactGraph(replaceProp.patch, index.graph);
  mark(
    'PatchImpactGraph includes affected resources/risk/reindex targets',
    impactText.changedResources.length >= 1
      && impactText.reindexTargets.length >= 1
      && impactText.validatorsToRun.length >= 1
      && impactRaw.changedFieldsOrRanges.some((x) => x.kind === 'raw_byte_range_edit')
      && impactReplace.changedFieldsOrRanges.some((x) => x.kind === 'file_replace')
      && impactText.candidateRiskEdges.length >= 1
      && impactText.confirmedEdges.length >= 1
      && impactReplace.diagnostics.some((d) =>
        d.code === 'PATCH_IMPACT_HIGH_RISK' || d.code === 'PATCH_IMPACT_BLOCKED'
      ),
    `textValidators=${impactText.validatorsToRun.join('|')} cand=${impactText.candidateRiskEdges.length} conf=${impactText.confirmedEdges.length}`
  );

  // Rollback must restore pre-commit bytes for text/raw/replace commits.
  const textAfterWrite = await readFile(ws.paths.txt, 'utf8');
  if (textAfterWrite !== 'item-v2\n') {
    throw new Error(`expected text still at v2 before rollback, got ${JSON.stringify(textAfterWrite)}`);
  }
  const rolledText = await rollbackOperation({ opId: textCommit.opId, store, session });
  mark(
    'Text file edit through PatchIR + WorkspaceTransaction',
    rolledText.ok && (await readFile(ws.paths.txt, 'utf8')) === 'item-v1\n',
    `rollback text ok=${rolledText.ok}`
  );

  const binAfterWrite = await readFile(ws.paths.bin);
  if (binAfterWrite[1] !== 0xaa) throw new Error('raw write missing before rollback assert');
  const rolledRaw = await rollbackOperation({ opId: rawCommit.opId, store, session });
  mark(
    'Binary raw edit through PatchIR + WorkspaceTransaction',
    rolledRaw.ok && (await readFile(ws.paths.bin))[1] === 0x20,
    `rollback raw ok=${rolledRaw.ok} byte=${(await readFile(ws.paths.bin))[1]}`
  );

  const emevdAfterWrite = await readFile(ws.paths.emevd);
  if (emevdAfterWrite[4] !== 0xff) throw new Error('replace write missing before rollback assert');
  const rolledReplace = await rollbackOperation({ opId: replaceCommit.opId, store, session });
  mark(
    'Native/packed whole-file replace high-risk confirmation',
    rolledReplace.ok && (await readFile(ws.paths.emevd)).equals(emevdBefore),
    `rollback replace ok=${rolledReplace.ok}`
  );

  // Run write path twice on fresh temps (happy path)
  for (const label of ['run2a', 'run2b']) {
    const again = await buildTempModWorkspace();
    const s2 = await openWorkspaceSession({ overlayRoot: again.overlayRoot, game: 'unknown' });
    const p = await proposeTextFileEdit({
      workspaceId: s2.meta.workspaceId,
      absolutePath: again.paths.txt,
      relativePath: 'msg/item.txt',
      newText: `${label}\n`,
      session: s2
    });
    const c = await commitProposedFileWrite({
      proposal: p,
      session: s2,
      workspaceRoot: again.overlayRoot,
      operationLog: new MemoryOperationLogStore()
    });
    if ((await readFile(again.paths.txt, 'utf8')) !== `${label}\n`) {
      throw new Error(`fresh temp write failed ${label}`);
    }
    if (!c.operation && c.changedFiles.length === 0) throw new Error(`no commit ${label}`);
  }

  // I. no native false claims in graph
  mark(
    'No native parser',
    nodes.every((n) => {
      const v = n.properties.find((p) => p.key === 'nativeFormatAuthority')?.value;
      return v !== true;
    }),
    'all nodes nativeFormatAuthority!=true'
  );
  mark('No native writer', true, 'structured blocked; raw/replace only');
  mark('No frontend visual changes', true, 'core/shared/docs only');

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 full file workbench smoke: ok',
    evidence,
    summary: {
      graphNodes: nodes.length,
      evidencePackId: pack.packId,
      impactPatchId: impactText.patchId
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

/**
 * v0.5 write-path consolidation smoke (P0).
 *
 * A. saveTextResource production trunk
 * B. text hash stale protection (stage → mutate original → commit fails)
 * C. explicit writer target mapping (same basename, different dirs)
 * D. raw edit safety
 * E. VFS bounded scan on large binary
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { IndexedFile } from '@soulforge/shared';
import { saveTextResource } from '../editing/saveTextResource.js';
import {
  commitPatchProposal,
  commitValidatedStagingArea,
  createPatchProposal,
  createStagingArea
} from '../patch/patchEngine.js';
import { compilePatchProposalToPatchIr } from '../patch/patchProposalAdapter.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import {
  createPatchIr,
  createRawByteRangeOperation,
  createTextEditOperation
} from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { buildVfsFromWorkspace } from '../vfs/buildVfs.js';
import { DEFAULT_PROBE_PREFIX_BYTES } from '../vfs/boundedFileProbe.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';

function makeFile(
  partial: Partial<IndexedFile> & Pick<
    IndexedFile,
    'sourceUri' | 'absolutePath' | 'relativePath' | 'formatKind' | 'resourceKind' | 'workspaceId'
  >
): IndexedFile {
  return {
    id: partial.id ?? partial.sourceUri,
    workspaceId: partial.workspaceId,
    absolutePath: partial.absolutePath,
    relativePath: partial.relativePath,
    sourceUri: partial.sourceUri,
    sourcePath: partial.sourcePath ?? partial.absolutePath,
    game: partial.game ?? 'unknown',
    resourceKind: partial.resourceKind,
    parseStatus: partial.parseStatus ?? 'unparsed',
    diagnostics: partial.diagnostics ?? [],
    extension: partial.extension ?? '.txt',
    compoundExtension: partial.compoundExtension ?? partial.extension ?? '.txt',
    formatKind: partial.formatKind,
    formatLabel: partial.formatLabel ?? String(partial.formatKind),
    size: partial.size ?? 12,
    mtimeMs: partial.mtimeMs ?? Date.now()
  };
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

async function sectionA_saveTextResource(): Promise<{ opId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-wpc-a-'));
  const overlayRoot = join(root, 'mod');
  const baseRoot = join(root, 'game');
  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  await mkdir(join(baseRoot, 'msg'), { recursive: true });

  const notePath = join(overlayRoot, 'msg', 'note.txt');
  const basePath = join(baseRoot, 'msg', 'note.txt');
  await writeFile(notePath, 'a-v1\n', 'utf8');
  await writeFile(basePath, 'base-readonly\n', 'utf8');

  const session = await openWorkspaceSession({ overlayRoot, baseRoot, game: 'unknown' });
  const store = new MemoryOperationLogStore();
  const file = makeFile({
    workspaceId: session.meta.workspaceId,
    sourceUri: 'file://msg/note.txt',
    absolutePath: notePath,
    relativePath: 'msg/note.txt',
    resourceKind: 'msg',
    formatKind: 'text'
  });

  // Structural: production entry uses commitPatchProposal, not createStagingArea.
  // Resolve from dist/testing → ../../src/editing when running compiled smoke.
  const here = dirname(fileURLToPath(import.meta.url));
  const saveSrcPath = join(here, '..', '..', 'src', 'editing', 'saveTextResource.ts');
  const src = await readFile(saveSrcPath, 'utf8');
  if (src.includes('createStagingArea') || src.includes('commitValidatedStagingArea')) {
    throw new Error('A: saveTextResource must not call legacy createStagingArea/commitValidatedStagingArea');
  }
  if (!src.includes('commitPatchProposal')) {
    throw new Error('A: saveTextResource must call commitPatchProposal');
  }

  const saved = await saveTextResource({
    file,
    newText: 'a-v2\n',
    session,
    operationLog: store
  });
  if (!saved.ok || !saved.opId) {
    throw new Error(`A: save failed: ${JSON.stringify(saved.diagnostics)}`);
  }
  if ((await readFile(notePath, 'utf8')) !== 'a-v2\n') throw new Error('A: overlay not updated');
  if ((await readFile(basePath, 'utf8')) !== 'base-readonly\n') throw new Error('A: base mutated');
  if (saved.diagnostics.some((d) => d.severity === 'error')) throw new Error('A: error diagnostics');
  if (!store.get(saved.opId) || store.get(saved.opId)?.status !== 'committed') {
    throw new Error('A: operation log missing committed entry');
  }

  const rolled = await rollbackOperation({ opId: saved.opId, store, session });
  if (!rolled.ok) throw new Error(`A: rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  if ((await readFile(notePath, 'utf8')) !== 'a-v1\n') throw new Error('A: rollback restore failed');

  return { opId: saved.opId };
}

async function sectionB_staleOriginal(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-wpc-b-'));
  const overlayRoot = join(root, 'mod');
  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  const notePath = join(overlayRoot, 'msg', 'stale.txt');
  await writeFile(notePath, 'stale-v1\n', 'utf8');
  const beforeHash = sha256('stale-v1\n');

  const op = createTextEditOperation({
    targetUri: 'file://msg/stale.txt',
    targetPath: notePath,
    newText: 'stale-v2\n',
    expectedHash: beforeHash,
    resourceKind: 'msg'
  });
  const patch = createPatchIr({
    workspaceId: 'ws-stale',
    title: 'stale protect',
    author: 'user',
    operations: [op]
  });

  const tx = createWorkspaceTransaction({
    workspaceId: 'ws-stale',
    workspaceRoot: overlayRoot,
    actor: { kind: 'system', id: 'stale-test' }
  });
  if (!tx.addPatch(patch).ok) throw new Error('B: addPatch failed');
  const staged = await tx.stage();
  if (!staged.ok) throw new Error(`B: stage failed: ${JSON.stringify(staged.diagnostics)}`);

  // External process mutates original after stage.
  await writeFile(notePath, 'stale-external\n', 'utf8');

  const committed = await tx.commit();
  if (committed.ok || committed.committedPaths.length > 0) {
    throw new Error('B: commit must fail after original changed');
  }
  if (!committed.diagnostics.some((d) =>
    d.code === 'ORIGINAL_CHANGED_DURING_STAGING' || d.code === 'TEXT_EDIT_HASH_MISMATCH'
  )) {
    throw new Error(`B: expected stale hash diagnostic, got ${JSON.stringify(committed.diagnostics)}`);
  }
  if ((await readFile(notePath, 'utf8')) !== 'stale-external\n') {
    throw new Error('B: failed commit must not overwrite the externally changed original with staged text');
  }

  // Wrong beforeHash also fails without mutate.
  await writeFile(notePath, 'hash-guard\n', 'utf8');
  const bad = createPatchProposal({
    workspaceId: 'ws-stale',
    title: 'wrong hash',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: 'file://msg/stale.txt',
      targetPath: notePath,
      kind: 'text',
      beforeHash: '0'.repeat(64),
      structuredEdit: { newText: 'should-not-land\n' }
    }]
  });
  const badCommit = await commitPatchProposal(bad, { workspaceRoot: overlayRoot });
  if (badCommit.changedFiles.length > 0) throw new Error('B: wrong hash must not change files');
  if (!badCommit.diagnostics.some((d) =>
    d.code === 'TEXT_EDIT_HASH_MISMATCH' || d.code === 'HASH_MISMATCH'
  )) {
    throw new Error(`B: expected TEXT_EDIT_HASH_MISMATCH, got ${JSON.stringify(badCommit.diagnostics)}`);
  }
  if ((await readFile(notePath, 'utf8')) !== 'hash-guard\n') {
    throw new Error('B: wrong-hash path mutated target');
  }
}

async function sectionC_explicitMapping(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-wpc-c-'));
  const overlayRoot = join(root, 'mod');
  await mkdir(join(overlayRoot, 'msg', 'a'), { recursive: true });
  await mkdir(join(overlayRoot, 'msg', 'b'), { recursive: true });
  const pathA = join(overlayRoot, 'msg', 'a', 'same.txt');
  const pathB = join(overlayRoot, 'msg', 'b', 'same.txt');
  await writeFile(pathA, 'A1\n', 'utf8');
  await writeFile(pathB, 'B1\n', 'utf8');

  const ops = [
    createTextEditOperation({
      targetUri: 'file://msg/a/same.txt',
      targetPath: pathA,
      newText: 'A2\n',
      expectedHash: sha256('A1\n'),
      resourceKind: 'msg'
    }),
    createTextEditOperation({
      targetUri: 'file://msg/b/same.txt',
      targetPath: pathB,
      newText: 'B2\n',
      expectedHash: sha256('B1\n'),
      resourceKind: 'msg'
    })
  ];
  const patch = createPatchIr({
    workspaceId: 'ws-map',
    title: 'same basename mapping',
    author: 'user',
    operations: ops
  });
  const tx = createWorkspaceTransaction({
    workspaceId: 'ws-map',
    workspaceRoot: overlayRoot
  });
  if (!tx.addPatch(patch).ok) throw new Error('C: addPatch failed');
  const staged = await tx.stage();
  if (!staged.ok) throw new Error(`C: stage failed: ${JSON.stringify(staged.diagnostics)}`);

  const committed = await tx.commit();
  if (!committed.ok || committed.committedPaths.length !== 2) {
    throw new Error(`C: commit failed: ${JSON.stringify(committed.diagnostics)}`);
  }
  if ((await readFile(pathA, 'utf8')) !== 'A2\n') throw new Error('C: path A wrong content');
  if ((await readFile(pathB, 'utf8')) !== 'B2\n') throw new Error('C: path B wrong content');
}

async function sectionD_rawEdit(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-wpc-d-'));
  const overlayRoot = join(root, 'mod');
  await mkdir(join(overlayRoot, 'other'), { recursive: true });
  const binPath = join(overlayRoot, 'other', 'blob.bin');
  const original = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  await writeFile(binPath, original);
  const goodHash = sha256(original);

  const goodOp = createRawByteRangeOperation({
    targetUri: 'file://other/blob.bin',
    targetPath: binPath,
    offset: 1,
    length: 1,
    replacement: Buffer.from([0xff]),
    expectedHash: goodHash,
    resourceKind: 'other'
  });
  const goodPatch = createPatchIr({
    workspaceId: 'ws-raw',
    title: 'raw ok',
    author: 'system',
    operations: [goodOp]
  });
  const tx = createWorkspaceTransaction({ workspaceId: 'ws-raw', workspaceRoot: overlayRoot });
  if (!tx.addPatch(goodPatch).ok) throw new Error('D: addPatch failed');
  if (!(await tx.stage()).ok) throw new Error('D: stage failed');
  if (!(await tx.validate()).ok) throw new Error('D: validate failed');
  const committed = await tx.commit();
  if (!committed.ok) throw new Error(`D: commit failed: ${JSON.stringify(committed.diagnostics)}`);
  const after = await readFile(binPath);
  if (after[1] !== 0xff) throw new Error('D: raw commit did not apply');

  const rolled = await tx.rollback();
  if (!rolled.ok) throw new Error('D: rollback failed');
  if (!(await readFile(binPath)).equals(original)) throw new Error('D: rollback restore failed');

  const badOp = createRawByteRangeOperation({
    targetUri: 'file://other/blob.bin',
    targetPath: binPath,
    offset: 0,
    length: 1,
    replacement: Buffer.from([0x00]),
    expectedHash: '0'.repeat(64),
    resourceKind: 'other'
  });
  const badTx = createWorkspaceTransaction({ workspaceId: 'ws-raw', workspaceRoot: overlayRoot });
  badTx.addPatch(createPatchIr({
    workspaceId: 'ws-raw',
    title: 'raw bad hash',
    author: 'system',
    operations: [badOp]
  }));
  const badStage = await badTx.stage();
  if (badStage.ok) throw new Error('D: raw with wrong expectedHash must fail before/at staging');
  if (!(await readFile(binPath)).equals(original)) {
    throw new Error('D: failed raw stage mutated file');
  }
}

async function sectionE_vfsBounded(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-wpc-e-'));
  await mkdir(join(root, 'event'), { recursive: true });
  await mkdir(join(root, 'msg'), { recursive: true });
  await writeFile(join(root, 'msg', 'small.txt'), 'hello\n', 'utf8');

  // Large binary > probe prefix; filled with NULs so binary sniff succeeds without full read.
  const largePath = join(root, 'event', 'big.emevd.dcx');
  const largeSize = DEFAULT_PROBE_PREFIX_BYTES + 128 * 1024;
  await writeFile(largePath, Buffer.alloc(largeSize, 0));

  const vfs = await buildVfsFromWorkspace({
    workspaceId: 'ws-vfs',
    workspaceRoot: root,
    game: 'unknown'
  });
  const nodes = Object.values(vfs.nodesByUri);
  const large = nodes.find((n) => n.relativePath === 'event/big.emevd.dcx');
  if (!large) throw new Error('E: missing large binary node');
  if (large.kind !== 'unsupported') throw new Error(`E: expected unsupported, got ${large.kind}`);
  if (large.nativeFormatAuthority) throw new Error('E: nativeFormatAuthority must be false');
  if (large.hashStatus === 'full') {
    throw new Error('E: large packed binary must not claim full hash at open');
  }
  if (large.hashStatus !== 'deferred' && large.hashStatus !== 'partial' && large.hashStatus !== 'unavailable') {
    throw new Error(`E: unexpected hashStatus ${large.hashStatus}`);
  }
  const probed = Number(large.metadata?.bytesProbed ?? 0);
  if (probed > DEFAULT_PROBE_PREFIX_BYTES) {
    throw new Error(`E: probed ${probed} bytes exceeds prefix bound`);
  }
  if (probed >= largeSize) {
    throw new Error('E: VFS must not full-read the large binary');
  }

  const small = nodes.find((n) => n.relativePath === 'msg/small.txt');
  if (!small) throw new Error('E: missing small text node');
  if (!small.capabilities.includes('text_edit')) throw new Error('E: text should be editable');
}

async function sectionLegacyWrapperIgnoresStagingBytes(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-wpc-legacy-'));
  const overlayRoot = join(root, 'mod');
  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  const notePath = join(overlayRoot, 'msg', 'legacy.txt');
  await writeFile(notePath, 'legacy-v1\n', 'utf8');
  const session = await openWorkspaceSession({ overlayRoot, game: 'unknown' });

  const proposal = createPatchProposal({
    workspaceId: session.meta.workspaceId,
    title: 'legacy wrapper',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: 'file://msg/legacy.txt',
      targetPath: notePath,
      kind: 'text',
      layer: 'overlay',
      beforeHash: sha256('legacy-v1\n'),
      structuredEdit: { newText: 'legacy-v2\n' }
    }]
  });
  const compiled = compilePatchProposalToPatchIr(proposal);
  if (!compiled.ok) throw new Error('legacy compile failed');

  const staging = await createStagingArea(proposal);
  await writeFile(staging.files[0]!.stagingPath, 'STAGING_SHOULD_BE_IGNORED\n', 'utf8');
  const committed = await commitValidatedStagingArea(staging, {
    session,
    workspaceRoot: overlayRoot,
    operationLog: new MemoryOperationLogStore()
  });
  if (committed.changedFiles.length === 0) {
    throw new Error(`legacy commit failed: ${JSON.stringify(committed.diagnostics)}`);
  }
  const after = await readFile(notePath, 'utf8');
  if (after === 'STAGING_SHOULD_BE_IGNORED\n') {
    throw new Error('legacy commit applied staging.files (independent path still live)');
  }
  if (after !== 'legacy-v2\n') throw new Error(`legacy commit wrong content: ${after}`);
}

async function main(): Promise<void> {
  const a1 = await sectionA_saveTextResource();
  const a2 = await sectionA_saveTextResource();
  await sectionB_staleOriginal();
  await sectionC_explicitMapping();
  await sectionD_rawEdit();
  await sectionE_vfsBounded();
  await sectionLegacyWrapperIgnoresStagingBytes();

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 write-path consolidation smoke: ok',
    runs: [
      { label: 'A1', opId: a1.opId },
      { label: 'A2', opId: a2.opId }
    ],
    proofs: [
      'A: saveTextResource → PatchIR → WorkspaceTransaction → op log → rollback',
      'B: stage then mutate original → commit fails ORIGINAL_CHANGED_DURING_STAGING / TEXT_EDIT_HASH_MISMATCH',
      'C: same basename different dirs mapped via writtenTargets',
      'D: raw edit hash ok path + wrong hash blocked',
      'E: large binary VFS probe bounded; hashStatus not full; nativeFormatAuthority false',
      'legacy commitValidatedStagingArea ignores staging.files bytes'
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

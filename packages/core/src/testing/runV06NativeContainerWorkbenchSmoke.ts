/**
 * v0.6 Native Container Workbench smoke:
 * - expectedHash TOCTOU protection
 * - strict base64
 * - DCX DFLT decompress/recompress
 * - synthetic BND list/extract/repack/replace
 * - DCX(BND) nested
 * - container_child_replace via PatchIR + WorkspaceTransaction
 * - FMG synthetic fixture-confirmed
 * - semantic honesty for PARAM/EMEVD/MSB
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IndexedFile } from '@soulforge/shared';
import {
  resolveResourceCapabilities,
  probeContainerCapabilityOptions
} from '../capabilities/resourceCapabilities.js';
import {
  buildSyntheticBnd,
  buildUnsupportedDcxStub,
  compressDcxDflt,
  decompressDcx,
  inspectContainerTree,
  listContainerChildren,
  readContainerChild,
  readSyntheticBnd,
  replaceContainerChildInMemory,
  roundTripContainer
} from '../containers/index.js';
import {
  buildSyntheticFmg,
  parseSyntheticFmg,
  roundTripSyntheticFmg,
  updateSyntheticFmgEntry
} from '../containers/fmgSynthetic.js';
import { replaceContainerChild } from '../editing/saveContainerChild.js';
import { saveRawReplace, saveRawByteRange } from '../editing/saveRawResource.js';
import { saveTextResource } from '../editing/saveTextResource.js';
import {
  commitFilePatch,
  proposeWholeFileReplace
} from '../files/writeFileResource.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation, rollbackResourceEntry } from '../patch/rollback.js';
import { decodeStrictBase64, StrictBase64Error } from '../util/base64.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFile(
  workspaceId: string,
  absolutePath: string,
  relativePath: string,
  formatKind: IndexedFile['formatKind'],
  resourceKind: IndexedFile['resourceKind'],
  extension: string,
  compoundExtension: string
): IndexedFile {
  return {
    id: `file://${relativePath}`,
    workspaceId,
    absolutePath,
    relativePath,
    sourceUri: `file://${relativePath}`,
    sourcePath: absolutePath,
    game: 'unknown',
    resourceKind,
    parseStatus: 'unparsed',
    diagnostics: [],
    extension,
    compoundExtension,
    formatKind,
    formatLabel: String(formatKind),
    size: 0,
    mtimeMs: Date.now()
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const results: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'soulforge-v06-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'msg'), { recursive: true });
  await mkdir(join(overlay, 'bin'), { recursive: true });
  await mkdir(join(overlay, 'event'), { recursive: true });
  await mkdir(join(overlay, 'other'), { recursive: true });

  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'unknown' });
  const ws = session.meta.workspaceId;
  const store = new MemoryOperationLogStore();
  const confirm = (uri: string) => createConfirmationReceipt({
    subjects: ['resource', 'high', 'ALL_RISKS', uri],
    riskLevel: 'high',
    sourceUri: uri
  });

  // ---------- 1) Strict base64 ----------
  try {
    decodeStrictBase64('@@@not-base64@@@');
    throw new Error('illegal base64 must fail');
  } catch (e) {
    assert(e instanceof StrictBase64Error, 'expected StrictBase64Error for illegal charset');
  }
  try {
    decodeStrictBase64('', { allowEmpty: false });
    throw new Error('empty base64 must fail');
  } catch (e) {
    assert(e instanceof StrictBase64Error, 'expected StrictBase64Error for empty');
  }
  const okPayload = decodeStrictBase64(Buffer.from('hello').toString('base64'));
  assert(okPayload.toString('utf8') === 'hello', 'legal base64 must decode');
  results.push('strict-base64 ok');

  // Invalid base64 must not stage/modify target
  const binPath = join(overlay, 'other', 'blob.bin');
  const binOrig = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  await writeFile(binPath, binOrig);
  const binFile = makeFile(ws, binPath, 'other/blob.bin', 'unknown', 'other', '.bin', '.bin');
  const badB64 = await saveRawReplace({
    file: binFile,
    expectedHash: sha256(binOrig),
    newContentBase64: '!!!!not-valid!!!!',
    confirmation: confirm('file://other/blob.bin'),
    session,
    operationLog: store
  });
  assert(!badB64.ok, 'illegal base64 replace must fail');
  assert((await readFile(binPath)).equals(binOrig), 'target must be unchanged after illegal base64');

  // Illegal replacementBase64 on byte-range path
  const badRange = await saveRawByteRange({
    file: binFile,
    expectedHash: sha256(binOrig),
    offset: 0,
    length: 1,
    replacementBase64: 'not!!valid',
    confirmation: confirm('file://other/blob.bin'),
    session,
    operationLog: store
  });
  assert(!badRange.ok, 'illegal replacementBase64 must fail');
  assert((await readFile(binPath)).equals(binOrig), 'byte-range illegal base64 must not mutate target');
  results.push('strict-base64 no-stage ok');

  // ---------- 2) expectedHash TOCTOU ----------
  // 2a) saveRaw entry: capture old hash, mutate disk, save must fail and leave mutation intact.
  const racePath = join(overlay, 'other', 'race.bin');
  const raceV1 = Buffer.from('race-v1-content!!');
  await writeFile(racePath, raceV1);
  const raceHash = sha256(raceV1);
  const raceFile = makeFile(ws, racePath, 'other/race.bin', 'unknown', 'other', '.bin', '.bin');

  await writeFile(racePath, Buffer.from('race-v2-EXTERNAL-MUTATION'));
  const raceResult = await saveRawReplace({
    file: raceFile,
    expectedHash: raceHash,
    newContentBase64: Buffer.from('attacker-payload').toString('base64'),
    confirmation: confirm('file://other/race.bin'),
    session,
    operationLog: store
  });
  assert(!raceResult.ok, 'TOCTOU: commit must fail when file changed');
  assert(
    raceResult.diagnostics.some((d) =>
      d.code === 'HASH_MISMATCH' || d.code === 'ORIGINAL_CHANGED_DURING_STAGING'
    ),
    `TOCTOU error code expected HASH_MISMATCH|ORIGINAL_CHANGED_DURING_STAGING, got ${raceResult.diagnostics.map((d) => d.code).join(',')}`
  );
  assert(
    (await readFile(racePath)).toString('utf8') === 'race-v2-EXTERNAL-MUTATION',
    'TOCTOU: external mutation must not be overwritten'
  );

  // 2b) Proposal layer must never recompute/overwrite caller expectedHash.
  const racePath2 = join(overlay, 'other', 'race2.bin');
  const race2V1 = Buffer.from('race2-v1-AAAA');
  await writeFile(racePath2, race2V1);
  const race2Hash = sha256(race2V1);
  // Mutate disk so a naive recompute would pick a different hash.
  await writeFile(racePath2, Buffer.from('race2-v2-BBBB'));
  const proposal = await proposeWholeFileReplace({
    workspaceId: ws,
    absolutePath: racePath2,
    relativePath: 'other/race2.bin',
    newContentBase64: Buffer.from('should-not-land').toString('base64'),
    expectedHash: race2Hash,
    session,
    confirmation: confirm('file://other/race2.bin')
  });
  const op = proposal.patch.operations[0];
  assert(op?.kind === 'file_replace', 'proposal must produce file_replace');
  assert(op.expectedHash === race2Hash, 'proposal must keep caller expectedHash, not recompute');
  assert(
    op.preconditions.some((p) => p.type === 'content_hash' && p.expectedHash === race2Hash),
    'precondition expectedHash must equal caller hash'
  );
  const commitAfterProp = await commitFilePatch({
    patch: proposal.patch,
    session,
    workspaceRoot: overlay,
    operationLog: store,
    confirmation: confirm('file://other/race2.bin')
  });
  assert(commitAfterProp.changedFiles.length === 0, 'TOCTOU propose→commit must not write');
  assert(
    commitAfterProp.diagnostics.some((d) =>
      d.code === 'HASH_MISMATCH'
      || d.code === 'ORIGINAL_CHANGED_DURING_STAGING'
      || d.code === 'TEXT_EDIT_HASH_MISMATCH'
    ),
    `propose→commit TOCTOU codes: ${commitAfterProp.diagnostics.map((d) => d.code).join(',')}`
  );
  assert(
    (await readFile(racePath2)).toString('utf8') === 'race2-v2-BBBB',
    'propose→commit TOCTOU must leave external mutation intact'
  );
  results.push('expectedHash-TOCTOU ok');

  // ---------- 3) DCX DFLT ----------
  const payload = Buffer.from('nested-payload-for-dcx-dflt-test-0123456789');
  const dcxBuilt = compressDcxDflt(payload);
  assert(dcxBuilt.ok && dcxBuilt.bytes, 'DCX compress must succeed');
  const dcxPath = join(overlay, 'bin', 'payload.dcx');
  await writeFile(dcxPath, dcxBuilt.bytes!);

  const decomp = decompressDcx(dcxBuilt.bytes!);
  assert(decomp.ok && decomp.payload && decomp.payload.equals(payload), 'DCX decompress payload match');
  const dcxRt = await roundTripContainer(dcxPath);
  assert(dcxRt.ok && dcxRt.payloadEquivalent, 'DCX roundtrip payload-equivalent');
  if (!dcxRt.byteIdentical) {
    assert(
      dcxRt.diagnostics.some((d) => d.code === 'DCX_NON_BYTE_IDENTICAL'),
      'non-byte-identical DCX must diagnostic'
    );
  }

  const unsupported = buildUnsupportedDcxStub();
  const unsup = decompressDcx(unsupported);
  assert(!unsup.ok && unsup.decompressionStatus === 'unsupported', 'KRAK DCX must be unsupported');
  assert(
    unsup.diagnostics.some((d) => d.code === 'DCX_COMPRESSION_UNSUPPORTED'),
    'unsupported DCX diagnostic required'
  );
  results.push('DCX DFLT ok');

  // ---------- 4) Synthetic BND ----------
  const childA = Buffer.from('child-A-bytes-aaaa');
  const childB = Buffer.from('child-B-bytes-bbbb');
  const fmgBuilt = buildSyntheticFmg([
    { textId: 100, text: 'Hello' },
    { textId: 200, text: 'World' }
  ]);
  assert(fmgBuilt.ok && fmgBuilt.bytes, 'FMG build');

  const bndBuilt = buildSyntheticBnd({
    format: 'bnd4',
    children: [
      { id: 1, name: 'item.fmg', bytes: fmgBuilt.bytes! },
      { id: 2, name: 'note.txt', bytes: childA },
      { id: 3, name: 'meta.bin', bytes: childB }
    ]
  });
  assert(bndBuilt.ok && bndBuilt.bytes, 'BND build');
  const bndPath = join(overlay, 'bin', 'pack.bnd');
  await writeFile(bndPath, bndBuilt.bytes!);

  const list = await listContainerChildren(bndPath, { relativePath: 'bin/pack.bnd' });
  assert(list.ok && list.children.length === 3, 'BND list children');
  const readA = await readContainerChild(
    bndPath,
    list.children.find((c) => c.name === 'note.txt')!.childUri,
    { relativePath: 'bin/pack.bnd' }
  );
  assert(readA.ok && readA.bytes?.equals(childA), 'BND extract child');

  const bndRt = await roundTripContainer(bndPath);
  assert(bndRt.ok && bndRt.childHashMatches, 'BND no-change repack child hashes');

  const newNote = Buffer.from('child-A-REPLACED!!!!');
  const replaced = replaceContainerChildInMemory(
    bndBuilt.bytes!,
    'note.txt',
    newNote,
    sha256(bndBuilt.bytes!),
    sha256(childA)
  );
  assert(replaced.ok && replaced.containerBytes, 'BND replace child');
  const reRead = readSyntheticBnd(replaced.containerBytes!);
  assert(reRead.ok, 'reread after replace');
  const noteAfter = reRead.children.find((c) => c.name === 'note.txt')!;
  const fmgAfter = reRead.children.find((c) => c.name === 'item.fmg')!;
  assert(noteAfter.hash === sha256(newNote), 'only target child changed');
  assert(fmgAfter.hash === sha256(fmgBuilt.bytes!), 'unmodified FMG preserved');
  results.push('BND synthetic ok');

  // ---------- 5) DCX + BND nested ----------
  const nestedDcx = compressDcxDflt(bndBuilt.bytes!);
  assert(nestedDcx.ok && nestedDcx.bytes, 'nested DCX(BND) compress');
  const nestedPath = join(overlay, 'msg', 'item.msgbnd.dcx');
  await writeFile(nestedPath, nestedDcx.bytes!);

  const tree = await inspectContainerTree(nestedPath, { relativePath: 'msg/item.msgbnd.dcx' });
  assert(tree.ok && tree.tree, 'nested tree');
  assert(tree.tree!.root.format === 'dcx', 'root is dcx');
  assert(tree.tree!.root.canReplaceChild, 'nested can replace child');
  assert(tree.tree!.root.children.length === 3, 'nested children listed');

  const nestedChild = tree.tree!.root.children.find((c) => c.name === 'note.txt')!;
  const nestedRead = await readContainerChild(nestedPath, nestedChild.childUri, {
    relativePath: 'msg/item.msgbnd.dcx'
  });
  assert(nestedRead.ok && nestedRead.bytes?.equals(childA), 'read child through nested uri');

  const nestedNew = Buffer.from('NESTED-CHILD-PATCH-v2');
  const nestedReplace = replaceContainerChildInMemory(
    nestedDcx.bytes!,
    'note.txt',
    nestedNew,
    sha256(nestedDcx.bytes!),
    sha256(childA)
  );
  assert(nestedReplace.ok && nestedReplace.containerBytes, 'nested replace');
  await writeFile(nestedPath, nestedReplace.containerBytes!);
  const reInspect = await inspectContainerTree(nestedPath, { relativePath: 'msg/item.msgbnd.dcx' });
  const noteNode = reInspect.tree!.root.children.find((c) => c.name === 'note.txt')!;
  assert(noteNode.hash === sha256(nestedNew), 're-inspect confirms nested modification');
  results.push('DCX+BND nested ok');

  // ---------- 6) Patch Engine container_child_replace ----------
  // Reset nested to original for transaction tests
  await writeFile(nestedPath, nestedDcx.bytes!);
  const nestedFile = makeFile(
    ws,
    nestedPath,
    'msg/item.msgbnd.dcx',
    'dcx',
    'msg',
    '.dcx',
    '.msgbnd.dcx'
  );
  const origNestedHash = sha256(nestedDcx.bytes!);
  const childUri = (await inspectContainerTree(nestedPath, { relativePath: 'msg/item.msgbnd.dcx' }))
    .tree!.root.children.find((c) => c.name === 'note.txt')!.childUri;

  // No confirmation
  const noConfirm = await replaceContainerChild({
    file: nestedFile,
    childUri,
    expectedContainerHash: origNestedHash,
    expectedChildHash: sha256(childA),
    newContentBase64: Buffer.from('x').toString('base64'),
    session,
    operationLog: store
  });
  assert(!noConfirm.ok, 'no confirmation must fail');
  assert(
    noConfirm.diagnostics.some((d) => d.code === 'EDIT_CONFIRMATION_REQUIRED'),
    'confirmation diagnostic'
  );
  assert((await readFile(nestedPath)).equals(nestedDcx.bytes!), 'unchanged without confirmation');

  // Hash mismatch
  const hashMismatch = await replaceContainerChild({
    file: nestedFile,
    childUri,
    expectedContainerHash: '0'.repeat(64),
    expectedChildHash: sha256(childA),
    newContentBase64: Buffer.from('x').toString('base64'),
    confirmation: confirm('file://msg/item.msgbnd.dcx'),
    session,
    operationLog: store
  });
  assert(!hashMismatch.ok, 'hash mismatch must fail');
  assert(
    hashMismatch.diagnostics.some((d) => d.code === 'HASH_MISMATCH'),
    'HASH_MISMATCH diagnostic'
  );

  // Success path
  const newNestedChild = Buffer.from('via-patch-engine-OK');
  const success = await replaceContainerChild({
    file: nestedFile,
    childUri,
    expectedContainerHash: origNestedHash,
    expectedChildHash: sha256(childA),
    newContentBase64: newNestedChild.toString('base64'),
    confirmation: confirm('file://msg/item.msgbnd.dcx'),
    session,
    operationLog: store,
    title: 'v06 nested child replace'
  });
  assert(success.ok, `container replace must succeed: ${success.diagnostics.map((d) => d.code).join(',')}`);
  assert(success.opId, 'opId required');
  assert(await store.get(success.opId!), 'operation log entry');
  const afterBytes = await readFile(nestedPath);
  const afterTree = await inspectContainerTree(nestedPath, { relativePath: 'msg/item.msgbnd.dcx' });
  const afterNote = afterTree.tree!.root.children.find((c) => c.name === 'note.txt')!;
  assert(afterNote.hash === sha256(newNestedChild), 'committed child hash');

  // Rollback
  const recordedEntryChanges = await store.listResourceEntryChanges(success.opId!);
  assert(recordedEntryChanges.length === 1, 'resource entry inverse must be recorded');
  assert(recordedEntryChanges[0]!.entryUri === childUri, 'resource entry inverse uri');
  const rb = await rollbackResourceEntry({
    opId: success.opId!,
    entryUri: childUri,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_RESOURCE_ENTRY:${success.opId!}:${childUri}`],
      riskLevel: 'high',
      note: 'native container smoke'
    })
  });
  assert(rb.ok, `rollback must work: ${rb.diagnostics.map((d) => d.code).join(',')}`);
  assert((await readFile(nestedPath)).equals(nestedDcx.bytes!), 'rollback restores container bytes');
  assert(rb.record?.rollbackScope === 'resource_entry', 'resource entry rollback scope');
  assert(rb.record?.rollbackTargetUri === childUri, 'resource entry rollback target');
  results.push('PatchEngine container_child_replace ok');

  // ---------- 7) FMG semantic fixture ----------
  const fmgPath = join(overlay, 'msg', 'standalone.fmg');
  await writeFile(fmgPath, fmgBuilt.bytes!);
  const fmgParse = parseSyntheticFmg(fmgBuilt.bytes!);
  assert(fmgParse.ok && fmgParse.authority === 'fixture-confirmed', 'FMG parse fixture-confirmed');
  const fmgRt = roundTripSyntheticFmg(fmgBuilt.bytes!);
  assert(fmgRt.ok && fmgRt.entriesMatch, 'FMG entries roundtrip');
  const fmgUpdated = updateSyntheticFmgEntry(fmgBuilt.bytes!, 100, 'Hello-Edited');
  assert(fmgUpdated.ok && fmgUpdated.bytes, 'FMG update entry');
  const fmgRe = parseSyntheticFmg(fmgUpdated.bytes!);
  assert(fmgRe.entries.find((e) => e.textId === 100)?.text === 'Hello-Edited', 'FMG text updated');
  assert(fmgRe.entries.find((e) => e.textId === 200)?.text === 'World', 'FMG other entry preserved');

  // FMG inside msgbnd.dcx: update FMG bytes + replace child + repack
  await writeFile(nestedPath, nestedDcx.bytes!);
  const fmgChild = (await inspectContainerTree(nestedPath, { relativePath: 'msg/item.msgbnd.dcx' }))
    .tree!.root.children.find((c) => c.name === 'item.fmg')!;
  const fmgInBnd = await readContainerChild(nestedPath, fmgChild.childUri, {
    relativePath: 'msg/item.msgbnd.dcx'
  });
  const fmgPatched = updateSyntheticFmgEntry(fmgInBnd.bytes!, 100, 'In-BND-Edit');
  const fmgReplace = await replaceContainerChild({
    file: nestedFile,
    childUri: fmgChild.childUri,
    expectedContainerHash: sha256(await readFile(nestedPath)),
    expectedChildHash: fmgChild.hash,
    newContentBase64: fmgPatched.bytes!.toString('base64'),
    confirmation: confirm('file://msg/item.msgbnd.dcx'),
    session,
    operationLog: store
  });
  assert(fmgReplace.ok, `FMG-in-container replace: ${fmgReplace.diagnostics.map((d) => d.code).join(',')}`);
  const fmgAfterRead = await readContainerChild(nestedPath, fmgChild.childUri, {
    relativePath: 'msg/item.msgbnd.dcx'
  });
  const fmgAfterParse = parseSyntheticFmg(fmgAfterRead.bytes!);
  assert(fmgAfterParse.entries.find((e) => e.textId === 100)?.text === 'In-BND-Edit', 'FMG nested edit');
  results.push('FMG fixture-confirmed ok');

  // ---------- 8) Semantic honesty ----------
  const emevdPath = join(overlay, 'event', 'common.emevd.dcx');
  await writeFile(emevdPath, Buffer.from([0x44, 0x43, 0x58, 0x00, 0x01]));
  const emevdFile = makeFile(ws, emevdPath, 'event/common.emevd.dcx', 'emevd', 'event', '.dcx', '.emevd.dcx');
  const emevdCaps = resolveResourceCapabilities(emevdFile);
  assert(!emevdCaps.semanticWritable, 'EMEVD semanticWritable=false');
  assert(emevdCaps.semanticAuthorityByFormat?.emevd === 'none', 'EMEVD authority none');
  assert(emevdCaps.semanticAuthorityByFormat?.param === 'none', 'PARAM authority none');
  assert(emevdCaps.semanticAuthorityByFormat?.msb === 'none', 'MSB authority none');

  const fmgCaps = resolveResourceCapabilities(
    makeFile(ws, fmgPath, 'msg/standalone.fmg', 'fmg', 'msg', '.fmg', '.fmg'),
    { syntheticFmg: true }
  );
  assert(fmgCaps.semanticWritable === true, 'synthetic FMG can be semanticWritable');
  assert(fmgCaps.semanticAuthorityByFormat?.fmg === 'fixture-confirmed', 'FMG fixture-confirmed');
  assert(fmgCaps.nativeFormatAuthority === false, 'never native authority claim');

  const probed = await probeContainerCapabilityOptions(nestedPath);
  assert(probed.dcxDfltSupported && probed.syntheticBnd && probed.nestedContainerRoundTripSafe, 'probe nested');
  const nestedCaps = resolveResourceCapabilities(nestedFile, probed);
  assert(nestedCaps.canReplaceChild && nestedCaps.containerRoundTripSafe, 'nested caps');
  assert(nestedCaps.containerWritableLevel === 'authoritative-repack', 'authoritative-repack level');
  results.push('semantic honesty ok');

  // ---------- 9) Regression: saveText on packed fails ----------
  const textOnPacked = await saveTextResource({
    file: nestedFile,
    newText: 'nope',
    session,
    operationLog: store
  });
  assert(!textOnPacked.ok, 'saveText on packed must fail');
  results.push('regression packed text gate ok');

  // Legal raw replace still works
  const legalRaw = await saveRawReplace({
    file: binFile,
    expectedHash: sha256(await readFile(binPath)),
    newContentBase64: Buffer.from([9, 8, 7, 6]).toString('base64'),
    confirmation: confirm('file://other/blob.bin'),
    session,
    operationLog: store
  });
  assert(legalRaw.ok, 'legal raw replace still works');
  assert((await readFile(binPath)).equals(Buffer.from([9, 8, 7, 6])), 'raw replace content');

  // Empty allowEmpty raw
  const emptyFail = await saveRawReplace({
    file: binFile,
    expectedHash: sha256(await readFile(binPath)),
    newContentBase64: '',
    allowEmpty: false,
    confirmation: confirm('file://other/blob.bin'),
    session,
    operationLog: store
  });
  assert(!emptyFail.ok, 'empty payload allowEmpty=false fails');

  console.log('v0.6 Native Container Workbench smoke PASSED');
  for (const line of results) console.log(' -', line);
}

main().catch((error) => {
  console.error('v0.6 Native Container Workbench smoke FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

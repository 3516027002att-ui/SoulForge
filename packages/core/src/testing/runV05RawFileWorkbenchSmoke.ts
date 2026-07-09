/**
 * Raw-level full file workbench smoke:
 * capability matrix, range read, text full read, raw replace/patch, rollback, native risk gates.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IndexedFile } from '@soulforge/shared';
import {
  resolveResourceCapabilities
} from '../capabilities/resourceCapabilities.js';
import {
  readRawResourceMetadata,
  readRawResourceRange,
  readTextResourceFull
} from '../files/rawRead.js';
import { saveRawByteRange, saveRawReplace } from '../editing/saveRawResource.js';
import { saveTextResource } from '../editing/saveTextResource.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { compilePatchProposalToPatchIr } from '../patch/patchProposalAdapter.js';
import { createPatchProposal } from '../patch/patchEngine.js';
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

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-raw-wb-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'msg'), { recursive: true });
  await mkdir(join(overlay, 'event'), { recursive: true });
  await mkdir(join(overlay, 'other'), { recursive: true });
  await mkdir(join(overlay, 'bin'), { recursive: true });

  const textPath = join(overlay, 'msg', 'note.txt');
  const eventJsPath = join(overlay, 'event', 'common.emevd.dcx.js');
  const binPath = join(overlay, 'other', 'blob.bin');
  const dcxPath = join(overlay, 'event', 'common.emevd.dcx');
  const bndPath = join(overlay, 'bin', 'pack.bnd');
  const fmgTxtPath = join(overlay, 'msg', 'item.fmg.txt');

  const textBytes = Buffer.from('hello-raw-v1\n', 'utf8');
  const binBytes = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  const dcxBytes = Buffer.from([0x44, 0x43, 0x58, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const bndBytes = Buffer.from([0x42, 0x4e, 0x44, 0x34, 0xaa, 0xbb]);

  await writeFile(textPath, textBytes);
  await writeFile(eventJsPath, '// event dump\n$Event(0);\n', 'utf8');
  await writeFile(binPath, binBytes);
  await writeFile(dcxPath, dcxBytes);
  await writeFile(bndPath, bndBytes);
  await writeFile(fmgTxtPath, 'id\ttext\n1\thello\n', 'utf8');

  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'unknown' });
  const ws = session.meta.workspaceId;
  const store = new MemoryOperationLogStore();

  const files = {
    text: makeFile(ws, textPath, 'msg/note.txt', 'text', 'msg', '.txt', '.txt'),
    eventJs: makeFile(ws, eventJsPath, 'event/common.emevd.dcx.js', 'text', 'event', '.js', '.emevd.dcx.js'),
    bin: makeFile(ws, binPath, 'other/blob.bin', 'unknown', 'other', '.bin', '.bin'),
    dcx: makeFile(ws, dcxPath, 'event/common.emevd.dcx', 'emevd', 'event', '.dcx', '.emevd.dcx'),
    bnd: makeFile(ws, bndPath, 'bin/pack.bnd', 'bnd', 'other', '.bnd', '.bnd'),
    fmgTxt: makeFile(ws, fmgTxtPath, 'msg/item.fmg.txt', 'text', 'msg', '.txt', '.fmg.txt')
  };

  // 1) Capability matrix for every file
  for (const [name, file] of Object.entries(files)) {
    const caps = resolveResourceCapabilities(file);
    if (!caps.openable || !caps.rawReadable || !caps.fullRawReadable) {
      throw new Error(`${name}: openable/rawReadable must be true`);
    }
    if (caps.nativeFormatAuthority !== false) {
      throw new Error(`${name}: nativeFormatAuthority must be false`);
    }
    // Static matrix without probe: no semantic/native/container claim for mock packed bytes.
    if (caps.semanticWritable || caps.nativeRoundTripSafe || caps.containerWritable) {
      throw new Error(`${name}: semantic/native/container write must be false without fixture probe`);
    }
    if (caps.containerReadableLevel === undefined || caps.containerWritableLevel === undefined) {
      throw new Error(`${name}: v0.6 container level fields required`);
    }
    if (!caps.rawWritable) throw new Error(`${name}: rawWritable must be true`);
  }

  const textCaps = resolveResourceCapabilities(files.text);
  if (!textCaps.textWritable) throw new Error('text must be textWritable');
  const dcxCaps = resolveResourceCapabilities(files.dcx);
  if (!dcxCaps.requiredConfirmation || dcxCaps.riskLevel !== 'high') {
    throw new Error('dcx must be high risk + confirmation');
  }
  if (dcxCaps.semanticWritable || dcxCaps.textWritable) {
    throw new Error('dcx must not be text/semantic writable');
  }
  if (!dcxCaps.reasonCodes.includes('RAW_REPLACE_NATIVE_PACKED')) {
    throw new Error('dcx must include RAW_REPLACE_NATIVE_PACKED');
  }

  // 2) Raw range read middle of binary
  const range = await readRawResourceRange(files.bin, 2, 3);
  if (!range.ok || !range.base64) throw new Error(`range failed: ${JSON.stringify(range.diagnostics)}`);
  const decoded = Buffer.from(range.base64, 'base64');
  if (!decoded.equals(binBytes.subarray(2, 5))) throw new Error('range bytes mismatch');
  if (range.sha256OfRange !== sha256(binBytes.subarray(2, 5))) throw new Error('range hash mismatch');

  const oob = await readRawResourceRange(files.bin, 100, 1);
  if (oob.ok || !oob.diagnostics.some((d) => d.code === 'RAW_RANGE_OOB')) {
    throw new Error('OOB range must fail');
  }

  // 3) Text full read
  const full = await readTextResourceFull(files.text);
  if (!full.ok || full.text !== 'hello-raw-v1\n') throw new Error('full text read failed');
  const fullBin = await readTextResourceFull(files.bin);
  if (fullBin.ok || !fullBin.diagnostics.some((d) => d.code === 'TEXT_FULL_READ_NOT_TEXT')) {
    throw new Error('binary full text read must fail');
  }

  // invalid utf-8
  const badUtfPath = join(overlay, 'msg', 'bad.txt');
  await writeFile(badUtfPath, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const badFile = makeFile(ws, badUtfPath, 'msg/bad.txt', 'text', 'msg', '.txt', '.txt');
  const badRead = await readTextResourceFull(badFile);
  if (badRead.ok || !badRead.diagnostics.some((d) => d.code === 'TEXT_INVALID_UTF8')) {
    throw new Error('invalid utf-8 must be diagnosed');
  }

  // 4) Raw whole-file replace with/without confirmation
  const binHash = sha256(await readFile(binPath));
  const noConfirm = await saveRawReplace({
    file: files.bin,
    expectedHash: binHash,
    newContentBase64: Buffer.from([0xde, 0xad]).toString('base64'),
    session,
    operationLog: store
  });
  if (noConfirm.ok || !noConfirm.diagnostics.some((d) => d.code === 'EDIT_CONFIRMATION_REQUIRED')) {
    throw new Error('raw replace without confirmation must fail');
  }
  if (!(await readFile(binPath)).equals(binBytes)) throw new Error('no-confirm replace mutated file');

  const receipt = createConfirmationReceipt({
    subjects: ['resource', 'high', 'caution', 'ALL_RISKS', files.bin.sourceUri, 'UNKNOWN_BINARY_RAW_ONLY'],
    riskLevel: 'caution',
    sourceUri: files.bin.sourceUri
  });
  const replaced = await saveRawReplace({
    file: files.bin,
    expectedHash: binHash,
    newContentBase64: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'),
    confirmation: receipt,
    session,
    operationLog: store
  });
  if (!replaced.ok || !replaced.opId) {
    throw new Error(`raw replace failed: ${JSON.stringify(replaced.diagnostics)}`);
  }
  if (!(await readFile(binPath)).equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))) {
    throw new Error('raw replace content wrong');
  }
  const rolled = await rollbackOperation({ opId: replaced.opId, store, session });
  if (!rolled.ok) throw new Error(`rollback replace failed: ${JSON.stringify(rolled.diagnostics)}`);
  if (!(await readFile(binPath)).equals(binBytes)) throw new Error('rollback replace did not restore');

  // 5) Raw byte range patch
  const hash2 = sha256(await readFile(binPath));
  const badHash = await saveRawByteRange({
    file: files.bin,
    expectedHash: '0'.repeat(64),
    offset: 1,
    length: 1,
    replacementBase64: Buffer.from([0xff]).toString('base64'),
    confirmation: createConfirmationReceipt({
      subjects: ['resource', 'high', 'caution', 'ALL_RISKS', files.bin.sourceUri],
      riskLevel: 'caution',
      sourceUri: files.bin.sourceUri
    }),
    session,
    operationLog: store
  });
  if (badHash.ok || !badHash.diagnostics.some((d) => d.code === 'HASH_MISMATCH')) {
    throw new Error('wrong expectedHash must fail');
  }

  const patched = await saveRawByteRange({
    file: files.bin,
    expectedHash: hash2,
    offset: 1,
    length: 1,
    replacementBase64: Buffer.from([0xff]).toString('base64'),
    confirmation: createConfirmationReceipt({
      subjects: ['resource', 'high', 'caution', 'ALL_RISKS', files.bin.sourceUri],
      riskLevel: 'caution',
      sourceUri: files.bin.sourceUri
    }),
    session,
    operationLog: store
  });
  if (!patched.ok || !patched.opId) throw new Error(`byte patch failed: ${JSON.stringify(patched.diagnostics)}`);
  if ((await readFile(binPath))[1] !== 0xff) throw new Error('byte patch not applied');
  const rolledPatch = await rollbackOperation({ opId: patched.opId, store, session });
  if (!rolledPatch.ok || !(await readFile(binPath)).equals(binBytes)) {
    throw new Error('byte patch rollback failed');
  }

  // OOB patch
  const oobPatch = await saveRawByteRange({
    file: files.bin,
    expectedHash: sha256(await readFile(binPath)),
    offset: 100,
    length: 1,
    replacementBase64: Buffer.from([0x00]).toString('base64'),
    confirmation: createConfirmationReceipt({
      subjects: ['resource', 'ALL_RISKS', 'caution', 'high', files.bin.sourceUri],
      riskLevel: 'caution',
      sourceUri: files.bin.sourceUri
    }),
    session,
    operationLog: store
  });
  if (oobPatch.ok) throw new Error('OOB patch must fail');

  // 6) Native packed: saveText fails, raw with confirmation works
  const textOnDcx = await saveTextResource({
    file: files.dcx,
    newText: 'nope',
    session,
    operationLog: store
  });
  if (textOnDcx.ok) throw new Error('saveTextResource must fail on packed dcx');

  const dcxHash = sha256(await readFile(dcxPath));
  const dcxNoConfirm = await saveRawReplace({
    file: files.dcx,
    expectedHash: dcxHash,
    newContentBase64: Buffer.from([0x44, 0x43, 0x58, 0x00, 0x99]).toString('base64'),
    session,
    operationLog: store
  });
  if (dcxNoConfirm.ok) throw new Error('dcx raw replace without confirmation must fail');

  const dcxOk = await saveRawReplace({
    file: files.dcx,
    expectedHash: dcxHash,
    newContentBase64: Buffer.from([0x44, 0x43, 0x58, 0x00, 0x99]).toString('base64'),
    confirmation: createConfirmationReceipt({
      subjects: [
        'resource', 'high', 'ALL_RISKS', files.dcx.sourceUri,
        'RAW_REPLACE_NATIVE_PACKED', 'SEMANTIC_WRITER_ABSENT', 'NATIVE_ROUNDTRIP_NOT_SAFE'
      ],
      riskLevel: 'high',
      sourceUri: files.dcx.sourceUri
    }),
    session,
    operationLog: store
  });
  if (!dcxOk.ok || !dcxOk.opId) {
    throw new Error(`dcx raw replace failed: ${JSON.stringify(dcxOk.diagnostics)}`);
  }
  if ((await readFile(dcxPath))[4] !== 0x99) throw new Error('dcx raw replace content wrong');
  await rollbackOperation({ opId: dcxOk.opId, store, session });
  if (!(await readFile(dcxPath)).equals(dcxBytes)) throw new Error('dcx rollback failed');

  // 7) Adapter compiles explicit raw schemas
  const proposal = createPatchProposal({
    workspaceId: ws,
    title: 'adapter raw',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: files.bin.sourceUri,
      targetPath: binPath,
      kind: 'binary',
      beforeHash: sha256(await readFile(binPath)),
      structuredEdit: {
        schemaId: 'rawByteRangeEdit',
        expectedHash: sha256(await readFile(binPath)),
        offset: 0,
        length: 1,
        replacementBase64: Buffer.from([0x01]).toString('base64')
      }
    }]
  });
  const compiled = compilePatchProposalToPatchIr(proposal);
  if (!compiled.ok || compiled.patch?.operations[0]?.kind !== 'raw_byte_range_edit') {
    throw new Error(`adapter raw compile failed: ${JSON.stringify(compiled.legacyDiagnostics)}`);
  }

  const bareBinary = createPatchProposal({
    workspaceId: ws,
    title: 'bare binary blocked',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: files.bin.sourceUri,
      targetPath: binPath,
      kind: 'binary'
    }]
  });
  const bareCompiled = compilePatchProposalToPatchIr(bareBinary);
  if (bareCompiled.ok) throw new Error('bare binary without schema must fail');

  // metadata
  const meta = await readRawResourceMetadata(files.text, { computeHash: true });
  if (meta.hashStatus !== 'full' || !meta.contentHash) throw new Error('text metadata hash missing');

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 raw file workbench smoke: ok',
    matrix: {
      allOpenable: true,
      allRawReadable: true,
      allRawWritableWithConfirmation: true,
      textWritable: true,
      nativeSemanticWritable: false,
      nativeRoundTripSafe: false
    },
    proofs: [
      'capability matrix for text/binary/dcx/bnd',
      'raw range read + OOB',
      'text full read + invalid utf-8',
      'raw replace confirm gate + rollback',
      'raw byte patch hash/OOB + rollback',
      'saveText blocked on packed; raw replace allowed with confirmation',
      'adapter compiles raw schemas; bare binary blocked'
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

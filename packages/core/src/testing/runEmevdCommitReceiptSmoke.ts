import { strict as assert } from 'node:assert';
import {
  finalizeCommittedToolResult,
  finalizeEmevdDslApplyResult,
  type ToolContext
} from '../ai/toolRegistry.js';
import {
  projectEmevdSubmitResult
} from '../editing/emevdEdit.js';
import { finalizeEmevdPostCommitRead } from '../editing/emevdPlanCommit.js';
import type { NativeReadProofStore } from '../editing/nativeReadProofStore.js';

const diagnostic = (code: string, severity: 'info' | 'warning' | 'error' = 'info') => ({
  severity,
  code,
  message: code
});

const noop = projectEmevdSubmitResult('/workspace/event/noop.emevd.dcx', [], {
  ok: true,
  commit: {
    ok: true,
    mutationCount: 0,
    diagnostics: [diagnostic('EMEVD_PLAN_EMPTY')]
  },
  diagnostics: []
});
assert.equal(noop.ok, true);
assert.equal(noop.transactionStatus, 'noop');
assert.equal(noop.mutationCount, 0);
assert.equal(noop.opId, undefined);
assert.ok(noop.diagnostics.some((item) => item.code === 'EMEVD_PLAN_EMPTY'));

const compileFailure = projectEmevdSubmitResult('/workspace/event/compile-failed.emevd.dcx', [
  diagnostic('EMEVD_SCHEMA_INFO')
], {
  ok: false,
  diagnostics: [diagnostic('EMEVD_DSL_COMPILE_FAILED', 'error')]
});
assert.equal(compileFailure.error?.code, 'EMEVD_DSL_COMPILE_FAILED');

const verified = projectEmevdSubmitResult('/workspace/event/verified.emevd.dcx', [], {
  ok: true,
  commit: {
    ok: true,
    mutationCount: 2,
    transactionStatus: 'committed',
    opId: 'op-verified',
    outputHash: 'payload-hash',
    payloadHash: 'payload-hash',
    outerFileHash: 'outer-hash',
    committedPath: '/workspace/event/verified.emevd.dcx',
    reRead: {
      ok: true,
      outputHash: 'outer-hash',
      sourceHash: 'payload-hash',
      outerFileHash: 'outer-hash',
      eventCount: 3,
      instructionCount: 8,
      semanticIdentical: true,
      byteConsistent: true
    },
    nativeVerification: {
      status: 'verified',
      details: { scope: 'committed-file-reread' }
    },
    diagnostics: [diagnostic('EMEVD_REREAD_VERIFIED')]
  },
  diagnostics: [diagnostic('EMEVD_REREAD_VERIFIED')]
});
assert.equal(verified.ok, true);
assert.equal(verified.transactionStatus, 'committed');
assert.equal(verified.opId, 'op-verified');
assert.equal(verified.outputHash, 'payload-hash');
assert.equal(verified.payloadHash, 'payload-hash');
assert.equal(verified.outerFileHash, 'outer-hash');
assert.equal(verified.reRead?.ok, true);
assert.equal(verified.reRead?.sourceHash, 'payload-hash');
assert.equal(verified.reRead?.outerFileHash, 'outer-hash');
assert.equal(verified.nativeVerification?.status, 'verified');

const verificationFailed = projectEmevdSubmitResult('/workspace/event/failed.emevd.dcx', [], {
  ok: false,
  commit: {
    ok: false,
    mutationCount: 2,
    transactionStatus: 'committed',
    opId: 'op-failed-reread',
    outputHash: 'payload-hash-failed',
    payloadHash: 'payload-hash-failed',
    committedPath: '/workspace/event/failed.emevd.dcx',
    nativeVerification: {
      status: 'failed',
      code: 'EMEVD_REREAD_FAILED',
      message: 'semantic roundtrip mismatch',
      details: { byteConsistent: true, semanticIdentical: false }
    },
    reRead: {
      ok: false,
      outputHash: 'actual-hash',
      eventCount: 3,
      instructionCount: 8,
      semanticIdentical: false,
      byteConsistent: true
    },
    diagnostics: [diagnostic('EMEVD_REREAD_FAILED', 'error')]
  },
  diagnostics: [diagnostic('EMEVD_REREAD_FAILED', 'error')]
});
assert.equal(verificationFailed.ok, false);
assert.equal(verificationFailed.transactionStatus, 'committed');
assert.equal(verificationFailed.opId, 'op-failed-reread');
assert.equal(verificationFailed.reRead?.ok, false);
assert.equal(verificationFailed.nativeVerification?.status, 'failed');

const postCommitException = await finalizeEmevdPostCommitRead({
  sourcePath: '/workspace/event/exception.emevd.dcx',
  allowedRoots: ['/workspace'],
  sourceFormat: 'dcx',
  expectedOutputHash: 'outer-hash-exception',
  expectedPayloadHash: 'payload-hash-exception',
  opId: 'op-reread-exception',
  committedPath: '/workspace/event/exception.emevd.dcx',
  outputHash: 'outer-hash-exception',
  payloadHash: 'payload-hash-exception',
  outerFileHash: 'outer-hash-exception',
  mutationCount: 2,
  commitDiagnostics: [],
  read: async () => { throw new Error('Bridge unavailable after commit'); }
});
assert.equal(postCommitException.transactionStatus, 'committed');
assert.equal(postCommitException.opId, 'op-reread-exception');
assert.equal(postCommitException.nativeVerification?.code, 'EMEVD_REREAD_EXCEPTION');
const verificationException = projectEmevdSubmitResult('/workspace/event/exception.emevd.dcx', [], {
  ok: false,
  commit: postCommitException,
  diagnostics: postCommitException.diagnostics
});
assert.equal(verificationException.transactionStatus, 'committed');
assert.equal(verificationException.opId, 'op-reread-exception');
assert.equal(verificationException.outputHash, 'outer-hash-exception');
assert.equal(verificationException.payloadHash, 'payload-hash-exception');
assert.equal(verificationException.outerFileHash, 'outer-hash-exception');
assert.equal(verificationException.reRead, undefined);
assert.equal(verificationException.nativeVerification?.code, 'EMEVD_REREAD_EXCEPTION');

const notCommitted = projectEmevdSubmitResult('/workspace/event/rolled-back.emevd.dcx', [], {
  ok: false,
  commit: {
    ok: false,
    mutationCount: 2,
    transactionStatus: 'not_committed',
    opId: 'op-rolled-back',
    diagnostics: [diagnostic('AFTER_COMMIT_VALIDATION_FAILED_ROLLED_BACK', 'error')]
  },
  diagnostics: [diagnostic('AFTER_COMMIT_VALIDATION_FAILED_ROLLED_BACK', 'error')]
});
assert.equal(notCommitted.ok, false);
assert.equal(notCommitted.transactionStatus, 'not_committed');
assert.equal(notCommitted.opId, 'op-rolled-back');
assert.equal(notCommitted.committedPath, undefined);

const context = { workspaceIndex: null, mode: 'normal' as const };
const finalizedVerified = await finalizeCommittedToolResult({
  data: verified,
  changedSources: [verified.filePath!],
  context,
  verifyNative: async () => ({
    ok: true as const,
    details: verified.nativeVerification?.details
  })
});
assert.equal(finalizedVerified.ok, true);
assert.equal(finalizedVerified.state, 'committed');
assert.equal((finalizedVerified.data as Record<string, any>).opId, 'op-verified');
assert.equal((finalizedVerified.data as Record<string, any>).lifecycle.nativeVerification.status, 'verified');

const finalizedFailed = await finalizeCommittedToolResult({
  data: verificationFailed,
  changedSources: [verificationFailed.filePath!],
  context,
  verifyNative: async () => ({
    ok: false as const,
    code: verificationFailed.nativeVerification?.code ?? 'EMEVD_REREAD_FAILED',
    message: verificationFailed.nativeVerification?.message ?? 'post-commit verification failed',
    details: verificationFailed.nativeVerification?.details
  })
});
assert.equal(finalizedFailed.ok, true);
assert.equal(finalizedFailed.state, 'verification_failed');
assert.equal((finalizedFailed.data as Record<string, any>).opId, 'op-failed-reread');
assert.equal((finalizedFailed.data as Record<string, any>).lifecycle.transaction, 'committed');
assert.equal((finalizedFailed.data as Record<string, any>).lifecycle.nativeVerification.status, 'failed');

// Exercise the production registry result mapper, not a hand-built wrapper:
// no-op must skip refresh/proof invalidation, while a committed verification
// failure must preserve the receipt and enter the sticky verification state.
let refreshCalls = 0;
const invalidatedSources: string[] = [];
const proofStore: NativeReadProofStore = {
  acceptDeliveredRead: () => undefined,
  requireCoverage: () => { throw new Error('not used'); },
  invalidateSource: (source) => invalidatedSources.push(source),
  invalidateAll: () => undefined,
  dispose: () => undefined
};
const mapperContext: ToolContext = {
  workspaceIndex: null,
  mode: 'normal',
  nativeReadProofs: proofStore,
  onNativeWriteCommitted: async () => {
    refreshCalls += 1;
    return undefined;
  }
};
const mappedNoop = await finalizeEmevdDslApplyResult(noop, '/workspace/event/noop.emevd.dcx', mapperContext);
assert.equal(mappedNoop.ok, true);
assert.equal(mappedNoop.state, 'completed');
assert.equal((mappedNoop.data as Record<string, any>).transactionStatus, 'noop');
assert.equal('lifecycle' in (mappedNoop.data as Record<string, any>), false);
assert.equal(refreshCalls, 0);
assert.equal(invalidatedSources.length, 0);

const mappedFailed = await finalizeEmevdDslApplyResult(
  verificationFailed,
  '/workspace/event/failed.emevd.dcx',
  mapperContext
);
assert.equal(mappedFailed.ok, true);
assert.equal(mappedFailed.state, 'verification_failed');
assert.equal((mappedFailed.data as Record<string, any>).opId, 'op-failed-reread');
assert.equal((mappedFailed.data as Record<string, any>).lifecycle.transaction, 'committed');
assert.equal((mappedFailed.data as Record<string, any>).lifecycle.nativeVerification.status, 'failed');
assert.equal(refreshCalls, 1);
assert.ok(invalidatedSources.length > 0);

const mappedException = await finalizeEmevdDslApplyResult(
  verificationException,
  '/workspace/event/exception.emevd.dcx',
  mapperContext
);
assert.equal(mappedException.ok, true);
assert.equal(mappedException.state, 'verification_failed');
assert.equal((mappedException.data as Record<string, any>).opId, 'op-reread-exception');
assert.equal((mappedException.data as Record<string, any>).lifecycle.nativeVerification.status, 'failed');

console.log(JSON.stringify({ ok: true, checks: 47, message: 'EMEVD commit receipt smoke passed' }));

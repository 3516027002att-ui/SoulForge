/** Regression for historical workspace_stats projection failures and audit parity. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { createDefaultToolRegistry, ToolRegistry, type ToolResult } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { projectEvidenceClaims } from '../model-services/evidenceIdentity.js';
import { encodeEvidenceClaims, expandEvidenceClaims } from '../model-services/evidenceTransport.js';

async function execute(result: ToolResult) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace_stats',
    description: 'Return the fixture payload through the production envelope.',
    permission: 'read',
    run: () => result
  });
  const bridge = createAgentToolBridge({
    registry,
    context: { workspaceIndex: null, mode: 'plan' }
  });
  const outer = await bridge.executeTool({
    id: 'envelope-regression', name: 'workspace_stats', argumentsJson: '{}'
  });
  return { outer, envelope: JSON.parse(outer.content) };
}

export async function runAgentToolEnvelopeSmoke(): Promise<void> {
  const claimFixture = projectEvidenceClaims({
    sourceUri: `workspace://mods/${'long-native-path/'.repeat(6)}gameparam.parambnd.dcx`,
    sourceHash: 'a'.repeat(64), sourceRevision: 123, table: 'NpcParam', entryName: 'NpcParam.param',
    rowId: 50800000,
    fields: ['npcType', 'ninsatuNum', 'itemLotId_1', 'itemLotId_2', 'itemLotId_3', 'hp', 'isSoulGetByBoss', 'getSoul']
      .map(fieldId => ({ fieldId, value: 10, rowId: 50800000 }))
  }, { workspaceId: 'transport-fixture', domain: 'param', authorityClass: 'native' });
  assert.equal(claimFixture.length, 8);
  const wire = encodeEvidenceClaims(claimFixture);
  assert.deepEqual(expandEvidenceClaims(wire), claimFixture);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < Buffer.byteLength(JSON.stringify({ claims: claimFixture })) / 2);
  const customHandle = claimFixture.map((claim, index) => ({ ...claim, handle: `custom:${index}` }));
  assert.deepEqual(expandEvidenceClaims(encodeEvidenceClaims(customHandle)), customHandle);
  assert.deepEqual(expandEvidenceClaims({ claims: claimFixture }), claimFixture);
  assert.deepEqual(expandEvidenceClaims({ claims: [{ identity: {}, text: 'invalid' }] }), [null]);

  const nativeFields = claimFixture.map((claim, i) => ({
    fieldId: claim.identity.claimKind, rowId: 50800000, table: 'NpcParam', entryName: 'NpcParam.param',
    value: i, sourceUri: claim.identity.canonicalOuterId, sourceHash: 'a'.repeat(64), sourceRevision: 123
  }));
  const nativeRegistry = new ToolRegistry();
  let verboseFields = false;
  nativeRegistry.register({
    name: 'read_param_fields', description: 'Eight-field native output fixture', permission: 'read',
    run: () => ({ ok: true, data: {
      sourceUri: claimFixture[0]!.identity.canonicalOuterId, sourceHash: 'a'.repeat(64), sourceRevision: 123,
      sourcePath: verboseFields
        ? `C:\\合成\\参数\\${'长路径/'.repeat(500)}gameparam.parambnd.dcx`
        : 'C:\\synthetic\\param\\gameparam.parambnd.dcx',
      outerFileHash: 'b'.repeat(64),
      fields: nativeFields.map(field => ({ ...field, ...(verboseFields ? { auxiliaryNativeMetadata: 'x'.repeat(2500) } : {}) }))
    } })
  });
  const nativeBridge = createAgentToolBridge({
    registry: nativeRegistry, context: { workspaceIndex: new WorkspaceIndex('native-fields-fixture'), mode: 'plan' }
  });
  const nativeResult = await nativeBridge.executeTool({ id: 'eight-fields', name: 'read_param_fields', argumentsJson: '{}' });
  assert.equal(nativeResult.ok, true, nativeResult.content);
  const nativeEnvelope = JSON.parse(nativeResult.content);
  assert.equal(nativeEnvelope.truncated, false);
  assert.equal(expandEvidenceClaims(nativeEnvelope.evidence).length, 8);
  assert.deepEqual(nativeEnvelope.data.record.fields, nativeFields);
  verboseFields = true;
  const verboseResult = await nativeBridge.executeTool({ id: 'eight-verbose-fields', name: 'read_param_fields', argumentsJson: '{}' });
  assert.equal(verboseResult.ok, true, verboseResult.content);
  const verboseEnvelope = JSON.parse(verboseResult.content);
  assert.equal(verboseEnvelope.data.record.fieldsReturnedCount, 8);
  assert.equal(verboseEnvelope.data.record.fieldsTruncated, undefined);
  assert.equal(verboseEnvelope.data.record.sourceHash, 'a'.repeat(64));
  assert.equal(verboseEnvelope.data.record.outerFileHash, 'b'.repeat(64));
  assert.equal(verboseEnvelope.data.record.sourceRevision, 123);
  assert.equal(typeof verboseEnvelope.data.record.sourcePath, 'string');
  assert.ok(verboseEnvelope.data.record.sourcePath.length <= 421);
  assert.deepEqual(verboseEnvelope.data.record.fields.map((field: { fieldId: string; value: number }) => [field.fieldId, field.value]),
    nativeFields.map(field => [field.fieldId, field.value]));

  const index = new WorkspaceIndex('stats-summary-fixture');
  const sourceVersions = Array.from({ length: 128 }, (_, i) => ({
    sourceUri: `workspace://mods/event/m11_00_00_00/${String(i).padStart(8, '0')}.emevd.dcx`,
    sourceRevision: 123
  }));
  index.setCoverageState({
    scope: 'workspace', status: 'partial', coveredResources: 127, expectedResources: 128,
    coveredResourceIds: sourceVersions.slice(0, 127).map((source) => source.sourceUri),
    expectedResourceIds: sourceVersions.map((source) => source.sourceUri), sourceVersions,
    staleSources: [sourceVersions[0]!.sourceUri], diagnostics: ['source is stale'],
    predicateCompleteness: { kind: 'unknown', status: 'partial', exhaustive: false, predicate: '', reason: 'fixture' }
  });
  const statistics = createAgentToolBridge({ registry: createDefaultToolRegistry(), context: { workspaceIndex: index, mode: 'plan' } });
  const statsResult = await statistics.executeTool({ id: 'stats-summary', name: 'workspace_stats', argumentsJson: '{}' });
  assert.equal(statsResult.ok, true, statsResult.content);
  const statsEnvelope = JSON.parse(statsResult.content);
  const coverage = statsEnvelope.data.record.coverage.find((item: { scope: string; domain?: string }) => item.scope === 'workspace' && item.domain === undefined);
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.sourceVersionCount, 128);
  assert.equal(coverage.staleSourceCount, 1);
  assert.equal(coverage.expectedResources, 128);
  assert.equal(coverage.sourceVersions, undefined);
  assert.equal(coverage.detail, 'summary-only');
  // The historical statistics payload included every coverage source identity.
  // Exercise the real serializer guard; do not mock its failed response.
  const oversized = await execute({
    ok: true,
    data: {
      files: 277,
      coverage: [{
        sourceVersions: Array.from({ length: 128 }, (_, index) => ({
          sourceUri: `workspace://mods/event/m11_00_00_00/${String(index).padStart(8, '0')}.emevd.dcx`,
          sourceRevision: 123
        }))
      }]
    }
  });
  assert.equal(oversized.envelope.error.code, 'RESULT_IDENTITY_TOO_LARGE');
  assert.equal(oversized.outer.ok, false);
  assert.equal(oversized.outer.code, oversized.envelope.error.code);
  assert.equal(oversized.envelope.state, 'failed');

  // A committed write must not be converted into a retryable ordinary
  // failure merely because its stable identity list is too large. Keep the
  // small transaction lifecycle and reread locator available to the model;
  // the oversized identity itself remains explicitly unavailable.
  const committedOversized = await execute({
    ok: true,
    state: 'committed',
    data: {
      operationId: 'fixture-committed-op',
      sourceUri: 'workspace://mods/NpcParam.parambnd.dcx',
      sourceHash: 'b'.repeat(64),
      lifecycle: {
        transaction: 'committed',
        nativeVerification: { status: 'verified', sourceUri: 'workspace://mods/NpcParam.parambnd.dcx' },
        knowledgeRefresh: 'failed'
      },
      sourceVersions: Array.from({ length: 128 }, (_, index) => ({
        sourceUri: `workspace://mods/event/${String(index).padStart(8, '0')}/${'long-source-name/'.repeat(3)}.emevd.dcx`,
        sourceRevision: 123
      }))
    }
  });
  assert.equal(committedOversized.outer.ok, true, committedOversized.outer.content);
  assert.equal(committedOversized.envelope.ok, true);
  assert.equal(committedOversized.envelope.state, 'committed');
  assert.equal(committedOversized.envelope.data.record.operationId, 'fixture-committed-op');
  assert.equal(committedOversized.envelope.data.record.lifecycle.transaction, 'committed');
  assert.equal(committedOversized.envelope.data.record.lifecycle.nativeVerification.status, 'verified');
  assert.equal(committedOversized.envelope.data.record.lifecycle.knowledgeRefresh, 'failed');
  assert.equal(committedOversized.envelope.data.record.sourceVersions, undefined);
  assert.equal(committedOversized.envelope.data.record.outputBudget.code, 'RESULT_IDENTITY_TOO_LARGE');
  assert.equal(committedOversized.envelope.data.record.outputBudget.identityBytes > 8192, true);
  assert.ok(
    Buffer.byteLength(committedOversized.outer.content, 'utf8') <= 8192,
    `committed oversized envelope exceeded byte budget: ${Buffer.byteLength(committedOversized.outer.content, 'utf8')}`
  );
  assert.ok(
    committedOversized.outer.content.length <= 8192,
    `committed oversized envelope exceeded character budget: ${committedOversized.outer.content.length}`
  );

  const partialOversized = await execute({
    ok: true,
    state: 'partial' as unknown as NonNullable<ToolResult['state']>,
    data: {
      sourceVersions: Array.from({ length: 128 }, (_, index) => ({
        sourceUri: `workspace://mods/event/partial/${String(index).padStart(8, '0')}/${'long-source-name/'.repeat(3)}.emevd.dcx`,
        sourceRevision: 123
      }))
    }
  });
  assert.equal(partialOversized.outer.ok, false);
  assert.equal(partialOversized.envelope.state, 'partial');
  assert.equal(partialOversized.envelope.error.code, 'RESULT_IDENTITY_TOO_LARGE');

  // Force the strictest committed fallback: long opaque locators and nested
  // diagnostics make the projected lifecycle itself too large.  The fallback
  // must omit incomplete handles while retaining the failed refresh state.
  const committedMinimal = await execute({
    ok: true,
    state: 'committed',
    data: {
      operationId: '操作'.repeat(400),
      lifecycle: {
        transaction: 'committed',
        nativeVerification: { status: 'verified', sourceUri: '地图'.repeat(400) },
        knowledgeRefresh: { status: 'failed', semanticState: 'empty' },
        diagnostics: Array.from({ length: 8 }, () => ({ message: '诊断'.repeat(600) }))
      },
      sourceVersions: Array.from({ length: 128 }, (_, index) => ({
        sourceUri: `workspace://mods/event/${String(index).padStart(8, '0')}/${'长路径/'.repeat(12)}.emevd.dcx`,
        sourceRevision: 123
      }))
    }
  });
  assert.equal(committedMinimal.outer.ok, true, committedMinimal.outer.content);
  assert.equal(committedMinimal.envelope.state, 'committed');
  assert.equal(committedMinimal.envelope.data.record.lifecycle.knowledgeRefresh.status, 'failed');
  assert.equal(committedMinimal.envelope.data.record.operationId, undefined);
  assert.equal(committedMinimal.envelope.data.record.outputBudget.locatorOmitted, true);
  assert.ok(Buffer.byteLength(committedMinimal.outer.content, 'utf8') <= 8192);
  assert.ok(committedMinimal.outer.content.length <= 8192);

  // An explicitly failed lifecycle must not be silently promoted to completed,
  // even if a registry handler returned an inconsistent ok flag.
  for (const ok of [false, true]) {
    const failed = await execute({
      ok,
      state: 'failed',
      error: { code: 'NATIVE_READ_FAILED', message: 'fixture failure' }
    });
    assert.equal(failed.outer.ok, false);
    assert.equal(failed.outer.code, 'NATIVE_READ_FAILED');
    assert.equal(failed.envelope.ok, false);
    assert.equal(failed.envelope.state, 'failed');
    assert.deepEqual(failed.envelope.error, {
      code: 'NATIVE_READ_FAILED', message: 'fixture failure'
    });
  }
  const missingError = await execute({ ok: true, state: 'failed' });
  assert.equal(missingError.outer.ok, false);
  assert.equal(missingError.outer.code, 'TOOL_FAILED');
  assert.equal(missingError.envelope.error.code, 'TOOL_FAILED');

  // Small errors retain the registry's exact details schema. The bounded
  // projection below must only activate after the original response exceeds
  // the dual byte/character budget.
  const exactError = {
    code: 'EXACT_TOOL_FAILURE',
    message: 'small failure',
    details: {
      vendorField: 'preserve-me',
      nested: { arbitrary: true },
      diagnostics: [{ severity: 'warning', code: 'D0', message: 'small' }]
    }
  };
  const exact = await execute({ ok: false, state: 'failed', error: exactError });
  assert.equal(exact.outer.ok, false);
  assert.deepEqual(exact.envelope.error, exactError);

  // Non-ok tool results must obey the same envelope budget as successful
  // results. Exercise repeated 1,000-entry diagnostic arrays so this does
  // not pass merely because one small fixture happened to fit. Stable
  // locators/hashes/handles remain whole; ordinary text is UTF-8 bounded.
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const failed = await execute({
      ok: false,
      state: 'failed',
      error: {
        code: 'SYNTHETIC_NATIVE_READ_FAILED',
        message: `失败诊断 ${attempt}：${'模型消息'.repeat(4_000)}`,
        details: {
          sourceUri: `workspace://mods/event/m11_00_00_00-${attempt}.emevd.dcx`,
          sourcePath: `D:\\synthetic\\event\\m11_00_00_00-${attempt}.emevd.dcx`,
          sourceHash: 'c'.repeat(64),
          outerFileHash: 'd'.repeat(64),
          sourceRevision: 123,
          handle: `event-handle:${attempt}`,
          detail: '细节'.repeat(4_000),
          diagnostics: Array.from({ length: 1_000 }, (_value, index) => ({
            severity: index % 2 === 0 ? 'error' : 'warning',
            code: `D-${index}`,
            message: `诊断 ${index}：${'原生字段布局'.repeat(120)}`,
            sourceUri: `workspace://diagnostic/${index}`
          }))
        }
      }
    });
    assert.equal(failed.outer.ok, false);
    assert.equal(failed.outer.code, 'SYNTHETIC_NATIVE_READ_FAILED');
    assert.equal(failed.envelope.ok, false);
    assert.equal(failed.envelope.state, 'failed');
    const error = failed.envelope.error as {
      message?: string;
      messageTruncated?: boolean;
      details?: {
        sourceHash?: string;
        outerFileHash?: string;
        handle?: string;
        detail?: string;
        diagnostics?: { items?: unknown[]; total?: number; returned?: number; truncated?: boolean };
      };
    };
    assert.equal(error.messageTruncated, true);
    assert.ok((error.message?.length ?? 0) < 2_000);
    assert.equal(error.details?.sourceHash, 'c'.repeat(64));
    assert.equal(error.details?.outerFileHash, 'd'.repeat(64));
    assert.equal(error.details?.handle, `event-handle:${attempt}`);
    assert.ok((error.details?.detail?.length ?? 0) < 500);
    assert.equal(error.details?.diagnostics?.total, 1_000);
    assert.ok((error.details?.diagnostics?.returned ?? 0) <= 8);
    assert.equal(error.details?.diagnostics?.truncated, true);
    assert.ok(Buffer.byteLength(failed.outer.content, 'utf8') <= 8_192);
    assert.ok(failed.outer.content.length <= 8_192);
  }

  // Some callers put stable identity and diagnostics on the error object
  // itself. They must survive the same bounded projection as nested details.
  const topLevelFailure = await execute({
    ok: false,
    state: 'failed',
    error: {
      code: 'TOP_LEVEL_NATIVE_READ_FAILED',
      message: '顶层失败'.repeat(4_000),
      sourcePath: 'D:\\synthetic\\event\\top-level.emevd.dcx',
      sourceHash: 'f'.repeat(64),
      handle: 'top-level-event-handle',
      diagnostics: Array.from({ length: 1000 }, (_value, index) => ({
        severity: 'error', code: `TOP-${index}`, message: `诊断 ${index}`
      }))
    } as NonNullable<ToolResult['error']>
  });
  assert.equal(topLevelFailure.outer.ok, false);
  assert.equal(topLevelFailure.envelope.error.code, 'TOP_LEVEL_NATIVE_READ_FAILED');
  assert.equal(topLevelFailure.envelope.error.sourcePath, 'D:\\synthetic\\event\\top-level.emevd.dcx');
  assert.equal(topLevelFailure.envelope.error.sourceHash, 'f'.repeat(64));
  assert.equal(topLevelFailure.envelope.error.handle, 'top-level-event-handle');
  assert.equal(topLevelFailure.envelope.error.diagnostics.total, 1000);
  assert.ok(topLevelFailure.envelope.error.diagnostics.returned <= 8);
  assert.equal(topLevelFailure.envelope.error.diagnostics.truncated, true);
  assert.ok(Buffer.byteLength(topLevelFailure.outer.content, 'utf8') <= 8_192);
  assert.ok(topLevelFailure.outer.content.length <= 8_192);

  // A post-commit failure state is not an ordinary retryable failure. The
  // bridge must preserve the lifecycle state even when the error is non-ok;
  // in particular it must not turn verification_failed/committed/partial
  // into a successful or generic failed envelope.
  for (const state of ['committed', 'verification_failed', 'partial'] as const) {
    const postCommit = await execute({
      ok: false,
      state: state as unknown as NonNullable<ToolResult['state']>,
      error: {
        code: 'POST_COMMIT_REFRESH_FAILED',
        message: 'write result requires reread',
        details: { operationId: 'op-committed', sourceHash: 'e'.repeat(64) }
      }
    });
    assert.equal(postCommit.outer.ok, false);
    assert.equal(postCommit.envelope.ok, false);
    assert.equal(postCommit.envelope.state, state);
    assert.equal(postCommit.envelope.error.code, 'POST_COMMIT_REFRESH_FAILED');
  }

  // verification_failed means a write already committed. It must retain its
  // lifecycle so callers cannot mistake it for a safe-to-retry ordinary error.
  for (const state of ['completed', 'staged', 'committed', 'verification_failed'] as const) {
    const data = { operationId: 'fixture-op', sourceHash: 'a'.repeat(64) };
    const succeeded = await execute({ ok: true, state, data });
    assert.equal(succeeded.outer.ok, true);
    assert.equal(succeeded.outer.code, undefined);
    assert.equal(succeeded.envelope.ok, true);
    assert.equal(succeeded.envelope.state, state);
    assert.deepEqual(succeeded.envelope.data.record, data);
  }
  const legacySuccess = await execute({ ok: true, data: { files: 1 } });
  assert.equal(legacySuccess.outer.ok, true);
  assert.equal(legacySuccess.envelope.state, 'completed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentToolEnvelopeSmoke().then(() => {
    console.log('Agent tool envelope smoke passed.');
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

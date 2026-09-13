/**
 * Production host-composition fixture for the EMEVD native proof boundary.
 *
 * This deliberately uses the real AgentToolBridge and desktop task-record
 * gateway.  Only the native read/write handlers are controlled fixtures: no
 * game file, Mod resource, Bridge process, or production proof/projection
 * implementation is replaced.  The fixture therefore exercises the same
 * ToolRegistry gate, final bounded envelope, host target attachment, and
 * receipt promotion used by the production host.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentToolBridge, ToolRegistry } from '../packages/core/dist/index.js';
import { createAgentTaskRecordGateway } from '../apps/desktop/src/main/agentTaskRecord.ts';

const MAX_RESULT_BYTES = 8_192;
const MAX_RESULT_CHARS = 8_192;
const NONCANONICAL_WARNING_CODE = 'EMEVD_NONCANONICAL_SOURCE_INSPECT_ONLY';
const fixtureRoot = await mkdtemp(join(tmpdir(), 'soulforge-emevd-proof-gate-'));
const liveHarnesses = [];
const completeFinalBytes = [];
let callSequence = 0;

function errorResult(error) {
  return {
    ok: false,
    state: 'failed',
    error: {
      code: typeof error?.code === 'string' ? error.code : 'FIXTURE_TOOL_FAILED',
      message: error instanceof Error ? error.message : String(error?.message ?? error)
    }
  };
}

function normalizeToken(value) {
  return String(value).trim().replaceAll('\\', '/').toLocaleLowerCase();
}

function eventKey(sourceUri, eventId) {
  return `${sourceUri}#${eventId}`;
}

function identityFor(harness, sourceUri, eventId) {
  const key = eventKey(sourceUri, eventId);
  const existing = harness.state.identities.get(key);
  if (existing) return existing;
  const identity = {
    sourceHash: `fixture-source-${eventId}`,
    outerFileHash: `fixture-outer-${eventId}`,
    sourceRevision: 1
  };
  harness.state.identities.set(key, identity);
  return identity;
}

function sourcePathFor(sourceUri) {
  return join(fixtureRoot, 'native-fixture', sourceUri.slice('file://'.length));
}

function makeIndexedFile(sourceUri) {
  const sourcePath = sourcePathFor(sourceUri);
  return {
    id: `fixture-${sourceUri}`,
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: sourceUri.slice('file://'.length),
    resourceKind: 'event',
    game: 'sekiro'
  };
}

function instructionFixture(index) {
  return {
    index,
    bank: 3,
    id: index,
    argsBase64: 'AA==',
    unknown: false,
    emedfName: `FixtureInstruction${index}`,
    typedArgs: [{ name: 'value', type: 's32', value: index }],
    diagnostics: []
  };
}

function completeReadData(harness, sourceUri, eventId, options = {}) {
  const identity = identityFor(harness, sourceUri, eventId);
  const sourcePath = sourcePathFor(sourceUri);
  const total = options.total ?? (eventId === 0 ? 0 : eventId === 20 ? 20 : 1);
  const instructions = Array.from({ length: total }, (_, index) => instructionFixture(index));
  const darkScript = options.darkScript ?? [
    `$Event(${eventId}, Restart, function() {`,
    ...instructions.map((instruction) => `  FixtureInstruction${instruction.index}(${instruction.index});`),
    '});'
  ].join('\n');
  return {
    ok: true,
    sourceUri,
    sourcePath,
    filePath: sourcePath,
    eventId,
    restBehavior: 1,
    instructionCount: total,
    total,
    offset: 0,
    limit: total,
    returned: total,
    truncated: false,
    darkScriptComplete: true,
    readRange: { start: 0, end: total },
    sourceHash: identity.sourceHash,
    outerFileHash: identity.outerFileHash,
    sourceRevision: identity.sourceRevision,
    game: 'sekiro',
    resourceKind: 'event',
    registryOrigin: 'imported',
    registryFingerprint: 'fixture-registry-v1',
    registry: { origin: 'imported', fingerprint: 'fixture-registry-v1' },
    format: 'darkscript',
    darkScript,
    instructions,
    diagnostics: Array.isArray(options.diagnostics) ? options.diagnostics : []
  };
}

function modeReadData(harness, sourceUri, eventId, input) {
  const mode = harness.state.readMode;
  if (mode === 'finalfailure') {
    return errorResult({ code: 'FIXTURE_NATIVE_READ_FAILED', message: 'controlled native final failure' });
  }
  if (mode === 'oversize') {
    return {
      ok: true,
      state: 'completed',
      data: completeReadData(harness, sourceUri, eventId, {
        total: 1,
        darkScript: `$Event(${eventId}, Restart, function() {\n  ${'X'.repeat(12_000)}\n});`
      })
    };
  }

  const complete = completeReadData(harness, sourceUri, eventId, {
    ...(mode === 'partial' ? { total: 20 } : {}),
    ...(harness.state.nativeDiagnostics.length > 0 ? { diagnostics: harness.state.nativeDiagnostics } : {})
  });
  if (mode === 'json' || input.format === 'json') {
    return {
      ok: true,
      state: 'completed',
      data: {
        ...complete,
        format: 'json',
        darkScriptComplete: false,
        darkScript: undefined
      }
    };
  }

  if (mode === 'partial' || (input.instructionOffset ?? 0) > 0 || input.instructionLimit !== undefined
    && input.instructionLimit < complete.total) {
    const offset = input.instructionOffset ?? 1;
    const limit = input.instructionLimit ?? 1;
    const returned = Math.max(0, Math.min(limit, complete.total - offset));
    return {
      ok: true,
      state: 'completed',
      data: {
        ...complete,
        offset,
        limit,
        returned,
        truncated: offset + returned < complete.total,
        darkScriptComplete: false,
        readRange: { start: offset, end: offset + returned },
        instructions: complete.instructions.slice(offset, offset + returned),
        darkScript: `$Event(${eventId}, Restart, function() {\n  FixtureInstruction${offset}(${offset});\n});`
      }
    };
  }

  return { ok: true, state: 'completed', data: complete };
}

function registerFixtureTools(harness, files) {
  const registry = new ToolRegistry();

  registry.register({
    name: 'update_agent_task_record',
    description: 'controlled host task-record update fixture',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: {},
    run: async (input, context) => {
      if (!context.taskRecord) return errorResult({ code: 'TASK_RECORD_UNAVAILABLE', message: 'fixture task record missing' });
      try {
        const snapshot = await context.taskRecord.update(input);
        return {
          ok: true,
          state: 'completed',
          data: {
            entryCount: snapshot.entries.length,
            statuses: snapshot.entries.map((entry) => ({ entryId: entry.entryId, status: entry.status }))
          }
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  });

  registry.register({
    name: 'search_events',
    description: 'controlled structured search_events ticket fixture',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string' },
    run: async () => ({
      ok: true,
      state: 'completed',
      data: { events: harness.state.searchResults }
    })
  });

  registry.register({
    name: 'read_emevd_event',
    description: 'controlled native EMEVD event read fixture',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      file: 'string',
      eventId: 'safe-integer',
      format: 'enum:darkscript|json?',
      instructionOffset: 'safe-integer?',
      instructionLimit: 'safe-integer?'
    },
    run: async (input, context) => {
      const directFile = files.find((candidate) => [candidate.sourceUri, candidate.sourcePath, candidate.absolutePath, candidate.relativePath]
        .some((value) => normalizeToken(value) === normalizeToken(input.file)));
      const inputBaseName = normalizeToken(input.file).split('/').at(-1);
      const aliasedFile = context.hostResolvedEmevdEventTarget?.canonical === false
        ? files.find((candidate) => normalizeToken(candidate.relativePath).split('/').at(-1) === inputBaseName)
        : undefined;
      const file = directFile ?? aliasedFile;
      if (!file) return errorResult({ code: 'FIXTURE_SOURCE_NOT_FOUND', message: `fixture source not found: ${input.file}` });
      return modeReadData(harness, file.sourceUri, input.eventId, input);
    }
  });

  registry.register({
    name: 'apply_emevd_dsl',
    description: 'controlled native EMEVD event write fixture',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      file: 'string',
      dsl: 'string',
      mode: 'enum:patch|dark-script?',
      eventId: 'safe-integer?',
      scope: 'enum:file|event?',
      sourceHash: 'string?',
      outerFileHash: 'string?',
      sourceRevision: 'number?',
      darkScriptComplete: 'boolean?'
    },
    run: async (input) => {
      harness.state.writeCalls.push({ ...input });
      if (harness.state.writeFailuresRemaining > 0) {
        harness.state.writeFailuresRemaining -= 1;
        return errorResult({
          code: 'EMEVD_DSL_SOURCE_STALE',
          message: 'controlled native fixture CAS failure after writer entry'
        });
      }
      return {
        ok: true,
        state: 'committed',
        data: {
          status: 'committed',
          eventId: input.eventId,
          sourceHash: input.sourceHash,
          outerFileHash: input.outerFileHash,
          sourceRevision: input.sourceRevision,
          mutationCount: 1
        }
      };
    }
  });

  registry.register({
    name: 'rollback_operation',
    description: 'controlled rollback action that releases the real task-record mutation count',
    permission: 'rollback',
    permissionLevel: 'rollback',
    inputSchema: { opId: 'string', objectName: 'string?' },
    run: async (input, context) => {
      if (!context.taskRecord) return errorResult({ code: 'TASK_RECORD_UNAVAILABLE', message: 'fixture task record missing' });
      const released = await context.taskRecord.releaseMutationCount({
        propertyKey: 'emevd',
        ...(typeof input.objectName === 'string' ? { objectName: input.objectName } : {}),
        count: 1,
        reason: `controlled rollback ${input.opId}`
      });
      if (!released.ok) return errorResult(released);
      return {
        ok: true,
        state: 'committed',
        data: { status: 'rolled_back', opId: input.opId, released: released.released }
      };
    }
  });

  return registry;
}

function createHarness(sessionId, sourceUris = ['file://event/fixture.emevd.dcx']) {
  const files = sourceUris.map(makeIndexedFile);
  const state = {
    readMode: 'complete',
    searchResults: [],
    identities: new Map(),
    writeCalls: [],
    writeFailuresRemaining: 0,
    nativeDiagnostics: []
  };
  const gateway = createAgentTaskRecordGateway(fixtureRoot, sessionId);
  const workspaceIndex = {
    workspaceId: `workspace://emevd-proof/${sessionId}`,
    getFiles: () => files
  };
  const session = {
    meta: { workspaceId: workspaceIndex.workspaceId, game: 'sekiro' },
    layers: { overlayRoot: fixtureRoot, baseRoot: fixtureRoot }
  };
  const context = {
    workspaceIndex,
    taskRecord: gateway,
    requireTaskRecord: true,
    mode: 'fullPermission',
    modeCeiling: 'fullPermission',
    session
  };
  const harness = { files, state, gateway, context };
  const registry = registerFixtureTools(harness, files);
  harness.bridge = createAgentToolBridge({ registry, context });
  liveHarnesses.push(harness);
  return harness;
}

async function call(harness, name, input) {
  const response = await harness.bridge.executeTool({
    id: `fixture-${++callSequence}`,
    name,
    argumentsJson: JSON.stringify(input)
  });
  assert.ok(typeof response.content === 'string', `${name} must return content`);
  assert.ok(Buffer.byteLength(response.content, 'utf8') <= MAX_RESULT_BYTES,
    `${name} exceeded bounded byte output: ${Buffer.byteLength(response.content, 'utf8')}`);
  assert.ok(response.content.length <= MAX_RESULT_CHARS,
    `${name} exceeded bounded character output: ${response.content.length}`);
  return { response, envelope: JSON.parse(response.content) };
}

function assertSuccess(result, label) {
  assert.equal(result.response.ok, true, `${label}: ${result.response.code ?? 'failed'} ${result.response.content}`);
  assert.equal(result.envelope.ok, true, `${label}: envelope must be successful`);
  return result.envelope;
}

function assertDenied(result, code, label) {
  assert.equal(result.response.ok, false, `${label}: expected denial`);
  assert.equal(result.response.code, code, `${label}: unexpected code ${result.response.code}: ${result.response.content}`);
  assert.equal(result.envelope.ok, false, `${label}: denied envelope must be false`);
}

async function declareTarget(harness, objectName) {
  const result = await call(harness, 'update_agent_task_record', {
    objectName,
    propertyKey: 'target',
    value: '待执行 EMEVD 事件修改',
    kind: 'target'
  });
  assertSuccess(result, `${objectName} target`);
}

async function searchTicket(harness, query, events, objectName) {
  harness.state.searchResults = events.map((event) => (
    objectName ? { ...event, name: objectName } : event
  ));
  const result = await call(harness, 'search_events', { query });
  const envelope = assertSuccess(result, `${query} search`);
  const searchId = envelope.data?.record?.searchId;
  assert.equal(typeof searchId, 'string', `${query} search must return host ticket`);
  return searchId;
}

async function addEvidence(harness, objectName, sourceUri, eventId, searchId) {
  const result = await call(harness, 'update_agent_task_record', {
    objectName,
    propertyKey: 'emevd',
    value: `sourceUri=${sourceUri} eventId=${eventId}`,
    kind: 'evidence',
    evidence: [`search_events sourceUri=${sourceUri} eventId=${eventId}`],
    searchId,
    mutationBudget: 1
  });
  return assertSuccess(result, `${objectName} evidence ${eventId}`);
}

async function writeInput(harness, sourceUri, eventId, identity, dsl = '$Event(1, Restart, function() {\n});') {
  return call(harness, 'apply_emevd_dsl', {
    file: sourceUri,
    dsl,
    mode: 'dark-script',
    scope: 'event',
    eventId,
    sourceHash: identity.sourceHash,
    outerFileHash: identity.outerFileHash,
    sourceRevision: identity.sourceRevision,
    darkScriptComplete: true
  });
}

async function prepareSingleEvidence(harness, sourceUri, eventId, objectName = `event-${eventId}`) {
  await declareTarget(harness, objectName);
  const searchId = await searchTicket(harness, `eventId=${eventId}`, [{ sourceUri, eventId }], objectName);
  await addEvidence(harness, objectName, sourceUri, eventId, searchId);
  return { objectName, identity: identityFor(harness, sourceUri, eventId) };
}

async function runCompleteWriteCase(label, eventId) {
  const sourceUri = `file://event/${label}.emevd.dcx`;
  const harness = createHarness(`complete-${label}`, [sourceUri]);
  const prepared = await prepareSingleEvidence(harness, sourceUri, eventId, `complete-${label}`);
  const read = await call(harness, 'read_emevd_event', { file: sourceUri, eventId, format: 'darkscript' });
  const readEnvelope = assertSuccess(read, `${label} complete read`);
  assert.equal(readEnvelope.completeness, 'complete', `${label} read must be complete`);
  assert.equal(readEnvelope.truncated, false, `${label} read must not be truncated`);
  assert.equal(readEnvelope.data?.record?.projection, 'complete_native_dsl', `${label} must deliver complete DSL projection`);
  assert.equal((await harness.gateway.read()).entries.find((entry) => entry.kind === 'evidence')?.status, 'verified');
  const write = await writeInput(harness, sourceUri, eventId, prepared.identity,
    `$Event(${eventId}, Restart, function() {\n});`);
  assertSuccess(write, `${label} write gate`);
  assert.equal(harness.state.writeCalls.length, 1, `${label} native fixture write must run once`);
  completeFinalBytes.push({
    label,
    eventId,
    readBytes: Buffer.byteLength(read.response.content, 'utf8'),
    readChars: read.response.content.length,
    writeBytes: Buffer.byteLength(write.response.content, 'utf8')
  });
}

async function runNoncanonicalInspectOnlyCase() {
  const sourceUri = 'file://event/noncanonical-inspect-only.emevd.dcx';
  const eventId = 710;
  const harness = createHarness('noncanonical-inspect-only', [sourceUri]);
  harness.state.nativeDiagnostics = Array.from({ length: 40 }, (_, index) => ({
    severity: 'warning',
    code: index === 39 ? NONCANONICAL_WARNING_CODE : `FIXTURE_NATIVE_DIAGNOSTIC_${index}`,
    message: index === 39 ? 'native counterfeit same-code diagnostic' : `native diagnostic ${index}`
  }));
  const prepared = await prepareSingleEvidence(harness, sourceUri, eventId, 'noncanonical-inspect-only');
  const basename = 'noncanonical-inspect-only.emevd.dcx';

  // The fixture handler only resolves this basename because the real host
  // target is noncanonical; the warning itself must come from ToolRegistry's
  // post-run host composition, never from this fixture handler.
  const read = await call(harness, 'read_emevd_event', { file: basename, eventId, format: 'darkscript' });
  const readEnvelope = assertSuccess(read, 'noncanonical basename read');
  assert.equal(readEnvelope.completeness, 'complete');
  assert.equal(readEnvelope.data?.record?.projection, 'complete_native_dsl');
  const diagnostics = readEnvelope.data?.record?.diagnostics;
  assert.ok(Array.isArray(diagnostics), 'noncanonical complete projection must expose diagnostics');
  assert.equal(diagnostics[0]?.code, NONCANONICAL_WARNING_CODE,
    'host inspect-only warning must remain first even with more than 32 native diagnostics');
  assert.equal(diagnostics[0]?.severity, 'warning');
  assert.match(diagnostics[0]?.message ?? '', /仅供检查.*写回凭据/u);
  assert.equal(diagnostics.filter((item) => item?.code === NONCANONICAL_WARNING_CODE).length, 1,
    'native same-code diagnostics must not duplicate or replace the host warning');
  assert.equal(diagnostics[0]?.message, '当前 file 未直接命中工作区索引的 canonical sourceUri/sourcePath/relativePath/absolutePath；本次 native read 仅供检查，不能生成写回凭据。请使用 search_events 返回的完整 sourceUri 重新读取。');
  assert.equal(diagnostics.length, 32, 'complete projection keeps its bounded diagnostic cap');
  assert.equal((await harness.gateway.read()).entries.find((entry) => entry.kind === 'evidence')?.status, 'candidate',
    'noncanonical read must not mint a native proof');

  const basenameWrite = await writeInput(harness, basename, eventId, prepared.identity);
  assertDenied(basenameWrite, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'basename read must remain inspect-only');
  const canonicalWriteBeforeReread = await writeInput(harness, sourceUri, eventId, prepared.identity);
  assertDenied(canonicalWriteBeforeReread, 'TASK_RECORD_NATIVE_PROOF_REQUIRED',
    'canonical write must not reuse a noncanonical read');
  assert.equal(harness.state.writeCalls.length, 0, 'noncanonical flow must not enter the writer');

  const reread = await call(harness, 'read_emevd_event', { file: sourceUri, eventId, format: 'darkscript' });
  const rereadEnvelope = assertSuccess(reread, 'canonical reread after inspect-only read');
  assert.equal(rereadEnvelope.data?.record?.projection, 'complete_native_dsl');
  assert.equal(rereadEnvelope.data?.record?.diagnostics?.some((item) => item?.code === NONCANONICAL_WARNING_CODE), false,
    'canonical reread must not carry the noncanonical warning');
  assert.equal((await harness.gateway.read()).entries.find((entry) => entry.kind === 'evidence')?.status, 'verified');
  assertSuccess(await writeInput(harness, sourceUri, eventId, prepared.identity),
    'canonical reread must restore the write gate');
  assert.equal(harness.state.writeCalls.length, 1);
}

async function runCanonicalLocatorFormsCase() {
  const sourceUri = 'file://event/direct-canonical-locators.emevd.dcx';
  const locatorKinds = ['sourcePath', 'relativePath'];
  for (const locatorKind of locatorKinds) {
    const harness = createHarness(`direct-canonical-${locatorKind}`, [sourceUri]);
    const prepared = await prepareSingleEvidence(
      harness,
      sourceUri,
      711,
      `direct-canonical-${locatorKind}`
    );
    const locator = harness.files[0][locatorKind];
    const read = await call(harness, 'read_emevd_event', { file: locator, eventId: 711, format: 'darkscript' });
    const readEnvelope = assertSuccess(read, `${locatorKind} direct canonical read`);
    assert.equal(readEnvelope.data?.record?.projection, 'complete_native_dsl');
    assert.equal(readEnvelope.data?.record?.diagnostics?.some((item) => item?.code === NONCANONICAL_WARNING_CODE), false,
      `${locatorKind} direct canonical read must not carry inspect-only warning`);
    assert.equal((await harness.gateway.read()).entries.find((entry) => entry.kind === 'evidence')?.status, 'verified');
    assertSuccess(await writeInput(harness, locator, 711, prepared.identity),
      `${locatorKind} direct canonical write`);
    assert.equal(harness.state.writeCalls.length, 1);
  }
}

async function runNoProofCase(label, mode, readInput, expectedReadOk, eventId = 301) {
  const sourceUri = `file://event/${label}.emevd.dcx`;
  const harness = createHarness(`no-proof-${label}`, [sourceUri]);
  const prepared = await prepareSingleEvidence(harness, sourceUri, eventId, `no-proof-${label}`);
  harness.state.readMode = mode;
  const read = await call(harness, 'read_emevd_event', { file: sourceUri, eventId, ...readInput });
  assert.equal(read.response.ok, expectedReadOk, `${label} read outcome mismatch`);
  if (expectedReadOk) {
    assert.notEqual(read.envelope.data?.record?.projection, 'complete_native_dsl', `${label} must not mint complete proof projection`);
    if (label === 'partial') {
      assert.equal(read.envelope.pagination?.total, 20);
      assert.equal(read.envelope.pagination?.offset, 0);
      assert.equal(read.envelope.pagination?.returnedCount, 8);
      assert.equal(read.envelope.pagination?.truncated, true);
      assert.equal(read.envelope.data?.record?.darkScriptComplete, false);
    }
    if (label === 'tail') {
      assert.equal(read.envelope.pagination?.total, 20);
      assert.equal(read.envelope.pagination?.offset, 12);
      assert.equal(read.envelope.pagination?.returnedCount, 8);
      assert.equal(read.envelope.pagination?.truncated, false);
      assert.equal(read.envelope.data?.record?.darkScriptComplete, false);
    }
  } else {
    assert.equal(read.envelope.ok, false, `${label} final failure must be false`);
  }
  const write = await writeInput(harness, sourceUri, 301, prepared.identity);
  assertDenied(write, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', `${label} write without complete proof`);
  assert.equal(harness.state.writeCalls.length, 0, `${label} fixture writer must not run`);
}

async function runSameIdCrossFileCase() {
  const sourceA = 'file://event/cross-a.emevd.dcx';
  const sourceB = 'file://event/cross-b.emevd.dcx';
  const harness = createHarness('same-id-cross-file', [sourceA, sourceB]);
  await declareTarget(harness, 'same-id-cross-file');
  const ticketA = await searchTicket(harness, 'eventId=700 sourceUri=file://event/cross-a.emevd.dcx', [{ sourceUri: sourceA, eventId: 700 }], 'same-id-cross-file');
  await addEvidence(harness, 'same-id-cross-file', sourceA, 700, ticketA);
  const ticketB = await searchTicket(harness, 'eventId=700 sourceUri=file://event/cross-b.emevd.dcx', [{ sourceUri: sourceB, eventId: 700 }], 'same-id-cross-file');
  await addEvidence(harness, 'same-id-cross-file', sourceB, 700, ticketB);

  const readA = await call(harness, 'read_emevd_event', { file: sourceA, eventId: 700 });
  assertSuccess(readA, 'same ID file A read');
  const writeB = await writeInput(harness, sourceB, 700, identityFor(harness, sourceB, 700));
  assertDenied(writeB, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'same eventId in another file must not reuse proof');
  assert.equal(harness.state.writeCalls.length, 0);
}

async function runHashRevisionMismatchCase() {
  const sourceUri = 'file://event/hash-revision.emevd.dcx';
  const harness = createHarness('hash-revision-mismatch', [sourceUri]);
  const prepared = await prepareSingleEvidence(harness, sourceUri, 701, 'hash-revision-mismatch');
  const read = await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 701 });
  assertSuccess(read, 'hash/revision baseline read');

  const hashMismatch = await writeInput(harness, sourceUri, 701, {
    ...prepared.identity,
    sourceHash: 'fixture-source-different'
  });
  assertDenied(hashMismatch, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'different sourceHash must deny write');
  const outerHashMismatch = await writeInput(harness, sourceUri, 701, {
    ...prepared.identity,
    outerFileHash: 'fixture-outer-different'
  });
  assertDenied(outerHashMismatch, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'different outerFileHash must deny write');
  const revisionMismatch = await writeInput(harness, sourceUri, 701, {
    ...prepared.identity,
    sourceRevision: prepared.identity.sourceRevision + 1
  });
  assertDenied(revisionMismatch, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'different sourceRevision must deny write');
  assert.equal(harness.state.writeCalls.length, 0);
}

async function runWriterFailureRetryCase() {
  const sourceUri = 'file://event/writer-failure-retry.emevd.dcx';
  const harness = createHarness('writer-failure-retry', [sourceUri]);
  const prepared = await prepareSingleEvidence(harness, sourceUri, 708, 'writer-failure-retry');
  const identity = prepared.identity;
  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 708 }), 'writer failure baseline read');
  harness.state.writeFailuresRemaining = 1;
  const failedWrite = await writeInput(harness, sourceUri, 708, identity);
  assertDenied(failedWrite, 'EMEVD_DSL_SOURCE_STALE', 'writer-entered CAS failure must surface its code');
  assert.equal(harness.state.writeCalls.length, 1, 'failed native writer must have been entered');
  const afterFailure = await harness.gateway.read();
  const evidenceAfterFailure = afterFailure.entries.find((entry) => entry.kind === 'evidence');
  assert.equal(evidenceAfterFailure?.mutationUsed, 0, 'failed writer must release the reserved mutation budget');

  // releaseMutationReservation also clears native receipts; a correct retry
  // therefore rereads the complete event before entering the writer again.
  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 708 }), 'writer failure fresh read');
  assertSuccess(await writeInput(harness, sourceUri, 708, identity), 'writer failure correct retry');
  assert.equal(harness.state.writeCalls.length, 2, 'correct retry must re-enter the writer');
  const afterRetry = await harness.gateway.read();
  assert.equal(afterRetry.entries.find((entry) => entry.kind === 'evidence')?.mutationUsed, 1);
}

async function runRollbackProofClearCase() {
  const sourceUri = 'file://event/rollback-proof-clear.emevd.dcx';
  const harness = createHarness('rollback-proof-clear', [sourceUri]);
  const objectName = 'rollback-proof-clear';
  const prepared = await prepareSingleEvidence(harness, sourceUri, 709, objectName);
  const identity = prepared.identity;
  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 709 }), 'rollback baseline read');
  assertSuccess(await writeInput(harness, sourceUri, 709, identity), 'rollback baseline write');
  assert.equal(harness.state.writeCalls.length, 1);

  const rollback = await call(harness, 'rollback_operation', {
    opId: 'fixture-rollback-709',
    objectName
  });
  assertSuccess(rollback, 'rollback action');
  const afterRollback = await harness.gateway.read();
  assert.equal(afterRollback.entries.find((entry) => entry.kind === 'evidence')?.mutationUsed, 0,
    'rollback action must release the consumed mutation count');

  const oldReceipt = await writeInput(harness, sourceUri, 709, identity);
  assertDenied(oldReceipt, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'rollback must clear the old native receipt');
  assert.equal(harness.state.writeCalls.length, 1, 'old rollback credential must not enter writer');
  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 709 }), 'rollback fresh read');
  assertSuccess(await writeInput(harness, sourceUri, 709, identity), 'rollback fresh write');
  assert.equal(harness.state.writeCalls.length, 2, 'fresh receipt after rollback must restore write access');
}

async function runFinalizeFreshReadCase() {
  const sourceUri = 'file://event/finalize-fresh-read.emevd.dcx';
  const harness = createHarness('finalize-fresh-read', [sourceUri]);
  const objectName = 'finalize-fresh-read';
  await declareTarget(harness, objectName);
  const firstTicket = await searchTicket(harness, 'first-finalize-ticket', [{ sourceUri, eventId: 702 }], objectName);
  await addEvidence(harness, objectName, sourceUri, 702, firstTicket);
  const secondTicket = await searchTicket(harness, 'second-finalize-ticket', [{ sourceUri, eventId: 702 }], objectName);
  await addEvidence(harness, objectName, sourceUri, 702, secondTicket);
  const identity = identityFor(harness, sourceUri, 702);

  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 702 }), 'finalize baseline read');
  assertSuccess(await writeInput(harness, sourceUri, 702, identity), 'first finalize write');
  assert.equal(harness.state.writeCalls.length, 1);

  const noFreshRead = await writeInput(harness, sourceUri, 702, identity);
  assertDenied(noFreshRead, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'finalize must clear all old native receipts');
  assert.equal(harness.state.writeCalls.length, 1);

  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 702 }), 'fresh reread after finalize');
  assertSuccess(await writeInput(harness, sourceUri, 702, identity), 'fresh reread restores second write');
  assert.equal(harness.state.writeCalls.length, 2);
}

async function runSameFileVersionInvalidationCase() {
  const sourceUri = 'file://event/version-invalidation.emevd.dcx';
  const harness = createHarness('same-file-version-invalidation', [sourceUri]);
  const objectName = 'same-file-version-invalidation';
  await declareTarget(harness, objectName);
  const ticket = await searchTicket(harness, 'version-events', [
    { sourceUri, eventId: 703 },
    { sourceUri, eventId: 704 }
  ], objectName);
  await addEvidence(harness, objectName, sourceUri, 703, ticket);
  await addEvidence(harness, objectName, sourceUri, 704, ticket);
  harness.state.identities.set(eventKey(sourceUri, 703), {
    sourceHash: 'version-v1-event1', outerFileHash: 'version-outer-v1', sourceRevision: 1
  });
  harness.state.identities.set(eventKey(sourceUri, 704), {
    sourceHash: 'version-v2-event2', outerFileHash: 'version-outer-v2', sourceRevision: 2
  });

  const firstIdentity = identityFor(harness, sourceUri, 703);
  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 703 }), 'same-file event1 v1 read');
  assertSuccess(await call(harness, 'read_emevd_event', { file: sourceUri, eventId: 704 }), 'same-file event2 v2 read');
  const staleEvent1 = await writeInput(harness, sourceUri, 703, firstIdentity);
  assertDenied(staleEvent1, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'new same-file identity must clear event1 v1 proof');
  assert.equal(harness.state.writeCalls.length, 0);
}

async function runAmbiguousAndWrongDomainCases() {
  const sourceA = 'file://event/ambiguous-a.emevd.dcx';
  const sourceB = 'file://event/ambiguous-b.emevd.dcx';
  const harness = createHarness('ambiguous-tickets', [sourceA, sourceB]);
  await declareTarget(harness, 'ambiguous-tickets');
  const ambiguousTicket = await searchTicket(harness, 'same event in two files', [
    { sourceUri: sourceA, eventId: 705 },
    { sourceUri: sourceB, eventId: 705 }
  ]);
  const ambiguousEvidence = await call(harness, 'update_agent_task_record', {
    objectName: 'ambiguous-tickets',
    propertyKey: 'emevd',
    value: 'eventId=705',
    kind: 'evidence',
    evidence: ['eventId=705'],
    searchId: ambiguousTicket,
    mutationBudget: 1
  });
  assertDenied(ambiguousEvidence, 'TASK_RECORD_EMEVD_TARGET_AMBIGUOUS', 'same event ticket across files must require sourceUri');

  const wrongDomain = createHarness('wrong-domain-ticket', [sourceA]);
  await declareTarget(wrongDomain, 'wrong-domain-ticket');
  const wrongTicket = await wrongDomain.gateway.recordSearch({
    toolName: 'search_msb_parts',
    query: 'eventId=706',
    result: { events: [{ sourceUri: sourceA, eventId: 706 }] }
  });
  const wrongEvidence = await call(wrongDomain, 'update_agent_task_record', {
    objectName: 'wrong-domain-ticket',
    propertyKey: 'emevd',
    value: `sourceUri=${sourceA} eventId=706`,
    kind: 'evidence',
    evidence: [`sourceUri=${sourceA} eventId=706`],
    searchId: wrongTicket.searchId,
    mutationBudget: 1
  });
  assertDenied(wrongEvidence, 'TASK_RECORD_EMEVD_SEARCH_DOMAIN_REQUIRED', 'MSB ticket must not authorize EMEVD evidence');
}

async function runPersistedVerifiedForgeryCase() {
  const sourceUri = 'file://event/persisted-verified.emevd.dcx';
  const sessionId = 'persisted-verified-forgery';
  const initial = createHarness(sessionId, [sourceUri]);
  const prepared = await prepareSingleEvidence(initial, sourceUri, 707, sessionId);
  const snapshot = await initial.gateway.read();
  const original = await readFile(snapshot.path, 'utf8');
  assert.match(original, /- kind: evidence\r?\n  - status: candidate/u);
  await writeFile(snapshot.path, original.replace(/(- kind: evidence\r?\n  - status: )candidate/u, '$1verified'), 'utf8');

  const reloaded = createHarness(sessionId, [sourceUri]);
  const reloadedSnapshot = await reloaded.gateway.read();
  assert.equal(reloadedSnapshot.entries.find((entry) => entry.kind === 'evidence')?.status, 'verified');
  const forgedWrite = await writeInput(reloaded, sourceUri, 707, prepared.identity);
  assertDenied(forgedWrite, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'persisted verified label must not mint host receipt');
  assert.equal(reloaded.state.writeCalls.length, 0);
}

try {
  await runCompleteWriteCase('small', 1);
  await runCompleteWriteCase('empty', 0);
  await runCompleteWriteCase('twenty-instruction', 20);
  await runNoncanonicalInspectOnlyCase();
  await runCanonicalLocatorFormsCase();

  await runNoProofCase('partial', 'partial', { instructionOffset: 0, instructionLimit: 8 }, true, 20);
  await runNoProofCase('tail', 'partial', { instructionOffset: 12, instructionLimit: 8 }, true, 20);
  await runNoProofCase('json', 'json', { format: 'json' }, true);
  await runNoProofCase('oversize', 'oversize', { instructionLimit: 1 }, false);
  await runNoProofCase('finalfailure', 'finalfailure', {}, false);

  await runSameIdCrossFileCase();
  await runHashRevisionMismatchCase();
  await runWriterFailureRetryCase();
  await runFinalizeFreshReadCase();
  await runSameFileVersionInvalidationCase();
  await runRollbackProofClearCase();
  await runAmbiguousAndWrongDomainCases();
  await runPersistedVerifiedForgeryCase();

  console.log(JSON.stringify({
    ok: true,
    contract: 'production-agent-emevd-proof-gate-host-composition',
    checks: [
      'complete-small-empty-20-bounded-and-write-enabled',
      'noncanonical-basename-inspect-only-warning-projection-and-proof-denial',
      'indexed-sourcePath-and-relativePath-direct-canonical-read-write',
      'partial-tail-json-success-without-proof',
      'oversize-and-finalfailure-without-proof',
      'same-event-id-cross-file-isolation',
      'source-hash-outer-file-hash-and-revision-cas-mismatch-denied',
      'writer-failure-releases-budget-and-fresh-retry-restores',
      'finalize-clears-receipt-and-fresh-read-restores',
      'same-file-new-version-clears-old-event-receipt',
      'rollback-action-clears-proof-and-fresh-read-restores',
      'ambiguous-multifile-ticket-and-wrong-domain-ticket-denied',
      'persisted-verified-forgery-denied',
      'bounded-tool-content-and-host-receipt'
    ],
    completeFinalBytes: [...completeFinalBytes].sort((left, right) => left.eventId - right.eventId)
  }, null, 2));
} finally {
  for (const harness of liveHarnesses) {
    await harness.gateway.read().catch(() => undefined);
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}

/**
 * v0.5 Architecture Scaffold vertical-slice smoke tests.
 *
 * Covers:
 * ResourceURI, ResourceGraph, PatchIR, Transaction (text/raw),
 * AI tool policy, VFS, Bridge protocol scaffold.
 *
 * No frontend UI. No native parser/writer claims.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMA_VERSION,
  createFieldUri,
  createResourceUri,
  createSyntheticFixtureProvenance,
  formatFieldUri,
  formatResourceUri,
  parseFieldUri,
  parseResourceUri,
  syntheticFixtureConfidence,
  validateFieldUri,
  validateResourceUri
} from '@soulforge/shared';
import { MemoryAuditLogStore } from '../audit-log/memoryAuditLog.js';
import {
  createScaffoldToolRegistry,
  type ScaffoldToolContext
} from '../ai-tools/scaffoldToolRegistry.js';
import {
  buildScaffoldCapabilityMatrix,
  createSyntheticInspectEnvelope,
  createTypedFailureEnvelope,
  schemaMismatchFailure,
  unsupportedNativeWriterFailure
} from '../bridge/bridgeProtocolScaffold.js';
import {
  collectAffectedResources,
  createPatchIr,
  createRawByteRangeOperation,
  createTextEditOperation,
  estimatePatchRisk,
  validatePatchIr
} from '../patch-engine/patchIr.js';
import { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { buildVfsFromWorkspace } from '../vfs/buildVfs.js';

async function main(): Promise<void> {
  const results: string[] = [];

  // --- 1. ResourceURI ---
  const uri = createResourceUri({
    game: 'sekiro',
    overlay: 'overlay',
    physicalPath: 'msg/note.txt',
    resourceKind: 'msg',
    symbolPath: 'entries/1000',
    version: 'v1',
    contentHash: 'aabbccddeeff0011'
  });
  const formatted = formatResourceUri(uri);
  const parsed = parseResourceUri(formatted);
  if (parsed.game !== 'sekiro' || parsed.overlay !== 'overlay' || parsed.physicalPath !== 'msg/note.txt') {
    throw new Error(`ResourceURI roundtrip failed: ${formatted}`);
  }
  if (parsed.symbolPath !== 'entries/1000' || parsed.contentHash !== 'aabbccddeeff0011') {
    throw new Error('ResourceURI symbol/hash roundtrip failed.');
  }
  const validation = validateResourceUri(formatted);
  if (!validation.ok) throw new Error(`validateResourceUri failed: ${validation.errors.join('; ')}`);

  const field = createFieldUri({
    game: 'sekiro',
    overlay: 'overlay',
    physicalPath: 'param/game.param',
    resourceKind: 'param',
    fieldPath: 'rows.1.weight'
  });
  const fieldFormatted = formatFieldUri(field);
  const fieldParsed = parseFieldUri(fieldFormatted);
  if (fieldParsed.fieldPath !== 'rows.1.weight') {
    throw new Error(`FieldURI roundtrip failed: ${fieldFormatted}`);
  }
  if (!validateFieldUri(fieldFormatted).ok) throw new Error('validateFieldUri failed.');
  results.push('ResourceURI/FieldURI ok');

  // --- 2. ResourceGraph ---
  const graph = new MemoryResourceGraph('ws-scaffold');
  const nodeA = graph.addNode({
    id: 'n1',
    kind: 'resource',
    uri: formatted,
    label: 'note.txt',
    resourceKind: 'msg',
    overlay: 'overlay',
    resourceUri: uri
  });
  const nodeB = graph.addNode({
    id: 'n2',
    kind: 'synthetic',
    uri: 'synthetic://event/1',
    label: 'synthetic event',
    resourceKind: 'event',
    overlay: 'synthetic'
  });
  graph.addEdge({
    id: 'e1',
    kind: 'references',
    fromId: nodeA.id,
    toId: nodeB.id,
    label: 'text refs event'
  });
  graph.attachProvenance({
    targetId: nodeB.id,
    targetKind: 'node',
    chain: { sources: [createSyntheticFixtureProvenance('event-fixture-1')] }
  });
  graph.setNodeConfidence(nodeB.id, syntheticFixtureConfidence());
  graph.attachDiagnostics({
    targetId: nodeB.id,
    targetKind: 'node',
    diagnostics: [{
      severity: 'info',
      code: 'SYNTHETIC_NOT_NATIVE',
      message: 'Synthetic node has no native authority.',
      targetUri: nodeB.uri
    }]
  });
  const versionBefore = graph.getVersion();
  graph.bumpVersion('index');
  if (graph.getVersion() === versionBefore) throw new Error('Graph version did not change.');
  const snap = graph.snapshot();
  if (snap.nodeCount !== 2 || snap.edgeCount !== 1) {
    throw new Error(`Unexpected graph snapshot counts: nodes=${snap.nodeCount} edges=${snap.edgeCount}`);
  }
  const attached = graph.getNode('n2');
  if (!attached?.provenance?.sources[0] || attached.provenance.sources[0].nativeFormatAuthority) {
    throw new Error('Synthetic provenance must have nativeFormatAuthority=false.');
  }
  if (!attached.confidence || attached.confidence.level === 'none') {
    throw new Error('Expected confidence on synthetic node.');
  }
  results.push('ResourceGraph ok');

  // --- 3. PatchIR ---
  const textOp = createTextEditOperation({
    targetUri: formatted,
    targetPath: '/tmp/note.txt',
    newText: 'hello\n',
    resourceKind: 'msg'
  });
  const textPatch = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'text edit',
    author: 'user',
    operations: [textOp]
  });
  const textValidation = validatePatchIr(textPatch);
  if (!textValidation.ok) throw new Error(`Text PatchIR invalid: ${JSON.stringify(textValidation.diagnostics)}`);

  const rawOp = createRawByteRangeOperation({
    targetUri: formatted,
    targetPath: '/tmp/bin.dat',
    offset: 0,
    length: 1,
    replacement: Buffer.from([0x42]),
    expectedHash: 'deadbeef'
  });
  const rawPatch = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'raw edit',
    author: 'user',
    operations: [rawOp]
  });
  const rawValidation = validatePatchIr(rawPatch);
  if (!rawValidation.ok) throw new Error('Raw PatchIR should validate structure (hash check is runtime).');
  if (collectAffectedResources(rawPatch.operations).length !== 1) {
    throw new Error('collectAffectedResources failed.');
  }

  const unsafePatch = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'unsafe container',
    author: 'ai',
    operations: [{
      id: 'bad-1',
      kind: 'container_child_replace',
      targetUri: 'soulforge://sekiro/overlay/event/event/common.emevd.dcx',
      containerUri: 'soulforge://sekiro/overlay/event/event/common.emevd.dcx',
      childPath: 'child.bin',
      preconditions: [],
      validatorRequirements: [],
      riskLevel: 'high'
    }]
  });
  const unsafeValidation = validatePatchIr(unsafePatch);
  if (unsafeValidation.ok) throw new Error('Unsafe container patch must be rejected.');
  if (estimatePatchRisk(unsafePatch.operations) !== 'blocked') {
    throw new Error('Unsafe patch risk must be blocked.');
  }
  results.push('PatchIR ok');

  // --- 4. Transaction text vertical slice ---
  const root = await mkdtemp(join(tmpdir(), 'soulforge-v05-arch-'));
  const workspaceRoot = join(root, 'mod');
  await mkdir(join(workspaceRoot, 'msg'), { recursive: true });
  await mkdir(join(workspaceRoot, 'other'), { recursive: true });
  await mkdir(join(workspaceRoot, 'synthetic'), { recursive: true });

  const notePath = join(workspaceRoot, 'msg', 'note.txt');
  const binPath = join(workspaceRoot, 'other', 'blob.bin');
  const unsupportedPath = join(workspaceRoot, 'event', 'common.emevd.dcx');
  await mkdir(join(workspaceRoot, 'event'), { recursive: true });
  await writeFile(notePath, 'overlay-v1\n', 'utf8');
  await writeFile(binPath, Buffer.from([0x01, 0x02, 0x03, 0x04]));
  await writeFile(unsupportedPath, Buffer.from([0x44, 0x43, 0x58, 0x00, 0x01]));
  await writeFile(join(workspaceRoot, 'synthetic', 'event-like.synthetic.json'), '{"eventId":1}\n', 'utf8');
  await writeFile(join(workspaceRoot, 'msg', 'locale.json'), '{"ok":true}\n', 'utf8');

  const noteUri = formatResourceUri(createResourceUri({
    game: 'unknown',
    overlay: 'overlay',
    physicalPath: 'msg/note.txt',
    resourceKind: 'msg'
  }));

  const audit = new MemoryAuditLogStore();
  const tx = createWorkspaceTransaction({
    workspaceId: 'ws-scaffold',
    workspaceRoot,
    actor: { kind: 'user', id: 'scaffold-smoke' },
    auditLog: audit
  });

  const txPatch = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'scaffold text commit',
    author: 'user',
    operations: [
      createTextEditOperation({
        targetUri: noteUri,
        targetPath: notePath,
        newText: 'overlay-v2\n',
        resourceKind: 'msg'
      })
    ]
  });

  const added = tx.addPatch(txPatch);
  if (!added.ok) throw new Error(`addPatch failed: ${JSON.stringify(added.diagnostics)}`);

  const staged = await tx.stage();
  if (!staged.ok || !staged.stagingRoot) throw new Error(`stage failed: ${JSON.stringify(staged.diagnostics)}`);

  const validated = await tx.validate();
  if (!validated.ok) throw new Error(`validate failed: ${JSON.stringify(validated.diagnostics)}`);

  const committed = await tx.commit();
  if (!committed.ok) throw new Error(`commit failed: ${JSON.stringify(committed.diagnostics)}`);
  if ((await readFile(notePath, 'utf8')) !== 'overlay-v2\n') {
    throw new Error('Commit did not change text file.');
  }
  if (audit.list({ transactionId: tx.transactionId }).length < 3) {
    throw new Error('Audit log missing transaction events.');
  }

  const rolled = await tx.rollback();
  if (!rolled.ok) throw new Error(`rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  if ((await readFile(notePath, 'utf8')) !== 'overlay-v1\n') {
    throw new Error('Rollback did not restore text file.');
  }
  results.push('Transaction text commit/rollback ok');

  // raw byte range slice
  const beforeHash = createHash('sha256').update(await readFile(binPath)).digest('hex');
  const binUri = formatResourceUri(createResourceUri({
    game: 'unknown',
    overlay: 'overlay',
    physicalPath: 'other/blob.bin',
    resourceKind: 'other'
  }));
  const rawTx = createWorkspaceTransaction({
    workspaceId: 'ws-scaffold',
    workspaceRoot,
    actor: { kind: 'system', id: 'raw-smoke' },
    auditLog: audit
  });
  const rawTxPatch = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'raw byte edit',
    author: 'system',
    operations: [
      createRawByteRangeOperation({
        targetUri: binUri,
        targetPath: binPath,
        offset: 1,
        length: 1,
        replacement: Buffer.from([0xff]),
        expectedHash: beforeHash,
        resourceKind: 'other'
      })
    ]
  });
  if (!rawTx.addPatch(rawTxPatch).ok) throw new Error('raw addPatch failed');
  if (!(await rawTx.stage()).ok) throw new Error('raw stage failed');
  if (!(await rawTx.validate()).ok) throw new Error('raw validate failed');
  const rawCommit = await rawTx.commit();
  if (!rawCommit.ok) throw new Error(`raw commit failed: ${JSON.stringify(rawCommit.diagnostics)}`);
  const afterRaw = await readFile(binPath);
  if (afterRaw[1] !== 0xff) throw new Error('Raw commit did not apply byte edit.');
  const rawRollback = await rawTx.rollback();
  if (!rawRollback.ok) throw new Error('raw rollback failed');
  const restoredRaw = await readFile(binPath);
  if (!restoredRaw.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))) {
    throw new Error('Raw rollback did not restore bytes.');
  }
  results.push('Transaction raw commit/rollback ok');

  // --- 5. AI tool policy ---
  const registry = createScaffoldToolRegistry();
  const toolNames = new Set(registry.listTools().map((tool) => tool.name));
  for (const required of [
    'workspace.stats',
    'resource.graph.query',
    'patch.proposeTextEdit',
    'patch.stage',
    'patch.validate',
    'patch.commit',
    'patch.rollback'
  ]) {
    if (!toolNames.has(required)) throw new Error(`Missing scaffold tool: ${required}`);
  }

  const planCtx: ScaffoldToolContext = {
    workspaceId: 'ws-scaffold',
    workspaceRoot,
    mode: 'plan',
    graph,
    auditLog: audit
  };

  const stats = await registry.executeToolThroughPolicy('workspace.stats', {}, planCtx);
  if (!stats.ok || typeof stats.data !== 'object') throw new Error('workspace.stats failed.');
  if (!Array.isArray(stats.diagnostics) || !stats.evidenceRefs) {
    throw new Error('Tool result must be typed with diagnostics + evidenceRefs.');
  }

  const propose = await registry.executeToolThroughPolicy('patch.proposeTextEdit', {
    targetUri: noteUri,
    targetPath: notePath,
    newText: 'from-tool\n',
    title: 'tool propose'
  }, planCtx);
  if (!propose.ok) throw new Error(`propose failed: ${JSON.stringify(propose.diagnostics)}`);

  const commitDenied = await registry.executeToolThroughPolicy('patch.commit', {}, planCtx);
  if (commitDenied.ok || commitDenied.policyDecision.kind === 'allow') {
    throw new Error('commit must be denied in plan mode without confirmation.');
  }

  // Stage/validate allowed in plan; commit needs confirmation or fullPermission.
  const stageOk = await registry.executeToolThroughPolicy('patch.stage', {}, planCtx);
  if (!stageOk.ok) throw new Error(`stage tool failed: ${JSON.stringify(stageOk.diagnostics)}`);
  const validateOk = await registry.executeToolThroughPolicy('patch.validate', {}, planCtx);
  if (!validateOk.ok) throw new Error(`validate tool failed: ${JSON.stringify(validateOk.diagnostics)}`);

  const fullCtx: ScaffoldToolContext = {
    workspaceId: planCtx.workspaceId,
    workspaceRoot: planCtx.workspaceRoot,
    mode: 'fullPermission',
    confirmationReceiptIds: ['mock-receipt-1'],
    ...(planCtx.graph ? { graph: planCtx.graph } : {}),
    ...(planCtx.auditLog ? { auditLog: planCtx.auditLog } : {}),
    ...(planCtx.state ? { state: planCtx.state } : {})
  };
  // New propose/stage chain under full permission for commit+rollback audit
  const noteBefore = await readFile(notePath, 'utf8');
  const propose2 = await registry.executeToolThroughPolicy('patch.proposeTextEdit', {
    targetUri: noteUri,
    targetPath: notePath,
    newText: 'tool-committed\n',
    title: 'full perm edit'
  }, fullCtx);
  if (!propose2.ok) throw new Error('full propose failed');
  if (!(await registry.executeToolThroughPolicy('patch.stage', {}, fullCtx)).ok) {
    throw new Error('full stage failed');
  }
  if (!(await registry.executeToolThroughPolicy('patch.validate', {}, fullCtx)).ok) {
    throw new Error('full validate failed');
  }
  const commitOk = await registry.executeToolThroughPolicy('patch.commit', {}, fullCtx);
  if (!commitOk.ok) throw new Error(`full commit failed: ${JSON.stringify(commitOk.diagnostics)}`);
  if ((await readFile(notePath, 'utf8')) !== 'tool-committed\n') {
    throw new Error('Tool commit did not write file.');
  }
  const rollbackOk = await registry.executeToolThroughPolicy('patch.rollback', {}, fullCtx);
  if (!rollbackOk.ok) throw new Error(`rollback tool failed: ${JSON.stringify(rollbackOk.diagnostics)}`);
  if ((await readFile(notePath, 'utf8')) !== noteBefore) {
    throw new Error('Tool rollback did not restore file.');
  }
  const toolAudits = audit.list().filter((entry) => entry.eventKind === 'tool_call' || entry.eventKind === 'policy_decision');
  if (toolAudits.length < 2) throw new Error('Expected tool/policy audit entries.');
  results.push('AI tool policy ok');

  // --- 6. VFS ---
  const vfs = await buildVfsFromWorkspace({
    workspaceId: 'ws-scaffold',
    workspaceRoot,
    game: 'unknown',
    overlay: 'overlay'
  });
  const allNodes = Object.values(vfs.nodesByUri);
  const textNode = allNodes.find((node) => node.relativePath === 'msg/note.txt');
  if (!textNode) throw new Error('VFS missing text file node.');
  if (!textNode.capabilities.includes('text_edit')) {
    throw new Error('Text file must have text_edit capability.');
  }
  const unsupportedNode = allNodes.find((node) => node.relativePath === 'event/common.emevd.dcx');
  if (!unsupportedNode || unsupportedNode.kind !== 'unsupported') {
    throw new Error('Unsupported binary must be marked unsupported.');
  }
  const syntheticNode = allNodes.find((node) => node.synthetic || node.kind === 'synthetic_resource');
  if (!syntheticNode) throw new Error('Expected synthetic resource node.');
  if (syntheticNode.nativeFormatAuthority) {
    throw new Error('Synthetic VFS node must not claim native authority.');
  }
  if (!syntheticNode.provenance?.sources.some((source) => source.syntheticFixture)) {
    throw new Error('Synthetic VFS node must carry synthetic provenance.');
  }
  results.push('VFS ok');

  // --- 7. Bridge protocol ---
  const matrix = buildScaffoldCapabilityMatrix();
  if (matrix.schemaVersion !== BRIDGE_SCHEMA_VERSION) throw new Error('schemaVersion mismatch');
  if (matrix.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new Error('protocolVersion mismatch');
  if (!matrix.commands.some((command) => command.name === 'inspect')) {
    throw new Error('Capability matrix missing inspect.');
  }
  if (matrix.cells.some((cell) => cell.nativeFormatAuthority)) {
    throw new Error('Scaffold capability matrix must not claim nativeFormatAuthority.');
  }
  const syntheticEnvelope = createSyntheticInspectEnvelope(unsupportedPath);
  if (syntheticEnvelope.nativeFormatAuthority || !syntheticEnvelope.syntheticFixture) {
    throw new Error('Synthetic inspect envelope authority flags wrong.');
  }
  const failEnvelope = createTypedFailureEnvelope('validate', unsupportedNativeWriterFailure());
  if (failEnvelope.ok || failEnvelope.failure?.kind !== 'unsupported') {
    throw new Error('Typed unsupported failure envelope invalid.');
  }
  const mismatch = schemaMismatchFailure('0.5.0', '0.1.0');
  if (mismatch.kind !== 'schemaMismatch') throw new Error('schemaMismatch failure kind wrong.');
  results.push('Bridge protocol ok');

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 architecture scaffold smoke: ok',
    results,
    transactionId: tx.transactionId,
    auditEntries: audit.list().length,
    vfsNodes: allNodes.length,
    graphVersion: graph.getVersion(),
    bridgeSchema: matrix.schemaVersion
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

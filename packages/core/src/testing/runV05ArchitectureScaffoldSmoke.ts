/**
 * v0.5 Architecture Scaffold vertical-slice smoke tests.
 *
 * Covers:
 * ResourceURI, ResourceGraph, PatchIR, Transaction (text/raw),
 * AI tool policy (production ToolRegistry), VFS, Bridge protocol scaffold.
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
  createDefaultToolRegistry
} from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
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

  // Incomplete container_child_replace (missing hashes/payload) must fail validation.
  const incompleteReplace = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'incomplete container replace',
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
  const incompleteValidation = validatePatchIr(incompleteReplace);
  if (incompleteValidation.ok) throw new Error('Incomplete container_child_replace must be rejected.');

  // Unimplemented container mutations stay blocked.
  const unsafePatch = createPatchIr({
    workspaceId: 'ws-scaffold',
    title: 'unsafe container add',
    author: 'ai',
    operations: [{
      id: 'bad-2',
      kind: 'container_child_add',
      targetUri: 'soulforge://sekiro/overlay/event/event/common.emevd.dcx',
      containerUri: 'soulforge://sekiro/overlay/event/event/common.emevd.dcx',
      childPath: 'child.bin',
      preconditions: [],
      validatorRequirements: [],
      riskLevel: 'high'
    }]
  });
  const unsafeValidation = validatePatchIr(unsafePatch);
  if (unsafeValidation.ok) throw new Error('Unsafe container_child_add patch must be rejected.');
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

  // --- 5. AI tool policy (production ToolRegistry) ---
  const registry = createDefaultToolRegistry();
  const toolNames = new Set(registry.listToolNames());
  for (const required of [
    "workspace.stats",
    "resource.graph.query",
    "patch.proposeTextEdit",
    "patch.stage",
    "patch.validate",
    "patch.commit",
    "patch.rollback"
  ]) {
    if (!toolNames.has(required)) throw new Error("Missing production tool: " + required);
  }

  const workspaceIndex = new WorkspaceIndex("ws-scaffold");
  const planCtx = {
    workspaceIndex,
    workspaceRoot,
    mode: "plan" as const,
    graph,
    state: {} as Record<string, unknown>
  };

  const stats = await registry.executeToolThroughPolicy("workspace.stats", {}, planCtx);
  if (!stats.ok || !stats.data || typeof stats.data !== "object") {
    throw new Error("workspace.stats failed: " + JSON.stringify(stats.error));
  }
  const statsData = stats.data as { fileCount?: number };
  if (typeof statsData.fileCount !== "number") throw new Error("workspace.stats missing fileCount");

  // plan mode caps at propose: propose allowed, stage/commit denied.
  const planPropose = await registry.executeToolThroughPolicy(
    "patch.proposeTextEdit",
    {
      targetUri: noteUri,
      targetPath: "msg/note.txt",
      newText: "plan-ok" + String.fromCharCode(10),
      title: "plan propose"
    },
    planCtx
  );
  if (!planPropose.ok) throw new Error("plan mode should allow propose: " + JSON.stringify(planPropose.error));

  const stageDenied = await registry.executeToolThroughPolicy("patch.stage", {}, planCtx);
  if (stageDenied.ok || !stageDenied.error || stageDenied.error.code !== "POLICY_DENIED") {
    throw new Error("plan mode must deny stage with POLICY_DENIED");
  }

  const commitDenied = await registry.executeToolThroughPolicy("patch.commit", {}, planCtx);
  if (commitDenied.ok || !commitDenied.error || commitDenied.error.code !== "POLICY_DENIED") {
    throw new Error("plan mode must deny commit with POLICY_DENIED");
  }

  const fullCtx = {
    workspaceIndex,
    workspaceRoot,
    mode: "fullPermission" as const,
    confirmationReceiptIds: ["mock-receipt-1"],
    graph,
    state: {} as Record<string, unknown>
  };

  const propose = await registry.executeToolThroughPolicy(
    "patch.proposeTextEdit",
    {
      targetUri: noteUri,
      targetPath: "msg/note.txt",
      newText: "hello scaffold" + String.fromCharCode(10),
      title: "scaffold text edit"
    },
    fullCtx
  );
  if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.error));

  const toolStaged = await registry.executeToolThroughPolicy("patch.stage", {}, fullCtx);
  if (!toolStaged.ok) throw new Error("stage failed: " + JSON.stringify(toolStaged.error));

  const toolValidated = await registry.executeToolThroughPolicy("patch.validate", {}, fullCtx);
  if (!toolValidated.ok) throw new Error("validate failed: " + JSON.stringify(toolValidated.error));

  const toolCommitted = await registry.executeToolThroughPolicy("patch.commit", {}, fullCtx);
  if (!toolCommitted.ok) throw new Error("commit failed: " + JSON.stringify(toolCommitted.error));
  const committedText = await readFile(notePath, "utf8");
  if (committedText !== "hello scaffold" + String.fromCharCode(10)) {
    throw new Error("Tool commit did not write file.");
  }

  const rollbackOk = await registry.executeToolThroughPolicy("patch.rollback", {}, fullCtx);
  if (!rollbackOk.ok) throw new Error("rollback failed: " + JSON.stringify(rollbackOk.error));
  const restoredText = await readFile(notePath, "utf8");
  if (restoredText !== "overlay-v1" + String.fromCharCode(10)) {
    throw new Error("Tool rollback did not restore file.");
  }

  const graphQuery = await registry.executeToolThroughPolicy("resource.graph.query", { limit: 10 }, fullCtx);
  if (!graphQuery.ok || !graphQuery.data || typeof graphQuery.data !== "object") {
    throw new Error("resource.graph.query failed: " + JSON.stringify(graphQuery.error));
  }
  const graphData = graphQuery.data as { nodes?: unknown[] };
  if (!Array.isArray(graphData.nodes) || graphData.nodes.length < 2) {
    throw new Error("resource.graph.query expected graph nodes from context.graph.");
  }
  results.push("AI tool policy ok");


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

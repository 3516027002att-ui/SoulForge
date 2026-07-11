import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveTextResource } from '../editing/saveTextResource.js';
import {
  assessEditRisk,
  createConfirmationReceipt,
  evaluateWriterGate,
  resolveWriterContract
} from '../patch/writerContract.js';
import { evaluateDiagnosticsGate } from '../patch/diagnosticsGate.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { IndexedFile } from '@soulforge/shared';

function makeFile(partial: Partial<IndexedFile> & Pick<IndexedFile, 'sourceUri' | 'absolutePath' | 'relativePath' | 'formatKind' | 'resourceKind'>): IndexedFile {
  return {
    id: partial.id ?? partial.sourceUri,
    workspaceId: partial.workspaceId ?? 'ws-test',
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

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-v05-p1-'));
  const overlayRoot = join(root, 'mod');
  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  await mkdir(join(overlayRoot, 'event'), { recursive: true });

  const notePath = join(overlayRoot, 'msg', 'note.txt');
  const bakPath = join(overlayRoot, 'msg', 'note.txt.bak');
  const dcxPath = join(overlayRoot, 'event', 'common.emevd.dcx');
  await writeFile(notePath, 'v1\n', 'utf8');
  await writeFile(bakPath, 'bak-v1\n', 'utf8');
  await writeFile(dcxPath, Buffer.from([0x44, 0x43, 0x58, 0x00]));

  const session = await openWorkspaceSession({ overlayRoot, game: 'unknown' });
  const store = new MemoryOperationLogStore();

  const textFile = makeFile({
    workspaceId: session.meta.workspaceId,
    sourceUri: 'file://msg/note.txt',
    absolutePath: notePath,
    relativePath: 'msg/note.txt',
    resourceKind: 'msg',
    formatKind: 'text',
    extension: '.txt',
    compoundExtension: '.txt'
  });

  const bakFile = makeFile({
    workspaceId: session.meta.workspaceId,
    sourceUri: 'file://msg/note.txt.bak',
    absolutePath: bakPath,
    relativePath: 'msg/note.txt.bak',
    resourceKind: 'msg',
    formatKind: 'backup',
    extension: '.bak',
    compoundExtension: '.bak'
  });

  const dcxFile = makeFile({
    workspaceId: session.meta.workspaceId,
    sourceUri: 'file://event/common.emevd.dcx',
    absolutePath: dcxPath,
    relativePath: 'event/common.emevd.dcx',
    resourceKind: 'event',
    formatKind: 'emevd',
    extension: '.dcx',
    compoundExtension: '.emevd.dcx'
  });

  // 1) Safe text contract
  const textContract = resolveWriterContract(textFile);
  if (textContract.capability !== 'text') throw new Error('Expected text writer capability.');
  const safeRisk = assessEditRisk(textFile);
  if (safeRisk.level !== 'safe') throw new Error(`Expected safe risk, got ${safeRisk.level}`);

  // 2) Native packed blocked — no blind rewrite
  const dcxRisk = assessEditRisk(dcxFile);
  if (dcxRisk.level !== 'blocked') throw new Error('DCX must be blocked.');
  if (dcxRisk.allowWithConfirmation) throw new Error('DCX must not allow confirmation bypass.');
  const dcxGate = evaluateWriterGate({ file: dcxFile, changeKind: 'text' });
  if (dcxGate.ok) throw new Error('DCX writer gate must fail.');

  // 3) Structured always blocked at contract layer
  const structuredGate = evaluateWriterGate({ file: textFile, changeKind: 'structured' });
  if (structuredGate.ok || !structuredGate.diagnostics.some((d) => d.code === 'STRUCTURED_WRITER_NOT_IMPLEMENTED')) {
    throw new Error('Structured writer must fail with STRUCTURED_WRITER_NOT_IMPLEMENTED.');
  }

  // 4) Backup requires confirmation receipt
  const bakRisk = assessEditRisk(bakFile);
  if (bakRisk.level !== 'high' && bakRisk.level !== 'caution') {
    throw new Error(`Backup risk should be elevated, got ${bakRisk.level}`);
  }
  const denied = await saveTextResource({
    file: bakFile,
    newText: 'bak-v2\n',
    session,
    operationLog: store
  });
  if (denied.ok || !denied.requiresConfirmation) {
    throw new Error('Backup save without confirmation must require confirmation.');
  }
  if (!denied.diagnostics.some((d) => d.code === 'EDIT_CONFIRMATION_REQUIRED')) {
    throw new Error('Expected EDIT_CONFIRMATION_REQUIRED diagnostic.');
  }

  const receipt = createConfirmationReceipt({
    subjects: [bakFile.sourceUri, ...bakRisk.reasons, bakRisk.level],
    riskLevel: bakRisk.level,
    sourceUri: bakFile.sourceUri,
    note: 'p1 smoke confirm'
  });
  const confirmed = await saveTextResource({
    file: bakFile,
    newText: 'bak-v2\n',
    session,
    operationLog: store,
    confirmation: receipt
  });
  if (!confirmed.ok) {
    throw new Error(`Confirmed backup save failed: ${confirmed.diagnostics.map((d) => d.message).join('; ')}`);
  }
  if ((await readFile(bakPath, 'utf8')) !== 'bak-v2\n') {
    throw new Error('Backup file content not updated after confirmed save.');
  }
  if (!confirmed.graph || confirmed.graph.summary.fileCount !== 1) {
    throw new Error('Save result must include patch graph summary.');
  }

  // 5) Truncated preview blocked
  const truncGate = evaluateWriterGate({
    file: textFile,
    changeKind: 'text',
    riskOptions: { truncated: true }
  });
  if (truncGate.ok || truncGate.risk.level !== 'blocked') {
    throw new Error('Truncated preview must block write.');
  }

  // 6) Diagnostics gate
  const gateOk = evaluateDiagnosticsGate([{ severity: 'info', code: 'X', message: 'ok' }]);
  if (!gateOk.ok) throw new Error('Info diagnostics must not block.');
  const gateBad = evaluateDiagnosticsGate([{ severity: 'error', code: 'Y', message: 'no' }]);
  if (gateBad.ok) throw new Error('Error diagnostics must block.');

  // 7) Safe save + history graphSummary
  const saved = await saveTextResource({
    file: textFile,
    newText: 'v2\n',
    session,
    operationLog: store
  });
  if (!saved.ok || !saved.graph) throw new Error('Safe text save should succeed with graph.');
  const history = await store.history(session.meta.workspaceId);
  if (!history.some((entry) => entry.graphSummary && entry.graphSummary.fileCount >= 1)) {
    throw new Error('History entries should include graphSummary.');
  }

  // 8) AI tool assess_edit_risk
  const registry = createDefaultToolRegistry();
  const index = new WorkspaceIndex(session.meta.workspaceId);
  const tool = await registry.run(
    'assess_edit_risk',
    { file: dcxFile },
    { workspaceIndex: index, mode: 'plan' }
  );
  if (!tool.ok) throw new Error('assess_edit_risk tool failed.');
  const toolData = tool.data as { risk: { level: string } };
  if (toolData.risk.level !== 'blocked') throw new Error('assess_edit_risk should report blocked for DCX.');

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 P1 smoke: ok',
    safeGraphFiles: saved.graph.summary.fileCount,
    confirmedGraphFiles: confirmed.graph?.summary.fileCount,
    historyWithGraph: history.filter((h) => h.graphSummary).length,
    tools: registry.list().map((t) => t.name).filter((n) => n.includes('risk') || n.includes('graph'))
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

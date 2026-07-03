import { readFile } from 'node:fs/promises';
import type { BridgeResult, Diagnostic, ResourceKind } from '@soulforge/shared';
import { createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import { createUnifiedDiff } from '../patch/textDiff.js';
import { parseEventText } from '../parsers/eventTextParser.js';
import { parseMsgText } from '../parsers/msgTextParser.js';
import { buildReferenceGraph } from '../references/referenceBuilder.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createMockWorkspace, type MockWorkspace } from './createMockWorkspace.js';

export interface MockEvidencePipelineResult {
  workspace: MockWorkspace;
  scannedFileCount: number;
  diagnostics: Diagnostic[];
  referenceStats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
  eventExplanationMarkdown: string;
  patchDiff: string;
  patchValidationOk: boolean;
}

/**
 * Runs SoulForge's v0.1 core loop against synthetic data:
 *
 * scan -> parse text symbols -> ingest bridge-like JSON -> build references
 * -> collect event evidence -> create text diff -> dry-run Patch Engine validation
 */
export async function runMockEvidencePipeline(): Promise<MockEvidencePipelineResult> {
  const workspace = await createMockWorkspace();
  const scan = await scanWorkspace({ workspaceRoot: workspace.root });
  const index = new WorkspaceIndex(scan.workspaceId);
  index.setFiles(scan.files);

  const diagnostics: Diagnostic[] = [...scan.diagnostics];

  const eventFile = scan.files.find((file) => file.relativePath.endsWith('.emevd.txt'));
  if (!eventFile) throw new Error('Mock event file missing after scan.');

  const eventText = await readFile(eventFile.absolutePath, 'utf8');
  const eventParse = parseEventText({
    sourceUri: eventFile.sourceUri,
    sourcePath: eventFile.relativePath,
    text: eventText
  });
  diagnostics.push(...eventParse.diagnostics);
  index.upsertEventExport(eventParse.export);

  const msgFile = scan.files.find((file) => file.relativePath.endsWith('Goods.tsv'));
  if (!msgFile) throw new Error('Mock msg file missing after scan.');

  const msgText = await readFile(msgFile.absolutePath, 'utf8');
  const msgParse = parseMsgText({
    sourceUri: msgFile.sourceUri,
    sourcePath: msgFile.relativePath,
    text: msgText,
    category: 'Goods'
  });
  diagnostics.push(...msgParse.diagnostics);
  index.upsertMsgExport(msgParse.export);

  await ingestJsonFixture(index, workspace.files.mapJson, 'map', diagnostics);
  await ingestJsonFixture(index, workspace.files.paramJson, 'param', diagnostics);

  const references = buildReferenceGraph(index.toSymbolBundle(), { enableNumericFallback: true });
  index.rebuildReferences({ enableNumericFallback: true });

  const explanation = index.buildEventExplanationInput('event://m11_00_00_00/11002800');
  if (!explanation) throw new Error('Mock event explanation could not be built.');

  const nextEventText = eventText.replace('EnableCharacter(character=1100800);', 'EnableCharacter(character=1100800);\n  // SoulForge mock patch touched this event.');
  const patchDiff = createUnifiedDiff(eventText, nextEventText, {
    fromFile: eventFile.relativePath,
    toFile: eventFile.relativePath,
    contextLines: 3
  });

  const proposal = createPatchProposal({
    workspaceId: scan.workspaceId,
    title: 'Mock event text patch',
    author: 'ai',
    mode: 'plan',
    changes: [
      {
        targetUri: eventFile.sourceUri,
        targetPath: eventFile.absolutePath,
        kind: 'text',
        diff: patchDiff,
        structuredEdit: { newText: nextEventText }
      }
    ]
  });

  const validation = await dryRunPatchProposal(proposal);
  diagnostics.push(...validation.diagnostics);

  return {
    workspace,
    scannedFileCount: scan.files.length,
    diagnostics,
    referenceStats: references.stats,
    eventExplanationMarkdown: explanation.markdown,
    patchDiff,
    patchValidationOk: validation.ok
  };
}

async function ingestJsonFixture(index: WorkspaceIndex, path: string, kind: ResourceKind, diagnostics: Diagnostic[]): Promise<void> {
  const text = await readFile(path, 'utf8');
  const data = JSON.parse(text) as unknown;
  const result: BridgeResult<unknown> = {
    sourceUri: `file://${path}`,
    sourcePath: path,
    game: 'sekiro',
    resourceKind: kind,
    parseStatus: 'parsed',
    diagnostics: [],
    data
  };

  const ingest = ingestBridgeResult(index, result);
  diagnostics.push(...ingest.diagnostics);
}

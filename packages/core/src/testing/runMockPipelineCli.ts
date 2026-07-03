import { runMockEvidencePipeline } from './runMockEvidencePipeline.js';

const result = await runMockEvidencePipeline();

const output = {
  workspaceRoot: result.workspace.root,
  scannedFileCount: result.scannedFileCount,
  referenceStats: result.referenceStats,
  patchValidationOk: result.patchValidationOk,
  diagnostics: result.diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message
  })),
  eventExplanationMarkdown: result.eventExplanationMarkdown,
  patchDiff: result.patchDiff
};

console.log(JSON.stringify(output, null, 2));

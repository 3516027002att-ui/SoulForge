/**
 * Count the complete single-file output of core's createUnifiedDiff before
 * preview truncation. That producer always emits exactly two file headers
 * first; every later +/- prefix belongs to content, including ---/+++ text.
 */
export function countGeneratedTextDiffLines(lines: readonly string[]): {
  addedLines: number;
  removedLines: number;
} {
  const bodyLines = lines.slice(2);
  return {
    addedLines: bodyLines.filter((line) => line.startsWith('+')).length,
    removedLines: bodyLines.filter((line) => line.startsWith('-')).length
  };
}

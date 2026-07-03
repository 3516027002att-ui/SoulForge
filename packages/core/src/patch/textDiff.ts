export interface TextEdit {
  startLine: number;
  endLine: number;
  replacement: string[];
}

export interface UnifiedDiffOptions {
  fromFile?: string;
  toFile?: string;
  contextLines?: number;
}

interface DiffOp {
  type: 'same' | 'add' | 'remove';
  value: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Applies 1-based inclusive line edits to a text document.
 * Edits must not overlap. This is useful for AI patch proposals because it can
 * validate exact line ranges before touching staging files.
 */
export function applyLineEdits(original: string, edits: readonly TextEdit[]): string {
  const lines = splitStableLines(original);
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  let cursor = 1;
  const output: string[] = [];

  for (const edit of sorted) {
    if (edit.startLine < cursor) throw new Error('Overlapping text edits are not allowed.');
    if (edit.startLine < 1 || edit.endLine < edit.startLine - 1) throw new Error('Invalid text edit line range.');

    while (cursor < edit.startLine && cursor <= lines.length) {
      output.push(lines[cursor - 1] ?? '');
      cursor += 1;
    }

    output.push(...edit.replacement);
    cursor = edit.endLine + 1;
  }

  while (cursor <= lines.length) {
    output.push(lines[cursor - 1] ?? '');
    cursor += 1;
  }

  return output.join('\n');
}

export function createUnifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string {
  const beforeLines = splitStableLines(before);
  const afterLines = splitStableLines(after);
  const ops = diffLines(beforeLines, afterLines);
  const contextLines = options.contextLines ?? 3;
  const hunks = buildHunks(ops, contextLines);
  const lines: string[] = [];

  lines.push(`--- ${options.fromFile ?? 'before'}`);
  lines.push(`+++ ${options.toFile ?? 'after'}`);

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const op of hunk.ops) {
      if (op.type === 'same') lines.push(` ${op.value}`);
      if (op.type === 'add') lines.push(`+${op.value}`);
      if (op.type === 'remove') lines.push(`-${op.value}`);
    }
  }

  return lines.join('\n');
}

function diffLines(before: string[], after: string[]): DiffOp[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j]
        ? (table[i + 1]?.[j + 1] ?? 0) + 1
        : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;

  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      ops.push({ type: 'same', value: before[i] ?? '', oldLine, newLine });
      i += 1;
      j += 1;
      oldLine += 1;
      newLine += 1;
    } else if (j < after.length && (i === before.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))) {
      ops.push({ type: 'add', value: after[j] ?? '', newLine });
      j += 1;
      newLine += 1;
    } else if (i < before.length) {
      ops.push({ type: 'remove', value: before[i] ?? '', oldLine });
      i += 1;
      oldLine += 1;
    }
  }

  return ops;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: DiffOp[];
}

function buildHunks(ops: DiffOp[], contextLines: number): Hunk[] {
  const changeIndexes = ops
    .map((op, index) => op.type === 'same' ? -1 : index)
    .filter((index) => index >= 0);

  if (changeIndexes.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  return ranges.map(([start, end]) => makeHunk(ops.slice(start, end + 1)));
}

function makeHunk(ops: DiffOp[]): Hunk {
  const oldLines = ops.filter((op) => op.type !== 'add');
  const newLines = ops.filter((op) => op.type !== 'remove');
  const oldStart = oldLines.find((op) => op.oldLine !== undefined)?.oldLine ?? 0;
  const newStart = newLines.find((op) => op.newLine !== undefined)?.newLine ?? 0;

  return {
    oldStart: oldStart === 0 ? 1 : oldStart,
    oldCount: oldLines.length,
    newStart: newStart === 0 ? 1 : newStart,
    newCount: newLines.length,
    ops
  };
}

function splitStableLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length === 0) return [];
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
}

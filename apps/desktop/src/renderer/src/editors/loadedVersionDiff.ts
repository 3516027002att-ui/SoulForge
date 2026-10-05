import { createUnifiedDiff } from '@soulforge/core/dist/patch/textDiff.js';
import { classifyDiffLines } from '../agent/agentTaskState.js';
import type { DecodedFieldView } from './ParamDefPanel.js';

export interface LoadedFieldIdentity { id: string; name: string; type: string }
export type LoadedFieldValue = Pick<DecodedFieldView, 'display' | 'comparisonDisplay' | 'diagnostic'>;
export interface LoadedFieldChange extends LoadedFieldIdentity { before: string; after: string }

/** 只比较真正的草稿；编辑框四位浮点显示不是一个用户修改。 */
export function compareLoadedFields(
  fields: readonly LoadedFieldIdentity[],
  loaded: ReadonlyMap<string, LoadedFieldValue> | null,
  drafts: Readonly<Record<string, string>>
): LoadedFieldChange[] {
  if (loaded === null) return [];
  const changes: LoadedFieldChange[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(drafts, field.id)) continue;
    const value = loaded.get(field.id);
    const after = drafts[field.id];
    if (!value || value.diagnostic || after === undefined) continue;
    const before = value.comparisonDisplay ?? value.display;
    if (before !== after) changes.push({ id: field.id, name: field.name, type: field.type, before, after });
  }
  return changes;
}

export interface LoadedSourceLine {
  kind: 'add' | 'remove' | 'context' | 'hunk';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface LoadedSourceComparison {
  lines: LoadedSourceLine[];
  coarse: boolean;
  omittedLines: number;
}

const MAX_DIFF_CELLS = 250_000;
const MAX_ENCODED_CHARACTERS = 200_000;
const MAX_DIFF_WINDOW_LINES = 2_000;
const MAX_PREVIEW_LINES = 400;

/**
 * 本次载入文本的只读预览。公共边缘先收窄；既有 LCS 只用于有界窗口。
 * JSON 编码每行后再交给 textDiff，避免其换行归一丢失 CR/末尾空行。
 * 超预算时如实显示整段增删，预览截断不会改变传入的原始文本。
 */
export function compareLoadedSource(before: string, after: string): LoadedSourceComparison {
  if (before === after) return { lines: [], coarse: false, omittedLines: 0 };
  const oldLines = before === '' ? [] : before.split('\n');
  const newLines = after === '' ? [] : after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const start = Math.max(0, prefix - 3);
  const endContext = Math.max(0, suffix - 3);
  const oldWindow = oldLines.slice(start, oldLines.length - endContext);
  const newWindow = newLines.slice(start, newLines.length - endContext);
  let coarse = (oldWindow.length + 1) * (newWindow.length + 1) > MAX_DIFF_CELLS
    || oldWindow.length + newWindow.length > MAX_DIFF_WINDOW_LINES;
  // 每个 UTF-16 单元最多编码成六字符的 JSON escape，另计引号/换行。
  if (!coarse) {
    let estimatedCharacters = 0;
    budget: for (const window of [oldWindow, newWindow]) {
      for (const text of window) {
        estimatedCharacters += text.length * 6 + 3;
        if (estimatedCharacters > MAX_ENCODED_CHARACTERS) { coarse = true; break budget; }
      }
    }
  }
  let lines: LoadedSourceLine[];
  if (coarse) {
    lines = [];
    const total = oldWindow.length + newWindow.length;
    const omittedLines = Math.max(0, total - MAX_PREVIEW_LINES);
    const append = (index: number): void => {
      if (index < oldWindow.length) lines.push({ kind: 'remove', text: oldWindow[index]!, oldLine: start + index + 1 });
      else {
        const nextIndex = index - oldWindow.length;
        lines.push({ kind: 'add', text: newWindow[nextIndex]!, newLine: start + nextIndex + 1 });
      }
    };
    const head = omittedLines > 0 ? MAX_PREVIEW_LINES / 2 : total;
    for (let index = 0; index < head; index += 1) append(index);
    if (omittedLines > 0) for (let index = total - MAX_PREVIEW_LINES / 2; index < total; index += 1) append(index);
    return { lines, coarse, omittedLines };
  } else {
    const encode = (texts: readonly string[]): string => texts.map(text => JSON.stringify(text)).join('\n');
    const diff = createUnifiedDiff(encode(oldWindow), encode(newWindow));
    let oldLine = start + 1;
    let newLine = start + 1;
    lines = [];
    for (const line of classifyDiffLines(diff)) {
      if (line.kind === 'header') continue;
      if (line.kind === 'hunk') {
        const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line.text)!;
        oldLine = start + Number(hunk[1]);
        newLine = start + Number(hunk[3]);
        lines.push({ kind: 'hunk', text: `@@ -${oldLine},${hunk[2]} +${newLine},${hunk[4]} @@` });
      } else {
        const text = JSON.parse(line.text.slice(1)) as string;
        if (line.kind === 'add') lines.push({ kind: 'add', text, newLine: newLine++ });
        else if (line.kind === 'remove') lines.push({ kind: 'remove', text, oldLine: oldLine++ });
        else lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }
  const omittedLines = Math.max(0, lines.length - MAX_PREVIEW_LINES);
  if (omittedLines > 0) lines = [...lines.slice(0, MAX_PREVIEW_LINES / 2), ...lines.slice(-MAX_PREVIEW_LINES / 2)];
  return { lines, coarse, omittedLines };
}

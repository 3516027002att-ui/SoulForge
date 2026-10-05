import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createUnifiedDiff } from '../../../../../packages/core/src/patch/textDiff.js';
import { countGeneratedTextDiffLines } from './generatedTextDiffCounts.js';

function generatedLines(before: string, after: string, contextLines = 3): string[] {
  return createUnifiedDiff(before, after, {
    fromFile: 'mods/example.txt',
    toFile: 'mods/example.txt',
    contextLines
  }).split('\n');
}

describe('countGeneratedTextDiffLines', () => {
  it('counts removed --flag and added ++counter as body lines', () => {
    assert.deepEqual(countGeneratedTextDiffLines(generatedLines('--flag', '++counter')), {
      addedLines: 1,
      removedLines: 1
    });
  });

  it('counts header-shaped content emitted inside a hunk', () => {
    assert.deepEqual(countGeneratedTextDiffLines(generatedLines('-- filename', '++ filename')), {
      addedLines: 1,
      removedLines: 1
    });
  });

  it('counts every new-file body line while excluding its two file headers', () => {
    assert.deepEqual(countGeneratedTextDiffLines(generatedLines('', '--flag\n++counter')), {
      addedLines: 2,
      removedLines: 0
    });
  });

  it('counts every deletion when the new text is empty', () => {
    assert.deepEqual(countGeneratedTextDiffLines(generatedLines('--flag\n++counter', '')), {
      addedLines: 0,
      removedLines: 2
    });
  });

  it('returns zero changes for equal text and equal empty files', () => {
    for (const text of ['', '--flag\n++counter\nunchanged']) {
      const lines = generatedLines(text, text);
      assert.equal(lines.length, 2, 'equal text emits only the two file headers');
      assert.deepEqual(countGeneratedTextDiffLines(lines), { addedLines: 0, removedLines: 0 });
    }
  });

  it('counts changes across separated hunks while ignoring context lines', () => {
    const context = Array.from({ length: 12 }, (_, index) => `context ${index}`);
    const before = ['--first flag', ...context, '--last flag'].join('\n');
    const after = ['++first counter', ...context, '++last counter'].join('\n');
    const lines = generatedLines(before, after, 1);
    assert.equal(lines.filter((line) => line.startsWith('@@')).length, 2);
    assert.ok(lines.some((line) => line.startsWith(' context ')));
    assert.deepEqual(countGeneratedTextDiffLines(lines), { addedLines: 2, removedLines: 2 });
  });

  it('counts the complete generated diff before a 400-line preview is truncated', () => {
    const after = Array.from({ length: 450 }, (_, index) => `++counter ${index}`).join('\n');
    const lines = generatedLines('', after);
    assert.ok(lines.length > 400);
    assert.deepEqual(countGeneratedTextDiffLines(lines), { addedLines: 450, removedLines: 0 });
  });
});

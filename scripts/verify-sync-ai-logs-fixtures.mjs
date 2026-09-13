import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateMarkdown, parseSessionFile, refreshArchiveIndex, renderArchiveIndex } from './sync-ai-logs.mjs';

const root = await mkdtemp(join(tmpdir(), 'soulforge-ai-log-sync-'));

async function fixture(name, items, trailing = '') {
  const filePath = join(root, `${name}.jsonl`);
  await writeFile(filePath, `${items.map((item) => JSON.stringify(item)).join('\n')}${trailing}\n`, 'utf8');
  return parseSessionFile(filePath);
}

try {
  const meta = {
    type: 'session-meta',
    meta: {
      sessionId: 'fixture-session',
      startedAt: '2026-09-07T00:00:00.000Z',
      configId: 'test',
      protocol: 'openai-compatible',
      permissionMode: 'normal'
    }
  };
  const user = { type: 'message', step: 1, message: { role: 'user', content: 'fixture prompt' } };

  for (const [finishReason, taskStatus] of [
    ['stop', 'completed'],
    ['cancelled', 'cancelled'],
    ['partial', 'partial'],
    ['error', 'error']
  ]) {
    const parsed = await fixture(`terminal-${finishReason}`, [
      meta,
      user,
      { type: 'turn-complete', at: '2026-09-07T00:01:00.000Z', finishReason, taskStatus, steps: 7, diagnostics: [] }
    ]);
    assert.equal(parsed.terminalSource, 'turn-complete');
    assert.equal(parsed.terminalMissing, false);
    assert.equal(parsed.finishReason, finishReason);
    assert.equal(parsed.taskStatus, taskStatus);
    assert.equal(parsed.totalSteps, 7);
  }

  const missing = await fixture('missing-terminal', [meta, user]);
  assert.equal(missing.finishReason, null);
  assert.equal(missing.taskStatus, 'in_progress');
  assert.equal(missing.terminalMissing, true);
  const missingMarkdown = generateMarkdown(missing);
  assert.match(missingMarkdown, /终态缺失/);
  assert.doesNotMatch(missingMarkdown, /✅\s+\*\*会话完成/);

  const truncated = await fixture('truncated-terminal', [meta, user], '\n{"type":"turn-complete"');
  assert.equal(truncated.terminalMissing, true);
  assert.equal(truncated.taskStatus, 'in_progress');
  assert.equal(truncated.parseErrors, 1);

  const multiple = await fixture('multiple-terminals', [
    meta,
    user,
    { type: 'turn-complete', finishReason: 'partial', taskStatus: 'partial', steps: 2 },
    { type: 'turn-complete', finishReason: 'stop', taskStatus: 'completed', steps: 4 },
    { type: 'session-done', finishReason: 'error', steps: 99 }
  ]);
  assert.equal(multiple.finishReason, 'stop', 'last durable turn-complete must win');
  assert.equal(multiple.taskStatus, 'completed');
  assert.equal(multiple.totalSteps, 4);

  const legacy = await fixture('legacy-terminal', [
    meta,
    user,
    { type: 'session-done', finishReason: 'cancelled', steps: 3 }
  ]);
  assert.equal(legacy.terminalSource, 'session-done');
  assert.equal(legacy.taskStatus, 'cancelled');
  assert.equal(legacy.terminalMissing, false);

  const archiveRoot = join(root, 'archive');
  await mkdir(join(archiveRoot, 'sessions'), { recursive: true });
  const archivedPath = join(archiveRoot, 'sessions', 'fixture.jsonl');
  const archivedBytes = [meta, user].map((item) => JSON.stringify(item)).join('\n');
  await writeFile(archivedPath, archivedBytes, 'utf8');
  const fixedTime = new Date('2026-09-09T00:00:00.000Z');
  const refreshed = refreshArchiveIndex(archiveRoot, fixedTime);
  assert.deepEqual(refreshed, { mode: 'index-only', archiveFiles: 1, sourceScanned: false, sessionFilesWritten: 0 });
  assert.equal(await readFile(archivedPath, 'utf8'), archivedBytes, 'index refresh must not rewrite raw sessions');
  assert.deepEqual((await readdir(archiveRoot)).sort(), ['README.md', 'sessions'], 'index refresh must not export or render private sessions');
  const index = await readFile(join(archiveRoot, 'README.md'), 'utf8');
  assert.match(index, /terminal missing/);
  assert.match(index, /未生成/);
  assert.match(index, /不是客户端实时会话列表/);
  assert.match(index, /不复制或改写会话原文/);
  assert.match(index, /不会自动脱敏/);
  assert.match(index, /2026-09-09T00:00:00.000Z/);
  assert.match(index, /本次索引收录 1 个会话/);
  assert.doesNotMatch(index, /的全量历史对话/);
  const emptyIndex = renderArchiveIndex([], 0, fixedTime);
  assert.match(emptyIndex, /本次索引收录 0 个会话/);

  console.log('sync-ai-logs fixture verification passed');
} finally {
  await rm(root, { recursive: true, force: true });
}

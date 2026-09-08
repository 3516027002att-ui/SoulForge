import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateMarkdown, parseSessionFile } from './sync-ai-logs.mjs';

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

  console.log('sync-ai-logs fixture verification passed');
} finally {
  await rm(root, { recursive: true, force: true });
}

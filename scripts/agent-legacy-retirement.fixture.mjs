import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('unused model-authored task ledger has no implementation or executable self-check', () => {
  assert.equal(existsSync('apps/desktop/src/main/agentTaskRecord.ts'), false);
  assert.equal(existsSync('scripts/verify-agent-task-record-gate.mjs'), false);
  for (const file of ['scripts/verify-agent-emevd-proof-gate.mjs','scripts/verify-agent-performance-fixes.mjs']) {
    assert.doesNotMatch(readFileSync(file,'utf8'), /createAgentTaskRecordGateway/);
  }
});

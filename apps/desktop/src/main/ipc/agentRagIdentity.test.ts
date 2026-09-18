import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentRagSearchIdentityCurrent, type AgentRagSearchIdentity } from './agentRagIdentity.js';

const index = {};
const session = {};
const base: AgentRagSearchIdentity = {
  activeIndex: index,
  activeSession: session,
  workspaceSessionId: 'session-a',
  workspaceSessionGeneration: 3,
  ragEpoch: 8,
  ragScope: 'full',
  ragSessionId: 'session-a',
  ragGeneration: 3,
  ragIndexedFilesRevision: 21
};

test('Agent RAG identity accepts the exact snapshot and rejects every changed boundary', () => {
  assert.equal(isAgentRagSearchIdentityCurrent(base, { ...base }), true);
  for (const [name, changed] of [
    ['index', { activeIndex: {} }],
    ['session', { activeSession: {} }],
    ['session id', { workspaceSessionId: 'session-b' }],
    ['generation', { workspaceSessionGeneration: 4 }],
    ['epoch', { ragEpoch: 9 }],
    ['scope', { ragScope: 'canonical-param' }],
    ['rag session id', { ragSessionId: 'session-b' }],
    ['rag generation', { ragGeneration: 4 }],
    ['catalog revision', { ragIndexedFilesRevision: 22 }]
  ] as const) {
    assert.equal(isAgentRagSearchIdentityCurrent(base, { ...base, ...changed }), false, `${name} must invalidate the search`);
  }
});

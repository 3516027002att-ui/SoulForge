import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialStreamRedactor } from './credentialStreamRedactor.js';
import { parseRolloutLines } from './rolloutRecorder.js';

test('redaction preserves ordinary text and handles repeated, overlapping and interleaved prefixes', () => {
  const redactor = new CredentialStreamRedactor('abab-secret', text => text);
  const output = [
    ...redactor.push({type:'text-delta',text:'plain aba'}),
    ...redactor.push({type:'thinking-delta',text:'b-secret abab-'}),
    ...redactor.push({type:'text-delta',text:'secret tail'}),
    ...redactor.flush()
  ];
  assert.equal(output.map(delta => delta.text).join(''), 'plain [REDACTED] [REDACTED] tail');
  assert.equal(redactor.retainedCharacters, 0);
});

test('stream retention is limited to the credential prefix on long and truncated responses', () => {
  const secret = 'fixture-credential';
  const redactor = new CredentialStreamRedactor(secret, text => text);
  for (let index = 0; index < 10000; index++) {
    const chunk = index % 2 ? 'plain response' : 'fixture-';
    redactor.push({type:'text-delta',text:chunk});
    assert.ok(redactor.retainedCharacters < secret.length);
  }
  redactor.push({type:'thinking-delta',text:'fixture-'});
  assert.equal(redactor.flush().map(delta => delta.text).join(''), '[REDACTED]');
  assert.equal(redactor.retainedCharacters, 0);
  assert.throws(() => new CredentialStreamRedactor('x'.repeat(4097), text => text), {code:'AGENT_CREDENTIAL_REDACTION_BUDGET_EXCEEDED'});
});

test('recognized protocol records never invent messages or independent task completion', () => {
  const envelope = {protocolVersion:1,sessionId:'session',runId:'run',requestId:'request',eventSeq:1,event:{type:'turn-complete',finishReason:'stop',steps:1}};
  const result = parseRolloutLines([
    JSON.stringify({type:'protocol-event',envelope}),
    JSON.stringify({type:'protocol-event',envelope:{...envelope,eventSeq:0}}),
    JSON.stringify({type:'unknown-observation'})
  ]);
  assert.equal(result.parseErrors, 2);
  assert.deepEqual(result.messages, []);
  assert.equal(result.terminal, null);
});

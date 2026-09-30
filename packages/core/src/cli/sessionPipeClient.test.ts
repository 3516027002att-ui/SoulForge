import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionPipeClient } from './sessionPipeClient.js';

interface ClientTestPort {
  socket: { destroyed: boolean; write(frame: string, callback: (error?: Error) => void): void; end(): void };
  handshakeDone: boolean;
  roundTrip(frame: object, timeout?: number): Promise<unknown>;
  failPending(error: Error): void;
  onData(chunk: string): void;
}
function client() {
  const instance = new SessionPipeClient();
  const port = instance as unknown as ClientTestPort;
  port.handshakeDone = true;
  port.socket = { destroyed: false, write: (_frame, callback) => callback(), end: () => undefined };
  return { instance, port };
}

test('a transmitted request timeout and disconnect are unknown and cannot be replayed safely', async () => {
  for (const failure of ['timeout', 'disconnect']) {
    const { port } = client();
    const keepAlive = setTimeout(() => undefined, 100);
    try {
      const call = port.roundTrip({ id: 'relative-write', tool: 'opaque', args: {} }, 10);
      if (failure === 'disconnect') port.failPending(new Error('CLI_DAEMON_DISCONNECTED'));
      await assert.rejects(call, (error: unknown) => {
        const outcome = error as { requestId?: string; retryable?: boolean; transaction?: { state: string } };
        assert.equal(outcome.requestId, 'relative-write');
        assert.equal(outcome.retryable, false);
        assert.equal(outcome.transaction?.state, 'unknown');
        return true;
      });
    } finally { clearTimeout(keepAlive); }
  }
});

test('the pipe protocol preserves committed receipts on cancelled replies', async () => {
  const { instance, port } = client();
  const expected = { id: 'cancelled', ok: false, result: { opId: 'operation' }, requestState: 'cancelled', transaction: { opId: 'operation', state: 'committed', operations: [{ opId: 'operation', state: 'committed' }] } };
  const pending = instance.call({ id: 'cancelled', tool: 'opaque', args: {} });
  port.onData(JSON.stringify(expected) + '\n');
  assert.deepEqual(await pending, expected);
});

test('concurrent operation outcome queries have distinct control request identities', async () => {
  const { instance, port } = client();
  const frames: Array<{ id: string }> = [];
  port.socket.write = (frame, callback) => { frames.push(JSON.parse(frame)); callback(); };
  const now = Date.now; Date.now = () => 1;
  try {
    const first = instance.operationStatus('first-op');
    const second = instance.operationStatus('second-op');
    const results = Promise.allSettled([first, second]);
    assert.equal(frames.length, 2, 'queries must not collide in one clock tick');
    assert.notEqual(frames[0]?.id, frames[1]?.id);
    for (const frame of frames) port.onData(JSON.stringify({ id: frame.id, ok: true }) + '\n');
    assert.ok((await results).every(result => result.status === 'fulfilled'));
  } finally { Date.now = now; instance.close(); }
});

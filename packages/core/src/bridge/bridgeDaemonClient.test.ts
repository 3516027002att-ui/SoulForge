import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import type { BridgeDaemonFrame } from '@soulforge/shared';
import { BRIDGE_PROTOCOL_VERSION } from '@soulforge/shared';
import { BridgeDaemonClient, BridgeDaemonError } from './bridgeDaemonClient.js';

const FRAGMENT_BLOCK_BYTES = 16 * 1024;

interface TestBridgeDaemonClient {
  consumeStdout(chunk: string): void;
  handleFrame(frame: BridgeDaemonFrame<unknown>): void;
  failAll(error: Error): void;
  clearCancellationTerminalObservers(): void;
  stdoutBufferBytes: number;
  stdoutBlocks: string[];
  stdoutTailFragments: string[];
  stdoutTailBytes: number;
  stdoutFailed: boolean;
  negotiatedMaxFrameBytes: number;
  closed: boolean;
  options: { workspaceSessionId: string };
  child: TestChild;
  pending: Map<string, unknown>;
  cancellationTerminalObservers: Map<string, {
    onTerminal: (receipt: { requestId: string; outcome: string; cancelRequested: boolean }) => void;
    cancelRequested: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>;
}

interface TestChild extends EventEmitter {
  stdin: { end: () => void; ref: () => void; unref: () => void };
  stdout: { ref: () => void; unref: () => void };
  stderr: { ref: () => void; unref: () => void };
  ref: () => void;
  unref: () => void;
  kill: () => void;
}

interface TestClientHarness {
  client: TestBridgeDaemonClient;
  frames: BridgeDaemonFrame<unknown>[];
  errors: Error[];
  killCount: () => number;
}

function createClientHarness(maxFrameBytes = 64 * 1024, captureFrames = true): TestClientHarness {
  const client = Object.create(BridgeDaemonClient.prototype) as TestBridgeDaemonClient;
  const frames: BridgeDaemonFrame<unknown>[] = [];
  const errors: Error[] = [];
  let kills = 0;
  Object.assign(client, {
    stdoutBuffer: '',
    stdoutBufferBytes: 0,
    stdoutScanned: 0,
    stdoutBlocks: [],
    stdoutTailFragments: [],
    stdoutTailBytes: 0,
    stdoutFailed: false,
    negotiatedMaxFrameBytes: maxFrameBytes,
    closed: false,
    options: { workspaceSessionId: 'bridge-reader-test' },
    child: {
      kill: () => { kills += 1; },
      ref: () => undefined,
      unref: () => undefined,
      stdin: { end: () => undefined, ref: () => undefined, unref: () => undefined },
      stdout: { ref: () => undefined, unref: () => undefined },
      stderr: { ref: () => undefined, unref: () => undefined }
    },
    pending: new Map(),
    cancellationTerminalObservers: new Map()
  });
  if (captureFrames) client.handleFrame = frame => { frames.push(frame); };
  return { client, frames, errors, killCount: () => kills };
}

function installCloseOnEnd(harness: TestClientHarness, duringGrace: () => void): void {
  const child = new EventEmitter() as TestChild;
  child.ref = () => undefined;
  child.unref = () => undefined;
  child.kill = () => undefined;
  child.stdout = { ref: () => undefined, unref: () => undefined };
  child.stderr = { ref: () => undefined, unref: () => undefined };
  child.stdin = {
    ref: () => undefined,
    unref: () => undefined,
    end: () => setImmediate(() => {
      duringGrace();
      queueMicrotask(() => child.emit('close', 0, null));
    })
  };
  child.once('close', () => harness.client.failAll(new BridgeDaemonError(
    'BRIDGE_PROCESS_EXITED', 'fixture child closed.'
  )));
  harness.client.child = child;
}

function validFrame(requestId: string, payload: unknown = { ok: true }): string {
  return JSON.stringify({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    kind: 'result',
    requestId,
    payload
  });
}

function pendingBytes(client: TestBridgeDaemonClient): number {
  return [...client.stdoutBlocks, ...client.stdoutTailFragments]
    .reduce((total, fragment) => total + Buffer.byteLength(fragment, 'utf8'), 0);
}

function recordErrors(harness: TestClientHarness): void {
  // The real failAll keeps the production close/error state machine; this
  // observer only records the transport error it was given.
  const original = harness.client.failAll.bind(harness.client);
  harness.client.failAll = error => {
    harness.errors.push(error);
    original(error);
  };
}

describe('BridgeDaemonClient inbound stdout framing', () => {
  it('scans one-byte fragmented lines in linear input-sized search windows', () => {
    const harness = createClientHarness(32 * 1024);
    recordErrors(harness);
    const wire = `${validFrame('linear', { pad: 'x'.repeat(4 * 1024) })}\n`;
    const originalIndexOf = String.prototype.indexOf;
    let newlineSearchReceiverChars = 0;
    String.prototype.indexOf = function (search, position) {
      if (search === '\n') newlineSearchReceiverChars += this.length;
      return originalIndexOf.call(this, search, position);
    };
    try {
      for (const character of wire) harness.client.consumeStdout(character);
    } finally {
      String.prototype.indexOf = originalIndexOf;
    }

    assert.equal(harness.frames.length, 1);
    assert.equal(harness.frames[0]?.requestId, 'linear');
    assert.ok(
      newlineSearchReceiverChars <= wire.length * 2,
      `newline search receivers grew superlinearly: ${newlineSearchReceiverChars} chars for ${wire.length} input chars`
    );
    assert.deepEqual(harness.errors, []);
  });

  it('compacts tiny tails into bounded blocks and joins the logical line only at newline', () => {
    const harness = createClientHarness(64 * 1024);
    recordErrors(harness);
    const wire = validFrame('fragmented', { pad: 'x'.repeat(FRAGMENT_BLOCK_BYTES) });
    for (const character of wire) harness.client.consumeStdout(character);

    assert.equal(harness.frames.length, 0, 'a partial line is not parsed before its newline');
    assert.equal(harness.client.stdoutBufferBytes, Buffer.byteLength(wire, 'utf8'));
    assert.equal(pendingBytes(harness.client), harness.client.stdoutBufferBytes);
    assert.ok(harness.client.stdoutBlocks.length <= Math.ceil(harness.client.stdoutBufferBytes / FRAGMENT_BLOCK_BYTES));
    assert.ok(harness.client.stdoutTailBytes < FRAGMENT_BLOCK_BYTES);
    assert.ok(harness.client.stdoutTailFragments.length <= FRAGMENT_BLOCK_BYTES);

    harness.client.consumeStdout('\n');
    assert.equal(harness.frames.length, 1);
    assert.equal(harness.frames[0]?.requestId, 'fragmented');
    assert.equal(harness.client.stdoutBufferBytes, 0);
    assert.deepEqual(harness.client.stdoutBlocks, []);
    assert.deepEqual(harness.client.stdoutTailFragments, []);
    assert.deepEqual(harness.errors, []);
  });

  it('preserves blank lines, split CRLF, and decoded Unicode across chunk boundaries', () => {
    const harness = createClientHarness();
    recordErrors(harness);
    const wire = `${validFrame('unicode', { text: 'Sekiro 世界。' })}\r\n`;
    const split = wire.indexOf('世界') + 1;
    for (const chunk of ['\r', '\n', '\n', wire.slice(0, split), wire.slice(split, split + 1), wire.slice(split + 1), '\r', '\n']) {
      harness.client.consumeStdout(chunk);
    }

    assert.equal(harness.frames.length, 1);
    assert.deepEqual(harness.frames[0]?.payload, { text: 'Sekiro 世界。' });
    assert.equal(harness.client.stdoutBufferBytes, 0);
    assert.deepEqual(harness.errors, []);
  });

  it('fails a complete line over the negotiated size and clears partial fragments', () => {
    const limit = 1024;
    const harness = createClientHarness(limit);
    recordErrors(harness);
    const wire = JSON.stringify({ pad: 'x'.repeat(limit) });
    harness.client.consumeStdout(wire);
    assert.equal(harness.client.stdoutBufferBytes, Buffer.byteLength(wire, 'utf8'));
    harness.client.consumeStdout('\n');

    assert.equal(harness.errors[0] instanceof BridgeDaemonError, true);
    assert.equal((harness.errors[0] as BridgeDaemonError).code, 'BRIDGE_FRAME_TOO_LARGE');
    assert.equal(harness.killCount(), 1);
    assert.equal(harness.client.stdoutBufferBytes, 0);
    assert.deepEqual(harness.client.stdoutBlocks, []);
    assert.deepEqual(harness.client.stdoutTailFragments, []);
  });

  it('fails malformed JSON and stops before later buffered frames', () => {
    const harness = createClientHarness();
    recordErrors(harness);
    harness.client.consumeStdout(`{\n${validFrame('must-not-run')}\n`);

    assert.equal((harness.errors[0] as BridgeDaemonError | undefined)?.code, 'BRIDGE_INVALID_JSON');
    assert.equal(harness.killCount(), 1);
    assert.deepEqual(harness.frames, []);
    assert.equal(harness.client.stdoutFailed, true);
    assert.equal(harness.client.stdoutBufferBytes, 0);
  });

  it('treats protocol mismatch as fatal without dispatching later frames from the same chunk', () => {
    const harness = createClientHarness(64 * 1024, false);
    recordErrors(harness);
    const dispatched: BridgeDaemonFrame<unknown>[] = [];
    const handleFrame = harness.client.handleFrame.bind(harness.client);
    harness.client.handleFrame = frame => { dispatched.push(frame); handleFrame(frame); };
    harness.client.consumeStdout(`${JSON.stringify({
      protocolVersion: 'wrong-version', kind: 'result', requestId: 'bad', payload: {}
    })}\n${validFrame('must-not-run')}\n`);

    assert.equal((harness.errors[0] as BridgeDaemonError | undefined)?.code, 'BRIDGE_PROTOCOL_MISMATCH');
    assert.equal(dispatched.length, 1);
    assert.equal(harness.killCount(), 1);
    assert.equal(harness.client.stdoutFailed, true);
  });

  for (const kind of ['result', 'failed', 'cancelled'] as const) {
    it(`delivers a late ${kind} receipt from a complete line during dispose grace`, async () => {
      const harness = createClientHarness(64 * 1024, false);
      const receipts: Array<{ requestId: string; outcome: string; cancelRequested: boolean }> = [];
      const frame: BridgeDaemonFrame<unknown> = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        kind,
        requestId: `late-${kind}`,
        workspaceSessionId: harness.client.options.workspaceSessionId,
        payload: {}
      };
      const wire = `${JSON.stringify(frame)}\n`;
      const split = Math.floor(wire.length / 2);
      harness.client.cancellationTerminalObservers.set(`late-${kind}`, {
        onTerminal: receipt => { receipts.push(receipt); },
        cancelRequested: true
      });
      harness.client.consumeStdout(wire.slice(0, split));
      assert.ok(harness.client.stdoutBufferBytes > 0, 'the first half remains buffered before disposal');
      installCloseOnEnd(harness, () => harness.client.consumeStdout(wire.slice(split)));

      await (harness.client as unknown as { dispose: () => Promise<void> }).dispose();

      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.requestId, `late-${kind}`);
      assert.equal(receipts[0]?.outcome, kind);
      assert.equal(receipts[0]?.cancelRequested, true);
      assert.equal(harness.client.stdoutFailed, true);
      assert.equal(harness.client.stdoutBufferBytes, 0);
      assert.deepEqual(harness.client.stdoutBlocks, []);
      assert.deepEqual(harness.client.stdoutTailFragments, []);
    });
  }

  it('resolves a pending result delivered after dispose closes admission', async () => {
    const harness = createClientHarness(64 * 1024, false);
    const frame: BridgeDaemonFrame<unknown> = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      kind: 'result',
      requestId: 'already-dispatched',
      workspaceSessionId: harness.client.options.workspaceSessionId,
      payload: { committed: true }
    };
    const wire = `${JSON.stringify(frame)}\n`;
    const split = Math.floor(wire.length / 2);
    let resolveResult!: (value: BridgeDaemonFrame<unknown>) => void;
    const result = new Promise<BridgeDaemonFrame<unknown>>(resolve => { resolveResult = resolve; });
    harness.client.pending.set('already-dispatched', {
      terminalKinds: new Set(['result', 'failed', 'cancelled']),
      resolve: resolveResult,
      reject: (error: Error) => { throw error; },
      progressChain: Promise.resolve(),
      requestFrameDispatched: true
    });
    harness.client.consumeStdout(wire.slice(0, split));
    installCloseOnEnd(harness, () => harness.client.consumeStdout(wire.slice(split)));

    await (harness.client as unknown as { dispose: () => Promise<void> }).dispose();
    const resolved = await result;

    assert.equal(resolved.kind, 'result');
    assert.deepEqual(resolved.payload, { committed: true });
  });

  it('clears an incomplete line only after the child actually closes', async () => {
    const harness = createClientHarness(64 * 1024);
    recordErrors(harness);
    harness.client.consumeStdout(`${validFrame('partial-close', { pad: 'unterminated' })}`);
    assert.ok(harness.client.stdoutBufferBytes > 0);
    installCloseOnEnd(harness, () => undefined);

    await (harness.client as unknown as { dispose: () => Promise<void> }).dispose();

    assert.equal(harness.client.stdoutFailed, true);
    assert.equal(harness.client.stdoutBufferBytes, 0);
    assert.deepEqual(harness.client.stdoutBlocks, []);
    assert.deepEqual(harness.client.stdoutTailFragments, []);
  });

  it('fails before storing a chunk that exceeds the two-frame accumulation limit', () => {
    const limit = 512;
    const harness = createClientHarness(limit);
    recordErrors(harness);
    harness.client.consumeStdout('x'.repeat(limit * 2 + 1));

    assert.equal((harness.errors[0] as BridgeDaemonError | undefined)?.code, 'BRIDGE_FRAME_TOO_LARGE');
    assert.equal(harness.killCount(), 1);
    assert.equal(harness.client.stdoutBufferBytes, 0);
    assert.deepEqual(harness.client.stdoutBlocks, []);
    assert.deepEqual(harness.client.stdoutTailFragments, []);
  });

  it('keeps the two-frame bound over the whole incoming chunk before dispatching any line', () => {
    const firstLine = `${validFrame('chunk-a')}\n`;
    const secondLine = `${validFrame('chunk-b')}\n`;
    const limit = Buffer.byteLength(firstLine, 'utf8');
    const harness = createClientHarness(limit);
    recordErrors(harness);
    const wire = `${firstLine}\n${secondLine}`;
    assert.ok(Buffer.byteLength(firstLine, 'utf8') <= limit);
    assert.ok(Buffer.byteLength(secondLine, 'utf8') <= limit);
    assert.ok(Buffer.byteLength(wire, 'utf8') > limit * 2);
    harness.client.consumeStdout(wire);

    assert.equal((harness.errors[0] as BridgeDaemonError | undefined)?.code, 'BRIDGE_FRAME_TOO_LARGE');
    assert.deepEqual(harness.frames, [], 'the frame-buffer boundary is checked before parsing any chunk lines');
    assert.equal(harness.client.stdoutBufferBytes, 0);
  });
});

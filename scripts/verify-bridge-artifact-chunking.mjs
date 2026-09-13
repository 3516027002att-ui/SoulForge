import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(
  process.argv[2] ?? 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
);

const workspace = await mkdtemp(join(tmpdir(), 'soulforge-bridge-artifact-'));
const allowedRoot = join(workspace, 'mod');
const eventPath = join(allowedRoot, 'event', 'm10_00_00_00.synthetic.emevd');
await mkdir(join(allowedRoot, 'event'), { recursive: true });
await writeFile(eventPath, createSyntheticEventFixture(), 'binary');

const sessions = [];
try {
  const smallFrame = await openSession(64 * 1024, 'artifact-64k');
  sessions.push(smallFrame);
  const productionFrame = await openSession(16 * 1024 * 1024, 'artifact-16m');
  sessions.push(productionFrame);

  assert.ok(smallFrame.descriptor.byteLength > 64 * 1024, 'fixture must force file-backed result');
  assert.ok(productionFrame.descriptor.byteLength > 16 * 1024 * 1024, 'fixture must force production file-backed result');
  assert.ok(smallFrame.descriptor.chunkSize > 0);
  assert.ok(productionFrame.descriptor.chunkSize > smallFrame.descriptor.chunkSize);
  assert.ok(productionFrame.descriptor.chunkSize > 32 * 1024);

  const smallArtifact = await readArtifact(smallFrame);
  const productionArtifact = await readArtifact(productionFrame);
  assert.deepEqual(productionArtifact.bytes, smallArtifact.bytes, 'artifact JSON must be byte-for-byte stable across frame budgets');
  assert.ok(
    productionArtifact.requestCount * 10 < smallArtifact.requestCount,
    `16 MiB chunking did not reduce requests enough: 64 KiB=${smallArtifact.requestCount}, 16 MiB=${productionArtifact.requestCount}`
  );
  assert.equal(
    JSON.parse(productionArtifact.bytes.toString('utf8')).parseStatus,
    'partial',
    'restored BridgeResult envelope must remain structured JSON'
  );

  const invalidRequestId = 'artifact-invalid-length';
  productionFrame.send(requestFrame(
    productionFrame.sessionId,
    invalidRequestId,
    eventPath,
    productionFrame.descriptor.artifactToken,
    0,
    productionFrame.descriptor.chunkSize + 1
  ));
  const invalid = await productionFrame.waitFor((frame) => frame.requestId === invalidRequestId && frame.kind === 'result');
  assert.equal(invalid.payload.result.parseStatus, 'failed', 'oversized artifact index must fail closed');
  assert.equal(invalid.payload.result.diagnostics?.[0]?.code, 'BRIDGE_ARTIFACT_READ_FAILED');

  const recovery = await readOneChunk(productionFrame, 0, productionFrame.descriptor.chunkSize);
  assert.ok(recovery.length > 0, 'valid artifact read must recover after rejected index');

  const cancelRequestId = 'artifact-cancel-race';
  productionFrame.send(requestFrame(
    productionFrame.sessionId,
    cancelRequestId,
    eventPath,
    productionFrame.descriptor.artifactToken,
    0,
    productionFrame.descriptor.chunkSize
  ));
  const cancelAccepted = await productionFrame.waitFor(
    (frame) => frame.kind === 'request/accepted' && frame.requestId === cancelRequestId
  );
  assert.equal(cancelAccepted.requestId, cancelRequestId, 'cancel target must be accepted before cancellation');
  productionFrame.send({
    protocolVersion: '1.0.0',
    kind: 'cancel',
    requestId: 'artifact-cancel-control',
    workspaceSessionId: productionFrame.sessionId,
    payload: { targetRequestId: cancelRequestId }
  });
  const cancellationRace = await productionFrame.waitFor(
    (frame) => frame.requestId === cancelRequestId && frame.kind === 'cancelled'
  );
  assert.equal(cancellationRace.requestId, cancelRequestId, 'cancellation terminal must belong to the accepted target');
  assert.equal(cancellationRace.workspaceSessionId, productionFrame.sessionId);
  assert.equal(cancellationRace.payload?.code, 'BRIDGE_REQUEST_CANCELLED');
  const recoveryAfterCancel = await readOneChunk(productionFrame, 0, productionFrame.descriptor.chunkSize);
  assert.ok(recoveryAfterCancel.length > 0, 'artifact store must remain readable after cancellation race');

  console.log(JSON.stringify({
    ok: true,
    fixtureBytes: (await (await import('node:fs/promises')).readFile(eventPath)).length,
    smallFrame: {
      maxFrameBytes: smallFrame.maxFrameBytes,
      maxRawFrameBytes: smallFrame.maxRawFrameBytes,
      artifactByteLength: smallFrame.descriptor.byteLength,
      chunkSize: smallFrame.descriptor.chunkSize,
      requestCount: smallArtifact.requestCount
    },
    productionFrame: {
      maxFrameBytes: productionFrame.maxFrameBytes,
      maxRawFrameBytes: productionFrame.maxRawFrameBytes,
      artifactByteLength: productionFrame.descriptor.byteLength,
      chunkSize: productionFrame.descriptor.chunkSize,
      requestCount: productionArtifact.requestCount
    },
    invalidLengthCode: invalid.payload.result.diagnostics?.[0]?.code,
    cancellationRaceKind: cancellationRace.kind
  }, null, 2));
} finally {
  for (const session of sessions) await session.close();
  await rm(workspace, { recursive: true, force: true });
}

function createSyntheticEventFixture() {
  const eventCount = 300;
  const instructionCount = 250;
  const eventTableStart = 32;
  const instructionTableStart = eventTableStart + eventCount * 16;
  const instructionBytes = eventCount * instructionCount * 24;
  const bytes = Buffer.alloc(instructionTableStart + instructionBytes);
  bytes.write('EVD\0', 0, 'ascii');
  bytes.write('SFEV', 4, 'ascii');
  bytes.writeInt32LE(1, 8);
  bytes.writeInt32LE(eventCount, 12);
  bytes.writeInt32LE(eventTableStart, 16);
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const eventOffset = eventTableStart + eventIndex * 16;
    bytes.writeInt32LE(eventIndex + 1, eventOffset);
    bytes.writeInt32LE(instructionCount, eventOffset + 4);
    bytes.writeInt32LE(instructionTableStart + eventIndex * instructionCount * 24, eventOffset + 8);
    for (let instructionIndex = 0; instructionIndex < instructionCount; instructionIndex += 1) {
      const row = instructionTableStart + (eventIndex * instructionCount + instructionIndex) * 24;
      bytes.writeInt32LE(instructionIndex, row);
      bytes.writeInt32LE(1000 + instructionIndex, row + 4);
      bytes.writeInt32LE((instructionIndex % 6) + 1, row + 8);
      bytes.writeInt32LE(0x10000000 + instructionIndex, row + 12);
      bytes.writeInt32LE((instructionIndex % 3) + 1, row + 16);
    }
  }
  return bytes;
}

async function openSession(maxFrameBytes, sessionId) {
  const child = spawn(executable, ['daemon'], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let stderr = '';
  const frames = [];
  const waiters = [];
  let maxRawFrameBytes = 0;
  let oversizedRawFrame = null;
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const rawLine = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const rawFrameBytes = Buffer.byteLength(rawLine, 'utf8');
      maxRawFrameBytes = Math.max(maxRawFrameBytes, rawFrameBytes);
      if (rawFrameBytes > maxFrameBytes && oversizedRawFrame === null) {
        oversizedRawFrame = rawFrameBytes;
      }
      const line = rawLine.trim();
      if (!line) continue;
      frames.push(JSON.parse(line));
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const session = {
    child,
    sessionId,
    maxFrameBytes,
    get maxRawFrameBytes() { return maxRawFrameBytes; },
    get oversizedRawFrame() { return oversizedRawFrame; },
    frames,
    send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); },
    waitFor(predicate, timeoutMs = 30_000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveFrame, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(check);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for Bridge frame; stderr=${stderr}`));
        }, timeoutMs);
        const check = () => {
          const match = frames.find(predicate);
          if (!match) return;
          clearTimeout(timeout);
          const index = waiters.indexOf(check);
          if (index >= 0) waiters.splice(index, 1);
          resolveFrame(match);
        };
        waiters.push(check);
      });
    },
    async close() {
      if (child.stdin.writable) child.stdin.end();
      await new Promise((resolveClose, rejectClose) => {
        const timeout = setTimeout(() => {
          child.kill();
          rejectClose(new Error(`Bridge daemon did not exit; stderr=${stderr}`));
        }, 10_000);
        child.once('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) rejectClose(new Error(`Bridge daemon exited with ${code}; stderr=${stderr}`));
          else resolveClose();
        });
      });
    }
  };
  session.send({
    protocolVersion: '1.0.0',
    kind: 'handshake',
    requestId: `${sessionId}-handshake`,
    workspaceSessionId: sessionId,
    payload: { allowedRoots: [allowedRoot], maxFrameBytes, maxConcurrency: 2 }
  });
  const handshake = await session.waitFor((frame) => frame.kind === 'handshake' && frame.requestId === `${sessionId}-handshake`);
  assert.equal(handshake.payload.maxFrameBytes, maxFrameBytes);

  const requestId = `${sessionId}-export`;
  session.send({
    protocolVersion: '1.0.0',
    kind: 'request',
    requestId,
    workspaceSessionId: sessionId,
    resourceUri: pathToFileURL(eventPath).toString(),
    payload: { command: 'export-event', filePath: eventPath }
  });
  const initial = await session.waitFor((frame) => frame.kind === 'result' && frame.requestId === requestId);
  const descriptor = initial.payload.result.data?.fileBacked;
  assert.ok(descriptor, `expected file-backed result: ${JSON.stringify(initial)}`);
  session.descriptor = descriptor;
  session.resourceUri = pathToFileURL(eventPath).toString();
  return session;
}

async function readArtifact(session) {
  const buffers = [];
  let offset = 0;
  let requestCount = 0;
  while (offset < session.descriptor.byteLength) {
    const length = Math.min(session.descriptor.chunkSize, session.descriptor.byteLength - offset);
    assert.ok(length > 0, 'artifact chunk length must be positive');
    assert.ok(offset >= 0 && offset + length <= session.descriptor.byteLength, 'artifact chunk must stay within byteLength');
    buffers.push(await readOneChunk(session, offset, length));
    offset += buffers[buffers.length - 1].length;
    requestCount += 1;
  }
  assert.equal(offset, session.descriptor.byteLength, 'artifact chunks must end exactly at byteLength');
  assert.equal(Buffer.concat(buffers).length, session.descriptor.byteLength, 'artifact bytes must cover byteLength exactly');
  assert.equal(session.oversizedRawFrame, null, `raw stdout frame exceeded negotiated limit: ${session.oversizedRawFrame}`);
  return { bytes: Buffer.concat(buffers), requestCount };
}

async function readOneChunk(session, offset, length) {
  assert.ok(Number.isInteger(offset) && offset >= 0, 'artifact offset must be a non-negative integer');
  assert.ok(Number.isInteger(length) && length > 0, 'artifact length must be a positive integer');
  assert.ok(offset + length <= session.descriptor.byteLength, 'artifact request must stay within byteLength');
  const requestId = `${session.sessionId}-artifact-${offset}-${length}-${Math.random()}`;
  session.send(requestFrame(session.sessionId, requestId, eventPath, session.descriptor.artifactToken, offset, length));
  const frame = await session.waitFor((item) => item.kind === 'result' && item.requestId === requestId);
  assert.equal(session.oversizedRawFrame, null, `raw stdout frame exceeded negotiated limit: ${session.oversizedRawFrame}`);
  assert.equal(frame.payload.result.parseStatus, 'partial');
  const chunk = frame.payload.result.data;
  assert.equal(chunk.artifactToken, session.descriptor.artifactToken);
  assert.equal(chunk.offset, offset);
  assert.equal(chunk.length, length);
  assert.equal(chunk.totalLength, session.descriptor.byteLength);
  const bytes = Buffer.from(chunk.dataBase64, 'base64');
  assert.equal(bytes.length, length);
  return bytes;
}

function requestFrame(sessionId, requestId, filePath, artifactToken, offset, length) {
  return {
    protocolVersion: '1.0.0',
    kind: 'request',
    requestId,
    workspaceSessionId: sessionId,
    resourceUri: pathToFileURL(filePath).toString(),
    payload: {
      command: 'read-bridge-artifact',
      filePath,
      options: { artifactToken, offset, length }
    }
  };
}

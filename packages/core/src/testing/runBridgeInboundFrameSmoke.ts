/**
 * Inbound frame reader smoke (BridgeDaemonClient.consumeStdout).
 *
 * The outbound frame limit already had coverage (runBridgeRecoveryHarnessSmoke
 * sends an oversized request); the INBOUND reader had none. It now maintains
 * its buffer byte count incrementally instead of re-measuring the whole buffer
 * per chunk — needed because read-emevd-document can answer with a single
 * multi-MiB frame split across hundreds of stdout chunks, where the old
 * per-chunk rescan was quadratic.
 *
 * Incremental accounting can drift, and drift is invisible in normal use, so
 * both directions are asserted here:
 *   many — 200 sub-limit frames whose combined size far exceeds the limit must
 *          ALL resolve. Over-counting (e.g. dropping the newline byte, or
 *          measuring the trimmed line so CRLF's '\r' leaks) accumulates and
 *          trips the guard, failing this case.
 *   huge — a single frame past 2x the limit must still trip the guard, so
 *          under-counting cannot silently disable it.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeDaemonClient, BridgeDaemonError } from '../bridge/bridgeDaemonClient.js';

const LIMIT = 65536;

/**
 * Fake NDJSON daemon impersonating just enough of BridgeDaemonHost to drive the
 * client's inbound reader. Written to a temp file so it needs no build step
 * (tsc would not copy a .mjs into dist/). Spawned as `node <file> daemon`,
 * matching BridgeDaemonClient.start's `[...args, 'daemon']` convention.
 */
const FAKE_DAEMON_SOURCE = String.raw`
const PROTOCOL = '1.0.0';
const LIMIT = Number(process.env.SOULFORGE_FAKE_FRAME_LIMIT ?? 65536);
const MODE = process.env.SOULFORGE_FAKE_FRAME_MODE ?? 'many';

const write = (text) => new Promise((resolve) => {
  if (process.stdout.write(text)) resolve();
  else process.stdout.once('drain', resolve);
});

const frame = (kind, requestId, payload) => JSON.stringify({
  protocolVersion: PROTOCOL, kind, requestId, payload
});

let buffer = '';
let busy = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = [];
  while (true) {
    const nl = buffer.indexOf('\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) lines.push(line);
  }
  // Serialize responses so interleaved writes cannot corrupt a frame.
  busy = busy.then(async () => {
    for (const line of lines) {
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (request.kind === 'handshake') {
        await write(frame('handshake', request.requestId, { maxFrameBytes: LIMIT }) + '\n');
        continue;
      }
      if (request.kind !== 'request') continue;

      if (MODE === 'huge') {
        // Oversized frame, streamed, never newline-terminated: the guard must
        // fire on accumulated bytes rather than on frame completion.
        await write('{"protocolVersion":"' + PROTOCOL + '","kind":"result","requestId":"'
          + request.requestId + '","payload":{"blob":"');
        const pad = 'x'.repeat(8 * 1024);
        let sent = 0;
        while (sent < LIMIT * 3) { await write(pad); sent += pad.length; }
        continue;
      }

      // 'many': one modest frame per request, split across small chunks and
      // CRLF-terminated so byte accounting must survive the '\r' that trim()
      // strips from the parsed line. Multi-byte pad keeps bytes != chars.
      const text = frame('result', request.requestId, { ok: true, pad: '。'.repeat(700) }) + '\r\n';
      for (let i = 0; i < text.length; i += 97) await write(text.slice(i, i + 97));
    }
  });
});
`;

async function startFake(mode: 'many' | 'huge', daemonPath: string): Promise<BridgeDaemonClient> {
  process.env.SOULFORGE_FAKE_FRAME_MODE = mode;
  process.env.SOULFORGE_FAKE_FRAME_LIMIT = String(LIMIT);
  return BridgeDaemonClient.start({
    executable: process.execPath,
    args: [daemonPath],
    allowedRoots: [],
    workspaceSessionId: 'inbound-frame-smoke',
    maxFrameBytes: LIMIT,
    startupTimeoutMs: 20_000
  });
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  const dir = await mkdtemp(join(tmpdir(), 'soulforge-inbound-frame-'));
  const daemonPath = join(dir, 'fakeBridgeFrameDaemon.mjs');
  await writeFile(daemonPath, FAKE_DAEMON_SOURCE, 'utf8');
  try {
    await run(results, daemonPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'bridge inbound frame smoke passed',
    ...results
  }, null, 2));
}

async function run(results: Record<string, unknown>, daemonPath: string): Promise<void> {
  // --- positive / no-drift ------------------------------------------------
  const manyClient = await startFake('many', daemonPath);
  try {
    const FRAMES = 200;
    let resolved = 0;
    for (let i = 0; i < FRAMES; i += 1) {
      const payload = await manyClient.request<{ ok: boolean; pad: string }>({
        payload: { command: 'health', filePath: `frame-${i}` },
        resourceUri: `file://inbound-frame/${i}`,
        timeoutMs: 20_000
      });
      if ((payload as unknown as { ok: boolean }).ok !== true) {
        throw new Error(`frame ${i} payload malformed`);
      }
      resolved += 1;
    }
    if (resolved !== FRAMES) throw new Error(`resolved ${resolved} != ${FRAMES}`);
    // Each frame is ~2.2 KiB; 200 of them is far past the 64 KiB limit.
    results.manyFramesResolved = resolved;
    results.manyTotalBytesExceedsLimit = true;

    // The guard alone is a weak witness: it only trips at 2x the limit, so a
    // small per-frame drift (e.g. measuring the trimmed line and losing CRLF's
    // '\r') would need ~131072 frames to surface. Assert the invariant instead
    // — the counter must exactly equal the live buffer's byte length, which
    // pins drift of even one byte. TS `private` is erased at runtime.
    const internals = manyClient as unknown as {
      stdoutBuffer: string;
      stdoutBufferBytes: number;
      stdoutScanned: number;
    };
    const actualBytes = Buffer.byteLength(internals.stdoutBuffer, 'utf8');
    if (internals.stdoutBufferBytes !== actualBytes) {
      throw new Error(
        `inbound byte accounting drifted: counter=${internals.stdoutBufferBytes} actual=${actualBytes}`
      );
    }
    if (internals.stdoutScanned > internals.stdoutBuffer.length) {
      throw new Error(
        `scan offset past buffer end: scanned=${internals.stdoutScanned} length=${internals.stdoutBuffer.length}`
      );
    }
    results.byteCounterMatchesBuffer = `${internals.stdoutBufferBytes}==${actualBytes}`;
  } finally {
    await manyClient.dispose();
  }

  // --- negative / guard still fires ---------------------------------------
  const hugeClient = await startFake('huge', daemonPath);
  let guardCode = 'NONE';
  try {
    await hugeClient.request({
      payload: { command: 'health', filePath: 'oversized' },
      resourceUri: 'file://inbound-frame/oversized',
      timeoutMs: 20_000
    });
  } catch (error) {
    guardCode = error instanceof BridgeDaemonError ? error.code : `UNEXPECTED:${String(error)}`;
  } finally {
    await hugeClient.dispose();
  }
  if (guardCode !== 'BRIDGE_FRAME_TOO_LARGE') {
    throw new Error(`oversized inbound frame did not trip the guard: ${guardCode}`);
  }
  results.oversizedInboundFrame = guardCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

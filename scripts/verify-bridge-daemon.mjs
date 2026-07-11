import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = resolve(
  process.argv[2] ?? 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
);
const root = await mkdtemp(join(tmpdir(), 'soulforge-bridge-daemon-'));
const allowedRoot = join(root, 'mod');
const outsideRoot = join(root, 'outside');
await mkdir(allowedRoot, { recursive: true });
await mkdir(outsideRoot, { recursive: true });
const insideFile = join(allowedRoot, 'event', 'sample.emevd');
const outsideFile = join(outsideRoot, 'outside.bin');
await mkdir(join(allowedRoot, 'event'), { recursive: true });
await writeFile(insideFile, Buffer.from('EVD\0synthetic-daemon-smoke', 'binary'));
await writeFile(outsideFile, Buffer.from('outside'));

const child = spawn(executable, ['daemon'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

let stdoutBuffer = '';
let stderr = '';
const frames = [];
const waiters = [];
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    frames.push(frame);
    for (const waiter of [...waiters]) waiter();
  }
});
child.stderr.on('data', (chunk) => { stderr += chunk; });

const sessionId = 'bridge-daemon-smoke-session';
send({
  protocolVersion: '1.0.0',
  kind: 'handshake',
  requestId: 'handshake-1',
  workspaceSessionId: sessionId,
  payload: { allowedRoots: [allowedRoot], maxFrameBytes: 262144, maxConcurrency: 2 }
});
const handshake = await waitFor((frame) => frame.kind === 'handshake' && frame.requestId === 'handshake-1');
assert(handshake.payload.protocolVersion === '1.0.0', 'handshake protocol version');
assert(handshake.payload.maxConcurrency === 2, 'handshake concurrency');

send(baseFrame('health', 'health-1', {}));
const health = await waitFor((frame) => frame.kind === 'health' && frame.requestId === 'health-1');
assert(health.payload.status === 'ok', 'health response');

send(baseFrame('request', 'inspect-1', {
  command: 'inspect',
  filePath: insideFile
}, 'file://event/sample.emevd'));
await waitFor((frame) => frame.kind === 'request/accepted' && frame.requestId === 'inspect-1');
const result = await waitFor((frame) => frame.kind === 'result' && frame.requestId === 'inspect-1');
assert(result.payload.nativeFormatAuthority === false, 'candidate result must not claim native authority');
assert(result.payload.authority === 'candidate', 'inspect authority');
assert(result.payload.result.parseStatus === 'partial', 'inspect result parse status');

send(baseFrame('request', 'outside-1', {
  command: 'inspect',
  filePath: outsideFile
}, 'file://outside.bin'));
const outsideFailure = await waitFor((frame) => frame.kind === 'failed' && frame.requestId === 'outside-1');
assert(outsideFailure.payload.code === 'BRIDGE_PATH_OUTSIDE_ALLOWED_ROOTS', 'outside root rejection');

const escapeLink = join(allowedRoot, 'escape-link');
await symlink(outsideRoot, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
send(baseFrame('request', 'junction-1', {
  command: 'inspect',
  filePath: join(escapeLink, 'outside.bin')
}, 'file://escape-link/outside.bin'));
const junctionFailure = await waitFor((frame) => frame.kind === 'failed' && frame.requestId === 'junction-1');
assert(junctionFailure.payload.code === 'BRIDGE_REPARSE_POINT_ESCAPE', 'junction escape rejection');

send({
  ...baseFrame('request', 'deadline-1', { command: 'inspect', filePath: insideFile }),
  deadlineUtc: new Date(Date.now() - 1000).toISOString()
});
const deadlineFailure = await waitFor((frame) => frame.kind === 'failed' && frame.requestId === 'deadline-1');
assert(deadlineFailure.payload.code === 'BRIDGE_DEADLINE_EXCEEDED', 'expired deadline rejection');

send(baseFrame('cancel', 'cancel-1', { targetRequestId: 'not-active' }));
const cancelFailure = await waitFor((frame) => frame.kind === 'failed' && frame.requestId === 'cancel-1');
assert(cancelFailure.payload.code === 'BRIDGE_REQUEST_NOT_ACTIVE', 'cancel route');

child.stdin.end();
const exitCode = await new Promise((resolveExit, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('Bridge daemon did not exit after stdin closed.'));
  }, 5000);
  child.once('close', (code) => {
    clearTimeout(timeout);
    resolveExit(code);
  });
});
assert(exitCode === 0, `daemon exit code ${exitCode}; stderr=${stderr}`);

console.log(JSON.stringify({
  ok: true,
  message: 'Bridge 1.0.0 NDJSON 常驻协议验证通过',
  frames: frames.map((frame) => `${frame.kind}:${frame.requestId ?? '-'}`),
  stderr
}, null, 2));

function baseFrame(kind, requestId, payload, resourceUri) {
  return {
    protocolVersion: '1.0.0',
    kind,
    requestId,
    workspaceSessionId: sessionId,
    ...(resourceUri ? { resourceUri } : {}),
    payload
  };
}

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

async function waitFor(predicate, timeoutMs = 5000) {
  const existing = frames.find(predicate);
  if (existing) return existing;
  return new Promise((resolveFrame, reject) => {
    const timeout = setTimeout(() => {
      const index = waiters.indexOf(check);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Timed out waiting for frame. stderr=${stderr}; frames=${JSON.stringify(frames)}`));
    }, timeoutMs);
    function check() {
      const match = frames.find(predicate);
      if (!match) return;
      clearTimeout(timeout);
      const index = waiters.indexOf(check);
      if (index >= 0) waiters.splice(index, 1);
      resolveFrame(match);
    }
    waiters.push(check);
  });
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

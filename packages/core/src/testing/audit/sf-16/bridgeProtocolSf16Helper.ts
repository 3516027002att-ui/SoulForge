import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { TextDecoder } from 'node:util';
import { join } from 'node:path';

export interface Sf16ProtocolOptions {
  executable: string;
  root: string;
  sourcePath: string;
  queuePath?: string;
  maxFrameBytes?: number;
}

export interface Sf16ProtocolAudit {
  advertisedCount: number;
  descriptorCount: number;
  dispatchProbes: string[];
  invalidUtf8Code: string;
  incompleteEofCode: string;
  oversizedFrameCode: string;
  queueBusyObserved: number;
  cancellationObserved: boolean;
  maxActiveObserved: number;
}

interface RawFrame {
  protocolVersion?: string;
  kind: string;
  requestId?: string;
  payload?: unknown;
}

interface CommandDescriptor {
  name: string;
  effect: string;
  advertised: boolean;
  requiredInputFields: string[];
  requiresOutputPath: boolean;
  handler: string;
}

const PROTOCOL = '1.0.0';
const DEFAULT_LIMIT = 64 * 1024;

/**
 * This helper deliberately launches the production daemon and speaks its raw
 * protocol. It is not a second Bridge implementation: it only provides a
 * small strict reader so the smoke can exercise malformed byte streams that
 * BridgeDaemonClient correctly refuses before JSON parsing.
 */
export async function runSf16ProtocolAudit(options: Sf16ProtocolOptions): Promise<Sf16ProtocolAudit> {
  const limit = options.maxFrameBytes ?? DEFAULT_LIMIT;
  const normal = await startSession(options, limit);
  try {
    const capabilities = await request(normal, 'capabilities', {
      command: 'capabilities',
      filePath: options.sourcePath
    });
    const payload = asRecord(capabilities.payload);
    const advertised = stringArray(payload.commands);
    const descriptors = descriptorArray(payload.commandDescriptors);
    const descriptorNames = descriptors.filter((item) => item.advertised).map((item) => item.name);
    equalSet(advertised, descriptorNames, 'advertised command projection drift');
    for (const descriptor of descriptors) {
      if (!descriptor.handler || descriptor.requiredInputFields.length < 2) {
        throw new Error(`invalid command descriptor: ${descriptor.name}`);
      }
      if (descriptor.requiresOutputPath && descriptor.effect !== 'write' && descriptor.effect !== 'export') {
        throw new Error(`output path effect mismatch: ${descriptor.name}`);
      }
    }

    const probes = ['inspect', 'validate', 'export-event', 'read-bridge-artifact', 'write-param'];
    for (const command of probes) {
      const descriptor = descriptors.find((item) => item.name === command);
      if (!descriptor) throw new Error(`descriptor missing production command ${command}`);
      const commandOptions = descriptor.requiresOutputPath
        ? { outputPath: join(options.root, 'staging', `${command.replaceAll('/', '-')}.out`) }
        : command === 'read-bridge-artifact'
          ? { artifactToken: 'missing-token', offset: 0, length: 1 }
          : undefined;
      const response = await request(normal, command, {
        command,
        filePath: options.sourcePath,
        ...(commandOptions ? { options: commandOptions } : {})
      });
      if (response.kind === 'failed' && asRecord(response.payload).code === 'UNKNOWN_COMMAND') {
        throw new Error(`production dispatch rejected descriptor command ${command}`);
      }
    }

    const unknown = await request(normal, 'sf16-unknown-command', {
      command: 'sf16-unknown-command',
      filePath: options.sourcePath
    });
    if (asRecord(unknown.payload).code !== 'UNKNOWN_COMMAND') {
      throw new Error(`unknown command was not rejected: ${JSON.stringify(unknown)}`);
    }

    const queue = await exerciseQueue(normal, options.queuePath ?? options.sourcePath, limit);
    await closeSession(normal);

    const invalidUtf8Code = await runInvalidUtf8Session(options, limit);
    const incompleteEofCode = await runIncompleteEofSession(options, limit);
    const oversizedFrameCode = await runOversizedSession(options, limit);
    return {
      advertisedCount: advertised.length,
      descriptorCount: descriptors.length,
      dispatchProbes: probes,
      invalidUtf8Code,
      incompleteEofCode,
      oversizedFrameCode,
      ...queue
    };
  } finally {
    await closeSession(normal);
  }
}

async function exerciseQueue(
  session: RawProtocolSession,
  sourcePath: string,
  limit: number
): Promise<Pick<Sf16ProtocolAudit, 'queueBusyObserved' | 'cancellationObserved' | 'maxActiveObserved'>> {
  const requestIds: string[] = [];
  const requestCount = 256;
  const sendQueueRequest = async (i: number): Promise<void> => {
    const requestId = `sf16-queue-${i}`;
    requestIds.push(requestId);
    await session.send({
      protocolVersion: PROTOCOL,
      kind: 'request',
      requestId,
      workspaceSessionId: 'sf16-smoke',
      deadlineUtc: new Date(Date.now() + 30_000).toISOString(),
      payload: {
        command: 'read-dcx-document',
        filePath: sourcePath,
        options: { includePayload: false },
        priority: i % 3 === 0 ? 'interactive' : 'background'
      }
    }, 4096);
  };

  // Fill both active slots first, then put one deterministic request behind
  // them. The cancel control frame is deliberately inserted before the rest
  // of the burst so it targets a queued request rather than a request already
  // rejected with BRIDGE_BUSY.
  await sendQueueRequest(0);
  await sendQueueRequest(1);
  await sendQueueRequest(2);

  const cancelTarget = requestIds[2]!;
  await session.send({
    protocolVersion: PROTOCOL,
    kind: 'cancel',
    requestId: 'sf16-cancel-control',
    workspaceSessionId: 'sf16-smoke',
    payload: { targetRequestId: cancelTarget }
  }, 13);
  for (let i = 3; i < requestCount; i += 1) await sendQueueRequest(i);
  const healthId = 'sf16-health-control';
  await session.send({
    protocolVersion: PROTOCOL,
    kind: 'health',
    requestId: healthId,
    workspaceSessionId: 'sf16-smoke',
    payload: {}
  }, 13);

  let terminals = 0;
  let queueBusyObserved = 0;
  let cancellationObserved = false;
  let maxActiveObserved = 0;
  const deadline = Date.now() + 45_000;
  while (terminals < requestCount && Date.now() < deadline) {
    const frame = await session.next(45_000);
    if (frame.requestId === healthId && frame.kind === 'health') {
      const health = asRecord(frame.payload);
      if (typeof health.activeRequests === 'number') maxActiveObserved = Math.max(maxActiveObserved, health.activeRequests);
      continue;
    }
    if (!frame.requestId || !frame.requestId.startsWith('sf16-queue-')) continue;
    if (frame.kind === 'request/accepted' || frame.kind === 'progress') continue;
    terminals += 1;
    if (frame.kind === 'failed' && asRecord(frame.payload).code === 'BRIDGE_BUSY') queueBusyObserved += 1;
    if (frame.kind === 'cancelled' || asRecord(frame.payload).code === 'BRIDGE_REQUEST_CANCELLED') cancellationObserved = true;
  }
  if (queueBusyObserved === 0) {
    throw new Error('queue pressure did not produce BRIDGE_BUSY');
  }
  if (!cancellationObserved) throw new Error('cancel control did not produce a cancellation terminal result');
  if (maxActiveObserved > 2) throw new Error(`active request count exceeded configured bound: ${maxActiveObserved}`);
  return { queueBusyObserved, cancellationObserved, maxActiveObserved };
}

async function runInvalidUtf8Session(options: Sf16ProtocolOptions, limit: number): Promise<string> {
  const session = await spawnSession(options, limit);
  try {
    await session.sendBytes(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d, 0x0a]));
    const frame = await session.next();
    const code = asRecord(frame.payload).code;
    if (code !== 'BRIDGE_INVALID_UTF8') throw new Error(`invalid UTF-8 was accepted: ${JSON.stringify(frame)}`);
    return code;
  } finally {
    await closeSession(session);
  }
}

async function runIncompleteEofSession(options: Sf16ProtocolOptions, limit: number): Promise<string> {
  const session = await spawnSession(options, limit);
  try {
    await session.sendBytes(Buffer.from('{"protocolVersion":"1.0.0"', 'utf8'));
    session.child.stdin.end();
    const frame = await session.next();
    const code = asRecord(frame.payload).code;
    if (code !== 'BRIDGE_EOF_INCOMPLETE_FRAME') throw new Error(`half frame was accepted: ${JSON.stringify(frame)}`);
    return code;
  } finally {
    await closeSession(session);
  }
}

async function runOversizedSession(options: Sf16ProtocolOptions, limit: number): Promise<string> {
  const session = await startSession(options, limit);
  try {
    const oversized = Buffer.concat([
      Buffer.from('{"protocolVersion":"1.0.0","kind":"health","requestId":"oversized","workspaceSessionId":"sf16-smoke","payload":{"blob":"', 'utf8'),
      Buffer.alloc(limit, 0x78),
      Buffer.from('"}}\n', 'utf8')
    ]);
    await session.sendBytes(oversized, 4096);
    const frame = await session.next();
    const code = asRecord(frame.payload).code;
    if (code !== 'BRIDGE_FRAME_TOO_LARGE') throw new Error(`oversized frame was accepted: ${JSON.stringify(frame)}`);
    return code;
  } finally {
    await closeSession(session);
  }
}

async function startSession(options: Sf16ProtocolOptions, limit: number): Promise<RawProtocolSession> {
  const session = await spawnSession(options, limit);
  await session.send({
    protocolVersion: PROTOCOL,
    kind: 'handshake',
    requestId: 'sf16-handshake',
    workspaceSessionId: 'sf16-smoke',
    payload: {
      allowedRoots: [options.root],
      writableRoots: [join(options.root, 'staging')],
      maxFrameBytes: limit,
      maxConcurrency: 2
    }
  }, 17);
  const frame = await session.next();
  if (frame.kind !== 'handshake') throw new Error(`handshake failed: ${JSON.stringify(frame)}`);
  return session;
}

async function spawnSession(options: Sf16ProtocolOptions, limit: number): Promise<RawProtocolSession> {
  const child = spawn(options.executable, ['daemon'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const session = new RawProtocolSession(child, limit);
  await session.waitForSpawn();
  return session;
}

async function request(session: RawProtocolSession, command: string, payload: Record<string, unknown>): Promise<RawFrame> {
  const requestId = `sf16-${command}-${Math.random().toString(16).slice(2)}`;
  await session.send({
    protocolVersion: PROTOCOL,
    kind: command === 'capabilities' ? 'capabilities' : 'request',
    requestId,
    workspaceSessionId: 'sf16-smoke',
    deadlineUtc: new Date(Date.now() + 30_000).toISOString(),
    payload: command === 'capabilities' ? {} : payload
  }, 29);
  while (true) {
    const frame = await session.next();
    if (frame.requestId !== requestId) continue;
    if (frame.kind === 'request/accepted' || frame.kind === 'progress') continue;
    return frame;
  }
}

async function closeSession(session: RawProtocolSession): Promise<void> {
  if (session.closed) return;
  if (!session.child.stdin.destroyed && !session.child.stdin.writableEnded)
    session.child.stdin.end();
  if (session.child.exitCode === null && session.child.signalCode === null)
    await once(session.child, 'close').catch(() => undefined);
  session.closed = true;
}

class RawProtocolSession {
  private buffer = Buffer.alloc(0);
  private readonly frames: RawFrame[] = [];
  private readonly waiters: Array<{ resolve: (frame: RawFrame) => void; reject: (error: Error) => void }> = [];
  private spawnError: Error | undefined;
  public closed = false;

  constructor(public readonly child: ChildProcessWithoutNullStreams, private readonly maxFrameBytes: number) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.once('error', (error) => {
      this.spawnError = error;
      this.rejectWaiters(error);
    });
    child.stderr.resume();
  }

  async waitForSpawn(): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    await new Promise<void>((resolve, reject) => {
      if (this.child.pid) {
        resolve();
        return;
      }
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
  }

  async send(frame: RawFrame & Record<string, unknown>, chunkSize: number): Promise<void> {
    await this.sendBytes(Buffer.concat([Buffer.from(JSON.stringify(frame), 'utf8'), Buffer.from([0x0a])]), chunkSize);
  }

  async sendBytes(bytes: Buffer, chunkSize = bytes.length): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      if (!this.child.stdin.write(part)) await once(this.child.stdin, 'drain');
    }
  }

  async next(timeoutMs = 20_000): Promise<RawFrame> {
    if (this.frames.length > 0) return this.frames.shift()!;
    if (this.spawnError) throw this.spawnError;
    return new Promise<RawFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`raw daemon frame timeout after ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push({
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxFrameBytes) this.rejectWaiters(new Error('raw helper frame overflow'));
        return;
      }
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      const bytes = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.trim().length === 0) continue;
      const frame = JSON.parse(text) as RawFrame;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    }
  }

  private rejectWaiters(error: Error): void {
    while (this.waiters.length > 0) this.waiters.shift()!.reject(error);
  }
}

function descriptorArray(value: unknown): CommandDescriptor[] {
  if (!Array.isArray(value)) throw new Error('daemon capabilities omitted commandDescriptors');
  return value.map((item) => {
    const record = asRecord(item);
    return {
      name: requireString(record.name, 'descriptor.name'),
      effect: requireString(record.effect, 'descriptor.effect'),
      advertised: record.advertised === true,
      requiredInputFields: stringArray(record.requiredInputFields),
      requiresOutputPath: record.requiresOutputPath === true,
      handler: requireString(record.handler, 'descriptor.handler')
    };
  });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error('expected string array');
  return value as string[];
}

function equalSet(left: string[], right: string[], label: string): void {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size || [...a].some((value) => !b.has(value)))
    throw new Error(`${label}: ${JSON.stringify({ left, right })}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

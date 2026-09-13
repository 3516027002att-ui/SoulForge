import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeDaemonFrame,
  type BridgeDaemonFrameKind
} from '@soulforge/shared';
import {
  BRIDGE_RECOVERY_FAULT_OPTION,
  BRIDGE_RECOVERY_PHASE_CODES,
  isBridgeRecoveryHarnessFault,
  type BridgeRecoveryHarnessEvent,
  type BridgeRecoveryHarnessFault,
  type BridgeRecoveryPhase
} from './bridgeRecoveryHarnessProtocol.js';

const eventLogArgument = process.argv[2];
if (!eventLogArgument) throw new Error('Bridge recovery fixture requires an event log path.');
const eventLogPath: string = eventLogArgument;
const fixtureMode = process.argv[3];
type CancellationTerminalOutcome = 'result' | 'failed' | 'cancelled' | 'hold';
type CancellationTerminalSession = 'valid' | 'missing' | 'wrong';
const cancellationTerminals = new Map<string, CancellationTerminalOutcome>();
const cancellationTerminalSessions = new Map<string, CancellationTerminalSession>();
const cancellationTerminalDuplicates = new Map<string, boolean>();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line) as BridgeDaemonFrame<unknown>;
  handleFrame(frame);
});

function handleFrame(frame: BridgeDaemonFrame<unknown>): void {
  if (!frame.requestId) return;
  if (frame.kind === 'handshake') {
    record({ kind: 'handshake', requestId: frame.requestId });
    writeFrame('handshake', frame, {
      maxFrameBytes: readNumber(frame.payload, 'maxFrameBytes') ?? 1024 * 1024,
      maxConcurrency: readNumber(frame.payload, 'maxConcurrency') ?? 1,
      syntheticFixture: true,
      nativeFormatAuthority: false
    }, () => {
      if (fixtureMode !== 'pause-after-handshake-close'
        && fixtureMode !== 'pause-after-handshake-hold') return;
      input.pause();
      setTimeout(
        () => process.exit(29),
        fixtureMode === 'pause-after-handshake-close' ? 75 : 750
      );
    });
    return;
  }
  if (frame.kind === 'health') {
    writeFrame('health', frame, {
      processId: process.pid,
      syntheticFixture: true,
      nativeFormatAuthority: false
    });
    return;
  }
  if (frame.kind === 'cancel') {
    const targetRequestId = readString(frame.payload, 'targetRequestId');
    record({
      kind: 'cancel',
      requestId: frame.requestId,
      ...(targetRequestId ? { targetRequestId } : {})
    });
    if (targetRequestId) {
      const terminal = cancellationTerminals.get(targetRequestId) ?? 'cancelled';
      const session = cancellationTerminalSessions.get(targetRequestId) ?? 'valid';
      const duplicate = cancellationTerminalDuplicates.get(targetRequestId) ?? false;
      cancellationTerminals.delete(targetRequestId);
      cancellationTerminalSessions.delete(targetRequestId);
      cancellationTerminalDuplicates.delete(targetRequestId);
      if (fixtureMode === 'close-after-cancel' || terminal === 'hold') {
        if (fixtureMode === 'close-after-cancel') setTimeout(() => process.exit(31), 25);
        return;
      }
      const terminalRequest = makeTerminalRequestFrame(frame, targetRequestId, session);
      const writeTerminalOnce = (): void => {
        if (terminal === 'failed') {
          writeFrame('failed', terminalRequest, {
            code: 'BRIDGE_HARNESS_LATE_FAILED',
            message: 'Deterministic fixture injected a late failed terminal.',
            retryable: false,
            syntheticFixture: true,
            nativeFormatAuthority: false
          }, () => record({ kind: 'terminal', requestId: targetRequestId }));
          return;
        }
        if (terminal === 'result') {
          writeFrame('result', terminalRequest, {
            authority: 'candidate',
            nativeFormatAuthority: false,
            syntheticFixture: true,
            result: { late: true }
          }, () => record({ kind: 'terminal', requestId: targetRequestId }));
          return;
        }
        writeFrame('cancelled', terminalRequest, {
          syntheticFixture: true,
          nativeFormatAuthority: false
        }, () => record({ kind: 'terminal', requestId: targetRequestId }));
      };
      const writeTerminal = (): void => {
        writeTerminalOnce();
        if (duplicate) setTimeout(writeTerminalOnce, 5);
      };
      if (terminal === 'cancelled') writeTerminal();
      else setTimeout(writeTerminal, 25);
    }
    return;
  }
  if (frame.kind !== 'request') return;

  const fault = readFault(frame.payload);
  const cancellationTerminal = readCancellationTerminal(frame.payload);
  record({
    kind: 'request',
    requestId: frame.requestId,
    ...(fault ? { fault } : {})
  });
  if (fault === 'process-exit') {
    writeFrame('progress', frame, { phase: 'fixture-active' }, () => process.exit(23));
    return;
  }
  if (fault === 'timeout' || fault === 'cancel') {
    if (fault === 'cancel' && cancellationTerminal) {
      cancellationTerminals.set(frame.requestId, cancellationTerminal);
      cancellationTerminalSessions.set(
        frame.requestId,
        readCancellationTerminalSession(frame.payload)
      );
      cancellationTerminalDuplicates.set(
        frame.requestId,
        readCancellationTerminalDuplicate(frame.payload)
      );
    }
    writeFrame('progress', frame, { phase: 'fixture-active' });
    return;
  }
  if (fault === 'progress-terminal-race') {
    writeFrame('progress', frame, { phase: 'fixture-active' });
    writeFrame('result', frame, {
      authority: 'candidate',
      nativeFormatAuthority: false,
      syntheticFixture: true,
      result: { ok: true }
    }, () => record({ kind: 'terminal', requestId: frame.requestId!, fault }));
    return;
  }
  if (fault && isRecoveryPhase(fault)) {
    writeFrame('failed', frame, {
      code: BRIDGE_RECOVERY_PHASE_CODES[fault],
      message: `Deterministic fixture injected ${fault} failure.`,
      retryable: false,
      syntheticFixture: true,
      nativeFormatAuthority: false
    });
    return;
  }

  writeFrame('result', frame, {
    authority: 'candidate',
    nativeFormatAuthority: false,
    syntheticFixture: true,
    result: { ok: true }
  });
}

function writeFrame(
  kind: BridgeDaemonFrameKind,
  request: BridgeDaemonFrame<unknown>,
  payload: unknown,
  callback?: () => void
): void {
  if (!request.requestId) throw new Error('Fixture response requires a request id.');
  const response: BridgeDaemonFrame = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    kind,
    requestId: request.requestId,
    ...(request.workspaceSessionId ? { workspaceSessionId: request.workspaceSessionId } : {}),
    payload
  };
  process.stdout.write(`${JSON.stringify(response)}\n`, callback);
}

function readFault(payload: unknown): BridgeRecoveryHarnessFault | null {
  const options = asRecord(asRecord(payload).options);
  const value = options[BRIDGE_RECOVERY_FAULT_OPTION];
  return isBridgeRecoveryHarnessFault(value) ? value : null;
}

function readString(payload: unknown, key: string): string | null {
  const value = asRecord(payload)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(payload: unknown, key: string): number | null {
  const value = asRecord(payload)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCancellationTerminal(payload: unknown): CancellationTerminalOutcome | null {
  const options = asRecord(asRecord(payload).options);
  const value = options.cancellationTerminal;
  return value === 'result' || value === 'failed' || value === 'cancelled' || value === 'hold'
    ? value
    : null;
}

function readCancellationTerminalSession(payload: unknown): CancellationTerminalSession {
  const options = asRecord(asRecord(payload).options);
  const value = options.cancellationTerminalSession;
  return value === 'missing' || value === 'wrong' ? value : 'valid';
}

function readCancellationTerminalDuplicate(payload: unknown): boolean {
  const options = asRecord(asRecord(payload).options);
  return options.cancellationTerminalDuplicate === true;
}

function makeTerminalRequestFrame(
  cancelFrame: BridgeDaemonFrame<unknown>,
  targetRequestId: string,
  session: CancellationTerminalSession
): BridgeDaemonFrame<unknown> {
  if (session === 'wrong') {
    return { ...cancelFrame, requestId: targetRequestId, workspaceSessionId: 'wrong-session' };
  }
  if (session === 'missing') {
    const { workspaceSessionId: _workspaceSessionId, ...withoutSession } = cancelFrame;
    return { ...withoutSession, requestId: targetRequestId };
  }
  return { ...cancelFrame, requestId: targetRequestId };
}

function isRecoveryPhase(value: BridgeRecoveryHarnessFault): value is BridgeRecoveryPhase {
  return value in BRIDGE_RECOVERY_PHASE_CODES;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function record(event: BridgeRecoveryHarnessEvent): void {
  appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8');
}

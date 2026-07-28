export const BRIDGE_RECOVERY_PHASES = [
  'stage',
  'validate',
  'commit',
  're-read'
] as const;

export type BridgeRecoveryPhase = typeof BRIDGE_RECOVERY_PHASES[number];
export type BridgeRecoveryHarnessFault =
  | BridgeRecoveryPhase
  | 'timeout'
  | 'cancel'
  | 'progress-terminal-race'
  | 'process-exit';

export const BRIDGE_RECOVERY_PHASE_CODES = {
  stage: 'BRIDGE_HARNESS_STAGE_FAILED',
  validate: 'BRIDGE_HARNESS_VALIDATE_FAILED',
  commit: 'BRIDGE_HARNESS_COMMIT_FAILED',
  're-read': 'BRIDGE_HARNESS_REREAD_FAILED'
} as const satisfies Record<BridgeRecoveryPhase, string>;

export const BRIDGE_RECOVERY_FAULT_OPTION = 'recoveryHarnessFault';

export interface BridgeRecoveryHarnessEvent {
  kind: 'handshake' | 'request' | 'cancel' | 'terminal';
  requestId: string;
  fault?: BridgeRecoveryHarnessFault;
  targetRequestId?: string;
}

export function isBridgeRecoveryHarnessFault(
  value: unknown
): value is BridgeRecoveryHarnessFault {
  return value === 'timeout'
    || value === 'cancel'
    || value === 'progress-terminal-race'
    || value === 'process-exit'
    || (BRIDGE_RECOVERY_PHASES as readonly string[]).includes(String(value));
}

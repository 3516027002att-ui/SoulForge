export type DiagnosticEventStatus = 'start' | 'progress' | 'complete' | 'failed';

/** Host-facing timing/progress event; never mixed into tool stdout envelopes. */
export interface DiagnosticEvent {
  phase: string;
  status: DiagnosticEventStatus;
  elapsedMs?: number;
  details?: Record<string, unknown>;
}

export type NativeReadStatus = 'passed' | 'failed' | 'unavailable' | 'not_run';
export interface NativeReadOutcome { status: Exclude<NativeReadStatus, 'not_run'>; code: string; message: string }
export function classifyNativeRead(result: unknown): NativeReadOutcome;
export function summarizeNativeReads(rows: ReadonlyArray<{ status: NativeReadStatus; file?: string; relativePath?: string; family?: string }>): {
  ok: boolean | null;
  status: NativeReadStatus;
  counts: Record<NativeReadStatus, number>;
  skippedLegs: string[];
  skipped?: boolean;
};
export function verifyFileCoverage(inputs: readonly string[], processed: readonly string[]): {
  ok: boolean; inputCount: number; processedCount: number; inputSetSha256: string; processedSetSha256: string;
  missing: string[]; unexpected: string[]; duplicateInputs: string[]; duplicateProcessed: string[];
};

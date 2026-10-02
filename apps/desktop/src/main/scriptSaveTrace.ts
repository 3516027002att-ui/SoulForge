import { performance } from 'node:perf_hooks';

// Temporary, main-only diagnostic for the hosted precommit save observation.
// No renderer capability, resource identity, payload or error text is emitted.
const phases = new Set(['ensure-log', 'read-roots', 'native-reread', 'stage-roots',
  'candidate-staging', 'stage-native-write', 'commit-entry']);
export type ScriptSavePhase = 'ensure-log' | 'read-roots' | 'native-reread' | 'stage-roots'
  | 'candidate-staging' | 'stage-native-write' | 'commit-entry';
type PhaseState = 'start' | 'finish' | 'throw';
let requestSequence = 0;

export function createScriptSaveTrace(options: {
  enabled?: boolean;
  clock?: () => number;
  write?: (line: string) => unknown;
} = {}) {
  const enabled = options.enabled ?? process.env.SOULFORGE_EDITOR_SAVE_TRACE === '1';
  const request = enabled ? ++requestSequence : 0;
  const clock = options.clock ?? (() => performance.now());
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  function emit(phase: ScriptSavePhase, state: PhaseState, startedAt?: number): number | undefined {
    if (!enabled || !phases.has(phase) || !['start', 'finish', 'throw'].includes(state)) return undefined;
    try {
      const at = clock();
      if (!Number.isFinite(at) || at < 0) return undefined;
      const pending = write(`[SoulForge script save phase] ${JSON.stringify({ request, phase, state,
        atMs: Math.round(at * 1000) / 1000,
        ...(startedAt !== undefined ? { elapsedMs: Math.max(0, at - startedAt) } : {}) })}\n`);
      // Diagnostic sinks must not change an already-running business operation.
      void Promise.resolve(pending).catch(() => undefined);
      return at;
    } catch { return undefined; }
  }
  function begin(phase: ScriptSavePhase): (state?: 'finish' | 'throw') => void {
    const startedAt = emit(phase, 'start');
    let settled = false;
    return (state = 'finish') => {
      if (settled) return;
      settled = true;
      emit(phase, state, startedAt);
    };
  }
  return { begin,
    async run<T>(phase: ScriptSavePhase, operation: () => T | Promise<T>): Promise<T> {
      const finish = begin(phase);
      try { const result = await operation(); finish(); return result; }
      catch (error) { finish('throw'); throw error; }
    }
  };
}

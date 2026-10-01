/** Test evidence helpers: the loader log is expected, asset changes are not. */
export interface GameFileSnapshot {
  name: string;
  size: number;
  mtimeMs: number;
}

export function classifyGameDirectoryChanges(before: GameFileSnapshot[], after: GameFileSnapshot[]) {
  const previous = new Map(before.map(file => [file.name, file]));
  const next = new Map(after.map(file => [file.name, file]));
  const runtimeArtifactChanges: string[] = [];
  const unexpectedChanges: string[] = [];
  for (const name of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(name), current = next.get(name);
    const kind = !old ? 'added' : !current ? 'removed'
      : old.size !== current.size || old.mtimeMs !== current.mtimeMs ? 'changed' : undefined;
    if (!kind) continue;
    // This exact root artifact is produced by me3. Removal, malformed stat and
    // other logs remain unexpected. Never use a broad *.log allowlist.
    const expected = name.toLowerCase() === 'mod_loader_log.txt' && kind !== 'removed'
      && current && current.size >= 0 && current.mtimeMs >= 0;
    (expected ? runtimeArtifactChanges : unexpectedChanges).push(`${kind}:${name}`);
  }
  return { runtimeArtifactChanges: runtimeArtifactChanges.sort(), unexpectedChanges: unexpectedChanges.sort() };
}

export interface CleanupAttempt {
  image: string;
  pid: number;
  exitCode: number | null;
  remainingPids: number[] | null;
}

export function cleanupDiagnostic(reason: 'watchdog' | 'failure' | 'exception', attempts: CleanupAttempt[], elapsedMs: number, timeoutMs: number, observationFailures: string[] = []) {
  const timedOut = reason === 'watchdog';
  // Later successful cleanup supersedes intermediate residual observations.
  const finalByImage = new Map(attempts.map(attempt => [attempt.image, attempt.remainingPids]));
  return {
    severity: timedOut ? 'error' as const : 'warning' as const,
    code: timedOut ? 'ME3_SESSION_WATCHDOG_TIMEOUT' : reason === 'exception' ? 'ME3_SESSION_EXCEPTION_CLEANUP' : 'ME3_SESSION_FAILURE_CLEANUP',
    message: timedOut ? '会话超过总时长上限，已尝试清理观测到的残留进程。' : '会话失败，已尝试清理观测到的残留进程。',
    details: { reason, timedOut, elapsedMs, timeoutMs, attempts, observationFailures,
      residualObservationComplete: observationFailures.length === 0 && [...finalByImage.values()].every(pids => pids !== null),
      terminatedPids: attempts.filter(a => a.exitCode === 0 && a.remainingPids?.includes(a.pid) === false).map(a => a.pid),
      residualPids: [...new Set([...finalByImage.values()].flatMap(pids => pids ?? []))] }
  };
}

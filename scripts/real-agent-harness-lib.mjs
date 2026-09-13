/** Pure harness policy and injectable polling; never imports production internals. */
export const SEMANTIC_CORPUS_KINDS = Object.freeze(['param', 'msg', 'event', 'map', 'script', 'action', 'chr']);

export function planSemanticCorpus(directories) {
  const present = new Set(directories);
  const missing = SEMANTIC_CORPUS_KINDS.filter((kind) => !present.has(kind));
  return {
    scope: 'selected-resource-directories',
    fullCorpus: false,
    requestedKinds: [...SEMANTIC_CORPUS_KINDS],
    copiedKinds: SEMANTIC_CORPUS_KINDS.filter((kind) => present.has(kind)),
    missingKinds: missing,
    omittedKinds: directories.filter((kind) => !SEMANTIC_CORPUS_KINDS.includes(kind)).sort(),
    diagnostics: missing.map((kind) => ({
      severity: 'warning', code: 'CORPUS_KIND_MISSING', kind,
      message: `源 Mod 缺少 ${kind} 目录；本次隔离工作区不含该类 Mod 语料。`
    }))
  };
}

export function evaluateGoalCoverage(goals, observationOnly) {
  const required = goals.filter((goal) => goal.required);
  const fieldChecksOk = required.length > 0 && required.every((goal) => goal.verified === true);
  return {
    mode: observationOnly ? 'observation-only' : 'param-fields-only',
    requiredGoalCount: required.length,
    observedGoalCount: goals.length,
    fieldChecksOk,
    goalsOk: !observationOnly && fieldChecksOk,
    // PARAM values do not establish full natural-language task semantics (AI,
    // timed effects, drop execution or combat outcomes). No such verifier exists here.
    taskCoverageOk: false,
    taskCompletionVerified: false,
    diagnostics: [{
      severity: 'warning', code: observationOnly ? 'TASK_OBSERVATION_ONLY' : 'TASK_COVERAGE_UNVERIFIED',
      message: observationOnly
        ? '本次只观察原文任务执行和可选原生字段，不作任务通过声明。'
        : '当前验证器仅检查指定 PARAM 字段；原文任务的完整语义尚未验证。'
    }, ...(required.length === 0 ? [{
      severity: 'warning', code: 'REQUIRED_GOALS_EMPTY',
      message: '没有必需终态目标，不能将空集合判为 goalsOk。'
    }] : [])]
  };
}

export function semanticReadiness(snapshot, requiredFamilies = []) {
  const stats = snapshot?.stats;
  const data = stats?.ok === true ? stats.data : null;
  const families = data?.semanticIndex?.rag?.byFamily ?? {};
  const counts = {
    param_row: Math.max(Number(families.param_row) || 0, Number(data?.paramRows) || 0),
    text_entry: Math.max(Number(families.text_entry) || 0, Number(data?.textEntries) || 0),
    event: Math.max(Number(families.event) || 0, Number(data?.events) || 0),
    map_entity: Math.max(Number(families.map_entity) || 0, Number(data?.mapEntities) || 0),
    map_region: Math.max(Number(families.map_region) || 0, Number(data?.mapRegions) || 0),
    tae_event: Number(families.tae_event) || 0
  };
  const missingFamilies = requiredFamilies.filter((family) => !(counts[family] > 0));
  const ready = stats?.ok === true && missingFamilies.length === 0
    && Object.values(counts).some((count) => count > 0);
  return {
    status: snapshot?.analysis?.status === 'failed' ? 'failed' : ready ? 'ready' : 'warming_up',
    counts, requiredFamilies, missingFamilies,
    analysisStatus: snapshot?.analysis?.status ?? 'unknown',
    diagnostics: snapshot?.analysis?.status === 'failed'
      ? [snapshot.analysis.error ?? { code: 'WORKSPACE_ANALYSIS_FAILED', message: '工作区分析失败。' }]
      : stats?.ok === false ? [stats.error] : []
  };
}

export async function waitForSemanticReadiness({
  readSnapshot, requiredFamilies = [], timeoutMs = 60_000, intervalMs = 1_000,
  now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onProgress = () => {}
}) {
  const started = now();
  let attempts = 0;
  let last = semanticReadiness(null, requiredFamilies);
  do {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) break;
    let timer;
    try {
      const snapshot = await Promise.race([
        Promise.resolve().then(readSnapshot),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('工作区状态读取超时。'), {
            code: 'SEMANTIC_PREFLIGHT_READ_TIMEOUT'
          })), remaining);
        })
      ]);
      last = semanticReadiness(snapshot, requiredFamilies);
    } catch (error) {
      last = { ...last, diagnostics: [{ code: error?.code ?? 'SEMANTIC_PREFLIGHT_READ_FAILED', message: String(error?.message ?? error) }] };
    } finally {
      clearTimeout(timer);
    }
    attempts += 1;
    onProgress({ ...last, attempts, elapsedMs: now() - started });
    if (last.status === 'ready' || last.status === 'failed') {
      return { ...last, attempts, elapsedMs: now() - started };
    }
    const pause = Math.min(intervalMs, timeoutMs - (now() - started));
    if (pause > 0) await delay(pause);
  } while (now() - started < timeoutMs);
  return {
    ...last, status: 'timeout', attempts, elapsedMs: now() - started,
    diagnostics: [...last.diagnostics, {
      code: 'SEMANTIC_PREFLIGHT_TIMEOUT',
      message: '首批工作区语义索引未在有界等待内就绪；继续观察 Agent 时可能返回预热或 RAG_UNAVAILABLE。'
    }]
  };
}

const SUPERVISOR_SUCCESS_FINISH_REASONS = Object.freeze(new Set(['stop', 'completed']));

function normalizedPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').toLowerCase() : null;
}

function normalizedCreationTime(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/**
 * Production Agent emits taskStatus on the durable recorder, not on the live
 * turn-complete event. Keep this policy independent of that implementation
 * detail: finishReason is the lifecycle contract; taskStatus is optional
 * supporting evidence when present.
 */
export function isCancelledAgentLifecycle(lifecycle) {
  return Array.isArray(lifecycle) && lifecycle.some((entry) => (
    entry?.event?.type === 'turn-complete'
      && entry.event.finishReason === 'cancelled'
  ));
}

export function isSuccessfulAgentTerminal(terminal, durableTerminal) {
  const liveOk = terminal?.type === 'session-done'
    && SUPERVISOR_SUCCESS_FINISH_REASONS.has(terminal.finishReason);
  const durableOk = durableTerminal?.type === 'turn-complete'
    && SUPERVISOR_SUCCESS_FINISH_REASONS.has(durableTerminal.finishReason)
    && durableTerminal.taskStatus === 'completed';
  return liveOk && durableOk;
}

export function evaluateSupervisorNormalCompletion({
  report,
  terminal,
  durableTerminal,
  exitCode,
  signal,
  identityOk,
  cleanupOk,
  durableEvidenceOk,
  rollbackEvidenceOk,
  afterRollback
} = {}) {
  return identityOk === true
    && report?.ok === true
    && isSuccessfulAgentTerminal(terminal, durableTerminal)
    && exitCode === 0
    && signal === null
    && cleanupOk === true
    && durableEvidenceOk === true
    && Array.isArray(afterRollback)
    && rollbackEvidenceOk === true;
}

export function sameOwnedProcessIdentity(current, expected) {
  if (!current || !expected || Number(current.pid) !== Number(expected.pid)) return false;
  const currentCreated = normalizedCreationTime(current.creationTime);
  const expectedCreated = normalizedCreationTime(expected.creationTime);
  if (!currentCreated || !expectedCreated || currentCreated !== expectedCreated) return false;
  const currentExecutable = normalizedPath(current.executablePath);
  const expectedExecutable = normalizedPath(expected.executablePath);
  return Boolean(currentExecutable && expectedExecutable && currentExecutable === expectedExecutable);
}

export function makeSupervisorGeneration({ startedAt = new Date(), pid = 'unknown', suffix = 'manual' } = {}) {
  const value = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(value.getTime())) throw new TypeError('startedAt must be a valid date');
  const stamp = value.toISOString().replace(/[^0-9TZ]/gu, '');
  const safePid = String(pid).replace(/[^0-9A-Za-z_-]/gu, '') || 'unknown';
  const safeSuffix = String(suffix).replace(/[^0-9A-Za-z_-]/gu, '') || 'manual';
  return `${stamp}-pid${safePid}-${safeSuffix}`;
}

export function safeHarnessFileLabel(value, maxLength = 128) {
  const normalized = String(value ?? '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, maxLength);
  return normalized || 'real-agent';
}

export function isRunStopRequested({ stopping = false, globalStop = false, runStop = false } = {}) {
  return stopping === true || globalStop === true || runStop === true;
}

/**
 * Roll back committed operations in the order returned by production
 * `listOperations()` (newest first). The caller supplies that production
 * order; do not reverse or otherwise mutate it because consecutive writes to
 * one file require the newest inverse to run before older inverses.
 */
export async function rollbackCommittedOperations(operations, rollbackOperation) {
  if (!Array.isArray(operations)) throw new TypeError('operations must be an array');
  if (typeof rollbackOperation !== 'function') throw new TypeError('rollbackOperation must be a function');
  const results = [];
  for (const operation of operations) {
    const opId = operation?.opId ?? null;
    try {
      const result = await rollbackOperation(opId, operation);
      results.push({ opId, attempted: true, result });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code.trim() !== ''
        ? error.code
        : 'ROLLBACK_OPERATION_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        opId,
        attempted: true,
        result: {
          ok: false,
          diagnostics: [{ severity: 'error', code, message }]
        },
        error: { code, message }
      });
      // A thrown rollback is indeterminate. Do not issue another inverse after
      // it, because the production side may have accepted the request before
      // the caller observed the error.
      break;
    }
  }
  return results;
}

/**
 * Keep the destructive cleanup gate strict: receipts and operation statuses
 * are insufficient when the isolated tree still differs from its baseline.
 * This helper only evaluates the already-collected evidence; it does not
 * grant any additional native/write authority.
 */
export function evaluateRollbackVerification({
  operations = [],
  results = [],
  statuses,
  treeRestoredExactly = false
} = {}) {
  const committedOperations = Array.isArray(operations) ? operations : [];
  const rollbackResults = Array.isArray(results) ? results : [];
  const readStatus = (opId) => statuses instanceof Map
    ? statuses.get(opId)
    : statuses && typeof statuses === 'object'
      ? statuses[opId]
      : undefined;
  const receiptOk = committedOperations.length > 0
    && rollbackResults.length === committedOperations.length
    && rollbackResults.every((entry) => entry?.result?.ok === true);
  const operationStatusOk = committedOperations.length > 0
    && committedOperations.every((operation) => readStatus(operation?.opId) === 'rolled_back');
  const treeOk = treeRestoredExactly === true;
  return {
    receiptOk,
    operationStatusOk,
    treeRestoredExactly: treeOk,
    verified: receiptOk && operationStatusOk && treeOk
  };
}

/**
 * Scratch removal is permitted only after rollback is verified or a
 * no-committed-operation/no-change result is proven not applicable. A
 * preserved scratch directory is evidence, not a cleanup success, so callers
 * can keep the run report honest when rollback is unverified.
 */
export function decideScratchCleanup({ electronStatus, rollbackStatus } = {}) {
  const electronExited = electronStatus === 'succeeded' || electronStatus === 'not-started';
  if (!electronExited) {
    return {
      remove: false,
      status: 'preserved',
      reason: 'ELECTRON_TREE_NOT_CONFIRMED_EXITED'
    };
  }
  if ((rollbackStatus === 'verified' || rollbackStatus === 'not_applicable') && electronExited) {
    return { remove: true, status: 'remove', reason: null };
  }
  return {
    remove: false,
    status: 'preserved',
    reason: 'ROLLBACK_NOT_VERIFIED'
  };
}

/** Pure harness policy and injectable polling; never imports production internals. */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isObservationGoalTool, validateTaskContractGoals } from './real-agent-goal-contract.mjs';

export const SEMANTIC_CORPUS_KINDS = Object.freeze(['param', 'msg', 'event', 'map', 'script', 'action', 'chr']);

// A PARAM field is useful as a narrow native anchor, but it is not the same
// thing as proving a natural-language task.  Keep the distinction explicit in
// the harness so a task can only be accepted after its semantic assertions
// have produced their own evidence.
const SEMANTIC_GOAL_KINDS = new Set([
  'semantic', 'composite', 'native-tool', 'event', 'tae-field', 'script',
  'map-entity', 'map-region', 'text-entry', 'param-row', 'resource', 'unsupported'
]);

function isSemanticGoal(goal) {
  return Boolean(goal && SEMANTIC_GOAL_KINDS.has(goal.kind));
}

function nativeResultRecords(result) {
  const data = result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data
    : result;
  const record = data?.record && typeof data.record === 'object' && !Array.isArray(data.record)
    ? data.record
    : undefined;
  return [data, record, result].filter((value) => value && typeof value === 'object');
}

/**
 * Resolve native container provenance to a logical URI only when the native
 * result's container is present in the current overlay snapshot. Absolute
 * physical paths outside the supplied workspace root and unindexed relative
 * guesses are rejected rather than converted by suffix guessing.
 */
export function resolveNativeSourceUri(result, { workspaceRoot, entries = [] } = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '' || !Array.isArray(entries)) return null;
  const candidates = [];
  for (const record of nativeResultRecords(result)) {
    for (const key of ['containerPath', 'sourceUri', 'sourcePath']) {
      if (typeof record[key] === 'string' && record[key].trim() !== '') candidates.push(record[key].trim());
    }
  }
  const root = resolve(workspaceRoot);
  const indexedPaths = new Set(entries
    .filter((entry) => entry?.type === 'file' && typeof entry.path === 'string')
    .map((entry) => entry.path.replaceAll('\\', '/').replace(/^\.\//u, '').toLocaleLowerCase()));
  for (const candidate of candidates) {
    let value = candidate.replaceAll('\\', '/');
    if (/^file:\/\//iu.test(value)) value = value.slice('file://'.length);
    let relativePath;
    const driveAbsolute = /^\/?[A-Za-z]:\//u.test(value);
    if (driveAbsolute || isAbsolute(value)) {
      const absolute = resolve(value);
      if (absolute !== root && !absolute.startsWith(root + sep)) continue;
      relativePath = relative(root, absolute).replaceAll('\\', '/');
    } else {
      relativePath = value.replace(/^\.\//u, '').replace(/^\/+/, '');
    }
    relativePath = relativePath.replace(/^\/+/, '');
    if (!relativePath || relativePath.includes('\0') || relativePath.includes(':') || relativePath === '..' || relativePath.startsWith('../')) continue;
    if (!indexedPaths.has(relativePath.toLocaleLowerCase())) continue;
    return { sourceUri: `file://${relativePath}`, relativePath };
  }
  return null;
}

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

export function evaluateGoalCoverage(goals, observationOnly, taskContract = undefined) {
  const normalizedGoals = Array.isArray(goals) ? goals : [];
  const required = normalizedGoals.filter((goal) => goal?.required);
  const fieldGoals = required.filter((goal) => goal.kind === 'param-field' || goal.kind === undefined);
  const semanticGoals = required.filter(isSemanticGoal);
  const observationGoals = required.filter((goal) => (
    goal.verificationClass === 'observation' || isObservationGoalTool(goal.tool)
  ));
  const unsupportedGoals = required.filter((goal) => (
    goal.kind === 'unsupported'
      || goal.verificationStatus === 'unsupported'
      || goal.status === 'unsupported'
  ));
  const unverifiedGoals = required.filter((goal) => (
    !unsupportedGoals.includes(goal)
      && !observationGoals.includes(goal)
      && goal.verified !== true
  ));
  const allRequiredVerified = required.length > 0 && required.every((goal) => (
    goal.verified === true && !unsupportedGoals.includes(goal) && !observationGoals.includes(goal)
  ));
  const fieldChecksOk = fieldGoals.length > 0 && fieldGoals.every((goal) => goal.verified === true);
  const semanticChecksOk = semanticGoals.length > 0 && semanticGoals.every((goal) => (
    !unsupportedGoals.includes(goal)
      && !observationGoals.includes(goal)
      && goal.verified === true
      && Array.isArray(goal.verificationEvidence)
      && goal.verificationEvidence.length > 0
  ));
  const collectSourceUris = (value, output = []) => {
    if (value === null || value === undefined || typeof value !== 'object') return output;
    if (Array.isArray(value)) {
      value.slice(0, 128).forEach((item) => collectSourceUris(item, output));
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sourceUri' && typeof child === 'string') output.push(child);
      else if (key === 'sourceUris' && Array.isArray(child)) output.push(...child.filter((item) => typeof item === 'string'));
      else collectSourceUris(child, output);
    }
    return output;
  };
  // Corpus provenance may come from optional read-only probes as well as
  // required outcome goals. Optional evidence cannot satisfy the outcome gate,
  // but it can prove that the selected native source was actually inspected.
  const sourceUris = normalizedGoals.flatMap((goal) => collectSourceUris({
    verificationEvidence: goal.verificationEvidence,
    read: goal.read
  }));
  const requiredSources = taskContract?.corpusFingerprint?.requiredSources ?? [];
  const corpusMismatches = requiredSources.filter((source) => {
    const token = String(source).replaceAll('\\', '/').toLocaleLowerCase();
    return !sourceUris.some((uri) => String(uri).replaceAll('\\', '/').toLocaleLowerCase().includes(token));
  });
  const corpusMismatch = corpusMismatches.length > 0;
  const contractCheck = validateTaskContractGoals(normalizedGoals, taskContract);
  const runtimeRequired = taskContract?.requiresRuntimeEvidence === true;
  const runtimeGoals = required.filter((goal) => (
    goal.verificationClass === 'runtime' || goal.runtimeVerified === true
  ));
  const runtimeEvidenceMissing = runtimeRequired && !runtimeGoals.some((goal) => goal.verified === true);
  const taskCoverageOk = !observationOnly
    && contractCheck.ok
    && !observationGoals.length
    && !corpusMismatch
    && unsupportedGoals.length === 0
    && !runtimeEvidenceMissing
    && semanticGoals.length > 0
    && allRequiredVerified
    && semanticChecksOk;
  const status = observationOnly
    ? 'observation_only'
    : !contractCheck.ok
      ? 'contract_invalid'
    : unsupportedGoals.length > 0
      ? 'unsupported'
      : observationGoals.length > 0
        ? 'observation_only'
      : unverifiedGoals.length > 0
        ? 'unverified'
        : runtimeEvidenceMissing
          ? 'unverified'
      : corpusMismatch
          ? 'corpus_mismatch'
          : taskCoverageOk
            ? 'verified'
            : 'implementation_failed';
  return {
    mode: observationOnly
      ? 'observation-only'
      : semanticGoals.length > 0
        ? 'native-semantic'
        : 'param-fields-only',
    requiredGoalCount: required.length,
    observedGoalCount: normalizedGoals.length,
    fieldChecksOk,
    semanticChecksOk,
    // goalsOk remains the required-goal contract used by older PARAM-only
    // runs. Semantic task acceptance additionally requires taskCoverageOk.
    goalsOk: !observationOnly && contractCheck.ok && observationGoals.length === 0
      && unsupportedGoals.length === 0 && !runtimeEvidenceMissing && allRequiredVerified,
    taskCoverageOk,
    taskCompletionVerified: taskCoverageOk,
    status,
    contractGoalMissing: contractCheck.missingGoalIds,
    observationGoalIds: observationGoals.map((goal) => goal.goalId ?? null),
    unsupportedGoalIds: unsupportedGoals.map((goal) => goal.goalId ?? null),
    unverifiedGoalIds: unverifiedGoals.map((goal) => goal.goalId ?? null),
    runtimeEvidenceMissing,
    corpusMismatch,
    corpusMismatches,
    diagnostics: [
      ...(observationOnly ? [{
        severity: 'warning', code: 'TASK_OBSERVATION_ONLY',
        message: '本次只观察原文任务执行和可选原生字段，不作任务通过声明。'
      }] : []),
      ...(!observationOnly && !contractCheck.ok ? [{
        severity: 'error', code: 'CONTRACT_GOAL_MISSING',
        message: `任务契约 postconditions 缺少 required goal：${contractCheck.missingGoalIds.join(', ')}。`
      }] : []),
      ...(!observationOnly && corpusMismatch ? [{
        severity: 'error', code: 'CORPUS_MISMATCH',
        message: `清单来源与本次 native 证据不一致：${corpusMismatches.join(', ')}；这不是实现失败，必须先更新/选择正确语料。`
      }] : []),
      ...(!observationOnly && unsupportedGoals.length > 0 ? [{
        severity: 'error', code: 'REQUIRED_GOAL_UNSUPPORTED',
        message: `必需行为目标没有可执行验证器：${unsupportedGoals.map((goal) => `${goal.goalId ?? 'unknown'}（${goal.unsupportedReason ?? '未说明原因'}）`).join('；')}。不能以局部字段或静态字符串代替。`
      }] : []),
      ...(!observationOnly && observationGoals.length > 0 ? [{
        severity: 'error', code: 'REQUIRED_GOAL_OBSERVATION_ONLY',
        message: `必需目标只能提供发现/静态观察，不能作为 semantic completion：${observationGoals.map((goal) => goal.goalId ?? 'unknown').join(', ')}。`
      }] : []),
      ...(!observationOnly && runtimeEvidenceMissing ? [{
        severity: 'error', code: 'RUNTIME_EVIDENCE_REQUIRED',
        message: '当前任务契约要求运行时证据；native read/static evidence 不能自动代表游戏行为。'
      }] : []),
      ...(!observationOnly && !corpusMismatch && unsupportedGoals.length === 0 && semanticGoals.length === 0 ? [{
        severity: 'warning', code: 'TASK_COVERAGE_UNVERIFIED',
        message: '当前验证器仅检查指定 PARAM 字段；原文任务的完整语义尚未验证。'
      }] : []),
      ...(!observationOnly && !corpusMismatch && unsupportedGoals.length === 0 && semanticGoals.length > 0 && !taskCoverageOk ? [{
        severity: 'error', code: 'TASK_SEMANTIC_GOAL_FAILED',
        message: '至少一个语义目标未产生完整的原生验证证据，不能宣称整题通过。'
      }] : []),
      ...(!observationOnly && unsupportedGoals.length === 0 && unverifiedGoals.length > 0 ? [{
        severity: 'error', code: 'REQUIRED_GOAL_UNVERIFIED',
        message: `必需目标未验证：${unverifiedGoals.map((goal) => goal.goalId ?? 'unknown').join(', ')}。`
      }] : []),
      ...(required.length === 0 ? [{
      severity: 'warning', code: 'REQUIRED_GOALS_EMPTY',
      message: '没有必需终态目标，不能将空集合判为 goalsOk。'
      }] : [])
    ]
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

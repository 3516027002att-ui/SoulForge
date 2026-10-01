/** Pure harness policy and injectable polling; never imports production internals. */
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isObservationGoalTool, validateTaskContractGoals } from './real-agent-goal-contract.mjs';

export const SEMANTIC_CORPUS_KINDS = Object.freeze(['param', 'msg', 'event', 'map', 'script', 'action', 'chr']);
const MAX_ELECTRON_OLD_SPACE_MIB = 16_384;

export function classifyStopTelemetry({
  diagnostics,
  stopFileRequested = false,
  stopFileConfigured = false,
  errorCode = null
} = {}) {
  const events = Array.isArray(diagnostics?.events) ? diagnostics.events : [];
  const pageClose = events.find((event) => event.type === 'page-close') ?? null;
  const rendererCrash = events.find((event) => event.type === 'renderer-crash') ?? null;
  const processExit = events.find((event) => event.type === 'process-exit') ?? null;
  const output = `${diagnostics?.stderrTail ?? ''}\n${diagnostics?.stdoutTail ?? ''}`;
  const v8Oom = /(?:OOM error in V8|Allocation failed - JavaScript heap out of memory|FATAL ERROR:\s*Reached heap limit)/iu.test(output);
  let classification = 'none';
  let reason = null;
  if (stopFileRequested) {
    classification = 'operator';
    reason = 'stop-file';
  } else if (v8Oom) {
    classification = 'internal';
    reason = 'v8-oom';
  } else if (rendererCrash) {
    classification = 'internal';
    reason = 'renderer-crash';
  } else if (pageClose) {
    // A page close alone does not identify an operator action. Preserve the
    // observed fact, but leave the cause unknown unless stronger evidence exists.
    classification = 'unknown';
    reason = 'window-close';
  } else if (processExit) {
    classification = 'internal';
    reason = 'process-exit';
  } else if (errorCode) {
    classification = 'internal';
    reason = 'harness-error';
  }
  return {
    classification,
    reason,
    stopFileConfigured: stopFileConfigured === true,
    stopFileRequested: stopFileRequested === true,
    pageClose: pageClose ? { at: pageClose.at } : null,
    rendererCrash: rendererCrash ? { at: rendererCrash.at } : null,
    processExit: processExit
      ? { at: processExit.at, code: processExit.code, signal: processExit.signal }
      : null,
    v8Oom
  };
}

export function createAgentElectronLaunchArgs({ runtime, productionMain, userDataDir, maxOldSpaceMb }) {
  if (!Number.isSafeInteger(maxOldSpaceMb) || maxOldSpaceMb < 2048 || maxOldSpaceMb > MAX_ELECTRON_OLD_SPACE_MIB) {
    throw new RangeError(`Electron old-space budget must be an integer from 2048 to ${MAX_ELECTRON_OLD_SPACE_MIB} MiB.`);
  }
  if (runtime !== 'unpacked' && runtime !== 'installed') {
    throw new TypeError('Electron runtime must be unpacked or installed.');
  }
  return [
    `--js-flags=--max-old-space-size=${maxOldSpaceMb}`,
    ...(runtime === 'unpacked' ? [productionMain] : []),
    `--user-data-dir=${userDataDir}`
  ];
}

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
export function resolveNativeSourceUri(result, { workspaceRoot, entries = [], sourceHint } = {}) {
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
  // Some native PARAM readers return only the physical child basename even
  // when the caller selected an explicit workspace-relative containerPath.
  // Bind that result only if the hint itself is indexed and its basename is
  // unique in the current snapshot; never suffix-guess an ambiguous source.
  if (typeof sourceHint === 'string' && sourceHint.trim() !== '') {
    const hinted = resolveNativeSourceUri({ data: { containerPath: sourceHint } }, { workspaceRoot, entries });
    if (!hinted) return null;
    const hintBasename = basename(hinted.relativePath).toLocaleLowerCase();
    const hasBareName = candidates.some((candidate) => {
      let value = candidate.replaceAll('\\', '/');
      if (/^file:\/\//iu.test(value)) value = value.slice('file://'.length);
      return value.split('/').length === 1 && value.toLocaleLowerCase() === hintBasename;
    });
    if (!hasBareName) return null;
    const matchingPaths = [...indexedPaths].filter((path) => basename(path).toLocaleLowerCase() === hintBasename);
    if (matchingPaths.length !== 1 || matchingPaths[0] !== hinted.relativePath.toLocaleLowerCase()) return null;
    return hinted;
  }
  return null;
}

/** Bind native provenance only through the current indexed overlay snapshot or an explicit unique source hint. */
export function enrichNativeSourceFacts(result, facts, { workspaceRoot, entries = [], sourceHint } = {}) {
  const resolved = resolveNativeSourceUri(result, { workspaceRoot, entries, sourceHint });
  const uris = Array.isArray(facts?.uris) ? [...facts.uris] : [];
  if (resolved && !uris.includes(resolved.sourceUri)) uris.push(resolved.sourceUri);
  return { ...(facts && typeof facts === 'object' ? facts : {}), uris };
}

/** Safe, path-free diagnostics for why a native container could not be bound. */
export function diagnoseNativeSourceUriResolution(result, { workspaceRoot, entries = [], requiredSources = [], sourceHint } = {}) {
  const rootProvided = typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '';
  const root = rootProvided ? resolve(workspaceRoot) : '';
  const indexedPaths = new Set(entries
    .filter((entry) => entry?.type === 'file' && typeof entry.path === 'string')
    .map((entry) => entry.path.replaceAll('\\', '/').replace(/^\.\//u, '').toLocaleLowerCase()));
  const candidates = [];
  const relativeCandidates = [];
  for (const record of nativeResultRecords(result)) {
    for (const key of ['containerPath', 'sourceUri', 'sourcePath']) {
      const candidate = record[key];
      if (typeof candidate !== 'string' || candidate.trim() === '') continue;
      let value = candidate.trim().replaceAll('\\', '/');
      if (/^file:\/\//iu.test(value)) value = value.slice('file://'.length);
      const absolute = /^\/?[A-Za-z]:\//u.test(value) || isAbsolute(value);
      let relativePath;
      if (absolute) {
        const resolved = resolve(value);
        if (!rootProvided || (resolved !== root && !resolved.startsWith(root + sep))) {
          candidates.push('absolute-outside-workspace');
          continue;
        }
        relativePath = relative(root, resolved).replaceAll('\\', '/');
      } else {
        relativePath = value.replace(/^\.\//u, '').replace(/^\/+/, '');
      }
      relativePath = relativePath.replace(/^\/+/, '');
      if (!relativePath || relativePath.includes('\0') || relativePath.includes(':')
        || relativePath === '..' || relativePath.startsWith('../')) {
        candidates.push('invalid-relative-path');
      } else {
        relativeCandidates.push(relativePath);
        candidates.push(indexedPaths.has(relativePath.toLocaleLowerCase())
          ? 'indexed-relative-path'
          : 'unindexed-relative-path');
      }
    }
  }
  const normalizedRequiredSources = requiredSources.map((source) => (
    String(source).replaceAll('\\', '/').replace(/^file:\/\//iu, '').replace(/^\/+/, '').toLocaleLowerCase()
  ));
  return {
    bound: resolveNativeSourceUri(result, { workspaceRoot, entries, sourceHint }) !== null,
    rootProvided,
    indexedFileCount: indexedPaths.size,
    candidateCount: candidates.length,
    candidateStatuses: [...new Set(candidates)],
    relativeCandidates: [...new Set(relativeCandidates)],
    candidateMatchesRequiredSource: relativeCandidates.map((candidate) => (
      normalizedRequiredSources.some((source) => source === candidate.toLocaleLowerCase())
    )),
    candidateComparisons: relativeCandidates.map((candidate) => {
      const normalized = candidate.toLocaleLowerCase();
      const basename = normalized.split('/').at(-1);
      return {
        segmentCount: normalized.split('/').length,
        basenameMatchesRequired: normalizedRequiredSources.some((source) => source.split('/').at(-1) === basename),
        suffixMatchesRequired: normalizedRequiredSources.some((source) => normalized === source || normalized.endsWith(`/${source}`))
      };
    }),
    requiredSourcesIndexed: requiredSources.map((source) => indexedPaths.has(
      String(source).replaceAll('\\', '/').replace(/^file:\/\//iu, '').replace(/^\/+/, '').toLocaleLowerCase()
    ))
  };
}

export function planSemanticCorpus(directories, requestedKinds = SEMANTIC_CORPUS_KINDS) {
  if (!Array.isArray(requestedKinds)
    || requestedKinds.some((kind) => !SEMANTIC_CORPUS_KINDS.includes(kind))) {
    throw new TypeError('Requested semantic corpus kinds must be selected from the known resource directories.');
  }
  const requested = [...new Set(requestedKinds)];
  const requestedSet = new Set(requested);
  const present = new Set(directories);
  const missing = requested.filter((kind) => !present.has(kind));
  return {
    scope: 'selected-resource-directories',
    fullCorpus: false,
    requestedKinds: requested,
    copiedKinds: requested.filter((kind) => present.has(kind)),
    missingKinds: missing,
    excludedKinds: [...present].filter((kind) => SEMANTIC_CORPUS_KINDS.includes(kind) && !requestedSet.has(kind)).sort(),
    omittedKinds: directories.filter((kind) => !SEMANTIC_CORPUS_KINDS.includes(kind)).sort(),
    diagnostics: missing.map((kind) => ({
      severity: 'warning', code: 'CORPUS_KIND_MISSING', kind,
      message: `源 Mod 缺少 ${kind} 目录；本次隔离工作区不含该类 Mod 语料。`
    }))
  };
}

/**
 * Execution admission follows mode/contract intent. Independent effect
 * verification is a final verdict; domain tools still own actual write guards.
 */
export function evaluateWriteAdmission(goals, { observationOnly = false, candidateWrite = false, taskContract } = {}) {
  observationOnly = observationOnly || taskContract?.intent === 'read';
  const requiredUnsupported = (Array.isArray(goals) ? goals : []).filter((goal) => (
    goal?.required === true
      && (goal.kind === 'unsupported'
        || goal.verificationStatus === 'unsupported'
        || goal.status === 'unsupported')
  ));
  const unsupportedGoalIds = requiredUnsupported.map((goal) => goal.goalId ?? null);
  if (observationOnly && candidateWrite) {
    return {
      allowed: false,
      executionMode: 'invalid',
      code: 'REAL_AGENT_MODE_INVALID',
      unsupportedGoalIds,
      message: '--observe 与 --candidate-write 不能同时使用。'
    };
  }
  if (observationOnly) {
    return { allowed: true, executionMode: 'observation-only', unsupportedGoalIds };
  }
  return {
    allowed: true,
    executionMode: candidateWrite ? 'candidate-experiment' : 'write',
    unsupportedGoalIds
  };
}

/** Classify an independently observed native postcondition, not a model receipt. */
export function evaluateNativeGoalOutcome({
  nativeReadOk, assertionOk, proofOk, resourceChanged = false,
  requireMutation = false, unavailable = false, mutationEvidenceAvailable = true
}) {
  if (unavailable) return { verified: false, status: 'unverified', reason: 'verification-unavailable' };
  if (!nativeReadOk) return { verified: false, status: 'failed', reason: 'native-read-failed' };
  if (!assertionOk) return { verified: false, status: 'failed', reason: 'postcondition-failed' };
  if (requireMutation && !mutationEvidenceAvailable) return { verified: false, status: 'unverified', reason: 'mutation-evidence-unavailable' };
  if (requireMutation && !resourceChanged) return { verified: false, status: 'failed', reason: 'required-mutation-missing' };
  if (!proofOk) return { verified: false, status: 'unverified', reason: 'source-proof-missing' };
  return { verified: true, status: 'verified', reason: 'postcondition-verified' };
}

/** Task outcome is independent of the model's terminal and of cleanup policy. */
export function evaluateTaskOutcome({ taskContract, goalCoverage, lifecycleOk, durableEvidenceOk,
  runtimeOk, writeMode, executionMode, committedOperationOk, writeObserved,
  rollbackStatus, treeRestoredExactly }) {
  const intent = taskContract?.intent ?? 'modify';
  if (executionMode === 'candidate-experiment') return {passed:false,status:'unverified',reason:'candidate-experiment'};
  if (intent === 'read' && (committedOperationOk || writeObserved)) return {passed:false,status:'failed',reason:'read-task-mutated'};
  if (!lifecycleOk || !runtimeOk) return {passed:false,status:'failed',reason:'execution-failed'};
  if (goalCoverage?.status === 'failed') return {passed:false,status:'failed',reason:'postcondition-failed'};
  if (!goalCoverage?.taskCompletionVerified || !durableEvidenceOk) return {passed:false,status:'unverified',reason:'evidence-incomplete'};
  if (intent === 'modify' && (!writeMode || !committedOperationOk || !writeObserved)) return {passed:false,status:'failed',reason:'required-mutation-missing'};
  // Actual mutations must always be restored in the harness. Read/ensure runs
  // with no mutations need only prove that the isolated tree is unchanged.
  if (!treeRestoredExactly || (writeObserved && rollbackStatus !== 'verified')
    || (intent === 'restore' && rollbackStatus !== 'verified')) {
    return {passed:false,status:'failed',reason:'restoration-failed'};
  }
  return {passed:true,status:'passed',reason:'applicable-postconditions-verified'};
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
  const failedGoals = required.filter((goal) => (
    !unsupportedGoals.includes(goal) && !observationGoals.includes(goal) && goal.status === 'failed'
  ));
  const unverifiedGoals = required.filter((goal) => (
    !unsupportedGoals.includes(goal)
      && !observationGoals.includes(goal)
      && !failedGoals.includes(goal)
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
  const collectSourceHashes = (value, output = []) => {
    if (value === null || value === undefined || typeof value !== 'object') return output;
    if (Array.isArray(value)) {
      value.slice(0, 128).forEach((item) => collectSourceHashes(item, output));
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sourceHash' && typeof child === 'string') output.push(child);
      else if (key === 'sourceHashes' && Array.isArray(child)) output.push(...child.filter((item) => typeof item === 'string'));
      else collectSourceHashes(child, output);
    }
    return output;
  };
  // Corpus provenance may come from optional read-only probes as well as
  // required outcome goals. Optional evidence cannot satisfy the outcome gate,
  // but it can prove that the selected native source was actually inspected.
  // Keep each evidence record intact so the source URI and its hash must come
  // from the same native read instead of unrelated goals satisfying each other.
  const sourceProofs = normalizedGoals.flatMap((goal) => {
    const evidenceRecords = [
      ...(Array.isArray(goal.verificationEvidence) ? goal.verificationEvidence : []),
      goal.read
    ].filter((value) => value && typeof value === 'object');
    return evidenceRecords.flatMap((evidence) => {
      const sourceHashes = collectSourceHashes(evidence).filter((hash) => hash.trim() !== '');
      return collectSourceUris(evidence).map((sourceUri) => ({ sourceUri, hasNativeHash: sourceHashes.length > 0 }));
    });
  });
  const normalizeSourcePath = (value) => {
    let normalized = String(value ?? '').trim().replaceAll('\\', '/').toLocaleLowerCase();
    if (normalized.startsWith('file://')) normalized = normalized.slice('file://'.length);
    return normalized.split('#', 1)[0].replace(/^\.\/+/, '').replace(/^\/+/, '');
  };
  const requiredSources = taskContract?.corpusFingerprint?.requiredSources ?? [];
  const requireNativeSourceHash = taskContract?.corpusFingerprint?.requireNativeSourceHash !== false;
  const corpusMismatches = requiredSources.filter((source) => {
    const expectedPath = normalizeSourcePath(source);
    return !sourceProofs.some((proof) => (
      normalizeSourcePath(proof.sourceUri) === expectedPath
      && (!requireNativeSourceHash || proof.hasNativeHash)
    ));
  });
  const corpusMismatch = corpusMismatches.length > 0;
  const contractCheck = validateTaskContractGoals(normalizedGoals, taskContract);
  const runtimeRequired = taskContract?.requiresRuntimeEvidence === true;
  const runtimeGoals = required.filter((goal) => (
    goal.verificationClass === 'runtime' || goal.runtimeVerified === true
  ));
  const runtimeEvidenceMissing = runtimeRequired && !runtimeGoals.some((goal) => goal.verified === true);
  // A declared read-only outcome can be verified while writes are disabled.
  // Legacy observation experiments still cannot mint task completion.
  const canVerifyTask = !observationOnly || taskContract?.intent === 'read';
  const declaredOutcomes = Array.isArray(taskContract?.postconditions) && taskContract.postconditions.length > 0;
  const taskCoverageOk = canVerifyTask
    && contractCheck.ok
    && !observationGoals.length
    && !corpusMismatch
    && unsupportedGoals.length === 0
    && !runtimeEvidenceMissing
    && (semanticGoals.length > 0 || declaredOutcomes)
    && allRequiredVerified
    && (semanticGoals.length === 0 || semanticChecksOk);
  const status = !canVerifyTask
    ? 'observation_only'
    : !contractCheck.ok
      ? 'contract_invalid'
    : unsupportedGoals.length > 0
      ? 'unsupported'
      : observationGoals.length > 0
        ? 'observation_only'
      : failedGoals.length > 0
        ? 'failed'
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
    goalsOk: canVerifyTask && contractCheck.ok && observationGoals.length === 0
      && unsupportedGoals.length === 0 && !runtimeEvidenceMissing && allRequiredVerified,
    taskCoverageOk,
    taskCompletionVerified: taskCoverageOk,
    status,
    contractGoalMissing: contractCheck.missingGoalIds,
    observationGoalIds: observationGoals.map((goal) => goal.goalId ?? null),
    unsupportedGoalIds: unsupportedGoals.map((goal) => goal.goalId ?? null),
    failedGoalIds: failedGoals.map((goal) => goal.goalId ?? null),
    unverifiedGoalIds: unverifiedGoals.map((goal) => goal.goalId ?? null),
    runtimeEvidenceMissing,
    corpusMismatch,
    corpusMismatches,
    diagnostics: [
      ...(!canVerifyTask ? [{
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
      ...(canVerifyTask && !declaredOutcomes && !corpusMismatch && unsupportedGoals.length === 0 && semanticGoals.length === 0 ? [{
        severity: 'warning', code: 'TASK_COVERAGE_UNVERIFIED',
        message: '当前验证器仅检查指定 PARAM 字段；原文任务的完整语义尚未验证。'
      }] : []),
      ...(canVerifyTask && failedGoals.length > 0 ? [{
        severity: 'error', code: 'REQUIRED_GOAL_FAILED',
        message: `必需目标实际断言失败：${failedGoals.map((goal) => goal.goalId ?? 'unknown').join(', ')}。`
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

/** Keep task-level unsupported obligations visible when execution aborts early. */
export function classifyInterruptedGoalCoverage(goals, observationOnly, taskContract = undefined) {
  const goalCoverage = evaluateGoalCoverage(goals, observationOnly, taskContract);
  return {
    goalCoverage,
    status: goalCoverage.status,
    verificationMode: goalCoverage.mode,
    taskCompletionVerified: false,
    unsupportedGoalIds: goalCoverage.unsupportedGoalIds,
    unverifiedGoalIds: goalCoverage.unverifiedGoalIds
  };
}

/** Preserve durable rollout completion evidence even if Electron closed before the IPC terminal reached the harness. */
export function buildFailureSessionEvidence({
  terminalEvidence,
  durableRollout,
  evidenceHasEntries = false
} = {}) {
  if (!terminalEvidence && !durableRollout && evidenceHasEntries !== true) return null;
  return {
    ...(terminalEvidence ?? {}),
    terminal: terminalEvidence?.terminal ?? null,
    terminalObserved: terminalEvidence?.terminal != null,
    durableRollout: durableRollout ?? null,
    evidenceHasEntries: evidenceHasEntries === true
  };
}

export function semanticReadiness(snapshot, requiredFamilies = [], { requireAnalysisComplete = false } = {}) {
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
  const analysisComplete = snapshot?.analysis?.status === 'completed';
  const ready = stats?.ok === true && missingFamilies.length === 0
    && Object.values(counts).some((count) => count > 0)
    && (!requireAnalysisComplete || analysisComplete);
  return {
    status: snapshot?.analysis?.status === 'failed' ? 'failed' : ready ? 'ready' : 'warming_up',
    counts, requiredFamilies, missingFamilies,
    analysisStatus: snapshot?.analysis?.status ?? 'unknown',
    diagnostics: snapshot?.analysis?.status === 'failed'
      ? [snapshot.analysis.error ?? { code: 'WORKSPACE_ANALYSIS_FAILED', message: '工作区分析失败。' }]
      : stats?.ok === false ? [stats.error]
        : requireAnalysisComplete && !analysisComplete ? [{
            severity: 'info', code: 'WORKSPACE_ANALYSIS_RUNNING',
            message: '等待工作区全量语义分析完成，避免 Agent 查询与后台 RAG 构建竞争。'
          }] : []
  };
}

export async function waitForSemanticReadiness({
  readSnapshot, requiredFamilies = [], timeoutMs = 60_000, intervalMs = 1_000,
  requireAnalysisComplete = false,
  now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onProgress = () => {}
}) {
  const started = now();
  let attempts = 0;
  let last = semanticReadiness(null, requiredFamilies, { requireAnalysisComplete });
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
      last = semanticReadiness(snapshot, requiredFamilies, { requireAnalysisComplete });
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
      message: requireAnalysisComplete
        ? '工作区全量语义分析未在有界等待内完成；Agent 未启动，以避免与后台 RAG 构建竞争。'
        : '首批工作区语义索引未在有界等待内就绪；继续观察 Agent 时可能返回预热或 RAG_UNAVAILABLE。'
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

/** Discover commits that were durable even when the Electron window died before final bookkeeping. */
export function selectNewCommittedOperations(operationsAfter, operationsBefore = []) {
  const beforeIds = new Set((Array.isArray(operationsBefore) ? operationsBefore : [])
    .map((operation) => operation?.opId)
    .filter((opId) => typeof opId === 'string' && opId.trim() !== ''));
  return (Array.isArray(operationsAfter) ? operationsAfter : []).filter((operation) => (
    operation?.status === 'committed'
      && typeof operation.opId === 'string'
      && operation.opId.trim() !== ''
      && !beforeIds.has(operation.opId)
  ));
}

/**
 * A failed renderer rollback may still have committed an inverse before the
 * IPC reply was lost. Once the owned Electron tree has exited, retry through
 * the isolated CLI whenever the write run has evidence that a mutation or
 * rollback was in flight.
 */
export function shouldRecoverUnverifiedWriteRollback({
  phase,
  writeMode = false,
  rollbackStatus,
  electronStatus,
  treeBefore,
  treeAfterRun,
  operationsAfterRun,
  newCommittedOperations = [],
  rollbackResults = []
} = {}) {
  const postAgentPhase = new Set([
    'run-agent',
    'agent-terminal',
    'verify-native-goals',
    'copy-durable-evidence',
    'rollback'
  ]).has(phase);
  const electronExited = electronStatus === 'succeeded' || electronStatus === 'not-started';
  if (!postAgentPhase || !writeMode || rollbackStatus !== 'unverified' || !electronExited || !treeBefore) return false;
  const attemptedRollback = Array.isArray(rollbackResults)
    && rollbackResults.some((result) => result?.attempted === true || result?.error != null);
  const observedTreeMutation = treeAfterRun?.sha256 != null && treeAfterRun.sha256 !== treeBefore.sha256;
  const interruptedBeforeOperationRead = operationsAfterRun == null && phase !== 'rollback';
  return (Array.isArray(newCommittedOperations) && newCommittedOperations.length > 0)
    || attemptedRollback
    || observedTreeMutation
    || interruptedBeforeOperationRead;
}

/** Return new operations in production history order, separating durable inverses from pending commits. */
export function planRollbackRecoveryOperations(operationsAfter, operationsBefore = []) {
  const beforeIds = new Set((Array.isArray(operationsBefore) ? operationsBefore : [])
    .map((operation) => operation?.opId)
    .filter((opId) => typeof opId === 'string' && opId.trim() !== ''));
  const newOperations = (Array.isArray(operationsAfter) ? operationsAfter : []).filter((operation) => (
    typeof operation?.opId === 'string'
      && operation.opId.trim() !== ''
      && !beforeIds.has(operation.opId)
  ));
  return {
    newOperations,
    pendingRollbackOperations: newOperations.filter((operation) => operation.status === 'committed'),
    alreadyRolledBackOperations: newOperations.filter((operation) => operation.status === 'rolled_back'),
    unresolvedOperations: newOperations.filter((operation) => !['committed', 'rolled_back'].includes(operation.status))
  };
}

/** Mirror the desktop history projection: an inverse commit marks its source operation rolled back. */
export function normalizeOperationHistoryForVerification(operations) {
  const records = Array.isArray(operations) ? operations : [];
  const reversedIds = new Set(records
    .filter((operation) => operation?.status === 'committed' && typeof operation.inverseOfOpId === 'string')
    .map((operation) => operation.inverseOfOpId));
  return records
    .filter((operation) => !operation?.inverseOfOpId && !operation?.rollbackScope)
    .map((operation) => reversedIds.has(operation.opId)
      ? { ...operation, status: 'rolled_back' }
      : operation);
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

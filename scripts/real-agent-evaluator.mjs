/** Independent postcondition evaluation. The reader must inspect the isolated resource,
 * not a model tool receipt. Assertions run before report compaction. */
import { evaluateNativeGoalOutcome, enrichNativeSourceFacts, diagnoseNativeSourceUriResolution, resolveNativeSourceUri } from './real-agent-harness-lib.mjs';
import { isObservationGoalTool, matchesAssertion, readAssertionPath } from './real-agent-goal-contract.mjs';

function isVerificationUnavailable(result) {
  return /(?:UNAVAILABLE|NOT_CONFIGURED|UNSUPPORTED|RUNTIME_NOT_FOUND|CORPUS_MISSING|VERIFICATION_UNAVAILABLE)/u.test(String(result?.error?.code ?? ''));
}

function sameValue(observed, expected) {
  if (typeof expected === 'number' && typeof observed === 'string' && observed.trim() !== '') {
    return /^-?(?:0|[1-9]\d*)$/u.test(observed.trim())
      && Number.isSafeInteger(Number(observed))
      && Number(observed) === expected;
  }
  if (typeof expected === 'boolean' && typeof observed === 'number') return Boolean(observed) === expected;
  return Object.is(observed, expected);
}

function collectNativeSourceFacts(value, facts = { hashes: [], revisions: [], uris: [] }, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return facts;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) collectNativeSourceFacts(item, facts, depth + 1);
    return facts;
  }
  if (typeof value !== 'object') return facts;
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLocaleLowerCase();
    if (typeof child === 'string' && lower === 'sourcehash' && child.length > 0) facts.hashes.push(child);
    if ((lower === 'sourcerevision' || lower === 'revision')
      && (typeof child === 'number' || typeof child === 'string')) facts.revisions.push(child);
    if (typeof child === 'string' && lower === 'sourceuri' && child.length > 0) facts.uris.push(child);
    collectNativeSourceFacts(child, facts, depth + 1);
  }
  return facts;
}

function compactNativeToolResult(value, depth = 0) {
  if (depth > 4) return '[depth-limited]';
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => compactNativeToolResult(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    // Complete Lua source and DarkScript are used for the in-process
    // assertion, but must not be copied into a rollout/report.
    if (key === 'sourceText' || key === 'darkScript' || key === 'argsBase64' || key === 'contentBase64') continue;
    output[key] = compactNativeToolResult(child, depth + 1);
  }
  return output;
}

async function runReadOnlyGoalTool(readTool, goal) {
  const result = await readTool(goal.tool, goal.input);
  return {
    tool: goal.tool,
    input: goal.input,
    result,
    compactResult: compactNativeToolResult(result)
  };
}

function evaluateParamGoal(goal, result, treeEvidence = undefined) {
  const resultData = result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data
    : null;
  const fields = result?.ok && Array.isArray(resultData?.fields)
    ? resultData.fields
    : result?.ok && Array.isArray(resultData?.record?.fields)
      ? resultData.record.fields
      : [];
  const matches = fields.filter((candidate) => (
    Number(candidate?.rowId) === goal.rowId
    && String(candidate?.fieldId ?? '').toLocaleLowerCase() === goal.fieldId.toLocaleLowerCase()
  ));
  // rowId is logical, while entryIndex/rowIndex identify distinct native rows.
  // This goal contract does not select a physical row; neither the first value
  // nor a partial page can establish that its target is unique.
  const incomplete = [resultData, resultData?.record].some((data) => {
    const pagination = data?.pagination;
    return pagination?.hasMore === true
      || (typeof pagination?.nextCursor === 'string' && pagination.nextCursor.trim().length > 0)
      || (Number.isSafeInteger(pagination?.offset) && pagination.offset > 0)
      || (Number.isSafeInteger(pagination?.totalCount) && pagination.totalCount > fields.length)
      || data?.evidence?.complete === false || data?.evidence?.status === 'partial'
      || data?.scan?.status === 'partial' || data?.execution?.status === 'partial' || data?.page?.status === 'partial';
  });
  const identityIssue = result?.ok === true && matches.length > 1 ? {
    reason: 'param-identity-ambiguous', code: 'PARAM_GOAL_IDENTITY_AMBIGUOUS',
    message: `Goal ${goal.goalId} matches ${matches.length} native PARAM fields. Its logical rowId/fieldId does not select a unique entry/physical row.`
  } : result?.ok === true && incomplete ? {
    reason: 'param-identity-incomplete', code: 'PARAM_GOAL_IDENTITY_INCOMPLETE',
    message: `Goal ${goal.goalId} has an incomplete native PARAM field window. A unique logical rowId/fieldId target was not established.`
  } : null;
  const field = identityIssue === null && matches.length === 1 ? matches[0] : undefined;
  const sourceHashPresent = typeof field?.sourceHash === 'string' && field.sourceHash.length > 0;
  const sourceIdentity = resolveNativeSourceUri(result, {
    workspaceRoot: treeEvidence?.root,
    entries: [
      ...(treeEvidence?.before?.entries ?? []),
      ...(treeEvidence?.after?.entries ?? [])
    ]
  });
  const sourceUriPresent = sourceIdentity !== null;
  const valueMatches = Boolean(result?.ok === true && field && sameValue(field.value, goal.expectedValue));
  const outcome = identityIssue ? { verified: false, status: 'unverified', reason: identityIssue.reason }
    : evaluateNativeGoalOutcome({ nativeReadOk: result?.ok === true, assertionOk:valueMatches,
    proofOk:sourceHashPresent && sourceUriPresent, resourceChanged:goalChangedInOverlay(goal, treeEvidence),
    requireMutation:goal.requireMutation === true, unavailable:isVerificationUnavailable(result), mutationEvidenceAvailable:goalMutationEvidenceBound(goal, treeEvidence) });
  return {
    ...goal,
    nativeReadOk: result?.ok === true,
    observedValue: field?.value ?? null,
    sourceHashPresent,
    sourceRevisionPresent: field?.sourceRevision !== undefined && field?.sourceRevision !== null,
    sourceUriPresent,
    ...outcome,
    verificationEvidence: result?.ok === true && sourceHashPresent
      ? [{
          tool: 'read_param_fields',
          sourceHashes: [field.sourceHash],
          sourceRevisions: field.sourceRevision === undefined ? [] : [field.sourceRevision],
          sourceUris: sourceIdentity ? [sourceIdentity.sourceUri] : []
        }]
      : [],
    diagnostics: identityIssue
      ? [{ severity: 'error', code: identityIssue.code, message: identityIssue.message, matchingFields: matches.length }]
      : result?.ok === false
      ? result?.error ?? null
      : sourceUriPresent ? null : [{
          severity: 'error',
          code: 'NATIVE_SOURCE_URI_UNBOUND',
          message: `目标 ${goal.goalId} 的 native containerPath 未能绑定到当前 overlay 工作区，不能作为 corpus 证据。`
        }],
    read: compactNativeToolResult(result ?? null)
  };
}

function goalMutationEvidenceBound(goal, treeEvidence) {
  return typeof goal.changedPath === 'string' && goal.changedPath.trim().length > 0
    && !goal.changedPath.startsWith('/') && !goal.changedPath.split(/[\\/]/u).includes('..')
    && Array.isArray(treeEvidence?.before?.entries) && Array.isArray(treeEvidence?.after?.entries)
    && treeEvidence.after.entries.some(entry => entry.path === goal.changedPath && entry.type === 'file' && typeof entry.sha256 === 'string' && entry.sha256.length > 0);
}

function goalChangedInOverlay(goal, treeEvidence) {
  if (!goalMutationEvidenceBound(goal, treeEvidence)) return false;
  const before = treeEvidence.before.entries.find((entry) => entry.path === goal.changedPath);
  const after = treeEvidence.after.entries.find((entry) => entry.path === goal.changedPath);
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

async function verifyGoalThroughNativeTool(readTool, goal, paramReads = new Map(), treeEvidence = undefined, taskContract = undefined) {
  if (goal.verificationClass === 'observation' || isObservationGoalTool(goal.tool)) {
    const execution = await runReadOnlyGoalTool(readTool, goal);
    return {
      ...goal,
      nativeReadOk: execution.result?.ok === true,
      verified: false,
      status: 'observed',
      verificationClass: 'observation',
      verificationEvidence: [],
      diagnostics: [{
        severity: 'info',
        code: 'GOAL_OBSERVATION_ONLY',
        message: `目标 ${goal.goalId ?? 'unknown'} 只产生发现/静态观察，不参与 semantic completion。`
      }],
      read: execution.compactResult
    };
  }
  if (goal.kind === 'unsupported'
    || goal.verificationStatus === 'unsupported'
    || goal.status === 'unsupported') {
    return {
      ...goal,
      nativeReadOk: false,
      verified: false,
      status: 'unsupported',
      verificationStatus: 'unsupported',
      verificationEvidence: [],
      diagnostics: [{
        severity: 'error',
        code: 'GOAL_VERIFICATION_UNSUPPORTED',
        message: goal.unsupportedReason ?? `目标 ${goal.goalId ?? 'unknown'} 没有可执行验证器。`
      }],
      read: null
    };
  }
  if (goal.kind === 'param-field') {
    const key = `${goal.table}\0${goal.rowId}\0${goal.fieldId}`;
    let result = paramReads.get(key);
    if (!result) {
      result = await readTool('read_param_fields', { table: goal.table, rowIds: [goal.rowId], fieldIds: [goal.fieldId] });
      paramReads.set(key, result);
    }
    const evaluation = evaluateParamGoal(goal, result, treeEvidence);
    return evaluation;
  }
  if (goal.kind === 'composite' || goal.kind === 'semantic') {
    const children = [];
    for (const child of goal.checks) {
      children.push(await verifyGoalThroughNativeTool(readTool, child, paramReads, treeEvidence, taskContract));
    }
    const requiredChildren = children.filter((child) => child?.required !== false);
    const verified = requiredChildren.length > 0 && requiredChildren.every((child) => child.verified === true);
    const unsupported = requiredChildren.some((child) => child.status === 'unsupported');
    const changed = goalChangedInOverlay(goal, treeEvidence);
    return {
      ...goal,
      verified: verified && (goal.requireMutation !== true || changed),
      status: requiredChildren.some(child => child.status === 'failed') ? 'failed' : unsupported ? 'unsupported' : goal.requireMutation === true && !goalMutationEvidenceBound(goal, treeEvidence) ? 'unverified' : (goal.requireMutation === true && !changed) ? 'failed' : verified ? 'verified' : 'unverified',
      ...(unsupported ? { verificationStatus: 'unsupported' } : {}),
      nativeReadOk: requiredChildren.every((child) => child.nativeReadOk === true),
      observedValue: verified,
      verificationEvidence: verified && (goal.requireMutation !== true || changed) ? children.flatMap((child) => child?.verificationEvidence ?? []) : [],
      checks: children,
      diagnostics: verified && (goal.requireMutation !== true || changed)
        ? []
        : [{ code: changed ? 'SEMANTIC_ASSERTION_FAILED' : 'GOAL_RESOURCE_UNCHANGED', message: changed ? `复合目标 ${goal.goalId} 的至少一个检查未通过。` : `目标 ${goal.goalId} 指定资源在 Agent 写回后没有变化。` }]
    };
  }
  const execution = await runReadOnlyGoalTool(readTool, goal);
  const result = execution.result;
  const facts = enrichNativeSourceFacts(result, collectNativeSourceFacts(result), {
    workspaceRoot: treeEvidence?.root,
    entries: [
      ...(treeEvidence?.before?.entries ?? []),
      ...(treeEvidence?.after?.entries ?? [])
    ],
    ...(typeof goal.input?.containerPath === 'string' ? { sourceHint: goal.input.containerPath } : {})
  });
  const sourceIdentityDiagnostics = diagnoseNativeSourceUriResolution(result, {
    workspaceRoot: treeEvidence?.root,
    entries: [
      ...(treeEvidence?.before?.entries ?? []),
      ...(treeEvidence?.after?.entries ?? [])
    ],
    requiredSources: taskContract?.corpusFingerprint?.requiredSources ?? [],
    ...(typeof goal.input?.containerPath === 'string' ? { sourceHint: goal.input.containerPath } : {})
  });
  const nativeReadOk = result?.ok === true;
  const sourceHashPresent = facts.hashes.length > 0;
  const assertionOk = nativeReadOk && matchesAssertion(result, goal.assertion);
  const proofOk = (!goal.requireSourceHash || sourceHashPresent) && sourceIdentityDiagnostics.bound;
  const observed = goal.assertion?.path === undefined
    ? null
    : readAssertionPath(result, goal.assertion.path).value ?? null;
  const changed = goalChangedInOverlay(goal, treeEvidence);
  const diagnostics = [];
  if (!nativeReadOk) diagnostics.push(result?.error ?? { code: 'NATIVE_READ_FAILED', message: `${goal.tool} 读取失败。` });
  if (nativeReadOk && !assertionOk) diagnostics.push({ code: 'SEMANTIC_ASSERTION_FAILED', message: `目标 ${goal.goalId} 的原生结果未满足断言。` });
  if (nativeReadOk && !proofOk) diagnostics.push({ code: 'NATIVE_SOURCE_HASH_MISSING', message: `目标 ${goal.goalId} 缺少 sourceHash，不能作为原生验证证据。` });
  if (nativeReadOk && goal.requireMutation === true && !changed) diagnostics.push({ code: 'GOAL_RESOURCE_UNCHANGED', message: `目标 ${goal.goalId} 指定资源在 Agent 写回后没有变化。` });
  return {
    ...goal,
    nativeReadOk,
    observedValue: compactNativeToolResult(observed),
    sourceHashPresent,
    sourceRevisionPresent: facts.revisions.length > 0,
    sourceIdentityDiagnostics,
    ...evaluateNativeGoalOutcome({nativeReadOk, assertionOk, proofOk, resourceChanged:changed,
      requireMutation:goal.requireMutation === true, unavailable:isVerificationUnavailable(result), mutationEvidenceAvailable:goalMutationEvidenceBound(goal, treeEvidence)}),
    verificationEvidence: nativeReadOk && assertionOk && proofOk && (goal.requireMutation !== true || changed)
      ? [{ tool: goal.tool, sourceHashes: [...new Set(facts.hashes)].slice(0, 4), sourceRevisions: [...new Set(facts.revisions)].slice(0, 4), sourceUris: [...new Set(facts.uris)].slice(0, 4) }]
      : [],
    diagnostics,
    read: execution.compactResult
  };
}

export async function verifyGoalsThroughNativeTool(readTool, goals, treeEvidence = undefined, taskContract = undefined) {
  const reads = [];
  const read = async (tool, input) => {
    let result;
    try { result = await readTool(tool, input); }
    catch (error) { result = {ok:false,error:{code:error.code ?? 'VERIFICATION_UNAVAILABLE',message:String(error.message ?? error)}}; }
    reads.push({tool,input,result:compactNativeToolResult(result)});
    return result;
  };
  const paramReads = new Map();
  const evaluations = [];
  for (const goal of goals) evaluations.push(await verifyGoalThroughNativeTool(read, goal, paramReads, treeEvidence, taskContract));
  return { reads, evaluations };
}

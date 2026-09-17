/**
 * Machine-verifiable goal contract for the real-agent harness.
 *
 * This module is deliberately independent from Electron and production core.
 * It only accepts a finite allow-list of read tools and a data-only assertion
 * language; arbitrary JavaScript predicates never enter the harness.
 */

export const READ_ONLY_NATIVE_GOAL_TOOLS = Object.freeze(new Set([
  'read_param_fields',
  'read_fmg_entries',
  'read_emevd_event',
  'read_tae_events',
  'read_msb_parts',
  'read_luabnd_script',
  'search_events',
  'search_tae_events',
  'search_map_entities',
  'search_param_rows',
  'search_text_entries'
]));

const GOAL_KINDS = new Set([
  'param-field', 'native-tool', 'event', 'tae-field', 'script', 'composite', 'semantic'
]);

function contractError(message, details) {
  const error = new Error(message);
  error.code = 'GOAL_CONTRACT_INVALID';
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertBoundedString(value, label, max = 4096) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw contractError(`${label} 必须是非空且不超过 ${max} 字符的字符串。`);
  }
  return value.trim();
}

function assertSafeInput(value, label = 'input', depth = 0) {
  if (depth > 8) throw contractError(`${label} 嵌套层级过深。`);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw contractError(`${label} 数字必须有限。`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 16_384) throw contractError(`${label} 字符串过长。`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw contractError(`${label} 数组过长。`);
    value.forEach((child, index) => assertSafeInput(child, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) throw contractError(`${label} 必须是 JSON 数据。`);
  const keys = Object.keys(value);
  if (keys.length > 64) throw contractError(`${label} 字段过多。`);
  for (const key of keys) {
    assertBoundedString(key, `${label} 的字段名`, 128);
    assertSafeInput(value[key], `${label}.${key}`, depth + 1);
  }
}

function normalizeAssertion(value, label) {
  if (!isPlainRecord(value)) throw contractError(`${label} 必须是对象。`);
  assertSafeInput(value, label);
  return value;
}

function defaultGoalId(goal, index) {
  return typeof goal.goalId === 'string' && goal.goalId.trim() !== ''
    ? goal.goalId.trim()
    : `goal-${index + 1}`;
}

function normalizeGoal(goal, index, prefix = '') {
  if (!isPlainRecord(goal) || !GOAL_KINDS.has(goal.kind)) {
    throw contractError(`${prefix}goal[${index}] kind 不受支持。`);
  }
  const goalId = defaultGoalId(goal, index);
  const required = goal.required !== false;
  const changedPath = goal.changedPath === undefined
    ? undefined
    : assertBoundedString(goal.changedPath, `${prefix}goal[${index}].changedPath`, 512)
        .replaceAll('\\', '/').replace(/^\/+/, '');

  if (goal.kind === 'param-field') {
    if (typeof goal.table !== 'string' || goal.table.trim() === ''
      || !Number.isSafeInteger(goal.rowId)
      || typeof goal.fieldId !== 'string' || goal.fieldId.trim() === ''
      || !['string', 'number', 'boolean'].includes(typeof goal.expectedValue)) {
      throw contractError(`${prefix}goal[${index}] 不是有效的 param-field 目标。`);
    }
    return {
      goalId,
      kind: 'param-field',
      table: goal.table.trim(),
      rowId: goal.rowId,
      fieldId: goal.fieldId.trim(),
      expectedValue: goal.expectedValue,
      required,
      ...(changedPath ? { changedPath } : {})
    };
  }

  if (goal.kind === 'composite' || goal.kind === 'semantic') {
    if (!Array.isArray(goal.checks) || goal.checks.length === 0 || goal.checks.length > 64) {
      throw contractError(`${prefix}goal[${index}] 需要 1 到 64 个 checks。`);
    }
    const checks = goal.checks.map((child, childIndex) => normalizeGoal(child, childIndex, `${goalId}.`));
    return {
      goalId,
      kind: goal.kind,
      checks,
      required,
      ...(changedPath ? { changedPath } : {}),
      ...(typeof goal.description === 'string' ? { description: goal.description.slice(0, 512) } : {})
    };
  }

  let tool = goal.tool;
  let input = goal.input;
  let assertion = goal.assertion ?? goal.assert;
  if (goal.kind === 'event') {
    if (typeof goal.file !== 'string' || goal.file.trim() === '' || !Number.isSafeInteger(goal.eventId)) {
      throw contractError(`${prefix}goal[${index}] event 目标需要 file 与安全整数 eventId。`);
    }
    tool = 'read_emevd_event';
    input = {
      file: goal.file,
      eventId: goal.eventId,
      ...(goal.format ? { format: goal.format } : {})
    };
  } else if (goal.kind === 'tae-field') {
    if (typeof goal.file !== 'string' || goal.file.trim() === ''
      || typeof goal.address !== 'string' || goal.address.trim() === '') {
      throw contractError(`${prefix}goal[${index}] tae-field 目标需要 file 与 address。`);
    }
    tool = 'read_tae_events';
    input = {
      file: goal.file,
      addresses: [goal.address],
      pageSize: 1
    };
    if (assertion === undefined && typeof goal.fieldName === 'string') {
      assertion = {
        path: 'data.events',
        some: {
          path: 'fields',
          some: {
            allOf: [
              { path: 'name', equals: goal.fieldName },
              { path: 'value', equals: goal.expectedValue }
            ]
          }
        }
      };
    }
  } else if (goal.kind === 'script') {
    if (typeof goal.file !== 'string' || goal.file.trim() === ''
      || typeof goal.childPath !== 'string' || goal.childPath.trim() === '') {
      throw contractError(`${prefix}goal[${index}] script 目标需要 file 与 childPath。`);
    }
    tool = 'read_luabnd_script';
    input = { file: goal.file, childPath: goal.childPath };
    if (assertion === undefined && typeof goal.contains === 'string') {
      assertion = { path: 'data.script.sourceText', contains: goal.contains };
    }
  }

  if (typeof tool !== 'string' || !READ_ONLY_NATIVE_GOAL_TOOLS.has(tool)) {
    throw contractError(`${prefix}goal[${index}] tool 不是允许的只读 native 工具。`);
  }
  if (!isPlainRecord(input)) throw contractError(`${prefix}goal[${index}] input 必须是对象。`);
  assertSafeInput(input, `${goalId}.input`);
  if (assertion === undefined) throw contractError(`${prefix}goal[${index}] 缺少 assertion。`);
  return {
    goalId,
    kind: goal.kind === 'event' || goal.kind === 'tae-field' || goal.kind === 'script' ? goal.kind : 'native-tool',
    tool,
    input,
    assertion: normalizeAssertion(assertion, `${goalId}.assertion`),
    required,
    ...(changedPath ? { changedPath } : {}),
    requireSourceHash: goal.requireSourceHash !== false
  };
}

export function parseGoalContract(raw, {
  observationOnly = false,
  taskQuery,
  defaultTaskQuery,
  defaultGoals = []
} = {}) {
  if (raw === undefined) {
    if (observationOnly) return [];
    if (taskQuery === defaultTaskQuery) return defaultGoals.map((goal) => ({ ...goal }));
    throw contractError('非默认任务须用 --goals 提供机器可验证目标，或 --observe 观察原文执行。');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw contractError(`--goals 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const goals = Array.isArray(parsed) ? parsed : parsed?.goals;
  if (!Array.isArray(goals) || goals.length === 0 || goals.length > 64) {
    throw contractError('--goals 必须是 1 到 64 项的数组，或包含该数组的对象。');
  }
  const ids = new Set();
  return goals.map((goal, index) => {
    const normalized = normalizeGoal(goal, index);
    if (ids.has(normalized.goalId)) throw contractError(`goalId 重复：${normalized.goalId}`);
    ids.add(normalized.goalId);
    return normalized;
  });
}

function valuesEqual(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'string' && /^-?(?:0|[1-9]\d*)$/u.test(expected)) {
    return Number.isSafeInteger(actual) && actual === Number(expected);
  }
  if (typeof actual === 'string' && typeof expected === 'number' && Number.isSafeInteger(expected)) {
    return actual === String(expected);
  }
  return Object.is(actual, expected);
}

export function readAssertionPath(value, path) {
  if (typeof path !== 'string' || path.trim() === '') return { found: true, value };
  const parts = path.match(/[^.[\]]+|\[(\d+)\]/gu) ?? [];
  let current = value;
  for (const rawPart of parts) {
    const part = rawPart.startsWith('[') ? rawPart.slice(1, -1) : rawPart;
    if (Array.isArray(current) && /^\d+$/u.test(part)) {
      const index = Number(part);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (isPlainRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

export function matchesAssertion(root, assertion) {
  if (!isPlainRecord(assertion)) return false;
  if (Array.isArray(assertion.allOf)) return assertion.allOf.every((child) => matchesAssertion(root, child));
  if (Array.isArray(assertion.anyOf)) return assertion.anyOf.some((child) => matchesAssertion(root, child));
  if (assertion.some !== undefined) {
    const target = assertion.path === undefined ? root : readAssertionPath(root, assertion.path).value;
    return Array.isArray(target) && target.some((item) => matchesAssertion(item, assertion.some));
  }
  if (assertion.every !== undefined) {
    const target = assertion.path === undefined ? root : readAssertionPath(root, assertion.path).value;
    return Array.isArray(target) && target.length > 0 && target.every((item) => matchesAssertion(item, assertion.every));
  }
  const resolved = readAssertionPath(root, assertion.path);
  if (assertion.exists === true) return resolved.found;
  if (!resolved.found) return false;
  const actual = resolved.value;
  if (Object.prototype.hasOwnProperty.call(assertion, 'equals')) return valuesEqual(actual, assertion.equals);
  if (Object.prototype.hasOwnProperty.call(assertion, 'notEquals')) return !valuesEqual(actual, assertion.notEquals);
  if (Object.prototype.hasOwnProperty.call(assertion, 'contains')) {
    return typeof actual === 'string'
      ? actual.includes(String(assertion.contains))
      : Array.isArray(actual) && actual.some((item) => valuesEqual(item, assertion.contains));
  }
  if (Object.prototype.hasOwnProperty.call(assertion, 'includes')) {
    return Array.isArray(actual) && assertion.includes !== undefined
      && actual.some((item) => valuesEqual(item, assertion.includes));
  }
  if (Object.prototype.hasOwnProperty.call(assertion, 'count')) {
    return (Array.isArray(actual) || typeof actual === 'string') && actual.length === assertion.count;
  }
  if (Object.prototype.hasOwnProperty.call(assertion, 'min')) {
    return typeof actual === 'number' && actual >= assertion.min;
  }
  if (Object.prototype.hasOwnProperty.call(assertion, 'max')) {
    return typeof actual === 'number' && actual <= assertion.max;
  }
  return false;
}

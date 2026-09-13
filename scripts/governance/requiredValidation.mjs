/**
 * requiredValidation 的兼容契约。
 *
 * 历史切片仍可使用一段人类可读的 legacy string；新切片则把可执行的根
 * package.json npm suite、参数、环境和人工检查拆成可校验的字段。这里不读
 * 文件也不执行命令：调用方注入 package.json，因而同一份纯函数可被治理门禁、
 * gov CLI 和验证计划复用。
 */

const SINGLE_KEYS = new Set(['suiteId', 'args', 'env', 'manualChecks', 'notes']);
const SEQUENCE_KEYS = new Set(['steps', 'manualChecks', 'notes']);
const STEP_KEYS = new Set(['suiteId', 'args', 'env']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeFinding(code, where, message) {
  return { severity: 'error', code, where, message };
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeStringArray(value, field, where, findings, { allowEmpty = true, allowBlankItems = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || (!allowBlankItems && item.trim().length === 0))) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      where,
      `${field} 必须是${allowEmpty ? '' : '非空'}字符串数组。`
    ));
    return [];
  }
  return [...value];
}

function normalizeEnv(value, where, findings) {
  if (value === undefined) return {};
  if (!isRecord(value)
    || Object.entries(value).some(([key, item]) => key.trim().length === 0 || typeof item !== 'string')) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      where,
      'env 必须是键为非空字符串、值为字符串的对象。'
    ));
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function normalizeStep(value, where, findings) {
  if (!isRecord(value) || !hasOnlyKeys(value, STEP_KEYS)
    || typeof value.suiteId !== 'string' || value.suiteId.trim().length === 0) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      where,
      '每个 validation step 必须只有 suiteId/args/env，且 suiteId 为非空字符串。'
    ));
    return null;
  }
  const args = normalizeStringArray(value.args, 'args', `${where}.args`, findings, { allowBlankItems: true });
  const env = normalizeEnv(value.env, `${where}.env`, findings);
  return { suiteId: value.suiteId, args, env };
}

function stepFields(value) {
  return {
    suiteId: value.suiteId,
    ...(value.args === undefined ? {} : { args: value.args }),
    ...(value.env === undefined ? {} : { env: value.env })
  };
}

function normalizeMetadata(value, where, findings) {
  const manualChecks = normalizeStringArray(
    value.manualChecks,
    'manualChecks',
    `${where}.manualChecks`,
    findings
  );
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.trim().length === 0)) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      `${where}.notes`,
      'notes 必须是非空字符串（省略时表示没有补充说明）。'
    ));
  }
  return {
    manualChecks,
    notes: value.notes === undefined ? '' : String(value.notes)
  };
}

/**
 * 把 legacy 或 structured requiredValidation 归一成验证计划。
 * malformed 数据返回 null；详细诊断由 validateRequiredValidation 提供。
 *
 * @returns {{kind: 'legacy'|'structured', raw?: string, steps: Array<{suiteId: string, args: string[], env: object}>, manualChecks: string[], notes: string}|null}
 */
export function normalizeRequiredValidation(value) {
  if (typeof value === 'string') {
    return {
      kind: 'legacy',
      raw: value,
      steps: [],
      manualChecks: [],
      notes: ''
    };
  }
  if (!isRecord(value)) return null;

  const findings = [];
  if (Object.prototype.hasOwnProperty.call(value, 'steps')) {
    if (!hasOnlyKeys(value, SEQUENCE_KEYS) || !Array.isArray(value.steps) || value.steps.length === 0) {
      return null;
    }
    const steps = value.steps.map((step, index) => normalizeStep(
      step,
      `requiredValidation.steps[${index}]`,
      findings
    ));
    const metadata = normalizeMetadata(value, 'requiredValidation', findings);
    if (findings.length > 0 || steps.some((step) => step === null)) return null;
    return {
      kind: 'structured',
      steps,
      ...metadata
    };
  }

  if (!Object.prototype.hasOwnProperty.call(value, 'suiteId') || !hasOnlyKeys(value, SINGLE_KEYS)) {
    return null;
  }
  const step = normalizeStep(stepFields(value), 'requiredValidation', findings);
  const metadata = normalizeMetadata(value, 'requiredValidation', findings);
  if (step === null || findings.length > 0) return null;
  return {
    kind: 'structured',
    steps: [step],
    ...metadata
  };
}

/**
 * 校验一个 requiredValidation。rootPackage 必须是当前仓库根 package.json 的
 * 解析结果；结构化 suiteId 不在另一个 registry 中复制，而是直接对账其 scripts
 * 键。legacy string 只做形状检查，以保持历史 completed 切片可读。
 */
export function validateRequiredValidation(value, {
  rootPackage,
  where = 'docs/governance/slices.json.requiredValidation'
} = {}) {
  const findings = [];
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      findings.push(makeFinding(
        'REQUIRED_VALIDATION_STRUCTURE_INVALID',
        where,
        'legacy requiredValidation string 不能为空。'
      ));
    }
    return findings;
  }
  if (!isRecord(value)) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      where,
      'requiredValidation 必须是 legacy string 或 structured object。'
    ));
    return findings;
  }

  const hasSteps = Object.prototype.hasOwnProperty.call(value, 'steps');
  const hasSuiteId = Object.prototype.hasOwnProperty.call(value, 'suiteId');
  if ((hasSteps && hasSuiteId)
    || (!hasSteps && !hasSuiteId)
    || !hasOnlyKeys(value, hasSteps ? SEQUENCE_KEYS : SINGLE_KEYS)) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      where,
      'structured requiredValidation 必须是单步 suiteId 对象，或带有有序 steps 数组的对象；不得混用或增加未知字段。'
    ));
    return findings;
  }

  if (hasSteps) {
    if (!Array.isArray(value.steps) || value.steps.length === 0) {
      findings.push(makeFinding(
        'REQUIRED_VALIDATION_STRUCTURE_INVALID',
        `${where}.steps`,
        'steps 必须是非空数组。'
      ));
    }
  }

  const steps = hasSteps
    ? (Array.isArray(value.steps)
      ? value.steps.map((step, index) => normalizeStep(step, `${where}.steps[${index}]`, findings))
      : [])
    : [normalizeStep(stepFields(value), where, findings)];
  normalizeMetadata(value, where, findings);
  if (findings.length > 0) return findings;

  const suiteIds = rootNpmSuiteIds(rootPackage);
  if (suiteIds === null) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_SUITE_REGISTRY_UNAVAILABLE',
      where,
      '无法读取当前根 package.json 的 scripts；结构化 suiteId 必须在可验证的根 npm 脚本集合中解析，失败关闭。'
    ));
    return findings;
  }
  for (const [index, step] of steps.entries()) {
    if (!suiteIds.has(step.suiteId)) {
      findings.push(makeFinding(
        'REQUIRED_VALIDATION_SUITE_UNDEFINED',
        `${where}${hasSteps ? `.steps[${index}]` : ''}.suiteId`,
        `suiteId=${step.suiteId} 不存在于当前根 package.json 的 scripts。`
      ));
    }
  }
  return findings;
}

/** 返回当前根 package.json 中可引用的 npm suiteId 集合；不可用时返回 null。 */
export function rootNpmSuiteIds(rootPackage) {
  if (!isRecord(rootPackage) || !isRecord(rootPackage.scripts)) return null;
  return new Set(Object.keys(rootPackage.scripts));
}

/** 对全部切片执行 requiredValidation 结构与 suite 引用校验。 */
export function validateRequiredValidations(slicesData, rootPackage, where = 'docs/governance/slices.json') {
  const findings = [];
  if (!isRecord(slicesData) || !Array.isArray(slicesData.slices)) {
    findings.push(makeFinding(
      'REQUIRED_VALIDATION_STRUCTURE_INVALID',
      where,
      'slices 数据必须包含 slices 数组。'
    ));
    return findings;
  }
  for (const [index, slice] of slicesData.slices.entries()) {
    findings.push(...validateRequiredValidation(
      slice?.requiredValidation,
      {
        rootPackage,
        where: `${where} ${slice?.sliceId ?? `<index:${index}>`}.requiredValidation`
      }
    ));
  }
  return findings;
}

function quoteArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : JSON.stringify(text);
}

function formatStep(step) {
  const env = Object.entries(step.env)
    .map(([key, value]) => `${key}=${quoteArg(value)}`)
    .join(' ');
  const args = step.args.length > 0 ? ` -- ${step.args.map(quoteArg).join(' ')}` : '';
  const command = `npm run ${step.suiteId}${args}`;
  return env.length > 0 ? `${env} ${command}` : command;
}

/**
 * 供 gov next、handoff 投影和旧人读入口使用的确定性文本格式化。
 * legacy string 原样返回；structured steps 按 JSON 数组顺序连接，绝不重排。
 */
export function formatRequiredValidation(value) {
  if (typeof value === 'string') return value;
  const normalized = normalizeRequiredValidation(value);
  if (normalized === null) return JSON.stringify(value);
  const sections = [normalized.steps.map(formatStep).join('；')];
  if (normalized.manualChecks.length > 0) {
    sections.push(`manualChecks：${normalized.manualChecks.join('；')}`);
  }
  if (normalized.notes.length > 0) sections.push(`notes：${normalized.notes}`);
  return sections.filter((section) => section.length > 0).join('；');
}

export const requiredValidationFreeText = formatRequiredValidation;

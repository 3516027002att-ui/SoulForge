#!/usr/bin/env node
/**
 * requiredValidation 结构化迁移的定点 fixture。
 *
 * 只在临时治理副本上运行，不写回 docs/governance；覆盖 legacy 兼容、步骤顺序、
 * 根 npm suiteId 引用和结构错误的失败关闭。它不执行任何 suite，也不改变执行面板。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  formatRequiredValidation,
  normalizeRequiredValidation,
  validateRequiredValidation
} from './governance/requiredValidation.mjs';
import { BLOCKS } from './generate-handoff-projection.mjs';
import { validateGovernanceData } from './governance/validateGovernanceData.mjs';
import {
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef,
  parseSealBaseline
} from './handoff-integrity-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const findings = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (!condition) findings.push({ name, detail });
}

const structured = {
  steps: [
    { suiteId: 'build', args: ['--first'], env: { FIRST: '1' } },
    { suiteId: 'test:governance', args: [], env: {} }
  ],
  manualChecks: ['检查 clean 包'],
  notes: '按顺序执行'
};
const normalized = normalizeRequiredValidation(structured);
check('normalize/structured-kind', normalized?.kind === 'structured', JSON.stringify(normalized));
check(
  'normalize/preserves-step-order',
  JSON.stringify(normalized?.steps.map((step) => step.suiteId)) === JSON.stringify(['build', 'test:governance']),
  JSON.stringify(normalized?.steps)
);
check('normalize/preserves-args-env', normalized?.steps[0]?.args[0] === '--first'
  && normalized?.steps[0]?.env.FIRST === '1', JSON.stringify(normalized?.steps[0]));
check(
  'format/keeps-order-and-metadata',
  formatRequiredValidation(structured)
    === 'FIRST=1 npm run build -- --first；npm run test:governance；manualChecks：检查 clean 包；notes：按顺序执行',
  formatRequiredValidation(structured)
);
const projected = BLOCKS({
  slicesData: {
    slices: [{
      sliceId: 'W-FIXTURE-REQUIRED-VALIDATION-01',
      lifecycle: 'ready',
      authority: 'candidate',
      blockerRefs: [],
      capabilityIds: ['FIXTURE'],
      goal: 'structured projection',
      hardPrerequisites: 'none',
      entryPoints: ['scripts/verify-required-validation-fixtures.mjs'],
      requiredValidation: structured,
      authorityCapNote: 'cap=candidate'
    }]
  },
  gatesData: { gates: [] },
  blockersData: { blockers: [] },
  evidenceRecords: [],
  scopeData: { scopeItems: [] },
  validationData: { frozen: [], unfrozen: [] }
})['slice-panel']();
check('projection/renders-structured-value', projected.includes('npm run build')
  && projected.indexOf('npm run build') < projected.indexOf('npm run test:governance')
  && !projected.includes('[object Object]'), projected);

const legacy = 'node scripts/legacy-check.mjs；人工复核';
check('args/preserve-empty-and-whitespace',
  JSON.stringify(normalizeRequiredValidation({ suiteId: 'build', args: ['', ' '] })?.steps[0].args) === '[""," "]',
  '空字符串和空白都是有效的原始 argv，不能清洗或拒绝。');
check('legacy/normalizes', normalizeRequiredValidation(legacy)?.kind === 'legacy', 'legacy string 未归一。');
check('legacy/formats-verbatim', formatRequiredValidation(legacy) === legacy, 'legacy string 被改写。');
check('legacy/validates-without-root-suite', validateRequiredValidation(legacy, { rootPackage: null }).length === 0,
  '历史 legacy string 不应依赖根 suite registry。');

const unknownSuite = { suiteId: 'test:does-not-exist', args: [], env: {} };
const unknownFindings = validateRequiredValidation(unknownSuite, { rootPackage, where: 'fixture.unknown' });
check('suite/undefined-is-rejected', unknownFindings.some((finding) => finding.code === 'REQUIRED_VALIDATION_SUITE_UNDEFINED'),
  JSON.stringify(unknownFindings));
check('suite/registry-unavailable-fails-closed',
  validateRequiredValidation({ suiteId: 'build' }, { rootPackage: null })
    .some((finding) => finding.code === 'REQUIRED_VALIDATION_SUITE_REGISTRY_UNAVAILABLE'),
  '缺少根 package.json 时 structured suite 不得静默放行。');

const malformed = { steps: [], manualChecks: [] };
const malformedFindings = validateRequiredValidation(malformed, { rootPackage, where: 'fixture.malformed' });
check('structure/malformed-is-rejected', malformedFindings.some((finding) => finding.code === 'REQUIRED_VALIDATION_STRUCTURE_INVALID'),
  JSON.stringify(malformedFindings));

const sandbox = mkdtempSync(join(tmpdir(), 'sf-required-validation-'));
try {
  mkdirSync(join(sandbox, 'docs'), { recursive: true });
  cpSync(join(root, 'docs', 'governance'), join(sandbox, 'docs', 'governance'), { recursive: true });
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify(rootPackage, null, 2));
  const registry = gateSubjectRegistry();
  const subjectRefsByGate = new Map(registry.gates.map((gate) => [
    gate.gateId,
    [
      ...gate.files,
      ...gate.handoffSections.map(handoffSectionSubjectRef),
      ...gate.handoffBlocks.map((block) => handoffBlockSubjectRef(block.id))
    ]
  ]));
  const options = {
    parseSealBaseline,
    subjectRefsOf: (gateId) => subjectRefsByGate.get(gateId) ?? null,
    freezeBaselineRef: null
  };
  const readSlices = () => JSON.parse(readFileSync(join(sandbox, 'docs/governance/slices.json'), 'utf8'));
  const writeSlices = (data) => writeFileSync(
    join(sandbox, 'docs/governance/slices.json'),
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );
  const run = (mutate) => {
    const data = readSlices();
    mutate(data);
    writeSlices(data);
    const result = validateGovernanceData(sandbox, options);
    return result.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code);
  };

  check('governance/structured-real-data-is-clean', run(() => []).length === 0,
    JSON.stringify(run(() => [])));
  check('governance/undefined-suite-fails-closed', run((data) => {
    const target = data.slices.find((slice) => slice.lifecycle === 'ready');
    target.requiredValidation = { suiteId: 'test:missing-suite', args: [], env: {} };
  }).includes('REQUIRED_VALIDATION_SUITE_UNDEFINED'), '未发现 undefined suiteId。');
  check('governance/malformed-structure-fails-closed', run((data) => {
    const target = data.slices.find((slice) => slice.lifecycle === 'ready');
    target.requiredValidation = { steps: [] };
  }).includes('GOVERNANCE_SCHEMA_VIOLATION'), 'schema 未拦截空 steps。');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: findings.length === 0,
  message: findings.length === 0
    ? 'requiredValidation 兼容与结构化引用 fixture 全部通过'
    : `requiredValidation fixture 有 ${findings.length} 项失败`,
  checks,
  findings
}, null, 2));
process.exitCode = findings.length === 0 ? 0 : 1;

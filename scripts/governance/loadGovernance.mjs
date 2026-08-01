/**
 * 治理数据加载器：把 docs/governance/*.json 读成门禁规则可直接消费的形状。
 *
 * 设计约束：
 * - 本模块只做「读取 + schema 校验 + 形状归一」，不含任何治理语义规则。
 *   语义规则全部留在 governanceRules.mjs，避免规则被拆成两处。
 * - 归一后的形状与旧 markdown 解析器的输出**逐字段等价**（同名、同类型、
 *   同缺省值），这样语义规则可以原样复用，不需要为换数据源重写一遍。
 *   等价性由 scripts/verify-governance-equivalence.mjs 证明。
 * - 任何 schema 违规都是 error，不降级、不容错。数据是权威，坏数据必须失败关闭。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';

export const GOVERNANCE_DIR = 'docs/governance';

const DATA_FILES = Object.freeze([
  { key: 'releases', file: 'releases.json', schema: 'releases.schema.json' },
  { key: 'scope', file: 'scope.json', schema: 'scope.schema.json' },
  { key: 'gates', file: 'gates.json', schema: 'gates.schema.json' },
  { key: 'slices', file: 'slices.json', schema: 'slices.schema.json' },
  { key: 'blockers', file: 'blockers.json', schema: 'blockers.schema.json' },
  { key: 'validation', file: 'validation.json', schema: 'validation.schema.json' }
]);

const EVIDENCE_FILE = 'evidence.jsonl';
const EVIDENCE_SCHEMA = 'evidence.schema.json';

function makeFinding(code, where, message) {
  return { severity: 'error', code, where, message };
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || '<root>'} ${error.keyword}: ${error.message}`)
    .join('; ');
}

/**
 * 读取并 schema 校验全部治理数据。
 *
 * @param {string} root 仓库根绝对路径。
 * @returns {{ data: object|null, findings: Array<object> }}
 *   data 为 null 表示数据不可用，调用方必须失败关闭而不是当作「无问题」。
 */
export function loadGovernanceData(root) {
  const findings = [];
  const ajv = new Ajv({ allErrors: true, strict: true });
  const data = {};

  for (const entry of DATA_FILES) {
    const dataPath = join(root, GOVERNANCE_DIR, entry.file);
    const schemaPath = join(root, GOVERNANCE_DIR, 'schema', entry.schema);
    const where = `${GOVERNANCE_DIR}/${entry.file}`;

    if (!existsSync(dataPath)) {
      findings.push(makeFinding('GOVERNANCE_DATA_MISSING', where, `治理数据文件缺失：${entry.file}`));
      continue;
    }
    if (!existsSync(schemaPath)) {
      findings.push(makeFinding(
        'GOVERNANCE_SCHEMA_MISSING',
        `${GOVERNANCE_DIR}/schema/${entry.schema}`,
        `治理 schema 缺失，无法校验 ${entry.file}；失败关闭而不是跳过校验。`
      ));
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(dataPath, 'utf8'));
    } catch (error) {
      findings.push(makeFinding('GOVERNANCE_DATA_PARSE_FAIL', where, `JSON 解析失败：${error.message}`));
      continue;
    }

    let validate;
    try {
      validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
    } catch (error) {
      findings.push(makeFinding(
        'GOVERNANCE_SCHEMA_INVALID',
        `${GOVERNANCE_DIR}/schema/${entry.schema}`,
        `schema 无法编译：${error.message}`
      ));
      continue;
    }

    if (!validate(parsed)) {
      findings.push(makeFinding(
        'GOVERNANCE_SCHEMA_VIOLATION',
        where,
        `不满足 schema：${formatAjvErrors(validate.errors)}`
      ));
      continue;
    }
    data[entry.key] = parsed;
  }

  // evidence.jsonl 逐行校验：单行坏数据不能污染其余记录，但必须逐条报出。
  const evidenceWhere = `${GOVERNANCE_DIR}/${EVIDENCE_FILE}`;
  const evidencePath = join(root, GOVERNANCE_DIR, EVIDENCE_FILE);
  const evidenceSchemaPath = join(root, GOVERNANCE_DIR, 'schema', EVIDENCE_SCHEMA);
  if (!existsSync(evidencePath)) {
    findings.push(makeFinding('GOVERNANCE_DATA_MISSING', evidenceWhere, 'evidence.jsonl 缺失。'));
  } else if (!existsSync(evidenceSchemaPath)) {
    findings.push(makeFinding(
      'GOVERNANCE_SCHEMA_MISSING',
      `${GOVERNANCE_DIR}/schema/${EVIDENCE_SCHEMA}`,
      'evidence schema 缺失，失败关闭。'
    ));
  } else {
    let validate;
    try {
      validate = ajv.compile(JSON.parse(readFileSync(evidenceSchemaPath, 'utf8')));
    } catch (error) {
      findings.push(makeFinding(
        'GOVERNANCE_SCHEMA_INVALID',
        `${GOVERNANCE_DIR}/schema/${EVIDENCE_SCHEMA}`,
        `schema 无法编译：${error.message}`
      ));
      validate = null;
    }
    if (validate) {
      const records = [];
      const lines = readFileSync(evidencePath, 'utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.trim() === '') continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          findings.push(makeFinding(
            'GOVERNANCE_DATA_PARSE_FAIL',
            `${evidenceWhere}:${index + 1}`,
            `JSONL 行解析失败：${error.message}`
          ));
          continue;
        }
        if (!validate(record)) {
          findings.push(makeFinding(
            'GOVERNANCE_SCHEMA_VIOLATION',
            `${evidenceWhere}:${index + 1}`,
            `不满足 schema：${formatAjvErrors(validate.errors)}`
          ));
          continue;
        }
        records.push(record);
      }
      data.evidence = records;
    }
  }

  const complete = DATA_FILES.every((entry) => entry.key in data) && Array.isArray(data.evidence);
  return { data: complete ? data : null, findings };
}

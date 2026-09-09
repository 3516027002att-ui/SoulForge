/**
 * SF-12 ChangeSetPlan
 *
 * 冻结计划规范与后置条件判定契约：
 * 1. 计划、候选产物阶段与最终落盘分离。
 * 2. readSet 包含规范资源 URI/版本/模式定义；writeSet 以最终 outer 目标为单位（同 outer 聚合）。
 * 3. expectedPostconditions 必须可由程序读取校验（文本/字段/实体属性/哈希）。
 * 4. 计划哈希严格确定性计算，保证授权与入锁核验一致。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Diagnostic } from '@soulforge/shared';

export interface ChangeSetReadItem {
  canonicalUri: string;
  canonicalPath?: string;
  version?: string | number;
  hash?: string;
  schemaOrKind?: string;
}

export interface ChangeSetWriteItem {
  canonicalOuterUri: string;
  canonicalOuterPath: string;
  targetKind?: string;
  expectedBeforeHash?: string;
  beforeExists?: boolean;
  expectedAfterHash?: string;
  afterExists?: boolean;
}

export interface ChangeSetOperation {
  id: string;
  targetOuterUri: string;
  targetOuterPath: string;
  childIdentifier?: {
    index?: number;
    id?: number;
    name?: string;
    hash?: string;
    leafFormat?: string;
  };
  domain: string;
  kind: string;
  payload: unknown;
}

export interface ChangeSetCandidate {
  operationId: string;
  artifactHandle: string;
  targetOuterPath: string;
  sourceVersion: string;
  payloadHash: string;
  bytes: number;
  writerVerificationInfo?: Record<string, unknown>;
}

export interface FrozenVersionCheck {
  canonicalUri: string;
  expectedVersion?: string | number;
  expectedHash?: string;
  actualVersion?: string | number;
  actualHash?: string;
}

export type ChangeSetPostcondition =
  | {
      type: 'text_entry_equals';
      description?: string;
      handle?: string;
      containerUri?: string;
      category?: string;
      entryId?: number;
      expectedText: string;
    }
  | {
      type: 'param_field_equals';
      description?: string;
      paramName: string;
      rowId: number;
      fieldName: string;
      expectedValue: unknown;
    }
  | {
      type: 'msb_part_property_equals';
      description?: string;
      mapId: string;
      partName: string;
      property: string;
      expectedValue: unknown;
    }
  | {
      type: 'file_hash_equals';
      description?: string;
      targetPath: string;
      expectedHash: string;
    }
  | {
      type: 'custom_check';
      checkId: string;
      description: string;
      expectedState?: unknown;
    };

export interface ChangeSetPlan {
  planId: string;
  workspaceId: string;
  baseSnapshot: {
    snapshotId?: string;
    rootHash?: string;
    capturedAt: string;
    [key: string]: unknown;
  };
  readSet: ChangeSetReadItem[];
  writeSet: ChangeSetWriteItem[];
  orderedOperations: ChangeSetOperation[];
  expectedPostconditions: ChangeSetPostcondition[];
  requiredCapabilities: string[];
  expectedChangedObjectCount: number;
  planHash: string;
  approvalReceiptId?: string;
  idempotencyKey?: string;
  createdAt: string;
}

export interface CreateChangeSetPlanInput {
  planId?: string;
  workspaceId: string;
  baseSnapshot?: {
    snapshotId?: string;
    rootHash?: string;
    capturedAt?: string;
    [key: string]: unknown;
  };
  readSet: ChangeSetReadItem[];
  writeSet: ChangeSetWriteItem[];
  orderedOperations: ChangeSetOperation[];
  expectedPostconditions?: ChangeSetPostcondition[];
  requiredCapabilities?: string[];
  expectedChangedObjectCount?: number;
  approvalReceiptId?: string;
  idempotencyKey?: string;
  createdAt?: string;
}

/**
 * 确定性计算 ChangeSetPlan 规范哈希
 */
export function computeChangeSetPlanHash(
  plan: Omit<ChangeSetPlan, 'planHash'>
): string {
  const normReadSet = [...plan.readSet]
    .map((item) => ({
      canonicalUri: item.canonicalUri,
      canonicalPath: item.canonicalPath ? item.canonicalPath.replaceAll('\\', '/').toLowerCase() : undefined,
      version: item.version,
      hash: item.hash,
      schemaOrKind: item.schemaOrKind
    }))
    .sort((a, b) => a.canonicalUri.localeCompare(b.canonicalUri));

  const normWriteSet = [...plan.writeSet]
    .map((item) => ({
      canonicalOuterUri: item.canonicalOuterUri,
      canonicalOuterPath: item.canonicalOuterPath.replaceAll('\\', '/').toLowerCase(),
      targetKind: item.targetKind,
      expectedBeforeHash: item.expectedBeforeHash,
      beforeExists: item.beforeExists,
      expectedAfterHash: item.expectedAfterHash,
      afterExists: item.afterExists
    }))
    .sort((a, b) => a.canonicalOuterPath.localeCompare(b.canonicalOuterPath));

  const normOps = plan.orderedOperations.map((op) => ({
    id: op.id,
    targetOuterPath: op.targetOuterPath.replaceAll('\\', '/').toLowerCase(),
    childIdentifier: op.childIdentifier,
    domain: op.domain,
    kind: op.kind,
    payload: op.payload
  }));

  const payload = JSON.stringify({
    workspaceId: plan.workspaceId,
    baseSnapshot: plan.baseSnapshot,
    readSet: normReadSet,
    writeSet: normWriteSet,
    orderedOperations: normOps,
    expectedPostconditions: plan.expectedPostconditions ?? [],
    requiredCapabilities: [...(plan.requiredCapabilities ?? [])].sort(),
    expectedChangedObjectCount: plan.expectedChangedObjectCount
  });

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 构造并冻结 ChangeSetPlan。
 * 强制检查：同 outer 聚合，writeSet 中每个 outer 文件绝对路径只能出现一次。
 */
export function createChangeSetPlan(input: CreateChangeSetPlanInput): ChangeSetPlan {
  const planId = input.planId ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const baseSnapshot = {
    capturedAt: createdAt,
    ...(input.baseSnapshot ?? {})
  };

  // 校验 writeSet 中的 outer 唯一性
  const seenOuterPaths = new Set<string>();
  for (const item of input.writeSet) {
    const norm = item.canonicalOuterPath.replaceAll('\\', '/').toLowerCase();
    if (seenOuterPaths.has(norm)) {
      throw new Error(
        `CHANGE_SET_DUPLICATE_OUTER: writeSet 中对于同一 outer 只能出现一次 (${item.canonicalOuterPath})`
      );
    }
    seenOuterPaths.add(norm);
  }

  const expectedChangedObjectCount =
    input.expectedChangedObjectCount ?? input.orderedOperations.length;

  const unsigned: Omit<ChangeSetPlan, 'planHash'> = {
    planId,
    workspaceId: input.workspaceId,
    baseSnapshot,
    readSet: [...input.readSet],
    writeSet: [...input.writeSet],
    orderedOperations: [...input.orderedOperations],
    expectedPostconditions: [...(input.expectedPostconditions ?? [])],
    requiredCapabilities: [...(input.requiredCapabilities ?? [])],
    expectedChangedObjectCount,
    ...(input.approvalReceiptId ? { approvalReceiptId: input.approvalReceiptId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    createdAt
  };

  const planHash = computeChangeSetPlanHash(unsigned);

  return {
    ...unsigned,
    planHash
  };
}

/**
 * 校验 ChangeSetPlan 完整性与哈希一致性
 */
export function validateChangeSetPlan(plan: ChangeSetPlan): {
  ok: boolean;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];

  if (!plan.planId) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_PLAN_ID',
      message: 'ChangeSetPlan 缺少 planId'
    });
  }

  if (!plan.workspaceId) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_WORKSPACE_ID',
      message: 'ChangeSetPlan 缺少 workspaceId'
    });
  }

  // 校验写集合同 outer 唯一性
  const seenOuter = new Set<string>();
  for (const item of plan.writeSet) {
    const norm = item.canonicalOuterPath.replaceAll('\\', '/').toLowerCase();
    if (seenOuter.has(norm)) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_OUTER_TARGET',
        message: `writeSet 中存在重复的 outer 目标: ${item.canonicalOuterPath}`
      });
    }
    seenOuter.add(norm);
  }

  // 校验 orderedOperations 的 outer 属于 writeSet
  for (const op of plan.orderedOperations) {
    const norm = op.targetOuterPath.replaceAll('\\', '/').toLowerCase();
    if (!seenOuter.has(norm)) {
      diagnostics.push({
        severity: 'error',
        code: 'OPERATION_OUTER_NOT_IN_WRITESET',
        message: `操作 ${op.id} 的目标 outer 不在 writeSet 中: ${op.targetOuterPath}`
      });
    }
  }

  // 校验计划哈希
  const expectedHash = computeChangeSetPlanHash(plan);
  if (plan.planHash !== expectedHash) {
    diagnostics.push({
      severity: 'error',
      code: 'PLAN_HASH_MISMATCH',
      message: `ChangeSetPlan 哈希不匹配 (声明: ${plan.planHash}, 实际: ${expectedHash})`
    });
  }

  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics
  };
}

/** Operations are simulated per child, but committed once per outer. */
export function groupChangeSetOperationsByOuter(
  plan: Pick<ChangeSetPlan, 'orderedOperations'>
): Map<string, ChangeSetOperation[]> {
  const groups = new Map<string, ChangeSetOperation[]>();
  for (const operation of plan.orderedOperations) {
    const key = operation.targetOuterPath.replaceAll('\\', '/').toLowerCase();
    const list = groups.get(key);
    if (list) list.push(operation);
    else groups.set(key, [operation]);
  }
  return groups;
}

/**
 * Re-check every frozen read item at the write boundary. No item may be silently
 * rebased to a newer source version after approval.
 */
export function validateFrozenReadSet(
  plan: Pick<ChangeSetPlan, 'readSet' | 'planHash'>,
  actual: readonly FrozenVersionCheck[]
): { ok: boolean; code?: 'STALE_PLAN' | 'READ_SET_MISSING'; mismatches: FrozenVersionCheck[] } {
  const byUri = new Map(actual.map((item) => [item.canonicalUri, item]));
  const mismatches: FrozenVersionCheck[] = [];
  for (const expected of plan.readSet) {
    const found = byUri.get(expected.canonicalUri);
    if (!found) {
      mismatches.push({
        canonicalUri: expected.canonicalUri,
        ...(expected.version !== undefined ? { expectedVersion: expected.version } : {}),
        ...(expected.hash !== undefined ? { expectedHash: expected.hash } : {})
      });
      continue;
    }
    if ((expected.version !== undefined && found.actualVersion !== expected.version)
      || (expected.hash !== undefined && found.actualHash !== expected.hash)) {
      mismatches.push({
        canonicalUri: expected.canonicalUri,
        ...(expected.version !== undefined ? { expectedVersion: expected.version } : {}),
        ...(expected.hash !== undefined ? { expectedHash: expected.hash } : {}),
        ...(found.actualVersion !== undefined ? { actualVersion: found.actualVersion } : {}),
        ...(found.actualHash !== undefined ? { actualHash: found.actualHash } : {})
      });
    }
  }
  return {
    ok: mismatches.length === 0,
    ...(mismatches.length > 0 ? { code: actual.length < plan.readSet.length ? 'READ_SET_MISSING' : 'STALE_PLAN' } : {}),
    mismatches
  };
}

export function validateCandidatesForPlan(
  plan: Pick<ChangeSetPlan, 'orderedOperations' | 'writeSet'>,
  candidates: readonly ChangeSetCandidate[]
): { ok: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const operationIds = new Set(plan.orderedOperations.map((operation) => operation.id));
  const writeSet = new Map(plan.writeSet.map((item) => [item.canonicalOuterPath.replaceAll('\\', '/').toLowerCase(), item]));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!operationIds.has(candidate.operationId)) {
      diagnostics.push({ severity: 'error', code: 'CANDIDATE_OPERATION_UNKNOWN', message: `候选引用未知操作 ${candidate.operationId}` });
      continue;
    }
    const key = candidate.targetOuterPath.replaceAll('\\', '/').toLowerCase();
    if (!writeSet.has(key)) {
      diagnostics.push({ severity: 'error', code: 'CANDIDATE_OUTER_NOT_PLANNED', message: `候选 outer 不在冻结 writeSet: ${candidate.targetOuterPath}` });
    }
    if (seen.has(candidate.operationId)) {
      diagnostics.push({ severity: 'error', code: 'CANDIDATE_DUPLICATE_OPERATION', message: `操作 ${candidate.operationId} 产生了重复候选` });
    }
    seen.add(candidate.operationId);
    if (!candidate.artifactHandle || !candidate.payloadHash || candidate.bytes < 0) {
      diagnostics.push({ severity: 'error', code: 'CANDIDATE_ARTIFACT_INVALID', message: `候选 ${candidate.operationId} 缺少宿主产物身份或哈希` });
    }
  }
  for (const operation of plan.orderedOperations) {
    if (!seen.has(operation.id)) {
      diagnostics.push({ severity: 'error', code: 'CANDIDATE_MISSING', message: `冻结计划的操作 ${operation.id} 没有候选产物` });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export interface PostconditionEvaluator {
  readTextEntry?(handle: string | { containerUri?: string; category?: string; entryId?: number }): Promise<string | undefined>;
  readParamField?(paramName: string, rowId: number, fieldName: string): Promise<unknown>;
  readMsbPartProperty?(mapId: string, partName: string, property: string): Promise<unknown>;
  readFileHash?(targetPath: string): Promise<string | undefined>;
  runCustomCheck?(checkId: string, expectedState?: unknown): Promise<{ ok: boolean; message?: string }>;
}

/**
 * 校验程序化预期后置条件
 */
export async function evaluatePostconditions(
  postconditions: readonly ChangeSetPostcondition[],
  evaluator: PostconditionEvaluator
): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];

  for (let i = 0; i < postconditions.length; i++) {
    const cond = postconditions[i]!;
    try {
      switch (cond.type) {
        case 'text_entry_equals': {
          if (!evaluator.readTextEntry) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_EVALUATOR_UNAVAILABLE',
              message: '未提供 readTextEntry 评估器以校验 text_entry_equals'
            });
            break;
          }
          const entryTarget = cond.handle ?? {
            ...(cond.containerUri !== undefined ? { containerUri: cond.containerUri } : {}),
            ...(cond.category !== undefined ? { category: cond.category } : {}),
            ...(cond.entryId !== undefined ? { entryId: cond.entryId } : {})
          };
          const actualText = await evaluator.readTextEntry(entryTarget);
          if (actualText !== cond.expectedText) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_TEXT_MISMATCH',
              message: `后置条件[${i}] 文本不匹配: 期望 "${cond.expectedText}", 实际 "${actualText ?? '<undefined>'}"`,
              details: { expected: cond.expectedText, actual: actualText }
            });
          }
          break;
        }

        case 'param_field_equals': {
          if (!evaluator.readParamField) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_EVALUATOR_UNAVAILABLE',
              message: '未提供 readParamField 评估器以校验 param_field_equals'
            });
            break;
          }
          const actualValue = await evaluator.readParamField(cond.paramName, cond.rowId, cond.fieldName);
          if (actualValue !== cond.expectedValue) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_PARAM_FIELD_MISMATCH',
              message: `后置条件[${i}] PARAM 字段不匹配: ${cond.paramName}[${cond.rowId}].${cond.fieldName} 期望 ${cond.expectedValue}, 实际 ${actualValue}`,
              details: { expected: cond.expectedValue, actual: actualValue }
            });
          }
          break;
        }

        case 'msb_part_property_equals': {
          if (!evaluator.readMsbPartProperty) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_EVALUATOR_UNAVAILABLE',
              message: '未提供 readMsbPartProperty 评估器以校验 msb_part_property_equals'
            });
            break;
          }
          const actualValue = await evaluator.readMsbPartProperty(cond.mapId, cond.partName, cond.property);
          if (actualValue !== cond.expectedValue) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_MSB_PROPERTY_MISMATCH',
              message: `后置条件[${i}] MSB 实体属性不匹配: ${cond.mapId}:${cond.partName}.${cond.property} 期望 ${cond.expectedValue}, 实际 ${actualValue}`,
              details: { expected: cond.expectedValue, actual: actualValue }
            });
          }
          break;
        }

        case 'file_hash_equals': {
          if (!evaluator.readFileHash) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_EVALUATOR_UNAVAILABLE',
              message: '未提供 readFileHash 评估器以校验 file_hash_equals'
            });
            break;
          }
          const actualHash = await evaluator.readFileHash(cond.targetPath);
          if (actualHash !== cond.expectedHash) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_FILE_HASH_MISMATCH',
              message: `后置条件[${i}] 文件哈希不匹配: ${cond.targetPath} 期望 ${cond.expectedHash}, 实际 ${actualHash ?? '<none>'}`,
              details: { expected: cond.expectedHash, actual: actualHash }
            });
          }
          break;
        }

        case 'custom_check': {
          if (!evaluator.runCustomCheck) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_EVALUATOR_UNAVAILABLE',
              message: `未提供 runCustomCheck 评估器以校验 custom_check (${cond.checkId})`
            });
            break;
          }
          const checkRes = await evaluator.runCustomCheck(cond.checkId, cond.expectedState);
          if (!checkRes.ok) {
            diagnostics.push({
              severity: 'error',
              code: 'POSTCONDITION_CUSTOM_CHECK_FAILED',
              message: `后置条件[${i}] 自定义检查失败 (${cond.checkId}): ${checkRes.message ?? cond.description}`
            });
          }
          break;
        }
      }
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'POSTCONDITION_EVALUATION_ERROR',
        message: `后置条件[${i}] 执行异常: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics
  };
}

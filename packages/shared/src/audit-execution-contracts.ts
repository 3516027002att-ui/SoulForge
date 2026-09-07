/**
 * SoulForge 审计与执行合同 (Audit Execution Contracts)
 *
 * 依据：《SoulForge 全域审查与演进研究报告》与执行施工图 §0.7 / §0.8。
 * 提供全局统一的资源身份、版本指纹、规范序列化、统一错误码与事务结果合同。
 */

export function checkCondition(condition: boolean, code: string): asserts condition {
  if (!condition) {
    const error = new Error(code);
    (error as { code?: string }).code = code;
    throw error;
  }
}

export function assertValidInteger(n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  checkCondition(typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max, 'INVALID_INTEGER');
  return n;
}

export function assertNonEmptyString(s: unknown, fieldName = 'IDENTITY'): string {
  checkCondition(typeof s === 'string' && s.length > 0, `EMPTY_${fieldName}`);
  return s;
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 规范稳定 JSON 序列化器。
 * 1. 严格排斥非有限数值 (NaN / Infinity)；
 * 2. 对象 Key 字母序稳定排序；
 * 3. 严格检测并拒绝循环引用；
 * 4. 仅支持普通对象、数组与基本标量。
 */
export function stableJson(value: unknown): string {
  const ancestors = new Set<object>();

  function visit(v: unknown): string {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') {
      return JSON.stringify(v);
    }
    if (typeof v === 'number') {
      checkCondition(Number.isFinite(v), 'NONFINITE_JSON');
      return JSON.stringify(v);
    }
    checkCondition(typeof v === 'object' && v !== null, 'UNSUPPORTED_JSON');
    checkCondition(!ancestors.has(v as object), 'CYCLIC_JSON');

    ancestors.add(v as object);
    let out: string;
    if (Array.isArray(v)) {
      out = '[' + v.map(visit).join(',') + ']';
    } else {
      const proto = Object.getPrototypeOf(v);
      checkCondition(proto === Object.prototype || proto === null, 'NONPLAIN_JSON');
      const keys = Object.keys(v as Record<string, unknown>).sort(compareText);
      out = '{' + keys.map((k) => JSON.stringify(k) + ':' + visit((v as Record<string, unknown>)[k])).join(',') + '}';
    }
    ancestors.delete(v as object);
    return out;
  }

  return visit(value);
}

// ---------------------------------------------------------------------------
// 0.7 统一身份体系 (Resource / Object / Claim Identity)
// ---------------------------------------------------------------------------

export interface ResourceIdentity {
  readonly workspaceId: string;
  readonly canonicalOuterId: string;
  readonly childChain: readonly string[];
  readonly formatProfileId: string;
}

export interface ObjectIdentity extends ResourceIdentity {
  readonly domain: string;
  readonly namespace: string;
  readonly snapshotObjectHandle: string;
}

export interface ClaimIdentity extends ObjectIdentity {
  readonly propertyKey: string;
}

export function validateResourceIdentity(identity: ResourceIdentity): void {
  assertNonEmptyString(identity.workspaceId, 'WORKSPACE_ID');
  assertNonEmptyString(identity.canonicalOuterId, 'OUTER_ID');
  assertNonEmptyString(identity.formatProfileId, 'FORMAT_PROFILE_ID');
  checkCondition(
    Array.isArray(identity.childChain) && identity.childChain.every((x) => typeof x === 'string' && x.length > 0),
    'INVALID_CHILD_CHAIN'
  );
}

export function resourceIdentityKey(identity: ResourceIdentity): string {
  validateResourceIdentity(identity);
  return stableJson([
    identity.workspaceId,
    identity.canonicalOuterId,
    identity.childChain,
    identity.formatProfileId
  ]);
}

export function validateObjectIdentity(identity: ObjectIdentity): void {
  validateResourceIdentity(identity);
  assertNonEmptyString(identity.domain, 'DOMAIN');
  assertNonEmptyString(identity.namespace, 'NAMESPACE');
  assertNonEmptyString(identity.snapshotObjectHandle, 'OBJECT_HANDLE');
}

export function objectIdentityKey(identity: ObjectIdentity): string {
  validateObjectIdentity(identity);
  return stableJson([
    identity.workspaceId,
    identity.canonicalOuterId,
    identity.childChain,
    identity.formatProfileId,
    identity.domain,
    identity.namespace,
    identity.snapshotObjectHandle
  ]);
}

export function validateClaimIdentity(identity: ClaimIdentity): void {
  validateObjectIdentity(identity);
  assertNonEmptyString(identity.propertyKey, 'PROPERTY_KEY');
}

export function claimIdentityKey(identity: ClaimIdentity): string {
  validateClaimIdentity(identity);
  return stableJson([
    identity.workspaceId,
    identity.canonicalOuterId,
    identity.childChain,
    identity.formatProfileId,
    identity.domain,
    identity.namespace,
    identity.snapshotObjectHandle,
    identity.propertyKey
  ]);
}

// ---------------------------------------------------------------------------
// 快照版本与凭据
// ---------------------------------------------------------------------------

export interface SnapshotVersion {
  readonly outerHash: string;
  readonly payloadHash?: string | null;
  readonly readerSchemaHash: string;
  readonly metadataSchemaHash: string;
  readonly workspaceEpoch: number;
}

export function snapshotVersionKey(version: SnapshotVersion): string {
  assertNonEmptyString(version.outerHash, 'OUTER_HASH');
  assertNonEmptyString(version.readerSchemaHash, 'READER_SCHEMA_HASH');
  assertNonEmptyString(version.metadataSchemaHash, 'METADATA_SCHEMA_HASH');
  assertValidInteger(version.workspaceEpoch, 0);
  return stableJson([
    version.outerHash,
    version.payloadHash ?? null,
    version.readerSchemaHash,
    version.metadataSchemaHash,
    version.workspaceEpoch
  ]);
}

export interface AuditConfirmationReceipt {
  readonly workspaceId: string;
  readonly planHash: string;
  readonly targetSet: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly maxModifications: number;
  readonly expiresAt: number;
  readonly authorizationMode: 'user_confirmed' | 'pre_authorized' | 'bypass';
}

export function confirmationReceiptKey(receipt: AuditConfirmationReceipt): string {
  assertNonEmptyString(receipt.workspaceId, 'WORKSPACE_ID');
  assertNonEmptyString(receipt.planHash, 'PLAN_HASH');
  assertValidInteger(receipt.maxModifications, 1);
  assertValidInteger(receipt.expiresAt, 0);
  checkCondition(Array.isArray(receipt.targetSet), 'INVALID_TARGET_SET');
  checkCondition(Array.isArray(receipt.allowedOperations), 'INVALID_ALLOWED_OPERATIONS');
  return stableJson({
    workspaceId: receipt.workspaceId,
    planHash: receipt.planHash,
    targetSet: receipt.targetSet,
    allowedOperations: receipt.allowedOperations,
    maxModifications: receipt.maxModifications,
    expiresAt: receipt.expiresAt,
    authorizationMode: receipt.authorizationMode
  });
}

// ---------------------------------------------------------------------------
// 0.8 统一错误与结果形状
// ---------------------------------------------------------------------------

export const AUDIT_EXECUTION_ERROR_CODES = [
  'INVALID_INPUT',
  'UNSUPPORTED_CAPABILITY',
  'STALE_SNAPSHOT',
  'AMBIGUOUS_TARGET',
  'INCOMPLETE_COVERAGE',
  'PRECONDITION_FAILED',
  'VALIDATION_FAILED',
  'COMMIT_FAILED',
  'RECOVERY_REQUIRED',
  'CANCELLED_BEFORE_COMMIT',
  'COMMITTED_BUT_NOT_VERIFIED',
  'ENVIRONMENT_BLOCKED'
] as const;

export type AuditExecutionErrorCode = (typeof AUDIT_EXECUTION_ERROR_CODES)[number];

export function isAuditExecutionErrorCode(code: string): code is AuditExecutionErrorCode {
  return (AUDIT_EXECUTION_ERROR_CODES as readonly string[]).includes(code);
}

export interface AuditExecutionDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: AuditExecutionErrorCode | string;
  readonly message: string;
  readonly target?: string;
}

export interface AuditExecutionResult<T = unknown> {
  readonly transactionId: string;
  readonly commitState: 'not_committed' | 'staged' | 'committed' | 'failed' | 'rolled_back';
  readonly verificationState: 'unverified' | 'verified_native' | 'verified_synthetic' | 'failed';
  readonly requestedTargets: readonly string[];
  readonly modifiedTargets: readonly string[];
  readonly unchangedTargets: readonly string[];
  readonly postconditions: readonly string[];
  readonly affectedVersions: readonly SnapshotVersion[];
  readonly diagnostics: readonly AuditExecutionDiagnostic[];
  readonly ok: boolean;
  readonly data?: T;
}

// ---------------------------------------------------------------------------
// FMG 文本条目句柄 (TextEntryHandle)
// 固定到: workspace, outer, childIndex+expectedChildHash, language, category, slotIndex, expectedTextId, sourceVersion
// ---------------------------------------------------------------------------

export interface TextEntryHandle {
  readonly workspaceId: string;
  readonly outerId: string;
  readonly childIndex: number;
  readonly expectedChildHash: string;
  readonly language: string;
  readonly category: string;
  readonly slotIndex: number;
  readonly expectedTextId: number;
  readonly sourceVersion: number | string;
}

export function validateTextEntryHandle(handle: TextEntryHandle): void {
  assertNonEmptyString(handle.workspaceId, 'WORKSPACE_ID');
  assertNonEmptyString(handle.outerId, 'OUTER_ID');
  assertValidInteger(handle.childIndex, 0);
  assertNonEmptyString(handle.expectedChildHash, 'CHILD_HASH');
  assertNonEmptyString(handle.language, 'LANGUAGE');
  assertNonEmptyString(handle.category, 'CATEGORY');
  assertValidInteger(handle.slotIndex, 0);
  assertValidInteger(handle.expectedTextId, 0);
  checkCondition(
    (typeof handle.sourceVersion === 'number' && Number.isFinite(handle.sourceVersion)) ||
    (typeof handle.sourceVersion === 'string' && handle.sourceVersion.length > 0),
    'INVALID_SOURCE_VERSION'
  );
}

export function textEntryHandleKey(handle: TextEntryHandle): string {
  validateTextEntryHandle(handle);
  return `${handle.workspaceId}::${handle.outerId}::${handle.childIndex}::${handle.language}::${handle.category}::${handle.slotIndex}::${handle.expectedTextId}`;
}

// ---------------------------------------------------------------------------
// EMEVD 事件句柄、指令句柄与参数绑定 (EventHandle, InstructionHandle, ParameterBinding)
// 依据 SF-09 §2.4.1 / §2.4.2
// ---------------------------------------------------------------------------

export interface EventHandle {
  readonly fileUri: string;
  /** 事件 ID 在 wire 上使用精确字符串 */
  readonly eventId: string;
  readonly sourceVersion: number | string;
}

export function validateEventHandle(handle: EventHandle): void {
  assertNonEmptyString(handle.fileUri, 'FILE_URI');
  assertNonEmptyString(handle.eventId, 'EVENT_ID');
  // 事件 ID 字符串必须表示合法的安全非负整数
  checkCondition(/^\d{1,16}$/.test(handle.eventId), 'INVALID_EVENT_ID_FORMAT');
  const numericId = Number(handle.eventId);
  checkCondition(Number.isSafeInteger(numericId) && numericId >= 0, 'EVENT_ID_OUT_OF_SAFE_RANGE');
  checkCondition(
    (typeof handle.sourceVersion === 'number' && Number.isFinite(handle.sourceVersion)) ||
    (typeof handle.sourceVersion === 'string' && handle.sourceVersion.length > 0),
    'INVALID_SOURCE_VERSION'
  );
}

export function eventHandleKey(handle: EventHandle): string {
  validateEventHandle(handle);
  return `${handle.fileUri}::event:${handle.eventId}`;
}

export interface InstructionHandle {
  readonly eventHandleKey: string;
  /** 原始事件局部序号 (0-based) */
  readonly localOrdinal: number;
  /** 指令 hash (内容指纹) */
  readonly instructionHash: string;
  readonly sourceVersion: number | string;
  readonly id: string;
}

export function validateInstructionHandle(handle: InstructionHandle): void {
  assertNonEmptyString(handle.eventHandleKey, 'EVENT_HANDLE_KEY');
  assertValidInteger(handle.localOrdinal, 0);
  assertNonEmptyString(handle.instructionHash, 'INSTRUCTION_HASH');
  assertNonEmptyString(handle.id, 'INSTRUCTION_HANDLE_ID');
  checkCondition(
    (typeof handle.sourceVersion === 'number' && Number.isFinite(handle.sourceVersion)) ||
    (typeof handle.sourceVersion === 'string' && handle.sourceVersion.length > 0),
    'INVALID_SOURCE_VERSION'
  );
}

export function instructionHandleKey(handle: InstructionHandle): string {
  validateInstructionHandle(handle);
  return handle.id;
}

export interface ParameterBinding {
  readonly id: string;
  readonly eventHandleKey: string;
  /** 目标指令句柄 ID (与具体局部序号解耦) */
  readonly targetInstructionHandleId: string;
  /** 目标指令参数体内的字节偏移量 (byteOffset) */
  readonly targetByteOffset: number;
  /** 字节宽度 (width) */
  readonly byteCount: number;
  /** 事件参数源字节偏移量 (sourceStartByte) */
  readonly sourceStartByte: number;
  readonly unkId: number;
}

export function validateParameterBinding(binding: ParameterBinding): void {
  assertNonEmptyString(binding.id, 'BINDING_ID');
  assertNonEmptyString(binding.eventHandleKey, 'EVENT_HANDLE_KEY');
  assertNonEmptyString(binding.targetInstructionHandleId, 'TARGET_INSTRUCTION_HANDLE_ID');
  assertValidInteger(binding.targetByteOffset, 0);
  assertValidInteger(binding.byteCount, 1);
  assertValidInteger(binding.sourceStartByte, 0);
  assertValidInteger(binding.unkId, 0);
}

export function parameterBindingKey(binding: ParameterBinding): string {
  validateParameterBinding(binding);
  return `${binding.eventHandleKey}::bind:${binding.id}`;
}

// ---------------------------------------------------------------------------
// TAE 动画事件句柄 (TaeEventHandle)
// 依据 SF-11 §2.6.1: 固定 animId、原 eventIndex、eventTypeId、paramDataHash、sourceVersion
// ---------------------------------------------------------------------------

export interface TaeEventHandle {
  readonly fileUri: string;
  readonly animId: number;
  readonly originalEventIndex: number;
  readonly eventTypeId: number;
  readonly paramDataHash: string;
  readonly sourceVersion: number | string;
}

export function validateTaeEventHandle(handle: TaeEventHandle): void {
  assertNonEmptyString(handle.fileUri, 'FILE_URI');
  assertValidInteger(handle.animId, 0);
  assertValidInteger(handle.originalEventIndex, 0);
  assertValidInteger(handle.eventTypeId, 0);
  assertNonEmptyString(handle.paramDataHash, 'PARAM_DATA_HASH');
  checkCondition(
    (typeof handle.sourceVersion === 'number' && Number.isFinite(handle.sourceVersion)) ||
    (typeof handle.sourceVersion === 'string' && handle.sourceVersion.length > 0),
    'INVALID_SOURCE_VERSION'
  );
}

export function taeEventHandleKey(handle: TaeEventHandle): string {
  validateTaeEventHandle(handle);
  return `${handle.fileUri}::anim:${handle.animId}::event:${handle.originalEventIndex}`;
}

/**
 * SoulForge Bridge 1.0 NDJSON daemon protocol.
 * Binary authority still depends on each capability cell; protocol support is
 * never evidence that a native parser/writer exists.
 */

import type { ConfidenceAssessment } from './confidence.js';
import type { StructuredDiagnostic } from './diagnostics.js';
import type { ProvenanceSource } from './provenance.js';
import type { ResourceKind } from './types.js';

export const BRIDGE_SCHEMA_VERSION = '1.0.0';
export const BRIDGE_PROTOCOL_VERSION = '1.0.0';

export type BridgeAuthorityLevel =
  | 'unsupported'
  | 'candidate'
  | 'fixture-confirmed'
  | 'native-verified';

export type BridgeDaemonFrameKind =
  | 'handshake'
  | 'request'
  | 'request/accepted'
  | 'progress'
  | 'result'
  | 'failed'
  | 'cancelled'
  | 'cancel'
  | 'health'
  | 'capabilities';

export interface BridgeDaemonFrame<TPayload = unknown> {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION | string;
  kind: BridgeDaemonFrameKind;
  requestId?: string;
  workspaceSessionId?: string;
  deadlineUtc?: string;
  resourceUri?: string;
  timestampUtc?: string;
  payload: TPayload;
}

export interface BridgeHandshakePayload {
  /** Main-process-owned absolute roots; never supplied by the renderer. */
  allowedRoots: string[];
  /** Main-process-owned staging roots for Bridge writer output. */
  writableRoots?: string[];
  /** Main-process-owned Sekiro installation root used only for local Oodle loading. */
  oodleRuntimeRoot?: string;
  maxFrameBytes?: number;
  maxConcurrency?: number;
}

export interface BridgeRequestPayload {
  command: BridgeCommandName;
  /** Main-process-resolved path checked against handshake allowedRoots. */
  filePath: string;
  options?: Record<string, unknown>;
}

export interface BridgeCancelPayload {
  targetRequestId: string;
}

export interface BridgeDaemonResultPayload<T = unknown> {
  authority: BridgeAuthorityLevel;
  nativeFormatAuthority: boolean;
  result: T;
}

export interface BridgeDaemonFailurePayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type BridgeFailureKind =
  | 'unsupported'
  | 'failed'
  | 'partial'
  | 'timeout'
  | 'cancelled'
  | 'unsafe'
  | 'schemaMismatch';

export type BridgeCommandName =
  | 'inspect'
  | 'export-event'
  | 'export-map'
  | 'export-param'
  | 'export-msg'
  | 'validate'
  | 'probe-oodle'
  | 'probe-document-locator'
  | 'read-dcx-document'
  | 'write-bnd4'
  | 'snapshot-bnd4-child'
  | 'extract-bnd4-child'
  | 'inventory-asset-resources'
  | 'read-fmg-document'
  | 'write-fmg'
  | 'read-param-document'
  | 'write-param'
  | 'read-gparam-document'
  | 'write-gparam'
  | 'read-text-catalog'
  | 'read-emevd-document'
  | 'write-emevd'
  | 'read-msb-document'
  | 'write-msb'
  | 'read-tae-document'
  | 'read-tae-event-params'
  | 'read-chrbnd-flver-preview'
  | 'read-tpf-document'
  | 'export-tpf-texture'
  | 'read-tpf-texture-preview'
  | 'write-tpf-texture-replace'
  | 'read-flver-document'
  | 'write-flver'
  | 'read-flver-mesh'
  | 'read-flver-skeleton'
  | 'read-flver-texture-slots'
  | 'read-flver-dummies'
  | 'read-esd-document'
  | 'write-esd-document'
  | 'write-tae-document'
  | 'write-fxr-document'
  | 'read-mtd-document'
  | 'write-mtd-document'
  | 'read-fxr-document'
  | 'capabilities'
  | 'health';

/**
 * 暂存区写入成功的诊断码：写入类命令的**唯一**成功判据。
 *
 * 为什么必须集中声明：生产侧五条写路径各自内联一个字符串字面量
 * （fmg/param/emevd/msbBridgeCommit.ts 与 writers/containerChildReplaceWriter.ts
 * 都写成 `d.code === 'X_STAGING_WRITE_VERIFIED'`），而这些码由 C# 的
 * BridgeCommandService 发出。两侧靠字面量恰好相同来耦合：**C# 改一个码名，
 * 写入会静默变成 ok:false——没有编译错误，也没有任何公开层的测试失败**，
 * 症状只是「用户点保存没反应」。断言这些码的 9 个 smoke 全部在 native 层，
 * 需要私有游戏语料，公开 CI 结构上跑不到。
 *
 * 这里是那对耦合的单一声明点：TS 侧从此引用常量而不是内联字面量，
 * 而 test:bridge-write-boundary 在真实 daemon 上观测到这些码确实被发出，
 * 并与 C# 源码里的码名双向对账（缺一即失败关闭）。
 *
 * 注意语义边界：这些码只表示「已写入暂存区并重读验证」，它**不表示**
 * 该格式具备 native writer authority，也不表示往返无损。
 */
export const BRIDGE_STAGING_WRITE_VERIFIED_CODES = Object.freeze({
  fmg: 'FMG_STAGING_WRITE_VERIFIED',
  param: 'PARAM_STAGING_WRITE_VERIFIED',
  emevd: 'EMEVD_STAGING_WRITE_VERIFIED',
  msb: 'MSB_STAGING_WRITE_VERIFIED',
  bnd4: 'BND4_STAGING_WRITE_VERIFIED',
  gparam: 'GPARAM_STAGING_WRITE_VERIFIED',
  flver: 'FLVER_STAGING_WRITE_VERIFIED',
  tpf: 'TPF_STAGING_WRITE_VERIFIED',
  mtd: 'MTD_STAGING_WRITE_VERIFIED',
  esd: 'ESD_STAGING_WRITE_VERIFIED',
  tae: 'TAE_STAGING_WRITE_VERIFIED',
  fxr: 'FXR_STAGING_WRITE_VERIFIED'
} as const);

export type BridgeStagingWriteVerifiedCode =
  typeof BRIDGE_STAGING_WRITE_VERIFIED_CODES[keyof typeof BRIDGE_STAGING_WRITE_VERIFIED_CODES];

export interface BridgeCommandInputMeta {
  command: BridgeCommandName;
  schemaVersion: string;
  protocolVersion: string;
  filePath?: string;
  timeoutMs?: number;
  cancelToken?: string;
  options?: Record<string, unknown>;
}

export interface BridgeCommandOutputMeta {
  command: BridgeCommandName;
  schemaVersion: string;
  protocolVersion: string;
  durationMs?: number;
  partial: boolean;
}

export interface BridgeTypedFailure {
  kind: BridgeFailureKind;
  code: string;
  message: string;
  retryable: boolean;
  diagnostics: StructuredDiagnostic[];
  details?: Record<string, unknown>;
}

export interface BridgeProtocolEnvelope<T = unknown> {
  schemaVersion: string;
  protocolVersion: string;
  command: BridgeCommandName;
  ok: boolean;
  partial: boolean;
  data?: T;
  failure?: BridgeTypedFailure;
  diagnostics: StructuredDiagnostic[];
  /**
   * True only for real native format authority.
   * Synthetic fixtures must set this false.
   */
  nativeFormatAuthority: boolean;
  /** True when payload originates from synthetic fixtures. */
  syntheticFixture: boolean;
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceSource[];
  capabilityHints?: string[];
}

export interface BridgeCommandDescriptor {
  name: BridgeCommandName;
  description: string;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  supportsCancellation: boolean;
  supportsProgress: boolean;
  resourceKinds: ResourceKind[] | ['*'];
}

export interface BridgeCapabilityCell {
  resourceKind: ResourceKind | '*';
  command: BridgeCommandName;
  supported: boolean;
  nativeFormatAuthority: boolean;
  syntheticFixtureOnly: boolean;
  notes?: string;
}

export interface BridgeCapabilityMatrix {
  schemaVersion: string;
  protocolVersion: string;
  bridgeId: string;
  commands: BridgeCommandDescriptor[];
  cells: BridgeCapabilityCell[];
  generatedAt: string;
}

/**
 * probe-document-locator 响应（NATIVE-03）：Bridge-confirmed 格式栈。
 *
 * suffix/path 永远不能构造这里的层；只有 Bridge 真实读取外层容器后才能
 * 产生 `confirmedBy: 'bridge'` 的层。响应只携带脱敏标识符与哈希，不携带
 * 主机路径；renderer 永远只消费由 main 组装的 opaque locator。
 */
export interface BridgeDocumentLocatorLayerDto {
  readonly layerIndex: number;
  readonly formatId: string;
  readonly confirmedBy: 'bridge';
  readonly childStableId: string | null;
  readonly entry: null | {
    readonly stableEntryId: string;
    readonly entryIndex: number;
    readonly entryName: string;
    readonly expectedEntryHash: string;
  };
}

export interface BridgeDocumentLocatorValue {
  readonly outerResourceId: string;
  readonly outerByteLength: number;
  readonly outerHash: string;
  readonly containerRole: string;
  readonly layers: readonly BridgeDocumentLocatorLayerDto[];
  readonly leafFormatId: string;
  /** 'confirmed' | 'blocked' | 'unsupported' | 'conflict' */
  readonly probeStatus: string;
  readonly reasonCode: string | null;
  readonly confirmedStackIds: readonly string[];
}

export function createBridgeEnvelope<T>(
  partial: Omit<BridgeProtocolEnvelope<T>, 'schemaVersion' | 'protocolVersion'> & {
    schemaVersion?: string;
    protocolVersion?: string;
  }
): BridgeProtocolEnvelope<T> {
  const envelope: BridgeProtocolEnvelope<T> = {
    schemaVersion: partial.schemaVersion ?? BRIDGE_SCHEMA_VERSION,
    protocolVersion: partial.protocolVersion ?? BRIDGE_PROTOCOL_VERSION,
    command: partial.command,
    ok: partial.ok,
    partial: partial.partial,
    diagnostics: partial.diagnostics,
    nativeFormatAuthority: partial.syntheticFixture ? false : partial.nativeFormatAuthority,
    syntheticFixture: partial.syntheticFixture
  };
  if (partial.data !== undefined) envelope.data = partial.data;
  if (partial.failure !== undefined) envelope.failure = partial.failure;
  if (partial.confidence !== undefined) envelope.confidence = partial.confidence;
  if (partial.provenance !== undefined) envelope.provenance = partial.provenance;
  if (partial.capabilityHints !== undefined) envelope.capabilityHints = partial.capabilityHints;
  return envelope;
}

export function createSyntheticBridgeFailure(
  code: string,
  message: string,
  kind: BridgeFailureKind = 'unsupported'
): BridgeTypedFailure {
  return {
    kind,
    code,
    message,
    retryable: false,
    diagnostics: [{
      severity: kind === 'partial' ? 'warning' : 'error',
      code,
      message,
      recordedAt: new Date().toISOString()
    }]
  };
}

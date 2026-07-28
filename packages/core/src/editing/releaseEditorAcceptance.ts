import type { EditorMutationKind } from '@soulforge/shared';
import {
  EDITOR_CAPABILITY_CONTRACTS,
  type EditorDocumentAuthorityContract,
  type EditorScaleAccess,
  type ProposedReleaseEditorId
} from './editorCapabilityContract.js';

export type ReleaseEditorEvidenceKind = 'candidate' | 'benchmark';
export type ReleaseEditorAcceptanceStatus = 'candidate' | 'rejected';
export type ThresholdRulingStatus = 'pending' | 'approved';
export type EditorScaleTierId = 'tier-1' | 'tier-2' | 'tier-3';
export type ReleaseEditorAcceptanceDiagnosticArea =
  | 'inventory'
  | 'source'
  | 'document-authority'
  | 'revision'
  | 'typed-mutation'
  | 'scale-access'
  | 'capacity'
  | 'latency'
  | 'release-ruling'
  | 'threshold-ruling'
  | 'human-acceptance';

export interface ReleaseEditorInventoryItem {
  releaseEditorId: ProposedReleaseEditorId;
  editorKind: 'hex' | 'fmg' | 'param' | 'emevd' | 'msb';
  scopeRulingStatus: 'pending';
  releaseIncluded: null;
  documentAuthorityRequirement: EditorDocumentAuthorityContract;
  mutationKinds: EditorMutationKind[];
  revisionContract: 'monotonic-reject-stale';
  scalePrimitives: EditorScaleAccess[];
  currentScaleAccess: EditorScaleAccess;
  scaleDimensions: string[];
  contractSources: string[];
}

export interface PendingNumericThreshold {
  rulingStatus: 'pending';
  value: null;
}

export interface EditorScaleTierDefinition {
  tierId: EditorScaleTierId;
  rulingStatus: 'pending';
  capacity: Array<{
    dimension: string;
    minimum: PendingNumericThreshold;
    maximum: PendingNumericThreshold;
  }>;
  latency: Array<{
    metric: EditorLatencyMetric;
    maximumMs: PendingNumericThreshold;
  }>;
}

export type EditorLatencyMetric =
  | 'first-interactive'
  | 'background-complete'
  | 'single-mutation-p95'
  | 'picking-p95'
  | 'box-selection-p95';

export interface EditorScaleSamplingSchema {
  schemaVersion: 1;
  releaseEditorId: ProposedReleaseEditorId;
  scopeRulingStatus: 'pending';
  tierRulingStatus: 'pending';
  tiers: EditorScaleTierDefinition[];
}

export type EditorDocumentAuthorityLevel =
  | 'unsupported'
  | 'unverified'
  | 'candidate'
  | 'fixture-confirmed'
  | 'partial'
  | 'native-verified'
  | 'raw-byte-authority';

export interface EditorScaleSample {
  schemaVersion: 1;
  releaseEditorId: ProposedReleaseEditorId;
  sourceMode: 'real-document' | 'demo-fallback' | 'synthetic';
  documentAuthority: 'none' | EditorDocumentAuthorityContract;
  authorityLevel: EditorDocumentAuthorityLevel;
  revision: string | number | null;
  rejectsStaleRevision: boolean;
  observedMutationKinds: EditorMutationKind[];
  scaleAccess: EditorScaleAccess;
  tierId: EditorScaleTierId | null;
  capacity: Record<string, number>;
  latencyMs: Partial<Record<EditorLatencyMetric, number | null>>;
}

export interface ReleaseEditorAcceptanceDiagnostic {
  severity: 'warning' | 'error';
  area: ReleaseEditorAcceptanceDiagnosticArea;
  code: string;
  message: string;
}

export interface ReleaseEditorAcceptanceResult {
  schemaVersion: 1;
  ok: null;
  releaseEditorId: ProposedReleaseEditorId;
  acceptanceStatus: ReleaseEditorAcceptanceStatus;
  evidenceKind: ReleaseEditorEvidenceKind;
  evidenceAuthority: 'candidate';
  releaseGateDecision: 'pending';
  releasePassed: false;
  scopeRulingStatus: 'pending';
  thresholdRulingStatus: 'pending';
  humanAcceptanceStatus: 'pending';
  realHumanAcceptanceRun: false;
  diagnostics: ReleaseEditorAcceptanceDiagnostic[];
}

export interface EvaluateReleaseEditorAcceptanceInput {
  sample: EditorScaleSample;
  claimedReleaseDecision?: 'pending' | 'pass';
}

const RELEASE_SAFE_SCALE_ACCESS = new Set<EditorScaleAccess>([
  'pagination',
  'virtualization',
  'chunking',
  'streaming'
]);

const BASE_LATENCY_METRICS: readonly EditorLatencyMetric[] = [
  'first-interactive',
  'background-complete',
  'single-mutation-p95'
];

const SCENE_LATENCY_METRICS: readonly EditorLatencyMetric[] = [
  ...BASE_LATENCY_METRICS,
  'picking-p95',
  'box-selection-p95'
];

const TIER_IDS: readonly EditorScaleTierId[] = ['tier-1', 'tier-2', 'tier-3'];

export function buildProposedReleaseEditorInventory(): ReleaseEditorInventoryItem[] {
  return Object.values(EDITOR_CAPABILITY_CONTRACTS)
    .filter((contract) => contract.proposedReleaseEditorId !== null)
    .sort((left, right) => (left.proposalOrder ?? Number.MAX_SAFE_INTEGER)
      - (right.proposalOrder ?? Number.MAX_SAFE_INTEGER))
    .map((contract) => ({
      releaseEditorId: contract.proposedReleaseEditorId as ProposedReleaseEditorId,
      editorKind: contract.editorKind as ReleaseEditorInventoryItem['editorKind'],
      scopeRulingStatus: 'pending',
      releaseIncluded: null,
      documentAuthorityRequirement: contract.documentAuthority,
      mutationKinds: [...contract.mutationKinds],
      revisionContract: contract.revisionContract,
      scalePrimitives: [...contract.scalePrimitives],
      currentScaleAccess: contract.scaleAccess,
      scaleDimensions: [...contract.scaleDimensions],
      contractSources: [...contract.contractSources]
    }));
}

export function buildPendingEditorScaleSamplingSchemas(): EditorScaleSamplingSchema[] {
  return buildProposedReleaseEditorInventory().map((editor) => {
    const latencyMetrics = editor.releaseEditorId === 'msb'
      ? SCENE_LATENCY_METRICS
      : BASE_LATENCY_METRICS;
    return {
      schemaVersion: 1,
      releaseEditorId: editor.releaseEditorId,
      scopeRulingStatus: 'pending',
      tierRulingStatus: 'pending',
      tiers: TIER_IDS.map((tierId) => ({
        tierId,
        rulingStatus: 'pending',
        capacity: editor.scaleDimensions.map((dimension) => ({
          dimension,
          minimum: pendingThreshold(),
          maximum: pendingThreshold()
        })),
        latency: latencyMetrics.map((metric) => ({
          metric,
          maximumMs: pendingThreshold()
        }))
      }))
    };
  });
}

/**
 * Evaluates one instrumented observation. This harness intentionally cannot
 * emit a release pass; approved thresholds and sealed human acceptance belong
 * to a later gate evaluator.
 */
export function evaluateReleaseEditorAcceptance(
  input: EvaluateReleaseEditorAcceptanceInput
): ReleaseEditorAcceptanceResult {
  const inventory = buildProposedReleaseEditorInventory();
  const editor = inventory.find((item) => item.releaseEditorId === input.sample.releaseEditorId);
  const diagnostics: ReleaseEditorAcceptanceDiagnostic[] = [];

  if (!editor) {
    diagnostics.push(error(
      'inventory',
      'EDITOR_NOT_IN_RELEASE_INVENTORY',
      '编辑器不在待裁定的发布清单中。'
    ));
    return rejectedResult(input.sample.releaseEditorId, diagnostics);
  }

  if (input.sample.sourceMode !== 'real-document') {
    diagnostics.push(error(
      'source',
      input.sample.sourceMode === 'demo-fallback'
        ? 'EDITOR_DEMO_FALLBACK_REJECTED'
        : 'EDITOR_SYNTHETIC_SOURCE_REJECTED',
      '发布编辑器验收必须读取真实 document；demo/synthetic 只能验证 harness。'
    ));
  }

  if (!hasRequiredDocumentAuthority(editor, input.sample)) {
    diagnostics.push(error(
      'document-authority',
      'EDITOR_NATIVE_AUTHORITY_REQUIRED',
      `编辑器 ${editor.releaseEditorId} 缺少 ${editor.documentAuthorityRequirement} authority。`
    ));
  }

  if (input.sample.revision === null
    || (typeof input.sample.revision === 'string' && input.sample.revision.trim() === '')) {
    diagnostics.push(error('revision', 'EDITOR_REVISION_REQUIRED', '验收样本必须绑定非空 revision。'));
  }
  if (!input.sample.rejectsStaleRevision) {
    diagnostics.push(error(
      'revision',
      'EDITOR_REVISION_CONFLICT_NOT_REJECTED',
      '验收样本必须证明 stale revision 失败关闭。'
    ));
  }

  const missingMutations = editor.mutationKinds.filter(
    (kind) => !input.sample.observedMutationKinds.includes(kind)
  );
  if (missingMutations.length > 0) {
    diagnostics.push(error(
      'typed-mutation',
      'EDITOR_TYPED_MUTATION_COVERAGE_MISSING',
      `缺少 typed mutation 覆盖：${missingMutations.join(', ')}。`
    ));
  }

  appendScaleAccessDiagnostic(diagnostics, editor.currentScaleAccess, 'current-contract');
  appendScaleAccessDiagnostic(diagnostics, input.sample.scaleAccess, 'observed-sample');

  for (const dimension of editor.scaleDimensions) {
    const value = input.sample.capacity[dimension];
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      diagnostics.push(error(
        'capacity',
        'EDITOR_CAPACITY_MEASUREMENT_REQUIRED',
        `缺少有效容量采样：${dimension}。`
      ));
    }
  }

  const requiredLatencyMetrics = editor.releaseEditorId === 'msb'
    ? SCENE_LATENCY_METRICS
    : BASE_LATENCY_METRICS;
  for (const metric of requiredLatencyMetrics) {
    const value = input.sample.latencyMs[metric];
    if (value === undefined || value === null || !Number.isFinite(value) || value < 0) {
      diagnostics.push(error(
        'latency',
        'EDITOR_LATENCY_MEASUREMENT_REQUIRED',
        `缺少有效延迟采样：${metric}。`
      ));
    }
  }

  if (input.claimedReleaseDecision === 'pass') {
    diagnostics.push(error(
      'release-ruling',
      'EDITOR_RELEASE_PASS_FORBIDDEN',
      'candidate/benchmark harness 不得输出 release pass。'
    ));
    diagnostics.push(error(
      'threshold-ruling',
      'EDITOR_THRESHOLDS_PENDING',
      '容量与延迟阈值仍为 null/pending，不能声明通过。'
    ));
    diagnostics.push(error(
      'human-acceptance',
      'EDITOR_HUMAN_ACCEPTANCE_PENDING',
      '尚无完整 Electron 人机规模验收证据，不能声明通过。'
    ));
  } else {
    diagnostics.push(warning(
      'threshold-ruling',
      'EDITOR_THRESHOLDS_PENDING',
      '容量与延迟阈值尚未由用户裁定；本结果仅为 candidate/benchmark evidence。'
    ));
    diagnostics.push(warning(
      'human-acceptance',
      'EDITOR_HUMAN_ACCEPTANCE_PENDING',
      '尚未运行完整 Electron 人机规模验收；本 harness 只记录候选观测。'
    ));
  }

  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return {
    schemaVersion: 1,
    ok: null,
    releaseEditorId: editor.releaseEditorId,
    acceptanceStatus: hasErrors ? 'rejected' : 'candidate',
    evidenceKind: !hasErrors && hasCompleteMeasurements(editor, input.sample)
      ? 'benchmark'
      : 'candidate',
    evidenceAuthority: 'candidate',
    releaseGateDecision: 'pending',
    releasePassed: false,
    scopeRulingStatus: 'pending',
    thresholdRulingStatus: 'pending',
    humanAcceptanceStatus: 'pending',
    realHumanAcceptanceRun: false,
    diagnostics
  };
}

function pendingThreshold(): PendingNumericThreshold {
  return { rulingStatus: 'pending', value: null };
}

function appendScaleAccessDiagnostic(
  diagnostics: ReleaseEditorAcceptanceDiagnostic[],
  scaleAccess: EditorScaleAccess,
  subject: 'current-contract' | 'observed-sample'
): void {
  if (RELEASE_SAFE_SCALE_ACCESS.has(scaleAccess)) return;

  const subjectLabel = subject === 'current-contract' ? '当前能力契约' : '本次观测';
  if (scaleAccess === 'bounded-window') {
    diagnostics.push(error(
      'scale-access',
      'EDITOR_BOUNDED_WINDOW_NOT_RELEASE_SAFE',
      `${subjectLabel}仅提供固定 bounded window，不能证明用户可访问完整大文档。`
    ));
    return;
  }
  if (scaleAccess === 'eager') {
    diagnostics.push(error(
      'scale-access',
      'EDITOR_EAGER_MATERIALIZATION_NOT_RELEASE_SAFE',
      `${subjectLabel}仍会 eager materialize 完整文档，未满足大文档分页、虚拟化、分块或流式要求。`
    ));
    return;
  }

  diagnostics.push(error(
    'scale-access',
    'EDITOR_PAGINATION_OR_VIRTUALIZATION_REQUIRED',
    `${subjectLabel}的规模访问模式为 ${scaleAccess}，必须提供 pagination、virtualization、chunking 或 streaming。`
  ));
}

function hasRequiredDocumentAuthority(
  editor: ReleaseEditorInventoryItem,
  sample: EditorScaleSample
): boolean {
  if (sample.documentAuthority !== editor.documentAuthorityRequirement) return false;
  if (editor.documentAuthorityRequirement === 'raw-byte-document') {
    return sample.authorityLevel === 'raw-byte-authority';
  }
  if (editor.documentAuthorityRequirement === 'bridge-native-document') {
    return sample.authorityLevel === 'partial' || sample.authorityLevel === 'native-verified';
  }
  return sample.authorityLevel !== 'unsupported' && sample.authorityLevel !== 'unverified';
}

function hasCompleteMeasurements(
  editor: ReleaseEditorInventoryItem,
  sample: EditorScaleSample
): boolean {
  const capacitiesComplete = editor.scaleDimensions.every((dimension) => {
    const value = sample.capacity[dimension];
    return value !== undefined && Number.isFinite(value) && value >= 0;
  });
  const latencyMetrics = editor.releaseEditorId === 'msb'
    ? SCENE_LATENCY_METRICS
    : BASE_LATENCY_METRICS;
  const latenciesComplete = latencyMetrics.every((metric) => {
    const value = sample.latencyMs[metric];
    return value !== undefined && value !== null && Number.isFinite(value) && value >= 0;
  });
  return capacitiesComplete && latenciesComplete;
}

function rejectedResult(
  releaseEditorId: ProposedReleaseEditorId,
  diagnostics: ReleaseEditorAcceptanceDiagnostic[]
): ReleaseEditorAcceptanceResult {
  return {
    schemaVersion: 1,
    ok: null,
    releaseEditorId,
    acceptanceStatus: 'rejected',
    evidenceKind: 'candidate',
    evidenceAuthority: 'candidate',
    releaseGateDecision: 'pending',
    releasePassed: false,
    scopeRulingStatus: 'pending',
    thresholdRulingStatus: 'pending',
    humanAcceptanceStatus: 'pending',
    realHumanAcceptanceRun: false,
    diagnostics
  };
}

function error(
  area: ReleaseEditorAcceptanceDiagnosticArea,
  code: string,
  message: string
): ReleaseEditorAcceptanceDiagnostic {
  return { severity: 'error', area, code, message };
}

function warning(
  area: ReleaseEditorAcceptanceDiagnosticArea,
  code: string,
  message: string
): ReleaseEditorAcceptanceDiagnostic {
  return { severity: 'warning', area, code, message };
}

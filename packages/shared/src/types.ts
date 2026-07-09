export type ResourceKind =
  | 'event'
  | 'map'
  | 'param'
  | 'msg'
  | 'menu'
  | 'script'
  | 'action'
  | 'ai'
  | 'sfx'
  | 'chr'
  | 'obj'
  | 'other'
  | 'unknown';

export type ResourceFormatKind =
  | 'text'
  | 'dcx'
  | 'bnd'
  | 'emevd'
  | 'msb'
  | 'param'
  | 'fmg'
  | 'lua'
  | 'hks'
  | 'gfx'
  | 'tpf'
  | 'backup'
  | 'unknown';

export type ParseStatus = 'unparsed' | 'parsed' | 'partial' | 'unsupported' | 'failed';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  sourceUri?: string;
  details?: unknown;
}

export interface ResourceMeta {
  sourceUri: string;
  sourcePath: string;
  game: string;
  resourceKind: ResourceKind;
  parseStatus: ParseStatus;
  diagnostics: Diagnostic[];
}

export interface IndexedFile extends ResourceMeta {
  id: string;
  workspaceId: string;
  absolutePath: string;
  relativePath: string;
  extension: string;
  compoundExtension: string;
  formatKind: ResourceFormatKind;
  formatLabel: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
}

export type ReferenceConfidence = 'high' | 'medium' | 'low';

export interface ReferenceEvidence {
  sourceUri: string;
  excerpt?: string;
  instructionUri?: string;
  fieldName?: string;
  value?: string | number | boolean;
}

export interface ReferenceEdge {
  fromUri: string;
  toUri: string;
  kind:
    | 'calls_event'
    | 'reads_flag'
    | 'writes_flag'
    | 'references_map_entity'
    | 'references_region'
    | 'references_param_row'
    | 'references_text'
    | 'numeric_match'
    | 'unknown';
  confidence: ReferenceConfidence;
  reason: string;
  evidence: ReferenceEvidence[];
}

export type PatchMode = 'plan' | 'normal' | 'fullPermission';

/**
 * v0.5 AI tool permission ladder.
 * Higher levels always include lower-level capabilities after policy checks.
 */
export type AiToolPermissionLevel =
  | 'read'
  | 'analyze'
  | 'propose'
  | 'stage'
  | 'validate'
  | 'commit'
  | 'rollback';

export type OverlayLayer = 'base' | 'overlay' | 'staging' | 'generated';

export interface WorkspaceLayers {
  /** Writable ModEngine-style overlay directory opened by the user. */
  overlayRoot: string;
  /** Optional read-only game install / base directory. */
  baseRoot?: string;
  /** Content-addressed or temp staging root for Patch Engine. */
  stagingRoot?: string;
}

export interface WorkspaceSessionMeta {
  workspaceId: string;
  layers: WorkspaceLayers;
  game: string;
  openedAt: string;
  /** True when no base root is configured; capabilities may degrade. */
  baseMissing: boolean;
}

export interface PatchProposal {
  opId: string;
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  changes: PatchChange[];
  createdAt: string;
  /**
   * Optional graph-oriented view of the same proposal.
   * Built by Patch Engine helpers; not required for text-only saves.
   */
  graph?: GraphPatch;
}

export interface PatchChange {
  targetUri: string;
  targetPath: string;
  kind: 'text' | 'binary' | 'structured';
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  structuredEdit?: unknown;
  /** Overlay layer this write targets. Defaults to overlay. */
  layer?: OverlayLayer;
  resourceKind?: ResourceKind;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  retryable: boolean;
}

export type GraphPatchNodeKind =
  | 'file'
  | 'resource'
  | 'field'
  | 'reference'
  | 'containerChild'
  | 'rawRange'
  | 'operation';

export interface GraphPatchNode {
  id: string;
  kind: GraphPatchNodeKind;
  uri: string;
  label: string;
  resourceKind?: ResourceKind;
  layer?: OverlayLayer;
  meta?: Record<string, unknown>;
}

export interface GraphPatchEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: 'affects' | 'depends_on' | 'rewrites' | 'validates' | 'references' | 'contains';
  confidence?: ReferenceConfidence;
  reason?: string;
}

/**
 * Unified graph patch IR (architecture fork #110).
 * Text, structured, and future container child edits all project into this graph.
 */
export interface GraphPatch {
  opId: string;
  title: string;
  nodes: GraphPatchNode[];
  edges: GraphPatchEdge[];
  summary: {
    fileCount: number;
    resourceCount: number;
    edgeCount: number;
  };
}

export type OperationStatus =
  | 'planned'
  | 'staged'
  | 'validated'
  | 'committed'
  | 'rolled_back'
  | 'failed';

export interface FileOperationRecord {
  targetUri: string;
  targetPath: string;
  relativePath?: string;
  beforeHash: string;
  afterHash: string;
  backupPath: string;
  kind: PatchChange['kind'];
  resourceKind?: ResourceKind;
}

export interface OperationLogRecord {
  opId: string;
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  status: OperationStatus;
  createdAt: string;
  committedAt?: string;
  rolledBackAt?: string;
  backupRoot?: string;
  files: FileOperationRecord[];
  diagnostics: Diagnostic[];
  graph?: GraphPatch;
}

export interface PatchHistoryEntry {
  opId: string;
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  status: OperationStatus;
  createdAt: string;
  committedAt?: string;
  rolledBackAt?: string;
  fileCount: number;
  changedPaths: string[];
  /** Compact patch-graph summary for AI sidebar / history UI. */
  graphSummary?: GraphPatch['summary'] & { title: string };
}

export type PreviewKind = 'text' | 'hex' | 'empty' | 'failed';

export type StructuredPreviewStatus = 'parsed' | 'partial' | 'unsupported' | 'failed';

export interface ContainerReadHint {
  kind: 'pathHint' | 'binderChildCandidate' | 'nestedMagicCandidate' | 'dcxPayloadBoundary' | 'dcxDecompressedPreview' | 'binderChildTable' | 'dcxNestedBinderChildTable';
  label: string;
  offset: number;
  confidence: ReferenceConfidence;
  resourceKind?: ResourceKind | string;
  rootFormat?: string;
  extensionChain?: string[];
  source?: string;
  raw?: unknown;
}

export interface ContainerReadSummary {
  rootFormat?: string;
  fileName?: string;
  fileSize?: number;
  extensionChain: string[];
  hints: ContainerReadHint[];
  pathHintCount: number;
  binderChildCandidateCount: number;
  nestedMagicCandidateCount: number;
  dcxPayloadBoundaryCount?: number;
  dcxDecompressedPreviewCount?: number;
  binderChildTableCount?: number;
  dcxNestedBinderChildTableCount?: number;
}

export interface ResourceStructuredPreview {
  status: StructuredPreviewStatus;
  kind: ResourceKind;
  parser: string;
  summary: string;
  editable: boolean;
  events?: import('./resourceSymbols.js').EventExport[];
  maps?: import('./resourceSymbols.js').MapExport[];
  params?: import('./resourceSymbols.js').ParamExport[];
  msgs?: import('./resourceSymbols.js').MsgExport[];
  container?: ContainerReadSummary;
  bridgeResult?: BridgeResult<unknown>;
  diagnostics: Diagnostic[];
}

export interface ResourcePreview {
  file: IndexedFile;
  previewKind: PreviewKind;
  text?: string;
  hex?: string;
  nativeInspection?: BridgeResult<unknown>;
  structuredPreview?: ResourceStructuredPreview;
  truncated: boolean;
  diagnostics: Diagnostic[];
}

export interface SaveTextResourceResult {
  ok: boolean;
  opId?: string;
  backupRoot?: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
  /** Graph IR attached after successful commit (or after proposal build for review). */
  graph?: GraphPatch;
  /** Present when save was blocked because the user has not confirmed residual risk. */
  risk?: EditRiskAssessment;
  /** True when the write requires an explicit confirmation receipt before commit. */
  requiresConfirmation?: boolean;
}

/**
 * Architecture fork #108 — writer contract surface.
 * Concrete binary/structured writers plug into this gate; absence is not a free pass to write.
 */
export type WriterCapability = 'none' | 'text' | 'structured' | 'container' | 'binary';

export type EditRiskLevel = 'safe' | 'caution' | 'high' | 'blocked';

export interface WriterContract {
  id: string;
  resourceKind: ResourceKind;
  formatKind: ResourceFormatKind;
  capability: WriterCapability;
  /** Stable schema id for structuredEdit payloads (empty when capability is none). */
  inputSchemaId: string;
  supportsStaging: boolean;
  supportsRollback: boolean;
  requiresConfirmation: boolean;
  preconditions: string[];
  validators: string[];
  notes?: string;
}

export interface EditRiskAssessment {
  level: EditRiskLevel;
  /** Machine-readable reasons, e.g. UNSUPPORTED_FORMAT, TRUNCATED_PREVIEW. */
  reasons: string[];
  /** Human-readable summary for UI / AI prompts. */
  summary: string;
  /** Whether Patch Engine may proceed after an explicit confirmation receipt. */
  allowWithConfirmation: boolean;
  contract: WriterContract;
  diagnostics: Diagnostic[];
}

/**
 * Architecture fork #133 — confirmation receipt for risky or gated writes.
 */
export interface ConfirmationReceipt {
  id: string;
  confirmedAt: string;
  /** What the user confirmed (risk codes, proposal opId, etc.). */
  subjects: string[];
  riskLevel: EditRiskLevel;
  sourceUri?: string;
  note?: string;
  /** Optional policy gate tags that were satisfied. */
  policyTags?: string[];
}

export interface ScanProgress {
  scannedFiles: number;
  currentPath?: string;
}

export interface WorkspaceScanResult {
  workspaceId: string;
  workspaceRoot: string;
  files: IndexedFile[];
  diagnostics: Diagnostic[];
  countsByKind: Record<ResourceKind, number>;
}

export interface BridgeResult<T = unknown> extends ResourceMeta {
  data?: T;
}

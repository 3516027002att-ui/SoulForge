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

export interface PatchProposal {
  opId: string;
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  changes: PatchChange[];
  createdAt: string;
}

export interface PatchChange {
  targetUri: string;
  targetPath: string;
  kind: 'text' | 'binary' | 'structured';
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  structuredEdit?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  retryable: boolean;
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

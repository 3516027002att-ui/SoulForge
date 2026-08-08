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

/**
 * 工作区顶层目录资源族（不含 unknown）。
 * 放在 shared：renderer 需要同一权威列表，但不能从 core barrel 拉入 Node-only 依赖。
 */
export const KNOWN_RESOURCE_DIRS: readonly ResourceKind[] = [
  'event',
  'map',
  'param',
  'msg',
  'menu',
  'script',
  'action',
  'ai',
  'sfx',
  'chr',
  'obj',
  'other'
] as const;

/** 含 unknown 的完整 ResourceKind 枚举值表。 */
export const ALL_RESOURCE_KINDS: readonly ResourceKind[] = [
  ...KNOWN_RESOURCE_DIRS,
  'unknown'
] as const;

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

/**
 * 资源解析状态。**这个 union 由两条来源共用**，逐值标明产出方——
 * 2026-08-08 有人（按锐评 T4-4 ③ 的判断）以为 parsed/unparsed 是 C# 永不发的
 * 死值而尝试删除，typecheck 立刻抓出四处真实用法。删任何一个成员前先读这里。
 *
 * - `unparsed`：**TS 侧产出**。scanWorkspace.ts:139 给「已扫到但尚未解析」的
 *   文件打初始状态，与 Bridge 无关。
 * - `parsed`：**TS 侧产出**。workspacePipeline.ts:216 走 JSON fixture 摄取路径时
 *   使用（不经 Bridge）；resourceCapabilities.ts:154 据它推 semanticReadTier，
 *   openResourcePreview.ts:257 也读它。
 * - `partial`：**C# 产出**（ParserTypes.cs:29 BridgeResult.Partial）。解析出结构
 *   但不构成完整 authority。
 * - `unsupported`：**C# 产出**（ParserTypes.cs:12）。格式已识别但本版不支持该语义导出。
 * - `failed`：**C# 产出**（ParserTypes.cs:23）。解析失败，必须附结构化诊断。
 *
 * 实测确认（bridge 全目录 grep）：C# 三个工厂只产出 partial / unsupported /
 * failed 三值，`"parsed"` 与 `"unparsed"` 字面量在 C# 侧零命中。所以**从 Bridge
 * 收到的信封里判 parsed 恒假**——若要判「Bridge 解析成功」，正确的判据是
 * partial 加 authority 字段，不是 parsed。这不是缺陷：authority 体系刻意保守，
 * native-verified 需另有真实往返证据支撑，Bridge 不自称「完全解析成功」。
 */
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
  | 'pending'
  | 'staged'
  | 'validated'
  | 'committed'
  | 'rolled_back'
  | 'failed'
  | 'recovery_required';

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
  /** WorkspaceTransaction id when commit went through the new trunk. */
  transactionId?: string;
  /** Durable recovery path when post-commit log mark fails. */
  recoveryPath?: string;
  recoveryReason?: string;
  /** Operation whose committed result this inverse transaction reverses. */
  inverseOfOpId?: string;
  rollbackScope?: 'operation' | 'file' | 'resource_entry';
  /** Exact file or resource-entry URI reversed by a fine-grained rollback. */
  rollbackTargetUri?: string;
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
  inverseOfOpId?: string;
  rollbackScope?: OperationLogRecord['rollbackScope'];
  rollbackTargetUri?: string;
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
  /**
   * 本次预览实际读取的字节数。`truncated` 只回答「是否被截断」，而界面必须能
   * 回答「已解析多少」（anti-ai-design 的状态优先原则）——只有布尔值时，
   * 文案只能写成「只读取了前缀」这种用户无法据以判断规模的说法。
   * 与 `file.size` 一起用即可给出「已读 N / 共 M」。
   */
  bytesRead: number;
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

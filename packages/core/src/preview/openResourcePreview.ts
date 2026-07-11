import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  BridgeResult,
  ContainerReadHint,
  ContainerReadSummary,
  Diagnostic,
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamExport,
  ReferenceConfidence,
  ResourceKind,
  ResourcePreview,
  ResourceStructuredPreview
} from '@soulforge/shared';
import { runBridge, type BridgeCommand } from '../bridge/runBridge.js';
import { parseEventText } from '../parsers/eventTextParser.js';
import { parseMsgText } from '../parsers/msgTextParser.js';

export interface OpenResourcePreviewOptions {
  file: IndexedFile;
  maxBytes?: number;
  inspectNative?: boolean;
  parseStructured?: boolean;
  bridgeProjectPath?: string;
  bridgeTimeoutMs?: number;
  /** Main-owned Sekiro installation root; never sourced from renderer input. */
  oodleRuntimeRoot?: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yml',
  '.yaml',
  '.lua',
  '.hks',
  '.emevd',
  '.js',
  '.ts',
  '.csv',
  '.ini',
  '.cfg',
  '.toml',
  '.log'
]);

const NATIVE_INSPECT_FORMATS = new Set([
  'dcx',
  'bnd',
  'emevd',
  'msb',
  'param',
  'fmg',
  'lua',
  'tpf',
  'backup'
]);

export async function openResourcePreview(options: OpenResourcePreviewOptions): Promise<ResourcePreview> {
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const diagnostics: Diagnostic[] = [];

  try {
    const { buffer, bytesRead } = await readPrefix(options.file.absolutePath, Math.min(options.file.size, maxBytes));
    const slice = buffer.subarray(0, bytesRead);
    const truncated = options.file.size > bytesRead;
    const nativeInspection = await inspectNativeEnvelope(options);
    const previewKind = determinePreviewKind(options.file, slice);
    const text = previewKind === 'text' ? slice.toString('utf8') : undefined;
    const structuredPreview = await buildStructuredPreview(options, text, nativeInspection);
    const previewDiagnostics = [
      ...diagnostics,
      ...nativeInspectionDiagnostics(nativeInspection),
      ...structuredPreviewDiagnostics(structuredPreview),
      ...(truncated ? [truncatedDiagnostic(options.file)] : [])
    ];

    if (options.file.size === 0) {
      return {
        file: options.file,
        previewKind: 'empty',
        ...(nativeInspection ? { nativeInspection } : {}),
        ...(structuredPreview ? { structuredPreview } : {}),
        truncated: false,
        diagnostics: previewDiagnostics
      };
    }

    if (previewKind === 'text') {
      return {
        file: options.file,
        previewKind: 'text',
        ...(text !== undefined ? { text } : {}),
        ...(nativeInspection ? { nativeInspection } : {}),
        ...(structuredPreview ? { structuredPreview } : {}),
        truncated,
        diagnostics: previewDiagnostics
      };
    }

    return {
      file: options.file,
      previewKind: 'hex',
      hex: toHexPreview(slice),
      ...(nativeInspection ? { nativeInspection } : {}),
      ...(structuredPreview ? { structuredPreview } : {}),
      truncated,
      diagnostics: [
        ...previewDiagnostics,
        {
          severity: 'info',
          code: 'BINARY_PREVIEW_ONLY',
          message: 'Binary resource is shown as a limited hex preview until a parser is available.',
          sourceUri: options.file.sourceUri
        }
      ]
    };
  } catch (error) {
    return {
      file: options.file,
      previewKind: 'failed',
      truncated: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'PREVIEW_FAILED',
          message: error instanceof Error ? error.message : 'Failed to open resource preview.',
          sourceUri: options.file.sourceUri,
          details: { path: options.file.absolutePath }
        }
      ]
    };
  }
}

async function inspectNativeEnvelope(options: OpenResourcePreviewOptions): Promise<BridgeResult<unknown> | undefined> {
  if (!(options.inspectNative ?? false)) return undefined;
  if (!shouldInspectNativeResource(options.file)) return undefined;

  return runBridge({
    command: 'inspect',
    filePath: options.file.absolutePath,
    resourceUri: options.file.sourceUri,
    allowedRoots: [workspaceRootForFile(options.file)],
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    ...(options.bridgeProjectPath ? { bridgeProjectPath: options.bridgeProjectPath } : {}),
    ...(options.bridgeTimeoutMs ? { timeoutMs: options.bridgeTimeoutMs } : {})
  });
}

async function buildStructuredPreview(
  options: OpenResourcePreviewOptions,
  text: string | undefined,
  nativeInspection: BridgeResult<unknown> | undefined
): Promise<ResourceStructuredPreview | undefined> {
  if (!(options.parseStructured ?? true)) return undefined;

  if (text !== undefined) {
    const parsedText = parseStructuredText(options.file, text);
    if (parsedText) return parsedText;
  }

  const container = nativeInspection ? buildContainerReadSummary(nativeInspection) : undefined;
  const command = exportCommandForStructuredPreview(options.file);
  if (!command) {
    if (!nativeInspection) return undefined;
    return {
      status: nativeInspection.parseStatus === 'failed' ? 'failed' : 'partial',
      kind: options.file.resourceKind,
      parser: 'bridge.inspect',
      summary: summarizeContainerInspection(container),
      editable: false,
      ...(container ? { container } : {}),
      bridgeResult: nativeInspection,
      diagnostics: []
    };
  }

  const exported = await runBridge({
    command,
    filePath: options.file.absolutePath,
    resourceUri: options.file.sourceUri,
    allowedRoots: [workspaceRootForFile(options.file)],
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    ...(options.bridgeProjectPath ? { bridgeProjectPath: options.bridgeProjectPath } : {}),
    ...(options.bridgeTimeoutMs ? { timeoutMs: options.bridgeTimeoutMs } : {})
  });

  return bridgeExportToStructuredPreview(options.file, command, exported);
}

function workspaceRootForFile(file: IndexedFile): string {
  try {
    if (file.workspaceId.startsWith('file:')) return fileURLToPath(file.workspaceId);
  } catch {
    // Fall through to the path/relative-path derivation for legacy indexes.
  }
  const suffixLength = file.relativePath.replaceAll('/', '\\').length;
  return file.absolutePath.slice(0, Math.max(0, file.absolutePath.length - suffixLength)).replace(/[\\/]+$/, '');
}

function parseStructuredText(file: IndexedFile, text: string): ResourceStructuredPreview | undefined {
  if (file.resourceKind === 'event' || file.relativePath.toLowerCase().endsWith('.emevd.dcx.js')) {
    const parsed = parseEventText({ sourceUri: file.sourceUri, sourcePath: file.relativePath, text });
    return {
      status: parsed.export.events.length > 0 ? 'parsed' : 'partial',
      kind: 'event',
      parser: 'eventTextParser',
      summary: `Parsed ${parsed.export.events.length} event(s) and ${countEventInstructions(parsed.export)} instruction(s).`,
      editable: true,
      events: [parsed.export],
      diagnostics: parsed.diagnostics
    };
  }

  if (file.resourceKind === 'msg' || isMsgLikeTextPath(file.relativePath)) {
    const parsed = parseMsgText({ sourceUri: file.sourceUri, sourcePath: file.relativePath, text });
    return {
      status: parsed.export.entries.length > 0 ? 'parsed' : 'partial',
      kind: 'msg',
      parser: 'msgTextParser',
      summary: `Parsed ${parsed.export.entries.length} text entr${parsed.export.entries.length === 1 ? 'y' : 'ies'}.`,
      editable: true,
      msgs: [parsed.export],
      diagnostics: parsed.diagnostics
    };
  }

  if (isPlainEditableText(file)) {
    return {
      status: 'partial',
      kind: file.resourceKind,
      parser: 'plainText',
      summary: 'Editable text file. No resource-specific semantic parser matched yet.',
      editable: true,
      diagnostics: []
    };
  }

  return undefined;
}

function bridgeExportToStructuredPreview(
  file: IndexedFile,
  command: BridgeCommand,
  result: BridgeResult<unknown>
): ResourceStructuredPreview {
  const container = buildContainerReadSummary(result);
  const semantic = bridgeSemanticData(command, result.data);
  return {
    status: result.parseStatus === 'failed' ? 'failed' : result.parseStatus === 'parsed' ? 'parsed' : 'partial',
    kind: result.resourceKind as ResourceKind,
    parser: `bridge.${command}`,
    summary: summarizeBridgeExport(file, command, result, container),
    editable: semantic.editable,
    ...semantic.symbols,
    ...(container ? { container } : {}),
    bridgeResult: result,
    diagnostics: result.diagnostics
  };
}

interface BridgeSemanticPreviewData {
  editable: boolean;
  symbols: Pick<ResourceStructuredPreview, 'events' | 'maps' | 'params' | 'msgs'>;
}

function bridgeSemanticData(command: BridgeCommand, data: unknown): BridgeSemanticPreviewData {
  const record = asRecord(data);

  if (command === 'export-event' && Array.isArray(record.events)) {
    return { editable: false, symbols: { events: [record as unknown as EventExport] } };
  }

  if (command === 'export-map' && (Array.isArray(record.entities) || Array.isArray(record.regions))) {
    return { editable: false, symbols: { maps: [record as unknown as MapExport] } };
  }

  if (command === 'export-param' && Array.isArray(record.rows)) {
    return { editable: false, symbols: { params: [record as unknown as ParamExport] } };
  }

  if (command === 'export-msg' && Array.isArray(record.entries)) {
    return { editable: false, symbols: { msgs: [record as unknown as MsgExport] } };
  }

  return { editable: false, symbols: {} };
}

function summarizeBridgeExport(
  file: IndexedFile,
  command: BridgeCommand,
  result: BridgeResult<unknown>,
  container: ContainerReadSummary | undefined
): string {
  if (result.parseStatus === 'failed') return `Bridge ${command} failed for ${file.formatLabel}.`;
  if (result.parseStatus === 'unsupported') return `Bridge ${command} is not supported for this resource yet.`;
  if (container && container.hints.length > 0) {
    return `Bridge ${command} returned ${result.parseStatus} data with ${container.hints.length} container hint(s). Native candidates remain read-only.`;
  }
  return `Bridge ${command} returned ${result.parseStatus} semantic data. Native candidates remain read-only until a writer is implemented.`;
}

function summarizeContainerInspection(container: ContainerReadSummary | undefined): string {
  if (!container) return 'Native envelope inspected; no container evidence was extracted yet.';
  const confirmedBinderTables = (container.binderChildTableCount ?? 0) + (container.dcxNestedBinderChildTableCount ?? 0);
  const dcxPreviews = (container.dcxPayloadBoundaryCount ?? 0) + (container.dcxDecompressedPreviewCount ?? 0);
  return `Native ${container.rootFormat ?? 'unknown'} envelope inspected: ${container.pathHintCount} path hint(s), ${container.binderChildCandidateCount} binder child candidate(s), ${container.nestedMagicCandidateCount} nested magic candidate(s), ${confirmedBinderTables} binder table evidence item(s), ${dcxPreviews} DCX evidence item(s).`;
}

function buildContainerReadSummary(result: BridgeResult<unknown>): ContainerReadSummary | undefined {
  const data = asRecord(result.data);
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  const hints = evidence.flatMap((item) => formatEvidenceToContainerHint(item)).slice(0, 120);
  const file = asRecord(data.file);
  const extensionChain = Array.isArray(file.extensionChain)
    ? file.extensionChain.filter((item): item is string => typeof item === 'string')
    : [];
  const rootFormat = asString(data.rootFormat);
  const fileName = asString(file.fileName);
  const fileSize = asNumber(file.size);

  if (!rootFormat && hints.length === 0 && extensionChain.length === 0) return undefined;

  return {
    ...(rootFormat ? { rootFormat } : {}),
    ...(fileName ? { fileName } : {}),
    ...(fileSize !== null ? { fileSize } : {}),
    extensionChain,
    hints,
    pathHintCount: hints.filter((hint) => hint.kind === 'pathHint').length,
    binderChildCandidateCount: hints.filter((hint) => hint.kind === 'binderChildCandidate').length,
    nestedMagicCandidateCount: hints.filter((hint) => hint.kind === 'nestedMagicCandidate').length,
    dcxPayloadBoundaryCount: hints.filter((hint) => hint.kind === 'dcxPayloadBoundary').length,
    dcxDecompressedPreviewCount: hints.filter((hint) => hint.kind === 'dcxDecompressedPreview').length,
    binderChildTableCount: hints.filter((hint) => hint.kind === 'binderChildTable').length,
    dcxNestedBinderChildTableCount: hints.filter((hint) => hint.kind === 'dcxNestedBinderChildTable').length
  };
}

function formatEvidenceToContainerHint(value: unknown): ContainerReadHint[] {
  const evidence = asRecord(value);
  const kind = asContainerHintKind(asString(evidence.kind));
  if (!kind) return [];

  const rawValue = asRecord(evidence.value);
  const label = containerHintLabel(kind, rawValue);
  const resourceKind = asString(rawValue.resourceKind);
  const rootFormat = asString(rawValue.rootFormat);
  const source = asString(rawValue.source);
  const extensionChain = Array.isArray(rawValue.extensionChain)
    ? rawValue.extensionChain.filter((item): item is string => typeof item === 'string')
    : undefined;

  return [{
    kind,
    label,
    offset: asNumber(evidence.offset) ?? 0,
    confidence: toReferenceConfidence(evidence.confidence),
    ...(resourceKind ? { resourceKind } : {}),
    ...(rootFormat ? { rootFormat } : {}),
    ...(extensionChain ? { extensionChain } : {}),
    ...(source ? { source } : {}),
    raw: evidence.value
  }];
}

function asContainerHintKind(value: string | undefined): ContainerReadHint['kind'] | null {
  if (value === 'pathHint'
    || value === 'binderChildCandidate'
    || value === 'nestedMagicCandidate'
    || value === 'dcxPayloadBoundary'
    || value === 'dcxDecompressedPreview'
    || value === 'binderChildTable'
    || value === 'dcxNestedBinderChildTable') return value;
  return null;
}

function containerHintLabel(kind: ContainerReadHint['kind'], rawValue: Record<string, unknown>): string {
  if (kind === 'nestedMagicCandidate') return asString(rawValue.rootFormat) || 'nested magic';
  if (kind === 'dcxPayloadBoundary') return `${asString(rawValue.compressionFormat) ?? 'DCX'} payload boundary`;
  if (kind === 'dcxDecompressedPreview') return `${asString(rawValue.nestedRootFormat) ?? 'unknown'} decompressed preview`;
  if (kind === 'binderChildTable') return `binder table: ${countChildren(rawValue)} child item(s)`;
  if (kind === 'dcxNestedBinderChildTable') return `DCX nested binder: ${countNestedChildren(rawValue)} child item(s)`;
  return asString(rawValue.path) || asString(rawValue.text) || 'path hint';
}

function countChildren(rawValue: Record<string, unknown>): number {
  const children = rawValue.children;
  return Array.isArray(children) ? children.length : 0;
}

function countNestedChildren(rawValue: Record<string, unknown>): number {
  const data = asRecord(rawValue.Data ?? rawValue.data);
  return countChildren(data);
}

function toReferenceConfidence(value: unknown): ReferenceConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function exportCommandForStructuredPreview(file: IndexedFile): BridgeCommand | null {
  const path = file.relativePath.toLowerCase();
  if (file.resourceKind === 'msg' && (path.endsWith('.fmg') || path.endsWith('.fmg.dcx') || path.includes('.msgbnd'))) return 'export-msg';
  if (file.resourceKind === 'event' && path.includes('.emevd')) return 'export-event';
  if (file.resourceKind === 'map' && path.includes('.msb')) return 'export-map';
  if (file.resourceKind === 'param' && path.includes('.param')) return 'export-param';
  return null;
}

function shouldInspectNativeResource(file: IndexedFile): boolean {
  if (file.resourceKind === 'unknown') return false;
  if (NATIVE_INSPECT_FORMATS.has(file.formatKind)) return true;

  const path = file.relativePath.toLowerCase();
  return path.endsWith('.dcx')
    || path.includes('.bnd')
    || path.includes('.emevd')
    || path.includes('.msb')
    || path.includes('.param')
    || path.endsWith('.fmg');
}

function determinePreviewKind(file: IndexedFile, buffer: Buffer): 'text' | 'hex' {
  return shouldPreviewAsText(file.extension, buffer) ? 'text' : 'hex';
}

function nativeInspectionDiagnostics(inspection: BridgeResult<unknown> | undefined): Diagnostic[] {
  if (!inspection) return [];

  return [
    {
      severity: inspection.parseStatus === 'failed' ? 'warning' : 'info',
      code: 'NATIVE_INSPECTION_ATTACHED',
      message: `Bridge inspect attached to preview with status '${inspection.parseStatus}'.`,
      sourceUri: inspection.sourceUri,
      details: {
        resourceKind: inspection.resourceKind,
        parseStatus: inspection.parseStatus
      }
    },
    ...inspection.diagnostics
  ];
}

function structuredPreviewDiagnostics(preview: ResourceStructuredPreview | undefined): Diagnostic[] {
  if (!preview) return [];
  return [
    {
      severity: preview.status === 'failed' ? 'warning' : 'info',
      code: 'STRUCTURED_PREVIEW_ATTACHED',
      message: preview.summary,
      details: { parser: preview.parser, editable: preview.editable }
    },
    ...preview.diagnostics
  ];
}

async function readPrefix(path: string, bytesToRead: number): Promise<{ buffer: Buffer; bytesRead: number }> {
  if (bytesToRead === 0) return { buffer: Buffer.alloc(0), bytesRead: 0 };

  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return { buffer, bytesRead: result.bytesRead };
  } finally {
    await handle.close();
  }
}

function shouldPreviewAsText(extension: string, buffer: Buffer): boolean {
  if (TEXT_EXTENSIONS.has(extension.toLowerCase())) return true;
  if (buffer.includes(0)) return false;

  const sampleLength = Math.min(buffer.byteLength, 512);
  if (sampleLength === 0) return true;

  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const value = buffer[index] ?? 0;
    const isPrintable = value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126) || value >= 128;
    if (!isPrintable) suspicious += 1;
  }

  return suspicious / sampleLength < 0.08;
}

function isPlainEditableText(file: IndexedFile): boolean {
  return file.formatKind === 'text' || TEXT_EXTENSIONS.has(file.extension.toLowerCase());
}

function isMsgLikeTextPath(relativePath: string): boolean {
  const path = relativePath.toLowerCase();
  return path.includes('/msg/') || path.endsWith('.fmg.txt') || path.endsWith('.fmg.csv') || path.endsWith('.fmg.tsv');
}

function countEventInstructions(eventExport: EventExport): number {
  return eventExport.events.reduce((total, event) => total + event.instructions.length, 0);
}

function toHexPreview(buffer: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += 16) {
    const row = buffer.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row]
      .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

function truncatedDiagnostic(file: IndexedFile): Diagnostic {
  return {
    severity: 'info',
    code: 'PREVIEW_PREFIX_TRUNCATED',
    message: 'Preview reads only a bounded prefix so every file can be opened safely, including large DCX/BND archives.',
    sourceUri: file.sourceUri,
    details: { size: file.size, maxPreviewBytes: DEFAULT_MAX_BYTES }
  };
}

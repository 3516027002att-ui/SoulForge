/**
 * Full EMEVD editor-document assembly via paginated Bridge reads.
 *
 * The Bridge `read-emevd-document` envelope is trimmed (256-instruction sample
 * by default); large real documents must be read page by page (hard constraint
 * 17) and assembled on the authoritative side (main/core), never on the
 * renderer. Assembly is validated: page indices must be continuous, the
 * collected instruction total must match the envelope total, and every event's
 * instruction slice must stay in range.
 *
 * EVENT-30A: the outer resource is opened as-is. DCX unwrap happens natively in
 * the C# Bridge (`DcxNativeDocument`), so production open never imports the
 * TypeScript DCX parser and never materializes a decompressed temp file that
 * could later be (mis)used as the Patch target. The read result therefore
 * carries `sourceFormat` / `outerFileHash` (the outer container identity) in
 * addition to the payload-level `sourceHash`, plus a bounded outline DTO for
 * the source IDE.
 */

import type { EmevdDocumentOutline, EmevdEditorDocument, EmevdEventIr } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { createEmevdEditorDocument } from './emevdFourViewController.js';
import { findInstructionDef, type EmedfRegistry } from '../emevd/emedfSchema.js';

export interface EmevdInstructionPageEntry {
  index: number;
  bank: number;
  id: number;
  argsLength: number;
  argsBase64: string;
  layerOffset: number;
}

export interface EmevdEnvelopePage {
  sourceHash: string;
  /** "emevd" for raw input; "dcx" when Bridge unwrapped a .dcx wrapper. */
  sourceFormat?: string;
  /** SHA-256 of the file bytes as opened (the outer container, not the payload). */
  outerFileHash?: string;
  eventCount: number;
  instructionCount: number;
  instructionTotal?: number;
  instructionPage?: number;
  instructionPageSize?: number;
  instructionPageCount?: number;
  events?: Array<{
    id: number;
    instructionCount: number;
    instructionStartIndex?: number;
    restBehavior: number;
    layerCount?: number;
  }>;
  instructionsSample?: EmevdInstructionPageEntry[];
  authority?: string;
}

export interface ReadFullEmevdDocumentInput {
  /** Path to the outer source resource: raw .emevd or DFLT/KRAK-wrapped .dcx. */
  filePath: string;
  allowedRoots: string[];
  resourceUri: string;
  registry: EmedfRegistry;
  documentInstanceId?: string;
  pageSize?: number;
  /** S15：已挂载原版根目录时传入，KRAK 压缩的地图事件（m11_02_71_10 等）需要
   *  Oodle 运行时才能解 DCX。未挂原版时不传。 */
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
}

export interface ReadFullEmevdDocumentResult {
  ok: boolean;
  document?: EmevdEditorDocument;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  pageCount: number;
  instructionTotal: number;
  /** SHA-256 of the decompressed EMEVD source bytes (Bridge commit precondition). */
  sourceHash?: string;
  /** "emevd" or "dcx" — how Bridge opened the outer source. */
  sourceFormat?: string;
  /** SHA-256 of the outer file bytes as opened (Patch target precondition). */
  outerFileHash?: string;
  /** Bounded event outline for the source IDE; never carries instruction bodies. */
  outline?: EmevdDocumentOutline;
}

const DEFAULT_PAGE_SIZE = 512;
const MAX_PAGE_SIZE = 4096;
export const DEFAULT_OUTLINE_LIMIT = 4096;

export async function readFullEmevdDocumentViaBridge(
  input: ReadFullEmevdDocumentInput
): Promise<ReadFullEmevdDocumentResult> {
  const pageSize = Math.min(Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const diagnostics: ReadFullEmevdDocumentResult['diagnostics'] = [];
  const resourceUri = sanitizeResourceUri(input.resourceUri);

  // Production open targets the outer resource path directly. DCX unwrap is the
  // C# Bridge's job (DcxNativeDocument); the TypeScript side never imports a
  // second DCX parser and never writes a decompressed temp file into the
  // write path (negative architecture: 不以 prepared temp path 作为 Patch target).
  const first = await runBridge<EmevdEnvelopePage>({
    command: 'read-emevd-document',
    filePath: input.filePath,
    allowedRoots: input.allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    timeoutMs: input.timeoutMs ?? 60_000,
    commandOptions: { instructionPage: 0, instructionPageSize: pageSize }
  });
  if (first.parseStatus === 'failed' || !first.data) {
    return {
      ok: false,
      diagnostics: first.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
      pageCount: 0,
      instructionTotal: 0
    };
  }
  const pageCount = Math.max(1, first.data.instructionPageCount ?? 1);
  const instructionTotal = first.data.instructionTotal ?? first.data.instructionCount;
  const collected = new Map<number, EmevdInstructionPageEntry>();
  const addPage = (page: number, envelope: EmevdEnvelopePage): void => {
    for (const entry of envelope.instructionsSample ?? []) {
      const previous = collected.get(entry.index);
      if (previous) {
        throw new Error(`EMEVD 分页读取出现重复指令索引 ${entry.index}。`);
      }
      collected.set(entry.index, entry);
    }
  };
  addPage(0, first.data);

  for (let page = 1; page < pageCount; page += 1) {
    const envelope = await runBridge<EmevdEnvelopePage>({
      command: 'read-emevd-document',
      filePath: input.filePath,
      allowedRoots: input.allowedRoots,
      ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
      timeoutMs: input.timeoutMs ?? 60_000,
      commandOptions: { instructionPage: page, instructionPageSize: pageSize }
    });
    if (envelope.parseStatus === 'failed' || !envelope.data) {
      return {
        ok: false,
        diagnostics: envelope.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
        pageCount,
        instructionTotal
      };
    }
    addPage(page, envelope.data);
  }

  if (collected.size !== instructionTotal) {
    throw new Error(`EMEVD 分页组装指令总数 ${collected.size} ≠ envelope 总数 ${instructionTotal}。`);
  }
  const allInstructions = [...collected.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => entry);
  const firstIndex = allInstructions[0]?.index ?? 0;
  for (let i = 0; i < allInstructions.length; i += 1) {
    if (allInstructions[i]!.index !== firstIndex + i) {
      throw new Error(`EMEVD 分页组装指令索引不连续：${allInstructions[i]!.index} ≠ ${firstIndex + i}。`);
    }
  }

  const events: Array<{
    eventId: number;
    restBehavior: number;
    instructions: Array<{ bank: number; id: number; argsBase64: string; unknown: boolean }>;
  }> = [];
  for (const event of first.data.events ?? []) {
    const count = event.instructionCount;
    const start = count > 0 ? (event.instructionStartIndex ?? -1) : 0;
    let instructions: typeof events[number]['instructions'] = [];
    if (count > 0) {
      if (start < 0 || start + count > allInstructions.length) {
        throw new Error(`EMEVD 事件 ${event.id} 的指令切片越界（start=${start}, count=${count}, total=${allInstructions.length}）。`);
      }
      instructions = allInstructions.slice(start, start + count).map((entry) => ({
        bank: entry.bank,
        id: entry.id,
        argsBase64: entry.argsBase64,
        unknown: findInstructionDef(input.registry, entry.bank, entry.id) === undefined
      }));
    }
    events.push({ eventId: event.id, restBehavior: event.restBehavior, instructions });
  }

  const document = createEmevdEditorDocument({
    resourceUri,
    events,
    ...(input.documentInstanceId !== undefined ? { documentInstanceId: input.documentInstanceId } : {})
  });
  diagnostics.push({
    severity: 'info',
    code: 'EMEVD_FULL_DOCUMENT_ASSEMBLED',
    message: `完整 EMEVD 文档组装完成：${events.length} 事件 / ${instructionTotal} 指令 / ${pageCount} 页。`
  });
  return {
    ok: true,
    document,
    diagnostics,
    pageCount,
    instructionTotal,
    sourceHash: first.data.sourceHash,
    sourceFormat: first.data.sourceFormat ?? 'emevd',
    ...(first.data.outerFileHash !== undefined ? { outerFileHash: first.data.outerFileHash } : {}),
    outline: buildEmevdDocumentOutline(document)
  };
}

/** Total instruction count a page set must cover for the given events table. */
export function expectedInstructionTotal(events: EmevdEventIr[]): number {
  return events.reduce((sum, event) => sum + event.instructions.length, 0);
}

/**
 * 绝对路径脱敏（EVENT-30A）：resourceUri 本应资源相对（如
 * `file://event/common.emevd`）。若调用方误传了本地绝对路径（`D:\...`、
 * `file:///D:/...`、UNC），收敛成无盘符的相对 `file://` 形式，避免把本地
 * 文件系统路径泄漏进 DSL 投影与 outline。已经是资源相对的 URI 原样返回。
 */
export function sanitizeResourceUri(uri: string): string {
  const relativeForm = /^file:\/\/[A-Za-z0-9_.-]+(?:\/|$)/;
  if (relativeForm.test(uri) || /^[A-Za-z0-9_.-]+(?:\/|$)/.test(uri)) {
    return uri;
  }
  const pathPart = uri
    .replace(/^file:\/\/\//, '')
    .replace(/^file:\/\//, '')
    .replace(/^[A-Za-z]:[\\/]/, '')
    .replace(/\\/g, '/')
    .replace(/^[\\/]+/, '');
  const relative = pathPart.replace(/^[\\/]+/, '');
  return relative ? `file://${relative}` : 'file://resource';
}

export interface BuildEmevdDocumentOutlineOptions {
  /** Cap on outline rows; larger documents truncate with `truncated: true`. */
  limit?: number;
}

/**
 * Build the bounded event outline for the source IDE (EVENT-30A). Summary rows
 * only — event identity + counts, never instruction bodies/args/strings — so a
 * real corpus stays well inside IPC budgets. `truncated` is set when the event
 * count exceeds `limit`.
 */
export function buildEmevdDocumentOutline(
  document: EmevdEditorDocument,
  options: BuildEmevdDocumentOutlineOptions = {}
): EmevdDocumentOutline {
  const limit = Math.max(1, options.limit ?? DEFAULT_OUTLINE_LIMIT);
  const truncated = document.events.length > limit;
  const events = document.events.slice(0, limit).map((event) => ({
    eventUri: event.eventUri,
    eventId: event.eventId,
    restBehavior: event.restBehavior,
    layer: event.layer,
    instructionCount: event.instructions.length,
    unknownCount: event.instructions.reduce((n, instruction) => n + (instruction.unknown ? 1 : 0), 0)
  }));
  return {
    schemaVersion: 1,
    resourceUri: document.resourceUri,
    eventCount: document.events.length,
    instructionTotal: expectedInstructionTotal(document.events),
    truncated,
    limit,
    events
  };
}

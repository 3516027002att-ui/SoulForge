/**
 * Full EMEVD editor-document assembly via paginated Bridge reads.
 *
 * The Bridge `read-emevd-document` envelope is trimmed (256-instruction sample
 * by default); large real documents must be read page by page (hard constraint
 * 17) and assembled on the authoritative side (main/core), never on the
 * renderer. Assembly is validated: page indices must be continuous, the
 * collected instruction total must match the envelope total, and every event's
 * instruction slice must stay in range.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmevdEditorDocument, EmevdEventIr } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { decompressDfltDcx, isDcxWrapper } from '../util/dcxDflt.js';
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
  /** Path to decompressed .emevd bytes on a Bridge-allowed staging root. */
  filePath: string;
  allowedRoots: string[];
  resourceUri: string;
  registry: EmedfRegistry;
  documentInstanceId?: string;
  pageSize?: number;
  timeoutMs?: number;
  /**
   * Directory for the DCX-unwrapped temp file when filePath is a .dcx wrapper.
   * Must already be inside `allowedRoots` (e.g. the workspace staging root) so
   * the caller can later reuse preparedSourcePath as a Bridge staging source.
   * Defaults to a private tmpdir subdirectory (read-only reuse).
   */
  tempDir?: string;
}

export interface ReadFullEmevdDocumentResult {
  ok: boolean;
  document?: EmevdEditorDocument;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  pageCount: number;
  instructionTotal: number;
  /** SHA-256 of the decompressed EMEVD source bytes (Bridge commit precondition). */
  sourceHash?: string;
  /**
   * When the input was a DCX wrapper, the decompressed .emevd temp file path.
   * The caller owns cleanup and may reuse it as the Bridge staging source for
   * subsequent writes. Undefined for raw .emevd inputs.
   */
  preparedSourcePath?: string;
}

const DEFAULT_PAGE_SIZE = 512;
const MAX_PAGE_SIZE = 4096;

export async function readFullEmevdDocumentViaBridge(
  input: ReadFullEmevdDocumentInput
): Promise<ReadFullEmevdDocumentResult> {
  const pageSize = Math.min(Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const diagnostics: ReadFullEmevdDocumentResult['diagnostics'] = [];

  // Accept raw .emevd or DFLT-wrapped .dcx; KRAK/unknown inner formats fail
  // structurally instead of being silently skipped. For DCX inputs the
  // decompressed temp file is handed to the caller via preparedSourcePath so
  // it can serve as the Bridge staging source for later writes.
  let targetPath = input.filePath;
  let preparedSourcePath: string | undefined;
  let unwrapRoot: string | undefined;
  try {
    const sourceBytes = await readFile(input.filePath);
    if (isDcxWrapper(sourceBytes)) {
      const payload = decompressDfltDcx(sourceBytes);
      unwrapRoot = input.tempDir ?? await mkdtemp(join(tmpdir(), 'soulforge-emevd-dcx-'));
      preparedSourcePath = join(unwrapRoot, `${randomUUID()}.emevd`);
      await writeFile(preparedSourcePath, payload);
      targetPath = preparedSourcePath;
    }
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'EMEVD_DCX_DECOMPRESS_FAILED',
        message: error instanceof Error ? error.message : 'DCX 解压失败（DFLT-only，KRAK 等变体结构化拒绝）。'
      }],
      pageCount: 0,
      instructionTotal: 0
    };
  }

  const bridgeRoots = unwrapRoot
    ? [...input.allowedRoots, unwrapRoot]
    : input.allowedRoots;
  const first = await runBridge<EmevdEnvelopePage>({
    command: 'read-emevd-document',
    filePath: targetPath,
    allowedRoots: bridgeRoots,
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
      filePath: targetPath,
      allowedRoots: bridgeRoots,
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
    resourceUri: input.resourceUri,
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
    ...(preparedSourcePath !== undefined ? { preparedSourcePath } : {})
  };
}

/** Total instruction count a page set must cover for the given events table. */
export function expectedInstructionTotal(events: EmevdEventIr[]): number {
  return events.reduce((sum, event) => sum + event.instructions.length, 0);
}

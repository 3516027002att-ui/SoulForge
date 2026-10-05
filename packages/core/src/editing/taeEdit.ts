/**
 * Agent / CLI TAE facade（问题 6-F）。
 *
 * 读：read-tae-document（anibnd 内所有可解析 TAE 子项的聚合 envelope）。写：只接已有
 * Bridge mutation —— update-event-times / insert-event（write-tae-document），
 * 经 applyNativeMutation → Patch Engine 提交，不直接写盘。
 *
 * 入参是地址字符串（c1050#A0200.e0），内部 parseActionAddress。帧 ↔ 秒在门面层
 * 换算（对外帧 = Math.round(seconds * 30)）。参数字段也必须先由 first-party
 * TAE schema 完整解码，再通过 typed mutation 写回；不把原始文本或未知字节假装成字段。
 */
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultReadSessionManager, createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
import type { ActionAddress, Diagnostic, TaeEntryWire } from '@soulforge/shared';
import { formatActionAddress, formatAnimCode, parseActionAddress } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { makeFileResourceUri, makeWorkspaceRelativePath } from '../workspace/resourceUri.js';
import { applyNativeMutation } from './editorMutationService.js';
import {
  commitTaeEventContainerViaBridge,
  commitTaeEventViaBridge,
  type TaeEventUpsertMutation
} from './taeBridgeCommit.js';
import type { NativeEditSession } from './nativeEditSession.js';
import { readTaeBrowse } from './taeBrowse.js';
import type { TaeBrowseAction } from './taeBrowse.js';

export const TAE_FPS = 30;

export interface TaeEventSnapshot {
  chrId: string;
  animId: number;
  code: string;
  eventIndex: number;
  uri: string;
  address: string;
  eventTypeId: number;
  typeName?: string;
  startTime: number;
  endTime: number;
  startFrame: number;
  endFrame: number;
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
  schemaBankId?: number;
  schemaVariant?: string;
  parameterDecoded?: boolean;
  parameterTailLength?: number;
  fields?: Array<{
    name: string;
    value: string | number | boolean;
    kind?: string;
    index?: number;
    type?: string;
    offset?: number;
    size?: number;
    isPadding?: boolean;
    assert?: number;
    assertValid?: boolean;
    enumEntries?: Array<{ value: number; name: string }>;
    rawValue?: number;
    displayValue?: string;
  }>;
  parameterBytesHex?: string;
  decodeStatus?: 'decoded' | 'partial' | 'unknown';
  raw?: { eventTypeId: number; startTime: number; endTime: number; parameterBytesHex?: string };
}

export interface TaeEventTimeEdit {
  /** `c1050#A0200.e0`。 */
  address: string;
  startFrame?: number;
  endFrame?: number;
}

export interface TaeEventFieldEdit {
  /** `c1050#A0200.e0`，也可使用带 TAE section 的 canonical action URI。 */
  address: string;
  fieldIndex?: number;
  fieldName?: string;
  value: string | number | boolean;
}

export interface TaeEditFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface TaeActionSnapshot {
  chrId: string; animId: number; code: string; address: string; eventCount: number;
  taeEntryIndex?: number; taeEntryId?: number; taeEntryName?: string; taeGroup?: string;
}

export type TaeReadResult =
  | {
    ok: true;
    filePath: string;
    chrId: string;
    readerSchemaRevision: number;
    sourceHash?: string;
    outerFileHash?: string;
    containerSourceHash?: string;
    animationCount?: number;
    totalEventCount?: number;
    status?: 'partial' | 'complete';
    eventsTruncated?: boolean;
    nativePagination?: { animationPage: number; animationPageSize: number; returnedCount: number; totalCount: number | null; hasMore: boolean };
    taeEntryCount?: number;
      taeEntries?: TaeEntryWire[];
      actions: Array<TaeActionSnapshot | TaeBrowseAction>;
      events: TaeEventSnapshot[];
      pagination: {
        returnedCount: number;
        totalCount: number | null;
        offset: number;
        hasMore: boolean;
        nextCursor: string | null;
        pageNumber?: number;
        totalPages?: number | null;
      };
      diagnostics: Diagnostic[];
  }
  | { ok: false; error: TaeEditFailure; diagnostics: Diagnostic[] };

export type TaeSetResult =
  | { ok: true; filePath: string; before: TaeEventSnapshot[]; after: TaeEventSnapshot[]; mutations: number; diagnostics: Diagnostic[] }
  | { ok: false; error: TaeEditFailure; diagnostics: Diagnostic[]; before?: TaeEventSnapshot[] };

interface EnvelopeTemplateField {
  name?: string;
  value?: unknown;
  kind?: string;
  index?: number;
  type?: string;
  offset?: number;
  size?: number;
  isPadding?: boolean;
  assert?: number;
  assertValid?: boolean;
  enumEntries?: Array<{ value: number; name: string }>;
  rawValue?: number;
  displayValue?: string;
}

interface EnvelopeEvent {
  startTime?: number;
  endTime?: number;
  eventTypeId?: number;
  typeName?: string;
  templateFields?: EnvelopeTemplateField[];
  parameterBytesHex?: string;
  parameterDecoded?: boolean;
  schemaBankId?: number;
  schemaVariant?: string;
  parameterTailLength?: number;
}

interface EnvelopeAnim {
  animId?: number;
  hkxName?: string;
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
  eventCount?: number;
  eventsTruncated?: boolean;
  events?: EnvelopeEvent[];
}

export function frameFromSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.round(seconds * TAE_FPS) : 0;
}

export function secondsFromFrame(frame: number): number {
  return Number.isFinite(frame) ? frame / TAE_FPS : 0;
}

export async function readTaeEvents(input: {
  edit: NativeEditSession;
  file: string;
  addresses?: string[];
  cursor?: string;
  offset?: number;
  pageSize?: number;
  expectedSourceHash?: string;
  expectedReaderSchemaRevision?: number;
}): Promise<TaeReadResult> {
  const resolved = await resolveAnibndFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const wanted = (input.addresses ?? []).map((address) => parseActionAddress(address));
  if (wanted.some((item) => item === null)) {
    return {
      ok: false,
      error: { code: 'TAE_ADDRESS_INVALID', message: `地址无法解析：${(input.addresses ?? []).filter((_, i) => wanted[i] === null).join(', ')}` },
      diagnostics: []
    };
  }
  if (wanted.every(address => address!.animId === undefined)) {
    const chrId = extractChrId(resolved.path);
    if (wanted.some(address => address!.chr.toLowerCase() !== chrId)) return {
      ok: false, error: { code: 'TAE_EVENT_NOT_FOUND', message: '请求的角色地址与 TAE 来源不匹配。' }, diagnostics: []
    };
    return readTaeBrowse({ ...input, filePath: resolved.path, loadPage: async (animationPage, animationPageSize) => {
      const envelope = await readTaeEnvelope(input.edit, resolved.path, undefined, { animationPage, animationPageSize });
      if (!envelope.ok) return envelope.result;
      const { animations, ...metadata } = envelope;
      return { ...metadata, animationsTruncated: envelope.animationsTruncated === true,
        events: projectEvents(envelope.chrId, animations), actions: projectActions(envelope.chrId, animations) };
    } });
  }
  const envelope = await readTaeEnvelope(input.edit, resolved.path, input.addresses);
  if (!envelope.ok) return envelope.result;
  if ((input.expectedSourceHash !== undefined && (input.expectedSourceHash !== (envelope.outerFileHash ?? envelope.containerSourceHash ?? envelope.sourceHash)
      || input.expectedSourceHash !== await sha256Of(resolved.path)))
    || (input.expectedReaderSchemaRevision !== undefined && input.expectedReaderSchemaRevision !== envelope.readerSchemaRevision))
    return { ok: false, error: { code: 'TAE_SOURCE_VERSION_CHANGED', message: 'TAE 来源或读取器版本已变化，请重新搜索或读取动作。' }, diagnostics: envelope.diagnostics };
  const chrId = envelope.chrId;
  const events = projectEvents(chrId, envelope.animations);
  const actions = projectActions(chrId, envelope.animations);
  let selected = events;
  if (wanted.length > 0) {
    selected = events.filter((event) => wanted.some((wantedAddr) => matchesAddress(wantedAddr!, event)));
    const ambiguous = (input.addresses ?? []).filter((address) => (
      new Set(events.filter((event) => matchesAddress(parseActionAddress(address)!, event)).map((event) =>
        JSON.stringify([event.taeEntryIndex, event.taeEntryId, event.taeEntryName, event.taeGroup]))).size > 1
    ));
    if (ambiguous.length > 0) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_AMBIGUOUS', message: `词条地址在多个 TAE section 中重复，必须指定 section：${ambiguous.join(', ')}`,
          details: { candidates: events.filter((event) => wanted.some((address) => matchesAddress(address!, event))).map((event) => ({ animId: event.animId, taeEntryIndex: event.taeEntryIndex, taeEntryName: event.taeEntryName, address: event.address })) } },
        diagnostics: []
      };
    }
    const missing = (input.addresses ?? []).filter((address, index) => (
      !events.some((event) => matchesAddress(wanted[index]!, event))
      && !(wanted[index]!.eventIndex === undefined && actions.some(action => matchesAddress(wanted[index]!, { ...action, eventIndex: 0 })))
    ));
    if (missing.length > 0) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_NOT_FOUND', message: `请求的词条不存在：${missing.join(', ')}（文件 ${resolved.path}）` },
        diagnostics: []
      };
    }
  }
  if (input.cursor && input.offset !== undefined) return { ok: false,
    error: { code: 'TAE_CURSOR_SCOPE_MISMATCH', message: '续页只传 cursor，不同时传 offset。' }, diagnostics: [] };
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) return { ok: false,
    error: { code: 'TAE_CURSOR_INVALID', message: 'offset 必须是非负安全整数。' }, diagnostics: [] };
  const maximumEventBytes = Math.max(1, ...selected.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8')));
  const pageSize = Math.max(1, Math.min(normalizeTaePageSize(input.pageSize), Math.floor(24000 / maximumEventBytes)));
  const sourceHash = envelope.outerFileHash ?? envelope.containerSourceHash ?? envelope.sourceHash ?? await sha256Of(resolved.path);
  // queryScope 只做续页时的相等性校验；用工作区相对逻辑 URI，避免把本机
  // 绝对路径编进发往模型的 opaque cursor（base64 可解码，不是脱敏）。
  const overlayRoot = input.edit.session.layers.overlayRoot;
  const queryScope = `tae-events:${makeFileResourceUri(makeWorkspaceRelativePath(overlayRoot, resolved.path))}:${JSON.stringify([...(input.addresses ?? [])].sort())}`;
  let pagination = {
    returnedCount: selected.length,
    totalCount: selected.length,
    offset: 0,
    hasMore: false,
    nextCursor: null as string | null,
    pageNumber: 1, totalPages: 1
  };
  {
    try {
      let cursor = input.cursor;
      if (cursor) {
        const payload = parseOpaqueCursor(cursor);
        const existing = defaultReadSessionManager.getSession(payload.sessionId);
        if (payload.domain !== 'tae' || payload.scope !== queryScope
          || (existing && (existing.domain !== 'tae' || existing.queryScope !== queryScope
            || existing.workspaceId !== input.edit.session.meta.workspaceId))) {
          return {
            ok: false,
            error: { code: 'TAE_CURSOR_SCOPE_MISMATCH', message: 'TAE 分页 cursor 与当前文件或读取范围不匹配，请重新读取。' },
            diagnostics: []
          };
        }
      } else {
        const session = defaultReadSessionManager.createSession({
          workspaceId: input.edit.session.meta.workspaceId,
          sourceVersion: { sourceUri: makeFileResourceUri(makeWorkspaceRelativePath(overlayRoot, resolved.path)), sourceHash },
          domain: 'tae',
          queryScope,
          items: selected
        });
        cursor = createOpaqueCursor({
          sessionId: session.sessionId,
          offset: input.offset ?? 0,
          sourceHash,
          domain: 'tae',
          scope: queryScope
        });
      }
      const page = defaultReadSessionManager.resolvePage(cursor, sourceHash, pageSize);
      selected = page.items as TaeEventSnapshot[];
      pagination = {
        returnedCount: page.items.length,
        totalCount: page.total,
        offset: page.offset,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        pageNumber: Math.floor(page.offset / pageSize) + 1,
        totalPages: Math.ceil(page.total / pageSize)
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'TAE_CURSOR_INVALID';
      return {
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) },
        diagnostics: []
      };
    }
  }
  return {
    ok: true,
    filePath: resolved.path,
    chrId,
    readerSchemaRevision: envelope.readerSchemaRevision,
    ...(envelope.sourceHash ? { sourceHash: envelope.sourceHash } : { sourceHash }),
    ...(envelope.outerFileHash ? { outerFileHash: envelope.outerFileHash } : {}),
    ...(envelope.containerSourceHash ? { containerSourceHash: envelope.containerSourceHash } : {}),
    ...(envelope.taeEntryCount !== undefined ? { taeEntryCount: envelope.taeEntryCount } : {}),
    ...(envelope.taeEntries ? { taeEntries: envelope.taeEntries } : {}),
    actions: actions.filter(action => selected.some(event => matchesAddress(parseActionAddress(action.address)!, event))
      || wanted.some(address => address!.eventIndex === undefined && matchesAddress(address!, { ...action, eventIndex: 0 }))),
    events: selected,
    pagination,
    diagnostics: envelope.diagnostics
  };
}

function normalizeTaePageSize(value: number | undefined): number {
  if (value === undefined) return 32;
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) return 32;
  return value;
}

export async function setTaeEventTimes(input: {
  edit: NativeEditSession;
  file: string;
  edits: TaeEventTimeEdit[];
}): Promise<TaeSetResult> {
  if (input.edits.length === 0) {
    return { ok: false, error: { code: 'TAE_EDIT_EMPTY', message: '没有要写入的事件时间。' }, diagnostics: [] };
  }
  const resolved = await resolveAnibndFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const addresses = input.edits.map(edit => edit.address);
  const invalidAddress = addresses.find(address => {
    const parsed = parseActionAddress(address);
    return !parsed || parsed.animId === undefined || parsed.eventIndex === undefined;
  });
  if (invalidAddress !== undefined) return { ok: false, error: { code: 'TAE_ADDRESS_INVALID', message: `地址需含动画与词条下标：${invalidAddress}` }, diagnostics: [] };
  const envelope = await readTaeEnvelope(input.edit, resolved.path, addresses);
  if (!envelope.ok) return envelope.result;
  const chrId = envelope.chrId;
  const events = projectEvents(chrId, envelope.animations);

  const before: TaeEventSnapshot[] = [];
  const mutations: TaeEventUpsertMutation[] = [];
  const pending: Array<{ event: TaeEventSnapshot; edit: TaeEventTimeEdit }> = [];

  for (const edit of input.edits) {
    const parsed = parseActionAddress(edit.address);
    if (!parsed || parsed.animId === undefined || parsed.eventIndex === undefined) {
      return {
        ok: false,
        error: { code: 'TAE_ADDRESS_INVALID', message: `地址需含动画与词条下标：${edit.address}` },
        diagnostics: []
      };
    }
    const matches = events.filter((item) => matchesAddress(parsed, item));
    if (matches.length > 1) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_AMBIGUOUS', message: `词条 ${edit.address} 在多个 TAE section 中重复，必须指定 section。` },
        diagnostics: []
      };
    }
    const event = matches[0];
    if (!event) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_NOT_FOUND', message: `词条不存在：${edit.address}（文件 ${resolved.path}）` },
        diagnostics: []
      };
    }
    if (edit.startFrame === undefined && edit.endFrame === undefined) {
      return {
        ok: false,
        error: { code: 'TAE_EDIT_EMPTY', message: `${edit.address} 需要至少一个 startFrame 或 endFrame。` },
        diagnostics: []
      };
    }
    const startTime = edit.startFrame !== undefined ? secondsFromFrame(edit.startFrame) : event.startTime;
    const endTime = edit.endFrame !== undefined ? secondsFromFrame(edit.endFrame) : event.endTime;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      return { ok: false, error: { code: 'TAE_EDIT_INVALID_FRAME', message: `${edit.address} 的帧必须是有限数字。` }, diagnostics: [] };
    }
    before.push(event);
    pending.push({ event, edit });
    mutations.push({
      mutation: 'update-event-times',
      animId: event.animId,
      eventIndex: event.eventIndex,
      startTime,
      endTime,
      ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex })
    });
  }

  const file = await input.edit.indexFile(resolved.path, 'action');
  const expectedHash = file.sha256 || await sha256Of(resolved.path);
  const isContainer = (envelope.taeEntryCount ?? 0) > 0;
  const expectedCommitHash = envelope.outerFileHash ?? (isContainer ? undefined : envelope.sourceHash);
  if (!expectedCommitHash || expectedCommitHash !== expectedHash) return { ok: false,
    error: { code: 'TAE_SOURCE_VERSION_CHANGED', message: 'TAE physical source 在原生读取后改变或缺少 snapshot hash，已拒绝写回。' }, diagnostics: envelope.diagnostics, before };
  const outcome = await applyNativeMutation({
    file: { ...file, sha256: expectedCommitHash },
    sourceUri: file.sourceUri,
    expectedHash: expectedCommitHash,
    stagingRoot: input.edit.stagingRoot,
    allowedRoots: () => [...input.edit.allowedRoots()],
    stagingPrefix: 'tae',
    stagingFileName: `${basename(resolved.path)}.mut.tae`,
    stageWrite: (context) => {
      const request = {
        sourcePath: resolved.path,
        outputPath: context.outputPath,
        expectedDocumentHash: expectedCommitHash,
        allowedRoots: context.allowedRoots,
        writableRoots: context.writableRoots,
        mutations,
        timeoutMs: 120_000,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
      };
      return isContainer
        ? commitTaeEventContainerViaBridge(request)
        : commitTaeEventViaBridge(request);
    },
    title: `TAE set ${mutations.length} event-times in ${basename(resolved.path)}`,
    confirmActionLabel: '提交 TAE 事件时间变更'
  }, { commit: input.edit.commitPort });

  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics = outcome.status === 'failed'
      ? outcome.diagnostics
      : outcome.status === 'committed'
        ? outcome.result.diagnostics
        : [{ severity: 'error' as const, code: 'TAE_WRITE_CANCELLED', message: '写入被取消。', sourceUri: file.sourceUri }];
    return {
      ok: false,
      error: { code: diagnostics[0]?.code ?? 'TAE_WRITE_FAILED', message: diagnostics[0]?.message ?? 'TAE 写入失败。' },
      diagnostics,
      before
    };
  }

  const reread = await readTaeEnvelope(input.edit, resolved.path, before.map(event => event.address));
  const after = reread.ok
    ? projectEvents(reread.chrId, reread.animations)
    : pending.map((item) => ({
      ...item.event,
      startFrame: item.edit.startFrame ?? item.event.startFrame,
      endFrame: item.edit.endFrame ?? item.event.endFrame
    }));
  return {
    ok: true,
    filePath: resolved.path,
    before,
    after,
    mutations: mutations.length,
    diagnostics: [...envelope.diagnostics, ...outcome.result.diagnostics]
  };
}

/**
 * Write first-party decoded TAE fields.  The caller may address a field by
 * its stable schema index or by the schema field name.  Padding/assert fields
 * are intentionally rejected; their original bytes remain part of the
 * native document and are preserved by the Bridge writer.
 */
export async function setTaeEventFields(input: {
  edit: NativeEditSession;
  file: string;
  edits: TaeEventFieldEdit[];
}): Promise<TaeSetResult> {
  if (input.edits.length === 0) {
    return { ok: false, error: { code: 'TAE_EDIT_EMPTY', message: '没有要写入的 TAE 字段。' }, diagnostics: [] };
  }
  const resolved = await resolveAnibndFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const addresses = input.edits.map(edit => edit.address);
  const invalidAddress = addresses.find(address => {
    const parsed = parseActionAddress(address);
    return !parsed || parsed.animId === undefined || parsed.eventIndex === undefined;
  });
  if (invalidAddress !== undefined) return { ok: false, error: { code: 'TAE_ADDRESS_INVALID', message: `地址需含动画与词条下标：${invalidAddress}` }, diagnostics: [] };
  const envelope = await readTaeEnvelope(input.edit, resolved.path, addresses);
  if (!envelope.ok) return envelope.result;
  const events = projectEvents(envelope.chrId, envelope.animations);
  const before: TaeEventSnapshot[] = [];
  const mutations: TaeEventUpsertMutation[] = [];

  for (const edit of input.edits) {
    const parsed = parseActionAddress(edit.address);
    if (!parsed || parsed.animId === undefined || parsed.eventIndex === undefined) {
      return {
        ok: false,
        error: { code: 'TAE_ADDRESS_INVALID', message: `地址需含动画与词条下标：${edit.address}` },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    const matches = events.filter((item) => matchesAddress(parsed, item));
    if (matches.length > 1) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_AMBIGUOUS', message: `词条 ${edit.address} 在多个 TAE section 中重复，必须指定 section。` },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    const event = matches[0];
    if (!event) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_NOT_FOUND', message: `词条不存在：${edit.address}（文件 ${resolved.path}）` },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    if (event.parameterDecoded !== true || !event.fields) {
      return {
        ok: false,
        error: {
          code: 'TAE_SCHEMA_COVERAGE_GAP',
          message: `${edit.address} 没有可写的 first-party 字段解码结果，已拒绝原始字节猜写。`
        },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    if (edit.fieldIndex !== undefined
      && (!Number.isSafeInteger(edit.fieldIndex) || edit.fieldIndex < 0)) {
      return {
        ok: false,
        error: { code: 'TAE_FIELD_INDEX_INVALID', message: `${edit.address} 的 fieldIndex 必须是非负安全整数。` },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    if (edit.fieldIndex === undefined && !edit.fieldName) {
      return {
        ok: false,
        error: { code: 'TAE_FIELD_SELECTOR_REQUIRED', message: `${edit.address} 需要 fieldIndex 或 fieldName。` },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    const candidates = event.fields.filter((field) => (
      (edit.fieldIndex === undefined || field.index === edit.fieldIndex)
      && (edit.fieldName === undefined || field.name === edit.fieldName)
    ));
    if (candidates.length !== 1) {
      return {
        ok: false,
        error: {
          code: candidates.length === 0 ? 'TAE_FIELD_NOT_FOUND' : 'TAE_FIELD_AMBIGUOUS',
          message: `${edit.address} 无法唯一定位字段${edit.fieldName ? ` ${edit.fieldName}` : ` #${edit.fieldIndex}`}。`
        },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    const field = candidates[0]!;
    if (field.isPadding === true || field.assert !== undefined) {
      return {
        ok: false,
        error: { code: 'TAE_FIELD_PADDING_READONLY', message: `${edit.address}.${field.name} 是保留/断言字段，原始字节只能保留不能改写。` },
        diagnostics: envelope.diagnostics,
        before
      };
    }
    before.push(event);
    mutations.push({
      mutation: 'set-event-field',
      animId: event.animId,
      eventIndex: event.eventIndex,
      ...(field.index === undefined ? {} : { fieldIndex: field.index }),
      ...(edit.fieldName === undefined ? {} : { fieldName: edit.fieldName }),
      value: edit.value,
      ...(event.schemaBankId === undefined ? {} : { schemaBankId: event.schemaBankId }),
      ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex })
    });
  }

  const file = await input.edit.indexFile(resolved.path, 'action');
  const expectedHash = file.sha256 || await sha256Of(resolved.path);
  const isContainer = (envelope.taeEntryCount ?? 0) > 0;
  const expectedCommitHash = envelope.outerFileHash ?? (isContainer ? undefined : envelope.sourceHash);
  if (!expectedCommitHash || expectedCommitHash !== expectedHash) return { ok: false,
    error: { code: 'TAE_SOURCE_VERSION_CHANGED', message: 'TAE physical source 在原生读取后改变或缺少 snapshot hash，已拒绝写回。' }, diagnostics: envelope.diagnostics, before };
  const outcome = await applyNativeMutation({
    file: { ...file, sha256: expectedCommitHash },
    sourceUri: file.sourceUri,
    expectedHash: expectedCommitHash,
    stagingRoot: input.edit.stagingRoot,
    allowedRoots: () => [...input.edit.allowedRoots()],
    stagingPrefix: 'tae',
    stagingFileName: `${basename(resolved.path)}.fields.mut.tae`,
    stageWrite: (context) => {
      const request = {
        sourcePath: resolved.path,
        outputPath: context.outputPath,
        expectedDocumentHash: expectedCommitHash,
        allowedRoots: context.allowedRoots,
        writableRoots: context.writableRoots,
        mutations,
        timeoutMs: 120_000,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
      };
      return isContainer
        ? commitTaeEventContainerViaBridge(request)
        : commitTaeEventViaBridge(request);
    },
    title: `TAE set ${mutations.length} event-fields in ${basename(resolved.path)}`,
    confirmActionLabel: '提交 TAE 事件字段变更'
  }, { commit: input.edit.commitPort });

  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics = outcome.status === 'failed'
      ? outcome.diagnostics
      : outcome.status === 'committed'
        ? outcome.result.diagnostics
        : [{ severity: 'error' as const, code: 'TAE_WRITE_CANCELLED', message: '写入被取消。', sourceUri: file.sourceUri }];
    return {
      ok: false,
      error: { code: diagnostics[0]?.code ?? 'TAE_WRITE_FAILED', message: diagnostics[0]?.message ?? 'TAE 字段写入失败。' },
      diagnostics,
      before
    };
  }

  const reread = await readTaeEnvelope(input.edit, resolved.path, before.map(event => event.address));
  return {
    ok: true,
    filePath: resolved.path,
    before,
    after: reread.ok ? projectEvents(reread.chrId, reread.animations) : before,
    mutations: mutations.length,
    diagnostics: [...envelope.diagnostics, ...outcome.result.diagnostics]
  };
}

export interface TaeEventInsertion {
  address: string;
  eventTypeId: number;
  startFrame: number;
  endFrame: number;
  template: { file?: string; address: string };
  fields?: Array<{ fieldIndex?: number; fieldName?: string; value: string | number | boolean }>;
}

/** Host-resolved templates; Bridge owns byte layout and typed-field validation. */
export async function insertTaeEvents(input: { edit: NativeEditSession; file: string; events: TaeEventInsertion[] }) {
  const failure = (code: string, message: string, diagnostics: Diagnostic[] = []) => ({ ok: false as const, error: { code, message }, diagnostics });
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 64)
    return failure('TAE_INSERT_INVALID', 'events 必须包含 1–64 条新增词条。');
  if (input.events.some(e => !e || typeof e.address !== 'string' || !e.template || typeof e.template.address !== 'string'))
    return failure('TAE_INSERT_INVALID', '每条新增词条必须指定目标和模板地址。');
  const resolved = await resolveAnibndFile(input.edit, input.file);
  if (!resolved.ok) return failure(resolved.error.code, resolved.error.message);
  const envelope = await readTaeEnvelope(input.edit, resolved.path, input.events.flatMap(e => [e.address, ...(e.template?.file ? [] : [e.template?.address ?? ''])]));
  if (!envelope.ok) return envelope.result;
  const current = projectEvents(envelope.chrId, envelope.animations);
  const mutations: TaeEventUpsertMutation[] = [];
  const templates: Array<{ path: string; entryIndex?: number; hash: string }> = [];
  const added: Array<{ animId: number; entryIndex?: number; eventIndex: number }> = [];
  for (const item of input.events) {
    const address = parseActionAddress(item.address);
    const templateAddress = item.template && parseActionAddress(item.template.address);
    if (!address || address.animId === undefined || address.eventIndex !== undefined
      || !templateAddress || templateAddress.animId === undefined || templateAddress.eventIndex === undefined)
      return failure('TAE_ADDRESS_INVALID', '目标需动作级地址，模板需完整词条地址。');
    if (!Number.isSafeInteger(item.eventTypeId) || item.eventTypeId < 0
      || !Number.isFinite(item.startFrame) || !Number.isFinite(item.endFrame) || item.startFrame > item.endFrame)
      return failure('TAE_INSERT_INVALID', '词条类型和起止帧无效。');
    const targetAnims = envelope.animations.filter(a => a.animId === address.animId
      && address.chr.toLowerCase() === envelope.chrId.toLowerCase()
      && (address.taeEntryIndex === undefined || address.taeEntryIndex === a.taeEntryIndex)
      && (address.taeEntryId === undefined || address.taeEntryId === a.taeEntryId)
      && (address.taeEntryName === undefined || address.taeEntryName === a.taeEntryName)
      && (address.taeGroup === undefined || address.taeGroup === a.taeGroup));
    if (targetAnims.length !== 1) return failure(targetAnims.length ? 'TAE_EVENT_AMBIGUOUS' : 'TAE_EVENT_NOT_FOUND', '目标动作不存在或跨 TAE section 歧义。');
    const target = targetAnims[0]!;
    const templateFile = item.template.file ? await resolveAnibndFile(input.edit, item.template.file) : resolved;
    if (!templateFile.ok) return failure(templateFile.error.code, templateFile.error.message);
    const templateEnvelope = templateFile.path === resolved.path ? envelope : await readTaeEnvelope(input.edit, templateFile.path, [item.template.address]);
    if (!templateEnvelope.ok) return templateEnvelope.result;
    const matches = projectEvents(templateEnvelope.chrId, templateEnvelope.animations).filter(e => matchesAddress(templateAddress, e));
    if (matches.length !== 1) return failure(matches.length ? 'TAE_EVENT_AMBIGUOUS' : 'TAE_TEMPLATE_NOT_FOUND', '模板词条不存在或跨 TAE section 歧义。');
    const template = matches[0]!;
    if (template.eventTypeId !== item.eventTypeId) return failure('TAE_TEMPLATE_TYPE_MISMATCH', '模板词条类型与新增词条类型必须相同。');
    if (item.fields !== undefined && (!Array.isArray(item.fields) || item.fields.some(f => !f || typeof f !== 'object'
      || (f.fieldIndex === undefined && !f.fieldName) || !['string', 'number', 'boolean'].includes(typeof f.value))))
      return failure('TAE_TEMPLATE_FIELDS_INVALID', 'fields 必须是有选择器和值的字段数组。');
    const pendingCount = added.filter(a => a.animId === target.animId && a.entryIndex === target.taeEntryIndex).length;
    added.push({ animId: target.animId!, ...(target.taeEntryIndex === undefined ? {} : { entryIndex: target.taeEntryIndex }), eventIndex: (target.events?.length ?? 0) + pendingCount });
    mutations.push({ mutation: 'insert-event', animId: target.animId!, templateAnimId: template.animId,
      templateEventIndex: template.eventIndex, eventTypeId: item.eventTypeId,
      startTime: item.startFrame / TAE_FPS, endTime: item.endFrame / TAE_FPS,
      ...(target.taeEntryIndex === undefined ? {} : { taeEntryIndex: target.taeEntryIndex }),
      ...(template.schemaBankId === undefined ? {} : { schemaBankId: template.schemaBankId }),
      ...(item.fields ? { fieldOverrides: item.fields } : {}) });
    templates.push({ path: templateFile.path, ...(template.taeEntryIndex === undefined ? {} : { entryIndex: template.taeEntryIndex }),
      hash: templateEnvelope.outerFileHash ?? ((templateEnvelope.taeEntryCount ?? 0) > 0 ? '' : templateEnvelope.sourceHash ?? '') });
  }
  const file = await input.edit.indexFile(resolved.path, 'action');
  const expectedHash = envelope.outerFileHash ?? ((envelope.taeEntryCount ?? 0) > 0 ? undefined : envelope.sourceHash);
  if (!expectedHash || expectedHash !== (file.sha256 || await sha256Of(resolved.path)))
    return failure('TAE_SOURCE_VERSION_CHANGED', 'TAE physical source 在原生读取后改变或缺少 snapshot hash，已拒绝插入。', envelope.diagnostics);
  const outcome = await applyNativeMutation({ file: { ...file, sha256: expectedHash }, sourceUri: file.sourceUri, expectedHash,
    stagingRoot: input.edit.stagingRoot, allowedRoots: () => [...input.edit.allowedRoots()], stagingPrefix: 'tae',
    stagingFileName: `${basename(resolved.path)}.insert.tae`,
    stageWrite: async context => {
      const prepared: TaeEventUpsertMutation[] = [];
      for (let index = 0; index < mutations.length; index++) {
        const template = templates[index]!;
        if (!(await input.edit.session.resolveWritablePathSecure(template.path)).ok)
          return { ok: false, diagnostics: [{ severity: 'error', code: 'TAE_TEMPLATE_PATH_BLOCKED', message: '模板路径越出安全工作区。' }] };
        if (await sha256Of(template.path) !== template.hash)
          return { ok: false, diagnostics: [{ severity: 'error', code: 'TAE_TEMPLATE_HASH_MISMATCH', message: '模板在读取后改变。' }] };
        let path = template.path;
        if (template.entryIndex !== undefined) {
          path = join(context.writableRoots[0]!, `template-${index}.tae`);
          const extract = await runBridge({ command: 'extract-bnd4-child', filePath: template.path,
            allowedRoots: context.allowedRoots, writableRoots: context.writableRoots,
            ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
            commandOptions: { outputPath: path, entryIndex: template.entryIndex }, timeoutMs: 120000 });
          if (extract.parseStatus === 'failed') return { ok: false, diagnostics: extract.diagnostics };
          const extractedSnapshot = extract.data as { sourceHash?: string } | undefined;
          if (extractedSnapshot?.sourceHash !== template.hash)
            return { ok: false, diagnostics: [{ severity: 'error', code: 'TAE_TEMPLATE_HASH_MISMATCH', message: '提取器的原生 physical snapshot 与已读取模板不一致。' }] };
        }
        const bytes = await readFile(path);
        if (await sha256Of(template.path) !== template.hash)
          return { ok: false, diagnostics: [{ severity: 'error', code: 'TAE_TEMPLATE_HASH_MISMATCH', message: '模板在暂存期间改变。' }] };
        prepared.push({ ...mutations[index]!, templateDocumentBase64: bytes.toString('base64'), expectedTemplateDocumentHash: createHash('sha256').update(bytes).digest('hex') } as TaeEventUpsertMutation);
      }
      const request = { sourcePath: resolved.path, outputPath: context.outputPath, expectedDocumentHash: expectedHash,
        allowedRoots: context.allowedRoots, writableRoots: context.writableRoots, mutations: prepared, timeoutMs: 120000,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}) };
      return (envelope.taeEntryCount ?? 0) > 0 ? commitTaeEventContainerViaBridge(request) : commitTaeEventViaBridge(request);
    }, title: `TAE insert ${mutations.length} native events in ${basename(resolved.path)}`, confirmActionLabel: '提交 TAE 新增词条'
  }, { commit: input.edit.commitPort });
  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics: Diagnostic[] = outcome.status === 'failed' ? outcome.diagnostics
      : outcome.status === 'committed' ? outcome.result.diagnostics : [{ severity: 'error', code: 'TAE_WRITE_CANCELLED', message: '写入被取消。' }];
    return failure(diagnostics[0]?.code ?? 'TAE_WRITE_FAILED', diagnostics[0]?.message ?? 'TAE 新增失败。', diagnostics);
  }
  const reread = await readTaeEnvelope(input.edit, resolved.path, input.events.map(e => e.address));
  const after = reread.ok ? projectEvents(reread.chrId, reread.animations).filter(e => added.some(a => a.animId === e.animId && a.entryIndex === e.taeEntryIndex && a.eventIndex === e.eventIndex)) : [];
  return { ok: true as const, filePath: resolved.path, before: current.filter(e => added.some(a => a.animId === e.animId && a.entryIndex === e.taeEntryIndex)),
    after, mutations: mutations.length, nativeVerified: reread.ok && after.length === mutations.length,
    opId: outcome.result.opId, backupRoot: outcome.result.backupRoot,
    rollback: { tool: 'rollback_operation', args: { opId: outcome.result.opId } },
    diagnostics: [...envelope.diagnostics, ...outcome.result.diagnostics, ...(reread.ok ? reread.diagnostics : reread.result.diagnostics)] };
}

function matchesAddress(address: ActionAddress, event: Pick<TaeEventSnapshot, 'chrId' | 'animId' | 'eventIndex' | 'taeEntryIndex' | 'taeEntryId' | 'taeEntryName' | 'taeGroup'>): boolean {
  if (address.chr !== event.chrId && address.chr.toLowerCase() !== event.chrId.toLowerCase()) return false;
  if (address.animId === undefined && address.eventIndex === undefined) return true;
  if (address.animId !== event.animId) return false;
  if (address.eventIndex !== undefined && address.eventIndex !== event.eventIndex) return false;
  if (address.taeEntryIndex !== undefined && address.taeEntryIndex !== event.taeEntryIndex) return false;
  if (address.taeEntryId !== undefined && address.taeEntryId !== event.taeEntryId) return false;
  if (address.taeEntryName !== undefined
    && address.taeEntryName.toLowerCase() !== event.taeEntryName?.toLowerCase()) return false;
  if (address.taeGroup !== undefined
    && address.taeGroup.toLowerCase() !== event.taeGroup?.toLowerCase()) return false;
  return true;
}

function sectionSelectorForAnimation(anim: EnvelopeAnim): Pick<
  ActionAddress,
  'taeEntryIndex' | 'taeEntryId' | 'taeEntryName' | 'taeGroup'
> {
  // The protocol intentionally emits one selector. Prefer the source-local
  // BND4 index, then fall back to the stable id/name/group selectors for
  // envelopes that do not expose an index.
  if (anim.taeEntryIndex !== undefined) return { taeEntryIndex: anim.taeEntryIndex };
  if (anim.taeEntryId !== undefined) return { taeEntryId: anim.taeEntryId };
  if (anim.taeEntryName !== undefined) return { taeEntryName: anim.taeEntryName };
  if (anim.taeGroup !== undefined) return { taeGroup: anim.taeGroup };
  return {};
}

function projectActions(chrId: string, animations: EnvelopeAnim[]): Array<TaeActionSnapshot & { eventsTruncated?: boolean }> {
  return animations.map(anim => ({ chrId, animId: anim.animId!, code: formatAnimCode(anim.animId!),
    ...(anim.taeEntryIndex === undefined ? {} : { taeEntryIndex: anim.taeEntryIndex }),
    ...(anim.taeEntryId === undefined ? {} : { taeEntryId: anim.taeEntryId }),
    ...(anim.taeEntryName === undefined ? {} : { taeEntryName: anim.taeEntryName }),
    ...(anim.taeGroup === undefined ? {} : { taeGroup: anim.taeGroup }),
    ...(anim.eventsTruncated === undefined ? {} : { eventsTruncated: anim.eventsTruncated }),
    address: formatActionAddress({ chr: chrId, animId: anim.animId!, ...sectionSelectorForAnimation(anim) }),
    eventCount: anim.eventCount ?? anim.events?.length ?? 0 }));
}

function projectEvents(chrId: string, animations: EnvelopeAnim[]): TaeEventSnapshot[] {
  const out: TaeEventSnapshot[] = [];
  for (const anim of animations) {
    if (anim.animId === undefined) continue;
    const code = formatAnimCode(anim.animId);
    for (let index = 0; index < (anim.events ?? []).length; index += 1) {
      const event = anim.events![index]!;
      const startTime = typeof event.startTime === 'number' && Number.isFinite(event.startTime) ? event.startTime : 0;
      const endTime = typeof event.endTime === 'number' && Number.isFinite(event.endTime) ? event.endTime : startTime;
      const sectionSelector = sectionSelectorForAnimation(anim);
      const canonicalAddress = formatActionAddress({
        chr: chrId,
        animId: anim.animId,
        eventIndex: index,
        ...sectionSelector
      });
      const uri = canonicalAddress.startsWith('action://')
        ? canonicalAddress
        : `action://${chrId}/${code}/e${String(index)}`;
      out.push({
        chrId,
        animId: anim.animId,
        code,
        eventIndex: index,
        uri,
        address: canonicalAddress,
        eventTypeId: typeof event.eventTypeId === 'number' ? event.eventTypeId : 0,
        ...(anim.taeEntryIndex === undefined ? {} : { taeEntryIndex: anim.taeEntryIndex }),
        ...(anim.taeEntryId === undefined ? {} : { taeEntryId: anim.taeEntryId }),
        ...(anim.taeEntryName === undefined ? {} : { taeEntryName: anim.taeEntryName }),
        ...(anim.taeGroup === undefined ? {} : { taeGroup: anim.taeGroup }),
        ...(typeof event.typeName === 'string' && event.typeName.length > 0 ? { typeName: event.typeName } : {}),
        ...(typeof event.schemaBankId === 'number' ? { schemaBankId: event.schemaBankId } : {}),
        ...(typeof event.schemaVariant === 'string' ? { schemaVariant: event.schemaVariant } : {}),
        ...(typeof event.parameterDecoded === 'boolean' ? { parameterDecoded: event.parameterDecoded } : {}),
        ...(typeof event.parameterTailLength === 'number' ? { parameterTailLength: event.parameterTailLength } : {}),
        startTime,
        endTime,
        startFrame: frameFromSeconds(startTime),
        endFrame: frameFromSeconds(endTime),
        decodeStatus: event.parameterDecoded === true && Array.isArray(event.templateFields)
          ? 'decoded'
          : typeof event.parameterBytesHex === 'string' && event.parameterBytesHex.length > 0
            ? 'unknown'
            : 'partial',
        raw: {
          eventTypeId: typeof event.eventTypeId === 'number' ? event.eventTypeId : 0,
          startTime,
          endTime,
          ...(typeof event.parameterBytesHex === 'string' && event.parameterBytesHex.length > 0
            ? { parameterBytesHex: event.parameterBytesHex }
            : {})
        },
        ...(Array.isArray(event.templateFields)
          ? {
            fields: event.templateFields
              .filter((field): field is EnvelopeTemplateField & { name: string } => (
                typeof field.name === 'string' && field.name.length > 0
              ))
              .map((field) => ({
                name: field.name,
                value: parseScalar(field.value),
                ...(typeof field.kind === 'string' ? { kind: field.kind } : {}),
                ...(typeof field.index === 'number' ? { index: field.index } : {}),
                ...(typeof field.type === 'string' ? { type: field.type } : {}),
                ...(typeof field.offset === 'number' ? { offset: field.offset } : {}),
                ...(typeof field.size === 'number' ? { size: field.size } : {}),
                ...(typeof field.isPadding === 'boolean' ? { isPadding: field.isPadding } : {}),
                ...(typeof field.assert === 'number' ? { assert: field.assert } : {}),
                ...(typeof field.assertValid === 'boolean' ? { assertValid: field.assertValid } : {}),
                ...(Array.isArray(field.enumEntries) ? { enumEntries: field.enumEntries } : {}),
                ...(typeof field.rawValue === 'number' ? { rawValue: field.rawValue } : {}),
                ...(typeof field.displayValue === 'string' ? { displayValue: field.displayValue } : {})
              }))
          }
          : {}),
        ...(typeof event.parameterBytesHex === 'string' && event.parameterBytesHex.length > 0
          ? { parameterBytesHex: event.parameterBytesHex }
          : {})
      });
    }
  }
  return out.sort((a, b) => (
    (a.taeEntryIndex ?? -1) - (b.taeEntryIndex ?? -1)
    || a.animId - b.animId
    || a.eventIndex - b.eventIndex
  ));
}

function parseScalar(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value ?? '');
}

async function readTaeEnvelope(
  edit: NativeEditSession,
  filePath: string,
  addresses?: string[],
  nativePage?: { animationPage: number; animationPageSize: number }
): Promise<
  | {
    ok: true;
    chrId: string;
    readerSchemaRevision: number;
    sourceHash?: string;
    outerFileHash?: string;
    containerSourceHash?: string;
    animationCount?: number;
    totalEventCount?: number;
    animationsTruncated?: boolean;
    taeEntryCount?: number;
    taeEntries?: TaeEntryWire[];
    animations: EnvelopeAnim[];
    diagnostics: Diagnostic[];
  }
  | { ok: false; result: { ok: false; error: TaeEditFailure; diagnostics: Diagnostic[] } }
> {
  const requested = (addresses ?? []).map(address => parseActionAddress(address)).filter((address): address is ActionAddress => address !== null && address.animId !== undefined);
  const nativeQueries = [...new Map(requested.map(address => [JSON.stringify([address.animId, address.taeEntryIndex, address.taeEntryId, address.taeEntryName, address.taeGroup]), address])).values()];
  const nativeOptions = (address: ActionAddress) => ({ animId: address.animId,
    ...(address.taeEntryIndex === undefined ? {} : { taeEntryIndex: address.taeEntryIndex }),
    ...(address.taeEntryId === undefined ? {} : { taeEntryId: address.taeEntryId }),
    ...(address.taeEntryName === undefined ? {} : { taeEntryName: address.taeEntryName }),
    ...(address.taeGroup === undefined ? {} : { taeGroup: address.taeGroup }) });
  const result = await runBridge<{
    identityProjectionVersion?: number;
    sourceHash?: string;
    outerFileHash?: string;
    containerSourceHash?: string;
    animationCount?: number;
    totalEventCount?: number;
    animationsTruncated?: boolean;
    taeEntryCount?: number;
    taeEntries?: TaeEntryWire[];
    animations?: Array<Record<string, unknown>>;
  }>({
    command: 'read-tae-document',
    filePath,
    resourceUri: pathToFileURL(filePath).href,
    allowedRoots: edit.allowedRoots(),
    ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000,
    commandOptions: nativeQueries[0] ? nativeOptions(nativeQueries[0]) : nativePage ?? { animationPage: 0, animationPageSize: 64 }
  });
  const diagnostics = asDiagnostics(result.diagnostics);
  if (result.parseStatus === 'failed' || !result.data || !Array.isArray(result.data.animations)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: diagnostics.some(d => d.message.includes('ACTION_TAE_ANIMATION_ID_AMBIGUOUS'))
          ? { code: 'TAE_EVENT_AMBIGUOUS', message: diagnostics.find(d => d.message.includes('ACTION_TAE_ANIMATION_ID_AMBIGUOUS'))!.message }
          : { code: 'TAE_READ_FAILED', message: `无法读取 TAE 文档：${filePath}` },
        diagnostics
      }
    };
  }
  for (const address of nativeQueries.slice(1)) {
    const next = await runBridge<{ identityProjectionVersion?: number; sourceHash?: string; outerFileHash?: string; animations?: Array<Record<string, unknown>> }>({
      command: 'read-tae-document', filePath, allowedRoots: edit.allowedRoots(), timeoutMs: 120000,
      commandOptions: nativeOptions(address), ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}) });
    if (next.parseStatus === 'failed' || !next.data?.animations || next.data.sourceHash !== result.data.sourceHash
      || next.data.outerFileHash !== result.data.outerFileHash
      || next.data.identityProjectionVersion !== result.data.identityProjectionVersion)
      return { ok: false, result: { ok: false, error: { code: 'TAE_ACTION_READ_INCOMPLETE', message: '目标动作查询失败或原生来源/读取器版本在查询间改变。' }, diagnostics: asDiagnostics(next.diagnostics) } };
    for (const animation of next.data.animations) {
      const key = (value: Record<string, unknown>) => JSON.stringify([value?.animId, value?.taeEntryIndex, value?.taeEntryId, value?.taeEntryName, value?.taeGroup]);
      if (!result.data.animations.some(existing => key(existing) === key(animation))) result.data.animations.push(animation);
    }
  }
  const invalidAnimationIndex = result.data.animations.findIndex((anim) => {
    if (anim === null || typeof anim !== 'object') return true;
    const animId = anim.animId;
    return typeof animId !== 'number' || !Number.isSafeInteger(animId) || animId < 0;
  });
  if (invalidAnimationIndex >= 0) {
    const invalidAnim = result.data.animations[invalidAnimationIndex];
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: 'TAE_ANIM_ID_INVALID',
          message: `原生 TAE 动画 ${invalidAnimationIndex} 的 animId 必须是非负 safe integer：${String(invalidAnim?.animId)}`
        },
        diagnostics
      }
    };
  }
  for (let index = 0; index < result.data.animations.length; index++) {
    if (nativePage) break;
    const animation = result.data.animations[index]!;
    if (typeof animation.animId !== 'number') continue;
    const selected = requested.some((address) => address.animId === animation.animId
      && (address.taeEntryIndex === undefined || address.taeEntryIndex === animation.taeEntryIndex)
      && (address.taeEntryId === undefined || address.taeEntryId === animation.taeEntryId)
      && (address.taeEntryName === undefined || address.taeEntryName === animation.taeEntryName)
      && (address.taeGroup === undefined || address.taeGroup === animation.taeGroup));
    if (nativeQueries.length > 0 && animation.eventsTruncated !== true) continue;
    if (!selected && animation.eventsTruncated !== true) continue;
    const full = await runBridge<{ sourceHash?: string; outerFileHash?: string; animations?: Array<Record<string, unknown>> }>({
      command: 'read-tae-document', filePath, allowedRoots: edit.allowedRoots(), timeoutMs: 120000,
      commandOptions: { animId: animation.animId,
        ...(typeof animation.taeEntryIndex === 'number' ? { taeEntryIndex: animation.taeEntryIndex } : {}) },
      ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {})
    });
    if (full.parseStatus === 'failed' || !full.data?.animations?.[0]
      || full.data.sourceHash !== result.data.sourceHash || full.data.outerFileHash !== result.data.outerFileHash) return { ok: false, result: { ok: false,
        error: { code: 'TAE_ACTION_READ_INCOMPLETE', message: '动作完整读取失败或来源在读取期间变化。' }, diagnostics: asDiagnostics(full.diagnostics) } };
    result.data.animations[index] = full.data.animations[0];
  }
  const chrId = extractChrId(filePath);
  if (!chrId) {
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'TAE_CHR_ID_UNKNOWN', message: `无法从路径提取角色 id：${filePath}` },
        diagnostics
      }
    };
  }
  const animations: EnvelopeAnim[] = result.data.animations.map((anim) => {
    const animId = asFinite(anim.animId);
    return {
      ...(animId === undefined ? {} : { animId }),
      ...(typeof anim.hkxName === 'string' ? { hkxName: anim.hkxName } : {}),
      ...(typeof anim.taeEntryIndex === 'number' ? { taeEntryIndex: anim.taeEntryIndex } : {}),
      ...(typeof anim.taeEntryId === 'number' ? { taeEntryId: anim.taeEntryId } : {}),
      ...(typeof anim.taeEntryName === 'string' ? { taeEntryName: anim.taeEntryName } : {}),
      ...(typeof anim.taeGroup === 'string' ? { taeGroup: anim.taeGroup } : {}),
      ...(typeof anim.eventCount === 'number' && Number.isSafeInteger(anim.eventCount) && anim.eventCount >= 0 ? { eventCount: anim.eventCount } : {}),
      ...(typeof anim.eventsTruncated === 'boolean' ? { eventsTruncated: anim.eventsTruncated } : {}),
      events: Array.isArray(anim.events) ? anim.events.map((event) => {
        const startTime = asFinite(event.startTime);
        const endTime = asFinite(event.endTime);
        const eventTypeId = asFinite(event.eventTypeId);
        return {
          ...(startTime === undefined ? {} : { startTime }),
          ...(endTime === undefined ? {} : { endTime }),
          ...(eventTypeId === undefined ? {} : { eventTypeId }),
          ...(typeof event.typeName === 'string' ? { typeName: event.typeName } : {}),
          ...(Array.isArray(event.templateFields)
            ? { templateFields: event.templateFields as NonNullable<EnvelopeEvent['templateFields']> }
            : {}),
          ...(typeof event.parameterBytesHex === 'string' ? { parameterBytesHex: event.parameterBytesHex } : {}),
          ...(typeof event.parameterDecoded === 'boolean' ? { parameterDecoded: event.parameterDecoded } : {}),
          ...(typeof event.schemaBankId === 'number' ? { schemaBankId: event.schemaBankId } : {}),
          ...(typeof event.schemaVariant === 'string' ? { schemaVariant: event.schemaVariant } : {}),
          ...(typeof event.parameterTailLength === 'number' ? { parameterTailLength: event.parameterTailLength } : {})
        };
      }) : []
    };
  });
  return {
    ok: true,
    chrId,
    readerSchemaRevision: typeof result.data.identityProjectionVersion === 'number' ? result.data.identityProjectionVersion : 0,
    ...(result.data.sourceHash ? { sourceHash: result.data.sourceHash } : {}),
    ...(result.data.outerFileHash ? { outerFileHash: result.data.outerFileHash } : {}),
    ...(result.data.containerSourceHash ? { containerSourceHash: result.data.containerSourceHash } : {}),
    ...(typeof result.data.animationCount === 'number' ? { animationCount: result.data.animationCount } : {}),
    ...(typeof result.data.totalEventCount === 'number' ? { totalEventCount: result.data.totalEventCount } : {}),
    ...(typeof result.data.animationsTruncated === 'boolean' ? { animationsTruncated: result.data.animationsTruncated } : {}),
    ...(typeof result.data.taeEntryCount === 'number' ? { taeEntryCount: result.data.taeEntryCount } : {}),
    ...(Array.isArray(result.data.taeEntries) ? { taeEntries: result.data.taeEntries } : {}),
    animations,
    diagnostics
  };
}

function extractChrId(filePath: string): string | null {
  const match = /(?:^|[/\\])c(\d{4})(?:[./\\]|$)/i.exec(filePath);
  return match ? `c${match[1]}`.toLowerCase() : null;
}

function asFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function resolveAnibndFile(
  edit: NativeEditSession,
  file: string
): Promise<{ ok: true; path: string } | { ok: false; error: TaeEditFailure }> {
  const overlay = edit.session.layers.overlayRoot;
  const candidates = [
    resolve(file),
    join(overlay, file),
    join(overlay, 'chr', file),
    join(overlay, 'chr', `${file}.anibnd.dcx`),
    join(overlay, 'chr', `${file}.anibnd`)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const writable = edit.session.resolveWritablePath(candidate);
      if (!writable.ok) continue;
      return { ok: true, path: candidate };
    } catch {
      // try next
    }
  }
  return {
    ok: false,
    error: { code: 'TAE_FILE_NOT_FOUND', message: `工作区内找不到动作文件：${file}（期望 chr/cXXXX.anibnd.dcx）` }
  };
}

function asDiagnostics(items: Array<{ severity: string; code: string; message: string; details?: unknown }>): Diagnostic[] {
  return items.map((item) => ({
    severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error',
    code: item.code,
    message: item.message, ...(item.details === undefined ? {} : { details: item.details })
  }));
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

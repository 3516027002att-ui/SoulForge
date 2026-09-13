/**
 * Agent / CLI TAE facade（问题 6-F）。
 *
 * 读：read-tae-document（anibnd 内所有可解析 TAE 子项的聚合 envelope）。写：只接已有
 * Bridge mutation —— update-event-times / insert-event（write-tae-document），
 * 经 applyNativeMutation → Patch Engine 提交，不直接写盘。
 *
 * 入参是地址字符串（c1050#A0200.e0），内部 parseActionAddress。帧 ↔ 秒在门面层
 * 换算（对外帧 = Math.round(seconds * 30)）。未解码参数体不开放 set —— 参数类
 * 字段走 mutate_param_fields，TAE 只存引用 ID。
 */
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ActionAddress, Diagnostic, TaeEntryWire } from '@soulforge/shared';
import { formatActionAddress, formatAnimCode, parseActionAddress } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { applyNativeMutation } from './editorMutationService.js';
import { commitTaeEventViaBridge, type TaeEventUpsertMutation } from './taeBridgeCommit.js';
import type { NativeEditSession } from './nativeEditSession.js';

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
  fields?: Array<{ name: string; value: string | number | boolean }>;
  parameterBytesHex?: string;
}

export interface TaeEventTimeEdit {
  /** `c1050#A0200.e0`。 */
  address: string;
  startFrame?: number;
  endFrame?: number;
}

export interface TaeEditFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type TaeReadResult =
  | {
    ok: true;
    filePath: string;
    chrId: string;
    sourceHash?: string;
    taeEntryCount?: number;
    taeEntries?: TaeEntryWire[];
    events: TaeEventSnapshot[];
    diagnostics: Diagnostic[];
  }
  | { ok: false; error: TaeEditFailure; diagnostics: Diagnostic[] };

export type TaeSetResult =
  | { ok: true; filePath: string; before: TaeEventSnapshot[]; after: TaeEventSnapshot[]; mutations: number; diagnostics: Diagnostic[] }
  | { ok: false; error: TaeEditFailure; diagnostics: Diagnostic[]; before?: TaeEventSnapshot[] };

interface EnvelopeEvent {
  startTime?: number;
  endTime?: number;
  eventTypeId?: number;
  typeName?: string;
  templateFields?: Array<{ name?: string; value?: unknown }>;
  parameterBytesHex?: string;
}

interface EnvelopeAnim {
  animId?: number;
  hkxName?: string;
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
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
}): Promise<TaeReadResult> {
  const resolved = await resolveAnibndFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const envelope = await readTaeEnvelope(input.edit, resolved.path);
  if (!envelope.ok) return envelope.result;
  const chrId = envelope.chrId;
  const events = projectEvents(chrId, envelope.animations);
  const wanted = (input.addresses ?? []).map((address) => parseActionAddress(address));
  if (wanted.some((item) => item === null)) {
    return {
      ok: false,
      error: { code: 'TAE_ADDRESS_INVALID', message: `地址无法解析：${(input.addresses ?? []).filter((_, i) => wanted[i] === null).join(', ')}` },
      diagnostics: []
    };
  }
  let selected = events;
  if (wanted.length > 0) {
    selected = events.filter((event) => wanted.some((wantedAddr) => matchesAddress(wantedAddr!, event)));
    const ambiguous = (input.addresses ?? []).filter((address) => (
      events.filter((event) => matchesAddress(parseActionAddress(address)!, event)).length > 1
    ));
    if (ambiguous.length > 0) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_AMBIGUOUS', message: `词条地址在多个 TAE section 中重复，必须指定 section：${ambiguous.join(', ')}` },
        diagnostics: []
      };
    }
    const missing = (input.addresses ?? []).filter((address, index) => (
      !events.some((event) => matchesAddress(wanted[index]!, event))
    ));
    if (missing.length > 0) {
      return {
        ok: false,
        error: { code: 'TAE_EVENT_NOT_FOUND', message: `请求的词条不存在：${missing.join(', ')}（文件 ${resolved.path}）` },
        diagnostics: []
      };
    }
  }
  return {
    ok: true,
    filePath: resolved.path,
    chrId,
    ...(envelope.sourceHash ? { sourceHash: envelope.sourceHash } : {}),
    ...(envelope.taeEntryCount !== undefined ? { taeEntryCount: envelope.taeEntryCount } : {}),
    ...(envelope.taeEntries ? { taeEntries: envelope.taeEntries } : {}),
    events: selected,
    diagnostics: envelope.diagnostics
  };
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
  const envelope = await readTaeEnvelope(input.edit, resolved.path);
  if (!envelope.ok) return envelope.result;
  if ((envelope.taeEntryCount ?? 0) > 1) {
    return {
      ok: false,
      error: { code: 'TAE_MULTI_ENTRY_WRITE_UNSUPPORTED', message: '多 TAE 子项聚合文档当前只读，不能把事件写入未明确选择的 section。' },
      diagnostics: envelope.diagnostics
    };
  }
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
    mutations.push({ mutation: 'update-event-times', animId: event.animId, eventIndex: event.eventIndex, startTime, endTime });
  }

  const file = await input.edit.indexFile(resolved.path, 'action');
  const expectedHash = file.sha256 || await sha256Of(resolved.path);
  const outcome = await applyNativeMutation({
    file: { ...file, sha256: expectedHash },
    sourceUri: file.sourceUri,
    expectedHash,
    stagingRoot: input.edit.stagingRoot,
    allowedRoots: () => [...input.edit.allowedRoots()],
    stagingPrefix: 'tae',
    stagingFileName: `${basename(resolved.path)}.mut.tae`,
    stageWrite: (context) => commitTaeEventViaBridge({
      sourcePath: resolved.path,
      outputPath: context.outputPath,
      expectedDocumentHash: expectedHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations,
      timeoutMs: 120_000
    }),
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

  const reread = await readTaeEnvelope(input.edit, resolved.path);
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

function matchesAddress(address: ActionAddress, event: TaeEventSnapshot): boolean {
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
        startTime,
        endTime,
        startFrame: frameFromSeconds(startTime),
        endFrame: frameFromSeconds(endTime),
        ...(Array.isArray(event.templateFields)
          ? {
            fields: event.templateFields
              .filter((field): field is { name: string; value: unknown } => typeof field.name === 'string' && field.name.length > 0)
              .map((field) => ({ name: field.name, value: parseScalar(field.value) }))
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
  filePath: string
): Promise<
  | {
    ok: true;
    chrId: string;
    sourceHash?: string;
    taeEntryCount?: number;
    taeEntries?: TaeEntryWire[];
    animations: EnvelopeAnim[];
    diagnostics: Diagnostic[];
  }
  | { ok: false; result: { ok: false; error: TaeEditFailure; diagnostics: Diagnostic[] } }
> {
  const result = await runBridge<{
    sourceHash?: string;
    taeEntryCount?: number;
    taeEntries?: TaeEntryWire[];
    animations?: Array<Record<string, unknown>>;
  }>({
    command: 'read-tae-document',
    filePath,
    resourceUri: pathToFileURL(filePath).href,
    allowedRoots: edit.allowedRoots(),
    ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  const diagnostics = asDiagnostics(result.diagnostics);
  if (result.parseStatus === 'failed' || !result.data || !Array.isArray(result.data.animations)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'TAE_READ_FAILED', message: `无法读取 TAE 文档：${filePath}` },
        diagnostics
      }
    };
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
      events: Array.isArray(anim.events) ? anim.events.map((event) => {
        const startTime = asFinite(event.startTime);
        const endTime = asFinite(event.endTime);
        const eventTypeId = asFinite(event.eventTypeId);
        return {
          ...(startTime === undefined ? {} : { startTime }),
          ...(endTime === undefined ? {} : { endTime }),
          ...(eventTypeId === undefined ? {} : { eventTypeId }),
          ...(typeof event.typeName === 'string' ? { typeName: event.typeName } : {}),
          ...(Array.isArray(event.templateFields) ? { templateFields: event.templateFields as Array<{ name?: string; value?: unknown }> } : {}),
          ...(typeof event.parameterBytesHex === 'string' ? { parameterBytesHex: event.parameterBytesHex } : {})
        };
      }) : []
    };
  });
  return {
    ok: true,
    chrId,
    ...(result.data.sourceHash ? { sourceHash: result.data.sourceHash } : {}),
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

function asDiagnostics(items: Array<{ severity: string; code: string; message: string }>): Diagnostic[] {
  return items.map((item) => ({
    severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error',
    code: item.code,
    message: item.message
  }));
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

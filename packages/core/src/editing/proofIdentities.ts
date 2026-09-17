/** T09 证明身份：读写两侧用同一推导规则产生对象键与外层源键；编造不出键就失败关闭。 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseActionAddress } from '@soulforge/shared';
import type { HostDeliveredNativeRead } from './nativeReadProofStore.js';

/**
 * 外层源键：已解析的绝对路径 → file URL。
 * 裸相对串必须先相对 overlayRoot 解析；解析不出或非文件即失败关闭，
 * 不得用未解析串作键（同容器两种拼写会分裂证明域）。
 */
export function outerFileKey(overlayRoot: string | undefined, raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('PROOF_IDENTITY_NO_FILE');
  let clean = raw.trim();
  if (clean.startsWith('file:///')) {
    try {
      clean = fileURLToPath(clean);
    } catch {
      clean = clean.slice(8);
    }
  } else if (clean.startsWith('file://')) {
    clean = clean.slice(7);
  }
  const resolved = isAbsolute(clean) ? resolve(clean) : overlayRoot ? resolve(overlayRoot, clean) : null;
  if (!resolved) throw new Error('PROOF_IDENTITY_NO_FILE');
  try {
    if (!statSync(resolved).isFile()) throw new Error('PROOF_IDENTITY_NOT_FILE');
  } catch {
    throw new Error('PROOF_IDENTITY_NOT_FILE');
  }
  return pathToFileURL(resolved).href;
}

export function paramOuterKey(containerPath: string): string {
  return pathToFileURL(containerPath).href;
}

/**
 * PARAM 对象键：param|外层|规范表|行|行槽|字段。
 * 行槽缺失时不编造：带 rowIndex 的写入将匹配不到，必须用 rowIndex 重读。
 * entryName 不进入键：写入侧没有该维度；物理行绑定由 writer 的
 * rowIndex + expectedDataHash 精确保证，证明只管“读过该逻辑字段”。
 */
export function paramObjectKey(input: {
  outerKey: string;
  table: string;
  rowId: number;
  rowIndex?: number;
  fieldId: string;
}): string {
  const normalizedTable = input.table.toLocaleLowerCase().replace(/[^a-z0-9]/gu, '');
  return [
    'param',
    input.outerKey,
    normalizedTable,
    String(input.rowId),
    input.rowIndex === undefined ? 'row' : `rowIndex:${String(input.rowIndex)}`,
    input.fieldId
  ].join('|');
}

export interface ParamReadField {
  table: string;
  rowId: number;
  rowIndex?: number;
  fieldId: string;
  sourceHash?: string;
  sourceRevision?: number;
}

/** 原生读取结果 → 逐字段已送达证明（调用方保证这些字段确在最终 envelope 中）。 */
export function paramDeliveredReads(input: {
  principal: string;
  workspaceId: string;
  containerPath: string;
  fields: ParamReadField[];
}): HostDeliveredNativeRead[] {
  const outerKey = paramOuterKey(input.containerPath);
  return input.fields
    .filter((field) => typeof field.fieldId === 'string' && field.fieldId.trim() !== '')
    .map((field) => ({
      principal: input.principal,
      workspaceId: input.workspaceId,
      objectKey: paramObjectKey({
        outerKey,
        table: field.table,
        rowId: field.rowId,
        ...(field.rowIndex === undefined ? {} : { rowIndex: field.rowIndex }),
        fieldId: field.fieldId
      }),
      outerSourceKey: outerKey,
      version: {
        ...(field.sourceHash === undefined ? {} : { childHash: field.sourceHash }),
        ...(field.sourceRevision === undefined ? {} : { sourceRevision: field.sourceRevision })
      },
      deliveredFields: [field.fieldId],
      readShape: 'fields' as const
    }));
}

export function emevdObjectKey(sourceUri: string, eventId: number): string {
  return `emevd|${sourceUri}|${String(eventId)}`;
}

/**
 * 整事件已送达证明：对宿主确认的完整 DSL 文本哈希定界。
 * 只有桥接器验证过 complete_native_dsl + complete + 未截断才调用此处。
 */
export function emevdDeliveredRead(input: {
  principal: string;
  workspaceId: string;
  canonicalSourceUri: string;
  eventId: number;
  version: HostDeliveredNativeRead['version'];
  dslText: string;
  capability?: string;
}): HostDeliveredNativeRead {
  const totalUtf8Bytes = Buffer.byteLength(input.dslText, 'utf8');
  return {
    principal: input.principal,
    workspaceId: input.workspaceId,
    objectKey: emevdObjectKey(input.canonicalSourceUri, input.eventId),
    outerSourceKey: input.canonicalSourceUri,
    version: { ...input.version },
    readShape: 'full-event',
    deliveredTextRange: {
      startByte: 0,
      endByte: totalUtf8Bytes,
      totalUtf8Bytes,
      fullTextHash: createHash('sha256').update(input.dslText, 'utf8').digest('hex')
    },
    ...(input.capability === undefined ? {} : { capability: input.capability })
  };
}

export function fmgObjectKey(outerKey: string, table: string, id: number): string {
  return `fmg|${outerKey}|${table.toLocaleLowerCase()}|${String(id)}`;
}

export function fmgContainerKey(outerKey: string, table: string): string {
  return `fmg-container|${outerKey}|${table.toLocaleLowerCase()}`;
}

export interface FmgReadEntry {
  table?: string;
  id: number;
  sourceHash?: string;
  sourceRevision?: number;
}

/**
 * FMG 已送达证明：读过的条目逐条记键；同时记容器键（新增条目凭容器读取授权，
 * 条目级键缺席时回退到它；writer 仍执行槽位规则）。
 */
export function fmgDeliveredReads(input: {
  principal: string;
  workspaceId: string;
  outerKey: string;
  table: string;
  entries: FmgReadEntry[];
}): HostDeliveredNativeRead[] {
  const containerProof: HostDeliveredNativeRead = {
    principal: input.principal,
    workspaceId: input.workspaceId,
    objectKey: fmgContainerKey(input.outerKey, input.table),
    outerSourceKey: input.outerKey,
    version: {},
    deliveredFields: [],
    readShape: 'fields'
  };
  const entryProofs = input.entries
    .filter((entry) => Number.isSafeInteger(entry.id))
    .map((entry) => ({
      principal: input.principal,
      workspaceId: input.workspaceId,
      objectKey: fmgObjectKey(input.outerKey, entry.table ?? input.table, entry.id),
      outerSourceKey: input.outerKey,
      version: {
        ...(typeof entry.sourceHash === 'string' ? { childHash: entry.sourceHash } : {}),
        ...(typeof entry.sourceRevision === 'number' ? { sourceRevision: entry.sourceRevision } : {})
      },
      deliveredFields: ['text'],
      readShape: 'fields' as const
    }));
  return [containerProof, ...entryProofs];
}

export interface TaeSectionIdentity {
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
}

export function taeObjectKey(
  outerKey: string,
  chrId: string,
  animId: number,
  eventIndex: number,
  section?: TaeSectionIdentity
): string {
  const sectionKey = section?.taeEntryIndex !== undefined
    ? `index:${section.taeEntryIndex}`
    : section?.taeEntryId !== undefined
      ? `id:${section.taeEntryId}`
      : section?.taeEntryName !== undefined
        ? `name:${section.taeEntryName.toLowerCase()}`
        : section?.taeGroup !== undefined
          ? `group:${section.taeGroup.toLowerCase()}`
          : 'tae';
  return `tae|${outerKey}|${chrId}|${sectionKey}|${String(animId)}|${String(eventIndex)}`;
}

/** 从动作地址 `c1050#A0200.e0` 解析身份；拼写非法返回 null。 */
export function parseTaeAddress(address: string): {
  chrId: string;
  animId: number;
  eventIndex: number;
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
} | null {
  const parsed = parseActionAddress(address);
  if (!parsed || parsed.animId === undefined || parsed.eventIndex === undefined) return null;
  return {
    chrId: parsed.chr,
    animId: parsed.animId,
    eventIndex: parsed.eventIndex,
    ...(parsed.taeEntryIndex === undefined ? {} : { taeEntryIndex: parsed.taeEntryIndex }),
    ...(parsed.taeEntryId === undefined ? {} : { taeEntryId: parsed.taeEntryId }),
    ...(parsed.taeEntryName === undefined ? {} : { taeEntryName: parsed.taeEntryName }),
    ...(parsed.taeGroup === undefined ? {} : { taeGroup: parsed.taeGroup })
  };
}

export interface TaeReadEvent {
  chrId?: string;
  animId: number;
  eventIndex: number;
  startFrame?: number;
  endFrame?: number;
  fieldNames?: string[];
  fieldIndices?: number[];
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
}

export function taeDeliveredReads(input: {
  principal: string;
  workspaceId: string;
  outerKey: string;
  chrId: string;
  events: TaeReadEvent[];
}): HostDeliveredNativeRead[] {
  return input.events
    .filter((event) => Number.isSafeInteger(event.animId) && Number.isSafeInteger(event.eventIndex))
    .map((event) => ({
      principal: input.principal,
      workspaceId: input.workspaceId,
      objectKey: taeObjectKey(
        input.outerKey,
        event.chrId ?? input.chrId,
        event.animId,
        event.eventIndex,
        event
      ),
      outerSourceKey: input.outerKey,
      version: {},
      deliveredFields: [
        ...(typeof event.startFrame === 'number' ? ['startFrame' as const] : []),
        ...(typeof event.endFrame === 'number' ? ['endFrame' as const] : []),
        ...(event.fieldNames ?? []),
        ...(event.fieldIndices ?? []).map((index) => `fieldIndex:${index}`)
      ],
      readShape: 'fields' as const
    }));
}

export function msbObjectKey(outerKey: string, nativeOffset: number): string {
  return `msb|${outerKey}|${String(nativeOffset)}`;
}

export function msbAddressKey(outerKey: string, address: string): string {
  return `msb|${outerKey}|address:${address}`;
}

const MSB_TRANSFORM_FIELDS = [
  'posX', 'posY', 'posZ',
  'rotX', 'rotY', 'rotZ',
  'scaleX', 'scaleY', 'scaleZ'
] as const;

export interface MsbReadPart {
  address?: string;
  nativeOffset?: number;
  posX?: number;
  posY?: number;
  posZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export function msbDeliveredReads(input: {
  principal: string;
  workspaceId: string;
  outerKey: string;
  parts: MsbReadPart[];
}): HostDeliveredNativeRead[] {
  const proofs: HostDeliveredNativeRead[] = [];
  for (const part of input.parts) {
    const delivered = MSB_TRANSFORM_FIELDS.filter((field) => typeof part[field] === 'number');
    if (typeof part.nativeOffset === 'number' && Number.isSafeInteger(part.nativeOffset)) {
      proofs.push({
        principal: input.principal,
        workspaceId: input.workspaceId,
        objectKey: msbObjectKey(input.outerKey, part.nativeOffset),
        outerSourceKey: input.outerKey,
        version: {},
        deliveredFields: [...delivered],
        readShape: 'fields'
      });
    }
    // 地址键与原生键并存：读侧不知道写侧用哪种引用，两键同义。
    if (typeof part.address === 'string' && part.address.trim() !== '') {
      proofs.push({
        principal: input.principal,
        workspaceId: input.workspaceId,
        objectKey: msbAddressKey(input.outerKey, part.address),
        outerSourceKey: input.outerKey,
        version: {},
        deliveredFields: [...delivered],
        readShape: 'fields'
      });
    }
  }
  return proofs;
}

export function msbModifiedFields(edit: Record<string, unknown>): string[] {
  return MSB_TRANSFORM_FIELDS.filter((field) => typeof edit[field] === 'number');
}

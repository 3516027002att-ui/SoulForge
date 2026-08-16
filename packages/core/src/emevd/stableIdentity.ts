import { createHash, randomUUID } from 'node:crypto';
import type {
  EmevdEditorDocument,
  EmevdEventIr,
  EmevdInstructionIr,
  EmevdNodeAnchor
} from '@soulforge/shared';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function localId(kind: 'event' | 'instruction', seed: unknown): string {
  // 96 bits keeps editor-local collision risk negligible even on large corpora.
  return createHash('sha256').update(`${kind}:${stableJson(seed)}`).digest('hex').slice(0, 24);
}

/**
 * `stableJson({bank, id, argsBase64, unknown})` 的直写形式（键序 = 字典序:
 * argsBase64, bank, id, unknown）。逐字节等价于通用实现，但省掉
 * Object.keys + sort + map + join + 递归。
 *
 * 真实 common.emevd 有 33266 条指令，通用 stableJson 在打开路径上要跑 3 遍
 * （instruction 指纹、localId 种子、event 指纹里的 instructions 数组），
 * 实测 66532 次调用就要 45.8 ms。此处让每条指令只序列化一次。
 *
 * 本文件有三处这样的直写形式：本函数、下面 event sourceFingerprint 的拼接、
 * 以及 instruction localNodeId 种子的拼接。三处的等价性由
 * `runEmevdStableIdentitySmoke`（npm run test:emevd-stable-identity）用一份
 * 独立 oracle（自带通用 stableJson，不复用本文件任何函数）逐锚比对。已实测
 * 该 smoke 对键序颠倒、少写键、以及把 JSON.stringify 换成裸插值（转义漂移）
 * 三种改法都会红；改这三处拼接前先读它。
 */
function instructionSeedJson(instruction: {
  bank: number;
  id: number;
  argsBase64: string;
  unknown: boolean;
}): string {
  return `{"argsBase64":${JSON.stringify(instruction.argsBase64)},"bank":${
    JSON.stringify(instruction.bank)},"id":${JSON.stringify(instruction.id)},"unknown":${
    JSON.stringify(instruction.unknown)}}`;
}

export function computeEmevdInstructionFingerprint(instruction: EmevdInstructionIr): string {
  return sha256(stableJson({
    bank: instruction.bank,
    id: instruction.id,
    argsBase64: instruction.argsBase64,
    unknown: instruction.unknown
  }));
}

export function computeEmevdEventFingerprint(event: EmevdEventIr): string {
  return sha256(stableJson({
    eventId: event.eventId,
    restBehavior: event.restBehavior,
    layer: event.layer,
    instructions: event.instructions.map((instruction) => ({
      anchor: instruction.anchor?.localNodeId ?? null,
      bank: instruction.bank,
      id: instruction.id,
      argsBase64: instruction.argsBase64,
      unknown: instruction.unknown
    }))
  }));
}

export function formatEmevdAnchor(kind: 'event' | 'instruction', anchor: EmevdNodeAnchor): string {
  return `@${kind === 'event' ? 'e' : 'i'}:${anchor.localNodeId}`;
}

export interface AttachEmevdStableIdentityOptions {
  documentInstanceId?: string;
  signal?: AbortSignal;
  eventsPerYield?: number;
}

export async function attachEmevdStableIdentityAsync(
  document: EmevdEditorDocument,
  options?: AttachEmevdStableIdentityOptions
): Promise<EmevdEditorDocument> {
  const eventsPerYield = Math.max(1, options?.eventsPerYield ?? 32);
  const signal = options?.signal;
  if (signal?.aborted) throw new Error('EMEVD_IDENTITY_CANCELLED');
  if (document.events.length === 0) {
    return attachEmevdStableIdentity(document, options);
  }
  const documentInstanceId = document.documentInstanceId ?? options?.documentInstanceId ?? randomUUID();
  const eventLocalIds = new Set<string>();
  const instructionLocalIds = new Set<string>();
  const events: EmevdEditorDocument['events'] = [];
  for (let index = 0; index < document.events.length; index += 1) {
    events.push(attachOneEvent(document.events[index]!, index, document.resourceUri, documentInstanceId, eventLocalIds, instructionLocalIds));
    if ((index + 1) % eventsPerYield === 0) {
      if (signal?.aborted) throw new Error('EMEVD_IDENTITY_CANCELLED');
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }
  return { ...document, documentInstanceId, events };
}

export function attachEmevdStableIdentity(
  document: EmevdEditorDocument,
  options?: AttachEmevdStableIdentityOptions
): EmevdEditorDocument {
  const documentInstanceId = document.documentInstanceId ?? options?.documentInstanceId ?? randomUUID();
  const eventLocalIds = new Set<string>();
  const instructionLocalIds = new Set<string>();
  const events = document.events.map((event, eventIndex) =>
    attachOneEvent(event, eventIndex, document.resourceUri, documentInstanceId, eventLocalIds, instructionLocalIds)
  );
  return { ...document, documentInstanceId, events };
}

function attachOneEvent(
  event: EmevdEventIr,
  eventIndex: number,
  resourceUri: string,
  documentInstanceId: string,
  eventLocalIds: Set<string>,
  instructionLocalIds: Set<string>
): EmevdEventIr {
  const instructionSeeds = event.instructions.map(instructionSeedJson);
  const eventSourceFingerprint = event.anchor?.sourceFingerprint ?? sha256(
    `{"eventId":${JSON.stringify(event.eventId)},"instructions":[${
      instructionSeeds.join(',')}],"layer":${JSON.stringify(event.layer)},"restBehavior":${
      JSON.stringify(event.restBehavior)}}`
  );
  const eventAnchor: EmevdNodeAnchor = event.anchor ?? {
    documentInstanceId,
    localNodeId: localId('event', {
      resourceUri,
      eventIndex,
      sourceFingerprint: eventSourceFingerprint
    }),
    sourceFingerprint: eventSourceFingerprint
  };
  assertAnchor('event', eventAnchor, eventLocalIds, documentInstanceId);

  const instructions = event.instructions.map((instruction, instructionIndex) => {
    const sourceFingerprint = instruction.anchor?.sourceFingerprint
      ?? sha256(instructionSeeds[instructionIndex]!);
    const anchor: EmevdNodeAnchor = instruction.anchor ?? {
      documentInstanceId,
      localNodeId: createHash('sha256').update(
        `instruction:{"eventLocalNodeId":${JSON.stringify(eventAnchor.localNodeId)
        },"instructionIndex":${JSON.stringify(instructionIndex)
        },"sourceFingerprint":${JSON.stringify(sourceFingerprint)}}`
      ).digest('hex').slice(0, 24),
      sourceFingerprint
    };
    assertAnchor('instruction', anchor, instructionLocalIds, documentInstanceId);
    return { ...instruction, anchor };
  });
  return { ...event, anchor: eventAnchor, instructions };
}

function assertAnchor(
  kind: 'event' | 'instruction',
  anchor: EmevdNodeAnchor,
  seen: Set<string>,
  documentInstanceId: string
): void {
  if (anchor.documentInstanceId !== documentInstanceId) {
    throw new Error(`EMEVD_${kind.toUpperCase()}_ANCHOR_DOCUMENT_INSTANCE_MISMATCH`);
  }
  if (seen.has(anchor.localNodeId)) {
    throw new Error(`EMEVD_${kind.toUpperCase()}_ANCHOR_COLLISION`);
  }
  seen.add(anchor.localNodeId);
}
